// 共享的敏感信息审计：桥接回复、MCP 发送、审批/提问文本统一使用，避免两处维护不一致。
//
// 设计要点（V3，本机部署修正）：
// - 只拦截“明显像凭据/本机敏感路径”的形态，不再因聊天里提到 token/密码/密钥 等词就误伤。
//   例：`token 是什么`、`密码是手机号吗` 这类正常聊天不再命中；
//   例：`token: sk-xxxx`、`password=12345678`、`C:\Users\...\.ssh\id_rsa` 仍命中。
// - 路径要求是“绝对路径形态”：盘符路径、UNC、/home|/etc|/var|/Users|/tmp|/opt 开头，
//   且后面跟着至少 1 个非空白内容。不再把 /app/、/root/ 一律当敏感：桥接从服务器迁移后
//   模型向用户汇报时可能提到 /app/napcat、/root/.dsh 等“项目自身部署形态”路径（说明性问题，
//   非真实本机凭据）；而 /root/.ssh、/root/.aws 这类密钥目录仍会被 credential 形态覆盖。
// - 凭据要求是“键 + 赋值符(:/=：) + 至少 6 位 ASCII 形态值”；纯中文举例不命中。

const PATH_RE = /(?<![A-Za-z0-9])[A-Za-z]:[\\/](?!\s)[^\s"'<>|，。；、]{2,}|\\\\[^\\s]+\\\\.*?(?<![,\s])|(?<![A-Za-z0-9])(?:\/home\/|\/Users\/|\/etc\/|\/var\/|\/tmp\/|\/opt\/)[^\s"'<>|，。；、]{1,}/;
// 密钥文件形态（不限盘符）：.ssh/、.aws/、.gnupg/、id_rsa/dsa/ecdsa/ed25519、*.pem、credentials、.netrc
const SECRET_PATH_RE = /(?:\/|\\|^)(?:\.ssh\/|\.aws\/|\.gnupg\/|id_rsa|id_dsa|id_ecdsa|id_ed25519|[\w.-]+\.pem|credentials|\.netrc)(?=[/\\\s"'<>|，。；、]|$)/i;
const CRED_RE = /(?:token|密码|密钥|口令|password|passwd|secret|api[_-]?key|access[_-]?key|authorization|bearer|credential|私钥)(?:\s*)(?:[:=：])(?:\s*)[A-Za-z0-9_\-./+@]{6,}/i;

// 银行卡正则（16~19位数字，支持空格/连字符分隔，包含典型银联/Visa/MasterCard等格式）
export const BANK_CARD_RE = /(?<!\d)(?:62\d{14,17}|4\d{15}|5[1-5]\d{14}|(?:[4-6]\d{3}[ -]\d{4}[ -]\d{4}[ -]\d{4}))(?!\d)/g;

// 支付密码/交易密码（带语义指示的6位纯数字凭据，如微信支付密码、银行卡取款密码等）
export const PAYMENT_PIN_RE = /((?:支付密码|交易密码|取款密码|提现密码|银行卡密码|付款密码|付款码|支付口令|pay[_-]?pin|pay[_-]?pass(?:word)?)\s*(?:[:=：为是]\s*|\s*))(\d{6})\b/gi;

// 身份证号正则（18位二代身份证）
export const ID_CARD_RE = /(?<!\d)([1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx])(?!\d)/g;

export const SENSITIVE_RE = new RegExp(`${PATH_RE.source}|${SECRET_PATH_RE.source}|${CRED_RE.source}|${PAYMENT_PIN_RE.source}|${BANK_CARD_RE.source}|${ID_CARD_RE.source}`, 'i');

/**
 * 隐私敏感信息脱敏：自动打码支付密码、银行卡号、身份证号
 * @param {string} text
 * @returns {string}
 */
export function maskPrivacySensitiveText(text) {
  let s = String(text ?? '');
  if (!s) return s;

  // 1. 支付密码脱敏（保留提示词，6位数字密码打码为 ******）
  s = s.replace(PAYMENT_PIN_RE, '$1******');

  // 2. 银行卡号掩码脱敏（保留前4后4，中间打码为 ****）
  s = s.replace(BANK_CARD_RE, (m) => {
    const clean = m.replace(/[ -]/g, '');
    if (clean.length < 16 || clean.length > 19) return m;
    return clean.slice(0, 4) + '****' + clean.slice(-4);
  });

  // 3. 身份证号掩码脱敏（保留前6后4，中间打码为 ********）
  s = s.replace(ID_CARD_RE, (m) => {
    return m.slice(0, 6) + '********' + m.slice(-4);
  });

  return s;
}

// 判断命中类别，便于日志定位真伪。返回 null | 'path' | 'secret-path' | 'credential' | 'payment-pin' | 'bank-card' | 'id-card'
export function sensitiveHitKind(text) {
  const s = String(text ?? '');
  if (PAYMENT_PIN_RE.test(s)) return 'payment-pin';
  if (BANK_CARD_RE.test(s)) return 'bank-card';
  if (ID_CARD_RE.test(s)) return 'id-card';
  if (PATH_RE.test(s)) return 'path';
  if (SECRET_PATH_RE.test(s)) return 'secret-path';
  if (CRED_RE.test(s)) return 'credential';
  return null;
}

// 供日志使用：只暴露命中类别与命中的少量上下文（本身仍可能含凭据，仅写入服务器端日志）。
export function sensitiveHitSample(text, max = 48) {
  const s = String(text ?? '');
  for (const re of [PATH_RE, CRED_RE]) {
    const m = re.exec(s);
    if (m && m[0]) return m[0].slice(0, max);
  }
  return '';
}
