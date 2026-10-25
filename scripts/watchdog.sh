#!/usr/bin/env bash
# NapCat 掉线自动恢复看门狗（C 方案）
#
# 背景：NapCat 4.18.x 有已知的 KickedOffLine 问题（GitHub #1728），
# 扫码登录后几小时可能被踢。手动重启重试既慢又容易被当成异常行为。
# 这个脚本做的是：
#   1. 每 60s 检查一次 QQ 是否在线（OneBot get_login_info，比 grep 日志可靠）
#   2. 连续 N 次离线 → 自动 docker restart 容器
#   3. 因为 compose 里配了 ACCOUNT=<QQ号>，NapCat 会走 -q 快速登录，**免扫码恢复**
#   4. 恢复成功/失败都写日志；失败太多次就停下来等人（不做无限重试）
#
# 用法：
#   setsid nohup bash scripts/watchdog.sh >/dev/null 2>&1 &
#   bash scripts/watchdog.sh status      # 看一眼当前状态
#   bash scripts/watchdog.sh stop        # 停掉
#
# 日志：logs/watchdog.log
set -uo pipefail
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
ROOT="$(cd "$(dirname "$SELF")/.." && pwd)"
LOG="$ROOT/logs/watchdog.log"
PIDFILE="$ROOT/logs/watchdog.pid"
CONTAINER="llminqq-napcat"
BRIDGE_PIDFILE="$ROOT/logs/bridge.pid"

# 可调参数（环境变量覆盖）
CHECK_INTERVAL="${CHECK_INTERVAL:-60}"        # 检查间隔（秒）
OFFLINE_THRESHOLD="${OFFLINE_THRESHOLD:-3}"   # 连续几次离线才重启（默认 3 次 = 约 3 分钟）
MAX_RESTARTS_PER_HOUR="${MAX_RESTARTS_PER_HOUR:-4}"  # 每小时最多重启几次，超了停下来等人
COOLDOWN_AFTER_RESTART="${COOLDOWN_AFTER_RESTART:-90}" # 重启后等多久再检查（秒）
BRIDGE_API="http://127.0.0.1:18080/health"
BRIDGE_TOKEN="llminqq-local-api"

log() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }

# QQ 在线吗？三个判据依次降级
is_online() {
  # ① 桥的 /health（最权威：OneBot 真的拿到了 selfId）
  local j
  j=$(curl -s -m 6 -H "authorization: Bearer $BRIDGE_TOKEN" "$BRIDGE_API" 2>/dev/null)
  if [ -n "$j" ]; then
    printf '%s' "$j" | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: sys.exit(1)
o=d.get('onebot') or {}
sys.exit(0 if o.get('online') and o.get('selfId') else 1)
" 2>/dev/null && return 0
  fi
  # ② 直接问 OneBot WS
  node -e '
const ws=new WebSocket("ws://127.0.0.1:3001")
const t=setTimeout(()=>process.exit(1),5000)
ws.onopen=()=>ws.send(JSON.stringify({action:"get_login_info",params:{},echo:"w"}))
ws.onmessage=e=>{try{const f=JSON.parse(String(e.data));if(f?.data?.user_id){clearTimeout(t);process.exit(0)}}catch{}}
ws.onerror=()=>{clearTimeout(t);process.exit(1)}
' 2>/dev/null && return 0
  # ③ 容器在跑吗
  docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$CONTAINER" || return 1
  return 1
}

container_running() {
  docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "$CONTAINER"
}

restart_container() {
  log "重启容器 $CONTAINER（期望 -q 快速登录免扫码）"
  ( cd "$ROOT/qqacct" && docker compose restart napcat ) >> "$LOG" 2>&1
}

ensure_bridge() {
  if [ -f "$BRIDGE_PIDFILE" ] && kill -0 "$(cat "$BRIDGE_PIDFILE")" 2>/dev/null; then
    return 0
  fi
  log "bridge 不在跑，拉起"
  ( cd "$ROOT" && setsid nohup node bridge/index.js >> logs/bridge.out 2>&1 & echo $! > "$BRIDGE_PIDFILE" )
  sleep 2
}

watch_loop() {
  set +e   # 循环内任何小失败都不许退出，watchdog 必须活着
  trap - ERR
  log "watchdog 启动 pid=$$ （间隔 ${CHECK_INTERVAL}s，阈值 ${OFFLINE_THRESHOLD} 次，每小时最多重启 ${MAX_RESTARTS_PER_HOUR} 次）"
  local offline_count=0
  local restart_times=()   # 存最近一小时的 unix 时间戳
  local was_online=1

  while :; do
    # 重启次数窗口清理
    local now_s; now_s=$(date +%s)
    local kept=()
    if [ "${#restart_times[@]}" -gt 0 ]; then
      for t in "${restart_times[@]}"; do
        if [ -n "$t" ] && [ $((now_s - t)) -lt 3600 ]; then kept+=("$t"); fi
      done
    fi
    restart_times=()
    if [ "${#kept[@]}" -gt 0 ]; then restart_times=("${kept[@]}"); fi

    if is_online; then
      if [ "$was_online" = "0" ]; then
        log "✓ QQ 恢复在线"
      fi
      offline_count=0
      was_online=1
    else
      offline_count=$((offline_count + 1))
      if [ "$was_online" = "1" ]; then
        log "⚠ 检测到离线（第 ${offline_count} 次）"
      else
        log "仍离线（第 ${offline_count} 次）"
      fi
      was_online=0

      if [ "$offline_count" -ge "$OFFLINE_THRESHOLD" ]; then
        if [ "${#restart_times[@]}" -ge "$MAX_RESTARTS_PER_HOUR" ]; then
          log "✗ 一小时内已重启 ${#restart_times[@]} 次，仍离线 → 停止自动重启，等人处理（可能被风控，需要扫码或换号）"
          offline_count=0
          # 不再重启，但继续监控；如果恢复就继续正常工作
        else
          restart_times+=("$now_s")
          restart_container
          ensure_bridge
          log "重启完成，等待 ${COOLDOWN_AFTER_RESTART}s 再看状态"
          sleep "$COOLDOWN_AFTER_RESTART"
          offline_count=0
          continue
        fi
      fi
    fi
    ensure_bridge
    sleep "$CHECK_INTERVAL"
  done
}

case "${1:-start}" in
  start)
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "watchdog 已在运行 pid=$(cat "$PIDFILE")"
      exit 0
    fi
    mkdir -p "$ROOT/logs"
    # 用 setsid 彻底脱离当前会话，这样父 shell 退出后它仍在跑
    setsid nohup bash "$SELF" run >/dev/null 2>&1 < /dev/null &
    echo $! > "$PIDFILE"
    sleep 2
    # run 模式会把真实 pid 写进 pidfile，覆盖掉这个临时值
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "watchdog 已启动 pid=$(cat "$PIDFILE")，日志：$LOG"
    else
      echo "watchdog 启动失败，看日志：$LOG"
      tail -5 "$LOG" 2>/dev/null
    fi
    ;;
  run)
    echo $$ > "$PIDFILE"
    watch_loop
    ;;
  stop)
    if [ -f "$PIDFILE" ]; then
      kill "$(cat "$PIDFILE")" 2>/dev/null || true
      rm -f "$PIDFILE"
      log "watchdog 被手动停止"
      echo "已停止"
    else
      echo "未在运行"
    fi
    ;;
  status)
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "watchdog: running pid=$(cat "$PIDFILE")"
    else
      echo "watchdog: 未运行"
    fi
    echo "--- 最近日志 ---"
    tail -15 "$LOG" 2>/dev/null || echo "(无日志)"
    ;;
  *) echo "用法: bash scripts/watchdog.sh {start|stop|status}"; exit 1 ;;
esac
