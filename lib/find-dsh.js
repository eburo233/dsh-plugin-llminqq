// 找到「怎么在本机启动 dsh」—— 这一步在 Windows 上比想象中麻烦。
//
// 为什么需要它（真实踩坑）：
//   桥用 `spawn('dsh', ['--profile', x])` 启动 LLM 运行时。
//   在 Windows 上 dsh 通常是 `dsh.cmd` / `dsh.exe`（npm 全局装的东西都是
//   批处理外壳），而 **Node 的 spawn 不会自动补 .cmd 后缀**，也不会像
//   shell 那样去查 PATHEXT → 直接 `spawn dsh ENOENT`。
//
//   更麻烦的是：用户可能是通过 Electron 桌面应用启动的 dsh，那里根本没有
//   `dsh` 在 PATH 里 —— 得从进程信息里反推出 node 和入口脚本。
//
// 策略（从最可靠到最兜底）：
//   ① 配置里显式给了 bin（最优先，用户自己填的）
//   ② 在 PATH 里按 PATHEXT 找 dsh.cmd / dsh.exe / dsh
//   ③ 从当前进程命令行反推（Electron / node 启动时，argv 里有 dsh 的入口）
//   ④ 用「当前这个 node 可执行文件 + 反推出的入口脚本」组合

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const IS_WIN = process.platform === 'win32'

/** 把 PATH 拆开，Windows 上要用 ';' */
function pathDirs () {
  const raw = process.env.PATH || process.env.Path || ''
  return raw.split(IS_WIN ? ';' : ':').map(s => s.trim()).filter(Boolean)
}

/** 按 PATHEXT 找命令的实际文件。 */
function resolveOnPath (name) {
  const exts = IS_WIN
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : ['']
  // Windows 上优先 .CMD（npm 装的就是它），其次是 .EXE
  const ordered = IS_WIN
    ? ['.cmd', '.exe', '.bat', '.com', ...exts].filter((v, i, a) => a.indexOf(v) === i)
    : ['']
  for (const dir of pathDirs()) {
    for (const ext of ordered) {
      const candidate = path.join(dir, name + ext)
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
      } catch { /* 权限问题忽略 */ }
    }
  }
  return null
}

/**
 * 反推「当前 dsh 是怎么起来的」。
 *
 * Electron 桌面版 / 某些启动器下，dsh 不在 PATH 里，但能从这个进程的
 * 启动参数里看到它。典型形态：
 *   process.argv0 = C:\Program Files\DeepSeek\resources\app\node.exe
 *   process.execPath = 上面那个
 *   process.argv[1] = ...\node_modules\@deepseek-ai\dsh\lib\bin.js
 */
function inferFromCurrentProcess () {
  const nodeExe = process.execPath
  const candidates = []

  for (const a of process.argv.slice(1)) {
    if (typeof a !== 'string') continue
    // dsh 的入口一般是 @deepseek-ai/dsh/lib/bin.js
    if (/@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js$/i.test(a) || /[\\/]dsh[\\/]lib[\\/]bin\.js$/i.test(a)) {
      candidates.push({ node: nodeExe, script: a })
    }
  }

  // 有些启动器把整个命令塞进 argv0 或 Electron 的辅助参数里
  const joined = process.argv.join(' ')
  const m = joined.match(/([A-Za-z]:\\[^"']*?@deepseek-ai\\dsh\\lib\\bin\.js)/i)
  if (m) candidates.push({ node: nodeExe, script: m[1] })

  return candidates
}

const COMMON_GLOBAL_PATHS = [
  path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'dsh.cmd'),
  path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'dsh'),
  path.join(os.homedir(), '.local', 'bin', 'dsh'),
  '/usr/local/bin/dsh',
  '/usr/bin/dsh',
  path.join(os.homedir(), '.npm-global', 'bin', 'dsh'),
  path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'DeepSeek', 'dsh.cmd'),
]

/**
 * 解析出「怎么启动 dsh」。
 *
 * @param {string} configured 配置里填的 bin（可空）
 * @returns {{ kind:'direct'|'node-script'|'cmd-shell'|'none', bin?:string, script?:string, reason:string, tried:string[] }}
 */
export function resolveDshCommand (configured = '') {
  const tried = []

  // ① 用户显式配置
  if (configured && configured !== 'dsh') {
    tried.push(`config: ${configured}`)
    if (fs.existsSync(configured)) {
      if (IS_WIN && /\.(cmd|bat)$/i.test(configured)) {
        return { kind: 'cmd-shell', bin: configured, reason: `使用配置的 ${configured}（.cmd 需要 shell）`, tried }
      }
      return { kind: 'direct', bin: configured, reason: `使用配置的 ${configured}`, tried }
    }
    // 配置了但不存在 —— 继续往下找，但把原因带上
  }

  // ② PATH 里找（按 PATHEXT）
  for (const name of ['dsh', 'dsh.cmd', 'dsh.exe']) {
    const hit = resolveOnPath(name)
    if (hit) {
      tried.push(`PATH: ${hit}`)
      if (IS_WIN && /\.(cmd|bat)$/i.test(hit)) {
        return { kind: 'cmd-shell', bin: hit, reason: `在 PATH 找到 ${hit}（.cmd 需要经 shell 启动）`, tried }
      }
      return { kind: 'direct', bin: hit, reason: `在 PATH 找到 ${hit}`, tried }
    }
  }
  tried.push('PATH: 没找到 dsh/dsh.cmd/dsh.exe')

  // ③ 从当前进程反推（Electron 场景）
  const inferred = inferFromCurrentProcess()
  for (const c of inferred) {
    tried.push(`argv: ${c.node} ${c.script}`)
    if (fs.existsSync(c.script)) {
      return { kind: 'node-script', bin: c.node, script: c.script, reason: `从当前进程反推出 dsh 入口：${c.script}`, tried }
    }
  }

  // ④ 常见全局安装位置
  for (const p of COMMON_GLOBAL_PATHS) {
    tried.push(`common: ${p}`)
    if (fs.existsSync(p)) {
      if (IS_WIN && /\.(cmd|bat)$/i.test(p)) {
        return { kind: 'cmd-shell', bin: p, reason: `在常见位置找到 ${p}`, tried }
      }
      return { kind: 'direct', bin: p, reason: `在常见位置找到 ${p}`, tried }
    }
  }

  return {
    kind: 'none',
    reason: '找不到 dsh 命令',
    tried,
  }
}

/**
 * 按解析结果构造 spawn 参数。
 * .cmd / .bat 在 Windows 上**必须经 shell 启动**，否则 ENOENT。
 */
export function spawnArgsFor (resolved, args = []) {
  if (resolved.kind === 'node-script') {
    return { cmd: resolved.bin, args: [resolved.script, ...args], useShell: false }
  }
  if (resolved.kind === 'cmd-shell') {
    // 用 shell 启动时参数要自己拼好（且路径含空格要引号）
    const quoted = [resolved.bin, ...args].map(a => /\s/.test(a) ? `"${a}"` : a).join(' ')
    if (IS_WIN) {
      return { cmd: process.env.COMSPEC || 'cmd.exe', args: ['/d', '/s', '/c', quoted], useShell: false }
    }
    return { cmd: resolved.bin, args, useShell: true }
  }
  return { cmd: resolved.bin, args, useShell: false }
}
