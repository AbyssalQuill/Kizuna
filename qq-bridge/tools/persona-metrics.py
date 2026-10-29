#!/usr/bin/env python3
"""persona-metrics：每小时统计 QQ 桥人格行为指标（只读，不碰任何业务状态）。

数据源 : /root/.dsh/sessions/*/session-*/session.v4.jsonl.zstd
口径   : 一个「回合」= 会话里同一个 turn 编号的发送集合
         bubbles  本回合 qq_send_message 的气泡数合计
         single / double / triple   1 条 / 2 条 / 3 条以上的回合数
         chars    单条气泡平均字数
         bracket  出现（…）或 *…* 的回合数
         voice / meme   本回合 qq_send_voice / qq_send_meme 调用次数
         rejected 被守卫打回的发送次数（tool/result 含 Protocol violation）
输出   : state/persona-metrics.jsonl  每小时一行 JSON
         state/persona-metrics-state.json  累计 + 去重游标
用法   : python3 persona-metrics.py            # 增量统计一次（timer 调这个）
         python3 persona-metrics.py --report   # 只打印最近 24 行汇总
"""
import collections
import glob
import json
import os
import subprocess
import sys
import time

SESS_GLOB = '/root/.dsh/sessions/*/session-*/session.v4.jsonl.zstd'
STATE = '/root/qq-bridge/state/persona-metrics-state.json'
OUT = '/root/qq-bridge/state/persona-metrics.jsonl'
# 2026-10-29 00:47 +08（16:47 UTC）：Gemini 人设改动上线点，累计从这里开始
BOUNDARY = 1793206020000
FILE_CAP = 400
SEND_TOOLS = ('qq_send_message', 'qq_send_voice', 'qq_send_meme')


def read_zst(path):
    out = subprocess.run(['zstd', '-dc', path], capture_output=True)
    return out.stdout if out.returncode == 0 else b''


def scan(since_ms):
    files = [p for p in glob.glob(SESS_GLOB) if os.path.getmtime(p) * 1000 >= since_ms - 7200000]
    files.sort(key=os.path.getmtime, reverse=True)
    recs = []
    for path in files[:FILE_CAP]:
        data = read_zst(path)
        if not data:
            continue
        turns = {}
        for line in data.decode('utf-8', 'replace').splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except Exception:
                continue
            typ = ev.get('type')
            data_ = ev.get('data') or {}
            turn = data_.get('turn')
            if turn is None:
                continue
            # 发图失败：占位标记 [image_lost] 出现在任意事件里就记一次（不参与回合统计）
            if 'image_lost' in line:
                recs.append({'id': '%s#img%s' % (path, ev.get('seq')), 'ts': int(ev.get('time') or 0),
                             'images_lost': 1, 'image_only': True})
            key = (path, turn)
            if typ == 'tool/call':
                args = data_.get('arguments')
                try:
                    args = json.loads(args) if isinstance(args, str) else (args or {})
                except Exception:
                    args = {}
                inner = str(args.get('tool_name') or args.get('toolName') or '').strip()
                if inner not in SEND_TOOLS:
                    continue
                rec = turns.setdefault(key, {
                    'bubbles': 0, 'chars': 0, 'voice': 0, 'meme': 0,
                    'brackets': 0, 'rejected': 0, 'ts': 0})
                rec['ts'] = max(rec['ts'], int(ev.get('time') or 0))
                ti = args.get('tool_input') or {}
                if inner == 'qq_send_message':
                    msgs = ti.get('messages') or args.get('messages') or []
                    if isinstance(msgs, list):
                        rec['bubbles'] += len(msgs)
                        for m in msgs:
                            s = str(m)
                            rec['chars'] += len(s)
                            if ('\uff08' in s) or ('*' in s):
                                rec['brackets'] += 1
                elif inner == 'qq_send_voice':
                    rec['voice'] += 1
                else:
                    rec['meme'] += 1
            elif typ == 'tool/result':
                blob = json.dumps(data_, ensure_ascii=False)
                if 'Protocol violation' in blob:
                    turns.setdefault(key, {
                        'bubbles': 0, 'chars': 0, 'voice': 0, 'meme': 0,
                        'brackets': 0, 'rejected': 0, 'ts': 0})
                    turns[key]['rejected'] += 1
                    turns[key]['ts'] = max(turns[key]['ts'], int(ev.get('time') or 0))
        for (p, turn), rec in turns.items():
            if rec['ts'] <= 0:
                continue
            rec['id'] = '%s#%s' % (p, turn)
            recs.append(rec)
    return recs


BLANK = {'turns': 0, 'bubbles': 0, 'single': 0, 'double': 0, 'triple': 0,
         'chars': 0, 'bracket_turns': 0, 'voice': 0, 'meme': 0, 'rejected': 0, 'images_lost': 0}


def merge(total, recs):
    for r in recs:
        if r.get('image_only'):
            total['images_lost'] += 1
            continue
        total['turns'] += 1
        total['bubbles'] += r['bubbles']
        if r['bubbles'] == 1:
            total['single'] += 1
        elif r['bubbles'] == 2:
            total['double'] += 1
        elif r['bubbles'] >= 3:
            total['triple'] += 1
        if r['bubbles']:
            total['chars'] += r['chars'] / r['bubbles']
        if r['brackets']:
            total['bracket_turns'] += 1
        total['voice'] += r['voice']
        total['meme'] += r['meme']
        total['rejected'] += r['rejected']
    return total


def pct(a, b):
    return round(a * 100.0 / b, 1) if b else 0.0


def summarize(total):
    n = total['turns']
    return {
        'turns': n,
        'bubbles': round(total['bubbles'] / n, 2) if n else 0,
        'single_pct': pct(total['single'], n),
        'double_pct': pct(total['double'], n),
        'triple_pct': pct(total['triple'], n),
        'chars': round(total['chars'] / n, 1) if n else 0,
        'bracket_pct': pct(total['bracket_turns'], n),
        'voice_per_turn': round(total['voice'] / n, 2) if n else 0,
        'meme_per_turn': round(total['meme'] / n, 2) if n else 0,
        'rejected': total['rejected'],
        'image_lost': total.get('images_lost', 0),
    }


def load_state():
    try:
        with open(STATE, encoding='utf-8') as fh:
            return json.load(fh)
    except Exception:
        return {'lastRun': BOUNDARY, 'seen': [], 'cumulative': dict(BLANK)}


def save_state(state):
    tmp = STATE + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as fh:
        json.dump(state, fh, ensure_ascii=False)
    os.replace(tmp, STATE)


DEPLOY_MS = 1793257740000   # 2026-10-29 15:09 +08：正向人设 + 末端锚上线点


def compare():
    """改前 / 改后对照：按部署点切两段，两个窗口用同一套口径，最后给出差值。"""
    recent_h = 6
    for i, a in enumerate(sys.argv):
        if a == '--hours' and i + 1 < len(sys.argv):
            try:
                recent_h = max(1, int(sys.argv[i + 1]))
            except ValueError:
                pass
    recs = scan(0)
    floor = DEPLOY_MS - recent_h * 3600 * 1000
    old = [r for r in recs if floor <= r['ts'] < DEPLOY_MS]
    new = [r for r in recs if r['ts'] >= DEPLOY_MS]
    a = summarize(merge(dict(BLANK), old))
    b = summarize(merge(dict(BLANK), new))

    def line(name, x):
        return ('%-6s n=%3d 气泡%.2f 单%.0f%% 双%.0f%% 三+%.0f%% 字数%.1f 括号%.0f%% 语音%.2f 表情%.2f 打回%d 丢图%d'
                % (name, x['turns'], x['bubbles'], x['single_pct'], x['double_pct'], x['triple_pct'],
                   x['chars'], x['bracket_pct'], x['voice_per_turn'], x['meme_per_turn'],
                   x['rejected'], x.get('image_lost', 0)))

    print('部署点 2026-10-29 15:09 +08；改前窗口 = 部署前 %d 小时' % recent_h)
    print(line('改前', a))
    print(line('改后', b))
    if b['turns']:
        print('差值   n=%+d 气泡%+.2f 单气泡%+.1f 括号%+.1f 字数%+.1f 打回%+d'
              % (b['turns'] - a['turns'], b['bubbles'] - a['bubbles'],
                 b['single_pct'] - a['single_pct'], b['bracket_pct'] - a['bracket_pct'],
                 b['chars'] - a['chars'], b['rejected'] - a['rejected']))
        print('判定   括号%.0f%%→%.0f%%（目标 0）；单气泡%.0f%%→%.0f%%（目标 60~70%%）'
              % (a['bracket_pct'], b['bracket_pct'], a['single_pct'], b['single_pct']))
    else:
        print('改后还没有样本 —— 等真实回合进来再跑一次。')
    return 0


def report():
    rows = []
    try:
        with open(OUT, encoding='utf-8') as fh:
            rows = [json.loads(x) for x in fh if x.strip()]
    except FileNotFoundError:
        print('还没有统计记录：' + OUT)
        return 0
    print('最近 %d 次（每次=上一小时的增量）' % min(len(rows), 24))
    for r in rows[-24:]:
        w = r['window']
        print('  %s  n=%2d 气泡%.2f 单%.0f%% 双%.0f%% 三+%.0f%% 字数%.1f 括号%.0f%% 语音%.2f 表情%.2f 打回%d 丢图%d'
              % (r['at'][11:16], w['turns'], w['bubbles'], w['single_pct'], w['double_pct'],
                 w['triple_pct'], w['chars'], w['bracket_pct'], w['voice_per_turn'],
                 w['meme_per_turn'], w['rejected'], w.get('image_lost', 0)))
    c = rows[-1]['cumulative']
    print('累计（00:47 起） n=%d 气泡%.2f 单%.0f%% 双%.0f%% 三+%.0f%% 字数%.1f 括号%.0f%% 语音%.2f 表情%.2f 打回%d 丢图%d'
          % (c['turns'], c['bubbles'], c['single_pct'], c['double_pct'], c['triple_pct'],
             c['chars'], c['bracket_pct'], c['voice_per_turn'], c['meme_per_turn'], c['rejected'],
             c.get('image_lost', 0)))
    return 0


def main():
    if '--report' in sys.argv:
        return report()
    if '--compare' in sys.argv:
        return compare()
    state = load_state()
    now = int(time.time() * 1000)
    since = int(state.get('lastRun') or BOUNDARY)
    recs = scan(since)
    seen = set(state.get('seen') or [])
    fresh = []
    for r in recs:
        if r['ts'] < since or r['id'] in seen:
            continue
        fresh.append(r)
    window = merge(dict(BLANK), fresh)
    # 老 state 可能缺新加的字段（如 images_lost）→ 先用 BLANK 补齐再累加，否则定时器会 KeyError
    carry = dict(BLANK)
    carry.update({k: v for k, v in (state.get('cumulative') or {}).items() if k in BLANK})
    cumulative = merge(carry, fresh)
    line = {
        # 服务器是 UTC，统计一律用东八区时间，免得看报告时还要自己加 8 小时
        'at': time.strftime('%Y-%m-%dT%H:%M:%S+0800', time.gmtime(time.time() + 8 * 3600)),
        'window': summarize(window),
        'cumulative': summarize(cumulative),
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'a', encoding='utf-8') as fh:
        fh.write(json.dumps(line, ensure_ascii=False) + '\n')
    state['lastRun'] = now
    state['cumulative'] = cumulative
    state['seen'] = (state.get('seen') or [])[-4000:] + [r['id'] for r in fresh]
    save_state(state)
    j = line['window']
    print('window n=%d bubbles=%.2f single=%.0f%% double=%.0f%% chars=%.1f voice=%.2f meme=%.2f rejected=%d'
          % (j['turns'], j['bubbles'], j['single_pct'], j['double_pct'], j['chars'],
             j['voice_per_turn'], j['meme_per_turn'], j['rejected']))
    return 0


if __name__ == '__main__':
    sys.exit(main())
