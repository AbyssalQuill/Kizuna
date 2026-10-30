#!/usr/bin/env python3
"""合并窗预演（目标轮用）：拿真实历史回合，算「如果按合并策略发」会变成什么样。

合并策略（候选，尚未上线）：
  · 一个回合里的**纯文本**气泡才参与；
  · 每句都不长（<= max_each 字）且合计 <= max_total 字 → 合成一条（用空格连）；
  · 任一句带问号/@/引用/CQ 码 → 不合并（那是有指向性的，合并会丢语义）；
  · 合并后仍超 max_total → 按顺序两两合并，最多留 2 条。

为什么先预演而不是直接上线：线上是「一条气泡一次工具调用」，真合并要改成跨调用合并窗，
会牵动发送节拍与引用归属；先用历史数据算清楚收益，再决定要不要动发送链。
"""
import argparse
import importlib.util
import os
import re
from datetime import datetime, timedelta, timezone

BJ = timezone(timedelta(hours=8))
HERE = os.path.dirname(os.path.abspath(__file__))
NORTH = re.compile(r'[?？]')
QUOTE = re.compile(r'@|\[CQ:|\[引用')


def load_turn_shape():
    spec = importlib.util.spec_from_file_location('turn_shape', os.path.join(HERE, 'turn-shape.py'))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def merge_turn(bubbles, max_each=30, max_total=30):
    if len(bubbles) < 2:
        return bubbles
    if any(NORTH.search(b) or QUOTE.search(b) for b in bubbles):
        return bubbles
    total = sum(len(b) for b in bubbles)
    if total > max_total:
        return bubbles
    return [' '.join(bubbles)]


def stats(rows):
    n = len(rows)
    if not n:
        return None
    total_b = sum(len(r) for r in rows)
    total_c = sum(sum(len(x) for x in r) for r in rows)
    single = sum(1 for r in rows if len(r) == 1)
    return dict(n=n, per_turn=total_b / n, single_pct=100 * single / n, chars=total_c / max(total_b, 1))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--hours', type=int, default=24)
    ap.add_argument('--key', default='')
    ap.add_argument('--max-each', type=int, default=30)
    ap.add_argument('--max-total', type=int, default=30)
    ap.add_argument('--show', type=int, default=3)
    a = ap.parse_args()

    ts_mod = load_turn_shape()
    since = int((datetime.now(BJ) - timedelta(hours=a.hours)).timestamp() * 1000)
    rows = []
    for p in ts_mod.sessions_for(None)[:6]:
        rows.extend(ts_mod.collect(p, since))
    rows = [r for r in rows if r['bubbles']]
    if a.key:
        rows = [r for r in rows if r.get('key') == a.key]
    rows.sort(key=lambda r: r['ts'] or 0)
    if not rows:
        print('没有回合')
        return

    before = [r['bubbles'] for r in rows]
    after = [merge_turn(r['bubbles'], a.max_each, a.max_total) for r in rows]
    sb = stats(before)
    sa = stats(after)
    print('策略：每句 <=%d 字、合计 <=%d 字、无问号/@/引用 → 合成一条' % (a.max_each, a.max_total))
    print('  现状   回合 %d | 每回合 %.2f | 单气泡 %.0f%% | 单条均字 %.1f' % (sb['n'], sb['per_turn'], sb['single_pct'], sb['chars']))
    print('  预演后 回合 %d | 每回合 %.2f | 单气泡 %.0f%% | 单条均字 %.1f' % (sa['n'], sa['per_turn'], sa['single_pct'], sa['chars']))
    changed = sum(1 for b, x in zip(before, after) if len(b) != len(x))
    print('  会改写的回合：%d / %d' % (changed, len(rows)))
    shown = 0
    for b, x in zip(before, after):
        if len(b) != len(x) and shown < a.show:
            print('  --- 例 %d' % (shown + 1))
            print('    原：', ' | '.join(b)[:160])
            print('    合：', x[0][:160])
            shown += 1


if __name__ == '__main__':
    main()
