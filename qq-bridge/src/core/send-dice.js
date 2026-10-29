// 「这一类内容本轮能不能发」的抽签 —— 桥侧掷骰，不让模型自己按概率决定（2026-09-15）
//
// 背景：语音和表情包原来都只是在提示词里写一句"概率 0.2 就偶尔来一个"，那属于软引导：
// 模型看不到真正的随机数，判断很飘（要么连着发、要么整晚不发）。现在桥每次唤醒掷一次骰子，
// 把结果当数据行写进唤醒正文（[Voice] / [Meme] dice HIT / MISS / cooldown），模型照着办。
// 语音那份先落在 voice.js 里；这里抽成通用件，语音与表情包共用同一套掷骰与冷却逻辑。
import { log } from '../lib/log.js';

let cfgRef = null;

export function initSendDice(cfg) {
  cfgRef = cfg;
}

/** `${kind}:${key}` -> 最近一次成功发出的时间戳（进程内；重启清空，不影响正确性） */
const sentAt = new Map();

/** 真的发出去了才登记：用于冷却窗口内不再抽中（防"概率虽小却连着发"）。 */
export function noteSent(kind, key) {
  const k = String(key ?? '').trim();
  if (!k) return;
  sentAt.set(`${kind}:${k}`, Date.now());
}

/**
 * 掷骰。
 * @returns {{ p:number, cooling:boolean, hit:boolean }}
 */
export function dice(kind, key, probability, cooldownMs) {
  const p = Math.min(1, Math.max(0, Number(probability) || 0));
  const cd = Math.max(0, Number(cooldownMs) || 0);
  const last = sentAt.get(`${kind}:${String(key ?? '').trim()}`) ?? 0;
  const cooling = cd > 0 && last > 0 && (Date.now() - last) < cd;
  return { p, cooling, hit: !cooling && p > 0 && Math.random() < p };
}

// ── 表情包（内置表情库 qq_send_meme + QQ 收藏表情 qq_send_sticker 共用一条概率）──────
// 配置沿用既有的 social.sticker.sendProbability（管理端「表情包」卡里那个"发表情概率"），
// 新增 sendCooldownMs 管同一会话的连发。
export const MEME_DEFAULT_PROBABILITY = 0.8;
export const MEME_DEFAULT_COOLDOWN_MS = 0;

function memeCfg() {
  const s = cfgRef?.social?.sticker ?? {};
  const prob = Number(s.sendProbability);
  return {
    enabled: cfgRef?.social?.sticker?.enabled !== false,
    probability: Number.isFinite(prob) && prob >= 0 ? prob : MEME_DEFAULT_PROBABILITY,
    cooldownMs: 0 // 彻底去除冷却（零冷却，伴侣自由随心发表情包）
  };
}

/** 表情包发出去之后登记一次（内置表情库与收藏表情两条路都调） */
export function noteMemeSent(key) {
  noteSent('meme', key);
}

/**
 * 唤醒提示词里的表情包抽签行（英文，与 preset 的英文指令框架一致）
 * 抽中给出强指令，平时亦鼓励随心发送画廊表情包，极大丰富对话生动度。
 */
export function memeTurnHint(key) {
  const c = memeCfg();
  if (!c.enabled) return '';
  const { p, cooling, hit } = dice('meme', key, c.probability, c.cooldownMs);
  if (hit) {
    return '[meme_hit] qq_send_meme\n';
  }
  // 同上（主人更正）：这是授权不是催促 —— 允许发，但不要求；默认发文字。
  return '[meme_free] qq_send_meme_allowed_not_required\n';
}

/** 供诊断/日志：当前生效的表情包参数 */
export function memeDiceInfo() {
  const c = memeCfg();
  return { ...c, lastSentAt: sentAt.get('meme:private') ?? 0 };
}

/** 清空登记（测试与排障用） */
export function resetSendDice() {
  sentAt.clear();
  log('[send-dice] 抽签登记已清空');
}
