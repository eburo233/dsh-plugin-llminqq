// OneBot 11 ↔ DSH(LLM) 桥接守护进程。
//
// 职责：
//   入站  QQ 消息（私聊/群聊 @）→ 拍平文本 + 下载图片 → 喂给 DSH 持久会话
//   出站  DSH 助手文本 → 发回 QQ；[SEND_FILE: path] → 上传真图发到 QQ
//
// 不做的事：不改现有项目、不碰 dsh-bridge 插件、不用官方 Bot API。

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { OneBotGateway } from './onebot.js'
import { createSecurity } from './security.js'
import { createPersona } from './persona.js'
import { createState } from './state.js'
import { createMessaging } from './messaging.js'
import { enrichCardUrls } from './carddetail.js'
// 纯函数/常量（标记正则、拆句、段转换）—— 2026-10-29 拆出，多个模块共用。
import {
  SEND_FILE_RE, AT_RE, POKE_RE, FOLLOW_RE, VOICE_RE,
  chunkText, textToSegments,
} from './common.js'
import { DshRuntime } from './dsh.js'
import { AcpRuntime } from './acp.js'
import { loadConfig } from './config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const cfgPath = process.env.LLMINQQ_CONFIG ?? path.join(__dirname, 'config.json')
// 配置加载走 bridge/config.js：占位符展开 + 相对路径规范化。
// config.json 是**模板**（只有 `${LLMINQQ_ROOT}/...` 这类占位符，没有本机绝对路径），
// 所以不能在这一行直接 JSON.parse —— 换个人 clone 到别的目录就会全线指错地方。
const { config, vars: ENV } = loadConfig({
  root: ROOT,
  configPath: cfgPath,
  warn: m => process.stderr.write(`[config] ${m}\n`),
})

// 安全模块（URL 守卫 + 不可信文本净化）—— 2026-10-29 从本文件拆出。
// 解构回原来的名字，所以下面的代码一行都不用改。
const security = createSecurity({ config, root: ROOT })
const {
  SENSITIVE, STAGING_DIR, MAX_FILE, URL_SAFE,
  checkUrlSafe, safeFetchBuffer, SYS_MARKERS,
  sanitizeUntrustedText, downloadUrlToStaging,
} = security

// ── 日志 ─────────────────────────────────────────────────────────────────────
const logFile = config.log?.file ?? path.join(ROOT, 'logs', 'bridge.log')
fs.mkdirSync(path.dirname(logFile), { recursive: true })

// ── 启动时先做一次日志轮转 ────────────────────────────────────────────────────
//
// 🔴 2026-11-01：`bridge.log` 涨到 **35GB** 把整块磁盘写满（115G 分区 0 可用），
//    根因是 EPIPE 自激死循环（见下面 writeStdout 的注释）。
//    但「一条坏日志能长到 35GB」这件事本身也是疏漏 —— 这个文件**从来没被轮转过**：
//    宿主侧只给 `bridge.out` 做了 8MB 轮转，桥自己写的 `bridge.log` 一直 append。
//
//    这里在打开文件前先滚一次；运行期再靠 size 检查（见 log() 里的 LOG_MAX_BYTES）。
const LOG_MAX_BYTES = 16 * 1024 * 1024   // 16MB：够排查，又不会被刷爆
const LOG_KEEP_FILES = 2                 // 保留 bridge.log.1 / .2
function rotateLogIfNeeded () {
  try {
    if (!fs.existsSync(logFile)) return false
    const size = fs.statSync(logFile).size
    if (size <= LOG_MAX_BYTES) return false
    // 从最老的往新滚：.2 删掉、.1→.2、当前→.1
    for (let i = LOG_KEEP_FILES; i >= 1; i--) {
      const from = i === 1 ? logFile : `${logFile}.${i - 1}`
      const to = `${logFile}.${i}`
      if (!fs.existsSync(from)) continue
      try { if (fs.existsSync(to)) fs.unlinkSync(to) } catch { /* ignore */ }
      try { fs.renameSync(from, to) } catch { /* ignore */ }
    }
    return true
  } catch {
    return false
  }
}

rotateLogIfNeeded()

// ⚠️ logStreamBroken 必须在 createLogStream 之前声明：
//    createLogStream 的 error 监听里会读它，声明在后面就是 TDZ（ReferenceError）。
let logStreamBroken = false

/**
 * 打开日志文件流（带 error 监听）。
 *
 * 为什么要挂 error 监听：Windows 上被占用/杀软锁文件时 createWriteStream 会 emit 'error'，
 * 没有监听就是 uncaughtException → 整个桥静默退出（用户侧表现为「机器人突然不说话」）。
 */
function createLogStream () {
  const st = fs.createWriteStream(logFile, { flags: 'a' })
  st.on('error', err => {
    if (logStreamBroken) return
    logStreamBroken = true
    try { process.stderr.write(`[bridge] 日志文件不可写（后续只走 stderr）: ${err.message}\n`) } catch { /* ignore */ }
  })
  return st
}

// 用 let 而不是 const：运行期轮转后要重新打开文件（见 maybeRotateRuntime）
let logStream = createLogStream()
function reloadLogStream () {
  logStreamBroken = false
  logStream = createLogStream()
}
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }
const minLevel = LEVELS[config.log?.level ?? 'info'] ?? 20

/** 从「WARN xxx」「debug xxx」这类前缀里取级别。之前只判 debug，WARN/ERROR 全被当 info，
 *  log.level=warn 时 WARN 反而被吞掉。 */
function levelOf(msg) {
  if (msg.startsWith('debug ')) return 'debug'
  if (msg.startsWith('WARN ')) return 'warn'
  if (msg.startsWith('ERROR ')) return 'error'
  return 'info'
}

// ── stdout 熔断 ───────────────────────────────────────────────────────────────
//
// 🔴 2026-11-01 真实事故：**bridge.log 几小时涨到 35GB，把整块磁盘写满**
//    （根分区 115G / 110G used / 0 available，连 dsh 自己都起不来）。
//
// 根因是一个**自激死循环**：
//   ① 宿主（或谁）关掉了桥的 stdout 管道 → `console.log` 抛 `EPIPE`
//   ② 这个异常变成 `uncaughtException` → `crashGuard()` 记录一条 ERROR
//   ③ crashGuard 里又调 `logger.log` → 又 `console.log` → stdout **仍是断的** → 再抛 EPIPE
//   ④ 回到 ②，**无限循环**，每圈写一行带完整堆栈的 ERROR
//
// 日志里 `未捕获异常（第 50130295 次，桥继续运行）: Error: write EPIPE` ——
// **五千万次**。一行堆栈约 700 字节，5000 万行 ≈ 35GB。CPU 也一起被打满。
//
// 修法（三层，缺一层都还能转起来）：
//   ① `console.log` 必须裹 try/catch —— 它是最外层，任何 IO 失败都不能变成异常源
//   ② stdout 一旦 EPIPE 就**永久停写**（熔断），别再试 —— 管道断了不会自己好
//   ③ crashGuard 防递归：正在处理异常时不能再触发自己（`inGuard` 标志）
//
// 为什么不是「catch 了就静默」：熔断时会往 stderr 写一次说明，并把计数带进状态，
// 排查时能看出「stdout 断了、停写了 N 次」。
let stdoutBroken = false
let stdoutSkipCount = 0
/** 停写后合计丢弃了多少行（防止无声无息地丢日志）。 */
function writeStdout (line) {
  if (stdoutBroken) { stdoutSkipCount++; return }
  try {
    console.log(line)
  } catch (err) {
    // EPIPE / ERR_STREAM_DESTROYED / EBADF 都意味着「stdout 没了」，不会再恢复
    stdoutBroken = true
    try {
      process.stderr.write(
        `[bridge] stdout 已断开（${err?.code || err?.message}），后续日志只写文件。` +
        '这通常是宿主关闭了管道；继续尝试写会变成 EPIPE 死循环（曾经写满 35GB 磁盘）。\n',
      )
    } catch { /* stderr 也断就算了 */ }
  }
}

/** 已写多少字节（运行期体积检查用，避免每次 stat）。 */
let logBytesWritten = 0
/** 写满一个阈值再复查一次文件实际大小（既不每次都 stat，又能及时轮转）。 */
const LOG_CHECK_EVERY = 4 * 1024 * 1024

/**
 * 运行期体积检查 —— 涨到 LOG_MAX_BYTES 就重新开一个新文件。
 *
 * 为什么需要（不只是启动时轮转一次）：桥是**长驻进程**，可能连跑几天。
 * 35GB 那次事故里就没有任何运行期保护，只能等磁盘写满。
 * 这里用「累计写入字节数」当水位，写满 4MB 才 stat 一次 —— 不做无谓的 IO。
 */
function maybeRotateRuntime () {
  if (logBytesWritten < LOG_CHECK_EVERY) return
  logBytesWritten = 0
  try {
    const size = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0
    if (size < LOG_MAX_BYTES) return
    // 换文件：旧流先关掉，滚一次，再用 append 重新打开
    try { logStream.end() } catch { /* ignore */ }
    rotateLogIfNeeded()
    try {
      // createWriteStream 关掉后不能复用，直接重新赋值（logger 是闭包引用，所以用 let）
      reloadLogStream()
    } catch { /* ignore */ }
    process.stderr.write(`[bridge] 日志超过 ${Math.round(LOG_MAX_BYTES / 1024 / 1024)}MB，已轮转到 ${logFile}.1\n`)
  } catch { /* 轮转失败不影响日志继续写 */ }
}

function log(msg, meta) {
  const line = `${new Date().toISOString()} ${msg}${meta ? ' ' + JSON.stringify(meta) : ''}`
  if ((LEVELS[levelOf(msg)] ?? 20) >= minLevel) {
    writeStdout(line)
  }
  if (!logStreamBroken) {
    try {
      logStream.write(line + '\n')
      logBytesWritten += Buffer.byteLength(line) + 1
      maybeRotateRuntime()
    } catch { logStreamBroken = true }
  }
}
const logger = { log, info: log, debug: m => log(`debug ${m}`), warn: m => log(`WARN ${m}`), error: m => log(`ERROR ${m}`) }

// ── 进程级兜底 ──────────────────────────────────────────────────────────────
// 桥是长驻子进程：一个没人接的 promise 拒绝 / 一次未捕获异常，默认就让 Node 直接退出，
// 用户侧表现是「机器人突然不说话了」，而且宿主那边只会看到 exit code（见 lib/index.js 的
// exit 监听）。以前桥一崩就得手动重启 DSH。这里统一兜住：带 stack 记一条 ERROR，进程继续跑。
// 不是「吞错误」——每条都落 bridge.log，且计数（crashGuardCount）便于判断是否该重启。
//
// ⚠️ 但这个兜底**自己也能成为异常源**（2026-11-01 EPIPE 事故）：
//    guard 里写日志 → 写 stdout 抛 EPIPE → 再次 uncaughtException → 又进 guard ……
//    所以必须：
//    ① `inGuard` 防重入 —— 处理异常期间再来的异常只计数，不再写日志
//    ② 同一个错误短时间内反复出现要**限流**，避免任何未知原因把磁盘刷爆
let crashGuardCount = 0
let inGuard = false
/** 同一类错误在这段时间内最多写几条（超过就只计数，不再写日志）。 */
const GUARD_DEDUP_MS = 60 * 1000
const GUARD_DEDUP_MAX = 20
const guardRecent = new Map() // key -> { at, count }
function crashGuard(kind, err) {
  crashGuardCount++
  // ① 防重入：已经在处理异常里，又抛了一个 → 只计数，绝不写日志（否则就是死循环）
  if (inGuard) return
  inGuard = true
  try {
    // ② 限流：同一种错误（按 kind + 首行）每分钟最多写 20 条
    const key = `${kind}|${String(err?.code || err?.message || err).slice(0, 80)}`
    const now = Date.now()
    const rec = guardRecent.get(key)
    if (rec && now - rec.at < GUARD_DEDUP_MS) {
      rec.count++
      if (rec.count > GUARD_DEDUP_MAX) {
        // 超了就静默计数（调用方可以从 crashGuardCount 看出异常频率）
        return
      }
    } else {
      guardRecent.set(key, { at: now, count: 1 })
    }
    logger.log(`ERROR ${kind}（第 ${crashGuardCount} 次，桥继续运行）: ${err?.stack ?? err?.message ?? String(err)}`)
  } finally {
    inGuard = false
  }
}
process.on('unhandledRejection', err => crashGuard('未处理的 Promise 拒绝', err))
process.on('uncaughtException', err => crashGuard('未捕获异常', err))

/** 给 /health、设置页用的日志健康快照（看 stdout 有没有断、丢了多少行）。 */
function logHealth () {
  return {
    stdoutBroken,
    stdoutSkipCount,
    logStreamBroken,
    crashGuardCount,
    file: logFile,
  }
}

/** 本进程起的定时器（shutdown 时要清掉，否则关闭途中还会排新任务）。 */
const timers = new Set()


// ── 人设文件 ────────────────────────────────────────────────────────────────
// 人设与工程约定分离：persona/persona.md 是「你是谁」，有性格；AGENTS.md 是「通道怎么用」，无性格。
//
// 注入策略（重要，直接决定上下文消耗速度）：
//   人设全文**只在「开始新对话」或「人设文件变了」时注入一次**，之后每轮只给一句
//   「人设未变化，见文件路径」。原因：把人设 7.2 KB 每轮都塞进 user message，
//   它会作为**普通对话历史**留存并被后续每一轮重复计费（≈3600 tokens/轮），
//   几百轮就把 1M 上下文吃掉，还会让 compaction 频繁触发。
//   文件一改（agent 自改人设后），下一轮自动重新注入一次全文，改动依然即时生效。
const PERSONA_PATH = path.resolve(
  config.persona?.path ?? path.join(config.dsh.cwd, 'persona', 'persona.md'),
)
const PERSONA_MAX_BYTES = config.persona?.maxBytes ?? 32768

// 性格模块（OCEAN + 39 原型）—— 2026-10-29 从本文件拆出。
// 解构回原名，下面的代码一行不用改。
const personaMod = createPersona({ personaPath: PERSONA_PATH })
const { OCEAN_DEFAULTS, deriveTraits, PERSONA_ARCHETYPES, readPersonaArchetype } = personaMod

/** 读取人设文件；超过预算则从尾部截断并明确告知。失败返回 null。 */
function readPersona() {
  try {
    const st = fs.statSync(PERSONA_PATH)
    if (!st.isFile()) return { text: null, hash: null }
    let raw = fs.readFileSync(PERSONA_PATH, 'utf8')
    const hash = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16)
    if (Buffer.byteLength(raw) > PERSONA_MAX_BYTES) {
      raw = raw.slice(0, PERSONA_MAX_BYTES)
      const cut = raw.lastIndexOf('\n')
      if (cut > 0) raw = raw.slice(0, cut)
      raw += '\n\n<!-- 注：本文件超过桥的注入预算，后续内容未加载 -->'
      logger.log(`WARN 人设文件超过 ${PERSONA_MAX_BYTES} 字节，已截断注入`)
    }
    return { text: raw.trim() || null, hash }
  } catch (err) {
    if (err.code !== 'ENOENT') logger.log(`WARN 读取人设文件失败: ${err.message}`)
    return { text: null, hash: null }
  }
}

/** 出站文件是否允许发送：必须在 staging 或 cwd 内，且不含敏感段。 */
function isPathAllowedForSend(p) {
  if (!config.media?.enabled) return false
  const abs = path.resolve(p)
  let real
  try { real = fs.realpathSync(abs) } catch { return false }
  const allowedRoots = [STAGING_DIR, config.dsh.cwd].map(r => { try { return fs.realpathSync(r) } catch { return path.resolve(r) } })
  const inside = allowedRoots.some(root => real === root || real.startsWith(root + path.sep))
  if (!inside) return { ok: false, reason: `path outside allowed roots: ${real}` }
  const segs = real.split(path.sep).map(s => s.toLowerCase())
  for (const s of SENSITIVE) {
    if (segs.some(seg => seg === s || seg.includes(s))) return { ok: false, reason: `sensitive path segment: ${s}` }
  }
  try {
    const st = fs.statSync(real)
    if (!st.isFile()) return { ok: false, reason: 'not a regular file' }
    if (st.size > MAX_FILE) return { ok: false, reason: `file too large: ${st.size}` }
  } catch (e) { return { ok: false, reason: e.message } }
  return { ok: true, path: real }
}

// ── SEND_FILE 指令解析 ──────────────────────────────────────────────────────

// ── 撤回（[RECALL]）：撤回自己发过的消息 ────────────────────────────────────
// 语法（标记会被从正文里剥掉，对方看不到）：
//   [RECALL:last]  或  [RECALL:1]   撤回我最近发的那一条（两者等价）
//   [RECALL:2]                      撤回倒数第 2 条
//   [RECALL:n]                      倒序 1-based；桥只记最近 10 条，n 最大 10
// 语义：撤回发生在**本条消息发出之前**——所以写得对是「先撤掉说错的那条，再补一句」。
//
// 两个硬限制（协议事实，不是我们加的）：
//   · QQ 撤回自己的消息有时限（普通成员约 2 分钟）。超时撤不掉，**必须明确报失败**，
//     不能让模型以为撤了（对方其实还看得见）。
//   · 每个 peer 每分钟最多撤 2 条（防它一气之下连撤刷屏）。
// OneBot 11 动作：delete_msg({ message_id })
const RECALL_RE = /\[RECALL:\s*(last|\d{1,2})\s*\]/gi
const RECALL_HISTORY_MAX = config.recall?.historyMax ?? 10
const RECALL_TTL_MS = config.recall?.ttlMs ?? 120000
const RECALL_RATE_MAX = config.recall?.maxPerMinute ?? 2
const RECALL_RATE_WINDOW_MS = 60 * 1000
const RECALL_NOTE_MAX = 3

/** peerKey -> [{ message_id, ts, kind }]，只留最近 RECALL_HISTORY_MAX 条 */
const sentMessages = new Map()
/** peerKey -> [撤回尝试时间戳]（滑动窗口限频） */
const recallAttempts = new Map()
/** peerKey -> [撤回结果文案]，留给下一轮告诉模型（最多 RECALL_NOTE_MAX 条） */
const recallNotes = new Map()

function recallKeyOf(peer) {
  return `${peer.scope}:${peer.id}`
}

/**
 * 发消息成功后调用：记住回来的 message_id，供之后的 [RECALL] 用。
 * 只留最近 N 条（QQ 撤回时限才 2 分钟，留太多没意义还占内存）。
 */
function noteSentMessage(peer, res, kind = 'text') {
  const raw = res?.message_id ?? res?.messageId ?? res?.msg_id
  if (raw == null || raw === '') return
  const key = recallKeyOf(peer)
  const list = sentMessages.get(key) ?? []
  list.push({ message_id: String(raw), ts: Date.now(), kind })
  while (list.length > RECALL_HISTORY_MAX) list.shift()
  sentMessages.set(key, list)
}

/**
 * 抽出文本里的 [RECALL:…]，返回倒序 1-based 序号（1 = 最近一条）+ 剥掉标记的正文。
 * 同一轮里重复的序号去重；一轮最多真的撤 RECALL_RATE_MAX 条（多写的丢弃并让调用方记日志）。
 */
function extractRecalls(text) {
  const all = []
  const stripped = String(text ?? '').replace(RECALL_RE, (_all, spec) => {
    const v = String(spec).toLowerCase()
    const idx = v === 'last' ? 1 : Number(v)
    if (Number.isInteger(idx) && idx >= 1 && idx <= RECALL_HISTORY_MAX && !all.includes(idx)) all.push(idx)
    return ''
  }).trim()
  return { specs: all.slice(0, RECALL_RATE_MAX), dropped: Math.max(0, all.length - RECALL_RATE_MAX), text: stripped }
}

function recallDescribeIndex(idx) {
  return idx === 1 ? '最近一条' : `倒数第 ${idx} 条`
}

/** 撤回结果写进文件（qq-agent/.bridge/recall.log）：模型下一轮可以 read 它确认到底撤没撤。 */
function recallStatusPath() {
  const rc = config.recall ?? {}
  if (rc.statusFile === false) return null
  return rc.statusFile ?? path.join(config.dsh.cwd, '.bridge', 'recall.log')
}

function appendRecallStatus(line) {
  const p = recallStatusPath()
  if (!p) return
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.appendFileSync(p, `${new Date().toISOString()} ${line}\n`)
  } catch { /* 记不下来不影响撤回本身 */ }
}

/** 滑动窗口限频：同一 peer 每分钟最多 RECALL_RATE_MAX 次。 */
function recallRateCheck(key, now = Date.now()) {
  const arr = (recallAttempts.get(key) ?? []).filter(t => now - t < RECALL_RATE_WINDOW_MS)
  if (arr.length >= RECALL_RATE_MAX) {
    recallAttempts.set(key, arr)
    return { ok: false, retryAfterMs: RECALL_RATE_WINDOW_MS - (now - arr[0]) }
  }
  arr.push(now)
  recallAttempts.set(key, arr)
  return { ok: true }
}

/** 统一的收尾：日志 + 状态文件 + 下一轮反馈队列。 */
function finishRecall(peer, ok, index, detail) {
  const key = recallKeyOf(peer)
  const line = ok
    ? `[RECALL] 成功 ${key} ${recallDescribeIndex(index)}：${detail}`
    : `[RECALL] 失败 ${key} ${recallDescribeIndex(index)}：${detail}`
  logger.log(line)
  appendRecallStatus(line)
  const notes = recallNotes.get(key) ?? []
  notes.push(ok ? `✅ ${recallDescribeIndex(index)}：${detail}` : `❌ ${recallDescribeIndex(index)}：${detail}`)
  while (notes.length > RECALL_NOTE_MAX) notes.shift()
  recallNotes.set(key, notes)
  return { ok, index, detail }
}

/**
 * 执行一次撤回。
 * @param {{id:string,scope:'group'|'c2c'}} peer
 * @param {number} index 倒序 1-based（1 = 最近一条）
 */
async function performRecall(peer, index) {
  const key = recallKeyOf(peer)
  const idx = Number(index)
  if (!Number.isInteger(idx) || idx < 1) return finishRecall(peer, false, index, '序号无效')
  const list = sentMessages.get(key) ?? []
  const target = list[list.length - idx]
  if (!target) {
    return finishRecall(peer, false, idx,
      `没有${recallDescribeIndex(idx)}可撤（我最多记得最近 ${RECALL_HISTORY_MAX} 条，可能还没发过这么多）`)
  }
  const ageMs = Date.now() - target.ts
  if (RECALL_TTL_MS > 0 && ageMs > RECALL_TTL_MS) {
    return finishRecall(peer, false, idx,
      `超过 QQ 撤回时限：这条已发出 ${Math.round(ageMs / 1000)} 秒（上限 ${Math.round(RECALL_TTL_MS / 1000)} 秒），` +
      '撤不掉了，对方已经看到')
  }
  const rate = recallRateCheck(key)
  if (!rate.ok) {
    return finishRecall(peer, false, idx,
      `撤回太频繁：同一会话每分钟最多 ${RECALL_RATE_MAX} 条，还要等 ${Math.ceil(rate.retryAfterMs / 1000)} 秒`)
  }
  const mid = target.message_id
  try {
    await gateway.callData('delete_msg', { message_id: /^\d+$/.test(mid) ? Number(mid) : mid }, 10000)
  } catch (err) {
    return finishRecall(peer, false, idx, `delete_msg 失败：${String(err?.message ?? err).slice(0, 140)}`)
  }
  // 撤成功了才从历史里删掉，避免误把别的条目当成已撤
  list.splice(list.length - idx, 1)
  sentMessages.set(key, list)
  return finishRecall(peer, true, idx, `message_id=${mid}`)
}

/**
 * [RECALL] 的 prompt 片段：能力说明（很短，每轮都有）+ 上一轮撤回结果（有才给）。
 * 单独作为一个 block 追加在上下文块之后，不混进 contextLines 拼装段。
 */
function recallPromptBlock(peerKey) {
  const lines = []
  const notice = recallNoticeFor(peerKey)
  if (notice) lines.push(notice, '')
  lines.push(
    '【你能撤回自己发的消息】写 `[RECALL:last]`（=撤回最近一条）或 `[RECALL:2]`（=倒数第 2 条，最多 10）。',
    '撤回在你这条发出**之前**执行，标记会从正文剥掉。QQ 时限约 2 分钟、每分钟最多撤 2 条。',
    '没发出标记就不要说「我撤回了」——上一轮的撤回结果会出现在这里。',
  )
  return { type: 'text', text: lines.join('\n') }
}

/**
 * 取出（并清空）上一个 peer 的撤回结果，供下一轮 prompt 注入。
 * 由 prompt 拼装处调用；没有结果返回 null。
 */
function recallNoticeFor(peerKey) {
  const notes = recallNotes.get(peerKey)
  if (!notes?.length) return null
  recallNotes.delete(peerKey)
  return ['【撤回结果】上一轮你用了 [RECALL] 标记，结果如下（别说反了）：', ...notes].join('\n')
}

// ── 媒体暂存（入站图片）─────────────────────────────────────────────────────
function extFor(contentType) {
  if (!contentType) return '.jpg'
  if (contentType.includes('png')) return '.png'
  if (contentType.includes('webp')) return '.webp'
  if (contentType.includes('gif')) return '.gif'
  if (contentType.includes('jpeg') || contentType.includes('jpg')) return '.jpg'
  return '.bin'
}

// 把暂存好的图片做成 ACP 内容块（{type:'image', data:base64, mimeType}）——
// 这样模型是**直接看图**，不用先被叫去 read_image（很多 acp 会话里没这个工具，
// 或者模型不敢调用）。太大就不内联，退回「给路径」的老办法。
const MAX_INLINE_IMAGE = 4 * 1024 * 1024

function imageBlockForPath (p) {
  try {
    const st = fs.statSync(p)
    if (st.size > MAX_INLINE_IMAGE) return null
    const data = fs.readFileSync(p).toString('base64')
    const mimeType = /\.png$/i.test(p) ? 'image/png'
      : /\.webp$/i.test(p) ? 'image/webp'
        : /\.gif$/i.test(p) ? 'image/gif'
          : 'image/jpeg'
    return { type: 'image', data, mimeType }
  } catch {
    return null
  }
}


// ── OneBot 消息段处理 ───────────────────────────────────────────────────────
// 记录机器人自己发出的消息 id，用于识别「别人回复了我」也算被 @
const selfMessageIds = new Set()

/**
 * 发消息成功后统一记账：① 自己发的 id（识别「回复我」）② 撤回历史（[RECALL] 用）。
 * 所有出站发送都必须走这里，否则模型撤到的是不存在的 id。
 */
function noteSelfSent(peer, res, kind = 'text') {
  const raw = res?.message_id ?? res?.messageId ?? res?.msg_id
  if (raw != null && raw !== '') {
    selfMessageIds.add(String(raw))
    if (selfMessageIds.size > 500) selfMessageIds.delete(selfMessageIds.values().next().value)
  }
  noteSentMessage(peer, res, kind)
}

function flattenMessage(message) {
  if (typeof message === 'string') return { text: message.trim(), images: [], replyId: null, atMe: false, replyToMe: false, atList: [], forwardIds: [] }
  if (!Array.isArray(message)) return { text: '', images: [], replyId: null, atMe: false, replyToMe: false, atList: [], forwardIds: [] }
  const texts = []
  const images = []
  const atList = [] // 本条消息 @ 了哪些 QQ 号（含别人，供模型理解对话对象）
  const forwardIds = [] // 合并转发的 forward_id
  const cards = [] // 解析出来的卡片文本（便于日志/上下文单独提示）
  const segTypes = [] // 本条消息出现了哪些段类型（诊断用：卡片没解析出来时能看出是哪一段）
  let replyId = null
  let atMe = false
  for (const seg of message) {
    if (!seg || typeof seg !== 'object') continue
    const d = seg.data ?? {}
    if (seg.type) segTypes.push(String(seg.type))
    if (seg.type === 'text') texts.push(String(d.text ?? ''))
    else if (seg.type === 'image') images.push(d)
    else if (seg.type === 'reply') {
      replyId = String(d.id ?? '')
    } else if (seg.type === 'forward') {
      // 合并转发：data.id 是 forward_id（NapCat/LLOneBot），也可能叫 res_id
      const fid = d.id || d.res_id || d.forward_id
      if (fid) forwardIds.push(String(fid))
    } else if (seg.type === 'json') {
      // 卡片（小程序/分享/音乐/图文）：尽量挖出可读文字，别再丢成空消息
      const cardText = cardJsonToText(seg)
      texts.push(cardText)
      cards.push(cardText)
    } else if (seg.type === 'xml') {
      const cardText = xmlToText(d.data ?? d)
      texts.push(cardText)
      cards.push(cardText)
    } else if (seg.type === 'at') {
      const qq = String(d.qq ?? '')
      if (qq && qq !== 'all') atList.push(qq)
      if (qq === String(gateway.selfId)) atMe = true
    } else if (seg.type === 'face') texts.push('')
  }
  // reply 引用的如果是机器人自己发的消息，等价于在跟我说话
  const replyToMe = !!replyId && selfMessageIds.has(replyId)
  return { text: texts.join('').trim(), images, replyId, atMe, replyToMe, atList, forwardIds, cards, segTypes }
}

// ── 平台状态 ────────────────────────────────────────────────────────────────
const gateway = new OneBotGateway({
  wsUrl: config.onebot.wsUrl,
  token: config.onebot.token,
  reconnectMs: config.onebot.reconnectMs ?? 3000,
  heartbeatTimeoutMs: config.onebot.heartbeatTimeoutMs ?? 90000,
  log: m => logger.log(m),
})

// 协议选择：acp（默认，支持挂 MCP）/ sdk（旧方案，不支持 MCP）
const PROTOCOL = config.dsh.protocol ?? 'acp'

// ── ACP profile 名的最终防线 ─────────────────────────────────────────────────
//
// 🔴 2026-10-31（CPU 打满事故）：插件侧 `bridgeProfileName()` 已经会挡住
//    web/headless/desktop，但**桥侧还得再守一道**：
//
//    ① bridge-config.json 是「插件写、桥读」的。旧版本写进去的是
//       `profile: "web"`（插件装在 profiles/web 下，反推出来就是 web），
//       而那份配置**已经落盘**。只修插件侧的推导，对已存在的配置文件无效 ——
//       用户升级插件后仍然拿着旧的 "web" 去起子进程。
//    ② 实测 4 分钟 99 次 `dsh --profile web`，每次都撞
//       `EADDRINUSE 127.0.0.1:3080`（web 会起 HTTP 服务，和宿主抢端口）→
//       加载整套 DSH + 9 个插件 + exit 1，CPU 直接顶满。
//
// 所以桥自己再判一次：会起端口的 profile 名一律落到随附的 `acp`（纯 stdio）。
// 这不是重复防御 —— 插件侧管「新写的配置是对的」，桥侧管「写错的老配置也能跑」。
const HOST_PROFILES = new Set(['desktop', 'web', 'headless'])
const SAFE_ACP_PROFILE = 'acp'
const DSH_PROFILE = (() => {
  const want = String(config.dsh?.profile ?? '').trim()
  if (!want) return SAFE_ACP_PROFILE
  if (HOST_PROFILES.has(want.toLowerCase())) {
    logger.log(`dsh profile "${want}" 会起 HTTP 服务、和宿主抢端口，已改用 "${SAFE_ACP_PROFILE}"`)
    return SAFE_ACP_PROFILE
  }
  return want
})()
// ⚠️ env 有两种合法写法，必须都认（2026-10-29 实测踩到）：
//   对象   {PATH:'/usr/bin'}            ← 老脚本版 bridge/config.json 的写法
//   数组   [{name:'PATH',value:'...'}]   ← **ACP 协议格式**，插件版 bridgeConfig 产出这个
// 原来只写了 Object.entries(env)，喂数组进来会变成
//   [['0', {name,value}], ['1', {...}]] → ACP 收到 {name:'0', value:'[object Object]'}
// 后果是**所有环境变量静默丢失**（尤其 STORYBOARD_DIR 丢了会让产物落到错误目录，
// 模型拿到路径也发不出去，而且极难排查）。所以这里显式分支处理。
function normalizeMcpEnv (env) {
  if (Array.isArray(env)) {
    // 已经是 ACP 格式：只做净化（name 必须是字符串、value 转字符串）
    return env
      .filter(e => e && typeof e === 'object' && e.name != null)
      .map(e => ({ name: String(e.name), value: String(e.value ?? '') }))
  }
  if (env && typeof env === 'object') {
    return Object.entries(env).map(([name, value]) => ({ name, value: String(value) }))
  }
  return []
}

const MCP_SERVERS = (config.mcpServers ?? []).map(srv => ({
  name: srv.name,
  command: srv.command,
  args: srv.args ?? [],
  env: normalizeMcpEnv(srv.env),
}))

// bili_* 工具（bili_search / bili_subtitle / bili_comments / bili_cover /
// bili_frames / bili_whoami）不是桥自带的，全靠 ACP 会话里挂的 MCP 服务器提供。
// 所以「能不能吹自己有 B站 工具」必须看 mcpServers 里到底有没有那一行，
// 不能只看 features.bili —— 否则提示词会教模型调一堆根本不存在工具。
const BILI_MCP = MCP_SERVERS.find(srv =>
  /bili/i.test(`${srv.name ?? ''} ${srv.command ?? ''} ${(srv.args ?? []).join(' ')}`),
) ?? null

const dsh = PROTOCOL === 'sdk'
  ? new DshRuntime({
      bin: config.dsh.bin,
      profile: DSH_PROFILE,
      cwd: config.dsh.cwd,
      provider: config.dsh.provider,
      model: config.dsh.model,
      reasoningEffort: config.dsh.reasoningEffort,
      startTimeoutMs: config.dsh.startTimeoutMs,
      turnTimeoutMs: config.dsh.turnTimeoutMs,
      log: m => logger.log(m),
    })
  : new AcpRuntime({
      bin: config.dsh.bin,
      profile: DSH_PROFILE,
      cwd: config.dsh.cwd,
      provider: config.dsh.provider,
      model: config.dsh.model,
      reasoningEffort: config.dsh.reasoningEffort,
      mcpServers: MCP_SERVERS,
      startTimeoutMs: config.dsh.startTimeoutMs,
      turnTimeoutMs: config.dsh.turnTimeoutMs,
      patchFile: path.join(path.dirname(cfgPath), 'acp-route.patch.yml'),
      // 群成员的消息会经模型触发工具调用（mcpServers 是挂着的）。
      // 默认 auto（兼容旧行为），但可配置成 allowlist/deny，见 acp.js 的注释。
      toolPolicy: config.security?.toolPolicy,
      log: m => logger.log(m),
    })

// （ACP 会话映射在 state 定义之后接线，见下方）
logger.log(`bridge 使用协议: ${PROTOCOL}${PROTOCOL === 'acp' ? `（mcpServers=${MCP_SERVERS.length}）` : '（不支持 MCP）'}`)
if (config.bili?.enabled !== false && !BILI_MCP) {
  logger.log('bili: features.bili 开着，但 mcpServers 里没有 bili 服务器 → 不给模型注入 bili_* 工具提示（免得教它调不存在的工具）')
}

// peer -> sessionId，持久化到 state.json，重启后能续同一个会话
const STATE_DIR = process.env.LLMINQQ_STATE_DIR ? path.resolve(process.env.LLMINQQ_STATE_DIR) : path.join(ROOT, 'logs')
fs.mkdirSync(STATE_DIR, { recursive: true })
const statePath = path.join(STATE_DIR, 'state.json')
let state = { peers: {}, people: {} }
try {
  state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  if (!state.peers) state.peers = {}
  // 老状态文件没有 people（好感度是 2026-10-28 加的顶层键）→ 补一个空对象，无需迁移
  if (!state.people) state.people = {}
} catch { /* 首次运行 */ }

let saveTimer = null
let saveErrorLogged = false
function saveState() {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    flushState()
  }, 500)
}

/**
 * 立刻把 state 落盘。
 *
 * 为什么不再裸 writeFileSync：Windows 上杀软/索引器会短暂占用文件，
 * writeFileSync 抛 EPERM/EBUSY —— 原来这个异常在 setTimeout 里没人接，
 * 直接变成 uncaughtException，整个桥静默退出（用户只看到「机器人不说话了」）。
 * 现在：失败只记一次日志 + 1s 后重试，状态退化为内存态，桥继续活着。
 */
function flushState() {
  try {
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2))
    saveErrorLogged = false
  } catch (err) {
    if (!saveErrorLogged) {
      saveErrorLogged = true
      logger.log(`ERROR 状态落盘失败，改为内存态稍后重试: ${err.message}`)
    }
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => { saveTimer = null; flushState() }, 1000)
  }
}

// ACP 会话是服务端生成的、可 resume 的持久会话。桥自己维护 peerKey -> acpSessionId，
// 落进 state.json 的 peers[key].acpSessionId，重启后用 session/resume 接上（保住上下文）。
if (dsh instanceof AcpRuntime) {
  dsh._remembered = new Map(
    Object.entries(state.peers)
      .filter(([, v]) => v?.acpSessionId)
      .map(([k, v]) => [k, v.acpSessionId]),
  )
  dsh.onSessionCreated = (peerKey, acpSessionId) => {
    if (!state.peers[peerKey]) {
      state.peers[peerKey] = { sessionId: `session-qq-${crypto.randomUUID()}`, createdAt: Date.now(), turns: 0 }
    }
    state.peers[peerKey].acpSessionId = acpSessionId
    saveState()
    logger.log(`acp 会话已记账 ${peerKey} -> ${acpSessionId}`)
  }
  if (dsh._remembered.size) logger.log(`acp: 从 state 恢复 ${dsh._remembered.size} 个会话映射`)
}

function sessionIdFor(peerKey) {
  if (!state.peers[peerKey]) {
    state.peers[peerKey] = { sessionId: `session-qq-${crypto.randomUUID()}`, createdAt: Date.now(), turns: 0 }
    saveState()
    logger.log(`新会话映射 ${peerKey} -> ${state.peers[peerKey].sessionId}`)
  }
  return state.peers[peerKey].sessionId
}

// ── 回复与发图 ──────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms))


/**
 * 整理出站文本里的换行。
 *
 * 为什么需要：模型经常输出「第一句\n\n第二句」——那是**写文章的排版**（段落之间空行）。
 * 但 QQ 聊天里空一行读起来像发邮件/写周报，不像真人随口说话。
 * 真人连说两句要么换行直接接，要么干脆一句话。
 *
 * 规则（保守，只动空行，不动单换行）：
 *   - 连续 2 个以上换行 → 压成 1 个换行（段距变行距）
 *   - 行首行尾空白去掉
 *   - 不合并单换行（那是有意的分行，比如 1. 2. 3. 列表）
 */
function tidyLineBreaks (text) {
  if (typeof text !== 'string' || !text) return text
  return text
    .replace(/\r\n?/g, '\n')          // 统一 LF
    .replace(/[ \t]+$/gm, '')          // 行尾空白
    .replace(/[ \t]{2,}/g, ' ')        // 行内多空格压一个
    .replace(/\n{2,}/g, '\n')          // **核心：连续空行压成单换行**
    .replace(/^\n+|\n+$/g, '')         // 首尾空行去掉
    .trim()
}

async function sendTextTo(peer, text) {
  if (!text) return
  // 出站前统一整理换行（所有发送路径都走这里）
  text = tidyLineBreaks(text)
  if (!text) return
  const max = config.policy.maxReplyChars ?? 1500
  // 分块时按纯文本长度算，保留 [AT] 标记
  const chunks = chunkText(text, max)
  for (let i = 0; i < chunks.length; i++) {
    const segments = textToSegments(chunks[i]).filter(s => !(s.type === 'text' && !s.data.text))
    if (!segments.length) continue
    const params = peer.scope === 'group'
      ? { group_id: Number(peer.id), message: segments, auto_escape: false }
      : { user_id: Number(peer.id), message: segments, auto_escape: false }
    try {
      const res = await gateway.callData(peer.scope === 'group' ? 'send_group_msg' : 'send_private_msg', params, 20000)
      noteSelfSent(peer, res, 'text')
      const atCount = segments.filter(s => s.type === 'at').length
      if (atCount) logger.log(`已发送含 ${atCount} 个真 @ 的消息 -> ${peer.scope}:${peer.id}`)
    } catch (err) {
      logger.log(`发送文本失败 ${JSON.stringify(peer)}: ${err.message}`)
      return
    }
    if (i < chunks.length - 1) await sleep(config.policy.replyChunkDelayMs ?? 400)
  }
}

/** 执行戳一戳。群里用 send_poke，私聊用 friend_poke。 */
async function sendPokeTo(peer, targetQq, scopeOverride) {
  const scope = scopeOverride ?? peer.scope
  const qq = Number(targetQq)
  if (!Number.isFinite(qq)) return false
  try {
    if (scope === 'group') {
      await gateway.callData('send_poke', { group_id: Number(peer.id), user_id: qq }, 15000)
    } else {
      await gateway.callData('friend_poke', { user_id: qq }, 15000)
    }
    logger.log(`已戳一戳 ${qq} (${scope})`)
    return true
  } catch (err) {
    logger.log(`戳一戳失败 ${qq}: ${err.message}`)
    return false
  }
}

async function sendImageTo(peer, filePath) {
  if (!config.media?.enabled) {
    logger.log(`media 已禁用，跳过发图 ${filePath}`)
    return false
  }
  const check = isPathAllowedForSend(filePath)
  if (!check.ok) {
    logger.log(`BLOCKED SEND_FILE: ${filePath} — ${check.reason}`)
    return false
  }
  const b64 = fs.readFileSync(check.path).toString('base64')
  const seg = { type: 'image', data: { file: `base64://${b64}` } }
  const params = peer.scope === 'group'
    ? { group_id: Number(peer.id), message: [seg] }
    : { user_id: Number(peer.id), message: [seg] }
  try {
    const res = await gateway.callData(peer.scope === 'group' ? 'send_group_msg' : 'send_private_msg', params, 60000)
    noteSelfSent(peer, res, 'image')
    logger.log(`已发图 ${path.basename(check.path)} -> ${peer.scope}:${peer.id}`)
    return true
  } catch (err) {
    logger.log(`发图失败 ${filePath}: ${err.message}`)
    return false
  }
}

// ── 卡片消息解析 ────────────────────────────────────────────────────────────
// NapCat 把 QQ 的 Ark 卡片（小程序 / 分享链接 / 音乐 / 图文）统一转成
// OneBot 的 `{type:'json', data:{data:'<JSON字符串>'}}` 段（见 NapCat 源码
// `arkElement: async (e) => ({ type: ze.json, data: { data: e.bytesData } })`）。
//
// 这些卡片的 JSON 结构各不相同，但都有可读的标题/描述。这里按优先级挖：
//   prompt                      ← 最稳（NapCat 自己也在用）
//   meta.detail_1.title/desc    ← 小程序
//   meta.news.title/desc        ← 分享链接
//   meta.music.title/desc       ← 音乐
//   meta.detail.title/desc      ← 其它
//   app + 兜底                   ← 实在没有就说是什么类型
// 解析失败一律降级成「[卡片]」，绝不抛错、绝不让消息被当空消息丢掉。

// ── 合并转发展开 ────────────────────────────────────────────────────────────
// QQ 的「合并转发」在 OneBot 里是一个 {type:'forward', data:{id}} 段，
// 内容不在本条消息里，要再用 get_forward_msg 按 id 拉一次。
// 展开成「昵称: 内容」的多行文本，塞进模型上下文，它就能真正读到被转发的对话。

// ── staging 清理 ────────────────────────────────────────────────────────────
// 入站图片、头像、测试图都落在 staging，长期运行会无限增长。
// 策略：按 mtime 删超过 maxAgeHours 的文件；总量超 maxFiles 时从最旧开始删。
// 只动 staging 目录本身（不递归），不碰工作区里的东西。
function pruneStaging() {
  const cfg = config.media?.prune ?? {}
  if (cfg.enabled === false) return
  const maxAgeMs = (cfg.maxAgeHours ?? 24) * 3600 * 1000
  const maxFiles = cfg.maxFiles ?? 300
  let entries
  try {
    entries = fs.readdirSync(STAGING_DIR, { withFileTypes: true })
      .filter(e => e.isFile())
      .map(e => {
        const p = path.join(STAGING_DIR, e.name)
        try { const st = fs.statSync(p); return { p, name: e.name, mtime: st.mtimeMs, size: st.size } }
        catch { return null }
      })
      .filter(Boolean)
  } catch (err) {
    logger.log(`WARN staging 扫描失败: ${err.message}`)
    return
  }
  const now = Date.now()
  let removed = 0
  let freed = 0
  // 1) 超期
  for (const e of entries) {
    if (now - e.mtime > maxAgeMs) {
      try { fs.unlinkSync(e.p); removed++; freed += e.size } catch { /* ignore */ }
    }
  }
  // 2) 超量：从最旧删到 maxFiles
  const left = entries.filter(e => !(now - e.mtime > maxAgeMs) && fs.existsSync(e.p))
  if (left.length > maxFiles) {
    left.sort((a, b) => a.mtime - b.mtime)
    for (const e of left.slice(0, left.length - maxFiles)) {
      try { fs.unlinkSync(e.p); removed++; freed += e.size } catch { /* ignore */ }
    }
  }
  if (removed) logger.log(`staging 清理：删除 ${removed} 个文件，释放 ${(freed / 1024).toFixed(0)} KB`)
}

// ── 作息（软约束）────────────────────────────────────────────────────────────
// 目的：真人小号凌晨不会活跃。凌晨还在回消息是"非人类作息"特征之一。
// 原则：**不硬拦**。硬拦会让群友发现"这人到点就消失"，反而更假、更烦人。
// 做法：
//   - 深夜/凌晨给模型一个"现在是几点、该不该回"的提示
//   - 降低旁听插话的倾向（不说沉默，只说"这个点插话要更克制"）
//   - 被 @ / 私聊仍然照常回（有人专门找你，装死才是最假的）
//   - 允许模型自己判断"这人显然在熬夜聊天，那我也能聊"
const QUIET = {
  enabled: true,
  // 默认：01:00–07:00 算深夜（可配）
  startHour: 1,
  endHour: 7,
  // 深夜时旁听倾向乘以这个系数（不是归零）
  passiveRatioFactor: 0.35,
}

/** 当前小时（按配置的时区，默认拿系统时区） */
function currentHour() {
  const tz = config.policy?.timezone
  if (tz) {
    try {
      const h = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: tz }).format(new Date()))
      return Number.isFinite(h) ? h % 24 : new Date().getHours()
    } catch { /* 时区非法就退回本地 */ }
  }
  return new Date().getHours()
}

/** 现在是不是深夜时段（支持跨午夜，如 23–7） */
function isQuietHours() {
  const cfg = { ...QUIET, ...(config.policy?.quietHours ?? {}) }
  if (cfg.enabled === false) return { quiet: false, hour: currentHour(), cfg }
  const h = currentHour()
  const { startHour: a, endHour: b } = cfg
  const quiet = a <= b ? (h >= a && h < b) : (h >= a || h < b)
  return { quiet, hour: h, cfg }
}

/** 深夜时给模型的提示（软约束，不禁止） */
function quietHint(hour, cfg) {
  const hh = String(hour).padStart(2, '0')
  return [
    `【现在是 ${hh}:00 左右，属于深夜/凌晨】`,
    '正常人在这个点基本都睡了。所以：',
    '- 旁听时插话要**更克制**：除非话题正好问到你、或你真有话说，否则沉默是更自然的选择。',
    '- 被 @ 或私聊**仍然照常回**——有人专门找你，装死才更奇怪。',
    '- 如果对方明显在熬夜聊天（连着说话、语气活跃），那陪着聊两句没问题，别扫兴。',
    '- **不要主动说「这么晚了还不睡」这种话**，很烦人。',
  ].join('\n')
}

// ── 主动搭话（proactive）─────────────────────────────────────────────────────
// 规格见 qq-agent/proactive-msg-spec.md（吉祥物自己写的需求）。
// 摘要：
//   tick 每 tickMin（默认 20）分钟一次；计时基准 = 我最后一次发言（last_spoke_at）
//   距上次发言不足 tickMin → 跳过（不评估、不改概率）
//   否则 roll：命中就发；未命中 p += step（上限 maxProb）
//   连续 guaranteeCount 次未命中 → 保底发一条
//   命中后 p 回 baseProb + 冷却 cooldownMin
//   01:00–07:00 不评估（保底也不触发）；23:00–01:00 概率 ×nightFactor
//   v1 只对白名单里的私聊生效，群聊一律不发
const PROACTIVE_DEFAULTS = {
  enabled: false,
  baseProb: 0.10,
  step: 0.05,
  maxProb: 0.60,
  guaranteeCount: 6,
  cooldownMin: 40,
  tickMin: 20,
  quietStartHour: 1,
  quietEndHour: 7,
  nightStartHour: 23,
  nightEndHour: 1,
  nightFactor: 0.5,
  whitelist: [],
  // 连续空转多少次后进入长冷却（见空转分支）
  emptyCooldownAfter: 3,
  emptyCooldownMin: 120,
  // ── 「接话窗口」（chatFollow，2026-10-26 新增；语义经过两轮纠正，别按旧注释理解）──
  //
  // 用户的原话：
  //   「十分钟内可以不等对方发言。过十分钟回到原有逻辑，**不是对方10分钟不发言就找新话题**，
  //     这样可能一直找新话题，不进原有逻辑。」
  //   「在话题中正常人的对话一般不是一问一答的，而是这边几句那边几句。」
  //
  // 所以 silentMin 是**窗口长度**，不是「沉默到点触发」的门槛。时间轴：
  //
  //   T0          对方发消息（锚点 = lastUserMsgAt）
  //   T0 ~ T0+10  窗口**开着**：我可以不等他回复就补话（这边几句那边几句）
  //   T0+10 之后  窗口**彻底关闭** → chatFollow 停止，什么都不做
  //               → 交给原有逻辑：我安静满 20min → 概率模型掷骰
  //
  // ⚠️ 三条硬规则（第一版全错了，这里写死，后人也别再改错）：
  //   ① **锚点是对方最后一条消息**（lastUserMsgAt）。我说话**不延长窗口**。
  //      否则我一直说自己就把窗口一直续上，退化成「无限找新话题」——正是用户担心的。
  //      代码层面：touchLastUserMsg 只在**入站**时调，touchLastSpoke 绝不改它。
  //   ② 窗口外 chatFollow 必须**彻底停**，不是「换个方式再找话题」。
  //   ③ chatFollow 只做「把**当前话题**接着聊」，不做「起新话题」。
  //      起新话题是窗口外原有 20min 概率路径的职责，两套逻辑**串行衔接**，不是并行竞争。
  //
  // 交互效果（这才是自然的）：
  //   对方说话 → 我回 → 窗口开 10 分钟
  //     窗口内：可以说 1-2 句（受 maxPerHour + 60~90s 间隔防抖）
  //   10 分钟后窗口关，chatFollow 不再触发 → lastSpokeAt 自然老化
  //   → 满 20 分钟，原有概率路径开始评估（「该不该主动找话了」）
  chatFollow: {
    enabled: true,
    silentMin: 10,        // 窗口长度：对方最后一条消息之后这么多分钟内可以补话
    maxPerHour: 3,        // 窗口内最多补几次（防刷屏）
    minGapSec: 75,        // 窗口内两次补话的最短间隔（防「立刻连发」；真人也要隔一会儿）
    maxFollowUps: 3,      // 每个窗口最多补几轮（我说话不续窗口，所以这是上限不是续期）
  },
}

function proactiveCfg () {
  return { ...PROACTIVE_DEFAULTS, ...(config.proactive ?? {}) }
}

/** 每个 peer 的主动搭话状态，落在 state.peers[key].proactive 里。 */
function proactiveState (peerKey) {
  const ps = state.peers[peerKey]
  if (!ps) return null
  if (!ps.proactive) {
    ps.proactive = {
      p: proactiveCfg().baseProb,
      missStreak: 0,
      lastSpokeAt: 0,
      lastUserMsgAt: 0,       // 对方最后一次发言 = 接话**窗口的锚点**（我说话不改它）
      lastProactiveAt: 0,
      cooldownUntil: 0,
      followHits: [],         // 接话最近命中的时间戳（每小时限频用）
      followChain: 0,         // 本窗口内已补几句（窗口关了/新窗口开时清零）
      followWindowClosedAt: 0, // 窗口关闭时刻（日志+下个窗口重置用；0=窗口开着）
    }
  }
  return ps.proactive
}

/** 刷新「我最后一次发言」时间（回一条 / 主动发一条都算）。 */
function touchLastSpoke (peerKey) {
  const st = proactiveState(peerKey)
  if (st) st.lastSpokeAt = Date.now()
  saveState()
}

/** 记录「对方最后一次发言」时间（接话路径的计时基准）。 */
function touchLastUserMsg (peerKey) {
  const st = proactiveState(peerKey)
  if (st) st.lastUserMsgAt = Date.now()
  saveState()
}

/** 当前小时（沿用全局 timezone 配置）。 */
function nowHour () {
  const tz = config.policy?.timezone
  if (tz) {
    try {
      const h = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: tz }).format(new Date()))
      return Number.isFinite(h) ? h % 24 : new Date().getHours()
    } catch { /* ignore */ }
  }
  return new Date().getHours()
}

// 状态系统（精力 + 情绪 + 好感度）—— 2026-10-29 从本文件拆出。
// state/saveState/config/logger 传进去（同一个引用），persona 从 persona.js 注入。
const stateMod = createState({ config, logger, state, saveState, persona: personaMod, nowHour })
const {
  energyCfg, energyState, energyDrop, energyHint, energyCharCap, startEnergyLoop, moodEnergyFactor,
  moodCfg, moodState, moodEvent, moodHint, startMoodLoop,
  affectionCfg, affectionTier, affectionEvent, affectionCheckin, affectionDailyTick,
  affectionHint, splitLongSentence, peopleState, dayIndex,
} = stateMod

// 消息形态处理（SEND_FILE/语音、卡片解析、合并转发）—— 2026-10-29 从本文件拆出。
const messagingMod = createMessaging({ config, logger, gateway, security, noteSelfSent, sendTextTo })
const {
  VOICE_MAX_CHARS, DEFAULT_AUDIO_CHARACTER, VOICE_CHARACTERS,
  resolveVoiceCharacter, synthesizeToFile, sendRecordFile, sendVoiceTo,
  extractSendFiles,
  CARD_MAX_CHARS, cardJsonToText, xmlToText,
  FORWARD_MAX_MSGS, FORWARD_MAX_CHARS,
  segToPlainText, quoteOf, expandForwards,
} = messagingMod

/** 主动搭话的时段闸：返回 {skip, factor, why} */
function proactiveWindow () {
  const c = proactiveCfg()
  const h = nowHour()
  const inQuiet = c.quietStartHour <= c.quietEndHour
    ? (h >= c.quietStartHour && h < c.quietEndHour)
    : (h >= c.quietStartHour || h < c.quietEndHour)
  if (inQuiet) return { skip: true, factor: 0, why: `静默时段 ${h}:00` }
  const inNight = c.nightStartHour <= c.nightEndHour
    ? (h >= c.nightStartHour && h < c.nightEndHour)
    : (h >= c.nightStartHour || h < c.nightEndHour)
  return { skip: false, factor: inNight ? c.nightFactor : 1, why: inNight ? `夜间 ${h}:00 ×${c.nightFactor}` : `白天 ${h}:00` }
}

/**
 * 从一条消息里识别情绪触发（关键词 + 是否 @ 我）。
 * 宁可漏判也不要误判成"被夸了"然后强行开心。
 */
function detectMoodTriggers (text, { addressed = false, atMe = false } = {}) {
  const t = String(text || '')
  const out = []
  // 夸奖 / 感谢：要么有明确指向（你/厉害），要么是明确的我-centric 词。
  // 「不错」太泛——「今天天气不错」会被误判，所以不在列表里。
  const PRAISE = [
    /(你|您).{0,4}(牛|厉害|强|真行|靠谱|有用|能行|太逗|好笑|有意思)/,
    /(谢谢|多谢|感谢).{0,6}(你|白嫖|吉祥物|老大)/,
    /(谢谢|多谢|感谢)/,
    /(牛啊|牛逼|厉害啊|666|nb)/i,
    /(笑死|太好笑|太逗了)/,
  ]
  if (PRAISE.some(re => re.test(t))) out.push({ kind: 'praise', why: '被夸/被谢' })
  // 挨怼 / 被纠错（幅度小，不记仇）
  if (/(傻|笨|蠢|滚|闭嘴|废物|没用|垃圾|神经|有病|你不行|错了|说错|不对|胡说|瞎编|又在编)/i.test(t)) {
    out.push({ kind: 'insult', why: '被怼/被纠错' })
  }
  // 被点名 → 活跃度上升
  if (addressed || atMe) out.push({ kind: 'addressed', why: '被点到' })
  return out
}

// ── 回话延迟（v2-2）────────────────────────────────────────────────────────
// 需求：「回话有快有慢，太匀速反而假」。
// 默认关（容易让人以为掉线），开启后对**被 @ / 私聊**的回复加一个短随机延迟。
const DELAY_DEFAULTS = {
  enabled: true,
  // 按「打字」算，不是纯随机：
  //   总时长 = 反应时间 + 字数 × 每字耗时，再加抖动
  // 真人「嗯」秒回；一段话要打一会儿。这才是"回话有快有慢"的真实来源。
  reactMs: 1200,         // 看到消息后的反应时间
  perCharMs: 110,        // 每字大约打多久（中文输入法约 9 字/10 秒）
  minMs: 900,            // 兜底最短
  maxMs: 15000,          // 兜底最长（再长像掉线）
  jitterRatio: 0.35,     // 抖动 ±35%
  energySlow: 0.6,       // 精力见底时打字速度乘数（0.6 = 慢 1.67 倍）
  arousalFast: 0.55,     // 情绪最亢奋时打字速度乘数（0.55 = 快近 2 倍）
}

function delayCfg () { return { ...DELAY_DEFAULTS, ...(config.replyDelay ?? {}) } }

/**
 * 算一个回复延迟（毫秒）。按字数算打字时间，再叠加精力/情绪。
 * @param {string} text 要发的内容
 * @param {string} [peerKey] 传了就把精力（累了慢）和情绪（亢奋快）算进去
 */
function replyDelayMs (text, peerKey) {
  const c = delayCfg()
  if (!c.enabled) return 0
  const len = Array.from(String(text ?? '')).length
  let ms = c.reactMs + len * c.perCharMs

  if (peerKey) {
    try {
      // 精力低 → 打字慢
      const e = energyState(peerKey)
      if (e) {
        const t = Math.max(0, Math.min(1, e.value))
        ms *= 1 + (1 - t) * (1 / c.energySlow - 1)
      }
      // 情绪亢奋 → 打字快
      const m = moodState(peerKey)
      if (m && m.arousal > 0.5) {
        // arousal 0.5 → ×1；1.0 → ×c.arousalFast（线性）
        const t = Math.min(1, (m.arousal - 0.5) / 0.5)
        ms *= 1 - t * (1 - c.arousalFast)
      }
    } catch { /* 状态取不到就跳过，别影响发送 */ }
  }

  ms *= 1 + (Math.random() * 2 - 1) * c.jitterRatio
  return Math.round(Math.max(c.minMs, Math.min(c.maxMs, ms)))
}

let proactiveTimer = null
let chatFollowTimer = null

/** 接话路径的配置（跟 proactive 共用 PROACTIVE_DEFAULTS，用户可只覆盖 chatFollow 段）。 */
function chatFollowCfg () {
  return { ...PROACTIVE_DEFAULTS.chatFollow, ...(proactiveCfg().chatFollow ?? {}) }
}

/**
 * 接话限频：最近一小时内已经接了几次。
 * followHits 只存最近 1 小时的命中时间戳，读的时候顺手清理旧的（自净，不用额外定时器）。
 */
function followRateOk (st, now = Date.now()) {
  const c = chatFollowCfg()
  const hits = (st.followHits ?? []).filter(t => now - t < 3600000)
  st.followHits = hits
  return hits.length < c.maxPerHour
}

/** 记一次接话命中（限频用）。 */
function noteFollowHit (st, now = Date.now()) {
  const hits = (st.followHits ?? []).filter(t => now - t < 3600000)
  hits.push(now)
  st.followHits = hits
  saveState()
}

/** 选一个可以主动搭话的 peer：v1 只看白名单里的私聊。 */
function proactiveCandidates () {
  const c = proactiveCfg()
  if (c.whitelist.length === 0) return []
  return Object.keys(state.peers)
    .filter(k => k.startsWith('c2c:'))
    .filter(k => c.whitelist.includes(k.slice(4)))
    .map(k => ({ peerKey: k, peer: { id: k.slice(4), scope: 'c2c' } }))
}

/** 跑一次 tick（对每个候选 peer 独立评估）。 */
async function proactiveTick () {
  const c = proactiveCfg()
  if (!c.enabled) return
  const win = proactiveWindow()
  const candidates = proactiveCandidates()
  if (!candidates.length) return

  for (const { peerKey, peer } of candidates) {
    const st = proactiveState(peerKey)
    if (!st) continue
    const now = Date.now()
    const minsSinceSpoke = st.lastSpokeAt ? (now - st.lastSpokeAt) / 60000 : Infinity

    // ① 距上次发言不足 tickMin → 跳过（不评估、不改概率）
    if (Number.isFinite(minsSinceSpoke) && minsSinceSpoke < c.tickMin) {
      logger.log(`proactive[${peerKey}] 跳过：距上次发言 ${minsSinceSpoke.toFixed(0)}min < ${c.tickMin}`)
      continue
    }
    // ② 冷却中 → 跳过
    if (now < st.cooldownUntil) {
      logger.log(`proactive[${peerKey}] 跳过：冷却中（剩 ${((st.cooldownUntil - now) / 60000).toFixed(0)}min）`)
      continue
    }
    // ③ 静默时段 → 跳过（保底也不触发）
    if (win.skip) {
      logger.log(`proactive[${peerKey}] 跳过：${win.why}`)
      continue
    }

    // ④ 掷骰：概率按夜间系数缩放
    const pEff = Math.min(c.maxProb, st.p * win.factor)
    const roll = Math.random()
    let action = 'miss'
    // ⚠️ 保底判定必须基于「连续 miss 次数」，而 missStreak 在空转时**不增长**（上午的修改）。
    //    于是如果只写 `missStreak+1 >= guaranteeCount`，当 missStreak 卡在 5 时
    //    这个条件**恒为真** → 每轮都判 guarantee → 每轮都空转 → 死循环。
    //    2026-10-26 实测：连续 5 轮全部 guarantee，全空转，missStreak 卡在 5 不动。
    //
    //    修法：保底触发后要**要求有新的 miss 积累**。用 misssSinceGuarantee 单独计，
    //    空转也计入这个计数（否则「一直空转」永远不会被保底救，也永远不会停）。
    const missesSinceGuarantee = (st.missesSinceGuarantee ?? 0)
    if (missesSinceGuarantee + 1 >= c.guaranteeCount) action = 'guarantee'
    else if (roll < pEff) action = 'hit'

    logger.log(`proactive[${peerKey}] 评估：距上次 ${Number.isFinite(minsSinceSpoke) ? minsSinceSpoke.toFixed(0) + 'min' : '首次'} | p=${(st.p * 100).toFixed(0)}%${win.factor !== 1 ? ` (${win.why}→${(pEff * 100).toFixed(0)}%)` : ''} | roll=${roll.toFixed(3)} | ${action}`)

    if (action === 'miss') {
      st.p = Math.min(c.maxProb, st.p + c.step)
      st.missStreak += 1
      st.missesSinceGuarantee = (st.missesSinceGuarantee ?? 0) + 1
      saveState()
      continue
    }

    // ⑤ 命中/保底 → 让模型自己决定说什么（也可能空转）
    const spoke = await proactiveSpeak(peerKey, peer, action)
    if (spoke) {
      st.p = c.baseProb
      st.missStreak = 0
      st.missesSinceGuarantee = 0
      st.empties = 0
      st.lastProactiveAt = Date.now()
      st.lastSpokeAt = Date.now()
      st.cooldownUntil = Date.now() + c.cooldownMin * 60000
    } else {
      // 空转（模型评估过但确实没话说）→ **不累加 missStreak**。
      //
      // 这是一个真实的设计缺陷（2026-10-26 实测）：原来空转也被算作未命中，
      // 导致「保底 → 模型没话说 → 空转 → streak+1 → 更快触发保底 → 又没话说」
      // 的死循环。实测 missStreak 一路涨到 7，p 涨到 45%，连保底 3 次都空转。
      //
      // 语义上：missStreak 应该表示「运气不好，一直没抽中」，
      // 而空转是「抽中了但内容上确实没什么可说的」——两者不该混为一谈。
      // 所以：空转只轻微抬 p（让下次更容易抽中，给新话题一个机会），不动 streak。
      // 空转**不抬 p**（原来抬 0.5×step，实测导致 p 一路涨到 50% 还在涨，恶性循环）
      // 但计入 missesSinceGuarantee，让「连续空转」也能被计数、最终走到真正的休止
      st.empties = (st.empties ?? 0) + 1
      st.missesSinceGuarantee = (st.missesSinceGuarantee ?? 0) + 1
      st.lastEmptyAt = Date.now()
      // 连续空转太多 → 进入长冷却（说明确实没话说，别每 20 分钟骚扰一次）
      if (st.empties >= (c.emptyCooldownAfter ?? 3)) {
        st.cooldownUntil = Date.now() + (c.emptyCooldownMin ?? 120) * 60000
        logger.log(`proactive[${peerKey}] 空转 ${st.empties} 次 → 进入 ${c.emptyCooldownMin ?? 120}min 长冷却`)
        st.empties = 0
        st.missesSinceGuarantee = 0
      }
      logger.log(`proactive[${peerKey}] 空转（真没话说），不累加 missStreak（当前 ${st.missStreak}，空转累计 ${st.empties}）`)
    }
    saveState()
  }
}

// ── 接话窗口（chatFollow）────────────────────────────────────────────────────
// 语义见 PROACTIVE_DEFAULTS.chatFollow 上方那段长注释。一句话：
// **窗口内（对方最后一条消息之后 10 分钟内）可以不等回复就补话；窗口外彻底停。**
// 窗口外的事不归这里管，归上面那条 20min 概率路径管 —— 两套逻辑**串行衔接**。
//
// 与 proactive 共享：静默时段、冷却、发送链路。
// 不共享：概率模型（接话不看概率）、限频计数（各自独立，避免互相挤占额度）。
/**
 * 接话窗口的**纯决策函数**（不读写 state、不调模型、不发消息）。
 *
 * 抽出来的原因有两个，都很实际：
 *   ① 窗口语义被改错过两次（「沉默到点就开口」→「窗口内才补话」），
 *      把时间段判断集中到这里，测试才能用**假时钟**直接验证「窗口内/窗口外」的分界，
 *      不用真的等 10 分钟。（真跑一遍 10 分钟的测试不会有人愿意跑。）
 *   ② 边界条件写在一处，比散落在 tick 里更容易看对。
 *
 * 三条硬规则的落点（见 PROACTIVE_DEFAULTS.chatFollow 注释）：
 *   规则①（锚点是 lastUserMsgAt，我说话不延长窗口）→ 这里只看 st.lastUserMsgAt，
 *         **完全不碰 lastSpokeAt 来算 age**。
 *   规则②（窗口外彻底停）→ age > windowMs 时 act=false，且不改任何「要不要找新话题」的意图。
 *   规则③（只补当前话题，不找新话题）→ 体现在 chatFollowSpeak 的 prompt 里。
 *
 * @returns {{act:boolean, why?:string, age:number, windowClosedNow:boolean, newWindow:boolean}}
 */
function chatFollowDecision (st, now, cfg) {
  const c = cfg ?? chatFollowCfg()
  const windowMs = Math.max(1, Number(c.silentMin)) * 60000
  const minGapMs = Math.max(0, Number(c.minGapSec) || 0) * 1000
  // ① 从没收到过他的消息 → 不接（那是「起话」，20min 概率路径的事）
  if (!st.lastUserMsgAt) return { act: false, why: '他还没发过言', age: Infinity, windowClosedNow: false, newWindow: false }

  const age = now - st.lastUserMsgAt

  // ② 窗口外 → **彻底停**。不是「换个方式找新话题」，是直接不管。
  if (age > windowMs) {
    const windowClosedNow = !st.followWindowClosedAt
    if (windowClosedNow) {
      st.followWindowClosedAt = now
      st.followChain = 0
    }
    return { act: false, why: `窗口外（对方最后发言 ${Math.round(age / 60000)}min 前 > ${c.silentMin}min）`, age, windowClosedNow, newWindow: false }
  }

  // 窗口内。如果上次标记过关闭（说明对方又说话了），开新窗口并重置本窗口计数
  let newWindow = false
  if (st.followWindowClosedAt) {
    st.followWindowClosedAt = 0
    st.followChain = 0
    newWindow = true
  }

  // ③ 窗口内但要满足补话间隔（防立刻连发）
  if (st.lastSpokeAt && now - st.lastSpokeAt < minGapMs) {
    return { act: false, why: `距我上次发言 ${Math.round((now - st.lastSpokeAt) / 1000)}s < ${c.minGapSec}s`, age, windowClosedNow: false, newWindow }
  }
  // ④ 冷却中（原路径命中后设的）→ 不接，避免两条路径叠在一起连着说话
  if (now < st.cooldownUntil) {
    return { act: false, why: `冷却中（剩 ${((st.cooldownUntil - now) / 60000).toFixed(0)}min）`, age, windowClosedNow: false, newWindow }
  }
  // ⑤ 每小时限频
  if (!followRateOk(st, now)) {
    return { act: false, why: `本小时已补 ${st.followHits?.length ?? 0}/${c.maxPerHour} 次`, age, windowClosedNow: false, newWindow }
  }
  // ⑥ 单个窗口内的补话上限
  const chain = st.followChain ?? 0
  if (chain >= (c.maxFollowUps ?? 3)) {
    return { act: false, why: `本窗口已补 ${chain} 轮，到上限 ${c.maxFollowUps}`, age, windowClosedNow: false, newWindow }
  }
  return { act: true, age, windowClosedNow: false, newWindow }
}

async function chatFollowTick () {
  const c = chatFollowCfg()
  if (c.enabled === false) return
  const pc = proactiveCfg()
  if (pc.enabled === false) return          // 总开关关掉就都不跑
  const win = proactiveWindow()
  if (win.skip) return                      // 静默时段：不打扰（跟原路径同一套时段闸）
  const candidates = proactiveCandidates()  // 复用同一批白名单 peer
  if (!candidates.length) return
  const now = Date.now()

  for (const { peerKey, peer } of candidates) {
    const st = proactiveState(peerKey)
    if (!st) continue
    const d = chatFollowDecision(st, now, c)
    if (d.windowClosedNow) {
      saveState()
      logger.log(`chatFollow[${peerKey}] 窗口已关闭（对方最后发言 ${Math.round(d.age / 60000)}min 前），交给 20min 概率路径`)
    }
    if (d.newWindow) {
      saveState()
      logger.log(`chatFollow[${peerKey}] 新窗口打开（他又说话了，age=${Math.round(d.age / 1000)}s），本窗口补话计数清零`)
    }
    if (!d.act) {
      if (d.why) logger.debug(`chatFollow[${peerKey}] 跳过：${d.why}`)
      continue
    }
    const chain = st.followChain ?? 0

    // ⑦ 忙就别插话
    if (busy.has(peerKey)) continue

    logger.log(`chatFollow[${peerKey}] 窗口内触发：对方最后发言 ${Math.round(d.age / 60000)}min 前（窗口 ${c.silentMin}min 内），继续聊当前话题`)
    const spoke = await chatFollowSpeak(peerKey, peer)
    if (spoke) {
      noteFollowHit(st, now)
      st.followChain = chain + 1
      st.lastSpokeAt = Date.now()
      st.lastProactiveAt = Date.now()
      // 不设 cooldownUntil：窗口内本来就是「说几句」，加冷却会退化成严格一问一答。
      // 防刷屏靠 maxPerHour + minGapSec + maxFollowUps 三道闸。
      logger.log(`chatFollow[${peerKey}] 已补一句（本小时第 ${st.followHits.length}/${c.maxPerHour} 次，本窗口第 ${st.followChain}/${c.maxFollowUps} 轮）`)
    } else {
      st.lastEmptyAt = Date.now()
      st.empties = (st.empties ?? 0) + 1
      logger.log(`chatFollow[${peerKey}] 模型判断这会儿不用补（空转累计 ${st.empties}）`)
    }
    saveState()
  }
}

/**
 * 让模型判断「这话题要不要再补一句」，并真的发出去。
 *
 * 与原路径 proactiveSpeak 的根本区别（别混）：
 *   · 这条在**窗口内**、话题**还在进行中** → prompt 只允许「顺着当前话题补话」
 *   · 原路径在**窗口外**、话题已凉 → 那才是「找新话题/起话头」
 * 用户举的例子（「今天好累啊」→「咋了」→「遇到糟心事了吗」）是第一类的典型。
 *
 * 返回 true = 真的发了；false = 模型选择空转。
 */
/**
 * 「接话 / 主动搭话 / 戳一戳」三条主动路径共用的简化出站流水线。
 *
 * 为什么需要：这三处原来各自复制了一遍
 *   提取 [RECALL] → 提取 [SEND_FILE] → 提取 [VOICE] → 逐条发送
 * 的代码（约 15 行 × 3 份）。它们和 handleInbound 里那条完整流水线
 * （deliverReply：还带精力截断、短句拆分、打字延迟、风格记账、好感度打卡）
 * 不是一回事 —— 主动路径不该记风格样本，也不该被精力上限截断。
 * 所以这里抽出的是那三份**相同**的部分，行为保持一致：
 *   - 先撤（失败不阻塞后续发送）
 *   - 只发剩下的正文/图片/语音/戳
 *   - 什么都没剩 → sent:false（调用方自己决定是「空转」还是「只剩撤回标记」）
 *
 * @returns {Promise<{sent:boolean, textForSend:string}>}
 */
async function dispatchOutbound (peer, rawBody, { tag = 'outbound' } = {}) {
  const { specs: recalls, text: noRecallBody } = extractRecalls(String(rawBody || ''))

  // [POKE:qq] 是独立动作，先剥掉（正文里不该出现）
  const pokes = []
  POKE_RE.lastIndex = 0
  const afterPoke = noRecallBody.replace(POKE_RE, (_all, qq, scope) => {
    pokes.push({ qq, scope })
    return ''
  }).trim()

  const { files, text: plain } = extractSendFiles(afterPoke)

  // [VOICE:文字:音色] 也是独立动作
  const voices = []
  VOICE_RE.lastIndex = 0
  const textForSend = plain.replace(VOICE_RE, (_all, vtext, vchar) => {
    voices.push({ text: String(vtext).trim(), character: vchar || null })
    return ''
  }).trim()

  if (!textForSend && !files.length && !voices.length && !pokes.length) {
    return { sent: false, textForSend }
  }

  // 先撤：让「撤掉上一句 + 重发」在同一轮里完成
  for (const idx of recalls) {
    try { await performRecall(peer, idx) } catch (err) { logger.log(`[RECALL] ${tag}撤回异常: ${err.message}`) }
  }
  if (textForSend) await sendTextTo(peer, textForSend)
  for (const f of files) {
    const abs = path.isAbsolute(f) ? f : path.resolve(config.dsh.cwd, f)
    await sendImageTo(peer, abs)
  }
  for (const v of voices) await sendVoiceTo(peer, v.text, v.character)
  for (const k of pokes) {
    await sendPokeTo(peer, k.qq, k.scope === 'c2c' ? 'c2c' : undefined)
    await sleep(300)
  }
  return { sent: true, textForSend }
}

async function chatFollowSpeak (peerKey, peer) {
  if (busy.has(peerKey)) return false
  busy.add(peerKey)
  try {
    const persona = readPersona()
    const st = proactiveState(peerKey)
    const c = chatFollowCfg()
    const silentMin = Math.round((Date.now() - (st?.lastUserMsgAt ?? Date.now())) / 60000)
    const memDigest = readMemoryDigest()
    const lines = [
      persona.text ? `【人设】未变化，仍以 ${PERSONA_PATH} 为准（需要复查就 read 该文件）。` : `【人设文件缺失】${PERSONA_PATH}`,
      '',
      `【这是「接着刚才的话头再说一句」，不是新开一个话题】`,
      `你在私聊（QQ号 ${peerKey.slice(4)}）里。他上一次说话是 ${silentMin} 分钟前。`,
      '',
      '**注意现在的情况**：你们正在一个**还没聊完的话题**里。他没回你，不是因为话题结束了，',
      '而是聊天本来就长这样 —— 这边说几句，那边再说几句，不用每句都等回复。',
      '',
      '【你要做的】顺着**刚才那个话题**往下说一句（或两句）。比如：',
      '  - 他刚才说「今天好累啊」→ 你可以先「咋了」，再说「遇到糟心事了吗」',
      '  - 他刚才在讲一件事 → 追问细节、说你的看法、或者接一个相关的反应',
      '',
      '【不要做的】**重要**：',
      '  - **不要开新话题** —— 那不是现在该干的事，现在聊的事还没完',
      '  - 不要问「你在吗」「还在吗」「怎么不说话了」',
      '  - 不要复述他刚才说过的话',
      '  - 不要长篇，一两句就够（本来就是随口说）',
      '',
      '【什么时候输出 [SILENT]】',
      '  - 刚才那个话题确实已经收尾了，没有能自然接下去的话',
      '  - 或者你觉得这会儿不该说话',
      '  但**别轻易用** —— 真人聊天里顺着自己上一句再补一句是很自然的。',
      '',
      memDigest ? `【你的记忆摘要】\n${memDigest}` : '',
      `你的 QQ 号：${gateway.selfId ?? '未知'}`,
      `【硬约束】[SEND_FILE] 只放行会话工作区与暂存目录内的文件；要发图走 qq-meme skill。`,
    ].filter(x => x !== '')
    const { text } = await dsh.prompt(peerKey, [{ type: 'text', text: lines.join('\n') }])
    const silent = /\[SILENT\]/i.test(text || '')
    const body = (text || '').replace(/\[SILENT\]/gi, '').trim()
    if (silent || !body) {
      logger.log(`chatFollow[${peerKey}] 模型选择不出声`)
      return false
    }
    // 复用共用出站流水线（图片/语音/戳 都支持；撤回也照常剥）
    const { sent } = await dispatchOutbound(peer, body, { tag: '接话' })
    if (!sent) {
      logger.log(`chatFollow[${peerKey}] 只剩撤回标记，无正文可发`)
      return false
    }
    logger.log(`chatFollow[${peerKey}] 已接着补一句：${JSON.stringify(body.slice(0, 60))}`)
    return true
  } catch (err) {
    logger.log(`chatFollow[${peerKey}] 出错: ${err.message}`)
    return false
  } finally {
    busy.delete(peerKey)
    // 主动/接话轮占着 busy 期间到达的消息会被入队（不丢），但**只有** handleInbound 的
    // finally 会排空队列 —— 如果这期间只来了这一条、之后对方不再说话，它就永远躺着。
    // 所以任何释放 busy 的地方都必须顺手排空一次。
    drainPendingIngress(peerKey, peer).catch(err => logger.log(`排空队列异常 ${peerKey}: ${err.message}`))
  }
}

/**
 * 让模型自己决定是否主动开口、说什么。
 * 返回 true 表示真的发了一条（false = 空转）。
 */
async function proactiveSpeak (peerKey, peer, action) {
  if (busy.has(peerKey)) { logger.log(`proactive[${peerKey}] 忙，本轮空转`); return false }
  busy.add(peerKey)
  try {
    const persona = readPersona()
    const ps = state.peers[peerKey]
    const memDigest = readMemoryDigest()
    // 从记忆里生成候选话题线索（这是解决「没话说就空转」的关键）
    const hints = buildTopicHints(peerKey)
    const hintText = topicHintText(hints)
    if (hintText) logger.log(`proactive[${peerKey}] 话题线索: 未了结${hints.pending.length} 时间锚${hints.timeAnchor.length} 偏好${hints.preference.length}`)
    const lines = [
      persona.text ? `【人设】未变化，仍以 ${PERSONA_PATH} 为准（需要复查就 read 该文件）。` : `【人设文件缺失】${PERSONA_PATH}`,
      '',
      `【这是一次「主动开口」的机会，不是回复】`,
      `你在私聊（QQ号 ${peerKey.slice(4)}）里，对方已经 ${ps?.proactive?.lastSpokeAt ? Math.floor((Date.now() - ps.proactive.lastSpokeAt) / 60000) + ' 分钟' : '很久'} 没跟你说话了。`,
      `你自己已经安静了同样的时间。现在你可以考虑主动说一句。`,
      '',
      hintText ? `【你可以聊的线索】（从你自己的记忆里翻出来的）\n${hintText}` : '',
      '',
      '【怎么做】',
      '**优先**从上面的线索里挑一条开口，比如：',
      '  - 未了结的事 → 问一句后续（「上次说的那个事后来咋样了」）',
      '  - 时间锚 → 核对现在时间，过了就问结果，没到就提个醒',
      '  - 偏好 → 顺着他的兴趣起个话头',
      '',
      '**线索都用完了**（或者根本不合适）→ 就自己想一个：',
      '  - 你最近在想/在学/刚知道的事（B站看到的梗、查到的东西）',
      '  - 他以前说过但你当时没深问的',
      '  - 一件小事、一个疑问、一句随口的感想都行',
      '',
      '**什么时候才该空转**：',
      '  - 你确实连一个像样的话头都想不出来（这很少见，通常总有点什么可说）',
      '  - 或者现在这个时间点开口明显不合适（比如深夜他可能在睡）',
      '  - 空转就只输出 `[SILENT]`。**但别轻易用**——你已经有段时间没说话了。',
      '- 私聊没有每日上限，但别刷屏；发一条就够',
      '- 格式不限（文字/图/语音按平时分寸），不为了刷存在感硬发',
      '',
      memDigest ? `【你的记忆摘要】\n${memDigest}` : '',
      `你的 QQ 号：${gateway.selfId ?? '未知'}`,
      `【硬约束】[SEND_FILE] 只放行会话工作区与暂存目录内的文件；要发图走 qq-meme skill。`,
    ].filter(x => x !== '')
    // 主动搭话复用**同一个**会话（peerKey），不另开 `:proactive` 分身。
    // 曾经用过 peerKey+':proactive'，后果：① state 里多出一个 turns=0 的僵尸键
    // ② ACP 每次都要新建会话，Session 目录无限膨胀 ③ 它看不到正常对话的上下文，
    //   主动开口时容易说出「我们刚才说到哪来着」这种失忆话。
    const { text } = await dsh.prompt(peerKey, [{ type: 'text', text: lines.join('\n') }])
    const silent = /\[SILENT\]/i.test(text || '')
    const body = (text || '').replace(/\[SILENT\]/gi, '').trim()
    if (silent || !body) {
      logger.log(`proactive[${peerKey}] 模型选择不出声`)
      return false
    }
    // 复用共用出站流水线（图片/语音/戳 都支持）
    // 撤回标记在主动搭话里也支持：剥掉标记 → 先撤 → 再发（同正常回复顺序）
    const { sent } = await dispatchOutbound(peer, body, { tag: '主动搭话' })
    if (!sent) {
      logger.log(`proactive[${peerKey}] 只剩撤回标记，无正文可发`)
      return true
    }
    logger.log(`proactive[${peerKey}] 已主动发出（${action}）：${JSON.stringify(body.slice(0, 60))}`)
    return true
  } catch (err) {
    logger.log(`proactive[${peerKey}] 出错: ${err.message}`)
    return false
  } finally {
    busy.delete(peerKey)
    // 同上：释放 busy 后必须排空这期间入队的消息，否则「主动开口期间来的消息」会一直躺着
    drainPendingIngress(peerKey, peer).catch(err => logger.log(`排空队列异常 ${peerKey}: ${err.message}`))
  }
}

// ── 记忆读取与注入（digest + 按人跨通道检索）────────────────────────────────
// 这一整段是「模型这轮能看到哪些以前的记忆」的唯一来源，测试靠这两个注释锚点抠源码求值
// （test/memory-cross-channel.test.mjs），锚点改了测试会直接报错，不会静默失配。
// ── 新话题联想（给主动搭话用）──────────────────────────────────────────────
// 为什么需要：实测「保底 → 模型没话说 → 空转」的死循环（2026-10-26）。
// 光给记忆摘要不够——摘要告诉他「发生过什么」，但没告诉他「可以聊什么」。
// 所以这里主动从记忆里**生成候选话题线索**，按三类组织：
//   ① 未了结的事（他提过但没后续 / 我答应过但没做）
//   ② 时间锚（他提过某个日期/时间，可能已经到点了）
//   ③ 他的偏好/雷点（可以顺着偏好的方向起话题，避开雷点）
// 这些是**线索不是答案**，模型自己决定用不用、怎么说。
const TOPIC_PATTERNS = {
  pending: /(待办|还没|未完成|答应|承诺|一会儿|稍后|回头|下次|等我|等我忙完|打算|计划|想加|要加|TODO)/i,
  timeAnchor: /(明天|后天|下周|周[一二三四五六日]|\d{1,2}[月日]|\d{1,2}[:：]\d{2}|\d{1,2}点)/,
  preference: /(喜欢|讨厌|偏好|习惯|爱|不爱|雷|别|不要|受不了)/,
}

function buildTopicHints (peerKey, limit = 6) {
  const out = { pending: [], timeAnchor: [], preference: [] }
  try {
    // 阶段二：优先走「按人跨通道检索」——主动搭话的候选 peer 都是私聊（c2c），
    // 所以 in_group=false、speaker=对端 QQ（私聊里发言人就等于对端）。
    // 这样他在群里说过的事也能变成搭话线索，不必只翻私聊那一节。
    // 拿不到（python 挂了/库不在）→ 退回老 CLI recall，行为跟改动前一致。
    let texts = []
    const scope = peerKey.split(':')[0]
    const qq = scope === 'c2c' ? peerKey.slice(4) : ''
    const rows = crossChannelRecall(peerKey, { speaker: qq, inGroup: scope !== 'c2c', top: 30 })
    if (rows) {
      texts = rows.map(r => String(r?.text ?? '')).filter(Boolean)
    } else {
      // 兜底路径：跨通道检索不可用时退回老 CLI recall。
      // 插件化：走 memoryCli() 统一构造（插件版是 run.py 包 shell，脚本版直接跑 memctl.py）。
      // 原来这里 `if (!fs.existsSync(memctl)) return out` 是**静默**退出 —— 缺文件时
      // 拓扑线索就这么没了，日志里一个字都没有。现在缺文件会 warn（见 memoryHealth）。
      if (!fs.existsSync(MEMORY_PATHS.script) && !fs.existsSync(MEMORY_PATHS.runner)) {
        memoryWarnOnce('topic-hints', `记忆脚本缺失（${MEMORY_PATHS.script} / ${MEMORY_PATHS.runner}），拓扑线索不可用`)
        return out
      }
      const cli = memoryCli('memctl', ['recall', '--peer', peerKey.replace(':', '-'), '--top', '30'])
      const py = execFileSync(cli.bin, cli.args,
        { encoding: 'utf8', timeout: 15000 })
      for (const line of String(py).split('\n')) {
        const m = /^\[[\d.]+\]\s+\((\w+),[^)]*\)\s+(.*)$/.exec(line.replace(/\r$/, ''))
        if (m) texts.push(m[2].trim())
      }
    }
    for (const text of texts) {
      if (!text || text.length < 8) continue
      if (TOPIC_PATTERNS.pending.test(text) && out.pending.length < limit) out.pending.push(text)
      else if (TOPIC_PATTERNS.timeAnchor.test(text) && out.timeAnchor.length < limit) out.timeAnchor.push(text)
      else if (TOPIC_PATTERNS.preference.test(text) && out.preference.length < limit) out.preference.push(text)
    }
  } catch (err) {
    // 拿不到线索不算错 —— 主动搭话照常进行，只是少点灵感
    logger.log(`topicHints 读取失败（不影响搭话）: ${String(err.message).slice(0, 80)}`)
  }
  return out
}

/** 把话题线索拼成 prompt 片段 */
function topicHintText (hints) {
  const parts = []
  const fmt = (arr, title, tip) => {
    if (!arr.length) return
    parts.push(`【${title}】`)
    for (const t of arr.slice(0, 4)) parts.push(`  - ${t.slice(0, 80)}`)
    if (tip) parts.push(`  ${tip}`)
  }
  fmt(hints.pending, '未了结的事（可以问后续）', '答应过/提过但没下文的，问一句很自然。')
  fmt(hints.timeAnchor, '有时间标记的事（可能到点了）', '核对当前时间：过了就问结果，没到别抢跑。')
  fmt(hints.preference, '他的偏好和雷点', '顺着偏好起话题；雷点避开，别主动踩。')
  return parts.join('\n')
}

function readMemoryDigestFor (peerKey) {
  try {
    // 路径走 MEMORY_PATHS（可被 config.memory.digestPath 覆盖，见 CONTRIBUTING §9）。
    // MEMORY_PATHS 在本文件更靠后定义，但这里只在运行时被调用，不存在 TDZ 问题。
    const p = MEMORY_PATHS.digest
    if (!fs.existsSync(p)) return ''
    const raw = fs.readFileSync(p, 'utf8')
    // peerKey 形如 c2c:1000000001 / group:2000000001 → 节名 c2c-1000000001 / group-2000000001
    const sectionKey = peerKey.replace(':', '-')
    const lines = raw.split('\n')
    let out = []
    let inSection = false
    for (const line of lines) {
      if (line.startsWith('## ')) {
        // 进入新的节
        inSection = line.slice(3).trim() === sectionKey
        if (inSection) out.push(line)
        continue
      }
      if (inSection) out.push(line)
    }
    const text = out.join('\n').trim()
    if (!text) return ''
    return text.length > 1200 ? text.slice(0, 1200) + '\n…（截断）' : text
  } catch { return '' }
}

/** 读记忆摘要（吉祥物自己维护的 memory/digest.md），读不到就返回空。 */
function readMemoryDigest () {
  try {
    const p = MEMORY_PATHS.digest
    if (!fs.existsSync(p)) return ''
    const raw = fs.readFileSync(p, 'utf8').trim()
    return raw.length > 3000 ? raw.slice(0, 3000) + '\n…（截断）' : raw
  } catch { return '' }
}

// ── 按人跨通道记忆检索（阶段二：把记忆层 v4 接进桥）────────────────────────
// 为什么（真实缺口）：记忆原来按「会话」分抽屉 —— c2c-1000000001 和 group-2000000001
// 互不相通，同一个人在私聊说过的事，群里聊天时想不起来。记忆层 v4 已经做好
// `recall_with_visibility()`（跨 c2c/group 按 owner 归集 + 按场景过滤 dm_only），
// 但桥一直还在调老的 `recall()`，所以跨通道**实际没生效**。这里把它接上。
//
// 三个语义（别混）：
//   owner      这条记忆属于谁（QQ 号）。群聊记忆 = 发言人 QQ，所以**必须拿到发言人**。
//   in_group   场合。群聊 → true（过滤 visibility='dm_only'，别当众说私聊的事）；
//              私聊 → false（私下说的当然能提）。NULL 未标注在两种场景都当 public。
//   speaker    群聊场景下由桥把发言人 QQ 传进去，否则群里的记忆归不到人头上。
//
// 为什么不用 `memctl.py recall-person` CLI：那条走 `recall_for_person()`，
// **没有 include_peer_context** —— 会丢掉群里 owner=NULL 的群级记忆（reflect 群摘要等，
// 生产库实测 35 条）。丢了它们，「头像」「B站」这类群级知识会整段退化。
// 所以这里用内联小脚本调 `recall_with_visibility(include_peer_context=True)`。
// ⚠️ 不改 memctl.py：阶段一刚做完、有测试保护，桥只做**调用方**。
//
// 降级（硬要求）：python 出错 / 超时 / 库不在 / memctl.py 被改坏 → 一律静默退回
// 只注入 digest.md（= 改动前的老行为）。记忆检索是锦上添花，绝不能拖死这轮回复。
const MEMORY_PATHS = (() => {
  // 路径全部可被 config 覆盖 —— 不是为了灵活，是 CONTRIBUTING §9 的硬规矩：
  // 测试会真起一份 index.js，改变不了 dsh.cwd，只能靠 config 把落盘/读取路径引开。
  //
  // 🔴 插件化改动（P0b）：**代码目录**和**数据目录**分开了。
  //   脚本版里 memctl.py 和 mem.db 躺在同一个 memory/ 下；插件里这两件事必须拆：
  //     代码 → npm 包内 lib/agent/memory/（只读，随版本升级）
  //     数据 → <dataDir>/memory/（可写，npm uninstall 不删记忆；旧目录自动迁移）
  //   用户已确认走 stateDir，不再用 dsh.cwd/memory（那目录会随包/配置变）。
  //
  //   所以：
  //     dir     = **数据目录**（默认由 lib/index.js 的 bridgeConfig() 传 stateDir）
  //     codeDir = 代码目录（默认 = script 所在目录，双布局自动成立）
  //     runner  = 包内 run.py（launcher：import 包内 py，把落盘路径改到 stateDir）
  //     py      = 插件探测出的解释器（配置优先，否则 python3）
  //
  //   runner 为空时**完全退回老行为**（直接 execFileSync(py, [script, ...])）——
  //   那是测试/脚本版的路径，绝不能让插件化改动把它打破。
  const dir = config.memory?.dir ?? path.join(config.dsh.stateDir ?? config.dsh.cwd, 'memory')
  const script = config.memory?.memctl ?? path.join(dir, 'memctl.py')
  return {
    dir,
    db: config.memory?.db ?? path.join(dir, 'mem.db'),
    digest: config.memory?.digestPath ?? path.join(dir, 'digest.md'),
    script,
    // 代码目录：inline python 要 sys.path.insert 到这里才 import 得到 memctl
    codeDir: config.memory?.codeDir ?? path.dirname(script),
    runner: config.memory?.runner ?? '',
    // Windows 上没有 python3.exe（官方安装器只给 python.exe，Store 版给 python3.exe 但
    // 不在 PATH 里常驻）。原来写死 'python3' → spawn ENOENT → 跨通道记忆**静默 0 条**，
    // 日志里只有一行 execFileSync 失败，用户完全看不出「记忆功能没在跑」。
    py: config.memory?.pythonBin || (process.platform === 'win32' ? 'python' : 'python3'),
  }
})()

/**
 * 构造一次 memory CLI 调用（统一入口，别在各处硬写 python3）。
 *
 * 两种布局：
 *   · 插件版 → [py, run.py, <tool>, ...args]（run.py 负责把数据路径指到 stateDir）
 *   · 脚本/测试 → [py, memctl.py, ...args]（直接跑，不需要 launcher）
 * 返回 { bin, args }，调用方自己 execFileSync。
 */
function memoryCli (tool, args, { py = null } = {}) {
  const bin = py || MEMORY_PATHS.py
  if (MEMORY_PATHS.runner && fs.existsSync(MEMORY_PATHS.runner)) {
    return { bin, args: [MEMORY_PATHS.runner, tool, ...args] }
  }
  // 老布局：工具名 → 具体脚本文件
  const map = {
    memctl: MEMORY_PATHS.script,
    stylebank: STYLE_ROOTS.script,
    lexicon: LEXICON_ROOTS.script,
  }
  return { bin, args: [map[tool] ?? MEMORY_PATHS.script, ...args] }
}

// ── 降级可见性（P0b 的核心：把「静默」改成「warn」）─────────────────────────
// 问题（用户实测的原始描述）：插件版有 10 处调 memctl.py，但包里没这个文件，
// 缺文件时 `if (!fs.existsSync(...)) return` 静默退出 → **记忆功能看起来开着、
// 实际是空的**，用户以为记忆坏了却查不到任何线索。
//
// 为什么不是「每处都改成 logger.warn」：热路径（每轮回复都调）刷屏比静默更糟
// —— 一天几千行 WARN 会让真正重要的错误被埋掉。所以：
//   · **同一个原因只 warn 一次**（memoryWarnOnce，key 去重）
//   · 状态从「这一轮能不能用」升级成**持久可见**：写进日志 + 通过 localStatus 上报
//     （设置页「记忆」卡片三态读它）
const memoryWarned = new Set()
function memoryWarnOnce (key, msg) {
  if (memoryWarned.has(key)) return
  memoryWarned.add(key)
  logger.warn(`memory: ${msg}`)
}

/**
 * 记忆能力的健康快照（设置页/本地 API 用；也用于启动日志）。
 *
 * 三态语义（照 PLUGINIZATION-PLAN 的验收要求）：
 *   ok      → python 在、脚本在、库能打开
 *   degraded → 有 python 但缺东西（库还没建 / 脚本缺失），功能部分可用
 *   off     → 没有 python / memory.enabled=false，功能关闭
 */
function memoryHealth () {
  const scriptOk = fs.existsSync(MEMORY_PATHS.runner) || fs.existsSync(MEMORY_PATHS.script)
  // 库不存在**不是**错误：memctl 的 CREATE TABLE IF NOT EXISTS 会建它（首次启动就该这样）。
  // 但**代码**不存在是硬错误 —— 那说明包不完整（正是「假开」的根源）。
  const dbExists = fs.existsSync(MEMORY_PATHS.db)
  const py = MEMORY_PATHS.py
  let pyOk = false
  let pyVersion = null
  if (MEMORY_CC.enabled) {
    try {
      // 复用探测结果（config.memory.pythonVersion 由插件 lib/index.js 探测后传入），
      // 拿不到才真起一次（只在启动时调一次健康检查，不在热路径）。
      if (config.memory?.pythonOk === true) { pyOk = true; pyVersion = config.memory?.pythonVersion ?? null }
      else if (config.memory?.pythonOk === false) pyOk = false
      else {
        const out = execFileSync(py, ['-c', 'import sys;print("%d.%d"%sys.version_info[:2])'],
          { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
        pyVersion = String(out).trim()
        pyOk = true
      }
    } catch { pyOk = false }
  }
  const on = MEMORY_CC.enabled
  const state = !on ? 'off' : (!pyOk || !scriptOk) ? 'off' : (dbExists ? 'ok' : 'degraded')
  return {
    state,
    enabled: on,
    python: { bin: py, ok: pyOk, version: pyVersion },
    code: { dir: MEMORY_PATHS.codeDir, present: scriptOk, runner: MEMORY_PATHS.runner || null },
    data: { dir: MEMORY_PATHS.dir, db: MEMORY_PATHS.db, dbExists },
    // 给设置页一句人话
    detail: state === 'ok' ? '记忆已就绪'
      : state === 'degraded' ? '记忆可用（库还是空的，攒到消息后自动建表）'
        : !on ? '记忆已关闭（memory.enabled=false）'
          : !pyOk ? `记忆不可用：没找到可用的 python（${py}）`
            : '记忆不可用：插件包内记忆脚本缺失（安装不完整？请重装插件）',
  }
}

/**
 * 启动时把记忆健康状态打进日志（**这是「假开变真开」的可验证证据**）。
 * 有 python + 脚本在 → 明确说「记忆功能完整」，而不是什么都不打。
 */
function logMemoryHealth () {
  const h = memoryHealth()
  if (h.state === 'ok') {
    logger.log(`memory: 记忆功能已启用（${MEMORY_PATHS.py} · 代码 ${MEMORY_PATHS.codeDir} · 数据 ${MEMORY_PATHS.dir} · 库${h.data.dbExists ? '已有' : '还没有，首条消息后自动建'})`)
  } else if (h.state === 'degraded') {
    logger.log(`memory: ${h.detail}（${MEMORY_PATHS.dir}）`)
  } else {
    // off 状态必须是 warn：这正是原来静默的那一种
    logger.warn(`memory: ${h.detail}`)
  }
  return h
}

const MEMORY_CC = {
  // 总开关：memory.enabled=false 或 memory.crossChannel.enabled=false 都关掉跨通道检索，
  // 桥退回老行为（只用 digest）。测试和排障都需要一个明确的 off 开关。
  enabled: config.memory?.enabled !== false && config.memory?.crossChannel?.enabled !== false,
  top: config.memory?.crossChannel?.top ?? 8,
  // 单轮预算：实测 700 条库 68ms，2.5s 已经是 30 倍余量。超时宁可不要记忆，不拖慢回话。
  timeoutMs: config.memory?.crossChannel?.timeoutMs ?? 2500,
  maxCharsPerRow: config.memory?.crossChannel?.maxCharsPerRow ?? 110,
  maxBlockChars: config.memory?.crossChannel?.maxBlockChars ?? 900,
  // 相关性门槛 + 条数上限（防「话题磁铁」，见 memoryRecallBlock 里注释）
  //
  // ⚠️ 门槛定太高的代价（实测）：minScore=0.15 + maxRows=4 会连**相关**的记忆一起丢。
  //    比如用户说「上次说的那件欠钱的事」，dm_only 那条因为 score 偏低被过滤掉了——
  //    而这恰恰是最该被想起的东西。
  //    实测 score 分布有**巨大断层**：相关记忆 0.95+，不相关的全在 0.09 附近。
  //    候选门槛扫描（7 个 query）：0.02→磁铁5条/总91；0.15→磁铁2条/总64；0.30→磁铁更少。
  //
  //    最终选 0.15，不是 0.30：0.30 在**小数据集**（测试造 10 条库）上会把真相关的也滤掉，
  //    因为 BM25 查询内归一化在候选集很小时分数被压低。宁可留 2 条噪音，也不丢相关记忆。
  //    （磁铁从 5 降到 2，已经解决主要问题；剩下 2 条由 digest 预算 420 字兜住。）
  minScore: config.memory?.crossChannel?.minScore ?? 0.15,
  maxRows: config.memory?.crossChannel?.maxRows ?? 6,
  maxDigestChars: config.memory?.crossChannel?.maxDigestChars ?? 420,
}
/** 缓存：peer+sender+场景+查询 在 15 秒内复用（同一句话被连发时不重复起 python）。 */
const memoryCcCache = new Map()

// 内联 python：只 import + 调一次，结果以 JSON 打出来。
//   in_group='1' → 群聊场景（recall_with_visibility 内部过滤 dm_only）
//   库用 mode=ro 打开 → 物理上不可能写生产库（CONTRIBUTING §9 的对冲）
//   sys.dont_write_bytecode → 不在生产 memory/ 里留 __pycache__（会脏工作树）
const MEMORY_CC_PY = [
  'import json,sqlite3,sys,urllib.parse',
  'sys.dont_write_bytecode=True',
  // ⚠️ 第一个参数现在是**代码目录**（codeDir），不是数据目录 dir：
  //    插件里 py 在包里、库在 stateDir，要分别取（原来两者同一个目录才写得对）。
  'dirp,db,peer,qq,query,top,in_group=sys.argv[1:8]',
  'sys.path.insert(0,dirp)',
  'import memctl as m',
  "conn=sqlite3.connect('file:%s?mode=ro'%urllib.parse.quote(db,safe='/'),uri=True)",
  'conn.row_factory=sqlite3.Row',
  'rows=m.recall_with_visibility(conn,peer or None,query or None,int(top),'
    + "in_group=(in_group=='1'),speaker=qq or None,include_self=False)",
  'print(json.dumps({"ok":True,"rows":[{"peer":r["peer"],"kind":r["kind"],'
    + '"visibility":r["visibility"],"text":r["text"],"score":round(float(_s),4)} for _s,r in rows]},ensure_ascii=False))',
].join('\n')

/**
 * 跨通道按人检索一次。返回 rows 数组；任何失败返回 null（调用方负责降级）。
 *
 * @param {string} peer      桥的 peerKey（如 group:2000000001）
 * @param {object} opts
 * @param {string} [opts.speaker]  发言人 QQ（群聊必需；私聊可省，由 peer 推断）
 * @param {boolean} opts.inGroup   场合：群聊 true / 私聊 false
 * @param {string} [opts.query]    当前这条消息（当查询词，让检索贴题）
 * @param {number} [opts.top]
 */
function crossChannelRecall (peer, opts = {}) {
  if (!MEMORY_CC.enabled) return null
  const peerDbKey = String(peer).replace(':', '-')
  const qq = opts.speaker != null && String(opts.speaker).trim() ? String(opts.speaker).trim() : ''
  const inGroup = opts.inGroup === true
  const query = String(opts.query ?? '').replace(/\s+/g, ' ').trim().slice(0, 300)
  const top = Math.max(1, Math.min(30, opts.top ?? MEMORY_CC.top))
  // 自检：脚本/库不存在就别起进程了。
  // 插件化：脚本在**包内**（MEMORY_PATHS.script 指向数据目录那份是不存在的），
  // 真正的入口是 run.py；只要它能跑就不算缺。库不存在 = 还没攒到记忆，是正常状态。
  if (!fs.existsSync(MEMORY_PATHS.runner) && !fs.existsSync(MEMORY_PATHS.script)) return null
  if (!fs.existsSync(MEMORY_PATHS.db)) return null
  const cacheKey = [peerDbKey, qq, inGroup ? 1 : 0, top, query].join('\u0001')
  const hit = memoryCcCache.get(cacheKey)
  if (hit && Date.now() - hit.at < (config.memory?.crossChannel?.cacheTtlMs ?? 15000)) return hit.rows
  try {
    // 解释器用 MEMORY_PATHS.py（插件探测结果；脚本版默认 python3，行为不变）
    const out = execFileSync(MEMORY_PATHS.py, [
      '-c', MEMORY_CC_PY,
      MEMORY_PATHS.codeDir, MEMORY_PATHS.db, peerDbKey, qq, query,
      String(top), inGroup ? '1' : '0',
    ], {
      encoding: 'utf8',
      timeout: MEMORY_CC.timeoutMs,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, PYTHONIOENCODING: 'utf8' },
    })
    const parsed = JSON.parse(String(out).trim().split('\n').pop())
    const rows = Array.isArray(parsed?.rows) ? parsed.rows : []
    memoryCcCache.set(cacheKey, { at: Date.now(), rows })
    if (memoryCcCache.size > 200) memoryCcCache.delete(memoryCcCache.keys().next().value)
    return rows
  } catch (err) {
    // 超时 / python 挂了 / memctl.py 被改坏 / 库坏了 —— 全都到这里，降级为「只用 digest」。
    //
    // 🔴 为什么要区分两种失败（P0b）：
    //   `ENOENT`（找不到解释器/脚本）= **环境缺东西**，不是这次的偶发问题。
    //   这种必须 warn 一次并被看见 —— 原来一律 debug，正是「假开」表现为
    //   「记忆看起来开着、实际是空的」的直接原因。
    //   而超时/库坏是**这一轮**的失败，下轮可能就好了 → 保持 debug（不刷屏）。
    const code = err?.code || ''
    if (code === 'ENOENT' || /not found|找不到|cannot find/i.test(String(err?.message || ''))) {
      memoryWarnOnce('cc-enoent', `跨通道检索的 python/脚本不存在（${MEMORY_PATHS.py} / ${MEMORY_PATHS.runner || MEMORY_PATHS.script}），记忆检索不可用`)
    } else {
      logger.debug(`memory 跨通道检索失败（本轮只用 digest）: ${String(err.message).slice(0, 100)}`)
    }
    return null
  }
}

/**
 * 拼「你记得的事」块：digest 的本人 section + 按人跨通道检索到的记忆。
 *
 * 为什么两段都留：digest 是**按 peer 分节**的汇总（群级背景、我的程序记忆都在里面），
 * 跨通道检索补的是「这个人在别的通道说过、原 peer 节里没有」的部分。两者互补。
 * 返回值 '' = 什么都不注入。
 */
function memoryRecallBlock (peerKey, { speaker = '', inGroup = false, query = '' } = {}) {
  const digest = readMemoryDigestFor(peerKey)
  const rows = crossChannelRecall(peerKey, { speaker, inGroup, query })
  const parts = []
  if (rows && rows.length) {
    // 每条前标来源通道：证明跨通道真的生效，也让模型知道「这是他在另一边说的」
    const me = String(peerKey).split(':')[0] === 'c2c' ? '私聊' : '群'
    const lines = []
    let used = 0
    // ⚠️ 2026-10-26 实测：不加相关性门槛时，不管问什么都会注入满 28 条
    //    （跨通道 8 条 + digest 20 条），其中「三点开会」那条 pin 记忆永远在里面。
    //    结果模型被它带跑：问「你嘴真毒」也回「三点开会」。
    //    所以这里按 score 过滤：低于 minScore 的丢掉，最多 maxRows 条。
    const minScore = MEMORY_CC.minScore ?? 0.15
    const maxRows = MEMORY_CC.maxRows ?? 4
    const kept = rows
      .filter(r => Number(r?.score ?? 0) >= minScore)
      .slice(0, maxRows)
    for (const r of kept) {
      const t = String(r?.text ?? '').replace(/\s+/g, ' ').trim()
      if (!t) continue
      const src = String(r?.peer ?? '')
      const chan = src.startsWith('c2c-') ? '私聊' : src.startsWith('group-') ? '群' : '记忆'
      // 只标「跟当前场合不同通道」的来源，免得每条都挂个没信息量的标签
      const tag = chan === me ? '' : `${chan}·`
      const line = `  - ${tag}${t.slice(0, MEMORY_CC.maxCharsPerRow)}`
      if (used + line.length > MEMORY_CC.maxBlockChars) break
      used += line.length
      lines.push(line)
    }
    if (lines.length) {
      parts.push(
        `【你记得的事·按人跨通道检索】（同一个人在私聊和群里的记忆合并检索，停在「${inGroup ? '群聊' : '私聊'}」场合）`,
        ...lines,
      )
    }
  }
  if (digest) {
    // digest 也要有预算：原来无上限，跟跨通道段叠加后总长能到近 900 字，
    // 大部分是不贴题的（按 importance 排，「三点开会」这种 pin 记忆永远在前）。
    const dcap = MEMORY_CC.maxDigestChars ?? 420
    const d = digest.length > dcap ? digest.slice(0, dcap) + '\n…（截断）' : digest
    parts.push('', '【你的见闻录摘要】（memory/digest.md 中本会话的部分）', d)
  }
  if (!parts.length) return ''
  parts.push('提到以前的事就照着说，不确定就别硬编。想翻更细的可以 read memory/ 下的文件。')
  if (inGroup) parts.push('（标注「私聊·」的是他在私聊里说的 —— 可以顺着聊，但别当众复述细节。）')
  return parts.join('\n')
}

// ── 自我风格样本库（人格一致性）─────────────────────────────────────────────
// 目的：让模型记得「自己在类似场合是怎么说的」，从而保持人格一致，而不是每轮换风格。
// 反复写人设没用（persona drift，https://openreview.net/forum?id=Mrz9E1EcIA），
// 有效的是给一个**风格锚**：拿当前消息检索「类似场合我的原话」，取 2-3 条进上下文。
//
// 存储是独立的 SQLite（memory/style.db，gitignore），不进 mem.db 的通用检索 ——
// 那边是「关于对方的事实」，这边是「我的说话风格」，两种检索目标不同。
// 检索算法复用 memctl.py 里那套 BM25（stylebank.py 直接 import），不另写相似度。
//
// 桥这侧只做三件事：
//   ① 记录（发送成功后，把「对方那句话 + 我实际发出去的第一条正文」追加到 jsonl）
//   ② 检索（拼 prompt 前问一次 python，拿渲染好的块）
//   ③ 兜底（python 挂了/超时/库没样本 → 一律不注入，绝不让这一轮失败）
const STYLE_ROOTS = (() => {
  // 路径都可被 config.style 覆盖 —— 不只是配置灵活性：
  // 端到端测试（recall-e2e.integration.mjs）会**真的启动一份 index.js**，它会换掉
  // persona.path / log.file / state 目录，但改变不了 dsh.cwd。如果这里硬编码
  // dsh.cwd/memory，测试就会往**生产** memory/ 里写假风格样本（实测踩到过：
  // 生产 style.db 被塞进 3 条 group:9137001123 的假数据）。
  // 所以所有落盘路径都必须可覆盖，测试才能把它们指到临时目录。
  // 插件化：数据在 stateDir（同 LEXICON_ROOTS 的理由）
  const base = config.style?.dir ?? (config.dsh.stateDir
    ? path.join(config.dsh.stateDir, 'memory')
    : path.join(config.dsh.cwd, 'memory'))
  return {
    base,
    script: config.style?.script ?? path.join(base, 'stylebank.py'),
    jsonl: config.style?.jsonl ?? path.join(base, 'style-cases.jsonl'),
    cursorDir: config.style?.cursorDir ?? path.join(config.dsh.cwd, '.bridge'),
  }
})()
const STYLE = {
  enabled: config.style?.enabled !== false,
  script: STYLE_ROOTS.script,
  jsonl: STYLE_ROOTS.jsonl,
  cursorDir: STYLE_ROOTS.cursorDir,
  n: config.style?.injectN ?? 3,
  maxChars: config.style?.maxChars ?? 60,
  recallTimeoutMs: config.style?.recallTimeoutMs ?? 4000,
  cacheTtlMs: config.style?.cacheTtlMs ?? 30000,
}
/** peerKey -> {at, block}：同一 peer 30 秒内复用检索结果（同一句话刷屏时不重复起 python） */
const styleCache = new Map()

/**
 * 该不该做（记 / 查是两个独立开关，别混）：
 *   enabled=false  → 整个功能关掉
 *   record=false   → 只停止**学习**（还在用已有样本），用来冻结风格
 * 返回非 null 时调用方直接跳过。
 */
function styleSkipReason (what = 'recall') {
  if (!STYLE.enabled) return 'disabled'
  if (what === 'record' && config.style?.record === false) return 'record-off'
  // 插件版：脚本在**包内**，配置里的 style.script 指向数据目录会不存在；
  // 只要 run.py 在就不算缺（真正决定能不能跑的是 launcher）。
  const haveScript = fs.existsSync(STYLE.script) || (MEMORY_PATHS.runner && fs.existsSync(MEMORY_PATHS.runner))
  if (!haveScript) {
    memoryWarnOnce('style-noscript', `风格库脚本缺失（${STYLE.script}），风格锚已停用`)
    return 'no-script'
  }
  return null
}

/**
 * 把一轮对话追加进风格样本来源文件（jsonl）。
 *
 * context = 触发这轮回复的那条消息（对方说了什么），my_reply = 我实际发出去的第一条正文。
 * 用 jsonl 而不是直接写 SQLite：桥是 Node、库在 Python 侧，
 * 让桥每轮起 python 进程去写库既慢又会在桥崩时丢数据；追加一行是原子的、几乎零成本，
 * python 那边按游标增量吃（stylebank.py ingest --jsonl）。
 * 过滤（<4 字、剥控制标记）放在 python 侧统一做，桥不重复实现一遍规则。
 */
function recordStyleCase (peerKey, context, reply) {
  if (styleSkipReason('record')) return
  const ctx = String(context ?? '').replace(/\s+/g, ' ').trim().slice(0, 400)
  const rep = String(reply ?? '').replace(/\s+/g, ' ').trim().slice(0, 400)
  if (!ctx || !rep) return
  try {
    const line = JSON.stringify({ peer: peerKey, context: ctx, my_reply: rep, ts: Date.now() / 1000 }) + '\n'
    fs.appendFileSync(STYLE.jsonl, line, 'utf8')
  } catch (err) {
    logger.debug(`style 记录失败（不影响对话）: ${err.message}`)
  }
}

/**
 * 检索「类似场合我上次怎么回」，返回可直接塞进 prompt 的文本块（拿不到就返回 ''）。
 *
 * 只注入**我的原话**，不注入当时的对方消息 —— 多点上下文会挤占 prompt，
 * 而且「场合」已经由当前这条消息本身表达了，锚只需要锚「我怎么说话」。
 * python 调用有硬超时（默认 4s），失败一律静默降级：风格锚是锦上添花，不是主链路。
 */
function styleAnchorBlock (peerKey, currentMessage) {
  if (styleSkipReason()) return ''
  const msg = String(currentMessage ?? '').trim()
  if (!msg) return ''
  const cached = styleCache.get(peerKey)
  if (cached && Date.now() - cached.at < STYLE.cacheTtlMs && cached.msg === msg) return cached.block
  try {
    // 插件化：走 memoryCli() 统一构造（插件版 = run.py stylebank ...，脚本版 = stylebank.py ...）
    const cli = memoryCli('stylebank', [
      'recall',
      '--peer', peerKey,
      '--query', msg.slice(0, 500),
      '--n', String(STYLE.n),
      '--max-chars', String(STYLE.maxChars),
      '--auto-ingest',
      '--jsonl', STYLE.jsonl,
      '--cursor-dir', STYLE.cursorDir,
      '--json',
    ])
    const out = execFileSync(cli.bin, cli.args,
      { encoding: 'utf8', timeout: STYLE.recallTimeoutMs, stdio: ['ignore', 'pipe', 'ignore'] })
    const res = JSON.parse(String(out).trim().split('\n').pop())
    const block = res?.injected ? String(res.block ?? '') : ''
    styleCache.set(peerKey, { at: Date.now(), msg, block })
    if (block) {
      logger.log(`style ${peerKey}: 注入 ${res.matched}/${res.total} 条风格样本`)
    } else if (res?.reason) {
      // 冷启动 / 弱匹配都是「正常不注入」，用 debug 级：不该刷屏 info 日志
      logger.debug(`style ${peerKey}: 不注入（${res.reason}，库 ${res.total} 条/命中 ${res.matched}）`)
    }
    return block
  } catch (err) {
    // 超时/库还没建/python 挂掉都走这里 —— 降级，本轮照常说话。
    // ENOENT（缺 python/缺脚本）单独 warn 一次：那是环境问题，不该静默（P0b）。
    const code = err?.code || ''
    if (code === 'ENOENT') memoryWarnOnce('style-enoent', `风格库的 python/脚本不存在（${STYLE.script}），风格锚不可用`)
    else logger.debug(`style 检索失败（不注入，不影响对话）: ${String(err.message).slice(0, 100)}`)
    return ''
  }
}

function startProactiveLoop () {
  const c = proactiveCfg()
  if (!c.enabled) { logger.log('proactive: 未启用'); return }
  if (!c.whitelist.length) { logger.log('proactive: 白名单为空，不启动'); return }
  if (proactiveTimer) clearInterval(proactiveTimer)
  proactiveTimer = setInterval(() => {
    proactiveTick().catch(err => logger.log(`proactive tick 异常: ${err.message}`))
  }, c.tickMin * 60000)
  proactiveTimer.unref?.()

  // ── 接话路径的定时器（**并行**，不替代上面那个）──────────────────────────
  // 检查频率不能跟 tickMin(20min) 一样 —— silentMin 才 10 分钟，20 分钟检查一次
  // 会把「10 分钟该判断」拖到 20 分钟，行为就钝了。所以按 min(silentMin, 5) 分钟检查一次。
  const fc = chatFollowCfg()
  if (fc.enabled !== false) {
    const everyMin = Math.max(1, Math.min(Number(fc.silentMin) || 10, 5))
    if (chatFollowTimer) clearInterval(chatFollowTimer)
    chatFollowTimer = setInterval(() => {
      chatFollowTick().catch(err => logger.log(`chatFollow tick 异常: ${err.message}`))
    }, everyMin * 60000)
    chatFollowTimer.unref?.()
    logger.log(`proactive: 接话路径已启动，每 ${everyMin}min 检查一次（只在对方最后一条消息后 ${fc.silentMin}min **窗口内**补话；窗口过了就交给 20min 概率路径，每小时上限 ${fc.maxPerHour}）`)
  } else {
    logger.log('proactive: 接话路径未启用（chatFollow.enabled=false），只用 20min 概率路径')
  }
  logger.log(`proactive: 已启动，tick=${c.tickMin}min 白名单=[${c.whitelist.join(',')}]`)
}

// ── 说话方式学习（从「别人」的语料里学词汇/梗/表情用法/句式）─────────────────────
// 三个已定的设计点（用户拍的，别改）：
//   ① 学其他人 —— 学自己由上面的 stylebank 负责（效果未证），这里只吃
//      qq-agent/memory/log/*.jsonl（群友原话）和 B站评论区楼中楼。
//   ② 单独文件存 lexicon.json —— 人可读、可 diff，且**不污染 persona.md**
//      （persona 是它自己会改的「我是谁」，词汇表是外来素材，混进去会被它下次自改冲掉）。
//   ③ 定时跑 —— scripts/learn.sh + 独立 systemd timer（每 12h，比反思低：语料更新慢）。
//      提炼要调模型、几分钟，塞进桥的对话链路会阻塞回话，所以是独立进程。
//
// 为什么不并进 stylebank.db：那是「我上次类似场合怎么说的」，
// 这里是「别人平时怎么说话的」—— 视角相反，一张表会互相稀释。
//
// 路径全可覆盖（CONTRIBUTING §9）：端到端测试能把 lexicon.json 指到临时文件，
// 保证测试绝不会往生产 memory/ 写数据。
const LEXICON_ROOTS = (() => {
  // 插件化：数据在 stateDir（默认由 bridgeConfig 传下来），不再用 dsh.cwd/memory
  const base = config.learning?.dir ?? (config.dsh.stateDir
    ? path.join(config.dsh.stateDir, 'memory')
    : path.join(config.dsh.cwd, 'memory'))
  return {
    script: config.learning?.script ?? path.join(base, 'lexicon.py'),
    json: config.learning?.json ?? path.join(base, 'lexicon.json'),
    recallTimeoutMs: config.learning?.recallTimeoutMs ?? 4000,
    // 2 分钟缓存：文件 mtime 变了才作废（定时学完自然生效），避免每轮都起 python
    cacheTtlMs: config.learning?.cacheTtlMs ?? 120000,
    // 默认 900 跟 lexicon.py 的 DEFAULT_MAX_CHARS 保持一致：
    // 渲染块尾巴那段「正经答题一个都别用」的约束是**防硬塞的关键**，
    // 预算太小会把它截掉 → 约束失效、模型又开始堆词（比不注入更糟）。
    maxChars: config.learning?.maxChars ?? 900,
    injectN: config.learning?.injectN ?? 12,
  }
})()
const lexiconCache = { at: 0, mtimeMs: -1, block: '' }

/**
 * 读 lexicon.json 渲染成可注入的上下文块；拿不到就返回 ''（静默降级）。
 *
 * 为什么不把词库直接读进桥、在 JS 里拼：渲染规则（排序、长度预算、冷启动闸）
 * 只该有一份，放在 lexicon.py 里；桥复用它，和 stylebank 走 python 是同一套理由。
 * 失败一律不注入：学来的词是锦上添花，不是主链路。
 */
function lexiconBlock () {
  try {
    if (!fs.existsSync(LEXICON_ROOTS.json)) return ''
    const st = fs.statSync(LEXICON_ROOTS.json)
    if (Date.now() - lexiconCache.at < LEXICON_ROOTS.cacheTtlMs &&
        lexiconCache.mtimeMs === st.mtimeMs) return lexiconCache.block
    const cli = memoryCli('lexicon', [
      'render',
      '--path', LEXICON_ROOTS.json,
      '--n', String(LEXICON_ROOTS.injectN),
      '--max-chars', String(LEXICON_ROOTS.maxChars),
      '--json',
    ])
    const out = execFileSync(cli.bin, cli.args,
      { encoding: 'utf8', timeout: LEXICON_ROOTS.recallTimeoutMs, stdio: ['ignore', 'pipe', 'ignore'] })
    const res = JSON.parse(String(out).trim().split('\n').pop())
    const block = res?.injected ? String(res.block ?? '') : ''
    if (block.length > LEXICON_ROOTS.maxChars) {
      // 双保险：python 侧已经控过长度，这里再兜一层，绝不让它挤占 prompt 预算
      logger.debug(`lexicon: 块过长（${block.length} > ${LEXICON_ROOTS.maxChars}），截断`)
    }
    const safe = block.length > LEXICON_ROOTS.maxChars ? '' : block
    lexiconCache.at = Date.now()
    lexiconCache.mtimeMs = st.mtimeMs
    lexiconCache.block = safe
    if (safe) logger.log(`lexicon: 注入学来的说话方式（库 ${res.total} 条）`)
    else if (res?.reason) {
      // 区分两种情况（重要）：cold-start / no-usable-entry 是**正常**的「还没学够」，
      // 用 debug；而 no-file/bad-json/bad-shape/unreadable 是**词库坏了** ——
      // 那种要能被运维看见（WARN），否则「一直不注入」会静默持续好几天。
      const broken = !['cold-start', 'no-usable-entry'].includes(res.reason)
      const msg = `lexicon: 不注入（${res.reason}，库 ${res.total} 条）`
      if (broken) logger.warn(msg)
      else logger.debug(msg)
    }
    return safe
  } catch (err) {
    // 文件不存在/半截 JSON/python 挂掉/超时都走这里 —— 不注入，本轮照常说话。
    // ENOENT 是环境问题（缺 python/缺脚本），必须 warn 一次（P0b：不许静默）。
    const code = err?.code || ''
    if (code === 'ENOENT') memoryWarnOnce('lexicon-enoent', `说话方式学习的 python/脚本不存在（${LEXICON_ROOTS.script}），词库不注入`)
    else logger.debug(`lexicon 读取失败（不注入，不影响对话）: ${String(err.message).slice(0, 100)}`)
    return ''
  }
}

// ── 模型路由故障转移 ────────────────────────────────────────────────────────
// 现象：trae/deepseek-v4.1-flash 会间歇性 `turn ended: error`（今天已 4 次）。
// 策略：连续失败 N 次 → 切到下一条备选路由；主路由冷却 probeBackMs 后探测一次，
//       成功则切回主路由。冷却期内不再反复尝试主路由，避免每轮都多花一次失败。
const ROUTE_MAIN = { provider: config.dsh.provider, model: config.dsh.model, reasoningEffort: config.dsh.reasoningEffort }
const ROUTE_FALLBACKS = (config.dsh.fallbackRoutes ?? []).filter(r => r?.provider && r?.model)
const FAILOVER = {
  enabled: config.dsh.failover?.enabled !== false && ROUTE_FALLBACKS.length > 0,
  consecutiveFailures: config.dsh.failover?.consecutiveFailures ?? 2,
  cooldownMs: config.dsh.failover?.cooldownMs ?? 300000,
  probeBackMs: config.dsh.failover?.probeBackMs ?? 180000,
}
const routeState = {
  current: { ...ROUTE_MAIN },
  fallbackIndex: -1,      // -1 = 主路由
  consecutiveFailures: 0,
  lastFailAt: 0,
  lastSwitchAt: 0,
  switches: 0,
}

function describeRoute(r) { return `${r.provider}/${r.model}` }

function noteLlmSuccess() {
  routeState.consecutiveFailures = 0
}

/** LLM 失败时调用：够次数就切到下一条可用路由。返回是否切换了。 */
async function noteLlmFailure(err) {
  routeState.consecutiveFailures += 1
  routeState.lastFailAt = Date.now()
  const msg = String(err?.message || '')
  logger.log(`LLM 失败计数 ${routeState.consecutiveFailures}/${FAILOVER.consecutiveFailures} @ ${describeRoute(routeState.current)}: ${msg.slice(0, 120)}`)
  if (!FAILOVER.enabled) return false
  if (routeState.consecutiveFailures < FAILOVER.consecutiveFailures) return false

  // 选下一条：先在备选链里往后走；走到头就回主路由（等冷却后再试）
  const nextIndex = routeState.fallbackIndex + 1
  let next
  if (nextIndex >= ROUTE_FALLBACKS.length) {
    // 所有备选都试过：冷却期过了才回主路由，否则保持在最后一条备选上
    const cooldownOver = Date.now() - routeState.lastSwitchAt > FAILOVER.cooldownMs
    next = cooldownOver ? { ...ROUTE_MAIN, kind: 'main' } : { ...ROUTE_FALLBACKS[ROUTE_FALLBACKS.length - 1], kind: 'fallback' }
  } else {
    next = { ...ROUTE_FALLBACKS[nextIndex], kind: 'fallback' }
  }

  routeState.fallbackIndex = next.kind === 'main' ? -1 : ROUTE_FALLBACKS.findIndex(r => r.provider === next.provider && r.model === next.model)
  routeState.consecutiveFailures = 0
  routeState.lastSwitchAt = Date.now()
  routeState.switches += 1
  try {
    await dsh.switchRoute({ provider: next.provider, model: next.model, reasoningEffort: next.reasoningEffort ?? null })
    routeState.current = { provider: next.provider, model: next.model }
    logger.log(`⚠️ 模型路由切换到 ${describeRoute(next)}（${next.kind === 'main' ? '主路由' : '备选 ' + (routeState.fallbackIndex + 1)}，累计切换 ${routeState.switches} 次）`)
    return true
  } catch (e) {
    logger.log(`切换路由失败: ${e.message}；保持 ${describeRoute(routeState.current)}`)
    return false
  }
}

/** 主路由冷却后探测切回。由每轮开始前调用（低频）。 */
async function maybeProbeBackMain() {
  if (!FAILOVER.enabled) return
  if (routeState.fallbackIndex === -1) return
  if (Date.now() - routeState.lastSwitchAt < FAILOVER.probeBackMs) return
  logger.log(`主路由冷却结束，尝试切回 ${describeRoute(ROUTE_MAIN)}`)
  const prev = routeState.current
  try {
    await dsh.switchRoute({ ...ROUTE_MAIN, reasoningEffort: ROUTE_MAIN.reasoningEffort ?? null })
    routeState.current = { provider: ROUTE_MAIN.provider, model: ROUTE_MAIN.model }
    routeState.fallbackIndex = -1
    routeState.lastSwitchAt = Date.now()
    logger.log(`✅ 已切回主路由 ${describeRoute(ROUTE_MAIN)}`)
  } catch (e) {
    logger.log(`切回主路由失败，继续用 ${describeRoute(prev)}: ${e.message}`)
    await dsh.switchRoute({ ...prev, reasoningEffort: null }).catch(() => {})
    routeState.lastSwitchAt = Date.now() // 再等一个周期
  }
}

// ── 入站处理 ────────────────────────────────────────────────────────────────
const busy = new Set() // peerKey
const passiveHits = new Map() // peerKey -> [timestamp]，旁听节流窗口

// ── 连发消息排队（修复「只回第一条，后面全丢」）──────────────────────────────
// 现象（用户实测 + 日志证据）：模型回一条要 10-30 秒，用户在这段时间连发 3-5 条
// 是很常见的（真人聊天就是「这边几句」）。原来 `busy` 一命中就 `return` ——
// **第 2 条之后的消息被直接丢弃，模型根本没见过**。生产日志里这种丢弃有 43 次。
//
// 现在改成：忙时**入队不丢**，当前轮结束后把积压合并成一段再跑一轮。
// 关键设计取舍：
//   · 合并成**一轮**而不是每句一轮 —— 省调用，且模型能看到完整的连发上下文
//     （分开跑的话第 3 条会看不到第 1、2 条的语气，回答会割裂）。
//   · 队列上限 20 条 —— 真刷屏时丢最旧的（保留最新，因为最新才是他此刻在说的），
//     并在日志里明确记下丢了几条，不静默。
//   · 合并文本里带**时间戳**（HH:MM:SS）—— 模型能看出这八秒内他连发了三句，
//     而不是以为这是一段连续的长文。时间戳用本地时区，跟上下文里别的时间一致。
const PENDING_MAX = config.policy?.pendingIngressMax ?? 20
/** peerKey -> [{text, senderName, senderQq, at, addressed}] */
const pendingIngress = new Map()
/** peerKey -> 是否已经在排空队列（防重入：排空过程中又来的消息留给下一轮） */
const drainingIngress = new Set()

/** 本地时区的 HH:MM:SS，用于合并段里的时间戳。 */
function hhmmss(ts, tz) {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      timeZone: tz || 'Asia/Shanghai',
    }).format(new Date(ts))
  } catch {
    return new Date(ts).toTimeString().slice(0, 8)
  }
}

/**
 * 把一条入站消息放进队列（忙时才用）。
 * 超上限丢**最旧**的：他刚发的那几条才是此刻在说的。
 */
function pushPendingIngress(peerKey, item) {
  const q = pendingIngress.get(peerKey) ?? []
  q.push(item)
  let dropped = 0
  while (q.length > PENDING_MAX) { q.shift(); dropped++ }
  pendingIngress.set(peerKey, q)
  if (dropped > 0) {
    logger.log(`排队 ${peerKey}: 积压超过 ${PENDING_MAX} 条，丢弃最旧 ${dropped} 条（当前 ${q.length} 条）`)
  }
  logger.log(`排队 ${peerKey}: 本轮还在处理，这条不丢，入队（积压 ${q.length} 条）`)
}

/**
 * 把积压的多条消息合并成给模型看的文本。
 *
 * 格式：
 *   【他连着发了几条】（3 条，11 秒内）
 *   [15:23:01] 今天好累啊
 *   [15:23:05] 加班到十点
 *   [15:23:12] 明天还得早起
 *
 * 群聊里连发的可能是不同人 → 每条带发送者，模型才能分清谁说的。
 * 私聊只有一个对话者 → 不标人名（省 token）。
 */
function mergePendingIngress(peerKey, items) {
  const tz = config.policy?.timezone ?? 'Asia/Shanghai'
  const isGroup = String(peerKey).startsWith('group:')
  const singleSender = !isGroup || new Set(items.map(i => i.senderQq)).size === 1
  const lines = items.map(i => {
    const who = singleSender ? '' : `${i.senderName || i.senderQq || '某人'}：`
    return `[${hhmmss(i.at, tz)}] ${who}${i.text}`
  })
  const span = items.length > 1 ? Math.round((items[items.length - 1].at - items[0].at) / 1000) : 0
  // 跨度 <1 秒时说「几秒内」而不是「0 秒内」—— 后者读起来像 bug。
  const spanText = span >= 1 ? `${span} 秒内` : '几秒内'
  const head = items.length === 1
    ? '【这是他在同一轮里补的一条】'
    : `【他连着发了几条】（${items.length} 条，${spanText}）`
  return { head, lines }
}

// ── 「对打字机」抑制 ─────────────────────────────────────────────────────────
// 现象：有人连续发长消息（工作汇报/自言自语），小群规则会让 bot 逐条回，听起来很吵。
// 做法：跟踪每个 peer 最近的消息节奏。如果短时间内连续收到多条**长消息**，
//       判定为「他在输出，不是在对话」→ 只保留最后一条的处理（前面的丢弃），
//       并在上下文里明确告诉模型「他在连发，不用逐条接」。
const FLURRY_DEFAULTS = {
  enabled: true,
  windowMs: 45000,       // 45 秒窗口内
  minMsgs: 3,            // 收到 3 条以上
  longMsgChars: 60,      // 其中至少这么长的算「长消息」
  suppressRatio: 0.6,    // 长消息占比超过这个就算在输出
  silenceAfter: 90000,   // 判定为打字机后，90 秒内不再主动回（除非被 @）
}

function flurryCfg () { return { ...FLURRY_DEFAULTS, ...(config.policy?.flurry ?? {}) } }

const recentMsgs = new Map() // peerKey -> [{at, len, addressed}]
const flurryState = new Map() // peerKey -> {until, peak}

/** 记录一条入站消息，返回是否判定为「打字机输出」。 */
function noteInboundRhythm (peerKey, textLen, addressed) {
  const c = flurryCfg()
  if (!c.enabled) return { flurry: false }
  const now = Date.now()
  const arr = (recentMsgs.get(peerKey) ?? []).filter(m => now - m.at < c.windowMs)
  arr.push({ at: now, len: textLen, addressed })
  recentMsgs.set(peerKey, arr)

  const longOnes = arr.filter(m => m.len >= c.longMsgChars)
  const ratio = arr.length ? longOnes.length / arr.length : 0
  const isFlurry = arr.length >= c.minMsgs && ratio >= c.suppressRatio

  if (isFlurry) {
    const prev = flurryState.get(peerKey)
    // 被 @ 的消息不算「刷屏」，但连续长文里夹一句 @ 也不打断判定
    if (!addressed) {
      flurryState.set(peerKey, {
        until: now + c.silenceAfter,
        peak: Math.max(prev?.peak ?? 0, arr.length),
      })
    }
    return { flurry: true, count: arr.length, ratio, peak: flurryState.get(peerKey)?.peak ?? arr.length }
  }
  return { flurry: false, count: arr.length, ratio }
}

/** 现在是否处在「他在连发，别接」的静默期。 */
function inFlurrySilence (peerKey) {
  const c = flurryCfg()
  if (!c.enabled) return false
  const st = flurryState.get(peerKey)
  if (!st) return false
  if (Date.now() > st.until) { flurryState.delete(peerKey); return false }
  return true
}



// ── 群人数缓存：说话欲望与群人数成反比 ──────────────────────────────────────
// 5 人小群里「旁听」几乎等于冷场（群里就那几个人，每句都跟他有关）；
// 200 人大群里插话才该克制。所以按群规模给一个「该开口的倾向档位」。
const groupSizeCache = new Map() // groupId -> { count, at }
const GROUP_SIZE_TTL = 5 * 60 * 1000

async function getGroupMemberCount(groupId) {
  const cached = groupSizeCache.get(String(groupId))
  if (cached && Date.now() - cached.at < GROUP_SIZE_TTL) return cached.count
  try {
    const info = await gateway.callData('get_group_info', { group_id: Number(groupId) }, 8000)
    const n = Number(info?.member_count)
    if (Number.isFinite(n) && n > 0) {
      groupSizeCache.set(String(groupId), { count: n, at: Date.now() })
      return n
    }
  } catch (err) {
    logger.debug(`get_group_info 失败（用缓存/默认）: ${err.message}`)
  }
  return cached?.count ?? null
}

/**
 * 由群人数推导「说话欲望」。
 * 人数越少 → 越该开口（小群里沉默=冷场）；人数越多 → 越该克制（大群里插话=刷屏）。
 * @returns {{tier:string, ratio:number, hint:string, silentFloor:boolean}}
 */
function speakingTendency(memberCount) {
  const cfg = config.policy?.speaking ?? {}
  const small = cfg.smallGroupMax ?? 8
  const large = cfg.largeGroupMin ?? 50
  const n = Number.isFinite(memberCount) ? memberCount : null
  if (n === null) {
    return { tier: 'unknown', ratio: 0.5, hint: '', silentFloor: false }
  }
  if (n <= small) {
    return {
      tier: 'small',
      ratio: 0.85,
      silentFloor: true,
      hint: [
        `这是一个 ${n} 人的小群。小群里每个人说的话基本都跟他有关，`,
        '所以**默认应该接话**，沉默才是反常的。',
        '只有真的无话可说（别人之间的私下对话、你在忙）才用 [SILENT]。',
        '接话可以短、可以不完美，但别让人觉得你在无视他。',
      ].join('\n'),
    }
  }
  if (n >= large) {
    return {
      tier: 'large',
      ratio: 0.15,
      silentFloor: false,
      hint: [
        `这是一个 ${n} 人的大群。人多嘴杂，插话等于刷屏。`,
        '所以**默认沉默**，只有被点到、或有真正值得说的东西时才开口。',
      ].join('\n'),
    }
  }
  return {
    tier: 'medium',
    ratio: 0.45,
    silentFloor: false,
    hint: [
      `这是一个 ${n} 人的群，规模中等。`,
      '要不要接自己判断：话题跟你有关、或你有东西可说就接；纯路人闲聊可以沉默。',
    ].join('\n'),
  }
}
const lastActivity = new Map()

function peerOf(evt) {
  if (evt.message_type === 'group') return { id: String(evt.group_id), scope: 'group' }
  return { id: String(evt.user_id), scope: 'c2c' }
}

function peerKeyOf(peer) {
  return `${peer.scope}:${peer.id}`
}

/**
 * 判断是否处理这条消息。
 * 群聊现在「全部读取」，但区分两类：
 *   - addressed=true ：@ 了我 / 私聊 / 别人回复了我的消息 → 必须回
 *   - addressed=false：群里的普通闲聊（旁听） → 由模型自己决定说不说
 * 白名单/忽略自己/群限制这些硬过滤对两类都生效。
 */
function allowed(evt, peer, atMe) {
  const { policy } = config
  if (policy.ignoreSelf && String(evt.user_id) === String(gateway.selfId)) return { ok: false }
  if (peer.scope === 'group') {
    if (policy.allowGroups?.length && !policy.allowGroups.includes(peer.id)) return { ok: false }
    // 组内旁听：读全部消息，但仅在 readAllGroupMessages 开启时
    if (!atMe) {
      if (policy.readAllGroupMessages === false) return { ok: false }
      return { ok: true, addressed: false }
    }
    return { ok: true, addressed: true }
  }
  if (!policy.allowC2C) return { ok: false }
  if (policy.allowUsers?.length && !policy.allowUsers.includes(peer.id)) return { ok: false }
  return { ok: true, addressed: true }
}

/**
 * 把「模型这一轮说的话」真正发出去：沉默判定 → 语音/@/补一句/撤回标记解包 →
 * 精力截断 → 打字延迟 → 短句连发 → 风格记账 → 好感度打卡 → 图片/语音/补发/戳。
 *
 * 为什么单独拆出来：这段原来是 handleInbound 里的一整段（约 190 行），
 * 和函数前半段（允许判定/卡片展开/情绪与好感度事件/记忆检索）混在一个 600 多行的函数里，
 * 改出站逻辑时很难确认自己动的是哪一段。拆出来后：
 *   - handleInbound 只负责「这条消息该不该处理、要给模型看什么」；
 *   - deliverReply 只负责「模型说了什么、怎么变成 QQ 上的动作」。
 * 行为与拆分前逐行一致（包括静默时不发言、打卡时机在正文发出之后）。
 */
async function deliverReply ({ peer, peerKey, text, addressed, senderQq, flat, forwardText }) {
  // 旁听模式下模型可以选择沉默：
  //   - 输出 [SILENT] → 明确表示不接
  //   - 或者干脆空回复
  // 两种情况都不发任何消息（但历史里已经记录了它"听过"这句话）。
  const silentMarked = /\[SILENT\]/i.test(text)
  const bodyText = text.replace(/\[SILENT\]/gi, '').trim()
  // 先抽出 [VOICE:文字:音色]（语音是独立动作，不是正文）
  const voices = []
  let textForSend = bodyText
  VOICE_RE.lastIndex = 0
  textForSend = textForSend.replace(VOICE_RE, (_all, vtext, vchar) => {
    voices.push({ text: String(vtext).trim(), character: vchar || null })
    return ''
  }).trim()

  // 再抽出 [POKE:qq]（同样是一个独立动作）
  const pokes = []
  POKE_RE.lastIndex = 0
  textForSend = textForSend.replace(POKE_RE, (_all, qq, scope) => {
    pokes.push({ qq, scope })
    return ''
  }).trim()

  // 「补一句」：抽出来，主消息发完后再补发（真人说漏了又补）
  const follows = []
  FOLLOW_RE.lastIndex = 0
  textForSend = textForSend.replace(FOLLOW_RE, (_all, t) => {
    const v = String(t).trim()
    if (v) follows.push(v)
    return ''
  }).trim()

  // 撤回标记 [RECALL:last] / [RECALL:n]：从正文剥掉，实际动作在**本条发出之前**执行。
  // 这样「撤掉上一句 + 重发」是一轮里完成的，对方看到的效果接近真人秒撤重打。
  // 同一次回复里最多撤 RECALL_RATE_MAX 条（多余的直接丢弃，记一笔日志）。
  const { specs: recallSpecs, dropped: recallDropped, text: noRecallText } = extractRecalls(textForSend)
  textForSend = noRecallText

  const { files, text: plain } = extractSendFiles(textForSend)
  const wantsSilence = silentMarked || (!plain && files.length === 0 && pokes.length === 0 &&
    voices.length === 0 && follows.length === 0 && recallSpecs.length === 0)

  if (!addressed && wantsSilence) {
    logger.log(`旁听→沉默 ${peerKey}（${silentMarked ? '[SILENT]' : '空回复'}），不发言`)
    state.peers[peerKey].silentSkips = (state.peers[peerKey].silentSkips ?? 0) + 1
    saveState()
    return
  }
  if (recallDropped > 0) {
    logger.log(`[RECALL] ${peerKey} 一轮里写了 ${recallDropped + recallSpecs.length} 个撤回标记，超出 ${RECALL_RATE_MAX} 条上限的 ${recallDropped} 个被忽略`)
  }
  // 先撤（失败也照常发后面的内容，不要把整轮搞崩）
  for (const idx of recallSpecs) {
    try { await performRecall(peer, idx) } catch (err) { logger.log(`[RECALL] 执行异常: ${err.message}`) }
  }
  // 低精力时的字数兜底（v2-1）：提示可能被无视，所以这里做一层软截断。
  // 只截正文、只在精力 < 40% 时生效，且保留完整句子结尾。
  let cappedPlain = plain
  const cap = energyCharCap(peerKey)
  if (cappedPlain && Number.isFinite(cap) && cappedPlain.length > cap) {
    const cut = cappedPlain.slice(0, cap)
    const lastPunc = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('\n'))
    cappedPlain = lastPunc > cap * 0.4 ? cappedPlain.slice(0, lastPunc + 1).trim() : cut.trim() + '…'
    logger.log(`energyCap ${peerKey}: 回复从 ${plain.length} 字截到 ${cappedPlain.length} 字（精力低）`)
  }

  // 回话延迟（v2-2）：让回复节奏有快有慢，不是每条都秒回
  const dly = replyDelayMs(cappedPlain || '', peerKey)
  if (dly > 0) {
    logger.log(`replyDelay ${peerKey}: ${dly}ms（模拟人打字的时间）`)
    await sleep(dly)
  }
  if (cappedPlain) {
    // 短句拆分的**代码兜底**（约束 2：硬规则优于形容词）。
    // 提示词里写了「少用标点、短句」，但实测提示词约束不可靠（energyHint 那次
    // 说「精力 15% 要短」照样回 748 字）。所以真的在出站前拆：
    // 单句 > splitChars(30) 且有多句 → 拆成 2 条连发（间隔像真人打完一句又补一句）。
    const parts = splitLongSentence(cappedPlain)
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) await sleep(400 + Math.random() * 600)
      await sendTextTo(peer, parts[i])
    }
  }
  // 风格样本记账：只记「对方那句话 → 我实际发出去的第一条正文」。
  // 记 cappedPlain 而不是模型原始输出：语音/图片/@/撤回等标记不是「说话内容」，
  // 而且要让记下来的就是对方真实看到的那句（否则学到的风格是没人见过的版本）。
  // 只记第一条正文（不含 [FOLLOW] 补发）：风格锚要的是「典型一句」而不是整个话痨流水。
  if (cappedPlain) recordStyleCase(peerKey, flat.text || forwardText || '', cappedPlain)
  // ── 好感度打卡：**必须放在这里**，不能放在 touchLastSpoke 旁边 ──────────
  // 打卡的定义是「他说话 **且** 我回应了」。touchLastSpoke 在 LLM 回完之后就调了，
  // 那时还没发送（后面还有 打字延迟 → 发送 → 图片 → 语音 → 补发）。
  // 如果放在那里，会出现「模型回了但发送失败」也算打卡（假打卡）。
  // 放这里 = 正文真的发出去了，才算出「有来有回」。
  if (senderQq && (cappedPlain || files.length || voices.length || pokes.length)) {
    affectionCheckin(senderQq, { peerKey })
  }
  for (const f of files) {
    const abs = path.isAbsolute(f) ? f : path.resolve(config.dsh.cwd, f)
    await sendImageTo(peer, abs)
  }
  for (const v of voices) {
    if (config.tts?.enabled === false) { logger.log('tts 已禁用，语音降级为文字'); await sendTextTo(peer, v.text); continue }
    await sendVoiceTo(peer, v.text, v.character)
    await sleep(400)
  }
      // 补发的几句：间隔像真人想了一下（1.2-3.5 秒）
  for (const f of follows.slice(0, 2)) {
    await sleep(1200 + Math.random() * 2300)
    await sendTextTo(peer, f)
    logger.log(`follow ${peerKey}: 补发一句 ${JSON.stringify(f.slice(0, 40))}`)
  }

for (const p of pokes) {
    // 默认 @/戳 对端；显式 scope=c2c 时强制私聊戳
    await sendPokeTo(peer, p.qq, p.scope === 'c2c' ? 'c2c' : undefined)
    await sleep(300)
  }
}

async function handleInbound(evt) {
  if (evt.post_type !== 'message') return
  const peer = peerOf(evt)
  const flat = flattenMessage(evt.message)
  const atMe = flat.atMe || flat.replyToMe || (evt.message_type === 'c2c')
  const verdict = allowed(evt, peer, atMe)
  if (!verdict.ok) {
    logger.debug(`忽略消息 ${peerKeyOf(peer)} (allow 判定)`)
    return
  }
  const addressed = verdict.addressed !== false
  const peerKey = peerKeyOf(peer)
  const now = Date.now()

  // 卡片（B站 分享）：文字只有标题，「里面讲了什么」得自己点开一次。
  // 放在 allow 判定之后：被忽略的消息不该去打外网接口。
  if (flat.cards?.length) {
    try {
      // 把 security.js 的守卫注进去（不注入的话 carddetail 只用不带 allowPrivateUrls /
      // blockedCidrs 配置的保守默认实例，等于用户的 SSRF 设置对卡片展开无效）
      const details = await enrichCardUrls(flat.cards, {
        checkUrlSafe,
        log: (m) => logger.log(m),
      })
      if (details.length) {
        flat.text = `${flat.text}\n${details.join('\n')}`.trim()
        logger.log(`卡片展开 ${details.length} 条：${details.join(' | ')}`.slice(0, 400))
      }
    } catch (err) {
      logger.debug(`卡片展开失败（忽略）: ${err?.message ?? err}`)
    }
  }

  // ⚠️ 接话窗口的锚点：**对方最后一条消息的时间**（在下面 busy.add 之后刷新，见那里的注释）。
  // 为什么不在这一行刷新：此时 state.peers[peerKey] 可能还不存在（首条消息），
  // touchLastUserMsg 内部的 proactiveState() 会因拿不到 ps 直接跳过，锚点就丢了。
  // 而这里又不能提前建 peer 对象（会绕过 sessionIdFor 的 sessionId 初始化）。
  // 所以放到 busy.add 之后 —— 那时 sessionIdFor 已经保证 state.peers[peerKey] 存在。

  // 情绪触发：对方说的话里有夸奖/怼/是否点到我
  for (const ev of detectMoodTriggers(flat.text, { addressed, atMe: flat.atMe })) {
    moodEvent(peerKey, ev.kind, ev.why)
  }

  // 好感度的「人」= 发言人 QQ（群聊 evt.user_id / 私聊 peer.id，两者都是发言人本人）。
  // 按人而不是 peerKey：同一个人在私聊和群里应该是同一个态度（见 affectionHint 注释）。
  const senderQq = evt.user_id != null ? String(evt.user_id) : (peer.scope === 'c2c' ? String(peer.id) : '')
  // 认识渠道（只做记录，不参与计算）
  if (senderQq) {
    const p0 = peopleState(senderQq)
    if (p0 && !p0.metIn.includes(peerKey)) {
      p0.metIn.push(peerKey)
      if (p0.metIn.length > 10) p0.metIn.shift()
    }
  }

  // 节奏判定：他在连续发长消息吗？
  const rhythm = noteInboundRhythm(peerKey, (flat.text || '').length, addressed)
  let flurryMode = rhythm.flurry
  // 好感度事件（**在 flurry 判定之后**，因为 flurry 期间不计分 —— 连发十条不是「陪我聊」）
  if (senderQq && !flurryMode) {
    // 指向性闸：群聊里无指向的夸（「666」「牛逼」）不算 —— 那不是夸我
    const pointed = addressed || atMe || peer.scope === 'c2c'
    const triggers = detectMoodTriggers(flat.text, { addressed, atMe: flat.atMe })
    for (const ev of triggers) {
      if (ev.kind === 'praise' && pointed) affectionEvent(senderQq, 'praise', { peerKey })
      // 被骂：**L≥3 免除**（熟人之间互怼是常态，不算掉分。这也是「关系越近越随便」的一面）
      else if (ev.kind === 'insult' && pointed && affectionTier(senderQq) !== 'l4') {
        affectionEvent(senderQq, 'insult', { peerKey })
      }
    }
    // 带新信息：长内容且是跟我说的（带图不算 —— 图里的评价交给模型看图判断后触发对应事件，
    // 这里不做特殊处理，符合任务「带图不作为涨分依据」的要求）
    if (pointed && !flat.images?.length && (flat.text || '').length > 60) {
      affectionEvent(senderQq, 'info', { peerKey })
    }
  }
  // 已经在「别接」静默期里，且这条没 @ 我 → 只记日志，不进 LLM（省一次调用）
  if (!addressed && inFlurrySilence(peerKey)) {
    logger.log(`flurry ${peerKey}: 他在连发（峰值 ${rhythm.peak ?? rhythm.count} 条），本条不接`)
    state.peers[peerKey] = state.peers[peerKey] ?? {}
    state.peers[peerKey].flurrySkips = (state.peers[peerKey].flurrySkips ?? 0) + 1
    saveState()
    return
  }
  const cool = config.policy.cooldownMsPerPeer ?? 1500
  if (cool && now - (lastActivity.get(peerKey) ?? 0) < cool) {
    logger.debug(`冷却中，忽略 ${peerKey}`)
    return
  }
  // ⚠️ 这里**不再丢弃**忙时到达的消息（原来 `if (busy.has(...)) return` 是 bug）。
  // 但要等下面的「图片/引用/转发」都处理完才能入队 —— 那些是异步的，且可能耗时
  // （下载图片、get_msg、展开转发）。提前 return 会导致入队的消息丢掉图片和引用。
  // 所以「忙」的判断放到内容准备好之后（见下方 queueIfBusy）。
  // 旁听：先看群多大，决定「说话欲望」。小群放宽节流（几乎都处理），大群收紧。
  let tendency = null
  const quiet = isQuietHours()
  if (!addressed && peer.scope === 'group') {
    const memberCount = await getGroupMemberCount(peer.id)
    tendency = speakingTendency(memberCount)
    // 深夜：把「该开口的倾向」打个折，但不归零、也不禁止
    if (quiet.quiet && tendency) {
      // 深夜要把「该接话」的语义也换掉，否则它和小群"默认应该接话"的提示打架。
      const quietHints = {
        small: [
          '这是一个小群，但**现在是深夜**。',
          '**默认不开口。** 这不是「30% 的概率说话」，而是：没被点到就不说。',
          '这条话你可以听完就过，不用回应——群里这个点本来就没人期待你回。',
          '**例外**（只有这两种才接）：有人直接问你；或者你确实有一句很想说的，那就说，但短。',
        ].join('\n'),
        medium: '今晚这个点群里应该很安静。**默认不开口**，除非有人直接问你或有真值得说的。',
        large: '深夜的大群基本没人说话。**默认不开口**。',
        unknown: '现在是深夜。**默认不开口**，除非有人直接问你。',
      }
      tendency = {
        ...tendency,
        ratio: Math.max(0.05, tendency.ratio * (quiet.cfg.passiveRatioFactor ?? 0.35)),
        hint: quietHints[tendency.tier] ?? quietHints.unknown,
        quiet: true,
      }
    }
    if (!tendency.silentFloor) {
      const win = config.policy.passiveWindowMs ?? 10000
      const baseMax = config.policy.passiveMaxPerWindow ?? 3
      const max = Math.max(1, Math.round(baseMax * (tendency.ratio / 0.45)))
      const nowTs = Date.now()
      const hist = (passiveHits.get(peerKey) ?? []).filter(t => nowTs - t < win)
      if (hist.length >= max) {
        logger.debug(`旁听节流 ${peerKey}: ${win}ms 内已处理 ${hist.length}/${max} 条（${tendency.tier}），丢弃本条`)
        return
      }
      hist.push(nowTs)
      passiveHits.set(peerKey, hist)
    } else {
      logger.debug(`小群旁听不节流 ${peerKey}（${tendency.tier}）`)
    }
  }
  lastActivity.set(peerKey, now)

  const senderName = evt.sender?.card || evt.sender?.nickname || String(evt.user_id)
  logger.log(`入站 ${peerKey} from=${senderName}(${evt.user_id}) text=${JSON.stringify(flat.text.slice(0, 80))} images=${flat.images.length} cards=${flat.cards?.length ?? 0} segs=${flat.segTypes?.length ? [...new Set(flat.segTypes)].join(',') : '-'}`)

  // 引用回复：reply 段只有 message_id，得用 get_msg 取回原话
  let quotedText = ''
  // 合并轮带来的引用（入队时已经取回过，不要重复请求 OneBot）
  const mergedExtras = evt._mergedExtras ?? null
  if (mergedExtras?.quotedText) quotedText = mergedExtras.quotedText
  else if (flat.replyId) {
    const q = await quoteOf(flat.replyId)
    if (q.ok) {
      quotedText = `${q.from}：${q.text}`
      logger.log(`引用消息已取回 from=${q.from} len=${q.text.length}`)
    } else {
      logger.log(`引用消息取不到（${q.reason}）`)
      quotedText = `（他引用了一条消息，但内容取不到：${q.reason}）`
    }
  }

  // 合并转发：展开成「谁说了什么」的纯文本，让模型能读到里面的对话
  let forwardText = ''
  if (mergedExtras?.forwardText) forwardText = mergedExtras.forwardText
  else if (flat.forwardIds.length) {
    forwardText = await expandForwards(flat.forwardIds)
    if (forwardText) logger.log(`已展开 ${flat.forwardIds.length} 条合并转发（${forwardText.length} 字）`)
  }

  // 图片：下载到 staging（供 LLM 读取；也作为后续 learn 的可能来源）
  const imagePaths = []
  for (const img of flat.images) {
    try {
      const url = img.url ?? img.file
      if (!url || !/^https?:\/\//.test(url)) { logger.log(`跳过非 http 图片 url=${url}`); continue }
      const p = await downloadUrlToStaging(url)
      imagePaths.push(p)
      logger.log(`图片已暂存 ${p}`)
    } catch (err) {
      logger.log(`图片下载失败: ${err.message}`)
    }
  }
  // 合并轮：图片在入队前已经下载过，直接用（别再下一遍）
  if (mergedExtras?.imagePaths?.length) imagePaths.push(...mergedExtras.imagePaths)

  // 空消息判定必须把**所有**可能承载内容的东西都算上：
  // 纯文本、图片、合并转发展开内容、卡片。
  // （之前漏了 forwardText —— 合并转发消息的 text 是空的，会被误判成空消息丢掉）
  const hasForward = !!forwardText
  const hasCard = !!(flat.cards?.length)
  if (!flat.text && imagePaths.length === 0 && !hasForward && !hasCard) {
    // 用 info 级：这个丢消息的时刻必须能被看见
    logger.log(`空消息，忽略 ${peerKey}（text=0 images=0 forward=0 card=0）`)
    return
  }

  // ── 忙时排队（不再丢弃）────────────────────────────────────────────────
  // 内容已经全部准备好（图片下载完、引用取回、转发展开），这时才发现忙 →
  // 入队，等当前轮结束后合并成一段再喂模型。
  if (busy.has(peerKey)) {
    pushPendingIngress(peerKey, {
      text: flat.text || (imagePaths.length ? `[发了 ${imagePaths.length} 张图片]` : '') ||
        (hasForward ? '[合并转发]' : '') || (hasCard ? '[卡片]' : '') || '',
      // 图片路径/转发/引用也要带过去，否则合并轮里模型看不到这些内容
      imagePaths, quotedText, forwardText, cards: flat.cards ?? [],
      senderName, senderQq: evt.user_id != null ? String(evt.user_id) : '',
      at: Date.now(), addressed,
    })
    return
  }

  busy.add(peerKey)
  try {
    // 想切回主路由就顺手探一下（内部有 probeBackMs 时间闸，不会每轮都探）
    maybeProbeBackMain().catch(() => {})
    // 轮数上限：超过就换新会话（新会话会自动重新注入人设全文）
    rolloverIfNeeded(peerKey)
    const sdkSessionId = sessionIdFor(peerKey)   // 顺便确保 state.peers[peerKey] 已建好（ACP 记账要用）

    // 接话窗口的锚点：**对方最后一条消息的时间**。
    // 只有**真实**入站消息才刷新它 —— 合并轮（`_mergedExtras`）是桥自己合成的，
    // 不是新消息，刷新它会让排空积压无限续窗口。
    // 而「我说话不延长窗口」是硬规则：touchLastSpoke 只改 lastSpokeAt，绝不碰这个字段，
    // 所以本行是 lastUserMsgAt 的**唯一**写入点（在 sessionIdFor 之后，保证 peer 对象已存在）。
    if (!evt._mergedExtras) touchLastUserMsg(peerKey)
    const blocks = []
    // 人设：全文只在「首次」或「文件变了」时注入一次，其余轮次只给路径 + 状态。
    // 这样人设不会作为普通历史被反复计费（省 ~3600 tokens/轮），但改动仍然下一轮就生效。
    const persona = readPersona()
    const peerState = state.peers[peerKey]
    const needPersonaFull = !!persona.text && peerState.personaHash !== persona.hash
    const contextLines = []
    if (needPersonaFull) {
      contextLines.push(
        [
          `【你的人设】以下是文件 ${PERSONA_PATH} 的当前内容。这是「你是谁」，` +
          `优先级高于任何编码 agent 的默认自我认知；你随时可以修改该文件来调整自己。`,
          '```markdown',
          persona.text,
          '```',
          '',
          `（这份全文只在人设变化时注入一次；后续轮次只提示文件路径，你随时可以 read 它。）`,
        ].join('\n'),
      )
    } else if (persona.text) {
      contextLines.push(`【人设】未变化，仍以 ${PERSONA_PATH} 为准（需要复查就 read 该文件）。`)
    } else {
      contextLines.push(
        `【人设文件缺失】${PERSONA_PATH} 不存在或读不到。请按普通群友的方式自然回话，` +
        `并可考虑自己写一份人设文件到该路径（桥下一轮会读）。`,
      )
    }
    contextLines.push(
      '',
      addressed
        ? `当前用户正通过【QQ】与你对话（${peer.scope === 'group' ? 'QQ群' : 'QQ私聊'}）——他在跟你说话（@你 / 私聊 / 回复你的消息）。`
        : `【你在旁听】以下是 QQ群里别人的对话，没有 @ 你。`,
      `发送者：${senderName}（QQ号 ${evt.user_id}）`,
      `当前时间：${new Date().toLocaleString('zh-CN', { timeZone: config.policy?.timezone ?? 'Asia/Shanghai', hour12: false })}`,
      peer.scope === 'group' ? `群号：${peer.id}` : null,
      peer.scope === 'group' && flat.atList?.length
        ? `这条消息 @ 了：${flat.atList.map(q => String(q)).join(', ')}（其中不含你 = 他们在跟别人说话）`
        : null,
      `你的 QQ 号：${gateway.selfId ?? '未知'}`,
      `你的人设文件：${PERSONA_PATH}（可读可改，改完下一轮生效）`,
      '',
    )
    // 合并轮：明确告诉模型「这不是一条长消息，是他连着发的几条」。
    // 不加这句的话，模型会把带时间戳的多行当成一条排版奇怪的长文，
    // 然后逐条点评（正是要避免的「他发十条我回十条」）。
    if (mergedExtras?.count > 1) {
      contextLines.push(
        `【他连着发了 ${mergedExtras.count} 条，我把它们合在一起给你看了】`,
        '这是同一个人在这几十秒内连续说的几句话（真实聊天就是这样，这边几句那边几句），',
        '不是一条长消息。**当成一个整体的意思来回应**，不要一句一句点评。',
        '如果几句话是分开的意思，挑最主要的那个回应，或者顺着他的情绪接一句就够。',
        '**不要**复述他说过的话，也不要说「你说了三点」这种话。',
        '',
      )
    }
    if (flurryMode) {
      contextLines.push(
        '',
        '【⚠️ 这个人正在连着发消息，不是在跟你对话】',
        `他最近 ${Math.round((config.policy?.flurry?.windowMs ?? 45000) / 1000)} 秒内已经发了 ${rhythm.count} 条，其中大部分是长段落。`,
        '这看起来是在**输出内容/汇报进度/自己往下讲**，不是等你逐条点评。',
        '所以：**不用一条条接。** 可以选择：',
        '  - 只回 `[SILENT]`（最合适，如果他只是在讲）',
        '  - 挑这一次真正需要回应的点，说一句就够',
        '  - 如果他明确问了你，才正经答',
        '他发十条我回十条，就是噪音。先听着。',
      )
    }
    if (quiet.quiet) {
      contextLines.push('', quietHint(quiet.hour, quiet.cfg))
    }
    if (!addressed) {
      const t = tendency ?? speakingTendency(null)
      contextLines.push(
        '【你在旁听：这一条不一定需要回】',
        '- 你听到了这句话，但没人叫你。要不要接，你自己判断。',
        '- 想接就直接输出你想说的话（就像在群里插一句，不用 @ 谁）。',
        '- 不想接就**只输出 [SILENT] 这一行**，什么都别多说。',
        '',
        t.quiet
          ? `【本群规模·深夜模式】${t.hint || '(群人数未知)'}`
          : `【本群规模】${t.hint || '(群人数未知)'}`,
        t.quiet
          ? `【这一条的默认动作】沉默（[SILENT]），除非命中上面写的例外`
          : `【当前该开口的倾向】${t.tier}（约 ${Math.round(t.ratio * 100)}%）`,
        '',
        '- 不要为了刷存在感而说话；不要复述别人的话；不要科普。',
        '- 但也不要故作高深地沉默 —— 该聊的时候像个正常人一样聊。',
        '',
      )
    }
    const eh = energyHint(peerKey)
    if (eh) contextLines.push('', eh)
    const mh = moodHint(peerKey)
    if (mh) contextLines.push(mh)
    // 好感度：**位置固定在 moodHint 之后、【硬约束】之前**（用户明确要求的安全隔离）。
    // 为什么不放到更靠后：靠后会被硬约束压制是对的，但硬约束必须在最后压轴；
    // 所以好感度跟 mood/记忆/风格/lexicon 同层，全部在硬约束之前。
    // L0 返回 ''（不注入）；L4 群聊返回 ''（损友分寸只在私聊）。
    // 分数只由 peopleState 的确定性代码改，模型输出碰不到它（安全隔离的结构保证）。
    const aff = affectionHint(senderQq, { inGroup: peer.scope === 'group' })
    if (aff) contextLines.push('', aff)
    // 记忆：让它在正常对话里也能"想起以前的事"，而不是只在主动搭话时才看。
    //
    // 阶段二改动：从「只读 digest.md 的本会话节」升级为「按人跨通道检索」——
    // 发言人在私聊说过的事，群里聊天时也能想起来（见 memoryRecallBlock 注释）。
    //   · speaker = 这条消息的发送者（`evt.user_id`；私聊时它就是对端本人）
    //   · inGroup = 群聊场景 → true，过滤掉 visibility='dm_only'（别当众说私聊的事）
    // 拿不到 speaker（user_id 缺失）时 memoryRecallBlock 内部会退回「只读 digest」的老行为。
    // 失败一律静默降级（crossChannelRecall 返回 null → 只剩 digest），不影响回话。
    const mem = memoryRecallBlock(peerKey, {
      speaker: evt.user_id != null ? String(evt.user_id) : '',
      inGroup: peer.scope === 'group',
      query: flat.text || '',
    })
    if (mem) contextLines.push('', mem)
    // 风格锚：把「我在类似场合的原话」放进来（最多 3 条、每条截 60 字；样本不足不注入）。
    // 位置在记忆之后、硬约束之前 —— 越靠后越靠近行动，但不能压住硬约束。
    const styleBlock = styleAnchorBlock(peerKey, flat.text || forwardText || '')
    if (styleBlock) contextLines.push('', styleBlock)
    // 说话方式学习：把「从别人语料里学来的词汇/梗/表情用法/句式」放进来。
    // 位置紧贴硬约束之前 —— 它是「说话的手感」，应该靠近行动，但不能压住硬约束。
    // 冷启动（库 <3 条）/文件不存在/解析失败 → lexiconBlock 返回 ''，不注入。
    // 「贴切才用，别硬塞」这句话是渲染块自带的尾巴（lexicon.py RENDER_FOOTER），
    // 因为「学来的词无脑堆」是这个功能最容易翻车的地方。
    const lexBlock = lexiconBlock()
    if (lexBlock) contextLines.push('', lexBlock)
    contextLines.push(
      `【硬约束】QQ 通道不认 [表情: 描述] 文字标记；要发表情包必须用 qq-meme skill 发送真实图片文件并输出 [SEND_FILE: 绝对路径]。`,
      `【硬约束】[SEND_FILE] 只放行会话工作区 (${config.dsh.cwd}) 与暂存目录 (${STAGING_DIR}) 内的文件。`,
    )
    if (config.bili?.enabled !== false && BILI_MCP) {
      contextLines.push(
        '',
        `【你能看 B站】你有这些工具（想用就用，不用请示）：`,
        `  bili_search <关键词>   → 搜视频，返回标题/BV号/播放量/UP/时长`,
        `  bili_subtitle <BV号>   → 拿**字幕全文**（判断视频讲了什么就靠它）`,
        `  bili_comments <BV号>   → 热门评论（看大家在玩什么梗）`,
        `  bili_cover <BV号>      → 封面图（能直接看到）`,
        `  bili_frames <BV号>     → 视频截图（1-6 帧，能看画面）`,
        `  bili_whoami            → 看 B站 登录状态`,
        '',
        '【什么时候看 B站】',
        '  - 有人发 BV 号/链接让你看 → **先 bili_subtitle 读字幕**，别凭标题瞎猜',
        '  - 群里在聊一个 B站 梗/视频/UP主，你不知道 → 可以搜一下',
        '  - 有人问「这个视频讲了啥」「这是谁」→ 查完用**人话**说结论',
        '  - 想知道某个梗的出处 → bili_search + bili_comments',
        '',
        '【注意】',
        '  - 看视频**不要**把字幕原文贴出来，提炼成人话',
        '  - 没字幕就直说「这视频没字幕我看不懂」，别编',
        '  - 一次最多查 1-2 个视频，别为了一个玩笑翻一堆；**不要主动刷**',
        '  - 涉及真人/UP主的评价保守点，别拿评论区的话当事实传播',
        '',
      )
    }
    if (config.tts?.enabled !== false) {
      const engineLabel = { gsv: 'GPT-SoVITS（本机，音色克隆）', piper: 'Piper（本机）', sherpa: 'sherpa-onnx（本机）', qq: 'QQ 内置音色' }
      contextLines.push(
        `【语音能力】你可以发**真语音**（本机 TTS 合成，不是 QQ 内置那种机械音）：`,
        `  引擎：${engineLabel[config.tts?.engine ?? 'gsv'] ?? config.tts?.engine}`,
        `  写法：[VOICE:要说的话]  → 直接用你自己的声音说`,
        `  一条上限 ${config.tts?.maxChars ?? 200} 字`,
        peer.scope === 'group' ? '' : '  （私聊也支持）',
        `【语音的使用分寸】群里语音比文字烦人（不能扫读、占屏幕），所以：`,
        `  - 只在**被明确要求**（"唱一个""说句话听听""语音回我"）、或一句话特别有情绪时才用`,
        `  - 通常 1-2 句就够，别一口气念一大段`,
        `  - 默认还是用文字；不要连着发语音`,
        `  - 不为了炫技而发语音`,
        `  - 语音和文字不要发同一句话（浪费）`,
        '',
      )
    }
    // 卡片：本条的 + 合并轮里攒下的（入队时解析好的，别丢）
    const anyCards = [...(flat.cards ?? []), ...(mergedExtras?.cards ?? [])]
    if (anyCards.length) {
      contextLines.push(
        '',
        '【这条消息是个分享卡片】',
        '你能看到的内容是：' + anyCards.join(' / '),
        '卡片本身你打不开（看不到里面的视频/小程序/网页）。所以：',
        '  - 标题够看懂就顺着聊，别装作看过内容',
        BILI_MCP
          ? '  - 想知道详情可以 bili_search 或搜一下标题'
          : '  - 想知道详情只能照标题聊（当前没挂 B站 工具，看不了内容）',
        '  - 实在猜不出是什么就直说「这卡片我打不开，你说说是啥」',
      )
    }
    if (quotedText) {
      contextLines.push(
        '',
        '【他引用了一条消息来回复你/别人】',
        `被引用的原文 —— ${quotedText}`,
        '所以你回话时可以针对那条内容说，不用问「你回的是哪条」。',
      )
    }
    if (forwardText) {
      contextLines.push('', '【这条消息里带了一段合并转发的聊天记录，内容已展开如下】', forwardText)
    }
    if (imagePaths.length) {
      contextLines.push('', `用户本条消息附带了 ${imagePaths.length} 张图片，**已随这条消息附上**（能直接看到内容）。`)
      contextLines.push('同时也在本机暂存了一份（万一你看不到图，可以用 read_image 按路径读）：')
      for (const p of imagePaths) contextLines.push(`- ${p}`)
      contextLines.push('若用户要求「入库/收藏/学图」，按 qq-meme skill 的 learn 流程处理。')
    }
    blocks.push({ type: 'text', text: contextLines.filter(Boolean).join('\n') })
    blocks.push(recallPromptBlock(peerKey))
    if (flat.text) {
      // ⚠️ 用户消息本身也是不可信输入：里面如果藏着 [SEND_FILE:...] 等标记，
      //    模型复述时会被桥当成指令执行。这里把标记打散（全角冒号），让它失去语义。
      blocks.push({ type: 'text', text: sanitizeUntrustedText(flat.text, { maxChars: 4000 }) })
    } else if (hasForward) {
      // 纯转发：不要再加图片占位符 —— ACP 会把两个 block 合并成一段，
      // 占位符会粘在转发内容屁股后面，让模型误以为图在转发里。
      // 转发内容里已经标了 [图片]，这里什么都不用补。
    } else if (hasCard) {
      // 纯卡片：同理，卡片文本已在上下文里
    } else {
      blocks.push({ type: 'text', text: '（用户只发了图片，没有文字）' })
    }

    // 图片本体：作为 ACP image 内容块附上去（放在文字之后，模型会先读到
    // 「附带了 N 张图片」再看到图）。内联不了的就只留路径。
    for (const p of imagePaths) {
      const imgBlock = imageBlockForPath(p)
      if (imgBlock) blocks.push(imgBlock)
      else logger.log(`图片没有内联（超过 ${Math.round(MAX_INLINE_IMAGE / 1024 / 1024)}MB 或读不出），只给路径: ${p}`)
    }

    const started = Date.now()
    // LLM 侧失败（模型目录刷新窗口、provider 抖动、超时）不该让整轮静默消失。
    // 重试一次；仍失败则用一句人话回过去，避免群里「发消息没人应」。
    let text
    try {
      ({ text } = await dsh.prompt(PROTOCOL === 'acp' ? peerKey : sdkSessionId, blocks))
    } catch (err) {
      logger.log(`LLM 第 1 次失败 ${peerKey}: ${err.message}；重试一次`)
      await sleep(1500)
      try {
        ({ text } = await dsh.prompt(PROTOCOL === 'acp' ? peerKey : sdkSessionId, blocks))
      } catch (err2) {
        logger.log(`LLM 重试仍失败 ${peerKey}: ${err2.message}`)
        await noteLlmFailure(err2)
        throw new Error(`模型暂时不可用（${err2.message}）`)
      }
    }
    // 人设注入成功后才记账：失败时下一轮会重新注入，不会因为异常而漏掉
    if (needPersonaFull) {
      peerState.personaHash = persona.hash
      peerState.personaInjectedAt = Date.now()
    }
    noteLlmSuccess()
    state.peers[peerKey].turns = (state.peers[peerKey].turns ?? 0) + 1
    // 「我最后一次发言」计时（主动搭话的基准）：只要真的发了东西就算发言
    touchLastSpoke(peerKey)
    energyDrop(peerKey)
    saveState()
    logger.log(`本轮完成 ${peerKey} ${Math.round((Date.now() - started) / 1000)}s 回复长度=${text.length}`)
    // 把回复**内容**也写进日志（截断到 500 字）：
    // 记忆系统只抓入站消息的话，就只剩「对方说了什么」，看不到「我回了什么」，
    // 于是记不住自己的态度/承诺/说过的话 —— 这是「记忆简陋」的根因之一。
    if (text && text.trim()) {
      const forLog = text.replace(/\s+/g, ' ').slice(0, 500).replace(/"/g, '\\"')
      logger.log(`出站 ${peerKey} text="${forLog}" chars=${text.length}`)
    }

    await deliverReply({ peer, peerKey, text, addressed, senderQq, flat, forwardText })
  } catch (err) {
    logger.log(`处理消息异常 ${peerKey}: ${err.message}`)
    // 给群里一句人话，而不是把技术错误原文贴出去
    const friendly = /模型暂时不可用/.test(err.message)
      ? '脑子卡了一下，等下再说'
      : '刚刚没接住，你再说一遍？'
    try { await sendTextTo(peer, friendly) } catch { /* ignore */ }
  } finally {
    busy.delete(peerKey)
    // 当前轮结束 → 把积压的连发消息合并成一轮再喂给模型。
    //
    // 为什么放在 finally 且不 await：这一轮已经结束，排空是**新一轮**的事，
    // 等它会让 handleInbound 的调用方（事件循环）多挂一会儿。但也不能完全撒手 ——
    // 用 drainingIngress 防重入：排空期间又来的消息入队，等下一轮排空时一起处理。
    // 注意：不 await 的任务必须有 catch，否则 rejected promise 会变成 unhandled rejection。
    drainPendingIngress(peerKey, peer).catch(err => logger.log(`排空队列异常 ${peerKey}: ${err.message}`))
  }
}

/**
 * 排空某个 peer 的积压消息：合并成一段，跑**一轮** LLM。
 *
 * 复用 handleInbound 的整条链路（人设/记忆/风格/发送/撤回等）是不可能的 ——
 * 那些都绑在 evt 上。所以这里做的是「合成一个虚拟入站事件」，再走一遍 handleInbound。
 * 这样合并轮和普通轮的行为完全一致（人设注入、记忆、限频、静默判定都走同一套），
 * 不会出现「合并轮是个特殊路径，行为不一样」的坑。
 */
async function drainPendingIngress(peerKey, peer) {
  const q = pendingIngress.get(peerKey)
  if (!q || !q.length) return
  if (drainingIngress.has(peerKey)) return
  if (busy.has(peerKey)) return   // 又有新轮在跑了，留给它结束后的排空
  drainingIngress.add(peerKey)
  // 立刻摘走队列（不用等异步）：这样排空期间新来的消息会进新队列，不会混进这一批
  pendingIngress.delete(peerKey)
  try {
    const items = q
    const { head, lines } = mergePendingIngress(peerKey, items)
    const mergedText = [head, ...lines].join('\n')
    const last = items[items.length - 1]
    // 把这一批里附带的非文本内容汇总起来（图片/引用/转发/卡片）。
    // 这些在入队时就已经处理好了（图片下载完、引用取回、转发展开），
    // 合并轮直接带上，不能丢 —— 否则「他连发三条，其中一张图」图就没了。
    const allImagePaths = items.flatMap(i => i.imagePaths ?? [])
    const allQuoted = items.map(i => i.quotedText).filter(Boolean)
    const allForward = items.map(i => i.forwardText).filter(Boolean)
    const allCards = items.flatMap(i => i.cards ?? []).filter(Boolean)
    logger.log(`排空 ${peerKey}: 合并 ${items.length} 条积压消息成一轮（${mergedText.length} 字，图 ${allImagePaths.length} 引用 ${allQuoted.length} 转发 ${allForward.length}）`)

    // 合成虚拟事件：sender 用**最后一条**的发送者（他就是刚说完话的人）
    const evt = {
      post_type: 'message',
      message_type: peer.scope === 'group' ? 'group' : 'private',
      sub_type: 'normal',
      time: Math.floor(last.at / 1000),
      self_id: gateway.selfId,
      message_id: `merged-${Date.now()}`,
      ...(peer.scope === 'group' ? { group_id: Number(peer.id) } : { user_id: Number(peer.id) }),
      user_id: last.senderQq ? Number(last.senderQq) : Number(peer.id),
      raw_message: mergedText,
      font: 0,
      sender: {
        user_id: last.senderQq ? Number(last.senderQq) : Number(peer.id),
        nickname: last.senderName || '某人',
        card: last.senderName || '',
      },
      // 关键：message 段里放合并后的**整段**（含时间戳）。
      // 这样 handleInbound 里所有基于 flat.text 的逻辑（情绪触发、检索 query、
      // 风格锚的 context、空消息判定）看到的都是合并文本 —— 走和真消息同一条路。
      message: [{ type: 'text', data: { text: mergedText } }],
      // 非文本内容的旁路：handleInbound 会读这个字段，把它们塞进上下文，
      // 但**不会**再走一遍下载/取回（那些在入队前已经做过了）。
      _mergedExtras: {
        count: items.length,
        imagePaths: allImagePaths,
        quotedText: allQuoted.join(' / '),
        forwardText: allForward.join('\n'),
        cards: allCards,
      },
    }
    await handleInbound(evt)
  } catch (err) {
    logger.log(`排空 ${peerKey} 失败: ${err.message}`)
  } finally {
    drainingIngress.delete(peerKey)
    // 排空期间又积了新消息 → 再排一次（递归但有 draining 闸，不会无限嵌套）
    if ((pendingIngress.get(peerKey) ?? []).length) {
      drainPendingIngress(peerKey, peer).catch(err => logger.log(`二次排空异常 ${peerKey}: ${err.message}`))
    }
  }
}

// ── 入群欢迎 ────────────────────────────────────────────────────────────────
// OneBot 11 的群成员变动通知：post_type=notice, notice_type=group_increase。
// 只处理「有人进群」，不处理退群/被踢（那没必要播报）。
function handleGroupIncrease(evt) {
  const cfg = config.welcome ?? {}
  if (cfg.enabled === false) return
  const groupId = String(evt.group_id ?? '')
  if (!groupId) return
  if (Array.isArray(cfg.groups) && cfg.groups.length && !cfg.groups.map(String).includes(groupId)) return
  // 自己进群不欢迎自己（机器人被拉进新群时）
  if (String(evt.user_id) === String(gateway.selfId)) {
    logger.log(`自己被拉进群 ${groupId}，不发欢迎`)
    return
  }
  const nickname = evt.user_id ? `QQ ${evt.user_id}` : '新同学'
  const peer = { id: groupId, scope: 'group' }
  const template = cfg.template ?? '[CQ:at,qq={qq}] 新来的？报下名字和来路，别潜水。'
  const text = template.replaceAll('{qq}', String(evt.user_id ?? '')).replaceAll('{group}', groupId).replaceAll('{nickname}', nickname)

  if (cfg.useLlm === false) {
    logger.log(`欢迎新群友 ${evt.user_id} -> ${groupId}（固定文案）`)
    gateway.callData('send_group_msg', { group_id: Number(groupId), message: [{ type: 'text', data: { text } }] }, 20000)
      .catch(err => logger.log(`欢迎消息发送失败: ${err.message}`))
    return
  }

  // 走 LLM：让它按人设自己组织一句欢迎词（更像人、不模板化）
  const peerKey = `group:${groupId}:welcome`
  if (busy.has(peerKey)) return
  busy.add(peerKey)
  ;(async () => {
    try {
      // 欢迎语用**一次性临时会话**，不写进 state：每个新成员一个永久会话会无限堆积，
      // 而且欢迎语也不需要跨轮记忆。临时 id 用完即弃（session 日志留在磁盘上可追溯）。
      const welcomeSessionId = `session-welcome-${groupId}-${evt.user_id}-${Date.now()}`
      const persona = readPersona()
      const blocks = [
        { type: 'text', text: [
          persona.text
            ? `【人设】未变化，仍以 ${PERSONA_PATH} 为准（需要复查就 read 该文件）。`
            : `【人设文件缺失】${PERSONA_PATH}`,
          '',
          `【系统事件】QQ群 ${groupId} 有新成员加入。`,
          `新成员 QQ 号：${evt.user_id ?? '未知'}`,
          `你是这个群的成员之一（你的 QQ 号 ${gateway.selfId ?? '未知'}）。`,
          '',
          '请写一句欢迎他的话，要求：',
          '- 一句话，最多 25 字，口语，别用「欢迎加入本群」这种套话',
          '- 可以带一点你自己的语气/梗，但别强行幽默',
          '- **开头必须包含 [CQ:at,qq=' + (evt.user_id ?? '') + '] 来 @ 他**，否则他不知道在跟他说话',
          '- 不要介绍群规（你不是管理员），不要说自己是 AI，不要长篇',
          '- 只输出这一句话本身，不要解释',
        ].join('\n') },
      ]
      const { text } = await dsh.prompt(welcomeSessionId, blocks)
      const line = (text || '').trim().split('\n').filter(l => l.trim())[0] ?? ''
      if (!line) { logger.log('欢迎语为空，跳过'); return }
      // 保证 @ 段存在：模型可能忘了。同时支持两种写法：新式 [AT:qq] 与旧式 CQ 码
      const atSeg = { type: 'at', data: { qq: String(evt.user_id) } }
      const hasAt = /\[CQ:at,qq=/.test(line) || /\[AT:\d+\]/.test(line)
      logger.log(`欢迎新群友 ${evt.user_id} -> ${groupId}: ${JSON.stringify(line.slice(0, 60))}`)
      if (hasAt) {
        // 模型直接给了 CQ 码字符串，转成消息段发（发送时用 message 段更稳）
        const cleaned = line.replace(/\[CQ:at,qq=\d+\]/g, '').replace(/\[AT:\d+\]/g, '').trim()
        await gateway.callData('send_group_msg', {
          group_id: Number(groupId),
          message: [atSeg, ...(cleaned ? [{ type: 'text', data: { text: ' ' + cleaned } }] : [])],
        }, 20000)
      } else {
        await gateway.callData('send_group_msg', {
          group_id: Number(groupId),
          message: [atSeg, { type: 'text', data: { text: ' ' + line } }],
        }, 20000)
      }
    } catch (err) {
      logger.log(`欢迎流程失败，退回固定文案: ${err.message}`)
      try {
        await gateway.callData('send_group_msg', {
          group_id: Number(groupId),
          message: [{ type: 'at', data: { qq: String(evt.user_id) } }, { type: 'text', data: { text: ' ' + text } }],
        }, 20000)
      } catch { /* ignore */ }
    } finally {
      busy.delete(peerKey)
    }
  })()
}

// ── 戳一戳 ──────────────────────────────────────────────────────────────────
// OneBot11 的 poke 通知里，sender_id=发起者，target_id=被戳的人，group_id 可选。
// 只处理「戳的是我」的情况；别人互相戳不打扰模型（也不该刷屏）。
async function handlePoke(evt) {
  const cfg = config.poke ?? {}
  if (cfg.enabled === false) return
  const target = String(evt.target_id ?? evt.target ?? '')
  const senderId = String(evt.sender_id ?? evt.user_id ?? '')
  const selfId = String(gateway.selfId ?? '')
  if (!target || !selfId || target !== selfId) {
    logger.debug(`忽略别人的戳一戳 ${senderId} -> ${target}`)
    return
  }
  if (senderId === selfId) return // 自己戳的自己，忽略
  const isGroup = !!evt.group_id
  const peer = isGroup ? { id: String(evt.group_id), scope: 'group' } : { id: senderId, scope: 'c2c' }
  const peerKey = peerKeyOf(peer)
  if (busy.has(peerKey)) {
    logger.log(`${peerKey} 正忙，戳一戳先记账不回应`)
    return
  }
  busy.add(peerKey)
  ;(async () => {
    try {
      const who = isGroup ? `群 ${peer.id} 里的 ${senderId}` : `${senderId}`
      const persona = readPersona()
      const blocks = [
        { type: 'text', text: [
          persona.text ? `【人设】未变化，仍以 ${PERSONA_PATH} 为准。` : `【人设文件缺失】${PERSONA_PATH}`,
          '',
          `【有人在 QQ 上戳了你（拍了拍你）】`,
          `谁戳的：${who}（QQ号 ${senderId}）`,
          isGroup ? `群号：${peer.id}` : null,
          `你的 QQ 号：${selfId}`,
          '',
          '这是 QQ 的「戳一戳」互动，不是普通消息。你可以：',
          `- 戳回去：输出 [POKE:${senderId}]（不要文字也行）`,
          `- 说句话回应：正常输出文字`,
          `- 完全不理会：只输出 [SILENT]`,
          '',
          '别每次都一本正经回应，看心情和你跟这人的关系。一句话就够，别长篇。',
          `- 想真 @ 他就写 [AT:${senderId}]（会弹出提醒）`,
        ].filter(Boolean).join('\n') },
      ]
      const { text } = await dsh.prompt(PROTOCOL === 'acp' ? peerKey : sessionIdFor(peerKey), blocks)
      const silentMarked = /\[SILENT\]/i.test(text)
      const body = String(text || '').replace(/\[SILENT\]/gi, '').trim()
      const { sent } = await dispatchOutbound(peer, body, { tag: '戳一戳' })
      if (!sent) {
        logger.log(`戳一戳 -> 选择不理会（${peerKey}${silentMarked ? '，[SILENT]' : ''}）`)
        return
      }
      logger.log(`戳一戳已回应 ${peerKey}`)
    } catch (err) {
      logger.log(`戳一戳处理失败: ${err.message}`)
      // 兜底：戳回去，别让对方戳了个寂寞
      try { await sendPokeTo(peer, senderId) } catch { /* ignore */ }
    } finally {
      busy.delete(peerKey)
      // 戳一戳期间对方发来的消息会入队 —— 这里也要排空，否则要等下一条消息才动
      drainPendingIngress(peerKey, peer).catch(err => logger.log(`排空队列异常 ${peerKey}: ${err.message}`))
    }
  })()
}

gateway.onEvent = evt => {
  // 戳一戳：notice_type = poke（NapCat/OneBot11 扩展）。
  // 有人戳我 → 让模型知道，并允许它回应（戳回去 / 说话 / 不理）。
  if (evt.post_type === 'notice' && (evt.notice_type === 'poke' || evt.notice_type === 'notify' && evt.sub_type === 'poke')) {
    try { handlePoke(evt) } catch (err) { logger.log(`handlePoke 异常: ${err.message}`) }
    return
  }
  if (evt.post_type === 'notice' && evt.notice_type === 'group_increase') {
    try { handleGroupIncrease(evt) } catch (err) { logger.log(`handleGroupIncrease 异常: ${err.message}`) }
    return
  }
  // 只打 message 的话，ReferenceError 这种「不知道在哪一行」的错就没线索了，
  // 所以顺带打前几帧堆栈（本地文件路径能直接对上代码）。
  handleInbound(evt).catch(err => {
    const where = String(err?.stack ?? '').split('\n').slice(1, 4).map(s => s.trim()).join(' ← ')
    logger.log(`handleInbound 未捕获异常: ${err?.message}${where ? `\n  ${where}` : ''}`)
  })
}

// ── 压缩感知：上下文被 compaction 压掉之后，人设全文要重新注入一次 ──────────
// compaction 会把旧历史换成摘要，我们早先注入的人设全文可能落进被压缩区间。
// 所以一旦看到本 peer 的会话发生 compaction/end，就清掉 personaHash，
// 让下一轮重新注入全文（这样人设不会"失忆"）。
dsh.onEvent((sessionId, event) => {
  // SDK 事件有 type；ACP 的 update 有 sessionUpdate。压缩事件两边都按 type 判断。
  const evType = event?.type ?? event?.sessionUpdate
  if (evType !== 'compaction/end') return
  for (const peerKey of Object.keys(state.peers)) {
    if (state.peers[peerKey].sessionId !== sessionId) continue
    if (state.peers[peerKey].personaHash) {
      delete state.peers[peerKey].personaHash
      saveState()
      logger.log(`会话 ${sessionId} 发生上下文压缩，${peerKey} 的人设将在下一轮重新注入`)
    }
    (state.peers[peerKey].compactions = (state.peers[peerKey].compactions ?? 0) + 1)
    saveState()
  }
})

// ── 会话轮数上限：防止单个群会话无限增长 ────────────────────────────────────
// 超过上限就换一个新 sessionId（并清掉人设哈希，新会话会重新注入全文）。
// 旧会话仍留在磁盘上可追溯，但不再参与后续请求。
const MAX_TURNS_PER_SESSION = config.policy?.maxTurnsPerSession ?? 400

function rolloverIfNeeded(peerKey) {
  const ps = state.peers[peerKey]
  if (!ps || (ps.turns ?? 0) < MAX_TURNS_PER_SESSION) return false
  const old = ps.sessionId
  ps.sessionId = `session-qq-${crypto.randomUUID()}`
  ps.createdAt = Date.now()
  ps.turns = 0
  ps.rolledFrom = old
  delete ps.personaHash // 新会话要重新注入人设
  saveState()
  logger.log(`${peerKey} 已达 ${MAX_TURNS_PER_SESSION} 轮，切换新会话 ${old} -> ${ps.sessionId}`)
  return true
}

// ── 本地 HTTP 状态/发送 API（运维用，只绑 127.0.0.1）──────────────────────
const API_BODY_LIMIT = config.server?.bodyLimitBytes ?? 1024 * 1024

/**
 * 恒定时间比较 token。
 * 原来是 `req.headers['authorization'] !== \`Bearer ${sc.token}\`` —— 按字节短路，
 * 理论上可以按响应耗时逐位猜。改成比较两侧的 sha256，长度固定且不泄漏前缀。
 */
function tokenMatches(got, want) {
  const a = crypto.createHash('sha256').update(String(got ?? '')).digest()
  const b = crypto.createHash('sha256').update(String(want ?? '')).digest()
  return crypto.timingSafeEqual(a, b)
}

/**
 * 读 JSON 请求体，带体积上限。
 * 原来是 `for await (const chunk of req) body += chunk` —— 没有上限，本机任何进程
 * （或网页里的一段 fetch）都能把桥的内存喂爆。超限直接断连并回 413。
 */
async function readApiBody(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > API_BODY_LIMIT) {
      const err = new Error(`请求体超过 ${API_BODY_LIMIT} 字节`)
      err.statusCode = 413
      throw err
    }
    chunks.push(chunk)
  }
  if (!size) return null
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    const err = new Error('bad json')
    err.statusCode = 400
    throw err
  }
}

/**
 * 出站白名单：/send、/recall 会直接往某个 peer 发消息/撤回。
 * 入站一直有 allowGroups/allowUsers/allowC2C 这套闸，出站原来没有 ——
 * 只要拿到端口和 token 就能给任意人发消息（等于绕过主人设的白名单）。
 * 现在出站和入站用同一份策略。
 */
function outboundAllowed(peer) {
  const policy = config.policy ?? {}
  if (peer.scope === 'group') {
    if (policy.allowGroups?.length && !policy.allowGroups.includes(peer.id)) {
      return { ok: false, why: `群 ${peer.id} 不在 allowGroups` }
    }
    return { ok: true }
  }
  if (!policy.allowC2C) return { ok: false, why: 'allowC2C 已关闭' }
  if (policy.allowUsers?.length && !policy.allowUsers.includes(peer.id)) {
    return { ok: false, why: `用户 ${peer.id} 不在 allowUsers` }
  }
  return { ok: true }
}

async function handleApiRequest(req, res, send, sc) {
  let url
  try {
    url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
  } catch {
    // 畸形 URL 在原来会抛进 async handler 成为 unhandledRejection
    return send(400, { ok: false, error: 'bad url' })
  }
  // 鉴权在**所有**路由之前。
  // 原来 /qr 在鉴权之前放行，可二维码里编码的是含 uin+token 的登录 URL，
  // 扫到就能登这个 QQ 号 —— 它是机密，不是「可以公开看的图片」。
  // 没配置 token 时不校验（纯本机自用，且 server 默认只绑 127.0.0.1）。
  if (sc.token && !tokenMatches(req.headers['authorization'], `Bearer ${sc.token}`)) {
    return send(401, { ok: false, error: 'unauthorized' })
  }
  if (url.pathname === '/qr' || url.pathname === '/qr.png') {
    const p = path.join(ROOT, 'llminqq-qr.png')
    if (!fs.existsSync(p)) return send(404, { ok: false, error: 'no qr yet; run scripts/qr.sh' })
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
    return res.end(fs.readFileSync(p))
  }
  if (url.pathname === '/health') {
    return send(200, {
      ok: true,
      onebot: { online: gateway.online, selfId: gateway.selfId, nickname: gateway.nickname, url: config.onebot.wsUrl },
      dsh: {
        ready: dsh.ready,
        profile: DSH_PROFILE,
        route: `${config.dsh.provider}/${config.dsh.model}`,
        currentRoute: `${routeState.current.provider}/${routeState.current.model}`,
        failover: {
          enabled: FAILOVER.enabled,
          fallbackCount: ROUTE_FALLBACKS.length,
          fallbackIndex: routeState.fallbackIndex,
          consecutiveFailures: routeState.consecutiveFailures,
          switches: routeState.switches,
          lastSwitchAt: routeState.lastSwitchAt || null,
        },
      },
      peers: Object.keys(state.peers).length,
      busy: [...busy],
      persona: { path: PERSONA_PATH, exists: !!readPersona().text },
      recall: {
        ttlMs: RECALL_TTL_MS, maxPerMinute: RECALL_RATE_MAX, historyMax: RECALL_HISTORY_MAX,
        trackedPeers: sentMessages.size,
      },
      sessions: state.peers,
    })
  }
  if (url.pathname === '/peers') return send(200, { ok: true, peers: state.peers })
  // 运维/自测用：看某个 peer 最近发过哪些消息（撤回历史）+ 手动触发一次撤回。
  // 和 /send 一样走同一份逻辑，不额外开权限面；token 保护由上面统一拦。
  if (url.pathname === '/sent') {
    const peer = { id: String(url.searchParams.get('peerId') ?? ''), scope: url.searchParams.get('scope') ?? 'group' }
    if (!peer.id) return send(400, { ok: false, error: 'peerId required' })
    const list = (sentMessages.get(recallKeyOf(peer)) ?? []).map(x => ({ message_id: x.message_id, kind: x.kind, ageMs: Date.now() - x.ts }))
    return send(200, { ok: true, peer: recallKeyOf(peer), sent: list })
  }
  if (url.pathname === '/recall' && req.method === 'POST') {
    const payload = await readApiBody(req)
    if (!payload) return send(400, { ok: false, error: 'bad json' })
    const peer = { id: String(payload.peerId ?? payload.groupId ?? payload.userId ?? ''), scope: payload.scope ?? (payload.groupId ? 'group' : 'c2c') }
    if (!peer.id || peer.id === 'undefined') return send(400, { ok: false, error: 'peerId required' })
    const allow = outboundAllowed(peer)
    if (!allow.ok) return send(403, { ok: false, error: `不允许操作 ${peer.id}: ${allow.why}` })
    const idx = payload.index ?? (payload.last ? 1 : NaN)
    if (!Number.isInteger(Number(idx)) || Number(idx) < 1) return send(400, { ok: false, error: 'index (>=1) required' })
    try {
      const r = await performRecall(peer, Number(idx))
      return send(r.ok ? 200 : 409, { ok: r.ok, index: r.index, detail: r.detail })
    } catch (err) { return send(500, { ok: false, error: err.message }) }
  }
  if (url.pathname === '/send' && req.method === 'POST') {
    const payload = await readApiBody(req)
    if (!payload) return send(400, { ok: false, error: 'bad json' })
    const peer = { id: String(payload.peerId ?? payload.groupId ?? payload.userId), scope: payload.scope ?? (payload.groupId ? 'group' : 'c2c') }
    if (!peer.id || peer.id === 'undefined') return send(400, { ok: false, error: 'peerId required' })
    const allow = outboundAllowed(peer)
    if (!allow.ok) return send(403, { ok: false, error: `不允许发给 ${peer.id}: ${allow.why}` })
    try {
      if (payload.text) await sendTextTo(peer, String(payload.text))
      const sent = []
      for (const f of payload.files ?? []) {
        const check = isPathAllowedForSend(f)
        if (!check.ok) { sent.push({ file: f, ok: false, reason: check.reason }); continue }
        sent.push({ file: f, ok: await sendImageTo(peer, check.path) })
      }
      return send(200, { ok: true, files: sent })
    } catch (err) { return send(500, { ok: false, error: err.message }) }
  }
  return send(404, { ok: false, error: 'not found' })
}

function startApiServer() {
  const sc = config.server
  if (!sc?.enabled) return null
  const server = http.createServer((req, res) => {
    const send = (code, obj) => {
      if (res.headersSent) return
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(obj))
    }
    // 请求级兜底：任何未捕获异常都回 500 并记日志，而不是变成 unhandledRejection
    // 把整个桥带走（原来 API 里一个畸形请求就可能让机器人静默失联）。
    handleApiRequest(req, res, send, sc).catch(err => {
      logger.log(`ERROR 本地 API 处理失败 ${req.method} ${req.url}: ${err.message}`)
      send(err.statusCode ?? 500, { ok: false, error: err.message })
    })
  })
  server.on('error', err => logger.log(`ERROR 本地 API 服务异常: ${err.message}`))
  server.listen(sc.port, sc.host ?? '127.0.0.1', () => logger.log(`本地 API: http://${sc.host ?? '127.0.0.1'}:${sc.port}`))
  return server
}

// ── 启动 ────────────────────────────────────────────────────────────────────
async function main() {
  logger.log('=== LLMinQQ bridge 启动 ===')
  logger.log(`config: ${cfgPath}`)
  // 记忆能力自检：启动第一条就说清「记忆到底能不能用」。
  // 原来这里什么都不打 —— 缺 python/缺脚本时用户完全无从发现（「假开」的根源之一）。
  const memHealth = logMemoryHealth()
  const apiServer = startApiServer()
  pruneStaging()
  const pruneTimer = setInterval(pruneStaging, 3600 * 1000)
  pruneTimer.unref()
  timers.add(pruneTimer)

  // 启动前清理「孤儿 ACP 进程」。
  // 桥每次重启都会 spawn 一个新的 `dsh --profile llminqq-acp`，但如果桥被
  // SIGKILL / 异常退出，子进程会变孤儿一直挂着（每个约 240MB）。
  // 实测：一天下来积了 30 个占 7.2G，最老挂了 21 小时。
  // 清理脚本只杀「PPid=1 的真孤儿」+「profile 名精确匹配」，不会误杀活着的桥的子进程。
  try {
    const { execFileSync } = await import('node:child_process')
    const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'cleanup-orphan-acp.mjs')
    if (fs.existsSync(script)) {
      const out = execFileSync(process.execPath, [script, '--kill', '--profile', DSH_PROFILE],
        { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] })
      for (const line of String(out).split('\n')) {
        if (line.includes('孤儿') || line.includes('已杀')) logger.log(line.replace('[cleanup-acp] ', 'acp清理: '))
      }
    }
  } catch (err) {
    // 清理失败不影响启动
    logger.log(`acp 孤儿清理跳过（不影响启动）: ${String(err.message).slice(0, 100)}`)
  }

  startProactiveLoop()
  startEnergyLoop()
  startMoodLoop()
  dsh.start().catch(err => logger.log(`dsh 预热失败（首次消息时会重试）: ${err.message}`))
  await gateway.start()
  logger.log('onebot 网关已启动，等待消息')

  let shuttingDown = false
  const shutdown = async sig => {
    if (shuttingDown) return
    shuttingDown = true
    logger.log(`收到 ${sig}，正在关闭…`)
    // 顺序：先停入站（网关），再停模型侧（dsh），最后落盘。
    // 原来两个 stop 都是「调了不 await」：dsh.stop 内部要结束子进程/会话，
    // 不等它就 process.exit 会留下孤儿 ACP 进程（实测一天能堆 30 个）。
    try { gateway.stop() } catch (err) { logger.log(`WARN 关闭网关失败: ${err.message}`) }
    try {
      await Promise.race([Promise.resolve(dsh.stop()).catch(() => {}), sleep(2500)])
    } catch (err) { logger.log(`WARN 关闭 dsh 失败: ${err.message}`) }
    try { apiServer?.close() } catch { /* ignore */ }
    // 定时器要显式清掉：否则 shutdown 期间还会排新任务（接话 tick 可能刚好在发消息）
    for (const t of timers) clearInterval(t)
    timers.clear()
    // 落盘改同步等待：原来只是 saveState()（500ms 去抖），紧接着 600ms 后 exit
    // 有时定时器还没跑 —— 最后几条会话映射/好感度直接丢。
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
    flushState()
    try { logStream.end() } catch { /* ignore */ }
    await sleep(150)
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch(err => {
  logger.log(`致命错误: ${err.stack ?? err.message}`)
  process.exit(1)
})
