// lib/agent/memory-v5/distill.mjs —— 记忆 v5 的**提炼 worker**（Step 2）
// ============================================================================
// 职责：events（原文）→ memories（结论）+ profiles（人物画像投影）。
//
// 设计对照 docs/MEMORY-AUDIT-AND-V5.md §3.6（提炼：失败必须可见，且窗口不能是
// 单向传送带）。v4 的 reflect 有三宗罪，这里逐条反着做：
//
//   ① **失败也打标**（P0-1）：v4 在 fallback 时把「扫描到的 80 条」全标 reflected，
//      下一轮再也不处理，等于静默丢记忆。
//      → v5 用 **watermark + 幂等去重**：watermark 只有在「LLM 成功 + 记忆写进库」
//      之后才推进；crash 在中间最坏只是重跑同一批，而重跑不会产生重复
//      （同文去重 + 同 key 取代），所以重放是安全的（不是「靠标记避免重跑」）。
//
//   ② **168 小时滑动窗口**（P0-7）：超过 7 天没被提炼的 episodic 永久滑出窗口，
//      现网 577 条里有 375 条已经滑出去了。
//      → v5 **没有时间窗口**：只按 `id > watermark` 取增量，积压多少处理多少。
//
//   ③ **失败不可见**（P1-5）：绿着坏。
//      → v5 走 jobs 表：失败 → attempts++ + 指数退避 → 3 次进 dead；last_error /
//      last_error_kind 落库；`distillStatus()` 直接给设置页/调度器读。
//      「LLM 没配」按 §3.6 的约定算 **unavailable = 跳过且不算失败**（不累计
//      attempts、不进死信），但**必须留痕**（v5_meta 里 last_unavailable +
//      retry_after），不能让用户以为一切正常。
//
// 增量怎么记（为什么不用加列）：store.mjs 的 events 表没有 distilled 标记列
// （DDL 里也没有），所以这里用 `v5_meta` 里的 **watermark**（已处理到的最大 event id）。
// 好处是零 schema 变更；代价是「只支持按 id 顺序处理」，这也正是我们要的
// （events 是只追加的，id 单调）。
//
// 单调性 & 并发：watermark 只在成功后推进，且用**单条 UPDATE/INSERT** 写入
// （v5_meta 主键 upsert），两个 worker 同时跑最多是「同一批处理两遍」，不会丢。
// 真正避免重复的是去重逻辑（见 ingestMemories）。调度器侧应当只起一个 worker。
// ============================================================================
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { nowSec, ftsTokens } from './store.mjs'
import {
  buildDistillPrompt, canonicalEventText, isUsableEvent, parseDistillOutput, DEFAULT_TZ,
} from './distill-prompt.mjs'
import { memoryCode } from '../dirs.mjs'
import { memoryEnv } from '../memory-run.mjs'

// ── 错误分类（§3.6：unavailable 跳过不算失败，runtime 才重试）──────────────────
/**
 * 提炼过程中的「模型侧」错误。
 * kind='unavailable' → 没配模型 / 找不到配置 / 起不来（重试也没用，跳过但留痕）
 * kind='runtime'     → 超时 / 报错 / 输出不是 JSON（重试可能好）
 */
export class LlmError extends Error {
  constructor (kind, message) {
    super(message)
    this.name = 'LlmError'
    this.kind = kind === 'unavailable' ? 'unavailable' : 'runtime'
  }
}

/** 把任意异常归成 §3.6 的两类（永远有答案，绝不静默）。 */
export function errorKindOf (err) {
  if (err && err.kind === 'unavailable') return 'unavailable'
  // 明确的「没配/找不到」也归 unavailable（reflection_llm 的 exit 2 语义）
  const msg = String(err?.message ?? err ?? '')
  if (/找不到.*(配置|脚本|reflection_llm)|模型不可用|no api key|未配置模型|缺少 LLMINQQ_CONFIG/i.test(msg)) {
    return 'unavailable'
  }
  return 'runtime'
}

// ── 默认 LLM 适配器：复用 v4 的 reflection_llm.mjs（薄壳）──────────────────────
/**
 * 跑一个子进程并收集结果（异步，不阻塞事件循环 —— 提炼可能跑几十秒）。
 * @returns {Promise<{code:number|null, signal:string|null, timedOut:boolean, stderr:string, error?:Error}>}
 */
function runChild (bin, args, { timeoutMs, env }) {
  return new Promise((resolve) => {
    let done = false
    let timedOut = false
    let stderr = ''
    const finish = (obj) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ timedOut, stderr, ...obj })
    }
    let child
    try {
      child = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (err) {
      resolve({ code: null, signal: null, timedOut: false, stderr: '', error: err })
      return
    }
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGKILL') } catch { /* ignore */ }
      // 兜底：万一 kill 不生效（极小概率的僵死子进程），2 秒后也要 resolve，
      // 否则 worker 会永远挂在这一步、jobs 里那条永远 running。
      setTimeout(() => finish({ code: null, signal: 'SIGKILL' }), 2000).unref?.()
    }, Math.max(200, Number(timeoutMs) || 60000))
    timer.unref?.()
    child.stderr?.on('data', d => { if (stderr.length < 4000) stderr += String(d) })
    child.stdout?.on('data', () => { /* 输出走 out-file，stdout 只是为了不撑满管道 */ })
    child.on('error', err => finish({ code: null, signal: null, error: err }))
    child.on('close', (code, signal) => finish({ code, signal }))
  })
}

/**
 * 默认 `llm()` 实现：和 v4 的 memctl._call_llm_via_acp 同一套调用方式 ——
 * 起 `node reflection_llm.mjs --prompt-file P --out-file O --timeout S`，
 * 结果从 out.json 读（{ok, text, error}）。退出码语义沿用那个薄壳的约定：
 *   0 成功 / 2 模型不可用 / 3 调用超时 / 1 其它错误
 *
 * 为什么复用而不是另写一套 ACP 调用：reflection_llm.mjs 已经处理了
 * 「插件版/脚本版两种布局找配置」「Windows 上 dsh.cmd」「ACP 超时」这些坑，
 * 而且 Step 1 起桥配置里 dsh 段是唯一权威来源。再写一套必然分叉。
 *
 * @param {object} opts
 * @param {object} [opts.cfg]         插件配置（用来定位 reflection_llm.mjs / 环境变量）
 * @param {string|null} [opts.configPath] 桥配置路径（LLMINQQ_CONFIG）
 * @param {number} [opts.timeoutMs=90000]
 * @param {string|null} [opts.nodeBin]  默认 process.execPath（和 v4 的 NODE_BIN 一致）
 * @param {string|null} [opts.scriptPath] 默认包内 reflection_llm.mjs（测试注入假脚本用）
 * @param {object|null} [opts.env]      子进程环境（默认 memoryEnv({cfg, configPath})）
 * @returns {(prompt:string)=>Promise<string>}
 */
export function createAcpLlm ({
  cfg = {}, configPath = null, timeoutMs = 90000, nodeBin = null, scriptPath = null, env = null,
  // 外层硬超时（杀掉子进程）：默认给内部 --timeout 留 60s 收尾时间。
  // 测试里调小它就能验证「超时 → runtime」这条路径，不用真等 90 秒。
  hardTimeoutMs = null,
} = {}) {
  const script = scriptPath || memoryCode(cfg).reflectionLlm
  const node = nodeBin || process.env.NODE_BIN || process.execPath
  return async function llm (prompt) {
    if (!script || !fs.existsSync(script)) {
      throw new LlmError('unavailable', `找不到 reflection_llm.mjs：${script}（插件包不完整？）`)
    }
    if (!node) throw new LlmError('unavailable', '找不到 node（NODE_BIN / process.execPath 都为空）')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v5-distill-'))
    const promptFile = path.join(dir, 'prompt.txt')
    const outFile = path.join(dir, 'out.json')
    try {
      fs.writeFileSync(promptFile, String(prompt ?? ''), 'utf8')
      const childEnv = env || memoryEnv({ cfg, configPath })
      const res = await runChild(node, [
        script, '--prompt-file', promptFile, '--out-file', outFile,
        '--timeout', String(Math.max(1, Math.ceil(Number(timeoutMs) / 1000))),
      ], {
        timeoutMs: Number(hardTimeoutMs) > 0 ? Number(hardTimeoutMs) : Number(timeoutMs) + 60000,
        env: childEnv,
      })

      if (res.error) throw new LlmError('unavailable', `起模型子进程失败：${res.error.message}`)
      const tail = String(res.stderr || '').trim().split('\n').filter(Boolean).pop() || ''

      let data = null
      try { data = JSON.parse(fs.readFileSync(outFile, 'utf8')) } catch { data = null }
      if (!data) {
        if (res.timedOut || res.code === 3) {
          throw new LlmError('runtime', `模型调用超时（>${Math.round(Number(timeoutMs) / 1000)}s）`)
        }
        // 没有结果文件：薄壳只在「起不来/没配置」时这样（exit 2 = 模型不可用），
        // 所以归 unavailable；exit 3 / 被硬杀 = 超时（可重试）。
        const kind = (res.code === 3 || res.timedOut) ? 'runtime' : 'unavailable'
        throw new LlmError(kind, `模型调用未产出结果（exit=${res.code}${res.signal ? ` signal=${res.signal}` : ''}）`
          + (tail ? `：${tail.slice(0, 200)}` : ''))
      }
      if (!data.ok) {
        const msg = String(data.error || '模型调用失败')
        throw new LlmError(res.code === 2 ? 'unavailable' : 'runtime', msg)
      }
      return String(data.text ?? '')
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  }
}

// ── v5_meta 里的 worker 状态（不动 schema，见文件头）──────────────────────────
const META = Object.freeze({
  watermark: 'distill:watermark',          // 已处理到的最大 event id
  lastSuccessAt: 'distill:last_success_at',
  lastError: 'distill:last_error',
  lastErrorKind: 'distill:last_error_kind',
  lastUnavailable: 'distill:last_unavailable', // JSON {at, reason}
  retryAfterAt: 'distill:retry_after',     // LLM 不可用时的下一轮重试时间（秒）
})

function readMeta (store, key) {
  try {
    const row = store.db.prepare('SELECT v FROM v5_meta WHERE k = ?').get(key)
    if (!row) return null
    const v = String(row.v ?? '')
    if ((v.startsWith('{') && v.endsWith('}')) || (v.startsWith('[') && v.endsWith(']'))) {
      try { return JSON.parse(v) } catch { return v }
    }
    return v
  } catch { return null }
}

function writeMeta (store, key, value) {
  const v = value === null || value === undefined
    ? ''
    : (typeof value === 'string' ? value : JSON.stringify(value))
  store.db.prepare(`INSERT INTO v5_meta(k, v) VALUES (?, ?)
    ON CONFLICT(k) DO UPDATE SET v = excluded.v`).run(key, v)
  return v
}

function clearMeta (store, key) {
  try { store.db.prepare('DELETE FROM v5_meta WHERE k = ?').run(key) } catch { /* ignore */ }
}

/** 已处理到的 event id（watermark）。 */
export function getWatermark (store) {
  const n = Number(readMeta(store, META.watermark) ?? 0)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/**
 * 积压情况：watermark 之后还有多少事件、最大 id 是多少。
 * @returns {{watermark:number, maxEventId:number, pending:number, hasBacklog:boolean}}
 */
export function distillBacklog ({ store } = {}) {
  if (!store) throw new Error('distillBacklog: 需要 store')
  const watermark = getWatermark(store)
  const maxRow = store.db.prepare('SELECT MAX(id) AS m FROM events').get()
  const maxEventId = Number(maxRow?.m ?? 0)
  let pending = 0
  try {
    pending = Number(store.db.prepare('SELECT COUNT(*) AS n FROM events WHERE id > ?').get(watermark)?.n ?? 0)
  } catch { pending = Math.max(0, maxEventId - watermark) }
  return { watermark, maxEventId, pending, hasBacklog: pending > 0 }
}

// ── 人物画像投影（确定性渲染，不调模型）──────────────────────────────────────
/**
 * 把某个 subject 的 active 记忆渲染成 3~5 句 summary + prefs/facts JSON。
 *
 * 为什么用确定性渲染而不是再调一次 LLM：profiles 是「稳定层」，每次投影都
 * 重新问模型会让 summary 抖动（同一份数据两次跑出不同画像，用户会觉得它记性
 * 变差了）。渲染规则固定 → 画像只随记忆变化而变化。而且少一次 LLM 调用就少
 * 一个失败点（§3.7 里 profiles 只是 120 字的注入块，不值得为它加一次模型调用）。
 *
 * @param {object} opts
 * @param {object} opts.store
 * @param {string} opts.subject
 * @param {number} [opts.now]
 * @param {number} [opts.maxSentences=3] 最多几句。文档 §3.7 说「3-5 句」，但**注入块
 *   总共只有 120 字**（search.mjs 的 BLOCK_BUDGETS.profile），5 句很容易把
 *   prefs/facts 挤掉。取 3 句（下限）给偏好/事实留位置；要更长传参数即可。
 * @returns {{subject:string, summary:string, prefs:string[], facts:Array, sentences:number}|null}
 */
export function projectProfile ({ store, subject, now = nowSec(), maxSentences = 3 } = {}) {
  if (!store) throw new Error('projectProfile: 需要 store')
  const subj = String(subject ?? '').trim()
  if (!subj) return null
  const rows = store.db.prepare(`SELECT id, type, text, key, confidence, salience, last_seen
    FROM memories
    WHERE state = 'active' AND subject = ? AND type IN ('fact', 'preference', 'relation')
    ORDER BY salience DESC, last_seen DESC LIMIT 8`).all(subj)
  if (!rows.length) return null

  const picked = rows.slice(0, Math.max(1, Math.min(5, Number(maxSentences) || 5)))
  const summary = picked.map(r => {
    const t = String(r.text ?? '').trim().replace(/[。.!！]+$/, '')
    return t ? `${t}。` : ''
  }).filter(Boolean).join('')

  const prefs = rows.filter(r => r.type === 'preference').map(r => String(r.text ?? '').trim()).filter(Boolean)
  const facts = rows.filter(r => r.type === 'fact').map(r => {
    // key = type:subject:topic → 取 topic 当 k（画像里「职业: 学生」比「fact#12」有用）
    const topic = String(r.key ?? '').split(':').slice(2).join(':').trim()
    return { k: topic || `fact#${r.id}`, v: String(r.text ?? '').trim(), confidence: Number(r.confidence) || 0.6 }
  }).filter(f => f.v)

  store.upsertProfile({ subject: subj, summary, prefs, facts })
  return { subject: subj, summary, prefs, facts, sentences: picked.length }
}

/** 对一批 subject 做画像投影（distill 之后自动调，跳过 null / 非 QQ 号）。 */
export function projectProfiles ({ store, subjects = [], now = nowSec() } = {}) {
  const out = []
  for (const s of new Set((subjects || []).map(String))) {
    if (!s || s === 'self' || !/^\d{4,15}$/.test(s)) continue
    try {
      const p = projectProfile({ store, subject: s, now })
      if (p) out.push(p)
    } catch { /* 单个画像失败不该影响提炼结果 */ }
  }
  return out
}

// ── supersede 目标查找（精确 key 优先，其次同 type+subject 的文本相似度）──────
//
// 为什么需要「相似度」这条路（task-21）：
//   Step 3 的迁移脚本（scripts/memory-v4-to-v5.mjs）给历史记忆的 key 是
//   `sha1(type \x1f subject \x1f 归一化文本)`；而 distill 新建记忆的 key 是
//   `type:subject:topic`（人读的主题词）。两套 key 永远精确匹配不上 →
//   **迁移来的旧条目永远不会被取代**，同一个主题新旧两条并存，检索里两条都进
//   （噪音率直接翻倍，正是这次要修的）。
//   所以：精确 key 只是「快路径」，命中不了就在**同 type + 同 subject** 范围内
//   用文本相似度找最像的那条 —— 迁移条目的正文和 distill 新结论通常措辞接近
//   （新结论往往就是「对方 + 原话」），相似度够高就按 supersede 归档。
//
// 为什么是「bigram 集合的 max(Jaccard, containment)」而不是纯 Jaccard：
//   · Jaccard 对长度不对称惩罚过重：旧条「安全底裤还没做」（6 个 bigram）与
//     新结论「对方的安全底裤还没做」（9 个）交集 6 → Jaccard=6/9=0.67 还行；
//     但如果新结论更长（「…已经生效很久了」13 个），Jaccard 会掉到 0.19，
//     明明说的是同一件事却合并不上。
//   · containment（交集 / 较短那个集合）= 3/6=0.5，正好覆盖「旧结论是一句话、
//     新结论是它的加长/改写版」这种真实形态。
//   · 取 max 就是「任一指标够像就算像」，再用阈值 0.5 兜住误合并。
//   阈值 0.5 的依据（本机实测构造数据；用 `textSimilarity()` 可复算）：
//     · 只加主语/加长（「喜欢冰美式」→「对方喜欢冰美式」）→ score 1.0 ✓ 合并
//     · 同事件改时间（「明天下午三点开会」→「明天下午两点开会」）→ 0.714 ✓ 合并
//     · 同主题换结论短句（「安全底裤还没做」→「…已经生效很久了」）→ 0.5 ✓ 合并
//     · 弱相关/并列事实（「他喜欢猫」vs「他喜欢狗」）→ 0.667 ⚠️ 会过阈值
//       —— 这是文本相似度的固有局限：它分不清「取代」和「补充」。四道防线：
//       ① **topic 闸**（见 topicsConflict）：双方都有 topic 且不同 → 直接不合并。
//          这一条就能挡住绝大多数「并列事实」（distill 自己建的条目都带 topic）。
//       ② 严格限制同 type + 同 subject（「两个人都提到开会」不会互相取代）；
//       ③ 只归档**一条**（相似度最高那条），不批量误伤；
//       ④ 归档不是删除（state='archived'，检索可 includeArchived 捞回来），
//          阈值可配（`minSupersedeScore`），生产上觉得误合并多就调到 0.6~0.7。
//   剩下真正挡不住的只有「迁移来的 sha1 旧条 vs 新增的相反事实」这种，
//   而它本来就是我们要合并的目标场景（旧结论被新结论取代）。
//
// 候选上限（性能）：FTS top `supersedeCandidates`（默认 10）→ 每条只做一次
// bigram 集合运算（几微秒）。FTS 命中不足 3 条时再补「同 type+subject 最近 20 条」
// 兜底 —— 否则「只差一个词」的旧条目可能因为 FTS 稀疏而被漏掉。
// 两次查询都走索引（idx_mem_subject / idx_mem_type + FTS），单次 <1ms。

/** 迁移脚本给的 key：40 位 sha1（没有可读主题）。 */
const SHA1_KEY_RE = /^[0-9a-f]{40}$/

/**
 * 从 key 里取出「主题词」。两类 key 的区别见文件头：
 *   · distill 建的：`type:subject:topic`（topic 是人读主题词）→ 返回 topic
 *   · 迁移来的：`sha1(...)`（40 位 hex，没有主题信息）→ 返回 null
 *
 * @param {string|null} key
 * @returns {string|null}
 */
export function topicFromKey (key) {
  if (!key) return null
  const k = String(key)
  if (SHA1_KEY_RE.test(k)) return null
  const parts = k.split(':')
  if (parts.length < 3) return null
  const topic = parts.slice(2).join(':').trim()
  return topic || null
}

/**
 * 「双方都有主题、但主题不同 → 不许按相似度合并」的闸（本任务最重要的防误并）。
 *
 * 为什么必须有它（我自己的测试抓到的真实反例）：
 *   同一个人、同 type 的两条**并列事实**——「对方在杭州做后端开发」（topic=职业）
 *   和「对方住在杭州」（topic=城市）—— bigram 相似度 containment=0.6，超过阈值
 *   0.5 → 会被误判成「城市取代职业」，直接丢一条真事实。
 *   但因为两条都带 topic，而且 topic 不同，我们知道它们**不是同一个话题**，
 *   可以安全地不合并。
 *   反过来，迁移来的旧条目是 sha1 key → 没有 topic 信息 → 这条闸不生效，
 *   相似度兜底照样工作（这正是 task-21 要解决的目标场景）。
 *
 * 也就是说：**知道得越多，越不应该猜。** 只有「至少一方不知道主题」时
 * 才让相似度说话。
 */
function topicsConflict (newTopic, oldTopic) {
  return Boolean(newTopic && oldTopic && newTopic !== oldTopic)
}

/** supersede 相似度阈值（默认 0.5，见上面注释的依据）。 */
export const DEFAULT_SUPERSEDE_MIN_SCORE = 0.5
/** 相似度候选上限（FTS top N）。 */
export const DEFAULT_SUPERSEDE_CANDIDATES = 10
/** FTS 稀疏时补查的「同 type+subject 最近 active」条数。 */
export const DEFAULT_SUPERSEDE_RECENT = 20

/**
 * 两段文本的相似度（bigram 集合）。分词直接用 store 的 ftsTokens —— 和 FTS
 * 索引同一套规则，「检索能命中的对」和「相似度能算的对」才是同一个集合。
 *
 * 为什么 score = max(jaccard, containment)：
 *   要能盖上「旧句 → 加长版」这种改写，比如
 *     「喜欢冰美式」→「对方最喜欢喝冰美式」
 *   Jaccard 会被长度拖低（0.44），containment（短句的 token 有多少被长句覆盖）= 0.75。
 *   取 max 才能合上。这条语义有测试锁着，别改成纯 Jaccard。
 *
 * 🔴 但纯 max 有个退化情形（2026-11-07 实测发现）：
 *   containment = shared / min(|A|,|B|)，当**短句只有 1 个 bigram** 时，
 *   只要那一个 bigram 出现在长句里，containment 就是 **1.0** —— 语义上毫无意义：
 *     「嘿嘿(*^▽^*)」 vs 「明天休息，嘿嘿」 → score 1.00（其实只是都含「嘿嘿」）
 *     「hello？」      vs 「hello，你还在吗？」 → score 1.00
 *   ephemeral 短句（表情/语气词）在库里大量存在，这会让 supersede **误合并**：
 *   一条新的短闲聊能把别的记忆归档掉。反过来，真正的长句改写
 *   （「乖宝」三条）相似度只有 0.25~0.5，还是合不上。
 *
 *   所以给 containment 加一个**最小可信度门槛**：至少共享 2 个 bigram，
 *   且短句至少有 2 个 bigram。不满足就退回 Jaccard（短句之间的真重复
 *   仍然能被 Jaccard 抓住，见用例）。
 *
 * @param {string} a
 * @param {string} b
 * @returns {{score:number, jaccard:number, containment:number, shared:number, containmentTrusted:boolean}}
 *   三者都在 0~1；containmentTrusted 说明 score 里那个 containment 是否可信。
 */
export function textSimilarity (a, b) {
  const A = new Set(ftsTokens(String(a ?? '')))
  const B = new Set(ftsTokens(String(b ?? '')))
  if (!A.size || !B.size) return { score: 0, jaccard: 0, containment: 0, shared: 0, containmentTrusted: false }
  let shared = 0
  for (const t of A) if (B.has(t)) shared += 1
  const union = A.size + B.size - shared
  const jaccard = union > 0 ? shared / union : 0
  const minSize = Math.min(A.size, B.size)
  const containment = shared / minSize
  // 退化保护：短句只有 1 个 bigram 时 containment 恒为 1，不能作为「同义」证据。
  const containmentTrusted = shared >= 2 && minSize >= 2
  return {
    score: Math.max(jaccard, containmentTrusted ? containment : 0),
    jaccard, containment, shared, containmentTrusted,
  }
}

/**
 * 找「可能被这条新记忆取代」的旧条目（**只读**，不归档；归档在 ingestMemories）。
 *
 * 约束（task-21 要求）：
 *   · 只同 type、只同 subject（subject=null 只和 null 比 —— 群级 vs 私人不能混）；
 *   · 只 active（已 archived 的不重复处理）；
 *   · excludeId 排除刚插入的新行自己（否则它和自己相似度 = 1.0）；
 *   · 返回按 score 降序，最多 `limit` 条（默认只取 top1 用于归档，测试可看全部）。
 *
 * @param {object} opts
 * @param {object} opts.store
 * @param {string} opts.type
 * @param {string|null} opts.subject
 * @param {string} opts.text
 * @param {number|null} [opts.excludeId]
 * @param {number} [opts.minScore=0.5]
 * @param {number} [opts.limit=10]
 * @param {number} [opts.recentLimit=20]
 * @returns {Array<{id:number,score:number,jaccard:number,containment:number,text:string,subject:string|null,type:string}>}
 */
export function findSupersedeCandidates ({
  store, type, subject = null, text, excludeId = null,
  newKey = null,
  minScore = DEFAULT_SUPERSEDE_MIN_SCORE,
  limit = DEFAULT_SUPERSEDE_CANDIDATES,
  recentLimit = DEFAULT_SUPERSEDE_RECENT,
} = {}) {
  if (!store) throw new Error('findSupersedeCandidates: 需要 store')
  const q = String(text ?? '').trim()
  if (!q) return []
  const wantSubject = subject === null || subject === undefined ? null : String(subject)
  const min = Math.min(1, Math.max(0, Number(minScore)))
  const lim = Math.max(1, Math.min(50, Number(limit) || DEFAULT_SUPERSEDE_CANDIDATES))

  const newTopicForGuard = topicFromKey(newKey)
  /** 统一后置过滤：subject 必须完全一致（searchFts 的 null 语义是「不过滤」） */
  const sameSubject = r => (wantSubject === null
    ? (r.subject === null || r.subject === undefined)
    : String(r.subject) === wantSubject)

  let rows = []
  try {
    // FTS 召回：subject 非空时下推给 SQL；null 时不能下推（store 的语义是不过滤），
    // 靠后置过滤保证「群级只和群级比」。
    rows = store.searchFts({
      query: q,
      limit: lim,
      type,
      subject: wantSubject,
      includeArchived: false,
    })
  } catch { rows = [] }
  rows = rows.filter(r => r && r.text && sameSubject(r))

  // 第二路召回：同 type + 同 subject 的**最近 active**（走 idx_mem_subject）。
  // 为什么两路都要（实测 3000 条库）：
  //   · FTS（bm25 排序）召回准，但一条要 ~6ms（bm25 要给所有命中打分再排序），
  //     而且 top10 里可能挤满「只是共享『对方』这种高频 bigram」的条目；
  //   · 最近窗口只要 ~0.3ms，且覆盖「FTS 排序把它挤出 top10」的那类旧条目
  //     （典型：迁移来的行 id 很小、bm25 不占优）。
  // 两路合起来 ≤ FTS 10 + recent 20 = 30 个候选，每个只做一次 bigram 集合运算
  // （微秒级）。这是「候选上限」的全部含义：不随库增大而变慢。
  try {
    const extra = store.db.prepare(`SELECT id, type, subject, text, key FROM memories
      WHERE state = 'active' AND type = ? AND (subject IS ? OR subject = ?)
      ORDER BY last_seen DESC, id DESC LIMIT ?`).all(type, wantSubject, wantSubject, Math.max(1, Number(recentLimit) || 20))
    const seen = new Set(rows.map(r => Number(r.id)))
    for (const r of extra) {
      if (seen.has(Number(r.id))) continue
      if (!r?.text) continue
      seen.add(Number(r.id))
      rows.push(r)
    }
  } catch { /* 第二路失败就只用 FTS 结果 */ }

  // FTS 的行里没有 key（store.searchFts 不返回它），但 topic 闸需要它。
  // 只有「新条自带 topic」时才要补查 —— 新条没 topic 时闸本来就不生效。
  const keyById = new Map()
  if (rows.length && newTopicForGuard) {
    try {
      const ids = rows.map(r => Number(r.id)).filter(Number.isFinite)
      if (ids.length) {
        const stmt = store.db.prepare(`SELECT id, key FROM memories WHERE id IN (${ids.map(() => '?').join(',')})`)
        for (const row of stmt.all(...ids)) keyById.set(Number(row.id), row.key ?? null)
      }
    } catch { /* 补查失败就让 topic 闸退化（不阻塞主流程） */ }
  }
  const newTopic = newTopicForGuard
  const out = []
  for (const row of rows) {
    const id = Number(row.id)
    if (!Number.isFinite(id)) continue
    if (excludeId !== null && excludeId !== undefined && id === Number(excludeId)) continue
    // FTS 行没有 key：用补查结果；
    const candKey = row.key !== undefined ? row.key : (keyById.get(id) ?? null)
    // 双方都有主题且不同 → 不是同一个话题（并列事实），不许相似度合并
    if (topicsConflict(newTopic, topicFromKey(candKey))) continue
    const sim = textSimilarity(q, row.text)
    if (sim.score < min) continue
    out.push({
      id, score: sim.score, jaccard: sim.jaccard, containment: sim.containment,
      text: String(row.text), subject: row.subject ?? null, type: row.type ?? type, key: candKey,
    })
  }
  out.sort((a, b) => b.score - a.score || b.id - a.id)   // 同分取更新的那条（更像「当前版本」）
  return out.slice(0, lim)
}

/**
 * 决定这条新记忆要取代谁（**精确 key 优先**，其次相似度 top1）。
 *
 * 优先级是任务要求：精确 key 命中时不再看相似度 —— 同 key 的语义最强
 * （同一个 type+subject+主题），相似度只用来兜「key 体系对不上」的历史数据。
 *
 * @returns {{targets:Array<{id,score?,via}>, via:'key'|'similarity'|'none', best:object|null}}
 */
export function findSupersedeTarget ({
  store, key = null, type, subject = null, text, excludeId = null,
  minScore = DEFAULT_SUPERSEDE_MIN_SCORE, limit = DEFAULT_SUPERSEDE_CANDIDATES,
} = {}) {
  if (!store) throw new Error('findSupersedeTarget: 需要 store')
  // ① 精确 key（distill 自己建的条目走这条；多条同 key 都归档）
  if (key) {
    const rows = store.findActiveByKey({ type, subject, key })
      .filter(r => r && (excludeId === null || excludeId === undefined || Number(r.id) !== Number(excludeId)))
    if (rows.length) {
      return { targets: rows.map(r => ({ id: Number(r.id), score: 1, via: 'key' })), via: 'key', best: null }
    }
  }
  // ② 同 type+subject 的文本相似度（迁移来的 sha1 key 走这条）
  const cands = findSupersedeCandidates({ store, type, subject, text, excludeId, newKey: key, minScore, limit })
  if (!cands.length) return { targets: [], via: 'none', best: null }
  const best = cands[0]
  return { targets: [{ id: best.id, score: best.score, via: 'similarity' }], via: 'similarity', best }
}

/**
 * supersede 情况的只读报告（生产迁移后验收用；不写库）。
 *
 * 用法见回执：`node -e "…supersedeReport({store})"`。
 *
 * @param {object} opts
 * @param {object} opts.store
 * @param {number} [opts.examples=10] 附带多少条样例
 * @returns {object}
 */
export function supersedeReport ({ store, examples = 10 } = {}) {
  if (!store) throw new Error('supersedeReport: 需要 store')
  const count = sql => Number(store.db.prepare(sql).get()?.n ?? 0)
  const rows = store.db.prepare(`SELECT old.id AS old_id, old.text AS old_text, old.type AS type,
      old.subject AS subject, old.superseded_by AS new_id, newm.text AS new_text, old.valid_until
    FROM memories old
    JOIN memories newm ON newm.id = old.superseded_by
    WHERE old.state = 'archived' AND old.archived_reason = 'superseded'
    ORDER BY old.id DESC LIMIT ?`).all(Math.max(1, Math.min(100, Number(examples) || 10)))
  return {
    active: count("SELECT COUNT(*) AS n FROM memories WHERE state = 'active'"),
    archived: count("SELECT COUNT(*) AS n FROM memories WHERE state = 'archived'"),
    superseded: count("SELECT COUNT(*) AS n FROM memories WHERE state = 'archived' AND archived_reason = 'superseded'"),
    expired: count("SELECT COUNT(*) AS n FROM memories WHERE state = 'archived' AND archived_reason = 'expired'"),
    // 迁移条目的 key 是 40 位 sha1（distill 的 key 形如 type:subject:topic）
    supersededFromMigratedKey: count(`SELECT COUNT(*) AS n FROM memories old
      WHERE old.state = 'archived' AND old.archived_reason = 'superseded'
        AND old.key IS NOT NULL AND length(old.key) = 40`),
    brokenChain: count(`SELECT COUNT(*) AS n FROM memories
      WHERE state = 'archived' AND archived_reason = 'superseded' AND superseded_by IS NULL`),
    examples: rows.map(r => ({
      oldId: Number(r.old_id), newId: Number(r.new_id), type: r.type, subject: r.subject,
      oldText: String(r.old_text || ''), newText: String(r.new_text || ''),
    })),
  }
}

// ── 把解析出来的记忆写进库（幂等 + superseded 链）───────────────────────────
/**
 * @param {object} opts
 * @param {object} opts.store
 * @param {Array} opts.items        parseDistillOutput 的输出
 * @param {Map<number, object>} opts.eventsById  event id → 行（用于 source_event / conv 回填）
 * @param {number[]} opts.includedIds 本批喂进 prompt 的 event id 顺序（src 行号 → event id）
 * @param {string|null} opts.singleConv 本批只有一个 conv 时用它兜底
 * @param {number} opts.now
 * @returns {{created:number, superseded:number, touched:number, ids:number[], subjects:string[]}}
 */
export function ingestMemories ({
  store, items = [], eventsById = new Map(), includedIds = [], singleConv = null, now = nowSec(),
  // supersede 阈值/候选数（task-21）：默认 0.5 / 10，见 findSupersedeCandidates 的注释
  minSupersedeScore = DEFAULT_SUPERSEDE_MIN_SCORE,
  supersedeCandidates = DEFAULT_SUPERSEDE_CANDIDATES,
} = {}) {
  const out = {
    created: 0, superseded: 0, touched: 0, ids: [], subjects: [],
    // 取代来源分开计（生产验收要看「精确 key 合并了多少 / 相似度兜住多少」）
    supersededByKey: 0, supersededBySimilarity: 0, merges: [],
  }
  const subjects = new Set()
  for (const m of items) {
    // ① 同文去重（幂等）：watermark 没跟上 / 同一批重跑时，同一条不该再进库。
    // ⚠️ 必须带上 type + subject：不同的人说同一句话（「我在杭州上班」）是**两条**
    //    记忆，只按 text 去重会把第二个人吞进第一个人的记忆里（写错归属比重复更糟）。
    const dup = store.db.prepare(`SELECT id FROM memories
      WHERE state = 'active' AND text = ? AND type = ? AND (subject IS ? OR subject = ?)
      LIMIT 1`).get(m.text, m.type, m.subject ?? null, m.subject ?? null)
    if (dup) {
      store.touchMemory([Number(dup.id)])
      out.touched += 1
      continue
    }

    // ② source_event：模型给的 src 是「第几行」，换成真实 event id（可追溯，§3.1）
    const srcIdx = Number(m.sourceLine)
    const srcEventId = Number.isInteger(srcIdx) && srcIdx > 0 && srcIdx <= includedIds.length
      ? Number(includedIds[srcIdx - 1])
      : null
    const srcRow = srcEventId !== null ? eventsById.get(srcEventId) : null
    const conv = m.conv || singleConv || srcRow?.conv || null
    const scope = conv && String(conv).startsWith('c2c:') ? 'dm_only' : 'public'

    // ③ 插入新版本（先插入：归档旧条目时 superseded_by 需要一个真实的新 id）
    const { id } = store.insertMemory({
      type: m.type,
      text: m.text,
      subject: m.subject ?? null,
      conv,
      speaker: srcRow?.speaker ?? null,
      key: m.key ?? null,
      confidence: m.confidence,
      salience: m.salience,
      state: 'active',
      validFrom: srcRow?.at ?? null,
      validUntil: m.validUntil ?? null,
      sourceEvent: srcEventId,
      scope,
      created: now,
      lastSeen: now,
    })
    out.created += 1
    out.ids.push(id)
    if (m.subject) subjects.add(String(m.subject))

    // ④ 找要取代的旧版本：**精确 key 优先**，命中不了再用同 type+subject 的
    //    文本相似度（迁移来的 sha1 key 只能靠这条路，见 findSupersedeCandidates）。
    //    排除刚插入的自己 —— 否则它和自己相似度 = 1.0，会把自己「取代」掉。
    const decision = findSupersedeTarget({
      store, key: m.key ?? null, type: m.type, subject: m.subject ?? null, text: m.text,
      excludeId: id, minScore: minSupersedeScore, limit: supersedeCandidates,
    })
    for (const target of decision.targets) {
      if (Number(target.id) === Number(id)) continue
      // 只归档 active 的（store.archiveMemory 自身也幂等：已 archived 的返回 false）
      if (!store.archiveMemory(Number(target.id), 'superseded', { supersededBy: id }).archived) continue
      out.superseded += 1
      if (decision.via === 'key') out.supersededByKey += 1
      else out.supersededBySimilarity += 1
      // 留一条可观测记录（生产验收/排查「为什么这条被合并了」）
      out.merges.push({ oldId: Number(target.id), newId: id, via: decision.via, score: target.score })
    }
  }
  out.subjects = [...subjects]
  return out
}

// ── 提炼一批 ────────────────────────────────────────────────────────────────
/**
 * 处理一批「尚未提炼」的事件：取增量 → 过滤 → 组 prompt → 调 LLM → 写 memories → 推进 watermark。
 *
 * **幂等**：重复调用同一批不会产生重复记忆（同文去重 + 同 key 取代）；
 * watermark 只有在本批记忆全部写成功后才推进，所以 crash 后重跑是安全的。
 *
 * @param {object} opts
 * @param {object} opts.store
 * @param {(prompt:string)=>Promise<string>} opts.llm  注入（测试用假 llm）
 * @param {number} [opts.now]
 * @param {number} [opts.batch=20]        一次最多喂多少条事件（文档 §3.6 的 LIMIT 节奏）
 * @param {string} [opts.tz]
 * @param {number} [opts.maxLineChars=400]
 * @param {number} [opts.maxPromptChars=8000]
 * @param {boolean} [opts.doProfiles=true] 写完后是否顺带投影 profiles
 * @returns {Promise<object>} 统计（见末尾 return）
 */
export async function distillPending ({
  store, llm = null, cfg = {}, configPath = null, now = nowSec(), batch = 20, tz = DEFAULT_TZ,
  maxLineChars = 400, maxPromptChars = 8000, doProfiles = true,
  // supersede 相似度阈值/候选数（task-21）
  minSupersedeScore = DEFAULT_SUPERSEDE_MIN_SCORE,
  supersedeCandidates = DEFAULT_SUPERSEDE_CANDIDATES,
} = {}) {
  if (!store) throw new Error('distillPending: 需要 store')
  // llm 可以注入（测试用假函数），也可以不传 —— 那就走默认的 reflection_llm 适配器。
  // 两者都没有（没 cfg 也没 llm）时**抛 unavailable** 而不是静默返回 0 条：
  // 「忘了接模型」必须是一个看得见的状态（§3.6）。
  const llmFn = typeof llm === 'function' ? llm : createAcpLlm({ cfg, configPath })
  if (typeof llmFn !== 'function') {
    throw new LlmError('unavailable', 'distillPending: 既没注入 llm() 也没有可用的默认模型适配器')
  }
  const wm = getWatermark(store)
  const rows = store.db.prepare(
    'SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT ?',
  ).all(wm, Math.max(1, Math.min(200, Number(batch) || 20)))

  if (!rows.length) {
    return { empty: true, watermark: wm, fed: 0, skipped: {}, created: 0, superseded: 0, touched: 0, profiles: [] }
  }

  const skipped = {}
  const usable = []
  for (const row of rows) {
    const v = isUsableEvent(row)
    if (!v.ok) { skipped[v.reason] = (skipped[v.reason] || 0) + 1; continue }
    usable.push(row)
  }
  const lastRowId = Number(rows[rows.length - 1].id)

  // 整批都是噪音/合并轮/占位：不调模型，但 watermark 必须推进 —— 否则这几条
  // 会被每一轮重新取出来，永远卡住后面的真消息。
  if (!usable.length) {
    writeMeta(store, META.watermark, lastRowId)
    writeMeta(store, META.lastSuccessAt, now)
    return {
      empty: false, watermark: lastRowId, batchSize: rows.length, fed: 0,
      skipped, created: 0, superseded: 0, touched: 0, deferred: 0, profiles: [], warnings: [],
    }
  }

  const { prompt, includedIds, deferredIds } = buildDistillPrompt({
    events: usable, now, tz, maxLineChars, maxPromptChars,
  })
  if (!includedIds.length) {
    // 理论上不会发生（usable 非空且至少放一行），留个防御：不推进 watermark，交给下一轮
    return {
      empty: false, watermark: wm, batchSize: rows.length, fed: 0, skipped,
      created: 0, superseded: 0, touched: 0, deferred: usable.length, profiles: [], warnings: ['prompt 预算装不下一行'],
    }
  }

  const raw = await llmFn(prompt)   // ← 抛错由 distillOnce 归类（unavailable/runtime）

  const eventsById = new Map(usable.map(r => [Number(r.id), r]))
  const includedEvents = includedIds.map(id => eventsById.get(id)).filter(Boolean)
  const convs = [...new Set(includedEvents.map(e => String(e.conv)))]
  const speakers = [...new Set(includedEvents.map(e => String(e.speaker)).filter(s => s && s !== 'self'))]

  const parsed = parseDistillOutput(raw, {
    allowedConvs: convs, speakers, tz, now,
  })
  const singleConv = convs.length === 1 ? convs[0] : null

  const ingest = ingestMemories({
    store, items: parsed.memories, eventsById, includedIds, singleConv, now,
    minSupersedeScore, supersedeCandidates,
  })

  // watermark 推进规则（§3.6：窗口不能是单向传送带）：
  //   · 有 deferred（prompt 预算装不下）→ 只推进到**最后一条真正喂进去的事件**，
  //     剩下的下一批继续（绝不能跳过）；
  //   · 没有 deferred → 这一批里每一条我们都判断过了（喂进 prompt 的 + 被跳过
  //     的噪音/合并轮/占位），可以直接推到本批最后一条 —— 否则那些被跳过的尾巴
  //     会在下一轮再取出来、再判一遍（虽然无害，但每轮都要多查一次、日志也乱）。
  const nextWatermark = deferredIds.length ? Math.max(...includedIds) : lastRowId
  writeMeta(store, META.watermark, nextWatermark)
  writeMeta(store, META.lastSuccessAt, now)
  clearMeta(store, META.lastError)
  clearMeta(store, META.lastErrorKind)
  clearMeta(store, META.lastUnavailable)
  clearMeta(store, META.retryAfterAt)
  // 连续错误计数也要清零：否则「昨天失败过 3 次」会一直挂在状态页上，
  // 用户会以为现在还在坏（这正是 v4「绿着坏」的反面 —— 也不能「红着好」）。
  clearMeta(store, 'distill:consecutive_errors')
  clearMeta(store, 'distill:last_error_at')

  const profiles = doProfiles ? projectProfiles({ store, subjects: ingest.subjects, now }) : []

  return {
    empty: false,
    watermark: nextWatermark,
    batchSize: rows.length,
    fed: includedIds.length,
    skipped,
    deferred: deferredIds.length,
    created: ingest.created,
    superseded: ingest.superseded,
    supersededByKey: ingest.supersededByKey,
    supersededBySimilarity: ingest.supersededBySimilarity,
    merges: ingest.merges,
    touched: ingest.touched,
    ids: ingest.ids,
    subjects: ingest.subjects,
    profiles,
    dropped: parsed.dropped,
    warnings: parsed.warnings,
  }
}

// ── 作业驱动 ────────────────────────────────────────────────────────────────
/** LLM 不可用时，多久之后允许再试（秒）。默认 30 分钟：没配模型时不该每分钟烧一次日志。 */
export const UNAVAILABLE_RETRY_SEC = 30 * 60

/**
 * 有积压 && 没有在跑的提炼作业 → 入队一个（供调度器每轮调用，幂等）。
 * @returns {{enqueued:boolean, id?:number, reason:string}}
 */
export function ensureDistillJob ({ store, now = nowSec(), batch = 20 } = {}) {
  if (!store) throw new Error('ensureDistillJob: 需要 store')
  const backlog = distillBacklog({ store })
  if (!backlog.hasBacklog) return { enqueued: false, reason: '没有待提炼的新事件' }

  const retryAfter = Number(readMeta(store, META.retryAfterAt) ?? 0)
  if (Number.isFinite(retryAfter) && retryAfter > now) {
    return { enqueued: false, reason: `LLM 不可用，${Math.ceil(retryAfter - now)} 秒后再试` }
  }
  const running = store.db.prepare(
    "SELECT id FROM jobs WHERE kind = 'distill' AND state IN ('pending', 'running') LIMIT 1",
  ).get()
  if (running) return { enqueued: false, reason: '已有待跑/在跑的提炼作业' }

  const { id } = store.enqueueJob({
    kind: 'distill',
    payload: { batch, watermark: backlog.watermark },
    nextAt: now,
  })
  return { enqueued: true, id, reason: `积压 ${backlog.pending} 条` }
}

/**
 * 调度器调用的一步：可选入队 → 认领 → 提炼 → finishJob。
 *
 * 失败处理（§3.6，两条路必须分开）：
 *   · unavailable（没配模型）→ finishJob(ok:true) **但不算成功**：不累计 attempts、
 *     不进死信；同时把 last_unavailable + retry_after 写进 v5_meta，让设置页看得见。
 *     为什么用 ok:true：store 的 finishJob 在 ok:false 时一定会 attempts++（认领时
 *     已经 +1），把「没配模型」累计成 3 次死信是把环境问题当成代码 bug。
 *   · runtime（超时/报错/输出坏）→ finishJob(ok:false, errorKind='runtime')，
 *     走 60s→120s 退避，第 3 次进 dead。
 *
 * @returns {Promise<{enqueued:object|null, claimed:number, results:Array, status:object}>}
 */
export async function distillOnce ({
  store, llm = null, cfg = {}, configPath = null, now = nowSec(), batch = 20, maxJobs = 1,
  autoEnqueue = true, tz = DEFAULT_TZ, log = () => {},
} = {}) {
  if (!store) throw new Error('distillOnce: 需要 store')
  // 没注入 llm 就用默认适配器（reflection_llm.mjs，和 v4 同一套调用方式）。
  // 调度器接入 = `distillOnce({ store, cfg })` 一行。
  const llmFn = typeof llm === 'function' ? llm : createAcpLlm({ cfg, configPath })
  const enqueued = autoEnqueue ? ensureDistillJob({ store, now, batch }) : null
  const jobs = store.claimDueJobs({ now, limit: Math.max(1, Math.min(10, Number(maxJobs) || 1)), kinds: ['distill'] })
  const results = []

  for (const job of jobs) {
    const jobBatch = Number(job.payload?.batch) || batch
    try {
      const r = await distillPending({ store, llm: llmFn, now, batch: jobBatch, tz })
      store.finishJob(job.id, { ok: true, now })
      results.push({ jobId: job.id, ok: true, ...r })
      log(`v5 distill: 作业 ${job.id} 完成 · 喂 ${r.fed} 条 → 新建 ${r.created} / 取代 ${r.superseded}`
        + (r.deferred ? ` / 顺延 ${r.deferred}` : ''))
    } catch (err) {
      const kind = errorKindOf(err)
      const msg = String(err?.message ?? err).slice(0, 500)
      if (kind === 'unavailable') {
        // 跳过且不算失败（见函数注释），但必须留痕
        store.finishJob(job.id, { ok: true, now })
        writeMeta(store, META.lastUnavailable, { at: now, reason: msg })
        writeMeta(store, META.retryAfterAt, Math.floor(now + UNAVAILABLE_RETRY_SEC))
        writeMeta(store, META.lastError, msg)
        writeMeta(store, META.lastErrorKind, 'unavailable')
        results.push({ jobId: job.id, ok: false, skipped: true, errorKind: 'unavailable', error: msg })
        log(`v5 distill: 作业 ${job.id} 跳过（模型不可用：${msg.slice(0, 160)}）—— ${Math.round(UNAVAILABLE_RETRY_SEC / 60)} 分钟后再试`)
      } else {
        const fin = store.finishJob(job.id, { ok: false, error: msg, errorKind: 'runtime', now })
        writeMeta(store, META.lastError, msg)
        writeMeta(store, META.lastErrorKind, 'runtime')
        setMetaErrorCount(store, now)
        results.push({
          jobId: job.id, ok: false, skipped: false, errorKind: 'runtime', error: msg,
          jobState: fin.state, dead: fin.dead, attempts: fin.attempts, nextAt: fin.nextAt,
        })
        log(`v5 distill: 作业 ${job.id} 失败（runtime: ${msg.slice(0, 160)}）`
          + (fin.dead ? ' → 已进死信，等人工处理' : ` → 第 ${fin.attempts} 次，退避后重试`))
      }
    }
  }

  return {
    enqueued,
    claimed: jobs.length,
    results,
    status: distillStatus({ store }),
  }
}

function setMetaErrorCount (store, now) {
  const prev = Number(readMeta(store, 'distill:consecutive_errors') ?? 0) || 0
  writeMeta(store, 'distill:consecutive_errors', prev + 1)
  writeMeta(store, 'distill:last_error_at', now)
}

/**
 * 提炼状态快照（设置页「记忆」页 / 调度器日志用）。
 * 字段和 scheduler.status() 的风格一致：既给「现在积压多少」，也给「最近一次
 * 为什么失败」—— §3.6 明确要求设置页显示「最近错误」，而不是一行自相矛盾的
 * 「成功（⚠ LLM 不可用…）」。
 */
export function distillStatus ({ store } = {}) {
  if (!store) throw new Error('distillStatus: 需要 store')
  const backlog = distillBacklog({ store })
  return {
    ...backlog,
    lastSuccessAt: Number(readMeta(store, META.lastSuccessAt) ?? 0) || null,
    lastError: readMeta(store, META.lastError) || null,
    lastErrorKind: readMeta(store, META.lastErrorKind) || null,
    lastErrorAt: Number(readMeta(store, 'distill:last_error_at') ?? 0) || null,
    lastUnavailable: readMeta(store, META.lastUnavailable) || null,
    retryAfterAt: Number(readMeta(store, META.retryAfterAt) ?? 0) || null,
    consecutiveErrors: Number(readMeta(store, 'distill:consecutive_errors') ?? 0) || 0,
    jobs: store.jobStats(),
  }
}

// 便于测试/其它模块复用的重导出
export { canonicalEventText, isUsableEvent, buildDistillPrompt, parseDistillOutput, nowSec }
