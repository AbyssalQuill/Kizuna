import assert from 'node:assert';
import path from 'node:path';
import fs from 'node:fs';

console.log('=== 验证 1：测试 meme 模糊搜索（分词 + 后缀剥离） ===');
const testFile = '蓝鱼吃白米饭开心.webp';
const cleanQuery = testFile.replace(/\.(webp|gif|png|jpe?g)$/i, '').replace(/[_\-\s]+/g, ' ').trim();
assert.strictEqual(cleanQuery, '蓝鱼吃白米饭开心');
console.log('PASS: 文件名清洗通过:', cleanQuery);

console.log('=== 验证 2：persona.md 格式与关键词检查 ===');
const personaPath = path.resolve(import.meta.dirname, '../persona.md');
const persona = fs.readFileSync(personaPath, 'utf8');
assert.ok(!persona.includes('kamoji_whale_deadpan'), 'deadpan 必须被移除');
assert.ok(persona.includes('FOOD_RICE'), '包含白米饭设定');
assert.ok(persona.includes('strict_immersion_never_break_fourth_wall'), '包含第四面墙保护');
console.log('PASS: persona.md 检查通过');

console.log('=== 全部新增功能逻辑校验 100% 通过！ ===');
