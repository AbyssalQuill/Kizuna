// 出站文本清洗
import { KNOWN_AGENT_TOKENS } from './text-safe.js';
import { stripImeEmoji } from './emoji.js';

// 只替换 KNOWN_AGENT_TOKENS 命中的令牌（不动 SENSITIVE_RE 之外的文本）
export function redactKnownTokensOnly(text) {
  let s = String(text ?? '');
  for (const token of KNOWN_AGENT_TOKENS) {
    if (token && s.includes(token)) s = s.split(token).join('***');
  }
  return s;
}

// —— 表情/图片占位符根治（2026-09-03）——
// AI 常把"想发的图/表情描述"误写成文字占位符（[表情:蓝鱼吃白米饭，开心]、
// [表情包:喜欢阁下：蓝发猫耳女仆…]、[QQ表情:害羞(148)]、[表情:xx.webp]、[收藏表情:…]等）。
// 本应通过 qq_send_meme / qq_send_sticker / qq_send_qq_face 或 qq_send_message 的 images
// 参数发真图；直接发这段文字 = "表情没发出去"，是观感崩坏的根源。
// 根治策略：出站文本把这类占位【全部剥掉】，占位单独成条且无法翻译成真表情时【整条丢弃】，
// 绝不把文字版表情发出去；可翻译成 QQ 原生 face 的（如 (148)）直接改发真 face 段。
const ARTIFACT_TOKEN_RE = /\[(?:QQ表情|q表情|表情包|表情|鲸鱼表情|收藏表情|大肥鱼表情|动画表情|动图|截图|图片|贴纸|颜文字|face|sticker)\s*[:：]\s*[^\]\[]+\]|\[(?:表情|QQ表情|face)\s*\(?\d{1,4}\)?\]/g;

// 清扫全部表情/图片占位符。返回 { text: 清除后的正文, removed: 清除个数, tokens: 各占位内部文本 }
export function sweepMessageArtifacts(text) {
  const s = String(text ?? '');
  const cq = [];
  const tokens = [];
  const masked = s.replace(/\[CQ:[^\]]*\]/g, (m) => { cq.push(m); return '\u0003'; });
  let removed = 0;
  let t = masked.replace(ARTIFACT_TOKEN_RE, (m) => {
    removed++;
    tokens.push(m.slice(1, -1));
    return ' ';
  });
  t = t.replace(/\u0003/g, () => cq.shift() || '');
  t = t.replace(/[ \t]{2,}/g, ' ').replace(/\s+([，。！？；：、,.!?;:])/g, '$1').replace(/^\s+|\s+$/g, '');
  return { text: t, removed, tokens };
}

// 兼容旧调用：只取清扫后的文本
export function stripMessageArtifacts(text) {
  return sweepMessageArtifacts(text).text;
}

/* 动作描写剥离（2026-10-29 恢复，默认开启；config.social.speech.stripActionBrackets=false 可关）。
 * 为什么恢复：条目 37 的三条探针实测证明规则、末端锚、示范都压不住括号（5 条气泡 3 条带动作描写）。
 * 口径很窄：只剥成对的 （…）/(…)/*…* 片段（每段 ≤80 字），正文其余标点一律不动。
 * 剥空的调用方负责整条跳过（见 qq-send.js：actionStripped 为真时不再回退原文）。 */
const ACTION_SPAN_RE = /（[^（）]{0,80}）|\([^()]{0,80}\)|\*[^*\n]{0,80}\*/g;
let actionStripEnabled = true;
export function configureOutbound(opts = {}) {
  if (typeof opts?.stripActionBrackets === 'boolean') actionStripEnabled = opts.stripActionBrackets;
}
export function actionStripStatus() { return actionStripEnabled; }
export function stripActionBrackets(text) {
  const s = String(text ?? '');
  if (!s || !actionStripEnabled) return s;
  return s.replace(ACTION_SPAN_RE, '');
}

export function stripTrailingPeriod(text) {
  let s = String(text ?? '').trimEnd();
  // 只去掉末尾连续的中文句号与英文句号，问号（？/?）、感叹号（！/!）、波浪号等正常保留
  return s.replace(/[。.]+$/g, '').trimEnd();
}

export function normalizeFirstPersonSelfCall(text) {
  // 遵循指示：中间的正则全部去掉，不干预中间语句表达
  return String(text ?? '');
}

// 出站文本统一清洗：占位符清扫 → 动作括号剥离 → 输入法 emoji 剥离 → 仅去除末尾句号（问号叹号保留）。
export function cleanOutboundTextDetailed(text) {
  const swept = sweepMessageArtifacts(text);
  const stripped = stripActionBrackets(swept.text);
  const noEmoji = stripImeEmoji(stripped);
  return {
    text: stripTrailingPeriod(noEmoji),
    removedArtifacts: swept.removed,
    actionStripped: stripped !== swept.text,
  };
}

export function cleanOutboundText(text) {
  return cleanOutboundTextDetailed(text).text;
}
