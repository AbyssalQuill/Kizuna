// dsh-temperature 的逻辑自测：不依赖 cordis 运行时，用假的 ctx / next 直接跑监听器。
// 跑法：node test/logic.test.mjs
import assert from 'node:assert/strict';
import { apply, name, inject } from '../lib/index.js';

/** 记录注册的监听器，供测试直接调用。 */
function fakeCtx() {
  const hooks = [];
  return {
    hooks,
    logger: { info: () => {} },
    on(n, fn, options) {
      hooks.push({ n, fn, options });
      return () => {};
    },
  };
}
const next = (config) => async () => config;

let pass = 0;
const check = (label, fn) => {
  fn();
  pass++;
  console.log(`ok ${pass} — ${label}`);
};

check('插件名与依赖', () => {
  assert.equal(name, 'dsh-temperature');
  assert.deepEqual(inject, []);
});

check('监听 agent/request，且是 global（否则收不到 scoped 事件）', () => {
  const ctx = fakeCtx();
  apply(ctx, { temperature: 0.3 });
  assert.equal(ctx.hooks.length, 1);
  assert.equal(ctx.hooks[0].n, 'agent/request');
  assert.equal(ctx.hooks[0].options?.global, true);
});

check('没有 config → 完全 no-op', async () => {
  const ctx = fakeCtx();
  apply(ctx, {});
  const out = await ctx.hooks[0].fn({}, next({ provider: 'deepseek-official', model: 'deepseek-flash' }));
  assert.equal('temperature' in out, false);
});

check('全局 temperature 生效', async () => {
  const ctx = fakeCtx();
  apply(ctx, { temperature: 0.3 });
  const out = await ctx.hooks[0].fn({}, next({ provider: 'p', model: 'm' }));
  assert.equal(out.temperature, 0.3);
  assert.equal(out.provider, 'p');
  assert.equal(out.model, 'm');
});

check('models 覆盖 providers，providers 覆盖全局', async () => {
  const ctx = fakeCtx();
  apply(ctx, { temperature: 0.9, providers: { p: 0.5 }, models: { m: 0.2 } });
  const fn = ctx.hooks[0].fn;
  assert.equal((await fn({}, next({ provider: 'p', model: 'm' }))).temperature, 0.2);
  assert.equal((await fn({}, next({ provider: 'p', model: 'other' }))).temperature, 0.5);
  assert.equal((await fn({}, next({ provider: 'other', model: 'x' }))).temperature, 0.9);
});

check('别人已经给了 temperature → 不覆盖（auto-review 的 0 要保住）', async () => {
  const ctx = fakeCtx();
  apply(ctx, { temperature: 0.7 });
  const out = await ctx.hooks[0].fn({}, next({ provider: 'p', model: 'm', temperature: 0 }));
  assert.equal(out.temperature, 0);
});

check('withoutThinkingOnly：effort 非 off 时不下发，off 时下发', async () => {
  const ctx = fakeCtx();
  apply(ctx, { temperature: 0.4, withoutThinkingOnly: true });
  const fn = ctx.hooks[0].fn;
  assert.equal('temperature' in (await fn({}, next({ provider: 'p', model: 'm', reasoningEffort: 'high' }))), false);
  assert.equal('temperature' in (await fn({}, next({ provider: 'p', model: 'm' }))), false);
  assert.equal((await fn({}, next({ provider: 'p', model: 'm', reasoningEffort: 'off' }))).temperature, 0.4);
});

check('非法值当作没配置（NaN / 字符串 / null）', async () => {
  const ctx = fakeCtx();
  apply(ctx, { temperature: Number.NaN, models: { m: '0.5' } });
  const out = await ctx.hooks[0].fn({}, next({ provider: 'p', model: 'm' }));
  assert.equal('temperature' in out, false);
  const ctx2 = fakeCtx();
  apply(ctx2, { temperature: null });
  assert.equal('temperature' in (await ctx2.hooks[0].fn({}, next({ provider: 'p', model: 'm' }))), false);
});

check('返回值是新对象，不改动传入的 config', async () => {
  const ctx = fakeCtx();
  apply(ctx, { temperature: 0.3 });
  const seed = { provider: 'p', model: 'm' };
  const out = await ctx.hooks[0].fn({}, next(seed));
  assert.notEqual(out, seed);
  assert.equal('temperature' in seed, false);
});

console.log(`\n${pass}/${pass} 通过`);
