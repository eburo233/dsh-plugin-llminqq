// test/memory-v5-bridge-write.test.mjs —— 记忆 v5 Step 1：桥侧双写 events（task-15）
//
// 背景（docs/MEMORY-AUDIT-AND-V5.md §3.5 / §4 Step 1）：
//   v4 的写入链是「桥 → 文本日志 → 正则解析 → 入库」，因此必然被截断（P1-1）、
//   被排版前缀污染（P0-5）、被字节游标丢数据（P0-6）。v5 让桥进程**直接 INSERT
//   events**（全文、msg_id 幂等），旧读路径完全不动 —— 这就是「零风险双写」。
//
// 这一层要守住四条硬要求：
//   ① 全文不截断（events.text 就是原文，不是日志里那 80 字）；
//   ② 幂等：同一个 (conv, msg_id) 重放只留一行（合并轮/补发/重复启动都靠它）；
//   ③ 旁路隔离：写库失败**不许影响收发**，首次失败只告警一次并降级关闭；
//   ④ 默认开、关着时零开销（不 import store、不建库、不写盘）。
//
// 测试手法：照 unit-log-runaway / unit-inbound 的老办法，从 lib/bridge/index.js
// 源码里抠出 v5 那几个**纯函数**，用 new Function 注入 stub 执行；store 用真实的
// lib/agent/memory-v5/store.mjs + 临时目录（node:sqlite 同步、很快）。发送路径
// （sendTextTo/noteSelfSent）也抠出来跑，专门验证「v5 挂了消息照发」。

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { openV5 } from '../lib/agent/memory-v5/store.mjs'
import * as search from '../lib/agent/memory-v5/search.mjs'
import { chunkText, textToSegments } from '../lib/bridge/common.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SRC = fs.readFileSync(path.join(ROOT, 'lib', 'bridge', 'index.js'), 'utf8')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'llminqq-v5-bridge-'))
after(() => fs.rmSync(TMP, { recursive: true, force: true }))

let seq = 0
/** 每次要一条干净库：临时目录 + 真 store。 */
function freshStore () {
  const dir = path.join(TMP, `db${seq++}`)
  fs.mkdirSync(dir, { recursive: true })
  const dbPath = path.join(dir, 'mem-v5.db')
  return { dir, dbPath, store: openV5({ dbPath }) }
}
function rows (store) {
  return store.db.prepare('SELECT * FROM events ORDER BY id').all()
}

/** 按花括号配平抠出一个顶层函数（支持 `async function`）——和 unit-log-runaway 同一套。
 *
 * ⚠️ 必须先跳过参数表：v5RecordInbound(evt, { flat, peer }) 的参数里有解构花括号，
 *    直接从函数名后找第一个 `{` 会抠到参数上（这个测试踩过）。
 */
function fnSource (name) {
  const i = SRC.search(new RegExp(`(?:async\\s+)?function ${name}\\s*\\(`))
  assert.ok(i > 0, `定位不到 ${name}`)
  // 1) 配平参数表，找到参数结束的 ')'
  let paren = 0
  let k = SRC.indexOf('(', i)
  assert.ok(k > 0, `${name} 没有参数表`)
  for (; k < SRC.length; k++) {
    if (SRC[k] === '(') paren++
    else if (SRC[k] === ')') { paren--; if (paren === 0) break }
  }
  // 2) 从参数表之后的第一个 '{' 开始配平函数体
  const start = SRC.indexOf('{', k)
  assert.ok(start > 0, `${name} 没有函数体`)
  let depth = 0
  for (let j = start; j < SRC.length; j++) {
    if (SRC[j] === '{') depth++
    else if (SRC[j] === '}') { depth--; if (depth === 0) return SRC.slice(i, j + 1) }
  }
  assert.fail(`${name} 函数体没闭合`)
}

const V5_FNS = [
  'v5Cfg', 'v5Enabled', 'v5Disable', 'v5DbFile', 'v5AppendEvent',
  'v5InboundText', 'v5KindRaw', 'v5InboundMeta', 'v5RecordInbound', 'v5RecordOutbound',
]

/**
 * 把 v5 的纯函数抠出来执行。v5OpenStore 由测试注入（可返回真 store / 抛错），
 * 这样既测了「组装 event」的逻辑，也测了「打不开库时怎么降级」。
 */
function makeWriter ({ config = {}, store = null, openImpl = null, memoryDir = TMP } = {}) {
  const logs = []
  const logger = { log: m => logs.push(String(m)), debug: () => {}, warn: () => {}, error: () => {} }
  const opens = { count: 0 }
  const v5OpenStore = openImpl ?? (async () => { opens.count++; return store })
  const peerKeyOf = peer => `${peer.scope}:${peer.id}`
  const code = `
    const V5_DB_FILE = 'mem-v5.db'
    let v5Disabled = false
    let v5StorePromise = null
    let v5WriteSeq = 0
    ${V5_FNS.map(fnSource).join('\n\n')}
    return { v5Cfg, v5Enabled, v5Disable, v5DbFile, v5AppendEvent, v5InboundText, v5KindRaw, v5InboundMeta, v5RecordInbound, v5RecordOutbound }
  `
  const factory = new Function(
    'config', 'logger', 'path', 'MEMORY_PATHS', 'v5OpenStore', 'peerKeyOf', 'process', code,
  )
  const api = factory(config, logger, path, { dir: memoryDir }, v5OpenStore, peerKeyOf, process)
  return { ...api, logs, opens }
}

const peerC2C = { scope: 'c2c', id: '10001' }
const peerGroup = { scope: 'group', id: '20001' }
const evtOf = (msgId, extra = {}) => ({
  post_type: 'message', message_id: msgId, time: 1700000000,
  user_id: 30001, message_type: 'group', group_id: 20001, ...extra,
})

// ── ① 开关：默认开、可关、关着零开销 ───────────────────────────────────────
test('默认开：老 bridge-config 没有 memory.v5 段也双写（Step 1 的预期行为）', () => {
  const w = makeWriter()
  assert.equal(w.v5Enabled(), true)
})

test('config.memory.v5.enabled=false → 关，且不 import store / 不建库', async () => {
  // 注意：这里不能用 freshStore()（它会真的 openV5 → 建库），拿纯路径即可
  const dbPath = path.join(TMP, 'disabled-should-not-exist', 'mem-v5.db')
  const w = makeWriter({ config: { memory: { v5: { enabled: false, dbPath } } } })
  const ok = await w.v5RecordInbound(evtOf(1), {
    flat: { text: '你好' }, peer: peerGroup, peerKey: 'group:20001', senderQq: '30001',
  })
  assert.equal(ok, false)
  assert.equal(w.opens.count, 0, '关着时不该打开/import store（零开销）')
  assert.equal(fs.existsSync(dbPath), false, '关着时不该建库')
})

test('环境变量 LLMINQQ_MEMORY_V5=0 → 也能关（bridge-config 自动生成时的手动闸）', () => {
  const old = process.env.LLMINQQ_MEMORY_V5
  process.env.LLMINQQ_MEMORY_V5 = '0'
  try {
    assert.equal(makeWriter().v5Enabled(), false)
  } finally {
    if (old === undefined) delete process.env.LLMINQQ_MEMORY_V5
    else process.env.LLMINQQ_MEMORY_V5 = old
  }
})

test('路径：默认 <memory.dir>/mem-v5.db；可用 memory.v5.dbPath 覆盖（测试/排障）', () => {
  // 生产里 MEMORY_PATHS.dir = config.memory.dir = memoryStateDir(cfg)
  // （见本文件末尾那条源码断言），所以两者必须一致。
  const a = makeWriter({ config: { memory: { dir: '/state/mem' } }, memoryDir: '/state/mem' })
  assert.equal(a.v5DbFile(), path.join('/state/mem', 'mem-v5.db'))
  const b = makeWriter({ config: { memory: { v5: { dbPath: path.join(TMP, 'x.db') } } } })
  assert.equal(b.v5DbFile(), path.join(TMP, 'x.db'))
})

// ── ② 入站：字段映射 / 全文 / 幂等 ─────────────────────────────────────────
test('入站事件字段映射：conv/msg_id/speaker/at/kind_raw/meta', async () => {
  const { store, dbPath } = freshStore()
  const w = makeWriter({ config: { memory: { v5: { dbPath } } }, store })
  const flat = {
    text: '明天下午三点开会，别忘了带电脑',
    images: [],
    cards: [],
    files: [],
    onlineFiles: [],
    voices: [],
    placeholders: [],
    segTypes: ['text'],
  }
  const ok = await w.v5RecordInbound(evtOf('msg-1'), {
    flat, peer: peerGroup, peerKey: 'group:20001', senderQq: '30001',
  })
  assert.equal(ok, true)
  const [row] = rows(store)
  assert.equal(row.conv, 'group:20001')
  assert.equal(row.msg_id, 'msg-1')
  assert.equal(row.speaker, '30001', 'speaker 必须是发送者 QQ，不是 peerKey')
  assert.equal(row.text, flat.text, 'text 必须是全文')
  assert.equal(row.at, 1700000000, 'at 应该用 OneBot 事件时间（秒）')
  assert.equal(row.kind_raw, 'text')
})

test('全文不截断：5000 字（含换行）进 events 一字不少（v4 的 P1-1 回归）', async () => {
  const { store, dbPath } = freshStore()
  const w = makeWriter({ config: { memory: { v5: { dbPath } } }, store })
  const long = Array.from({ length: 300 }, (_, i) => `第 ${i} 行：这是一段很长的记忆原文，用来验证 events 不做 80 字截断`).join('\n')
  assert.ok(long.length > 2000)
  await w.v5RecordInbound(evtOf('msg-long'), {
    flat: { text: long }, peer: peerC2C, peerKey: 'c2c:10001', senderQq: '10001',
  })
  const [row] = rows(store)
  assert.equal(row.text, long)
  assert.equal(row.text.length, long.length)
  assert.notEqual(row.text.length, 80, '别又截成 80 字（v4 的 bug）')
})

test('重复 msg_id 只写一条（重放/合并轮/重启都靠它幂等）', async () => {
  const { store, dbPath } = freshStore()
  const w = makeWriter({ config: { memory: { v5: { dbPath } } }, store })
  const args = { flat: { text: '同一句话' }, peer: peerC2C, peerKey: 'c2c:10001', senderQq: '10001' }
  assert.equal(await w.v5RecordInbound(evtOf('dup-1'), args), true)
  assert.equal(await w.v5RecordInbound(evtOf('dup-1'), args), true)
  assert.equal(rows(store).length, 1, '同一 (conv,msg_id) 必须只留一行')
})

test('合并轮：合成事件（msg_id=merged-<ts>）各写一条，且不互相幂等掉', async () => {
  const { store, dbPath } = freshStore()
  const w = makeWriter({ config: { memory: { v5: { dbPath } } }, store })
  await w.v5RecordInbound(evtOf('merged-1700000000000', { _mergedExtras: { count: 2 } }), {
    flat: { text: '第一条 + 第二条' }, peer: peerC2C, peerKey: 'c2c:10001', senderQq: '10001',
  })
  await w.v5RecordInbound(evtOf('merged-1700000000001'), {
    flat: { text: '第三条' }, peer: peerC2C, peerKey: 'c2c:10001', senderQq: '10001',
  })
  const all = rows(store)
  assert.equal(all.length, 2)
  // 合并轮事件要打 meta.merged —— Step 2 提炼据此跳过（否则同一句话会被提炼两遍）
  const mergedMeta = JSON.parse(all[0].meta)
  assert.equal(mergedMeta.merged, true)
  assert.equal(mergedMeta.mergedCount, 2)
  assert.equal(JSON.parse(all[1].meta), null, '普通事件不该有多余 meta')
})

test('纯图片消息：text 补「[图片]」占位，kind_raw=image，meta 只存文件名', async () => {
  const { store, dbPath } = freshStore()
  const w = makeWriter({ config: { memory: { v5: { dbPath } } }, store })
  const imgPath = path.join(TMP, 'staging', '123_abc.jpg')
  await w.v5RecordInbound(evtOf('img-1'), {
    flat: { text: '', images: [{ url: 'https://example.com/a.jpg' }], segTypes: ['image'] },
    peer: peerGroup, peerKey: 'group:20001', senderQq: '30001', imagePaths: [imgPath],
  })
  const [row] = rows(store)
  assert.equal(row.text, '[图片]')
  assert.equal(row.kind_raw, 'image')
  const meta = JSON.parse(row.meta)
  assert.deepEqual(meta.images, ['123_abc.jpg'], 'meta 里不要存绝对路径（换机器就废/泄露本机布局）')
  assert.equal(meta.imageCount, 1)
})

test('语音转写成功时，转写文本进 meta（否则这条语音在 events 里只剩 [语音]）', async () => {
  const { store, dbPath } = freshStore()
  const w = makeWriter({ config: { memory: { v5: { dbPath } } }, store })
  await w.v5RecordInbound(evtOf('voice-1'), {
    flat: { text: '[语音] 5s', voices: [{ duration: 5, file_size: 100 }], segTypes: ['voice'] },
    peer: peerC2C, peerKey: 'c2c:10001', senderQq: '10001',
    voiceTranscripts: [
      { ok: true, text: '明天下午三点开会' },
      { ok: false, reason: '超时', text: '' },
    ],
  })
  const meta = JSON.parse(rows(store)[0].meta)
  assert.deepEqual(meta.transcripts, ['明天下午三点开会'], '只收成功的转写')
})

test('卡片/文件/语音的元信息都进 meta（Step 2 提炼要知道消息长什么样）', async () => {
  const { store, dbPath } = freshStore()
  const w = makeWriter({ config: { memory: { v5: { dbPath } } }, store })
  await w.v5RecordInbound(evtOf('card-1'), {
    flat: {
      text: '[卡片] B站视频：安全底裤',
      cards: ['[卡片] B站视频：安全底裤'],
      files: [{ file_name: 'a.pdf', file_size: 12 }],
      voices: [{ duration: 5, file_size: 100 }],
      segTypes: ['json', 'file', 'voice'],
    },
    peer: peerGroup, peerKey: 'group:20001', senderQq: '30001',
  })
  const [row] = rows(store)
  assert.equal(row.kind_raw, 'voice')
  const meta = JSON.parse(row.meta)
  assert.deepEqual(meta.cards, ['[卡片] B站视频：安全底裤'])
  assert.deepEqual(meta.files, [{ name: 'a.pdf', size: 12 }])
  assert.deepEqual(meta.voices, [{ duration: 5, size: 100 }])
})

// ── ③ 出站：真正发出后才写，speaker=self ───────────────────────────────────
test('出站事件：speaker=self、msg_id 带 self: 前缀、text=实际发出的正文', async () => {
  const { store, dbPath } = freshStore()
  const w = makeWriter({ config: { memory: { v5: { dbPath } } }, store })
  await w.v5RecordOutbound(peerC2C, { text: '我在呢，怎么啦', msgId: '777' })
  const [row] = rows(store)
  assert.equal(row.conv, 'c2c:10001')
  assert.equal(row.speaker, 'self')
  assert.equal(row.msg_id, 'self:777')
  assert.equal(row.text, '我在呢，怎么啦')
  assert.equal(row.kind_raw, 'text')
})

test('出站语音/图片也各记一条，meta 标注', async () => {
  const { store, dbPath } = freshStore()
  const w = makeWriter({ config: { memory: { v5: { dbPath } } }, store })
  await w.v5RecordOutbound(peerGroup, { text: '晚安', kindRaw: 'voice', meta: { character: '小新' } })
  await w.v5RecordOutbound(peerGroup, { text: '[图片] a.png', kindRaw: 'image', meta: { file: 'a.png' } })
  const all = rows(store)
  assert.equal(all.length, 2)
  assert.equal(all[0].kind_raw, 'voice')
  assert.deepEqual(JSON.parse(all[0].meta), { character: '小新' })
  assert.equal(all[1].kind_raw, 'image')
})

test('空正文不写出站事件（避免噪音行）', async () => {
  const { store, dbPath } = freshStore()
  const w = makeWriter({ config: { memory: { v5: { dbPath } } }, store })
  assert.equal(await w.v5RecordOutbound(peerC2C, { text: '   ' }), false)
  assert.equal(await w.v5RecordOutbound(peerC2C, { text: '' }), false)
  assert.equal(rows(store).length, 0)
})

// ── ④ 失败隔离：写库失败只告警一次 + 降级，不影响发送 ─────────────────────
test('打不开 v5 库：只告警一次并降级关闭，之后不再重试', async () => {
  const w = makeWriter({ config: { memory: { v5: { enabled: true } } }, openImpl: async () => { throw new Error('disk full') } })
  assert.equal(await w.v5RecordOutbound(peerC2C, { text: '你好' }), false)
  assert.equal(await w.v5RecordOutbound(peerC2C, { text: '又一条' }), false)
  assert.equal(await w.v5RecordInbound(evtOf(1), { flat: { text: 'hi' }, peer: peerC2C }), false)
  const warns = w.logs.filter(l => /memory-v5: 已降级关闭/.test(l))
  assert.equal(warns.length, 1, `只该告警一次：${JSON.stringify(w.logs)}`)
})

test('appendEvent 抛错（锁冲突等）：同样降级，不往外抛', async () => {
  const badStore = { appendEvent () { throw new Error('database is locked') } }
  const w = makeWriter({ config: { memory: { v5: { enabled: true } } }, store: badStore })
  const ok = await w.v5RecordOutbound(peerC2C, { text: '你好' })
  assert.equal(ok, false)
  assert.ok(w.logs.some(l => /database is locked/.test(l)))
})

// ── ⑤ 写库失败不影响发送（sendTextTo / noteSelfSent 真跑一遍）─────────────
function makeSendSandbox ({ v5RecordOutbound }) {
  const logs = []
  const gateway = { calls: [], async callData (action, params) { this.calls.push({ action, params }); return { message_id: 42 } } }
  const config = { policy: { maxReplyChars: 1500, replyChunkDelayMs: 0 } }
  const selfMessageIds = new Set()
  const sentNotes = []
  const code = `
    ${fnSource('tidyLineBreaks')}
    ${fnSource('noteSelfSent')}
    ${fnSource('sendTextTo')}
    return { sendTextTo, noteSelfSent }
  `
  const factory = new Function(
    'config', 'logger', 'gateway', 'sleep', 'selfMessageIds', 'noteSentMessage',
    'segToPlainText', 'textToSegments', 'chunkText', 'v5RecordOutbound', 'path', code,
  )
  const api = factory(
    config,
    { log: m => logs.push(String(m)), debug: () => {}, warn: () => {} },
    gateway,
    async () => {},
    selfMessageIds,
    (peer, res, kind) => sentNotes.push({ peer, res, kind }),
    segs => segs.filter(s => s.type === 'text').map(s => String(s.data?.text ?? '')).join('').trim(),
    textToSegments,
    chunkText,
    v5RecordOutbound,
    path,
  )
  return { ...api, gateway, selfMessageIds, logs, sentNotes }
}

test('写库失败不影响发送：v5 抛错（async reject）时消息照发、noteSelfSent 照记', async () => {
  const box = makeSendSandbox({ v5RecordOutbound: () => Promise.reject(new Error('db down')) })
  await box.sendTextTo({ scope: 'c2c', id: '10001' }, '你好呀')
  assert.equal(box.gateway.calls.length, 1)
  assert.equal(box.gateway.calls[0].action, 'send_private_msg')
  assert.ok(box.selfMessageIds.has('42'), '发送成功后仍要记账（撤回功能依赖它）')
  assert.equal(box.sentNotes.length, 1)
})

test('写库失败不影响发送：v5 抛错（同步 throw）也不会冒泡到发送路径', async () => {
  const box = makeSendSandbox({ v5RecordOutbound: () => { throw new Error('sync boom') } })
  await box.sendTextTo({ scope: 'c2c', id: '10001' }, '你好呀')
  assert.equal(box.gateway.calls.length, 1)
})

test('发送成功时把「实际发出的纯文本」交给 v5（不是带 [AT:] 的原文）', async () => {
  const seen = []
  const box = makeSendSandbox({ v5RecordOutbound: (peer, info) => { seen.push({ peer, info }); return Promise.resolve(true) } })
  await box.sendTextTo({ scope: 'group', id: '20001' }, '[AT:123] 你好')
  assert.equal(box.gateway.calls.length, 1)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].peer.scope, 'group')
  assert.ok(!String(seen[0].info.text).includes('[AT:'), `不该把控制标记写进 events：${seen[0].info.text}`)
})

// ── ⑥ 源码接线：位置 / 无读路径改动 / 无 mem.db ────────────────────────────
test('入站 hook 位置：`入站` 日志之后、空消息判定之前（和 bridge.out 1:1 对齐）', () => {
  const iLog = SRC.indexOf('logger.log(`入站 ${peerKey}')
  const iV5 = SRC.indexOf('await v5RecordInbound(evt')
  const iEmpty = SRC.indexOf('if (!flat.text && imagePaths.length === 0 && !hasForward && !hasCard)')
  assert.ok(iLog > 0 && iV5 > iLog && iEmpty > iV5,
    `hook 位置不对：log=${iLog} v5=${iV5} empty=${iEmpty}`)
  assert.match(SRC, /v5RecordInbound\(evt, \{ flat, peer, peerKey, senderQq, imagePaths, voiceTranscripts \}\)/)
})

test('出站 hook 在三个发送路径里（text 经 noteSelfSent、图片、语音）', () => {
  assert.match(SRC, /noteSelfSent\(peer, res, 'text', \{ text: segToPlainText\(segments\)/, '文本发送没接 v5')
  assert.match(SRC, /noteSelfSent\(peer, res, 'image', \{/, '图片发送没接 v5')
  // 语音只有在真的发成语音时才记（失败降级成文字由 sendTextTo 记）
  assert.match(SRC, /const okVoice = await sendVoiceTo\(peer, v\.text, v\.character\)/, '语音调用点没拿返回值')
  assert.match(SRC, /if \(okVoice\) \{/, '语音成功判断缺失（会在 TTS 失败时误记语音事件）')
})

test('不碰读路径：v5 层没有读 mem.db，旧注入链路一字未改', () => {
  const start = SRC.indexOf('// ── 记忆 v5：桥侧直接写 events')
  const end = SRC.indexOf('构造一次 memory CLI 调用')
  assert.ok(start > 0 && end > start)
  const block = SRC.slice(start, end)
  assert.doesNotMatch(block, /mem\.db/, 'v5 层不该碰 v4 的 mem.db')
  // 路径等价性：桥的 MEMORY_PATHS.dir 就是插件侧传进来的 memoryStateDir(cfg)
  // （bridgeConfig 的 memory.dir = memoryPaths(cfg).dir = memoryStateDir(cfg)），
  // 所以 `<memoryStateDir>/mem-v5.db` 不需要再 import dirs.mjs 去算一遍。
  assert.match(SRC, /const dir = config\.memory\?\.dir \?\? path\.join\(config\.dsh\.stateDir \?\? config\.dsh\.cwd, 'memory'\)/,
    'MEMORY_PATHS.dir 的推导变了 —— v5 库路径依赖它等于 memoryStateDir')
  assert.match(block, /path\.join\(MEMORY_PATHS\.dir, V5_DB_FILE\)/, 'v5 库没按 <memory.dir>/mem-v5.db 落盘')
  assert.match(block, /import\('\.\.\/agent\/memory-v5\/store\.mjs'\)/)
  assert.match(block, /openV5\(\{/)
  // 仍读旧库的注入函数保持原样（只断言存在，不改它们）
  assert.match(SRC, /MEMORY_PATHS\.db/)
})

// ── ⑦ 只读验收脚本：events vs bridge.out 行数 + 偏差说明 ─────────────────
test('memory-v5-count.mjs：events 条数与 bridge.out 行数对比（只读、JSON 输出）', () => {
  const { store, dbPath } = freshStore()
  const at = 1700000000
  store.appendEvent({ conv: 'c2c:10001', msgId: '1', speaker: '10001', text: '在吗', at, kindRaw: 'text' })
  store.appendEvent({ conv: 'c2c:10001', msgId: '2', speaker: '10001', text: '问你个事', at: at + 1, kindRaw: 'text' })
  store.appendEvent({ conv: 'group:20001', msgId: '3', speaker: '30001', text: '开会', at: at + 2, kindRaw: 'text' })
  store.appendEvent({ conv: 'c2c:10001', msgId: 'self:11', speaker: 'self', text: '在呢', at: at + 3, kindRaw: 'text' })
  store.appendEvent({ conv: 'c2c:10001', msgId: 'self:12', speaker: 'self', text: '你说', at: at + 4, kindRaw: 'text' })
  store.close()

  const logFile = path.join(TMP, 'bridge.out')
  fs.writeFileSync(logFile, [
    '2026-11-03T00:00:00.000Z 入站 c2c:10001 from=某人(10001) text="在吗" images=0 cards=0 nontext=0 files=0 segs=text',
    '2026-11-03T00:00:01.000Z 入站 c2c:10001 from=某人(10001) text="问你个事" images=0 cards=0 nontext=0 files=0 segs=text',
    '2026-11-03T00:00:02.000Z 入站 group:20001 from=某人(30001) text="开会" images=0 cards=0 nontext=0 files=0 segs=text',
    '2026-11-03T00:00:03.000Z 出站 c2c:10001 text="在呢" chars=2',
    '2026-11-03T00:00:04.000Z 出站 c2c:10001 text="你说" chars=2',
    '2026-11-03T00:00:05.000Z 本轮完成 c2c:10001 1s 回复长度=2',
    '',
  ].join('\n'))

  const script = path.join(ROOT, 'scripts', 'memory-v5-count.mjs')
  const r = spawnSync(process.execPath, [script, '--db', dbPath, '--log', logFile, '--json'], {
    encoding: 'utf8', timeout: 30000,
  })
  assert.equal(r.status, 0, `脚本退出码 ${r.status}：${r.stderr}`)
  const report = JSON.parse(r.stdout)
  assert.equal(report.events.total, 5)
  assert.equal(report.events.self, 2)
  assert.equal(report.events.other, 3)
  assert.equal(report.bridgeLog.inbound.total, 3)
  assert.equal(report.bridgeLog.outbound.total, 2)
  assert.equal(report.deviation.inbound.diff, 0)
  assert.equal(report.deviation.outbound.diff, 0)
  // 只读：库文件跑前跑后内容不变（readOnly 打开，不会写 WAL/改行）
  const before = fs.readFileSync(dbPath)
  const r2 = spawnSync(process.execPath, [script, '--db', dbPath, '--json'], { encoding: 'utf8', timeout: 30000 })
  assert.equal(r2.status, 0)
  assert.ok(before.equals(fs.readFileSync(dbPath)), '脚本不该改库文件')
})

test('memory-v5-count.mjs：拒绝直接打开生产路径（先 cp 到 /tmp 再跑）', () => {
  const script = path.join(ROOT, 'scripts', 'memory-v5-count.mjs')
  const fakeProd = path.join(os.homedir(), '.dsh', 'dsh-plugin-llminqq', 'agent', 'memory', 'mem-v5.db')
  const r = spawnSync(process.execPath, [script, '--db', fakeProd], { encoding: 'utf8', timeout: 30000 })
  assert.equal(r.status, 3, `生产路径该被拒绝，实际 ${r.status}: ${r.stdout}${r.stderr}`)
  assert.match(r.stderr, /拒绝直接打开生产路径/)
})

// ── 出站同时记「我说过什么」（utterances，2026-11-07 线上实测漏写）───────────
//
// 现场：44 小时里桥发了 747 条消息，utterances 表**一条没涨**（停在迁移的 442 条，
// 最后一条 11-05 16:43）。而 v5 的防复读块 utteranceBlock **优先读 utterances**，
// 只有它为空才回退查 events —— 442 条旧数据让它永远不为空，
// 于是「我说过什么」注入的永远是**切换前的旧话**。
//
// 这条用例锁两件事：① 文本出站要写 utterances；② 非文本（图片/语音占位）不写，
// 免得 `[图片] a.png` 这种污染防复读素材。
test('出站文本要写 utterances（否则防复读永远用迁移前的旧话）', async () => {
  const s = freshStore()
  try {
    const w = makeWriter({ store: s.store })
    await w.v5RecordOutbound(peerC2C, { text: '我在呢，怎么啦', msgId: '9001' })
    const utt = s.store.db.prepare('SELECT conv, text, kind FROM utterances ORDER BY id').all()
    assert.equal(utt.length, 1, '出站文本必须进 utterances 表')
    assert.equal(utt[0].conv, 'c2c:10001')
    assert.equal(utt[0].text, '我在呢，怎么啦')
    assert.equal(utt[0].kind, 'text')
    // events 仍要写（两条路互不影响）
    assert.equal(rows(s.store).length, 1, 'events 也要照写')
  } finally { s.store.close() }
})

test('出站非文本（图片/语音）只写 events，不污染 utterances', async () => {
  const s = freshStore()
  try {
    const w = makeWriter({ store: s.store })
    await w.v5RecordOutbound(peerC2C, { text: '[图片] a.png', kindRaw: 'image' })
    await w.v5RecordOutbound(peerC2C, { text: '晚安', kindRaw: 'voice' })
    assert.equal(rows(s.store).length, 2, 'events 两条都要写')
    assert.equal(s.store.db.prepare('SELECT count(*) AS n FROM utterances').get().n, 0,
      '图片/语音不该进 utterances（「我说过什么」只要语义素材）')
  } finally { s.store.close() }
})

test('utterances 写失败不影响出站（旁路功能必须吞错）', async () => {
  const s = freshStore()
  try {
    // 让 appendUtterance 抛错，但 appendEvent 正常
    const broken = Object.create(s.store)
    broken.appendUtterance = () => { throw new Error('disk full') }
    const w = makeWriter({ store: broken })
    const ok = await w.v5RecordOutbound(peerC2C, { text: '照常说话', msgId: '9002' })
    assert.equal(ok, true, 'utterance 失败不能让整条出站记录失败')
    assert.equal(rows(s.store).length, 1, 'events 仍要写进去')
  } finally { s.store.close() }
})

test('防复读块在 utterances 有数据时用新话，而不是迁移旧话', async () => {
  // 复刻线上状态：先塞一条「旧话」（模拟迁移），再写出站文本，最后读防复读块
  const s = freshStore()
  try {
    s.store.appendUtterance({ conv: 'c2c:10001', text: '这是切换前的旧话', at: 1700000000 })
    const w = makeWriter({ store: s.store })
    await w.v5RecordOutbound(peerC2C, { text: '这是刚刚说的新话', msgId: '9003' })
    const block = search.utteranceBlock({ store: s.store, conv: 'c2c:10001', now: Date.now() / 1000 })
    assert.match(block, /这是刚刚说的新话/, '防复读块必须能看到刚说的话')
    // 旧话在预算内可以出现（块取最近 3 条），但**必须排在新话之后** ——
    // 顺序错了等于「最近说过什么」是假的。这才是要锁的不变量。
    const iNew = block.indexOf('这是刚刚说的新话')
    const iOld = block.indexOf('这是切换前的旧话')
    assert.ok(iNew >= 0, '新话必须在块里')
    if (iOld >= 0) assert.ok(iNew < iOld, '新话必须排在旧话前面（按时间倒序）')
  } finally { s.store.close() }
})
