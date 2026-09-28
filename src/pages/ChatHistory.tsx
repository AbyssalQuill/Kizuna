import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import NoticeBar from '../components/NoticeBar';
import StatValue from '../components/StatValue';
import { deleteChatHistory, getChatConvs, getChatMessages, getChatStats } from '../api';
import type { ChatConv, ChatMessage, ChatScope, ChatStatsResp } from '../api';
import { initialFromCache, warmCache, writeCacheValue } from '../lib/read-cache';
import { activeScopeInfo } from '../config-cache';
import { ArrowLeft, Loader2, MessageSquare, Radio, Search, Trash2, Users } from 'lucide-react';

interface Props {
  onBack: () => void;
  /* 数据来源由连接状态决定，页面不提供"本机/服务端"开关：
   * 连上服务器就读服务器（App.tsx 传 `state.connected && state.activeServer` 的那台），
   * 没连上就读本机 —— 与桥配置页、语音页、学习页同一条规则。 */
  remote: { id: string; name: string; host: string } | null;
}

/* 两个常量的来历（都不是随手写的）：
 *   · PAGE = 50 —— 与后端契约的 limit 默认值一致。翻页只改 offset 不改 limit，
 *     免得同一次浏览里出现两种页长，分页边界也跟着漂。
 *   · DAY_MS —— 后端只接受绝对时间戳 beforeMs，不接受「天数」；天数在点击那一刻算成时间戳，
 *     慢一拍重发也不会因为时间流逝而多删几条（换算结果是一次性的、确定的）。 */
const PAGE = 50;
const DAY_MS = 86400000;

/* ── 模块级：作用域与读取缓存（2026-09-26 追加）────────────────────────────────────────
 * 「为什么提到模块级」：读取要提前 —— 进管理器空闲时、鼠标停在入口上时，就把这一页要用的两份数据
 * （会话列表、前若干会话的第一页消息）先读进缓存，点进来时已经是"有旧值"的路径（瞬时，不摆骨架）。
 * 预热函数是模块级的（不依赖组件状态），故缓存本体也必须提到模块级，两边共用同一份。
 *
 * 「作用域」与页面完全同一口径：页面用的是 App 传进来的 `remote`（= `state.connected && state.activeServer`），
 * 而那一事实在模块级只有一处可读 —— `config-cache` 的 `activeScopeInfo()`（`/api/state` 每次成功回包时登记）。
 * 连上服务器 → `remote:<serverId>`；`remote:?`（连上了但服务端身份尚未解析出来）按本机处理，
 * 与 App 此时传 `remote = null`、页面读本机完全一致。
 *
 * 「key 里带作用域」：原来消息缓存是组件内的 Map，换作用域时在 effect 里 clear() 一次即可；
 * 提到模块级后没有"换库"这个时机可利用，故把作用域写进 key（`local::group:123` / `remote:srv-1::group:123`），
 * 从根上杜绝"拿这台库的内容糊另一台"。 */

/** 作用域标记（进 key 用）：`local` 或 `remote:<serverId>` */
const scopeTagOf = (scope: ChatScope, serverId: string) => (scope === 'remote' ? `remote:${serverId}` : 'local');

/** 会话列表的读取缓存键：`chat:convs:local` / `chat:convs:remote:<serverId>`
 *  （只缓存列表本身，"选中了哪个会话"不进缓存） */
const convsCacheKeyOf = (scope: ChatScope, serverId: string) => `chat:convs:${scopeTagOf(scope, serverId)}`;

/** 顶部三个数字的读取缓存键：`chat:stats:local` / `chat:stats:remote:<serverId>`
 *  （进页面先把上次那三个数铺上、随后后台校准：不然先摆一排 `—`，观感就是"这一页还在读"。
 *   与列表同规矩：只缓存**成功**读到的那一份，换作用域就换 key，绝不拿另一台库的数字冒充） */
const statsCacheKeyOf = (scope: ChatScope, serverId: string) => `chat:stats:${scopeTagOf(scope, serverId)}`;

/** 模块级作用域解析：与页面取作用域同一口径（见上）。 */
function chatScopeNow(): { scope: ChatScope; serverId: string } {
  const s = activeScopeInfo().scope;
  if (s.startsWith('remote:')) {
    const id = s.slice('remote:'.length);
    if (id && id !== '?') return { scope: 'remote', serverId: id };
  }
  return { scope: 'local', serverId: '' };
}

/* 会话级消息缓存（模块级）：key = `<作用域>::<会话 key>`，上限 40 条
   （列表本身最多 300 行，留最近 40 个会话足够）。
   只缓存「第一页 + 无关键词 + 全部方向」这一种读法 —— 那正是点会话时的读法。 */
type MsgSnapshot = { messages: ChatMessage[]; total: number };
const MSG_CACHE_MAX = 40;
const msgCache = new Map<string, MsgSnapshot>();
/** 正在飞的 key（`<作用域>::<会话 key>`）：点会话的读、预取、悬停预热、模块级预热共用它，
 *  免得同一个会话被并发读两三遍 */
const msgInflight = new Set<string>();
/** 预热时的并发上限：别把远程那条链压满 */
const WARM_CONCURRENCY = 3;
/** 后台预热/预取的范围：一屏大约显示 5 行，12 个足够覆盖「看得到的 + 顺手往下滚一点」 */
const WARM_CONVS = 12;

const msgCacheKeyOf = (scope: ChatScope, serverId: string, convKey: string) =>
  `${scopeTagOf(scope, serverId)}::${convKey}`;

/** 缓存别无限长：留最近 40 个会话（Map 保持插入顺序，从最旧的开始删） */
function capMsgCache(): void {
  if (msgCache.size > MSG_CACHE_MAX) {
    for (const k of [...msgCache.keys()].slice(0, msgCache.size - MSG_CACHE_MAX)) msgCache.delete(k);
  }
}

function readMsgCache(scope: ChatScope, serverId: string, convKey: string): MsgSnapshot | undefined {
  return convKey ? msgCache.get(msgCacheKeyOf(scope, serverId, convKey)) : undefined;
}
function writeMsgCache(scope: ChatScope, serverId: string, convKey: string, snap: MsgSnapshot): void {
  if (!convKey) return;
  msgCache.set(msgCacheKeyOf(scope, serverId, convKey), snap);
  capMsgCache();
}
function dropMsgCache(scope: ChatScope, serverId: string, convKey: string): void {
  if (convKey) msgCache.delete(msgCacheKeyOf(scope, serverId, convKey));
}

/** 读会话列表（全量 kind=all）。组件与模块级预热共用这一处"取数 + 整形"，
 *  写进 `chat:convs:*` 的形状因此只有一份来源。 */
type ConvsRead = { ok: true; list: ChatConv[] } | { ok: false; message: string };
async function readConvs(scope: ChatScope, serverId: string): Promise<ConvsRead> {
  try {
    const r = await getChatConvs({ scope, serverId, kind: 'all', limit: 300 });
    if (r?.ok) return { ok: true, list: Array.isArray(r.convs) ? r.convs : [] };
    return { ok: false, message: String(r?.message || '后端未给出原因') };
  } catch (e: any) {
    return { ok: false, message: String(e?.message ?? e) };
  }
}

/** 读顶部统计（三个数字 + 数据来源）：组件与模块级预热共用这一处"取数"，
 *  写进 `chat:stats:*` 的形状因此只有一份来源。只回答"读到没有"：失败给 null，
 *  成功才由调用方写缓存（失败写进去，下次进页面就会拿错误状态当旧值反复渲染）。 */
async function readStats(scope: ChatScope, serverId: string): Promise<ChatStatsResp | null> {
  try {
    const r = await getChatStats({ scope, serverId });
    return r?.ok ? r : null;
  } catch { return null; }
}

/** 后台读一个会话的第一页放进缓存（页面预取 / 悬停预热 / 模块级预热都走这里）：
 *  已缓存 / 已在飞 / 并发已满就跳过；失败当没发生，不占任何界面状态（不 busy、不骨架、不报错）。 */
async function warmConvFor(scope: ChatScope, serverId: string, convKey: string): Promise<void> {
  if (!convKey) return;
  const k = msgCacheKeyOf(scope, serverId, convKey);
  if (msgCache.has(k) || msgInflight.has(k)) return;
  if (msgInflight.size >= WARM_CONCURRENCY) return;
  msgInflight.add(k);
  try {
    const r = await getChatMessages({ scope, serverId, key: convKey, limit: PAGE, offset: 0, query: '', direction: 'all' });
    if (r?.ok) {
      writeMsgCache(scope, serverId, convKey, {
        messages: Array.isArray(r.messages) ? r.messages : [],
        total: Number(r.total) || 0,
      });
    }
  } catch { /* 预热失败不影响界面 */ } finally { msgInflight.delete(k); }
}

/** 「打开聊天记录页」的预热：模块级调用，**不带参数**（作用域自己解析，口径见上）。
 *  做两件事：(a) 读会话列表写 `chat:convs:*`；(b) 对列表最前面 12 个会话预热第 0 页消息
 *  （与页面自身的后台预取同一个范围、同一套去重与并发上限）。
 *  失败静默：`warmCache` 与 `warmConvFor` 都自己吞掉 —— 预热不 setState、不弹错、不刷屏。 */
export async function warmChatPage(): Promise<void> {
  const { scope, serverId } = chatScopeNow();
  /* 顶部三个数字（`chat:stats:*`）与列表**并行**预热：两条都是后台读，谁先回来都行；
     失败静默（readStats 给 null，warmCache 见 null 不写缓存）。这一步就是"点进页面数字已经在"的来源。 */
  void warmCache(statsCacheKeyOf(scope, serverId), async () => readStats(scope, serverId));
  const key = convsCacheKeyOf(scope, serverId);
  await warmCache(key, async () => {
    const r = await readConvs(scope, serverId);
    return r.ok ? r.list : null;   // 失败不写缓存（warmCache 见 null 即跳过）
  });
  /* 列表取"缓存里最新的那份"：刚预热带回来的，或者本轮之前就已经有了的（那份本来就够用） */
  const list = initialFromCache<ChatConv[]>(key).value ?? [];
  for (const cv of list.slice(0, WARM_CONVS)) await warmConvFor(scope, serverId, cv.key);
}

type ConvKindFilter = 'all' | 'group' | 'private';
type DirectionFilter = 'all' | 'in' | 'out';

/** 千分位整数（后端字段缺失时按 0 显示，不出现 NaN） */
const num = (v?: number | null) => (Number.isFinite(Number(v)) ? Number(v).toLocaleString('zh-CN') : '0');
/** 平均 token：小数值有意义（<100 保留一位），大数值取整；一律加千分位 */
const fmtAvg = (v?: number | null) => {
  const n = Number(v) || 0;
  if (!(n > 0)) return '—';
  return (n < 100 ? n.toFixed(1) : String(Math.round(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
};
/** 大数缩写（token 量级）：≥1 亿写「X.YZ 亿」、≥1 万写「X.Y 万」，避免卡片里塞一长串数字 */
const fmtBig = (v?: number | null) => {
  const n = Number(v) || 0;
  if (n >= 1e8) return `${(n / 1e8).toFixed(2)} 亿`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)} 万`;
  return num(n);
};
/** MM-DD HH:mm（与群友画像页同一口径，便于两页对照看时间） */
const fmtTs = (ms?: number | null) => {
  const t = Number(ms) || 0;
  if (!(t > 0)) return '—';
  const d = new Date(t), p = (x: number) => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const trunc = (s: unknown, n: number) => {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n) + '…' : t;
};

/** 读取占位骨架：形状跟目标行一致（消息行 / 会话行都用它）。
 *  用它代替「正在读取…」那行字 + 转圈 —— 读取中屏上是"内容马上就位"的样子，
 *  而不是"被清空去等"。 */
const Skeleton = ({ rows = 5, variant = 'msg' }: { rows?: number; variant?: 'msg' | 'conv' }) => (
  <div className="chat-skel" aria-hidden="true">
    {Array.from({ length: rows }).map((_, i) => (
      <div className={`chat-skel-row is-${variant}`} key={i}>
        <span className="chat-skel-bar w-time" />
        <span className="chat-skel-bar w-name" />
        <span className="chat-skel-bar w-text" />
      </div>
    ))}
  </div>
);

/* 今日发送 / 总发送：带 "+N" 浮出的计数（2026-09-26 一度还原成纯数字，2026-09-27 主人要求加回来：
   "你聊天记录页的那个也加个 +小数字的动效，之前加过的"），与学习页的 token 统计共用 StatValue，
   两页观感一致。第三张「平均每条消息 token」是会涨会跌的平均值，用 signed 版本：涨 +N、跌 -N。 */

export default function ChatHistory({ onBack, remote }: Props) {
  /* 作用域完全跟随连接事实（没有开关，也没有"待选择"的中间态）：
   *   remote 有值 → 服务端那台（serverId 就是它的 id）；否则本机。
   * 连接一变（连上 / 断开 / 换服务器），scope 与 serverId 自身就跟着变，
   * 下面的 effect 依赖它们，因此会自动重读，不需要用户做任何选择。 */
  const scope: ChatScope = remote ? 'remote' : 'local';
  const serverId = remote?.id ?? '';

  /* 首帧用上次读到的那份统计起底（`chat:stats:<作用域>`）：数字立刻在，后台再校准。
     没有旧值（本次会话还没读过这个作用域）时仍是 null，卡片显示 `—`（而不是 0 这种假数）。
     与列表同一套：作用域换了就换 key，切回原来的那台时那份还在。 */
  const statsFromCache = () => initialFromCache<ChatStatsResp>(statsCacheKeyOf(scope, serverId));
  const [stats, setStats] = useState<ChatStatsResp | null>(() => statsFromCache().value ?? null);
  const [statsErr, setStatsErr] = useState('');
  /* 会话列表一律取全量（kind=all），群聊/私聊的筛选在前端做：
     推流推的是全量，切「群聊/私聊」不必再发请求，也不会因为筛选把新会话挡在外面。
     首帧用上次读到的那份起底（`chat:convs:<作用域>`，只缓存列表本身）：进页面即出内容，
     再后台静默重读、读到原地替换；确实没有旧值（本次会话没读过这个作用域）才摆骨架行。 */
  const convsFromCache = () => initialFromCache<ChatConv[]>(convsCacheKeyOf(scope, serverId));
  const [allConvs, setAllConvs] = useState<ChatConv[]>(() => convsFromCache().value ?? []);
  const [convsErr, setConvsErr] = useState('');
  /* 第一份会话列表到没到：没到之前左栏显示骨架行，而不是"还没有会话记录"这种结论。
     首帧就命中缓存时直接算"已到"（那份列表就在屏上，不该再摆骨架）。 */
  const [convsLoaded, setConvsLoaded] = useState(() => convsFromCache().fromCache);
  const [kind, setKind] = useState<ConvKindFilter>('all');
  /* 数据通路：sse=实时推流；poll=推流连续失败，已退回轮询兜底（界面上给一个小标）。 */
  const [live, setLive] = useState<'sse' | 'poll'>('sse');

  const [selKey, setSelKey] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [msgsErr, setMsgsErr] = useState('');
  const [msgsBusy, setMsgsBusy] = useState(false);
  /* q 与 qInput 分开：输入框每敲一个字都改 qInput，只有回车/点「搜索」才写进 q（并发出请求）。
     这样翻页、切方向、刷新都沿用一个已提交的关键词，不会把半截输入当成筛选条件。 */
  const [q, setQ] = useState('');
  const [qInput, setQInput] = useState('');
  const [direction, setDirection] = useState<DirectionFilter>('all');

  const [selIds, setSelIds] = useState<string[]>([]);
  const [days, setDays] = useState('7');
  /* busy 用「正在执行的操作名」而非布尔量：按钮上的转圈只出现在被点的那一个，
     其余删除按钮同时禁用，避免两条危险操作并行。 */
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [msgKind, setMsgKind] = useState<'notice' | 'warn'>('notice');

  /* ── 新消息的「顺滑入场 + 金色高亮」（2026-09-26 要求）─────────────────────────────
   * 推流每 2 秒就可能推一次变化。原来收到变化就把当前会话整页重读，观感是"被重置"；
   * 现在只做两件事：把**变化的那一条**标成 fresh（金色高亮，2.8 秒自己褪掉），
   * 以及让会话行的位移用 FLIP 平滑过去 —— 界面不转圈、不重画整列。 */
  const [freshConvs, setFreshConvs] = useState<Record<string, number>>({});
  const [freshMsgs, setFreshMsgs] = useState<Record<string, number>>({});
  const flashTimersRef = useRef<number[]>([]);
  const flash = useCallback((setter: typeof setFreshConvs, keys: string[]) => {
    const list = keys.filter(Boolean);
    if (!list.length) return;
    const until = Date.now() + 2800;
    setter((m) => { const o = { ...m }; for (const k of list) o[k] = until; return o; });
    const t = window.setTimeout(() => {
      setter((m) => {
        const now = Date.now(); const o: Record<string, number> = {};
        for (const [k, v] of Object.entries(m)) if (v > now) o[k] = v;
        return o;
      });
    }, 2900);
    flashTimersRef.current.push(t);
  }, []);
  useEffect(() => () => { for (const t of flashTimersRef.current) window.clearTimeout(t); }, []);

  /* 会话签名 = 条数 | 最后时间。只有签名真的变了才算"这个会话来了新消息"：
     首次见到某个会话（基线）不算变化，否则一进页面满屏金色。 */
  const convSigRef = useRef(new Map<string, string>());
  const noteConvChanges = useCallback((list: ChatConv[]) => {
    const prev = convSigRef.current;
    const next = new Map<string, string>();
    const changed: string[] = [];
    for (const cv of list) {
      const sig = `${Number(cv.count) || 0}|${Number(cv.lastTs) || 0}`;
      next.set(cv.key, sig);
      const old = prev.get(cv.key);
      if (old !== undefined && old !== sig) changed.push(cv.key);
    }
    convSigRef.current = next;
    if (changed.length) flash(setFreshConvs, changed);
    return changed;
  }, [flash]);

  /* 连接状态由 App 统一轮询并作为 remote 传进来，页面不再自己读一次
     （自己读只会读到打开那一刻的快照，连上/断开时不会跟着变）。 */

  const loadStats = useCallback(async () => {
    setStatsErr('');
    try {
      const r = await getChatStats({ scope, serverId });
      setStats(r);
      if (!r?.ok) setStatsErr(String(r?.message || '后端未给出原因'));
      else writeCacheValue(statsCacheKeyOf(scope, serverId), r);   // 读到真值即覆盖缓存：下次进页面先铺这份
    } catch (e: any) {
      setStats(null);
      setStatsErr(String(e?.message ?? e));
    }
  }, [scope, serverId]);

  const loadConvs = useCallback(async () => {
    setConvsErr('');
    /* 取数 + 整形在模块级 `readConvs`（与预热函数共用同一份代码，见文件头部那段） */
    const r = await readConvs(scope, serverId);
    if (r.ok) {
      setAllConvs(r.list);
      noteConvChanges(r.list);
      /* 读到新列表即覆盖读取缓存：下次进页面 / 换回这个作用域时先按这份旧值渲染 */
      writeCacheValue(convsCacheKeyOf(scope, serverId), r.list);
    } else { setAllConvs([]); setConvsErr(r.message); }
    setConvsLoaded(true);
  }, [scope, serverId, noteConvChanges]);

  /* 会话级消息缓存：点回已经看过的会话直接瞬时出内容（先渲染缓存，再后台悄悄校准）。
     缓存本体是模块级的 `msgCache`（key = `<作用域>::<会话 key>`，上限 40 条），
     提到模块级是为了让模块级的 `warmChatPage()` 也能往里写（见文件头部那段）。
     只缓存「第一页 + 无关键词 + 全部方向」这一种读法 —— 那正是点会话时的读法。 */

  const warmTimerRef = useRef<number | null>(null);

  /* 后台读一个会话的第一页放进缓存（预取与悬停预热都走这里）：已缓存 / 已在飞 / 并发已满就跳过。
     实现是模块级的 `warmConvFor` —— 与 `warmChatPage()` 共用同一条去重与并发上限。 */
  const warmConv = useCallback((key: string) => warmConvFor(scope, serverId, key), [scope, serverId]);

  /* 鼠标在一个会话行上停 120ms 就顺手预热它（远程一次读要 0.3~0.6s，
     所以"手先到、内容后到"，点下去时多半已经命中缓存）。移到别的行会重排这个计时器。 */
  const onConvHover = (key: string) => {
    if (warmTimerRef.current) window.clearTimeout(warmTimerRef.current);
    warmTimerRef.current = window.setTimeout(() => { void warmConv(key); }, 120);
  };

  const loadMsgs = useCallback(async (key: string, nextOffset: number, nextQ: string, nextDir: DirectionFilter, quiet = false) => {
    if (!key) return;
    /* quiet=true：不把消息栏换成任何读取态（连骨架都不换），屏上内容原地不动，读到了再替换。
       "瞬时读取"就靠它 —— 翻页 / 搜索 / 切方向 / 推流兜底 / 缓存命中后的校准一律走它；
       只有"这个会话一次都没读过"那一次才显示骨架占位（那是真没内容可留）。 */
    if (!quiet) setMsgsBusy(true);
    setMsgsErr('');
    const flightKey = msgCacheKeyOf(scope, serverId, key);
    msgInflight.add(flightKey);
    try {
      const r = await getChatMessages({
        scope, serverId,
        key, limit: PAGE, offset: nextOffset, query: nextQ, direction: nextDir,
      });
      if (r?.ok) {
        const list = Array.isArray(r.messages) ? r.messages : [];
        setMessages(list);
        setTotal(Number(r.total) || 0);
        setOffset(nextOffset);
        // 第一页 + 无关键词 + 全部方向 = 点会话时的读法，写进缓存供下次瞬时渲染
        if (nextOffset === 0 && !nextQ && nextDir === 'all') {
          writeMsgCache(scope, serverId, key, { messages: list, total: Number(r.total) || 0 });
        }
        setSelIds([]);   // 换页/换筛选后旧的勾选已不在屏上，留着会让「删除选中」删到看不见的条目
      } else {
        setMessages([]); setTotal(0);
        setMsgsErr(String(r?.message || '后端未给出原因'));
      }
    } catch (e: any) {
      setMessages([]); setTotal(0);
      setMsgsErr(String(e?.message ?? e));
    } finally { msgInflight.delete(flightKey); if (!quiet) setMsgsBusy(false); }
  }, [scope, serverId]);

  const msgKeyOf = (m: ChatMessage) => m.id || `${m.ts}-${m.senderUid}-${m.content}`;
  const messagesRef = useRef<ChatMessage[]>([]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  const msgListRef = useRef<HTMLDivElement | null>(null);
  const msgScrollRef = useRef({ before: 0, atTop: false, scrollTop: 0, armed: false });
  /* 上一次见到的会话总条数（按 key 记）：差量 = 本次条数 - 上次条数。
     注意不能用"会话总条数 - 屏上条数"——屏上永远只有一页（50 条），总条数动辄几千，
     那样算出来永远 >50，就永远退化成整页重读、也就永远看不到"新消息蹦出来"了。 */
  const prevCountRef = useRef(new Map<string, number>());

  /* 只补差量：取最新 added 条，按 id 去重后插到最前面（后端 offset=0 就是最新一页），
     并给新出现的那几条加金色高亮。added >50 条、或屏上本来就是空的，才退回整页读取
     —— 而且走 quiet，不转圈。取数失败时**不推进基线**，下一轮还会再试同一批。 */
  const mergeNewMsgs = useCallback(async (key: string, convCount: number) => {
    const totalNow = Number(convCount) || 0;
    const prev = prevCountRef.current.get(key);
    if (prev === undefined) { prevCountRef.current.set(key, totalNow); return; }
    const added = totalNow - prev;
    if (added <= 0) { if (added < 0) prevCountRef.current.set(key, totalNow); return; }
    const host = msgListRef.current;
    msgScrollRef.current = {
      before: host?.scrollHeight ?? 0,
      atTop: !host || host.scrollTop <= 8,
      scrollTop: host?.scrollTop ?? 0,
      armed: true,
    };
    if (messagesRef.current.length === 0 || added > 50) {
      msgScrollRef.current.armed = false;
      prevCountRef.current.set(key, totalNow);
      void loadMsgs(key, 0, '', 'all', true);
      return;
    }
    try {
      const r = await getChatMessages({ scope, serverId, key, limit: added, offset: 0, query: '', direction: 'all' });
      if (!r?.ok) { msgScrollRef.current.armed = false; return; }
      const known = new Set(messagesRef.current.map(msgKeyOf));
      const add = (Array.isArray(r.messages) ? r.messages : []).filter((m) => !known.has(msgKeyOf(m)));
      if (!add.length) { msgScrollRef.current.armed = false; prevCountRef.current.set(key, totalNow); return; }
      prevCountRef.current.set(key, totalNow);
      /* 插到最前面之后裁掉尾部多余的（一个会话开着不动，推流会一直往里加）：
         一页 50 条 + 最多再来 50 条，超出的部分翻页本来就还能看到。 */
      setMessages((prevMsgs) => [...add, ...prevMsgs].slice(0, PAGE + 50));
      setTotal(Number(r.total) || 0);
      flash(setFreshMsgs, add.map(msgKeyOf));
    } catch { msgScrollRef.current.armed = false; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, serverId, flash, loadMsgs]);

  /* 差量插入后把滚动位置补回来：本来贴着顶部（正在看最新的几条）就保持贴顶，
     否则把新增的高度加回去，别把正在看的位置顶走。 */
  useLayoutEffect(() => {
    const host = msgListRef.current; const meta = msgScrollRef.current;
    if (!host || !meta.armed) return;
    meta.armed = false;
    const added = host.scrollHeight - meta.before;
    if (meta.atTop) host.scrollTop = 0;
    else if (added > 0) host.scrollTop = meta.scrollTop + added;
  }, [messages]);

  /* 2026-09-24 主人要求："去掉刷新按钮，改为 SSE"。
   * 打开页面即挂一条 SSE（/api/bridge/chat-stream）：后端每 5 秒取一次 stats + convs，
   * 只有内容真变了才推一帧过来，所以这里不需要定时器、也不会无谓重渲染。
   *   · stats / convs 事件 → 直接替换对应状态（数字与列表自己会长出来）；
   *   · 事件里带 ok:false → 当错误显示，但**保留上一次的数据**（不清屏）；
   *   · stream-error 或连续两次 onerror → 退回 30 秒轮询兜底（EventSource 自身也在重连，
   *     推流恢复后会自动切回实时，界面上那个小标会跟着变）。
   * 作用域变了（连上/断开服务器）就重建这条流：query 里的 scope / serverId 跟着走。 */
  useEffect(() => {
    if (typeof EventSource === 'undefined') { setLive('poll'); return () => {}; }
    let alive = true;
    let errs = 0;
    let poll: number | null = null;
    let es: EventSource | null = null;
    const startPoll = () => { if (poll === null) poll = window.setInterval(() => { void loadStats(); void loadConvs(); }, 30000); };
    const stopPoll = () => { if (poll !== null) { clearInterval(poll); poll = null; } };

    const applyStats = (payload: any) => {
      if (!alive || !payload || typeof payload !== 'object') return;
      setStats(payload);
      setStatsErr(payload.ok ? '' : String(payload.message || '后端未给出原因'));
      if (payload.ok) writeCacheValue(statsCacheKeyOf(scope, serverId), payload);   // 推流推来的同样是"读到的新值"
    };
    const applyConvs = (payload: any) => {
      if (!alive || !payload || typeof payload !== 'object') return;
      if (payload.ok) {
        const list = Array.isArray(payload.convs) ? payload.convs : [];
        setAllConvs(list);
        setConvsErr('');
        setConvsLoaded(true);
        noteConvChanges(list);   // 变了的那几行加金色高亮（首帧只记基线，不闪）
        writeCacheValue(convsCacheKeyOf(scope, serverId), list);   // 推流推来的也是"读到的新列表"
      } else setConvsErr(String(payload.message || '后端未给出原因'));
    };

    try {
      es = new EventSource(`/api/bridge/chat-stream?scope=${encodeURIComponent(scope)}&serverId=${encodeURIComponent(serverId)}`);
      es.addEventListener('snapshot', () => { errs = 0; stopPoll(); if (alive) setLive('sse'); });
      es.addEventListener('stats', (ev: MessageEvent) => { errs = 0; stopPoll(); if (alive) setLive('sse'); try { applyStats(JSON.parse(ev.data)); } catch { /* 半截帧，下一帧再说 */ } });
      es.addEventListener('convs', (ev: MessageEvent) => { try { applyConvs(JSON.parse(ev.data)); } catch { /* 同上 */ } });
      es.addEventListener('stream-error', () => { errs += 1; if (errs >= 2) { setLive('poll'); startPoll(); } });
      es.onerror = () => { errs += 1; if (alive && errs >= 2) { setLive('poll'); startPoll(); } };
    } catch {
      setLive('poll');
      startPoll();
    }

    return () => { alive = false; if (es) es.close(); stopPoll(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, serverId]);

  useEffect(() => { void loadStats(); }, [loadStats]);
  /* 从别的标签页切回来时立刻重读一次：屏上先摆着的可能是切走前的那份，
     不必等下一拍推流（"瞬时读数"的补一刀，不引入任何新请求路径）。 */
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== 'visible') return;
      void loadStats();
      void loadConvs();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [loadStats, loadConvs]);
  useEffect(() => { void loadConvs(); }, [loadConvs]);
  /* 作用域一变（连上/断开服务器）即换一份库：上一个作用域的会话与消息全部作废
     （否则会拿着服务端的 key 去查本机）。 */
  useEffect(() => {
    setSelKey(''); setMessages([]); setTotal(0); setOffset(0); setSelIds([]); setMsgsErr('');
    prevCountRef.current.clear();   // 换库了：差量基线不能跨库沿用
    /* 换库了：消息缓存不必再 clear —— 它的 key 里自带作用域（`<作用域>::<会话 key>`），
       另一台库的内容永远读不到；切回原来那台时那份还在，正好是"有旧值就先显示旧值"。
       会话列表同理：改铺新作用域那份缓存（没有旧值就空着 + 骨架），随后照常读一次真值。 */
    /* 统计同理：铺新作用域那份缓存（没有就回 `—`），旧错误提示一并清掉（它属于上一个作用域） */
    const bootStats = statsFromCache();
    setStats(bootStats.value ?? null);
    setStatsErr('');
    const boot = convsFromCache();
    setAllConvs(boot.value ?? []);
    setConvsLoaded(boot.fromCache);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, serverId]);

  /* 会话列表全量在前、筛选在后：切「全部/群聊/私聊」是本地过滤，网格立刻变，不发请求。 */
  const convs = useMemo(
    () => (kind === 'all' ? allConvs : allConvs.filter((c) => c.kind === kind)),
    [allConvs, kind],
  );
  /* 选中的会话从全量里找：筛成「群聊」时，之前选中的私聊仍然能取到名字（用于标题与删除确认）。 */
  const selConv = useMemo(() => allConvs.find((c) => c.key === selKey) ?? null, [allConvs, selKey]);

  /* 会话行的位移用 FLIP：先量上一帧每行的位置，渲染后把差值当成初始 transform 再放回 0，
     于是有新消息的会话是"滑"到最上面，而不是整列重画（过渡在 .chat-conv-row 的 transform 上）。 */
  const convListRef = useRef<HTMLDivElement | null>(null);
  const convTopsRef = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const host = convListRef.current;
    if (!host) return;
    const prev = convTopsRef.current;
    const next = new Map<string, number>();
    for (const el of Array.from(host.querySelectorAll<HTMLElement>('[data-conv-key]'))) {
      const key = el.dataset.convKey || '';
      const top = el.getBoundingClientRect().top;
      next.set(key, top);
      const before = prev.get(key);
      if (before === undefined || Math.abs(before - top) < 1.5) continue;
      el.style.transition = 'none';
      el.style.transform = `translateY(${before - top}px)`;
      void el.offsetHeight;   // 强制回流：让下面的过渡从这个位移开始，而不是被浏览器合并掉
      el.style.transition = '';
      el.style.transform = '';
    }
    convTopsRef.current = next;
  }, [convs]);

  /* 推流把新消息送进来后，若当前正开着的这个会话变了（条数或最后时间）：
     只补差量（mergeNewMsgs：静默插到最前面 + 金色高亮），**不再整页重读转圈**。
     只在"停在第一页且没有搜索筛选"时做，避免把正在翻页/搜索的人顶走；删除进行中也不动
     （那由 runDelete 自己收尾）。方向筛选（收到的/我发的）下差量跟"新条数"对不上，
     那种情况退回整页 quiet 重读 —— 依旧不转圈。
     基线按会话记（key + 签名）：选中某个会话后第一次拿到数据只记基线，不当成"有变化"。 */
  const selSigRef = useRef<{ key: string; sig: string }>({ key: '', sig: '' });
  useEffect(() => {
    if (!selKey) { selSigRef.current = { key: '', sig: '' }; return; }
    const c = allConvs.find((x) => x.key === selKey);
    if (!c) return;
    const sig = `${c.count}|${c.lastTs}`;
    const prev = selSigRef.current;
    if (prev.key !== selKey) {
      selSigRef.current = { key: selKey, sig };
      prevCountRef.current.set(selKey, Number(c.count) || 0);   // 基线：这一刻的条数
      return;
    }
    if (prev.sig === sig) return;
    selSigRef.current = { key: selKey, sig };
    if (offset === 0 && !q && !busy && !msgsBusy) {
      if (direction === 'all') void mergeNewMsgs(selKey, c.count);
      else void loadMsgs(selKey, 0, '', direction, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allConvs, selKey, offset, q, busy, msgsBusy, direction]);

  /* 点会话：**先出内容、再校准**，中途不出现任何读取态。
     · 缓存里有 → 立刻渲染（0 等待），同时后台 quiet 重读一遍校准（内容没变就什么都不动）；
     · 缓存里没有 → 只给骨架占位（形状跟消息行一样），也没有「正在读取…」那行字；
     · 点的是当前已选中的那个 → 什么都不做（原来会白读一遍、顺带闪一下）。 */
  const pickConv = (key: string) => {
    if (key === selKey) return;
    setSelKey(key); setQ(''); setQInput(''); setDirection('all');
    selSigRef.current = { key: '', sig: '' };
    const known = allConvs.find((x) => x.key === key);
    prevCountRef.current.set(key, Number(known?.count) || 0);   // 差量基线跟着切会话重置
    const hit = readMsgCache(scope, serverId, key);
    setSelIds([]); setMsgsErr('');
    if (hit) {
      setMessages(hit.messages); setTotal(hit.total); setOffset(0);
      void loadMsgs(key, 0, '', 'all', true);
    } else {
      setMessages([]); setTotal(0); setOffset(0);
      void loadMsgs(key, 0, '', 'all');
    }
  };

  /* 后台预取：会话列表一到位，就把最前面 12 个会话（不够就全部）的第一页悄悄读下来放进缓存 ——
     一屏大约显示 5 行，12 个足够覆盖「看得到的 + 顺手往下滚一点」的范围，点它们是真·瞬时。
     串行、跳过已缓存的、失败当没发生，不占任何界面状态（不 busy、不骨架、不报错）。 */
  const prefetchingRef = useRef(false);
  useEffect(() => {
    if (prefetchingRef.current) return;
    const keys = convs.slice(0, 12).map((c) => c.key).filter((k) => k !== selKey && !readMsgCache(scope, serverId, k));
    if (!keys.length) return;
    prefetchingRef.current = true;
    (async () => {
      for (const k of keys) await warmConvFor(scope, serverId, k);
      // 缓存别无限长：留最近 40 个会话足够（列表本身最多 300 行；上限在 msgCache 内部统一维护）
      capMsgCache();
    })().finally(() => { prefetchingRef.current = false; });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convs, selKey, scope, serverId]);

  /** 所有删除都走这里：调用方先弹二次确认，这里只负责发请求 + 汇报 + 刷新。
   *  成功后必须重读统计与会话列表（否则卡片和列表还显示删除前的条数，看起来像没生效），
   *  并按需重载当前会话的消息页。 */
  const runDelete = async (
    label: string,
    body: { key?: string; ids?: string[]; beforeMs?: number; all?: boolean },
  ) => {
    setBusy(label);
    setMsg(null);
    try {
      const r = await deleteChatHistory({ scope, serverId, ...body });
      if (r?.ok) {
        setMsgKind('notice');
        setMsg(`${label}完成：已删除 ${num(r.deleted)} 条${r.mode ? `（${r.mode}）` : ''}`);
        await Promise.all([loadStats(), loadConvs()]);
        if (body.key) await loadMsgs(body.key, 0, q, direction, true);   // 删完也原地换，不跳读取态
        dropMsgCache(scope, serverId, body.key || '');                   // 缓存作废，下次点它重读
      } else {
        setMsgKind('warn');
        setMsg(`${label}未执行：${r?.message || '后端未给出原因'}`);
      }
    } catch (e: any) {
      setMsgKind('warn');
      setMsg(`删除失败：${String(e?.message ?? e)}`);
    } finally { setBusy(''); }
  };

  const toggleId = (id: string) =>
    setSelIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  /* 三个危险按钮：一律先 window.confirm，文案里写明「不可恢复」与影响范围（多少条 / 哪个会话）——
     只说「确定删除吗」不足以让人意识到这是从记忆库里真删。 */
  const doDeleteSelected = () => {
    if (!selIds.length) return;
    if (!window.confirm(`将永久删除选中的 ${selIds.length} 条聊天记录，删除后不可恢复。是否继续？`)) return;
    void runDelete('删除选中', { ids: selIds });
  };

  const doDeleteConv = () => {
    if (!selKey) return;
    const name = selConv?.name || selKey;
    if (!window.confirm(`将永久删除会话「${name}」的全部记录（共 ${num(selConv?.count)} 条），删除后不可恢复。是否继续？`)) return;
    void runDelete('删除该会话全部记录', { key: selKey, all: true });
  };

  const doDeleteBefore = () => {
    if (!selKey) return;
    const d = Math.floor(Number(days));
    if (!Number.isFinite(d) || d <= 0) {
      setMsgKind('warn');
      setMsg(`「删除 X 天前」的天数要填正整数（当前填的是「${days}」），未发出请求。`);
      return;
    }
    const beforeMs = Date.now() - d * DAY_MS;
    const name = selConv?.name || selKey;
    if (!window.confirm(`将永久删除会话「${name}」中 ${d} 天前（即 ${fmtTs(beforeMs)} 之前）的全部记录，删除后不可恢复。是否继续？`)) return;
    void runDelete(`删除 ${d} 天前`, { key: selKey, beforeMs });
  };

  const submitSearch = () => {
    if (!selKey) return;
    const kw = qInput.trim();
    setQ(kw);
    void loadMsgs(selKey, 0, kw, direction, true);   // 搜索也原地换，不跳读取态
  };

  const setDir = (d: DirectionFilter) => {
    setDirection(d);
    if (selKey) void loadMsgs(selKey, 0, q, d, true);
  };

  const c = stats?.counters;
  const u = stats?.usage;
  const avg = Number(u?.avgTokensPerMessage) || 0;

  return (
    <div className="page cute-ui">
      <div className="page-header">
        <div className="page-header-left">
          <button className="btn btn-sm" onClick={onBack}><ArrowLeft size={15} /> 返回</button>
          <div className="page-title-wrap">
            <div className="page-title">聊天记录</div>
            <div className="page-subtitle">
              {/* 来源跟着连接走，标题里把当前这一侧说出来即可（没有可切换的开关） */}
              {remote ? `服务端：${remote.name}（${remote.host}）` : '本机：本机桥的聊天记录库 chat.db'}
            </div>
          </div>
        </div>
        <div className="page-actions">
          {/* 2026-09-24 主人要求："去掉刷新按钮，改为 SSE" —— 这里不再有手动刷新。
              数字与会话列表由 /api/bridge/chat-stream 推过来（后端每 2 秒探一次、有变化才推），
              这个小标只说数据是"实时推流"还是"推流断了、已退回 30 秒轮询"。 */}
          <span className={`chat-live${live === 'poll' ? ' is-poll' : ''}`}
>
            <Radio size={13} /> {live === 'sse' ? '实时推流' : '轮询兜底'}
          </span>
        </div>
      </div>

      <div className="page-body">
        <NoticeBar msg={msg} onClose={() => setMsg(null)} kind={msgKind} />

        {statsErr && (
          <div className="notice-bar" style={{ borderColor: '#e5484d', background: '#fef2f2', color: '#912018', cursor: 'default' }}>
            统计读取失败：{statsErr}
          </div>
        )}

        {/* 三张统计卡：粉 / 浅黄 / 浅蓝，各带一层流动渐变光效（样式在 app.css 的 .c-pink/.c-yellow/.c-blue）。
            数字口径全部来自 /bridge/chat-stats（现在由 SSE 推送），不在前端二次计算。
            2026-09-24 主人反馈"这个计数和聊天记录对不上吧"：卡片的"发送"只算机器人发出的，
            而左边会话列表的"条"是发出+收到，两者本来就不是一个数。现在每张卡把自己的口径
            写在数字下面（从哪个窗口、算的是哪一部分、分母是多少），一眼能对回列表。 */}
        <div className="chat-stat-row stagger-in">
          <div className="chat-stat-card c-pink">
            <div className="k">今日发送消息总数</div>
            {/* key 带上作用域：切本机/服务端时整体重挂，差量基线不会跨库沿用（否则会闪一个假 +N） */}
            <StatValue key={scope + ':' + serverId} className="v" value={stats && c ? Math.round(Number(c.todaySent) || 0) : null} text={stats ? num(c?.todaySent) : '—'} />
            <div className="k-sub">今天 00:00 起 · 全部 {num(c?.convTotal)} 个会话合计 · 只算机器人发出的（今天这里共 {num(c?.todayTotal)} 条）</div>
          </div>
          <div className="chat-stat-card c-yellow">
            <div className="k">总发送消息总数</div>
            <StatValue key={scope + ':' + serverId} className="v" value={stats && c ? Math.round(Number(c.sentTotal) || 0) : null} text={stats ? num(c?.sentTotal) : '—'} />
            <div className="k-sub">全部历史 · 只算机器人发出的；库内合计 {num(c?.total)} 条 = 发出 {num(c?.sentTotal)} + 收到 {num(c?.receivedTotal)}</div>
          </div>
          <div className="chat-stat-card c-blue">
            <div className="k">平均每条消息 token 消耗</div>
<StatValue key={scope + ':' + serverId} className="v" signed value={stats && u ? Math.round(avg) : null} text={stats ? fmtAvg(avg) : '—'} />
            <div className="k-sub">
              近 {num(u?.sinceDays || 7)} 天 · 会话轮次 {fmtBig(u?.totalTokens)} token ÷ 同期发出 {num(u?.messages)} 条
              （含上下文与缓存命中，所以远大于回复本身的长度）
            </div>
          </div>
        </div>
        <div className="chat-stat-note">
          数据来源：{remote ? '服务端' : '本机'}桥的聊天记录库 <code>{stats?.dbPath || (statsErr ? '（路径未返回）' : '—')}</code>
          {/* 口径写清楚是为了让这三个数字可核对：前两张只统计机器人发出的消息。 */}
          ；对账：库内 {num(c?.total)} 条 = 收到 {num(c?.receivedTotal)} + 发出 {num(c?.sentTotal)}（会话列表里每行的「发/收」相加即这两个数）
          {u?.sinceDays ? `；token 窗口最近 ${u.sinceDays} 天（台账 ${u.ledgerPath || '未返回'}${u.ledgerLines ? `，计入 ${num(u.ledgerLines)} 轮` : ''}${u.excludedLines ? `，另有 ${num(u.excludedLines)} 轮与会话无关的内部任务未计入` : ''}）` : ''}
          {avg > 0 ? '' : `；平均 token 暂无数据，显示为 —${u?.note ? `：${u.note}` : '（后端未给出 note）'}`}
        </div>

        <div className="chat-main">
          <div className="card" style={{ padding: '14px 16px' }}>
            <div className="card-title"><Users size={15} /> 会话（{convsLoaded ? num(convs.length) : '…'}）</div>
            <div className="chat-toolbar">
              {([['all', '全部'], ['group', '群聊'], ['private', '私聊']] as const).map(([k, label]) => (
                <button key={k} className={`btn btn-sm${kind === k ? ' btn-soft-primary' : ''}`}
                  onClick={() => setKind(k)}>{label}</button>
              ))}
            </div>
            {convsErr && <div className="chat-err">会话列表读取失败：{convsErr}</div>}
            {!convsErr && convsLoaded && convs.length === 0 && (
              <div className="chat-empty">{remote ? '服务端上还没有读到会话记录。' : '本机桥的聊天记录库里还没有会话记录。'}</div>
            )}
            <div className="chat-conv-list" ref={convListRef}>
              {!convsLoaded && !convsErr && <Skeleton rows={5} variant="conv" />}
              {convs.map((cv) => (
                <div key={cv.key} data-conv-key={cv.key}
                  className={`chat-conv-row${cv.key === selKey ? ' active' : ''}${freshConvs[cv.key] ? ' is-fresh' : ''}`}
                  onClick={() => pickConv(cv.key)}
                  onMouseEnter={() => onConvHover(cv.key)}
                  onFocus={() => onConvHover(cv.key)}
>
                  <div className="chat-conv-head">
                    <div className="chat-conv-name">{cv.name || cv.key}</div>
                    {cv.kind === 'group'
                      ? (cv.groupNick ? <div className="chat-conv-nick">群昵称 {cv.groupNick}</div> : null)
                      : (cv.remark ? <div className="chat-conv-nick">备注 {cv.remark}</div> : null)}
                  </div>
                  <div className="chat-conv-meta">
                    {cv.key} · {cv.kind === 'group' ? '群聊' : '私聊'} · {num(cv.count)} 条
                    {' '}（发 {num(cv.sent)} / 收 {num(cv.received)}）· {fmtTs(cv.lastTs)}
                  </div>
                  <div className="chat-conv-last">{trunc(cv.lastText, 46) || '（无内容摘要）'}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="card" style={{ padding: '14px 16px' }}>
            <div className="card-title">
              <MessageSquare size={15} /> 消息{selConv ? ` · ${selConv.name || selConv.key}` : ''}
            </div>
            {!selKey ? (
              <div className="chat-empty">请先在左侧选择一个会话。</div>
            ) : (
              <>
                <div className="chat-toolbar">
                  <input className="input" style={{ maxWidth: 240 }} value={qInput}
                    placeholder="搜索消息内容（回车生效）"
                    onChange={(e) => setQInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') submitSearch(); }} />
                  <button className="btn btn-sm" onClick={submitSearch}><Search size={13} /> 搜索</button>
                  {q && (
                    <button className="btn btn-sm"
                      onClick={() => { setQInput(''); setQ(''); void loadMsgs(selKey, 0, '', direction, true); }}>清除搜索</button>
                  )}
                  <span className="chat-sep" />
                  {([['all', '全部'], ['in', '收到的'], ['out', '我发的']] as const).map(([d, label]) => (
                    <button key={d} className={`btn btn-sm${direction === d ? ' btn-soft-primary' : ''}`}
                      onClick={() => setDir(d)}>{label}</button>
                  ))}
                </div>

                <div className="chat-toolbar">
                  <span className="chat-batch-count">已选 {num(selIds.length)} 条</span>
                  <button className="btn btn-sm" disabled={!messages.length}
                    onClick={() => setSelIds(messages.map((m) => m.id).filter(Boolean))}>全选本页</button>
                  <button className="btn btn-sm" disabled={!selIds.length} onClick={() => setSelIds([])}>清空选择</button>
                  <button className="btn btn-outline-danger btn-sm" disabled={!!busy || !selIds.length}
                    onClick={doDeleteSelected}>
                    {busy === '删除选中' ? <Loader2 size={13} className="spin" /> : <Trash2 size={13} />} 删除选中
                  </button>
                  <button className="btn btn-outline-danger btn-sm" disabled={!!busy}
                    onClick={doDeleteConv}>
                    {busy === '删除该会话全部记录' ? <Loader2 size={13} className="spin" /> : <Trash2 size={13} />} 删除该会话全部记录
                  </button>
                  <span className="chat-sep" />
                  <input className="input chat-days" style={{ width: 58 }} inputMode="numeric" value={days}
                    onChange={(e) => setDays(e.target.value.replace(/\D/g, '').slice(0, 4))} />
                  <button className="btn btn-outline-danger btn-sm" disabled={!!busy}
                    onClick={doDeleteBefore}>
                    {busy.startsWith('删除 ') ? <Loader2 size={13} className="spin" /> : <Trash2 size={13} />} 删除该会话 N 天前
                  </button>
                </div>

                {msgsErr && <div className="chat-err">消息读取失败：{msgsErr}</div>}
                <div className="chat-msg-list" ref={msgListRef}>
                  {/* 读取中不再整块替换成「正在读取…」：骨架只在"这个会话一次都没读过"时出现；
                      其余情况（翻页 / 搜索 / 切方向 / 推流兜底 / 点回看过的会话）屏上内容原地不动。 */}
                  {msgsBusy && <div className="chat-progress" />}
                  {!msgsErr && messages.length === 0 && (msgsBusy
                    ? <Skeleton rows={7} variant="msg" />
                    : <div className="chat-empty">{q ? `没有匹配「${q}」的消息。` : '该会话没有消息记录。'}</div>)}
                  {messages.map((m) => (
                    <div className={`chat-msg-row${freshMsgs[msgKeyOf(m)] ? ' is-fresh' : ''}`} key={msgKeyOf(m)}>
                      <input type="checkbox" checked={!!m.id && selIds.includes(m.id)} disabled={!m.id}
                        onChange={() => { if (m.id) toggleId(m.id); }} />
                      <span className="chat-msg-time">{fmtTs(m.ts)}</span>
                      <span className="chat-msg-sender">{m.sender || m.senderUid || '未知'}</span>
                      {m.isSelf && <span className="badge badge-info">me</span>}
                      <span className="chat-msg-content" style={m.recalled ? { opacity: .6, textDecoration: 'line-through' } : undefined}>
                        {m.content || '（空内容）'}
                      </span>
                      {m.recalled && <span className="chat-msg-recalled">已撤回</span>}
                    </div>
                  ))}
                </div>

                <div className="chat-pager">
                  <span>
                    共 {num(total)} 条
                    {messages.length ? ` · 当前第 ${num(offset + 1)}–${num(offset + messages.length)} 条` : ''}
                    {q ? ` · 关键词「${q}」` : ''}
                  </span>
                  <span className="chat-pager-btns">
                    <button className="btn btn-sm" disabled={msgsBusy || offset <= 0}
                      onClick={() => void loadMsgs(selKey, Math.max(0, offset - PAGE), q, direction, true)}>上一页</button>
                    <button className="btn btn-sm" disabled={msgsBusy || offset + messages.length >= total}
                      onClick={() => void loadMsgs(selKey, offset + PAGE, q, direction, true)}>下一页</button>
                  </span>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
