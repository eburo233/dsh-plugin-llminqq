#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""test_owner.py —— 按人归集 / 跨通道可见性（v4）的测试。

覆盖任务要求的五项：
  1. schema 迁移：老库（v3，无 owner 列）平滑升级、不丢数据、只迁移一次
  2. owner 推断：c2c-<qq> → qq；group-<群号> → NULL（除非给了发言人）
  3. recall_for_person 跨 peer 归集
  4. dm_only 在群聊场景被过滤、私聊场景不被过滤
  5. 老的 recall() 行为**逐位不变**（回归保护，固定时间戳 + 逐条比对旧公式）

全部用临时库，绝不碰生产 mem.db。
"""

import importlib.util
import os
import sqlite3
import tempfile

_HERE = os.path.dirname(os.path.abspath(__file__))
_PROD = os.path.join(_HERE, "mem.db")          # 生产库，任何情况下都不能写
spec = importlib.util.spec_from_file_location("m", os.path.join(_HERE, "memctl.py"))
m = importlib.util.module_from_spec(spec)

_TMPDIR = tempfile.mkdtemp(prefix="ownertest-")
m.DB = os.path.join(_TMPDIR, "mem.db")
m.LOG_DIR = os.path.join(_TMPDIR, "log")
m.CURSOR = os.path.join(_TMPDIR, "cursor")
m.DIGEST = os.path.join(_TMPDIR, "digest.md")
# ⚠️ 必须在 exec_module 之后**再**覆盖一次：模块加载时会把 DB 重设成生产路径
spec.loader.exec_module(m)
_TMPDIR2 = tempfile.mkdtemp(prefix="ownertest2-")
m.DB = os.path.join(_TMPDIR2, "mem.db")
m.LOG_DIR = os.path.join(_TMPDIR2, "log")
m.CURSOR = os.path.join(_TMPDIR2, "cursor")
m.DIGEST = os.path.join(_TMPDIR2, "digest.md")
os.makedirs(m.LOG_DIR, exist_ok=True)
assert os.path.abspath(m.DB) != os.path.abspath(_PROD), "测试必须隔离，不能连生产库！"

pass_, fail = 0, 0


def ok(name, cond, detail=""):
    global pass_, fail
    if cond:
        pass_ += 1
        print("  ✓", name)
    else:
        fail += 1
        print("  ✗", name, ("— " + str(detail)) if detail else "")


# ── 1. 老库迁移（v3 → v4）────────────────────────────────────────────────────
print("=== 1. schema 迁移：老库平滑升级、不丢数据、只迁一次 ===")
OLD = os.path.join(_TMPDIR, "old-v3.db")
c = sqlite3.connect(OLD)
# 手工建一个「v3 结构」的库（没有 owner/visibility/is_self）
c.executescript("""
    CREATE TABLE entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT, peer TEXT NOT NULL, kind TEXT NOT NULL,
        text TEXT NOT NULL, fp TEXT NOT NULL, importance REAL NOT NULL DEFAULT 0.5,
        strength REAL NOT NULL DEFAULT 1.0, pinned INTEGER NOT NULL DEFAULT 0,
        hits INTEGER NOT NULL DEFAULT 1, created REAL NOT NULL, last_seen REAL NOT NULL,
        retired INTEGER NOT NULL DEFAULT 0, reflected INTEGER NOT NULL DEFAULT 0
    );
""")
OLD_ROWS = [
    # (peer, kind, text, importance, pinned, last_seen)
    ("c2c-3022464706", "procedural", "规矩：只接信风的活，别人一概不接", 0.88, 1, 1750000000.0),
    ("c2c-3022464706", "semantic", "他在杭州上班，常凌晨五点在线", 0.62, 0, 1750000100.0),
    ("c2c-3022464706", "episodic", "明天下午三点开会，地点3楼", 0.55, 0, 1750000200.0),
    ("group-1017567471", "episodic", "群里的第一条测试记忆内容", 0.40, 0, 1750000300.0),
    ("group-1017567471", "semantic", "他喜欢猫，讨厌下雨天", 0.50, 0, 1750000400.0),
    ("c2c-226002670", "episodic", "我们加个好友吧", 0.30, 0, 1750000500.0),
]
for peer, kind, text, imp, pin, ts in OLD_ROWS:
    c.execute("INSERT INTO entries(peer,kind,text,fp,importance,strength,pinned,hits,"
              "created,last_seen,retired,reflected) VALUES(?,?,?,?,?,?,?,1,?,?,0,0)",
              (peer, kind, text, m.fp(text), imp, 1.0, pin, ts, ts))
c.commit()
c.close()

old_snapshot = [tuple(r) for r in sqlite3.connect(OLD).execute(
    "SELECT id,peer,kind,text,importance,pinned,reflected,last_seen FROM entries ORDER BY id"
).fetchall()]
os.replace(OLD, os.path.join(_TMPDIR, "mig.db"))
MIG = os.path.join(_TMPDIR, "mig.db")
conn = m.connect(MIG)
cols = {r["name"] for r in conn.execute("PRAGMA table_info(entries)")}
ok("新增 owner 列", "owner" in cols, cols)
ok("新增 visibility 列", "visibility" in cols, cols)
ok("新增 is_self 列", "is_self" in cols, cols)
after_snapshot = [tuple(r) for r in conn.execute(
    "SELECT id,peer,kind,text,importance,pinned,reflected,last_seen FROM entries ORDER BY id"
).fetchall()]
ok("老数据一条不丢、字段逐位不变", old_snapshot == after_snapshot,
   [a for a, b in zip(old_snapshot, after_snapshot) if a != b])
ok("条数不变", len(after_snapshot) == len(OLD_ROWS), (len(after_snapshot), len(OLD_ROWS)))
ok("importance 保留手调值（没被重算覆盖）",
   conn.execute("SELECT importance FROM entries WHERE id=1").fetchone()[0] == 0.88)

# 迁移只跑一次：第二次 connect 不该再 alter / 不该改 owner
snap = conn.execute("SELECT id,owner,visibility,is_self FROM entries ORDER BY id").fetchall()
conn.close()
conn = m.connect(MIG)
snap2 = conn.execute("SELECT id,owner,visibility,is_self FROM entries ORDER BY id").fetchall()
ok("第二次 connect 幂等（不重复迁移）", snap == snap2)
ok("integrity_check ok", conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok")

# 回填：c2c 用 peer 推断，group 没有 log 可对 → NULL
ok("迁移后 c2c 记忆 owner=QQ",
   conn.execute("SELECT owner FROM entries WHERE peer='c2c-3022464706' AND id=1").fetchone()[0] == "3022464706")
ok("迁移后 group 记忆 owner=NULL（无日志可对）",
   conn.execute("SELECT owner FROM entries WHERE peer='group-1017567471' AND id=4").fetchone()[0] is None)

# ── 2. owner 推断 ───────────────────────────────────────────────────────────
print("\n=== 2. owner 推断：c2c → QQ，group → NULL ===")
ok("c2c-3022464706 → 3022464706", m.owner_from_peer("c2c-3022464706") == "3022464706")
ok("c2c-226002670 → 226002670", m.owner_from_peer("c2c-226002670") == "226002670")
ok("group-1017567471 → None", m.owner_from_peer("group-1017567471") is None)
ok("group-9137001122 → None", m.owner_from_peer("group-9137001122") is None)
ok("manual → None", m.owner_from_peer("manual") is None)
ok("None 不崩", m.owner_from_peer(None) is None)
ok("空串不崩", m.owner_from_peer("") is None)

# 写入侧：remember 自动从 peer 推断
DB2 = os.path.join(_TMPDIR2, "own2.db")
conn2 = m.connect(DB2)
rid_c2c = m.remember(conn2, "c2c-3022464706", "私聊里说的事：明天三点开会", kind="episodic")
r = conn2.execute("SELECT owner,is_self,visibility FROM entries WHERE id=?", (rid_c2c,)).fetchone()
ok("remember(c2c) 自动 owner=QQ", r["owner"] == "3022464706", dict(r))
ok("remember(c2c) 非自己说的 → is_self=0", r["is_self"] == 0, r["is_self"])
ok("remember 不传 visibility → NULL（当 public）", r["visibility"] is None, r["visibility"])
rid_g = m.remember(conn2, "group-1017567471", "群里说的事：换个头像吧", kind="episodic")
ok("remember(group) 不传 owner → NULL（群号不是人）",
   conn2.execute("SELECT owner FROM entries WHERE id=?", (rid_g,)).fetchone()[0] is None)
rid_g2 = m.remember(conn2, "group-1017567471", "群里说的另一件事：B站那个视频", kind="episodic",
                    owner="3022464706")
ok("remember(group, owner=QQ) → 归到发言人（ingest 走的就是这条）",
   conn2.execute("SELECT owner FROM entries WHERE id=?", (rid_g2,)).fetchone()[0] == "3022464706")
rid_self = m.remember(conn2, "c2c-3022464706", "我自己说的一句话，不算对方的画像",
                      outbound=True)
r = conn2.execute("SELECT owner,is_self FROM entries WHERE id=?", (rid_self,)).fetchone()
ok("出站（outbound）→ is_self=1 且 owner=NULL", r["is_self"] == 1 and r["owner"] is None, dict(r))

# visibility 归一化
ok("'dm_only' 归一", m.normalize_visibility("dm_only") == "dm_only")
ok("'DM_ONLY' 归一（大小写）", m.normalize_visibility("DM_ONLY") == "dm_only")
ok("'public' 归一", m.normalize_visibility("public") == "public")
ok("None 归一为 NULL", m.normalize_visibility(None) is None)
ok("看不懂的值 → NULL（不瞎猜成 dm_only）", m.normalize_visibility("随便什么") is None)

# ── 3. recall_for_person 跨 peer 归集 ───────────────────────────────────────
print("\n=== 3. recall_for_person 跨 peer 归集 ===")
conn2.execute("DELETE FROM entries")
conn2.commit()
QQ = "3022464706"
# 同一个人：私聊说「撤回要加 delete_msg」，群里说「头像换个猫的」，另一个群说「B站那个视频」
m.remember(conn2, "c2c-3022464706", "撤回要另外加 delete_msg 才行", kind="procedural",
           owner=QQ, ts=1750001000.0)
m.remember(conn2, "group-1017567471", "头像想换成猫的，别用默认的", kind="semantic",
           owner=QQ, ts=1750001100.0)
m.remember(conn2, "group-9137001122", "B站那个视频的评论区我还没看", kind="episodic",
           owner=QQ, ts=1750001200.0)
# 另一个人：同名话题，不该被归进来
m.remember(conn2, "c2c-226002670", "撤回是什么意思啊？", kind="episodic", ts=1750001300.0)
m.remember(conn2, "group-1017567471", "头像随便吧，我不在意", kind="episodic",
           owner="226002670", ts=1750001400.0)
# 群级混合摘要：owner 未知
m.remember(conn2, "group-1017567471", "群里的三条要点：接头像、改撤回、看B站", kind="semantic",
           ts=1750001500.0)
# 我自己说的话（出站）：不该混进对方的画像
m.remember(conn2, "c2c-3022464706", "我说过的一句回复，属于风格样本不属于他的画像",
           outbound=True, ts=1750001600.0)
conn2.commit()
m.invalidate_bm25()

peers = m.peers_for_owner(conn2, QQ)
ok("归集覆盖 c2c 和两个群（3 个 peer）", set(peers) == {"c2c-3022464706", "group-1017567471",
                                                     "group-9137001122"}, peers)
res = m.recall_for_person(conn2, QQ, "撤回", top=5)
texts = [r["text"] for _, r in res]
ok("私聊话题能被按人检索到", any("delete_msg" in t for t in texts), texts)
# 注：不用「B站」做查询词 —— 分词器把 "B站" 切成单字「站」，而正文里是 bigram
#     「站那」，这是 v3 就存在的粗分词局限，不是本次改动引入的。
ok("跨群也能检索到（同一个人的另一个群里说的话）",
   any("评论区" in r["text"] for _, r in m.recall_for_person(conn2, QQ, "评论区", top=5)),
   [r["text"][:20] for _, r in m.recall_for_person(conn2, QQ, "评论区", top=5)])
res_av = m.recall_for_person(conn2, QQ, "头像", top=5)
ok("同话题下只归到本人，不混别人（226002670 那条不在结果里）",
   all(r["owner"] == QQ for _, r in res_av if r["owner"] is not None),
   [(r["owner"], r["text"][:20]) for _, r in res_av])
ok("默认不混入我自己说的话（is_self 过滤）",
   all(r["is_self"] == 0 for _, r in m.recall_for_person(conn2, QQ, top=20)))
ok("include_self=True 时才带上自己的话",
   any(r["is_self"] == 1 for _, r in m.recall_for_person(conn2, QQ, top=20, include_self=True)))
ok("不存在的 QQ 返回空", m.recall_for_person(conn2, "999999", "撤回", top=5) == [])
ok("空 query 可用（纯按人+重要性+新近度）", len(m.recall_for_person(conn2, QQ, top=5)) > 0)
ok("返回格式与 recall() 一致（score, Row）",
   res and isinstance(res[0][0], float) and "text" in res[0][1].keys())

# ── 4. dm_only：群聊过滤、私聊放行 ──────────────────────────────────────────
print("\n=== 4. dm_only 在群聊场景被过滤、私聊场景不被过滤 ===")
conn2.execute("DELETE FROM entries")
SECRET = "他私下说这次考试挂了，别在群里提"
sid = m.remember(conn2, "c2c-3022464706", SECRET, kind="semantic", owner=QQ,
                 visibility="dm_only", ts=1750002000.0)
pub = m.remember(conn2, "c2c-3022464706", "他生日是 10 月 26 日，可以群里祝福", kind="semantic",
                 owner=QQ, visibility="public", ts=1750002100.0)
conn2.commit()
m.invalidate_bm25()
ok("set_visibility 能手动标 dm_only", m.set_visibility(conn2, ids=[pub], dm_only=True) == 1)
ok("set_visibility 能标回 public", m.set_visibility(conn2, ids=[pub], dm_only=False) == 1)

dm = m.recall_for_person(conn2, QQ, "考试", top=8, in_group=False)
ok("私聊场景：dm_only 记忆能取到", any(r["id"] == sid for _, r in dm), [r["text"][:20] for _, r in dm])
grp = m.recall_for_person(conn2, QQ, "考试", top=8, in_group=True)
ok("群聊场景：dm_only 记忆被过滤掉", all(r["id"] != sid for _, r in grp), [r["text"][:20] for _, r in grp])
ok("群聊场景：public 记忆照常可取",
   any(r["id"] == pub for _, r in m.recall_for_person(conn2, QQ, "生日", top=8, in_group=True)))
# visibility=NULL 按 public 处理
null_vis = m.remember(conn2, "c2c-3022464706", "未标注可见性的普通记忆：喜欢猫", kind="semantic",
                      owner=QQ, ts=1750002200.0)
conn2.commit()
ok("visibility=NULL 在群聊场景不被过滤（按 public 处理）",
   any(r["id"] == null_vis for _, r in m.recall_for_person(conn2, QQ, "喜欢猫", top=8, in_group=True)))

# ── 5. 老 recall() 逐位不变（回归保护）───────────────────────────────────────
print("\n=== 5. 老 recall() 行为逐位不变（回归保护）===")
AT = 1750100000.0
# 5a 无 query：手算旧公式，逐位比对
r_row = {"id": 1, "text": "开会那条记忆", "importance": 0.55, "pinned": 0,
         "kind": "episodic", "strength": 1.0, "last_seen": 1750000000.0}
got = m.combine(r_row, None, at=AT)
exp = (m.ALPHA_RELEVANCE * 0.5 + m.ALPHA_IMPORTANCE * 0.55
       + m.ALPHA_RECENCY * m.recency(r_row, AT))
ok("无 query 时 combine 与旧公式逐位相同（偏差 0）", got == exp, (got, exp))

# 5b 有 query：直接用「老实现」的函数算，逐条比对
conn3 = m.connect(os.path.join(_TMPDIR2, "regress.db"))
conn3.execute("DELETE FROM entries"); conn3.commit()
for peer, text, ts in [("c2c-3022464706", "明天下午三点开会，地点3楼", 1750000000.0),
                       ("c2c-3022464706", "撤回要加 delete_msg", 1750000030.0),
                       ("group-1017567471", "群里说的开会时间改成四点了", 1750000060.0),
                       ("c2c-3022464706", "他喜欢猫", 1750000090.0)]:
    m.remember(conn3, peer, text, ts=ts)
conn3.commit()
m.invalidate_bm25()


def reference_recall(conn, peer=None, query=None, top=8, min_score=0.05):
    """独立参照实现：不调 recall()/combine()，按文档公式手算。

    公式（memctl.py 顶部注释 + README）：
        score = 0.60·relevance + 0.25·importance + 0.15·recency
        recency = 0.5 ** (age_days / half_life)
        pinned 时 importance 至少 0.8
        有 query 但 relevance==0 → score ×0.25
        最后 × strength
    候选集 = `peer` + `retired=0`（**没有 owner/is_self 过滤** —— 这是老语义核心）。
    """
    HALF = {"episodic": 3.0, "semantic": 60.0, "procedural": 365.0}
    import math as _math
    now = m.now_ts()
    if peer:
        rows = conn.execute("SELECT * FROM entries WHERE peer=? AND retired=0", (peer,)).fetchall()
    else:
        rows = conn.execute("SELECT * FROM entries WHERE retired=0").fetchall()
    qt = m.tokenize(query) if query else None
    idx = m.bm25_index(conn) if qt else None
    out = []
    for r in rows:
        kind = "procedural" if r["pinned"] else r["kind"]
        hl = HALF.get(kind, 14.0)
        age = max(0.0, (now - r["last_seen"]) / 86400.0)
        rec = 0.5 ** (age / hl)
        imp = r["importance"]
        if r["pinned"]:
            imp = max(imp, 0.8)
        if qt:
            rel = idx.score(r["id"], qt)
        else:
            rel = 0.5
        s = 0.60 * rel + 0.25 * imp + 0.15 * rec
        if qt and rel == 0:
            s *= 0.25
        s *= (r["strength"] or 1.0)
        out.append((s, r))
    out.sort(key=lambda x: x[0], reverse=True)
    return [(s, r) for s, r in out[:top] if s >= min_score]


for q in (None, "开会", "撤回", "猫"):
    for peer in (None, "c2c-3022464706", "group-1017567471"):
        old = reference_recall(conn3, peer, q, top=8)
        new = m.recall(conn3, peer, q, top=8)
        same = ([r["id"] for _, r in old] == [r["id"] for _, r in new]
                and all(abs(a[0] - b[0]) < 1e-12 for a, b in zip(old, new)))
        ok(f"recall(peer={peer}, query={q}) 与独立手算公式逐条一致（id + 分数）", same,
           ([(r["id"], round(s, 4)) for s, r in old], [(r["id"], round(s, 4)) for s, r in new]))
# 老语义的核心：recall 候选集不许掺 owner/is_self 过滤
cand = m.recall(conn3, None, None, top=100)
ok("recall 候选集与 `retired=0` 的裸 SQL 一致（没掺 owner/is_self 过滤）",
   {r["id"] for _, r in cand} == {r["id"] for r in conn3.execute(
       "SELECT id FROM entries WHERE retired=0")}, len(cand))
ok("recall 签名没加减必填参数（老调用点 recall(conn,peer,query,top) 可用）",
   len(m.recall(conn3, "c2c-3022464706", "开会", 2)) <= 2)

# 5c recall_with_visibility 向后兼容：算不出 owner 时原样委托 recall()
no_owner = m.recall_with_visibility(conn3, "group-1017567471", "开会", top=8)
legacy_g = m.recall(conn3, "group-1017567471", "开会", top=8)
ok("无 speaker 时 recall_with_visibility 与旧 recall 完全一致（逐条 id + 分数）",
   [r["id"] for _, r in no_owner] == [r["id"] for _, r in legacy_g]
   and all(abs(a[0] - b[0]) < 1e-15 for a, b in zip(no_owner, legacy_g)))

# 有 speaker：跨通道，但仍带本 peer 的 owner=NULL 群级摘要（否则会丢群知识）
with_sp = m.recall_with_visibility(conn3, "group-1017567471", "开会", top=8, speaker="3022464706")
ok("有 speaker 时跨通道并入私聊记忆",
   any(r["peer"].startswith("c2c-") and "开会" in r["text"] for _, r in with_sp),
   [(r["peer"], r["text"][:14]) for _, r in with_sp])
ok("有 speaker 时仍保留本群 owner=NULL 的群级记忆（不丢群知识）",
   any(r["peer"] == "group-1017567471" and r["owner"] is None for _, r in with_sp),
   [(r["peer"], r["owner"], r["text"][:14]) for _, r in with_sp])
ok("include_peer_context=False 时退回纯按人",
   all(r["owner"] is not None for _, r in m.recall_with_visibility(
       conn3, "group-1017567471", "开会", top=8, speaker="3022464706",
       include_peer_context=False)))

# ── 6. 生产库隔离 ───────────────────────────────────────────────────────────
print("\n=== 6. 生产库隔离确认 ===")
for cc in (conn, conn2, conn3):
    path = cc.execute("PRAGMA database_list").fetchone()[2]
    ok("测试连接指向临时库, 不是生产库", os.path.abspath(path) != os.path.abspath(_PROD), path)
    cc.close()

print(f"\n结果: {pass_} 通过 / {fail} 失败")
import sys
sys.exit(0 if fail == 0 else 1)
