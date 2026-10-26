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
import time
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


def connect(db_path=None):
    """连库。db_path 显式传时用它 —— 测试必须传，否则会连到生产库。

    ⚠️ 踩过的坑：测试在 exec_module **之前**改 m.DB 是没用的，
       因为模块加载时 DB = os.path.join(BASE,"mem.db") 会把它覆盖回去。
       结果三个测试一直在写生产库，其中一个还有 os.remove(m.DB) —— 直接把库删了。
       所以这里必须支持显式传参。
    """
    conn = sqlite3.connect(db_path or DB)
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
            retired INTEGER NOT NULL DEFAULT 0,
            reflected INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_peer ON entries(peer);
        CREATE INDEX IF NOT EXISTS idx_kind ON entries(kind);
    """)
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(entries)")}
    if "reflected" not in cols:
        conn.execute("ALTER TABLE entries ADD COLUMN reflected INTEGER NOT NULL DEFAULT 0")
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


# ── BM25 检索（带 IDF）───────────────────────────────────────────────────────
# v3：把「bigram 字面重合」升级成 BM25。
# 为什么（实测踩到的短板）：v2 的 relevance 是 inter/sqrt(|D|)，
# **没有 IDF** —— 「觉得」「就是」这种满库都是的词，和「开会」「撤回」这种
# 只在一两处出现的词，权重一样。于是「我觉得开会」这类查询会被
# 「我今天觉得吧…」的长回复抢走，因为长回复命中的噪音词多。
# BM25 用 IDF 把噪音词的权重压下去，专有词自然浮上来。
# 参考：GroupMemBench（微软）里纯 BM25 追平/超过多数商业 agent memory。
# 纯 Python 实现，不引依赖。
K1 = 1.5          # 词频饱和参数（标准值）
B = 0.75          # 文档长度归一强度（标准值）


def term_freqs(text):
    """BM25 用的词频表：term → 出现次数。

    跟 tokenize() 的区别：tokenize 返回 set（去重，别处按「命中/没命中」用），
    这里要**保留重复次数**（tf 是 BM25 的词频分量）。
    分词规则跟 tokenize() 完全一致，保证两边对同一句话切出同一批词。
    """
    t = (text or "").lower()
    tf = {}
    for w in re.findall(r"[a-z0-9_]{2,}", t):
        tf[w] = tf.get(w, 0) + 1
    for seg in re.findall(r"[\u4e00-\u9fff]+", t):
        if len(seg) == 1:
            if seg not in STOPWORDS:
                tf[seg] = tf.get(seg, 0) + 1
            continue
        for i in range(len(seg) - 1):
            bg = seg[i:i + 2]
            if bg not in STOPWORDS:
                tf[bg] = tf.get(bg, 0) + 1
    return tf


class BM25Index:
    """倒排索引 + BM25 打分（语料 = 全部未归档记忆）。

    score(q, D) = Σ IDF(t) · tf(t,D)·(k1+1) / (tf + k1·(1-b + b·|D|/avgdl))
                 IDF(t) = ln((N - n(t) + 0.5) / (n(t) + 0.5) + 1)

    ⚠️ BM25 原始分没有上界，不能直接跟 importance/recency 加权，
    所以这里做**查询内归一**：raw / 本次查询的最高分 → [0,1]。
    同一个查询里所有条目除以同一个分母，排序不变，但尺度稳定。
    查询词一个都不在库里命中 → max=0 → 全 0（交给上游的零重合折损规则）。
    """

    def __init__(self, docs):
        # docs: [(id, text)]
        self.tf = {}       # id → {term: tf}
        self.dl = {}       # id → 文档长度（词数，含重复）
        self.df = {}       # term → 出现在几个文档里
        for did, text in docs:
            tf = term_freqs(text)
            self.tf[did] = tf
            self.dl[did] = sum(tf.values())
            for term in tf:
                self.df[term] = self.df.get(term, 0) + 1
        self.N = len(self.tf)
        self.avgdl = (sum(self.dl.values()) / self.N) if self.N else 0.0
        self._key = None      # 上次算分的 query 词集
        self._scores = {}     # id → 原始 BM25 分
        self._max = 0.0       # 该查询的最高原始分（归一化分母）

    def idf(self, term):
        n = self.df.get(term, 0)
        return math.log((self.N - n + 0.5) / (n + 0.5) + 1.0)

    def _compute(self, query_terms):
        key = frozenset(query_terms)
        if key == self._key:
            return self._scores, self._max
        scores = {}
        for did, tf in self.tf.items():
            dl = self.dl[did] or 1
            norm = K1 * (1 - B + B * (dl / self.avgdl if self.avgdl else 1.0))
            s = 0.0
            for term in query_terms:
                f = tf.get(term)
                if not f:
                    continue
                s += self.idf(term) * (f * (K1 + 1)) / (f + norm)
            if s > 0:
                scores[did] = s
        mx = max(scores.values()) if scores else 0.0
        self._key, self._scores, self._max = key, scores, mx
        return scores, mx

    def score(self, doc_id, query_terms):
        """单条记忆的归一化 relevance ∈ [0,1]；零重合 → 0。"""
        scores, mx = self._compute(query_terms)
        if not mx:
            return 0.0
        raw = scores.get(doc_id)
        if not raw:
            return 0.0
        return min(1.0, raw / mx)


# 进程内索引缓存：recall() 每轮都会查，重建倒排太重。
# 失效条件 = 语料指纹变了（库文件 + 未归档条数 + 最大 id）。
# 条数变了 / 新插入 / prune 归档 → 指纹变 → 自动重建。
_BM25_CACHE = {"sig": None, "idx": None}
_BM25_ACTIVE = None    # 最近一次 recall 用的索引，给 relevance(row, qt) 兜底


def _db_file(conn):
    """当前连接的库文件路径（测试会用不同临时库，必须分清）。"""
    try:
        for r in conn.execute("PRAGMA database_list"):
            if r[1] == "main":
                return r[2] or ":memory:"
    except Exception:
        pass
    return "?"


def bm25_signature(conn):
    row = conn.execute(
        "SELECT COUNT(*), IFNULL(MAX(id), 0) FROM entries WHERE retired=0"
    ).fetchone()
    return (_db_file(conn), row[0], row[1])


def bm25_index(conn):
    """取进程内索引；语料变了就重建。IDF 用全库统计（不按 peer 切）。"""
    global _BM25_ACTIVE
    sig = bm25_signature(conn)
    idx = _BM25_CACHE["idx"]
    if idx is None or _BM25_CACHE["sig"] != sig:
        docs = [(r["id"], r["text"]) for r in conn.execute(
            "SELECT id, text FROM entries WHERE retired=0")]
        idx = BM25Index(docs)
        _BM25_CACHE["sig"] = sig
        _BM25_CACHE["idx"] = idx
    _BM25_ACTIVE = idx
    return idx


def invalidate_bm25():
    """写库后手动作废索引（指纹兜底之外，让写操作后的下一次查询直接重建）。"""
    global _BM25_ACTIVE
    _BM25_CACHE["sig"] = None
    _BM25_CACHE["idx"] = None
    _BM25_ACTIVE = None


def _legacy_relevance(row, query_tokens):
    """v2 的 bigram 重合度。仅在没有索引上下文时兜底（正常检索走 BM25）。"""
    mem_tokens = tokenize(row["text"])
    if not mem_tokens:
        return 0.0
    inter = len(query_tokens & mem_tokens)
    if inter == 0:
        return 0.0
    return min(1.0, inter / math.sqrt(len(mem_tokens)))


def relevance(row, query_tokens, index=None):
    """relevance：查询词与记忆的相关性 ∈ [0,1]。没有 query 时返回中性 0.5。

    v3 起内部是 BM25（带 IDF + 查询内归一）；`index` 由 recall() 传入，
    不传就用最近一次 recall 建的索引（保持旧签名可单独调用）。
    """
    if not query_tokens:
        return 0.5
    idx = index if index is not None else _BM25_ACTIVE
    if idx is None:
        # 完全没有索引上下文（单条直调，生产路径不会走到）→ 退回旧公式，别崩
        return _legacy_relevance(row, query_tokens)
    return idx.score(row["id"], query_tokens)


def combine(row, query_tokens=None, at=None, index=None):
    """论文公式：score = α_rel·relevance + α_imp·importance + α_rec·recency

    加了一条论文没有的规则：**给了 query 但零重合 → 强折减**。
    否则「问情绪」会被一条毫不相关的「开会安排」抢答（实测踩过）。
    """
    r = recency(row, at)
    imp = row["importance"] if "importance" in row.keys() else 0.5
    if row["pinned"]:
        imp = max(imp, 0.8)
    rel = relevance(row, query_tokens, index=index)
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
    """检索：按论文三分量打分。有 query 才用 relevance（v3 = BM25）。

    IDF 统计用**全库**（跨 peer 的文档频率才准），候选条目才按 peer 过滤。
    索引进程内缓存，语料变化时自动重建（见 bm25_index）。
    """
    if peer:
        rows = conn.execute(
            "SELECT * FROM entries WHERE peer=? AND retired=0", (peer,)
        ).fetchall()
    else:
        rows = conn.execute("SELECT * FROM entries WHERE retired=0").fetchall()
    qt = tokenize(query) if query else None
    idx = bm25_index(conn) if qt else None
    scored = [(combine(r, qt, index=idx), r) for r in rows]
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


# ── 定期反思（reflection）────────────────────────────────────────────────────
# 论文 §4.2：让 agent 定期回头看最近的记忆，提炼成更高层的「反思」
# （关于这个人是谁、他的偏好、你们的关系、答应过什么、还有什么没做完）。
# 这里真正调一次 LLM 去做，而不是像 consolidate() 那样按关键词拼句子。

REFLECTION_PROMPT = """你在整理一段聊天记录的记忆。请从下面的对话片段里，提炼出 **{n_min}~{n_max} 条**值得长期记住的事实。

只记这几类（其他一律不要）：
1. 这个人的身份/基本情况（称呼、所在、职业、习惯作息）
2. 他明确的偏好与雷点（喜欢什么、讨厌什么、别对他做什么）
3. 你们之间的约定和规矩（他要求你怎么做、什么情况下不做什么）
4. 没做完 / 待办的事（他说了要做但还没做的、答应过的）
5. 关系变化（称呼变了、态度变了、亲疏变了）

**严格要求**：
- 每条**一句话**，20~60 字，写在 `- ` 开头
- 必须是**能脱离上下文独立看懂**的陈述（不要「他说了那个」「上面提到的」这种指代）
- 只写**对话里真的出现过**的信息，**不要推测、不要编**
- 如果这段对话没啥值得记的，就只输出 `- 无` 一行
- 除了这 {n_min}~{n_max} 条，**不要写任何别的话**（不要标题、不要解释、不要总结段）

对话片段（时间从早到晚）：
{memories}
"""


def _prompt_for_reflection(items, n_min, n_max):
    lines = []
    for r in items:
        try:
            t = datetime.fromtimestamp(r["last_seen"], timezone.utc).strftime("%m-%d %H:%M")
        except Exception:
            t = "?"
        lines.append(f"[{t}] {r['text'][:200]}")
    body = "\n".join(lines)
    return REFLECTION_PROMPT.format(n_min=n_min, n_max=n_max, memories=body)


def _parse_reflection(raw):
    """从模型输出里抠出条目。宽容解析：容忍编号、项目符号、多余前后缀。"""
    out = []
    for line in (raw or "").splitlines():
        line = line.strip()
        if not line:
            continue
        # 去掉常见前缀：- * • 1. 1) 「」
        m = re.match(r"^(?:[-*•·]|\d+[.、)])\s*(.+)$", line)
        cand = (m.group(1) if m else line).strip().strip("「」\"'")
        if not cand:
            continue
        if cand in ("无", "（无）", "(无)", "没有", "无值得记录的信息"):
            continue
        # 过滤掉模型自作主张加的标题/说明行
        if re.match(r"^(以下是|根据|总结|说明|注意|对话片段|以上)", cand):
            continue
        # 门槛设 4 字：实测 5 字的事实（「甲是程序员」）完全有效，
        # 设 6 会把它们全丢掉。4 字以下基本只有「嗯」「好的」，那是噪音。
        if len(cand) < 4:
            continue
        out.append(cand[:200])
    # 去重（按内容指纹）
    seen, uniq = set(), []
    for c in out:
        f = fp(c)
        if f in seen:
            continue
        seen.add(f)
        uniq.append(c)
    return uniq


def _call_llm_via_acp(prompt, timeout=90):
    """调一次模型。调用者是 reflection_llm.mjs（薄壳），失败抛异常。

    返回值：提炼后的文本；调用不可用时抛 LLMRuntimeError / LLMUnavailable。
    """
    import subprocess
    import tempfile

    script = os.path.join(BASE, "reflection_llm.mjs")
    if not os.path.exists(script):
        raise LLMUnavailable(f"找不到 {script}")
    node = os.environ.get("NODE_BIN") or "node"
    with tempfile.TemporaryDirectory(prefix="refl-") as td:
        pf = os.path.join(td, "prompt.txt")
        of = os.path.join(td, "out.json")
        with open(pf, "w", encoding="utf-8") as f:
            f.write(prompt)
        try:
            proc = subprocess.run(
                [node, script, "--prompt-file", pf, "--out-file", of,
                 "--timeout", str(timeout)],
                capture_output=True, text=True, timeout=timeout + 60,
            )
        except subprocess.TimeoutExpired:
            raise LLMRuntimeError(f"模型调用超时（>{timeout + 60}s）")
        if not os.path.exists(of):
            raise LLMUnavailable(
                f"模型调用未产出结果（exit={proc.returncode}）: "
                f"{(proc.stderr or '')[-300:]}"
            )
        try:
            with open(of, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception as e:
            raise LLMRuntimeError(f"结果文件读不出来: {e}")
        if not data.get("ok"):
            msg = data.get("error") or "未知错误"
            if proc.returncode == 2:
                raise LLMUnavailable(msg)
            raise LLMRuntimeError(msg)
        return data.get("text") or ""


class LLMUnavailable(Exception):
    """模型不可用（没配置 / 起不来）。这种情况应静默退回非 LLM 模式。"""


class LLMRuntimeError(Exception):
    """模型可用但这次调用失败了（超时/报错）。不应污染已有记忆。"""


def _fallback_summaries(items):
    """粗糙拼接（老 consolidate 的思路）：同关键词的几条并一句。"""
    buckets = {}
    for r in items:
        if r["importance"] < 0.45:
            continue
        key = None
        for tk in tokenize(r["text"]):
            if len(tk) >= 2 and tk in IMPORTANT_WORDS:
                key = tk
                break
        if key:
            buckets.setdefault(key, []).append(r)
    out = []
    for key, rows in buckets.items():
        if len(rows) < 2:
            continue
        joined = "；".join(i["text"][:60] for i in rows[:3])
        out.append(f"[关于「{key}」的几条] {joined}")
    return out


def _mark_reflected(conn, ids):
    """把一批 episodic 打上 reflected=1（分批 UPDATE，避开 SQLite 变量上限）。"""
    for chunk_start in range(0, len(ids), 200):
        chunk = ids[chunk_start:chunk_start + 200]
        conn.execute(
            f"UPDATE entries SET reflected=1 WHERE id IN ({','.join('?' * len(chunk))})",
            chunk,
        )


def reflect(conn, peer, hours=24, n_min=2, n_max=5, use_llm=True,
            timeout=90, batch=10, total_timeout=600, llm_caller=None,
            dry_run=False):
    """对某个 peer 最近一段 episodic 记忆做一次反思提炼。

    幂等：被提炼过的 episodic 打 reflected=1，下次不会重复提炼。
    分批：每 batch 条拼一个 prompt —— 一次性喂几十条会撑爆单次调用（实测 59 条
          180s 超时，而 3 条只要 42s）。批大小和单批超时可调。
    失败安全：LLM 不可用 → 退回粗糙拼接法（consolidate 那套）；
    单批失败不连累全局 → 该批不打标记、继续后面的批，返回 batches_failed；
    全部批失败才算 mode='error'（且此时不改任何数据）。
    总预算：累计耗时超 total_timeout → 停止后续批，已成功的存下来，mode='llm-partial'。
    """
    cutoff = now_ts() - hours * 3600
    items = conn.execute(
        "SELECT * FROM entries WHERE peer=? AND retired=0 AND kind='episodic' "
        "AND reflected=0 AND last_seen>=? ORDER BY last_seen ASC LIMIT 80",
        (peer, cutoff),
    ).fetchall()

    result = {
        "peer": peer, "scanned": len(items), "created": 0, "skipped": 0,
        "mode": "none", "summaries": [], "error": None,
        "batches": 0, "batches_ok": 0, "batches_failed": 0,
    }
    if not items:
        return result

    batch = max(1, int(batch or 1))
    chunks = [items[i:i + batch] for i in range(0, len(items), batch)]
    result["batches"] = len(chunks)
    summaries = []
    mode = "llm"

    if use_llm:
        caller = llm_caller or _call_llm_via_acp
        seen = set()
        done_ids, failed_ids, errs = [], [], []
        failed_batches = 0
        t0 = time.monotonic()
        stopped = False
        unavailable = False
        for idx, chunk in enumerate(chunks):
            if time.monotonic() - t0 > total_timeout:
                stopped = True
                errs.append(f"总耗时超过 {total_timeout}s，停止后续 {len(chunks) - idx} 批")
                break
            try:
                raw = caller(_prompt_for_reflection(chunk, n_min, n_max), timeout)
            except LLMUnavailable as e:
                unavailable = True
                result["error"] = f"LLM 不可用，退回拼接法: {e}"
                break
            except Exception as e:
                # 单批失败：记下来，该批不打标记（下轮还能重试），继续后面的批
                failed_ids.extend(r["id"] for r in chunk)
                failed_batches += 1
                errs.append(f"第 {idx + 1} 批: {e}")
                continue
            for sm in _parse_reflection(raw)[:n_max]:
                f = fp(sm)
                if f in seen:
                    continue
                seen.add(f)
                summaries.append(sm)
            done_ids.extend(r["id"] for r in chunk)
            result["batches_ok"] += 1

        result["batches_failed"] = failed_batches

        if unavailable:
            mode = "fallback"
        elif not done_ids and errs:
            # 一批都没成功 → 全失败，才算 error
            result["error"] = "LLM 调用失败: " + "; ".join(errs)
            result["mode"] = "error"
            return result
        else:
            if errs:
                result["error"] = "LLM 部分失败: " + "; ".join(errs)
            if stopped or failed_ids:
                mode = "llm-partial"
            elif not summaries:
                mode = "llm-empty"  # 模型说「无」是正常结果，不是失败
    else:
        mode = "fallback"

    if mode == "fallback":
        summaries = _fallback_summaries(items)
        if not summaries:
            result["mode"] = mode
            result["skipped"] = len(items)
            return result

    if dry_run:
        result["mode"] = mode + "-dry"
        result["summaries"] = summaries
        return result

    created = 0
    for text in summaries:
        imp = max(estimate_importance(text), 0.65)  # 反思产物天然比单条闲聊重要
        rid = remember(conn, peer, text, kind="semantic", importance=imp)
        if rid:
            created += 1
    # 只给成功处理过的批打标记：失败/没跑到的批保持 reflected=0，下轮还能重试
    mark_ids = (done_ids if use_llm and mode != "fallback" else [r["id"] for r in items])
    _mark_reflected(conn, mark_ids)
    conn.commit()

    result["created"] = created
    result["mode"] = mode
    result["summaries"] = summaries
    return result


def reflect_all(conn, hours=24, n_min=2, n_max=5, use_llm=True, timeout=90,
                batch=10, total_timeout=600, llm_caller=None, dry_run=False):
    """对所有有未反思 episodic 的 peer 跑一遍。"""
    peers = [r["peer"] for r in conn.execute(
        "SELECT DISTINCT peer FROM entries WHERE retired=0 AND kind='episodic' "
        "AND reflected=0 AND last_seen>=?", (now_ts() - hours * 3600,)
    )]
    out = []
    for peer in peers:
        out.append(reflect(conn, peer, hours, n_min, n_max, use_llm, timeout,
                           batch, total_timeout, llm_caller=llm_caller,
                           dry_run=dry_run))
    return out


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

    sub.add_parser("consolidate", help="情节→语义提炼（粗糙拼接，不调模型）")

    p = sub.add_parser("reflect", help="定期反思：调模型把情节真正提炼成语义记忆")
    p.add_argument("--peer", default=None, help="只反思某个 peer（默认全部）")
    p.add_argument("--hours", type=float, default=24, help="回看最近多少小时（默认24）")
    p.add_argument("--n-min", type=int, default=2, help="至少提炼几条")
    p.add_argument("--n-max", type=int, default=5, help="最多提炼几条")
    p.add_argument("--no-llm", action="store_true", help="不调模型，退回粗糙拼接")
    p.add_argument("--timeout", type=int, default=90, help="单批模型调用超时（秒）")
    p.add_argument("--batch", type=int, default=10, help="每批喂几条记忆（默认10）")
    p.add_argument("--total-timeout", type=int, default=600, help="全程总超时预算（秒）")
    p.add_argument("--dry-run", action="store_true", help="只打印提炼结果，不写库")

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
    elif a.cmd == "reflect":
        kwargs = dict(hours=a.hours, n_min=a.n_min, n_max=a.n_max,
                      use_llm=not a.no_llm, timeout=a.timeout, batch=a.batch,
                      total_timeout=a.total_timeout, dry_run=a.dry_run)
        results = ([reflect(conn, a.peer, **kwargs)] if a.peer
                   else reflect_all(conn, **kwargs))
        for r in results:
            print(f"[{r['peer']}] 扫描 {r['scanned']} 条 · 模式 {r['mode']} · 新建 {r['created']} 条"
                  f" · 批次 {r.get('batches_ok', 0)}/{r.get('batches', 0)} 成功"
                  f"（失败 {r.get('batches_failed', 0)}）")
            if r.get("error"):
                print(f"    ⚠ {r['error']}")
            for sm in r.get("summaries") or []:
                print(f"    + {sm}")
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
