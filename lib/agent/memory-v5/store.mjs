// lib/agent/memory-v5/store.mjs —— 记忆 v5 的**数据层**（Step 1 前半）
// ============================================================================
// 这是 docs/MEMORY-AUDIT-AND-V5.md §3.1 那套 DDL 的 Node 实现。设计原则里有
// 三条是「v4 踩过、v5 必须靠结构解决」的，写代码时不能丢：
//
//   ① **先存原文，再谈提炼**（events 只追加、不改写）。v4 的写入链是
//      `桥 → 文本日志 → 正则解析 → 入库`，于是被截断（P1-1）、被排版前缀污染
//      （P0-5）、靠字节游标丢数据（P0-6）。v5 让桥**直接 INSERT events**，
//      全文不截断，所有 memories 都能追溯到一条原始消息（source_event）。
//
//   ② **一份数据一个真源**：原文在 events、结论在 memories、我自己的话在
//      utterances。谁都不许「一张大表靠 kind 区分」（v4 的 retired 一列兼
//      「归档」和「完成」两义，逼出了 `已完成：` 文本前缀这种补丁）。
//
//   ③ **重放必须安全**：events 上有 `UNIQUE(conv, msg_id)`。v4 靠 fp 文本指纹
//      事后去重，历史算法变过 → 库里留下 162 组同 peer 重复。现在「写两次」
//      从根上不会产生第二行（见 appendEvent 的幂等语义）。
//
// ── 为什么用 node:sqlite（而不是继续走 python）─────────────────────────────
// §3.5 实测：5000 条插入（单事务）8.5ms；200 次并发读写锁冲突 0（WAL +
// busy_timeout）。桥是长驻进程，每轮都要写，起一次 python 进程（~70ms 冷启动）
// 只为插一行是不可接受的；而设置页读库也不需要再起 python（v4 就常因为
// 「只读连接遇热日志」静默降级，见 P2）。
//
// ⚠️ node:sqlite 在 Node ≥22.5 内建、实验特性（会打一次 ExperimentalWarning，
// 可忽略）。仓库里已有同样用法（lib/index.js 的 memoryHealthForUi），这里沿用
// createRequire 的取法：取不到就给一条**能看懂**的错误，而不是让插件加载失败。
//
// ── 与 python 侧（v4）的关系 ────────────────────────────────────────────────
// Step 1 是**双写**：旧 memctl 链路一个字都不改，注入仍读旧库。这个模块只负责
// 新库（`<stateDir>/mem-v5.db`）。v4 的 `mem.db` 与新库互不影响，出问题把开关
// 关掉就能退回 —— 所以本文件绝不读写 mem.db。
//
// ── 桥侧接入契约（一句话版）────────────────────────────────────────────────
//   import { openV5, v5DbPath } from './memory-v5/store.mjs'
//   const v5 = openV5({ dbPath: v5DbPath(cfg) })            // 进程内开一次，别每轮开
//   v5.appendEvent({ conv, msgId, speaker, text, at, kindRaw, meta })   // 幂等
//   v5.appendUtterance({ conv, text, at, kind })            // 「我说过什么」
//   然后每轮（或定时）v5.claimDueJobs() → v5.finishJob(id, ...) 跑提炼。
//   完整签名见文件末尾的 `V5_STORE_API` 注释块，以及各函数自己的 JSDoc。
// ============================================================================
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { memoryStateDir } from '../dirs.mjs'

// ── 依赖探测（缺 node:sqlite 时给一条能看懂的错，而不是 undefined is not a constructor）──
let DatabaseSync = null
let sqliteLoadError = null
try {
  const req = createRequire(import.meta.url)
  ;({ DatabaseSync } = req('node:sqlite'))
} catch (err) {
  sqliteLoadError = err
}

/**
 * v5 库的默认路径：`<stateDir>/mem-v5.db`。
 *
 * 为什么和 v4 的 mem.db 放同一个 stateDir：同一份数据的「新旧两个引擎」必须
 * 在同一个目录里，迁移/备份/换机器时不能漏；文件名带 `-v5` 是为了**绝不**
 * 和 v4 的 `mem.db` 混（Step 4 下线 v4 后它才可能改回 mem.db）。
 *
 * @param {object} [cfg] 插件配置（readConfig() 的返回值）
 * @returns {string}
 */
export function v5DbPath (cfg = {}) {
  return path.join(memoryStateDir(cfg), 'mem-v5.db')
}

/** 当前 schema 版本。以后加列/建表要 bump，并在 openV5 里做增量迁移。 */
export const V5_SCHEMA_VERSION = 1

/** 允许的归档原因（§3.4 的三种遗忘机制 + done/merged）。 */
export const ARCHIVE_REASONS = Object.freeze([
  'expired',    // 时间失效：valid_until < now（「明天三点开会」过期）
  'superseded', // 版本取代：同 key 出现新条目（「安全底裤还没做」→「已生效」）
  'pruned',     // 价值退场：salience 低 + 访问少 + 太旧
  'done',       // 待办完成（v4 靠文本前缀 `已完成：` 反推，v5 是一列）
  'merged',     // 合并进另一条（人工/迁移用）
])

/** 记忆类型白名单（和文档注释一致）。 */
export const MEMORY_TYPES = Object.freeze([
  'fact', 'preference', 'commitment', 'episode', 'rule', 'relation',
])

/** 作业类别白名单。 */
export const JOB_KINDS = Object.freeze(['distill', 'learn', 'profile', 'expire'])

/**
 * 建表 DDL —— 和 docs §3.1 一一对应（mem_fts 的 external content 用法有个必须知道
 * 的细节，见那一段的注释；另加了一张 doc 里没有的 v5_meta，只存 schema 版本）。
 *
 * 为什么全是 `IF NOT EXISTS`：openV5 会在**每个进程**启动时跑一次（桥、调度器、
 * 设置页的只读查询都可能是不同进程）。幂等是硬要求，不然第二次启动就炸。
 */
const DDL = [
  // ① 事件流（原文，只追加）
  `CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY,
    conv        TEXT NOT NULL,
    msg_id      TEXT,
    speaker     TEXT NOT NULL,
    text        TEXT NOT NULL,
    at          REAL NOT NULL,
    ingested_at REAL NOT NULL,
    kind_raw    TEXT,
    meta        TEXT,
    UNIQUE(conv, msg_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_events_conv_at ON events(conv, at DESC)`,

  // ② 记忆条目（结论，可归档/可取代/可过期）
  `CREATE TABLE IF NOT EXISTS memories (
    id           INTEGER PRIMARY KEY,
    type         TEXT NOT NULL,
    subject      TEXT,
    conv         TEXT,
    speaker      TEXT,
    text         TEXT NOT NULL,
    key          TEXT,
    confidence   REAL NOT NULL DEFAULT 0.6,
    salience     REAL NOT NULL DEFAULT 0.5,
    state        TEXT NOT NULL DEFAULT 'active',
    archived_reason TEXT,
    valid_from   REAL,
    valid_until  REAL,
    superseded_by INTEGER,
    source_event INTEGER REFERENCES events(id),
    scope        TEXT NOT NULL DEFAULT 'public',
    created      REAL NOT NULL,
    last_seen    REAL NOT NULL,
    access_count INTEGER NOT NULL DEFAULT 0,
    last_access  REAL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_mem_subject ON memories(subject, state)`,
  `CREATE INDEX IF NOT EXISTS idx_mem_type ON memories(type, state)`,
  `CREATE INDEX IF NOT EXISTS idx_mem_valid ON memories(valid_until)`,

  // ③ 检索索引：bigram 预分词后的 FTS5（文档 §3.1 的 DDL 原样，
  //    content='memories' / content_rowid='id'）
  //
  // ⚠️ 用 external content 表 + **自己写分词后的 tok** 是这里的组合关键：
  //    FTS5 在 external content 模式下「写」是自由的（INSERT INTO mem_fts(rowid,tok)
  //    存的就是索引），只有「读列 / rebuild」时才会回 content 表取原文 —— 而我们
  //    的查询只用到 `rowid` 和 `bm25(mem_fts)`（纯索引侧），从不 select tok，
  //    所以既享受 external content 的 id 对齐，又能真的用上 bigram。
  //    这也是为什么 reindexFts() 是手写的（delete-all + 逐行重新喂分词结果）：
  //    FTS5 内建的 `'rebuild'` 命令会去 content 表找 `tok` 列，而 memories 里
  //    没有这一列（我们不想把分词结果冗余进正文表）。code 里别改成 rebuild。
  `CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts USING fts5(
    tok, content='memories', content_rowid='id', tokenize='unicode61'
  )`,

  // ④ 人物画像
  `CREATE TABLE IF NOT EXISTS profiles (
    subject   TEXT PRIMARY KEY,
    nickname  TEXT,
    summary   TEXT,
    prefs     TEXT,
    dislikes  TEXT,
    facts     TEXT,
    updated   REAL
  )`,

  // ⑤ 我说过什么（防复读）
  `CREATE TABLE IF NOT EXISTS utterances (
    id   INTEGER PRIMARY KEY,
    conv TEXT NOT NULL,
    text TEXT NOT NULL,
    at   REAL NOT NULL,
    kind TEXT,
    thread TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_utt_conv_at ON utterances(conv, at DESC)`,

  // ⑥ 作业队列（提炼/学习/画像/过期清理）
  `CREATE TABLE IF NOT EXISTS jobs (
    id       INTEGER PRIMARY KEY,
    kind     TEXT NOT NULL,
    payload  TEXT,
    state    TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    next_at  REAL NOT NULL,
    last_error      TEXT,
    last_error_kind TEXT,
    created  REAL,
    updated  REAL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(state, next_at)`,
]

/** 元信息表：schema 版本等。文档 DDL 里没有，但「升级时要能判断库的版本」必须有。 */
const META_DDL = `CREATE TABLE IF NOT EXISTS v5_meta (
  k TEXT PRIMARY KEY,
  v TEXT
)`

// ── 小工具 ─────────────────────────────────────────────────────────────────

/** 当前时间（秒）。**全模块统一用秒**（和 v4 的 ts、DDL 的 REAL 一致）。 */
export function nowSec () {
  return Date.now() / 1000
}

/** 主线程可用的同步 sleep（只在 SQLITE_BUSY 重试之间用，5-20ms 级别）。 */
const sleepBuf = new Int32Array(new SharedArrayBuffer(4))
function sleepSync (ms) {
  try {
    Atomics.wait(sleepBuf, 0, 0, ms)
  } catch {
    /* 某些环境不允许 Atomics.wait（主线程）——那就别等，靠 busy_timeout */
  }
}

function isBusyError (err) {
  const msg = String(err?.message || err)
  return err?.errcode === 5 || /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked/i.test(msg)
}

/**
 * 中文/英文 → FTS5 的 token 列表。
 *
 * 为什么必须预分词：FTS5 的 unicode61 把连续 CJK 当一个「词」——
 * 「明天下午三点开会」整段是一个 token，所以 query「开会」永远命不中。
 * 切成 **2-gram**（相邻两字）后，任何长度 ≥2 的中文片段都能被覆盖：
 *   「明天下午三点开会」→ 明天 天午 午下 下午 午三 三点 点开 开会
 *   query「开会」→ [开会] → 命中 ✓
 *
 * 已知限制（文档 §3.3 明说）：**单字查询命不中**（库里没有 1-gram，
 * 除非原文就是单独一个字）。所以留了 searchLike() 作为回退。
 *
 * @param {string} text
 * @returns {string[]}
 */
export function ftsTokens (text) {
  const s = String(text ?? '')
  // CJK（含日文假名/韩文）+ ASCII 词。标点/空白是分隔符，不产生 token。
  const CJK = '\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\u3040-\\u30ff\\uac00-\\ud7af'
  const runs = s.match(new RegExp(`[${CJK}]+|[A-Za-z0-9_]+`, 'g')) || []
  const out = []
  for (const run of runs) {
    if (new RegExp(`^[${CJK}]`).test(run)) {
      if (run.length === 1) out.push(run)                 // 单字原文（如「累」单独成句）
      else for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2))
    } else {
      out.push(run.toLowerCase())
    }
  }
  return out
}

/** 把分词结果拼成 FTS 表里存的 `tok` 文本。 */
export function ftsDoc (text) {
  return ftsTokens(text).join(' ')
}

/**
 * 把用户 query 变成 FTS5 的 MATCH 表达式。
 *
 * 多个 bigram 之间用 **OR**（不是 AND）：自然语言查询「今天好累啊」拆出
 * 4 个 bigram，AND 会要求四段全中（几乎必然空），OR + BM25 排序才是
 * 检索该有的行为；阈值/预算由 Step 2 决定，这里只负责「给出候选 + 分数」。
 * token 用双引号包起来，避免 `-`、`*`、`NEAR` 这类被当成查询语法。
 *
 * @param {string} text
 * @returns {string} 空串 = 这份 query 产生不了任何 token（调用方应走 searchLike）
 */
export function ftsMatchQuery (text) {
  const uniq = [...new Set(ftsTokens(text))]
  if (!uniq.length) return ''
  return uniq.map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ')
}

function jsonOrNull (v) {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') return v          // 已经是 JSON 字符串就原样存
  return JSON.stringify(v)                     // 循环引用会抛 —— 由调用方看到明确错误
}

function parseJson (v, fallback = null) {
  if (v === null || v === undefined) return fallback
  if (typeof v !== 'string') return v
  try { return JSON.parse(v) } catch { return fallback }
}

// ── 打开库 ─────────────────────────────────────────────────────────────────

/**
 * 打开（必要时创建）v5 库，返回一个绑定了连接的 store。
 *
 * 每个进程建议只开一次（桥在起进程时开、调度器在起任务时开），不要每轮开 ——
 * 虽然 SQLite 打开很便宜，但每个连接都有自己的 WAL 读快照和 busy_timeout，
 * 开开关关反而更容易撞 busy。
 *
 * @param {object} opts
 * @param {string} opts.dbPath            库文件路径（父目录会自动创建）
 * @param {number} [opts.busyTimeoutMs=3000]  PRAGMA busy_timeout；v4 完全没有这个，
 *   两个写者会直接 `database is locked`（P2）
 * @param {number} [opts.deadLetterAfter=3]  连续失败几次进 dead（文档：distill 3 次）
 * @param {number} [opts.backoffBaseMs=60000] 重试退避基数（第 n 次失败等 base*2^(n-1)）
 * @param {number} [opts.backoffMaxMs=3600000] 退避上限
 * @param {number} [opts.busyRetries=3]   撞 SQLITE_BUSY 时的重试次数
 * @param {(m:string)=>void} [opts.log]
 * @returns {object} store（方法见文件末尾 API 契约）
 */
export function openV5 ({
  dbPath,
  busyTimeoutMs = 3000,
  deadLetterAfter = 3,
  backoffBaseMs = 60_000,
  backoffMaxMs = 60 * 60 * 1000,
  busyRetries = 3,
  log = () => {},
} = {}) {
  if (!dbPath) throw new Error('openV5: 必须给 dbPath（用 v5DbPath(cfg) 算）')
  if (!DatabaseSync) {
    throw new Error('openV5: 当前 Node 没有 node:sqlite（需要 Node ≥22.5）'
      + `：${sqliteLoadError?.message || '未知原因'}`)
  }
  const dir = path.dirname(dbPath)
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }) } catch { /* 已存在/无权限由 open 报 */ }

  const db = new DatabaseSync(dbPath)

  // ── PRAGMA：v4 一个都没有，这是「两个人同时写就报 database is locked」的根因 ──
  // WAL：读写并发（桥写事件不阻塞设置页读），且写入不 fsync 整个库
  // synchronous=NORMAL：WAL 下这个档位等于「断电可能丢最后几个事务，但不会坏库」，
  //   对聊天记忆完全够（丢了下一轮的消息还会再来）
  // busy_timeout=3000：撞锁先等 3 秒再报错，而不是立刻失败
  db.exec('PRAGMA journal_mode=WAL')
  db.exec('PRAGMA synchronous=NORMAL')
  db.exec(`PRAGMA busy_timeout=${Math.max(0, Math.floor(Number(busyTimeoutMs) || 0))}`)

  for (const sql of DDL) db.exec(sql)
  db.exec(META_DDL)

  // schema 版本：只在第一次写入；以后若不一致，这里就是升级钩子
  const metaGet = db.prepare('SELECT v FROM v5_meta WHERE k = ?')
  const metaSet = db.prepare('INSERT INTO v5_meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
  const schemaRow = metaGet.get('schema_version')
  if (!schemaRow) metaSet.run('schema_version', String(V5_SCHEMA_VERSION))

  // ── 事务 & busy 重试 ────────────────────────────────────────────────────
  // 为什么 BEGIN IMMEDIATE：默认的 DEFERRED 事务在「先读后写」时可能已经持有
  // 读锁，再想升级成写锁会直接 SQLITE_BUSY（而且 busy_timeout 也救不了它）；
  // IMMEDIATE 一开始就拿写锁，配合 busy_timeout 就是「排队等一下」。
  let depth = 0
  function retryBusy (fn, label) {
    let delay = 5
    for (let attempt = 0; ; attempt++) {
      try {
        return fn()
      } catch (err) {
        if (!isBusyError(err) || attempt >= busyRetries) throw err
        log(`v5: ${label} 撞锁（第 ${attempt + 1} 次），${delay}ms 后重试`)
        sleepSync(delay)
        delay *= 2
      }
    }
  }
  function tx (fn) {
    return retryBusy(() => {
      if (depth > 0) return fn()             // 嵌套：外层事务里直接跑（不吞错）
      db.exec('BEGIN IMMEDIATE')
      depth += 1
      try {
        const r = fn()
        db.exec('COMMIT')
        return r
      } catch (err) {
        try { db.exec('ROLLBACK') } catch { /* 回滚失败就让原错误抛出去 */ }
        throw err
      } finally {
        depth -= 1
      }
    }, '事务')
  }

  /** 事务外单条写：也包一次重试（busy 时等一会儿再试）。 */
  const write = (fn, label = '写入') => retryBusy(fn, label)

  // ── 预编译语句（每方法自己 prepare 一次太浪费，集中在这里）──────────────
  const stmt = {
    insertEvent: db.prepare(`INSERT OR IGNORE INTO events
      (conv, msg_id, speaker, text, at, ingested_at, kind_raw, meta)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    eventById: db.prepare('SELECT * FROM events WHERE id = ?'),
    eventByMsg: db.prepare('SELECT * FROM events WHERE conv = ? AND msg_id = ?'),
    lastEventId: db.prepare('SELECT last_insert_rowid() AS id'),

    insertMemory: db.prepare(`INSERT INTO memories
      (type, subject, conv, speaker, text, key, confidence, salience, state,
       valid_from, valid_until, superseded_by, source_event, scope, created, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    memoryById: db.prepare('SELECT * FROM memories WHERE id = ?'),
    lastMemoryId: db.prepare('SELECT last_insert_rowid() AS id'),

    archive: db.prepare(`UPDATE memories
      SET state = 'archived', archived_reason = ?,
          superseded_by = COALESCE(?, superseded_by),
          valid_until = COALESCE(?, valid_until)
      WHERE id = ? AND state = 'active'`),
    touch: db.prepare(`UPDATE memories SET access_count = access_count + 1, last_access = ?
      WHERE id = ? AND state = 'active'`),
    expireDue: db.prepare(`UPDATE memories SET state = 'archived', archived_reason = 'expired'
      WHERE state = 'active' AND valid_until IS NOT NULL AND valid_until < ?`),

    ftsInsert: db.prepare('INSERT INTO mem_fts(rowid, tok) VALUES (?, ?)'),
    // external content 表不能 DELETE（会报 "cannot DELETE from contentless fts5 table"
    // 或要求提供原值）；清空索引用专门的 `'delete-all'` 命令（3.43+ 支持，本机
    // SQLite 3.53 可用）。这批行只是索引，不碰 memories 本体。
    ftsClear: db.prepare("INSERT INTO mem_fts(mem_fts) VALUES('delete-all')"),
    memAllForIndex: db.prepare('SELECT id, text FROM memories'),

    insertUtterance: db.prepare('INSERT INTO utterances (conv, text, at, kind, thread) VALUES (?, ?, ?, ?, ?)'),
    lastUtteranceId: db.prepare('SELECT last_insert_rowid() AS id'),

    enqueueJob: db.prepare(`INSERT INTO jobs (kind, payload, state, attempts, next_at, created, updated)
      VALUES (?, ?, 'pending', 0, ?, ?, ?)`),
    lastJobId: db.prepare('SELECT last_insert_rowid() AS id'),
    dueJobs: db.prepare(`SELECT id FROM jobs
      WHERE state = 'pending' AND next_at <= ?
      ORDER BY next_at ASC, id ASC LIMIT ?`),
    markRunning: db.prepare(`UPDATE jobs SET state = 'running', attempts = attempts + 1, updated = ?
      WHERE id = ? AND state = 'pending'`),
    jobById: db.prepare('SELECT * FROM jobs WHERE id = ?'),
    finishDone: db.prepare(`UPDATE jobs SET state = 'done', last_error = NULL, last_error_kind = NULL,
      updated = ? WHERE id = ?`),
    finishRetry: db.prepare(`UPDATE jobs SET state = 'pending', next_at = ?, last_error = ?, last_error_kind = ?,
      updated = ? WHERE id = ?`),
    finishDead: db.prepare(`UPDATE jobs SET state = 'dead', last_error = ?, last_error_kind = ?,
      updated = ? WHERE id = ?`),

    upsertProfile: db.prepare(`INSERT INTO profiles (subject, nickname, summary, prefs, dislikes, facts, updated)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(subject) DO UPDATE SET
        nickname = COALESCE(excluded.nickname, profiles.nickname),
        summary  = COALESCE(excluded.summary, profiles.summary),
        prefs    = COALESCE(excluded.prefs, profiles.prefs),
        dislikes = COALESCE(excluded.dislikes, profiles.dislikes),
        facts    = COALESCE(excluded.facts, profiles.facts),
        updated  = excluded.updated`),
    profileBySubject: db.prepare('SELECT * FROM profiles WHERE subject = ?'),
  }

  // ── events ──────────────────────────────────────────────────────────────
  /**
   * 追加一条原始消息。**幂等**：同 (conv, msg_id) 重复调用返回 {inserted:false}。
   *
   * 幂等是 §3.5 的核心：日志轮转、游标错乱、进程重启都不会产生重复记忆。
   * ⚠️ msg_id 为 null 时**没有幂等性**（SQLite 的 UNIQUE 把 NULL 视为互不相等）——
   * 桥侧应尽量带 OneBot 的 message_id；确实没有的（比如主动发言）用
   * `msgId: 'out:' + 时间戳 + 随机` 之类自己造一个稳定值。
   *
   * @param {object} ev
   * @param {string} ev.conv       'c2c:3022464706' / 'group:1017567471'
   * @param {string|number|null} [ev.msgId]
   * @param {string} ev.speaker    'self' | QQ号
   * @param {string} ev.text       全文，**不截断**
   * @param {number} [ev.at]       秒（默认 nowSec()）
   * @param {string|null} [ev.kindRaw] text/image/voice/card/file/system
   * @param {object|string|null} [ev.meta] JSON（图片路径/卡片标题/BV号/转发来源）
   * @returns {{inserted:boolean, id:number|null}}
   */
  function appendEvent ({ conv, msgId = null, speaker = '', text, at = null, kindRaw = null, meta = null } = {}) {
    if (!conv) throw new Error('appendEvent: 缺 conv')
    if (text === undefined || text === null) throw new Error('appendEvent: 缺 text')
    const msg = msgId === null || msgId === undefined ? null : String(msgId)
    const ts = Number.isFinite(Number(at)) && Number(at) > 0 ? Number(at) : nowSec()
    const metaJson = jsonOrNull(meta)   // 循环引用/不可序列化会在这里抛（明确报错）
    return write(() => {
      const r = stmt.insertEvent.run(
        conv, msg, String(speaker ?? ''), String(text), ts, nowSec(), kindRaw, metaJson,
      )
      if (Number(r.changes) > 0) return { inserted: true, id: Number(stmt.lastEventId.get().id) }
      // 被 UNIQUE 挡掉：把已有那条的 id 还给调用方（幂等重放要能继续用这个 id）
      if (msg !== null) {
        const row = stmt.eventByMsg.get(conv, msg)
        if (row) return { inserted: false, id: Number(row.id) }
      }
      return { inserted: false, id: null }
    }, 'appendEvent')
  }

  /** 按 (conv, msg_id) 查事件（幂等重放/调试用）。 */
  function getEvent ({ conv, msgId }) {
    if (!conv || msgId === null || msgId === undefined) return null
    return stmt.eventByMsg.get(conv, String(msgId)) || null
  }

  /**
   * 批量追加（一个事务）。给迁移/补写用：§3.5 实测 5000 条单事务 8.5ms。
   * @param {Array<object>} events 同 appendEvent 的参数
   * @returns {{inserted:number, ids:number[]}} ids 与入参一一对应（重复的给已有 id）
   */
  function appendEvents (events = []) {
    const ids = []
    let inserted = 0
    tx(() => {
      for (const ev of events) {
        const r = appendEvent(ev)
        if (r.inserted) inserted += 1
        ids.push(r.id)
      }
    })
    return { inserted, ids }
  }

  // ── memories ────────────────────────────────────────────────────────────
  /**
   * 插入一条记忆（结论），同时写 FTS 索引 —— 同一个事务，不会出现「库里有、检索不到」。
   * @param {object} m
   * @param {string} m.type        fact|preference|commitment|episode|rule|relation
   * @param {string} m.text        一句话结论（第三人称、可独立读懂）
   * @param {string|null} [m.subject] 关于谁（QQ号）；null = 群级/公共
   * @param {string|null} [m.conv] [m.speaker]
   * @param {string|null} [m.key]  去重/取代键（type+subject+主题），Step 2 用它做 supersede
   * @param {number} [m.confidence=0.6] [m.salience=0.5]
   * @param {string} [m.state='active']
   * @param {number|null} [m.validFrom] [m.validUntil] 秒
   * @param {number|null} [m.sourceEvent]
   * @param {string} [m.scope='public'] public|dm_only
   * @param {number[]|null} [m.linkedEvents] 额外的来源事件（写进 meta? v5 暂不建多对多表）
   * @returns {{id:number}}
   */
  function insertMemory ({
    type, text, subject = null, conv = null, speaker = null, key = null,
    confidence = 0.6, salience = 0.5, state = 'active',
    validFrom = null, validUntil = null, supersededBy = null,
    sourceEvent = null, scope = 'public', created = null, lastSeen = null,
  } = {}) {
    if (!MEMORY_TYPES.includes(type)) {
      throw new Error(`insertMemory: 非法 type=${type}（允许：${MEMORY_TYPES.join('|')}）`)
    }
    if (text === undefined || text === null || String(text).trim() === '') {
      throw new Error('insertMemory: 缺 text')
    }
    const ts = Number.isFinite(Number(created)) && Number(created) > 0 ? Number(created) : nowSec()
    const seen = Number.isFinite(Number(lastSeen)) && Number(lastSeen) > 0 ? Number(lastSeen) : ts
    const tok = ftsDoc(text)
    return tx(() => {
      const r = stmt.insertMemory.run(
        type, subject, conv, speaker, String(text), key,
        Number(confidence) || 0, Number(salience) || 0, state,
        validFrom, validUntil, supersededBy, sourceEvent, scope, ts, seen,
      )
      const id = Number(stmt.lastMemoryId.get().id)
      if (tok) stmt.ftsInsert.run(id, tok)
      return { id, changes: Number(r.changes) }
    })
  }

  /** 按 id 取一条（原始行，meta 型字段都是 JSON 字符串）。 */
  function getMemory (id) {
    const row = stmt.memoryById.get(id)
    return row || null
  }

  /** 找「同 key 且 active」的旧条目 —— Step 2 的 supersede 要用（先给出现成的查询）。 */
  function findActiveByKey ({ type, subject = null, key }) {
    if (!key) return []
    return db.prepare(`SELECT * FROM memories
      WHERE state = 'active' AND key = ? AND type = ?
        AND (subject IS ? OR subject = ?)
      ORDER BY created DESC`).all(key, type, subject, subject)
  }

  /**
   * 归档一条记忆（§3.4 的三条遗忘机制统一走这里）。
   * @param {number} id
   * @param {string} reason  见 ARCHIVE_REASONS
   * @param {object} [extra]
   * @param {number|null} [extra.supersededBy] 被哪条取代（reason='superseded' 时必填）
   * @param {number|null} [extra.validUntil]   顺带补上时间边界（可选）
   * @returns {{archived:boolean, id:number, reason:string}}
   */
  function archiveMemory (id, reason, { supersededBy = null, validUntil = null } = {}) {
    if (!ARCHIVE_REASONS.includes(reason)) {
      throw new Error(`archiveMemory: 非法 reason=${reason}（允许：${ARCHIVE_REASONS.join('|')}）`)
    }
    return write(() => {
      const r = stmt.archive.run(reason, supersededBy, validUntil, id)
      return { archived: Number(r.changes) > 0, id: Number(id), reason }
    }, 'archiveMemory')
  }

  /**
   * 记一次「被用到」（检索命中并注入时调用）。访问次数是「价值退场」机制的输入，
   * 不记的话 pruned 判据就只能看 salience，等于把 v4 的毛病又带回来。
   * @param {number|number[]} ids
   * @returns {{touched:number}}
   */
  function touchMemory (ids) {
    const list = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Number.isFinite)
    if (!list.length) return { touched: 0 }
    const ts = nowSec()
    return write(() => {
      let n = 0
      tx(() => { for (const id of list) n += Number(stmt.touch.run(ts, id).changes) })
      return { touched: n }
    }, 'touchMemory')
  }

  /**
   * 低价值归档（§3.4 第三条「遗忘」）—— salience 低 + 访问少 + 够旧 → archived(pruned)。
   *
   * 🔴 2026-11-07：这条机制**设计文档里写了、代码里没有**。
   *   审计文档 §3 明确列了三条遗忘机制：
   *     ① valid_until < now  → expired      ✅ 已实现（dueExpire）
   *     ② 同 key 新版本       → superseded   ✅ 已实现（supersede）
   *     ③ salience 低+访问少  → pruned       ❌ **从来没实现过**
   *   P0-2 描述的 v4 病症就是这个：「库只增不减（886 条 live 里 74% 的 episodic
   *   已超过一个半衰期）」。v5 把前两条修好了，第三条一直缺着 ——
   *   所以 active 数只涨：上线 2 天已从 873 涨到 986，且没有任何回收路径。
   *
   * 为什么只清 **episode**：episode 是原始闲聊片段（「嘿嘿，听你的」），
   *   价值最低、量最大；fact/rule/preference/relation/commitment 是提炼出的结论，
   *   删它们风险大（可能是有用的长期事实）。宁可少清，不要误删结论。
   *
   * 判据（全部满足才归档，**保守**）：
   *   · type = 'episode'
   *   · state = 'active'
   *   · salience < maxSalience（默认 0.3）
   *   · access_count <= maxAccess（默认 0，即从没被检索命中过）
   *   · created < now - minAgeDays（默认 14 天，给足「以后可能想起来」的窗口）
   *   · valid_until IS NULL（有失效时间的**交给 dueExpire**，别抢它的活）
   *   · 不是 supersede 链上的新版（superseded_by IS NULL）
   *
   * 每轮限量 limit（默认 100）：万一判据写错，也只影响一小批，且可捞回。
   * 归档是 state 变更（不是 DELETE），随时能把 state 改回 active。
   *
   * @param {{now?:number, limit?:number, maxSalience?:number, maxAccess?:number, minAgeDays?:number}} [opts]
   * @returns {{pruned:number, ids:number[]}}
   */
  function pruneLowValue ({
    now = nowSec(), limit = 100, maxSalience = 0.3, maxAccess = 0, minAgeDays = 14,
  } = {}) {
    const ts = Number.isFinite(Number(now)) ? Number(now) : nowSec()
    const lim = Math.max(1, Math.min(500, Number(limit) || 100))
    const sal = Math.max(0, Math.min(1, Number(maxSalience)))
    const acc = Math.max(0, Math.floor(Number(maxAccess) || 0))
    const ageCutoff = ts - Math.max(0, Number(minAgeDays) || 0) * 86400
    return write(() => {
      const rows = db.prepare(`SELECT id FROM memories
        WHERE state = 'active' AND type = 'episode'
          AND salience < ? AND access_count <= ?
          AND created < ?
          AND superseded_by IS NULL
          AND valid_until IS NULL
        ORDER BY salience ASC, created ASC
        LIMIT ?`).all(sal, acc, ageCutoff, lim)
      if (!rows.length) return { pruned: 0, ids: [] }
      const ids = rows.map(r => Number(r.id))
      const upd = db.prepare(`UPDATE memories SET state = 'archived', archived_reason = 'pruned'
        WHERE id = ? AND state = 'active'`)
      let n = 0
      for (const id of ids) n += Number(upd.run(id).changes)
      return { pruned: n, ids }
    }, 'pruneLowValue')
  }

  /**
   * 时间失效：把 valid_until < now 的 active 记忆归档成 expired（§3.4 第一条）。
   * 幂等：第二次调用返回 0。
   * @param {number} [now] 秒
   * @returns {{expired:number}}
   */
  function dueExpire (now = nowSec()) {
    const ts = Number.isFinite(Number(now)) ? Number(now) : nowSec()
    return write(() => {
      const r = stmt.expireDue.run(ts)
      return { expired: Number(r.changes) }
    }, 'dueExpire')
  }

  // ── 检索 ────────────────────────────────────────────────────────────────
  /**
   * FTS 检索（BM25 由 SQLite 给，不用自己实现）。
   *
   * 只返回 **active** 的记忆（归档的不该被注入；要查历史传 includeArchived）。
   * `score` = -bm25（越大越相关）；原始 bm25 是负数、越负越相关。
   *
   * @param {object} q
   * @param {string} q.query
   * @param {number} [q.limit=8]
   * @param {string|string[]|null} [q.type]  过滤类型
   * @param {string|null} [q.subject]        过滤「关于谁」
   * @param {boolean} [q.includeArchived=false]
   * @returns {Array<{id:number,type:string,subject:string|null,text:string,state:string,bm25:number,score:number}>}
   */
  function searchFts ({ query, limit = 8, type = null, subject = null, includeArchived = false } = {}) {
    const match = ftsMatchQuery(query)
    if (!match) return []
    const lim = Math.max(1, Math.min(200, Number(limit) || 8))
    const params = [match]
    let sql = `SELECT m.id, m.type, m.subject, m.conv, m.speaker, m.text, m.state,
                      m.salience, m.confidence, m.valid_until, bm25(mem_fts) AS bm
               FROM mem_fts JOIN memories m ON m.id = mem_fts.rowid
               WHERE mem_fts MATCH ?`
    if (!includeArchived) sql += ` AND m.state = 'active'`
    if (type) {
      const types = Array.isArray(type) ? type : [type]
      sql += ` AND m.type IN (${types.map(() => '?').join(',')})`
      params.push(...types)
    }
    if (subject !== null && subject !== undefined) {
      sql += ' AND m.subject = ?'
      params.push(String(subject))
    }
    sql += ' ORDER BY bm ASC LIMIT ?'
    params.push(lim)
    return db.prepare(sql).all(...params).map(r => ({
      id: Number(r.id), type: r.type, subject: r.subject, conv: r.conv, speaker: r.speaker,
      text: r.text, state: r.state, salience: r.salience, confidence: r.confidence,
      validUntil: r.valid_until, bm25: Number(r.bm), score: -Number(r.bm),
    }))
  }

  /**
   * 单字/极短查询的**回退**：直接 LIKE 扫描。
   *
   * 为什么需要（文档 §3.3 已知限制）：bigram 索引里没有 1-gram，query「累」
   * 在 FTS 里永远空。886 条库全表扫描 <1ms，所以回退是划算的。
   *
   * @param {object} q 同 searchFts（query 逐字 LIKE，不支持分词）
   * @returns {Array<{id,type,subject,text,state,score}>}
   */
  function searchLike ({ query, limit = 8, type = null, subject = null, includeArchived = false } = {}) {
    const q = String(query ?? '').trim()
    if (!q) return []
    const lim = Math.max(1, Math.min(200, Number(limit) || 8))
    // LIKE 的通配符要转义，否则用户 query 里的 % / _ 会变成通配
    const esc = q.replace(/[\\%_]/g, m => '\\' + m)
    const params = [`%${esc}%`]
    let sql = `SELECT id, type, subject, conv, speaker, text, state, salience, confidence
               FROM memories WHERE text LIKE ? ESCAPE '\\'`
    if (!includeArchived) sql += ` AND state = 'active'`
    if (type) {
      const types = Array.isArray(type) ? type : [type]
      sql += ` AND type IN (${types.map(() => '?').join(',')})`
      params.push(...types)
    }
    if (subject !== null && subject !== undefined) {
      sql += ' AND subject = ?'
      params.push(String(subject))
    }
    sql += ' ORDER BY salience DESC, last_seen DESC LIMIT ?'
    params.push(lim)
    return db.prepare(sql).all(...params).map(r => ({
      id: Number(r.id), type: r.type, subject: r.subject, conv: r.conv, speaker: r.speaker,
      text: r.text, state: r.state, salience: r.salience, confidence: r.confidence,
      // LIKE 没有相关性分数：用 salience 当序（Step 2 会给它一个真正的归一化分数）
      score: Number(r.salience) || 0, bm25: null,
    }))
  }

  /**
   * 「该不该走 LIKE 回退」的钩子（Step 2 用；现在只是把判据定下来，方便桥侧/检索层
   * 共用同一份规则，别各写一套）。
   *
   * 规则：FTS 没结果 & query 里存在**单字**（去掉标点后长度 1 的中文段）→ 回退。
   * 注意不是「结果少就回退」：那会让每轮都多一次全表扫描。
   *
   * @param {string} query
   * @param {Array} ftsResults
   * @returns {boolean}
   */
  function shouldFallbackToLike (query, ftsResults = []) {
    if (Array.isArray(ftsResults) && ftsResults.length > 0) return false
    const s = String(query ?? '').trim()
    if (!s) return false
    // 去掉 ASCII/标点后，剩下来的中文段里有没有「长度 1 的独立段」
    const runs = s.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g) || []
    return runs.some(r => r.length === 1)
  }

  /**
   * 一步到位的检索入口：FTS → （满足条件时）LIKE 回退。
   * @param {object} q searchFts 的参数 + {fallbackToLike?: boolean}
   * @returns {Array} 同 searchFts；带 `via: 'fts'|'like'` 方便观测
   */
  function searchMemories ({ fallbackToLike = true, ...q } = {}) {
    const fts = searchFts(q).map(r => ({ ...r, via: 'fts' }))
    if (fts.length > 0 || !fallbackToLike) return fts
    if (!shouldFallbackToLike(q.query, fts)) return fts
    return searchLike(q).map(r => ({ ...r, via: 'like' }))
  }

  /** 从 memories 重建 FTS 索引（迁移后 / 索引坏了时用）。幂等。 */
  function reindexFts () {
    return tx(() => {
      stmt.ftsClear.run()
      let n = 0
      for (const row of stmt.memAllForIndex.all()) {
        const tok = ftsDoc(row.text)
        if (!tok) continue
        stmt.ftsInsert.run(row.id, tok)
        n += 1
      }
      return { indexed: n }
    })
  }

  // ── utterances（我说过什么，防复读）──────────────────────────────────────
  /**
   * 记一句「我自己说过的话」。和 memories 分家：这是**原文**，不是结论。
   * @returns {{id:number}}
   */
  function appendUtterance ({ conv, text, at = null, kind = 'text', thread = null } = {}) {
    if (!conv) throw new Error('appendUtterance: 缺 conv')
    if (text === undefined || text === null) throw new Error('appendUtterance: 缺 text')
    const ts = Number.isFinite(Number(at)) && Number(at) > 0 ? Number(at) : nowSec()
    return write(() => {
      stmt.insertUtterance.run(conv, String(text), ts, kind, thread)
      return { id: Number(stmt.lastUtteranceId.get().id) }
    }, 'appendUtterance')
  }

  /** 最近 N 句我说过的话（防复读/Step 2 的相似度检查用）。 */
  function recentUtterances ({ conv = null, limit = 20 } = {}) {
    const lim = Math.max(1, Math.min(500, Number(limit) || 20))
    return conv
      ? db.prepare('SELECT * FROM utterances WHERE conv = ? ORDER BY at DESC LIMIT ?').all(conv, lim)
      : db.prepare('SELECT * FROM utterances ORDER BY at DESC LIMIT ?').all(lim)
  }

  // ── jobs（提炼/学习/画像/过期清理）───────────────────────────────────────
  /**
   * 入队一个作业。
   * @param {object} j
   * @param {string} j.kind  distill|learn|profile|expire
   * @param {object|string|null} [j.payload]
   * @param {number} [j.nextAt] 秒；默认立刻可跑
   * @returns {{id:number}}
   */
  function enqueueJob ({ kind, payload = null, nextAt = null } = {}) {
    if (!JOB_KINDS.includes(kind)) {
      throw new Error(`enqueueJob: 非法 kind=${kind}（允许：${JOB_KINDS.join('|')}）`)
    }
    const ts = nowSec()
    const due = Number.isFinite(Number(nextAt)) && Number(nextAt) > 0 ? Number(nextAt) : ts
    return write(() => {
      stmt.enqueueJob.run(kind, jsonOrNull(payload), due, ts, ts)
      return { id: Number(stmt.lastJobId.get().id) }
    }, 'enqueueJob')
  }

  /**
   * 认领到期的作业（pending → running，attempts + 1）。
   *
   * 为什么在**认领时**就把 attempts 加一：如果作业把 worker 弄崩了（bug），
   * 只在 finish 时加的话它永远停在 attempts=0 → 无限重跑、永远进不了死信。
   * 现在崩一次也算一次，3 次之后它会自己躺进 dead，等设置页显示/人来看。
   *
   * 原子性：SELECT + UPDATE 在同一个 BEGIN IMMEDIATE 事务里 —— 两个 worker
   * 并发认领时，第二个的 UPDATE 会因 `state='pending'` 条件不满足而拿到 0 行。
   *
   * @param {object} [opts]
   * @param {number} [opts.now] 秒
   * @param {number} [opts.limit=10]
   * @param {string|string[]|null} [opts.kinds]
   * @returns {Array<{id:number, kind:string, payload:any, attempts:number, nextAt:number}>}
   */
  function claimDueJobs ({ now = nowSec(), limit = 10, kinds = null } = {}) {
    const ts = Number.isFinite(Number(now)) ? Number(now) : nowSec()
    const lim = Math.max(1, Math.min(100, Number(limit) || 10))
    return tx(() => {
      // kinds 过滤必须在 **SQL 里**做：如果先 LIMIT 再在内存里过滤，
      // 「前 N 条恰好是别的 kind」时本 kind 的活会被永远饿死（且没有任何报错）。
      let rows
      if (kinds) {
        const allow = (Array.isArray(kinds) ? kinds : [kinds]).map(String).filter(Boolean)
        if (!allow.length) return []
        rows = db.prepare(`SELECT id FROM jobs
          WHERE state = 'pending' AND next_at <= ? AND kind IN (${allow.map(() => '?').join(',')})
          ORDER BY next_at ASC, id ASC LIMIT ?`).all(ts, ...allow, lim)
      } else {
        rows = stmt.dueJobs.all(ts, lim)
      }
      const out = []
      for (const row of rows) {
        const r = stmt.markRunning.run(ts, Number(row.id))
        if (Number(r.changes) === 0) continue          // 被别人抢了
        const fresh = stmt.jobById.get(Number(row.id))
        out.push({
          id: Number(fresh.id),
          kind: fresh.kind,
          payload: parseJson(fresh.payload),
          attempts: Number(fresh.attempts),
          nextAt: Number(fresh.next_at),
        })
      }
      return out
    })
  }

  /** 第 n 次失败后该等多久（指数退避，封顶 backoffMaxMs）。 */
  function backoffMs (attempts) {
    const n = Math.max(1, Number(attempts) || 1)
    return Math.min(backoffMaxMs, backoffBaseMs * Math.pow(2, n - 1))
  }

  /**
   * 结掉一个 running 的作业。
   *   · ok=true  → done
   *   · ok=false → attempts >= deadLetterAfter ? dead : pending（next_at = now + 退避）
   * @param {number} id
   * @param {object} [res]
   * @param {boolean} [res.ok=false]
   * @param {string|null} [res.error]
   * @param {string|null} [res.errorKind] unavailable|runtime|bug（v4 的「失败必须可见」）
   * @param {number} [res.now]
   * @returns {{state:string, attempts:number, nextAt:number|null, dead:boolean, changed:boolean}}
   */
  function finishJob (id, { ok = false, error = null, errorKind = null, now = nowSec() } = {}) {
    const ts = Number.isFinite(Number(now)) ? Number(now) : nowSec()
    return write(() => {
      const row = stmt.jobById.get(Number(id))
      if (!row) throw new Error(`finishJob: 作业 ${id} 不存在`)
      if (row.state !== 'running') {
        // 重复 finish / 没认领就 finish：如实报告，不覆盖别人的状态
        return { state: row.state, attempts: Number(row.attempts), nextAt: Number(row.next_at), dead: row.state === 'dead', changed: false }
      }
      if (ok) {
        stmt.finishDone.run(ts, Number(id))
        return { state: 'done', attempts: Number(row.attempts), nextAt: null, dead: false, changed: true }
      }
      const attempts = Number(row.attempts) || 1
      const dead = attempts >= Math.max(1, Number(deadLetterAfter) || 3)
      if (dead) {
        stmt.finishDead.run(String(error ?? ''), errorKind, ts, Number(id))
        log(`v5: 作业 ${id}（${row.kind}）连续失败 ${attempts} 次 → 死信`)
        return { state: 'dead', attempts, nextAt: null, dead: true, changed: true }
      }
      const nextAt = ts + backoffMs(attempts) / 1000
      stmt.finishRetry.run(nextAt, String(error ?? ''), errorKind, ts, Number(id))
      return { state: 'pending', attempts, nextAt, dead: false, changed: true }
    }, 'finishJob')
  }

  /** 作业统计（设置页/健康检查用）：各状态条数 + 最老的 pending 时间。 */
  function jobStats () {
    const rows = db.prepare('SELECT state, COUNT(*) AS n FROM jobs GROUP BY state').all()
    const byState = {}
    for (const r of rows) byState[r.state] = Number(r.n)
    const oldest = db.prepare("SELECT MIN(next_at) AS t FROM jobs WHERE state = 'pending'").get()
    return {
      byState: { pending: 0, running: 0, done: 0, failed: 0, dead: 0, ...byState },
      oldestPendingAt: oldest?.t ?? null,
    }
  }

  // ── profiles（人物画像，从 memories 投影出来）────────────────────────────
  /**
   * 写/合并一个人物画像（只覆盖给了的字段）。
   * @param {object} p
   * @param {string} p.subject QQ号（主键）
   * @param {string|null} [p.nickname] [p.summary]
   * @param {string[]|null} [p.prefs] [p.dislikes]
   * @param {Array<{k:string,v:string,confidence:number}>|null} [p.facts]
   */
  function upsertProfile ({ subject, nickname = null, summary = null, prefs = null, dislikes = null, facts = null } = {}) {
    if (!subject) throw new Error('upsertProfile: 缺 subject')
    return write(() => {
      stmt.upsertProfile.run(
        String(subject), nickname, summary,
        prefs === null ? null : jsonOrNull(prefs),
        dislikes === null ? null : jsonOrNull(dislikes),
        facts === null ? null : jsonOrNull(facts),
        nowSec(),
      )
      return { subject: String(subject) }
    }, 'upsertProfile')
  }

  /** 读画像（JSON 字段已解析回对象/数组）。 */
  function getProfile (subject) {
    const row = stmt.profileBySubject.get(String(subject))
    if (!row) return null
    return {
      ...row,
      prefs: parseJson(row.prefs, []),
      dislikes: parseJson(row.dislikes, []),
      facts: parseJson(row.facts, []),
    }
  }

  // ── 杂项 ────────────────────────────────────────────────────────────────
  /** 库的概况（设置页/健康检查用）。不扫大表、全是 count。 */
  function stats () {
    const one = (sql, ...p) => {
      const r = db.prepare(sql).get(...p)
      return r ? Number(Object.values(r)[0]) : 0
    }
    return {
      path: dbPath,
      schemaVersion: Number(metaGet.get('schema_version')?.v || 0),
      events: one('SELECT COUNT(*) FROM events'),
      memories: {
        total: one('SELECT COUNT(*) FROM memories'),
        active: one("SELECT COUNT(*) FROM memories WHERE state = 'active'"),
        archived: one("SELECT COUNT(*) FROM memories WHERE state = 'archived'"),
      },
      utterances: one('SELECT COUNT(*) FROM utterances'),
      jobs: jobStats(),
    }
  }

  /** 当前连接在用的几个 PRAGMA（测试/排查用；正常代码不用它）。 */
  function pragmas () {
    const get = p => db.prepare(`PRAGMA ${p}`).get()
    return {
      journalMode: get('journal_mode')?.journal_mode,
      synchronous: get('synchronous')?.synchronous,
      busyTimeout: get('busy_timeout')?.timeout,
    }
  }

  /**
   * 把 WAL 落回主库并截断（`wal_checkpoint(TRUNCATE)`）。
   *
   * 为什么需要它（交接文档 §7 的已知坑）：
   *   WAL 在自动 checkpoint 到阈值（默认 1000 页 ≈ 4MB）之前**不会**合并回 `.db`。
   *   于是「只拷 .db」看到的是一个几乎空的库 —— 备份/迁移时踩过，表现为
   *   「明明有 570 条事件，拷出来的副本查是 0 条」。
   *   现场实测：v5 上线 10 分钟 WAL 就从 0 涨到 1.3MB，照这个速度一天几 MB，
   *   而备份脚本（以及人手 cp）不会记得连 WAL 一起拷。
   *
   * 为什么是 TRUNCATE 而不是 PASSIVE：
   *   PASSIVE 只是「尽力」，有读者时可能什么都不做；TRUNCATE 会把 WAL 截成 0 字节。
   *   调用点不在消息路径上（定时器），偶尔等一下读锁可以接受。
   *
   * **永不抛错**：checkpoint 失败（比如正好有长读事务）不该影响调用方，
   * 返回 ok:false 让上层记一条日志，下一轮再试。
   *
   * @returns {{ok:boolean, busy:*, log:*, checkpointed:*}}
   */
  function checkpoint () {
    try {
      const row = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() || {}
      // sqlite 返回 {busy, log, checkpointed}：busy=0 表示没被阻塞、完整做完
      const busy = Number(row.busy ?? 0)
      return { ok: busy === 0, busy: row.busy ?? null, log: row.log ?? null, checkpointed: row.checkpointed ?? null }
    } catch (err) {
      return { ok: false, busy: null, log: null, checkpointed: null, error: String(err?.message ?? err) }
    }
  }

  /** 当前 WAL 文件大小（字节）；拿不到返回 -1。排查「WAL 又涨了」用。 */
  function walSize () {
    try {
      const f = `${dbPath}-wal`
      return fs.existsSync(f) ? fs.statSync(f).size : 0
    } catch { return -1 }
  }

  /** 关闭连接。可重复调用（第二次是 no-op）。 */
  let closed = false
  function close () {
    if (closed) return
    closed = true
    try { db.close() } catch { /* ignore */ }
  }

  return {
    // 元信息
    dbPath, db,
    // events
    appendEvent, appendEvents, getEvent,
    // memories
    insertMemory, getMemory, findActiveByKey, archiveMemory, touchMemory, dueExpire,
    // 遗忘（§3.4 第三条）：低价值 episode 归档，库不再只增不减
    pruneLowValue,
    // 检索
    searchFts, searchLike, searchMemories, shouldFallbackToLike, reindexFts,
    // 我说过什么
    appendUtterance, recentUtterances,
    // jobs
    enqueueJob, claimDueJobs, finishJob, jobStats, backoffMs,
    // profiles
    upsertProfile, getProfile,
    // 其它
    stats, pragmas, close,
    // WAL 维护（交接文档 §7：v5 正式上线后加周期性 checkpoint）
    checkpoint, walSize,
  }
}

// ============================================================================
// V5_STORE_API —— 给「桥侧双写」用的契约（Step 1 的另一半按这个接）
// ============================================================================
//
// 打开/关闭
//   const v5 = openV5({ dbPath: v5DbPath(cfg) })   // 桥起进程时开一次；卸载时 close()
//   v5.close()                                      // 可重复调用
//   ⚠️ node:sqlite 是**同步** API：单条写入 0.1-0.2ms 量级（§3.5 实测 5000 条
//      单事务 8.5ms），可以直接在桥的消息路径上调；但批量补写请用 appendEvents
//      （一个事务），不要循环单条提交。
//
// WAL 维护（定时器调用，别放消息路径上）
//   v5.checkpoint() → { ok, busy, log, checkpointed }   // = PRAGMA wal_checkpoint(TRUNCATE)
//   v5.walSize()    → number                            // 当前 -wal 字节数，-1=读不到
//   · 为什么要它：WAL 自动 checkpoint 阈值约 4MB，之前「只拷 .db」会让副本看起来是空库
//     （交接文档 §7 的坑）。现场 10 分钟就涨到 1.3MB，一天几 MB —— 备份脚本不会记得
//     连 WAL 一起拷，所以由进程自己定期收。
//   · **永不抛错**，ok:false 时上层记日志、下一轮再试。
//
// 写事件（每条入站/出站都写；幂等，重放安全）
//   v5.appendEvent({ conv, msgId, speaker, text, at, kindRaw, meta })
//     → { inserted: boolean, id: number|null }
//   · conv:    'c2c:<QQ>' | 'group:<群号>'
//   · msgId:   OneBot message_id（字符串化）。**尽量给**：没有 msg_id 就没有幂等
//              （UNIQUE 把 NULL 视为互不相等）。没有的时候自己造稳定值。
//   · speaker: 'self' | 对方 QQ 号
//   · text:    全文，**绝不截断**（v4 在格式化时截 80 字 = P1-1）
//   · at:      秒（默认 now）。不要传毫秒（>1e11 会被当成未来时间）
//   · kindRaw: 'text'|'image'|'voice'|'card'|'file'|'system'（原样记录，不做判断）
//   · meta:    对象或 JSON 字符串（图片路径/卡片标题/BV号/转发来源）
//   · 抛错：缺 conv/text、meta 不可序列化（循环引用）
//   v5.appendEvents([...]) → { inserted, ids }   // 迁移/补写用，单事务
//
// 写「我说过什么」
//   v5.appendUtterance({ conv, text, at, kind, thread }) → { id }
//
// 作业（提炼由 worker 跑，桥不需要直接调；Step 2 之前可以先只写 events）
//   v5.enqueueJob({ kind, payload, nextAt }) → { id }
//   v5.claimDueJobs({ now, limit, kinds }) → [{ id, kind, payload, attempts, nextAt }]
//   v5.finishJob(id, { ok, error, errorKind }) → { state, attempts, nextAt, dead, changed }
//     · claim 时 attempts 已经 +1（崩溃也算一次，避免无限重跑）
//     · 失败按 backoffBaseMs * 2^(n-1) 退避（默认 60s → 120s → 死信）
//     · attempts >= deadLetterAfter（默认 3）→ state='dead'
//     · 重复 finish / 没 claim 就 finish → changed:false，不改状态
//
// 检索（Step 2 用；桥侧第一步只需要能查「这条记忆存过没」）
//   v5.searchMemories({ query, limit, type, subject, fallbackToLike }) → rows
//   v5.searchFts({...}) / v5.searchLike({...}) / v5.shouldFallbackToLike(query, rows)
//   row: { id, type, subject, text, state, score, bm25, via }
//
// 常见错误行为
//   · 非法 type/kind/reason → 抛 Error（消息里列出允许值），绝不静默塞进库
//   · SQLITE_BUSY → 等 busy_timeout(3s)，仍失败则 3 次重试（5/10/20ms）后抛出
//   · 同一个 (conv,msg_id) 重复 append → 返回 { inserted:false, id:已有id }，不抛错
//   · 归档一条已归档的 → { archived:false }，不抛错
//
// Step 1 先不填、Step 3 迁移时再补的列
//   events:    meta 在 Step 1 只存原始 JSON（图片本地路径/卡片标题/BV 号由桥按
//              自己的格式塞进来，Step 3 再统一读成结构化字段）；msg_id 为 NULL 的
//              历史行（v4 日志解析来的）保留 NULL —— 那批没有幂等语义。
//   memories:  superseded_by / valid_from / valid_until 靠 Step 2 的提炼与取代逻辑
//              填；Step 3 迁移时由 v4 的 entries 映射（procedural→rule、
//              episodic→episode、semantic→fact，pinned→salience 抬到 0.9）。
//   profiles:  整表 Step 1 只建结构 + 提供 upsert/get，内容由 Step 2 的 profile
//              job 从 memories 投影出来；Step 3 迁移时为空。
//   jobs:      payload 的 schema 由各 kind 自己定（Step 2 写 distill 时才定稿）；
//              last_error_kind 的三分类（unavailable/runtime/bug）由 worker 填。
//   utterances: thread（话题线）Step 1 可空，Step 2 的防复读/话题跟踪再填。
// ============================================================================
