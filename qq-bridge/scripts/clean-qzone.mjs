// 清除当前账号已发布的所有 QQ 空间说说
import fs from 'node:fs';
import path from 'node:path';

const config = JSON.parse(fs.readFileSync('/root/qq-bridge/config.json', 'utf8'));
const napcatBase = (config.napcat?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const token = config.napcat?.accessToken || config.napcat?.wsAccessToken || '';
const headers = token ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };

async function fetchOneBot(action, body = {}) {
  const res = await fetch(`${napcatBase}/${action}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  return res.json();
}

function getBkn(skey) {
  let hash = 5381;
  for (let i = 0; i < skey.length; i++) {
    hash += (hash << 5) + skey.charCodeAt(i);
  }
  return hash & 0x7fffffff;
}

async function main() {
  console.log('获取登录号信息与 Cookies...');
  const loginInfo = await fetchOneBot('get_login_info');
  const uin = loginInfo?.data?.user_id;
  console.log(`当前登录 QQ 号: ${uin}`);

  // 获取 qzone.qq.com 的 cookies 和 credentials
  const cookieRes = await (await fetch(`${napcatBase}/get_cookies?domain=qzone.qq.com`, { headers })).json();
  const cookies = cookieRes?.data?.cookies || '';
  const bkn = cookieRes?.data?.bkn || '';
  console.log('获取凭证成功, bkn:', bkn);

  let totalDeleted = 0;
  while (true) {
    const listUrl = `https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6?uin=${uin}&ftype=0&sort=0&pos=0&num=60&replynum=0&g_tk=${bkn}`;
    console.log('正在拉取 QQ 空间说说列表...');
    const listRes = await fetch(listUrl, {
      headers: {
        Cookie: cookies,
        Referer: `https://user.qzone.qq.com/${uin}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    const rawText = await listRes.text();
    const jsonMatch = /_Callback\s*\(([\s\S]*)\)\s*;?$/.exec(rawText.trim()) || /_preloadCallback\s*\(([\s\S]*)\)\s*;?$/.exec(rawText.trim()) || /^\s*([\s\S]*)\s*$/.exec(rawText.trim());
    let msgList = [];
    try {
      const parsed = JSON.parse(jsonMatch ? jsonMatch[1] : rawText);
      msgList = parsed.msglist || [];
    } catch (e) {
      console.log('解析说说列表失败，原始返回:', rawText.slice(0, 200));
      break;
    }

    if (!msgList || msgList.length === 0) {
      console.log('当前空间已没有任何已发布说说，清空完毕！');
      break;
    }

    console.log(`本批发现 ${msgList.length} 条说说，正在批量删除...`);
    for (const item of msgList) {
      const tid = item.tid;
      const content = item.content || '(无文字内容)';
      console.log(`正在删除说说 [${tid}]: ${content.slice(0, 30)}...`);
      try {
        const delRes = await fetchOneBot('delete_qzone_msg', { tid });
        if (delRes.status === 'ok' || delRes.retcode === 0) {
          console.log(`  -> 删除成功 [${tid}]`);
          totalDeleted++;
        }
      } catch (err) {
        console.log(`  -> 删除出错 [${tid}]:`, err.message);
      }
      await new Promise(r => setTimeout(r, 400));
    }
  }

  console.log(`\n全部清理彻底完毕！累计清理历史说说 ${totalDeleted} 条。`);
}

main().catch(console.error);
