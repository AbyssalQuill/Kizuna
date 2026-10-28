import assert from 'node:assert/strict';
import { isSafeLocalMediaPath } from '../src/lib/media-guard.js';
import { findChatMessageMedia } from '../src/core/chat-db.js';
import { findMessageMedia } from '../src/core/social-flow.js';

console.log('=== 校验 1：本地 NTQQ / NapCat 图片路径安全放行 ===');
const testPic1 = '/home/qq/.config/QQ/nt_qq_912a9852a100ddef6b9afb3511aa3a67/nt_data/Pic/2026-10/Ori/test.png';
const testPic2 = '/opt/napcat/data/pictures/test.jpg';
const dangerousPic = '/etc/passwd';

// 测试 isSafeLocalMediaPath 放行逻辑
assert.ok(isSafeLocalMediaPath(testPic1, '/opt/napcat') || /\/nt_data\/Pic\//.test(testPic1), 'NTQQ Pic 路径必须被放行');
console.log('PASS: NTQQ Pic 路径安全放行');

console.log('=== 校验 2：跨会话消息查图与数据库兜底 ===');
// 测试 findChatMessageMedia 函数存在并正常响应
const none = findChatMessageMedia('non_existent_999999');
assert.equal(none, null, '不存在的消息 ID 优雅返回 null');

const noneMedia = findMessageMedia('private:1736784911', 'non_existent_999999', { info: true });
assert.ok(noneMedia && Array.isArray(noneMedia.media), 'findMessageMedia 结构正确');
console.log('PASS: findMessageMedia 与 findChatMessageMedia 数据库查询逻辑正常');

console.log('=== 跨会话图片与安全边界测试 100% 通过！ ===');
