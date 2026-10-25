#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
memctl.py —— 吉祥物的记忆系统 v2（按 Stanford Generative Agents 论文重构）

原 v1 的问题（实测发现的）：
  - 检索**只看时间**（半衰期衰减）→ 越新越有用。可「三小时前的一句废话」
    会排在「一个月前他说的重要约定」前面。
  - 没有 importance → 不知道哪条重要。222 条记录里大部分是
    「唔，好毒，好像人」「回个干啥就好了」这种噪音。
  - 没有 relevance → 问一个话题时检索不到相关的旧事，只看谁新。

v2 按论文的检索公式（Generative Agents, arXiv:2304.03442 §4.1）：
    score = α_relevance·relevance + α_importance·importance + α_recency·recency
  三者归一到 [0,1]，等权（论文用的就是等权）。

记忆分三层（认知科学标准分法，也是 MemGPT/Mem0 的共识）：
  procedural 程序记忆：约定/规矩/怎么做事（几乎不衰减，一年）
  semantic   语义记忆：稳定事实（他是谁、喜欢什么、什么关系，60 天）
  episodic   情节记忆：具体对话片段（衰减快，3 天）

用法：
  python3 memory/memctl.py ingest                    # 从 bridge 日志增量抓
  python3 memory/memctl.py digest                    # 重生成 digest.md（分三层）
  python3 memory/memctl.py recall --peer c2c-3022464706 --query "开会" --top 8
  python3 memory/memctl.py remember "内容" --peer c2c-3022464706 --kind semantic --pin
  python3 memory/memctl.py consolidate               # 情节→语义提炼
  python3 memory/memctl.py stats                     # 库里有什么
  python3 memory/memctl.py prune                     # 归档低价值记忆
"""

import argparse
import hashlib
import json
import math
import os
import re
import sqlite3
import sys
from datetime import datetime, timezone

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

BASE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(BASE, "mem.db")
LOG_DIR = os.path.join(BASE, "log")
CURSOR = os.path.join(BASE, ".ingest_cursor")
BRIDGE_LOG = "/home/jojo/dsh/LLMinQQ/logs/bridge.out"
DIGEST = os.path.join(BASE, "digest.md")

# ── 衰减半衰期（天）：三层各不相同 ──────────────────────────────────────────
# 语义记忆活得久（事实不会因时间不成立），情节记忆活得短（具体场景会模糊），
# 程序记忆几乎不衰减（约定/规矩就是该一直记着）。
HALF_LIFE = {
    "episodic": 3.0,
    "semantic": 60.0,
    "procedural": 365.0,
}
DEFAULT_HALF_LIFE = 14.0

# 检索公式权重。
# 论文用等权（1/3 各），但实测发现**等权在聊天场景下有坑**：
#   query=「情绪」时，一条 relevance=0.32 的记忆（正好聊情绪）
#   会输给一条 relevance=0 + importance=0.8（开会安排），
#   因为 importance 高 + recency 新，两项加起来压过了相关性。
#   结果就是「问 A 却答 B」。
# 所以这里把 relevance 提到主导（显式 query 时它是用户真正在问的东西）。
ALPHA_RELEVANCE = 0.60
ALPHA_IMPORTANCE = 0.25
ALPHA_RECENCY = 0.15

STOPWORDS = set("""
的 了 我 你 他 她 它 们 是 在 有 和 就 都 而 及 与 着 或 一个 没有 我们 你们
这 那 这个 那个 什么 怎么 为什么 不 也 很 还 要 会 能 可以 但是 但 因为 所以
啊 吧 呢 呀 哦 嗯 哈 嘛 啦 呗 么 个 些 上 下 中 里 外 好 对 说 去 来 过 到
""".split())

RE_INBOUND = re.compile(
    r"^(?P<ts>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\s+入站\s+(?P<peer>[^\s]+)\s+"
    r"from=(?P<name>[^(\n]+)\((?P<qq>\d+)\)\s+text=\"(?P<text>.*?)\"\s+images=\d+"
)

# 出站（我自己说的话）。重要性要打折：记忆该以「对方告诉我的」为主，
# 我自己的话只是让对话有上下文，不该和约定同权重。
RE_OUTBOUND = re.compile(
    r"^(?P<ts>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\s+出站\s+(?P<peer>[^\s]+)\s+"
    r"text=\"(?P<text>.*?)\"\s+chars=\d+"
)

# 无信息量的回话，不入库
NOISE = {
    "嗯", "哦", "好", "行", "行吧", "好的", "哈哈", "哈哈哈", "哈哈哈哈", "嘻嘻",
    "？", "??", "!", "！", "在", "在呢", "收到", "ok", "OK", "okay", "+1", "1",
    "笑死", "草", "牛逼", "666", "确实", "同意", "有道理", "对对对", "这还差不多",
}

# 长期意味词（重要性 + pin 判定共用）
IMPORTANT_WORDS = [
    "记住", "以后", "每次", "一律", "默认", "规矩", "约定", "长期", "说好了",
    "重要", "必须", "不要", "别忘", "提醒", "安排", "计划", "喜欢", "讨厌",
    "生日", "名字", "叫我", "家住", "上班", "公司", "学校", "医院",
]
IMPORTANT_RE = re.compile("|".join(IMPORTANT_WORDS))


def now_ts():
    return datetime.now(timezone.utc).timestamp()


def fp(text):
    """指纹：同一句话不同时间说，算同一条记忆（避免重复膨胀）。"""
    norm = re.sub(r"\s+", "", text or "")
    return hashlib.sha1(norm.encode("utf-8")).hexdigest()[:16]


def tokenize(text):
    """粗分词：中文按二元组，英文按词。不依赖分词库，够用。"""
    t = (text or "").lower()
    tokens = set()
    for w in re.findall(r"[a-z0-9_]{2,}", t):
        tokens.add(w)
    for seg in re.findall(r"[\u4e00-\u9fff]+", t):
        for i in range(len(seg) - 1):
            bg = seg[i:i + 2]
            if bg not in STOPWORDS:
                tokens.add(bg)
        if len(seg) == 1 and seg not in STOPWORDS:
            tokens.add(seg)
    return tokens


def estimate_importance(text, kind=None):
    """这条记忆有多重要（0..1，要求有区分度）。

    论文让 LLM 打 1-10 分。这里不调 LLM（每轮都要打分，太贵），
    用可解释的启发式。

    ⚠️ 第一版失败过：分数公式把 90% 的条目挤在 0.26，最高只到 0.42，
    导致 importance 在检索里几乎不起作用（全都一样）。原因是
    「长度分 × 0.35 + 长期词 × 0.35 + 实体 × 0.30」三项都很少同时命中，
    加权后被稀释。v2 改成：**基础分 + 加分项**，让差异说得清。
    """
    t = (text or "").strip()
    if not t or t in NOISE:
        return 0.02
    if re.fullmatch(r"[哈啊嗯哦呀吧呢嘛啦呗。，！？…\s]+", t):
        return 0.02

    n = len(t)
    # ── 基础分：由信息量决定（长度是最强的信号）──────────────────────
    if n < 6:
        base = 0.08       # 「嗯」「好」这种
    elif n < 12:
        base = 0.20
    elif n < 25:
        base = 0.35
    elif n < 60:
        base = 0.50
    elif n < 150:
        base = 0.58
    else:
        base = 0.50       # 太长可能是整段粘贴，反而降

    # ── 加分项（每项独立，累加）────────────────────────────────────
    bonus = 0.0
    # 长期意味词：这是「该记住」的最强信号
    hits = len(IMPORTANT_RE.findall(t))
    bonus += min(0.30, hits * 0.12)
    # 实体：时间/地点/数字
    if re.search(r"\d{1,2}[:：]\d{2}|\d{1,2}[月日]|\d{4}-\d{1,2}-\d{1,2}", t):
        bonus += 0.15
    if re.search(r"\d+楼|会议室|家里|公司|学校|医院", t):
        bonus += 0.10
    if re.search(r"\d{5,}", t):
        bonus += 0.08
    # 明确的观点/偏好陈述
    if re.search(r"(我觉得|我喜欢|我讨厌|我要|我打算|我习惯|我一般)", t):
        bonus += 0.12
    # 第一人称叙述（比第三人称的闲聊更可能是关于自己的事实）
    if re.search(r"(我|你)", t):
        bonus += 0.05

    score = base + bonus
    # 类型下限：程序记忆（规矩/约定）天然重要
    if kind == "procedural":
        score = max(score, 0.70)
    elif kind == "semantic":
        score = max(score, 0.45)
    return max(0.0, min(1.0, score))


def classify(text):
    """粗分类三层。不追求准，追求「别把约定当废话降权」。"""
    t = text or ""
    if re.search(r"(记住|以后|每次|一律|默认|规矩|约定|说好了|必须|不要|别)", t):
        return "procedural"
    if re.search(r"(我(叫|是|住|在|喜欢|讨厌|有|没)|他(叫|是|住|在)|生日|年龄|工作|职业)", t):
        return "semantic"
    return "episodic"


# 不像「约定」的句式：疑问、讨论过程、我在汇报状态、感叹
NOT_RULE = re.compile(
    r"(咋样|怎么样|行不行|好不好|吗？|吗$|吧？|\?|？$"
    r"|已开启|已启动|已写入|已提交|tests? passed|通过\s*$"
    r"|我觉得|可能是|估计|也许)"
)
# 真正的约定通常这样开头/包含
RULE_SHAPE = re.compile(
    r"(规矩|约定|说好了|定好|只接|只对|只能|一律|默认|必须|不要|别|记住"
    r"|以后(都|每次)|每次(都|要)|长期)"
)


def is_pin(text):
    """强记忆点：必须是「讲清楚的一条规矩」才钉住。

    踩过的坑：v1 里「那我以后给你正个咋样」「已开启：proactive…」
    这种讨论过程/状态汇报也被钉住了，结果 10 条 pin 里有一半是噪音。
    所以这里加三道闸：
      ① 不能是疑问句或讨论语气
      ② 不能是「我已开启/已提交」这类状态汇报（那是我的话，不是他的约定）
      ③ 得真的有规矩的句式
    """
    t = (text or "").strip()
    if len(t) < 8:
        return False                      # 太短不可能是完整规矩
    if NOT_RULE.search(t):
        return False
    # ① 「规矩类」：讲的是以后该怎么做
    hard = re.search(r"(记住|必须|一律|只对|只接|只能|以后都)", t)
    longterm = re.search(r"(以后|每次|一律|默认|长期|说好了|规矩|约定)", t)
    if hard and longterm and RULE_SHAPE.search(t):
        return True
    # ② 「重要事实类」：带明确时空锚（明天/几点/几楼/日期）的承诺和安排，
    #    不满足规矩句式但同样该钉住（否则时间一过就检索不到）。
    if re.search(r"(明天|后天|下周|下次|周[一二三四五六日])", t) and \
       re.search(r"(\d{1,2}[:：]\d{2}|上午|下午|晚上|点)", t) and \
       re.search(r"(开会|见面|约|安排|记得|别忘|提醒)", t):
        return True
    return False


def connect():
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            peer TEXT NOT NULL,
            kind TEXT NOT NULL,
            text TEXT NOT NULL,
            fp TEXT NOT NULL,
            importance REAL NOT NULL DEFAULT 0.5,
            strength REAL NOT NULL DEFAULT 1.0,
            pinned INTEGER NOT NULL DEFAULT 0,
            hits INTEGER NOT NULL DEFAULT 1,
            created REAL NOT NULL,
            last_seen REAL NOT NULL,
            retired INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_peer ON entries(peer);
        CREATE INDEX IF NOT EXISTS idx_kind ON entries(kind);
    """)
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(entries)")}
    fresh = "importance" not in cols
    if fresh:
        conn.execute("ALTER TABLE entries ADD COLUMN importance REAL NOT NULL DEFAULT 0.5")
    # v1 的 kind（fact/person/topic/task/约定）→ v2 三层
    for old_k, new_k in [("fact", "episodic"), ("person", "semantic"),
                         ("topic", "episodic"), ("task", "procedural")]:
        conn.execute("UPDATE entries SET kind=? WHERE kind=?", (new_k, old_k))
    conn.execute("UPDATE entries SET kind='procedural' WHERE kind='约定'")
    # ⚠️ 只在首次迁移时补算 importance。之后必须尊重已存的值，
    #    否则每次 connect 都会把手动调过的重要性覆盖掉。
    if fresh:
        for r in conn.execute("SELECT id, text, pinned FROM entries").fetchall():
            imp = estimate_importance(r["text"])
            if r["pinned"]:
                imp = max(imp, 0.8)
            conn.execute("UPDATE entries SET importance=? WHERE id=?", (imp, r["id"]))
    conn.commit()
    return conn


def recency(row, at=None):
    """recency → [0,1]：越近越接近 1。"""
    at = at or now_ts()
    kind = "procedural" if row["pinned"] else row["kind"]
    hl = HALF_LIFE.get(kind, DEFAULT_HALF_LIFE)
    age_days = max(0.0, (at - row["last_seen"]) / 86400.0)
    return 0.5 ** (age_days / hl)


def relevance(row, query_tokens):
    """relevance：查询词与记忆的重合度。没有 query 时返回中性 0.5。"""
    if not query_tokens:
        return 0.5
    mem_tokens = tokenize(row["text"])
    if not mem_tokens:
        return 0.0
    inter = len(query_tokens & mem_tokens)
    if inter == 0:
        return 0.0
    # 命中数 / sqrt(长度)：长记忆不因长而被罚
    return min(1.0, inter / math.sqrt(len(mem_tokens)))


def combine(row, query_tokens=None, at=None):
    """论文公式：score = α_rel·relevance + α_imp·importance + α_rec·recency

    加了一条论文没有的规则：**给了 query 但零重合 → 强折减**。
    否则「问情绪」会被一条毫不相关的「开会安排」抢答（实测踩过）。
    """
    r = recency(row, at)
    imp = row["importance"] if "importance" in row.keys() else 0.5
    if row["pinned"]:
        imp = max(imp, 0.8)
    rel = relevance(row, query_tokens)
    base = ALPHA_RELEVANCE * rel + ALPHA_IMPORTANCE * imp + ALPHA_RECENCY * r
    # 有 query 却完全无关 → 折到 25%（排序靠后，但钉住的还能兜底出现）
    if query_tokens and rel == 0:
        base *= 0.25
    strength = row["strength"] if row["strength"] else 1.0
    return base * strength


def remember(conn, peer, text, kind=None, pin=False, ts=None, importance=None, outbound=False):
    t = (text or "").strip()
    if not t or t in NOISE:
        return None
    kind = kind or classify(t)
    if outbound:
        # 我自己说的话：永远算情节记忆，重要性打 6 折，也绝不 pin
        kind = "episodic"
        pin = False
        if importance is None:
            importance = estimate_importance(t) * 0.6
    if pin and kind == "episodic":
        # 能钉住的多半是「约定/规矩」→ 归到程序记忆，别让它按情节记忆 3 天衰减
        kind = "procedural"
    f = fp(t)
    ts = ts or now_ts()
    imp = estimate_importance(t, kind) if importance is None else importance
    if pin:
        # 钉住的确实重要，但别一律 0.95 —— 全一样的话 importance 就没区分度了。
        # 抬到至少 0.8，保留原有的高低差异。
        imp = max(imp, 0.8)
    row = conn.execute(
        "SELECT id FROM entries WHERE peer=? AND fp=?", (peer, f)
    ).fetchone()
    if row:
        # 同一句话再次出现 → 强化（hits 增、强度回升、重要性取高）
        conn.execute(
            "UPDATE entries SET hits=hits+1, last_seen=?, strength=MIN(1.5, strength+0.15), "
            "importance=MAX(importance, ?), pinned=MAX(pinned, ?), kind=? WHERE id=?",
            (ts, imp, 1 if pin else 0, kind, row["id"]),
        )
        return row["id"]
    cur = conn.execute(
        "INSERT INTO entries(peer, kind, text, fp, importance, strength, pinned, hits, created, last_seen, retired) "
        "VALUES(?,?,?,?,?,?,?,1,?,?,0)",
        (peer, kind, t, f, imp, 1.0, 1 if pin else 0, ts, ts),
    )
    return cur.lastrowid


def recall(conn, peer=None, query=None, top=8, min_score=0.05):
    """检索：按论文三分量打分。有 query 才用 relevance。"""
    if peer:
        rows = conn.execute(
            "SELECT * FROM entries WHERE peer=? AND retired=0", (peer,)
        ).fetchall()
    else:
        rows = conn.execute("SELECT * FROM entries WHERE retired=0").fetchall()
    qt = tokenize(query) if query else None
    scored = [(combine(r, qt), r) for r in rows]
    scored.sort(key=lambda x: x[0], reverse=True)
    return [(s, r) for s, r in scored[:top] if s >= min_score]


def ingest_bridge(conn, path=BRIDGE_LOG):
    os.makedirs(LOG_DIR, exist_ok=True)
    offset = 0
    if os.path.exists(CURSOR):
        with open(CURSOR, "r", encoding="utf-8") as f:
            offset = int(f.read().strip() or 0)
    if not os.path.exists(path):
        return 0
    size = os.path.getsize(path)
    if size < offset:
        offset = 0
    added = 0
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        f.seek(offset)
        for line in f:
            raw = line.rstrip("\n")
            mo = RE_OUTBOUND.match(raw)
            if mo:
                peer = mo.group("peer").replace(":", "-")
                text = mo.group("text").strip()
                if not text or text in NOISE:
                    continue
                try:
                    ts = datetime.strptime(mo.group("ts"), "%Y-%m-%dT%H:%M:%S.%fZ").replace(
                        tzinfo=timezone.utc
                    ).timestamp()
                except ValueError:
                    ts = now_ts()
                remember(conn, peer, text, ts=ts, outbound=True)
                added += 1
                continue
            m = RE_INBOUND.match(raw)
            if not m:
                continue
            peer = m.group("peer").replace(":", "-")
            text = m.group("text").replace("\\n", " ").replace('\\"', '"').strip()
            if not text or text in NOISE:
                continue
            try:
                ts = datetime.strptime(m.group("ts"), "%Y-%m-%dT%H:%M:%S.%fZ").replace(
                    tzinfo=timezone.utc
                ).timestamp()
            except ValueError:
                ts = now_ts()
            remember(conn, peer, text, kind=classify(text), pin=is_pin(text), ts=ts)
            short = {"ts": ts, "from": m.group("name"), "qq": m.group("qq"), "text": text}
            day = datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%d")
            p = os.path.join(LOG_DIR, f"{peer}-{day}.jsonl")
            with open(p, "a", encoding="utf-8") as lf:
                lf.write(json.dumps(short, ensure_ascii=False) + "\n")
            added += 1
        offset = f.tell()
    with open(CURSOR, "w", encoding="utf-8") as f:
        f.write(str(offset))
    conn.commit()
    return added


def prune(conn, cutoff=0.15):
    """归档：综合分低于阈值的标记 retired（不删，可回溯）。钉住的不归档。"""
    rows = conn.execute("SELECT * FROM entries WHERE retired=0 AND pinned=0").fetchall()
    n = 0
    for r in rows:
        if combine(r) < cutoff:
            conn.execute("UPDATE entries SET retired=1 WHERE id=?", (r["id"],))
            n += 1
    conn.commit()
    return n


def consolidate(conn, min_importance=0.45):
    """情节 → 语义的提炼（论文 §4.2 Reflection 的简化版）。

    不调 LLM：把同 peer 的高重要 episodic 记忆按关键词聚类，
    生成一句「要点」写进 semantic 层。真正高保真的提炼要 LLM，
    这里只保证「重要的东西别沉底」。
    """
    created = 0
    peers = [r["peer"] for r in conn.execute(
        "SELECT DISTINCT peer FROM entries WHERE retired=0")]
    for peer in peers:
        hot = conn.execute(
            "SELECT * FROM entries WHERE peer=? AND retired=0 AND kind='episodic' "
            "AND importance>=? ORDER BY importance DESC, last_seen DESC LIMIT 40",
            (peer, min_importance),
        ).fetchall()
        if len(hot) < 3:
            continue
        buckets = {}
        for r in hot:
            key = None
            for tk in tokenize(r["text"]):
                if len(tk) >= 2 and tk in IMPORTANT_WORDS:
                    key = tk
                    break
            if key:
                buckets.setdefault(key, []).append(r)
        for key, items in buckets.items():
            if len(items) < 2:
                continue
            joined = "；".join(i["text"][:60] for i in items[:3])
            remember(conn, peer, f"[关于「{key}」的几条] {joined}",
                     kind="semantic", importance=0.7)
            created += 1
    conn.commit()
    return created


def digest(conn):
    """生成 digest.md：按三层 + 重要性排序，不是按时间堆砌。"""
    peers = [r["peer"] for r in conn.execute(
        "SELECT DISTINCT peer FROM entries WHERE retired=0 ORDER BY peer")]
    lines = [
        "# 记忆摘要（memctl.py 自动生成，别手改）",
        "",
        f"生成时间：{datetime.now().strftime('%Y-%m-%d %H:%M')}",
        "",
        "> 分三层：**程序记忆**（约定/规矩，几乎不衰减）→ **语义记忆**（稳定事实）",
        "> → **情节记忆**（具体对话，衰减快）。同层内按综合分排序。",
        "> ★ = 钉住或极重要；· = 一般。",
        "",
    ]
    LAYERS = [
        ("procedural", "程序记忆 · 约定与规矩"),
        ("semantic", "语义记忆 · 稳定事实"),
        ("episodic", "情节记忆 · 最近聊过的"),
    ]
    for peer in peers:
        lines.append(f"## {peer}")
        lines.append("")
        for kind, title in LAYERS:
            rows = conn.execute(
                "SELECT * FROM entries WHERE peer=? AND retired=0 AND kind=? "
                "ORDER BY importance DESC, last_seen DESC LIMIT 12", (peer, kind)
            ).fetchall()
            rows = [r for r in rows if r["pinned"] or combine(r) >= 0.2]
            if not rows:
                continue
            lines.append(f"**{title}**")
            for r in rows[:8]:
                mark = "★" if (r["pinned"] or r["importance"] >= 0.85) else "·"
                lines.append(f"- {mark} {r['text'][:150]}")
            lines.append("")
    with open(DIGEST, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    return DIGEST


def scan_log(conn, path):
    """从一段原始对话文本里抽候选记忆（给 agent 自己用）。"""
    n = 0
    for line in open(path, "r", encoding="utf-8", errors="replace"):
        line = line.strip()
        if not line or line in NOISE:
            continue
        imp = estimate_importance(line)
        if imp < 0.4:
            continue
        remember(conn, "manual", line, importance=imp)
        n += 1
    conn.commit()
    return n


def main():
    ap = argparse.ArgumentParser(description="吉祥物的记忆系统 v2")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("ingest", help="从 bridge 日志增量抓")
    p.add_argument("--path", default=BRIDGE_LOG)

    sub.add_parser("digest", help="重生成 digest.md")

    p = sub.add_parser("prune", help="归档低分记忆")
    p.add_argument("--cutoff", type=float, default=0.15)

    sub.add_parser("consolidate", help="情节→语义提炼")

    p = sub.add_parser("remember", help="手动记一条")
    p.add_argument("text")
    p.add_argument("--peer", required=True)
    p.add_argument("--kind", default=None, choices=["episodic", "semantic", "procedural"])
    p.add_argument("--pin", action="store_true")

    p = sub.add_parser("recall", help="检索")
    p.add_argument("--peer", default=None)
    p.add_argument("--query", default=None)
    p.add_argument("--top", type=int, default=8)

    sub.add_parser("stats", help="统计")

    p = sub.add_parser("scan", help="从文本文件抽记忆")
    p.add_argument("path")

    a = ap.parse_args()
    conn = connect()

    if a.cmd == "ingest":
        print(f"新增 {ingest_bridge(conn, a.path)} 条")
    elif a.cmd == "digest":
        print(f"已写入 {digest(conn)}")
    elif a.cmd == "prune":
        print(f"归档 {prune(conn, a.cutoff)} 条")
    elif a.cmd == "consolidate":
        print(f"生成 {consolidate(conn)} 条语义记忆")
    elif a.cmd == "remember":
        rid = remember(conn, a.peer, a.text, kind=a.kind, pin=a.pin)
        conn.commit()
        print(f"已记 #{rid}")
    elif a.cmd == "recall":
        for s, r in recall(conn, a.peer, a.query, a.top):
            print(f"[{s:.3f}] ({r['kind']},{'pin' if r['pinned'] else '-'},imp={r['importance']:.2f}) {r['text'][:90]}")
    elif a.cmd == "stats":
        total = conn.execute("SELECT COUNT(*) FROM entries WHERE retired=0").fetchone()[0]
        print(f"有效记忆 {total} 条")
        for kind in ("procedural", "semantic", "episodic"):
            n = conn.execute("SELECT COUNT(*) FROM entries WHERE retired=0 AND kind=?", (kind,)).fetchone()[0]
            avg = conn.execute("SELECT AVG(importance) FROM entries WHERE retired=0 AND kind=?", (kind,)).fetchone()[0] or 0
            print(f"  {kind:12} {n:4} 条  平均重要性 {avg:.2f}")
        pin = conn.execute("SELECT COUNT(*) FROM entries WHERE retired=0 AND pinned=1").fetchone()[0]
        low = conn.execute("SELECT COUNT(*) FROM entries WHERE retired=0 AND importance<0.15").fetchone()[0]
        print(f"  钉住 {pin} 条 | 低价值(<0.15) {low} 条  ← 这些该清")
    elif a.cmd == "scan":
        print(f"抽取 {scan_log(conn, a.path)} 条")


if __name__ == "__main__":
    main()
