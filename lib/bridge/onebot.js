// OneBot 11 WebSocket 客户端：连 NapCat 的正向 WS，收事件、发 action。
// 只依赖 Node 内置 WebSocket（Node 22 起全局可用），无第三方依赖。

const RECONNECT_BASE = 1000

// WebSocket.OPEN 的数字值（不依赖全局 WebSocket 常量，便于单测替换假实现）
const WS_OPEN = 1
// 入站 message_id 去重窗口：NapCat 重连/补发时同一条消息可能来两次
const MESSAGE_DEDUPE_MAX = 200
// 未连接时 call() 的发送队列：上限与单条排队超时
const OUTBOX_MAX = 200
const OUTBOX_TIMEOUT_MS = 15000

export class OneBotGateway {
  /**
   * @param {object} opts
   * @param {string} opts.wsUrl
   * @param {string} [opts.token]
   * @param {number} [opts.reconnectMs]
   * @param {number} [opts.heartbeatTimeoutMs]
   * @param {number} [opts.dedupeMax] 入站 message_id 去重窗口（默认 200）
   * @param {number} [opts.outboxMax] 未连接时发送队列上限（默认 200）
   * @param {number} [opts.outboxTimeoutMs] 单条发送排队超时（默认 15000）
   * @param {(msg: string, meta?: object) => void} [opts.log]
   * @param {(evt: object) => void} [opts.onEvent]
   */
  constructor({ wsUrl, token = '', reconnectMs = 3000, heartbeatTimeoutMs = 90000, log, onEvent,
    dedupeMax = MESSAGE_DEDUPE_MAX, outboxMax = OUTBOX_MAX, outboxTimeoutMs = OUTBOX_TIMEOUT_MS }) {
    this.wsUrl = wsUrl
    this.token = token
    this.reconnectMs = reconnectMs
    this.heartbeatTimeoutMs = heartbeatTimeoutMs
    this.log = log ?? (() => {})
    this.onEvent = onEvent ?? (() => {})

    this.ws = null
    this.connected = false
    this.closedByUs = false
    this.nextEcho = 1
    this.pending = new Map() // echo -> {resolve, reject, timer}
    this.lastHeartbeat = 0
    this.reconnectAttempt = 0
    this.selfId = null
    this.nickname = null
    this._hbTimer = null

    // 入站 message_id 去重（Set + 插入顺序数组 = 环形窗口）
    this.dedupeMax = dedupeMax
    this._seenMessageIds = new Set()
    this._seenMessageOrder = []

    // 未连接时 call() 的发送队列（FIFO，每条带排队超时）
    this.outboxMax = outboxMax
    this.outboxTimeoutMs = outboxTimeoutMs
    this._outbox = []
  }

  get online() {
    return this.connected
  }

  async start() {
    this.closedByUs = false
    await this._connect()
  }

  stop() {
    this.closedByUs = true
    this._clearHeartbeat()
    const ws = this.ws
    this.ws = null
    try { ws?.close() } catch { /* ignore */ }
    this.connected = false
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer)
      reject(new Error('gateway stopped'))
    }
    this.pending.clear()
    this._failOutbox(new Error('gateway stopped'))
  }

  _url() {
    if (!this.token) return this.wsUrl
    const u = new URL(this.wsUrl)
    // OneBot 11 规范允许把 token 放查询串。两种都发（query + header），
    // 因为不同实现认的不一样 —— 见 _connect 里的说明。
    u.searchParams.set('access_token', this.token)
    return u.toString()
  }

  _wsOptions() {
    // token 同时用两种方式带上：
    //   ① 查询串 access_token=...   ← OneBot 11 规范写法，部分实现只认这个
    //   ② Authorization: Bearer ... ← NapCat 的 WebSocket **服务器**模式认这个，
    //      token 配置在 NapCat WebUI 的「网络配置 → WebSocket 服务器」里
    //
    // 为什么必须两种都发（真实踩坑）：
    //   只发 ① 时，NapCat 服务器模式会用 1005 直接断开，不回任何提示，
    //   日志里看起来像「连上又立刻断开」，极难判断是鉴权问题。
    //   Node 内置 WebSocket 支持第二参数传 headers（已实测），所以两者可兼得。
    if (!this.token) return undefined
    return { headers: { authorization: `Bearer ${this.token}` } }
  }

  _connect() {
    return this._openSocket()
  }

  /**
   * 唯一的建连入口：**任何时刻只保留一个 socket**。
   * connect()/重连都走这里；旧 socket 的事件（open/message/close）一律按
   * `this.ws !== ws` 识别并丢弃，避免旧 socket 的 close 再触发一轮重连风暴。
   */
  _openSocket() {
    return new Promise(resolve => {
      let settled = false
      const done = () => { if (!settled) { settled = true; resolve() } }
      let ws
      try {
        ws = new WebSocket(this._url(), this._wsOptions())
      } catch (err) {
        this.log(`onebot: 创建 WebSocket 失败: ${err.message}`)
        return this._scheduleReconnect(done)
      }
      // 先换上新 socket，再关旧的：旧 socket 的 close 事件会在下面被 `this.ws !== ws` 拦掉
      const prev = this.ws
      this.ws = ws
      if (prev && prev !== ws) { try { prev.close() } catch { /* ignore */ } }

      const openTimer = setTimeout(() => {
        this.log('onebot: 连接超时（8s）')
        // 先摘掉引用，让随后到来的 close 事件被当作「旧 socket」丢弃（重连只在这里触发一次）
        if (this.ws === ws) this.ws = null
        try { ws.close() } catch { /* ignore */ }
        this._scheduleReconnect(done)
      }, 8000)

      ws.addEventListener('open', () => {
        clearTimeout(openTimer)
        if (this.ws !== ws) return
        this.connected = true
        this.reconnectAttempt = 0
        this.lastHeartbeat = Date.now()
        this.log(`onebot: 已连接 ${this.wsUrl}`)
        this._startHeartbeat()
        this._probeLogin().catch(() => {})
        done()
        this._flushOutbox()
      })

      ws.addEventListener('message', ev => {
        if (this.ws !== ws) return
        this.lastHeartbeat = Date.now()
        let frame
        try {
          frame = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
        } catch (err) {
          this.log(`onebot: 收到非 JSON 帧: ${err.message}`)
          return
        }
        this._handleFrame(frame)
      })

      ws.addEventListener('close', ev => {
        clearTimeout(openTimer)
        // 旧 socket 的 close：不改变状态、不重连、不 fail pending（新 socket 还在用）
        if (this.ws !== ws) return done()
        this.ws = null
        const wasConnected = this.connected
        this.connected = false
        this._clearHeartbeat()
        this._failPending(new Error(`connection closed (${ev.code})`))
        if (wasConnected) this.log(`onebot: 连接断开 code=${ev.code} reason=${ev.reason || '-'}`)
        if (!this.closedByUs) this._scheduleReconnect(done)
        else done()
      })

      ws.addEventListener('error', () => {
        // close 事件紧随其后，统一在那里处理重连
      })
    })
  }

  _scheduleReconnect(resolve) {
    if (this.closedByUs) return resolve?.()
    const delay = Math.min(this.reconnectMs * Math.pow(1.5, Math.min(this.reconnectAttempt, 6)), 30000)
    this.reconnectAttempt += 1
    this.log(`onebot: ${Math.round(delay)}ms 后重连（第 ${this.reconnectAttempt} 次）`)
    setTimeout(() => {
      this._openSocket().then(() => resolve?.())
    }, delay)
    resolve?.()
  }

  _handleFrame(frame) {
    if (frame && typeof frame === 'object' && 'echo' in frame && frame.echo != null) {
      const entry = this.pending.get(frame.echo)
      if (entry) {
        clearTimeout(entry.timer)
        this.pending.delete(frame.echo)
        entry.resolve(frame)
      }
      return
    }
    if (frame?.post_type === 'meta_event') {
      // lifecycle 必须在这里先处理：之前它被「meta_event 一律 return」的写法挡死，
      // connect/enable/disable 从来没有被处理过（死代码）。
      if (frame.meta_event_type === 'lifecycle') {
        this._handleLifecycle(frame)
        return
      }
      if (frame.meta_event_type === 'heartbeat') {
        this.lastHeartbeat = Date.now()
        const status = frame.status
        if (status?.online === false && this.connected) this.log('onebot: 心跳显示 QQ 不在线')
      }
      return
    }
    if (frame?.post_type === 'message' && this._isDuplicateMessage(frame)) {
      this.log(`debug onebot: 丢弃重复消息 message_id=${frame.message_id}`)
      return
    }
    if (frame?.post_type === 'message' || frame?.post_type === 'message_sent' ||
        frame?.post_type === 'notice' || frame?.post_type === 'request') {
      try { this.onEvent(frame) } catch (err) { this.log(`onebot: 事件处理异常 ${err.message}`) }
      return
    }
  }

  _handleLifecycle(frame) {
    const sub = frame?.sub_type
    if (sub === 'connect' || sub === 'enable') {
      this.connected = true
      this.lastHeartbeat = Date.now()
      this.log(`onebot: lifecycle ${sub}，已就绪`)
      this._flushOutbox()
      return
    }
    if (sub === 'disable') {
      this.connected = false
      this.log(`onebot: lifecycle ${sub}，标记为未连接`)
      return
    }
    this.log(`onebot: lifecycle ${sub}`)
  }

  /** 入站 message_id 去重：窗口内见过就返回 true（重复帧直接丢弃）。 */
  _isDuplicateMessage(frame) {
    const id = frame?.message_id
    if (id == null) return false
    const key = String(id)
    if (this._seenMessageIds.has(key)) return true
    this._seenMessageIds.add(key)
    this._seenMessageOrder.push(key)
    while (this._seenMessageOrder.length > this.dedupeMax) {
      this._seenMessageIds.delete(this._seenMessageOrder.shift())
    }
    return false
  }

  _canSendNow() {
    return !!(this.connected && this.ws && this.ws.readyState === WS_OPEN)
  }

  _startHeartbeat() {
    this._clearHeartbeat()
    this._hbTimer = setInterval(() => {
      if (!this.connected) return
      if (Date.now() - this.lastHeartbeat > this.heartbeatTimeoutMs) {
        this.log('onebot: 心跳超时，主动断开以触发重连')
        try { this.ws?.close() } catch { /* ignore */ }
      }
    }, 15000)
  }

  _clearHeartbeat() {
    if (this._hbTimer) { clearInterval(this._hbTimer); this._hbTimer = null }
  }

  _failPending(err) {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer)
      reject(err)
    }
    this.pending.clear()
  }

  _failOutbox(err) {
    while (this._outbox.length) {
      const item = this._outbox.shift()
      clearTimeout(item.queueTimer)
      item.reject(err)
    }
  }

  /** 连接就绪后按入队顺序把积压的 action 发出去（发送失败的那条直接 reject，不卡住后面的）。 */
  _flushOutbox() {
    if (!this._canSendNow()) return
    while (this._outbox.length) {
      const item = this._outbox.shift()
      clearTimeout(item.queueTimer)
      if (!this._sendNow(item)) {
        // 竞态：flush 途中连接又断了，放回队列等下次重连（重新起排队超时）
        this._enqueue(item)
        return
      }
    }
  }

  /** 真正把 action 写进 socket：分配 echo、登记 pending、挂 action 超时。返回是否已发出。 */
  _sendNow(item) {
    const { action, params, timeoutMs, resolve, reject } = item
    if (!this._canSendNow()) return false
    const echo = `e${this.nextEcho++}`
    const timer = setTimeout(() => {
      this.pending.delete(echo)
      reject(new Error(`onebot action timeout: ${action}`))
    }, timeoutMs)
    this.pending.set(echo, { resolve, reject, timer })
    try {
      this.ws.send(JSON.stringify({ action, params, echo }))
      return true
    } catch (err) {
      clearTimeout(timer)
      this.pending.delete(echo)
      reject(err)
      return false
    }
  }

  /** 把一条 action 放进发送队列（带排队超时，满了丢最旧并 warn）。 */
  _enqueue(item) {
    if (this._outbox.length >= this.outboxMax) {
      const dropped = this._outbox.shift()
      clearTimeout(dropped.queueTimer)
      dropped.reject(new Error(`onebot queue overflow (${this.outboxMax}), dropped action=${dropped.action}`))
      this.log(`WARN onebot: 发送队列已满（${this.outboxMax}），丢弃最旧 action=${dropped.action}`)
    }
    item.queueTimer = setTimeout(() => {
      const i = this._outbox.indexOf(item)
      if (i >= 0) this._outbox.splice(i, 1)
      item.reject(new Error(`onebot queue timeout (${this.outboxTimeoutMs}ms, action=${item.action})`))
      this.log(`WARN onebot: 发送排队超时 action=${item.action}（${this.outboxTimeoutMs}ms）`)
    }, this.outboxTimeoutMs)
    this._outbox.push(item)
  }

  async _probeLogin() {
    try {
      const info = await this.call('get_login_info', {}, 6000)
      const d = info?.data
      if (d?.user_id) {
        this.selfId = String(d.user_id)
        this.nickname = d.nickname ?? ''
        this.log(`onebot: 登录账号 user_id=${this.selfId} nickname=${this.nickname}`)
      }
    } catch (err) {
      this.log(`onebot: get_login_info 失败: ${err.message}`)
    }
  }

  /**
   * 调用 OneBot action，返回完整响应帧（含 status/retcode/data）。
   * 未连接时不直接失败，而是入队（上限 outboxMax，单条排队超时 outboxTimeoutMs），
   * 连接就绪后按顺序 flush —— 调用方拿到的仍然是同一个 Promise。
   */
  call(action, params = {}, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const item = { action, params, timeoutMs, resolve, reject, queueTimer: null }
      // 已经 shudown 或根本没有 socket 可等：不排队，直接拒绝（排队会永久挂）
      if (this.closedByUs) return reject(new Error(`onebot stopped (action=${action})`))
      if (this._canSendNow() && this._outbox.length === 0) return this._sendNow(item)
      this._enqueue(item)
      // 队列里可能已经有积压，说明连接刚好在入队前恢复，这里顺手 flush 一次
      this._flushOutbox()
    })
  }

  /** 调用 action 并只取 data，非 ok 时抛错。 */
  async callData(action, params = {}, timeoutMs = 30000) {
    const res = await this.call(action, params, timeoutMs)
    if (res.status !== 'ok' && res.retcode !== 0) {
      throw new Error(`onebot ${action} 失败: status=${res.status} retcode=${res.retcode} ${res.wording ?? res.message ?? ''}`)
    }
    return res.data
  }
}

// 供单测使用（只暴露常量/内部契约，不改变外部行为）
export const __test = { WS_OPEN, MESSAGE_DEDUPE_MAX, OUTBOX_MAX, OUTBOX_TIMEOUT_MS }
