// 音乐卡片「签名服务」实测：把卡片数据 POST 给 NapCat 会用的那两个签名地址，看哪个通。
//
//   node tools/test-music-sign.mjs              # 用内置样例卡片（网易云 163）
//   node tools/test-music-sign.mjs payload.json # 用自定义卡片数据
//
// 这一步就是 NapCat 发音乐卡前做的最后一件事（见 docs/MUSIC-CARD.md §1、§3.2）。
// 两个地址都不通 → 卡片一定会发不出去（NapCat 日志里是 `[音乐卡片签名失败]`）。

import fs from 'node:fs';

const SAMPLE = {
  type: '163',
  url: 'https://y.music.163.com/m/song?id=1330348068',
  title: '起风了',
  image: 'https://p2.music.126.net/diGAyEmpymX8G7JcnElncQ%3D%3D/109951163699673355.jpg?imageView=1&thumbnail=300x300&type=jpg',
  singer: '冯沁苑(买辣椒也用券)'
};

// 与 NapCat 内置的两个地址一致（napcat.mjs:73430 首选、:73437 备选）
const ADDRESSES = [
  ['首选（NapCat 默认）', 'http://106.55.0.102:10087/'],
  ['备选（ss.xingzhige.com）', 'https://ss.xingzhige.com/music_card/card']
];

const argFile = process.argv[2];
let payload = SAMPLE;
if (argFile) {
  try {
    payload = JSON.parse(fs.readFileSync(argFile, 'utf8'));
  } catch (e) {
    console.error(`读不了 ${argFile}：${e.message}`);
    process.exit(2);
  }
}

console.log('卡片数据：' + JSON.stringify(payload));
let okCount = 0;

for (const [label, url] of ADDRESSES) {
  const t0 = Date.now();
  let status = 0;
  let body = '';
  let err = '';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(40000)
    });
    status = res.status;
    body = await res.text();
  } catch (e) {
    err = e?.name === 'TimeoutError' ? '超时（40s）' : (e?.cause?.code || e?.message || String(e));
  }
  const ms = Date.now() - t0;
  // 签名成功的返回体是被 JSON 编码过一次的字符串，里面一定有 tencent.tuwen / app 字样
  const signed = status === 200 && /tencent\.tuwen|"app"|preview/.test(body);
  if (signed) okCount += 1;
  console.log('');
  console.log(`── ${label}`);
  console.log(`   ${url}`);
  console.log(`   HTTP ${status || '(无)'}   耗时 ${ms}ms   ${signed ? '签名成功' : '未拿到签名'}${err ? '   错误：' + err : ''}`);
  if (body) console.log('   返回：' + body.replace(/\s+/g, ' ').slice(0, 220));
}

console.log('');
if (okCount === 0) {
  console.log('结论：两个地址都不通 —— 这台机器发出的音乐卡片会失败，NapCat 日志里应能看到 `[音乐卡片签名失败]`。');
  console.log('      处置：在 NapCat 配置的 musicSignUrl 里填一个本机能连通的签名服务地址。');
  process.exit(1);
}
console.log(`结论：${okCount}/2 个地址可用 —— 签名这一环没问题，卡片发不出去要往别处查（见 docs/MUSIC-CARD.md §5）。`);
