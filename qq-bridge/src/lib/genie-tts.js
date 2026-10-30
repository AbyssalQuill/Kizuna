// 本地语音合成引擎客户端（Genie / GPT-SoVITS ONNX sidecar）—— 2026-09-28 新增
//
// 背景：语音一直在走云端 MiMo-TTS（core/voice.js），要联网、要 Key、按字数计费，还有每日额度。
// 内置一个**本地引擎**之后，合成这段就不出网了：文本进、wav 出，音色是本地模型（GPT-SoVITS 系）。
//
// 为什么用 sidecar（独立 HTTP 进程）而不是把 Python 嵌进 Node 进程：
//   · 引擎的文本前端（pyopenjtalk-plus / pypinyin / g2pM / jieba_fast / g2pk2）全在 Python 生态，
//     在 Node 里重写等于重写整个 G2P 前端，得不偿失；
//   · 独立进程能被桥随时拉起、空闲回收（模型几 GB 的常驻内存说放就放），崩了也不牵连桥；
//   · 模型常驻同一进程 → 第二次之后的合成没有加载开销（上游实测首次 1.13s，见 tools/genie-setup.mjs）。
//
// 分工（和 core/voice.js 的边界）：
//   · 本文件只管「引擎进程 + HTTP」：探测环境、拉起/回收、发文本收音频、上报内存读数；
//   · 缓存、每日额度、音色库、发消息、裁回声……仍然全在 core/voice.js，这里不碰。
//   · 因此本文件**不读配置全域**：调用方把 cfg.local（voiceConfig().local）传进来即可，
//     这样也便于测试（不用起真引擎就能验路径归一化与探测逻辑）。
//
// 引擎覆盖范围（上游能力决定的，不是取舍）：
//   tts    → 用本地角色的固有音色念（角色 = modelsDir 下的一个目录）
//   clone  → 本地角色 + 参考音频（把桥的「音色复刻」样本当 reference 送进去）
//   design → **不支持**：文字描述造音色是云端 voicedesign 模型的能力，本地引擎没有对应模型，
//            调用方遇到 design 直接回落云端（voice.js 里就这么写的）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { ROOT, STATE_DIR } from './paths.js';
import { log } from './log.js';
import { ensureVenvHome } from './genie-venv-home.js';

const SERVER_FILE_NAME = 'genie_server.py';
const LOG_FILE_NAME = 'genie.log';
const REF_SUBDIR = 'genie-refs';
const PROBE_TTL_MS = 20000;

/** 探测未满足项的**稳定标识**（2026-10-02）：「查看目标」那一行直接显示 `reasons` 的文案，
 *  所以文案必须说人话、且随时可能再改；调用方（测试、tools/genie-setup.mjs）一律按这里的
 *  code 判定缺什么，改文案就不会把判定改坏。 */
export const PROBE_ISSUES = Object.freeze({
  ENGINE_FILES: 'engine-files',        // 引擎自身的运行文件不在
  RUNTIME: 'runtime',                  // 没有可用的解释器/运行环境
  ENGINE_PACKAGE: 'engine-package',    // 运行环境在，但语音引擎没装
  PUBLIC_DATA: 'public-data',          // 公共数据不在或不完整
  CHARACTERS: 'characters'             // 一个角色模型都没有
});

/** 出厂默认值。真正的默认值在 core/voice.js 的 defaults().local，这里只是"字段缺失时的兜底"。 */
export const LOCAL_DEFAULTS = {
  enabled: false,
  engine: 'genie',
  rootDir: '',
  pythonPath: '',
  dataDir: '',
  modelsDir: '',
  character: '',
  language: 'zh',
  port: 4610,
  autoStart: true,
  idleShutdownMs: 600000,
  startupTimeoutMs: 120000,
  timeoutMs: 180000,
  fallbackToCloud: true
};

const isWin = process.platform === 'win32';

/** 合并默认值（纯函数，便于测试）。空串一律当成"没配"，回落到默认值。 */
export function normalizeLocal(raw) {
  const out = { ...LOCAL_DEFAULTS };
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && ['rootDir', 'pythonPath', 'dataDir', 'modelsDir', 'character'].includes(k)) {
      out[k] = v.trim();
      continue;
    }
    out[k] = v;
  }
  out.port = Math.max(1, Math.min(65535, Number(out.port) || LOCAL_DEFAULTS.port));
  for (const k of ['idleShutdownMs', 'startupTimeoutMs', 'timeoutMs']) {
    const n = Number(out[k]);
    out[k] = Number.isFinite(n) && n >= 0 ? n : LOCAL_DEFAULTS[k];
  }
  out.language = ['zh', 'en', 'jp', 'kr'].includes(String(out.language)) ? String(out.language) : 'zh';
  out.enabled = out.enabled === true;
  out.autoStart = out.autoStart !== false;
  out.fallbackToCloud = out.fallbackToCloud !== false;
  return out;
}

/** 所有本地路径一处算清（配置为空 → 全部落在 qq-bridge/python 下，跟着桥一起搬）。 */
export function localPaths(cfg = {}) {
  const c = normalizeLocal(cfg);
  const rootDir = c.rootDir ? path.resolve(c.rootDir) : path.join(ROOT, 'python');
  const venvDir = path.join(rootDir, '.venv');
  const venvPython = isWin
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python');
  const dataDir = c.dataDir ? path.resolve(c.dataDir) : path.join(rootDir, 'GenieData');
  const modelsDir = c.modelsDir ? path.resolve(c.modelsDir) : path.join(rootDir, 'models');
  return {
    cfg: c,
    rootDir,
    venvDir,
    venvPython,
    python: c.pythonPath ? path.resolve(c.pythonPath) : (fs.existsSync(venvPython) ? venvPython : (isWin ? 'python' : 'python3')),
    dataDir,
    modelsDir,
    serverFile: path.join(rootDir, SERVER_FILE_NAME),
    logFile: path.join(STATE_DIR, LOG_FILE_NAME),
    refDir: path.join(STATE_DIR, REF_SUBDIR),
    url: `http://127.0.0.1:${c.port}`
  };
}

// ── 引擎日志（追加到 state/genie.log；超过 1MB 轮转一份 .1） ───────────────────
function engineLog(line) {
  try {
    const p = path.join(STATE_DIR, LOG_FILE_NAME);
    try {
      const st = fs.statSync(p);
      if (st.size > 1024 * 1024) fs.renameSync(p, `${p}.1`);
    } catch { /* 文件不存在或改名失败都不影响写日志 */ }
    fs.appendFileSync(p, `[${new Date().toISOString()}] ${line}\n`);
  } catch { /* 日志写不进去绝不能影响合成 */ }
}

// ── 环境探测 ────────────────────────────────────────────────────────────────

let _probeCache = { at: 0, key: '', value: null };
/** 上一次写进日志的未满足项指纹：避免每次探测都重复写同一条（见 probeLocal 末尾）。 */
let _lastIssueLogKey = '';

function listCharacterDirs(modelsDir) {
  const out = [];
  try {
    for (const entry of fs.readdirSync(modelsDir, { withFileTypes: true })) {
      /* 目录或软链/联接都算：`--add-character` / `--characters` 装出来的角色是 Windows 目录联接
       * （junction），而 `withFileTypes` 对它们报的是 isSymbolicLink、不是 isDirectory —— 只看
       * isDirectory 会把装好的角色全判成"没有角色"（2026-09-28 实测：装完三个角色，--check 仍说
       * 一个都没有，而引擎自己（Python 的 os.path.isdir 会跟随软链）看得见它们）。 */
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const full = path.join(modelsDir, entry.name);
      const hasOnnx = (dir) => {
        try { return fs.readdirSync(dir).some((f) => f.endsWith('.onnx')); } catch { return false; }
      };
      if (hasOnnx(full) || hasOnnx(path.join(full, 'tts_models'))) out.push(entry.name);
    }
  } catch { /* 目录不存在 → 没有角色 */ }
  return out.sort();
}

/** 角色目录里可选的 character.json（装角色时由 tools/genie-setup.mjs 写）：{label, language}。
 * 为什么需要它：语言必须准 —— 未花（mika）是日语角色，从目录名读不出任何线索，引擎会退回默认的 zh，
 * 合成出来是错的；而目录名又要出现在界面下拉里，写成 jp_mika 就难看。 */
function readCharacterMeta(modelsDir, name) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(modelsDir, name, 'character.json'), 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch { return {}; }
}

/** 给管理端界面用的角色清单：[{name, label, language, loaded}]（label 为空时界面显示 name）。 */
function listCharacterInfos(modelsDir, loaded = []) {
  const loadedNames = new Set((loaded ?? []).map((x) => (typeof x === 'string' ? x : x?.name)).filter(Boolean));
  return listCharacterDirs(modelsDir).map((name) => {
    const meta = readCharacterMeta(modelsDir, name);
    return {
      name,
      label: typeof meta.label === 'string' ? meta.label : '',
      language: ['zh', 'jp', 'en', 'kr'].includes(meta.language) ? meta.language : '',
      loaded: loadedNames.has(name)
    };
  });
}

/**
 * 探测引擎是否可用（**同步**，供状态接口/合成前快检用）。
 * 只做能快速判定的事：解释器在不在、genie_tts 能不能 import、数据与模型目录有没有角色。
 * 不在这里拉起进程 —— 那是 ensureServer 的事。
 */
export function probeLocal(cfg = {}, { force = false } = {}) {
  const p = localPaths(cfg);
  /* 【2026-09-28】包里自带 Python 运行时（`<rootDir>\runtime\`）之后，venv 的 `pyvenv.cfg` 里
   * `home` 必须是**绝对路径**才跑得起来，而包里带的是相对占位（否则安装包会写进构建机的用户名路径）。
   * 所以每次探测/启动前按**当前**引擎根纠正一次（幂等，已经对了就一个字节都不写）。
   * `runtime\` 不存在＝使用方本机现网那种老布局，`ensureVenvHome` 直接跳过，绝不动它。 */
  const venvFix = ensureVenvHome(p.rootDir, { log: engineLog });
  if (venvFix.changed) engineLog(`venv 的 pyvenv.cfg 已按当前路径纠正：home = ${venvFix.home}（包里带的是相对占位，Py 解释器只认绝对路径）`);
  const key = [p.python, p.dataDir, p.modelsDir, p.serverFile].join('|');
  if (!force && _probeCache.value && _probeCache.key === key && Date.now() - _probeCache.at < PROBE_TTL_MS) {
    return _probeCache.value;
  }
  /* 未满足项：**只说人话**（界面「查看目标」那一行直接显示 reasons，面向大众的页面上不该出现
   * 解释器路径、目录、安装命令这类运维细节）；技术细节一律降级进引擎日志（state/genie.log）。
   * 判定逻辑一个字没改：缺什么，仍然逐条报什么。 */
  const issues = [];
  const issueDetails = [];
  const addIssue = (code, message, detail = '') => {
    issues.push({ code, message });
    if (detail) issueDetails.push(detail);
  };
  let pythonVersion = '';
  let hasGenie = false;
  let genieVersion = '';

  const serverOk = fs.existsSync(p.serverFile);
  if (!serverOk) addIssue(PROBE_ISSUES.ENGINE_FILES, '缺少语音引擎的运行文件', `引擎运行文件不存在：${p.serverFile}`);

  /* 探测脚本：**故意不 import genie_tts** —— 上游 `Core/Resources.py` 在 GenieData 目录不存在时
   * 会 `input()` 问"要不要自动下载"，非交互环境下就是 EOFError，会把"没下数据"误报成"没装引擎"。
   * 这里只用 find_spec + 包元数据判断"装没装、什么版本"，数据与角色仍由下面的目录检查负责。
   * 兼容垫照样装上：探测结果里要能看出分词后端是不是被替身顶了（见 python/genie_compat.py）。 */
  const probeCode = [
    'import importlib.util, importlib.metadata as md, json, sys',
    `sys.path.insert(0, ${JSON.stringify(path.dirname(p.serverFile))})`,
    'shim = None',
    'try:',
    '    from genie_compat import install_jieba_fast_shim',
    '    shim = install_jieba_fast_shim()',
    'except Exception as _e:',
    '    shim = {"installed": False, "reason": "兼容垫不可用：%s" % _e}',
    'has = importlib.util.find_spec("genie_tts") is not None',
    'ver = ""',
    'if has:',
    '    try: ver = md.version("genie-tts")',
    '    except Exception: ver = "?"',
    'print(json.dumps({"python": sys.version.split()[0], "has": has, "version": ver, "shim": shim}, ensure_ascii=False))',
  ].join('\n');
  const pyProbe = spawnSync(p.python, ['-c', probeCode], {
    encoding: 'utf8', timeout: 60000, windowsHide: true, input: ''
  });
  let jiebaShim = null;
  if (pyProbe.status === 0) {
    let parsed = null;
    try { parsed = JSON.parse(String(pyProbe.stdout || '').trim().split(/\r?\n/).filter(Boolean).slice(-1)[0]); } catch { parsed = null; }
    pythonVersion = parsed?.python || '';
    hasGenie = parsed?.has === true;
    jiebaShim = parsed?.shim ?? null;
    if (hasGenie) genieVersion = parsed?.version || '';
    else addIssue(PROBE_ISSUES.ENGINE_PACKAGE, '语音引擎尚未安装', `解释器 ${p.python} 里没有 genie_tts（装：node tools/genie-setup.mjs --install）`);
  } else {
    addIssue(PROBE_ISSUES.RUNTIME, '缺少运行环境', `解释器 ${p.python} 用不了：${String(pyProbe.stderr || pyProbe.error?.message || '').trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] || '未安装'}`);
  }

  // GenieData：至少要有 hubert / speaker_encoder / G2P 三个之一才算"数据在"
  let dataOk = false;
  try {
    const entries = fs.readdirSync(p.dataDir).map((s) => s.toLowerCase());
    dataOk = entries.length > 0 && entries.some((e) => e.includes('hubert') || e.includes('speaker_encoder') || e === 'g2p');
    if (!dataOk) addIssue(PROBE_ISSUES.PUBLIC_DATA, '公共数据不完整', `数据目录里没有可用资产：${p.dataDir}（下载：node tools/genie-setup.mjs --download）`);
  } catch {
    addIssue(PROBE_ISSUES.PUBLIC_DATA, '缺少公共数据', `数据目录不存在：${p.dataDir}`);
  }

  const characters = listCharacterDirs(p.modelsDir);
  if (!characters.length) addIssue(PROBE_ISSUES.CHARACTERS, '缺少角色模型', `角色目录里没有任何可用角色：${p.modelsDir}（装：node tools/genie-setup.mjs --convert）`);

  /* 技术细节只写日志，而且同一种"缺什么"只写一次 —— 这个探测每次打开语音页都会跑，
   * 不去重就会把 genie.log 刷满。 */
  const detailKey = issues.length ? issues.map((i) => i.code).join(',') + '｜' + issueDetails.join(' | ') : '';
  if (!detailKey) _lastIssueLogKey = '';
  else if (detailKey !== _lastIssueLogKey) { _lastIssueLogKey = detailKey; engineLog(`环境探测未满足项（${issues.map((i) => i.code).join('/')}）：${issueDetails.join(' | ')}`); }

  const reasons = issues.map((i) => i.message);

  const value = {
    enabled: p.cfg.enabled === true,
    ready: Boolean(serverOk && hasGenie && dataOk && characters.length),
    python: p.python,
    pythonVersion,
    hasGenie,
    genieVersion,
    dataOk,
    characters,
    reasons,
    /* issues 是 reasons 的结构化版本（同序、一一对应）：`{ code, message }`。
     * reasons（字符串数组）形状不变，界面照旧直接用；调用方要判"缺哪一类"时读 issues 的 code。 */
    issues,
    jiebaShim,
    paths: {
      rootDir: p.rootDir, serverFile: p.serverFile, dataDir: p.dataDir,
      modelsDir: p.modelsDir, logFile: p.logFile, refDir: p.refDir, url: p.url
    }
  };
  _probeCache = { at: Date.now(), key, value };
  return value;
}

// ── 进程生命周期 ────────────────────────────────────────────────────────────

let _child = null;
let _starting = null;
let _idleTimer = null;
let _lastHealth = null;
/** stopServer 要知道端口才能请它自己退出（每次合成都会刷新它）。 */
let _lastCfgForStop = {};

async function healthOnce(url, timeoutMs = 2000) {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** 引擎进程是否在跑（带一次 /health 实测，不只看 pid）。 */
export async function serverStatus(cfg = {}) {
  const p = localPaths(cfg);
  const h = await healthOnce(p.url);
  if (h) _lastHealth = h;
  return {
    running: Boolean(h),
    pid: h?.pid ?? (_child?.pid ?? null),
    rssMb: h?.rssMb ?? null,
    bootMs: h?.bootMs ?? null,
    loaded: h?.loaded ?? [],
    url: p.url,
    health: h
  };
}

function touchIdle(c) {
  if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
  const ms = Number(c.idleShutdownMs) || 0;
  if (ms <= 0) return;                       // 0 = 常驻，不回收
  _idleTimer = setTimeout(() => { void stopServer().catch(() => {}); }, ms);
  if (typeof _idleTimer.unref === 'function') _idleTimer.unref();
}

function spawnServer(p) {
  const c = p.cfg;
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch { /* 已有则忽略 */ }
  /* spawn 之前最后一道关：`pyvenv.cfg` 的 `home` 不对，解释器连启动都做不到（exit=103）。 */
  const venvFix = ensureVenvHome(p.rootDir, { log: engineLog });
  if (venvFix.changed) engineLog(`venv 的 pyvenv.cfg 已按当前路径纠正：home = ${venvFix.home}`);
  else if (venvFix.error) engineLog(`⚠️ venv 的 pyvenv.cfg 纠正失败（引擎可能起不来）：${venvFix.error}`);
  let out = null;
  try { out = fs.openSync(p.logFile, 'a'); } catch { out = 'ignore'; }
  const args = [
    p.serverFile,
    '--host', '127.0.0.1',
    '--port', String(c.port),
    '--data-dir', p.dataDir,
    '--models-dir', p.modelsDir,
    '--language', c.language
  ];
  if (c.character) args.push('--character', c.character);
  const child = spawn(p.python, args, {
    cwd: p.rootDir,
    stdio: ['ignore', out, out],
    windowsHide: true,
    env: {
      ...process.env,
      GENIE_DATA_DIR: p.dataDir,
      PYTHONUNBUFFERED: '1',
      PYTHONIOENCODING: 'utf-8',
      /* 上游 ModelManager 用 LRU 缓存已加载的角色模型，默认**同时缓存 3 个角色**；每个角色
       * 是一整套 ONNX（加载时还要把 fp16 权重在内存里升成 fp32 再序列化，峰值远高于常驻）。
       * 这里压到 1：本引擎是"按需合成"的旁路服务，缓存 3 个角色纯属浪费内存、只省一点点
       * 换角色的加载时间。想反悔就设 GENIE_MAX_CACHED_MODELS，别改代码。 */
      Max_Cached_Character_Models: String(process.env.GENIE_MAX_CACHED_MODELS || 1)
    }
  });
  child.on('error', (e) => engineLog(`进程启动失败：${e?.message ?? e}`));
  child.on('exit', (code, sig) => {
    engineLog(`进程退出 code=${code} signal=${sig ?? ''}`);
    if (_child === child) _child = null;
  });
  engineLog(`已拉起：${p.python} ${args.join(' ')}（cwd=${p.rootDir}）`);
  return child;
}

/**
 * 确保引擎在跑（幂等：并发调用共用同一个启动 Promise）。
 * 启动失败一律抛错并带上最后一条引擎日志 —— 调用方（voice.js）据此决定要不要回落云端。
 */
export async function ensureServer(cfg = {}) {
  const p = localPaths(cfg);
  const c = p.cfg;
  const h = await healthOnce(p.url);
  if (h) { _lastHealth = h; touchIdle(c); return { started: false, url: p.url, health: h }; }
  if (_starting) return _starting;

  const probe = probeLocal(cfg);
  if (!probe.ready) throw new Error(`本地语音引擎不可用：${probe.reasons.join('；')}`);

  _starting = (async () => {
    if (_child && _child.exitCode === null) { try { _child.kill(); } catch { /* 已死 */ } }
    _child = spawnServer(p);
    const deadline = Date.now() + (Number(c.startupTimeoutMs) || 120000);
    let lastErr = '';
    while (Date.now() < deadline) {
      if (_child && _child.exitCode !== null) {
        lastErr = lastLogTail();
        throw new Error(`本地语音引擎启动后立刻退出（code=${_child.exitCode}）：${lastErr}`);
      }
      const hh = await healthOnce(p.url, 1500);
      if (hh) { _lastHealth = hh; touchIdle(c); return { started: true, url: p.url, health: hh }; }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`本地语音引擎启动超时（${Math.round((Number(c.startupTimeoutMs) || 120000) / 1000)}s）：${lastLogTail()}`);
  })();

  try {
    return await _starting;
  } finally {
    _starting = null;
  }
}

function lastLogTail(lines = 6) {
  try {
    const txt = fs.readFileSync(path.join(STATE_DIR, LOG_FILE_NAME), 'utf8').trim().split(/\r?\n/);
    return txt.slice(-lines).join(' | ');
  } catch { return '（读不到引擎日志）'; }
}

/** 关掉引擎进程（空闲回收 / 桥退出 / 命令行 --stop 都用它）。没在跑就当成功。
 *
 * 两种"在跑"都要能关掉：
 *   ① 本进程拉起的（`_child` 在手上）—— 发 `/shutdown` 请它干净收尾，超时再强杀；
 *   ② **别的进程拉起的**（上一次桥崩了留下的、或手工 `python genie_server.py` 起的）——
 *      这是 `--stop` 最常见的场景，而它 `_child` 是空的：只看 `_child` 会得出
 *      "引擎本来就没在跑"这种当场可证伪的结论（2026-09-28 实测踩到）。
 *      所以退一步：探 `/health`，确认 `service === 'kizuna-genie-tts'`（认身份，别把别的
 *      服务当自家引擎关掉）再发 `/shutdown`，然后看它是否真的消失。
 */
export async function stopServer({ waitMs = 3000, cfg = null } = {}) {
  if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
  const child = _child;
  const p = localPaths(cfg || _lastCfgForStop || {});
  if (!child || child.exitCode !== null) {
    _child = null;
    const h = await healthOnce(p.url);
    if (!h || h.service !== 'kizuna-genie-tts') return { stopped: false, external: false };
    await fetch(`${p.url}/shutdown`, { method: 'POST', signal: AbortSignal.timeout(2000) }).catch(() => {});
    const t0 = Date.now();
    while (Date.now() - t0 < waitMs) {
      if (!(await healthOnce(p.url, 800))) return { stopped: true, external: true, pid: h.pid ?? null };
      await new Promise((r) => setTimeout(r, 120));
    }
    return { stopped: false, external: true, pid: h.pid ?? null, reason: '请它退出后仍然在响应' };
  }
  try {
    // 先礼貌请它自己退（uvicorn 干净收尾、释放 ONNX 会话），超时再强杀
    await fetch(`${p.url}/shutdown`, { method: 'POST', signal: AbortSignal.timeout(1500) }).catch(() => {});
    const t0 = Date.now();
    while (Date.now() - t0 < waitMs && child.exitCode === null) await new Promise((r) => setTimeout(r, 100));
  } catch { /* 走到下面强杀 */ }
  if (child.exitCode === null) {
    try { child.kill(); } catch { /* 已死 */ }
    engineLog('优雅退出超时，已强杀');
  }
  _child = null;
  _lastHealth = null;
  return { stopped: true };
}

/** 桥退出时调用：不等优雅收尾，直接杀。 */
export function killServerSync() {
  if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
  if (_child && _child.exitCode === null) { try { _child.kill(); } catch { /* 已死 */ } }
  _child = null;
}

// ── 参考音频（复刻样本）落盘 ────────────────────────────────────────────────

/** 把一段音频样本写到 state/genie-refs/<sha1>.<ext>（同内容只写一次），返回磁盘路径。 */
export function writeReference(cfg, buf, { ext = 'mp3' } = {}) {
  if (!buf || !buf.length) return '';
  const p = localPaths(cfg);
  fs.mkdirSync(p.refDir, { recursive: true });
  const sha = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 20);
  const file = path.join(p.refDir, `${sha}.${String(ext).replace(/[^a-z0-9]/gi, '') || 'mp3'}`);
  if (!fs.existsSync(file) || fs.statSync(file).size !== buf.length) fs.writeFileSync(file, buf);
  return file;
}

/** 从 data:audio/...;base64,xxx 里取出字节（clone 模式的样本就是这么来的）。 */
export function decodeDataUrl(dataUrl) {
  const s = String(dataUrl ?? '');
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/i.exec(s);
  if (!m) return { buf: Buffer.from(s, 'base64'), mime: '' };
  const isB64 = Boolean(m[2]);
  return {
    buf: isB64 ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'binary'),
    mime: m[1] || ''
  };
}

// ── 合成 ────────────────────────────────────────────────────────────────────

/**
 * 本地合成一段文本。
 * @returns {Promise<{ok:true, buf:Buffer, mime:string, format:string, ms:number, rssMb:number|null, character:string, serverStarted:boolean}>}
 */
export async function synthesizeLocal({
  cfg = {}, text, character = '', language = '', referenceAudio = '', referenceText = '', format = 'wav'
} = {}) {
  const p = localPaths(cfg);
  const c = p.cfg;
  _lastCfgForStop = cfg;
  const want = String(text ?? '').trim();
  if (!want) throw new Error('本地合成：文本为空');

  const { started, health } = await ensureServer(cfg);
  const chars = (health?.characters ?? []).map((x) => x.name);
  const pick = String(character || c.character || '').trim();
  const chosen = pick && chars.includes(pick) ? pick
    : (chars.includes(String(character || '').trim()) ? String(character).trim()
      : (c.character && chars.includes(c.character) ? c.character : (chars[0] || '')));
  if (!chosen) throw new Error(`本地合成：没有可用角色（${p.modelsDir} 下没有带 .onnx 的角色目录）`);

  const body = {
    character: chosen,
    text: want,
    language: language || c.language,
    reference_audio: referenceAudio || '',
    reference_text: referenceText || '',
    format
  };
  const t0 = Date.now();
  const res = await fetch(`${p.url}/tts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Number(c.timeoutMs) || 180000)
  });
  if (!res.ok) {
    let detail = '';
    try { detail = String((await res.json())?.detail ?? ''); } catch { detail = await res.text().catch(() => ''); }
    throw new Error(`本地引擎 HTTP ${res.status}：${String(detail).slice(0, 300)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('本地引擎返回了空音频');
  const ms = Number(res.headers.get('x-genie-ms')) || (Date.now() - t0);
  const rssMb = Number(res.headers.get('x-genie-rss-mb')) || health?.rssMb || null;
  touchIdle(c);
  engineLog(`合成完成：角色=${chosen} 文本=${want.length}字 音频=${buf.length}字节 ${ms}ms 内存=${rssMb}MB`);
  return { ok: true, buf, mime: res.headers.get('content-type') || 'audio/wav', format, ms, rssMb, character: chosen, serverStarted: started };
}

/** 供 /api/voice/local 状态接口一次性取全（探测 + 进程 + 最近一次读数）。 */
export async function localState(cfg = {}, { force = false } = {}) {
  const probe = probeLocal(cfg, { force });
  const status = await serverStatus(cfg);
  return {
    ok: true,
    engine: 'genie',
    enabled: probe.enabled,
    ready: probe.ready,
    running: status.running,
    pid: status.pid,
    rssMb: status.rssMb ?? _lastHealth?.rssMb ?? null,
    /* characters 保持字符串数组（旧界面在用）；characterList 是给界面下拉用的对象数组
     * （带中文 label 与语言，2026-09-28 加"角色要能在界面里选、能试听"时补的）。 */
    characters: probe.characters,
    characterList: listCharacterInfos(probe.paths.modelsDir, status.loaded),
    loaded: status.loaded,
    python: probe.python,
    pythonVersion: probe.pythonVersion,
    /* 分词后端：装不上真的 jieba_fast（PyPI 上只有源码包、要 C 编译器）时，引擎实际跑的是
     * python/genie_compat.py 顶上来的纯 jieba。这是"被替换过的依赖"，界面里要看得见。 */
    jiebaShim: probe.jiebaShim ?? null,
    reasons: probe.reasons,
    paths: probe.paths
  };
}
