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
   * @param {{mode?:'auto'|'allowlist'|'deny', allowed?:string[]}} [opts.toolPolicy]
   *        工具调用批准策略，见 _handleFrame 里 request_permission 的注释。
   */
  constructor({ bin, profile, cwd, provider, model, reasoningEffort, mcpServers = [], startTimeoutMs = 90000, turnTimeoutMs = 240000, remembered, onSessionCreated, patchFile, log, toolPolicy }) {
    // toolPolicy: 模型在 QQ 里请求工具权限时怎么批（auto/allowlist/deny）
    this.toolPolicy = toolPolicy ?? { mode: 'auto' }
    this._toolPolicyWarned = false
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
    // ── 启动失败退避（见 start() 的注释，2026-10-31 CPU 打满事故）────────────
    this._startAttempts = 0   // 连续失败次数（成功后清零）
    this._retryAt = 0         // 冷却结束时间戳（ms）；0 = 不在冷却
    this._lastStartError = null // 上次失败原因（给冷却期内的报错用）
    this._startupHint = null   // 从 stderr 里翻译出的「为什么起不来」（EADDRINUSE 之类）
  }

  onEvent (fn) {
    this._onEvent.push(fn)
    return () => { this._onEvent = this._onEvent.filter(f => f !== fn) }
  }

  /**
   * 启动 ACP 子进程（带**失败退避**）。
   *
   * 🔴 2026-10-31 修（真实事故：CPU 打满，4 分钟 99 次 spawn）：
   *   原来这里是
   *       if (this.startPromise) return this.startPromise
   *       this.startPromise = this._start().catch(err => { this.startPromise = null; throw err })
   *   —— 失败就把 startPromise 清掉，于是**下一次调用马上又全量 spawn 一遍**。
   *   `_ensureSession` / `prompt` 都是 `if (!this.ready) await this.start()`，
   *   而每次 spawn 失败后 ready 仍为 false，所以每条消息（甚至每次重试）
   *   都会重新拉起一个完整的 `dsh` 子进程：加载 9 个插件 → 撞端口 → exit 1。
   *   实测日志里 **99 次**「bridge 启动 + 99 次 dsh 启动」，CPU 直接顶满。
   *
   *   现在失败后进入冷却期（指数退避 5s → 10s → 20s → … 上限 5 分钟），
   *   冷却期内直接抛「上次失败」而**不再 spawn**。成功一次就重置退避。
   *
   *   为什么不是「失败一次就永久放弃」：失败可能是暂时的（宿主重启中、
   *   端口刚好被占）。永久放弃会让桥再也不响应；退避 + 上限才两头都对。
   */
  async start () {
    if (this.startPromise) return this.startPromise
    // 冷却期内：直接报上次的错误，别再去 spawn 一个注定失败的进程
    const remain = this._retryAt - Date.now()
    if (remain > 0) {
      throw new Error(this._lastStartError
        ? `上次启动失败，冷却中（还要等 ${Math.ceil(remain / 1000)}s）：${this._lastStartError}`
        : `上次启动失败，冷却中（还要等 ${Math.ceil(remain / 1000)}s）`)
    }
    this.startPromise = this._start()
      .then(init => {
        // 成功：清零退避，下次失败从最短间隔开始
        this._startAttempts = 0
        this._retryAt = 0
        this._lastStartError = null
        return init
      })
      .catch(err => {
        this.startPromise = null
        this._startAttempts += 1
        this._lastStartError = String(err?.message || err).slice(0, 300)
        // 退避：5s, 10s, 20s, 40s, 80s, 160s，封顶 5 分钟
        const delay = Math.min(5000 * (2 ** Math.min(6, this._startAttempts - 1)), 5 * 60 * 1000)
        this._retryAt = Date.now() + delay
        this.log(`acp: 启动失败第 ${this._startAttempts} 次，${Math.round(delay / 1000)}s 内不再重试（${this._lastStartError.slice(0, 160)}）`)
        throw err
      })
    return this.startPromise
  }

  async _start () {
    this.log(`acp: 启动 ${this.bin} --profile ${this.profile} (cwd=${this.cwd})`)
    this._startupHint = null  // 新一轮，清掉上次的 stderr 诊断
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
        // 🔴 把「为什么起不来」翻译成人话。
        //    真实事故（2026-10-31）日志里只有一行 `acp exited code=1`，
        //    看不出是 **profile 抢了宿主端口**。用户只能看到 CPU 打满却查不出原因。
        if (/EADDRINUSE/i.test(line)) {
          this._startupHint = `宿主端口被占（${line.trim().slice(0, 160)}）—— profile "${this.profile}" 会起 HTTP 服务，`
            + '和正在运行的 DSH 抢同一个端口。把设置页「高级 → ACP profile」留空（自动会落到 acp），或显式填 acp。'
          this.log(`acp: ${this._startupHint}`)
        } else if (/startup failed/i.test(line)) {
          this._startupHint = this._startupHint || `宿主启动失败：${line.trim().slice(0, 160)}`
        }
      }
    })

    child.on('exit', (code, signal) => {
      this.ready = false
      // 把「为什么退出」一并打出来：只有 code 的话，用户根本查不到根因
      const hint = this._startupHint ? ` —— ${this._startupHint}` : ''
      this.log(`acp: 进程退出 code=${code} signal=${signal}${hint}`)
      this._failAll(new Error(`acp exited (code=${code}, signal=${signal})${hint}`))
      this.child = null
      // ⚠️ 这里**不能**只把 startPromise 置 null 就完事：
      //    那样下一次 `if (!this.ready) await this.start()` 会立刻重新 spawn，
      //    而退避逻辑在 start() 里 —— 只有当 startPromise 为 null 时才会走进去，
      //    所以置 null 是必要的；真正防住雪崩的是 start() 里的 _retryAt 冷却。
      //    （2026-10-31 事故：这里置 null + start() 无退避 = 4 分钟 99 次 spawn。）
      this.startPromise = null
      this._peerSession.clear()
      this._acpToPeer.clear()
    })
    child.on('error', err => {
      this.log(`acp: spawn 错误 ${err.message}`)
      this.startPromise = null
      this._startupHint = `spawn 失败：${String(err?.message || err).slice(0, 200)}`
    })

    // 🔴 2026-11-01：**等 provider 注册完再 initialize**，否则图片能力会被误判成不可用。
    //
    //    真实事故：用户问「ds41f 不是支持图片吗」，但日志一直报
    //        acp: 图片输入 不可用（当前路由 trae/deepseek-v4.1-flash 没声明 image 输入）
    //    而宿主模型目录明明写着 inputModalities: ['text','image']。
    //
    //    根因在 dsh-acp 的 initialize 实现里：
    //        imagePromptEnabled = await supportsAcpImagePrompts(ctx, config.provider, config.model)
    //    它用 llm.resolveModelInfo(provider, model) 查该模型的 inputModalities。
    //    而桥**一 spawn 就立刻发 initialize** —— 这时第三方 provider 插件
    //    （dsh-our-free-model）还没把自己的 provider 注册进 llm，resolveModelInfo 抛错，
    //    supportsAcpImagePrompts 的 catch 吞掉 → 返回 false → **整个进程生命周期内
    //    图片都被判为不可用**（这个值在 initialize 时算一次就不再更新）。
    //
    //    实测证据（同一份配置，只改 initialize 的发送时机）：
    //        延迟 0ms    → image: false   ← 桥的现状
    //        延迟 3000ms → image: true
    //        延迟 6000ms → image: true
    //
    //    修法：initialize 前**轮询探测** provider 是否已就绪（不是傻等固定时间）。
    //    探测方式：直接问 llm 层的模型列表太绕，这里用「短 sleep + 重试 initialize」
    //    —— 但如果第一次 initialize 已经返回 image:false，**没有第二次机会**
    //    （值已被固定）。所以必须先等，不能先发。
    //
    //    等待上限取 startTimeoutMs 的一部分（默认 60s → 最多等 8s）。
    //    等不到就照常 initialize（宁可慢一点也不要卡死启动）。
    if (this.provider && this.model) {
      const waitMs = Math.min(8000, Math.max(1000, (this.startTimeoutMs || 60000) / 4))
      this.log(`acp: 等 provider 注册（最多 ${Math.round(waitMs/1000)}s，路由 ${this.provider}/${this.model}）`)
      await this._waitForProviderReady(waitMs)
    }
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
   * 等第三方 provider 注册完成（ACP 启动竞态）。
   *
   * 为什么只能「傻等」而不能探测：
   *   ACP 协议规定**第一条消息必须是 initialize**，在那之前客户端不能发别的请求。
   *   而 provider 是否就绪这件事，只有 llm 服务内部知道 —— 拿不到。
   *
   * 为什么要等：dsh-acp 的 initialize 里
   *     imagePromptEnabled = await supportsAcpImagePrompts(ctx, config.provider, config.model)
   * 它调 llm.resolveModelInfo(provider, model) 查 inputModalities。
   * 如果 provider 还没注册完，这次查询抛错 → catch 吞掉 → 返回 false，
   * 而**这个值在整个进程生命周期内不再更新** → 图片永久被判不可用。
   *
   * 实测（同一份配置，只改 initialize 时机）：
   *     500ms false / 1000ms false / 1500ms false / 2000ms false / **2500ms true**
   *
   * 所以等 3 秒是够的（留一点余量）。这 3 秒只花在**桥启动时**，不在每条消息上。
   *
   * @param {number} maxMs 最多等多久（失败也照常往下走，不能卡死启动）
   */
  async _waitForProviderReady (maxMs) {
    // 只有配了「非宿主内置」的 provider 才需要等：
    // 内置的 deepseek-official 由宿主自己注册，没有竞态。
    const builtin = new Set(['deepseek-official', 'deepseek-account'])
    if (builtin.has(String(this.provider || ''))) return

    // 实测就绪点约 2.5s；取 3s 留余量，且不超过调用方给的上限
    const waitMs = Math.min(maxMs, 3000)
    const t0 = Date.now()
    await new Promise(r => setTimeout(r, waitMs))
    this.log(`acp: 已等 ${Date.now() - t0}ms 让 provider 注册就绪（路由 ${this.provider}/${this.model}）`)
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
    // permission 请求：按 config.security.toolPolicy 决定。
    //
    // ⚠️ 默认 'auto' = 沿用旧行为（一律允许），因为宿主已经把 mcpServers 挂进来了，
    //    突然全部拒绝会让现有用户的所有工具（发消息/查B站/读文件）立刻报错。
    //    但旧行为是**静默**的：谁也不知道 QQ 群里一句「帮我读一下 D:\ 下的 xxx」
    //    就能让模型真的去调本机工具。所以这里至少给一条 WARN，并把决策写进日志。
    //
    // 三种模式（config.security.toolPolicy.mode）：
    //   auto      一律允许（默认，兼容旧配置）
    //   allowlist 只允许 toolPolicy.allowed 里匹配到的工具（按 toolCall 标题/kind 子串匹配）
    //   deny      一律拒绝
    if (frame.method === 'session/request_permission' && frame.id != null) {
      const opts = frame.params?.options ?? []
      const allow = opts.find(o => /allow/i.test(o.optionId ?? '')) ?? opts[0]
      const reject = opts.find(o => /reject|cancel|deny/i.test(o.optionId ?? '')) ?? null
      const policy = this.toolPolicy ?? { mode: 'auto' }
      const mode = policy.mode ?? 'auto'
      const tc = frame.params?.toolCall ?? {}
      const label = tc.title ?? tc.kind ?? tc.toolCallId ?? '(未命名工具)'
      const hay = `${label} ${tc.kind ?? ''} ${tc.toolCallId ?? ''}`
      let decision = 'allow'
      if (mode === 'deny') decision = 'deny'
      else if (mode === 'allowlist') {
        const list = Array.isArray(policy.allowed) ? policy.allowed : []
        decision = list.some(p => p && hay.toLowerCase().includes(String(p).toLowerCase())) ? 'allow' : 'deny'
      }
      if (decision === 'allow') {
        if (!this._toolPolicyWarned) {
          this._toolPolicyWarned = true
          const hint = mode === 'auto'
            ? '当前 toolPolicy=auto：模型在 QQ 里的任意工具调用都会被自动批准（可在 config.security.toolPolicy 收紧）'
            : `toolPolicy=${mode} 已放行 ${label}`
          this.log(`acp: ${hint}`)
        }
        this._send({ jsonrpc: '2.0', id: frame.id, result: { outcome: { outcome: 'selected', optionId: allow?.optionId ?? 'allow_once' } } })
        return
      }
      this.log(`acp: 拒绝工具调用 ${label}（toolPolicy=${mode}）`)
      if (reject) {
        this._send({ jsonrpc: '2.0', id: frame.id, result: { outcome: { outcome: 'selected', optionId: reject.optionId } } })
      } else {
        // 没有 reject 选项时用协议里的 cancelled，别让 agent 一直等
        this._send({ jsonrpc: '2.0', id: frame.id, result: { outcome: { outcome: 'cancelled' } } })
      }
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
        // 🔴 2026-11-01 真实事故：**恢复会话时必须重新挂 MCP，否则所有 MCP 工具全丢**。
        //
        //    现场：用户发了个视频，机器人回得完全不沾边。查会话原始记录发现
        //    turn 8 有一条 `tool-registry` 事件，一次性 **移除 39 个工具**
        //    （全是 `mcp__bilibili__*` 和 `mcp__storyboard__*`），新增 0 个。
        //    之后模型调 `bili_search` 直接报 `unknown tool`，
        //    只能退回用 `bash` 瞎猜 —— 所以它答不出视频内容。
        //
        //    根因就在这一行：原来只传 `{ sessionId, cwd }`，**没传 mcpServers**。
        //    而 `dsh-acp` 的 `AcpSession.resume()` 里是这么写的：
        //        await mountAcpMcpServers(agentCtx, options.mcpServers, options.cwd);
        //    传空数组 = 一个 MCP 都不挂 = 所有 MCP 工具消失。
        //
        //    而 `session/new` 那边**是传了的**（见下面 mcpServers: this.mcpServers），
        //    所以只有「恢复会话」这一路会丢 —— 这就是为什么它时好时坏：
        //    新会话正常，老 peer 只要恢复过一次就永久没工具了。
        //
        //    ⚠️ 这个 bug 特别难发现，因为：
        //      · 桥日志只记「恢复会话 xxx」，看不出工具没了；
        //      · 模型不会报错，它会**优雅地降级**（用 bash 猜），
        //        结果就是「答得很离谱」而不是「明确失败」。
        await this._request('session/resume', {
          sessionId: remembered,
          cwd: this.cwd,
          mcpServers: this.mcpServers,   // ← 就是这里漏了
        }, 60000)
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

