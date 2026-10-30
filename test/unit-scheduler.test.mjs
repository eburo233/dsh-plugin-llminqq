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
