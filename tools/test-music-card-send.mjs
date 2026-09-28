// 音乐卡片「真发」实测：走桥自己的 /api/social/send-rich，和模型调 qq_send_rich 是同一条路。
//
//   node tools/test-music-card-send.mjs --config /root/qq-bridge/config.json \
//        --mid 0004jPDk2eB2dt --title 起风了 --artist 买辣椒也用券
//
//   默认目标是配置里的 ownerQQ（私聊）。--key private:12345 / group:67890 可改。
//   --dry 只建卡不发（不需要令牌，不发任何 QQ 消息）。
//
// ⚠️ 不加 --dry 会**真的发一条 QQ 消息**给目标会话，别拿它试别人。
// 脚本会把 config.json 里的 provider token / NapCat token 留在原地，只读不打印。

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function arg(name, def = '') {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}
const flag = (name) => process.argv.includes(`--${name}`);

const cfgPath = arg('config', process.env.KIZUNA_CONFIG || 'D:\\Kizuna\\resources\\runtime\\qq-bridge\\config.json');
if (!fs.existsSync(cfgPath)) {
  console.error(`找不到 config.json：${cfgPath}\n用法见本文件顶部注释（--config <qq-bridge/config.json>）`);
  process.exit(2);
}
const bridgeDir = path.dirname(cfgPath);
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

const mt = arg('type', 'qq');
const mid = arg('mid');
const title = arg('title', '起风了');
const artist = arg('artist', '买辣椒也用券');
const key = arg('key', `private:${cfg.ownerQQ}`);
if (!mid) { console.error('缺少 --mid（qq_music_search 返回的 id）'); process.exit(2); }

if (flag('dry')) {
  const mediaPath = path.join(bridgeDir, 'src', 'core', 'media.js');
  const { createMediaDomain } = await import(pathToFileURL(mediaPath).href);
  const plan = await createMediaDomain(cfg).buildMusicCard(mt, mid, { title, artist });
  console.log('（--dry：只建卡，不发消息）');
  console.log(JSON.stringify({ style: plan.style, title: plan.title, note: plan.note, primary: plan.primary, link: plan.link }, null, 1));
  process.exit(0);
}

// 令牌：取该会话在 state/social-state.json 里的 agentToken（桥签发给本会话的那个）
const statePath = path.join(bridgeDir, 'state', 'social-state.json');
let token = '';
try {
  const st = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const conv = st.conversations ?? st;
  token = String((conv[key] ?? Object.values(conv).find((v) => v && v.agentToken))?.agentToken ?? '');
} catch (error) {
  console.error(`读不到会话令牌（${statePath}）：${error?.message ?? error}`);
  process.exit(2);
}
if (!token) { console.error(`state 里没有 ${key} 的 agentToken，先让该会话被唤醒过一次`); process.exit(2); }

const base = `http://127.0.0.1:${cfg.consolePort ?? 3100}`;
const body = { key, type: 'music', musicType: mt, musicId: mid, title, content: artist };
console.log(`POST ${base}/api/social/send-rich  key=${key} musicType=${mt} musicId=${mid} title=${title} artist=${artist}`);
const res = await fetch(`${base}/api/social/send-rich`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-agent-token': token },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(90000)
});
const text = await res.text();
console.log(`HTTP ${res.status}`);
try { console.log(JSON.stringify(JSON.parse(text), null, 1)); } catch { console.log(text); }
process.exit(res.ok ? 0 : 1);
