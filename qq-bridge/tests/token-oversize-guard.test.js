// 单条记录硬上限闸门（token-meter 的 MAX_ROW_TOKENS）测试：不可能值**永不进账本**。
//
// 2026-09-29 事故：账本 state/token-usage.jsonl 里同一会话在 02:16 写了 3 条一模一样的对账补记行，
// 单条 cacheRead 高达 5,434,432 / 7,144,512（一次请求不可能命中这么多），合计虚增
// 命中 96,822,208 + 未命中 3,226,461 —— QQ 的 `/token` 与面板钱数从此对不上。
// 本文件锁死三件事：① 超限单条 → 拒绝入账 + 落日志（带 sessionId/时间/数值）；
//                  ② 正常小值 → 照常入账（防误伤）；③ 边界值（等于上限）放行、"上限+1"拒绝。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'token-oversize-'));
const stateDir = path.join(tmp, 'state');
fs.mkdirSync(stateDir, { recursive: true });

const meter = await import('../src/core/token-meter.js');
meter.initTokenMeter({ stateDir, nowMs: Date.now() });

const ledger = path.join(stateDir, 'token-usage.jsonl');
const rejectLog = path.join(stateDir, 'token-meter-reject.log');
const readLines = () => (fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8').split('\n').filter((l) => l.trim()) : []);
const usageFrame = (sid, usage) => ({ type: 'session/event', sessionId: sid, event: { type: 'step/end', data: { usage } } });

// ── ①②③ 真实 usage 帧：超限拒绝 / 正常放行 / 边界 ────────────────────────────────
const SID_OK = 'session-ok-0001';
const r0 = meter.meterTokenFrame(usageFrame(SID_OK, { inputTokens: 1200, outputTokens: 340, cacheReadTokens: 5600, cacheWriteTokens: 0 }));
assert.equal(r0.recorded, true, '正常小值必须照常入账（防误伤）');
assert.equal(r0.kind, 'usage');
assert.equal(readLines().length, 1, '正常值应写进账本');

const SID_BIG = 'session-big-0002';
const BIG = 5434432; // 事故现场的单条命中值
const r1 = meter.meterTokenFrame(usageFrame(SID_BIG, { inputTokens: 980000, outputTokens: 1200, cacheReadTokens: BIG }));
assert.equal(r1.recorded, false, '超限单条不得入账');
assert.equal(r1.reason, 'oversize', '拒绝原因必须是 oversize（而不是笼统的 io-error）');
assert.equal(r1.rejected.field, 'cacheRead');
assert.equal(r1.rejected.value, BIG);
assert.equal(r1.rejected.limit, 1000000);
assert.equal(readLines().length, 1, '超限记录不得写进账本');
assert.ok(!fs.readFileSync(ledger, 'utf8').includes(String(BIG)), '账本里不得出现超限值');

// 日志必须带 sessionId / 时间 / 数值（便于追查）
assert.ok(fs.existsSync(rejectLog), '必须落 token-meter-reject.log');
const logText = fs.readFileSync(rejectLog, 'utf8');
for (const needle of [SID_BIG, String(BIG), 'cacheRead', '1000000']) {
  assert.ok(logText.includes(needle), `拒绝日志里应含 ${needle}`);
}
const logRec = JSON.parse(logText.trim().split('\n').pop());
assert.equal(logRec.sessionId, SID_BIG);
assert.equal(logRec.kind, 'usage');
assert.ok(Number.isFinite(Date.parse(logRec.at)), '日志必须带可解析的时间戳');
assert.ok(Number.isFinite(logRec.tsMs), '日志必须带记录自身的时间戳');
assert.ok(logRec.rec.includes(String(BIG)), '日志应留整条记录便于追查');

// 边界：等于上限放行，上限 +1 拒绝（判定是严格大于）
const SID_EDGE = 'session-edge-0003';
const rEdge = meter.meterTokenFrame(usageFrame(SID_EDGE, { inputTokens: 0, outputTokens: 1, cacheReadTokens: 1000000 }));
assert.equal(rEdge.recorded, true, '等于上限应放行');
const rEdge2 = meter.meterTokenFrame(usageFrame(SID_EDGE, { inputTokens: 0, outputTokens: 2, cacheReadTokens: 1000001 }));
assert.equal(rEdge2.recorded, false, '上限 +1 应拒绝');
assert.equal(rEdge2.rejected.value, 1000001);

// 其它字段同样受管：completion / prompt / total 超限一律拒绝
const rOut = meter.meterTokenFrame(usageFrame('session-out-0004', { inputTokens: 10, outputTokens: 250000, cacheReadTokens: 0 }));
assert.equal(rOut.recorded, false);
assert.equal(rOut.rejected.field, 'completion');
const rTotal = meter.meterTokenFrame(usageFrame('session-tot-0005', { totalTokens: 9999999 }));
assert.equal(rTotal.recorded, false);
assert.equal(rTotal.rejected.field, 'total');

// ── ④ 估算行（est:true）也过同一道闸门 ───────────────────────────────────────────
const rEst = meter.meterActivityEstimate({ sessionId: 'session-est-0006', promptChars: 3000000, completionChars: 0 });
assert.equal(rEst.recorded, false, '估算行超限同样拒绝（单回合 300 万字符本身就是异常）');
assert.equal(rEst.reason, 'oversize');
assert.ok(fs.readFileSync(rejectLog, 'utf8').includes('session-est-0006'), '估算行的拒绝也要留 sessionId');

// ── ⑤ 拒绝不得影响报表：账本里只有 2 条合法行，且文件仍是合法 JSONL ────────────────
const rows = readLines();
assert.equal(rows.length, 2, '账本应只有两条合法行（正常小值 + 边界放行）');
for (const l of rows) assert.doesNotThrow(() => JSON.parse(l), '账本必须仍是合法 JSONL');
const rep = meter.getTokenReport(7);
// 正常小值 1200+340+5600 = 7140；边界行 0+1+1000000 = 1000001
assert.equal(rep.today.billedTotal, 7140 + 1000001, '报表只应统计入账的行');
assert.equal(rep.today.samples, 2);

// ── ⑥ 状态接口暴露闸门状态（面板/管理端可一眼看出被拦了多少条）────────────────────
const guard = meter.tokenReconcileStatus().rowGuard;
assert.equal(guard.limits.cacheRead, 1000000);
assert.equal(guard.rejected, 5, '本文件共触发 5 次拒绝（4 帧 + 1 估算）');
assert.equal(guard.last.sessionId, 'session-est-0006');
assert.equal(guard.log, rejectLog);

console.log('token-oversize-guard: 全部通过 ✓');
fs.rmSync(tmp, { recursive: true, force: true });
