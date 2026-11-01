import assert from 'node:assert/strict';
import { isSessionSilent, setSessionSilent, listSilentSessions } from '../src/lib/session-silent.js';

// 单元测试：验证指令正则匹配与归一化逻辑
const normalizeCmd = (plainContent) => {
  const cleanCmd = plainContent.replace(/^@\S+\s*/, '').trim();
  const isSlashOrBareCmd = cleanCmd.startsWith('/') || /^(?:deepsleep|start)\b/i.test(cleanCmd);
  return { cleanCmd, isSlashOrBareCmd };
};

// 1. 测试前缀剥离与命令识别
const testCases = [
  { input: '/silent', expectClean: '/silent', expectCmd: true },
  { input: '@小鲸鱼 /silent', expectClean: '/silent', expectCmd: true },
  { input: '@12345678 /silent on', expectClean: '/silent on', expectCmd: true },
  { input: '@Bot /silent off', expectClean: '/silent off', expectCmd: true },
  { input: '@小鲸鱼 /silent status', expectClean: '/silent status', expectCmd: true },
  { input: '/deepsleep', expectClean: '/deepsleep', expectCmd: true },
  { input: '@小鲸鱼 /deepsleep', expectClean: '/deepsleep', expectCmd: true },
  { input: 'deepsleep', expectClean: 'deepsleep', expectCmd: true },
  { input: '@小鲸鱼 deepsleep', expectClean: 'deepsleep', expectCmd: true },
  { input: 'deepsleep on', expectClean: 'deepsleep on', expectCmd: true },
  { input: 'deepsleep off', expectClean: 'deepsleep off', expectCmd: true },
  { input: 'deepsleep status', expectClean: 'deepsleep status', expectCmd: true },
  { input: '/start', expectClean: '/start', expectCmd: true },
  { input: '@小鲸鱼 /start', expectClean: '/start', expectCmd: true },
  { input: 'start', expectClean: 'start', expectCmd: true },
  { input: '@小鲸鱼 start', expectClean: 'start', expectCmd: true },
  { input: '@张三 今天吃什么', expectClean: '今天吃什么', expectCmd: false },
  { input: '今天天气真好', expectClean: '今天天气真好', expectCmd: false },
];

for (const tc of testCases) {
  const { cleanCmd, isSlashOrBareCmd } = normalizeCmd(tc.input);
  assert.equal(cleanCmd, tc.expectClean, `CleanCmd mismatch for "${tc.input}"`);
  assert.equal(isSlashOrBareCmd, tc.expectCmd, `isSlashOrBareCmd mismatch for "${tc.input}"`);
}

// 2. 测试指令模式命中
const testCmdPatterns = [
  // deepsleep on
  { cmd: '/deepsleep', isDeepSleepOn: true },
  { cmd: '/deepsleep on', isDeepSleepOn: true },
  { cmd: 'deepsleep', isDeepSleepOn: true },
  { cmd: 'deepsleep on', isDeepSleepOn: true },
  // deepsleep off / start
  { cmd: '/start', isDeepSleepOff: true },
  { cmd: 'start', isDeepSleepOff: true },
  { cmd: '/deepsleep off', isDeepSleepOff: true },
  { cmd: 'deepsleep off', isDeepSleepOff: true },
  { cmd: '/deepsleep stop', isDeepSleepOff: true },
  { cmd: 'deepsleep stop', isDeepSleepOff: true },
  // deepsleep status
  { cmd: '/deepsleep status', isDeepSleepStatus: true },
  { cmd: 'deepsleep status', isDeepSleepStatus: true },
  // silent on
  { cmd: '/silent', isSilentOn: true },
  { cmd: '/silent on', isSilentOn: true },
  { cmd: '/quiet', isSilentOn: true },
  { cmd: '/quiet on', isSilentOn: true },
  // silent off
  { cmd: '/silent off', isSilentOff: true },
  { cmd: '/silent stop', isSilentOff: true },
  { cmd: '/silent close', isSilentOff: true },
  // silent status
  { cmd: '/silent status', isSilentStatus: true },
  { cmd: '/quiet status', isSilentStatus: true },
];

for (const t of testCmdPatterns) {
  if (t.isDeepSleepOn) {
    assert.ok(/^(?:\/deepsleep|deepsleep)(?:\s+on)?$/i.test(t.cmd), `deepsleep on failed for ${t.cmd}`);
  }
  if (t.isDeepSleepOff) {
    assert.ok(/^(?:\/start|start)$/i.test(t.cmd) || /^(?:\/deepsleep|deepsleep)\s+(?:off|close|stop|false)$/i.test(t.cmd), `deepsleep off failed for ${t.cmd}`);
  }
  if (t.isDeepSleepStatus) {
    assert.ok(/^(?:\/deepsleep|deepsleep)\s+status$/i.test(t.cmd), `deepsleep status failed for ${t.cmd}`);
  }
  if (t.isSilentOn) {
    assert.ok(/^\/(?:silent|quiet)(?:\s+on)?$/i.test(t.cmd), `silent on failed for ${t.cmd}`);
  }
  if (t.isSilentOff) {
    assert.ok(/^\/(?:silent|quiet)\s+(?:off|close|stop|false)$/i.test(t.cmd), `silent off failed for ${t.cmd}`);
  }
  if (t.isSilentStatus) {
    assert.ok(/^\/(?:silent|quiet)\s+status$/i.test(t.cmd), `silent status failed for ${t.cmd}`);
  }
}

console.log('ALL CMD VARIANT TESTS PASSED!');
