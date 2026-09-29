// 「搜+发一步化」的已读副作用：markRead 融进未读读取与各发送工具（2026-09-29）
//
// 需求原话：「把 pixiv 搜图发图融合到一起，模型**一步之内**完成收发，包括把**已读融进各个工具内**」。
// 本测试要钉住的不是"搜+发是不是一次调用"（那是描述措辞问题），而是**这次改动唯一有风险的地方**：
// 自动推进已读水位，绝不能把「模型从没见过的消息」静默标记成已读。
//
// 判据（真起 console-server + 真 spawn MCP server + 假 OneBot，全部真实 HTTP）：
//   ① qq_get_unread_messages 默认（markRead 缺省=true）→ 读到的这批同一次调用里就被标记；
//      再读一次不再返回它（水位真的推进了）。
//   ② markRead:false → 纯只读，再读一次原样还在。
//   ③ 被 limit 截断时不推进水位（更旧的未读没展示给模型，绝不能被顺手签收）。
//   ④ qq_send_message 默认发完自动推进水位（turnSeenUnread 快照内），"搜+发"那一步同时也是"读"。
//   ⑤ 发送工具 markRead:false → 不推进。
//   ⑥ **没有展示快照时一律不动**（主动搭话/定时/跨会话转达那一类回合）—— 这是防吞消息的主闸门。
//
// 跑法：node tests/mark-read-fused.test.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/* 沙箱必须在**仓库内**（tests/.tmp-mark-read-fused）：MCP server 要 import @modelcontextprotocol/sdk，
 * 放到系统临时目录会解析不到 qq-bridge/node_modules（ERR_MODULE_NOT_FOUND）。
 * 固定名 + 删不掉就退到带 pid 的名字：console-server 起的 node:sqlite 连接要到进程结束才释放，
 * Windows 上上一轮的目录偶尔删不掉（EPERM）。 */
let sandbox = path.join(HERE, '.tmp-mark-read-fused');
try {
  fs.rmSync(sandbox, { recursive: true, force: true });
} catch {
  sandbox = path.join(HERE, `.tmp-mark-read-fused-${process.pid}`);
  fs.rmSync(sandbox, { recursive: true, force: true });
}
fs.mkdirSync(path.join(sandbox, 'state'), { recursive: true });
fs.cpSync(path.join(HERE, '..', 'src'), path.join(sandbox, 'src'), { recursive: true });
fs.writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ name: 'qbh-mark-read-fused', private: true, type: 'module' }));

const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

const onebotPort = await freePort();
const consolePort = await freePort();

// 假 OneBot：记下真正被发出去的消息，并回一个 message_id
const received = [];
const onebot = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let parsed = {};
    try { parsed = JSON.parse(body || '{}'); } catch {}
    if (/send_(group|private)_msg/.test(String(req.url ?? ''))) received.push(parsed);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 7000 + received.length } }));
  });
});
await new Promise((r) => onebot.listen(onebotPort, '127.0.0.1', r));

const CONSOLE_TOKEN = 'mark-read-fused-console-token';
const cfg = {
  ownerQQ: '100001',
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
const socialFlow = await import(modUrl('core/social-flow.js'));
socialFlow.initSocialFlowCore(cfg);
const consoleSrv = await import(modUrl('core/console-server.js'));
consoleSrv.initConsoleCore(cfg);
consoleSrv.setConsoleBot(null);
consoleSrv.startConsoleServer();

const KEY = 'group:868756515';
const TOKEN = '868756515';                 // 会话令牌 = 会话本体（群号），见 social-state.fixedTokenForKey

// ── 把"未读消息"塞进沙箱社交状态 ──────────────────────────────────────────────
// 走**真实的入站收口** appendSocialMessage（内存 st.unread + 落 chat.db 两步都做），
// 这样 markMessagesRead 的 SQL 水位更新才有真实行可更新（否则 dbUpdated 恒为 0，验不到落库那一半）。
const APPEND = ['测试同学', null, null, false, false, null, [], '200002'];
let mid = 100000;
function seedUnread(n) {
  const st = socialState.getSocialState(KEY);
  st.unread = [];
  st.turnSeenUnread = [];
  for (let i = 0; i < n; i++) {
    mid += 1;
    const text = `第 ${mid} 条未读`;
    socialFlow.appendSocialMessage(KEY, APPEND[0], text, text, false, false, mid, [], '200002');
  }
  return st;
}
const unreadNow = () => (socialState.getSocialState(KEY).unread || []).map((m) => Number(m.seq));
const maxSeqNow = () => Math.max(0, ...unreadNow());

// ── MCP 客户端（stdin/stdout JSON-RPC；spawn 沙箱里那份 mcp-napcat-safe.js）────────
function startMcpServer(timeoutMs = 30000) {
  const child = spawn(process.execPath, [path.join(sandbox, 'src', 'mcp-napcat-safe.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
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
await mcp.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'mark-read-fused', version: '0' } });
mcp.write({ jsonrpc: '2.0', method: 'notifications/initialized' });

async function callTool(name, args) {
  const r = await mcp.rpc('tools/call', { name, arguments: args });
  const text = String(r.result?.content?.[0]?.text ?? '');
  return { isError: !!r.result?.isError, text };
}
/** 工具回显是 JSON 文本，解析成对象；解析不了就抛（附原文前 300 字符便于定位）。 */
function asJson(res) {
  try { return JSON.parse(res.text); } catch { throw new Error(`工具回显不是 JSON：${res.text.slice(0, 300)}`); }
}

let pass = 0;
let fail = 0;
const t = async (name, fn) => {
  try { await fn(); pass += 1; console.log(`  PASS ${name}`); }
  catch (e) { fail += 1; console.error(`  FAIL ${name}\n       ${e?.message ?? e}`); }
};

// ── ① 未读工具默认读后即已读 ──────────────────────────────────────────────────
console.log('== ① qq_get_unread_messages：默认读完即已读 ==');
{
  const st = seedUnread(2);
  const top = maxSeqNow();
  st.turnSeenUnread = unreadNow();               // 唤醒正文已展示过（通常由 wake-send 写入）
  const r1 = await callTool('qq_get_unread_messages', { key: KEY, token: TOKEN });
  const j1 = asJson(r1);
  await t('sanity：第一次读到 2 条', () => {
    assert.equal(r1.isError, false, r1.text.slice(0, 300));
    assert.equal(j1.unreadCount, 2, r1.text.slice(0, 300));
  });
  await t('默认 markRead：回执里带 markRead，标记数=返回条数、水位=最大 seq', () => {
    assert.ok(j1.markRead, '回执里没有 markRead 字段：' + r1.text.slice(0, 300));
    assert.equal(j1.markRead.marked, 2);
    assert.equal(j1.markRead.watermark, top);
    assert.equal(j1.markRead.dbUpdated, 2, '应把 2 条入向消息在 chat.db 里置为已读');
  });
  await t('水位真的推进：内存未读清空', () => {
    assert.deepEqual(unreadNow(), []);
  });
  const r2 = await callTool('qq_get_unread_messages', { key: KEY, token: TOKEN });
  await t('再读一次：不再返回那批（不会反复重放）', () => {
    assert.equal(asJson(r2).unreadCount, 0, r2.text.slice(0, 300));
  });
}

// ── ② markRead:false 仍是纯只读 ───────────────────────────────────────────────
console.log('== ② markRead:false 保持只读语义 ==');
{
  seedUnread(2);
  const r1 = await callTool('qq_get_unread_messages', { key: KEY, token: TOKEN, markRead: false });
  const j1 = asJson(r1);
  await t('markRead:false：回执里没有 markRead，未读原样保留', () => {
    assert.equal(j1.unreadCount, 2);
    assert.equal(j1.markRead, undefined, 'markRead:false 不该带回 markRead 字段');
    assert.equal(unreadNow().length, 2, '未读不该被标记');
  });
  const r2 = await callTool('qq_get_unread_messages', { key: KEY, token: TOKEN, markRead: false });
  await t('再读一次：还是那 2 条', () => {
    assert.equal(asJson(r2).unreadCount, 2);
  });
}

// ── ③ 截断安全：没返回给模型的更旧未读不许被签收 ─────────────────────────────
console.log('== ③ 列表被 limit 截断时不推进水位（防吞）==');
{
  seedUnread(5);
  const r1 = await callTool('qq_get_unread_messages', { key: KEY, token: TOKEN, limit: 2 });
  const j1 = asJson(r1);
  await t('只返回最新 2 条，且回执明确说明没推水位', () => {
    assert.equal(j1.unreadCount, 2);
    assert.equal(j1.markRead.marked, 2);
    assert.equal(j1.markRead.watermark, null, '截断时不该给水位');
    assert.match(String(j1.markRead.note ?? ''), /水位/, '应说明未推进水位：' + r1.text.slice(0, 300));
  });
  await t('更旧的 3 条仍在未读里（模型没看过 → 不许被签收）', () => {
    assert.equal(unreadNow().length, 3);
  });
}

// ── ④ 发送工具默认自动推进水位 ────────────────────────────────────────────────
console.log('== ④ qq_send_message：发完自动推进已读水位 ==');
{
  const st = seedUnread(2);
  const top = maxSeqNow();
  st.turnSeenUnread = unreadNow();
  received.length = 0;
  const r1 = await callTool('qq_send_message', { key: KEY, token: TOKEN, messages: '一步到位的回复' });
  const j1 = asJson(r1);
  await t('消息真的发出去了（假 OneBot 收到一条）', () => {
    assert.equal(r1.isError, false, r1.text.slice(0, 300));
    assert.equal(j1.sent, 1, r1.text.slice(0, 300));
    assert.equal(received.length, 1, '假 OneBot 应收到 1 条');
  });
  await t('回执带 markRead.ok=true 且推进到快照水位', () => {
    assert.ok(j1.markRead, '回执里没有 markRead：' + r1.text.slice(0, 300));
    assert.equal(j1.markRead.ok, true, r1.text.slice(0, 300));
    assert.equal(j1.markRead.advanced, true);
    assert.equal(j1.markRead.watermark, top);
    assert.equal(j1.markRead.markedCount, 2);
  });
  await t('已读水位真的推进：未读清空', () => {
    assert.deepEqual(unreadNow(), []);
  });
}

// ── ⑤ 发送工具 markRead:false 不推进 ─────────────────────────────────────────
console.log('== ⑤ qq_send_message markRead:false 不推进 ==');
{
  const st = seedUnread(2);
  st.turnSeenUnread = unreadNow();
  received.length = 0;
  const r1 = await callTool('qq_send_message', { key: KEY, token: TOKEN, messages: '这条之后我还没看完', markRead: false });
  const j1 = asJson(r1);
  await t('markRead:false 时明确 skip，且未读原样保留', () => {
    assert.equal(r1.isError, false, r1.text.slice(0, 300));
    assert.equal(received.length, 1, '消息照样要发出去');
    assert.equal(j1.markRead?.skipped, 'markRead=false', r1.text.slice(0, 300));
    assert.equal(unreadNow().length, 2, '未读不该被标记');
  });
}

// ── ⑥ 没有展示快照 → 一律不动（本改动的主安全闸门）───────────────────────────
console.log('== ⑥ 没有"已展示"快照时不动水位（防把没见过的消息签收）==');
{
  const st = seedUnread(3);
  st.turnSeenUnread = [];                     // 该回合不是靠唤醒正文开起来的（主动搭话 / 定时 / 跨会话）
  received.length = 0;
  const r1 = await callTool('qq_send_message', { key: KEY, token: TOKEN, messages: '主动打个招呼' });
  const j1 = asJson(r1);
  await t('消息发得出去，但已读水位一分不动', () => {
    assert.equal(r1.isError, false, r1.text.slice(0, 300));
    assert.equal(received.length, 1);
    assert.equal(j1.markRead?.ok, true, r1.text.slice(0, 300));
    assert.equal(j1.markRead?.advanced, false, '没有快照就该 advanced=false：' + r1.text.slice(0, 300));
    assert.equal(j1.markRead?.markedCount, 0);
    assert.match(String(j1.markRead?.note ?? ''), /qq_mark_read/, '应提示要显式收尾就用 qq_mark_read');
    assert.equal(unreadNow().length, 3, '3 条没见过的未读必须原样留着');
  });
}

// ── ⑦ 未读工具的 schema 说明了新语义 ────────────────────────────────────────
console.log('== ⑦ schema 文案 ==');
{
  const list = await mcp.rpc('tools/list', {});
  const tools = list.result?.tools ?? [];
  const unreadTool = tools.find((x) => x.name === 'qq_get_unread_messages');
  const sendTool = tools.find((x) => x.name === 'qq_send_message');
  await t('qq_get_unread_messages：描述里不再说 "does not auto-mark them read"，且声明了 markRead', () => {
    assert.ok(unreadTool, 'qq_get_unread_messages 未注册');
    const desc = String(unreadTool.description ?? '');
    assert.ok(!/does not auto-mark them read/.test(desc), '旧文案还在：' + desc.slice(0, 200));
    assert.ok(Object.keys(unreadTool.inputSchema?.properties ?? {}).includes('markRead'), 'schema 里没有 markRead');
  });
  await t('qq_send_message：schema 里有 markRead，且 key/token 仍是可选的（缺 key 走"缺 key"提示）', () => {
    assert.ok(sendTool, 'qq_send_message 未注册');
    assert.ok(Object.keys(sendTool.inputSchema?.properties ?? {}).includes('markRead'), 'schema 里没有 markRead');
  });
}

// ── 收尾 ────────────────────────────────────────────────────────────────────
mcp.stop();
try { onebot.closeAllConnections?.(); } catch {}
await new Promise((r) => onebot.close(() => r()));
try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* sqlite 句柄未释放时留给下一轮重建 */ }
console.log(`mark-read-fused: ${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);
