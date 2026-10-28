// 回合末「瞬态人设」剪枝插件（2026-10-28）。
//
// 背景：每轮开场都要 qq_load_persona，返回的是整张角色卡（217 行、约 8.7k 字）。这份工具结果会
// 原样写进会话历史，下一轮又带一份 —— 实测单个会话日志里同样的卡出现 132 次（state 里 1.3MB），
// 每一步请求都要重发，缓存价也照付。
//
// 旧实现（src/core/turn-pruner.js）直接改写 session 文件：那是 DSH 0.1.x 的
// `storages/session_projcache/sessions/<id>.json`；0.2.x 改成
// `sessions/<slug>/session-<id>/session.v4.jsonl.zstd`（仅追加 + seq 连续 + 帧校验），
// 那条路径现在永远 resolve 不到文件 → 剪枝静默失效，日志里一条 [pruner] 都没有。
//
// 这里走 DSH **受支持**的那条路：和 @deepseek-ai/dsh-compaction-tool-result-pruner 一样，
// 用 session.append('tool/result', …, { surfaceOp: { op:'replace', startSeq, endSeq } }) 追加一条
// 「替换」事件把旧结果挤出当前 surface —— 原始事件仍在日志里可回放，seq 连续，不影响加载。
//
// 失败一律吞掉并记一行 stderr：剪枝只省 token，绝不能影响回复。

export const name = 'qq-persona-ephemeral';

const PERSONA_MARK = '【persona_load】';
const STUB = '【persona_load: ephemeral_turn_pruned】本轮人设已内化；正文已剪除以省上下文，需要时再调 qq_load_persona。';

function textOf(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  return blocks.filter((b) => b && b.type === 'text').map((b) => String(b.text ?? '')).join('');
}

/** 把一条人设工具结果的本轮内容换成占位（保留调用痕迹与其它 block） */
function stubContent(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  let done = false;
  return blocks.map((b) => {
    if (!b || b.type !== 'text') return b;
    if (!done) { done = true; return { ...b, text: STUB }; }
    return { ...b, text: '' };
  });
}

/**
 * 对一个 session 做一次剪枝；导出给测试用（不依赖 cordis 上下文）。
 * @returns {number} 实际替换的条数
 */
export function prunePersonaResults(session) {
  if (!session || typeof session.append !== 'function') return 0;
  const nodes = session.surface && Array.isArray(session.surface.nodes) ? [...session.surface.nodes] : [];
  if (!nodes.length) return 0;
  let replaced = 0;
  for (const seq of nodes) {
    const event = typeof session.eventAt === 'function' ? session.eventAt(seq) : null;
    if (!event || event.type !== 'tool/result') continue;
    const message = event.data?.message;
    const text = textOf(message);
    if (!text.includes(PERSONA_MARK)) continue;
    if (text.length <= STUB.length + 80) continue; // 已经剪过：只剩占位
    try {
      session.append('tool/result', { ...event.data, message: { ...message, content: stubContent(message) } }, {
        surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
        sourceEventSeqs: [seq],
      });
      replaced += 1;
    } catch { /* 单条替换失败不影响其它条 */ }
  }
  return replaced;
}

export function apply(ctx) {
  if (!ctx || typeof ctx.on !== 'function') return;
  ctx.on('agent/turn-stopping', (payload) => {
    try {
      const session = payload?.agent?.session;
      const n = prunePersonaResults(session);
      if (n > 0 && typeof ctx.logger?.info === 'function') ctx.logger.info(`[qq-persona-ephemeral] 本轮剪掉 ${n} 段瞬态人设`);
    } catch (e) {
      try { console.error(`[qq-persona-ephemeral] skip: ${String(e?.message ?? e).slice(0, 160)}`); } catch { /* 日志都写不出去就算了 */ }
    }
  });
}
