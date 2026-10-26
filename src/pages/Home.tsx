import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { instanceAction, startAllInstances, remoteStackById, sshServiceAction } from '../api';
import { pendingConnect, activeScopeInfo } from '../config-cache';
import { readCacheValue, writeCacheValue } from '../lib/read-cache';
import { warmInstancePage } from './InstanceConfig';
import { warmBridgePage } from './BridgeConfig';
import type { ManagerState, LocalInstance } from '../stores/types';
import {
  Settings, Loader2, Rocket, BookOpen, X, RotateCw, Square, AlertTriangle,
  Radio, Cpu, Sparkles, Terminal
} from 'lucide-react';

interface HomeProps {
  state: ManagerState | null;
  onOpenSSH: () => void;
  onOpenConfig: (id: 'dsh-isolated' | 'napcat-local' | 'bridge-local') => void;
  onOpenWeb: (url: string, title: string) => void;
  onRefresh: () => void;
}

type Phase = 'idle' | 'starting' | 'running' | 'stopping' | 'failed';

function phaseOf(inst?: LocalInstance): Phase {
  if (!inst) return 'idle';
  const p = (inst.phase as Phase) || 'idle';
  if (p === 'running' && !inst.reachable && !inst.proc.running) return 'idle';
  return p;
}

const PHASE_TEXT: Record<Phase, string> = {
  idle: '未启动',
  starting: '启动中',
  running: '运行中',
  stopping: '停止中',
  failed: '启动失败',
};

function footText(inst: LocalInstance | undefined, phase: Phase): string {
  if (!inst) return PHASE_TEXT[phase];
  if (phase === 'starting') {
    const s = Math.max(0, Math.round((inst.elapsedMs || 0) / 1000));
    return `启动中 ${s}s${inst.note ? ' · ' + inst.note : ' · 等待就绪'}`;
  }
  if (phase === 'stopping') return '停止中…';
  if (phase === 'failed') return `启动失败：${(inst.error || '见日志').slice(0, 60)}`;
  if (phase === 'running') {
    if (inst.kind === 'napcat' && !inst.loggedIn) return '已启动 · 等待 QQ 扫码登录';
    return inst.kind === 'bridge' ? '运行中' : '运行中 · 点击打开';
  }
  return '未启动';
}

function dotClass(phase: Phase): string {
  if (phase === 'running') return 'online';
  if (phase === 'starting' || phase === 'stopping') return 'loading';
  return 'offline';
}

const CONNECT_FOOT: Record<string, string> = {
  connecting: '服务端连接中 · 正在连接服务器',
  tunnels: '服务端连接中 · 建立隧道',
  'server-starting': '服务端连接中 · 服务端组件启动中',
  warming: '服务端连接中 · 界面鉴权',
  partial: '服务端已连接 · 部分组件没在运行',
  failed: '服务端连接失败（会自动重试）',
};

function stepOwner(key: string): string {
  const s = String(key || '').toLowerCase();
  if (s.includes('bridge') || s.includes('桥')) return 'bridge-local';
  if (s.includes('napcat')) return 'napcat-local';
  if (s.includes('dsh')) return 'dsh-isolated';
  return '*';
}

const SLOGAN = 'Made a character, kept a friend.';

function useTypewriterLoop(text: string, speed = 100, holdMs = 3600) {
  const [n, setN] = useState(0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let cancelled = false;
    const tick = (i: number) => {
      if (cancelled) return;
      setN(i);
      if (i >= text.length) {
        timer = setTimeout(() => {
          if (!cancelled) {
            setN(0);
            tick(1);
          }
        }, holdMs);
      } else {
        timer = setTimeout(() => tick(i + 1), speed);
      }
    };
    timer = setTimeout(() => tick(1), 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [text, speed, holdMs]);
  return text.slice(0, n);
}

type SvcId = 'dsh-isolated' | 'napcat-local' | 'bridge-local';

export default function Home({ state, onOpenSSH, onOpenConfig, onOpenWeb, onRefresh }: HomeProps) {
  const [busy, setBusy] = useState<SvcId | null>(null);
  const [acting, setActing] = useState<string | null>(null);
  const [allBusy, setAllBusy] = useState(false);
  const [footErr, setFootErr] = useState<Record<string, string>>({});
  const [tutorialOpen, setTutorialOpen] = useState(false);

  const warmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const warmEntry = (id: SvcId) => {
    if (warmTimer.current) clearTimeout(warmTimer.current);
    warmTimer.current = setTimeout(() => {
      if (id === 'bridge-local') {
        warmBridgePage();
      } else {
        warmInstancePage(id);
      }
    }, 120);
  };
  const cancelWarm = () => {
    if (warmTimer.current) {
      clearTimeout(warmTimer.current);
      warmTimer.current = null;
    }
  };

  const typed = useTypewriterLoop(SLOGAN, 90, 4200);

  const inst = (id: SvcId) => (state?.instances ?? []).find((x) => x.id === id);

  const doAction = async (id: SvcId, action: 'start' | 'stop' | 'restart') => {
    const label = action === 'start' ? '启动' : action === 'stop' ? '停止' : '重启';
    setBusy(id); setActing(`${id}:${action}`); setFootErr({});
    try {
      const r = await instanceAction(id, action);
      if (r.success === false) setFootErr({ [id]: `${label}未成功：${(r.message || '见日志').slice(0, 80)}` });
    } catch { setFootErr({ [id]: `${label}失败：无法连接后端` }); }
    finally { setBusy(null); setActing(null); onRefresh(); }
  };

  const act = (id: SvcId) => doAction(id, 'start');
  const actStop = (id: SvcId) => doAction(id, 'stop');
  const actRestart = (id: SvcId) => doAction(id, 'restart');

  const stateReady = !!state;
  const bootRemote = !stateReady && activeScopeInfo().scope.startsWith('remote');
  const serverMode = !!state?.activeServer || bootRemote;
  const remoteId = state?.activeServer?.id ?? null;
  const remoteCompOf = (id: SvcId): 'dsh' | 'napcat' | 'bridge' =>
    (id === 'napcat-local' ? 'napcat' : id === 'dsh-isolated' ? 'dsh' : 'bridge');
  const remoteSvcIdOf = (id: SvcId): string =>
    (id === 'napcat-local' ? 'srv-napcat-webui' : id === 'dsh-isolated' ? 'srv-dsh-web' : 'srv-bridge');
  const remoteServiceOf = (id: SvcId) => (state?.services ?? []).find((s) => s.id === remoteSvcIdOf(id));

  const doRemoteAction = async (id: SvcId, action: 'start' | 'stop' | 'restart') => {
    if (!remoteId) return;
    const label = action === 'start' ? '启动' : action === 'stop' ? '停止' : '重启';
    if (!sshConn) { setFootErr({ [id]: '服务端正在重连，请稍候数秒再操作（不会操作本机实例）' }); return; }
    setBusy(id); setActing(`${id}:${action}`); setFootErr({});
    try {
      const r = await sshServiceAction(remoteId, remoteCompOf(id), action);
      if (r.ok !== true) setFootErr({ [id]: `${label}服务端未成功：${(r.message || '见日志').slice(0, 80)}` });
    } catch { setFootErr({ [id]: `${label}服务端失败：无法连接后端` }); }
    finally { setBusy(null); setActing(null); onRefresh(); }
  };

  const actAll = async () => {
    setAllBusy(true); setFootErr({});
    try {
      if (remoteId && state?.activeServer) {
        const r = await remoteStackById(remoteId, 'start');
        const bad = (r.steps ?? []).filter((s) => !s.ok);
        if (r.success !== true || bad.length) {
          const list = bad.length ? bad : [{ step: '', msg: r.message || '' }];
          const next: Record<string, string> = {};
          for (const s of list) {
            next[stepOwner(s.step)] = `整套启动未完成：${s.step ? s.step + ' · ' : ''}${String(s.msg || r.message || '见日志').split('\n')[0].slice(0, 80)}`;
          }
          setFootErr(next);
        }
        return;
      }
      const r = await startAllInstances();
      if (r.success === false) {
        const bad = (r.steps ?? []).filter((s) => s.success === false);
        const next: Record<string, string> = {};
        if (bad.length) for (const s of bad) next[stepOwner(s.id)] = `启动失败：${(s.error || s.message || '见日志').slice(0, 80)}`;
        else next['*'] = `整套启动未完成：${(r.message || '见日志').slice(0, 80)}`;
        setFootErr(next);
      }
    } catch { setFootErr({ '*': '一键启动失败：无法连接后端' }); }
    finally { setAllBusy(false); onRefresh(); }
  };

  const svcs: Array<{
    id: SvcId;
    label: string;
    sub: string;
    openTitle: string;
    icon: ReactNode;
    defaultPort: string;
  }> = [
    {
      id: 'napcat-local',
      label: 'NapCat',
      sub: 'QQ 网关 · 消息通道',
      openTitle: 'NapCat 官方界面',
      icon: <Radio size={19} />,
      defaultPort: 'PORT 3000/3001',
    },
    {
      id: 'dsh-isolated',
      label: 'DeepSeek Harness',
      sub: '内置模型服务 · 独立端口',
      openTitle: 'DeepSeek Harness',
      icon: <Cpu size={19} />,
      defaultPort: 'PORT 10721',
    },
    {
      id: 'bridge-local',
      label: 'Core',
      sub: '内置核心层 · 智能人设',
      openTitle: '功能配置',
      icon: <Sparkles size={19} />,
      defaultPort: 'PORT 3100',
    },
  ];

  const sshConn = state?.connected;
  const sshReconnecting = !!state?.reconnecting;

  const serverUpOf = (id: SvcId): boolean | null => {
    if (!sshConn) return null;
    const rs: any = (state as any)?.remoteStatus;
    const key: 'dsh' | 'napcat' | 'bridge' = remoteCompOf(id);
    if (rs && rs.ok !== false && rs[key]) return !!rs[key].running;
    const comp = ((state as any)?.connect?.components ?? []).find((c: any) => c?.id === key);
    if (comp?.state === 'ready') return true;
    if (comp?.state === 'down') return false;
    return null;
  };

  useEffect(() => {
    for (const id of ['napcat-local', 'dsh-isolated', 'bridge-local'] as SvcId[]) {
      const up = serverUpOf(id);
      if (up !== null) writeCacheValue('home:remote:' + id, up);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const connPhase = state?.connect?.phase ?? 'idle';
  const connectBusy = connPhase !== 'idle' && connPhase !== 'ready' && connPhase !== 'partial';
  const connectFailed = connPhase === 'failed';
  const probe = pendingConnect(state);
  const connectFootText = CONNECT_FOOT[connPhase] || `服务端连接中 · ${connPhase}`;

  const getPortLabel = (id: SvcId, defaultPort: string, isRemote: boolean) => {
    if (isRemote) {
      if (id === 'napcat-local') return 'PORT 13000/13001';
      if (id === 'dsh-isolated') return 'PORT 13080';
      if (id === 'bridge-local') return 'PORT 13100';
    }
    const target = inst(id);
    if (target?.url) {
      try {
        const p = new URL(target.url).port;
        if (p) return `PORT ${p}`;
      } catch {}
    }
    return defaultPort;
  };

  return (
    <div className="launcher">
      {/* 首页柔美氛围背景 */}
      <div className="launcher-bg" aria-hidden="true">
        <i className="launcher-aurora a1" />
        <i className="launcher-aurora a2" />
        <i className="launcher-aurora a3" />
      </div>

      <div className="launcher-title">
        <div className="typewriter">{typed}</div>
        <div className="launcher-tag">Kizuna · 一键配置本地和服务器的拟人 QQ Bot</div>
      </div>

      {/* 新手教程按钮 */}
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 8 }}>
        <button className="btn btn-primary tutorial-btn" onClick={() => setTutorialOpen(true)}>
          <BookOpen size={14} style={{ verticalAlign: -2, marginRight: 6 }} /> 新手教程
        </button>
      </div>

      {/* 安装位置与环境提示 */}
      {(state?.warnings?.length ?? 0) > 0 && (
        <div className="notice-bar" style={{ maxWidth: 720, margin: '0 auto 12px', textAlign: 'left' }}>
          {(state?.warnings ?? []).map((w, i) => <div key={i}>注意 {w}</div>)}
        </div>
      )}

      {/* 服务端组件未启动提示 */}
      {sshConn && (() => {
        const rs: any = (state as any)?.remoteStatus;
        if (!rs) return null;
        const ups = [rs.dsh?.running, rs.napcat?.running, rs.bridge?.running].filter((x) => x !== undefined);
        if (!ups.length || ups.some(Boolean)) return null;
        return (
          <div className="notice-bar" style={{ maxWidth: 720, margin: '0 auto 12px', textAlign: 'left' }}>
            注意 已连接服务器，但服务端整套尚未运行（DSH / NapCat / 桥）。可点下方「一键启动整套」，或在对应卡片上点「启动服务端」。
          </div>
        );
      })()}

      {/* 单点登录互斥提示 */}
      {(state as any)?.dualNapcat && (
        <div className="notice-bar" style={{ maxWidth: 720, margin: '0 auto 12px', textAlign: 'left', borderColor: '#e5484d', color: '#b42318', background: '#fff5f5' }}>
          注意 本机与服务端的 NapCat 均在运行。同一 QQ 号在两处登录会被腾讯判为「已在另一台终端登录」，双方相互踢下线。
          请仅保留一处：点上方「一键启动整套（服务端）」（管理器会先停止本机那份），或到服务端卡片点「停止」。
        </div>
      )}

      {/* 一键启动整套按钮 */}
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
        <button
          className="btn btn-primary"
          style={{ padding: '8px 26px', fontSize: 15, borderRadius: 12 }}
          disabled={allBusy}
          onClick={actAll}
          data-genui-primary-action
        >
          {allBusy ? <Loader2 size={16} className="spin" style={{ verticalAlign: -2, marginRight: 8 }} /> : <Rocket size={16} style={{ verticalAlign: -2, marginRight: 8 }} />}
          {allBusy ? '正在一键启动整套…' : (sshConn ? '一键启动整套（服务端）' : '一键启动整套（NapCat → DSH → 桥）')}
        </button>
      </div>

      {/* 2×2 清爽经典卡片网格，融入服务器卡片图标与端口标识 */}
      <div className="tiles grid2x2">
        {svcs.map((t) => {
          const i = inst(t.id);
          const remoteUp = sshConn ? serverUpOf(t.id) : null;
          const remoteUpShown: boolean | null = remoteUp !== null
            ? remoteUp
            : (readCacheValue<boolean>('home:remote:' + t.id)?.value ?? null);
          const isRemote = serverMode;
          const phase: Phase = isRemote ? (remoteUp ? 'running' : 'idle') : phaseOf(i);
          const startAct = () => (isRemote ? doRemoteAction(t.id, 'start') : act(t.id));
          const stopAct = () => (isRemote ? doRemoteAction(t.id, 'stop') : actStop(t.id));
          const restartAct = () => (isRemote ? doRemoteAction(t.id, 'restart') : actRestart(t.id));

          const handleOpen = () => {
            if (t.id === 'bridge-local') { onOpenConfig('bridge-local'); return; }
            if (isRemote) {
              const svc = remoteServiceOf(t.id);
              if (svc?.url) onOpenWeb(svc.url, t.openTitle);
              return;
            }
            if (i?.url) onOpenWeb(i.url, t.openTitle);
          };

          const footErrText = footErr[t.id] || footErr['*'] || '';
          const portText = getPortLabel(t.id, t.defaultPort, isRemote);

          return (
            <div
              className="big-tile"
              key={t.id}
              onMouseEnter={() => warmEntry(t.id)}
              onMouseLeave={cancelWarm}
            >
              <div className="big-tile-head">
                <div className="big-tile-title-row">
                  <div className="big-tile-icon-box">
                    {t.icon}
                  </div>
                  <div className="big-tile-title-meta">
                    <div className="big-tile-name-line">
                      <span className="big-name">{t.label}</span>
                      <span className="big-tile-port">{portText}</span>
                    </div>
                    <span className="big-sub">{t.sub}</span>
                  </div>
                </div>
              </div>

              <div className="big-actions">
                {phase === 'starting' ? (
                  <button className="btn btn-primary btn-block" disabled>
                    <Loader2 size={16} className="spin" /> 启动中…
                  </button>
                ) : phase === 'stopping' ? (
                  <button className="btn btn-primary btn-block" disabled>
                    <Loader2 size={16} className="spin" /> 停止中…
                  </button>
                ) : phase === 'running' ? (
                  <>
                    <button className="btn btn-primary btn-block" onClick={handleOpen}>打开</button>
                    <button
                      className="icon-btn"
                      disabled={busy === t.id}
                      onClick={restartAct}
                      title="重启"
                    >
                      {acting === `${t.id}:restart` ? <Loader2 size={16} className="spin" /> : <RotateCw size={16} />}
                    </button>
                    <button
                      className="icon-btn"
                      disabled={busy === t.id}
                      onClick={stopAct}
                      title="停止"
                    >
                      {acting === `${t.id}:stop` ? <Loader2 size={16} className="spin" /> : <Square size={15} />}
                    </button>
                  </>
                ) : (
                  <button className="btn btn-primary btn-block" disabled={busy === t.id} onClick={startAct}>
                    {busy === t.id ? (
                      <><Loader2 size={16} className="spin" /> {isRemote ? '下发中…' : '启动中…'}</>
                    ) : phase === 'failed' ? (
                      '重试启动'
                    ) : (
                      isRemote ? '启动服务端' : '启动'
                    )}
                  </button>
                )}
                <button
                  className="icon-btn"
                  onClick={() => onOpenConfig(t.id)}
                  title="配置"
                >
                  <Settings size={16} />
                </button>
              </div>

              <div className="big-foot">
                {footErrText ? (
                  <>
                    <span className="status-dot offline" />
                    <span className="status-label" style={{ color: 'var(--nc-primary-600, #e5484d)' }}>{footErrText}</span>
                  </>
                ) : isRemote ? (
                  <>
                    <span className={`status-dot ${
                      connectBusy
                        ? 'loading'
                        : remoteUpShown === true
                        ? 'online'
                        : remoteUpShown === false
                        ? 'offline'
                        : 'loading'
                    }`} />
                    <span className="status-label">
                      {connectBusy
                        ? connectFootText
                        : remoteUpShown === true
                        ? '服务端运行中'
                        : remoteUpShown === false
                        ? (connectFailed ? '服务端连接失败（会自动重试）' : '服务端未运行')
                        : '正在读取服务端状态…'}
                    </span>
                  </>
                ) : (
                  <>
                    <span className={`status-dot ${dotClass(phase)}`} />
                    <span className="status-label">{footText(i, phase)}</span>
                  </>
                )}
              </div>
            </div>
          );
        })}

        {/* 第 4 张卡片：SSH 远程服务器卡片 */}
        <div className="big-tile ssh-tile">
          <div className="big-tile-head">
            <div className="big-tile-title-row">
              <div className="big-tile-icon-box" style={{
                background: sshConn ? 'hsl(150 90% 96%)' : undefined,
                color: sshConn ? 'hsl(150 70% 36%)' : undefined,
                borderColor: sshConn ? 'hsl(150 60% 85%)' : undefined
              }}>
                <Terminal size={19} />
              </div>
              <div className="big-tile-title-meta">
                <div className="big-tile-name-line">
                  <span className="big-name">SSH 配置</span>
                  <span className="big-tile-port">{sshConn ? (state?.activeServer?.host ? `${state.activeServer.host}:22` : 'PORT 22 · 已连') : 'PORT 22'}</span>
                </div>
                <span className="big-sub">远程服务器 · 隧道配置</span>
              </div>
            </div>
          </div>
          <div className="big-actions">
            <button className="btn btn-soft btn-block" onClick={onOpenSSH}>进入</button>
          </div>
          <div className="big-foot">
            <span className={`status-dot ${sshConn ? 'online' : (sshReconnecting || probe) ? 'loading' : 'offline'}`} />
            <span className="status-label">
              {sshConn
                ? `已连接 ${state?.activeServer?.name || ''}`
                : sshReconnecting
                ? '服务端重连中…'
                : probe
                ? (probe.serverName ? `正在连接 ${probe.serverName}…` : '正在连接服务端…')
                : '未连接远程'}
            </span>
          </div>
        </div>
      </div>

      <div className="launcher-footer">
        版本 v3.5.0 · 按 Esc 或顶部「Kizuna」随时返回首页
      </div>

      {/* 新手教程弹窗模态框 */}
      {tutorialOpen && (
        <div className="modal-mask" onClick={() => setTutorialOpen(false)}>
          <div className="modal help-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 680, maxHeight: '82vh' }}>
            <div className="modal-head">
              <span className="modal-title">新手使用教程</span>
              <button className="icon-btn" onClick={() => setTutorialOpen(false)} title="关闭"><X size={16} /></button>
            </div>
            <div className="modal-body tutorial-body">
              <TutorialSection title="① 两种运行模式：本机 或 服务器">
                <p>
                  Kizuna 支持 <b>完全在本机跑</b>，也支持 <b>连远程 Linux 服务器跑</b>（腾讯云 / 阿里云 / 物理机均可）：
                </p>
                <ul>
                  <li><b>本机运行</b>：直接点下方的 NapCat、DeepSeek Harness、Core 即可，数据与模型全在你自己电脑上；</li>
                  <li><b>服务器运行</b>：点击右下角 <b>SSH 配置</b> 连接服务器，连上后首页的所有卡片与一键启动都会<b>自动无缝切换为操作服务器</b>，并经安全隧道映射网页，无须手动敲任何 Linux 命令。</li>
                </ul>
              </TutorialSection>
              <TutorialSection title="② 本机快速起步（三步拉起）">
                <ol>
                  <li>先点 <b>NapCat</b> 卡「启动」：首次启动会弹出登录二维码，用小号 QQ 扫码授权登录。</li>
                  <li>再启动 <b>DeepSeek Harness</b>（内置模型服务），等待状态变为「运行中」。</li>
                  <li>最后启动 <b>Core</b>（内置核心层）：由它判断该不该回应、组装提示词与工具调用，再把 QQ 消息转交 DSH 处理。</li>
                  <li>亦可直接点上方 <b>「一键启动整套」</b>，程序按 NapCat → DSH → Core 的顺序自动拉起（NapCat 首次仍需扫码）。</li>
                </ol>
              </TutorialSection>
              <TutorialSection title="③ SSH 远程服务器配置">
                <ol>
                  <li>在首页点 <b>SSH 配置</b> 卡 → 「添加服务器」，填写名称、主机 IP、端口、用户名（如 <code>root</code>）、密码或密钥，随后点「测试」，通过后点「连接」。</li>
                  <li><b>连上之后，首页那三张卡即代表服务器那套</b>：状态行显示 <b>服务端运行中 / 服务端未运行</b>，「启动 / 重启 / 停止」直接操作服务器上的对应服务（各按那台机器自己的托管方式，界面不假设用什么命令），「一键启动整套」亦为拉起服务器上的整套。未连接服务器时，这些按钮仍操作本机实例。</li>
                  <li><b>打开界面</b>：NapCat / DeepSeek Harness 卡点「打开」，经隧道打开<b>服务器上</b>的界面（自动携带该机的访问令牌），可在应用内直接查看。隧道映射：NapCat WebUI 6099→13000、NapCat HTTP 3000→13001、DSH 3080→13080、桥控制台 3100→13100（桥控制台设有安全响应头，只能「新窗口打开」）。</li>
                  <li><b>修改服务器上的核心层配置</b>：连上服务器时，功能配置页读写的是<b>服务器上的那份核心层配置</b>（页首有醒目横幅）。保存流程为：先就地备份（备份文件名带时间戳）→ 原子替换 → 回读比对关键字段；桥会热加载，故<b>不必重启桥即可生效</b>；人设与发言规则亦可一并写入服务端。</li>
                  <li><b>用量按两侧分别统计</b>：「学习与用量」页同时给出 <b>本机 / 服务端 / 合计</b>；服务器未连接时只显示本机那份，并注明原因。</li>
                  <li><b>关于失败与冷却</b>：连续测试失败会短暂冷却（<b>连不上 / 超时类：20 秒 → 40 秒 → 60 秒</b>；<b>凭据类仅停 10 秒</b>），提示中写明具体的报错内容，并提供「仍然重试一次」按钮以跳过冷却。<b>但不可反复点击测试</b>：服务器上的安全防护软件只统计认证失败次数，点击过多会把本机 IP 整机封禁（届时正确密码亦无法连接，表现为连接超时）——若已被封禁，需由服务器管理员解除对本机 IP 的封禁，或等待封禁自动过期后再试。</li>
                  <li>每台服务器行另设「同步」（将本地桥代码推送至服务器）与「清整套」（删除远端整套并备份）按钮。</li>
                </ol>
              </TutorialSection>
              <TutorialSection title="④ 常用设置入口">
                <ul>
                  <li><b>NapCat / DeepSeek Harness / Core</b> 三张卡右下角齿轮为各自的启动配置；<b>Core 卡</b>点开后直接进入「功能配置」页。</li>
                  <li>功能配置页含：<b>常用设置</b>（模型 / 连接 / 白名单 / 主动闲聊）、<b>工具与规则</b>（MCP 工具开关）、<b>人设与发言规则</b>（可上传 .md 或从角色库导入）、<b>JSON 进阶</b>。</li>
                  <li>Core 运行后，右上角「群友画像 / 学习与用量」需经过一段时间的交流才会逐渐产生数据。</li>
                </ul>
              </TutorialSection>
              <TutorialSection title="⑤ 端口一览与返回方式">
                <p style={{ margin: 0 }}>
                  所有端口：管理端 1921 · NapCat 6099/3000/3001 · 隔离 DSH {instPortOf(state, 'dsh-isolated')} · Core {instPortOf(state, 'bridge-local')}。任一页按 <b>Esc</b> 返回首页。
                </p>
              </TutorialSection>
            </div>
            <div className="help-foot">
              <button className="btn btn-sm" onClick={() => setTutorialOpen(false)}>已阅读，开始配置</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TutorialSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="tutorial-sec">
      <div className="tutorial-sec-title">{title}</div>
      <div className="tutorial-sec-body">{children}</div>
    </div>
  );
}

function instPortOf(state: ManagerState | null, id: string): string {
  const i = state?.instances?.find((x) => x.id === id);
  if (!i) return '—';
  try { return new URL(i.url || '').port || '—'; } catch { return '—'; }
}
