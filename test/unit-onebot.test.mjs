// test/unit-onebot.test.mjs —— OneBot 网关的三处修复（离线、无真 socket）
//
// 背景（为什么值得测）：
//   1. meta_event 里「非 lifecycle 先 return」的写法曾把 lifecycle 分支变成死代码，
//      connect/enable/disable 从来没被处理过；
//   2. connect 与重连各自 new 一次 WebSocket，重连会叠加 socket，旧 socket 的 close
//      又触发新一轮重连（风暴）；
//   3. 入站消息重连后可能重复投递，靠 message_id 去重；
//   4. 未连接时 call() 直接 reject 会丢消息，现在入队 + 排队超时。
//
// 这里用假 WebSocket 类替换全局 WebSocket，只验证网关自己的契约。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const M = await import(pathToFileURL(path.join(ROOT, 'lib', 'bridge', 'onebot.js')).href)

const REAL_WS = globalThis.WebSocket

class FakeWS {
  static OPEN = 1
  static instances = []
  constructor (url, opts) {
    this.url = url
    this.opts = opts
    this.readyState = 0
    this.sent = []
    this.listeners = new Map()
    FakeWS.instances.push(this)
  }

  addEventListener (type, fn) {
    const list = this.listeners.get(type) ?? []
    list.push(fn)
    this.listeners.set(type, list)
  }

  emit (type, ev = {}) {
    for (const fn of this.listeners.get(type) ?? []) fn(ev)
  }

  open () {
    this.readyState = 1
    this.emit('open', {})
  }

  send (data) {
    if (this.readyState !== 1) throw new Error('send on non-open socket')
    this.sent.push(JSON.parse(data))
  }

  close () {
    if (this.readyState === 3) return
    this.readyState = 3
    this.emit('close', { code: 1000, reason: 'fake-close' })
  }
}

function useFakeWs (t) {
  FakeWS.instances = []
  globalThis.WebSocket = FakeWS
  t.after(() => { globalThis.WebSocket = REAL_WS })
}

function makeGateway (t, extra = {}) {
  const logs = []
  const events = []
  const gw = new M.OneBotGateway({
    wsUrl: 'ws://127.0.0.1:9999',
    log: m => logs.push(m),
    onEvent: e => events.push(e),
    ...extra,
  })
  t.after(() => gw.stop())
  return { gw, logs, events }
}

// ── 1. 入站 message_id 去重 ─────────────────────────────────────────────────
test('onebot: 重复 message_id 只触发一次 onEvent，且打 debug 日志', (t) => {
  const { gw, logs, events } = makeGateway(t)
  gw._handleFrame({ post_type: 'message', message_id: 1001, raw_message: 'hi' })
  gw._handleFrame({ post_type: 'message', message_id: 1001, raw_message: 'hi' })
  gw._handleFrame({ post_type: 'message', message_id: 1002, raw_message: 'yo' })
  assert.equal(events.length, 2, '重复帧必须被丢掉')
  assert.equal(events[0].message_id, 1001)
  assert.equal(events[1].message_id, 1002)
  assert.ok(logs.some(l => l.startsWith('debug ') && l.includes('重复消息') && l.includes('1001')), '重复帧要有 debug 日志')
})

test('onebot: 没有 message_id 的帧不做去重（照常派发）', (t) => {
  const { gw, events } = makeGateway(t)
  gw._handleFrame({ post_type: 'message', raw_message: 'a' })
  gw._handleFrame({ post_type: 'message', raw_message: 'a' })
  assert.equal(events.length, 2)
})

test('onebot: 去重窗口有上限，最旧的 id 会被挤出（环形）', (t) => {
  const { gw, events } = makeGateway(t, { dedupeMax: 2 })
  gw._handleFrame({ post_type: 'message', message_id: 1 })
  gw._handleFrame({ post_type: 'message', message_id: 2 })
  gw._handleFrame({ post_type: 'message', message_id: 3 })
  assert.equal(gw._seenMessageIds.size, 2)
  assert.equal(gw._seenMessageIds.has('1'), false, '最旧的 id 应被挤出窗口')
  // 被挤出的 id 再次出现：会当成新消息（窗口有限，符合设计）
  gw._handleFrame({ post_type: 'message', message_id: 1 })
  assert.equal(events.length, 4)
})

// ── 2. lifecycle 可达到 + 状态置位 ─────────────────────────────────────────
test('onebot: lifecycle connect/enable 置为已连接，disable 标为未连接', (t) => {
  const { gw, logs } = makeGateway(t)
  assert.equal(gw.online, false)
  gw._handleFrame({ post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect' })
  assert.equal(gw.online, true, 'lifecycle connect 必须被处理（不再是死代码）')
  gw._handleFrame({ post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'disable' })
  assert.equal(gw.online, false)
  gw._handleFrame({ post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'enable' })
  assert.equal(gw.online, true)
  assert.ok(logs.some(l => l.includes('lifecycle connect')), 'lifecycle 要有日志')
  assert.ok(logs.some(l => l.includes('lifecycle disable')))
})

test('onebot: heartbeat 不改变连接状态', (t) => {
  const { gw } = makeGateway(t)
  gw.lastHeartbeat = 0
  gw._handleFrame({ post_type: 'meta_event', meta_event_type: 'heartbeat', status: { online: true } })
  assert.ok(gw.lastHeartbeat > 0, 'heartbeat 应刷新 lastHeartbeat')
  assert.equal(gw.online, false)
})

// ── 3. 未连接时 call 入队、连接后按序 flush ────────────────────────────────
test('onebot: 未连接时 call 入队，lifecycle connect 后按序发出', async (t) => {
  useFakeWs(t)
  const { gw } = makeGateway(t)
  const p1 = gw.call('send_private_msg', { text: 'a' })
  const p2 = gw.call('send_group_msg', { text: 'b' })
  const p3 = gw.call('send_msg', { text: 'c' })
  assert.equal(gw._outbox.length, 3, '未连接时应进队列而不是 reject')
  assert.equal(gw.ws, null)

  // 模拟握手完成（socket OPEN）+ lifecycle connect → flush
  const ws = new FakeWS('ws://127.0.0.1:9999', undefined)
  ws.readyState = 1
  gw.ws = ws
  gw._handleFrame({ post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect' })

  assert.deepEqual(ws.sent.map(f => f.action), ['send_private_msg', 'send_group_msg', 'send_msg'], '必须按入队顺序发出')
  assert.equal(gw._outbox.length, 0)

  for (const f of ws.sent) gw._handleFrame({ echo: f.echo, status: 'ok', retcode: 0, data: { action: f.action } })
  const [r1, r2, r3] = await Promise.all([p1, p2, p3])
  assert.equal(r1.data.action, 'send_private_msg')
  assert.equal(r2.data.action, 'send_group_msg')
  assert.equal(r3.data.action, 'send_msg')
})

test('onebot: 已连接且空闲时 call 直接发出（不进队列）', async (t) => {
  useFakeWs(t)
  const { gw } = makeGateway(t)
  const ws = new FakeWS('ws://127.0.0.1:9999', undefined)
  ws.readyState = 1
  gw.ws = ws
  gw.connected = true
  const p = gw.call('get_status', {})
  assert.equal(gw._outbox.length, 0)
  assert.equal(ws.sent.length, 1)
  gw._handleFrame({ echo: ws.sent[0].echo, status: 'ok', retcode: 0, data: { online: true } })
  const res = await p
  assert.deepEqual(res.data, { online: true })
})

test('onebot: 队列满时丢最旧并 warn', async (t) => {
  const { gw, logs } = makeGateway(t, { outboxMax: 2 })
  const p1 = gw.call('a1')
  p1.catch(() => {})
  const p2 = gw.call('a2')
  p2.catch(() => {})
  const p3 = gw.call('a3')
  p3.catch(() => {})
  await assert.rejects(p1, /queue overflow/)
  assert.deepEqual(gw._outbox.map(i => i.action), ['a2', 'a3'])
  assert.ok(logs.some(l => l.startsWith('WARN onebot:') && l.includes('队列已满')), '丢最旧必须 warn')
})

test('onebot: 排队超时会 reject 并 warn（不永久挂住）', async (t) => {
  const { gw, logs } = makeGateway(t, { outboxTimeoutMs: 30 })
  const p = gw.call('send_msg', { text: 'x' })
  await assert.rejects(p, /queue timeout/)
  assert.equal(gw._outbox.length, 0, '超时的项必须从队列移除')
  assert.ok(logs.some(l => l.startsWith('WARN onebot:') && l.includes('排队超时')))
})

test('onebot: stop() 后 call 直接 reject，且队列里的 Promise 被清理', async (t) => {
  const { gw } = makeGateway(t)
  const queued = gw.call('send_msg', {})
  queued.catch(() => {})
  gw.stop()
  await assert.rejects(queued, /gateway stopped/)
  await assert.rejects(gw.call('send_msg', {}), /onebot stopped/)
})

// ── 4. 单一 socket 入口：旧 socket 的 close 被忽略 ──────────────────────────
test('onebot: start() 只建一个 socket，重开时旧 socket 被关且其 close 被忽略', async (t) => {
  useFakeWs(t)
  const { gw } = makeGateway(t, { reconnectMs: 10 })

  const startP = gw.start()
  const first = FakeWS.instances[0]
  first.open()
  await startP
  assert.equal(FakeWS.instances.length, 1, 'start 只应建一个 WebSocket')
  assert.equal(gw.online, true)

  const reopenP = gw._openSocket()
  const second = FakeWS.instances[1]
  assert.equal(FakeWS.instances.length, 2)
  assert.equal(first.readyState, 3, '旧 socket 应被主动关闭')
  second.open()
  await reopenP
  assert.equal(gw.online, true)

  // 旧 socket 迟到的 close：不允许把状态打回未连接，也不许触发重连
  first.emit('close', { code: 1006, reason: 'stale' })
  assert.equal(gw.online, true)
  assert.equal(gw.reconnectAttempt, 0)
  await new Promise(r => setTimeout(r, 40))
  assert.equal(FakeWS.instances.length, 2, '旧 socket 的 close 不该再开新连接')
})

test('onebot: 只有 _openSocket 一处 new WebSocket（单一建连入口，重连不叠加）', async () => {
  const fs = await import('node:fs')
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'bridge', 'onebot.js'), 'utf8')
  const hits = src.match(/new WebSocket\(/g) ?? []
  assert.equal(hits.length, 1, '首次连接与重连必须共用同一个建连入口')
})

test('onebot: closedByUs 时断开不再安排重连', async (t) => {
  useFakeWs(t)
  const { gw } = makeGateway(t, { reconnectMs: 1 })
  const startP = gw.start()
  const sock = FakeWS.instances[0]
  gw.closedByUs = true
  sock.close()
  await startP
  assert.equal(gw.reconnectAttempt, 0)
  await new Promise(r => setTimeout(r, 20))
  assert.equal(FakeWS.instances.length, 1, '主动关闭后不许自动重连')
  assert.equal(gw.online, false)
})
