# 生产部署：作用域与改动纪律

> 服务器地址、端口、账号等连接信息**不入库**。放在本机 `~/.dsh/memory/` 或你自己的凭据管理里。

## 允许改的三个作用域
1. `qq-chat` preset 与 persona / speech-rules
2. bridge 源码（`src/`）
3. DSH 侧与此项目相关的插件装配

## 硬规矩
- 改动前就地备份：`*.bak-<用途>-<YYYYmmdd-HHMMSS>`
- 改完必须跑验证命令，把输出贴出来才算完成
- 不碰桌面端 DSH 的 home —— 服务器与本地同名 `~/.dsh` 但是两个实例，混了会改错机器
- 部署形态是 systemd 三个单元：DSH web、bridge、NapCat；重启顺序先 DSH 再 bridge

## 当前部署形态（不含连接信息）
```
dsh-web.service    → dsh --profile web --port <port> --no-open
qq-bridge.service  → node /path/to/qq-bridge/src/bridge.js
napcat.service     → NapCat
```
