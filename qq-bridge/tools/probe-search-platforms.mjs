// 逐平台实测「我们自己的搜索引擎」在每个来源上的真实产出（条数 / 耗时 / 报错 / 首条样例）。
//
// 为什么要单独一个工具：`web_search` 的默认行为是多平台并行 + 早退，只看聚合结果无法判断
// "到底是哪个源在机房 IP 下哑了"。这个脚本按 MCP 协议真的 spawn 一次 server，再对每个平台
// 单独发一次 tools/call —— 拿到的就是**线上 DSH 里模型看到的同一个数**（同一份代码、同一套解析）。
//
// 用法（在 qq-bridge 目录下）：
//   node tools/probe-search-platforms.mjs                      # 默认查询词，全部平台
//   node tools/probe-search-platforms.mjs "望月けい pixiv"       # 指定查询词
//   node tools/probe-search-platforms.mjs "查询词" bing,duckduckgo  # 只测指定平台
//   node tools/probe-search-platforms.mjs "查询词" default       # 不带 platforms 参数（就是模型默认的全量聚合）
//   node tools/probe-search-platforms.mjs "查询词" all --json    # 打印每个平台的原始 JSON
//
// 需要联网；不写任何文件、不改配置、不碰运行中的进程。
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const argv = process.argv.slice(2).filter((a) => a !== '--json');
const RAW = process.argv.includes('--json');
const QUERY = argv[0] || '望月けい pixiv';

const child = spawn(process.execPath, [path.join(ROOT, 'src/mcp-web-search-safe.js')], {
  cwd: ROOT,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env },
});

let buf = '';
let stderr = '';
const responses = new Map();
child.stderr.on('data', (d) => { stderr += d.toString(); });
child.stdout.on('data', (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id != null) responses.set(msg.id, msg);
    } catch { /* 非 JSON 行忽略 */ }
  }
});

const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n');
const waitFor = async (id, timeoutMs = 60000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (responses.has(id)) return responses.get(id);
    await new Promise((r) => setTimeout(r, 40));
  }
  return null;
};

const die = (msg) => {
  console.error(msg + (stderr ? `\nserver stderr:\n${stderr.slice(0, 1500)}` : ''));
  child.kill();
  process.exit(1);
};

send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe-search-platforms', version: '1.0' } } });
if (!await waitFor(1, 15000)) die('initialize 超时。');
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
const list = await waitFor(2, 15000);
const tools = list?.result?.tools ?? [];
if (!tools.length) die('tools/list 为空。');

const schema = tools.find((t) => t.name === 'web_search')?.inputSchema ?? {};
const allPlatforms = schema?.properties?.platforms?.items?.enum ?? [];
if (!allPlatforms.length) die('web_search 的 platforms 枚举为空，无法逐平台测。');

const wanted = (argv[1] && argv[1] !== 'all' && argv[1] !== 'default')
  ? argv[1].split(',').map((s) => s.trim()).filter(Boolean)
  : allPlatforms;
const useDefault = argv[1] === 'default'; // 不传 platforms → 模型平时的默认路径（全部平台 + 早退 + 相关度闸门）
const unknown = wanted.filter((p) => !allPlatforms.includes(p));
if (unknown.length) die(`未知平台：${unknown.join(', ')}（可选：${allPlatforms.join(', ')}）`);

console.log(`server = ${path.relative(process.cwd(), path.join(ROOT, 'src/mcp-web-search-safe.js'))}  node ${process.version}  ${process.platform}`);
console.log(`查询词 = ${JSON.stringify(QUERY)}   ${useDefault ? '模式 = 默认聚合（不带 platforms）' : `平台 = ${wanted.join(' ')}`}\n`);

let idc = 100;
const rows = [];
for (const platform of (useDefault ? ['(default)'] : wanted)) {
  const id = (idc += 1);
  const t0 = Date.now();
  send({
    jsonrpc: '2.0', id, method: 'tools/call',
    params: {
      name: 'web_search',
      arguments: useDefault ? { query: QUERY, maxResults: 12 } : { query: QUERY, maxResults: 12, platforms: [platform] },
    },
  });
  const res = await waitFor(id, 45000);
  const ms = Date.now() - t0;
  const text = res?.result?.content?.find((c) => c.type === 'text')?.text ?? '';
  let payload = null;
  try { payload = JSON.parse(text); } catch { /* 非 JSON（如 "No results ..." 或报错文本） */ }
  if (payload) {
    const first = payload.results?.[0];
    rows.push({
      platform,
      n: payload.results?.length ?? 0,
      ms: payload.tookMs ?? ms,
      failures: JSON.stringify(payload.failures ?? {}),
      note: payload.note ? '低相关' : '',
      sample: first ? `${String(first.title).slice(0, 46)} | ${String(first.url).slice(0, 58)}` : '',
      payload,
    });
  } else {
    rows.push({ platform, n: 0, ms, failures: '', note: '', sample: text.replace(/\s+/g, ' ').slice(0, 110), payload: null });
  }
}

if (useDefault) {
  const r = rows[0];
  const p = r.payload;
  console.log(`条数=${r.n}  耗时=${r.ms}ms  ${r.note}`);
  console.log(`各平台产出：${JSON.stringify(p?.platforms ?? {})}`);
  if (p?.failures && Object.keys(p.failures).length) console.log(`失败：${JSON.stringify(p.failures)}`);
  for (const [i, it] of (p?.results ?? []).entries()) {
    console.log(`  ${String(i + 1).padStart(2)}. [${it.source}] ${String(it.title).slice(0, 60)}  ${String(it.url).slice(0, 62)}`);
  }
  child.kill();
  process.exit(r.n ? 0 : 2);
}

console.log('平台'.padEnd(14) + '条数 耗时ms  失败/备注');
for (const r of rows.sort((a, b) => b.n - a.n || a.platform.localeCompare(b.platform))) {
  const tail = [r.failures !== '{}' ? r.failures : '', r.note].filter(Boolean).join(' ');
  console.log(`${r.platform.padEnd(14)}${String(r.n).padStart(4)} ${String(r.ms).padStart(6)}  ${tail}`);
  if (r.sample) console.log(`                 ↳ ${r.sample}`);
}

const ok = rows.filter((r) => r.n > 0);
console.log(`\n有结果 ${ok.length}/${rows.length}：${ok.map((r) => `${r.platform}(${r.n})`).join(' ')}`);
const bad = rows.filter((r) => r.n === 0);
if (bad.length) console.log(`零结果：${bad.map((r) => r.platform).join(' ')}`);

if (RAW) {
  for (const r of rows) {
    if (r.payload) console.log(`\n===== ${r.platform} =====\n${JSON.stringify(r.payload, null, 2).slice(0, 3000)}`);
  }
}

child.kill();
process.exit(ok.length ? 0 : 2);
