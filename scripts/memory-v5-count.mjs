#!/usr/bin/env node
// scripts/memory-v5-count.mjs —— 记忆 v5 Step 1 的**只读**验收脚本（task-15）
// ============================================================================
// 验收标准（docs/MEMORY-AUDIT-AND-V5.md §4 Step 1）：
//   `events` 条数 ≈ 桥日志（bridge.out）里可解析的「入站 + 出站」行数。
//
// 为什么「≈」不是「=」：
//   ① 出站：bridge.out 的 `出站 ...` 是**每个 LLM 回合**一行（写在 deliverReply
//      之前），而 events 是**每条真正发出去的 QQ 消息** —— 一段回复会被 chunkText
//      或 [SPLIT] 拆成 N 条，图片/语音也各记一条 → events(出站) 通常 ≥ 日志行数。
//   ② SILENT / 旁听沉默：日志有 `出站 ... text="[SILENT]..."`（模型输出被记了），
//      但一条都没发 → events 少。
//   ③ 纯撤回：只撤不发，两个方向都不写 event。
//   ④ 写库失败降级、被 allow 判定/节流丢掉的消息：events 少（日志也少 —— 入站
//      日志在节流之后，所以入站基本 1:1）。
//   ⑤ 合并轮：一条合成事件（msg_id=merged-<ts>）对应 bridge.out 里一行合成 `入站`。
//
// 所以脚本输出的是**偏差表 + 逐项解释**，不是 PASS/FAIL 断言。
//
// 用法：
//   # 先把生产库/日志**复制**到 /tmp（本脚本不会、也不该直接读生产现场）
//   cp ~/.dsh/dsh-plugin-llminqq/agent/memory/mem-v5.db /tmp/mem-v5.db
//   cp ~/.dsh/dsh-plugin-llminqq/agent/memory/bridge.out  /tmp/bridge.out
//   node scripts/memory-v5-count.mjs --db /tmp/mem-v5.db --log /tmp/bridge.out
//   node scripts/memory-v5-count.mjs --db /tmp/mem-v5.db --json
//
// 安全：db 用 readOnly 打开（写会直接报 readonly）；日志只 readFileSync；不写任何文件。
//       默认拒绝 ~/.dsh 下的生产路径（防手滑），--allow-prod 才放行（仍然只读）。
// ============================================================================

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

function parseArgs (argv) {
  const out = { json: false, allowProd: false, db: '', log: '' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') out.json = true
    else if (a === '--allow-prod') out.allowProd = true
    else if (a === '--db') out.db = argv[++i] ?? ''
    else if (a === '--log') out.log = argv[++i] ?? ''
    else if (a === '-h' || a === '--help') { out.help = true } else {
      console.error(`[count] 不认识的参数：${a}`)
      out.help = true
    }
  }
  return out
}

/** 看起来像生产现场的路径：~/.dsh 或 DSH_HOME 下面。 */
function looksLikeProd (p) {
  const resolved = path.resolve(p)
  const home = os.homedir()
  const dshHome = process.env.DSH_HOME ? path.resolve(process.env.DSH_HOME) : path.join(home, '.dsh')
  const prodRoots = [path.join(home, '.dsh'), dshHome, '/mnt/llminqq-data']
  return prodRoots.some(root => resolved === root || resolved.startsWith(root + path.sep))
}

function die (code, msg) {
  console.error(`[count] ${msg}`)
  process.exit(code)
}

/** 打开 v5 库（只读）。找不到 db 时给一句能照着做的提示。 */
function openReadOnly (dbPath) {
  if (!fs.existsSync(dbPath)) die(2, `v5 库不存在：${dbPath}（Step 1 双写还没跑过？）`)
  let DatabaseSync = null
  try {
    ;({ DatabaseSync } = require('node:sqlite'))
  } catch (err) {
    die(2, `当前 Node 没有 node:sqlite（需要 ≥22.5）：${err.message}`)
  }
  try {
    return new DatabaseSync(dbPath, { readOnly: true })
  } catch (err) {
    die(2, `打不开 v5 库（只读）：${dbPath}：${err.message}`)
  }
}

/** 解析 bridge.out：只认 `ISO时间 入站 ...` / `ISO时间 出站 ...` 两种行。 */
function parseBridgeLog (logPath) {
  const lines = fs.readFileSync(logPath, 'utf8').split('\n')
  const inboundRe = /^\S+ 入站 (\S+) from=/
  const outboundRe = /^\S+ 出站 (\S+) text="/
  const inbound = { total: 0, byConv: new Map() }
  const outbound = { total: 0, byConv: new Map() }
  let skipped = 0
  for (const line of lines) {
    if (!line) continue
    let m = line.match(inboundRe)
    if (m) {
      inbound.total++
      inbound.byConv.set(m[1], (inbound.byConv.get(m[1]) ?? 0) + 1)
      continue
    }
    m = line.match(outboundRe)
    if (m) {
      outbound.total++
      outbound.byConv.set(m[1], (outbound.byConv.get(m[1]) ?? 0) + 1)
      continue
    }
    skipped++
  }
  return { lines: lines.length - 1, inbound, outbound, skipped }
}

function topN (map, n = 5) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
}

function main () {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.db) {
    console.log(`用法：node scripts/memory-v5-count.mjs --db <mem-v5.db> [--log <bridge.out>] [--json] [--allow-prod]
默认拒绝直接打开 ~/.dsh / $DSH_HOME / /mnt/llminqq-data 下的生产文件（先 cp 到 /tmp 再跑）。`)
    process.exit(args.help ? 0 : 1)
  }
  const dbPath = path.resolve(args.db.replace(/^~/, os.homedir()))
  const logPath = args.log ? path.resolve(args.log.replace(/^~/, os.homedir())) : ''
  if (!args.allowProd) {
    for (const p of [dbPath, logPath].filter(Boolean)) {
      if (looksLikeProd(p)) {
        die(3, `拒绝直接打开生产路径：${p}
请先复制到临时目录再跑（例：cp <path> /tmp/），或确认只读后加 --allow-prod。`)
      }
    }
  }

  const db = openReadOnly(dbPath)
  let stats
  try {
    const total = db.prepare('SELECT COUNT(*) AS n FROM events').get().n
    const speakers = db.prepare(`SELECT speaker, COUNT(*) AS n FROM events GROUP BY speaker ORDER BY n DESC`).all()
    const kinds = db.prepare(`SELECT kind_raw AS kind, COUNT(*) AS n FROM events GROUP BY kind_raw ORDER BY n DESC`).all()
    const convs = db.prepare(`SELECT conv, COUNT(*) AS n FROM events GROUP BY conv ORDER BY n DESC LIMIT 10`).all()
    const span = db.prepare('SELECT MIN(at) AS first, MAX(at) AS last FROM events').get()
    const self = speakers.find(r => r.speaker === 'self')?.n ?? 0
    const other = total - self
    stats = {
      total,
      self,
      other,
      speakers,
      kinds,
      convs,
      span: { first: span.first ?? null, last: span.last ?? null },
      // 检查 Step 1 最关心的两件事：全文有没有被截断、meta 是不是 JSON
      truncatedLike80: db.prepare('SELECT COUNT(*) AS n FROM events WHERE length(text) = 80').get().n,
      withMeta: db.prepare('SELECT COUNT(*) AS n FROM events WHERE meta IS NOT NULL').get().n,
    }
  } finally { db.close() }

  const log = logPath ? parseBridgeLog(logPath) : null
  const report = { dbPath, logPath: logPath || null, events: stats, bridgeLog: log, deviation: null }
  if (log) {
    report.deviation = {
      inbound: {
        events: stats.other,
        logLines: log.inbound.total,
        diff: stats.other - log.inbound.total,
      },
      outbound: {
        events: stats.self,
        logLines: log.outbound.total,
        diff: stats.self - log.outbound.total,
      },
    }
  }

  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  console.log('══ 记忆 v5 双写验收（只读）══')
  console.log(`库：${dbPath}`)
  console.log(`events 总数：${stats.total}（self ${stats.self} / 对方 ${stats.other}）`)
  if (stats.span.first) {
    console.log(`时间范围：${new Date(stats.span.first * 1000).toISOString()} → ${new Date(stats.span.last * 1000).toISOString()}`)
  }
  console.log(`kind 分布：${stats.kinds.map(r => `${r.kind ?? 'null'}=${r.n}`).join('  ')}`)
  console.log(`top 会话：${topN(new Map(stats.convs.map(r => [r.conv, r.n]))).map(([c, n]) => `${c}=${n}`).join('  ')}`)
  console.log(`length(text)=80（疑似 v4 截断）的条数：${stats.truncatedLike80}`)
  console.log(`meta 非空的条数：${stats.withMeta}`)
  if (log) {
    console.log('')
    console.log(`bridge.out：${logPath}（共 ${log.lines} 行，其它 ${log.skipped} 行）`)
    console.log(`  入站行 ${log.inbound.total}  / 出站行 ${log.outbound.total}`)
    const d = report.deviation
    console.log(`  偏差：入站 events ${d.inbound.events} - 日志 ${d.inbound.logLines} = ${d.inbound.diff}`)
    console.log(`        出站 events ${d.outbound.events} - 日志 ${d.outbound.logLines} = ${d.outbound.diff}`)
    console.log('')
    console.log('偏差解释（不要求严格相等，见脚本头注释）：')
    console.log('  · 入站：日志在节流/allow 之后，事件在同一位置写 → 理论 1:1；')
    console.log('    差值为负 = 有写库失败/空消息，为正 = 合并轮合成事件或日志行没落盘。')
    console.log('  · 出站：日志是一回合一行；events 是一条真实发出的 QQ 消息一条，')
    console.log('    拆分([SPLIT]/chunkText)、图片、语音会让 events 变多；')
    console.log('    SILENT/沉默回合、纯撤回只让日志变多。')
  }
  console.log('')
  console.log('（只读检查完成，未写入任何文件）')
}

main()
