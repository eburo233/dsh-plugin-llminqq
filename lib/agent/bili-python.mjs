/**
 * bili-duty 那份 venv 的 python 在哪？
 *
 * 为什么单独一个模块：这个路径在三个地方被用到（抓语料、记忆后台、python 侧的
 * lexicon.py），而它们各自写死了 `~/.dsh/bili-duty/.venv/bin/python` ——
 * **那是 Linux/macOS 的布局**。Windows 上 venv 的 python 在 `Scripts/python.exe`，
 * 于是一台跑得好好的机器上，设置页永远报「没找到 B站语料抓取用的 python」，
 * 用户按提示去装依赖也修不好（因为找的地方从来就不对）。
 *
 * 所以这里把「候选路径」一次列全：先看显式配置，再按平台常见布局找，
 * 同时覆盖 `~/.dsh` 与 DSH_HOME（有的机器 bili-duty 放在 HOME 下，
 * 有的放在 DSH_HOME 下，两个都真实存在过）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** venv 里 python 的相对位置：Windows 是 Scripts，其它平台是 bin。 */
const VENV_PYTHON_REL = process.platform === 'win32'
  ? ['Scripts/python.exe', 'bin/python']
  : ['bin/python', 'bin/python3', 'Scripts/python.exe']

/** bili-duty 可能所在的根目录（都真实见过）。 */
function biliRoots () {
  const roots = []
  if (process.env.DSH_HOME) roots.push(process.env.DSH_HOME)
  roots.push(path.join(os.homedir(), '.dsh'))
  // DSH_HOME 常被配成 D:\dsh-home，但用户也可能装在别处；这里只放最常见的两个猜测，
  // 真正权威的永远是 cfg.learning.crawlPython（显式配置优先）。
  roots.push('D:/dsh-home')
  roots.push('C:/dsh-home')
  return [...new Set(roots.map(r => path.resolve(r)))]
}

/**
 * @param {object} cfg 插件配置（读 learning.crawlPython / learning.venvPython）
 * @returns {{ bin: string, root: string, tried: string[] }}
 *   bin 为空串 = 没找到。
 */
export function resolveBiliPython (cfg = {}) {
  const explicit = String(cfg?.learning?.crawlPython || cfg?.learning?.venvPython || '').trim()
  const tried = []
  if (explicit) {
    tried.push(explicit)
    if (fs.existsSync(explicit)) {
      return { bin: explicit, root: path.dirname(path.dirname(path.dirname(explicit))), tried }
    }
    // 显式配置了但不存在：不直接失败，继续按布局找一遍 —— 用户改过目录很常见
  }
  for (const root of biliRoots()) {
    for (const rel of VENV_PYTHON_REL) {
      const p = path.join(root, 'bili-duty', '.venv', rel)
      tried.push(p)
      if (fs.existsSync(p)) return { bin: p, root: path.join(root, 'bili-duty'), tried }
    }
  }
  return { bin: '', root: '', tried }
}

/** bili-duty 目录（mcp_server.py 所在处）：优先跟着 python 走。 */
export function resolveBiliRoot (cfg = {}, bin = '') {
  const explicit = String(cfg?.learning?.crawlMcpDir || cfg?.learning?.mcpDir || '').trim()
  if (explicit) return explicit
  if (bin) {
    // <root>/bili-duty/.venv/Scripts/python.exe → <root>/bili-duty
    const guess = path.dirname(path.dirname(path.dirname(bin)))
    if (fs.existsSync(path.join(guess, 'mcp_server.py'))) return guess
  }
  for (const root of biliRoots()) {
    const dir = path.join(root, 'bili-duty')
    if (fs.existsSync(dir)) return dir
  }
  return ''
}
