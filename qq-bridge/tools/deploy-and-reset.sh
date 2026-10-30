#!/usr/bin/env bash
# 部署提示词类改动的标准动作（2026-10-30 起的工作纪律）
#
# 一条命令做完三件事：
#   1) 重启桥，让 preset / 唤醒正文的改动生效（preset 会重新合成并装到 ~/.dsh/.agent-presets）；
#   2) reset 所有会话 —— 系统提示词是建会话那刻烧进 history 的，不 reset 就等于没改；
#   3) 体检：读会话日志里实际投递的唤醒正文，确认 [style]/[tools]/[bubbles]/[anchor] 都在。
#
# 用法：bash tools/deploy-and-reset.sh
set -e
cd /root/qq-bridge

echo "[1/3] 重启 qq-bridge"
systemctl restart qq-bridge
sleep 8
systemctl is-active qq-bridge dsh-web napcat

echo "[2/3] reset 所有会话（保留唤醒配置与已回复账本）"
python3 tools/reset-sessions.py

echo "[3/3] 唤醒正文体检"
sleep 2
python3 tools/wake-body-check.py --limit 6 || true

echo "完成。下一步：等一条真实消息，再用 tools/turn-shape.py 复量。"
