// lib/pyprobe.mjs —— 「这台机器上有没有能跑记忆系统的 Python？」
// ============================================================================
// 为什么需要单独探测（而不是直接 execFileSync('python3') 撞运气）：
//
//   记忆/学习能力全部是 Python 脚本（memctl/lexicon/stylebank，纯标准库）。
//   在没有 Python 的机器上（Windows 全新装、精简容器、某些桌面发行版），
//   原来那些调用会**抛 ENOENT 然后被 catch 成 debug 日志** —— 用户看不见，
//   表现就是「记忆功能看起来开着，实际是空的」。这是本任务要根治的问题。
//
// 探测策略（照 dsh-bili-scroll 的 hostdeps/uvfetch 那套「先找现成的、
// 找不到给出可执行的结论」的纪律，但**不下载运行时**）：
//   为什么这里不学它「自动下载 uv + 建 venv」：
//   那条路的成本是 32MB 下载 + venv 104MB，为的是**第三方依赖**（bilibili-mcp）。
//   而三个记忆脚本实测**零第三方依赖**（只 import 标准库），系统 python3 就能跑。
//   所以对记忆能力，正确做法是「探测 + 明确告知」，不是「悄悄装 140MB」。
//   真要下载运行时的场景是 B站工具（P3），那时才用 uvfetch。
//
// 探测顺序（config 优先，便于用户把某一台机器钉死到指定解释器）：
//   ① config.memory.pythonBin / 环境变量 LLMINQQ_PYTHON
//   ② PATH 里的 python3
//   ③ PATH 里的 python（有些发行版/conda 只装了 python）
//   ④ Windows 上的 py -3（Python launcher，唯一保证存在的入口）
//   ⑤ 都没有 → ok=false + 人能看懂的 reason
//
// 版本门槛 3.8：三个脚本用了 f-string / `:=` / dataclasses 之前的东西，
// 3.8 是安全下界（本机实测 3.12 正常）。低于它宁可报「不可用」，
// 也不要在运行时抛出几百行 SyntaxError。
// ============================================================================
import { execFile, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'

// 同步版（spawnSync）保留给「已经在同步上下文里、没有别的选择」的调用方；
// 设置页/启动路径一律用异步版 —— 同步会钉住 DSH 的事件循环（最坏 8s×3）。
const execFileAsync = promisify(execFile)

/** 记忆系统要求的最低 Python 版本（见文件头注释，不是拍脑袋） */
export const MIN_PY = '3.8'
export const MIN_PY_MAJOR = 3
export const MIN_PY_MINOR = 8

/** 探测一次解释器的脚本：只打印版本，不 import 任何东西（最快的失败路径）。 */
const VERSION_PY = 'import sys;print("%d.%d.%d"%sys.version_info[:3])'

/**
 * 试一个候选解释器，返回 {ok, version} 或 {ok:false, error}。
 * @param {string} bin        可执行文件名/路径
 * @param {string[]} preArgs  前缀参数（如 Windows 的 py -3）
 */
function tryInterpreter (bin, preArgs, timeoutMs) {
  try {
    const r = spawnSync(bin, [...preArgs, '-c', VERSION_PY], {
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    if (r.error) {
      // ENOENT = 没这个可执行文件；ETIMEDOUT = 卡住了（别当成「有」）
      return { ok: false, error: r.error.code || r.error.message }
    }
    if (r.status !== 0) return { ok: false, error: `退出码 ${r.status}` }
    const raw = String(r.stdout || '').trim().split('\n').pop() || ''
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(raw)
    if (!m) return { ok: false, error: `版本输出看不懂：${raw.slice(0, 40)}` }
    const version = `${m[1]}.${m[2]}.${m[3]}`
    return { ok: true, version, major: Number(m[1]), minor: Number(m[2]) }
  } catch (err) {
    return { ok: false, error: String(err?.message || err).slice(0, 120) }
  }
}

/**
 * 试一个候选解释器（异步版）。语义与 tryInterpreter 完全一致，
 * 只是不阻塞事件循环 —— 设置页每 4 秒轮询的主机不能再有同步子进程。
 */
async function tryInterpreterAsync (bin, preArgs, timeoutMs) {
  try {
    const r = await execFileAsync(bin, [...preArgs, '-c', VERSION_PY], {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    })
    const raw = String(r.stdout || '').trim().split('\n').pop() || ''
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(raw)
    if (!m) return { ok: false, error: `版本输出看不懂：${raw.slice(0, 40)}` }
    return { ok: true, version: `${m[1]}.${m[2]}.${m[3]}`, major: Number(m[1]), minor: Number(m[2]) }
  } catch (err) {
    // execFile 的错误里 ENOENT/ETIMEDOUT 在 code 上，退出码在 exitCode 上
    const code = err?.code || err?.cause?.code
    if (code) return { ok: false, error: code }
    if (typeof err?.exitCode === 'number') return { ok: false, error: `退出码 ${err.exitCode}` }
    return { ok: false, error: String(err?.message || err).slice(0, 120) }
  }
}

/** 候选解释器列表（同步版与异步版共用，避免两边顺序漂移）。 */
function buildCandidates (pythonBin) {
  const explicit = String(pythonBin || process.env.LLMINQQ_PYTHON || '').trim()
  const candidates = []
  if (explicit) candidates.push({ bin: explicit, preArgs: [], source: 'config' })
  candidates.push({ bin: 'python3', preArgs: [], source: 'path:python3' })
  if (!explicit) {
    candidates.push({ bin: 'python', preArgs: [], source: 'path:python' })
    if (process.platform === 'win32') {
      candidates.push({ bin: 'py', preArgs: ['-3'], source: 'windows-launcher' })
    }
  }
  return candidates
}

/** 把「试了一堆候选」的结论拼成人能照做的 reason（同步版与异步版共用）。 */
function concludeProbe (tried, log) {
  const plainNone = tried.every(t => t.error && /ENOENT|not found|系统找不到/i.test(String(t.error)))
  const versionOnly = tried.some(t => t.version)
  const reason = versionOnly
    ? `找到 Python 但版本低于 ${MIN_PY}（${tried.filter(t => t.version).map(t => `${t.bin}=${t.version}`).join(', ')}），记忆/学习功能需要 ${MIN_PY}+`
    : plainNone
      ? `没有找到 python3/python${process.platform === 'win32' ? '/py -3' : ''}，记忆与学习功能已禁用（装一个 Python ${MIN_PY}+ 即可，无需任何 pip 依赖）`
      : `python 探测失败（${tried.map(t => `${t.bin}:${t.error}`).join('; ')}），记忆与学习功能已禁用`
  log(`python 探测：全部不可用 —— ${reason}`)
  return {
    ok: false, bin: null, preArgs: [], version: null,
    source: 'none', reason, tried,
  }
}

/**
 * 探测可用的 Python。**永不抛错** —— 拿不到就返回 ok:false + reason，
 * 调用方据此决定「关掉记忆功能 + 打 warn」，而不是让插件起不来。
 *
 * @param {object} opts
 * @param {string} [opts.pythonBin]  config.memory.pythonBin（可覆盖探测顺序）
 * @param {number} [opts.timeoutMs]  单次探测超时，默认 8000
 * @param {(m:string)=>void} [opts.log] 详细过程（探测失败原因）回调
 * @returns {{ok:boolean, bin:string|null, preArgs:string[], version:string|null,
 *            source:string, reason:string, tried:Array<{bin:string,error?:string,version?:string}>}}
 */
export function probePython ({ pythonBin = '', timeoutMs = 8000, log = () => {} } = {}) {
  const tried = []
  for (const c of buildCandidates(pythonBin)) {
    const r = tryInterpreter(c.bin, c.preArgs, timeoutMs)
    if (!r.ok) {
      tried.push({ bin: c.bin, error: r.error })
      log(`python 探测：${c.bin} 不可用（${r.error}）`)
      continue
    }
    tried.push({ bin: c.bin, version: r.version })
    const tooOld = r.major < MIN_PY_MAJOR || (r.major === MIN_PY_MAJOR && r.minor < MIN_PY_MINOR)
    if (tooOld) {
      // 版本不够**不算可用**：让它继续往下试（py -3 拿到的可能是别的版本），
      // 全都不合格时 reason 会明确说「版本太低」，而不是含糊的「没找到」。
      log(`python 探测：${c.bin} 版本 ${r.version} 低于 ${MIN_PY}`)
      continue
    }
    log(`python 探测：${c.bin} ${r.version}（${c.source}）✓`)
    return {
      ok: true, bin: c.bin, preArgs: c.preArgs, version: r.version,
      source: c.source, reason: '', tried,
    }
  }
  return concludeProbe(tried, log)
}

/**
 * `probePython` 的异步版本：结果完全一致，但不会阻塞事件循环。
 * 启动预热、设置页刷新、`/overview` 这类路径都应该用这个。
 */
export async function probePythonAsync ({ pythonBin = '', timeoutMs = 8000, log = () => {} } = {}) {
  const tried = []
  for (const c of buildCandidates(pythonBin)) {
    const r = await tryInterpreterAsync(c.bin, c.preArgs, timeoutMs)
    if (!r.ok) {
      tried.push({ bin: c.bin, error: r.error })
      log(`python 探测：${c.bin} 不可用（${r.error}）`)
      continue
    }
    tried.push({ bin: c.bin, version: r.version })
    const tooOld = r.major < MIN_PY_MAJOR || (r.major === MIN_PY_MAJOR && r.minor < MIN_PY_MINOR)
    if (tooOld) {
      log(`python 探测：${c.bin} 版本 ${r.version} 低于 ${MIN_PY}`)
      continue
    }
    log(`python 探测：${c.bin} ${r.version}（${c.source}）✓`)
    return {
      ok: true, bin: c.bin, preArgs: c.preArgs, version: r.version,
      source: c.source, reason: '', tried,
    }
  }
  return concludeProbe(tried, log)
}

/** 探测结果 → 一行给日志/设置页看的中文结论。 */
export function describeProbe (probe) {
  if (!probe) return '未探测'
  if (probe.ok) return `记忆可用（${probe.bin} ${probe.version}，来源 ${probe.source}）`
  return `记忆不可用：${probe.reason}`
}
