// 回归（2026-10-28）：人设工具结果必须在回合末被挤出 surface，否则整张 217 行角色卡每轮进历史重发。
// 现场证据：单会话日志里同一张卡出现 132 次；旧的 turn-pruner 指向 DSH 0.1.x 的 session_*.json，
// 0.2.x 的 session.v4.jsonl.zstd 永远 resolve 不到 → 一条 [pruner] 日志都没有。
// 这里验证新插件走的是 DSH 受支持的 surfaceOp replace（和内置 tool-result-pruner 同款 API）。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PRESET_DIR = path.join(process.cwd(), 'dsh', 'agent-presets', 'qq-chat');
let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + ' ' + extra); process.exitCode = 1; }
};

const mod = await import(pathToFileURL(path.join(PRESET_DIR, 'qq-persona-ephemeral.mjs')).href);

function fakeSession(events) {
  const appended = [];
  return {
    appended,
    surface: { nodes: events.map((e) => e.seq) },
    eventAt(seq) { return events.find((e) => e.seq === seq) || null; },
    append(type, data, opts) { appended.push({ type, data, opts }); return { seq: 900 + appended.length }; },
  };
}

const longPersona = '【persona_load】\n# 角色卡：DeepSeek 小鲸鱼\n' + '你是谁 '.repeat(400);
const mkPersona = (seq, callId) => ({ seq, type: 'tool/result', data: { message: { role: 'tool', source: { kind: 'tool', callId }, content: [{ type: 'text', text: longPersona }] } } });

/* 2026-10-30 政策：人设只剪「旧副本」，最近一次加载常驻 —— 否则守卫的 30 分钟新鲜窗口
 * 会让整场会话只有第 1 轮手里有人设（线上 6 回合 1 次加载的现场）。 */
console.log('== ① 旧人设被替换成占位，最近一份保留 ==');
const events = [
  { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: '在吗' }] } },
  mkPersona(2, 'c1'),
  { seq: 3, type: 'assistant/message', data: { content: [{ type: 'text', text: '在' }] } },
  mkPersona(4, 'c2'),
];
const s1 = fakeSession(events);
const n1 = mod.prunePersonaResults(s1);
ok('只剪了旧的 1 条', n1 === 1, 'got ' + n1);
const rep = s1.appended[0];
ok('剪的是 seq 2 那份旧人设', !!rep && rep.opts?.surfaceOp?.op === 'replace' && rep.opts.surfaceOp.startSeq === 2 && rep.opts.surfaceOp.endSeq === 2, JSON.stringify(rep?.opts));
ok('引用了被遮蔽的原事件', JSON.stringify(rep?.opts?.sourceEventSeqs) === '[2]');
const newText = rep?.data?.message?.content?.map((b) => b.text).join('');
ok('正文只剩占位（不含角色卡正文）', newText.includes('ephemeral_turn_pruned') && !newText.includes('你是谁'), String(newText).slice(0, 120));
ok('调用痕迹保留', rep?.data?.message?.source?.callId === 'c1');
ok('最新一份人设（seq 4）没被剪', s1.appended.every((a) => a.opts?.surfaceOp?.startSeq !== 4));

console.log('== ①b 只有一份人设时一条也不剪（常驻） ==');
const s1b = fakeSession([mkPersona(6, 'c3')]);
ok('不替换', mod.prunePersonaResults(s1b) === 0);
ok('没写多余事件', s1b.appended.length === 0);

console.log('== ② 已剪过的不再重复剪 ==');
const pruned = { seq: 4, type: 'tool/result', data: { message: { role: 'tool', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'text', text: '【persona_load: ephemeral_turn_pruned】本轮人设已内化；正文已剪除以省上下文，需要时再调 qq_load_persona。' }] } } };
const s2 = fakeSession([pruned]);
ok('二次不替换', mod.prunePersonaResults(s2) === 0);
ok('没写多余事件', s2.appended.length === 0);

console.log('== ③ 非人设结果不动 ==');
const s3 = fakeSession([{ seq: 5, type: 'tool/result', data: { message: { role: 'tool', content: [{ type: 'text', text: '普通工具结果'.repeat(50) }] } } }]);
ok('普通结果不替换', mod.prunePersonaResults(s3) === 0);

console.log('== ③b 读进来的对话上下文也剪（tool/call 映射） ==');
const ctxEvents = [
  { seq: 10, type: 'tool/call', data: { callId: 'c-ctx', name: 'mcp__napcat__napcat_invoke_tool', arguments: JSON.stringify({ tool_name: 'qq_get_recent_messages', tool_input: {} }) } },
  { seq: 11, type: 'tool/result', data: { toolCallId: 'c-ctx', message: { role: 'tool', source: { kind: 'tool', callId: 'c-ctx' }, content: [{ type: 'text', text: '{"ok":true,"messages":[' + '"老消息"'.repeat(200) + ']}' }] } } },
  { seq: 12, type: 'tool/call', data: { callId: 'c-send', name: 'mcp__napcat__napcat_invoke_tool', arguments: JSON.stringify({ tool_name: 'qq_send_message', tool_input: {} }) } },
  { seq: 13, type: 'tool/result', data: { toolCallId: 'c-send', message: { role: 'tool', source: { kind: 'tool', callId: 'c-send' }, content: [{ type: 'text', text: '{"ok":true,"messageId":"123"}' }] } } }
];
const s4 = fakeSession(ctxEvents);
const n4 = mod.prunePersonaResults(s4);
ok('只剪上下文读取那条', n4 === 1, 'got ' + n4);
ok('剪的是 qq_get_recent_messages 的结果', s4.appended[0]?.opts?.surfaceOp?.startSeq === 11);
ok('发送结果不动', s4.appended.every((a) => a.opts?.surfaceOp?.startSeq !== 13));

console.log('== ③c get_time 的结果也剪（每轮现取的时钟，下一轮就过期） ==');
const clockEvents = [
  { seq: 20, type: 'tool/call', data: { callId: 'c-clock', name: 'get_time', arguments: '{}' } },
  { seq: 21, type: 'tool/result', data: { toolCallId: 'c-clock', message: { role: 'tool', source: { kind: 'tool', callId: 'c-clock' }, content: [{ type: 'text', text: 'time=20:05 timezone=Asia/Shanghai epochMs=1793' }] } } }
];
const s5 = fakeSession(clockEvents);
ok('get_time 结果被剪', mod.prunePersonaResults(s5) === 1 && s5.appended[0]?.opts?.surfaceOp?.startSeq === 21);

console.log('== ⑤ 单轮折叠：除系统提示词/工具注册外全部折叠 ==');
const sys = { seq: 1, type: 'system/message', data: { message: { role: 'system', content: [{ type: 'text', text: '系统提示词' }] } } };
const reg = { seq: 2, type: 'developer/message', data: { message: { role: 'developer', source: { kind: 'tool-registry' }, content: [{ type: 'tool-removal', toolName: 'ops_bash' }] } } };
const turnEvents = [
  sys, reg,
  { seq: 3, type: 'user/message', data: { content: [{ type: 'text', text: '[Wake private]' }] } },
  { seq: 4, type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'x', name: 'qq_send_message', arguments: '{"messages":["打得太软喵"]}' }] } } },
  mkPersona(5, 'cp'),
  { seq: 6, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'OK' }] } } },
];
const sc = fakeSession(turnEvents);
sc.id = 'sess-collapse';
const nc = mod.collapseToSingleTurn(sc);
ok('折叠了 4 个节点（user/assistant/tool）', nc === 4, 'got ' + nc);
ok('只追加 1 条替换事件', sc.appended.length === 1, 'got ' + sc.appended.length);
const rc = sc.appended[0];
ok('替换范围 3..6', rc?.opts?.surfaceOp?.startSeq === 3 && rc.opts.surfaceOp.endSeq === 6, JSON.stringify(rc?.opts?.surfaceOp));
ok('sourceEventSeqs 列全被覆盖节点', JSON.stringify(rc?.opts?.sourceEventSeqs) === '[3,4,5,6]');
ok('替换事件是空 developer/message（不产生模型消息）', rc?.type === 'developer/message' && rc.data.message.role === 'developer' && rc.data.message.content.length === 0);
ok('系统提示词与工具注册不在范围内', rc.opts.surfaceOp.startSeq > 2);
ok('通知守卫人设/上下文记录作废', globalThis.__qqCollapsedAt instanceof Map && globalThis.__qqCollapsedAt.has('sess-collapse'));

console.log('== ⑤b 已折叠的会话不再重复折叠；新一轮只折叠新增部分 ==');
const placeholder = { seq: 7, type: 'developer/message', data: { message: { role: 'developer', source: { kind: 'tool-registry' }, content: [] } } };
const sd = fakeSession([sys, reg, placeholder]);
ok('只有空占位时不动', mod.collapseToSingleTurn(sd) === 0 && sd.appended.length === 0);
const se = fakeSession([sys, reg, placeholder,
  { seq: 8, type: 'user/message', data: { content: [{ type: 'text', text: '新一轮' }] } },
  { seq: 9, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'OK' }] } } }]);
ok('占位 + 新一轮合并折叠（不累积空占位）', mod.collapseToSingleTurn(se) === 3 && se.appended[0].opts.surfaceOp.startSeq === 7 && se.appended[0].opts.surfaceOp.endSeq === 9, JSON.stringify(se.appended[0]?.opts));

console.log('== ⑤c 守卫在折叠之后要求重读人设与上下文 ==');
const guardSrc = fs.readFileSync(path.join(PRESET_DIR, 'qq-tool-restrict.mjs'), 'utf8');
ok('守卫比较 __qqCollapsedAt（人设）', /loadedAt <= collapsedAt/.test(guardSrc));
ok('守卫比较 __qqCollapsedAt（上下文）', /ctxAt <= collapsedAt/.test(guardSrc));

console.log('== ④ 接线 ==');
const yml = fs.readFileSync(path.join(PRESET_DIR, 'agent.cordis.yml'), 'utf8');
ok('预设挂了 qq-persona-ephemeral', /- id: qq-persona-ephemeral[\s\S]{0,80}qq-persona-ephemeral\.mjs/.test(yml));
const guard = fs.readFileSync(path.join(PRESET_DIR, 'qq-tool-restrict.mjs'), 'utf8');
ok('守卫放行 run_code', /'run_code',/.test(guard) && /SAFE_BARE_NAME/.test(guard));

console.log('\nALL PASS  pass=' + pass + ' fail=' + fail);
