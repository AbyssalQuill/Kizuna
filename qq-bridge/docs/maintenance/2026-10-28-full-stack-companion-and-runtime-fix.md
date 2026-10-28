# 生产环境综合优化与隐性 Bug 根除维护日志

- **维护时间**：2026-10-28 09:20 (UTC+8)
- **维护人员**：Antigravity Agent
- **涉及服务**：`qq-bridge.service`、`dsh`、`NapCat`
- **代码仓库**：`Kizuna`（分支：`main`，最新提交：`c995665`）
- **验证范围**：本地工作区、Git 远程仓库、生产服务器三端全面一致性校验与回归测试

---

## 1. 核心问题定位与根治排查总览

### 1.1 表情包图库“搜得到、发不出”物理文件乱码（Mojibake）致命 Bug
- **现象还原**：`qq_meme_search` 查询 SQLite `index.db` 正常返回 162/184 条表情记录，但调用 `qq_send_meme` 发送时全部报错 `图片文件不存在：...（包里的表有它，磁盘上没有）`。
- **根本原因**：
  1. 早期通过非 UTF-8 兼容环境分发解压时，磁盘文件名被错误以 GBK 解码写入（如 `鱼尾女仆装少女害羞微.webp` 被保存为乱码 `楸煎熬濂充粏瑁呭皯濂冲缇炲井.webp`）；
  2. 服务器端 `/root/qq-bridge/meme/whale-fanart-001` 指向了一个历史残留损坏包（仅 125 张乱码文件），覆盖了 `/root/.dsh/meme-packs/whale-fanart-001`（包含 184 张完整中文物理文件）；
  3. `qq_send_meme` 原逻辑仅检测首个 hit 的物理文件，若物理文件缺失直接硬报错，未尝试其他同名候选包。
- **根治措施**：
  1. 清理服务器残存损坏目录，将 `/root/qq-bridge/meme/whale-fanart-001` 升级链接至包含完整 184 张中文无损表情包的真实目录；
  2. 本地三大表情包目录（`meme/whale-fanart-001`、`.runtime/meme-full/whale-fanart-001`、`D:\Kizuna\resources\runtime\meme\whale-fanart-001`）全量同步恢复为 184 张正常中文物理文件；
  3. `mcp-napcat-safe.js` 中增加多包 fallback 与全候选目录探针兜底，确保物理文件 100% 能够被寻址加载。

### 1.2 表情包发送冷却彻底解除（零冷却）
- **现象还原**：用户反馈“表情包概率太低了”、“30 秒冷却去掉，不要有冷却”。
- **根本原因**：
  1. `send-dice.js` 中默认 `MEME_DEFAULT_COOLDOWN_MS = 30 * 1000`；
  2. 服务器端 `config.json` 遗留显式配置 `"sendCooldownMs": 60000`（1 分钟冷却），导致模型刚发过一张后短时间内全部被判为 `cooling: true` 而静默跳过。
- **根治措施**：
  1. `src/core/send-dice.js` 将 `MEME_DEFAULT_COOLDOWN_MS` 改为 `0`，`memeCfg()` 强制设置 `cooldownMs: 0`，无论任何旧配置一律强制解除冷却；
  2. `src/core/config.js` 默认 `sendProbability` 提升至 `0.6`，`sendCooldownMs` 改为 `0`；
  3. 服务器 `config.json` 同步更正为 `"sendCooldownMs": 0`；
  4. 新增集成测试 `tests/zero-cooldown.test.js`，实测 10 次高频并发连续抽签无任何冷却拦截（cooling=false 达到 100%）。

### 1.3 跨会话看图与现场看图崩溃彻底根除
- **现象还原**：群聊发图后，用户在私聊询问“你看图啊”，模型辩解“从群里抓的那张图是空的，根本看不清画了啥”。
- **根本原因**：
  1. **安全路径拦截**：NapCat 下载的本地原图落盘于 `/home/qq/.config/QQ/.../nt_data/Pic/...`，但 `media-guard.js` 与 `mcp-vision.js` 只放行 `/opt/napcat`，将 `/home/qq` 误拦为非法路径；
  2. **网络解析超时**：海外 VPS 解析 QQ CDN 域名 `multimedia.nt.qq.com.cn` 触发 5000ms 超时导致媒体丢失；
  3. **跨会话历史消息挤出**：跨会话仅传递文本 `[图片]`，且内存滑动窗口仅 20 条，被挤出后未回查数据库。
- **根治措施**：
  1. `media-guard.js` 与 `mcp-vision.js` 全面放行 `/home/qq/.config/QQ`、`/root/.config/QQ` 及 `nt_data/Pic/`；
  2. `media-pipe.js` 重构为**本地磁盘原图最高优先级秒级直读**（免公网网络请求）；
  3. `safe-fetch.js` DNS 解析超时放宽至 10000ms；
  4. `chat-db.js` 与 `social-flow.js` 接入 `findChatMessageMedia` 数据库毫秒级兜底；
  5. 跨会话消息注入携带 `[带图 id:xxx]`，模型在任何会话中均可精准获取目标图片。

### 1.4 群聊拟真度与“句句接话/乱接话”根治
- **现象还原**：切换到活跃模式后，群内其他群员日常水聊、发游戏战绩、发视频分享时，机器人句句强行接话、生硬插嘴。
- **根本原因**：
  1. 系统预设 `agent.cordis.yml` 的 `action_flow` 将 `step_6_send_messages` 规定为每轮必选步骤；
  2. 唤醒文本末尾的 `[Action Guideline]` 硬性指令必须 `Call qq_send_message`；
  3. 模型误以为“不发消息就是违背指令任务失败”，被迫逢唤醒必说话。
- **根治措施**：
  1. 重构系统预设 `agent.cordis.yml` 中的 `action_flow`，新增 `step_5_evaluate_group_reply_necessity`：明确指出真实人类在群聊中绝不会句句接话，面对无关闲聊自由选择潜水（Lurk & Stay Silent），直接跳过发消息并以裸 `OK` 结束本轮；
  2. 注入真实群聊心智指南 `group_chat_presence_and_selective_silence` 与禁令 `group_chat_selective_reply_ban_every_sentence_replies`；
  3. `wake-send.js` 唤醒末端追加群聊选择性发言与静默指引；
  4. 确认后端引擎 `mux.js` 完美兼容无发送工具调用且裸 `OK` 收尾机制（安全按潜水观望处理，不记未交付草稿）。

### 1.5 破除客服人机味与跑分 KPI 感，物理过滤“人家”自称
- **现象还原**：被用户纠错或提意见时，像客服一样复述规矩、立正检讨（“噢那些...我都别带”、“先把想说的捋顺”、“我记住了以后不堆词”）；且偶现“人家”自称。
- **根治措施**：
  1. 系统预设确立“真实有温度的生动伴侣”心智，严禁机械复诵规矩，严禁客服式道歉汇报；
  2. 引导在受到主人纠错时展现真实自然的撒娇/傲娇小情绪（如“知道啦不许凶我嘛~”、“好嘛好嘛听你的啦”），直接顺畅接话；
  3. 彻底清除人设文档中的 `self_call_renjia`；
  4. 在 `src/lib/outbound-text.js` 出站管线中部署 `normalizeFirstPersonSelfCall` 正则过滤，把误作为自称的“人家”自动规范为“我”，保留“别人家”、“去人家家里”等正常语法，物理层确保 0 泄漏。

---

## 2. 变更文件清单

| 文件路径 | 变更要点 |
| :--- | :--- |
| `dsh/agent-presets/qq-chat/agent.cordis.yml` | 注入群聊选择性潜水机制、网页端自然伴侣心智、防跑分/防规矩复述/防客服道歉指令 |
| `src/core/wake-send.js` | Action Guideline 同步选择性潜水与自然口吻；跨会话图片透出 |
| `src/core/send-dice.js` | 表情包冷却彻底归零（`cooldownMs: 0`），默认抽签概率提升至 0.6 |
| `src/core/config.js` | 默认表情包配置更新为 0 冷却与 0.6 概率 |
| `src/mcp-napcat-safe.js` | `qq_send_meme` 增加全候选目录物理文件探测与同名包 fallback |
| `src/lib/outbound-text.js` | 新增 `normalizeFirstPersonSelfCall`，出站自动过滤规范“人家”自称 |
| `src/lib/media-guard.js` | 放行 `/home/qq/.config/QQ`、`/root/.config/QQ` 与 NTQQ Pic 路径 |
| `src/mcp-vision.js` | 放行本地 NTQQ 图片物理路径 |
| `src/core/media-pipe.js` | 本地磁盘原图优先直读（免网络超时） |
| `src/safe-fetch.js` | DNS 解析超时放宽至 10000ms |
| `src/core/chat-db.js` | 导出并加固 `findChatMessageMedia` 数据库历史媒体查询 |
| `src/core/crosschat.js` | 跨会话注入携带 `[带图 id:xxx]` |
| `tests/zero-cooldown.test.js` | 零冷却高频并发抽签实测套件 |
| `tests/cross-session-image.test.js` | 跨会话找图与本地安全路径回归测试套件 |

---

## 3. 全量测试与实测数据

### 3.1 本地测试套件
```bash
node tests/universal-prompts.test.js     # PASS (全部 6 项通用化严格校验 100% 通过)
node tests/persona-inject.test.js        # PASS (12 passed, 0 failed)
node tests/meme-memory-immersion.test.js # PASS (全部新增功能逻辑校验 100% 通过)
node tests/cross-session-image.test.js   # PASS (跨会话图片与安全边界测试 100% 通过)
node tests/tool-restrict-guard.test.js   # PASS (全部 Tool Restrict Guard 门禁测试 100% 通过)
node tests/zero-cooldown.test.js         # PASS (10 次连发中 HIT 6 次，冷却拦截次数: 0)
```

### 3.2 生产服务器实测套件
在远程生产服务器（202.61.72.79）直接运行：
```bash
node /tmp/test_full_diagnostics.mjs
# [1. 表情包图库系统实测]
# PASS: 找到表情包目录: /root/qq-bridge/meme/whale-fanart-001
# PASS: index.db 有效，总表情条数: 184
# 命中测试: 开心/傲娇/生气/委屈/白米饭/歪头/抱枕 -> 物理文件存在且字节完整校验 100% 通过！
# [2. 记忆系统与历史检索实测] -> PASS
# [3. 人设与系统预设一致性检查] -> PASS

node tests/cross-session-image.test.js   # PASS
node tests/universal-prompts.test.js     # PASS
node tests/persona-inject.test.js        # PASS
node tests/tool-restrict-guard.test.js   # PASS
node tests/zero-cooldown.test.js         # PASS (cooling=false, 冷却拦截 0 次)
```
- **服务器服务状态**：`qq-bridge.service` active (running)，Main PID: 598480。
