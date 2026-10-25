// OneBot 11 WebSocket 客户端：连 NapCat 的正向 WS，收事件、发 action。
// 只依赖 Node 内置 WebSocket（Node 22 起全局可用），无第三方依赖。

const RECONNECT_BASE = 1000

export class OneBotGateway {
  /**
   * @param {object} opts
   * @param {string} opts.wsUrl
   * @param {string} [opts.token]
   * @param {number} [opts.reconnectMs]
   * @param {number} [opts.heartbeatTimeoutMs]
   * @param {(msg: string, meta?: object) => void} [opts.log]
   * @param {(evt: object) => void} [opts.onEvent]
   */
  constructor({ wsUrl, token = '', reconnectMs = 3000, heartbeatTimeoutMs = 90000, log, onEvent }) {
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
    try { this.ws?.close() } catch { /* ignore */ }
    this.connected = false
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer)
      reject(new Error('gateway stopped'))
    }
    this.pending.clear()
  }

  _url() {
    if (!this.token) return this.wsUrl
    const u = new URL(this.wsUrl)
    u.searchParams.set('access_token', this.token)
    return u.toString()
  }

  _connect() {
    return new Promise(resolve => {
      let settled = false
      const done = () => { if (!settled) { settled = true; resolve() } }
      let ws
      try {
        ws = new WebSocket(this._url())
      } catch (err) {
        this.log(`onebot: 创建 WebSocket 失败: ${err.message}`)
        return this._scheduleReconnect(done)
      }
      this.ws = ws
      const openTimer = setTimeout(() => {
        this.log('onebot: 连接超时（8s）')
        try { ws.close() } catch { /* ignore */ }
        this._scheduleReconnect(done)
      }, 8000)

      ws.addEventListener('open', () => {
        clearTimeout(openTimer)
        this.connected = true
        this.reconnectAttempt = 0
        this.lastHeartbeat = Date.now()
        this.log(`onebot: 已连接 ${this.wsUrl}`)
        this._startHeartbeat()
        this._probeLogin().catch(() => {})
        done()
      })

      ws.addEventListener('message', ev => {
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
      this._connect().then(() => resolve?.())
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
      if (frame.meta_event_type === 'heartbeat') {
        this.lastHeartbeat = Date.now()
        const status = frame.status
        if (status?.online === false && this.connected) this.log('onebot: 心跳显示 QQ 不在线')
      }
      return
    }
    if (frame?.post_type === 'message' || frame?.post_type === 'message_sent' ||
        frame?.post_type === 'notice' || frame?.post_type === 'request') {
      try { this.onEvent(frame) } catch (err) { this.log(`onebot: 事件处理异常 ${err.message}`) }
      return
    }
    if (frame?.post_type === 'meta_event' && frame.meta_event_type === 'lifecycle') {
      this.log(`onebot: lifecycle ${frame.sub_type}`)
    }
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

  /** 调用 OneBot action，返回完整响应帧（含 status/retcode/data）。 */
  call(action, params = {}, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (!this.connected || !this.ws) return reject(new Error(`onebot not connected (action=${action})`))
      const echo = `e${this.nextEcho++}`
      const timer = setTimeout(() => {
        this.pending.delete(echo)
        reject(new Error(`onebot action timeout: ${action}`))
      }, timeoutMs)
      this.pending.set(echo, { resolve, reject, timer })
      try {
        this.ws.send(JSON.stringify({ action, params, echo }))
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(echo)
        reject(err)
      }
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
