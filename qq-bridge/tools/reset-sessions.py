#!/usr/bin/env python3
"""把所有会话重置到"下一条消息重建"（工作纪律：改完提示词/预设必须跑它）。

为什么是纪律而不是可选项（2026-10-30）：
  系统提示词（preset）在建会话那一刻烧进 history，之后改文件、重启 dsh-web 都不会回灌。
  因此"提示词改了却没生效"是默认结局；不 reset 就等于白改。今天为此浪费了整整一个上午。

做的是 /api/session/reset（逐个 key），**不动** social-state：唤醒配置、名单、账本全部保留。
不用的：/api/social/reset（那个会清会话上下文 + 唤醒配置，之前误用过一次）。
"""
import json
import urllib.request

BASE = 'http://127.0.0.1:3100'
STATE = '/root/qq-bridge/state/sessions.json'
SOCIAL = '/root/qq-bridge/state/social-state.json'


def post(path, body):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode(),
                                 headers={'content-type': 'application/json'}, method='POST')
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def main():
    try:
        mapped = json.load(open(STATE)).get('sessions', {})
    except Exception:
        mapped = {}
    try:
        conv = json.load(open(SOCIAL)).get('conversations', {})
    except Exception:
        conv = {}
    keys = sorted(set(list(mapped.keys()) + list(conv.keys())))
    ok, skip = 0, 0
    for k in keys:
        try:
            d = post('/api/session/reset', {'key': k})
            if d.get('archived'):
                ok += 1
                print('reset ', k, '-> archived', d['archived'])
            else:
                skip += 1
                print('skip  ', k, '(没有会话映射)')
        except Exception as e:
            print('fail  ', k, str(e)[:80])
    print('---')
    print('重置 %d 个，跳过 %d 个（共 %d）' % (ok, skip, len(keys)))


if __name__ == '__main__':
    main()
