// 离线消息补读（2026-11-07）
//
// ── 为什么需要它 ────────────────────────────────────────────────────────────
// QQ 被踢下线后重新扫码，NapCat「登录成功」的那一刻就会把**离线期间收到的消息**
// 推给所有连着的 WS 客户端。但桥的重连是带退避的（失败次数越多等得越久，上限 30s），
// 这段空窗期推出来的消息**没人在听，就永远丢了** —— 不是「不回复」，是桥根本没见过。
//
// 现场实证（2026-11-07 14:37，同一台机器）：
//   NapCat 日志  14:37:50 登录成功、14:37:50 收到「让你大开眼界！」
//   bridge.log   14:38:20 才 `onebot: 已连接`（第 37 次重连的退避）
//                14:38:56 收到的是下一条「好无聊啊」
//   → 「让你大开眼界！」在桥里没有任何入站记录。用户视角就是
//     「账号下线后收到的消息不会响应，桥不会读」。
//
// 退避调小治标不治本（再快也有竞态）。正解是**连上之后主动补读**：
//   ① 等 `get_login_info` 真的返回 user_id（WS 可能先于 QQ 登录就连上了）
//   ② `get_recent_contact` 拿最近会话
//   ③ 对「最后一条消息时间 > 水位」的会话取 history（私聊/群聊两个 action）
//   ④ 把水位之后、且不是自己发的消息，按时间先后重新注入入站流水线
//
// 去重：回放走 gateway.injectEvent()，和实时推送共用同一个 message_id 去重窗口，
// 所以「实时推一遍 + 补读又拿一遍」不会变成两轮回复。
//
// 水位：state.offline.lastSeenTs（Unix 秒），每条真实入站消息都刷新并落盘，
// 桥重启也不丢。旧状态文件第一次升级时用 peers[*].proactive.lastUserMsgAt 推出来。

/** 补读参数的默认值（可用 bridge-config 的 offlineCatchUp 段覆盖，主要给测试/运维用）。 */
export const OFFLINE_DEFAULTS = {
  enabled: true,
  maxAgeHours: 12,        // 超过 12 小时的消息不补（避免离线一整天后翻旧账）
  maxMessages: 30,        // 单次补读总量上限
  perPeer: 10,            // 每个会话最多取几条
  maxPeers: 10,           // 单次最多查几个会话的历史
  contactCount: 50,       // get_recent_contact 取多少个
  settleMs: 1500,         // 登录成功后稍等再问会话列表（连续两次连接时 NapCat 还没准备好）
  loginWaitMs: 5 * 60 * 1000,
  loginPollMs: 3000,
  historyTimeoutMs: 15000,
  retryMs: 15000,         // 两次补读尝试的最小间隔（open 与 lifecycle connect 会先后触发）
}

function fmtTs (sec) {
  const n = Number(sec)
  if (!Number.isFinite(n) || n <= 0) return '-'
  const d = new Date(n * 1000)
  const p = x => String(x).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/**
 * @param {object} deps
 * @param {object} deps.gateway           OneBotGateway（需要 callData / online / injectEvent）
 * @param {object} [deps.config]          bridge 配置（只读 config.offlineCatchUp）
 * @param {object} deps.logger            { log }
 * @param {() => number} deps.getWatermark 取当前水位（Unix 秒）
 * @param {(ts: number) => void} deps.setWatermark 写水位（Unix 秒）
 * @param {(evt: object) => void} deps.replay 把一条 OB11 message 事件送回入站流水线
 * @param {() => number} [deps.now]
 * @param {(ms: number) => Promise<any>} [deps.sleep]
 */
export function createOfflineCatchUp (deps) {
  const {
    gateway,
    config = {},
    logger,
    getWatermark,
    setWatermark,
    replay,
    now = () => Date.now(),
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  } = deps
  const opt = { ...OFFLINE_DEFAULTS, ...(config.offlineCatchUp ?? {}) }

  let running = false
  let lastAttemptAt = 0
  let lastResult = null

  const log = msg => logger?.log?.(`offline: ${msg}`)

  /** 读一次登录信息；没登录/连接断了都返回 null（不抛）。 */
  async function loginInfo () {
    try {
      const data = await gateway.callData('get_login_info', {}, 6000)
      return data?.user_id ? data : null
    } catch {
      return null
    }
  }

  /**
   * 等到 QQ 真的登录成功。
   * 为什么要等：NapCat 的 OneBot WS 服务在**扫码前**就已经在监听，
   * 桥完全可能先连上、后登录；这时立刻查会话列表会拿到空/报错。
   */
  async function waitLogin () {
    const maxPolls = Math.max(1, Math.ceil(Number(opt.loginWaitMs) / Math.max(1, Number(opt.loginPollMs))))
    for (let i = 0; i < maxPolls; i++) {
      const info = await loginInfo()
      if (info) return info
      if (i < maxPolls - 1) await sleep(opt.loginPollMs)
    }
    return null
  }

  /** 取最近会话；返回数组（不同 NapCat 版本外层包装不一样，几种都认）。 */
  async function recentContacts () {
    let lastErr = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const data = await gateway.callData('get_recent_contact', { count: opt.contactCount }, opt.historyTimeoutMs)
        if (Array.isArray(data)) return data
        if (Array.isArray(data?.list)) return data.list
        if (Array.isArray(data?.contacts)) return data.contacts
        return []
      } catch (err) {
        lastErr = err
        await sleep(1200)
      }
    }
    throw lastErr ?? new Error('get_recent_contact 无数据')
  }

  /**
   * 取某个会话的历史消息。
   * chatType：1 = 私聊（KCHATTYPEC2C），2 = 群（KCHATTYPEGROUP）。
   * 其它（临时会话/频道等）先跳过 —— 补读只覆盖策略里真正会被回复的两类。
   */
  async function historyOf (contact) {
    const isGroup = Number(contact.chatType) === 2
    const peerId = String(contact.peerUin ?? contact.user_id ?? contact.group_id ?? '')
    if (!peerId) return { isGroup, peerId, messages: [] }
    const action = isGroup ? 'get_group_msg_history' : 'get_friend_msg_history'
    const params = isGroup
      ? { group_id: peerId, count: opt.perPeer }
      : { user_id: peerId, count: opt.perPeer }
    let data
    try {
      data = await gateway.callData(action, params, opt.historyTimeoutMs)
    } catch (err) {
      log(`取历史失败 ${isGroup ? 'group' : 'c2c'}:${peerId}：${err?.message ?? err}`)
      return { isGroup, peerId, messages: [] }
    }
    const messages = Array.isArray(data)
      ? data
      : (Array.isArray(data?.messages) ? data.messages : [])
    return { isGroup, peerId, messages }
  }

  /**
   * 把 NapCat history 返回的消息整理成入站事件。
   * 正常情况 history 也是完整 OB11 message（带 post_type/message/sender），
   * 但不同版本字段不一定齐，这里补齐 peerOf()/flattenMessage() 需要的最小集合。
   */
  function normalize (msg, { isGroup, peerId }, selfId) {
    if (!msg || typeof msg !== 'object') return null
    if (msg.post_type && msg.post_type !== 'message') return null
    if (msg.post_type === 'message_sent' || msg.message_sent_type) return null
    const uid = msg.user_id != null ? String(msg.user_id) : ''
    if (selfId && uid && uid === String(selfId)) return null
    const t = Number(msg.time)
    if (!Number.isFinite(t) || t <= 0) return null
    const evt = { ...msg, post_type: 'message', time: t }
    if (isGroup) {
      evt.message_type = 'group'
      if (evt.group_id == null) evt.group_id = peerId
    } else {
      evt.message_type = 'private'
      if (evt.sub_type == null) evt.sub_type = 'friend'
      if (evt.user_id == null) evt.user_id = peerId
    }
    if (!evt.sender) evt.sender = { user_id: evt.user_id, nickname: '' }
    return evt
  }

  /**
   * 真正补读。返回 { replayed, dropped?, watermark } 或 { skipped: 原因 }。
   * 任何失败都只记日志 —— 补读是兜底路径，不能影响正常收发。
   */
  async function catchUp (reason = 'connect') {
    if (opt.enabled === false) return { skipped: 'disabled' }
    if (running) return { skipped: 'running' }
    if (!gateway.online) return { skipped: 'offline' }
    if (now() - lastAttemptAt < opt.retryMs) return { skipped: 'throttled' }
    lastAttemptAt = now()
    running = true
    const t0 = now()
    try {
      const wmRaw = Math.max(0, Math.floor(Number(getWatermark?.()) || 0))
      const info = await waitLogin()
      if (!info) {
        log(`等不到登录（${Math.round((now() - t0) / 1000)}s），跳过补读`)
        return { skipped: 'not-logged-in' }
      }
      const selfId = String(info.user_id ?? '')
      if (Number(opt.settleMs) > 0) await sleep(opt.settleMs)

      const contacts = await recentContacts()
      // 水位不能停在很久以前：超过 maxAgeHours 的旧消息一律当已处理，
      // 否则每次连上都去翻同一批老消息（还可能一次性回一堆隔夜消息）。
      const ageCutoff = Math.floor(now() / 1000) - Number(opt.maxAgeHours) * 3600
      const wm = Math.max(wmRaw, ageCutoff)

      // 先筛会话：只要「最后一条比水位新」的私聊/群聊
      const targets = []
      for (const c of contacts) {
        if (!c || typeof c !== 'object') continue
        const chatType = Number(c.chatType)
        if (chatType !== 1 && chatType !== 2) continue
        const peerId = String(c.peerUin ?? c.user_id ?? c.group_id ?? '')
        if (!peerId) continue
        const ts = Number(c.msgTime)
        if (!Number.isFinite(ts) || ts <= wm) continue
        targets.push({ contact: c, peerId, isGroup: chatType === 2, ts })
      }
      targets.sort((a, b) => b.ts - a.ts)   // 最近的会话优先，历史请求次数有限

      const picked = []
      let queried = 0
      for (const target of targets) {
        if (queried >= Number(opt.maxPeers)) break
        queried++
        const h = await historyOf(target.contact)
        const fresh = []
        for (const m of h.messages) {
          const evt = normalize(m, h, selfId)
          if (!evt) continue
          if (evt.time <= wm) continue
          fresh.push(evt)
        }
        fresh.sort((a, b) => a.time - b.time)
        for (const evt of fresh.slice(-Number(opt.perPeer))) picked.push(evt)
      }
      picked.sort((a, b) => a.time - b.time)

      const replayList = picked.slice(-Number(opt.maxMessages))
      const dropped = picked.length - replayList.length
      const newest = picked.reduce((mx, e) => Math.max(mx, e.time), 0)

      if (!replayList.length) {
        log(`无需补读（水位 ${fmtTs(wm)}，最近会话 ${contacts.length} 个，超过水位的 ${targets.length} 个）`)
        lastResult = { replayed: 0, watermark: wm, at: t0 }
        return lastResult
      }

      let replayed = 0
      for (const evt of replayList) {
        // 标记「这是补读回来的」：入站 prompt 会据此告诉模型原消息时间，
        // 让它可以自然地说「刚看到」而不是装成刚刚收到。
        evt._offlineReplay = true
        if (replay?.(evt) !== false) replayed++
      }
      // 水位放在回放**之后**推进：中途失败时下一次还能重试（回放成功的那些
      // 已经由入站流水线的 noteInboundTime 逐条推进过水位了）。
      if (newest > wm) setWatermark?.(newest)
      log(`补读 ${replayed} 条（${dropped > 0 ? `另有 ${dropped} 条超出上限略过；` : ''}` +
        `水位 → ${fmtTs(Math.max(wm, newest))}；触发=${reason}）`)
      lastResult = { replayed, dropped, watermark: Math.max(wm, newest), at: t0 }
      return lastResult
    } catch (err) {
      log(`补读失败（不影响正常收发）：${err?.message ?? err}`)
      return { error: String(err?.message ?? err) }
    } finally {
      running = false
    }
  }

  /** 连接建立时调用；不 await，避免挡住主循环。 */
  function onConnect (reason = 'connect') {
    catchUp(reason).catch(err => log(`补读异常：${err?.message ?? err}`))
  }

  return {
    onConnect,
    catchUp,
    get lastResult () { return lastResult },
  }
}
