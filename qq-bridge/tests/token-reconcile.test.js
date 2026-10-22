// 用量对账（token-meter.reconcileWithDsh）测试：桥侧漏记 usage 帧时，用 DSH 会话级权威计数补差额。
// 关键性质：① 只补"桥侧少掉的那部分"；② 幂等（水位落盘，重复跑不重复补）；
//          ③ 没有桥侧基准（很久以前的会话）不补，只抬水位；④ 会话早就停了不补（差额会落错日期）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'token-reconcile-'));
const stateDir = path.join(tmp, 'state');
const cacheDir = path.join(tmp, 'projcache');
fs.mkdirSync(stateDir, { recursive: true });
fs.mkdirSync(cacheDir, { recursive: true });

const meter = await import('../src/core/token-meter.js');

const SID_A = 'session-aaaa-1111';
const SID_B = 'session-bbbb-2222';
const nowMs = Date.now();

function row(sid, prompt, completion, cacheRead, tsMs) {
  return JSON.stringify({ tsMs, sessionId: sid, convKey: null, prompt, completion, total: prompt + completion + cacheRead, cacheRead, cacheWrite: 0, est: false }) + '\n';
}
// 桥侧已记：A 会话 100,000（漏掉了一步）；B 会话一笔没有
fs.writeFileSync(path.join(stateDir, 'token-usage.jsonl'), row(SID_A, 20000, 8000, 72000, nowMs - 60000));

function cacheFile(sid, uncached, output, cacheRead, mtimeMs) {
  const p = path.join(cacheDir, sid + '.json');
  fs.writeFileSync(p, JSON.stringify({ version: 1, record: { sessionId: sid, rows: { tokenUsage: { val: { totals: { uncachedInputTokens: uncached, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: 0 } } } } } }));
  const t = mtimeMs / 1000;
  fs.utimesSync(p, t, t);
}
// A：DSH 侧 172,101（比桥侧多 72,101）；B：老会话，DSH 侧 5,000,000，桥侧一条都没有
cacheFile(SID_A, 30000, 9000, 133101, nowMs - 30000);
cacheFile(SID_B, 1000000, 200000, 3800000, nowMs - 3 * 86400000);

meter.initTokenMeter({ stateDir });
meter.setTokenReconcileHome(tmp); // cacheDir 直接由 opts.dir 指定，这里只保证已初始化

const r1 = meter.reconcileWithDsh({ dir: cacheDir, nowMs });
assert.equal(r1.ok, true, '对账应当成功');
assert.equal(r1.added, 1, '只应补 A 会话一条');
assert.equal(r1.addedTokens, 72101, '差额应为 30000+9000+133101 - 100000');
assert.equal(r1.skippedNoBaseline, 1, 'B 会话没有桥侧基准 → 跳过');

const billed1 = meter.getTokenReport(7, { nowMs }).today.billedTotal;
assert.equal(billed1, 172101, '对账后今日合计应等于 DSH 侧权威值');

// 幂等：再跑一次不应再补
const r2 = meter.reconcileWithDsh({ dir: cacheDir, nowMs });
assert.equal(r2.addedTokens, 0, '第二次对账不应重复补');
assert.equal(meter.getTokenReport(7, { nowMs }).today.billedTotal, 172101, '合计不应变化');

// A 会话继续跑：桥侧只多记了 1,500（prompt 1000 / output 500），DSH 侧涨到 253,500 → 应补 79,899
fs.appendFileSync(path.join(stateDir, 'token-usage.jsonl'), row(SID_A, 1000, 500, 0, nowMs + 1000));
meter.initTokenMeter({ stateDir });   // 重读文件（模拟桥重启）
cacheFile(SID_A, 41000, 12500, 200000, nowMs + 2000);
const r3 = meter.reconcileWithDsh({ dir: cacheDir, nowMs: nowMs + 3000 });
assert.equal(r3.addedTokens, 79899, '应补 253500 - 173601（逐桶差额）');
assert.equal(meter.getTokenReport(7, { nowMs: nowMs + 3000 }).today.billedTotal, 253500, '合计应等于 DSH 侧最新值');

// 会话早已停止（projcache 3 天没动）→ 不补，避免差额落到错误日期
cacheFile(SID_A, 40000, 12000, 300000, nowMs - 3 * 86400000);
fs.appendFileSync(path.join(stateDir, 'token-usage.jsonl'), row(SID_A, 100, 100, 100, nowMs + 4000));
meter.initTokenMeter({ stateDir });
const r4 = meter.reconcileWithDsh({ dir: cacheDir, nowMs: nowMs + 5000 });
assert.equal(r4.addedTokens, 0, '停用会话不应补差额');
assert.equal(r4.skippedStale, 1, '应记为 skippedStale');

// ── ⑤⑥⑦⑧ 幂等硬回归（2026-09-30 修「对账补记重复补账」）──────────────────────────
// 事故形态：桥侧自己的补记行被 MAX_LINES 裁剪 / 7 天窗口重建 / 文件被外部截断之后，
// 旧实现的水位停在**补账之前**（成功补账那条路不抬水位），于是 base = max(mine, floor)
// 退回旧水位、同一个缺口被重新打开、被再补一次 —— 线上于是出现同一会话 3 条一模一样的补记行、
// 单条 cacheRead 5,434,432 / 7,144,512 这种不可能值。下面四段把它们逐个钉死。
const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'token-reconcile-idem-'));
const state2 = path.join(tmp2, 'state');
const cache2 = path.join(tmp2, 'projcache');
fs.mkdirSync(state2, { recursive: true });
fs.mkdirSync(cache2, { recursive: true });
const SID_C = 'session-cccc-3333';
const ledger2 = path.join(state2, 'token-usage.jsonl');
const baseRow = row(SID_C, 20, 10, 0, nowMs - 60000); // 桥侧只记了 30（正常小值）
const lines2 = () => fs.readFileSync(ledger2, 'utf8').split('\n').filter((l) => l.trim());
function cacheFileIn(dir, sid, uncached, output, cacheRead, mtimeMs) {
  const p = path.join(dir, sid + '.json');
  fs.writeFileSync(p, JSON.stringify({ version: 1, record: { sessionId: sid, rows: { tokenUsage: { val: { totals: { uncachedInputTokens: uncached, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: 0 } } } } } }));
  const t = mtimeMs / 1000;
  fs.utimesSync(p, t, t);
}
fs.writeFileSync(ledger2, baseRow);
cacheFileIn(cache2, SID_C, 1000, 300, 500000, nowMs - 30000); // DSH 权威 501,300 → 缺口 501,270

meter.initTokenMeter({ stateDir: state2 });
const q1 = meter.reconcileWithDsh({ dir: cache2, nowMs });
assert.equal(q1.added, 1, '第一轮应补 1 条');
assert.equal(q1.addedTokens, 501270, '差额应为 501300 - 30');
// ⑤ 同一缺口连续判定两次（文件未动）→ 只补一次
const q2 = meter.reconcileWithDsh({ dir: cache2, nowMs: nowMs + 1000 });
assert.equal(q2.added, 0, '第二次对账不得再补');
assert.equal(q2.addedTokens, 0, '第二次对账不得再补 token');
assert.equal(lines2().length, 2, '账本仍只有原始行 + 1 条补记');
// 水位必须随补账前移（幂等的机制本身），并留下缺口指纹
const floorFile = JSON.parse(fs.readFileSync(path.join(state2, 'token-reconcile.json'), 'utf8'));
assert.equal(floorFile.version, 2, '水位文件应升到 version 2（带缺口指纹）');
assert.equal(floorFile.sessions[SID_C].cacheRead, 500000, '补账后水位必须抬到 DSH 当前值');
assert.equal(floorFile.sessions[SID_C].ackSig, '1000|300|500000|0', '应记下被认账的四桶指纹');
assert.equal(floorFile.sessions[SID_C].ackedRuns, 1, '认账次数应为 1');

// ⑥ 关键回归：把桥侧那条补记行删掉（= MAX_LINES 裁剪 / 外部截断），再对账一次。
//    旧实现会把这个缺口**再补一次**；修好后必须 0 补账。
fs.writeFileSync(ledger2, baseRow); // mine 掉回 30
meter.initTokenMeter({ stateDir: state2 }); // 模拟桥重启后重读文件
const q3 = meter.reconcileWithDsh({ dir: cache2, nowMs: nowMs + 2000 });
assert.equal(q3.addedTokens, 0, '同一缺口不得被再补一次（水位已随补账前移）');
assert.equal(q3.added, 0, '不得新增补记行');
assert.equal(lines2().length, 1, '账本不应新增任何行');
assert.equal(meter.getTokenReport(7, { nowMs: nowMs + 2000 }).today.billedTotal, 30, '合计只剩桥侧真实记的 30');

// ⑦ 水位前移不能挡住真实增量：DSH 侧继续涨 → 差额照常补
cacheFileIn(cache2, SID_C, 1500, 500, 600000, nowMs + 3000);
const q4 = meter.reconcileWithDsh({ dir: cache2, nowMs: nowMs + 4000 });
assert.equal(q4.addedTokens, 100700, '新缺口 602000 - 501300 应照常补上');

// ⑧ 凭据闸门本身可用：人为构造"有指纹但四桶为 0"的水位 —— 正是「水位不再前移」那种回归会留下的状态，
//    此时必须靠 ackSig 独立挡住重复补账（不依赖水位数值）。水位是**进程启动时从文件读一次**的，
//    所以这里用一个独立的模块实例（带 query 的 import = 独立模块缓存）来走"从水位文件加载"的真实路径。
const meter2 = await import(new URL('../src/core/token-meter.js?case=ack', import.meta.url));
const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'token-reconcile-ack-'));
const state3 = path.join(tmp3, 'state');
const cache3 = path.join(tmp3, 'projcache');
fs.mkdirSync(state3, { recursive: true });
fs.mkdirSync(cache3, { recursive: true });
const SID_D = 'session-dddd-4444';
fs.writeFileSync(path.join(state3, 'token-usage.jsonl'), row(SID_D, 20, 10, 0, nowMs - 60000));
cacheFileIn(cache3, SID_D, 1000, 300, 500000, nowMs - 30000);
fs.writeFileSync(path.join(state3, 'token-reconcile.json'), JSON.stringify({
  version: 2, updatedAt: new Date(nowMs).toISOString(),
  sessions: { [SID_D]: { prompt: 0, completion: 0, cacheRead: 0, cacheWrite: 0, at: nowMs - 1000, ackSig: '1000|300|500000|0', ackAt: nowMs - 1000 } }
}));
meter2.initTokenMeter({ stateDir: state3 });
const q5 = meter2.reconcileWithDsh({ dir: cache3, nowMs });
assert.equal(q5.addedTokens, 0, '指纹相同的缺口不得再补（即使水位四桶被人为清零）');
assert.equal(q5.skippedAcked, 1, '应记为 skippedAcked（凭据闸门命中）');
assert.equal(fs.readFileSync(path.join(state3, 'token-usage.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).length, 1, '账本不应新增补记行');

// ⑨ 缺口本身就是不可能值（单条超限）→ 拒绝入账 + 留日志 + 水位照样前移（不再反复撞同一个不可能值）
const tmp4 = fs.mkdtempSync(path.join(os.tmpdir(), 'token-reconcile-over-'));
const state4 = path.join(tmp4, 'state');
const cache4 = path.join(tmp4, 'projcache');
fs.mkdirSync(state4, { recursive: true });
fs.mkdirSync(cache4, { recursive: true });
const SID_E = 'session-eeee-5555';
const ledger4 = path.join(state4, 'token-usage.jsonl');
fs.writeFileSync(ledger4, row(SID_E, 100, 50, 0, nowMs - 60000));
cacheFileIn(cache4, SID_E, 200000, 100000, 7144512, nowMs - 30000); // 事故现场那个不可能值
meter.initTokenMeter({ stateDir: state4 });
const q6 = meter.reconcileWithDsh({ dir: cache4, nowMs });
assert.equal(q6.addedTokens, 0, '不可能值不得入账');
assert.equal(q6.skippedOversize, 1, '应记为 skippedOversize');
assert.ok(!fs.readFileSync(ledger4, 'utf8').includes('7144512'), '账本里不得出现超限值');
const rejLog = fs.readFileSync(path.join(state4, 'token-meter-reject.log'), 'utf8');
assert.ok(rejLog.includes(SID_E) && rejLog.includes('7144512') && rejLog.includes('cacheRead'), '拒绝日志要带 sessionId/数值/字段');
const q7 = meter.reconcileWithDsh({ dir: cache4, nowMs: nowMs + 1000 });
assert.equal(q7.skippedOversize, 0, '水位已前移 → 不再反复撞同一个不可能值');

console.log('token-reconcile: 全部通过 ✓');
fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(tmp2, { recursive: true, force: true });
fs.rmSync(tmp3, { recursive: true, force: true });
fs.rmSync(tmp4, { recursive: true, force: true });

