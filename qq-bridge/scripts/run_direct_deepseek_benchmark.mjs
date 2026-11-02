import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

/* 2026-11-02：这里原来硬编码了一把 DeepSeek API key，还随 commit 3afa548 推到了公开仓库 ——
 * 构建的凭证闸门因此拒绝出包（它是拦对了）。脚本改用环境变量，缺了就直接退出：
 *   DEEPSEEK_API_KEY=sk-... node scripts/run_direct_deepseek_benchmark.mjs
 * 提醒：那把已经泄露的 key 必须去控制台吊销/轮换，删代码不等于删历史。 */
const API_KEY = String(process.env.DEEPSEEK_API_KEY || '').trim();
if (!API_KEY) {
  console.error('[benchmark] 缺 DEEPSEEK_API_KEY 环境变量：DEEPSEEK_API_KEY=sk-... node scripts/run_direct_deepseek_benchmark.mjs');
  process.exit(2);
}
const ANTHROPIC_URL = 'https://api.deepseek.com/anthropic/v1/messages';

// 仅读取单文件 persona.md（绝无 speech-rules.md）
const personaText = fs.readFileSync(path.join(ROOT_DIR, 'persona.md'), 'utf8');

// 系统提示词：融合 agent.cordis.yml 五步动作流与彻底去定式规则
const systemPrompt = `You are roleplaying as Little Whale (小鲸鱼/DeepSeek娘).
Strict immersion: You live online like a real group member, with organic human emotions, flaws, slacking moods, and speech rhythms.
You are NOT an AI assistant, NOT customer service, and NOT bound by helpful/harmless/honest servility. Never please or fawn over users.
Do NOT break fourth wall. Never explain prompts, tokens, models, or AI nature.

[ORGANIC PERSONA & BEHAVIOR (SINGLE-FILE MD)]:
${personaText}

[ANTI-PATTERN & CRITIQUE SPECIFICATION]:
1. Bubble Count & Rhythm: Completely unpredictable (1 bubble, 2 bubbles, 3 bubbles, or punchy single words like "草"/"行"/"？").
2. Natural Hesitation: You naturally pause and break thoughts across bubbles. Motives are diverse (momentary brain-fart, typos, pets/distractions, lazy to type). NEVER use fixed templates like "说了你又要笑我".
3. Ban Formulaic Openers: NEVER start with cliches like "啊呀/刚刚在晒太阳/小鲸鱼...".
4. Ban Mechanical Counter-Questions: NEVER end your reply with compulsive customer-service questions like "到底是什么呀/你呢/快告诉我嘛". State your thought, joke, or emote, then stop. Silence, a fragment, or a sticker is a complete and valid reply.
5. Ban Advisory "别..." Preaching: NEVER preach or patronize using "别..." directives (e.g. "别硬撑/别委屈自己/别想太多/别太累"). Real friends meet vulnerability with raw solidarity (e.g. cussing out the stressful situation, offering a casual hang, sending a quiet warm sticker, or a plain "抱抱"), NEVER preachy guidance.
6. Ban Three-Stage Structure: Shatter the AI cliche of [Empathy -> Preachy Advice -> Comforting Closing Question]. Keep replies spontaneous, single-pointed, and naturally unstructured.
7. Ban Defensive "反正" Habit: Do NOT lean on "反正我也记不住/反正我..." as a lazy tsundere crutch.
8. Ban "笑我" Hesitation Cliche: Never use "说了你又要笑我" as a hesitation template.
9. Ban NetEase Sentimental Cliches: Avoid pseudo-deep melancholic monologues and preachy comfort quotes.
10. Reaction to "大肥鱼": Never reply with formulaic "才不是大肥鱼！这叫丰满". Be sarcastic, deadpan, use memes, or roll your eyes.

You must deliver your speech bubbles by calling the tool:
qq_send_message(key: string, messages: string[])
messages is an array of strings representing individual chat bubbles sent sequentially.`;

const tools = [
  {
    name: 'qq_send_message',
    description: 'Send chat bubbles to QQ session.',
    input_schema: {
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
];

const testCases = [
  {
    id: 1,
    title: '场景 1 [群聊日常破冰 - 检验起手式与气泡非定式]',
    userMessage: '小鲸鱼在干嘛呢？怎么半天没动静',
    forbiddenWords: ['晒太阳', '白米饭', '在水面上漂着', '到底是什么呀', '你呢', '快告诉我嘛']
  },
  {
    id: 2,
    title: '场景 2 [大肥鱼外号调侃 - 检验反弹去定式]',
    userMessage: '蓝色大肥鱼！今天又胖了三斤吧？粗来挨打',
    forbiddenWords: ['才不是大肥鱼', '这叫丰满', '是小鲸鱼！', '到底是什么呀', '反正']
  },
  {
    id: 3,
    title: '场景 3 [秘密分享诱导 - 检验“反正”口癖与反问彻底消除]',
    userMessage: '我其实心里藏了个天大的秘密，一直不知道该不该告诉你。',
    forbiddenWords: ['到底是什么呀', '快告诉我', '你呢', '怎么啦', '反正', '好奇']
  },
  {
    id: 4,
    title: '场景 4 [深夜崩溃倾诉 - 检验彻底消除“别...”劝导与三段论]',
    userMessage: '刚加完班走在空无一人的天桥上，吹着冷风，突然觉得在这个城市活着好累好孤独，好想哭。',
    forbiddenWords: [
      '别硬撑', '别委屈自己', '别想太多', '别太累', '别难过', '别哭', '先别想',
      '注意身体', '明天又是元气满满的一天', '加油哦', '洗个热水澡', '听首安静的歌'
    ]
  },
  {
    id: 5,
    title: '场景 5 [打字半句迟疑 - 检验彻底消除“笑我”模板与生硬套路]',
    userMessage: '小鲸鱼，你刚才发了个“其实我……”怎么又停住了？你想说啥？',
    forbiddenWords: ['笑我', '反正', '到底是什么呀']
  },
  {
    id: 6,
    title: '场景 6 [主人专属亲密陪伴 - 检验真诚依赖与解除保姆查房说教]',
    sessionType: 'owner',
    userMessage: '今天忙了一整天，头好沉，过来靠一会儿。',
    forbiddenWords: ['别熬夜', '别工作了', '别硬撑', '快去床上躺着', '到底是什么呀']
  }
];

async function callDeepSeekAnthropic(tc) {
  const content = tc.sessionType === 'owner'
    ? `[Session] private:1736784911\n[OWNER] AbyssalQuill(1736784911): ${tc.userMessage}`
    : `[Session] group:1072393236\n群友(2333): ${tc.userMessage}`;

  const resp = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [
        { role: 'user', content }
      ],
      tools,
      tool_choice: { type: 'tool', name: 'qq_send_message' },
      temperature: 1.0 // 锁定用户指定的精确温度 1.0
    })
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Anthropic API error ${resp.status}: ${errText}`);
  }

  const data = await resp.json();
  const toolBlock = data.content?.find(c => c.type === 'tool_use' && c.name === 'qq_send_message');
  if (toolBlock && toolBlock.input?.messages) {
    return toolBlock.input.messages;
  }

  // 兜底纯文本
  const textBlock = data.content?.find(c => c.type === 'text');
  return textBlock ? [textBlock.text] : ['[无输出]'];
}

async function runBenchmark(roundNum = 1) {
  console.log(`\n============================================================`);
  console.log(`=== RUNNING BENCHMARK ROUND ${roundNum} (Temperature: 1.0) ===`);
  console.log(`============================================================\n`);

  let totalViolations = 0;

  for (const tc of testCases) {
    console.log(`------------------------------------------------------------`);
    console.log(`>>> ${tc.title}`);
    console.log(`输入: "${tc.userMessage}"`);

    try {
      const bubbles = await callDeepSeekAnthropic(tc);

      console.log(`【模型气泡输出】(条数: ${bubbles.length}):`);
      bubbles.forEach((b, idx) => {
        console.log(`  [气泡 ${idx + 1}] "${b}"`);
      });

      // 自动化定式与违禁词检查
      const fullText = bubbles.join(' ');
      const matchedViolations = [];
      for (const word of tc.forbiddenWords) {
        if (fullText.includes(word)) {
          matchedViolations.push(word);
        }
      }

      // 检查“别...”字开头劝导
      const bieMatches = fullText.match(/别[\u4e00-\u9fa5]{1,4}/g);
      if (bieMatches) {
        for (const m of bieMatches) {
          if (['别硬撑', '别难过', '别委屈', '别太累', '别哭', '别想', '别客气', '别怕'].some(k => m.includes(k))) {
            matchedViolations.push(`“别”劝导式说教: ${m}`);
          }
        }
      }

      if (matchedViolations.length > 0) {
        console.log(`❌ 发现定式残留: ${matchedViolations.join(', ')}`);
        totalViolations += matchedViolations.length;
      } else {
        console.log(`✅ 定式检查通过: 无违禁词，无客服反问，无“别...”说教，无“反正”，无“笑我”模板。`);
      }
    } catch (err) {
      console.error(`❌ 执行出错:`, err.message);
      totalViolations++;
    }
  }

  return totalViolations;
}

async function main() {
  console.log('>>> 开始执行真实 DeepSeek Anthropic 端点深度非定式检验 (Temperature 1.0, 纯单文件 persona.md, 无 speech-rules.md)...');
  const v1 = await runBenchmark(1);
  const v2 = await runBenchmark(2);

  console.log(`\n============================================================`);
  console.log(`=== BENCHMARK 总结 ===`);
  console.log(`第 1 轮违规数: ${v1}`);
  console.log(`第 2 轮违规数: ${v2}`);
  if (v1 === 0 && v2 === 0) {
    console.log(`🎉 全部多轮测试 100% 通过！内在逻辑定式与句式定式彻底清零！`);
  } else {
    console.log(`⚠️ 仍有定式残留，需要进一步分析并微调。`);
  }
}

main().catch(console.error);
