// QQ 桥接安全硬边界与调用流守卫：
// 1) 隐藏全局开发工具（restrict）；
// 2) 白名单兜底（guard）；
// 3) 防呆拦截：严禁将会话 Token / QQ 号作为工具名盲调；
// 4) 强制 step_1：发言前必须先调用 qq_load_persona 载入角色设定，否则物理拦截打回；
// 5) 消息发送后防狂乱收敛：发完消息后严禁盲目调用无关工具，强制回复 OK 完结本轮。

export const name = 'qq-tool-restrict';

export const inject = ['tools'];

const KNOWN_DANGEROUS_GLOBAL_TOOLS = [
  'dev_build_plugin',
  'dev_clear_routes',
  'dev_fix_patch',
  'dev_heal_links',
  'dev_inject_plugin',
  'dev_injected_list',
  'dev_install_package',
  'dev_mode_set',
  'dev_mode_status',
  'dev_mode_subagent',
  'dev_plugin_status',
  'dev_router_mode',
  'dev_router_status',
  'dev_release_plugin',
  'dev_reload_package',
  'dev_scaffold_plugin',
  'dev_self_test',
  'dev_stage_add',
  'dev_stage_call',
  'dev_stage_demote',
  'dev_stage_list',
  'dev_stage_promote',
  'dev_uninject_plugin',
];

const SAFE_PREFIXES = [
  'mcp__napcat__',
  'mcp__napcat-host__',
  'mcp__web-search-safe__',
];

const SAFE_EXACT = new Set([
  'ask_user_question',
  'todo_write',
  'agy_tool',
]);

// 会话人设加载与发言状态记录（基于 sessionId）
export const sessionLoadedPersona = new Map();
export const sessionSentMessage = new Map();
export const sessionLoadedCount = new Map();
export const sessionSentCount = new Map();

export function apply(ctx) {
  // 1) 隐藏危险全局工具
  for (const name of KNOWN_DANGEROUS_GLOBAL_TOOLS) {
    try {
      ctx.tools.restrict({ deny: [name] });
    } catch (error) {
      const detail = String(error?.message ?? error);
      console.error(`[qq-tool-restrict] skip restrict ${name}: ${detail.slice(0, 160)}${detail.length > 160 ? '…' : ''}`);
    }
  }

  // 2) 执行期白名单与动作流物理硬守卫
  ctx.tools.guard((exec) => {
    const name = String(exec?.name ?? '').trim();
    if (!name) return;

    // 提取压缩代理包装下的真实工具名
    const innerName = String(exec.arguments?.tool_name || exec.arguments?.toolName || '').trim();
    const effectiveName = innerName || name;

    // ① 防呆拦截：严禁把 Token 或纯数字当成工具名调用
    if (/^\d{5,12}$/.test(name)) {
      return `"${name}" 是会话鉴权 Token 参数，不是工具名！请直接在工具参数内传 token 字段，禁止作为工具调用。`;
    }
    if (innerName && /^\d{5,12}$/.test(innerName)) {
      return `"${innerName}" 是会话鉴权 Token 参数，不是工具名！请直接在工具参数内传 token 字段，禁止作为工具调用。`;
    }

    // ② 后台学习任务工具豁免（离线分析与画像抽取无须遵循群聊会话流程）
    if (/qq_learning_/.test(effectiveName) || /qq_learning_/.test(name)) {
      return;
    }

    // ③ 白名单检查
    if (!SAFE_EXACT.has(name) && !SAFE_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      return `工具 "${name}" 不在 QQ 桥接白名单内，已拒绝（仅允许 QQ MCP 工具与无害模型侧工具）`;
    }

    const sessId = String(exec.agent?.session?.id || 'default');
    if (!sessionLoadedPersona.has(sessId)) sessionLoadedCount.delete(sessId);
    if (!sessionSentMessage.has(sessId)) sessionSentCount.delete(sessId);

    const isLoadPersona = effectiveName === 'qq_load_persona' || name.endsWith('__qq_load_persona');
    const isSendTool = effectiveName === 'qq_send_message' || name.endsWith('__qq_send_message') ||
                       effectiveName === 'qq_send_voice' || name.endsWith('__qq_send_voice');

    // ④ 记录人设加载标记
    if (isLoadPersona) {
      sessionLoadedPersona.set(sessId, Date.now());
      sessionLoadedCount.set(sessId, (sessionLoadedCount.get(sessId) || 0) + 1);
      return; // 允许加载人设
    }

    // ⑤ 物理硬门禁：每轮硬开局发言前必须已调用 qq_load_persona（loadedCount > sentCount）
    if (isSendTool) {
      const loaded = sessionLoadedCount.get(sessId) || 0;
      const sent = sessionSentCount.get(sessId) || 0;
      if (loaded <= sent) {
        return '协议违规：每轮硬开局必须先执行 step_1，调用 qq_load_persona 读取角色设定！本轮尚未调用 qq_load_persona，禁止发送。请立即调用 qq_load_persona。';
      }
      sessionSentCount.set(sessId, sent + 1);
      sessionSentMessage.set(sessId, Date.now());
      return;
    }

    // ⑥ 发言后防狂乱收敛：本轮已经调用过发言后，严禁继续盲调空间、定时、无目的搜图等无关工具
    const sentAt = sessionSentMessage.get(sessId) || 0;
    if (sentAt && (Date.now() - sentAt < 30 * 1000)) {
      const isPostChatUnrelated = /^(qq_qzone_|qq_publish_qzone|qq_schedule_|qq_image_search)/.test(effectiveName);
      if (isPostChatUnrelated) {
        return `消息已发送成功，本轮交流闭环已达成！禁止继续调用多余工具 ${effectiveName}，请立即输出纯文本 "OK" 完结本轮。`;
      }
    }
  });
}
