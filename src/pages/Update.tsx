import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CSSProperties } from 'react';
import {
  AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, Download, FileDiff,
  GitBranch, Loader2, RefreshCw, Terminal, X,
} from 'lucide-react';
import {
  updateApply, updateCheck, updatePlan, updateStatus,
} from '../api';
import type {
  UpdateFileAction, UpdateJob, UpdateLastResult, UpdatePlanEntry, UpdatePlanResult, UpdateStatus,
} from '../api';

/** onBack：弹窗形态下就是"关闭"（点遮罩/关闭按钮/ESC 都走它）；modal：小弹窗形态，不再占整页高度 */
interface Props { onBack: () => void; modal?: boolean; }

/** 老版本管理器没有 /api/update/*：拿到 404 时用这句降级，不把整页打崩。 */
const UNSUPPORTED_TEXT = '当前管理器版本不含更新接口';

/** status 还没回来或后端少给 job 时用它，页面无需到处判空。 */
const EMPTY_JOB: UpdateJob = {
  phase: 'idle', step: '', percent: 0, message: '', startedAt: null, finishedAt: null, log: [],
};

const PHASE_TEXT: Record<string, string> = {
  idle: '空闲',
  checking: '检查中',
  preparing: '准备中',
  planning: '比对文件',
  applying: '写入文件',
  building: '重建前端',
  done: '已完成',
  error: '失败',
};

const ACTION_TEXT: Record<string, string> = {
  add: '新增', update: '更新', conflict: '冲突', delete: '删除', kept: '保留',
};

const META_LINE: CSSProperties = {
  marginTop: 6, fontSize: 12.5, color: 'var(--nc-foreground-500)', lineHeight: 1.7, wordBreak: 'break-word',
};
const SHA_CODE: CSSProperties = { fontSize: 15, fontWeight: 700, padding: '2px 8px' };
const TH: CSSProperties = {
  padding: '8px 10px', textAlign: 'left', fontWeight: 600, fontSize: 12,
  color: 'var(--nc-foreground-500)', borderBottom: '1px solid var(--nc-border)',
  background: 'var(--nc-bg)', position: 'sticky', top: 0,
};
const TD: CSSProperties = {
  padding: '8px 10px', borderBottom: '1px solid var(--nc-border)', verticalAlign: 'top',
};

/** idle 是没任务，done/error 是终态：这两种再每 1.5 秒问一次只是白打请求。
 *  真正需要轮询的是中间几段（preparing / planning / applying / building）。 */
function isActiveJob(phase: string | undefined): boolean {
  return !!phase && phase !== 'idle' && phase !== 'done' && phase !== 'error';
}

function errorText(e: unknown, fallback: string): string {
  const m = (e as { message?: unknown } | null)?.message;
  const raw = typeof m === 'string' && m ? m : (e ? String(e) : '');
  if (/\bHTTP\s*404\b/.test(raw)) return UNSUPPORTED_TEXT;
  return raw || fallback;
}

function fmtTime(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '' || v === 0) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function fmtBytes(n: number | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function shortOf(c: { short?: string; sha?: string } | null | undefined): string {
  return c?.short || (c?.sha ? c.sha.slice(0, 7) : '—');
}

function actionBadge(action: UpdateFileAction): string {
  if (action === 'add') return 'badge badge-info';
  if (action === 'conflict') return 'badge badge-error';
  if (action === 'delete') return 'badge badge-warn';
  return 'badge badge-soft';
}

function entrySize(e: UpdatePlanEntry): string {
  if (e.action === 'add') return `上游 ${fmtBytes(e.upstreamBytes)}`;
  if (e.action === 'delete' || e.action === 'kept') return `本地 ${fmtBytes(e.localBytes)}`;
  return `本地 ${fmtBytes(e.localBytes)} → 上游 ${fmtBytes(e.upstreamBytes)}`;
}

export default function Update({ onBack, modal }: Props) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [busy, setBusy] = useState<null | 'check' | 'plan' | 'apply'>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgWarn, setMsgWarn] = useState(false);
  const [plan, setPlan] = useState<UpdatePlanResult | null>(null);
  const [overwriteAll, setOverwriteAll] = useState(false);
  /* apply 之后先把轮询打开：POST 返回时后端任务可能还没被 status 看见，
     等第一轮读到 preparing 就自然接上了。 */
  const [follow, setFollow] = useState(false);
  const logRef = useRef<HTMLDivElement | null>(null);
  /* 轮询失败时只提示一次：后端长时间不可用，每 1.5 秒弹一条同样的提示没有意义。 */
  const pollErrRef = useRef(false);

  const notify = useCallback((text: string, warn = false) => { setMsg(text); setMsgWarn(warn); }, []);

  /* toast 5 秒自动收（2026-10-24）：它是浮层，不关也不挤版式，但不该一直挂在那儿。 */
  useEffect(() => {
    if (!msg) return;
    const t = window.setTimeout(() => setMsg(null), 5000);
    return () => window.clearTimeout(t);
  }, [msg]);

  const applyStatus = useCallback((s: UpdateStatus) => {
    setStatus(s);
    setUnsupported(false);
    setLoadErr(null);
    if (isActiveJob(s.job?.phase)) setFollow(true);
  }, []);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      const s = await updateStatus();
      if (!s || s.ok === false) throw new Error(s?.error || '读取更新状态失败');
      applyStatus(s);
    } catch (e) {
      const text = errorText(e, '读取更新状态失败');
      if (text === UNSUPPORTED_TEXT) setUnsupported(true);
      else setLoadErr(text);
    } finally {
      setLoading(false);
    }
  }, [applyStatus]);

  useEffect(() => { void loadStatus(); }, [loadStatus]);

  /* 更新任务运行期间每 1.5 秒读一次 status（进度、日志、lastResult 都在里面）。
     到 done/error 就停：这两个是终态，继续轮询不会再有新信息。 */
  useEffect(() => {
    if (!follow) return;
    pollErrRef.current = false;
    let alive = true;
    let timer: number | null = null;
    const tick = async () => {
      try {
        const s = await updateStatus();
        if (!alive) return;
        if (!s || s.ok === false) {
          if (!pollErrRef.current) { notify(s?.error || '读取更新进度失败', true); pollErrRef.current = true; }
        } else {
          pollErrRef.current = false;
          applyStatus(s);
          const phase = s.job?.phase;
          if (phase === 'done' || phase === 'error') {
            setFollow(false);
            setPlan(null);
            notify(
              phase === 'done' ? '更新完成。请退出并重新打开 Kizuna 使新代码生效。' : '更新失败，原因见下方日志。',
              phase === 'error',
            );
            return;
          }
        }
      } catch (e) {
        // 后端短暂重启 / 网络抖动时继续重试，不把轮询打断。
        if (!alive) return;
        const text = errorText(e, '读取更新进度失败');
        if (text === UNSUPPORTED_TEXT) { setUnsupported(true); setFollow(false); return; }
        if (!pollErrRef.current) { notify(text, true); pollErrRef.current = true; }
      }
      if (alive) timer = window.setTimeout(tick, 1500);
    };
    timer = window.setTimeout(tick, 500);
    return () => { alive = false; if (timer !== null) window.clearTimeout(timer); };
  }, [follow, applyStatus, notify]);

  const job = status?.job ?? EMPTY_JOB;
  const jobRunning = isActiveJob(job.phase);
  const current = status?.current ?? null;
  const latest = status?.latest ?? null;
  const behind = status?.behind === true || (!!current && !!latest && current.sha !== latest.sha);
  /* 版本条下面那行固定说明：一张卡只留一句，不再分「当前版本」「仓库最新」两处重复。 */
  const verSubTitle = latest
    ? `${latest.message || '（上游未给出提交说明）'} · ${fmtTime(latest.date)}${typeof latest.files === 'number' ? ` · 相差 ${latest.files} 个文件` : ''}`
    : '尚未检查上游版本：点右侧「检查更新」拉取仓库最新提交。';
  const locked = loading || busy !== null || jobRunning || unsupported;
  const logAll = job.log ?? [];
  const logLines = logAll.slice(-200);
  const logText = logLines.join('\n');
  const percent = Math.max(0, Math.min(100, Math.round(Number(job.percent) || 0)));
  const lastResult: UpdateLastResult | null = status?.lastResult ?? null;
  const conflicts: string[] = lastResult && Array.isArray(lastResult.conflicts) ? lastResult.conflicts : [];
  const planEntries: UpdatePlanEntry[] = plan?.ok ? (plan.entries ?? []) : [];
  const planCounts = plan?.ok ? plan.counts : undefined;

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logText]);

  useEffect(() => {
    if (job.phase === 'done') {
      const t = setTimeout(() => {
        window.location.reload();
      }, 3500);
      return () => clearTimeout(t);
    }
  }, [job.phase]);

  const reportError = useCallback((e: unknown, fallback: string) => {
    const text = errorText(e, fallback);
    if (text === UNSUPPORTED_TEXT) { setUnsupported(true); return; }
    notify(text, true);
  }, [notify]);

  const doCheck = async () => {
    if (locked) return;
    setBusy('check');
    try {
      const r = await updateCheck();
      if (!r || r.ok === false) throw new Error(r?.error || '检查更新失败');
      setStatus((prev) => {
        const base: UpdateStatus = prev ?? { ok: true, current: null, latest: null, behind: false, job: EMPTY_JOB, lastResult: null };
        return {
          ...base,
          ...r,
          // check 只回版本信息时，job / lastResult 仍以原状态为准。
          job: r.job ?? base.job,
          lastResult: r.lastResult === undefined ? base.lastResult : r.lastResult,
        };
      });
      setPlan(null);
      setUnsupported(false);
      /* 2026-10-24：检查成功后不再弹提示 —— 版本条已经写明「上游 xxx 有更新」，重复一次只是噪音。 */
      if (isActiveJob(r.job?.phase)) setFollow(true);
    } catch (e) {
      reportError(e, '检查更新失败');
    } finally {
      setBusy(null);
    }
  };

  const doPlan = async () => {
    if (locked) return;
    setBusy('plan');
    setPlan(null);
    try {
      const r = await updatePlan(latest?.sha);
      setPlan(r);
      if (!r || r.ok === false) { notify(r?.error || '生成更新预览失败', true); return; }
      /* 2026-10-24：预览结果直接渲染成表格，不再额外弹一条重复计数。 */
    } catch (e) {
      reportError(e, '生成更新预览失败');
    } finally {
      setBusy(null);
    }
  };

  const doApply = async () => {
    if (locked) return;
    setBusy('apply');
    try {
      const r = await updateApply({ sha: latest?.sha, overwriteAll, build: true });
      if (!r || r.ok !== true || r.started !== true) throw new Error(r?.error || '更新未能启动');
      setPlan(null);
      setFollow(true);
      notify('更新任务已启动，进度见下方。构建前端可能需要几分钟。');
    } catch (e) {
      reportError(e, '启动更新失败');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={modal ? 'page cute-ui kz-upd-in-modal' : 'page cute-ui'}>
      <div className="page-header">
        <div className="page-header-left">
          {modal
            ? <button className="btn btn-sm" onClick={onBack}><X size={15} /> 关闭</button>
            : <button className="btn btn-sm" onClick={onBack}><ArrowLeft size={15} /> 返回</button>}
          <div className="page-title-wrap">
            <div className="page-title" style={{ color: 'var(--nc-primary-500)' }}>Kizuna · 更新</div>
            <div className="page-subtitle">从上游仓库获取新版本 · 合并进当前安装目录（不改用户配置与数据）</div>
          </div>
        </div>
        <div className="page-actions">
          {status?.repo && (
            <span className="connection-bar" title={`${status.repo}${status.branch ? '@' + status.branch : ''}`}>
              <GitBranch size={13} /> {status.repo}{status.branch ? `@${status.branch}` : ''}
            </span>
          )}
        </div>
      </div>

      <div className="page-body">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {unsupported ? (
            <div className="card">
              <div className="card-title"><AlertTriangle size={17} /> 更新不可用</div>
              <div style={{ fontSize: 13, lineHeight: 1.8, color: 'var(--nc-foreground-600)' }}>
                {UNSUPPORTED_TEXT}。更新功能需要后端提供 <code>/api/update/*</code> 接口，
                请使用新版本的安装包覆盖安装后再打开本页。
              </div>
            </div>
          ) : loadErr && !status ? (
            <div className="card">
              <div className="card-title"><AlertTriangle size={17} /> 读取更新状态失败</div>
              <div style={{ fontSize: 13, lineHeight: 1.8, color: 'var(--nc-foreground-600)' }}>{loadErr}</div>
              <div className="lrn-actions">
                <button className="btn btn-sm" onClick={() => void loadStatus()}>重试</button>
              </div>
            </div>
          ) : loading && !status ? (
            <div className="card">
              <div className="lrn-inline-note"><Loader2 size={13} className="spin" /> 正在读取更新状态…</div>
            </div>
          ) : status ? (
            <>
              {/* 版本条（2026-10-24 精简）：一行放当前/上游 + 有更新标记 + 检查按钮，下一行提交说明。
                  原来这里是两张卡片 + 一条「发现新版本」横幅，同一件事说了三遍，还占掉半屏。 */}
              <div className="ag-update-hero">
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <span className={`badge ${jobRunning ? "badge-info" : behind ? "badge-warn" : "badge-success"}`}>
                    {jobRunning ? "AGENT UPDATING" : behind ? "发现新版本" : "已是最新"}
                  </span>
                  <span className="kz-upd-ver-key">当前</span>
                  <code style={SHA_CODE}>{current ? shortOf(current) : "未记录"}</code>
                  <ArrowRight size={13} style={{ opacity: 0.45 }} />
                  <span className="kz-upd-ver-key">GitHub 上游</span>
                  <code style={SHA_CODE}>{latest ? shortOf(latest) : "未检查"}</code>
                  <button className="btn btn-sm btn-soft" style={{ marginLeft: "auto" }} disabled={locked} onClick={() => void doCheck()}>
                    {busy === "check" ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} 检查更新
                  </button>
                </div>
                <div className="ag-step-track">
                  {[
                    { k: "check", idx: 1, title: "1. 检查上游", desc: "比对远端 Commit" },
                    { k: "plan", idx: 2, title: "2. 差异分析", desc: "生成文件指纹清单" },
                    { k: "apply", idx: 3, title: "3. 智能合并", desc: "保护本地配置与数据" },
                    { k: "build", idx: 4, title: "4. 构建生效", desc: "编译前端并热重载" },
                  ].map((stItem) => {
                    const stepNum = job.phase === "done" ? 5 : job.phase === "building" ? 4 : job.phase === "applying" ? 3 : (job.phase === "planning" || job.phase === "preparing" || busy === "plan") ? 2 : (job.phase === "checking" || busy === "check") ? 1 : 0;
                    const isDone = stepNum > stItem.idx;
                    const isAct = stepNum === stItem.idx;
                    return (
                      <div key={stItem.k} className={`ag-step-node ${isAct ? "active" : ""} ${isDone ? "done" : ""}`}>
                        <span className="ag-step-dot">{isDone ? "✓" : stItem.idx}</span>
                        <div>
                          <div style={{ fontWeight: 700, fontSize: 12.5 }}>{stItem.title}</div>
                          <div style={{ fontSize: 11, color: "var(--nc-foreground-400)" }}>{stItem.desc}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="kz-upd-ver-sub" title={verSubTitle}>{verSubTitle}</div>
              </div>

              <div className="card kz-upd-ops">
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                  <button className="btn btn-soft" disabled={locked} onClick={() => void doPlan()}>
                    {busy === 'plan' ? <Loader2 size={15} className="spin" /> : <FileDiff size={15} />} 预览变更
                  </button>
                  <button className="btn btn-primary" disabled={locked} onClick={() => void doApply()}>
                    {busy === 'apply' ? <Loader2 size={15} className="spin" /> : <Download size={15} />} 立即更新
                  </button>
                </div>

                <label className="switch-row" style={{ marginTop: 12, opacity: locked ? 0.6 : 1 }}>
                  <input
                    type="checkbox"
                    checked={overwriteAll}
                    disabled={locked}
                    onChange={(e) => setOverwriteAll(e.target.checked)}
                  />
                  <span>
                    以上游为准覆盖本地改动
                    <em>不勾选时：冲突文件保留本地，上游版本另存 .new（文件名带短 sha），可自行 diff。</em>
                  </span>
                </label>

                {/* 一行固定高度的状态（2026-10-24）：原来这两段提示是按条件出现/消失的下横条，
                    每弹一次就推一次版式 —— 主人说的"会让界面动"就是它。现在永远占一行、只换文字。 */}
                <div className="kz-upd-status">
                  {jobRunning ? (
                    <><Loader2 size={13} className="spin" /> {PHASE_TEXT[job.phase] ?? job.phase} {percent}% · {job.message || job.step || '进行中'}</>
                  ) : busy === 'plan' ? (
                    <><Loader2 size={13} className="spin" /> 正在下载源码包并逐文件比对（首次 10–40 秒）…</>
                  ) : behind ? (
                    <>上游有新提交：先「预览变更」看差异，或直接「立即更新」。</>
                  ) : latest ? (
                    <>本地与上游一致。</>
                  ) : (
                    <>尚未检查上游版本。</>
                  )}
                </div>
                <div className="kz-upd-note">更新完成后需要退出并重新打开 Kizuna 才会生效。</div>
              </div>

              {plan?.ok ? (
                <div className="card">
                  <div className="card-title">
                    <FileDiff size={17} /> 变更预览{plan.sha ? ` · ${plan.sha.slice(0, 7)}` : ''}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
                    <span className="badge badge-info">新增 {planCounts?.add ?? 0}</span>
                    <span className="badge badge-soft">更新 {planCounts?.update ?? 0}</span>
                    <span className="badge badge-error">冲突 {planCounts?.conflict ?? 0}</span>
                    <span className="badge badge-warn">删除 {planCounts?.delete ?? 0}</span>
                    {planCounts?.kept ? <span className="badge badge-soft">保留 {planCounts.kept}</span> : null}
                  </div>
                  {planEntries.length === 0 ? (
                    <div className="lrn-inline-note">没有需要变更的文件（本地已与上游一致）。</div>
                  ) : (
                    <div style={{ maxHeight: 380, overflow: 'auto', border: '1px solid var(--nc-border)', borderRadius: 'var(--nc-radius-m)' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                        <thead>
                          <tr>
                            <th style={TH}>文件</th>
                            <th style={{ ...TH, width: 180 }}>动作</th>
                            <th style={{ ...TH, width: 220 }}>大小</th>
                          </tr>
                        </thead>
                        <tbody>
                          {planEntries.map((e) => {
                            const conflict = e.action === 'conflict';
                            return (
                              <tr key={e.rel} style={conflict ? { background: 'var(--nc-danger-100)' } : undefined}>
                                <td style={{ ...TD, fontFamily: "'JetBrains Mono', monospace", wordBreak: 'break-all', color: conflict ? 'var(--nc-danger-600)' : undefined }}>
                                  {e.rel}
                                </td>
                                <td style={TD}>
                                  <span className={actionBadge(e.action)}>{ACTION_TEXT[e.action] ?? e.action}</span>
                                  {conflict ? (
                                    <div style={{ marginTop: 4, fontSize: 11, lineHeight: 1.5, color: 'var(--nc-danger-600)' }}>
                                      本地改过，会保留本地并另存 .new
                                    </div>
                                  ) : null}
                                </td>
                                <td style={{ ...TD, color: 'var(--nc-foreground-400)', whiteSpace: 'nowrap' }}>{entrySize(e)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <div style={META_LINE}>
                    共 {planEntries.length} 个文件需要处理；勾选「以上游为准覆盖本地改动」后，冲突行会直接覆盖本地，不再另存 .new。
                  </div>
                </div>
              ) : null}

              {job.phase !== 'idle' ? (
                <div className="card">
                  <div className="card-title"><Terminal size={17} /> 更新进度</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    {jobRunning
                      ? <Loader2 size={16} className="spin" />
                      : job.phase === 'done'
                        ? <CheckCircle2 size={16} style={{ color: 'var(--nc-success-500)' }} />
                        : job.phase === 'error'
                          ? <AlertTriangle size={16} style={{ color: 'var(--nc-danger-500)' }} />
                          : <Terminal size={16} />}
                    <b>{PHASE_TEXT[job.phase] ?? job.phase}</b>
                    <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--nc-foreground-500)' }}>{percent}%</span>
                  </div>
                  <div
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={percent}
                    style={{ height: 10, borderRadius: 999, background: 'var(--nc-default-100)', overflow: 'hidden', margin: '10px 0 8px' }}
                  >
                    <div style={{
                      width: `${percent}%`,
                      height: '100%',
                      background: job.phase === 'error' ? 'var(--nc-danger-500)' : job.phase === 'done' ? 'var(--nc-success-500)' : 'var(--nc-primary-500)',
                      transition: 'width .3s ease',
                    }} />
                  </div>
                  <div style={META_LINE}>{job.message || job.step || '—'}</div>
                  {job.phase === 'done' && (
                    <div style={{
                      marginTop: 8,
                      padding: '8px 12px',
                      borderRadius: 8,
                      background: 'rgba(34, 197, 94, 0.12)',
                      border: '1px solid rgba(34, 197, 94, 0.3)',
                      color: 'var(--nc-success-600, #16a34a)',
                      fontSize: 13,
                      fontWeight: 600,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                    }}>
                      <CheckCircle2 size={15} />
                      更新完成！系统正在自动重启服务并刷新页面（约 3 秒）…
                    </div>
                  )}
                  <div className="lrn-status-meta">
                    {job.startedAt ? <span>开始：{fmtTime(job.startedAt)}</span> : null}
                    {job.finishedAt ? <span>结束：{fmtTime(job.finishedAt)}</span> : null}
                    <span>仅显示最后 200 行日志{logAll.length > 200 ? `（共 ${logAll.length} 行）` : ''}</span>
                  </div>
                  <div className="log-viewer" ref={logRef} style={{ marginTop: 8 }}>
                    {logLines.length
                      ? logLines.map((line, i) => <div className="log-line" key={i}>{line || ' '}</div>)
                      : <div className="log-line" style={{ color: 'var(--nc-foreground-400)' }}>暂无日志</div>}
                  </div>
                </div>
              ) : null}

              {lastResult ? (
                <div className="card">
                  <div className="card-title"><CheckCircle2 size={17} /> 上次更新结果</div>
                  {lastResult.ok === false ? (
                    <div style={{ fontSize: 13, lineHeight: 1.8, color: 'var(--nc-danger-600)' }}>
                      更新失败：{lastResult.error || lastResult.message || '未知原因'}
                      {lastResult.finishedAt ? <div style={META_LINE}>结束时间：{fmtTime(lastResult.finishedAt)}</div> : null}
                    </div>
                  ) : (
                    <>
                      <div className="lrn-status-meta" style={{ marginTop: 0 }}>
                        <span>版本：<code>{shortOf(lastResult)}</code></span>
                        <span>应用了 {lastResult.applied ?? 0} 个文件</span>
                        <span>冲突 {conflicts.length} 个</span>
                        <span>删除 {lastResult.deleted ?? 0} 个</span>
                        <span>前端：{typeof lastResult.built === 'boolean' ? (lastResult.built ? '已重建' : '未重建') : '—'}</span>
                        <span>结束时间：{fmtTime(lastResult.finishedAt)}</span>
                      </div>
                      {lastResult.backupDir ? (
                        <div style={{ ...META_LINE, wordBreak: 'break-all' }}>
                          备份目录：<code>{lastResult.backupDir}</code>
                        </div>
                      ) : null}
                      {conflicts.length > 0 ? (
                        <div style={{
                          marginTop: 10, padding: '8px 10px', borderRadius: 8, background: 'var(--nc-danger-100)',
                          color: 'var(--nc-danger-600)', fontSize: 12.5, lineHeight: 1.7,
                        }}>
                          冲突 {conflicts.length} 个：本地改动已保留，上游版本另存成 <code>xxx.new-短sha</code>，可自行 diff。
                          <div style={{ marginTop: 4, wordBreak: 'break-all' }}>
                            {conflicts.slice(0, 12).join('、')}{conflicts.length > 12 ? ` 等 ${conflicts.length} 个` : ''}
                          </div>
                        </div>
                      ) : null}
                    </>
                  )}
                </div>
              ) : null}

            </>
          ) : (
            <div className="card">
              <div className="lrn-inline-note">没有读取到更新状态。</div>
            </div>
          )}
        </div>
      </div>

      {/* 提示改成浮层 toast（2026-10-24）：固定定位、不占文档流，出现/消失都不会把下面的内容顶走。
          必须走 portal 挂到 document.body：外层 .view-swap 带 transform（哪怕 matrix 是单位矩阵），
          会把它变成 position:fixed 的包含块，实测 toast 会被压到屏幕底部之外。 */}
      {msg ? createPortal(
        <div className={msgWarn ? 'kz-upd-toast kz-upd-toast-warn' : 'kz-upd-toast'} role="status">
          <span style={{ flex: '1 1 auto' }}>{msg}</span>
          <button className="kz-upd-toast-x" type="button" onClick={() => setMsg(null)} aria-label="关闭提示"><X size={13} /></button>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
