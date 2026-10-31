// test/unit-log-runaway.test.mjs —— 「日志写满磁盘」的回归测试
//
// 背景（2026-11-01 用户实测）：`bridge.log` 几小时涨到 **35GB**，
// 把整块盘写满（115G 分区 0 可用），连 dsh 自己都起不来。
//
// 日志里是：
//    ERROR 未捕获异常（第 50130295 次，桥继续运行）: Error: write EPIPE
//    ...完整堆栈...
// **五千万次**。一行约 700 字节 → 35GB。
//
// 根因是自激死循环：
//   ① 宿主关了桥的 stdout 管道 → console.log 抛 EPIPE
//   ② 变成 uncaughtException → crashGuard 记录 ERROR
//   ③ crashGuard 里又 logger.log → 又 console.log → stdout 仍断 → 再抛 EPIPE
//   ④ 回到 ②，无限循环
//
// 三个修复点，各自都足以让循环继续，所以三层都要。
// 这个测试直接验证三层判据，并**不依赖 spawn 时序**（那个很难稳定复现）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SRC = fs.readFileSync(path.join(ROOT, 'lib', 'bridge', 'index.js'), 'utf8')

/**
 * 抽取源码里的某个函数体。
 *
 * 原来写死截 2400 字符，但 crashGuard / maybeRotateRuntime 里注释很长，
 * 截到一半会把后面的 `logger.log(...)`、`maybeRotateRuntime()` 调用截掉，
 * 断言就假失败了。这里按**花括号配平**取到函数真正结束的位置。
 */
function fnBody (name) {
  // 兼容 `function f ()` 和 `function f()` 两种写法
  const i = SRC.search(new RegExp(`function ${name}\\s*\\(`))
  assert.ok(i > 0, `定位不到 ${name}`)
  // 从函数第一个 { 开始配平
  const start = SRC.indexOf('{', i)
  assert.ok(start > 0, `${name} 没有函数体`)
  let depth = 0
  for (let k = start; k < SRC.length; k++) {
    const ch = SRC[k]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return SRC.slice(i, k + 1)
    }
  }
  return SRC.slice(i)
}

// ── ① stdout 熔断 ────────────────────────────────────────────────────────────

test('console.log 必须裹 try/catch（它是最外层异常源）', () => {
  const body = fnBody('writeStdout')
  assert.match(body, /try\s*\{/, 'writeStdout 里没有 try —— console.log 抛 EPIPE 会直接变 uncaughtException')
  assert.match(body, /catch/, 'writeStdout 没有 catch')
  assert.match(body, /console\.log\(line\)/, '写 stdout 的核心调用不见了')
})

test('stdout 断了之后必须永久停写（不能每行都再试一次）', () => {
  const body = fnBody('writeStdout')
  assert.match(body, /stdoutBroken/, '缺 stdoutBroken 熔断标志')
  assert.match(body, /if \(stdoutBroken\)/, '没有在入口处检查熔断标志')
  assert.match(body, /stdoutSkipCount\+\+/, '停写后没有计数（会无声无息地丢日志）')
})

// ── ② crashGuard 防递归 ─────────────────────────────────────────────────────

test('crashGuard 必须防重入（处理异常时再来的异常不能再写日志）', () => {
  const body = fnBody('crashGuard')
  assert.match(body, /inGuard/, '缺 inGuard 防重入标志 —— 这是死循环的直接成因')
  // 必须在写日志之前就 return
  const guardIdx = body.indexOf('if (inGuard) return')
  const logIdx = body.indexOf('logger.log(')
  assert.ok(guardIdx > 0, '没有 if (inGuard) return')
  assert.ok(guardIdx < logIdx, '防重入检查必须在写日志之前（否则等于没有）')
})

test('crashGuard 必须限流（同一种错误不能无限写）', () => {
  const body = fnBody('crashGuard')
  assert.match(body, /GUARD_DEDUP_MS/, '缺时间窗口')
  assert.match(body, /GUARD_DEDUP_MAX/, '缺次数上限')
  assert.match(body, /guardRecent/, '缺去重表')
})

// ── ③ 日志轮转 ─────────────────────────────────────────────────────────────

test('bridge.log 必须有大小上限（它从来没被轮转过，才会长到 35GB）', () => {
  assert.match(SRC, /const LOG_MAX_BYTES = /, '缺 LOG_MAX_BYTES —— 日志又会无限增长')
  const m = SRC.match(/const LOG_MAX_BYTES = (\d+) \* (\d+) \* (\d+)/)
  assert.ok(m, 'LOG_MAX_BYTES 不是明确的字节数')
  const bytes = Number(m[1]) * Number(m[2]) * Number(m[3])
  assert.ok(bytes <= 64 * 1024 * 1024,
    `日志上限太大（${Math.round(bytes / 1024 / 1024)}MB），应该 ≤64MB`)
  assert.match(SRC, /function rotateLogIfNeeded/, '缺轮转实现')
  assert.match(SRC, /rotateLogIfNeeded\(\)\n/, '启动时没有调用轮转')
})

test('运行期也要检查体积（桥是长驻进程，不能只在启动时滚）', () => {
  assert.match(SRC, /function maybeRotateRuntime/, '缺运行期轮转 —— 长跑几天又会写满磁盘')
  const body = fnBody('maybeRotateRuntime')
  assert.match(body, /logBytesWritten/, '没有累计写入计数')
  assert.match(body, /LOG_CHECK_EVERY/, '没有检查间隔（每行都 stat 会很费）')
  // log() 里必须真的调用它
  const logBody = fnBody('log')
  assert.match(logBody, /maybeRotateRuntime\(\)/, 'log() 里没调运行期轮转')
})

// ── ④ 逻辑等价性（不依赖 spawn 时序）────────────────────────────────────────

test('异常风暴：10 万次 crashGuard 只写有限行', () => {
  // 把三层逻辑按源码同样的语义拼起来跑，验证「风暴」不会刷爆
  const harness = `
    let stdoutBroken = false, stdoutSkip = 0, guardCount = 0, inGuard = false
    const guardRecent = new Map()
    const GUARD_DEDUP_MS = 60000, GUARD_DEDUP_MAX = 20
    const lines = []
    let writeAttempts = 0
    function writeStdout (line) {
      if (stdoutBroken) { stdoutSkip++; return }
      try { writeAttempts++; throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }) }
      catch { stdoutBroken = true }
    }
    function log (msg) { writeStdout(msg); lines.push(msg) }
    function crashGuard (kind, err) {
      guardCount++
      if (inGuard) return
      inGuard = true
      try {
        const key = kind + '|' + String(err?.code || err?.message).slice(0,80)
        const now = Date.now(); const rec = guardRecent.get(key)
        if (rec && now - rec.at < GUARD_DEDUP_MS) {
          rec.count++
          if (rec.count > GUARD_DEDUP_MAX) return
        } else guardRecent.set(key, { at: now, count: 1 })
        log('ERROR ' + kind + ': ' + err.message)
      } finally { inGuard = false }
    }
    for (let i = 0; i < 100000; i++) crashGuard('未捕获异常', new Error('write EPIPE'))
    return JSON.stringify({ writeAttempts, stdoutBroken, stdoutSkip, guardCount, loggedLines: lines.length })
  `
  const r = new Function(harness)()
  const j = JSON.parse(r)
  assert.ok(j.writeAttempts <= 60,
    `console.log 被调用了 ${j.writeAttempts} 次（应 ≤60）—— 熔断没生效，会无限写`)
  assert.ok(j.loggedLines <= 60,
    `日志写了 ${j.loggedLines} 行（应 ≤60）—— 10 万次风暴会变成几十 MB`)
  assert.equal(j.stdoutBroken, true, 'EPIPE 之后 stdoutBroken 必须为 true')
  assert.ok(j.guardCount === 100000, 'guardCount 仍应如实计数（限流只影响写日志，不影响统计）')
})
