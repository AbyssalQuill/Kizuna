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

## 2. 已核实事项

- **「清除已保存的密钥」**：调用 `clearApiKey()`，向后端发 `dsh.clearApiKey`，删除隔离 DSH `.credentials.yaml` 中该服务商密钥一行，其余内容保留；功能有效。
- **NapCat WebUI（6099）字体**：由 NapCat 自带前端提供，管理端样式无法注入，不在本次范围。

## 3. 验证

- `npm run build`（`tsc -b && vite build`）通过。
- `qq-bridge/tests/persona-ephemeral.test.js`：28/28 PASS。

## 4. 遗留

- 桥端 `console-server.js` 的 `burstEnabled === false` 拦截仍在代码里，配置默认 `true`；若要彻底去除需另提交，并同步 `social-timeline.js`。
- 本次提交把 `src/` 下文件行尾统一为 LF，diff 行数偏大属正常。
- 前端构建产物尚未同步到生产服务器 `202.61.72.79`，需构建后部署。
