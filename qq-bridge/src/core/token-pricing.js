// src/core/token-pricing.js — 计费口径的**唯一权威来源**（2026-09-30 建）
//
// 为什么单独拆一份：同一个「花了多少钱」的问题，本机同时有三条实现路径 ——
//   · QQ `/token`（core/token-report.js，读 state/token-usage.jsonl）
//   · 小鲸鱼面板 dsh-whale-widget（lib/index.js 逐轮结算 + lib/pricing.mjs）
//   · 提供方控制台（余额扣减，真实花费）
// 三条路径各自维护价目/峰谷窗口/日界时，谁跟谁都不一样：/token 少算 cacheWrite、
// 多日路径不含高峰倍率、面板漏 cacheWrite、价目表散在 4 个文件里。本文件把
// **价目 + 峰谷窗口 + 节假日表 + 日界 + 金额公式**集中成一份，桥侧直接 import；
// 面板侧是独立安装包（无法跨包 import），用 lib/pricing.mjs 逐字镜像同一份常量，
// 由 tests/token-pricing-parity.test.js 用同一份用量数据锁死两边金额逐分相同。
//
// ── 官方价目（逐字抄自 https://api-docs.deepseek.com/zh-cn/quick_start/pricing ，2026-09-30 复核）──
//   表格原文（元 / 百万 tokens）：
//     deepseek-flash      缓存命中输入 空闲 0.02 / 高峰 0.04
//                         缓存未命中输入 空闲 1    / 高峰 2
//                         输出          空闲 4    / 高峰 8
//     deepseek-v4-pro     缓存命中 0.15 / 0.30；未命中 4.5 / 9.0；输出 13.5 / 27.0
//   脚注(2) 原文：「空闲时段价格为高峰时段价格的一半。北京时间周一至周五（不含中国法定节假日）
//   9:00 - 12:00、14:00 - 18:00 为高峰时段；其余时段，包括周末及中国法定节假日全天均为空闲时段。」
//   扣费规则原文：「扣减费用 = token 消耗量 × 模型单价，对应的费用将直接从充值余额或赠送余额中进行扣减。」
//   —— 官方**没有**「缓存写入单价」这一档：写入的 token 就是未命中输入（缓存未命中价已覆盖），
//      所以公式里 cacheWrite 必须并按**未命中输入价**计价，既不能丢（旧 /token 丢了）也不能另立单价。
//      依据 DSH 权威口径 @deepseek-ai/dsh-llm lib/types/types.d.ts:118-121：
//      「Counts are DISJOINT: inputTokens is uncached input only; cached input is reported
//        separately as cacheReadTokens/cacheWriteTokens (billed input = sum of the three)」。
//
// ── 金额公式（三条路径必须逐字相同）─────────────────────────────────────────────
//   miss = 未命中输入(inputTokens) + 缓存写入(cacheWriteTokens)      ← 两项同价，均为 miss 价
//   cost = (cacheRead×pHit + miss×pMiss + output×pOut) / 1e6 × (高峰 ? peakMult : 1)
//   命中率 = cacheRead / (cacheRead + 未命中输入)（只看确实带缓存字段的请求）
//   · 估算行（est:true，桥侧无真实 usage 时按字符折算）**永不进钱**，只进 token 总量。
//   · 计费日（08:00 北京换日）= 提供方控制台口径；自然日（北京 00:00 起）= 面板记账口径。
//     两个口径都对，只是窗口不同，所以两边都必须带标签、都计入 cacheWrite。

/** 高峰窗口（北京时，[起,止) 小时，仅贴在「周一至周五 + 非节假日」上） */
export const PEAK_WINDOWS = [[9, 12], [14, 18]];

/** 计为高峰的小时集合（config.json tokenCost.peakHours 的默认值，由 PEAK_WINDOWS 展开） */
export const DEFAULT_PEAK_HOURS = [9, 10, 11, 14, 15, 16, 17];

// Flash（正式模型名 deepseek-flash = DeepSeek-V4.1-Flash）：[空闲价, 高峰价]
const FLASH_PRICE = { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] };
// Pro 为 Flash 的 3 倍价（官方 2026-08-17 生效；2026-09-14 公告 pro 继续按自身价目计费）
const PRO_PRICE = { hit: [0.15, 0.3], miss: [4.5, 9.0], out: [13.5, 27.0] };

/** 模型 → 价目表（按键长降序匹配，避免短关键字误伤） */
export const PRICE_TABLE = {
  'deepseek-flash': FLASH_PRICE,
  'deepseek-v4-flash': FLASH_PRICE,             // 旧名已下线，请求由 V4.1-Flash 提供，按 Flash 价计费
  'deepseek-v4-flash-vision-exp': FLASH_PRICE,
  'deepseek-v4-pro': PRO_PRICE,
};
export const DEFAULT_PRICE = FLASH_PRICE;

/** 汇率兜底（自定义单价按美元填写时用；账本统一 CNY） */
export const DEFAULT_USD_RATE = 0;

/**
 * 按模型名取价目（[空闲, 高峰] 对）。
 * @param {string} model
 * @param {Record<string,{hit:number[],miss:number[],out:number[]}>} [table] 覆盖表（面板自定义单价用）
 */
export function priceForModel(model, table = PRICE_TABLE) {
  const m = String(model || '').toLowerCase();
  const keys = Object.keys(table || {}).sort((a, b) => b.length - a.length);
  for (const k of keys) if (k && m.indexOf(k) !== -1) return table[k];
  return DEFAULT_PRICE;
}

// ── 法定节假日全天谷价 ────────────────────────────────────────────────────────
// 依据：官方脚注(2)「周一至周五（不含中国法定节假日）…其余时段，包括周末及中国法定节假日全天均为空闲时段」
//      +《国务院办公厅关于 2026 年部分节假日安排的通知》（国办发明电〔2025〕7 号，2025-11-04）。
// 只列**放假**的日期：调休上班日全部落在周末（2026 年 1/4、2/14、2/28、5/9、9/20、10/10），
// 按「周末也算谷价」本来就是谷价，无需单列。
// ⚠️ 每年 11 月国务院发布次年安排后，必须在这里补下一年的日期（桥与面板镜像表都要补）。
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
export const WEEKEND_VALLEY_FROM_MS = Date.UTC(2026, 7, 22, 16, 0, 0);
export const HOLIDAY_VALLEY_FROM_MS = Date.UTC(2026, 8, 18, 16, 0, 0);

/** 计费日偏移（分钟）：480 = UTC 自然日 = 北京时每天 08:00 换日（对齐提供方控制台）。 */
export const DEFAULT_DAY_OFFSET_MIN = 480;

/** 毫秒时间戳 → 北京日历日键 `YYYY-MM-DD` */
export function bjDayKey(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return '';
  return new Date(n + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 毫秒时间戳 → 计费日键（默认北京 08:00 换日） */
export function billingDayKey(ms, offsetMin = DEFAULT_DAY_OFFSET_MIN) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return '';
  const off = Number.isFinite(Number(offsetMin)) ? Number(offsetMin) : DEFAULT_DAY_OFFSET_MIN;
  return bjDayKey(n - off * 60000);
}

/** 官方默认单价（config.json tokenCost 未覆盖时用；与管理端/面板同源） */
export const DEFAULT_TOKEN_COST = {
  pHit: FLASH_PRICE.hit[0],      // ¥ / 百万 tok，缓存命中（空闲时段价）
  pMiss: FLASH_PRICE.miss[0],    // ¥ / 百万 tok，未命中输入 + 缓存写入（空闲时段价）
  pOut: FLASH_PRICE.out[0],      // ¥ / 百万 tok，输出（空闲时段价）
  peakMult: FLASH_PRICE.miss[1] / FLASH_PRICE.miss[0],   // 高峰倍率 = 2
  peakHours: DEFAULT_PEAK_HOURS.slice(),
};

/** 按官方规则判「这一刻是不是高峰」：只看北京时间的星期与时刻，周末/节假日直接判谷。 */
export function isPeakAtMs(ms, peakHours) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return false;
  const set = peakHours instanceof Set ? peakHours
    : new Set(Array.isArray(peakHours) && peakHours.length ? peakHours : DEFAULT_TOKEN_COST.peakHours);
  const bj = new Date(n + 8 * 3600 * 1000);
  if (n >= WEEKEND_VALLEY_FROM_MS) {
    const dow = bj.getUTCDay();            // 按 UTC 读平移后的时间 = 北京日历日的星期
    if (dow === 0 || dow === 6) return false;
  }
  if (n >= HOLIDAY_VALLEY_FROM_MS && HOLIDAY_VALLEY[bj.toISOString().slice(0, 10)]) return false;
  return set.has(bj.getUTCHours());
}

/**
 * 分时/分槽桶用的高峰判定。
 * @param hour 0..23（北京小时）
 * @param opts.dayKey 该桶所属的北京日期（给了它就按官方规则判：周末/节假日→谷时）
 * @param opts.at 代表时刻（毫秒）；与 dayKey 二选一
 */
export function isPeakHour(hour, opts = {}) {
  const h = Number(hour);
  if (!Number.isFinite(h)) return false;
  const set = opts.peakHours instanceof Set ? opts.peakHours
    : new Set(Array.isArray(opts.peakHours) && opts.peakHours.length ? opts.peakHours : DEFAULT_TOKEN_COST.peakHours);
  if (Number.isFinite(Number(opts.at))) return isPeakAtMs(Number(opts.at), set);
  const key = typeof opts.dayKey === 'string' ? opts.dayKey : '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(key)) {
    const dayMs = Date.parse(`${key}T00:00:00+08:00`);
    if (Number.isFinite(dayMs)) return isPeakAtMs(dayMs + h * 3600 * 1000, set);
  }
  return set.has(h);
}

/** 计费日内第 slot 个时段槽（0 = 换日那一刻）对应的绝对时刻（毫秒）。 */
export function slotAtMs(dayKey, slot, offsetMin = DEFAULT_DAY_OFFSET_MIN) {
  const dayMs = Date.parse(`${String(dayKey)}T00:00:00+08:00`);
  if (!Number.isFinite(dayMs)) return NaN;
  const off = Number.isFinite(Number(offsetMin)) ? Number(offsetMin) : DEFAULT_DAY_OFFSET_MIN;
  const startHour = Math.floor((((off % 1440) + 1440) % 1440) / 60);
  const s = Math.max(0, Math.min(23, Math.round(Number(slot) || 0)));
  const total = startHour + s;
  return dayMs + Math.floor(total / 24) * 86400000 + (total % 24) * 3600 * 1000;
}

/**
 * **金额公式**（唯一实现）：cacheWrite 与未命中输入同价，高峰时段整体乘倍率。
 * @param {{cacheRead?:number,missInput?:number,cacheWrite?:number,output?:number}} buckets
 * @param {{pHit:number,pMiss:number,pOut:number,peakMult:number,peakHours:Set<number>|number[]}} price
 * @param {{atMs?:number,hour?:number,dayKey?:string}} [when] 该笔用量发生的时刻/小时（判峰谷用）
 * @returns {number} CNY
 */
export function costOfTokens(buckets, price, when = {}) {
  const b = buckets || {};
  const hit = Number(b.cacheRead) || 0;
  const miss = (Number(b.missInput) || 0) + (Number(b.cacheWrite) || 0);   // 写入按未命中输入价
  const out = Number(b.output) || 0;
  const mult = isPeakHour(when.hour != null ? when.hour : 0, {
    at: when.atMs, dayKey: when.dayKey, peakHours: price?.peakHours,
  }) ? Number(price?.peakMult) || 1 : 1;
  return ((hit * price.pHit + miss * price.pMiss + out * price.pOut) / 1e6) * mult;
}

/** 命中率：cacheRead / (cacheRead + 未命中输入)；无样本返回 null。估算行不计入。 */
export function hitRateOf({ cacheRead, missInput } = {}) {
  const hit = Number(cacheRead) || 0;
  const miss = Number(missInput) || 0;
  return (hit + miss) > 0 ? hit / (hit + miss) : null;
}

/** 金额归一：浮点求和后按「分」取整（跨实现比较时用，避免 1e-15 级噪声）。 */
export function roundCents(v) {
  return Math.round((Number(v) || 0) * 100) / 100;
}
