// 回归（2026-10-28）：qq_load_persona 不该要 key/token。
// 现场：模型每轮先调一次 tool_input:{} 的 qq_load_persona → 包装层回「缺 key…」→ 它再补一次带 key 的调用，
// 白烧一步。人设读取不往任何会话发东西，缺 key 与"发错群"无关，所以这类工具必须直接放行。
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SRC = path.join(process.cwd(), 'src');
let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS ' + name); } else { fail++; console.log('  FAIL ' + name + ' ' + extra); process.exitCode = 1; }
};

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(SRC, 'mcp-napcat-safe.js')],
  cwd: path.join(SRC, '..'),
  stderr: 'ignore',
});
const client = new Client({ name: 'persona-keyless', version: '1.0.0' });
const textOf = (res) => (res?.content ?? []).map((c) => c?.text ?? '').join('\n');

try {
  await client.connect(transport);
  console.log('== qq_load_persona 不传 key/token ==');
  const r = await client.callTool({ name: 'qq_load_persona', arguments: {} });
  const t = textOf(r);
  ok('没有回「缺 key」', !t.includes('缺 key'), t.slice(0, 160));
  ok('没有回「缺 token」', !t.includes('缺 token'), t.slice(0, 160));
  ok('isError 为假', r?.isError !== true, JSON.stringify(r?.isError));
  ok('真的读到了人设正文', t.includes('【persona_load】') && /角色卡|DeepSeek/.test(t), t.slice(0, 120));
} catch (e) {
  fail++;
  process.exitCode = 1;
  console.log('  FAIL 运行异常 ' + (e?.message ?? e));
} finally {
  try { await client.close(); } catch { /* ignore */ }
}

console.log('\nALL PASS  pass=' + pass + ' fail=' + fail);
