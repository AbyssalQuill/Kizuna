#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Kizuna 网易云真实高赞神评爬取与高共情语料提炼器
------------------------------------------------
功能：
1. 抓取网易云深夜/治愈/民谣/高共情代表歌曲的热门评论（Hot Comments）；
2. 自动过滤广告、点赞打卡、无意义纯表情与格式垃圾；
3. 保留真实人类在深夜留下的真情实感、破碎感、细腻自白，提炼为高纯度 JSONL 语料池。
"""

import os
import re
import json
import time
import base64
import random
import urllib.request
import urllib.parse

# 精选最容易产生真实走心、深夜共情、细腻真情热评的网易云代表歌曲 ID
CURATED_TRACKS = [
    {"id": "28815250", "name": "理想三旬 - 陈鸿宇", "theme": "成年人的迷茫与漂泊"},
    {"id": "27591651", "name": "安和桥 - 宋冬野", "theme": "再也回不去的过往与遗憾"},
    {"id": "1330348068", "name": "起风了 - 买辣椒也用券", "theme": "青春逆光奔跑与告别"},
    {"id": "186016", "name": "晴天 - 周杰伦", "theme": "青春暗恋与藏在心底的名字"},
    {"id": "1413585838", "name": "海底 - 一支榴莲", "theme": "绝望时的温柔呼唤与托底"},
    {"id": "1313354324", "name": "写给黄淮 - 解忧邵帅", "theme": "大学时代笨拙又真挚的爱"},
    {"id": "1894094482", "name": "漠河舞厅 - 柳爽", "theme": "刻骨铭心的思念与生死相隔"},
    {"id": "32507038", "name": "成都 - 赵雷", "theme": "走走停停的异乡人日常"},
    {"id": "139774", "name": "The Truth That You Leave", "theme": "纯音乐下真实自白的树洞"},
    {"id": "1456890009", "name": "世间美好与你环环相扣 - 柏松", "theme": "温柔治愈与重拾希望"}
]

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Referer": "https://music.163.com/",
    "Accept": "*/*",
    "Accept-Language": "zh-CN,zh;q=0.9"
}

def is_meaningful_comment(content: str) -> bool:
    """过滤垃圾评论：广告、复制粘贴、打卡、单纯求赞"""
    if not content or len(content.strip()) < 12:
        return False
    if len(content) > 300: # 剔除过长的小说体
        return False
    # 过滤明显的营销/打卡词汇
    ban_patterns = [
        r"关注我", r"互关", r"打卡", r"第.*条", r"听歌的第.*天", 
        r"双击", r"微信", r"加v", r"vx", r"考研加油", r"高考加油",
        r"上热评", r"赞我", r"捞我", r"复制粘贴"
    ]
    for pat in ban_patterns:
        if re.search(pat, content):
            return False
    return True

def fetch_comments_via_api(song_id: str, offset: int = 0, limit: int = 40):
    """通过开放公共代理接口抓取评论"""
    url = f"https://music.163.com/api/v1/resource/comments/R_SO_4_{song_id}?limit={limit}&offset={offset}"
    req = urllib.request.Request(url, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=8) as response:
            data = json.loads(response.read().decode('utf-8'))
            return data
    except Exception as e:
        # print(f"抓取歌曲 {song_id} 异常: {e}")
        return None

def collect_comments(target_count=300):
    """批量抓取并写入语料库"""
    output_dir = os.path.join(os.path.dirname(__file__), "..", "state", "raw_comments")
    os.makedirs(output_dir, exist_ok=True)
    output_file = os.path.join(output_dir, "netease_heartfelt_comments.jsonl")

    collected = []
    seen = set()

    print(f"[*] 开始从网易云音乐代表曲目中抽取真实走心高赞评论（目标: {target_count} 条）...")

    for track in CURATED_TRACKS:
        if len(collected) >= target_count:
            break
        print(f" -> 正在挖掘: 【{track['name']}】({track['theme']})")
        
        # 爬取热评与前几页最新有感而发的评论
        for offset in [0, 20, 40, 60]:
            if len(collected) >= target_count:
                break
            res = fetch_comments_via_api(track["id"], offset=offset, limit=30)
            if not res or "hotComments" not in res:
                # 尝试普通 comments
                comments = res.get("comments", []) if res else []
            else:
                comments = res.get("hotComments", []) + res.get("comments", [])

            for c in comments:
                content = c.get("content", "").strip()
                liked = c.get("likedCount", 0)
                user = c.get("user", {}).get("nickname", "路人")
                cid = c.get("commentId", "")

                if content and cid not in seen and is_meaningful_comment(content):
                    seen.add(cid)
                    entry = {
                        "song": track["name"],
                        "theme": track["theme"],
                        "author": user,
                        "liked_count": liked,
                        "raw_comment": content
                    }
                    collected.append(entry)

            time.sleep(random.uniform(0.6, 1.2)) # 温和礼貌延时

    # 写入 JSONL 文件
    with open(output_file, "w", encoding="utf-8") as f:
        for item in collected:
            f.write(json.dumps(item, ensure_ascii=False) + "\n")

    print(f"[+] 采集完成！成功收集 {len(collected)} 条高质量真实网易云走心评论。")
    print(f"[+] 文件已保存至: {output_file}")
    return collected

if __name__ == "__main__":
    collect_comments(150)
