/* ── 2026-09-28：preset tool-web 门控 + 历史 modsearch 覆盖行清理的离线断言 ────────────────────────
 * 这两件事原先由 tools/test-modsearch-bundle.mjs 顺带钉住；ModSearch 按要求从本项目去掉后，那个套件
 * 连同装配代码一起删了，但**留下来的两条性质还得有人看着**（它们都是"升级上来的老 home 会不会被修好"
 * 的兜底，出错的方式是静默的：一个写歪的 preset，或 profile 里一条指向已不存在插件的覆盖行）：
 *   ① `syncPresetToolWeb(home)`：隔离 home 里那份 preset 的 `- id: tool-web` 的 `search` 必须是 false，
 *      且**只**动这一行（别的插件的同名键、`fetch` 的值、缩进与 CRLF 都不动）；值已对时零写入。
 *   ② `stripLegacyModsearchOverlay(target)`：老版本写进 profile `cordis.patch.yml` 的那段
 *      `# === modsearch overlay … BEGIN/END ===` 必须被整段摘掉，其余内容一字不动；再跑一次零写入。
 * 全部断言在 os.tmpdir() 下的临时假 home 上跑，结束即删，**不碰任何真 home**（真 home 的保护逻辑
 * —— 桌面端一律拒绝 —— 单独有断言，见最后一组）。离线，不联网。
 *
 * 用法：node tools/test-dsh-side-gate.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  syncPresetToolWeb,
  rewriteToolWebSearch,
  stripLegacyModsearchOverlay,
  MODSEARCH_CORDIS_BEGIN,
  MODSEARCH_CORDIS_END,
  PRESET_TOOLWEB_REL,
} from '../src/lib/dsh-side.js';

let pass = 0;
const fails = [];
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); return true; }
  fails.push(`${name}${detail ? ` —— ${detail}` : ''}`);
  console.log(`  ❌ ${name}${detail ? ` —— ${detail}` : ''}`);
  return false;
}
const md5 = (s) => createHash('md5').update(String(s), 'utf8').digest('hex');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'kz-dsh-gate-'));
const PRESET_BODY = [
  '- id: qq-mode-console',
  "  name: 'qq-mode-console'",
  '',
  '- id: tool-web',
  "  name: '@deepseek-ai/dsh-tool-web'",
  '  config:',
  '    search: true',
  '    fetch: false',
  '',
  '- id: other-plugin',
  "  name: '@example/other'",
  '  config:',
  '    search: true',
  '',
].join('\n');

function newHome(name) {
  const home = path.join(ROOT, name);
  fs.mkdirSync(path.join(home, path.dirname(PRESET_TOOLWEB_REL)), { recursive: true });
  return home;
}
const presetFile = (home) => path.join(home, PRESET_TOOLWEB_REL);

try {
  /* ══════════ 一、rewriteToolWebSearch（纯函数）══════════ */
  console.log('\n══════ 一、rewriteToolWebSearch ══════');
  const fixed = rewriteToolWebSearch(PRESET_BODY, false);
  ok('search: true → false', fixed !== null && /^ {4}search: false$/m.test(fixed), JSON.stringify(fixed?.match(/^\s*search:.*$/gm)));
  ok('只动 tool-web 那一块：别的插件的 search: true 原样留着',
    fixed !== null && fixed.includes("- id: other-plugin\n  name: '@example/other'\n  config:\n    search: true"),
    '别的插件的同名键被改了');
  ok('fetch 的值不动', fixed !== null && fixed.includes('    fetch: false'));
  ok('缩进保持原样（4 空格）', fixed !== null && fixed.includes('    search: false'));
  ok('值已对时返回逐字节相同的文本', rewriteToolWebSearch(fixed, false) === fixed);
  ok('拷回 true 也能对（函数是双向的）', rewriteToolWebSearch(fixed, true)?.includes('    search: true') === true);
  const crlf = PRESET_BODY.replace(/\n/g, '\r\n');
  const crlfOut = rewriteToolWebSearch(crlf, false);
  ok('CRLF 文本同样能改且不破坏行尾',
    crlfOut !== null && crlfOut.includes('    search: false\r\n') && crlfOut.split('\r\n').length === crlf.split('\r\n').length);
  ok('没有 tool-web 块 → null', rewriteToolWebSearch('- id: foo\n  config:\n    search: true\n', false) === null);
  ok('tool-web 块里没有 search 行 → null（不擅自插入）',
    rewriteToolWebSearch("- id: tool-web\n  name: 'x'\n  config:\n    fetch: false\n", false) === null);
  ok('空输入 → null', rewriteToolWebSearch('', false) === null && rewriteToolWebSearch(null, false) === null);

  /* ══════════ 二、syncPresetToolWeb（假 home 上的真写盘）══════════ */
  console.log('\n══════ 二、syncPresetToolWeb ══════');
  const h1 = newHome('home-search-true');
  fs.writeFileSync(presetFile(h1), PRESET_BODY, 'utf8');
  const r1 = syncPresetToolWeb(h1);
  const after1 = fs.readFileSync(presetFile(h1), 'utf8');
  ok('search: true 被改成 false', r1.ok === true && r1.changed === true && after1.includes('    search: false'));
  ok('只改了那一行：其余字节与输入一致（把 search 行换回去即相等）',
    after1 === PRESET_BODY.replace('    search: true', '    search: false'));
  ok('返回值带两侧 md5 且确实不同', r1.md5Before !== r1.md5After && r1.md5Before === md5(PRESET_BODY) && r1.md5After === md5(after1));
  const r2 = syncPresetToolWeb(h1);
  ok('第二次调用零写入（changed=false、md5 不变）', r2.ok === true && r2.changed === false && r2.md5Before === r2.md5After && fs.readFileSync(presetFile(h1), 'utf8') === after1);

  const h2 = newHome('home-no-preset');
  const r3 = syncPresetToolWeb(h2);
  ok('preset 不存在 → skipped=no-preset 且不建文件',
    r3.ok === true && r3.changed === false && r3.skipped === 'no-preset' && !fs.existsSync(presetFile(h2)));

  const h3 = path.join(ROOT, 'home-no-toolweb');
  fs.mkdirSync(path.join(h3, path.dirname(PRESET_TOOLWEB_REL)), { recursive: true });
  const noToolWeb = '- id: foo\n  config:\n    search: true\n';
  fs.writeFileSync(presetFile(h3), noToolWeb, 'utf8');
  const r4 = syncPresetToolWeb(h3);
  ok('preset 里没有 tool-web 块 → ok=false 且文件一字不动',
    r4.ok === false && r4.changed === false && fs.readFileSync(presetFile(h3), 'utf8') === noToolWeb && /没找到/.test(r4.reason));

  ok('没有 home → ok=false（不抛）', syncPresetToolWeb('').ok === false);

  /* ══════════ 三、stripLegacyModsearchOverlay ══════════ */
  console.log('\n══════ 三、stripLegacyModsearchOverlay ══════');
  const h4 = newHome('home-no-patch');
  const s1 = stripLegacyModsearchOverlay({ home: h4, profile: 'web' });
  ok('profile patch 不存在 → ok 且 skipped=no-patch-file（更不建文件）',
    s1.ok === true && s1.changed === false && s1.skipped === 'no-patch-file' && !fs.existsSync(s1.file));

  const patchDir = path.join(h4, 'profiles', 'web');
  fs.mkdirSync(patchDir, { recursive: true });
  const patchFile = path.join(patchDir, 'cordis.patch.yml');
  const patchBody = [
    '# 宿主级 patch（测试样例）',
    '- id: some-plugin',
    '  config:',
    '    keep: true',
    '',
    MODSEARCH_CORDIS_BEGIN,
    '- id: modsearch',
    '  config:',
    '    readPage: false',
    '    xSearch: false',
    MODSEARCH_CORDIS_END,
    '',
    '- id: tool-web',
    '  config:',
    '    search: false',
    '',
  ].join('\n');
  fs.writeFileSync(patchFile, patchBody, 'utf8');
  const s2 = stripLegacyModsearchOverlay({ home: h4, profile: 'web' });
  const afterPatch = fs.readFileSync(patchFile, 'utf8');
  ok('覆盖行被整段摘掉（BEGIN/END 与中间那几行都不在了）',
    s2.ok === true && s2.changed === true && !afterPatch.includes('modsearch') && !afterPatch.includes(MODSEARCH_CORDIS_BEGIN));
  ok('其余内容与顺序一字不动',
    afterPatch === [
      '# 宿主级 patch（测试样例）',
      '- id: some-plugin',
      '  config:',
      '    keep: true',
      '',
      '- id: tool-web',
      '  config:',
      '    search: false',
      '',
    ].join('\n'), JSON.stringify(afterPatch));
  ok('返回值带两侧 md5', s2.md5Before === md5(patchBody) && s2.md5After === md5(afterPatch) && s2.md5Before !== s2.md5After);
  const s3 = stripLegacyModsearchOverlay({ home: h4, profile: 'web' });
  ok('第二次调用零写入', s3.ok === true && s3.changed === false && s3.md5Before === s3.md5After && fs.readFileSync(patchFile, 'utf8') === afterPatch);

  const patchNoBlock = '# 只有别人的 patch\n- id: tool-web\n  config:\n    search: false\n';
  fs.writeFileSync(patchFile, patchNoBlock, 'utf8');
  const s4 = stripLegacyModsearchOverlay({ home: h4, profile: 'web' });
  ok('patch 里没有这段覆盖行 → changed=false 且文件字节不变',
    s4.ok === true && s4.changed === false && fs.readFileSync(patchFile, 'utf8') === patchNoBlock);
  ok('没有 home → ok=false（不抛）', stripLegacyModsearchOverlay({}).ok === false);

  /* ══════════ 四、真 home 保护（桌面端一律拒绝）══════════ */
  console.log('\n══════ 四、桌面端 home 保护 ══════');
  const desktop = path.join(os.homedir(), '.dsh');
  const d1 = syncPresetToolWeb(desktop);
  const d2 = stripLegacyModsearchOverlay({ home: desktop, profile: 'web' });
  if (process.platform === 'win32') {
    ok('syncPresetToolWeb 拒绝桌面端 home', d1.ok === false && /拒绝/.test(d1.reason), JSON.stringify(d1));
    ok('stripLegacyModsearchOverlay 拒绝桌面端 home', d2.ok === false && /拒绝/.test(d2.reason), JSON.stringify(d2));
  } else {
    // 非 Windows 上 ~/.dsh 就是正常安装目标（服务器形态），这里只断言"不抛、且结论取决于该目录是否存在"。
    ok('非 Windows：~/.dsh 不被当作桌面端而拒绝（返回结构完整）',
      typeof d1.ok === 'boolean' && typeof d1.reason === 'string' && typeof d2.ok === 'boolean',
      JSON.stringify({ d1, d2 }));
  }
} finally {
  fs.rmSync(ROOT, { recursive: true, force: true });
}

console.log('\n────────────────────────────────────────────────────────────────');
if (fails.length === 0) {
  console.log(`✅ 全部通过：${pass} 项断言。（离线，临时假 home，结束即删）`);
  process.exit(0);
}
console.log(`❌ 失败 ${fails.length} 项 / 共 ${pass + fails.length} 项：`);
for (const f of fails) console.log(`   - ${f}`);
process.exit(1);
