/* 系统提示词在线更新（2026-11-02 主人：「希望以后更新系统提示词内置的更新能拉取上」）
 *
 * 为什么需要它：系统提示词（agent preset）是**建会话那一刻烧进 history** 的，而且随安装包一起发出去。
 * 于是「发出去的包 = 冻结的提示词」：改一次措辞就要重打 2GB 的安装包，用户还得重装。
 * 这里补一条窄通道：桥启动时（或 console POST /api/prompt/update）从 GitHub 拉 preset，
 * 写进 <bridge>/dsh/agent-presets/qq-chat/；紧接着的 installPresets() 把它装进 DSH home。
 * —— 更新提示词不再需要重打包，重启一次桥就吃到新版本。
 *
 * 走 GitHub Contents API 而不是 raw.githubusercontent.com：实测本机 raw / jsdelivr 都连不通（000），
 * api.github.com 200。API 返回 base64，顺便能拿到 blob sha 做变更判据。每分钟 60 次的匿名额度，
 * 4 个文件一次检查，所以内置 6 小时的最小间隔（force 可跳过）。
 *
 * 边界（宁可少更新，也不要装坏）：
 *   · 只认预设目录下的 4 个文件（白名单），不写任何其它路径；
 *   · 每个文件先做结构校验（agent.cordis.yml 必须含 [PERSONA] 标记与 persona 段），不合格整次放弃；
 *   · 先写 .tmp 再 rename，任一文件失败就回滚到本轮之前的内容；
 *   · 网络超时/404/额度用完一律当"这次不更新"，绝不影响桥启动。
 * 更新成功后由调用方 bumpSessionEpoch()：下一条消息重建会话，新提示词立刻生效（老会话本来改不动）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, STATE_DIR } from '../lib/paths.js';
import { readJsonSafe, atomicWriteJson } from '../lib/json-fs.js';
import { log } from '../lib/log.js';

export const PRESET_REL = path.join('dsh', 'agent-presets', 'qq-chat');
const STATE_FILE = path.join(STATE_DIR, 'prompt-version.json');
/** 默认源：本仓库 main 分支的预设目录（Contents API）。config.social.promptUpdate.apiBase 可换仓库/分支。 */
const DEFAULT_API_BASE = 'https://api.github.com/repos/AbyssalQuill/Kizuna/contents/qq-bridge/dsh/agent-presets/qq-chat';
const DEFAULT_REF = 'main';
const DEFAULT_MIN_INTERVAL_MS = 6 * 3600 * 1000;

/** 白名单 + 每个文件"装坏了看得见"的结构校验 */
const FILES = [
  {
    name: 'agent.cordis.yml',
    minBytes: 800,
    check: (t) => t.includes('[PERSONA]') && t.includes('- id: persona'),
    why: '系统提示词本体（必须带 [PERSONA] 标记与 persona 段，否则人设注入会断）',
  },
  { name: 'preset.yml', minBytes: 20, check: (t) => /name|id/i.test(t), why: 'preset 元信息' },
  { name: 'qq-tool-restrict.mjs', minBytes: 2000, check: (t) => t.includes('tools.guard'), why: '工具白名单 / 发送门禁' },
  { name: 'qq-persona-ephemeral.mjs', minBytes: 2000, check: (t) => t.includes('export'), why: '人设注入与回合末裁剪' },
];

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function presetConfig(cfg) {
  const raw = cfg?.social?.promptUpdate ?? {};
  return {
    enabled: raw.enabled !== false,
    checkOnStart: raw.checkOnStart !== false,
    apiBase: String(raw.apiBase ?? '').trim().replace(/\/+$/, '') || DEFAULT_API_BASE,
    rawBase: String(raw.rawBase ?? '').trim().replace(/\/+$/, ''),
    ref: String(raw.ref ?? '').trim() || DEFAULT_REF,
    timeoutMs: Math.min(30000, Math.max(2000, Number(raw.timeoutMs) || 8000)),
    minIntervalMs: Math.max(0, Number(raw.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS) || 0),
    dryRun: process.env.QQB_PROMPT_UPDATE_DRY === '1',
  };
}

/** 取一个文件：rawBase 优先（自建镜像），否则走 GitHub Contents API（base64）。 */
async function fetchOne(c, name) {
  if (c.rawBase) {
    const res = await fetch(`${c.rawBase}/${name}`, { signal: AbortSignal.timeout(c.timeoutMs), redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  const url = `${c.apiBase}/${name}?ref=${encodeURIComponent(c.ref)}`;
  const res = await fetch(url, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'kizuna-qq-bridge' },
    signal: AbortSignal.timeout(c.timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  if (!j || j.type !== 'file' || typeof j.content !== 'string') throw new Error('返回结构不是文件内容');
  return Buffer.from(j.content, j.encoding === 'base64' ? 'base64' : 'utf8');
}

/**
 * 拉一次预设更新。返回 { checked, updated[], unchanged[], error? }，从不抛异常。
 */
export async function maybeUpdatePrompt(cfg, { force = false } = {}) {
  const c = presetConfig(cfg);
  if (!c.enabled) return { checked: false, updated: [], unchanged: [], error: 'disabled' };
  if (!force && !c.checkOnStart) return { checked: false, updated: [], unchanged: [], error: 'checkOnStart=false' };

  const prev = readJsonSafe(STATE_FILE, {}) ?? {};
  if (!force && !c.dryRun && c.minIntervalMs > 0) {
    const last = Date.parse(String(prev?.fetchedAt ?? '')) || 0;
    if (last && Date.now() - last < c.minIntervalMs) {
      return { checked: false, updated: [], unchanged: [], error: 'throttled' };
    }
  }

  const dir = path.join(ROOT, PRESET_REL);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const unchanged = [];
  const staged = [];

  try {
    for (const f of FILES) {
      let buf;
      try { buf = await fetchOne(c, f.name); }
      catch (e) { throw new Error(`${f.name} 下载失败：${e?.message ?? e}`); }
      const text = buf.toString('utf8');
      if (buf.length < f.minBytes || !f.check(text)) {
        throw new Error(`${f.name} 校验不通过（${buf.length} 字节）—— ${f.why}`);
      }
      const digest = sha(buf);
      const localPath = path.join(dir, f.name);
      const localDigest = (() => { try { return sha(fs.readFileSync(localPath)); } catch { return ''; } })();
      if (digest === localDigest) { unchanged.push(f.name); continue; }
      staged.push({ name: f.name, buf, digest, localPath, localDigest });
    }
  } catch (e) {
    const error = String(e?.message ?? e);
    log(`[prompt-update] 这次不更新：${error}`);
    return { checked: true, updated: [], unchanged, error };
  }

  if (!staged.length) {
    atomicWriteJson(STATE_FILE, { ...prev, checkedAt: new Date().toISOString(), base: c.rawBase || c.apiBase });
    if (c.dryRun) log('[prompt-update] 远端与本地一致，无需更新');
    return { checked: true, updated: [], unchanged, error: null };
  }

  if (c.dryRun) {
    log(`[prompt-update] DRY：会更新 ${staged.map((s) => s.name).join(', ')}（未写盘）`);
    return { checked: true, updated: staged.map((s) => s.name), unchanged, error: null, dryRun: true };
  }

  const backups = [];
  const updated = [];
  try {
    for (const s of staged) fs.writeFileSync(s.localPath + '.tmp', s.buf);
    for (const s of staged) {
      const old = (() => { try { return fs.readFileSync(s.localPath); } catch { return null; } })();
      backups.push({ localPath: s.localPath, old });
      fs.renameSync(s.localPath + '.tmp', s.localPath);
      updated.push(`${s.name}(${s.digest.slice(0, 8)})`);
    }
  } catch (e) {
    const error = String(e?.message ?? e);
    for (const b of backups) {
      try { if (b.old) fs.writeFileSync(b.localPath, b.old); else fs.rmSync(b.localPath, { force: true }); } catch {}
    }
    for (const s of staged) { try { fs.rmSync(s.localPath + '.tmp', { force: true }); } catch {} }
    log(`[prompt-update] 写入失败已回滚：${error}`);
    return { checked: true, updated: [], unchanged, error };
  }

  atomicWriteJson(STATE_FILE, {
    fetchedAt: new Date().toISOString(),
    base: c.rawBase || c.apiBase,
    ref: c.ref,
    files: Object.fromEntries(FILES.map((f) => [f.name, (() => { try { return sha(fs.readFileSync(path.join(dir, f.name))); } catch { return null; } })()])),
    previous: prev?.files ?? null,
  });
  log(`[prompt-update] 已更新预设：${updated.join(', ')}（来源 ${c.rawBase || c.apiBase}@${c.ref}）`);
  return { checked: true, updated, unchanged, error: null };
}
