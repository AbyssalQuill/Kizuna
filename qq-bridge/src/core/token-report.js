// src/core/token-report.js — `/token` 指令：把「今日用量 + 今日花费」说成人话（2026-09-21）
//
// 需求：输入 /token 就自动发出今天的 token 消耗总量与钱数消耗。
//
// ── 为什么单独一个模块（而不是塞进 mux.js）────────────────────────────────────
//   · mux.js 已经 1300+ 行，指令分支里塞金额计算会越写越乱；
//   · 口径必须与管理端面板（小鲸鱼挂件 dsh-whale-widget 的记账）**同一把尺子** ——
//     价目、峰谷窗口、节假日表、cacheWrite 归属、金额公式全部来自 core/token-pricing.js
//     （2026-09-30 起为桥侧唯一权威源；面板侧是独立安装包，用 lib/pricing.mjs 逐字镜像同一份常量，
//      两边由 tests/token-pricing-parity.test.js 用同一份用量数据锁死金额逐分相同）。
//   · 单价可在 config.json 的 `tokenCost` 段覆盖（管理端 Core 设置可改）；
//     口径不变、只换单价 —— 用户调价后 /token 与面板同时变。
//
// 依赖：core/token-meter.js 的 getTokenReport()（计费日口径，默认北京时 08:00 换日）。
import { getTokenReport } from './token-meter.js';
import {
  DEFAULT_TOKEN_COST, HOLIDAY_VALLEY, bjDayKey, billingDayKey,
  isPeakAtMs, isPeakHour, costOfTokens, hitRateOf, slotAtMs,
} from './token-pricing.js';

// 这些名字历史上从本文件导出（桥内其它模块/工具按老路径引用），现在改成权威源再导出，
// 引用方不用改，且不会再出现「此处是副本、价目在别处」的分叉。
export { DEFAULT_TOKEN_COST, HOLIDAY_VALLEY, bjDayKey, billingDayKey, isPeakAtMs, isPeakHour };

/** 计费口径说明：给 /token 正文末尾那一行用（用户问"这数怎么算出来的"时有据可依）。 */
let cfgRef = null;
export function initTokenReportCore(cfg) {
  cfgRef = cfg || null;
}

/* ── 口径标签（2026-10-01 加）───────────────────────────────────────────────────
 * 用户原话「计费要改，只统计机器人消耗的」。/token 本来就已经只算桥 —— 计量文件是
 * `<qq-bridge>/state/token-usage.jsonl`，只收桥自己 DSH 的用量帧；用量对账用的 DSH home 由
 * resolveDshTarget() 挑出**隔离** home，显式拒绝桌面端 home（src/lib/dsh-side.js 的
 * refusedDesktop）—— 但这件事以前只写在注释里，用户从回复上看不出来。所以这里把口径
 * 印在正文上，并随 data.scope 一起下发，避免被误读成"账户总花费"。 */
export const TOKEN_REPORT_SCOPE = 'robot';
/* 2026-09-30 补「面板 = 本机 + 服务端」这半句：上一版只说了"只统计机器人"，用户拿面板 ¥9.7903 与
 * /token ¥2.5954 对比时仍然对不上账 —— 面板是把**本机 DSH 桌面端**与**服务端桥**两边的花费加在一起，
 * 而 /token 只报这台桥自己那一份。数字都没错，缺的是这句话。 */
export const TOKEN_REPORT_SCOPE_LINE = '口径：只统计这台桥（服务端）自己那份，不含本机 DSH 桌面端与子代理；管理端面板数字 = 本机 + 服务端合计，与本行不等属正常';

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
 * 纯函数：小时桶数组 → 汇总（金额公式与面板逐字一致，见 core/token-pricing.js）。
 *
 * 两个金额口径同时给出（2026-09-30）：
 *   · `fullCost` —— **全量复算口径**：窗口内每一条真实用量都算钱，缓存写入按未命中输入价
 *     一并计入。这是「按用量复算的真实花费」，与小鲸鱼面板逐轮结算出来的数字同源；
 *     /token 正文里的「费用」用的就是它。
 *   · `cost` —— 旧的「实测子集」口径：只统计确实带缓存字段（cacheSamples>0）的桶，
 *     且不含 cacheWrite。保留它是为了不动用户已经看到的命中率/谷峰拆分语义，
 *     以及避免旧断言无声失效；新代码一律用 fullCost。
 *     两条口径的差额来源就是「不带缓存字段的那些请求」（缓存命中为 0 的首次请求等）。
 *
 * @param {Array<{hour:number,prompt:number,completion:number,cacheRead:number,cacheWrite:number,cachePrompt:number,cacheCompletion:number,cacheSamples:number}>} hours
 * @param {{pHit:number,pMiss:number,pOut:number,peakMult:number,peakHours:Set<number>}} price
 * @param {{dayKey?:string}} [opts] dayKey=这些分时桶所属的北京日期（不传则退回「只看小时」旧口径）
 */
export function summarizeMeasuredCost(hours, price, opts = {}) {
  let mHit = 0; let mMiss = 0; let mOut = 0; let mSamples = 0;
  let cost = 0; let offCost = 0; let peakCost = 0; let peakHours = 0;
  let fullCost = 0; let fullOffCost = 0; let fullPeakCost = 0; let fullPeakHours = 0;
  let dayMiss = 0; let dayOut = 0; let dayCacheRead = 0; let dayCacheWrite = 0; let dayTotal = 0;
  const when = (h) => ({ hour: h?.hour, dayKey: opts?.dayKey });
  for (const h of Array.isArray(hours) ? hours : []) {
    const prompt = Number(h?.prompt) || 0;
    const completion = Number(h?.completion) || 0;
    const cacheRead = Number(h?.cacheRead) || 0;
    const cacheWrite = Number(h?.cacheWrite) || 0;
    dayMiss += prompt;
    dayOut += completion;
    dayCacheRead += cacheRead;
    dayCacheWrite += cacheWrite;
    // 自然日口径的总量 = 提供方 total_tokens 口径的四项相加（旧版漏了 cacheWrite，
    // 于是「自然日」永远比「今日(计费日)」小一截 —— 两个数都已经各自正确）
    dayTotal += prompt + completion + cacheRead + cacheWrite;
    const mult = isPeakHour(h?.hour, { dayKey: opts?.dayKey, peakHours: price.peakHours }) ? price.peakMult : 1;
    // ① 全量复算：写入与未命中输入同价（官方没有单独的 cache 写入档）
    // 空小时（分时序列里 0..现在 会补零）不参与「谷/峰各几小时」的计数，也不进金额。
    const hasUsage = (prompt + completion + cacheRead + cacheWrite) > 0;
    const full = hasUsage
      ? costOfTokens({ cacheRead, missInput: prompt, cacheWrite, output: completion }, price, when(h))
      : 0;
    if (hasUsage) {
      fullCost += full;
      if (mult > 1) { fullPeakCost += full; fullPeakHours += 1; } else { fullOffCost += full; }
    }
    // ② 实测子集（老口径，保持原样）
    const samples = Number(h?.cacheSamples) || 0;
    if (samples > 0) {
      const hit = cacheRead;
      const miss = Number(h?.cachePrompt) || 0;
      const out = Number(h?.cacheCompletion) || 0;
      mHit += hit; mMiss += miss; mOut += out; mSamples += samples;
      const c = costOfTokens({ cacheRead: hit, missInput: miss, output: out }, price, when(h));
      cost += c;
      if (mult > 1) { peakCost += c; peakHours += 1; } else { offCost += c; }
    }
  }
  const measuredRate = (mHit + mMiss) > 0 ? mHit / (mHit + mMiss) : null;
  return {
    mHit, mMiss, mOut, mSamples, cost, offCost, peakCost, peakHours,
    fullCost, fullOffCost, fullPeakCost, fullPeakHours,
    dayMiss, dayOut, dayCacheRead, dayCacheWrite, dayTotal,
    measuredRate,
    /** 全量口径的命中率（面板同源公式：cacheRead / (cacheRead + 未命中输入)） */
    hitRate: hitRateOf({ cacheRead: dayCacheRead, missInput: dayMiss }),
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
 * 2026-09-30 再修（「两个口径各自算对、都算上 cacheWrite、复算要跟面板逐分相同」）：
 *   · 「自然日」总量补上 cacheWrite（旧版漏掉，于是两个日界线永远对不上账）；
 *   · 「费用」改用全量复算口径（sum.fullCost）：每一条真实用量都算钱，缓存写入按未命中输入价
 *     计入，峰谷按小时判定 —— 与小鲸鱼面板的逐轮结算同源（面板此前也漏了 cacheWrite）；
 *   · 多日路径（`/token N`）不再笼统按谷时价：逐日按分槽桶判峰谷、乘上高峰倍率。
 *
 * 版式（2026-09-28 主人给的样式：一行一个口径、标签后用全角冒号、同行多个数值用「｜」分隔、数值带单位）：
 *   第 1 行 今日 ：… tok（计费日）       = 提供方控制台口径（北京 08:00 换日，含缓存写入）
 *   第 2 行 自然日：… tok                = 北京自然日 00:00 起合计（含缓存写入）
 *   第 3 行 命中率：…｜未命中｜命中｜输出  = 实测子集（只算带缓存字段的请求）
 *   第 4 行 费用：¥…（谷 ¥…｜峰 ¥…）      = 全量复算口径（与小鲸鱼面板同源）
 *   第 5 行 全天预估：约 … tok
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
  // 北京自然日 00:00 起：分时桶合计（面板「今日 token 合计」就是它，含缓存写入）
  const naturalTotal = sum.dayTotal;
  const naturalSame = naturalTotal > 0 && Math.abs(naturalTotal - todayBilled) < Math.max(1, todayBilled * 0.005);
  const windowDates = Array.isArray(rep?.dates) ? rep.dates : [];
  const windowTotal = windowDates.reduce((a, d) => a + (Number(d?.total) || 0), 0);
  const rate = sum.measuredRate;
  const money = Number(sum.fullCost) || 0;   // 全量复算口径（= 面板同源）

  if (days === 1) {
    /* 2026-10-01 修「/token 说今天没记录、面板却摆着一个金额」：
     * 旧判据只看**计费日**（todayBilled）与估算，于是北京 00:00–08:00 这一段必然误报 ——
     * 那段时间的用量按平台口径算在**前一天**的计费日里，`today.billedTotal` 天然是 0，
     * 可北京自然日明明已经在烧 token（实测：自然日 1.01 亿 tok / ¥7.19 时 /token 回「还没有用量记录」）。
     * 面板主数字现在是同一个自然日复算额，两边必须能对上，所以判据补上 naturalTotal：
     * 只有「计费日 0 且自然日 0 且估算 0」才是真的没收到任何 usage 帧。 */
    if (todayBilled <= 0 && todayEst <= 0 && naturalTotal <= 0) {
      return {
        ok: true,
        text: `今日还没有用量记录（一条 usage 帧都还没收到）\n${TOKEN_REPORT_SCOPE_LINE}`,
        data: { days, billed: todayBilled, naturalTotal, est: todayEst, cost: 0, scope: TOKEN_REPORT_SCOPE },
      };
    }
    /* 2026-09-28 主人给的版式（原话：「报告写成这种类型」）——五行、一行一个口径：
     *     今日 ：39,580,622 tok
     *     自然日：61,146,491 tok
     *     命中率：97.7%｜未命中 1,417,135｜命中 59,674,368｜输出 54,988
     *     费用：¥3.0567（谷 ¥2.6045｜峰 ¥0.4522）
     *     全天预估：约 61,198,852 tok
     * 第 1 行**不带任何口径注**（同日主人明确：「我没让你带括号里的废话，计费日换日」）——两个日界
     * 现在只靠行首的「今日」/「自然日」两个标签区分；为什么会差一截（计费日 = 北京 08:00 换日，
     * 自然日 = 北京 00:00 起）只在管理端「桥接 → 用量与统计」的帮助文字与「学习」页正文里解释，
     * 不再出现在 QQ 回复里。
     * 全天预估 = 自然日已用 + 到 24:00 的预计剩余（restOfDayEstimate）；不能拿计费日预计减基数，
     * 那会把次日 0-8 点算两遍。 */
    const fullDay = Math.round(naturalTotal + (Number(rep?.restOfDayEstimate) || 0));
    const proj = Number(rep?.todayEstimatedTotal) || 0;
    const lines = [];
    // 标签列对齐：「今日」两字，后面补一个空格，与「自然日 / 命中率」这类三字标签齐平
    lines.push(`今日 ：${fmtNum(todayBilled)} tok`);
    lines.push(`自然日：${fmtNum(naturalTotal)} tok`);
    lines.push(`命中率：${rate != null ? `${(rate * 100).toFixed(1)}%` : '—（本时段没有带缓存字段的请求）'}`
      + `｜未命中 ${fmtNum(sum.mMiss)}｜命中 ${fmtNum(sum.mHit)}｜输出 ${fmtNum(sum.mOut)}`);
    lines.push(`费用：¥${money.toFixed(4)}`
      + (sum.fullPeakHours > 0 ? `（谷 ¥${Number(sum.fullOffCost).toFixed(4)}｜峰 ¥${Number(sum.fullPeakCost).toFixed(4)}）` : ''));
    lines.push(`全天预估：约 ${fmtNum(fullDay)} tok`);
    // 第 6 行：口径标签（机器人专属）。不是给"这个数怎么算的"用的括号注，而是一行独立的口径声明。
    lines.push(TOKEN_REPORT_SCOPE_LINE);
    return {
      ok: true,
      text: lines.join('\n'),
      data: {
        days, billed: todayBilled, naturalTotal, naturalSame, est: todayEst, cost: money,
        rate, peakCost: sum.fullPeakCost, offCost: sum.fullOffCost, projected: proj,
        scope: TOKEN_REPORT_SCOPE, scopeLabel: '机器人（QQ 桥）',
        // 老字段（实测子集口径）一并留着，避免旧调用方读到 undefined
        measuredCost: sum.cost, cacheWrite: sum.dayCacheWrite,
      },
    };
  }

  // 近 N 天：总量按 `dates`（计费日逐日）求和 —— 旧版这里错取了"只算今天"的 billedTotal
  // 金额逐日按分槽桶判峰谷（同一份 token-pricing 规则），不再笼统「未含高峰倍率」。
  // 分槽桶缺失（老数据/空日）时退回谷时价，并在文案里说清。
  const lines = [];
  lines.push(`近 ${days} 天：${fmtNum(windowTotal)} tok（计费日逐日合计，含今日）`);
  const offPeakPrice = { ...price, peakMult: 1 };
  let c = 0; let fellBack = false;
  for (const d of windowDates) {
    const slots = Array.isArray(d?.slots) ? d.slots : null;
    if (slots && slots.length) {
      for (const s of slots) {
        c += costOfTokens({
          cacheRead: Number(s?.cacheRead) || 0,
          missInput: Number(s?.missInput) || 0,
          cacheWrite: Number(s?.cacheWrite) || 0,
          output: Number(s?.completion) || 0,
        }, price, { atMs: slotAtMs(d?.date, s?.slot) });
      }
    } else {
      fellBack = true;
      c += costOfTokens({
        cacheRead: Number(d?.cacheRead) || 0,
        missInput: Number(d?.prompt) || 0,
        cacheWrite: Number(d?.cacheWrite) || 0,
        output: Number(d?.completion) || 0,
      }, offPeakPrice, { atMs: 0 });
    }
  }
  lines.push(`费用：约 ¥${c.toFixed(4)}（逐日按峰谷倍率${fellBack ? '；无分槽数据的天按谷时价' : ''}）`);
  if (todayBilled > 0) lines.push(`其中今日：${fmtNum(todayBilled)} tok｜¥${money.toFixed(4)}（自然日分时复算）`);
  lines.push(TOKEN_REPORT_SCOPE_LINE);
  return {
    ok: true,
    text: lines.join('\n'),
    data: { days, windowTotal, cost: c, billed: todayBilled, naturalTotal, todayCost: money, rate, scope: TOKEN_REPORT_SCOPE },
  };
}
