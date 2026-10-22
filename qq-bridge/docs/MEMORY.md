# Memory Index（项目工程知识）

qq-bridge 的长期工程知识。一条一行：标题 → 详情文件 + 一句话结论。
2026-10-22 建立，格式与本机 `~/.dsh/memory/MEMORY.md` 一致（索引 + 主题文件）。

**和 `state/memory.db` 的分工**：那个是**机器人跟人聊天时**的记忆（77 条 entries / 116 条 profiles，走 `qq_memory_*` 工具）；
这里是**改代码的人**要知道的事（为什么这么写、踩过什么坑、改哪儿会炸）。两者别混。

**和 `RULES.md` 的分工**：RULES 是运行时权限与安全边界（谁能干什么），这里是实现层面的来龙去脉。

## 部署与运维

- [生产部署：作用域与改动纪律](memory/kizuna-deploy-authorization.md) — 只碰 qq-chat preset / bridge 源码 / DSH 侧插件三个作用域，改动前就地备份；连接信息不入库（放本机 memory）
- [会话归档机制（DSH 会话目录）](memory/session-archive.md) — `src/core/session-archive.js`，10 分钟巡检 / 闲置 30 分钟 / 单批 20；GET+POST `/api/social/session-archive`

## DSH 适配

- [DSH 0.2.1 预设双源：改仓库源不生效](memory/dsh-021-preset-dual-source.md) — 0.2.1 只读 profile patch 里的声明行；`syncPresetDeclaration21` 已接到 installPresets 尾部，每次启动自愈
- [0.2.1 的两处不兼容：persona 改名 + `{{cwd}}` 被删](memory/dsh-021-incompat.md) — `text` → `prefix`；提示变量只剩 provider/model，留着 `{{cwd}}` 整轮直接 error

- [视觉模型 id 失效：deepseek-v4-flash-vision-exp](memory/vision-model-id-stale.md) — 0.2.1 目录里只剩 deepseek-flash / deepseek-v4-pro；每次唤醒重试 4 次刷日志，改成 deepseek-flash 即好

## 桥接内部

- [seq 重置不能把 known 归零](memory/seq-watermark-reset.md) — 归零等于拆掉去重闸门，200 条历史会被当新事件重放，副作用跟着重跑
- [学习会话复用前必须探活](memory/learner-session-probe.md) — 0.2.1 会话按 cwd 分目录，持久化 id 会失效；不探活就是每次 prompt 都 not found
- [日志双写：log.js 与 systemd 抢同一个文件](memory/log-double-write.md) — 每行落盘两次；改 `StandardOutput=journal` 解决
- [重置会话前要清定时器](memory/reset-timer-leak.md) — proactive 回调闭包持有旧 st，删 map 不等于取消 timer

## 省额度

- [mark_read 占了 65% 的工具调用](memory/mark-read-cost.md) — 发送已自动推进已读水位，发完再单独标读是纯浪费；提示词第 69 行曾与此矛盾，2026-10-22 已统一
- [上下文成本在重发，不在单步大小](memory/context-cost-model.md) — cacheRead 占 97.2%，每步均值 85k token，所以少一步 > 压缩单步

## 历史坑

- [配置写入与并发的历史问题](memory/config-write-races.md) — 多进程同时改 config.json / social-state.json 时的原子写与锁
