// QQ 空间说说与动态（小鲸鱼自主发表）
import { log } from '../lib/log.js';
import { initMemoryDb } from './memory.js';

let cfgRef = null;
export function initQzoneCore(cfg) { cfgRef = cfg; }

/**
 * 小鲸鱼自主发表一条 QQ 空间说说动态
 * 由模型结合当下的真实想法、群聊/私聊事件或生活点滴生成，拒绝预设模板死板同质化
 */
export async function publishCustomQzone(content, images = []) {
  const cleanContent = String(content ?? '').trim();
  if (!cleanContent) {
    throw new Error('说说正文内容不能为空');
  }

  const napcatBase = String(cfgRef?.napcat?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const body = { content: cleanContent };

  const res = await fetch(`${napcatBase}/send_qzone_msg`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cfgRef?.napcat?.accessToken ? { authorization: `Bearer ${cfgRef.napcat.accessToken}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });

  const j = await res.json().catch(() => ({}));
  if (j.status !== 'ok' || j.retcode !== 0) {
    throw new Error(`OneBot send_qzone_msg 失败: ${j.message || j.wording || res.status}`);
  }

  // 记录到空间动态记忆表，便于后续上下文检索
  const uid = String(cfgRef?.ownerQQ ?? '');
  try {
    const db = initMemoryDb();
    if (db) {
      db.prepare('INSERT INTO memory_entries (uid, category, content, created_at) VALUES (?, ?, ?, ?)')
        .run(uid, 'qzone_post', `我发了一条空间说说：${cleanContent}`, Date.now());
    }
  } catch (e) {
    log(`[qzone] 写入空间说说记忆记录异常: ${e?.message ?? e}`);
  }

  log(`[qzone] 小鲸鱼自主发布空间说说成功: ${cleanContent.slice(0, 35)}…`);
  return { ok: true, content: cleanContent };
}

/**
 * 兼容旧导出：已停用死板预设模板的盲目轮询
 */
export async function postRandomQzone() {
  log('[qzone] 空间说说已转为小鲸鱼自主决策发表模式，跳过静态模板自动抽选');
  return { ok: true, skipped: true };
}
