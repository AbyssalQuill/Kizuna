import { useEffect, useRef, useState } from 'react';
import { instanceAction, startAllInstances, remoteStackById, sshServiceAction } from '../api';
import { pendingConnect, activeScopeInfo } from '../config-cache';
import { readCacheValue, writeCacheValue } from '../lib/read-cache';
import { warmInstancePage } from './InstanceConfig';
import { warmBridgePage } from './BridgeConfig';
import type { ManagerState, LocalInstance } from '../stores/types';
import {
  Settings, Loader2, BookOpen, X, RotateCw, Square, AlertTriangle,
  Cpu, Sparkles, Activity, Radio, ExternalLink, Zap,
  CheckCircle2, Terminal, RefreshCw
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
    return inst.kind === 'bridge' ? '核心运行中' : '运行中 · 点击进入';
  }
  return '未启动';
}

const CONNECT_FOOT: Record<string, string> = {
  connecting: '服务端连接中 · 正在建立安全握手',
  tunnels: '服务端连接中 · 配置端口转发隧道',
  'server-starting': '服务端连接中 · 拉起云端组件',
  warming: '服务端连接中 · 会话鉴权中',
  partial: '服务端已连接 · 部分组件待就绪',
  failed: '服务端连接失败（自动重试中）',
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
        timer = setTimeout(() => { if (!cancelled) { setN(0); tick(1); } }, holdMs);
      } else {
        timer = setTimeout(() => tick(i + 1), speed);
      }
    };
    timer = setTimeout(() => tick(1), 500);
    return () => { cancelled = true; clearTimeout(timer); };
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
  const typed = useTypewriterLoop(SLOGAN);

  const inst = (id: SvcId) => state?.instances.find((i) => i.id === id);

  const warmedRef = useRef(new Set<string>());
  const warmTimerRef = useRef<number | null>(null);
  const cancelWarm = () => {
    if (warmTimerRef.current !== null) { window.clearTimeout(warmTimerRef.current); warmTimerRef.current = null; }
  };
  const warmEntry = (id: SvcId) => {
    if (warmedRef.current.has(id)) return;
    cancelWarm();
    warmTimerRef.current = window.setTimeout(() => {
      warmTimerRef.current = null;
      warmedRef.current.add(id);
      if (id === 'bridge-local') {
        const sv = state?.connected && state.activeServer ? state.activeServer : null;
        void warmBridgePage(sv ? { id: sv.id, name: sv.name } : null);
      } else void warmInstancePage(id);
    }, 120);
  };
  useEffect(() => () => cancelWarm(), []);

  const stateReady = !!state;

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

  const svcs: Array<{ id: SvcId; label: string; sub: string; openTitle: string; port: string; icon: any }> = [
    { id: 'napcat-local', label: 'NapCat 网关', sub: 'QQ 核心协议 · 消息与群管', openTitle: 'NapCat Web 界面', port: '3000 / 3001', icon: Radio },
    { id: 'dsh-isolated', label: 'DeepSeek 智能引擎', sub: 'DSH 运行时 · 思考与工具推理', openTitle: 'DeepSeek Harness', port: '10721', icon: Cpu },
    { id: 'bridge-local', label: 'Kizuna 交互桥', sub: '拟人记忆 · 语音表情 · 唤醒调度', openTitle: 'Kizuna 核心配置', port: '3100', icon: Sparkles },
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

  const runningCount = svcs.filter((t) => {
    const isRemote = serverMode;
    const remoteUp = sshConn ? serverUpOf(t.id) : null;
    const phase: Phase = isRemote ? (remoteUp ? 'running' : 'idle') : phaseOf(inst(t.id));
    return phase === 'running';
  }).length;
  const isFullyOnline = runningCount === 3;

  return (
    <div className="launcher nexus-theme">
      {/* 动态数字星云极光背景层 */}
      <div className="launcher-bg" aria-hidden="true">
        <i className="launcher-aurora a1" />
        <i className="launcher-aurora a2" />
        <i className="launcher-aurora a3" />
        <div className="nexus-grid-overlay" />
      </div>

      {/* 顶部现代化态势操控舱 (Top Cockpit Bar) */}
      <header className="nexus-cockpit">
        <div className="nexus-pill-group">
          <div className="nexus-pill">
            <span className={`status-dot ${sshConn ? 'online' : (serverMode ? 'loading' : 'local')}`} />
            <span className="nexus-pill-text">
              {sshConn ? `云端集群 · ${state?.activeServer?.name || '远程主机'}` : (serverMode ? '连接云端中…' : '本地单机引擎')}
            </span>
          </div>
          <div className="nexus-pill">
            <Activity size={12} className={isFullyOnline ? 'text-success' : 'text-muted'} />
            <span className="nexus-pill-text">
              {isFullyOnline ? '全链路健康在线' : `在线节点: ${runningCount}/3`}
            </span>
          </div>
        </div>

        <div className="nexus-top-actions">
          <button className="nexus-glass-btn" onClick={onOpenSSH} title="服务器与集群配置">
            <Terminal size={14} />
            <span>{sshConn ? '服务器设置' : '连接远程集群'}</span>
          </button>
          <button className="nexus-glass-btn" onClick={() => setTutorialOpen(true)} title="快速入门手册">
            <BookOpen size={14} />
            <span>入门向导</span>
          </button>
          <button className="nexus-glass-icon-btn" onClick={onRefresh} title="刷新全局状态">
            <RefreshCw size={14} />
          </button>
        </div>
      </header>

      {/* 警告通知区 */}
      {(state?.warnings?.length ?? 0) > 0 && (
        <div className="notice-bar nexus-notice" style={{ maxWidth: 860, margin: '0 auto 8px', textAlign: 'left' }}>
          {(state?.warnings ?? []).map((w, i) => <div key={i}>⚠️ {w}</div>)}
        </div>
      )}

      {sshConn && (() => {
        const rs: any = (state as any)?.remoteStatus;
        if (!rs) return null;
        const ups = [rs.dsh?.running, rs.napcat?.running, rs.bridge?.running].filter((x) => x !== undefined);
        if (!ups.length || ups.some(Boolean)) return null;
        return (
          <div className="notice-bar nexus-notice" style={{ maxWidth: 860, margin: '0 auto 8px', textAlign: 'left' }}>
            💡 已连接服务器，但服务端尚未启动各模块，点击下方「一键唤醒整套」即可开始运行。
          </div>
        );
      })()}

      {(state as any)?.dualNapcat && (
        <div className="notice-bar nexus-notice-danger" style={{ maxWidth: 860, margin: '0 auto 8px', textAlign: 'left' }}>
          🛑 本机与服务端的 NapCat 均在运行！同一 QQ 号双端登录会被互踢下线。请停用其中一端。
        </div>
      )}

      {/* 中心灵动视觉区：标语与全息拓扑链路 */}
      <section className="nexus-hero">
        <div className="nexus-brand-title">
          <h1 className="nexus-typewriter">{typed}</h1>
          <p className="nexus-slogan-sub">Kizuna Pro · 次世代拟人数字伴侣与自动化工作台</p>
        </div>

        {/* 核心服务交互拓扑链路 (Service Pipeline Flow) */}
        <div className="nexus-pipeline">
          {svcs.map((t, idx) => {
            const isRemote = serverMode;
            const remoteUp = sshConn ? serverUpOf(t.id) : null;
            const phase: Phase = isRemote ? (remoteUp ? 'running' : 'idle') : phaseOf(inst(t.id));
            const isUp = phase === 'running';
            const isWorking = phase === 'starting' || phase === 'stopping';
            return (
              <div key={t.id} className="nexus-node-wrap">
                <div className={`nexus-node ${isUp ? 'is-up' : isWorking ? 'is-busy' : 'is-down'}`}>
                  <t.icon size={15} />
                  <span>{t.label.split(' ')[0]}</span>
                  <span className={`nexus-mini-dot ${isUp ? 'online' : isWorking ? 'loading' : 'offline'}`} />
                </div>
                {idx < svcs.length - 1 && (
                  <div className={`nexus-flow-cable ${isUp ? 'active' : ''}`}>
                    <div className="cable-particle" />
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* 超感一键全量启停总控触发器 (Master Action Console) */}
        <div className="nexus-master-action">
          <button
            className={`btn nexus-master-btn ${isFullyOnline ? 'is-online' : ''}`}
            disabled={allBusy}
            onClick={actAll}
            data-genui-primary-action
          >
            <div className="master-btn-glow" />
            <div className="master-btn-content">
              {allBusy ? (
                <Loader2 size={18} className="spin" />
              ) : isFullyOnline ? (
                <CheckCircle2 size={18} className="text-online" />
              ) : (
                <Zap size={18} className="text-accent" />
              )}
              <span>
                {allBusy
                  ? '系统正在全量编排就绪中…'
                  : isFullyOnline
                  ? '服务全链路已在线 · 点击重置整套'
                  : (sshConn ? '一键唤醒云端全栈服务' : '一键启动整套（网关 → 大脑 → 核心桥）')}
              </span>
            </div>
          </button>
        </div>
      </section>

      {/* 服务矩阵卡片网络 (Service Matrix Cards) */}
      <section className="tiles nexus-matrix">
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
          const isUp = phase === 'running';

          return (
            <div
              className={`big-tile nexus-card ${isUp ? 'card-online' : ''}`}
              key={t.id}
              onMouseEnter={() => warmEntry(t.id)}
              onMouseLeave={cancelWarm}
            >
              <div className="nexus-card-header">
                <div className="nexus-card-icon-box">
                  <t.icon size={20} />
                </div>
                <div className="nexus-card-info">
                  <div className="nexus-card-title-row">
                    <span className="big-name">{t.label}</span>
                    <span className="nexus-port-badge">PORT {t.port}</span>
                  </div>
                  <span className="big-sub">{t.sub}</span>
                </div>
              </div>

              <div className="big-actions nexus-card-actions">
                {phase === 'starting' ? (
                  <button className="btn btn-primary btn-block nexus-action-btn" disabled>
                    <Loader2 size={16} className="spin" /> 正在拉起…
                  </button>
                ) : phase === 'stopping' ? (
                  <button className="btn btn-primary btn-block nexus-action-btn" disabled>
                    <Loader2 size={16} className="spin" /> 正在关闭…
                  </button>
                ) : phase === 'running' ? (
                  <>
                    <button className="btn btn-primary btn-block nexus-action-btn" onClick={handleOpen}>
                      <ExternalLink size={14} style={{ marginRight: 6 }} />
                      进入控制台
                    </button>
                    <button
                      className="icon-btn nexus-tool-btn"
                      disabled={busy === t.id}
                      onClick={restartAct}
                      title="平滑热重启"
                    >
                      {acting === `${t.id}:restart` ? <Loader2 size={15} className="spin" /> : <RotateCw size={15} />}
                    </button>
                    <button
                      className="icon-btn nexus-tool-btn"
                      disabled={busy === t.id}
                      onClick={stopAct}
                      title="停止服务"
                    >
                      {acting === `${t.id}:stop` ? <Loader2 size={15} className="spin" /> : <Square size={14} />}
                    </button>
                  </>
                ) : (
                  <button className="btn btn-primary btn-block nexus-action-btn" disabled={busy === t.id} onClick={startAct}>
                    {busy === t.id ? (
                      <><Loader2 size={16} className="spin" /> {isRemote ? '下发中…' : '拉起中…'}</>
                    ) : phase === 'failed' ? (
                      '异常重试'
                    ) : isRemote ? (
                      '启动服务端'
                    ) : (
                      '启动服务'
                    )}
                  </button>
                )}
                <button
                  className="icon-btn nexus-tool-btn"
                  onClick={() => onOpenConfig(t.id)}
                  onMouseEnter={() => warmEntry(t.id)}
                  onMouseLeave={cancelWarm}
                  title="高级配置"
                >
                  <Settings size={16} />
                </button>
              </div>

              <div className="big-foot nexus-card-foot">
                {connectBusy ? (
                  <>
                    <span className={`status-dot ${connectFailed ? 'offline' : 'loading'}`} />
                    {connectFailed ? <AlertTriangle size={12} /> : null}
                    <span>{connectFootText}</span>
                  </>
                ) : probe ? (
                  <>
                    <span className="status-dot loading" />
                    <span>{probe}</span>
                  </>
                ) : isRemote ? (
                  sshReconnecting ? (
                    <>
                      <span className="status-dot loading" />
                      <span>服务端重连中…</span>
                    </>
                  ) : !remoteUp && footErrText ? (
                    <>
                      <span className="status-dot offline" />
                      <AlertTriangle size={12} />
                      <span>{footErrText}</span>
                    </>
                  ) : remoteUpShown === null ? (
                    <>
                      <span className="status-dot loading" />
                      <span>正在同步状态…</span>
                    </>
                  ) : (
                    <>
                      <span className={`status-dot ${remoteUpShown ? 'online' : 'offline'}`} />
                      <span>{remoteUpShown ? '云端运行中 · 就绪' : '云端待命'}</span>
                    </>
                  )
                ) : (
                  <>
                    <span className={`status-dot ${dotClass(phase)}`} />
                    {footErrText ? <AlertTriangle size={12} /> : null}
                    <span>{footErrText || footText(i, phase)}</span>
                    {i?.proc?.pid ? <code>PID {i.proc.pid}</code> : null}
                  </>
                )}
              </div>
            </div>
          );
        })}
      </section>

      {/* 底部悬浮快捷坞 (Quick Dock) */}
      <footer className="nexus-dock">
        <span className="nexus-dock-copy">Kizuna v3.5.0 · Next-Gen Humanoid Agent Architecture</span>
      </footer>

      {/* 入门指引抽屉模态框 */}
      {tutorialOpen && (
        <div className="help-overlay" onClick={() => setTutorialOpen(false)}>
          <div className="help-panel nexus-modal" onClick={(e) => e.stopPropagation()}>
            <div className="help-panel-head">
              <span className="help-title">✨ Kizuna 快速上手指南</span>
              <button className="icon-btn" onClick={() => setTutorialOpen(false)}><X size={16} /></button>
            </div>
            <div className="help-panel-body" style={{ maxHeight: '72vh', overflowY: 'auto', paddingRight: 4 }}>
              <h4>1. 首次启动顺序</h4>
              <p>点击中央「一键启动整套」，系统将依次为您拉起：<strong>NapCat QQ 协议网关</strong> ➔ <strong>DeepSeek 智能引擎</strong> ➔ <strong>Kizuna 拟人交互桥</strong>。</p>
              <h4>2. QQ 扫码与登录</h4>
              <p>启动后点击 NapCat 卡片上的「进入控制台」，使用机器人 QQ 手机扫码确认登录即可建立连接。</p>
              <h4>3. 拟人人设与记忆</h4>
              <p>点击 Kizuna 交互桥卡片上的齿轮进入配置，可自由切换角色人设、发言规则、调整打字语气，或者配置语音合成与表情包库。</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
