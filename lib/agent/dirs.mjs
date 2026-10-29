// lib/agent/dirs.mjs —— 记忆/学习能力的「代码在哪」与「数据在哪」
// ============================================================================
// 两件事必须分开（这是插件化的核心约束，也是本任务的前提）：
//
//   代码  →  npm 包里 `lib/agent/memory/`（只读，随版本升级而变）
//   数据  →  stateDir 里 `~/.dsh/llminqq/`（可写，npm uninstall 不能删）
//
// 为什么不用 `config.dsh.cwd/memory`（脚本版就是那么干的）：
//   插件的 dsh.cwd 是它自己拉起的 agent 工作区，**跟着包/配置走**。
//   用户升级、重装、切 profile 时那个目录会变/会重建 —— 记忆跟着丢。
//   用户已确认走 stateDir（独立、稳定、卸载不删）。
//
// 默认 stateDir = `~/.dsh/llminqq/`，可用 config.memory.stateDir 覆盖。
// 为什么默认不在 dataDir()（`~/.dsh/dsh-plugin-llminqq/`）下面：
//   我们刻意让「记忆数据」和「插件配置/state」分开放：
//   配置可以随手删了重来，记忆不行（那是几个月攒的对话归纳）。
//   分开放之后，「重置插件配置」不会顺手把记忆端掉。
// ============================================================================
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 包内记忆代码目录（vendored py + reflection_llm.mjs + run.py）。 */
export function memoryCodeDir () {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'memory')
}

/**
 * 记忆数据目录（stateDir）。
 * @param {object} cfg 插件配置（readConfig() 的返回值）
 */
export function memoryStateDir (cfg = {}) {
  const explicit = String(cfg?.memory?.stateDir || '').trim()
  if (explicit) return path.resolve(explicit.replace(/^~/, os.homedir()))
  return path.join(os.homedir(), '.dsh', 'llminqq')
}

/**
 * 「首次启动」要建的东西。
 *
 * ⚠️ 这里**故意不创建 mem.db**：建库交给 memctl 自己的
 * `CREATE TABLE IF NOT EXISTS`（那才是表结构的唯一真源）。
 * 这个函数只保证目录存在、给 ingest 一个游标位、写一个 `.prod-guard` 哨兵。
 *
 * 为什么要写 `.prod-guard`：memctl 有一道「拒绝写生产库」的保护
 * （生产库旁边有 `.prod-guard` 时必须显式 MEMCTL_PROD=1 才允许写）。
 * 插件里的桥**就是生产进程**，所以它在 spawn python 时会带 MEMCTL_PROD=1。
 * 哨兵让「用户拿脚本手工去写这个库」也会被拦住 —— 那正是我们想要的安全网。
 *
 * @returns {{stateDir:string, created:boolean, files:string[]}}
 */
export function ensureMemoryStateDir (cfg = {}) {
  const stateDir = memoryStateDir(cfg)
  const created = !fs.existsSync(stateDir)
  if (created) fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })

  const files = []
  const sentinel = path.join(stateDir, '.prod-guard')
  if (!fs.existsSync(sentinel)) {
    fs.writeFileSync(sentinel, '这是生产记忆库目录（插件 llminqq 在写它）。\n'
      + '脚本/测试想写这里必须显式 MEMCTL_PROD=1，否则 memctl 会拒绝。\n', { mode: 0o600 })
    files.push('.prod-guard')
  }
  // ingest 游标文件不存在是正常的（memctl 会当 0 处理）。这里不预建 ——
  // 预建成 0 反而会在「日志被轮转/截断」时把 offset reset 的判断弄乱。
  const logDir = path.join(stateDir, 'log')
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true, mode: 0o700 })
    files.push('log/')
  }
  return { stateDir, created, files }
}

/**
 * 记忆数据目录下的各文件路径 —— **给桥写配置用的单一真源**。
 * 桥（Python 调用方）不该自己拼这些路径，否则「插件改了目录、桥还在读老的」
 * 这类 bug 会静默发生（脚本版就踩过：学的是旧目录，排查 3 次）。
 */
export function memoryPaths (cfg = {}) {
  const dir = memoryStateDir(cfg)
  return {
    dir,
    db: path.join(dir, 'mem.db'),
    digest: path.join(dir, 'digest.md'),
    style: path.join(dir, 'style.db'),
    styleJsonl: path.join(dir, 'style-cases.jsonl'),
    styleCursorDir: path.join(dir, 'style-cursor'),
    lexicon: path.join(dir, 'lexicon.json'),
    corpus: path.join(dir, 'corpus'),
    log: path.join(dir, 'log'),
    bridgeLog: path.join(dir, 'bridge.out'),
  }
}

/** 包内代码的各文件路径（只读）。 */
export function memoryCode (cfg = {}) {
  const dir = memoryCodeDir()
  return {
    dir,
    memctl: path.join(dir, 'memctl.py'),
    stylebank: path.join(dir, 'stylebank.py'),
    lexicon: path.join(dir, 'lexicon.py'),
    reflectionLlm: path.join(dir, 'reflection_llm.mjs'),
    // 唯一的入口：所有 python 调用都走它，它负责把路径常量指到 stateDir
    runner: path.join(dir, 'run.py'),
  }
}
