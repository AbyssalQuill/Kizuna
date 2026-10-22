# 视觉模型 id 失效：deepseek-v4-flash-vision-exp

## 现象
每次唤醒都刷：
```
设置会话视觉模型失败 session-xxx（档位 off，第 1/2 次）: session/model-unavailable:
Select an available model before sending a message.
设置会话视觉模型失败 session-xxx（服务商默认档位，第 2/2 次）: ...
```
每个会话重试两遍 × 两个档位 = 4 次无谓往返，日志被刷满。消息仍能正常发出去（主链路不依赖 selectModel 成功），所以很容易被忽略。

## 根因
DSH 0.2.1 的模型目录里**没有** `deepseek-v4-flash-vision-exp`，只剩两个：

| model | reasoningEfforts |
| --- | --- |
| `deepseek-flash` | 不声明（传 off 可用） |
| `deepseek-v4-pro` | 不声明 |

而 `config.json` 的 `dsh.model` 还写着那个已下线的 id。`ensureVisionModel` 拿它去 `sessions.selectModel`，DSH 回 `session/model-unavailable`。

## 实测（2026-10-22）
```
FAIL  deepseek-official/deepseek-v4-flash-vision-exp  effort=(none) → session/model-unavailable
FAIL  deepseek-official/deepseek-v4-flash-vision-exp  effort=off  → session/model-unavailable
OK    deepseek-official/deepseek-flash               effort=(none) → deepseek-flash high
OK    deepseek-official/deepseek-flash               effort=off    → deepseek-flash off
OK    deepseek-official/deepseek-v4-pro              effort=(none) → deepseek-v4-pro high
```
注意 `reasoningEffort: "off"` 本身没问题 —— `deepseek-flash` 接受它。坏的只有模型 id。

## 修法
`config.json` 与 `config.example.json` 的 `dsh.model` 改成 `deepseek-flash`：
```json
{ "provider": "deepseek-official", "model": "deepseek-flash", "reasoningEffort": "off" }
```
`config.example.json` 必须跟着改，否则新部署会照抄失效 id 又踩一次。

## 验证
重启桥后触发一次唤醒：
```
已设置会话视觉模型 session-xxx -> deepseek-official/deepseek-flash (off)
model-unavailable 次数: 0
```

## 以后
模型 id 会随 DSH 版本变。升级后先跑一次目录探针，比对 `config.json` 里配的 id 还在不在：

```js
const cat = unwrap(await client.sessionModelCatalog(), 'catalog');
for (const g of cat.groups) for (const m of g.models) console.log(g.id + '/' + m.id);
```
