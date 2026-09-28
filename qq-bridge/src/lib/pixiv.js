// Pixiv 图片：搜索（含本地筛选 + 自动翻页） + 拿可下载的图片地址。
//
// 为什么走第三方平替站（不想登录、也进不去官网）：
//   · pixiv.net 的搜索/详情接口要登录 cookie，而且机房 IP 常被挡；
//   · https://pixigraph.online 是一个平替站（2026-09-28 起为内置默认；此前是它的同族域名
//     x.pixigraph.xyz，已按使用方要求从默认与界面里去掉 —— 两个域名实测同一套后端），
//     2026-09-18 在线上 VPS 实测可用：
//
//       GET /api/search.php?keyword=<关键词>&page=1
//         → {"error":false,"body":{"illustManga":{"data":[<一页 60 条>],"total":…,"lastPage":…}}}
//           每条就是 pixiv ajax 的原生形状：
//           {id,title,userName,tags[],url,pageCount,width,height,xRestrict,sl,alt,userId,…}
//
//       GET /api/image.php?url=<encodeURIComponent(图片URL)>     ← 站内图床代理（API 式）
//         2026-09-28 **整体移除**（主人要求取图不要再经过它）：它慢（2.3~5.2 s）且不返回
//         Content-Length，下游拿不到字节完整性的对照物。取图只剩两条路 —— 直联 i.pximg.net
//         （带 Referer）与 host 重写式镜像，见 pixivProxyUrls 上方那段实测记录；本站的
//         search/detail 两条接口线仍在用（pixivBase()）。
//
// 图片地址怎么来（搜索结果只给 250×250 缩略图，但 URL 里带着日期路径，可以推出大图）：
//
//   缩略图 https://i.pximg.net/c/250x250_80_a2/img-master/img/2026/09/18/01/37/08/149787938_p0_square1200.jpg
//   master https://i.pximg.net/img-master/img/2026/09/18/01/37/08/149787938_p0_master1200.jpg   ← 实测直连 200 / 227KB
//   原图   https://i.pximg.net/img-original/img/2026/09/18/01/37/08/149787938_p0.jpg            ← VPS 直连 404，走站内代理 200
//
// 档位与默认值（2026-09-21 更正，原文写着"默认发 master1200"，与实际行为不符）：
//   `qq_send_pixiv` 的 `size` 默认 original（2026-09-20 定调"发图默认原图，不要缩略图"，
//   工具层实现见 mcp-napcat-safe.js 的 sizeEff）；master1200 只在"调用方显式要"或"原图确实拿不到"时用，
//   而且必须显式降级并如实回报（见下面 pixivImageTier / planPixivSend）。
//   本文件里 pixivImageCandidates / pixivImageSources 的 `size ?? 'master'` 只是给老调用方的兼容默认，
//   工具层永远显式传 size —— 别把这两个默认值当成"产品行为"。
// 注意 `custom-thumb` 那种缩略图（作者自定义封面）路径里同样有 `img/<日期>/<id>_pN_`，同一个正则能吃。
//
// 两条纪律（与 image-search.js 一致）：
//   ① 只返回 URL，不下载、不落盘 —— 下载由调用方走 SSRF 安全的 safeFetchBuffer；
//   ② 直联候选必须带 Referer（i.pximg.net 不带就 403）；镜像候选**一律不带**（host 重写式镜像
//      自己会补，而 pximg.cocomi.eu.org 带了反而 403）。safeFetchBuffer 的头是调用方按这条传的。
//
// ══════════════════════════════════════════════════════════════════════════════════════════
// 2026-09-18 实测：镜像站只认 keyword / page，所以筛选只能在本地做。
//   逐个试过 mode=safe/all/r18、s_mode=s_tag/s_tag_full/s_tc、order=date_d/popular_d、p、bl、
//   type=illust/manga：全部被忽略（同一关键词 total 恒定、首条 id 恒定）；只有 page 让结果换了一批。
//   前端那几个参数是浏览器里本地过滤的，没传给上游。⇒ 本文件里的 normalizePixivFilters /
//   filterPixivItems 就是"在已抓回来的数据上自己筛"，这也是 scanPages 自动翻页存在的原因。
//
// 2026-09-18 实测：返回体里没有收藏数 —— 按人气/收藏排序做不到，别假装支持。
//   逐条核对了第 1 页 60 条 item 的全部键：aiType / alt / bookmarkData / createDate / description /
//   height / id / illustType / isBookmarkable / isMasked / isOriginal / isUnlisted / is_howto /
//   pageCount / profileImageUrl / restrict / sl / tags / title / titleCaptionTranslation /
//   updateDate / url / userId / userName / visibilityScope / width / xRestrict。
//   其中 bookmarkData 是"当前登录用户有没有收藏"（未登录恒为 null），isBookmarkable 只是"能不能收藏"；
//   把整个返回体当字符串数过：bookmarkCount = 0 次、like = 0 次、view = 0 次。
//   ⇒ 收藏数/浏览数这类热度指标根本没返回，所以 sort 只能按 createDate（投稿时间），
//     调用方若传 sort=popular/hot 会被回落成 date_desc 并在 warnings 里写明原因。
//
// 2026-09-18 实测：aiType 到底是什么值 —— 不能写成 aiType !== 0。
//   · 关键词「AIイラスト」→ 60/60 条 aiType=2；「AI生成」→ 60/60 条 aiType=2；
//   · 关键词「手描き」→ 60/60 条 aiType=1（手绘，几乎不可能是 AI）；「アナログ」1=57 / 2=3。
//   ⇒ aiType=2 = AI 生成，aiType=1 = 非 AI（0 在实测样本里没出现过，按"未标注"处理）。
//     如果按"!=0 就算 AI"来写，会把整页作品全过滤光——这是本次实测最容易踩的坑。
//
// 2026-09-18 实测：xRestrict（R-18）在本镜像站默认搜索里恒为 0。
//   「初音ミク」「エロ」「R-18」「巨乳」「オリジナル」各 60 条，xRestrict 全是 0：
//   本站只搜全年龄库（这也是它不认 mode=r18 的同一个原因）。
//   ⇒ r18='only' 实测恒为空；'exclude'（默认）和 'include' 拿到的是同一批数据。
//   过滤逻辑仍然保留（xRestrict !== 0 + R-18/R-18G 标签兜底）：上游随时可能变，
//   而且标签兜底确实能挡住"关键词本身就是 R-18 标签"的作品。
//
// 2026-09-18 实测：illustType 有 0/1/2 三种，2 是动图。
//   0=插画、1=漫画、2=动图(ugoira)；实测「初音ミク」60 条里有 1 条 illustType=2。
//   ⇒ illustType='illust'|'manga' 只认 0/1；2 不属于任何一类，被这两条筛选中任意一条排除。
//
// 2026-09-18 实测：翻页与边界。
//   · 相邻页 id 不重叠（p1∩p2=p1∩p3=p2∩p3=0），每页 60 条，lastPage 恒为 10；
//   · page 超出 lastPage（试过 page=11）仍然返回 60 条，明显是兜底/循环 —— 不可采信，
//     所以自动翻页一律卡在 lastPage 内，不会去扫越界页。
// ══════════════════════════════════════════════════════════════════════════════════════════
//
// 本地筛选 + 自动翻页的设计（2026-09-18 定为"方案 A"：不登录、不用会员、不加部署）
//   筛选全在本地对已抓回来的数据做，只筛一页结果会很少（一页 60 条），所以支持 scanPages 自动往后翻，
//   直到筛够 limit 或扫到 lastPage；默认 3 页、上限 10 页。返回里的 scan / scanNotice 会如实告诉
//   调用方"只扫了 N 页 / 全站共 total 条 / lastPage 多少"，免得模型以为自己筛了全站。
//
//   硬要求：不传任何新参数时，结果必须与改动前逐字段一致。
//   做法：把"调用方有没有用新参数"当开关 ——
//     · 一个筛选参数都没给 → 完全走旧路径：只抓 1 页、不排序、只过滤 R-18（与旧版逐字段一致）；
//     · 给了任意一个（包括显式 scanPages）→ 启用扫描引擎：默认排序 date_desc、默认扫 3 页。
//   这样"已经能用的搜索"不可能被改坏（回归测试见 tools/test-pixiv-filters.mjs）。
//
// 镜像站地址可改（2026-09-18）：优先级 config.json 的 pixiv.base > 环境变量 QQBRIDGE_PIXIV_BASE
//   > 内置默认 —— 与 core/config.js 里 dsh.baseUrl 的"配置文件覆盖环境变量"同一套路。
//   为什么要接配置：桥打包给别人装好后，用户没法方便地改环境变量，而镜像站是第三方、随时可能换域名/挂掉；
//   改 config.json 一处即可，不用改代码（见 qq-bridge/config.example.json 的 pixiv 段）。
//
// ══════════════════════════════════════════════════════════════════════════════════════════
// 2026-09-18 实测更正：官网并不需要登录，机房 IP 也没被挡（至少在线上那台 VPS 上）。
//   上面"官网要登录、机房 IP 常被挡"是本文件最初写的理由，实测不成立，逐条留证：
//     · GET https://www.pixiv.net/ajax/illust/<id>?lang=zh        → 200，带完整 title/userName/tags/xRestrict/aiType
//     · GET https://www.pixiv.net/ajax/illust/<id>/pages?lang=zh  → 200，逐页给出 urls.original（原图直链）
//     · GET https://www.pixiv.net/ajax/search/artworks/<kw>?lang=zh → 200，illustManga.data 60 条
//     · GET https://www.pixiv.net/ajax/user/<uid>/profile/all?lang=zh → 200，body.illusts 是 id→null 的表
//   全部不需要 cookie，也不需要 Referer（带不带 referer 都 200；UA 用 'Mozilla/5.0' 就行）。
//   唯一真需要 Referer 的是图床 i.pximg.net：不带 `referer: https://www.pixiv.net/` 一律 403 nginx，
//   带上就 200 —— 所以取图那条路要给 safeFetchBuffer 传 referer（见下面 pixivImageSources）。
//   ⇒ 现在的分工：元数据与地址直联官网（快：100~400ms），镜像站只当兜底
//     （它的 search.php 实测就是 pixiv search 的透传，detail.php 则是它拿自己登录态换来的同一份
//      ajax 响应；它慢得多：同一张图 2.7~5.7s，还出现过 25s 超时，所以只能兜底）。
// ══════════════════════════════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════════════════════════════
// 2026-09-20：官方 pixiv API 优先，镜像站只做兜底。
//   约定："官方 pixiv API 优先，镜像站只做兜底"（此前本文件是镜像站优先，判断依据是
//   2026-09-18 那会儿以为官网要登录；2026-09-18 晚实测更正过一半，2026-09-19 又加了 cookie 段）。
//   现在每个能力都按同一套顺序试，并如实报出这次是谁供的数据（结果里的 source / sourcesTried）：
//     ① app-api.pixiv.net（Bearer token，见 lib/pixiv-auth.js）—— 形状最规整，能拿到 meta_pages
//        原图直链（逐页、不用猜扩展名）；没登录态时直接跳过（实测匿名必 400，白等一次超时）。
//     ② www.pixiv.net/ajax（匿名就能用，2026-09-18 实测四类接口全 200）—— 没配登录态时的主力。
//     ③ 第三方镜像站（`pixivBase()`，默认 https://pixigraph.online）—— 最慢，只能垫底
//        （接口本身 1~2s；早年那条图片代理更慢：同一张图 2.7~5.7s、出现过 25s 超时，
//         那条路 2026-09-28 已整体移除，见上面取图链）。
//   纪律：cookie 与 Bearer 只发给 pixiv 自己的域名，镜像站永远看不到任何凭证（见 pixivRequestHeaders）。
//   每个来源最多重试 1 次、超时短、不空转（镜像站那次重试前等 1.2 秒，它偶发慢；官网是硬失败，等它没意义）。
// ══════════════════════════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPixivAccessToken, pixivAppHeaders, isPixivHost } from './pixiv-auth.js';
// 第 ④ 条来源直接用桥自己的搜索内核（2026-09-27 从 mcp-web-search-safe.js 抽到 lib/web-search.js）。
// 为什么不用子进程跑 MCP server：那要 spawn 一个 stdio 服务，只为查一个号码太重。
import { searchAll } from './web-search.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 桥的 config.json（本文件在 qq-bridge/src/lib/ 下 → 上两级就是 qq-bridge/）。 */
const CONFIG_PATH = path.resolve(__dirname, '..', '..', 'config.json');
/* 2026-09-28：内置兜底站从 `x.pixigraph.xyz` 换成同族的 `pixigraph.online`（使用方要求
 *   「去掉那个旧地址，用我们首推的」）。两个域名本机同时实测各 4 条路由：search/detail 都是
 *   200 + 同一份 JSON 形状、首条 id 都是 150206784、detail 的 illustTitle 也一致 ⇒ 同一套后端。
 * ⚠ 这个 base **只管接口兜底**（`{base}/api/search.php`、`{base}/api/detail.php`、`/api/native.php`），
 *   **取图完全不看它** —— 取图走 `pixivProxyUrls` 的 host 重写镜像链，首推 `i.muxmus.com`
 *   （见下面那段实测）。所以别把纯图床反代（i.muxmus.com / cocomi / i.pixiv.re）填到这里：
 *   它们对 `/api/*` 一律 404，填了这条兜底线就废了。 */
const DEFAULT_BASE = 'https://pixigraph.online';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const TIMEOUT_MS = 15000;

/** 把地址规整成"能用或 null"：必须是 http(s)、去掉尾部斜杠。 */
function cleanBase(v) {
  const s = String(v ?? '').trim().replace(/\/+$/, '');
  return /^https?:\/\/[^\s]+$/i.test(s) ? s : null;
}

/** 读 config.json 里的 pixiv.base（读不到文件 / 格式坏 / 值非法都当"没配"，绝不让它把搜索搞挂）。 */
export function configPixivBase() {
  try {
    let text = fs.readFileSync(CONFIG_PATH, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return cleanBase(JSON.parse(text)?.pixiv?.base);
  } catch {
    return null;
  }
}

/**
 * 纯函数：决定这次用哪个镜像站地址（便于离线测试优先级）。
 * 顺序与 core/config.js 的 dsh.baseUrl 一致：配置文件 > 环境变量 > 内置默认。
 */
export function pickPixivBase({ configBase, envBase, fallback = DEFAULT_BASE } = {}) {
  return cleanBase(configBase) ?? cleanBase(envBase) ?? fallback;
}

/** 当前生效的镜像站地址。**每次现读** config.json：改完配置不用重启 MCP 子进程。 */
export function pixivBase() {
  return pickPixivBase({ configBase: configPixivBase(), envBase: process.env.QQBRIDGE_PIXIV_BASE });
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * 2026-09-28 图片源换成 host 重写式反代（本机实测数据，不是搜来的推荐）
 *
 * 实测口径：本机国内家宽，**绕过系统代理**（node 的 fetch 默认不吃系统代理；另用
 *   `curl.exe --noproxy "*"` 交叉验过一次）。基准图 = 作品 80643572 p0 原图
 *   `/img-original/img/2020/04/08/11/41/00/80643572_p0.jpg`，满额 1,886,996B，
 *   sha256 前 16 位 536c4aebbabc1fb6。
 *   · 官方三域名本机**全 TCP 超时**（各 10s）：www.pixiv.net / i.pximg.net / app-api.pixiv.net
 *     ⇒ 本机没有"直连兜底"这条退路，取图只能走镜像（直连排序见下面的可达性探测）。
 *   · 旧图片源 `x.pixigraph.xyz/api/image.php?url=`：8/8 都下满了 1,886,996B、sha 一致，
 *     **这次没复现"中途断流"**；但它 2.3~5.2s（均值 3.3s）且**不返回 Content-Length**
 *     —— 下游 safe-fetch 的字节完整性闸门（verifyImageComplete）拿不到对照物。
 *   · `i.muxmus.com`：同一张图 8/8 满额、同一个 sha，0.28~1.29s（均值 0.81s，快 4 倍），
 *     **返回 Content-Length**（完整性闸门有了对照物），6 并发仍 6/6 满额。
 *   · ⚠ 上面第一条（`x.pixigraph.xyz/api/image.php?url=`）**2026-09-28 已按主人要求移除**：
 *     `pixivProxyUrls` 不再产出它，非 pximg 地址一律原样返回；本站只剩 search / detail
 *     两条接口线还在用（`pixivBase()`）。
 *
 * 契约差异（本次改动的核心，别只看"谁快"）：
 *   · `x.pixigraph.xyz`（历史；2026-09-28 起内置默认已换成同族 `pixigraph.online`）是 **API 站**：
 *     靠 `{base}/api/image.php?url=<enc>` 代拉 ⇒ 旧代码"只改
 *     config.json 的 pixiv.base 就换源"成立；
 *   · `i.muxmus.com` 是 **host 重写式反代**：把 `i.pximg.net` 换成它的域名、路径原样透传
 *     （实测 `/img-original/…`、`/img-master/…`、`/c/250x250_80_a2/…` 全 200；而 `/api/image.php`
 *     一律 404/844B HTML）⇒ **换 base 没用，必须改这个函数**，且 detail/native/search 三条接口
 *     线仍只能留给 API 站（默认 https://pixigraph.online，见 `pixivBase()` 的调用点）。
 *   · 实测 muxmus 带不带 Referer 都 200；`pximg.cocomi.eu.org` **反过来 —— 带 Referer 一律 403
 *     （3 字节）**，所以镜像候选一律不带 referer（`pixivImageSources` 的 ② 本来就不带）。
 *
 * 候选顺序与理由（全部本人实测，非搜索结果）：
 *   ① i.muxmus.com         8/8 满额、最快、给 Content-Length
 *   ② pximg.cocomi.eu.org  6/6 满额、3.0~7.4s（次选；务必别给它加 referer）
 *   ③ i.pixiv.re           6/6 满额但 1.5~9s，且见过一次 25s 超时**切在 982,685B**（末选）
 * 已失效（同一批实测，别再写回来）：i.pixiv.cat / pixiv.cat（DNS 通但 443 全超时）；
 *   i.pixiv.download / pximg.nya.pub / pixivimg.net / pximg.exozy.me / pixiv.ducks.party
 *   （域名不存在）；pixiv.pics（ECONNRESET）；pixiv.js.org（文档站，任何路径都回同一页 HTML）。
 * ══════════════════════════════════════════════════════════════════════════════════════════ */

/** 图片镜像域名（host 重写式）。顺序 = 实测可靠性，`pixivProxyUrls` 照这个顺序发候选。 */
export const PIXIV_IMAGE_MIRROR_HOSTS = ['i.muxmus.com', 'pximg.cocomi.eu.org', 'i.pixiv.re'];

/** 只有 pixiv 图床的地址才做 host 重写（外站地址原样返回，不再经任何代理）。 */
const PIXIV_PXIMG_HOST_RE = /(^|\.)pximg\.net$/i;

/**
 * 一条图片地址 → **全部**可用的代理候选（按可靠性排序，调用方逐个试）。
 *   · 入参 host 是 `i.pximg.net`（含子域）→ 对每个镜像域名做 host 重写，path/search 原样保留；
 *   · 不是 pximg、或 URL 解析不出来 → **原样返回这一条**（2026-09-28 主人要求移除老
 *     `x.pixigraph.xyz/api/image.php?url=` 图片源：它慢、且不返回 Content-Length，
 *     下游没法做字节完整性对账。外站图本来就不该塞进 pixiv 镜像）。
 * @param {string} imageUrl
 * @returns {string[]} 至少一条；顺序即尝试顺序
 */
export function pixivProxyUrls(imageUrl) {
  const u = String(imageUrl ?? '').trim();
  try {
    const x = new URL(u);
    if (PIXIV_PXIMG_HOST_RE.test(x.hostname)) {
      return PIXIV_IMAGE_MIRROR_HOSTS.map((h) => `https://${h}${x.pathname}${x.search}`);
    }
  } catch { /* 不是标准 URL：原样返回 */ }
  return [u];
}

/**
 * 单条代理地址（= 第一条候选）。给"只要一个地址"的老调用方用（工具自测里钉了它）；
 * 新的取图路径请用 `pixivProxyUrls` 拿全部候选，失败了才有下一条可试。
 */
export function pixivProxyUrl(imageUrl) {
  return pixivProxyUrls(imageUrl)[0];
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * 2026-09-28 修「pixiv 代理挂了」——直联走不通时，别让代理永远排在它后面等
 *
 * 现场（本机，国内家宽；证据 = tools/test-pixiv-byid.mjs --live 在本机第 12 节崩在
 *   `Error: 请求超时：i.pximg.net`（safe-fetch.js 的 20s 超时），而同一张图走镜像代理 2 秒就回来）：
 *   · www.pixiv.net 直连是**秒失败**（fetch failed，匿名 ajax 拿不到）→ 详情一路降级到镜像站；
 *   · i.pximg.net 更难受：TCP 连得上、但一直不出数据，于是每个直联候选都**白等满 20 秒**才轮到代理；
 *   · 多页作品（一页一个候选对）就是 20s × 页数 —— 用户看到的正是"pixiv 代理挂了"。
 * 同一份代码在线上 VPS（能直连 pixiv）跑 --live 是 67/67 全过（直联 60~400ms），所以问题不在代码对不对，
 *   而在"直联这条路不通时，代码还按直联优先硬等"。
 *
 * 处理（最小改动，不动档位纪律、不动纯函数测试）：
 *   ① 直联候选单独用短超时 PIXIV_IMAGE_DIRECT_TIMEOUT_MS（正常直联 60~400ms，4s 足够；代理候选仍用默认 20s）；
 *   ② 直联候选**超时**时把整条直联路由判死 PIXIV_DIRECT_DEAD_TTL_MS，期间用 pixivPrioritizeCandidates
 *      把"同一张图、同一档位"的代理候选提到直联孪生兄弟前面（只换位置：不删候选、不改档位顺序，
 *      直联仍在代理失败后兜底；10 分钟后自动重新试一次直联，直联恢复了会自动变回来）。
 * 诚实性不变：结果里的 via 依旧按实际取字节的那条路回报（pximg-direct / mirror-proxy）。
 * ══════════════════════════════════════════════════════════════════════════════════════════ */

/** 直联 i.pximg 候选的请求超时（毫秒）。正常直联只要 60~400ms，4s 足够；代理候选不用这个值。 */
export const PIXIV_IMAGE_DIRECT_TIMEOUT_MS = 4000;
/** 镜像代理候选的请求超时（毫秒）。镜像站本来就慢：本机实测同一张图 2~18s，本文件上方还记过 25s 超时；
 *  safeFetchBuffer 的默认 20s 会把"慢但能成"的那一次直接判死 —— 这是「代理像是挂了」的另一半原因。 */
export const PIXIV_PROXY_TIMEOUT_MS = 45000;
/** 直联判死**或判活**都记这么久再重新判（毫秒）。 */
export const PIXIV_DIRECT_DEAD_TTL_MS = 10 * 60 * 1000;

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * 2026-09-28：直联可达性**探测**（带 10 分钟缓存）—— 修「本机每张图白等满超时才轮到镜像」
 *
 * 为什么要把"判死"升级成"探测"：
 *   上面那套（直联超时 → markPixivDirectDead）是**被动**的，只能等真取图超时了才反应过来。
 *   于是本机每过一个 TTL 就得再白白等一次直联超时。现在改成**主动探测 + 缓存判决**：
 *   取图之前先问一次"i.pximg 到底通不通"，据此决定候选顺序是"直连优先"还是"镜像优先"。
 *
 * 判据（怎么算"通"）：**收到任何 HTTP 响应就算通**（含 403/404）。依据是本机实测的故障形态
 *   是"连不上/不回数据"（`Connect Timeout Error (attempted address: i.pximg.net:443)`），
 *   而不是"服务器拒绝"；服务端答了话说明链路是通的，该不该用它交给真正取图时按完整超时
 *   和错误类型判。探测只取响应头就掐掉 body（不发完整的 1.9MB），所以它比取图本身便宜得多。
 *
 * 超时与延迟预算：探测超时 PIXIV_DIRECT_PROBE_TIMEOUT_MS = 1.5s。
 *   · 服务器（香港，直连实测 0.49s 拿满 1.9MB）：探测只需 TLS 握手 + 首字节，约 0.1~0.3s，
 *     而且**进程启动时就后台预热一次**（见 pixivWarmupDirectProbe），等用户真正发图时判决早已在缓存里
 *     ⇒ 服务器上取图路径不额外等任何一次探测（这正是"不要给服务器加延迟"那条要求）；
 *   · 本机：探测 1.5s 判死（对比原来直联候选白等 4s），之后 10 分钟内直接镜像优先。
 *
 * 失败语义：探测失败（超时/连接错误）**等同于判死**，直接翻转成"镜像优先"，并且写进缓存
 *   （所以失败也只探测一次，不会每张图都探）。
 * 未知语义：**没探测过**时 `pixivDirectDead()` 返回 false（= 直连优先）。这是刻意的保守选择：
 *   服务器上一旦探测因偶发网络抖动失败，代价只是 10 分钟走镜像（图还是对的，只是慢些）；
 *   反过来若把"未知"也当镜像优先，服务器每次冷启动都要先吃一次镜像延迟 —— 那才是真的引入延迟。
 *   ⚠ 取图的两个调用点（mcp-napcat-safe.js / lib/qzone-image.js）都在排序前 `await pixivDirectReachable()`，
 *   所以真实路径里"未知"这一态在排序时不会出现。
 * 诚实性不变：候选顺序变了，但结果里的 via 仍按实际取到字节的那条路回报（pximg-direct / mirror-proxy）。
 * ══════════════════════════════════════════════════════════════════════════════════════════ */

/** 探测直联可达性的超时（毫秒）。理由见上面那段：服务器 0.1~0.3s，本机到点即判死。 */
export const PIXIV_DIRECT_PROBE_TIMEOUT_MS = 1500;
/** 探测用的地址：本文件头注释里那个 2020 年就在的基准原图（存在性稳定，且与真正要取的资源同类）。 */
export const PIXIV_DIRECT_PROBE_URL = 'https://i.pximg.net/img-original/img/2020/04/08/11/41/00/80643572_p0.jpg';

/** 当前判决：{ reachable:boolean, at:number, how:'probe'|'fetch', status:number }；null = 还没判过。 */
let pixivDirectVerdict = null;
/** 正在飞的探测（并发调用共用同一个 Promise，别把探测打成洪水）。 */
let pixivDirectProbeInFlight = null;

const pixivDirectVerdictFresh = () => Boolean(pixivDirectVerdict) && (Date.now() - pixivDirectVerdict.at) < PIXIV_DIRECT_DEAD_TTL_MS;

function setPixivDirectVerdict(reachable, how, status = 0) {
  pixivDirectVerdict = { reachable: Boolean(reachable), at: Date.now(), how, status: Number(status) || 0 };
  return pixivDirectVerdict;
}

/** 直联路由现在是否被判为不可达（判决过期后自动回到 false）。 */
export function pixivDirectDead() { return pixivDirectVerdictFresh() && pixivDirectVerdict.reachable === false; }

/** 把直联路由判死一段时间；返回 true 表示"这次是刚刚判死"（调用方据此只打一次日志，别刷屏）。 */
export function markPixivDirectDead() {
  const first = !pixivDirectDead();
  setPixivDirectVerdict(false, 'fetch');
  return first;
}

/** 直联真的取到过图 ⇒ 判活（比探测更硬的证据：连 1.9MB 都拿回来了）。返回 true = 这次是刚判活。 */
export function markPixivDirectAlive() {
  const first = pixivDirectDead();
  setPixivDirectVerdict(true, 'fetch');
  return first;
}

/** 当前判决快照（诊断/自测用；顺序决策请用 pixivDirectDead）。 */
export function pixivDirectVerdictInfo() {
  if (!pixivDirectVerdict) return { reachable: null, ageMs: 0, how: '', status: 0, fresh: false };
  return {
    reachable: pixivDirectVerdict.reachable,
    ageMs: Date.now() - pixivDirectVerdict.at,
    how: pixivDirectVerdict.how,
    status: pixivDirectVerdict.status,
    fresh: pixivDirectVerdictFresh(),
  };
}

/**
 * 问一次"直联 i.pximg 通不通"，并把结论写进 10 分钟缓存。**并发调用共用同一次探测。**
 * @param {{url?:string, force?:boolean}} [opts] url 默认用 PIXIV_DIRECT_PROBE_URL；force=true 忽略缓存重探
 * @returns {Promise<boolean>} true = 可达
 */
export async function pixivDirectReachable({ url = PIXIV_DIRECT_PROBE_URL, force = false } = {}) {
  if (!force && pixivDirectVerdictFresh()) return pixivDirectVerdict.reachable;
  if (pixivDirectProbeInFlight) return pixivDirectProbeInFlight;
  pixivDirectProbeInFlight = (async () => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), PIXIV_DIRECT_PROBE_TIMEOUT_MS);
    let reachable = false;
    let status = 0;
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'user-agent': UA, referer: PIXIV_REFERER, range: 'bytes=0-1' },
        signal: ac.signal,
        redirect: 'follow',
      });
      status = Number(res.status) || 0;
      reachable = status > 0;            // 收到任何 HTTP 响应就算链路通（见上面"判据"）
      try { await res.body?.cancel(); } catch { /* 只要响应头，body 不读 */ }
    } catch { reachable = false; }
    finally { clearTimeout(timer); pixivDirectProbeInFlight = null; }
    setPixivDirectVerdict(reachable, 'probe', status);
    return reachable;
  })();
  return pixivDirectProbeInFlight;
}

/** 后台预热一次探测（不 await、不抛）。给"进程刚起来、先别让第一张图吃延迟"的调用点用。 */
export function pixivWarmupDirectProbe() {
  Promise.resolve()
    .then(() => pixivDirectReachable())
    .catch(() => { /* 预热失败无所谓：真正需要时会再探一次 */ });
}

/**
 * 候选排序：直联判死时，把"同一档位、同一张图（内层地址相同）"的代理候选提到直联前面。
 * 只换同一对孪生兄弟的先后，不动别的候选、不删任何候选、不改档位分桶顺序
 * （档位顺序是 planPixivSend 的契约：原图档 → 显式降级档，见本文件上方）。
 * 直联没判死（或参数不是数组）时原样返回，纯函数可离线测。
 */
export function pixivPrioritizeCandidates(list) {
  const arr = Array.isArray(list) ? list.slice() : [];
  if (!pixivDirectDead()) return arr;
  const inner = (s) => pixivImageInnerUrl(s?.url);
  const out = [];
  for (const s of arr) {
    if (s?.referer && !out.includes(s)) {
      const twin = arr.find((x) => x !== s && !x.referer && x.tier === s.tier && inner(x) === inner(s));
      if (twin) {
        if (!out.includes(twin)) out.push(twin);
        out.push(s);
        continue;
      }
    }
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * 2026-09-21 新增：档位识别 + 候选分档 —— 修「用户要原图，收到的却是 720 档 + 半幅灰」
 *
 * 现场（实测取证，证据是发到 QQ 的那个附件名）：`3bbd4e1d0c3c1308c4d6fbf2ca3493bc_720.jpg`
 *   · (a) 分辨率不是原图：pixiv 的档位命名是确定性的 —— `<id>_pN.jpg/_pN.png` = 原图、
 *     `<id>_pN_master1200.jpg` = 1200 档、`<id>_pN_square1200.jpg` = 250/540 缩略档，
 *     而 `_720` 是 720 档。用户没要过 720 档，代码里也没有任何一处会拼出 720 档地址
 *     （`pixivMasterUrl` 只会拼 `_master1200.jpg`）⇒ 这个地址只能来自上游给的原图地址，
 *     而此前全链路没有任何一处校验"你给我的这个地址到底是不是原图档"：
 *       · `normalizePixivIllustDetail`（本文件 1236 行）把镜像站 `urls.original` 原样收下；
 *       · `pixivIllustOriginals` 的 ③④ 兜底会拿这条地址去推别的页，并把它当"原图地址"回报；
 *       · `pixivImageSources` 1502 行 `upstream = ... : work.urls.original` 更是直接用这条地址，
 *         而且排在候选第一位 —— 于是 `size=original` 请求会首选一个 720 档地址发出去，
 *         结果里还写着 `lossless: true / contentKind: 'pixiv-original'`（谎报无损）。
 *   · (b) 字节被截断：见 safe-fetch.js 的 verifyImageComplete。
 *   两道闸门一起补：这里管"地址属于哪一档"，safe-fetch 管"字节是不是完整"。
 * ══════════════════════════════════════════════════════════════════════════════════════════ */

/** 缩略/中图路径里的 `/c/<W>x<H>` 边长前缀（W ≤ 600 一律算缩略档：c/250x250、c/360x360、c/540x540）。 */
const PIXIV_THUMB_SIDE_RE = /\/c\/(\d{3,4})x(\d{3,4})/;
/** 文件名上的"档位后缀"：`_master1200` / `_square1200` / `_custom1200` / `_720` / `_1080` 这类。 */
const PIXIV_RENDITION_NAME_RE = /_p\d+_(?:master1200|square1200|custom1200|\d{3,4})\./i;
/** 原图文件名：`<id>_pN.jpg`（`/img-original/img/` 下、且没有档位后缀）。 */
const PIXIV_ORIGINAL_NAME_RE = /\/\d+_p\d+\.(?:jpe?g|png|webp|gif)$/i;

/** 把"镜像站代理地址"还原成它包着的 i.pximg 地址（档位要看里层那个地址才准）。
 *  当前只有一种镜像形态：host 重写式 `https://i.muxmus.com/<path>`（2026-09-28 起的图片源）
 *  —— 把镜像域名换回 `i.pximg.net`。**这条是 `pixivPrioritizeCandidates` 的孪生配对能继续
 *  工作的前提**：它靠 `pixivImageInnerUrl(直联) === pixivImageInnerUrl(镜像)` 认"同一张图"，
 *  不还原的话直联判死时镜像候选就提不到前面去。
 *  老 API 式 `…/api/image.php?url=` 的解包分支随 2026-09-28 移除该图片源一并删除（不再有任何
 *  代码产出那种地址）。 */
export function pixivImageInnerUrl(rawUrl) {
  const s = String(rawUrl ?? '').trim();
  if (!s) return '';
  try {
    const u = new URL(s);
    if (PIXIV_IMAGE_MIRROR_HOSTS.includes(u.hostname.toLowerCase())) {
      return `https://i.pximg.net${u.pathname}${u.search}`;
    }
    return s;
  } catch { return s; }
}

/**
 * 这个地址是哪一档图。纯函数，离线可测（自测见 tools/test-pixiv-tier-truncation.mjs）。
 *   · `original` —— `img-original/img/<日期>/<id>_pN.<ext>`，文件名上没有任何档位后缀；
 *   · `master`   —— 1200 档，或 `_720`/`_1080` 这类按边长命名的档（≥601 边长的显式降级档）；
 *   · `thumb`    —— 缩略/中图档（`_square1200` / `_custom1200` / `c/250x250` / `c/540x540`）：永远不许当原图发；
 *   · `unknown`  —— 认不出（第三方 CDN/新形状）：不拦，但下游不许据此谎称无损。
 */
export function pixivImageTier(rawUrl) {
  const u = pixivImageInnerUrl(rawUrl);
  if (!u) return 'unknown';
  let pathOnly = u;
  try { pathOnly = new URL(u).pathname; } catch { /* 不是标准 URL：按原字符串判 */ }
  const side = PIXIV_THUMB_SIDE_RE.exec(pathOnly);
  if (/_p\d+_(?:square1200|custom1200)\./i.test(pathOnly)) return 'thumb';
  if (side && Number(side[1]) <= 600) return 'thumb';
  if (PIXIV_ORIGINAL_NAME_RE.test(pathOnly) && !PIXIV_RENDITION_NAME_RE.test(pathOnly) && !side) return 'original';
  if (/_p\d+_master1200\./i.test(pathOnly)) return 'master';
  if (/_p\d+_\d{3,4}\./i.test(pathOnly)) return 'master';
  if (/\/img-master\//.test(pathOnly) || side) return 'master';
  return 'unknown';
}

/**
 * 候选分档：把 `pixivImageSources` 给的候选拆成"可以首选发的"和"只能显式降级发的"。
 * 纯函数，离线可测（自测同上）。规矩：
 *   · 缩略档任何情况下都不发（发出去就是用户看到的那张 250×250）；
 *   · `size=original` 时 1200 档只能当 fallback：只有真原图档的候选全部失败（体积超限 / 404 / 超时 /
 *     档位像素不符）才允许走到它，而且调用方必须显式打日志 + 在结果里如实说明；
 *   · `size=master` 时 1200 档就是正常首选（用户明确要的就是它）。
 * 返回顺序与传入顺序一致（不重排候选，只分桶），老行为因此不变。
 * @returns {{primary:object[], fallback:object[], skipped:object[]}}
 */
export function planPixivSend(sources, opts = {}) {
  const wantOriginal = String(opts.size ?? 'original').toLowerCase() !== 'master';
  const primary = [];
  const fallback = [];
  const skipped = [];
  for (const s of Array.isArray(sources) ? sources : []) {
    const url = String(s?.url ?? '').trim();
    if (!url) continue;
    const tier = s?.tier || pixivImageTier(url);
    const entry = { ...s, url, tier };
    // 桶归属由本函数重算，先把上游带的标记清掉，免得"primary 里却挂着 fallback:true"这种自相矛盾
    delete entry.fallback;
    delete entry.fallbackReason;
    if (tier === 'thumb') {
      skipped.push({ ...entry, fallback: true, reason: '缩略档（250/540 的 square1200/custom1200）：不是能当原图/大图发出去的档位' });
      continue;
    }
    if (wantOriginal && tier === 'master') {
      fallback.push({ ...entry, fallback: true, fallbackReason: '原图档候选全部失败后的显式降级（体积超限/404/超时/像素不符才可能走到）' });
      continue;
    }
    primary.push(entry);
  }
  return { primary, fallback, skipped };
}

/**
 * 档位 × 实际像素 的一致性判定。纯函数，离线可测。
 *
 * 为什么光校验"地址像不像原图"不够：镜像站（第三方代理）完全可能拿着原图地址却给你一张缩过的图
 * （它的缓存/<md5>_720.jpg 就是这种产物），地址看着是原图、字节却是 720 档 —— 这次线上现场正是这样。
 * 所以再拿"作品的原图像素"（pixiv 详情里的 width/height，就是原图的尺寸）跟实际拿到的像素对一遍：
 * 只有 `page=0` 才比（详情里的宽高就是第 0 页的；其它页拿不到权威尺寸，不瞎比）。
 * @param {'original'|'master'|'thumb'|'unknown'} tier
 * @param {{originalWidth?:number, originalHeight?:number, imageWidth?:number, imageHeight?:number, page?:number}} info
 * @returns {{ok:boolean, reason:string, expectedLongSide:number, actualLongSide:number}}
 */
export function pixivTierSizeVerdict(tier, info = {}) {
  const ow = Math.max(0, Number(info.originalWidth) || 0);
  const oh = Math.max(0, Number(info.originalHeight) || 0);
  const iw = Math.max(0, Number(info.imageWidth) || 0);
  const ih = Math.max(0, Number(info.imageHeight) || 0);
  const page = Math.max(0, Number(info.page) || 0);
  const actualLongSide = Math.max(iw, ih);
  if (page !== 0) return { ok: true, reason: '', expectedLongSide: 0, actualLongSide };
  if (!iw || !ih) return { ok: true, reason: '', expectedLongSide: 0, actualLongSide };   // 认不出像素：只靠档位/尾标记判
  if (tier === 'original') {
    const expected = Math.max(ow, oh);
    if (!expected) return { ok: true, reason: '', expectedLongSide: 0, actualLongSide };
    if (actualLongSide < expected) {
      return {
        ok: false,
        expectedLongSide: expected,
        actualLongSide,
        reason: `档位不符：要的是原图（${ow}×${oh}），拿到的却是 ${iw}×${ih} —— 被上游缩过的档（线上现场就是这样拿到 720 档的）`,
      };
    }
    return { ok: true, reason: '', expectedLongSide: expected, actualLongSide };
  }
  if (tier === 'master') {
    const expected = Math.min(1200, Math.max(ow, oh));
    if (!expected) return { ok: true, reason: '', expectedLongSide: 0, actualLongSide };
    // 容 5%：pixiv 的 master1200 是按长边缩到 ≤1200，四舍五入会有 1~2px 误差
    if (actualLongSide < Math.floor(expected * 0.95)) {
      return {
        ok: false,
        expectedLongSide: expected,
        actualLongSide,
        reason: `档位不符：要的是 1200 档（长边应 ≈${expected}），拿到的长边只有 ${actualLongSide} —— 又被缩了一档`,
      };
    }
    return { ok: true, reason: '', expectedLongSide: expected, actualLongSide };
  }
  return { ok: true, reason: '', expectedLongSide: 0, actualLongSide };
}

/** 作品页地址（给模型/用户点开用）。 */
export function pixivPageUrl(id) {
  return `https://www.pixiv.net/artworks/${String(id ?? '').trim()}`;
}

/** 从一堆文本里认 pixiv 作品号：pixiv.net/artworks/123456 或裸的 6 位以上数字。 */
export function parsePixivId(text) {
  const s = String(text ?? '').trim();
  const m = /pixiv\.net\/(?:en\/)?artworks\/(\d{5,})/i.exec(s);
  if (m) return m[1];
  if (/^\d{5,}$/.test(s)) return s;
  return '';
}

/** 不宜在 QQ 里发的作品：R-18 / R-18G。默认过滤掉。
 *  fail-closed：xRestrict 缺失/非 0（含 NaN）一律当 R-18；标签兜底挡"关键词本身是 R-18 标签"的作品。 */
function isAdult(item) {
  if (Number(item?.xRestrict) !== 0) return true;
  const tags = Array.isArray(item?.tags) ? item.tags.join(' ') : '';
  return /r-?18|r18|エロ|グロ|成人|18禁/i.test(tags);
}

/* ────────────────────────── 本地筛选：参数规范化 ────────────────────────── */

export const PIXIV_SCAN_PAGES_DEFAULT = 3; // 默认往后扫几页（克制值：3 页 = 最多 180 条原始数据）
export const PIXIV_SCAN_PAGES_MAX = 10;    // 上限（镜像站 lastPage 实测就是 10）
const R18_VALUES = ['exclude', 'only', 'include'];
const SORT_VALUES = ['date_desc', 'date_asc', 'random'];
const ORIENTATION_VALUES = ['portrait', 'landscape', 'square'];
const ILLUST_TYPE_CODE = { illust: 0, manga: 1 }; // 2=动图(ugoira)，不属于这两类
/** 实测 aiType=2 才是 AI 生成（见文件头）。写成"!=0"会把整页都当 AI 排掉。 */
const AI_TYPE_OF_AI = 2;
/** AI 标签兜底正则：锚定 `^ai$` + 明确的 AI 词，避免 'Maid'、'Fairy' 这种含 "ai" 的普通标签误伤。 */
const AI_TAG_RE = /^ai$|ai\s*生成|aiイラスト|ai[-_ ]?art|ai绘画|ai作画|ai[-_ ]?girl|generated by ai|stable\s*diffusion|novelai|midjourney/i;
/** 调用方能用的全部新参数（判断"这次要不要启用筛选引擎"就靠这张表）。 */
const NEW_KEYS = ['r18', 'tags', 'author', 'orientation', 'minWidth', 'minHeight', 'multiPage', 'excludeAi', 'illustType', 'sort', 'scanPages'];

/**
 * 把调用方给的筛选参数规范化成内部形状。
 * 非法值一律不抛错（工具层要返回给模型看，不能炸）：回落到安全默认并记进 warnings，
 * 尤其是 r18 —— 取值不认识时一定回落 'exclude'，绝不可能因为拼错就把 R-18 放行。
 * @returns {object} 含 engaged（调用方到底用没用新参数）
 */
export function normalizePixivFilters(opts = {}) {
  const warnings = [];
  const given = (k) => opts[k] !== undefined && opts[k] !== null;
  const engaged = NEW_KEYS.some(given);

  let r18 = 'exclude';
  if (given('r18')) {
    const v = String(opts.r18).trim().toLowerCase();
    if (R18_VALUES.includes(v)) r18 = v;
    else warnings.push(`r18=「${opts.r18}」不认识（只有 exclude/only/include），已按最保险的 exclude 排除 R-18`);
  }

  let sort = 'date_desc';
  if (given('sort')) {
    const v = String(opts.sort).trim().toLowerCase();
    if (SORT_VALUES.includes(v)) sort = v;
    else if (/pop|hot|bookmark|fav|rank|收藏|人气|热度/.test(v)) {
      warnings.push(`sort=「${opts.sort}」做不到：镜像站返回体里没有收藏数（bookmarkData 恒为 null，实测 bookmarkCount/like/view 出现 0 次），只能按投稿时间排，已回落 date_desc`);
    } else warnings.push(`sort=「${opts.sort}」不认识（只有 date_desc/date_asc/random），已回落 date_desc`);
  }

  let tags = [];
  if (given('tags')) {
    if (Array.isArray(opts.tags)) tags = opts.tags.map((t) => String(t).trim()).filter(Boolean);
    else if (typeof opts.tags === 'string') {
      tags = opts.tags.split(/[,，、\s]+/).map((t) => t.trim()).filter(Boolean);
      if (tags.length) warnings.push('tags 传的是字符串，已按逗号/空格拆成数组（建议直接传数组）');
    } else warnings.push('tags 必须是字符串数组，已忽略');
  }

  let author = '';
  if (given('author')) {
    author = String(opts.author).trim();
    if (!author) warnings.push('author 是空串，已忽略');
  }

  let orientation = '';
  if (given('orientation')) {
    const v = String(opts.orientation).trim().toLowerCase();
    if (ORIENTATION_VALUES.includes(v)) orientation = v;
    else warnings.push(`orientation=「${opts.orientation}」不认识（只有 portrait/landscape/square），已忽略该项`);
  }

  const numOrNull = (key, min) => {
    if (!given(key)) return null;
    const n = Number(opts[key]);
    if (Number.isFinite(n) && n >= min) return n;
    warnings.push(`${key}=「${opts[key]}」不是 ≥${min} 的数字，已忽略该项`);
    return null;
  };
  const minWidth = numOrNull('minWidth', 1);
  const minHeight = numOrNull('minHeight', 1);

  let multiPage = false;
  if (given('multiPage')) {
    if (typeof opts.multiPage === 'boolean') multiPage = opts.multiPage;
    else warnings.push(`multiPage=「${opts.multiPage}」不是布尔值，已忽略该项`);
  }
  let excludeAi = false;
  if (given('excludeAi')) {
    if (typeof opts.excludeAi === 'boolean') excludeAi = opts.excludeAi;
    else warnings.push(`excludeAi=「${opts.excludeAi}」不是布尔值，已忽略该项`);
  }

  let illustType = '';
  if (given('illustType')) {
    const v = String(opts.illustType).trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(ILLUST_TYPE_CODE, v)) illustType = v;
    else warnings.push(`illustType=「${opts.illustType}」不认识（只有 illust=插画0 / manga=漫画1；本站还有 illustType=2 的动图，不属于这两类），已忽略该项`);
  }

  let scanPages = PIXIV_SCAN_PAGES_DEFAULT;
  if (given('scanPages')) {
    const n = Number(opts.scanPages);
    if (Number.isFinite(n) && n >= 1) {
      const capped = Math.min(PIXIV_SCAN_PAGES_MAX, Math.floor(n));
      if (capped !== Math.floor(n)) warnings.push(`scanPages=${opts.scanPages} 超过上限，已按 ${PIXIV_SCAN_PAGES_MAX} 页处理`);
      scanPages = capped;
    } else warnings.push(`scanPages=「${opts.scanPages}」不是 ≥1 的数字，已按默认 ${PIXIV_SCAN_PAGES_DEFAULT} 页处理`);
  }

  return {
    engaged, warnings,
    r18, tags, author, orientation, minWidth, minHeight, multiPage, excludeAi, illustType, sort, scanPages,
  };
}

/* ────────────────────────── 本地筛选：逐条判定（纯函数） ────────────────────────── */

/** 构图：竖图/横图/正方；尺寸缺失（0）判不出来 → 返回空串。 */
function orientationOf(item) {
  const w = Number(item?.width) || 0;
  const h = Number(item?.height) || 0;
  if (!w || !h) return '';
  if (h > w) return 'portrait';
  if (w > h) return 'landscape';
  return 'square';
}

/** 是不是 AI 生成：以实测的 aiType=2 为准，再用标签兜底（aiType 有漏标时仍能挡住一部分）。 */
function isAiWork(item) {
  if (Number(item?.aiType) === AI_TYPE_OF_AI) return true;
  const tags = Array.isArray(item?.tags) ? item.tags : [];
  return tags.some((t) => AI_TAG_RE.test(String(t)));
}

/** 标签全命中（大小写不敏感、子串匹配：'初音ミク' 能命中 '初音ミク(Hatsune Miku)'）。 */
function hitAllTags(item, wanted) {
  const have = (Array.isArray(item?.tags) ? item.tags : []).map((t) => String(t).toLowerCase());
  return wanted.every((w) => {
    const lw = String(w).toLowerCase();
    return have.some((h) => h.includes(lw));
  });
}

/** 作者：纯数字当 userId 精确比对，否则按 userName 子串匹配（大小写不敏感）。 */
function hitAuthor(item, want) {
  if (/^\d+$/.test(want)) return String(item?.userId ?? '') === want;
  return String(item?.userName ?? '').toLowerCase().includes(want.toLowerCase());
}

/**
 * 对一批镜像站原始条目做本地筛选（纯函数，离线可测，见 tools/test-pixiv-filters.mjs）。
 * @param {Array} items 原始条目
 * @param {object} f normalizePixivFilters 的结果
 * @param {Set<string>} seenIds 跨页去重用的已见 id（会被就地更新）
 * @returns {{items:Array, dropped:object, droppedTotal:number}} dropped = 各类丢弃计数（写进 scan 里给模型看）
 */
export function filterPixivItems(items, f, seenIds = new Set()) {
  const kept = [];
  const dropped = {
    noId: 0, adult: 0, notR18: 0, tag: 0, author: 0, orientation: 0,
    minWidth: 0, minHeight: 0, multiPage: 0, ai: 0, illustType: 0, duplicate: 0,
  };
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || !it.id) { dropped.noId++; continue; }
    const id = String(it.id);
    if (seenIds.has(id)) { dropped.duplicate++; continue; }

    // ① R-18 规则（默认 exclude，与旧行为一致）
    const adult = isAdult(it);
    if (f.r18 === 'exclude' && adult) { dropped.adult++; continue; }
    if (f.r18 === 'only' && !adult) { dropped.notR18++; continue; }
    // 'include' → 不按 R-18 过滤

    // ② 标签全命中
    if (f.tags.length && !hitAllTags(it, f.tags)) { dropped.tag++; continue; }
    // ③ 作者
    if (f.author && !hitAuthor(it, f.author)) { dropped.author++; continue; }
    // ④ 构图（尺寸缺失判不出来 → 该条不算命中，如实排除）
    if (f.orientation) {
      const o = orientationOf(it);
      if (o !== f.orientation) { dropped.orientation++; continue; }
    }
    // ⑤ 最小尺寸（0/缺失都算不达标）
    if (f.minWidth !== null && (Number(it.width) || 0) < f.minWidth) { dropped.minWidth++; continue; }
    if (f.minHeight !== null && (Number(it.height) || 0) < f.minHeight) { dropped.minHeight++; continue; }
    // ⑥ 只看多图
    if (f.multiPage && !(Number(it.pageCount) > 1)) { dropped.multiPage++; continue; }
    // ⑦ 排除 AI
    if (f.excludeAi && isAiWork(it)) { dropped.ai++; continue; }
    // ⑧ 插画 / 漫画
    if (f.illustType && Number(it.illustType) !== ILLUST_TYPE_CODE[f.illustType]) { dropped.illustType++; continue; }

    seenIds.add(id);
    kept.push(it);
  }
  const droppedTotal = Object.values(dropped).reduce((a, b) => a + b, 0);
  return { items: kept, dropped, droppedTotal };
}

/** 按 createDate（ISO，带 +09:00 偏移）排序；缺日期当 0 处理。Array.sort 在 V8 里是稳定排序。 */
function sortByCreateDate(items, dir) {
  return items.slice().sort((a, b) => {
    const ta = Date.parse(a?.createDate ?? '') || 0;
    const tb = Date.parse(b?.createDate ?? '') || 0;
    return dir > 0 ? ta - tb : tb - ta;
  });
}

/** Fisher–Yates 洗牌（sort='random' 用；不追求可复现，只在已扫到的页里打乱）。 */
function shuffle(items) {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** 原始条目 → 对外返回的形状（旧版原样保留，字段一个不动，避免改坏下游）。 */
function toResult(it) {
  return {
    id: String(it.id),
    title: String(it.title ?? '').trim(),
    author: String(it.userName ?? '').trim(),
    tags: (Array.isArray(it.tags) ? it.tags : []).map(String).slice(0, 8),
    pages: Number(it.pageCount) || 1,
    width: Number(it.width) || 0,
    height: Number(it.height) || 0,
    pageUrl: pixivPageUrl(it.id),
    thumbUrl: String(it.url ?? '').trim(),
    description: String(it.alt ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
  };
}

/** 扫描摘要的中文一句话（模型只读这段也能明白"没筛全站"）。 */
function buildScanNotice({ q, scanned, fromPage, toPage, scanPages, total, lastPage, rawScanned, kept, returned, dropped, f, warnings, sort, reachedLimit, exhausted, source, perPage }) {
  const parts = [];
  // 来源要写出来（2026-09-20）：三个来源的每页条数与"全站共多少"都不一样，不写清楚模型会把
  // app-api 的 30 条/页 当成 60 条/页 去推算。
  const totalText = total ? `全站共 ${total} 条` : '全站条数未知';
  parts.push(`本地筛选（数据来源 ${source || '?'}，每页 ${perPage || 60} 条）：搜「${q}」${totalText}（上游最多给 ${lastPage || '?'} 页）`);
  parts.push(`本次扫了第 ${fromPage}~${toPage} 页共 ${scanned} 页（上限 ${scanPages} 页），原始 ${rawScanned} 条`);
  const dropBits = [];
  if (dropped.adult) dropBits.push(`R-18 规则 ${dropped.adult} 条`);
  if (dropped.notR18) dropBits.push(`非 R-18 ${dropped.notR18} 条`);
  if (dropped.duplicate) dropBits.push(`跨页重复 ${dropped.duplicate} 条`);
  const ruleDrop = dropped.tag + dropped.author + dropped.orientation + dropped.minWidth + dropped.minHeight + dropped.multiPage + dropped.ai + dropped.illustType;
  if (ruleDrop) dropBits.push(`条件不符 ${ruleDrop} 条`);
  parts.push(`筛掉 ${dropBits.length ? dropBits.join('、') : '0 条'}，命中 ${kept} 条，返回 ${returned} 条`);
  parts.push(`r18=${f.r18}、排序=${sort}`);
  if (exhausted) parts.push('已扫到上游最后一页（后面没有了）');
  else if (reachedLimit) parts.push('命中已够 limit，没继续往后翻');
  else parts.push(`扫满 ${scanPages} 页上限仍未凑够 limit（后面还有页，可调大 scanPages 或放宽筛选）`);
  if (warnings.length) parts.push(`提示：${warnings.join('；')}`);
  return parts.join('；') + '。注意：这不是全站筛选结果。';
}

/**
 * 搜 Pixiv 作品。
 *
 * 旧签名照旧（query + page + limit）；新增本地筛选参数（见 normalizePixivFilters）。
 * @returns {Promise<{query:string, page:number, total:number, lastPage:number, filtered:number, results:Array,
 *                    scan?:object, scanNotice?:string}>}
 *          scan / scanNotice 只在用了筛选参数时出现（旧路径不产生，保证与改动前逐字段一致）。
 */
export async function pixivSearch(query, opts = {}) {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('搜索词不能为空');
  const page = Math.max(1, Math.min(200, Number(opts.page) || 1));
  const limit = Math.min(20, Math.max(1, Number(opts.limit) || 8));
  const f = normalizePixivFilters(opts);

  /* ── 旧路径：调用方一个筛选参数都没用 → 与改动前逐字段一致（只抓 1 页、不排序、只过滤 R-18）──
   * 这里故意不加 source/sourcesTried：硬要求是"不传任何新参数时结果逐字段一致"，
   *    多一个键就不再一致（离线自测 tools/test-pixiv-filters.mjs 第一段就是钉这件事的）。
   *    想知道这次是谁供的数据，要么带上任意筛选参数（走下面那条路），要么看 scan.source。 */
  if (!f.engaged) {
    const box = await fetchPixivSearchPage(q, page);
    const safe = box.data.filter((it) => it && it.id && !isAdult(it));
    const filtered = box.data.length - safe.length;
    const results = safe.slice(0, limit).map(toResult);
    return { query: q, page, total: box.total, lastPage: box.lastPage, filtered, results };
  }

  /* ── 扫描引擎：按页往后翻，直到筛够 limit / 扫满 scanPages / 到底 lastPage ── */
  const seenIds = new Set();
  const kept = [];
  const dropped = {
    noId: 0, adult: 0, notR18: 0, tag: 0, author: 0, orientation: 0,
    minWidth: 0, minHeight: 0, multiPage: 0, ai: 0, illustType: 0, duplicate: 0,
  };
  const warnings = [...f.warnings];
  let scanned = 0;
  let fromPage = page;
  let toPage = page;
  let rawScanned = 0;
  let total = 0;
  let lastPage = 0;
  let exhausted = false;
  let reachedLimit = false;
  let source = '';            // 第 1 页是谁供的（正常情况全程同一家）
  let perPage = 0;
  const sourcesTried = [];    // 这一轮搜索里"试过但全军覆没"的来源（如实报给模型，别假装一切正常）

  for (let i = 0; i < f.scanPages; i += 1) {
    const p = page + i;
    if (p > 200) { warnings.push('页码已达 200 上限，停止翻页'); break; }
    let box;
    try {
      box = await fetchPixivSearchPage(q, p);
    } catch (e) {
      // 第一页就抓不到 → 按旧行为抛错；中途失败 → 保留已扫到的部分结果（别把第一页的收获也扔掉）
      if (i === 0) throw e;
      warnings.push(`第 ${p} 页抓取失败（${e?.message ?? e}），已返回扫到的 ${scanned} 页结果`);
      break;
    }
    scanned += 1;
    toPage = p;
    if (!source) { source = box.source; perPage = box.perPage; }
    else if (source !== box.source) warnings.push(`第 ${p} 页换了个来源（${box.source}），不同来源每页条数不同，筛选口径不受影响`);
    for (const t of box.sourcesTried || []) if (!sourcesTried.includes(t)) sourcesTried.push(t);
    rawScanned += box.data.length;
    if (box.total) total = box.total;
    if (box.lastPage) lastPage = box.lastPage;

    const r = filterPixivItems(box.data, f, seenIds);
    for (const k of Object.keys(dropped)) dropped[k] += r.dropped[k] || 0;
    kept.push(...r.items);

    if (kept.length >= limit) { reachedLimit = true; break; }
    if (lastPage && p >= lastPage) { exhausted = true; break; }
  }

  if (!scanned) throw new Error('pixiv 搜索失败：一页都没扫到');
  /* 注意：这里**不**再额外塞一条"扫满上限仍不够"的警告 —— scan 里的 reachedLimit/exhausted
   * 和下面 scanNotice 的末句已经把这件事说清楚了，再塞一条会让模型的 JSON 里出现两遍同样的话。 */

  // 排序只在已扫到的页内生效（镜像站不给服务端排序，而且我们要先凑够 limit 才能截断）
  const ordered = f.sort === 'random' ? shuffle(kept)
    : f.sort === 'date_asc' ? sortByCreateDate(kept, 1)
      : sortByCreateDate(kept, -1);
  const results = ordered.slice(0, limit).map(toResult);
  const droppedTotal = Object.values(dropped).reduce((a, b) => a + b, 0);

  const scan = {
    pagesScanned: scanned,
    fromPage,
    toPage,
    scanPagesLimit: f.scanPages,
    total,
    lastPage,
    rawScanned,
    kept: kept.length,
    returned: results.length,
    dropped,
    droppedTotal,
    reachedLimit,       // 凑够 limit 了
    exhausted,          // 扫到上游最后一页了
    r18: f.r18,
    sort: f.sort,
    source,             // 谁供的数据：app-api / web-ajax / mirror（2026-09-20 起官方优先）
    perPage,
    sourcesTried,       // 试过但没成的来源（含原因）
    filters: {
      tags: f.tags, author: f.author, orientation: f.orientation,
      minWidth: f.minWidth, minHeight: f.minHeight,
      multiPage: f.multiPage, excludeAi: f.excludeAi, illustType: f.illustType,
    },
    warnings,
  };
  return {
    query: q,
    page,
    total,
    lastPage,
    // 旧字段语义保持：被 R-18 规则丢掉的条数（发图工具的"已过滤 R-18 N 条"提示还在用）
    filtered: dropped.adult + dropped.notR18,
    results,
    source,
    sourcesTried,
    scan,
    scanNotice: buildScanNotice({
      q, scanned, fromPage, toPage, scanPages: f.scanPages, total, lastPage,
      rawScanned, kept: kept.length, returned: results.length, dropped, f, warnings, sort: f.sort,
      reachedLimit, exhausted, source, perPage,
    }),
  };
}

/**
 * 由搜索结果推出可下载的大图地址（按可靠性排序，全部走站内代理）。
 * @param {object} work pixivSearch 的 results 里的元素（或任何带 thumbUrl 的对象）
 * @param {{page?:number, size?:'master'|'original'}} opts
 * @returns {string[]} 候选 URL，按优先级从高到低
 */
export function pixivImageCandidates(work, opts = {}) {
  const id = String(work?.id ?? '').trim();
  const thumb = String(work?.thumbUrl ?? '').trim();
  const p = Math.max(0, Number(opts.page) || 0);
  const size = String(opts.size ?? 'master').toLowerCase() === 'original' ? 'original' : 'master';
  const out = [];
  /* 2026-09-28：一个地址现在展开成**多个镜像候选**（host 重写式，顺序 = 实测可靠性）。
   * 展开要成组做：先把 ① 的第一条镜像全试完，再试 ② 的 —— 所以这里是"每条地址各自展开"，
   * 不是"每个镜像各轮一遍所有地址"（后者会把更可能命中的 muxmus 拖到最后一个）。 */
  const pushProxy = (u) => { for (const one of pixivProxyUrls(u)) out.push(one); };
  // 缩略图 URL 里的日期路径 —— master / original / custom-thumb 三种都吃
  const m = thumb ? /\/img\/(\d{4}\/\d{2}\/\d{2}\/\d{2}\/\d{2}\/\d{2})\/(\d+)_p(\d+)_/.exec(thumb) : null;
  if (m && id) {
    const datePath = m[1];
    const pid = m[2];
    const master = `https://i.pximg.net/img-master/img/${datePath}/${pid}_p${p}_master1200.jpg`;
    if (size === 'original') {
      // 原图扩展名有 jpg 也有 png，两个都试（站内代理会自己挑得到内容的那个）
      pushProxy(`https://i.pximg.net/img-original/img/${datePath}/${pid}_p${p}.jpg`);
      pushProxy(`https://i.pximg.net/img-original/img/${datePath}/${pid}_p${p}.png`);
    }
    pushProxy(master);
  }
  // 最后兜底：就用搜索结果给的那张缩略图（也过代理）
  if (thumb) pushProxy(thumb);
  return [...new Set(out)];
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * 2026-09-18 新增：按作品号取图 —— 修「给了 illustId 却试了 0 个地址」
 *
 * 现场（实测取证）：`qq_send_pixiv {illustId:"80643572", size:"original"}` 返回
 *   `Pixiv 图片下载失败（试了 0 个地址）`，一个候选都没生成。
 * 根因：换 illustId 的那条路只会拼 `work = {id, thumbUrl:''}`（当时注释写着"没有按号取详情的免登录接口"），
 *   而 `pixivImageCandidates` 是从 thumbUrl 里的日期路径推大图地址的 —— thumbUrl 是空串，
 *   日期路径推不出来，于是 out 里只剩"再兜一次空 thumb"= 0 个候选。
 *   ⇒ 这条路等于从来没通过：不是被风控、也不是地址过期，是压根没地址可试。
 *
 * 修法：先按作品号把"下游地址"问出来，再交给 `pixivImageSources` 拼候选。实测可用的来源：
 *   ① pixiv 直联（首选）：`ajax/illust/{id}` 取元数据、`ajax/illust/{id}/pages` 取逐页原图直链。
 *      实测 `pages` 给出的就是 `https://i.pximg.net/img-original/img/<日期>_p<N>.<ext>` —— 真原图，
 *      拿它拼地址不用猜日期、也不用猜扩展名（同一作品各页扩展名实测一致，但不同作品有 jpg 也有 png）。
 *      注意 `ajax/illust/{id}` 的 `urls` 字段可能整组为 null（实测：80643572 全 null，
 *      149807268 齐全），所以不要只依赖它 —— 原图地址以 `pages` 为准。
 *   ② 镜像站兜底：`api/detail.php?id=`（形状与 pixiv 的 ajax 一致，它用自己的登录态取），
 *      慢（实测 0.9~14s）且偶发超时，只在 ① 失败时用。
 * 取字节：`i.pximg.net` 需要 `referer: https://www.pixiv.net/`（不带 403），所以直联优先、镜像代理兜底；
 *   两者返回的字节实测逐字节相同（jpg 1,886,996B sha 536c4aeb… / png 696,829B sha c792e5ce…）。
 *
 * R-18 闸门：按号取图不会经过搜索的本地筛选，所以这里必须自己判 —— 用同一个 `isAdult` 规则
 *   （xRestrict 缺失/非 0 一律当 R-18）。实测 R-18 作品 `ajax/illust` 仍会 200 且 `xRestrict:1`
 *   （例：110000000），所以"官网会替我挡"是错的；倒是 `pages` 对 R-18 会 404。
 * ══════════════════════════════════════════════════════════════════════════════════════════ */

/** 直联 pixiv 时必须带的 Referer（图床防盗链只认它；ajax 本身带不带都行）。 */
export const PIXIV_REFERER = 'https://www.pixiv.net/';
const PIXIV_AJAX = 'https://www.pixiv.net/ajax';
const PIXIV_APP_API = 'https://app-api.pixiv.net/v1';
const PIXIV_DIRECT_TIMEOUT_MS = 15000;
/** app-api 每页 30 条（web ajax 与镜像站是 60 条）—— 翻页与"每页多少"的说明都按来源分开算。 */
const PIXIV_APP_PAGE_SIZE = 30;
/** 按画师号取作品时最多向后翻几页 app-api（每页 30 件 → 上限 300 件；超过就不翻了，别把人家的接口当爬虫）。 */
const PIXIV_USER_WORKS_MAX_PAGES = 10;

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * 2026-09-20 新增：三个来源 + 统一行形状。
 * 关键约束：不管哪一家供的数据，进筛选之前必须是同一个形状（web ajax / 镜像站那套 camelCase）——
 *   ① 筛选函数（filterPixivItems 那一串）是纯函数、被离线自测钉死了，不能为来源分叉；
 *   ② 老路径"不传新参数时结果逐字段一致"是硬要求，web ajax / 镜像站的行原样透传才算一致。
 * 所以 app-api 的 snake_case 行在这里一次性翻译成 camelCase，之后全流程不再提"来源"二字。
 * xRestrict：app-api 缺这个键时不能补 0 —— isAdult 是 fail-closed（键缺失一律当 R-18），
 *   补 0 会把 R-18 放行。所以只在原字段存在时才写。
 * ══════════════════════════════════════════════════════════════════════════════════════════ */

/** app-api 的作品对象 → "镜像站形状"的那一行。 */
function appApiRowToWebRow(it) {
  const tags = (Array.isArray(it?.tags) ? it.tags : []).map((t) => String(t?.name ?? t ?? '').trim()).filter(Boolean);
  const imgs = it?.image_urls ?? {};
  const row = {
    id: String(it?.id ?? ''),
    title: String(it?.title ?? ''),
    userName: String(it?.user?.name ?? ''),
    userId: String(it?.user?.id ?? ''),
    tags,
    // 缩略图 URL 里带日期路径 —— 搜索结果的"推大图"（pixivImageCandidates）就是靠它，所以必须留着
    url: String(imgs.square_medium ?? imgs.medium ?? imgs.large ?? imgs.thumb ?? ''),
    width: Number(it?.width) || 0,
    height: Number(it?.height) || 0,
    pageCount: Math.max(1, Number(it?.page_count) || 1),
    illustType: Number(it?.illust_type) || 0,
    createDate: String(it?.create_date ?? ''),
    alt: String(it?.alt ?? ''),
  };
  if (it?.x_restrict !== undefined && it?.x_restrict !== null) row.xRestrict = Number(it.x_restrict);
  if (it?.illust_ai_type !== undefined) row.aiType = Number(it.illust_ai_type);
  return row;
}

/** 任意来源的一行 → "镜像站形状"。web ajax / 镜像站本来就是这形状，**原样返回**（老路径一致性靠这行）。 */
function normalizePixivRow(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  if (raw.image_urls || raw.user) return appApiRowToWebRow(raw);   // app-api 那套（有嵌套的 user/image_urls）
  return raw;
}

/** app-api 的作品对象 → web ajax 的 body 形状（详情复用同一个归一化函数，不写第二套字段映射）。 */
function appApiIllustToWebBody(it) {
  const row = appApiRowToWebRow(it);
  const imgs = it?.image_urls ?? {};
  const metaPages = (Array.isArray(it?.meta_pages) ? it.meta_pages : [])
    .map((p) => String(p?.image_urls?.original ?? '').trim()).filter(Boolean);
  return {
    ...row,
    description: String(it?.caption ?? ''),
    tags: { tags: row.tags.map((tag) => ({ tag })) },
    urls: {
      original: String(imgs.original ?? metaPages[0] ?? ''),
      regular: String(imgs.large ?? ''),
      thumb: String(imgs.square_medium ?? imgs.medium ?? ''),
    },
    metaPages,   // ← 逐页原图直链：pixivIllustOriginals 的首选，省掉一次 pages 请求
  };
}

/** 失败原因里那句"官网为什么拒绝"（有 message 就带上，没有就空）。 */
function httpHint(json) {
  const m = json?.message ?? json?.error?.message;
  return m ? `（${String(m).replace(/\s+/g, ' ').slice(0, 60)}）` : '';
}

/** app-api 需要 Bearer：没登录态时抛这个，调用方据此**跳过**（不联网），并在 sourcesTried 里如实说。 */
const NO_TOKEN_MSG = '没有登录态（跳过：匿名调 app-api 必 400）';

/* ── 关键词搜索：三个来源各一个实现，返回同一个形状 ────────────────────────────────────── */

/** ① 官方 app-api `/v1/search/illust`（Bearer）。 */
async function appApiSearchPage(keyword, page) {
  const token = await getPixivAccessToken();
  if (!token) throw new Error(NO_TOKEN_MSG);
  const q = new URLSearchParams({
    word: keyword,
    search_target: 'partial_match_for_tags',
    sort: 'date_desc',
    filter: 'for_android',
    offset: String((page - 1) * PIXIV_APP_PAGE_SIZE),
    lang: 'zh',
  });
  const r = await fetchPixivJson(`${PIXIV_APP_API}/search/illust?${q.toString()}`, PIXIV_DIRECT_TIMEOUT_MS, pixivAppApiHeaders(token));
  const arr = r.json?.illusts;
  if (r.json?.error || !Array.isArray(arr)) throw new Error(`HTTP ${r.status}${httpHint(r.json)}`);
  return {
    data: arr.map(normalizePixivRow),
    total: 0,                                        // app-api 不给全站条数：**如实报 0 = 未知**，别编一个
    lastPage: r.json?.next_url ? 0 : page,           // 没有 next_url 就是"到底了"
    perPage: PIXIV_APP_PAGE_SIZE,
  };
}

/** ② pixiv web ajax `/ajax/search/artworks/<kw>`（匿名可用）。翻页参数 `p` 与前端 chunk 一致。 */
async function webAjaxSearchPage(keyword, page) {
  const url = `${PIXIV_AJAX}/search/artworks/${encodeURIComponent(keyword)}?lang=zh&p=${page}`;
  const r = await fetchPixivJson(url);
  const box = r.json?.body?.illustManga ?? r.json?.body?.illust ?? null;
  if (r.json?.error || !box || !Array.isArray(box.data)) throw new Error(`HTTP ${r.status}${httpHint(r.json)}`);
  return {
    data: box.data.map(normalizePixivRow),
    total: Number(box.total) || 0,
    lastPage: Number(box.lastPage) || 0,
    perPage: 60,
  };
}

/**
 * ③ 第三方镜像站 search.php（形状与 web ajax 一致，只是慢）。不带任何凭证。
 *
 * 为什么这一条要重试 1 次（2026-09-18 的现场记录，原注释移到这里）：这个平替站偶发慢/超时
 * （实测同一条请求 0.4s 正常，偶尔直接挂到 12s 超时），重试一次再放弃 —— 否则一次抖动模型就会
 * 以为"Pixiv 搜不到"。官网那两条路是硬失败（400/404 立刻回），重试没意义，所以等待只留给这里。
 */
async function mirrorSearchPage(keyword, page) {
  const base = pixivBase();
  const url = `${base}/api/search.php?keyword=${encodeURIComponent(keyword)}&page=${page}`;
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/json, text/plain, */*', referer: `${base}/` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (body?.error) throw new Error(body.message || '镜像站说请求有误');
  const box = body?.body?.illustManga ?? body?.body?.illust ?? null;
  return {
    data: Array.isArray(box?.data) ? box.data.map(normalizePixivRow) : [],
    total: Number(box?.total) || 0,
    lastPage: Number(box?.lastPage) || 0,
    perPage: 60,
  };
}

/** 来源顺序（2026-09-20 定的"官方优先"）。第 3 项是"重试前等多少毫秒"。 */
const PIXIV_SEARCH_SOURCES = [
  ['app-api', appApiSearchPage, 0],
  ['web-ajax', webAjaxSearchPage, 0],
  ['mirror', mirrorSearchPage, 1200],   // 只有它偶发慢/超时，值得等一下再试第二次
];

/**
 * 按官方→镜像的顺序要一页搜索结果。每个来源最多试 2 次（首次 + 1 次重试）。
 * @returns {Promise<{data:Array, total:number, lastPage:number, perPage:number, source:string, sourcesTried:string[]}>}
 */
async function fetchPixivSearchPage(keyword, page) {
  const tried = [];
  for (const [name, run, retryDelayMs] of PIXIV_SEARCH_SOURCES) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const box = await run(keyword, page);
        return { ...box, source: name, sourcesTried: tried };
      } catch (e) {
        const msg = `${name}: ${e?.message ?? e}`;
        // 只记"这个来源彻底不行了"那一条（第一次失败还不算结论）
        if (attempt === 1) tried.push(msg);
        else if (retryDelayMs) await new Promise((r) => setTimeout(r, retryDelayMs));
      }
    }
  }
  throw new Error(`pixiv 搜索失败：三个来源都没给出结果 —— ${tried.join('；')}`);
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * 2026-09-19 新增：pixiv 登录态（cookie）—— 只为"按名字搜画师"这一件事。
 *
 * 为什么需要：pixiv 的用户搜索接口对匿名请求一律拒绝。实测（线上 VPS，未登录）：
 *   · GET /ajax/search/users?word=米山舞[&s_mode=s_usr][&p=1][&type=user] → 400「不正确的请求。」
 *     （注意不是 404：路由存在，只是不接受匿名请求）
 *   · GET /ajax/search/users/米山舞 → 404；/ajax/search/users/米山舞?s_mode=s_usr → 404
 *   · 作品关键词搜索替不了它：搜「米山舞」全站 173 条里，作者名含"米山舞"的0 条
 *     （那些是打了她名字标签的粉丝图）。所以"找某人本人的作品"没法靠关键词搜。
 *   · 镜像站（当时试的是 x.pixigraph.xyz）也没有用户搜索（猜的 5 条路由全 404，search.php 忽略 type/mode/s_mode，
 *     native.php 代拉 pixiv 的用户搜索返回空）。
 *   ⇒ 想按名字找人，只能自己带登录态。免费号就够（会员只管人气排序/多标签检索这类玩法）。
 *
 * 三条纪律：
 *   ① 只在 pixiv 域名上带 cookie（见 pixivRequestHeaders）—— 绝不能把登录凭证发给第三方镜像站；
 *   ② cookie 只从本地配置读（config.json 的 pixiv.cookie / 环境变量），永不写进任何返回值、日志或 QQ 消息；
 *   ③ 没配 cookie 时"按名字搜"要明确说不支持，不许悄悄退化成"关键词搜"（那会给出错误的答案）。
 *
 * 2026-09-20 更新：cookie 从"日常必需"降级为"只在引导时用一次"：手动贴一次 PHPSESSID，
 * 桥拿它换长期 refresh_token（lib/pixiv-auth.js），之后 app-api 用 Bearer、自动轮换，不用再管。
 * 这一段（config.json 的 pixiv.cookie）留着不删：它是旧安装的兼容路径、也是令牌彻底坏掉时的应急手段。
 * ══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * 纯函数：把用户给的东西规整成一条能用的 Cookie 头。
 * 容忍三种写法（不一定会照抄格式）：整条 cookie 串、`PHPSESSID=xxx`、光秃秃的会话值。
 * 空/含换行（有人会连回车一起复制）都要处理干净 —— 换行进请求头会直接把请求弄坏。
 * @returns {string} 可用则返回 cookie 串，否则空串
 */
export function cleanPixivCookie(v) {
  let s = String(v ?? '').replace(/[\r\n\t]+/g, ' ').trim();
  if (!s) return '';
  // 有人只复制会话值本身（32 位左右的十六进制/字母数字），补上键名
  if (!s.includes('=') && /^[A-Za-z0-9_%\-+/=.]{8,200}$/.test(s)) s = `PHPSESSID=${s}`;
  // 只保留 pixiv 需要的几个键（其余键带过去没意义，还会把凭证面铺大）
  const keep = s.split(';')
    .map((x) => x.trim())
    .filter((x) => /^(PHPSESSID|device_token|p_ab_id|p_ab_id_2|p_ab_d_id|p_ab_id_3|yuid_b|cookies_banner)=/i.test(x));
  const out = (keep.length ? keep : [s]).join('; ').slice(0, 2000);
  return /^[\x20-\x7E]+$/.test(out) ? out : '';
}

/** 读 config.json 的 pixiv.cookie（读不到/格式坏都当"没配"，绝不让它把搜索搞挂）。 */
export function configPixivCookie() {
  try {
    let text = fs.readFileSync(CONFIG_PATH, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return cleanPixivCookie(JSON.parse(text)?.pixiv?.cookie);
  } catch {
    return '';
  }
}

/**
 * 当前生效的 pixiv 登录 cookie。每次现读 config.json：贴完新 cookie 不用重启 MCP 子进程。
 * `QQBRIDGE_PIXIV_COOKIE_OFF=1` 可以强制"没有登录态"（自检/验证缓存兜底时用，也方便临时停用而不删配置）。
 */
export function pixivCookie() {
  if (String(process.env.QQBRIDGE_PIXIV_COOKIE_OFF ?? '').trim() === '1') return '';
  return configPixivCookie() || cleanPixivCookie(process.env.QQBRIDGE_PIXIV_COOKIE);
}

/** 是否配了登录 cookie（只回布尔，**绝不回值**）。 */
export function pixivLoggedIn() {
  return pixivCookie().length > 0;
}

/* ── 「名字 → 画师号」本地缓存（2026-09-19）────────────────────────────────────────────
 * 手写 cookie 只愿意配合一次，而登录态总有失效的时候（2026-09-20 起已经是自动轮换的长期令牌，见
 * lib/pixiv-auth.js，但令牌也可能被 pixiv 吊销/网络不可达）。而它其实只在解析名字时需要：
 * 解出来之后，按画师号发作品、取原图全都不需要登录态。
 * 所以把每次成功解出的候选表按名字落盘 —— 登录态掉了，已经查过的名字照样能用。
 * 文件：<qq-bridge>/state/pixiv-artists.json（原子写；最多留 500 条，超出按时间淘汰最旧的）。 */
const ARTIST_CACHE_PATH = process.env.QQBRIDGE_PIXIV_CACHE_PATH
  ? path.resolve(String(process.env.QQBRIDGE_PIXIV_CACHE_PATH))
  : path.resolve(__dirname, '..', '..', 'state', 'pixiv-artists.json');
const ARTIST_CACHE_MAX = 500;

/** 读缓存（读不到/坏文件都当空表，绝不让它把搜索搞挂）。 */
export function readArtistCache() {
  try {
    const j = JSON.parse(fs.readFileSync(ARTIST_CACHE_PATH, 'utf8'));
    return j && typeof j === 'object' && j.names && typeof j.names === 'object' ? j.names : {};
  } catch {
    return {};
  }
}

/** 按名字取缓存条目（返回 users 数组或 null）。 */
export function artistCacheGet(name) {
  const key = normalizeArtistName(name);
  const hit = readArtistCache()[key];
  if (!hit || !Array.isArray(hit.users) || !hit.users.length) return null;
  return { at: Number(hit.at) || 0, users: hit.users, name: String(hit.name ?? name) };
}

/** 写入一条缓存（原子写；失败只记不抛 —— 缓存不该把主流程搞挂）。 */
export function artistCacheSet(name, users) {
  if (!Array.isArray(users) || !users.length) return false;
  const key = normalizeArtistName(name);
  if (!key) return false;
  try {
    const all = readArtistCache();
    all[key] = { at: Date.now(), name: String(name), users };
    const keys = Object.keys(all);
    if (keys.length > ARTIST_CACHE_MAX) {
      keys.sort((a, b) => (Number(all[a]?.at) || 0) - (Number(all[b]?.at) || 0));
      for (const k of keys.slice(0, keys.length - ARTIST_CACHE_MAX)) delete all[k];
    }
    fs.mkdirSync(path.dirname(ARTIST_CACHE_PATH), { recursive: true });
    const tmp = `${ARTIST_CACHE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, names: all }, null, 2));
    fs.renameSync(tmp, ARTIST_CACHE_PATH);
    return true;
  } catch {
    return false;
  }
}

/** 缓存里已经记住多少个名字（诊断/自检用）。 */
export function artistCacheSize() {
  return Object.keys(readArtistCache()).length;
}

/**
 * pixiv 请求头。cookie 只发给 pixiv 自己的域名 —— 镜像站是第三方，把登录凭证发过去等于泄露账号。
 * 2026-09-20 加固：非 pixiv 主机上，调用方塞进来的 cookie / authorization 也会被摘掉：
 *   以前只有"本函数自己不加"这一层，万一哪天上面多传个头（比如 Bearer），镜像站就白拿一个凭证。
 * @param {string} url 目标地址
 */
export function pixivRequestHeaders(url, extra = {}) {
  const isPixiv = isPixivHost(url);
  const ck = isPixiv ? pixivCookie() : '';
  const out = {
    'user-agent': UA,
    accept: 'application/json,text/plain,*/*',
    referer: PIXIV_REFERER,
    ...(ck ? { cookie: ck } : {}),
    ...extra,
  };
  if (!isPixiv) {
    for (const k of Object.keys(out)) if (/^(cookie|authorization)$/i.test(k)) delete out[k];
  }
  return out;
}

/**
 * app-api（官方 App 接口）的请求头：Bearer 换 cookie。
 * 为什么这里不带 cookie：app-api 认 Bearer；cookie 那套只对 www.pixiv.net 的 ajax 有用，
 * 少带一处凭证就少一处泄露面（2026-09-20）。
 */
function pixivAppApiHeaders(token) {
  return { ...pixivAppHeaders(), authorization: `Bearer ${token}` };
}

/**
 * 登录态自检：拿一个"匿名时被抹掉原图地址"的作品当试纸。
 *
 * 依据（实测）：作品 80643572 匿名请求 `ajax/illust/{id}` 时 `urls` 整组为 null（sl=4），
 * 而 149807268（sl=2）匿名也带 urls。所以"试纸作品 80643572 的 urls.original 非空"
 * 就能证明 cookie 真的生效了 —— 比"看有没有配 cookie"可靠得多（cookie 会过期）。
 * @returns {Promise<{configured:boolean, loggedIn:boolean, probeId:string, evidence:string}>}
 */
export async function pixivLoginState(probeId = '80643572') {
  const configured = pixivLoggedIn();
  if (!configured) {
    return { configured: false, loggedIn: false, probeId: String(probeId), evidence: '没配 pixiv.cookie（config.json 的 pixiv.cookie 或环境变量 QQBRIDGE_PIXIV_COOKIE）' };
  }
  try {
    const r = await fetchPixivJson(`${PIXIV_AJAX}/illust/${probeId}?lang=zh`);
    const url = String(r.json?.body?.urls?.original ?? '').trim();
    return {
      configured: true,
      loggedIn: Boolean(url),
      probeId: String(probeId),
      evidence: url ? `试纸作品 ${probeId} 拿到了原图地址（登录态生效）` : `试纸作品 ${probeId} 的 urls.original 仍是 null（cookie 无效/已过期）`,
    };
  } catch (e) {
    return { configured: true, loggedIn: false, probeId: String(probeId), evidence: `自检请求失败：${e?.message ?? e}` };
  }
}

/** 归一化名字用于比对：去掉空白与全角空格、转小写（'米山舞 ！！' 与 '米山舞！！' 视为同名）。 */
export function normalizeArtistName(s) {
  return String(s ?? '').replace(/[\s\u3000]+/g, '').toLowerCase();
}

/**
 * 纯函数：解析"用户搜索"的返回体（形状已实测，见下）。
 * 实测返回（`/ajax/search/users?nick=米山舞&s_mode=s_usr&p=1&i=0`，HTTP 200）：
 *   body 有 data/page/tagTranslation/thumbnails/users/zoneConfig 等键，其中
 *   `users[] = { userId, name, comment, image, imageBig, premium, partial, isFollowed, isMypixiv, isBlocking, background, commission }`
 *   —— 没有作品数（要另外补，见 enrichArtistWorks），`comment` 是签名（消歧很有用）。
 * 2026-09-20 扩展：还要吃 app-api `/v1/search/user` 的 `user_previews[]`：那里用户包在 `user` 字段里
 *   （`{user:{id,name,account,profile_image_urls,is_premium}, illusts:[…该用户的公开作品预览], novels:[…]}`），
 *   所以 `illusts` 是数组 —— 数组长度当作品数用（`partial` 只代表"这个预览不全"）。
 * 仍做宽容解析（认 body.users / body.user_previews / body.list / body.data / 裸数组；认 userId|id、name|userName、illusts|works）。
 * @returns {{id:string,name:string,comment:string,works:number,partial:number,premium:boolean,pageUrl:string,avatar:string}[]}
 */
export function parsePixivUserSearch(json) {
  const b = json?.body ?? json;
  const arr = Array.isArray(b?.users) ? b.users
    : Array.isArray(b?.user_previews) ? b.user_previews
      : Array.isArray(b?.list) ? b.list
        : Array.isArray(b?.data) ? b.data
          : Array.isArray(b) ? b : [];
  return arr.map((raw) => {
    const u = raw?.user ?? raw;      // app-api 的 user_previews[i].user
    const id = String(u?.userId ?? u?.id ?? '').trim();
    const works = raw?.illusts ?? u?.illusts;
    const w = Number(Array.isArray(works) ? works.length : works ?? u?.works ?? u?.illustCount ?? u?.illust_count);
    return {
      id,
      name: String(u?.userName ?? u?.name ?? '').trim(),
      comment: String(u?.comment ?? '').replace(/\s+/g, ' ').trim().slice(0, 60),
      works: Number.isFinite(w) ? w : 0,
      worksKnown: Number.isFinite(w),
      partial: Number(u?.partial ?? (raw?.illusts ? 1 : 0)) || 0,
      premium: Boolean(u?.premium ?? u?.is_premium),
      pageUrl: /^\d+$/.test(id) ? `https://www.pixiv.net/users/${id}` : '',
      avatar: String(
        u?.image ?? u?.profileImageUrl ?? u?.imageBig ?? u?.profile_image_url
        ?? u?.profile_image_urls?.medium ?? u?.profile_image_urls?.px_170x170 ?? '',
      ).trim(),
    };
  }).filter((u) => u.id);
}

/**
 * 纯函数：从**搜索结果**里挑出「pixiv 画师主页」命中（第 ④ 条来源用的，见下方那段说明）。
 *
 * 输入就是桥自己搜索内核的形状：`[{ title, url, snippet }, …]`（`searchAll()` 返回的 `results`）。
 * 名字从哪来：pixiv **用户页**的标题就是「<昵称> - pixiv」（实测），所以剥掉尾巴当名字；
 * 剥完还像作品页/标签页的一律**不给名字**（空串）—— 宁可候选里显示"(无名字)"，也不拿假名字去参与定号。
 * 去重按 id（同一个号常命中多次，比如 `/users/1554775` 与 `/users/1554775/artworks`），保持首次出现顺序
 * （搜索引擎的排序就是可信度）。
 * @returns {{id:string,name:string,url:string,snippet:string,title:string}[]}
 */
export function parseSearchUserHits(items) {
  const list = Array.isArray(items) ? items : [];
  const out = [];
  const seen = new Set();
  for (const it of list) {
    const url = String(it?.url ?? '').trim();
    const m = /pixiv\.net\/(?:en\/)?users\/(\d{1,12})(?:[/?#]|$)/i.exec(url);
    if (!m) continue;                       // 作品页 / 标签页 / 别的站：一概不要
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: searchHitName(it?.title),
      url: `https://www.pixiv.net/users/${id}`,
      snippet: String(it?.snippet ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
      title: String(it?.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
    });
  }
  return out;
}

/** 纯函数：从搜索结果标题里剥画师名（剥不出来给空串，理由见上）。 */
export function searchHitName(title) {
  let t = String(title ?? '').replace(/\s+/g, ' ').trim();
  t = t.replace(/\s*[-–—|｜]\s*pixiv\s*$/i, '').trim();      // 「米山舞 - pixiv」→「米山舞」
  if (!t || t.length > 40) return '';
  if (/[#＃]/.test(t)) return '';                             // 「#米山舞 - …」是标签页
  if (/(のイラスト|のマンガ|の作品|の小説|illustrations|artworks|作品一覧)/i.test(t)) return '';
  return t;
}

/**
 * 把"按画师名搜"的返回体排序/挑选（纯函数，离线可测）。
 *
 * 排序：名字完全相等 → 作品数多 → 其余。作品数是"这个号是不是活跃画师"的唯一可用信号（要另外补）。
 *
 * 什么时候才敢直接定号（unique）：恰好有一个同名号名下真有作品（works>0），并且
 *   · 其它同名号都是 0 作品（实测：搜「米山舞」会带出 7 个 0 作品的同名/近似小号），且
 *   · 所有近似号（"米山舞です"这种）的作品数都没有超过它。
 * 为什么不用"作品数最多"来定号：实测搜「ちーのすけ」会出 3 个完全同名的活跃画师（20 / 49 / 82 件），
 * 而要找的那个是 20 件的那位 —— "作品最多"会把号认错。这种情况下只能列候选让人挑：
 * 发错人比不发出去更糟。
 * @returns {{exact:object[], partial:object[], others:object[], candidates:object[], unique:object|null}}
 */
export function rankArtistCandidates(users, name) {
  const want = normalizeArtistName(name);
  const list = Array.isArray(users) ? users.slice() : [];
  const exact = list.filter((u) => normalizeArtistName(u.name) === want);
  const partial = list.filter((u) => {
    const n = normalizeArtistName(u.name);
    return n !== want && (n.includes(want) || want.includes(n));
  });
  const others = list.filter((u) => !exact.includes(u) && !partial.includes(u));
  const byWorks = (a, b) => (b.works || 0) - (a.works || 0);
  const candidates = [...exact.slice().sort(byWorks), ...partial.slice().sort(byWorks), ...others];
  const withWorks = exact.filter((u) => (u.works || 0) > 0);
  const maxOf = (arr) => arr.reduce((m, u) => Math.max(m, u.works || 0), 0);
  let unique = null;
  if (withWorks.length === 1) {
    const cand = withWorks[0];
    const otherExactWorks = maxOf(exact.filter((u) => u !== cand));
    if (otherExactWorks === 0 && maxOf(partial) < (cand.works || 0)) unique = cand;
  }
  return { exact, partial, others, candidates, unique };
}

/** GET 一个 pixiv/mirror 的 JSON 端点。**不抛 HTTP 状态错**（404 的 JSON 体也要能读到，才能给准话）。
 *  第三个参数用于 app-api：那一路要 Bearer 头（auth 头只在这里显式传，绝不下发给镜像站）。 */
async function fetchPixivJson(url, timeoutMs = PIXIV_DIRECT_TIMEOUT_MS, headers = null) {
  const res = await fetch(url, {
    headers: headers ?? pixivRequestHeaders(url),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

/** 把 pixiv ajax（或镜像站同形状）的 body 归一成本模块对外的作品形状。**纯函数，离线可测**。 */
export function normalizePixivIllustDetail(body, source = 'pixiv') {
  const b = body ?? {};
  const id = String(b.id ?? b.illustId ?? '').trim();
  const tagList = Array.isArray(b.tags?.tags) ? b.tags.tags
    : Array.isArray(b.tags) ? b.tags : [];
  const tags = tagList.map((t) => String(t?.tag ?? t ?? '').trim()).filter(Boolean);
  const out = {
    id,
    title: String(b.title ?? b.illustTitle ?? '').trim(),
    author: String(b.userName ?? '').trim(),
    authorId: String(b.userId ?? '').trim(),
    tags,
    description: String(b.description ?? b.illustComment ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
    pageCount: Math.max(1, Number(b.pageCount) || 1),
    width: Number(b.width) || 0,
    height: Number(b.height) || 0,
    illustType: Number(b.illustType) || 0,
    xRestrict: b.xRestrict,
    aiType: Number(b.aiType) || 0,
    createDate: String(b.createDate ?? ''),
    pageUrl: pixivPageUrl(id),
    thumbUrl: String(b.urls?.thumb ?? '').trim(),
    urls: {
      original: String(b.urls?.original ?? '').trim(),
      regular: String(b.urls?.regular ?? '').trim(),
      thumb: String(b.urls?.thumb ?? '').trim(),
    },
    // 逐页原图直链（app-api 的 meta_pages 归一化后就挂在这里）——pixivIllustOriginals 的首选来源，
    // 有它就不用再问一次 pages 接口。别的来源给不出，就是空数组。
    metaPages: (Array.isArray(b.metaPages) ? b.metaPages : []).map((u) => String(u ?? '').trim()).filter(Boolean),
    source,
  };
  // fail-closed：xRestrict 缺失/非 0 都当 R-18（与搜索路径的 isAdult 同一口径）
  out.adult = isAdult({ xRestrict: out.xRestrict, tags });
  out.origin = 'detail';
  return out;
}

/**
 * 按作品号取详情（元数据 + 可能的原图地址）。
 * 顺序（2026-09-20 定"官方优先"）：app-api `/v1/illust/detail`（Bearer）→
 * pixiv web ajax `ajax/illust/<id>` → 镜像站 detail.php。三个都失败才抛错，并把三家各自的原话都带上。
 */
export async function pixivIllustDetail(id) {
  const pid = String(id ?? '').trim();
  if (!/^\d{1,12}$/.test(pid)) throw new Error(`Pixiv 作品号不合法：「${String(id ?? '')}」（应为纯数字，例如 80643572）`);
  const tried = [];

  // ① app-api：形状是 snake_case，先翻译成 web ajax 形状再走同一个归一化函数
  const token = await getPixivAccessToken();
  if (token) {
    try {
      const r = await fetchPixivJson(`${PIXIV_APP_API}/illust/detail?illust_id=${pid}&lang=zh`, PIXIV_DIRECT_TIMEOUT_MS, pixivAppApiHeaders(token));
      const it = r.json?.illust;
      if (r.json?.error || !it?.id) throw new Error(`HTTP ${r.status}${httpHint(r.json)}`);
      return withTried(normalizePixivIllustDetail(appApiIllustToWebBody(it), 'app-api'), tried);
    } catch (e) {
      tried.push(`app-api: ${e?.message ?? e}`);
    }
  } else tried.push(`app-api: ${NO_TOKEN_MSG}`);

  // ② pixiv web ajax（匿名可用；配了 cookie 时带上 cookie，结果一样但不算"登录态必需"）
  const attempts = [
    ['web-ajax', `${PIXIV_AJAX}/illust/${pid}?lang=zh`],
    ['mirror', `${pixivBase()}/api/detail.php?id=${pid}`],
  ];
  for (const [source, url] of attempts) {
    try {
      const r = await fetchPixivJson(url, source === 'mirror' ? TIMEOUT_MS + 10000 : PIXIV_DIRECT_TIMEOUT_MS);
      const body = r.json?.body;
      if (r.json?.error || !body || !String(body.id ?? body.illustId ?? '').trim()) {
        throw new Error(`HTTP ${r.status}${r.json?.error ? '（官网说没这个作品或不让看）' : ''}`);
      }
      return withTried(normalizePixivIllustDetail(body, source), tried);
    } catch (e) {
      tried.push(`${source}: ${e?.message ?? e}`);
    }
  }
  throw new Error(`取 Pixiv 作品 ${pid} 失败 —— ${tried.join('；')}。请核对作品号，或换成关键词搜索（query）。`);
}

/** 把"试过哪些来源"挂到详情对象上（给工具层/模型看的一句话，别再多一层结构）。 */
function withTried(detail, tried) {
  return { ...detail, note: tried.length ? tried.join('；') : '' };
}

/** 由 p0 原图直链推出同一作品每一页的原图直链。**纯函数，离线可测**（pages 接口失败时的兜底）。 */
export function deriveOriginalPageUrls(p0, pageCount) {
  const s = String(p0 ?? '').trim();
  const m = /^(.*_p)(\d+)(\.[A-Za-z0-9]+)$/.exec(s);
  if (!m) return [];
  const n = Math.max(1, Number(pageCount) || 1);
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(`${m[1]}${i}${m[3]}`);
  return out;
}

/** 原图直链 → master1200 直链。**纯函数，离线可测**。
 *  实测：master 一律是 .jpg（png 原图的作品，`..._p0_master1200.png` 是 404，`.jpg` 才是 200/740KB）。 */
export function pixivMasterUrl(originalUrl) {
  return String(originalUrl ?? '').trim()
    .replace('/img-original/img/', '/img-master/img/')
    .replace(/\.[A-Za-z0-9]+$/, '_master1200.jpg');
}

/**
 * 取一个作品的逐页原图直链。
 * 顺序（2026-09-20 定"官方优先"，且"按作品/画师发送时优先 app-api 的 meta_pages"）：
 * ① app-api `/v1/illust/detail` 的 `meta_pages[].image_urls.original`（最准：逐页给真原图，不用猜扩展名）；
 *    详情本身就是 app-api 取的、已经带着 metaPages 时直接复用，不再多发一次请求；
 * ② 官网 `ajax/illust/{id}/pages`（匿名可用，实测 100~400ms，逐页给 urls.original）；
 * ③ 镜像站 detail.php 的 urls.original（或它的 meta_pages）→ 用 `deriveOriginalPageUrls` 推页；
 * 都没成时再用详情里的 urls.original 推（老的 'derived' 兜底，行为不变）。
 * @returns {Promise<{urls:string[], source:string, note:string}>}
 */
export async function pixivIllustOriginals(detail) {
  const id = String(detail?.id ?? '').trim();
  const pageCount = Math.max(1, Number(detail?.pageCount) || 1);
  const tried = [];
  const noteOf = (extra = '') => [...tried, extra].filter(Boolean).join('；');

  // ① 详情里已经有 meta_pages（app-api 那条路）→ 直接就是答案
  const meta = Array.isArray(detail?.metaPages) ? detail.metaPages.filter(Boolean) : [];
  if (meta.length) return { urls: meta, source: 'app-api:meta_pages', note: '' };

  if (id) {
    const token = await getPixivAccessToken();
    if (token) {
      try {
        const r = await fetchPixivJson(`${PIXIV_APP_API}/illust/detail?illust_id=${id}&lang=zh`, PIXIV_DIRECT_TIMEOUT_MS, pixivAppApiHeaders(token));
        const pages = (Array.isArray(r.json?.illust?.meta_pages) ? r.json.illust.meta_pages : [])
          .map((p) => String(p?.image_urls?.original ?? '').trim()).filter(Boolean);
        if (pages.length) return { urls: pages, source: 'app-api:meta_pages', note: noteOf() };
        tried.push(`app-api: HTTP ${r.status} 没给 meta_pages`);
      } catch (e) {
        tried.push(`app-api: ${e?.message ?? e}`);
      }
    } else tried.push(`app-api: ${NO_TOKEN_MSG}`);

    // ② 官网 pages
    try {
      const r = await fetchPixivJson(`${PIXIV_AJAX}/illust/${id}/pages?lang=zh`);
      const arr = r.json?.body;
      if (Array.isArray(arr)) {
        const urls = arr.map((p) => String(p?.urls?.original ?? '').trim()).filter(Boolean);
        if (urls.length) return { urls, source: 'pixiv:pages', note: noteOf() };
        tried.push(`pixiv pages 没给原图地址（HTTP ${r.status}）`);
      } else {
        tried.push(`pixiv pages 返回了非预期形状（HTTP ${r.status}）`);
      }
    } catch (e) {
      tried.push(`pixiv pages 失败：${e?.message ?? e}`);
    }

    // ③ 镜像站兜底（它自己的登录态换来的同一份 ajax 响应；慢，只此一次）
    try {
      const r = await fetchPixivJson(`${pixivBase()}/api/detail.php?id=${id}`, TIMEOUT_MS + 10000);
      const b = r.json?.body ?? {};
      const urls = (Array.isArray(b.meta_pages) ? b.meta_pages : [])
        .map((p) => String(p?.image_urls?.original ?? '').trim()).filter(Boolean);
      const derived = urls.length ? urls : deriveOriginalPageUrls(String(b.urls?.original ?? '').trim(), pageCount);
      if (derived.length) return { urls: derived, source: 'mirror', note: noteOf() };
      tried.push(`mirror: HTTP ${r.status} 没给原图地址`);
    } catch (e) {
      tried.push(`mirror: ${e?.message ?? e}`);
    }
  }

  // ④ 老兜底：详情里的 p0 原图直链推同作品其它页（来源标注沿用 'derived'，下游自测认这个值）
  const p0 = String(detail?.urls?.original ?? '').trim();
  if (p0) {
    const derived = deriveOriginalPageUrls(p0, pageCount);
    if (derived.length) return { urls: derived, source: 'derived', note: noteOf() };
  }
  return { urls: [], source: '', note: noteOf('拿不到原图地址') };
}

/**
 * 取一个画师（userId）的公开作品号列表，新→旧。
 *
 * 为什么需要它：关键词搜索搜的是"标签/标题里出现这个词的作品"，所以搜「米山舞」搜到的是别人画的、
 * 打了她名字标签的图，找不到她本人的作品（2026-09-18 报的正是这件事）。
 * 找"某人本人的作品"必须走 user 接口：`ajax/user/{uid}/profile/all` 的 `body.illusts` 是 `{id: null}` 表。
 * 实测：uid=26249081 → 29 条；uid=52021072 → 20 条；uid=533797 → 0 条（该号叫 "Kana"，本来就没作品）。
 * pixiv 作品号全局递增，所以按号倒序 = 按投稿时间新→旧（这里没有 createDate 可用，只能这么排）。
 *
 * 顺序（2026-09-20）：app-api `/v1/user/illusts`（Bearer，每页 30 件、跟 next_url 往后翻，上限 10 页）
 *   → 官网 `profile/all`（一次给全，原来的唯一实现）→ 镜像站 native.php 代拉同一个 profile/all。
 * app-api 若返回 0 件，不当作结论，继续往下试：app-api 那个 type=illust 可能不含某些投稿类型，
 *    而 profile/all 是"这个人一共投了什么"的权威答案，兜底一遍成本很低。
 * @returns {Promise<{userId:string, ids:string[], source:string, note:string}>}
 */
export async function pixivUserWorkIds(userId) {
  const uid = String(userId ?? '').trim();
  if (!/^\d{1,12}$/.test(uid)) throw new Error(`画师号不合法：「${String(userId ?? '')}」（应为纯数字，例如 26249081）`);
  const tried = [];
  const sortDesc = (raw) => [...new Set(raw.filter((x) => /^\d+$/.test(String(x))).map(String))]
    .sort((a, b) => Number(b) - Number(a));

  // ① app-api：每页 30 件，跟 next_url 往后翻
  const token = await getPixivAccessToken();
  if (token) {
    try {
      const ids = [];
      for (let i = 0; i < PIXIV_USER_WORKS_MAX_PAGES; i += 1) {
        const q = new URLSearchParams({ user_id: uid, type: 'illust', filter: 'for_android', offset: String(i * PIXIV_APP_PAGE_SIZE), lang: 'zh' });
        const r = await fetchPixivJson(`${PIXIV_APP_API}/user/illusts?${q.toString()}`, PIXIV_DIRECT_TIMEOUT_MS, pixivAppApiHeaders(token));
        const arr = r.json?.illusts;
        if (r.json?.error || !Array.isArray(arr)) throw new Error(`HTTP ${r.status}${httpHint(r.json)}`);
        ids.push(...arr.map((x) => String(x?.id ?? '')).filter(Boolean));
        if (!r.json?.next_url || arr.length < PIXIV_APP_PAGE_SIZE) break;
      }
      if (ids.length) return { userId: uid, ids: sortDesc(ids), source: 'app-api', note: tried.join('；') };
      tried.push('app-api: 0 件（继续用 profile/all 核实）');
    } catch (e) {
      tried.push(`app-api: ${e?.message ?? e}`);
    }
  } else tried.push(`app-api: ${NO_TOKEN_MSG}`);

  // ② 官网 profile/all（原来的唯一实现，一次给全，也包含漫画）
  try {
    const r = await fetchPixivJson(`${PIXIV_AJAX}/user/${uid}/profile/all?lang=zh`);
    const b = r.json?.body;
    if (r.json?.error || !b) throw new Error(`HTTP ${r.status}${httpHint(r.json)}`);
    const ids = sortDesc([...Object.keys(b.illusts ?? {}), ...Object.keys(b.manga ?? {})]);
    return { userId: uid, ids, source: 'web-ajax', note: tried.join('；') };
  } catch (e) {
    tried.push(`web-ajax: ${e?.message ?? e}`);
  }

  // ③ 镜像站：native.php 代拉同一个 profile/all（形状不一定稳，能认就认）
  try {
    const target = `https://www.pixiv.net/ajax/user/${uid}/profile/all?lang=zh`;
    const url = `${pixivBase()}/api/native.php?url=${encodeURIComponent(target)}`;
    const r = await fetchPixivJson(url, TIMEOUT_MS + 10000);
    const b = r.json?.body ?? r.json;
    const ids = sortDesc([...Object.keys(b?.illusts ?? {}), ...Object.keys(b?.manga ?? {})]);
    if (ids.length) return { userId: uid, ids, source: 'mirror', note: tried.join('；') };
    tried.push(`mirror: HTTP ${r.status} 没给作品表`);
  } catch (e) {
    tried.push(`mirror: ${e?.message ?? e}`);
  }
  throw new Error(`取画师 ${uid} 的作品列表失败（${tried.join('；')}）`);
}

/** 供工具层用的 R-18 判定（与搜索路径同一个函数，避免两处规则漂移）。 */
export function isAdultWork(item) {
  return isAdult(item);
}

/**
 * 拼出"这张图的字节从哪几个地址能拿到"，按可靠性排序（工具层逐个试）。
 *
 * 每条是 `{url, referer?, tier}`：带 referer 的走直联（要传给 safeFetchBuffer 的第三个参数），
 * 不带的走镜像站代理。直联在前是因为实测它快一个数量级（60~400ms vs 2.7~5.7s）且字节完全一致；
 * 镜像代理想吐超时时直联早就成功了。
 * 最后仍会追加 `pixivImageCandidates` 的老候选（从缩略图推的日期路径），保证"搜索路径"行为不变。
 *
 * `tier`（2026-09-21 补）是如实标注每条候选属于哪一档（见 pixivImageTier）：老候选里既有原图猜测、
 *   也有 `_master1200` 和 250×250 的 `_square1200` 缩略图，而 `upstream` 还可能是上游给的 720 档地址。
 *   以前这三类混在一个数组里且没有任何标注，调用方（qq_send_pixiv）逐个试、谁先成功就发谁，
 *   于是"默认原图"实际上经常发的是 720/1200/缩略档，结果里却写着 lossless:true（现场见文件头）。
 *   现在标注齐全，发什么档由 `planPixivSend` 按 tier 决定，降级必须显式。
 *
 * @param {object} work 作品对象（搜索结果或 `pixivIllustDetail` 的结果）
 * @param {{page?:number, size?:'master'|'original', originals?:string[]}} opts
 * @returns {{url:string, referer?:string, tier:string, fallback?:boolean, fallbackReason?:string}[]}
 */
export function pixivImageSources(work, opts = {}) {
  const page = Math.max(0, Number(opts.page) || 0);
  const size = String(opts.size ?? 'master').toLowerCase() === 'original' ? 'original' : 'master';
  const out = [];
  const push = (url, referer) => {
    const u = String(url ?? '').trim();
    if (!u || out.some((x) => x.url === u)) return;
    const tier = pixivImageTier(u);
    // size=original 时，非原图档（上游给的 720/1200 档、老候选里的 master/缩略图）一律标成"降级候选"：
    // 调用方只允许在真原图档全失败之后才用它们，并且必须把降级写进日志与结果。
    // `unknown`（认不出的第三方形状）不标 —— 不按档位拦，但要靠像素对账把关（见 pixivTierSizeVerdict）。
    const downgraded = size === 'original' && (tier === 'master' || tier === 'thumb');
    out.push({
      ...(referer ? { url: u, referer } : { url: u }),
      tier,
      ...(downgraded
        ? { fallback: true, fallbackReason: tier === 'thumb' ? '缩略档，不是能当原图发的档位' : `上游/老候选给的地址其实是 ${tier} 档，不是原图档` }
        : {}),
    });
  };
  const originals = Array.isArray(opts.originals) ? opts.originals.map((u) => String(u ?? '').trim()).filter(Boolean) : [];
  const upstream = originals.length ? originals[Math.min(page, originals.length - 1)] : String(work?.urls?.original ?? '').trim();
  if (upstream) {
    const target = size === 'original' ? upstream : (String(work?.urls?.regular ?? '').trim() && page === 0
      ? String(work.urls.regular).trim()
      : pixivMasterUrl(upstream));
    push(target, PIXIV_REFERER);   // ① 直联 i.pximg（带 Referer）
    /* ② 镜像站代理兜底（同字节，但慢）。2026-09-28：从"一条 API 式代理"改成"多条 host 重写式镜像"
     * （顺序 = 实测可靠性，见本文件上方那段）：镜像候选都**不带 referer** —— 这是必须的，
     * pximg.cocomi.eu.org 带 Referer 会 403。 */
    for (const one of pixivProxyUrls(target)) push(one);
  }
  // ③ 老候选：从缩略图推日期路径（搜索路径一直用这套，保持行为不变）
  for (const u of pixivImageCandidates(work, { page, size })) push(u);
  return out;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * 2026-09-19 新增：按画师名字找号（要登录 cookie；见本文件上方 cookie 段）
 *
 * 调用方给的"画师"入参可能是三种东西，这里统一收口：
 *   · 画师号 / pixiv.net/users/<数字> 链接 → 直接用；
 *   · 画师名（不含数字）→ 走登录态的用户搜索；
 *   · 什么都没给 → none。
 * 名字搜出来不保证唯一（同名号在 pixiv 上很常见），所以：
 *   · 只有一个名字完全相等、且没有包含关系的候选 → 敢直接定（unique）；
 *   · 否则返回候选列表让用户挑，绝不瞎猜一个发出去 —— 发错人比不发更糟。
 *   （**桥自己的** web 搜索引擎那条路实测不可靠：这台 VPS 上 bing 候选恒 0、duckduckgo 时好时坏 202，
 *    且"七菜"这种常见名会捞出 3 个同名号而真号不在前列；所以只做候选，不做自动定号。
 *    2026-09-27 补：桥自己的多平台搜索修好之后（见 CHANGELOG 该日实测数字）这条路可用了，见下面 ④ 段。）
 * ══════════════════════════════════════════════════════════════════════════════════════════ */

/* ── 第 ④ 条来源：桥自己的搜索引擎（2026-09-27）─────────────────────────────────────────
 * 为什么加：官方两条路（app-api 的 Bearer / 官网 cookie）**都要登录态**，而线上服务器现在一个令牌
 * 都没有 —— 实测 `node tools/pixiv-login.mjs --status` → 「长期令牌 refresh_token：没有」「access_token：
 * 没有」，于是"按名字找号"整个不可用，而"能在国外服务器上查到作者的 pixiv 账号 id"正是要这条。
 * 桥自己的多平台搜索实测能直接从搜索结果里拿到画师主页：
 *   `site:pixiv.net/users 米山舞` → https://www.pixiv.net/users/1554775（标题「米山舞 - pixiv」，约 1.5 s）
 * 所以加第 ④ 条，**只在 ①②③ 全失败时才走**（有登录态时官方接口仍是唯一权威）：
 *   · 直接调 `lib/web-search.js` 的 `searchAll()`（同一份平台表与相关度判据，不 spawn 子进程）；
 *   · 平台只用能查 `site:` 的那几个（见 PIXIV_NAME_SEARCH_PLATFORMS），**不花任何第三方账号额度**
 *     —— 唯一有计量的是免密钥 firecrawl 通道（按出口 IP 计，没有 key、没有月配额）；
 *   · 第一条查询命中就不再发第二条（省一次出站请求与一次相关度计算）；
 *   · **只产候选、不做自动定号** —— 名字是从搜索结果标题剥出来的、也给不出作品数，
 *     "只有一个同名号且名下有作品 = 敢定号"那套依据在这里不成立（见 shapeAuthorResolution）。
 * ══════════════════════════════════════════════════════════════════════════════════════════ */

/** 纯函数：认调用方给的"画师"入参。 */
export function parseAuthorInput(input) {
  const s = String(input ?? '').trim();
  if (!s) return { kind: 'none' };
  const link = /pixiv\.net\/(?:en\/)?users\/(\d{1,12})/i.exec(s);
  if (link) return { kind: 'id', id: link[1], from: 'link' };
  if (/^\d{1,12}$/.test(s)) return { kind: 'id', id: s, from: 'number' };
  return { kind: 'name', name: s };
}

/** 纯函数：用户搜索的地址。**参数是 `nick` 不是 `word`**（见 pixivUserSearchUrl 的注释）。 */
export function pixivUserSearchUrl(nick, page = 1, onlyCreator = false) {
  const q = new URLSearchParams({
    nick: String(nick ?? '').trim(),
    s_mode: 's_usr',
    p: String(Math.max(1, Number(page) || 1)),
    i: onlyCreator ? '1' : '0',
  });
  return `${PIXIV_AJAX}/search/users?${q.toString()}`;
}

/**
 * 给候选补"公开作品数"（搜索返回体里没有，但它是"这个号是不是活跃画师"的唯一可用信号）。
 * 只补前 limit 个、每个一次 `ajax/user/{id}/profile/all`、全部 best-effort（失败就当 0，不抛）。
 * 实测成本：8 个号约 750~880ms。
 */
async function enrichArtistWorks(users, limit = 8) {
  const slice = users.slice(0, limit);
  await Promise.allSettled(slice.map(async (u) => {
    try {
      const r = await fetchPixivJson(`${PIXIV_AJAX}/user/${u.id}/profile/all?lang=zh`, 12000);
      const b = r.json?.body;
      if (!b) return;
      u.works = Object.keys(b.illusts ?? {}).length + Object.keys(b.manga ?? {}).length;
      u.worksKnown = true;
    } catch { /* 补不上就当未知，不影响主流程 */ }
  }));
  return users;
}

/* ── 第 ④ 条的实现：直接调桥自己的搜索内核（只读搜索，不改任何东西）────────────────────── */

/** ④ 用哪几个平台：只要能认 `site:` 的通用检索源。firecrawl 是本项目在机房 IP 上唯一稳定的那条
 *  （见 lib/web-search.js 的平台表与 CHANGELOG 2026-09-27 的实测数字），其余按"可能给结果"带上 ——
 *  它们失败或超时都不会拖慢整体：`searchAll` 的核心集一旦有结论就立刻返回（firecrawl 在核心集里）。 */
export const PIXIV_NAME_SEARCH_PLATFORMS = ['firecrawl', 'bing', 'duckduckgo', 'baidu', 'sogou', 'so360'];

/** ④ 桥自己的搜索引擎：从搜索结果里找画师主页，归一成和官方同一个形状（见 parsePixivUserSearch）。
 *  两条查询，第一条命中就不再发第二条；归一化借同一个函数，所以 pageUrl/字段名与官方一致，
 *  而 `works` 一律 unknown（worksKnown=false，候选里会显示"作品数未知"，补查成功才有数）。 */
async function pixivSearchUsersByOwnSearch(name) {
  const tried = [];
  for (const q of [`site:pixiv.net/users ${name}`, `${name} pixiv`]) {
    let r = null;
    try {
      r = await searchAll(q, { maxResults: 12, platforms: PIXIV_NAME_SEARCH_PLATFORMS });
    } catch (e) {
      tried.push(`「${q}」搜索失败：${e?.message ?? e}`);
      continue;
    }
    const hits = parseSearchUserHits(r?.results);
    if (!hits.length) {
      const bad = Object.keys(r?.failures ?? {});
      tried.push(`「${q}」没有画师主页命中${bad.length ? `（平台报错：${bad.map((k) => `${k}:${r.failures[k]}`).join('、')}）` : ''}`);
      continue;
    }
    const users = parsePixivUserSearch({ body: { users: hits.map((h) => ({ userId: h.id, userName: h.name, comment: h.snippet })) } });
    await enrichArtistWorks(users);            // 匿名补得上就补（best-effort，失败不影响主流程）
    return { endpoint: 'web-search', users, query: q, hits };
  }
  throw new Error(`桥自己的搜索引擎搜了两轮都没有画师主页命中：${tried.join('；')}`);
}

/**
 * 按名字搜画师（官方两条路都要登录态；都没有时退到桥自己的搜索引擎，见下面 ④）。
 *
 * 路由是怎么找到的（留证，免得下次又从头试）：`/ajax/search/users` 这条路由一直都在，
 * 之前一直 400「不正确的请求」是因为参数名给错了 —— 它要的是 `nick`，不是 `word`。
 * 证据：pixiv 用户搜索页自己的 chunk `s.pximg.net/soy/pixiv-web-next/.../chunks/users-*.js` 里写着
 *   `e.get("/ajax/search/users", {}, { nick: t.nick, s_mode: t.sMode, p: t.page, i: t.onlyCreator ? "1" : "0" })`
 * 实测（带 cookie）：`nick=米山舞` → 1 条命中 `1554775:米山舞`；`nick=七菜` → 10 条同名候选；
 * `nick=<纯数字>`、`nick=自己的英文 ID` → 0 条（它只按昵称搜，不按号、不按 @ID）。
 * 匿名（不带 cookie）时同一条请求是 400「不正しいリクエストです。」/「不正确的请求。」
 * —— 这正是「按名字搜画师」过去要靠手贴 cookie 的原因，也是本次做 OAuth 长期令牌的动机。
 *
 * 顺序（2026-09-20 要求的"官方优先"，也是"能一直用"的关键）：
 *   ① app-api `/v1/search/user?word=`（Bearer，见 lib/pixiv-auth.js —— 长期令牌自动轮换，不再依赖 cookie）；
 *   ② 官网 `ajax/search/users?nick=`（cookie；就是原来的唯一实现，保留当兜底）；
 *   ③ 镜像站 native.php 代拉同一个地址（实测它自己没有用户搜索路由，能认就认）；
 *   ④ 桥自己的多平台搜索（`lib/web-search.js`）—— **只在 ①②③ 全失败时**才走，且只产候选（见 shapeAuthorResolution）。
 *
 * @returns {Promise<{query:string, endpoint:string, users:object[], source:string, cached?:boolean, cachedAt?:number}>}
 */
export async function pixivSearchUsersByName(name) {
  const w = String(name ?? '').trim();
  if (!w) throw new Error('要搜的画师名不能为空');
  // ① 先查本地缓存：命中就完全不碰网络、也不要求登录态（令牌失效后已查过的名字照样能用）
  const cached = artistCacheGet(w);
  if (cached) return { query: w, endpoint: 'cache', users: cached.users, cached: true, cachedAt: cached.at, source: 'cache' };

  const token = await getPixivAccessToken();
  const tried = [];
  // 2026-09-27：以前这里"没登录态就直接抛错、不退化成关键词搜"。现在**不抛了** —— 多了第 ④ 条
  // （桥自己的多平台搜索），它能在没有登录态时把画师主页直接搜出来（服务器实测：米山舞 → users/1554775）。
  // 官方两条路的优先级一字未改：有登录态就先用官方，①②③ 全失败才走 ④。
  if (!token && !pixivLoggedIn()) {
    tried.push('登录态 → 没有 refresh_token/access_token 也没有 cookie（官方两条路都跳过；'
      + '想要长期可用的官方接口就跑一次 node tools/pixiv-login.mjs --cookie "PHPSESSID=…"，之后桥自己续期）');
  }

  // ① app-api（Bearer）：没有令牌就跳过，别白等一次 400
  if (token) {
    try {
      const r = await fetchPixivJson(`${PIXIV_APP_API}/search/user?word=${encodeURIComponent(w)}&filter=for_android&lang=zh`, PIXIV_DIRECT_TIMEOUT_MS, pixivAppApiHeaders(token));
      const users = parsePixivUserSearch(r.json);
      if (users.length) {
        await enrichArtistWorks(users);
        artistCacheSet(w, users);
        return { query: w, endpoint: 'app-api:/v1/search/user', users, cached: false, source: 'app-api' };
      }
      tried.push(`app-api → HTTP ${r.status} 无 users`);
    } catch (e) {
      tried.push(`app-api → ${e?.message ?? e}`);
    }
  } else tried.push(`app-api → ${NO_TOKEN_MSG}`);

  // ② 官网（cookie）；没用 cookie 就如实说跳过
  // 首选实测可用的那条；后面那条是历史形状，留着当兜底（pixiv 随时可能改）
  const ends = pixivLoggedIn()
    ? [pixivUserSearchUrl(w), `${PIXIV_AJAX}/search/users?word=${encodeURIComponent(w)}&s_mode=s_usr&lang=zh`]
    : [];
  if (!ends.length) tried.push('web-ajax → 没配 cookie（跳过）');
  for (const url of ends) {
    try {
      const r = await fetchPixivJson(url);
      const users = parsePixivUserSearch(r.json);
      if (users.length) {
        await enrichArtistWorks(users);
        artistCacheSet(w, users);   // 解开一次就记住：登录态掉了也能用（cookie 只给一次的意思）
        return { query: w, endpoint: url.replace(`${PIXIV_AJAX}/`, '/ajax/'), users, cached: false, source: 'web-ajax' };
      }
      const why = r.json?.error ? `error=${String(r.json.message ?? '').slice(0, 40)}` : '无 users 字段';
      tried.push(`${url.replace(PIXIV_AJAX, '')} → HTTP ${r.status} ${why}`);
    } catch (e) {
      tried.push(`${url.replace(PIXIV_AJAX, '')} → ${e?.message ?? e}`);
    }
  }

  // ③ 镜像站兜底（第三方，不带任何凭证）
  try {
    const target = `https://www.pixiv.net/ajax/search/users?nick=${encodeURIComponent(w)}&s_mode=s_usr&p=1&i=0`;
    const r = await fetchPixivJson(`${pixivBase()}/api/native.php?url=${encodeURIComponent(target)}`, TIMEOUT_MS + 10000);
    const users = parsePixivUserSearch(r.json);
    if (users.length) {
      await enrichArtistWorks(users);
      artistCacheSet(w, users);
      return { query: w, endpoint: 'mirror:native.php', users, cached: false, source: 'mirror' };
    }
    tried.push(`mirror → HTTP ${r.status} 无 users 字段`);
  } catch (e) {
    tried.push(`mirror → ${e?.message ?? e}`);
  }

  // ④ 桥自己的多平台搜索：没有登录态时的出路（见本文件上方那段说明）。放最后：官方接口才是权威。
  try {
    const r = await pixivSearchUsersByOwnSearch(w);
    artistCacheSet(w, r.users);            // 搜到一次就记住：下次连搜索都不用跑
    return { query: w, endpoint: r.endpoint, users: r.users, cached: false, source: 'search' };
  } catch (e) {
    tried.push(`search → ${e?.message ?? e}`);
  }

  throw new Error(`按名字搜「${w}」没拿到结果。逐条试过：${tried.join('；')}。`
    + '（官方两条路要登录态，用 tools/pixiv-login.mjs --status 看当前状态；'
    + '搜索那条要这台机器能出网（机房 IP 下 firecrawl 与维基/新闻 RSS 可用，见 CHANGELOG）。'
    + '也可以直接给画师号（如 1554775）或作品链接。）');
}

/**
 * 纯函数：把"名字 → 号"的结果收口成对外的 resolve 形状（离线可测）。
 *
 * 2026-09-27 新增一条硬规则：**source === 'search' 时一律只给候选**，哪怕恰好只命中一个同名号
 * 也不自动定号。原因：搜索那条来源的名字是从搜索结果标题剥出来的（pixiv 用户页标题是
 * 「昵称 - pixiv」），而且它给不出作品数 —— rankArtistCandidates 那套"唯一一个名下有作品 = 敢定号"
 * 的依据在这里不成立。候选里带着主页链接，念给用户认一下就行：发错画师比多发一条确认消息糟得多。
 */
export function shapeAuthorResolution({ name, ranked, endpoint, source }) {
  const candidates = ranked.candidates.slice(0, 8);
  if (source === 'search') return { kind: 'candidates', name, candidates, endpoint, source };
  if (ranked.unique) {
    return {
      kind: 'id', id: ranked.unique.id, from: 'name', name, endpoint,
      alternatives: ranked.candidates.filter((u) => u.id !== ranked.unique.id).slice(0, 5),
    };
  }
  return { kind: 'candidates', name, candidates, endpoint };
}

/**
 * 收口"画师入参" → 画师号 或 候选列表。
 * @returns {Promise<{kind:'id',id:string,from:string,name?:string,alternatives?:object[]}|{kind:'candidates',name:string,candidates:object[],endpoint:string}|{kind:'none'}>}
 */
export async function resolvePixivAuthor(input) {
  const p = parseAuthorInput(input);
  if (p.kind === 'none') return { kind: 'none' };
  if (p.kind === 'id') return { kind: 'id', id: p.id, from: p.from };
  const r = await pixivSearchUsersByName(p.name);
  return shapeAuthorResolution({
    name: p.name,
    ranked: rankArtistCandidates(r.users, p.name),
    endpoint: r.endpoint,
    source: r.source,
  });
}
