// test/memory-v5-supersede.test.mjs —— distill 的 supersede 与迁移来的 sha1 key 对齐（task-21）
//
// 背景（memory-python 在 task-19 回执里标出的最大衔接风险）：
//   Step 3 的迁移脚本（scripts/memory-v4-to-v5.mjs）给历史记忆的 key 是
//   `sha1(type + '\x1f' + subject + '\x1f' + 归一化文本)`（40 位 hex）；
//   而 distill 新建记忆的 key 是 `type:subject:topic`（人读主题词）。
//   两套 key 永远精确匹配不上 → **迁移来的旧条目永远不会被 supersede**，
//   同一个主题会新旧并存、检索里两条都进（噪音率翻倍）。
//
// 修法：distill 写库后先试精确 key（distill 自己建的条目），若没有命中，就在
// **同 type + 同 subject** 范围内用 bigram 文本相似度找最像的旧条目，
// score ≥ 阈值（默认 0.5）→ archiveMemory('superseded', {supersededBy: 新id})。
//
// 测试重点：
//   · 迁移 sha1 旧条 + distill 新结论 → 旧条归档且 superseded_by 正确；
//   · 不跨 subject、不跨 type（「两个人都提到开会」不能误并）；
//   · 双方都有 topic 且不同 → 不合并（并列事实，我的测试抓到的真实反例）；
//   · 阈值边界（正好 0.5 合并，0.83 在 0.9 阈值下不合并）；
//   · 重复跑幂等（不重复归档、不重复插入）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-v5-supersede-'))
process.env.HOME = TMP_HOME
process.env.USERPROFILE = TMP_HOME
process.env.DSH_HOME = path.join(TMP_HOME, '.dsh')

const S = await import(pathToFileURL(path.join(ROOT, 'lib', 'agent', 'memory-v5', 'store.mjs')).href)
const D = await import(pathToFileURL(path.join(ROOT, 'lib', 'agent', 'memory-v5', 'distill.mjs')).href)

const { openV5 } = S
const {
  textSimilarity, topicFromKey, findSupersedeCandidates, findSupersedeTarget,
  ingestMemories, distillPending, supersedeReport,
  DEFAULT_SUPERSEDE_MIN_SCORE, DEFAULT_SUPERSEDE_CANDIDATES,
} = D

let caseNo = 0
function mkStore () {
  caseNo += 1
  const dir = path.join(TMP_HOME, 'db', String(caseNo))
  const store = openV5({ dbPath: path.join(dir, 'mem-v5.db') })
  return { store, cleanup: () => { try { store.close() } catch { /* ignore */ } try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } } }
}
test.after(() => { try { fs.rmSync(TMP_HOME, { recursive: true, force: true }) } catch { /* ignore */ } })

const NOW = 1_800_000_000
const memoriesJson = list => JSON.stringify({ memories: list })

/** 复刻迁移脚本的 key：sha1(type \x1f subject \x1f 归一化文本)。只读探针，用于造历史数据。 */
function migrationKey (type, subject, text) {
  const norm = String(text ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
  const raw = `${type}\x1f${subject === null || subject === undefined ? '' : String(subject)}\x1f${norm}`
  return crypto.createHash('sha1').update(raw, 'utf8').digest('hex')
}

function addEvent (store, { conv = 'c2c:10086', msgId, speaker = '10086', text, at = NOW - 60 } = {}) {
  return store.appendEvent({ conv, msgId, speaker, text, at, kindRaw: 'text' }).id
}

const activeOfSubject = (store, subject) => store.db.prepare(
  `SELECT id, text, key, state, archived_reason, superseded_by FROM memories
   WHERE subject IS ? OR subject = ? ORDER BY id`,
).all(subject, subject)

const fakeLlm = payload => async () => (typeof payload === 'function' ? payload() : payload)

// ── ① 相似度函数本身 ───────────────────────────────────────────────────────

test('textSimilarity：完全一样 = 1；无关 = 0；空 = 0', () => {
  assert.equal(textSimilarity('开会记得带电脑', '开会记得带电脑').score, 1)
  assert.equal(textSimilarity('开会记得带电脑', '今天天气不错').score, 0)
  assert.equal(textSimilarity('', '开会').score, 0)
  // 标点/空白不影响（分词时已经剥掉）
  assert.equal(textSimilarity('开会，记得带电脑！', '开会 记得带电脑').score, 1)
})

test('textSimilarity：加主语/加长的改写 → containment 明显高于 Jaccard，score 取高的那个', () => {
  const sim = textSimilarity('喜欢冰美式', '对方最喜欢喝冰美式')
  // 短句 4 个 bigram，长句 8 个，交集 3：
  //   Jaccard = 3/9 = 0.33（被长句多出来的 bigram 拖低）
  //   containment = 3/4 = 0.75（> 阈值，能合并）
  assert.ok(Math.abs(sim.containment - 0.75) < 1e-9, `containment=${sim.containment}`)
  assert.ok(sim.jaccard < sim.containment, 'Jaccard 应该被长度拖低')
  assert.equal(sim.score, sim.containment, 'score 必须取 max —— 否则「旧句→加长版」这种改写合并不上')
  assert.ok(sim.score >= DEFAULT_SUPERSEDE_MIN_SCORE)
})

test('textSimilarity：真实取代样例「安全底裤还没做」→「对方的安全底裤已经生效很久了」正好 0.5', () => {
  const sim = textSimilarity('安全底裤还没做', '对方的安全底裤已经生效很久了')
  assert.ok(Math.abs(sim.containment - 0.5) < 1e-9, `containment 应该正好 0.5，实际 ${sim.containment}`)
  assert.ok(sim.jaccard < 0.3, `Jaccard 被长度拖低到 ${sim.jaccard}`)
  assert.equal(sim.score, 0.5, '默认阈值 0.5 是「含等于」——这条要能合并')
})

test('topicFromKey：distill key 能取主题；迁移 sha1 key 没有主题信息', () => {
  assert.equal(topicFromKey('fact:10086:城市'), '城市')
  assert.equal(topicFromKey('commitment:global:周三 会议'), '周三 会议')
  assert.equal(topicFromKey(migrationKey('fact', '10086', '对方在杭州上班')), null, 'sha1 key 不能当主题')
  assert.equal(topicFromKey(null), null)
  assert.equal(topicFromKey(''), null)
  assert.equal(topicFromKey('not-a-key'), null)
})

// ── ② 迁移 sha1 旧条 + distill 新结论（核心场景）────────────────────────────

test('核心：迁移来的 sha1 key 旧条 → distill 同主题新结论 → 旧条 archived(superseded) 且链正确', async () => {
  const { store, cleanup } = mkStore()
  try {
    // 模拟 Step 3 迁移：旧记忆的 key 是 sha1 文本指纹，没有 topic
    const oldText = '喜欢喝冰美式'
    const oldId = store.insertMemory({
      type: 'preference', subject: '10086', text: oldText, key: migrationKey('preference', '10086', oldText),
      confidence: 0.6, salience: 0.4, created: NOW - 30 * 24 * 3600, lastSeen: NOW - 30 * 24 * 3600,
    }).id
    assert.equal(topicFromKey(store.getMemory(oldId).key), null, '前置：迁移条目的 key 没有 topic')

    addEvent(store, { msgId: 'm1', text: '我最近天天喝冰美式', at: NOW - 60 })
    const llm = fakeLlm(memoriesJson([
      { type: 'preference', text: '对方喜欢喝冰美式', subject: '10086', conv: 'c2c:10086', topic: '咖啡偏好', confidence: 0.9, salience: 0.7, src: 1 },
    ]))
    const r = await distillPending({ store, llm, now: NOW })
    assert.equal(r.created, 1)
    assert.equal(r.superseded, 1, '迁移来的旧条必须被取代（精确 key 匹配不上，靠相似度）')
    assert.equal(r.supersededByKey, 0)
    assert.equal(r.supersededBySimilarity, 1, '这条应该走相似度路径')

    const oldRow = store.getMemory(oldId)
    assert.equal(oldRow.state, 'archived')
    assert.equal(oldRow.archived_reason, 'superseded')
    const newRow = store.db.prepare("SELECT * FROM memories WHERE state = 'active'").get()
    assert.equal(oldRow.superseded_by, newRow.id, 'superseded_by 要指向新的那条')
    assert.equal(newRow.text, '对方喜欢喝冰美式')

    // 检索只看得见新版本（旧的不再污染注入）
    const hits = store.searchMemories({ query: '冰美式' })
    assert.deepEqual(hits.map(h => h.id), [newRow.id])

    // merges 里要能看出是哪条被谁取代、走哪条路径、分数多少（生产验收要看）
    assert.equal(r.merges.length, 1)
    assert.deepEqual(r.merges[0].oldId, oldId)
    assert.deepEqual(r.merges[0].newId, newRow.id)
    assert.equal(r.merges[0].via, 'similarity')
    assert.ok(r.merges[0].score >= DEFAULT_SUPERSEDE_MIN_SCORE)
  } finally { cleanup() }
})

test('核心：迁移条目正文与旧 v4 措辞一致（「安全底裤还没做」）→ 相似度 0.5 正好合并', async () => {
  const { store, cleanup } = mkStore()
  try {
    const oldText = '安全底裤还没做'
    const oldId = store.insertMemory({
      type: 'fact', subject: '10086', text: oldText, key: migrationKey('fact', '10086', oldText),
      confidence: 0.7, salience: 0.6, created: NOW - 3600, lastSeen: NOW - 3600,
    }).id
    addEvent(store, { msgId: 'm1', text: '安全底裤早就生效了', at: NOW - 60 })
    const llm = fakeLlm(memoriesJson([
      { type: 'fact', text: '对方的安全底裤已经生效很久了', subject: '10086', conv: 'c2c:10086', topic: '安全底裤', confidence: 0.9, salience: 0.8, src: 1 },
    ]))
    const r = await distillPending({ store, llm, now: NOW })
    assert.equal(r.superseded, 1, '同主题换结论必须被取代（否则新旧并存）')
    assert.equal(store.getMemory(oldId).state, 'archived')
  } finally { cleanup() }
})

// ── ③ 安全边界：不跨 subject / 不跨 type / topic 冲突不合并 ─────────────────

test('不跨 subject：两个人说类似的话不能互相取代', async () => {
  const { store, cleanup } = mkStore()
  try {
    const otherOld = store.insertMemory({
      type: 'preference', subject: '20002', text: '喜欢喝冰美式', key: migrationKey('preference', '20002', '喜欢喝冰美式'),
      created: NOW - 3600, lastSeen: NOW - 3600,
    }).id

    addEvent(store, { conv: 'c2c:10086', msgId: 'm1', text: '我最近天天喝冰美式', at: NOW - 60 })
    const llm = fakeLlm(memoriesJson([
      { type: 'preference', text: '对方喜欢喝冰美式', subject: '10086', conv: 'c2c:10086', topic: '咖啡偏好', src: 1 },
    ]))
    const r = await distillPending({ store, llm, now: NOW })
    assert.equal(r.created, 1)
    assert.equal(r.superseded, 0, '别人的同类偏好不能被这条取代')
    assert.equal(store.getMemory(otherOld).state, 'active', '20002 的旧条目必须还是 active')

    // 反证：候选查询里也绝不该出现别的 subject
    const cands = findSupersedeCandidates({ store, type: 'preference', subject: '10086', text: '对方喜欢喝冰美式' })
    assert.ok(cands.every(c => c.subject === '10086'), '候选里混进了别的 subject')
  } finally { cleanup() }
})

test('群级（subject=null）只和群级比：不碰任何具体人的同类规矩', () => {
  const { store, cleanup } = mkStore()
  try {
    // 两条内容几乎相同的旧规矩：一条是「某个人的」，一条是群级的（都来自迁移、sha1 key）
    const personOld = store.insertMemory({
      type: 'rule', subject: '10086', text: '群里晚上十一点后不要发消息', key: migrationKey('rule', '10086', '群里晚上十一点后不要发消息'),
      salience: 0.9, created: NOW - 3600, lastSeen: NOW - 3600,
    }).id
    const groupOld = store.insertMemory({
      type: 'rule', subject: null, text: '群里晚上十一点后不要发消息', key: migrationKey('rule', null, '群里晚上十一点后不要发消息'),
      salience: 0.9, created: NOW - 1800, lastSeen: NOW - 1800,
    }).id

    // 新的**群级**规矩（正文加了一点后缀，避免撞上同文去重）
    const r = ingestMemories({
      store,
      items: [{
        type: 'rule', text: '群里晚上十一点后不要发消息（群规）', subject: null, key: 'rule:global:群规',
        confidence: 0.9, salience: 0.9,
      }],
      now: NOW,
    })
    assert.equal(r.created, 1)
    assert.equal(r.superseded, 1, '群级新规矩应该取代群级旧规矩（相似度路径）')
    assert.equal(r.supersededBySimilarity, 1)
    assert.equal(store.getMemory(groupOld).state, 'archived', '群级旧规矩要被取代')
    assert.equal(store.getMemory(personOld).state, 'active', '某个人的同类规矩不能被群级新规矩吃掉')
  } finally { cleanup() }
})

test('不跨 type：同一个人、相似措辞但 type 不同（fact vs episode）不合并', async () => {
  const { store, cleanup } = mkStore()
  try {
    const factOld = store.insertMemory({
      type: 'fact', subject: '10086', text: '明天下午三点开会', key: migrationKey('fact', '10086', '明天下午三点开会'),
      created: NOW - 3600, lastSeen: NOW - 3600,
    }).id
    const r = ingestMemories({
      store,
      items: [{
        type: 'episode', text: '明天下午三点开会这件事已经聊过了', subject: '10086', key: 'episode:10086:周三会议',
        confidence: 0.7, salience: 0.5,
      }],
      now: NOW,
    })
    assert.equal(r.created, 1)
    assert.equal(r.superseded, 0, 'type 不同不是「取代」，是两层不同的记忆')
    assert.equal(store.getMemory(factOld).state, 'active')
  } finally { cleanup() }
})

test('topic 冲突（并列事实）不合并：职业 vs 城市（相似度 0.6 也不许并）', async () => {
  const { store, cleanup } = mkStore()
  try {
    const job = store.insertMemory({
      type: 'fact', subject: '10086', text: '对方在杭州做后端开发', key: 'fact:10086:职业',
      confidence: 0.9, salience: 0.8, created: NOW - 100, lastSeen: NOW - 100,
    }).id
    // 前置：这条本来会被相似度命中（containment 0.6 > 阈值），topic 闸必须拦住
    const cands = findSupersedeCandidates({
      store, type: 'fact', subject: '10086', text: '对方住在杭州', newKey: 'fact:10086:城市',
    })
    assert.deepEqual(cands.map(c => c.id), [], '双方都有 topic 且不同 → 不是同一个话题，不该当候选')

    const r = ingestMemories({
      store,
      items: [{ type: 'fact', text: '对方住在杭州', subject: '10086', key: 'fact:10086:城市', confidence: 0.9, salience: 0.7 }],
      now: NOW,
    })
    assert.equal(r.created, 1)
    assert.equal(r.superseded, 0, '并列事实不能互相取代（会丢真信息）')
    assert.equal(store.getMemory(job).state, 'active')

    // 但「至少一方没有 topic」（迁移 sha1 旧条）时，相似度仍要工作 ——
    // 否则 task-21 的核心场景就废了
    const migratedOld = store.insertMemory({
      type: 'fact', subject: '20002', text: '对方在杭州做后端开发', key: migrationKey('fact', '20002', '对方在杭州做后端开发'),
      created: NOW - 200, lastSeen: NOW - 200,
    }).id
    const cands2 = findSupersedeCandidates({
      store, type: 'fact', subject: '20002', text: '对方住在杭州', newKey: 'fact:20002:城市',
    })
    assert.equal(cands2.length, 1, '旧条没有 topic（sha1）→ 相似度可以合并')
    assert.equal(cands2[0].id, migratedOld)
  } finally { cleanup() }
})

// ── ④ 精确 key 优先 ────────────────────────────────────────────────────────

test('精确 key 命中优先于相似度（不再看相似度候选）', async () => {
  const { store, cleanup } = mkStore()
  try {
    const sameKeyOld = store.insertMemory({
      type: 'fact', subject: '10086', text: '对方在杭州上班', key: 'fact:10086:城市',
      created: NOW - 3600, lastSeen: NOW - 3600,
    }).id
    // 另一条「更像」但与新条 topic 不同 —— 精确 key 命中时不该动它
    const other = store.insertMemory({
      type: 'fact', subject: '10086', text: '对方的老家在杭州', key: migrationKey('fact', '10086', '对方的老家在杭州'),
      created: NOW - 7200, lastSeen: NOW - 7200,
    }).id

    const r = ingestMemories({
      store,
      items: [{ type: 'fact', text: '对方现在住在杭州', subject: '10086', key: 'fact:10086:城市', confidence: 0.9, salience: 0.7 }],
      now: NOW,
    })
    assert.equal(r.superseded, 1)
    assert.equal(r.supersededByKey, 1, '精确 key 命中应走 key 路径')
    assert.equal(r.supersededBySimilarity, 0)
    assert.equal(store.getMemory(sameKeyOld).state, 'archived')
    assert.equal(store.getMemory(other).state, 'active', '精确 key 命中时不要再按相似度误伤别的条目')
  } finally { cleanup() }
})

test('精确 key 有多条 active（历史脏数据）→ 全部归档到新条', async () => {
  const { store, cleanup } = mkStore()
  try {
    for (const t of ['版本一', '版本二']) {
      store.insertMemory({ type: 'fact', subject: '10086', text: t, key: 'fact:10086:城市', created: NOW - 100, lastSeen: NOW - 100 })
    }
    const r = ingestMemories({
      store,
      items: [{ type: 'fact', text: '版本三', subject: '10086', key: 'fact:10086:城市', confidence: 0.9, salience: 0.7 }],
      now: NOW,
    })
    assert.equal(r.supersededByKey, 2, '同 key 的旧条目（可能不止一条）都该被取代')
  } finally { cleanup() }
})

// ── ⑤ 阈值边界与可配 ──────────────────────────────────────────────────────

test('阈值边界：score≈0.83 的候选，在 0.9 阈值下不合并、在 0.8 下合并', () => {
  const { store, cleanup } = mkStore()
  try {
    const oldText = '开会记得带电脑'
    store.insertMemory({ type: 'fact', subject: '10086', text: oldText, key: migrationKey('fact', '10086', oldText), created: NOW - 100, lastSeen: NOW - 100 })
    // 「开会议记得带电脑」比旧句多一个 bigram、交集 5/6 → J=0.625 / containment=0.833
    const newText = '开会议记得带电脑'
    const sim = textSimilarity(oldText, newText)
    assert.ok(sim.score > 0.8 && sim.score < 0.9, `构造的样例分数应在 0.8~0.9（实际 ${sim.score}）`)

    assert.equal(findSupersedeCandidates({ store, type: 'fact', subject: '10086', text: newText, minScore: 0.9 }).length, 0,
      '阈值 0.9 时不该合并')
    assert.equal(findSupersedeCandidates({ store, type: 'fact', subject: '10086', text: newText, minScore: 0.8 }).length, 1,
      '阈值 0.8 时应该合并')
  } finally { cleanup() }
})

test('阈值可配：distillPending({minSupersedeScore: 0.9}) 时不合并 0.5 分的那对', async () => {
  const { store, cleanup } = mkStore()
  try {
    const oldText = '安全底裤还没做'
    const oldId = store.insertMemory({
      type: 'fact', subject: '10086', text: oldText, key: migrationKey('fact', '10086', oldText), created: NOW - 3600, lastSeen: NOW - 3600,
    }).id
    addEvent(store, { msgId: 'm1', text: '安全底裤早就生效了', at: NOW - 60 })
    const llm = fakeLlm(memoriesJson([
      { type: 'fact', text: '对方的安全底裤已经生效很久了', subject: '10086', conv: 'c2c:10086', topic: '安全底裤', src: 1 },
    ]))
    const r = await distillPending({ store, llm, now: NOW, minSupersedeScore: 0.9 })
    assert.equal(r.superseded, 0, '阈值调高后不该合并（宁可并存，也不要误归档）')
    assert.equal(store.getMemory(oldId).state, 'active')
  } finally { cleanup() }
})

test('候选上限：同 subject 的相似候选再多，也只算前 N 个（性能护栏）', () => {
  const { store, cleanup } = mkStore()
  try {
    for (let i = 0; i < 40; i++) {
      store.insertMemory({
        type: 'fact', subject: '10086', text: `对方在杭州做后端开发第${i}版`,
        key: migrationKey('fact', '10086', `对方在杭州做后端开发第${i}版`),
        created: NOW - 1000 + i, lastSeen: NOW - 1000 + i,
      })
    }
    const cands = findSupersedeCandidates({ store, type: 'fact', subject: '10086', text: '对方在杭州做后端开发', limit: 5 })
    assert.ok(cands.length <= 5, `候选数超过 limit：${cands.length}`)
    assert.ok(cands.every(c => c.score >= DEFAULT_SUPERSEDE_MIN_SCORE))
    assert.ok(DEFAULT_SUPERSEDE_CANDIDATES <= 20, '默认候选上限应该很小（每轮每条约 20 次 bigram 运算）')
    // 排序：分数降序
    for (let i = 1; i < cands.length; i++) assert.ok(cands[i - 1].score >= cands[i].score)
  } finally { cleanup() }
})

// ── ⑥ 幂等 ──────────────────────────────────────────────────────────────────

test('重复跑幂等：同一条新结论第二次提炼不会再插一条、也不会重复归档', async () => {
  const { store, cleanup } = mkStore()
  try {
    const oldText = '喜欢喝冰美式'
    const oldId = store.insertMemory({
      type: 'preference', subject: '10086', text: oldText, key: migrationKey('preference', '10086', oldText),
      created: NOW - 3600, lastSeen: NOW - 3600,
    }).id
    addEvent(store, { msgId: 'm1', text: '我最近天天喝冰美式', at: NOW - 60 })
    const llm = fakeLlm(memoriesJson([
      { type: 'preference', text: '对方喜欢喝冰美式', subject: '10086', conv: 'c2c:10086', topic: '咖啡偏好', src: 1 },
    ]))
    const r1 = await distillPending({ store, llm, now: NOW })
    assert.equal(r1.created, 1)
    assert.equal(r1.superseded, 1)

    // 模拟 crash 后 watermark 回退 → 同一批事件再提炼一遍
    store.db.prepare("UPDATE v5_meta SET v = '0' WHERE k = 'distill:watermark'").run()
    const r2 = await distillPending({ store, llm, now: NOW + 10 })
    assert.equal(r2.created, 0, '幂等：不重复插入')
    assert.equal(r2.superseded, 0, '幂等：已归档的不会重复归档（也不会把新条自己归档掉）')
    assert.equal(store.getMemory(oldId).state, 'archived')
    const activeRows = store.db.prepare("SELECT * FROM memories WHERE state = 'active'").all()
    assert.equal(activeRows.length, 1, `active 应该只有一条新版本，实际 ${activeRows.length}`)
    // 幂等重放记了一次「又见到」
    assert.equal(r2.touched, 1)
  } finally { cleanup() }
})

test('没有候选就正常插入（相似度低于阈值不合并）', () => {
  const { store, cleanup } = mkStore()
  try {
    const oldId = store.insertMemory({ type: 'fact', subject: '10086', text: '他喜欢猫', key: migrationKey('fact', '10086', '他喜欢猫'), created: NOW - 100, lastSeen: NOW - 100 }).id
    const r = ingestMemories({
      store,
      items: [{ type: 'fact', text: '明天公司要团建', subject: '10086', key: 'fact:10086:团建', confidence: 0.8, salience: 0.5 }],
      now: NOW,
    })
    assert.equal(r.created, 1)
    assert.equal(r.superseded, 0)
    assert.equal(store.getMemory(oldId).state, 'active')
  } finally { cleanup() }
})

// ── ⑦ 生产验收：supersedeReport ────────────────────────────────────────────

test('supersedeReport：只读统计 + 样例（生产迁移后验收用）', async () => {
  const { store, cleanup } = mkStore()
  try {
    const a = store.insertMemory({ type: 'preference', subject: '10086', text: '喜欢喝冰美式', key: migrationKey('preference', '10086', '喜欢喝冰美式'), created: NOW - 3600, lastSeen: NOW - 3600 }).id
    const b = store.insertMemory({ type: 'fact', subject: '10086', text: '安全底裤还没做', key: migrationKey('fact', '10086', '安全底裤还没做'), created: NOW - 3600, lastSeen: NOW - 3600 }).id
    ingestMemories({
      store,
      items: [
        { type: 'preference', text: '对方喜欢喝冰美式', subject: '10086', key: 'preference:10086:咖啡偏好', confidence: 0.9, salience: 0.7 },
        { type: 'fact', text: '对方的安全底裤已经生效很久了', subject: '10086', key: 'fact:10086:安全底裤', confidence: 0.9, salience: 0.8 },
      ],
      now: NOW,
    })
    const rep = supersedeReport({ store })
    assert.equal(rep.superseded, 2)
    assert.equal(rep.supersededFromMigratedKey, 2, '两条都是从 sha1 key 迁移来的（旧 key 40 位）')
    assert.equal(rep.brokenChain, 0, 'superseded 必须有 superseded_by')
    assert.equal(rep.active, 2)
    assert.equal(rep.examples.length, 2)
    assert.ok(rep.examples.every(e => e.oldText && e.newText && e.oldId && e.newId))
    // 只读：调用两次结果一样，且库没变
    assert.deepEqual(supersedeReport({ store }), rep)
    assert.equal(store.getMemory(a).state, 'archived')
    assert.equal(store.getMemory(b).state, 'archived')
  } finally { cleanup() }
})
