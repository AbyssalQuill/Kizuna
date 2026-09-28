// 多平台聚合搜索内核（2026-09-27 从 mcp-web-search-safe.js 抽出来的那一段）。
//
// 为什么单独成文件：MCP server 那份的末尾会 await server.connect()（stdio 服务），而桥进程里的
// 「按画师名定 pixiv 号」那条路只想直接调 searchAll()，不能为此 spawn 一个 MCP 子进程；
// 抽成纯函数库之后两边共用同一份平台表、同一套相关度判据与同一个 5 分钟缓存。
//
// 边界：本文件**不依赖 @modelcontextprotocol/sdk**，也不碰 web_fetch 那套 SSRF 防护
// （那部分仍在 mcp-web-search-safe.js：DNS 预解析、逐跳校验、限量读取）。这里只有一个出站地址
// 需要校验 —— QQBRIDGE_FIRECRAWL_BASE（唯一一个可被外界改写的地址），复用 safe-fetch 的校验。
//
// 导出面：searchAll（聚合入口）、SEARCH_PLATFORMS / CORE_PLATFORMS（平台表与核心集）、
// cleanQuery / queryGrams（查询词清洗与相关度用的二元组）、parseRssItems / unwrapBingNewsLink
// （RSS 解析，离线可测）。其余都是内部实现。
import { validateFetchUrl as validateOutboundUrl } from '../safe-fetch.js';

function decodeHtml(s) {
  return String(s ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ───────────────────────── 多平台聚合搜索（2026-09-16）─────────────────────────
 * 原来只有一个后端（cn.bing.com）、15 秒超时、最多 8 条，而且工具描述写着"仅用于理解词义"——
 * 于是模型遇到不懂的东西要么少搜、要么去问用户。现在：
 *   · 多平台并行：Bing / DuckDuckGo / 百度 / 搜狗 / Mojeek 同时发（谁先回谁先用）；
 *   · 快速返回：每个后端 7 秒硬超时；只要 2 个平台回来了、去重后够 maxResults 条就立刻返回，
 *     不等最慢的那个（整体耗时 ≈ 最快那个平台，而不是五个串起来）；
 *   · 合并去重：按规范化 URL（去掉 utm_/spm 等跟踪参数）去重，多平台命中同一条只留一次；
 *   · 没有条数/次数限制：调用次数不限，返回条数由 maxResults 决定（默认 12，最多 30）；
 *   · 5 分钟缓存：同一查询 + 同样参数直接命中缓存（秒回），避免重复联网。
 */
const SEARCH_TIMEOUT_MS = 7000;
const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const SEARCH_CACHE_MAX = 200;
const searchCache = new Map();

const SEARCH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function cacheGet(key) {
  const hit = searchCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > SEARCH_CACHE_TTL_MS) { searchCache.delete(key); return null; }
  return hit.value;
}
function cacheSet(key, value) {
  searchCache.set(key, { at: Date.now(), value });
  if (searchCache.size > SEARCH_CACHE_MAX) {
    for (const [k, v] of searchCache) { if (Date.now() - v.at > SEARCH_CACHE_TTL_MS) searchCache.delete(k); }
    while (searchCache.size > SEARCH_CACHE_MAX) { const first = searchCache.keys().next().value; searchCache.delete(first); }
  }
}

/** 去掉跟踪参数，便于跨平台去重 */
function normalizeUrl(raw) {
  try {
    const u = new URL(String(raw));
    const drop = [];
    for (const k of u.searchParams.keys()) {
      if (/^(utm_|spm|from|fr|src|ref|refer|wd|sa|ved|usg|tn|rsv_|bsst|_?client)/i.test(k)) drop.push(k);
    }
    for (const k of drop) u.searchParams.delete(k);
    u.hash = '';
    let s = u.toString();
    if (s.endsWith('?')) s = s.slice(0, -1);
    return s.replace(/\/$/, '');
  } catch { return String(raw || '').trim(); }
}

/** DuckDuckGo 的跳转链（//duckduckgo.com/l/?uddg=…）解出真实地址 */
function unwrapDuck(raw) {
  try {
    const s = String(raw);
    const u = new URL(s.startsWith('//') ? 'https:' + s : s);
    const target = u.searchParams.get('uddg');
    return target ? decodeURIComponent(target) : s;
  } catch { return String(raw || ''); }
}

async function fetchSearchHtml(url, timeoutMs = SEARCH_TIMEOUT_MS) {
  const res = await fetch(url, {
    headers: { 'user-agent': SEARCH_UA, 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

function pushResult(out, { title, url, snippet }, limit) {
  const t = decodeHtml(title);
  const u = normalizeUrl(url);
  if (!t || !u || !/^https?:\/\//i.test(u)) return;
  if (out.some((r) => r.url === u)) return;
  out.push({ title: t.slice(0, 200), url: u, snippet: decodeHtml(snippet || '').slice(0, 400) });
  void limit;
}

async function bingSearch(query) {
  const url = new URL('https://www.bing.com/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', '20');
  // 中文查询走中国区市场，结果更贴中文语境（实测国际站 bing.com 可达、cn.bing.com 从境外 IP 常被截断）
  if (/[\u4e00-\u9fa5]/.test(query)) { url.searchParams.set('mkt', 'zh-CN'); url.searchParams.set('setlang', 'zh-CN'); }
  const html = await fetchSearchHtml(url);
  const out = [];
  for (const block of html.split('<li class="b_algo"').slice(1)) {
    const href = block.match(/<a[^>]+href="(https?:\/\/[^"]+)"/i);
    if (!href) continue;
    const title = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const snippet = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    pushResult(out, { title: title ? title[1] : '', url: href[1], snippet: snippet ? snippet[1] : '' });
    if (out.length >= 12) break;
  }
  // 2026-09-27：境外机房 IP 下 HTML 页解析出 0 条（德国 VPS 实测 HTTP 200 / 114KB，但整页没有任何
  // b_algo 块），而同一 IP 的 **RSS 出口是通的**，于是 HTML 空手时补一次 RSS。RSS 对**拉丁文查询**
  // 给的是真结果（openai gpt-5 → openai.com / chatgpt.com；node fetch timeout → nodejs.org），
  // 对中日文查询这个 IP 会返回东南亚的无关条目（「望月けい pixiv」→「37手游」、马来亚大学登录页）——
  // 那些条目跟查询词没有任何共同 gram，会被 searchAll 的相关度闸门丢掉，不会污染最终结果。
  if (!out.length) {
    const rss = new URL('https://www.bing.com/search');
    rss.searchParams.set('q', query);
    rss.searchParams.set('format', 'rss');
    rss.searchParams.set('count', '20');
    const xml = await fetchSearchHtml(rss);
    for (const item of parseRssItems(xml, 12)) {
      pushResult(out, { title: item.title, url: item.link, snippet: item.description });
    }
  }
  return out;
}

/** 360 搜索（国内网络可用；境外 IP 常被拦，失败即跳过） */
async function so360Search(query) {
  const url = new URL('https://www.so.com/s');
  url.searchParams.set('q', query);
  const html = await fetchSearchHtml(url);
  const out = [];
  for (const block of html.split(/<li class="res-list"/i).slice(1)) {
    const href = block.match(/<a[^>]+href="(https?:\/\/[^"]+)"/i);
    const title = block.match(/<h3[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i);
    const snippet = block.match(/class="res-desc"[^>]*>([\s\S]*?)<\/p>/i) || block.match(/class="res-rich[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    if (!href || !title) continue;
    pushResult(out, { title: title[1], url: href[1], snippet: snippet ? snippet[1] : '' });
    if (out.length >= 10) break;
  }
  return out;
}

/** 萌娘百科站内搜索（ACG 梗/角色/作品最对口；API 需要授权，所以走搜索页 HTML） */
async function moegirlSearch(query) {
  const url = new URL('https://zh.moegirl.org.cn/index.php');
  url.searchParams.set('search', query);
  url.searchParams.set('title', 'Special:搜索');
  url.searchParams.set('fulltext', '1');
  const html = await fetchSearchHtml(url);
  const out = [];
  for (const block of html.split(/<li[^>]+class="mw-search-result[^"]*"/i).slice(1)) {
    const href = block.match(/href="(\/index\.php\?[^"]+|\/[^"]+)"/i);
    const title = block.match(/title="([^"]+)"/i);
    const snippet = block.match(/class="searchresult">([\s\S]*?)<\/div>/i);
    if (!href) continue;
    pushResult(out, {
      title: title ? title[1] : '',
      url: new URL(decodeHtml(href[1]), 'https://zh.moegirl.org.cn').toString(),
      snippet: snippet ? snippet[1] : '',
    });
    if (out.length >= 8) break;
  }
  return out;
}

/** 维基百科（中/英/日）MediaWiki API：事实、人物、作品、术语的可靠覆盖面。
 *  429 是它的常态限流（同一 IP 短时间多次查询）——退避重试一次，仍失败就交给其它平台。 */
const WIKI_LABEL = { zh: '中文维基', en: 'Wikipedia', ja: '日文维基' };
async function wikiSearch(query, lang = 'zh') {
  const build = () => {
    const url = new URL(`https://${lang}.wikipedia.org/w/api.php`);
    url.searchParams.set('action', 'query');
    url.searchParams.set('list', 'search');
    url.searchParams.set('srsearch', query);
    url.searchParams.set('srlimit', '6');
    url.searchParams.set('format', 'json');
    url.searchParams.set('utf8', '1');
    return url;
  };
  const attempt = async () => {
    const res = await fetch(build(), {
      headers: {
        // 维基要求可识别的 UA（带联系方式），否则容易被限流
        'user-agent': 'KizunaQQBridge/1.0 (https://github.com/AbyssalQuill/Kizuna; web search for a QQ chat bot)',
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    if (res.status === 429) throw new Error('HTTP 429');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json().catch(() => null);
  };
  let j = null;
  try {
    j = await attempt();
  } catch (error) {
    if (!String(error?.message || '').includes('429')) throw error;
    await new Promise((r) => setTimeout(r, 700));
    j = await attempt();
  }
  const hits = Array.isArray(j?.query?.search) ? j.query.search : [];
  return hits.map((h) => ({
    title: `${h.title} · ${WIKI_LABEL[lang] || 'Wikipedia'}`,
    url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(String(h.title).replace(/\s+/g, '_'))}`,
    snippet: decodeHtml(String(h.snippet || '')).slice(0, 400),
  }));
}
const zhwikiSearch = (q) => wikiSearch(q, 'zh');
const enwikiSearch = (q) => wikiSearch(q, 'en');
// 2026-09-27：日文维基也挂上。查画师/作品时日文条目的命中率明显高（中文维基常常整屏无关，
// 见线上实测「望月けい pixiv」中文维基返回的是「楠木同學的高中出道計畫瀕臨失敗」），
// 而 ja.wikipedia 的 API 从境外 VPS 与国内都通、无 key、约 550ms。
const jawikiSearch = (q) => wikiSearch(q, 'ja');

/**
 * Google News RSS（实测从境外 VPS 唯一稳定的中文检索源：2026-09-16 查「宁芙奖」得 52 条、
 * 354ms，全是第五人格「宁芙奖」相关报道；同一时刻 Bing 从该 IP 返回的是完全无关的结果、
 * 百度/搜狗/360/searx 是验证码或 429）。普通 HTML 搜索页对机房 IP 基本都不友好，RSS 没事。
 */
async function gnewsSearch(query) {
  const url = new URL('https://news.google.com/rss/search');
  url.searchParams.set('q', query);
  url.searchParams.set('hl', 'zh-CN');
  url.searchParams.set('gl', 'CN');
  url.searchParams.set('ceid', 'CN:zh-Hans');
  const res = await fetch(url, { headers: { 'user-agent': SEARCH_UA, 'accept-language': 'zh-CN,zh;q=0.9' }, signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  const out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1];
    const title = (block.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    const link = (block.match(/<link>([\s\S]*?)<\/link>/i)?.[1] || '').trim();
    const desc = (block.match(/<description>([\s\S]*?)<\/description>/i)?.[1] || '')
      .replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, ' ');
    const source = (block.match(/<source[^>]*>([\s\S]*?)<\/source>/i)?.[1] || '').trim();
    if (!title || !link) continue;
    pushResult(out, { title: source ? `${title}` : title, url: link, snippet: `${desc}${source ? '（' + source + '）' : ''}` });
    if (out.length >= 14) break;
  }
  return out;
}

/** 通用 RSS 2.0 解析（Bing 网页/新闻 RSS 与 Google News 都是这一套字段）。导出给离线测试用。 */
export function parseRssItems(xml, limit = 12) {
  const out = [];
  for (const m of String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1];
    const pick = (tag) => (block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'))?.[1] || '')
      .replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    const title = pick('title');
    const link = pick('link');
    if (!title || !link) continue;
    out.push({ title, link, description: pick('description').replace(/<[^>]+>/g, ' ') });
    if (out.length >= limit) break;
  }
  return out;
}

/** Bing 新闻 RSS 的 <link> 是 apiclick.aspx?…&url=<真实地址> 的跳转链，解出 url= 参数才是原文地址。导出给离线测试用。 */
export function unwrapBingNewsLink(raw) {
  try {
    const u = new URL(decodeHtml(String(raw)));
    const real = u.searchParams.get('url');
    return real ? decodeURIComponent(real) : String(raw);
  } catch { return String(raw || ''); }
}

/** Bing 新闻 RSS（2026-09-27 德国 VPS 实测：无 key、约 370ms、10~12 条，而且**中日文查询都真的相关**
 *  ——「望月けい」→ 個展「俗世」的报道，「openai」→ 中文科技媒体稿）。它和 gnews 互补：
 *  gnews 在境外对中文时事稳（实测「第五人格 宁芙奖」100 条）但对日文弱，Bing 新闻反过来。
 *  同样走 RSS：普通 HTML 搜索页对机房 IP 基本都不友好，RSS 出口没事。 */
async function bingNewsSearch(query) {
  const url = new URL('https://www.bing.com/news/search');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'rss');
  const xml = await fetchSearchHtml(url);
  const out = [];
  for (const item of parseRssItems(xml, 12)) {
    pushResult(out, { title: item.title, url: unwrapBingNewsLink(item.link), snippet: item.description });
  }
  return out;
}

/* ── 查询词清洗：把"是什么 / 什么意思 / 是谁 / 帮我查一下"这类问句外壳剥掉 ──
 * 实测 2026-09-16：把「宁芙奖 是什么」原样丢给维基/Bing，匹配会飘到毫不相干的条目；
 * 「这个梗是什么意思 贴贴」更是直接搜成了"这个"这个字的词典解释。
 * 剥成「宁芙奖」/「贴贴」之后命中率明显变好（全文检索对问句外壳和虚词特别敏感）。 */
const QUERY_FILLER_RE = /(是什么意思|什么意思|啥意思|是啥意思|什么梗|是啥|是什么|是谁|谁啊|怎么办|怎么样|为什么|为啥|多少|多少钱|请问|帮我|帮忙|查一下|搜一下|有谁知道|这个|那个|到底|究竟|意思|含义|解释|梗)/g;
/** 只允许剥掉**结尾**的单字语气词：`我的世界` 这种不能把"的"挖掉。 */
const TRAILING_PARTICLES = /[吗呢啊呀啦吧嘛的了哦喔诶]$/;
export function cleanQuery(raw) {
  const original = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  let s = original
    .replace(/[？?。！!，,、；;：:"'「」『』（）()【】\[\]]/g, ' ')
    .replace(QUERY_FILLER_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (let i = 0; i < 3; i += 1) s = s.replace(TRAILING_PARTICLES, '').trim();
  return s.length >= 2 ? s : original;
}

/** 相关度打分：查询词（中文 2-gram + 英文/数字词）在标题/摘要里命中越多分越高。 */
function relevance(result, grams) {
  if (!grams.size) return 0;
  const title = String(result.title || '').toLowerCase();
  const body = String(result.snippet || '').toLowerCase();
  let score = 0;
  for (const g of grams) {
    if (title.includes(g)) score += 2;
    else if (body.includes(g)) score += 1;
  }
  return score;
}

export function queryGrams(query) {
  const t = String(query || '').toLowerCase();
  const set = new Set();
  for (const w of t.match(/[a-z0-9]{2,}/g) || []) set.add(w);
  // 2026-09-27：CJK 二元组原来只取汉字（\u4e00-\u9fa5），于是「しらたま」「ゆき」这类**纯假名**查询
  // 算出的是空集合 → relevance 全为 0 → 整批结果被标成 lowRelevance。日文画师名正是本项目最常见的
  // 查询类型，所以把假名并进来（平假名 \u3040-\u309f、片假名 \u30a0-\u30ff、半角片假名 \uff66-\uff9f）。
  const cjk = t.replace(/[^\u3040-\u30ff\u4e00-\u9fa5\uff66-\uff9f]/g, '');
  for (let i = 0; i + 2 <= cjk.length; i += 1) set.add(cjk.slice(i, i + 2));
  if (cjk.length === 1) set.add(cjk);
  return set;
}

async function duckSearch(query) {
  const url = new URL('https://html.duckduckgo.com/html/');
  url.searchParams.set('q', query);
  const html = await fetchSearchHtml(url);
  const out = [];
  const blocks = html.split('class="result__body"').slice(1);
  for (const block of blocks) {
    const href = block.match(/<a[^>]+class="result__a"[^>]+href="([^"]+)"/i) || block.match(/href="(\/\/duckduckgo\.com\/l\/[^"]+)"/i);
    if (!href) continue;
    const title = block.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/i);
    const snippet = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);
    pushResult(out, { title: title ? title[1] : '', url: unwrapDuck(decodeHtml(href[1])), snippet: snippet ? snippet[1] : '' });
    if (out.length >= 12) break;
  }
  return out;
}

async function baiduSearch(query) {
  const url = new URL('https://www.baidu.com/s');
  url.searchParams.set('wd', query);
  url.searchParams.set('rn', '20');
  const html = await fetchSearchHtml(url);
  const out = [];
  for (const block of html.split(/<div[^>]+class="result[^"]*c-container/i).slice(1)) {
    const href = block.match(/<h3[^>]*>\s*<a[^>]+href="([^"]+)"/i) || block.match(/<a[^>]+href="(https?:\/\/[^"]+)"/i);
    const title = block.match(/<h3[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/i);
    const snippet = block.match(/class="(?:c-abstract|content-right_[^"]*)"[^>]*>([\s\S]*?)<\/div>/i) || block.match(/class="c-span-last[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    if (!href || !title) continue;
    pushResult(out, { title: title[1], url: decodeHtml(href[1]).replace(/^http:/, 'https:'), snippet: snippet ? snippet[1] : '' });
    if (out.length >= 12) break;
  }
  return out;
}

async function sogouSearch(query) {
  const url = new URL('https://www.sogou.com/web');
  url.searchParams.set('query', query);
  const html = await fetchSearchHtml(url);
  const out = [];
  for (const block of html.split(/<div[^>]+class="(?:vrwrap|rb)"[^>]*>/i).slice(1)) {
    const href = block.match(/<h3[^>]*>\s*<a[^>]+href="([^"]+)"/i) || block.match(/<a[^>]+href="(\/link\?url=[^"]+)"/i);
    const title = block.match(/<h3[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/i);
    const snippet = block.match(/class="(?:str_info|space-txt|fz-mid|text-layout)[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    if (!href || !title) continue;
    const raw = decodeHtml(href[1]);
    pushResult(out, { title: title[1], url: raw.startsWith('http') ? raw : new URL(raw, 'https://www.sogou.com').toString(), snippet: snippet ? snippet[1] : '' });
    if (out.length >= 10) break;
  }
  return out;
}

async function mojeekSearch(query) {
  const url = new URL('https://www.mojeek.com/search');
  url.searchParams.set('q', query);
  const html = await fetchSearchHtml(url);
  const out = [];
  for (const block of html.split(/<li>\s*<h2>/i).slice(1)) {
    const href = block.match(/<a[^>]+href="(https?:\/\/[^"]+)"/i);
    const title = block.match(/<a[^>]*>([\s\S]*?)<\/a>/i);
    const snippet = block.match(/<p class="s">([\s\S]*?)<\/p>/i);
    if (!href || !title) continue;
    pushResult(out, { title: title[1], url: href[1], snippet: snippet ? snippet[1] : '' });
    if (out.length >= 10) break;
  }
  return out;
}

/* ============================================================================
 * 2026-09-17 扩容：多聚合引擎
 *
 * 原有的 10 个平台（gnews/zhwiki/enwiki/moegirl/duckduckgo/bing/baidu/sogou/so360/mojeek）
 * 偏"通用 + 中文百科"，缺三类东西：
 *   ① 中文长尾内容（知乎/公众号式文章）—— 用雅虎/必应系之外的独立索引补；
 *   ② 视频（B 站）—— 直接接官方搜索 API，比让模型拿网页搜索去猜准得多；
 *   ③ 技术资料（GitHub / Stack Overflow）—— 用官方 JSON API，稳且不占配额。
 *
 * 所有新平台都遵守同一个契约：失败就抛错，由 searchAll() 收进 failures 并继续，
 * 绝不因为一个平台挂了让整次搜索失败。返回行统一 { title, url, snippet }。
 * ========================================================================== */

/** 雅虎（独立索引，中文长尾比 Bing 好；HTML 结果块稳定） */
async function yahooSearch(query) {
  const url = new URL('https://search.yahoo.com/search');
  url.searchParams.set('p', query);
  url.searchParams.set('ei', 'UTF-8');
  const html = await fetchSearchHtml(url);
  const out = [];
  for (const block of html.split(/<div class="algo[^"]*"/i).slice(1)) {
    const href = block.match(/<a[^>]+href="(https?:\/\/[^"]+)"/i);
    const title = block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
    const snippet = block.match(/<div class="compText[^"]*"[^>]*>([\s\S]*?)<\/div>/i) || block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    if (!href || !title) continue;
    pushResult(out, { title: title[1], url: href[1], snippet: snippet ? snippet[1] : '' });
    if (out.length >= 10) break;
  }
  return out;
}

/** Yandex（俄区索引，对中文也有覆盖；结果块 class="serp-item"） */
async function yandexSearch(query) {
  const url = new URL('https://yandex.com/search/');
  url.searchParams.set('text', query);
  const html = await fetchSearchHtml(url);
  const out = [];
  for (const block of html.split(/<li class="serp-item"/i).slice(1)) {
    const href = block.match(/href="(https?:\/\/[^"]+)"/i);
    const title = block.match(/<h2[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i) || block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const snippet = block.match(/class="OrganicTextContentSpan[^"]*"[^>]*>([\s\S]*?)<\/span>/i) || block.match(/<div class="text-container[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    if (!href || !title) continue;
    pushResult(out, { title: title[1], url: href[1], snippet: snippet ? snippet[1] : '' });
    if (out.length >= 10) break;
  }
  return out;
}

/** Brave Search（独立索引） */
async function braveSearch(query) {
  const url = new URL('https://search.brave.com/search');
  url.searchParams.set('q', query);
  const html = await fetchSearchHtml(url);
  const out = [];
  for (const block of html.split(/<div class="snippet[^"]*"/i).slice(1)) {
    const href = block.match(/href="(https?:\/\/[^"]+)"/i);
    const title = block.match(/<div class="title[^"]*"[^>]*>([\s\S]*?)<\/div>/i) || block.match(/<a[^>]*>([\s\S]*?)<\/a>/i);
    const snippet = block.match(/<div class="snippet-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i) || block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    if (!href || !title) continue;
    pushResult(out, { title: title[1], url: href[1], snippet: snippet ? snippet[1] : '' });
    if (out.length >= 10) break;
  }
  return out;
}

/** Ecosia（Bing 后端 + 自己的排序，HTML 结果块固定 class="result"） */
async function ecosiaSearch(query) {
  const url = new URL('https://www.ecosia.org/search');
  url.searchParams.set('q', query);
  const html = await fetchSearchHtml(url);
  const out = [];
  for (const block of html.split(/<article[^>]*class="[^"]*result[^"]*"/i).slice(1)) {
    const href = block.match(/href="(https?:\/\/[^"]+)"/i);
    const title = block.match(/<h2[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i) || block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const snippet = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    if (!href || !title) continue;
    pushResult(out, { title: title[1], url: href[1], snippet: snippet ? snippet[1] : '' });
    if (out.length >= 10) break;
  }
  return out;
}

/** Marginalia：独立小索引，专收"非 SEO 站点"（技术博客、个人站），长尾技术问题很好用 */
async function marginaliaSearch(query) {
  const url = new URL('https://search.marginalia.nu/search');
  url.searchParams.set('query', query);
  const html = await fetchSearchHtml(url);
  const out = [];
  for (const block of html.split(/<div class="card search-result"/i).slice(1)) {
    const href = block.match(/<a[^>]+href="(https?:\/\/[^"]+)"/i);
    const title = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i) || block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const snippet = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    if (!href || !title) continue;
    pushResult(out, { title: title[1], url: href[1], snippet: snippet ? snippet[1] : '' });
    if (out.length >= 10) break;
  }
  return out;
}

/** GitHub 仓库/代码搜索（公开 API，轻量调用不需要 token） */
async function githubSearch(query) {
  const url = new URL('https://api.github.com/search/repositories');
  url.searchParams.set('q', query);
  url.searchParams.set('per_page', '8');
  const res = await fetch(url, {
    headers: { 'user-agent': 'KizunaQQBridge/1.0', accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  return (j.items || []).map((r) => ({
    title: r.full_name + (r.description ? ` — ${r.description}` : ''),
    url: r.html_url,
    snippet: [
      r.language && `语言 ${r.language}`,
      Number.isFinite(r.stargazers_count) && `${r.stargazers_count} star`,
      r.updated_at && `更新 ${String(r.updated_at).slice(0, 10)}`,
      r.description || '',
    ].filter(Boolean).join(' · ').slice(0, 400),
  })).filter((r) => r.title);
}

/** Stack Overflow / StackExchange 公开 API（写代码、报错信息查询的权威来源） */
async function stackSearch(query) {
  const url = new URL('https://api.stackexchange.com/2.3/search/advanced');
  url.searchParams.set('order', 'desc');
  url.searchParams.set('sort', 'relevance');
  url.searchParams.set('q', query);
  url.searchParams.set('site', 'stackoverflow');
  url.searchParams.set('pagesize', '8');
  url.searchParams.set('filter', 'default');
  const res = await fetch(url, { headers: { 'user-agent': 'KizunaQQBridge/1.0' }, signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  return (j.items || []).map((it) => ({
    title: decodeHtml(it.title || ''),
    url: it.link,
    snippet: [
      it.is_answered ? '已有采纳答案' : '尚无采纳答案',
      Number.isFinite(it.score) && `${it.score} 分`,
      Number.isFinite(it.answer_count) && `${it.answer_count} 个回答`,
      (it.tags || []).slice(0, 4).join(' '),
    ].filter(Boolean).join(' · '),
  })).filter((r) => r.title);
}

/** B 站视频搜索（官方 JSON API；"这首/这个视频"类问题直接给视频而不是网页） */
async function bilibiliPlatformSearch(query) {
  const { videoSearch: biliVideoSearch } = await import('./core/video.js');
  const r = await biliVideoSearch(query, { limit: 8 });
  return (r.results || []).map((v) => ({
    title: v.title,
    url: v.url,
    snippet: [
      v.author && `UP ${v.author}`,
      v.duration && `时长 ${v.duration}`,
      v.playText && `${v.playText}播放`,
      v.typeName,
    ].filter(Boolean).join(' · '),
  })).filter((x) => x.title && x.url);
}

/* ----------------------------------------------------------------------------
 * 平台清单 —— 2026-09-17 在线上那台机器上逐引擎实测后定稿（中英各一个查询，各跑两次）
 *
 *   可用：gnews(14/14) zhwiki(6/6) enwiki(0/6) moegirl(8/8) bing(10/7)
 *         bilibili(8/8) github(5/8) stackoverflow(0/8)
 *   能用但会限速（忙时会返回 0 条）：baidu sogou duckduckgo yandex
 *   结构上不通（每次都硬报错，留着只是噪声）：
 *         yahoo(HTTP 500) brave(HTTP 429) ecosia(HTTP 403) marginalia(fetch failed)
 *
 * 所以下面只挂"实测过得去"的平台；那几个不通的函数保留（网络环境变了随时能启用），
 * 用环境变量挂回来即可：QQBRIDGE_SEARCH_EXTRA=yahoo,brave,ecosia,marginalia,yandex
 * -------------------------------------------------------------------------- */
const EXTRA_PLATFORMS = String(process.env.QQBRIDGE_SEARCH_EXTRA ?? '')
  .split(',').map((s) => s.trim()).filter(Boolean);

/** Google（走 /search 的 HTML；从机房 IP 常被换成验证码页，失败由 searchAll 收进 failures） */
async function googleSearch(query) {
  const url = new URL('https://www.google.com/search');
  url.searchParams.set('q', query);
  url.searchParams.set('num', '20');
  url.searchParams.set('hl', /[\u4e00-\u9fa5]/.test(query) ? 'zh-CN' : 'en');
  const html = await fetchSearchHtml(url);
  if (/id="captcha-form"|Our systems have detected unusual traffic|unusual traffic/i.test(html)) {
    throw new Error('被 Google 要求人机验证（机房 IP 常态）');
  }
  const out = [];
  // Google 的结果块：<div class="g">…<a href="/url?q=…"> 或直接 https 链接
  for (const block of html.split(/<div class="[^"]*\bGx5Zad\b[^"]*"|<div class="g"/i).slice(1)) {
    const href = block.match(/href="(https?:\/\/[^"]+)"/i) || block.match(/href="\/url\?q=([^&"]+)/i);
    if (!href) continue;
    let u = decodeHtml(href[1]);
    if (!/^https?:/i.test(u)) { try { u = decodeURIComponent(u); } catch { /* ignore */ } }
    const title = block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
    const snippet = block.match(/<div[^>]*class="[^"]*(?:VwiC3b|yXK7lf)[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
      || block.match(/<span[^>]*>([\s\S]{40,400}?)<\/span>/i);
    if (!title || !u) continue;
    pushResult(out, { title: title[1], url: u, snippet: snippet ? snippet[1] : '' });
    if (out.length >= 12) break;
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════════════════════
 * Firecrawl v2 搜索（2026-09-28 新增）—— 免 key 即可用，作为**优先来源**
 *
 * 现象：线上那台香港机器实测各平台条数 {google:0, bing:0, sogou:0, baidu:0, duckduckgo:0, moegirl:8}。
 *   注意这不是"网络不通"：那几个抓结果页的引擎是**静默归零**（拿回的是风控/验证码页，
 *   正则切不出结果块，于是既不报错也没有结果，failures 里也看不到），整个 web_search 实际只剩萌娘百科出条。
 *
 * 依据（2026-09-28 在服务器上直接实测，不带任何 key）：
 *   POST https://api.firecrawl.dev/v2/search  {"query":"望月けい pixiv","limit":5}
 *   → HTTP 200 / 1.52s，响应 {success:true, data:{web:[{url,title,description,position}]}, creditsUsed:2, id:"01a0e3f9…"}
 *     5 条全是真结果：pixiv 画师页、x.com/key_999、pixiv 标签页、dic.pixiv 百科、pixivision 访谈。
 *   同一查询 limit=15 → data.web 15 条 / creditsUsed=4；中文查询「宁芙奖 第五人格」limit=10 → HTTP 200 / 0.95s / creditsUsed=2；
 *   limit=1 也是 creditsUsed=2（所以默认取 10 条是"同样的钱多拿 9 条"）。
 *   {"query":""} → HTTP 200 {success:true,data:{},creditsUsed:0}（data 是空对象，**不是**报错——这种就走"空数组"而不是抛错）。
 *   sources 默认只给 web；显式 sources:["news"] 时字段名变成 data.news[].snippet + date（下面的归一化两种都认）。
 *   额度耗尽的形状（本机这台 Windows 的出口 IP 实测已被打满，服务器 IP 同期正常）：
 *   HTTP 429 {"success":false,"error":"You've hit Firecrawl's keyless free tier rate limit. …","reason":"credits","retry_after_seconds":27818}
 *   即：免 key 额度按**出口 IP** 计（不是按进程/账号），耗尽后约 7.7 小时才恢复；服务器 IP 目前健康。
 *
 * 判据：抓别人的结果页要猜 HTML 结构（改版就瞎、被风控就静默归零），而这是官方 JSON 接口、字段固定、
 *   1 秒上下返回 —— 稳一个量级。所以它排在平台表**第一位**，并且进 CORE_PLATFORMS：
 *   早退必须等它，否则会拿着 bing 那类 150ms 就回来的垃圾结果提前收工（见 CORE_PLATFORMS 注释）。
 *   （说明：最终结果列表是 interleave() 按各平台**完成顺序**交错后再按相关度排序的，
 *    "优先"在这里的确切含义 = 默认平台清单的第一个 + 早退等它；没有去改 interleave 的输入顺序，
 *    因为那会动到其它平台结果的相对次序。）
 *
 * 为什么没走 safe-fetch（本文件叫 -safe，这一条必须说清）：safe-fetch.js 只有 GET
 *   （requestOnce / requestOnceBuffer 都是 method:'GET'，不接受请求体/自定义方法），而 Firecrawl 是 POST + JSON；
 *   实测 GET /v2/search → HTTP 405 {"code":"METHOD_NOT_ALLOWED","allowed_methods":["POST"]}，这条路物理上走不通。
 *   本文件里"抓取类"平台本来就全是裸 fetch + 硬编码域名（bing/baidu/sogou/维基/GitHub 同理），
 *   safe-fetch 那套 SSRF 闸门是给**用户可填 URL**的入口用的（web_fetch、图片下载），不是给固定上游用的。
 *   唯一一个"外面能改的出站地址"是 QQBRIDGE_FIRECRAWL_BASE，它单独过 validateOutboundUrl（见 assertFirecrawlBase）。
 *
 * 环境变量（一个字都不配也能用；全部写在这里，别处没有）：
 *   FIRECRAWL_API_KEY / QQBRIDGE_FIRECRAWL_KEY  有值就带 Authorization: Bearer <key>（前者优先，后者是本桥命名习惯的别名）
 *   QQBRIDGE_FIRECRAWL_BASE                     换域名或自建代理，默认 https://api.firecrawl.dev（会先过 safe-fetch 的 SSRF 校验）
 *   QQBRIDGE_FIRECRAWL_OFF=1|true|yes|on        整体关掉：不注册进平台表，一次请求都不发
 *   （本平台默认就在表里，不走既有的 QQBRIDGE_SEARCH_EXTRA —— 那个只负责把 SHELVED_PLATFORMS 挂回来）
 * ══════════════════════════════════════════════════════════════════════════════ */
const FIRECRAWL_OFF = /^(1|true|yes|on)$/i.test(String(process.env.QQBRIDGE_FIRECRAWL_OFF ?? '').trim());
const FIRECRAWL_BASE = String(process.env.QQBRIDGE_FIRECRAWL_BASE || 'https://api.firecrawl.dev').replace(/\/+$/, '');
const FIRECRAWL_KEY = String(process.env.FIRECRAWL_API_KEY || process.env.QQBRIDGE_FIRECRAWL_KEY || '').trim();
/** 超时必须小于 searchAll 的硬上限（SEARCH_TIMEOUT_MS + 400 = 7400ms）：firecrawl 在 CORE 集合里，
 *  自己不 settle 就会一直拖住那一轮的早退。实测 0.95~1.52s 返回，6s 已是四倍余量。 */
const FIRECRAWL_TIMEOUT_MS = 6000;
const FIRECRAWL_LIMIT_DEFAULT = 10;

/** QQBRIDGE_FIRECRAWL_BASE 是唯一可被外面改的出站地址，所以它也过一道 SSRF 校验（默认域名同样过）。
 *  每个进程只查一次；失败不缓存，避免一次 DNS 抖动把整个平台永久锁死。 */
let firecrawlBaseChecked = null;
function assertFirecrawlBase() {
  if (!firecrawlBaseChecked) {
    firecrawlBaseChecked = validateOutboundUrl(`${FIRECRAWL_BASE}/v2/search`)
      .catch((error) => { firecrawlBaseChecked = null; throw new Error(`Firecrawl 地址未通过安全校验：${error?.message ?? error}`); });
  }
  return firecrawlBaseChecked;
}

/** Firecrawl 的 description 是 Markdown。实测 pixiv 那条以 `![望月けい](https://i.pximg.net/…)` 开头、
 *  还带 `# 望月けい` 标题符 —— 不剥掉就等于把图片链接当正文塞给模型，先把这层壳去掉（不追求完整 Markdown 解析）。 */
function stripMarkdownNoise(s) {
  return String(s ?? '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, ' ')
    .replace(/\*\*/g, '');
}

/**
 * Firecrawl 搜索。契约与同文件其它平台完全一致：失败就抛错（由 searchAll 收进 failures 并继续，
 * 绝不因为这一个平台挂了让整次搜索失败）；拿到 0 条就返回空数组 —— 那时结果里的 platforms.firecrawl=0
 * 就是如实记录（本文件不引入新的日志通道，原因只走 failures 这条既有通道）。
 * @param {string} query
 * @param {{ limit?:number }} [opts]
 */
async function firecrawlSearch(query, opts = {}) {
  await assertFirecrawlBase();
  const limit = Math.min(20, Math.max(1, Math.round(Number(opts.limit) || FIRECRAWL_LIMIT_DEFAULT)));
  const headers = { 'content-type': 'application/json', accept: 'application/json', 'user-agent': SEARCH_UA };
  if (FIRECRAWL_KEY) headers.authorization = `Bearer ${FIRECRAWL_KEY}`;
  const res = await fetch(`${FIRECRAWL_BASE}/v2/search`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, limit }),
    signal: AbortSignal.timeout(FIRECRAWL_TIMEOUT_MS),
  });
  const text = await res.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* 交给下面按"不是 JSON"处理 */ }
  if (!res.ok || j?.success === false) {
    const key = j?.reason || j?.code;                                     // 实测：reason="credits"、code="BAD_REQUEST_INVALID_JSON"
    const why = String(j?.error || text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    throw new Error(`Firecrawl HTTP ${res.status}${key ? ` (${key})` : ''}${why ? `：${why}` : ''}`);
  }
  if (!j) throw new Error('Firecrawl 返回的不是 JSON（可能被中间层改写/拦截）');
  // v2 的载荷在 data.web / data.news；v1（或自建网关）是 data 直接为数组 —— 两种都认，免得上游一换形状就静默 0 条。
  const rows = Array.isArray(j.data) ? j.data : [].concat(j.data?.web || [], j.data?.news || []);
  const out = [];
  for (const r of rows) {
    pushResult(out, { title: r?.title, url: r?.url, snippet: stripMarkdownNoise(r?.description || r?.snippet) });
    if (out.length >= limit) break;
  }
  return out;
}

export const SEARCH_PLATFORMS = {
  // 2026-09-28：Firecrawl 放**第一位**（免 key、官方 JSON、线上机房 IP 下唯一还稳的通用检索源）。
  // 关掉它就是整条不注册：QQBRIDGE_FIRECRAWL_OFF=1（见上方环境变量块）。
  ...(FIRECRAWL_OFF ? {} : { firecrawl: firecrawlSearch }),
  gnews: gnewsSearch,
  // 2026-09-27 新增：两个都是无 key、机房 IP 可达、国内外实测都通的源（见各自函数上的实测记录）
  bingnews: bingNewsSearch,
  zhwiki: zhwikiSearch,
  enwiki: enwikiSearch,
  jawiki: jawikiSearch,
  moegirl: moegirlSearch,
  duckduckgo: duckSearch,
  bing: bingSearch,
  baidu: baiduSearch,
  sogou: sogouSearch,
  so360: so360Search,
  mojeek: mojeekSearch,
  // 2026-09-17 新增（线上实测可用）
  bilibili: bilibiliPlatformSearch,
  github: githubSearch,
  stackoverflow: stackSearch,
  // 2026-09-18 新增（"拓展谷歌搜索引擎"；机房 IP 常被验证码拦，失败会如实进 failures）
  google: googleSearch,
};

/** 实测从机房 IP 不通、默认收起；要挂回来用 QQBRIDGE_SEARCH_EXTRA=名字（逗号分隔） */
const SHELVED_PLATFORMS = {
  yahoo: yahooSearch,
  yandex: yandexSearch,
  brave: braveSearch,
  ecosia: ecosiaSearch,
  marginalia: marginaliaSearch,
};

for (const name of EXTRA_PLATFORMS) {
  const fn = SHELVED_PLATFORMS[name];
  if (fn) SEARCH_PLATFORMS[name] = fn;
}

/** 把各平台结果按"平台轮转"交错合并，保证任何一次搜索都有多平台视角（而不是被某一个平台刷屏）。 */
function interleave(bySource, maxResults) {
  const lists = Object.entries(bySource)
    .filter(([, v]) => Array.isArray(v) && v.length)
    .map(([k, v]) => ({ k, items: [...v] }));
  const out = [];
  const seen = new Set();
  for (let guard = 0; guard < 400 && out.length < maxResults; guard += 1) {
    let progressed = false;
    for (const { k, items } of lists) {
      while (items.length) {
        const r = items.shift();
        if (!r || !r.url || seen.has(r.url)) continue;
        seen.add(r.url);
        out.push({ ...r, source: k });
        progressed = true;
        break;
      }
      if (out.length >= maxResults) break;
    }
    if (!progressed) break;
  }
  return out;
}

/**
 * 多平台并行搜索 + 快速返回。
 * @param {string} query
 * @param {{ maxResults?:number, platforms?:string[] }} opts
 */
/**
 * "核心平台"：实测从机房 IP 稳定可用的那几个（Firecrawl、Google 新闻 RSS、维基、萌娘、DDG）。
 * 早退只在它们都回来之后才允许 —— 否则会拿着 Bing 的垃圾结果提前收工
 * （2026-09-16 实测：bing 从这台 VPS 返回的是完全无关的页面，且它 150ms 就回，
 *  比 gnews/维基都早，于是"2 个平台够数就早退"直接把好结果挡在门外）。
 *
 * 2026-09-28 把 firecrawl 加进核心集：它是线上唯一还能稳定出通用结果的源（实测 0.95~1.52s），
 * 早退不等它 = 相当于没加。它自己不 settle 也不拖挂整轮：见 FIRECRAWL_TIMEOUT_MS（6s < 硬上限 7.4s）。
 *
 * 2026-09-27 加 bingnews / jawiki 进核心集：两个都是无 key、机房 IP 可达、且**快**的源
 * （德国 VPS 实测 bingnews ~370ms、jawiki ~550ms）。核心集只要求"有结论"，不要求"有结果"，
 * 所以把一个源加进来只是多等它几百毫秒，不会因为它在某个 IP 上返回空而卡住早退。
 */
export const CORE_PLATFORMS = new Set(['firecrawl', 'gnews', 'bingnews', 'zhwiki', 'enwiki', 'jawiki', 'moegirl', 'duckduckgo']);

export async function searchAll(query, opts = {}) {
  const maxResults = Math.min(30, Math.max(3, Number(opts.maxResults) || 12));
  const clean = String(opts.raw === true ? query : cleanQuery(query));
  const names = (Array.isArray(opts.platforms) && opts.platforms.length ? opts.platforms : Object.keys(SEARCH_PLATFORMS))
    .map((n) => String(n).toLowerCase())
    .filter((n) => SEARCH_PLATFORMS[n]);
  const cacheKey = `${clean}|${maxResults}|${names.join(',')}`;
  const cached = cacheGet(cacheKey);
  if (cached) return { ...cached, cached: true };

  const t0 = Date.now();
  const bySource = {};
  const failures = {};
  const settledNames = new Set();
  const coreWanted = names.filter((n) => CORE_PLATFORMS.has(n));

  await new Promise((resolve) => {
    let settled = false;
    const finish = () => { if (!settled) { settled = true; resolve(); } };
    // 硬上限：即使有平台卡住也不超过 SEARCH_TIMEOUT_MS 多一点
    const hardTimer = setTimeout(finish, SEARCH_TIMEOUT_MS + 400);
    const maybeFinish = () => {
      // 核心平台全部有结论 → 立刻返回（不等 bing/baidu 这些可选件）
      if (coreWanted.every((n) => settledNames.has(n))) { clearTimeout(hardTimer); finish(); return; }
      if (settledNames.size >= names.length) { clearTimeout(hardTimer); finish(); }
    };
    for (const name of names) {
      SEARCH_PLATFORMS[name](clean).then((rows) => {
        bySource[name] = Array.isArray(rows) ? rows : [];
        settledNames.add(name);
        maybeFinish();
      }).catch((error) => {
        failures[name] = String(error?.message ?? error).slice(0, 120);
        settledNames.add(name);
        maybeFinish();
      });
    }
    if (!names.length) { clearTimeout(hardTimer); finish(); }
  });

  // ① 平台轮转交错 → 多平台视角、不被单一平台刷屏
  const grams = queryGrams(clean);
  const interleaved = interleave(bySource, Math.max(maxResults * 2, 24));
  // ② 按"和查询词的相关度"稳定排序
  const scored = interleaved.map((r, i) => ({ r, i, s: relevance(r, grams) }));
  scored.sort((a, b) => (b.s - a.s) || (a.i - b.i));
  // ③ 精度优先：先只要真有共同词的结果（机房 IP 下 bing/维基全文检索经常整屏无关），
  //    相关结果够（≥3）就干脆不掺垃圾；不够才退回原序，并如实标注低相关。
  const relevant = scored.filter((x) => x.s > 0);
  const useRelevant = relevant.length >= Math.min(3, maxResults);
  const picked = (useRelevant ? relevant : scored).slice(0, maxResults);
  const results = picked.map((x) => ({ ...x.r, ...(useRelevant ? {} : { lowRelevance: true }) }));

  const value = {
    query: String(query),
    searchedFor: clean,
    tookMs: Date.now() - t0,
    platforms: Object.fromEntries(Object.entries(bySource).map(([k, v]) => [k, v.length])),
    failures,
    ...(useRelevant ? {} : { note: '没有找到与查询词明显相关的条目，下面这些是各平台的原样返回，请谨慎采用' }),
    results,
  };
  cacheSet(cacheKey, value);
  return value;
}
