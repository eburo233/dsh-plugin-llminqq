#!/usr/bin/env node
// lib/agent/memory-migrate.mjs —— 把「脚本版」的记忆数据搬进插件 stateDir
// ============================================================================
// 这是**一次性**的手动操作（用户自己触发），不是插件启动时自动做的事：
// 自动导入别人的旧数据会让「我装了插件为什么它记得我没说过的事」变成灵异事件。
//
// 用法：
//   node lib/agent/memory-migrate.mjs --from /home/<user>/dsh/LLMinQQ/qq-agent/memory
//   node lib/agent/memory-migrate.mjs --from <dir> --to ~/.dsh/llminqq --dry-run
//   node lib/agent/memory-migrate.mjs --from <dir> --force        # 覆盖已有数据
//
// 为什么不能 `cp mem.db`（本任务描述里的原话，也是这里最关键的实现细节）：
//   SQLite 是**页式**文件，写事务进行中直接 cp 可能拷到「撕裂」的半页快照
//   （journal 里的内容还没落进主库）。拷出来的库能打开，但可能缺行/索引坏 ——
//   最坏的情况是**静默少了几百条记忆**，比直接失败糟糕得多。
//
//   正确做法是走 SQLite 的 **backup API**：它在读事务里做一致快照，
//   源码库同时在写也没问题（拿到的是某个瞬间的完整状态）。
//   本机有两种可选实现：
//     · python3 内置 `sqlite3.Connection.backup()`（标准库，最稳，优先用）
//     · 没有 python 时退到 `sqlite3` CLI 的 `.backup`
//   两个都没有就**明确报错**，绝不退回 cp（那等于把风险重新引进来）。
//
// 要知道的一件事：**`.learn-cursor` 别丢**。它是「语料池学到哪了」的游标，
// 丢了之后 learn 会从池子第一段重新吃一遍 —— 白烧 10-20 分钟 + 可能把
// 已经淘汰的低分词条重新灌回去。旧的游标文件名在不同版本里有两个
// （`.learn-cursor.json` / corpus 内的同名文件），所以按「两种名字都找」处理。
// ============================================================================
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { memoryPaths, memoryStateDir, ensureMemoryStateDir } from './dirs.mjs'
import { probePython } from '../pyprobe.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function arg (name, def = null) {
  const i = process.argv.indexOf(`--${name}`)
  if (i < 0) return def
  const v = process.argv[i + 1]
  if (!v || v.startsWith('--')) return true // 布尔型开关
  return v
}
const has = name => process.argv.includes(`--${name}`)

/** 要搬的文件清单：名字 → 目标名（都不带目录，目录由 stateDir 决定）。 */
const FILES = [
  { src: 'mem.db', dst: 'mem.db', kind: 'sqlite', required: true },
  { src: 'style.db', dst: 'style.db', kind: 'sqlite', required: false },
  { src: 'lexicon.json', dst: 'lexicon.json', kind: 'copy', required: false },
  { src: 'digest.md', dst: 'digest.md', kind: 'copy', required: false },
  { src: 'style-cases.jsonl', dst: 'style-cases.jsonl', kind: 'copy', required: false },
  // ingest 游标：不搬会导致下次 ingest 从头重放整个 bridge.out（重复记忆会被
  // fp 去重挡住，但 hits 会被虚增 —— 重要性判断跟着失真）
  { src: '.ingest_cursor', dst: '.ingest_cursor', kind: 'copy', required: false },
  // 语料池游标（两个历史名字都试，见文件头注释）
  { src: '.learn-cursor.json', dst: '.learn-cursor.json', kind: 'copy', required: false },
  { src: 'corpus/.learn-cursor.json', dst: '.learn-cursor.json', kind: 'copy', required: false },
]

/** 目录型数据（整棵复制）。 */
const DIRS = [
  { src: 'corpus', dst: 'corpus' },
  { src: 'log', dst: 'log' },
]

function whichSync (bin) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  return r.status === 0 ? String(r.stdout || '').trim().split('\n')[0] : null
}

/**
 * 用 SQLite backup API 拷库（一致快照，热拷也不会撕裂）。
 * 优先 python3 标准库，退到 sqlite3 CLI。都不行 → 抛错（**绝不 cp**）。
 */
function sqliteBackup (src, dst, log) {
  try { fs.mkdirSync(path.dirname(dst), { recursive: true }) } catch { /* ignore */ }
  try { fs.rmSync(dst, { force: true }) } catch { /* 覆盖旧目标 */ }

  const probe = probePython({ log: () => {} })
  if (probe.ok) {
    const py = [
      'import sqlite3,sys',
      'src,dst=sys.argv[1],sys.argv[2]',
      "s=sqlite3.connect('file:%s?mode=ro'%src,uri=True)",
      'd=sqlite3.connect(dst)',
      's.backup(d)',
      'd.close();s.close()',
      'print("ok")',
    ].join('\n')
    const r = spawnSync(probe.bin, [...(probe.preArgs || []), '-c', py, src, dst], { encoding: 'utf8', timeout: 120000 })
    if (r.status === 0 && /ok/.test(String(r.stdout))) return 'python-sqlite3-backup'
    log(`  python backup 失败（${r.status}）：${String(r.stderr || '').trim().slice(0, 160)}，改试 sqlite3 CLI`)
  }
  const cli = whichSync('sqlite3')
  if (cli) {
    const r = spawnSync(cli, [src, `.backup ${dst}`], { encoding: 'utf8', timeout: 120000 })
    if (r.status === 0 && fs.existsSync(dst)) return 'sqlite3-cli-backup'
    log(`  sqlite3 CLI backup 失败（${r.status}）：${String(r.stderr || '').trim().slice(0, 160)}`)
  }
  throw new Error('没有可用的 SQLite backup 实现（缺 python3 / sqlite3 CLI）。'
    + '为了不把库拷坏，这里**不会**退回到 cp —— 请先装 python3，再重跑。')
}

/** 统计 mem.db 条数（用 python，因为没有 python 时上面已经抛过了）。 */
function countRows (db, log) {
  const probe = probePython({ log: () => {} })
  if (!probe.ok) return null
  const py = [
    'import sqlite3,sys,json',
    "c=sqlite3.connect('file:%s?mode=ro'%sys.argv[1],uri=True)",
    "t=c.execute(\"select count(*) from sqlite_master where type='table'\").fetchone()[0]",
    "n=c.execute('select count(*) from entries').fetchone()[0] if t else 0",
    "r=c.execute('select count(*) from entries where retired=0').fetchone()[0] if t else 0",
    'print(json.dumps({"tables":t,"entries":n,"alive":r}))',
  ].join('\n')
  const r = spawnSync(probe.bin, [...(probe.preArgs || []), '-c', py, db], { encoding: 'utf8', timeout: 60000 })
  if (r.status !== 0) return null
  try { return JSON.parse(String(r.stdout).trim().split('\n').pop()) } catch { return null }
}

/** 脚本版是否还在跑？—— 提示用户先停，否则备份虽安全，但新老两边会同时写记忆。 */
function scriptVersionRunning () {
  const r = spawnSync(process.platform === 'win32' ? 'tasklist' : 'ps', process.platform === 'win32' ? ['/FI', 'IMAGENAME eq node.exe'] : ['-eo', 'args'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  const out = String(r.stdout || '')
  const hits = []
  // 只看「跑 bridge/index.js」和「跑 memctl.py」的进程
  for (const line of out.split('\n')) {
    if (/bridge[/\\]index\.js/.test(line) && !/dsh-plugin-llminqq/.test(line)) hits.push('bridge/index.js')
    if (/memctl\.py/.test(line) && !/dsh-plugin-llminqq/.test(line)) hits.push('memctl.py')
  }
  return [...new Set(hits)]
}

function main () {
  const from = arg('from')
  const dryRun = has('dry-run')
  const force = has('force')
  if (!from || from === true) {
    console.error('用法: node lib/agent/memory-migrate.mjs --from <脚本版 memory 目录> [--to <stateDir>] [--dry-run] [--force]')
    return 2
  }
  const srcDir = path.resolve(String(from).replace(/^~/, os.homedir()))
  if (!fs.existsSync(srcDir)) {
    console.error(`源目录不存在：${srcDir}`)
    return 2
  }
  // --to 覆盖：解析成一个「假的 cfg」交给 dirs，保持「stateDir 只有一个真源」
  const toArg = arg('to')
  const cfg = toArg && toArg !== true ? { memory: { stateDir: String(toArg) } } : {}
  const stateDir = memoryStateDir(cfg)
  const paths = memoryPaths(cfg)

  console.log(`源：    ${srcDir}`)
  console.log(`目标：  ${stateDir}${dryRun ? '（dry-run，不写任何文件）' : ''}`)
  console.log('')

  // ── 前置检查 ①：脚本版还在跑吗 ──────────────────────────────────────────
  const running = scriptVersionRunning()
  console.log('== 1. 前置检查 ==')
  if (running.length) {
    console.log(`  ⚠️ 检测到脚本版仍在运行：${running.join(', ')}`)
    console.log('     建议先停掉它再迁移，否则两边会同时写记忆（库本身有写锁，不会坏，但会互相抢）。')
    if (!force) {
      console.log('     确认要继续（新老不会同时跑）就加 --force，或先停掉脚本版。')
      return 3
    }
    console.log('     --force 已给，继续。')
  } else {
    console.log('  ✓ 没检测到脚本版在跑')
  }

  // ── 前置检查 ②：源库能被读、有几条 ─────────────────────────────────────
  const srcCount = countRows(path.join(srcDir, 'mem.db'), () => {})
  if (!srcCount) {
    console.error(`  ✗ 读不出源库 ${path.join(srcDir, 'mem.db')} 的条数（库坏了？路径不对？）`)
    return 4
  }
  console.log(`  ✓ 源库：${srcCount.entries} 条（有效 ${srcCount.alive} 条，${srcCount.tables} 张表）`)

  // ── 目标已有数据？ ──────────────────────────────────────────────────────
  const existing = countRows(paths.db, () => {})
  if (existing && existing.entries > 0) {
    console.log(`\n== 2. 目标已有记忆（${existing.entries} 条）==`)
    if (!force) {
      console.log('  ✗ 已存在数据，拒绝覆盖（迁移是破坏性的）。')
      console.log('     想覆盖就加 --force；想保留两份就先用 --to 指到别处。')
      return 5
    }
    console.log('  --force 已给：会覆盖目标数据。')
  }

  if (dryRun) {
    console.log('\n== dry-run 清单 ==')
    for (const f of FILES) {
      const p = path.join(srcDir, f.src)
      console.log(`  ${fs.existsSync(p) ? '✓' : '·'} ${f.src}${fs.existsSync(p) ? '' : '（源里没有，跳过）'}`)
    }
    for (const d of DIRS) {
      const p = path.join(srcDir, d.src)
      const n = fs.existsSync(p) ? fs.readdirSync(p).length : 0
      console.log(`  ${n ? '✓' : '·'} ${d.src}/${n ? `（${n} 个文件）` : '（源里没有，跳过）'}`)
    }
    console.log('\ndry-run 结束，未写入任何文件。')
    return 0
  }

  // ── 真正搬 ──────────────────────────────────────────────────────────────
  console.log('\n== 3. 创建 stateDir ==')
  const ensure = ensureMemoryStateDir(cfg)
  console.log(`  ✓ ${ensure.stateDir}${ensure.created ? '（新建）' : ''}`)

  console.log('\n== 4. 搬数据 ==')
  const log = m => console.log(`  ${m}`)
  const copied = []
  const skipped = []
  for (const f of FILES) {
    const src = path.join(srcDir, f.src)
    const dst = path.join(stateDir, f.dst)
    if (!fs.existsSync(src)) {
      if (f.required) {
        console.error(`  ✗ 必需文件缺失：${f.src}`)
        return 6
      }
      skipped.push(f.src)
      continue
    }
    try {
      if (f.kind === 'sqlite') {
        const method = sqliteBackup(src, dst, log)
        console.log(`  ✓ ${f.src} → ${f.dst}（${method}）`)
      } else {
        fs.copyFileSync(src, dst)
        try { fs.chmodSync(dst, 0o600) } catch { /* ignore */ }
        console.log(`  ✓ ${f.src} → ${f.dst}`)
      }
      copied.push(f.dst)
    } catch (err) {
      console.error(`  ✗ ${f.src} 失败：${err.message}`)
      return 7
    }
  }

  for (const d of DIRS) {
    const src = path.join(srcDir, d.src)
    const dst = path.join(stateDir, d.dst)
    if (!fs.existsSync(src)) { skipped.push(`${d.src}/`); continue }
    try {
      fs.mkdirSync(dst, { recursive: true })
      // 只复制文件（语料池是平铺的 json；log 是平铺的 jsonl），不跟符号链接
      let n = 0
      for (const name of fs.readdirSync(src)) {
        const s = path.join(src, name)
        if (!fs.statSync(s).isFile()) continue
        fs.copyFileSync(s, path.join(dst, name))
        n++
      }
      console.log(`  ✓ ${d.src}/ → ${d.dst}/（${n} 个文件）`)
      copied.push(`${d.dst}/`)
    } catch (err) {
      console.error(`  ✗ ${d.src}/ 失败：${err.message}`)
      return 7
    }
  }

  // ── 校验（这是整个工具唯一有意义的部分：条数对不上就别说过成功了）──────
  console.log('\n== 5. 校验 ==')
  const dstCount = countRows(paths.db, log)
  if (!dstCount) {
    console.error('  ✗ 读不出目标库条数 —— 迁移结果不可信')
    return 8
  }
  const ok = dstCount.entries === srcCount.entries
  console.log(`  条数：源 ${srcCount.entries} → 目标 ${dstCount.entries}  ${ok ? '✓ 一致' : '✗ 不一致'}`)
  console.log(`  有效：源 ${srcCount.alive} → 目标 ${dstCount.alive}  ${dstCount.alive === srcCount.alive ? '✓ 一致' : '✗ 不一致'}`)
  if (!ok) {
    console.error('  ✗ 条数不一致，迁移不可信。目标目录留着排查，别拿它当真数据。')
    return 8
  }
  const cursorOk = fs.existsSync(path.join(stateDir, '.learn-cursor.json'))
  console.log(`  ${cursorOk ? '✓' : '·'} 语料池游标（.learn-cursor.json）${cursorOk ? '已搬' : '源里没有'}`)
  console.log(`\n完成。搬了 ${copied.length} 项${skipped.length ? `，源里没有而跳过：${skipped.join(', ')}` : ''}。`)
  console.log(`数据目录：${stateDir}`)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exit(main())
}

export { main, sqliteBackup, countRows }
