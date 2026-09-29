/* ── 按会话静默（2026-09-29 修「`/silent` 把机器人整体静默」）──────────────────────
 * 事故原话：「`/silent` 指令有误，应该是单个会话静默而不是所有会话甚至是私聊，修复」。
 *
 * 旧实现：`/silent` 只写 `state/current-role.json` 的 `mode:"silent"`，而那个字段是**全局**的
 * ——两个读取点（`core/mux.js` 入站闸门、`core/audit.js` 出站闸门）都只看这一个布尔值、
 * 不看会话 key，于是「在 A 群发一句 /silent」= 所有群 + 所有私聊一起闭嘴。
 *
 * 现在：`/silent` 只写本模块的按会话存储（`state/silent-sessions.json`），
 *   { "group:123456": { "since": 1759140000000, "by": "10001" }, ... }
 * 一处为真只静默那一个会话，别的群/私聊完全不受影响。
 *
 * `current-role.json` 的 `mode:"silent"` **保留读取兼容**（管理端的角色模式开关、
 * 以及升级前 `/silent` 留下的旧值仍在生产上跑着，不能让它突然失效），语义固定为
 * 「所有会话都静默（私聊里的主人除外）」，且**不再由任何 QQ 指令写入**。
 */
import path from 'node:path';
import { STATE_DIR } from './paths.js';
import { readJsonSafe, atomicWriteJson } from './json-fs.js';

export const SILENT_SESSIONS_FILE = path.join(STATE_DIR, 'silent-sessions.json');

/** 归一化：容错掉手改出来的 `{"group:1": 12345}`（时间戳直写）这种形态。 */
function normalizeStore(store) {
  const out = {};
  if (store && typeof store === 'object' && !Array.isArray(store)) {
    for (const [key, val] of Object.entries(store)) {
      const k = String(key ?? '').trim();
      if (!k) continue;
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        out[k] = {
          since: Number(val.since) || 0,
          by: val.by == null ? null : String(val.by)
        };
      } else {
        out[k] = { since: Number(val) || 0, by: null };
      }
    }
  }
  return out;
}

/** 读整份按会话静默表（持久化在 state/silent-sessions.json，重启桥后仍生效）。 */
export function readSilentSessions() {
  return normalizeStore(readJsonSafe(SILENT_SESSIONS_FILE, {}));
}

/** 该会话是否被静默（只看按会话存储；全局兼容判定见 audit.js / mux.js）。 */
export function isSessionSilent(key) {
  const k = String(key ?? '').trim();
  if (!k) return false;
  return Object.prototype.hasOwnProperty.call(readSilentSessions(), k);
}

/** 开/关单个会话的静默；返回写入后的完整清单（便于回执里说清"现在一共静默了几个会话"）。 */
export function setSessionSilent(key, on, meta = {}) {
  const k = String(key ?? '').trim();
  if (!k) return { ok: false, error: '缺少会话 key' };
  const store = readSilentSessions();
  if (on) {
    if (!store[k]) store[k] = { since: Date.now(), by: meta.by == null ? null : String(meta.by) };
  } else {
    delete store[k];
  }
  atomicWriteJson(SILENT_SESSIONS_FILE, store);
  return { ok: true, key: k, silent: !!on, changed: true, sessions: Object.keys(store) };
}

/** 列出当前被静默的会话（管理端/`/status` 可查）。 */
export function listSilentSessions() {
  return Object.entries(readSilentSessions())
    .map(([key, v]) => ({ key, since: v.since || 0, by: v.by ?? null }))
    .sort((a, b) => a.since - b.since);
}
