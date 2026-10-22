// 读一个 DSH 会话日志里的请求头事件，确认 temperature 到底有没有进 config。
//
//   node test/read-header.mjs ~/.dsh/sessions/<工作区>/<session>/session.v4.jsonl.zstd
//
// 为什么要手写解压：DSH 的会话日志是**多个独立 zstd 帧拼接**的，Node 的
// zstdDecompressSync / createZstdDecompress 都只解第一帧（只得到 1 条 session 元数据）。
// 这里按帧魔数 28 B5 2F FD 切开，逐帧解，再拼成完整 jsonl。
import zlib from 'node:zlib';
import fs from 'node:fs';

/** 按 zstd 帧魔数切开并逐帧解压，拼回完整文本。 */
export function readZstdFrames(path) {
  const buf = fs.readFileSync(path);
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const offs = [];
  for (let i = 0; i + 4 <= buf.length; i++) if (buf.compare(magic, 0, 4, i, i + 4) === 0) offs.push(i);
  let text = '';
  let ok = 0;
  for (let k = 0; k < offs.length; k++) {
    const end = k + 1 < offs.length ? offs[k + 1] : buf.length;
    try { text += zlib.zstdDecompressSync(buf.subarray(offs[k], end)).toString(); ok++; } catch { /* 非帧边界，跳过 */ }
  }
  return { text, frames: offs.length, decoded: ok };
}

const path = process.argv[2];
if (!path) {
  console.error('用法: node test/read-header.mjs <session.v4.jsonl.zstd>');
  process.exit(2);
}
const { text, frames, decoded } = readZstdFrames(path);
const events = text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const headers = events.filter((e) => e.type === 'request/header');
console.log(`zstd 帧 ${frames}（解出 ${decoded}），事件 ${events.length}，request/header ${headers.length}`);
for (const e of headers) {
  const { config, adapterDefaults } = e.data.header;
  console.log(`  reason=${e.data.reason} config=${JSON.stringify(config)} adapterDefaults=${JSON.stringify(adapterDefaults ?? null)}`);
  console.log(`  temperature: ${typeof config.temperature === 'number' ? config.temperature : '（没有）'}`);
}
