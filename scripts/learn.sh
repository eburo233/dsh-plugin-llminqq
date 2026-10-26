#!/usr/bin/env bash
# 定时学习「说话方式」：从别人的语料里提炼词汇/梗/表情用法/句式 → memory/lexicon.json
#
# 用法：
#   bash scripts/learn.sh                 # 群语料 + 语料池各学一小段（默认，定时任务用）
#   bash scripts/learn.sh --no-corpus     # 只学群语料
#   bash scripts/learn.sh --dry-run       # 只看统计，不写文件
#   bash scripts/learn.sh --only-corpus --segments 6   # 只吃语料池，且只吃 6 段
#
# 为什么照 reflect.sh 一样做成独立脚本 + 独立进程：
#   - 提炼要调模型（几十秒到几分钟），塞进桥的定时器会阻塞对话链路
#   - 独立进程崩了不影响桥，桥重启也不会打断它
#   跟反思的区别只有一个：**换了个输入输出**（反思写 mem.db，这里写 lexicon.json）。
#
# 输入现在是两路（**都不现抓 B站**）：
#   ① 本群语料 memory/log/*.jsonl（9 段，熟人接话，最接近吉祥物的处境）
#   ② 语料池 qq-agent/memory/corpus/（crawl-bili-comments.mjs 攒的跨分区评论）
# 每轮按预算取一小段、用游标记住学到哪 —— 池子几百段也不会一夜跑 2 小时。
#
# 频率比反思低（12h vs 8h）：语料更新没那么快，学太勤只会把同一批词反复确认。
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1
LOG="$ROOT/logs/learn.log"
mkdir -p "$ROOT/logs"

stamp() { date '+%Y-%m-%d %H:%M:%S'; }

# 语料池那一路：池子目录不存在时自动降级成「只学群语料」，不让定时任务天天报错
# （刚部署、还没跑过 crawl 的那一天就是这种状态）。
CORPUS_DIR="$ROOT/qq-agent/memory/corpus"
EXTRA=()
case " $* " in
  *" --only-corpus "*) ;;   # 调用方明确要求只吃池子 → 原样交给 python（池子空它会报错，这正是要看见的）
  *) [ -d "$CORPUS_DIR" ] && EXTRA+=(--corpus-dir "$CORPUS_DIR") ;;
esac
# 为什么默认传 --corpus-dir 而不是让 python 自己读默认目录：
# 显式传路径 = 定时脚本和配置各说各话时至少日志里能看到真实路径（排查过 3 次「学的是旧目录」）。

{
  echo "[$(stamp)] === 说话方式学习开始 ==="
  # 总超时 1200s：群语料 9 段 + 语料池 18 段，实测语料量 1.2 万字左右，10 分钟量级。
  # 比原来给 B站现抓留的余量小，因为现抓那一路已挪到 crawl 脚本（低频、单独限速）。
  timeout 1200 python3 qq-agent/memory/lexicon.py learn "${EXTRA[@]}" "$@" 2>&1
  rc=$?
  if [ $rc -ne 0 ]; then
    echo "[$(stamp)] ⚠️ 退出码 $rc（模型超时/部分来源失败；已学到的不受影响，游标也没前进，下轮会重试）"
  fi
  echo "[$(stamp)] === 学习结束 当前词库 ==="
  timeout 60 python3 qq-agent/memory/lexicon.py stats 2>&1
  echo
} >> "$LOG" 2>&1
