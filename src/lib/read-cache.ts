/* 页面读取的「先出上次内容、再后台校准」脚手架。
 *
 * 背景（2026-09-26）：各页进来先跳一行「正在读取…」/转圈，读完再刷出来 —— 观感是"被清空去等"。
 * 这里只解决一件事：把上一次**成功**读到的结果留在内存里，下次进页面立刻拿来渲染，
 * 同时后台静默重读，读到了原地替换；内容没变则屏上什么都不动。
 *
 * 三条纪律：
 *   1. 缓存只是"首帧的旧值"，不是真相 —— 每次进页面都必须照样发一次真请求（quiet 校准）。
 *   2. 只在**成功**回包时写入缓存；失败不写（免得把错误状态当旧值反复渲染）。
 *   3. 页面拿到新值后要么自己 setState，要么用 writeCacheValue 同步写回，否则下次仍读到旧的。
 *
 * 刷新页面即失效（进程内 Map，不落盘）：不引入"跨会话的过期数据"这种更难解释的问题。
 */

type Entry<T> = { at: number; value: T };

const store = new Map<string, Entry<unknown>>();

/** 读缓存。返回 null 表示"没有旧值可用"，调用方按"首次进入"处理（骨架占位）。 */
export function readCacheValue<T>(key: string): Entry<T> | null {
  const hit = store.get(key) as Entry<T> | undefined;
  return hit ?? null;
}

/** 首帧初值：缓存的 value（没有就 null）+ 这份值是不是旧的。 */
export function initialFromCache<T>(key: string): { value: T | null; fromCache: boolean; at: number } {
  const hit = readCacheValue<T>(key);
  return hit ? { value: hit.value, fromCache: true, at: hit.at } : { value: null, fromCache: false, at: 0 };
}

/** 写入缓存（只在成功回包后调用）。 */
export function writeCacheValue<T>(key: string, value: T): void {
  store.set(key, { at: Date.now(), value });
}

/** 主动作废（例如该对象已被删除/改名，旧值再渲染就是错的）。 */
export function dropCacheValue(key: string): void {
  store.delete(key);
}

/** 缓存里的这份有多旧（毫秒）；没有缓存返回 -1。用于小字提示"上次读到"。 */
export function cacheAgeMs(key: string): number {
  const hit = store.get(key);
  return hit ? Date.now() - hit.at : -1;
}

/* ── 后台预热（2026-09-26 追加）──────────────────────────────────────────────────────
 * 用户反馈："没正在读取了但是有时候切换，内容还是有延迟显示" —— 延迟来自"这一页本次会话还没读过"，
 * 首帧只能给骨架。所以把读提前：进管理器后空闲时、以及鼠标停在入口按钮上时，先把要用的那份读进缓存，
 * 点下去时就已经是"有旧值"的路径（瞬时）。
 *
 * 调用方**只给 fetcher**：去重、写缓存、失败静默都在这里，页面代码不必自己判"要不要预热"。
 */

const warming = new Set<string>();

/** 预热一个 key。已在飞 / 缓存还新（默认 5 分钟）→ 直接返回；失败静默（预热不该弹任何错）。 */
export async function warmCache<T>(
  key: string,
  fetcher: () => Promise<T | null | undefined>,
  opts: { maxAgeMs?: number } = {},
): Promise<void> {
  const maxAge = opts.maxAgeMs ?? 5 * 60_000;
  const hit = store.get(key);
  if (hit && Date.now() - hit.at < maxAge) return;
  if (warming.has(key)) return;
  warming.add(key);
  try {
    const v = await fetcher();
    if (v !== null && v !== undefined) store.set(key, { at: Date.now(), value: v });
  } catch {
    /* 预热失败当没发生：进页面时照常自己读一遍 */
  } finally {
    warming.delete(key);
  }
}

/** 这一轮预热是不是已经在跑（有的页面想据此少发一次请求，可不用）。 */
export function isWarming(key: string): boolean {
  return warming.has(key);
}
