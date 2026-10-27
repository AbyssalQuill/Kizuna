// 洛谷 (Luogu) 题面、题解、每日一题与公开用户视奸
import { log } from '../lib/log.js';

const DIFFICULTY_MAP = {
  0: '暂无评定',
  1: '入门',
  2: '普及-',
  3: '普及/提高-',
  4: '普及+/提高',
  5: '提高+/省选-',
  6: '省选/NOI-',
  7: 'NOI/NOI+/CTSC'
};

const USER_COLOR_MAP = {
  'Gray': '灰名 (未实名/初入江湖)',
  'Blue': '蓝名 (探索者)',
  'Green': '绿名 (进阶者)',
  'Orange': '橙名 (刷题达人)',
  'Red': '红名 (算法神犇)',
  'Purple': '紫名 (洛谷管理员/官方)'
};

// 经典洛谷题库池（涵盖入门、普及、提高不同梯度的优质经典题，用于每日一题轮换）
const DAILY_PROBLEMS_POOL = [
  { pid: 'P1001', name: 'A+B Problem', difficulty: '入门', tag: '语言基础' },
  { pid: 'P1002', name: '过河卒', difficulty: '普及-', tag: '递推 / 动态规划' },
  { pid: 'P1009', name: '阶乘之和', difficulty: '普及-', tag: '高精度 / 模拟' },
  { pid: 'P1024', name: '一元三次方程求解', difficulty: '普及/提高-', tag: '二分查找 / 数学' },
  { pid: 'P1048', name: '采药', difficulty: '普及-', tag: '01背包 / 动态规划' },
  { pid: 'P1060', name: '开心的金明', difficulty: '普及-', tag: '背包 DP' },
  { pid: 'P1090', name: '合并果子', difficulty: '普及/提高-', tag: '贪心 / 优先队列' },
  { pid: 'P1115', name: '最大子段和', difficulty: '普及-', tag: '前缀和 / 动态规划' },
  { pid: 'P1177', name: '【模板】快速排序', difficulty: '普及-', tag: '排序 / 分治' },
  { pid: 'P1219', name: '八皇后', difficulty: '普及/提高-', tag: 'DFS / 回溯' },
  { pid: 'P1425', name: '小鱼的游泳时间', difficulty: '入门', tag: '简单模拟' },
  { pid: 'P1908', name: '逆序对', difficulty: '普及/提高-', tag: '归并排序 / 树状数组' },
  { pid: 'P3371', name: '【模板】单源最短路径 (弱化版)', difficulty: '普及+/提高', tag: 'Dijkstra / 图论' },
  { pid: 'P3372', name: '【模板】线段树 1', difficulty: '普及+/提高', tag: '线段树 / 数据结构' },
  { pid: 'P3367', name: '【模板】并查集', difficulty: '普及-', tag: '并查集 / 图论' },
  { pid: 'P1601', name: 'A+B Problem (高精)', difficulty: '普及-', tag: '高精度计算' },
  { pid: 'P1044', name: '栈', difficulty: '普及/提高-', tag: '卡特兰数 / 组合数学' }
];

let cfgRef = null;

export function initLuoguCore(cfg) {
  cfgRef = cfg;
}

/** 规范化题号：如 p1001 -> P1001, 1001 -> P1001 */
export function normalizePid(rawPid) {
  let pid = String(rawPid ?? '').trim();
  if (/^\d+$/.test(pid)) pid = 'P' + pid;
  return pid.toUpperCase();
}

/** 洛谷通用 HTML 数据提取器（处理 302 C3VK 挑战与 JSON 数据内嵌提取） */
async function fetchLuoguPage(url, customCookie = '') {
  const cookie = customCookie || cfgRef?.luogu?.cookie || (cfgRef?.luogu?.clientId ? `__client_id=${cfgRef.luogu.clientId}` : '');
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  };

  let activeCookie = cookie;
  // 1. 发起探测请求以捕获 302 C3VK 校验 Cookie
  const r1 = await fetch(url, {
    redirect: 'manual',
    headers: { ...headers, ...(activeCookie ? { Cookie: activeCookie } : {}) }
  });

  const setCookie = r1.headers.get('set-cookie');
  if (setCookie) {
    const c3vk = setCookie.split(';')[0];
    activeCookie = activeCookie ? `${activeCookie}; ${c3vk}` : c3vk;
  }

  // 2. 正式拉取页面
  const r2 = await fetch(url, {
    headers: {
      ...headers,
      ...(activeCookie ? { Cookie: activeCookie } : {})
    }
  });

  const text = await r2.text();

  // 3. 从 HTML 中的 <script> 标签内提取注入的 JSON 数据块
  const scriptTags = [...text.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)];
  for (const m of scriptTags) {
    const content = m[2].trim();
    if (content.startsWith('{') && content.includes('"data"')) {
      try {
        const parsed = JSON.parse(content);
        return { status: r2.status, ...parsed };
      } catch {}
    }
  }

  // 备用方式：直接解析返回内容
  try {
    const direct = JSON.parse(text);
    return { status: r2.status, data: direct };
  } catch {
    throw new Error(`洛谷接口返回异常 (HTTP ${r2.status})，可能受到反爬安全验证限制`);
  }
}

/**
 * 查题面：获取指定题目的详细信息
 * @param {string} rawPid 题号 (如 P1001, B2002, CF4A 等)
 */
export async function getLuoguProblem(rawPid) {
  const pid = normalizePid(rawPid);
  const url = `https://www.luogu.com.cn/problem/${pid}`;
  log(`[luogu] 正在获取题面: ${pid} -> ${url}`);

  const res = await fetchLuoguPage(url);
  if (res.template === 'error') {
    throw new Error(res.data?.errorMessage || '题目不存在或无权限访问');
  }

  const p = res.data?.problem;
  if (!p) throw new Error(`未找到题号为 ${pid} 的题目信息`);

  const diffName = DIFFICULTY_MAP[p.difficulty] || '未知难度';
  const timeLimit = Array.isArray(p.limits?.time) ? Math.max(...p.limits.time) : 1000;
  const memoryLimit = Array.isArray(p.limits?.memory) ? Math.max(...p.limits.memory) / 1024 : 128; // KB -> MB
  const acRate = p.totalSubmit > 0 ? ((p.totalAccepted / p.totalSubmit) * 100).toFixed(1) : '0.0';

  // 样例输入输出
  let samplesText = '';
  if (Array.isArray(p.samples) && p.samples.length > 0) {
    samplesText = p.samples.map((s, idx) => {
      const inp = s[0] ?? '';
      const out = s[1] ?? '';
      return `【样例 ${idx + 1} 输入】:\n\`\`\`\n${inp}\n\`\`\`\n【样例 ${idx + 1} 输出】:\n\`\`\`\n${out}\n\`\`\``;
    }).join('\n\n');
  }

  const formatted = [
    `【洛谷 ${p.pid}】${p.name}`,
    `难度: ${diffName} | 时限: ${timeLimit}ms | 空间: ${memoryLimit.toFixed(0)}MB`,
    `提交数: ${p.totalSubmit} | 通过数: ${p.totalAccepted} | 通过率: ${acRate}%`,
    p.background ? `\n【题目背景】:\n${p.background}` : '',
    p.description ? `\n【题目描述】:\n${p.description}` : '',
    p.inputFormat ? `\n【输入格式】:\n${p.inputFormat}` : '',
    p.outputFormat ? `\n【输出格式】:\n${p.outputFormat}` : '',
    samplesText ? `\n${samplesText}` : '',
    p.hint ? `\n【说明/提示】:\n${p.hint}` : ''
  ].filter(Boolean).join('\n');

  return {
    ok: true,
    pid: p.pid,
    name: p.name,
    difficulty: diffName,
    timeLimit,
    memoryLimit,
    totalSubmit: p.totalSubmit,
    totalAccepted: p.totalAccepted,
    acRate: `${acRate}%`,
    description: p.description,
    inputFormat: p.inputFormat,
    outputFormat: p.outputFormat,
    samples: p.samples,
    hint: p.hint,
    text: formatted
  };
}

/**
 * 视奸用户：查询洛谷用户的公开档案、估值与做题状态
 * @param {string|number} rawUid 洛谷用户 UID (数字)
 */
export async function getLuoguUser(rawUid) {
  const uid = String(rawUid ?? '').trim().replace(/^UID:?/i, '');
  if (!uid) throw new Error('必须提供洛谷用户 UID');

  const url = `https://www.luogu.com.cn/user/${uid}`;
  log(`[luogu] 正在查询用户信息 (视奸): ${uid} -> ${url}`);

  const res = await fetchLuoguPage(url);
  if (res.template === 'error') {
    throw new Error(res.data?.errorMessage || '用户不存在或主页已被设置为隐私隐藏');
  }

  const u = res.data?.user;
  if (!u) throw new Error(`未找到 UID 为 ${uid} 的用户`);

  const colorDesc = USER_COLOR_MAP[u.color] || u.color || '常规';
  const ccf = u.ccfLevel ? `CCF 认证 ${u.ccfLevel} 级` : '未认证';
  const ranking = u.ranking ? `全站第 ${u.ranking} 名` : '未上榜';
  const slogan = u.slogan || '（这家伙很懒，什么个性签名也没留下）';

  // 咕值详情 (如果公开)
  const gu = res.data?.gu;
  let guzhiText = '';
  if (gu) {
    const totalGu = (gu.basic || 0) + (gu.practice || 0) + (gu.community || 0) + (gu.contest || 0) + (gu.achievement || 0);
    guzhiText = `咕值总分: ${totalGu} (基础信用: ${gu.basic || 0}, 练习情况: ${gu.practice || 0}, 社区贡献: ${gu.community || 0}, 比赛情况: ${gu.contest || 0}, 获得成就: ${gu.achievement || 0})`;
  }

  // 格式化视奸报告
  const report = [
    `【洛谷公开档案 · 视奸报告】`,
    `昵称: ${u.name} (UID: ${u.uid})`,
    `身份/头衔: ${u.badge ? `[${u.badge}] ` : ''}${colorDesc}${u.isAdmin ? ' · 官方管理' : ''}`,
    `实力认证: ${ccf} | ${ranking}`,
    `关注数: ${u.followingCount ?? 0} | 粉丝数: ${u.followerCount ?? 0}`,
    `个性签名: “${slogan}”`,
    guzhiText ? `${guzhiText}` : '',
    u.introduction ? `\n个人主页简介 (前 200 字):\n${u.introduction.slice(0, 200)}${u.introduction.length > 200 ? '...' : ''}` : ''
  ].filter(Boolean).join('\n');

  return {
    ok: true,
    uid: u.uid,
    name: u.name,
    badge: u.badge,
    color: u.color,
    colorDesc,
    ccfLevel: u.ccfLevel,
    ranking: u.ranking,
    slogan: u.slogan,
    followingCount: u.followingCount,
    followerCount: u.followerCount,
    gu: res.data?.gu || null,
    report
  };
}

/**
 * 洛谷每日一题
 * 按当日日期产生稳定的经典/精品题目推荐
 */
export async function getLuoguDaily(dateKey = '') {
  const day = dateKey || new Date().toISOString().slice(0, 10);
  // 用日期生成确定性哈希
  let hash = 0;
  for (let i = 0; i < day.length; i++) {
    hash = ((hash << 5) - hash) + day.charCodeAt(i);
    hash |= 0;
  }
  const index = Math.abs(hash) % DAILY_PROBLEMS_POOL.length;
  const picked = DAILY_PROBLEMS_POOL[index];

  try {
    const detail = await getLuoguProblem(picked.pid);
    return {
      ok: true,
      day,
      picked,
      detail: detail.text,
      problem: detail
    };
  } catch (err) {
    // 兜底返回池中概要
    return {
      ok: true,
      day,
      picked,
      detail: `【今日洛谷每日一题 (${day})】\n题号: ${picked.pid} - ${picked.name}\n难度: ${picked.difficulty} | 核心标签: ${picked.tag}\n题目链接: https://www.luogu.com.cn/problem/${picked.pid}`
    };
  }
}

/**
 * 查题解：获取洛谷题解或解题思路
 */
export async function getLuoguSolution(rawPid) {
  const pid = normalizePid(rawPid);
  const url = `https://www.luogu.com.cn/problem/solution/${pid}`;
  log(`[luogu] 正在获取题解: ${pid} -> ${url}`);

  try {
    const res = await fetchLuoguPage(url);
    if (res.template === 'error') {
      // 洛谷查看题解可能需登录 Cookie
      const needLogin = res.data?.errorMessage?.includes('登录') || res.status === 401;
      return {
        ok: false,
        needLogin,
        pid,
        message: needLogin
          ? '洛谷题解需要登录态后方可查阅。请在管理端配置洛谷 Cookie，或者由我直接为你讲解解题思路并写出 C++ 代码哦！'
          : (res.data?.errorMessage || '暂无可用公开题解')
      };
    }

    const solList = res.data?.solutions?.result;
    if (Array.isArray(solList) && solList.length > 0) {
      const top = solList[0];
      return {
        ok: true,
        pid,
        author: top.author?.name,
        content: top.content?.slice(0, 4000)
      };
    }

    return {
      ok: false,
      pid,
      message: '该题目暂无官方题解记录。'
    };
  } catch (err) {
    return {
      ok: false,
      pid,
      error: err.message,
      message: `获取题解遇到网络或权限限制：${err.message}`
    };
  }
}
