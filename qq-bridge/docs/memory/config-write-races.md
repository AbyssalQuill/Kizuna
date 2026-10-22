# 配置写入与并发的历史问题

**状态：待核实。** 这条目前只有零散观察，没有形成可复现的结论，先记骨架，后续补证据。

## 已知
- `config.json` 有目录监听 + 2s 轮询兜底（管理端保存后无需重启桥即时生效）
- `social-state.json` 由多个模块写（mux / social-state / console-server），走 `atomicWriteJson`
- `state/persona-agent.json`、`state/slang-session.json` 都是单文件登记

## 待查
- 多个模块同一时刻写 social-state.json 时的实际行为（3 秒去抖之外有没有真并发）
- config.json 热更新与桥内缓存刷新之间的窗口

**别把这条当结论用**，要么补证据，要么删掉。
