// 群聊发言闸门（2026-10-30）
// ── 为什么在这一层 ────────────────────────────────────────────────
// 现场证据（2026-10-30 02:06~02:22 journalctl）：
//   · 主力群 group:868756515 实际是 diving + probability 0.15，不是 anyMessage；
//     上一版把预算写在 evaluateWakeTrigger 的 `if (tr.anyMessage)` 分支里，于是**一次都没执行**（8 小时 0 条日志）。
//   · 真正让它不停说话的是两条自唤醒链：每次发完消息排 replyCheck（15~29s 后再叫一次），
//     以及主动机会 proactiveCheck（8~20min 一次）。这两条都不经过 evaluateWakeTrigger。
// 所以闸门必须放在 scheduleWake —— 所有唤醒（含三条自唤醒链）的唯一入口。
//
// ── 参考实现 ──────────────────────────────────────────────────────
// MaiBot src/maisaka/turn_trigger/（同一问题域：QQ/NapCat 群聊、中文）：
//   scheduler.py        流水线：消息防抖 → 静默消费 → @ 强制触发 → 空闲退避 → 动态门控
//   reply_likelihood.py 逻辑回归估计"这批消息会引出一次 reply"的概率（阈值表见 dynamic_gate.py）
//   dynamic_gate.py     闭环：目标回复数 = 频率 × 预计回复数；窗口内实际回复超出就收紧保留比例
//   idle_backoff.py     连续空闲后 base*2^n 退避（有上限，待处理够多可绕过）
// 我们照抄的是"形状"，不是数值：MaiBot 的权重是从它自己的 Planner 首轮记录拟合出来的，
// 换模型就得重拟合；这里保留同样 8 个特征与符号，阈值做成可调项，靠 `[speech-gate]` 日志里
// 的 score 实测校准。
// 两处有意的分歧：
//   ① recent_self_ratio 取负号。MaiBot 那一项是正权重（它自己越说越容易继续说），
//      但在它那边下压靠的是 dynamic_gate 的闭环；我们这一层就直接当"别抢话"信号用。
//   ② @/点名/关键词/提问 完全绕过闸门，且不占用配额。MaiBot 会把强制触发也计入回复额度，
//      那是因为它有 Planner 兜底；我们这里额度是硬的，计入等于让人一 @ 就把配额打光。
import { log } from '../lib/log.js';

/** 需要过闸门的唤醒原因（其余一律放行：@/点名/提问/关键词/拍一拍/私聊/超时续接等真实触发）。 */
const GATED_REASONS = new Set([
  'probability',   // 潜水模式按概率接话
  'anyMessage',    // 活跃模式每条都唤醒
  'topic',         // 命中 AI 话题关键词
  'replyCheck',    // 发完消息后自查还有没有漏回
  'proactiveCheck',// 主动机会
  'afterthought',  // 私聊碎碎念（私聊本来就不过闸门，留着防御）
  'activityStart'  // 活跃时段开始
]);

const RECENT_WINDOW_MS = 5 * 60 * 1000;
const MEDIA_ONLY_RE = /^\s*(\[图片|\[表情|\[语音|\[文件|\[卡片|\[CQ:image|\[CQ:mface)/;

// MaiBot reply_likelihood.py 的拟合权重（截距 + 8 项），仅用于给出 0~1 的分数。
const INTERCEPT = -1.2005;
const W_MENTION_BOT = 1.5852;
const W_AT_OTHER = -1.1157;
const W_QUESTION = 0.4807;
const W_PLACEHOLDER_ONLY = -1.0281;
const W_RECENT_SELF_RATIO = -2.6525; // 见文件头「分歧①」：符号相对 MaiBot 取反
const W_RECENT_COUNT = -0.0367;
const W_LOG_SINCE_BOT = 0.0571;
const W_PENDING = 0.1012;
const MAX_PENDING = 20;

function baseReason(reason) {
  return String(reason ?? '').split(':')[0].trim();
}

/** 这批未读里有没有"在跟别人说话"的迹象（@ 了别人、或纯媒体）。 */
function summarizeBatch(batch) {
  const texts = batch.map((m) => String(m?.text ?? m?.plain ?? '').trim()).filter(Boolean);
  const atOther = texts.some((t) => t.includes('@'));
  const hasQuestion = texts.some((t) => t.includes('?') || t.includes('？'));
  const placeholderOnly = texts.length > 0 && texts.every((t) => MEDIA_ONLY_RE.test(t));
  return { atOther, hasQuestion, placeholderOnly };
}

/** 近 5 分钟内"自己说了几条 / 一共几条"。数据源是 recentMessages（发送时由各发送路径写入，含 isSelf）。 */
function recentActivity(st, now) {
  const recent = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
  let self = 0;
  let total = 0;
  for (const m of recent) {
    const t = Number(m?.time) || 0;
    if (!t || now - t > RECENT_WINDOW_MS) continue;
    total += 1;
    if (m?.isSelf) self += 1;
  }
  return { self, total };
}

/** 给定一批未读消息，估计"叫醒模型后它会开口"的概率（0~1）。 */
export function estimateReplyLikelihood(st, now, batch) {
  const { atOther, hasQuestion, placeholderOnly } = summarizeBatch(batch);
  const { self, total } = recentActivity(st, now);
  const sinceBot = Number(st?.lastAiReplyAt) > 0 ? Math.max(0, (now - Number(st.lastAiReplyAt)) / 1000) : 3600;
  const recentSelfRatio = total > 0 ? self / total : 0;
  const logit = INTERCEPT
    + W_MENTION_BOT * 0
    + W_AT_OTHER * (atOther ? 1 : 0)
    + W_QUESTION * (hasQuestion ? 1 : 0)
    + W_PLACEHOLDER_ONLY * (placeholderOnly ? 1 : 0)
    + W_RECENT_SELF_RATIO * Math.min(1, Math.max(0, recentSelfRatio))
    + W_RECENT_COUNT * Math.max(0, total)
    + W_LOG_SINCE_BOT * Math.log1p(Math.max(0, sinceBot))
    + W_PENDING * Math.min(MAX_PENDING, Math.max(0, batch.length));
  return 1 / (1 + Math.exp(-logit));
}

/**
 * 判断这次唤醒该不该真的投给模型。纯判断 + 一处理性记账（放行时记 _speechLastPassAt）。
 * @returns {{allow:boolean, why:string, detail:string, score:number}}
 */
export function checkSpeechGate({ key, st, reason, cfg, now = Date.now() }) {
  const conf = cfg?.social?.speech ?? {};
  const base = baseReason(reason);
  if (conf.enabled === false) return { allow: true, why: 'off', detail: '', score: 0 };
  if (!String(key ?? '').startsWith('group:')) return { allow: true, why: 'not-group', detail: '', score: 0 };
  if (!GATED_REASONS.has(base)) return { allow: true, why: 'directed', detail: base, score: 0 };

  const pending = Array.isArray(st?.unread) ? st.unread : [];
  const score = estimateReplyLikelihood(st, now, pending);
  const detailParts = [];

  // ① 最短间隔：从上一次放行或上一次真发言算起。用 _speechLastPassAt 而不是只看 lastAiReplyAt，
  //    因为"叫醒了但模型没说话"也必须算一次占用，否则沉默一轮后下一秒又被叫醒。
  const minGapMs = Math.max(0, Number(conf.minGapMs ?? 120000));
  const lastTouch = Math.max(Number(st?._speechLastPassAt) || 0, Number(st?.lastAiReplyAt) || 0);
  if (minGapMs > 0 && lastTouch > 0 && now - lastTouch < minGapMs) {
    const wait = Math.round((minGapMs - (now - lastTouch)) / 1000);
    return { allow: false, why: 'gap', detail: `还需 ${wait}s（间隔 ${Math.round(minGapMs / 1000)}s）`, score };
  }

  // ② 滑动窗口配额：按**已发出**的消息数算，不按唤醒数算 —— 叫醒后选择沉默不该消费额度。
  const windowMs = Math.max(60000, Number(conf.windowMs ?? 1800000));
  const maxPerWindow = Math.max(0, Number(conf.maxPerWindow ?? 5));
  const recent = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
  const sentInWindow = recent.filter((m) => m?.isSelf && Number(m?.time) > 0 && now - Number(m.time) < windowMs).length;
  if (maxPerWindow > 0 && sentInWindow >= maxPerWindow) {
    return { allow: false, why: 'quota', detail: `近 ${Math.round(windowMs / 60000)}min 已发 ${sentInWindow} 条 ≥ 配额 ${maxPerWindow}`, score };
  }

  // ③ 别抢话：近 5 分钟自己占比过高就闭嘴（MaiBot 用闭环纠偏，我们直接写成硬信号）。
  const { self, total } = recentActivity(st, now);
  const maxSelfRatio = Number(conf.maxSelfRatio ?? 0.35);
  if (total >= 4 && maxSelfRatio > 0 && self / total > maxSelfRatio) {
    return { allow: false, why: 'domination', detail: `近 5min 自己 ${self}/${total} = ${(100 * self / total).toFixed(0)}% > ${(100 * maxSelfRatio).toFixed(0)}%`, score };
  }

  // ④ 概率门：叫醒模型前先估一次"它大概会开口吗"。只有拿到至少一条未读时才启用，
  //    免得 unread 为空时分数天然偏低，把正常唤醒也掐掉。
  const threshold = Number(conf.likelihoodThreshold ?? 0.3);
  if (conf.likelihoodGate !== false && pending.length > 0 && threshold > 0 && score < threshold) {
    return { allow: false, why: 'likelihood', detail: `score ${score.toFixed(2)} < ${threshold}`, score };
  }

  st._speechLastPassAt = now;
  detailParts.push(`${base} score ${score.toFixed(2)} 近 ${Math.round(windowMs / 60000)}min 已发 ${sentInWindow}/${maxPerWindow}`);
  return { allow: true, why: 'pass', detail: detailParts.join(' '), score };
}
