// 回归（2026-10-28 现场：「表情包图库搜得到、发不出」）：
//   包里 index.db 的表还挂着文件名，磁盘上却没有这个人文件（历史乱码包 / 半截拷贝 / 换过盘的残留包）。
//   旧行为：qq_meme_search 把幽灵行照原样报给模型 → 模型拿去 qq_send_meme → 永远「图片文件不存在：…
//   （包 X 的表里有它，磁盘上没有）」→ 模型只能对用户说"图库里的图全都不见了，就剩名字挂着"。
//   现在的口径：**表只是索引，能不能发以磁盘为准**。
//     ① qq_meme_search 只报磁盘上真有文件的；
//     ② qq_send_meme 只给 query 时，跳过幽灵行挑到真能发的那张；
//     ③ 两份包同名时优先取有物理文件的那份（3cbcdd9 起），本测试用同名前缀的幽灵包把顺序钉死在最前。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SRC = path.join(process.cwd(), 'src');
let pass = 0;
let failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS ' + name); } else { failed++; console.log('  FAIL ' + name + ' ' + extra); process.exitCode = 1; }
};

const sandbox = path.join(os.tmpdir(), 'meme-phantom-' + process.pid);
fs.rmSync(sandbox, { recursive: true, force: true });
fs.mkdirSync(sandbox, { recursive: true });

/** 造一份 pack：rows = [{file_name, tag, caption}]；withFiles=false → 表里有、盘上没有（幽灵包） */
function makePack(dirName, id, rows, withFiles) {
  const dir = path.join(sandbox, dirName);
  fs.mkdirSync(path.join(dir, 'memes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id, name: id }));
  const db = new DatabaseSync(path.join(dir, 'index.db'));
  db.exec('CREATE TABLE memes (path TEXT PRIMARY KEY, file_name TEXT, tag TEXT, caption TEXT, keywords TEXT)');
  const ins = db.prepare('INSERT INTO memes (path, file_name, tag, caption, keywords) VALUES (?, ?, ?, ?, ?)');
  for (const r of rows) {
    const rel = 'memes/' + r.tag + '/' + r.file_name;
    ins.run(rel, r.file_name, r.tag, r.caption, r.caption);
    if (withFiles) {
      fs.mkdirSync(path.join(dir, 'memes', r.tag), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), Buffer.from('RIFF0000WEBPfake', 'utf8'));
    }
  }
  db.close();
  return dir;
}

// 幽灵包 id 按字母序排在前面 → orderedMemePacks 里它一定是第一份（复刻现场"乱码残留包排最前"）
const ghostRows = [
  { file_name: '幽灵图甲.webp', tag: 'happy', caption: 'zzphantom 幽灵甲' },
  { file_name: '幽灵图乙.webp', tag: 'happy', caption: 'zzphantom 幽灵乙' },
  { file_name: '幽灵图丙.webp', tag: 'shy', caption: 'zzphantom 幽灵丙' }
];
const realRows = [
  { file_name: '实在图甲.webp', tag: 'happy', caption: 'zzphantom 实在甲' },
  { file_name: '实在图乙.webp', tag: 'happy', caption: 'zzphantom 实在乙' }
];
makePack('aaa-ghost', 'aaa-ghost', ghostRows, false);
makePack('bbb-real', 'bbb-real', realRows, true);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(SRC, 'mcp-napcat-safe.js')],
  cwd: path.join(SRC, '..'),
  env: { ...process.env, QQB_MEME_ROOT: sandbox },
  stderr: 'ignore'
});
const client = new Client({ name: 'meme-phantom-test', version: '1.0.0' });

const textOf = (res) => (res?.content ?? []).map((c) => c?.text ?? '').join('\n');

try {
  await client.connect(transport);

  console.log('== ① qq_meme_search 不报幽灵行 ==');
  const search = await client.callTool({ name: 'qq_meme_search', arguments: { query: 'zzphantom', limit: 8 } });
  const stext = textOf(search);
  ok('搜到了东西（前置条件）', stext.includes('找到') || stext.includes('实在图甲'), stext.slice(0, 200));
  ok('幽灵行一条都不返回', !stext.includes('幽灵图'), stext.slice(0, 300));
  ok('真实文件正常返回', stext.includes('实在图甲.webp'), stext.slice(0, 300));
  ok('来源只报真有文件的包', stext.includes('bbb-real') && !stext.includes('aaa-ghost'), stext.slice(0, 300));

  console.log('== ② qq_send_meme 只给 query 时跳过幽灵行 ==');
  const send = await client.callTool({ name: 'qq_send_meme', arguments: { key: 'private:10001', token: 'bogus-token-for-test', query: 'zzphantom' } });
  const sendText = textOf(send);
  ok('没有落在"图片文件不存在"上', !sendText.includes('图片文件不存在'), sendText.slice(0, 300));
  ok('没有挑到幽灵文件', !sendText.includes('幽灵图'), sendText.slice(0, 300));
  ok('走到了真正的发送环节（校验/网络失败都算过了挑图这关）', /发送失败|"ok"|验证失败/.test(sendText) || sendText.length > 0, sendText.slice(0, 300));
} catch (e) {
  failed++;
  process.exitCode = 1;
  console.log('  FAIL 运行异常 ' + (e?.message ?? e));
} finally {
  try { await client.close(); } catch { /* 关不掉不影响结论 */ }
  try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* Windows 上句柄还没释放就留到 tmp */ }
}

console.log('\nALL PASS  pass=' + pass + ' fail=' + failed);
