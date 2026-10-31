import assert from 'node:assert/strict';
import { canonicalKey } from './src/lib/keys.js';
import { isSessionAllowedInCurrentMode, initModeCore } from './src/core/mode.js';
import { loadConfig } from './src/core/config.js';

console.log('=== User Incident Auto-Repair Regression Test ===');

const cfg = loadConfig();
initModeCore(cfg);

// 1. 验证 canonicalKey 纯数字自愈
assert.equal(canonicalKey('1736784911'), 'private:1736784911', '纯数字必须自愈为 private:1736784911');
assert.equal(canonicalKey('private:1736784911'), 'private:1736784911');
assert.equal(canonicalKey('私聊:1736784911'), 'private:1736784911');
assert.equal(canonicalKey('group:868756515'), 'group:868756515');
assert.equal(canonicalKey('群:868756515'), 'group:868756515');
console.log('PASS 1: canonicalKey 纯数字与别名前缀自愈成功');

// 2. 验证 isSessionAllowedInCurrentMode 纯数字自愈
const allowed = isSessionAllowedInCurrentMode('1736784911');
console.log('PASS 2: isSessionAllowedInCurrentMode("1736784911") ->', allowed);
assert.equal(allowed, true, '纯数字 QQ 号必须被认定为合法会话');

console.log('ALL INCIDENT CASES PASSED SUCCESSFULLY!');
