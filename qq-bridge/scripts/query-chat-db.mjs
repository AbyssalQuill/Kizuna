import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';

const dbPath = '/root/qq-bridge/state/chat.db';
if (!fs.existsSync(dbPath)) {
  console.log('chat.db 不存在:', dbPath);
  process.exit(1);
}

const db = new DatabaseSync(dbPath, { readOnly: true });

// 1. 表结构
const cols = db.prepare("PRAGMA table_info(chat_messages)").all();
console.log('chat_messages columns:', cols.map(c => c.name));

const sample = db.prepare("SELECT * FROM chat_messages ORDER BY id DESC LIMIT 5").all();
console.log('Sample rows:', sample);
