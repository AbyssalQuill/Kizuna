// 本地语音引擎（Genie / GPT-SoVITS ONNX sidecar）的纯逻辑与守卫测试 —— 2026-09-28 新增
//
// 与 tests/voice.test.js 同一纪律：**不真装引擎、不真联网、不写业务状态**。
//   ① 被断言的要么是纯函数（normalizeLocal / localPaths / decodeDataUrl），
//      要么是"在发出请求之前就该拦下"的守卫；
//   ② 「本地合成真的跑起来」这件事验不了也不该在单测里验（要 391MB 数据 + 一个角色模型），
//      它的验收手段是 `node tools/genie-setup.mjs --smoke` 与管理端「自检合成」按钮；
//   ③ 需要走网络的两条用例一律用替身 fetch 接管，并且**让替身返回失败**，
//      这样既能断言"报文发往哪里"，又不会让合成真的落盘（合成成功后是会写缓存文件的）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const lib = await import('../src/lib/genie-tts.js');
const voice = await import('../src/core/voice.js');

/** 载入 `src/lib/genie-tts.js` 的**真实现**，并额外暴露两个私有函数
 *  （`listCharacterDirs` / `listCharacterInfos` 不在模块的公开导出里，而角色清单的形状正是它们定的）。
 *  做法：把来源读出来，只把两个副作用依赖（`./paths.js` 的 ROOT/STATE_DIR 与 `./log.js` 的 log）
 *  换成替身、再补两行导出，落在临时目录里 import —— 于是断言校验的还是桥侧真正在跑的那份代码，
 *  而不是在测试里另抄一遍实现（抄一遍就必然漂移）。 */
const _genieProbe = new Map();
async function loadGenie() {
  const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', 'genie-tts.js');
  assert.ok(fs.existsSync(src), `找不到 genie-tts.js：${src}（本测试要在 qq-bridge 目录下跑）`);
  let code = fs.readFileSync(src, 'utf8')
    .replace(/^import \{ ROOT, STATE_DIR \} from '\.\/paths\.js';$/m, "const ROOT = '', STATE_DIR = '';")
    .replace(/^import \{ log \} from '\.\/log\.js';$/m, 'const log = () => {};');
  assert.ok(!/^import .*'\.\/(paths|log)\.js';$/m.test(code), 'genie-tts.js 的副作用依赖没能替换掉');
  code += '\nexport { listCharacterDirs, readCharacterMeta, listCharacterInfos };\n';
  if (!_genieProbe.has(src)) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-src-'));
    const tmp = path.join(dir, 'genie-tts.probe.mjs');
    fs.writeFileSync(tmp, code);
    /* 【2026-09-28】genie-tts.js 现在 import 了 `./genie-venv-home.js`（自带 Python 运行时之后，
     * venv 的 pyvenv.cfg 要在运行期按当前安装路径纠正）。那份文件没有任何副作用依赖（只 fs + path），
     * 原样拷进同一个临时目录即可被解析到 —— 否则这里会报 "Cannot find module …genie-venv-home.js"。 */
    fs.copyFileSync(path.join(path.dirname(src), 'genie-venv-home.js'), path.join(dir, 'genie-venv-home.js'));
    _genieProbe.set(src, import(pathToFileURL(tmp).href));
  }
  return _genieProbe.get(src);
}

let pass = 0;
let fail = 0;
const cases = [];
function t(name, fn) { cases.push([name, fn]); }

// ── 配置归一化（纯函数） ─────────────────────────────────────────────────────
t('normalizeLocal：空输入给出厂默认值，且默认是"关闭 + 回落云端"', () => {
  const d = lib.normalizeLocal(undefined);
  assert.equal(d.enabled, false, '本地引擎必须默认关闭');
  assert.equal(d.engine, 'genie');
  assert.equal(d.port, 4610);
  assert.equal(d.language, 'zh');
  assert.equal(d.fallbackToCloud, true, '默认要能回落云端（否则本地一坏就发不出语音）');
  assert.equal(d.autoStart, true);
  assert.ok(d.idleShutdownMs > 0, '默认要空闲回收（几百 MB 常驻内存不能一直占着）');
  assert.deepEqual(lib.normalizeLocal({}), d, '未传与传空对象应当等价');
});

t('normalizeLocal：布尔只认严格 true/false；字符串 trim；数字夹到合法区间', () => {
  const c = lib.normalizeLocal({
    enabled: 'true',            // 字符串不是布尔 → 保持默认 false（与 voice.js 里 allVoice 同一纪律）
    fallbackToCloud: 'no',      // 同上 → 保持默认 true
    autoStart: false,
    rootDir: '   C:\\eng   ',
    character: '  小红  ',
    port: '70000',
    language: 'jp',
    idleShutdownMs: -5,
    unknownKey: '应当被忽略'
  });
  assert.equal(c.enabled, false, '字符串 "true" 不能当开关打开');
  assert.equal(c.fallbackToCloud, true, '字符串 "no" 不能把回落关掉');
  assert.equal(c.autoStart, false);
  assert.equal(c.rootDir, 'C:\\eng', '路径要去掉首尾空白');
  assert.equal(c.character, '小红');
  assert.equal(c.port, 65535, '端口要夹在 1~65535');
  assert.equal(c.language, 'jp');
  assert.ok(c.idleShutdownMs >= 0, '负数时长回落到默认值');
  assert.equal(lib.normalizeLocal({ language: 'klingon' }).language, 'zh', '不支持的语言回落到 zh');
});

// ── 路径推导（纯函数，跟着桥一起搬） ─────────────────────────────────────────
t('localPaths：默认全部落在 qq-bridge/python 下，脚本名与端口正确', () => {
  const p = lib.localPaths({ port: 5123 });
  assert.ok(p.rootDir.endsWith(path.join('qq-bridge', 'python')), `默认引擎目录应在桥里：${p.rootDir}`);
  assert.equal(p.serverFile, path.join(p.rootDir, 'genie_server.py'));
  assert.equal(p.dataDir, path.join(p.rootDir, 'GenieData'));
  assert.equal(p.modelsDir, path.join(p.rootDir, 'models'));
  assert.equal(p.url, 'http://127.0.0.1:5123');
  // 虚拟环境解释器按平台取（Windows 在 Scripts\，其余在 bin/）
  const rel = path.relative(p.venvDir, p.venvPython).split(path.sep).join('/');
  assert.ok(rel === 'Scripts/python.exe' || rel === 'bin/python', `venv 解释器路径不对：${rel}`);
});

t('localPaths：显式 rootDir 会一并改写数据/模型/脚本路径（不会各指一处）', () => {
  const p = lib.localPaths({ rootDir: 'D:\\tts', dataDir: '', modelsDir: '' });
  assert.equal(p.rootDir, path.resolve('D:\\tts'));
  assert.equal(p.serverFile, path.join(path.resolve('D:\\tts'), 'genie_server.py'));
  assert.equal(p.dataDir, path.join(path.resolve('D:\\tts'), 'GenieData'));
  assert.equal(p.modelsDir, path.join(path.resolve('D:\\tts'), 'models'));
});

// ── 样本解码 ────────────────────────────────────────────────────────────────
t('decodeDataUrl：DataURL 与裸 base64 都能解出同一份字节', () => {
  const raw = Buffer.from('kizuna-voice-sample');
  const b64 = raw.toString('base64');
  assert.deepEqual(lib.decodeDataUrl(`data:audio/mpeg;base64,${b64}`).buf, raw);
  assert.equal(lib.decodeDataUrl(`data:audio/mpeg;base64,${b64}`).mime, 'audio/mpeg');
  assert.deepEqual(lib.decodeDataUrl(b64).buf, raw, '裸 base64（老调用方）也要能解');
  assert.equal(lib.decodeDataUrl('').buf.length, 0);
});

t('writeReference：空样本直接返回空串（不落任何文件）', () => {
  assert.equal(lib.writeReference({}, Buffer.alloc(0)), '');
  assert.equal(lib.writeReference({}, null), '');
});

// ── 环境探测：缺什么就如实说缺什么 ──────────────────────────────────────────
t('probeLocal：引擎与数据都不在时 ready=false，且逐条写明缺什么', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-probe-'));
  try {
    const p = lib.probeLocal({ rootDir: empty, pythonPath: path.join(empty, 'no-such-python'), port: 4611 }, { force: true });
    assert.equal(p.ready, false);
    assert.equal(p.hasGenie, false);
    assert.equal(p.dataOk, false);
    assert.deepEqual(p.characters, []);
    assert.ok(p.reasons.some((r) => r.includes('genie_server.py')), `应当指出缺引擎脚本：${p.reasons}`);
    assert.ok(p.reasons.some((r) => r.includes('genie_tts')), `应当指出没装引擎包：${p.reasons}`);
    assert.ok(p.reasons.some((r) => r.includes('GenieData')), `应当指出缺公共数据：${p.reasons}`);
    assert.ok(p.reasons.some((r) => r.includes('角色')), `应当指出缺角色模型：${p.reasons}`);
    assert.equal(p.paths.url, 'http://127.0.0.1:4611');
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

t('probeLocal：有 .onnx 的角色目录才算角色（两级布局也认）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-chars-'));
  const models = path.join(root, 'models');
  try {
    fs.mkdirSync(path.join(models, '直接放'), { recursive: true });
    fs.writeFileSync(path.join(models, '直接放', 't2s.onnx'), 'x');
    fs.mkdirSync(path.join(models, '整合包', 'tts_models'), { recursive: true });
    fs.writeFileSync(path.join(models, '整合包', 'tts_models', 'vits.onnx'), 'x');
    fs.mkdirSync(path.join(models, '空目录'), { recursive: true });
    const p = lib.probeLocal({ rootDir: root, pythonPath: path.join(root, 'no-such-python') }, { force: true });
    assert.deepEqual(p.characters, ['整合包', '直接放'].sort(), `角色识别不对：${p.characters}`);
    assert.ok(!p.characters.includes('空目录'), '没有 .onnx 的目录不该算角色');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── 角色清单：管理端下拉框读的那两份（2026-10-01）────────────────────────────
// 管理端语音页的「默认角色」下拉读 `GET /api/voice/local` 回包里的 **characterList**
// （对象数组 `{name,label,language,loaded}`，`label` 可能为空串）；`characters`（字符串数组）
// 只作回退项、形状不能改（旧界面在用）。容易错的是两件：① 语言必须来自角色目录里的
// character.json —— 未花（mika）是日语角色，从目录名读不出线索，引擎会退回默认 zh 念错语言；
// ② 没有 .onnx 的目录不算角色。这里对真函数（loadGenie 暴露的 listCharacterInfos/listCharacterDirs）断言。
t('listCharacterInfos：characters 仍是字符串数组，characterList 带 label/language/loaded', async () => {
  const g = await loadGenie();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-charlist-'));
  const models = path.join(root, 'models');
  try {
    // 角色 A：目录里直接放 .onnx，没有 character.json → label 与语言都收成空串
    fs.mkdirSync(path.join(models, 'atri'), { recursive: true });
    fs.writeFileSync(path.join(models, 'atri', 't2s.onnx'), 'x');
    // 角色 B：.onnx 在 tts_models/ 里，且 character.json 声明了显示名与日语
    fs.mkdirSync(path.join(models, 'mika', 'tts_models'), { recursive: true });
    fs.writeFileSync(path.join(models, 'mika', 'tts_models', 'vits.onnx'), 'x');
    fs.writeFileSync(path.join(models, 'mika', 'character.json'),
      JSON.stringify({ label: '圣园未花', language: 'jp', ip: 'third-party' }));
    // 角色 C：语言写了个约定外的值（'ja'）→ 语言收成空串，label 照收
    fs.mkdirSync(path.join(models, 'odd'), { recursive: true });
    fs.writeFileSync(path.join(models, 'odd', 'vits.onnx'), 'x');
    fs.writeFileSync(path.join(models, 'odd', 'character.json'), JSON.stringify({ label: '猜的', language: 'ja' }));
    // 角色 D：character.json 内容坏掉 → 不许抛错，label 空串
    fs.mkdirSync(path.join(models, 'broken'), { recursive: true });
    fs.writeFileSync(path.join(models, 'broken', 'vits.onnx'), 'x');
    fs.writeFileSync(path.join(models, 'broken', 'character.json'), '{ not json');
    // 没有 .onnx 的目录：不算角色
    fs.mkdirSync(path.join(models, '空目录'), { recursive: true });

    const probe = lib.probeLocal({ rootDir: root, pythonPath: path.join(root, 'no-such-python') }, { force: true });
    assert.deepEqual(probe.characters, ['atri', 'broken', 'mika', 'odd'],
      `characters 必须仍是目录名字符串数组：${probe.characters}`);
    assert.ok(probe.characters.every((n) => typeof n === 'string'), 'characters 里不许出现对象');

    // loaded 同时认字符串与 {name} 两种形状（桥侧 serverStatus 报的是后者）
    const infos = g.listCharacterInfos(probe.paths.modelsDir, ['atri', { name: 'odd' }]);
    assert.deepEqual(infos, [
      { name: 'atri', label: '', language: '', loaded: true },
      { name: 'broken', label: '', language: '', loaded: false },
      { name: 'mika', label: '圣园未花', language: 'jp', loaded: false },
      { name: 'odd', label: '猜的', language: '', loaded: true },
    ], `characterList 内容不对：${JSON.stringify(infos)}`);
    assert.ok(infos.every((c) => typeof c.label === 'string' && typeof c.loaded === 'boolean'),
      'label 必须是字符串（可能是空串）、loaded 必须是布尔');
    assert.ok(!infos.some((c) => c.name === '空目录'), '没有 .onnx 的目录不该进下拉框');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── 对外配置：本地段必须出现在管理端拿到的配置里 ────────────────────────────
t('voiceConfig().local：默认段存在、开关默认关闭、字段类型正确', () => {
  const c = voice.voiceConfig();
  assert.ok(c.local && typeof c.local === 'object', 'voiceConfig 必须带 local 段');
  assert.equal(typeof c.local.enabled, 'boolean');
  assert.equal(c.local.engine, 'genie');
  assert.equal(typeof c.local.port, 'number');
  assert.ok(c.local.port > 0 && c.local.port < 65536);
  assert.equal(typeof c.local.idleShutdownMs, 'number');
});

t('voiceConfigPublic().local：回给管理端的本地段不含任何密钥字段', () => {
  const pub = voice.voiceConfigPublic();
  assert.ok(pub.local && typeof pub.local === 'object', 'voiceConfigPublic 必须回传 local（否则界面保存会把这段洗掉）');
  assert.equal(typeof pub.local.enabled, 'boolean');
  assert.equal(pub.local.engine, 'genie');
  assert.equal(typeof pub.local.fallbackToCloud, 'boolean');
  const keys = Object.keys(pub.local);
  assert.ok(!keys.some((k) => /key|token|secret/i.test(k)), `本地段不该有密钥类字段：${keys.join(',')}`);
  assert.ok(!('apiKey' in pub.local));
});

// ── 合成路径的守卫（用替身 fetch，且让替身失败以避开落盘） ────────────────────
function stubFetchFailing() {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), payload: init?.body ? JSON.parse(String(init.body)) : null });
    return { ok: false, status: 401, json: async () => ({ error: { message: '替身：不给音频' } }) };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

/** 一份最小可用的语音配置（云端那套照原样给一份假的，本地段按参数覆盖）。 */
function cfgWith(localPatch, extra = {}) {
  const models = {};
  for (const r of voice.VOICE_ROLES) models[r.role] = { baseUrl: 'https://example.invalid/v1', apiKey: 'test-key', model: r.defaultModel };
  return {
    enabled: true,
    models,
    defaultVoice: '冰糖',
    style: '',
    format: 'mp3',
    maxChars: 120,
    dailyChars: 0,
    cacheEnabled: false,
    ...extra,
    local: { ...lib.normalizeLocal({ rootDir: os.tmpdir(), pythonPath: path.join(os.tmpdir(), 'no-such-python') }), ...localPatch }
  };
}

t('本地引擎开启但装不起来、且禁止回落时：直接报错，且**一个云请求都不发**', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-cache-'));
  voice.initVoiceCore({ napcat: { tmpDir: dir } });   // 把缓存目录也引到临时目录，别碰桥的 state
  const stub = stubFetchFailing();
  try {
    await assert.rejects(
      () => voice.synthesize({ text: '你好呀', cfg: cfgWith({ enabled: true, fallbackToCloud: false }) }),
      (e) => { assert.match(String(e.message), /本地语音引擎不可用/); return true; }
    );
    /* 只断言"没打云端地址"：本地引擎探测本身也会走一次 fetch（GET /health 探活），
     * 替身把所有 fetch 都拦了，所以这里不能简单地按调用次数断言。 */
    assert.equal(stub.calls.filter((c) => c.url.includes('example.invalid')).length, 0,
      '已明确禁止回落云端，就不该再去请求云端');
  } finally {
    stub.restore();
    voice.initVoiceCore(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

t('本地引擎默认关闭时：照旧走云端（本地这条路完全不被触碰）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-cache-'));
  voice.initVoiceCore({ napcat: { tmpDir: dir } });
  const stub = stubFetchFailing();
  try {
    await assert.rejects(() => voice.synthesize({ text: '你好呀', cfg: cfgWith({ enabled: false }) }));
    const cloud = stub.calls.filter((c) => c.url.includes('example.invalid'));
    assert.equal(cloud.length, 1, '关闭本地引擎时应发出一次云端请求');
    assert.match(cloud[0].url, /example\.invalid\/v1\/chat\/completions$/, '应当打云端那套 OpenAI 兼容端点');
  } finally {
    stub.restore();
    voice.initVoiceCore(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

t('音色设计（design）不走本地：本地没有对应模型，仍按云端处理', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-cache-'));
  voice.initVoiceCore({ napcat: { tmpDir: dir } });
  const stub = stubFetchFailing();
  try {
    await assert.rejects(() => voice.synthesize({
      text: '你好呀', mode: 'design', description: '二十七八岁的御姐音',
      cfg: cfgWith({ enabled: true, fallbackToCloud: false })
    }), (e) => {
      // 关键判据：报的是**云端**失败（替身的 401），而不是"本地引擎不可用"
      assert.doesNotMatch(String(e.message), /本地语音引擎不可用/);
      return true;
    });
    assert.equal(stub.calls.filter((c) => c.url.includes('example.invalid')).length, 1, 'design 应当照旧请求云端');
  } finally {
    stub.restore();
    voice.initVoiceCore(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 关引擎：认身份、认外部进程 ───────────────────────────────────────────────
// 起因：`--stop` 原先只看本进程手上的子进程句柄，于是"上一次桥崩了留下的引擎 / 手工拉起的
// 引擎"会被报成「引擎本来就没在跑」—— 当场可证伪（探一下 /health 就知道它在）。
// 这两条用假 HTTP 服务做**真请求**（本机环回，不碰真引擎、不写状态）。
function fakeEngine({ identify = true } = {}) {
  const hits = [];
  const { createServer } = http;
  const srv = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    if (req.url === '/health') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(identify ? { service: 'kizuna-genie-tts', ok: true, pid: 4242 } : { hello: 'world' }));
      return;
    }
    if (req.url === '/shutdown') {
      res.end('{}');
      setTimeout(() => srv.close(), 30);   // 收到退出请求后自己消失，模拟 uvicorn 收尾
      return;
    }
    res.statusCode = 404; res.end('{}');
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({ srv, hits, port: srv.address().port }));
  });
}

t('stopServer：端口上什么都没有时返回 stopped=false（不抛、不误报已停）', async () => {
  const r = await lib.stopServer({ cfg: { port: 46199 }, waitMs: 300 });
  assert.equal(r.stopped, false);
});

t('stopServer：外部进程拉起的引擎也能关掉（先认 service 标识，再发 /shutdown）', async () => {
  const { srv, hits, port } = await fakeEngine();
  try {
    const r = await lib.stopServer({ cfg: { port }, waitMs: 2000 });
    assert.equal(r.stopped, true, '识别出自家引擎后应当真的关掉');
    assert.equal(r.external, true, '要如实说明这是外部进程');
    assert.equal(r.pid, 4242, '要把对方的 pid 报出来');
    assert.ok(hits.includes('POST /shutdown'), `应当发过 /shutdown：${hits}`);
  } finally { try { srv.close(); } catch { /* 已关 */ } }
});

t('stopServer：端口上是别的服务时拒绝动手（没有 service 标识就不发 /shutdown）', async () => {
  const { srv, hits, port } = await fakeEngine({ identify: false });
  try {
    const r = await lib.stopServer({ cfg: { port }, waitMs: 300 });
    assert.equal(r.stopped, false, '不该把别人家的服务当引擎关掉');
    assert.ok(!hits.includes('POST /shutdown'), `不该发 /shutdown：${hits}`);
  } finally { try { srv.close(); } catch { /* 已关 */ } }
});

// ── 跑 ──────────────────────────────────────────────────────────────────────
for (const [name, fn] of cases) {
  try {
    await fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  FAIL ${name}\n       ${e?.message ?? e}`);
  }
}
console.log(`\nvoice-local: ${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
