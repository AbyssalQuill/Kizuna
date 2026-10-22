// dsh-temperature —— 让 temperature 真正下发到模型请求。
//
// ── 为什么需要它 ────────────────────────────────────────────────────
// DSH 的**配置面里没有任何一个字段能承载 temperature**，把 temperature 写进
// cordis.patch.yml 的 config 只会被静默吞掉（实测：schemastery 对未知键既不报错、
// 也不丢弃，照原样透传，只是没人读它）。温度是「有管道、没水龙头」：
//
//   · 类型层有：dsh-llm 的 LlmCallConfig / GenerateOptions 都带 temperature
//     （见 dsh-llm/lib/index.js:368 的 callConfigEquals，temperature 参与比较）
//   · 适配器会发：dsh-llm-deepseek/lib/index.js:1710
//     `...options.temperature === void 0 ? {} : { temperature: options.temperature }`
//     （pi-ai 与 dsh-our-free-model 同样处理）
//   · 但**唯一的生产者**是 dsh-experimental-auto-review/lib/index.js:412 硬编码的
//     temperature: 0（它自己的评审调用），主对话链路上没有任何地方写这个字段。
//     官方 README 把这条写成了已知现状：「sampling is temperature/maxTokens/stop
//     only … the vocabulary grows when a producer lands」。
//
// ── 它挂在哪 ────────────────────────────────────────────────────────
// 挂 agent 作用域的 `agent/request` 瀑布（dsh-agent-loop/lib/index.js:1179）。
// 这个瀑布的返回值就是**请求头配置**：
//
//   agent/request 瀑布 → config → canonicalHeader → session「request/header」事件
//   →（dsh-agent-loop/lib/index.js:1269 `{...header.config, messages, …}`）
//   → llm.stream(options) → 适配器请求体里的 temperature
//
// 所以必须在这个瀑布上补，**不能**挂在 `llm/stream` 上：后者发生时请求头已经写过，
// 会撞两条自检 —— dsh-agent-loop/lib/invariant.js:28 要求
// `options.temperature === header.config.temperature`，dsh-llm/lib/index.js:2225
// 的 callConfigEquals 也会因 temperature 不一致抛 INVALID_PREPARED_CALL。
//
// 已确认的挂载前提（都读过源码，非推测）：
//   · `agent/request` 是 scoped 瀑布事件，载荷里带 agent —— 全局监听器可以收到
//     （cordis 的 hook 收集规则：`hook.global || !filter || filter(...)`，
//     见 cordis/lib/index.js:263；`global` 选项见 cordis/lib/types/events.d.ts:105）
//   · 两个已注册的监听器（dsh-agent、dsh-webhook）都用 rest 展开重写返回值，
//     不认识的键（temperature）**不会被剥掉**，所以注册顺序不影响结果
//   · session 的请求头校验只强制 provider/model，temperature 允许存在
//     （dsh-session/lib/index.js:1145-1160）
//
// ── 用法 ────────────────────────────────────────────────────────────
// 插件本身**没有 config 就是 no-op**，必须由 profile 的 cordis.patch.yml 给值：
//
//   - id: temperature-knob
//     config:
//       temperature: 0.3            # 全局默认
//       models:                     # 按模型覆盖（键是 resolved.model）
//         deepseek-flash: 0.2
//       providers:                  # 按 provider 覆盖（优先级低于 models）
//         deepseek-official: 0.3
//       withoutThinkingOnly: true   # 只在 reasoningEffort 明确为 'off' 时下发
//       log: true                   # 每个路由第一次生效时打一行 info 日志
//
// ⚠️ 关于「思考开启时能不能带 temperature」：DeepSeek 走 Anthropic Messages 协议，
//    适配器在 effort ≠ off 时会发 `thinking: {type: "enabled"}`。Anthropic 对
//    扩展思考的限制是 temperature 只能为 1 或省略——本机**没有实测过** DeepSeek
//    这个端点是否同样拒绝。若开 `withoutThinkingOnly: true` 就完全绕开这个问题
//    （代价：默认 effort=high 时插件不生效）。首次启用后跑一个普通提问即可知道：
//    报错就打开 withoutThinkingOnly，或把默认 effort 降到 off。

export const name = 'dsh-temperature';
/** 不需要任何服务：只监听事件。 */
export const inject = [];

/** 只接受有限数值；其余（undefined / NaN / 字符串）一律当作「没配置」。 */
const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/**
 * 按优先级取值：models[模型] > providers[provider] > 全局 temperature。
 * @param {object} config - 插件配置。
 * @param {object} resolved - 瀑布当前的请求头配置。
 * @returns {number|undefined} 要下发的温度。
 */
function pick(config, resolved) {
  const perModel = config.models?.[resolved.model];
  if (finite(perModel) !== undefined) return finite(perModel);
  const perProvider = config.providers?.[resolved.provider];
  if (finite(perProvider) !== undefined) return finite(perProvider);
  return finite(config.temperature);
}

/**
 * 安装插件：在 `agent/request` 瀑布上补 temperature。
 * @param {object} ctx - cordis 上下文。
 * @param {object} [config] - 见文件头的用法段。
 * @returns {() => void} 卸载函数。
 */
export function apply(ctx, config = {}) {
  const withoutThinkingOnly = config.withoutThinkingOnly === true;
  const announce = config.log !== false;
  const said = new Set();

  const onRequest = async (payload, next) => {
    const resolved = await next();
    // 别人已经明确给了值（例如 auto-review 的 temperature: 0）：不覆盖。
    if (typeof resolved.temperature === 'number') return resolved;
    // 只在明确关闭思考时下发（规避 Anthropic 协议对扩展思考的采样限制）。
    if (withoutThinkingOnly && resolved.reasoningEffort !== 'off') return resolved;
    const value = pick(config, resolved);
    if (value === undefined) return resolved;
    if (announce) {
      const route = `${resolved.provider}/${resolved.model}`;
      if (!said.has(route)) {
        said.add(route);
        ctx.logger?.info?.(`temperature: ${route} ← ${value}`);
      }
    }
    return { ...resolved, temperature: value };
  };

  const dispose = ctx.on('agent/request', onRequest, { global: true });
  return () => dispose?.();
}
