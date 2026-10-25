// ACP (Agent Client Protocol) 客户端：spawn `dsh --profile <profile>`，
// 通过 `session/new` 的 `mcpServers` 字段挂载 MCP 服务器（**协议正式支持**，
// 不是绕路），从 `session/update` 收流式输出。
//
// 为什么用 ACP 而不是 SDK：
//   DSH 的 SDK 协议（`@deepseek-ai/dsh-sdk-protocol`）的 `initialize` 只有
//   cwd/provider/model/reasoningEffort/maxTokens，**没有挂载 MCP 的入口**。
//   ACP 的 `session/new` 有 `mcpServers: McpServer[]`（stdio / streamable-http），
//   是官方给「外部控制器驱动 agent 并挂工具」设计的正规通道。
//
// 参考：@deepseek-ai/dsh-acp 的 README「Protocol contract」与 lib/index.js
//      的 mountAcpMcpServers / resolveMcpConfigs 实现。

import { spawn } from 'node:child_process'

export class AcpRuntime {
  /**
   * @param {object} opts
   * @param {string} opts.bin        dsh 可执行文件
   * @param {string} opts.profile    profile 名（llminqq-acp）
   * @param {string} opts.cwd        agent 工作目录
   * @param {string} opts.provider   模型 provider
   * @param {string} opts.model      模型名
   * @param {string} [opts.reasoningEffort]
   * @param {Array}  [opts.mcpServers] ACP 格式的 mcpServers 数组
   * @param {number} [opts.startTimeoutMs]
   * @param {number} [opts.turnTimeoutMs]
   * @param {(m:string)=>void} [opts.log]
   */
  constructor({ bin, profile, cwd, provider, model, reasoningEffort, mcpServers = [], startTimeoutMs = 90000, turnTimeoutMs = 240000, remembered, onSessionCreated, log }) {
    // remembered: Map<peerKey, acpSessionId>（由桥从 state 里恢复，用于 session/resume）
    this._remembered = remembered ?? new Map()
    this.onSessionCreated = onSessionCreated
    this.bin = bin
    this.profile = profile
    this.cwd = cwd
    this.provider = provider
    this.model = model
    this.reasoningEffort = reasoningEffort ?? null
    this.mcpServers = mcpServers
    this.startTimeoutMs = startTimeoutMs
    this.turnTimeoutMs = turnTimeoutMs
    this.log = log ?? (() => {})

    this.child = null
    this.ready = false
    this.nextId = 1
    this.pending = new Map()
    this.partials = new Map() // sessionId -> [text]
    this.turnWaiters = new Map() // sessionId -> [{resolve,reject,timer}]
    this.startPromise = null
    this._onEvent = []
    this.effectiveRoute = null
    this._peerSession = new Map() // peerKey -> acpSessionId（ACP 侧生成的）
    this._acpToPeer = new Map() // acpSessionId -> peerKey
  }

  onEvent (fn) {
    this._onEvent.push(fn)
    return () => { this._onEvent = this._onEvent.filter(f => f !== fn) }
  }

  async start () {
    if (this.startPromise) return this.startPromise
    this.startPromise = this._start().catch(err => { this.startPromise = null; throw err })
    return this.startPromise
  }

  async _start () {
    this.log(`acp: 启动 ${this.bin} --profile ${this.profile} (cwd=${this.cwd})`)
    const child = spawn(this.bin, ['--profile', this.profile], {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    })
    this.child = child

    let buf = ''
    child.stdout.on('data', chunk => {
      buf += chunk.toString('utf8')
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        if (!line.trim()) continue
        let frame
        try { frame = JSON.parse(line) } catch {
          this.log(`acp: 非 JSON stdout 行: ${line.slice(0, 160)}`)
          continue
        }
        this._handleFrame(frame)
      }
    })

    let ebuf = ''
    child.stderr.on('data', chunk => {
      ebuf += chunk.toString('utf8')
      let idx
      while ((idx = ebuf.indexOf('\n')) >= 0) {
        let line = ebuf.slice(0, idx).replace(/\s+$/, '')
        ebuf = ebuf.slice(idx + 1)
        // ACP 的 stderr 里夹着 MCP 自己的日志，太吵，只留有用的一点点
        if (!line) continue
        if (/Processing request|ListToolsRequest|CallToolRequest/i.test(line)) continue
        this.log(`acp[stderr]: ${line.slice(0, 300)}`)
      }
    })

    child.on('exit', (code, signal) => {
      this.ready = false
      this.log(`acp: 进程退出 code=${code} signal=${signal}`)
      this._failAll(new Error(`acp exited (code=${code}, signal=${signal})`))
      this.child = null
      this.startPromise = null
      this._peerSession.clear()
      this._acpToPeer.clear()
    })
    child.on('error', err => {
      this.log(`acp: spawn 错误 ${err.message}`)
      this.startPromise = null
    })

    const init = await this._request('initialize', { protocolVersion: 1, clientCapabilities: {} }, this.startTimeoutMs)
    this.ready = true
    this.log(`acp: 初始化完成 ${JSON.stringify(init?.agentInfo ?? {})}`)
    return init
  }

  stop () {
    this.ready = false
    try { this.child?.kill('SIGTERM') } catch { /* ignore */ }
    setTimeout(() => { try { this.child?.kill('SIGKILL') } catch { /* ignore */ } }, 1500)
  }

  /**
   * 运行时切换模型路由（ACP 有 set_config_option，但只有 session 建立后才能设）。
   * 换 route 不需要重启进程，只影响后续 session。
   */
  async switchRoute (route) {
    this.provider = route.provider
    this.model = route.model
    this.reasoningEffort = route.reasoningEffort ?? null
    this.log(`acp: 切换路由 -> ${this.provider}/${this.model}`)
    // 已建立的会话也要跟着换（ACP 的 set_config_option 可在会话存续期间生效）
    for (const [peerKey, acpSessionId] of this._peerSession) {
      try {
        await this._request('session/set_config_option', {
          sessionId: acpSessionId,
          configId: 'model',
          value: JSON.stringify([this.provider, this.model]),
        }, 30000)
        this.log(`acp: 会话 ${peerKey} 已切到 ${this.provider}/${this.model}`)
      } catch (err) {
        this.log(`acp: 会话切路由失败（下次新建时生效）: ${err.message}`)
      }
    }
  }

  _handleFrame (frame) {
    // 响应
    if (frame.id != null && frame.method == null) {
      const p = this.pending.get(frame.id)
      if (!p) return
      clearTimeout(p.timer)
      this.pending.delete(frame.id)
      if (frame.error) {
        const e = new Error(`${frame.error.message ?? 'rpc error'} (code ${frame.error.code ?? '?'})`)
        e.acpError = frame.error
        p.reject(e)
      } else p.resolve(frame.result)
      return
    }
    // 服务端 → 客户端 的通知/请求
    if (frame.method === 'session/update') {
      this._onUpdate(frame.params)
      return
    }
    // permission 请求：一律允许（桥已经用 config 决定策略，这里是自动化客户端）
    if (frame.method === 'session/request_permission' && frame.id != null) {
      const opts = frame.params?.options ?? []
      const allow = opts.find(o => /allow/i.test(o.optionId ?? '')) ?? opts[0]
      this.log(`acp: permission 请求 → 自动批准 ${allow?.optionId ?? '(none)'}`)
      this._send({ jsonrpc: '2.0', id: frame.id, result: { outcome: { outcome: 'selected', optionId: allow?.optionId ?? 'allow_once' } } })
      return
    }
    if (frame.id != null) {
      // 其它未知请求：回一个 method not found，别让 peer 等死
      this._send({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: `unsupported: ${frame.method}` } })
    }
  }

  _onUpdate (params) {
    if (!params) return
    const sessionId = params.sessionId
    const u = params.update
    if (!u) return
    for (const fn of this._onEvent) {
      try { fn(sessionId, u) } catch { /* ignore */ }
    }
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        const t = u.content?.text
        if (typeof t === 'string' && t) {
          const acc = this.partials.get(sessionId) ?? []
          acc.push(t)
          this.partials.set(sessionId, acc)
        }
        break
      }
      case 'tool_call': {
        // 记一下工具名，便于日志观察
        const name = u.title ?? u.toolCallId ?? 'tool'
        this.log(`acp: 工具调用 ${name}`)
        break
      }
      default:
        break
    }
  }

  _send (obj) {
    try { this.child?.stdin?.write(JSON.stringify(obj) + '\n') } catch { /* ignore */ }
  }

  _request (method, params, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      if (!this.child) return reject(new Error('acp runtime 未启动'))
      const id = this.nextId++
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} 超时 (${timeoutMs}ms)`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(err)
      }
    })
  }

  _failAll (err) {
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(err) }
    this.pending.clear()
    for (const waiters of this.turnWaiters.values()) {
      for (const w of waiters) { clearTimeout(w.timer); w.reject(err) }
    }
    this.turnWaiters.clear()
  }

  /**
   * 建/取 ACP 会话。
   * ⚠️ ACP 的 `session/new` **返回**它自己生成的 sessionId（客户端不能指定），
   *    所以这里维护 peerKey → acpSessionId 的映射；进程重启后映射清空，重新新建。
   */
  async _ensureSession (peerKey) {
    if (!this.ready) await this.start()
    const existing = this._peerSession.get(peerKey)
    if (existing) return existing

    // ① 先用历史记录里的 ACP sessionId 尝试 resume（保住上下文，别每次都从零开始）
    const remembered = this._remembered?.get(peerKey)
    if (remembered) {
      try {
        await this._request('session/resume', { sessionId: remembered, cwd: this.cwd }, 60000)
        this._peerSession.set(peerKey, remembered)
        this._acpToPeer.set(remembered, peerKey)
        this.log(`acp: 恢复会话 ${peerKey} -> ${remembered}`)
        await this._applyModel(remembered)
        return remembered
      } catch (err) {
        this.log(`acp: 恢复 ${remembered} 失败（新建）: ${String(err.message).slice(0, 120)}`)
      }
    }

    // ② 新建
    const res = await this._request('session/new', {
      cwd: this.cwd,
      mcpServers: this.mcpServers,
    }, this.startTimeoutMs)
    const acpSessionId = res?.sessionId
    if (!acpSessionId) throw new Error('session/new 没返回 sessionId')
    this._peerSession.set(peerKey, acpSessionId)
    this._acpToPeer.set(acpSessionId, peerKey)
    this.log(`acp: 新建会话 ${peerKey} -> ${acpSessionId}（mcpServers=${this.mcpServers.length}）`)
    await this._applyModel(acpSessionId)
    // 通知外面把映射存下来（桥负责落盘）
    this.log(`acp: 通知记账 onSessionCreated=${typeof this.onSessionCreated} ${peerKey} -> ${acpSessionId}`)
    try { this.onSessionCreated?.(peerKey, acpSessionId) } catch (e) { this.log(`记账回调异常: ${e.message}`) }
    return acpSessionId
  }

  /** 给一个 ACP 会话设模型路由。 */
  async _applyModel (acpSessionId) {
    try {
      await this._request('session/set_config_option', {
        sessionId: acpSessionId,
        configId: 'model',
        value: JSON.stringify([this.provider, this.model]),
      }, 30000)
      this.effectiveRoute = `${this.provider}/${this.model}`
    } catch (err) {
      this.log(`acp: 设置模型失败（用默认路由）: ${err.message}`)
    }
  }

  /**
   * 跑一轮：取/建 ACP 会话 → prompt（ACP 的 prompt 是阻塞的，返回即 turn 结束）→ 取合并文本。
   * @param {string} peerKey  桥侧的 peer 键（如 `group:1017567471`）
   * @param {Array<{type:'text',text:string}>} contentBlocks
   */
  async prompt (peerKey, contentBlocks) {
    if (!this.ready) await this.start()
    const acpSessionId = await this._ensureSession(peerKey)

    this.partials.set(acpSessionId, [])
    const t0 = Date.now()
    try {
      const res = await this._request('session/prompt', {
        sessionId: acpSessionId,
        prompt: contentBlocks,
      }, this.turnTimeoutMs)
      const text = (this.partials.get(acpSessionId) ?? []).join('')
      this.partials.delete(acpSessionId)
      this.log(`acp: 本轮结束 ${peerKey} ${Math.round((Date.now() - t0) / 1000)}s stopReason=${res?.stopReason ?? '?'} 长度=${text.length}`)
      return { text, reason: res?.stopReason ?? 'end_turn', raw: res }
    } catch (err) {
      this.partials.delete(acpSessionId)
      throw err
    }
  }
}

