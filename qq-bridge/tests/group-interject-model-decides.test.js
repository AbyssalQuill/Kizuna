/* ── 群聊插话：不再写死概率/阈值，一律交给模型判断（2026-09-30）────────────────────────
 *
 * 需求原话（主人）：「修复群聊**插话概率**的问题，**别写死让模型自己判断**，然后…发言这一块
 * 也**不要死板地发 3 段**…我感觉**人机味太重**，修复」。
 *
 * 本测试钉死的三件事（都必须在"概率怎么配"下都成立）：
 *   ① 群聊普通消息**不再掷骰子**：不管 probability 配成 0.05 / 0.15 / 0.3 / 1，也不管配置里
 *      根本没有这个键，消息都必须走到"交给模型判断"这一步 —— 判据是把 Math.random 钉成
 *      恒定 0.999999（任何 `Math.random() < p` 的骰子都必然输）后，唤醒理由仍必须产生；
 *   ② 主动冒泡（proactiveCheck）同样去概率化：同样的恒定随机数下必须仍然把这一步交给模型，
 *      只剩"关闭开关（0）/ 没话题 / 不冷场 / 会话忙"这些结构性前提可以拦住它；
 *   ③ 老配置兼容：配置里**缺** recommendedProbability 这个键时，绝不能把它当成显式 0
 *      （那会变成"永久静默"，是这次改造最容易踩的坑），也不能把会话的 probability 同步成 0。
 *
 * 顺带钉住"不死板发 3 段"：代码里没有任何把一次回复切成固定 3 段的逻辑 ——
 * 条数完全由模型给（qq_send_message 的数组长度），代码只做「单条超长就按长度硬拆」的安全拆分，
 * 以及 burstMaxMessages 这个可配置的安全上限（不是 3，也不是目标条数）。
 *
 * 跑法：cd qq-bridge && node tests/group-interject-model-decides.test.js
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const mod = (rel) => pathToFileURL(path.join(SRC, rel)).href;

let pass = 0;
const failures = [];
const check = (name, fn) => {
  try { fn(); pass += 1; console.log(`PASS  ${name}`); }
  catch (e) { failures.push(name); console.log(`FAIL  ${name}\n      ${e?.message ?? e}`); }
};

const { evaluateWakeTrigger } = await import(mod('core/wake-send.js'));
const socialMod = await import(mod('core/social-state.js'));
const { proactiveGate, defaultWakeConfig, applyOwnerWakeProbabilityToSessions, initSocialCore, social } = socialMod;
const { planSocialTimeline } = await import(mod('lib/social-timeline.js'));
const { splitLongSegment } = await import(mod('lib/segment.js'));

/* ── 把随机数钉死：任何 `Math.random() < p`（p<1）都必然判"不中"。
 * 这正是判定"骰子还在不在"的探针 —— 骰子还在，普通消息就会在这里被丢掉。 */
const realRandom = Math.random;
const freezeRandom = (v = 0.999999) => { Math.random = () => v; };
const unfreezeRandom = () => { Math.random = realRandom; };
freezeRandom();

const SELF = '10000';
const plainGroupEvent = () => ({
  self_id: SELF,
  user_id: '20000',
  sender: { nickname: '路人' },
  message: [{ type: 'text', data: { text: '今晚吃什么' } }],
});
const stWith = (triggers) => ({ wakeConfig: { triggers, mode: 'diving' } });
const evalPlain = (triggers) => evaluateWakeTrigger('group:999', stWith(triggers), plainGroupEvent(), 'group', '今晚吃什么', '今晚吃什么', false);

console.log('=== ① 群聊普通消息：任何概率配置下都必须走到模型判断（不再掷骰子）===');
for (const p of [0.05, 0.15, 0.3, 0.5, 0.9, 1, 0.0001]) {
  check(`probability=${p} 且随机数恒 0.999999 → 仍产生唤醒理由（交给模型）`, () => {
    assert.equal(evalPlain({ probability: p }), 'probability');
  });
}
check('probability 缺键（老配置）→ 仍交给模型，且不抛异常', () => {
  assert.equal(evalPlain({ atMention: true }), 'probability');
  assert.equal(evalPlain({}), 'probability');
  assert.equal(evalPlain(undefined), 'probability');
});
check('probability = null / 空串（脏值）→ 仍交给模型', () => {
  assert.equal(evalPlain({ probability: null }), 'probability');
  assert.equal(evalPlain({ probability: '' }), 'probability');
  assert.equal(evalPlain({ probability: 'abc' }), 'probability');
});
check('probability 显式 0 → 明确的"关闭开关"仍然生效（返回 null）', () => {
  assert.equal(evalPlain({ probability: 0 }), null);
});
check('probability 显式 0（字符串 "0"）→ 同样是关闭', () => {
  assert.equal(evalPlain({ probability: '0' }), null);
});
check('连续 300 条普通消息全部产生唤醒理由（不是"多少条里中一条"）', () => {
  for (let i = 0; i < 300; i++) {
    assert.equal(evalPlain({ probability: 0.05 }), 'probability', `第 ${i + 1} 条被丢掉了`);
  }
});
unfreezeRandom();

console.log('\n=== ② 主动冒泡（proactive）也去概率化：只剩结构性前提 ===');
check('probCfg 缺键（老配置）→ 仍把这一步交给模型', () => {
  assert.equal(proactiveGate({ fresh: true, idleMs: 3600_000, idleThresholdMs: 600_000 }).fire, true);
  assert.equal(proactiveGate({ probCfg: null, fresh: true, idleMs: 3600_000, idleThresholdMs: 600_000 }).fire, true);
});
check('probCfg=0.3 且随机数恒 0.999999 → 仍然开口（交给模型判断）', () => {
  freezeRandom();
  for (let i = 0; i < 200; i++) {
    const g = proactiveGate({ probCfg: 0.3, fresh: true, idleMs: 3600_000, idleThresholdMs: 600_000 });
    assert.equal(g.fire, true, `第 ${i + 1} 次被骰子挡下：${g.why}`);
    assert.equal(g.why, 'model-decides');
  }
  unfreezeRandom();
});
check('probCfg=0 → off-switch（明确关闭，不再开口）', () => {
  assert.deepEqual(proactiveGate({ probCfg: 0, fresh: true, idleMs: 3600_000, idleThresholdMs: 600_000 }), { fire: false, why: 'off-switch' });
  assert.deepEqual(proactiveGate({ probCfg: '0', fresh: true, idleMs: 3600_000, idleThresholdMs: 600_000 }), { fire: false, why: 'off-switch' });
});
check('没话题（freshContextOnly 默认开）→ no-topic，不叫醒模型', () => {
  assert.deepEqual(proactiveGate({ probCfg: 0.9, fresh: false, idleMs: 3600_000, idleThresholdMs: 600_000 }), { fire: false, why: 'no-topic' });
});
check('freshContextOnly=false 且没话题 → 仍交给模型（开关说了算，不是概率）', () => {
  assert.equal(proactiveGate({ probCfg: 0.9, freshOnly: false, fresh: false, idleMs: 3600_000, idleThresholdMs: 600_000 }).fire, true);
});
check('还没冷场 → not-idle', () => {
  assert.deepEqual(proactiveGate({ probCfg: 0.9, fresh: true, idleMs: 1000, idleThresholdMs: 600_000 }), { fire: false, why: 'not-idle' });
});
check('会话正忙 → busy', () => {
  assert.deepEqual(proactiveGate({ probCfg: 0.9, fresh: true, idleMs: 3600_000, idleThresholdMs: 600_000, busy: true }), { fire: false, why: 'busy' });
});
check('无参数 / 空对象不抛异常（防御性）', () => {
  assert.equal(proactiveGate().fire, false);
  assert.equal(proactiveGate({}).fire, false);
});
check('判定里没有任何概率系数（旧实现有 ×1.4 / ×0.5 / ×0.3 四个机械系数）', () => {
  const g = proactiveGate({ probCfg: 0.3, fresh: true, idleMs: 3600_000, idleThresholdMs: 600_000 });
  assert.deepEqual(Object.keys(g).sort(), ['fire', 'why']);
});

console.log('\n=== ③ 老配置兼容：缺 recommendedProbability 不能被当成"关闭" ===');
/* 本节的 applyOwner… 会走到 saveSocialState()：这里用的是内存里的假会话（没有 recentMessages 等数组），
 * 保存会在拼对象时抛错并 return —— 也就是说**真实 state/social-state.json 绝不会被写**。
 * 这既是"不要拿测试去污染真机状态"的护栏，下面也把它当断言钉住（文件 mtime+大小前后一致）。 */
const { SOCIAL_STATE_FILE } = await import(mod('lib/paths.js'));
const stateStat = () => {
  try { const s = fs.statSync(SOCIAL_STATE_FILE); return `${s.size}:${s.mtimeMs}`; } catch { return 'missing'; }
};
const stateBefore = stateStat();
check('defaultWakeConfig：配置缺 recommendedProbability → probability 不是 0', () => {
  initSocialCore({ social: { wake: {} } });
  const wc = defaultWakeConfig();
  assert.notEqual(wc.triggers.probability, 0, '缺键被写成了 0 = 永久静默');
  assert.equal(wc.triggers.probability, undefined);
});
check('defaultWakeConfig：配置显式 0 → probability === 0（关闭开关保留）', () => {
  initSocialCore({ social: { wake: { recommendedProbability: 0 } } });
  const wc = defaultWakeConfig();
  assert.equal(wc.triggers.probability, 0);
});
check('defaultWakeConfig：配置显式 0.15 → 原样记录（数值不再参与判断）', () => {
  initSocialCore({ social: { wake: { recommendedProbability: 0.15 } } });
  assert.equal(defaultWakeConfig().triggers.probability, 0.15);
});
check('applyOwnerWakeProbabilityToSessions：配置缺键时不把会话同步成 0', () => {
  initSocialCore({ social: { wake: {} } });
  const key = 'group:990001';
  const st = { wakeConfig: { mode: 'diving', triggers: { probability: 0.15, probabilitySource: 'model' } } };
  social.conversations.set(key, st);
  try {
    const r = applyOwnerWakeProbabilityToSessions();
    assert.equal(st.wakeConfig.triggers.probability, 0.15, '缺键却把会话写成了 0 = 永久静默');
    assert.equal(st.wakeConfig.triggers.probabilitySource, 'model');
    assert.equal(r.updated, 0);
    assert.equal(r.kept, 1);
  } finally {
    social.conversations.delete(key);
  }
});
check('applyOwnerWakeProbabilityToSessions：配置显式 0 → 照旧同步（主人要关就是关）', () => {
  initSocialCore({ social: { wake: { recommendedProbability: 0 } } });
  const key = 'group:990002';
  const st = { wakeConfig: { mode: 'diving', triggers: { probability: 0.15, probabilitySource: 'owner' } } };
  social.conversations.set(key, st);
  try {
    const r = applyOwnerWakeProbabilityToSessions();
    assert.equal(st.wakeConfig.triggers.probability, 0);
    assert.equal(r.updated, 1);
  } finally {
    social.conversations.delete(key);
  }
});
check('本节没有把真实 state/social-state.json 写坏（前后 size+mtime 一致）', () => {
  assert.equal(stateStat(), stateBefore);
});

console.log('\n=== ④ 源码级护栏：骰子没有被改回来（这类改动最容易被后续提交悄悄还原）===');
const readSrc = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
/* 只看真实代码：注释里出现 Math.random 是说明文字（本次改造就写了「原来这里是 Math.random() < prob」），
 * 不能算骰子。注意 Math.random() 本身不一律禁止 —— 两条 wake 间隔的抖动
 * （`Math.floor(min + Math.random() * (max - min))`）是打散定时器、防"整点报时"用的，
 * 跟"要不要开口"无关，必须保留；被禁的是拿它判**要不要说话**。 */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
check('wake-send.js 的 evaluateWakeTrigger 里没有掷骰判定（骰子已删）', () => {
  const src = stripComments(readSrc('core/wake-send.js'));
  const start = src.indexOf('export function evaluateWakeTrigger');
  assert.ok(start > 0, '找不到 evaluateWakeTrigger');
  const end = src.indexOf('\n}', start);
  assert.ok(end > start, '找不到 evaluateWakeTrigger 结尾');
  const body = src.slice(start, end);
  assert.ok(!/Math\.random/.test(body), 'evaluateWakeTrigger 里又出现了随机数');
  assert.ok(!/Math\.random\(\)\s*<\s*Number\(tr\.probability\)/.test(src), '旧的骰子那一行又回来了');
  assert.ok(/return 'probability';/.test(body), 'evaluateWakeTrigger 里没有"交给模型"的返回');
});
check('social-state.js 的 proactive 定时器里没有掷骰判定 / 概率系数', () => {
  const src = stripComments(readSrc('core/social-state.js'));
  const start = src.indexOf('st.proactiveTimer = setTimeout(');
  const end = src.indexOf('export function proactiveGate');
  assert.ok(start > 0 && end > start, '找不到 proactive 定时器段');
  const body = src.slice(start, end);
  assert.ok(!/Math\.random\(\)\s*</.test(body), 'proactive 里又出现了掷骰判定');
  assert.ok(!/prob\b/.test(body), 'proactive 里又出现了 prob 变量');
  assert.ok(!/prob\s*\*=/.test(src), 'proactive 里又出现了概率系数（prob *= …）');
  assert.ok(/proactiveGate\(/.test(body), '定时器没有走 proactiveGate 判定');
});
check('wakeRefLine 不再要求模型"把 triggers.probability 填成这个值"', () => {
  const src = readSrc('core/wake-send.js');
  assert.ok(!/把 triggers\.probability 填成这个值/.test(src), '旧文案又回来了：它会让模型继续按概率回话');
  assert.ok(/不再按概率过滤/.test(src), 'wakeRefLine 没有说明新语义');
});

console.log('\n=== ⑤ 「不死板发 3 段」：代码里没有固定条数逻辑 ===');
check('分条工具不把条数截断到固定值：6 段的输入就是 6 条', () => {
  const out = planSocialTimeline('你好 世界 再见 走吧 好 嗯', { burstEnabled: true, maxReplyChars: 500 });
  assert.equal(out.main.length, 6);
  assert.equal(out.followUp, null);
});
check('超长文本只按长度硬拆（安全兜底），拆出的条数由长度决定、不是固定 3', () => {
  const per = 20;
  const long = '啊'.repeat(per * 3 + 5);
  assert.equal(splitLongSegment(long, per).length, 4);
  const long2 = '啊'.repeat(per * 7);
  assert.equal(splitLongSegment(long2, per).length, 7);
});
check('一条普通字符串不会被自动切成多条气泡（条数只能由模型给）', () => {
  const src = readSrc('core/console-server.js');
  assert.ok(/default不再按空格自动分条：字符串就是一条消息/.test(src), '自动分条逻辑又回来了');
  assert.ok(/const messages = Array\.isArray\(rawMessages\)/.test(src), '找不到 messages 的构造点');
});
check('burstMaxMessages 是"上限"且不是 3（可配置，缺省 8）', () => {
  const src = readSrc('core/config.js');
  const m = src.match(/burstMaxMessages:\s*(\d+)/);
  assert.ok(m, '找不到 burstMaxMessages 默认值');
  assert.notEqual(Number(m[1]), 3);
  assert.ok(Number(m[1]) >= 8, `默认上限太小：${m[1]}`);
  const cs = readSrc('core/console-server.js');
  assert.ok(/messages\.length > maxMsgs/.test(cs), 'burstMaxMessages 的"上限"语义变了');
});
check('发送路径按 length 用一条消息（无 split/index===2 之类的固定分段）', () => {
  const cs = readSrc('core/console-server.js');
  assert.ok(!/sendList\[2\]/.test(cs), '发送路径出现了"第 3 条"的硬编码');
  assert.ok(!/index\s*===\s*2\b/.test(cs), '发送路径出现了 index===2 的硬编码');
});

console.log('\n=== ⑥ 端到端（进程内真跑一遍）：群消息 → 唤醒理由 → 真唤醒正文 ===');
/* 前面几节是"判定函数"层面的；这一节用真配置（loadConfig，只读）+ 真 group 事件，
 * 把 evaluateWakeTrigger → buildWakePrompt 整条链跑一遍，钉住模型**真的**收到了新语义。 */
const { loadConfig } = await import(mod('core/config.js'));
const fullCfg = loadConfig(); // 只读 config.json，不写盘（既有测试同样用法）
socialMod.initSocialCore(fullCfg);
const modeMod = await import(mod('core/mode.js'));
modeMod.initModeCore(fullCfg);
const wakeMod = await import(mod('core/wake-send.js'));
wakeMod.initWakeCore(fullCfg);

const buildGroupPrompt = (triggerPatch) => {
  const key = 'group:123456';
  fullCfg.social.wake.recommendedProbability = 0.15;
  const st = socialMod.getSocialState(key);
  st._promptInjected = false;
  st.wakeConfig = { mode: 'diving', batchWindowMs: 2000, triggers: { atMention: true, ...triggerPatch } };
  st.unread = [{
    seq: 1, userId: '20000', sender: '路人', isOwner: false, messageId: '111',
    time: Date.now(), atSelf: false, hasMedia: false, hasFile: false,
    plain: '今晚吃什么', text: '今晚吃什么'
  }];
  const reason = evaluateWakeTrigger(key, st, plainGroupEvent(), 'group', '今晚吃什么', '今晚吃什么', false);
  const prompt = String(wakeMod.buildWakePrompt(key, reason ?? 'probability'));
  socialMod.social.conversations.delete(key);
  return { reason, prompt };
};
check('真配置 + 真群事件（probability=0.15）→ 理由 probability，正文里 [WakeRef] 说明"不再按概率过滤"', () => {
  const { reason, prompt } = buildGroupPrompt({ probability: 0.15, probabilitySource: 'owner' });
  assert.equal(reason, 'probability');
  const ref = prompt.split('\n').find((l) => l.includes('[WakeRef]'));
  assert.ok(ref, '正文里没有 [WakeRef] 行');
  assert.match(ref, /不再按概率过滤/);
  assert.match(ref, /主人配置=0\.15/);
  assert.match(ref, /来源=owner/);
  assert.ok(!/填成这个值/.test(prompt), '旧的"把 probability 填成这个值"文案又回来了');
});
check('配置缺 recommendedProbability（老配置）→ 仍产生理由，[WakeRef] 如实写"未设置"，不抛异常', () => {
  const { reason, prompt } = buildGroupPrompt({}); // 没有任何 probability 键
  assert.equal(reason, 'probability');
  const ref = prompt.split('\n').find((l) => l.includes('[WakeRef]'));
  assert.match(ref, /不再按概率过滤/);
  assert.match(ref, /未设置/);
});
check('probability=0（关闭开关）→ 不产生唤醒理由，且照旧构造正文不抛异常', () => {
  const key = 'group:123457';
  const st = socialMod.getSocialState(key);
  st.wakeConfig = { mode: 'diving', triggers: { probability: 0 } };
  const reason = evaluateWakeTrigger(key, st, plainGroupEvent(), 'group', '今晚吃什么', '今晚吃什么', false);
  socialMod.social.conversations.delete(key);
  assert.equal(reason, null);
});

console.log(`\n${failures.length ? `${failures.length} FAILED` : 'ALL PASS'}  (${pass} passed, ${failures.length} failed)`);
process.exit(failures.length ? 1 : 0);
