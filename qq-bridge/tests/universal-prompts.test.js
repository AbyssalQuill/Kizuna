import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripOverrideBlock } from '../src/lib/preset-compose.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

console.log('=== 校验 1：agent.cordis.yml 系统预设骨架 100% 通用化 ===');
const presetFile = path.join(root, 'dsh', 'agent-presets', 'qq-chat', 'agent.cordis.yml');
const presetContent = fs.readFileSync(presetFile, 'utf8');
const baseSkeleton = stripOverrideBlock(presetContent);

assert.ok(baseSkeleton.includes('pure_in_character') || baseSkeleton.includes('role_rp_agent'), '系统提示词采用精简下划线短语规范');
assert.ok(baseSkeleton.includes('qq_send_message'), '包含发消息工具协议');
assert.ok(!baseSkeleton.includes('[对话风格示范]'), '严禁包含风格示范');

// 严禁在底座骨架中包含特定角色硬编码
const forbiddenTerms = ['小鲸鱼', '鲸鱼娘', '小娇妻', '触感微凉', '尾鳍', 'AbyssalQuill', '冷脸萌', 'ᗜ系列', '1736784911'];
for (const term of forbiddenTerms) {
  assert.ok(!baseSkeleton.includes(term), `系统预设底座骨架中严禁包含特定角色词汇: ${term}`);
}
console.log('PASS: agent.cordis.yml 骨架完全通用且无任何特定角色残留');

console.log('=== 校验 2：config.js 默认样式行通用化 ===');
import { loadConfig } from '../src/core/config.js';
const cfg = loadConfig();
assert.ok(cfg.prompt?.styleLine, 'styleLine 存在');
assert.ok(!cfg.prompt.styleLine.includes('冷脸萌'), 'styleLine 不含冷脸萌');
assert.ok(!cfg.prompt.styleLine.includes('ᗜ系列'), 'styleLine 不含ᗜ系列');
const recKw = cfg.wake?.interject?.recommendedKeywords || cfg.wake?.recommendedKeywords || [];
assert.ok(Array.isArray(recKw), 'recommendedKeywords 为数组');
assert.ok(!recKw.includes('小鲸鱼'), 'recommendedKeywords 不包含写死的小鲸鱼');
console.log('PASS: config.js styleLine 与 recommendedKeywords 完全通用化');

console.log('=== 校验 3：preset-compose.js 兜底文本通用化 ===');
import { buildOverrideBlock } from '../src/lib/preset-compose.js';
const emptyBlock = buildOverrideBlock({ persona: '', speechRules: '' });
assert.ok(!emptyBlock.includes('主人还没有上传人设'), '兜底文本已去除特定主人称谓');
assert.ok(!emptyBlock.includes('主人还没有写发言规则'), '兜底文本已去除特定主人称谓');
assert.ok(emptyBlock.includes('尚未指定专属人设'), '包含通用伴侣兜底');
console.log('PASS: preset-compose.js 兜底文本完全通用化');

console.log('=== 校验 4：wake-send.js 话题唤醒正则通用化 ===');
import { TOPIC_WAKE_RE } from '../src/core/wake-send.js';
assert.ok(!TOPIC_WAKE_RE.test('小鲸鱼'), '话题正则不再写死小鲸鱼');
assert.ok(!TOPIC_WAKE_RE.test('大肥鱼'), '话题正则不再写死大肥鱼');
assert.ok(TOPIC_WAKE_RE.test('这个大模型怎么样'), '通用 AI / 大模型关键词正常触发');
assert.ok(TOPIC_WAKE_RE.test('deepseek 的新功能'), '通用深度求索 / deepseek 正常触发');
console.log('PASS: wake-send.js 话题唤醒正则完全通用化');

console.log('=== 校验 5：social-timeline.js AI 挑战检测通用化 ===');
import { isDirectedAtAi } from '../src/lib/social-timeline.js';
assert.ok(isDirectedAtAi('你这机器人不行啊'), '通用机器人关键词被正确识别');
assert.ok(!isDirectedAtAi('今天天气真好'), '普通消息不被误判为针对 AI');
console.log('PASS: social-timeline.js 通用化识别正常');

console.log('=== 校验 6：persona-learn.js 学习提示词通用化 ===');
import { buildPersonaPrompt } from '../src/core/persona-learn.js';
const pPrompt = buildPersonaPrompt('123456', []);
assert.ok(!pPrompt.includes('小鲸鱼'), '学习提示词不包含小鲸鱼');
assert.ok(!pPrompt.includes('鱼尾巴'), '学习提示词不包含鱼尾巴');
console.log('PASS: persona-learn.js 学习提示词完全通用化');

console.log('\n>>> 全部 6 项通用化严格校验 100% 通过！');
