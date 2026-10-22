// 跨实现一致性测试：桥侧 `/token`（core/token-report.js + core/token-pricing.js）
// 与 小鲸鱼面板 dsh-whale-widget（lib/pricing.mjs）必须对同一份用量算出**逐分相同**的钱。
//
// 为什么必须有这个测试：两边是两份独立安装（桥在 qq-bridge/，面板是 DSH 的 npm 插件），
// 无法跨包 import，只能"逐字镜像 + 测试锁死"。用户要的是"真实花了多少钱"这一个数，
// 而历史上两处口径各写一遍：/token 漏 cacheWrite、多日路径不含高峰倍率，面板也漏 cacheWrite、
// 峰谷判定用结算时刻的挂钟 —— 于是同一个问题有两个答案。价目/峰谷窗口/节假日表/公式，
// 任何一边改了而另一边没跟上，这里立刻失败（而不是等用户拿两个数字对账时才发现）。
//
// 覆盖的边界：
//   ① 谷时（03:00）与高峰（10:00 / 15:30）分别计价；
//   ② 跨 08:00 计费日界（07:59 属于上一个计费日、却属于同一个北京自然日）；
//   ③ 带 cacheWrite 的行（写入按未命中输入价，两边都必须计）；
//   ④ 周末 + 法定节假日（2026-09-26 周六，同时是中秋假期 → 即使 10:00 也是谷价）；
//   ⑤ 空数据（没有任何 usage 行）不吐 NaN、金额为 0。
//   ⑦ 机器人口径（2026-10-01 加）：面板主数字（机器人自己的花费）与 /token 今日金额**逐分相同**，
//      两个日界的 token 与命中率也逐项相同 —— 面板主数字换成机器人后，两边不能各说各话。
//   ⑧ 口径边界（2026-10-01 加）：把「本机 DSH 桌面端 + 子代理」的用量造出来（含 DSH home 根下的
//      同名 token-usage.jsonl 与面板自己的 .dshw-usage.json），断言机器人数字**一字不变** ——
//      证明"只统计机器人"是结构上的事实（只读桥侧计量文件），不是靠约定；同时钉住估算行只进 token
//      总量、永不进钱。
//
// 跑法：cd qq-bridge && node tests/token-pricing-parity.test.js
// 面板插件不在本机（例如在生产机上跑）时会**显式 SKIP 并打印原因**，桥侧自检仍照跑。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const failures = [];
const check = (name, fn) => {
  try { fn(); console.log(`PASS  ${name}`); }
  catch (e) { failures.push(name); console.log(`FAIL  ${name}\n      ${e?.message ?? e}`); }
};

const { initTokenMeter, getTokenReport } = await import('../src/core/token-meter.js');
const { initTokenReportCore, buildTokenReportText, summarizeMeasuredCost } = await import('../src/core/token-report.js');
const bridge = await import('../src/core/token-pricing.js');

// ── 定位面板插件（本机真实路径优先；找不到就 SKIP，不假装通过）────────────────
const widgetCandidates = [
  process.env.DSH_WHALE_WIDGET_DIR,
  process.env.DSH_HOME ? path.join(process.env.DSH_HOME, 'profiles', 'web', 'node_modules', 'dsh-whale-widget') : null,
  path.join(os.homedir(), '.dsh', 'profiles', 'web', 'node_modules', 'dsh-whale-widget'),
  'D:/Kizuna/resources/runtime/node_modules/dsh-whale-widget',
].filter(Boolean);
let widget = null;
let widgetDir = '';
for (const dir of widgetCandidates) {
  const file = path.join(dir, 'lib', 'pricing.mjs');
  if (!fs.existsSync(file)) continue;
  widget = await import(new URL(`file://${file.replace(/\\/g, '/')}`).href);
  widgetDir = dir;
  break;
}
if (!widget) {
  console.log('SKIP  未找到 dsh-whale-widget（试过：' + widgetCandidates.join(' | ') + '）——跨实现断言未执行');
}

// ── 构造同一份用量：覆盖谷/峰、跨 08:00 日界、cacheWrite、周末+节假日、估算行 ──
const NOW = Date.parse('2026-09-22T20:00:00+08:00');   // 周二 20:00（谷时）
const ms = (s) => Date.parse(s);
const ROWS = [
  // ① 谷时（北京 03:00，属上一个计费日 09-21，但属自然日 09-22）
  { tsMs: ms('2026-09-22T03:00:00+08:00'), cacheRead: 2_000_000, prompt: 200_000, cacheWrite: 100_000, completion: 50_000 },
  // ② 高峰（北京 10:00）
  { tsMs: ms('2026-09-22T10:00:00+08:00'), cacheRead: 1_500_000, prompt: 300_000, cacheWrite: 0, completion: 80_000 },
  // ③ 高峰（北京 15:30）
  { tsMs: ms('2026-09-22T15:30:00+08:00'), cacheRead: 800_000, prompt: 120_000, cacheWrite: 60_000, completion: 20_000 },
  // ④ 07:59 —— 计费日界另一侧（计费日 09-21），仍是同一个北京自然日
  { tsMs: ms('2026-09-22T07:59:00+08:00'), cacheRead: 500_000, prompt: 50_000, cacheWrite: 10_000, completion: 5_000 },
  // ⑤ 上一个自然日 09-21 20:00（进多日窗口，不进今日自然日）
  { tsMs: ms('2026-09-21T20:00:00+08:00'), cacheRead: 400_000, prompt: 40_000, cacheWrite: 0, completion: 4_000 },
  // ⑥ 周六 + 中秋假期（2026-09-26）的 10:00 —— 官方规则：节假日全天谷价
  { tsMs: ms('2026-09-26T10:00:00+08:00'), cacheRead: 300_000, prompt: 30_000, cacheWrite: 0, completion: 3_000 },
];
const EST_ROW = { tsMs: NOW - 30_000, prompt: 800, completion: 80, total: 880, est: true, cacheRead: 0, cacheWrite: 0 };
const BILLING_OFFSET = bridge.DEFAULT_DAY_OFFSET_MIN;   // 480 分钟 = 北京 08:00 换日

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'token-parity-'));
const stateDir = path.join(tmp, 'state');
fs.mkdirSync(stateDir, { recursive: true });
const jsonl = ROWS.map((r, i) => JSON.stringify({
  tsMs: r.tsMs, sessionId: `s${i}`, convKey: `group:${i}`,
  prompt: r.prompt, completion: r.completion,
  total: r.prompt + r.completion + r.cacheRead + r.cacheWrite,
  cacheRead: r.cacheRead, cacheWrite: r.cacheWrite, est: false,
})).concat([JSON.stringify(EST_ROW)]).join('\n') + '\n';
fs.writeFileSync(path.join(stateDir, 'token-usage.jsonl'), jsonl, 'utf8');

const price = { ...bridge.DEFAULT_TOKEN_COST, peakHours: new Set(bridge.DEFAULT_TOKEN_COST.peakHours) };
initTokenMeter({ stateDir, nowMs: NOW });
initTokenReportCore({ tokenCost: { ...bridge.DEFAULT_TOKEN_COST } });

// 面板侧口径：逐条 usage 按**它自己的时刻**判峰谷、按北京自然日 / 计费日分组（与面板同源函数）
const widgetSum = (rows, mode) => {
  const dayOf = (ts) => (mode === 'billing' ? bridge.billingDayKey(ts, BILLING_OFFSET) : bridge.bjDayKey(ts));
  return { dayOf, total: rows.reduce((a, r) => a + widget.costOfUsage(
    { cacheRead: r.cacheRead, missInput: r.prompt, cacheWrite: r.cacheWrite, output: r.completion },
    { atMs: r.tsMs, price: widget.PRICE_TABLE['deepseek-flash'] },
  ), 0) };
};
const inWindow = (day, days) => {
  const today = bridge.billingDayKey(NOW, BILLING_OFFSET);
  const list = [];
  for (let i = 0; i < days; i += 1) {
    const d = new Date(Date.parse(`${today}T00:00:00Z`) - i * 86400000).toISOString().slice(0, 10);
    list.push(d);
  }
  return list.includes(day);
};

// ── ① 价目表 / 峰谷窗口 / 节假日表：两份实现必须逐字相同 ─────────────────────
check('价目、峰谷窗口、节假日表：桥侧与面板侧逐字一致', () => {
  if (!widget) { console.log('      （面板不可用，跳过比较）'); return; }
  assert.deepEqual(Object.keys(widget.HOLIDAY_VALLEY).sort(), Object.keys(bridge.HOLIDAY_VALLEY).sort(), '节假日表不一致');
  assert.deepEqual(widget.PEAK_WINDOWS, bridge.PEAK_WINDOWS, '高峰窗口不一致');
  for (const key of Object.keys(bridge.PRICE_TABLE)) {
    assert.deepEqual(widget.PRICE_TABLE[key], bridge.PRICE_TABLE[key], `价目表 ${key} 不一致`);
  }
  assert.deepEqual(widget.PRICE_TABLE['deepseek-flash'], { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] },
    '官方 Flash 价目（缓存命中 0.02/0.04、未命中 1/2、输出 4/8）');
  assert.equal(bridge.DEFAULT_TOKEN_COST.peakMult, 2, '高峰倍率 = 空闲 ×2');
});

// ── ② 峰谷判定逐点一致（含周末与节假日）─────────────────────────────────────
check('峰谷判定：同一时刻两边结论相同（含周末、中秋假期、08:00 前后）', () => {
  if (!widget) { console.log('      （面板不可用，跳过比较）'); return; }
  const stamps = [
    ms('2026-09-22T08:59:00+08:00'), ms('2026-09-22T09:00:00+08:00'), ms('2026-09-22T11:59:00+08:00'),
    ms('2026-09-22T12:00:00+08:00'), ms('2026-09-22T14:00:00+08:00'), ms('2026-09-22T17:59:00+08:00'),
    ms('2026-09-22T18:00:00+08:00'), ms('2026-09-22T03:00:00+08:00'),
    ms('2026-09-26T10:00:00+08:00'),   // 周六 + 中秋假期 → 谷
    ms('2026-09-27T15:00:00+08:00'),   // 中秋假期内的周日 → 谷
    ms('2026-09-28T10:00:00+08:00'),   // 假期后的周一 → 高峰
    ms('2026-10-01T10:00:00+08:00'),   // 国庆 → 谷
  ];
  for (const t of stamps) {
    assert.equal(bridge.isPeakAtMs(t, price.peakHours), widget.isPeakMs(t),
      `峰谷判定不一致 @ ${new Date(t).toISOString()}`);
  }
});

// ── ③ 今日（北京自然日）金额：桥侧 /token 的「费用」== 面板逐条复算 ───────────
check('今日自然日金额：/token 的「费用」与面板复算逐分相同（含 cacheWrite 与高峰倍率）', () => {
  const rep = getTokenReport(1, { nowMs: NOW });
  const sum = summarizeMeasuredCost(rep.todayHourly, price, { dayKey: bridge.bjDayKey(NOW) });
  const text = buildTokenReportText({ days: 1, nowMs: NOW });
  const textCost = Number((text.text.match(/费用：¥(\d+\.\d{4})/) || [])[1]);
  assert.equal(bridge.roundCents(textCost), bridge.roundCents(sum.fullCost), `/token 正文金额与 fullCost 不一致：${text.text}`);
  if (widget) {
    const today = bridge.bjDayKey(NOW);
    const rows = ROWS.filter((r) => bridge.bjDayKey(r.tsMs) === today);
    const w = widgetSum(rows, 'natural');
    assert.equal(bridge.roundCents(sum.fullCost), bridge.roundCents(w.total),
      `桥侧 ¥${sum.fullCost.toFixed(4)} vs 面板 ¥${w.total.toFixed(4)}`);
  }
  // cacheWrite 必须计入：漏掉它就会少算 写入量×未命中价
  const missOnly = summarizeMeasuredCost(rep.todayHourly, price, { dayKey: bridge.bjDayKey(NOW) }).fullCost;
  const withoutWrite = ROWS.filter((r) => bridge.bjDayKey(r.tsMs) === bridge.bjDayKey(NOW))
    .reduce((a, r) => a + bridge.costOfTokens(
      { cacheRead: r.cacheRead, missInput: r.prompt, output: r.completion }, price, { atMs: r.tsMs }), 0);
  assert.ok(missOnly > withoutWrite, `含 cacheWrite 的金额应更大：${missOnly} vs ${withoutWrite}`);
  // 命中率公式两边同源
  const rate = bridge.hitRateOf({ cacheRead: 4_800_000, missInput: 670_000 });
  if (widget) assert.equal(rate, widget.hitRateOf({ cacheRead: 4_800_000, missInput: 670_000 }), '命中率公式不一致');
});

// ── ④ 多日窗口金额：桥侧 /token N 也按峰谷倍率，且与面板同源 ────────────────
check('多日金额（/token 3）：逐日按峰谷倍率，且与面板逐条复算逐分相同', () => {
  const text = buildTokenReportText({ days: 3, nowMs: NOW });
  const textCost = Number((text.text.match(/费用：约 ¥(\d+\.\d{4})/) || [])[1]);
  assert.ok(Number.isFinite(textCost), `未取到多日金额：${text.text}`);
  assert.ok(!/未含高峰倍率/.test(text.text), '多日路径不应再声明"未含高峰倍率"');
  const rep = getTokenReport(3, { nowMs: NOW });
  let bridgeTotal = 0;
  for (const d of rep.dates) {
    for (const s of (d.slots || [])) {
      bridgeTotal += bridge.costOfTokens(
        { cacheRead: s.cacheRead, missInput: s.missInput, cacheWrite: s.cacheWrite, output: s.completion },
        price, { atMs: bridge.slotAtMs(d.date, s.slot) });
    }
  }
  assert.equal(bridge.roundCents(textCost), bridge.roundCents(bridgeTotal), `/token 3 正文金额与逐槽复算不一致：${text.text}`);
  // 多日路径必须真的吃到高峰倍率：把这批行全部按谷价算一遍，应当更便宜
  const windowRows = ROWS.filter((r) => inWindow(bridge.billingDayKey(r.tsMs, BILLING_OFFSET), 3));
  const valleyOnly = windowRows.reduce((a, r) => a + bridge.costOfTokens(
    { cacheRead: r.cacheRead, missInput: r.prompt, cacheWrite: r.cacheWrite, output: r.completion },
    price, { atMs: bridge.slotAtMs('2026-09-22', 0) }), 0);   // 08:00 = 谷
  assert.ok(bridgeTotal > valleyOnly, `多日金额应含高峰倍率：${bridgeTotal} vs 谷价 ${valleyOnly}`);
  if (widget) {
    const w = widgetSum(windowRows, 'billing');
    assert.equal(bridge.roundCents(bridgeTotal), bridge.roundCents(w.total),
      `桥侧多日 ¥${bridgeTotal.toFixed(4)} vs 面板 ¥${w.total.toFixed(4)}`);
  }
});

// ── ⑤ 两个日界各自正确（计费日 08:00 / 自然日 00:00）且都含 cacheWrite ───────
check('两个日界各自正确：计费日(08:00) 含 cacheWrite，自然日(00:00) 也含 cacheWrite', () => {
  const rep = getTokenReport(1, { nowMs: NOW });
  const sum = summarizeMeasuredCost(rep.todayHourly, price, { dayKey: bridge.bjDayKey(NOW) });
  const naturalDay = bridge.bjDayKey(NOW);
  const naturalRows = ROWS.filter((r) => bridge.bjDayKey(r.tsMs) === naturalDay);
  const expectNatural = naturalRows.reduce((a, r) => a + r.prompt + r.completion + r.cacheRead + r.cacheWrite, 0);
  assert.equal(sum.dayTotal, expectNatural, '自然日总量 = 未命中+输出+命中+缓存写入');
  assert.equal(sum.dayCacheWrite, naturalRows.reduce((a, r) => a + r.cacheWrite, 0), '自然日必须计入 cacheWrite');
  const billedRows = ROWS.filter((r) => bridge.billingDayKey(r.tsMs, BILLING_OFFSET) === bridge.billingDayKey(NOW, BILLING_OFFSET));
  const expectBilled = billedRows.reduce((a, r) => a + r.prompt + r.completion + r.cacheRead + r.cacheWrite, 0);
  assert.equal(Number(rep.today.billedTotal), expectBilled, '计费日总量 = 四项相加（07:59 那行属于上一个计费日）');
  assert.ok(sum.dayTotal > Number(rep.today.billedTotal), '自然日应含 00:00–08:00 段，故大于计费日');
});

// ── ⑥ 空数据：不吐 NaN、金额为 0 ────────────────────────────────────────────
check('空数据：两句"还没有用量记录"，金额 0，无 NaN', () => {
  const emptyDir = path.join(tmp, 'empty');
  fs.mkdirSync(emptyDir, { recursive: true });
  initTokenMeter({ stateDir: emptyDir, nowMs: NOW });
  const text = buildTokenReportText({ days: 1, nowMs: NOW });
  assert.ok(text.ok);
  assert.match(text.text, /还没有用量记录/);
  assert.ok(!/NaN|undefined/.test(text.text), text.text);
  assert.equal(Number(text.data.cost) || 0, 0);
  const rep = getTokenReport(3, { nowMs: NOW });
  const sum = summarizeMeasuredCost(rep.todayHourly, price, { dayKey: bridge.bjDayKey(NOW) });
  assert.equal(sum.fullCost, 0);
  assert.equal(sum.dayTotal, 0);
  initTokenMeter({ stateDir, nowMs: NOW });   // 复位，便于后续手工复跑
});

// ── ⑦ 机器人口径：面板主数字 == /token 今日金额（逐分相同）────────────────────
/* 用户 2026-10-01 要求「计费要改，只统计机器人消耗的」：
 *   · 主数字 = 机器人（QQ 桥）自己的用量与花费，来源是桥侧计量文件 state/token-usage.jsonl；
 *   · 账户级/含本机 DSH 桌面端与子代理的数字不再是主数字，必须单独标注、放次要位置。
 * 这一节把「面板主数字 == /token 今日金额」钉成逐分相同（含 token 两项与命中率），
 * 下一节把「本机 DSH 的用量不会进入机器人数字」钉成结构性事实（不是靠约定）。 */
let robotMod = null;
if (widgetDir) {
  const rf = path.join(widgetDir, 'lib', 'robot-usage.mjs');
  if (fs.existsSync(rf)) robotMod = await import(new URL(`file://${rf.replace(/\\/g, '/')}`).href);
}
if (!robotMod) console.log('SKIP  未找到 dsh-whale-widget/lib/robot-usage.mjs —— 机器人口径断言未执行');

check('⑦ 面板机器人口径：金额 / 两个日界 token / 命中率与 /token 逐项相同', () => {
  if (!robotMod) { console.log('      （robot-usage.mjs 不可用，跳过比较）'); return; }
  const rep = getTokenReport(1, { nowMs: NOW });
  const sum = summarizeMeasuredCost(rep.todayHourly, price, { dayKey: bridge.bjDayKey(NOW) });
  const text = buildTokenReportText({ days: 1, nowMs: NOW });
  const textCost = Number((text.text.match(/费用：¥(\d+\.\d{4})/) || [])[1]);
  const robot = robotMod.summarizeRobotUsage({
    stateDir, nowMs: NOW, price: widget.PRICE_TABLE['deepseek-flash'], dayOffsetMin: BILLING_OFFSET,
  });
  assert.equal(robot.scope, 'robot', '机器人摘要必须自带 scope=robot（前端据此标注，绝不与账户级混排）');
  assert.match(robot.scopeNote, /机器人/, robot.scopeNote);
  assert.equal(robot.stateDir, stateDir, '机器人摘要只读桥侧计量目录');
  assert.equal(bridge.roundCents(robot.todayCost), bridge.roundCents(sum.fullCost),
    `面板机器人金额 ¥${robot.todayCost.toFixed(4)} vs /token ¥${sum.fullCost.toFixed(4)}`);
  assert.equal(bridge.roundCents(robot.todayCost), bridge.roundCents(textCost), '/token 正文金额与面板机器人金额必须逐分相同');
  assert.equal(robot.todayBillingTokens, Number(rep.today.billedTotal), '「今日」（计费日 08:00）token 应与 /token 第 1 行相同');
  assert.equal(robot.todayNaturalTokens, sum.dayTotal, '「自然日」token 应与 /token 第 2 行相同');
  assert.equal(robot.todayHitRate, sum.measuredRate, '命中率应与 /token 第 3 行同源');
  assert.equal(robot.todayMissInput, sum.mMiss);
  assert.equal(robot.todayHit, sum.mHit);
  assert.equal(robot.todayOutput, sum.mOut);
  assert.ok(robot.todayCost > 0, '构造数据下机器人金额应大于 0');
});

// ── ⑧ 口径边界：本机 DSH 用量不进机器人数字；估算行不进钱 ────────────────────
check('⑧ 本机 DSH 用量不会进入机器人数字（构造桌面端用量，机器人数字不变）', () => {
  if (!robotMod) { console.log('      （robot-usage.mjs 不可用，跳过比较）'); return; }
  const before = robotMod.summarizeRobotUsage({
    stateDir, nowMs: NOW, price: widget.PRICE_TABLE['deepseek-flash'], dayOffsetMin: BILLING_OFFSET,
  });
  // 造一份"本机 DSH 桌面端/子代理"的用量：既有面板自己的事件账本，也有同名的会话目录树。
  const desktopHome = path.join(tmp, 'desktop-dsh-home');
  fs.mkdirSync(path.join(desktopHome, 'storages', 'session_projcache', 'sessions'), { recursive: true });
  const desktopRows = [
    { tsMs: NOW - 1800_000, sessionId: 'desktop-1', prompt: 9_000_000, completion: 3_000_000, total: 12_000_000, cacheRead: 8_000_000, cacheWrite: 0, est: false },
    { tsMs: NOW - 900_000, sessionId: 'desktop-2', prompt: 5_000_000, completion: 2_000_000, total: 7_000_000, cacheRead: 4_000_000, cacheWrite: 0, est: false },
  ];
  // 故意在 DSH home 根下也放一个同名计量文件：机器人读取器绝不能把它当数据源。
  fs.writeFileSync(path.join(desktopHome, 'token-usage.jsonl'),
    desktopRows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(desktopHome, '.dshw-usage.json'), JSON.stringify({
    events: desktopRows.map((r) => ({ ts: r.tsMs, day: bridge.bjDayKey(r.tsMs), model: 'deepseek-flash', cost: 3, tokens: r.total })),
  }), 'utf8');

  const after = robotMod.summarizeRobotUsage({
    stateDir, nowMs: NOW, price: widget.PRICE_TABLE['deepseek-flash'], dayOffsetMin: BILLING_OFFSET,
  });
  assert.deepEqual(after, before, '本机 DSH 的用量出现后，机器人数字必须一字不变');

  // 桌面端那份用量本身是个非零的、与机器人不同的数 —— 证明这是两个口径，不是同一个数换了个名字
  const desktopCost = desktopRows.reduce((a, r) => a + widget.costOfUsage(
    { cacheRead: r.cacheRead, missInput: r.prompt, cacheWrite: r.cacheWrite, output: r.completion },
    { atMs: r.tsMs, price: widget.PRICE_TABLE['deepseek-flash'] },
  ), 0);
  assert.ok(desktopCost > 0, '构造的桌面端用量应算出非零金额');
  assert.notEqual(bridge.roundCents(desktopCost), bridge.roundCents(before.todayCost), '桌面端金额与机器人金额不应相等（否则这条断言没意义）');

  // 目录解析：DSH home 根下的同名文件绝不能被选中；有桥侧目录时选桥侧
  const fakeHome = path.join(tmp, 'fake-home');
  const fakeDsh = path.join(fakeHome, '.dsh');
  const fakeBridge = path.join(fakeHome, 'qq-bridge', 'state');
  fs.mkdirSync(fakeDsh, { recursive: true });
  fs.mkdirSync(fakeBridge, { recursive: true });
  fs.writeFileSync(path.join(fakeDsh, 'token-usage.jsonl'), '{"tsMs":1,"prompt":1,"completion":1,"total":2}\n', 'utf8');
  fs.writeFileSync(path.join(fakeBridge, 'token-usage.jsonl'), '{"tsMs":1,"prompt":1,"completion":1,"total":2}\n', 'utf8');
  const picked = robotMod.resolveRobotStateDir({ env: { DSH_HOME: fakeDsh }, homedir: fakeHome, extra: [] });
  assert.equal(picked.dir, fakeBridge, `应选 DSH home 的兄弟目录 qq-bridge/state，实选 ${picked.dir}`);

  /* 估算行：只进 token 总量（est 字段），永不进钱、也不进两个日界的计费 token。
   * 塞一条巨大的估算行（10 亿 token）——如果它漏进钱里，金额会立刻涨到几万元以上。 */
  const bigEst = { tsMs: NOW - 30_000, prompt: 1_000_000_000, completion: 0, total: 1_000_000_000, est: true, cacheRead: 0, cacheWrite: 0 };
  const withEst = robotMod.summarizeRobotUsage({
    stateDir, nowMs: NOW, price: widget.PRICE_TABLE['deepseek-flash'], dayOffsetMin: BILLING_OFFSET,
    records: [...ROWS, EST_ROW, bigEst].map((r) => robotMod.normalizeRobotRecord(r)).filter(Boolean),
  });
  assert.equal(bridge.roundCents(withEst.todayCost), bridge.roundCents(before.todayCost), '估算行不得进钱');
  assert.equal(withEst.todayBillingTokens, before.todayBillingTokens, '估算行不得进计费日 token');
  assert.equal(withEst.todayNaturalTokens, before.todayNaturalTokens, '估算行不得进自然日计费 token');
  assert.ok(withEst.todayEst >= 1_000_000_880, `估算行应单独记进 est 字段，实际 ${withEst.todayEst}`);
});


// ── ⑨ 主数字载荷：标签齐备；配错目录时报「不可用」而不是显示别的桥 ────────────
check('⑨ 机器人主数字载荷：口径标签齐备，配错目录不回退到别的 qq-bridge', () => {
  if (!robotMod || typeof robotMod.buildRobotPayload !== 'function') { console.log('      （robot-usage.mjs 不可用，跳过）'); return; }
  const p = robotMod.buildRobotPayload({
    nowMs: NOW, explicit: stateDir, env: { DSH_HOME: path.join(tmp, 'desktop-dsh-home') },
  });
  assert.equal(p.available, true);
  assert.equal(p.scope, 'robot');
  assert.equal(p.label, robotMod.ROBOT_LABEL);
  assert.match(p.scopeNote, /不含本机 DSH 桌面端与子代理/, p.scopeNote);
  assert.equal(p.currency, 'CNY');
  assert.equal(bridge.roundCents(p.amount), bridge.roundCents(p.todayCost));
  assert.ok(/机器人/.test(robotMod.LOCAL_SCOPE_LABEL) && /非机器人/.test(robotMod.ACCOUNT_SCOPE_LABEL));
  // 显式配错：必须报不可用（否则用户配错目录时会看到另一个桥的数字却浑然不知）
  const bad = robotMod.buildRobotPayload({ nowMs: NOW, explicit: path.join(tmp, 'no-such-bridge') });
  assert.equal(bad.available, false, '显式目录不存在时应报不可用');
  assert.equal(bad.amount, 0);
  assert.ok(bad.readError, '应带 readError 供前端显示');
  // 未显式配置时按 mtime 挑最新的那份（本机常有多份 qq-bridge 副本）
  const home2 = path.join(tmp, 'multi-home');
  const b1 = path.join(home2, 'qq-bridge', 'state');
  const b2 = path.join(home2, 'Desktop', 'Kizuna Public', 'qq-bridge', 'state');
  fs.mkdirSync(b1, { recursive: true });
  fs.mkdirSync(b2, { recursive: true });
  fs.writeFileSync(path.join(b1, 'token-usage.jsonl'), '{"tsMs":1,"prompt":1,"completion":1,"total":2}\n', 'utf8');
  fs.writeFileSync(path.join(b2, 'token-usage.jsonl'), '{"tsMs":1,"prompt":1,"completion":1,"total":2}\n', 'utf8');
  const old = new Date(Date.now() - 86400000);
  fs.utimesSync(path.join(b1, 'token-usage.jsonl'), old, old);
  const picked = robotMod.resolveRobotStateDir({ env: {}, homedir: home2, extra: [] });
  assert.equal(picked.dir, b2, `应挑最新的那份 qq-bridge，实选 ${picked.dir}`);
});

// ── ⑩ 零点的边界：计费日还没用量时，/token 不能谎报「今天没记录」 ─────────────
/* 北京 00:00–08:00 这一段按平台口径算在**前一天**的计费日里，`today.billedTotal` 天然是 0。
 * 旧判据只看 billedTotal，于是这段时间 /token 会回「今日还没有用量记录」，而北京自然日其实
 * 已经在烧钱（本机实测就是：自然日 1.01 亿 tok / ¥7.19 时，/token 说没记录）。面板主数字正是
 * 那个自然日复算额 —— 两边必须能对上，所以这里把这条边界钉死。 */
check('⑩ 计费日为空但自然日有量时，/token 仍报出费用，且与面板机器人金额相同', () => {
  if (!robotMod) { console.log('      （robot-usage.mjs 不可用，跳过比较）'); return; }
  const earlyDir = path.join(tmp, 'early-hours');
  fs.mkdirSync(earlyDir, { recursive: true });
  // 只有北京 03:00 的一行（属自然日 09-22、属计费日 09-21）
  fs.writeFileSync(path.join(earlyDir, 'token-usage.jsonl'), JSON.stringify({
    tsMs: ms('2026-09-22T03:00:00+08:00'), sessionId: 's', convKey: 'private:1',
    prompt: 200_000, completion: 50_000, total: 250_000, cacheRead: 2_000_000, cacheWrite: 0, est: false,
  }) + '\n', 'utf8');
  try {
    initTokenMeter({ stateDir: earlyDir, nowMs: NOW });
    const rep = getTokenReport(1, { nowMs: NOW });
    assert.equal(Number(rep.today.billedTotal) || 0, 0, '这一段的计费日应为空（边界前提）');
    const text = buildTokenReportText({ days: 1, nowMs: NOW });
    assert.ok(!/还没有用量记录/.test(text.text), `计费日为空但自然日有量时不得报"没有用量记录"：${text.text}`);
    const money = Number((text.text.match(/费用：¥(\d+\.\d{4})/) || [])[1]);
    assert.ok(Number.isFinite(money) && money > 0, `应报出非零费用：${text.text}`);
    const robot = robotMod.summarizeRobotUsage({
      stateDir: earlyDir, nowMs: NOW, price: widget.PRICE_TABLE['deepseek-flash'], dayOffsetMin: BILLING_OFFSET,
    });
    assert.equal(bridge.roundCents(robot.todayCost), bridge.roundCents(money), '面板机器人金额应与 /token 费用逐分相同');
    assert.equal(robot.todayBillingTokens, 0);
    assert.ok(robot.todayNaturalTokens > 0);
  } finally {
    initTokenMeter({ stateDir, nowMs: NOW });   // 复位到主用例的 stateDir
  }
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n面板插件：${widget ? widgetDir : '未找到（跨实现断言已跳过）'}`);
if (failures.length) {
  console.log(`\n${failures.length} 项失败：\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('token-pricing-parity: 全部通过 ✓');
