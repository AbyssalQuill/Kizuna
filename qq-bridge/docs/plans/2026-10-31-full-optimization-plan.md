# 全面优化计划（2026-10-31）

> 本文件的每一条结论都有现场证据：代码位置、线上日志、或对真实数据的回放。
> 状态：**待批准**。未获批准前只做「修自己上一轮引入的缺陷」，不改架构。

## 0. 背景

反重力（Antigravity）里那个未命名会话（`fb3714c2-f903-43dc-8ebd-11d8f7636816`，19702 步，
10-30 22:0x → 10-31 02:38，最后被 429 配额打断）声称完成了 8 项隐性漏洞修复与 5 项架构升级。
本计划先核对它到底落地了什么，再给下一步。

## 1. 13 项声明核查

| # | 声称 | 实测 | 证据 |
|---|---|---|---|
| 1 | wake-send 补 messageMediaStore 导入 | 已落地 | `src/core/wake-send.js:37` |
| 2 | genie-tts 重复对象键 windowsHide | 已落地 | `scripts/check-scope.mjs` 0 重复键 |
| 3 | 停用出站动作括号正则 | 已落地 | `src/lib/outbound-text.js:59` 默认 false |
| 4 | 删掉 scheduleWake 的 2500ms 恒真短路 | 已落地 | `social-state.js` 只剩 `PEER_TYPING_HOLD_MAX_MS` |
| 5 | 缺 key 一律拒绝、绝不猜会话 | **语义已改** | `mcp-napcat-safe.js:764` 只接受唯一在途会话 |
| 6 | voice 空串覆盖 + base64 回退 | 已落地 | `voice.js:159-163` / `:1805` |
| 7 | [Status] / [Mid-turn] / recent 兜底 | 已落地 | `wake-send.js:562 / 590`；线上命中 8 / 62 次 |
| 8 | follow 流指数退避 | 已落地 | `dsh-client.js:376-435`，重试风暴已停（最后一次 10-30 18:55） |
| 9 | buildDynamicTurnContext 每轮注入 | 已落地 | `wake-send.js:512` |
| 10 | 回合末 collapseToSingleTurn 折叠 | **代码里不存在** | 全仓 0 定义，只有 `wake-send.js:507` 一行注释 |
| 11 | 黑话 ≥2 人共现自动提权 | 已落地 | `slang.js:425` |
| 12 | 主动发言 waiting-peer-reply 退避 | 已落地 | `social-state.js:910` |
| 13 | 并行工具调用 + 群聊自决 @/引用 | 已落地 | `agent.cordis.yml:11 / 22` |

两条偏差：

- **第 10 条是叙事**。真正让上下文不堆积的是三件事叠加：`autoReset.permanent: true`
  （不按轮数轮换）+ 空闲 30 分钟归档会话 + DSH 侧 `thresholdRatio 0.16 / retainRatio 0.02` 压缩。
  名字写进了总结，机制不存在。
- **第 5 条被后一轮主动放宽**。原规矩是缺 key 直接拒绝，现改为「问桥、只接受唯一在途会话」，
  多会话在途仍拒绝。理由是线上 5 次缺 key 全部白烧一次调用。这条需要重新确认。

## 2. 本轮体检新发现

### 2.1 群友羁绊查询从未工作（已修，dc29c86）

`memory.js` 的 `getTopSocialBonds` 调 `initChatDb()` 但没导入，ReferenceError 被
`catch { return '' }` 吞掉 → 永远返回空串。修复后现场返回：
`常互动群友: 星痕Ofter(互动11次)、马卡龙不是南梁(互动5次)、🧶(互动5次)`。

### 2.2 人格学习 142 次全失败，一次没成（上游比想象的严重）

日志：`设置会话视觉模型失败 session-6b563529…: session/model-unavailable: Select an available
model before sending a message` → `学习会话 turn 未正常完成：blocked`（`mux.js:895`）。

再往上刨一层，这**不是人格学习独有的问题**：

- `session/selectModel` 最近 7 天成功 123 次、失败 1264 次；
- 最后一次成功是 **10-30 15:48 UTC**，第一次失败是 **10-30 18:41 UTC**（正好在上一轮部署重启之后）；
- 现在每次唤醒都会重试两次，仅最近 30 分钟就 88 条失败日志。

老会话因为早就绑好模型，照常收发，所以这个问题在群里看不出来；**新建会话拿不到模型**，
只有人格学习这种「必须新建会话且失败即整轮失败」的路径被当场打死。

另有 8 条 `resume failed … stored session is corrupt`（`session-7b6eed9a` 的 v4 日志损坏）。

所以 P0-1 的顺序要改：先修 `selectModel` 为什么拿不到可用模型，再谈人格学习。

**07:29 UTC 复查（排查到一半，结论又变了）**：直接打 DSH 的 `session/selectModel` 接口，
同一个会话、同一个 `deepseek-flash`、同样的 `reasoningEffort: off`，**返回 ok**。
也就是说模型目录是「一度为空、后来自己恢复了」，不是模型名写错：

- 失败的 1252 次全部落在 10-30 18:41 → 10-31 07:29 这个窗口内；
- 07:29:33 之后不再有新失败；
- 过程中 `deepseek-v4-flash` 明确不可用，`deepseek-flash` 与 `deepseek-v4-pro` 可用
  （我们配置里的 `deepseek-flash` 本来就是对的，我一度改成 `deepseek-v4-flash` 是错的，已原样还原，
  `config.json` 与备份语义完全一致）。

留下来的真问题不是「选哪个模型」，而是**这一层没有任何健康检查与告警**：目录空了 13 小时没人知道，
桥每次唤醒还照打两遍日志（7 天 1264 条），人格学习因此空转一整天。
P0 应该加的是：`selectModel` 失败后指数退避 + 一次性告警，而不是每次唤醒重试两次。

**根因（07:34 UTC 定位并修复，55daeec）**：`dsh-session.js` 用 `??` 取模型名，而
`dsh.visionModel` 是空字符串（"留空"这种常见写法），于是 `rawModel` 得到 `''`，
再掉进硬编码兜底 `deepseek-v4-flash-vision-exp` —— 那个实验模型已经在服务商目录里下架。
现场两条命令就能证明：同一会话同一档位，`model=deepseek-v4-flash-vision-exp` → unavailable，
`model=deepseek-flash` → ok。

改成 `||` 链（空字符串视同没配，回落到主模型 `dsh.model`）后：`已设置会话视觉模型 … -> deepseek-official/deepseek-flash (off)`。

还有第二层：那个学习会话本身已经卡死（旧会话 `session-6b563529` 每次都秒 blocked），
删掉 `state/persona-agent.json` 重建后，人格学习正常跑完：
`人格学习结果经工具落库 2709998617 …` / `自动间隔学习完成：1 个目标（成功 1）`。

**这条写进 P0 的运维步骤**：模型配置类故障修复后，必须重建对应的学习会话，
否则会话级的 blocked 状态会一直粘着。

### 2.3 记忆自动写入等于没写

- 回放最近 600 条真实入站消息跑 `extractAndRememberMicroFact`：命中 1 条（0.17%），
  且是私聊那句「下周一和三要考试了」。
- `memory_entries` 92 条，最后写入是 30 小时前；分类 persona 45 / qzone_post 28 / note 12 /
  rule 4 / fact 2 / lesson 1。
- 现有提取器要求「我 + 偏好/事实模板」，群里绝大多数句子不带主语，直接漏光。

### 2.4 数据基线（7 天）

| 指标 | 数值 |
|---|---|
| 请求数 | 15754 |
| 平均上下文 | 76529 token（10-28 峰值 97735） |
| 缓存命中率 | 95.4% |
| 输出 token | 195.2 万 |
| 群消息 in/out | 谬友圈 2298/389，谬儿园 276/77，落木 264/**0** |
| 私聊 in/out | owner 455/**1090**，3619804038 35/73 |
| 工具调用 | `qq_send_message` 279、`qq_get_recent_messages` 260、`qq_load_persona` 154、`qq_memory_search` **10** |

两条结论：钱不是问题（95.4% 命中），**上下文长度和「记忆查不到」才是**；
指望模型自己想起调 `qq_memory_search`（0.5%）这条路，数据上已经证伪。

## 3. 对标结论

源码级核对 MaiBot / AstrBot / LangBot / Pallas-Bot / NoneBot2 / chatgpt-on-wechat 之后，
真正值得抄的三件，以及三条不成立的对标：

**值得抄**

1. **闭环配额**：`target = 群频率 × 期望回复数`，窗口内实际回复超出就收紧保留比例，
   反馈只收紧不放宽。我们的 `speech-gate.js` 有那 8 个特征的 logit、有配额和 20s 保险丝，
   但配额是硬上限，说多了不收紧、说少了不放开。
2. **空闲退避**：连续 no_action 后 `base × 2^n`（15s→300s），待处理 ≥6 条立即打断。
3. **虚拟轮次合批**：40s 内到达的消息只计一次期望回复，减少「每条都掷骰子」。

**不成立**（子代理只看了我们的 README）

- 「我们没有 logit / 没有防复读」是错的：`speech-gate.js:41-50` 就是那套权重（两处符号故意改过），
  防复读有 `loop-guard.js` 与 90s 近重复。
- 记忆检索的 RRF k=60 我们已经是这个值，不需要换。
- 图数据库（Graphiti / HippoRAG）的收益证据全来自多跳 QA，几十会话规模不值。

**反模式**（研究结论，采纳）

- 不要实时 embedding：bge-m3 在本机实测 987ms/条，只能离线批处理。现有 bge-small-zh 512d 保留。
- 不要全量 rerank：0.6B cross-encoder 在 CPU 上是数十秒级。
- 不要每轮跑 Mem0 式 ADD/UPDATE/DELETE：多一次 LLM 调用且错误合并不可逆。
- 不要先微调：先做检索式人格 + 记忆生命周期。

## 4. 计划

### P0 止血（先做，独立部署）

1. **人格学习能跑完**：`dsh-session.js` 遇 `model-unavailable` 时不把会话留在无模型状态，
   回落到「不指定 provider/model」让 DSH 用默认；`mux.js` 把 blocked 原因带进日志。
   验收：连续 3 次出现「人格学习完成」，且 `persona-metrics.jsonl` 有新样本。
2. **记忆写入通道**：把「正则 + 必须带我」换成回合末异步抽 1-5 条原子事实（事件计数触发，
   参考 DSH 自己 memory 插件的 `extractInterval: 40`），写库前 hash 去重。
   验收：24 小时新增 ≥20 条 fact/plan/identity，抽样人工看准确率 ≥80%。
3. **记忆检索改为桥侧触发**：识别到「上次/以前/你记得/昨天说过」这类问法就直接检索并注入正文，
   不依赖模型调工具。验收：问「我上次说的那个」时，唤醒正文里出现检索到的原文。

### P1 拟人闭环

4. 闭环配额（分位数阈值 + 反馈只收紧，`speech-gate.js`）。
5. 空闲退避（`social-state.js` 的 proactiveCheck / replyCheck 两处 dispatch）。
6. 虚拟轮次合批 15-25s（高频时段开启）。
7. 回复前置必填 `reply_reference`（先落事实再开口）。
验收：连发 3 条以上的时段占比下降，被 @ 的响应延迟不升。

### P2 记忆

8. 生命周期：decay / prune 0.1 / revive 0.15 / 命中加权 0.05。
9. 写入合并：hash 精确去重 + 余弦 0.92 合并 + `superseded_by` 矛盾失效。
10. 纠错回滚：用户说记错了能改、能撤。
验收：旁路表跑两周，条数增速降 30% 而矛盾率不升。

### P3 成本与安全

11. 摘要常驻（保留未闭合话题）。
12. 群消息注入防御：正文一律当数据、不当指令；工具白名单收敛。
13. 发错群审计。

## 5. 待批准决策

1. 记忆抽取要不要多花一次 LLM 调用（每轮 +1 次小请求，换 24h 内 20 条真事实）？
2. 群聊也自动记，还是只记私聊与 owner？
3. 合批 15-25s 会让首响变慢，只在高频时段开是否可接受？
4. 第 5 条（缺 key 的处理）回到「一律拒绝」还是保留「唯一在途会话」？
5. LoRA / 微调：建议本版不做，先把已有的 15 个人格档与检索式人格用起来。

## 6. 覆盖对照（你列的每一项，现在在哪）

| 维度 | 现状（证据） | 计划 |
|---|---|---|
| 拟人 | 长短句自由、气泡 1-18、零动作括号；人设 15 档 | P1-7 `reply_reference` |
| 智能插话 | `speech-gate.js` 8 特征 logit + 配额 + 20s 保险丝，线上 233 次拦截 | P1-4/5/6 闭环配额、空闲退避、合批 |
| 快速响应 | 平均上下文 76529 token；命中去重后首包未单独计量 | P3-11 摘要常驻；加 TTFT 计量 |
| 省钱 | 缓存命中 95.4%，钱不是主要矛盾 | P1-6 合批、P3-11 |
| 无上下文堆积 | `permanent: true` + 空闲 30 分钟归档 + DSH 16% 压缩（无 `collapseToSingleTurn`） | P2-8 生命周期；P3-11 |
| 记忆落地 | 92 条 / 30 小时零写入；micro-fact 600 条命中 1 条 | P0-2 写入通道 |
| 按需检索 | `qq_memory_search` 1999 次里只 10 次（0.5%） | P0-3 桥侧触发 |
| 人格学习 | 142 次全失败（`model-unavailable` → blocked），15 档画像停在 10-30 | P0-1 |
| 黑话学习 | 夜间学习 10-30 16:02 成功（新增 12）；≥2 人共现提权已实现，线上 0 次 | P2 保持，先观察 |
| RAG / Embedding | bge-small-zh 512d + FTS5 RRF(k=60)，参数已对齐业界默认 | 不换模型（bge-m3 实测 987ms/条） |
| LoRA | 未做 | **不做**：CPU 不可训练，先检索式人格 |
| 网络搜索 | `web-search-safe` 存在，7 天 4 次调用 | P3 与记忆检索同一条触发链 |
| 提示词 | 全小写 snake_case 正向短语、无对话示例、人设不入系统提示词 | 维持 |
| MCP 扩展 | napcat-safe 层 + 预设裁剪 | P3-12 白名单收敛 |
| 系统安全 | 缺 key 门禁、发错群审计缺 | P0-4（待定）、P3-12/13 |

## 7. 待确认的一个现象

`group:1072393236`（落木）7 天 264 条入站、0 条出站。状态是 `diving` + `probability 0.15`，
但 `wakeCount: 0`、`answeredMessageIds` 有 192 条 —— 更像「只读不回」而不是概率分支没跑。
按 0.15 算 264 条应触发约 40 次，所以要么这个群本来就设成只回应点名，要么唤醒路径有断点。
**我还没下结论**，需要你确认这个群的预期行为。

