// 图片字节磁盘缓存（2026-10-31）
// ── 为什么要有它（真机证据）──────────────────────────────────────────────
//   journalctl 里同一条消息，几分钟后模型再去看，三种失败：
//     18:41:16 get_image 解析失败: file not found
//     18:41:17 图片 URL 抓取失败：HTTP 400        （multimedia.nt.qq.com.cn 的 rkey 过期）
//     18:46:39 get_image 解析失败: get_image 响应超时
//     18:46:41 图片 URL 抓取失败：HTTP 404        （表情包 gxh.vip.qq.com，链接已失效）
//   最后都退化成 [image_lost] [no_image_content]，模型只能说"这边没加载出来"。
//   根因不是抓取代码写错，而是**抓取时机**：QQ 的图片直链有效期很短，
//   等模型想到要看时（常常是同一回合的后半段、或者下一条消息）链接已经死了。
// ── 做法 ────────────────────────────────────────────────────────────────
//   消息刚收到的那一刻就把字节抓下来存盘（prewarm），后面无论什么时候读都先查缓存。
//   缓存键 = sha1(media.file + '|' + media.url)，这两个字段在消息元数据里是稳定的，
//   不依赖会过期的签名参数 —— 所以即使链接换了签名，只要 file 相同就能命中。
//   存储：state/media-cache/<key>.<ext>，按 mtime 做 LRU，超过上限就删最旧的。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from '../lib/paths.js';
import { log } from '../lib/log.js';

const DIR = path.join(STATE_DIR, 'media-cache');
const MAX_FILES = 600;
const MAX_TOTAL_BYTES = 320 * 1024 * 1024; // 320MB 上限，超出按最旧优先删

const EXT_BY_MIME = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/bmp': 'bmp',
};

function ensureDir() {
  try { fs.mkdirSync(DIR, { recursive: true }); } catch { /* 已存在 */ }
}

/** 稳定缓存键：只用 file 与 url 两个字段（签名参数变化不影响 file）。 */
export function cacheKeyOf(media) {
  const file = String(media?.file ?? '').trim();
  const url = String(media?.url ?? '').trim();
  if (!file && !url) return '';
  // url 里去掉查询串（rkey/term 这类参数每次都会变，不能进键）
  const urlStable = url.split('?')[0];
  return crypto.createHash('sha1').update(file + '|' + urlStable).digest('hex').slice(0, 24);
}

function findFile(key) {
  ensureDir();
  for (const ext of Object.values(EXT_BY_MIME)) {
    const p = path.join(DIR, key + '.' + ext);
    try { if (fs.statSync(p).isFile()) return p; } catch { /* 不存在 */ }
  }
  return '';
}

function mimeFromFile(p) {
  const ext = path.extname(p).slice(1).toLowerCase();
  for (const [mime, e] of Object.entries(EXT_BY_MIME)) if (e === ext) return mime;
  return 'image/jpeg';
}

/** 读缓存；命中返回 { buffer, mimeType }，未命中返回 null。 */
export function readCachedMedia(media) {
  const key = cacheKeyOf(media);
  if (!key) return null;
  const p = findFile(key);
  if (!p) return null;
  try {
    const buffer = fs.readFileSync(p);
    if (!buffer.length) return null;
    // 命中即刷新 mtime，实现"最近用过的留着"
    try { const now = new Date(); fs.utimesSync(p, now, now); } catch { /* 忽略 */ }
    return { buffer, mimeType: mimeFromFile(p) };
  } catch {
    return null;
  }
}

/** 写缓存（同步写，体积上限内；失败只记日志，绝不影响发送/识图主流程）。 */
export function writeCachedMedia(media, buffer, mimeType) {
  try {
    if (!buffer || !buffer.length) return false;
    if (buffer.length > MAX_TOTAL_BYTES) return false;
    const key = cacheKeyOf(media);
    if (!key) return false;
    ensureDir();
    const ext = EXT_BY_MIME[String(mimeType || '').toLowerCase()] || 'jpg';
    const p = path.join(DIR, key + '.' + ext);
    if (fs.existsSync(p)) return true; // 已有同名（同内容），不重复写
    fs.writeFileSync(p, buffer);
    maybePrune();
    return true;
  } catch (e) {
    log('[media-cache] 写入失败（忽略）: ' + (e?.message ?? e));
    return false;
  }
}

let lastPrune = 0;
function maybePrune() {
  const now = Date.now();
  if (now - lastPrune < 60_000) return; // 一分钟最多整理一次
  lastPrune = now;
  prune();
}

/** 按 mtime 从旧到新删，直到文件数与总体积都在上限内。 */
export function prune() {
  try {
    const names = fs.readdirSync(DIR);
    const entries = [];
    let total = 0;
    for (const n of names) {
      const p = path.join(DIR, n);
      try {
        const st = fs.statSync(p);
        if (!st.isFile()) continue;
        entries.push({ p, mtime: st.mtimeMs, size: st.size });
        total += st.size;
      } catch { /* 跳过 */ }
    }
    if (entries.length <= MAX_FILES && total <= MAX_TOTAL_BYTES) return;
    entries.sort((a, b) => a.mtime - b.mtime);
    for (const e of entries) {
      if (entries.length <= MAX_FILES && total <= MAX_TOTAL_BYTES) break;
      try { fs.unlinkSync(e.p); entries.length -= 1; total -= e.size; } catch { /* 忽略 */ }
    }
  } catch { /* 目录还不存在 */ }
}

/** 诊断用：缓存条目数与总体积。 */
export function mediaCacheStats() {
  try {
    const names = fs.readdirSync(DIR);
    let total = 0;
    for (const n of names) {
      try { total += fs.statSync(path.join(DIR, n)).size; } catch { /* 忽略 */ }
    }
    return { files: names.length, bytes: total };
  } catch {
    return { files: 0, bytes: 0 };
  }
}
