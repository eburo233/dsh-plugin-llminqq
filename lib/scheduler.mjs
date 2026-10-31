// lib/scheduler.mjs —— 桥内定时任务（反思 / 学习），替代 systemd timer
// ============================================================================
// 背景：脚本版靠 `~/.config/systemd/user/llminqq-{reflect,learn}.{service,timer}`。
// 插件版不能要求用户装 systemd（Windows/macOS/桌面版都没有），所以任务要跑在
// 桥**进程内**。
//
// ⚠️ 为什么「进程内」不等于「塞进事件循环里跑」：
//   反思一轮 2-6 分钟、学习一轮 10-20 分钟，还都要调 LLM。
//   如果在事件循环里 await，桥就**不能回消息了** —— 这是绝对不能接受的。
//   所以：**定时器在进程内，任务本体 spawn 成子进程**。
//   spawn 是异步的，await 它只占一个 promise，不占 CPU，消息照常收发。
//
// ⚠️ 为什么可以放弃 systemd 的「错过补跑」：
//   reflect.sh 用的是 REFLECT_HOURS=168（一周窗口）兜积压 —— 就算机器关机
//   两天没跑，下次启动跑一轮也能把这两天的记忆全扫进来（已提炼的打过标记，
//   不会重复）。所以**不需要 OS timer 补齐**，只需要「启动后别立刻跑、别重复跑」。
//   这是能砍掉 systemd 依赖的关键论据，不是偷懒。
//
// 四条纪律（每条都对应一个真实会踩的坑）：
//   ① **启动抖动 ±30min**：多个实例（比如用户同时开着 DSH 和旧脚本版）
//      不能在同一秒一起起 python 抢同一个库；
//   ② **lastRunAt 持久化**：否则每次重启（改配置、升级、崩溃重启）都会立刻
//      重跑一轮 —— 用户体验是「一重启就要等 10 分钟记忆才安静」；
//   ③ **并发锁**：一轮没跑完不能起下一轮（反思一轮可能就超过 8 小时的一半）；
//   ④ **子进程要能被杀**：插件卸载/桥退出时必须 SIGTERM 掉正在跑的 python，
//      否则 `ps aux | grep memctl` 会攒下一堆孤儿（脚本版踩过，见 PLUGINIZATION-PLAN §9）。
// ============================================================================
import fs from 'node:fs'
import path from 'node:path'
import { runMemoryAsync, summarizeRun } from './agent/memory-run.mjs'

/** 默认任务表。intervalMin 是「多久跑一次」，jitterMin 是启动抖动窗口。 */
export const DEFAULT_TASKS = {
  // 抓取：把桥日志里的「入站/出站」行吃进 mem.db（情节记忆）。
  // ⚠️ 这个任务原来是**缺的** —— 脚本版靠 systemd timer 跑 `memctl ingest`，
  //    插件化时只搬了 reflect/learn，于是 ingest 从没被调度过：
  //    表现为「消息正常收发、记忆页永远 0 条、mem.db 从不出现」（用户实测两台机器都这样）。
  //    5 分钟一轮：ingest 是纯本地 sqlite 写入，带游标增量，开销很小。
  ingest: {
    enabled: true,
    tool: 'memctl',
    args: ['ingest'],
    intervalMin: 5,
    timeoutMs: 2 * 60 * 1000,
  },
  // 反思：情节记忆 → 语义记忆。8 小时一次（脚本版 reflect.timer 是 02/10/18 点）。
  // hours=168 见文件头注释：一周窗口兜积压，不用 systemd 补跑。
  reflect: {
    enabled: true,
    tool: 'memctl',
    args: ['reflect', '--hours', '168'],
    intervalMin: 8 * 60,
    timeoutMs: 30 * 60 * 1000,
  },
  // 摘要：把 mem.db 里**按人分节**的记忆渲染成 digest.md。
  //
  // ⚠️ 这个任务原来也是**缺的**，和 ingest 同一个毛病：脚本版靠手工跑
  //    `memctl digest`，插件化时没人调度它，于是：
  //      · digest.md 从不存在（首次导入 844 条记忆后仍然是空的）
  //      · 桥的 memoryRecallBlock 读 digest 走 `if (!existsSync) return ''`，
  //        静默降级成空 —— 用户看不到任何异常，但「群级背景 / 程序记忆」那一段
  //        永远是空的，只有按人检索在干活。
  //
  // 为什么单独排一个任务、而不是挂到 reflect 后面：
  //   · reflect 8 小时一次，而 ingest 5 分钟一次。digest 挂 reflect 上，
  //     摘要最多会**落后 8 小时**；用户在设置页看到「记忆 844 条」，
  //     但桥注入的摘要还是早上的。
  //   · digest 是纯本地计算（实测 14ms @ 844 条），不调 LLM、不走网络，
  //     排密一点几乎零成本。
  //   30 分钟：比 ingest（5 分钟）慢，保证摘要不会比库里数据新太多；
  //   又比 reflect 快得多，反思刚提炼出的语义记忆半小时内就能进摘要。
  digest: {
    enabled: true,
    tool: 'memctl',
    args: ['digest'],
    intervalMin: 30,
    timeoutMs: 2 * 60 * 1000,
    // 产物不存在时，启动就补一次而不是等满 30 分钟（见 start() 里的说明）。
    // 桥读不到 digest 是**静默降级**，用户不会看到任何异常，所以这里必须主动补。
    runIfMissing: true,
    missingPath: ({ stateDir }) => path.join(stateDir, 'digest.md'),
  },
  // 学习：从语料里学说话方式 → lexicon.json。12 小时一次（语料更新没那么快，
  // 学太勤只是把同一批词反复确认）。
  learn: {
    enabled: true,
    tool: 'lexicon',
    // 池子存在就吃池子，不存在 learn 自己会降级成「只学本群语料」
    args: ['learn'],
    intervalMin: 12 * 60,
    timeoutMs: 30 * 60 * 1000,
  },
}

const LAST_RUN_FILE = 'scheduler.json'
/** 错误信息进状态文件/status() 前的截断长度（堆栈可能有几 KB，别把 state 撑大）。 */
export const LAST_ERROR_MAX = 500
/** status() 里 lastError 的展示长度。 */
const STATUS_ERROR_MAX = 300

/**
 * 任务调度器。
 *
 * @param {object} opts
 * @param {object} opts.cfg         插件配置（readConfig()）
 * @param {object} opts.probe       probePython() 结果（不可用时全部任务跳过，不再反复探测）
 * @param {string} opts.stateDir    状态/数据目录（lastRunAt 落这里）
 * @param {(m:string)=>void} opts.log
 * @param {(m:string)=>void} opts.warn
 * @param {object} [opts.tasks]     覆盖默认任务表（测试用它把间隔改小）
 * @param {()=>number} [opts.now]  可注入时钟（测试用，不 sleep 真实时间）
 * @param {Function} [opts.run]    跑一次任务的实现（默认 runMemoryAsync；测试注入用）
 */
export function createScheduler ({ cfg = {}, probe, stateDir, log = () => {}, warn = () => {}, tasks = null, now = Date.now, bridgeLog = '', run = runMemoryAsync }) {
  const featureOn = cfg?.features?.scheduler !== false
  const stateFile = path.join(stateDir, LAST_RUN_FILE)
  const taskTable = { ...DEFAULT_TASKS, ...(tasks || {}) }

  /** lastRunAt 持久化：重启后不要立刻重跑（纪律 ②） */
  function readState () {
    try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')) } catch { return {} }
  }
  function writeState (patch) {
    let cur = {}
    try { cur = readState() } catch { cur = {} }
    const next = { ...cur, ...patch, updatedAt: Date.now() }
    try { fs.writeFileSync(stateFile, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 }) } catch (err) {
      warn(`scheduler: 写状态失败（不影响任务）: ${err.message}`)
    }
    return next
  }

  const handles = new Map() // name -> {timer, child, running, lastResult}
  let stopped = false

  /** 跑一个任务（异步，不阻塞事件循环 —— 见文件头注释） */
  async function runTask (name, { manual = false } = {}) {
    const t = taskTable[name]
    if (!t) return { ok: false, reason: `未知任务 ${name}` }
    const h = handles.get(name) || {}
    // 纪律 ③：并发锁。上一轮没跑完就别起下一轮（反思一轮可能超过间隔的一半）
    if (h.running) {
      log(`scheduler: ${name} 上一轮还在跑，跳过本次`)
      return { ok: false, reason: '上一轮未结束', skipped: true }
    }
    if (!probe?.ok) {
      // 无 python：明确记一条「跳过」，而不是报错（PLUGINIZATION-PLAN 验收要求）
      const reason = probe?.reason || 'python 不可用'
      log(`scheduler: ${name} 跳过（${reason}）`)
      writeState({ [name]: { lastSkippedAt: now(), reason } })
      return { ok: false, reason, skipped: true }
    }
    const startedAt = now()
    log(`scheduler: ${name} 开始（${t.tool} ${t.args.join(' ')}）`)
    h.running = true
    handles.set(name, h)
    let res = null
    let thrown = null
    // ⚠️ try/catch/finally 是**必须的**，不是风格问题：
    //   旧实现在 `await runMemoryAsync(...)` 与 `h.running = false` 之间裸奔，
    //   一旦 promise reject（spawn 同步抛错、实现里 bug…），running 永远是 true，
    //   这个任务此后每一轮都被并发锁静默跳过，而 status() 还一直显示 running ——
    //   用户看到的是「记忆/学习任务某天开始再也不跑了」，且没有任何错误日志。
    try {
      res = await run({
        cfg, probe, tool: t.tool, args: t.args,
        timeoutMs: t.timeoutMs, stateDir,
        // 显式告诉 python 桥日志在哪：memctl ingest 只认这个变量，
        // 不传就会去 stateDir/bridge.out 找一个不存在的文件 → 「新增 0 条」永远静默。
        env: bridgeLog ? { LLMINQQ_BRIDGE_LOG: bridgeLog } : null,
        onChild: child => { h.child = child },
      })
    } catch (err) {
      // 异常要吞掉并记录：定时器回调里再抛会变成 unhandled rejection，
      // 而且「这一轮失败」不等于「这个任务以后别跑了」。
      thrown = err
      const detail = String(err?.stack || err?.message || err)
      h.lastError = detail.slice(0, LAST_ERROR_MAX)
      h.lastErrorAt = now()
      warn(`scheduler: ${name} 抛错（本轮失败，下轮照常）: ${detail.split('\n')[0].slice(0, 200)}`)
    } finally {
      // 无论成功/失败/抛错都必须复位；lastRunAt/lastDurationMs 也在这里记，
      // 保证 status() 看到的运行态与实际一致（不会出现 running 永远 true）。
      h.running = false
      h.child = null
      h.lastRunAt = startedAt
      h.lastDurationMs = Math.max(0, now() - startedAt)
      handles.set(name, h)
    }
    const entry = thrown
      ? {
          lastRunAt: startedAt, lastFinishedAt: now(), ok: false, kind: 'throw',
          reason: `异常：${String(thrown?.message || thrown).slice(0, 200)}`,
          ms: h.lastDurationMs, summary: `异常：${String(thrown?.message || thrown).slice(0, 160)}`,
          lastError: h.lastError, lastErrorAt: h.lastErrorAt,
        }
      : {
          lastRunAt: startedAt, lastFinishedAt: now(), ok: res.ok, kind: res.kind || null,
          reason: res.reason || '', ms: res.ms || 0, summary: summarizeRun(t.tool, res),
          lastError: res.ok ? '' : String(res.reason || '').slice(0, LAST_ERROR_MAX),
          lastErrorAt: res.ok ? null : now(),
        }
    // 统一维护「最近一次错误」：解析式失败（子进程非 0 退出）和抛错都要能在
    // status() 里看到，而不是只存在于一行日志里。
    if (!entry.ok) {
      h.lastError = entry.lastError || entry.reason || '未知错误'
      h.lastErrorAt = entry.lastErrorAt || now()
    }
    h.lastResult = entry
    handles.set(name, h)
    writeState({ [name]: entry })
    if (entry.ok) log(`scheduler: ${name} 完成（${(entry.ms / 1000).toFixed(0)}s）· ${entry.summary}`)
    else if (entry.kind === 'unavailable') log(`scheduler: ${name} 跳过（${res.reason}）`)
    // 抛错在 catch 里已经 warn 过一次，这里别刷第二遍
    else if (!thrown) warn(`scheduler: ${name} 失败（${(entry.ms / 1000).toFixed(0)}s）: ${res.reason}${res.stderr ? ` / ${String(res.stderr).trim().split('\n').pop()?.slice(0, 120)}` : ''}`)
    return { ...entry, skipped: false, manual }
  }

  /** 排下一轮：按 intervalMin + 启动抖动（纪律 ①） */
  function schedule (name) {
    if (stopped) return
    const t = taskTable[name]
    if (!t?.enabled) return
    const h = handles.get(name) || {}
    const intervalMs = Math.max(1000, Number(t.intervalMin) * 60000)
    // 抖动：只在**首次**排程时加（之后按固定间隔走，否则间隔会漂）
    const seedJitter = h.scheduledOnce ? 0 : (Number(t.jitterMin ?? 30) * 60000) * Math.random()
    const waitMs = h.scheduledOnce ? intervalMs : Math.min(intervalMs, seedJitter + 1000)
    h.scheduledOnce = true
    if (h.timer) clearTimeout(h.timer)
    h.timer = setTimeout(() => {
      // 上一轮还没结束（missed run）：旧实现是交给 runTask 内部 return，
      // 用户只能看到一行 log，然后「这轮就没了」。现在至少留一条 warn + 计数，
      // 设置页的 status() 能看到「因为上一轮没跑完，累计跳过了几次」。
      const cur = handles.get(name) || h
      if (cur.running) {
        cur.skippedCount = (cur.skippedCount ?? 0) + 1
        warn(`scheduler: ${name} 本轮跳过（上一轮仍在运行，累计跳过 ${cur.skippedCount} 次）`)
        handles.set(name, cur)
        schedule(name)
        return
      }
      runTask(name).catch(err => warn(`scheduler: ${name} 异常 ${err.message}`))
      schedule(name)
    }, waitMs)
    h.nextAt = now() + waitMs
    h.timer.unref?.() // 绝不因为这个定时器让进程不退出
    handles.set(name, h)
  }

  return {
    /** 启动：只排程，不立即跑（纪律 ②：重启不该立刻重跑一轮） */
    start () {
      if (!featureOn) { log('scheduler: features.scheduler=false，定时任务未启用'); return false }
      const enabled = Object.entries(taskTable).filter(([, t]) => t?.enabled).map(([n]) => n)
      if (!enabled.length) { log('scheduler: 没有启用的任务'); return false }
      log(`scheduler: 已启用 ${enabled.join('/')}`
        + (probe?.ok ? `（python ${probe.bin} ${probe.version}）` : `（⚠️ python 不可用：${probe?.reason}，任务会跳过）`))
      for (const n of enabled) schedule(n)

      // ── 「产出物缺失就立刻补一次」────────────────────────────────────────────
      //
      // 纪律 ② 是「重启不该立刻重跑一轮」，那条针对的是**昂贵且幂等**的任务
      // （reflect 一轮 2-6 分钟、learn 10-20 分钟，白跑纯粹浪费）。
      //
      // 但 digest 不是这类任务：它是 14ms 的纯本地渲染，而且**产物不存在时
      // 桥读它就是空字符串**（memoryRecallBlock 里 `if (!existsSync) return ''`），
      // 静默降级、用户毫不知情。按纪律 ② 等满 30 分钟，就等于这半小时里
      // 摘要段一直是空的 —— 完全没必要。
      //
      // 所以只对声明了 `runIfMissing` 的任务做这件事：启动时检查产物，
      // 缺失就**立刻**跑一轮。有产物就照常等排程。
      // 这是纪律 ② 的一个有依据的例外，不是绕过它。
      //
      // ⚠️ 扫描范围：真实启动（调用方没传 tasks）→ 扫合并后的全表；
      //    测试（显式传了 tasks）→ 只扫它注入的那几个。
      //    为什么这么分：测试用 `tasks: { slow: ... }` 精确控制跑哪些任务，
      //    如果这里无条件扫默认表里的 digest，测试注入的 run 会被多调一次，
      //    「上一轮没结束不该再起一轮」那条断言就会莫名变成 2。
      //    （这是测试暴露出来的真问题 —— 补跑不该污染不相关任务的计数。）
      if (probe?.ok) {
        const scanNames = tasks
          ? Object.keys(tasks)
          : Object.entries(taskTable).filter(([, t]) => t?.enabled).map(([nm]) => nm)
        for (const n of scanNames) {
          const t = taskTable[n]
          if (!t?.enabled || !t.runIfMissing || !t.missingPath) continue
          const p = t.missingPath({ stateDir, cfg })
          let exists = false
          try { exists = fs.existsSync(p) } catch { exists = false }
          if (exists) continue
          log(`scheduler: ${n} 的产物不存在（${p}），启动时立刻补一次`)
          runTask(n).catch(err => warn(`scheduler: ${n} 首次补跑异常 ${err.message}`))
        }
      }
      return true
    },
    runTask,
    /** 卸钩：杀掉正在跑的子进程（纪律 ④） */
    stop () {
      stopped = true
      for (const [, h] of handles) {
        if (h.timer) clearTimeout(h.timer)
        if (h.child) { try { h.child.kill('SIGTERM') } catch { /* ignore */ } }
        h.timer = null
      }
      log('scheduler: 已停止（在跑的子进程已 SIGTERM）')
    },
    /** 给设置页/状态接口用的快照 */
    status () {
      const persisted = readState()
      return {
        enabled: featureOn,
        python: probe ? { ok: !!probe.ok, bin: probe.bin, version: probe.version, reason: probe.reason } : null,
        tasks: Object.entries(taskTable).map(([name, t]) => {
          const h = handles.get(name) || {}
          const persistedEntry = persisted[name] ?? null
          const lastError = h.lastError ?? persistedEntry?.lastError ?? null
          return {
            name, tool: t.tool, args: t.args, enabled: !!t.enabled,
            intervalMin: t.intervalMin,
            running: !!h.running,
            nextAt: h.nextAt ?? null,
            lastRunAt: h.lastRunAt ?? persistedEntry?.lastRunAt ?? h.lastResult?.lastRunAt ?? null,
            lastDurationMs: h.lastDurationMs ?? persistedEntry?.ms ?? null,
            // 上次失败原因（没失败过 = null）。截断：堆栈几 KB，设置页放不下也不该放。
            lastError: lastError ? String(lastError).slice(0, STATUS_ERROR_MAX) : null,
            lastErrorAt: h.lastErrorAt ?? persistedEntry?.lastErrorAt ?? null,
            // 定时器触发时上一轮还在跑 → 跳过的次数（missed run 不再是静默丢弃）
            skippedCount: h.skippedCount ?? 0,
            lastResult: h.lastResult ?? persistedEntry,
          }
        }),
      }
    },
    _defaultTasks: DEFAULT_TASKS,
  }
}
