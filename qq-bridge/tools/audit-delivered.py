#!/usr/bin/env python3
"""audit-delivered：核对「实际投递到 QQ 的文本」有没有动作括号（只读，不发送）。

为什么需要它：chat.db 记的是**模型原文**（落库在出站清洗之前），拿它当投递证据会误判。
唯一权威的投递见证是 QQ 侧的消息记录 —— 走 NapCat 的 OneBot get_msg。

用法：
  python3 tools/audit-delivered.py                       # 最近 20 条私聊投递
  python3 tools/audit-delivered.py --limit 50
  python3 tools/audit-delivered.py --key private:123456
  python3 tools/audit-delivered.py --since "2026-10-29 15:24"   # 只看之后（东八区）
  python3 tools/audit-delivered.py --json

退出码：0 = 范围内无括号；1 = 有括号（便于挂定时巡检）。
"""
import argparse
import calendar
import json
import sqlite3
import subprocess
import sys
import time

DB = '/root/qq-bridge/state/chat.db'
CFG = '/root/qq-bridge/config.json'
HTTP = 'http://127.0.0.1:3000'


def napcat_token():
    try:
        cfg = json.load(open(CFG, encoding='utf-8'))
        return str((cfg.get('napcat') or {}).get('accessToken') or '')
    except Exception:
        return ''


def get_msg(message_id, token):
    payload = json.dumps({'message_id': int(message_id)})
    out = subprocess.run(
        ['curl', '-s', '-X', 'POST', HTTP + '/get_msg',
         '-H', 'content-type: application/json',
         '-H', 'Authorization: Bearer ' + token,
         '-d', payload],
        capture_output=True,
    )
    try:
        return json.loads(out.stdout.decode('utf-8', 'replace'))
    except Exception:
        return {}


def parse_row_ts(value):
    """chat.db 的 ts 是格式化文本（形如 '2026-10-29 周四 15:40:30'，东八区），不是时间戳。"""
    s = str(value).strip()
    parts = s.split()
    if len(parts) == 3:
        s = parts[0] + ' ' + parts[2]
    for fmt in ('%Y-%m-%d %H:%M:%S', '%Y-%m-%d %H:%M'):
        try:
            return int((calendar.timegm(time.strptime(s, fmt)) - 8 * 3600) * 1000)
        except ValueError:
            continue
    return 0


def has_bracket(s):
    return ('\uff08' in s) or ('(' in s) or ('*' in s)


def parse_since(text):
    if not text:
        return 0
    # 服务器时区是 UTC，而 --since 一直按东八区理解（看日志的人在东八区）：
    # 先把它当 UTC 解析成形，再减 8 小时得到真正的 UTC 瞬时。
    for fmt in ('%Y-%m-%d %H:%M:%S', '%Y-%m-%d %H:%M', '%Y-%m-%d'):
        try:
            epoch = calendar.timegm(time.strptime(text, fmt)) - 8 * 3600
            return int(epoch * 1000)
        except ValueError:
            continue
    raise SystemExit('--since 格式应为 "YYYY-MM-DD HH:MM" 或 "YYYY-MM-DD"')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--key', default=None, help='会话键（默认取 ownerQQ 的私聊）')
    ap.add_argument('--limit', type=int, default=20)
    ap.add_argument('--since', default=None, help='只看该时刻之后（东八区）')
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args()

    key = args.key
    if not key:
        try:
            owner = str((json.load(open(CFG, encoding='utf-8')) or {}).get('ownerQQ') or '')
        except Exception:
            owner = ''
        key = 'private:' + owner
    since_ms = parse_since(args.since)
    token = napcat_token()

    con = sqlite3.connect(DB)
    rows = list(con.execute(
        "select message_id, ts, content from chat_messages "
        "where conv_key=? and is_self=1 and message_id is not null order by id desc limit ?",
        (key, args.limit),
    ))

    results = []
    for mid, ts, content in rows:
        ts_ms = parse_row_ts(ts)
        if since_ms and ts_ms < since_ms:
            continue
        data = (get_msg(mid, token) or {}).get('data') or {}
        delivered = data.get('raw_message')
        if delivered is None:
            results.append({'id': mid, 'delivered': None, 'model_raw': str(content)[:80], 'bracket': None})
            continue
        results.append({
            'id': mid,
            'delivered': delivered,
            'model_raw': str(content)[:80],
            'bracket': has_bracket(delivered),
        })

    checked = [r for r in results if r['bracket'] is not None]
    dirty = [r for r in checked if r['bracket']]

    if args.json:
        print(json.dumps({'key': key, 'checked': len(checked), 'bracket': len(dirty), 'items': results},
                         ensure_ascii=False, indent=2))
    else:
        for r in results:
            if r['bracket'] is None:
                print('SKIP     %-12s (get_msg 无数据) 模型原文=%s' % (r['id'], r['model_raw']))
                continue
            print('%-8s %-12s %s' % ('BRACKET' if r['bracket'] else 'clean', r['id'], str(r['delivered'])[:70]))
        print('checked=%d  bracket=%d  key=%s' % (len(checked), len(dirty), key))

    return 1 if dirty else 0


if __name__ == '__main__':
    sys.exit(main())
