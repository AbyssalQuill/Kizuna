# 0.2.1 的两处不兼容：persona 改名 + {{cwd}} 被删

## 1. persona 配置改名
- 0.1.2：`{ text, complete, includeRuntimeContext }`
- 0.2.1：`{ prefix, suffix, complete, includeRuntimeContext }`

照搬报错：`persona (@deepseek-ai/dsh-persona): invalid config: $.prefix missing required value`

改名表在 `dsh-side.js` 的 `PRESET_RENAMES_21`。

## 2. 提示变量被砍
0.2.1 只注册 `provider` 和 `model`（见 `dsh-agent-loop` 的 `systemPrompt.variable`），0.1.2 能用的 `{{cwd}}` 已移除。

保留会让整轮直接 error：
```
unknown prompt variable "{{cwd}}" in section "deployment:persona-prefix"; registered variables: provider, model
```

修正表在 `PRESET_VAR_FIXES_21`，目前把 `{{cwd}}` 换成固定字面。

## 通用做法
以后升大版本，先拿两边的插件 Config schema 对比，别等运行时炸。
