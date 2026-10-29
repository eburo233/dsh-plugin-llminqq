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
 */
export function createScheduler ({ cfg = {}, probe, stateDir, log = () => {}, warn = () => {}, tasks = null, now = Date.now, bridgeLog = '' }) {
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
    const res = await runMemoryAsync({
      cfg, probe, tool: t.tool, args: t.args,
      timeoutMs: t.timeoutMs, stateDir,
      // 显式告诉 python 桥日志在哪：memctl ingest 只认这个变量，
      // 不传就会去 stateDir/bridge.out 找一个不存在的文件 → 「新增 0 条」永远静默。
      env: bridgeLog ? { LLMINQQ_BRIDGE_LOG: bridgeLog } : null,
      onChild: child => { h.child = child },
    })
    h.running = false
    h.child = null
    const entry = {
      lastRunAt: startedAt, lastFinishedAt: now(), ok: res.ok, kind: res.kind || null,
      reason: res.reason || '', ms: res.ms || 0, summary: summarizeRun(t.tool, res),
    }
    h.lastResult = entry
    handles.set(name, h)
    writeState({ [name]: entry })
    if (res.ok) log(`scheduler: ${name} 完成（${(entry.ms / 1000).toFixed(0)}s）· ${entry.summary}`)
    else if (res.kind === 'unavailable') log(`scheduler: ${name} 跳过（${res.reason}）`)
    else warn(`scheduler: ${name} 失败（${(entry.ms / 1000).toFixed(0)}s）: ${res.reason}${res.stderr ? ` / ${String(res.stderr).trim().split('\n').pop()?.slice(0, 120)}` : ''}`)
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
          return {
            name, tool: t.tool, args: t.args, enabled: !!t.enabled,
            intervalMin: t.intervalMin,
            running: !!h.running,
            nextAt: h.nextAt ?? null,
            lastRunAt: persisted[name]?.lastRunAt ?? h.lastResult?.lastRunAt ?? null,
            lastResult: h.lastResult ?? persisted[name] ?? null,
          }
        }),
      }
    },
    _defaultTasks: DEFAULT_TASKS,
  }
}
