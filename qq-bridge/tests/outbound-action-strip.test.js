// 动作括号剥离（条目 38）：确保出站文字零括号，且不误伤正文标点。
import assert from 'node:assert/strict';
import { cleanOutboundText, cleanOutboundTextDetailed, configureOutbound } from '../src/lib/outbound-text.js';

// 线上探针原文（条目 37 抓到的三条气泡）
const probe1 = '主人～你人呢？我在这边等了你好久了哦（尾鳍拍了两下水）';
const probe2 = '…对了，这个点是不是该吃饭了呀。我这边肚子先鸣咕叫了，好想吃热乎乎的米饭（尾鳍甩了一下）';
const probe3 = '( ˘ω˘ )';

const d1 = cleanOutboundTextDetailed(probe1);
assert.ok(!d1.text.includes('尾鳍'), '括号动作被剥掉');
assert.ok(d1.text.startsWith('主人～你人呢？'), '正文与问号保留');
assert.equal(d1.actionStripped, true, '标记为动作剥离，调用方据此不回退原文');

const d2 = cleanOutboundTextDetailed(probe2);
assert.ok(!d2.text.includes('尾鳍'), '长段里的括号同样剥掉');
assert.ok(d2.text.startsWith('…对了'), '段首保留');

/* 2026-10-30 政策修正：纯符号括号不再当动作描写剥 —— 冷脸萌整套里有两张天生带括号
 * （（ᗜ_ᗜ）➡（ᗜ֊ᗜ）、( ╯－︿－)╯╧╧），一刀切会把它们剥成空。判据：括号内有没有汉字/拉丁字母。 */
const d3 = cleanOutboundTextDetailed(probe3);
assert.equal(d3.text, '( ˘ω˘ )', '纯符号 kaomoji 保留');
assert.equal(d3.actionStripped, false, '没剥括号就不算动作剥离');

const KAOMOJI_SET = [
  'ᗜ - ᗜ', 'ᗜ ᴗ ᗜ', 'ᗜ ‸ ᗜ', ',,ᗜ - ᗜ,,', 'ᗜ - ᗜ💢',
  'ᗜ 𖥦 ᗜ', '✌︎ ᗜ ֊ ᗜ◞', '（ᗜ_ᗜ）➡（ᗜ֊ᗜ）', '( ╯－︿－)╯╧╧', 'ᶻz ₍ _ _ ₎',
];
for (const face of KAOMOJI_SET) assert.equal(cleanOutboundText(face), face, '冷脸萌整张保留: ' + face);
assert.equal(cleanOutboundText('（尾鳍拍了两下水）'), '', '带字的动作照样剥空');
assert.equal(cleanOutboundText('(smiles) hi'), 'hi', '英文动作照样剥');

assert.equal(cleanOutboundText('纯文本。'), '纯文本', '非括号文本只去末尾句号');
assert.equal(cleanOutboundText('嗯（'), '嗯（', '未闭合括号不误伤');
assert.equal(cleanOutboundText('*微笑* 你好'), '你好', '星号动作剥掉');
assert.equal(cleanOutboundText('主人（尾鳍甩了一下）（蹭蹭）好'), '主人好', '多段连续剥离');

// 回滚开关
configureOutbound({ stripActionBrackets: false });
assert.equal(cleanOutboundText(probe1), probe1.replace(/。$/, ''), '关掉开关后括号原样保留');
configureOutbound({ stripActionBrackets: true });
assert.ok(!cleanOutboundText(probe1).includes('尾鳍'), '重新打开后继续剥离');

console.log('>>> 出站动作括号剥离测试全部通过');