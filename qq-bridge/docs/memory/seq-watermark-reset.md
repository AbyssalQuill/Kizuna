# seq 重置不能把 known 归零

## 现象
同一秒内同一条日志连出两次；`state/tool-calls.jsonl` 1000 条记录 / 332 个去重键、48 个键重复、多出 668 份；同一秒对同一个群调了 25 次发消息、26 次标已读。

## 根因
`src/dsh-client.js` 的 `shouldResetSeqWatermark` 命中后执行 `known = 0`，等于把去重闸门整个拆掉，快照里最多 200 条历史全被 push 成新事件。

下游 `pumpMux` 对重放帧和实时帧完全同形、分不出来，历史回合的收尾副作用被完整重跑：重复计 token、重复累加 `noActionCount`、重复 `saveSocialState`、重放「无正文收尾」把新未读误标已读。

0.2.1 每个会话 seq 从 1 重新计数，持久化水位还停在 5728 这种值，**几乎必然触发一次**。

## 修法
seq 重置后「快照里最新那条」就是已知最新状态，把它作为新水位起点，只放行比它更大的实时帧：
```js
known = maxRec;
this._sidSeq.set(sessionId, maxRec);
this._scheduleSeqSave();
```
历史不重放，新事件也不丢（seq 单调递增）。

## 验证
重启后 `adjacent-duplicates: 0`，不再出现「判定序号已重置」后的大批事件。
