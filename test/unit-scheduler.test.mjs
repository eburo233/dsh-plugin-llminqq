// test/unit-scheduler.test.mjs —— 定时任务「抛错就永久停摆」的回归测试
//
// 背景（线上真实问题）：
//   runTask 原来在 `h.running = true` 与 `h.running = false` 之间直接
//   `await runMemoryAsync(...)`，没有 try/finally。只要这一轮 reject，
//   running 永远是 true → 这个任务此后每一轮都被并发锁静默跳过，
//   而 status() 还一直显示 running。表现为「记忆/学习任务某天起再也不跑了」，
//   日志里却看不出错误。
//
// 这些测试注入一个会 reject 的 run（createScheduler 的测试接缝），
// 断言第二轮仍然执行；定时器路径用很小的 interval，秒级结束、不 hang。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const { createScheduler } = await import(pathToFileURL(path.join(ROOT, 'lib', 'scheduler.mjs')).href)

function mkStateDir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'llminqq-sched-'))
}

/** 间隔取 0.001 分钟：Math.max(1000, 60) → 真实 1000ms（调度器的下限） */
const tinyTask = () => ({ enabled: true, tool: 'memctl', args: ['ingest'], intervalMin: 0.001, timeoutMs: 1000 })

const statusOf = (s, name) => s.status().tasks.find(t => t.name === name)

async function waitFor (pred, { timeoutMs = 10000, stepMs = 25 } = {}) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return true
    await new Promise(resolve => setTimeout(resolve, stepMs))
  }
  return false
}

test('任务抛错时 running 必须复位（连续两轮都执行）', async () => {
  const stateDir = mkStateDir()
  let calls = 0
  const s = createScheduler({
    probe: { ok: true, bin: 'python', version: '3.12' },
    stateDir,
    log: () => {},
    warn: () => {},
    tasks: { only: tinyTask() },
    run: async () => { calls++; throw new Error(`boom-${calls}`) },
  })
  try {
    const r1 = await s.runTask('only')
    assert.equal(calls, 1)
    assert.equal(r1.ok, false)
    assert.equal(statusOf(s, 'only').running, false, '抛错后 running 必须复位')
    assert.match(String(statusOf(s, 'only').lastError), /boom-1/, 'status() 应带出 lastError')

    const r2 = await s.runTask('only')
    assert.equal(calls, 2, '第一轮抛错后第二轮仍必须被执行（不能永久停摆）')
    assert.equal(r2.ok, false)
    assert.equal(statusOf(s, 'only').running, false)
    assert.match(String(statusOf(s, 'only').lastError), /boom-2/)
  } finally {
    s.stop()
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

test('定时器路径：第一轮抛错后第二轮照常触发', async () => {
  const stateDir = mkStateDir()
  let calls = 0
  const s = createScheduler({
    probe: { ok: true, bin: 'python' },
    stateDir,
    log: () => {},
    warn: () => {},
    tasks: { beat: tinyTask() },
    run: async () => {
      calls++
      if (calls === 1) throw new Error('timer-boom')
      return { ok: true, kind: null, reason: '', ms: 1, stdout: 'ok', stderr: '' }
    },
  })
  try {
    s.start()
    const ok = await waitFor(() => calls >= 2)
    assert.ok(ok, `第二轮没有触发（calls=${calls}）——任务很可能永久停摆了`)
    const snap = statusOf(s, 'beat')
    assert.equal(snap.running, false)
    assert.equal(snap.lastResult?.ok, true, '第二轮应成功')
  } finally {
    s.stop()
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

test('定时器触发时上一轮未结束：记 skippedCount + warn，而不是静默丢弃', async () => {
  const stateDir = mkStateDir()
  let release
  const gate = new Promise(resolve => { release = resolve })
  let runs = 0
  const warns = []
  const s = createScheduler({
    probe: { ok: true, bin: 'python' },
    stateDir,
    log: () => {},
    warn: m => warns.push(String(m)),
    tasks: { slow: tinyTask() },
    run: async () => { runs++; await gate; return { ok: true, kind: null, reason: '', ms: 1 } },
  })
  try {
    s.start()
    const ok = await waitFor(() => statusOf(s, 'slow').skippedCount >= 1)
    assert.ok(ok, '第二次定时触发应记录 skippedCount')
    assert.equal(runs, 1, '上一轮没结束时不应再起一轮')
    assert.ok(warns.some(m => /上一轮仍在运行/.test(m)), `应有 warn 日志: ${JSON.stringify(warns)}`)
  } finally {
    release()
    s.stop()
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

test('stop() 清理定时器：停止后不再触发', async () => {
  const stateDir = mkStateDir()
  let runs = 0
  const s = createScheduler({
    probe: { ok: true, bin: 'python' },
    stateDir,
    log: () => {},
    warn: () => {},
    tasks: { timer: tinyTask() },
    run: async () => { runs++; return { ok: true, kind: null, reason: '', ms: 1 } },
  })
  try {
    s.start()
    s.stop()
    await new Promise(resolve => setTimeout(resolve, 1300)) // 比 interval（1000ms）长
    assert.equal(runs, 0, 'stop() 之后定时器不该再触发')
    assert.equal(statusOf(s, 'timer').running, false)
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

// ── digest 任务：摘要文件必须有人调度生成 ────────────────────────────────────
//
// 背景（用户实测发现）：导入 844 条记忆之后，digest.md 仍然不存在。
// 根因和 ingest 一模一样 —— 脚本版靠手工跑 `memctl digest`，插件化时只搬了
// reflect/learn，digest 从没进过任务表。
//
// 后果是**静默**的：桥的 memoryRecallBlock 读 digest 走
// `if (!existsSync) return ''`，没有任何报错。用户能看到「记忆 844 条」，
// 但桥注入的「群级背景 / 程序记忆」那一段永远为空，只有按人检索在工作。

test('默认任务表里有 digest（摘要文件不能靠手工跑）', () => {
  const { _defaultTasks } = createScheduler({
    probe: { ok: true, bin: 'python' },
    stateDir: mkStateDir(),
  })
  assert.ok(_defaultTasks.digest, '任务表里没有 digest —— digest.md 永远不会生成')
  assert.deepEqual(_defaultTasks.digest.args, ['digest'], 'digest 任务的参数不对')
  assert.equal(_defaultTasks.digest.tool, 'memctl', 'digest 得走 memctl')
  assert.equal(_defaultTasks.digest.enabled, true, 'digest 默认必须启用')

  // 间隔要合理：比 reflect（8h）密得多（否则摘要落后 8 小时），
  // 又没必要比 ingest（5min）更密（digest 是纯计算但也不该刷太勤）
  const iv = _defaultTasks.digest.intervalMin
  assert.ok(iv >= 5 && iv <= 120,
    `digest 间隔不合理（${iv} 分钟）：应在 5~120 之间（ingest 是 5，reflect 是 480）`)
})

test('digest 任务能真跑（注入 run 后状态正确）', async () => {
  const stateDir = mkStateDir()
  let seen = null
  const s = createScheduler({
    probe: { ok: true, bin: 'python' },
    stateDir,
    log: () => {},
    warn: () => {},
    tasks: { digest: _defaultTasksDigest() },
    run: async (opts) => {
      seen = opts
      return { ok: true, kind: null, reason: '', ms: 14, stdout: '已写入 /x/digest.md' }
    },
  })
  try {
    const r = await s.runTask('digest')
    assert.equal(r.ok, true, 'digest 任务应能成功跑完')
    assert.equal(seen.tool, 'memctl', '应通过 memctl 执行')
    assert.deepEqual(seen.args, ['digest'], '参数必须是 digest')
    assert.equal(statusOf(s, 'digest').running, false, '跑完必须复位 running')
  } finally {
    s.stop()
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

/** 复制默认 digest 任务定义（测试用，避免和下表的其它任务纠缠） */
function _defaultTasksDigest () {
  const s = createScheduler({ probe: { ok: true, bin: 'python' }, stateDir: mkStateDir() })
  return { ...s._defaultTasks.digest }
}

// ── digest 的「产物缺失就立刻补一次」────────────────────────────────────────
//
// 调度器纪律 ② 是「重启不该立刻重跑一轮」，那条针对的是昂贵且幂等的任务
// （reflect 一轮 2-6 分钟、learn 10-20 分钟）。
//
// digest 不是这类：14ms 纯本地渲染，而**产物不存在时桥读它是空字符串**
// （静默降级、用户毫不知情）。按纪律 ② 等满 30 分钟，就等于这半小时里
// 「群级背景 / 程序记忆」那段一直空白。所以给它一个 `runIfMissing` 例外。

test('digest 产物缺失时，start() 立刻补跑一次（不等 30 分钟）', async () => {
  const stateDir = mkStateDir()
  let calls = 0
  const s = createScheduler({
    probe: { ok: true, bin: 'python' },
    stateDir,
    log: () => {},
    warn: () => {},
    // 覆盖成很小的间隔，确保本测试不依赖真实 30 分钟
    tasks: { digest: { ..._defaultTasksDigest(), intervalMin: 60 } },
    run: async () => { calls++; return { ok: true, ms: 14 } },
  })
  try {
    assert.equal(fs.existsSync(path.join(stateDir, 'digest.md')), false, '前置：产物不存在')
    s.start()
    assert.equal(await waitFor(() => calls >= 1, { timeoutMs: 3000 }), true,
      'digest.md 不存在时必须立刻补跑，而不是等 30 分钟')
    assert.equal(statusOf(s, 'digest').running, false, '补跑结束 running 要复位')
  } finally {
    s.stop()
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

test('产物已存在时不额外补跑（纪律 ② 对昂贵任务仍生效）', async () => {
  const stateDir = mkStateDir()
  fs.writeFileSync(path.join(stateDir, 'digest.md'), '# 已有摘要\n')
  let calls = 0
  const s = createScheduler({
    probe: { ok: true, bin: 'python' },
    stateDir,
    log: () => {},
    warn: () => {},
    tasks: { digest: { ..._defaultTasksDigest(), intervalMin: 60 } },
    run: async () => { calls++; return { ok: true, ms: 14 } },
  })
  try {
    s.start()
    await new Promise(resolve => setTimeout(resolve, 400))
    assert.equal(calls, 0, '产物已在，不该立刻重跑（否则每次重启都白跑一轮）')
  } finally {
    s.stop()
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

test('只有声明 runIfMissing 的任务享受这个例外', async () => {
  const { _defaultTasks } = createScheduler({ probe: { ok: true, bin: 'python' }, stateDir: mkStateDir() })
  // ingest/reflect/learn 都是昂贵或依赖增量状态的任务，不该被「立刻补跑」
  for (const name of ['ingest', 'reflect', 'learn']) {
    assert.equal(_defaultTasks[name].runIfMissing, undefined,
      `${name} 不该声明 runIfMissing —— 它跑一轮有成本，重启时不该无条件重跑`)
  }
  assert.equal(_defaultTasks.digest.runIfMissing, true, 'digest 必须声明 runIfMissing')
})
