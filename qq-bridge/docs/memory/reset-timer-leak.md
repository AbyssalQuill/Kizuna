# 重置会话前要清定时器

## 根因
`src/core/social-state.js` 的 `resetConversationKeepingLedger` 直接 `social.conversations.delete(canonical)`，但 proactive/reply 的回调是闭包捕获旧 `st` 的 —— 删掉 map 里的条目并不会让已排的 timer 消失。

到点后它仍按旧 `st` 评估 idle/fresh，命中就 `dispatchWake`，给一个「刚重置过的新会话」多排一次唤醒。反复 reset 会累积多条主动链。

## 修法
delete 之前先 `clearSocialTimers(canonical)`。**顺序不能反**：该函数内部按 key 取 st，删了就取不到。
