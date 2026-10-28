// 媒体/文件引用安全校验
// isSafeLocalMediaPath 原读取运行态 cfg.napcat.homeDir，现改为参数注入（调用方传 cfg.napcat?.homeDir）。
import fs from 'node:fs';
import path from 'node:path';

// 校验本地媒体路径必须位于合法目录之内（homeDir、/home/qq/.config/QQ、/root/.config/QQ 或 NTQQ 数据目录）
export function isSafeLocalMediaPath(filePath, homeDir) {
  try {
    const real = fs.realpathSync(String(filePath));
    const normalized = real.replace(/\\/g, '/');
    // 1. 如果在显式指定的 homeDir 及其下，放行
    if (homeDir) {
      try {
        const realHome = fs.realpathSync(String(homeDir)).replace(/\\/g, '/');
        if (normalized === realHome || normalized.startsWith(realHome + '/')) return true;
      } catch {}
    }
    // 2. Linux / Windows 宿主机常见 QQ / NapCat 数据缓存目录放行
    const allowedRoots = [
      '/home/qq/.config/QQ',
      '/root/.config/QQ',
      '/opt/napcat',
    ];
    for (const r of allowedRoots) {
      if (normalized.startsWith(r)) return true;
    }
    // 3. 严格匹配 NTQQ 原图/缩略图特征路径（防止读到 QQ 账号敏感配置，仅限 Pic/Ori/Thumb 媒体子目录）
    if (/\/nt_data\/Pic\//i.test(normalized) || /\/nt_data\/Thumb\//i.test(normalized)) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// OneBot 图片 file 字段只应接受简单缓存文件名；拒绝路径、URL、盘符、协议前缀等，
// 防止把任意本地路径/内网 URL 交给网关 get_image 造成 SSRF/任意文件读取。
export function isProbablySafeImageFileRef(file) {
  const s = String(file ?? '').trim();
  if (!s || s.length > 512) return false;
  if (/[\u0000-\u001f\u007f]/.test(s)) return false;
  if (/[\\/]/.test(s)) return false;
  if (/^[a-zA-Z]:/.test(s)) return false;
  if (/^(file|https?|base64|data):/i.test(s)) return false;
  if (s.includes('..')) return false;
  return /^[\w.+=@-]+$/.test(s);
}
