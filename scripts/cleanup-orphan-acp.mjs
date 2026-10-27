#!/usr/bin/env node
// 清理「孤儿 ACP 进程」—— 桥每次重启都会拉一个新的 `dsh --profile llminqq-acp`，
// 但桥异常退出 / 被 SIGKILL 时，子进程没人管，会一直挂着占内存（每个约 240MB）。
//
// 实测（2026-10-27）：一天下来积了 30 个，占 7.2G 内存，最老的挂了 21 小时。
//
// 用法：
//   node scripts/cleanup-orphan-acp.mjs            # 只列出，不杀（默认 dry-run）
//   node scripts/cleanup-orphan-acp.mjs --kill     # 真的杀
//   node scripts/cleanup-orphan-acp.mjs --kill --max-age-hours 2   # 只杀超过 2 小时的
//
// 安全设计（三条硬规则，缺一不可）：
//   ① **只杀孤儿**：PPid 必须是 1（被 init 收养）或 PPid 已不存在。
//      父进程还活着的进程一律不碰 —— 那是别的正在用的桥的子进程。
//   ② **不匹配自己**：绝不使用 pgrep/pkill -f（会匹配到自己/父 shell 的命令行，
//      实测在另一个会话里踩过「pkill 自杀」）。这里直接读 /proc/<pid>/cmdline 精确比对 argv。
//   ③ **排除本进程及其祖先链**：把自己、父进程、父父进程……全部排除，防止误杀调用方。
//
// 另外只处理**本 profile**（默认 llminqq-acp），别去动别的 dsh 进程。

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const KILL = args.includes('--kill')
const PROFILE = (() => {
  const i = args.indexOf('--profile')
  return i >= 0 && args[i + 1] ? args[i + 1] : 'llminqq-acp'
})()
const MAX_AGE_HOURS = (() => {
  const i = args.indexOf('--max-age-hours')
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : 0 // 0 = 不限
})()

const log = (m) => console.log(m)

/** 读 /proc/<pid>/cmdline → argv 数组（\0 分隔） */
function readCmdline (pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')
    return raw.split('\0').filter(Boolean)
  } catch {
    return null
  }
}

/** 读 PPid */
function readPpid (pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    // 格式：pid (comm) state ppid ...  comm 里可能有空格/括号，所以按最后一个 ')' 切
    const after = stat.slice(stat.lastIndexOf(')') + 2)
    return Number(after.split(' ')[1])
  } catch {
    return null
  }
}

/** 进程启动时间（秒级 epoch），从 /proc/<pid>/stat 的 starttime 换算 */
function readStartEpoch (pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const startTicks = Number(after[19]) // 第 22 个字段（1-based），切掉前两个后索引 19
    const btime = Number(
      fs.readFileSync('/proc/stat', 'utf8')
        .split('\n').find(l => l.startsWith('btime '))?.split(' ')[1] || 0,
    )
    const hz = 100 // Linux 常见 USER_HZ
    return btime + startTicks / hz
  } catch {
    return null
  }
}

/** 判断 pid 是否在调用方祖先链里（自己/父/祖父…） */
function ancestorsOfSelf () {
  const set = new Set()
  let pid = process.pid
  for (let i = 0; i < 32 && pid > 1; i++) {
    set.add(pid)
    const ppid = readPpid(pid)
    if (!ppid || ppid === pid) break
    pid = ppid
  }
  set.add(1)
  return set
}

/** 这个进程是不是我们要找的 ACP 子进程 */
function isTargetAcp (argv) {
  if (!argv || argv.length < 2) return false
  const joined = argv.join(' ')

  // ① 必须有 --profile <本 profile>（两种形式都认）
  //    真实进程：argv = ['node','/path/dsh','--profile','llminqq-acp']
  //    也有人 / 测试用 exec -a 把整串塞进 argv[0]，那也要能认
  let profileOk = false
  const idx = argv.indexOf('--profile')
  if (idx >= 0 && argv[idx + 1] === PROFILE) {
    profileOk = true
  } else {
    // 单串形式：--profile 后面紧跟 profile 名
    const m = /(?:^|\s)--profile\s+(\S+)/.exec(joined)
    profileOk = !!m && m[1] === PROFILE
  }
  if (!profileOk) return false

  // ② 必须确实是 dsh 启动的（避免误杀别的同名 profile 进程）
  const isDsh = argv.some(a => /(?:^|\/)dsh$/.test(a)) || /(?:^|\/)dsh\s/.test(joined)
  if (!isDsh) return false

  // ③ 排除明显不是 agent 的东西：ping/sleep 这种兜底用的测试替身也认（它们是同一 argv）
  //    这里不额外限制 —— 只要 profile 名对上，就是我们的。
  return true
}

const skip = ancestorsOfSelf()
const now = Date.now() / 1000

let found = 0
let orphans = 0
let killed = 0
const report = []

let pids = []
try {
  pids = fs.readdirSync('/proc').filter(d => /^\d+$/.test(d)).map(Number)
} catch (err) {
  console.error(`读 /proc 失败: ${err.message}`)
  process.exit(1)
}

for (const pid of pids) {
  if (skip.has(pid)) continue
  const argv = readCmdline(pid)
  if (!isTargetAcp(argv)) continue
  found += 1
  const ppid = readPpid(pid)
  const startedAt = readStartEpoch(pid)
  const ageH = startedAt ? (now - startedAt) / 3600 : null

  // ① 孤儿判定：PPid == 1，或 PPid 已不存在
  const parentAlive = ppid != null && ppid > 1 && fs.existsSync(`/proc/${ppid}`)
  const isOrphan = !parentAlive

  if (!isOrphan) {
    report.push(`  · PID ${pid} 父进程 ${ppid} 存活 → 跳过（不是孤儿）`)
    continue
  }
  orphans += 1

  const ageStr = ageH == null ? '?' : `${ageH.toFixed(1)}h`
  if (MAX_AGE_HOURS > 0 && ageH != null && ageH < MAX_AGE_HOURS) {
    report.push(`  · PID ${pid} 孤儿但只挂了 ${ageStr} < ${MAX_AGE_HOURS}h → 跳过`)
    continue
  }

  report.push(`  · PID ${pid} 孤儿（PPid=${ppid}）挂机 ${ageStr} → ${KILL ? '杀死' : '待杀'}`)
  if (KILL) {
    try {
      process.kill(pid, 'SIGTERM')
      killed += 1
    } catch (err) {
      report.push(`      ⚠️ 杀 ${pid} 失败: ${err.message}`)
    }
  }
}

log(`[cleanup-acp] profile=${PROFILE} 模式=${KILL ? 'KILL' : 'dry-run'} 最大年龄=${MAX_AGE_HOURS || '不限'}h`)
log(`[cleanup-acp] 扫描 ${pids.length} 个进程：命中本 profile ${found} 个，其中孤儿 ${orphans} 个`)
if (report.length) {
  log('[cleanup-acp] 明细：')
  for (const r of report) log(r)
} else {
  log('[cleanup-acp] 没有需要处理的孤儿进程')
}

if (KILL && killed > 0) {
  // 给 1.5s 优雅退出，再对顽固的补 SIGKILL
  await new Promise(r => setTimeout(r, 1500))
  let forceKilled = 0
  for (const pid of pids) {
    if (skip.has(pid)) continue
    const argv = readCmdline(pid)
    if (!isTargetAcp(argv)) continue
    const ppid = readPpid(pid)
    const parentAlive = ppid != null && ppid > 1 && fs.existsSync(`/proc/${ppid}`)
    if (parentAlive) continue
    try {
      process.kill(pid, 'SIGKILL')
      forceKilled += 1
    } catch { /* 已经死了 */ }
  }
  log(`[cleanup-acp] 已杀 ${killed} 个（SIGTERM），补杀 ${forceKilled} 个顽固的（SIGKILL）`)
}

process.exit(0)
