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
| 8 | 沉浸式 Action 流程规范与 KV-Cache 增益保障 | ① 唤醒词中英文散杂，流程跳转不严格；② 时钟结果若保留将持续膨胀，时钟硬写 prompt 破坏 prefix cache；③ 双 Agent 缺乏硬纪律约束 | ① 规范 5 步严谨 Action 流程（`qq_load_persona` 首调 → `get_time` 必调 → 按需查消息/记忆 → 去机械化与反定式反思 → `qq_send_message` + 纯文本 `OK`）；② `get_time` 正式纳入回合末剪枝；③ 确立 `AGENTS.md` 双 Agent 落地纪律与重启顺序 | `a930eb2` | 服务器实测：`tests/persona-ephemeral.test.js` 15/15 PASS（含 get_time 剪枝测试）；`tests/universal-prompts.test.js` 6 项 100% PASS；服务严格按序重启，活跃会话已产生 107 个剪枝占位 |
| 9 | STEP 单一轮瞬态投影架构改造：提示词与瞬态工具扩展 | ① 上下文无限累积导致 Token 滚雪球、人设稀释、定式严重；② 缺少对联网/表情包/黑话查询工具的剪枝闭环 | ① 在 `agent.cordis.yml` 确立 5 阶段黄金 Action 链路（Grounding 时空与人设 -> Perceiving 窗口/记忆/黑话/联网 -> Cognition 意图与潜台词 -> Critique 反定式自检 -> Dispatch 决策输出与瞬态销毁）；② `qq-persona-ephemeral.mjs` 扩充全部只读检索工具（含 web_search, meme_search, search_slang 等）；③ `wake-send.js` 对齐单轮瞬态投影正文 | `2974d08` | 本地与服务器端 `tests/persona-ephemeral.test.js` 15/15 PASS、`tests/universal-prompts.test.js` 6 项全 PASS；严格按序重启服务，`qq-bridge` 和 `dsh-web` 均为 active |
| 10 | 彻底清理 PTC 并赋权灵活调用 100+ 项能力 | ① PTC 缺乏 runtime 支持；② 预设需赋予模型自主决定是否联网、查黑话、搜图的自由度 | ① 清除 `agent.cordis.yml` 中 `ptc_form`、`ptc_batching` 等说教；② 加入 `flexible_on_demand_tools`，明确除步骤 1 和 2 为锚点外，其余 100+ 工具（联网、记忆、表情包、群管、戳一戳等）由模型全自主按需调度 | `1116bf3` | 服务器 `systemctl restart qq-bridge` → `dsh-web` 重启；`universal-prompts` 与 `persona-ephemeral` 均 PASS；双服务 active |
| 11 | 群聊混乱多线程人机感根治：活跃度自适应窗口与引用约束 | ① 实测取证：群友多线程斗嘴时机器人突兀插入“谁把你退了，我去看看”和“我那是回嘴不是加戏”，脱节无引用极度人机；② 写死携带数导致刷屏时前因后果被截断 | ① `wake-send.js` 增加群聊活跃度动态自适应算法（高频刷屏自动放宽至 25~35 条，并打上 `[Group Dynamic]` 提示多线程交织）；② `agent.cordis.yml` 增加 `group_thread_awareness` 与 `anti_defensive` 规则，强制跨发言距离使用 `replyToMessageId` 引用或 @ 对应人；③ `persona.md` 补全反面取证案例纠偏 | `369e6f1` | 服务器实测：测试全部 PASS，按序重启 `qq-bridge` 和 `dsh-web` 均为 active；`chat.db` 取证实证已被吸收规范 |
| 12 | `[Action Flow]` 在系统提示词和唤醒正文各写一份 | 五步流程同时存在于 `agent.cordis.yml`（→ system prompt）和 `wake-send.js` 正文尾部；正文那份每轮全价计费，且与系统提示词完全重复 | 正文删掉整张流程表，唯一出处归系统提示词（`@deepseek-ai/dsh-persona` 把 `persona.text` 注册成 system-prompt section，属静态前缀、吃 KV-Cache）；正文只留 `[HARD OPEN]` 两行触发器 + `[Context]` 瞬态说明 | `b80dd96` | 渲染 `appendTurnTailPersonaAnchor`：700 字符、`HAS_ACTION_FLOW=false`（删前 960 字符）；`tests/wake-trigger.test.js` 19/19 PASS；按序重启后三服务 active |
| 13 | GUI 每次重启后又弹「预览版说明」 | ack 存在 `ui-settings-general.welcomeNoticeVersion`，而 DSH 回写这条 ack 时正好落在桥托管的 preset 声明块内部，`syncPresetDeclaration21` 每次启动整块替换 → ack 消失 → 版本比对不过就弹窗 | 生成器新增 `readWelcomeNoticeVersion()`：从已装 DSH 的 `dsh-client-ui-settings-models/lib/client.js` 读 `WELCOME_NOTICE_VERSION`（读不到用 `2026-09-28.1` 兜底），每次重启把 ack 行写进声明块；DSH 升级自动跟版本 | `b80dd96` | 重启后 `profiles/web/cordis.patch.yml` 有 `welcomeNoticeVersion: 2026-09-28.1`；PyYAML `safe_load` 7 个顶层项、`has ui-settings-general: True`、值为字符串 |
| 14 | 服务器 GUI 工作区堆着实验目录 | `persona-agent-probe` 是零引用探针工作区；`SlangAgent` 只是显示名，路径本来就是 `state/slang-agent` | 停 `dsh-web` → 改 `storages/workspace.json`（删行 + 同步 `global.workspaceIds` + 改标题）→ 起服务；`agents` / `persona-agent` / `slang-agent` 保留（机器人自己在写） | —（数据操作，无代码提交） | `tables.workspaces` 与 `global.workspaceIds` 一致（4 条、`ids_ok: True`）；3080 在听；备份 `workspace.json.bak-wsclean-20261028-124604` |
| 15 | 本地 commit 推不上 GitHub | CLI `git push` 走本机 HTTPS，连 GitHub 超时 | 改走 GitHub MCP `push_files` 直接推文件；本地 `git fetch && git reset --hard origin/main` 对齐 | `05d2910` | 本地与远端 `git log` 同为 `05d2910`、`## main...origin/main` 无差异；`wake-send.js` 里 `[Action Flow]` 只剩一行注释 |
| 16 | 图片投递后只收到「这张图没能投递给你」占位 | ① NapCat 给的图是绝对路径（`C:\…\xx.png`），而 `resolveOneMedia` 调 `get_image` 的前置闸门 `isProbablySafeImageFileRef()` 只放行 `[\w.+=@-]+`，判定失败；② 失败就直接返回 null 走上层占位，`fetchOneBotImage` 返回 null 前一行日志都没有 → 线上无从定位 | ① 闸门放宽为「绝对路径 + `isSafeLocalMediaPath(…, cfg.napcat.homeDir)` 通过」也放行；② 返回 null 前补一行 `[media] 图片拿不到内容：file=… url=… kind=…` | `bc7adac` | 服务器 `media-pipe.js` 18986 字节、`md5sum` = `a7f02cb642406cbca0b7d16b69a2112f`（与本地一致）、`node --check` 通过、`grep -c canAskGateway`=2 / `图片拿不到内容`=1；按序重启后三服务 active，近 3 分钟日志无 `MODULE_NOT_FOUND` / `SyntaxError` |
| 17 | 上传「失败」两小时，实际把线上文件清空了 | `ssh_upload` 的写入是「先 `open` 截断、再灌流」，握手超时时截断已经发生、内容没到 → 线上 `media-pipe.js` 变成 0 字节（`md5` = `d41d8cd98f00b204e9800998ecf8427e`）；而我用 `grep -c` 判断「没传上去」，恰好和「文件是空的」同一个结果，连错两轮都没发现 | ① 判定一律看 `stat -c %s` + `md5sum`，不看内容 grep；② 改走分段 base64：本地切 6KB 段 → `printf` 落 `/tmp/mpchunks/` → `cat … | base64 -d` 拼到 `/tmp` 先校验 md5，一致才 `cp`+`mv` 原子替换上线 | `bc7adac` | 拼接产物 md5 与本地一致后才替换；替换后 `md5sum`/字节数/`node --check` 三项齐全 |
| 18 | 表情包与语音被动哑火，且回复定式为固定两条短句 | ① `wake-send.js` 哨兵轮（第 1797 行）与首轮（第 480 行）拼装 `promptText` 时把 `diceBlock` 漏掉，导致模型完全收不到 `[Meme]` 与 `[Voice]` 提示；② `voice.js` 未中骰时返回空字符串，抑制了模型随心发语音；③ 缺乏气泡分布随机性引导，模型陷入“一句主干+一句反转”的双气泡定式 | ① `wake-send.js` 补齐 `diceBlock` 与 `recallLine`，首发与哨兵轮均能稳定获得表情包/语音抽签与意图行；② `voice.js` 未中骰时返回 `[Voice Freedom]`，放开自主发送权；③ `agent.cordis.yml` 与 `persona.md` 明确 `natural_bubble_distribution`（60~70% 单气泡直出，严禁机械双发）；④ 持续强化零动作括号铁律 | `f3f11bc` | 单元测试 4 项全 PASS；实测 `diceBlock` 成功进入 prompt；按序平滑重启 |
| 19 | 语音与表情包提示词冗长，占用较多心智与 Token | 原 `[Voice]` 与 `[Meme]` 散文式长英文（每句 2~4 行）稀释上下文，违背极简精炼原则 | 全面压缩为单行高密度指令（如 `[Voice] HIT: send voice (qq_send_voice, voice=..., <60 chars)` / `[Meme] HIT: send 1 gallery meme` / `[Meme Freedom]` 单行版） | `16cf191` | 4 项单元测试 PASS；提示词字符缩减 75%+；推送到 main 并热重启部署 |
| 20 | 同回合追加的语音被 `Protocol violation: step_1` 打回 | 守卫拿「`load` 次数 > `发送` 次数」当每次发送的前置条件 —— 一次 `qq_load_persona` 只换一次发送。Gemini 新规则允许同回合 2~3 条气泡与语音，于是「`qq_send_message` + 两个 `qq_send_meme` + 一条 `qq_send_voice`」里那条语音被判成「本回合还没读人设」；模型只能多花一步重新 `load_persona` 再重发，用户侧看到一条红色报错 | 判据换成布尔「本回合是否 load 过」（`sessionPersonaTurn`），`agent/turn-stopping` 时清空；同回合后续发送一律放行，新回合仍必须 `step_1`。顺带重写 `tests/tool-restrict-guard.test.js`（旧版还按中文文案断言，早已静默失败） | 见下 | 线上 `session-34493e38` 实录：step1 `qq_load_persona` → step2 `get_time` → step3 `qq_send_message` → step4/5 `qq_send_meme`(噫娇/害羞) → step6 `qq_send_voice` 被拦 → 重新 load 后同参数重发成功。修后 `tests/tool-restrict-guard.test.js` 6 组全 PASS，`persona-ephemeral` / `persona-inject` / `universal-prompts` / `wake-trigger` / `meme-memory-immersion` 均 PASS；服务器两份拷贝 `md5=7a5bd811df4c872d3657afb48e5070d3`、`node --check` OK、三服务 active |
| 21 | 「人设放顶还是放尾」只有说法，没有可量化依据 | 线上没有任何行为指标落盘：气泡分布、动作括号、语音/表情使用率全靠人眼印象，「首尾夹心」这类架构主张无法验证 | 新增 `tools/persona-metrics.py`：只读解析 DSH 会话日志（zstd），按 `turn` 统计气泡数 / 单双三分布 / 单条字数 / 动作括号 / 语音 / 表情 / 被守卫打回次数，写 `state/persona-metrics.jsonl`；配 `persona-metrics.timer` 整点跑（oneshot、`Nice=10`、`Persistent=true`） | 见下 | **实测（近两天 330 回合）**：旧配置 n=327 → 平均 2.44 气泡、单气泡 20.5%、两气泡 52.9%、括号 0.9%、语音 0.05/回合；新配置 n=3 → 1.33 气泡、单气泡 66.7%、语音 1.33/回合。结论：**规则写在系统提示词里（当时在段尾）327 回合只有 20% 遵守**，位置不是主因；新窗口样本 3 个且同时动了 4 个变量，不能归因。timer `enabled`/`active`、`Result=success`、下次 02:00(+08)，读法 `python3 tools/persona-metrics.py --report` |

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
- 推送 GitHub：本机 `git push` 常超时，改走 GitHub MCP `push_files`（owner `AbyssalQuill` / repo `Kizuna` / branch `main`）；推完本地 `git fetch && git reset --hard origin/main` 对齐，避免两套 sha 打架。
- 服务器 `/root/qq-bridge` 不是 git 仓库，上线一直是 scp 覆盖文件；查线上版本只能比对内容。
- **上传会先截断**：`ssh_upload` / `scp` 都是「先 open 截断、再灌流」。链路是跨境长途（约 170ms、ICMP 被墙），握手随时可能超时，超时那一刻线上文件已经是 0 字节。所以：
  - 判断有没有传上去，只看 `stat -c %s` 和 `md5sum`，不要看内容 grep（空文件和旧版本对 grep 一样是 0）。
  - 传丢了、或者文件已被清空，用分段 base64 补：
```bash
# 本地：base64 -w0 file > file.b64，按 6000 字符切段；逐段 printf 上传
printf '%s' '<段内容>' > /tmp/mpchunks/c000
cat /tmp/mpchunks/c* | base64 -d > /tmp/staged.js
md5sum /tmp/staged.js   # 与本地一致才继续
cp /tmp/staged.js /root/qq-bridge/src/core/.new && mv -f .new /root/qq-bridge/src/core/<file>.js
```
  - 单条 `ssh_exec` 串行执行、失败重试 3~5 次基本都能过；并发开多条 SSH 会加剧握手超时。

---

## 5. 待办 / 未落地

1. **PTC**：查清 `dsh-web` 为什么没有把 `ctx.ptcRuntime` 组装进来；确认后再开 `tool-presentation.mode=ptc`，否则整个 preset 会被拒挂。
2. `tools/test-wake-protocol.mjs` 有 56 条陈旧断言（仍按"[Token] 首行 / 不要 [Now]"的老设计判），需要对齐现状。
3. 旧会话的人设副本（916 份）仍在日志里，仅不可达；如需回收磁盘可另行归档。
4. 服务器 `/root/qq-bridge` 不是 git 仓库（一直 scp 覆盖）：建议改成 `git pull --ff-only` 部署，"线上跑的是哪个 commit"才有锚点。
5. 下一次真实唤醒做端到端复核：确认前两个工具仍是 `qq_load_persona` → `get_time`，且回合末 `ephemeral_turn_pruned` 计数增长（现有测试只覆盖渲染层，没覆盖线上实跑）。
