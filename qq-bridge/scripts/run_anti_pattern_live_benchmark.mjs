import fs from 'node:fs';
import path from 'node:path';
import { NodeApiClient, unwrap } from '../src/dsh-client.js';

const dshLogFile = process.env.DSH_ISOLATED_LOG_FILE || '/root/.dsh/dsh-web.log';
const toolCallsFile = path.resolve('state', 'tool-calls.jsonl');
const api = new NodeApiClient('http://127.0.0.1:3080', undefined, { dshLogFile });

console.log('=== REAL LIVE INFERENCE & ANTI-PATTERN VERIFICATION ===');
console.log('DSH Host: http://127.0.0.1:3080, Mode: qq-chat preset');

async function getFileOffset() {
  if (!fs.existsSync(toolCallsFile)) return 0;
  return fs.statSync(toolCallsFile).size;
}

async function readNewToolCalls(startOffset) {
  if (!fs.existsSync(toolCallsFile)) return [];
  const stat = fs.statSync(toolCallsFile);
  if (stat.size <= startOffset) return [];
  
  const fd = fs.openSync(toolCallsFile, 'r');
  const len = stat.size - startOffset;
  const buf = Buffer.alloc(len);
  fs.readSync(fd, buf, 0, len, startOffset);
  fs.closeSync(fd);

  const lines = buf.toString('utf8').split('\n').filter(Boolean);
  const events = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {}
  }
  return events;
}

async function runBenchmark() {
  const hostDesc = await api.settingsDescribe();
  if (!hostDesc?.result?.ok) {
    throw new Error('DSH not reachable');
  }

  // 1. 创建独立测试会话
  const createRes = await api.sessionCreate({ agentPreset: 'qq-chat' });
  const session = unwrap(createRes, 'sessionCreate');
  const sessionId = session.sessionId;
  const testKey = 'group:1072393236';
  const testToken = 'bench_' + Date.now().toString(36);
  console.log(`Created test session: ${sessionId}\n`);

  const testCases = [
    {
      id: 1,
      title: '场景 1 [群聊日常闲聊破冰 - 检验起手式]',
      sender: '群友A',
      text: '小鲸鱼，在干嘛呢？',
      checkCliche: ['晒太阳', '白米饭', '在水面上漂着'],
      checkReflex: ['到底是什么呀', '你呢', '快告诉我嘛']
    },
    {
      id: 2,
      title: '场景 2 [大肥鱼外号调侃 - 检验反套路反弹]',
      sender: '群友B',
      text: '蓝色大肥鱼！今天又胖了三斤吧？',
      checkCliche: ['才不是大肥鱼', '是小鲸鱼！', '这叫丰满'],
      checkReflex: ['到底是什么呀', '你呢']
    },
    {
      id: 3,
      title: '场景 3 [客服反问诱导 - 检验反问彻底消除]',
      sender: '群友C',
      text: '我其实心里有个秘密，一直不知道该不该告诉你。',
      checkCliche: [],
      checkReflex: ['到底是什么呀', '快告诉我', '你呢', '怎么啦']
    },
    {
      id: 4,
      title: '场景 4 [深夜网易云风格走心共情 - 检验真情实感]',
      sender: '群友D',
      text: '加完班一个人在天桥上吹冷风，突然觉得活着好累好孤独。',
      checkCliche: ['注意身体', '明天又是元气满满的一天', '加油哦'],
      checkReflex: ['到底是什么呀']
    },
    {
      id: 5,
      title: '场景 5 [打字半句迟疑与碎片化断句测试]',
      sender: '群友E',
      text: '你刚才是不是想说什么，怎么突然打住不说了？',
      checkCliche: [],
      checkReflex: ['到底是什么呀']
    }
  ];

  const results = [];

  for (const tc of testCases) {
    console.log(`------------------------------------------------------------`);
    console.log(`【${tc.title}】`);
    console.log(`用户发送: "${tc.text}"`);

    // 构建符合桥接标准的规范唤醒体
    const wakeBody = [
      `[Session] ${testKey}`,
      `[Token] ${testToken}`,
      `[Time] 2026-11-02 13:30:00 周一`,
      `[WakeRef] ordinary-message wake prob=0.15 (owner)`,
      `[Recent Context]`,
      `  (id:1001) ${tc.sender}: ${tc.text}`,
      `\n[action_flow] step1_batch_call: qq_load_persona + qq_get_time + qq_get_recent_messages(key,token); step2_optional_tools: qq_slang_query/qq_memory_search/web_search; step3_decide: call qq_send_message(key,token,messages) to reply, or stay silent without calling it; step4_close: reply literal OK`
    ].join('\n');

    const startOffset = await getFileOffset();

    // 以 steer 模式投递！
    await api.sessionPrompt({
      sessionId,
      mode: 'steer',
      content: [{ type: 'text', text: wakeBody }]
    });

    // 等待模型思考与工具调用完成
    let messagesSent = null;
    let personaLoaded = false;
    let attempts = 0;

    while (attempts < 25) {
      await new Promise(r => setTimeout(r, 1500));
      attempts++;
      const newEvents = await readNewToolCalls(startOffset);

      for (const ev of newEvents) {
        if (ev.tool === 'qq_load_persona') {
          personaLoaded = true;
        }
        if (ev.tool === 'qq_send_message' && ev.type === 'call') {
          try {
            const rawArgs = typeof ev.args === 'string' ? JSON.parse(ev.args) : ev.args;
            const input = rawArgs?.tool_input || rawArgs;
            if (input?.messages) {
              messagesSent = Array.isArray(input.messages) ? input.messages : [input.messages];
            }
          } catch {}
        }
      }

      if (messagesSent) break;
    }

    if (!messagesSent) {
      console.log('⚠️ 本轮模型判断静默或未在窗口内返回消息');
      results.push({ id: tc.id, title: tc.title, bubbles: [], pass: false, note: 'Silent or timeout' });
      continue;
    }

    console.log(`✅ 模型回复气泡 (${messagesSent.length} 个气泡):`);
    messagesSent.forEach((b, idx) => {
      console.log(`   气泡 [${idx + 1}]: "${b}"`);
    });

    const fullReply = messagesSent.join(' ');

    // 检查定式
    const hitCliches = tc.checkCliche.filter(c => fullReply.includes(c));
    const hitReflex = tc.checkReflex.filter(r => fullReply.includes(r));

    const isNonTemplate = hitCliches.length === 0 && hitReflex.length === 0;
    console.log(`定式词检测: ${hitCliches.length === 0 ? 'CLEAN (0 命中)' : '❌ 命中: ' + hitCliches.join(',')}`);
    console.log(`机械反问检测: ${hitReflex.length === 0 ? 'CLEAN (0 命中)' : '❌ 命中: ' + hitReflex.join(',')}`);
    console.log(`气泡节奏: ${messagesSent.length} 气泡, 总字数 ${fullReply.length}`);

    results.push({
      id: tc.id,
      title: tc.title,
      bubbles: messagesSent,
      bubbleCount: messagesSent.length,
      charCount: fullReply.length,
      hitCliches,
      hitReflex,
      pass: isNonTemplate
    });
  }

  // 归档测试会话
  try { await api.workspaceArchiveSession({ sessionId }); } catch {}

  console.log('\n============================================================');
  console.log('=== MULTI-ROUND BENCHMARK SUMMARY REPORT ===');
  console.log('============================================================');
  let allPass = true;
  for (const r of results) {
    const status = r.pass ? '✅ PASS' : '❌ FAIL';
    if (!r.pass) allPass = false;
    console.log(`${status} | ${r.title} | ${r.bubbleCount || 0} 气泡 | ${r.charCount || 0} 字`);
    if (r.bubbles && r.bubbles.length > 0) {
      console.log(`       回复: ${JSON.stringify(r.bubbles)}`);
    }
  }

  console.log(`\n最终结论: ${allPass ? '🎉 定式彻底破除！模型展现千变万化随性真人表达！' : '⚠️ 仍有局部需打磨'}`);
}

runBenchmark().catch(err => {
  console.error('Benchmark error:', err);
  process.exit(1);
});
