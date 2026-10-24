/* 更新器（2026-10-23 新增）
 *
 * 做三件事：
 *   ① 从 GitHub 仓库取最新版本（默认 main 分支最新提交）；
 *   ② 原地更新安装目录（server/ + qq-bridge/），不重装、不动用户数据；
 *   ③ 按"合并补丁"的语义落盘：上游改了、本地没改 → 直接覆盖；两边都改过 → 保留本地，
 *      上游版本另存成 <文件名>.new-<短sha>，事后可以自己 diff。
 *
 * 为什么要合并而不是整包覆盖：这套安装目录里有 Gemini 手改过的东西（洛谷卡片、温度、语音），
 * 整包覆盖会把它们冲掉；而完全不更新又拿不到上游的 bug 修复。所以按"三方合并"处理：
 * 基线（base）是上一次更新时写下的清单（state.files 里每个文件的 sha256），
 * 据此判断某个文件到底是"上游改的"还是"本地改的"。
 *
 * 为什么不放在 qq-bridge/：它要改的是整个安装目录（server/ 与 qq-bridge/ 都在内），
 * 只有管理器进程站在够高的位置；而且它是唯一常驻、用户一定会打开的进程。
 *
 * 受管范围只有 MANAGED_ROOTS 那两棵子树。dsh/、napcat-onekey/、meme/、logs/、node_modules/ 一律不碰；
 * 人格与发言规则（persona.md / speech-rules.md）、config.json、state/、roles/、assets/ 也一律不覆盖 ——
 * 那些是用户的东西，不是代码。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, copyFileSync, rmSync, createWriteStream, renameSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import https from 'node:https';

const UA = 'Kizuna-Updater';
const DEFAULT_REPO = 'AbyssalQuill/Kizuna';
const DEFAULT_BRANCH = 'main';
// 只有这两棵子树会被更新（dist/ 例外：由构建产物整体替换）
const MANAGED_ROOTS = ['server', 'qq-bridge'];
/* 不覆盖的路径：用户数据、本机备份、第三方运行时。正则匹配的是"仓库相对路径"（正斜杠）。 */
const EXCLUDE = [
  /(^|\/)config\.json(\.[^/]*)?$/i,
  /(^|\/)persona\.md(\.[^/]*)?$/i,
  /(^|\/)speech-rules\.md(\.[^/]*)?$/i,
  /(^|\/)roles\//i,
  /(^|\/)assets\//i,
  /(^|\/)state\//i,
  /(^|\/)\.dsh\//i,
  /(^|\/)node_modules\//i,
  /(^|\/)(\.venv|GenieData|models|CharacterModels|__pycache__)\//i,
  /\.log$/i,
  /\.bak(-[^/]*)?$/i,
  /\.new-[0-9a-f]{7,}$/i,
  /* 2026-10-24 主人要求：临时/测试文件不进更新。只在受管的两棵子树里生效 ——
   * 例子：qq-bridge/scripts 下的 test-*.mjs、qq-bridge 根下的 test-dsh-v2-wait.mjs、
   * 以及各插件目录里的 test/ 子目录。这些是开发期自测脚本，装到使用者机器上只是噪音，
   * 还会在更新预览里挂一大排。 */
  /(^|\/)(test|tests|__tests__)\//i,
  /(^|\/)test-[^/]*$/i,
  /(^|\/)[^/]*-test\.(mjs|cjs|js)$/i,
  /(^|\/)self-test-[^/]*$/i,
];

/* 读 tar 头里的定长字段。**必须按 UTF-8 解码**：GitHub 的 codeload 包用 UTF-8 写文件名，
 * 按 latin1 读会把 `角色库说明.md` 变成 `è§è²åºè¯´ææ.md`（2026-10-24 实测踩到，
 * 更新预览里就是这名，落盘也会写成这个乱码名）。ASCII 字段（size/mode）按 UTF-8 读结果不变。 */
function cstr(buf, start, len) {
  let end = start;
  const stop = Math.min(start + len, buf.length);
  while (end < stop && buf[end] !== 0) end++;
  return buf.toString('utf8', start, end);
}

/* 极简 tar 解包（只认 ustar / GNU longname / pax path，够解 GitHub 的 codeload 包）。
 * 不用外部 tar 的原因见 prepare() 里的注释。 */
function extractTarGz(tgzPath, destDir, stripComponents = 1) {
  const buf = gunzipSync(readFileSync(tgzPath));
  let off = 0;
  let longName = '';
  let paxPath = '';
  let files = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    let allZero = true;
    for (let i = 0; i < 512; i++) { if (h[i] !== 0) { allZero = false; break; } }
    if (allZero) break;
    const name = cstr(h, 0, 100);
    const size = parseInt((cstr(h, 124, 12).trim() || '0'), 8) || 0;
    const type = String.fromCharCode(h[156] || 48);
    const prefix = cstr(h, 345, 155);
    const dataStart = off + 512;
    const dataEnd = dataStart + size;
    off = dataStart + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = cstr(buf, dataStart, size).replace(/\0+$/, ''); continue; }
    if (type === 'x' || type === 'g') {
      const body = buf.toString('utf8', dataStart, dataEnd);
      const m = /\d+ path=([^\n]+)/.exec(body);
      if (m) paxPath = m[1].replace(/\n$/, '');
      continue;
    }
    if (type !== '0' && type !== '\0' && type !== '5' && type !== '7') continue;
    let full = paxPath || longName || (prefix ? prefix + '/' + name : name);
    longName = '';
    paxPath = '';
    const parts = full.split('/').filter(Boolean).slice(stripComponents);
    if (!parts.length) continue;
    const target = join(destDir, parts.join(sep));
    if (type === '5') { mkdirSync(target, { recursive: true }); continue; }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, buf.subarray(dataStart, dataEnd));
    files++;
  }
  return files;
}
function isExcluded(rel) { return EXCLUDE.some((re) => re.test(rel)); }

function walkFiles(root, out = []) {
  let ents = [];
  try { ents = readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const full = join(root, e.name);
    if (e.isDirectory()) walkFiles(full, out);
    else if (e.isFile()) out.push(full);
  }
  return out;
}

function sha256File(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

function relOf(abs, base) {
  return abs.slice(base.length + 1).split(sep).join('/');
}

function humanBytes(n) {
  if (!Number.isFinite(n)) return '-';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

function download(url, dest, redirect = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': UA } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirect < 5) {
        res.resume();
        resolve(download(new URL(res.headers.location, url).href, dest, redirect + 1));
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error('下载失败 HTTP ' + res.statusCode)); return; }
      const ws = createWriteStream(dest);
      res.pipe(ws);
      ws.on('finish', () => ws.close(() => resolve()));
      ws.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(180000, () => req.destroy(new Error('下载超时')));
  });
}

function httpJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: Object.assign({ 'User-Agent': UA, Accept: 'application/vnd.github+json' }, headers) }, (res) => {
      if (res.statusCode !== 200) {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => reject(new Error('GitHub API ' + res.statusCode + ': ' + body.slice(0, 200))));
        return;
      }
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('请求超时')));
  });
}

export function createUpdater({ runtimeRoot, dataDir, repo, branch, token, log, onFinished }) {
  const REPO = String(repo || process.env.KIZUNA_UPDATE_REPO || DEFAULT_REPO);
  const BRANCH = String(branch || DEFAULT_BRANCH);
  const TOKEN = String(token || process.env.KIZUNA_UPDATE_TOKEN || '');
  const STATE_FILE = join(dataDir, 'update-state.json');
  const STAGE_ROOT = join(dataDir, 'update-staging');
  const BACKUP_ROOT = join(dataDir, 'update-backups');
  const say = typeof log === 'function' ? log : () => {};

  /* staging 目录格式版本：解包逻辑变了就 bump 一次，旧的缓存目录自动作废重解。
   * v1 → v2：文件名从 latin1 改成 UTF-8 解码（v1 解出来的中文名是乱码）。 */
  const STAGE_FORMAT = 'v2';
  const job = { phase: 'idle', step: '', percent: 0, message: '', startedAt: null, finishedAt: null, log: [] };
  let lastResult = null;
  /* 真正在跑才置 true。不能拿 job.phase 当锁：plan 预览也会把 phase 推到 'preparing'，
   * 那只是"正在下载源码包"，不是"正在改动安装目录"。 */
  let busy = false;

  function jlog(line) {
    const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const s = '[' + t + '] ' + line;
    job.log.push(s);
    if (job.log.length > 800) job.log.splice(0, job.log.length - 800);
    try { say('[update] ' + line); } catch { /* 日志失败不影响更新 */ }
  }
  function setJob(phase, message, percent) {
    if (phase) job.phase = phase;
    if (typeof message === 'string') { job.message = message; job.step = message; }
    if (typeof percent === 'number') job.percent = Math.max(0, Math.min(100, Math.round(percent)));
  }

  function headers() {
    const h = {};
    if (TOKEN) h.Authorization = 'Bearer ' + TOKEN;
    return h;
  }

  function loadState() {
    try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
  }
  function saveState(s) {
    try { mkdirSync(dataDir, { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch (e) { jlog('写状态文件失败：' + e.message); }
  }

  async function ghCommit(ref) {
    const j = await httpJson('https://api.github.com/repos/' + REPO + '/commits/' + encodeURIComponent(ref || BRANCH), headers());
    return {
      sha: j.sha,
      short: String(j.sha || '').slice(0, 7),
      message: String(j.commit?.message || '').split('\n')[0],
      date: j.commit?.committer?.date || j.commit?.author?.date || '',
    };
  }

  async function ghCompare(base, head) {
    try {
      const j = await httpJson('https://api.github.com/repos/' + REPO + '/compare/' + base + '...' + head, headers());
      return {
        aheadBy: Number(j.ahead_by) || 0,
        files: Array.isArray(j.files) ? j.files.length : undefined,
        commits: (j.commits || []).map((c) => ({ sha: c.sha, message: String(c.commit?.message || '').split('\n')[0] })),
      };
    } catch { return null; }
  }

  function currentInfo() {
    const st = loadState();
    if (!st || !st.sha) return null;
    return { sha: st.sha, short: String(st.sha).slice(0, 7), date: st.date || '', appliedAt: st.appliedAt || 0 };
  }

  function stageDirFor(sha) { return join(STAGE_ROOT, String(sha).slice(0, 12)); }

  async function prepare(sha) {
    const dir = stageDirFor(sha);
    const tree = join(dir, 'tree');
    const wasIdle = !busy;
    const marker = STAGE_FORMAT + '|' + String(sha);
    let readyText = '';
    try { readyText = readFileSync(join(dir, '.ready'), 'utf8').trim(); } catch { /* 没标记就当没缓存 */ }
    if (existsSync(join(dir, '.ready')) && existsSync(tree) && readyText === marker) {
      jlog('复用已下载的源码包：' + tree);
      if (wasIdle) { job.phase = 'idle'; job.message = ''; job.percent = 0; }
      return tree;
    }
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(tree, { recursive: true });
    const tgz = join(dir, 'src.tar.gz');
    setJob('preparing', '下载源码包…', 8);
    jlog('下载 ' + REPO + ' @ ' + String(sha).slice(0, 7));
    await download('https://codeload.github.com/' + REPO + '/tar.gz/' + sha, tgz);
    jlog('源码包 ' + humanBytes(statSync(tgz).size) + ' 已下载');
    setJob('preparing', '解压源码包…', 16);
    /* 用自带的解析器而不是外部 tar：Windows 上的 GNU tar 会把 "C:\\..." 的盘符当成远程主机名
     * （实测报 tar: Cannot connect to C: resolve failed），而 bsdtar 又不一定在用户的 PATH 里。 */
    const n = extractTarGz(tgz, tree, 1);
    jlog('解压完成：' + n + ' 个文件');
    writeFileSync(join(dir, '.ready'), marker);
    if (wasIdle) { job.phase = 'idle'; job.message = ''; job.percent = 0; }
    return tree;
  }

  function runCmd(cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
      const p = spawn(cmd, args, Object.assign({ stdio: ['ignore', 'pipe', 'pipe'] }, opts));
      let out = '';
      p.stdout.on('data', (c) => { out += c; });
      p.stderr.on('data', (c) => { out += c; });
      p.on('error', reject);
      p.on('close', (code) => code === 0 ? resolve(out) : reject(new Error(cmd + ' 退出码 ' + code + '：' + out.slice(-500))));
    });
  }

  function runStream(cmd, args, cwd, label) {
    return new Promise((resolve, reject) => {
      const win = process.platform === 'win32';
      const p = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], shell: win });
      const eat = (buf) => {
        const text = String(buf);
        for (const line of text.split(/\r?\n/)) {
          const s = line.trim();
          if (s) jlog((label ? label + ' ' : '') + s.slice(0, 300));
        }
      };
      p.stdout.on('data', eat);
      p.stderr.on('data', eat);
      p.on('error', reject);
      p.on('close', (code) => code === 0 ? resolve() : reject(new Error(cmd + ' ' + args.join(' ') + ' 退出码 ' + code)));
    });
  }

  /* 把上游树里受管路径的文件读成 map：rel(仓库相对，正斜杠) -> { abs, hash, size } */
  function collectUpstream(tree) {
    const map = new Map();
    for (const root of MANAGED_ROOTS) {
      const abs = join(tree, root);
      if (!existsSync(abs)) continue;
      for (const f of walkFiles(abs)) {
        const rel = relOf(f, tree);
        if (isExcluded(rel)) continue;
        const st = statSync(f);
        map.set(rel, { abs: f, hash: sha256File(f), size: st.size });
      }
    }
    return map;
  }

  function computePlan(tree) {
    const upstream = collectUpstream(tree);
    const st = loadState();
    const base = (st && st.files) || {};
    /* 有没有 baseline，决定了"本地改过"能不能判得出来：
     *   · 有 baseline（以前更新过）→ 逐文件三方比对，两边都改的算冲突；
     *   · 没有 baseline（刚装好、从没走过更新器）→ 没有基线可比，一律按"上游为准"处理，
     *     否则整棵安装目录里只要是旧版本文件都会变成"冲突"，第一次更新等于什么都没更。
     *     覆盖前照样逐个备份到 update-backups，真要找回来有备份。 */
    const hasBaseline = Object.keys(base).length > 0;
    const entries = [];
    for (const [rel, info] of upstream) {
      const localAbs = join(runtimeRoot, rel);
      if (!existsSync(localAbs)) { entries.push({ rel, action: 'add', upstreamBytes: info.size }); continue; }
      let localHash = null;
      try { localHash = sha256File(localAbs); } catch { /* 读不了就当冲突处理 */ }
      if (localHash === info.hash) continue;                        // 已一致，不用动
      const baseHash = base[rel];
      const localChanged = hasBaseline && baseHash && localHash && localHash !== baseHash;
      entries.push({
        rel,
        action: localChanged ? 'conflict' : 'update',
        localBytes: statSync(localAbs).size,
        upstreamBytes: info.size,
      });
    }
    // 上游删掉、本地还在的文件：本地没改过就跟着删；改过就留着（别吃掉用户的东西）
    for (const rel of Object.keys(base)) {
      if (upstream.has(rel)) continue;
      const localAbs = join(runtimeRoot, rel);
      if (!existsSync(localAbs)) continue;
      let localHash = null;
      try { localHash = sha256File(localAbs); } catch { continue; }
      entries.push({ rel, action: localHash === base[rel] ? 'delete' : 'kept' });
    }
    const counts = { add: 0, update: 0, conflict: 0, delete: 0, kept: 0 };
    for (const e of entries) counts[e.action] = (counts[e.action] || 0) + 1;
    return { tree, entries, counts, upstream, firstRun: !hasBaseline };
  }

  async function buildDist(tree, stamp) {
    const pkg = join(tree, 'package.json');
    if (!existsSync(pkg)) throw new Error('源码包缺少 package.json，无法构建前端');
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    if (!existsSync(join(tree, 'node_modules', 'vite'))) {
      setJob('building', '安装前端依赖（首次较慢，约 1-3 分钟）…', 72);
      jlog('node_modules 里没有 vite → 执行 npm install');
      await runStream(npm, ['install', '--no-audit', '--no-fund', '--loglevel=error'], tree, '[npm]');
    }
    setJob('building', '构建前端（tsc + vite build）…', 86);
    await runStream(npm, ['run', 'build'], tree, '[build]');
    const built = join(tree, 'dist');
    if (!existsSync(join(built, 'index.html'))) throw new Error('构建完成但没有产物 dist/index.html');
    const dst = join(runtimeRoot, 'dist');
    const backup = join(runtimeRoot, 'dist.bak-update-' + stamp);
    if (existsSync(dst)) {
      try { rmSync(backup, { recursive: true, force: true }); renameSync(dst, backup); } catch (e) { jlog('旧 dist 改名失败（继续）：' + e.message); }
    }
    let n = 0;
    for (const f of walkFiles(built)) {
      const rel = relOf(f, built);
      const to = join(dst, rel.split('/').join(sep));
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(f, to);
      n++;
    }
    jlog('前端产物已替换：' + n + ' 个文件（旧版备份 ' + (existsSync(backup) ? backup : '无') + '）');
    return backup;
  }

  async function apply(opts = {}) {
    if (busy) throw new Error('上一次更新还没结束');
    busy = true;
    const overwriteAll = opts.overwriteAll === true;
    const wantBuild = opts.build !== false;
    job.log = [];
    job.phase = 'preparing';
    job.startedAt = Date.now();
    job.finishedAt = null;
    setJob('preparing', '准备中…', 2);
    try {
      const latest = opts.sha ? await ghCommit(opts.sha) : await ghCommit(BRANCH);
      const tree = await prepare(latest.sha);
      setJob('planning', '比对本地文件…', 20);
      const plan = computePlan(tree);
      const c = plan.counts;
      jlog('差异：新增 ' + c.add + ' / 更新 ' + c.update + ' / 冲突 ' + c.conflict + ' / 删除 ' + c.delete + ' / 保留 ' + (c.kept || 0));
      const stamp = Date.now() + '-' + latest.short;
      const backupDir = join(BACKUP_ROOT, stamp);
      mkdirSync(backupDir, { recursive: true });
      const prevState = loadState();
      writeFileSync(join(backupDir, '_state.json'), JSON.stringify(prevState || {}, null, 2));
      const created = [];
      const conflicts = [];
      const filesNow = Object.assign({}, (prevState && prevState.files) || {});
      let applied = 0;
      let deleted = 0;
      const total = plan.entries.length || 1;
      let done = 0;
      for (const e of plan.entries) {
        done++;
        setJob('applying', '写入 ' + e.rel, 20 + Math.round((done / total) * 50));
        const localAbs = join(runtimeRoot, e.rel);
        const upstream = plan.upstream.get(e.rel);
        try {
          if (e.action === 'delete') {
            if (existsSync(localAbs)) {
              const bk = join(backupDir, e.rel.split('/').join(sep));
              mkdirSync(dirname(bk), { recursive: true });
              copyFileSync(localAbs, bk);
              rmSync(localAbs, { force: true });
              deleted++;
            }
            delete filesNow[e.rel];
            continue;
          }
          if (e.action === 'kept') { jlog('保留本地改动（上游已删除）：' + e.rel); continue; }
          if (!upstream) continue;
          if (e.action === 'conflict' && !overwriteAll) {
            const newPath = localAbs + '.new-' + latest.short;
            copyFileSync(upstream.abs, newPath);
            conflicts.push(e.rel);
            jlog('冲突：' + e.rel + ' → 保留本地，上游版另存 ' + e.rel + '.new-' + latest.short);
            continue;
          }
          if (existsSync(localAbs)) {
            const bk = join(backupDir, e.rel.split('/').join(sep));
            mkdirSync(dirname(bk), { recursive: true });
            copyFileSync(localAbs, bk);
          } else {
            created.push(e.rel);
          }
          mkdirSync(dirname(localAbs), { recursive: true });
          copyFileSync(upstream.abs, localAbs);
          filesNow[e.rel] = upstream.hash;
          applied++;
        } catch (err) {
          jlog('写入失败 ' + e.rel + '：' + err.message);
        }
      }
      writeFileSync(join(backupDir, '_created.json'), JSON.stringify(created, null, 2));
      let distBackup = '';
      if (wantBuild) {
        try { distBackup = await buildDist(tree, stamp); }
        catch (err) { jlog('前端构建失败（旧 dist 保持原样）：' + err.message); }
      } else { jlog('按请求跳过前端构建，dist 保持原样'); }
      const result = {
        ok: true,
        sha: latest.sha,
        short: latest.short,
        message: latest.message,
        applied,
        conflicts,
        deleted,
        built: !!distBackup,
        distBackup,
        backupDir,
        finishedAt: Date.now(),
      };
      saveState({
        repo: REPO,
        branch: BRANCH,
        sha: latest.sha,
        date: latest.date,
        appliedAt: Date.now(),
        lastBackupDir: backupDir,
        files: filesNow,
      });
      lastResult = result;
      job.phase = 'done';
      job.percent = 100;
      job.message = '更新完成：写入 ' + applied + ' 个文件' + (conflicts.length ? '，冲突 ' + conflicts.length + ' 个已另存 .new' : '') + (distBackup ? '，前端已重建' : '，前端未重建');
      job.finishedAt = Date.now();
      jlog(job.message);
      jlog('更新已完成，系统即将自动重启生效…');
      if (typeof onFinished === 'function') {
        try { onFinished(result); } catch (e) { jlog('自动重启回调异常：' + e.message); }
      }
      return result;
    } catch (err) {
      job.phase = 'error';
      job.message = '更新失败：' + (err && err.message ? err.message : String(err));
      job.finishedAt = Date.now();
      jlog(job.message);
      lastResult = { ok: false, error: job.message, finishedAt: Date.now() };
      throw err;
    } finally {
      busy = false;
    }
  }

  /* 备份目录按时间戳命名，倒序就是"从新到旧"。 */
  function listBackups() {
    try {
      return readdirSync(BACKUP_ROOT)
        .filter((n) => /^\d/.test(n))
        .sort()
        .reverse()
        .map((n) => join(BACKUP_ROOT, n));
    } catch { return []; }
  }

  /* 找最近一份"真的有文件"的备份。为什么不能只看 lastBackupDir：
   * 上一次更新如果只产生了冲突文件（没覆盖任何本地文件），它的备份目录里只有 _state.json，
   * 直接回滚等于什么都没做 —— 用户会以为按钮坏了。 */
  function findRollbackDir() {
    const st = loadState();
    const cands = [st && st.lastBackupDir].concat(listBackups()).filter(Boolean);
    for (const dir of cands) {
      try {
        if (!existsSync(dir)) continue;
        /* 两种"有东西可回滚"：① 备份里真存了文件（覆盖/删除前的副本）；
         * ② 只有 _created.json —— 说明这次是全新装进来的文件，回滚就是把它们删掉。 */
        const hasFiles = walkFiles(dir).some((f) => !relOf(f, dir).startsWith('_'));
        let hasCreated = false;
        try {
          const cf = join(dir, '_created.json');
          hasCreated = existsSync(cf) && JSON.parse(readFileSync(cf, 'utf8')).length > 0;
        } catch { /* 解析失败就当没有 */ }
        if (hasFiles || hasCreated) return dir;
      } catch { /* 下一个 */ }
    }
    return null;
  }

  function rollback() {
    const dir = findRollbackDir();
    if (!dir) throw new Error('没有可回滚的备份');
    let restored = 0;
    for (const f of walkFiles(dir)) {
      const rel = relOf(f, dir);
      if (rel.startsWith('_')) continue;
      const dst = join(runtimeRoot, rel.split('/').join(sep));
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(f, dst);
      restored++;
    }
    const createdFile = join(dir, '_created.json');
    let removed = 0;
    if (existsSync(createdFile)) {
      try {
        for (const rel of JSON.parse(readFileSync(createdFile, 'utf8'))) {
          const p = join(runtimeRoot, rel.split('/').join(sep));
          if (existsSync(p)) { rmSync(p, { force: true }); removed++; }
        }
      } catch { /* 忽略 */ }
    }
    const snap = join(dir, '_state.json');
    if (existsSync(snap)) {
      try {
        const prev = JSON.parse(readFileSync(snap, 'utf8'));
        // 回滚后把基线退回去，否则下一次更新会把这些文件误判成"本地改过"
        saveState(Object.assign({ repo: REPO, branch: BRANCH }, prev, { lastBackupDir: '' }));
      } catch { /* 忽略 */ }
    }
    jlog('已回滚：还原 ' + restored + ' 个文件，删除 ' + removed + ' 个新增文件');
    job.phase = 'idle';
    job.message = '已回滚：还原 ' + restored + ' 个文件';
    return { restored, removed, dir };
  }

  async function check() {
    const cur = currentInfo();
    const latest = await ghCommit(BRANCH);
    const behind = !cur || cur.sha !== latest.sha;
    let compare = null;
    if (cur && behind) compare = await ghCompare(cur.sha, latest.sha);
    return { ok: true, repo: REPO, branch: BRANCH, current: cur, latest, behind, compare };
  }

  function status() {
    return { ok: true, repo: REPO, branch: BRANCH, current: currentInfo(), job, lastResult, runtimeRoot };
  }

  return { check, status, apply, rollback, computePlan, prepare, stageDirFor, loadState };
}
