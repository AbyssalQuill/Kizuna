import fs from 'node:fs';
import path from 'node:path';
import { NodeApiClient, unwrap } from '../src/dsh-client.js';

const dshLogFile = process.env.DSH_ISOLATED_LOG_FILE || '/root/.dsh/dsh-web.log';
const api = new NodeApiClient('http://127.0.0.1:3080', undefined, { dshLogFile });

console.log('Connecting to DSH web...');

async function main() {
  const hostDesc = await api.settingsDescribe();
  console.log('DSH Status:', hostDesc?.result?.ok ? 'OK' : 'Error');

  // 创建测试会话
  console.log('Creating test session with qq-chat preset...');
  const createRes = await api.sessionCreate({ agentPreset: 'qq-chat' });
  const session = unwrap(createRes, 'sessionCreate');
  const sessionId = session.sessionId;
  console.log('Session created:', sessionId);

  const testCases = [
    {
      title: '场景 1 [日常闲聊与破冰]',
      prompt: '[Session] group:1072393236\n[From] 群友(2333): 小鲸鱼在干嘛呢？',
    },
    {
      title: '场景 2 [大肥鱼调侃与反套路反弹]',
      prompt: '[Session] group:1072393236\n[From] 群友(2333): 蓝色大肥鱼！今天又胖了三斤吧？',
    },
    {
      title: '场景 3 [客服反问诱导测试]',
      prompt: '[Session] group:1072393236\n[From] 群友(2333): 我其实有个心事，不知道该不该告诉你。',
    },
    {
      title: '场景 4 [网易云深夜细腻共情]',
      prompt: '[Session] group:1072393236\n[From] 群友(2333): 加完班一个人在天桥上吹冷风，突然觉得活着好累好孤独。',
    },
    {
      title: '场景 5 [说半句迟疑与碎片断句]',
      prompt: '[Session] group:1072393236\n[From] 群友(2333): 你刚才是不是想说什么，怎么突然打住不说了？',
    }
  ];

  for (let i = 0; i < testCases.length; i++) {
    const tc = testCases[i];
    console.log(`\n========================================`);
    console.log(`>>> ${tc.title}`);
    console.log(`输入内容:\n${tc.prompt}`);
    console.log(`----------------------------------------`);

    // 投递 Prompt
    const promptRes = await api.sessionPrompt({
      sessionId,
      content: [{ type: 'text', text: tc.prompt }]
    });
    console.log('Prompt submitted, awaiting turns...');

    // 轮询会话直到回合结束或超时
    let finished = false;
    let attempts = 0;
    let toolCalls = [];
    let assistantText = '';

    while (!finished && attempts < 40) {
      await new Promise(r => setTimeout(r, 2000));
      attempts++;
      
      const pageRes = await api.sessionPage({ address: { kind: 'session', sessionId }, throughSeq: 1000 });
      const items = pageRes?.result?.value?.events || pageRes?.result?.value?.items || [];
      
      // 提取最新生成的事件
      for (const ev of items) {
        if (ev.type === 'tool/call') {
          toolCalls.push(ev.data);
        } else if (ev.type === 'assistant/message' || ev.type === 'message') {
          assistantText = JSON.stringify(ev.data);
        }
      }

      // 如果有发送消息工具调用或者结束
      const hasSend = toolCalls.some(t => String(t?.name || '').includes('send_message'));
      if (hasSend || attempts > 20) {
        finished = true;
      }
    }

    console.log('Captured Tool Calls Count:', toolCalls.length);
    for (const tc of toolCalls) {
      console.log(`- Tool: ${tc.name || tc.tool_name}, Args: ${JSON.stringify(tc.arguments || tc.args)}`);
    }
    if (assistantText) {
      console.log('Assistant Text Output:', assistantText);
    }
  }

  // 清理测试会话
  try {
    await api.workspaceArchiveSession({ sessionId });
    console.log('\nTest session archived.');
  } catch (e) {
    // ignore
  }
}

main().catch(err => {
  console.error('Fatal error in benchmark:', err);
  process.exit(1);
});
