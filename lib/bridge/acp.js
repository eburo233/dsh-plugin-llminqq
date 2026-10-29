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
import fs from 'node:fs'
import path from 'node:path'
import { resolveDshCommand, spawnArgsFor } from '../find-dsh.js'

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
  constructor({ bin, profile, cwd, provider, model, reasoningEffort, mcpServers = [], startTimeoutMs = 90000, turnTimeoutMs = 240000, remembered, onSessionCreated, patchFile, log }) {
    // patchFile: 每次启动都会写的 --patch 叠加层（见 _writeRoutePatch）
    this.patchFile = patchFile ?? null
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
    this._configOptions = new Map() // acpSessionId -> session/new 公布的 configOptions
    this._acpToPeer = new Map() // acpSessionId -> peerKey
    // 哪些 provider/model 明确不接受图片输入（ACP 会回 invalid params）。
    // 记下来，后面的轮次就别再白白发一次图，省一次失败往返。
    this._noImageRoutes = new Set()
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
    // Windows 上 dsh 通常是 .cmd（npm 全局装的都是批处理外壳），
    // Node 的 spawn 不会自动补后缀、也不查 PATHEXT → 直接 ENOENT。
    // 所以先解析出「怎么启动它」，再按结果决定用不用 shell。
    //
    // profile 为空时也别传空参数（`--profile  ` 会让 dsh 报奇怪的错），
    // 直接省掉这个参数，让 dsh 用它自己的默认 profile。
    const profileArgs = this.profile ? ['--profile', this.profile] : []

    // 关键：acp profile 自带一个「默认模型路由」（dsh-acp 的 provider/model 配置）。
    // 它在 initialize 时用这个路由判断「本连接能不能收图片」，并把结论写进
    // agentCapabilities.promptCapabilities.image。而桥之后是用
    // session/set_config_option 改路由的 —— 那时 initialize 早跑完了。
    // 所以只要两边路由不一致（acp profile 默认 deepseek-official，插件配的是
    // deepseek-account），发图就会被 dsh-acp 回
    // `inline image prompts were not advertised by this connection`。
    // 解法：每次启动都写一份 --patch 覆盖，把 acp 的默认路由顶成插件配置的这条。
    const patchFile = this._writeRoutePatch()
    if (patchFile) {
      this.log(`acp: 路由 patch 已写到 ${patchFile}（provider=${this.provider} model=${this.model}）`)
      profileArgs.push('--patch', patchFile)
    }

    const resolved = resolveDshCommand(this.bin)
    if (resolved.kind === 'none') {
      this.log(`acp: 找不到 dsh —— ${resolved.reason}`)
      this.log(`acp: 试过：${resolved.tried.join(' | ')}`)
      this.log('acp: 去设置页「高级」里把 dsh 可执行文件路径填上（Windows 一般是 dsh.cmd 的完整路径）')
      throw new Error(`cannot find dsh: ${resolved.reason}`)
    }
    if (resolved.kind !== 'direct') this.log(`acp: ${resolved.reason}`)

    const sp = spawnArgsFor(resolved, profileArgs)
    const child = spawn(sp.cmd, sp.args, {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
      shell: sp.useShell,
      windowsHide: true,
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
    // 图片能力是 initialize 时按「默认路由」算死的，这里记一笔：
    // 发图不发得出去，看这一行就知道了。
    const caps = init?.agentCapabilities?.promptCapabilities ?? null
    this.imageInput = caps?.image === true
    this.log(caps
      ? `acp: 图片输入 ${this.imageInput ? '可用' : `不可用（当前路由 ${this.provider}/${this.model} 没声明 image 输入）`}`
      : 'acp: 图片输入未知（对端没公布 promptCapabilities）')
    return init
  }

  stop () {
    this.ready = false
    try { this.child?.kill('SIGTERM') } catch { /* ignore */ }
    setTimeout(() => { try { this.child?.kill('SIGKILL') } catch { /* ignore */ } }, 1500)
  }

  /**
   * 写一份 --patch 叠加层，把 acp profile 里 dsh-acp 插件的默认路由
   * 顶成桥正在用的那条（provider/model 来自 config.json）。
   * 只有默认路由能读到图片输入声明时，initialize 才会通告 image 能力。
   * 返回 patch 文件路径；没有 patchFile / 路由不全时返回 null（照旧启动）。
   */
  _writeRoutePatch () {
    if (!this.patchFile || !this.provider || !this.model) return null
    const yaml = [
      '# 由 llminqq 桥每次启动时重写，不要手改。',
      '# 目的：让 dsh-acp 的 initialize 用「桥真正在用的这条路由」来判断图片能力，',
      '# 否则发图会被回 inline image prompts were not advertised by this connection。',
      '- id: acp',
      '  config:',
      `    provider: ${JSON.stringify(this.provider)}`,
      `    model: ${JSON.stringify(this.model)}`,
      '',
    ].join('\n')
    try {
      fs.mkdirSync(path.dirname(this.patchFile), { recursive: true })
      const prev = fs.existsSync(this.patchFile) ? fs.readFileSync(this.patchFile, 'utf8') : ''
      if (prev !== yaml) fs.writeFileSync(this.patchFile, yaml)
      return this.patchFile
    } catch (err) {
      this.log(`acp: 写路由 patch 失败（照旧启动）：${err.message}`)
      return null
    }
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
    this._configOptions.set(acpSessionId, res?.configOptions || [])
    this.log(`acp: 新建会话 ${peerKey} -> ${acpSessionId}（mcpServers=${this.mcpServers.length}）`)
    await this._applyModel(acpSessionId)
    // 通知外面把映射存下来（桥负责落盘）
    this.log(`acp: 通知记账 onSessionCreated=${typeof this.onSessionCreated} ${peerKey} -> ${acpSessionId}`)
    try { this.onSessionCreated?.(peerKey, acpSessionId) } catch (e) { this.log(`记账回调异常: ${e.message}`) }
    return acpSessionId
  }

  /** 给一个 ACP 会话设模型路由。
   *
   * ⚠️ 这里不能闭着眼睛发：`session/new` 会公布一份 **configOptions(select)**，
   *    里面才是这个宿主真的能用 `provider/model` 组合（host 侧的模型目录和
   *    ACP 子进程里公布的不是同一份，子进程会按自己有没有凭据过滤）。
   *    发一个不在清单里的值会拿到 `-32602 unknown model option`，然后静默
   *    回落到会话默认 —— 表现就是「设置页写着 A，实际跑的是 B」。
   *    所以先在清单里查一遍，查不到就把可选项打进日志。 */
  async _applyModel (acpSessionId) {
    const want = JSON.stringify([this.provider, this.model])
    const modelOpt = this._configOptions.get(acpSessionId)?.find?.(o => o.id === 'model')
    if (modelOpt) {
      const flat = []
      for (const group of modelOpt.options || []) {
        for (const opt of group.options || []) flat.push({ value: opt.value, label: this._labelOfRoute(opt.value) })
      }
      if (flat.length && !flat.some(o => o.value === want)) {
        const list = flat.map(o => o.label).join('、')
        this.effectiveRoute = this._labelOfRoute(modelOpt.currentValue)
        this.log(`acp: 配置的路由 ${this.provider}/${this.model} 不在宿主给 ACP 的清单里（可用：${list}），沿用 ${this.effectiveRoute}`)
        return
      }
    }
    try {
      await this._request('session/set_config_option', {
        sessionId: acpSessionId,
        configId: 'model',
        value: want,
      }, 30000)
      this.effectiveRoute = `${this.provider}/${this.model}`
    } catch (err) {
      this.log(`acp: 设置模型失败（用默认路由）: ${err.message}`)
    }
  }

  /** `["provider","model"]` → `provider/model`（只用于日志，解析失败就原样返回）。 */
  _labelOfRoute (value) {
    try {
      const [p, m] = JSON.parse(value)
      return `${p}/${m}`
    } catch {
      return String(value ?? '')
    }
  }

  /**
   * 跑一轮：取/建 ACP 会话 → prompt（ACP 的 prompt 是阻塞的，返回即 turn 结束）→ 取合并文本。
   *
   * 图片：ACP v1 的 prompt 支持 `{type:'image', data:base64, mimeType}` 内容块，
   * 宿主会把它存成 attachment 直接喂给模型（真·看图，不用模型去调 read_image）。
   * 但**不是所有模型都吃图** —— 不吃的时候 dsh-acp 会抛 `model "x" does not
   * declare image input`（invalid）。所以这里带一次自适应：失败就去掉图片重发，
   * 并把该路由记进 _noImageRoutes，后续轮次不再重复试。
   *
   * @param {string} peerKey  桥侧的 peer 键（如 `group:2000000001`）
   * @param {Array<{type:'text',text:string}|{type:'image',data:string,mimeType:string}>} contentBlocks
   */
  async prompt (peerKey, contentBlocks) {
    if (!this.ready) await this.start()
    const acpSessionId = await this._ensureSession(peerKey)
    const routeKey = `${this.provider}/${this.model}`

    const hasImages = contentBlocks.some(b => b.type === 'image')
    let blocks = contentBlocks
    if (hasImages && this._noImageRoutes.has(routeKey)) {
      const n = contentBlocks.filter(b => b.type === 'image').length
      blocks = contentBlocks.filter(b => b.type !== 'image')
      this.log(`acp: ${routeKey} 之前已确认不吃图，本轮 ${n} 张图只留文字`)
    }

    const t0 = Date.now()
    const runTurn = async (payload) => {
      this.partials.set(acpSessionId, [])
      const res = await this._request('session/prompt', { sessionId: acpSessionId, prompt: payload }, this.turnTimeoutMs)
      return { res, text: (this.partials.get(acpSessionId) ?? []).join('') }
    }

    try {
      let out
      try {
        out = await runTurn(blocks)
      } catch (err) {
        const triedImages = blocks.some(b => b.type === 'image')
        if (!triedImages || !/image/i.test(String(err.message))) throw err
        // 模型不吃图：去掉图片，补一句诚实的提示，再跑一次
        this._noImageRoutes.add(routeKey)
        this.log(`acp: ${routeKey} 不接受图片输入（${String(err.message).slice(0, 120)}），去掉图片重试`)
        const textOnly = blocks.filter(b => b.type !== 'image')
        textOnly.push({
          type: 'text',
          text: '（提醒：当前模型不支持图片输入，你看不到用户发的图片内容。别猜图里是什么，需要的话就直说「我这模型看不了图」。）',
        })
        out = await runTurn(textOnly)
      }
      const { res, text } = out
      this.log(`acp: 本轮结束 ${peerKey} ${Math.round((Date.now() - t0) / 1000)}s stopReason=${res?.stopReason ?? '?'} 长度=${text.length}`)
      return { text, reason: res?.stopReason ?? 'end_turn', raw: res }
    } finally {
      this.partials.delete(acpSessionId)
    }
  }
}

