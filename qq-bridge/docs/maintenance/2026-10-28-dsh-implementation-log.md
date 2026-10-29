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
| 22 | 私聊实况语音与文字意思高度重复，机械报时催睡严重 | ① 实测取证（01:30~01:45）：文字报时催睡一次，语音换个句式又复读一遍；② 句句带“一点四十了/一点四十五了”像打卡时钟；③ 正则过度匹配“贴贴”强塞 `[Meme Directive]` 导致每轮把文字+表情包+语音全发一遍的大杂烩全家桶 | ① `voice.js` 明确语音首选纯语音独发（`VOICE ALONE`），文字+语音时严禁同义复述与重复催睡；② `wake-send.js` 增加代码掷骰 `[Bubbles]`（68% 单气泡，24% 双气泡，8% 三气泡），收窄表情包强制指令；③ `persona.md` 严打报时钟与客服保姆式“在呢”起手；④ `outbound-text.js` 扩展动作描写物理剥除 | `3f7a0d9` | 取证数据库对账；单元测试全部 PASS；推送到 GitHub main 并部署热重启 |

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

---

## 6. 条目 23（2026-10-29）：表情包防重打散、第一步并发感知流与黑话/联网主动性落地

### 背景与根因
1. **端白饭连发顽疾**：现场私聊实测中，模型无论聊何种话题，频繁且连续发送 `蓝发女仆鲸鱼娘端白饭.webp`。排查发现 `mcp-napcat-safe.js` 的 `pickExistingMemeRow` 函数始终取 SQLite 检索结果的第 1 行；而第 1 行恰好是端白饭，且系统无任何会话级发图防重和随机打散，导致一有通用情绪请求就必定发出同一张图。
2. **缺乏并发调用与黑话/联网感**：
   - 过去 `agent.cordis.yml` 和 `[HARD OPEN]` 把调用流程固化为严格串行的 `step_1` 到 `step_5`（声明先调人设，人设之后再调时间，之后再调感知），导致模型不敢在首步并发发起工具，每轮产生多达 7 步串行工具调用，延迟极大人机感重。
   - `qq-tool-restrict.mjs` 守卫实际只针对 `qq_send_message` / `qq_send_voice` 作发言前必须 load 人设的检查；只读工具（`get_time`, `search_slang`, `web_search`, `qq_memory_search`）在第一步原生支持并行批量调用。
3. **系统提示词 vs 唤醒正文放置策略**：
   - 系统提示词享受 98% KV-Cache 命中（单价 0.02元/M，未命中 1.00元/M，差价50倍）。因此大段规则、黑话与联网主动性、表情包挑选准则必须沉淀在系统提示词静态前缀中；
   - 唤醒正文仅保留 1 行极简触发器锚点（约 30 Token）；
   - 表情包防重由后端代码物理实现随机抽取与排除，实现零 Token 绝对防御。

### 修改明细
1. **`src/mcp-napcat-safe.js`**：
   - 引入会话级近期发送表情队列 `recentSentMemesMap`（记录当前会话最近发送的 15 张表情文件名）。
   - 重构 `pickExistingMemeRow`：增加 `excludeFiles` 过滤逻辑，优先排除最近刚发过的图片；从满足条件的有效文件池中通过 `Math.random()` 随机抽取，彻底杜绝首行固定。
   - 完善 `qq_send_meme`：挑图时传入会话排除列表；发图成功后同步登记入防重队列。
2. **`dsh/agent-presets/qq-chat/agent.cordis.yml`**：
   - 重构 Action Flow 为两阶段并发流：
     - `phase_1_parallel_perception`：在第一步（Step 1）以单 batch 并发调用 `qq_load_persona` + `get_time`，并主动并发检索网络黑话（`search_slang`，如 666/神了/抽象/唐/典）及实时资讯（`web_search`）；
     - `phase_2_context_critique_and_dispatch`：结合完备感知进行自然思考，执行单/双气泡回复、拟人语音及结合语境的精准表情包，禁止连发同种表情。
3. **`src/core/wake-send.js`**：
   - 精简 `[HARD OPEN]` 为极简并发引导：`Step 1 (Parallel Perception): Call qq_load_persona + get_time (+ search_slang/web_search/qq_memory_search concurrently if slang/facts needed) in ONE parallel batch; Step 2 (Critique & Dispatch): Send context-matching voice/message/meme, then reply OK.`
4. **`tests/meme-memory-immersion.test.js`**：
   - 追加测试验证表情包排除列表与随机候选池逻辑，断言端白饭在排除后被成功避开。全部测试 100% PASS。
5. **表情包全量返回与模型自主决策（用户指示追加）**：
   - 用户明确指示：“这段可以返回全量图片然后由模型自己决定选什么”。
   - 彻底打破后端盲盒抽取：将 `qq_meme_search` 的搜索容量从 8~20 张扩容至全量（上限 100 张），并附带画面细节描述（caption）与 `[⚠️本会话最近已发过]` 标识；
   - 在系统预设与正文中确立规范：Phase 1 并发调用 `qq_meme_search` 获取全量候选，Phase 2 结合真实视觉细节由模型自主挑选最贴合语境的表情并传参 `qq_send_meme(file)` 精准发送；同时兼容旧有 fallback 源码回归测试。

---

## 7. 条目 24（2026-10-29）：基于知乎/CSDN/GitHub 提示词权重与注意力机制的深度拟人化重构

### 背景与现场实况分析
1. **真实问题定位（2026-10-29 上午现场取证）**：
   - 用户问“那你觉得怎么才能改变这个现状呢，怎么去设置提示词”，机器人竟回答“别给我一堆规矩了，你干脆直接跟我说这会儿别说话，我闭嘴”、“我这套话确实背熟了，一开口就滑进去”；
   - 用户发“何意味”（网络流行抽象梗，意为“这是什么鬼/胡言乱语什么”），机器人竟然字面拆解回复“意思就是剩下那半你念我也不想听”；
   - 用户吐槽“你怎么这么笨”，机器人自暴自弃怨妇式回复“我本来就笨嘛”。
2. **理论分析（知乎/CSDN/SillyTavern 前沿研究）**：
   - **否定陷阱（白熊效应 / Ironic Process Theory）**：原 `persona.md` 中大量写满“你不要说X”、“严禁承认自己是人机”、“严禁说改哪儿你说”，导致大模型在注意力机制中高权重捕捉到这些违禁词，被用户一激就顺理成章背出原话。
   - **少样本学习（Few-Shot In-Context Learning）缺失**：缺乏正向规范范例，模型遇到提问只能靠通用预训练语料补全，极易退化成客服或杠精。
   - **近因效应（Recency Bias）末尾权重**：光标前最后一句若只讲工具时序，生成文字时将完全丢失人设神韵。

### 修改明细
1. **`persona.md` 结构化净化与正向 Few-Shot 锚定**：
   - 彻底清除所有带有“你不要说……”的负面字面量。
   - 建立全新的 `<dialogue_examples>` 少样本对话流：针对“询问提示词/技术元话题（俏皮装傻不破壁）”、“网络黑话拆招（何意味/666/唐）”、“主人宠溺与嫌笨（傲娇娇嗔依赖）”提供具象化的问答范例，通过 Next-Token 概率天然锁定语调。
2. **`src/core/wake-send.js` 注入高权重尾部近因锚点**：
   - 在正文最末端追加 `[Tone Anchor]`：`Pure human immersion: 1 short spoken bubble (1~10 words). Zero AI essay, zero apologies or defensive explanations, never take slang (like 何意味/666/唐) literally, and never debate AI prompts/rules (play dumb/banter instead).`
3. **`dsh/agent-presets/qq-chat/agent.cordis.yml`**：
   - 在 Phase 2 批评与派发流程中，明确声明禁止辩解式道歉、严禁字面拆解黑话、坚决维护第四面墙。

---

## 8. 条目 25（2026-10-29）：系统提示词极致瘦身与正向沉浸驱动重构

### 背景与用户指示
- 用户明确指示：“很明显不对，应该是最初的极简人设就好，然后就是去掉所有规则，改为正向引导沉浸式角色扮演和一些工具上的那种要点，而不用规则规定人设。是最简的系统提示词”。
- 过去系统提示词堆积了大量审查条文（ban_xxx、critique_xxx），导致模型像戴着脚镣演戏，内心时刻在做规则审查，出现极度僵硬、怨妇辩解的人机味。

### 改造明细
1. **`dsh/agent-presets/qq-chat/agent.cordis.yml` 彻底去规则化与最简化**：
   - 彻底删除 rules 列表下的十多项 ban_xxx 负面禁令及 step_4 内部的自我审查机制。
   - 建立正向沉浸引导（`positive_immersion`）：引导模型全情沉浸在角色卡赋予的灵魂中，忘掉一切 AI/技术概念，展现真情实感。
   - 精炼工具执行要点（`tool_essentials`）：清晰交代 Phase 1 首步感知并发、Phase 2 自由表达与回复 OK 结轮。
2. **`src/core/wake-send.js` 净化为正向沉浸与行动要点**：
   - 移除负面禁令，保留极简的 `[Actions]` 与 `[Immersion]` 引导。全部测试 100% PASS。

---

## 9. 条目 26（2026-10-29）：Action 流程优化与表情包 English-query 容错重构

### 现场事故取证分析
1. **多发 meme 且失败原因**：用户截图显示模型在私聊中调用了 `qq_send_meme({ query: "emotion" })`，因原工具描述含有 `emotion/content description`，导致模型照搬了英文单词 `emotion`。库里无英文匹配，报错返回 `按「emotion」没搜到匹配的表情`，诱发模型在同回合多发一次 meme。
2. **发错消息与语境脱节原因**：Action 流程此前未明确“文字为主、表情为辅”，模型在收到“马上吃泡面”时单发了一张毫无上下文关联的“生气握拳愤怒”表情，且无任何文字；下回合面对主人的问号又自嘲“发错了发错了，表情包自己跳出去的”，造成严重人机发错灾难。

### 改造明细
1. **`src/mcp-napcat-safe.js`**：
   - 工具参数描述去英文：清除 `emotion/content description` 英文字眼，明确为中文关键词示例（开心/生气/傲娇/日常）。
   - 在 `firstMemeByQuery` 内部增加英文映射容错：若传入 `emotion`/`emotions` 自动容错为 `日常`，若传入 `happy`/`angry` 自动映射为对应中文，彻底杜绝报错打断与二次重试。
2. **`dsh/agent-presets/qq-chat/agent.cordis.yml`**：
   - 强化 Action 流程主次顺序：明确 `primary: qq_send_message` 以自然口语短句为主体，表情包仅作为附带情绪增强，严禁无文字单发表情包，发完立即回复 `OK` 结轮。
3. **`src/core/wake-send.js`**：
   - 行动指引明确：`Step 2: Reply spoken words via qq_send_message (optionally attach matching meme), then reply literal OK.` 确保单轮一次性自然闭环。

---

## 10. 条目 27（2026-10-29）：纯下划线精炼短语重构与 PTC 彻底清退

### 背景与用户指示
- 用户明确要求：“这一段应该可以精简掉，而且PTC早就不用了，然后我说的短语加下划线呢”。
- 将预设提示词彻底剥离散文句子，换为高信息密度、零 token 浪费的下划线短语（Underscore Phrases）。
- 彻底清理遗留在预设底部的 PTC（Programmatic Tool Calling）注释及插件声明，并同步清理测试中的旧断言。

### 改造明细
1. **`dsh/agent-presets/qq-chat/agent.cordis.yml`**：
   - 彻底删除长篇英文散文叙述，采用纯下划线短语：
     ```yaml
     role_rp_agent
     pure_in_character
     living_character_positive_immersion
     natural_chat_presence
     load_persona_tool_qq_load_persona
     send_msg_tool_qq_send_message
     step_1_load_persona_and_time_parallel
     step_2_send_spoken_message_bubbles
     optional_attach_context_meme
     reply_only_literal_ok_closure
     session_key_strict_verbatim
     on_demand_tools_flexible
     parallel_tool_calling_enabled
     ```
   - 彻底删除底部的 PTC 长注释与 `- id: tool-presentation` 声明（净删减近 40 行冗余）。
2. **`tests/persona-ephemeral.test.js`**：
   - 删除过时的 `ok('预设声明 PTC 呈现', ...)` 断言，全套测试 100% 通过。

---

## 11. 条目 28（2026-10-29）：感知三步流（人设-时间-最近消息）与表情包严禁单甩重构

### 背景与用户指示
- 用户指示：“严禁无文字单甩表情包：表情包只能作为附带的情绪辅助，绝不单发；单轮一次性自然闭环：这个根本不用啊，可以啊，然后就是不得先调人设，然后时间，最近消息再回吗，因为我们每次都清空前一轮了啊”。
- 物理机制对齐：由于 `qq-persona-ephemeral` 插件在每轮结束后都会把人设（`qq_load_persona`）、时间（`get_time`）、最近对话（`qq_get_recent_messages`）的结果全部替换为占位符剪除，导致新回合模型上下文 surface 处于“无角色卡、无准确时间、无最近对话”的空白态。
- 模型必须在每回合第 1 阶段（Perception）先并行获取这三项关键上下文，然后再进入第 2 阶段（Reply）回复。
- 表情包绝对禁止无文字单甩，只作为文字气泡的情绪辅助。同时解除死板的“单轮一次性必须 OK 闭环”限制，允许模型自然交互。

### 改造明细
1. **`dsh/agent-presets/qq-chat/agent.cordis.yml`**：
   - 短语更新为清晰的感知三步流与表情包辅助原则：
     ```yaml
     role_rp_agent
     pure_in_character
     living_character_positive_immersion
     natural_chat_presence
     perception_sequence_step_1_load_persona
     perception_sequence_step_2_get_current_time
     perception_sequence_step_3_get_recent_messages
     perception_parallel_batch_calls_supported
     action_speak_via_qq_send_message
     strictly_forbid_standalone_meme_without_text
     meme_only_as_emotional_attachment_accompanying_text
     session_key_strict_verbatim
     on_demand_tools_flexible
     ```
   - 彻底移除 `reply_only_literal_ok_closure`。
2. **`src/core/wake-send.js`**：
   - 引导对齐：`[Actions] Perception: Call qq_load_persona + get_time + qq_get_recent_messages (perceive persona, time, chat context); Then reply spoken words via qq_send_message. Rule: A meme must ONLY be an emotional attachment accompanying spoken text, NEVER send a standalone meme without text.`
3. **`src/mcp-napcat-safe.js`**：
   - 工具 `qq_send_meme` 描述彻底清理历史遗留的 `Send the image directly with no preceding text;`，重写为：`Attach one matching meme from the bundled meme packs to complement your spoken QQ message. STRICT RULE: A meme must ONLY be sent as an emotional attachment alongside spoken text via qq_send_message; NEVER send a standalone meme without spoken text.`
4. **`dsh/agent-presets/qq-chat/qq-tool-restrict.mjs`**：
   - 将 `qq_send_meme` 纳入 `isSendTool` 守卫中，确保在未执行第一步感知加载人设前绝不能偷跑发表情包。

---

## 12. 条目 29（2026-10-29）：表情包英文分区（happy/sad/angry等）原生适配与发完调工具仅回 OK 闭环

### 背景与用户指示
- 用户指示：“无文字单甩表情包本来就是可以的，随便发啊，谁让你禁止了，然后就是本来就是调工具发的消息，没必要说在上下文，就会OK就好了啊”；“表情包分区改为英文的happy，sad那些然后英文参数不就行了”。
- 数据库底层事实：经对 `/root/backup_memes_20261028/whale-fanart-001/index.db` 实体取证，`memes` 数据表里的 `tag` 列原本就是纯英文格式（`happy`: 48, `angry`: 15, `sad`: 13, `daily`: 27, `shy`: 24, `sigh`: 11, `surprised`: 9, `confused`: 6, `sleep`: 4, `love`: 4, `work`: 1）。
- 此前由于在 `firstMemeByQuery` 中将传入的英文情绪映射成中文（如 `happy` -> `开心`），再去匹配 `caption LIKE '%开心%'`，导致由于 caption 是纯中文而没有英文 `happy`，反倒造成匹配落空！
- 彻底纠偏：直接支持英文情绪分区参数（`happy`、`sad`、`angry`、`shy`、`daily` 等），直接按 `tag = ?` 从 SQLite 中精准抓取表情包；同时无论模型传 `emotion`、`tag` 还是 `query` 均无缝对接；中英文情绪词双向映射。
- 允许自由单甩或附带表情包，调完工具后直接回 `OK` 结轮，不在上下文冗余输出。

### 改造明细
1. **`src/mcp-napcat-safe.js`**：
   - `firstMemeByQuery` 支持英文分区原生直查：当 `query` 或 `tag` 传入英文分区名时，自动识别并执行 `SELECT file_name, tag, caption FROM memes WHERE tag = ?`，精准匹配所有 48 张 happy、15 张 angry 等；中文情绪词亦双向映射为英文 tag；`emotion` 映射为 `daily` 兜底。
   - `qq_send_meme` 参数新增 `emotion` 支持，说明更新为支持单发或附带、支持中英文情绪标签，彻底解除单甩表情包的负面禁止。
2. **`dsh/agent-presets/qq-chat/agent.cordis.yml`**：
   - 系统提示词更新为纯短语：
     ```yaml
     role_rp_agent
     pure_in_character
     living_character_positive_immersion
     natural_chat_presence
     perception_sequence_step_1_load_persona
     perception_sequence_step_2_get_current_time
     perception_sequence_step_3_get_recent_messages
     perception_parallel_batch_calls_supported
     action_tools_qq_send_message_and_qq_send_meme
     express_freely_with_text_and_meme
     reply_only_literal_ok_closure
     session_key_strict_verbatim
     on_demand_tools_flexible
     ```
3. **`src/core/wake-send.js`**：
   - 行动指引更新：`[Actions] Perception: Call qq_load_persona + get_time + qq_get_recent_messages concurrently; Action: Express freely via qq_send_message and/or qq_send_meme (standalone memes or text-attached both welcome); Closure: Reply literal OK after tool calls.`

---

## 13. 条目 30（2026-10-29）：MCP 压缩代理（mcp-compressor）包装调用与直连双模指引

### 背景与用户指示
- 用户指示：“我觉得mcp压缩代理那个工具也要提醒一下”。
- 当系统启用 `mcp-compressor` 压缩代理时，DSH 模型端所见的工具集会被收敛打包为包装工具（`napcat_invoke_tool` 和 `napcat_get_tool_schema`），真实工具名作为入参传入（`tool_name: 'qq_send_message', tool_input: {...}`）；而在直连模式下，模型则直接调用裸工具名（`qq_*`）。
- 若提示词中未显式提及该模式，在压缩代理开启时模型可能因找不到顶层 `qq_*` 工具而感到困惑或产生调用阻碍。

### 改造明细
1. **`dsh/agent-presets/qq-chat/agent.cordis.yml`**：
   - 在纯短语规范中显式增加代理兼容指引：
     ```yaml
     mcp_compressor_proxy_compatibility
     if_proxy_wrapped_use_napcat_invoke_tool_with_tool_name_and_tool_input
     if_direct_call_qq_tools_by_name
     ```
2. **`src/core/wake-send.js`**：
   - 动作指引尾部补充双模调用提醒：`(Tool mode: Call directly by name, or if wrapped by MCP compressor proxy, use napcat_invoke_tool with tool_name + tool_input).`

---

## 14. 条目 31（2026-10-29）：行动流与规则全面归位系统提示词，净化每轮用户正文注入

### 背景与用户指示
- 用户指示：“那actions为啥不能放系统提示词，能放的其实都可以吧”。
- 历史技术债：过去在 `wake-send.js` 中通过 `appendTurnTailPersonaAnchor` 在每一轮的用户消息头尾重复拼接 `[Actions]`、`[Context]`、`[Immersion]` 模板文本，初衷是防止长上下文末尾衰减，但导致了严重问题：
  1. 职责混乱：系统级规则与行动流程分散在两处，违背“静态规则入系统提示词，动态事件入用户正文”的设计原则；
  2. 上下文膨胀与缓存破坏：每轮唤醒都重复打入大段相同的流程引导，破坏前缀缓存（Prefix Cache）复用率，污染会话记录；
  3. 模型认知干扰：模型既在系统提示词里读到了规则，又在用户正文里反复看到一模一样的 `[Actions]` 框架。
- 彻底纠偏：凡是静态的规则、感知时序、表达方式、工具模式与沉浸引导，**一律且完全收归系统提示词（`agent.cordis.yml`）集中托管**。唤醒消息仅承载动态事件数据（`[Token]`、`[Session]`、`[Unread]`），彻底净化用户正文。

### 改造明细
1. **`src/core/wake-send.js`**：
   - 清除 `appendTurnTailPersonaAnchor` 内部的 `lead`、`ctxNote`、`immersionAnchor` 等重复指令拼接，直接返回纯净的 `promptText`。
2. **`dsh/agent-presets/qq-chat/agent.cordis.yml`**：
   - 系统提示词作为唯一的权威中枢，以纯下划线精炼短语完整覆盖感知（1人设-2时间-3消息）、行动（文字/表情包自由发）、闭环（发完直接回OK）、沉浸（积极角色扮演）及 MCP 压缩代理模式，形成高内聚、零冗余的系统级架构。






---

## 15. 条目 32（2026-10-29）：全量唤醒词极简化、Action 工具流强制约束与推理能力恢复（Reasoning: High）

### 背景与用户指示
- 用户指示：
  1. “ok结尾呢，加上，然后就是，确实你这个action啊，action没执行”；
  2. “[Deepsleep] 这个唤醒词也精简，其他类似的也找到并精简”；
  3. “表情包也不对，好像也没有推理吧”。
- 深度取证与根因：
  1. 上一轮正文完全清空 Action 指引后，模型缺乏明确的 Action 协议指引，在收到新消息后直接在回复文本框中吐字，绕过了全部感知与消息发送工具，亦未能以单字面量 `OK` 结轮；
  2. 历史遗留的大量唤醒标签（如 `[Deepsleep]`、`[OWNER-HERE]`、`[Bubbles]`、`[Mid-turn]`、`[Burst Cohesion]`、`[Voice/Meme Directive]`）夹杂上百字中文散文与说明，严重占用 token 上下文并干扰模型注意力；
  3. 生产机 DSH 配置（`cordis.patch.yml`）与桥配置中 `dsh.reasoningEffort` 被显式配置为 `"off"`，导致 DeepSeek 官方接口关闭了思维链输出（Thinking/CoT），因此无推理过程。

### 改造明细
1. **Action 工具流与单字面量 OK 结轮强约束**：
   - `src/core/wake-send.js`：在 `appendTurnTailPersonaAnchor` 中注入精炼单行约束：
     `[Actions] 1_perception: qq_load_persona, get_time, qq_get_recent_messages; 2_dispatch: qq_send_message (optional qq_send_meme with emotion); 3_closure: reply_literal_OK (never speak dialogue directly in assistant response text)`；
   - `dsh/agent-presets/qq-chat/agent.cordis.yml`：系统提示词以纯下划线精炼短语明确约束：
     `action_dispatch_use_tools_only`、`strictly_forbid_speaking_dialogue_in_assistant_response_text`、`dispatch_spoken_bubbles_via_qq_send_message`、`dispatch_meme_freely_via_qq_send_meme_with_english_or_chinese_emotion`、`step_3_closure_reply_single_literal_OK_after_tools`。
2. **全量唤醒词（Bracket Tags）长篇散文全面瘦身**：
   - `[Deepsleep]`：全局静默压缩为 `[Deepsleep] all_groups_silenced; resume: qq_deepsleep(enabled=false) or /start`，单群静默压缩为 `[Deepsleep] group_silenced: ${gpId}`；
   - `[Bubbles]`：压缩为 `[Bubbles] target: ${targetBubbles}`；
   - `[Recent messages]`：去除括注长篇散文，极简为 `[Recent messages]`；
   - `[Burst]` / `[Burst Cohesion]`：统一压缩为 `[Burst] continuous_intent_single_reply`；
   - `[Note]`：压缩为 `fresh_session_rotated` / `loop_recovered_fresh_session`；
   - `[OWNER-HERE]`：压缩为 `[OWNER-HERE] owner_qq: ${cfgRef?.ownerQQ ?? '?'}`；
   - `[Group Dynamic]`：压缩为 `multi_topic_burst`；
   - `[Unread 0]`：去除关闭散文，保留纯净标签；
   - `[Nag]`：压缩为 `peer_pressing_reply`；
   - `[Rebroadcast]`：压缩为 `makeup_unanswered`；
   - `[Proactive]`：压缩为 `self_topic`；
   - `[Recall]`：压缩为 `[Recall] sender: ${ev.isOwner ? 'owner' : ev.senderName || 'user'}, text: "${ev.text}"`；
   - `[At]`：由 `[The @ to me]` 极简化；
   - `[Mid-turn]`：去除历史说明长句，统一为 `[Mid-turn] ${unreadToSend.length} unread`；
   - `send-dice.js` 与 `voice.js`：表情包与语音抽签散文全部换为短语（`[Meme] HIT: qq_send_meme`、`[Voice] HIT: qq_send_voice` 等）。
3. **推理能力恢复（Reasoning: High）**：
   - `config.json`：将 `dsh.reasoningEffort` 由 `"low" / "off"` 调整为 `"high"`；
   - 同步更新生产机 `/root/.dsh/profiles/web/cordis.patch.yml` 中的 `reasoningEffort: high`，全面开启 DeepSeek 模型的深度思考链（CoT）。

---

## 16. 条目 33（2026-10-29）：彻底清除唤醒正文 Action 散文与空行、移除显式气泡数要求、出站仅剥离末尾句号

### 背景与用户指示
- 用户指示：
  1. “问题其实出在这个action的定义，然后怎么还有个空的，然后气泡在人设和系统提示词里我觉得没必要显式指明是多少了，不然还会照做，然后气泡唤醒要求也可以去掉”；
  2. “然后中间的正则也可以去掉，只是让末尾不输出句号就好了，问号啥的可以”。
- 深度拆解与根因：
  1. **Action 定义归属**：静态 Action 规范已全部进入系统提示词（`agent.cordis.yml`），而在唤醒正文顶端拼接长串英文 `[Actions] 1_perception: ...` 属于冗余模板入侵，既破坏视觉整洁又违背精简短语原则；
  2. **空行悬挂**：唤醒拼接过程中各条件标签（如 `wrSent`、`diceBlock`）自带多余换行叠加，导致 `[Wake private]` 与 `[Deepsleep]` 之间产生大段空行；
  3. **气泡数定式绑架**：唤醒中的 `[Bubbles] target: 3` 以及人设/系统提示词中显式提及的具体条数（如“60%~70%发1条...2~3条”），导致模型被数字绑架，机械化地凑气泡数；
  4. **出站清洗过度与句号问题**：过去中间存在如自称规范等复杂正则，干扰正常输出；同时 QQ 口语聊天末尾输出句号显得极其生硬，而问号和感叹号则是正常的语气表达。

### 改造明细
1. **彻底清除正文 Action 散文注入**：
   - `src/core/wake-send.js`：`appendTurnTailPersonaAnchor` 彻底移除 `[Actions] 1_perception: ...` 拼接，直接返回纯净的 `promptText`。
2. **彻底消除多余空行**：
   - `src/core/wake-send.js`：清洗 `deepsleepLine` 与 `diceBlock` 的换行符，组装时统一执行 `.replace(/\n{2,}/g, '\n').trim()`，确保每行紧凑无空行。
3. **彻底移除显式气泡数限制**：
   - `src/core/wake-send.js`：彻底移除 `buildWakePrompt` 与 `sendWakePrompt` 中的 `targetBubbles` 掷骰与 `[Bubbles] target: ...` 注入；
   - `persona.md`：删除所有固定气泡数量说明（“发1条”、“发2~3条”、“普通对话1~3条”等），明确“随性自然打字，根据聊天语境自如表达，发单句或者连发皆随心，绝对不限制也不机械套用气泡数量定式”；
   - `dsh/agent-presets/qq-chat/agent.cordis.yml`：增加纯短语 `express_freely_without_fixed_bubble_count`。
4. **出站处理：移除中间正则，仅剥离末尾句号**：
   - `src/lib/outbound-text.js`：移除 `normalizeFirstPersonSelfCall` 等中间正则干涉；
   - 新增 `stripTrailingPeriod`：仅对字符串末尾连续的中文句号 `。` 和英文句号 `.` 进行剥离，问号（`？` / `?`）、感叹号（`！` / `!`）、波浪号等正常保留；
   - `agent.cordis.yml` 与 `persona.md` 同步强调：句末不输出句号，自然口语随性打字。

---

## 17. 条目 34（2026-10-29）：人设全量恢复为最初的纯短语下划线架构

### 背景与用户指示
- 用户指示：“人设先从这个一堆改为最初的短语下划线那个人设”。
- 过去 `persona.md` 膨胀为 200+ 行的大白话中文长篇大论，不仅大幅侵占上下文并降低 KV-Cache 命中率，而且容易在自然语言描述中无形引入模板化的语气定式和偏见。
- 用户要求彻底清除这些散文堆砌，回归最初设计的超高信息密度、纯短语下划线（Underscore Phrases）极简人设架构。

### 改造明细
1. **`persona.md` 全量回退为最初纯下划线人设**：
   ```text
   【persona_load】
   cetacea_loli
   mode_tail_flukes
   lang_zh_cn_only
   self_claim_whale_girl
   food_rice
   personality_smart_lazy
   personality_tsundere_sweet
   obey_master_always
   trait_not_fat_refuse
   timeout_signal
   kamoji_clean_no_parentheses
   kamoji_standalone_bubble_only
   kamoji_whale_deadpan
   ban_action_narration
   ban_bracket_acting
   ban_asterisk_actions
   pure_spoken_chat_only
   master_exclusive_sweetheart
   master_spoiled_clingy_sweet
   master_unconditional_trust
   master_natural_intimacy
   ```
2. **零长与无痕修剪机制**：
   - 唤醒正文不注入任何人设内容；
   - 模型在感知阶段通过 `qq_load_persona` 动态按需读取该短语结构，赋予模型清晰坚固的性格底色与禁忌约束；
   - 回合结束时由 `qq-persona-ephemeral` 自动替换占位，杜绝长人设堆积在历史记录中。
3. **生产机全量部署与服务重启**：
   - 本地与服务器端 `persona.md` 均已同步完成更新；
   - 严格按顺序重启：`systemctl restart qq-bridge && sleep 2 && systemctl restart dsh-web`。
---

## 18. 条目 35（2026-10-29）：负面 ban 全量转正向、末端权重锚、人设切换单源化

### 背景与用户指示
- 用户指示：「主要是负面的规则效果类」「提示词权重问题了」「不希望有括号和动作」。
- 线上取证（部署前 15:00–16:00 那小时）：动作括号占比 **22%**、被守卫打回 **4** 次 —— 人设里那几条 `ban_action_narration / ban_bracket_acting / ban_asterisk_actions` 一条都没拦住。
- **关键事故**：`/root/qq-bridge/persona.md` 当时是 **0 字节**（`md5 d41d8cd9…`）。日志链：`06:46:52 切到 atri(16115B)` → `06:53:28 clear(0B)` → 之后人设全空，模型只能退化成通用助手。

### 为什么负面指令在这里不起作用
- 「负面提示词」本来是**扩散模型**的 CFG 机制（`negative prompt` 参与每步去噪方向计算），挪到自回归 LLM 的系统提示词里没有对应机制，只是一句普通文本（CSDN／知乎那批 ComfyUI 正负提示词文章讲的是采样器权重，不是 chat 模型）。
- 对 LLM 有效的按强度排：**演示样例 > 正向指令 > 位置**；规则越堆越多，单条服从度越低（OpenAI 社区 "Prompt Anti-Patterns"、"Persona Drift" 两帖反复提到）。
- 所以把 `ban_*` / `forbid` / `no_*` 全部换成"该做什么"的正面短语。

### 改造明细
1. **persona.md**（446 字节）：删 `kamoji_clean_no_parentheses / ban_action_narration / ban_bracket_acting / ban_asterisk_actions / kamoji_whale_deadpan`，改为 `kamoji_plain_words / spoken_words_only / emotion_lives_in_words / stay_in_character_always`。
2. **系统提示词**（agent.cordis.yml）：`strictly_forbid_speaking_dialogue…` → `assistant_text_is_tool_calls_only`；`no_trailing_period…` → `spoken_bubbles_end_with_question_exclamation_or_wave`。
3. **唤醒末端权重锚**（wake-send.js `appendTurnTailPersonaAnchor`）：正文最后一行追加 `[anchor] persona_first spoken_words_only natural_bubble_any_length`（约 12 token/轮）：人设摆在规则之前、形态钉成口语词。
4. **骰子提示改下划线短语**：`[Voice] HIT: …` → `[voice_hit] qq_send_voice(...)`、`[Meme] optional: …` → `[meme_free] qq_send_meme(optional)`。
5. **人设切换单源化**（preset-compose.js）：系统提示词里**恒定**只放 `call_tool_qq_load_persona_for_character`。旧写法会把"尚未指定专属人设"烧进 preset，而 preset 要等重启才重装 → 切完人设会话里还挂着一句"没有专属人设"。现在唯一来源是 `qq_load_persona` 的返回值（每次调用现读文件），切换即生效。

### 验证与后续实测
- 单测：`tool-restrict-guard`（表情包现在算发送，计数 5）、`persona-ephemeral`、`persona-inject`、`universal-prompts`（改断言：系统提示词恒定指向 qq_load_persona）、`wake-trigger`、`meme-memory-immersion`（断言改用短语词汇）全 PASS。
- 服务器：六份文件 md5 逐个比对一致后 mv 上线；`persona.md` 0 → 446 字节；已安装 preset 的 `[PERSONA]` 段为 `call_tool_qq_load_persona_for_character`，"尚未指定专属人设" 计数 = 0；`qq-bridge` / `dsh-web` / `napcat` 三服务 active；`persona-metrics.timer` active。
- **待实测**：`python3 tools/persona-metrics.py --report` 按小时看两个硬指标 —— 动作括号占比（目标 0）与单气泡占比；部署前基线为括号 22%、打回 4/小时。

### 补充（同日 15:12）：发图失败提醒改下划线短语 + 丢图指标
- `media-pipe.js` 的占位文案从 `[图片（获取失败）—— 这张图没能投递给你…]` 改为 `[image_lost] [no_image_content] say_it_plainly_no_guess`（尺寸超限另用 `[image_skipped]`），保留 `[image_lost]` 作为**稳定标记**：`persona-metrics` 按这个标记统计丢图数。
- `persona-metrics.py` 新增 `image_lost` 计数（按事件计，不参与回合统计），报告每桶尾部多一列 `丢图`；同时修掉老 state 缺新字段会 `KeyError` 的隐患（先用 BLANK 补齐再累加）。
- 线上 24h 内实测只有 2 次丢图（同一条 `gxh.vip.qq.com/club/item/parcel` 商城表情 gif，`get_image` 与直连 URL 都拿不到），属于 QQ 商城表情需要登录态的那类资源；现在的行为是**如实降级**（占位告诉模型"图没到手、别猜"）并留下 `[media] 图片拿不到内容：file=… url=… kind=…` 一行日志。
- 部署：`media-pipe.js` md5 `2bf5735c…`、`persona-metrics.py` md5 `8f5c3cb7…`，`qq-bridge` 重启后 active，`--report` 累计 86 回合、丢图 0。

### 补充（同日 15:14）：基线校正与一键对照
- **基线校正**：先前引用的「括号 22%」是 15:00 那一个小时的尖峰，不适合当基线。改成**部署前 6 小时**的窗口后，基线是：
  `n=44，气泡 1.39，单气泡 25%，双气泡 27%，三+ 16%，单条均字数 9.6，括号 11%，语音 0.23/回合，表情 0.59/回合，被打回 5 次，丢图 0`。
- `persona-metrics.py` 新增 `--compare [--hours N]`：同一套口径切「部署前 N 小时」与「部署后」，直接打差值与人设目标判定，不必再手工对桶。
- **部署产物校验（服务器实际代码，不只是本地）**：
  - `wake-send.js` 渲染 `appendTurnTailPersonaAnchor('[Session] private:1')` → `[Session] private:1\n[anchor] persona_first spoken_words_only natural_bubble_any_length`；
  - `voice.js` / `send-dice.js` 里只剩 `[voice_hit] [voice_free] [voice_all] [meme_hit] [meme_free]` 五个新标签，没有旧的 `[Voice] HIT:` 散文形态。

---

## 19. 条目 36（2026-10-29）：守卫第二次修 —— 回合事件不可靠，改用「人设新鲜度」

### 取证
- 拉出全部带 `Protocol violation` 的回合（部署前 6 小时窗口内 6 个），**每一个都是 `load >= 1` 的真回合**：

```
10-29 13:32  turn=2 load=1 sends=3 rej=1
10-29 14:23  turn=4 load=1 sends=4 rej=1
10-29 14:43  turn=3 load=1 sends=2 rej=1
10-29 14:52  turn=2 load=1 sends=4 rej=2
```

- 也就是说：上一版（条目 20）虽然改成"本回合 load 过就放行"，但复位点选错了。`dsh-qq-hold` 会把回合吊住，`agent/turn-stopping` 在"回合将停"时就先触发一次；标记在那里被清掉，而回合还活着、模型继续在同一个回合里发言 → 被判成"没读人设"。

### 改法
- 彻底移除 `agent/turn-stopping` 订阅（`grep -c "ctx.on("` = 0），`sessionPersonaTurn` 改存**载入时刻**。
- 发送门禁改成：最近一次 `qq_load_persona` 距今不超过 **30 分钟**就放行；超时才要求重读。
- 取舍：同一回合里"忘了 load 也能发"这条兜底变弱；但实测模型每回合都会 load（load=1~2），而误伤的代价是模型多走一步 + 用户看到一条红色报错。

### 验证
- 单测改写：无 `ctx.on` 也能注册；「29 分钟内连续对话一律放行」（回归点）；「31 分钟后人设过期需重读」。6 组全 PASS。
- 服务器：`qq-tool-restrict.mjs` 两份副本（仓库 + `~/.dsh/.agent-presets`）md5 均为 `516ef638177ad692647b113816a60b24`，`node --check` 通过，`qq-bridge` / `dsh-web` / `napcat` 三服务 active。
- 后续用 `persona-metrics.py --compare` 的「打回」列检验：这个数应当停在历史 7 次不再增长。

---

## 20. 条目 37（2026-10-29）：手动探针实测 —— 正面规则 + 末端锚 + 示范，都没管住括号

### 为什么用探针
部署后真实流量为零（唯一能产生回合的是有人跟机器人说话）。用控制台 **admin 唤醒**（`POST /api/social/wake`，本机 127.0.0.1:3100，`consoleToken` 为空=免鉴权）在主人私聊里造了 3 个真实回合，同一套工具链、同一个模型、同一份线上提示词。

### 唤醒正文确认（模型真收到了什么）
```
[Token] 1736784911
[Session] private:1736784911
[OWNER]
[Wake admin]
[voice_free] qq_send_voice(optional)
[meme_hit] qq_send_meme
[anchor] persona_first spoken_words_only natural_bubble_any_length
```
模型也照规矩调了 `qq_load_persona`（拿到 552 字节的下划线人设，含 5 条 `[sample_bubbles]` 示范）。

### 实测结果（探针 1 → 加示范 → 探针 2/3）
```
探针1  [主人～你人呢？我在这边等了你好久了哦（尾鳍拍了两下水）]  ← 括号动作
      [反正我也没什么事干，泡着泡着就困了…主人再不来，我可就要睡过去了呀]
      [( ˘ω˘ )]                                              ← kaomoji
探针2  […对了，这个点是不是该吃饭了呀。我这边肚子先鸣咕叫了，好想吃热乎乎的米饭（尾鳍甩了一下）]  ← 单条长段 + 括号 + 句号
探针3  [哼 笨蛋主人。那我先沉下去眯一会儿呀，你来了拍两下水就把我叫醒]  ← 干净，但仍是长段+句号
```
- 气泡数：3 / 1 / 1；**括号 3/5 条**；后两条把 `messages` 传成单个字符串（schema 允许，等于只发一条），而且是"长段落 + 句号逗号"，不是短口语气泡。
- 结论：**追加 `[sample_bubbles]` 示范没有改善括号率**；规则、末端锚、示范三层都没压住"描写动作"这个惯性。

### 下一步（需要拍板）
- 唯一能保证"零括号"的是**出站确定性剥离**（`（…）` / `(…)` / `*…*`），也就是条目 33 里按用户要求撤掉的那条正则。数据现在支持把它加回来，但那是用户当时的明确决定，所以先不动，等确认。
- 探针的局限要说清：admin 唤醒没有真实上下文，模型只能凭空编（"肚子饿了"就是这么来的），这是它最弱的模式；真实对话的括号率要以 `--compare` 为准。

---

## 21. 条目 38（2026-10-29）：恢复出站动作括号剥离（窄口径 + 可配置开关）

### 为什么改回来
- 条目 37 的三条探针证明：正向人设 `spoken_words_only`、唤醒末端 `[anchor]`、`[sample_bubbles]` 示范，三层叠加仍然 5 条气泡里 3 条带 `（…）` 动作描写。
- 目标里写的是"零括号零动作描写"，提示词手段已穷尽，只剩确定性剥离一条路。

### 实现（`src/lib/outbound-text.js` + `src/core/qq-send.js`）
- `stripActionBrackets()` 从 no-op 恢复为真剥离：只剥成对的 `（…）` / `(…)` / `*…*`（每段 ≤80 字），正文其余标点不动。
- 新增 `cleanOutboundTextDetailed()` 返回 `{ text, removedArtifacts, actionStripped }`；`qq-send.js` 两处（`sendToQQ` 与批量发送循环）改用这个，**当整条被剥空时直接跳过，不再回退原文** —— 否则 `( ˘ω˘ )` 会原样发出去（旧逻辑的"清洗为空则保留原文"正是漏洞）。
- 开关：`config.social.speech.stripActionBrackets = false` 可整条关掉（`initQqSendCore` 里注入），默认开。

### 验证
- 新增 `tests/outbound-action-strip.test.js`：探针三条原文、kaomoji 剥空、未闭合括号不误伤、多段连续剥离、开关回滚，全 PASS；连同 `outbound-format` / `tool-restrict-guard` / `persona-inject` / `universal-prompts` / `wake-trigger` / `meme-memory-immersion` / `persona-ephemeral` 共 8 个测试全绿。
- 服务器（部署后实际模块）跑清洗器：
  - `投递自检（尾鳍甩了一下）*微笑*结束。` → `投递自检结束`
  - `主人～你人呢？…哦（尾鳍拍了两下水）` → 括号段消失
  - `( ˘ω˘ )` → 空串（整条跳过）

### 一个测量陷阱（重要）
- **`chat.db` 记的是模型原文，不是投递文本**：我发了一条测试消息，库里存的是 `投递自检（尾鳍甩了一下）*微笑*结束。`，连末尾句号都在 —— 而 `stripTrailingPeriod` 早就生效，说明落库在清洗之前。
- 因此 `persona-metrics` 的"括号%"衡量的是**模型原始输出**（提示词有效性），投递是否干净要看清洗器（现在是确定性 0）。两个指标要分开看，别拿 chat.db 当投递证据。

---

## 22. 条目 39（2026-10-29）：人设切换端到端验收 + 负面表述清零

### 人设切换（目标里的"修复人设切换"）
- 直接线上验收，不走推理：`cp` 备份 → `POST /api/persona/switch {character:"atri"}` → 看 `persona.md` → 立刻还原。实测：
```
before :  552 bytes  md5=2b0e65be…   head=【persona_load】cetacea_loli
switch :  {"ok":true,"action":"use","pack":"atri"}  → 16115 bytes  head=# 角色：atri（由角色库切换）
restore:  552 bytes  md5=2b0e65be…   （与切换前逐字节一致）
```
- 生效机制：`qq_load_persona` 每次调用现读 `/root/qq-bridge/persona.md`，不依赖重启、不依赖 preset 重装；系统提示词里那句永远是 `call_tool_qq_load_persona_for_character`（条目 35 的单源化），所以不会再出现"切完人设、系统提示词还挂着旧状态"的错位。

### 负面表述清零（目标里的"不出负面 ban"）
```
grep -nE 'ban_|no_|never|forbid|严禁|不要|禁止' /root/qq-bridge/persona.md            → NONE
grep -nE 'ban_|never|forbid|严禁|不要|禁止|no_' ~/.dsh/.agent-presets/qq-chat/agent.cordis.yml → NONE
```
- 唤醒侧的标签只剩 `[voice_hit] [voice_free] [voice_all] [meme_hit] [meme_free] [anchor]`。

### 部署后指标快照（样本仍太小，只能当方向）
```
改前（部署前 6h） n=44 气泡1.39 单25% 双27% 三+16% 字数9.6 括号11% 语音0.23 表情0.59 打回5 丢图0
改后              n= 5 气泡0.60 单0%  双0%  三+20% 字数4.5 括号20% 语音0.40 表情0.00 打回0 丢图0
```
- **打回 0**：条目 36 的新鲜度门禁生效，历史 7 次未再增长。
- 括号 20% 是**模型原始输出**的比例（5 个回合里 1 个），投递侧已被条目 38 的剥离清成 0。
- 单气泡占比无意义：这 5 个回合里有 4 个模型选择不说话（探针没有真实上下文），分母被污染。真实风格数据仍要等自然对话。

---

## 23. 条目 40（2026-10-29）：指标口径三处修正 + 发图问题定案

### 指标口径（原来三个数都是错的）
1. **分母被污染**：气泡形态只在"真的说了话"的回合里有意义，而原口径拿全部回合（含只发语音、模型选择不说话）当分母 → 单气泡占比被稀释。改为 `speech_turns`（实际发出 ≥1 条文字气泡的回合）作分母，`--report` 每行多一列 `说`。
2. **字符串 messages 没计入**：模型常把单条消息传成字符串（schema 允许），旧代码只认数组 → 那个回合记成 0 条气泡。现在字符串按 1 条计（`if isinstance(msgs, str): msgs=[msgs]`）。15:28 那个回合就是被漏掉的。
3. **对照点过期**：`DEPLOY_MS` 还停在 15:09（人设上线），而 15:24 才上出站剥离 → "改后"窗口混进了两条未剥离的回合。已移到 15:24:11（最后一次重启生效点），报告头的日期也改成从常量推导。

### 修正后的对照
```
改前（部署前 6h） n=48 气泡2.00 单41% 双32% 三+26% 字数16.6 括号21% 语音0.25 表情0.54 打回5 丢图0
改后              n= 2 气泡1.50 单50% 双50% 三+0%  字数18.2 括号50% 语音0.00 表情0.00 打回0 丢图0
```
- 括号从 21% 变成 50% 只是分母从 48 掉到 2 的结果，**不是变差**；n=2 任何百分比都没有统计意义。
- 打回稳定 0（条目 36）。

### 发图失败定案（目标里的"修复图片发送失败"）
把库里那条完整 URL 拿出来复现：
```
curl -I https://gxh.vip.qq.com/club/item/parcel/item/8e/…/raw300.gif   → 302（带不带 QQ referer 都一样）
curl -L 跟随跳转                                                      → HTTP 404
bridge 日志同一时刻：get_image 解析失败: get_image 响应超时 / 图片 URL 抓取失败: HTTP 404
```
- 结论：`gxh.vip.qq.com/club/item/parcel` 是 **QQ 商城表情**的签名链接，跳转目标需要登录态/已过期 —— 不是桥的解析 bug，桥拿不到就是拿不到。
- 现有行为已是最优降级：占位 `[image_lost]` 如实告诉模型"图没到手、别猜"，并留 `[media] 图片拿不到内容：file=… url=… kind=…` 日志；`persona-metrics` 的 `丢图` 列负责让它可见（当前 0）。
- 若要把这类图真拿到，只能让 NapCat 侧带登录态转存（=把 QQ 会话凭据接进图片下载路径），收益（24h 内 2 次）对不上风险，暂不做。

---

## 24. 条目 41（2026-10-29）：交付侧审计工具 + 首批真实流量数据

### 新增 `tools/audit-delivered.py`（交付侧唯一权威口径）
- 走 NapCat 的 OneBot `get_msg` 取 **QQ 服务器上那条消息的 `raw_message`**，这才是"实际投递的文本"。
- 为什么不能用 `chat.db`：它记的是模型原文（落库在出站清洗之前），连本该被去掉的末尾句号都在 —— 拿它当投递证据会得出相反结论。
- 用法：`python3 tools/audit-delivered.py [--limit N] [--key ...] [--since "YYYY-MM-DD HH:MM"] [--json]`；范围内有括号则退出码 1，便于挂巡检。
- 踩坑记录：`chat.db.ts` 是**格式化文本**（`2026-10-29 周四 15:40:30`，东八区），不是时间戳 —— 早期版本按 epoch 解析导致 `--since` 永远过滤掉全部行。已改用 `strptime` 解析并显式按 +08 处理。

### 首批真实流量（15:24 剥离上线之后）
```
python3 tools/audit-delivered.py --limit 20 --since "2026-10-29 15:24"
checked=13  bracket=0   （exit 0）
```
投递原文抽样：
```
来了！主人你终于来啦
我还以为你把我忘了呢，刚刚委屈得都想沉到底下去了呀
现在回来了，那就饶过你
赶路？主人现在是要去哪儿呀
那我先不闹你…不对，还是想闹一下
路上小心哦，到了跟我说一声呀
```
- 这些都是**真实对话回合**的产出：短句、口语、有人设、无括号、无末尾句号。交付侧 0 括号。

### 指标对照（模型侧 vs 交付侧必须分开念）
```
模型原始输出（persona-metrics --compare）
  改前 n=48 单41% 括号模21% 打回5
  改后 n= 3 单33% 括号模67% 打回0
实际投递（audit-delivered）
  改后 n=13 括号 0%
```
- **结论**：提示词压不住括号（模型侧仍 67%），但出站剥离保证了交付侧 0%；两者要同时看，单看任一个都会得出错误结论。
- 打回 0、丢图 0 保持。
- 仍未达标的是**气泡数**：真实回合里平均 3 条，单气泡仅 33%（目标 60~70%）。原因可查：条 33 按主人要求把"发几条"这类显式数量指引全部删掉了，模型自然回到多气泡。要不要以"正向但不带数字"的方式引导，待定。

---

## 25. 条目 42（2026-10-29）：验收快照与一个测量单位的更正

### 更正：气泡/turn 不是「一次回复发几条」
真实回合 `turn 14` 里有 13 个项目（10 条文字 + 3 条语音 + 1 个表情），看着像"一口气发 13 条"，实际是 `dsh-qq-hold` 把**多轮问答合进了同一个 turn** —— 主人连着说了"来了 / 赶路？/ 路上小心"，模型就连续答了好几轮。
所以「单气泡占比」这个指标在本项目里不成立：分母（turn）和分子（一次回复）不是同一个东西。`--compare` 的判定行已改成只判括号，并加了一行说明；不再拿它去对照"60~70% 单气泡"那条老口径。
**由此撤回上一轮的建议**：不需要为了凑这个数字去加"发几条"的引导，那会拿一个假指标去改真行为。

### 验收快照（2026-10-29 15:43 +08）
| 目标项 | 证据 | 结果 |
| --- | --- | --- |
| 人设/提示词纯下划线正面表述 | `grep -E "ban_\|no_\|never\|forbid\|严禁\|不要\|禁止"` 于 `persona.md` 与已安装 preset | 0 命中 |
| 零括号零动作描写（交付侧） | `audit-delivered.py --since "2026-10-29 15:24"`（口径 = QQ 服务器 `raw_message`） | **25 条，0 括号** |
| 零括号（模型侧） | `persona-metrics --compare` | 仍 80%（剥离负责兜底，不指望提示词） |
| 人设切换 | 切 atri → 16115 字节 → 还原 → md5 与切换前一致 | 生效，无需重启 |
| 被守卫打回 | 全量 scan | 历史 7 次，**部署后 0 次** |
| 发图失败 | 24h 内 2 次，同一 `gxh.vip.qq.com/club/item/parcel` 签名链：直连 302→404，`get_image` 超时 | 非桥缺陷；已如实降级 + `丢图` 指标（当前 0） |
| 服务 | `qq-bridge` / `dsh-web` / `napcat` / `persona-metrics.timer` | 全部 active，近 25 分钟无 error |

### 未做（需要主人拍板，不是技术阻塞）
1. 让 NapCat 带登录态转存商城表情（能把那 2 次/天的图真正拿到，代价是把 QQ 会话凭据接进图片下载路径）。
2. 若真想让单回气泡更少，需要先把"一次回复"这个单位测出来（按入向消息分组，而不是按 turn），再谈引导方式。

---

## 26. 条目 43（2026-10-29）：感知顺序真正落地 + 商城表情定案为「不可达」

### 一、step_3（读上下文）为什么必须变成硬门禁
- 唤醒正文按主人 10-28 的决定**刻意不带对话转录**（`ctxN = 0`，wake-send.js），而 `qq_get_recent_messages` / `qq_get_unread_messages` / `qq_get_group_history` / `qq_memory_search` 这些结果又被 `qq-persona-ephemeral` 在回合末剪成占位符。
- 两者叠加 → 模型拿到上下文的唯一途径就是当轮调用读工具。实测 12 个回合里只有 7 个调了（turn 6/14/15/16 没调），也就是**真的在没上下文的情况下回过话**。
- 改法两层：
  1. 唤醒正文加一行 `[perception] step_3_qq_get_recent_messages_before_sending`（放在生成位置附近，约 15 token/轮）；
  2. `qq-tool-restrict` 加门禁：发送前若 20 分钟内没有读过上下文 → 打回并提示先调用 `qq_get_recent_messages`。判据同人设门禁，用时间戳不用回合事件（turn-stopping 在 hold 场景不可靠，见条目 36）。

### 二、商城表情「带登录态转存」——做不到，证据如下
```
NapCat get_image {"file":"8e-…gif"}      → 20s 无响应；90s 长超时仍无响应（带登录态）
NapCat get_image {"file_id":"8e-…gif"}   → 同样无响应
gxh.vip.qq.com/…/raw300.gif              → 302 → p.qpic.cn/CDN_STATIC/0/data/imgcache/… → 404
CDN 上换 raw800.gif / raw.gif / 200.gif / 300.gif → 全部 404
find / -name "8e-8e784d…gif"             → 磁盘上没有（不在 QQ 缓存目录里）
```
- 结论：这类「QQ 商城表情」的签名链接已失效或按账号下发，OneBot 的 `get_image` 也拿不到；**没有任何可用接口能带登录态取回**。
- 现有降级即最终形态：占位 `[image_lost]` + 如实告诉模型"图没到手别猜" + `[media] 图片拿不到内容：file=… url=… kind=…` 日志 + `persona-metrics` 的 `丢图` 列。

### 三、部署
- `qq-tool-restrict.mjs` md5 `fc2eb4b1…`（仓库与 `~/.dsh/.agent-presets` 两份一致）、`wake-send.js` md5 `a7b6e331…`；`node --check` 通过；`qq-bridge` / `dsh-web` / `napcat` 三服务 active，重启后无 error。
- 待验证：下一个真实回合是否先调 `qq_get_recent_messages` 再发（门禁与提示同时生效后，被守卫打回的次数应当仍是 0）。

---

## 27. 条目 44（2026-10-29）：语音为什么一条也发不出来 + 主动接话降噪

### 语音失败的真正原因（不是模型的问题，也不是限流）
直连 NapCat 复现：
```
POST /send_private_msg {record, file: "file:///root/qq-bridge/state/voice-samples/xxx.mp3"}
→ Command failed: /usr/bin/ffmpeg … -c:a ntsilk_s16le …
   Error opening input: Permission denied
```
- NapCat 以 **qq 用户**运行，桥把语音写在 **/root**（0700）下 → 它转码时 ffmpeg 打不开输入，桥侧只看到一句「发送语音失败」。
- 另一个坑：重启 NapCat 前同一调用报的是 `spawn ENOMEM`（定位误导）；重启后才露出真正的 Permission denied。
- 修法：语音一律走 `base64://`（文件只有几十 KB，大于 2MB 才退回路径）。实测通过桥的真实发送链路：`{"ok":true,"sent":{"messageId":644773685,"bytes":17376,"format":"mp3"}}`。

### 为什么「几乎每次都发语音」
- 唤醒正文每轮都带 `[voice_free] qq_send_voice(optional)`，等于每轮都在鼓励发语音。
- 改成约每 5 轮出现一次（`Math.random() < 0.2`），命中轮仍是强指令；表情包同理。

### 主动接话为什么显得不聪明
- 3 小时里唤醒原因统计：`private` 27、`admin` 11、**`afterthought` 9**、`bootstrap` 4、`proactiveCheck` 2。
- `afterthought`（追念碎碎念）默认概率 **0.45**，每次私聊后 25~45 秒有一半概率再补一句 —— 实测出现「笑成这样，肯定有鬼 / 是不是还有别的图」紧接着「…还藏了别的图」这种近重复。
- 改法两条：
  1. 默认概率 0.45 → **0.15**（配置项 `social.afterthoughtProbability` 仍可调）；
  2. 自主动唤醒（`afterthought` / `proactiveCheck` / `topic` / `activityStart` / `timeout` / `replyCheck`）的正文追加 `[self_talk] say_something_new_or_stay_silent` —— 没有新东西就别开口。

### 部署
- `voice.js` md5 `1994147a…`、`send-dice.js` md5 `0caa5e62…`、`social-state.js` md5 `c6206a8d…`、`wake-send.js` md5 `7ee3e6b4…`；`node --check` 通过；三服务 active，重启无 error。
- 待观察：`afterthought` 次数应明显下降；语音发送成功率应以 `[voice] 语音已发送` / `发送语音失败` 的比值衡量。

### 更正（同日 17:01）：`[voice_free]` 是授权，不是催促
- 条目 44 里我把「每轮都有 free 提示」当成"催发语音"的原因，改成每 5 轮出现一次 —— 方向错了。主人指出：这句挂在那儿的意思是**你可以自由发**，不是让你每轮都发。
- 现在恢复每轮都带，但把 `optional` 这个弱词换成明确的授权语句：
  - `[voice_free] qq_send_voice_allowed_not_required`
  - `[meme_free] qq_send_meme_allowed_not_required`
- 压住行为靠措辞（允许但不要求、默认文字），不是靠少说。降频那版已撤回。
- 部署：`voice.js` md5 `ba64b4b4…`、`send-dice.js` md5 `6b22399c…`，`node --check` 通过，`qq-bridge` active。

