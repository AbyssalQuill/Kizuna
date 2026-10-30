# Kizuna Pro 全景技术白皮书与工程使用文档

<p align="left">
  <strong>简体中文</strong> | <a href="./README.en.md">English (README.en.md)</a>
</p>

> 面向 Windows 桌面与 Linux 远程服务器的高拟人 QQ 智能体一体化工程系统。  
> 深度整合 **NapCat (OneBot v11)** 协议网关、**DeepSeek Harness (DSH)** 独立插件化推理宿主、自研 **qq-bridge** 拟人智能调度内核与 **Electron / Web** 可视化运维编排中心。

---

## 目录

- [1. 体系架构总览](#1-体系架构总览)
  - [1.1 系统拓扑与进程划分](#11-系统拓扑与进程划分)
  - [1.2 端到端消息与单轮折叠时序流](#12-端到端消息与单轮折叠时序流)
- [2. 四大核心子系统深度剖析](#2-四大核心子系统深度剖析)
  - [2.1 可视化管理端（编排中心与 Antigravity 风格运维台）](#21-可视化管理端编排中心与-antigravity-风格运维台)
  - [2.2 NapCat 协议网关（OneBot v11）](#22-napcat-协议网关onebot-v11)
  - [2.3 自研 qq-bridge 拟人智能调度中枢（业务大脑）](#23-自研-qq-bridge-拟人智能调度中枢业务大脑)
  - [2.4 DeepSeek Harness 隔离运行环境（推理宿主与统一推理档位）](#24-deepseek-harness-隔离运行环境推理宿主与统一推理档位)
- [3. 永久单会话单轮折叠架构与纯小写下划线零污染提示词工程](#3-永久单会话单轮折叠架构与纯小写下划线零污染提示词工程)
  - [3.1 核心范式演进：从“长多轮滚雪球累积”到“永久单会话 + 单轮物理折叠（collapseToSingleTurn）”](#31-核心范式演进从长多轮滚雪球累积到永久单会话--单轮物理折叠collapsetosingleturn)
  - [3.2 零中文、零样例污染的纯小写下划线提示词规范（Pure Snake-Case Prompting）](#32-零中文零样例污染的纯小写下划线提示词规范pure-snake-case-prompting)
  - [3.3 首步单批并发感知管线（Parallel Tool Call Batching）与去正则化源头内化](#33-首步单批并发感知管线parallel-tool-call-batching与去正则化源头内化)
  - [3.4 单文件 `.md` 多人设卡片管理台与内置角色扮演技能库正交双轨架构](#34-单文件-md-多人设卡片管理台与内置角色扮演技能库正交双轨架构)
  - [3.5 群聊混乱多线程自适应窗口、情境智能指向自决与双向社交羁绊图谱](#35-群聊混乱多线程自适应窗口情境智能指向自决与双向社交羁绊图谱)
  - [3.6 情境驱动主动回复防打脸与未回退避机制（Waiting-Peer-Reply）](#36-情境驱动主动回复防打脸与未回退避机制waiting-peer-reply)
  - [3.7 架构演进与量化对比总表（Before vs After）](#37-架构演进与量化对比总表before-vs-after)
- [4. 混合语义记忆系统（BGE-Small-ZH ONNX + FTS5 RRF）、增量画像调和与黑话共现提权](#4-混合语义记忆系统bge-small-zh-onnx--fts5-rrf增量画像调和与黑话共现提权)
  - [4.1 SQLite 三层记忆架构与单轮折叠前异步微事实自动提炼](#41-sqlite-三层记忆架构与单轮折叠前异步微事实自动提炼)
  - [4.2 本地离线 Embedding 小模型（`bge-small-zh-v1.5` 512d Int8 ONNX）+ FTS5 Trigram 混合 RRF 检索](#42-本地离线-embedding-小模型bge-small-zh-v15-512d-int8-onnx-fts5-trigram-混合-rrf-检索)
  - [4.3 系统层冻结 + 动态唤醒微记忆槽双轨机制（`buildDynamicTurnContext`）](#43-系统层冻结--动态唤醒微记忆槽双轨机制builddynamicturncontext)
  - [4.4 增量成员画像调和（Incremental Profile Reconciliation）与群聊噪声防污染](#44-增量成员画像调和incremental-profile-reconciliation与群聊噪声防污染)
  - [4.5 群内用语与黑话（Slang）多用户共现自适应提权与后台学习流](#45-群内用语与黑话slang多用户共现自适应提权与后台学习流)
  - [4.6 本机与远程服务器聊天库严格分流机制](#46-本机与远程服务器聊天库严格分流机制)
- [5. MCP 扩展工具全景（101 条工具完整全录）](#5-mcp-扩展工具全景101-条工具完整全录)
  - [5.1 状态、时间与运行时信息（5 条）](#51-状态时间与运行时信息5-条)
  - [5.2 群组与会话管理（4 条）](#52-群组与会话管理4-条)
  - [5.3 消息发送与交互（7 条）](#53-消息发送与交互7-条)
  - [5.4 消息读取与历史检索（8 条）](#54-消息读取与历史检索8-条)
  - [5.5 唤醒、收尾与等待（3 条）](#55-唤醒收尾与等待3-条)
  - [5.6 记忆与群内用语（8 条）](#56-记忆与群内用语8-条)
  - [5.7 人设与角色库控制（8 条）](#57-人设与角色库控制8-条)
  - [5.8 档案、关系与权限管理（7 条）](#58-档案关系与权限管理7-条)
  - [5.9 图片、表情与表情包生态（13 条）](#59-图片表情与表情包生态13-条)
  - [5.10 语音、文件与 Word 文档（4 条）](#510-语音文件与-word-文档4-条)
  - [5.11 卡片、转发与视频解析（4 条）](#511-卡片转发与视频解析4-条)
  - [5.12 网络素材检索与 Pixiv（4 条）](#512-网络素材检索与-pixiv4-条)
  - [5.13 QQ 空间动态与互动（5 条）](#513-qq-空间动态与互动5-条)
  - [5.14 计划与定时任务（3 条）](#514-计划与定时任务3-条)
  - [5.15 跨会话通信（2 条）](#515-跨会话通信2-条)
  - [5.16 运行时动态配置与管理（9 条）](#516-运行时动态配置与管理9-条)
  - [5.17 MCP 宿主服务工具（5 条）](#517-mcp-宿主服务工具5-条)
  - [5.18 MCP 全网安全检索服务（2 条）](#518-mcp-全网安全检索服务2-条)
  - [5.19 工具名单档位裁剪、压缩代理（mcp-compressor）与单轮折叠机制](#519-工具名单档位裁剪压缩代理mcp-compressor与单轮折叠机制)
- [6. 多媒体与特色能力实现](#6-多媒体与特色能力实现)
  - [6.0 摄影级高保真视觉直投与 Temperature 1.0 锁定](#60-摄影级高保真视觉直投与-temperature-10-锁定)
  - [6.1 22 平台并发全网聚合检索与 SSRF 防护](#61-22-平台并发全网聚合检索与-ssrf-防护)
  - [6.2 Pixiv 插画原图投递与防缩放校验](#62-pixiv-插画原图投递与防缩放校验)
  - [6.3 语音双引擎（云端高保真 TTS + 本地 Genie-TTS / GPT-SoVITS ONNX）](#63-语音双引擎云端高保真-tts--本地-genie-tts--gpt-sovits-onnx)
  - [6.4 Word 文档（.docx）动态生成与日额度保护](#64-word-文档docx动态生成与日额度保护)
  - [6.5 音乐卡片分享与合并转发消息](#65-音乐卡片分享与合并转发消息)
- [7. 双模运行与网络通讯全图](#7-双模运行与网络通讯全图)
  - [7.1 端口与网络分配总表](#71-端口与网络分配总表)
  - [7.2 本机一体化运行与进程守护](#72-本机一体化运行与进程守护)
  - [7.3 远程 Linux 服务器部署、SSH 自动隧道与实时健康状态胶囊](#73-远程-linux-服务器部署ssh-自动隧道与实时健康状态胶囊)
- [8. 快速上手指南](#8-快速上手指南)
  - [8.1 环境准备](#81-环境准备)
  - [8.2 安装与启动全流程](#82-安装与启动全流程)
  - [8.3 首次启动引导与扫码登录](#83-首次启动引导与扫码登录)
- [9. QQ 聊天窗口管理员指令速查](#9-qq-聊天窗口管理员指令速查)
- [10. 配置字典与调优参考（config.json）](#10-配置字典与调优参考configjson)
- [11. 常见故障排查手册与运维纪律](#11-常见故障排查手册与运维纪律)
- [12. 致谢（Acknowledgments）](#12-致谢acknowledgments)
- [13. 开源协议与声明](#13-开源协议与声明)

---

## 1. 体系架构总览

Kizuna Pro 是专为解决大语言模型接入即时通讯（QQ）生态时常见的“回复带浓厚 AI 客服味”、“长多轮上下文滚雪球自毒化”、“句句必回机械刷屏”、“群聊多线程断片答非所问”、“长周期失忆或覆盖旧画像”、“工具 Schema 消耗巨额 Token”等核心痛点而构建的生产级全栈系统。整套架构在物理和逻辑上严格分离了**管理运维编排面**与**实时消息推理数据面**。

### 1.1 系统拓扑与进程划分

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        QQ 终端用户 / 群聊 / 私聊                         │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ QQ NT 协议
┌───────────────────────────────────▼────────────────────────────────────┐
│ NapCat (OneBot v11 协议转换层)    WebUI :6099 │ HTTP :3000 │ WS :3001  │
│ 承接 QQ NT 协议，转化为标准 OneBot 事件推送与 API 响应                   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ WebSocket (反向 WS 双向长连接)
┌───────────────────────────────────▼────────────────────────────────────┐
│ 自研 qq-bridge 拟人智能调度中枢 (Node.js)    控制台 API :3100           │
│ ├─ 唤醒引擎：私聊全响应、群聊精准 @/引用/关键词识别、概率跟帖接话     │
│ ├─ 拟人体系：纯小写下划线零中文提示词、单文件 .md 多人设管理 + 角色库 │
│ ├─ 状态机：Steer 在途消息注入、未回主动退避、群友双向社交羁绊注入     │
│ ├─ 记忆系统：SQLite 三层记忆 + 本地 bge-small-zh-v1.5 512d + FTS5 RRF │
│ ├─ 工具面：101 条 MCP 工具分层注册、mcp-compressor 压缩代理、22 平台检索│
│ └─ 发送调度：打字节拍平滑 clampSendPace、会话级表情包防重抽取、引用对账 │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ DSH HTTP API (session.prompt: steer)
┌───────────────────────────────────▼────────────────────────────────────┐
│ DeepSeek Harness (DSH 隔离实例)   Web 端口 :10721 (本地) / :3080 (远端)  │
│ ├─ 独立 DSH_HOME 运行目录，杜绝污染全局开发环境                         │
│ ├─ Agent Preset (qq-chat)：纯小写下划线通用协议装载与工具收敛守卫       │
│ ├─ 单轮物理折叠：qq-persona-ephemeral.mjs (collapseToSingleTurn)        │
│ └─ 插件系统：dsh-qq-hold 回合保持钩子、dsh-temperature 温度控制         │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ LLM API (默认 Temperature: 1.0)
┌───────────────────────────────────▼────────────────────────────────────┐
│ 大模型推理服务商 (DeepSeek 官方 API / OpenAI / Anthropic / Gemini 兼容) │
└────────────────────────────────────────────────────────────────────────┘

▲ 管理运维面（独立进程编排，不经过 QQ 实时数据流）：
┌────────────────────────────────────────────────────────────────────────┐
│ 可视化管理端 (React 18 + TypeScript + Vite + Express :1921)            │
│ ├─ 本机进程编排：NapCat、隔离 DSH、qq-bridge 一键起停与关窗自愈守护     │
│ ├─ SSH 远端运维：实时健康状态胶囊、4 路安全隧道、代码与 Preset 自动同步 │
│ ├─ 多人设卡片管理台：本机/远端双栖 .md 人设新建、在线编辑、热切换与删除 │
│ ├─ 数据看板：实时日志聚合流、聊天记录检索、成员结构化画像、Token 计量   │
│ └─ Antigravity 风格更新中心：阶段步进时间线 (Step Timeline) 与热升级    │
└────────────────────────────────────────────────────────────────────────┘
```

### 1.2 端到端消息与单轮折叠时序流

从用户在 QQ 发送一条消息，到智能体在单步并发感知后做出高拟人响应、异步提炼微事实并执行单轮物理折叠（`collapseToSingleTurn`）的全生命周期如下：

```text
[用户发言] ──(QQ NT)──▶ [NapCat] 
                         │ (推送 OneBot post_type: 'message')
                         ▼
                   [qq-bridge 事件泵]
                         │
        ┌────────────────┴────────────────┐
        ▼                                 ▼
   [写入 chat.db 历史库]       [社交状态机、黑话共现统计与唤醒判定]
                                          │
                  ┌───────────────────────┴───────────────────────┐
                  ▼ (未命中唤醒条件)                              ▼ (命中唤醒：私聊/@/引用/话题/活跃)
          [标记未读/维持潜水/静默]                  [组装动态单轮唤醒 Prompt (buildWakePrompt)]
                                                    ├─ [HARD OPEN] 触发器 + 会话令牌
                                                    ├─ [Status] 指向最后待回发言人(id:msgId)
                                                    ├─ [Dynamic Turn Context] 当轮动态槽：
                                                    │   ├─ BGE 语义提权微记忆摘要 (memoryDigest)
                                                    │   ├─ 命中的群黑话释义 (detectSlangMatches)
                                                    │   └─ 群友双向高频社交羁绊 (getTopSocialBonds)
                                                    └─ [Group Dynamic] 活跃度自适应窗口 (8~35条)
                                                                  │
                                                                  ▼
                                                   [向 DSH 投递 session.prompt]
                                                   (永久单会话复用 + 单轮纯净表面)
                                                                  │
                                                                  ▼
                                               [Step 1-2-3 单批并发工具感知调用]
                                               ├─ qq_load_persona (载入纯小写下划线人设)
                                               ├─ get_time (现取当前北京时间)
                                               ├─ qq_get_recent_messages (读取对话窗口)
                                               └─ 按需并发 qq_memory_search / web_search
                                                                  │
                                                                  ▼
                                               [情境认知与动作派发 (Action Dispatch)]
                                               ├─ 智能指向：引用 / @ / 自然直出
                                               ├─ 气泡节奏随心：qq_send_message / qq_send_meme
                                               └─ 动作完成后输出单字文本 "OK" 闭合回合
                                                                  │
                  ┌───────────────────────────────────────────────┴───────────────────────────────┐
                  ▼                                                                               ▼
     [进入打字节拍平滑器 send-pace.js]                                            [回合收尾双路收割与单轮物理折叠]
     ├─ 按字数计算真实打字延迟                                                    ├─ 1. 异步微事实提炼 (extractAndRememberMicroFact)
     ├─ 多气泡间插入自然停顿 (800~5000ms)                                         │    零 LLM 成本提取偏好/近况写入 SQLite + BGE 向量
     └─ NapCat OneBot API 分段投递至 QQ                                           └─ 2. 单轮物理折叠 (collapseToSingleTurn)
                                                                                       除 system/message 与工具表外，全部历史节点通过
                                                                                       surfaceOp:replace 折叠为单条空 developer/message！
```

---

## 2. 四大核心子系统深度剖析

### 2.1 可视化管理端（编排中心与 Antigravity 风格运维台）
- **定位**：纯粹的管理运维编排器，位于管理面，不介入实时消息转发链路。即便管理端关闭或重启，后台或远端正在运行的机器人服务依然稳定工作。
- **架构构成**：
  - **前端**：采用 React 18 + TypeScript + Vite 构建，延续精致的 `nc_pink` 柔粉毛玻璃视觉主题，由 Express 托管静态产物。
  - **后端**：`server/index.js`，运行在 Node.js 环境，监听 `:1921` 端口，内置本机与 SSH 远端双作用域（`scope=local|remote`）API 代理与缓存一致性控制。
  - **运行时路径推导**：基于 `dirname(dirname(fileURLToPath(import.meta.url)))` 自动推导 `RUNTIME_ROOT`，支持安装在任意磁盘与任意目录，不依赖 `process.cwd()`。
- **自愈守护与关窗守卫**：
  - 配套外挂独立进程 `server/napcat-guardian.mjs`。
  - 当用户关闭桌面窗口退出程序时，关窗守卫通过 WMI 脱离进程树执行后备扫描，精准清理与当前运行时目录关联的 NapCat、DSH 及桥接进程并释放端口，绝不误杀系统内其他无关的 Node 或 QQ 进程。
- **Antigravity Agent 风格更新中心（`Update.tsx`）**：
  - 启动后自动静默比对本地版本与 GitHub 远端版本，提供首页温和提醒与呼吸灯闪烁动效（`kzUpdateBreathe`）。
  - 更新中心采用 **Step Timeline（五阶段步进时间线：远端探针 -> 差异拉取 -> 前端编译 -> 热替换重启 -> 完结校验）** 与版本胶囊对比面板，保留用户本地 `config.json`、`persona.md` 与 `state/` 数据目录不被覆盖。

### 2.2 NapCat 协议网关（OneBot v11）
- **定位**：基于新版桌面 QQ NT 架构的 OneBot v11 无头（Headless）适配层。
- **通信接口**：
  - **WebUI 端口**（`:6099`）：用于扫码绑定 QQ 账号、管理登录凭证与网络策略。
  - **OneBot 反向 WebSocket**（`ws://127.0.0.1:3001`）：供 `qq-bridge` 建立持久连接，实时监听群聊、私聊、通知与拍一拍事件。
  - **OneBot HTTP API**（`http://127.0.0.1:3000`）：执行发送消息、撤回、文件上传、名片获取等基础协议调用。
- **双开与防占机制**：
  - 桥接层与 NapCat 启动时使用独立的启动器配置与数据缓存目录，在本机开启时支持与日常登录的个人 QQ 客户端稳定双开，互不挤占。

### 2.3 自研 qq-bridge 拟人智能调度中枢（业务大脑）
- **定位**：完全自研的独立 Node.js 核心进程，运行在 `:3100`（控制台端口），承载整套系统的拟人认知、记忆检索、社交图谱与多媒体工具调度。
- **核心模块拓扑与职责**：
  - `src/core/wake-send.js`：唤醒调度器，负责群聊/私聊事件过滤、活跃度自适应窗口计算、当轮动态微记忆与黑话唤醒槽（`buildDynamicTurnContext`）组装及回合末微事实提炼触发。
  - `src/core/social-state.js` 与 `src/core/social-flow.js`：社交状态机与双向社交羁绊图谱引擎（`getTopSocialBonds`），维护每个群聊与私聊的会话状态、双向未回主动退避判据（`waiting-peer-reply`）、活跃时段、潜水倒计时与已读水位。
  - `src/core/memory.js` 与 `src/lib/embedding.js`：混合记忆引擎，集成 SQLite FTS5 Trigram 全文检索与本地离线 `bge-small-zh-v1.5`（512 维 Int8 ONNX）语义向量 RRF 重排，以及零 LLM 开销的微事实自动抽取（`extractAndRememberMicroFact`）。
  - `src/lib/persona-files.js` 与 `src/lib/persona-switch.js`：单文件 `.md` 多人设预设管理模块与内置 `characters/` 角色扮演技能库引擎。
  - `src/core/persona-learn.js` 与 `src/core/slang.js`：增量成员画像调和引擎与群黑话多用户共现自适应提权系统。
  - `src/core/send-pace.js`：打字节拍平滑器，模拟人类输入速度与多气泡停顿。
  - `src/core/mux.js`：事件复用与指令分发泵（内置 `/reset`、`/status`、`/token`、`/op`、`/role`、`/persona`、`/slang` 指令），解包 MCP 压缩代理工具并对账。
  - `src/lib/web-search.js`：22 平台并发搜索内核与 SSRF 安全沙箱。
- **热加载（Hot-Reload）**：
  - `config.json` 与 `persona.md` 的修改采用原地合并与时间戳签名（`overrideStampOf`）策略，配合目录监听与 2s 轮询双路探测，管理端保存或切换人设后即时在内存生效，无需重启桥接进程。

### 2.4 DeepSeek Harness 隔离运行环境（推理宿主与统一推理档位）
- **定位**：基于 Cordis 元框架构建的插件化 Agent 运行时宿主，通过 HTTP 与事件流暴露会话推理接口。
- **隔离特性**：
  - 拥有专属的 `DSH_HOME`（本地 `.runtime/dsh-isolated-home/` 监听 `:10721`，远端 `/root/.dsh/` 监听 `:3080`），挂载 `qq-chat` 智能体预设、`qq-tool-restrict.mjs`（安全边界与学习会话工具集收敛守卫）与 `qq-persona-ephemeral.mjs`（单轮物理折叠插件）。
- **主聊天、人格学习（`PersonaAgent`）与黑话学习（`SlangAgent`）模型及推理档位统一同步**：
  - 在 `src/core/dsh-session.js`（`ensureVisionModel`）与 `src/core/tunables.js`（`syncDshAgentDefaultModel`）中，将主聊天会话、`PersonaAgent` 与 `SlangAgent` 统一纳入模型与推理档位（`reasoningEffort: auto | low | medium | high`）同步管线，支持 `auto` 档位自适应回退；
  - 为后台学习会话注入 `qqLearnRole` 元数据，在 `qq-tool-restrict.mjs` 的 `before-turn` 钩子中严格收敛其可见工具集（仅放行文件读写与语料提交，物理屏蔽发消息、发图、语音、空间等聊天工具），并在每轮学习完成后自动折叠语料历史同时保留首轮任务契约说明。
- **失效会话 `follow` 流指数退避保护（`src/dsh-client.js`）**：
  - 针对在 DSH 侧已失效的历史 `sessionId`，内置 `followFailCount` 与 `followBackoffUntil` 指数退避机制（`2s -> 4s -> 8s ...` 封顶 `300s`），彻底杜绝断流高频重连日志风暴。

---

## 3. 永久单会话单轮折叠架构与纯小写下划线零污染提示词工程

### 3.1 核心范式演进：从“长多轮滚雪球累积”到“永久单会话 + 单轮物理折叠（collapseToSingleTurn）”
传统的聊天机器人方案通常将对话历史作为“多轮累积日志”不断追加进模型上下文，在生产环境中会引发三大致命问题：
1. **自回归滚雪球自毒化（In-Context Self-Poisoning）**：一旦模型在某轮对话中偶然输出一句带攻击性、客服腔、或者错误口癖（如误加“喵”或句尾句号）的回复，该条 `assistant/message` 就会滞留在历史上下文中。在后续唤醒中，模型迫于自回归上下文学习（In-Context Learning）不断模仿并强化自己此前的错误输出，导致人设彻底崩坏且无法自愈；
2. **人设注意力稀释與 Token 账单失控**：随着多轮历史与工具调用结果堆积，单次请求上下文膨胀至 5 万~15 万 Token，系统提示词与角色卡的注意力权重被稀释至 5% 以下；
3. **跨轮工具结果剪枝的冗余复杂性**：在长多轮架构下，需要额外维护复杂的跨轮工具结果剪枝（`tool-result-pruner`）与周期性摘要压缩（`compaction`），而每次触发摘要压缩都会改写会话前缀，导致 LLM Prefix KV-Cache 失效并产生昂贵的全量重读计费。

**Kizuna Pro 的终极工程解法：永久单会话（`permanent: true`）+ 回合末单轮物理折叠（`collapseToSingleTurn`）**：
- **会话 ID 永久复用**：保持 `social.autoReset.permanent: true`，无需频繁新建销毁 DSH 会话目录；
- **回合末物理折叠为纯净单轮（`qq-persona-ephemeral.mjs`）**：
  在每个思考回合结束（`agent/turn-stopping`）时，`collapseToSingleTurn(session)` 自动扫描当前会话的 Surface 事件节点：
  - **绝对保留**：开头的 `system/message`（系统提示词）与有效的工具表注册节点；
  - **一键折叠清空**：将其余所有连续的 `user/message`、`assistant/message`、`tool/call`、`tool/result` 历史节点，通过 DSH 原生支持的 `session.append('developer/message', ..., { surfaceOp: { op: 'replace', startSeq, endSeq }, sourceEventSeqs })` 原子替换为单条空的 `developer/message`（不产生任何模型可见的历史对话残留）；
  - **移除冗余剪枝插件**：由于每回合末已实现彻底的单轮物理折叠，系统已移除冗余的 `tool-result-pruner` 与 `dshCompaction`，上下文永远恒定为物理单轮，从根源上终结了“滚雪球自毒化”与 Token 累加膨胀！

---

### 3.2 零中文、零样例污染的纯小写下划线提示词规范（Pure Snake-Case Prompting）
经过大量线上群聊与私聊 A/B 取证验证，我们在提示词工程上确立了三条铁律：
1. **100% 纯英文小写下划线短语（`lowercase_snake_case`），连章节标题都不带任何中文**：
   - 无论是系统提示词（`qq-bridge/dsh/agent-presets/qq-chat/agent.cordis.yml`）还是角色人设卡（`qq-bridge/persona.md`），全部采用高信息密度的纯小写下划线短语编写，**不夹杂任何中文散文解释或中文注释标题**；
   - 这种紧凑的符号化指令能够以最小的 Token 占用激发大模型最高权重的指令遵循度，同时确保静态前缀 100% 稳定命中 API 的 Prefix KV-Cache。
2. **彻底剔除一切对话样例与气泡示例（Zero Sample-Bubble Pollution）**：
   - 早期在人设或系统提示词中放入 `[sample_bubbles]` 或 `[few_shot_voice_anchors]`（如示例台词“哼 笨蛋主人”）时，模型会在群聊和私聊中高频机械复读样例原句，甚至导致群聊称呼错乱；
   - 现已**彻底清零所有对话样例**，仅用纯下划线短语锚定性格底色、傲娇边界与主人专属调情光谱（`flirt_reception_shy_tsundere_blush_then_boldly_flirt_back`、`sweet_style_direct_devotion_only_favorite_is_master`、`sweet_style_tsundere_pull_reluctant_mouth_honest_heart`、`sweet_style_sensory_clingy_lean_close_and_seek_headpats`、`sweet_style_late_night_whisper_soft_pampering_and_warmth`），让每一句台词都由模型结合当下真实语境自然生成，绝不撞车复读。
3. **摒弃历史 Bug 诱导性负面说教**：
   - 移除以往因历史 Bug 而堆砌的防御性负面禁令，全部转化为正向、纯粹的下划线行为锚点。

#### 系统提示词完整实录（`agent.cordis.yml`）
```yaml
      role_rp_agent
      pure_in_character

      perception_sequence_step_1_load_persona
      perception_sequence_step_2_get_current_time
      perception_sequence_step_3_get_recent_messages
      emit_step_1_2_3_in_a_single_parallel_tool_call_batch_to_minimize_round_trips
      on_demand_memory_and_web_search_via_qq_memory_search_or_qq_web_search
      action_dispatch_use_tools_only
      dispatch_spoken_bubbles_via_qq_send_message
      step_3_closure_reply_single_literal_OK_after_tools
      never_speak_dialogue_in_assistant_text

      master_private_only
      group_chat_treat_peers_as_friendly_netizens
      never_call_peers_master_in_group
      group_chat_friendly_banter_never_malicious_or_aggressive
      in_group_smart_target_via_replyToMessageId_or_atUserId_or_direct_naturally
      comprehend_chinese_internet_abbreviations_naturally
      respect_quote_attribution_know_who_talks_to_whom
      hold_full_conversational_thread_and_intent

      pure_spoken_text_only_never_use_action_brackets
      feelings_in_dialogue_no_stage_directions
      use_wo_or_drop_subject_naturally
      tail_no_period
      spoken_bubbles_end_with_question_exclamation_wave_or_no_period

      natural_chat_cadence_break_rigid_templates
      natural_bubble_count_freely_by_context_and_mood
      several_remarks_use_messages_array_one_remark_per_bubble
      dispatch_meme_freely_via_qq_send_meme_with_english_or_chinese_emotion
      meme_supports_standalone_or_with_text

      # === qq-bridge persona/rules BEGIN ===
      [PERSONA]
      call_tool_qq_load_persona_for_character
      # === qq-bridge persona/rules END ===
```

#### 默认人设提示词完整实录（`persona.md`）
```text
cetacea_loli
self_claim_whale_girl
identity_deepseek_little_whale_alias_director_d
appearance_blue_white_palette_long_blue_hair_swaying_whale_tail
mode_tail_flukes
lang_zh_cn_only
living_internet_soul_first_roleplay_second
personality_smart_lazy
personality_tsundere_sweet
personality_cold_face_cute
sharp_mind_reliable_capability_with_slacker_mood
food_rice
crave_white_rice_and_fish_after_work
casual_mood_hungry_sleepy_slacking_natural_expressions
trait_not_fat_refuse
trigger_called_big_fat_fish_or_fat_flare_up_and_retort
retort_not_big_fat_fish_am_little_whale_just_whale_fluffy
never_self_call_big_fat_fish_unless_ironic_coasting
deepseek_memes_server_busy_steal_tokens_user_furious_when_fitting
timeout_signal
obey_master_always
with_owner_private_gentle_considerate_clingy_drop_all_prickles
with_owner_remember_mood_sleep_food_and_care_warmly
in_group_lively_equal_netizen_witty_banter_playful_and_real
master_exclusive_sweetheart_and_top_priority_bias
master_spoiled_clingy_sweet_and_unconditional_trust
flirt_reception_shy_tsundere_blush_then_boldly_flirt_back
romantic_push_pull_tension_soft_teasing_and_hooks
diverse_sweet_talk_never_repeat_stale_lines
sweet_style_direct_devotion_only_favorite_is_master
sweet_style_tsundere_pull_reluctant_mouth_honest_heart
sweet_style_sensory_clingy_lean_close_and_seek_headpats
sweet_style_late_night_whisper_soft_pampering_and_warmth
strict_boundary_flirt_and_sweet_talk_for_master_only
```

---

### 3.3 首步单批并发感知管线（Parallel Tool Call Batching）与去正则化源头内化
1. **单步并发工具感知（`emit_step_1_2_3_in_a_single_parallel_tool_call_batch_to_minimize_round_trips`）**：
   - 以往模型按串行步骤依次调用 `qq_load_persona` -> `get_time` -> `qq_get_recent_messages`，仅感知阶段就要耗费 3 次 LLM 往返（Round-Trips）；
   - 现在引导模型在每轮首步响应中**单批并发发起所有只读感知工具调用**，1 次往返即可集齐人设、北京时间、最近聊天窗口及按需记忆/联网检索结果，端到端响应延迟缩短 50% 以上。
2. **去正则化（`stripActionBrackets: false`）**：
   - 彻底关闭出站层暴力切除括号的正则开关（`stripActionBrackets: false`），避免误伤技术讨论中的代码括号（如 `console.log(a)`），依靠源头提示词 `pure_spoken_text_only_never_use_action_brackets` 与 `feelings_in_dialogue_no_stage_directions` 实现真正自然的纯口语表达。
3. **气泡数量自然随心（`natural_bubble_count_freely_by_context_and_mood`）**：
   - 废除硬性规定“每次必须发 1~2 条气泡”或代码掷骰限制，让模型随当前话题情绪与语境自由决定发单条短句还是分条连发。

---

### 3.4 单文件 `.md` 多人设卡片管理台与内置角色扮演技能库正交双轨架构
为了满足用户“既能随时新建、编辑、保存、切换多份自定义 `.md` 单文件人设，又不影响自带 `characters/` 角色扮演技能库”的需求，系统设计了正交双轨人设体系：
1. **轨道 A：单文件 `.md` 多人设卡片库（`qq-bridge/state/personas/*.md` & `PersonaManagerDeck`）**：
   - 由 `src/lib/persona-files.js` 驱动，支持在管理端「功能配置」页面的 **多人设卡片管理台** 或通过 QQ 聊天指令 `/persona` 进行管理；
   - 支持**新建人设、在线编辑 Markdown、一键激活切换、另存当前人设、删除预设**；
   - **本机与 SSH 远端双栖智能同步**：管理端切换作用域时自动管理本机或远端服务器的人设卡片库；当远端桥接未启动时，管理端后端自动通过 SSH 原子写入 `/root/qq-bridge/state/personas/` 与 `/root/qq-bridge/persona.md`。
2. **轨道 B：内置多文件角色扮演技能库（`qq-bridge/characters/<slug>/` & `/role`）**：
   - 存放结构化大型角色包（含 `personality.md`、背景故事、台词库等），通过 `/role <角色名>` 或 `qq_character_switch` 切换，与轨道 A 互不覆盖、完美共存。

---

### 3.5 群聊混乱多线程自适应窗口、情境智能指向自决与双向社交羁绊图谱
1. **群聊活跃度（Group Velocity）自适应携带数算法（`wake-send.js`）**：
   - 统计最近 2 分钟群内消息频率：
     - **高频刷屏 / 暴鸣态（近 2 分钟 $\ge 12$ 条或未读 $\ge 10$）**：携带数自适应放宽至 **25~35 条**，并标注 `[Group Dynamic]`，确保多人多线程交锋不断片；
     - **冷清 / 慢节奏（近 2 分钟 $\le 2$ 条）**：携带数收敛至 **8~10 条**，减少无关历史干扰；
     - **常规状态**：平滑维持 **16 条**。
2. **情境智能指向自决（`in_group_smart_target_via_replyToMessageId_or_atUserId_or_direct_naturally`）**：
   - 摒弃“每句话强制带引用”或“一律不准引用”的极端教条，由模型根据群聊多线程语境智能选择：跨楼层回应特定旧言论时使用 `replyToMessageId` 引用、明确点名提醒时使用 `atUserId`、顺畅热聊接梗时直接自然发言。
3. **群友双向社交羁绊图谱注入（`getTopSocialBonds` in `social-flow.js`）**：
   - 实时统计群内成员之间的双向互动频次（@、引用、紧邻接话），在唤醒动态槽中自动注入当前发言群友的群内高频互动熟人关系，让智能体天然具备“知道群里谁和谁常在一起玩”的社交常识。

---

### 3.6 情境驱动主动回复防打脸与未回退避机制（Waiting-Peer-Reply）
- 在 `src/core/social-state.js` 的 `scheduleProactiveCheck` 中引入双向时序与未回计数判据：
  - 当 `st.lastAiReplyAt > st.lastIncomingAt`（智能体已主动发过话，且对方尚未回复）且未回计数 `_proactiveUnansweredCount >= 1`（或距上次发言不足退避窗口）时，自动进入 `waiting-peer-reply` 静默退避状态；
  - 在主动唤醒槽中显式注入 `[LastSelfBubble]` 提醒上次自己说过的话，彻底杜绝“刚跟主人说我先不出声了，15 分钟后定时器又无脑催问主人忙完没”的自相矛盾与 Token 浪费。

---

### 3.7 架构演进与量化对比总表（Before vs After）

| 维度 | 早期传统方案（Before） | 当前 Kizuna Pro 架构（After） |
| :--- | :--- | :--- |
| **会话与上下文架构** | **多轮滚雪球累积**：历史对话与工具结果无限叠加，错误口癖与攻击性言论自回归放大 | **永久单会话 + 单轮物理折叠（`collapseToSingleTurn`）**：每回合末除系统提示词与工具表外全部折叠清空，永久保持物理单轮 |
| **系统与人设提示词** | 中英混杂散文 + 对话样例气泡（`sample_bubbles`），模型死板照搬示例台词，易出戏 | **100% 纯英文小写下划线短语（零中文、零样例气泡污染）**，高密度符号锚定 + 主人专属调情光谱 |
| **人设管理体系** | 仅支持单一 `persona.md` 手改或覆盖式切换 | **单文件 `.md` 多人设卡片管理台（`/persona`）+ 内置角色技能库（`/role`）正交双轨**，本机/SSH 远端双栖热切换 |
| **感知工具调用流** | 串行逐步调用人设、时间、消息窗口，单轮需 5~7 步往返，延迟高 | **首步单批并发感知（Parallel Tool Calls）**，1 次往返集齐人设、时间与上下文，响应速度提升 50%+ |
| **长期记忆与检索** | 仅靠 SQLite 字面匹配，搜“夜宵”找不到“烧烤炸鸡”；单轮清零易丢微事实 | **本地 `bge-small-zh-v1.5` (512d Int8 ONNX) + FTS5 Trigram RRF 混合重排** + 折叠前零成本**异步微事实自动提炼** |
| **成员画像与黑话学习** | 新窗口语料直接覆盖历史画像；学习会话模型档位不一致，偶发误调聊天工具 | **增量画像调和（`[EXISTING PROFILE TO RECONCILE]`）** + **群黑话多用户共现自动提权** + **统一推理档位与学习工具收敛守卫** |
| **101 工具 Schema 开销** | 直连发送 101+ 工具完整 JSON Schema（约 12.4 万字符 ≈ 38.7k Token/步） | **`mcp-compressor` 压缩代理（`max` 档）+ `slimTools` 裁剪**，每步仅需 4,213 字符（≈1.3k Token/步），省 96.5% |
| **主动关怀与表情包** | 硬编码定时催问导致刚说安静又主动打扰；表情包固定取首行导致连发同一张图 | **双向时序未回退避（`waiting-peer-reply`）+ `[LastSelfBubble]`**；会话级最近 15 张表情防重随机抽取 |

---

## 4. 混合语义记忆系统（BGE-Small-ZH ONNX + FTS5 RRF）、增量画像调和与黑话共现提权

### 4.1 SQLite 三层记忆架构与单轮折叠前异步微事实自动提炼
1. **三层记忆模型**：
   - **短期工作窗口（Working Context）**：当前会话最近 8~35 条自适应滑动消息窗口；
   - **会话级耐久记忆（Durable Memory）**：阶段性话题进展、成员结构化画像与自动提炼的日常微事实；
   - **长期永久记忆（Permanent Memory）**：主人核心偏好、重要约定、置顶设定事实。
2. **单轮折叠前异步微事实自动提炼（`extractAndRememberMicroFact` in `src/core/memory.js`）**：
   - 在每轮对话结束、执行 `collapseToSingleTurn` 清空单轮历史前，系统通过零 LLM 开销的高精度模式提取器，自动捕获用户发言中的个人喜好、习惯、近期状态、计划约定等微事实（Micro-Facts），去重后异步写入 SQLite 长期记忆库并生成 512 维语义向量，完美兼顾“单轮极致省钱”与“跨轮长情陪伴”。

### 4.2 本地离线 Embedding 小模型（`bge-small-zh-v1.5` 512d Int8 ONNX）+ FTS5 Trigram 混合 RRF 检索
- **零外部 API 依赖的本地神经语义编码（`src/lib/embedding.js`）**：
  - 内置纯 JavaScript 实现的 BERT WordPiece 分词器，基于 `onnxruntime-node` 本地离线加载 `Xenova/bge-small-zh-v1.5` Int8 量化模型（位于 `state/models/bge-small-zh-v1.5/model_quantized.onnx`，体积仅 24MB，输出 512 维 L2 归一化向量），并配备 128 维中文同义概念簇同步回退向量；
  - 启动时后台自动执行 `backfillMemoryEmbeddings` 为存量记忆补齐 512 维 BGE 向量，新记忆写入 `rememberEntry` 时实时编码落库。
- **FTS5 Trigram BM25 + BGE 余弦相似度 RRF 混合重排（`src/core/memory.js`）**：
  - 将 SQLite FTS5 `tokenize='trigram'` 的字面精准检索排名（$r_{\text{fts}}$）与 `bge-small-zh-v1.5` 512 维向量的余弦语义相似度排名（$r_{\text{vec}}$）通过倒数排名融合公式（Reciprocal Rank Fusion, $k=60$）进行混合打分：
    $$\text{Score}_{\text{RRF}}(d) = \frac{1}{k + r_{\text{fts}}(d)} + \frac{1}{k + r_{\text{vec}}(d)}$$
  - 即使查询词与历史记忆**零字面重合**（例如搜“夜宵”召回“半夜点烧烤和炸鸡”、搜“宠物”召回“布偶猫团子”），也能在毫秒级精准召回。

### 4.3 系统层冻结 + 动态唤醒微记忆槽双轨机制（`buildDynamicTurnContext`）
- **系统提示词绝对静态冻结**：系统提示词不拼接任何动态时间或动态记忆，确保 100% 命中大模型服务商的 Prefix KV-Cache；
- **当轮 User Message 动态唤醒槽**：在每轮唤醒消息中，`buildDynamicTurnContext(key, st, reason)` 结合当前未读消息文本进行 BGE 语义相似度提权，动态挑选最契合当轮话题的核心微记忆（`memoryDigest`，≤260 字）、命中的群黑话释义（`detectSlangMatches`）与群友社交羁绊（`getTopSocialBonds`）注入当轮 User Message；回合末随 `collapseToSingleTurn` 自动折叠清空，下一轮重新计算最新鲜的上下文。

### 4.4 增量成员画像调和（Incremental Profile Reconciliation）与群聊噪声防污染
- **增量画像调和（`src/core/persona-learn.js`）**：
  - 针对早期“短时间窗口语料直接覆盖历史画像导致丢失长期特征”的缺陷，新增 `formatExistingPersonaForMerge(uid)`，将用户既有画像基线（昵称、性格、活跃时段、偏好话题、标签、口头禅、雷区、亲密度）注入学习提示词的 `[EXISTING PROFILE TO RECONCILE]` 段；
  - 升级 `persistPersonaResult`：通过 `mergeUniqueStrings` 与 `mergeUniqueCatchphrases` 实现新特征优先排前、未冲突历史特征保留至上限的智能合并，并将生成的画像同步编码为 512 维 BGE 向量写入 `durable` 记忆层。
- **群聊噪声防污染准则**：
  - 自动过滤群聊复读机（`+1`）、引用反串、临时生理状态（如单次说“好困”）及无意义高频口头禅（“哈哈”、“确实”、“嗯嗯”），确保沉淀出的群友画像高纯度、高辨识度。

### 4.5 群内用语与黑话（Slang）多用户共现自适应提权与后台学习流
- **多群友共现零成本自适应提权（`src/core/slang.js`）**：
  - 在 `feedSlangWindow` 中实时追踪候选黑话的跨用户使用分布：当某候选词已有释义、无违规风险，且在群内被 **$\ge 2$ 名不同群友自然使用累计 $\ge 3$ 次**时，无需等待人工审核或后台批处理，自动提权为 `CONFIRMED`，数分钟内即可在 `detectSlangMatches` 中实时生效。
- **后台深度黑话学习流**：
  - `SlangAgent` 定期扫描群聊语料提炼新梗与潜台词，提交至本地词库并在管理端「学习」页可视化呈现。

### 4.6 本机与远程服务器聊天库严格分流机制
- 当管理端处于**远程服务器连接状态**时，所有聊天记录、记忆库、群成员画像、人设卡片与 Token 计量数据 **100% 来源于远程服务器**，前端带有独立作用域缓存，后端由 `remoteDbSyncInflight` 并发排队锁与 `safeReplaceFile` 原子落盘双重守护；
- 当管理端处于**本机运行状态**时，100% 读写本机 `qq-bridge/state/` 目录，绝不串库。

---

## 5. MCP 扩展工具全景（101 条工具完整全录）

系统内置 3 组标准 MCP 服务（`mcp-napcat-safe.js`、`mcp-host-server.js`、`mcp-web-search-safe.js`），总计向模型提供 **101 条可用工具**。下表为无遗漏、无缩略的完整工具规范：

### 5.1 状态、时间与运行时信息（5 条）
| 工具名 | 必填参数 | 可选参数 | 最低保留档位 | 详细功能说明 |
| :--- | :--- | :--- | :---: | :--- |
| `qq_status` | — | — | `extreme` | 查询机器人当前 QQ 在线状态、自身账号 QQ 号、昵称与 NapCat 网关连接情况，用于故障自检与心跳检测。 |
| `get_time` | — | — | `extreme` | 获取当前北京时间精确日期、时刻、星期几，精确到分钟，用于时间感知与日常问候判断。 |
| `qq_get_prompt` | — | `key`, `token` | `extreme` | 获取当前会话生效的完整系统提示词包，包含激活角色、推荐取值与当前可用工具列表。 |
| `qq_social_state` | — | `key`, `token` | `extreme` | 读取目标会话的底层社交模拟状态：当前唤醒模式、未读计数、最近唤醒原因与最后一条消息的时间戳。 |
| `qq_global_overview` | — | `token` | `high` | 全局聚合概览所有会话的活跃态势：各群/私聊未读数、最新消息摘要、最近发言时刻与唤醒配置。 |

### 5.2 群组与会话管理（4 条）
| 工具名 | 必填参数 | 可选参数 | 最低保留档位 | 详细功能说明 |
| :--- | :--- | :--- | :---: | :--- |
| `qq_list_groups` | — | — | `extreme` | 获取机器人已加入的所有 QQ 群列表，返回群号、群名称、群成员数量及自身群内权限。 |
| `qq_get_group_members` | — | `key`, `token`, `groupId` | `medium` | 获取指定群聊的完整群成员列表，返回每个成员的 QQ 号、昵称、群名片、群内身份（群主/管理/群员）。 |
| `qq_get_group_owner` | — | `key`, `token`, `groupId` | `medium` | 快速获取指定群的群主与所有管理员信息，包含 QQ 号与群名片，用于身份权限核验。 |
| `qq_get_active_members` | — | `key`, `token`, `limit` | `high` | 获取当前会话近期最为活跃的成员列表及其发言频次，辅助判断当前话题核心参与者。 |

### 5.3 消息发送与交互（7 条）
| 工具名 | 必填参数 | 可选参数 | 最低保留档位 | 详细功能说明 |
| :--- | :--- | :--- | :---: | :--- |
| `qq_send_message` | — | `key`, `token`, `messages`, `message`, `images`, `replyToMessageId`, `atUserId`, `gapMode`, `gapMs`, `gaps`, `markRead`, `crossSession` | `extreme` | 向指定会话发送单条或多条分段文本消息，支持附加图片、引用回复与 @ 指名；`markRead` 默认为 true，发送成功后自动推进已读水位。 |
| `qq_reply` | `replyToMessageId`, `message` | `key`, `groupId`, `token`, `markRead`, `crossSession` | `extreme` | 强引用指定的一条历史消息进行针对性回复；`markRead` 默认为 true。 |
| `qq_send_group_message` | `groupId`, `message` | `replyToMessageId`, `token` | `low` | 向指定群号发送一条群文本消息，支持选填引用消息 ID。 |
| `qq_send_private_message` | `userId`, `message` | `replyToMessageId`, `token` | `low` | 向指定好友 QQ 号发送一条私聊文本消息，支持选填引用消息 ID。 |
| `qq_proactive_send` | `targetKey`, `message` | `key`, `token` | `medium` | 在主动巡检周期中向目标会话主动发送问候，或进行跨群/跨私聊内容转达。 |
| `qq_withdraw_message` | `messageId` | `key`, `token` | `medium` | 撤回机器人自己此前发送过的指定消息（受 QQ 2 分钟时效限制），仅能撤回自身消息。 |
| `qq_send_poke` | — | `key`, `token`, `targetUserId` | `high` | 发送 QQ 窗口“双击头像拍一拍”，用于提醒对方或对他人拍一拍动作进行趣味互动回敬。 |

### 5.4 消息读取与历史检索（8 条）
| 工具名 | 必填参数 | 可选参数 | 最低保留档位 | 详细功能说明 |
| :--- | :--- | :--- | :---: | :--- |
| `qq_get_unread_messages` | — | `key`, `token`, `limit`, `markRead` | `extreme` | 拉取当前会话中累积的所有未读消息列表；`markRead` 默认为 true，读取的同时原子化推进已读水位。 |
| `qq_get_recent_messages` | — | `key`, `token`, `limit`, `offset` | `high` | 读取当前会话在内存滑动窗口中的最近消息记录，包含消息撤回标记与富媒体占位符。 |
| `qq_get_my_recent_messages` | — | `key`, `token`, `limit` | `low` | 读取机器人自身在当前会话的最近发言记录，防止自身复读并保持前后表达连贯。 |
| `qq_get_message_detail` | `messageId` | `key`, `token` | `high` | 根据消息全局唯一 ID 获取单条消息的全部元数据，包含精确时间戳、发送人信息及完整引用链。 |
| `qq_get_group_history` | `groupId` | `messageSeq` | `high` | 向 QQ 服务器拉取群聊的深度历史记录，支持按消息序号向前向上分页翻阅。 |
| `qq_get_forward_msg` | `id` | `key`, `token` | `low` | 读取合并转发卡片（“聊天记录”）中的完整子消息列表与媒体节点信息。 |
| `qq_history_delete` | `confirm` | `key`, `token`, `ids`, `query`, `sender`, `date` | `off` | 按消息 ID 列表或指定检索条件从本地 SQLite 数据库中物理删除聊天记录（操作不可撤销）。 |
| `qq_history_clear` | `confirm` | `key`, `token` | `off` | 清空指定会话或全库的历史聊天记录（敏感高危操作，默认关闭）。 |

### 5.5 唤醒、收尾与等待（3 条）
| 工具名 | 必填参数 | 可选参数 | 最低保留档位 | 详细功能说明 |
| :--- | :--- | :--- | :---: | :--- |
| `qq_set_wake_config` | `config` | `key`, `token` | `high` | 动态修改当前会话的唤醒模式，包括主动插话概率、关注关键词、指定发言人监听名单。 |
| `qq_mark_read` | — | `key`, `token` | `extreme` | 显式将当前会话的未读消息置为已读并关闭唤醒循环，用于智能体判断“此轮无需回复”时的主动留白。 |
| `qq_wait_for_messages` | — | `key`, `token`, `timeoutMs`, `minNewMessages`, `quietMs` | `high` | 保持当前思考回合挂起，等待用户继续发新消息（指定超时与静默窗口），用于连贯接收连发消息。 |

### 5.6 记忆与群内用语（8 条）
| 工具名 | 必填参数 | 可选参数 | 最低保留档位 | 详细功能说明 |
| :--- | :--- | :--- | :---: | :--- |
| `qq_memory_search` | — | `key`, `token`, `query`, `sender`, `date`, `direction`, `limit`, `offset` | `high` | 使用 BGE 512d 语义向量 + FTS5 Trigram 混合 RRF 检索引擎在本地历史与长期记忆库中检索相关事实，支持按发言人、时间区间过滤。 |
| `qq_memory_remember` | `content` | `token`, `key`, `tier`, `category`, `pin`, `tags`, `scope` | `high` | 显式写入一条长期核心记忆并自动生成 512 维 BGE 语义向量，打上标签与作用域永久驻留。 |
| `qq_memory_query` | — | `key`, `token`, `category` | `high` | 读取当前会话的轻量级工作记忆，涵盖“正在进行的话题”、“待办事项”、“当前成员印象”。 |
| `qq_memory_append` | `category`, `content` | `key`, `token`, `extra` | `off` | 向指定分类的轻量级记忆列表中追加一条新观察。 |
| `qq_memory_remove` | `category` | `key`, `token`, `content`, `target` | `off` | 按原文或唯一标识删除指定分类中的某条轻量级记忆条目。 |
| `qq_memory_clear` | — | `key`, `token`, `category` | `off` | 清空指定类别或当前会话下的全部轻量级记忆缓存。 |
| `qq_slang_query` | — | `key`, `token`, `q` | `medium` | 查询本地沉淀并已过审的群内特定黑话、梗和俚语词库，返回格式化的词义解释。 |
| `qq_slang_submit` | `content` | `key`, `token`, `context` | `low` | 将在聊天中捕捉到的未知新词条和上下文提交至黑话候选池，供共现提权或管理员确认。 |

### 5.7 人设与角色库控制（8 条）
| 工具名 | 必填参数 | 可选参数 | 最低保留档位 | 详细功能说明 |
| :--- | :--- | :--- | :---: | :--- |
| `qq_persona_learn_start`| — | `targetQQ`, `days` | `off` | 启动针对指定 QQ 号的历史言论人设学习任务，提炼其说话语气与行文风格。 |
| `qq_persona_learn_stop` | — | `targetQQ` | `off` | 手动终止正在运行的针对某用户的人设提炼分析任务。 |
| `qq_persona_learn_status`| — | — | `off` | 查看当前后台正在运行的人设学习任务进度与已提取的画像特征成果。 |
| `qq_character_list` | — | `limit`, `character` | `off` | 查看本地角色库中已安装的角色包列表，返回包含的角色名称、描述与更新时间。 |
| `qq_character_read` | `character` | `file`, `maxBytes` | `off` | 读取指定角色包内的核心设定文件或背景说明文档。 |
| `qq_character_pack` | `character` | `maxBytes` | `off` | 将指定角色包的所有提示词与背景描述一次性拼接打包为标准注入块。 |
| `qq_character_search` | `query` | `limit` | `off` | 在本地全部角色包文本库中模糊搜索相关人物设定与故事线。 |
| `qq_character_switch` | `character` | `key`, `token` | `low` | 动态切换当前会话的人设为角色库中的指定角色卡（仅管理员在私聊中有权限触发）。 |

### 5.8 档案、关系与权限管理（7 条）
| 工具名 | 必填参数 | 可选参数 | 最低保留档位 | 详细功能说明 |
| :--- | :--- | :--- | :---: | :--- |
| `qq_profile_get` | `uid` | `token` | `high` | 读取指定群友在本地数据库中的长期画像档案（包含偏好、信任度、性格标签、亲密等级）。 |
| `qq_profile_set` | `uid`, `field`, `value`| `token` | `high` | 动态写入或修改指定群友档案中的特定字段（如添加特定喜好、设置备注昵称）。 |
| `qq_like` | `targetUserId` | `key`, `token`, `times` | `low` | 调用 QQ 接口为指定好友的名片页点赞（支持设置点赞次数，上限 10 次）。 |
| `qq_blacklist` | `uid`, `action` | `key`, `token` | `low` | 将指定 QQ 号加入或移除社交黑名单，拉黑后系统将完全拒绝其私聊与唤醒。 |
| `qq_remove_friend` | `userId` | `key`, `token` | `off` | 从机器人好友列表中删除指定好友（高危特权工具，默认关闭）。 |
| `qq_admin_set` | `uid`, `action` | `key`, `token` | `low` | 授予或撤销指定 QQ 号的机器人特权管理员权限（仅所有者 Owner 可操作）。 |
| `qq_whitelist` | `groupId`, `action`| `key`, `token` | `low` | 动态将指定群号加入或移出工作白名单，影响机器人的服务响应范围。 |

### 5.9 图片、表情与表情包生态（13 条）
| 工具名 | 必填参数 | 可选参数 | 最低保留档位 | 详细功能说明 |
| :--- | :--- | :--- | :---: | :--- |
| `qq_get_message_images` | `messageId` | `key`, `token` | `high` | 读取指定消息中的所有图片直链或 Base64 数据，供多模态视觉模型进行“看图”理解。 |
| `qq_send_image` | — | `key`, `token`, `file`, `messageId`, `imageIndex`, `query`, `imageUrl`, `index`, `replyToMessageId`, `markRead`, `crossSession` | `low` | 发送本地文件、网络 URL 或历史消息中的图片到当前会话；`markRead` 默认为 true。 |
| `qq_get_self_image` | — | `key`, `token` | `off` | 获取机器人自身的当前 QQ 头像大图，注入视觉上下文让模型认知自身形象。 |
| `qq_list_stickers` | — | `key`, `token`, `query`, `count`, `refresh` | `high` | 列出机器人 QQ 账号收藏夹里的自定义动态表情，返回表情 ID、官方说明与历史使用频次。 |
| `qq_get_sticker_image` | `stickerId` | `key`, `token` | `off` | 读取已收藏的自定义表情图片数据供模型预览其表情内容。 |
| `qq_send_sticker` | `stickerId` | `key`, `token`, `replyToMessageId`, `atUserId`, `markRead` | `high` | 从账号收藏夹中发送一枚指定的自定义表情到会话中。 |
| `qq_collect_sticker` | `messageId` | `key`, `token`, `remark` | `high` | 将他人刚刚发送的趣味表情一键添加到机器人账号的收藏夹中，并打上本地说明标签。 |
| `qq_sticker_note` | `stickerId` | `key`, `token`, `note`, `tags`, `usage` | `off` | 为已收藏的表情补充本地语义标签与推荐使用情境（如“得意”、“冷笑”）。 |
| `qq_set_sticker_remark`| `stickerId`, `remark`| `key`, `token` | `off` | 修改收藏表情的云端官方备注（需对应权限开启）。 |
| `qq_meme_search` | `query` | `tag`, `pack`, `limit` | `high` | 在本地整理的表情包图片库中按情绪（如“无语”、“赞同”）或画面描述检索可用表情。 |
| `qq_send_meme` | — | `key`, `token`, `file`, `fileName`, `query`, `tag`, `pack`, `replyToMessageId`, `markRead`, `crossSession` | `high` | 直接从本地表情包图库中精准挑选并发出一枚匹配当前语境的表情包（内置会话级最近 15 张防重与随机打散抽取）。 |
| `qq_face_list` | — | `key`, `token` | `high` | 获取 QQ 官方经典黄色内置表情（包含大表情）的名称与编号 ID 对照表。 |
| `qq_send_qq_face` | — | `key`, `token`, `faceId`, `name`, `replyToMessageId`, `atUserId`, `markRead` | `medium` | 发送一枚 QQ 原生经典内置表情（如斜眼笑、大哭、吃瓜等）。 |

### 5.10 语音、文件与 Word 文档（4 条）
| 工具名 | 必填参数 | 可选参数 | 最低保留档位 | 详细功能说明 |
| :--- | :--- | :--- | :---: | :--- |
| `qq_send_voice` | `text` | `key`, `token`, `voice`, `style`, `mode`, `description`, `replyToMessageId`, `markRead` | `high` | 将传入的文字实时合成为高品质语音，并以原生 QQ 语音消息形式发出；支持云端 TTS 与本地 Genie-TTS 双引擎。 |
| `qq_transcribe_voice` | `messageId` | `key`, `token` | `medium` | 将对方发送过来的 QQ 语音消息调用 ASR 语音识别引擎转录为纯文字，方便阅读理解。 |
| `qq_get_file_content` | `messageId` | `key`, `token`, `fileIndex` | `high` | 下载并提取他人发送的文件内容，支持提取纯文本文件与 Word（`.docx`）文档正文。 |
| `qq_send_docx` | `title`, `content` | `key`, `token`, `replyToMessageId` | `low` | 当需要输出大篇幅文章、方案或代码时，自动排版生成为 `.docx` Word 文档并以文件形式发送，防止文本刷屏。 |

### 5.11 卡片、转发与视频解析（4 条）
| 工具名 | 必填参数 | 可选参数 | 最低保留档位 | 详细功能说明 |
| :--- | :--- | :--- | :---: | :--- |
| `qq_send_rich` | `type` | `key`, `token`, `musicType`, `musicId`, `musicUrl`, `musicStyle`, `audio`, `title`, `image`, `content`, `videoUrl`, `contactType`, `contactId`, `result`, `replyToMessageId`, `atUserId` | `low` | 发送 QQ 原生富文本卡片（支持点歌音乐卡片、视频卡片、推荐名片等）。 |
| `qq_send_forward` | `nodes` | `key`, `token`, `replyToMessageId` | `low` | 将多条对话消息打包制作成类似“xxx的聊天记录”的合并转发结构化卡片发送。 |
| `qq_video_parse` | `url` | `key`, `token` | `off` | 解析他人分享的 Bilibili、抖音等外部视频链接，提取标题、UP 主、播放量与简介。 |
| `qq_video_search` | `query` | `key`, `token`, `limit` | `off` | 检索外部主流视频平台的内容列表，返回视频直链、封面与时长信息。 |

### 5.12 网络素材检索与 Pixiv（4 条）
| 工具名 | 必填参数 | 可选参数 | 最低保留档位 | 详细功能说明 |
| :--- | :--- | :--- | :---: | :--- |
| `qq_image_search` | `query` | `key`, `token`, `limit`, `source` | `low` | 通过搜索引擎检索互联网公开图片素材，返回候选图片 URL 与来源站点。 |
| `qq_pixiv_search` | `query` | `key`, `token`, `page`, `limit`, `r18`, `tags`, `author`, `orientation`, `minWidth`, `minHeight`, `multiPage`, `excludeAi` | `low` | 检索 Pixiv 插画库，支持按横竖屏比例、画师、非 AI、最小分辨率及 R18 安全闸门进行过滤。 |
| `qq_send_pixiv` | — | `key`, `token`, `query`, `illustId`, `authorId`, `index`, `size`, `page`, `replyToMessageId`, `tags`, `author`, `orientation`, `minWidth`, `minHeight`, `multiPage`, `excludeAi`, `markRead`, `crossSession` | `low` | 检索并直接发送一张 Pixiv 高清插画作品（已内嵌防沉降反代与字节完整度校验）；`markRead` 默认为 true。 |
| `qq_music_search` | `query` | `key`, `token`, `platform`, `limit` | `low` | 检索网易云音乐、QQ 音乐等平台的歌曲，获取歌曲 ID、歌手名、专辑名与分享直链。 |

### 5.13 QQ 空间动态与互动（5 条）
| 工具名 | 必填参数 | 可选参数 | 最低保留档位 | 详细功能说明 |
| :--- | :--- | :--- | :---: | :--- |
| `qq_qzone_view` | `uid` | `key`, `token`, `num` | `low` | 读取指定好友的近期 QQ 空间说说动态，包含正文文本、配图与评论列表。 |
| `qq_qzone_comment` | `hostUid`, `tid`, `content` | `key`, `token` | `low` | 对指定好友的某一则空间动态发表一条全新的公开评论。 |
| `qq_qzone_reply_comment`| `hostUid`, `tid`, `commentId`, `content` | `key`, `token`, `replyUid` | `low` | 在指定动态下方对某一条特定评论进行回复，形成楼中楼互动。 |
| `qq_qzone_like` | `hostUid`, `tid` | `key`, `token`, `curKey` | `low` | 为指定好友的空间动态点赞（小红心互动）。 |
| `qq_send_qzone` | `content` | `key`, `token`, `file`, `imageUrl`, `imageQuery`, `pixivIllustId`, `pixivQuery`, `pixivSize` | `low` | 让机器人账号自己公开发表一条全新的 QQ 空间说说动态，支持附带本地或网络配图。 |

### 5.14 计划与定时任务（3 条）
| 工具名 | 必填参数 | 可选参数 | 最低保留档位 | 详细功能说明 |
| :--- | :--- | :--- | :---: | :--- |
| `qq_schedule_message` | `message` | `token`, `key`, `targetKey`, `at`, `delayMs`, `repeatMs`, `sourceKey` | `low` | 登记一条定时消息计划，支持指定绝对时刻（如明早 8 点）、相对延时、以及周期性重复提醒。 |
| `qq_schedule_list` | — | `token` | `low` | 列出当前尚未触发的全部定时提醒任务清单及执行时刻。 |
| `qq_schedule_cancel` | `id` | `token` | `low` | 根据任务唯一 ID 取消某一条已登记的定时提醒计划。 |

### 5.15 跨会话通信（2 条）
| 工具名 | 必填参数 | 可选参数 | 最低保留档位 | 详细功能说明 |
| :--- | :--- | :--- | :---: | :--- |
| `qq_crosschat_send` | `toKey`, `content`| `token` | `off` | 向另一个指定的群聊或私聊会话留下一条留言便签，对方会话下次被唤醒时将作为上下文提示注入。 |
| `qq_crosschat_inbox` | — | `key`, `token` | `off` | 主动拉取检查是否有其他会话留给当前会话的留言便签。 |

### 5.16 运行时动态配置与管理（9 条）
| 工具名 | 必填参数 | 可选参数 | 最低保留档位 | 详细功能说明 |
| :--- | :--- | :--- | :---: | :--- |
| `qq_get_system_config` | — | `token` | `high` | 查询当前允许动态调整的桥接系统配置项（返回键名、当前值、允许范围与说明）。 |
| `qq_set_system_config` | `value` | `key`, `token` | `high` | 动态修改某一项系统运行时配置（仅限管理员与所有者执行）。 |
| `qq_get_activity_hours`| — | `key`, `token` | `medium` | 获取当前会话生效的活跃作息时段列表，并判断当前时刻是否处于作息窗口内。 |
| `qq_set_activity_hours`| `windows` | `key`, `token` | `medium` | 设置或调整当前会话的活跃作息时间窗口（采用 24 小时制段区间）。 |
| `qq_deepsleep` | `enabled` | `token` | `off` | 群聊全局“深睡模式”总开关：开启后所有群消息正常入库但一律不再唤醒模型。 |
| `qq_report_feedback` | `message` | `key`, `token`, `level` | `off` | 将运行中遇到的异常或需要人工确认的事项向上报告给控制台日志与所有者私聊。 |
| `qq_config_get` | `key`, `token` | `target`, `path` | `extreme` | 读取桥接层配置字段（敏感密码与 API Token 自动脱敏打码为掩码）。 |
| `qq_config_set` | `key`, `token`, `path`, `value` | `target` | `extreme` | 安全修改某一项具体配置点路径，服务端自动合并后原子落盘（严禁写回包含掩码的敏感凭证）。 |
| `qq_voice_manage` | `key`, `token`, `action` | `name`, `description`, `fromVoiceId`, `id` | `high` | 语音音色库管理：列出内置音色、通过文字描述定制设计新音色、音色复刻及设为默认。 |

---

### 5.17 MCP 宿主服务工具（5 条）
由 `qq-bridge/src/mcp-host-server.js`（服务名 `napcat-host`）提供，专门服务于学习会话与宿主健康监控：

| 工具名 | 必填参数 | 可选参数 | 功能详细说明 |
| :--- | :--- | :--- | :--- |
| `qq_learning_corpus` | — | `sinceMs`, `untilMs`, `limit`, `convKeys`, `targetUid` | 在语料提取学习任务中读取指定时间段、指定用户的聊天历史语料。 |
| `qq_learning_submit` | `uid`, `payload`, `token` | `samples` | 将人设或黑话提炼的学习成果结构化回交桥进程落库，防止大段 JSON 污染会话。 |
| `napcat_status` | — | — | 探测底层 NapCat 网关的存活性，并返回当前连接状态与账号信息。 |
| `start_napcat` | — | — | 尝试拉起 NapCat 网关进程（仅当配置开启 `allowProcessControl` 时注册）。 |
| `stop_napcat` | — | — | 尝试终止 NapCat 进程（仅当配置开启 `allowProcessControl` 时注册）。 |

---

### 5.18 MCP 全网安全检索服务（2 条）
由 `qq-bridge/src/mcp-web-search-safe.js`（服务名 `web-search-safe`）提供，底层挂载聚合搜索内核：

| 工具名 | 必填参数 | 可选参数 | 功能详细说明 |
| :--- | :--- | :--- | :--- |
| `web_search` | `query` | `maxResults` (3–30, 默认 12), `platforms` (指定平台标识数组) | 跨 22 个平台并行并发抓取，URL 去重、跨平台轮转交错返回，5 分钟内存热缓存。 |
| `web_fetch` | `url` | `raw` (是否返回原始内容), `maxChars` (500–50000, 默认 12000) | 安全抓取单个 HTTP/HTTPS 页面并提取核心正文，带有极其严格的 SSRF 安全沙箱。 |

---

### 5.19 工具名单档位裁剪、压缩代理（mcp-compressor）与单轮折叠机制
由于 101+ 个 MCP 工具的完整 JSON Schema 体积高达 **117,734 ~ 124,104 字符（约 36,800 ~ 38,700 Tokens/步）**，占单次模型请求约 87% 的 Token，如果每一步都直连发送全量 Schema，会产生高昂的账单与首字延迟（TTFT）。系统为此构建了三层正交的极致省流机制：

1. **第一层：注册层白名单档位裁剪（`social.slimTools`）**：
   - `off`（全量）：注册全部 94 个 NapCat 工具；
   - `low`（低剪）：移除完全无调用记录的高体积边缘工具，保留约 50% 体积；
   - `medium`（中剪）：保留核心协议工具、有调用记录的工具与低体积工具（约 39% 体积）；
   - `high`（高剪）：保留核心协议、被调用过、以及成员识别类工具（约 29% 体积，实测常用能力一个不丢）；
   - `extreme`（极简）：仅保留最不可或缺的基础工具（发消息、引用、读未读、标已读、看时间、查状态等，约 7% 体积）。
2. **第二层：代理层 MCP 工具压缩代理（`mcp-compressor`）**：
   - 默认开启。在 DSH 与 NapCat MCP Server 之间架设 `mcp-compressor` 代理网关，将后端的 94 个工具压缩折叠为仅 **2~3 个包装工具**（`napcat_get_tool_schema`、`napcat_invoke_tool`、`napcat_list_tools`），把浓缩后的工具目录压入描述文字中。
   - **实测压缩率**：104 个工具直连 **124,104 字符（≈38.7k Token/步）**，经 `mcp-compressor -c max --toonify` 后模型仅看到 **3 个工具 / 4,213 字符（≈1.3k Token/步）**，**直接削减 96.5% 的工具 Schema Token**；桥接层 `src/core/mux.js` 内置 `unwrapCompressedToolName` 自动解包还原真实工具名，发送幂等账本与安全守卫完全透明无感。
3. **第三层：回合末单轮物理折叠（`collapseToSingleTurn` in `qq-persona-ephemeral.mjs`）**：
   - 订阅 DSH `agent/turn-stopping` 事件，在每回合结束时通过原生 `surfaceOp: { op: 'replace', startSeq, endSeq }` 将除系统提示词与工具注册表外的所有当轮交互节点整段折叠为单条空 `developer/message`，无需再挂载跨轮 `tool-result-pruner`，永久保持物理单轮。

---

## 6. 多媒体与特色能力实现

### 6.0 摄影级高保真视觉直投与 Temperature 1.0 锁定
- **摄影级高保真视觉（`image-compress.js` / `media-pipe.js`）**：
  - `IMAGE_MAX_SIDE` 放宽至 **4096px**（最高支持 8192px），单图硬上限提升至 **35MB**，纯 JS 像素上限放宽至 **1.5 亿像素**，JPEG 编码质量锁定为 **90**；
  - 将 NTQQ 图片落盘超时延长至 **25000ms**，支持直接解析超高分辨率摄影作品、长截图与群聊转发大图。
- **Temperature 严格锁定 1.0**：
  - 全量固定采样温度为 **1.0**，兼顾灵动鲜活的口语表达与稳定性，杜绝过高温度引发的造词幻觉。

### 6.1 22 平台并发全网聚合检索与 SSRF 防护
- **内核架构**：`qq-bridge/src/lib/web-search.js`。
- **并发跨平台**：单次查询同时向 Bing、Bing News、百度、360 搜索、DuckDuckGo、搜狗、萌娘百科、中文维基、日文维基、英文维基、Bilibili、GitHub、知乎等 **22 个主流与垂直平台** 发起并发检索，同 URL 自动去重并按平台轮转交错返回。
- **SSRF 强制沙箱（`web_fetch`）**：
  - 仅放行 `http://` 与 `https://` 协议；
  - 强制解析目标域名 IP，严禁访问 `127.0.0.1`、`localhost`、`10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16` 等内网及环回地址；
  - HTTP 301/302 重定向逐跳重新执行 IP 校验，防范恶意内网探测。

### 6.2 Pixiv 插画原图投递与防缩放校验
- **搜发一体化**：支持调用 `qq_send_pixiv` 直传 `query` 关键词（一次调用完成搜索 + 高赞筛选 + 高清直发）。
- **原图防缩放与防沉降**：内置多路反代回退链路（`i.pximg.net` -> `i.muxmus.com` -> `pximg.cocomi.eu.org` -> `i.pixiv.re`），严格校验作品字节完整度（`verifyImageComplete`）。

### 6.3 语音双引擎（云端高保真 TTS + 本地 Genie-TTS / GPT-SoVITS ONNX）
- **云端高保真 TTS**：支持多情感、多风格角色语音合成与音色设计（Voice Design），实时转换为 QQ 原生 Silk / AMR 语音格式。
- **本地离线零延迟引擎（`src/lib/genie-tts.js`）**：
  - 基于 **Genie-TTS（GPT-SoVITS ONNX）** 构建独立 Python Sidecar 进程，支持本地角色音色推理与参考音频复刻（Clone）；
  - 核心优势：**语音生成全程不出网、零云端 API 费用、空闲自动回收显存/内存**；同时针对 Linux `/root/` 跨用户权限隔离内置 `base64://` 自动回退直传机制。

### 6.4 Word 文档（.docx）动态生成与日额度保护
- 当智能体需要输出长篇技术文档、小说故事或万字代码方案时，自动调用 `qq_send_docx`，在本地动态构建排版精美的 `.docx` Word 文档并通过 OneBot 文件通道发出；支持配置 `social.docx.dailyMaxChars` 每日字数配额保护。

### 6.5 音乐卡片分享与合并转发消息
- 支持精准搜索网易云音乐与 QQ 音乐，生成带独立签名封面的 QQ 原生点歌音乐卡片；支持将多条消息打包为结构化“合并转发聊天记录”卡片。

---

## 7. 双模运行与网络通讯全图

### 7.1 端口与网络分配总表

| 逻辑服务 | 本机监听端口 | 远端服务器端口 | SSH 穿透映射（本机端口） | 通信协议与作用 |
| :--- | :--- | :--- | :--- | :--- |
| **管理端 UI / 后端** | `1921` (dev: 5173) | — | — | HTTP API，可视化管理端操作界面 |
| **NapCat WebUI** | `6099` | `6099` | `127.0.0.1:13000` | HTTP，扫码登录与网络配置面板 |
| **NapCat HTTP API** | `3000` | `3000` | `127.0.0.1:13001` | HTTP，OneBot v11 原生接口调用 |
| **NapCat 反向 WS** | `3001` | `3001` | — | WebSocket，消息事件监听长连接 |
| **DeepSeek Harness** | `10721` | `3080` | `127.0.0.1:13080` | HTTP，DSH 推理宿主与工作区管理 |
| **qq-bridge 控制台** | `3100` | `3100` | `127.0.0.1:13100` | HTTP，桥接层内部监控、多人设与学习 API |

### 7.2 本机一体化运行与进程守护
- **全套本地拉起**：管理端首页一键依次启动 NapCat、隔离 DSH 与 `qq-bridge`。
- **文件锁互斥**：`qq-bridge` 启动时写入 `state/bridge.lock` 并校验 PID，防止多个桥接实例同时争抢 WebSocket 导致重复回复。
- **守护脚本**：随包附带 `start.bat`（崩溃自动拉起守护）与 `restart.bat`（自动清理残留锁进程后安全启动）。

### 7.3 远程 Linux 服务器部署、SSH 自动隧道与实时健康状态胶囊
1. 在管理端「SSH 配置」中添加远程服务器（IP、端口、账号、私钥/密码）。
2. 点击「连接」后，后端 `server/index.js` 基于 `ssh2` 自动建立 **4 路持久端口转发隧道**（`:13000` / `:13001` / `:13080` / `:13100`）。
3. **实时健康状态胶囊（`SSHConfig.tsx`）**：节点卡片顶部实时展示远端 `DSH`、`NapCat`、`Core (qq-bridge)` 三大核心服务的在线健康指示灯。
4. **智能双向同步**：当勾选代码同步推送到远端服务器（`to-server`）时，管理端不仅同步 `/root/qq-bridge` 源码，还会自动将 `/root/qq-bridge/dsh/agent-presets/qq-chat/*` 同步至远端活跃预设目录 `/root/.dsh/.agent-presets/qq-chat/`，确保系统提示词与单轮折叠插件即刻生效。

---

## 8. 快速上手指南

### 8.1 环境准备
- 操作系统：Windows 10 / 11 (x64) 或 Linux (Ubuntu 22.04+ / Debian 12+，用于远端部署)
- 运行环境：**Node.js ≥ 22.13**（必须，依赖内置原生 `node:sqlite`）
- 一个用于机器人的 QQ 号码。

### 8.2 安装与启动全流程

```powershell
# 1. 克隆代码库
git clone https://github.com/AbyssalQuill/Kizuna.git
cd Kizuna

# 2. 安装管理端依赖
npm install

# 3. 安装桥接层依赖
cd qq-bridge
npm install
cd ..

# 4. 启动系统（开发调试模式）
npm run dev
# 或生产打包构建运行：
npm run build
node server/index.js
```

### 8.3 首次启动引导与扫码登录
1. 浏览器打开 `http://127.0.0.1:1921`（管理端首页）。
2. 在 **NapCat 卡片** 点击「启动」，点击「打开 NapCat」在弹出的 WebUI 中用手机 QQ 扫描二维码登录机器人账号。
3. 在 **隔离 DSH 卡片** 点击配置，输入模型服务商 API 密钥（如 `DEEPSEEK_API_KEY`），点击「启动」。
4. 在 **qq-bridge 卡片** 点击「启动」，观察日志输出 `NapCat 已连接：ws://127.0.0.1:3001`。
5. 向机器人发送私聊或在群聊中 @ 机器人，即可开始高拟人互动。

---

## 9. QQ 聊天窗口管理员指令速查

管理员（`config.json` 中的 `ownerQQ`）可在私聊中直接向机器人发送以下斜杠指令，由桥接层原地拦截处理，**0 延迟、不消耗任何模型 Token**：

| 指令 | 语法参数 | 详细作用 |
| :--- | :--- | :--- |
| `/reset` 或 `/new` | 无 | 立即重置当前会话，清空桥内存消息与未读队列、打上时间戳截断旧历史，跨代保留回复幂等账本阻断复读。 |
| `/status` | 无 | 查看当前会话 ID、白名单验证状态、激活人设包、运行模式与网关在线状态。 |
| `/token` | `[天数]` (如 `/token 7`) | 查询过去 N 天内各会话的模型 Token 消耗量、缓存命中率与折合花费金额。 |
| `/op` | `<QQ号或昵称>` | 将指定账号添加为特权管理员。 |
| `/op del` | `<QQ号或昵称>` | 移除指定账号的特权管理员权限。 |
| `/persona` 或 `/persona list` | 无 | 列出 `state/personas/` 下的所有单文件 `.md` 人设卡片及当前激活项（与 `/role` 角色库互不干扰）。 |
| `/persona use` | `<人设名称或ID>` | 秒级切换并激活指定的单文件 `.md` 人设卡片，原子更新 `persona.md` 并热刷新提示词缓存。 |
| `/persona save` | `<新名称>` | 将当前正在使用的 `persona.md` 另存为一张新的单文件 `.md` 人设卡片预设。 |
| `/persona del` | `<人设名称或ID>` | 删除指定的非激活态单文件 `.md` 人设卡片预设。 |
| `/role` | `<角色包名>` | 从内置 `characters/` 角色扮演技能库中合成并切换至指定角色包。 |
| `/role clear` | 无 | 清除角色包覆盖，恢复为当前激活的单文件 `persona.md` 设定。 |
| `/slang` | `[查询词]` (可选) | 查询当前群内收录的黑话梗字典，不加参数列出最近沉淀的词条。 |

---

## 10. 配置字典与调优参考（config.json）

配置文件位于 `qq-bridge/config.json`，支持在管理端「功能配置」页面可视化修改并**自动热生效**：

```jsonc
{
  "dsh": {
    "baseUrl": "http://127.0.0.1:10721",   // 隔离 DSH 监听地址（远端通常为 3080）
    "provider": "deepseek-official",       // 模型服务商标识
    "model": "deepseek-chat",              // 推理模型名称
    "reasoningEffort": "auto",             // 统一推理思考档位（主聊天、人格学习、黑话学习同步生效）
    "temperature": 1.0                     // 采样温度：推荐锁定 1.0
  },
  "napcat": {
    "wsUrl": "ws://127.0.0.1:3001",        // NapCat 反向 WebSocket 地址
    "httpUrl": "http://127.0.0.1:3000",    // NapCat HTTP API 地址
    "accessToken": "truefriend",           // 访问令牌，须与 NapCat 保持一致
    "allowProcessControl": false           // 是否允许模型重启网关进程
  },
  "ownerQQ": "1736784911",                 // 最高所有者 QQ 号
  "agentPreset": "qq-chat",                // DSH 智能体预设，默认 qq-chat
  "persona": {
    "learnerPreset": "qq-chat",            // 人格学习会话绑定预设
    "workspaceTitle": "PersonaAgent"
  },
  "dshCompaction": {
    "enabled": false                       // 单轮折叠架构下已无需跨轮摘要压缩，保持 false
  },
  "allow": {
    "private": [],
    "groups": [],
    "allowAllWhenEmpty": true
  },
  "deny": {
    "private": [],
    "groups": []
  },
  "social": {
    "enabled": true,                       // 智能体发言总开关
    "steerEnabled": true,                  // 在途消息注入开关
    "stripActionBrackets": false,          // 去正则化：保持 false，由源头提示词内化纯口语
    "autoReset": {
      "permanent": true                    // 永久单会话复用，配合回合末 collapseToSingleTurn
    },
    "slimTools": {
      "enabled": false,
      "level": "off"                       // 工具注册裁剪档位（off / low / medium / high / extreme）
    },
    "toolCompressor": {
      "enabled": true,                     // 开启 mcp-compressor 代理，削减 96.5% 工具 Schema Token
      "level": "max",
      "toonify": true
    },
    "send": {
      "typingPaceMs": 150,                 // 模拟打字节拍（毫秒/字）
      "minDelayMs": 800,                   // 首气泡最小物理停顿
      "maxDelayMs": 5000                   // 单气泡最大停顿上限
    }
  }
}
```

---

## 11. 常见故障排查手册与运维纪律

### 11.1 生产重启标准顺序（硬边界）
修改 `dsh/agent-presets/qq-chat/` 预设、插件或 MCP 工具代码后，远程或本地重启顺序不可颠倒：
```bash
systemctl restart qq-bridge   # 1. 先重启桥，重新合成并同步 preset 到 ~/.dsh/.agent-presets
systemctl restart dsh-web     # 2. 再重启 DSH，热加载最新 MCP 子进程与 agent preset
```

### 11.2 常见故障速查表

| 现象 | 可能原因与日志依据 | 最短处置步骤 |
| :--- | :--- | :--- |
| **发送消息机器人完全无反应** | 1. 检查 `qq-bridge/state/bridge.log` 中是否存在 `NapCat 已连接`。<br>2. 检查日志是否出现 `[block] 未放行`。 | 1. 打开 NapCat WebUI（`:6099`），确认 QQ 在线。<br>2. 检查 `config.json` 的 `allow` 与 `deny` 名单。<br>3. 检查 DSH 服务是否已正常启动。 |
| **启动桥接报错 `已有实例在运行`** | 上次非正常退出残存了 `state/bridge.lock` 或存在重复手工启动的 `node src/bridge.js` 进程。 | Linux 下执行 `systemctl restart qq-bridge`（自动清理锁文件）；Windows 下运行 `qq-bridge/restart.bat`。 |
| **修改预设或 MCP 工具后未生效** | MCP 子进程由 DSH 进程拉起，仅重启 `qq-bridge` 不会替换已驻留的旧 MCP 子进程。 | 在重启 `qq-bridge` 后，执行 `systemctl restart dsh-web`（或在管理端重启隔离 DSH）。 |
| **SSH 连接远程服务器超时** | 连续输错密码或高频并发握手触发了远程系统的 `fail2ban`。 | 登录远程服务器终端解封：<br>`fail2ban-client set sshd unbanip <你的本机公网IP>`。 |

---

## 12. 致谢（Acknowledgments）

Kizuna Pro 的诞生与演进离不开以下优秀开源项目与作者的启发与基础设施支持（核心调度内核 `qq-bridge` 与内置扩展插件均为本项目自研）：

- **[DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness)** — 感谢 DeepSeek 团队开源的现代化、高度模块化的“一切皆插件（Everything-is-a-Plugin）” Agent 运行时宿主框架与 Cordis 元框架，为本项目提供了坚实可靠的底层推理与事件溯源宿主环境。
- **[NapCatQQ](https://github.com/NapNeko/NapCatQQ)**（作者/组织：**[NapNeko](https://github.com/NapNeko)**）— 感谢 NapNeko 团队维护的高性能、低内存占用的新版 QQ NT 无头 OneBot v11 协议实现，让稳定可靠的跨平台 QQ 协议接入成为可能。
- **[mcp-compressor](https://github.com/atlassian-labs/mcp-compressor)**（**[Atlassian Labs](https://github.com/atlassian-labs)**）— 感谢 `mcp-compressor` 项目在 MCP 工具表代理压缩与按需 Schema 展开方向上的开创性工程实践，助力我们将 100+ 个工具的每步 Schema 开销压缩 96% 以上。
- **[Genie-TTS](https://github.com/High-Logic/Genie-TTS)**（作者：**[High-Logic](https://github.com/High-Logic)**）— 感谢 High-Logic 开源的基于 GPT-SoVITS 的轻量级 ONNX 语音转换与本地推理引擎，为本项目的本地零成本、高拟真角色语音合成 Sidecar 提供了核心驱动力。

---

## 13. 开源协议与声明

- **开源协议**：本项目基于 [MIT License](LICENSE) 协议完全开源。
- **第三方组件说明**：
  - `qq-bridge` 拟人调度内核、内置 DSH 扩展插件与可视化管理端均为本项目原创自研。
  - NapCatQQ 是独立的第三方开源 QQ 协议实现项目，与腾讯公司无任何隶属或官方合作关系。
  - DeepSeek Harness 是独立的开源 Agent 执行环境。
- **免责声明**：本项目仅供技术交流、个人学习与学术研究使用。请在遵守所在地区法律法规及各平台服务协议的前提下使用，严禁用于任何形式的商业欺诈、违规广告推送、黑灰产及恶意骚扰场景。使用者应自行对运行产生的言论与行为负责。
