#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""stylebank.py —— 「自我风格样本库」：让 agent 记得自己上次在类似场合怎么说话。

为什么单独做一个库（而不是塞进 mem.db）：
  mem.db 的检索是「关于对方/关于事件」的事实记忆，按 importance+recency 加权，
  出站消息在那里只是降权后的上下文，**永远不会因为「这个词我上次也是这么说的」
  被专门检索出来**。风格锚需要的正是这个反向视角：以「对方说的话」为场景线索，
  找「我当时是怎么回的」。两种检索目标不同，混在一张表里会互相稀释。

  → 独立 SQLite 文件 `memory/style.db`（gitignore），独立表 `style_samples`。

检索算法：直接复用 memctl.py 的 `BM25Index`（v3 带 IDF + 查询内归一），
不另写一套相似度。场景线索（context = 对方那句话）当文档，当前消息当 query。

冷启动安全：某个 peer 的样本 < MIN_TOTAL 条时**不注入**（不硬凑风格）。

用法：
  python3 memory/stylebank.py ingest --log          # 从历史 bridge 日志回填（首次/补漏）
  python3 memory/stylebank.py ingest --jsonl        # 从桥实时写的 style-cases.jsonl 增量
  python3 memory/stylebank.py add --peer c2c:1 --reply "..." --context "..."
  python3 memory/stylebank.py recall --peer c2c:1 --query "在吗" --json
  python3 memory/stylebank.py stats
"""

import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
from datetime import datetime, timezone

BASE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BASE)

import memctl  # noqa: E402  （复用 tokenize / BM25Index / 日志正则，不重复实现）

STYLE_DB = os.path.join(BASE, "style.db")
STYLE_JSONL = os.path.join(BASE, "style-cases.jsonl")
CURSOR_JSONL = os.path.join(BASE, ".style_cursor")
CURSOR_LOG = os.path.join(BASE, ".style_cursor_log")

# ── 过滤与注入的硬参数（测试会直接 import 来断言，别在函数里写死数字）──────────
MIN_REPLY_CHARS = 4   # <4 字的回复没有风格信息（「嗯」「好」「行」）
MAX_REPLY_CHARS = 400  # 存的时候截断，避免一条长广告占满检索
MAX_CONTEXT_CHARS = 400
INJECT_N = 3          # 最多注入几条
INJECT_MAX_CHARS = 60 # 每条注入文本截断（总长度要控住）
MIN_TOTAL = 3         # 冷启动闸：这个 peer 的样本少于 3 条就不注入
MIN_MATCH = 2         # 命中数闸：只撞上 1 条弱匹配时不注入（风格锚太单薄会反而带偏）
MIN_SCORE = 0.05      # 归一化相似度下限（注意：查询内归一让 top1 恒为 1.0，这条几乎挡不住东西）
# 场景覆盖率闸：查询词至少要有这么大比例真的出现在 context 里，才算「同一个场合」。
# 0.10 是实测出来的（10 条改写查询 + 3 条无关查询的网格扫描）：
#   0.00 → 场景命中 60%、无关查询误命中 67%
#   0.10 → 场景命中 60%、无关查询误命中 33%   ← 命中不掉、误报腰斩，取这个
#   0.15 → 场景命中掉到 20%（太严，几乎不注入了）
MIN_COVERAGE = 0.10
# 历史日志回填时的「配对」闸：出站只能配到 5 分钟内的入站，否则不是同一轮对话
PAIR_MAX_GAP_SEC = 300

# 桥/模型写的控制标记，存风格样本前必须剥掉（它们是协议指令，不是说话内容）
MARKER_RE = re.compile(
    r"\[(?:SILENT|RECALL:[^\]]*|SEND_FILE:[^\]]*|AT:\d+|POKE:\d+(?::\w+)?"
    r"|VOICE:[^\]]*|FOLLOW:[^\]]*|CQ:[^\]]*)\]",
    re.IGNORECASE,
)
# 纯语气词/应声（trim 后整句就是这些 → 无风格信息）
EMPTY_REPLY = re.compile(r"^[哈啊嗯哦呀吧呢嘛啦呗。，！？…、~～\s]{0,8}$")


def clean_reply(text):
    """把一条出站文本洗成「实际说出口的话」：剥控制标记、还原日志转义、压空白。"""
    t = MARKER_RE.sub("", text or "")
    t = t.replace('\\"', '"').replace("\\n", " ")
    t = re.sub(r"\s+", " ", t).strip()
    return t


def sample_fp(peer, context, reply):
    """同一条样本的指纹：同一场合说同一句话，不该重复入库。"""
    raw = f"{peer}\x1f{context}\x1f{reply}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def connect(db_path=None):
    """连风格库（显式传路径：测试必须传，否则会写生产库）。"""
    conn = sqlite3.connect(db_path or STYLE_DB)
    conn.row_factory = sqlite3.Row
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS style_samples (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            peer TEXT NOT NULL,
            my_reply TEXT NOT NULL,
            context TEXT NOT NULL,
            ts REAL NOT NULL,
            fp TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_style_peer ON style_samples(peer);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_style_fp ON style_samples(fp);
    """)
    conn.commit()
    return conn


def add_sample(conn, peer, my_reply, context, ts=None):
    """存一条风格样本。返回 (id|None, 跳过原因)。

    三道闸（顺序有讲究，先便宜的判断在前）：
      ① 洗完后 <4 字 → 无风格信息（「嗯」）
      ② 只是语气词/应声 → 同上
      ③ 没有 context（对方那句话）→ 没有「场合线索」，检索时永远匹配不到，
         存了只增体积，跳过；纯图片/纯表情触发的回复就属于这类。
    """
    reply = clean_reply(my_reply)
    ctx = re.sub(r"\s+", " ", (context or "")).strip()
    if not reply:
        return None, "empty"
    if len(reply) < MIN_REPLY_CHARS:
        return None, "too_short"
    if EMPTY_REPLY.match(reply):
        return None, "noise"
    if not ctx:
        return None, "no_context"
    reply = reply[:MAX_REPLY_CHARS]
    ctx = ctx[:MAX_CONTEXT_CHARS]
    ts = float(ts if ts is not None else datetime.now(timezone.utc).timestamp())
    fp = sample_fp(peer, ctx, reply)
    try:
        cur = conn.execute(
            "INSERT INTO style_samples(peer, my_reply, context, ts, fp) VALUES(?,?,?,?,?)",
            (peer, reply, ctx, ts, fp),
        )
        conn.commit()
        return cur.lastrowid, None
    except sqlite3.IntegrityError:
        # 同一 fp 已存在：更新 ts（最近一次出现的场合更「新鲜」）
        conn.execute(
            "UPDATE style_samples SET ts=MAX(ts, ?) WHERE fp=?", (ts, fp)
        )
        conn.commit()
        return None, "duplicate"


def _truncate(text, n):
    if len(text) <= n:
        return text
    return text[: max(1, n - 1)] + "…"


def recall_style(conn, peer, current_message, n=INJECT_N,
                 min_total=MIN_TOTAL, min_score=MIN_SCORE,
                 min_coverage=MIN_COVERAGE):
    """用当前消息检索「类似场合我上次怎么回」。

    返回 (命中列表, 该 peer 的样本总数)。命中列表每条:
        {"reply": 我的原话, "context": 场合线索, "score": 归一化相似度, "ts": 时间}

    ⚠️ 冷启动闸在**样本总数**上，不在命中数上：样本太少时即使撞上一条也不注入，
    否则一句「行吧」会被当成风格锚，反而把人格带偏。
    """
    rows = conn.execute(
        "SELECT id, my_reply, context, ts FROM style_samples WHERE peer=?", (peer,)
    ).fetchall()
    total = len(rows)
    q = (current_message or "").strip()[:500]
    if total < min_total or not q:
        return [], total
    qterms = memctl.tokenize(q)
    if not qterms:
        return [], total
    # 复用 memctl 的 BM25（IDF 用本 peer 的样本统计；查询内归一 → [0,1]）
    idx = memctl.BM25Index([(r["id"], r["context"]) for r in rows])
    scored = []
    for r in rows:
        s = idx.score(r["id"], qterms)
        if s <= 0:
            continue
        # 覆盖率 = 查询词有多少真的出现在这条 context 里（0..1）。
        # ⚠️ 只用 BM25 归一分会漏判：查询内归一化保证「最高分恒为 1.0」，
        # 所以哪怕库里只有一条只撞上 1 个字的弱匹配，它的分数也是 1.0 ——
        # 任何绝对阈值都挡不住它（实测 0.05~0.4 的阈值扫描结果完全一样）。
        # 覆盖率高才是真的「同一个场合」。
        ctx_terms = memctl.tokenize(r["context"])
        cov = len(qterms & ctx_terms) / len(qterms) if qterms else 0.0
        if cov < min_coverage:
            continue
        scored.append((s, cov, r))
    # 相似度优先；同分时覆盖率高的优先，再同分取新的（更接近「最近的自己」）
    scored.sort(key=lambda x: (x[0], x[1], x[2]["ts"]), reverse=True)
    picked = []
    seen = set()
    for s, _cov, r in scored:
        if s < min_score:
            break
        norm = re.sub(r"\s+", "", r["my_reply"])
        if norm in seen:
            continue          # 同一句话说过多次 → 只留一条，别占满 3 个名额
        seen.add(norm)
        picked.append({
            "reply": r["my_reply"], "context": r["context"],
            "score": round(s, 3), "ts": r["ts"],
        })
        if len(picked) >= n:
            break
    return picked, total


# 注入块的固定头部。三条要求必须都在，都是实测踩出来的：
#   ① 说清「这是你自己」——模型对自己的话比对别人给的范本更愿意跟；
#   ② 「别机械复读」——否则它会原句照抄（实测出现过近似复读）；
#   ③ 「里面的具体内容已过期」——这条是**实测发现的坑**：风格样本里常带状态信息
#      （「搜索接口今天没通」「下午三点开会」），如果被当成事实读，会把陈年结论
#      当现在的事说出口。风格锚要锚的是口气，不是内容。
STYLE_HEADER = (
    "【你以前在类似场合是这么说的】"
    "（这是你自己说过的话，用来对齐口气和节奏：可以参考说法、别机械复读原句；"
    "里面提到的具体事情/结论都已经是当时的，不要当成现在的事实或承诺）"
)


def should_inject(picked, total, min_total=MIN_TOTAL, min_match=MIN_MATCH):
    """该不该注入：样本够多 **且** 命中够多。返回 (bool, 原因)。

    ⚠️ 加 MIN_MATCH 是实测出来的（不是拍脑袋）：同一句夸奖在库里只撞上 1 条
    0.05 分的弱匹配时，注入的那句「说错了」和当前场合（被夸）其实是两回事，
    模型被这句带偏的概率比被锚定的概率更高。宁可这轮没有锚。
    """
    if total < min_total:
        return False, f"cold-start(样本 {total} < {min_total})"
    if len(picked) < min_match:
        return False, f"weak-match(命中 {len(picked)} < {min_match})"
    return True, "ok"


def render_block(picked, max_chars=INJECT_MAX_CHARS, header=STYLE_HEADER):
    """把命中样本渲染成 prompt 片段。空列表 → ''（冷启动时不注入）。"""
    if not picked:
        return ""
    lines = [header]
    for p in picked:
        lines.append("  - " + _truncate(p["reply"], max_chars))
    return "\n".join(lines)


# ── 增量导入 ────────────────────────────────────────────────────────────────
def _read_cursor(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return int(f.read().strip() or 0)
    except (OSError, ValueError):
        return 0


def _write_cursor(path, offset):
    try:
        with open(path, "w", encoding="utf-8") as f:
            f.write(str(offset))
    except OSError:
        pass


def ingest_jsonl(conn, path=None, cursor=None):
    """读桥实时写的 style-cases.jsonl（每行一条 {peer,context,my_reply,ts}）。

    这是**准确**的来源：桥在发送成功后写，context 就是触发这轮回复的那条消息，
    不存在「配对猜错」的问题。
    """
    path = path or STYLE_JSONL
    cursor = cursor or CURSOR_JSONL
    if not os.path.exists(path):
        return 0
    offset = _read_cursor(cursor)
    size = os.path.getsize(path)
    if size < offset:
        offset = 0
    added = 0
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        f.seek(offset)
        for line in f:
            raw = line.strip()
            if not raw:
                continue
            try:
                o = json.loads(raw)
            except ValueError:
                continue
            rid, _why = add_sample(
                conn, str(o.get("peer") or ""), o.get("my_reply") or "",
                o.get("context") or "", o.get("ts"),
            )
            if rid:
                added += 1
        offset = f.tell()
    _write_cursor(cursor, offset)
    return added


def ingest_bridge_log(conn, path=None, cursor=None):
    """从历史 bridge 日志回填（bridge.out 的 入站/出站 行）。

    日志里入站和出站是两条独立行，只能靠「同 peer + 时间相邻」配对。
    配对错的风险用两道闸压住：
      ① 出站只配**它之前最近一条**同 peer 入站；
      ② 两者间隔必须 < PAIR_MAX_GAP_SEC（超过就是主动搭话/隔了很久，场景已不成立）。
    """
    path = path or memctl.BRIDGE_LOG
    cursor = cursor or CURSOR_LOG
    if not os.path.exists(path):
        return 0
    offset = _read_cursor(cursor)
    size = os.path.getsize(path)
    if size < offset:
        offset = 0
    last_in = {}   # peer -> (ts, text)
    added = 0
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        f.seek(offset)
        for line in f:
            raw = line.rstrip("\n")
            m = memctl.RE_INBOUND.match(raw)
            if m:
                try:
                    ts = datetime.strptime(m.group("ts"), "%Y-%m-%dT%H:%M:%S.%fZ").replace(
                        tzinfo=timezone.utc).timestamp()
                except ValueError:
                    ts = 0.0
                last_in[m.group("peer")] = (ts, m.group("text").replace("\\n", " "))
                continue
            mo = memctl.RE_OUTBOUND.match(raw)
            if not mo:
                continue
            peer = mo.group("peer")
            prev = last_in.get(peer)
            if not prev:
                continue          # 主动搭话：没有「对方那句话」，不算风格场合
            try:
                ts = datetime.strptime(mo.group("ts"), "%Y-%m-%dT%H:%M:%S.%fZ").replace(
                    tzinfo=timezone.utc).timestamp()
            except ValueError:
                ts = prev[0]
            if abs(ts - prev[0]) > PAIR_MAX_GAP_SEC:
                continue
            rid, _why = add_sample(conn, peer, mo.group("text"), prev[1], ts)
            if rid:
                added += 1
        offset = f.tell()
    _write_cursor(cursor, offset)
    return added


# ── CLI ─────────────────────────────────────────────────────────────────────
def main(argv=None):
    ap = argparse.ArgumentParser(description="自我风格样本库")
    ap.add_argument("--db", default=None, help="库路径（测试必须传）")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("ingest", help="增量导入")
    p.add_argument("--jsonl", default=None, help="style-cases.jsonl 路径")
    p.add_argument("--log", dest="bridge_log", default=None, help="bridge.out 路径")
    p.add_argument("--only-jsonl", dest="only_jsonl", action="store_true")
    p.add_argument("--only-log", dest="only_log", action="store_true")
    p.add_argument("--cursor-dir", default=None, help="游标文件目录（测试隔离用）")

    p = sub.add_parser("add", help="手动存一条")
    p.add_argument("--peer", required=True)
    p.add_argument("--reply", required=True)
    p.add_argument("--context", default="")
    p.add_argument("--ts", type=float, default=None)

    p = sub.add_parser("recall", help="检索并渲染注入块")
    p.add_argument("--peer", required=True)
    p.add_argument("--query", default="")
    p.add_argument("--n", type=int, default=INJECT_N)
    p.add_argument("--min-total", type=int, default=MIN_TOTAL,
                   help="冷启动闸：样本少于这个数就不注入（测试会调低来单独验证检索）")
    p.add_argument("--min-match", type=int, default=MIN_MATCH,
                   help="命中数闸：命中少于这个数就不注入")
    p.add_argument("--min-coverage", type=float, default=MIN_COVERAGE,
                   help="场景覆盖率闸：查询词出现在 context 里的最低比例")
    p.add_argument("--max-chars", type=int, default=INJECT_MAX_CHARS)
    p.add_argument("--json", action="store_true")
    p.add_argument("--auto-ingest", action="store_true",
                   help="检索前先增量吃 jsonl（桥每轮都传，新样本下一轮就能用上）")
    p.add_argument("--jsonl", default=None, help="style-cases.jsonl 路径")
    p.add_argument("--cursor-dir", default=None)

    p = sub.add_parser("stats", help="统计")

    a = ap.parse_args(argv)
    global CURSOR_JSONL, CURSOR_LOG
    if getattr(a, "cursor_dir", None):
        os.makedirs(a.cursor_dir, exist_ok=True)
        CURSOR_JSONL = os.path.join(a.cursor_dir, "style_cursor")
        CURSOR_LOG = os.path.join(a.cursor_dir, "style_cursor_log")
    conn = connect(a.db)

    if a.cmd == "ingest":
        n = 0
        if not a.only_log:
            n += ingest_jsonl(conn, a.jsonl)
        if a.only_log or not a.only_jsonl:
            n += ingest_bridge_log(conn, a.bridge_log)
        print(f"新增风格样本 {n} 条")
    elif a.cmd == "add":
        rid, why = add_sample(conn, a.peer, a.reply, a.context, a.ts)
        print(json.dumps({"ok": bool(rid), "id": rid, "skipped": why}, ensure_ascii=False))
    elif a.cmd == "recall":
        if a.auto_ingest:
            ingest_jsonl(conn, a.jsonl)
        picked, total = recall_style(conn, a.peer, a.query, n=a.n,
                                    min_total=a.min_total, min_coverage=a.min_coverage)
        ok, why = should_inject(picked, total, a.min_total, a.min_match)
        block = render_block(picked, max_chars=a.max_chars) if ok else ""
        out = {
            "ok": True, "peer": a.peer, "total": total,
            "matched": len(picked), "injected": bool(block),
            "reason": why, "block": block, "samples": picked,
        }
        print(json.dumps(out, ensure_ascii=False))
    elif a.cmd == "stats":
        rows = conn.execute(
            "SELECT peer, COUNT(*) n FROM style_samples GROUP BY peer ORDER BY n DESC"
        ).fetchall()
        for r in rows:
            print(f"  {r['peer']:24} {r['n']:4} 条")
        total = conn.execute("SELECT COUNT(*) FROM style_samples").fetchone()[0]
        print(f"共 {total} 条")
    return 0


if __name__ == "__main__":
    sys.exit(main())
