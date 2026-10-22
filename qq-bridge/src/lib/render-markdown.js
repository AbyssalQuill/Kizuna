// Markdown / KaTeX / 代码排版图片渲染器（DeepSeek 网页端浅色白底风格）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { log } from './log.js';

/**
 * 将 Markdown 文本渲染为纯白底精美图片（DeepSeek 网页端同款字体与代码公式排版）
 * @param {string} markdown - Markdown 格式文本，支持 $公式$ 和 $$块级公式$$
 * @param {object} options - 选项 { title, width = 820, outPath }
 * @returns {Promise<{ ok: boolean, imagePath: string, width: number, height: number }>}
 */
export async function renderMarkdownToImage(markdown, options = {}) {
  const width = Math.max(600, Math.min(1200, Number(options.width) || 820));
  const title = options.title ? String(options.title).trim() : '';

  const tmpId = `md-render-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const tmpHtml = path.join(os.tmpdir(), `${tmpId}.html`);
  const tmpRawPng = path.join(os.tmpdir(), `${tmpId}-raw.png`);
  const finalPng = options.outPath || path.join(os.tmpdir(), `${tmpId}.png`);

  const htmlContent = buildDeepSeekHtml(markdown, title, width);
  fs.writeFileSync(tmpHtml, htmlContent, 'utf8');

  try {
    // 1. 无头浏览器截图
    const chromeCmd = fs.existsSync('/usr/local/bin/headless-chrome') ? '/usr/local/bin/headless-chrome' : 'headless-chrome';
    execFileSync(chromeCmd, [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--force-device-scale-factor=2', // 2x 超高清视网膜渲染
      `--window-size=${width},3600`,
      `--screenshot=${tmpRawPng}`,
      tmpHtml
    ], { timeout: 20000 });

    // 2. 使用 Python Pillow 精确探测底部边界并裁剪
    const cropScript = `
import sys
from PIL import Image

raw_path = sys.argv[1]
out_path = sys.argv[2]

im = Image.open(raw_path).convert("RGB")
w, h = im.size

# 寻找底部最后一个非纯白像素（容差 rgb > 250）
# 从底部向上扫描
bottom_y = h - 1
for y in range(h - 1, 0, -2):
    is_blank = True
    for x in range(0, w, 4):
        p = im.getpixel((x, y))
        if p[0] < 248 or p[1] < 248 or p[2] < 248:
            is_blank = False
            bottom_y = y
            break
    if not is_blank:
        break

# 留 32px 底部 padding
crop_bottom = min(h, bottom_y + 48)
# 顶部若有空白也保留 padding
cropped = im.crop((0, 0, w, crop_bottom))
cropped.save(out_path, "PNG", quality=95)
print(f"{w}x{crop_bottom}")
`;
    const cropOut = execFileSync('python3', ['-c', cropScript, tmpRawPng, finalPng], { encoding: 'utf8' }).trim();
    const [finW, finH] = cropOut.split('x').map(Number);

    log(`[render-md] 成功生成 Markdown 图片: ${finalPng} (${finW}x${finH})`);
    return { ok: true, imagePath: finalPng, width: finW, height: finH };
  } catch (error) {
    log(`[render-md] 渲染图片失败:`, error?.message ?? error);
    throw error;
  } finally {
    try { fs.unlinkSync(tmpHtml); } catch {}
    try { fs.unlinkSync(tmpRawPng); } catch {}
  }
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildDeepSeekHtml(markdown, title, width) {
  const safeTitle = escapeHtml(title);
  const safeMarkdown = JSON.stringify(markdown);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>${safeTitle || '解答'}</title>
  <!-- KaTeX 数学公式渲染库与样式 -->
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
  <script src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/contrib/auto-render.min.js"></script>
  <!-- Marked Markdown 解析 -->
  <script src="https://cdn.jsdelivr.net/npm/marked@11.1.1/marked.min.js"></script>
  <!-- Prism 代码高亮 -->
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/themes/prism.min.css">
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/prism.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-cpp.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-python.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-javascript.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-java.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/prismjs@1.29.0/components/prism-bash.min.js"></script>

  <style>
    * {
      box-sizing: border-box;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }
    body {
      margin: 0;
      padding: 0;
      background-color: #ffffff;
      color: #0f172a;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif;
      font-size: 15px;
      line-height: 1.75;
      letter-spacing: -0.01em;
      display: flex;
      justify-content: center;
      width: ${width}px;
    }
    #container {
      width: 100%;
      padding: 32px 36px 40px 36px;
      background-color: #ffffff;
    }
    ${title ? `
    .main-title {
      font-size: 22px;
      font-weight: 700;
      color: #000000;
      margin: 0 0 18px 0;
      line-height: 1.4;
    }` : ''}
    
    h1 { font-size: 20px; font-weight: 700; color: #000000; margin: 24px 0 12px 0; }
    h2 { font-size: 17px; font-weight: 700; color: #000000; margin: 20px 0 10px 0; }
    h3 { font-size: 15px; font-weight: 600; color: #0f172a; margin: 16px 0 8px 0; }
    p { margin: 10px 0; }

    /* DeepSeek 网页端同款代码块卡片 */
    .code-card {
      margin: 16px 0;
      border-radius: 8px;
      border: 1px solid #e2e8f0;
      background: #f8fafc;
      overflow: hidden;
    }
    .code-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 7px 14px;
      background: #f1f5f9;
      border-bottom: 1px solid #e2e8f0;
      font-size: 12px;
      color: #64748b;
      font-family: Consolas, "JetBrains Mono", monospace;
    }
    .code-actions {
      display: flex;
      gap: 12px;
      align-items: center;
      color: #64748b;
      font-size: 12px;
    }
    .code-action-btn {
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .code-action-btn svg {
      width: 13px;
      height: 13px;
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
    }
    pre {
      margin: 0 !important;
      padding: 14px 16px !important;
      overflow-x: auto;
      font-family: Consolas, "Fira Code", "JetBrains Mono", Menlo, monospace !important;
      font-size: 13.5px !important;
      line-height: 1.6 !important;
      color: #1e293b !important;
      background: transparent !important;
    }
    code {
      font-family: Consolas, "Fira Code", "JetBrains Mono", Menlo, monospace;
    }
    :not(pre) > code {
      background: #f1f5f9;
      border: 1px solid #e2e8f0;
      border-radius: 4px;
      padding: 2px 6px;
      font-size: 13.5px;
      color: #0f172a;
    }

    /* KaTeX 公式优化 */
    .katex-display {
      margin: 16px 0 !important;
      text-align: center;
    }
    .katex {
      font-size: 1.08em;
    }
    /* 表格 */
    table {
      border-collapse: collapse;
      width: 100%;
      margin: 16px 0;
      font-size: 14px;
    }
    th, td {
      border: 1px solid #e2e8f0;
      padding: 8px 12px;
      text-align: left;
    }
    th {
      background-color: #f8fafc;
      font-weight: 600;
    }
    tr:nth-child(even) {
      background-color: #fbfcfd;
    }
    /* 引用块 */
    blockquote {
      margin: 14px 0;
      padding: 4px 0 4px 14px;
      border-left: 3px solid #cbd5e1;
      color: #475569;
    }
    ul, ol {
      padding-left: 24px;
      margin: 10px 0;
    }
    li {
      margin: 4px 0;
    }
  </style>
</head>
<body>
  <div id="container">
    ${title ? `<div class="main-title">${safeTitle}</div>` : ''}
    <div id="content"></div>
  </div>

  <script>
    const rawMarkdown = ${safeMarkdown};
    const contentEl = document.getElementById('content');
    
    // 渲染 Markdown
    contentEl.innerHTML = marked.parse(rawMarkdown);

    // 包装代码块为 DeepSeek 风格卡片
    contentEl.querySelectorAll('pre').forEach((pre) => {
      const code = pre.querySelector('code');
      let lang = 'code';
      if (code) {
        const cls = Array.from(code.classList).find(c => c.startsWith('language-'));
        if (cls) lang = cls.replace('language-', '');
      }
      
      const card = document.createElement('div');
      card.className = 'code-card';
      card.innerHTML = \`
        <div class="code-header">
          <span>\${lang}</span>
          <div class="code-actions">
            <span class="code-action-btn">
              <svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
              复制
            </span>
            <span class="code-action-btn">
              <svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
              下载
            </span>
          </div>
        </div>
      \`;
      pre.parentNode.insertBefore(card, pre);
      card.appendChild(pre);
    });

    // 语法高亮
    if (window.Prism) Prism.highlightAll();

    // KaTeX 数学公式自动渲染
    renderMathInElement(contentEl, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '$', right: '$', display: false },
        { left: '\\\\[', right: '\\\\]', display: true },
        { left: '\\\\(', right: '\\\\)', display: false }
      ],
      throwOnError: false
    });
  </script>
</body>
</html>`;
}
