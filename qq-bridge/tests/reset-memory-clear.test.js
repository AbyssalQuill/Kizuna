import assert from 'node:assert/strict';
import { getSocialState, resetConversationKeepingLedger, social, initSocialCore } from '../src/core/social-state.js';
import { messageMediaStore } from '../src/core/session-state.js';
import { initModeCore } from '../src/core/mode.js';

const cfg = { ownerQQ: '1736784911', allow: {}, deny: {}, allowAllWhenEmpty: true, social: { wake: {} } };
initSocialCore(cfg);
initModeCore(cfg);

const KEY = 'private:1736784911';

// 1. 模拟一个有大量内存消息和未读的活跃会话
const st = getSocialState(KEY);
st.recentMessages = [
  { seq: 1, messageId: '1001', time: Date.now() - 50000, text: '旧消息1', sender: '主人' },
  { seq: 2, messageId: '1002', time: Date.now() - 40000, text: '旧消息2', sender: '主人' }
];
st.unread = [
  { seq: 2, messageId: '1002', time: Date.now() - 40000, text: '旧消息2', sender: '主人' }
];
st.turnSeenUnread = [2];
st.pendingUndeliveredText = '未投递草稿';
st._undeliveredAt = Date.now() - 10000;
st._mediaAttachedSeq = 2;
st.activeTopics = [{ text: '旧话题' }];
st.pendingThoughts = ['旧想法'];
st.answeredMessageIds = ['1001'];
st.lastUnreadSeq = 2;
st.lastDeliveredSeq = 2;
st._wakeIntendedSeq = 2;

// 模拟媒体存储
const mediaMap = new Map();
mediaMap.set('1002', [{ kind: 'image', file: 'test.jpg' }]);
messageMediaStore.set(KEY, mediaMap);

console.log('测试 1: reset 前状态验证');
assert.equal(st.recentMessages.length, 2);
assert.equal(st.unread.length, 1);
assert.equal(messageMediaStore.has(KEY), true);

console.log('测试 2: 执行 resetConversationKeepingLedger(KEY)');
const beforeReset = Date.now();
const carried = resetConversationKeepingLedger(KEY);

// 验证返回的账本
assert.ok(carried);
assert.deepEqual(carried.patch.answeredMessageIds, ['1001']);
assert.equal(carried.patch.lastUnreadSeq, 2);
assert.equal(carried.patch.lastDeliveredSeq, 2);
assert.equal(carried.patch._wakeIntendedSeq, 2);

// 验证重置后全新的会话状态
const freshSt = getSocialState(KEY);
assert.deepEqual(freshSt.recentMessages, [], 'recentMessages 必须被彻底清空为 []');
assert.deepEqual(freshSt.unread, [], 'unread 必须被彻底清空为 []');
assert.deepEqual(freshSt.turnSeenUnread, [], 'turnSeenUnread 必须清空');
assert.equal(freshSt.pendingUndeliveredText, '', '未发送草稿必须清空');
assert.equal(freshSt._undeliveredAt, 0);
assert.equal(freshSt._mediaAttachedSeq, 0);
assert.deepEqual(freshSt.activeTopics, []);
assert.deepEqual(freshSt.pendingThoughts, []);
assert.equal(messageMediaStore.has(KEY), false, 'messageMediaStore 必须被清除');
assert.ok(freshSt._resetAt >= beforeReset, '_resetAt 时间戳必须被记录');
assert.ok(freshSt.lastAiSeenAt >= beforeReset, 'lastAiSeenAt 水位必须推进到 reset 时间');

console.log('ALL PASS: reset 清除桥内存消息验证通过！');
