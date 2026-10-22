// Excel (.xlsx) 表格生成与发送
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { DOC_TMP_DIR, uploadFileToQQ } from './docx.js';
import { log } from '../lib/log.js';

let cfgRef = null;
export function initExcelCore(cfg) {
  cfgRef = cfg;
}

/**
 * 生成并发送 Excel 表格到 QQ 会话
 * @param {string} key - 会话 key（如 group:123 或 private:456）
 * @param {string} filename - 文件名（如 统计表.xlsx）
 * @param {object} spec - 表格数据规范 { sheets: [{ name, headers, rows }] } 或 { title, headers, rows }
 * @param {object} options - 附加选项
 */
export async function sendExcel(key, filename, spec, options = {}) {
  try {
    fs.mkdirSync(DOC_TMP_DIR, { recursive: true });
  } catch {}

  const rawName = String(filename || spec?.title || '表格').replace(/[\\/:*?"<>|\r\n]/g, '_').trim() || '表格';
  const baseName = rawName.toLowerCase().endsWith('.xlsx') ? rawName.slice(0, -5) : rawName;
  const outFileName = `${baseName}-${Date.now()}.xlsx`;
  const outHostPath = path.join(DOC_TMP_DIR, outFileName);

  const tmpSpec = path.join(os.tmpdir(), `excel-spec-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  try {
    fs.writeFileSync(tmpSpec, JSON.stringify(spec || {}, null, 2), 'utf8');

    let helperPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../lib/doc-helper.py');
    if (!fs.existsSync(helperPath)) {
      helperPath = path.resolve('qq-bridge/src/lib/doc-helper.py');
    }

    const out = execFileSync('python3', [helperPath, 'generate_excel', tmpSpec, outHostPath], {
      encoding: 'utf8',
      timeout: 30000
    });
    const res = JSON.parse(out.trim());
    if (!res.ok) {
      throw new Error(`生成 Excel 失败: ${res.error || '未知错误'}`);
    }

    const stat = fs.statSync(outHostPath);
    const sent = await uploadFileToQQ(key, outHostPath, `${baseName}.xlsx`, options);
    log(`[excel] 成功发送 Excel 表格到 ${key}: ${baseName}.xlsx (${stat.size} 字节)`);
    return { ...sent, size: stat.size };
  } finally {
    try { fs.unlinkSync(tmpSpec); } catch {}
  }
}
