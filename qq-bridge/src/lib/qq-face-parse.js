// 表情/图片占位符 → QQ 原生 face、内置同人表情包及收藏表情的解析工具
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resolveFaceRef } from '../qq-faces.js';

// 从占位内容里提取 QQ 原生 face id（如 [表情:害羞(148)] → 148；[QQ表情:148] → 148）
export function faceIdFromArtifactContent(content) {
  const c = String(content ?? '').replace(/^[^:：]*[:：]?\s*/, '').trim();
  const num = /(?:^|[（(])(\d{1,4})(?:[）)]|$)/.exec(c);
  if (num) {
    const id = Number(num[1]);
    if (id >= 0 && id <= 999) return id;
  }
  return null;
}

// 占位内容按名字解析 face（如 [QQ表情:旺柴] / [表情:狗头] → 真 QQ 原生表情）
export function resolveArtifactFaceId(content) {
  const numeric = faceIdFromArtifactContent(content);
  if (numeric != null) return numeric;
  const name = String(content ?? '')
    .replace(/^[^:：]*[:：]?\s*/, '')        // 去前缀（QQ表情: / 表情: …）
    .replace(/\s*[（(]?\d{1,4}[）)]?\s*$/, '') // 去尾部 (id)
    .trim();
  if (!name) return null;
  try {
    const f = resolveFaceRef(name);
    if (f && f.id != null && Number(f.id) >= 0) return Number(f.id);
  } catch {}
  return null;
}

/**
 * 占位内容按语义/关键词解析内置表情包（whale-fanart-001/index.db）
 * 返回真实图片绝对路径 { file, caption } 或 null
 */
export function resolveArtifactMeme(content, memeRoot = '/root/whale-fanart-001') {
  if (!content) return null;
  const raw = String(content).replace(/^[^:：]*[:：]?\s*/, '').trim();
  if (!raw) return null;
  const dbPath = path.join(memeRoot, 'index.db');
  if (!fs.existsSync(dbPath)) return null;
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      // 1. 全词匹配
      let row = db.prepare('SELECT path, caption FROM memes WHERE caption LIKE ? OR keywords LIKE ? OR file_name LIKE ? LIMIT 1').get(`%${raw}%`, `%${raw}%`, `%${raw}%`);
      if (row?.path) {
        const full = path.join(memeRoot, row.path);
        if (fs.existsSync(full)) return { file: full, caption: row.caption };
      }
      // 2. 分词匹配（去除助词后长于2字的核心词）
      const words = raw.split(/[\s,，、/]+/).map((w) => w.trim()).filter((w) => w.length >= 2);
      for (const w of words) {
        row = db.prepare('SELECT path, caption FROM memes WHERE caption LIKE ? OR keywords LIKE ? OR file_name LIKE ? LIMIT 1').get(`%${w}%`, `%${w}%`, `%${w}%`);
        if (row?.path) {
          const full = path.join(memeRoot, row.path);
          if (fs.existsSync(full)) return { file: full, caption: row.caption };
        }
      }
    } finally {
      try { db.close(); } catch {}
    }
  } catch {}
  return null;
}

/**
 * 占位内容按语义/关键词解析 QQ 收藏表情（stickers.json）
 * 返回命中条目 { faceId, url, name, desc, localNote } 或 null
 */
export function resolveArtifactCustomSticker(content, stickersJsonPath) {
  if (!content || !stickersJsonPath || !fs.existsSync(stickersJsonPath)) return null;
  const raw = String(content).replace(/^[^:：]*[:：]?\s*/, '').trim();
  if (!raw) return null;
  try {
    const list = JSON.parse(fs.readFileSync(stickersJsonPath, 'utf8'));
    if (!Array.isArray(list)) return null;
    const words = [raw, ...raw.split(/[\s,，、/]+/).map((w) => w.trim()).filter((w) => w.length >= 2)];
    for (const w of words) {
      const hit = list.find((s) => {
        const text = `${s.localNote ?? ''} ${s.desc ?? ''} ${s.name ?? ''} ${(s.tags ?? []).join(' ')}`.toLowerCase();
        return text.includes(w.toLowerCase());
      });
      if (hit) return hit;
    }
  } catch {}
  return null;
}
