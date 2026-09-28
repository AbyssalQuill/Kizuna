// 1.3.0 新增能力的回归用例（纯函数为主，不碰生产 state 文件）。
// 覆盖三件事：
//   ① /token 的金额口径 —— 必须与管理端「学习」页实测区逐字一致（算错钱是一眼能看出来的错）；
//   ② 工具 schema 压缩档 —— 档位解析、白名单/黑名单优先级、实测占比；
//   ③ 记忆检索的查询串构造 —— 短词不能喂给 trigram 的 FTS5（会直接返回空，表现为"查不到"）。
// 跑法：cd qq-bridge && node tests/v13-features.test.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const failures = [];
const check = async (name, fn) => {
  try { await fn(); console.log(`PASS  ${name}`); }
  catch (e) { failures.push(name); console.log(`FAIL  ${name}\n      ${e?.message ?? e}`); }
};

const { initTokenMeter, getTokenReport } = await import(new URL('../src/core/token-meter.js', import.meta.url));
const { initTokenReportCore, buildTokenReportText, summarizeMeasuredCost, DEFAULT_TOKEN_COST, fmtTok } =
  await import(new URL('../src/core/token-report.js', import.meta.url));
const { resolveToolTier, toolAllowedByTier, measureSchemaShare, normalizeToolTier, TOOL_TIERS } =
  await import(new URL('../src/lib/tool-tiers.js', import.meta.url));

// ── ① /token 金额口径 ─────────────────────────────────────────────────────────
await check('① 金额口径：命中/未命中/输出分别按单价相加，且只统计带缓存字段的请求', () => {
  const price = { pHit: 0.02, pMiss: 1, pOut: 4, peakMult: 2, peakHours: new Set([9, 10, 11, 14, 15, 16, 17]) };
  const hours = [
    { hour: 3, prompt: 5000, completion: 200, cacheRead: 195000, cacheWrite: 0, cachePrompt: 5000, cacheCompletion: 200, cacheSamples: 1 },
    { hour: 4, prompt: 9999, completion: 999, cacheRead: 0, cacheWrite: 0, cachePrompt: 0, cacheCompletion: 0, cacheSamples: 0 },
  ];
  const s = summarizeMeasuredCost(hours, price);
  // 只有第 1 个小时带缓存字段：0.02×195000/1e6 + 1×5000/1e6 + 4×200/1e6 = 0.0039 + 0.005 + 0.0008
  assert.equal(Number(s.cost.toFixed(6)), 0.0097, `金额 ${s.cost}`);
  assert.equal(s.peakHours, 0);
  assert.equal(s.measuredRate, 195000 / 200000);
});

await check('① 高峰时段按北京小时整体乘倍率，并且谷时/高峰分开记账', () => {
  const price = { pHit: 0.02, pMiss: 1, pOut: 4, peakMult: 2, peakHours: new Set([9, 10, 11, 14, 15, 16, 17]) };
  const mk = (hour) => ({ hour, prompt: 1e6, completion: 0, cacheRead: 0, cacheWrite: 0, cachePrompt: 1e6, cacheCompletion: 0, cacheSamples: 1 });
  const s = summarizeMeasuredCost([mk(3), mk(10)], price);
  assert.equal(Number(s.offCost.toFixed(6)), 1);       // 谷时 1e6 × ¥1/M
  assert.equal(Number(s.peakCost.toFixed(6)), 2);      // 高峰同样量 ×2
  assert.equal(s.peakHours, 1);
  assert.equal(Number(s.cost.toFixed(6)), 3);
});

await check('① 空数据说人话，不吐 NaN/¥0.0000', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v13-tok-'));
  try {
    initTokenMeter({ stateDir: dir });
    initTokenReportCore({ tokenCost: { ...DEFAULT_TOKEN_COST } });
    const r = buildTokenReportText({ days: 1 });
    assert.ok(r.ok);
    assert.match(r.text, /还没有用量记录/);
    assert.ok(!/NaN|undefined/.test(r.text), r.text);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

await check('① 有数据时正文包含总量与钱数，且估算行不并进钱里', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v13-tok-'));
  try {
    /* 时刻钉死（2026-09-26 加）：北京 2026-09-22（周二）20:00 —— 谷时，且 4 行真实数据都落在同一个
     * 小时桶里，于是"钱"可以逐位复算，不受挂钟与"周末/节假日整日谷价"规则影响。 */
    const NOW = Date.parse('2026-09-22T20:00:00+08:00');
    const rows = [];
    for (let i = 0; i < 4; i++) rows.push({ tsMs: NOW - i * 60_000, sessionId: 's', convKey: 'group:1', prompt: 1000, completion: 50, total: 201050, est: false, cacheRead: 200000, cacheWrite: 0 });
    rows.push({ tsMs: NOW - 30_000, sessionId: 's2', convKey: null, prompt: 800, completion: 80, total: 880, est: true, promptChars: 1440, completionChars: 176 });
    fs.writeFileSync(path.join(dir, 'token-usage.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    initTokenMeter({ stateDir: dir, nowMs: NOW });
    initTokenReportCore({ tokenCost: { ...DEFAULT_TOKEN_COST } });
    const rep = getTokenReport(1, { nowMs: NOW });
    const r = buildTokenReportText({ days: 1, nowMs: NOW });
    const billed = Number(rep.today.billedTotal);
    assert.ok(billed > 0, `billedTotal=${billed}`);
    /* 2026-09-28 契约变更（主人给的版式：「报告写成这种类型」，见 src/core/token-report.js:219-243）：
     * 五行、一行一个口径 —— 今日 / 自然日 / 命中率（含未命中·命中·输出）/ 费用（谷·峰）/ 全天预估；
     * 标签后用全角冒号、同行多个数值用「｜」分隔、数值带 tok。第 1 行**不带口径注**（同日主人明确
     * 「我没让你带括号里的废话，计费日换日」，所以这里反过来钉住"没有那句括号"）；估算数仍在
     * data.est / todayEst 里。断言随契约对齐，但钉住的实质没变：总量带千分位、两个日界各自带标签、
     * 钱数在、估算不进钱。 */
    assert.ok(r.text.includes(Number(billed).toLocaleString('en-US')), r.text);
    const dayLines = r.text.split('\n');
    assert.equal(dayLines.length, 5, r.text);
    assert.match(dayLines[0], /^今日 ：[\d,]+ tok$/, dayLines[0]);
    assert.match(dayLines[1], /^自然日：[\d,]+ tok$/, dayLines[1]);
    assert.match(dayLines[2], /^命中率：\d+\.\d%｜未命中 [\d,]+｜命中 [\d,]+｜输出 [\d,]+$/, dayLines[2]);
    assert.match(dayLines[3], /^费用：¥\d+\.\d{4}$/, dayLines[3]);   // 20:00 谷时：不分谷/峰，所以没有括号
    assert.match(dayLines[4], /^全天预估：约 [\d,]+ tok$/, dayLines[4]);
    // 估算行绝不进 billedTotal
    assert.equal(billed, 4 * (1000 + 50 + 200000));
    /* 估算行也绝不进钱：4 行真实数据 = 4×(200000×0.02 + 1000×1 + 50×4)/1e6 = ¥0.0208（20:00 谷时无倍率）。
     * 若那行估算（800+80 tok）混进金额，这里立刻不等 —— 比旧版"正文里有「另有估算」四个字"更硬。 */
    const money = (r.text.match(/费用：¥(\d+\.\d+)/) || [])[1];
    assert.equal(money, '0.0208', r.text);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

await check('① 两个日界口径都必须带标签标注（计费日 vs 北京自然日），数字带千分位', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v13-tok2-'));
  try {
    // 造"跨换日"的数据：今天（计费日，北京 08:00 起）只有一点点，而北京自然日 00:00 起有一大堆
    // —— 线上现场就是 592,685（计费日）vs 12,182,789（自然日），旧版把两者挨着印，看着像算错。
    // 时刻必须钉死（opts.nowMs）：这个断言跟挂钟有关 —— 北京时间 11:00 以后"now−3h"也落在
    //   计费日里，两边数字就会相等，测试会假失败（2026-09-22 实际踩到）。所以固定成北京 11:00。
    const NOW = Date.parse('2026-09-22T11:00:00+08:00');
    const rows = [
      // 北京 10:00 —— 在计费日里（08:00 换日之后）
      { tsMs: NOW - 3600_000, sessionId: 's', convKey: 'private:1', prompt: 2000, completion: 600, total: 592685, est: false, cacheRead: 589824, cacheWrite: 0 },
      // 北京 03:00 —— 同一自然日、但属于上一个计费日（平台算在昨天）
      { tsMs: NOW - 8 * 3600_000, sessionId: 's', convKey: 'private:1', prompt: 300000, completion: 20000, total: 11800000, est: false, cacheRead: 11500000, cacheWrite: 0 },
    ];
    fs.writeFileSync(path.join(dir, 'token-usage.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    /* 2026-09-22：meter 也要吃同一个"钉死的现在"：分时桶按北京自然日归属，若它读真实时钟，
     * 那么真跑过北京 00:00 之后 todayHourly 就落到新的一天、聚合为空，这条断言会假失败。 */
    initTokenMeter({ stateDir: dir, nowMs: NOW });
    initTokenReportCore({ tokenCost: { ...DEFAULT_TOKEN_COST } });
    const r = buildTokenReportText({ days: 1, nowMs: NOW });
    const rep = getTokenReport(1, { nowMs: NOW });
    const natural = (rep.todayHourly || []).reduce((a, h) => a + h.prompt + h.completion + h.cacheRead, 0);
    assert.ok(natural > Number(rep.today.billedTotal), `自然日 ${natural} 应大于计费日 ${rep.today.billedTotal}`);
    assert.ok(r.text.includes(Number(rep.today.billedTotal).toLocaleString('en-US')), `缺计费日数字: ${r.text}`);
    assert.ok(r.text.includes(Number(natural).toLocaleString('en-US')), `缺自然日数字: ${r.text}`);
    /* 2026-09-28 契约变更：五行版把两个日界拆回各自一行（「今日 ：…」一行、「自然日：…」一行，
     * 都不带括号注）。旧断言 /自然日 00:00 起/ 与 /平台算在昨天/ 钉的是更早的排版和解释词。
     * 改口径不等于放水：这里要求两个数字各自带着自己的标签**分行**出现（无标签的裸数字、
     * 或两者又合回一行互相挨着，都算失败），而上面两条已经钉住了"这两个数确实是各自口径的真值"。 */
    assert.match(r.text, /^今日 ：[\d,]+ tok$/m, r.text);
    assert.match(r.text, /^自然日：[\d,]+ tok$/m, r.text);
    assert.ok(!/NaN|undefined/.test(r.text), r.text);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

await check('① 近 N 天报的是"整段窗口"的总量，不是只算今天（旧版这里错取 today.billedTotal）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v13-tok3-'));
  try {
    const DAY = 86400_000;
    const now = Date.now();
    const rows = [];
    for (let d = 0; d < 4; d++) {
      rows.push({ tsMs: now - d * DAY, sessionId: 's', convKey: 'private:1', prompt: 1000, completion: 100, total: 1_000_000, est: false, cacheRead: 998900, cacheWrite: 0 });
    }
    fs.writeFileSync(path.join(dir, 'token-usage.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    initTokenMeter({ stateDir: dir });
    initTokenReportCore({ tokenCost: { ...DEFAULT_TOKEN_COST } });
    const r = buildTokenReportText({ days: 7 });
    assert.match(r.text, /近 7 天/);
    const shown = Number((r.text.match(/近 7 天：([\d,]+) tok/) || [])[1]?.replace(/,/g, '') || 0);
    assert.ok(shown >= 1_000_000, `近 7 天总量应含窗口内每一天，实际=${shown}`);
    assert.ok(shown <= 4_000_000, `不应超过窗口内实际用量，实际=${shown}`);
    assert.ok(!/NaN|undefined/.test(r.text), r.text);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── ② 工具 schema 压缩档 ──────────────────────────────────────────────────────
await check('② 档位解析：非法值一律当 off（错字不能把工具砍没）', () => {
  assert.equal(normalizeToolTier('HIGH'), 'high');
  assert.equal(normalizeToolTier('highh'), 'off');
  assert.equal(normalizeToolTier(undefined), 'off');
  assert.equal(resolveToolTier({}).level, 'off');
});

await check('② 档位未开总开关时不裁剪', () => {
  const r = resolveToolTier({ level: 'high', enabled: false });
  assert.equal(r.level, 'off');
  assert.equal(toolAllowedByTier('qq_send_pixiv', r), true);
});

await check('② high 档：实测被调用过的能力一个都不丢，零调用的庞然大物砍掉', () => {
  const r = resolveToolTier({ enabled: true, level: 'high' });
  assert.equal(r.level, 'high');
  // 协议闭环 + 服务器调用日志里出现过的工具，切 high 后必须还在
  for (const keep of ['qq_send_message', 'qq_reply', 'qq_mark_read', 'qq_get_unread_messages',
    'qq_meme_search', 'qq_send_meme', 'qq_send_voice', 'qq_profile_set', 'qq_memory_search',
    'qq_get_message_images', 'qq_get_recent_messages']) {
    assert.equal(toolAllowedByTier(keep, r), true, `应保留 ${keep}`);
  }
  // 实测 0 次调用、体积最大的那批：high 档砍掉
  for (const drop of ['qq_send_pixiv', 'qq_send_rich', 'qq_character_read', 'qq_music_search']) {
    assert.equal(toolAllowedByTier(drop, r), false, `应砍掉 ${drop}`);
  }
  assert.equal(toolAllowedByTier('qq_status', r), true);
});

await check('② extreme 档：只留八件套，且明确是"会丢功能"的极限档（与 high 不同）', () => {
  const high = resolveToolTier({ enabled: true, level: 'high' });
  const extreme = resolveToolTier({ enabled: true, level: 'extreme' });
  assert.equal(toolAllowedByTier('qq_send_meme', high), true, 'high 不该丢发米姆');
  assert.equal(toolAllowedByTier('qq_send_meme', extreme), false, 'extreme 会丢发米姆（已在 note 里警告）');
  assert.equal(toolAllowedByTier('qq_send_message', extreme), true);
  assert.equal(toolAllowedByTier('qq_status', extreme), true);
});

await check('② low 档走"不要"名单：名单外一律保留（新增工具默认可见）', () => {
  const r = resolveToolTier({ enabled: true, level: 'low' });
  /* 2026-09-22 改口径：low 的 drop 名单按真实调用日志复核过：
   * pixiv / 富卡片 / 点歌 / 定时 / QQ 空间五条 当时判"零调用"，后来确认真实在用 → 全部撤出名单。
   * 所以这条断言改成：在用的不砍、零调用的大块头照砍。 */
  assert.equal(toolAllowedByTier('qq_send_pixiv', r), true, 'pixiv 主人在用（画画），不能再砍');
  assert.equal(toolAllowedByTier('qq_send_rich', r), true, '富卡片主人在用');
  assert.equal(toolAllowedByTier('qq_send_qzone', r), true, '发说说主人在用');
  assert.equal(toolAllowedByTier('qq_character_list', r), false, '角色卡四件是实测零调用的大块头，仍然砍');
  /* 2026-09-26 契约变更（依据 src/lib/tool-tiers.js:139-141 那条注释）：qq_deepsleep 已撤出 low 的
   * drop 名单 —— 线上的 low 档曾把它砍掉，主人让机器人"把群聊解封"时模型只能说"工具不存在"。
   * low 仍是黑名单语义，所以它现在是 true；qq_whitelist 同理（远程解封的两件事都不许砍）。 */
  assert.equal(toolAllowedByTier('qq_deepsleep', r), true, '2026-09-26 起 low 档保留全程静默开关（唯一远程解封手段）');
  assert.equal(toolAllowedByTier('qq_whitelist', r), true, '同理：群白名单不在 low 的 drop 名单里');
  assert.equal(toolAllowedByTier('qq_send_message', r), true);
  assert.equal(toolAllowedByTier('qq_某个将来才会有的工具', r), true, '黑名单语义：不在名单里就该保留');
});

await check('② 老配置（只有 enabled+deny、没有 level）走 custom 黑名单，行为不变', () => {
  const r = resolveToolTier({ enabled: true, deny: ['mcp__napcat__qq_send_pixiv', 'qq_send_rich'] });
  assert.equal(r.level, 'custom');
  assert.equal(toolAllowedByTier('qq_send_pixiv', r), false);
  assert.equal(toolAllowedByTier('mcp__napcat__qq_send_rich', r), false);
  assert.equal(toolAllowedByTier('qq_send_message', r), true);
});

await check('② 选了具体档位时，手写 allow/deny 一律忽略（避免"档位说要留、老 deny 说要砍"的自相矛盾）', () => {
  const r = resolveToolTier({ enabled: true, level: 'high', allow: ['qq_send_voice'], deny: ['qq_send_message'] });
  assert.equal(toolAllowedByTier('qq_send_message', r), true, '档位说留就得留，老 deny 不该生效');
  assert.equal(toolAllowedByTier('qq_send_voice', r), true);
  assert.equal(toolAllowedByTier('qq_send_pixiv', r), false);
  assert.equal(r.allow, null);
  assert.equal(r.deny, null);
  // 手写名单只在 custom 档生效
  const c = resolveToolTier({ enabled: true, level: 'custom', allow: ['qq_send_voice'], deny: [] });
  assert.equal(toolAllowedByTier('qq_send_voice', c), true);
  assert.equal(toolAllowedByTier('qq_send_message', c), false);
});

await check('② 实测占比：按字符加权算（不是按工具个数），档位严格递减', () => {
  const tools = [
    { name: 'qq_send_message', cost: 2744 }, { name: 'qq_send_pixiv', cost: 6277 },
    { name: 'qq_reply', cost: 1387 }, { name: 'qq_send_rich', cost: 4866 },
    { name: 'qq_mark_read', cost: 643 }, { name: 'qq_get_prompt', cost: 407 },
    { name: 'qq_social_state', cost: 420 }, { name: 'qq_get_unread_messages', cost: 451 },
    { name: 'qq_list_groups', cost: 208 }, { name: 'qq_status', cost: 198 },
  ];
  const total = tools.reduce((s, t) => s + t.cost, 0);
  const m = measureSchemaShare(tools, new Set(TOOL_TIERS.extreme.keep));
  assert.equal(m.totalChars, total);
  // extreme 名单里这 8 个都在：2744+1387+643+407+420+451+208+198
  assert.equal(m.keptChars, 6458);
  assert.equal(m.keptCount, 8);
  assert.ok(m.share < 1);
  // 不带名单 = 全量（off 档）
  const all = measureSchemaShare(tools, null);
  assert.equal(all.keptChars, total);
  assert.equal(all.share, 1);
  // low 用 drop 名单：这一档只砍"实测零调用"的大块头 —— 上面这份样本里 pixiv/富卡片都在用，
  // 所以一个都不该被砍（省 0 字符）；把角色卡加进样本，才应该被砍掉并计入节省。
  const lowSame = measureSchemaShare(tools, null, new Set(TOOL_TIERS.low.drop));
  assert.equal(lowSame.totalChars - lowSame.keptChars, 0, '样本里的工具都在用，low 档不该砍任何一个');
  const withChars = [...tools, { name: 'qq_character_list', cost: 1329 }];
  const low2 = measureSchemaShare(withChars, null, new Set(TOOL_TIERS.low.drop));
  assert.equal(low2.totalChars - low2.keptChars, 1329, '角色卡是实测零调用的大块头，应该被砍');
  assert.equal(low2.droppedCount, 1);
  assert.equal(low2.dropped[0].name, 'qq_character_list');
});

// ── ③ 记忆检索的查询串 ────────────────────────────────────────────────────────
await check('③ FTS5 查询串：够长的词才进索引，2 字中文词交给 LIKE（trigram 最少要 3 个字）', async () => {
  const { ftsQueryOf } = await import(new URL('../src/core/memory.js', import.meta.url));
  assert.equal(ftsQueryOf(''), '');
  assert.equal(ftsQueryOf('ab'), '');                       // 只有 2 字 → 交给 LIKE
  assert.equal(ftsQueryOf('考试'), '');                     // 中文两字词：trigram 索引里没有 2 字词条
  assert.equal(ftsQueryOf('期末考试'), '"期末考试"');         // 4 字 → 正常进 FTS
  // 长短混写：短词被丢掉，长词照样进索引（比整条退回 LIKE 强）
  assert.equal(ftsQueryOf('考试 关于期末考试的事'), '"关于期末考试的事"');
  assert.equal(ftsQueryOf('hello world'), '"hello" OR "world"');
  assert.equal(ftsQueryOf('a"b"c 期末考试'), '"期末考试"');    // 引号一律剥掉，免得拼出非法 FTS 语法
  assert.ok(ftsQueryOf(Array.from({ length: 20 }, (_, i) => `word${i}xx`).join(' ')).split(' OR ').length <= 8);
});

// ── ④ 分层记忆的层级归一（纯函数，不落库）─────────────────────────────────────
await check('④ 记忆层级：rule/owner/identity 天然是永久层；显式 tier 说了算', async () => {
  const { PERMANENT_CATEGORIES, MEMORY_TIERS } = await import(new URL('../src/core/memory.js', import.meta.url));
  assert.equal(MEMORY_TIERS.permanent, 0);
  assert.ok(PERMANENT_CATEGORIES.has('rule') && PERMANENT_CATEGORIES.has('owner'));
  assert.ok(MEMORY_TIERS.working > 0 && MEMORY_TIERS.durable > MEMORY_TIERS.working);
});

console.log('');
if (failures.length) {
  console.log(`${failures.length} 项失败：\n- ${failures.join('\n- ')}`);
  process.exit(1);
}
console.log('1.3.0 新增能力：全部通过 ✓');
void ROOT;
