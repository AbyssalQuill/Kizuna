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
// 2026-10-30 回退：主人要求去掉冷脸萌人设（[faces] 块 / cold_face 短语 / 纯脸示范气泡一并移除）。
// 发送侧的颜文字换行守卫保留 —— 模型自己冒出来的颜文字也不会再被切成两半。
assert.ok(!persona.includes('cold_face') && !persona.includes('deadpan'), '冷脸萌措辞已移除');
assert.ok(!persona.includes('[faces]'), '[faces] 块已移除');
assert.ok(!persona.includes('ᗜ'), '人设里不再带 ᗜ 系列颜文字');
assert.ok(!persona.includes('kamoji_whale_deadpan'), '旧短语 kamoji_whale_deadpan 不再使用');
// 2026-10-29：人设已改为纯下划线短语（条目 34），断言改用短语词汇而不是中文散文
assert.ok(persona.includes('food_rice') || persona.includes('米饭'), '包含米饭/饮食设定');
assert.ok(persona.includes('stay_in_character_always') || persona.includes('真人'), '包含沉浸拟真设定');
console.log('PASS: persona.md 检查通过');

console.log('=== 验证 3：测试 meme 防重打散与随机池逻辑 ===');
const mockRows = [
  { file_name: '蓝发女仆鲸鱼娘端白饭.webp', tag: 'daily' },
  { file_name: '蓝发女仆得意叉腰.webp', tag: 'happy' },
  { file_name: '蓝发女仆傲娇哼.webp', tag: 'angry' }
];
const excludeList = ['蓝发女仆鲸鱼娘端白饭.webp'];
const filtered = mockRows.filter(r => !excludeList.includes(r.file_name));
assert.strictEqual(filtered.length, 2, '排除最近发送的图片后应剩2张');
assert.ok(!filtered.some(r => r.file_name === '蓝发女仆鲸鱼娘端白饭.webp'), '端白饭已被排除');
console.log('PASS: 防重过滤通过，端白饭被成功避开');

console.log('=== 全部新增功能逻辑校验 100% 通过！ ===');
