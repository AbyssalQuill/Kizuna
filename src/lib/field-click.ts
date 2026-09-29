/* ===================================================================================
   字段行的点击目标修复（Kizuna 管理端 · 全站）
   -----------------------------------------------------------------------------------
   2026-09-28 使用方反馈原话：「改掉所有输入框的 bug，鼠标悬停同一水平线就可以点击了
   而不是正好落在输入框里才能点击，这个不好，修复」

   现象：只有正好点进 <input> 自己的边框里才会聚焦 / 打开下拉；点同一个字段的标签，
   或者点这个字段那一行（与输入框同一条水平线）的空白处，什么都不会发生。

   根因（三类，都是"点击目标跟屏幕上看见的字段行对不上"）：
     ① 标签没有关联：`<div class="form-group"><label class="label">端口</label><NumInput/></div>`
        —— 这个 <label> 既没有 for、内部也没有控件，浏览器不会把点击转给任何东西。
        实例配置（10 处）、服务器配置（20 处）、画像学习（7 处）全是这个写法。
     ② 标签关联错了：`<label class="field-row"><span class="f-label">名字<button class="help-dot">ⓘ</button></span><input/></label>`
        —— HTML 规定"包裹式 label 的点击转发给**第一个可标注后代**"，这里第一个正是那个 ⓘ 按钮，
        于是点字段名弹出的是说明弹窗而不是聚焦输入框（桥配置 Field 渲染的每个字段都这样）。
     ③ 行容器根本不是 label，或控件被收窄后不占满整行：
        `<div class="switch-row">`（画像学习两处开关）、`<div class="field-row">`（人格学习的目标 QQ 多行框）、
        以及 `.is-short` / `.is-mid` 收窄后输入框**右侧那一截空白** —— 点上去一律没反应。
        `.switch-row` 还带 cursor:pointer 与悬停高亮，看起来能点、点了不动（正是上面那句反馈）。

   做法：一个全局的"字段行点击转发"，**一处改动覆盖全站每一页**（含以后新增的页面），
   各页 JSX 一行都不用改（所以不会跟正在改别的页面的改动撞车）。规则：
     · 只接管「点在非交互元素上」的点击：点在 input / textarea / select / button / a 上时原样放行 ——
       输入框内部的光标定位、选区拖选（拖选不产生 click）都不会被抢走；
     · 命中字段行容器（.field-row / .form-group / .switch-row / .cost-field / .pg-filter）后按两条规则挑控件：
         甲、点在「字段标签」那一类装饰元素上（.f-label / .label / .cost-label / .pg-filter-label /
             .cost-price em / .cost-custom em）→ 取文档顺序上排在它后面的第一个控件；
         乙、否则取**纵向上覆盖点击点、横向离得最近**的那个控件（这就是"同一水平线"）；
     · 两条都挑不到（例如点在字段下方的说明文字那一行）→ 什么都不做：不猜、不乱聚焦；
     · 挑到之后按控件类型给出与"用户自己点在那个控件上"一致的动作：
         文本框 / 多行框 → focus() 并把光标放到末尾（**不做 select() 全选**，不会把用户已有输入洗掉）；
         复选框 / 单选 → click()（与原生 label 行为一致，只切换一次）；
         自定义下拉（button[role=combobox]）→ click() 打开面板；
     · 点击落在 <label> 内部时先 preventDefault()：掐掉浏览器那套原生转发，
       统一由上面这一步完成动作 —— 否则桥配置里"标签里含 ⓘ 按钮"的字段会同时弹说明弹窗，
       `.switch-row` 这类会被原生和这里各切一次（等于没切换）。

   挂在 src/main.tsx 里一次（installFieldClickTargets()），卸载函数由调用方按需使用。
   本文件不产生任何 DOM / 视觉改动：只决定"点哪里算点到哪个输入控件"。
   =================================================================================== */

/** 字段行容器：全站所有表单都由这几类拼出来（`.field-row`/`.switch-row` 来自 .cfg-fields/各页，`.form-group` 来自 global.css，`.cost-field`/`.pg-filter` 来自学习页与画像页） */
const ROW_SELECTOR = '.field-row, .form-group, .switch-row, .cost-field, .pg-filter';
/** 行里可当作"要聚焦的控件"的元素 */
const CONTROL_SELECTOR = 'input, textarea, select, [role="combobox"]';
/** 不是可填控件、必须排除的 input（隐藏域与文件选择框，后者一律由旁边的按钮触发） */
const NOT_A_CONTROL = 'input[type="hidden"], input[type="file"]';
/** 点到这些元素（或它们内部）时一律放行：原生行为（光标定位、选区、按钮自身点击）不能被打断 */
const NATIVE_TARGET = 'input, textarea, select, button, a[href], option,'
  + ' [role="combobox"], [role="listbox"], [role="option"], [contenteditable="true"], .mb-dd-panel';
/** 「字段标签」那一类装饰元素：点它 = 点它后面紧跟的那个控件 */
const LABEL_LIKE = '.f-label, .label, .cost-label, .pg-filter-label, .cost-price em, .cost-custom em';
/** 「同一水平线」的纵向容差：`.field-row` 的 label 与控件之间那道 gap 是 4px，点进缝里也算这一行 */
export const LINE_SLACK_PX = 4;

/** 一个元素在视口里的纵向/横向范围（只取判定需要的四个数，便于脱离 DOM 单测） */
export type Box = { top: number; bottom: number; left: number; right: number };
export type Placed<T> = { el: T; box: Box };

/**
 * 「同一水平线」的核心判定：先按纵向覆盖筛（点击点的 y 落在控件上下边之内，允许 ±slack），
 * 再在这些候选里取横向距离 x 最近的一个。
 * 纯函数、不碰 DOM —— `tools` 下的临时断言脚本直接喂矩形给它跑。
 * 注意 slack 故意很小（4px）：只为了吃掉 label 与控件之间那道缝，
 * 不会让"点在下面那行说明文字上"也去聚焦上面的输入框。
 */
export function pickOnSameLine<T>(items: readonly Placed<T>[], x: number, y: number, slack: number = LINE_SLACK_PX): T | null {
  let best: T | null = null;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const it of items) {
    const b = it.box;
    if (y < b.top - slack || y > b.bottom + slack) continue;
    const gap = x < b.left ? b.left - x : (x > b.right ? x - b.right : 0);
    if (gap < bestGap) { bestGap = gap; best = it.el; }
  }
  return best;
}

/** 文档顺序上排在 anchor 之后的第一个控件（"点标签 → 聚焦它后面那个控件"） */
function pickAfter<T extends Element>(anchor: Element, items: readonly T[]): T | null {
  for (const el of items) {
    if ((anchor.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0) return el;
  }
  return null;
}

/** 能真的接收点击的控件：不是隐藏域 / 文件框，没被禁用，且在屏幕上占着位置（display:none / 折叠的字段不算） */
function isUsableControl(el: Element): boolean {
  if (el.matches(NOT_A_CONTROL)) return false;
  if (el.hasAttribute('disabled')) return false;
  if ((el as HTMLInputElement).disabled === true) return false;
  const b = el.getBoundingClientRect();
  return b.width > 0 && b.height > 0;
}

function place(el: HTMLElement): Placed<HTMLElement> {
  const b = el.getBoundingClientRect();
  return { el, box: { top: b.top, bottom: b.bottom, left: b.left, right: b.right } };
}

/**
 * 给挑中的控件做出"与用户自己点在那个控件上"一致的动作。
 * 这里只做聚焦/打开，**绝不改动值**（文本框不做全选，避免一次误点把已有输入清掉）。
 */
function activate(el: HTMLElement): void {
  if (el.tagName === 'INPUT') {
    const t = (el as HTMLInputElement).type;
    if (t === 'checkbox' || t === 'radio') { (el as HTMLInputElement).click(); return; }
  }
  if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'combobox') {
    const btn = el as HTMLButtonElement;
    btn.focus();
    /* 自定义下拉：整块触发器本来就点得开，这里让"它所在的这一行"也点得开。
       **只在它还没展开时点**：同一次点击里若已经有人把它点开过（历史上语音配置页自己挂过一份
       「整行可点」，见 git 记录里的 VoiceConfig.focusRowControl），这里再点一下就是"开了又关"——
       用户看到的现象正是"点这一行的空白/标签，下拉闪一下还是没打开"（2026-09-29 无头实测：
       同一次点击里 button.mb-dd 收到两个合成 click，第一个把 aria-expanded 变 true，第二个又关回去）。
       展开状态是控件自己写的（Dropdown 的 aria-expanded），读它比记"谁先谁后"可靠，也不依赖挂载顺序。 */
    if (btn.getAttribute('aria-expanded') !== 'true') btn.click();
    return;
  }
  el.focus();
  const tf = el as HTMLInputElement | HTMLTextAreaElement;
  if (typeof tf.setSelectionRange === 'function') {
    const end = typeof tf.value === 'string' ? tf.value.length : 0;
    try { tf.setSelectionRange(end, end); } catch { /* number / email 这类不支持选区的类型：忽略 */ }
  }
}

/* 浏览器对 <label> 的原生转发：点击落在 label 里 → 转发给"第一个可标注后代"。
   桥配置的字段行里，那个后代是 ⓘ 帮助按钮（renderLabel() 把 helpBtn 放在最前面），
   于是点字段名/点说明文字会莫名弹出帮助框。我们自己已经决定"这一击不做任何事"时，
   就把这条转发掐掉 —— 但只掐"第一个后代是按钮"这一类：
   第一个后代是输入框/复选框的那种保持浏览器原有语义，不改变既有行为。 */
function suppressStrayLabelForwarding(label: Element | null, e: MouseEvent): void {
  if (!label) return;
  const first = label.querySelector('input:not([type="hidden"]):not([type="file"]), textarea, select, button');
  if (first && first.tagName === 'BUTTON' && !first.matches('[role="combobox"]')) e.preventDefault();
}

/**
 * 装上「字段行点击转发」。返回卸载函数。
 * 只在浏览器里调用（src/main.tsx 启动时挂一次）；不传参时用当前文档。
 */
export function installFieldClickTargets(doc: Document = document): () => void {
  /* 下拉面板的"点外面就关"发生在 mousedown（Dropdown 自己的 document 捕获监听）。
     所以要在 mousedown 那一刻记下"这一行本来有没有开着的下拉"：
     有的话，这次点击的语义是"点在面板外面 → 关掉"，不能再把它打开一次。
     注意必须在这一行**内部**找（querySelector），不能用 closest —— closest 只往祖先方向找，
     而这里被点中的是"行内的空白"，它自己是那行里的元素、祖先里当然没有下拉。 */
  let openComboboxAtDown: Element | null = null;

  const onMouseDown = (e: MouseEvent) => {
    const t = e.target;
    const row = t instanceof Element ? t.closest(ROW_SELECTOR) : null;
    openComboboxAtDown = row ? row.querySelector('[role="combobox"][aria-expanded="true"]') : null;
  };

  /* 同一个 click 只做一次决定：万一本函数被挂了两遍（热更新等），
     复选框那种"切两次等于没切"的失效就不会发生。 */
  const handled = new WeakSet<Event>();

  const onClick = (e: MouseEvent) => {
    const wasOpen = openComboboxAtDown;
    openComboboxAtDown = null;                     // 键盘触发的 click 没有 mousedown，不能留上一次的残留
    if (handled.has(e)) return;
    handled.add(e);
    if (e.defaultPrevented || e.button !== 0) return;
    const t = e.target;
    if (!(t instanceof Element)) return;
    if (t.closest(NATIVE_TARGET)) return;          // 点的是控件/按钮本身 → 原生行为原样放行

    const row = t.closest(ROW_SELECTOR);
    if (!row) return;
    const label = t.closest('label');               // 落在 <label> 里吗？决定要不要掐掉原生转发
    if (wasOpen && row.contains(wasOpen)) {         // 面板开着的这一行：这一击的语义是"关"，不是"开"
      if (label) e.preventDefault();                // 不掐，label 会把这一击转给下拉触发器 → 关了又开
      return;
    }

    const ctls = Array.from(row.querySelectorAll<HTMLElement>(CONTROL_SELECTOR)).filter(isUsableControl);
    if (!ctls.length) { suppressStrayLabelForwarding(label, e); return; }

    const tag = t.closest(LABEL_LIKE);
    const el = (tag ? pickAfter(tag, ctls) : null) ?? pickOnSameLine(ctls.map(place), e.clientX, e.clientY);
    /* 说明文字那一行 / 纯装饰区：不聚焦任何控件 */
    if (!el) { suppressStrayLabelForwarding(label, e); return; }

    /* 点进 <label> 里时，浏览器自己也会转发这次点击（转发给"第一个可标注后代"，
       桥配置里那个后代是 ⓘ 按钮）。统一改由 activate() 完成，先掐掉原生那一路。 */
    if (label) e.preventDefault();
    activate(el);
  };

  doc.addEventListener('mousedown', onMouseDown, true);
  doc.addEventListener('click', onClick);
  return () => {
    doc.removeEventListener('mousedown', onMouseDown, true);
    doc.removeEventListener('click', onClick);
  };
}
