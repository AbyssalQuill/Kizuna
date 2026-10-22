# 上下文成本在重发，不在单步大小

## 数据（`state/token-usage.jsonl` 近 2000 次请求）
- cacheRead 占 **97.2%**
- 每步均值 85,455 token
- 每轮 4.26 步
- 单个会话步数中位 56，最大 456

## 结论
钱几乎全花在「重发上下文」上，缓存的单价只有未命中的几十分之一，但步数一多总量就上去了。

所以省额度的杠杆是 **减少步数**，不是压缩单步内容。并行工具调用救不了这个局：同轮可并行的只占 13.4%，而且 DSH 已经会自动并行独立只读调用（`isConcurrencySafe`）。

PTC（run_code）理论上能用一次调用干完多次往返，但在 qq-chat 预设里等于把 node 执行权交给群成员（profile 默认 `danger-full-access`），且 `qq-tool-restrict` 白名单会直接拒掉 `run_code`。不做。
