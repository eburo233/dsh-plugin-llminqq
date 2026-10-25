#!/usr/bin/env python3
"""
memctl.py —— 分层记忆的落地实现（吉祥物自用）

双层结构：
  短期层：memory/log/<peer>.jsonl   原文流水，按天切，保留最近 7 天
  长期层：memory/mem.db             条目 + 强度 + 半衰期衰减 + 强记忆点（pin）

半衰期规则：
  pinned（强记忆点）  180 天
  fact / person       14 天
  topic               3 天
每次读取时按 0.5 ** (age/half_life) 折算当前强度；
强度低于 0.15 的条目在整理时归档（不删，标记 retired），避免无限膨胀。

用法：
  python3 memory/memctl.py ingest            # 从 bridge 日志增量抓入站消息
  python3 memory/memctl.py remember "内容" --peer c2c-3022464706 --kind fact --pin
  python3 memory/memctl.py recall --peer c2c-3022464706 --top 8
  python3 memory/memctl.py digest            # 生成 memory/digest.md
  python3 memory/memctl.py prune             # 归档衰减到低强度的条目
"""

import argparse
import hashlib
import json
import math
import os
import re
import sqlite3
import sys
import time
from datetime import datetime, timezone

BASE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(BASE, "mem.db")
LOG_DIR = os.path.join(BASE, "log")
CURSOR = os.path.join(BASE, ".ingest_cursor")
BRIDGE_LOG = "/home/jojo/dsh/LLMinQQ/logs/bridge.log"

HALF_LIFE = {"pinned": 180.0, "fact": 14.0, "person": 60.0, "topic": 3.0, "task": 30.0}
DEFAULT_HALF_LIFE = 14.0

# 强记忆点的触发词：说到这些，说明对方在立规矩
# 强记忆点 = 「对我下的长期指令」。只认命令句，不认描述句。
PIN_CUES = ["记住", "记得", "别再", "不要", "别句句", "不准", "禁止", "一律",
            "只和", "只对", "只能", "说好了", "约好", "以后"]

# 无信息量的回话，不入库
NOISE = {"嗯", "哦", "好", "行", "行吧", "好的", "哈哈", "哈哈哈", "哈哈哈哈", "嘻嘻",
         "ok", "OK", "okay", "这还差不多", "确实", "同意", "+1", "收到", "在", "？", "?"}

# 强记忆点还要求带「长期」意味，避免一次性指令被钉死
DURABLE_CUES = ["以后", "每次", "每轮", "每回", "一律", "只和", "只对", "只能",
                "永远", "永久", "说好了", "约好", "都"]

# 分类线索
KIND_CUES = [
    ("task", ["帮我", "做个", "实现", "写个", "加个", "改一下", "需求", "功能"]),
    ("person", ["老大", "SeekDee", "群主", "管理员", "他是", "她在"]),
    ("topic", ["在聊", "最近", "那个", "这事", "话题"]),
]

RE_INBOUND = re.compile(
    r"^(?P<ts>\S+Z) 入站 (?P<peer>[a-z0-9]+:[0-9]+) from=(?P<name>.*?)\((?P<qq>\d+)\) "
    r"text=\"(?P<text>.*?)\" images=(?P<img>\d+)$"
)


def now_ts():
    return time.time()


def connect():
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            peer TEXT NOT NULL,
            kind TEXT NOT NULL,
            text TEXT NOT NULL,
            fp TEXT NOT NULL,
            strength REAL NOT NULL DEFAULT 1.0,
            pinned INTEGER NOT NULL DEFAULT 0,
            hits INTEGER NOT NULL DEFAULT 1,
            created REAL NOT NULL,
            last_seen REAL NOT NULL,
            retired INTEGER NOT NULL DEFAULT 0
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_fp ON entries(peer, fp);
        CREATE INDEX IF NOT EXISTS idx_peer ON entries(peer, retired);
        """
    )
    return conn


def fingerprint(text):
    norm = re.sub(r"[\s\W_]+", "", text.lower())
    return hashlib.sha1(norm.encode("utf-8")).hexdigest()[:16]


def classify(text):
    for kind, cues in KIND_CUES:
        if any(c in text for c in cues):
            return kind
    return "fact"


def is_pin(text):
    """只有「对人说的长期规矩」才算强记忆点。
    门槛：同时出现命令词和长期意味词，且句子不长（长了多半是报告不是规矩）。
    """
    if len(text) > 120:
        return False
    return any(c in text for c in PIN_CUES) and any(c in text for c in DURABLE_CUES)


QUESTION_WORDS = ["吗", "呢", "?", "？", "多少", "怎么", "是不是", "能不能", "会不会"]


def worth_storing(text):
    """只把「有信息量」的话收进长期库。
    问句、寒暄、复读、极短的两三个字，一律只留在短期日志里，不进长期层。
    例外：明确带规矩意味的（记住/以后/不要…）照收，那种哪怕短也重要。
    """
    t = text.strip()
    if len(t) < 2 or t in NOISE:
        return False
    if is_pin(t):
        return True
    # 问句不进长期库
    if any(q in t for q in QUESTION_WORDS) and len(t) < 40:
        return False
    # 纯寒暄/复读：去掉标点后不足 5 个字
    core = re.sub(r"[\s\W_]+", "", t)
    if len(core) < 5:
        return False
    # 长文多半是状态汇报、贴的代码、转发的长消息，留在短期日志里够了
    if len(t) > 200:
        return False
    return True


def score(row, at=None):
    at = at or now_ts()
    kind = "pinned" if row["pinned"] else row["kind"]
    hl = HALF_LIFE.get(kind, DEFAULT_HALF_LIFE)
    age_days = max(0.0, (at - row["last_seen"]) / 86400.0)
    decay = 0.5 ** (age_days / hl)
    return row["strength"] * decay


def remember(conn, peer, text, kind="fact", pin=False, ts=None):
    text = text.strip()
    if not text:
        return None
    if not worth_storing(text):
        return None
    ts = ts or now_ts()
    fp = fingerprint(text)
    row = conn.execute(
        "SELECT * FROM entries WHERE peer=? AND fp=?", (peer, fp)
    ).fetchone()
    if row:
        conn.execute(
            "UPDATE entries SET hits=hits+1, last_seen=?, strength=MIN(1.0, strength+0.15), "
            "pinned=MAX(pinned, ?) WHERE id=?",
            (ts, 1 if pin else 0, row["id"]),
        )
        return row["id"]
    cur = conn.execute(
        "INSERT INTO entries(peer, kind, text, fp, strength, pinned, created, last_seen) "
        "VALUES(?,?,?,?,?,?,?,?)",
        (peer, kind, text, fp, 1.0 if pin else 0.8, 1 if pin else 0, ts, ts),
    )
    return cur.lastrowid


def recall(conn, peer=None, top=8, min_score=0.05):
    if peer is None:
        rows = conn.execute("SELECT * FROM entries WHERE retired=0").fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM entries WHERE peer=? AND retired=0", (peer,)
        ).fetchall()
    ranked = sorted(rows, key=lambda r: score(r), reverse=True)
    return [(score(r), r) for r in ranked[:top] if score(r) >= min_score]


def ingest_bridge(conn, path=BRIDGE_LOG):
    os.makedirs(LOG_DIR, exist_ok=True)
    offset = 0
    if os.path.exists(CURSOR):
        with open(CURSOR, "r", encoding="utf-8") as f:
            offset = int(f.read().strip() or 0)
    if not os.path.exists(path):
        return 0
    size = os.path.getsize(path)
    if size < offset:  # 日志被轮转
        offset = 0
    added = 0
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        f.seek(offset)
        for line in f:
            m = RE_INBOUND.match(line.rstrip("\n"))
            if not m:
                continue
            peer = m.group("peer").replace(":", "-")
            text = m.group("text").replace("\\n", " ").replace('\\"', '"').strip()
            try:
                ts = datetime.strptime(m.group("ts"), "%Y-%m-%dT%H:%M:%S.%fZ").replace(
                    tzinfo=timezone.utc
                ).timestamp()
            except ValueError:
                ts = now_ts()
            kind = classify(text)
            remember(conn, peer, text, kind=kind, pin=is_pin(text), ts=ts)
            short = {"ts": ts, "from": m.group("name"), "qq": m.group("qq"), "text": text}
            day = datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%d")
            p = os.path.join(LOG_DIR, f"{peer}-{day}.jsonl")
            with open(p, "a", encoding="utf-8") as lf:
                lf.write(json.dumps(short, ensure_ascii=False) + "\n")
            added += 1
        offset = f.tell()
    with open(CURSOR, "w", encoding="utf-8") as f:
        f.write(str(offset))
    return added


def prune(conn, cutoff=0.15):
    rows = conn.execute("SELECT * FROM entries WHERE retired=0").fetchall()
    n = 0
    for r in rows:
        if score(r) < cutoff:
            conn.execute("UPDATE entries SET retired=1 WHERE id=?", (r["id"],))
            n += 1
    return n


def digest(conn):
    peers = [r["peer"] for r in conn.execute(
        "SELECT DISTINCT peer FROM entries WHERE retired=0 ORDER BY peer"
    )]
    lines = ["# 记忆摘要（memctl.py 自动生成，别手改）", "",
             f"生成时间：{datetime.now().strftime('%Y-%m-%d %H:%M')}", ""]
    for peer in peers:
        lines.append(f"## {peer}")
        lines.append("")
        items = recall(conn, peer, top=8)
        if not items:
            lines.append("- （空）")
        for s, r in items:
            mark = "★" if r["pinned"] else "·"
            lines.append(f"- {mark} [{r['kind']}|{s:.2f}x{r['hits']}] {r['text']}")
        lines.append("")
    # 跨会话区只放「钉住的规矩」，不放散碎日志
    shared = [(sc, r) for sc, r in recall(conn, None, top=200) if r["pinned"]][:10]
    if shared:
        lines.append("## 跨会话（所有窗口都该知道的）")
        lines.append("")
        for sc, r in shared:
            mark = "★" if r["pinned"] else "·"
            lines.append(f"- {mark} [{r['kind']}|{sc:.2f}] <{r['peer']}> {r['text']}")
        lines.append("")

    with open(os.path.join(BASE, "digest.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    return len(peers)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("ingest")
    p.add_argument("--log", default=BRIDGE_LOG)

    p = sub.add_parser("remember")
    p.add_argument("text")
    p.add_argument("--peer", required=True)
    p.add_argument("--kind", default="fact")
    p.add_argument("--pin", action="store_true")

    p = sub.add_parser("recall")
    p.add_argument("--peer", default=None, help="不传则跨所有会话检索")
    p.add_argument("--top", type=int, default=8)

    p = sub.add_parser("peers")

    sub.add_parser("digest")
    sub.add_parser("prune")

    a = ap.parse_args()
    conn = connect()
    try:
        if a.cmd == "ingest":
            print(f"新增 {ingest_bridge(conn, a.log)} 条")
        elif a.cmd == "remember":
            remember(conn, a.peer, a.text, kind=a.kind, pin=a.pin)
            print("ok")
        elif a.cmd == "recall":
            for sc, r in recall(conn, a.peer, top=a.top):
                mark = "★" if r["pinned"] else " "
                tag = "" if a.peer else f" <{r['peer']}>"
                print(f"{mark}{sc:5.2f}  [{r['kind']}/{r['hits']}]{tag} {r['text']}")
        elif a.cmd == "peers":
            for r in conn.execute(
                "SELECT peer, COUNT(*) n FROM entries WHERE retired=0 GROUP BY peer ORDER BY n DESC"
            ):
                print(f"{r['peer']}\t{r['n']}")
        elif a.cmd == "digest":
            print(f"写入 {digest(conn)} 个会话")
        elif a.cmd == "prune":
            print(f"归档 {prune(conn)} 条")
        conn.commit()
    finally:
        conn.close()


if __name__ == "__main__":
    main()
