// 长期记忆 SQLite 库（用户/群友档案 + 通用记忆）
//
// ── 2026-09-24 分家：聊天记录搬去 state/chat.db ────────────────────────────────
// chat_messages 是全库最大的表，生命周期与记忆档案完全不同：它只增不改、可按会话整段删；
// profiles / memory_entries 则少量、长期、每一轮都要注入上下文。挤在一个文件里，意味着
// "删聊天历史"等于"动记忆库"（锁竞争、写放大、备份粒度都跟着变粗）。所以现在：
//   聊天记录 → core/chat-db.js（state/chat.db，自带 chat_fts 全文索引 + chat_stats 总量计数）
//   记忆档案 → 本模块（state/memory.db）
// **调用方零改动**：下面 re-export chat-db 的聊天函数，历史 import 路径全部照旧。
// memDb 为模块级单例；群缓存（bot 依赖）暂留 main。
//
// ── 2026-09-21 记忆架构升级（v1.3.0）───────────────────────────────────────────
// 需求："升级记忆架构、档案架构，永久记忆一些东西；SQLite 储存还可以，甚至可以重构这一层。
// 增强上下文理解、语义理解，尽量永久一轮对话或混合着来，用尽一切办法压缩成本。"
//
// 这一层原来只有三个朴素表（profiles / memory_entries / chat_messages），检索全靠
// `content LIKE '%词%'` 全表扫 —— 结论有三条，全是钱和时间：
//   ① 检索慢且不准：LIKE 没有相关性排序，30 万条历史里"找上次说的那件事"要么扫全表、要么查不着；
//      模型一旦查不着就会说"我看不到更早的消息"（最贵的一种失败：用户一眼看出失忆）。
//   ② 没有轻重：一条"用户不吃香菜"和一条随口闲话躺在同一张表里，谁都不会过期、谁都不会被优先注入。
//   ③ 没有"永久"这个概念：真正想永久记住的东西，没有任何机制保证它每一轮都在。
//
// 现在的分层（都在同一个 memory.db 里，不动既有调用方）：
//   TIER permanent（永久）：pinned=1 或 category ∈ {rule, owner, identity}。永不过期，每轮注入摘要。
//   TIER durable（长期）：默认层。默认 90 天不活跃才淡出（expires_at 可显式指定）。
//   TIER working（短期）：显式 working=true 或 importance 很低的临时条目，7 天淡出。
//   检索：SQLite FTS5 trigram 全文索引（content='表名' 外部内容表 + 触发器同步）。
//     trigram 对中文是"三字滑窗"，中文子串照样命中，不需要分词器；BM25 天然给出相关性排序。
//     这就是"语义理解/上下文理解"的底座：模型说一句模糊的话，也能从三年聊天记录里捞回最相关的那几条。
//   成本：索引与触发器全部在 SQLite 内部完成（C 实现），桥侧只多一次 INSERT 的开销；
//     注入给模型的是几百字符的摘要，不是把历史塞回上下文 —— 省钱靠的是"按需检索"而不是"全都记住"。
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ROOT } from '../lib/paths.js';
import { beijingTs } from '../lib/time.js';
import { log } from '../lib/log.js';
import { ftsUsable, ftsQueryOf } from '../lib/fts.js';
import {
  BGE_DIM, bgeModelFilesReady, embedBgeAsync, getBgeCached,
  embedFallbackSync, vectorToBlob, blobToVector, cosineSimilarity,
} from '../lib/embedding.js';
// 聊天记录库（state/chat.db）：本模块只用到"总量计数 + 索引重建 + 状态"这几件事，
// 其余聊天函数通过下面的 re-export 透出给调用方。
import { chatCounters, chatDbStats, rebuildChatFts } from './chat-db.js';

export let memDb = null;

// ── 长期记忆 SQLite 库（用户/群友档案 + 通用记忆） ─────────────────────────
export function initMemoryDb() {
  if (memDb) return memDb;
  try {
    const dir = path.join(ROOT, 'state');
    fs.mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(path.join(dir, 'memory.db'));
    db.exec(`CREATE TABLE IF NOT EXISTS profiles (
      uid TEXT PRIMARY KEY,
      name TEXT DEFAULT '',
      personality TEXT DEFAULT '',
      likes TEXT DEFAULT '',
      dislikes TEXT DEFAULT '',
      birthday TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      updated_at INTEGER DEFAULT 0
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS memory_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uid TEXT NOT NULL,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER DEFAULT 0
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_mem_uid ON memory_entries(uid, category)');
    // 聊天记录（chat_messages 建表 / 四个索引 / 幂等去重 / 消息 id 唯一索引）自 2026-09-24 起
    // 归 state/chat.db，见 core/chat-db.js 的 initChatDb()；本库只管记忆档案，不再碰那张表。
    memDb = db;
    ensureMemoryIndex(db);
    log('[memory] SQLite 记忆库已初始化');
    return db;
  } catch (error) {
    log(`[memory] SQLite 初始化失败（不影响主流程）: ${error?.message ?? error}`);
    return null;
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * 记忆分层 + 全文检索（v1.3.0）
 * ══════════════════════════════════════════════════════════════════════════ */

/** 记忆层级 → 默认存活时长（ms）。0 = 永不过期。 */
export const MEMORY_TIERS = { permanent: 0, durable: 90 * 24 * 3600 * 1000, working: 7 * 24 * 3600 * 1000 };
/** 这些 category 天然属于"永久"（约定的规则 / 账号本人 / 身份设定）—— 不需要显式 pin 也不淡出。 */
export const PERMANENT_CATEGORIES = new Set(['rule', 'owner', 'identity']);
const FTS_SCHEMA_VERSION = '2';   // 索引结构一变就 +1 → 下次启动自动重建（幂等）

function tableHasColumn(db, table, col) {
  try { return db.prepare(`PRAGMA table_info(${table})`).all().some((r) => r.name === col); } catch { return false; }
}

/**
 * 建索引 / 加列 / 建触发器（幂等）。任何一步失败都只记日志、绝不阻断桥启动 ——
 * 记忆库是增强件，坏了不能把聊天一起带下水。
 */
export function ensureMemoryIndex(db = memDb) {
  if (!db) return { ok: false, error: '记忆库不可用' };
  const out = { ok: true, columns: [], fts: [], rebuilt: false };
  // ① memory_entries 补列（存量库用 ALTER，幂等）
  const cols = [
    ['pinned', 'INTEGER DEFAULT 0'],
    ['importance', 'INTEGER DEFAULT 0'],
    ['last_used_at', 'INTEGER DEFAULT 0'],
    ['hits', 'INTEGER DEFAULT 0'],
    ['expires_at', 'INTEGER DEFAULT 0'],
    ['conv_key', "TEXT DEFAULT ''"],
    ['tags', "TEXT DEFAULT ''"],
    ['source', "TEXT DEFAULT ''"],
    ['tier', "TEXT DEFAULT ''"],
    ['updated_at', 'INTEGER DEFAULT 0'],
    ['embedding', 'BLOB'],
  ];
  for (const [name, decl] of cols) {
    if (tableHasColumn(db, 'memory_entries', name)) continue;
    try { db.exec(`ALTER TABLE memory_entries ADD COLUMN ${name} ${decl}`); out.columns.push(name); } catch (e) {
      log(`[memory] memory_entries.${name} 加列失败（忽略）: ${e?.message ?? e}`);
    }
  }
  // ①b 记忆库 v1.3.0 新增：memory_meta：索引版本等元信息（一张一行的 KV 表）
  try {
    db.exec('CREATE TABLE IF NOT EXISTS memory_meta (k TEXT PRIMARY KEY, v TEXT DEFAULT \'\')');
  } catch (e) { log(`[memory] memory_meta 建表失败（忽略）: ${e?.message ?? e}`); }
  // ② 检索用索引：把"谁、哪层、什么时候用过"变成可走索引的查询
  for (const sql of [
    'CREATE INDEX IF NOT EXISTS idx_mem_tier ON memory_entries(tier, uid, pinned)',
    'CREATE INDEX IF NOT EXISTS idx_mem_conv ON memory_entries(conv_key, created_at)',
    'CREATE INDEX IF NOT EXISTS idx_mem_expire ON memory_entries(expires_at)',
  ]) { try { db.exec(sql); } catch (e) { log(`[memory] 索引创建失败 ${sql}: ${e?.message ?? e}`); } }

  // ③ FTS5 trigram 全文索引（外部内容表 + 触发器同步）。
  //    为什么用外部内容表：文本只存一份（chat_messages / memory_entries 自己），索引里只有词条指针，
  //    数据库不会膨胀一倍；内容更新靠触发器自动同步，桥侧零维护。
  const ftsDefs = [
    // 聊天记录的全文索引（chat_fts）随库搬去 core/chat-db.js 了，这里只剩记忆条目这一份；
    // rebuildMemoryFts() 会把两边一起重建，所以"全量可搜"的对外语义没有变。
    { name: 'mem_fts', src: 'memory_entries', label: '记忆条目' },
  ];
  for (const d of ftsDefs) {
    try {
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${d.name} USING fts5(content, tokenize='trigram', content='${d.src}', content_rowid='id')`);
      out.fts.push(d.name);
    } catch (e) {
      log(`[memory] ${d.name} 全文索引不可用（该库可能没编 FTS5），检索退回 LIKE: ${e?.message ?? e}`);
      continue;
    }
    // 触发器：三张表（增/删/改）与索引保持一致。DROP 再建，改定义时不会残留旧触发器。
    try {
      const that = d.name;
      const src = d.src;
      db.exec(`DROP TRIGGER IF EXISTS ${src}_fts_ai`);
      db.exec(`DROP TRIGGER IF EXISTS ${src}_fts_ad`);
      db.exec(`DROP TRIGGER IF EXISTS ${src}_fts_au`);
      db.exec(`CREATE TRIGGER ${src}_fts_ai AFTER INSERT ON ${src} BEGIN
        INSERT INTO ${that}(rowid, content) VALUES (new.id, new.content);
      END`);
      db.exec(`CREATE TRIGGER ${src}_fts_ad AFTER DELETE ON ${src} BEGIN
        INSERT INTO ${that}(${that}, rowid, content) VALUES ('delete', old.id, old.content);
      END`);
      db.exec(`CREATE TRIGGER ${src}_fts_au AFTER UPDATE OF content ON ${src} BEGIN
        INSERT INTO ${that}(${that}, rowid, content) VALUES ('delete', old.id, old.content);
        INSERT INTO ${that}(rowid, content) VALUES (new.id, new.content);
      END`);
    } catch (e) {
      log(`[memory] ${d.src} 全文索引触发器创建失败（忽略）: ${e?.message ?? e}`);
    }
  }
  // ④ 一次性的索引重建：存量库里已有几十万行，触发器只覆盖"建索引之后"的新增。
  //    放在 setTimeout(…,0) 里跑，不拖慢桥启动；重建期间检索仍可用（只是可能少看到老消息）。
  //    （不用 setImmediate：本仓库的静态作用域检查（scripts/check-scope.mjs）只开 DOM lib，
  //      setImmediate 不在其中会被判成"未定义标识符"，改用它就过不了 CI。）
  try {
    const row = db.prepare("SELECT v FROM memory_meta WHERE k = 'fts_version'").get();
    if (String(row?.v ?? '') !== FTS_SCHEMA_VERSION) {
      setTimeout(() => { try { rebuildMemoryFts({ reason: 'schema-upgrade' }); } catch { /* 已内记日志 */ } }, 0);
    }
  } catch { /* 忽略 */ }
  // ⑤ 后台异步回填存量记忆条目的 512 维 BGE 语义向量（不阻塞启动）
  if (bgeModelFilesReady()) {
    setTimeout(() => { backfillMemoryEmbeddings().catch(() => {}); }, 200);
  }
  return out;
}

/** 异步预热查询词的 512 维 BGE 向量到内存缓存，使紧随其后的同步 listMemoryEntries / memoryDigest 直接命中神经网络向量。 */
export async function warmQueryEmbedding(query) {
  if (!query || !String(query).trim()) return null;
  try { return await embedBgeAsync(String(query).trim(), { isQuery: true }); } catch { return null; }
}

/** 将单条记忆异步编码为 512 维 BGE 向量并写入 SQLite memory_entries.embedding */
async function updateEntryBgeEmbedding(id, content) {
  if (!id || !content) return;
  try {
    const vec = await embedBgeAsync(content, { isQuery: false });
    if (!vec || !memDb) return;
    const blob = vectorToBlob(vec);
    if (blob) {
      memDb.prepare('UPDATE memory_entries SET embedding = ? WHERE id = ?').run(blob, Number(id));
    }
  } catch { /* 忽略单条向量异步写入异常 */ }
}

/** 批量回填尚未生成 512 维 BGE 向量的存量记忆条目 */
export async function backfillMemoryEmbeddings({ batchSize = 200 } = {}) {
  const db = initMemoryDb();
  if (!db || !bgeModelFilesReady()) return { ok: false, updated: 0 };
  try {
    // length(embedding) != 2048 表示尚未存储 512 维 Float32 (512 * 4 = 2048 bytes) BGE 向量
    const rows = db.prepare('SELECT id, content FROM memory_entries WHERE embedding IS NULL OR length(embedding) != ? LIMIT ?')
      .all(BGE_DIM * 4, batchSize);
    if (!rows.length) return { ok: true, updated: 0 };
    let updated = 0;
    const stmt = db.prepare('UPDATE memory_entries SET embedding = ? WHERE id = ?');
    for (const r of rows) {
      const vec = await embedBgeAsync(r.content, { isQuery: false });
      if (!vec) continue;
      const blob = vectorToBlob(vec);
      if (blob) {
        stmt.run(blob, Number(r.id));
        updated += 1;
      }
    }
    if (updated > 0) log(`[memory] 已回填 ${updated} 条记忆的 bge-small-zh-v1.5 语义向量`);
    return { ok: true, updated };
  } catch (err) {
    return { ok: false, updated: 0, error: err?.message ?? String(err) };
  }
}

/** 重建全文索引（幂等；大库会跑几秒，因此只在版本变化或手动调用时执行）。
 *  记忆条目在本库重建；聊天记录那份在 state/chat.db，委托 chat-db 的 rebuildChatFts。
 *  对外仍然只暴露这一个函数：调用方（控制台接口、测试）调一次就能保证两边都能全量搜。 */
export function rebuildMemoryFts({ reason = 'manual' } = {}) {
  const db = initMemoryDb();
  const out = { ok: true, rebuilt: [] };
  if (db) {
    try {
      const t0 = Date.now();
      db.exec("INSERT INTO mem_fts(mem_fts) VALUES('rebuild')");
      out.rebuilt.push(`mem_fts(${Date.now() - t0}ms)`);
    } catch (e) {
      log(`[memory] mem_fts 重建失败（检索退回 LIKE）: ${e?.message ?? e}`);
    }
    try {
      db.prepare("INSERT INTO memory_meta (k, v) VALUES ('fts_version', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
        .run(FTS_SCHEMA_VERSION);
      db.prepare("INSERT INTO memory_meta (k, v) VALUES ('fts_rebuilt_at', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
        .run(String(Date.now()));
    } catch { /* 元信息写不进去不影响检索 */ }
    if (out.rebuilt.length) log(`[memory] 全文索引重建完成（${reason}）：${out.rebuilt.join(', ')}`);
  } else {
    out.ok = false;
    out.error = '记忆库不可用';
  }
  // 聊天记录索引：chat-db 自带 chat_meta 版本水位与重建实现
  try {
    const r = rebuildChatFts({ reason });
    if (r?.ok) out.rebuilt.push('chat_fts');
  } catch (e) {
    log(`[memory] chat_fts 重建失败（检索退回 LIKE）: ${e?.message ?? e}`);
  }
  return out;
}

/* ftsUsable / ftsQueryOf 于 2026-09-24 抽到 lib/fts.js：chat-db.js 也要用同一套规则，
 * 两份实现必然漂移（一处改分词规则、另一处忘改，症状只是"搜不到"且不报错）。
 * 这里 re-export ftsQueryOf，保持既有 import（含 tests/v13-features.test.js）不变。 */
export { ftsQueryOf };

export function getProfile(uid) {
  const db = initMemoryDb();
  if (!db || !uid) return null;
  try {
    const row = db.prepare('SELECT * FROM profiles WHERE uid = ?').get(String(uid));
    return row || null;
  } catch (error) {
    log(`[memory] 读取档案失败 ${uid}: ${error?.message ?? error}`);
    return null;
  }
}

/** 把观察到的昵称补进通讯录（只在当前为空时写，绝不覆盖已学到的/用户设过的名字）。
 *
 * 2026-09-23 修「群聊的人的 QQ 号昵称好像还无法识别」：
 * 现场诊断（服务端 state/memory.db）：`profiles` 共 23 行，有名字的只有 1 行；
 * 而 `formatContactsLine()` 是 `WHERE name != '' ... LIMIT 30`，于是注入给模型的
 * `[Contacts]` 只有账号所有者一个人。群友在消息里明明带着解析好的昵称
 * （recentMessages 里 sender="马卡龙不是南梁" / "坐忘道" / "星痕Ofter" …），
 * 但那些名字从来没有被写进 profiles —— 模型看得到号码，通讯录里却查无此人。
 * 写入时机就是每条入站消息：桥手上已经有 `event.sender.card || nickname` 与 QQ 号，
 * 顺手补一行即可，不必等画像学习跑到那个人（学习是抽样、覆盖不全，这才是根因）。 */
export function rememberContactName(uid, name) {
  const u = String(uid ?? '').trim();
  const n = String(name ?? '').trim();
  if (!u || !n) return false;
  if (!/^\d{5,12}$/.test(u)) return false;   // 只认 QQ 号
  if (/^\d+$/.test(n)) return false;         // "名字"本身就是号码 → 没有信息量
  if (n.length > 64) return false;           // 群名片不会这么长，多半是误传的正文
  const db = initMemoryDb();
  if (!db) return false;
  try {
    const cur = db.prepare('SELECT name FROM profiles WHERE uid = ?').get(u);
    if (cur && String(cur.name ?? '').trim()) return false;   // 已有名字：不动
    db.prepare(`INSERT INTO profiles (uid, name, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(uid) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`)
      .run(u, n.slice(0, 500), Date.now());
    return true;
  } catch (error) {
    log(`[memory] 补昵称失败 ${u}: ${error?.message ?? error}`);
    return false;
  }
}

export function setProfileField(uid, field, value) {
  const db = initMemoryDb();
  if (!db || !uid) return null;
  const allowed = new Set(['name', 'personality', 'likes', 'dislikes', 'birthday', 'notes']);
  if (!allowed.has(field)) throw new Error(`档案字段只能是：${[...allowed].join('/')}`);
  // 长度上限分字段：personality/notes 要装得下一整段人格画像（成文介绍上千字，
  // 旧的统一 500 会把介绍从中间切掉，界面和提示词里都只剩半句）；其它短字段保持 500。
  const cap = (field === 'personality' || field === 'notes') ? 4000 : 500;
  const clean = String(value ?? '').trim().slice(0, cap);
  try {
    db.prepare(`INSERT INTO profiles (uid, ${field}, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(uid) DO UPDATE SET ${field} = excluded.${field}, updated_at = excluded.updated_at`)
      .run(String(uid), clean, Date.now());
    return getProfile(uid);
  } catch (error) {
    log(`[memory] 写档案失败 ${uid}/${field}: ${error?.message ?? error}`);
    return null;
  }
}

function getPersonaLibraryEntrySafe(uid) {
  try {
    const f = path.join(ROOT, 'state', 'persona-library.json');
    if (!fs.existsSync(f)) return null;
    const all = JSON.parse(fs.readFileSync(f, 'utf8'));
    return all && typeof all === 'object' ? all[String(uid)] : null;
  } catch {
    return null;
  }
}

export function formatProfileText(uid) {
  const p = getProfile(uid);
  const parts = [];
  if (p?.name) parts.push(`Name:${p.name}`);
  const lib = getPersonaLibraryEntrySafe(uid);
  if (lib?.oneSentenceSummary) parts.push(`Summary:${lib.oneSentenceSummary}`);
  if (p?.personality) parts.push(`Personality:${p.personality}`);
  if (p?.likes) parts.push(`Likes:${p.likes}`);
  if (p?.dislikes) parts.push(`Dislikes:${p.dislikes}`);
  if (p?.birthday) parts.push(`Birthday:${p.birthday}`);
  if (p?.notes) parts.push(`Notes:${p.notes}`);
  return parts.length ? parts.join('; ') : '';
}

// 按 QQ 号查通讯录昵称（规范化括号别名：把 "主名（别名）" 规整成 "主名/别名"），查不到返回 null。
export function profileDisplayName(uid) {
  if (!uid) return null;
  const db = initMemoryDb();
  if (!db) return null;
  try {
    const row = db.prepare("SELECT name FROM profiles WHERE uid = ? AND name != '' ORDER BY updated_at DESC LIMIT 1").get(String(uid));
    if (!row || !row.name) return null;
    const name = String(row.name).replace(/[（(]/g, '/').replace(/[）)]/g, '').trim();
    return name || null;
  } catch (error) {
    return null;
  }
}

export function formatContactsLine() {
  const db = initMemoryDb();
  if (!db) return '';
  try {
    const rows = db.prepare("SELECT uid, name FROM profiles WHERE name != '' ORDER BY updated_at DESC LIMIT 30").all();
    const list = [];
    for (const r of rows) {
      if (!r || !r.name) continue;
      // "主名（别名）" → 显示成 主名/别名，方便模型一眼认出别名
      const name = String(r.name).replace(/[（(]/g, '/').replace(/[）)]/g, '').trim();
      if (!name) continue;
      list.push(`${name}(QQ:${r.uid})`);
      if (list.length >= 20) break;
    }
    return list.length ? `[Contacts] ${list.join(', ')}` : '';
  } catch (error) {
    log(`[memory] 通讯录读取失败: ${error?.message ?? error}`);
    return '';
  }
}

// 按昵称反查 QQ 号（精确/包含匹配通讯录里的名字、括号别名、斜杠别名），找不到返回 null。
export function resolveNameToUid(name) {
  if (!name) return null;
  const db = initMemoryDb();
  if (!db) return null;
  const n = String(name).trim();
  if (!n) return null;
  try {
    const rows = db.prepare("SELECT uid, name FROM profiles WHERE name != ''").all();
    for (const r of rows) {
      if (!r || !r.name) continue;
      const full = String(r.name);
      const pm = full.match(/^([^（(]+)[（(]([^）)]+)[）)]$/);
      const base = pm ? pm[1] : full;
      const paren = pm ? pm[2] : '';
      const aliases = [full, base, ...base.split(/[\/\s、,，;；]+/), ...paren.split(/[\/\s、,，;；]+/)]
        .map((x) => String(x ?? '').trim()).filter(Boolean);
      if (aliases.some((a) => a && (a === n || a.includes(n) || n.includes(a)))) return String(r.uid);
    }
  } catch (error) {
    log(`[memory] 名字解析失败 ${name}: ${error?.message ?? error}`);
  }
  return null;
}

/* ── 聊天记录（已迁到独立库 state/chat.db，实现见 core/chat-db.js）───────────────
 * 这里 re-export 保持调用方零改动：mux / social-flow / wake-send / crosschat /
 * message-cache / console-server 全都继续从 './memory.js' import 这些函数。
 * 末尾三个（chatCounters / chatConvList / chatDbStats）是管理端「聊天记录」页要的总量计数。 */
export {
  persistChatMessage, markMessagesRead, markChatRecalled, markOutboundRecalled,
  fetchUnreadChatMessages, recentChatMessages, recentMessagesAcrossSessions, findChatMessageMedia,
  searchChatMessages, deleteChatMessages, clearChatHistory, loadGroupChatMessagesForLearning,
  chatCounters, chatConvList, chatDbStats, tokenUsageSummary, recountChatCounters,
  // rebuildChatFts 也要透出：控制台的 /api/social/chat-reindex 与测试从 './memory.js' import 它
  // （曾经漏出过一次，症状是 ESM 直接 "does not provide an export named 'rebuildChatFts'"，
  //  整个 console-server 模块加载失败、桥跟着起不来 —— 所以这里宁可多透一个，别漏）。
  rebuildChatFts,
} from './chat-db.js';

// ── 会话记忆格式化/写入 ─────────
import { redactKnownTokensOnly } from '../lib/outbound-text.js';
import { saveSocialState } from './social-state.js';

let cfgRef = null;
/** main 启动时调用：注入 cfg（此后不再变） */
export function initMemoryCore(cfg) {
  cfgRef = cfg;
}

export function formatMemory(st) {
  if (!st) return '';
  const lines = [];
  const topics = Array.isArray(st.activeTopics) ? st.activeTopics.filter((t) => t && t.text) : [];
  if (topics.length) {
    lines.push('[Active topics]');
    for (const t of topics.slice(-10)) {
      const ago = t.lastMentionAt ? Math.round((Date.now() - t.lastMentionAt) / 60000) : 0;
      const stale = t.lastMentionAt && Date.now() - Number(t.lastMentionAt) > 2 * 60 * 60 * 1000 ? ' (stale)' : '';
      lines.push(`- ${t.text}${stale} (${ago > 0 ? ago + ' min ago' : 'just now'})${t.pendingQuestion ? `; pending Q: ${t.pendingQuestion}` : ''}`);
    }
  }
  const thoughts = Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => t && t.text && (!t.expiresAt || Date.now() < t.expiresAt)) : [];
  if (thoughts.length) {
    lines.push('[Things you wanted to say]');
    for (const t of thoughts.slice(-10)) {
      lines.push(`- ${t.text}${t.motivation ? ` (${t.motivation})` : ''}`);
    }
  }
  const impressions = st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {};
  const names = Object.keys(impressions);
  if (names.length) {
    lines.push('[Impressions of members]');
    for (const name of names.slice(-10)) {
      const im = impressions[name] || {};
      const traits = Array.isArray(im.traits) ? im.traits : [];
      lines.push(`- ${name}: ${traits.length ? traits.join(', ') : 'none yet'} (interacted ${Number(im.interactionCount) || 0} times)`);
    }
  }
  return lines.join('\n');
}

export function appendMemory(st, category, content, extra = {}) {
  if (!st) return;
  const text = redactKnownTokensOnly(String(content ?? '')).trim();
  const cat = String(category || '').trim();
  // 轻量清理：过期想法移除；超过 24h 未提起的话题移除（避免无限膨胀）。
  if (Array.isArray(st.pendingThoughts)) {
    st.pendingThoughts = st.pendingThoughts.filter((t) => t && (!t.expiresAt || Date.now() < Number(t.expiresAt)));
  }
  if (Array.isArray(st.activeTopics)) {
    st.activeTopics = st.activeTopics.filter((t) => t && (!t.lastMentionAt || Date.now() - Number(t.lastMentionAt) < 24 * 60 * 60 * 1000));
  }
  if (cat === 'activeTopic' && text) {
    if (!Array.isArray(st.activeTopics)) st.activeTopics = [];
    const existing = st.activeTopics.find((t) => t && String(t.text || '') === text);
    if (existing) {
      existing.lastMentionAt = Date.now();
      if (Array.isArray(extra.participants)) {
        const set = new Set([...(existing.participants || []), ...extra.participants.map((p) => redactKnownTokensOnly(String(p)))]);
        existing.participants = [...set].slice(0, 10);
      }
      if (extra.pendingQuestion) existing.pendingQuestion = redactKnownTokensOnly(String(extra.pendingQuestion)).slice(0, 200);
    } else {
      st.activeTopics.push({
        text: text.slice(0, 200),
        lastMentionAt: Date.now(),
        participants: Array.isArray(extra.participants) ? extra.participants.map((p) => redactKnownTokensOnly(String(p))).slice(0, 10) : [],
        pendingQuestion: redactKnownTokensOnly(String(extra.pendingQuestion || '')).slice(0, 200)
      });
    }
    if (st.activeTopics.length > 20) st.activeTopics.splice(0, st.activeTopics.length - 20);
  } else if (cat === 'pendingThought' && text) {
    if (!Array.isArray(st.pendingThoughts)) st.pendingThoughts = [];
    const existing = st.pendingThoughts.find((t) => t && String(t.text || '') === text);
    if (existing) {
      existing.createdAt = Date.now();
      existing.expiresAt = Date.now() + (Number(extra.expiresAtMs) || 2 * 60 * 60 * 1000);
      if (extra.motivation) existing.motivation = redactKnownTokensOnly(String(extra.motivation)).slice(0, 50);
    } else {
      st.pendingThoughts.push({
        text: text.slice(0, 200),
        createdAt: Date.now(),
        expiresAt: Date.now() + (Number(extra.expiresAtMs) || 2 * 60 * 60 * 1000),
        motivation: redactKnownTokensOnly(String(extra.motivation || 'curiosity')).slice(0, 50)
      });
    }
    if (st.pendingThoughts.length > 20) st.pendingThoughts.splice(0, st.pendingThoughts.length - 20);
  } else if (cat === 'memberImpression') {
    const target = String(extra.target || '').trim();
    if (!target || ['__proto__', 'constructor', 'prototype'].includes(target)) return;
    if (!st.memberImpressions || typeof st.memberImpressions !== 'object') st.memberImpressions = {};
    const old = st.memberImpressions[target] || {};
    const traits = Array.isArray(old.traits) ? old.traits.slice(0, 10) : [];
    if (text && !traits.includes(text.slice(0, 50))) traits.push(text.slice(0, 50));
    st.memberImpressions[target] = {
      traits,
      interactionCount: (Number(old.interactionCount) || 0) + 1,
      lastSeenAt: Date.now()
    };
    const impressionEntries = Object.entries(st.memberImpressions);
    if (impressionEntries.length > 50) {
      impressionEntries.sort((a, b) => (Number(a[1]?.lastSeenAt) || 0) - (Number(b[1]?.lastSeenAt) || 0));
      for (let i = 0; i < impressionEntries.length - 50; i++) {
        delete st.memberImpressions[impressionEntries[i][0]];
      }
    }
  }
  saveSocialState();
}

/* 群消息黑话学习的批量聊天读取（loadGroupChatMessagesForLearning）已随聊天记录搬去
 * core/chat-db.js，对外仍从本模块 re-export（见上面的 export 块）。 */

/* ══════════════════════════════════════════════════════════════════════════
 * 分层记忆 API（v1.3.0）—— 永久 / 长期 / 短期 + 相关性检索
 * ══════════════════════════════════════════════════════════════════════════ */

/** 归一：tier 字符串 → 规范层级名（非法值一律按 durable） */
function normTier(v, { pinned = false, category = '' } = {}) {
  const t = String(v ?? '').trim().toLowerCase();
  if (t === 'permanent' || t === 'durable' || t === 'working') return t;
  if (pinned || PERMANENT_CATEGORIES.has(String(category ?? '').trim())) return 'permanent';
  return 'durable';
}

/** 归一：mem_fts 行 → 对外形状 */
function rowToMemoryEntry(r) {
  return {
    id: Number(r.id),
    uid: r.uid || '',
    category: r.category || '',
    content: r.content || '',
    createdAt: Number(r.created_at) || 0,
    updatedAt: Number(r.updated_at) || Number(r.created_at) || 0,
    /* 2026-09-22 修 M14：有的写入路径是裸 INSERT（qzone.js / persona-learn.js 直接往表里插行），
     * 那些行 tier 是空串；以前 `r.tier || 'durable'` 会在读出时谎报成 durable，而 listMemoryEntries 的
     * `tier=?` 过滤又不归一化 → 同一批数据两处口径不一致。现在读出即归一（空串/未知值一律当 durable），
     * 与 server/index.js 的 COALESCE(NULLIF(tier,''),'durable') 对齐。 */
    tier: (() => { const s = String(r.tier ?? '').trim(); return MEMORY_TIERS[s] !== undefined ? s : 'durable'; })(),
    pinned: !!r.pinned,
    importance: Number(r.importance) || 0,
    hits: Number(r.hits) || 0,
    lastUsedAt: Number(r.last_used_at) || 0,
    expiresAt: Number(r.expires_at) || 0,
    convKey: r.conv_key || '',
    tags: r.tags || '',
    source: r.source || '',
  };
}

/**
 * 写一条记忆（幂等去重：同 uid+category+content 只留一条，重复写只累加 hits / 刷新时间）。
 * @param {{uid?:string, category?:string, content:string, tier?:string, pinned?:boolean,
 *          importance?:number, ttlMs?:number, convKey?:string, tags?:string, source?:string}} o
 */
export function rememberEntry(o = {}) {
  const db = initMemoryDb();
  if (!db) return { ok: false, error: '记忆库不可用' };
  const content = String(o.content ?? '').trim();
  if (!content) return { ok: false, error: 'content 不能为空' };
  const category = String(o.category ?? 'note').trim().slice(0, 40) || 'note';
  const uid = String(o.uid ?? '').trim();
  const tier = normTier(o.tier, { pinned: o.pinned === true, category });
  const pinned = tier === 'permanent' ? 1 : (o.pinned ? 1 : 0);
  const ttl = Number(o.ttlMs);
  const expiresAt = Number.isFinite(ttl) && ttl > 0
    ? Date.now() + ttl
    : (MEMORY_TIERS[tier] || 0) > 0 ? Date.now() + MEMORY_TIERS[tier] : 0;
  const now = Date.now();
  const row = {
    uid, category, content: content.slice(0, 4000), tier,
    pinned, importance: Math.max(0, Math.min(100, Number(o.importance) || 0)),
    expiresAt, convKey: String(o.convKey ?? '').slice(0, 120),
    tags: String(o.tags ?? '').slice(0, 200), source: String(o.source ?? '').slice(0, 40),
  };
  try {
    const hit = db.prepare('SELECT id, hits FROM memory_entries WHERE uid = ? AND category = ? AND content = ? LIMIT 1')
      .get(row.uid, row.category, row.content);
    if (hit) {
      /* 2026-09-22 修 M12：去重时不能拿本次调用的值覆盖更强的旧值：旧写法直接把 tier/pinned/
       * expires_at 写成这次归一化的结果，于是"把同一句话再记一遍"会把一条 permanent（永不过期、每轮
       * 都进 [Recall]）降级成 durable（90 天）。现在三个字段都取"更强的那一边"：
       *   tier：任一边 permanent 就是 permanent；pinned 取 MAX；
       *   expires_at：0 = 永不过期 → 任一边为 0 就是 0，否则取更晚的那个（绝不缩短寿命）。 */
      db.prepare(`UPDATE memory_entries SET hits = hits + 1, updated_at = ?, last_used_at = ?,
        tier = CASE WHEN tier = 'permanent' OR ? = 'permanent' THEN 'permanent' ELSE ? END,
        pinned = MAX(pinned, ?),
        importance = MAX(importance, ?),
        expires_at = CASE WHEN tier = 'permanent' OR ? = 'permanent' THEN 0
                          WHEN expires_at = 0 OR ? = 0 THEN 0
                          ELSE MAX(expires_at, ?) END
        WHERE id = ?`)
        .run(now, now, row.tier, row.tier, row.pinned, row.importance, row.tier, row.expiresAt, row.expiresAt, Number(hit.id));
      updateEntryBgeEmbedding(Number(hit.id), row.content).catch(() => {});
      return { ok: true, id: Number(hit.id), deduped: true, tier: row.tier };
    }
    const initVec = getBgeCached(row.content, { isQuery: false, triggerWarmup: false }) || embedFallbackSync(row.content);
    const initBlob = vectorToBlob(initVec);
    const info = db.prepare(`INSERT INTO memory_entries
      (uid, category, content, created_at, updated_at, tier, pinned, importance, expires_at, conv_key, tags, source, embedding)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(row.uid, row.category, row.content, now, now, row.tier, row.pinned, row.importance, row.expiresAt, row.convKey, row.tags, row.source, initBlob);
    const newId = Number(info.lastInsertRowid);
    if (!initVec || initVec.length !== BGE_DIM) {
      updateEntryBgeEmbedding(newId, row.content).catch(() => {});
    }
    return { ok: true, id: newId, deduped: false, tier: row.tier };
  } catch (error) {
    log(`[memory] 写记忆失败: ${error?.message ?? error}`);
    return { ok: false, error: error?.message ?? String(error) };
  }
}

/** 置顶/取消置顶（置顶 = permanent 层：永不过期，且进每轮摘要） */
export function setMemoryPinned(id, pinned = true) {
  const db = initMemoryDb();
  if (!db) return { ok: false, error: '记忆库不可用' };
  try {
    /* 2026-09-22 修 M13：取消置顶时必须把 tier 也降回来：旧写法 `ELSE tier` 会把 permanent 层留着，
     * 于是"取消置顶"之后这条记忆仍然每轮进 [Recall] 摘要，而且 pruneExpiredMemory 明确排除
     * tier='permanent' → 永远清不掉（界面动作与库内语义不一致）。现在取消置顶 = 回到 durable 层，
     * 并给它一个正常的过期时间（TTL 取 durable 档）。 */
    const info = db.prepare("UPDATE memory_entries SET pinned = ?, "
      + "tier = CASE WHEN ? = 1 THEN 'permanent' ELSE 'durable' END, "
      + "expires_at = CASE WHEN ? = 1 THEN 0 ELSE ? END, updated_at = ? WHERE id = ?")
      .run(pinned ? 1 : 0, pinned ? 1 : 0, pinned ? 1 : 0,
        Date.now() + (Number(MEMORY_TIERS.durable) || 0), Date.now(), Number(id));
    return { ok: true, updated: Number(info.changes) || 0 };
  } catch (error) {
    return { ok: false, error: error?.message ?? String(error) };
  }
}

/** 计算单行记忆与查询向量的语义相似度（优先 512 维 bge-small-zh-v1.5 向量，兼容 128 维同义概念簇回退） */
function scoreMemorySemantic(row, qBgeVec, qFallbackVec) {
  const rowVec = row.embedding ? blobToVector(row.embedding) : null;
  if (qBgeVec && rowVec && rowVec.length === BGE_DIM) {
    return { sim: cosineSimilarity(qBgeVec, rowVec), mode: 'bge' };
  }
  const docBge = getBgeCached(row.content, { isQuery: false, triggerWarmup: true });
  if (qBgeVec && docBge && docBge.length === BGE_DIM) {
    return { sim: cosineSimilarity(qBgeVec, docBge), mode: 'bge' };
  }
  const docFallback = (rowVec && rowVec.length === qFallbackVec.length)
    ? rowVec
    : embedFallbackSync(row.content);
  return { sim: cosineSimilarity(qFallbackVec, docFallback), mode: 'fallback' };
}

/** 列表/检索记忆条目。query 有值走 Hybrid RRF（FTS5 BM25 + bge-small-zh-v1.5 语义向量融合重排），否则按层级+重要性+时间排。 */
export function listMemoryEntries(opts = {}) {
  const db = initMemoryDb();
  if (!db) return { ok: false, error: '记忆库不可用', entries: [] };
  const limit = Math.min(200, Math.max(1, Number(opts.limit) || 30));
  const where = [];
  const params = [];
  if (opts.uid) { where.push('uid = ?'); params.push(String(opts.uid)); }
  if (opts.category) { where.push('category = ?'); params.push(String(opts.category)); }
  if (opts.convKey) { where.push('conv_key = ?'); params.push(String(opts.convKey)); }
  if (opts.tier) { where.push('tier = ?'); params.push(String(opts.tier)); }
  if (!opts.includeExpired) { where.push('(expires_at = 0 OR expires_at > ?)'); params.push(Date.now()); }
  const rawQuery = String(opts.query ?? '').trim();
  const ftsQ = rawQuery ? ftsQueryOf(rawQuery) : '';
  try {
    if (rawQuery) {
      // 1. 路 A：FTS5 Trigram BM25 字面检索
      let ftsRows = [];
      if (ftsQ && ftsUsable(db, 'mem_fts')) {
        const conds = [...where, 'mem_fts MATCH ?'];
        ftsRows = db.prepare(
          `SELECT memory_entries.* FROM memory_entries JOIN mem_fts ON mem_fts.rowid = memory_entries.id
           WHERE ${conds.join(' AND ')} ORDER BY bm25(mem_fts) ASC LIMIT ?`
        ).all(...params, ftsQ, limit * 2);
      } else {
        const likeConds = [...where, 'content LIKE ?'];
        ftsRows = db.prepare(
          `SELECT * FROM memory_entries WHERE ${likeConds.join(' AND ')}
           ORDER BY pinned DESC, importance DESC, COALESCE(updated_at, created_at) DESC LIMIT ?`
        ).all(...params, `%${rawQuery}%`, limit * 2);
      }

      // 2. 路 B：bge-small-zh-v1.5 稠密向量余弦相似度语义检索（支持跨字面同义召回，如“夜宵”召回“烧烤炸鸡”）
      const qBgeVec = getBgeCached(rawQuery, { isQuery: true, triggerWarmup: true });
      const qFallbackVec = embedFallbackSync(rawQuery);
      const candidates = db.prepare(
        `SELECT * FROM memory_entries${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
         ORDER BY pinned DESC, importance DESC, COALESCE(updated_at, created_at) DESC LIMIT 400`
      ).all(...params);

      const vecScored = [];
      for (const r of candidates) {
        const { sim, mode } = scoreMemorySemantic(r, qBgeVec, qFallbackVec);
        const threshold = mode === 'bge' ? 0.43 : 0.25;
        if (sim >= threshold) {
          vecScored.push({ row: r, sim });
        }
      }
      vecScored.sort((a, b) => b.sim - a.sim);
      const vecRows = vecScored.slice(0, limit * 2).map((x) => x.row);

      // 3. RRF (Reciprocal Rank Fusion, k=60) 混合重排
      const RRF_K = 60;
      const rrfMap = new Map();
      ftsRows.forEach((r, idx) => {
        const id = Number(r.id);
        const cur = rrfMap.get(id) || { row: r, score: 0 };
        cur.score += 1.2 / (RRF_K + idx + 1); // 字面精确命中赋予 1.2 权重保障高精确度
        rrfMap.set(id, cur);
      });
      vecRows.forEach((r, idx) => {
        const id = Number(r.id);
        const cur = rrfMap.get(id) || { row: r, score: 0 };
        cur.score += 1.0 / (RRF_K + idx + 1);
        rrfMap.set(id, cur);
      });

      const merged = [...rrfMap.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((x) => rowToMemoryEntry(x.row));
      return { ok: true, ranked: true, hybrid: true, entries: merged };
    }

    const rows = db.prepare(
      `SELECT * FROM memory_entries${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
       ORDER BY pinned DESC, importance DESC, COALESCE(updated_at, created_at) DESC LIMIT ?`
    ).all(...params, limit);
    return { ok: true, entries: rows.map(rowToMemoryEntry) };
  } catch (error) {
    log(`[memory] 读记忆失败: ${error?.message ?? error}`);
    return { ok: false, error: error?.message ?? String(error), entries: [] };
  }
}

/** 记账：这些条目刚被用到（hits+1、last_used_at=now），供重要性排序与"老忘不掉"的自愈。 */
export function touchMemoryEntries(ids = []) {
  const db = initMemoryDb();
  if (!db) return { ok: false };
  const list = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Number.isFinite);
  if (!list.length) return { ok: true, touched: 0 };
  try {
    const now = Date.now();
    const st = db.prepare('UPDATE memory_entries SET hits = hits + 1, last_used_at = ? WHERE id = ?');
    let n = 0;
    for (const id of list) n += Number(st.run(now, id).changes) || 0;
    return { ok: true, touched: n };
  } catch { return { ok: false }; }
}

/** 清掉过期的短期记忆（桥启动时与每天定时各跑一次；permanent 永不被清）。 */
export function pruneExpiredMemory() {
  const db = initMemoryDb();
  if (!db) return { ok: false, deleted: 0 };
  try {
    const info = db.prepare("DELETE FROM memory_entries WHERE pinned = 0 AND tier != 'permanent' AND expires_at > 0 AND expires_at <= ?").run(Date.now());
    const n = Number(info.changes) || 0;
    if (n > 0) log(`[memory] 清理过期记忆 ${n} 条`);
    return { ok: true, deleted: n };
  } catch (error) {
    return { ok: false, deleted: 0, error: error?.message ?? String(error) };
  }
}

/**
 * 每轮注入的记忆摘要（永久层 + 与当前对话语境/该人最相关的长期记忆条目）。
 *
 * @param {{uid?:string, convKey?:string, query?:string, limit?:number, maxChars?:number}} o
 */
export function memoryDigest(o = {}) {
  const db = initMemoryDb();
  if (!db) return '';
  /* 2026-09-22 修 M15：过期行以前永远不会被删：pruneExpiredMemory 全仓只有 import、没有调用点。
   * 这里顺手清一次就够（摘要本来就每轮唤醒都会跑），但按小时节流，别每次唤醒都扫一遍表。 */
  try {
    const last = Number(memoryDigest._lastPruneAt) || 0;
    if (Date.now() - last > 3600_000) {
      memoryDigest._lastPruneAt = Date.now();
      const pr = pruneExpiredMemory();
      if (pr?.ok && pr.removed > 0) log(`[memory] 清理过期记忆 ${pr.removed} 条`);
    }
  } catch { /* 清理失败不影响摘要 */ }
  const limit = Math.max(1, Math.min(30, Number(o.limit) || 12));
  const maxChars = Math.max(120, Math.min(4000, Number(o.maxChars) || 700));
  const now = Date.now();
  const contextQuery = String(o.query ?? '').trim();
  try {
    const rows = db.prepare(`
      SELECT * FROM memory_entries
      WHERE (pinned = 1 OR tier = 'permanent' OR category IN ('rule','owner','identity','persona'))
        AND (expires_at = 0 OR expires_at > ?)
        AND (uid = ? OR uid = '' OR ? = '')
      ORDER BY pinned DESC, importance DESC, COALESCE(updated_at, created_at) DESC
      LIMIT ?`).all(now, String(o.uid ?? ''), String(o.uid ?? ''), limit);
    let others = db.prepare(`
      SELECT * FROM memory_entries
      WHERE pinned = 0 AND tier != 'permanent' AND category NOT IN ('rule','owner','identity','persona')
        AND (expires_at = 0 OR expires_at > ?) AND (uid = ? OR uid = '' OR ? = '')
      ORDER BY importance DESC, COALESCE(updated_at, created_at) DESC LIMIT ?`)
      .all(now, String(o.uid ?? ''), String(o.uid ?? ''), Math.max(limit * 4, 40));

    // 当传入当前对话上下文 query 时，利用 bge-small-zh-v1.5 语义向量动态提权与当前话题最相关的记忆
    if (contextQuery && others.length > 1) {
      const qBgeVec = getBgeCached(contextQuery, { isQuery: true, triggerWarmup: true });
      const qFallbackVec = embedFallbackSync(contextQuery);
      others = others
        .map((r) => {
          const { sim } = scoreMemorySemantic(r, qBgeVec, qFallbackVec);
          const impScore = (Number(r.importance) || 0) / 100;
          return { r, score: sim * 1.5 + impScore * 0.5 };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((x) => x.r);
    } else {
      others = others.slice(0, limit);
    }

    const list = [...rows, ...others];
    if (!list.length) return '';
    const seen = new Set();
    const lines = [];
    let used = 0;
    for (const r of list) {
      const e = rowToMemoryEntry(r);
      const key = `${e.category}|${e.content}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const tag = e.pinned || e.tier === 'permanent' ? '★' : e.category;
      const line = `- [${tag}] ${e.content.replace(/\s+/g, ' ').slice(0, 140)}`;
      if (used + line.length > maxChars) break;
      used += line.length + 1;
      lines.push(line);
    }
    return lines.join('\n');
  } catch (error) {
    log(`[memory] 记忆摘要生成失败: ${error?.message ?? error}`);
    return '';
  }
}

/** 记忆库规模/索引状态（诊断与管理端展示用） */
export function memoryStats() {
  const db = initMemoryDb();
  if (!db) return { ok: false };
  const one = (sql, ...p) => { try { return Number(db.prepare(sql).get(...p)?.c || 0); } catch { return 0; } };
  const meta = (k) => { try { return db.prepare('SELECT v FROM memory_meta WHERE k = ?').get(k)?.v ?? ''; } catch { return ''; } };
  return {
    ok: true,
    profiles: one('SELECT COUNT(*) AS c FROM profiles'),
    entries: one('SELECT COUNT(*) AS c FROM memory_entries'),
    permanent: one("SELECT COUNT(*) AS c FROM memory_entries WHERE pinned = 1 OR tier = 'permanent'"),
    embedded: one('SELECT COUNT(*) AS c FROM memory_entries WHERE embedding IS NOT NULL AND length(embedding) = ?', BGE_DIM * 4),
    embeddingModel: bgeModelFilesReady() ? 'bge-small-zh-v1.5-int8-512d' : 'semantic-cluster-128d',
    // 聊天记录在 state/chat.db：条数与索引状态都从那边取（本库里已经没有那张表了）
    chat: Number(chatCounters()?.total) || 0,
    ftsChat: (() => { const cs = chatDbStats(); return cs?.fts?.ok ? Number(cs.fts.indexed) : -1; })(),
    chatDbBytes: Number(chatDbStats()?.dbBytes) || 0,
    ftsMem: ftsUsable(db, 'mem_fts') ? one('SELECT COUNT(*) AS c FROM mem_fts') : -1,
    ftsVersion: meta('fts_version'),
    ftsRebuiltAt: Number(meta('fts_rebuilt_at')) || 0,
  };
}

/**
 * 单轮折叠前异步微事实自动提炼（零 LLM 开销）：
 * 识别用户在对话中明确表达的称呼偏好、喜好、雷区、重要约定或近期状态，自动落入分层记忆库并生成 BGE 512d 向量。
 */
const MICRO_FACT_PATTERNS = [
  { re: /^(?:以后|你可以)?(?:叫我|称呼我为?)["'“「]?([^\s"'”」，。！？,!?]{1,12})["'”」]?/, cat: 'preference', imp: 82, tpl: (m) => `偏好称呼：希望被叫做「${m[1]}」` },
  { re: /我(?:最喜欢|超喜欢|特别喜欢|最爱吃|最爱喝|平时喜欢)([^，。！？\n]{2,28})/, cat: 'preference', imp: 72, tpl: (m) => `个人喜好：喜欢${m[1].trim()}` },
  { re: /我(?:最讨厌|超讨厌|特别反感|不吃|对.+过敏)([^，。！？\n]{1,28})/, cat: 'taboo', imp: 78, tpl: (m) => `个人禁忌/雷区：${m[0].trim()}` },
  { re: /记住(?:了|哦|呀|哈)?[，：:\s]+([^。！？\n]{4,60})/, cat: 'fact', imp: 85, tpl: (m) => `叮嘱记住的事项：${m[1].trim()}` },
  { re: /别忘了[，：:\s]*([^。！？\n]{4,60})/, cat: 'promise', imp: 84, tpl: (m) => `提醒别忘的约定：${m[1].trim()}` },
  { re: /我(?:生日是|的生日在)([^，。！？\n]{2,20})/, cat: 'fact', imp: 88, tpl: (m) => `生日信息：${m[1].trim()}` },
  /* 2026-10-31 追加（主人：「包括记忆，没落地吗」）。实测 47 天只落了 2 条 fact ——
   * 上面那 6 条要求「以后叫我 XX」「我最喜欢 XX」这种教科书句式，真实对话里几乎不出现。
   * 下面补的是实际出现过的说法：考试/面试/开学这类**近期安排**、学业身份、姓名、年龄。
   * 仍然坚持零 LLM、纯模式匹配；宁可少记，也不把「好困」这类临时状态灌进长期库
   * （README §4.4 的群聊防污染口径）。 */
  { re: /我(?:今天|明天|后天|这周|下周|下下周|下周[一二三四五六日天]|周[一二三四五六日天])[^。！？\n]{0,20}(?:要|得|准备|打算|约了|去)?[^。！？\n]{0,14}(考试|面试|上课|开学|出差|加班|放假|体检|答辩|比赛|报名)/, cat: 'plan', imp: 76, tpl: (m) => `近期安排：${m[0].trim()}` },
  { re: /我(?:是|在)(?:读)?(高中|初中|大学|大[一二三四]|研[一二三]|高三|高二|高一|初三|初二|初一)[^，。！？\n]{0,16}/, cat: 'identity', imp: 74, tpl: (m) => `学业身份：${m[0].trim()}` },
  { re: /我(?:叫|名字叫|名字是|网名是)([^，。！？\n]{2,12})/, cat: 'identity', imp: 80, tpl: (m) => `姓名/网名：${m[1].trim()}` },
  { re: /我(?:今年)?(\d{1,2})(?:岁|年级)/, cat: 'identity', imp: 70, tpl: (m) => `年龄/年级：${m[0].trim()}` },
];

/* 私聊专用：真实私聊里主语经常省略（「下周一和三要考试了」「有点慌」）。
 * 一对一场景说话人唯一，省掉主语不会张冠李戴，所以这里允许没有「我」。
 * 群里不放宽 —— 群聊省略主语会把别人的安排记到发言者头上，那比不记更糟。 */
const PRIVATE_FACT_PATTERNS = [
  { re: /^(?:今天|明天|后天|这周|下周|下下周|下周[一二三四五六日天]|周[一二三四五六日天])[^。！？\n]{0,20}(?:要|得|准备|打算|约了|去)?[^。！？\n]{0,14}(考试|面试|上课|开学|出差|加班|放假|体检|答辩|比赛|报名)/, cat: 'plan', imp: 74, tpl: (m) => `近期安排：${m[0].trim()}` },
  { re: /(?:在|读)(高中|初中|大学|大[一二三四]|研[一二三]|高三|高二|高一|初三)[^，。！？\n]{0,16}/, cat: 'identity', imp: 70, tpl: (m) => `学业身份：${m[0].trim()}` },
];

export function extractAndRememberMicroFact(uid, convKey, rawText, isOwner = false) {
  try {
    const cleanUid = String(uid ?? '').trim();
    const text = String(rawText ?? '').replace(/\[CQ:[^\]]*\]/g, '').trim();
    if (!cleanUid || text.length < 4 || text.length > 180 || text.startsWith('/')) return null;
    const isPrivate = String(convKey ?? '').startsWith('private:');
    const patterns = isPrivate ? [...MICRO_FACT_PATTERNS, ...PRIVATE_FACT_PATTERNS] : MICRO_FACT_PATTERNS;
    for (const item of patterns) {
      const m = item.re.exec(text);
      if (m) {
        const content = item.tpl(m);
        const tier = isOwner && item.imp >= 82 ? 'permanent' : 'durable';
        return rememberEntry({
          uid: cleanUid,
          convKey: String(convKey ?? ''),
          category: isOwner && item.cat === 'preference' ? 'owner' : item.cat,
          content,
          importance: isOwner ? Math.min(98, item.imp + 10) : item.imp,
          tier,
          pinned: isOwner && item.imp >= 85,
          source: 'auto-micro-fact',
        });
      }
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * 群友双向社交羁绊查询：基于 chat.db 中引用互动与同频对话提取某用户的群内熟人关系网。
 */
export function getTopSocialBonds(uid, convKey = '', limit = 3) {
  try {
    const cleanUid = String(uid ?? '').trim();
    if (!cleanUid) return '';
    const cdb = initChatDb();
    if (!cdb) return '';
    const whereConv = convKey && String(convKey).startsWith('group:') ? 'AND conv_key = ?' : "AND conv_key LIKE 'group:%'";
    const args = convKey && String(convKey).startsWith('group:') ? [cleanUid, String(convKey)] : [cleanUid];
    const rows = cdb.prepare(`
      SELECT content FROM chat_messages
      WHERE sender_uid = ? ${whereConv} AND content LIKE '[引用 %'
      ORDER BY ts_ms DESC LIMIT 120
    `).all(...args);
    if (!rows.length) return '';
    const counts = new Map();
    for (const r of rows) {
      const m = /^\[引用\s+([^：:\]]+)[：:]/.exec(String(r.content || ''));
      if (m && m[1]) {
        const target = m[1].trim();
        if (target && target !== 'DeepSeek Harness' && target !== '我') {
          counts.set(target, (counts.get(target) || 0) + 1);
        }
      }
    }
    const top = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.max(1, limit))
      .map(([name, cnt]) => `${name}(互动${cnt}次)`);
    return top.length ? `常互动群友: ${top.join('、')}` : '';
  } catch {
    return '';
  }
}

