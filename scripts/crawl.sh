#!/usr/bin/env bash
# 定时抓 B站公开评论进语料池（低频：每天 1-2 次，每次 2-3 个新视频）
#
# 用法：
#   bash scripts/crawl.sh              # 按 config.learning.crawlOnly（默认 3）抓几个新视频
#   bash scripts/crawl.sh --only 5     # 这轮抓 5 个
#   bash scripts/crawl.sh --dry-run    # 只看还要抓哪些
#
# 为什么低频、每次只抓几个：
#   B站评论接口翻页有风控（-412）。一次把清单刷完既不必要（池子能存住）又容易触发限制，
#   而且风控一旦触发，后面几天的抓取都会被牵连。低频少量才是可持续的。
#
# 为什么单独一个脚本 + 单独的 timer（不塞进 learn.sh）：
#   抓取和提炼是两件事、两条时间线：
#     · 抓取：慢、要限速、失败了可以慢慢补（池子缺几个视频不影响学习）
#     · 提炼：慢、要调模型、一轮只吃预算内的量
#   塞在一起的话，「抓取被限流」和「模型超时」会互相搅在一起，日志也分不清谁挂了。
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1
LOG="$ROOT/logs/crawl.log"
mkdir -p "$ROOT/logs" "$ROOT/qq-agent/memory/corpus"

stamp() { date '+%Y-%m-%d %H:%M:%S'; }

{
  echo "[$(stamp)] === B站评论抓取开始 ==="
  # 退出码 3 = 遇到限流。**不重试**（重试只会把风控拖长），交给下一个定时窗口。
  timeout 900 node scripts/crawl-bili-comments.mjs 2>&1
  rc=$?
  case $rc in
    0) ;;
    3) echo "[$(stamp)] ⛔ 被限流，本轮停止（不重试；下一窗口再抓）" ;;
    *) echo "[$(stamp)] ⚠️ 退出码 $rc（部分视频失败；已抓到的文件不受影响，下轮会补）" ;;
  esac
  echo "[$(stamp)] === 抓取结束 当前语料池 ==="
  python3 - <<'PY' 2>&1
import glob, json, os
from collections import Counter
files = [p for p in glob.glob(os.path.join("qq-agent/memory/corpus", "bili-*.json"))]
doms = Counter(); tops = nodes = 0
for p in files:
    try:
        d = json.load(open(p, encoding="utf-8"))
    except Exception:
        continue
    doms[d.get("domain") or "unknown"] += 1
    for c in d.get("comments") or []:
        tops += 1
        nodes += 1 + len(c.get("top_replies") or [])
print(f"池子：{len(files)} 个视频 / {tops} 条一级评论 / {nodes} 条含楼中楼 / 分区 {dict(doms)}")
PY
  echo
} >> "$LOG" 2>&1
