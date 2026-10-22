// Markdown / KaTeX / 代码排版图片渲染器（DeepSeek 网页端浅色白底风格，服务端纯同步预渲染）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { marked } from 'marked';
import katex from 'katex';
import Prism from 'prismjs';
import loadLanguages from 'prismjs/components/index.js';
import { log } from './log.js';

// 预加载常用语言高亮支持
loadLanguages(['cpp', 'c', 'python', 'javascript', 'typescript', 'java', 'bash', 'json', 'yaml', 'sql', 'rust', 'go', 'html', 'css']);

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

// ── 浏览器可执行文件探测（Linux 生产机 / Windows 本机都能跑） ──
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  process.env.HEADLESS_CHROME_PATH,
  '/usr/local/bin/headless-chrome',
  '/usr/bin/headless-chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
].filter(Boolean);

function resolveChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {}
  }
  // 生产机上 headless-chrome 常是 PATH 里的包装脚本
  for (const name of ['headless-chrome', 'google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser', 'chrome']) {
    try {
      execFileSync(name, ['--version'], { stdio: 'ignore', timeout: 5000 });
      return name;
    } catch {}
  }
  return null;
}

// ── Python 解释器探测（用于 Pillow 精确裁剪） ──
function resolvePython() {
  for (const candidate of [process.env.PYTHON_BIN, 'python3', 'python']) {
    if (!candidate) continue;
    try {
      execFileSync(candidate, ['-c', 'import PIL'], { stdio: 'ignore', timeout: 8000 });
      return candidate;
    } catch {}
  }
  return null;
}

/**
 * 将 Markdown 文本渲染为纯白底精美图片（DeepSeek 网页端同款字体与代码公式排版）
 * @param {string} markdown - Markdown 格式文本，支持 $公式$ 和 $$块级公式$$
 * @param {object} options - 选项 { title, width = 820, outPath }
 * @returns {Promise<{ ok: boolean, imagePath: string, width: number, height: number }>}
 */
export async function renderMarkdownToImage(markdown, options = {}) {
  const width = Math.max(600, Math.min(1200, Number(options.width) || 820));
  const title = options.title ? String(options.title).trim() : '';

  const tmpId = 'md-render-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  const tmpHtml = path.join(os.tmpdir(), tmpId + '.html');
  const tmpRawPng = path.join(os.tmpdir(), tmpId + '-raw.png');
  const finalPng = options.outPath || path.join(os.tmpdir(), tmpId + '.png');

  const chrome = resolveChrome();
  if (!chrome) throw new Error('未找到可用的 headless Chrome/Chromium（可设置 CHROME_PATH）');

  const htmlContent = buildServerRenderedHtml(markdown, title, width);
  fs.writeFileSync(tmpHtml, htmlContent, 'utf8');

  try {
    // 1. 无头浏览器截图（2x 超高清视网膜渲染）
    execFileSync(chrome, [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--force-device-scale-factor=2',
      '--window-size=' + width + ',3600',
      '--virtual-time-budget=3000',
      '--screenshot=' + tmpRawPng,
      tmpHtml
    ], { timeout: 40000, stdio: 'ignore' });

    // 2. 用 Python Pillow 精确探测底部边界并裁剪
    let finW = width * 2;
    let finH = 0;
    const python = resolvePython();
    if (python && fs.existsSync(tmpRawPng)) {
      const cropScript = [
        'import sys',
        'from PIL import Image',
        'raw_path, out_path = sys.argv[1], sys.argv[2]',
        'im = Image.open(raw_path).convert("RGB")',
        'w, h = im.size',
        'bottom_y = h - 1',
        'for y in range(h - 1, 0, -2):',
        '    row = [im.getpixel((x, y)) for x in range(0, w, 4)]',
        '    if any((p[0] < 248 or p[1] < 248 or p[2] < 248) for p in row):',
        '        bottom_y = y',
        '        break',
        'crop_bottom = min(h, bottom_y + 44)',
        'im.crop((0, 0, w, crop_bottom)).save(out_path, "PNG")',
        'print("%dx%d" % (w, crop_bottom))'
      ].join('\n');
      const cropOut = execFileSync(python, ['-c', cropScript, tmpRawPng, finalPng], { encoding: 'utf8', timeout: 40000 }).trim();
      const parsed = cropOut.split('x').map(Number);
      finW = parsed[0] || finW;
      finH = parsed[1] || 0;
    } else {
      // 没有 Pillow 时直接交付整张截图，不阻塞功能
      fs.copyFileSync(tmpRawPng, finalPng);
      log('[render-md] 未找到带 Pillow 的 Python，跳过自动裁剪');
    }

    if (!finH) {
      const size = imageSize(finalPng);
      finW = size.width || finW;
      finH = size.height;
    }

    log('[render-md] 成功生成 Markdown 图片: ' + finalPng + ' (' + finW + 'x' + finH + ')');
    return { ok: true, imagePath: finalPng, width: finW, height: finH };
  } catch (error) {
    log('[render-md] 渲染图片失败:', error?.message ?? error);
    throw error;
  } finally {
    try { fs.unlinkSync(tmpHtml); } catch {}
    try { fs.unlinkSync(tmpRawPng); } catch {}
  }
}

// 读取 PNG 头里的宽高（避免再引入图像库）
function imageSize(pngPath) {
  try {
    const fd = fs.openSync(pngPath, 'r');
    const buf = Buffer.alloc(24);
    fs.readSync(fd, buf, 0, 24, 0);
    fs.closeSync(fd);
    if (buf.readUInt32BE(0) === 0x89504e47) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
  } catch {}
  return { width: 0, height: 0 };
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── KaTeX 样式与字体：字体以 base64 内嵌，彻底摆脱临时目录相对路径 404 ──
let cachedKatexStyle = null;
function katexStyleWithInlineFonts() {
  if (cachedKatexStyle !== null) return cachedKatexStyle;
  try {
    const cssPath = firstExisting([
      path.resolve('node_modules/katex/dist/katex.min.css'),
      path.resolve(MODULE_DIR, '../../../node_modules/katex/dist/katex.min.css')
    ]);
    if (!cssPath) { cachedKatexStyle = ''; return cachedKatexStyle; }
    const fontsDir = path.join(path.dirname(cssPath), 'fonts');
    let css = fs.readFileSync(cssPath, 'utf8');
    const cache = new Map();
    css = css.replace(/url\((['"]?)\.?\/?fonts\/([^'")]+)\1\)/g, (whole, quote, file) => {
      if (!file.endsWith('.woff2')) return whole; // 只内嵌 woff2，体积减半且所有现代内核都支持
      if (!cache.has(file)) {
        const full = path.join(fontsDir, file);
        cache.set(file, fs.existsSync(full) ? 'data:font/woff2;base64,' + fs.readFileSync(full).toString('base64') : null);
      }
      const data = cache.get(file);
      return data ? 'url(' + data + ')' : whole;
    });
    cachedKatexStyle = css;
    return css;
  } catch {
    cachedKatexStyle = '';
    return cachedKatexStyle;
  }
}

function firstExisting(list) {
  for (const item of list) {
    try { if (item && fs.existsSync(item)) return item; } catch {}
  }
  return null;
}

/**
 * 服务端预渲染数学公式与代码高亮，生成 100% 静态立即可截图的 HTML
 */
function buildServerRenderedHtml(markdown, title, width) {
  const safeTitle = escapeHtml(title);

  // 1. 抽取并预渲染 LaTeX 数学公式，避免被 marked 误格式化
  const mathPlaceholders = [];
  const addMath = (formula, displayMode) => {
    let rendered = '';
    try {
      rendered = katex.renderToString(formula.trim(), {
        displayMode,
        throwOnError: false,
        strict: 'ignore',
        trust: false,
        output: 'html'
      });
    } catch (e) {
      rendered = '<code>' + escapeHtml(formula) + '</code>';
    }
    const key = '@@KATEX_PLACEHOLDER_' + mathPlaceholders.length + '@@';
    mathPlaceholders.push({ key, html: rendered, display: Boolean(displayMode) });
    return key;
  };

  // 优先匹配块级公式 $$ ... $$
  let processed = String(markdown || '').replace(/\$\$([\s\S]+?)\$\$/g, (_, f) => addMath(f, true));
  // 匹配行内公式 $ ... $（避免把货币符号 $100 当成公式）
  processed = processed.replace(/(?<!\$)\$([^\$\n]+?)\$(?!\$)/g, (_, f) => addMath(f, false));

  // 2. 配置 marked 自定义渲染器（专门生成 DeepSeek 网页端代码卡片）
  const renderer = new marked.Renderer();
  renderer.code = function ({ text, lang }) {
    const rawLang = String(lang || '').trim();
    const cleanLang = rawLang.toLowerCase().split(/\s+/)[0] || 'text';
    let highlighted = '';

    const prismLang = cleanLang === 'c++' ? 'cpp' : (Prism.languages[cleanLang] ? cleanLang : null);
    if (prismLang && Prism.languages[prismLang]) {
      try {
        highlighted = Prism.highlight(text, Prism.languages[prismLang], prismLang);
      } catch (e) {
        highlighted = escapeHtml(text);
      }
    } else {
      highlighted = escapeHtml(text);
    }

    return [
      '<div class="code-card">',
      '  <div class="code-header">',
      '    <span class="code-lang">' + escapeHtml(cleanLang || 'text') + '</span>',
      '    <div class="code-actions">',
      '      <span class="code-action-btn">',
      '        <svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>复制',
      '      </span>',
      '      <span class="code-action-btn">',
      '        <svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>下载',
      '      </span>',
      '    </div>',
      '  </div>',
      '  <pre class="language-' + escapeHtml(cleanLang) + '"><code class="language-' + escapeHtml(cleanLang) + '">' + highlighted + '</code></pre>',
      '</div>'
    ].join('\n');
  };

  marked.setOptions({ renderer, gfm: true, breaks: true });
  let htmlBody = marked.parse(processed);

  // 3. 把数学公式 HTML 替换回占位符（块级公式先剥掉 marked 包上的 <p> 外壳，否则会继承行高产生大块空白）
  for (const item of mathPlaceholders) {
    const wrappedP = new RegExp('<p>\\s*' + item.key + '\\s*(?:<br\\s*\\/?>)?</p>');
    if (item.display) {
      htmlBody = htmlBody.replace(wrappedP, item.html);
    }
    htmlBody = htmlBody.split(item.key).join(item.html);
  }

  const katexCss = katexStyleWithInlineFonts();

  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '  <meta charset="UTF-8">',
    '  <title>' + (safeTitle || '解答') + '</title>',
    katexCss ? '  <style>' + katexCss + '</style>' : '  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">',
    '  <style>',
    CSS_BODY(width),
    '  </style>',
    '</head>',
    '<body>',
    '  <div id="container">',
    (title ? '    <div class="main-title">' + safeTitle + '</div>' : ''),
    '    <div id="content">' + htmlBody + '</div>',
    '  </div>',
    '</body>',
    '</html>'
  ].join('\n');
}

// ── 视觉样式（对齐 DeepSeek 网页端浅色主题） ──
function CSS_BODY(width) {
  return [
    '    * { box-sizing: border-box; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }',
    '    html, body { background: #ffffff; }',
    '    body {',
    '      margin: 0; padding: 0; color: #0f1115;',
    '      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;',
    '      font-size: 15px; line-height: 1.75; letter-spacing: 0.01em;',
    '      display: flex; justify-content: center; width: ' + width + 'px;',
    '    }',
    '    #container { width: 100%; padding: 32px 40px 36px 40px; background: #ffffff; }',
    '    .main-title { font-size: 22px; font-weight: 700; color: #0f1115; margin: 0 0 20px 0; line-height: 1.45; letter-spacing: 0; }',
    '    h1 { font-size: 23px; font-weight: 700; color: #0f1115; margin: 26px 0 14px; line-height: 1.45; }',
    '    h2 { font-size: 19px; font-weight: 700; color: #0f1115; margin: 24px 0 12px; line-height: 1.5; }',
    '    h3 { font-size: 16px; font-weight: 700; color: #0f1115; margin: 20px 0 10px; line-height: 1.55; }',
    '    p { margin: 10px 0; }',
    '',
    '    /* ── 代码卡片：单一浅灰底、无描边（DeepSeek 网页端） ── */',
    '    .code-card { margin: 16px 0 18px; border-radius: 10px; background: #f9fafb; border: none; overflow: hidden; }',
    '    .code-header { display: flex; justify-content: space-between; align-items: center; padding: 10px 16px 2px 16px; min-height: 28px; background: transparent; }',
    '    .code-lang { font-size: 12px; color: #6a6e72; font-family: Consolas, "SF Mono", "JetBrains Mono", Menlo, monospace; letter-spacing: 0; }',
    '    .code-actions { display: flex; gap: 14px; align-items: center; color: #9b9ea2; font-size: 12px; }',
    '    .code-action-btn { display: inline-flex; align-items: center; gap: 4px; }',
    '    .code-action-btn svg { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }',
    '    pre { margin: 0 !important; padding: 8px 16px 18px 16px !important; overflow: visible;',
    '      font-family: Consolas, "SF Mono", "Fira Code", "JetBrains Mono", Menlo, monospace !important;',
    '      font-size: 13.5px !important; line-height: 1.72 !important; color: #383a42 !important; background: transparent !important; white-space: pre-wrap; word-break: break-word; }',
    '    code { font-family: Consolas, "SF Mono", "Fira Code", "JetBrains Mono", Menlo, monospace; }',
    '    :not(pre) > code { background: #ebeef2; border: none; border-radius: 4px; padding: 1px 5px; font-size: 13px; color: #4a4c51; }',
    '',
    '    /* ── 语法高亮：DeepSeek 网页端同款（Atom One Light 变体） ── */',
    '    .token.comment, .token.prolog, .token.doctype, .token.cdata { color: #a0a1a7 !important; font-style: italic; }',
    '    .token.punctuation { color: #383a42 !important; }',
    '    .token.property, .token.tag, .token.constant, .token.symbol, .token.deleted, .token.number, .token.boolean { color: #986801 !important; }',
    '    .token.selector, .token.attr-name, .token.string, .token.char, .token.builtin, .token.inserted { color: #50a14f !important; }',
    '    .token.operator, .token.entity, .token.url { color: #383a42 !important; }',
    '    .token.atrule, .token.attr-value, .token.keyword { color: #a626a4 !important; font-weight: 400; }',
    '    .token.function, .token.class-name { color: #4078f2 !important; font-weight: 400; }',
    '    .token.regex, .token.important, .token.variable { color: #e45649 !important; }',
    '    .token.italic { font-style: italic; } .token.bold { font-weight: 700; }',
    '',
    '    /* ── KaTeX 公式排版：数学字体必须真正加载，否则上下标会错位重叠 ── */',
    '    .katex { font-size: 1.06em; color: #0f1115; }',
    '    .katex-display { margin: 14px 0 !important; text-align: center; overflow: visible; }',
    '    .katex-display > .katex { white-space: normal; }',
    '    .katex .boxed { padding: 0.34em 0.5em; border-width: 1px; border-color: #3f4550; }',
    '',
    '    /* ── 表格 / 引用 / 列表 ── */',
    '    table { border-collapse: collapse; width: 100%; margin: 14px 0; font-size: 14px; }',
    '    th, td { border: 1px solid #e6e8ec; padding: 8px 12px; text-align: left; vertical-align: top; }',
    '    th { background: #f7f8fa; font-weight: 600; color: #0f1115; }',
    '    tbody tr:nth-child(even) { background: #fbfcfd; }',
    '    blockquote { margin: 14px 0; padding: 2px 0 2px 14px; border-left: 2px solid #d5d8de; color: #4a4c51; }',
    '    ul, ol { padding-left: 22px; margin: 10px 0; }',
    '    li { margin: 3px 0; }',
    '    hr { border: none; border-top: 1px solid #e6e8ec; margin: 22px 0; }',
    '    a { color: #4078f2; text-decoration: none; }',
    '    strong { font-weight: 600; }'
  ].join('\n');
}
