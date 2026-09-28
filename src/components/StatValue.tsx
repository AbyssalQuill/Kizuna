import { useEffect, useRef, useState } from 'react';

/** 计数值旁边的 "+N" 浮出件（2026-09-26 主人要求，2026-09-27 起两页共用同一个口径）。
 *  先用在聊天记录页的「今日发送 / 总发送」，后抽成公用件给学习页的 token 统计复用；
 *  2026-09-27 主人再次要求聊天记录页也要这个动效（"你聊天记录页的那个也加个 +小数字的动效"），
 *  于是三张卡与 token 页的数字统一走这一个组件 —— 两页观感必须一致，别再各写一套。
 *
 *  规则：
 *  · 首次到达（还没有旧值，如刚打开页面）不算"新增"，不闪；
 *  · 默认只报增量：变小不闪（换作用域 / 换服务器 / 换库 / 跨零点），那不是新增量；
 *  · signed=true 用于会涨也会跌的数（如「平均每条消息 token」）：涨给 +N、跌给 -N
 *    （不给负号的话，一个来回震荡的平均值只会单边闪，看不出它其实降了）；
 *  · 调用方按作用域给 key，换数据源时整体重挂，旧值不会串到新库里；
 *  · 2.6 秒后自己消失（动画在 app.css 的 .stat-delta，时长与这里保持一致）。
 *
 *  @param value     计数值；null 表示"还不知道"，不参与比较
 *  @param text      主数字的展示文本（调用方自己格式化，组件不猜单位）
 *  @param as        外层标签：卡片里的数字用 div，句子中间的计数用 span
 *  @param className 沿用调用方原有的数字样式类，避免改动任何既有排版
 *  @param signed    涨跌都要提示（默认 false：只提示增加）
 *  @param title     悬停说明（可选）。2026-09-26 主人要求去掉界面上所有悬停说明，
 *                   故不再转成 DOM 的 title 属性；形参保留只为不做大范围签名改动。 */
export default function StatValue({
  value, text, as = 'div', className = 'v', title, signed = false,
}: {
  value: number | null;
  text: string;
  as?: 'div' | 'span';
  className?: string;
  title?: string;
  signed?: boolean;
}) {
  const prevRef = useRef<number | null>(null);
  const [delta, setDelta] = useState<{ n: number; at: number } | null>(null);
  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = value;
    if (value === null || prev === null || value === prev) return;
    const n = value - prev;
    if (n < 0 && !signed) return;
    setDelta({ n, at: Date.now() });
    const t = window.setTimeout(() => setDelta(null), 2600);
    return () => window.clearTimeout(t);
  }, [value, signed]);
  const Tag = as;
  return (
    <Tag className={className}>
      {text}
      {delta ? (
        <span className={`stat-delta${delta.n < 0 ? ' is-down' : ''}`} key={delta.at}>
          {delta.n > 0 ? '+' : '-'}{Math.abs(delta.n).toLocaleString('zh-CN')}
        </span>
      ) : null}
    </Tag>
  );
}
