// tools/genie-setup.mjs —— 本地语音引擎（Genie / GPT-SoVITS ONNX）的一键安装与自检（2026-09-28 新增）
//
// 这个脚本解决的唯一问题：**"内置"到底内置了什么、装在哪、装没装成功**。
// 桥内置的本地合成能力（core/voice.js + src/lib/genie-tts.js + python/genie_server.py）本身
// 不含任何第三方二进制；它需要三样外来的东西，缺一样都跑不起来，本脚本负责把它们逐样装齐并当场验证：
//   ① 引擎运行时 —— 一个装好 `genie-tts` 的 Python 虚拟环境（默认 <qq-bridge>/python/.venv）；
//   ② 引擎公共数据 —— GenieData（hubert / speaker_encoder / 文本前端），上游首次运行会自动下载 ~391MB；
//   ③ 角色音色模型 —— 每个角色一个带 .onnx 的目录（GPT-SoVITS V2 / V2ProPlus 转换而来）。
//
// 授权与合规（重要，别踩）：
//   · 引擎代码 MIT（High-Logic/Genie-TTS），GenieData 所在 HF 仓（High-Logic/Genie）标注 license: mit；
//   · 上游自带的**预置角色**（菲比 / 未花 / 三七，来自鸣潮 / 蔚蓝档案 / 重返未来：1999）是第三方 IP 的音色克隆：
//     **随产品分发出去就是侵权** —— 分发只带①②，角色模型让用户自己用自己的（自己的声音 / 自己合法持有的模型）；
//     本机自用则可以显式装：`--characters` 就是干这个的，**默认不跑**，只有明确点名才会去下
//     （2026-09-28 主人要求"把角色装齐"之后改的口径，之前是连入口都不给）。
//     【2026-09-28 晚 使用方决定】使用方（项目作者）明确决定：**这三个角色的模型要随安装包分发**，
//     并已知悉它们是第三方 IP 的音色克隆、随包分发的权利责任由其本人承担。为此本脚本加了 `--bundle`
//     （把 models/<角色> 从 junction 换成真实目录拷贝）—— 上面的法律提示保留，供后来者知情。
//
// 安装期的一个已知坑（本脚本已处理，别手动绕）：上游硬依赖 `jieba_fast`（jieba 的 C 加速分支），
//   它在 PyPI 上只有源码包，装它要当场调 C 编译器 —— 没有编译器的机器上 pip 会在源码构建里卡死，
//   有编译器但构建失败时又会把整个 genie-tts 一起回滚。两种表现都像"引擎根本装不了"。
//   本脚本的做法：先只允许预编译包（缺 wheel 会立刻明确报错，而不是无限期挂着），失败就改走两段式
//   （只装本体 → 按元数据逐条装依赖、跳过 jieba_fast → 补装纯 jieba），由 python/genie_compat.py
//   在导入期用纯 jieba 顶替 jieba_fast（API 与分词质量一致，只是慢一点）。
//
// 用法（在 qq-bridge 目录下跑，或带上完整路径）：
//   node tools/genie-setup.mjs                     # = --check：看现在缺什么
//   node tools/genie-setup.mjs --install           # 建 venv + pip install genie-tts
//   node tools/genie-setup.mjs --download          # 下载 GenieData（~391MB，含可选中文 RoBERTa）
//   node tools/genie-setup.mjs --characters         # 装上游预置角色（菲比/未花/三七，约 950MB，第三方 IP 仅供自用）
//   node tools/genie-setup.mjs --bundle             # 【实体化】把 models/<角色> 从 junction 换成真实目录拷贝
//   node tools/genie-setup.mjs --characters --bundle # 下完角色顺手实体化（默认仍是 junction，省磁盘）
//   node tools/genie-setup.mjs --add-character <目录> [名字]   # 把一个已转换好的角色接进 models/
//   node tools/genie-setup.mjs --convert a.pth a.ckpt <名字>   # 从 GPT-SoVITS 原始模型转换（需要 torch）
//   node tools/genie-setup.mjs --smoke "你好呀"     # 拉起引擎真合成一句，报耗时与内存读数
//   node tools/genie-setup.mjs --stop              # 关掉引擎进程
// 通用参数：--root <目录>（引擎根目录，默认 qq-bridge/python）、--python <解释器>、--version <版本>
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureVenvHome } from '../src/lib/genie-venv-home.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_ROOT = path.resolve(HERE, '..');

// ── 参数 ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name, def = '') => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const has = (name) => argv.includes(`--${name}`);
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
const CMD = ['check', 'install', 'download', 'characters', 'add-character', 'convert', 'smoke', 'stop', 'bundle'].find((c) => has(c)) || 'check';

const engineRoot = path.resolve(flag('root', path.join(BRIDGE_ROOT, 'python')));
const pyOverride = flag('python', '');
const wantVersion = flag('version', '2.0.2');
const modelVersion = flag('model-version', 'v2ProPlus');   // 角色模型版本（上游仓里是 CharacterModels/<版本>/<角色>）
const isWin = process.platform === 'win32';
const venvDir = path.join(engineRoot, '.venv');
const venvPython = isWin ? path.join(venvDir, 'Scripts', 'python.exe') : path.join(venvDir, 'bin', 'python');
const GENIE_DATA_DIR = path.join(engineRoot, 'GenieData');
const modelsDir = path.join(engineRoot, 'models');

const log = (...a) => console.log(...a);
const ok = (s) => log(`  [OK]   ${s}`);
const bad = (s) => log(`  [缺]   ${s}`);
const info = (s) => log(`  [i]    ${s}`);

/* 【2026-09-28】自带 Python 运行时的新布局：包里 `<引擎根>\runtime\` 是真 Python，
 * 而 `.venv\pyvenv.cfg` 带出去的是**相对占位**（`home = ..\runtime`，为了不含构建机用户名路径），
 * 解释器只认绝对路径 —— 所以任何命令在用到 venvPython 之前，先按当前引擎根纠正一次（幂等）。
 * `runtime\` 不存在的老布局（比如主人现网那份）这里什么都不做。 */
const venvFix = ensureVenvHome(engineRoot, { log: (m) => info(m) });
if (venvFix.changed) info(`已按当前引擎根纠正 .venv\\pyvenv.cfg：home = ${venvFix.home}（包里带的是相对占位）`);
else if (venvFix.error) bad(`.venv\\pyvenv.cfg 纠正失败，解释器可能起不来：${venvFix.error}`);

function runCmd(cmd, args, { inherit = false, env = null, cwd = BRIDGE_ROOT } = {}) {
  const r = spawnSync(cmd, args, {
    cwd, encoding: 'utf8', timeout: 3600000, windowsHide: true,
    stdio: inherit ? 'inherit' : 'pipe',
    /* input: '' 很关键：上游（以及若干 G2P 库）会在资源缺失时 `input()` 问问题，
     * 非交互环境下必须立刻得到 EOF，否则子进程会一直挂着等输入（比报错更难查）。 */
    input: inherit ? undefined : '',
    env: env ? { ...process.env, ...env } : process.env
  });
  return { status: r.status, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? ''), error: r.error };
}

/* 国内网络的两个现实问题（2026-09-28 实测踩到）：
 *   ① pypi.org 直连会 SSL EOF（本机就是），即使连上也只有 ~80kB/s（下一个 76.9MB 的日语词典要十几分钟），
 *      所以**镜像优先、官方放最后**——这个工具是给国内用户装的，官方源在他们的网络里通常是最差的一条；
 *   ② huggingface.co 在国内多半连不上，GenieData 要走 hf-mirror.com（HF_ENDPOINT 环境变量）。
 * 两个下载步骤都是"逐个源试，成功即停"，并允许 --index / --hf-endpoint 显式指定。 */
const PIP_MIRRORS = [
  { name: '清华 TUNA', url: 'https://pypi.tuna.tsinghua.edu.cn/simple' },
  { name: '阿里云', url: 'https://mirrors.aliyun.com/pypi/simple/' },
  { name: '中科大', url: 'https://mirrors.ustc.edu.cn/pypi/simple' },
  { name: '官方 pypi', url: '' }
];
const HF_MIRRORS = [
  { name: 'hf-mirror.com', env: { HF_ENDPOINT: 'https://hf-mirror.com' } },
  { name: '官方 huggingface.co', env: {} }
];

function dirSizeMb(dir) {
  let total = 0;
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { try { total += fs.statSync(p).size; } catch { /* 忽略 */ } }
    }
  };
  walk(dir);
  return Math.round(total / 1048576 * 10) / 10;
}

/** 上游预置角色（High-Logic/Genie 仓的 CharacterModels/<版本>/<角色>）。
 * 装的时候会在角色目录里写一份 character.json —— **语言必须声明**：未花是日语角色，光看目录名 'mika'
 * 引擎读不出线索会按中文合成（文本前端走错语言，出来是废音）；而目录名要干净（界面下拉显示的是 label）。 */
const PREDEFINED = [
  { name: 'feibi', label: '菲比（中文）', language: 'zh', ip: '鸣潮' },
  { name: 'mika', label: '未花（日语）', language: 'jp', ip: '蔚蓝档案' },
  { name: 'thirtyseven', label: '三七（英语）', language: 'en', ip: '重返未来：1999' }
];

function charaMeta(name) {
  try { return JSON.parse(fs.readFileSync(path.join(modelsDir, name, 'character.json'), 'utf8')) ?? {}; } catch { return {}; }
}

function charaDisplay(name) {
  const m = charaMeta(name);
  return typeof m?.label === 'string' && m.label ? `${m.label}[${name}]` : name;
}

/** 只看"数据目录里有没有像样的资产"（与 src/lib/genie-tts.js 的 probeLocal 同一口径）。 */
function dataLooksReady() {
  try {
    const entries = fs.readdirSync(GENIE_DATA_DIR).map((s) => s.toLowerCase());
    return entries.length > 0 && entries.some((e) => e.includes('hubert') || e.includes('speaker_encoder') || e === 'g2p');
  } catch { return false; }
}

function resolvePython() {
  const c = pyOverride || (fs.existsSync(venvPython) ? venvPython : (isWin ? 'python' : 'python3'));
  const r = runCmd(c, ['-c', 'import sys;print("%d.%d.%d" % sys.version_info[:3])']);
  if (r.status !== 0) return { exe: c, version: '', okPy: false };
  return { exe: c, version: r.stdout.trim(), okPy: true };
}

/* 所有 `python -c` 片段都要先吃一口兼容垫（python/genie_compat.py）：
 * 上游硬依赖 jieba_fast，而它在 PyPI 上只有源码包 —— 没有 C 编译器的机器装不上，
 * 于是"引擎装没装好"会被这条无关紧要的缺口误判。缺了就顶上纯 Python 的 jieba。 */
function shimPrelude() {
  return [
    'import sys',
    `sys.path.insert(0, ${JSON.stringify(engineRoot)})`,
    'try:',
    '    from genie_compat import install_jieba_fast_shim',
    '    _shim = install_jieba_fast_shim()',
    '    if _shim.get("installed"): print("SHIM: " + _shim.get("reason", ""))',
    'except Exception as _e:',
    '    print("SHIM_WARN: %s" % _e)'
  ];
}

/** 只取"常用名"：pip 的 requirement 串里带版本号/环境标记，比较名字时要剥掉。 */
function reqName(req) {
  return String(req).split(';')[0].trim().split(/[<>=!~\[]/)[0].trim().toLowerCase().replace(/_/g, '-');
}

// ── --check ─────────────────────────────────────────────────────────────────
async function doCheck() {
  const g = await import('../src/lib/genie-tts.js');
  const probe = g.probeLocal({ rootDir: engineRoot }, { force: true });
  log(`\n本地语音引擎自检（引擎根目录 ${engineRoot}）\n`);
  log('① Python 运行时');
  const py = resolvePython();
  if (py.okPy) ok(`${py.exe}（Python ${py.version}）${py.version.startsWith('3.1') || py.version.startsWith('3.9') ? ' —— 需要 >= 3.10' : ''}`);
  else bad(`找不到可用的 Python 解释器（${py.exe}）—— 先装 Python 3.10~3.13，再用 --install`);
  if (fs.existsSync(venvDir)) ok(`虚拟环境已建：${venvDir}（${dirSizeMb(venvDir)} MB）`);
  else bad(`虚拟环境未建：${venvDir} —— node tools/genie-setup.mjs --install`);

  log('\n② 引擎包（genie-tts）');
  if (probe.hasGenie) {
    ok(`已安装：${probe.python} → genie_tts ${probe.genieVersion || '?'}`);
    const shimLine = probe.jiebaShim?.installed ? probe.jiebaShim.reason : null;
    if (shimLine) info(`分词后端：${shimLine}`);
    else if (probe.jiebaShim && /都不可用/.test(probe.jiebaShim.reason || '')) {
      bad(`${probe.jiebaShim.reason} —— 装上纯 jieba 即可：${probe.python} -m pip install jieba`);
    }
    /* 数据齐了才做完整导入：`import genie_tts` 会顺带校验 hubert / speaker_encoder 是否在位，
     * 那正是"端到端能不能起来"的证明；数据没齐就别去碰它（会走交互分支问你要不要下载）。 */
    if (probe.dataOk) {
      /* 必须把 GENIE_DATA_DIR 显式给子进程：上游默认是 `./GenieData`（**相对进程 cwd**）——
       * 不给就会去 qq-bridge/GenieData 找、找不到就 `input()` 问你要不要下载，非交互下报 EOFError，
       * 让人以为"引擎装坏了"。sidecar 里也是同一件事（genie_server.py 导入前设这个变量）。 */
      const imp = runCmd(probe.python, ['-c', [...shimPrelude(), 'import genie_tts', 'print("IMPORT_OK")'].join('\n')],
        { env: { GENIE_DATA_DIR } });
      if (imp.status === 0 && /IMPORT_OK/.test(imp.stdout)) ok('完整导入通过（genie_tts 已能加载，含数据与文本前端）');
      else bad(`完整导入失败：${(imp.stderr || imp.stdout || '').trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] || '原因未知'}`);
    } else info('数据还没齐，本次跳过完整导入校验（先 --download）');
  } else bad(`未安装 —— node tools/genie-setup.mjs --install（${probe.reasons.find((r) => r.includes('genie_tts')) ?? ''}）`);

  log('\n③ 引擎公共数据（GenieData）');
  if (probe.dataOk) ok(`${GENIE_DATA_DIR}（${dirSizeMb(GENIE_DATA_DIR)} MB）`);
  else bad(`${GENIE_DATA_DIR} 不存在或不完整 —— node tools/genie-setup.mjs --download`);

  log('\n④ 角色音色模型');
  if (probe.characters.length) ok(`可用角色 ${probe.characters.length} 个：${probe.characters.map((n) => charaDisplay(n)).join('、')}`);
  else bad(`${modelsDir} 下没有带 .onnx 的角色目录 —— --characters 装上游预置角色，或 --add-character <目录> / --convert <pth> <ckpt> <名字> 接自己的`);

  log('\n⑤ 桥侧状态');
  const st = await g.serverStatus({ rootDir: engineRoot }).catch(() => null);
  if (st?.running) ok(`引擎进程在跑：pid=${st.pid} 内存=${st.rssMb ?? '?'}MB 已加载角色=${(st.loaded || []).map((x) => x.name).join('、') || '（无）'}`);
  else info('引擎进程未运行（合成时按需自动拉起；也可以 --smoke 现在就试）');

  log(`\n结论：${probe.ready ? '三样齐了，把管理端「语音」页的「本地引擎」打开即可用。' : '还有缺项，按上面的提示逐条补齐。'}`);
  if (probe.reasons.length) log(`未满足项：${probe.reasons.join('；')}\n`); else log('');
  return probe.ready ? 0 : 1;
}

// ── --install ───────────────────────────────────────────────────────────────
function doInstall() {
  const py = resolvePython();
  if (!py.okPy) { bad(`没有可用的 Python（${py.exe}）。先装 Python 3.10~3.13（https://www.python.org/downloads/），重开后重试`); return 2; }
  const [maj, min] = py.version.split('.').map(Number);
  if (maj < 3 || (maj === 3 && min < 10)) { bad(`Python ${py.version} 太旧，引擎要求 >= 3.10`); return 2; }
  log(`\n用 ${py.exe}（Python ${py.version}）在 ${venvDir} 建虚拟环境`);

  if (!fs.existsSync(venvPython)) {
    const r = runCmd(py.exe, ['-m', 'venv', venvDir], { inherit: true });
    if (r.status !== 0) { bad('建虚拟环境失败（看上面 venv 的输出）'); return 3; }
    ok('虚拟环境已建');
  } else ok('虚拟环境已存在，直接复用');

  log('\n安装引擎包（第一次要下载约 200MB 的 onnxruntime，慢是正常的）');
  const pkg = wantVersion ? `genie-tts==${wantVersion}` : 'genie-tts';
  runCmd(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip'], { inherit: true });   // 失败不致命，继续
  const explicitIndex = flag('index', '');
  const tried = explicitIndex ? [{ name: explicitIndex, url: explicitIndex }] : PIP_MIRRORS;

  /** 按源逐个重试一条 pip 命令；返回 true 表示某一路装成功。
   * 统一加 --timeout / --retries：本机实测遇到过"连接卡死但进程不退出"（占着 venv 锁十几分钟
   * 一个字节都没动），靠 pip 默认超时等不到结论，必须让它自己放弃并换源。 */
  function pipTry(args, label) {
    for (const m of tried) {
      const full = [...args, '--timeout', '20', '--retries', '2'];
      if (m.url) full.push('--index-url', m.url);
      log(`\n→ 用「${m.name}」${label}${m.url ? `（${m.url}）` : ''}`);
      const r = runCmd(venvPython, full, { inherit: true });
      if (r.status === 0) { ok(`${label} 完成（来源：${m.name}）`); return true; }
      info(`「${m.name}」失败${explicitIndex ? '' : '，换下一个镜像重试'}`);
    }
    return false;
  }

  let installed = pipTry(['-m', 'pip', 'install', pkg, '--only-binary', ':all:'],
    `安装 ${pkg}（只允许预编译包）`);

  /* 整包装不上时走"拆开装"的降级路径 —— 2026-09-28 在本机实测到的真实成因：
   * 依赖里的 `jieba_fast` 在 PyPI 上**只有源码包**，装它要当场调用 C 编译器。
   * 没有编译器的机器上，pip 会在源码构建里**卡死**（实测占着 venv 锁十几分钟零字节进展，
   * 连 Ctrl 都等不到结论），或有编译器但构建失败后把**整个** genie-tts 一起回滚 ——
   * 两种表现都会让人误判成"引擎根本装不了"。所以第一步就加 `--only-binary :all:`：
   * 只允许预编译包，于是"缺 wheel"这件事会**立刻**变成一条明确的错误（而是不是无限期挂着）。
   * jieba_fast 只是 jieba 的加速分支、API 与分词质量完全一致（替身见 python/genie_compat.py），
   * 为它放弃整个引擎显然不划算：改用两段式 —— 先只装本体（--no-deps），
   * 再从它自己的元数据里读出依赖清单逐条装，跳过 jieba_fast、补装纯 jieba。 */
  if (!installed) {
    info('没有可用的预编译整包 —— 改走降级路径：先装本体，再逐条装依赖（跳过需要 C 编译器的 jieba_fast）');
    installed = pipTry(['-m', 'pip', 'install', '--no-deps', pkg], `只装 ${pkg} 本体`);
    if (!installed) {
      bad('所有源都装不上。可手动指定：node tools/genie-setup.mjs --install --index https://你的镜像/simple');
      return 4;
    }
    const meta = runCmd(venvPython, ['-c',
      'import importlib.metadata as m,json;print(json.dumps(m.requires("genie-tts") or []))']);
    let reqs = [];
    try { reqs = JSON.parse(meta.stdout.trim() || '[]'); } catch { reqs = []; }
    if (!reqs.length) info('读不到依赖清单（元数据缺失），改用手工清单：只保证本体 + jieba 装上');
    const skip = new Set(['jieba-fast']);   // 需要 C 编译器；由 genie_compat.py 的兼容垫顶替
    const wanted = reqs
      .filter((r) => !/;\s*extra\s*=/.test(r))              // 与本项目无关的可选依赖（如 gui 的 PySide6）
      .filter((r) => !skip.has(reqName(r)));
    log(`\n依赖清单 ${reqs.length} 条，实际安装 ${wanted.length} 条（跳过：${[...skip].join('、')}）`);
    const failedDeps = [];
    for (const req of wanted) {
      const one = pipTry(['-m', 'pip', 'install', req], `装依赖 ${req}`);
      if (!one) failedDeps.push(req);
    }
    // 兼容垫的本体：纯 Python 的 jieba（jieba_fast 的替身要靠它）
    pipTry(['-m', 'pip', 'install', 'jieba'], '装兼容垫依赖 jieba（纯 Python，替 jieba_fast）');
    if (failedDeps.length) {
      info(`以下依赖没装上（引擎可能缺少对应语种的前端，中文不受影响）：${failedDeps.join('、')}`);
    }
  }

  /* 校验分两级，因为"能不能 import"取决于数据下没下：
   *   · 没下数据时只校验**依赖链**（本体在不在 + 关键依赖能不能各自 import）—— 这已经足够回答
   *     "装成功了吗"，而且不会碰到上游那个"数据缺失就 input() 问你要不要下载"的交互分支；
   *   · 数据齐了才做完整 `import genie_tts`（那才是端到端可导入的证明）。 */
  const dataReady = dataLooksReady();
  const verifyCode = [
    ...shimPrelude(),
    'import importlib.util as iu, importlib.metadata as md',
    'assert iu.find_spec("genie_tts") is not None, "genie_tts 本体不在"',
    'print("VERSION", md.version("genie-tts"))',
    ...(dataReady ? ['import genie_tts  # noqa', 'print("IMPORT_OK")'] : []),
    'mods = ["onnxruntime", "tokenizers", "soundfile", "numpy", "jieba", "pypinyin", "g2pM", "nltk", "pyopenjtalk", "fastapi", "uvicorn"]',
    'bad = []',
    'for m in mods:',
    '    try: __import__(m)',
    '    except Exception as e: bad.append("%s(%s)" % (m, type(e).__name__))',
    'print("DEPS_BAD", ",".join(bad) if bad else "-")'
  ].join('\n');
  const v = runCmd(venvPython, ['-c', verifyCode]);
  if (v.status !== 0) {
    bad(`装完了但校验失败：${(v.stderr || v.stdout || '').trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] || '原因未知'}`);
    info('把上面这行报错发出来即可定位；常见是某个依赖没装上或缺 C 运行库');
    return 5;
  }
  ok(`校验：genie_tts ${(v.stdout.match(/VERSION\s+(.+)/) || [])[1]?.trim() || '?'}${dataReady ? '（含完整导入）' : ''}`);
  const shimLine = (v.stdout.match(/SHIM: (.+)/) || [])[1];
  if (shimLine) info(shimLine.trim());
  const depsBad = (v.stdout.match(/DEPS_BAD\s+(.+)/) || [])[1]?.trim();
  if (depsBad && depsBad !== '-') {
    info(`这些依赖没能导入（对应语种的前端会不可用，中文一般不受影响）：${depsBad}`);
  }
  if (!dataReady) info('还没下公共数据，所以这次没做完整导入校验 —— 下一步 --download 之后用 --check 复验');
  log('\n下一步：node tools/genie-setup.mjs --download（GenieData ~391MB）\n');
  return 0;
}

// ── --download ──────────────────────────────────────────────────────────────
function doDownload() {
  if (!fs.existsSync(venvPython)) { bad('还没装引擎环境，先 --install'); return 2; }
  fs.mkdirSync(GENIE_DATA_DIR, { recursive: true });
  /* 为什么不用上游那个 `genie.download_genie_data()`：
   *   ① 它内部是 `snapshot_download(..., local_dir=".")` —— 落到**当前工作目录**下的 GenieData，
   *      与我们配置的 GENIE_DATA_DIR 不一定是一处（cwd 得恰好等于引擎根目录才行，太脆）；
   *   ② 它带的 `local_dir_use_symlinks=True` 在新版 huggingface_hub 里已废弃/可能被移除；
   *   ③ 它必须先 `import genie_tts` —— 而数据目录不存在时那个 import 会先去 `input()` 问
   *      "要不要自动下载"，等于一边问一边才去下，非交互环境直接 EOFError。
   * 这里直接调 hub 的 snapshot_download（同一个仓、同一个 allow_patterns），但 **local_dir 给
   * GENIE_DATA_DIR 的父目录**：仓里文件带 `GenieData/` 前缀，落在父目录下正好拼成
   * `<引擎根>/GenieData/...`。给 GENIE_DATA_DIR 自己会多套一层（GenieData/GenieData，2026-09-28 实测踩到）。 */
  const code = [
    'import os, sys, json',
    'from huggingface_hub import snapshot_download',
    `data_dir = r"${GENIE_DATA_DIR}"`,
    `local_dir = r"${path.dirname(GENIE_DATA_DIR)}"`,
    'os.makedirs(data_dir, exist_ok=True)',
    'p = snapshot_download(repo_id="High-Logic/Genie", repo_type="model", allow_patterns="GenieData/*", local_dir=local_dir)',
    'print("DOWNLOAD_DONE", data_dir, os.path.isdir(data_dir))'
  ].join('\n');
  log(`\n下载 GenieData 到 ${GENIE_DATA_DIR}（约 391MB，含可选中文 RoBERTa）`);
  const explicitHf = flag('hf-endpoint', '');
  const tried = explicitHf ? [{ name: explicitHf, env: { HF_ENDPOINT: explicitHf } }] : HF_MIRRORS;
  let done = false;
  for (const m of tried) {
    log(`\n→ 用「${m.name}」下载${m.env.HF_ENDPOINT ? `（HF_ENDPOINT=${m.env.HF_ENDPOINT}）` : ''}`);
    /* ETAG 超时压到 10 秒：直连 huggingface.co 时是 SSL EOF，默认超时下每个文件都要磨很久
     * 才发现连不上（实测半小时只下了 0.05MB），压短它才能快速换到镜像。 */
    const env = { HF_HUB_ETAG_TIMEOUT: '10', ...m.env };
    const r = runCmd(venvPython, ['-c', code], { inherit: true, env });
    if (r.status === 0) { done = true; ok(`完成（来源：${m.name}），目录大小 ${dirSizeMb(GENIE_DATA_DIR)} MB`); break; }
    info(`「${m.name}」失败${explicitHf ? '' : '，换镜像重试'}`);
  }
  if (!done) {
    bad('下载失败。可手动从 HuggingFace 的 High-Logic/Genie 仓把 GenieData 整个放进 ' + GENIE_DATA_DIR);
    return 4;
  }
  return 0;
}

// ── --characters（上游预置角色，第三方 IP，仅供本机自用）──────────────────────
/** 把一份模型目录接进 models/<名字>（软链，不复制）。已存在则跳过。 */
function linkCharacter(srcDir, name) {
  fs.mkdirSync(modelsDir, { recursive: true });
  const dest = path.join(modelsDir, name);
  if (fs.existsSync(dest)) { info(`角色「${name}」已经在 models 里了（${dest}）—— 跳过`); return 0; }
  try {
    fs.symlinkSync(srcDir, dest, isWin ? 'junction' : 'dir');
    ok(`已接入角色「${name}」（软链 ${dest} → ${srcDir}，不复制文件、不占额外空间）`);
    return 0;
  } catch (e) {
    info(`建软链失败（${e?.message ?? e}）—— 请手动把模型目录复制到 ${dest}`);
    return 1;
  }
}

function doCharacters() {
  if (!fs.existsSync(venvPython)) { bad('还没装引擎环境，先 --install'); return 2; }
  const names = positional.length ? positional : PREDEFINED.map((c) => c.name);
  const unknown = names.filter((n) => !PREDEFINED.some((c) => c.name === n));
  if (unknown.length) { bad(`不认识的角色：${unknown.join('、')}（可用的：${PREDEFINED.map((c) => c.name).join('、')}）`); return 2; }
  const picked = PREDEFINED.filter((c) => names.includes(c.name));
  const outRoot = path.join(engineRoot, 'CharacterModels', modelVersion);
  log(`\n下载 ${names.length} 个预置角色到 ${outRoot}（约 ${names.length * 320}MB），再软链进 ${modelsDir}`);
  log(`  ※ 第三方 IP 音色（${picked.map((c) => `${c.name}=${c.ip}`).join('、')}）—— **仅供本机自用，不要随产品分发**`);
  /* 落地目录给引擎根：仓里文件带 `CharacterModels/` 前缀，正好拼成 <引擎根>/CharacterModels/<版本>/<角色>（与
   * --download 给 GenieData 的父目录是同一个道理，见上面那段注释）。 */
  const code = [
    'import os',
    'from huggingface_hub import snapshot_download',
    `root = r"${engineRoot}"`,
    `ver = "${modelVersion}"`,
    `names = ${JSON.stringify(names)}`,
    'for name in names:',
    '    snapshot_download(repo_id="High-Logic/Genie", repo_type="model",',
    '                      allow_patterns="CharacterModels/%s/%s/*" % (ver, name), local_dir=root)',
    '    print("CHARA_DONE", name)',
    'print("ALL_DONE")'
  ].join('\n');
  const explicitHf = flag('hf-endpoint', '');
  const tried = explicitHf ? [{ name: explicitHf, env: { HF_ENDPOINT: explicitHf } }] : HF_MIRRORS;
  let done = false;
  for (const m of tried) {
    log(`\n→ 用「${m.name}」下载${m.env.HF_ENDPOINT ? `（HF_ENDPOINT=${m.env.HF_ENDPOINT}）` : ''}`);
    /* HF_HUB_DISABLE_XET=1 是必须的：这批文件在 hf-mirror.com 上走 Xet 会 401 Unauthorized
     * （cas-server.xethub.hf.co 拒绝镜像的取数请求），关掉 Xet 回落普通 LFS 才下得动（2026-09-28 实测）。 */
    const env = { HF_HUB_ETAG_TIMEOUT: '10', HF_HUB_DISABLE_XET: '1', ...m.env };
    const r = runCmd(venvPython, ['-c', code], { inherit: true, env });
    if (r.status === 0) { done = true; ok(`下载完成（来源：${m.name}）`); break; }
    info(`「${m.name}」失败${explicitHf ? '' : '，换镜像重试'}`);
  }
  if (!done) {
    bad(`下载失败。可手动从 HuggingFace 的 High-Logic/Genie 仓把 CharacterModels/${modelVersion}/<角色> 整个放进 ${outRoot}`);
    return 4;
  }
  let rc = 0;
  log('');
  for (const c of picked) {
    const realDir = path.join(outRoot, c.name);
    try {
      fs.writeFileSync(path.join(realDir, 'character.json'), JSON.stringify({
        label: c.label, language: c.language, ip: c.ip,
        source: `High-Logic/Genie CharacterModels/${modelVersion}/${c.name}`,
        installedAt: new Date().toISOString()
      }, null, 2) + '\n');
    } catch (e) {
      info(`写 character.json 失败（${e?.message ?? e}）—— 语言会退回引擎按目录名猜，日语角色会猜错`);
    }
    rc = linkCharacter(realDir, c.name) || rc;
    log(`  ${charaDisplay(c.name)}：${dirSizeMb(realDir)} MB`);
  }
  log('\n装完用 node tools/genie-setup.mjs --check 复验，或 --smoke "你好" 真合成一句。\n');
  /* 默认仍是 junction（省磁盘）。要随安装包分发就必须实体化：--bundle 顺带做掉。 */
  if (has('bundle')) {
    log('（带了 --bundle：下完直接把角色实体化成真实目录）');
    rc = Math.max(rc, doBundle());
  }
  return rc;
}

// ── --bundle（实体化：junction → 真实目录拷贝）────────────────────────────────
/* 为什么要这一步：`--characters` / `--add-character` 接进来的角色是 **Windows 目录联接（junction）**，
 * 省磁盘、装得快。但联接只是"本机的一个指针"：
 *   · 它指向的原目录一旦被搬走/删掉，角色就没了（安装到别人机器上必然如此）；
 *   · 打包工具（electron-builder 的 extraResources 全匹配 filter、robocopy 默认、多数 zip 库）
 *     对 junction 的处理不确定 —— 拷贝可能是"空目录"或整段漏掉，**而每一步都不报错**，
 *     于是"模型随包分发"会静默落空。
 * 所以「要随安装包分发」的角色必须先把文件真正落到 models/<角色> 里 —— 本命令就干这一件事。
 *
 * 安全要点（junction 的删除是本命令唯一有破坏性的动作）：
 *   `fs.rmSync(p, { recursive: true })` 在部分 Node 版本/Windows 上会**穿透联接把目标目录内容删掉**
 *   （本机 Node 实测当前版本只摘链接，但不能把结论建立在"这个版本恰好没问题"上）。
 *   本命令一律先 `lstatSync(p).isSymbolicLink()` 判定：是链接就 `unlinkSync(p)`
 *   （对目录联接等价于 RemoveDirectory：只摘链接、绝不碰目标），只有真目录才走 rmSync。
 *   换入用"先拷到同盘临时目录、删链接、再 rename"的顺序：任何一步失败都不会留下半个角色目录。 */

/** 是不是重解析点（symlink / junction / mount point）。读不到（不存在/无权限）一律按 false。 */
function isReparsePoint(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

/** 只删链接本身；真目录才递归删。返回用了哪种方式（回显给用户看，别让人以为删了目标）。 */
function removeLinkOnly(p) {
  if (isReparsePoint(p)) { fs.unlinkSync(p); return 'unlink（只摘链接）'; }
  fs.rmSync(p, { recursive: true, force: true });
  return 'rmSync（真目录）';
}

/** 递归拷贝目录，返回 { files, bytes }。用 copyFileSync（原生实现，几百 MB 的 .bin 也快）。
 *  进度行只在真终端打（isTTY）：重定向到日志/管道时 `\r` 会留下半行垃圾。 */
function copyTreeSync(from, to, label = '') {
  const tty = Boolean(process.stdout.isTTY);
  let files = 0, bytes = 0, done = 0;
  const walk = (src, dst) => {
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, e.name), d = path.join(dst, e.name);
      let st = null;
      try { st = fs.statSync(s); } catch { continue; }     // 跟随链接：模型目录内部不该有，但按最坏情况处理
      if (st.isDirectory()) { walk(s, d); continue; }
      const size = st.size;
      fs.copyFileSync(s, d);
      files += 1; bytes += size; done += 1;
      if (tty && label && done % 4 === 0) process.stdout.write(`\r     … ${label} 已拷 ${done} 个文件 / ${(bytes / 1048576).toFixed(1)} MB`);
    }
  };
  walk(from, to);
  if (tty && label && done) process.stdout.write('\r' + ' '.repeat(72) + '\r');
  return { files, bytes };
}

/** 统计目录里的文件数与字节数（**不跟随链接**：实体化后这里不该再出现链接）。 */
function treeMeasure(dir) {
  let files = 0, bytes = 0;
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      let st = null;
      try { st = fs.lstatSync(p); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(p);
      else { files += 1; bytes += st.size; }
    }
  };
  walk(dir);
  return { files, bytes };
}

/** models/ 下的角色目录清单（目录 + 联接都算，见 src/lib/genie-tts.js listCharacterDirs 的同一口径）。
 *  注意 `withFileTypes` 对 Windows 联接报的是 isSymbolicLink、不是 isDirectory，所以这里用 statSync 跟随判定。 */
function listModelEntries() {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(modelsDir); } catch { return out; }
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const p = path.join(modelsDir, name);
    let st = null;
    try { st = fs.statSync(p); } catch { continue; }
    if (!st.isDirectory()) continue;
    out.push({ name, path: p, link: isReparsePoint(p) });
  }
  return out;
}

/** 一个角色的"权威真源"：优先 CharacterModels/<版本>/<角色>（--characters 下下来的那棵树），
 *  否则用链接解析出来的真实路径（从别处 --add-character 接进来的角色就是这种）。 */
function resolveSourceDir(entry) {
  const authoritative = path.join(engineRoot, 'CharacterModels', modelVersion, entry.name);
  try {
    if (fs.statSync(path.join(authoritative, 'tts_models')).isDirectory()) return { dir: authoritative, why: 'CharacterModels/ 下的权威副本' };
  } catch { /* 没有就用 realpath */ }
  const real = fs.realpathSync(entry.path);
  if (real === entry.path) return null;                    // 不是链接也不是权威副本 → 无可拷之源
  return { dir: real, why: '链接解析出的真实路径' };
}

function doBundle() {
  const wanted = positional.filter((a) => !a.startsWith('--'));
  if (!fs.existsSync(modelsDir)) { bad(`找不到 models 目录：${modelsDir}（先 --characters 或 --add-character）`); return 2; }
  const all = listModelEntries();
  if (!all.length) { bad(`${modelsDir} 下没有角色目录 —— 先 --characters（上游预置）或 --add-character <目录> <名字>`); return 2; }

  /* models/ 自己也可能是个联接（本机安装树的现状就是这样：整个 models 指到源码仓）。
   * 那种情况下**任何**写入都会落到链接目标上，所以必须整目录对换，而不是逐个换。 */
  const modelsIsLink = isReparsePoint(modelsDir);
  if (modelsIsLink) info(`models 目录本身是联接 → 链接目标：${(() => { try { return fs.realpathSync(modelsDir); } catch { return '?'; } })()}`);
  const unknown = wanted.filter((n) => !all.some((e) => e.name === n));
  if (unknown.length) { bad(`不认识的角色：${unknown.join('、')}（models 下现有：${all.map((e) => e.name).join('、')}）`); return 2; }

  log(`\n实体化角色模型（junction → 真实目录拷贝）\n  引擎根：${engineRoot}\n  models：${modelsDir}${modelsIsLink ? '（联接，本次整目录对换）' : ''}`);
  log('  ※ 实体化后同一份模型在磁盘上存在两份（原目录不动），占用翻倍 —— 这是随包分发必需的代价。\n');

  const todo = all.filter((e) => (modelsIsLink || e.link) && (!wanted.length || modelsIsLink || wanted.includes(e.name)));
  /* 整目录对换时必须一个不落：漏掉的角色会随链接一起消失。 */
  if (modelsIsLink && wanted.length && todo.length !== all.length) {
    bad(`models 是联接 → 必须整目录对换，不能只挑 ${wanted.join('、')}（会把没点名的角色一起丢掉）。请不带角色名跑 --bundle。`);
    return 2;
  }
  for (const e of all.filter((x) => !todo.includes(x))) info(`角色「${e.name}」已经是真实目录 —— 跳过（不重复拷贝）`);
  if (!todo.length) { ok('没有需要实体化的角色：models 下都已经是真实目录了'); return 0; }

  const staging = path.join(engineRoot, `.models-bundle-${Date.now()}`);
  const plan = [];
  try {
    fs.mkdirSync(staging, { recursive: true });
    for (const e of todo) {
      const src = resolveSourceDir(e);
      if (!src) { bad(`角色「${e.name}」既不是联接，也不在 CharacterModels 下 —— 找不到可拷的真源（${e.path}）`); return 3; }
      const tmp = path.join(staging, e.name);
      log(`→ 「${e.name}」\n     源：${src.dir}（${src.why}）\n     目标：${e.path}`);
      const t0 = Date.now();
      const copied = copyTreeSync(src.dir, tmp, e.name);
      const srcM = treeMeasure(src.dir);
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      if (copied.files !== srcM.files || copied.bytes !== srcM.bytes) {
        bad(`  拷贝不完整：源 ${srcM.files} 个文件 / ${srcM.bytes} 字节，暂存区只有 ${copied.files} / ${copied.bytes} —— **原链接一个都没动**，先查磁盘空间`);
        return 3;
      }
      ok(`  已拷 ${copied.files} 个文件 / ${(copied.bytes / 1048576).toFixed(1)} MB（${secs}s）`);
      plan.push({ ...e, tmp, srcDir: src.dir, files: copied.files, bytes: copied.bytes });
    }

    /* 换入。models 是联接时：先摘 models 的链接，再把暂存树 rename 成 models（同盘 rename，瞬时）。 */
    if (modelsIsLink) {
      const how = removeLinkOnly(modelsDir);
      log(`  models 链接已摘除（${how}）→ 换上实体目录`);
      fs.renameSync(staging, modelsDir);
      const m = treeMeasure(modelsDir);
      ok(`models 已实体化：${plan.length} 个角色 / ${m.files} 个文件 / ${(m.bytes / 1048576).toFixed(1)} MB`);
    } else {
      for (const p of plan) {
        const how = removeLinkOnly(p.path);
        fs.renameSync(p.tmp, p.path);
        ok(`「${p.name}」已实体化（旧链接：${how}）→ ${p.path}`);
      }
      try { fs.rmdirSync(staging); } catch { /* 非空/被占用都无所谓，就是个暂存目录 */ }
    }
  } catch (e) {
    bad(`实体化中断：${e?.message ?? e}`);
    log(`  暂存目录（可保留也可删）：${staging}`);
    return 4;
  }

  /* 复验：三个角色必须都是"真目录 + 文件数与字节数对得上"。这里不复验就不算完成 ——
   * 实体化的全部意义就是"文件真的在本地磁盘上"，而这一点只能量出来。 */
  log('\n复验：');
  let rc = 0, total = 0;
  for (const p of plan) {
    const still = isReparsePoint(p.path);
    const m = treeMeasure(p.path);
    const same = m.files === p.files && m.bytes === p.bytes;
    total += m.bytes;
    if (still || !same) { bad(`「${p.name}」实体化后仍不对：链接=${still} / ${m.files} 文件 ${m.bytes} 字节（期望 ${p.files} / ${p.bytes}）`); rc = 1; continue; }
    ok(`「${p.name}」：真实目录，${m.files} 个文件 / ${(m.bytes / 1048576).toFixed(1)} MB（lstat.isSymbolicLink()=false）`);
  }
  const leftoverLink = listModelEntries().filter((e) => e.link);
  if (leftoverLink.length) { bad(`models 下仍有联接角色：${leftoverLink.map((e) => e.name).join('、')}`); rc = 1; }
  if (!rc) log(`\n本次实体化合计写入 ${(total / 1048576).toFixed(1)} MB（拷贝源原样保留，未被删除）。\n`);
  return rc;
}

// ── --add-character / --convert ─────────────────────────────────────────────
function doAddCharacter() {
  const src = positional[0];
  if (!src) { bad('用法：--add-character <ONNX 模型目录> [角色名]'); return 2; }
  const abs = path.resolve(src);
  if (!fs.existsSync(abs)) { bad(`目录不存在：${abs}`); return 2; }
  const name = positional[1] || path.basename(abs).replace(/^tts_models$/i, path.basename(path.dirname(abs)));
  // 兼容两种布局：角色目录里直接是 .onnx，或 角色/tts_models/*.onnx（上游整合包就是这个结构）
  const hasOnnx = (d) => { try { return fs.readdirSync(d).some((f) => f.endsWith('.onnx')); } catch { return false; } };
  const target = hasOnnx(abs) ? abs : (hasOnnx(path.join(abs, 'tts_models')) ? path.join(abs, 'tts_models') : '');
  if (!target) { bad(`这个目录里没有 .onnx：${abs}（应当是 GPT-SoVITS 转换后的模型目录）`); return 2; }
  return linkCharacter(target, name);
}

function doConvert() {
  const [pth, ckpt, name] = positional;
  if (!pth || !ckpt || !name) { bad('用法：--convert <.pth> <.ckpt> <名字>（需要 pip install torch，转换只用一次，装完可以卸）'); return 2; }
  const outDir = path.join(modelsDir, name);
  fs.mkdirSync(outDir, { recursive: true });
  const code = [
    ...shimPrelude(),
    'import sys',
    'import genie_tts as genie',
    `genie.convert_to_onnx(torch_pth_path=r"${path.resolve(pth)}", torch_ckpt_path=r"${path.resolve(ckpt)}", output_dir=r"${outDir}")`,
    'print("CONVERT_DONE")'
  ].join('\n');
  const r = runCmd(venvPython, ['-c', code], { inherit: true, env: { GENIE_DATA_DIR } });
  if (r.status !== 0) { bad('转换失败（装了 torch 吗？V2 / V2ProPlus 之外的老模型不支持）'); return 4; }
  ok(`转换完成：${outDir}`);
  return 0;
}

// ── --smoke / --stop ────────────────────────────────────────────────────────
async function doSmoke() {
  const g = await import('../src/lib/genie-tts.js');
  /* 文本从 `--smoke` 后面那个位置参数取：通用 positional 过滤器会把"跟在 --smoke 后面的词"当成
   * 该参数的值而剔掉，所以 `--smoke "你好"` 实际从来拿不到这句话（2026-09-28 实测发现）。 */
  const smokeArg = (() => {
    const i = argv.indexOf('--smoke');
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : '';
  })();
  const text = flag('text', '') || smokeArg || positional[0] || '本地引擎自检，一二三四五。';
  const cfg = { rootDir: engineRoot, character: flag('character', '') };
  log(`\n拉起引擎并合成一句（「${text}」）—— 第一次会慢一些（加载模型）`);
  const t0 = Date.now();
  try {
    const r = await g.synthesizeLocal({ cfg, text, format: 'wav' });
    const st = await g.serverStatus(cfg);
    ok(`合成成功：角色=${r.character} 音频=${r.buf.length} 字节 ${r.ms}ms（含冷启动共 ${Date.now() - t0}ms）`);
    ok(`引擎常驻内存读数：${r.rssMb ?? st.rssMb ?? '?'} MB（pid=${st.pid}）`);
    /* 内存这一项专门打印，是因为上游源码注释里写过"修改后内存 6448MB"这种吓人的数字，
     * 而那个数字说的是**权重数据量**（fp16→fp32 展开后的体量），不是进程实际常驻内存。
     * 现场量一次比信注释靠谱 —— 这里就是那次实测。 */
    const out = path.join(BRIDGE_ROOT, 'state', `genie-smoke-${Date.now()}.wav`);
    try { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, r.buf); ok(`音频已存：${out}`); } catch { /* 存不下就算了 */ }
    return 0;
  } catch (e) {
    bad(`合成失败：${e?.message ?? e}`);
    return 4;
  }
}

async function doStop() {
  const g = await import('../src/lib/genie-tts.js');
  const cfg = { rootDir: engineRoot };
  const r = await g.stopServer({ cfg });
  if (r.stopped) ok(r.external ? `引擎进程已关闭（pid ${r.pid ?? '?'}，由别的进程拉起）` : '引擎进程已关闭');
  else if (r.reason) bad(`${r.reason} —— 可能没权限，或用的是另一个端口/根目录`);
  else ok('引擎本来就没在跑');
  return 0;
}

// ── 入口 ────────────────────────────────────────────────────────────────────
const table = {
  check: doCheck, install: doInstall, download: doDownload, characters: doCharacters,
  'add-character': doAddCharacter, convert: doConvert, smoke: doSmoke, stop: doStop, bundle: doBundle
};
const code = await table[CMD]();
/* 退出这块踩过两次，写清楚为什么是现在这样：`--smoke` 会把引擎拉起来，而它的 stdio 管道握在 Node 手上，
 * ① 只设 exitCode → 命令"合成完了却不返回"（2026-09-28 实测：日志已写出"合成完成 …7337ms"、音频也落盘，
 *    调用方却等到超时）；② 直接 process.exit() → 在句柄关闭途中撞上 libuv 断言
 *    "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), async.c line 76"。
 * 正解：先把**本进程自己拉起的**引擎同步收掉（killServerSync 只动 _child，别的进程拉起的引擎它不碰），
 * 再让事件循环自然走完。 */
try {
  const g = await import('../src/lib/genie-tts.js');
  g.killServerSync();
} catch { /* 没拉起来 / 导入失败都不影响退出 */ }
process.exitCode = code;
