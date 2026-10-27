import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pruneSessionSchemaRecords, isSchemaToolName } from '../src/core/turn-pruner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmpDir = path.join(__dirname, '..', '.tmp-test-prune');
fs.mkdirSync(tmpDir, { recursive: true });

console.log('=== 校验 1：isSchemaToolName 工具名判定 ===');
assert.equal(isSchemaToolName('napcat_get_tool_schema'), true, 'napcat_get_tool_schema 识别正确');
assert.equal(isSchemaToolName('mcp__napcat__napcat_get_tool_schema'), true, 'mcp__napcat__napcat_get_tool_schema 识别正确');
assert.equal(isSchemaToolName('dsh_get_tool_schema'), true, 'dsh_get_tool_schema 识别正确');
assert.equal(isSchemaToolName('get_tool_schema'), true, 'get_tool_schema 识别正确');
assert.equal(isSchemaToolName('qq_send_message'), false, 'qq_send_message 不是 schema 工具');
assert.equal(isSchemaToolName('napcat_invoke_tool'), false, 'napcat_invoke_tool 不是 schema 工具');
console.log('PASS: isSchemaToolName 判定准确');

console.log('=== 校验 2：单一 Schema 会话剪枝（多次调用自动去重剪除旧记录） ===');
const fakeSessionId = 'test-session-schema-prune-1';
const fakeSessionPath = path.join(tmpDir, `${fakeSessionId}.json`);

// 模拟会话历史：模型先后调用了两次 schema（比如先查了 qq_send_like 的 schema，后来又查了 qq_send_poke 的 schema）
const fakeSessionContent = JSON.stringify({
  version: 1,
  record: {
    identity: { sessionId: fakeSessionId },
    history: [
      {
        type: 'tool/call',
        callId: 'call_schema_1',
        name: 'napcat_get_tool_schema',
        arguments: { tool_name: 'qq_send_like' }
      },
      {
        type: 'tool/result',
        callId: 'call_schema_1',
        name: 'napcat_get_tool_schema',
        content: '{"type":"object","description":"Very long schema 1 with massive json structure ' + 'x'.repeat(2000) + '"}'
      },
      {
        type: 'message',
        text: '我已经了解点赞工具的参数了'
      },
      {
        type: 'tool/call',
        callId: 'call_schema_2',
        name: 'napcat_get_tool_schema',
        arguments: { tool_name: 'qq_send_poke' }
      },
      {
        type: 'tool/result',
        callId: 'call_schema_2',
        name: 'napcat_get_tool_schema',
        content: '{"type":"object","description":"Very long schema 2 for poke ' + 'y'.repeat(2000) + '"}'
      }
    ]
  }
}, null, 2);

fs.writeFileSync(fakeSessionPath, fakeSessionContent, 'utf8');

// 执行针对该文件的剪枝
const result = pruneSessionSchemaRecords(fakeSessionId, null, fakeSessionPath);
assert.ok(result.pruned, '剪枝应当生效');
assert.equal(result.schemaCountAfter, 1, '剪枝后会话中应且仅应保留 1 个有效 schema 结果');

const afterContent = fs.readFileSync(fakeSessionPath, 'utf8');
// 第一次调用的庞大结果应被清除
assert.ok(!afterContent.includes('Very long schema 1 with massive json structure'), '第 1 次调用的巨大 schema 结果必须已被移除');
assert.ok(afterContent.includes('[previous schema result pruned: single-schema rule enforced]'), '旧 schema 结果已被替换为精简占位');
// 第二次调用应被完整保留
assert.ok(afterContent.includes('Very long schema 2 for poke'), '最新的第 2 次 schema 查询结果应被完整保留');

console.log('PASS: 多次 schema 调用剪枝验证通过，仅保留最新一次，历史旧记录自动剪除！');

// 清理测试临时文件
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
console.log('>>> 全部 Schema 剪枝测试通过！');
