#!/usr/bin/env python3
"""唤醒正文体检：确认每轮真正发给模型的正文里，几个必需的指引行在不在。

为什么需要这个工具（2026-10-30 的教训）：
  [style]/[tools]/[bubbles]/[turn] 这几行一开始写在 buildWakePrompt 里，
  而那个函数**只在"首次注入完整 prompt"时调用**；日常每一轮走的是哨兵分支，
  于是这些要求一整天没送到模型面前 —— 表现出来就是"要求都没执行"，
  而日志里一切正常、没有任何报错。这个脚本就是防这类"静默漏注入"。

用法：
  python3 tools/wake-body-check.py            # 看最近 10 条唤醒正文
  python3 tools/wake-body-check.py --limit 30 --key group:
"""
import argparse
import glob
import json
import os
import subprocess

DEFAULT_WORKSPACE = 'root-qq-bridge-state-agents'
REQUIRED = ['[style]', '[tools]', '[bubbles]', '[anchor]']
# 群聊 anyMessage 唤醒还必须有这一行；其它唤醒没有是正常的
CONDITIONAL = {'[turn]': 'anyMessage'}


def text_of(obj):
    if isinstance(obj, dict):
        if obj.get('type') == 'text':
            return obj.get('text', '')
        return ' '.join(text_of(v) for v in obj.values())
    if isinstance(obj, list):
        return ' '.join(text_of(v) for v in obj)
    return ''


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--limit', type=int, default=10)
    ap.add_argument('--key', default='', help='只看某个会话（group: / private:）')
    a = ap.parse_args()

    root = os.path.expanduser('~/.dsh/sessions')
    pats = sorted(glob.glob(os.path.join(root, '*' + DEFAULT_WORKSPACE + '*', 'session-*/session.v4.jsonl.zstd')),
                  key=os.path.getmtime, reverse=True)[:4]
    bodies = []
    for p in pats:
        raw = subprocess.run(['zstd', '-dc', p], capture_output=True).stdout.decode('utf-8', 'replace')
        for line in raw.splitlines():
            if '"user/message"' not in line:
                continue
            try:
                rec = json.loads(line)
            except Exception:
                continue
            s = text_of(rec.get('data'))
            if '[Token]' not in s or '[Session]' not in s:
                continue
            # 只查"真正的唤醒正文"：哨兵提醒（[Reminder] 轮）走的是另一条拼装路径，不该按同一套判据
            if '[Wake ' not in s:
                continue
            bodies.append((rec.get('time') or 0, s))
    bodies.sort(key=lambda x: x[0])
    if a.key:
        bodies = [b for b in bodies if a.key in (b[1].split('[Session] ')[1].split('\n')[0] if '[Session] ' in b[1] else '')]
    bodies = bodies[-a.limit:]
    if not bodies:
        print('没有唤醒正文可查')
        return 1
    bad = 0
    for ts, s in bodies:
        head = s.split('\n')[0:3]
        missing = [m for m in REQUIRED if m not in s]
        conditional = [m for m, need in CONDITIONAL.items() if need in s and m not in s]
        if missing or conditional:
            bad += 1
            print('FAIL', ' | '.join(head), '缺:', ','.join(missing + conditional))
        else:
            print('PASS', ' | '.join(head))
    print('---')
    print('%d 条正文，%d 条缺必需行' % (len(bodies), bad))
    return 0 if bad == 0 else 1


if __name__ == '__main__':
    raise SystemExit(main())
