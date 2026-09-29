import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import NoticeBar from '../components/NoticeBar';
import {
  ArrowLeft, Mic, Volume2, Play, Save, Trash2, Plus, Loader2, AlertTriangle,
  Zap, Upload, Wand2, FlaskConical, Clock3, Sparkles, Download, Cpu, HardDrive, RefreshCw, Square, ChevronDown,
  Star, Music,
} from 'lucide-react';
import { api } from '../api';
import { CFG_VOICE, getCachedConfig, rememberConfig } from '../config-cache';
import NumInput from '../components/NumInput';
import Dropdown from '../components/Dropdown';
import { initialFromCache, writeCacheValue, dropCacheValue, warmCache } from '../lib/read-cache';
/** 角色清单的取数与显示口径（读 characterList、回退 characters、label 空则显示 name、
 *  语言 zh/jp/en/kr → 中文名）—— 与桥侧契约同源，见该文件顶部说明。 */
import { normalizeChars, charDisplay, type LocalChar, type LocalStatCharacter } from '../lib/char-list';
import { ReadBar, Skeleton } from '../components/ReadState';

/**
 * Kizuna · 语音（MiMo-V2.5 TTS／音色设计／音色复刻／语音识别）
 *
 * 「为何单独设页」：语音使用独立的模型服务商与密钥（与聊天模型分属不同账号或端点的情况很常见），
 * 因此四类模型各自配置「请求地址 + API Key + 模型名」，互不影响。配置保存于桥侧
 * （state/voice-config.json），保存即生效，无需重启桥，且不进入公开仓库。
 *
 * 「安全」API Key 仅单向写入：界面读回的始终是掩码（前 3 位 + 后 4 位）；
 * 输入框留空表示不改动已保存的密钥。
 *
 * 「实测过的接口形态」（2026-09-15 服务器实测，与官方文档 api 一致）
 *   · 合成：POST {地址}/chat/completions，assistant 消息放待朗读文本、user 消息放风格／音色描述，
 *     音色置于 audio.voice；返回 choices[0].message.audio.data（base64 音频）。
 *   · 识别：messages 的 content 中放 input_audio（data URL，mp3/wav），返回 message.content（文本）。
 */

interface RoleCfg { baseUrl: string; model: string; apiKeyMasked: string; apiKeySet: boolean }
interface VoiceCfg {
  ok?: boolean;
  enabled?: boolean;
  defaultVoice?: string;
  style?: string;
  /** 音色稳定模式（桥侧 core/voice.js 的 stableVoice）：为 true 时忽略每条消息的语气标注，只用 style */
  stableVoice?: boolean;
  format?: string;
  maxChars?: number;
  dailyChars?: number;
  cacheEnabled?: boolean;
  maxCacheFiles?: number;
  asrLanguage?: string;
  asrAutoTranscribe?: boolean;
/** 主动发语音的节奏：概率（0~1）+ 同一会话冷却（毫秒）+ 全语音发送模式 */
  send?: { probability?: number; cooldownMs?: number; allVoice?: boolean };
  usage?: { day: string; chars: number; calls: number; cacheHits: number; asrCalls: number };
  roles?: { role: string; label: string; defaultModel: string }[];
  presets?: { tokenPlanCn: string; official: string };
  builtinVoices?: { id: string; label: string; lang: string; gender: string; note: string }[];
  models?: Record<string, RoleCfg>;
  /** 本地语音引擎（桥侧 core/voice.js 的 local 段，2026-09-28 新增）：字段与桥侧 src/lib/genie-tts.js 的 LOCAL_DEFAULTS 对应 */
  local?: LocalCfg;
}
/** 本地语音引擎（Genie / GPT-SoVITS ONNX sidecar）的配置形状：全是路径、开关与数量，没有密钥。
 *  桥侧权威定义在 src/lib/genie-tts.js 的 normalizeLocal()（缺字段回落到那里的默认值）。 */
interface LocalCfg {
  enabled?: boolean;
  engine?: string;
  rootDir?: string;
  pythonPath?: string;
  dataDir?: string;
  modelsDir?: string;
  character?: string;
  language?: string;
  port?: number;
  autoStart?: boolean;
  idleShutdownMs?: number;
  startupTimeoutMs?: number;
  timeoutMs?: number;
  fallbackToCloud?: boolean;
}
/** `GET /api/voice/local` 的状态回包。下面只列出界面明面用到的字段，其余一律由索引签名接住 ——
 *  与桥侧「回包字段随时会长」的口径一致（本页各处对回包都做容错，不因缺字段而崩）。
 *  角色那两个字段的**取数与显示口径**（含类型 `LocalStatCharacter`）在 `src/lib/char-list.ts`：
 *  `characterList` 对象数组为准、`characters` 字符串数组作回退，`label` 为空串时显示 `name`，
 *  语言 zh/jp/en/kr 显示成中文名 —— 单独成模块是为了那几个容易写错的分支能直接单测。 */
interface LocalStat {
  ok?: boolean;
  /** 环境是否就绪（引擎目录、.venv、依赖都齐） */
  ready?: boolean;
  running?: boolean;
  pid?: number | null;
  rssMb?: number | null;
  python?: string;
  pythonVersion?: string;
  jiebaShim?: { reason?: string } | null;
  /** 老形状（顶层）：界面早期只按这一层读，实际桥侧不回它们 —— 保留作兜底，见 localDetail */
  rootDir?: string;
  modelsDir?: string;
  url?: string;
  /** 桥侧真正的形状（`localState` 的 `paths`）：目录、脚本、数据目录、日志与实际监听地址都在这里。
   *  2026-10-01 修：此前界面只读顶层同名字段，于是悬停详情里「引擎目录 / 角色模型目录」一直是空的。
   *  取数口径：`paths` 优先、顶层兜底（两种形状都认，老桥新桥都不至于显示空白）。 */
  paths?: { rootDir?: string; modelsDir?: string; dataDir?: string; serverFile?: string; logFile?: string; refDir?: string; url?: string; [k: string]: any };
  /** 未满足项（中文，直接摊在状态行上） */
  reasons?: string[];
  /** 角色清单：对象数组 `[{name,label,language,loaded}]`（界面下拉用它；`label` 可能为空串） */
  characterList?: LocalStatCharacter[];
  /** 旧字段：目录名字符串数组（旧界面在用，形状不能改）。仅作 `characterList` 缺失/为空时的回退 */
  characters?: Array<LocalStatCharacter | string>;
  /** 本地音色档案（2026-10-02 新增，桥侧 state/local-voices.json）：**与上面两个字段完全不是一回事** ——
   *  `characters`/`characterList` 是引擎 models/ 下的真实角色模型目录，这里列的是用户自己建的音色
   *  （一段参考音频 + 一个基础角色 + 可选参考文本）。界面「我的音色」列读的就是它。 */
  localVoices?: LocalVoice[];
  [k: string]: any;
}
/** 一个「本地音色档案」：桥侧 core/voice.js 里那一节定义的东西。
 *  用它合成 = 走既有的 clone 路径（基础角色 + 这段参考音频），不是另一条合成路径。 */
interface LocalVoice {
  id: string;
  name: string;
  /** 基础角色：引擎里真实存在的角色名（为空 = 用引擎当前的默认角色） */
  baseCharacter?: string;
  /** 样本文件名（桥侧 state/local-voices/ 下，**不是**绝对路径） */
  sampleFile?: string;
  sampleBytes?: number;
  sampleExt?: string;
  /** 可选参考文本：样本里念的是什么。给了能让复刻更准（桥侧原样交给引擎的 reference_text） */
  promptText?: string;
  createdAt?: string;
  /** 样本文件是否还在（桥侧如实回答；文件被清掉时界面要能看出来） */
  hasSample?: boolean;
}
/** `POST /api/voice/local {action:'preview'}` 的回包：真合成一句并把 wav 字节带回来。
 *  失败时不带音频相关字段，原因写在 `reason` 里（界面原样显示，不吞）。 */
interface LocalPreviewResp {
  ok: boolean;
  ms?: number;
  bytes?: number;
  /** 固定为 audio/wav（本地引擎只出 wav） */
  mime?: string;
  /** 音频本体（base64，不带 data: 前缀） */
  audioBase64?: string;
  reason?: string;
  [k: string]: any;
}
/** 本地引擎这一段在界面上的初值（与桥侧 `src/lib/genie-tts.js` 的 `LOCAL_DEFAULTS` 一一对应）。
 *
 * 为什么界面要自带一份初值，而不是等桥回包：`voice.local` 这个键在用户**第一次保存之前
 * 根本不存在**（桥侧默认值是内存里合并的，不写进 config.json），老一些的桥更是完全不返回它。
 * 那时若把 `local` 原样当成 null，整张卡片的输入框会全部 `disabled` —— 用户看得见却一个也改不了
 * （2026-09-28 使用方反馈"在语音配置界面没看见这个"时排查出来的第二半）。
 * 自带初值后：卡永远可编辑，用户改了什么、保存时就整段写回 `voice.local`，桥侧再按自己的
 * normalizeLocal 收口（它才是权威，界面这份只是"表单起点"）。 */
const LOCAL_FORM_DEFAULTS: LocalCfg = {
  enabled: false,
  engine: 'genie',
  rootDir: '',
  modelsDir: '',
  character: '',
  language: 'zh',
  port: 4610,
  autoStart: true,
  idleShutdownMs: 600000,
  fallbackToCloud: true,
};

/** 本地音色样本的大小上限：与桥侧 `core/voice.js` 的 `MAX_LOCAL_SAMPLE_BYTES` **同一口径**（640KB）。
 *  「为什么不是云端那个 7MB」：云端样本是发给小米的接口（限制在那边），而本地这份样本要经
 *  base64 JSON 上传到桥，桥控制台的请求体上限是 1MB（`console-server.js` 的 `readBody`，
 *  MAX_BODY_BYTES），base64 又把字节放大 4/3 —— 640KB 原始字节 ≈ 874KB 请求体，留出余量。
 *  超过就该在**选文件那一刻**说清楚，而不是等桥回一句「请求体过大」。 */
const LOCAL_SAMPLE_MAX_BYTES = 640 * 1024;

/* ── 本地引擎卡片的「查看目标」三态（2026-10-01 新增）─────────────────────────────
 * 「为什么需要它」管理端后端早就支持按作用域取本地引擎（server/index.js 的 voiceScopeOf /
 * voiceScopeTarget：`?scope=local` 查本机桥，`?scope=remote` 查服务器那侧；**不带 scope 时
 * 跟随当前连接** —— 连上服务器就看服务器，这是既定语义，不能改），可界面从来不发这个参数、
 * 也没有任何控件能指定看哪一侧。于是使用方连着自己的服务器时，这张卡读到的一直是服务端那份
 * （`/root/qq-bridge/python`：没有引擎、没有角色），而本机其实装着角色、真能合成 —— 屏幕上没有
 * 任何线索说明"你看的是另一台机器"。
 * 「三档的含义」自动 = 不带 scope（保持原行为）；本机 = scope=local；服务端 = scope=remote。
 * 「为什么记住它」选完刷新页面又跳回自动，等于每次都要重选；非法值一律退回 auto。 */
type VoiceScopeChoice = 'auto' | 'local' | 'remote';
const VOICE_SCOPE_KEY = 'kizuna.voiceScope.v1';
const VOICE_SCOPE_OPTIONS: Array<{ value: VoiceScopeChoice; label: string }> = [
  { value: 'auto', label: '自动（跟随连接）' },
  { value: 'local', label: '本机' },
  { value: 'remote', label: '服务端' },
];
/** 读回记住的目标：没有记录 / 值不认识 / localStorage 不可用（隐私模式）一律当 `auto`。 */
function readVoiceScope(): VoiceScopeChoice {
  try {
    const v = window.localStorage.getItem(VOICE_SCOPE_KEY);
    return v === 'local' || v === 'remote' ? v : 'auto';
  } catch { return 'auto'; }
}
/** 记住目标（写失败不影响本次选择生效，只是下次进页面回到默认）。 */
function writeVoiceScope(v: VoiceScopeChoice): void {
  try { window.localStorage.setItem(VOICE_SCOPE_KEY, v); } catch { /* 忽略 */ }
}
/** 本卡四个请求共用的作用域查询串：`自动` 返回空串（= 现状：由后端跟随当前连接），
 *  `本机`/`服务端` 返回 `scope=local|remote`。`sep` 给的是拼接位置的分隔符 ——
 *  GET 已带 `?force=1` 时用 '&'，POST 没有其它查询参数时用 '?'。 */
function scopeQuery(q: VoiceScopeChoice, sep: '?' | '&' = '?'): string {
  return q === 'auto' ? '' : `${sep}scope=${q}`;
}

interface CustomVoice { id: string; name: string; kind: 'design' | 'clone'; description: string; sampleBytes: number; hasSample: boolean; createdAt: string }

interface Props { onBack: () => void }

const SAMPLE_TEXT = '你好呀，我是月亮，这是音色试听。';
/** 「自定义测试文本」输入框的**默认值**（2026-09-29 使用方指定，原话「欲买挂花同载酒，终不似、少年游」，
 *  「挂」为「桂」的笔误，此处按「桂花」并用中文顿号原样照抄）。
 *  只作初始显示：用户改动后以用户输入为准（状态见下方 ctText）。
 *  与 SAMPLE_TEXT 分开：那一句仍是「音色库 / 文字设计 / 样本复刻」各试听按钮用的固定试听文本，未改动。 */
const CUSTOM_TEST_TEXT = '欲买桂花同载酒，终不似、少年游';
/** 「全局风格指令（style）的默认值」——英文书写，描述"像真人一样说话"，供语音合成以 user 消息接收。
 *  「权威源在桥侧」：真正的出厂默认值在 `qq-bridge/src/core/voice.js` 的默认语音配置里
 *  （该文件不在本次改动范围内；此处与之同口径，改一处需同步另一处）。
 *  桥未保存过该项（style 为空）时，本页以此值呈现并写回，使「不填」等同于"采用默认风格"。
 *  写法要求：一段自然语言英文（非全大写 token 体例），涵盖自然口语、停顿与语气词、不疾不徐、
 *  情绪贴合内容，并明确排除播音腔、客服腔与机械朗读。 */
const DEFAULT_VOICE_STYLE = 'Talk the way a real person talks: natural, unhurried everyday speech with small pauses and the occasional filler, pitch and emphasis following what the line actually carries. Keep it warm and conversational, and avoid announcer or customer-service delivery, flat mechanical reading and over-clean articulation.';
const ROLE_ORDER = ['tts', 'design', 'clone', 'asr'] as const;
/** 2026-09-18四类模型的角色 id（tts / design / clone / asr）及其中文名称。
 *  桥返回的 roles[].label 通常可用；若旧版桥未提供 label，则由此表兜底，
 *  以免界面直接显示英文角色 id（tools/audit-ui-labels.mjs 会检查此表须覆盖 ROLE_ORDER 中的全部 id）。 */
const ROLE_LABEL: Record<string, string> = {
  tts: '语音合成', design: '音色设计', clone: '音色复刻', asr: '语音识别',
};
/** 角色 id → 界面显示名（优先取桥返回的 label，其次取本地兜底表，最后回落到原 id） */
const roleName = (role: string, label?: string) => label || ROLE_LABEL[role] || role;
const ROLE_HINT: Record<string, string> = {
  tts: '使用官方内置音色朗读（默认走此路径）',
  design: '以一段文字描述生成音色，无需样本',
  clone: '上传一段 mp3/wav 样本，复刻该样本的音色',
  asr: '将他人发来的语音转为文字（使机器人可识别语音内容）',
};

/** 2026-09-27 修复「点击预置未填入请求地址」预置接入点：一个预置 = 一家服务商的请求地址 + 四个模型名。
 *  地址来源（并非推断）：桥侧 `qq-bridge/src/core/voice.js:59-60` 的
 *  `DEFAULT_BASE_URL = 'https://token-plan-cn.xiaomimimo.com/v1'`（国内 Token Plan，已验证可用，见该文件 :51 注释）
 *  与 `ALT_BASE_URL = 'https://api.xiaomimimo.com/v1'`（小米 MiMo 官方站）；
 *  同一对象在 `voiceConfigPublic()` 中以 `presets.tokenPlanCn / presets.official` 返回给管理端（voice.js:167）。
 *  模型名来源：`voice.js:52-57` 的 VOICE_ROLES[].defaultModel（两个地址同属小米，模型 id 相同）。
 *  「前端为何另存一份」：桥未运行时取不到 `cfg`（本页此时仍渲染表单，见下方 loadErr 分支），
 *  旧代码 `cfg?.presets?.tokenPlanCn ?? ''` 会把地址填为空串，表现为「点击预置后地址未被填入」。
 *  此处的本地常量仅作兜底：桥可正常返回时一律以桥为准（桥为权威源）。 */
const PRESETS: { key: 'tokenPlanCn' | 'official'; label: string; baseUrl: string; models: Record<string, string> }[] = [
  {
    key: 'tokenPlanCn', label: '小米 Token Plan（国内）',
    baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
    models: { tts: 'mimo-v2.5-tts', design: 'mimo-v2.5-tts-voicedesign', clone: 'mimo-v2.5-tts-voiceclone', asr: 'mimo-v2.5-asr' },
  },
  {
    key: 'official', label: '小米官方 API',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    models: { tts: 'mimo-v2.5-tts', design: 'mimo-v2.5-tts-voicedesign', clone: 'mimo-v2.5-tts-voiceclone', asr: 'mimo-v2.5-asr' },
  },
];

/** 桥控制台返回体兼容：管理端代理失败时会返回 { success:false, code, message }（无 ok 字段），
 *  因此判定成功一律使用 `ok === true`，不可仅判 `ok === false`，
 *  否则会把代理失败的结果当作成功数据渲染。
 *  2026-09-19 变更要求：文案不再于前端写死：「桥未运行」与「桥版本过旧」是两回事，
 *  服务端已按实际原因区分（code='bridge-offline' 表示对端无应答；code='bridge-stale' 表示桥有应答但无此路由），
 *  此处优先使用服务端返回的说明。前端另抄一份必然漂移：此前所抄的文案把「未启动」表述为
 *  「确认桥接进程已启动、远端连接与隧道正常」，仅因桥未运行的用户会误以为需要升级或排查隧道。 */
function pickErr(e: any): string {
  if (!e) return '未知错误';
  if (e.message || e.error) return String(e.message || e.error);
  if (e.code === 'bridge-offline') return '桥未运行，本页语音配置需在桥启动后方可读取（启动后本页会自动重读）';
  if (e.code === 'bridge-stale') return '桥正在运行，但其版本不含语音接口：请更新桥代码并重启桥，本页会自动重读';
  return String(e);
}

/** 自动重试说明（2026-09-30 原话：「不要我点击重试再刷新，而是自动刷新，也不要有点击重试这样的按钮」）。
 *  `ms > 0`：失败后的退避重读中（5 → 10 → 20 → 40 → 60 秒，封顶 60 秒）；`ms === 0`：已读到，停止重试。 */
const autoRetryNote = (ms: number): string =>
  ms > 0
    ? `正在自动重试：约每 ${Math.max(1, Math.round(ms / 1000))} 秒重读一次（失败后按 5／10／20／40／60 秒退避，最长 60 秒一次）。桥启动后本页会自行恢复，无需手动刷新。`
    : '';

/* 整行可点（"鼠标悬停同一水平线就能点"）**不在本文件实现**：全站那一份在 src/lib/field-click.ts，
   由 src/main.tsx 启动时 installFieldClickTargets() 装一次，本页的 .field-row / .switch-row 都在它的兜底范围内。

   【2026-09-29 删除本页那份重复实现的原因】本页此前另有一份 focusRowControl（挂在 .page-body 的 onClick 上），
   于是**同一次点击**会被两处各转发一次。文本框多聚焦一次无害，但自定义下拉（Dropdown）的触发器是"开 → 关"翻转，
   两遍合起来等于没点开 —— 无头实测：点该行空白时 button.mb-dd 收到两个合成 click，第一个把 aria-expanded 变 true、
   第二个又关回去，最终仍是关着的（用户看到的就是"点这一行点不开下拉"）。留一份实现，这种互相抵消就不会再出现。 */

/* ================= 表单取值（2026-09-23 重订口径） =================
 * 本页与「实例配置」同属配置页：有缓存即以缓存里的真实值渲染（缓存见 `src/config-cache.ts`），
 * 使本管理端会话内反复切换页面时数值不跳变；没有缓存（本次会话首次进入）时一律留空、
 * 开关不选中且不可编辑 —— 绝不以出厂默认值冒充，屏幕上不会出现与桥上配置不同的数值；
 * 「应用配置」：在真实配置读到之前一律禁用。 */

/** 表单取值。未读到的字段以 `undefined`/`null` 表示"未知"，渲染为空框或未选中且禁用。 */
interface VoiceForm {
  enabled: boolean | null;
  defaultVoice: string;
  style: string;
  format: string;
  maxChars?: number;
  dailyChars?: number;
  cacheEnabled: boolean | null;
  probPct?: number;
  coolMin?: number;
  allVoice: boolean | null;
  stableVoice: boolean | null;
  asrLanguage: string;
  models: Record<string, { baseUrl: string; model: string; apiKey: string }>;
}

/** 尚未读到任何配置时的表单取值：全空。 */
function emptyVoiceForm(): VoiceForm {
  const models: VoiceForm['models'] = {};
  for (const r of ROLE_ORDER) models[r] = { baseUrl: '', model: '', apiKey: '' };
  return {
    enabled: null, defaultVoice: '', style: '', format: '',
    maxChars: undefined, dailyChars: undefined,
    cacheEnabled: null, probPct: undefined, coolMin: undefined, allVoice: null, stableVoice: null,
    asrLanguage: '', models,
  };
}

/** 由一份桥配置导出表单取值（`applyCfg` 与"缓存预热"共用同一口径，避免两处写法漂移）。
 *  注意：此函数只处理"已读到配置"这一情形，其取值口径与本次改动之前完全一致
 *  （缺键时沿用桥侧既有默认），因此不会改变已读到配置时的任何显示。 */
function voiceFormOf(c: VoiceCfg): VoiceForm {
  const models: VoiceForm['models'] = {};
  for (const r of ROLE_ORDER) {
    const rc = c.models?.[r] ?? ({} as RoleCfg);
    // 密钥只写入不回显：此处始终留空（留空表示不改动已保存的密钥）
    models[r] = { baseUrl: String(rc.baseUrl ?? ''), model: String(rc.model ?? ''), apiKey: '' };
  }
  return {
    enabled: c.enabled === true,
    defaultVoice: String(c.defaultVoice ?? '冰糖'),
    // 全局风格指令：桥侧未设置（空串）时采用默认的英文拟人风格，见上方 DEFAULT_VOICE_STYLE
    style: String(c.style || DEFAULT_VOICE_STYLE),
    format: String(c.format ?? 'mp3'),
    maxChars: Number(c.maxChars) || 120,
    dailyChars: Number(c.dailyChars) || 0,
    cacheEnabled: c.cacheEnabled !== false,
    probPct: Math.round((Number(c.send?.probability ?? 0.2) || 0) * 100),
    coolMin: Math.round((Number(c.send?.cooldownMs ?? 600000) || 0) / 60000),
    // 全语音发送模式：缺失或非布尔值一律按 false 处理（旧配置无 send.allVoice 即普通模式），不报错
    allVoice: c.send?.allVoice === true,
    // 音色稳定模式：缺失或非布尔一律按关闭处理（旧配置/旧桥无此键即"沿用每条语气标注"）
    stableVoice: c.stableVoice === true,
    asrLanguage: String(c.asrLanguage ?? 'auto'),
    models,
  };
}

/* ================= 取数（组件加载与预热共用同一段） ================= */

/** 音色库那条读取缓存（`voice:voices`）的形状：内置清单 + 自建清单。 */
interface VoiceVoicesCache { builtin: NonNullable<VoiceCfg['builtinVoices']>; custom: CustomVoice[] }
/** 本页首屏要用的三份：配置本体（`voice:config`）、今日用量（`voice:usage`）、音色库（`voice:voices`）。 */
interface VoiceData { cfg: VoiceCfg; usage: VoiceCfg['usage'] | null; voices: VoiceVoicesCache }

/** 本页首屏三份数据的「取数 + 整形」。组件里那一次加载与下方 `warmVoicePage()` 预热**共用这一段** ——
 *  不各写一份：两份整形代码必然漂移，而预热灌进缓存的形状一旦与页面成功回包时写的不同，首帧就会渲染出问题。
 *  返回的三份值就是分别写入三个键的形状。失败时抛错（错误文本与原 `setLoadErr(pickErr(…))` 同一构造），
 *  由调用方走各自既有的兜底；预热侧由 warmCache 静默吞掉。 */
async function readVoiceData(): Promise<VoiceData> {
  const [c, v] = await Promise.all([
    // 2026-09-19目标侧的选择不再由前端承担：管理端后端统一按「连上服务器则走服务器，否则走本机」路由
    // （server/index.js 的 resolveBridgeTarget），前端仅采用其结果，用户无需先理解本页作用于哪一侧。
    api<VoiceCfg>('/voice/config'),
    api<{ ok?: boolean; builtin?: any[]; custom?: CustomVoice[] }>('/voice/voices'),
  ]);
  /* 成功判定与文件上方 pickErr 的说明同一口径：代理失败会返回 { success:false, code, message }（无 ok 字段），
     故一律用 `ok === true` 判定，不可仅判 `ok === false`。 */
  if (!c || (c as any).ok !== true) throw new Error(pickErr(c));
  if (((v as any)?.ok) !== true) throw new Error(pickErr(v));
  return {
    cfg: c,
    // 用量随配置一起回包，但单独占一条键：配置本体尚未读到（或读取失败）时，「今日用量」也能先出旧值
    usage: c.usage ?? null,
    voices: {
      builtin: c.builtinVoices ?? v.builtin ?? [],
      custom: Array.isArray(v.custom) ? v.custom : [],
    },
  };
}

/* ================= 预热（供外部：进管理器后空闲时 / 鼠标停在入口按钮上时调用） =================
 * 目的：把本页首屏要用的三份提前读进读取缓存 —— 用户点进来时首帧就已经走「有旧值」的瞬时路径，
 * 不再出现「没在读取但内容仍有延迟」的那一帧骨架。
 * 三份来自同一次读取（共用下面这个在飞 promise，只发一轮请求）；去重、写缓存、失败静默都由 warmCache 负责。
 * 这里是模块级函数：不 setState、不弹错、不 console，失败一律当没发生。 */

/** 预热期间的共用读取：三个键的 fetcher 都从这里取，避免为三份缓存各发一轮请求。 */
let voiceWarmInflight: Promise<VoiceData> | null = null;
function voiceWarmDataOnce(): Promise<VoiceData> {
  if (!voiceWarmInflight) voiceWarmInflight = readVoiceData().finally(() => { voiceWarmInflight = null; });
  return voiceWarmInflight;
}

/** 预热「语音」页首屏三份（voice:config / voice:usage / voice:voices）。可在空闲时、悬停入口时调用；
 *  重复调用无副作用（缓存还新即跳过，见 src/lib/read-cache.ts 的 warmCache）。 */
export async function warmVoicePage(): Promise<void> {
  await Promise.all([
    warmCache('voice:config', async () => (await voiceWarmDataOnce()).cfg),
    // 用量缺失时不写这条键（warmCache 对 null/undefined 不落盘），与页面里 `if (c.usage)` 同一口径
    warmCache('voice:usage', async () => (await voiceWarmDataOnce()).usage ?? undefined),
    warmCache('voice:voices', async () => (await voiceWarmDataOnce()).voices),
  ]);
}

/* ================= 音色导出（2026-10-01 新增） =================
 * 需求（主人原话）：给"生成的音色"一个导出按钮，支持选择导出文件夹，然后保存到本地。
 *
 * 「导出什么」= 该音色的**样本音频文件** + 一份**同名 .json 元数据**（id / 名字 / 类型 / 生成方式与
 * 描述 / 创建时间 / 是否默认 / 样本文件名）。
 *   · 有样本文件的音色（复刻型）→ 音频 + 同名 json；
 *   · 没有样本文件的音色（内置音色、纯文字设计音色、样本已丢失的复刻音色）→ **只导 json**，
 *     并如实写明「该音色没有样本文件，只能导出配置信息」—— 绝不现场合成一段来冒充样本
 *     （桥侧 GET /api/voice/sample 对这类音色直接 4xx 不给音频，见 fetchVoiceSample）。
 *
 * 「写到哪里」= 三档能力依次降级，**降级一律如实告知**（页面上一直写着会退成什么，不静默改变行为）：
 *   ① 选文件夹：File System Access API 的 showDirectoryPicker（Chrome / Edge 等安全上下文可用）；
 *   ② 单文件保存：showSaveFilePicker（逐个文件弹一次保存框）；
 *   ③ `<a download>` 逐个下载（落到浏览器的下载目录）。
 * 「为什么不覆盖已有文件」：① 在写入前逐个探测同名文件（pickFreeBase），重名加 -2/-3…；
 * ②③ 两档由浏览器自身去重（保存框会问是否覆盖、下载会自动加「(1)」）。 */

/** File System Access API 的两个入口（Chromium 专有）：lib.dom 里没有它们，故自己声明一个窄类型，
 *  免得为了两个方法把整个 window 放宽成 any。 */
type FsaWindow = Window & {
  showDirectoryPicker?: (opts?: { id?: string; mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
  showSaveFilePicker?: (opts?: { suggestedName?: string; types?: { description: string; accept: Record<string, string[]> }[] }) => Promise<FileSystemFileHandle>;
};

/** 本次导出实际走了哪条路（提示语必须与之对得上，不能把"逐个下载"说成"保存到文件夹"）。 */
type ExportMode = 'folder' | 'save-picker' | 'download';

/** 一条待导出的音色：把本页的两种清单（内置音色 / 自建音色）收敛成同一形状，
 *  命名、元数据与提示因此只有一套写法，不会两边漂移。 */
interface ExportVoice {
  id: string;
  name: string;
  /** 机器可读的类型 */
  kindId: 'builtin' | 'design' | 'clone';
  /** 元数据里的 kind：内置音色 / 文字设计 / 样本复刻（中文，打开 json 就能读懂） */
  kindLabel: string;
  /** 生成方式（一句话），与用户填的「描述」分两个字段写 */
  generation: string;
  description: string;
  createdAt: string;
  isDefault: boolean;
  /** 桥侧是否真有样本文件（内置音色恒为 false；与列表里「样本丢失」标记同一判据 hasSample） */
  hasSample: boolean;
  /** 没有样本文件时的中文原因：既写进元数据，也用于提示语 */
  noSampleReason: string;
  /** 桥侧记录的样本字节数（没有样本时为 0） */
  sampleBytes: number;
  /** 内置音色的语言与性别（仅内置音色有，写进元数据） */
  lang?: string;
  gender?: string;
}

/** 文件名里不能出现的字符换成下划线（Windows 与 Linux 的合集），掐掉首尾的点与空白并截断。
 *  全被替换掉时给一个兜底名 —— 否则会写出一个没有主文件名、只有后缀的文件。 */
function safeFilePart(s: string): string {
  const t = String(s ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 60);
  return t || '未命名';
}

/** 导出的基础名：一眼看出是哪个音色。带上音色 id —— 音色库允许重名，只靠名字分不开。 */
const exportBaseName = (v: ExportVoice) =>
  `音色-${safeFilePart(v.name)}-${safeFilePart(v.kindLabel)}-${safeFilePart(v.id)}`;

/** 音频后缀 → MIME（保存框的 accept 与 `<a download>` 的 Blob 类型都要用）。 */
const audioMimeOf = (ext: string) => (ext === '.wav' ? 'audio/wav' : 'audio/mpeg');

/** 一份 .json 元数据（与音频同名，只差后缀；没有音频时 `sampleFileName` 为 null）。 */
function exportMetaOf(v: ExportVoice, sampleFileName: string | null, sampleBytes: number, exportedAt: string) {
  return {
    schema: 'kizuna.voice-export/1',
    note: 'Kizuna 语音页导出的音色：音频文件与本文件同名（只差后缀）；没有样本文件的音色只有这一份 json。',
    exportedAt,
    id: v.id,
    name: v.name,
    kind: v.kindLabel,
    kindId: v.kindId,
    generation: v.generation,
    description: v.description,
    createdAt: v.createdAt || '（桥侧未记录创建时间）',
    isDefault: v.isDefault,
    hasSampleFile: !!sampleFileName,
    sampleFileName,
    sampleBytes: sampleBytes || 0,
    noSampleReason: sampleFileName ? null : v.noSampleReason,
    ...(v.lang ? { lang: v.lang } : {}),
    ...(v.gender ? { gender: v.gender } : {}),
  };
}

/** 内置音色 → 导出形状。内置音色的声音由语音服务按待朗读文本现合成，桥侧**没有**样本文件。 */
function builtinExportVoice(
  v: { id: string; label: string; lang: string; gender: string; note: string },
  isDefault: boolean,
): ExportVoice {
  return {
    id: v.id,
    name: v.label,
    kindId: 'builtin',
    kindLabel: '内置音色',
    generation: '官方内置音色：由语音服务在每次合成时现产生，桥侧不保存样本文件',
    description: v.note || '',
    createdAt: '',
    isDefault,
    hasSample: false,
    noSampleReason: '内置音色没有样本文件（它的声音由语音服务现合成），只能导出配置信息',
    sampleBytes: 0,
    lang: v.lang,
    gender: v.gender,
  };
}

/** 自建音色 → 导出形状。`hasSample` 与列表里的「样本丢失」标记同一判据：
 *  只有复刻型且 samplePath 对应的文件真的存在，才算"有样本文件"，
 *  文字设计音色的 frozen 锚点不算样本文件（那是它合成时用的参考，不是用户给的样本）。 */
function customExportVoice(v: CustomVoice, isDefault: boolean): ExportVoice {
  const clone = v.kind === 'clone';
  return {
    id: v.id,
    name: v.name,
    kindId: clone ? 'clone' : 'design',
    kindLabel: clone ? '样本复刻' : '文字设计',
    generation: clone
      ? `音频样本复刻：以一段上传的 mp3/wav 样本复刻该音色${v.sampleBytes ? `（桥侧记录的样本 ${v.sampleBytes} 字节）` : ''}`
      : '文字描述生成：每次合成都依据这段描述生成音色，桥侧不保存样本文件',
    description: v.description || '',
    createdAt: v.createdAt || '',
    isDefault,
    hasSample: clone && v.hasSample === true,
    noSampleReason: clone
      ? '这个复刻音色的样本文件已丢失（音色样本目录里找不到它），只能导出配置信息'
      : '文字设计音色没有样本文件，只能导出配置信息',
    sampleBytes: Number(v.sampleBytes) || 0,
  };
}

/** 音频后缀：先认 Content-Type（桥侧是按**文件内容** sniff 出来的，比文件名可靠），
 *  再退到 Content-Disposition 里的中文文件名。 */
function audioExtOf(contentType: string, disposition: string | null): string {
  const t = contentType.toLowerCase();
  if (t.includes('wav')) return '.wav';
  if (t.includes('mpeg') || t.includes('mp3')) return '.mp3';
  try {
    const m = /filename\*=UTF-8''([^;]+)/i.exec(String(disposition ?? ''));
    const e = m ? /\.([a-z0-9]{2,4})$/i.exec(decodeURIComponent(m[1])) : null;
    if (e) return `.${e[1].toLowerCase()}`;
  } catch { /* 文件名解码失败就用下面的兜底 */ }
  return '.mp3';
}

/** 从桥取某个音色的样本音频字节（`GET /api/voice/sample`）。失败时抛出**桥给的中文原因**。
 *  「为什么不走 api()」api() 只认 JSON（且遇非 2xx 直接抛成一句 HTTP 状态），而这里要的是字节流；
 *  失败时桥与管理端回的都是 JSON（`{ ok:false, error|message }`），故自己取响应再按内容类型分流。 */
async function fetchVoiceSample(voiceId: string): Promise<{ data: ArrayBuffer; ext: string }> {
  const res = await fetch(`/api/voice/sample?id=${encodeURIComponent(voiceId)}`);
  const ct = String(res.headers.get('content-type') ?? '');
  if (res.ok && /^audio\//i.test(ct)) {
    return { data: await res.arrayBuffer(), ext: audioExtOf(ct, res.headers.get('content-disposition')) };
  }
  let reason = '';
  try {
    const j: any = await res.json();
    reason = String(j?.error ?? j?.message ?? '');
  } catch { /* 非 JSON：用下面的兜底 */ }
  throw new Error(reason || `取音色样本失败（HTTP ${res.status}）`);
}

/** 目录里是否已有这个名字。File System Access API 没有"查询存在"的接口 —— 不带 create 调
 *  getFileHandle，文件不存在时它抛 NotFoundError，正好当"不存在"用（其它错误也一并按不存在处理，
 *  真写不进去时后面的 create 会抛出真实原因，不会静默丢文件）。 */
async function dirHasFile(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try { await dir.getFileHandle(name); return true; } catch { return false; }
}

/** 在目录里挑一个不重名的基名：音频与它的同名 .json **一起判重**，两者始终同名同序号。
 *  重名时依次试 -2、-3…（到 -200），仍躲不开才加时间戳。 */
async function pickFreeBase(dir: FileSystemDirectoryHandle, base: string, ext: string): Promise<string> {
  const probeExt = ext || '.json';
  for (let i = 1; i <= 200; i++) {
    const cand = i === 1 ? base : `${base}-${i}`;
    if (await dirHasFile(dir, `${cand}${probeExt}`)) continue;
    if (await dirHasFile(dir, `${cand}.json`)) continue;
    return cand;
  }
  return `${base}-${Date.now()}`;
}

/** 往已选目录写一个文件（覆盖由调用方用 pickFreeBase 先行避免）。 */
async function writeToDir(dir: FileSystemDirectoryHandle, name: string, data: BlobPart): Promise<void> {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(data);
  await w.close();
}

/** ③ 兜底：`<a download>` 逐个下载（浏览器自己会给出「文件名 (1)」这类去重，不会覆盖已有文件）。 */
function downloadFile(name: string, data: BlobPart, mime: string): void {
  const url = URL.createObjectURL(new Blob([data], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  /* 「为什么延迟 revoke」点完立刻 revoke，部分浏览器上会让这次下载拿不到数据（表现为"点了没反应"）；
     留 10 秒足够下载开始，之后释放内存。 */
  window.setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export default function VoiceConfig({ onBack }: Props) {
  /* 首帧初值只在挂载时取一次（用 ref，不放在渲染里每次调用 `initialFromCache` —— 那会反复构造
     新对象，也会让据此做的判断漂移）。三份读取各留一份"上一次成功读到的内容"：进页面先把它们
     渲染出来，随后照旧发一次真请求在后台静默校准，读到即原地替换 —— 「正在读取…」把内容整块
     顶掉的中间态因此不再出现。缓存键：配置 voice:config、今日用量 voice:usage、音色库 voice:voices
     （只在成功回包后写入，见 src/lib/read-cache.ts）。 */
  const bootRef = useRef<{
    cfg: VoiceCfg | null;
    builtin: NonNullable<VoiceCfg['builtinVoices']>;
    custom: CustomVoice[];
    usage: VoiceCfg['usage'] | null;
    voicesKnown: boolean;
  } | null>(null);
  if (!bootRef.current) {
    /* 配置：本会话的读取缓存优先，其次跨会话的配置缓存（src/config-cache.ts，另带 localStorage 一级）。
       两者都只装"上一次真实读到的值"；都没有则保持 null（下方字段留空、控件禁用），不以出厂默认值冒充。 */
    const cachedCfg = initialFromCache<VoiceCfg>('voice:config').value ?? getCachedConfig<VoiceCfg>(CFG_VOICE);
    const cachedVoices = initialFromCache<{ builtin?: VoiceCfg['builtinVoices']; custom?: CustomVoice[] }>('voice:voices').value;
    // 缓存里这份有可能是别处写进来的别种形状：数组判定后仍显式收敛一次类型，免得把非数组当清单渲染
    const cachedCustom = cachedVoices && Array.isArray(cachedVoices.custom) ? (cachedVoices.custom as CustomVoice[]) : [];
    bootRef.current = {
      cfg: cachedCfg,
      /* 音色清单：先用音色库那条读取缓存；没有则用配置里的内置音色清单（桥在配置回包里同样返回这一份），
         使「有缓存值就照常显示」对音色库也成立 —— 而不是先把「0 个」当事实渲染一帧。 */
      builtin: cachedVoices?.builtin ?? cachedCfg?.builtinVoices ?? [],
      custom: cachedCustom,
      usage: initialFromCache<VoiceCfg['usage']>('voice:usage').value,
      voicesKnown: !!cachedVoices || (cachedCfg?.builtinVoices?.length ?? 0) > 0,
    };
  }
  const boot0 = bootRef.current!;
  const [cfg, setCfg] = useState<VoiceCfg | null>(boot0.cfg);
  const [custom, setCustom] = useState<CustomVoice[]>(boot0.custom);
  const [builtin, setBuiltin] = useState<VoiceCfg['builtinVoices']>(boot0.builtin);
  /** 音色库是否已有可显示的内容（读取缓存或配置缓存或有回包）：为 false 时用骨架承接，不把「0 个」当成事实。 */
  const [voicesKnown, setVoicesKnown] = useState(boot0.voicesKnown);
  const [loadErr, setLoadErr] = useState('');
/** 读取失败后的自动重试间隔（毫秒，0 = 已读到）。仅用于提示条上如实说明"现在多久重读一次"。 */
  const [autoRetryMs, setAutoRetryMs] = useState(0);
/** 是否处于失败后的自动退避重读中（2026-09-30 起本页不再有「重试」按钮）。
   *  单独用一个布尔量驱动重读循环，而不是让循环去盯着错误文本 —— 见下方 load 的说明。 */
  const [retrying, setRetrying] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /* 配置读取状态：`cfgLoading` 与 `loadErr` 只用于一行行内提示以及各按钮的可用性，
     页面结构在回包之前即已可见，不出现「整页只有一行正在读取」的等待态。
     `touched` 记录本次读取期间表单是否已被改动：已改动则不让迟到的回包覆盖用户刚输入的内容。 */
  const [cfgLoading, setCfgLoading] = useState(true);
  const touched = useRef(false);
/** 配置是否已读到（缓存或回包）。为 false 时全部字段留空且不可编辑、保存禁用。 */
  const ready = cfg !== null;

  /* 各字段初值：与上面的 `cfg` 同一份来源（读取缓存优先，其次配置缓存），有缓存值就照常显示并可编辑，
     没有才留空（见文件上方 VoiceForm 说明）。 */
  const [boot] = useState<VoiceForm>(() => (boot0.cfg ? voiceFormOf(boot0.cfg) : emptyVoiceForm()));
  const [enabled, setEnabled] = useState<boolean | null>(boot.enabled);
  const [defaultVoice, setDefaultVoice] = useState(boot.defaultVoice);
  const [style, setStyle] = useState(boot.style);
  const [format, setFormat] = useState(boot.format);
  const [maxChars, setMaxChars] = useState<number | undefined>(boot.maxChars);
  const [dailyChars, setDailyChars] = useState<number | undefined>(boot.dailyChars);
  const [cacheEnabled, setCacheEnabled] = useState<boolean | null>(boot.cacheEnabled);
  const [probPct, setProbPct] = useState<number | undefined>(boot.probPct);   // 主动发语音概率（百分数呈现，桥上按 0~1 存储）
  const [coolMin, setCoolMin] = useState<number | undefined>(boot.coolMin);   // 语音冷却时长（分钟）
/** 「全语音发送模式」send.allVoice：开启后机器人的回复一律以语音发出（是否实际发送由桥侧决定，本页仅读写配置）。 */
  const [allVoice, setAllVoice] = useState<boolean | null>(boot.allVoice);
/** 「音色稳定模式」stableVoice：开启后桥侧忽略每条消息的语气标注，只用全局风格合成（见桥 core/voice.js）。 */
  const [stableVoice, setStableVoice] = useState<boolean | null>(boot.stableVoice);
  const [asrLanguage, setAsrLanguage] = useState(boot.asrLanguage);
  const [models, setModels] = useState<Record<string, { baseUrl: string; model: string; apiKey: string }>>(boot.models);

  /* 本地语音引擎（Genie / GPT-SoVITS sidecar，2026-09-28 新增）。三份状态：
   *   localEngine —— 配置本体（读写都随「应用配置」走；初值一定是对象，见 LOCAL_FORM_DEFAULTS）；
   *   localStat   —— **按需**探测的结果（GET /api/voice/local）；
   *   localMsg    —— 自检/关进程的结果提示。 */
  const [localEngine, setLocalEngine] = useState<LocalCfg | null>(null);
  const [localStat, setLocalStat] = useState<LocalStat | null>(null);
  const [localMsg, setLocalMsg] = useState('');
  const [localBusy, setLocalBusy] = useState<string | null>(null);
  /** 自动检测的"进行中"标记与失败文本（2026-10-02：使用方要求「检测状态改为自动检测，去掉按钮」）。
   *  两者都只喂给状态行那一处 —— 失败不弹错、不刷屏，就是那一行小字（见下面那条自动探测的 useEffect）。 */
  const [localProbing, setLocalProbing] = useState(false);
  const [localProbeErr, setLocalProbeErr] = useState('');
  /* 查看目标（2026-10-01 新增，见文件上方 scopeQuery 的说明）：三档的取值与含义在
   * VOICE_SCOPE_OPTIONS；本卡四个请求（探测/自检/试听/关闭）都带上它。 */
  const [localScope, setLocalScope] = useState<VoiceScopeChoice>(() => readVoiceScope());
  /* 本地引擎试听（本次新增）：桥侧 `POST /api/voice/local {action:'preview'}` 真合成一句，
   * 回包里带 wav 的 base64。文本可改（默认一句中文短句），结果读数与失败原因单独一条提示，
   * 不与上面那句 localMsg 抢位置（自检/关进程的结论要留在卡上）。 */
  const [localPvText, setLocalPvText] = useState('你好，我是本地语音引擎。');
  /* 试听忙碌态：**按按钮分别持有**（`'default'` = 角色那一行；`lvid` = 「我的音色」里某一条），
   * 与云端试听同一套写法 —— 点一个按钮不该让全场置灰。2026-10-02 从布尔量改成键之后，
   * 一行里多个试听按钮各转各的圈。 */
  const [localPvBusy, setLocalPvBusy] = useState<string | null>(null);
  const [localPvMsg, setLocalPvMsg] = useState('');
  /* ── 本地音色档案（2026-10-02 新增）─────────────────────────────────────────
   * 「使用方要的」：本地这侧也能像云端那样"上传一段样本音频 → 取个名字 → 新建一个音色"，
   * 之后能在列表里试听 / 删除，也能把它设成机器人的默认音色（桥侧按 clone 走这段样本）。
   * 清单的权威源是桥（`GET /api/voice/local` 的 `localVoices`，随探测一起回）—— 界面只缓存这一份。 */
  const [localVoices, setLocalVoices] = useState<LocalVoice[]>([]);
  /** 新建表单：名字 / 可选参考文本 / 样本（上传的文件 或 已有音色）。
   *  2026-10-02 二次改造：**基础角色不再进表单**（原来那个 lvChar 下拉去掉了）——
   *  用户只管传音频，角色由桥按实时读数自己挑（桥侧 autoBaseCharacter）。 */
  const [lvName, setLvName] = useState('');
  const [lvPrompt, setLvPrompt] = useState('');
  const [lvSample, setLvSample] = useState<{ name: string; base64: string; bytes: number } | null>(null);
  const [lvFromVoice, setLvFromVoice] = useState('');
  /** 新建/删除的忙碌键（'create' / 'del-<id>'），与上面试听的键分开：一个操作不该锁住另一个的按钮 */
  const [lvBusy, setLvBusy] = useState<string | null>(null);
  const lvFileRef = useRef<HTMLInputElement | null>(null);
  /** 当前档位下角色为空、而**本机**那侧有角色时，本机探测到的角色数（下面那条"一键切过去"的提示用）。
   *  null = 没探到 / 本机也没角色 / 本机桥没起来 —— 一律不提示，绝不报错刷屏。 */
  const [otherSideChars, setOtherSideChars] = useState<number | null>(null);
/** 「高级」折叠区（引擎目录/模型目录/端口/进程参数）是否展开。默认收起，见 .lrn-adv-toggle。 */
  const [advOpen, setAdvOpen] = useState(false);
/** 用户是否已在本页动过本地引擎那几项。动过之后，迟到的配置回包不许覆盖（见 applyCfg）。 */
  const localTouched = useRef(false);
/** 本地引擎每一项的改动都走这里：先登记"用户动过"，再写状态。 */
  const patchLocal = useCallback((patch: Partial<LocalCfg>) => {
    localTouched.current = true;
    setLocalEngine((c) => ({ ...LOCAL_FORM_DEFAULTS, ...(c ?? {}), ...patch }));
  }, []);
  /** 切换「查看目标」：记住选择，并把上一个目标留下的读数与提示一并清掉。
   *  「为什么必须清」状态行上的读数与提示都属于**上一次请求的那一侧** ——
   *  切到「本机」却继续显示服务端那份「环境尚不可用；可选角色 0 个」，与谎言无异
   *  （这正是本次要修的那个坑的另一半）。清空后的文案由 charHint 说明怎么读回来。 */
  const changeLocalScope = (v: VoiceScopeChoice) => {
    writeVoiceScope(v);
    if (v === localScope) return;          // 重复点当前这一档：不动读数
    setLocalScope(v);
    setLocalStat(null);
    setLocalMsg('');
    setLocalPvMsg('');
    /* 「我的音色」与上面那份读数同理：它们是**上一次请求的那一侧**的档案（桥侧各自存在自己的
     * state/local-voices.json 里），切了目标却继续列着另一侧的档案，等于让人对着不存在的东西点删除。 */
    setLocalVoices([]);
    setOtherSideChars(null);
  };

  // 试听
  // 2026-09-15 修按钮状态机：试听每个按钮各自持有忙碌状态（pvBusy[来源]=true）：
  // 原实现令所有试听按钮共用一个 busy 字符串并采用 disabled={busy!==null}，点击一个即全场置灰，观感如同全部在试听。
  // pvSeq 每次试听递增，用作 <audio> 的 key：命中缓存时 URL 完全相同，不更换 key 浏览器即不会重新
  // 加载与播放，表现为「点击后无反应」（本次一并修复）。
  const [preview, setPreview] = useState<{ url: string; label: string } | null>(null);
  /* 「刚试听出来的这段音频」（2026-10-02 新增）：云端音色设计/复刻试听成功后把它留一份，
   * 于是本地那张卡能直接给出「以此音频新建本地音色」——用户不必先下载再上传。
   * 只对**云端现场生成**的那两种（design / clone）记录；内置音色那种试听同样会记（也是音频），
   * 但按钮文案会写清"用刚试听的音频"，用户看得见自己拿的是哪一段。 */
  const [previewAudio, setPreviewAudio] = useState<{ label: string; base64: string; bytes: number } | null>(null);
  const [pvBusy, setPvBusy] = useState<Record<string, boolean>>({});
  const [pvSeq, setPvSeq] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // 新建音色
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [sample, setSample] = useState<{ name: string; base64: string; bytes: number } | null>(null);
  /** ③「用已有音色当样本」（2026-09-26 新增）：直接取某个已有音色的声音当新音色的复刻样本。
   *  与②二选一 —— 上传了文件就以文件为准（用户手上那段音频永远优先于系统取样）。 */
  const [sampleFrom, setSampleFrom] = useState('');
  const fileRef = useRef<HTMLInputElement | null>(null);
  /** 导出进行中的键（某个音色 id，或 'all'）：导出期间全部导出按钮一并置灰 ——
   *  同时往一个目录里写两份导出会互相插队，重名探测也会读到对方刚写的文件。 */
  const [expBusy, setExpBusy] = useState<string | null>(null);

  /* ── 自定义测试文本 + 保存并冻结（2026-10-02 新增）───────────────────────────
   * 使用方原话：「加一个输入框，可以输入自定义的文本来测试，保存并冻结」。
   * 位置放在「语音功能」卡里 —— 它测的就是这张卡配的那个云端音色（默认音色 + 全局风格指令 + 音频格式）。
   *   · ctText ：要合成的那段文本（默认就是原来写死的那句试听文本）；
   *   · ctBusy ：忙碌键（'synth' / 'freeze' / 'local'），与页面其它忙碌态互不干扰；
   *   · ctMsg  ：结果行，成功与失败都逐字写在这里（音频播放仍走页面下方那个既有播放器）；
   *   · ctName ：给"冻结出来的参考样本"与"新建的本地音色"起的名字（留空则自动命名）。 */
  const [ctText, setCtText] = useState(CUSTOM_TEST_TEXT);
  const [ctBusy, setCtBusy] = useState<string | null>(null);
  const [ctMsg, setCtMsg] = useState('');
  const [ctName, setCtName] = useState('');

  /* 三档写盘能力在渲染时探一次：用于把「本浏览器不支持选文件夹、会退成什么」**一直**写在页面上，
     而不是点完才发现（需求：降级必须如实提示，不许静默）。 */
  const fsa = (() => {
    const w = window as FsaWindow;
    return { folder: typeof w.showDirectoryPicker === 'function', save: typeof w.showSaveFilePicker === 'function' };
  })();

/** 把一份配置写入表单。 */
/**  · `overwrite = true`（保存回包、清空密钥回包）：整份覆盖，以桥上返回的值为准； */
/**  · `overwrite = false`（首次读取的回包）：只登记配置本体（供预置地址、角色说明与用量读数使用）， */
/**    不覆盖表单字段 —— 用户若在回包到达之前已经动过表单，其输入必须保留。 */
  const applyCfg = useCallback((c: VoiceCfg, overwrite = true) => {
    setCfg(c);
    setBuiltin(c.builtinVoices ?? []);
    /* 本地引擎配置属"配置本体"，与表单字段分开存：即使表单已被用户改动（overwrite=false），
     * 这份也要跟着回包走，否则「应用配置」会把本地引擎那一段洗回默认值。
     * 回包里没有 `local`（键还没被保存过 / 老一些的桥不返回它）时用界面自带的初值兜底，
     * 不然那张卡会整张变成灰的、一个字段也改不了（见 LOCAL_FORM_DEFAULTS 的说明）。
     * 【2026-09-28 补】例外：用户已经在这张卡上动过手（localTouched）就不覆盖 —— 这张卡的字段
     * 现在一进页面就能编辑（不再等配置读回来），所以"回包晚到"与"用户先改"很容易撞上，
     * 此时必须保留用户刚选的项，否则会出现"我明明勾了启用、过两秒自己弹回未勾"。 */
    if (!localTouched.current) setLocalEngine({ ...LOCAL_FORM_DEFAULTS, ...(c.local ?? {}) });
    if (!overwrite) return;
    const f = voiceFormOf(c);
    setEnabled(f.enabled);
    setDefaultVoice(f.defaultVoice);
    setStyle(f.style);
    setFormat(f.format);
    setMaxChars(f.maxChars);
    setDailyChars(f.dailyChars);
    setCacheEnabled(f.cacheEnabled);
    setProbPct(f.probPct);
    setCoolMin(f.coolMin);
    // 全语音发送模式：缺失或非布尔值一律按 false 处理（旧配置无 send.allVoice 即普通模式），不报错
    setAllVoice(f.allVoice);
    setStableVoice(f.stableVoice);
    setAsrLanguage(f.asrLanguage);
    setModels(f.models);
  }, []);

/** 读取语音配置。返回是否成功 —— 供下面的自动退避重试用（2026-09-30 起失败不再给「重试」按钮）。 */
/**  注意：本函数不在开头清 loadErr（原文是 `setLoadErr('')`）。若每轮开头都清， */
/**  提示条会一闪一闪，且退避循环若以 loadErr 为依赖，会每轮被重置回 5 秒； */
/**  失败原因留到下一次成功为止更稳。重读循环改由 `retrying` 布尔量驱动。 */
  const load = useCallback(async (): Promise<boolean> => {
    setCfgLoading(true);
    try {
      /* 取数与整形都在模块级的 readVoiceData 里（与下方 warmVoicePage 预热共用同一段逻辑，
         两边写进缓存的形状因此必然一致）；它读失败时抛错，由下面的 catch 按原口径兜底。 */
      const { cfg: c, voices } = await readVoiceData();
      /* 成功读到即写入模块级缓存：下次进入本页先按这份真实值渲染，切换页面时不闪默认值。 */
      rememberConfig(CFG_VOICE, c);
      /* 同时写本会话的读取缓存（只在成功回包后写；失败路径不写，见下方 catch）：
         配置 / 今日用量 / 音色库各占一个键，下次进本页首帧即可照着渲染，不必再等一次回包。 */
      writeCacheValue('voice:config', c);
      // 用量随配置一起回包，但单独占一条键：配置本体尚未读到（或读取失败）时，「今日用量」也能先出旧值
      if (c.usage) writeCacheValue('voice:usage', c.usage);
      writeCacheValue('voice:voices', voices);
      // 表单若已被改动，则只登记配置本体，不用回包覆盖输入（见 applyCfg 的 overwrite 参数）
      applyCfg(c, !touched.current);
      setBuiltin(voices.builtin);
      setCustom(voices.custom);
      // 音色库这一次是真读到了（哪怕是空清单）：此后不再以骨架承接
      setVoicesKnown(true);
      setLoadErr('');
      setRetrying(false);
      return true;
    } catch (e: any) {
      setLoadErr(pickErr(e));
      setRetrying(true);
      return false;
    } finally { setCfgLoading(false); }
  }, [applyCfg]);

  useEffect(() => { void load(); }, [load]);

  /* 2026-09-30 修改要求：读取失败不再要人"点重试再刷新"，改为自动重试，页面上不出现重试按钮：
     失败后按 5 → 10 → 20 → 40 → 60 秒（封顶 60 秒）逐档拉长重读，读到即停（retrying 置回 false → 本 effect 退出）。
     失败事实照常显示在提示条上（原因来自 pickErr），页面不会变成"永远转圈"。
     循环由 `retrying` 布尔量驱动（load 不会在开头清它），故失败原因文本无论如何变化，
     退避档位都不会被重置回 5 秒。 */
  useEffect(() => {
    if (!retrying) { setAutoRetryMs(0); return; }
    let alive = true;
    let backoff = 5000;
    let t: number | null = null;
    const step = () => {
      setAutoRetryMs(backoff);
      t = window.setTimeout(() => {
        if (!alive) return;
        backoff = Math.min(60000, backoff * 2);
        void load().finally(() => { if (alive) step(); });
      }, backoff);
    };
    step();
    return () => { alive = false; if (t !== null) window.clearTimeout(t); };
  }, [retrying, load]);

/** 点击预置：将该项预置声明的字段直接写入表单（受控 state，修改后立即显示于输入框）。 */
/**  · 请求地址：必定覆盖 —— 切换预置本就是为了更换端点；地址优先取桥返回的 presets（权威来源）， */
/**    桥未运行或旧版桥未返回时使用 PRESETS 中的本地常量，绝不写入空串。 */
/**  · 模型名：仅补空白输入框（用户手工修改过的模型名不被覆盖；两个预置同属小米，模型 id 相同）。 */
/**  · 密钥、格式、试听等其余字段一律不改动。 */
  const applyPreset = (p: typeof PRESETS[number]) => {
    const fromBridge = cfg?.presets?.[p.key];
    const baseUrl = (typeof fromBridge === 'string' && fromBridge.trim()) ? fromBridge.trim() : p.baseUrl;
    setModels((prev) => {
      const next: Record<string, { baseUrl: string; model: string; apiKey: string }> = { ...prev };
      for (const r of ROLE_ORDER) {
        const cur = next[r] ?? { baseUrl: '', model: '', apiKey: '' };
        next[r] = { ...cur, baseUrl, model: cur.model.trim() ? cur.model : (p.models[r] ?? '') };
      }
      return next;
    });
    setMsg(`已按「${p.label}」填入请求地址：${baseUrl}（模型名仅补空白输入框，已填写者不变）`);
  };

  const save = async () => {
    setBusy('save');
    try {
      const patch: any = {
        enabled, defaultVoice, style: style.trim(), format,
        /* 音色稳定模式：与 enabled 一样是**顶层严格布尔**（桥侧只认 true/false，收到别的值就保持原值），
           所以这里直传 state，不要写成 `stableVoice === true` —— 配置尚未读取（null）时须让桥保留原值。 */
        stableVoice,
        maxChars: Number(maxChars) || 120, dailyChars: Number(dailyChars) || 0,
        cacheEnabled, asrLanguage,
        // 主动发语音的节奏：界面以百分数与分钟表示，桥侧存 0~1 的概率与毫秒冷却；allVoice 为全语音发送模式
        send: {
          probability: Math.max(0, Math.min(100, Number(probPct) || 0)) / 100,
          cooldownMs: Math.max(0, Number(coolMin) || 0) * 60000,
          allVoice,
        },
        models: Object.fromEntries(ROLE_ORDER.map((r) => [r, {
          baseUrl: models[r]?.baseUrl ?? '', model: models[r]?.model ?? '',
          // 仅上传用户实际输入的密钥，留空表示保留原密钥
          ...(models[r]?.apiKey ? { apiKey: models[r].apiKey } : {}),
        }])),
        /* 本地引擎（2026-09-28）：整段回传（桥侧对每个字段各自做类型/范围校验，认不出的键会被丢掉）。
         * 现在 `localEngine` 一定有值（回包缺这段时用界面初值兜底，见 LOCAL_FORM_DEFAULTS），
         * 所以这里恒带 `local` —— 用户在这张卡上看到的每一项都会随保存落进 config.json。 */
        local: localEngine ?? LOCAL_FORM_DEFAULTS,
      };
      const r = await api<VoiceCfg>('/voice/config', { method: 'PUT', body: JSON.stringify(patch) });
      if ((r as any)?.ok !== true) { setMsg(`保存失败：${pickErr(r)}`); return; }
      /* 保存成功即更新缓存：切走再回来看到的是刚保存的这份配置。 */
      rememberConfig(CFG_VOICE, r);
      // 保存回包即新的配置本体：直接覆盖本会话的读取缓存（内容已变，旧值一片都不留）
      writeCacheValue('voice:config', r);
      // 「兼容旧桥」：回包若未带 send.allVoice（旧版桥不认识该字段，只返回其认识的字段），
      // 则按刚提交的值显示，避免开关自行弹回关闭状态；若带回 allVoice 则一律以桥返回值为准。
      const echoed = r?.send;
      /* stableVoice 同理：旧版桥不认识这个顶层字段 → 回包不带该键 → 用刚提交的值顶住，
       * 否则「音色稳定模式」开关保存后会自己弹回关闭状态。 */
      const merged = (typeof echoed?.allVoice === 'boolean' ? r : { ...r, send: { ...(echoed ?? {}), allVoice } }) as VoiceCfg;
      applyCfg((typeof merged?.stableVoice === 'boolean' ? merged : { ...merged, stableVoice }) as VoiceCfg);
      setMsg('语音配置已保存（桥侧立即生效，无需重启）');
    } catch (e: any) {
      setMsg(`保存失败：${pickErr(e)}`);
    } finally { setBusy(null); }
  };

  const runTest = async (role: string) => {
    setBusy(`test-${role}`);
    try {
      const r = await api<any>('/voice/test', { method: 'POST', body: JSON.stringify({ role }) });
      setMsg(r?.ok !== true ? `测试失败：${pickErr(r)}` : `测试通过：${r.detail ?? 'ok'}`);
    } catch (e: any) { setMsg(`测试失败：${pickErr(e)}`); }
    finally { setBusy(null); }
  };

  /* ── 本地语音引擎：状态 / 自检 / 关进程（2026-09-28 新增）────────────────────────
   * 三条都打桥侧 /api/voice/local（管理端只做转发，见 server/index.js 的 voiceLocalRoute）。
   * 2026-10-01：三条（以及下面的试听）都带上「查看目标」的作用域 —— 后端按 `scope` 决定问本机桥
   * 还是服务端那侧，不带 scope 时跟随当前连接（既定语义）。
   * 「自检」会真拉起引擎进程并合成一句：首次冷启动要导入 onnxruntime、加载模型，可能几十秒，
   * 所以那条的代理超时单独给到 180 秒；期间按钮保持忙碌态，不重复发请求。 */
  const readLocalStatus = async (scope: VoiceScopeChoice = localScope) => {
    setLocalBusy('status');
    try {
      /* `?force=1` 后面接作用域：自动时为空串（不带 scope = 保持原行为），本机/服务端时接 `&scope=…`。
       * scope 由参数给（默认当前档）：下面那条"切到本机并重新检测"的提示按钮要在**同一次点击里**
       * 换档并立刻读这一侧 —— 那时 state 还是旧值，读 state 会读回上一侧（这正是要避免的）。 */
      const r = await api<LocalStat>(`/voice/local?force=1${scopeQuery(scope, '&')}`);
      if (r?.ok !== true) { setLocalMsg(`状态读取失败：${pickErr(r)}`); return; }
      setLocalStat(r);
      if (Array.isArray(r.localVoices)) setLocalVoices(r.localVoices);
      setLocalMsg('');
    } catch (e: any) { setLocalMsg(`状态读取失败：${pickErr(e)}`); }
    finally { setLocalBusy(null); }
  };

  const runLocalSelfTest = async () => {
    setLocalBusy('test');
    try {
      const r = await api<any>(`/voice/local${scopeQuery(localScope)}`, { method: 'POST', body: JSON.stringify({ action: 'self-test' }) });
      if (r?.ok !== true) { setLocalMsg(`自检失败：${pickErr(r)}`); return; }
      /* 内存读数特意写出来：上游源码注释里写过"修改后内存 6448MB"这种吓人的数字，
       * 那说的是权重数据量（fp16→fp32 展开后的体量），不是进程实际常驻内存 —— 这里给的是实测值。 */
      setLocalMsg(`自检通过：角色「${r.character}」合成 ${r.bytes} 字节，用时 ${r.ms}ms${r.serverStarted ? '（含引擎冷启动）' : ''}，引擎常驻内存 ${r.rssMb ?? '?'}MB`);
      setLocalStat((s: any) => ({ ...(s ?? {}), running: true, pid: r.pid, rssMb: r.rssMb }));
    } catch (e: any) { setLocalMsg(`自检失败：${pickErr(e)}`); }
    finally { setLocalBusy(null); }
  };

  const stopLocalEngine = async () => {
    setLocalBusy('stop');
    try {
      const r = await api<any>(`/voice/local${scopeQuery(localScope)}`, { method: 'POST', body: JSON.stringify({ action: 'stop' }) });
      if (r?.ok !== true) { setLocalMsg(`关闭失败：${pickErr(r)}`); return; }
      setLocalMsg(r.stopped ? '引擎进程已关闭（内存已回收；下次合成会按需重新拉起）' : '引擎进程本来就没在跑');
      setLocalStat((s: any) => ({ ...(s ?? {}), running: false, pid: null, rssMb: null }));
    } catch (e: any) { setLocalMsg(`关闭失败：${pickErr(e)}`); }
    finally { setLocalBusy(null); }
  };

  /* 本地引擎试听（本次新增）：真让引擎把「试听文本」合成一句，回包里带 wav 字节。
   * 「为什么用 `new Audio(data:...)` 直放，而不是页面上那套 <audio ref> 状态机」：这条路径固定出 wav、
   * 只播一次，不需要缓存命中重播那一套；两套播放器互不干扰，云端试听的结果也不会被这里顶掉。
   * 失败原因（引擎没装、角色没选、模型加载失败…）桥侧写在 `reason` 里，必须原样显示 —— 只报一句
   * "试听失败"等于没给排查线索。
   * 2026-10-02：加 `voiceId` —— 传了就用**那个本地音色档案**试听（桥侧走 clone：档案的基础角色 +
   * 档案的参考音频），不传就是老行为（用「默认角色」）。两种走的是同一个按钮、同一条报文、同一处提示，
   * 不另造一套试听。 */
  const previewLocal = async (voiceId = '', label = '') => {
    const key = voiceId || 'default';
    if (localPvBusy) return;
    setLocalPvBusy(key);
    try {
      const r = await api<LocalPreviewResp>(`/voice/local${scopeQuery(localScope)}`, {
        method: 'POST',
        body: JSON.stringify({
          action: 'preview',
          text: localPvText,
          character: String(localEngine?.character ?? ''),
          ...(voiceId ? { voiceId } : {}),
        }),
      });
      if (r?.ok !== true) { setLocalPvMsg(`试听失败：${r?.reason || pickErr(r)}`); return; }
      if (!r.audioBase64) { setLocalPvMsg('试听失败：桥回包里没有音频字节'); return; }
      const mime = r.mime || 'audio/wav';
      try {
        const el = new Audio(`data:${mime};base64,${r.audioBase64}`);
        void el.play().catch(() => { /* 被浏览器自动播放策略拦截：读数照常显示，用户可再点一次 */ });
      } catch { /* 播放器构造失败不影响下面的读数 */ }
      setLocalPvMsg(voiceId
        ? `试听完成（音色「${label || r.voiceName || voiceId}」，基础角色 ${r.character}）：合成 ${r.bytes ?? '?'} 字节，用时 ${r.ms ?? '?'}ms（${mime}）`
        : `试听完成：合成 ${r.bytes ?? '?'} 字节，用时 ${r.ms ?? '?'}ms（${mime}）`);
    } catch (e: any) { setLocalPvMsg(`试听失败：${pickErr(e)}`); }
    finally { setLocalPvBusy(null); }
  };

  /* ── 本地音色档案：新建 / 删除 / （下面）一键切到本机 ─────────────────────────────
   * 三条都打同一个 `POST /api/voice/local`（动作不同），scope 口径与上面四条完全一致。 */
  /** 新建：样本优先用**这次上传的文件**；没上传但选了"用已有音色当样本"时把 fromVoiceId 交给桥，
   *  由桥去取那个音色的声音当样本（与云端「新建音色」的 ③ 是同一段桥侧逻辑，见 sampleFromVoice）。 */
  const createLocalVoice = async () => {
    if (lvBusy) return;
    const nm = lvName.trim();
    if (!nm) { setLocalMsg('新建本地音色失败：先给它起个名字'); return; }
    if (!lvSample?.base64 && !lvFromVoice) { setLocalMsg('新建本地音色失败：上传一段音频样本，或选一个已有音色当样本'); return; }
    setLvBusy('create');
    try {
      const body: any = {
        action: 'voice-create',
        name: nm,
        // 基础角色**不再由用户挑、也不由界面传**：桥按本机实时读数自己挑一个已装角色
        // （优先与样本语言对得上的），一个都没装时桥会回一句人话（下面原样显示）。
        promptText: lvPrompt.trim(),
      };
      if (lvSample?.base64) body.sampleBase64 = lvSample.base64;
      else body.fromVoiceId = lvFromVoice;
      const r = await api<any>(`/voice/local${scopeQuery(localScope)}`, { method: 'POST', body: JSON.stringify(body) });
      if (r?.ok !== true) { setLocalMsg(`新建本地音色失败：${pickErr(r)}`); return; }
      if (Array.isArray(r.voices)) setLocalVoices(r.voices);
      setLocalMsg(`本地音色「${r.voice?.name ?? nm}」已创建（样本 ${(Number(r.voice?.sampleBytes) || 0) / 1024 < 1 ? `${Number(r.voice?.sampleBytes) || 0} 字节` : `${((Number(r.voice?.sampleBytes) || 0) / 1024).toFixed(0)}KB`}）：点它那一行的「试听」听听看`);
      setLvName(''); setLvSample(null); setLvFromVoice(''); setLvPrompt('');
      if (lvFileRef.current) lvFileRef.current.value = '';
    } catch (e: any) { setLocalMsg(`新建本地音色失败：${pickErr(e)}`); }
    finally { setLvBusy(null); }
  };

  const removeLocalVoice = async (v: LocalVoice) => {
    if (lvBusy) return;
    setLvBusy(`del-${v.id}`);
    try {
      const r = await api<any>(`/voice/local${scopeQuery(localScope)}`, { method: 'POST', body: JSON.stringify({ action: 'voice-delete', id: v.id }) });
      if (r?.ok !== true) { setLocalMsg(`删除失败：${pickErr(r)}`); return; }
      if (Array.isArray(r.voices)) setLocalVoices(r.voices);
      setLocalMsg(`本地音色「${v.name}」已删除${r?.deleted?.sampleRemoved ? '（样本文件已一并删除）' : '（桥侧本来就没有它的样本文件）'}`);
    } catch (e: any) { setLocalMsg(`删除失败：${pickErr(e)}`); }
    finally { setLvBusy(null); }
  };

  /** 「切到本机并重新检测」：用户点一下就走完"记住选择 → 探测本机 → 刷新下拉框"，
   *  不必理解 scope 是什么。**只在用户点击时发生**，不改默认档语义、不做自动切换。 */
  const switchToLocalAndProbe = async () => {
    changeLocalScope('local');
    await readLocalStatus('local');
  };

  /** 选本地音色的样本文件：大小与格式在**选的那一刻**就把话说清楚（桥侧还有一道同样的闸门）。 */
  const onPickLocalSample = (f: File | null) => {
    if (!f) return;
    if (f.size > LOCAL_SAMPLE_MAX_BYTES) {
      setLocalMsg(`样本过大（${(f.size / 1024).toFixed(0)}KB，上限 ${LOCAL_SAMPLE_MAX_BYTES / 1024}KB）：本地这条路走 base64 上传（桥请求体上限 1MB），请剪短一些再传`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const data = String(reader.result || '');
      setLvSample({ name: f.name, base64: data.replace(/^data:[^,]+,/, ''), bytes: f.size });
      setLocalMsg('');
    };
    reader.readAsDataURL(f);
  };

  /* 云端那块刚试听出来的那段音频（design/clone 的试听结果）能不能直接拿来当本地音色的样本？
   * 能 —— 它就在浏览器的 `preview.url`（data URL）里，一行就能取到，不必让用户再下载再上传。
   * 只有"云端刚生成出来的音频"才给这个入口：`previewAudio` 由 doPreview 在 design/clone 时记下。 */
  const usePreviewAudioAsSample = () => {
    if (!previewAudio) return;
    if (previewAudio.bytes > LOCAL_SAMPLE_MAX_BYTES) {
      setLocalMsg(`「${previewAudio.label}」这段音频有 ${(previewAudio.bytes / 1024).toFixed(0)}KB，超过本地上限 ${LOCAL_SAMPLE_MAX_BYTES / 1024}KB：本地这条路走 base64 上传（桥请求体上限 1MB）；可以在音色库里先把它存成复刻音色，再用下面的「用已有音色当样本」（那条由桥直接取样本，不受这个上限限制）`);
      return;
    }
    setLvSample({ name: `${previewAudio.label}.mp3`, base64: previewAudio.base64, bytes: previewAudio.bytes });
    setLvFromVoice('');
    setLocalMsg(`已把刚试听的「${previewAudio.label}」（${(previewAudio.bytes / 1024).toFixed(0)}KB）当作样本：填个名字就能点「创建」`);
  };

/* ── 本地引擎卡的派生值 ──────────────────────────────────────────────── */
  /* 角色清单的归一化：以 `characterList`（对象数组）为准，为空/不存在时回退 `characters`
   * （字符串数组，旧界面在用）。两种形状都收成同一份 `LocalChar`，后面（下拉框、小字、状态行）
   * 一律按这一份用（归一化规则与单测在 `src/lib/char-list.ts`）。 */
  const charList = useMemo<LocalChar[]>(() => normalizeChars(localStat), [localStat]);

  /* 「默认角色」下拉框的选项：桥侧状态接口报回来的角色目录名（modelsDir 下带 .onnx 的子目录），
   * 显示成「标签（语言）」（标签为空退回目录名，语言不认识就不写括号）。
   * 空值项 = 自动匹配（按请求的音色名找同名角色，都没有就用第一个可用角色）。 */
  const charOptions = useMemo(() => {
    const list = charList.slice();
    const cur = String(localEngine?.character ?? '').trim();
    /* 配置里已经写着、但当前目录里扫不到的角色也要能显示出来（否则触发器会显示成空白，
     * 用户会以为配置丢了；它仍然原样保存，只是此刻目录里没有这个角色）。 */
    if (cur && !list.some((c) => c.name === cur)) list.unshift({ name: cur, label: '', language: '' });
    return [
      { value: '', label: '自动（按请求的音色名匹配）' },
      ...list.map((c) => ({ value: c.name, label: charDisplay(c) })),
    ];
  }, [charList, localEngine?.character]);

  /* 「新建本地音色」里原来那个基础角色下拉（2026-10-02）已在同一天去掉：使用方要的是"上传的音频
   * 就是音色"，不该让人先理解"引擎角色决定发音"这件事。角色改由桥自动挑（桥侧 autoBaseCharacter：
   * 优先语言与样本对得上的已装角色，其次引擎默认/任意一个），界面一个字段都不传。
   * 上面那个「默认角色」下拉仍在（它管的是**没指定音色时**用哪个角色合成），与本表单无关。 */

  /* 角色下拉框下面那行小字：有多少个能选 / 一个都没有时怎么说。
   * 空的时候这里只说"没有"，两条安装命令摊在卡片下方那条说明里（命令很长，塞进这行小字会挤成一团）。
   * 2026-10-02：角色为空而**本机那侧有角色**时，这里直接点名"你看的是服务端、本机有几个"，
   * 并指向下面那个一键按钮 —— 使用方"三个角色我没看见"就是卡在这一步（见 otherSideChars 那段说明）。 */
  /** 当前档位对应的"那一台"，界面文案里用它说清"你正在看哪台机器"。
   *  只写两种：本机 / 服务端（自动档在能连上服务端时读的就是服务端那侧）。
   *  下面那条"角色不在这一侧"的提醒只在「本机有、这一侧没有」时出现 —— 那时当前目标必不是本机，
   *  所以自动档写成服务端是准确的，不是猜的。 */
  const curSideLabel = localScope === 'local'
    ? '本机'
    : (localScope === 'remote' ? '服务端' : '自动（跟随连接）＝服务端');
  const charHint = useMemo(() => {
    if (!localStat) return '角色来自引擎的模型目录；进页面与切换目标时会自动探测，读到就列在这里';
    if (!charList.length) {
      if (otherSideChars) {
        return `当前看的是${curSideLabel}：它上面没有角色；本机有 ${otherSideChars} 个 —— 点下面的「切到本机并重新检测」即可看到`;
      }
      return '还没有安装任何角色（装好后刷新本页，或切一下「查看目标」，就会列出来）';
    }
    return `共 ${charList.length} 个角色可选；改相关设置或切换目标时会自动重读目录`;
  }, [localStat, charList, otherSideChars, curSideLabel]);

  /* 状态行的悬停详情：只在排查时看的那些读数（解释器/分词后端/目录）。
   * 2026-10-01 修：目录与地址在桥的回包里位于 `paths` 那一层（见 LocalStat.paths），
   * 此前只读顶层同名键 → 悬停里「引擎目录 / 角色模型目录 / 引擎地址」三行一直是空的。
   * 现在 `paths` 优先、顶层兜底：本机档显示 `D:\Kizuna\resources\runtime\qq-bridge\python`，
   * 自动/服务端档显示服务器那份 `/root/qq-bridge/python`。 */
  const localDetail = useMemo(() => {
    if (!localStat) return '';
    const p = localStat.paths ?? {};
    const rootDir = p.rootDir || localStat.rootDir || '';
    const modelsDir = p.modelsDir || localStat.modelsDir || '';
    const engineUrl = p.url || localStat.url || '';
    return [
      `解释器 ${localStat.python || '?'}${localStat.pythonVersion ? `（Python ${localStat.pythonVersion}）` : ''}`,
      localStat.jiebaShim ? `分词后端：${localStat.jiebaShim.reason ?? '未知'}` : '',
      rootDir ? `引擎目录 ${rootDir}` : '',
      modelsDir ? `角色模型目录 ${modelsDir}` : '',
      engineUrl ? `引擎地址 ${engineUrl}` : '',
    ].filter(Boolean).join('\n');
  }, [localStat]);

  /* 「本地引擎为什么现在装不了 / 换了机器怎么办」那块的**结论句**（2026-09-29 使用方要求
   *  「界面上不要有任何写死的东西，并精简，因为我们主要是面向大众」）。
   *  这一句完全由上面那行的探测读数决定（localStat.ready / running / rssMb / localProbeErr），
   *  所以换机器、换「查看目标」时同一段文字自动跟着变，界面里不再留任何本机或某台服务器的
   *  实测数字、目录路径与内部命令行。 */
  const engineVerdict = !localStat
    ? (localProbeErr
      ? `读数没拿到（${localProbeErr}）—— 点上面的「重新检测」再看一次。`
      : '正在读取目标机器的实况，读到就按它判定。')
    : localStat.ready
      ? `满足上面的要求，引擎可用${localStat.running ? `（运行中，常驻 ${localStat.rssMb ?? '?'} MB）` : ''}。`
      : '还不满足上面的要求 —— 具体缺什么，由上面那行读数如实列出，这里不下结论。';

  /* 自动检测引擎状态（2026-10-02 改）。
   * 使用方原话：「检测状态改为自动检测，去掉按钮」——原来那个「检测状态」按钮已经撤掉，
   * 改为**自动**探测，触发点四个（都收在同一条 useEffect 里，共用一个防抖计时器）：
   *   ① 进页面 / 配置读到（localEngine 那几个字段变了）；
   *   ② 切换「查看目标」档位（localScope 变了）；
   *   ③ 本地引擎的相关设置变化（启用开关、默认角色、引擎目录、角色模型目录、本地端口）；
   *   ④ 上一次探测的结果被清掉之后（切档会清，见 changeLocalScope）。
   *
   * 三条硬约束：
   *   · **探测绝不启动引擎进程**：打的还是 `GET /api/voice/local?force=1` —— 桥侧那条只用
   *     `find_spec` 判装没装、再数一下角色目录，不 import 引擎、不拉起 sidecar（原注释里
   *     "要 import、会卡十几秒"的说法早已过期）；
   *   · **别把请求打爆**：等 400ms 没人再动才发，且依赖是一个"拼接出来的键"而不是每次渲染都变的对象 ——
   *     同一次输入抖动最多发一轮；
   *   · **失败只安静显示状态行**：错误文本进 `localProbeErr`，由下面状态行那一处渲染，
   *     不弹错、不刷屏、也**不自动重试**（失败后自动重试会变成一个刷屏循环）。
   *
   * 「为什么设置变了也探一次，但读数仍以桥为准」：引擎目录/模型目录/端口这些字段要等点了「应用配置」
   * 才会写进桥上的 config.json，所以这一读回来的目录/角色**仍是桥上那台的实况** —— 这里是"顺手重读一次"，
   * 不是"改了立刻生效"的承诺（那张卡的说明里也是这么写的）。 */
  const localProbeKey = [
    localScope,
    localEngine?.enabled === true ? '1' : '0',
    String(localEngine?.character ?? ''),
    String(localEngine?.rootDir ?? ''),
    String(localEngine?.modelsDir ?? ''),
    String(localEngine?.port ?? ''),
  ].join('|');
  useEffect(() => {
    let alive = true;
    setLocalProbing(true);
    const t = window.setTimeout(() => {
      if (!alive) return;
      void (async () => {
        try {
          const r = await api<LocalStat>(`/voice/local?force=1${scopeQuery(localScope, '&')}`);
          if (!alive) return;
          if (r?.ok === true) {
            setLocalStat(r);
            if (Array.isArray(r.localVoices)) setLocalVoices(r.localVoices);
            setLocalProbeErr('');
          } else {
            setLocalProbeErr(`状态读取失败：${pickErr(r)}`);
          }
        } catch (e: any) {
          if (alive) setLocalProbeErr(`状态读取失败：${pickErr(e)}`);
        } finally {
          if (alive) setLocalProbing(false);
        }
      })();
    }, 400);
    return () => { alive = false; window.clearTimeout(t); setLocalProbing(false); };
    // localScope 已在 localProbeKey 里；这里只依赖那个键，避免对象身份每次渲染都触发一轮探测
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localProbeKey]);

  /* ── 2026-10-02「三个角色我没看见」的直接修法（可发现性）────────────────────────────
   * 使用方当时停在「自动（跟随连接）」= 服务端那侧，那张卡如实显示"可选角色 0 个 / 没有引擎"，
   * 而**本机其实装着三个角色、真能合成** —— 屏幕上没有任何线索说明"你看的是另一台机器"，
   * 于是他只能得出"三个角色我没看见"。
   *
   * 做法：当前档位下角色为空、而**本机**那侧有角色时，探一次本机并在卡上给出**一键按钮**
   * （切档 + 重新检测，见 switchToLocalAndProbe）——用户不必理解 scope 是什么。
   * 「为什么是本机、而不是"另一侧"」：目标只有三档，服务端=机器人所在的那台（引擎常不在上面），
   * 真正装着引擎的多半就是用户面前这台；本机这一侧也正是"点一下就能立刻看到结果"的那侧。
   * 「静默」：本机桥没起来/本机也没角色/请求失败，一律不提示（不报错、不刷屏）。 */
  useEffect(() => {
    if (!localStat || charList.length > 0 || localScope === 'local') { setOtherSideChars(null); return; }
    let alive = true;
    void (async () => {
      try {
        // 显式 scope=local（不受当前档位影响）；force=1 只为拿当下的目录结论（探测不启动引擎）
        const r = await api<LocalStat>('/voice/local?force=1&scope=local');
        if (!alive) return;
        const n = r?.ok === true ? normalizeChars(r).length : 0;
        setOtherSideChars(n > 0 ? n : null);
      } catch { if (alive) setOtherSideChars(null); }
    })();
    return () => { alive = false; };
  }, [localStat, localScope, charList.length]);

/** 试听：仅被点击的那一个按钮进入忙碌态（pvBusy[自己的 key]），其余按钮照常可点击； */
/**  命中缓存时同样从头重播（更换 <audio> 的 key 并显式调用 play）。 */
  const doPreview = async (label: string, body: any, key = 'default') => {
    if (pvBusy[key]) return;                       // 同一按钮防重复点击，其他按钮不受影响
    setPvBusy((m) => ({ ...m, [key]: true }));
    try {
      const r = await api<any>('/voice/preview', { method: 'POST', body: JSON.stringify(body) });
      if (r?.ok !== true) { setMsg(`试听失败：${pickErr(r)}`); return; }
      setPreview({ url: `data:${r.mime || 'audio/mpeg'};base64,${r.audioBase64}`, label });
      /* 把这段音频留给本地卡（2026-10-02）：「以此音频新建本地音色」的入口读的就是它。
       * 云端现场生成的那两种（design / clone）最有价值 —— 使用方的原话正是"我先用云端 tts 合成样本，
       * 然后用本地的克隆"；内置音色试听也一并记下（同样是现合成的音频，一样能当样本）。 */
      if (typeof r.audioBase64 === 'string' && r.audioBase64) {
        setPreviewAudio({ label, base64: r.audioBase64, bytes: Number(r.bytes) || Math.round(r.audioBase64.length * 3 / 4) });
      }
      setPvSeq((n) => n + 1);                      // 更换 key，使与上次完全相同的音频也重新播放
      setMsg(r.cached ? `试听：${label}（命中缓存，未重复请求）` : `试听：${label}（${r.bytes} 字节，${r.ms}ms）`);
    } catch (e: any) { setMsg(`试听失败：${pickErr(e)}`); }
    finally { setPvBusy((m) => { const n = { ...m }; delete n[key]; return n; }); }
  };

  // 每次试听均显式 load + play：浏览器对 data URL 的重复播放常表现为无反应，显式播放最为可靠；
  // 被自动播放策略拦截时保留原生 controls，用户仍可手动播放。
  useEffect(() => {
    const el = audioRef.current;
    if (!el || !preview) return;
    try { el.load(); void el.play().catch(() => { /* 被拦截时交由 controls 处理 */ }); } catch { /* 忽略 */ }
  }, [pvSeq, preview]);

  /* ── 自定义测试文本：合成 / 保存并冻结 / 用这段音频新建本地音色（2026-10-02 新增）────
   * 三条打的全是**既有**接口，没有新造任何一条存储或路径：
   *   · 合成     → `POST /api/voice/preview`（与「音色库」里那些试听按钮完全同一条）；
   *   · 冻结     → `POST /api/voice/voices`（与「新建音色」②上传样本同一条：样本落 state/voice-samples/、
   *                记录落 state/voice-library.json，之后合成走 clone —— 正是「文字设计 → 冻结 → 复刻」
   *                那条既成机制的同一个存储与同一条消费路径，见 qq-bridge/src/core/voice.js 的
   *                freezeDesignVoice / frozenSampleOf / synthesizeWithSavedVoice）；
   *   · 本地音色 → `POST /api/voice/local {action:'voice-create'}`（本地引擎卡那张表单同一条）。 */

  /** 长度口径：与「单条语音最长字数」**同一条**（和「应用配置」里 `Number(maxChars) || 120` 一字不差），
   *  所以这里不另开一个上限，也就绕不过上面那条限制。 */
  const ctTextLimit = Math.max(1, Number(maxChars) || 120);

  /** 这次自定义文本用哪个音色合成：与音色库里的试听按钮同一套口径 ——
   *  自建音色（design/clone）用 `voiceId` 交给桥（design 型没有可用锚点时，桥侧这条既成路径
   *  会在合成成功后把参考样本冻成固定锚点，这是"冻结"的另一半，见桥侧 rebuildFixedAnchor），
   *  内置音色用 `mode:'tts'` + `voice`。「默认音色」为空（配置还没读到）时不带音色参数，
   *  由桥用它自己的默认音色。每次点击时算一次即可，不做 memo（这点开销远小于一次合成请求）。 */
  const ctVoiceArgOf = (): Record<string, string> => {
    const id = String(defaultVoice ?? '').trim();
    if (!id) return {};
    const isCustom = custom.some((v) => v.id === id || v.name === id);
    const arg: Record<string, string> = isCustom ? { voiceId: id } : { mode: 'tts', voice: id };
    return arg;
  };

  /** 结果行里点名用的音色名（取不到就写"桥的默认音色"，绝不猜一个名字出来）。
   *  这里直接查 builtin/custom 两份清单，**不查 voiceOptions** —— 那个 useMemo 在下面才定义，
   *  在这里引用会撞上暂时性死区。 */
  const ctVoiceLabel = useMemo(() => {
    const id = String(defaultVoice ?? '').trim();
    if (!id) return '桥的默认音色';
    const b = (builtin ?? []).find((x) => x.id === id);
    if (b) return `${b.label}（内置）`;
    const c = custom.find((v) => v.id === id || v.name === id);
    return c ? `${c.name}（自建）` : id;
  }, [defaultVoice, builtin, custom]);

  /** 合成自定义文本。成功：读数写进结果行，音频交给页面下方那个既有播放器播放（播放方式沿用现有）；
   *  失败：把桥／代理给的原话逐字写进结果行。返回回包（失败返回 null），供"保存并冻结"接着用。 */
  const ctSynthesize = async (): Promise<any | null> => {
    const text = ctText.trim();
    if (!text) { setCtMsg('合成失败：先输入要念的文本'); return null; }
    if (text.length > ctTextLimit) {
      setCtMsg(`合成失败：这段文本 ${text.length} 字，超过「单条语音最长字数」的 ${ctTextLimit} 字（这条限制不绕过，改短一些再试）`);
      return null;
    }
    setCtBusy('synth');
    try {
      const r = await api<any>('/voice/preview', { method: 'POST', body: JSON.stringify({ text, ...ctVoiceArgOf() }) });
      if (r?.ok !== true) { setCtMsg(`合成失败：${pickErr(r)}`); return null; }
      const label = `自定义文本（${ctVoiceLabel}）`;
      setPreview({ url: `data:${r.mime || 'audio/mpeg'};base64,${r.audioBase64}`, label });
      if (typeof r.audioBase64 === 'string' && r.audioBase64) {
        setPreviewAudio({ label, base64: r.audioBase64, bytes: Number(r.bytes) || Math.round(r.audioBase64.length * 3 / 4) });
      }
      setPvSeq((n) => n + 1);
      setCtMsg(`合成成功：${r.bytes} 字节，用时 ${r.ms}ms（${r.mime || 'audio/mpeg'}${r.cached ? '，命中缓存，未重复请求' : ''}）；音频已在下方「试听」播放器里，可接着「保存并冻结」`);
      return r;
    } catch (e: any) { setCtMsg(`合成失败：${pickErr(e)}`); return null; }
    finally { setCtBusy(null); }
  };

  /** 保存并冻结：把**这次合成出来的这段音频**固化成固定参考样本，音色从此不再漂。
   *
   *  「冻结在这套代码里的本来含义」（先摸清再动手）：给一个音色定下一段**固定不变**的参考音频，
   *  此后每次合成都拿它当锚点走 clone，而不是每次现设计 —— 桥侧 `freezeDesignVoice()` 写的就是这件事：
   *  样本落 `state/voice-samples/frozen-<音色id>.<后缀>`，同时把 `frozenSamplePath / frozenDescHash /
   *  frozenAt / frozenFrom` 四个字段写进 `state/voice-library.json`，之后由 `frozenSampleOf()` 取、
   *  经 `synthesizeWithSavedVoice()` 按 clone 合成。
   *
   *  「本页接在哪」：`frozen-*` 那个前缀只有桥内部的 `freezeDesignVoice` 会写，管理端**没有**这条 HTTP 路径
   *  （本页只能打既有接口，不新造存储），所以这里接的是**同一套存储 + 同一条消费路径**：
   *   样本存进同一个 `state/voice-samples/` 目录、记录写进同一份 `state/voice-library.json`，
   *   类型取 clone（有固定样本的音色本来就是复刻型），名字写成「冻结·<原音色名>」。
   *   与 `frozen-*` 的差别只有文件名与挂载点（新建一条 clone 记录，而不是挂在原 design 记录上），
   *   语义与效果一致：用它合成时固定用这一段，不漂。原音色自己的锚点状态一并如实报出来。 */
  const ctSaveAndFreeze = async () => {
    if (ctBusy) return;
    const r = await ctSynthesize();
    if (!r?.audioBase64) return;
    setCtBusy('freeze');
    try {
      const name = ctName.trim() || `冻结·${ctVoiceLabel.replace(/（.*$/, '')}`;
      const saved = await api<any>('/voice/voices', {
        method: 'POST',
        body: JSON.stringify({ name, kind: 'clone', sampleBase64: r.audioBase64 }),
      });
      if (saved?.ok !== true) { setCtMsg(`保存并冻结失败：${pickErr(saved)}`); return; }
      /* 冻完立刻重读音色库：① 新音色要出现在「音色库」里；② 原音色若本来没锚点，桥在合成那一步
         可能刚给它冻上（design 型），`hasFrozen` 是最硬的证据 —— 这两件事都如实写进结果行。 */
      let lib: any = null;
      try { lib = await api<any>('/voice/voices'); } catch { /* 重读失败不影响冻结本身，下面照实说 */ }
      if (lib?.ok === true && Array.isArray(lib.custom)) setCustom(lib.custom as CustomVoice[]);
      const origId = String(defaultVoice ?? '').trim();
      const orig = (lib?.custom ?? []).find((v: any) => v.id === origId || v.name === origId);
      const parts = [
        `保存并冻结成功：参考样本已存成音色「${saved.voice?.name ?? name}」（id ${saved.voice?.id ?? '?'}，${saved.voice?.sampleBytes ?? '?'} 字节）`,
        '此后用这个音色合成固定走这一段（与「文字设计 → 冻结 → 复刻」同一套存储，桥侧日志里能看到"音色已保存：<名字>（音频复刻）"）',
        `要用它：在下方「音色库」里点它的「设为默认音色」，再点这张卡的「应用配置」`,
        orig ? `原音色「${orig.name}」的锚点状态：${orig.hasFrozen ? `已有冻结锚点（来源 ${orig.frozenFrom || '未知'}，${orig.frozenAt || '时间未知'}）` : '暂无冻结锚点'}` : '',
        lib?.ok === true ? '' : '（音色库重读失败，新音色要刷新页面才看得到）',
      ].filter(Boolean);
      setCtMsg(parts.join('；'));
    } catch (e: any) { setCtMsg(`保存并冻结失败：${pickErr(e)}`); }
    finally { setCtBusy(null); }
  };

  /** 用刚合成的这段音频新建一个**本地**音色（本地引擎卡那张表单的同一条接口 voice-create）。
   *  「为什么要这个入口」：使用方原话是"我先用云端 tts 合成样本，然后用本地的克隆"——
   *  这一步就是把刚合成的那段直接交成本地引擎的参考音频，不必先下载再上传。
   *  样本走 base64（与本地卡上传样本同一条路，上限 LOCAL_SAMPLE_MAX_BYTES），参考文本就用刚念的那段；
   *  **基础角色同样不传**（2026-10-02 二次改造）：由桥自动挑（它优先用引擎的默认角色，所以
   *  用户配的「默认角色」照样生效），与「新建音色」那一行完全同一条口径。 */
  const ctCreateLocalVoice = async () => {
    if (ctBusy) return;
    const text = ctText.trim();
    const r = await ctSynthesize();
    if (!r?.audioBase64) return;
    const bytes = Number(r.bytes) || Math.round(String(r.audioBase64).length * 3 / 4);
    if (bytes > LOCAL_SAMPLE_MAX_BYTES) {
      setCtMsg(`新建本地音色失败：这段音频 ${(bytes / 1024).toFixed(0)}KB，超过本地上限 ${LOCAL_SAMPLE_MAX_BYTES / 1024}KB（这条路走 base64 上传，桥请求体上限 1MB）：把文本改短一些再试，或先「保存并冻结」再拿它当样本`);
      return;
    }
    setCtBusy('local');
    try {
      const name = ctName.trim() || `云端样本·${ctVoiceLabel.replace(/（.*$/, '')}`;
      const res = await api<any>(`/voice/local${scopeQuery(localScope)}`, {
        method: 'POST',
        body: JSON.stringify({
          action: 'voice-create',
          name,
          // 基础角色由桥自动挑（不传）；一个都没装时桥回人话，这里原样显示
          sampleBase64: r.audioBase64,
          promptText: text,
        }),
      });
      if (res?.ok !== true) { setCtMsg(`新建本地音色失败：${pickErr(res)}`); return; }
      if (Array.isArray(res.voices)) setLocalVoices(res.voices);
      setCtMsg(`本地音色「${res.voice?.name ?? name}」已新建（样本 ${bytes} 字节）：在下面「本地语音引擎」卡的「我的音色」里点它那一行的「试听」听听看`);
    } catch (e: any) { setCtMsg(`新建本地音色失败：${pickErr(e)}`); }
    finally { setCtBusy(null); }
  };

  const onPickFile = (f: File | null) => {
    if (!f) return;
    if (f.size > 7 * 1024 * 1024) { setMsg('样本过大（超过 7MB），请改用更短的 mp3/wav'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const data = String(reader.result || '');
      setSample({ name: f.name, base64: data.replace(/^data:[^,]+,/, ''), bytes: f.size });
    };
    reader.readAsDataURL(f);
  };

  const saveVoice = async (kind: 'design' | 'clone') => {
    setBusy('save-voice');
    /* 「用已有音色当样本」（kind=clone 且没上传文件但选了③）：把 fromVoiceId 交给桥，
       由桥去取那个音色的声音（文字设计音色取它的冻结锚点，没有就现冻一个）当样本 —— 桥侧见
       core/voice.js 的 sampleFromVoice 与 console-server.js 的 POST /api/voice/voices。 */
    const useFrom = kind === 'clone' && !sample && !!sampleFrom;
    try {
      const r = await api<any>('/voice/voices', {
        method: 'POST',
        body: JSON.stringify({
          name: newName.trim(), kind,
          description: kind === 'design' ? newDesc.trim() : '',
          sampleBase64: kind === 'clone' ? (sample?.base64 ?? '') : '',
          ...(useFrom ? { fromVoiceId: sampleFrom } : {}),
        }),
      });
      if (r?.ok !== true) { setMsg(`保存音色失败：${pickErr(r)}`); return; }
      setMsg(useFrom
        ? `音色「${newName.trim()}」已按「${voiceOptions.find((o) => o.id === sampleFrom)?.label ?? sampleFrom}」的声音存为复刻音色`
        : `音色「${newName.trim()}」已存入音色库，可在「默认音色」中选用`);
      setNewName(''); setNewDesc(''); setSample(null); setSampleFrom('');
      if (fileRef.current) fileRef.current.value = '';
      /* 音色库内容已变：旧值再渲染就是错的（清单里少了刚存的这一条），先作废该键；
         紧随其后的 load() 成功会立刻把新的一份写回去。 */
      dropCacheValue('voice:voices');
      await load();
    } catch (e: any) { setMsg(`保存音色失败：${pickErr(e)}`); }
    finally { setBusy(null); }
  };

  const removeVoice = async (v: CustomVoice) => {
    setBusy(`del-${v.id}`);
    try {
      const r = await api<any>(`/voice/voices?id=${encodeURIComponent(v.id)}`, { method: 'DELETE' });
      if (r?.ok !== true) { setMsg(`删除失败：${pickErr(r)}`); return; }
      setMsg(`已删除音色「${v.name}」`);
      /* 已删掉的音色绝不能再从缓存里被渲染出来：作废该键，等紧随其后的 load() 用新的一份补上。 */
      dropCacheValue('voice:voices');
      await load();
    } catch (e: any) { setMsg(`删除失败：${pickErr(e)}`); }
    finally { setBusy(null); }
  };

  /** 导出音色。传一条 = 单个音色的「导出」；传多条 = 「导出全部」（自建音色一次导到一个文件夹）。
   *  · 先把要写的字节**都取齐**再落盘：选文件夹是用户交互，点完就该是纯写入；
   *    也避免"选完文件夹才发现某个样本取不到"这种半成品状态。
   *  · 单个样本取不到（音色库说有、桥那边文件没了）**不算成功**：如实报错，不降级成"只导配置"。 */
  const exportVoices = async (voices: ExportVoice[]) => {
    if (!voices.length || expBusy) return;
    setExpBusy(voices.length === 1 ? voices[0].id : 'all');
    try {
      const w = window as FsaWindow;
      const exportedAt = new Date().toISOString();
      const items: { v: ExportVoice; audio: { data: ArrayBuffer; ext: string } | null; base: string }[] = [];
      const failed: string[] = [];
      const onlyMeta: string[] = [];
      for (const v of voices) {
        if (v.hasSample) {
          try { items.push({ v, audio: await fetchVoiceSample(v.id), base: exportBaseName(v) }); }
          catch (e: any) { failed.push(`「${v.name}」的样本取不到：${pickErr(e)}`); }
        } else {
          // 没有样本文件的音色（内置 / 纯文字设计 / 样本已丢失）：只导 json，并记下名字用于如实提示
          onlyMeta.push(v.name);
          items.push({ v, audio: null, base: exportBaseName(v) });
        }
      }
      if (!items.length) { setMsg(`导出失败：${failed.join('；')}`); return; }

      const mode: ExportMode = fsa.folder ? 'folder' : (fsa.save ? 'save-picker' : 'download');
      const written: string[] = [];
      /* 降级提示先说一遍（第②③档会连续弹框/下载，用户得先知道这是浏览器的能力限制，
         而不是我们"忘了让他选文件夹"）；最终结果里再说一遍。 */
      if (mode !== 'folder') {
        setMsg(mode === 'save-picker'
          ? '当前浏览器不支持选文件夹（File System Access API 不可用），已改为逐个文件保存：每个文件会弹一次保存框。'
          : '当前浏览器不支持选文件夹（File System Access API 不可用），已改为逐个下载到浏览器的下载目录。');
      }

      if (mode === 'folder') {
        let dir: FileSystemDirectoryHandle | null = null;
        try { dir = await w.showDirectoryPicker!({ id: 'kizuna-voice-export', mode: 'readwrite' }); }
        catch (e: any) {
          if (e?.name === 'AbortError') { setMsg('已取消导出：没有选择文件夹（再点一次「导出」即可重来）'); return; }
          setMsg(`打不开所选文件夹：${pickErr(e)}`); return;
        }
        for (const it of items) {
          // 音频与它的同名 json 共用一个基名：先定下不重名的基名，再各写各的
          const base = await pickFreeBase(dir, it.base, it.audio?.ext ?? '');
          if (it.audio) {
            await writeToDir(dir, `${base}${it.audio.ext}`, it.audio.data);
            written.push(`${base}${it.audio.ext}`);
          }
          const meta = exportMetaOf(it.v, it.audio ? `${base}${it.audio.ext}` : null,
            it.audio ? it.audio.data.byteLength : it.v.sampleBytes, exportedAt);
          await writeToDir(dir, `${base}.json`, JSON.stringify(meta, null, 2));
          written.push(`${base}.json`);
        }
      } else if (mode === 'save-picker') {
        /* 第②档：每个文件各弹一次保存框（浏览器没有"选文件夹"能力时的次选）。
           「元数据里的样本文件名」用**实际存下来的名字**（用户可能在保存框里改过名），
           而不是我们预先建议的那个 —— 否则 json 里写的名字和盘上的文件对不上。 */
        for (const it of items) {
          let audioName: string | null = null;
          if (it.audio) {
            const fh = await w.showSaveFilePicker!({
              suggestedName: `${it.base}${it.audio.ext}`,
              types: [{ description: '音色样本音频', accept: { [audioMimeOf(it.audio.ext)]: [it.audio.ext] } }],
            });
            const s = await fh.createWritable();
            await s.write(it.audio.data);
            await s.close();
            written.push(fh.name);
            audioName = fh.name;
          }
          const meta = exportMetaOf(it.v, audioName,
            it.audio ? it.audio.data.byteLength : it.v.sampleBytes, exportedAt);
          const jh = await w.showSaveFilePicker!({
            suggestedName: `${it.base}.json`,
            types: [{ description: '音色配置信息（JSON）', accept: { 'application/json': ['.json'] } }],
          });
          const js = await jh.createWritable();
          await js.write(JSON.stringify(meta, null, 2));
          await js.close();
          written.push(jh.name);
        }
      } else {
        for (const it of items) {
          if (it.audio) {
            downloadFile(`${it.base}${it.audio.ext}`, it.audio.data, audioMimeOf(it.audio.ext));
            written.push(`${it.base}${it.audio.ext}`);
          }
          const meta = exportMetaOf(it.v, it.audio ? `${it.base}${it.audio.ext}` : null,
            it.audio ? it.audio.data.byteLength : it.v.sampleBytes, exportedAt);
          downloadFile(`${it.base}.json`, JSON.stringify(meta, null, 2), 'application/json');
          written.push(`${it.base}.json`);
          /* 连续触发下载会被浏览器当成"批量下载"而提示拦截：每个之间留一点间隔，
             让下载队列逐条走（这条路径本来就是能力受限时的兜底，慢一点无妨）。 */
          await new Promise((r) => window.setTimeout(r, 300));
        }
      }

      const audioCount = items.filter((it) => it.audio).length;
      const parts: string[] = [];
      parts.push(mode === 'folder'
        ? `已导出 ${items.length} 个音色到所选文件夹：音频 ${audioCount} 个 + 配置信息 ${items.length} 份（同名 .json）`
        : (mode === 'save-picker'
          ? `当前浏览器不支持选文件夹，已改为逐个保存：已存 ${written.length} 个文件（音频 ${audioCount} 个 + 配置信息 ${items.length} 份）`
          : `当前浏览器不支持选文件夹，已改为逐个下载：已开始下载 ${written.length} 个文件（音频 ${audioCount} 个 + 配置信息 ${items.length} 份）`));
      if (onlyMeta.length) {
        parts.push(`${onlyMeta.map((n) => `「${n}」`).join('、')}没有样本文件，只能导出配置信息（未导出音频）`);
      }
      if (failed.length) parts.push(`失败：${failed.join('；')}`);
      setMsg(parts.join('；'));
    } catch (e: any) {
      // 写到一半失败（磁盘满 / 权限 / 用户在保存框里取消）：原因照实说，不谎报成功。
      // 「已写入的文件保持原样」是事实：每个文件都是整体写入（createWritable + close），没有半截文件。
      setMsg(e?.name === 'AbortError'
        ? '已取消导出（在保存框里点了取消）；此前已写出的文件保持原样。'
        : `导出中断：${pickErr(e)}（此前已写出的文件保持原样，不会损坏）`);
    } finally { setExpBusy(null); }
  };

  /* 今日用量：配置本体已读到时以它为唯一来源（不拿旧用量顶替新配置的读数）；配置本体还没有
     （读取中）或读失败时，用 voice:usage 这条读取缓存先出上一次读到的数 —— 于是
     「正在读取今日用量…」也不再是必经的一屏。 */
  const usage = cfg ? cfg.usage : boot0.usage;
/** 2026-09-19配置未读取到时仍渲染页面骨架（桥未运行时取不到真实值，但页面不应退化为一块错误提示）：
   *  cfg 为空时以空壳承接，以下只读取值均通过可选访问进行；各输入控件的值另由表单 state 提供，
   *  未读到时为空白且不可编辑（见文件上方 VoiceForm 说明）。 */
  const view: VoiceCfg = cfg ?? {};
  const voiceOptions = useMemo(() => {
    const opts = (builtin ?? []).map((b) => ({ id: b.id, label: `${b.label}（内置·${b.lang}${b.gender !== '—' ? '·' + b.gender : ''}）` }));
    for (const v of custom) opts.push({ id: v.id, label: `${v.name}（自建·${v.kind === 'clone' ? '样本复刻' : '文字设计'}）` });
    return opts;
  }, [builtin, custom]);

  return (
    <div className="page cute-ui">
      <div className="page-header">
        <div className="page-header-left">
          <button className="btn btn-sm" onClick={onBack}><ArrowLeft size={15} /> 返回</button>
          <div className="page-title-wrap">
            <div className="page-title" style={{ color: 'var(--nc-primary-500)' }}>Kizuna · 语音</div>
            <div className="page-subtitle">机器人可发声（合成语音并发送至群聊），亦可听取（将他人语音转为文字）</div>
          </div>
        </div>
        <div className="page-actions">
          <span className="connection-bar">
            <Zap size={13} /> 目标：当前活动实例
          </span>
        </div>
      </div>

      {/* 表单任何一处控件（含复选框、下拉、文本与文件输入）被改动时登记一次：
          首次读取的回包若在此之后到达，则不再覆盖用户已输入的内容（见 applyCfg 的 overwrite 参数）。
          用捕获阶段的 change 事件统一登记，无需为每个控件各写一遍。
          —— 另：「整行可点」（点标签区或同一行的空白处就聚焦/展开本行的控件）**不在这里挂**：
          全站那一份在 src/lib/field-click.ts（main.tsx 启动时装一次），本页不必也不能再挂第二份，
          否则同一次点击会被转发两遍、自定义下拉会"开了又关"（见文件上方那段说明）。 */}
      <div className="page-body" onChangeCapture={() => { touched.current = true; }}>
        <NoticeBar msg={msg} onClose={() => setMsg(null)} />

        {loadErr && (
          /* 2026-09-19 变更要求：此前此处为 `loadErr ? <错误卡> : <整页表单>`，桥一停整页配置即消失。
             现改为错误仅作错误呈现（提示条，不含重试按钮），配置照常显示、照常可改；真正依赖桥运行时的
             部分（保存／测试／试听／音色库）在下方以一句说明标出，而非删除整页。
             2026-09-30 修改要求：原先这里那个「重试」按钮已移除：本页会按退避间隔自动重读。 */
          <div className="card">
            <div className="lrn-error">
              <AlertTriangle size={15} />
              <div style={{ flex: 1 }}>
                {loadErr}
                <div className="lrn-error-detail">
                  {ready
                    ? '下方为上次读取到的配置，可继续修改；但保存、测试、试听与音色库均须经由桥完成，桥启动前点击这些操作会报同样的错误。'
                    : <>尚未读取到桥上的配置：下方字段保持<b>空白且不可编辑</b>，「应用配置」暂不可用 —— 不会以任何默认值冒充桥上配置。保存、测试、试听与音色库均须经由桥完成，桥启动前不可用。</>}
                </div>
                <div className="lrn-error-detail">{autoRetryNote(autoRetryMs)}</div>
              </div>
            </div>
          </div>
        )}

        {/* 读取状态：只要已经有旧值（读取缓存或跨会话配置缓存），就一概不插中间态 —— 下方字段本就是
            上次读到的真实值，读取期间不再有任何进度条，只是静默在后台校准，读到即原地替换。
            确实一无所有（本次会话第一次进入本页）时才留一段小字说明，且不再配转圈图标。
            （原文案为「正在读取语音配置：读到之前下方字段为空白且不可编辑…」+ 转圈。） */}
        {!ready && !loadErr && (
          <div className="card">
            <div className="lrn-inline-note">正在读取本机语音配置；读到之前字段为空白。</div>
          </div>
        )}

        {/* 目标侧不在此处暴露：管理端后端按「连上服务器则走服务器，否则走本机」自动路由
            （2026-09-19 按要求移除「当前编辑目标」那段提示）。仅当两侧均无法连接时才由后端给出错误。 */}

            {/* ───────── 总开关与发送设置 ───────── */}
            <div className="card">
              <div className="card-title"><Mic size={17} /> 语音功能</div>
              <div className="cfg-fields">
                <label className="switch-row">
                  <input type="checkbox" checked={enabled === true} disabled={!ready} onChange={(e) => setEnabled(e.target.checked)} />
                  <span>启用语音（总开关）</span>
                  <em>关闭后模型调用语音工具将被拒绝，机器人仅发送文字</em>
                </label>
                <label className="field-row">
                  <span className="f-label">默认音色</span>
                  <Dropdown className="input is-mid" value={defaultVoice} disabled={!ready} onChange={setDefaultVoice}
                    options={ready
                      ? voiceOptions.map((o) => ({ value: o.id, label: o.label }))
                      : [{ value: '', label: '（配置尚未读取）' }]} />
                </label>
                <label className="field-row">
                  <span className="f-label">全局风格指令</span>
                  <input className="input" type="text" placeholder={ready ? '可选，例如：语气温和，语速稍快，带一点笑意' : '尚未读取'}
                    value={style} disabled={!ready} onChange={(e) => setStyle(e.target.value)} />
                </label>
                <label className="field-row">
                  <span className="f-label">单条语音最长字数</span>
                  {/* 【2026-09-19】此处原为原生 number 输入配合 `Number(v) || 120`：
                      数字被删空时 `Number('') === 0`，随即被 ||120 顶回 120，输入框内容始终无法清空。
                      现统一改用 NumInput（全站数字输入框的既有标准件）：输入期间允许为空，失焦时不写入 0。 */}
                  <NumInput className="input is-short" value={maxChars} disabled={!ready} placeholder="尚未读取" onCommit={(n) => setMaxChars(n)} ariaLabel="单条语音最长字数" />
                  <em>超过此长度将被拒绝，以免发出长达数十秒的语音</em>
                </label>
                <label className="field-row">
                  <span className="f-label">每日合成字数上限</span>
                  <NumInput className="input is-short" value={dailyChars} disabled={!ready} placeholder="尚未读取" onCommit={(n) => setDailyChars(n)} ariaLabel="每日合成字数上限" />
                  <em>0 表示不限；命中缓存的重复文本不计入</em>
                </label>
                <label className="field-row">
                  <span className="f-label">音频格式</span>
                  <Dropdown className="input" value={format} disabled={!ready} onChange={setFormat}
                    options={ready
                      ? [
                        { value: 'mp3', label: 'mp3（推荐，文件体积较小）' },
                        { value: 'wav', label: 'wav（无损，文件体积较大）' },
                      ]
                      : [{ value: '', label: '（配置尚未读取）' }]} />
                </label>
                <label className="field-row">
                  <span className="f-label">识别语言</span>
                  <Dropdown className="input is-short" value={asrLanguage} disabled={!ready} onChange={setAsrLanguage}
                    options={ready
                      ? [
                        { value: 'auto', label: '自动判定' },
                        { value: 'zh', label: '中文' },
                        { value: 'en', label: '英文' },
                      ]
                      : [{ value: '', label: '（配置尚未读取）' }]} />
                </label>

                {/* 自定义测试文本 + 保存并冻结（2026-10-02 新增）。使用方原话：
                    「加一个输入框，可以输入自定义的文本来测试，保存并冻结」。
                    合成的就是这张卡配的那个云端音色（默认音色 / 全局风格指令 / 音频格式），
                    接口也是既有的那一条（与「音色库」里的试听按钮完全相同）；
                    长度沿用「单条语音最长字数」，不另开一条口径，也就绕不过它。 */}
                <div className="field-row" style={{ gridColumn: '1 / -1' }}>
                  <span className="f-label">自定义测试文本（试听 / 保存并冻结）</span>
                  <textarea className="textarea" rows={2} value={ctText} disabled={!ready}
                    placeholder={CUSTOM_TEST_TEXT}
                    onChange={(e) => setCtText(e.target.value)} />
                  <em>
                    用上面「默认音色」合成这一段，合成完在下方播放器里播放；长度限制与「单条语音最长字数」同一条 ——
                    已输入 {ctText.trim().length} / {ctTextLimit} 字{ctText.trim().length > ctTextLimit ? '（超长，合成会被拒绝）' : ''}
                  </em>
                  <div className="lrn-actions">
                    <button className="btn btn-primary btn-sm"
                      disabled={!ready || ctBusy !== null || !ctText.trim() || ctText.trim().length > ctTextLimit}
                      onClick={() => void ctSynthesize()}>
                      {ctBusy === 'synth' ? <Loader2 size={14} className="spin" /> : <Play size={14} />} 合成并试听
                    </button>
                    <button className="btn btn-soft-primary btn-sm"
                      disabled={!ready || ctBusy !== null || !ctText.trim() || ctText.trim().length > ctTextLimit}
                      onClick={() => void ctSaveAndFreeze()}>
                      {ctBusy === 'freeze' ? <Loader2 size={14} className="spin" /> : <Save size={14} />} 保存并冻结
                    </button>
                    <button className="btn btn-soft-primary btn-sm"
                      disabled={!ready || ctBusy !== null || !ctText.trim() || ctText.trim().length > ctTextLimit}
                      onClick={() => void ctCreateLocalVoice()}>
                      {ctBusy === 'local' ? <Loader2 size={14} className="spin" /> : <Cpu size={14} />} 用这段音频新建本地音色
                    </button>
                    <input className="input is-mid" type="text" value={ctName} disabled={!ready}
                      placeholder="名字（留空自动命名）" aria-label="冻结样本与本地音色的名字"
                      onChange={(e) => setCtName(e.target.value)} />
                  </div>
                  <div className="lrn-inline-note" style={{ display: 'block', lineHeight: 1.75 }}>
                    <div>
                      <b>保存并冻结</b>：把这次合出来的音频固化成该音色的<b>固定参考样本</b>，此后用这个音色合成固定走这一段，
                      音色不再漂。与既成的「文字设计 → 冻结 → 复刻」共用同一套存储 —— 样本与记录都落进音色样本库
                      （合成时可以按类型分别取），类型是复刻型
                      （合成时读的就是这段样本字节，与 design 型音色读冻结锚点是同一条复刻路径）；
                      冻结完在「音色库」里点它的「设为默认音色」，再点本卡的「应用配置」即生效。
                    </div>
                    <div>
                      <b>用这段音频新建本地音色</b>：把同一段音频交给本机引擎当参考音频（本地那侧走复刻），
                      样本上限与下面本地那张卡一致；本机引擎没装或没有角色时会在那张卡上如实报错，不会悄悄成功。
                    </div>
                    {ctMsg && <div><b>结果：</b>{ctMsg}</div>}
                  </div>
                </div>
                <label className="switch-row">
                  <input type="checkbox" checked={cacheEnabled === true} disabled={!ready} onChange={(e) => setCacheEnabled(e.target.checked)} />
                  <span>相同内容复用缓存</span>
                  <em>同一句话配合同一音色仅合成一次，以节省时间与费用</em>
                </label>
                <label className="field-row">
                  <span className="f-label">主动发语音概率</span>
                  <NumInput className="input is-short" value={probPct} disabled={!ready} placeholder="尚未读取" onCommit={(n) => setProbPct(Math.max(0, Math.min(100, Math.round(n))))} ariaLabel="主动发语音概率" />
                  <em>取值范围 0~100（%）。每次唤醒桥时掷一次判定，并将结果写入提示词，告知模型本轮是否可以掺入一条语音；0 表示不主动发送，仅在明确要求时发送</em>
                </label>
                <label className="field-row">
                  <span className="f-label">语音冷却（分钟）</span>
                  <NumInput className="input is-short" value={coolMin} disabled={!ready} placeholder="尚未读取" onCommit={(n) => setCoolMin(Math.max(0, Math.round(n)))} ariaLabel="语音冷却分钟" />
                  <em>同一会话刚发送过语音后，该时长内不再被抽中（防止连续发送刷屏）</em>
                </label>
                {/* 全语音发送模式（send.allVoice）：本页仅读写配置并提示，真正的「一律发语音」由桥侧实现 */}
                <label className="switch-row">
                  <input type="checkbox" checked={allVoice === true} disabled={!ready} onChange={(e) => setAllVoice(e.target.checked)} />
                  <span>全语音发送模式</span>
                  <em>开启后机器人的回复<b>一律以语音发出</b>（不再发送文字）；关闭即回到上方的「概率 + 冷却」规则。修改后须点击「应用配置」</em>
                </label>
                {/* 音色稳定模式（stableVoice）：2026-09-30 修「音色抖动」。线上日志显示参考样本 sha1 完全一致
                    （冻结锚点稳定生效），但每条语音的**语气标注**都不同（小声说一句 / 压着嗓子说 …），
                    而合成服务会把风格与文本一起算进音色条件 —— 每条换一个侧写就等于每条把音色往不同方向拉。
                    开启后桥侧只送这条全局风格，音色与语速不再逐条漂移（代价是情绪表达变淡）。 */}
                <label className="switch-row">
                  <input type="checkbox" checked={stableVoice === true} disabled={!ready} onChange={(e) => setStableVoice(e.target.checked)} />
                  <span>音色稳定模式</span>
                  <em>开启后<b>忽略每条消息的语气标注</b>，只用上方「全局风格指令」合成：音色与语速不逐条漂移，代价是情绪起伏变淡；关闭则每条语音按模型给的那句话的语气念。修改后须点击「应用配置」</em>
                </label>
                {allVoice === true && (
                  <div className="lrn-inline-note" style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'flex-start', lineHeight: 1.7 }}>
                    <Volume2 size={13} style={{ flex: 'none', marginTop: 2 }} />
                    <span>
                      全语音模式会<b>显著增加语音合成消耗</b>（每日合成字数存在上限，见上方「每日合成字数上限」）；
                      某句合成失败时将<b>自动退回文字</b>发出，不会丢失该条回复。
                    </span>
                  </div>
                )}
              </div>
              <div className="lrn-inline-note">
                <Clock3 size={13} />
                {usage
                  ? <>今日（{usage.day}）已合成 {usage.chars} 字，共 {usage.calls} 次，缓存命中 {usage.cacheHits} 次；语音识别 {usage.asrCalls} 次</>
                  /* 用量为桥侧的实时计数：桥未运行时不应持续显示「读取中…」，须说明该计数缺失的原因 */
                  : loadErr ? '今日用量无法读取（该计数需桥处于运行状态）'
                  /* 一无所有（本次会话还没读到过用量）时才用骨架承接原来那句「正在读取今日用量…」：
                     读数一旦有过，就一直显示它，读取期间不再有任何进度条，只是静默在后台校准。 */
                  : <Skeleton rows={1} />}
              </div>
              <div className="lrn-actions">
                {/* 「应用配置」在配置尚未读取到（读取中或读取失败）时禁用：此时表单为空值，
                    直接保存会把空值写回桥上，覆盖桥上已保存的真实配置。 */}
                <button className="btn btn-primary btn-sm" disabled={busy !== null || !ready}
                  onClick={() => void save()}>
                  {busy === 'save' ? <Loader2 size={14} className="spin" /> : <Save size={14} />} 应用配置
                </button>
                <button className="btn btn-soft-primary btn-sm" disabled={busy !== null} onClick={() => void runTest('tts')}>
                  {busy === 'test-tts' ? <Loader2 size={14} className="spin" /> : <FlaskConical size={14} />} 测试合成
                </button>
                <button className="btn btn-soft-primary btn-sm" disabled={busy !== null} onClick={() => void runTest('asr')}>
                  {busy === 'test-asr' ? <Loader2 size={14} className="spin" /> : <FlaskConical size={14} />} 测试识别
                </button>
              </div>
            </div>

            {/* ───────── 本地语音引擎（Genie / GPT-SoVITS，可选）─────────
                2026-09-28 新增：把一台本机合成引擎接进语音链。为什么单独一张卡而不是并进「语音功能」：
                它是**可选件**（没装就是没装，桥侧照旧走云端），且它的配置项是路径与进程参数，
                与上面那组"云端接入"字段不是一类东西。 */}
            <div className="card">
              <div className="card-title">
                <Cpu size={17} /> 本地语音引擎（可选）
                <span className="lrn-updated">不装也能用；装了才走本机合成</span>
              </div>
              <div className="cfg-fields">
                <label className="switch-row">
                  <input type="checkbox" checked={localEngine?.enabled === true}
                    onChange={(e) => patchLocal({ enabled: e.target.checked })} />
                  <span>启用本地合成</span>
                  <em>「内置音色朗读」与「音色复刻」改由本机引擎合成（不出网、不占云端额度）；文字设计音色仍走云端</em>
                </label>
                {/* 查看目标（2026-10-01 新增）：这张卡看的是"某一侧"的本地引擎 ——
                    连上服务器时默认看服务端那份，而用户要看本机引擎时必须能明确指定。
                    控件沿用页面上既有的"分段按钮"写法（容器 .tabs + 选中档 btn-primary、
                    未选中 btn-soft，与「功能配置」页签同一套），只按本卡尺寸收成 btn-sm。
                    横跨整行（grid-column），免得与右边的「语言」挤在同一格。 */}
                <div className="field-row" style={{ gridColumn: '1 / -1' }}>
                  <span className="f-label">查看目标</span>
                  <div className="tabs" style={{ marginBottom: 0, gap: 6 }}>
                    {VOICE_SCOPE_OPTIONS.map((o) => (
                      <button key={o.value} type="button"
                        className={`btn btn-sm ${localScope === o.value ? 'btn-primary' : 'btn-soft'}`}
                        aria-pressed={localScope === o.value}
                        onClick={() => changeLocalScope(o.value)}>{o.label}</button>
                    ))}
                  </div>
                  <em>本机 = 这台电脑上的引擎，服务端 = 服务器上的引擎；连接服务器时默认看服务端。切换目标会清掉上一次的读数，并**自动**重新探测一次（无需点任何按钮）。</em>
                </div>

                {/* 2026-10-02「三个角色我没看见」的那一键（见上面 otherSideChars 的说明）：
                    当前这一档没有角色、而本机那侧有 —— 一个按钮走完"切到本机 + 重新检测"，
                    用户不需要知道 scope 是什么，也不需要先切档再点检测。 */}
                {otherSideChars && charList.length === 0 && (
                  <div className="field-row" style={{ gridColumn: '1 / -1' }}>
                    <span className="f-label">角色不在这一侧</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <button type="button" className="btn btn-primary btn-sm"
                        disabled={localBusy !== null}
                        onClick={() => void switchToLocalAndProbe()}>
                        {localBusy === 'status' ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} 切到本机并重新检测
                      </button>
                      <span>本机那侧有 <b>{otherSideChars}</b> 个角色，这一侧没有</span>
                    </div>
                    <em>本机引擎装的是真模型，服务端上通常没有；点一下就会把「查看目标」切到本机并立刻重读角色目录（不启动引擎、不产生费用）</em>
                  </div>
                )}
                <label className="field-row">
                  <span className="f-label">默认角色</span>
                  <Dropdown className="input is-mid" value={localEngine?.character ?? ''}
                    onChange={(v) => patchLocal({ character: v })} options={charOptions} />
                  <em>{charHint}</em>
                </label>
                <label className="field-row">
                  <span className="f-label">语言</span>
                  <Dropdown className="input is-short" value={localEngine?.language ?? 'zh'}
                    onChange={(v) => patchLocal({ language: v })}
                    options={[{ value: 'zh', label: '中文' }, { value: 'jp', label: '日语' }, { value: 'en', label: '英语' }, { value: 'kr', label: '韩语' }]} />
                  <em>角色按语言训练/转换，选错会读不出正确发音</em>
                </label>

                {/* 试听（本次新增）：让引擎按当前选中的「默认角色」真合成一句，直接在浏览器里播。
                    放在角色/语言旁边 —— 选完角色立刻能听出来对不对，不必去机器人里发条消息试。 */}
                <div className="field-row">
                  <span className="f-label">试听</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <input className="input is-mid" type="text" value={localPvText}
                      onChange={(e) => setLocalPvText(e.target.value)}
                      placeholder="你好，我是本地语音引擎。" />
                    <button className="btn btn-soft-primary btn-sm"
                      disabled={busy !== null || localBusy !== null || localPvBusy !== null}
                      onClick={() => void previewLocal()}>
                      {localPvBusy === 'default' ? <Loader2 size={14} className="spin" /> : <Play size={14} />} 试听
                    </button>
                  </div>
                  <em>用当前「默认角色」合成这一句；引擎没起会按需冷启动，首次可能等几十秒</em>
                </div>

                {/* ───────── 本地音色（2026-10-02 新增）─────────
                    使用方要的："像云端那样能上传样本音频并新建角色" —— 云端的音色（设计/复刻）由
                    小米的接口生成，本地这侧没有那个接口，所以本地的"音色"就是**一段自己的参考音频**：
                      · 样本     = 要复刻的那把声音（上传文件，或直接取一个已有音色的声音）
                      · 参考文本 = 样本里念的是哪句话（可选，给了更准）
                    本质上就是引擎的「复刻」模式，只是把这段样本**存成一条档案**，于是可以反复选用、
                    试听、删除 —— 与云端音色在界面上的用法一致（界面这两块共用同一个 scope 口径与试听口径）。
                    2026-10-02 二次改造（使用方原话："应当是直接把上传的音频当做音色来复刻就行，
                    而不依靠原有角色"）：这一行**不再有基础角色下拉**。引擎必须有已装的角色权重才发得出声，
                    但那是桥的事 —— 用户只管传音频，角色由桥按实时读数自己挑（见桥的 autoBaseCharacter）。 */}
                <div className="field-row" style={{ gridColumn: '1 / -1' }}>
                  <span className="f-label">新建音色</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <input className="input is-mid" type="text" value={lvName}
                      onChange={(e) => setLvName(e.target.value)}
                      placeholder="音色名字（如：小明·解说）" />
                    <input ref={lvFileRef} type="file" accept="audio/mpeg,audio/wav,.mp3,.wav"
                      style={{ display: 'none' }}
                      onChange={(e) => onPickLocalSample(e.target.files?.[0] ?? null)} />
                    <button type="button" className="btn btn-soft btn-sm"
                      onClick={() => lvFileRef.current?.click()}>
                      <Upload size={14} /> 选音频样本
                    </button>
                    {previewAudio && (
                      <button type="button" className="btn btn-soft btn-sm"
                        onClick={() => usePreviewAudioAsSample()}
                        title={`把刚试听的「${previewAudio.label}」当作样本`}>
                        <Music size={14} /> 用刚试听的音频
                      </button>
                    )}
                    <button type="button" className="btn btn-primary btn-sm"
                      disabled={lvBusy !== null || !lvName.trim() || (!lvSample && !lvFromVoice)}
                      onClick={() => void createLocalVoice()}>
                      {lvBusy === 'create' ? <Loader2 size={14} className="spin" /> : <Plus size={14} />} 创建
                    </button>
                  </div>
                  <em>
                    上传的音频决定音色（复刻用的就是它）
                    {' · '}样本 {lvSample ? `已选「${lvSample.name}」（${(lvSample.bytes / 1024).toFixed(0)}KB）` : `未选（mp3/wav，上限 ${LOCAL_SAMPLE_MAX_BYTES / 1024}KB）`}
                    {previewAudio ? `；也可以直接用刚试听的「${previewAudio.label}」` : '；上面云端音色试听过的音频也能一键拿来当样本'}
                  </em>
                </div>
                <label className="field-row">
                  <span className="f-label">样本来源</span>
                  <Dropdown className="input is-mid" value={lvFromVoice}
                    onChange={(v) => { setLvFromVoice(v); if (v) setLvSample(null); }}
                    options={[
                      { value: '', label: lvSample ? '用刚选的音频文件（已选）' : '上传音频文件（未选）' },
                      ...voiceOptions.map((o) => ({ value: o.id, label: `取「${o.label}」的声音` })),
                    ]} />
                  <em>不想自己录：可以取一个已有音色的声音当样本（桥侧去取它那段音频；选了它就以它为准）</em>
                </label>
                <label className="field-row" style={{ gridColumn: '1 / -1' }}>
                  <span className="f-label">参考文本</span>
                  <input className="input" type="text" value={lvPrompt}
                    onChange={(e) => setLvPrompt(e.target.value)}
                    placeholder="样本里念的那句话（可选，留空也能用）" />
                  <em>样本里念的是什么，填上能让复刻更准（引擎的参考文本）；留空则按无文本参考处理</em>
                </label>

                {/* 我的音色：桥侧 state/local-voices.json 里的档案。名字 / 样本 / 试听 / 删除都在这一块，
                    排版沿用上面「自建音色」清单那一套类名（.lrn-status-list / .lrn-status-row / .lrn-actions），
                    不另造一套样式。 */}
                <div className="field-row" style={{ gridColumn: '1 / -1' }}>
                  <span className="f-label">我的音色</span>
                  <div style={{ width: '100%' }}>
                    {localVoices.length === 0 ? (
                      <em>还没有本地音色：选一段音频样本（或取一个已有音色的声音），点「创建」就有一条。创建出来的音色也能在「默认音色」里选。</em>
                    ) : (
                      <div className="lrn-status-list">
                        {localVoices.map((v) => (
                          <div className="lrn-status-row" key={v.id} style={{ cursor: 'default' }}>
                            <div className="lrn-status-main">
                              <div className="lrn-status-uid">
                                <b>{v.name}</b>
                                <span className="badge badge-soft">本地音色</span>
                                <span className="badge badge-soft">{v.baseCharacter ? `基础角色 ${v.baseCharacter}` : '基础角色 引擎默认'}</span>
                                {!v.hasSample && <span className="badge badge-soft">样本丢失</span>}
                              </div>
                              <div className="lrn-status-preview">
                                {v.hasSample
                                  ? `样本 ${(Number(v.sampleBytes) / 1024).toFixed(0)}KB ${String(v.sampleExt || '').toUpperCase()}${v.promptText ? ` · 参考文本「${v.promptText}」` : ' · 无参考文本'}`
                                  : '样本文件不在了：这条音色合成时会失败，删掉它重建，或把样本文件放回音色样本目录'}
                              </div>
                              <div className="lrn-actions">
                                <button className="btn btn-primary btn-sm" disabled={localPvBusy !== null || !v.hasSample}
                                  onClick={() => void previewLocal(v.id, v.name)}>
                                  {localPvBusy === v.id ? <Loader2 size={13} className="spin" /> : <Play size={13} />} 试听
                                </button>
                                <button className="btn btn-sm" disabled={lvBusy !== null}
                                  title="把「默认音色」选成它（点上方「保存配置」后生效）"
                                  onClick={() => { setDefaultVoice(v.name); setMsg(`「默认音色」已选为「${v.name}」（本地音色）：点上方「保存配置」后生效`); }}>
                                  <Star size={13} /> 设为默认音色
                                </button>
                                <button className="btn btn-outline-danger btn-sm" disabled={lvBusy !== null}
                                  onClick={() => void removeLocalVoice(v)}>
                                  {lvBusy === `del-${v.id}` ? <Loader2 size={13} className="spin" /> : <Trash2 size={13} />} 删除
                                </button>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <em>样本存在应用自己的数据目录里（与角色模型目录分开）；删掉音色会一并删掉它自己的样本文件</em>
                </div>

                {/* 路径与进程参数默认收起（使用方要求「去掉废话」）：只有换机器、换目录、调端口时才要动。
                    展开开关横跨整行（.lrn-adv-toggle 带 grid-column: 1 / -1）。 */}
                <button type="button" className={`lrn-adv-toggle${advOpen ? ' is-open' : ''}`}
                  onClick={() => setAdvOpen((v) => !v)}>
                  <ChevronDown size={14} /> 高级：引擎目录与进程参数
                </button>

                {advOpen && (<>
                <label className="field-row">
                  <span className="f-label">引擎目录</span>
                  <input className="input" type="text" placeholder="留空 = 默认位置"
                    value={localEngine?.rootDir ?? ''}
                    onChange={(e) => patchLocal({ rootDir: e.target.value })} />
                  <em>引擎所在目录（里面是引擎脚本与它自带的运行环境）</em>
                </label>
                <label className="field-row">
                  <span className="f-label">角色模型目录</span>
                  <input className="input" type="text" placeholder="留空 = <引擎目录>/models"
                    value={localEngine?.modelsDir ?? ''}
                    onChange={(e) => patchLocal({ modelsDir: e.target.value })} />
                  <em>一个角色一个子目录，目录里要有 .onnx</em>
                </label>
                <label className="field-row">
                  <span className="f-label">本地端口</span>
                  <NumInput className="input is-short" value={localEngine?.port} placeholder="4610"
                    onCommit={(n) => patchLocal({ port: Math.max(1, Math.min(65535, Math.round(n))) })} ariaLabel="本地引擎端口" />
                  <em>只监听 127.0.0.1，不对外暴露</em>
                </label>
                <label className="switch-row">
                  <input type="checkbox" checked={localEngine?.autoStart !== false}
                    onChange={(e) => patchLocal({ autoStart: e.target.checked })} />
                  <span>需要时自动拉起引擎进程</span>
                  <em>关闭后只连已在运行的引擎，引擎没起时按「回落云端」处理</em>
                </label>
                <label className="switch-row">
                  <input type="checkbox" checked={Number(localEngine?.idleShutdownMs ?? 600000) > 0}
                    onChange={(e) => patchLocal({ idleShutdownMs: e.target.checked ? 600000 : 0 })} />
                  <span>空闲后回收引擎进程</span>
                  <em>空闲 10 分钟关进程，下次合成要重新冷启动</em>
                </label>
                <label className="switch-row">
                  <input type="checkbox" checked={localEngine?.fallbackToCloud !== false}
                    onChange={(e) => patchLocal({ fallbackToCloud: e.target.checked })} />
                  <span>本地失败时回落云端</span>
                  <em>失败改用云端（照旧计费）；关闭则这条语音直接失败</em>
                </label>
                </>)}
              </div>

              <div className="lrn-inline-note" style={{ display: 'flex', alignItems: 'flex-start', lineHeight: 1.7 }}>
                <HardDrive size={13} style={{ flex: 'none', marginTop: 2 }} />
                <span>
                  引擎与角色装好后，刷新本页（或切一下「查看目标」）就会出现在上面的下拉框里；只放自己有权使用的模型。
                </span>
              </div>

              {/* 三句必须写在卡面上的事实（本次新增）：角色从哪来、音色库里哪一类本地能用、空的时候是怎么回事。
                  容器用块级（`.lrn-inline-note` 是 inline-flex，元素子节点会被拆成 flex 子项、正文会错位换行）。
                  2026-09-29：这里原来把引擎的安装命令行与内部目录原样抄在界面上，已按使用方要求去掉
                  （「界面上不要有任何写死的东西」）—— 只剩"角色从哪来、装好要做什么"这两句人话。 */}
              <div className="lrn-inline-note" style={{ display: 'block', lineHeight: 1.75 }}>
                <div>角色来自引擎自己的<b>模型目录</b>：把一个角色放成一个子目录，刷新本页（或切一下「查看目标」）它就会出现在上面的下拉框里。</div>
                {/* 2026-10-02：上面那句以前不分场合地摆着 —— 使用方连着服务器、看的是服务端那份时，
                    很容易以为"在本机装一下就行"，而角色其实要装在**跑引擎的那台机器**上。
                    这里补一句"装在哪台机器上"的说明 + 指向上面那个一键按钮；原有诊断信息一句没删。 */}
                {localScope !== 'local' && (
                  <div>
                    注意：角色要装在<b>跑引擎的那台机器</b>上。
                    当前「查看目标」看的是 <b>{curSideLabel}</b>；如果角色其实装在本机，
                    点上面的「切到本机并重新检测」就能看到它 —— 这一档不变的话，这里永远只会显示服务端那份目录。
                  </div>
                )}
                <div>「音色库」里的 <b>复刻</b> 音色（clone）能直接被本地引擎使用：以本地角色为底、那段样本当参考音频；<b>文字设计</b> 音色（design）只能用云端引擎生成，本地不参与。</div>
                <div>本地引擎默认不附带任何角色：一个都没装时，上面「默认角色」里会是空的（这不是引擎坏了）。</div>
              </div>

              {/* 角色列表为空时的明确提示：光有一个空下拉框，用户不知道是没装角色还是没检测出来。 */}
              {localStat && charList.length === 0 && (
                <div className="lrn-inline-note" style={{ display: 'block', lineHeight: 1.75 }}>
                  <div><b>还没有安装任何角色</b>：本地引擎默认不带角色，装好一个才会出现在上面的「默认角色」里。</div>
                  <div>把角色放进引擎的模型目录（一个角色一个子目录），再刷新本页即可。</div>
                  {/* "本机有、这一侧没有"时，这里也要给出那条一键路径（与上面 charHint / 那个按钮同一件事）。 */}
                  {otherSideChars && localScope !== 'local' && (
                    <div>
                      但<b>本机那侧有 {otherSideChars} 个角色</b>（当前看的是 {curSideLabel}）：点上面的「切到本机并重新检测」即可看到，不必在这台机器上再装一遍。
                    </div>
                  )}
                </div>
              )}

              {/* 2026-10-02：原来这里第一个按钮是「检测状态」，按使用方要求改成**自动检测**后已撤掉
                  （进页面、切「查看目标」、改相关设置都会自动探一次，见上方那条自动探测的 useEffect）。
                  剩下两个按钮都是"要真做事"的：自检合成会冷启动引擎，关进程会把内存还回去 ——
                  这两件都不该被自动化。 */}
              <div className="lrn-actions">
                <button className="btn btn-soft-primary btn-sm" disabled={busy !== null || localBusy !== null} onClick={() => void runLocalSelfTest()}>
                  {localBusy === 'test' ? <Loader2 size={14} className="spin" /> : <FlaskConical size={14} />} 自检合成
                </button>
                <button className="btn btn-soft-primary btn-sm" disabled={busy !== null || localBusy !== null} onClick={() => void stopLocalEngine()}>
                  {localBusy === 'stop' ? <Loader2 size={14} className="spin" /> : <Square size={14} />} 关闭引擎进程
                </button>
              </div>

              {(localProbing || localProbeErr || localMsg || localPvMsg || localStat) && (
                /* 状态行只留三件要紧事：环境在不在、进程在不在、有几个角色可选。
                   解释器路径、分词后端、模型目录这些收进悬停提示（title）—— 只在排查时才看，
                   摊在卡面上就是"废话"（2026-09-28 使用方要求去掉废话）。未满足项仍留在明面上：
                   那是"为什么不能用"的行动指引，不是细节。
                   2026-10-02：自动检测的"正在检测"与失败文本也落在这一行里（失败只安静写这一行，
                   不弹错、不刷屏；这一行本身在探测失败时也照常出现，因为 localProbeErr 进了上面的条件）。 */
                <div className="lrn-inline-note" style={{ display: 'flex', alignItems: 'flex-start', lineHeight: 1.7 }}
                  title={localDetail || undefined}>
                  <span>
                    {localProbing && (
                      <div>
                        <Loader2 size={12} className="spin" style={{ verticalAlign: '-2px' }} /> 正在自动检测
                        {curSideLabel}的引擎状态…（只读状态，不会启动引擎进程）
                      </div>
                    )}
                    {localProbeErr && !localProbing && <div>{localProbeErr}</div>}
                    {localMsg && <div>{localMsg}</div>}
                    {localPvMsg && <div>{localPvMsg}</div>}
                    {localStat && (
                      <div>
                        环境{localStat.ready ? '已就绪' : '尚不可用'}
                        {localStat.running
                          ? `；引擎运行中（pid ${localStat.pid}，常驻 ${localStat.rssMb ?? '?'} MB）`
                          : '；引擎未运行'}
                        {`；可选角色 ${charList.length} 个${charList.length ? `（${charList.map((c) => c.name).join('、')}）` : ''}`}
                        {localStat.reasons?.length ? `；未满足项：${localStat.reasons.join('；')}` : ''}
                      </div>
                    )}
                  </span>
                </div>
              )}

              {/* 本地引擎对机器的要求 + 按当前「查看目标」的读数给结论（2026-09-29 使用方要求：
                  「界面上不要有任何写死的东西，并精简，因为我们主要是面向大众」）。
                  这一块**刻意只留三行**：
                   ① 引擎自身的通用门槛（内存 / 磁盘 / CPU，措辞带「约」，任何机器都适用）；
                   ② 结论 —— 由上面那行探测读数驱动（engineVerdict 读 localStat.ready / reasons / running），
                      不写死"哪台机器装不了"，换机器或换「查看目标」时这段文字自己跟着变；
                   ③ 一句说明为什么不用改界面。
                  这里不出现任何一台具体机器的规格、目录路径与内部命令行 —— 那是运维细节，
                  会在有部署需求时随文档给出，而不是摆在面向大众的界面上。 */}
              <div className="lrn-inline-note" style={{ display: 'block', lineHeight: 1.75 }}>
                <div>
                  引擎与角色装在<b>跑它的那台机器</b>上；对机器的通用要求：可用内存约 5 GB、磁盘约 2 GB
                  （每加一个角色再约 0.3 GB），x86 CPU 且支持 AVX。
                </div>
                <div>当前「查看目标」＝<b>{curSideLabel}</b>：{engineVerdict}</div>
                <div>换机器不用改这里：能力没有按机器删减，把「查看目标」切到那一侧，就按那台机器的实况重新判定。</div>
              </div>
            </div>

            {/* ───────── 四个模型各自的地址与密钥 ───────── */}
            <div className="card">
              <div className="card-title">
                <Sparkles size={17} /> 模型接入（各模型分别配置地址与密钥）
                <span className="lrn-updated">密钥只写入不回显，留空即不改动</span>
              </div>
              {/* 2026-09-26 主人要求：「把这个大说明去掉并重新排版这块地方」。原来这里是一张
                  无标题的内嵌卡片，按钮下面挂了四句解释性长文（两处都是小米的 OpenAI 兼容入口…、
                  免费试用期按量计费…、地址以桥里的 presets 为准…）。现在收成一行：左边一句小标题，
                  右边两个预置按钮；点了会写什么、地址是否可能兜底，都挪进按钮的 title（悬停可见）。
                  外层也不再套第二层卡片，`page-body` 里少一层盒子。 */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
                <span style={{ fontSize: 12.5, color: 'var(--nc-foreground-400)' }}>一键预置</span>
                {PRESETS.map((p) => (
                  <button key={p.key} className="btn btn-sm"
                    disabled={!ready}
                    onClick={() => applyPreset(p)}>{p.label}</button>
                ))}
              </div>
              {ROLE_ORDER.map((role) => {
                const rc = models[role] ?? { baseUrl: '', model: '', apiKey: '' };
                const meta = (view.roles ?? []).find((x) => x.role === role);
                const saved = view.models?.[role];
                // 音色设计与音色复刻同语音合成属同一家服务、同一把密钥（经确认请求地址相同），
                // 因此这两栏留空即自动跟随「语音合成」，无需重复填写。
                const followsTts = role !== 'tts';
                return (
                  <div key={role} className="lrn-block" style={{ marginBottom: 12 }}>
                    <div className="lrn-block-title">{roleName(role, meta?.label)}　<span style={{ fontWeight: 400, color: 'var(--nc-foreground-400)' }}>{ROLE_HINT[role]}</span></div>
                    <div className="cfg-fields">
                      <label className="field-row">
                        <span className="f-label">请求地址</span>
                        <input className="input is-mid" type="text"
                          placeholder={!ready ? '尚未读取' : (followsTts ? '留空即跟随「语音合成」的地址（属同一家服务）' : (view.presets?.tokenPlanCn || PRESETS[0].baseUrl))}
                          value={rc.baseUrl} disabled={!ready}
                          onChange={(e) => setModels({ ...models, [role]: { ...rc, baseUrl: e.target.value } })} />
                      </label>
                      <label className="field-row">
                        <span className="f-label">语音模型密钥</span>
                        <input className="input is-mid" type="password" autoComplete="new-password"
                          placeholder={!ready
                            ? '尚未读取'
                            : (saved?.apiKeySet
                              ? `已设置：${saved.apiKeyMasked}（留空表示不改动）`
                              : (followsTts ? '留空即使用「语音合成」的密钥（两者相同即可）' : '尚未设置，粘贴密钥即可'))}
                          value={rc.apiKey} disabled={!ready}
                          onChange={(e) => setModels({ ...models, [role]: { ...rc, apiKey: e.target.value } })} />
                      </label>
                      <label className="field-row">
                        <span className="f-label">模型名</span>
                        <input className="input is-mid" type="text" placeholder={ready ? (meta?.defaultModel ?? '') : '尚未读取'} value={rc.model} disabled={!ready}
                          onChange={(e) => setModels({ ...models, [role]: { ...rc, model: e.target.value } })} />
                      </label>
                    </div>
                    {ready && followsTts && !saved?.apiKeySet && (
                      <div className="lrn-inline-note" style={{ marginTop: -2 }}>
                        此栏可以留空：请求地址与密钥均跟随「语音合成」（二者本属同一服务）。模型名须保持接口所给的 id。
                      </div>
                    )}
                    <div className="lrn-actions">
                      <button className="btn btn-sm" disabled={busy !== null} onClick={() => void runTest(role)}>
                        {busy === `test-${role}` ? <Loader2 size={13} className="spin" /> : <FlaskConical size={13} />} 测试该模型
                      </button>
                      {saved?.apiKeySet && (
                        <button className="btn btn-outline-danger btn-sm" disabled={busy !== null}
                          onClick={async () => {
                            setBusy(`clear-${role}`);
                            try {
                              const r = await api<any>('/voice/config', { method: 'PUT', body: JSON.stringify({ enabled, clearKeys: [role] }) });
                              if (r?.ok !== true) { setMsg(`清空失败：${pickErr(r)}`); return; }
                              rememberConfig(CFG_VOICE, r);
                              /* 密钥已清空：读取缓存里那份「已设置：掩码」不能再被渲染出来，故作废该键。
                                 本页不会因此变空 —— 当前状态已由下面的 applyCfg(r) 就地更新；
                                 下次进本页的首帧则取自上面刚写的跨会话配置缓存（内容就是这份回包）。 */
                              dropCacheValue('voice:config');
                              applyCfg(r); setMsg(`已清空「${roleName(role, meta?.label)}」的密钥`);
                            } catch (e: any) { setMsg(`清空失败：${pickErr(e)}`); }
                            finally { setBusy(null); }
                          }}>
                          <Trash2 size={13} /> 清空密钥
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* ───────── 音色库 ───────── */}
            <div className="card">
              {/* 音色库与配置同属一次读取（同一个 Promise.all），故同一条进度条 */}
              <div className="card-title">
                <Volume2 size={17} /> 音色库
                <span className="lrn-updated">内置音色可直接试听；自建音色由文字描述生成或上传样本复刻</span>
              </div>

              {/* 如实告知降级（不是静默改变行为）：本浏览器没有「选文件夹」能力时（Firefox / Safari 等
                  非 Chromium 内核），这一句一直写在页面上，用户点导出之前就知道会退成什么。 */}
              {!fsa.folder && (
                <div className="lrn-inline-note">
                  当前浏览器不支持选文件夹（File System Access API 只在 Chrome / Edge 等安全上下文中可用），
                  导出将改为{fsa.save ? '逐个文件保存（每个文件弹一次保存框）' : '逐个下载到浏览器的下载目录'}；
                  每个文件仍按「音色-名字-类型-音色id」命名。
                </div>
              )}

              {preview && (
                <div className="lrn-inline-note" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <b>试听：{preview.label}</b>
                  <audio key={pvSeq} ref={audioRef} controls src={preview.url} style={{ height: 32 }} />
                  <button className="btn btn-sm" onClick={() => setPreview(null)}>收起播放器</button>
                </div>
              )}

              <div className="lrn-block">
                {/* 音色清单尚未读到（本次会话既没有读取缓存、配置缓存里也没有内置音色清单）时，
                    不能把「0 个」当成事实显示。 */}
                <div className="lrn-block-title">{voicesKnown ? `内置音色（${builtin?.length ?? 0} 个）` : '内置音色'}</div>
                {/* 原来这里是一行「正在读取音色库；读到之前这里不显示任何音色条目。」——
                    改成：一无所有时用骨架占位（形状即列表行），读到内容后原地替换，全程没有那行字。 */}
                {!voicesKnown && <Skeleton rows={4} />}
                <div className="lrn-status-list">
                  {(builtin ?? []).map((v) => (
                    <div className="lrn-status-row" key={v.id} style={{ cursor: 'default' }}>
                      <div className="lrn-status-main">
                        <div className="lrn-status-uid">
                          <b>{v.label}</b>
                          <span className="lrn-nick">{v.lang}{v.gender !== '—' ? ` · ${v.gender}` : ''}</span>
                          {defaultVoice === v.id && <span className="badge badge-success">当前默认</span>}
                          <span className="lrn-status-caret">{v.id}</span>
                        </div>
                        {v.note && <div className="lrn-status-preview" style={{ opacity: .75 }}>{v.note}</div>}
                        <div className="lrn-actions">
                          <button className="btn btn-primary btn-sm" disabled={!!pvBusy[`builtin:${v.id}`]}
                            onClick={() => void doPreview(v.label, { mode: 'tts', voice: v.id, text: SAMPLE_TEXT }, `builtin:${v.id}`)}>
                            {pvBusy[`builtin:${v.id}`] ? <Loader2 size={13} className="spin" /> : <Play size={13} />} 试听
                          </button>
                          <button className="btn btn-sm" onClick={() => setDefaultVoice(v.id)}>设为默认音色</button>
                          {/* 导出：内置音色在桥侧没有样本文件（声音是每次现合成的），所以这里只会导出一份
                              .json 配置信息 —— 这一点直接写在按钮提示里，免得点完才发现没有音频。 */}
                          <button className="btn btn-sm" disabled={expBusy !== null}
                            title="内置音色没有样本文件：只能导出配置信息（.json）"
                            onClick={() => void exportVoices([builtinExportVoice(v, defaultVoice === v.id)])}>
                            {expBusy === v.id ? <Loader2 size={13} className="spin" /> : <Download size={13} />} 导出
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="lrn-divider" />

              <div className="lrn-block">
                <div className="lrn-block-title"><Wand2 size={14} /> 新建音色（两种方式，选填其一）</div>
                <div className="cfg-fields">
                  <label className="field-row">
                    <span className="f-label">音色名字</span>
                    <input className="input is-mid" type="text" placeholder="例如：清亮少女音" value={newName} onChange={(e) => setNewName(e.target.value)} />
                  </label>
                  <label className="field-row">
                    <span className="f-label">① 文字描述（生成音色）</span>
                    <input className="input" type="text" placeholder="例如：十六七岁少女音，清亮柔和，语速稍快，带一点笑意"
                      value={newDesc} onChange={(e) => setNewDesc(e.target.value)} />
                  </label>
                  <div className="field-row">
                    <span className="f-label">② 音频样本（复刻音色）</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <input ref={fileRef} type="file" accept="audio/mpeg,audio/wav,.mp3,.wav" style={{ display: 'none' }}
                        onChange={(e) => onPickFile(e.target.files?.[0] ?? null)} />
                      <button className="btn btn-sm" onClick={() => fileRef.current?.click()}><Upload size={13} /> 选择 mp3 / wav 文件</button>
                      {sample && <span className="lrn-dk">{sample.name}（{(sample.bytes / 1024).toFixed(0)}KB）</span>}
                    </div>
                  </div>
                  {/* ③ 2026-09-26：不必自己先下载再上传 —— 直接选一个已有音色，取它的声音当样本。
                      文字设计音色取的是**它实际发声用的那段锚点**（没有就现场冻一个），
                      内置音色没有样本文件、现场录一段固定文本；②上传了文件时以②为准。 */}
                  <div className="field-row">
                    <span className="f-label">③ 用已有音色当样本</span>
                    <Dropdown className="input is-mid" value={sampleFrom} onChange={setSampleFrom} disabled={!ready}
                      placeholder="不选用（改用②的样本或①的文字描述）"
                      options={[{ value: '', label: '不选用（改用②的样本或①的文字描述）' },
                        ...voiceOptions.map((o) => ({ value: o.id, label: o.label }))]} />
                  </div>
                </div>
                <div className="lrn-actions">
                  <button className="btn btn-primary btn-sm" disabled={!!pvBusy['new-design'] || !newDesc.trim()}
                    onClick={() => void doPreview('文字描述音色（未保存）', { mode: 'design', text: SAMPLE_TEXT, description: newDesc.trim() }, 'new-design')}>
                    {pvBusy['new-design'] ? <Loader2 size={14} className="spin" /> : <Play size={14} />} 试听描述音色
                  </button>
                  <button className="btn btn-primary btn-sm" disabled={!!pvBusy['new-clone'] || !sample}
                    onClick={() => void doPreview('样本复刻音色（未保存）', { mode: 'clone', text: SAMPLE_TEXT, sampleBase64: sample?.base64 ?? '' }, 'new-clone')}>
                    {pvBusy['new-clone'] ? <Loader2 size={14} className="spin" /> : <Play size={14} />} 试听复刻音色
                  </button>
                  <button className="btn btn-primary btn-sm" disabled={busy !== null || !ready || !newName.trim()}
                    onClick={() => void saveVoice((sample || sampleFrom) ? 'clone' : 'design')}>
                    {busy === 'save-voice' ? <Loader2 size={14} className="spin" /> : <Plus size={14} />}
                    保存音色（{sample ? '按复刻' : sampleFrom ? '按已有音色的样本' : '按文字描述'}）
                  </button>
                </div>
                {/* 【2026-09-28 重排】这一条原先是一整段散文，且正文里写着 `**复刻音色**` 与
                    `` `state/voice-samples/` `` —— 那是写作时的 Markdown 习惯，JSX 里不会被解析，
                    界面上就照原样显示成了星号与反引号（使用方截图指出）。现在按两行排、
                    关键词用 <b>／<code>，同时把容器改成块级（`.lrn-inline-note` 是 inline-flex，
                    元素子节点会被拆成 flex 子项、正文会错位换行）。 */}
                <div className="lrn-inline-note" style={{ display: 'block', lineHeight: 1.75 }}>
                  <div>文字描述音色：每次合成都依据描述生成，音色稳定但不依赖样本；样本复刻：以上传的那段声音复刻，更接近本人。仅支持 mp3 / wav，样本须控制在 7MB 以内。</div>
                  <div>③ 用已有音色当样本：文字设计音色取它正在用的那段锚点（没有则现场冻一个），内置音色现场录一段固定文本；取到后按 <b>复刻音色</b> 存下来，样本存进音色样本库，今后不再被重新设计。</div>
                  {/* 与本地引擎的关系（本次新增）：只说清两类音色各自走哪条路，不给音色加"绑本地角色"这类新字段。 */}
                  <div>与本地引擎的关系：<b>复刻音色</b>（clone）本地引擎能直接用 —— 本地角色 + 这段样本当参考音频；<b>文字设计音色</b>（design）只走云端。想在本地引擎上试听，先在上面那张「本地语音引擎」卡里选好默认角色。</div>
                </div>
              </div>

              {custom.length > 0 && (
                <div className="lrn-block">
                  <div className="lrn-block-title">已保存的音色（{custom.length} 个）</div>
                  {/* 导出全部：把这一页能看到的自建音色一次导出到一个文件夹（内置音色不在此列 ——
                      它们没有样本文件，且导出全部的目标是"我自己的音色库"）。 */}
                  <div className="lrn-actions">
                    <button className="btn btn-sm" disabled={expBusy !== null}
                      title="把下面这些自建音色（样本音频 + 同名 .json 配置信息）一次导出到一个文件夹"
                      onClick={() => void exportVoices(custom.map((v) => customExportVoice(v, defaultVoice === v.id)))}>
                      {expBusy === 'all' ? <Loader2 size={13} className="spin" /> : <Download size={13} />} 导出全部（{custom.length} 个）
                    </button>
                  </div>
                  {/* 【2026-09-28 重排】这一段原先是一整段散文里夹着一个 <b> 文件名，而 `.lrn-inline-note`
                      是 `display:inline-flex`（见 styles/app.css）—— 元素子节点会被当作 flex 子项，
                      整段文字于是被拆成「正文 … ｜ 粗体文件名 ｜ …正文」几块，各自换行、还带 6px 间隙，
                      看起来就是文件名跑到行中间、后文缩进到下一行（使用方截图指出）。
                      改法：这一块改成块级、按三行排（导出内容 / 没有样本的音色 / 文件名），
                      文件名与前缀用 <code> 而不是 <b>，整段不再出现"半句话被搬走"的排版。 */}
                  <div className="lrn-inline-note" style={{ display: 'block', lineHeight: 1.75 }}>
                    <div>导出内容：每个音色的样本音频 + 一份同名 <code>.json</code> 配置信息（id／名字／类型／生成方式／描述／创建时间／是否默认／样本文件名）。</div>
                    <div>没有样本文件的音色（内置音色、纯文字设计音色、样本已丢失的复刻音色）只导出配置信息，不会凭空生成音频。</div>
                    <div>文件名形如 <code>音色-名字-类型-音色id.mp3</code>；重名时自动加序号，不覆盖已有文件。</div>
                  </div>
                  <div className="lrn-status-list">
                    {custom.map((v) => (
                      <div className="lrn-status-row" key={v.id} style={{ cursor: 'default' }}>
                        <div className="lrn-status-main">
                          <div className="lrn-status-uid">
                            <b>{v.name}</b>
                            <span className="badge badge-soft">{v.kind === 'clone' ? '样本复刻' : '文字设计'}</span>
                            {/* 2026-09-26：复刻音色的样本文件丢了（历史上样本存在 napcat 临时目录里，被清理过），
                                这种音色一用就报「音色复刻需要上传音频样本」，必须在列表里就能一眼看出来。 */}
                            {v.kind === 'clone' && !v.hasSample && (
                              <span className="badge badge-soft">样本丢失</span>
                            )}
                            {defaultVoice === v.id && <span className="badge badge-success">当前默认</span>}
                          </div>
                          {v.description && <div className="lrn-status-preview">{v.description}</div>}
                          <div className="lrn-actions">
                            <button className="btn btn-primary btn-sm" disabled={!!pvBusy[`saved:${v.id}`]}
                              onClick={() => void doPreview(v.name, { voiceId: v.id, text: SAMPLE_TEXT }, `saved:${v.id}`)}>
                              {pvBusy[`saved:${v.id}`] ? <Loader2 size={13} className="spin" /> : <Play size={13} />} 试听
                            </button>
                            <button className="btn btn-sm" onClick={() => setDefaultVoice(v.id)}>设为默认音色</button>
                            {/* 导出一条：复刻音色 = 样本音频 + 同名 .json；文字设计音色没有样本文件，
                                只导 .json 并在提示里说清（见 customExportVoice 的 hasSample / noSampleReason）。 */}
                            <button className="btn btn-sm" disabled={expBusy !== null}
                              title={v.kind === 'clone' && v.hasSample
                                ? '导出这个音色的样本音频 + 一份同名 .json 配置信息'
                                : '该音色没有样本文件，只能导出配置信息（.json）'}
                              onClick={() => void exportVoices([customExportVoice(v, defaultVoice === v.id)])}>
                              {expBusy === v.id ? <Loader2 size={13} className="spin" /> : <Download size={13} />} 导出
                            </button>
                            <button className="btn btn-outline-danger btn-sm" disabled={busy !== null} onClick={() => void removeVoice(v)}>
                              {busy === `del-${v.id}` ? <Loader2 size={13} className="spin" /> : <Trash2 size={13} />} 删除
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

      </div>
    </div>
  );
}
