#!/usr/bin/env bash
# 定时学习「说话方式」：从别人的语料里提炼词汇/梗/表情用法/句式 → memory/lexicon.json
#
# 用法：
#   bash scripts/learn.sh                 # 两路都学（本群语料 + B站评论区）
#   bash scripts/learn.sh --no-bili       # 只学本群语料（不想碰 B站时）
#   bash scripts/learn.sh --dry-run       # 只看统计，不写文件
#
# 为什么照 reflect.sh 一样做成独立脚本 + 独立进程：
#   - 提炼要调模型（几十秒到几分钟），塞进桥的定时器会阻塞对话链路
#   - 独立进程崩了不影响桥，桥重启也不会打断它
#   跟反思的区别只有一个：**换了个输入输出**（反思写 mem.db，这里写 lexicon.json）。
#
# 频率比反思低（12h vs 8h）：语料更新没那么快，学太勤只会把同一批词反复确认。
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1
LOG="$ROOT/logs/learn.log"
mkdir -p "$ROOT/logs"

stamp() { date '+%Y-%m-%d %H:%M:%S'; }

{
  echo "[$(stamp)] === 说话方式学习开始 ==="
  # B站抓取有风控：默认 3 个源、每个 8 条评论，够了。别为了凑量反复请求。
  # 总超时 900s：群语料几段 + B站 3 个源，正常 3-5 分钟跑完。
  timeout 1200 python3 qq-agent/memory/lexicon.py learn "$@" 2>&1
  rc=$?
  if [ $rc -ne 0 ]; then
    echo "[$(stamp)] ⚠️ 退出码 $rc（模型超时/部分来源失败；已学到的不受影响，下轮会重试）"
  fi
  echo "[$(stamp)] === 学习结束 当前词库 ==="
  timeout 60 python3 qq-agent/memory/lexicon.py stats 2>&1
  echo
} >> "$LOG" 2>&1
