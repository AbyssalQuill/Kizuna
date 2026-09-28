/* 一次性验收：直接调 localEnginePreview（界面「试听」按钮走的就是它），确认真能出音频。
 * 跑法：在 qq-bridge 目录下 node <这个文件> */
import fs from 'node:fs';
import path from 'node:path';
import * as voice from '../src/core/voice.js';
import * as genie from '../src/lib/genie-tts.js';

const out = path.join(process.cwd(), 'state', 'preview-check.wav');
const r = await voice.localEnginePreview({ text: '试听一句话，听得到吗？', character: 'feibi' });
const buf = Buffer.from(r.audioBase64, 'base64');
fs.writeFileSync(out, buf);
console.log(JSON.stringify({
  ok: r.ok, character: r.character, ms: r.ms, totalMs: r.totalMs, bytes: r.bytes,
  mime: r.mime, rssMb: r.rssMb, text: r.text,
  base64长度: r.audioBase64.length, 落盘: out,
  头四字节: buf.subarray(0, 4).toString('latin1'),
  与bytes一致: buf.length === r.bytes
}, null, 0));
try { await voice.localEngineStop(); console.log('引擎已关'); } catch (e) { console.log('关引擎失败(不影响结论):', e?.message); }
genie.killServerSync();
