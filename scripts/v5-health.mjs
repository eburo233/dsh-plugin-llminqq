#!/usr/bin/env node
// scripts/v5-health.mjs —— 记忆 v5 上线后的「体检 + 自愈」脚本
// ============================================================================
// 为什么需要它（2026-11-07 的真实教训）：
//   这几个检查是我这两天**手工反复敲**的 —— 每次桥/宿主重启后都要重新确认一遍：
//     · engine 到底是不是 v5？（重启前是 v4，重启后才对）
//     · 记忆子进程的模型路由还在不在？（宿主重写 bridge-config 会把它抹掉）
//     · 是不是又起了两个桥？（双桥会双发消息，11-06 真实事故）
//     · distill 追平没有？有没有死信作业？
//     · WAL 有没有又涨到几 MB？数据完整吗？
//   手工敲的问题不是慢，是**会漏**：漏一条就以为「都好了」。
//
// 用法：
//   node scripts/v5-health.mjs                 # 只体检，报告问题，退出码 0/1/2
//   node scripts/v5-health.mjs --fix           # 体检 + 把缺的字段补进 bridge-config
//   node scripts/v5-health.mjs --json          # 机器可读（给别的脚本用）
//   node scripts/v5-health.mjs --data-dir <d>  # 指定插件数据目录（默认自动找）
//
// 退出码：0 全好 / 1 有警告 / 2 有严重问题
//
// --fix 只做**确定安全**的事：把 config.json 里已有的值补写进 bridge-config.json。
//   它**不**替你改用户配置、不动数据库、不重启进程（重启会打断对话，得人来决定）。
//   补完之后要重启桥才生效 —— 脚本会把这句话打出来。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')

const argv = process.argv.slice(2)
const argOf = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : '' }
const has = n => argv.includes(n)
const JSON_OUT = has('--json')
const FIX = has('--fix')

/** 插件数据目录：~/.dsh/dsh-plugin-llminqq（可用 DSH_HOME / LLMINQQ_DATA_DIR 覆盖）。 */
function dataDir () {
  const explicit = argOf('--data-dir') || process.env.LLMINQQ_DATA_DIR || ''
  if (explicit) return path.resolve(explicit.replace(/^~/, os.homedir()))
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(dshHome, 'dsh-plugin-llminqq')
}

const DATA = dataDir()
const cfgPath = path.join(DATA, 'bridge-config.json')
const userCfgPath = path.join(DATA, 'config.json')
const v5Db = path.join(DATA, 'agent', 'memory', 'mem-v5.db')
const v4Db = path.join(DATA, 'agent', 'memory', 'mem.db')
const logFile = path.join(DATA, 'logs', 'bridge.log')

const results = []
/** @param {'ok'|'warn'|'bad'} level */
function add (level, name, detail, hint = '') {
  results.push({ level, name, detail, hint })
  if (JSON_OUT) return
  const icon = level === 'ok' ? '✅' : level === 'warn' ? '⚠️ ' : '❌'
  console.log(`${icon} ${name}${detail ? ' — ' + detail : ''}`)
  if (hint && level !== 'ok') console.log(`     → ${hint}`)
}

const readJson = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } }
const exists = p => { try { fs.accessSync(p); return true } catch { return false } }

// ── 1) 配置文件 ──────────────────────────────────────────────────────────────
const bridgeCfg = readJson(cfgPath)
const userCfg = readJson(userCfgPath)
if (!bridgeCfg) {
  add('bad', 'bridge-config.json', `读不到：${cfgPath}`, '桥根本没起过？先启动插件')
} else {
  add('ok', 'bridge-config.json', '可读')
}

// engine：兼容两种形状（嵌套 memory.v5.engine 优先，其次旧的摊平 memory.engine）
const memCfg = bridgeCfg?.memory || {}
const engine = String(memCfg?.v5?.engine ?? memCfg?.engine ?? '').trim().toLowerCase() || 'v4'
const wantEngine = String(userCfg?.memory?.v5?.engine ?? '').trim().toLowerCase() || 'v4'
if (engine === 'v5') {
  add('ok', '引擎', 'engine=v5')
} else {
  add('bad', '引擎', `桥读到 engine=${engine}（v5 读路径没启用）`,
    `用户配置想要 engine=${wantEngine}。若 wantEngine=v5：说明宿主是旧代码，重启 DSH Web；`
    + `否则桥会一直走 v4。临时可用 LLMINQQ_MEMORY_ENGINE=v5 环境变量强制。`)
}

// 记忆子进程的模型路由（宿主重写 bridge-config 时最容易被抹掉）
const refl = memCfg?.reflection
const wantRefl = userCfg?.memory?.reflection
const reflOk = refl && typeof refl === 'object' && String(refl.model ?? '').trim()
if (reflOk) {
  add('ok', '记忆子进程路由', `${refl.provider || '继承'}/${refl.model}`)
} else if (wantRefl && String(wantRefl.model ?? '').trim()) {
  add('warn', '记忆子进程路由', 'bridge-config 里缺失，但用户配置里有',
    '宿主是旧代码，重写 bridge-config 时把它抹掉了。--fix 可补；或重启 DSH Web 根治')
} else {
  add('ok', '记忆子进程路由', '未配置（继承主对话路由，合法）')
}

// ── 2) 进程：必须恰好一个桥 ─────────────────────────────────────────────────
let bridgePids = []
try {
  const out = execFileSync('pgrep', ['-f', 'bridge/index.js'], { encoding: 'utf8' })
  bridgePids = out.split('\n').map(s => s.trim()).filter(Boolean).filter(pid => {
    // 排除 pgrep 自己 / shell 包装
    try { return /bridge[\/\\]index\.js/.test(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ')) } catch { return true }
  })
} catch { /* pgrep 无匹配（退出码 1）就是 0 个 */ }
if (bridgePids.length === 1) add('ok', '桥进程', `1 个（pid=${bridgePids[0]}）`)
else if (bridgePids.length === 0) add('bad', '桥进程', '没有桥在跑', '机器人不会回消息。启动桥：见 docs 的「恢复操作」')
else add('bad', '桥进程', `${bridgePids.length} 个（${bridgePids.join(',')}）`,
  '双桥会重复处理同一条消息、双发回复（11-06 真实事故）。杀掉多余的，只留一个')

// ── 3) 数据：distill 水位 / 死信 / WAL / 完整性 ─────────────────────────────
function querySqlite (dbPath, sql) {
  try {
    return execFileSync('sqlite3', [`file:${dbPath}?mode=ro`, sql], { encoding: 'utf8' }).trim()
  } catch (err) { return null }
}
if (exists(v5Db)) {
  const counts = querySqlite(v5Db,
    "select (select count(*) from events)||'|'||(select count(*) from memories)||'|'||" +
    "(select count(*) from utterances)||'|'||(select count(*) from profiles);")
  if (counts) {
    const [ev, mem, utt, prof] = counts.split('|').map(Number)
    add('ok', 'v5 数据', `events ${ev} · memories ${mem} · utterances ${utt} · profiles ${prof}`)

    const wm = Number(querySqlite(v5Db, "select v from v5_meta where k='distill:watermark';") || 0)
    const backlog = ev - wm
    if (backlog <= 0) add('ok', 'distill 水位', `${wm} / ${ev}（已追平）`)
    else if (backlog < 100) add('ok', 'distill 水位', `${wm} / ${ev}（积压 ${backlog}，约 ${Math.ceil(backlog / 20)} 轮）`)
    else add('warn', 'distill 水位', `${wm} / ${ev}（积压 ${backlog}）`,
      '积压大说明 distill 跑得慢或失败。看 jobs 表的 dead 作业和 v5_meta 的 last_error')

    const dead = Number(querySqlite(v5Db, "select count(*) from jobs where state='dead';") || 0)
    const lastErr = querySqlite(v5Db, "select v from v5_meta where k='distill:last_error';") || ''
    if (dead > 0 || lastErr) {
      add('warn', 'distill 错误', `${dead} 个死信作业${lastErr ? '；' + lastErr.slice(0, 60) : ''}`,
        '常见原因：模型超时（把 memory.reflection 指向快模型，见 --fix）或路由不可用')
    } else add('ok', 'distill 错误', '无')

    const integ = querySqlite(v5Db, 'pragma integrity_check;')
    if (integ === 'ok') add('ok', '库完整性', 'ok')
    else add('bad', '库完整性', String(integ).slice(0, 100), '**先备份再动**；可能需要从 backups/ 恢复')
  } else {
    add('warn', 'v5 库', `查不了数据（sqlite3 缺失或库损坏）：${v5Db}`)
  }

  // WAL：大涨说明周期性 checkpoint 没跑（§7 那个「只拷 .db 是空库」的坑）
  try {
    const wal = path.join(DATA, 'agent', 'memory', 'mem-v5.db-wal')
    const sz = fs.existsSync(wal) ? fs.statSync(wal).size : 0
    if (sz > 4 * 1024 * 1024) add('warn', 'WAL 大小', `${(sz / 1048576).toFixed(1)}MB`, '周期性 checkpoint 可能没跑；备份时记得连 -wal/-shm 一起拷')
    else add('ok', 'WAL 大小', `${Math.round(sz / 1024)}KB`)
  } catch { /* ignore */ }
} else {
  add('warn', 'v5 库', `不存在：${v5Db}`, '还没迁移或路径不对（--data-dir 指定）')
}

// v4 库必须还在（回滚的唯一依据，绝不能被删）
if (exists(v4Db)) {
  const n = Number(querySqlite(v4Db, 'select count(*) from entries;') || 0)
  add('ok', 'v4 库（回滚用）', `entries ${n}`)
} else {
  add('bad', 'v4 库（回滚用）', `不存在：${v4Db}`, '**别继续操作**：回滚能力没了，先从 backups/ 恢复')
}

// ── 4) 日志健康（EPIPE 死循环是历史重灾）─────────────────────────────────────
if (exists(logFile)) {
  try {
    const st = fs.statSync(logFile)
    add('ok', 'bridge.log', `${(st.size / 1048576).toFixed(1)}MB`)
    // 只扫尾部 2MB，别把几百 MB 的日志读进内存
    const fd = fs.openSync(logFile, 'r')
    const start = Math.max(0, st.size - 2 * 1024 * 1024)
    const buf = Buffer.alloc(st.size - start)
    fs.readSync(fd, buf, 0, buf.length, start)
    fs.closeSync(fd)
    let tail = buf.toString('utf8')
    // ⚠️ 只看**本次桥启动之后**的日志。
    //   第一版直接数尾部 2MB 里的 EPIPE，结果把修复前的历史记录也算进来了
    //   （实测报 2692 次「严重」，其实那批全在旧进程里，当前进程一次都没有）。
    //   判据：日志里最后一次「=== LLMinQQ bridge 启动 ===」之后的内容才算数。
    const startMarker = '=== LLMinQQ bridge 启动 ==='
    const lastStart = tail.lastIndexOf(startMarker)
    if (lastStart > 0) tail = tail.slice(lastStart)
    const epipe = (tail.match(/write EPIPE/g) || []).length
    if (epipe > 25) {
      add('bad', 'EPIPE', `本次启动后 ${epipe} 次 write EPIPE`,
        'stdout 熔断没生效（桥版本旧？）。桥侧修复见 commit b5df201，重启桥即生效')
    } else add('ok', 'EPIPE', epipe === 0 ? '本次启动后无' : `本次启动后 ${epipe} 次（可接受）`)
    const v4fb = (tail.match(/本轮改用 v4/g) || []).length
    if (v4fb > 0) add('warn', 'v4 回退', `尾部 ${v4fb} 次`, 'v5 检索出错才会回退；看日志里的 reason')
    else add('ok', 'v4 回退', '0 次')
  } catch { /* ignore */ }
}

// ── 5) --fix：把用户配置里已有的值补回 bridge-config ────────────────────────
if (FIX && bridgeCfg && userCfg) {
  let changed = false
  const mem = bridgeCfg.memory = bridgeCfg.memory || {}
  const wantV5 = userCfg?.memory?.v5
  if (wantV5 && !mem.v5) {
    // 只在用户配置里明确有 v5 段时补，别凭空造
    mem.v5 = {
      enabled: wantV5.enabled !== false,
      engine: String(wantV5.engine ?? '').trim().toLowerCase() === 'v5' ? 'v5' : 'v4',
      distill: wantV5.distill || { enabled: true, intervalMin: 10 },
    }
    changed = true
    add('ok', '已补', 'memory.v5（嵌套形状）')
  }
  const wantR = userCfg?.memory?.reflection
  if (wantR && String(wantR.model ?? '').trim() && !mem.reflection) {
    mem.reflection = wantR
    changed = true
    add('ok', '已补', `memory.reflection=${wantR.provider || ''}/${wantR.model}`)
  }
  // 旧的摊平字段在补了嵌套之后要清掉，避免两套并存被误读
  if (mem.v5 && (mem.engine !== undefined || mem.distill !== undefined)) {
    delete mem.engine
    delete mem.distill
    changed = true
    add('ok', '已清', '摊平残留（memory.engine/distill）')
  }
  if (changed) {
    try {
      fs.writeFileSync(cfgPath, JSON.stringify(bridgeCfg, null, 2) + '\n', { mode: 0o600 })
      add('ok', '已写入', cfgPath)
      console.log('\n⚠️  bridge-config 改了，**要重启桥才生效**（重启会短暂断线，自己挑时间）：')
      console.log('   kill -TERM $(pgrep -f "bridge/index.js" | head -1)')
    } catch (err) {
      add('bad', '写入失败', err.message)
    }
  } else if (!JSON_OUT) {
    console.log('\n（--fix：没有需要补的字段）')
  }
}

// ── 汇总 ────────────────────────────────────────────────────────────────────
const bad = results.filter(r => r.level === 'bad').length
const warn = results.filter(r => r.level === 'warn').length
if (JSON_OUT) {
  console.log(JSON.stringify({ ok: bad === 0, bad, warn, results }, null, 2))
} else {
  console.log(`\n合计：${results.filter(r => r.level === 'ok').length} 项正常 · ${warn} 项警告 · ${bad} 项严重`)
  if (bad > 0) console.log('有严重问题，按上面的 → 提示处理。')
}
process.exit(bad > 0 ? 2 : warn > 0 ? 1 : 0)
