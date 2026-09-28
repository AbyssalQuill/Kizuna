// src/core/token-report.js — `/token` 指令：把「今日用量 + 今日花费」说成人话（2026-09-21）
//
// 需求：输入 /token 就自动发出今天的 token 消耗总量与钱数消耗。
//
// ── 为什么单独一个模块（而不是塞进 mux.js）────────────────────────────────────
//   · mux.js 已经 1300+ 行，指令分支里塞金额计算会越写越乱；
//   · 口径必须与管理端「学习/用量」页的实测区逐字一致，否则用户拿两边对数必然对不上。
//     管理端口径（src/pages/Learning.tsx::useLiveCost）：
//       实测 = 只统计确实带缓存命中字段的请求（cacheSamples>0 的小时桶），不反推、不外推；
//       金额 = (命中×pHit + 未命中×pMiss + 输出×pOut)/1e6 × 高峰倍率；
//       高峰时段（北京时）= 周一至周五（不含法定节假日）09:00-12:00 与 14:00-18:00，
//       倍率 ×peakMult；周末、调休上班的周末、法定节假日全天一律按谷价（见下方 HOLIDAY_VALLEY）。
//     这里逐字复刻那套算法，默认单价也同源（Learning.tsx::COST_DEFAULT）。
//   · 单价可在 config.json 的 `tokenCost` 段覆盖（管理端 Core 设置可改）；
//     口径不变、只换单价 —— 用户调价后 /token 与面板同时变。
//
// 依赖：core/token-meter.js 的 getTokenReport()（计费日口径，默认北京时 08:00 换日）。
import { getTokenReport } from './token-meter.js';

// ── 峰谷口径（2026-09-26 对齐小鲸鱼挂件 dsh-whale-widget）──────────────────────
// 官方说明：高峰 = 北京时间周一至周五（**不含中国法定节假日**）9:00–12:00、14:00–18:00；
// 其余时段 —— 包括周末、调休上班的周末、以及法定节假日全天 —— 一律按空闲时段（谷价）计费。
//   时间线：2026-08-17 峰谷定价实施 → 2026-08-23 00:00 起周末全天谷价 →
//           2026-09-19 明确「调休上班的周末 + 法定节假日全天」也按谷价。
// 改之前这里只按「小时」判高峰（peakHours 集合），没有星期与节假日概念：于是每个周末、
// 以及中秋连假（2026-09-25~09-27）都被算成高峰、金额翻倍 —— 这就是主人 2026-09-26 看到的
// 「峰谷定价不准了，小鲸鱼插件是准的」。下面这张节假日表逐字照抄挂件的 HOLIDAY_VALLEY。
// ⚠️ 每年 11 月国务院发布次年安排后，必须在这里补下一年的日期。
export const HOLIDAY_VALLEY = {
  '2026-01-01': 1, '2026-01-02': 1, '2026-01-03': 1, // 元旦 1/1–1/3（1/4 周日上班）
  '2026-02-15': 1, '2026-02-16': 1, '2026-02-17': 1, '2026-02-18': 1, '2026-02-19': 1, // 春节 2/15–2/23（9 天）
  '2026-02-20': 1, '2026-02-21': 1, '2026-02-22': 1, '2026-02-23': 1,
  '2026-04-04': 1, '2026-04-05': 1, '2026-04-06': 1, // 清明 4/4–4/6
  '2026-05-01': 1, '2026-05-02': 1, '2026-05-03': 1, '2026-05-04': 1, '2026-05-05': 1, // 劳动节 5/1–5/5（5/9 周六上班）
  '2026-06-19': 1, '2026-06-20': 1, '2026-06-21': 1, // 端午 6/19–6/21
  '2026-09-25': 1, '2026-09-26': 1, '2026-09-27': 1, // 中秋 9/25–9/27
  '2026-10-01': 1, '2026-10-02': 1, '2026-10-03': 1, '2026-10-04': 1, // 国庆 10/1–10/7（9/20 周日、10/10 周六上班）
  '2026-10-05': 1, '2026-10-06': 1, '2026-10-07': 1,
};
// 生效分界（北京时间）：2026-08-23 00:00 起周末算谷时；2026-09-19 00:00 起节假日算谷时。
// 分界之前的历史分桶仍按旧规则计价，所以判定要带上这两个时间点。
const WEEKEND_VALLEY_FROM_MS = Date.UTC(2026, 7, 22, 16, 0, 0);
const HOLIDAY_VALLEY_FROM_MS = Date.UTC(2026, 8, 18, 16, 0, 0);

/** 毫秒时间戳 → 北京日历日键 `YYYY-MM-DD`（分时桶按北京自然日聚合，判定也得用北京日期）。 */
export function bjDayKey(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return "";
  return new Date(n + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 按官方规则判「这一刻是不是高峰」：只看北京时间的星期与时刻，节假日与周末直接判谷。 */
export function isPeakAtMs(ms, peakHours) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return false;
  const set = peakHours instanceof Set ? peakHours : new Set(Array.isArray(peakHours) ? peakHours : DEFAULT_TOKEN_COST.peakHours);
  const bj = new Date(n + 8 * 3600 * 1000);
  if (n >= WEEKEND_VALLEY_FROM_MS) {
    const dow = bj.getUTCDay();            // 按 UTC 读平移后的时间 = 北京日历日的星期
    if (dow === 0 || dow === 6) return false;
  }
  if (n >= HOLIDAY_VALLEY_FROM_MS && HOLIDAY_VALLEY[bj.toISOString().slice(0, 10)]) return false;
  return set.has(bj.getUTCHours());
}

/**
 * 分时桶用的高峰判定。
 * @param hour 0..23（北京小时）
 * @param opts.dayKey 该桶所属的北京日期 `YYYY-MM-DD`（给了它就按官方规则判：周末/节假日→谷时）
 * @param opts.at 代表时刻（毫秒）；与 dayKey 二选一
 * @param opts.peakHours 计为高峰的小时集合（config.tokenCost.peakHours）
 * 两者都没给时退回旧口径（只看小时）—— 老调用点没有日期信息，不能凭空猜。
 */
export function isPeakHour(hour, opts = {}) {
  const h = Number(hour);
  if (!Number.isFinite(h)) return false;
  const set = opts.peakHours instanceof Set ? opts.peakHours
    : new Set(Array.isArray(opts.peakHours) ? opts.peakHours : DEFAULT_TOKEN_COST.peakHours);
  if (Number.isFinite(Number(opts.at))) return isPeakAtMs(Number(opts.at), set);
  const key = typeof opts.dayKey === "string" ? opts.dayKey : "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(key)) {
    const dayMs = Date.parse(`${key}T00:00:00+08:00`);
    if (Number.isFinite(dayMs)) return isPeakAtMs(dayMs + h * 3600 * 1000, set);
  }
  return set.has(h);
}
export const DEFAULT_TOKEN_COST = {
  pHit: 0.02,      // ¥ / 百万 tok，缓存命中（谷时）
  pMiss: 1,        // ¥ / 百万 tok，未命中输入（谷时）
  pOut: 4,         // ¥ / 百万 tok，输出（谷时）
  peakMult: 2,     // 高峰倍率
  peakHours: [9, 10, 11, 14, 15, 16, 17],   // 北京时高峰小时（还要过「工作日 + 非节假日」这道闸）
};

/** 计费口径说明：给 /token 正文末尾那一行用（用户问"这数怎么算出来的"时有据可依）。 */
let cfgRef = null;
export function initTokenReportCore(cfg) {
  cfgRef = cfg || null;
}

function priceCfg() {
  const raw = cfgRef?.tokenCost && typeof cfgRef.tokenCost === 'object' ? cfgRef.tokenCost : {};
  const numOr = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const hours = Array.isArray(raw.peakHours) && raw.peakHours.length
    ? raw.peakHours.map((h) => Number(h)).filter((h) => Number.isFinite(h) && h >= 0 && h <= 23)
    : DEFAULT_TOKEN_COST.peakHours;
  return {
    pHit: numOr(raw.pHit, DEFAULT_TOKEN_COST.pHit),
    pMiss: numOr(raw.pMiss, DEFAULT_TOKEN_COST.pMiss),
    pOut: numOr(raw.pOut, DEFAULT_TOKEN_COST.pOut),
    peakMult: Math.max(1, numOr(raw.peakMult, DEFAULT_TOKEN_COST.peakMult)),
    peakHours: new Set(hours),
  };
}

/** 千分位（金额/大数读起来不费眼） */
export function fmtNum(v) {
  const n = Number(v) || 0;
  return n.toLocaleString('en-US');
}
/** 1_234_567 → 1.23M；12_345 → 12.3k；< 1000 原样 */
export function fmtTok(v) {
  const n = Math.round(Number(v) || 0);
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(1)}k`;
  return fmtNum(n);
}

/**
 * 纯函数：小时桶数组 → 实测口径汇总（与管理端 useLiveCost 的实测分支逐字一致）。
 * @param {Array<{hour:number,prompt:number,completion:number,cacheRead:number,cacheWrite:number,cachePrompt:number,cacheCompletion:number,cacheSamples:number}>} hours
 * @param {{pHit:number,pMiss:number,pOut:number,peakMult:number,peakHours:Set<number>}} price
 * @param {{dayKey?:string}} [opts] dayKey=这些分时桶所属的北京日期（不传则退回「只看小时」旧口径）
 */
export function summarizeMeasuredCost(hours, price, opts = {}) {
  let mHit = 0; let mMiss = 0; let mOut = 0; let mSamples = 0;
  let cost = 0; let offCost = 0; let peakCost = 0; let peakHours = 0;
  let dayMiss = 0; let dayOut = 0; let dayCacheRead = 0; let dayCacheWrite = 0; let dayTotal = 0;
  for (const h of Array.isArray(hours) ? hours : []) {
    dayMiss += Number(h?.prompt) || 0;
    dayOut += Number(h?.completion) || 0;
    dayCacheRead += Number(h?.cacheRead) || 0;
    dayCacheWrite += Number(h?.cacheWrite) || 0;
    dayTotal += (Number(h?.prompt) || 0) + (Number(h?.completion) || 0) + (Number(h?.cacheRead) || 0);
    const mult = isPeakHour(h?.hour, { dayKey: opts?.dayKey, peakHours: price.peakHours }) ? price.peakMult : 1;
    const samples = Number(h?.cacheSamples) || 0;
    if (samples > 0) {
      const hit = Number(h?.cacheRead) || 0;
      const miss = Number(h?.cachePrompt) || 0;
      const out = Number(h?.cacheCompletion) || 0;
      mHit += hit; mMiss += miss; mOut += out; mSamples += samples;
      const c = ((hit * price.pHit + miss * price.pMiss + out * price.pOut) / 1e6) * mult;
      cost += c;
      if (mult > 1) { peakCost += c; peakHours += 1; } else { offCost += c; }
    }
  }
  const measuredRate = (mHit + mMiss) > 0 ? mHit / (mHit + mMiss) : null;
  return {
    mHit, mMiss, mOut, mSamples, cost, offCost, peakCost, peakHours,
    dayMiss, dayOut, dayCacheRead, dayCacheWrite, dayTotal, measuredRate,
  };
}

/**
 * 组一条 `/token` 回复（短句、人话；空行分气泡由调用方决定）。
 *
 * 2026-09-22 修「/token 与管理端面板对不上」——是口径混用，不是算错：
 * 线上实测（北京 10:00 那次，数字全部可复算）：
 *   · 面板顶部「今日已用」            = 592,685  ← `today.billedTotal`，计费日（08:00 换日 = 提供方控制台口径）
 *   · 面板「实测计量」里的「今日 token 合计」= 12,182,789 ← 分时桶合计，北京自然日 00:00 起
 *   · 面板两处都对，区别只在口径；面板自己也在正文里写了「北京自然日 00:00 起合计 …… 其中
 *     00:00–08:00 那段平台算在昨天」。
 * 而旧版 /token 把两个口径挨着印：第一行总量取计费日（592.7k），第二行的"新输入/命中/输出"
 * 与金额却来自自然日分时桶（12.18M 那一套）——读起来就是"592.7k 下面挂着 12.18M 的分量"，
 * 当然像算错了。现在逐行标注口径，并且每个数字都能在面板里指到出处：
 *   2026-09-28 版式（主人给的样式：一行一个口径、标签后用全角冒号、同行多个数值用「｜」分隔、数值带单位）：
 *     第 1 行 今日 ：… tok（计费日）       = 面板顶部「今日已用」（计费日，平台口径）
 *     第 2 行 自然日：… tok                = 面板「实测计量」下方「今日 token 合计」（北京自然日 00:00 起）
 *     第 3 行 命中率：…｜未命中｜命中｜输出  = 面板「实测计量」的命中率与三段分量（自然日分时桶）
 *     第 4 行 费用：¥…（谷 ¥…｜峰 ¥…）      = 面板「今日费用」（实测，按自然日分时，谷时/高峰分开）
 *     第 5 行 全天预估：约 … tok           = 面板「今日预计」
 *   （旧版的「第 2/3 行」「最后一行」就是上面这五行里的第 2~5 行，口径映射没变。）
 * `days>1` 那条路原来还有个真 bug：总量取的是 today.billedTotal（只算今天），却印成"近 N 天"。
 * 现在按 `dates`（计费日逐日）求和。
 * @param {{days?:number}} opts days=取几天（默认 1=今天）
 * @returns {{ok:boolean, text:string, data:object}}
 */
export function buildTokenReportText(opts = {}) {
  const days = Math.max(1, Math.min(60, Math.round(Number(opts.days) || 1)));
  // opts.nowMs：只给测试用（"日界口径"这类断言必须能在固定时刻复现，不能跟着挂钟走 —— 实测：
  // 同一份测试在北京 11:00 之后会因为"3 小时前那一行也落在计费日里"而失败）
  const nowMs = Number(opts.nowMs);
  let rep = null;
  try { rep = getTokenReport(days, Number.isFinite(nowMs) ? { nowMs } : undefined); } catch (e) {
    return { ok: false, text: `用量库读不出来：${e?.message ?? e}`, data: {} };
  }
  const price = priceCfg();
  // 分时桶按北京自然日聚合，所以高峰判定要带上「今天」这个北京日期（周末/节假日整日算谷时）
  const sum = summarizeMeasuredCost(rep?.todayHourly, price, {
    dayKey: bjDayKey(Number.isFinite(nowMs) ? nowMs : Date.now()),
  });
  const today = rep?.today ?? {};
  // 计费日（平台口径）：未命中 + 命中 + 缓存写 + 输出，只有真实行
  const todayBilled = Number(today.billedTotal) || 0;
  const todayEst = Number(today.estTotal) || 0;
  // 北京自然日 00:00 起：分时桶合计（面板「今日 token 合计」就是它）
  const naturalTotal = sum.dayTotal;
  const naturalSame = naturalTotal > 0 && Math.abs(naturalTotal - todayBilled) < Math.max(1, todayBilled * 0.005);
  const windowDates = Array.isArray(rep?.dates) ? rep.dates : [];
  const windowTotal = windowDates.reduce((a, d) => a + (Number(d?.total) || 0), 0);
  const rate = sum.measuredRate;

  if (days === 1) {
    if (todayBilled <= 0 && todayEst <= 0) {
      return {
        ok: true,
        text: `今日还没有用量记录（一条 usage 帧都还没收到）`,
        data: { days, billed: todayBilled, naturalTotal, est: todayEst, cost: 0 },
      };
    }
    /* 2026-09-28 主人给的版式（原话：「报告写成这种类型」）——五行、一行一个口径：
     *     今日 ：39,580,622 tok
     *     自然日：61,146,491 tok
     *     命中率：97.7%｜未命中 1,417,135｜命中 59,674,368｜输出 54,988
     *     费用：¥3.0567（谷 ¥2.6045｜峰 ¥0.4522）
     *     全天预估：约 61,198,852 tok
     * 与 2026-09-26 那版（一行塞三个口径）比：标签对齐、数值带 tok、谷峰用「｜」分隔、全天预估独立成行。
     * 第 1 行**不带任何口径注**（同日主人明确：「我没让你带括号里的废话，计费日换日」）——两个日界
     * 现在只靠行首的「今日」/「自然日」两个标签区分；为什么会差一截（计费日 = 北京 08:00 换日，
     * 自然日 = 北京 00:00 起）只在管理端「桥接 → 用量与统计」的帮助文字与「学习」页正文里解释，
     * 不再出现在 QQ 回复里。（2026-09-22 那次「两个口径挨着印、看着像算错」是靠分行 + 标签修的，
     * 现在仍是分行 + 标签；括号注只是当时的补充说明。）
     * 全天预估 = 自然日已用 + 到 24:00 的预计剩余（restOfDayEstimate）；不能拿计费日预计减基数，
     * 那会把次日 0-8 点算两遍。 */
    const fullDay = Math.round(naturalTotal + (Number(rep?.restOfDayEstimate) || 0));
    const money = Number(sum.cost) || 0;   // 三行版把 money 声明删漏了，补回（data 里还在用）
    const proj = Number(rep?.todayEstimatedTotal) || 0;   // 同上：data 的 projected 还在用它
    const lines = [];
    // 标签列对齐：「今日」两字，后面补一个空格，与「自然日 / 命中率」这类三字标签齐平
    lines.push(`今日 ：${fmtNum(todayBilled)} tok`);
    lines.push(`自然日：${fmtNum(naturalTotal)} tok`);
    lines.push(`命中率：${rate != null ? `${(rate * 100).toFixed(1)}%` : '—（本时段没有带缓存字段的请求）'}`
      + `｜未命中 ${fmtNum(sum.mMiss)}｜命中 ${fmtNum(sum.mHit)}｜输出 ${fmtNum(sum.mOut)}`);
    lines.push(`费用：¥${money.toFixed(4)}`
      + (sum.peakHours > 0 ? `（谷 ¥${Number(sum.offCost).toFixed(4)}｜峰 ¥${Number(sum.peakCost).toFixed(4)}）` : ''));
    lines.push(`全天预估：约 ${fmtNum(fullDay)} tok`);
    return {
      ok: true,
      text: lines.join('\n'),
      data: {
        days, billed: todayBilled, naturalTotal, naturalSame, est: todayEst, cost: money,
        rate, peakCost: sum.peakCost, offCost: sum.offCost, projected: proj,
      },
    };
  }

  // 近 N 天：总量按 `dates`（计费日逐日）求和 —— 旧版这里错取了"只算今天"的 billedTotal
  // 版式与当天那份对齐（2026-09-28）：标签 + 全角冒号、数值带单位、同行多值用「｜」分隔。
  const lines = [];
  lines.push(`近 ${days} 天：${fmtNum(windowTotal)} tok（计费日逐日合计，含今日）`);
  let c = 0;
  for (const d of windowDates) {
    c += ((Number(d?.cacheRead) || 0) * price.pHit
      + (Number(d?.prompt) || 0) * price.pMiss
      + (Number(d?.completion) || 0) * price.pOut) / 1e6;
  }
  lines.push(`费用：约 ¥${c.toFixed(4)}（逐日按谷时价算，未含高峰倍率）`);
  if (todayBilled > 0) lines.push(`其中今日：${fmtNum(todayBilled)} tok｜¥${sum.cost.toFixed(4)}（自然日分时实测）`);
  return {
    ok: true,
    text: lines.join('\n'),
    data: { days, windowTotal, cost: c, billed: todayBilled, naturalTotal, todayCost: sum.cost, rate },
  };
}
