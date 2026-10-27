// 步末瞬态人设裁剪器（Transient Persona Pruner）
// 核心设计：每轮通过工具或瞬态注入的人设，在当前步为模型提供极高权重（Prompt Weighting）后，
// 本轮结束立即修改 session 记录，剪除该单步内的冗余人设或巨大工具中间结果，
// 彻底阻断历史上下文的指数级暴增，下一轮按需重读，使上下文永久保持极轻量！

import fs from 'node:fs';
import path from 'node:path';
import { log } from '../lib/log.js';

const DSH_HOME = process.env.QQB_DSH_HOME || (process.platform === 'win32' ? 'C:/Users/17367/.dsh' : '/root/.dsh');

function resolveSessionFile(sessionId) {
  if (!sessionId) return null;
  const cleanId = String(sessionId).replace(/\.json$/, '');
  const candidates = [
    path.join(DSH_HOME, 'storages', 'session_projcache', 'sessions', `${cleanId}.json`),
    path.join(DSH_HOME, 'storages', 'session_projcache', 'sessions', `session-${cleanId}.json`),
    path.join(DSH_HOME, 'storages', 'session_projcache', 'sessions', cleanId.replace(/^session-/, '') + '.json'),
  ];
  return candidates.find((p) => {
    try { return fs.existsSync(p); } catch { return false; }
  }) || null;
}

/**
 * 在 turn/end 收尾时执行单步剪枝，精准剔除瞬态长人设（只有人设时这样，不碰任何其他业务）
 * @param {string} sessionId 
 */
export async function pruneSessionEphemeralRecord(sessionId) {
  if (!sessionId) return;
  try {
    const sessionFile = resolveSessionFile(sessionId);
    if (!sessionFile) return;

    const raw = fs.readFileSync(sessionFile, 'utf8');
    const sizeBefore = raw.length;
    let pruned = raw;

    // 1. 若包含了完整的长人设块（【persona_load】），在历史中剪枝为瞬态占位，防多轮累加
    const PERSONA_TRIGGER = '【persona_load】';
    if (pruned.includes(PERSONA_TRIGGER)) {
      pruned = pruned.replace(/(【persona_load】[\s\S]{200,}?)(?="\]|\}\]|\n\n\[对话风格示范\]|\n\n\[RecentMessages\]|\\n\\n\[|$)/g, () => {
        return '【persona_load: ephemeral_turn_pruned】';
      });
    }

    // 2. 剪除 qq_load_persona 工具在当轮返回的巨大人设全文（保留调用痕迹，抹平膨胀文本）
    pruned = pruned.replace(/("(?:tool_name|name)":\s*"(?:mcp__[^"]*__)?qq_load_persona"[\s\S]{1,300}?"content":\s*")[\s\S]{300,}?(")/g, '$1[Persona dynamically loaded in-turn & pruned]$2');

    // 针对 JSON 转义场景
    pruned = pruned.replace(/(\\n|\\r\\n)?【persona_load】[\s\S]{200,}?(?=\\n\[Session\]|\\n\[Token\]|"|\\")/g, '\\n【persona_load: ephemeral_pruned】');

    if (pruned.length < sizeBefore) {
      fs.writeFileSync(sessionFile, pruned, 'utf8');
      const savedChars = sizeBefore - pruned.length;
      log(`[pruner] 会话 ${sessionId} 步末剪枝成功：精准释放 ${savedChars} 字符人设，历史上下文复位`);
    }
  } catch (error) {
    // 剪枝异常不阻断主消息流
    log(`[pruner] 会话 ${sessionId} 步末剪枝跳过：${error?.message ?? error}`);
  }
}
