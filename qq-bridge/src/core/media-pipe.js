// 媒体管道：OneBot 图片/表情抓取、压缩、多图解析
// cfg 注入（initMediaPipeCore），bot 注入（setMediaPipeBot）。
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { log } from '../lib/log.js';
import { MAX_MEDIA_COUNT } from './session-state.js';
import { safeFetchBuffer, looksLikeImageBuffer } from '../safe-fetch.js';
import { readCachedMedia, writeCachedMedia } from './media-cache.js';
import { isProbablySafeImageFileRef, isSafeLocalMediaPath } from '../lib/media-guard.js';
import { mimeFromBuffer, mimeFromUrl, base64FromMaybe } from '../lib/media-meta.js';
import { finalizeImageBuffer, ensureDeliverableImage, IMAGE_HARD_MAX_SIDE } from '../lib/image-compress.js';
import { visionSplitEnabled as useVisionSplit, describeImageWithVisionModel } from './vision.js';
// 2026-09-21 表情包理解：收到 QQ 原生表情、又拿不到在线描述时，用本地 id→中文名表兜底
import { faceNameById } from '../qq-faces.js';

export const MAX_MEDIA_BYTES = 50 * 1024 * 1024; // 单条消息图片总字节上限（调大至50MB以支持摄影级超高清大图与RAW导出）
export const MAX_MEDIA_PIXELS = 150_000_000; // 单张图片像素上限（1.5亿像素，支持高像素单反与全景摄影图）
export const MAX_MEDIA_STORE_PER_KEY = 500; // 每个会话最多缓存多少条消息的媒体元数据，防止无限增长

let cfgRef = null;
let botRef = null;
export function initMediaPipeCore(cfg) { cfgRef = cfg; }
export function setMediaPipeBot(bot) { botRef = bot; }

export function getImageDimensions(buf) {
  if (!buf || buf.length < 24) return null;
  try {
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
      let offset = 2;
      while (offset + 9 < buf.length) {
        if (buf[offset] !== 0xff) { offset += 1; continue; }
        const marker = buf[offset + 1];
        if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
        const len = buf.readUInt16BE(offset + 2);
        if (len < 2) return null;
        // SOF0-SOF15（排除 DHT C4、DAC CC、DNL DC、DRI DD）
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
        }
        offset += 2 + len;
      }
    }
    // WebP：解析 VP8X / VP8L / VP8 三种容器，避免“图片炸弹”绕过像素上限。
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const fourcc = buf.toString('ascii', 12, 16);
      if (fourcc === 'VP8X' && buf.length >= 30) {
        const width = 1 + buf[24] + (buf[25] << 8) + (buf[26] << 16);
        const height = 1 + buf[27] + (buf[28] << 8) + (buf[29] << 16);
        return { width, height };
      }
      if (fourcc === 'VP8L' && buf.length >= 25) {
        const bits = [buf[21], buf[22], buf[23], buf[24]];
        const width = 1 + (((bits[1] & 0x3f) << 8) | bits[0]);
        const height = 1 + (((bits[3] & 0x0f) << 10) | (bits[2] << 2) | ((bits[1] & 0xc0) >> 6));
        return { width, height };
      }
      if (fourcc === 'VP8 ' && buf.length >= 30) {
        const width = buf.readUInt16LE(26) & 0x3fff;
        const height = buf.readUInt16LE(28) & 0x3fff;
        return { width, height };
      }
    }
  } catch {}
  return null;
}

export async function fetchOneBotImage(media, opts = {}) {
  /* 2026-09-22 需求「默认转发原图，别压缩」：raw=true 时原样返回抓到的字节：
   * 喂给视觉模型那条路必须压缩（缩到 1280px 内、40KB 以上就重编码，为的是 token 与被 DSH 附件层
   * 拒收的风险），但「把这张图转出去」要的是原图 —— 压缩过的副本转出去，对方拿到的就是
   * 二次编码的糊图。安全闸门照旧（字节上限、像素上限、魔术字校验），只是不做重编码。 */
  const raw = opts.raw === true;
  /* 2026-10-31 根治「表情包/图片看不到」：先查磁盘缓存。
   * QQ 图片直链寿命很短，等模型想起来看时常常已经 400/404（见 media-cache.js 顶部的真机日志）。
   * 消息一进来 prewarmMedia() 就把字节存下来了，所以这里的命中率才是关键路径，
   * 而不是"再抓一次"。缓存存的是**未压缩的原始字节**，raw 与压缩两条路都从它派生。 */
  const asIs = (buf, mime) => (raw ? { buffer: buf, mimeType: mime, compressed: false } : finalizeImageBuffer(buf, mime));
  const cachedHit = readCachedMedia(media);
  if (cachedHit) return await asIs(cachedHit.buffer, cachedHit.mimeType);
  /** 抓到的原始字节先落盘，再交给 asIs 做（可选的）压缩 —— 顺序不能反，否则缓存里存的是压缩图。 */
  const keepAnd = async (buf, mime) => {
    try { writeCachedMedia(media, buf, mime); } catch { /* 缓存失败不影响主流程 */ }
    return await asIs(buf, mime);
  };
  // 优先使用 OneBot get_image 获取网关侧信息；只有 file 是安全缓存文件名时才允许交给网关。
  /* 2026-10-28 修「图还没加载出来」：NapCat 有些版本把 file 直接给成绝对路径
   * （/root/.config/QQ/nt_data/Pic/....jpg），旧的「只认简单文件名」判据会把这类图整条跳过 ——
   * 连 get_image 都不问，最后静默退化成 [图片（获取失败）]，日志里什么都没有。
   * 绝对路径只要能通过 isSafeLocalMediaPath（仍在 QQ 缓存目录内）就照样问网关：这一步只读元数据。 */
  const fileRefRaw = media.kind === 'image' && media.file ? String(media.file) : '';
  const fileRefIsAbs = /^([a-zA-Z]:[\\/]|\/)/.test(fileRefRaw);
  const canAskGateway = !!fileRefRaw
    && (isProbablySafeImageFileRef(fileRefRaw) || (fileRefIsAbs && isSafeLocalMediaPath(fileRefRaw, cfgRef?.napcat?.homeDir)));
  if (canAskGateway) {
    try {
      // 留足 25 秒给 NapCat 下载/落盘超大摄影级图片，避免因过早超时而拿不到本地原图
      const info = await botRef.getImage({ file: String(media.file) }, { timeoutMs: 25000 });
      const obj = info && typeof info === 'object' ? info : {};

      // 1. 本地缓存文件优先策略（0 延迟、免受网络 CDN/DNS 超时影响）
      if (typeof obj.file === 'string' && !obj.file.startsWith('base64://') && fs.existsSync(obj.file) && isSafeLocalMediaPath(obj.file, cfgRef.napcat?.homeDir)) {
        const stat = fs.statSync(obj.file);
        if (stat.size > MAX_MEDIA_BYTES) {
          log(`本地图片文件超限，已跳过（${Math.round(stat.size / 1024)}KB）`);
        } else {
          const buf = fs.readFileSync(obj.file);
          const dims = getImageDimensions(buf);
          if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
            log(`本地图片像素超限，已跳过（${dims.width}x${dims.height}）`);
          } else if (!looksLikeImageBuffer(buf)) {
            log(`本地缓存文件不是可识别的图片格式，已跳过（${Math.round(buf.length / 1024)}KB）`);
          } else {
            return await keepAnd(buf, mimeFromBuffer(buf));
          }
        }
      }

      // 2. 网关直接回传 base64 数据
      const base64 = base64FromMaybe(obj.data) || base64FromMaybe(obj.base64);
      if (base64) {
        if (base64.length * 3 / 4 <= MAX_MEDIA_BYTES) {
          const buf = Buffer.from(base64, 'base64');
          if (buf.length > 0 && looksLikeImageBuffer(buf)) {
            const dims = getImageDimensions(buf);
            if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
              log(`get_image 返回的图片像素超限，已跳过（${dims.width}x${dims.height}）`);
            } else {
              return await keepAnd(buf, mimeFromBuffer(buf));
            }
          }
        } else {
          log(`get_image 返回的图片 base64 超限，已跳过（${Math.round(base64.length * 3 / 4 / 1024)}KB）`);
        }
      }

      // 3. 兜底尝试通过 URL 网络下载（独立 try-catch，防止 DNS/CDN 超时阻断后续）
      if (obj.url) {
        try {
          const qqHeaders = String(obj.url).includes('qq.com') ? { referer: 'https://im.qq.com/', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) QQ/9.7.21' } : {};
          const fetched = await safeFetchBuffer(String(obj.url), MAX_MEDIA_BYTES, qqHeaders);
          const dims = getImageDimensions(fetched.buffer);
          if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
            log(`get_image URL 图片像素超限，已跳过（${dims.width}x${dims.height}）`);
          } else {
            return await keepAnd(fetched.buffer, mimeFromBuffer(fetched.buffer) || mimeFromUrl(obj.url));
          }
        } catch (fetchErr) {
          log(`get_image 内部 URL 抓取失败: ${fetchErr?.message ?? fetchErr}`);
        }
      }
    } catch (error) {
      log(`get_image 解析失败: ${error?.message ?? error}`);
    }
  }
  // 其次直接用消息段里的 URL
  if (media.url) {
    try {
      const qqHeaders = String(media.url).includes('qq.com') ? { referer: 'https://im.qq.com/', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) QQ/9.7.21' } : {};
      const fetched = await safeFetchBuffer(String(media.url), MAX_MEDIA_BYTES, qqHeaders);
      const dims = getImageDimensions(fetched.buffer);
      if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
        log(`图片 URL 像素超限，已跳过（${dims.width}x${dims.height}）`);
      } else {
        return await keepAnd(fetched.buffer, mimeFromBuffer(fetched.buffer) || mimeFromUrl(media.url));
      }
    } catch (error) {
      log(`图片 URL 抓取失败: ${error?.message ?? error}`);
    }
  }
  /* 失败必须留痕：否则线上只看到 [图片（获取失败）]，分不清是没文件、没 URL 还是下载挂了。 */
  log(`[media] 图片拿不到内容：file=${fileRefRaw ? fileRefRaw.slice(0, 96) : '(空)'} url=${media.url ? String(media.url).slice(0, 60) : '(空)'} kind=${media.kind ?? '(空)'}`);
  return null;
}

/** 消息刚到达时就把图片字节抓下来存缓存 —— 这是「根治」的关键一步：
 *  QQ 直链在收到消息的当下是有效的，过几分钟就 400/404 了（见 media-cache.js 顶部日志）。
 *  串行 + 最多 2 张：不抢带宽、不被某张慢图拖住消息处理；任何失败都静默（主流程照常）。 */
export async function prewarmMedia(mediaList, limit = 2) {
  const list = Array.isArray(mediaList) ? mediaList : [];
  let done = 0;
  for (const media of list) {
    if (done >= limit) break;
    if (!media || typeof media !== 'object') continue;
    if (media.kind !== 'image') continue;
    if (readCachedMedia(media)) continue;
    done += 1;
    try { await fetchOneBotImage(media, { raw: true }); } catch { /* 静默 */ }
  }
}

export async function fetchFaceMedia(media, opts = {}) {
  const raw = opts.raw === true;
  const faceId = Number(media.faceId);
  /* 2026-09-21 表情包理解：本地表兜底：拿不到 NapCat 的在线描述时，
   * 也要把 `[表情#123]`（一个数字，模型只能猜）降级成 `[表情:偷笑]`（一句情绪）。 */
  const localName = faceNameById(faceId);
  const fallbackText = localName ? `[表情:${localName}]` : `[表情#${media.faceId}]`;
  if (!Number.isInteger(faceId)) return { text: `[表情#${media.faceId}]` };
  try {
    const face = await botRef.fetchFaceEntity(faceId, { timeoutMs: 12000 });
    if (face && typeof face === 'object') {
      const desc = face.q_des || (Array.isArray(face.emoji_name_alias) && face.emoji_name_alias[0]) || localName || '';
      if (face.url) {
        try {
          const fetched = await safeFetchBuffer(String(face.url), MAX_MEDIA_BYTES);
          const dims = getImageDimensions(fetched.buffer);
          if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
            log(`表情图片像素超限，已跳过（${dims.width}x${dims.height}）`);
          } else {
            const faceMime = mimeFromBuffer(fetched.buffer) || mimeFromUrl(face.url);
            // 转发（raw）要原图：表情也一样，别把对方的动图压成一张静图
            const fim = raw ? { buffer: fetched.buffer, mimeType: faceMime } : await finalizeImageBuffer(fetched.buffer, faceMime);
          return { buffer: fim.buffer, mimeType: fim.mimeType, text: desc ? `[表情:${desc}]` : '' };
          }
        } catch (error) {
          log(`表情图片抓取失败: ${error?.message ?? error}`);
        }
      }
      return { text: desc ? `[表情:${desc}]` : fallbackText };
    }
  } catch (error) {
    log(`fetchFaceEntity 失败: ${error?.message ?? error}`);
  }
  return { text: fallbackText };
}

/**
 * 投递闸门：DSH 附件层对单边像素有硬限制（超限 = 整条 prompt 被 `attachment-error` 拒收，
 * 桥侧表现为一条「消息未被接受」的报错）。这里保证只要交出去的图一定合规；不合规就退化成文字占位，
 * 宁少一张图，也不要因为一张图把整轮唤醒/回复吞掉。
 */
async function gateImage(buffer, mimeType, label) {
  const checked = await ensureDeliverableImage(buffer, mimeType);
  if (checked.ok) return { ok: true, buffer: checked.buffer, mimeType: checked.mimeType };
  log(`[media] ${label} 尺寸不合规，已跳过不投递 DSH：${checked.reason}（硬上限单边 ${IMAGE_HARD_MAX_SIDE}px）`);
  return { ok: false, reason: checked.reason };
}

/* 2026-09-16：占位文案要明确告诉模型"这张图没到你手上"：
 * 以前只写 `[图片（获取失败）]`，模型容易顺着上下文"脑补"图里有什么（线上报的"看图乱猜"）。
 * 现在占位文案直接把规则写进去：看不到就如实说、不要猜内容、也不要描述样子。 */
/* 2026-10-29：占位文案统一成下划线短语，并留一个稳定标记 [image_lost] 供 persona-metrics 统计发图失败。
 * 语义不变：告诉模型"图没到你手上"—— 如实说，别猜（看图乱猜是历史事故）。 */
const IMAGE_LOST_TAG = '[image_lost]';
const MEDIA_PLACEHOLDER_HINT = '[no_image_content] say_it_plainly_no_guess';
export async function resolveOneMedia(media, opts = {}) {
  const raw = opts.raw === true;
  if (!media || typeof media !== 'object') return { ok: false, fallbackText: '' };
  if (media.kind === 'face') {
    const face = await fetchFaceMedia(media, opts);
    if (face.buffer) {
      if (raw) return { ok: true, face: true, buffer: face.buffer, mimeType: face.mimeType || 'image/png', faceText: face.text || '', raw: true };
      const g = await gateImage(face.buffer, face.mimeType || 'image/png', `表情#${media.faceId ?? ''}`);
      if (g.ok) return { ok: true, face: true, buffer: g.buffer, mimeType: g.mimeType, faceText: face.text || '' };
      return { ok: false, fallbackText: `${face.text || `[face#${media.faceId}]`} [image_skipped] ${MEDIA_PLACEHOLDER_HINT}` };
    }
    return { ok: false, fallbackText: face.text || `[表情#${media.faceId}]` };
  }
  const img = await fetchOneBotImage(media, opts);
  if (img?.buffer) {
    // 转发（raw）：只做安全校验，不做压缩/降采样 —— 这一步正是"默认转发原图"的实现点
    if (raw) return { ok: true, face: false, buffer: img.buffer, mimeType: img.mimeType || 'image/jpeg', raw: true };
    const g = await gateImage(img.buffer, img.mimeType || 'image/jpeg', '图片');
    if (g.ok) return { ok: true, face: false, buffer: g.buffer, mimeType: g.mimeType };
    return { ok: false, fallbackText: `[image_skipped] ${g.reason} ${MEDIA_PLACEHOLDER_HINT}` };
  }
  return { ok: false, fallbackText: `${IMAGE_LOST_TAG} ${MEDIA_PLACEHOLDER_HINT}` };
}

export async function resolveMediaList(mediaList) {
  const list = Array.isArray(mediaList) ? mediaList : [];
  const limited = [];
  let index = 0;
  for (const media of list) {
    index += 1;
    if (index > MAX_MEDIA_COUNT) {
      limited.push({ media: null, index, overLimit: true });
      continue;
    }
    if (!media || typeof media !== 'object') continue;
    limited.push({ media, index, overLimit: false });
  }
  // 并行解析全部图片/表情（每张内部已有 12s 短超时），避免多图串行卡住唤醒/回复
  const results = await Promise.all(limited.map(async ({ media, index, overLimit }) => {
    if (overLimit) return { type: 'text', text: `[图片/表情 ${index}（超过单条上限 ${MAX_MEDIA_COUNT}，已跳过）]` };
    const r = await resolveOneMedia(media);
    if (!r.ok) return { type: 'text', text: r.fallbackText || `${IMAGE_LOST_TAG} [image${index}] ${MEDIA_PLACEHOLDER_HINT}` };
    return r;
  }));
  const parts = [];
  let totalBytes = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (!r) continue;
    const idx = limited[i]?.index ?? i + 1;
    if (r.type === 'text') { parts.push(r); continue; }
    const size = r.buffer.length;
    if (totalBytes + size > MAX_MEDIA_BYTES) {
      parts.push({ type: 'text', text: r.face ? `[表情${idx}（图片总大小超限，已跳过）]` : `[图片${idx}（图片总大小超限，已跳过）]` });
      continue;
    }
    totalBytes += size;
    if (r.face) {
      if (r.faceText) parts.push({ type: 'text', text: r.faceText });
      parts.push({ type: 'image', mediaType: r.mimeType, data: r.buffer.toString('base64'), name: `face-${idx}.${(r.mimeType || 'png').split('/')[1]}` });
      continue;
    }
    /* 2026-09-19：配了「识图模型请求地址」→ 走独立识图通路：图片不进上下文，只把文字描述交给语言模型。
     * 失败（超时/非 2xx/没文字）就退回附件，绝不让识图故障变成"图丢了"。 */
    if (useVisionSplit()) {
      const d = await describeImageWithVisionModel(r.buffer, r.mimeType);
      if (d.ok) {
        log(`[vision] 图片${idx} 由独立识图模型 ${d.model} 转成文字（${d.text.length} 字，${d.ms}ms）`);
        parts.push({ type: 'text', text: `[图片${idx}] ${d.text}` });
        continue;
      }
      log(`[vision] 图片${idx} 独立识图失败（${d.error}），退回附件方式发给主模型`);
    }
    parts.push({ type: 'text', text: `[图片${idx}]` });
    parts.push({ type: 'image', mediaType: r.mimeType, data: r.buffer.toString('base64'), name: `qq-image-${idx}.${(r.mimeType || 'jpeg').split('/')[1]}` });
  }
  return parts;
}

export async function fetchMediaData(mediaList, opts = {}) {
  const raw = opts.raw === true;
  const list = Array.isArray(mediaList) ? mediaList : [];
  const limited = [];
  let index = 0;
  for (const media of list) {
    index += 1;
    if (index > MAX_MEDIA_COUNT) {
      limited.push({ media: null, index, overLimit: true });
      continue;
    }
    if (!media || typeof media !== 'object') continue;
    limited.push({ media, index, overLimit: false });
  }
  const results = await Promise.all(limited.map(async ({ media, index, overLimit }) => {
    if (overLimit) return { index, kind: 'image', text: `（超过单条上限 ${MAX_MEDIA_COUNT}，已跳过）` };
    const r = await resolveOneMedia(media, opts);
    if (!r.ok) {
      return {
        index,
        kind: media?.kind === 'face' ? 'face' : 'image',
        ...(media?.kind !== 'face' ? { file: media.file ? String(media.file) : undefined, url: media.url ? String(media.url) : undefined } : {}),
        text: r.fallbackText || `${IMAGE_LOST_TAG} ${MEDIA_PLACEHOLDER_HINT}`
      };
    }
    const out = {
      index,
      kind: r.face ? 'face' : 'image',
      mimeType: r.mimeType,
      data: r.buffer.toString('base64'),
      bytes: r.buffer.length,
      text: r.face ? (r.faceText || '') : ''
    };
    // raw=1（转发用）：如实标出这是未经压缩的原图字节
    if (raw) {
      out.raw = true;
      out.sha256 = createHash('sha256').update(r.buffer).digest('hex');
    }
    if (r.face) {
      if (media.faceId != null) out.faceId = String(media.faceId);
    } else {
      if (media.file) out.file = String(media.file);
      if (media.url) out.url = String(media.url);
    }
    return out;
  }));
  let totalBytes = 0;
  const out = [];
  for (const r of results) {
    if (!r) continue;
    if (r.data) {
      const size = Math.round(r.data.length * 3 / 4);
      if (totalBytes + size > MAX_MEDIA_BYTES) {
        out.push({ ...r, data: undefined, mimeType: undefined, text: `${r.text || ''}（图片总大小超限，已跳过）` });
        continue;
      }
      totalBytes += size;
    }
    out.push(r);
  }
  return out;
}
