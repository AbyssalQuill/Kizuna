# DSH 实现与落地日志（2026-10-28）

- **角色分工**：Gemini（Antigravity）主想法 —— 记录在 `2026-10-28-full-stack-companion-and-runtime-fix.md`；
  **DSH 负责实现、修复、端到端验证与回滚**，也就是本文件。判断一条措施"落地了没有"，只看本文件里的提交号与实测输出。
- **环境**：生产服务器 `202.61.72.79`，服务 `qq-bridge.service` / `dsh-web.service` / `napcat.service`。
- **仓库**：`Kizuna` / `main`，本地 `C:\Users\17367\Desktop\Kizuna Public` ↔ 服务器 `/root/qq-bridge`。

---

## 1. 本轮落地清单

| # | 问题 / 想法 | 根因 | 落地改动 | 提交 | 证据 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | 表情包图库"搜得到、发不出" | ① `/root/meme/whale-fanart-001` 是 9 月乱码残留包（162 行索引只剩 2 个文件），且排在候选路径第一位；② 线上 MCP 子进程还是 10-27 12:58 的旧代码（`LIMIT 1` + `hits[0]` 硬发）；③ 昨晚的多包回退修复只落在磁盘上，没重启 dsh-web | 搜索/兜底挑图按磁盘对账（幽灵行不返回）；启动日志带包目录；失败列出候选包；残留包移到 `/root/_meme-quarantine-20261028/`；重启 dsh-web | `6dab499` | 服务器实测 `qq_meme_search("开心")` 只返回真实文件；真实发图 `messageId 1232086092` 到达私聊 |
| 2 | 人设从工具记录里没剪掉（吃掉大量 token） | 旧 `turn-pruner.js` 只认 DSH 0.1.x 的 `storages/session_projcache/sessions/<id>.json`；0.2.x 会话在 `sessions/<slug>/session-<id>/session.v4.jsonl.zstd`，`resolveSessionFile()` 永远 null 且**零日志** | 新插件 `qq-persona-ephemeral.mjs`：`agent/turn-stopping` 时用 DSH 受支持的 `session.append(..., { surfaceOp: { op:'replace' } })` 把结果挤出 surface；失败留 stderr；工具 `tools/check-persona-bloat.mjs` 体检 | `0bf285b` `b9b88d7` | 体检：31 会话 916 份人设副本 / 仅 82 个占位（历史欠账）；修复后新会话 8 份进 8 份剪 |
| 3 | 每轮多一步「缺 key」再补 key | `qq_load_persona` schema 声明了 key/token，包装层对声明了 key 的工具强制补齐，补不上就拒绝 | `KEYLESS_TOOLS` 豁免集，跳过补全与三处强校验 | `785a151` | `tests/persona-keyless.test.js`：空参数调用返回人设正文、`isError=false` |
| 4 | 上下文理解"没落地" | 哨兵轮正文只有 `[Unread N]`；最近窗口只在会话首轮注入一次 | 先补 `[Recent tail]`，后按主人要求**改为不注入转录**：`ctxN=0`、删 `[Recent tail]`，细节一律走工具，回合末由 #2 剪掉 | `4aa194d` → `4a6df2b` → `f50cb80` | 唤醒正文实测只剩状态位；`qq_memory_search` 实调 `考试`→4 条、`鲸鱼`→181 条 |
| 5 | 正文时间戳 | `[Now]` 每轮变、且与 get_time 重复 | 删 `[Now]`（首轮 + 哨兵轮），`get_time` 写进每轮流程（`[HARD OPEN]` 第 2 条 + `[Action Flow]` Step 2），主动唤醒不再带 `[Clock]` 而只留 `[Proactive]` 提示 | `fde3e91` `4216a0e` | 唤醒正文无 `[Now]`；`get_time` 实调返回 `Asia/Shanghai` |
| 6 | 提示词风格 | 注入文本中英混杂、散文式 | `[HARD OPEN]/[Context]/[Meme]/[Voice]/[Burst]/[Proactive]`、守卫回执、剪枝占位、缺 key/token 提示全部改英文短规则 | `16b82ec` | 新唤醒正文全英文；`tests/persona-ephemeral.test.js` 15/15、`tool-restrict-guard` 全通过 |
| 7 | PTC（run_code）批量调用 | 需要 `ctx.ptcRuntime` | 预设已加 `tool-presentation: mode: ptc`（默认 `disabled: true`），守卫放行 `run_code` 与裸 `qq_*` 名 | `0bf285b` | **未落地**：打开后新建会话不产 `run_code` 日志（疑似缺运行时），已回滚 native |

---

## 2. 关键机制：上一轮记录到底怎么去掉的

1. **挂点**：插件订阅 `agent/turn-stopping`，拿到 `agent.session`。
2. **找目标**：遍历 `session.surface.nodes`，只看 `tool/result`；用同 surface 里的 `tool/call` 事件把 `callId → 工具名` 对上，命中 `EPHEMERAL_TOOLS`（人设、最近消息、历史检索、`get_time` 等）才处理。
3. **追加替换**：`session.append('tool/result', {...}, { surfaceOp: { op:'replace', startSeq, endSeq }, sourceEventSeqs:[seq] })`。DSH 的模型历史从 surface 派生，所以下一轮只看到占位。
4. **原事件不删**：日志仅追加、seq 连续、帧校验完整，回放可还原；这与"直接改日志文件"（旧 turn-pruner 的死路）本质不同。
5. **幂等**：按占位 marker 判断，不用长度（短结果如 `get_time` 会被长度门槛误判成"已剪过"）。

**为什么正文不能注入对话转录**：转录是 `user/message`，上面第 2 步只认 `tool/result`；注进去就永久留在历史里、每步重发。所以规则是"正文只带状态位，细节走工具，工具结果回合末剪掉"。

---

## 3. 成本数据（2026-10-28 当日）

| 会话 | token | 请求 | 均值/次 | 份额 |
| :--- | ---: | ---: | ---: | ---: |
| group:868756515 | 106,472,684 | 727 | 146,455 | 62.8% |
| private:1852240154 | 35,920,650 | 239 | 150,296 | 21.2% |
| private:1736784911（主人） | 22,153,887 | 557 | 39,774 | 13.1% |
| group:1073589775 | 3,887,899 | 68 | 57,175 | 2.3% |
| 无归属 | 980,552 | 17 | 57,680 | 0.6% |

- 合计 **169,415,672 token / 1,608 次请求**，缓存命中 97~98%。
- 工具 schema：直连 104 个工具 / 124,104 字符；经 `mcp-compressor -c max --toonify` 后模型只看到 **3 个工具 / 4,213 字符（≈1.3k token/步）**。
- 人设重复：全量 916 份副本（旧会话欠账），按 5.5k token/份估重发量 ≈6.5 亿；修复后新会话 100% 剪除。

---

## 4. 运维手册

```bash
# 改预设 / 插件 / MCP 代码后（顺序不能反）
scp <file> root@202.61.72.79:/root/qq-bridge/...
ssh root@202.61.72.79 'systemctl restart qq-bridge'   # 重装 preset 到 ~/.dsh/.agent-presets
ssh root@202.61.72.79 'systemctl restart dsh-web'     # MCP 子进程只随 dsh 重启，桥重启不会换掉它
```

- 人设剪枝体检：`node qq-bridge/tools/check-persona-bloat.mjs`（多份人设却零占位 → exit 1）。
- 回滚点：`persona.md.bak-tokenlist-20261028`（旧 token 人设）、`state/social-state.json.bak-reset-20261028-1905`（reset 前状态）、`/root/_meme-quarantine-20261028/`（乱码包）。
- 定时任务库：`state/scheduled-tasks.json`（当前 0 条）。

---

## 5. 待办 / 未落地

1. **PTC**：查清 `dsh-web` 为什么没有把 `ctx.ptcRuntime` 组装进来；确认后再开 `tool-presentation.mode=ptc`，否则整个 preset 会被拒挂。
2. `tools/test-wake-protocol.mjs` 有 56 条陈旧断言（仍按"[Token] 首行 / 不要 [Now]"的老设计判），需要对齐现状。
3. 旧会话的人设副本（916 份）仍在日志里，仅不可达；如需回收磁盘可另行归档。
