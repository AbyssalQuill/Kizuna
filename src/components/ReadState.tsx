/* 读取态的零件：骨架占位（Skeleton）。

 * 2026-09-26 主人要求「去掉界面上所有加载线，全量」：原来这里还有一条 ReadBar
 * （2px 细进度条，做成 sticky 贴在卡片/列表顶部，表示"正在后台校准"）。它在学习页
 * 会同时出现两条（卡片级一条、区块级一条），观感像"界面漏了两条粉线"，故整支去掉。
 * 现在 ReadBar 保留同名同签名的空实现：21 个调用点不用逐个改，也保证类型不变；
 * 它恒返回 null，屏幕上不会再有任何加载线。配套的 .read-bar 样式已从 app.css 删除。
 * 后台照样静默校准与刷新，只是不再用任何线条表示"正在读"（呼应 2026-09-24 那条
 * "宁可静默刷新、也不要跳状态"的既有决定）。 */

/** 兼容用的空实现：主人要求去掉全部加载细线，此处恒返回 null。 */
export function ReadBar(_props: { active?: boolean; title?: string }) {
  return null;
}

/** 骨架占位：只在"屏上确实没有可显示的内容"时用（首次进入、或对象刚被换掉）。
 *  注意它与"加载线"不是一回事：骨架是首帧占位、数据一到就整体消失，不会长期挂在屏上。 */
export function Skeleton({ rows = 5, variant = 'line' }: { rows?: number; variant?: 'line' | 'card' }) {
  return (
    <div className="read-skel" aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div className={`read-skel-row is-${variant}`} key={i}>
          <span className="read-skel-bar w1" />
          <span className="read-skel-bar w2" />
          <span className="read-skel-bar w3" />
        </div>
      ))}
    </div>
  );
}
