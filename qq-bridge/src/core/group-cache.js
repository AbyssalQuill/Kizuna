// 群信息/群名缓存
// cfg 静态注入（initGroupCacheCore），bot 运行期注入（setGroupCacheBot）。
import { log } from '../lib/log.js';

// ── 群信息缓存：群主/管理员（OneBot get_group_member_list 的 role 字段） ──
const groupInfoCache = new Map(); // groupId -> { ownerId, ownerName, adminIds, adminNames, ts }
const GROUP_INFO_TTL_MS = 10 * 60 * 1000;
// 群名缓存：groupId -> { name, ts }，用于唤醒提示的【群清单】，避免 AI 记不住群号↔群名对应关系发错群
const groupNameCache = new Map();
// 2026-09-16 修：get_group_info（NapCat 内部走 NodeIKernelGroupService/getGroupDetailInfo）在部分
// QQ 版本/账号缓存上会稳定失败，实测报 `EventChecker Failed … "errMsg":"inner_error"`：
// 一失败群名就永久缺失，桥日志与唤醒提示里的群名全变成光秃秃的群号（看着像坏了，其实只是名字没拿到）。
// 这里补一条**回退**：改用 get_group_list 拉全量群列表（同环境实测可用），建「群号 → 群名」映射并缓存。
let groupListCache = { ts: 0, map: new Map() };
const GROUP_LIST_TTL_MS = 10 * 60 * 1000;

/** 回退：从 get_group_list 全量列表里找群名（列表整体缓存 10 分钟，逐个群不会重复请求）。 */
async function nameFromGroupList(g) {
  const fresh = Date.now() - groupListCache.ts < GROUP_LIST_TTL_MS && groupListCache.map.size > 0;
  if (!fresh) {
    try {
      const list = await botRef.api('get_group_list', {});
      const arr = Array.isArray(list) ? list : (list?.data ?? []);
      const map = new Map();
      for (const it of arr) {
        const id = it?.group_id != null ? String(it.group_id) : '';
        const nm = String(it?.group_name || it?.name || '').trim();
        if (id && nm) map.set(id, nm);
      }
      if (map.size) groupListCache = { ts: Date.now(), map };
    } catch (error) {
      log(`[memory] 群列表拉取失败（群名回退也失败）：${error?.message ?? error}`);
    }
  }
  return groupListCache.map.get(g) || null;
}

let cfgRef = null;
let botRef = null;
/** main 启动时调用：注入 cfg（此后不再变） */
export function initGroupCacheCore(cfg) {
  cfgRef = cfg;
}
/** NapCat 网关就绪后注入 bot（NapCat client） */
export function setGroupCacheBot(bot) {
  botRef = bot;
}

export async function warmGroupName(groupId) {
  const g = String(groupId);
  try {
    const info = await botRef.getGroupInfo(Number(g));
    const name = String(info?.group_name || info?.name || '').trim();
    if (name) {
      groupNameCache.set(g, { name, ts: Date.now() });
      return name;
    }
  } catch (error) {
    // 主路径失败不再直接放弃：先试 get_group_list 回退，拿到名字就照常返回（只留一行说明用了回退）
    const fallback = await nameFromGroupList(g);
    if (fallback) {
      groupNameCache.set(g, { name: fallback, ts: Date.now() });
      log(`[memory] 群名主接口失败(${error?.message ?? error})，已用群列表回退拿到「${fallback}」`);
      return fallback;
    }
    log(`[memory] 群名拉取失败 ${g}: ${error?.message ?? error}`);
    return null;
  }
  return null;
}

export function getGroupDisplayName(groupId) {
  const hit = groupNameCache.get(String(groupId));
  if (hit && Date.now() - hit.ts < GROUP_INFO_TTL_MS) return hit.name;
  return null;
}

// 群清单文本：所有白名单群的 群号（群名），供 AI 跨会话发消息时确认目标，避免发错群
export function formatGroupListLine() {
  const gids = Array.isArray(cfgRef?.allow?.groups) ? cfgRef.allow.groups.map(String) : [];
  if (!gids.length) return '';
  const parts = gids.map((g) => {
    const name = getGroupDisplayName(g);
    return name ? `${g}(${name})` : `${g}`;
  });
  return `[Groups] ${parts.join(', ')}`;
}

export async function warmGroupInfo(groupId) {
  const g = String(groupId);
  try {
    const list = await botRef.getGroupMemberList(Number(g));
    const members = Array.isArray(list) ? list : (list?.data ?? []);
    let ownerId = null, ownerName = null;
    const adminIds = [], adminNames = [];
    for (const m of members) {
      const uid = m?.user_id != null ? String(m.user_id) : null;
      if (!uid) continue;
      const nm = m?.card || m?.nickname || String(uid);
      const role = String(m?.role ?? '');
      if (role === 'owner') { ownerId = uid; ownerName = nm; }
      else if (role === 'admin') { adminIds.push(uid); adminNames.push(nm); }
    }
    if (ownerId) {
      groupInfoCache.set(g, { ownerId, ownerName, adminIds, adminNames, ts: Date.now() });
      return groupInfoCache.get(g);
    }
  } catch (error) {
    log(`[memory] 群信息拉取失败 ${g}: ${error?.message ?? error}`);
  }
  return null;
}

export function getCachedGroupInfo(groupId) {
  const hit = groupInfoCache.get(String(groupId));
  if (hit && Date.now() - hit.ts < GROUP_INFO_TTL_MS) return hit;
  return null;
}

export function formatGroupInfoLine(groupId) {
  const info = getCachedGroupInfo(groupId);
  if (!info) return '';
  const owner = `${info.ownerName || '?'}(QQ:${info.ownerId})`;
  const admins = info.adminNames && info.adminNames.length ? `; admins: ${info.adminNames.join(', ')}` : '';
  return `[This group] owner: ${owner}${admins}`;
}

/* ── 会话显示名（管理端「聊天记录」左栏标题）──────────────────────────────────────────
 * 2026-09-26 要求：「这一栏的标题改为群昵称和私聊个人昵称」。
 *
 * 为什么要专门做一遍：左栏标题原来直接取 chat_convs.name，而那一列是
 * 「最近一条消息的 sender_name」（见 chat-db.js 里的迁移与 upsert）——**是群里某个人、
 * 或者机器人自己那条消息的发送者名**，于是同一批会话会显示成
 * 「坐忘道」「幻时」「星痕Ofter」「我」这种和人无关的东西（线上实测就是这个）。
 *
 * 现在的口径：
 *   · 群聊：标题 = **群名**（群名称；get_group_info / 群列表回退），另外带上**我的群昵称**
 *     （群名片优先、其次群昵称）供界面小字显示；都拿不到才退回库里那条、最后退回 key；
 *   · 私聊：标题 = **对方昵称**（get_friend_list 的 nickname；好友列表里没有就走
 *     get_stranger_info），备注（remark）单独作为附加字段返回，不覆盖昵称。
 *
 * 缓存 10 分钟（与群名同一档）；失败也缓存 60 秒，避免界面每 5 秒推流时反复打 NapCat。 */
const convNameCache = new Map(); // key -> { name, groupName, groupNick, remark, ts, ttl }
const CONV_NAME_TTL_MS = 10 * 60 * 1000;
const CONV_NAME_FAIL_TTL_MS = 60 * 1000;
let friendListCache = { ts: 0, map: new Map() };
const FRIEND_LIST_TTL_MS = 10 * 60 * 1000;
let selfIdCache = { id: '', ts: 0 };
const SELF_ID_TTL_MS = 30 * 60 * 1000;

/** 机器人自己的 QQ 号（拿「我的群昵称」要用）；30 分钟缓存。 */
async function selfUserId() {
  if (selfIdCache.id && Date.now() - selfIdCache.ts < SELF_ID_TTL_MS) return selfIdCache.id;
  try {
    const me = await botRef.api('get_login_info', {});
    const id = String((me?.data ?? me)?.user_id ?? '').trim();
    if (id) selfIdCache = { id, ts: Date.now() };
    return id;
  } catch (error) {
    log(`[memory] 取登录号失败（群昵称会缺）：${error?.message ?? error}`);
    return selfIdCache.id || '';
  }
}

/** 好友列表（uid → { nickname, remark }）；整体缓存 10 分钟。 */
async function friendMap() {
  if (Date.now() - friendListCache.ts < FRIEND_LIST_TTL_MS && friendListCache.map.size > 0) return friendListCache.map;
  try {
    const list = await botRef.api('get_friend_list', {});
    const arr = Array.isArray(list) ? list : (list?.data ?? []);
    const map = new Map();
    for (const it of arr) {
      const uid = it?.user_id != null ? String(it.user_id) : '';
      if (!uid) continue;
      map.set(uid, { nickname: String(it?.nickname ?? '').trim(), remark: String(it?.remark ?? '').trim() });
    }
    if (map.size) friendListCache = { ts: Date.now(), map };
  } catch (error) {
    log(`[memory] 好友列表拉取失败（私聊昵称会缺）：${error?.message ?? error}`);
  }
  return friendListCache.map;
}

/** 读缓存（过期返回 null，由调用方决定要不要预热）。 */
export function getConvDisplayName(key) {
  const hit = convNameCache.get(String(key));
  if (!hit) return null;
  const ttl = hit.name ? CONV_NAME_TTL_MS : CONV_NAME_FAIL_TTL_MS;
  if (Date.now() - hit.ts >= ttl) return null;
  return hit;
}

/** 预热一个 key 的显示名；失败只记一行日志并写短期空缓存（不让界面每轮都打 NapCat）。 */
export async function warmConvName(key) {
  const k = String(key ?? '').trim();
  const m = /^(group|private):(\d+)$/.exec(k);
  if (!m) return null;
  const [, kind, id] = m;
  try {
    if (kind === 'group') {
      let groupName = getGroupDisplayName(id);
      if (!groupName) groupName = (await warmGroupName(id)) || '';
      let groupNick = '';
      const self = await selfUserId();
      if (self) {
        try {
          const mi = await botRef.api('get_group_member_info', { group_id: Number(id), user_id: Number(self) });
          const d = mi?.data ?? mi ?? {};
          groupNick = String(d?.card ?? '').trim() || String(d?.nickname ?? '').trim();
        } catch (error) {
          // 线上实测有的群这个接口稳定 failed（如 906430959）——不致命，群名照用
          log(`[memory] 取「我的群昵称」失败 group:${id}：${error?.message ?? error}`);
        }
      }
      const entry = { name: groupName || groupNick, groupName, groupNick, remark: '', ts: Date.now() };
      convNameCache.set(k, entry);
      return entry;
    }
    const fm = await friendMap();
    let nickname = fm.get(id)?.nickname || '';
    const remark = fm.get(id)?.remark || '';
    if (!nickname) {
      try {
        const si = await botRef.api('get_stranger_info', { user_id: Number(id) });
        const d = si?.data ?? si ?? {};
        nickname = String(d?.nickname ?? '').trim();
      } catch (error) {
        log(`[memory] 取私聊昵称失败 private:${id}：${error?.message ?? error}`);
      }
    }
    const entry = { name: nickname || remark, groupName: '', groupNick: '', remark, ts: Date.now() };
    convNameCache.set(k, entry);
    return entry;
  } catch (error) {
    log(`[memory] 会话显示名解析失败 ${k}：${error?.message ?? error}`);
    convNameCache.set(k, { name: '', groupName: '', groupNick: '', remark: '', ts: Date.now() });
    return null;
  }
}

/** 批量预热（并发 + 整体预算，超预算的先返回、下一轮再补；界面每次都调用它）。 */
export async function warmConvNames(keys, budgetMs = 2500) {
  const list = [...new Set((Array.isArray(keys) ? keys : []).map((x) => String(x ?? '').trim()).filter(Boolean))];
  if (!list.length) return 0;
  const jobs = list.map((k) => warmConvName(k));
  let done = 0;
  await Promise.race([
    Promise.allSettled(jobs).then((rs) => { done = rs.filter((r) => r.status === 'fulfilled' && r.value).length; }),
    new Promise((resolve) => setTimeout(resolve, Math.max(200, Number(budgetMs) || 2500))),
  ]);
  return done;
}
