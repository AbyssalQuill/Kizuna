// 回归测试（离线，不联网）：我们自己的多平台搜索 `src/lib/web-search.js` + `src/mcp-web-search-safe.js`
// 里"能被静态验证"的那部分。
//
// 为什么单独有这样一个测试：`web_search` 的其余行为都要联网才能验（见 tools/probe-search-platforms.mjs），
// 但下面这些**曾经真的错过**的点完全不需要网络，一旦被改回去就是线上直接退化：
//   ① queryGrams 的 CJK 二元组：原来只取汉字，纯假名查询（「しらたま」）算出空集合 →
//      relevance 全 0 → 整批结果被标成 lowRelevance（2026-09-27 修）；
//   ② 平台表 / 核心集 / 工具 schema 三处必须一致：平台表里有、schema enum 里没有 = 模型根本选不到
//      （google 就这样漏了很久）；核心集里写了平台表里没有的名字 = 早退永远等不到它；
//   ③ Bing RSS 的解析与新闻跳转链解包（离线函数，错了就是静默 0 条）。
// 用法：node tools/test-web-search-offline.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, '..', 'src', 'mcp-web-search-safe.js');
const source = fs.readFileSync(SRC, 'utf8');

// 搜索内核 2026-09-27 抽到 lib/web-search.js（纯函数，不带 MCP stdio 连接）——直接 import，不需要开关
const mod = await import(new URL('../src/lib/web-search.js', import.meta.url).href);
const { SEARCH_PLATFORMS, CORE_PLATFORMS, queryGrams, cleanQuery, parseRssItems, unwrapBingNewsLink } = mod;

let fails = 0;
let total = 0;
const check = (name, ok, extra = '') => { total += 1; if (!ok) fails += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); };

/* ① queryGrams：CJK 二元组必须覆盖假名（2026-09-27 修复的回归点） */
{
  const g = queryGrams('しらたま');
  check('queryGrams：纯假名查询「しらたま」有 gram（不再算成空集合）', g.size >= 3 && g.has('しら') && g.has('らた') && g.has('たま'), `size=${g.size}`);

  const g2 = queryGrams('望月けい');
  check('queryGrams：汉字+假名混合「望月けい」两种都有', g2.has('望月') && g2.has('けい'), [...g2].join('/'));

  const g3 = queryGrams('望月けい pixiv');
  check('queryGrams：拉丁词照旧小写化保留', g3.has('pixiv') && g3.has('望月'), [...g3].join('/'));

  const g4 = queryGrams('メイド');
  check('queryGrams：片假名「メイド」有 gram', g4.has('メイ') && g4.has('イド'), [...g4].join('/'));

  check('queryGrams：空查询仍是空集合', queryGrams('').size === 0);
  check('queryGrams：单个汉字仍保留（原有行为不变）', queryGrams('鬼').has('鬼'));
}

/* ② 平台表 / 核心集 / 工具 schema 的一致性 */
{
  const keys = Object.keys(SEARCH_PLATFORMS);
  const firecrawlOff = String(process.env.QQBRIDGE_FIRECRAWL_OFF || '') !== '';
  const mustHave = ['gnews', 'bingnews', 'zhwiki', 'enwiki', 'jawiki', 'moegirl', 'duckduckgo', 'bing', 'baidu', 'sogou', 'so360', 'moegirl', 'bilibili', 'github', 'stackoverflow', 'google'];
  const missing = mustHave.filter((n) => !keys.includes(n));
  check('平台表包含全部默认平台（含 2026-09-27 新增的 bingnews / jawiki）', missing.length === 0, missing.length ? `缺 ${missing.join(',')}` : `${keys.length} 个平台`);
  check('firecrawl 默认在表里（除非 QQBRIDGE_FIRECRAWL_OFF）', firecrawlOff || keys.includes('firecrawl'));

  const missingCore = [...CORE_PLATFORMS].filter((n) => !keys.includes(n));
  check('核心集里的名字都能在平台表里找到（否则早退永远等不到它）', missingCore.length === 0, missingCore.length ? `幻名 ${missingCore.join(',')}` : `${CORE_PLATFORMS.size} 个核心平台`);
  check('核心集新增 bingnews / jawiki（无 key、机房 IP 可达、快）', CORE_PLATFORMS.has('bingnews') && CORE_PLATFORMS.has('jawiki'));

  const m = source.match(/platforms: z\.array\(z\.enum\(\[([^\]]+)\]\)\)/);
  const enumNames = m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
  check('工具 schema 的 platforms 枚举解析成功', enumNames.length >= 15, `${enumNames.length} 项`);
  const notSelectable = keys.filter((n) => !enumNames.includes(n));
  check('平台表里每个平台都能被模型显式选中（表 ⊆ enum）', notSelectable.length === 0, notSelectable.length ? `选不到 ${notSelectable.join(',')}` : '');
  check('google 已在枚举里（此前长期只在表里、模型选不到）', enumNames.includes('google'));
}

/* ③ RSS 解析与 Bing 新闻跳转链（离线纯函数） */
{
  const xml = [
    '<rss><channel>',
    '<item><title>望月けい、寺田てらなど20人が描く「悪」のイラスト集</title>',
    '<link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;aid=&amp;url=https%3a%2f%2fkai-you.net%2farticle%2f81066&amp;c=5487199103967695619</link>',
    '<description>KADOKAWA が <b>9月29日</b> に発売する。</description><pubDate>Mon, 02 Aug 2021 11:51:00 GMT</pubDate></item>',
    '<item><title><![CDATA[ 第二条 & 测试 ]]></title><link>https://example.com/a</link><description></description></item>',
    '<item><title>没有 link 的条目应被丢掉</title></item>',
    '</channel></rss>',
  ].join('');
  const items = parseRssItems(xml, 12);
  check('parseRssItems：解出 2 条（丢掉没有 link 的那条）', items.length === 2, `实际 ${items.length}`);
  check('parseRssItems：CDATA + 实体 + 首尾空白都处理了', items[1]?.title === '第二条 & 测试', JSON.stringify(items[1]?.title));
  check('parseRssItems：description 里的标签被剥掉', items[0]?.description.includes('9月29日') && !items[0]?.description.includes('<b>'), items[0]?.description);
  check('parseRssItems：limit 生效', parseRssItems(xml, 1).length === 1);
  check('parseRssItems：空输入返回空数组', parseRssItems('', 5).length === 0);

  const unwrapped = unwrapBingNewsLink(items[0].link);
  check('unwrapBingNewsLink：从 apiclick 跳转链解出真实地址', unwrapped === 'https://kai-you.net/article/81066', unwrapped);
  check('unwrapBingNewsLink：本来就是真实地址时原样返回', unwrapBingNewsLink('https://example.com/x') === 'https://example.com/x');
  check('unwrapBingNewsLink：垃圾输入不抛异常', unwrapBingNewsLink('not a url') === 'not a url');
}

/* ④ cleanQuery 的基础约束（不联网） */
{
  check('cleanQuery：去掉 CQ 码', !cleanQuery('[CQ:face,id=1] 贴贴').includes('CQ:'));
  check('cleanQuery：空输入返回空串', cleanQuery('   ').length === 0);
  check('cleanQuery 是函数且 searchAll 已导出', typeof cleanQuery === 'function' && typeof mod.searchAll === 'function');
}

console.log(fails === 0 ? `\nALL PASS（${total} 项）` : `\nFAILED（${total} 项里失败 ${fails} 项）`);
process.exit(fails === 0 ? 0 : 1);
