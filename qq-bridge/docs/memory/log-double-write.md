# 日志双写：log.js 与 systemd 抢同一个文件

## 现象
`state/bridge.log` 里每行都出现两次，相邻两行完全相同、时间戳也一样。排查时一度误判成双订阅 / 双 socket / 双事件泵，逐项排除后才定位。

## 根因
- `src/lib/log.js` 自己 `appendFileSync` 写 `state/bridge.log`
- `qq-bridge.service` 又把同样的 stdout/stderr `StandardOutput=append:` 到同一个文件

## 修法
systemd 改成 journal：
```
StandardOutput=journal
StandardError=journal
```
文件只由 log.js 写，格式与 2000 行轮转逻辑都不变。查服务日志改用 `journalctl -u qq-bridge`。

## 验证
清空日志后重启，相邻重复从「整文件成对」降到只剩几条不同会话各自的业务日志。
