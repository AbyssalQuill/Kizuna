// 循环复读监测的纯文本工具
// 归一化：去空白、压缩重复标点、限长，用于比较两回合输出是否"复读"。
export function normalizeLoopSignature(text) {
  const t = String(text ?? '')
    .replace(/[ \t\r\n]+/g, ' ')
    .replace(/([，。！？、,.!?])\1+/g, '$1')
    .trim();
  return t.slice(0, 120);
}

// 防循环回复：判断两条发送文本是否构成重复（相同、包含、或公共前缀高度重合）
/* 2026-10-30 真机复现「重复回复」：
 *   12:42:32 发 ["被这样拎着 裙摆都飘起来了呀","人家又不是挂件 笨蛋主人"] → 工具回了一条
 *            styleWarn「第 1、2 条消息内部有中文空格…」
 *   12:42:42 模型把第一条改了个标点重发 ["被这样拎着裙摆都飘起来了，人家又不是挂件啦", …]
 *   群里于是出现「被这样拎着 裙摆都飘起来了呀」和「被这样拎着裙摆都飘起来了…」同一句两遍。
 * 旧判据为什么没拦住：它比的是**原文**，前 5 字之后因为多了一个空格整体错位；
 * 而且分母取 max(len)，一句被拉长到 20 字时前缀重合度会被稀释（13/20=0.65 < 0.8）。
 * 现在先去掉空白再比，且公共前缀的分母取较短那条（被改写的永远是较短/较长的一方之一）。 */
/* 2026-10-30 主人：「不用忽略标点符号，就是句尾不要句号就行了」。
 * 所以这里只归一两种必然不算差异的东西：空白（发送时本来就会被吞）和**句尾**的句号/点
 * （stripTrailingPeriod 出站时一定会去掉，所以"有没有句号"在用户看来是同一条）。
 * 中间的 ，！？～ 一律算数：那两个版本的删除逻辑就是从这里开始失控的。 */
const normForCompare = (s) => String(s ?? '').replace(/[ \t\r\n\u3000]+/g, '').replace(/[。.]+$/, '');
export function isDuplicateSendText(a, b) {
  const na = normForCompare(a);
  const nb = normForCompare(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const la = na.length, lb = nb.length;
  if (la < 4 || lb < 4) return false;
  if (na.includes(nb) || nb.includes(na)) return true;
  let cp = 0;
  const lim = Math.min(la, lb);
  while (cp < lim && na[cp] === nb[cp]) cp++;
  return cp >= 10 && cp / lim >= 0.8;
}
