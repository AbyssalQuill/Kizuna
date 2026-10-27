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

  // 动态自适应超长图所需视口高度（彻底消除 3600px 限制，自适应长图）
  const lineCount = (markdown.match(/\n/g) || []).length + 1;
  const codeBlocks = Math.floor((markdown.match(/```/g) || []).length / 2);
  const mathBlocks = Math.floor((markdown.match(/\$\$/g) || []).length / 2);
  const estimatedHeight = Math.max(3600, Math.min(32000, Math.ceil(lineCount * 38 + codeBlocks * 220 + mathBlocks * 120 + 1600)));

  try {
    // 1. 无头浏览器截图（2x 超高清视网膜渲染，动态高度支持长图）
    execFileSync(chrome, [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--force-device-scale-factor=2',
      '--window-size=' + width + ',' + estimatedHeight,
      '--virtual-time-budget=3500',
      '--screenshot=' + tmpRawPng,
      tmpHtml
    ], { timeout: 60000, stdio: 'ignore' });

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
        'step = 4 if h > 4000 else 2',
        'for y in range(h - 1, 0, -step):',
        '    row = [im.getpixel((x, y)) for x in range(0, w, 4)]',
        '    if any((p[0] < 246 or p[1] < 246 or p[2] < 246) for p in row):',
        '        bottom_y = y',
        '        break',
        'crop_bottom = min(h, bottom_y + 48)',
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
      '    <div class="code-window-controls">',
      '      <span class="mac-dot mac-dot-red"></span>',
      '      <span class="mac-dot mac-dot-yellow"></span>',
      '      <span class="mac-dot mac-dot-green"></span>',
      '    </div>',
      '    <span class="code-badge">' + escapeHtml(cleanLang.toUpperCase() || 'CODE') + '</span>',
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

// ── 视觉样式（现代高颜值排版：Mac风格代码块、精致KaTeX、现代斑马纹表格） ──
function CSS_BODY(width) {
  return [
    '    * { box-sizing: border-box; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }',
    '    html, body { background: #ffffff; }',
    '    body {',
    '      margin: 0; padding: 0; color: #0f172a;',
    '      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;',
    '      font-size: 15px; line-height: 1.8; letter-spacing: 0.015em;',
    '      display: flex; justify-content: center; width: ' + width + 'px;',
    '    }',
    '    #container { width: 100%; padding: 36px 44px 42px 44px; background: #ffffff; }',
    '    .main-title { font-size: 24px; font-weight: 700; color: #0f172a; margin: 0 0 20px 0; padding-bottom: 12px; border-bottom: 2px solid #e2e8f0; line-height: 1.4; letter-spacing: -0.01em; }',
    '    h1 { font-size: 22px; font-weight: 700; color: #1e293b; margin: 28px 0 14px; line-height: 1.45; }',
    '    h2 { font-size: 18px; font-weight: 700; color: #1e293b; margin: 24px 0 12px; line-height: 1.5; }',
    '    h3 { font-size: 16px; font-weight: 600; color: #334155; margin: 20px 0 10px; line-height: 1.55; }',
    '    p { margin: 10px 0; }',
    '',
    '    /* ── 代码卡片：Mac 经典三色圆点 + 语言徽章 + 柔和边框 ── */',
    '    .code-card { margin: 18px 0 20px; border-radius: 10px; background: #f8fafc; border: 1px solid #e2e8f0; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.02); }',
    '    .code-header { display: flex; justify-content: space-between; align-items: center; padding: 8px 14px; background: #f1f5f9; border-bottom: 1px solid #e2e8f0; min-height: 32px; }',
    '    .code-window-controls { display: flex; gap: 6px; align-items: center; }',
    '    .mac-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }',
    '    .mac-dot-red { background: #ff5f56; }',
    '    .mac-dot-yellow { background: #ffbd2e; }',
    '    .mac-dot-green { background: #27c93f; }',
    '    .code-badge { font-size: 11px; font-weight: 600; color: #475569; background: #e2e8f0; padding: 2px 8px; border-radius: 4px; font-family: Consolas, "JetBrains Mono", Menlo, monospace; letter-spacing: 0.04em; }',
    '    pre { margin: 0 !important; padding: 12px 16px 18px 16px !important; overflow: visible;',
    '      font-family: Consolas, "JetBrains Mono", "Fira Code", Menlo, monospace !important;',
    '      font-size: 13.5px !important; line-height: 1.72 !important; color: #334155 !important; background: transparent !important; white-space: pre-wrap; word-break: break-word; }',
    '    code { font-family: Consolas, "JetBrains Mono", "Fira Code", Menlo, monospace; }',
    '    :not(pre) > code { background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 4px; padding: 2px 6px; font-size: 13px; color: #0f172a; font-weight: 500; }',
    '',
    '    /* ── 语法高亮：现代高对比度配色 ── */',
    '    .token.comment, .token.prolog, .token.doctype, .token.cdata { color: #94a3b8 !important; font-style: italic; }',
    '    .token.punctuation { color: #475569 !important; }',
    '    .token.property, .token.tag, .token.constant, .token.symbol, .token.deleted, .token.number, .token.boolean { color: #d97706 !important; }',
    '    .token.selector, .token.attr-name, .token.string, .token.char, .token.builtin, .token.inserted { color: #16a34a !important; }',
    '    .token.operator, .token.entity, .token.url { color: #475569 !important; }',
    '    .token.atrule, .token.attr-value, .token.keyword { color: #7c3aed !important; font-weight: 600; }',
    '    .token.function, .token.class-name { color: #2563eb !important; font-weight: 600; }',
    '    .token.regex, .token.important, .token.variable { color: #dc2626 !important; }',
    '    .token.italic { font-style: italic; } .token.bold { font-weight: 700; }',
    '',
    '    /* ── KaTeX 公式排版：微底衬托，舒适外边距 ── */',
    '    .katex { font-size: 1.08em; color: #0f172a; }',
    '    .katex-display { margin: 16px 0 !important; padding: 12px 16px; background: #f8fafc; border: 1px solid #f1f5f9; border-radius: 8px; text-align: center; overflow: visible; }',
    '    .katex-display > .katex { white-space: normal; }',
    '    .katex .boxed { padding: 0.34em 0.5em; border-width: 1px; border-color: #3b82f6; }',
    '',
    '    /* ── 表格 / 引用 / 列表 ── */',
    '    table { border-collapse: separate; border-spacing: 0; width: 100%; margin: 18px 0; font-size: 14px; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden; }',
    '    th, td { padding: 10px 14px; text-align: left; vertical-align: top; }',
    '    th { background: #f1f5f9; font-weight: 600; color: #1e293b; border-bottom: 1px solid #e2e8f0; }',
    '    td { border-bottom: 1px solid #f1f5f9; color: #334155; }',
    '    tbody tr:last-child td { border-bottom: none; }',
    '    tbody tr:nth-child(even) { background: #f8fafc; }',
    '    blockquote { margin: 16px 0; padding: 12px 18px; border-left: 4px solid #3b82f6; background: #f0f7ff; border-radius: 0 8px 8px 0; color: #1e3a8a; }',
    '    ul, ol { padding-left: 22px; margin: 12px 0; color: #334155; }',
    '    li { margin: 4px 0; }',
    '    hr { border: none; border-top: 1px dashed #cbd5e1; margin: 26px 0; }',
    '    a { color: #2563eb; text-decoration: none; font-weight: 500; }',
    '    strong { font-weight: 600; color: #0f172a; }'
  ].join('\n');
}
