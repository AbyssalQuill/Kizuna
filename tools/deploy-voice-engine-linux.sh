#!/usr/bin/env bash
# 把 Genie TTS 语音引擎单独部署到一台 Linux 服务器（systemd 常驻 127.0.0.1:4610）。
#
# 为什么要单独部署：QQ 桥跑在服务器上时，语音合成也在服务器上做；
# 桥的 genie-tts.js 会先探 127.0.0.1:4610 的健康检查 —— 只要那儿已经有一个引擎在跑，
# 它就直接复用，不会再去 spawn 本机 python（见 ensureServer()）。所以引擎可以完全独立部署。
#
# 硬指标（2026-10-24 实测本机引擎得出）：
#   · 磁盘：models 964MB（三角色）＋ GenieData 约 390MB ＋ venv 约 600MB ≈ 2GB
#   · 内存：加载一个角色后峰值到过 4.4GB（onnxruntime）；建议 8GB 机器，至少 4GB + swap
#   · Python：3.11 / 3.12（3.13+ 的 onnxruntime / genie-tts 轮子还不齐，3.14 装不上）
#   · CPU：1 核可用，但首次合成含模型加载约 36s，之后每句数秒
#
# 用法：
#   SRC=/path/to/qq-bridge/python bash deploy-voice-engine-linux.sh
#   SRC 指向装有 genie_server.py / genie_compat.py / GenieData/ / models/ 的目录。
set -euo pipefail

APP_DIR=${APP_DIR:-/opt/kizuna-voice}
PY=${PY:-python3.12}
SRC=${SRC:-}
PORT=${PORT:-4610}

[ -n "$SRC" ] || { echo "用法：SRC=<qq-bridge/python 目录> bash $0" >&2; exit 2; }
[ -f "$SRC/genie_server.py" ] || { echo "SRC 里没有 genie_server.py：$SRC" >&2; exit 2; }
[ -d "$SRC/GenieData" ] || echo "警告：$SRC/GenieData 不存在，引擎会因缺公共数据起不来" >&2
command -v "$PY" >/dev/null || { echo "找不到 $PY（需要 Python 3.11/3.12）" >&2; exit 2; }

echo "== 1) 落地引擎文件到 $APP_DIR"
mkdir -p "$APP_DIR"
cp -f "$SRC/genie_server.py" "$SRC/genie_compat.py" "$APP_DIR/"
for d in GenieData models; do
  if [ -d "$SRC/$d" ]; then
    mkdir -p "$APP_DIR/$d"
    rsync -a --delete "$SRC/$d/" "$APP_DIR/$d/" || cp -r "$SRC/$d/." "$APP_DIR/$d/"
  fi
done

echo "== 2) 建 venv 并装依赖（genie-tts + fastapi + uvicorn）"
"$PY" -m venv "$APP_DIR/.venv"
"$APP_DIR/.venv/bin/pip" install -q -U pip
"$APP_DIR/.venv/bin/pip" install -q "genie-tts==2.0.2" fastapi uvicorn

echo "== 3) 写 systemd 单元（只监听 127.0.0.1，靠 ssh -R 或同机访问）"
cat >/etc/systemd/system/kizuna-voice.service <<UNIT
[Unit]
Description=Kizuna Genie TTS engine
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
ExecStart=$APP_DIR/.venv/bin/python $APP_DIR/genie_server.py --host 127.0.0.1 --port $PORT --data-dir $APP_DIR/GenieData --models-dir $APP_DIR/models
Restart=always
RestartSec=3
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now kizuna-voice.service

echo "== 4) 等它就绪并自检"
for i in $(seq 1 60); do
  if curl -fsS -m 2 "http://127.0.0.1:$PORT/characters" >/dev/null 2>&1; then
    echo "OK：引擎已就绪 http://127.0.0.1:$PORT"
    curl -s "http://127.0.0.1:$PORT/characters" | head -c 300; echo
    exit 0
  fi
  sleep 2
done
echo "引擎 120s 内没起来，看日志：journalctl -u kizuna-voice -n 80 --no-pager" >&2
exit 1
