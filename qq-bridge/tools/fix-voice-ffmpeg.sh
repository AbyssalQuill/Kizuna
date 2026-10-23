#!/bin/sh
# 2026-10-24: NapCat 发语音要靠 ffmpeg 的 `ntsilk_s16le` 封装（腾讯 silk），系统 ffmpeg 没有这个 muxer，
# 报 "Requested output format 'ntsilk_s16le' is not known"，语音就发不出去。
# 这个脚本把修复装到本机，幂等：已经装过就什么都不做。
#
#   sh tools/fix-voice-ffmpeg.sh            # 装/检查
#   sh tools/fix-voice-ffmpeg.sh --check    # 只检查，不改动（退出码 0=已就绪）
set -eu

CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1
MARK='# kizuna-ntsilk-wrapper'
NT=' /usr/local/bin/ffmpeg-ntsilk'

say() { echo "[voice-ffmpeg] $*"; }

# 1) 已经能用 ntsilk 吗？（有的发行版/自编译 ffmpeg 自带）
if ffmpeg -hide_banner -muxers 2>/dev/null | grep -qi ntsilk; then
  say "系统 ffmpeg 已支持 ntsilk，无需处理"
  exit 0
fi

# 2) 是不是已经装过我们的分发脚本了？
if grep -q "$MARK" /usr/bin/ffmpeg 2>/dev/null && [ -x /usr/local/bin/ffmpeg-ntsilk ]; then
  say "已安装（分发脚本 + NTSilk），无需处理"
  exit 0
fi

if [ "$CHECK_ONLY" = "1" ]; then
  say "未安装：NapCat 发语音会失败（缺 ntsilk）"
  exit 1
fi

[ "$(id -u)" = "0" ] || { say "需要 root 权限（会改 /usr/bin/ffmpeg 与 /usr/bin/ffprobe）"; exit 1; }

# 3) 下载 NTSilk Userland 的精简 ffmpeg（只带 silk 与 mp3）
URL1='https://ntsilk.ilharper.com/ntsilk-linux-x64'
URL2='https://github.com/ntsilk-userland/binaries/releases/latest'
TMP=$(mktemp /tmp/ntsilk.XXXXXX) || exit 1
trap 'rm -f "$TMP"' EXIT
say "下载 NTSilk 二进制…"
if ! curl -fsSL --max-time 180 -o "$TMP" "$URL1"; then
  say "主地址失败，改走 GitHub releases（请手动从 $URL2 下载 ntsilk-linux-x64 后重跑）"
  exit 1
fi
chmod +x "$TMP"
"$TMP" -hide_banner -encoders 2>/dev/null | grep -qi ntsilk_s16le || { say "下载到的二进制不含 ntsilk_s16le，放弃"; exit 1; }
mkdir -p /usr/local/bin
mv "$TMP" /usr/local/bin/ffmpeg-ntsilk
chmod +x /usr/local/bin/ffmpeg-ntsilk
say "已安装 /usr/local/bin/ffmpeg-ntsilk"

# 4) 给 /usr/bin/ffmpeg 与 /usr/bin/ffprobe 套分发脚本（真身保留为 *.real）
if [ ! -f /usr/bin/ffmpeg.real ]; then cp -a /usr/bin/ffmpeg /usr/bin/ffmpeg.real; fi
cat > /usr/bin/ffmpeg <<EOF
#!/bin/sh
$MARK
# 只有带 ntsilk 的调用交给精简版，其余一律走真身（桥的回声裁剪、其它工具不受影响）
case "\$*" in
  *ntsilk*) exec /usr/local/bin/ffmpeg-ntsilk "\$@" ;;
esac
exec /usr/bin/ffmpeg.real "\$@"
EOF
chmod +x /usr/bin/ffmpeg

if [ ! -f /usr/bin/ffprobe.real ]; then cp -a /usr/bin/ffprobe /usr/bin/ffprobe.real; fi
cat > /usr/bin/ffprobe <<EOF
#!/bin/sh
$MARK
/usr/bin/ffprobe.real "\$@"
rc=\$?
[ \$rc -eq 0 ] && exit 0
f=''
for a in "\$@"; do case "\$a" in -*) ;; *) f="\$a" ;; esac; done
[ -n "\$f" ] && [ -f "\$f" ] || exit \$rc
head -c 10 "\$f" 2>/dev/null | grep -q SILK || exit \$rc
sz=\$(stat -c %s "\$f" 2>/dev/null) || exit \$rc
awk -v s="\$sz" 'BEGIN{printf "%.3f\\n", s/3466}'
exit 0
EOF
chmod +x /usr/bin/ffprobe

say "完成：ffmpeg 分发到 NTSilk、ffprobe 对 silk 文件按体积估算时长"
say "自检：ffmpeg -hide_banner -muxers | grep -i ntsilk  （应能看到 ntsilk_s16le）"
