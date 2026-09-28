/**
 * 本地语音引擎「角色清单」的取数与显示口径（2026-10-01 立此形状）。
 *
 * 为什么单独一个模块：这份口径是**桥与管理端之间的契约**，两边都要认同一份 ——
 *   · 桥侧 `GET /api/voice/local`（qq-bridge/src/lib/genie-tts.js 的 `localState` / `listCharacterInfos`）回：
 *       characters     字符串数组（角色目录名，**旧界面在用，形状不能改**）
 *       characterList  对象数组 `[{name, label, language, loaded}]`
 *                       —— `label` 可能为空串（为空时界面显示 `name`）、`language` 是 zh/jp/en/kr 之一、
 *                          `loaded` 是布尔（该角色此刻是否已加载进引擎）
 *   · 管理端「语音」页的角色下拉：**读 `characterList`**；为空或不存在时回退 `characters`，
 *     选项显示 `label || name`、值用 `name`，语言按 zh/jp/en/kr 显示成 中文/日语/英语/韩语
 *     （`label` 末尾已经写着这个语言时不重复追加，见 `charDisplay`）。
 *
 * 放在 `src/lib/` 而不是留在页面里：这里全是纯函数，且 node 能直接 import（`node --test` 实测可跑），
 * 于是"标签为空串显示目录名""语言认不出就不写括号""旧桥只回字符串数组时仍能列出角色"这些
 * 容易写错的分支可以在单测里锁住，而不是靠读代码相信它对。
 */

/** 桥侧 `characterList` 里的一项。`label`/`language`/`loaded` 一律可选：老一些的桥不带它们。 */
export interface LocalStatCharacter {
  name: string;
  label?: string;
  language?: string;
  loaded?: boolean;
}

/** 归一化后的角色（两种来源、两种形状都收成这一份）。 */
export interface LocalChar { name: string; label: string; language: string }

/** 语言代码 → 界面中文名（与「识别语言」下拉框同一套代码）。认不出来就不写括号。 */
export const LANG_LABEL: Record<string, string> = { zh: '中文', jp: '日语', en: '英语', kr: '韩语' };

/** 「（中文）」这类语言后缀的匹配式：全角 `（）` 与半角 `()` 都认，括号内外允许有空格。
 *  语言名是固定四条中文词，仍做一次转义（将来表里加了带正则字符的值也不至于变成别的意思）。 */
const langSuffixRe = (lang: string): RegExp =>
  new RegExp(`[（(]\\s*${lang.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[）)]\\s*$`);

/** 角色在界面上的显示名：`标签（语言）`；标签为空退回目录名，语言不认识就不写括号。
 *
 *  **标签里已经写着这个语言时不再追加**（2026-10-01 实测修的显示 bug）：桥侧的 `label` 有的自带后缀
 *  （`{name:'feibi', label:'菲比（中文）', language:'zh'}`），此前一律再追加一次，下拉框里就成了
 *  「菲比（中文）（中文）」。用户自己 `--add-character` 加的角色往往**没有**后缀
 *  （`label:'我的角色'` + `zh`），那种情况照旧追加成「我的角色（中文）」——
 *  绝不能因为"有的带后缀"就把后缀整个去掉。只对**末尾**是这个语言的后缀去重（中段出现不算）。 */
export const charDisplay = (c: LocalChar): string => {
  const disp = c.label || c.name;
  const lang = LANG_LABEL[c.language] ?? '';
  if (!lang) return disp;
  return langSuffixRe(lang).test(disp) ? disp : `${disp}（${lang}）`;
};

/** 收一个角色项（对象或裸目录名）成 `LocalChar`；name 为空即视为无效项。 */
const toLocalChar = (c: LocalStatCharacter | string | null | undefined): LocalChar | null => {
  if (typeof c === 'string') {
    const name = c.trim();
    return name ? { name, label: '', language: '' } : null;
  }
  if (!c || typeof c !== 'object') return null;
  const name = String(c.name ?? '').trim();
  return name ? { name, label: String(c.label ?? '').trim(), language: String(c.language ?? '').trim() } : null;
};

/** 把 `GET /api/voice/local` 的某个回包里的角色清单收成一份界面用的列表。
 *
 * **读哪一份**：以 `characterList`（对象数组，带 label/language）为准；为空或不存在时回退
 * `characters`（字符串数组）。两份同时存在且不是同一批名字时取并集、`characterList` 在前 ——
 * 对象那份信息更全，但绝不因为"新版字段在"就把旧字段里的角色从下拉框里弄丢
 * （旧桥、或桥侧两份暂时不一致时都可能这样）。
 *
 * 入参只声明用到的两个字段，不绑整个回包类型：这样页面里那份 LocalStat 和单测里的裸对象都能传。 */
export function normalizeChars(
  stat: { characterList?: unknown; characters?: unknown } | null | undefined,
): LocalChar[] {
  const out: LocalChar[] = [];
  const seen = new Set<string>();
  const take = (v: unknown) => {
    if (!Array.isArray(v)) return;
    for (const raw of v) {
      const c = toLocalChar(raw as LocalStatCharacter | string);
      if (!c || seen.has(c.name)) continue;
      seen.add(c.name);
      out.push(c);
    }
  };
  take(stat?.characterList);
  take(stat?.characters);
  return out;
}
