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

console.log('== ④ 接线 ==');
const yml = fs.readFileSync(path.join(PRESET_DIR, 'agent.cordis.yml'), 'utf8');
ok('预设挂了 qq-persona-ephemeral', /- id: qq-persona-ephemeral[\s\S]{0,80}qq-persona-ephemeral\.mjs/.test(yml));
const guard = fs.readFileSync(path.join(PRESET_DIR, 'qq-tool-restrict.mjs'), 'utf8');
ok('守卫放行 run_code', /'run_code',/.test(guard) && /SAFE_BARE_NAME/.test(guard));

console.log('\nALL PASS  pass=' + pass + ' fail=' + fail);
