// test/memory-v5-store.test.mjs —— 记忆 v5 数据层（Step 1）单测
//
// 测的是 lib/agent/memory-v5/store.mjs：schema、幂等、WAL、jobs 退避/死信、
// expire 归档、FTS bigram 中文命中、并发写。全部在 os.tmpdir() 里建库，
// **绝不碰生产库**（生产是 ~/.dsh/.../mem.db 与未来的 mem-v5.db，
// 这里连 mem.db 的名字都不出现）。
//
// 为什么这些断言值得写（每条都对应审计文档里的一个事故）：
//   · 幂等（UNIQUE(conv,msg_id)）—— v4 靠 fp 文本指纹事后去重，历史算法一改
//     就留下 162 组重复（§3.5）。重放安全是 v5 的地基。
//   · WAL + busy_timeout —— v4 一个 PRAGMA 都没有，两个写者直接 database is locked（P2）。
//   · jobs 退避/死信 —— v4 调度器没有「连续失败 N 次」概念（P2 死信缺失），
//     只能靠人翻 scheduler.json 发现任务坏了。
//   · expire 归档 —— v4 的「明天三点开会」过期 8 天还留在 digest 里（P0-7 相关）。
//   · FTS bigram —— unicode61 不切中文，不预分词就永远搜不到（§3.3）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

// dataDir() 会读 DSH_HOME —— 先引到临时目录，再 import（v5DbPath 用它算默认路径）
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-v5-'))
process.env.HOME = TMP_HOME
process.env.USERPROFILE = TMP_HOME
process.env.DSH_HOME = path.join(TMP_HOME, '.dsh')

const M = await import(pathToFileURL(path.join(ROOT, 'lib', 'agent', 'memory-v5', 'store.mjs')).href)
const { openV5, v5DbPath, ftsTokens, ftsMatchQuery } = M

let caseNo = 0
/** 每个用例一个独立库文件（互不影响，也避免 WAL 历史干扰断言）。 */
function mkStore (opts = {}) {
  caseNo += 1
  const dir = path.join(TMP_HOME, 'db', String(caseNo))
  const dbPath = path.join(dir, 'mem-v5.db')
  const state = openV5({ dbPath, log: () => {}, ...opts })
  return {
    ...state,
    dbPath,
    cleanup: () => {
      try { state.close() } catch { /* ignore */ }
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
    },
  }
}

test.after(() => { try { fs.rmSync(TMP_HOME, { recursive: true, force: true }) } catch { /* ignore */ } })

// ── ① 建库 / PRAGMA / 幂等 ─────────────────────────────────────────────────

test('v5DbPath：落在 stateDir 下，叫 mem-v5.db（绝不和 v4 的 mem.db 混）', () => {
  const p = v5DbPath({})
  assert.equal(p, path.join(process.env.DSH_HOME, 'dsh-plugin-llminqq', 'agent', 'memory', 'mem-v5.db'))
  assert.ok(p.endsWith('mem-v5.db'))
  assert.ok(!p.endsWith('mem.db'), 'v5 绝不能写 v4 的库文件')
  // 显式 memory.stateDir 时跟着走（测试隔离/多实例）
  const custom = path.join(TMP_HOME, '自定义')
  assert.equal(v5DbPath({ memory: { stateDir: custom } }), path.join(custom, 'mem-v5.db'))
})

test('openV5：建出文档 §3.1 的全部表，WAL + synchronous=NORMAL + busy_timeout=3000', () => {
  const s = mkStore()
  try {
    const tables = s.db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name")
      .all().map(r => r.name)
    for (const want of ['events', 'memories', 'mem_fts', 'profiles', 'utterances', 'jobs', 'v5_meta']) {
      assert.ok(tables.includes(want), `缺表 ${want}（实际：${tables.join(',')}）`)
    }
    // 索引也在（缺索引 = 以后全表扫描，慢得莫名其妙）
    const idx = s.db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(r => r.name)
    for (const want of ['idx_events_conv_at', 'idx_mem_subject', 'idx_mem_type', 'idx_mem_valid', 'idx_jobs_due']) {
      assert.ok(idx.includes(want), `缺索引 ${want}`)
    }

    const p = s.pragmas()
    assert.equal(p.journalMode, 'wal', 'v4 没有 WAL：读写互相阻塞、设置页一读就撞锁')
    assert.equal(p.synchronous, 1, 'WAL 下 synchronous 应该是 NORMAL(1)，FULL(2) 太贵')
    assert.equal(p.busyTimeout, 3000, 'busy_timeout 必须是 3000 —— 没有它两个写者直接 database is locked')
    assert.equal(s.stats().schemaVersion, M.V5_SCHEMA_VERSION)
  } finally { s.cleanup() }
})

test('openV5 是幂等的：同一个库开两次不炸、数据还在', () => {
  const dir = path.join(TMP_HOME, 'db', 'reopen')
  const dbPath = path.join(dir, 'mem-v5.db')
  const a = openV5({ dbPath })
  a.appendEvent({ conv: 'c2c:1', msgId: 'x1', speaker: '1', text: '你好' })
  a.close()
  const b = openV5({ dbPath })
  try {
    assert.equal(b.stats().events, 1, '第二次打开把数据弄丢了？')
    // 表在、PRAGMA 在、还能继续写
    b.appendEvent({ conv: 'c2c:1', msgId: 'x2', speaker: '1', text: '再见' })
    assert.equal(b.stats().events, 2)
  } finally { b.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('openV5：缺 dbPath 直接报错（别糊里糊涂建到进程 cwd 里）', () => {
  assert.throws(() => openV5({}), /dbPath/)
})

test('WAL 真的生效：写入后库旁边有 -wal 文件', () => {
  const s = mkStore()
  try {
    s.appendEvent({ conv: 'c2c:1', msgId: 'w1', speaker: '1', text: 'x' })
    assert.ok(fs.existsSync(`${s.dbPath}-wal`), '没有 -wal 文件 = 不是 WAL 模式')
  } finally { s.cleanup() }
})

// ── ①b WAL checkpoint：只拷 .db 不再是空库（交接文档 §7 的坑）──────────────
//
// 现场教训：WAL 攒到阈值前不会合并回 .db，于是「只拷 mem-v5.db」的副本查出来是 0 条
// （迁移演练时 570 条事件的库、副本查询为空，就是这么来的 —— 那份 -wal 有 4MB）。
// v5 正式上线后加了周期性 checkpoint，这一组锁住「收了之后副本真的是全的」。
test('checkpoint：WAL 收进主库，副本（只拷 .db）也能查到全部数据', () => {
  const s = mkStore()
  try {
    for (let i = 0; i < 20; i++) {
      s.appendEvent({ conv: 'c2c:1', msgId: `ck${i}`, speaker: '1', text: `第${i}条` })
    }
    const walBefore = s.walSize()
    assert.ok(walBefore > 0, '写入后 WAL 应该非空（否则这条用例没意义）')

    const r = s.checkpoint()
    assert.equal(r.ok, true, `checkpoint 应该成功：${JSON.stringify(r)}`)
    assert.ok(s.walSize() <= walBefore, 'checkpoint 后 WAL 不该变大')

    // 关键：只拷 .db（不带 -wal/-shm），能查到全部 20 条
    const copy = path.join(TMP_HOME, 'db', 'copy-after-checkpoint.db')
    fs.copyFileSync(s.dbPath, copy)
    const s2 = openV5({ dbPath: copy, log: () => {} })
    try {
      assert.equal(s2.stats().events, 20,
        '只拷 .db 的副本必须能查到全部事件 —— 这正是没 checkpoint 时会「看起来是空的」')
    } finally { s2.close() }
  } finally { s.cleanup() }
})

test('checkpoint：可重复调用、空库也不抛错', () => {
  const s = mkStore()
  try {
    for (let i = 0; i < 3; i++) {
      const r = s.checkpoint()
      assert.equal(typeof r.ok, 'boolean')
    }
  } finally { s.cleanup() }
})

test('walSize：返回有限数字而不是抛错', () => {
  const s = mkStore()
  try {
    assert.ok(Number.isFinite(s.walSize()), 'walSize 必须返回数字')
  } finally { s.cleanup() }
})

// ── ② events：幂等 + 全文不截断 ────────────────────────────────────────────

test('appendEvent：同 (conv,msg_id) 重放幂等，返回已有 id；不同 conv 不冲突', () => {
  const s = mkStore()
  try {
    const a = s.appendEvent({ conv: 'c2c:1001', msgId: 'm-1', speaker: '1001', text: '在吗' })
    assert.deepEqual(a.inserted, true)
    const b = s.appendEvent({ conv: 'c2c:1001', msgId: 'm-1', speaker: '1001', text: '在吗' })
    assert.equal(b.inserted, false, '重复的 (conv,msg_id) 必须被 UNIQUE 挡掉')
    assert.equal(b.id, a.id, '幂等重放要返回已有那条的 id，调用方才能继续引用')
    assert.equal(s.stats().events, 1, '重放不该产生第二行')

    // 同一个 msg_id 在另一个会话里是另一条（群聊/私聊的 message_id 空间不同）
    const c = s.appendEvent({ conv: 'group:2002', msgId: 'm-1', speaker: '1001', text: '在吗' })
    assert.equal(c.inserted, true)
    assert.equal(s.stats().events, 2)
  } finally { s.cleanup() }
})

test('appendEvent：msg_id 为空时没有幂等性（文档行为，桥侧要尽量带 msg_id）', () => {
  const s = mkStore()
  try {
    const a = s.appendEvent({ conv: 'c2c:1', msgId: null, speaker: '1', text: '主动发言' })
    const b = s.appendEvent({ conv: 'c2c:1', msgId: null, speaker: '1', text: '主动发言' })
    assert.equal(a.inserted, true)
    assert.equal(b.inserted, true, 'NULL 在 SQLite 的 UNIQUE 里互不相等 —— 这是文档说明过的行为')
    assert.equal(s.stats().events, 2)
  } finally { s.cleanup() }
})

test('appendEvent：全文不截断（v4 在日志格式化时截到 80 字 = P1-1）', () => {
  const s = mkStore()
  try {
    const long = '这是一条很长的消息。'.repeat(400)   // ~4400 字
    const { id } = s.appendEvent({ conv: 'c2c:1', msgId: 'long', speaker: '1', text: long })
    const row = s.getEvent({ conv: 'c2c:1', msgId: 'long' })
    assert.equal(row.id, id)
    assert.equal(row.text.length, long.length, `全文被截断了：${row.text.length} != ${long.length}`)
    assert.equal(row.text, long)
  } finally { s.cleanup() }
})

test('appendEvent：meta 对象存成 JSON，kind_raw/at/ingested_at 都落库', () => {
  const s = mkStore()
  try {
    s.appendEvent({
      conv: 'group:9', msgId: 'i1', speaker: '333', text: '[图片]',
      at: 1700000000, kindRaw: 'image', meta: { path: '/tmp/a.png', w: 100 },
    })
    const row = s.getEvent({ conv: 'group:9', msgId: 'i1' })
    assert.equal(row.at, 1700000000)
    assert.equal(row.kind_raw, 'image')
    assert.deepEqual(JSON.parse(row.meta), { path: '/tmp/a.png', w: 100 })
    assert.ok(row.ingested_at > 0, 'ingested_at 要自动填')
  } finally { s.cleanup() }
})

test('appendEvent：meta 不可序列化时抛错且不落库（不留半条事件）', () => {
  const s = mkStore()
  try {
    const circular = {}; circular.self = circular
    assert.throws(() => s.appendEvent({ conv: 'c2c:1', msgId: 'bad', speaker: '1', text: 'x', meta: circular }))
    assert.equal(s.stats().events, 0)
  } finally { s.cleanup() }
})

test('appendEvent：缺 conv/text 抛错（别把半截数据写进库）', () => {
  const s = mkStore()
  try {
    assert.throws(() => s.appendEvent({ text: 'x' }), /conv/)
    assert.throws(() => s.appendEvent({ conv: 'c2c:1' }), /text/)
    assert.equal(s.stats().events, 0)
  } finally { s.cleanup() }
})

test('appendEvents：批量单事务；ids 和入参一一对应', () => {
  const s = mkStore()
  try {
    const r = s.appendEvents([
      { conv: 'c2c:1', msgId: 'b1', speaker: '1', text: 'a' },
      { conv: 'c2c:1', msgId: 'b2', speaker: '1', text: 'b' },
      { conv: 'c2c:1', msgId: 'b1', speaker: '1', text: 'a' },   // 重复
    ])
    assert.equal(r.inserted, 2)
    assert.equal(r.ids.length, 3)
    assert.equal(r.ids[0], r.ids[2], '重复项应返回同一个 id')
    assert.equal(s.stats().events, 2)
  } finally { s.cleanup() }
})

test('appendEvents：中途失败整批回滚（不会只写进去一半）', () => {
  const s = mkStore()
  try {
    const circular = {}; circular.self = circular
    assert.throws(() => s.appendEvents([
      { conv: 'c2c:1', msgId: 'ok1', speaker: '1', text: '第一条' },
      { conv: 'c2c:1', msgId: 'bad', speaker: '1', text: '第二条', meta: circular },
    ]))
    assert.equal(s.stats().events, 0, '第二条失败时第一条也必须回滚（一个事务）')
  } finally { s.cleanup() }
})

// ── ③ memories + FTS bigram ────────────────────────────────────────────────

test('ftsTokens：中文切 2-gram，英文整词小写，标点是分隔符', () => {
  assert.deepEqual(ftsTokens('开会'), ['开会'])
  // 「明天下午三点开会」= 明 天 下 午 三 点 开 会（8 字 → 7 个相邻 2-gram）
  assert.deepEqual(ftsTokens('明天下午三点开会'),
    ['明天', '天下', '下午', '午三', '三点', '点开', '开会'])
  assert.deepEqual(ftsTokens('deadline 前交！'), ['deadline', '前交'])
  assert.deepEqual(ftsTokens('累'), ['累'], '单字原文自己是一个 token（整句单字时能命中）')
  assert.deepEqual(ftsTokens('！！'), [], '纯标点没有 token → 调用方该走 LIKE')
})

test('ftsMatchQuery：多 token 用 OR（AND 会让自然语言查询几乎必然为空），并给 token 加引号', () => {
  const q = ftsMatchQuery('三点开会')
  assert.match(q, / OR /, '自然语言查询不能用 AND —— 四个 bigram 全中的概率太低')
  assert.match(q, /"三点"/)
  assert.match(q, /"开会"/)
  assert.equal(ftsMatchQuery('！！'), '', '纯标点返回空串 = 让调用方去走 LIKE')
})

test('insertMemory：字段落库、FTS 同一事务写进去（插完立刻能搜到）', () => {
  const s = mkStore()
  try {
    const { id } = s.insertMemory({
      type: 'commitment', subject: '1001', conv: 'c2c:1001', speaker: '1001',
      text: '明天下午三点开会', key: 'meeting:1001', confidence: 0.9, salience: 0.8,
      sourceEvent: null, scope: 'dm_only', validUntil: 1800000000,
    })
    const row = s.getMemory(id)
    assert.equal(row.type, 'commitment')
    assert.equal(row.state, 'active')
    assert.equal(row.confidence, 0.9)
    assert.equal(row.salience, 0.8)
    assert.equal(row.scope, 'dm_only')
    assert.equal(row.valid_until, 1800000000)

    const hits = s.searchFts({ query: '开会' })
    assert.equal(hits.length, 1, 'insertMemory 之后必须立刻能被 FTS 搜到（同一个事务）')
    assert.equal(hits[0].id, id)
  } finally { s.cleanup() }
})

test('insertMemory：非法 type / 空 text 抛错，不留下 FTS 残行', () => {
  const s = mkStore()
  try {
    assert.throws(() => s.insertMemory({ type: 'nonsense', text: 'x' }), /type/)
    assert.throws(() => s.insertMemory({ type: 'fact', text: '   ' }), /text/)
    assert.equal(s.stats().memories.total, 0)
    assert.deepEqual(s.searchFts({ query: 'x' }), [], 'FTS 里不该留下残行')
  } finally { s.cleanup() }
})

test('FTS bigram：query「开会」命中「明天下午三点开会」（这就是预分词的意义）', () => {
  const s = mkStore()
  try {
    const a = s.insertMemory({ type: 'episode', text: '明天下午三点开会，地点3楼' }).id
    const b = s.insertMemory({ type: 'fact', text: '他最讨厌下雨天' }).id
    const hits = s.searchFts({ query: '开会' })
    assert.deepEqual(hits.map(h => h.id), [a], '中文 2-gram 必须命中；不带 bigram 预分词时 unicode61 会整段当一个词 → 永远搜不到')
    assert.equal(hits[0].text, '明天下午三点开会，地点3楼')
    assert.ok(!hits.some(h => h.id === b))

    // 反过来：用原句的一部分（不同 bigram 组合）也能命中
    assert.deepEqual(s.searchFts({ query: '下午三点' }).map(h => h.id), [a])
    assert.deepEqual(s.searchFts({ query: '下雨' }).map(h => h.id), [b])
  } finally { s.cleanup() }
})

test('FTS：英文/数字整词能命中', () => {
  const s = mkStore()
  try {
    const id = s.insertMemory({ type: 'fact', text: 'deadline 是 2026-11-10 之前交 PPT' }).id
    assert.deepEqual(s.searchFts({ query: 'deadline' }).map(h => h.id), [id])
    assert.deepEqual(s.searchFts({ query: 'ppt' }).map(h => h.id), [id], 'ASCII 查询大小写不敏感')
  } finally { s.cleanup() }
})

test('FTS 单字查不到（已知限制）→ LIKE 回退能兜住，且规则有钩子', () => {
  const s = mkStore()
  try {
    const id = s.insertMemory({ type: 'episode', text: '今天好累啊' }).id
    assert.deepEqual(s.searchFts({ query: '累' }), [], 'bigram 索引里没有 1-gram —— 文档 §3.3 的已知限制')

    assert.equal(s.shouldFallbackToLike('累', []), true, '单字 + FTS 空 → 必须回退')
    assert.equal(s.shouldFallbackToLike('好累', []), false, '两字以上不该回退（那会让每轮都全表扫描）')
    assert.equal(s.shouldFallbackToLike('累', [{ id: 1 }]), false, 'FTS 已经有结果就不回退')

    const like = s.searchLike({ query: '累' })
    assert.deepEqual(like.map(h => h.id), [id])

    const auto = s.searchMemories({ query: '累' })
    assert.deepEqual(auto.map(h => h.id), [id])
    assert.equal(auto[0].via, 'like', '要能观测到这次走的是回退（排查「为什么没结果」时有用）')
    assert.deepEqual(s.searchMemories({ query: '累', fallbackToLike: false }), [], '显式关掉回退时应为空')
  } finally { s.cleanup() }
})

test('searchLike：LIKE 通配符要转义（用户 query 里的 % 不能当通配）', () => {
  const s = mkStore()
  try {
    const a = s.insertMemory({ type: 'fact', text: '进度 100% 完成' }).id
    s.insertMemory({ type: 'fact', text: '完全无关的另一条' })
    assert.deepEqual(s.searchLike({ query: '100%' }).map(h => h.id), [a])
    // 裸 % 转义后是「字面量 %」→ 只命中真的含 % 的那条，而不是把全库捞出来
    assert.deepEqual(s.searchLike({ query: '%' }).map(h => h.id), [a], '% 必须当字面量，不能当通配符')
  } finally { s.cleanup() }
})

test('searchFts：默认只返回 active，includeArchived 才看得到归档的', () => {
  const s = mkStore()
  try {
    const id = s.insertMemory({ type: 'fact', text: '明天下午三点开会' }).id
    assert.equal(s.archiveMemory(id, 'expired').archived, true)
    assert.deepEqual(s.searchFts({ query: '开会' }), [], '归档的记忆不该被注入')
    assert.equal(s.searchFts({ query: '开会', includeArchived: true }).length, 1)
  } finally { s.cleanup() }
})

test('searchFts：type / subject 过滤（Step 2 的按人检索靠它）', () => {
  const s = mkStore()
  try {
    const a = s.insertMemory({ type: 'preference', subject: '1001', text: '他喜欢开会的下午茶' }).id
    const b = s.insertMemory({ type: 'fact', subject: '1002', text: '她喜欢开会的效率' }).id
    assert.deepEqual(s.searchFts({ query: '开会', type: 'preference' }).map(h => h.id), [a])
    assert.deepEqual(s.searchFts({ query: '开会', subject: '1002' }).map(h => h.id), [b])
    assert.deepEqual(s.searchFts({ query: '开会', type: ['fact', 'preference'] }).length, 2)
  } finally { s.cleanup() }
})

test('reindexFts：索引丢了能重建（迁移后/索引坏了的兜底）', () => {
  const s = mkStore()
  try {
    s.insertMemory({ type: 'fact', text: '明天下午三点开会' })
    s.insertMemory({ type: 'fact', text: '他最讨厌下雨天' })
    // 模拟索引损坏/清空（external content 表用 'delete-all'，不是 DELETE）
    s.db.exec("INSERT INTO mem_fts(mem_fts) VALUES('delete-all')")
    assert.deepEqual(s.searchFts({ query: '开会' }), [])
    const r = s.reindexFts()
    assert.equal(r.indexed, 2)
    assert.equal(s.searchFts({ query: '开会' }).length, 1)
    assert.equal(s.searchFts({ query: '下雨' }).length, 1)
  } finally { s.cleanup() }
})

// ── ④ 归档 / 访问计数 / 时间失效 ──────────────────────────────────────────

test('archiveMemory：写 state/archived_reason/superseded_by；重复归档返回 archived:false', () => {
  const s = mkStore()
  try {
    const old = s.insertMemory({ type: 'fact', text: '安全底裤还没做', key: 'safety' }).id
    const fresh = s.insertMemory({ type: 'fact', text: '安全底裤已生效很久了', key: 'safety' }).id
    const r = s.archiveMemory(old, 'superseded', { supersededBy: fresh })
    assert.equal(r.archived, true)
    const row = s.getMemory(old)
    assert.equal(row.state, 'archived')
    assert.equal(row.archived_reason, 'superseded')
    assert.equal(row.superseded_by, fresh)

    // 归档不该动到新那条
    assert.equal(s.getMemory(fresh).state, 'active')
    // 幂等：再归档一次 = no-op
    assert.equal(s.archiveMemory(old, 'pruned').archived, false)
    assert.equal(s.getMemory(old).archived_reason, 'superseded', '第二次归档不该改原因')
  } finally { s.cleanup() }
})

test('archiveMemory：非法 reason 抛错（原因是一列，不是随便的字符串）', () => {
  const s = mkStore()
  try {
    const id = s.insertMemory({ type: 'fact', text: 'x' }).id
    assert.throws(() => s.archiveMemory(id, '随便写的'), /reason/)
    assert.equal(s.getMemory(id).state, 'active')
  } finally { s.cleanup() }
})

test('findActiveByKey：按 type+key+subject 找同键旧条目（Step 2 取代逻辑要用）', () => {
  const s = mkStore()
  try {
    const a = s.insertMemory({ type: 'fact', subject: '1001', key: 'k1', text: '版本一' }).id
    s.archiveMemory(a, 'superseded')
    const b = s.insertMemory({ type: 'fact', subject: '1001', key: 'k1', text: '版本二' }).id
    const found = s.findActiveByKey({ type: 'fact', subject: '1001', key: 'k1' })
    assert.deepEqual(found.map(r => r.id), [b], '只剩 active 的那条')
    assert.deepEqual(s.findActiveByKey({ type: 'fact', subject: '9999', key: 'k1' }), [])
    assert.deepEqual(s.findActiveByKey({ type: 'fact', key: '' }), [])
  } finally { s.cleanup() }
})

test('touchMemory：访问次数 +1、last_access 更新；归档的不计数', () => {
  const s = mkStore()
  try {
    const a = s.insertMemory({ type: 'fact', text: 'a' }).id
    const b = s.insertMemory({ type: 'fact', text: 'b' }).id
    s.archiveMemory(b, 'pruned')
    assert.equal(s.touchMemory([a, b]).touched, 1, '归档条目不该再积累访问次数（否则退场机制失效）')
    assert.equal(s.getMemory(a).access_count, 1)
    assert.ok(s.getMemory(a).last_access > 0)
    assert.equal(s.touchMemory(a).touched, 1)
    assert.equal(s.getMemory(a).access_count, 2)
    assert.equal(s.touchMemory([]).touched, 0)
  } finally { s.cleanup() }
})

test('dueExpire：valid_until < now 的 active 归档成 expired；幂等；没时间边界的绝不动', () => {
  const s = mkStore()
  try {
    const past = s.insertMemory({ type: 'commitment', text: '明天下午三点开会', validUntil: 1000 }).id
    const future = s.insertMemory({ type: 'commitment', text: '下周交周报', validUntil: 9_000_000_000 }).id
    const noBound = s.insertMemory({ type: 'fact', text: '他喜欢猫' }).id
    const archivedBefore = s.insertMemory({ type: 'fact', text: '旧条目' }).id
    s.archiveMemory(archivedBefore, 'pruned')

    const r = s.dueExpire(2000)
    assert.equal(r.expired, 1, '只该归档那条过期的')
    assert.equal(s.getMemory(past).state, 'archived')
    assert.equal(s.getMemory(past).archived_reason, 'expired')
    assert.equal(s.getMemory(future).state, 'active', '没过期的不该动')
    assert.equal(s.getMemory(noBound).state, 'active', '没有 valid_until 的永不过期（NULL 不能当 0）')
    assert.equal(s.getMemory(archivedBefore).archived_reason, 'pruned', '已归档的不该被改成 expired')

    assert.equal(s.dueExpire(2000).expired, 0, '幂等：第二次归档 0 条')
    // 时间往后推，pending 的那条也该过期
    assert.equal(s.dueExpire(9_000_000_001).expired, 1)
    assert.equal(s.getMemory(future).archived_reason, 'expired')
  } finally { s.cleanup() }
})

// ── ⑤ jobs：退避 / 死信 / 原子认领 ────────────────────────────────────────

test('jobs：入队 → 认领（attempts+1、running）→ 第二次认领抢不到', () => {
  const s = mkStore()
  try {
    const { id } = s.enqueueJob({ kind: 'distill', payload: { conv: 'c2c:1', fromEvent: 1 }, nextAt: 1000 })
    const claimed = s.claimDueJobs({ now: 1000, limit: 10 })
    assert.equal(claimed.length, 1)
    assert.equal(claimed[0].id, id)
    assert.equal(claimed[0].kind, 'distill')
    assert.deepEqual(claimed[0].payload, { conv: 'c2c:1', fromEvent: 1 })
    assert.equal(claimed[0].attempts, 1, '认领时就要 attempts+1 —— 作业把 worker 弄崩也算一次')

    assert.deepEqual(s.claimDueJobs({ now: 1000, limit: 10 }), [], 'running 的不能被再认领')
    assert.equal(s.jobStats().byState.running, 1)
  } finally { s.cleanup() }
})

test('jobs：next_at 没到的不认领（定时/退避都靠它）', () => {
  const s = mkStore()
  try {
    s.enqueueJob({ kind: 'learn', nextAt: 5000 })
    assert.deepEqual(s.claimDueJobs({ now: 4999 }), [])
    assert.equal(s.claimDueJobs({ now: 5000 }).length, 1)
  } finally { s.cleanup() }
})

test('jobs：失败按指数退避 60s → 120s，第 3 次失败进 dead（默认阈值 3）', () => {
  const s = mkStore()
  try {
    const { id } = s.enqueueJob({ kind: 'distill', nextAt: 1000 })

    // 第 1 次
    s.claimDueJobs({ now: 1000 })
    const f1 = s.finishJob(id, { ok: false, error: 'LLM 超时', errorKind: 'runtime', now: 1000 })
    assert.equal(f1.state, 'pending')
    assert.equal(f1.dead, false)
    assert.equal(f1.nextAt, 1060, '第 1 次失败后等 60s（默认 backoffBaseMs）')

    // 第 2 次（还没到点 → 不认领；到点后认领）
    assert.deepEqual(s.claimDueJobs({ now: 1059 }), [])
    assert.equal(s.claimDueJobs({ now: 1060 }).length, 1)
    const f2 = s.finishJob(id, { ok: false, error: '又超时', errorKind: 'unavailable', now: 1060 })
    assert.equal(f2.state, 'pending')
    assert.equal(f2.nextAt, 1180, '第 2 次失败后等 120s（60*2）')

    // 第 3 次 → 死信
    assert.equal(s.claimDueJobs({ now: 1180 }).length, 1)
    const f3 = s.finishJob(id, { ok: false, error: '还是超时', errorKind: 'bug', now: 1180 })
    assert.equal(f3.state, 'dead')
    assert.equal(f3.dead, true)
    assert.equal(f3.attempts, 3)

    const row = s.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id)
    assert.equal(row.state, 'dead')
    assert.match(row.last_error, /还是超时/)
    assert.equal(row.last_error_kind, 'bug', '错误分类要落库（unavailable/runtime/bug）')
    assert.deepEqual(s.claimDueJobs({ now: 999999 }), [], '死信不该再被认领')
    assert.equal(s.jobStats().byState.dead, 1)
  } finally { s.cleanup() }
})

test('jobs：阈值可配（deadLetterAfter=2 时第二次失败就进 dead）', () => {
  const s = mkStore({ deadLetterAfter: 2, backoffBaseMs: 1000 })
  try {
    const { id } = s.enqueueJob({ kind: 'profile', nextAt: 1000 })
    s.claimDueJobs({ now: 1000 })
    s.finishJob(id, { ok: false, error: 'e1', now: 1000 })
    s.claimDueJobs({ now: 1001 })
    const f = s.finishJob(id, { ok: false, error: 'e2', now: 1001 })
    assert.equal(f.dead, true)
    assert.equal(f.state, 'dead')
  } finally { s.cleanup() }
})

test('jobs：成功 → done；重复 finish / 没认领就 finish 不覆盖状态', () => {
  const s = mkStore()
  try {
    const { id } = s.enqueueJob({ kind: 'expire', nextAt: 1000 })
    // 没认领就 finish：如实返回 changed:false
    const early = s.finishJob(id, { ok: true })
    assert.equal(early.changed, false)
    assert.equal(early.state, 'pending')

    s.claimDueJobs({ now: 1000 })
    const ok = s.finishJob(id, { ok: true, now: 1001 })
    assert.equal(ok.state, 'done')
    assert.equal(s.db.prepare('SELECT state FROM jobs WHERE id = ?').get(id).state, 'done')

    // 重复 finish（worker 重试）不报错、不改状态
    const again = s.finishJob(id, { ok: false, error: 'late failure' })
    assert.equal(again.changed, false)
    assert.equal(again.state, 'done', '已 done 的不能被迟到的失败改成 dead')
  } finally { s.cleanup() }
})

test('jobs：非法 kind 抛错；finish 不存在的作业抛错', () => {
  const s = mkStore()
  try {
    assert.throws(() => s.enqueueJob({ kind: 'nope' }), /kind/)
    assert.throws(() => s.finishJob(9999, { ok: true }), /不存在/)
  } finally { s.cleanup() }
})

test('jobs：kinds 过滤（不同 worker 只认自己的活）', () => {
  const s = mkStore()
  try {
    s.enqueueJob({ kind: 'distill', nextAt: 1000 })
    s.enqueueJob({ kind: 'learn', nextAt: 1000 })
    const claimed = s.claimDueJobs({ now: 1000, kinds: ['learn'] })
    assert.deepEqual(claimed.map(j => j.kind), ['learn'])
    assert.equal(s.jobStats().byState.pending, 1)
  } finally { s.cleanup() }
})

// ── ⑥ 并发：两个连接交替写 ────────────────────────────────────────────────

test('并发写：两个 store 交替 append 不炸（WAL + busy_timeout + 重试）', () => {
  const dir = path.join(TMP_HOME, 'db', 'concurrent')
  const dbPath = path.join(dir, 'mem-v5.db')
  const a = openV5({ dbPath })
  const b = openV5({ dbPath })
  try {
    for (let i = 0; i < 50; i++) {
      a.appendEvent({ conv: 'c2c:1', msgId: `a-${i}`, speaker: '1', text: `a${i}` })
      b.appendEvent({ conv: 'c2c:1', msgId: `b-${i}`, speaker: '2', text: `b${i}` })
    }
    assert.equal(a.stats().events, 100, '两个连接交替写 100 条，一条都不能丢')
    // 两边读到的也要是同一份
    assert.equal(b.stats().events, 100)
    // 幂等跨连接同样生效
    const dup = a.appendEvent({ conv: 'c2c:1', msgId: 'b-0', speaker: '2', text: 'b0' })
    assert.equal(dup.inserted, false)
    assert.equal(a.stats().events, 100)
  } finally {
    a.close(); b.close()
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

test('并发写：两个连接同时认领同一批作业，不会重复认领', () => {
  const dir = path.join(TMP_HOME, 'db', 'claim-race')
  const dbPath = path.join(dir, 'mem-v5.db')
  const a = openV5({ dbPath })
  const b = openV5({ dbPath })
  try {
    for (let i = 0; i < 5; i++) a.enqueueJob({ kind: 'distill', nextAt: 1000 })
    const c1 = a.claimDueJobs({ now: 1000, limit: 10 })
    const c2 = b.claimDueJobs({ now: 1000, limit: 10 })
    assert.equal(c1.length, 5)
    assert.equal(c2.length, 0, '已经被别人认领的作业不能被第二个 worker 再领一次')
    const ids = new Set(c1.map(j => j.id))
    assert.equal(ids.size, 5, '同一批里不能有重复 id')
  } finally {
    a.close(); b.close()
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

// ── ⑦ profiles / utterances / stats ───────────────────────────────────────

test('profiles：upsert 只覆盖给了的字段，JSON 字段读写对称', () => {
  const s = mkStore()
  try {
    assert.equal(s.getProfile('1001'), null)
    s.upsertProfile({
      subject: '1001', nickname: '小Q', summary: '喜欢猫',
      prefs: ['猫', '咖啡'], dislikes: ['噪音'], facts: [{ k: '职业', v: '学生', confidence: 0.8 }],
    })
    let p = s.getProfile('1001')
    assert.equal(p.nickname, '小Q')
    assert.deepEqual(p.prefs, ['猫', '咖啡'])
    assert.deepEqual(p.facts, [{ k: '职业', v: '学生', confidence: 0.8 }])

    // 只更新 summary：其它字段要保住（memories 投影时是一次只更新一层的）
    s.upsertProfile({ subject: '1001', summary: '喜欢猫，最近在学钢琴' })
    p = s.getProfile('1001')
    assert.equal(p.nickname, '小Q', '没给的字段不能被 NULL 抹掉')
    assert.deepEqual(p.prefs, ['猫', '咖啡'])
    assert.equal(p.summary, '喜欢猫，最近在学钢琴')
    assert.ok(p.updated > 0)
  } finally { s.cleanup() }
})

test('utterances：记「我说过什么」，按时间倒序取最近 N 条', () => {
  const s = mkStore()
  try {
    s.appendUtterance({ conv: 'c2c:1', text: '第一句', at: 1000 })
    s.appendUtterance({ conv: 'c2c:1', text: '第二句', at: 2000, kind: 'voice' })
    s.appendUtterance({ conv: 'group:2', text: '别人会话里的', at: 3000 })
    const recent = s.recentUtterances({ conv: 'c2c:1', limit: 10 })
    assert.deepEqual(recent.map(r => r.text), ['第二句', '第一句'])
    assert.equal(recent[0].kind, 'voice')
    assert.equal(s.recentUtterances({ limit: 1 }).length, 1)
    assert.equal(s.stats().utterances, 3)
  } finally { s.cleanup() }
})

test('stats：给出事件/记忆/作业的概况（设置页健康检查用）', () => {
  const s = mkStore()
  try {
    s.appendEvent({ conv: 'c2c:1', msgId: 'e1', speaker: '1', text: 'x' })
    const a = s.insertMemory({ type: 'fact', text: '事实一' }).id
    s.insertMemory({ type: 'episode', text: '情节一' })
    s.archiveMemory(a, 'pruned')
    s.enqueueJob({ kind: 'distill' })

    const st = s.stats()
    assert.equal(st.events, 1)
    assert.equal(st.memories.total, 2)
    assert.equal(st.memories.active, 1)
    assert.equal(st.memories.archived, 1)
    assert.equal(st.jobs.byState.pending, 1)
    assert.equal(st.schemaVersion, M.V5_SCHEMA_VERSION)
    assert.equal(st.path, s.dbPath)
  } finally { s.cleanup() }
})

test('close 可重复调用；关闭后再用会报错（而不是静默成功）', () => {
  const s = mkStore()
  s.close()
  s.close()   // 不该抛
  assert.throws(() => s.appendEvent({ conv: 'c2c:1', msgId: 'x', speaker: '1', text: 'y' }))
})

// ── ③ 低价值归档 pruneLowValue（§3.4 第三条遗忘机制，2026-11-07 补实现）────
//
// 审计文档 §3 列了三条遗忘机制：① valid_until 过期 ② 同 key 取代 ③ salience 低+访问少。
// 前两条早就有生产调用，**第三条从来没实现过** —— 于是库只增不减
// （v5 上线 2 天 active 从 873 涨到 986，没有任何回收路径），
// 正是 P0-2 描述的 v4 病症。
//
// 这一组锁住「保守」：只清低价值 episode，误删结论是不可接受的。
const daySec = 86400
const oldTs = () => Math.floor(Date.now() / 1000) - 20 * daySec

test('pruneLowValue：只归档「低分 + 零访问 + 够旧」的 episode', () => {
  const s = mkStore()
  try {
    const old = oldTs()
    const junk = s.insertMemory({ type: 'episode', text: '嘿嘿，听你的', salience: 0.2, created: old, lastSeen: old })
    const important = s.insertMemory({ type: 'episode', text: '这是重要情节', salience: 0.8, created: old, lastSeen: old })
    const fact = s.insertMemory({ type: 'fact', text: '对方有鼻炎', salience: 0.1, created: old, lastSeen: old })
    const fresh = s.insertMemory({ type: 'episode', text: '昨天说的', salience: 0.2, created: Math.floor(Date.now() / 1000) - daySec, lastSeen: 0 })
    const touched = s.insertMemory({ type: 'episode', text: '常被访问', salience: 0.2, created: old, lastSeen: old })
    s.touchMemory([touched.id])

    const r = s.pruneLowValue({ now: Math.floor(Date.now() / 1000) })
    assert.equal(r.pruned, 1, `只该归档 1 条，实际 ${r.pruned}（${JSON.stringify(r.ids)}）`)

    const get = id => s.db.prepare('SELECT state, archived_reason FROM memories WHERE id = ?').get(id)
    assert.equal(get(junk.id).state, 'archived', '低分零访问的旧 episode 应被归档')
    assert.equal(get(junk.id).archived_reason, 'pruned')
    assert.equal(get(important.id).state, 'active', '高 salience 不能被清')
    assert.equal(get(fact.id).state, 'active', 'fact 类型不在清理范围（结论不能误删）')
    assert.equal(get(fresh.id).state, 'active', '太新的不能清（给「以后想起来」留窗口）')
    assert.equal(get(touched.id).state, 'active', '被检索命中过的不能清')
  } finally { s.cleanup() }
})

test('pruneLowValue：幂等 + 可重复调用返回 0', () => {
  const s = mkStore()
  try {
    const old = oldTs()
    s.insertMemory({ type: 'episode', text: '垃圾片段', salience: 0.1, created: old, lastSeen: old })
    const now = Math.floor(Date.now() / 1000)
    assert.equal(s.pruneLowValue({ now }).pruned, 1)
    assert.equal(s.pruneLowValue({ now }).pruned, 0, '第二轮不该再归档（已 archived）')
  } finally { s.cleanup() }
})

test('pruneLowValue：归档不是删除 —— 行还在，能捞回来', () => {
  const s = mkStore()
  try {
    const old = oldTs()
    const m = s.insertMemory({ type: 'episode', text: '可捞回', salience: 0.1, created: old, lastSeen: old })
    s.pruneLowValue({ now: Math.floor(Date.now() / 1000) })
    const row = s.db.prepare('SELECT text, state FROM memories WHERE id = ?').get(m.id)
    assert.ok(row, '归档不能删行（pruned 是 state 变更，不是 DELETE）')
    assert.equal(row.text, '可捞回')
    // 手动捞回
    s.db.prepare("UPDATE memories SET state='active', archived_reason=NULL WHERE id = ?").run(m.id)
    assert.equal(s.db.prepare('SELECT state FROM memories WHERE id = ?').get(m.id).state, 'active')
  } finally { s.cleanup() }
})

test('pruneLowValue：limit 生效（判据万一写错也只影响一小批）', () => {
  const s = mkStore()
  try {
    const old = oldTs()
    for (let i = 0; i < 10; i++) {
      s.insertMemory({ type: 'episode', text: `垃圾${i}`, salience: 0.1, created: old, lastSeen: old })
    }
    assert.equal(s.pruneLowValue({ now: Math.floor(Date.now() / 1000), limit: 3 }).pruned, 3)
  } finally { s.cleanup() }
})

test('pruneLowValue：未来 valid_until 的不清（交给 dueExpire，别抢）', () => {
  const s = mkStore()
  try {
    const old = oldTs()
    const now = Math.floor(Date.now() / 1000)
    const m = s.insertMemory({ type: 'episode', text: '还没到期的', salience: 0.1, created: old, lastSeen: old, validUntil: now + 7 * daySec })
    assert.equal(s.pruneLowValue({ now }).pruned, 0, '有未来失效时间的交给 dueExpire 处理')
    assert.equal(s.db.prepare('SELECT state FROM memories WHERE id = ?').get(m.id).state, 'active')
  } finally { s.cleanup() }
})
