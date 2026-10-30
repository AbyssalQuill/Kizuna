// 本地轻量级语义向量引擎（BAAI/bge-small-zh-v1.5 ONNX Int8 512维 + 同步概念簇回退）
//
// 架构设计：
//   1. 主引擎（Neural Tier）：基于 onnxruntime-node 运行量化版 bge-small-zh-v1.5（仅 24MB，512 维），
//      内置纯 JS 实现的 BERT WordPiece 分词器（读取 vocab.txt，零额外分词器依赖），
//      对检索 Query 自动注入 BGE v1.5 官方前缀「为这个句子生成表示以用于检索相关文章：」，
//      取 CLS Pooling + L2 归一化得到 Float32Array(512)。
//   2. 同步缓存与零等待回退（Sync Fallback Tier）：
//      由于 memory.js 的 listMemoryEntries / memoryDigest 支持同步调用，本模块维护进程内 LRU 向量缓存
//      与 SQLite BLOB 持久化；在异步预热（warmQueryEmbedding / backfillEmbeddings）已就绪时，
//      同步调用直接命中 512 维 BGE 神经网络向量；若在单测同 tick 尚未完成异步推理，则自动回退到
//      128 维中文同义概念簇 + 字级 N-gram 语义向量，确保任何场景下零阻塞、零报错。

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './paths.js';
import { log } from './log.js';

export const BGE_DIM = 512;
export const FALLBACK_DIM = 128;
export const BGE_QUERY_PREFIX = '为这个句子生成表示以用于检索相关文章：';

const MODEL_DIR = path.join(ROOT, 'state', 'models', 'bge-small-zh-v1.5');
const ONNX_PATH = path.join(MODEL_DIR, 'model_quantized.onnx');
const VOCAB_PATH = path.join(MODEL_DIR, 'vocab.txt');

let vocabMap = null;
let ortModule = null;
let ortSession = null;
let ortInitPromise = null;
let ortUnavailable = false;

// LRU 缓存：key = `${isQuery ? 'Q:' : 'D:'}${normalizedText}` -> Float32Array(512)
const bgeCache = new Map();
const MAX_CACHE_SIZE = 2048;

function cacheSet(key, vec) {
  if (bgeCache.has(key)) bgeCache.delete(key);
  bgeCache.set(key, vec);
  if (bgeCache.size > MAX_CACHE_SIZE) {
    const oldest = bgeCache.keys().next().value;
    if (oldest !== undefined) bgeCache.delete(oldest);
  }
}

/* ── 1. 纯 JS BERT WordPiece 分词器 ───────────────────────────────────────── */

function loadVocab() {
  if (vocabMap) return vocabMap;
  if (!fs.existsSync(VOCAB_PATH)) return null;
  try {
    const lines = fs.readFileSync(VOCAB_PATH, 'utf8').split(/\r?\n/);
    const map = new Map();
    for (let i = 0; i < lines.length; i++) {
      const tok = lines[i];
      if (tok !== '') map.set(tok, i);
    }
    vocabMap = map;
    return vocabMap;
  } catch {
    return null;
  }
}

function isCjkCode(code) {
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0xf900 && code <= 0xfaff)
  );
}

function isPunctCode(code) {
  return (
    (code >= 33 && code <= 47) ||
    (code >= 58 && code <= 64) ||
    (code >= 91 && code <= 96) ||
    (code >= 123 && code <= 126) ||
    (code >= 0x2000 && code <= 0x206f) ||
    (code >= 0x3000 && code <= 0x303f) ||
    (code >= 0xff00 && code <= 0xffef)
  );
}

export function tokenizeBert(text, maxLen = 256) {
  const vocab = loadVocab();
  if (!vocab) return null;
  const clsId = vocab.get('[CLS]') ?? 101;
  const sepId = vocab.get('[SEP]') ?? 102;
  const unkId = vocab.get('[UNK]') ?? 100;

  const clean = String(text ?? '').toLowerCase().trim();
  const basicTokens = [];
  let buf = '';
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    const code = ch.charCodeAt(0);
    if (/\s/.test(ch)) {
      if (buf) { basicTokens.push(buf); buf = ''; }
    } else if (isCjkCode(code) || isPunctCode(code)) {
      if (buf) { basicTokens.push(buf); buf = ''; }
      basicTokens.push(ch);
    } else {
      buf += ch;
    }
  }
  if (buf) basicTokens.push(buf);

  const ids = [clsId];
  const limit = maxLen - 1;
  for (const word of basicTokens) {
    if (ids.length >= limit) break;
    if (vocab.has(word)) {
      ids.push(vocab.get(word));
      continue;
    }
    let start = 0;
    const subIds = [];
    let isBad = false;
    while (start < word.length) {
      let end = word.length;
      let curId = null;
      while (start < end) {
        const sub = (start > 0 ? '##' : '') + word.slice(start, end);
        if (vocab.has(sub)) {
          curId = vocab.get(sub);
          break;
        }
        end -= 1;
      }
      if (curId === null) {
        isBad = true;
        break;
      }
      subIds.push(curId);
      start = end;
    }
    if (isBad) {
      ids.push(unkId);
    } else {
      for (const sid of subIds) {
        if (ids.length >= limit) break;
        ids.push(sid);
      }
    }
  }
  ids.push(sepId);
  return ids;
}

/* ── 2. ONNX Runtime 推理会话（bge-small-zh-v1.5）───────────────────────── */

export function bgeModelFilesReady() {
  return fs.existsSync(ONNX_PATH) && fs.existsSync(VOCAB_PATH);
}

export async function ensureBgeSession() {
  if (ortSession) return ortSession;
  if (ortUnavailable) return null;
  if (!bgeModelFilesReady()) return null;
  if (ortInitPromise) return ortInitPromise;

  ortInitPromise = (async () => {
    try {
      const mod = await import('onnxruntime-node');
      ortModule = mod.default || mod;
      const session = await ortModule.InferenceSession.create(ONNX_PATH, {
        intraOpNumThreads: 2,
        interOpNumThreads: 1,
        graphOptimizationLevel: 'all',
      });
      loadVocab();
      ortSession = session;
      log('[embedding] bge-small-zh-v1.5 (512d Int8 ONNX) 语义向量模型已就绪');
      return session;
    } catch (err) {
      ortUnavailable = true;
      log(`[embedding] ONNX Runtime 未就绪，将使用内置语义概念簇向量回退: ${err?.message ?? err}`);
      return null;
    } finally {
      ortInitPromise = null;
    }
  })();
  return ortInitPromise;
}

function l2Normalize(vec) {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 1e-12) {
    for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  }
  return vec;
}

/**
 * 异步计算 512 维 bge-small-zh-v1.5 语义向量（带内存 LRU 缓存）。
 * @param {string} text
 * @param {{isQuery?: boolean}} opts
 * @returns {Promise<Float32Array|null>}
 */
export async function embedBgeAsync(text, { isQuery = false } = {}) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const cacheKey = `${isQuery ? 'Q:' : 'D:'}${raw.slice(0, 512)}`;
  const cached = bgeCache.get(cacheKey);
  if (cached) return cached;

  const session = await ensureBgeSession();
  if (!session || !ortModule) return null;

  const inputText = isQuery ? `${BGE_QUERY_PREFIX}${raw}` : raw;
  const ids = tokenizeBert(inputText, 256);
  if (!ids || !ids.length) return null;

  try {
    const len = ids.length;
    const inputIds = new BigInt64Array(len);
    const attentionMask = new BigInt64Array(len);
    const tokenTypeIds = new BigInt64Array(len);
    for (let i = 0; i < len; i++) {
      inputIds[i] = BigInt(ids[i]);
      attentionMask[i] = 1n;
      tokenTypeIds[i] = 0n;
    }
    const feeds = {
      input_ids: new ortModule.Tensor('int64', inputIds, [1, len]),
      attention_mask: new ortModule.Tensor('int64', attentionMask, [1, len]),
    };
    if (session.inputNames.includes('token_type_ids')) {
      feeds.token_type_ids = new ortModule.Tensor('int64', tokenTypeIds, [1, len]);
    }
    const results = await session.run(feeds);
    const outName = session.outputNames.includes('sentence_embedding')
      ? 'sentence_embedding'
      : session.outputNames[0];
    const data = results[outName]?.data;
    if (!data || data.length < BGE_DIM) return null;

    // CLS token pooling（前 512 维）+ L2 归一化
    const vec = new Float32Array(BGE_DIM);
    for (let i = 0; i < BGE_DIM; i++) vec[i] = Number(data[i]);
    l2Normalize(vec);
    cacheSet(cacheKey, vec);
    return vec;
  } catch (err) {
    log(`[embedding] BGE 向量推理异常: ${err?.message ?? err}`);
    return null;
  }
}

/**
 * 同步读取已缓存的 BGE 512 维向量（若未命中则异步触发预热并返回 null）。
 */
export function getBgeCached(text, { isQuery = false, triggerWarmup = true } = {}) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const cacheKey = `${isQuery ? 'Q:' : 'D:'}${raw.slice(0, 512)}`;
  const hit = bgeCache.get(cacheKey);
  if (hit) return hit;
  if (triggerWarmup && !ortUnavailable && bgeModelFilesReady()) {
    embedBgeAsync(raw, { isQuery }).catch(() => {});
  }
  return null;
}

/* ── 3. 同步语义概念簇 + N-gram 向量回退（128 维，0 毫秒同步可用）───────── */

const CONCEPT_CLUSTERS = [
  ['夜宵', '宵夜', '烧烤', '烤串', '炸鸡', '汉堡', '泡面', '方便面', '外卖', '半夜吃', '深夜吃', '撸串', '小龙虾', '麻辣烫', '火锅', '夜里饿'],
  ['早餐', '早饭', '午餐', '午饭', '晚餐', '晚饭', '食堂', '做饭', '菜谱', '米饭', '面条', '饺子', '包子', '美食', '好吃', '肚子饿', '饭店', '餐厅'],
  ['奶茶', '咖啡', '拿铁', '美式', '果茶', '柠檬茶', '可乐', '雪碧', '汽水', '饮料', '喝水', '冰美式', '下午茶', '甜品', '蛋糕', '冰淇淋'],
  ['忌口', '不吃', '讨厌吃', '过敏', '香菜', '葱', '姜', '蒜', '辣椒', '吃辣', '微辣', '清淡', '甜党', '咸党', '折耳根', '榴莲'],
  ['宠物', '猫', '猫咪', '小猫', '布偶', '英短', '美短', '橘猫', '狗', '小狗', '修勾', '柴犬', '金毛', '柯基', '仓鼠', '主子', '毛孩子', '撸猫'],
  ['睡觉', '熬夜', '通宵', '失眠', '困了', '晚安', '早安', '起床', '赖床', '午睡', '补觉', '作息', '休息', '梦', '睡不着'],
  ['编程', '代码', '写代码', '程序员', '开发', '前端', '后端', '全栈', '算法', '调试', '报错', 'bug', '重构', '部署', '上线', '服务器', '数据库', '接口', 'api'],
  ['语言', 'python', 'javascript', 'typescript', 'nodejs', 'cpp', 'c++', 'java', 'rust', 'golang', 'sql', 'sqlite', 'react', 'vue', 'linux', 'docker', 'git'],
  ['游戏', '打游戏', '开黑', '上号', 'steam', '原神', '崩铁', '星穹铁道', '鸣潮', '王者', '王者荣耀', 'lol', '英雄联盟', 'valorant', '瓦罗兰特', 'csgo', 'cs2', 'mc', '我的世界', '抽卡', '歪了', '保底'],
  ['动漫', '番剧', '二次元', '追番', '新番', '漫画', '轻小说', 'cos', '漫展', '老婆', '推', '谷子', '手办', '虚拟主播', 'vtb'],
  ['音乐', '听歌', '歌单', '演唱会', '乐队', '吉他', '钢琴', '唱歌', '耳机', '纯音乐', '摇滚', '周杰伦', '术曲', 'vocaloid'],
  ['学习', '考试', '期末', '考研', '考公', '作业', '论文', '毕业', '毕设', '实验', '上课', '逃课', '图书馆', '复习', '挂科', '成绩', '绩点'],
  ['工作', '上班', '加班', '通勤', '摸鱼', '下班', '请假', '周末', '放假', '假期', '工资', '发薪', '面试', '简历', '实习', '老板', '同事'],
  ['心情', '开心', '高兴', '快乐', '爽', '哈哈', '难过', '伤心', '委屈', '郁闷', '烦躁', '生气', '破防', '崩溃', '焦虑', '压力', '累', '疲惫', '无聊'],
  ['天气', '下雨', '暴雨', '台风', '下雪', '晴天', '降温', '好冷', '好热', '空调', '出门', '带伞', '感冒', '发烧', '生病', '头疼', '吃药', '医院'],
  ['旅行', '旅游', '出去玩', '机票', '高铁', '火车', '酒店', '民宿', '景点', '拍照', '打卡', '海边', '爬山', '回家', '过年'],
  ['生日', '过生日', '礼物', '纪念日', '岁', '星座', '愿望', '祝福', '蜡烛'],
  ['规定', '规矩', '记住', '不准', '禁止', '必须', '永远', '设定', '人设', '称呼', '叫我', '主人', '群主', '管理员'],
];

function fnvHash(str, seed = 2166136261) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

/**
 * 128 维同步概念簇 + 字符 N-gram 特征向量（用于 BGE 异步推理完成前的 0ms 同步兜底）。
 */
export function embedFallbackSync(text) {
  const vec = new Float32Array(FALLBACK_DIM);
  const clean = String(text ?? '').toLowerCase().replace(/\s+/g, '');
  if (!clean) return vec;

  // 前 32 维：同义概念簇激活（跨字面同义召回，如“夜宵”与“烧烤/炸鸡”同激活 dim 0）
  for (let c = 0; c < CONCEPT_CLUSTERS.length; c++) {
    const cluster = CONCEPT_CLUSTERS[c];
    let hits = 0;
    for (const word of cluster) {
      if (clean.includes(word)) hits += 1;
    }
    if (hits > 0) {
      vec[c % 32] += 2.5 * Math.min(3, hits);
    }
  }

  // 后 96 维：字符 unigram + bigram 符号哈希投影
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (isPunctCode(ch.charCodeAt(0))) continue;
    const h1 = fnvHash(ch, 0x811c9dc5);
    const idx1 = 32 + (h1 % 96);
    vec[idx1] += (h1 & 1) ? 0.6 : -0.6;

    if (i + 1 < clean.length) {
      const bi = clean.slice(i, i + 2);
      const h2 = fnvHash(bi, 0x9e3779b9);
      const idx2 = 32 + (h2 % 96);
      vec[idx2] += (h2 & 1) ? 1.2 : -1.2;
    }
  }
  return l2Normalize(vec);
}

/* ── 4. BLOB 序列化与余弦相似度 ───────────────────────────────────────────── */

export function vectorToBlob(vec) {
  if (!vec || !(vec instanceof Float32Array) || !vec.length) return null;
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function blobToVector(buf) {
  if (!buf) return null;
  try {
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    if (b.byteLength % 4 !== 0 || b.byteLength === 0) return null;
    const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    return new Float32Array(ab);
  } catch {
    return null;
  }
}

export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}
