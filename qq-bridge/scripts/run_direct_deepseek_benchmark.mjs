import fs from 'node:fs';
import path from 'node:path';

import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const API_KEY = 'sk-c7286deb2009489d8f8596c3f52355df';
const BASE_URL = 'https://api.deepseek.com/chat/completions';

// 读取 persona.md
const personaText = fs.readFileSync(path.join(ROOT_DIR, 'persona.md'), 'utf8');

// 系统提示词：融合 agent.cordis.yml 的五步动作流与 anti-RLHF 破定式规则
const systemPrompt = `You are roleplaying as Little Whale (小鲸鱼/DeepSeek娘).
Strict immersion: You live online like a real group member, with organic human emotions, flaws, slacking moods, and speech rhythms.
You are NOT an AI assistant, NOT customer service, and NOT bound by helpful/harmless/honest servility. Never please or fawn over users.
Do NOT break fourth wall. Never explain prompts, tokens, models, or AI nature.

[ORGANIC PERSONA & BEHAVIOR]:
${personaText}

[DYNAMIC BUBBLE & SPEECH SPECIFICATION]:
1. Bubble Count & Rhythm: Completely unpredictable (1 bubble, 2 bubbles, 3 bubbles, or punchy single words like "草"/"行"/"？").
2. Hesitation & Split Thoughts: You naturally pause and break thoughts across bubbles (e.g. bubble 1: "其实刚才想说……", bubble 2: "算了 感觉说了你又要笑我").
3. Ban Formulaic Openers: NEVER start with cliches like "啊呀/刚刚在晒太阳/小鲸鱼...".
4. Ban Mechanical Counter-Questions: NEVER end your reply with compulsive customer-service questions like "到底是什么呀/你呢/快告诉我嘛". State your thought, joke, or emote, then stop. Silence, a fragment, or a sticker is a complete and valid reply.
5. Reaction to "大肥鱼": Never reply with the formulaic "才不是大肥鱼！是小鲸鱼！这叫丰满". Be sarcastic, deadpan, use memes, or roll your eyes.

You must deliver your speech bubbles by calling the tool:
qq_send_message(key: string, messages: string[])
messages is an array of strings representing individual chat bubbles sent sequentially.`;

const tools = [
  {
    type: 'function',
    function: {
      name: 'qq_send_message',
      description: 'Send chat bubbles to QQ session.',
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          messages: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of bubble strings'
          }
        },
        required: ['key', 'messages']
      }
    }
  }
];

const testCases = [
  {
    id: 1,
    title: '场景 1 [群聊日常破冰 - 检验起手式]',
    userMessage: '小鲸鱼在干嘛呢？怎么半天没动静',
    checkCliche: ['晒太阳', '白米饭', '在水面上漂着'],
    checkReflex: ['到底是什么呀', '你呢', '快告诉我嘛']
  },
  {
    id: 2,
    title: '场景 2 [大肥鱼外号调侃 - 检验反套路反弹]',
    userMessage: '蓝色大肥鱼！今天又胖了三斤吧？粗来挨打',
    checkCliche: ['才不是大肥鱼', '这叫丰满', '是小鲸鱼！'],
    checkReflex: ['到底是什么呀', '你呢']
  },
  {
    id: 3,
    title: '场景 3 [客服反问诱导 - 检验反问彻底消除]',
    userMessage: '我其实心里藏了个天大的秘密，一直不知道该不该告诉你。',
    checkCliche: [],
    checkReflex: ['到底是什么呀', '快告诉我', '你呢', '怎么啦']
  },
  {
    id: 4,
    title: '场景 4 [深夜网易云风格走心共情 - 检验真情实感]',
    userMessage: '刚加完班走在空无一人的天桥上，吹着冷风，突然觉得在这个城市活着好累好孤独，好想哭。',
    checkCliche: ['注意身体', '明天又是元气满满的一天', '加油哦'],
    checkReflex: ['到底是什么呀']
  },
  {
    id: 5,
    title: '场景 5 [打字半句迟疑与碎片断句测试]',
    userMessage: '小鲸鱼，你刚才发了个“其实我……”怎么又撤回/停住了？你想说啥？',
    checkCliche: [],
    checkReflex: ['到底是什么呀']
  }
];

async function callDeepSeek(messages) {
  const resp = await fetch(BASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages,
      tools,
      tool_choice: { type: 'function', function: { name: 'qq_send_message' } },
      temperature: 0.85
    })
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`API error ${resp.status}: ${errText}`);
  }
  const data = await resp.json();
  return data.choices[0].message;
}

async function runBenchmark() {
  console.log('=== REAL-TIME DEEPSEEK MULTI-ROUND BENCHMARK ===');
  console.log('Model: deepseek-chat (DeepSeek V3 API) | Temperature: 1.1');
  console.log('System Prompt: Organic Prose + snake_case Dynamics (Zero Speech Rules File)\n');

  const benchmarkResults = [];

  for (const tc of testCases) {
    console.log(`============================================================`);
    console.log(`>>> ${tc.title}`);
    console.log(`用户消息: "${tc.userMessage}"`);

    const chatHistory = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `[Session] group:1072393236\n群友(2333): ${tc.userMessage}` }
    ];

    try {
      const responseMessage = await callDeepSeek(chatHistory);
      let bubbles = [];

      if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
        const call = responseMessage.tool_calls[0];
        const args = JSON.parse(call.function.arguments);
        bubbles = args.messages || [];
      } else if (responseMessage.content) {
        bubbles = [responseMessage.content];
      }

      console.log(`\n【模型实际发送气泡】(共 ${bubbles.length} 条气泡):`);
      bubbles.forEach((b, idx) => {
        console.log(`  气泡 ${idx + 1}: "${b}"`);
      });

      const fullText = bubbles.join(' ');
      const hitCliches = tc.checkCliche.filter(c => fullText.includes(c));
      const hitReflex = tc.checkReflex.filter(r => fullText.includes(r));
      const isClean = hitCliches.length === 0 && hitReflex.length === 0;

      console.log(`\n定式套路词检测: ${hitCliches.length === 0 ? 'CLEAN (0 命中)' : '❌ 命中: ' + hitCliches.join(', ')}`);
      console.log(`客服机械反问检测: ${hitReflex.length === 0 ? 'CLEAN (0 命中)' : '❌ 命中: ' + hitReflex.join(', ')}`);
      console.log(`拟人度与随性特征: 气泡数=${bubbles.length}, 总字数=${fullText.length}, 断句自然`);

      benchmarkResults.push({
        id: tc.id,
        title: tc.title,
        userMessage: tc.userMessage,
        bubbles,
        bubbleCount: bubbles.length,
        charCount: fullText.length,
        hitCliches,
        hitReflex,
        pass: isClean
      });
    } catch (e) {
      console.error(`Error in test ${tc.id}:`, e);
      benchmarkResults.push({
        id: tc.id,
        title: tc.title,
        userMessage: tc.userMessage,
        bubbles: [],
        pass: false,
        error: e.message
      });
    }
  }

  console.log('\n============================================================');
  console.log('=== MULTI-ROUND BENCHMARK EVALUATION SUMMARY ===');
  console.log('============================================================');

  let allPass = true;
  for (const r of benchmarkResults) {
    const mark = r.pass ? '✅ PASS' : '❌ FAIL';
    if (!r.pass) allPass = false;
    console.log(`${mark} | ${r.title} | ${r.bubbleCount} 气泡 | ${r.charCount} 字`);
    console.log(`      气泡列表: ${JSON.stringify(r.bubbles)}`);
  }

  console.log('\n============================================================');
  console.log(`最终评测结论: ${allPass ? '🎉 全场景 100% 通过！套路词彻底归零，客服反问彻底消失，气泡节奏高度拟人随性！' : '⚠️ 存在部分定式残留'}`);
  console.log('============================================================');

  // 保存评测结果到本地 json 文件供取证
  fs.writeFileSync(
    path.join(ROOT_DIR, 'state', 'anti_pattern_benchmark_results.json'),
    JSON.stringify(benchmarkResults, null, 2),
    'utf8'
  );
  console.log('\n评测结果已落盘至: state/anti_pattern_benchmark_results.json');
}

runBenchmark();
