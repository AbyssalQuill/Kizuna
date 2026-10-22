# 会话归档机制（DSH 会话目录）

## 是什么
`src/core/session-archive.js` 定时把「空闲」的 DSH 会话目录归档，防止 `~/.dsh/sessions` 无限膨胀。

## 配置（config.json → social.sessionArchive，线上实际值）
```json
{ "enabled": true, "intervalMs": 600000, "idleMinutes": 30, "batchMax": 20, "pruneDays": 0 }
```
- `pruneDays: 0` = 归档目录不清理
- 关闭时启动日志会打「空闲会话自动归档已关闭（social.sessionArchive.enabled=false）」

## 怎么确认在跑
`state/bridge.log` 搜 `[archive]`：
```
[archive] 已归档闲置会话 session-xxx（闲置 31 分钟）
[archive] 巡检完成：扫描 87，保护 9，候选 1，归档 1，清理 0，失败 0（本地已归档 159）
```

## HTTP
```
GET  /api/social/session-archive   → sessionArchiveStatus()
POST /api/social/session-archive   → 立即巡检
     body: {force:false 或 dryRun:true, allWorkspaces, idleMinutes, batchMax}
```
2026-10-22 实测 GET 返回 ok:true、workspaceSessionDirs 三个（agents / persona-agent / slang-agent）。**不是** `/api/social/archive-status`（这个我一开始写错过）。

## 别混
归档的是磁盘会话目录；会话内部 token 压缩由预设层 `compaction-basic` 管，两回事。
