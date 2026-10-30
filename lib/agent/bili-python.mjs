/**
 * bili-duty 那份 venv 的 python 在哪？
 *
 * 为什么单独一个模块：这个路径在三个地方被用到（抓语料、记忆后台、python 侧的
 * lexicon.py），而它们各自写死了 `~/.dsh/bili-duty/.venv/bin/python` ——
 * **那是 Linux/macOS 的布局**。Windows 上 venv 的 python 在 `Scripts/python.exe`，
 * 于是一台跑得好好的机器上，设置页永远报「没找到 B站 语料抓取用的 python」，
 * 用户按提示去装依赖也修不好（因为找的地方从来就不对）。
 *
 * 所以这里把「候选根」按优先级列全（见 biliRoots 注释）：显式环境变量 →
 * DSH_HOME / 插件数据目录约定（lib/store.js 的 dataDir()）→ 老的 `~/.dsh` →
 * 旧版本写死的 `D:/dsh-home`、`C:/dsh-home`（**只在真实存在时**兜底）。
 * 真正权威的永远是 cfg.learning.crawlPython（显式配置优先）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dataDir } from '../store.js'

/** venv 里 python 的相对位置：Windows 是 Scripts，其它平台是 bin。 */
export const VENV_PYTHON_REL = process.platform === 'win32'
  ? ['Scripts/python.exe', 'bin/python']
  : ['bin/python', 'bin/python3', 'Scripts/python.exe']

/**
 * 旧版本写死的两个根（`D:/dsh-home`、`C:/dsh-home`）。
 *
 * 换一台机器它们通常不存在，但老部署里 bili-duty 确实装在那 —— 所以保留，
 * 但**只在 fs.existsSync 为真时**才进候选，不再无条件猜。
 */
const LEGACY_ROOTS = ['D:/dsh-home', 'C:/dsh-home']

/**
 * bili-duty 可能所在的根目录，按优先级去重返回（全部 path.resolve 过）。
 *
 * 优先级（第一个命中的就是权威）：
 *   ① `LLMINQQ_DATA_DIR`  显式数据目录（容器/自定义部署唯一可靠的来源）
 *   ② `DSH_HOME`          dsh 的 home；脚本版把 bili-duty 直接放在它下面
 *   ③ `<DSH_HOME>/dsh-plugin-llminqq`、以及 `dataDir()`（插件数据目录约定，
 *      与 lib/store.js 一致：反推安装路径 → DSH_HOME → ~/.dsh）
 *   ④ `~/.dsh`            老布局：`~/.dsh/bili-duty/.venv/...`
 *   ⑤ `D:/dsh-home`、`C:/dsh-home`  仅当它们**真实存在**时才兜底
 *
 * 参数可注入（homedir/exists/dataDirPath）纯粹是为了能测「换台机器」的纯函数
 * 行为；生产调用一律用默认值，语义与旧实现一致。
 *
 * @param {NodeJS.ProcessEnv} [env] 环境变量来源
 * @param {{homedir?:string, exists?:(p:string)=>boolean, dataDirPath?:string}} [opts]
 * @returns {string[]}
 */
export function biliRoots (env = process.env, opts = {}) {
  const homedir = opts.homedir ?? os.homedir()
  const exists = opts.exists ?? fs.existsSync
  const dataDirPath = opts.dataDirPath ?? dataDir()
  const roots = []
  const push = (v) => {
    const s = String(v ?? '').trim()
    if (s) roots.push(path.resolve(s))
  }

  // ① 显式数据目录
  push(env.LLMINQQ_DATA_DIR)

  // ② DSH_HOME：bili-duty 放在它下面（以及插件数据目录 = <DSH_HOME>/dsh-plugin-llminqq）
  const dshHome = String(env.DSH_HOME ?? '').trim()
  push(dshHome)
  if (dshHome) push(path.join(dshHome, 'dsh-plugin-llminqq'))

  // ③ 插件实际数据目录约定（和 store.js 的 dataDir() 同一份推导，别再猜一遍）
  push(dataDirPath)

  // ④ 老布局：bili-duty 直接放在 ~/.dsh 下
  push(path.join(homedir, '.dsh'))

  // ⑤ 旧的硬编码根：只认真实存在的
  for (const r of LEGACY_ROOTS) if (exists(r)) push(r)

  return [...new Set(roots)]
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
