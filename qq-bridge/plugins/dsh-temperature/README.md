# dsh-temperature

让 `temperature` 真正下发到模型请求。**插件已写好并自测通过，但还没有装进任何 profile —— 装上需要重启 DSH，等你点头。**

## 一、为什么改配置做不到

DSH 的配置面里**没有任何字段能承载 temperature**。把它写进 `cordis.patch.yml` 的 `config` 会被静默吞掉：我用 schemastery 实测过，`z.object` 对未知键既不报错也不丢弃，照原样透传 —— 所以「写进去了、不生效、也不报错」正是会发生的现象。

证据链（都读过源码，不是推测）：

| 位置 | 事实 |
|---|---|
| `dsh-llm/lib/types/call-config.d.ts:20` | `LlmCallConfig.temperature?: number` 存在 |
| `dsh-llm-deepseek/lib/index.js:1710` | 适配器会发：`…options.temperature === void 0 ? {} : { temperature: options.temperature }` |
| `dsh-llm/lib/index.js:368` | `callConfigEquals` 把 temperature 纳入相等比较 |
| `dsh-experimental-auto-review/lib/index.js:412` | **唯一的生产者**，硬编码 `temperature: 0`（它自己的评审调用） |
| `dsh-llm-deepseek/lib/index.js:297-334` | provider 配置模式（catalogModel / deepSeekConfigFields）**没有** temperature |
| `dsh-agent-default-model/lib/index.js:21-25` | 默认模型选择只有 provider / model / reasoningEffort |
| `dsh-llm/README.md`（Known Limitations） | 官方原话：*sampling is `temperature`/`maxTokens`/`stop` only … the vocabulary grows when a producer lands* |

实测旁证 —— 本机一个真实会话的请求头（`~/.dsh/sessions/…/session.v4.jsonl.zstd`）：

```
config = {"provider":"deepseek-official","model":"deepseek-flash","reasoningEffort":"high","maxTokens":256000}
```

没有 temperature 字段。**管道有，水龙头没有。**

## 二、插件怎么工作

挂在 agent 作用域的 `agent/request` 瀑布上（`dsh-agent-loop/lib/index.js:1179`）。这个瀑布的返回值就是请求头配置，链路是：

```
agent/request 瀑布 → config → canonicalHeader → session「request/header」事件
  →（dsh-agent-loop/lib/index.js:1269 `{...header.config, messages, …}`）
  → llm.stream(options) → 请求体里的 temperature
```

不能改挂 `llm/stream`：那时请求头已经写过，会撞两条自检 —— `dsh-agent-loop/lib/invariant.js:28` 要求 `options.temperature === header.config.temperature`，`dsh-llm/lib/index.js:2225` 的 `callConfigEquals` 也会因不一致抛 `INVALID_PREPARED_CALL`。

挂得住的前提（均已核对）：

- `agent/request` 是 scoped 事件（载荷带 `agent`，见 `dsh-scope/lib/invariant.js:18`），全局监听器收得到 —— cordis 的规则是 `hook.global || !filter || filter(...)`（`cordis/lib/index.js:263`），`global` 选项见 `cordis/lib/types/events.d.ts:105`
- 已注册的两个监听器（`dsh-agent`、`dsh-webhook`）都用 rest 展开重写返回值，**不认识的键不会被剥掉**，所以注册顺序不影响结果
- session 的请求头校验只强制 provider/model，temperature 允许存在（`dsh-session/lib/index.js:1145-1160`）
- 插件不覆盖别人已经给的 temperature（auto-review 的 `0` 保住）

## 三、启用（4 步，缺一不可）

```bash
# 1. 把插件挂进 web profile 的依赖
#    在 ~/.dsh/profiles/web/package.json 的 dependencies 加：
#      "dsh-temperature": "link:C:/Users/17367/.dsh/plugins/dsh-temperature"
#    并在 dsh.profile.bundles 数组里加 "dsh-temperature"
# 2. 装链接
cd ~/.dsh/profiles/web && pnpm install
```

```yaml
# 3. 在 ~/.dsh/profiles/web/cordis.patch.yml 里给值（同 id 合并）
- id: temperature-knob
  config:
    temperature: 0.3            # 全局默认
    # models:                   # 按模型覆盖，优先级最高
    #   deepseek-flash: 0.2
    # providers:                # 按 provider 覆盖
    #   deepseek-official: 0.3
    # withoutThinkingOnly: true # 只在 effort 明确为 off 时下发（见下）
```

4. **重启 DSH**（profile 的 `patchReload: startup`，补丁只在启动时读）。

不写 `config` 时插件全程 no-op；临时停用只需删掉第 3 步那段（或从 `bundles` 里摘掉），不用删文件。

## 四、验证

- 插件日志：每个路由第一次生效时打一行 `temperature: deepseek-official/deepseek-flash ← 0.3`（`log: false` 可关）。
- 耐久证据（请求头事件）：跑一轮对话后读本会话的日志 —— 这就是「参数确实进了请求头」的落库证据。

  ```bash
  node ~/.dsh/plugins/dsh-temperature/test/read-header.mjs \
    ~/.dsh/sessions/<工作区>/<session>/session.v4.jsonl.zstd
  ```

  注意日志是**多 zstd 帧拼接**的，`zstdDecompressSync`/`createZstdDecompress` 都只解第一帧（只得到一条 session 元数据）；`read-header.mjs` 按帧魔数 `28 B5 2F FD` 切开逐帧解。实测未启用本插件时该命令输出：
  `config={"provider":"deepseek-official","model":"deepseek-flash","reasoningEffort":"high","maxTokens":256000}`。

## 五、风险（未实测，必须知道）

1. **思考开启时能不能带 temperature 没实测过。** DeepSeek 走 Anthropic Messages 协议，effort ≠ off 时请求带 `thinking: {type:"enabled"}`，而 Anthropic 对扩展思考的限制是 temperature 只能为 1 或省略。本机默认 `reasoningEffort: high`，所以第一次启用后跑一个普通提问就知道：若报 INVALID_REQUEST 之类的错，把 `withoutThinkingOnly` 设成 `true`（代价：此时插件不生效），或把默认 effort 降到 `off`。
2. **重启会中断当前会话**（GUI 会重连，但正在跑的对话会断）。
3. 任何生效都意味着请求体多一个字段 → **KV 缓存前缀**多一次变化，第一次请求会重算前缀。

## 六、自测

```
node test/logic.test.mjs    # 9/9：no-op、优先级、不覆盖、withoutThinkingOnly、非法值、不可变性
node --check lib/index.js   # 语法
```
`cordis.patch.yml` 与 `package.json` 已用 js-yaml / JSON 解析验证通过。
