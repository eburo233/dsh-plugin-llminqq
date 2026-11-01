#!/usr/bin/env node
// scripts/cleanup-orphan-acp.mjs —— 清理重启动留下的孤儿进程（ACP 子进程 + 桥自己）
//
// ============================================================================
// 为什么要有这个脚本（2026-10-31 真实事故）
// ============================================================================
//
// 现象：用户说「重启了」，但重启后 CPU 反而更高，日志里 OneBot 重连计数
// 飙到 **387 次**（本该十几次）。
//
// 查下来：重启后**两个桥进程并存**
//   PID 561089  PPid=1（孤儿）  存活 4h32m  **CPU 13.7%**（累计 37 分钟）
//   PID 626677  PPid=626585     本次 dsh 起的正常桥
//
// 它们都在死连同一个 OneBot 端口（30s 一次重连），而且孤儿还占着 18080
// 本地 API —— 新桥启动时报 `EADDRINUSE: address already in use 127.0.0.1:18080`。
//
// 根因：`lib/bridge/index.js` 里本来就有「启动前清孤儿」的调用，
// 但它引用的就是这个文件 —— **而这个文件从来没被创建过**。
// 所以那段代码一直是死代码：`if (fs.existsSync(script))` 判断不过，静默跳过。
// 而且原设计只管 `dsh --profile <x>` 的 ACP 子进程，**根本不管桥自己**。
//
// ============================================================================
// 安全边界（这个脚本会 kill 进程，判据必须保守）
// ============================================================================
//
// 「孤儿」的严格定义，三条全中才算：
//   ① PPid == 1     —— 父进程已死，真孤儿（被 init 收养）
//   ② 命令行里有本插件的 **精确路径**（不是模糊的 "node"、"bridge"）
//   ③ 不是当前进程自己
//
// 为什么 PPid==1 是必要条件：DSH 正常运行时桥是它的子进程（PPid=<dsh pid>）。
// 只有 DSH 被强杀/崩溃/重启而桥没收到 SIGTERM 时，桥才会被 init 收养变成 PPid=1。
//
// 为什么必须「精确路径」匹配：机器上可能有别的 node 进程、别的 QQ 桥项目。
// 用 `bridge/index.js` 这种片段匹配会误杀别人的进程。
//
// 默认**只看不杀**：要杀必须显式 `--kill`。这是给排障用的工具，
// 不该在没看清的时候就把进程干掉。
//
// 用法：
//   node scripts/cleanup-orphan-acp.mjs                  # 只列出，不动手
//   node scripts/cleanup-orphan-acp.mjs --kill           # 列出并杀
//   node scripts/cleanup-orphan-acp.mjs --kill --json    # 给调用方解析
//   node scripts/cleanup-orphan-acp.mjs --kill --self <pid>   # 保护某个 pid 不杀
// ============================================================================

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** 本插件根目录（scripts/ 的上一级）—— 用它的绝对路径做「这是我们的进程」的唯一凭据。 */
const PKG_ROOT = path.resolve(HERE, '..')

const argv = process.argv.slice(2)
const KILL = argv.includes('--kill')
const JSON_OUT = argv.includes('--json')
const argOf = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : ''
}
const selfPid = Number(argOf('--self')) || process.pid

/** 本插件的桥入口 / ACP 子进程特征。都用绝对路径，避免误杀。 */
const BRIDGE_ENTRY = path.join(PKG_ROOT, 'lib', 'bridge', 'index.js')

/**
 * 「哪些路径算我们的桥」——**不能只认脚本自己所在的那份**。
 *
 * ⚠️ 真实踩坑：这个脚本在仓库里（`<repo>/scripts/`），但**真正在跑的桥**
 * 是 pnpm 拷进 profile 的那份（`~/.dsh/profiles/<profile>/node_modules/dsh-plugin-llminqq/`）。
 * 只比对 `PKG_ROOT` 推出来的路径，会把真正的孤儿判成「不是我们的进程」→
 * 扫 404 个进程、报告「发现 0 个孤儿」，而孤儿明明还在跑并吃着 13.7% CPU。
 *
 * 所以判据是「命令行里出现 `dsh-plugin-llminqq/lib/bridge/index.js` 这个后缀」+
 * 包名精确，而不是某一条绝对路径。保留两条候选路径做优先匹配。
 */
const BRIDGE_MARKERS = [
  'dsh-plugin-llminqq/lib/bridge/index.js',
  path.join(PKG_ROOT, 'lib', 'bridge', 'index.js'),
]

/** 这条命令行是不是本插件的桥进程。 */
function isOurBridge (cmd) {
  return BRIDGE_MARKERS.some(m => cmd.includes(m))
}

/**
 * 枚举所有进程（Linux 走 /proc，其它平台退化成 ps）。
 * @returns {Array<{pid:number, ppid:number, cmd:string}>}
 */
function listProcesses () {
  const out = []
  if (fs.existsSync('/proc')) {
    for (const name of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue
      const pid = Number(name)
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
        // stat 格式：pid (comm) state ppid ... ；comm 里可能有空格/括号，从最后一个 ) 之后切
        const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
        const ppid = Number(after[1])
        let cmd = ''
        try {
          cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim()
        } catch { cmd = '' }
        // cwd：ACP 子进程的判据之一（见 classify 里对「不带 --patch」的说明）
        let cwd = ''
        try {
          cwd = fs.readlinkSync(`/proc/${pid}/cwd`)
        } catch { cwd = '' }
        out.push({ pid, ppid, cmd, cwd })
      } catch { /* 进程刚好退出 */ }
    }
    return out
  }
  // 非 Linux：退化用 ps（字段用 \x1f 分隔，避免命令行里的空格把列拆错）
  try {
    const raw = execFileSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8' })
    for (const line of raw.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)
      if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] })
    }
  } catch { /* ps 不可用就算了 */ }
  return out
}

/**
 * 判定一个进程是不是「本插件的孤儿」。
 *
 * @param {{pid:number, ppid:number, cmd:string}} p
 * @returns {{orphan:boolean, kind?:string, why:string}}
 */
function classify (p) {
  if (p.pid === selfPid) return { orphan: false, why: 'protected: 当前进程' }
  if (p.ppid !== 1) {
    return { orphan: false, why: `父进程还活着（ppid=${p.ppid}），不是孤儿` }
  }
  // 桥自己：命令行里必须出现本插件桥入口的路径（仓库那份或安装副本那份）
  if (isOurBridge(p.cmd)) {
    return { orphan: true, kind: 'bridge', why: '桥孤儿（PPid=1，父 DSH 已退出）' }
  }
  // ACP 子进程：`dsh --profile <name>`，且能确认是**本插件**起的。
  //
  // ⚠️ 2026-11-01 实测踩到判据盲区：有个孤儿是 `dsh --profile acp`（**不带 --patch**），
  //    原来只认「命令行里有 dsh-plugin-llminqq 或 patch 路径」，
  //    于是它被判成「不匹配本插件特征」→ 扫 437 个进程报「0 个孤儿」，孤儿还在跑。
  //
  // 现在用 cwd 作为可靠判据：
  //   我们桥起的 ACP 子进程，cwd 一定在插件数据目录下（通常是 .../dsh-plugin-llminqq/agent）；
  //   别人家的 `dsh --profile acp` 不会恰好跑在那个目录里。
  //
  // 三重条件任一成立即认定（宁严不宽）：
  //   ① 命令行里有 dsh-plugin-llminqq 路径（带 --patch 的常规情况）
  //   ② cwd 落在本插件数据目录内（不带 --patch 时也能认出来）
  if (/dsh\s+--profile/.test(p.cmd)) {
    const marker = p.cmd.includes('dsh-plugin-llminqq')
    if (marker) return { orphan: true, kind: 'acp', why: 'ACP 子进程孤儿（PPid=1，命令行含插件路径）' }
    if (p.cwd && isPluginDataDir(p.cwd)) {
      return { orphan: true, kind: 'acp', why: `ACP 子进程孤儿（PPid=1，cwd=${p.cwd}）` }
    }
  }
  return { orphan: false, why: '不匹配本插件特征' }
}

/** 这个路径是不是本插件的数据目录（或其子目录）。 */
function isPluginDataDir (dir) {
  if (!dir) return false
  const norm = dir.replace(/\\/g, '/')
  // 插件数据目录固定叫 dsh-plugin-llminqq（见 lib/store.js 的 dataDir）
  return /\/dsh-plugin-llminqq(\/|$)/.test(norm)
}

function main () {
  const procs = listProcesses()
  const found = []
  for (const p of procs) {
    const c = classify(p)
    if (c.orphan) found.push({ ...p, kind: c.kind, why: c.why })
  }

  const result = { scanned: procs.length, orphans: found, killed: [], dryRun: !KILL }

  if (!JSON_OUT) {
    console.log(`[cleanup-acp] 扫描 ${procs.length} 个进程，发现 ${found.length} 个孤儿`)
    for (const o of found) {
      const kb = (() => {
        try { return Math.round(Number(fs.readFileSync(`/proc/${o.pid}/statm`, 'utf8').split(' ')[1]) * 4096 / 1024 / 1024) }
        catch { return null }
      })()
      console.log(`[cleanup-acp]   孤儿 pid=${o.pid} kind=${o.kind}${kb ? ` 内存≈${kb}MB` : ''}  ${o.cmd.slice(0, 100)}`)
    }
    if (found.length === 0) console.log('[cleanup-acp] 没有孤儿，无需清理')
  }

  if (KILL && found.length > 0) {
    for (const o of found) {
      try {
        process.kill(o.pid, 'SIGTERM')
        result.killed.push({ pid: o.pid, kind: o.kind, signal: 'SIGTERM' })
        if (!JSON_OUT) console.log(`[cleanup-acp] 已杀 pid=${o.pid}（SIGTERM）`)
      } catch (err) {
        if (!JSON_OUT) console.log(`[cleanup-acp] 杀 pid=${o.pid} 失败：${err.message}`)
        result.killed.push({ pid: o.pid, kind: o.kind, error: err.message })
      }
    }
    // SIGTERM 之后给 2 秒收尾，还在就 SIGKILL（桥会删 staging、落盘状态）
    const still = []
    for (const k of result.killed) {
      if (k.error) continue
      try {
        // 检查是否还活着（kill -0）
        process.kill(k.pid, 0)
        still.push(k.pid)
      } catch { /* 已退出，正常 */ }
    }
    if (still.length) {
      for (const pid of still) {
        try {
          process.kill(pid, 'SIGKILL')
          if (!JSON_OUT) console.log(`[cleanup-acp] pid=${pid} 不响应 SIGTERM，已 SIGKILL`)
        } catch { /* ignore */ }
      }
    }
  }

  if (JSON_OUT) console.log(JSON.stringify(result, null, 2))
  return found.length
}

// 直接执行（被 import 时不该有副作用，所以用下面的判断）
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (invokedDirectly) {
  try {
    main()
  } catch (err) {
    console.error(`[cleanup-acp] 失败：${err.message}`)
    process.exitCode = 1
  }
}

export { listProcesses, classify, BRIDGE_ENTRY, BRIDGE_MARKERS, isOurBridge, isPluginDataDir }
