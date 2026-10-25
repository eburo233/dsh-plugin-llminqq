#!/usr/bin/env bash
# 定期反思：把情节记忆提炼成语义记忆
#
# 用法：
#   bash scripts/reflect.sh              # 跑全部 peer
#   bash scripts/reflect.sh --peer c2c-3022464706   # 单个
#
# 为什么用独立脚本而不是塞进桥：
#   - 反思要 2-3 分钟、偶尔会超时，放桥的定时器里会阻塞对话
#   - 独立进程崩了不影响桥
#   - 桥重启不会打断它
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1
LOG="$ROOT/logs/reflect.log"
mkdir -p "$ROOT/logs"

stamp() { date '+%Y-%m-%d %H:%M:%S'; }

{
  echo "[$(stamp)] === 反思开始 ==="
  # 单个 peer 用时 2-4 分钟，全部可能要十几分钟；宁可慢也别截断
  # ⚠️ 默认 24h 窗口会漏掉「昨天没跑」造成的积压（实测踩过：
  #    70 条待提炼全部早于 24h 窗口 → 定时任务空跑）。
  #    这里用 REFLECT_HOURS（默认 168 = 一周）兜住，已提炼的不会重复。
  HOURS="${REFLECT_HOURS:-168}"
  if [ $# -gt 0 ]; then
    timeout 1800 python3 qq-agent/memory/memctl.py reflect "$@" --hours "$HOURS" 2>&1
  else
    # 不带 --peer 就是全部（--all 不是有效参数，别写错）
    timeout 1800 python3 qq-agent/memory/memctl.py reflect --hours "$HOURS" 2>&1
  fi
  rc=$?
  if [ $rc -ne 0 ]; then
    echo "[$(stamp)] ⚠️ 退出码 $rc（超时或部分失败；已提炼的不会重复，下轮会重试剩下的）"
  fi
  echo "[$(stamp)] === 反思结束 ==="
  echo
} >> "$LOG" 2>&1

# 顺带清理极低价值的（不给 pin 的）
timeout 120 python3 qq-agent/memory/memctl.py prune >> "$LOG" 2>&1 || true
