// 颜文字换行守卫（2026-10-30）：气泡里放不下的颜文字整体挤到下一行，放得下不动。
import assert from 'node:assert/strict';
import { cleanOutboundText, guardKaomojiLine, columnWidth, tailFaceSpan, configureOutbound } from '../src/lib/outbound-text.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + ' ' + extra); process.exitCode = 1; }
};

console.log('== ① 线上真实那条：正文 13 个汉字 + 冷脸萌，超一行 → 挤到下一行 ==');
const real = '不过拟人还行这句话我记下了 ᗜ - ᗜ';
console.log('   prefix cols =', columnWidth('不过拟人还行这句话我记下了'), 'face cols =', columnWidth('ᗜ - ᗜ'));
const g1 = guardKaomojiLine(real);
ok('被换成两行', g1.includes('\n'), JSON.stringify(g1));
ok('颜文字完整在第二行', g1.endsWith('\nᗜ - ᗜ'), JSON.stringify(g1));
ok('正文一字不丢', g1.replace('\n', ' ') === real, JSON.stringify(g1));

console.log('== ② 短句 + 颜文字放得下 → 不动 ==');
for (const s of ['哼 笨蛋主人 ᗜ - ᗜ', '早啊主人 一睁眼就来贴贴 ᗜ ᴗ ᗜ', 'ᗜ ‸ ᗜ', ',,ᗜ - ᗜ,,']) {
  ok('原样: ' + s, guardKaomojiLine(s) === s, JSON.stringify(guardKaomojiLine(s)));
}

console.log('== ③ 收尾句读不当颜文字（"我记下了." 里的点不算脸） ==');
ok('句号结尾不动', guardKaomojiLine('不过拟人还行这句话我记下了。') === '不过拟人还行这句话我记下了。');
ok('没有符号时不动', guardKaomojiLine('这是一句很长很长的正文内容用来超过一行宽度测试') === '这是一句很长很长的正文内容用来超过一行宽度测试');

console.log('== ④ 换成别的颜文字同样生效（不写死 ᗜ） ==');
const other = '这个我也会啊别问了还用你来教我吗 ✌︎ ᗜ ֊ ᗜ◞';
ok('别的脸也能被挤下去', guardKaomojiLine(other).includes('\n'), JSON.stringify(guardKaomojiLine(other)));

console.log('== ⑤ tailFaceSpan 取到的就是那一段 ==');
const span = tailFaceSpan(real);
ok('face 取对', span && span.face === 'ᗜ - ᗜ', JSON.stringify(span));

console.log('== ⑥ 接线：cleanOutboundText 里生效，且开关能关 ==');
ok('清洗链路里生效', cleanOutboundText(real).includes('\nᗜ - ᗜ'), JSON.stringify(cleanOutboundText(real)));
configureOutbound({ kaomojiLineGuard: false });
ok('关掉后不动', cleanOutboundText(real) === real, JSON.stringify(cleanOutboundText(real)));
configureOutbound({ kaomojiLineGuard: true });

console.log(fail === 0 ? '>>> 颜文字换行守卫全部通过 (' + pass + ')' : '>>> ' + fail + ' FAILED');
