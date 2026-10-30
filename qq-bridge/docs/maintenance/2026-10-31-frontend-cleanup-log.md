# 管理端前端精简与字体统一日志（2026-10-31）

- **仓库**：`Kizuna` / `main`，提交 `6f0e615`（前端）；前序 `00f99e0`（README 中英双语、提示词）。
- **主题**：保持 `nc_pink` 柔粉主题不变，只做布局与文案清理。

## 1. 落地清单

| # | 问题 | 改动 | 文件 |
| :-- | :-- | :-- | :-- |
| 1 | 部分界面未用 AaCute | `body/input/button/select/textarea` 强制 `AaCute, AaCute-full`；`.cute-ui` 内 label/span/em/div 同样覆盖 | `src/styles/global.css` `src/styles/app.css` |
| 2 | 上下文轮换卡已无意义 | 删除「③ 聊多少轮自动换新会话」（`wakeThreshold`/`prewarmAhead`），卡片改名「上下文与记忆窗口」并重写说明 | `BridgeConfig.tsx` |
| 3 | 工具历史剪枝卡已废弃 | 整张移除「上下文治理」（`dshCompaction`），当前由 `qq-persona-ephemeral.mjs` 每回合末单轮折叠 | `BridgeConfig.tsx` |
| 4 | `[Style]` 语感行已内置 | 整张移除「提示词与语感」卡（`prompt.styleLine`） | `BridgeConfig.tsx` |
| 5 | 允许连发开关 | 界面隐藏 `burstEnabled`，发送节奏卡说明注明连发恒开 | `BridgeConfig.tsx` |
| 6 | Pixiv/洛谷两张卡占位过高 | 并排双列 `.dual-card-row`，Pixiv 去掉镜像站地址与自动管理项说明，文案精简 | `BridgeConfig.tsx` `app.css` |
| 7 | 表情包上传重复 | 「表情包」卡去掉上传按钮，图库统一在「表情包库」卡导入 | `BridgeConfig.tsx` |
| 8 | 语音页黑字 | `.field-row em`、`.lrn-inline-note` 改主题灰；`b/strong/code` 改粉调 | `app.css` |
| 9 | 群友画像输入框宽度不一 | 群聊下拉与昵称/QQ 输入框统一 220px | `GroupPortrait.tsx` |
| 10 | 学习页剪枝旧文案 | 改写为「单轮折叠与上下文节省（实测）」与记忆库归档说明 | `Learning.tsx` |

## 1b. 追加：连发与唤醒行为提示死代码清除（提交 `89aa9d4` + 本次清理）

| # | 问题 | 改动 | 文件 |
| :-- | :-- | :-- | :-- |
| 11 | 「唤醒行为提示」（`social.send.recommendedHint`）已被内置规则取代 | 界面隐藏该字段；默认值、配置合并、示例配置全部删除。`social.wake.recommendedHint` 仍由 `qq_get_prompt` 下发，予以保留 | `BridgeConfig.tsx` `config.js` `console-server.js` `config.example.json` |
| 12 | `burstEnabled` 拦截与开关 | 删除 `/api/social/send-message` 里 `burstEnabled === false` 的 403 分支；`planSocialTimeline` 去掉「关闭分条」分支；删除默认值、配置合并、示例配置、界面标签与帮助、测试夹具参数 | `console-server.js` `social-timeline.js` `config.js` `config.example.json` `BridgeConfig.tsx` `group-interject-model-decides.test.js` |

- **部署**：生产服务器 `202.61.72.79` 只同步 `console-server.js`、`social-timeline.js`、`config.js`，按先 `qq-bridge` 后 `dsh-web` 的顺序重启。
- **旧配置兼容**：已有 `config.json` 里残留的 `burstEnabled`、`send.recommendedHint` 不再被读取，也不会渲染到界面（`BridgeConfig.tsx` 发送节奏卡的 `filter` 仍排除这两个键，避免旧配置里的它们显示成裸键名输入框）。
- **验证**：`group-interject-model-decides` 38/38、`persona-ephemeral` 28/28、`npm run build` 通过。
- **部署后观察**：重启后旧会话 `session-888962dc…` 的 follow 流进入长退避重连，属重启后的会话重连现象，需再看一次是否收敛。

## 2. 已核实事项

- **「清除已保存的密钥」**：调用 `clearApiKey()`，向后端发 `dsh.clearApiKey`，删除隔离 DSH `.credentials.yaml` 中该服务商密钥一行，其余内容保留；功能有效。
- **NapCat WebUI（6099）字体**：由 NapCat 自带前端提供，管理端样式无法注入，不在本次范围。

## 3. 验证

- `npm run build`（`tsc -b && vite build`）通过。
- `qq-bridge/tests/persona-ephemeral.test.js`：28/28 PASS。

## 4. 遗留

- 前端构建产物在管理端本机，重启管理端并强刷页面后生效；服务器侧无需前端部署。
