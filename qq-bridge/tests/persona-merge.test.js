// 回归：人格学习"越学越短"不能覆盖旧的长档案
// 2026-09-20 现场：人格画像本来是几百字成文，一轮只交了 nickname 的学习把它写成了
// `昵称「群魅魔/AbyssalQuill」。`（两个词）—— 旧文被整条覆盖，报障"我以前是有的是不是被清除了"。
// 跑法：node tests/persona-merge.test.js
import assert from 'node:assert/strict';
import {
  mergePersonaProfileText,
  mergeUniqueStrings,
  mergeUniqueCatchphrases,
  buildPersonaTaskBrief,
  PERSONA_BRIEF_VERSION,
} from '../src/core/persona-learn.js';

let passed = 0;
const cases = [];
const t = (name, fn) => cases.push([name, fn]);

const RICH = '昵称「群魅魔」；被叫群魅魔，别人也这样称呼ta；对朋友用@+昵称发起互动。技术能力强，能独立解决设备GUID、'
  + 'NapCat掉登录等底层技术问题，且会与落木等人协作测试；直接坦率，说话不绕弯子；有游戏爱好（三角洲行动），会向群友发起挑战。';
const STUB = '昵称「群魅魔/AbyssalQuill」。';

t('① 只学到两个词 → 保留旧的长档案（不能被写成 stub）', () => {
  const out = mergePersonaProfileText(RICH, STUB);
  assert.ok(out.includes('技术能力强'), '旧内容必须还在');
  assert.ok(out.includes('AbyssalQuill'), '新学到的昵称要补进去，不能丢');
  assert.ok(out.length >= RICH.length, `长度不该缩水：${out.length} < ${RICH.length}`);
});

t('② 真的学到更多 → 以新的为准（越学越全不受影响）', () => {
  const bigger = `${RICH}另外还会写 cpp，喜欢树形DP，半夜也在调设备。`;
  assert.equal(mergePersonaProfileText(RICH, bigger), bigger);
});

t('③ 旧档案本来就短 → 照常覆盖（没内容可保时别拦）', () => {
  assert.equal(mergePersonaProfileText('昵称「甲」。', '昵称「甲/乙」。会写代码，爱打游戏，说话直接。'), '昵称「甲/乙」。会写代码，爱打游戏，说话直接。');
});

t('④ 本轮什么都没产出 → 原样保留旧的', () => {
  assert.equal(mergePersonaProfileText(RICH, ''), RICH);
  assert.equal(mergePersonaProfileText(RICH, '   '), RICH);
});

t('⑤ 旧档案为空 → 用新的', () => {
  assert.equal(mergePersonaProfileText('', STUB), STUB);
});

t('⑥ 新 stub 已经包含在旧文里时不重复追加', () => {
  const prev = `昵称「群魅魔」。${RICH}`;
  const out = mergePersonaProfileText(prev, '昵称「群魅魔」。');
  assert.equal(out, prev, '重复内容不该被追加第二遍');
});

t('⑦ 结构化数组字段（topics/tags/taboos）新旧智能去重合并，新发现排前、旧特征保留', () => {
  const merged = mergeUniqueStrings(['C++', 'Remotion'], ['布偶猫', 'c++', '三角洲行动'], 10);
  assert.deepEqual(merged, ['C++', 'Remotion', '布偶猫', '三角洲行动']);
});

t('⑧ 口头禅（catchphrases）按 phrase 不区分大小写去重合并，新上下文优先', () => {
  const next = [{ phrase: '草', context: '好笑时' }, { phrase: '确实', context: '赞同时' }];
  const prev = [{ phrase: '草', context: '旧语境' }, { phrase: '包的', context: '打包票时' }];
  const merged = mergeUniqueCatchphrases(next, prev, 10);
  assert.equal(merged.length, 3);
  assert.equal(merged[0].phrase, '草');
  assert.equal(merged[0].context, '好笑时');
  assert.equal(merged[2].phrase, '包的');
});

t('⑨ 人格学习说明版本 v8 包含增量调和（INCREMENTAL PROFILE RECONCILIATION）与群聊防污染规则', () => {
  assert.equal(PERSONA_BRIEF_VERSION, 8);
  const brief = buildPersonaTaskBrief();
  assert.ok(brief.includes('INCREMENTAL PROFILE RECONCILIATION'), '应包含增量画像调和指引');
  assert.ok(brief.includes('ANTI-POLLUTION & HIGH-SIGNAL EXTRACTION'), '应包含群聊噪声防污染指引');
});

for (const [name, fn] of cases) {
  try { fn(); passed += 1; console.log(`  PASS ${name}`); }
  catch (e) { console.error(`  FAIL ${name}\n       ${e?.message ?? e}`); process.exitCode = 1; }
}
console.log(`persona-merge: ${passed}/${cases.length} 通过`);
if (process.exitCode) process.exit(process.exitCode);
