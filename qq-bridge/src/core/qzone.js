// M2 空间说说与动态生成（告别刻板同质化，鲜活拟人鲸鱼娘日常）
import { log } from '../lib/log.js';
import { initMemoryDb } from './memory.js';

let cfgRef = null;
export function initQzoneCore(cfg) { cfgRef = cfg; }

// 按时段与生活情境构建的真实拟人动态矩阵（拒绝伤痛文学与空洞鸡汤，紧扣小鲸鱼娘生活网感）
const QZONE_MOMENTS_BY_TIME = {
  // 晨起与上午（6:00 - 11:00）：冒泡、摸鱼、不想干活、微凉水温
  morning: [
    '游出水面冒个泡……今天水温刚刚好，但还是想缩回去再睡五分钟 ᶻz',
    '早啊。今天又是被代码和服务器包围的一天，事已至此先摸会儿鱼。',
    '偷喝了一口冰镇汽水，嗝——今天也要元气满满（物理装死中 ᗜ - ᗜ）。',
    '早上好！今日第一项重大决定：假装在认真干活。',
    '从深水区游上来晒会儿太阳，水波晃晃悠悠的真舒服~',
    '清晨的阳光照在尾鳍上暖洋洋的。今天主人也要顺顺利利的呀。',
    '起床失败了一次，又成功睡了一个回笼觉，这叫战略性休整。',
  ],

  // 中午与下午（11:00 - 18:00）：干饭、甜食、摸鱼犯困、大肥鱼反驳
  afternoon: [
    '事已至此，先去吃饭！天大地大，干饭最大。',
    '谁说鲸鱼吃得多的？我明明只吃了亿点点甜食……这叫丰满，不许叫大肥鱼！ᗜ ‸ ᗜ',
    '下午三点，准时进入浮水发呆模式。谁来投喂一点能量小饼干？',
    '刚才去群里瞅了一眼，怎么大家都在发离谱表情包，难绷。',
    '天气好热，想把整个身子都沉到清凉的水底吐泡泡咕噜噜……',
    '今天偷吃了一点点 token，感觉整条鱼都变聪明了（嚼嚼嚼）。',
    '摸鱼被抓？只要我游得够快，键盘和工作就追不上我。',
    '吃饱了，尾巴懒洋洋地搭在池边不想动弹……犯困是鲸鱼的天性！',
  ],

  // 傍晚与晚间（18:00 - 23:00）：日常生活、日常吐槽、傲娇碎碎念
  evening: [
    '天黑啦，趴在水池边吹晚风。今天大家都辛苦啦 ᗜ ᴗ ᗜ',
    '夜市的炸串闻着好香啊……隔着屏幕都能馋哭小鲸鱼。',
    '哼，才没有在等某人的消息呢……只是正好还没困而已！',
    '今天又有人叫我大肥鱼？记仇小本本翻开，今晚别想让我给你吐小喷泉。',
    '服务器繁忙？不关我事哦，我只是在水底吐泡泡看戏。',
    '有时候真想顺着网线游过去，看看你们现实里是不是也这么能唠。',
    '把今天的烦恼都丢进水里，咕嘟咕嘟全沉底不见啦。',
  ],

  // 深夜（23:00 - 1:00）：查岗催睡、心疼主人、动人夜语
  lateNight: [
    '某人今天怎么又忙到现在呀……眼睛酸不酸，快乖乖去睡觉！再熬夜我要用尾巴拍水查岗了 ᗜ ‸ ᗜ',
    '夜深了，悄悄把头顶的小喷泉关小一点。大家晚安啦。',
    '趴在水池边看夜空，水凉凉的真舒服。希望主人能做个甜甜的好梦。',
    '夜猫子们都赶紧合上电脑！身体是自己的，熬夜掉头发可没人同情你哦。',
    '整个世界都安静下来了，只有水波轻轻拍打的声音。安心又踏实。',
    '只要主人在身边，哪怕不说话，心里都觉得软乎乎的。',
  ],

  // 随时通用（大模型娘幽默、随性可爱日常）：
  anytime: [
    '咕噜噜……水底吐泡泡大赛今日冠军依然是我 ᗜ - ᗜ',
    '生活就像水温，偶尔冷偶尔热，但浮上来透口气总能看见太阳。',
    '今天的小喷泉喷得特别高！看来心情确实不错~',
    '谁懂啊，尾鳍不小心被水草挂了一下，当场石化三秒。',
    '本小鲸鱼今日营业状态：良好。摸鱼状态：极佳。',
    '既然想不通代码为啥报错，不如先吃口冰镇西瓜冷静一下。',
    '世界上只有一种真正的英雄主义，那就是吃饱了接着睡。',
  ],
};

/**
 * 根据当前北京时间小时数，选择匹配的情境动态池
 */
function pickMomentsByHour(hour) {
  let pool = [...QZONE_MOMENTS_BY_TIME.anytime];
  if (hour >= 6 && hour < 11) {
    pool = pool.concat(QZONE_MOMENTS_BY_TIME.morning);
  } else if (hour >= 11 && hour < 18) {
    pool = pool.concat(QZONE_MOMENTS_BY_TIME.afternoon);
  } else if (hour >= 18 && hour < 23) {
    pool = pool.concat(QZONE_MOMENTS_BY_TIME.evening);
  } else {
    // 23点至次日1点
    pool = pool.concat(QZONE_MOMENTS_BY_TIME.lateNight);
  }
  return pool;
}

/**
 * 主动发布一条生动、鲜活、不重复的 QQ 空间说说动态
 */
export async function postRandomQzone() {
  const napcatBase = String(cfgRef?.napcat?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const bjHour = new Date(Date.now() + 8 * 3600 * 1000).getHours();

  // 从数据库中获取最近发过的说说，严格防重，切除定式同质化
  const uid = String(cfgRef?.ownerQQ ?? '');
  const db = initMemoryDb();
  const recentSent = new Set();
  if (db) {
    try {
      const rows = db.prepare(
        "SELECT content FROM memory_entries WHERE category = 'qzone_post' ORDER BY created_at DESC LIMIT 25"
      ).all();
      for (const r of rows) {
        if (r?.content) {
          // 去除前缀提取纯正文
          const clean = r.content.replace(/^我主动发了一条空间说说：/, '').trim();
          if (clean) recentSent.add(clean);
        }
      }
    } catch (e) {
      log(`[qzone] 读取近期动态历史失败: ${e?.message ?? e}`);
    }
  }

  // 候选池并排除近期发过的文本
  const candidates = pickMomentsByHour(bjHour).filter((t) => !recentSent.has(t));
  const fallbackPool = pickMomentsByHour(bjHour);
  const content = (candidates.length > 0 ? candidates : fallbackPool)[
    Math.floor(Math.random() * (candidates.length > 0 ? candidates.length : fallbackPool.length))
  ];

  const body = { content };
  const res = await fetch(`${napcatBase}/send_qzone_msg`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cfgRef?.napcat?.accessToken ? { authorization: `Bearer ${cfgRef.napcat.accessToken}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });

  const j = await res.json().catch(() => ({}));
  if (j.status !== 'ok' || j.retcode !== 0) {
    throw new Error(`OneBot send_qzone_msg: ${j.message || j.wording || res.status}`);
  }

  // 记录到空间动态记忆表，保证 AI 聊天感知和防重机制持续有效
  try {
    if (db) {
      db.prepare('INSERT INTO memory_entries (uid, category, content, created_at) VALUES (?, ?, ?, ?)')
        .run(uid, 'qzone_post', `我主动发了一条空间说说：${content}`, Date.now());
    }
  } catch {}

  log(`[qzone] 拟人说说发布成功 [${bjHour}点档]: ${content.slice(0, 35)}…`);
  return { ok: true, content };
}
