// test/unit-scheduler-semantics.test.mjs —— P1-5：调度器把「没学到」当失败、把「失败」当成功
//
// 背景（docs/MEMORY-AUDIT-AND-V5.md §2 P1-5 / §4-6 §4-7）：
//   (a) learn 没有新语料时 mode='none'，旧 lexicon.py 返回 **1** →
//       调度器记 ok:false。用户看到「学习一直失败」，其实什么都没坏。
//   (b) reflect **彻底失败**（LLM 不可用）时 memctl.main() 没有返回值 →
//       进程 exit **0** → 调度器记 ok:true。最危险的那种：绿着坏。
//   再加上设置页完全不渲染 scheduler 状态（grep -c scheduler client.js == 0），
//   用户没有任何途径发现这两个任务其实都没在工作。
//
// 现在 Node 侧的判据是「退出码 + 输出语义」两条一起看（classifyMemoryRun），
// 并且 scheduler.json 记录 lastRun/ok/consecutiveFailures/deadLetters。
// 这里逐条锁住：
//   · learn 走 --only-corpus（定时任务不现抓 B站）；
//   · mode=none 不算失败；mode=error / 非 0 退出算失败；fallback 是「降级成功」；
//   · 连续失败累计 + 死信 + 成功自愈；
//   · python 侧的约定（退出码）变了也不会误判（两条都兜住）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const M = await import(pathToFileURL(path.join(ROOT, 'lib', 'scheduler.mjs')).href)
const {
  createScheduler, classifyMemoryRun, parseMemoryRun, DEAD_LETTER_AFTER,
} = M

function mkStateDir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'llminqq-sched-sem-'))
}
const probe = { ok: true, bin: 'python', version: '3.12' }
const readStateFile = stateDir => JSON.parse(fs.readFileSync(path.join(stateDir, 'scheduler.json'), 'utf8'))

/** 造一个「跑完的 run 结果」（和 runMemoryAsync 的返回形状一致）。 */
const runResult = (over = {}) => ({
  ok: over.code === 0, kind: over.code === 0 ? null : 'exit',
  reason: over.code === 0 ? '' : `退出码 ${over.code}`,
  stdout: '', stderr: '', code: 0, ms: 5, ...over,
})

// ── ① 定时任务的 learn 参数 ─────────────────────────────────────────────────
test('默认任务表：learn 必须带 --only-corpus（定时任务不能现抓 B站）', () => {
  const { _defaultTasks } = createScheduler({ probe, stateDir: mkStateDir() })
  const args = _defaultTasks.learn.args
  assert.equal(_defaultTasks.learn.tool, 'lexicon')
  assert.deepEqual(args.slice(0, 2), ['learn', '--only-corpus'],
    `learn 参数不对（${JSON.stringify(args)}）—— 裸 learn 会现抓 B站，跟 crawl 抢风控还没有增量`)
  assert.ok(args.includes('--json'), 'learn 要 --json 输出，好让调度器按语义判断「没东西可学」')
})

// ── ② 语义解析 ──────────────────────────────────────────────────────────────
test('parseMemoryRun：lexicon --json 能读出 mode/added', () => {
  const res = runResult({
    stdout: '一些日志\n{"mode":"llm","added":5,"merged":2,"entries":30,"sources":["corpus"]}\n',
  })
  const p = parseMemoryRun('lexicon', res)
  assert.equal(p.mode, 'llm')
  assert.equal(p.added, 5)
})

test('parseMemoryRun：没有 --json 的文本输出也能兜住（`模式 llm`）', () => {
  const res = runResult({ stdout: '[学习] 模式 llm · 来源 [\'corpus\'] · 语料段 3 · 新增 4 / 合并 1 · 库里 20 条 · 3.1s' })
  const p = parseMemoryRun('lexicon', res)
  assert.equal(p.mode, 'llm')
  assert.equal(p.added, 4, '文本里的「新增 N」也要能读出来（老版本 python 的兼容）')
})

test('parseMemoryRun：memctl reflect 的每一条 peer 行（含模式/条数）', () => {
  const res = runResult({
    stdout: [
      '[c2c:100] 扫描 80 条 · 模式 llm · 新建 3 条 · 批次 1/1 成功',
      '[group:200] 扫描 10 条 · 模式 fallback · 新建 1 条 · 批次 0/1 成功（失败 1）',
    ].join('\n'),
  })
  const p = parseMemoryRun('memctl', res)
  assert.deepEqual(p.modes, ['llm', 'fallback'])
  assert.equal(p.scanned, 90)
  assert.equal(p.created, 4)
})

// ── ③ 判定：没东西可学 ≠ 失败 ──────────────────────────────────────────────
test('learn mode=none + 退出码 1（旧 python）→ 成功，kind=noop，不累计失败', () => {
  const res = runResult({
    code: 1, kind: 'exit', reason: '退出码 1',
    stdout: '{"mode":"none","added":0,"sources":["corpus"]}',
  })
  const c = classifyMemoryRun('lexicon', res)
  assert.equal(c.ok, true, '「没新语料」是正常状态，不是失败（P1-5(a)）')
  assert.equal(c.kind, 'noop')
  assert.match(c.reason, /没有新语料/)
  assert.equal(c.mode, 'none')
})

test('learn 真失败（mode=error）→ 失败', () => {
  const c = classifyMemoryRun('lexicon', runResult({
    code: 1, kind: 'exit', stdout: '{"mode":"error","added":0,"error":"模型全部失败"}',
  }))
  assert.equal(c.ok, false)
  assert.match(c.reason, /模型全部失败|error/)
})

test('learn 部分批次失败（llm-partial）→ 成功但标 degraded（黄色，别混进绿色）', () => {
  const c = classifyMemoryRun('lexicon', runResult({
    code: 1, kind: 'exit', stdout: '{"mode":"llm-partial","added":2}',
  }))
  assert.equal(c.ok, true, '部分成功不该算「连续失败」—— 否则会一路攒到死信')
  assert.equal(c.kind, 'degraded')
})

// ── ④ 判定：彻底失败 ≠ 成功（哪怕退出码 0）────────────────────────────────
test('reflect 输出 mode=error 但退出码 0（旧 python）→ 仍然算失败', () => {
  const c = classifyMemoryRun('memctl', runResult({
    code: 0,
    stdout: '[c2c:1] 扫描 80 条 · 模式 error · 新建 0 条 · 批次 0/1 成功（失败 1）\n    ⚠ LLM 调用失败: no api key',
  }))
  assert.equal(c.ok, false, '「绿着坏」的核心：退出码 0 不代表成功（P1-5(b)）')
  assert.match(c.reason, /LLM 调用失败|error/)
})

test('reflect 全部 fallback（LLM 不可用退拼接法）→ 成功但 degraded', () => {
  const c = classifyMemoryRun('memctl', runResult({
    code: 0,
    stdout: '[c2c:1] 扫描 80 条 · 模式 fallback · 新建 1 条 · 批次 0/1 成功（失败 0）',
  }))
  assert.equal(c.ok, true)
  assert.equal(c.kind, 'degraded', '降级必须看得见（设置页黄色），不能显示成普通成功')
  assert.match(c.reason, /拼接法|fallback/)
})

test('reflect 没有需要反思的记忆（全是 mode=none）→ 成功，kind=noop', () => {
  const c = classifyMemoryRun('memctl', runResult({
    code: 0, stdout: '[c2c:1] 扫描 0 条 · 模式 none · 新建 0 条 · 批次 0/0 成功',
  }))
  assert.equal(c.ok, true)
  assert.equal(c.kind, 'noop')
})

test('正常成功 / 普通失败 / 起不来 / 超时 的判定', () => {
  assert.equal(classifyMemoryRun('memctl', runResult({ code: 0, stdout: '新增 3 条' })).ok, true)

  const fail = classifyMemoryRun('memctl', runResult({ code: 2, kind: 'exit', reason: '退出码 2' }))
  assert.equal(fail.ok, false)
  assert.equal(fail.kind, 'exit')

  const timeout = classifyMemoryRun('memctl', runResult({ code: null, kind: 'timeout', reason: '超时（>1800000ms）' }))
  assert.equal(timeout.ok, false)
  assert.equal(timeout.kind, 'timeout')

  const noPy = classifyMemoryRun('memctl', runResult({ code: null, kind: 'unavailable', reason: 'python 不可用' }))
  assert.equal(noPy.ok, false)
  assert.equal(noPy.kind, 'unavailable')

  // 注入式 run（没有 code 字段）不能因为「没退出码」被误判成失败
  const injected = classifyMemoryRun('memctl', { ok: true, kind: null, reason: '', stdout: '', stderr: '', ms: 1 })
  assert.equal(injected.ok, true, '没有 code 的 run 结果要退回它自己的 ok，而不是判失败')
})

// ── ⑤ 连续失败 / 死信 / 自愈（scheduler.json + status()）───────────────────
test('连续失败会累计，达到阈值记死信；成功一次就清零并清掉死信', async () => {
  const stateDir = mkStateDir()
  let attempt = 0
  const s = createScheduler({
    probe, stateDir, log: () => {}, warn: () => {},
    tasks: { learn: { enabled: true, tool: 'lexicon', args: ['learn', '--only-corpus'], intervalMin: 60, timeoutMs: 1000 } },
    run: async () => {
      attempt++
      // 前 DEAD_LETTER_AFTER 次真失败，之后成功
      return attempt <= DEAD_LETTER_AFTER
        ? runResult({ code: 1, kind: 'exit', reason: '退出码 1', stdout: '{"mode":"error","error":"模型挂了"}' })
        : runResult({ code: 0, stdout: '{"mode":"llm","added":2}' })
    },
  })
  try {
    for (let i = 1; i <= DEAD_LETTER_AFTER; i++) {
      const r = await s.runTask('learn')
      assert.equal(r.ok, false)
      assert.equal(r.consecutiveFailures, i, `第 ${i} 次失败后 consecutiveFailures 应该是 ${i}`)
      const persisted = readStateFile(stateDir)
      assert.equal(persisted.learn.consecutiveFailures, i, 'scheduler.json 要持久化连续失败次数（重启后不丢）')
    }
    // 达到阈值 → 死信
    const st = s.status()
    const task = st.tasks.find(t => t.name === 'learn')
    assert.equal(task.deadLetter, true, '连续失败达到阈值必须标记死信')
    assert.equal(st.deadLetters.length, 1)
    assert.equal(st.deadLetters[0].name, 'learn')
    assert.equal(st.deadLetterAfter, DEAD_LETTER_AFTER)
    assert.match(st.deadLetters[0].reason, /模型挂了/)
    assert.equal(readStateFile(stateDir).deadLetters.learn.consecutiveFailures, DEAD_LETTER_AFTER)

    // 成功一次：清零 + 清掉死信（任务自己好了就不该继续亮红灯）
    const ok = await s.runTask('learn')
    assert.equal(ok.ok, true)
    assert.equal(ok.consecutiveFailures, 0)
    const st2 = s.status()
    assert.equal(st2.tasks.find(t => t.name === 'learn').deadLetter, false)
    assert.deepEqual(st2.deadLetters, [], '恢复成功后死信要自动清掉')
    assert.equal(readStateFile(stateDir).learn.consecutiveFailures, 0)
  } finally {
    s.stop()
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

test('mode=none 的成功不会累计连续失败（这正是误报的来源）', async () => {
  const stateDir = mkStateDir()
  let i = 0
  const s = createScheduler({
    probe, stateDir, log: () => {}, warn: () => {},
    tasks: { learn: { enabled: true, tool: 'lexicon', args: ['learn', '--only-corpus', '--json'], intervalMin: 60, timeoutMs: 1000 } },
    run: async () => {
      i++
      // 前两次真失败，之后是「没新语料」（旧 python 会返回 1）
      return i <= 2
        ? runResult({ code: 1, kind: 'exit', stdout: '{"mode":"error","error":"boom"}' })
        : runResult({ code: 1, kind: 'exit', reason: '退出码 1', stdout: '{"mode":"none","added":0}' })
    },
  })
  try {
    await s.runTask('learn')
    await s.runTask('learn')
    const before = s.status().tasks.find(t => t.name === 'learn').consecutiveFailures
    assert.equal(before, 2)
    const r = await s.runTask('learn')
    assert.equal(r.ok, true, 'mode=none 必须算成功')
    assert.equal(r.kind, 'noop')
    assert.equal(r.consecutiveFailures, 0, '「没东西可学」要把连续失败清零，否则永远等不到自愈')
  } finally {
    s.stop()
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

test('scheduler.json 记录 lastRun / ok / kind / mode / summary（设置页只读它）', async () => {
  const stateDir = mkStateDir()
  const s = createScheduler({
    probe, stateDir, log: () => {}, warn: () => {},
    tasks: { reflect: { enabled: true, tool: 'memctl', args: ['reflect', '--hours', '168'], intervalMin: 60, timeoutMs: 1000 } },
    run: async () => runResult({ code: 0, stdout: '[c2c:1] 扫描 12 条 · 模式 llm · 新建 2 条 · 批次 1/1 成功' }),
  })
  try {
    const r = await s.runTask('reflect')
    const persisted = readStateFile(stateDir)
    assert.equal(persisted.reflect.ok, true)
    assert.equal(persisted.reflect.kind, null)
    assert.equal(persisted.reflect.mode, 'llm')
    assert.ok(persisted.reflect.lastRunAt > 0, '必须有 lastRunAt（设置页显示上次运行时间）')
    assert.ok(Number.isFinite(persisted.reflect.ms), 'ms 要写进去')
    assert.equal(persisted.reflect.consecutiveFailures, 0)
    assert.match(String(persisted.reflect.summary), /扫描 12/)
    assert.equal(r.summary, persisted.reflect.summary, '返回值和落盘文案要一致，别两套')
  } finally {
    s.stop()
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

test('status() 给设置页的字段齐全：ok/kind/mode/summary/consecutiveFailures/deadLetter', async () => {
  const stateDir = mkStateDir()
  const s = createScheduler({
    probe, stateDir, log: () => {}, warn: () => {},
    tasks: { digest: { enabled: true, tool: 'memctl', args: ['digest'], intervalMin: 30, timeoutMs: 1000 } },
    run: async () => runResult({ code: 0, stdout: '已写入 12 条' }),
  })
  try {
    await s.runTask('digest')
    const snap = s.status()
    for (const k of ['enabled', 'python', 'tasks', 'deadLetters', 'deadLetterAfter']) {
      assert.ok(k in snap, `status() 缺 ${k}`)
    }
    const t = snap.tasks.find(x => x.name === 'digest')
    for (const k of ['ok', 'kind', 'mode', 'summary', 'consecutiveFailures', 'deadLetter', 'lastRunAt', 'intervalMin', 'lastError']) {
      assert.ok(k in t, `status().tasks[] 缺 ${k} —— 设置页拿不到就不能显示`)
    }
    assert.equal(t.ok, true)
  } finally {
    s.stop()
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})

// ── ⑥ configPath 要一路传到 run（reflect 才能读到桥配置）──────────────────
test('createScheduler 的 configPath 会传给 run（→ memoryEnv 的 LLMINQQ_CONFIG）', async () => {
  const stateDir = mkStateDir()
  let seen = null
  const s = createScheduler({
    probe, stateDir, log: () => {}, warn: () => {},
    configPath: '/tmp/假桥配置/bridge-config.json',
    tasks: { reflect: { enabled: true, tool: 'memctl', args: ['reflect'], intervalMin: 60, timeoutMs: 1000 } },
    run: async (opts) => { seen = opts; return runResult({ code: 0 }) },
  })
  try {
    await s.runTask('reflect')
    assert.equal(seen.configPath, '/tmp/假桥配置/bridge-config.json',
      'configPath 没传到 run —— 反思子进程拿不到 LLMINQQ_CONFIG，会静默退回拼接法')
    assert.equal(seen.stateDir, stateDir, 'stateDir 也要传（记忆数据目录的唯一真源）')
  } finally {
    s.stop()
    fs.rmSync(stateDir, { recursive: true, force: true })
  }
})
