# 学习会话复用前必须探活

## 现象
`bridge.log` 里 44 条 `人格学习任务说明注入失败 ... session "session-a8a184ff-..." not found`，人格学习全挂。

## 根因
`state/persona-agent.json` / `state/slang-session.json` 里存着会话 id，但 0.2.1 起会话按 cwd 分目录存放，旧 id 在磁盘上早没了。恢复分支直接信任持久化 id，之后每次 `sessions.prompt` 都 not found。

## 修法
`src/core/slang.js` 的 `learnSessionExistsForRestore(sessionId)`，复用前先查一次 `sessions.list`；不存在就删登记、走新建。persona-learn.js 复用同一个。

**关键约定**：探活本身失败（网络/接口异常/分页没走完）一律按「还在」处理 —— 宁可多试一次复用，也不能因为一次抖动就把登记删掉、白丢一个已经喂了大量语料的学习会话。

## 验证
```
ghost => false      // 已失效的 id
live  => true       // 存在的 id
no-api => true      // 未注入 apiRef 时保守放行
```
真实日志：`人格学习会话已失效（DSH 侧不存在），重建：session-a8a184ff-...` → `人格学习会话已创建：session-d52e9b0b-...`
