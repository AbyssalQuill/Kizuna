import assert from 'node:assert/strict';
import {
  apply,
  sessionLoadedPersona,
  sessionSentMessage,
  sessionPersonaTurn,
  sessionSentCount
} from '../dsh/agent-presets/qq-chat/qq-tool-restrict.mjs';

console.log('=== 校验 1：白名单与 Token 防呆 ===');
let guardFn = null;
const turnStoppingHandlers = [];
const fakeCtx = {
  tools: {
    restrict: () => {},
    guard: (fn) => { guardFn = fn; }
  },
  on: (event, fn) => { if (event === 'agent/turn-stopping') turnStoppingHandlers.push(fn); }
};

apply(fakeCtx);
assert.ok(typeof guardFn === 'function', 'guard 必须成功注册');
assert.equal(turnStoppingHandlers.length, 1, '必须订阅 agent/turn-stopping（回合边界复位）');

const resNum = guardFn({ name: '1736784911' });
assert.ok(resNum && resNum.includes('is a session auth token, not a tool name'), '纯数字工具名被精准拦截');

const resInvokeNum = guardFn({
  name: 'mcp__napcat__napcat_invoke_tool',
  arguments: { tool_name: '1736784911' }
});
assert.ok(resInvokeNum && resInvokeNum.includes('is a session auth token, not a tool name'), 'invoke 包装下的纯数字被精准拦截');

assert.ok(
  String(guardFn({ name: 'dev_build_plugin' })).includes('not on the QQ bridge whitelist'),
  '白名单外的全局开发工具被拒'
);
console.log('PASS: 白名单 / Token 拦截');

// 工具夹具：线上真实形态是 napcat_invoke_tool + tool_name
const sess = 'test-sess-guard-voice';
const resetSess = () => {
  for (const m of [sessionLoadedPersona, sessionSentMessage, sessionPersonaTurn, sessionSentCount]) m.delete(sess);
};
const call = (toolName) => guardFn({
  name: 'mcp__napcat__napcat_invoke_tool',
  arguments: { key: 'private:1736784911', tool_name: toolName },
  agent: { session: { id: sess } }
});

console.log('=== 校验 2：未载入人设，任何发送都被拦 ===');
resetSess();
assert.ok(String(call('qq_send_message')).includes('step_1 is mandatory'), '未读人设发文字被拦截');
assert.ok(String(call('qq_send_voice')).includes('step_1 is mandatory'), '未读人设发语音被拦截');
console.log('PASS: 开局硬门禁');

console.log('=== 校验 3：载入人设后，同回合可以连续发（文字 + 表情包 + 语音）===');
assert.equal(call('qq_load_persona'), undefined, 'qq_load_persona 放行');
assert.equal(sessionPersonaTurn.get(sess), true, '本回合已标记载入');

assert.equal(call('qq_send_message'), undefined, '第一条文字放行');
assert.equal(call('qq_send_meme'), undefined, '表情包放行');
assert.equal(call('qq_send_meme'), undefined, '第二个表情包放行');
// 回归点：线上就是这一步（同回合追加一条语音）被旧逻辑当成新回合打回的
assert.equal(call('qq_send_voice'), undefined, '同回合追加语音必须放行（不得再要一次 load_persona）');
assert.equal(call('qq_send_message'), undefined, '同回合第二条文字同样放行');
assert.equal(sessionSentCount.get(sess), 3, '发送计数如实累计（表情包不算发送，只有文字与语音计）');
console.log('PASS: 同回合多气泡 / 语音连发');

console.log('=== 校验 4：发言后防狂乱收敛 ===');
const resQzone = call('qq_qzone_like');
assert.ok(resQzone && resQzone.includes('this turn\'s goal is met'), '发完消息后调空间点赞被收敛拦截');
const resSchedule = call('qq_schedule_message');
assert.ok(resSchedule && resSchedule.includes('this turn\'s goal is met'), '发完消息后调定时任务被收敛拦截');
assert.equal(call('qq_send_voice'), undefined, '收敛规则不误伤语音（只有空间/定时/搜图被限）');
console.log('PASS: 收敛门禁');

console.log('=== 校验 5：回合结束复位，新回合必须重新载入人设 ===');
turnStoppingHandlers[0]({ agent: { session: { id: sess } } });
assert.equal(sessionPersonaTurn.has(sess), false, 'turn-stopping 清掉本回合标记');
assert.ok(String(call('qq_send_message')).includes('step_1 is mandatory'), '新回合未经 load 直接发言被拦截');

assert.equal(call('qq_load_persona'), undefined, '新回合 load 放行');
assert.equal(call('qq_send_voice'), undefined, '新回合载入后语音放行');
console.log('PASS: 每回合一次开局门禁');

console.log('=== 校验 6：后台学习任务工具直接豁免 ===');
assert.equal(guardFn({ name: 'mcp__napcat-host__qq_learning_corpus', arguments: { limit: 100 } }), undefined, '学习语料工具豁免');
assert.equal(guardFn({ name: 'mcp__napcat-host__qq_learning_submit', arguments: { uid: '123456' } }), undefined, '学习提交工具豁免');
console.log('PASS: 学习任务豁免');

console.log('>>> 全部 Tool Restrict Guard 门禁测试 100% 通过！');
