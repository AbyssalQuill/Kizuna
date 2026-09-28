// 管理端「本地语音引擎」角色下拉的取数与显示口径（2026-10-01）
//
// 这是桥与管理端之间那条契约的**管理端一侧**：桥回 `GET /api/voice/local` 的
// `characters`（字符串数组）与 `characterList`（对象数组），界面读后者、为空才回退前者。
// 桥侧那一半（`listCharacterInfos` / `listCharacterDirs` 产出的形状与语言归一）在
// tests/voice-local.test.js 里。
//
// 被测的是 `../../src/lib/char-list.ts` 本身（不是抄一份实现）：node 能直接 import 这个 .ts
// （类型剥离），所以下面跑的就是界面在跑的那份代码。
//
// 要锁住的是三条容易被"看着对"蒙过去的分支：
//   ① `characterList` 为准、为空/不存在时回退 `characters`（旧桥只回字符串数组，不能因此列不出角色）；
//   ② `label` 是**空串**时显示 `name`（桥侧对没有 character.json 的角色就是回空串 ——
//      界面若不回退，下拉框会出现一行空白）；
//   ③ `language` 按 zh/jp/en/kr 显示成 中文/日语/英语/韩语，认不出（含空串）就不写括号；
//   ④ `label` **末尾已经写着本语言**（桥侧有些角色的 label 就是「菲比（中文）」）时不再追加 ——
//      否则下拉框显示成「菲比（中文）（中文）」（2026-10-01 界面实测就是这么显示的，本次修）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeChars, charDisplay, LANG_LABEL } from '../../src/lib/char-list.ts';

/** 与页面里 charOptions 的构造同形：值用 name，显示用 charDisplay。 */
const options = (stat) => normalizeChars(stat).map((c) => ({ value: c.name, label: charDisplay(c) }));

test('characterList 为准：label 有值用 label，label 为空串回退 name，语言翻成中文名', () => {
  assert.deepEqual(
    options({
      characterList: [
        { name: 'atri', label: '亚托莉', language: 'zh', loaded: true },
        { name: 'mika', label: '', language: 'jp', loaded: false },
        { name: 'feibi', label: '菲比', language: 'xx' },   // 语言不是约定值 → 不写括号
      ],
    }),
    [
      { value: 'atri', label: '亚托莉（中文）' },
      { value: 'mika', label: 'mika（日语）' },
      { value: 'feibi', label: '菲比' },
    ],
  );
});

test('回退：没有 characterList 或它是空数组时，仍用 characters 的字符串数组', () => {
  assert.deepEqual(options({ characters: ['atri', 'mika'] }),
    [{ value: 'atri', label: 'atri' }, { value: 'mika', label: 'mika' }]);
  assert.deepEqual(options({ characterList: [], characters: ['thirtyseven'] }),
    [{ value: 'thirtyseven', label: 'thirtyseven' }]);
  // 桥回包整个没读到 / 字段是别的形状 → 空清单，不抛错
  assert.deepEqual(normalizeChars(null), []);
  assert.deepEqual(normalizeChars({}), []);
  assert.deepEqual(normalizeChars({ characterList: 'atri', characters: {} }), []);
});

test('两份同时存在且名字不同时取并集、characterList 在前且按 name 去重', () => {
  assert.deepEqual(
    options({ characterList: [{ name: 'atri', label: '亚托莉', language: 'zh' }], characters: ['atri', 'legacy'] }),
    [{ value: 'atri', label: '亚托莉（中文）' }, { value: 'legacy', label: 'legacy' }],
  );
});

test('脏数据不产出无名项：空 name / 非字符串 / null 一律丢掉', () => {
  assert.deepEqual(
    options({ characterList: [null, { label: '只有标签' }, '   '], characters: [123, 'ok', 'ok '] }),
    [{ value: 'ok', label: 'ok' }],
  );
});

test('语言表恰好是 zh/jp/en/kr 四条（界面与桥侧约定一致）', () => {
  assert.deepEqual(LANG_LABEL, { zh: '中文', jp: '日语', en: '英语', kr: '韩语' });
});

/* ── 语言后缀去重（2026-10-01 实测修的显示 bug：下拉框显示「菲比（中文）（中文）」）──────
 * 桥侧 `characterList` 的 `label` 有的自带语言后缀（`{name:'feibi', label:'菲比（中文）', language:'zh'}`），
 * 界面此前一律再追加一次。修法是**只对末尾是同一个语言的后缀去重**：用户自己 --add-character
 * 加的角色通常没有后缀，那种情况必须照旧追加（少写后缀与多写后缀一样是显示错误）。 */
test('label 末尾已带本语言后缀 → 不重复追加（全角括号）', () => {
  assert.equal(charDisplay({ name: 'feibi', label: '菲比（中文）', language: 'zh' }), '菲比（中文）');
  assert.equal(charDisplay({ name: 'mika', label: '未花（日语）', language: 'jp' }), '未花（日语）');
  assert.equal(charDisplay({ name: 'thirtyseven', label: '三七（英语）', language: 'en' }), '三七（英语）');
  // 整份回包走一遍完整口径，形状与界面一致
  assert.deepEqual(
    options({ characterList: [
      { name: 'feibi', label: '菲比（中文）', language: 'zh', loaded: true },
      { name: 'mika', label: '未花（日语）', language: 'jp', loaded: false },
      { name: 'thirtyseven', label: '三七（英语）', language: 'en', loaded: false },
    ] }),
    [
      { value: 'feibi', label: '菲比（中文）' },
      { value: 'mika', label: '未花（日语）' },
      { value: 'thirtyseven', label: '三七（英语）' },
    ],
  );
});

test('label 没有后缀 + language 认得 → 照旧追加成「X（中文）」', () => {
  assert.equal(charDisplay({ name: 'myrole', label: '我的角色', language: 'zh' }), '我的角色（中文）');
  assert.equal(charDisplay({ name: 'myrole', label: '', language: 'kr' }), 'myrole（韩语）');   // 标签为空退回目录名
  assert.equal(charDisplay({ name: 'myrole', label: '我的角色', language: 'kr' }), '我的角色（韩语）');
  // 中段出现同一个语言不算后缀：仍然追加（只认末尾）
  assert.equal(charDisplay({ name: 'x', label: '中文·我的角色', language: 'zh' }), '中文·我的角色（中文）');
});

test('label 带半角括号与空格 → 同样不重复追加', () => {
  assert.equal(charDisplay({ name: 'a', label: '菲比(中文)', language: 'zh' }), '菲比(中文)');
  assert.equal(charDisplay({ name: 'b', label: '未花 ( 日语 )', language: 'jp' }), '未花 ( 日语 )');
  assert.equal(charDisplay({ name: 'c', label: '三七（ 英语 ）', language: 'en' }), '三七（ 英语 ）');
  // 末尾是**别的**语言 → 不认，照常追加（把不一致摊出来，不悄悄吞掉）
  assert.equal(charDisplay({ name: 'd', label: '菲比（日语）', language: 'zh' }), '菲比（日语）（中文）');
});

test('language 认不出（未知值 / 空串 / 缺失）→ 原样返回 label（不写括号）', () => {
  assert.equal(charDisplay({ name: 'feibi', label: '菲比（中文）', language: 'xx' }), '菲比（中文）');
  assert.equal(charDisplay({ name: 'feibi', label: '菲比（中文）', language: '' }), '菲比（中文）');
  assert.equal(charDisplay({ name: 'feibi', label: '菲比（中文）' }), '菲比（中文）');
  assert.equal(charDisplay({ name: 'feibi', label: '', language: 'xx' }), 'feibi');
});
