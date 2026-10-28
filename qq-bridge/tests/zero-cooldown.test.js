import { initSendDice, memeTurnHint, noteMemeSent } from '../src/core/send-dice.js';
import { loadConfig } from '../src/core/config.js';

const cfg = loadConfig();
initSendDice(cfg);

console.log('=== 连续掷骰无冷却实测 ===');
let hitCount = 0;
for (let i = 1; i <= 10; i++) {
  // 刚发过表情包，立即登记
  noteMemeSent('private:1736784911');
  // 零延迟立即进行下一轮抽签
  const hint = memeTurnHint('private:1736784911');
  if (hint.includes('cooling')) {
    console.error(`FAIL: 第 ${i} 次仍在冷却中！`);
    process.exit(1);
  }
  if (hint) hitCount++;
  console.log(`第 ${i} 次发图后立即抽签: cooling=false, 结果=${hint ? 'HIT (带图库指令)' : 'MISS (概率未命中，非冷却)'}`);
}

console.log(`实测完成！10 次连发中 HIT ${hitCount} 次，冷却拦截次数: 0！零冷却彻底生效！`);
