// lib/agent/memory-run.mjs —— 「跑一次记忆工具」的唯一实现
// ============================================================================
// 桥（bridge/index.js，10 处 memctl 调用）和定时调度器（scheduler.mjs）
// 都需要「起一个 python 子进程跑某个记忆命令」。这段逻辑只该有一份，
// 否则会出现「桥用的 python 和定时任务用的不是同一个」这类幽灵 bug。
//
// 三条硬要求（都来自踩过的坑）：
//   ① **超时必须有**：python 挂了/卡住不能拖死调用方（桥的跨通道检索预算只有 2.5s）；
//   ② **失败必须能区分「不可用」和「这次失败」**：
//      不可用 = 没 python / 缺脚本 → 应关闭该能力并只警告一次（不是每轮刷屏）；
//      这次失败 = 超时 / 库坏 → 本轮回退，下轮还能好；
//   ③ **生产库要显式声明**：memctl 有「拒绝写生产库」的保护，插件进程
//      带着 MEMCTL_PROD=1 spawn 才是合法的生产写入方（见 agent/dirs.mjs 注释）。
// ============================================================================
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { memoryCode, memoryPaths, memoryStateDir } from './dirs.mjs'
import { dataDir } from '../store.js'

/**
 * 桥配置（bridge-config.json）的默认路径 —— 记忆子进程要读它里面的 dsh 段
 * （bin/profile/provider/model）来起反思用的 ACP 运行时。
 *
 * 为什么是 bridge-config.json 而不是插件的 config.json：
 *   插件配置里 dsh.bin / dsh.profile 是**空的**（空 = 自动探测，由 bridgeConfig()
 *   在生成桥配置时解析成实际值）。reflection_llm.mjs 拿到空值会直接
 *   `die(2, 'dsh 段缺少 bin/profile/provider/model')` → memctl 退回拼接法。
 *   也就是说：指错文件等于没修。
 *
 * 不存在就返回空串（不硬指一个不存在的路径：那样报错信息会误导人去查文件权限，
 * 而真实原因是「还没起过桥 + 也还没生成配置」）。
 */
function defaultBridgeConfigPath () {
  try {
    const p = path.join(dataDir(), 'bridge-config.json')
    return fs.existsSync(p) ? p : ''
  } catch { return '' }
}

/**
 * 解析要给 python 的 LLMINQQ_CONFIG：显式参数 > 进程环境 > <dataDir>/bridge-config.json。
 * 三者都没有就返回空串（此时不设这个变量，保持老行为 + 老报错信息）。
 */
function resolveConfigPath (explicit) {
  const fromOpt = String(explicit ?? '').trim()
  if (fromOpt) return fromOpt
  const fromEnv = String(process.env.LLMINQQ_CONFIG ?? '').trim()
  if (fromEnv) return fromEnv
  return defaultBridgeConfigPath()
}

/** 一次运行的统一返回形状（绝不抛错 —— 调用方永远拿到结果对象）。 */
function fail (kind, reason, extra = {}) {
  return { ok: false, kind, reason, stdout: '', stderr: '', code: null, ms: 0, ...extra }
}

/**
 * 构造 python 子进程的完整环境。
 *
 * 为什么要显式传这么多变量（而不是继承 process.env）：
 *   · PYTHONIOENCODING：Windows 上默认 cp936，中文记忆会变乱码甚至报错；
 *   · PYTHONDONTWRITEBYTECODE：包目录只读（也可能是全局 npm 安装），
 *     不许在 lib/agent/memory/ 里留下 __pycache__；
 *   · MEMCTL_PROD=1：声明「我是生产进程」（见文件头 ③）；
 *   · LLMINQQ_STATE_DIR：run.py 必需 —— 它按这个目录算 mem.db / style.db /
 *     游标 / 语料池。**桥、调度器、设置页、导出必须传同一个值**，否则就是
 *     P1-4 的 split-brain（两套库、共用一个游标，用户备份到的是停掉的那份）。
 *   · LLMINQQ_CONFIG：reflection_llm.mjs 靠它找**桥配置**（dsh.bin/profile/
 *     provider/model）；lexicon 靠它读 learning 段。缺了它插件版只能在包里找
 *     `bridge/config.json` —— 那个文件不存在 → 反思**静默**退回拼接法（P0-1）。
 *   · LLMINQQ_BRIDGE_LOG：memctl ingest 要读桥日志，日志在 stateDir 下。
 */
export function memoryEnv ({ cfg = {}, stateDir = null, configPath = null, extra = {} } = {}) {
  const dir = stateDir || memoryStateDir(cfg)
  // 配置路径也允许调用方显式覆盖（调度器传 bridge-config.json 的绝对路径）；
  // 解析不到就**不设**这个变量，别指一个不存在的文件去误导排查。
  const cfgFile = resolveConfigPath(configPath)
  // ⚠️ 桥日志必须从 **dir** 推导，不能用 memoryPaths(cfg)：
  //    那个函数按 cfg.memory.stateDir 算，一旦调用方传了 stateDir 覆盖（测试隔离、
  //    或者以后支持多实例），就会把 LLMINQQ_BRIDGE_LOG 指回**默认** stateDir 的
  //    日志 —— ingest 于是读错文件、返回「新增 0 条」，看起来像"日志没新内容"，
  //    其实是读了别人家的日志（实测踩到：我传 stateDir 后 ingest 一直 0 条）。
  const paths = memoryPaths({ memory: { stateDir: dir } })
  return {
    ...process.env,
    PYTHONIOENCODING: 'utf8',
    PYTHONUTF8: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    MEMCTL_PROD: '1',
    LLMINQQ_STATE_DIR: dir,
    // 注意顺序：显式值必须写在 ...process.env **之后**才能覆盖它。
    // 桥进程里的 process.env.LLMINQQ_CONFIG 就是桥配置本身（同一个文件），
    // 而插件的常驻进程里通常没有这个变量 —— 不补的话调度器起的 reflect
    // 永远读不到配置（P1-4 的另一半）。
    ...(cfgFile ? { LLMINQQ_CONFIG: cfgFile } : {}),
    LLMINQQ_BRIDGE_LOG: paths.bridgeLog,
    // node 的绝对路径：reflection_llm.mjs 是 python 通过 subprocess 起的，
    // 它只认 `NODE_BIN` 或 PATH 里的 `node`。桌面版里 `node` 很可能
    // **不在 PATH**（dsh 是 Electron/npm 装出来的）；那种情况下反思会永远报
    // 「找不到 node」→ 静默退回拼接法，用户看不出原因。
    // process.execPath = 「跑我们自己的那个 node」，一定存在。
    NODE_BIN: process.env.NODE_BIN || process.execPath,
    ...extra,
  }
}

/**
 * 同步跑一次记忆命令（给桥的热路径用：超时短、失败静默回退）。
 *
 * @param {object} opts
 * @param {object} opts.cfg        插件配置
 * @param {object} opts.probe      probePython() 的结果（ok=false 时直接返回 unavailable，不起进程）
 * @param {string} opts.tool       'memctl' | 'stylebank' | 'lexicon'
 * @param {string[]} opts.args     该工具的原有 CLI 参数
 * @param {number} [opts.timeoutMs] 默认 5000
 * @param {string} [opts.stateDir]  覆盖 stateDir（测试隔离用）
 * @returns {{ok:boolean, kind?:string, reason?:string, stdout:string, stderr:string, code:number|null, ms:number}}
 */
export function runMemorySync ({ cfg = {}, probe, tool, args = [], timeoutMs = 5000, stateDir = null, configPath = null }) {
  if (!probe?.ok) return fail('unavailable', probe?.reason || 'python 不可用')
  const code = memoryCode(cfg)
  if (!fs.existsSync(code.runner)) {
    return fail('unavailable', `记忆脚本缺失：${code.runner}（插件包不完整？）`)
  }
  const t0 = Date.now()
  const r = spawnSync(probe.bin, [...(probe.preArgs || []), code.runner, tool, ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: memoryEnv({ cfg, stateDir, configPath }),
    windowsHide: true,
  })
  const ms = Date.now() - t0
  if (r.error?.code === 'ETIMEDOUT' || (r.error && /ETIMEDOUT|timed out/i.test(String(r.error.message)))) {
    return { ...fail('timeout', `超时（>${timeoutMs}ms）`), ms }
  }
  if (r.error) return { ...fail('spawn', String(r.error.code || r.error.message)), ms }
  // 非 0 退出码不等于「不可用」：CLI 的 `learn` 在没有新语料时也返回 1（正常）。
  // 由调用方按 stdout 判断语义，这里只如实带回 code/输出。
  return {
    ok: r.status === 0, kind: r.status === 0 ? null : 'exit',
    reason: r.status === 0 ? '' : `退出码 ${r.status}`,
    stdout: String(r.stdout || ''), stderr: String(r.stderr || ''),
    code: r.status, ms,
  }
}

/**
 * 异步跑一次（给定时任务用：不阻塞事件循环，可能跑几分钟）。
 *
 * 返回对象额外带 `kill()`，调度器在插件卸载时要能杀掉它（不留孤儿 python）。
 *
 * @returns {Promise<{ok, kind, reason, stdout, stderr, code, ms}>}
 */
export function runMemoryAsync ({ cfg = {}, probe, tool, args = [], timeoutMs = 1800000, stateDir = null, onChild = () => {}, env = null, configPath = null }) {
  return new Promise(resolve => {
    if (!probe?.ok) { resolve(fail('unavailable', probe?.reason || 'python 不可用')); return }
    const code = memoryCode(cfg)
    if (!fs.existsSync(code.runner)) {
      resolve(fail('unavailable', `记忆脚本缺失：${code.runner}`))
      return
    }
    const t0 = Date.now()
    let done = false
    let timedOut = false
    const finish = (obj) => { if (!done) { done = true; clearTimeout(timer); resolve({ ...obj, ms: Date.now() - t0 }) } }

    const child = spawn(probe.bin, [...(probe.preArgs || []), code.runner, tool, ...args], {
      env: memoryEnv({ cfg, stateDir, configPath, extra: env || {} }),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    onChild(child)
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', d => { stdout += d })
    child.stderr?.on('data', d => { stderr += d })

    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGKILL') } catch { /* ignore */ }
    }, Math.max(1000, timeoutMs))
    timer.unref?.()

    child.on('error', err => finish(fail('spawn', String(err?.code || err?.message || err))))
    child.on('close', (code, signal) => {
      if (timedOut) { finish({ ...fail('timeout', `超时（>${timeoutMs}ms）`), stdout, stderr }); return }
      finish({
        ok: code === 0, kind: code === 0 ? null : 'exit',
        reason: code === 0 ? '' : `退出码 ${code}${signal ? ` 信号 ${signal}` : ''}`,
        stdout, stderr, code,
      })
    })
  })
}

/**
 * 把一次 CLI 运行的原始输出变成一行结论（日志/设置页都用它，别各写一套）。
 * @param {string} tool
 * @param {object} res runMemorySync/Async 的返回值
 */
export function summarizeRun (tool, res) {
  if (!res) return '未运行'
  if (res.kind === 'unavailable') return `跳过：${res.reason}`
  if (!res.ok) return `失败：${res.reason}`
  const last = String(res.stdout || '').trim().split('\n').filter(Boolean).pop() || ''
  return last ? `成功（${last.slice(0, 160)}）` : '成功'
}

export { memoryStateDir, memoryPaths, memoryCode }
