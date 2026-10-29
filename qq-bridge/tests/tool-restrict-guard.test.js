import assert from 'node:assert/strict';
import {
  apply,
  sessionLoadedPersona,
  sessionSentMessage,
  sessionPersonaTurn,
  sessionContextAt,
  sessionSentCount
} from '../dsh/agent-presets/qq-chat/qq-tool-restrict.mjs';

console.log('=== 校验 1：白名单与 Token 防呆 ===');
let guardFn = null;
const fakeCtx = {
  tools: {
    restrict: () => {},
    guard: (fn) => { guardFn = fn; }
  }
};

apply(fakeCtx);
assert.ok(typeof guardFn === 'function', 'guard 必须成功注册');
// 2026-10-29 第二次修：不再依赖 agent/turn-stopping（dsh-qq-hold 会把回合吊住，钩子提前触发 → 误伤），
// 所以 ctx 没有 on() 也必须能正常注册。

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
  for (const m of [sessionLoadedPersona, sessionSentMessage, sessionPersonaTurn, sessionContextAt, sessionSentCount]) m.delete(sess);
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

console.log('=== 校验 3：载入人设 + 读过上下文后，同回合可以连续发 ===');
assert.equal(call('qq_load_persona'), undefined, 'qq_load_persona 放行');
assert.ok(Number(sessionPersonaTurn.get(sess)) > 0, '记录本次载入的时刻');

// 2026-10-29 新增门禁：唤醒正文不带转录、读工具结果回合末被剪 → 发送前必须新鲜读过上下文
assert.ok(String(call('qq_send_message')).includes('step_3 is mandatory'), '没读上下文就发送被拦截');
assert.equal(call('qq_get_recent_messages'), undefined, 'qq_get_recent_messages 放行');
assert.ok(Number(sessionContextAt.get(sess)) > 0, '记录上下文读取时刻');

assert.equal(call('qq_send_message'), undefined, '第一条文字放行');
assert.equal(call('qq_send_meme'), undefined, '表情包放行');
assert.equal(call('qq_send_meme'), undefined, '第二个表情包放行');
// 回归点：线上就是这一步（同回合追加一条语音）被旧逻辑当成新回合打回的
assert.equal(call('qq_send_voice'), undefined, '同回合追加语音必须放行（不得再要一次 load_persona）');
assert.equal(call('qq_send_message'), undefined, '同回合第二条文字同样放行');
assert.equal(sessionSentCount.get(sess), 5, '发送计数如实累计（文字 / 语音 / 表情包都算一次发送）');
console.log('PASS: 同回合多气泡 / 语音连发');

console.log('=== 校验 4：发言后防狂乱收敛 ===');
const resQzone = call('qq_qzone_like');
assert.ok(resQzone && resQzone.includes('this turn\'s goal is met'), '发完消息后调空间点赞被收敛拦截');
const resSchedule = call('qq_schedule_message');
assert.ok(resSchedule && resSchedule.includes('this turn\'s goal is met'), '发完消息后调定时任务被收敛拦截');
assert.equal(call('qq_send_voice'), undefined, '收敛规则不误伤语音（只有空间/定时/搜图被限）');
console.log('PASS: 收敛门禁');

console.log('=== 校验 5：人设过期（超过 30 分钟）后必须重新载入 ===');
// 回归点：旧版靠 turn-stopping 复位，而 dsh-qq-hold 会让钩子提前触发 → 真回合里被误判。
// 现在只看"载入时刻是否新鲜"，跟回合事件无关。
sessionPersonaTurn.set(sess, Date.now() - 31 * 60 * 1000);
assert.ok(String(call('qq_send_message')).includes('step_1 is mandatory'), '人设过期后发送被拦');

assert.equal(call('qq_load_persona'), undefined, '重新 load 放行');
assert.equal(call('qq_send_voice'), undefined, '载入后语音放行');

// 刚载入 29 分钟 → 仍算新鲜，不能误伤（线上四个打回回合就是这个场景）
sessionPersonaTurn.set(sess, Date.now() - 29 * 60 * 1000);
assert.equal(call('qq_send_message'), undefined, '29 分钟内连续对话一律放行');

// 上下文过期（>20 分钟）→ 要求重读；重读后恢复
sessionContextAt.set(sess, Date.now() - 21 * 60 * 1000);
assert.ok(String(call('qq_send_message')).includes('step_3 is mandatory'), '上下文过期后发送被拦');
assert.equal(call('qq_get_unread_messages'), undefined, '读未读也可恢复');
assert.equal(call('qq_send_message'), undefined, '重读后放行');
console.log('PASS: 人设新鲜度门禁');

console.log('=== 校验 6：后台学习任务工具直接豁免 ===');
assert.equal(guardFn({ name: 'mcp__napcat-host__qq_learning_corpus', arguments: { limit: 100 } }), undefined, '学习语料工具豁免');
assert.equal(guardFn({ name: 'mcp__napcat-host__qq_learning_submit', arguments: { uid: '123456' } }), undefined, '学习提交工具豁免');
console.log('PASS: 学习任务豁免');

console.log('>>> 全部 Tool Restrict Guard 门禁测试 100% 通过！');
