// 混合向量检索（bge-small-zh-v1.5 512d ONNX + FTS5 BM25 RRF 重排）专项测试
import assert from 'node:assert/strict';
import {
  BGE_DIM, bgeModelFilesReady, embedBgeAsync, embedFallbackSync, cosineSimilarity,
} from '../src/lib/embedding.js';
import {
  initMemoryDb, memDb, rememberEntry, listMemoryEntries, memoryDigest,
  warmQueryEmbedding, backfillMemoryEmbeddings, memoryStats,
} from '../src/core/memory.js';

initMemoryDb();

const TEST_UID = '999888777';

// 1. 验证 bge-small-zh-v1.5 512 维 ONNX 模型推理与 L2 归一化
if (bgeModelFilesReady()) {
  const qVec = await embedBgeAsync('上次说的夜宵吃什么', { isQuery: true });
  const dPos = await embedBgeAsync('主人喜欢半夜点烧烤和炸鸡', { isQuery: false });
  const dNeg = await embedBgeAsync('今天下午把生产环境服务器重启了一下', { isQuery: false });
  assert.ok(qVec && qVec.length === BGE_DIM, 'BGE query 向量维度应为 512');
  let norm = 0;
  for (let i = 0; i < qVec.length; i++) norm += qVec[i] * qVec[i];
  assert.ok(Math.abs(norm - 1.0) < 1e-4, 'BGE 向量应已完成 L2 归一化');
  const simPos = cosineSimilarity(qVec, dPos);
  const simNeg = cosineSimilarity(qVec, dNeg);
  assert.ok(simPos > simNeg + 0.15, `同义跨字面相似度(${simPos.toFixed(3)})应显著高于无关文本(${simNeg.toFixed(3)})`);
  console.log(`PASS  ① bge-small-zh-v1.5 (512d ONNX) 跨字面语义区分度验证通过 (${simPos.toFixed(3)} vs ${simNeg.toFixed(3)})`);
}

// 2. 验证零字面重合下的 Hybrid RRF 记忆召回（“夜宵” -> “半夜点烧烤和炸鸡”）
const r1 = rememberEntry({ uid: TEST_UID, category: 'preference', content: '主人喜欢半夜点烧烤和炸鸡', importance: 60 });
const r2 = rememberEntry({ uid: TEST_UID, category: 'note', content: '周三下午要去拿快递和买洗衣液', importance: 60 });
const r3 = rememberEntry({ uid: TEST_UID, category: 'pet', content: '家里养了一只叫团子的布偶猫', importance: 60 });
assert.ok(r1.ok && r2.ok && r3.ok, '测试记忆写入应成功');

// 2a. 同步回退状态下的跨字面召回
const syncRes = listMemoryEntries({ uid: TEST_UID, query: '夜宵吃啥', limit: 5 });
assert.ok(syncRes.ok && syncRes.hybrid, '带 query 的 listMemoryEntries 应走 hybrid RRF 分支');
assert.ok(syncRes.entries.length >= 1, '零字面重合“夜宵吃啥”应能召回“烧烤和炸鸡”');
assert.ok(syncRes.entries[0].content.includes('烧烤和炸鸡'), `首位召回结果应为烧烤炸鸡，实得: ${syncRes.entries[0]?.content}`);
console.log('PASS  ② 零字面重合下同步语义回退召回通过（“夜宵吃啥” -> “主人喜欢半夜点烧烤和炸鸡”）');

// 2b. 回填 512 维 BGE 向量并预热 Query 后的神经网络 RRF 召回
await backfillMemoryEmbeddings();
await warmQueryEmbedding('想撸家里的小宠物了');
const bgeRes = listMemoryEntries({ uid: TEST_UID, query: '想撸家里的小宠物了', limit: 5 });
assert.ok(bgeRes.ok && bgeRes.entries.length >= 1, 'BGE 512d 向量检索应召回宠物记忆');
assert.ok(bgeRes.entries[0].content.includes('团子'), `首位召回结果应为布偶猫团子，实得: ${bgeRes.entries[0]?.content}`);
console.log('PASS  ③ bge-small-zh-v1.5 + FTS5 Hybrid RRF 混合重排召回通过（“想撸家里的小宠物了” -> “布偶猫团子”）');

// 3. 验证 memoryDigest 结合当前对话上下文 query 的动态语义提权
await warmQueryEmbedding('半夜肚子好饿想点外卖');
const digest = memoryDigest({ uid: TEST_UID, query: '半夜肚子好饿想点外卖', limit: 1, maxChars: 200 });
assert.ok(digest.includes('烧烤和炸鸡'), `memoryDigest 传入饥饿语境时应优先浮现烧烤炸鸡记忆，实得: ${digest}`);
console.log('PASS  ④ memoryDigest 当轮语境语义动态提权通过');

const stats = memoryStats();
assert.ok(stats.ok && stats.embeddingModel, 'memoryStats 应包含 embeddingModel 状态');
console.log(`PASS  ⑤ memoryStats 向量状态正常 (model=${stats.embeddingModel}, embedded=${stats.embedded})`);

// 清理测试条目
try { memDb.prepare('DELETE FROM memory_entries WHERE uid = ?').run(TEST_UID); } catch {}

