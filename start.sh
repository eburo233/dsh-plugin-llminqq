#!/usr/bin/env bash
# LLMinQQ 一键运维：NapCat(OneBot11 协议端) + bridge(OneBot↔LLM 桥)
#
#   bash start.sh up          启动 NapCat 与 bridge
#   bash start.sh down        停止两者
#   bash start.sh restart     重启 bridge（NapCat 不动，登录态保留）
#   bash start.sh status      状态总览（容器 / 进程 / /health / 真实QQ号）
#   bash start.sh logs        跟踪 bridge 日志
#   bash start.sh qr          等一张最新登录二维码并高清重绘（需要重新扫码时用）
#   bash start.sh watch-log   看登录检测后台任务的输出
#   bash start.sh test        跑全部自动化测试
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAPCAT_DIR="$ROOT/qqacct"
BRIDGE_PID="$ROOT/logs/bridge.pid"
API="http://127.0.0.1:18080"
TOKEN="llminqq-local-api"

bridge_running() {
  [ -f "$BRIDGE_PID" ] && kill -0 "$(cat "$BRIDGE_PID")" 2>/dev/null
}

up() {
  echo "== 启动 NapCat =="
  ( cd "$NAPCAT_DIR" && docker compose up -d )
  echo "== 启动 bridge =="
  if bridge_running; then
    echo "bridge 已在运行 pid=$(cat "$BRIDGE_PID")"
  else
    mkdir -p "$ROOT/logs"
    ( cd "$ROOT" && setsid nohup node bridge/index.js >> logs/bridge.out 2>&1 & echo $! > "$BRIDGE_PID" )
    sleep 2
    echo "bridge pid=$(cat "$BRIDGE_PID")"
  fi
  sleep 12
  status
}

down() {
  echo "== 停止 bridge =="
  if bridge_running; then kill "$(cat "$BRIDGE_PID")" 2>/dev/null || true; fi
  rm -f "$BRIDGE_PID"
  pkill -f "node $ROOT/bridge/index.js" 2>/dev/null || true
  pkill -f "node bridge/index.js" 2>/dev/null || true
  echo "== 停止 NapCat =="
  ( cd "$NAPCAT_DIR" && docker compose down )
}

restart() {
  echo "== 重启 bridge（NapCat 不动，QQ 登录态保留）=="
  if bridge_running; then kill "$(cat "$BRIDGE_PID")" 2>/dev/null || true; fi
  rm -f "$BRIDGE_PID"
  pkill -f "node bridge/index.js" 2>/dev/null || true
  sleep 2
  mkdir -p "$ROOT/logs"
  ( cd "$ROOT" && setsid nohup node bridge/index.js >> logs/bridge.out 2>&1 & echo $! > "$BRIDGE_PID" )
  sleep 12
  status
}

status() {
  echo "== NapCat 容器 =="
  docker ps --filter name=llminqq-napcat --format '  {{.Names}}  {{.Status}}  {{.Ports}}' || true
  echo
  echo "== bridge 进程 =="
  if bridge_running; then echo "  running pid=$(cat "$BRIDGE_PID")"
  else echo "  未运行（或 pid 文件过期）"; fi
  echo
  echo "== /health =="
  local json
  json=$(curl -s -m 5 -H "authorization: Bearer $TOKEN" "$API/health" 2>/dev/null)
  if [ -z "$json" ]; then
    echo "  API 无响应"
    return
  fi
  LLMINQQ_HEALTH_JSON="$json" python3 - <<'PYEOF'
import json,os
d=json.loads(os.environ['LLMINQQ_HEALTH_JSON'])
ob=d['onebot']; dsh=d['dsh']
sid=ob.get('selfId')
line=f"  OneBot 在线 : {ob.get('online')}"
if sid: line += f"   真实QQ号: {sid} ({ob.get('nickname')})"
print(line)
route = dsh.get('currentRoute') or dsh['route']
fo = dsh.get('failover') or {}
line = f"  DSH 就绪    : {dsh['ready']}   当前路由: {route}"
if fo.get('enabled'):
    idx = fo.get('fallbackIndex', -1)
    pos = '主路由' if idx == -1 else f"备选 {idx+1}/{fo.get('fallbackCount',0)}"
    line += f"  [{pos}"
    if fo.get('switches'):
        line += f", 已切换 {fo['switches']} 次"
    if fo.get('consecutiveFailures'):
        line += f", 连续失败 {fo['consecutiveFailures']}"
    line += "]"
print(line)
print(f"  人设文件    : {d['persona']['path']}  存在={d['persona']['exists']}")
sess=d.get('sessions') or {}
if sess:
    print("  会话:")
    for k,v in sess.items():
        extra=''
        if v.get('compactions'): extra += f"  压缩={v['compactions']}次"
        if v.get('rolledFrom'): extra += f"  已换会话(原 {v['rolledFrom'][:24]}...)"
        print(f"    {k}  turns={v.get('turns')}{extra}")
else:
    print("  会话: (暂无，还没人发消息)")
PYEOF
}

case "${1:-status}" in
  up) up ;;
  down) down ;;
  restart) restart ;;
  status) status ;;
  logs) tail -f "$ROOT/logs/bridge.out" ;;
  qr)
    bash "$ROOT/scripts/qr.sh" "${@:2}"
    echo
    echo "把上面这张图发到 QQ 里扫，或用浏览器打开："
    echo "  http://127.0.0.1:6099/webui?token=llminqq-2026"
    ;;
  watch-log)
    echo "登录检测后台任务输出：$ROOT/logs/login-watch.log"
    tail -20 "$ROOT/logs/login-watch.log" 2>/dev/null || echo "(还没有记录，启动它：setsid nohup bash scripts/login-watch.sh >/dev/null 2>&1 &)"
    ;;
  test)
    echo "== 单元测试 =="
    node "$ROOT/test/unit.test.mjs" | tail -3
    echo
    echo "== 入站图片端到端 =="
    LLMINQQ_TEST_OUT="$ROOT/logs/inbound-image-test.txt" node "$ROOT/test/inbound-image.test.mjs" | tail -4
    ;;
  *) echo "用法: bash start.sh {up|down|restart|status|logs|qr|watch-log|test}"; exit 1 ;;
esac
