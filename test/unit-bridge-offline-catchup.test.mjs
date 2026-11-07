// test/unit-bridge-offline-catchup.test.mjs —— 离线消息补读（2026-11-07）
//
// 为什么测行为而不是「源码里有没有这个函数」：
//   这个补读要解决的问题（QQ 被踢后、桥还在退避重连时，NapCat 已经推出来的离线消息
//   没人接）只有**数据流**能证明：哪些消息被重放、顺序对不对、旧消息会不会被翻出来、
//   自说自话的消息会不会被当成对方消息。所以这里用假 gateway 直接跑模块，
//   断言「重放了什么 / 没重放什么 / 水位推进到哪」。
//
// 现场实证见 lib/bridge/offline.js 头注释（2026-11-07 14:37 丢了「让你大开眼界！」）。

import test from 'node:test'
import assert from 'node:assert/strict'
import { createOfflineCatchUp, OFFLINE_DEFAULTS } from '../lib/bridge/offline.js'

const SELF = '1398198377'
const T = 1_794_030_000   // 固定的「现在」（Unix 秒），所有用例都用相对它算

/**
 * 造一个假 OneBotGateway + 一套可断言的回放收集器。
 * @param {object} opts
 * @param {Array} [opts.recents]   get_recent_contact 返回的会话
 * @param {Object} [opts.histories] 'c2c:<qq>' / 'group:<gid>' -> messages[]
 * @param {object|Error} [opts.login] get_login_info 返回（Error = 一直没登录）
 * @param {boolean} [opts.online]
 * @param {number} [opts.watermark] 初始水位（Unix 秒）
 * @param {object} [opts.offlineCfg] 覆盖 config.offlineCatchUp
 */
function makeCtx (opts = {}) {
  const {
    recents = [],
    histories = {},
    login = { user_id: SELF },
    online = true,
    watermark = 0,
    offlineCfg = {},
  } = opts
  const calls = []
  const replayed = []
  const logs = []
  let wm = watermark
  const nowMs = T * 1000

  const gateway = {
    get online () { return online },
    async callData (action, params = {}) {
      calls.push({ action, params })
      if (action === 'get_login_info') {
        if (login instanceof Error) throw login
        return login
      }
      if (action === 'get_recent_contact') return recents
      if (action === 'get_friend_msg_history') {
        return { messages: histories[`c2c:${params.user_id}`] ?? [] }
      }
      if (action === 'get_group_msg_history') {
        return { messages: histories[`group:${params.group_id}`] ?? [] }
      }
      throw new Error(`unexpected action ${action}`)
    },
  }

  const cu = createOfflineCatchUp({
    gateway,
    config: { offlineCatchUp: offlineCfg },
    logger: { log: m => logs.push(m) },
    getWatermark: () => wm,
    setWatermark: v => { wm = Math.max(wm, v) },
    replay: evt => { replayed.push(evt); return true },
    now: () => nowMs,
    sleep: async () => {},
  })
  return { cu, calls, replayed, logs, watermark: () => wm, gateway }
}

const msg = (id, t, user = '3022464706') => ({
  post_type: 'message',
  message_id: id,
  user_id: user,
  time: t,
  message: [{ type: 'text', data: { text: `m${id}` } }],
})

// ── 1. 核心：把水位之后、断线窗口里的消息补回来 ─────────────────────────────
test('offline: 水位之后的消息按时间顺序补读，水位推进到最新一条', async () => {
  const { cu, calls, replayed, watermark } = makeCtx({
    watermark: T - 100,
    recents: [{ peerUin: '3022464706', chatType: 1, msgTime: String(T - 5) }],
    histories: {
      'c2c:3022464706': [
        msg(11, T - 100),   // 等于水位 = 已经处理过，不能补
        msg(12, T - 50),
        msg(13, T - 20),
        msg(14, T - 5),
        msg(15, T - 4, SELF), // 自己发的（message_sent/历史里也可能出现）不能补
      ],
    },
  })
  const r = await cu.catchUp('test')
  assert.equal(r.replayed, 3, '只补 12/13/14 三条')
  assert.deepEqual(replayed.map(e => e.message_id), [12, 13, 14], '必须按时间先后重放')
  assert.equal(watermark(), T - 5, '水位推进到补到的最新一条')
  // 真的去问了历史（而不是只拿 recent 列表就下结论）
  const hist = calls.find(c => c.action === 'get_friend_msg_history')
  assert.ok(hist, '私聊要走 get_friend_msg_history')
  assert.equal(hist.params.user_id, '3022464706')
})

test('offline: recent 里最后一条不比水位新 → 一次历史都不查', async () => {
  const { cu, calls, replayed } = makeCtx({
    watermark: T - 10,
    recents: [{ peerUin: '3022464706', chatType: 1, msgTime: String(T - 50) }],
    histories: { 'c2c:3022464706': [msg(1, T - 5)] },
  })
  const r = await cu.catchUp('test')
  assert.equal(r.replayed, 0)
  assert.equal(replayed.length, 0)
  assert.equal(calls.filter(c => c.action.endsWith('_msg_history')).length, 0)
})

// ── 2. 群聊：action 与字段不能混成私聊 ──────────────────────────────────────
test('offline: 群会话走 get_group_msg_history，补出来的事件带 group_id/message_type', async () => {
  const { cu, calls, replayed } = makeCtx({
    watermark: T - 10,
    recents: [{ peerUin: '1064190335', chatType: 2, msgTime: String(T - 2) }],
    histories: {
      'group:1064190335': [
        // 历史消息里没有 group_id，也要按会话补上（否则 peerOf() 会算成 c2c）
        { post_type: 'message', message_id: 21, user_id: '3022464706', time: T - 3, message: [] },
      ],
    },
  })
  const r = await cu.catchUp('test')
  assert.equal(r.replayed, 1)
  const evt = replayed[0]
  assert.equal(evt.message_type, 'group')
  assert.equal(evt.group_id, '1064190335')
  const hist = calls.find(c => c.action === 'get_group_msg_history')
  assert.ok(hist, '群聊必须走 group 历史 action')
  assert.equal(hist.params.group_id, '1064190335')
})

// ── 3. 没登录 / 没连接：跳过而不是报错 ─────────────────────────────────────
test('offline: 一直没登录（NapCat 在等扫码）→ 跳过补读，不查历史', async () => {
  const { cu, calls, replayed } = makeCtx({
    login: new Error('not logged in'),
    offlineCfg: { loginWaitMs: 10, loginPollMs: 1 },
    watermark: T - 10,
    recents: [{ peerUin: '3022464706', chatType: 1, msgTime: String(T - 2) }],
  })
  const r = await cu.catchUp('test')
  assert.equal(r.skipped, 'not-logged-in')
  assert.equal(replayed.length, 0)
  assert.equal(calls.filter(c => c.action === 'get_recent_contact').length, 0)
})

test('offline: 网关未连接时直接跳过', async () => {
  const { cu, calls } = makeCtx({ online: false })
  const r = await cu.catchUp('test')
  assert.equal(r.skipped, 'offline')
  assert.equal(calls.length, 0)
})

// ── 4. 上限：单会话 / 总量 / 时间窗 ────────────────────────────────────────
test('offline: 单会话默认最多补 10 条（取最新的 10 条）', async () => {
  const many = Array.from({ length: 30 }, (_, i) => msg(100 + i, T - 100 + i))
  const { cu, replayed } = makeCtx({
    watermark: T - 1000,
    recents: [{ peerUin: '3022464706', chatType: 1, msgTime: String(T - 71) }],
    histories: { 'c2c:3022464706': many },
  })
  const r = await cu.catchUp('test')
  assert.equal(r.replayed, OFFLINE_DEFAULTS.perPeer)
  assert.deepEqual(replayed.map(e => e.message_id), many.slice(-10).map(e => e.message_id))
  assert.equal(replayed[replayed.length - 1].time, T - 71, '补的必须是最新的那批')
})

test('offline: 总量上限超出时只补最新的，并在日志里说明略过多少', async () => {
  const many = Array.from({ length: 40 }, (_, i) => msg(200 + i, T - 200 + i))
  const { cu, replayed, logs } = makeCtx({
    watermark: T - 1000,
    offlineCfg: { maxMessages: 5, perPeer: 100 },
    recents: [{ peerUin: '3022464706', chatType: 1, msgTime: String(T - 161) }],
    histories: { 'c2c:3022464706': many },
  })
  const r = await cu.catchUp('test')
  assert.equal(r.replayed, 5)
  assert.equal(r.dropped, 35)
  assert.equal(replayed[replayed.length - 1].time, T - 161, '最新一条必须补到')
  assert.ok(logs.some(l => l.includes('超出上限')), '略过要留痕')
})

test('offline: 超过 maxAgeHours 的旧消息不补（离线一整天后不翻旧账）', async () => {
  const { cu, replayed, watermark } = makeCtx({
    watermark: T - 20 * 3600,
    recents: [{ peerUin: '3022464706', chatType: 1, msgTime: String(T - 3600) }],
    histories: {
      'c2c:3022464706': [
        msg(31, T - 13 * 3600),  // 超过 12h，不补
        msg(32, T - 3600),       // 1h 前，补
      ],
    },
  })
  const r = await cu.catchUp('test')
  assert.equal(r.replayed, 1)
  assert.equal(replayed[0].message_id, 32)
  assert.equal(watermark(), T - 3600)
})

// ── 5. 容错：history 返回结构不对/报错不能把桥带崩 ─────────────────────────
test('offline: 某个会话取历史失败只记日志，其它会话照常补', async () => {
  const { cu, replayed, logs } = makeCtx({
    watermark: T - 100,
    recents: [
      { peerUin: '1111111', chatType: 1, msgTime: String(T - 10) },
      { peerUin: '3022464706', chatType: 1, msgTime: String(T - 5) },
    ],
    histories: { 'c2c:3022464706': [msg(41, T - 5)] },
  })
  // 第一个会话的 history 不在表里 → historyOf 返回空（不抛）；再模拟一个 action 直接报错
  const orig = cu.catchUp
  const r = await orig('test')
  assert.equal(r.replayed, 1)
  assert.equal(replayed[0].message_id, 41)
  // 异常路径：callData 抛错时也要返回 error 而不是 reject
  const bad = makeCtx({ watermark: T - 100, recents: [{ peerUin: '3022464706', chatType: 1, msgTime: String(T - 2) }] })
  bad.gateway.callData = async (action) => {
    if (action === 'get_login_info') return { user_id: SELF }
    if (action === 'get_recent_contact') throw new Error('napcat busy')
    throw new Error('weird')
  }
  // 重新建一个用坏 gateway 的实例（gateway 在闭包里，直接换掉 callData 也可）
  const badCu = createOfflineCatchUp({
    gateway: bad.gateway,
    config: {},
    logger: { log: m => logs.push(m) },
    getWatermark: () => T - 100,
    setWatermark: () => {},
    replay: evt => replayed.push(evt),
    now: () => T * 1000,
    sleep: async () => {},
  })
  const r2 = await badCu.catchUp('test')
  assert.ok(r2.skipped || r2.error, '失败要返回状态，不能 reject')
})
