import assert from 'node:assert/strict';
import { apply, sessionLoadedPersona, sessionSentMessage } from '../dsh/agent-presets/qq-chat/qq-tool-restrict.mjs';

console.log('=== 校验 1：防呆拦截——严禁把 Token / 纯数字当成工具名调用 ===');
let guardFn = null;
const fakeCtx = {
  tools: {
    restrict: () => {},
    guard: (fn) => { guardFn = fn; }
  }
};

apply(fakeCtx);
assert.ok(typeof guardFn === 'function', 'guard 必须成功注册');

// 测试直接调用纯数字工具
const resNum = guardFn({ name: '1736784911' });
assert.ok(resNum && resNum.includes('是会话鉴权 Token 参数，不是工具名'), '纯数字工具名被精准拦截');

// 测试通过 napcat_invoke_tool 传入纯数字 tool_name
const resInvokeNum = guardFn({
  name: 'mcp__napcat__napcat_invoke_tool',
  arguments: { tool_name: '1736784911' }
});
assert.ok(resInvokeNum && resInvokeNum.includes('是会话鉴权 Token 参数，不是工具名'), 'invoke 包装下的纯数字被精准拦截');
console.log('PASS: 纯数字 Token 拦截测试通过');

console.log('=== 校验 2：物理硬门禁——未调用 qq_load_persona 严禁发消息 ===');
const testSess = 'test-sess-guard-1';
sessionLoadedPersona.delete(testSess);
sessionSentMessage.delete(testSess);

// 未读人设直接尝试发消息
const resBlocked = guardFn({
  name: 'mcp__napcat__qq_send_message',
  agent: { session: { id: testSess } }
});
assert.ok(resBlocked && resBlocked.includes('必须严格执行 step_1，先调用 qq_load_persona'), '未读人设直接发消息被物理硬门禁拦截');

// 压缩代理下的直接发消息同样被拦截
const resBlockedInvoke = guardFn({
  name: 'mcp__napcat__napcat_invoke_tool',
  arguments: { tool_name: 'qq_send_message' },
  agent: { session: { id: testSess } }
});
assert.ok(resBlockedInvoke && resBlockedInvoke.includes('必须严格执行 step_1，先调用 qq_load_persona'), '压缩代理下未读人设同样被拦截');
console.log('PASS: 开局未读人设硬门禁拦截测试通过');

console.log('=== 校验 3：调用 qq_load_persona 后发消息顺利放行 ===');
// 执行读人设
const resLoad = guardFn({
  name: 'mcp__napcat__qq_load_persona',
  agent: { session: { id: testSess } }
});
assert.equal(resLoad, undefined, 'qq_load_persona 执行必须放行');
assert.ok(sessionLoadedPersona.has(testSess), '人设状态已被记录');

// 再次调用发消息，顺利放行
const resSend = guardFn({
  name: 'mcp__napcat__qq_send_message',
  agent: { session: { id: testSess } }
});
assert.equal(resSend, undefined, '加载人设后发消息顺利放行');
assert.ok(sessionSentMessage.has(testSess), '发消息状态已被记录');
console.log('PASS: 加载人设后发消息正常放行');

console.log('=== 校验 4：发消息后防狂乱收敛——禁止调用无关空间/定时/盲目搜图工具 ===');
const resQzone = guardFn({
  name: 'mcp__napcat__napcat_invoke_tool',
  arguments: { tool_name: 'qq_qzone_like' },
  agent: { session: { id: testSess } }
});
assert.ok(resQzone && resQzone.includes('交流闭环已达成！禁止继续调用多余工具'), '发完消息后调用空间点赞被收敛拦截');

const resSchedule = guardFn({
  name: 'mcp__napcat__napcat_invoke_tool',
  arguments: { tool_name: 'qq_schedule_message' },
  agent: { session: { id: testSess } }
});
assert.ok(resSchedule && resSchedule.includes('交流闭环已达成！禁止继续调用多余工具'), '发完消息后调用定时任务被收敛拦截');
console.log('PASS: 发消息后收敛门禁测试通过');

console.log('>>> 全部 Tool Restrict Guard 门禁测试 100% 通过！');
