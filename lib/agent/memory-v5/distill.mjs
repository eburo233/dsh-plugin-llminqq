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
import { nowSec } from './store.mjs'
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
export function ingestMemories ({ store, items = [], eventsById = new Map(), includedIds = [], singleConv = null, now = nowSec() } = {}) {
  const out = { created: 0, superseded: 0, touched: 0, ids: [], subjects: [] }
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

    // ③ 同 key 的旧版本 → 插入新版本后把旧的归档成 superseded
    const oldOnes = m.key ? store.findActiveByKey({ type: m.type, subject: m.subject, key: m.key }) : []
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
    for (const old of oldOnes) {
      if (Number(old.id) === Number(id)) continue
      if (store.archiveMemory(Number(old.id), 'superseded', { supersededBy: id }).archived) out.superseded += 1
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
