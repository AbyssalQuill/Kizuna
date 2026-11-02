import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const dbPath = path.resolve('state', 'chat.db');
const db = new DatabaseSync(dbPath);

console.log('=== LATEST 5 OUTBOUND MESSAGES ===');
const latest = db.prepare(`
  SELECT id, conv_key, content, ts 
  FROM chat_messages 
  WHERE direction = 'out' 
  ORDER BY id DESC 
  LIMIT 5
`).all();

for (const m of latest) {
  console.log(`[#${m.id} | ${m.conv_key} | ${m.ts}]`);
  console.log(`  ${m.content}`);
}
