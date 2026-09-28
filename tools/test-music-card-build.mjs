// 音乐卡片「桥侧建卡」实测：搜索 → 解析 → 拼卡（不发任何 QQ 消息）
//
//   node tools/test-music-card-build.mjs [关键词] [运行时目录]
//   node tools/test-music-card-build.mjs 起风了
//   node tools/test-music-card-build.mjs 起风了 D:\Kizuna\resources\runtime
//
// 默认用本机安装里的那份 media.js（与线上跑的代码同源，见 docs/MUSIC-CARD.md §3.4），
// 所以这个脚本验证的是「这台机器能不能把卡片拼出来」，不涉及 NapCat 与签名服务。

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';

const keyword = process.argv[2] || '起风了';
const runtime = process.argv[3] || process.env.KIZUNA_RUNTIME || 'D:\\Kizuna\\resources\\runtime';
const mediaPath = path.join(runtime, 'qq-bridge', 'src', 'core', 'media.js');
if (!fs.existsSync(mediaPath)) {
  console.error(`找不到 media.js：${mediaPath}\n用法：node tools/test-music-card-build.mjs [关键词] [运行时目录]`);
  process.exit(2);
}

const { createMediaDomain } = await import(pathToFileURL(mediaPath).href);

const t0 = Date.now();
const stamp = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const brief = (o, n = 900) => {
  const s = typeof o === 'string' ? o : JSON.stringify(o, null, 1);
  return s.length > n ? s.slice(0, n) + '\n…（截断）' : s;
};

const cfg = { napcat: {}, social: { send: {} } };
const d = createMediaDomain(cfg);

console.log(`[${stamp()}] 用 ${mediaPath}`);
console.log(`[${stamp()}] ① 搜索「${keyword}」（网易云 + QQ 音乐）`);
let res = null;
try {
  res = await d.musicSearch(keyword, 'all', 3);
  for (const r of res.results ?? []) {
    console.log(`   · platform=${r.platform} id=${r.id} title=${r.title} artist=${r.artist}`);
    console.log(`     url=${r.url}`);
    console.log(`     cover=${r.cover}`);
  }
} catch (e) {
  console.log('   搜索失败：', e?.message ?? e);
}

const ne = (res?.results ?? []).find((x) => x.platform === 'netease');
if (ne) {
  console.log(`[${stamp()}] ② 网易云卡片 buildMusicCard('163', ${ne.id})`);
  try {
    const card = await d.buildMusicCard('163', ne.id, {});
    console.log(`   style = ${card.style} | title = ${card.title}`);
    console.log('   note    =', card.note);
    console.log('   primary =', brief(card.primary));
    console.log('   native  =', brief(card.native));
    console.log('   link    =', card.link);
  } catch (e) {
    console.log('   失败：', e?.message ?? e);
  }
} else {
  console.log('② 跳过：搜索结果里没有网易云条目');
}

const qq = (res?.results ?? []).find((x) => x.platform === 'qqmusic');
if (qq) {
  console.log(`[${stamp()}] ③ QQ 音乐卡片 buildMusicCard('qq', ${qq.id}, title=${qq.title})`);
  try {
    const card = await d.buildMusicCard('qq', qq.id, { title: qq.title, content: qq.artist });
    console.log(`   style = ${card.style} | title = ${card.title}`);
    console.log('   note    =', card.note);
    console.log('   primary =', brief(card.primary));
    console.log('   link    =', card.link);
    console.log('   （注意：卡里的 title/singer/封面/落地页若与搜索结果不一致，就是 docs/MUSIC-CARD.md §7 那个缺陷）');
  } catch (e) {
    console.log('   失败：', e?.message ?? e);
  }
} else {
  console.log('③ 跳过：搜索结果里没有 QQ 音乐条目');
}
console.log(`[${stamp()}] 完`);
