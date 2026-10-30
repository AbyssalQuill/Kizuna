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
/* 2026-10-30：括号里一个汉字/拉丁字母都没有 = 不是动作描写，是颜文字。
 * 冷脸萌整套里有两张天生带括号（（ᗜ_ᗜ）➡（ᗜ֊ᗜ）、( ╯－︿－)╯╧╧），一刀切会把它们剥成空。
 * 动作描写必然带字（"尾鳍拍了两下水" / "smiles"），所以按"有没有字"分流是安全的：
 * 有字 → 剥；纯符号 → 当颜文字原样留着。 */
const ACTION_WORD_RE = /[\u3400-\u9fffA-Za-z]/;
/* 2026-10-30：动作描写剥离（默认开启）。
 * 用户原话：「当然我们仍然不希望有动作描写」。
 * 规则精细安全：成对括号内含有汉字/英文单词的（如（甩了甩尾巴）、（蹭蹭）、*笑*）判定为舞台动作，予以干净剥除；
 * 纯符号颜文字（如 ( ˘ω˘ )、(>_<)）不含文字，原样保留。 */
let actionStripEnabled = true;
/** 颜文字换行守卫（默认开）+ 一行按多少列算（默认 30；线上气泡约 31 列） */
let kaomojiLineGuard = true;
let kaomojiMaxCols = 30;
export function configureOutbound(opts = {}) {
  if (typeof opts?.stripActionBrackets === 'boolean') actionStripEnabled = opts.stripActionBrackets;
  if (typeof opts?.kaomojiLineGuard === 'boolean') kaomojiLineGuard = opts.kaomojiLineGuard;
  if (Number.isFinite(Number(opts?.kaomojiMaxCols)) && Number(opts.kaomojiMaxCols) > 0) kaomojiMaxCols = Math.round(Number(opts.kaomojiMaxCols));
}
export function actionStripStatus() { return actionStripEnabled; }
/* 星号动作（*笑*）跟括号不是一回事：真人 QQ 聊天里不会这么写，所以它**始终剥**，
 * 与「括号要不要留」的开关解耦（2026-10-30 主人只要求去掉括号正则）。 */
const STAR_SPAN_RE = /\*[^*\n]{0,80}\*/g;
export function stripActionBrackets(text) {
  const s = String(text ?? '');
  if (!s) return s;
  if (!actionStripEnabled) return s.replace(STAR_SPAN_RE, '');
  return s.replace(ACTION_SPAN_RE, (m) => {
    if (m.startsWith('*')) return '';
    const inner = m.slice(1, -1);
    return ACTION_WORD_RE.test(inner) ? '' : m;
  });
}

/* 颜文字整块不跨行（2026-10-30 主人：「冷脸萌被切成两半」）。
 * 现场：气泡「不过拟人还行这句话我记下了 ᗜ - ᗜ」在 QQ 里被自动换行切成
 *   「…我记下了 ᗜ -」 / 「ᗜ」，脸直接废掉。
 * 做法：按列宽近似气泡宽度（CJK 记 2 列，其余 1 列），「正文 + 空格 + 颜文字」放不下就把颜文字整体挪到下一行；
 *   放得下原样不动（不做多余改动）。不写死 ᗜ —— 人设里换成任何颜文字都是同一套标准，不必单独发一条。 */
const WIDE_CHAR_RE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/;
const WORD_CHAR_RE = /[\u3400-\u9fffA-Za-z0-9]/;      // 汉字 / 拉丁 / 数字 = 正文，扫到这里停
const SENTENCE_END_RE = /[。！？；：、.!?;:]/;           // 句读 = 一定不是颜文字的一部分
const CJK_PUNCT_RE = /[\u3000-\u303f]/;                // 中文标点同理

/** 近似列宽：CJK 记 2 列，其余 1 列 */
export function columnWidth(text) {
  let w = 0;
  for (const ch of String(text ?? '')) w += WIDE_CHAR_RE.test(ch) ? 2 : 1;
  return w;
}

/** 取正文末尾那段颜文字（没有就返回 null）。返回 { start, face }。 */
export function tailFaceSpan(text) {
  const s = String(text ?? '');
  if (!s || s.includes('\n')) return null;
  let i = s.length;
  let sawSymbol = false;
  while (i > 0) {
    const ch = s[i - 1];
    if (WORD_CHAR_RE.test(ch) || SENTENCE_END_RE.test(ch) || CJK_PUNCT_RE.test(ch)) break;
    if (!/\s/.test(ch)) sawSymbol = true;
    i -= 1;
  }
  if (!sawSymbol) return null;
  const start = s.slice(0, i).length;
  const face = s.slice(start).trim();
  if (face.length < 2) return null;   // 单个 "~" 之类不算颜文字
  return { start, face };
}

/** 放不下就把颜文字挤到下一行；放得下原样返回。 */
export function guardKaomojiLine(text, maxCols = 30) {
  const s = String(text ?? '');
  const span = tailFaceSpan(s);
  if (!span) return s;
  const prefix = s.slice(0, span.start).trimEnd();
  if (!prefix) return s;
  if (columnWidth(prefix) + 1 + columnWidth(span.face) <= maxCols) return s;
  return prefix + '\n' + span.face;
}

export function stripTrailingPeriod(text) {
  let s = String(text ?? '').trimEnd();
  // 只去掉末尾连续的中文句号与英文句号，问号（？/?）、感叹号（！/!）、波浪号等正常保留
  return s.replace(/[。.]+$/g, '').trimEnd();
}

/* 2026-10-30 主人：「都别写死，提示词里强调就行」。
 * 所以这里保持原样返回 —— 不再在出站层把"人家"改成"我"。
 * 语气/自称这种事交给提示词（[style] 行的 self_call_wo_only + persona 的同名 token），
 * 桥只做"给什么发什么"。历史上这段被加上又被撤掉过一次，这次记清楚：它现在是故意空着的。 */
export function normalizeFirstPersonSelfCall(text) {
  return String(text ?? '');
}

// 出站文本统一清洗：占位符清扫 → 动作括号剥离 → 输入法 emoji 剥离 → 仅去除末尾句号（问号叹号保留）。
export function cleanOutboundTextDetailed(text) {
  const swept = sweepMessageArtifacts(text);
  const stripped = stripActionBrackets(swept.text);
  const noEmoji = stripImeEmoji(stripped);
  const guarded = kaomojiLineGuard ? guardKaomojiLine(noEmoji, kaomojiMaxCols) : noEmoji;
  return {
    text: stripTrailingPeriod(guarded),
    removedArtifacts: swept.removed,
    actionStripped: stripped !== swept.text,
  };
}

export function cleanOutboundText(text) {
  return cleanOutboundTextDetailed(text).text;
}
