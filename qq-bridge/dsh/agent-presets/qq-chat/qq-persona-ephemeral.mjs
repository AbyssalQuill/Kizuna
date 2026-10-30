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
const STUB = '[context: ephemeral_turn_pruned] This turn\'s loaded context was removed from history to save tokens. Re-read with the same tool when needed.';

/** 这些工具的结果是「本轮读进来的上下文」，转瞬即逝，回合末一律剪掉 */
const EPHEMERAL_TOOLS = new Set([
  'qq_load_persona',
  'get_time',
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
  'qq_meme_search',
  'meme_search',
  'web_search',
  'qq_web_search',
  'google_search',
  'qq_search_slang',
  'search_slang',
  'qq_get_user_profile',
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
  /* 2026-10-30：人设卡片是唯一要常驻的那一份 —— 只剪旧副本，保留最近一次加载。
   * 为什么：守卫有 30 分钟新鲜窗口（qq-tool-restrict 的 PERSONA_FRESH_MS），模型不会每轮都去重读，
   * 而这里每回合末把结果清零，两边一凑就变成「整场只在第 1 轮手里有人设」。
   * 线上实测（session-94f4c1b9，00:56–00:59）：6 个回合只加载过 1 次，后面几轮全靠模仿自己上一句，
   * 语气开始自我复述、冷脸萌一次都没发出去。保留最近一份 = 恒定一条副本，成本可控，且不依赖模型自觉。 */
  let keepSeq = -1;
  for (const seq of nodes) {
    const ev = session.eventAt?.(seq);
    if (!ev || ev.type !== 'tool/result') continue;
    const t = textOf(ev.data?.message);
    if (!t.includes(PERSONA_MARK) || t.includes('ephemeral_turn_pruned')) continue;
    if (seq > keepSeq) keepSeq = seq;
  }
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
    /* 用 marker 判断"剪过没有"，别用长度：get_time 这类短结果本来就没几百字，
     * 用 STUB.length+40 当门槛会把它们当成已剪过，永远不动。 */
    if (text.includes('ephemeral_turn_pruned')) continue;
    if (seq === keepSeq) continue;   // 最近一次人设加载：常驻，不剪
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

/* 2026-10-30 主人：「我需要的是单轮 —— 所有的都裁剪，除了系统提示词，只保留一轮」。
 * 永久会话 + 逐类剪枝剪不干净：模型自己发过的气泡在 assistant/message(tool-call 参数) 里，
 * 剪枝只认 tool/result，旧台词一直留着被模仿（「喵」「打得太软」就是这么滚起来的）。
 * 所以回合末直接把「系统提示词 / 工具注册(developer/message 有内容) 之外的所有 surface 节点」
 * 整段替换成一条空 developer/message（空内容不产生任何模型消息，见 deriveEventMessage）。
 * 下一轮模型只看到：系统提示词 + 工具表 + 新的唤醒正文，其余一律靠工具现读。
 * 原始事件仍在日志里（surfaceOp replace 不删数据），seq 连续，可回放。 */
const isEmptyDeveloper = (ev) => ev?.type === 'developer/message'
  && Array.isArray(ev.data?.message?.content) && ev.data.message.content.length === 0;

/** 该节点是否要被折叠：系统消息、带内容的 developer/message（工具注册）保留 */
function isCollapsible(ev) {
  if (!ev) return false;
  if (ev.type === 'system/message') return false;
  if (ev.type === 'developer/message') return isEmptyDeveloper(ev);
  return ev.type === 'user/message' || ev.type === 'assistant/message' || ev.type === 'tool/result';
}

/**
 * 把会话折叠成「系统提示词 + 空占位」。导出给测试用。
 * @returns {number} 被折叠的节点数（已经是干净状态则为 0）
 */
export function collapseToSingleTurn(session) {
  if (!session || typeof session.append !== 'function') return 0;
  const nodes = session.surface && Array.isArray(session.surface.nodes) ? [...session.surface.nodes] : [];
  if (!nodes.length) return 0;
  const evs = nodes.map((seq) => session.eventAt?.(seq) || null);
  // 连续可折叠节点分成若干段（被保留的 developer/message 把它们隔开）
  const runs = [];
  let cur = null;
  for (let i = 0; i < nodes.length; i += 1) {
    if (isCollapsible(evs[i])) {
      if (!cur) { cur = []; runs.push(cur); }
      cur.push(i);
    } else {
      cur = null;
    }
  }
  const proto = evs.find((e) => e && e.type === 'developer/message' && !isEmptyDeveloper(e));
  const lastData = [...evs].reverse().find((e) => e && e.data && e.data.turn !== undefined)?.data || {};
  let collapsed = 0;
  for (const run of runs) {
    // 这一段本来就只是一条上次留下的空占位 → 不再重复折叠
    if (run.length === 1 && isEmptyDeveloper(evs[run[0]])) continue;
    const startSeq = nodes[run[0]];
    const endSeq = nodes[run[run.length - 1]];
    const sources = run.map((i) => nodes[i]);
    try {
      session.append('developer/message', {
        ...(lastData.turn !== undefined ? { turn: lastData.turn } : {}),
        ...(lastData.step !== undefined ? { step: lastData.step } : {}),
        message: {
          source: proto?.data?.message?.source || { kind: 'tool-registry' },
          content: [],
          role: 'developer',
          id: globalThis.crypto?.randomUUID?.() || `collapse-${Date.now()}-${startSeq}`,
        },
      }, {
        surfaceOp: { op: 'replace', startSeq, endSeq },
        sourceEventSeqs: sources,
      });
      collapsed += sources.length;
    } catch (e) {
      try { console.error(`[qq-persona-ephemeral] 单轮折叠失败 ${startSeq}-${endSeq}: ${String(e?.message ?? e).slice(0, 160)}`); } catch { /* ignore */ }
    }
  }
  /* 通知 qq-tool-restrict：这个会话的人设/上下文已被清空，之前的「新鲜」记录一律作废，
   * 下一轮发言前必须重新 qq_load_persona + 读上下文。用 globalThis 共享，不依赖两个插件是同一个模块实例。 */
  if (collapsed > 0) {
    const sid = String(session.id || 'default');
    if (!(globalThis.__qqCollapsedAt instanceof Map)) globalThis.__qqCollapsedAt = new Map();
    globalThis.__qqCollapsedAt.set(sid, Date.now());
  }
  return collapsed;
}

export function apply(ctx) {
  if (!ctx || typeof ctx.on !== 'function') return;
  ctx.on('agent/turn-stopping', (payload) => {
    try {
      const session = payload?.agent?.session;
      const n = collapseToSingleTurn(session);
      if (n > 0 && typeof ctx.logger?.info === 'function') ctx.logger.info(`[qq-persona-ephemeral] 单轮折叠：本轮收尾折叠 ${n} 个历史节点（仅留系统提示词）`);
      if (n === 0) {
        const m = prunePersonaResults(session);   // 兜底：折叠不可用时仍按旧策略剪瞬态结果
        if (m > 0 && typeof ctx.logger?.info === 'function') ctx.logger.info(`[qq-persona-ephemeral] 本轮剪掉 ${m} 段瞬态上下文`);
      }
    } catch (e) {
      try { console.error(`[qq-persona-ephemeral] skip: ${String(e?.message ?? e).slice(0, 160)}`); } catch { /* 日志都写不出去就算了 */ }
    }
  });
}
