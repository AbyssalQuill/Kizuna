// 步末瞬态人设与单一 Schema 裁剪器（Transient Persona & Single Schema Pruner）
// 核心设计：
// 1. 每轮通过工具或瞬态注入的人设，在当前步为模型提供极高权重（Prompt Weighting）后，
//    本轮结束立即修改 session 记录，剪除该单步内的冗余人设或巨大工具中间结果，
//    彻底阻断历史上下文的指数级暴增，下一轮按需重读，使上下文永久保持极轻量！
// 2. 会话内单一 Schema 保留机制（Single Schema Retention）：
//    一整个对话历史中最多只允许存在 1 个有效的 get_tool_schema 记录；
//    一旦模型偶发再次查询 schema，系统自动将前一次调用的旧记录及巨大返回结果剪除剔除，
//    避免冗长 JSON Schema 反复堆积占满上下文！

import fs from 'node:fs';
import path from 'node:path';
import { log } from '../lib/log.js';

const DSH_HOME = process.env.QQB_DSH_HOME || (process.platform === 'win32' ? 'C:/Users/17367/.dsh' : '/root/.dsh');

export function isSchemaToolName(name) {
  const n = String(name ?? '').trim();
  return /(?:^|__)(?:[A-Za-z0-9_-]+_)?get_tool_schema$/.test(n) || n === 'get_tool_schema';
}

function resolveSessionFile(sessionId, overridePath = null) {
  if (overridePath && fs.existsSync(overridePath)) return overridePath;
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
 * 单一 Schema 裁剪：一整个会话只保留最新 1 个 schema 查询结果，旧记录自动去重剪除
 * @param {string} sessionId
 * @param {string} [activeCallId] 正在执行或指定保留的最新 callId（若无则默认保留最后一个）
 * @param {string} [overridePath] 指定测试文件路径
 * @returns {{ pruned: boolean, schemaCountBefore: number, schemaCountAfter: number }}
 */
export function pruneSessionSchemaRecords(sessionId, activeCallId = null, overridePath = null) {
  const result = { pruned: false, schemaCountBefore: 0, schemaCountAfter: 0 };
  if (!sessionId && !overridePath) return result;

  try {
    const sessionFile = resolveSessionFile(sessionId, overridePath);
    if (!sessionFile) return result;

    const raw = fs.readFileSync(sessionFile, 'utf8');
    let modified = false;
    let prunedText = raw;

    // 1. 结构化 JSON 剪枝尝试
    try {
      const data = JSON.parse(raw);
      // 收集所有包含 schema 工具调用的节点
      const schemaResults = [];

      function walkAndCollect(obj) {
        if (!obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) {
          for (const item of obj) {
            if (item && typeof item === 'object') {
              const toolName = item.name || item.tool || item.tool_name || item.toolName;
              if (isSchemaToolName(toolName)) {
                schemaResults.push(item);
              }
            }
            walkAndCollect(item);
          }
          return;
        }
        for (const key of Object.keys(obj)) {
          walkAndCollect(obj[key]);
        }
      }

      walkAndCollect(data);
      result.schemaCountBefore = schemaResults.length;

      if (schemaResults.length > 1) {
        // 确定保留的目标项：优先匹配 activeCallId，否则保留最后一个
        let keepIndex = -1;
        if (activeCallId) {
          keepIndex = schemaResults.findIndex((item) => String(item.callId || item.id) === String(activeCallId));
        }
        if (keepIndex === -1) {
          keepIndex = schemaResults.length - 1; // 默认保留最新（最后）一个
        }

        for (let i = 0; i < schemaResults.length; i++) {
          if (i === keepIndex) continue;
          const oldItem = schemaResults[i];
          // 将前序旧调用的返回结果剪除为轻量占位
          if (oldItem.content !== undefined) {
            oldItem.content = '[previous schema result pruned: single-schema rule enforced]';
            modified = true;
          }
          if (oldItem.result !== undefined) {
            oldItem.result = '[previous schema result pruned: single-schema rule enforced]';
            modified = true;
          }
          if (oldItem.text !== undefined && typeof oldItem.text === 'string' && oldItem.text.length > 100) {
            oldItem.text = '[previous schema result pruned: single-schema rule enforced]';
            modified = true;
          }
        }

        if (modified) {
          prunedText = JSON.stringify(data, null, 2);
          result.pruned = true;
          result.schemaCountAfter = 1;
        }
      } else {
        result.schemaCountAfter = schemaResults.length;
      }
    } catch {
      // 非纯合法单一根 JSON 或嵌套特殊流时，走正则匹配
    }

    // 2. 文本正则兜底剪枝（针对非标准格式或 JSON 转义块中包含多份 schema）
    if (!result.pruned) {
      const SCHEMA_RE = /("(?:tool_name|name|tool)":\s*"(?:mcp__[^"]*__)?(?:[a-zA-Z0-9_-]+_)?get_tool_schema"[\s\S]{1,500}?"(?:content|text|result)":\s*")([\s\S]*?)(")/g;
      const matches = [...prunedText.matchAll(SCHEMA_RE)];
      result.schemaCountBefore = Math.max(result.schemaCountBefore, matches.length);

      if (matches.length > 1) {
        // 保留最后一个，前面的全部替换为轻量标记
        let count = 0;
        prunedText = prunedText.replace(SCHEMA_RE, (match, prefix, content, suffix) => {
          count++;
          if (count < matches.length) {
            return `${prefix}[previous schema result pruned: single-schema rule enforced]${suffix}`;
          }
          return match;
        });
        if (prunedText.length !== raw.length) {
          result.pruned = true;
          result.schemaCountAfter = 1;
        }
      }
    }

    if (result.pruned && prunedText.length < raw.length) {
      fs.writeFileSync(sessionFile, prunedText, 'utf8');
      const savedChars = raw.length - prunedText.length;
      log(`[schema-guard] 会话 ${sessionId} 自动剔除前序旧 schema 记录：释放 ${savedChars} 字符，仅保留最新一次有效 schema`);
    }

    return result;
  } catch (error) {
    log(`[schema-guard] 会话 ${sessionId} 单一 Schema 剪枝跳过：${error?.message ?? error}`);
    return result;
  }
}

/**
 * 在 turn/end 收尾时执行单步剪枝，精准剔除瞬态长人设及多余 schema 记录
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

    // 3. 联动单一 Schema 剪枝：保证整个会话历史中旧的 schema 记录已被彻底剔除
    pruneSessionSchemaRecords(sessionId);
  } catch (error) {
    // 剪枝异常不阻断主消息流
    log(`[pruner] 会话 ${sessionId} 步末剪枝跳过：${error?.message ?? error}`);
  }
}
