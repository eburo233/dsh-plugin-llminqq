// lib/agent/memory-v5/search.mjs —— 记忆 v5 的**检索 + 注入渲染层**（Step 2）
// ============================================================================
// 这是 docs/MEMORY-AUDIT-AND-V5.md §3.3(c) 和 §3.7 的实现：把 v5 数据层
// （store.mjs 的 FTS/BM25）变成「每轮 prompt 里那一块记忆」。
//
// 为什么不能沿用 v4 的检索（实测问题，逐条对应）：
//   ① **分数不可比**：v4 的 relevance 分母是「本次查询最高分」→ top1 恒 1.0，
//      阈值（minScore=0.15）筛掉的既可能是噪音也可能是相关记忆（P0-3，精度 2.3%）。
//      v5 用**绝对量**：rel 按全库归一，同一条记忆在不同 query 下的 rel 可比。
//   ② **maxRows 硬砍**：v4 固定 6 条，长记忆挤占短记忆的空间，且不看预算（§3.3c）。
//      v5 按**字数预算**装填：装不下就停，块的总字数 ≤ budgetChars。
//   ③ **重复注入已在上下文里的东西**：v4 把「本轮正在聊的 171 条」又当回忆塞回去。
//      v5 用 events 里本会话最早一条的时间做**水位线**，水源在当前会话的跳过。
//   ④ **注入长度不可控**：v4 digest 三层截断后仍有 1865 字（P0-4）。v5 目标 ~800 字，
//      本模块把检索块默认压到 350 字、画像 120、防复读 60（§3.7）。
//
// 打分公式（§3.3 / 本文件常量；回执/测试都以这里为唯一真源）：
//
//     base  = 0.55·rel + 0.22·salience + 0.18·recency + 0.10·pinned
//     score = TYPE_WEIGHT[type] · base − 0.25·mmrSim        ← mmrSim 在贪心选择时算
//     rel   = clamp(-bm25 / log(1 + N), 0, 1)               ← N = 全库 active 记忆数
//     recency = 0.5 ^ (ageDays / TYPE_HALF_LIFE_DAYS[type])
//     pinned  = salience >= 0.9 ? 1 : 0   ← v5 没有 pinned 列；迁移规则把 v4 的
//                                            pinned 抬到 salience 0.9（store.mjs 注释）
//
// 为什么 MMR 用「bigram Jaccard」当相似度：v5 的 FTS 索引里存的就是 bigram 词元
// （store.ftsTokens），复用它衡量「两条记忆在说同一件事」几乎零成本，也不依赖
// embedding（不调模型）。MMR 只惩罚**已经选中的**条目，不会因为「库里两条像」
// 就把两条都压死 —— 第一条该进还是要进。
//
// ── 桥侧接入契约（Step 2 切换时按这个接）────────────────────────────────────
//   import { searchForPrompt, utteranceBlock, profileBlock, buildMemoryBlocks }
//     from './memory-v5/search.mjs'
//
//   // 每轮回复前（拿到 lastUserText / 对端 QQ / 会话后）：
//   const memBlock = buildMemoryBlocks({
//     store,                       // openV5(...) 的返回值，进程内复用，别每轮开
//     subject: qq,                 // 关于谁（群聊时必须传发言人 QQ；私聊可省）
//     conv: 'c2c:123456',          // 当前会话（与 store 的 events.conv 同格式）
//     query: lastUserText,         // 当前这条消息（当检索词）
//     inGroup: false,              // 群聊 → true（dm_only 记忆不注入）
//     now: Date.now() / 1000,
//   })
//   // memBlock.block      拼好的整块（总字数 ≤ 800；空库/无命中 = ''）
//   // 也可以按块用：searchForPrompt / utteranceBlock / profileBlock（各自返回字符串）
//
//   建议顺序：画像（稳定事实）→ 按需检索（贴当前话题）→ 防复读。
//   注入成功后可 `store.touchMemory(ids)`（需要 ids 时用 rankMemories() 拿 items）。
// ============================================================================

// ── 打分常量（唯一真源；改这里之前先看回执/测试里的期望值）──────────────────
export const W_REL = 0.55
export const W_SALIENCE = 0.22
export const W_RECENCY = 0.18
export const W_PINNED = 0.10

/** MMR 冗余惩罚系数：adjusted = score − MMR_WEIGHT · maxSim。 */
export const MMR_WEIGHT = 0.25

/** 类型权重：规矩/事实/偏好 > 约定/关系 > 情节（同分时优先「稳定层」）。 */
export const TYPE_WEIGHT = Object.freeze({
  rule: 1.00,
  fact: 1.00,
  preference: 1.00,
  commitment: 0.97,
  relation: 0.95,
  episode: 0.90,
})

/** 类型 → 中文标签（注入里给人/模型看的那一个词）。 */
export const TYPE_LABEL = Object.freeze({
  rule: '规矩',
  fact: '事实',
  preference: '偏好',
  commitment: '约定',
  relation: '关系',
  episode: '情节',
})

/**
 * recency 半衰期（天），按类型：
 *   rule       365  —— 规矩/约定不该因为「旧」而失效
 *   relation   120  —— 关系是慢变量
 *   preference  90  —— 偏好稳定但会变
 *   fact        60  —— 同 v4 semantic 的半衰期
 *   commitment  30  —— 约定/待办有时限
 *   episode      3  —— 具体对话衰减最快（同 v4 episodic）
 */
export const TYPE_HALF_LIFE_DAYS = Object.freeze({
  rule: 365,
  relation: 120,
  preference: 90,
  fact: 60,
  commitment: 30,
  episode: 3,
})
export const DEFAULT_HALF_LIFE_DAYS = 30

/** LIKE 回退没有 BM25：给一个低于强 FTS 命中的常数相关度（避免字面命中压过语义相关）。 */
export const LIKE_REL = 0.45

/** 少于这个字数的剩余空间就不塞新条目（避免半截行更难读）。 */
const MIN_ITEM_CHARS = 24

const SECOND = 1
const MINUTE = 60
const HOUR = 3600
const DAY = 86400

const clamp01 = x => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0)

/** 按 code point 数「字数」（中文/emoji 都按一个字算；`str.length` 对 emoji 会多算）。 */
export function charLen (s) {
  return [...String(s ?? '')].length
}

/** 截断到 maxChars 个字（按 code point），超了补省略号。 */
export function truncateChars (s, maxChars) {
  const chars = [...String(s ?? '')]
  if (chars.length <= maxChars) return String(s ?? '')
  if (maxChars <= 1) return chars.slice(0, Math.max(0, maxChars)).join('')
  return chars.slice(0, maxChars - 1).join('') + '…'
}

/**
 * recency 分数：0.5 ^ (ageDays / halfLifeDays)。future（时钟回拨）→ 1。
 * @param {string} type
 * @param {number} lastSeen 秒
 * @param {number} now 秒
 * @returns {number} [0,1]
 */
export function recencyScore (type, lastSeen, now) {
  const hl = TYPE_HALF_LIFE_DAYS[type] ?? DEFAULT_HALF_LIFE_DAYS
  const ageDays = Math.max(0, (Number(now) - Number(lastSeen)) / DAY)
  return Math.pow(0.5, ageDays / hl)
}

/**
 * 「多久以前」的相对时间标签（注入里每条都带，模型才知道「这是旧事还是刚才」）。
 *
 * 为什么必须有：v4 的 digest 里「过期 8 天的会议」和「今天的约定」长得一模一样，
 * 模型没有时间感，就会把旧事当现在（P0-4/P0-7 的次生问题）。
 */
export function relativeTimeLabel (atSec, nowSec) {
  const at = Number(atSec)
  if (!Number.isFinite(at) || at <= 0) return '时间未知'
  const d = Math.max(0, Number(nowSec) - at)
  if (d < MINUTE) return '刚刚'
  if (d < HOUR) return `${Math.floor(d / MINUTE)} 分钟前`
  if (d < DAY) return `${Math.floor(d / HOUR)} 小时前`
  const days = Math.floor(d / DAY)
  if (days < 7) return `${days} 天前`
  if (days < 30) return `${Math.floor(days / 7)} 周前`
  if (days < 365) return `${Math.floor(days / 30)} 个月前`
  return `${Math.floor(days / 365)} 年前`
}

/** FTS 检索命中词的 bigram 集合（复用 store 的分词规则；用于 MMR 相似度）。 */
function tokenSet (text) {
  // 延迟 import 会让模块加载变复杂，这里直接内联一份等价的 bigram 切分。
  // ⚠️ 必须和 store.mjs 的 ftsTokens 保持一致（同一套 CJK 区间 + 2-gram）。
  const s = String(text ?? '')
  const CJK = '\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\u3040-\\u30ff\\uac00-\\ud7af'
  const runs = s.match(new RegExp(`[${CJK}]+|[A-Za-z0-9_]+`, 'g')) || []
  const out = new Set()
  for (const run of runs) {
    if (new RegExp(`^[${CJK}]`).test(run)) {
      if (run.length === 1) out.add(run)
      else for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2))
    } else out.add(run.toLowerCase())
  }
  return out
}

/** Jaccard 相似度（两个 bigram 词元集合的交集 / 并集）。 */
export function similarity (a, b) {
  const A = a instanceof Set ? a : tokenSet(a)
  const B = b instanceof Set ? b : tokenSet(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const t of A) if (B.has(t)) inter += 1
  return inter / (A.size + B.size - inter)
}

/** 一条记忆的「pinned」代理：v5 没有 pinned 列，迁移把 v4 的 pinned 抬到 salience 0.9。 */
export function pinnedOf (mem) {
  if (mem && mem.pinned !== undefined && mem.pinned !== null) return Number(mem.pinned) ? 1 : 0
  return Number(mem?.salience ?? 0) >= 0.9 ? 1 : 0
}

/**
 * 单条记忆的**基础分**（不含 MMR；MMR 是选择阶段的事）。
 *
 * @param {object} p
 * @param {object} p.mem    memories 行（至少含 type/salience/last_seen）
 * @param {number} p.rel    相关度 [0,1]
 * @param {number} p.now    秒
 * @returns {{score:number, rel:number, recency:number, salience:number, pinned:number,
 *            typeWeight:number, halfLifeDays:number}}
 */
export function scoreMemory ({ mem, rel, now }) {
  const type = String(mem?.type || 'episode')
  const relScore = clamp01(rel)
  const salience = clamp01(mem?.salience)
  const recency = recencyScore(type, mem?.last_seen ?? mem?.lastSeen ?? 0, now)
  const pinned = pinnedOf(mem)
  const typeWeight = TYPE_WEIGHT[type] ?? 1
  const base = W_REL * relScore + W_SALIENCE * salience + W_RECENCY * recency + W_PINNED * pinned
  return {
    score: typeWeight * base,
    rel: relScore,
    recency,
    salience,
    pinned,
    typeWeight,
    halfLifeDays: TYPE_HALF_LIFE_DAYS[type] ?? DEFAULT_HALF_LIFE_DAYS,
  }
}

/** 把 query 字符串转 bigram 词元（只用于内部一致；store 才是索引真源）。 */
export function queryTokens (query) {
  return [...tokenSet(query)]
}

// ── 候选获取（FTS → 短查询 LIKE 回退 → 去重）────────────────────────────────
function dedupeById (rows) {
  const seen = new Set()
  const out = []
  for (const r of rows) {
    const id = Number(r?.id)
    if (!Number.isFinite(id) || seen.has(id)) continue
    seen.add(id)
    out.push(r)
  }
  return out
}

/**
 * 取候选：**一次 FTS 扫描**（不按 subject 过滤），后面在 JS 里按可见性过滤。
 *
 * 为什么不按 subject 查两路（早期实现）：检索在**每轮回复的关键路径**上，两次
 * FTS 查询实测把 p50 从 ~2.5ms 拉到 ~7ms、p99 到 ~29ms（1000 条库）。而 subject
 * 的可见性本来就是本层在 JS 里判的（跨通道/群级知识/dm_only 都依赖上下文，不是
 * 一个 SQL 条件能表达）。所以只做一次全库候选，再用 visibleInContext() 过滤。
 *
 * 召回取舍：query 命中的候选按 bm25 取前 limit 条；886 条库上同 topic 的条目通常
 * 远少于 limit(40)。真出现「高频词磁铁」把某个 subject 挤出去的情况，把
 * limitCandidates 调大即可（接口已暴露）。
 *
 * 单字/极短查询：FTS 的 bigram 索引没有 1-gram，落空时回退 LIKE（store 自带规则
 * 只覆盖单个汉字；这里对 ≤3 字查询也补一次，因为分词边界会让 2 字查询偶发漏命中）。
 */
function fetchCandidates ({ store, query, limit }) {
  const lim = Math.max(5, Math.min(200, Number(limit) || 40))
  let rows = store.searchMemories({ query, limit: lim }).map(r => ({ ...r, via: r.via || 'fts' }))
  if (!rows.length) {
    const q = String(query ?? '').trim()
    if (q && charLen(q) <= 3) {
      rows = store.searchLike({ query: q, limit: lim }).map(r => ({ ...r, via: 'like' }))
    }
  }
  return dedupeById(rows)
}

// ── 过滤（scope / 会话 / 主体 / 水位线）──────────────────────────────────────
/**
 * 这条记忆在当前场合能不能被注入？
 *
 * 规则（对应 §3.3 跨通道与 v4 P1-3 的两个泄漏方向）：
 *   · dm_only 只在私聊注入（群聊里绝不当众复述私聊内容）；
 *   · subject 匹配 → 可以跨通道（私聊说过的事群里也能想起来，这是 v5 的设计目标）；
 *   · subject=NULL 且 conv=NULL → **全局公共知识**（规矩/常识），任何场合都能用；
 *   · subject=NULL 且 conv 有值 → 群级知识，**只在自己那条会话里**用
 *     （不能把 A 群的公共知识注入到 B 群或私聊）；
 *   · 调用方没给 subject 时，只允许「本会话里关于某人」的记忆（不猜全库谁是谁）；
 *   · 时间边界已过（valid_until < now，expire job 还没跑的窗口）不注入。
 */
function visibleInContext (mem, { subject, conv, inGroup, now }) {
  if (!mem) return false
  if (mem.state !== 'active') return false
  const scope = String(mem.scope || 'public')
  if (inGroup && scope === 'dm_only') return false
  if (mem.valid_until != null && Number(mem.valid_until) > 0 && Number(mem.valid_until) < Number(now)) return false

  const memSubject = mem.subject === null || mem.subject === undefined ? null : String(mem.subject)
  const wantSubject = subject === null || subject === undefined ? null : String(subject)
  const memConv = mem.conv === null || mem.conv === undefined ? null : String(mem.conv)
  const wantConv = conv === null || conv === undefined ? null : String(conv)

  if (memSubject !== null) {
    if (wantSubject !== null) return memSubject === wantSubject
    // 没给 subject：只允许「本会话里关于某人」的记忆（不猜全库谁是谁）
    return memConv !== null && wantConv !== null && memConv === wantConv
  }
  // subject=NULL：全局知识（conv=NULL）处处可用；群级知识只在自己的会话里用
  if (memConv === null) return true
  return wantConv !== null && memConv === wantConv
}

/** 本会话「已经在上下文里」的水位线：events 里该会话最早一条的时间（秒）。 */
export function contextWatermark ({ store, conv }) {
  if (!conv) return null
  try {
    const row = store.db.prepare('SELECT MIN(at) AS t FROM events WHERE conv = ?').get(String(conv))
    const t = Number(row?.t)
    return Number.isFinite(t) && t > 0 ? t : null
  } catch {
    return null // 库还没建 events / 老库：当没有水位线，不影响注入
  }
}

/**
 * 批量取完整记忆行（一条 IN 查询），替代逐条 getMemory()。
 *
 * 为什么必须批量：候选池最多 80 条（subject 专属 + 全库两路），逐条 getMemory
 * 每次都是一次 prepared statement 执行 —— 实测 1000 条库上 p99 会从 ~3ms 涨到
 * ~28ms（注入在每轮回复的关键路径上，这个开销不能接受）。
 */
function fetchMemoriesByIds (store, ids) {
  const list = [...new Set(ids.map(Number).filter(Number.isFinite))]
  const out = new Map()
  if (!list.length) return out
  try {
    const rows = store.db.prepare(
      `SELECT * FROM memories WHERE id IN (${list.map(() => '?').join(',')})`,
    ).all(...list)
    for (const r of rows) out.set(Number(r.id), r)
  } catch {
    // 兜底：没有 db 句柄（理论不会有）就退回逐条查询
    for (const id of list) {
      const m = store.getMemory(id)
      if (m) out.set(Number(id), m)
    }
  }
  return out
}

/** 批量取来源事件的时刻（水位线用）。返回 id -> at(秒)。 */
function fetchEventTimes (store, ids) {
  const list = [...new Set(ids.map(Number).filter(Number.isFinite))]
  const out = new Map()
  if (!list.length) return out
  try {
    const rows = store.db.prepare(
      `SELECT id, at FROM events WHERE id IN (${list.map(() => '?').join(',')})`,
    ).all(...list)
    for (const r of rows) out.set(Number(r.id), Number(r.at))
  } catch { /* events 表不可用 → 走 created */ }
  return out
}

/**
 * 记忆的「来源时间」：优先 source_event 的时刻，其次 created。
 * 水位线判断用「来源时间 >= 本会话最早一条」→ 这条来自当前会话、大概率已在上下文。
 */
function sourceTimeOf (mem, { eventTimes }) {
  if (mem.source_event != null) {
    const t = eventTimes.get(Number(mem.source_event))
    if (Number.isFinite(t) && t > 0) return t
  }
  const t = Number(mem.created)
  return Number.isFinite(t) && t > 0 ? t : null
}

// ── 主入口：排序（含 MMR）────────────────────────────────────────────────────
/**
 * 检索 + 过滤 + 绝对量打分 + MMR 去冗余，返回按注入顺序排好的条目。
 *
 * 为什么单独导出：桥侧需要 `items[].id` 做 touchMemory（访问计数是 pruned 判据的
 * 输入），测试也需要检查每一步的中间值。`searchForPrompt()` 只是它的渲染包装。
 *
 * @param {object} opts
 * @param {object} opts.store          openV5() 的返回值
 * @param {string} opts.query          当前消息（检索词）
 * @param {string|null} [opts.subject] 关于谁（QQ 号）；群聊场景应传发言人
 * @param {string|null} [opts.conv]    当前会话（'c2c:123' / 'group:456'）
 * @param {boolean} [opts.inGroup=false]
 * @param {number} [opts.now]          秒（默认 nowSec()）
 * @param {number} [opts.limitCandidates=40] 候选池大小（先取再排序/预算）
 * @param {number} [opts.minScore=0.10] 绝对分兜底阈值（跨查询可比；真正的闸门是
 *   「有 query 时 rel 必须 > 0」，见下）
 * @param {number|false|null} [opts.contextSince=null] 水位线；false=不跳过；null=按 conv 自动算
 * @param {boolean} [opts.skipContext=true]
 * @returns {{items:Array, via:string, docCount:number, watermark:number|null,
 *            skippedContext:number, skippedScope:number, rejected:number}}
 */
export function rankMemories ({
  store, query, subject = null, conv = null, inGroup = false, now = null,
  limitCandidates = 40, minScore = 0.10, contextSince = null, skipContext = true,
} = {}) {
  if (!store) throw new Error('rankMemories: 缺 store（openV5() 的返回值）')
  const at = Number.isFinite(Number(now)) ? Number(now) : Date.now() / 1000
  const q = String(query ?? '').trim()
  const out = { items: [], via: 'none', docCount: 0, watermark: null, skippedContext: 0, skippedScope: 0, rejected: 0 }
  if (!q) return out // 空 query 不检索（桥侧也不该拿空串去猜记忆）

  const raw = fetchCandidates({ store, query: q, subject, limit: limitCandidates })
  out.via = raw.some(r => r.via === 'like') ? 'like' : raw.length ? 'fts' : 'none'
  if (!raw.length) return out

  // 水位线：调用方显式给了就用；null=按 conv 自动算；false=关闭
  let watermark = null
  if (skipContext !== false && contextSince !== false) {
    watermark = Number.isFinite(Number(contextSince)) && Number(contextSince) > 0
      ? Number(contextSince)
      : contextWatermark({ store, conv })
  }
  out.watermark = watermark

  // 全库 active 条数 N —— rel 的归一化分母（不是「本次查询最高分」，所以跨查询可比）。
  // 只做一次 COUNT，不用 stats()（那里面还有 events/utterances/jobs 四个 count）。
  try {
    const row = store.db.prepare("SELECT COUNT(*) AS n FROM memories WHERE state = 'active'").get()
    out.docCount = Number(row?.n) || 0
  } catch { out.docCount = 0 }
  const logN = Math.log(1 + Math.max(0, out.docCount))

  // 批量补全行/来源时间：每轮注入在关键路径上，不能逐条查（见 fetchMemoriesByIds 注释）
  const fullRows = fetchMemoriesByIds(store, raw.map(r => r.id))
  const eventTimes = fetchEventTimes(store, raw
    .map(r => fullRows.get(Number(r.id))?.source_event)
    .filter(v => v !== null && v !== undefined))

  const enriched = []
  for (const row of raw) {
    const full = fullRows.get(Number(row.id)) || row
    if (!visibleInContext(full, { subject, conv, inGroup, now: at })) { out.skippedScope += 1; continue }
    if (watermark !== null) {
      const src = sourceTimeOf(full, { eventTimes })
      // 「来源时间 >= 本会话最早一条」→ 这条消息还在当前会话上下文里，注入是重复信号
      if (src !== null && src >= watermark) { out.skippedContext += 1; continue }
    }
    const mem = { ...full, via: row.via || 'fts', bm25: row.bm25 ?? null }
    const bm25Score = Number(row.score)
    const rel = mem.via === 'like'
      ? LIKE_REL
      : (logN > 0 && Number.isFinite(bm25Score) ? clamp01(bm25Score / logN) : 0)
    const parts = scoreMemory({ mem, rel, now: at })
    // 真正的相关性闸门是「有 query 时 rel > 0」：零相关的高 salience/新记忆不算「记得」。
    // minScore 只是兜底地板（默认 0.10）：小库里 bm25 量纲可能很小，阈值定高了会把
    // 「又旧又相关」的情节记忆误杀；而绝对量分数本来就可以跨查询比较，地板只负责挡掉
    // 近乎零分的垃圾，不需要像 v4 那样靠阈值做精度筛选。
    if (q && parts.rel <= 0) { out.rejected += 1; continue }
    if (parts.score < Number(minScore)) { out.rejected += 1; continue }
    enriched.push({
      ...mem,
      rel: parts.rel,
      recency: parts.recency,
      salience: parts.salience,
      pinned: parts.pinned,
      typeWeight: parts.typeWeight,
      halfLifeDays: parts.halfLifeDays,
      score: parts.score,
      tokens: tokenSet(mem.text),
      relTime: relativeTimeLabel(mem.last_seen ?? mem.lastSeen, at),
      typeLabel: TYPE_LABEL[mem.type] || mem.type,
    })
  }
  if (!enriched.length) return out

  // ── MMR 贪心选择 ──────────────────────────────────────────────────────
  // 与「按分降序直接装」的区别：近似重复的条目第二条起会被惩罚，把预算让给
  // 信息增量更大的条目（§3.3 的「按信息增量分配预算」）。MMR 只和**已选中的**
  // 比，所以第一条不会被自己的相似度影响。
  // 候选池只留前 limitCandidates 条（按基础分），MMR 在池内做贪心：池外的条目
  // 基础分已经最低，被冗余惩罚也不可能翻盘。
  const poolSize = Math.max(5, Math.min(200, Number(limitCandidates) || 40))
  const remaining = enriched
    .slice()
    .sort((a, b) => (b.score - a.score) || (a.id - b.id))
    .slice(0, poolSize)
  // maxSim 增量维护：每选中一条，只需把它和剩余候选各比一次（O(n²) 次 Jaccard，
  // 而不是每轮重算 O(n³)）——这是把 p99 从 ~29ms 压下来的关键之一。
  const maxSims = new Array(remaining.length).fill(0)
  const items = []
  while (remaining.length) {
    let bestIdx = 0
    let bestAdjusted = -Infinity
    for (let i = 0; i < remaining.length; i++) {
      const adjusted = remaining[i].score - MMR_WEIGHT * maxSims[i]
      if (adjusted > bestAdjusted) { bestAdjusted = adjusted; bestIdx = i }
    }
    const picked = remaining.splice(bestIdx, 1)[0]
    const pickedSim = maxSims.splice(bestIdx, 1)[0]
    picked.mmrSim = pickedSim
    picked.adjusted = picked.score - MMR_WEIGHT * pickedSim
    // 更新剩余候选的 maxSim（新选中的这条 vs 每一条）
    for (let i = 0; i < remaining.length; i++) {
      const sim = similarity(remaining[i].tokens, picked.tokens)
      if (sim > maxSims[i]) maxSims[i] = sim
    }
    items.push(picked)
  }
  out.items = items.map(({ tokens, ...rest }) => rest) // 不把内部 tokens 泄漏给调用方
  return out
}

// ── 渲染 ────────────────────────────────────────────────────────────────────
/** 注入块标题（单独导出，测试/桥侧要对齐字数时用）。 */
export const RETRIEVAL_HEADER = '【你记得的事】'
export const UTTERANCE_HEADER = '【你最近说过的话（别复读）】'
export const PROFILE_HEADER = '【关于他】'

function formatMemoryLine (item) {
  return `- [${item.typeLabel}·${item.relTime}] ${String(item.text ?? '').trim()}`
}

/**
 * 把 rankMemories 的结果渲染成注入块，**总字数 ≤ budgetChars**（含标题）。
 *
 * 预算语义（§3.3c）：
 *   · 按分数降序装，装不下就停（不为了凑条数把半句话塞进去）；
 *   · 但如果「差一点点」能放下，就截断本条文本并结束（比留一整块空白更有用）；
 *   · 连一个条目都放不下 → 返回 ''（不注入空壳标题）。
 *
 * @param {object} opts
 * @param {Array} [opts.items]        rankMemories 的 items
 * @param {number} [opts.budgetChars=800]
 * @returns {string} 空串 = 没有可注入内容
 */
export function renderMemories ({ items = [], budgetChars = 800 } = {}) {
  const budget = Math.max(0, Math.floor(Number(budgetChars) || 0))
  if (!items.length) return ''
  const header = RETRIEVAL_HEADER
  let used = charLen(header)
  if (used > budget) return ''
  const lines = [header]
  for (const item of items) {
    const line = formatMemoryLine(item)
    const len = charLen(line)
    if (used + 1 + len <= budget) {
      used += 1 + len
      lines.push(line)
      continue
    }
    // 装不下整行：剩余空间还够放「一条有意义的截断」就截断本条并收尾
    const rest = budget - used - 1 // -1 是换行
    if (rest >= MIN_ITEM_CHARS) {
      const prefix = `- [${item.typeLabel}·${item.relTime}] `
      const room = rest - charLen(prefix)
      if (room >= 6) {
        lines.push(prefix + truncateChars(String(item.text ?? '').trim(), room))
        used = budget
      }
    }
    break // 装不下就停（后面的条目就算短也不再塞：保持「按信息增量装填」的可解释性）
  }
  if (lines.length === 1) return ''
  return lines.join('\n')
}

/**
 * 检索 → 渲染，返回**字符串**（空结果返回空串，桥侧直接 `if (!s) 不注入`）。
 * 需要细节（items/id/水位线）用 rankMemories()。
 *
 * @param {object} opts 见 rankMemories + renderMemories（budgetChars 默认 800）
 * @returns {string}
 */
export function searchForPrompt ({ budgetChars = 800, ...opts } = {}) {
  const ranked = rankMemories(opts)
  return renderMemories({ items: ranked.items, budgetChars })
}

// ── 防复读（我说过什么）─────────────────────────────────────────────────────
/**
 * 「我最近说过的话」块：给模型一个对照，避免重复夸同一张图/重复问同一个问题
 * （用户 2026-11-02 明确提过这个需求，见审计文档 P1-2）。
 *
 * 数据源优先 utterances 表（v5 的原文表）；没有时退回 events 里 speaker='self'
 * 的最近几条 —— Step 1 双写只保证 events，utterances 由 Step 2 的发送路径补，
 * 所以两条路都要能出东西。
 *
 * @param {object} opts
 * @param {object} opts.store
 * @param {string} opts.conv
 * @param {number} [opts.limit=3]
 * @param {number} [opts.now] 秒
 * @param {number} [opts.budgetChars=60] §3.7 的防复读预算
 * @returns {string} 空串 = 没有可注入内容
 */
export function utteranceBlock ({ store, conv, limit = 3, now = null, budgetChars = 60 } = {}) {
  if (!store || !conv) return ''
  const at = Number.isFinite(Number(now)) ? Number(now) : Date.now() / 1000
  const budget = Math.max(0, Math.floor(Number(budgetChars) || 0))
  let rows = []
  try { rows = store.recentUtterances({ conv, limit: Math.max(1, Math.min(20, Number(limit) || 3)) }) } catch { rows = [] }
  if (!rows.length) {
    try {
      // events 表的列叫 kind_raw（不是 utterances 的 kind）—— 这里显式别名一下，
      // 两条数据源返回的行形状保持一致，渲染代码不用分叉。
      rows = store.db.prepare(
        "SELECT id, conv, text, at, kind_raw AS kind FROM events "
        + "WHERE conv = ? AND speaker = 'self' ORDER BY at DESC LIMIT ?",
      ).all(String(conv), Math.max(1, Math.min(20, Number(limit) || 3)))
    } catch { rows = [] }
  }
  if (!rows.length) return ''
  let used = charLen(UTTERANCE_HEADER)
  if (used > budget) return ''
  const lines = [UTTERANCE_HEADER]
  for (const r of rows) {
    const text = String(r.text ?? '').replace(/\s+/g, ' ').trim()
    if (!text) continue
    const line = `- ${relativeTimeLabel(r.at, at)}：${text}`
    if (used + 1 + charLen(line) > budget) break
    used += 1 + charLen(line)
    lines.push(line)
  }
  return lines.length === 1 ? '' : lines.join('\n')
}

// ── 人物画像 ────────────────────────────────────────────────────────────────
/**
 * 人物画像块（profiles 投影的稳定事实，§3.7 的 120 字）。
 *
 * 顺序：summary（3-5 句画像）→ 偏好 → 雷点 → facts（能放多少放多少）。
 * 没有画像 / 画像全空 → ''（不注入空标题）。
 *
 * @param {object} opts
 * @param {object} opts.store
 * @param {string} opts.subject QQ 号
 * @param {number} [opts.now] 秒
 * @param {number} [opts.budgetChars=120]
 * @returns {string}
 */
export function profileBlock ({ store, subject, now = null, budgetChars = 120 } = {}) {
  if (!store || subject === null || subject === undefined || subject === '') return ''
  const at = Number.isFinite(Number(now)) ? Number(now) : Date.now() / 1000
  const budget = Math.max(0, Math.floor(Number(budgetChars) || 0))
  let profile = null
  try { profile = store.getProfile(String(subject)) } catch { profile = null }
  if (!profile) return ''

  const parts = []
  const summary = String(profile.summary ?? '').replace(/\s+/g, ' ').trim()
  if (summary) parts.push(summary)
  const prefs = Array.isArray(profile.prefs) ? profile.prefs.filter(Boolean).map(String) : []
  if (prefs.length) parts.push(`偏好：${prefs.slice(0, 6).join('、')}`)
  const dislikes = Array.isArray(profile.dislikes) ? profile.dislikes.filter(Boolean).map(String) : []
  if (dislikes.length) parts.push(`雷点：${dislikes.slice(0, 6).join('、')}`)
  const facts = Array.isArray(profile.facts) ? profile.facts : []
  const factTexts = facts
    .filter(f => f && (f.v !== undefined && f.v !== null && String(f.v).trim() !== ''))
    .map(f => (f.k ? `${f.k}=${f.v}` : String(f.v)))
  if (factTexts.length) parts.push(`事实：${factTexts.slice(0, 6).join('；')}`)
  if (!parts.length) return ''
  if (profile.updated) parts.push(`（画像 ${relativeTimeLabel(profile.updated, at)}更新）`)

  let used = charLen(PROFILE_HEADER)
  if (used > budget) return ''
  const lines = [PROFILE_HEADER]
  for (const p of parts) {
    for (const line of String(p).split('\n')) {
      const len = charLen(line)
      if (used + 1 + len <= budget) {
        used += 1 + len
        lines.push(line)
        continue
      }
      const rest = budget - used - 1
      if (rest >= MIN_ITEM_CHARS) {
        lines.push(truncateChars(line, rest))
        used = budget
      }
      break
    }
  }
  return lines.length === 1 ? '' : lines.join('\n')
}

// ── 组合入口（§3.7 的注入预算）──────────────────────────────────────────────
/** §3.7 的默认分块预算：检索 350 + 画像 120 + 防复读 60（风格/词库由桥侧另加）。 */
export const BLOCK_BUDGETS = Object.freeze({
  retrieval: 350,
  profile: 120,
  utterance: 60,
})

/** 三块合起来的总上限（§3.7 目标 ~800；这里留 800 作为硬上限，桥侧别再超）。 */
export const DEFAULT_TOTAL_BUDGET = 800

/**
 * 一次拿到「记忆注入」的全部块（画像 → 检索 → 防复读，按 §3.7 的顺序）。
 *
 * 为什么还要一个组合入口：桥侧若自己拼三块，很容易忘了总预算，结果三个块
 * 加起来又回到 1865 字。这里负责**总量兜底**（> totalBudgetChars 时从末尾的
 * 防复读块/检索块里砍，画像最后砍 —— 画像最稳定、按字最不占）。
 *
 * @param {object} opts
 * @param {object} opts.store
 * @param {string} [opts.query]
 * @param {string|null} [opts.subject]
 * @param {string|null} [opts.conv]
 * @param {boolean} [opts.inGroup=false]
 * @param {number} [opts.now]
 * @param {number} [opts.totalBudgetChars=800]
 * @param {object} [opts.budgets] 覆盖 BLOCK_BUDGETS（{retrieval, profile, utterance}）
 * @returns {{block:string, chars:number, blocks:{profile:string, retrieval:string, utterances:string},
 *            charsByBlock:{profile:number, retrieval:number, utterances:number}}}
 */
export function buildMemoryBlocks ({
  store, query = '', subject = null, conv = null, inGroup = false, now = null,
  totalBudgetChars = DEFAULT_TOTAL_BUDGET, budgets = {},
} = {}) {
  const at = Number.isFinite(Number(now)) ? Number(now) : Date.now() / 1000
  const b = {
    retrieval: Math.max(0, Number(budgets.retrieval ?? BLOCK_BUDGETS.retrieval) || 0),
    profile: Math.max(0, Number(budgets.profile ?? BLOCK_BUDGETS.profile) || 0),
    utterance: Math.max(0, Number(budgets.utterance ?? BLOCK_BUDGETS.utterance) || 0),
  }
  const profile = profileBlock({ store, subject, now: at, budgetChars: b.profile })
  const retrieval = searchForPrompt({
    store, query, subject, conv, inGroup, now: at, budgetChars: b.retrieval,
  })
  const utterances = utteranceBlock({ store, conv, now: at, budgetChars: b.utterance })

  // 总量兜底：超了先砍防复读，再砍检索末尾，画像最后砍（稳定事实最不该丢）。
  // ⚠️ 预算按**最终拼出来的字符串**算：块之间的 '\n\n' 也算字数，不然
  //    「三块各 350 字」拼起来会悄悄超 4 个字。
  const cap = Math.max(0, Math.floor(Number(totalBudgetChars) || 0))
  const blocks = { profile, retrieval, utterances }
  const joinBlocks = () => [blocks.profile, blocks.retrieval, blocks.utterances].filter(Boolean).join('\n\n')
  const trimTo = (text, keep) => {
    const cs = [...text]
    if (cs.length <= keep) return text
    return keep <= 1 ? '' : cs.slice(0, keep - 1).join('') + '…'
  }
  const trimOrder = ['utterances', 'retrieval', 'profile']
  for (let guard = 0; guard < 8 && charLen(joinBlocks()) > cap; guard++) {
    const overflow = charLen(joinBlocks()) - cap
    const target = trimOrder.find(k => blocks[k])
    if (!target) break
    const keep = Math.max(0, charLen(blocks[target]) - overflow)
    // 只剩标题（≤ 12 字）就整块去掉，避免留下一个孤零零的【…】标题
    blocks[target] = keep > 12 ? trimTo(blocks[target], keep) : ''
  }
  const block = joinBlocks()
  return {
    block,
    chars: charLen(block),
    blocks,
    charsByBlock: {
      profile: charLen(blocks.profile),
      retrieval: charLen(blocks.retrieval),
      utterances: charLen(blocks.utterances),
    },
  }
}

/**
 * 打开 v5 store 的便捷入口（桥/测试用）：
 *   const store = openStoreForPrompt({ dbPath })   // = openV5({dbPath})
 * 单独导出只是为了让接入方不用 import 两个模块。
 */
export { openV5, v5DbPath } from './store.mjs'
