// QQ 桥接安全硬边界与调用流守卫：
// 1) 隐藏全局开发工具（restrict）；
// 2) 白名单兜底（guard）；
// 3) 防呆拦截：严禁将会话 Token / QQ 号作为工具名盲调；
// 4) 强制 step_1：每回合第一次发言前必须先调用 qq_load_persona 载入角色设定，否则物理拦截打回；
//    注意「每回合一次」不等于「每次发言一次」——同一回合里的第二条文字 / 语音 / 表情
//    不该被要求重新读人设（2026-10-29 线上实测：一言一语连发语音时被误判成 protocol violation，
//    模型被迫多花一步重新 load_persona 才发出去）；
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
  // 2026-10-28：PTC 呈现下模型唯一可见的入口就是 run_code；它本身不碰 QQ，
  // 真正的动作在程序里逐个工具调用，仍然逐次过本守卫（见 ③ 白名单与 ⑤ 人设门禁）。
  'run_code',
]);

/* PTC 里嵌套调用的工具名可能是不带服务前缀的裸名（qq_send_message / napcat_invoke_tool）。
   这里明确放行 qq_* / napcat_* 裸名，其余一律拒 —— 危险工具（shell/fs/dev_*）仍然进不来。 */
const SAFE_BARE_NAME = /^(?:qq_[a-z0-9_]+|napcat_[a-z0-9_]+)$/i;

// 会话人设加载与发言状态记录（基于 sessionId）
export const sessionLoadedPersona = new Map();
export const sessionSentMessage = new Map();
export const sessionLoadedCount = new Map();
export const sessionSentCount = new Map();
// 本回合是否已经载入过人设：true 之后同回合的任意多次发送都放行，回合结束（turn-stopping）清空
export const sessionPersonaTurn = new Map();

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

  // 3) 回合结束清空「本回合已载入人设」标记：下个回合的第一次发言必须重新 load。
  //    dsh-qq-hold 会把 turn-stopping 按住不放，真回合结束时本钩子才真正执行；
  //    万一没触发，最坏结果是沿用上一回合的载入状态（仅放宽门禁，不会误伤正常发言）。
  if (typeof ctx.on === 'function') {
    ctx.on('agent/turn-stopping', (payload) => {
      const id = String(payload?.agent?.session?.id || '');
      if (id) sessionPersonaTurn.delete(id);
      else sessionPersonaTurn.clear();
    });
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
      return `"${name}" is a session auth token, not a tool name. Pass it in the token field of a tool call, never as the tool itself.`;
    }
    if (innerName && /^\d{5,12}$/.test(innerName)) {
      return `"${innerName}" is a session auth token, not a tool name. Pass it in the token field of a tool call, never as the tool itself.`;
    }

    // ② 后台学习任务工具豁免（离线分析与画像抽取无须遵循群聊会话流程）
    if (/qq_learning_/.test(effectiveName) || /qq_learning_/.test(name)) {
      return;
    }

    // ③ 白名单检查
    if (!SAFE_EXACT.has(name) && !SAFE_PREFIXES.some((prefix) => name.startsWith(prefix)) && !SAFE_BARE_NAME.test(name)) {
      return `Tool "${name}" is not on the QQ bridge whitelist and was rejected (only QQ MCP tools and harmless model-side tools are allowed).`;
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
      sessionPersonaTurn.set(sessId, true);
      return; // 允许加载人设
    }

    // ⑤ 物理硬门禁：本回合还没载入人设就不许发言。
    //    判据是「本回合是否 load 过」（布尔），不是「load 次数 > 发送次数」——
    //    后者会把同回合的第二条消息 / 语音当成新一轮，线上就是在这里把 qq_send_voice 打回的。
    if (isSendTool) {
      if (!sessionPersonaTurn.get(sessId)) {
        return 'Protocol violation: step_1 is mandatory at the top of every turn. qq_load_persona has not been called yet in this turn, so sending is blocked. Call qq_load_persona now, then retry the send. Later sends in the same turn do not need another load.';
      }
      sessionSentCount.set(sessId, (sessionSentCount.get(sessId) || 0) + 1);
      sessionSentMessage.set(sessId, Date.now());
      return;
    }

    // ⑥ 发言后防狂乱收敛：本轮已经调用过发言后，严禁继续盲调空间、定时、无目的搜图等无关工具
    const sentAt = sessionSentMessage.get(sessId) || 0;
    if (sentAt && (Date.now() - sentAt < 30 * 1000)) {
      const isPostChatUnrelated = /^(qq_qzone_|qq_publish_qzone|qq_schedule_|qq_image_search)/.test(effectiveName);
      if (isPostChatUnrelated) {
        return `The message was sent - this turn's goal is met. Do not call more tools (${effectiveName}); reply literal "OK" to close the turn.`;
      }
    }
  });
}
