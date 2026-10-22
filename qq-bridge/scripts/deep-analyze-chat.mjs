import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

const dbPath = '/root/qq-bridge/state/chat.db';
const db = new DatabaseSync(dbPath, { readOnly: true });

const groupKey = 'group:868756515';

// 1. 最近 120 条对话记录
const rows = db.prepare(`
  SELECT id, sender_name, sender_uid, is_self, direction, content, ts, ts_ms 
  FROM chat_messages 
  WHERE conv_key = ? 
  ORDER BY id DESC 
  LIMIT 120
`).all(groupKey);

console.log(`=== 谬友圈最近 120 条聊天记录 (正序排列) ===`);
for (const r of rows.reverse()) {
  const who = r.is_self ? '【小鲸鱼】' : `${r.sender_name || '群友'}(${r.sender_uid})`;
  console.log(`[${r.ts}] ${who}: ${r.content}`);
}

// 2. 统计谬友圈中小鲸鱼的所有发言特征（最近 200 条）
const aiRows = db.prepare(`
  SELECT id, content, ts 
  FROM chat_messages 
  WHERE conv_key = ? AND is_self = 1 
  ORDER BY id DESC 
  LIMIT 200
`).all(groupKey);

console.log(`\n=== 谬友圈小鲸鱼发言特征统计 (样本量: ${aiRows.length}) ===`);

let heiheiMatches = [];
let hahaMatches = [];
let memeMatches = [];
let burstCount = 0; // 连发气泡次数
let totalChars = 0;

for (let i = 0; i < aiRows.length; i++) {
  const c = aiRows[i].content || '';
  totalChars += c.length;
  if (/嘿嘿/i.test(c)) heiheiMatches.push({ id: aiRows[i].id, ts: aiRows[i].ts, text: c });
  if (/哈哈/i.test(c)) hahaMatches.push({ id: aiRows[i].id, ts: aiRows[i].ts, text: c });
  if (/\[(?:表情|图)\]|\[表情包:/i.test(c)) memeMatches.push({ id: aiRows[i].id, ts: aiRows[i].ts, text: c });
}

console.log(`- 平均单条字数: ${(totalChars / (aiRows.length || 1)).toFixed(1)} 字`);
console.log(`- 包含“嘿嘿”的条数: ${heiheiMatches.length}`);
console.log(`- 包含“哈哈”的条数: ${hahaMatches.length}`);
console.log(`- 包含表情包的条数: ${memeMatches.length} (${((memeMatches.length / (aiRows.length || 1)) * 100).toFixed(1)}%)`);

if (heiheiMatches.length > 0) {
  console.log('\n--- 所有包含“嘿嘿”的句子 ---');
  heiheiMatches.forEach(m => console.log(`  [${m.ts}] ${m.text}`));
}

if (memeMatches.length > 0) {
  console.log('\n--- 最近 10 条表情包发送记录 ---');
  memeMatches.slice(0, 10).forEach(m => console.log(`  [${m.ts}] ${m.text}`));
}
