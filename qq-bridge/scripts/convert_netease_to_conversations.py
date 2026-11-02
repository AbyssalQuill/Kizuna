#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
网易云真实热评 -> Kizuna 高共情多气泡对话语料转换器
--------------------------------------------------
将网易云爬取到的真实人类元评论，自动构造成即时通讯中
'用户深夜倾诉' -> '高共情灵动多气泡托底' 的真实训练对。
"""

import os
import json
import re

RAW_FILE = os.path.join(os.path.dirname(__file__), "..", "state", "raw_comments", "netease_heartfelt_comments.jsonl")
OUTPUT_FILE = os.path.join(os.path.dirname(__file__), "..", "state", "raw_comments", "curated_train_dataset.jsonl")

def clean_comment_text(text: str) -> str:
    # 规范换行与空字符
    lines = [line.strip() for line in text.split("\n") if line.strip()]
    return "，".join(lines) if len(lines) <= 3 else " ".join(lines)

def build_prompt_pairs():
    if not os.path.exists(RAW_FILE):
        print("未找到爬取文件，请先运行 fetch_netease_comments.py")
        return

    with open(RAW_FILE, "r", encoding="utf-8") as f:
        items = [json.loads(line) for line in f]

    print(f"[*] 正在从 {len(items)} 条真实网易云评论中提取高共情情感片段...")

    # 我们将真实评论作为生成对话的真实输入
    pairs = []
    for item in items:
        raw = clean_comment_text(item["raw_comment"])
        if len(raw) < 20 or len(raw) > 200:
            continue
        
        pairs.append({
            "source_song": item["song"],
            "theme": item["theme"],
            "real_human_expression": raw
        })

    print(f"[+] 筛选出 {len(pairs)} 条适合转化为即时通讯深度对话的真实心声种子！")
    return pairs

if __name__ == "__main__":
    build_prompt_pairs()
