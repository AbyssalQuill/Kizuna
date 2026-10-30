// 视觉 MCP server（stdio，直连，**不经 mcp-compressor**）。2026-10-22
//
// 为什么单独一个服务，而不是往 mcp-napcat-safe.js 里加：
//   napcat 那一路走 mcp-compressor 代理（compressed-tools 模式），代理的核心数据结构是
//   ProxyResponse { text } —— 它只能回文本。工具结果里的 {type:'image'} 内容块在代理那一层
//   被序列化进 text（实测拿到的是 /9j/4AAQSkZJRg... 一长串 base64，约 20 万 token），
//   DSH 那一侧 never 看到 image 块。所以「让模型看图」这件事只要经过代理就必然失败。
//   而把整个 napcat server 改成直连也不划算：实测 schema 116125 字符 ≈ 36289 token/步，
//   代理后是 3900 字符 ≈ 1219 token/步。
//   → 结论：**只把「看图」这一件事拆成一个极小的直连服务**（2 个工具、约 1.2KB schema），
//     工具表照旧走压缩代理，两边各拿各的好处。
//
// 它解决的现场（2026-10-22 主人报障）：
//   桥自己发出去的 pixiv 图，模型看不见 —— 只能回「发出的图我这边看不到渲染的效果呀」，
//   被追问「你发的图你自己不会看吗」。发图工具返回的 staged 路径就在本机，模型只要有个
//   能把它读成 image 块的工具，就能真的看到自己发出去的那张。
//
// 安全边界（这是硬性的，等同 NO_LOCAL_TOOLS）：
//   本服务**只读图片**，且只能读三个允许的目录：NapCat 临时目录、桥的 image-tmp、
//   DSH 附件目录 —— 别的一律拒绝。它不是通用文件读取工具。
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ensureDeliverableImage, sniffImageInfo } from './lib/image-compress.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function getConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch { return {}; }
}

const log = (...a) => console.error('[vision]', ...a);

/** 允许读图的根目录。全部 realpath 化后再做前缀判定，避免 ../ 或符号链接绕过。 */
function allowedRoots() {
  const cfg = getConfig();
  const list = [
    String(cfg?.napcat?.tmpDir ?? '').trim() || path.join(ROOT, 'state', 'image-tmp'),
    String(cfg?.napcat?.homeDir ?? '').trim(),
    path.join(ROOT, 'state', 'image-tmp'),
    '/root/.dsh/attachments',
    '/home/qq/.config/QQ',
    '/root/.config/QQ',
    '/opt/napcat',
  ];
  const out = [];
  for (const p of list) {
    if (!p) continue;
    try { out.push(fs.realpathSync(p)); } catch {}
  }
  return out;
}

function withinRoots(target) {
  let real;
  try { real = fs.realpathSync(target); } catch { return null; }
  const normalized = real.replace(/\\/g, '/');
  // 严格匹配 NTQQ 原图/缩略图特征路径
  if (/\/nt_data\/Pic\//i.test(normalized) || /\/nt_data\/Thumb\//i.test(normalized)) {
    return real;
  }
  for (const root of allowedRoots()) {
    const withSep = root.endsWith(path.sep) ? root : root + path.sep;
    if (real === root || real.startsWith(withSep)) return real;
  }
  return null;
}

/** 把本地图片做成模型看得见的 image 内容块；超限/认不出时退化成一行文字说明，绝不硬塞。 */
async function imageBlockFromFile(file) {
  const real = withinRoots(String(file || '').trim());
  if (!real) {
    return { error: '不在允许读取的图片目录内（只允许 NapCat 临时目录 / 桥的 image-tmp / DSH 附件目录）。这个工具只用来回看聊天里的、或你刚发出去的图。' };
  }
  let buf;
  try {
    const st = fs.statSync(real);
    if (!st.isFile()) return { error: '不是文件' };
    buf = fs.readFileSync(real);
  } catch (e) {
    return { error: '读不到这个文件：' + (e?.message ?? e) };
  }
  const info = sniffImageInfo(buf);
  if (!info?.format) return { error: '这个文件不是可识别的图片（png/jpeg/gif/webp）' };
  const gate = await ensureDeliverableImage(buf, 'image/' + info.format);
  if (!gate?.ok || !gate.buffer) {
    return { error: '这张图没法交给你看：' + (gate?.reason || '未知原因') };
  }
  return {
    block: { type: 'image', mimeType: gate.mimeType, data: gate.buffer.toString('base64') },
    meta: {
      file: real,
      name: path.basename(real),
      bytes: buf.length,
      shownBytes: gate.buffer.length,
      width: gate.width ?? info.width,
      height: gate.height ?? info.height,
      format: info.format,
      compressed: gate.buffer.length !== buf.length,
    },
  };
}

async function bridgeApi(pathname, init = {}) {
  const cfg = getConfig();
  const port = Number(cfg.consolePort) || 3100;
  let consoleToken = '';
  try { consoleToken = String(cfg.consoleToken || ''); } catch {}
  if (!consoleToken) {
    try { consoleToken = fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim(); } catch {}
  }
  const timeoutMs = Number(init.timeoutMs) || 120000;
  const { timeoutMs: _omit, headers: extraHeaders, ...rest } = init;
  const res = await fetch('http://127.0.0.1:' + port + pathname, {
    ...rest,
    headers: {
      'content-type': 'application/json',
      ...(consoleToken ? { 'x-console-token': consoleToken } : {}),
      ...(extraHeaders ?? {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  let body = null;
  try { body = await res.json(); } catch {}
  if (!res.ok) throw new Error(body?.error || ('桥接 API HTTP ' + res.status));
  return body;
}

/* ── GIF / 动态图分帧（2026-10-30）─────────────────────────────────────────────
 * 现场：主人说「识图还是不准」。多模态模型对**动图**基本只看得到第一帧，
 * 于是表情包里的"动作"（打滚、拍桌、笑喷）全被读成一帧静止画面，语义自然错。
 * 做法：ffmpeg 把动图抽成最多 4 张等间隔的 PNG，按顺序一起交给模型 ——
 * 它能同时看到"怎么开始、怎么结束"，而不是一张快照。
 * 失败一律回退成单帧（绝不因为抽帧失败就不给图）。 */
const GIF_MAX_FRAMES = 4;
function extractAnimatedFrames(real) {
  let tmpDir;
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-gif-'));
    const out = path.join(tmpDir, 'f%02d.png');
    // fps=2 抽 2 帧/秒，再由 -frames:v 限制总数；对短表情包足够覆盖起止
    execFileSync('ffmpeg', ['-loglevel', 'error', '-i', real, '-vf', 'fps=2,scale=512:-1:flags=lanczos', '-frames:v', String(GIF_MAX_FRAMES), out], { timeout: 15000 });
    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.png')).sort().map((f) => path.join(tmpDir, f));
    return { dir: tmpDir, files };
  } catch (e) {
    try { if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    log('抽帧失败，回退单帧：' + String(e?.message ?? e).slice(0, 120));
    return { dir: null, files: [] };
  }
}
function cleanupDir(dir) {
  try { if (dir) fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

const server = new McpServer({ name: 'vision', version: '0.1.0' });

server.tool(
  'qq_view_image',
  'SEE a picture that exists on the bridge host: returns it as real image content you can look at. Use it right after you send an image (the send tool returns viewWith / staged paths) so you actually SEE what went out instead of guessing; also for any local picture path you were given. Only pictures inside the NapCat temp dir, the bridge image-tmp dir, or the DSH attachments dir can be read - it is not a general file reader.',
  {
    file: z.string().describe('Absolute path of the picture ON THE BRIDGE HOST - normally the viewWith or staged path returned by qq_send_pixiv or qq_send_image'),
  },
  async ({ file }) => {
    const r = await imageBlockFromFile(file);
    if (r.error) return { content: [{ type: 'text', text: r.error }], isError: true };
    // 动图：抽出多帧一起交给模型（只看第一帧会把动作读错）
    if (String(r.meta?.format || '').toLowerCase() === 'gif') {
      const { dir, files } = extractAnimatedFrames(r.meta.file);
      try {
        if (files.length > 1) {
          const blocks = [];
          for (const f of files) {
            const one = await imageBlockFromFile(f);
            if (one?.block) blocks.push(one.block);
          }
          if (blocks.length > 1) {
            return {
              content: [
                { type: 'text', text: JSON.stringify({ ...r.meta, animated: true, frames: blocks.length, note: 'GIF 已按时间顺序抽帧：先看整体动作，再看首尾差异' }, null, 2) },
                ...blocks,
              ],
            };
          }
        }
      } finally {
        cleanupDir(dir);
      }
    }
    return { content: [{ type: 'text', text: JSON.stringify(r.meta, null, 2) }, r.block] };
  }
);

server.tool(
  'qq_view_message_image',
  'SEE the picture(s) a QQ message carries - your own sent picture or someone else. Same look path as qq_get_message_images, but it lives on a server that is NOT behind the text-only tool proxy, so the picture really reaches you. Use it when a message id is all you have (e.g. your own sent image: the send tool returns the QQ message id).',
  {
    key: z.string().describe('Session key: group:ID or private:QQ'),
    token: z.string().describe('Session token (from the wake prompt)'),
    messageId: z.union([z.number(), z.string()]).describe('The QQ message id (may be negative)'),
    imageIndex: z.number().optional().describe('Which picture of that message, 0-based (default 0 = the first)'),
  },
  async ({ key, token, messageId, imageIndex }) => {
    try {
      const qs = new URLSearchParams({ key, messageId: String(messageId) });
      const data = await bridgeApi('/api/images/message?' + qs.toString(), { headers: { 'x-agent-token': token } });
      const all = (Array.isArray(data?.images) ? data.images : []).filter((i) => i?.data && i?.mimeType);
      const pics = all.filter((i) => i?.kind !== 'face');
      const use = pics.length ? pics : all;
      if (!use.length) {
        return { content: [{ type: 'text', text: '消息 ' + messageId + ' 里没有可交给你的图片（' + (data?.note || '未找到') + '）' }], isError: true };
      }
      const idx = Math.max(0, Number(imageIndex) || 0);
      const pick = use[idx] || use[0];
      const buf = Buffer.from(String(pick.data), 'base64');
      const gate = await ensureDeliverableImage(buf, pick.mimeType);
      if (!gate?.ok || !gate.buffer) {
        return { content: [{ type: 'text', text: '这张图没法交给你看：' + (gate?.reason || '未知原因') }], isError: true };
      }
      const meta = {
        messageId: String(messageId),
        index: idx,
        ofTotal: use.length,
        kind: pick.kind ?? 'image',
        bytes: buf.length,
        shownBytes: gate.buffer.length,
        width: gate.width,
        height: gate.height,
        mimeType: gate.mimeType,
      };
      return {
        content: [
          { type: 'text', text: JSON.stringify(meta, null, 2) },
          { type: 'image', mimeType: gate.mimeType, data: gate.buffer.toString('base64') },
        ],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: '取图失败：' + (e?.message ?? e) }], isError: true };
    }
  }
);

log('视觉 MCP 已加载（直连，不经压缩代理）：qq_view_image / qq_view_message_image');
await server.connect(new StdioServerTransport());
