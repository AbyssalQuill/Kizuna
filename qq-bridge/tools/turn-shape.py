#!/usr/bin/env python3
"""回合形状统计（目标轮专用）：每个回合发了几条气泡、每条多长、单气泡占比、相邻气泡的雷同率。

为什么另写一个：tools/persona-metrics.py 的口径是"说"，按发送事件与回合的对应关系统计；
这边直接数 tool/call 里 qq_send_message / qq_reply 的 messages 数组，逐条计数 ——
目标里的"单气泡占比 ≥55%、每条 8~18 字"判的是**发出去的气泡本身**，用这个口径更贴。

用法：
  python3 tools/turn-shape.py                # 最近 30 个回合
  python3 tools/turn-shape.py --since 2026-10-30 08:40
  python3 tools/turn-shape.py --key private:1736784911 --limit 50
"""
import argparse
import difflib
import glob
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone

BJ = timezone(timedelta(hours=8))


# 只数 QQ 私聊/群聊那条工作区（辅助 agent 的 persona/slang 会话来掺和会把回合号搅乱）
DEFAULT_WORKSPACE = 'root-qq-bridge-state-agents'


def sessions_for(workspace=None):
    root = os.path.expanduser('~/.dsh/sessions')
    ws = workspace or DEFAULT_WORKSPACE
    pats = sorted(glob.glob(os.path.join(root, '*' + ws + '*', 'session-*/session.v4.jsonl.zstd')),
                  key=os.path.getmtime, reverse=True)
    return pats


def text_of(obj):
    if isinstance(obj, dict):
        if obj.get('type') == 'text':
            return obj.get('text', '')
        return ' '.join(text_of(v) for v in obj.values())
    if isinstance(obj, list):
        return ' '.join(text_of(v) for v in obj)
    return ''


def collect(path, since_ms):
    raw = subprocess.run(['zstd', '-dc', path], capture_output=True).stdout.decode('utf-8', 'replace')
    turns = []
    turn = None
    ts = None
    bubbles = []
    turn_key = ['']
    keyed = []
    for line in raw.splitlines():
        if not line.strip():
            continue
        try:
            rec = json.loads(line)
        except Exception:
            continue
        t = rec.get('type')
        if t == 'turn/start':
            if turn is not None and ts and ts >= since_ms:
                turns.append({'turn': turn, 'ts': ts, 'bubbles': bubbles, 'key': turn_key[0]})
            turn = (rec.get('data') or {}).get('turn')
            ts = rec.get('time')
            bubbles = []
            turn_key = ['']
            continue
        if t == 'tool/call':
            d = rec.get('data') or {}
            try:
                args = json.loads(d.get('arguments') or '{}')
            except Exception:
                args = {}
            name = str(args.get('tool_name') or d.get('name') or '').split('__')[-1]
            # 文本气泡的三种发法都算：qq_send_message / qq_send_group_message / qq_send_private_message / qq_reply
            if not (name in ('qq_send_message', 'qq_send_group_message', 'qq_send_private_message', 'qq_reply')
                    or 'qq_send_message' in name or 'qq_reply' in name):
                continue
            ti = args.get('tool_input') or {}
            k = ti.get('key')
            if isinstance(k, str) and k:
                turn_key[0] = k
            # 三种字段名都见过：message（单条字符串）/ messages（数组）/ text
            for field in ('messages', 'text', 'message'):
                v = ti.get(field)
                items = [v] if isinstance(v, str) else ([str(x) for x in v] if isinstance(v, list) else [])
                for item in items:
                    if isinstance(item, str) and item.strip():
                        bubbles.append(item.strip())
    if turn is not None and ts and ts >= since_ms:
        turns.append({'turn': turn, 'ts': ts, 'bubbles': bubbles, 'key': turn_key[0]})
    return turns


def summarize(rows, prefix=''):
    n = len(rows)
    if not n:
        print(prefix + '没有回合')
        return
    total_b = sum(len(r['bubbles']) for r in rows)
    total_c = sum(sum(len(x) for x in r['bubbles']) for r in rows)
    single = sum(1 for r in rows if len(r['bubbles']) == 1)
    dup = 0
    dup_den = 0
    for r in rows:
        b = r['bubbles']
        for i in range(len(b) - 1):
            dup_den += 1
            if difflib.SequenceMatcher(None, b[i], b[i + 1]).ratio() >= 0.6:
                dup += 1
    print(prefix + '回合 %d | 气泡合计 %d | 每回合 %.2f | 单气泡 %d/%d = %.0f%% | 单条均字数 %.1f | 相邻雷同 %d/%d'
          % (n, total_b, total_b / n, single, n, 100 * single / n, total_c / max(total_b, 1), dup, dup_den))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--since', default='')
    ap.add_argument('--limit', type=int, default=30)
    ap.add_argument('--session', default='', help='指定 session 文件（默认扫描最新几个）')
    ap.add_argument('--workspace', default='', help='工作区目录关键字（默认 ' + DEFAULT_WORKSPACE + '）')
    ap.add_argument('--key', default='', help='只看某个会话（group:xxx / private:xxx）')
    ap.add_argument('--compare', default='', help='给出分界时刻（东八区 "YYYY-MM-DD HH:MM"），分别打印改动前 / 改动后')
    a = ap.parse_args()
    since_ms = 0
    if a.since:
        since_ms = int(datetime.strptime(a.since, '%Y-%m-%d %H:%M').replace(tzinfo=BJ).timestamp() * 1000)
        # 2026-10-30：踩过一次「把 --since 写成未来时间」，结果是"没有回合可统计"这种假空窗。
        future = (since_ms - datetime.now(BJ).timestamp() * 1000) / 60000
        if future > 1:
            print('⚠️  --since 比当前时间还晚 %.0f 分钟（当前 %s 东八区），这个窗口不可能是空的，先确认时间。'
                  % (future, datetime.now(BJ).strftime('%m-%d %H:%M')))
    paths = [a.session] if a.session else sessions_for(a.workspace)[:4]
    rows = []
    for p in paths:
        rows.extend(collect(p, since_ms))
    rows = [r for r in rows if r['bubbles']]        # 没发消息的回合（只读不发的）不计
    if a.key:
        rows = [r for r in rows if r.get('key') == a.key]
    if a.compare:
        cut = int(datetime.strptime(a.compare, '%Y-%m-%d %H:%M').replace(tzinfo=BJ).timestamp() * 1000)
        before = [r for r in rows if (r['ts'] or 0) < cut]
        after = [r for r in rows if (r['ts'] or 0) >= cut]
        print('分界：%s（东八区）' % a.compare)
        summarize(before, '  改动前  ')
        summarize(after, '  改动后  ')
        return
    rows.sort(key=lambda r: r['ts'] or 0)
    rows = rows[-a.limit:]
    if not rows:
        print('没有回合可统计（since=%s）' % (a.since or '不限'))
        return
    total_b = 0
    total_c = 0
    single = 0
    dup = 0
    dup_den = 0
    print('%s' % '时间'.ljust(8), '回合', '气泡', '字数')
    for r in rows:
        b = r['bubbles']
        total_b += len(b)
        total_c += sum(len(x) for x in b)
        if len(b) == 1:
            single += 1
        for i in range(len(b) - 1):
            dup_den += 1
            if difflib.SequenceMatcher(None, b[i], b[i + 1]).ratio() >= 0.6:
                dup += 1
        when = datetime.fromtimestamp((r['ts'] or 0) / 1000, BJ).strftime('%m-%d %H:%M')
        print(when.ljust(12), str(r['turn']).rjust(4), str(len(b)).rjust(4), str(sum(len(x) for x in b)).rjust(4), (r.get('key') or '')[:18])
    n = len(rows)
    print('---')
    print('回合 %d | 气泡合计 %d | 每回合 %.2f | 单气泡 %d/%d = %.0f%% | 单条均字数 %.1f | 相邻雷同 %d/%d'
          % (n, total_b, total_b / n, single, n, 100 * single / n, total_c / max(total_b, 1), dup, dup_den))


if __name__ == '__main__':
    main()
