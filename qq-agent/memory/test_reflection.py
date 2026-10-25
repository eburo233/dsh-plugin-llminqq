#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""reflection 测试：临时库 + mock LLM，绝不真的调模型、绝不碰生产 mem.db。"""
import importlib.util
import os
import sys
import tempfile

_HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("m", os.path.join(_HERE, "memctl.py"))
m = importlib.util.module_from_spec(spec)

_tmp = tempfile.mkdtemp(prefix="refl-test-")
m.DB = os.path.join(_tmp, "mem.db")
m.LOG_DIR = os.path.join(_tmp, "log")
m.CURSOR = os.path.join(_tmp, "cursor")
m.DIGEST = os.path.join(_tmp, "digest.md")
spec.loader.exec_module(m)

# ⚠️ 必须在 exec_module **之后**再覆盖：模块加载时会把 DB 重设成生产路径。
_TMPDIR = tempfile.mkdtemp(prefix="memtest-isolated-")
m.DB = os.path.join(_TMPDIR, "mem.db")
m.LOG_DIR = os.path.join(_TMPDIR, "log")
m.CURSOR = os.path.join(_TMPDIR, "cursor")
m.DIGEST = os.path.join(_TMPDIR, "digest.md")
os.makedirs(m.LOG_DIR, exist_ok=True)
_PROD = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mem.db")
assert os.path.abspath(m.DB) != os.path.abspath(_PROD), "测试必须隔离，不能连生产库！"

pass_, fail_ = 0, 0


def ok(name, cond, detail=""):
    global pass_, fail_
    if cond:
        pass_ += 1
        print("  ✓", name)
    else:
        fail_ += 1
        print("  ✗", name, ("— " + str(detail)) if detail else "")


def fresh_conn():
    """每个用例一个干净的库。"""
    if os.path.exists(m.DB):
        os.remove(m.DB)
    return m.connect(m.DB)


def seed(conn, peer, texts, hours_ago=1):
    ts = m.now_ts() - hours_ago * 3600
    ids = []
    for t in texts:
        rid = m.remember(conn, peer, t, kind="episodic", ts=ts)
        if rid:
            ids.append(rid)
    conn.commit()
    return ids


FAKE_SUMMARY = """- 信风是做后端的，平时在杭州上班
- 他讨厌被问"吃了吗"这种客套话
- 约定：只接他的活，别人来一概不接
"""


def fake_llm_ok(prompt, timeout):
    return FAKE_SUMMARY


def fake_llm_empty(prompt, timeout):
    return "- 无"


def fake_llm_garbage(prompt, timeout):
    return "以下是总结：\n\n随便一些没用的东西\n1. 也不行\n"


def fake_llm_raises_runtime(prompt, timeout):
    raise m.LLMRuntimeError("模拟模型超时")


def fake_llm_raises_unavailable(prompt, timeout):
    raise m.LLMUnavailable("模拟没配模型")


# ── 1. 提炼结果真的入库 ────────────────────────────────────────────────────
print("=== 1. 提炼结果入库 ===")
conn = fresh_conn()
seed(conn, "c2c:1", ["我在杭州上班，做后端的", "别问我吃了吗", "记住了以后只接我的活",
                     "今天有点累"], hours_ago=2)
res = m.reflect(conn, "c2c:1", hours=24, use_llm=True, llm_caller=fake_llm_ok)
ok("模式是 llm", res["mode"] == "llm", res["mode"])
ok("扫描到了 episodic", res["scanned"] == 4, res["scanned"])
ok("提炼出 3 条", res["created"] == 3, res["created"])

sem = conn.execute(
    "SELECT text, kind, importance FROM entries WHERE peer=? AND kind='semantic'",
    ("c2c:1",)).fetchall()
ok("库里确实有 3 条 semantic", len(sem) == 3, len(sem))
ok("semantic 内容来自模型", any("杭州" in r["text"] for r in sem),
   [r["text"][:20] for r in sem])
ok("semantic 重要性不低于 0.65", all(r["importance"] >= 0.65 for r in sem),
   [round(r["importance"], 2) for r in sem])

# ── 2. 幂等：同一批不重复提炼 ───────────────────────────────────────────────
print("\n=== 2. 幂等 ===")
res2 = m.reflect(conn, "c2c:1", hours=24, use_llm=True, llm_caller=fake_llm_ok)
ok("第二次扫描 0 条（已标记）", res2["scanned"] == 0, res2["scanned"])
n_sem = conn.execute(
    "SELECT COUNT(*) FROM entries WHERE peer=? AND kind='semantic'", ("c2c:1",)).fetchone()[0]
ok("semantic 还是 3 条（没重复膨胀）", n_sem == 3, n_sem)
marked = conn.execute(
    "SELECT COUNT(*) FROM entries WHERE peer=? AND kind='episodic' AND reflected=1",
    ("c2c:1",)).fetchone()[0]
ok("episodic 都打了 reflected 标记", marked >= 4, marked)

# 新来一批 → 能继续提炼
ts = m.now_ts() - 600
m.remember(conn, "c2c:1", "下周要去北京出差三天", kind="episodic", ts=ts)
conn.commit()
res3 = m.reflect(conn, "c2c:1", hours=24, use_llm=True, llm_caller=fake_llm_ok)
ok("新消息能再被提炼", res3["scanned"] == 1, res3["scanned"])

# ── 3. 失败不崩、不污染数据 ────────────────────────────────────────────────
print("\n=== 3. 失败安全 ===")
conn = fresh_conn()
seed(conn, "c2c:2", ["我的猫叫团子", "它三岁了", "是个橘猫", "很能吃"])
before_sem = conn.execute("SELECT COUNT(*) FROM entries WHERE kind='semantic'").fetchone()[0]
before_mark = conn.execute(
    "SELECT COUNT(*) FROM entries WHERE reflected=1").fetchone()[0]

res = m.reflect(conn, "c2c:2", hours=24, use_llm=True, llm_caller=fake_llm_raises_runtime)
ok("调用失败时 mode=error", res["mode"] == "error", res["mode"])
ok("失败时有 error 说明", bool(res["error"]))
after_sem = conn.execute("SELECT COUNT(*) FROM entries WHERE kind='semantic'").fetchone()[0]
ok("失败不新增 semantic", after_sem == before_sem, f"{before_sem}→{after_sem}")
after_mark = conn.execute("SELECT COUNT(*) FROM entries WHERE reflected=1").fetchone()[0]
ok("失败不打 reflected 标记（可重试）", after_mark == before_mark, f"{before_mark}→{after_mark}")

# LLM 不可用 → 静默退回拼接法，不报错
res = m.reflect(conn, "c2c:2", hours=24, use_llm=True,
                llm_caller=fake_llm_raises_unavailable)
ok("不可用时退回 fallback", res["mode"] in ("fallback",), res["mode"])
ok("退回了但不崩（有 error 记录）", res["error"] is not None)

# ── 4. 模型说「无」时是正常结果 ─────────────────────────────────────────────
print("\n=== 4. 模型回「无」===")
conn = fresh_conn()
seed(conn, "c2c:3", ["哈哈", "确实确实", "哈哈哈哈哈"])
res = m.reflect(conn, "c2c:3", hours=24, use_llm=True, llm_caller=fake_llm_empty)
ok("不新增 semantic", res["created"] == 0, res["created"])
ok("模式标 llm-empty", res["mode"] == "llm-empty", res["mode"])
ok("但依然打标记（避免反复扫同一批废话）",
   conn.execute("SELECT COUNT(*) FROM entries WHERE reflected=1").fetchone()[0] > 0)

# ── 5. 解析器宽容 ──────────────────────────────────────────────────────────
print("\n=== 5. 输出解析 ===")
ok("项目符号", len(m._parse_reflection("- 甲是程序员\n- 乙是设计师")) == 2)
ok("编号列表", len(m._parse_reflection("1. 甲是程序员\n2. 乙是设计师")) == 2)
ok("过滤标题行", m._parse_reflection("以下是总结：\n- 甲是程序员") == ["甲是程序员"],
   m._parse_reflection("以下是总结：\n- 甲是程序员"))
ok("回「无」得到空", m._parse_reflection("- 无") == [])
ok("去重", len(m._parse_reflection("- 他住在杭州做后端开发\n- 他住在杭州做后端开发")) == 1,
   m._parse_reflection("- 他住在杭州做后端开发\n- 他住在杭州做后端开发"))
ok("短碎片丢弃", m._parse_reflection("- 嗯") == [])
ok("空输入不崩", m._parse_reflection("") == [])
ok("垃圾输入不崩", isinstance(m._parse_reflection("!!!!\n???\n@@@"), list))

# ── 6. --no-llm 退回粗糙法 ──────────────────────────────────────────────────
print("\n=== 6. --no-llm 退回拼接 ===")
conn = fresh_conn()
seed(conn, "c2c:4", ["记住以后每次都要先问我", "记住以后别在群里说话",
                     "默认用中文", "惯例是先问我"])
res = m.reflect(conn, "c2c:4", hours=24, use_llm=False)
ok("模式 fallback", res["mode"] == "fallback", res["mode"])
ok("不调用 llm 也能产出", res["created"] >= 0)
ok("没有 error（这是正常路径）", res["error"] is None, res["error"])

# ── 7. dry-run 不写库 ──────────────────────────────────────────────────────
print("\n=== 7. dry-run ===")
conn = fresh_conn()
seed(conn, "c2c:5", ["我在成都，做前端的", "我养了两只狗"])
res = m.reflect(conn, "c2c:5", hours=24, use_llm=True,
                llm_caller=fake_llm_ok, dry_run=True)
ok("拿到 summaries", len(res["summaries"]) == 3, len(res["summaries"]))
ok("库里没有新 semantic",
   conn.execute("SELECT COUNT(*) FROM entries WHERE kind='semantic'").fetchone()[0] == 0)
ok("也没有打标记",
   conn.execute("SELECT COUNT(*) FROM entries WHERE reflected=1").fetchone()[0] == 0)

# ── 8. 时间窗 ──────────────────────────────────────────────────────────────
print("\n=== 8. 时间窗 ===")
conn = fresh_conn()
seed(conn, "c2c:6", ["很久以前说的", "很久以前的第二句"], hours_ago=100)
seed(conn, "c2c:6", ["刚刚说的"], hours_ago=0.1)
res = m.reflect(conn, "c2c:6", hours=24, use_llm=True, llm_caller=fake_llm_ok)
ok("只扫 24h 内的（1 条）", res["scanned"] == 1, res["scanned"])
res = m.reflect(conn, "c2c:6", hours=200, use_llm=True, llm_caller=fake_llm_ok)
ok("放宽到 200h 能扫到全部", res["scanned"] >= 2, res["scanned"])

# ── 9. 边界 ────────────────────────────────────────────────────────────────
print("\n=== 9. 边界 ===")
conn = fresh_conn()
ok("空 peer 不崩", m.reflect(conn, "c2c:999")["scanned"] == 0)
ok("reflect_all 空库不崩", m.reflect_all(conn) == [])
ok("garbage 模型输出不崩", m.reflect(
    fresh_conn(), "c2c:7", llm_caller=fake_llm_garbage)["scanned"] == 0)

print(f"\n结果: {pass_} 通过 / {fail_} 失败")
sys.exit(0 if fail_ == 0 else 1)
