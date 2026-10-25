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
  proactive-logic flurry-logic mood-logic mood-decay mood-traits delay-logic
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

echo
if [ "$total_fail" != "0" ]; then
  echo "❌ 有 $total_fail 个套件失败，拒绝提交。"
  exit 1
fi
echo "✅ 全部通过（共 ${total_pass} 项断言）"

echo
echo "== 3. 提交 =="
if [ -z "$(git status --porcelain)" ]; then
  echo "  没有变更，跳过提交"
  exit 0
fi
git status --short | sed 's/^/  /'
echo
if [ -z "$MSG" ]; then
  changed=$(git status --porcelain | awk '{print $2}' | head -3 | tr '\n' ' ')
  MSG="更新：${changed}"
fi
git add -A
git commit -q -m "$MSG"
echo "  已提交：$(git log --oneline -1)"
echo
echo "== 当前 =="
echo "  提交数: $(git rev-list --count HEAD)"
echo "  文件数: $(git ls-files | wc -l)"
