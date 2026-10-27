#!/usr/bin/env bash
# 改完代码后的一键流程：跑全部测试 → 过了才提交 → 输出摘要
#
#   bash scripts/commit.sh "改了什么"
#   bash scripts/commit.sh              # 不给说明就自动生成
#
# 为什么要有这个：我（agent）改 bridge/index.js 时曾经手误把文件复制成两份、
# 还连带丢了函数，而当时没有版本控制，只能靠人工比对修复。
# 有了 git + 这个脚本，「改坏了」永远能 `git diff` 看出来 / `git restore` 回滚。
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

MSG="${1:-}"

echo "== 1. 语法检查 =="
fail=0
for f in bridge/index.js bridge/acp.js bridge/dsh.js bridge/onebot.js; do
  if node --check "$f" 2>/dev/null; then
    echo "  ✓ $f"
  else
    echo "  ✗ $f 语法错误"
    fail=1
  fi
done
if [ "$fail" = "1" ]; then
  echo
  echo "❌ 语法检查失败，拒绝提交。修好再来。"
  exit 1
fi

echo
echo "== 2. 跑全部测试 =="
SUITES=(
  unit card-parse url-guard sanitize forward-path
  proactive-logic flurry-logic mood-logic mood-decay mood-traits delay-logic chain-walk
  quote-reply memory-cross-channel arousal-cap energy-mood-link linebreak prod-db-lock guarantee-fix cleanup-orphan-acp recall
  style-bank memory-cross-channel lexicon message-queue chat-follow
  # 语料池抓取：离线（假 python）、不真请求 B站，所以能安全进每次提交的测试
  crawl-bili-comments
)
total_pass=0
total_fail=0
for t in "${SUITES[@]}"; do
  f="test/${t}.test.mjs"
  [ -f "$f" ] || { echo "  ⚠ $t (缺文件)"; continue; }
  out=$(node "$f" 2>&1)
  line=$(printf '%s' "$out" | grep -E "^结果:" | tail -1)
  if printf '%s' "$line" | grep -q "0 失败"; then
    echo "  ✓ $t  ${line}"
    n=$(printf '%s' "$line" | grep -oE "[0-9]+ 通过" | grep -oE "[0-9]+")
    total_pass=$((total_pass + ${n:-0}))
  else
    echo "  ✗ $t  ${line:-（跑失败）}"
    printf '%s\n' "$out" | tail -5 | sed 's/^/      /'
    total_fail=$((total_fail + 1))
  fi
done

# 整机集成测试（自己起 mock OneBot + 独立端口的 bridge 子进程，隔离于生产）
# 命名规则：test/*.integration.mjs
for f in test/*.integration.mjs; do
  [ -f "$f" ] || continue
  t="$(basename "$f" .integration.mjs)"
  out=$(node "$f" 2>&1)
  line=$(printf '%s' "$out" | grep -E "^结果:" | tail -1)
  if printf '%s' "$line" | grep -q "0 失败"; then
    echo "  ✓ ${t} (integration)  ${line}"
    n=$(printf '%s' "$line" | grep -oE "[0-9]+ 通过" | grep -oE "[0-9]+")
    total_pass=$((total_pass + ${n:-0}))
  else
    echo "  ✗ ${t} (integration)  ${line:-（跑失败）}"
    printf '%s\n' "$out" | tail -8 | sed 's/^/      /'
    total_fail=$((total_fail + 1))
  fi
done

# Python 记忆系统测试（隔离到临时库）
echo
echo "== 2.5 记忆系统测试 =="
for t in test_memctl test_outbound test_reflection test_bm25 test_owner; do
  f="qq-agent/memory/${t}.py"
  [ -f "$f" ] || { echo "  ⚠ $t (缺文件)"; continue; }
  out=$(python3 "$f" 2>&1)
  line=$(printf '%s' "$out" | grep -E "^结果:" | tail -1)
  if printf '%s' "$line" | grep -q "0 失败"; then
    echo "  ✓ $t  ${line}"
    n=$(printf '%s' "$line" | grep -oE "[0-9]+ 通过" | grep -oE "[0-9]+")
    total_pass=$((total_pass + ${n:-0}))
  else
    echo "  ✗ $t  ${line:-（跑失败）}"
    printf '%s\n' "$out" | tail -5 | sed 's/^/      /'
    total_fail=$((total_fail + 1))
  fi
done

echo
if [ "$total_fail" != "0" ]; then
  echo "❌ 有 $total_fail 个套件失败，拒绝提交。"
  exit 1
fi
echo "✅ 全部通过（共 ${total_pass} 项断言）"

echo
echo "== 3. 提交 =="

# ⚠️ 只提交**已暂存**的文件，绝不 git add -A。
#
# 为什么改：原来用 `git add -A`，多 agent 并行时会把别人未完成的工作一起裹进来。
# 2026-10-26 一天里被踩了 5 次：
#   bm25-dev / recall-dev / crosschannel-dev / learn-dev / Lead 自己
# 最严重的一次：Lead 提交「日志消歧」，实际裹进了 crawl-dev 的全部语料+脚本（21 个文件）。
#
# 所以现在要求：**你自己 git add 要提交的文件**，然后跑这个脚本。
# 没暂存任何东西时，脚本会拒绝提交并给出提示（而不是默默 add 全部）。
if [ -z "$(git diff --cached --name-only)" ]; then
  echo "  ❌ 没有已暂存的文件，拒绝提交。"
  echo ""
  echo "  这个脚本**不再**帮你 git add -A（会把别人未完成的工作裹进来）。"
  echo "  请先明确暂存你要提交的文件："
  echo ""
  echo "    git add <你的文件> ...        # 只加你自己的"
  echo "    bash scripts/commit.sh \"说明\"   # 再跑本脚本（会先跑全量测试）"
  echo ""
  echo "  当前工作树状态："
  git status --short | sed 's/^/    /'
  exit 1
fi

echo "  将提交以下已暂存文件："
git diff --cached --name-only | sed 's/^/    /'
echo
if [ -z "$MSG" ]; then
  changed=$(git diff --cached --name-only | head -3 | tr '\n' ' ')
  MSG="更新：${changed}"
fi
git commit -q -m "$MSG"
echo "  已提交：$(git log --oneline -1)"
echo
echo "== 当前 =="
echo "  提交数: $(git rev-list --count HEAD)"
echo "  文件数: $(git ls-files | wc -l)"
