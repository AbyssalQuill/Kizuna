// 安全版 Web Search / Fetch MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 安全设计：
// - 只暴露只读工具 `web_search` 与 `web_fetch`：查网络用语/梗/黑话、抓取网页正文。
// - 不暴露任何本地文件、命令执行、写操作。
// - 查询词做基础清洗：去 CQ 码、控制字符、超长截断。
// - `web_fetch` 仅允许 http/https：
//   - 禁止 URL 内嵌凭据；
//   - 禁止 localhost / .local / 私有 IP / 环回 / 链路本地 / CGNAT 等内网地址；
//   - 域名会先做 DNS 解析并检查全部解析结果，避免解析到内网；
//   - 手动跟随重定向，每一跳都重新校验；
//   - 响应体按字节流限量读取，避免超大响应拖垮进程。
// - 搜索结果/抓取结果仅作为“候选解释”，最终是否入库仍由控制台人工确认。
// - 2026-09-27：多平台聚合搜索那一大段（平台实现 + searchAll）抽到 lib/web-search.js，本文件只保留
//   工具注册与 web_fetch 的 SSRF 加固；QQBRIDGE_WEB_SEARCH_NO_CONNECT 那个导入开关随之撤销。
import dns from 'node:dns';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { StringDecoder } from 'node:string_decoder';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { extractReadableHtml } from './lib/html-text.js';
// 多平台聚合搜索内核现在在 lib/web-search.js（纯函数，不依赖 MCP SDK）：本文件只用它的 searchAll，
// 好让桥进程也能直接调同一份实现（见 lib/pixiv.js 的按名字定号）；抓取那条路（safeFetch）仍在本文件。
import { searchAll } from './lib/web-search.js';
import { z } from 'zod';

const dnsLookup = dns.promises.lookup;

function sanitizeQuery(query) {
  return String(query ?? '')
    // 去掉 CQ 码（[CQ:xxx]）
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

// 解析 IPv6 中内嵌的 IPv4（::ffff:a.b.c.d、::ffff:7f00:1、::a.b.c.d 等）。
// 只处理标准 IPv4-mapped / IPv4-compatible 形式，避免把 fc00::1、fe80::1 误判成内嵌 IPv4。
function ipv4FromLast32(lower) {
  const parts = String(lower || '').split(':');
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  const secondLast = parts[parts.length - 2];
  if (/^\d+\.\d+\.\d+\.\d+$/.test(last)) return last;
  if (/^[0-9a-f]{1,4}$/.test(secondLast) && /^[0-9a-f]{1,4}$/.test(last)) {
    const num = (parseInt(secondLast, 16) << 16) + parseInt(last, 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  return null;
}

function parseEmbeddedIpv4(h) {
  const lower = String(h || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!lower.includes(':')) return null;
  const dotted = lower.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  // ::ffff:7f00:1 或 ::7f00:1（IPv4-mapped / compatible）
  const m = lower.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (m) {
    const num = (parseInt(m[1], 16) << 16) + parseInt(m[2], 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  // 兼容 ::ffff:0:7f00:1、::ffff:0:c0a8:101、::c0a8:101 等非规范 IPv4-mapped/compatible 写法。
  if (lower.startsWith('::ffff:') || lower.startsWith('::')) {
    const embedded = ipv4FromLast32(lower);
    if (embedded) return embedded;
  }
  // NAT64 前缀（64:ff9b::/96 与 64:ff9b:1::/48）内嵌 IPv4，例如 64:ff9b::c0a8:101 -> 192.168.1.1
  if (lower.startsWith('64:ff9b')) {
    const embedded = ipv4FromLast32(lower);
    if (embedded) return embedded;
  }
  const nat64 = lower.match(/^64:ff9b:(?:::)?(?:([0-9a-f]{1,4}):([0-9a-f]{1,4})|(\d+\.\d+\.\d+\.\d+))$/i);
  if (nat64) {
    if (nat64[3]) return nat64[3];
    const num = (parseInt(nat64[1], 16) << 16) + parseInt(nat64[2], 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  return null;
}

function isPrivateIp(ip) {
  const h = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  const embedded = h.includes(':') ? parseEmbeddedIpv4(h) : null;
  if (embedded) return isPrivateIp(embedded);

  if (net.isIP(h) === 4) {
    const parts = h.split('.').map(Number);
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    // 198.18.0.0/15（benchmarking）、192.0.0.0/24（IETF 协议保留）
    if (parts[0] === 198 && parts[1] >= 18 && parts[1] <= 19) return true;
    if (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) return true;
    // 组播与保留段
    if (parts[0] >= 224) return true;
    return false;
  }

  if (net.isIP(h) === 6) {
    if (h === '::' || h === '::1') return true;
    // fc00::/7 ULA
    if (h.startsWith('fc') || h.startsWith('fd')) return true;
    // fe80::/10 link-local
    if (/^fe[89ab]/.test(h)) return true;
    // fec0::/10 site-local（已废弃）
    if (h.startsWith('fec') || h.startsWith('fed') || h.startsWith('fee') || h.startsWith('fef')) return true;
    // 2001:db8::/32 文档地址
    if (h.startsWith('2001:db8')) return true;
    if (h.startsWith('2001:2:') || h.startsWith('2001:10:') || h.startsWith('2001:20:')) return true;
    // 6to4 内嵌 IPv4，例如 2002:c0a8:0101:: -> 192.168.1.1
    const sixth4 = h.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/i);
    if (sixth4) {
      const num = (parseInt(sixth4[1], 16) << 16) + parseInt(sixth4[2], 16);
      const ipv4 = `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
      if (isPrivateIp(ipv4)) return true;
    }
    // ff00::/8 组播地址
    if (h.startsWith('ff')) return true;
    return false;
  }

  // 非标准 IP 字面量由 DNS 解析后统一检查。
  return false;
}

// 解析主机名并固定到已校验的 IP，避免 DNS rebinding。
async function lookupWithTimeout(hostname) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('DNS 解析超时')), 5000);
  });
  return Promise.race([dnsLookup(hostname, { all: true, verbatim: true }), timeout]).finally(() => clearTimeout(timer));
}

async function resolveSafeHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) throw new Error('主机名为空');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) {
    throw new Error('禁止访问内网/本机地址');
  }
  if (net.isIP(h)) {
    if (isPrivateIp(h)) throw new Error('禁止访问内网/本机地址');
    return h;
  }
  let addresses;
  try {
    addresses = await lookupWithTimeout(h);
  } catch (error) {
    throw new Error(`域名解析失败：${error?.message ?? error}`);
  }
  if (!addresses.length) throw new Error('域名没有解析结果');
  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new Error('域名解析到内网/本机地址，已阻止');
    }
  }
  return addresses[0].address;
}

async function validateFetchUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new Error('URL 无效');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅允许 http/https');
  if (url.username || url.password) throw new Error('URL 不能包含凭据');
  const ip = await resolveSafeHost(url.hostname);
  return { url, ip };
}

// 从 Node IncomingMessage 读取最多 maxChars 个字符，用 StringDecoder 避免切断 UTF-8。
function sliceByCodePoints(s, max) {
  if (s.length <= max) return s;
  return Array.from(s).slice(0, max).join('');
}

function readBoundedText(res, maxChars) {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder('utf8');
    let text = '';
    let settled = false;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      fn(val);
    };
    res.on('data', (chunk) => {
      if (settled) return;
      text += decoder.write(chunk);
      if (text.length >= maxChars) {
        text = sliceByCodePoints(text, maxChars);
        try { res.destroy(); } catch {}
        finish(resolve, text);
      }
    });
    res.on('end', () => {
      if (!settled) {
        text += decoder.end();
        finish(resolve, sliceByCodePoints(text, maxChars));
      }
    });
    res.on('error', (err) => finish(reject, err));
  });
}

// 使用已校验的 IP 发起请求（保留 Host/SNI），从根上消除 DNS rebinding。
function requestOnce(url, ip) {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const port = url.port || (url.protocol === 'https:' ? 443 : 80);
    const req = mod.request({
      hostname: ip,
      port,
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        host: url.host,
        'user-agent': 'Mozilla/5.0',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9',
      },
      servername: url.protocol === 'https:' ? url.hostname : undefined,
      rejectUnauthorized: url.protocol === 'https:',
      timeout: 12000,
    }, (res) => {
      const statusCode = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(statusCode)) {
        res.resume();
        resolve({ statusCode, redirect: String(res.headers.location || '') });
        return;
      }
      readBoundedText(res, 50000)
        .then((body) => resolve({ statusCode, body }))
        .catch(reject);
    });
    req.on('timeout', () => req.destroy(new Error(`请求超时：${url.hostname}`)));
    req.on('error', reject);
    req.end();
  });
}

async function safeFetch(urlString) {
  const MAX_REDIRECTS = 5;
  let { url, ip } = await validateFetchUrl(urlString);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const result = await requestOnce(url, ip);
    if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
      if (!result.redirect) throw new Error(`重定向缺少 Location: ${result.statusCode}`);
      const next = new URL(result.redirect, url).toString();
      ({ url, ip } = await validateFetchUrl(next));
      continue;
    }
    const maxChars = 50000;
    const body = result.body || '';
    return {
      url: url.toString(),
      statusCode: result.statusCode,
      truncated: body.length >= maxChars,
      body,
    };
  }
  throw new Error('重定向次数过多，已停止');
}

const server = new McpServer({ name: 'web-search-safe', version: '0.1.0' });

server.tool(
  'web_search',
  'Web search (read-only, multi-platform aggregate: Firecrawl / Bing / DuckDuckGo / Baidu / Sogou / 360 / Mojeek / Yahoo / Yandex / Brave / Ecosia / Marginalia / Google News / Bing News / Wikipedia (zh+en+ja) / Moegirl / Bilibili / GitHub / Stack Overflow, run in parallel, results interleaved round-robin by platform and de-duplicated by URL). '
  + 'Use it for anything outside your own knowledge: an unfamiliar word / meme / slang, a fact or number you are unsure of, a person / work / current event, any question that needs outside material. '
  + '**No call limit, no result limit** (maxResults caps at 30); the same query within 5 minutes hits the cache and answers instantly. '
  + 'One thin result is not a wall: reword it, switch language or platforms, search again - never hold back because "I already searched". '
  + '**Search first, then answer is the default**: when you are not sure of something, search once before you speak; never fob anyone off with "I think maybe…", and never bounce the question back to the asker ("what is this?"). '
  + 'Use web_fetch when you only need the text of one page. It performs no local actions.',
  {
    query: z.string().describe('Search terms (natural language is fine; site: is supported)'),
    maxResults: z.number().int().min(3).max(30).optional().describe('How many results to return, default 12'),
    platforms: z.array(z.enum(['firecrawl', 'gnews', 'bingnews', 'zhwiki', 'enwiki', 'jawiki', 'moegirl', 'duckduckgo', 'bing', 'baidu', 'sogou', 'so360', 'mojeek', 'bilibili', 'github', 'stackoverflow', 'google', 'yahoo', 'yandex', 'brave', 'ecosia', 'marginalia'])).optional()
      .describe('Search only the listed platforms (default: all). firecrawl=Firecrawl web search (keyless, works from datacenter IPs but IP-metered), gnews/bingnews=Google/Bing news RSS (keyless, reachable from datacenter IPs), zhwiki/enwiki/jawiki=Wikipedia, moegirl=Moegirl wiki, bilibili=Bilibili video, github=GitHub repos, stackoverflow=Stack Overflow; the rest are search engines (yahoo/yandex/brave/ecosia/marginalia are unreachable from this host, an admin can re-enable them via QQBRIDGE_SEARCH_EXTRA; firecrawl can be turned off with QQBRIDGE_FIRECRAWL_OFF=1)'),
  },
  async ({ query, maxResults, platforms }) => {
    const clean = sanitizeQuery(query);
    if (!clean) {
      return { content: [{ type: 'text', text: 'Empty query - refused.' }], isError: true };
    }
    try {
      const result = await searchAll(clean, { maxResults, platforms });
      if (!result.results.length) {
        return {
          content: [{ type: 'text', text: `No results (platforms: ${JSON.stringify(result.platforms)} failures: ${JSON.stringify(result.failures)}, took ${result.tookMs}ms). Try different wording.` }],
        };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Search failed: ${error?.message ?? error}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'web_fetch',
  'Read one HTTP(S) page and return it as CLEAN READABLE TEXT (not raw HTML): { title, description, image, text, links, truncated }. '
  + 'Use it to actually READ a page - the most relevant hit from web_search, a link the owner pasted, a GitHub README, a news article, or a video page. '
  + 'Pass raw=true only when you need the original markup (e.g. hunting for a specific tag); the default extracted text is far shorter and easier to reason about. '
  + 'Returns at most ~12000 characters of text (clean) or 50000 (raw), 20s timeout. Blocks intranet/loopback hosts; performs no local action.',
  {
    url: z.string().describe('The http(s) URL to read'),
    raw: z.boolean().optional().describe('true = return the original HTML body (up to 50000 chars) instead of the extracted text'),
    maxChars: z.number().int().min(500).max(50000).optional().describe('Text budget for the extracted form, default 12000'),
  },
  async ({ url, raw, maxChars }) => {
    try {
      const result = await safeFetch(url, raw ? 50000 : 400000);
      if (raw) {
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
      const doc = extractReadableHtml(result.body, { url: result.url, maxChars: maxChars || 12000 });
      const payload = {
        url: result.url,
        statusCode: result.statusCode,
        title: doc.title || '',
        description: doc.description || '',
        ...(doc.image ? { image: doc.image } : {}),
        ...(doc.siteName ? { siteName: doc.siteName } : {}),
        text: doc.text,
        textChars: doc.textChars,
        truncated: doc.truncated,
        ...(doc.extracted ? { extracted: doc.extracted } : {}),
        ...(doc.links ? { links: doc.links.slice(0, 40) } : {}),
      };
      if (!doc.text && !doc.title) {
        return { content: [{ type: 'text', text: `页面没有可读正文（HTTP ${result.statusCode}）。可能是纯前端渲染或需要登录；可以试 raw=true 看原始 HTML。\n${JSON.stringify(payload, null, 2)}` }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `抓取失败：${error?.message ?? error}` }],
        isError: true,
      };
    }
  }
);

await server.connect(new StdioServerTransport());
