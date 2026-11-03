// test/memory-v5-distill.test.mjs —— 记忆 v5 提炼 worker（Step 2，events → memories + profiles）
//
// 覆盖 docs §3.6 的三条要求 + task-16 的验收点：
//   · 失败必须可见（jobs 退避/死信 + last_error_kind 区分 unavailable/runtime）；
//   · 窗口不能是单向传送带（按 watermark 取增量，跳过的噪音也要推进游标，
//     不能把后面的真消息堵死）；
//   · 幂等（同一批 events 重放不重复入库；同 key 新版本 → superseded 链）。
//
// 全部用**假 llm** + 临时库（os.tmpdir），不碰生产库、不连网络、不真调模型。
// 唯一「真起子进程」的是 createAcpLlm 的适配器测试 —— 它起的是我们现写的假脚本，
// 用来验证 exit code → unavailable/runtime 的映射（那是「失败可见」的地基）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-v5-distill-'))
process.env.HOME = TMP_HOME
process.env.USERPROFILE = TMP_HOME
process.env.DSH_HOME = path.join(TMP_HOME, '.dsh')

const S = await import(pathToFileURL(path.join(ROOT, 'lib', 'agent', 'memory-v5', 'store.mjs')).href)
const D = await import(pathToFileURL(path.join(ROOT, 'lib', 'agent', 'memory-v5', 'distill.mjs')).href)
const P = await import(pathToFileURL(path.join(ROOT, 'lib', 'agent', 'memory-v5', 'distill-prompt.mjs')).href)

const { openV5, v5DbPath } = S
const {
  distillPending, distillOnce, ensureDistillJob, distillBacklog, distillStatus,
  projectProfile, projectProfiles, ingestMemories, getWatermark,
  createAcpLlm, LlmError, errorKindOf,
} = D
const {
  canonicalEventText, isUsableEvent, isNoiseText, buildDistillPrompt,
  parseDistillOutput, zonedWallTimeToEpoch, fmtLocal,
} = P

let caseNo = 0
function mkStore (opts = {}) {
  caseNo += 1
  const dir = path.join(TMP_HOME, 'db', String(caseNo))
  const dbPath = path.join(dir, 'mem-v5.db')
  const store = openV5({ dbPath, ...opts })
  return { store, dir, cleanup: () => { try { store.close() } catch { /* ignore */ } try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } } }
}
test.after(() => { try { fs.rmSync(TMP_HOME, { recursive: true, force: true }) } catch { /* ignore */ } })

const HOUR = 3600
const NOW = 1_800_000_000   // 固定「现在」（2027-01-15 左右，具体值不重要，只要确定）

/** 造一个「只输出给定 JSON」的假 llm，并记录下来拿到的 prompt（给断言用）。 */
function fakeLlm (payload, { calls = [] } = {}) {
  const fn = async (prompt) => {
    calls.push(prompt)
    return typeof payload === 'function' ? payload(prompt, calls.length) : payload
  }
  fn.calls = calls
  return fn
}
const memoriesJson = list => JSON.stringify({ memories: list })

function addEvent (store, { conv = 'c2c:10086', msgId, speaker = '10086', text, at = NOW - 60, kindRaw = 'text', meta = null } = {}) {
  return store.appendEvent({ conv, msgId, speaker, text, at, kindRaw, meta }).id
}

// ── ① 事件侧过滤（P0-5 污染 / P1-6 噪音）────────────────────────────────────

test('canonicalEventText：剥掉控制标记（[SILENT]/[SEND_FILE:...] 这些不该进记忆）', () => {
  assert.equal(canonicalEventText({ text: '[SILENT]' }), '')
  assert.equal(canonicalEventText({ text: '[SEND_FILE: /tmp/a.png]' }), '')
  assert.equal(canonicalEventText({ text: '好的 [AT:10086] 我来' }), '好的 我来')
  assert.equal(canonicalEventText({ text: '[VOICE:晚上好] 听着' }), '听着')
})

test('canonicalEventText：纯语音占位但有转写 → 用转写（否则语音内容整个丢了）', () => {
  const text = canonicalEventText({
    text: '[语音]', kind_raw: 'voice',
    meta: JSON.stringify({ transcripts: ['明天下午三点开会'] }),
  })
  assert.equal(text, '明天下午三点开会')
  // 有正文时把转写附上（模型可能只看到占位，转写是额外信息）
  const both = canonicalEventText({
    text: '听一下', kind_raw: 'voice', meta: { transcripts: ['明天下午三点开会'] },
  })
  assert.match(both, /听一下/)
  assert.match(both, /语音转写：明天下午三点开会/)
})

test('canonicalEventText：纯图/纯文件占位没有可提炼内容 → 空串', () => {
  assert.equal(canonicalEventText({ text: '[图片]' }), '')
  assert.equal(canonicalEventText({ text: '[图片 ×3]' }), '')
  assert.equal(canonicalEventText({ text: '[文件]' }), '')
  assert.equal(canonicalEventText({ text: '[合并转发]' }), '')
})

test('isUsableEvent：合并轮（meta.merged）必须跳过 —— 同一句话不能提炼两遍', () => {
  const merged = { id: 2, conv: 'c2c:1', speaker: '1', text: '明天下午三点开会', meta: JSON.stringify({ merged: true, mergedCount: 3 }) }
  assert.equal(isUsableEvent(merged).ok, false)
  assert.equal(isUsableEvent(merged).reason, 'merged')
  // 原始事件（没打标记）照常处理
  assert.equal(isUsableEvent({ id: 1, conv: 'c2c:1', speaker: '1', text: '明天下午三点开会' }).ok, true)
})

test('isUsableEvent：self 的纯工具/占位文本跳过（P1-7 那批「永久规矩」的来源）', () => {
  for (const text of ['[SILENT]', '[SEND_FILE: /tmp/x.png]', '[POKE:10086]', '[SPLIT]', '[图片]']) {
    const v = isUsableEvent({ id: 1, conv: 'c2c:1', speaker: 'self', text })
    assert.equal(v.ok, false, `${text} 不该进提炼`)
  }
  // 正常发言要保留（当上下文，prompt 里明说别从 self 的话推规矩）
  assert.equal(isUsableEvent({ id: 1, conv: 'c2c:1', speaker: 'self', text: '我一会儿查一下天气' }).ok, true)
})

test('isUsableEvent/isNoiseText：短句噪音不喂模型（P1-6：v4 白名单拦截率 0%）', () => {
  for (const t of ['哦哦', '嗯', '嗯嗯', '哈哈', '在吗', '好的', '可以', '111', 'okk', '谢谢']) {
    assert.equal(isNoiseText(t), true, `${t} 应该算噪音`)
    assert.equal(isUsableEvent({ id: 1, conv: 'c2c:1', speaker: '1', text: t }).ok, false)
  }
  for (const t of ['明天下午三点开会', '我养了只猫叫豆豆', '累死我了']) {
    assert.equal(isNoiseText(t), false, `${t} 不是噪音`)
    assert.equal(isUsableEvent({ id: 1, conv: 'c2c:1', speaker: '1', text: t }).ok, true)
  }
})

// ── ② prompt 设计 ──────────────────────────────────────────────────────────

test('buildDistillPrompt：包含「现在/时区」、六类 type、硬性要求、输出 JSON 契约', () => {
  const { prompt } = buildDistillPrompt({
    events: [{ id: 1, conv: 'c2c:10086', speaker: '10086', text: '明天下午三点开会', at: NOW - 60 }],
    now: NOW,
  })
  assert.match(prompt, /现在是/)                       // 模型据此把「明天」换成绝对时间
  assert.match(prompt, /时区 Asia\/Shanghai/)
  for (const t of ['fact', 'preference', 'commitment', 'episode', 'rule', 'relation']) {
    assert.ok(prompt.includes(t), `prompt 里没写 type=${t}`)
  }
  assert.match(prompt, /第三人称/)
  assert.match(prompt, /不要.*推测|不推测|不编造/)      // P0-1：不许编
  assert.match(prompt, /纯寒暄|语气词/)                 // P1-6：噪音规则
  assert.match(prompt, /topic/)                         // 取代逻辑靠它
  assert.match(prompt, /valid_until/)                   // 时间事实
  assert.match(prompt, /"memories"/)                    // 输出契约
  // 对话行的格式：行号 + 时间 + conv + speaker
  assert.match(prompt, /#1 \[[\d-]+ [\d:]+\] \[conv=c2c:10086\] \[speaker=10086\] 明天下午三点开会/)
})

test('buildDistillPrompt：只喂 usable 事件；单行超长截断（全文仍在 events 里）', () => {
  const long = '很长的正文'.repeat(200)
  const { prompt, includedIds } = buildDistillPrompt({
    events: [
      { id: 1, conv: 'c2c:1', speaker: '1', text: '短句', at: NOW },
      { id: 2, conv: 'c2c:1', speaker: '1', text: long, at: NOW },
    ],
    now: NOW, maxLineChars: 50,
  })
  assert.deepEqual(includedIds, [1, 2])
  const line2 = prompt.split('\n').find(l => l.startsWith('#2'))
  assert.ok(line2.length < 120, `单行没截断：${line2.length}`)
  assert.match(line2, /…$/)
})

test('buildDistillPrompt：prompt 预算装不下时**少喂几条**，返回 deferredIds（绝不能跳过）', () => {
  const events = Array.from({ length: 10 }, (_, i) => ({
    id: i + 1, conv: 'c2c:1', speaker: '1', text: '一条比较长的消息'.repeat(10), at: NOW,
  }))
  const r = buildDistillPrompt({ events, now: NOW, maxLineChars: 200, maxPromptChars: 2500 })
  assert.ok(r.includedIds.length >= 1, '至少要喂一条，否则永远推进不了')
  assert.ok(r.deferredIds.length >= 1, '超预算的必须顺延（返回 deferredIds）')
  assert.equal(r.includedIds.length + r.deferredIds.length, events.length)
  // 顺延的是**后面的**事件（顺序不能乱）
  assert.ok(Math.max(...r.includedIds) < Math.min(...r.deferredIds))
})

test('zonedWallTimeToEpoch：本地墙钟时间按给定时区换算；纯数字当 epoch', () => {
  // Asia/Shanghai 是 UTC+8（无 DST）
  assert.equal(zonedWallTimeToEpoch('2026-11-04T15:00:00', 'Asia/Shanghai'), Date.UTC(2026, 10, 4, 7, 0, 0) / 1000)
  assert.equal(zonedWallTimeToEpoch('2026-11-04 15:00', 'Asia/Shanghai'), Date.UTC(2026, 10, 4, 7, 0, 0) / 1000)
  assert.equal(zonedWallTimeToEpoch('1800000000', 'Asia/Shanghai'), 1800000000)
  assert.equal(zonedWallTimeToEpoch('1800000000000', 'Asia/Shanghai'), 1800000000)
  assert.equal(zonedWallTimeToEpoch('不是时间', 'Asia/Shanghai'), null)
  assert.equal(zonedWallTimeToEpoch('', 'Asia/Shanghai'), null)
})

// ── ③ 输出解析/校验 ─────────────────────────────────────────────────────────

test('parseDistillOutput：容忍 markdown 围栏 / 前后废话 / 裸数组', () => {
  const base = [{ type: 'fact', text: '对方养了一只猫叫豆豆', subject: '10086', topic: '猫的名字' }]
  for (const raw of [
    JSON.stringify({ memories: base }),
    '```json\n' + JSON.stringify({ memories: base }) + '\n```',
    '好的，结果如下：\n' + JSON.stringify({ memories: base }) + '\n以上。',
    JSON.stringify(base),
  ]) {
    const r = parseDistillOutput(raw, { allowedConvs: ['c2c:10086'], speakers: ['10086'] })
    assert.equal(r.memories.length, 1, `解析失败：${raw.slice(0, 40)}`)
    assert.equal(r.memories[0].text, '对方养了一只猫叫豆豆')
  }
})

test('parseDistillOutput：类型别名（中文）→ 英文；未知类型丢弃并告警', () => {
  const r = parseDistillOutput(memoriesJson([
    { type: '偏好', text: '对方喜欢喝冰美式不加糖', subject: '1', topic: '咖啡' },
    { type: '胡说八道', text: '这条类型不认识应该被丢掉', subject: '1', topic: 'x' },
    { type: 'fact', text: '这条正常', subject: '1', topic: 'y' },
  ]), { speakers: ['1'], allowedConvs: ['c2c:1'] })
  assert.deepEqual(r.memories.map(m => m.type), ['preference', 'fact'])
  assert.equal(r.dropped, 1)
  assert.ok(r.warnings.some(w => /类型不认识/.test(w)))
})

test('parseDistillOutput：text 太短丢弃、超长截断；confidence/salience 夹到 0~1', () => {
  const r = parseDistillOutput(memoriesJson([
    { type: 'fact', text: '嗯', subject: '1', topic: 'a' },
    { type: 'fact', text: '长'.repeat(500), subject: '1', topic: 'b', confidence: 9, salience: -3 },
    { type: 'fact', text: '正常一条事实', subject: '1', topic: 'c', confidence: 'abc' },
  ]), { speakers: ['1'], allowedConvs: ['c2c:1'] })
  assert.equal(r.memories.length, 2)
  assert.equal(r.memories[0].text.length, 200, '超长要截断（v4 的 text 上限就是 200）')
  assert.equal(r.memories[0].confidence, 1, 'confidence 要夹到 1')
  assert.equal(r.memories[0].salience, 0, 'salience 要夹到 0')
  assert.equal(r.memories[1].confidence, 0.6, '非法 confidence → 默认 0.6')
})

test('parseDistillOutput：subject 必须是本批说话人的 QQ；conv 必须在本批会话里', () => {
  const r = parseDistillOutput(memoriesJson([
    { type: 'fact', text: '对方在杭州上班', subject: '10086', conv: 'c2c:10086', topic: '城市' },
    { type: 'fact', text: '这条 subject 是编的', subject: '999999', topic: 'x' },
    { type: 'fact', text: '这条 subject 不是号码', subject: '小明', topic: 'y' },
    { type: 'fact', text: '这条 conv 不对', subject: '10086', conv: 'group:404', topic: 'z' },
  ]), { speakers: ['10086'], allowedConvs: ['c2c:10086'] })
  assert.equal(r.memories[0].subject, '10086')
  assert.equal(r.memories[0].conv, 'c2c:10086')
  assert.equal(r.memories[1].subject, null, '陌生 subject 要置 null（不能凭空造人）')
  assert.equal(r.memories[2].subject, null, '非 QQ 号置 null')
  assert.equal(r.memories[3].conv, null, '不在本批的 conv 置 null')
  assert.ok(r.warnings.length >= 3)
})

test('parseDistillOutput：rule 的 salience 有下限（规矩≈钉住）、key = type:subject:topic', () => {
  const r = parseDistillOutput(memoriesJson([
    { type: 'rule', text: '对方要求晚上十一点后不要主动找他', subject: '10086', topic: '作息雷点', salience: 0.2 },
    { type: 'fact', text: '对方在杭州上班', subject: '10086', topic: '城市' },
    { type: 'fact', text: '没有 topic 的一条', subject: '10086' },
  ]), { speakers: ['10086'], allowedConvs: ['c2c:10086'] })
  assert.equal(r.memories[0].salience, 0.85, 'rule 类必须高 salience（否则会被价值退场清掉）')
  assert.equal(r.memories[0].key, 'rule:10086:作息雷点')
  assert.equal(r.memories[1].key, 'fact:10086:城市')
  assert.equal(r.memories[2].key, null, '没有 topic 就没有 key（只能靠同文去重）')
  assert.ok(r.warnings.some(w => /缺 topic/.test(w)))
})

test('parseDistillOutput：valid_until 本地时间→epoch；过去的时间丢弃并告警', () => {
  const future = fmtLocal(NOW + 2 * 24 * HOUR).replace(/ (\d{2}):(\d{2})$/, 'T$1:$2:00')
  const past = fmtLocal(NOW - 24 * HOUR).replace(/ (\d{2}):(\d{2})$/, 'T$1:$2:00')
  const r = parseDistillOutput(memoriesJson([
    { type: 'commitment', text: '对方约了明天下午三点开会', subject: '1', topic: '会议', valid_until: future },
    { type: 'commitment', text: '这条的时间已经过去了', subject: '1', topic: '旧事', valid_until: past },
  ]), { speakers: ['1'], allowedConvs: ['c2c:1'], now: NOW })
  assert.ok(r.memories[0].validUntil > NOW, `未来时间没换算对：${r.memories[0].validUntil}`)
  assert.equal(r.memories[1].validUntil, null, '过去的时间边界没意义（dueExpire 会立刻归档）')
  assert.ok(r.warnings.some(w => /早于现在/.test(w)))
})

test('parseDistillOutput：不是 JSON / 没有 memories 数组 → 抛错（交给 jobs 重试，并可见）', () => {
  assert.throws(() => parseDistillOutput('我觉得这段对话记录了……'), /不是 JSON/)
  assert.throws(() => parseDistillOutput('{"foo":1}'), /没有 memories/)
  try {
    parseDistillOutput('随便一段话')
    assert.fail('应该抛错')
  } catch (err) {
    assert.equal(err.code, 'llm_output')
  }
})

// ── ④ distillPending：一批事件 → memories + profiles ───────────────────────

test('distillPending：一批事件 → 记忆入库（type/key/conv/scope/source_event/valid_until）', async () => {
  const { store, cleanup } = mkStore()
  try {
    const e1 = addEvent(store, { msgId: 'm1', text: '明天下午三点开会，地点3楼', at: NOW - 120 })
    const e2 = addEvent(store, { msgId: 'm2', text: '我最喜欢喝冰美式了', at: NOW - 60 })
    const llm = fakeLlm(memoriesJson([
      {
        type: 'commitment', text: '对方约了明天下午三点在三楼开会', subject: '10086',
        conv: 'c2c:10086', topic: '周三会议', confidence: 0.9, salience: 0.7,
        valid_until: fmtLocal(NOW + 24 * HOUR).replace(/ (\d{2}):(\d{2})$/, 'T$1:$2:00'), src: 1,
      },
      { type: 'preference', text: '对方最喜欢喝冰美式', subject: '10086', conv: 'c2c:10086', topic: '咖啡偏好', confidence: 0.8, salience: 0.6, src: 2 },
    ]))

    const r = await distillPending({ store, llm, now: NOW })
    assert.equal(r.fed, 2)
    assert.equal(r.created, 2)
    assert.equal(r.watermark, Math.max(e1, e2))

    const rows = store.db.prepare('SELECT * FROM memories ORDER BY id').all()
    assert.equal(rows.length, 2)
    const [meeting, coffee] = rows
    assert.equal(meeting.type, 'commitment')
    assert.equal(meeting.key, 'commitment:10086:周三会议')
    assert.equal(meeting.scope, 'dm_only', '私聊里说的话默认 dm_only（文档 §4 Step 3 的规则）')
    assert.equal(meeting.source_event, e1, 'source_event 要能追到原始事件（§3.1）')
    assert.ok(meeting.valid_until > NOW)
    assert.equal(coffee.type, 'preference')

    // 幂等：watermark 已经推到最后 → 再跑一次是空的
    const r2 = await distillPending({ store, llm, now: NOW + 1 })
    assert.equal(r2.empty, true)
    assert.equal(store.stats().memories.total, 2)
  } finally { cleanup() }
})

test('distillPending：跳过 merged / self 标记 / 噪音，watermark 照样推进（不能堵住后面的真消息）', async () => {
  const { store, cleanup } = mkStore()
  try {
    addEvent(store, { msgId: 'm1', text: '明天下午三点开会', at: NOW - 400 })
    addEvent(store, { msgId: 'm2', speaker: 'self', text: '[SILENT]', at: NOW - 300 })
    addEvent(store, { msgId: 'm3', text: '哦哦', at: NOW - 200 })
    addEvent(store, { msgId: 'm4', text: '合并轮重复内容', at: NOW - 100, meta: { merged: true, mergedCount: 2 } })
    const llm = fakeLlm(memoriesJson([{ type: 'commitment', text: '对方约了明天下午三点开会', subject: '10086', topic: '会议', src: 1 }]))
    const r = await distillPending({ store, llm, now: NOW })
    assert.equal(r.fed, 1, '只有一条能喂给模型')
    assert.equal(llm.calls.length, 1)
    // prompt 里不该出现被跳过的那几条。
    // ⚠️ 只能看**对话行**（#N 开头）：prompt 的规则文字里本来就有「哦哦/嗯」这些
    //    反例示例（这是故意的），拿整段 prompt 做 includes 会误判。
    const dialogLines = llm.calls[0].split('\n').filter(l => /^#\d+/.test(l))
    assert.equal(dialogLines.length, 1)
    assert.ok(!dialogLines.some(l => l.includes('[SILENT]')))
    assert.ok(!dialogLines.some(l => l.includes('合并轮重复内容')))
    assert.ok(!dialogLines.some(l => l.includes('哦哦')))
    assert.equal(r.skipped.merged, 1)
    assert.equal(r.skipped.noise, 1)
    assert.equal(r.skipped.empty, 1)
    assert.equal(getWatermark(store), 4, 'watermark 必须推到本轮最后一条，否则噪音会反复出现')
  } finally { cleanup() }
})

test('distillPending：整批都是噪音时**不调模型**，但 watermark 必须推进', async () => {
  const { store, cleanup } = mkStore()
  try {
    addEvent(store, { msgId: 'm1', text: '哦哦', at: NOW - 200 })
    addEvent(store, { msgId: 'm2', text: '[图片]', at: NOW - 100 })
    let called = 0
    const llm = async () => { called += 1; return memoriesJson([]) }
    const r = await distillPending({ store, llm, now: NOW })
    assert.equal(called, 0, '全是噪音还调模型 = 白烧 token')
    assert.equal(r.fed, 0)
    assert.equal(getWatermark(store), 2)
    assert.equal(distillBacklog({ store }).pending, 0)
  } finally { cleanup() }
})

test('distillPending：幂等重放 —— watermark 被回退（crash 后重跑）也不产生重复记忆', async () => {
  const { store, cleanup } = mkStore()
  try {
    addEvent(store, { msgId: 'm1', text: '我最喜欢喝冰美式了', at: NOW - 60 })
    const payload = memoriesJson([{ type: 'preference', text: '对方最喜欢喝冰美式', subject: '10086', topic: '咖啡偏好', src: 1 }])
    const llm = fakeLlm(payload)
    await distillPending({ store, llm, now: NOW })
    assert.equal(store.stats().memories.total, 1)

    // 模拟「写库成功但 watermark 没落盘」：手动把 watermark 归零再跑
    store.db.prepare("UPDATE v5_meta SET v = '0' WHERE k = 'distill:watermark'").run()
    const r2 = await distillPending({ store, llm, now: NOW + 10 })
    assert.equal(r2.created, 0, '同一批重跑不能再插一条一样的')
    assert.equal(r2.touched, 1, '重跑应该记一次「又见到了」（access_count 是价值退场的输入）')
    assert.equal(store.stats().memories.total, 1)
    const m = store.db.prepare('SELECT access_count FROM memories').get()
    assert.equal(m.access_count, 1)
  } finally { cleanup() }
})

test('distillPending：同文去重带 subject —— 两个人说同一句话是两条记忆（别写错归属）', async () => {
  const { store, cleanup } = mkStore()
  try {
    addEvent(store, { conv: 'c2c:10086', msgId: 'a1', speaker: '10086', text: '我在杭州上班', at: NOW - 200 })
    addEvent(store, { conv: 'c2c:20002', msgId: 'b1', speaker: '20002', text: '我在杭州上班', at: NOW - 100 })
    const llm = fakeLlm(memoriesJson([
      { type: 'fact', text: '对方在杭州上班', subject: '10086', conv: 'c2c:10086', topic: '城市', src: 1 },
      { type: 'fact', text: '对方在杭州上班', subject: '20002', conv: 'c2c:20002', topic: '城市', src: 2 },
    ]))
    const r = await distillPending({ store, llm, now: NOW })
    assert.equal(r.created, 2, '同文去重只该在「同一个人」的范围内生效')
    const rows = store.db.prepare('SELECT subject FROM memories ORDER BY id').all()
    assert.deepEqual(rows.map(x => x.subject), ['10086', '20002'])
  } finally { cleanup() }
})

test('distillPending：不注入 llm 时走默认适配器（这里会让它显式失败，而不是静默 0 条）', async () => {
  const { store, cleanup } = mkStore()
  try {
    addEvent(store, { msgId: 'm1', text: '明天下午三点开会', at: NOW - 60 })
    // 没注入 llm、也没 cfg → 默认适配器找不到 reflection_llm.mjs（测试环境 cwd 下没有）
    // 关键断言：它会**抛错**（unavailable 或 runtime），而不是安静地返回 0 条记忆。
    await assert.rejects(
      () => distillPending({ store, now: NOW, cfg: { memory: { stateDir: path.join(TMP_HOME, '无此目录') } } }),
      (err) => {
        assert.ok(['unavailable', 'runtime'].includes(err.kind), `错误没分类：${err.kind}`)
        return true
      },
    )
    // 失败不能推进 watermark（否则这批事件就永远丢了）
    assert.equal(getWatermark(store), 0)
    assert.equal(store.stats().memories.total, 0)
  } finally { cleanup() }
})

test('distillPending：同 key 新版本 → 旧记录 archived(superseded) + superseded_by 链', async () => {
  const { store, cleanup } = mkStore()
  try {
    addEvent(store, { msgId: 'm1', text: '安全底裤还没做', at: NOW - 120 })
    const llm1 = fakeLlm(memoriesJson([
      { type: 'fact', text: '安全底裤（安全措施）还没做', subject: '10086', topic: '安全底裤', confidence: 0.8, src: 1 },
    ]))
    await distillPending({ store, llm: llm1, now: NOW })
    const oldId = store.db.prepare("SELECT id FROM memories WHERE state = 'active'").get().id

    addEvent(store, { msgId: 'm2', text: '安全底裤早就生效了', at: NOW - 60 })
    const llm2 = fakeLlm(memoriesJson([
      { type: 'fact', text: '对方的安全底裤已经生效很久了', subject: '10086', topic: '安全底裤', confidence: 0.9, src: 1 },
    ]))
    const r2 = await distillPending({ store, llm: llm2, now: NOW + 10 })
    assert.equal(r2.created, 1)
    assert.equal(r2.superseded, 1, '同 key 的旧版本必须被归档成 superseded')

    const oldRow = store.getMemory(oldId)
    assert.equal(oldRow.state, 'archived')
    assert.equal(oldRow.archived_reason, 'superseded')
    const newRow = store.db.prepare("SELECT * FROM memories WHERE state = 'active'").get()
    assert.equal(oldRow.superseded_by, newRow.id, 'superseded_by 要指向新版本（形成链）')
    // 检索只看得见新版本
    const active = store.findActiveByKey({ type: 'fact', subject: '10086', key: 'fact:10086:安全底裤' })
    assert.deepEqual(active.map(r => r.id), [newRow.id])
  } finally { cleanup() }
})

test('distillPending：valid_until 过期后 dueExpire 自动归档成 expired（§3.4 时间失效）', async () => {
  const { store, cleanup } = mkStore()
  try {
    addEvent(store, { msgId: 'm1', text: '明天下午三点开会', at: NOW - 60 })
    const soon = fmtLocal(NOW + HOUR).replace(/ (\d{2}):(\d{2})$/, 'T$1:$2:00')
    const llm = fakeLlm(memoriesJson([
      { type: 'commitment', text: '对方约了明天下午三点开会', subject: '10086', topic: '会议', valid_until: soon, src: 1 },
    ]))
    await distillPending({ store, llm, now: NOW })
    assert.equal(store.stats().memories.active, 1)
    const r = store.dueExpire(NOW + 2 * HOUR)
    assert.equal(r.expired, 1)
    const row = store.db.prepare("SELECT state, archived_reason FROM memories").get()
    assert.equal(row.state, 'archived')
    assert.equal(row.archived_reason, 'expired')
  } finally { cleanup() }
})

test('distillPending：prompt 预算不够时只提炼前面几条，剩下的下一轮（不丢）', async () => {
  const { store, cleanup } = mkStore()
  try {
    for (let i = 0; i < 6; i++) addEvent(store, { msgId: `m${i}`, text: `第 ${i} 条消息内容足够长一点`, at: NOW - 100 + i })
    const llm = fakeLlm(memoriesJson([]))
    // maxPromptChars 比 head（规则文本，约 1.4k 字）还小 → 预算被压到下限 500，
    // 只能装一两行；batch=6 一次取完剩下 5 条顺延
    const r = await distillPending({ store, llm, now: NOW, batch: 6, maxPromptChars: 1200, maxLineChars: 300 })
    assert.ok(r.fed >= 1 && r.fed < 6, `应该只喂一部分（fed=${r.fed}）`)
    assert.ok(r.deferred >= 1)
    assert.equal(getWatermark(store), r.watermark)
    const left = distillBacklog({ store })
    assert.ok(left.pending > 0, '剩下的必须在 watermark 之后，下一轮继续')
  } finally { cleanup() }
})

test('distillPending：source_event 追踪（非法 src → null，不瞎指）', async () => {
  const { store, cleanup } = mkStore()
  try {
    const e1 = addEvent(store, { msgId: 'm1', text: '第一句话在这里', at: NOW - 120 })
    const e2 = addEvent(store, { msgId: 'm2', text: '第二句话在这里', at: NOW - 60 })
    const llm = fakeLlm(memoriesJson([
      { type: 'fact', text: '对方说过第一句话', subject: '10086', topic: 'a', src: 1 },
      { type: 'fact', text: '对方说过第二句话', subject: '10086', topic: 'b', src: 2 },
      { type: 'fact', text: '这条 src 越界了', subject: '10086', topic: 'c', src: 99 },
    ]))
    await distillPending({ store, llm, now: NOW })
    const rows = store.db.prepare('SELECT text, source_event FROM memories ORDER BY id').all()
    assert.equal(rows[0].source_event, e1)
    assert.equal(rows[1].source_event, e2)
    assert.equal(rows[2].source_event, null, '越界的 src 不能瞎指一条事件')
  } finally { cleanup() }
})

// ── ⑤ profiles 投影 ────────────────────────────────────────────────────────

test('profiles：提炼完后自动投影（3-5 句 summary + prefs/facts JSON），且不抖（确定性渲染）', async () => {
  const { store, cleanup } = mkStore()
  try {
    addEvent(store, { msgId: 'm1', text: '我在杭州上班，做后端', at: NOW - 300 })
    addEvent(store, { msgId: 'm2', text: '我最喜欢喝冰美式了', at: NOW - 200 })
    const llm = fakeLlm(memoriesJson([
      { type: 'fact', text: '对方在杭州做后端开发', subject: '10086', topic: '职业', confidence: 0.9, salience: 0.8, src: 1 },
      { type: 'fact', text: '对方住在杭州', subject: '10086', topic: '城市', confidence: 0.9, salience: 0.7, src: 1 },
      { type: 'preference', text: '对方喜欢喝冰美式', subject: '10086', topic: '咖啡偏好', confidence: 0.8, salience: 0.6, src: 2 },
    ]))
    const r = await distillPending({ store, llm, now: NOW })
    assert.equal(r.created, 3)
    const p = store.getProfile('10086')
    assert.ok(p, '提炼完应该自动投影 profiles')
    assert.equal(p.subject, '10086')
    assert.match(p.summary, /杭州/, 'summary 必须包含稳定事实')
    const sentences = p.summary.split('。').filter(Boolean)
    assert.ok(sentences.length >= 1 && sentences.length <= 5, `summary 句数不对：${sentences.length}`)
    assert.deepEqual(p.prefs, ['对方喜欢喝冰美式'])
    assert.ok(p.facts.length >= 2)
    assert.ok(p.facts.every(f => f.k && f.v && typeof f.confidence === 'number'))
    assert.ok(p.facts.some(f => f.k === '职业'), 'facts 的 k 用 topic 更可读')

    // 确定性：同一份数据再投影一次，**内容**不变（updated 是时间戳，按设计会变）
    const before = { ...store.getProfile('10086') }
    delete before.updated
    projectProfile({ store, subject: '10086', now: NOW + 100 })
    const after = { ...store.getProfile('10086') }
    delete after.updated
    assert.deepEqual(after, before, '画像投影必须是确定性的（否则用户会觉得它记性一阵一阵的）')
  } finally { cleanup() }
})

test('profiles：没有 fact/preference/relation 时不投影（commitment/episode 不进画像）', async () => {
  const { store, cleanup } = mkStore()
  try {
    addEvent(store, { msgId: 'm1', text: '明天下午三点开会', at: NOW - 60 })
    const llm = fakeLlm(memoriesJson([
      { type: 'commitment', text: '对方约了明天下午三点开会', subject: '10086', topic: '会议', src: 1 },
    ]))
    await distillPending({ store, llm, now: NOW })
    assert.equal(store.getProfile('10086'), null)
    assert.deepEqual(projectProfiles({ store, subjects: ['10086', 'self', 'abc'] }), [], '非 QQ / self 不做画像')
  } finally { cleanup() }
})

// ── ⑥ jobs：失败可见（unavailable vs runtime）+ 退避/死信 ───────────────────

test('distillOnce：没有积压时什么都不做（不入队、不调模型）', async () => {
  const { store, cleanup } = mkStore()
  try {
    let called = 0
    const llm = async () => { called += 1; return memoriesJson([]) }
    const r = await distillOnce({ store, llm, now: NOW })
    assert.equal(r.enqueued?.enqueued, false)
    assert.equal(r.claimed, 0)
    assert.equal(called, 0)
    assert.equal(store.jobStats().byState.pending, 0)
  } finally { cleanup() }
})

test('distillOnce：有积压 → 入队 → 认领 → 成功 → done（watermark 推进）', async () => {
  const { store, cleanup } = mkStore()
  try {
    addEvent(store, { msgId: 'm1', text: '我最喜欢喝冰美式了', at: NOW - 60 })
    const llm = fakeLlm(memoriesJson([{ type: 'preference', text: '对方最喜欢喝冰美式', subject: '10086', topic: '咖啡偏好', src: 1 }]))
    const r = await distillOnce({ store, llm, now: NOW })
    assert.equal(r.enqueued.enqueued, true)
    assert.equal(r.claimed, 1)
    assert.equal(r.results[0].ok, true)
    assert.equal(r.results[0].created, 1)
    assert.equal(store.jobStats().byState.done, 1)
    assert.equal(distillBacklog({ store }).pending, 0)
    const st = distillStatus({ store })
    assert.ok(st.lastSuccessAt > 0)
    assert.equal(st.lastError, null)
  } finally { cleanup() }
})

test('distillOnce：runtime 失败 → 作业失败 + errorKind=runtime + 退避/死信（可见，不静默）', async () => {
  const { store, cleanup } = mkStore()
  try {
    addEvent(store, { msgId: 'm1', text: '我最喜欢喝冰美式了', at: NOW - 60 })
    let attempt = 0
    const llm = async () => { attempt += 1; throw new LlmError('runtime', `模型超时（第 ${attempt} 次）`) }

    // 第 1 次：失败，job 回到 pending 且 next_at 后推 60s
    const r1 = await distillOnce({ store, llm, now: NOW })
    assert.equal(r1.results[0].ok, false)
    assert.equal(r1.results[0].errorKind, 'runtime')
    assert.equal(r1.results[0].jobState, 'pending')
    assert.equal(r1.results[0].attempts, 1)
    const st1 = distillStatus({ store })
    assert.match(String(st1.lastError), /模型超时/)
    assert.equal(st1.lastErrorKind, 'runtime', '设置页要能区分「模型没配」和「这次失败了」')

    // 到点再跑：第 2 次失败 → 退避 120s
    const r2 = await distillOnce({ store, llm, now: NOW + 61 })
    assert.equal(r2.results[0].attempts, 2)
    // 第 3 次 → dead
    const r3 = await distillOnce({ store, llm, now: NOW + 61 + 121 })
    assert.equal(r3.results[0].dead, true)
    assert.equal(r3.results[0].jobState, 'dead')
    assert.equal(store.jobStats().byState.dead, 1)
    // 死信之后不会再入队（ensure 看到没有 pending 会想入队，但积压还在 → 会再入队新 job；
    // 这是预期：死信记录的是「这 3 次失败」，新事件/新作业仍应继续尝试）
    assert.ok(attempt >= 3)
  } finally { cleanup() }
})

test('distillOnce：LLM 不可用（没配模型）→ 跳过且**不累计失败/不死信**，但留痕 + 30 分钟后再试', async () => {
  const { store, cleanup } = mkStore()
  try {
    addEvent(store, { msgId: 'm1', text: '我最喜欢喝冰美式了', at: NOW - 60 })
    let calls = 0
    const llm = async () => { calls += 1; throw new LlmError('unavailable', '模型调用未产出结果（exit=2）：no api key') }

    const r = await distillOnce({ store, llm, now: NOW })
    assert.equal(r.results[0].ok, false)
    assert.equal(r.results[0].skipped, true)
    assert.equal(r.results[0].errorKind, 'unavailable')
    // §3.6：前者（没配模型）「跳过且不算失败」→ 不进死信、attempts 不累计
    assert.equal(store.jobStats().byState.dead, 0)
    assert.equal(store.jobStats().byState.done, 1, '作业以 done 收尾（不算失败），但状态里留着 last_unavailable')

    const st = distillStatus({ store })
    assert.equal(st.lastErrorKind, 'unavailable')
    assert.match(String(st.lastError), /no api key/)
    assert.ok(st.lastUnavailable && st.lastUnavailable.reason, 'last_unavailable 必须留痕（设置页要能显示）')
    assert.ok(st.retryAfterAt > NOW, '要设置重试时间窗口（否则每分钟烧一次日志）')

    // 重试窗口内不再入队
    const e = ensureDistillJob({ store, now: NOW + 60 })
    assert.equal(e.enqueued, false)
    assert.match(e.reason, /LLM 不可用/)

    // 窗口过了还能再试（不是永久放弃）
    const e2 = ensureDistillJob({ store, now: st.retryAfterAt + 1 })
    assert.equal(e2.enqueued, true)
    assert.equal(calls, 1, '窗口内不该再调模型')
  } finally { cleanup() }
})

test('distillOnce：模型输出不是 JSON → 也算 runtime 失败（失败必须可见，不许静默吞）', async () => {
  const { store, cleanup } = mkStore()
  try {
    addEvent(store, { msgId: 'm1', text: '我最喜欢喝冰美式了', at: NOW - 60 })
    const llm = async () => '这是一段散文，不是 JSON'
    const r = await distillOnce({ store, llm, now: NOW })
    assert.equal(r.results[0].ok, false)
    assert.equal(r.results[0].errorKind, 'runtime')
    assert.match(String(r.results[0].error), /不是 JSON/)
    assert.equal(distillStatus({ store }).lastErrorKind, 'runtime')
  } finally { cleanup() }
})

test('errorKindOf：只把「没配/找不到」归 unavailable，其它一律 runtime（可重试）', () => {
  assert.equal(errorKindOf(new LlmError('unavailable', 'x')), 'unavailable')
  assert.equal(errorKindOf(new LlmError('runtime', 'x')), 'runtime')
  assert.equal(errorKindOf(new Error('找不到配置文件')), 'unavailable')
  assert.equal(errorKindOf(new Error('模型超时')), 'runtime')
  assert.equal(errorKindOf(new Error('spawn ENOENT')), 'runtime')
  assert.equal(errorKindOf(null), 'runtime')
})

test('ensureDistillJob：已有 pending/running 的 distill 作业时不重复入队', async () => {
  const { store, cleanup } = mkStore()
  try {
    addEvent(store, { msgId: 'm1', text: '我最喜欢喝冰美式了', at: NOW - 60 })
    const a = ensureDistillJob({ store, now: NOW })
    assert.equal(a.enqueued, true)
    const b = ensureDistillJob({ store, now: NOW + 1 })
    assert.equal(b.enqueued, false)
    assert.match(b.reason, /已有/)
    assert.equal(store.jobStats().byState.pending, 1)
  } finally { cleanup() }
})

test('ingestMemories：可以直接对解析结果调用（供 Step 3 迁移复用）', () => {
  const { store, cleanup } = mkStore()
  try {
    const r = ingestMemories({
      store,
      items: [{ type: 'fact', text: '对方在杭州上班', subject: '10086', conv: 'c2c:10086', key: 'fact:10086:城市', confidence: 0.8, salience: 0.6, validUntil: null, sourceLine: null }],
      now: NOW,
    })
    assert.equal(r.created, 1)
    assert.deepEqual(r.subjects, ['10086'])
    assert.equal(store.stats().memories.active, 1)
  } finally { cleanup() }
})

// ── ⑦ 默认 LLM 适配器（真起子进程，用假脚本验证退出码映射）──────────────────

const FAKE_SCRIPT = path.join(TMP_HOME, 'fake-reflection-llm.mjs')
function writeFakeLlm (body) {
  fs.writeFileSync(FAKE_SCRIPT, body, 'utf8')
  return FAKE_SCRIPT
}

test('createAcpLlm：成功路径 —— 起子进程、传 prompt 文件、从 out.json 读回文本', async () => {
  const script = writeFakeLlm(`
import fs from 'node:fs'
const a = process.argv.slice(2)
const get = n => a[a.indexOf('--' + n) + 1]
const prompt = fs.readFileSync(get('prompt-file'), 'utf8')
fs.writeFileSync(get('out-file'), JSON.stringify({ ok: true, text: '看到 prompt 长度 ' + prompt.length, reason: 'end_turn' }))
process.exit(0)
`)
  const llm = createAcpLlm({ scriptPath: script, nodeBin: process.execPath, env: { ...process.env }, timeoutMs: 5000 })
  const promptText = '请提炼这段对话'
  const out = await llm(promptText)
  assert.match(out, new RegExp(`看到 prompt 长度 ${promptText.length}`))
})

test('createAcpLlm：exit 2 / 没有结果文件 → unavailable（没配模型，不该重试烧钱）', async () => {
  const script = writeFakeLlm(`
process.stderr.write('reflection_llm: 找不到桥配置：设 LLMINQQ_CONFIG\\n')
process.exit(2)
`)
  const llm = createAcpLlm({ scriptPath: script, nodeBin: process.execPath, env: { ...process.env }, timeoutMs: 5000 })
  await assert.rejects(() => llm('x'), (err) => {
    assert.equal(err.kind, 'unavailable')
    assert.match(err.message, /exit=2/)
    return true
  })
})

test('createAcpLlm：out.json 说 ok:false 且 exit 2 → unavailable；exit 3 → runtime', async () => {
  const makeScript = (code, payload) => writeFakeLlm(`
import fs from 'node:fs'
const a = process.argv.slice(2)
const get = n => a[a.indexOf('--' + n) + 1]
fs.writeFileSync(get('out-file'), JSON.stringify(${JSON.stringify(payload)}))
process.exit(${code})
`)
  const s2 = makeScript(2, { ok: false, error: 'dsh 段缺少 provider' })
  const llm2 = createAcpLlm({ scriptPath: s2, nodeBin: process.execPath, env: { ...process.env }, timeoutMs: 5000 })
  await assert.rejects(() => llm2('x'), (err) => {
    assert.equal(err.kind, 'unavailable')
    assert.match(err.message, /缺少 provider/)
    return true
  })

  const s3 = makeScript(3, { ok: false, error: '模型调用超时' })
  const llm3 = createAcpLlm({ scriptPath: s3, nodeBin: process.execPath, env: { ...process.env }, timeoutMs: 5000 })
  await assert.rejects(() => llm3('x'), (err) => {
    assert.equal(err.kind, 'runtime')
    assert.match(err.message, /超时/)
    return true
  })
})

test('createAcpLlm：硬超时 → runtime（子进程卡死时 worker 不能永远挂着）', async () => {
  const script = writeFakeLlm(`
setTimeout(() => {}, 60000)   // 永远不退出
`)
  const llm = createAcpLlm({
    scriptPath: script, nodeBin: process.execPath, env: { ...process.env },
    timeoutMs: 300, hardTimeoutMs: 400,
  })
  const t0 = Date.now()
  await assert.rejects(() => llm('x'), (err) => {
    assert.equal(err.kind, 'runtime')
    return true
  })
  assert.ok(Date.now() - t0 < 10000, `超时后没有及时返回（${Date.now() - t0}ms）`)
})

test('createAcpLlm：脚本不存在 → unavailable（包不完整的报错要能看懂）', async () => {
  const llm = createAcpLlm({ scriptPath: path.join(TMP_HOME, '不存在的脚本.mjs'), env: { ...process.env } })
  await assert.rejects(() => llm('x'), (err) => {
    assert.equal(err.kind, 'unavailable')
    assert.match(err.message, /找不到 reflection_llm/)
    return true
  })
})
