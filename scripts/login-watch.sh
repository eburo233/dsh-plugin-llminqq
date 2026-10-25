#!/usr/bin/env bash
# 只做一件事：盯着「真实 QQ 号是否登录成功」，一旦成功就把结果写进
# logs/login-watch.log，供人/agent 随时查看。不发二维码、不发消息。
#
# 判据（任一成立即视为登录成功）：
#   1. bridge 的 /health 里 onebot.online=true 且 selfId 非空
#   2. OneBot WS 上 get_login_info 返回真实 user_id
#   3. NapCat 日志出现登录成功字样
#
# 用法：setsid nohup bash scripts/login-watch.sh >/dev/null 2>&1 &
# 结果：logs/login-watch.log（同时最后一行以 LOGIN_OK / LOGIN_PENDING 开头）
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/logs/login-watch.log"
HEALTH="http://127.0.0.1:18080/health"
TOKEN="llminqq-local-api"

: > "$OUT"
echo "[$(date '+%F %T')] login-watch 启动（只检查登录，不发任何消息）" >> "$OUT"

check_health() {
  curl -s -m 5 -H "authorization: Bearer $TOKEN" "$HEALTH" 2>/dev/null | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: sys.exit(1)
o=d.get('onebot') or {}
sid=o.get('selfId') or ''
if o.get('online') and sid: print(sid, o.get('nickname') or ''); sys.exit(0)
sys.exit(1)
" 2>/dev/null
}

check_onebot() {
  node - <<'JS' 2>/dev/null
const ws = new WebSocket('ws://127.0.0.1:3001')
const t = setTimeout(() => { process.exit(1) }, 5000)
ws.onopen = () => ws.send(JSON.stringify({ action: 'get_login_info', params: {}, echo: 'w1' }))
ws.onmessage = e => {
  try {
    const f = JSON.parse(String(e.data))
    const d = f?.data
    if (d?.user_id) { clearTimeout(t); console.log(d.user_id, d.nickname ?? ''); process.exit(0) }
  } catch {}
}
ws.onerror = () => { clearTimeout(t); process.exit(1) }
JS
}

for i in $(seq 1 720); do   # 最多盯 6 小时（30s 一轮）
  R=$(check_health) && {
    echo "[$(date '+%F %T')] LOGIN_OK via /health: $R" >> "$OUT"
    echo "LOGIN_OK $R" >> "$OUT"; exit 0; }
  R=$(check_onebot) && {
    echo "[$(date '+%F %T')] LOGIN_OK via OneBot get_login_info: $R" >> "$OUT"
    echo "LOGIN_OK $R" >> "$OUT"; exit 0; }
  if docker logs --since 1m llminqq-napcat 2>&1 | grep -qE "登录成功|账号已上线|Login Success"; then
    echo "[$(date '+%F %T')] LOGIN_OK via napcat log" >> "$OUT"
    echo "LOGIN_OK (log)" >> "$OUT"; exit 0
  fi
  # 每 5 分钟留一条心跳，便于区分「还在盯」和「脚本死了」
  if [ $((i % 10)) -eq 1 ]; then
    echo "[$(date '+%F %T')] LOGIN_PENDING (未登录，继续盯) 二维码码龄 $(( $(date +%s) - $(stat -c %Y "$ROOT/qqacct/data/cache/qrcode.png" 2>/dev/null || echo 0) ))s" >> "$OUT"
  fi
  sleep 30
done
echo "[$(date '+%F %T')] LOGIN_PENDING (6 小时超时)" >> "$OUT"
echo "LOGIN_PENDING" >> "$OUT"
exit 1
