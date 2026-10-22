# mark_read 占了 65% 的工具调用

## 数据（`state/tool-calls.jsonl` 1000 条）
- mark_read 占全部工具调用 **65.3%**（326/499）
- 每轮平均 4.26 个工具步
- 112 轮里有 35 轮发过消息，其中 **24 轮（69%）发完又单独调了一次 mark_read**

## 为什么会这样
工具层早就做了自动标已读 —— `mcp-napcat-safe.js` 的 `autoMarkReadAfterSend` 接了 15 处发送工具，工具描述还写着 "you do NOT need a separate mark-read call"。第 96 行（私聊）也写了 "never a mark-read on top of a send"。

但第 69 行（群聊/通用）仍要求 `Elsewhere: close with qq_mark_read`。同一份提示词两条规则打架，靠前那条占上风。

## 修法（2026-10-22）
第 69 行改成与第 96 行一致：
> a bubble covers the read watermark, so close with qq_mark_read **ONLY when you stayed silent**

## 验收标准
跑几十轮后看 `state/tool-calls.jsonl`，mark_read 占比应从 65% 掉到 25% 上下。没降说明还有别处推它调（第 70/71/75/81 行是沉默收尾场景，属正常）。
