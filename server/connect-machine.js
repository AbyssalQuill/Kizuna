/**
 * 连接服务端的状态机（纯逻辑，可单测）。
 *
 * 2026-09-22：需求是"我们连接上服务器之后，直接退出，下次打开自动连接服务器，这个过程希望能带上
 * 「服务端启动中」状态机。" —— 打开应用那一下最难受的不是慢，而是看不出它在干什么：SSH 连上没有？
 * 隧道几条？服务端那三个组件（DSH / NapCat / 桥）谁是好的、谁还在起？以前只在界面上写"服务端重连中…"，
 * 于是"服务端在起"和"凭据错了永远起不来"看起来一模一样。
 *
 * 所以这里把连接过程拆成能显示的阶段：
 *   idle → connecting（SSH）→ tunnels（隧道 x/y）→ server-starting（服务端组件逐个就绪）
 *        → warming（静默预鉴权 NapCat 界面，一次性）→ ready
 *   任何一步失败 → failed（带人话原因），并按退避重试。
 *   2026-10-01 新增 partial：「连上了，但服务端的组件没起来」的终态（例如 DSH/NapCat 在跑、桥停了）。
 *   它不是失败（SSH 与隧道都好好的），也不是进行中（没有任何组件在启动），所以界面不该继续显示
 *   「服务端连接中」—— 各卡片如实显示自己那份「运行中 / 未运行」，并可点「启动服务端」。
 *
 * 本模块只做状态与文案：不联网、不起进程。推进由 server/index.js 的驱动函数负责，
 * 判定"服务端组件好了没有"用的就是既有的 getRemoteServerStatus 结果（纯函数 describeRemoteStatus）。
 */

/** 阶段枚举（界面按这个顺序显示进度）。 */
export const PHASES = ['idle', 'connecting', 'tunnels', 'server-starting', 'warming', 'ready', 'partial', 'failed'];

/** 某个端口通不通。优先看组件自己报的 ports（NapCat 那份），再退回顶层聚合表；两处都没有 → null（不判定）。 */
function portUpFor(remote, port, componentId = '') {
  const own = componentId ? remote?.[componentId]?.ports : null;
  const fromOwn = own ? own[String(port)] : undefined;
  if (fromOwn !== undefined && fromOwn !== null) return fromOwn === true;
  const ports = remote?.ports ?? {};
  const v = ports[String(port)];
  return v === undefined || v === null ? null : v === true;
}

/**
 * 把 getRemoteServerStatus 的结果翻译成"三个组件各自什么状态"。纯函数（单测直接喂样例对象）。
 * @returns {{ready:boolean, down:boolean, starting:boolean, components:Array<{id:string,name:string,state:'ready'|'starting'|'down',detail:string}>, note:string}}
 */
export function describeRemoteStatus(remote, opts = {}) {
  // 端口以服务端自报的为准（每台机器可能不一样），拿不到才用调用方给的默认值
  const napcatPort = Number(remote?.remotePorts?.napcat) || Number(opts.napcatWebuiPort) || 6099;
  if (!remote || remote.ok === false) {
    return { ready: false, down: false, starting: false, components: [], note: '服务端状态还没取到' };
  }
  const dshUp = remote.dsh?.running === true;
  const dshPort = remote.dsh?.portUp !== false;                 // 老版本没有 portUp 字段时不误判
  const napRunning = remote.napcat?.running === true;
  const brUp = remote.bridge?.running === true;
  const brPort = remote.bridge?.portUp !== false;
  const components = [
    {
      id: 'dsh', name: 'DSH',
      state: dshUp ? (dshPort ? 'ready' : 'starting') : 'down',
      detail: dshUp ? (dshPort ? `已就绪（端口 ${remote.dsh?.port ?? '?'} 在听）` : `进程在，端口 ${remote.dsh?.port ?? '?'} 还没听`) : '没在运行',
    },
    {
      id: 'napcat', name: 'NapCat',
      state: napRunning ? (portUpFor(remote, napcatPort, 'napcat') === false ? 'starting' : 'ready') : 'down',
      detail: napRunning ? (portUpFor(remote, napcatPort, 'napcat') === false ? '进程在，界面端口还没通' : '已就绪') : '没在运行',
    },
    {
      id: 'bridge', name: '桥',
      state: brUp ? (brPort ? 'ready' : 'starting') : 'down',
      detail: brUp ? (brPort ? `已就绪（${remote.bridge?.pids?.length ?? 0} 个进程）` : '进程在，控制台端口还没通') : '没在运行',
    },
  ];
  const ready = components.every((c) => c.state === 'ready');
  const down = components.every((c) => c.state === 'down');
  const starting = !ready && !down;
  const bad = components.filter((c) => c.state !== 'ready');
  const note = ready
    ? '服务端已就绪'
    : (starting
      ? '服务端启动中：' + bad.map((c) => `${c.name}${c.state === 'starting' ? '启动中' : '未运行'}`).join(' · ')
      : '服务端整套都没在运行（点「一键启动整套」）');
  return { ready, down, starting, components, note };
}

/**
 * 组件明细 → 状态机该怎么写（纯函数，remote / observe 共用；两者只差"就绪那一步落在哪"）。
 *
 * 2026-10-01 主人反馈「状态机不对」：线上实测的连接状态是 SSH/隧道都通、DSH ready、NapCat ready、
 * **桥 down** —— 而旧代码把这三种局面一律写成 server-starting，于是界面一直显示
 * 「服务端连接中 · 服务端组件启动中」：既不真（没有任何东西在启动），又把每个组件自己的
 * 「运行中 / 未运行」小字整段盖掉（卡片中间态文案优先于服务端状态，见 Home.tsx 的渲染顺序）。
 * 现在按"到底有没有东西在起"分开：
 *   · 有组件 state=starting（进程在、端口还没听）→ 真的是启动中 → server-starting；
 *   · 其余（全都没跑 / 有的在跑有的停了）→ partial：**连接是成功的**，只是组件没起来，
 *     如实说明谁没在运行，并把卡片小字交回各组件自己的状态；
 *   · 没读到明细（components 为空）→ null：调用方保持原状，什么结论都不下。
 * @returns {{phase:'server-starting'|'partial', note:string}|null}
 */
export function verdictOf(d) {
  if (!d || !d.components || !d.components.length) return null;
  if (d.components.some((c) => c.state === 'starting')) return { phase: 'server-starting', note: d.note };
  const downNames = d.components.filter((c) => c.state === 'down').map((c) => c.name);
  const note = d.down
    ? '服务端整套都没在运行（点「一键启动整套」）'
    : `服务端已连接，但 ${downNames.join(' / ')} 没在运行（点该卡片的「启动服务端」）`;
  return { phase: 'partial', note };
}

/**
 * 连接状态机。`set()` 只在阶段/文案真的变了时才更新时间戳，方便界面做"卡在这一步多久了"的显示。
 * @param {{now?:() => number, log?: (msg: string) => void}} [opts]
 */
export function createConnectMachine(opts = {}) {
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? (() => {});
  let state = {
    phase: 'idle',
    note: '未连接',
    serverId: '', serverName: '',
    components: [],
    attempts: 0,
    lastError: '',
    since: now(),
    updatedAt: now(),
    warm: { done: false, at: 0, note: '' },
  };

  function snapshot() { return { ...state, components: state.components.map((c) => ({ ...c })), warm: { ...state.warm }, now: now() }; }

  /** 更新状态；同阶段只改文案时不动 since（界面上的"已用时"才有意义）。 */
  function set(patch = {}, reason = '') {
    const next = { ...state, ...patch };
    if (next.phase !== state.phase) next.since = now();
    next.updatedAt = now();
    const changed = next.phase !== state.phase || next.note !== state.note || next.lastError !== state.lastError;
    state = next;
    if (changed) log(`[connect] ${state.phase}${state.serverName ? ' · ' + state.serverName : ''} — ${state.note}${reason ? '（' + reason + '）' : ''}`);
    return snapshot();
  }

  return {
    /** 开始连接（用户点「连接」或开机自动连接）。 */
    begin(server, reason = '') {
      state.attempts = state.serverId === (server?.id ?? '') ? state.attempts + 1 : 1;
      return set({ serverId: server?.id ?? '', serverName: server?.name || server?.host || '', phase: 'connecting', note: '正在连接服务器…', components: [], lastError: '', warm: { done: false, at: 0, note: '' } }, reason);
    },
    /** SSH 已建立、隧道建立结果回来了。 */
    tunnels(created = [], reason = '') {
      const okCount = (created || []).filter((x) => x?.ok).length;
      const total = (created || []).length;
      return set({ phase: 'tunnels', note: total ? `隧道已建立 ${okCount}/${total} 条` : '隧道已就绪' }, reason);
    },
    /** 服务端组件状态（连接循环里每次轮询都调，文案跟着变）。 */
    remote(remote, reason = '') {
      const d = describeRemoteStatus(remote, { napcatWebuiPort: opts.napcatWebuiPort });
      if (d.ready) return set({ phase: 'warming', note: '服务端已就绪，正在静默完成 NapCat 界面鉴权…', components: d.components }, reason);
      const v = verdictOf(d);
      /* 状态还没取到（首轮未回 / 取状态失败）：既不能说"在启动"，也不能说"没在运行" ——
       * 保持中间态那一档并如实写"还没取到"，同时**不动**上一轮已知的组件明细（它还是界面的兜底依据）。 */
      if (!v) return set({ phase: 'server-starting', note: d.note || '正在读取服务端组件状态…' }, reason);
      return set({ phase: v.phase, note: v.note, components: d.components }, reason);
    },
    /**
     * 被动观测：由 /api/state 的轮询顺手喂进来（连接循环之外）。
     *
     * 2026-10-01「状态机不对」的另一半根因：状态机原先只在 waitServerReady 那 150 秒里被推进，
     * 循环一结束就再没人更新它 —— 于是"桥停了""桥后来起来了"这类变化界面永远看不到，
     * 一直停在最后一帧「服务端组件启动中」。这里只在"连接已经完成"之后接管（idle/connecting/tunnels
     * 阶段一律不插嘴），且就绪直接落 ready：连接循环之外没有"静默预鉴权"那一步，不能停在 warming。
     */
    observe(remote, reason = '') {
      const cur = state.phase;
      if (cur === 'idle' || cur === 'connecting' || cur === 'tunnels') return snapshot();
      const d = describeRemoteStatus(remote, { napcatWebuiPort: opts.napcatWebuiPort });
      if (!d.components.length) return snapshot();                       // 没读到：什么都不改（别把结论说小）
      if (d.ready) return set({ phase: 'ready', note: '服务端已就绪', components: d.components }, reason);
      const v = verdictOf(d);
      if (!v) return snapshot();
      return set({ phase: v.phase, note: v.note, components: d.components }, reason);
    },
    /** 静默预鉴权结果（一次性；成功/限流/失败都如实记）。 */
    warmed(result, reason = '') {
      const note = result?.ok ? 'NapCat 界面鉴权已静默完成（点开即用，不会再重复鉴权）' : `NapCat 界面预鉴权没成功：${result?.note ?? '未知原因'}`;
      return set({ phase: 'ready', note, warm: { done: result?.ok === true, at: now(), note: result?.note ?? '' } }, reason);
    },
    /** 就绪（本地这套或服务端那套都走这里收尾）。 */
    ready(note = '已就绪', reason = '') { return set({ phase: 'ready', note }, reason); },
    /** 失败：人话原因 + 交给调用方安排重试。 */
    fail(err, reason = '') {
      const msg = String(err?.message ?? err ?? '未知错误');
      return set({ phase: 'failed', note: '连接失败：' + msg, lastError: msg }, reason);
    },
    idle(note = '未连接', reason = '') { return set({ phase: 'idle', note, components: [] }, reason); },
    get: snapshot,
    /** 给界面用的轻量视图（不含 now/updatedAt 之外的东西，字段名稳定）。 */
    view() {
      const s = snapshot();
      return {
        phase: s.phase, note: s.note, serverId: s.serverId, serverName: s.serverName,
        components: s.components, attempts: s.attempts, lastError: s.lastError,
        since: s.since, updatedAt: s.updatedAt, elapsedMs: Math.max(0, s.now - s.since), warm: s.warm,
      };
    },
  };
}
