/* ── 按会话静默（2026-09-29 修「/silent 误静默所有会话甚至是私聊」）──────────────────
 * 需求原话：「`/silent` 指令有误，应该是单个会话静默而不是所有会话甚至是私聊，修复」。
 *
 * 本测试要钉住的**唯一风险点**：一条 /silent 只能影响发出它的那个会话，
 * 绝不能有任何"一处为真 → 全机器人静默"的后门（旧实现正是如此：只写
 * state/current-role.json 的全局 mode:"silent"，两个闸门都不看会话 key）。
 *
 * 判据（真起 console-server + 真 spawn MCP server + 假 OneBot，全程真实 HTTP）：
 *   ① 群 A 里发 /silent → A 被静默：A 的群友消息不入未读、A 的发送被 403；
 *   ② 同一时刻群 B 与私聊**完全不受影响**：消息照常入未读、MCP 发送成功、假 OneBot 真收到；
 *   ③ 持久化：另起一个**全新 node 进程**读 state/silent-sessions.json，A 仍在静默表里；
 *   ④ /active（或 /silent off）只解除本会话；
 *   ⑤ 兼容历史全局字段：current-role.json 的 mode:"silent" 仍全局拦截（主人私聊除外），
 *      且 /active 能把它清掉（升级前旧值不会把人锁死）；/silent 自己**不再写**它；
 *   ⑥ 反后门：只做过 /silent 时，全局字段必须仍是 active（别又变成一条指令全局生效）。
 *
 * 跑法：node tests/session-silent.test.js
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/* 沙箱必须在**仓库内**：MCP server 要 import @modelcontextprotocol/sdk，
 * 放系统临时目录会解析不到 qq-bridge/node_modules。固定名，删不掉就退到带 pid 的名字。 */
let sandbox = path.join(HERE, '.tmp-session-silent');
try {
  fs.rmSync(sandbox, { recursive: true, force: true });
} catch {
  sandbox = path.join(HERE, `.tmp-session-silent-${process.pid}`);
  fs.rmSync(sandbox, { recursive: true, force: true });
}
fs.mkdirSync(path.join(sandbox, 'state'), { recursive: true });
fs.cpSync(path.join(HERE, '..', 'src'), path.join(sandbox, 'src'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ name: 'qbh-session-silent', private: true, type: 'module' }));

const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

const onebotPort = await freePort();
const consolePort = await freePort();

// 假 OneBot：记下真正被发出去的消息（含目标），并回一个 message_id
const received = [];
const onebot = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let parsed = {};
    try { parsed = JSON.parse(body || '{}'); } catch {}
    if (/send_(group|private)_msg/.test(String(req.url ?? ''))) {
      received.push({ url: String(req.url ?? ''), params: parsed.params ?? parsed });
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 8000 + received.length } }));
  });
});
await new Promise((r) => onebot.listen(onebotPort, '127.0.0.1', r));

const CONSOLE_TOKEN = 'session-silent-console-token';
const OWNER = '100001';
const cfg = {
  ownerQQ: OWNER,
  consolePort,
  consoleToken: CONSOLE_TOKEN,
  sendDelayMs: 0,
  napcat: { httpUrl: `http://127.0.0.1:${onebotPort}`, accessToken: '' },
  dsh: { baseUrl: 'http://127.0.0.1:1' },
  allow: {}, deny: {}, allowAllWhenEmpty: true,
  social: {
    tools: {},
    send: { linearEnabled: false, burstMaxMessages: 8, maxMessageChars: 1000, maxSendPerMinute: 0, maxSendPerHour: 0 },
  },
};
fs.writeFileSync(path.join(sandbox, 'config.json'), JSON.stringify(cfg, null, 2));

// ── 沙箱里的真 console-server（MCP server 会通过 config.consolePort 连上它）────────────
const modUrl = (p) => pathToFileURL(path.join(sandbox, 'src', p)).href;
const socialState = await import(modUrl('core/social-state.js'));
socialState.initSocialCore(cfg);
const modeMod = await import(modUrl('core/mode.js'));
modeMod.initModeCore(cfg);
const qqSend = await import(modUrl('core/qq-send.js'));
qqSend.initQqSendCore(cfg);
const auditMod = await import(modUrl('core/audit.js'));
auditMod.initAuditCore(cfg);   // shouldBlockSilentReply 要读 cfgRef.ownerQQ（全局静默豁免主人私聊）
const socialFlow = await import(modUrl('core/social-flow.js'));
socialFlow.initSocialFlowCore(cfg);
const slangMod = await import(modUrl('core/slang.js'));
try { slangMod.initSlangCore?.(cfg); } catch { /* 可选 */ }
const consoleSrv = await import(modUrl('core/console-server.js'));
consoleSrv.initConsoleCore(cfg);

/* 假机器人：桥的 QQ 发送走注入的 bot（qq-send.js 的 sendToQQ 用 botRef.sendGroupMessage /
 * sendPrivateMessage），console-server 那条 HTTP 路径自己连 napcat.httpUrl。
 * 两条路径都落到同一个假 OneBot 上，所以 received 里能看到"到底发出去了什么"。 */
function onebotApi(action, params) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(params);
    const req = http.request({ host: '127.0.0.1', port: onebotPort, path: `/${action}`, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (/send_(group|private)_msg/.test(action)) received.push({ url: `/${action}`, params });
        resolve(JSON.parse(body || '{}'));
      });
    });
    req.on('error', () => resolve({ status: 'failed' }));
    req.write(payload);
    req.end();
  });
}
const fakeBot = {
  sendGroupMessage: (gid, msg) => onebotApi('send_group_msg', { group_id: Number(gid), message: msg }),
  sendPrivateMessage: (uid, msg) => onebotApi('send_private_msg', { user_id: Number(uid), message: msg }),
  raw: (action, params) => onebotApi(action, params),
};
consoleSrv.setConsoleBot(fakeBot);
consoleSrv.startConsoleServer();
const mux = await import(modUrl('core/mux.js'));
mux.initMuxCore(cfg);
mux.setMuxBot(fakeBot);
qqSend.setQqSendBot(fakeBot);   // 桥自己的 sendToQQ 用的是 qq-send 里那份 bot

const A = '868756515';        // 被 /silent 的群
const B = '868756516';        // 另一个群（必须不受影响）
const PAL = '200002';         // 群友 QQ
const PSTRANGER = '300003';   // 私聊里的普通人（"甚至是私聊"那条的主角）
const KEY_A = `group:${A}`;
const KEY_B = `group:${B}`;
const KEY_P = `private:${PSTRANGER}`;
const KEY_OWNER_P = `private:${OWNER}`;
const SILENT_FILE = path.join(sandbox, 'state', 'silent-sessions.json');
const ROLE_FILE = path.join(sandbox, 'state', 'current-role.json');
const ACTIVITY = path.join(sandbox, 'state', 'qq-activity.log');

const readSilentFile = () => { try { return JSON.parse(fs.readFileSync(SILENT_FILE, 'utf8')); } catch { return {}; } };
const readRoleFile = () => { try { return JSON.parse(fs.readFileSync(ROLE_FILE, 'utf8')); } catch { return { role: null, mode: 'active' }; } };
const unreadOf = (key) => (socialState.getSocialState(key).unread ?? []).length;
/** 假 OneBot 收到的那条消息的纯文本（bot 路径是段对象/数组，HTTP 路径可能是字符串）。 */
const sentText = (entry) => {
  const m = entry?.params?.message;
  if (typeof m === 'string') return m;
  if (Array.isArray(m)) return m.map((s) => (typeof s === 'string' ? s : (s?.data?.text ?? ''))).join('');
  if (m && typeof m === 'object') return String(m.data?.text ?? '');
  return String(m ?? '');
};

// ── 真实入站：走 handleIncoming（QQ 消息进桥的唯一入口）────────────────────────
let mid = 500000;
const groupMsg = (gid, uid, text) => ({
  post_type: 'message', message_type: 'group', group_id: Number(gid), user_id: Number(uid),
  self_id: 100000, message_id: (mid += 1), raw_message: text,
  sender: { user_id: Number(uid), nickname: 'tester', card: '' },
  message: [{ type: 'text', data: { text } }],
});
const privateMsg = (uid, text) => ({
  post_type: 'message', message_type: 'private', user_id: Number(uid),
  self_id: 100000, message_id: (mid += 1), raw_message: text,
  sender: { user_id: Number(uid), nickname: 'tester' },
  message: [{ type: 'text', data: { text } }],
});

async function inboundGroup(gid, uid, text) { await mux.handleIncoming('group', gid, groupMsg(gid, uid, text), cfg); }
async function inboundPrivate(uid, text) { await mux.handleIncoming('private', uid, privateMsg(uid, text), cfg); }

/* 不真的去连 DSH：给各会话装一份"全关"的唤醒配置并置上 bootstrap 标记，
 * 这样 evaluateWakeTrigger 不会触发任何唤醒（本测试只关心两个静默闸门放不放行）。 */
function dormantSession(key) {
  const st = socialState.getSocialState(key);
  st.bootstrapSent = true;
  st.wakeConfig = {
    mode: 'diving', infinite: true, sleepUntil: null,
    triggers: { atMention: false, nameMention: false, speakerIds: [], keywords: [], question: false, poke: false, anyMessage: false, probability: 0, probabilitySource: 'owner' },
    batchWindowMs: 8000, lastWakeAt: 0, wakeCount: 0, noActionCount: 0, confirmedAt: Date.now(), confirmedBy: 'default',
  };
  return st;
}
for (const k of [KEY_A, KEY_B, KEY_P, KEY_OWNER_P]) dormantSession(k);

// ── MCP 客户端（stdin/stdout JSON-RPC；spawn 沙箱里那份 mcp-napcat-safe.js）────────
function startMcpServer(timeoutMs = 30000) {
  const child = spawn(process.execPath, [path.join(sandbox, 'src', 'mcp-napcat-safe.js')], { stdio: ['pipe', 'pipe', 'pipe'], cwd: sandbox });
  let stdout = '';
  let stderr = '';
  let id = 900;
  const pending = new Map();
  child.stdout.on('data', (c) => {
    stdout += c.toString('utf8');
    let idx;
    while ((idx = stdout.indexOf('\n')) >= 0) {
      const line = stdout.slice(0, idx).trim();
      stdout = stdout.slice(idx + 1);
      if (!line.startsWith('{')) continue;
      let msg = null;
      try { msg = JSON.parse(line); } catch { continue; }
      const resolve = pending.get(msg.id);
      if (resolve) { pending.delete(msg.id); resolve(msg); }
    }
  });
  child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
  const write = (obj) => child.stdin.write(`${JSON.stringify(obj)}\n`);
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const rid = ++id;
    const timer = setTimeout(() => { pending.delete(rid); reject(new Error(`timeout ${method}; stderr=${stderr.slice(0, 400)}`)); }, timeoutMs);
    pending.set(rid, (msg) => { clearTimeout(timer); resolve(msg); });
    write({ jsonrpc: '2.0', id: rid, method, params });
  });
  return { rpc, write, stop: () => { try { child.stdin.end(); } catch {} try { child.kill(); } catch {} } };
}

const mcp = startMcpServer();
await mcp.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'session-silent', version: '0' } });
mcp.write({ jsonrpc: '2.0', method: 'notifications/initialized' });

async function callTool(name, args) {
  const r = await mcp.rpc('tools/call', { name, arguments: args });
  return { isError: !!r.result?.isError, text: String(r.result?.content?.[0]?.text ?? '') };
}

/** 真实 HTTP 调 console-server（管理端可查"当前静默了哪些会话"）。 */
function consoleGet(p) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: consolePort, path: p, method: 'GET', headers: { 'x-console-token': CONSOLE_TOKEN } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(body); } catch {} resolve({ status: res.statusCode, json: j, body }); });
    });
    req.on('error', reject);
    req.end();
  });
}

let pass = 0;
let fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass += 1; console.log(`  PASS ${name}`); }
  catch (e) { fail += 1; console.error(`  FAIL ${name}\n       ${e?.message ?? e}`); }
};

// ── ① A 群发 /silent：只静默 A ───────────────────────────────────────────────
console.log('== ① 群 A 发 /silent：只静默 A ==');
{
  received.length = 0;
  const before = unreadOf(KEY_A);
  await inboundGroup(A, OWNER, '/silent');
  await t('/silent 在 A 群回执（假 OneBot 收到发往 A 的群消息）', () => {
    assert.ok(received.length >= 1, `假 OneBot 收到 ${received.length} 条`);
    for (const r of received) assert.equal(String(r.params.group_id), A, JSON.stringify(r).slice(0, 200));
    const joined = received.map(sentText).join(' | ');
    assert.match(joined, /这个会话/, joined);
    assert.match(joined, /其他群和私聊不受影响/, joined);
  });
  await t('静默表落盘 state/silent-sessions.json 且只有 group:A', () => {
    const store = readSilentFile();
    assert.deepEqual(Object.keys(store), [KEY_A], JSON.stringify(store));
    assert.ok(store[KEY_A].by === OWNER || store[KEY_A].by === Number(OWNER), JSON.stringify(store));
  });
  await t('/silent 不再写全局字段（current-role.json 仍是 active）', () => {
    assert.equal(readRoleFile().mode, 'active', JSON.stringify(readRoleFile()));
  });
  await t('A 群群友消息被拦下（不入未读），活动日志写明是本会话静默', async () => {
    await inboundGroup(A, PAL, '路过一下');
    assert.equal(unreadOf(KEY_A), before, '静默会话的群友消息不该进未读');
    const log = fs.readFileSync(ACTIVITY, 'utf8');
    const line = log.split('\n').find((l) => l.includes('路过一下')) ?? '';
    assert.match(line, /静默模式/, line);
    assert.ok(!line.includes('全局'), '本会话静默不该被记成全局：' + line);
  });
  await t('真实 HTTP 可查：GET /api/silent-sessions 列出 group:A', async () => {
    const r = await consoleGet('/api/silent-sessions');
    assert.equal(r.status, 200, r.body.slice(0, 200));
    assert.deepEqual((r.json?.sessions ?? []).map((x) => x.key), [KEY_A], JSON.stringify(r.json).slice(0, 300));
  });
}

// ── ② B 群与私聊完全不受影响（本 bug 的正题）────────────────────────────────
console.log('== ② 同一时刻：B 群与私聊照常（不得被一起静默）==');
{
  received.length = 0;
  const beforeB = unreadOf(KEY_B);
  const beforeP = unreadOf(KEY_P);
  await inboundGroup(B, PAL, 'B 群正常说话');
  await inboundPrivate(PSTRANGER, '私聊正常说话');
  await t('B 群群友消息照常入未读', () => {
    assert.equal(unreadOf(KEY_B), beforeB + 1, 'B 群被误静默了');
  });
  await t('私聊消息照常入未读（"甚至是私聊"这条不再发生）', () => {
    assert.equal(unreadOf(KEY_P), beforeP + 1, '私聊被误静默了');
  });
  await t('MCP 发送：A 被 403 拦下（静默表真的在出站闸门上生效）', async () => {
    const r = await callTool('qq_send_message', { key: KEY_A, token: A, messages: '这条不该发出去' });
    assert.equal(r.isError, true, r.text.slice(0, 200));
    assert.match(r.text, /静默模式已开启/, r.text.slice(0, 200));
    assert.equal(received.filter((x) => String(x.params.group_id) === A).length, 0, '被拦下的内容不该到 OneBot');
  });
  await t('MCP 发送：B 群照常发出（假 OneBot 真收到）', async () => {
    const n = received.length;
    const r = await callTool('qq_send_message', { key: KEY_B, token: B, messages: 'B 群照常回' });
    assert.equal(r.isError, false, r.text.slice(0, 200));
    assert.ok(received.length > n, `假 OneBot 没收到新消息（${received.length}）`);
    assert.equal(String(received[received.length - 1].params.group_id), B);
  });
  await t('MCP 发送：给别人私聊照常发出', async () => {
    const n = received.length;
    const r = await callTool('qq_send_message', { key: KEY_P, token: PSTRANGER, messages: '私聊照常回' });
    assert.equal(r.isError, false, r.text.slice(0, 200));
    assert.ok(received.length > n, `假 OneBot 没收到新消息（${received.length}）`);
    assert.equal(String(received[received.length - 1].params.user_id), PSTRANGER);
  });
}

// ── ③ 持久化：全新进程读同一份状态，A 依然静默 ───────────────────────────────
console.log('== ③ 持久化：换一个全新 node 进程读状态，A 仍在静默表 ==');
{
  await t('子进程 listSilentSessions() = [group:A]', () => {
    const spec = pathToFileURL(path.join(sandbox, 'src', 'lib', 'session-silent.js')).href;
    const r = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(spec)}).then(m => console.log(JSON.stringify(m.listSilentSessions())))`], { cwd: sandbox, encoding: 'utf8' });
    assert.equal(r.status, 0, `${r.status} stderr=${r.stderr.slice(0, 300)}`);
    const list = JSON.parse(r.stdout.trim().split('\n').pop() || '[]');
    assert.deepEqual(list.map((x) => x.key), [KEY_A], JSON.stringify(list));
  });
}

// ── ④ /active 与 /silent off 只解除本会话 ───────────────────────────────────
console.log('== ④ 撤销只影响本会话 ==');
{
  await inboundGroup(A, OWNER, '/silent off');
  await t('/silent off 后 A 从静默表消失（B 无关）', () => {
    assert.deepEqual(readSilentFile(), {}, JSON.stringify(readSilentFile()));
  });
  received.length = 0;
  await t('A 的群友消息恢复入未读、MCP 发送恢复', async () => {
    const before = unreadOf(KEY_A);
    await inboundGroup(A, PAL, 'A 群照常闲聊');
    assert.equal(unreadOf(KEY_A), before + 1);
    const r = await callTool('qq_send_message', { key: KEY_A, token: A, messages: 'A 恢复' });
    assert.equal(r.isError, false, r.text.slice(0, 200));
    assert.ok(received.length >= 1, `假 OneBot 收到 ${received.length} 条`);
    assert.equal(String(received[received.length - 1].params.group_id), A);
  });
  // 再用 /active 走一遍（老写法）
  await inboundGroup(A, OWNER, '/silent');
  await inboundGroup(A, OWNER, '/active');
  await t('/active 同样解除本会话（且不残留静默表条目）', () => {
    assert.deepEqual(readSilentFile(), {}, JSON.stringify(readSilentFile()));
  });
}

// ── ⑤ 历史全局字段仍被尊重 + 可被 /active 清掉 ──────────────────────────────
console.log('== ⑤ 兼容 current-role.json 的全局 mode:"silent" ==');
{
  fs.writeFileSync(ROLE_FILE, JSON.stringify({ role: null, mode: 'silent' }, null, 2) + '\n');
  received.length = 0;
  await t('全局静默时：B 群消息被拦、B 的 MCP 发送 403', async () => {
    const before = unreadOf(KEY_B);
    await inboundGroup(B, PAL, '全局静默下这句该被拦');
    assert.equal(unreadOf(KEY_B), before, '全局静默没生效（旧配置会失效）');
    const r = await callTool('qq_send_message', { key: KEY_B, token: B, messages: 'x' });
    assert.equal(r.isError, true, r.text.slice(0, 200));
  });
  await t('全局静默时：主人私聊仍放行（旧语义保留）', async () => {
    const r = await callTool('qq_send_message', { key: KEY_OWNER_P, token: OWNER, messages: '主人私聊' });
    assert.equal(r.isError, false, r.text.slice(0, 200));
  });
  await inboundGroup(A, OWNER, '/active');
  await t('/active 清掉全局字段（否则升级前的旧值会把人锁死）', () => {
    const role = readRoleFile();
    assert.equal(role.mode, 'active', JSON.stringify(role));
  });
  await t('全局解除后 B 立刻恢复', async () => {
    const before = unreadOf(KEY_B);
    await inboundGroup(B, PAL, 'B 再次正常');
    assert.equal(unreadOf(KEY_B), before + 1);
  });
  await t('/silent 仍然不写全局字段（反后门）', async () => {
    await inboundGroup(A, OWNER, '/silent');
    assert.equal(readRoleFile().mode, 'active', JSON.stringify(readRoleFile()));
    assert.deepEqual(Object.keys(readSilentFile()), [KEY_A]);
    assert.equal(readSilentFile()[KEY_A].by, OWNER);
    // 收尾：还原成"什么都没有"的状态
    await inboundGroup(A, OWNER, '/active');
    assert.deepEqual(readSilentFile(), {});
  });
}

// ── ⑥ /status 把两种静默分开报 ──────────────────────────────────────────────
console.log('== ⑥ /status 文案 ==');
{
  received.length = 0;
  await inboundGroup(A, OWNER, '/silent');
  await inboundGroup(A, OWNER, '/status');
  await t('/status 同时报「本会话静默」与「全局静默」', () => {
    const text = sentText(received[received.length - 1]);
    assert.match(text, /本会话静默 开/, text);
    assert.match(text, /全局静默 关/, text);
  });
  await inboundGroup(A, OWNER, '/active');
}

// ── 收尾 ────────────────────────────────────────────────────────────────────
mcp.stop();
try { onebot.closeAllConnections?.(); } catch {}
await new Promise((r) => onebot.close(() => r()));
try { consoleSrv.stopConsoleServer?.(); } catch {}
try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* sqlite 句柄未释放时留给下一轮重建 */ }
console.log(`session-silent: ${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
