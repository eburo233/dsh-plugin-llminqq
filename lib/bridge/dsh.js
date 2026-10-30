// DSH SDK (JSON-RPC over stdio) 客户端：spawn 一个 dsh --profile <profile>，
// 用它开持久会话、收事件、拿回复。协议见 @deepseek-ai/dsh-sdk-protocol。

import { spawn } from 'node:child_process'
import { resolveDshCommand, spawnArgsFor } from '../find-dsh.js'

export class DshRuntime {
  constructor({ bin, profile, cwd, provider, model, reasoningEffort, startTimeoutMs = 60000, turnTimeoutMs = 180000, promptRequestTimeoutMs = 30000, log }) {
    this.bin = bin
    this.profile = profile
    this.cwd = cwd
    this.provider = provider
    this.model = model
    this.reasoningEffort = reasoningEffort
    this.startTimeoutMs = startTimeoutMs
    this.turnTimeoutMs = turnTimeoutMs
    // `session/prompt` 的「受理」超时（不是整轮超时）：超时就必须 reject 外层调用方，
    // 不能让 await dsh.prompt(...) 永远挂住
    this.promptRequestTimeoutMs = promptRequestTimeoutMs
    this.log = log ?? (() => {})

    this.child = null
    this.ready = false
    this.nextId = 1
    this.pending = new Map() // id -> {resolve, reject, timer}
    this.partials = new Map() // sessionId -> 累积的 assistant 文本
    this.turnWaiters = new Map() // sessionId -> [{resolve, reject, timer, text:[]}]
    this.lastError = null
    this._resumed = new Set() // 已尝试 resume 过的 sessionId，避免每轮重复请求
    this.startPromise = null
    this._onEvent = [] // 外部订阅
  }

  onEvent(fn) {
    this._onEvent.push(fn)
    return () => { this._onEvent = this._onEvent.filter(f => f !== fn) }
  }

  /**
   * 运行时切换模型路由（失败时自动重连 dsh 进程，新路由在下一轮生效）。
   * @param {{provider:string, model:string, reasoningEffort?:string|null}} route
   */
  async switchRoute(route) {
    const same = route.provider === this.provider && route.model === this.model
    this.provider = route.provider
    this.model = route.model
    this.reasoningEffort = route.reasoningEffort ?? null
    this.effectiveEffort = null
    this._resumed.clear()
    this.log(`dsh: 切换路由 -> ${this.provider}/${this.model}`)
    if (same) return
    // 换路由必须重启 dsh 进程：SDK 的 initialize 只在启动时接受一次
    this.stop()
    await new Promise(r => setTimeout(r, 1200))
    this.startPromise = null
    this.ready = false
    await this.start()
  }

  async start() {
    if (this.startPromise) return this.startPromise
    this.startPromise = this._start().catch(err => {
      this.startPromise = null
      throw err
    })
    return this.startPromise
  }

  async _start() {
    const profileArgs = this.profile ? ['--profile', this.profile] : []
    const resolved = resolveDshCommand(this.bin)
    const sp = spawnArgsFor(resolved, profileArgs)
    this.log(`dsh: 启动 ${sp.cmd} ${sp.args.join(' ')} (cwd=${this.cwd})`)
    const child = spawn(sp.cmd, sp.args, {
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
          this.log(`dsh: 非 JSON stdout 行: ${line.slice(0, 200)}`)
          continue
        }
        this._handleFrame(frame)
      }
    })
    // stderr 是 dsh 的诊断输出，折叠成一行一条
    let ebuf = ''
    child.stderr.on('data', chunk => {
      ebuf += chunk.toString('utf8')
      let idx
      while ((idx = ebuf.indexOf('\n')) >= 0) {
        const line = ebuf.slice(0, idx).replace(/\s+$/, '')
        ebuf = ebuf.slice(idx + 1)
        if (line) this.log(`dsh[stderr]: ${line.slice(0, 400)}`)
      }
    })
    child.on('exit', (code, signal) => {
      this.ready = false
      this.log(`dsh: 进程退出 code=${code} signal=${signal}`)
      this._failAll(new Error(`dsh exited (code=${code}, signal=${signal})`))
      this.child = null
      this.startPromise = null
    })
    child.on('error', err => {
      this.log(`dsh: spawn 错误 ${err.message}`)
      this.startPromise = null
    })

    // 模型目录（our-free-model 每 15 分钟探测一次）刷新窗口内，同一 route 的
    // reasoningEffort 支持情况会短暂变化，直接报 UNSUPPORTED_REASONING_EFFORT。
    // 这时绝不能整轮对话失败——按「原 effort → 无 effort → 依次降级」重试。
    const efforts = []
    if (this.reasoningEffort) efforts.push(this.reasoningEffort)
    efforts.push(undefined)
    for (const eff of ['medium', 'low']) {
      if (eff !== this.reasoningEffort) efforts.push(eff)
    }
    // 去重（保持顺序）
    const tried = []
    for (const e of efforts) if (!tried.includes(e)) tried.push(e)

    let init = null
    let lastErr = null
    for (const eff of tried) {
      try {
        init = await this._request('initialize', {
          cwd: this.cwd,
          provider: this.provider,
          model: this.model,
          ...(eff ? { reasoningEffort: eff } : {}),
        }, this.startTimeoutMs)
        if (eff !== this.reasoningEffort) {
          this.log(`dsh: reasoningEffort "${this.reasoningEffort}" 被拒，已降级为 ${eff ?? '(不指定)'} 继续`)
          this.effectiveEffort = eff ?? null
        } else {
          this.effectiveEffort = eff
        }
        break
      } catch (err) {
        lastErr = err
        // 实际消息形如 `does not support reasoning effort "high"`，不一定带错误码名
        if (!/reasoning.?effort|REASONING_EFFORT/i.test(String(err?.message))) throw err
        this.log(`dsh: reasoningEffort "${eff ?? '(不指定)'}" 不可用，尝试下一档`)
      }
    }
    if (!init) throw lastErr ?? new Error('initialize failed')
    this.ready = true
    this.log(`dsh: 初始化完成 server=${init?.serverInfo?.name ?? '?'} v${init?.serverInfo?.version ?? '?'} route=${this.provider}/${this.model} effort=${this.effectiveEffort ?? '(默认)'}`)
    return init
  }

  stop() {
    this.ready = false
    try { this.child?.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method: 'shutdown' }) + '\n') } catch { /* ignore */ }
    setTimeout(() => { try { this.child?.kill('SIGTERM') } catch { /* ignore */ } }, 500)
  }

  _handleFrame(frame) {
    if (frame.id != null && frame.method == null) {
      const p = this.pending.get(frame.id)
      if (!p) return
      clearTimeout(p.timer)
      this.pending.delete(frame.id)
      if (frame.error) p.reject(new Error(`${frame.error.message ?? 'rpc error'} (code ${frame.error.code ?? '?'})`))
      else p.resolve(frame.result)
      return
    }
    if (frame.method === 'session.event') return this._onSessionEvent(frame.params)
    if (frame.method === 'session.status') return
    if (frame.method === 'subagent.started' || frame.method === 'subagent.finished') return
  }

  _onSessionEvent(params) {
    const { sessionId, event } = params ?? {}
    if (!sessionId || !event) return
    for (const fn of this._onEvent) {
      try { fn(sessionId, event) } catch { /* ignore */ }
    }
    if (event.type === 'assistant/message') {
      const msg = event.data?.message
      const text = blocksToText(msg?.content)
      if (text) {
        const acc = this.partials.get(sessionId) ?? []
        acc.push(text)
        this.partials.set(sessionId, acc)
      }
      return
    }
    if (event.type === 'turn/end') {
      const waiters = this.turnWaiters.get(sessionId)
      if (!waiters?.length) return
      this.turnWaiters.delete(sessionId)
      const reason = event.data?.reason?.kind ?? 'unknown'
      const text = (this.partials.get(sessionId) ?? []).join('\n')
      this.partials.delete(sessionId)
      for (const w of waiters) {
        clearTimeout(w.timer)
        if (reason === 'completed' || reason === 'max-tokens' || reason === 'max-steps') w.resolve({ text, reason, raw: event })
        else w.reject(Object.assign(new Error(`turn ended: ${reason}`), { turnReason: reason, text }))
      }
    }
  }

  _request(method, params, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      if (!this.child) return reject(new Error('dsh runtime 未启动'))
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

  _failAll(err) {
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(err) }
    this.pending.clear()
    for (const waiters of this.turnWaiters.values()) {
      for (const w of waiters) { clearTimeout(w.timer); w.reject(err) }
    }
    this.turnWaiters.clear()
  }

  /**
   * 在一个持久会话里跑一轮：发 prompt，等 turn/end，返回合并后的助手文本。
   * @param {string} sessionId
   * @param {Array<{type:'text',text:string}|{type:'image',data:string,mimeType:string}>} contentBlocks
   */
  async prompt(sessionId, contentBlocks) {
    if (!this.ready) await this.start()

    // 桥重启后，磁盘上记着旧 sessionId；如果这个 dsh 进程里该 session 已被占住
    // （比如上一轮还在跑、或本进程内已恢复过），`session/prompt` 会报
    // `session "…" already exists`。这里先尝试 resume（幂等恢复持久会话），
    // 若报 already exists 就说明本进程已持有它，直接继续即可。
    if (!this._resumed.has(sessionId)) {
      try {
        await this._request('session/resume', { sessionId }, 30000)
        this.log(`dsh: 已恢复持久会话 ${sessionId}`)
      } catch (err) {
        const msg = String(err?.message || '')
        if (/already exists|already owned|occupied/i.test(msg)) {
          this.log(`dsh: 会话 ${sessionId} 已在本进程内，直接续用`)
        } else if (/not found|missing|no stored|incompatible|unknown/i.test(msg)) {
          // 全新会话（第一次聊），prompt 会自己创建，无需 resume
          this.log(`dsh: 会话 ${sessionId} 无历史，将新建`)
        } else {
          this.log(`dsh: resume ${sessionId} 失败（继续尝试 prompt）: ${msg}`)
        }
      }
      this._resumed.add(sessionId)
    }

    // 清掉残留累积，避免上一轮未收尾的文本混进来
    this.partials.delete(sessionId)
    const startedAt = Date.now()
    const waiter = new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null }
      entry.timer = setTimeout(() => {
        const cur = this.turnWaiters.get(sessionId) ?? []
        const rest = cur.filter(w => w.timer !== entry.timer)
        if (rest.length) this.turnWaiters.set(sessionId, rest)
        else this.turnWaiters.delete(sessionId)
        reject(new Error(`turn 超时 (${this.turnTimeoutMs}ms, session=${sessionId}, 已等待 ${Date.now() - startedAt}ms)`))
      }, this.turnTimeoutMs)
      const list = this.turnWaiters.get(sessionId) ?? []
      list.push(entry)
      this.turnWaiters.set(sessionId, list)
    })
    // 失败路径上 waiter 可能没人 await（prompt() 先抛了），挂个空 catch，
    // 免得它被 reject 时触发 unhandledRejection（桥会记一条 ERROR）。
    waiter.catch(() => {})

    // 受理超时：session/prompt 的 30s 上限 + 显式超时 promise 竞速。
    // 之前只从 turnWaiters 里删项、不给 waiter 结算，外层 `await dsh.prompt(...)`
    // 就永远挂住了；现在超时/失败都走同一段清理，并 reject 调用方。
    let acceptTimer = null
    const accept = this._request('session/prompt', { sessionId, contentBlocks }, this.promptRequestTimeoutMs)
    const timeout = new Promise((_, reject) => {
      acceptTimer = setTimeout(() => {
        reject(Object.assign(
          new Error(`prompt timeout (${this.promptRequestTimeoutMs}ms) session=${sessionId} 已等待 ${Date.now() - startedAt}ms`),
          { code: 'PROMPT_TIMEOUT', sessionId },
        ))
      }, this.promptRequestTimeoutMs)
    })
    try {
      await Promise.race([accept, timeout])
    } catch (err) {
      this._dropTurnWaiters(sessionId, err)
      throw err
    } finally {
      clearTimeout(acceptTimer)
    }
    return waiter
  }

  /** 清掉某会话的全部等待者（超时/失败路径）：清定时器 + reject，不留永远 pending 的状态。 */
  _dropTurnWaiters(sessionId, err = null) {
    const list = this.turnWaiters.get(sessionId)
    if (!list) return
    this.turnWaiters.delete(sessionId)
    for (const w of list) {
      clearTimeout(w.timer)
      w.reject(err ?? Object.assign(new Error(`prompt 已放弃 (session=${sessionId})`), { code: 'PROMPT_ABANDONED', sessionId }))
    }
  }
}

/** 把 ContentBlock[] 拍平成纯文本（只取 text 块）。 */
export function blocksToText(content) {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : ''
  const out = []
  for (const b of content) {
    if (b?.type === 'text' && typeof b.text === 'string') out.push(b.text)
  }
  return out.join('\n').trim()
}
