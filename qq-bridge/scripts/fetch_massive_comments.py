#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Kizuna 万级网易云真实热评大规模抓取流水线
------------------------------------------
支持从网易云官方精选歌单（热歌榜、民谣榜、深夜伤感情感歌单等）
全自动批量挖掘数万条真实高赞评论。
"""

import os
import json
import time
import random
import re
import urllib.request

# 核心精选歌单（涵盖：网易云深夜放映室、万赞热评合集、治愈民谣、华语伤感等）
PLAYLIST_COLLECTIONS = [
    {"id": "3778678", "name": "网易云音乐热歌榜"},
    {"id": "2884035", "name": "网易原创歌曲榜"},
    {"id": "505964270", "name": "网易云十万加评论神曲"},
    {"id": "3112527582", "name": "深夜 emo 与温柔救赎"},
    {"id": "24381616", "name": "民谣故事与人间烟火"}
]

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Referer": "https://music.163.com/",
    "Accept": "*/*"
}

def clean_comment(text):
    if not text or len(text.strip()) < 15 or len(text) > 280:
        return None
    # 过滤明显的打卡刷赞垃圾
    if re.search(r"打卡|互关|关注|求赞|第.*天|考研加油|高考加油|微信|复制粘贴", text):
        return None
    return text.strip()

def fetch_playlist_tracks(playlist_id):
    """获取歌单中的歌曲列表"""
    url = f"https://music.163.com/api/v6/playlist/detail?id={playlist_id}"
    req = urllib.request.Request(url, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            tracks = data.get("playlist", {}).get("trackIds", [])
            return [str(t["id"]) for t in tracks[:50]] # 每个歌单取前50首经典
    except Exception as e:
        return []

def fetch_song_hot_comments(song_id, limit=30):
    url = f"https://music.163.com/api/v1/resource/comments/R_SO_4_{song_id}?limit={limit}&offset=0"
    req = urllib.request.Request(url, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode('utf-8'))
            hots = data.get("hotComments", [])
            commons = data.get("comments", [])
            return hots + commons
    except:
        return []

def massive_mine(target_count=1000):
    out_dir = os.path.join(os.path.dirname(__file__), "..", "state", "raw_comments")
    os.makedirs(out_dir, exist_ok=True)
    out_file = os.path.join(out_dir, "massive_netease_raw.jsonl")

    seen = set()
    total_saved = 0

    print(f"[*] 启动网易云万级评论流水线挖掘（当前批次目标: {target_count} 条）...")

    with open(out_file, "a", encoding="utf-8") as f:
        for pl in PLAYLIST_COLLECTIONS:
            if total_saved >= target_count:
                break
            print(f" -> 正在解析歌单: 【{pl['name']}】...")
            song_ids = fetch_playlist_tracks(pl["id"])
            print(f"    共获取到 {len(song_ids)} 首候选歌曲，开始深挖热评...")

            for sid in song_ids:
                if total_saved >= target_count:
                    break
                comments = fetch_song_hot_comments(sid, limit=40)
                for c in comments:
                    cid = c.get("commentId")
                    content = clean_comment(c.get("content", ""))
                    if content and cid and cid not in seen:
                        seen.add(cid)
                        row = {
                            "cid": cid,
                            "liked": c.get("likedCount", 0),
                            "author": c.get("user", {}).get("nickname", "匿名"),
                            "content": content
                        }
                        f.write(json.dumps(row, ensure_ascii=False) + "\n")
                        total_saved += 1
                        if total_saved % 50 == 0:
                            print(f"    已累计入库优质真实热评: {total_saved} 条...")
                
                time.sleep(random.uniform(0.4, 0.8)) # 平滑防封

    print(f"[+] 本批次采集完成！累计成功落盘 {total_saved} 条真实网易云走心评论至: {out_file}")

if __name__ == "__main__":
    massive_mine(500)
