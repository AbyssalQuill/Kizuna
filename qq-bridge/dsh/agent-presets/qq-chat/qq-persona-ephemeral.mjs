// 回合末「瞬态上下文」剪枝插件（2026-10-28 二版：不只人设，读过的对话也一起剪）。
//
// 设计（主人 2026-10-28 晚定下的用法）：
//   每一轮该看什么就现调工具看 —— 读人设、读最近消息、翻历史、查自己的回复；
//   这一轮结束，这些结果全部从历史里移走。下一轮重新调一次。
//   好处：① 每轮都是新鲜的、最高权重的上下文；② 历史里不留重复副本，上下文恒定轻；
//         ③ 自己的上一条回复本来就在 SQLite 里（qq_memory_search direction=out 能查到），不怕忘。
//
// 为什么会走到这一步：旧实现（src/core/turn-pruner.js）直接改写 session 文件，那是 DSH 0.1.x 的
// `storages/session_projcache/sessions/<id>.json`；0.2.x 改成
// `sessions/<slug>/session-<id>/session.v4.jsonl.zstd`（仅追加 + seq 连续 + 帧校验），
// 那条路径永远 resolve 不到文件 → 剪枝静默失效，日志里一条 [pruner] 都没有，
// 结果同一张 8.7k 字的角色卡在一个会话里被复制了几百份，每步请求都重发一遍。
//
// 这里走 DSH **受支持**的那条路：和 @deepseek-ai/dsh-compaction-tool-result-pruner 一样，
// 用 session.append('tool/result', …, { surfaceOp: { op:'replace', startSeq, endSeq } }) 追加一条
// 「替换」事件把旧结果挤出当前 surface —— 原始事件仍在日志里可回放，seq 连续，不影响加载。
//
// 失败一律吞掉并记一行 stderr：剪枝只省 token，绝不能影响回复。

export const name = 'qq-persona-ephemeral';

const PERSONA_MARK = '【persona_load】';
const STUB = '【context: ephemeral_turn_pruned】本轮读过的上下文已移出历史（省 token）；需要时再调一次对应工具。';

/** 这些工具的结果是「本轮读进来的上下文」，转瞬即逝，回合末一律剪掉 */
const EPHEMERAL_TOOLS = new Set([
  'qq_load_persona',
  'qq_get_prompt',
  'qq_get_recent_messages',
  'qq_get_my_recent_messages',
  'qq_get_unread_messages',
  'qq_memory_search',
  'qq_memory_notes',
  'qq_get_message_detail',
  'qq_get_forward_msg',
  'qq_get_group_history',
  'qq_group_history',
]);

/** 只认最后一段名字：mcp__napcat__qq_memory_search / qq_memory_search 都算 */
function bareName(raw) {
  const n = String(raw ?? '').trim();
  if (!n) return '';
  const tail = n.includes('__') ? n.slice(n.lastIndexOf('__') + 2) : n;
  return tail;
}

function textOf(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  return blocks.filter((b) => b && b.type === 'text').map((b) => String(b.text ?? '')).join('');
}

/** 把一条结果的本轮内容换成占位（保留调用痕迹与其它 block） */
function stubContent(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  let done = false;
  return blocks.map((b) => {
    if (!b || b.type !== 'text') return b;
    if (!done) { done = true; return { ...b, text: STUB }; }
    return { ...b, text: '' };
  });
}

/** callId → 真实工具名（tool/call 事件的 arguments 里带 tool_name；没有就退回事件名） */
function callNameMap(session) {
  const map = new Map();
  for (const seq of session.surface?.nodes ?? []) {
    const ev = session.eventAt?.(seq);
    if (!ev || ev.type !== 'tool/call') continue;
    const callId = String(ev.data?.callId ?? '');
    if (!callId) continue;
    let name = String(ev.data?.name ?? '');
    try {
      const args = typeof ev.data?.arguments === 'string' ? JSON.parse(ev.data.arguments) : ev.data?.arguments;
      if (args?.tool_name) name = String(args.tool_name);
    } catch { /* arguments 不是 JSON 就用事件名 */ }
    map.set(callId, bareName(name));
  }
  return map;
}

/**
 * 对一个 session 做一次剪枝；导出给测试用（不依赖 cordis 上下文）。
 * @returns {number} 实际替换的条数
 */
export function prunePersonaResults(session) {
  if (!session || typeof session.append !== 'function') return 0;
  const nodes = session.surface && Array.isArray(session.surface.nodes) ? [...session.surface.nodes] : [];
  if (!nodes.length) return 0;
  const names = callNameMap(session);
  let replaced = 0;
  for (const seq of nodes) {
    const event = session.eventAt?.(seq);
    if (!event || event.type !== 'tool/result') continue;
    const message = event.data?.message;
    const text = textOf(message);
    const callId = String(message?.source?.callId ?? event.data?.toolCallId ?? '');
    const toolName = names.get(callId) || '';
    const isEphemeral = EPHEMERAL_TOOLS.has(toolName) || text.includes(PERSONA_MARK);
    if (!isEphemeral) continue;
    if (text.length <= STUB.length + 40) continue; // 已经剪过
    try {
      session.append('tool/result', { ...event.data, message: { ...message, content: stubContent(message) } }, {
        surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
        sourceEventSeqs: [seq],
      });
      replaced += 1;
    } catch (e) {
      /* 剪枝悄悄失效过一次（旧 turn-pruner 走错路径、零日志），失败必须留一行痕迹 */
      try { console.error(`[qq-persona-ephemeral] 替换失败 seq=${seq}: ${String(e?.message ?? e).slice(0, 160)}`); } catch { /* ignore */ }
    }
  }
  return replaced;
}

export const pruneEphemeralResults = prunePersonaResults;

export function apply(ctx) {
  if (!ctx || typeof ctx.on !== 'function') return;
  ctx.on('agent/turn-stopping', (payload) => {
    try {
      const n = prunePersonaResults(payload?.agent?.session);
      if (n > 0 && typeof ctx.logger?.info === 'function') ctx.logger.info(`[qq-persona-ephemeral] 本轮剪掉 ${n} 段瞬态上下文`);
    } catch (e) {
      try { console.error(`[qq-persona-ephemeral] skip: ${String(e?.message ?? e).slice(0, 160)}`); } catch { /* 日志都写不出去就算了 */ }
    }
  });
}
