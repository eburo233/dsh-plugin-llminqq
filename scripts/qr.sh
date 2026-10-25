#!/usr/bin/env bash
# 产出一张「刚刚刷新」的登录二维码，高清重绘，放到可被 [SEND_FILE] 发送的路径。
#
# 为什么需要它：
#   1. NapCat 的登录二维码每 ~2 分钟自动刷新一次，旧码扫了会立刻失效，
#      所以每次要发码都必须等到一个足够新的码。
#   2. 容器里那张 qrcode.png 只有 147x147，手机扫不动；直接插值放大会糊。
#      这里取 NapCat 日志里的「二维码解码URL」，用 qrcode 库**重新渲染**，
#      得到边缘锐利的高清码（payload 与容器那张完全一致）。
#
# 用法：
#   bash scripts/qr.sh                 # 输出 $ROOT/llminqq-qr.png
#   bash scripts/qr.sh /path/out.png   # 自定义输出路径
#   bash scripts/qr.sh --maxage 15     # 只接受 15 秒内的新码（默认 15）
#   bash scripts/qr.sh --size 1200     # 输出边长像素（默认 900）
#
# 退出码：0 = 已产出新码；2 = 等不到新码（NapCat 没在跑 / 已登录）
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/qqacct/data/cache/qrcode.png"
OUT="$ROOT/llminqq-qr.png"
MAXAGE=15
SIZE=900

args=("$@")
i=0
while [ $i -lt ${#args[@]} ]; do
  case "${args[$i]}" in
    --maxage) MAXAGE="${args[$((i+1))]:-15}"; i=$((i+2)) ;;
    --size)   SIZE="${args[$((i+1))]:-900}"; i=$((i+2)) ;;
    *)        OUT="${args[$i]}"; i=$((i+1)) ;;
  esac
done

if ! docker ps --format '{{.Names}}' | grep -q '^llminqq-napcat$'; then
  echo "✗ NapCat 容器没在跑：docker compose -f $ROOT/qqacct/compose.yaml up -d" >&2
  exit 2
fi

# 等一个足够新的码（NapCat 每 120s 刷新一次，所以最多等 ~140s）
deadline=$(( $(date +%s) + 140 ))
while :; do
  if [ -f "$SRC" ]; then
    age=$(( $(date +%s) - $(stat -c %Y "$SRC") ))
    if [ "$age" -le "$MAXAGE" ]; then break; fi
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    age=$(( $(date +%s) - $(stat -c %Y "$SRC" 2>/dev/null || echo 0) ))
    echo "✗ 等不到新码（当前码龄 ${age}s）。可能已登录成功，或 NapCat 卡住了。" >&2
    exit 2
  fi
  sleep 2
done

AGE=$(( $(date +%s) - $(stat -c %Y "$SRC") ))

# 取容器日志里最新一次刷码的「二维码解码URL」——它与 qrcode.png 是同一个 payload
URL=$(docker logs --tail 120 llminqq-napcat 2>&1 | grep -oP '二维码解码URL: \K\S+' | tail -1)

QRCODE_LIB="$HOME/.dsh/profiles/web/node_modules/qrcode/lib/index.js"
rendered=0
if [ -n "${URL:-}" ] && [ -f "$QRCODE_LIB" ]; then
  if node -e "
    import('$QRCODE_LIB').then(async m => {
      const QR = m.default || m;
      await QR.toFile(process.argv[2], process.argv[1], { width: $SIZE, margin: 2, errorCorrectionLevel: 'M' });
    }).catch(e => { console.error(e.message); process.exit(1) });
  " "$URL" "$OUT"; then
    rendered=1
    echo "✓ 高清重绘: $OUT (${SIZE}px, 码龄 ${AGE}s)"
  fi
fi

if [ "$rendered" = "0" ]; then
  python3 - "$SRC" "$OUT" <<'PY'
import sys
from PIL import Image
src, out = sys.argv[1], sys.argv[2]
im = Image.open(src).convert('RGB')
im.resize((im.width * 14, im.height * 14), Image.NEAREST).save(out)
PY
  echo "✓ 位图放大（回退）: $OUT ($(stat -c %s "$OUT") bytes, 码龄 ${AGE}s)"
fi

chmod 644 "$OUT" 2>/dev/null || true
[ -n "${URL:-}" ] && echo "  payload: $URL"
exit 0
