import { createRoot } from 'react-dom/client';
import App from './App';
import { installFieldClickTargets } from './lib/field-click';
import './styles/global.css';
import './styles/app.css';

/* 【2026-09-28】字段行点击目标（使用方反馈："鼠标悬停同一水平线就可以点击"，而不是
 * 正好点进输入框里才行）。这一处挂载覆盖全站每一页 —— 各页的 JSX 一行都不用改，
 * 所以不会跟正在改其它页面的改动撞车。成因、规则与取舍见 src/lib/field-click.ts 头部注释。 */
installFieldClickTargets();

/* 【2026-09-27 主人要求】启动过渡动画换成「纯白屏 + 内置 home 粉的 AaCute Kizuna」，
 * 换掉了原来那张 kizuna-start.png 启动图。第二版按主人反馈调过：不要粉色雾气、蹦慢一点、
 * 从四面八方蹦进来、最后来一道从左到右的扫光。节奏：
 *   渐入 .45s → 等 AaCute 就绪后六个字母从各自方向蹦进来（错峰 240ms、单字 1.1s，
 *   最后一个字母约 2.3s 站定）→ 一道白光从左到右扫过（2.45s 起、1.15s）→
 *   最短展示 4.2s → 淡出 .9s（与 #root 的过渡同时长，一次交叉淡化）。
 * 动画本体是 index.html 里的 `#boot-splash`（写在 HTML 里 → JS 加载前就已在屏上，
 * 不会出现「白屏一闪再出现动画」），这里只负责到点把它淡出摘掉。
 * 三重兜底，任何一步出问题都不会让这层挡住界面：
 *   ① 等两帧再计时（保证首页至少已经画出一帧，不会动画没了首页还没出来）；
 *   ② 12s 硬超时无条件摘除；
 *   ③ 摘除用的是 remove()，与后续路由/渲染没有耦合。 */
const splash = document.getElementById('boot-splash');
createRoot(document.getElementById('root')!).render(<App />);
if (splash) {
  const MIN_MS = 4200; // 最短展示时长（逐字蹦完约 2.3s + 扫光 1.15s），留一点让单词停稳
  const startedAt = Date.now();
  let dropped = false;
  const drop = () => {
    if (dropped) return;
    dropped = true;
    splash.classList.add('is-out');
    /* 与启动层的淡出同时把应用本体显出来（index.html 里 `html:not(.app-ready) #root` 是藏着的）：
       两边各 .9s（CSS 的 bsFadeOut 与 #root 的 transition 都是 .9s），正好是一次交叉淡化；
       不同时做的话会先白一下再出界面。 */
    document.documentElement.classList.add('app-ready');
    window.setTimeout(() => splash.remove(), 900);
  };
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const rest = MIN_MS - (Date.now() - startedAt);
    if (rest > 0) window.setTimeout(drop, rest);
    else drop();
  }));
  window.setTimeout(() => {
    document.documentElement.classList.add('app-ready');
    if (document.body.contains(splash)) { dropped = true; splash.remove(); }
  }, 12000);
}
