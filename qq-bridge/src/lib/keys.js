// 会话 key 工具

// "群聊:123" / "私聊:456" 风格 key
export const convKey = (kind, id) => `${kind}:${id}`;

// default会话 key 规范化：接受 group:正整数 / private:正整数，中文私聊/群聊前缀，或纯数字容错。
export function canonicalKey(key, defaultKind = 'private') {
  const s = String(key ?? '').trim();
  if (!s) return null;
  // 1. 标准 group:123 或 private:456
  const m = /^(group|private):(\d+)$/i.exec(s);
  if (m) {
    const id = Number(m[2]);
    return Number.isSafeInteger(id) && id > 0 ? `${m[1].toLowerCase()}:${id}` : null;
  }
  // 2. 中文前缀容错：私聊:123 或 群聊:456 / 群:456
  const mZh = /^(?:私聊|私|private)[：:]\s*(\d+)$/i.exec(s);
  if (mZh) {
    const id = Number(mZh[1]);
    return Number.isSafeInteger(id) && id > 0 ? `private:${id}` : null;
  }
  const mGroupZh = /^(?:群聊|群|group)[：:]\s*(\d+)$/i.exec(s);
  if (mGroupZh) {
    const id = Number(mGroupZh[1]);
    return Number.isSafeInteger(id) && id > 0 ? `group:${id}` : null;
  }
  // 3. 纯数字容错（如 1736784911）：默认作为 private 会话
  const mNum = /^(\d+)$/.exec(s);
  if (mNum) {
    const id = Number(mNum[1]);
    return Number.isSafeInteger(id) && id > 0 ? `${defaultKind}:${id}` : null;
  }
  return null;
}
