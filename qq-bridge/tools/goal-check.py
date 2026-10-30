#!/usr/bin/env python3
"""目标计分卡：把「像真人打字」的六条判据一次算出来，逐条 PASS/FAIL。

判据（来自 goal-67cf8c18）：
  1. 单气泡占比 >= 55%
  2. 平均每回合气泡 1.2 ~ 2.2
  3. 单条均字数 8 ~ 18
  4. 动作括号率 == 0（按**发出去的**气泡判，用 audit-delivered）
  5. 被打回 <= 1/天（桥的协议守卫日志）
  6. 不复述自己上一句（相邻回合首句相似度 >= 0.6 的比例）

用法：
  python3 tools/goal-check.py                 # 最近 24h 的日志 + 最近 30 个回合
  python3 tools/goal-check.py --hours 6 --key private:1736784911
"""
import argparse
import difflib
import importlib.util
import json
import os
import re
import subprocess
from datetime import datetime, timedelta, timezone

BJ = timezone(timedelta(hours=8))
HERE = os.path.dirname(os.path.abspath(__file__))


def load_turn_shape():
    spec = importlib.util.spec_from_file_location('turn_shape', os.path.join(HERE, 'turn-shape.py'))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def journal_count(pattern, hours):
    try:
        out = subprocess.run(['journalctl', '-u', 'qq-bridge', '--since', '-%dh' % hours, '--no-pager'],
                             capture_output=True, text=True, timeout=120).stdout
    except Exception:
        return None
    return len(re.findall(pattern, out))


def delivered_bracket(limit):
    try:
        out = subprocess.run(['python3', os.path.join(HERE, 'audit-delivered.py'), '--limit', str(limit)],
                             capture_output=True, text=True, timeout=300).stdout
    except Exception:
        return None
    m = re.search(r'checked=(\d+)\s+bracket=(\d+)', out)
    return (int(m.group(1)), int(m.group(2))) if m else None


HISTORY = os.path.join(HERE, '..', 'state', 'goal-history.jsonl')


def append_history(rec):
    os.makedirs(os.path.dirname(HISTORY), exist_ok=True)
    with open(HISTORY, 'a', encoding='utf-8') as f:
        f.write(json.dumps(rec, ensure_ascii=False) + '\n')


def streak():
    """按东八区日期，看最近几天是不是「全天最后一条记录六项全过」。"""
    if not os.path.exists(HISTORY):
        print('还没有历史记录（先跑一次 --append）')
        return
    by_day = {}
    with open(HISTORY, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except Exception:
                continue
            day = (rec.get('at') or '')[:10]
            if day:
                by_day[day] = rec
    days = sorted(by_day)
    if not days:
        print('历史为空')
        return
    for d in days[-5:]:
        r = by_day[d]
        print('  %s  %s  单气泡 %.0f%% | 每回合 %.2f | 均字 %.1f | 括号 %s | 打回 %s | 丢图 %s | 复述 %.0f%%'
              % (d, 'PASS' if r.get('all_pass') else 'FAIL', r.get('single_pct', 0), r.get('per_turn', 0),
                 r.get('chars', 0), r.get('bracket_ok'), r.get('reject'), r.get('lost'), r.get('dup_pct', 0)))
    run = 0
    for d in reversed(days):
        if by_day[d].get('all_pass'):
            run += 1
        else:
            break
    print('  连续全过天数：%d（目标 3）' % run)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--hours', type=int, default=24)
    ap.add_argument('--key', default='')
    ap.add_argument('--limit', type=int, default=30)
    ap.add_argument('--append', action='store_true', help='把这次读数追加进 state/goal-history.jsonl')
    ap.add_argument('--streak', action='store_true', help='只看历史：最近几天的通过情况与连续天数')
    a = ap.parse_args()
    if a.streak:
        streak()
        return

    ts_mod = load_turn_shape()
    rows = []
    for p in ts_mod.sessions_for(None)[:6]:
        rows.extend(ts_mod.collect(p, int((datetime.now(BJ) - timedelta(hours=a.hours)).timestamp() * 1000)))
    rows = [r for r in rows if r['bubbles']]
    if a.key:
        rows = [r for r in rows if r.get('key') == a.key]
    rows.sort(key=lambda r: r['ts'] or 0)

    n = len(rows)
    total_b = sum(len(r['bubbles']) for r in rows)
    total_c = sum(sum(len(x) for x in r['bubbles']) for r in rows)
    single = sum(1 for r in rows if len(r['bubbles']) == 1)
    per_turn = total_b / n if n else 0
    chars = total_c / total_b if total_b else 0
    single_pct = 100 * single / n if n else 0

    # 复述：相邻两个回合的首句相似度
    dup = 0
    for i in range(1, n):
        prev = rows[i - 1]['bubbles'][0]
        cur = rows[i]['bubbles'][0]
        if difflib.SequenceMatcher(None, prev, cur).ratio() >= 0.6:
            dup += 1
    dup_pct = 100 * dup / max(n - 1, 1)

    bracket = delivered_bracket(60)
    reject = journal_count(r'协议违规|Protocol violation|打回', a.hours)
    lost = journal_count(r'\[image_lost\]', a.hours)

    print('时间窗 %dh | 回合 %d | 关键：%s' % (a.hours, n, a.key or '全部'))
    def line(name, value, ok, target):
        print('  %-14s %-22s %s   (目标 %s)' % (name, value, 'PASS' if ok else 'FAIL', target))
    line('单气泡占比', '%.0f%%' % single_pct, single_pct >= 55, '>=55%')
    line('每回合气泡', '%.2f' % per_turn, 1.2 <= per_turn <= 2.2, '1.2~2.2')
    line('单条均字数', '%.1f' % chars, 8 <= chars <= 18, '8~18')
    # 2026-10-30 主人取消括号剥离 —— 括号不再作为判据，只作信息行显示
    if bracket:
        print('  %-14s %-22s (仅信息，不判)' % ('交付括号', '%d/%d 条' % (bracket[1], bracket[0])))
    if reject is not None:
        line('被打回/天', str(reject), reject <= max(1, a.hours // 24), '<=1')
    if lost is not None:
        line('丢图', str(lost), lost == 0, '=0')
    line('复述上一句', '%.0f%%' % dup_pct, dup_pct < 10, '<10%')

    ok_shape = single_pct >= 55 and 1.2 <= per_turn <= 2.2 and 8 <= chars <= 18
    ok_bracket = True   # 括号判据已取消（2026-10-30）
    ok_reject = (reject <= max(1, a.hours // 24)) if reject is not None else False
    ok_lost = (lost == 0) if lost is not None else False
    ok_dup = dup_pct < 10
    all_pass = all([ok_shape, ok_bracket, ok_reject, ok_lost, ok_dup])
    print('  => %s' % ('ALL PASS' if all_pass else 'NOT YET'))
    if a.append:
        append_history({
            'at': datetime.now(BJ).strftime('%Y-%m-%d %H:%M:%S'),
            'hours': a.hours, 'key': a.key, 'n': n,
            'single_pct': round(single_pct, 1), 'per_turn': round(per_turn, 2), 'chars': round(chars, 1),
            'bracket_checked': bracket[0] if bracket else None, 'bracket_bad': bracket[1] if bracket else None,
            'bracket_ok': ok_bracket, 'reject': reject, 'lost': lost,
            'dup_pct': round(dup_pct, 1), 'all_pass': all_pass,
        })


if __name__ == '__main__':
    main()
