// test/memory-v5-engine-switch.test.mjs —— 记忆 v5 Step 2：桥读路径切换（task-18）
//
// 这一步是「切读路径」：engine=v4（默认）时桥行为与切换前**完全一致**；
// engine=v5 时注入改走 search.mjs 的 buildMemoryBlocks，失败自动回退 v4。
// 验收要求两套路径都有测试兜底，且回退绝不能影响本轮回复。
//
// 为什么用「源码抠函数 + 真 store/真 search」：
//   lib/bridge/index.js 是长驻进程入口（import 即起桥），没法直接 import。
//   和 unit-log-runaway / memory-v5-bridge-write 一样，把纯逻辑函数抠出来用
//   new Function 注入 stub 执行；v5 数据层用真的 openV5 + 临时库，
//   这样「注入/回退/touch」测的是真代码 + 真 SQLite，不是假装。
//
// 覆盖：engine 默认 v4、env 覆盖、v5 成功注入、v5 抛错/库打不开回退 v4、
// touch 只对真正注入的条目、contextSince 透传、distill 调度注册/防重入、
// 两套路径互不影响、插件侧 bridgeConfig 透传（memoryV5Config）。

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { openV5 } from '../lib/agent/memory-v5/store.mjs'
import * as realSearch from '../lib/agent/memory-v5/search.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SRC = fs.readFileSync(path.join(ROOT, 'lib', 'bridge', 'index.js'), 'utf8')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'llminqq-v5-engine-'))
after(() => fs.rmSync(TMP, { recursive: true, force: true }))

let seq = 0
function freshStore () {
  const dir = path.join(TMP, `db${seq++}`)
  fs.mkdirSync(dir, { recursive: true })
  return openV5({ dbPath: path.join(dir, 'mem-v5.db') })
}

/** 按花括号配平抠顶层函数（先跳过参数表；参数里有解构花括号，踩过）。 */
function fnSource (name) {
  const i = SRC.search(new RegExp(`(?:async\\s+)?function ${name}\\s*\\(`))
  assert.ok(i > 0, `定位不到 ${name}`)
  let paren = 0
  let k = SRC.indexOf('(', i)
  assert.ok(k > 0, `${name} 没有参数表`)
  for (; k < SRC.length; k++) {
    if (SRC[k] === '(') paren++
    else if (SRC[k] === ')') { paren--; if (paren === 0) break }
  }
  const start = SRC.indexOf('{', k)
  assert.ok(start > 0, `${name} 没有函数体`)
  let depth = 0
  for (let j = start; j < SRC.length; j++) {
    if (SRC[j] === '{') depth++
    else if (SRC[j] === '}') { depth--; if (depth === 0) return SRC.slice(i, j + 1) }
  }
  assert.fail(`${name} 函数体没闭合`)
}

const ENGINE_FNS = [
  'v5Cfg', 'v5Enabled', 'memoryEngine', 'v5ReadEnabled', 'acpContextStartSec',
  'v5MemoryRecallBlock', 'memoryBlockForTurn',
  'v5DistillCfg', 'v5DistillTick', 'startV5DistillLoop',
]

/**
 * 组装一个「桥逻辑沙箱」：
 *   - v5OpenStore / v5SearchMod / v5DistillMod / memoryRecallBlock(v4) / memoryWarnOnce
 *     全部由测试注入；
 *   - v5Disabled / 定时器 / running 等模块级变量在沙箱里声明，闭包内生效。
 */
function makeEngine ({
  config = {}, store = null, openStore = null, searchMod = null, distillMod = null,
  warn = () => {}, v4 = () => '', logger = null, env = {}, state = { peers: {} }, cfgPath = '/tmp/bridge-config.json',
} = {}) {
  const logs = []
  const log = logger ?? {
    log: m => logs.push(String(m)),
    debug: m => logs.push(`debug ${m}`),
    warn: () => {},
  }
  const proc = { env: { ...env } }
  const timers = new Set()
  const intervals = []
  const setIntervalStub = (fn, ms) => { const t = { fn, ms }; intervals.push(t); return t }
  const clearIntervalStub = () => {}
  const warnings = []
  const v4Calls = []
  const openCalls = { count: 0 }
  const v5OpenStoreStub = openStore ?? (async () => { openCalls.count++; return store })
  const searchModStub = searchMod ?? realSearch
  const distillModStub = distillMod ?? { distillOnce: async () => ({ claimed: 0, results: [], status: {} }) }
  const v4Stub = (...args) => { v4Calls.push(args); return typeof v4 === 'function' ? v4(...args) : '' }
  const warnStub = (key, msg) => { warnings.push({ key, msg }) }
  const searchCalls = { count: 0 }
  const distillCalls = { count: 0, args: [] }

  const code = `
    const V5_ENGINE_VALUES = ['v4', 'v5']
    const V5_DISTILL_DEFAULTS = { intervalMin: 10, minIntervalMin: 1, maxIntervalMin: 120 }
    let v5Disabled = false
    let v5SearchPromise = null
    let v5DistillPromise = null
    let v5DistillTimer = null
    let v5DistillRunning = false
    ${ENGINE_FNS.map(fnSource).join('\n\n')}
    return {
      memoryEngine, v5ReadEnabled, acpContextStartSec, v5MemoryRecallBlock, memoryBlockForTurn,
      v5DistillCfg, v5DistillTick, startV5DistillLoop,
      // v5Cfg / v5Enabled 也暴露出来：形状兼容的用例要直接验「桥从什么位置读配置」
      v5Cfg, v5Enabled,
    }
  `
  const factory = new Function(
    'config', 'logger', 'process', 'state', 'cfgPath', 'timers', 'setInterval', 'clearInterval',
    'v5OpenStore', 'v5SearchMod', 'v5DistillMod', 'memoryRecallBlock', 'memoryWarnOnce', code,
  )
  const api = factory(
    config, log, proc, state, cfgPath, timers, setIntervalStub, clearIntervalStub,
    v5OpenStoreStub,
    async () => { searchCalls.count++; return searchModStub },
    async () => { distillCalls.count++; return distillModStub },
    v4Stub, warnStub,
  )
  return { ...api, logs, warnings, v4Calls, openCalls, searchCalls, distillCalls, intervals, timers, proc }
}

const CONFIG_V5 = { memory: { v5: { enabled: true, engine: 'v5' } } }
const CONFIG_V4 = { memory: { v5: { enabled: true, engine: 'v4' } } }

// ── ① 引擎开关：默认 v4、config/env 覆盖 ───────────────────────────────────
test('engine 默认 v4（Step 3 迁移 + 盲评通过前不切默认）', () => {
  const e = makeEngine({ config: { memory: {} } })
  assert.equal(e.memoryEngine(), 'v4')
})

test('config.memory.v5.engine="v5" → v5；其它脏值回落 v4', () => {
  assert.equal(makeEngine({ config: CONFIG_V5 }).memoryEngine(), 'v5')
  for (const bad of ['V5x', 'true', 1, null, '', 'v6']) {
    const e = makeEngine({ config: { memory: { v5: { engine: bad } } } })
    assert.equal(e.memoryEngine(), 'v4', `engine=${JSON.stringify(bad)} 不该切成 v5`)
  }
})

test('环境变量 LLMINQQ_MEMORY_ENGINE 优先级最高（v4/v5 双向覆盖）', () => {
  const a = makeEngine({ config: CONFIG_V4, env: { LLMINQQ_MEMORY_ENGINE: 'v5' } })
  assert.equal(a.memoryEngine(), 'v5', 'env=v5 应覆盖 config=v4')
  const b = makeEngine({ config: CONFIG_V5, env: { LLMINQQ_MEMORY_ENGINE: 'v4' } })
  assert.equal(b.memoryEngine(), 'v4', 'env=v4 是紧急回退，应覆盖 config=v5')
  const c = makeEngine({ config: CONFIG_V5, env: { LLMINQQ_MEMORY_ENGINE: 'V5' } })
  assert.equal(c.memoryEngine(), 'v5', '大小写不敏感')
  const d = makeEngine({ config: CONFIG_V5, env: { LLMINQQ_MEMORY_ENGINE: 'nonsense' } })
  assert.equal(d.memoryEngine(), 'v5', '非法 env 忽略，回落 config')
})

test('v5ReadEnabled：engine=v5 但 memory.v5.enabled=false → 整段跳过', () => {
  const e = makeEngine({ config: { memory: { v5: { enabled: false, engine: 'v5' } } } })
  assert.equal(e.memoryEngine(), 'v5')
  assert.equal(e.v5ReadEnabled(), false)
  assert.equal(makeEngine({ config: CONFIG_V5 }).v5ReadEnabled(), true)
})

// ── ①b 形状兼容：旧插件摊平写的 memory.engine / memory.distill 也要认 ────────
//
// 现场（2026-11-05）：插件把 v5 配置摊平写在 memory 顶层，桥读 memory.v5.*，
// 于是 engine 永远 v4。插件侧已改成嵌 v5 子对象，但**桥也认旧形状**，因为
// 宿主进程可能比桥代码旧（宿主先起、桥后起），旧宿主每次重启桥都会把配置
// 写回摊平 —— 桥侧多认一种形状才能切断这个死循环。
test('形状兼容：摊平的 memory.engine="v5" 也能切到 v5（旧宿主写出来的样子）', () => {
  const legacy = { memory: { enabled: true, engine: 'v5', distill: { intervalMin: 10 } } }
  const e = makeEngine({ config: legacy })
  assert.equal(e.memoryEngine(), 'v5', '旧形状摊平的 engine 必须被认（否则旧宿主永远开不起 v5）')
  // distill 段也要能兜到（startV5DistillLoop 读的就是 v5Cfg().distill）
  assert.deepEqual(e.v5Cfg().distill, { intervalMin: 10 })
})

test('形状兼容：嵌套优先于摊平（正解不被旧字段污染）', () => {
  const both = { memory: { engine: 'v4', v5: { engine: 'v5' } } }
  assert.equal(makeEngine({ config: both }).memoryEngine(), 'v5',
    '有 memory.v5 时必须以它为准，不能因为顶层还留着旧 engine 就回落')
  const both2 = { memory: { engine: 'v5', v5: { engine: 'v4' } } }
  assert.equal(makeEngine({ config: both2 }).memoryEngine(), 'v4', '显式嵌套 v4 就是 v4')
})

test('形状兼容：摊平的 memory.enabled 不当成 v5 开关（那是记忆总开关）', () => {
  // 用户关掉记忆总开关 → memory.enabled=false。这时 v5 双写的开关语义不同，
  // 不能被它连带关掉；反过来「记忆开着」也不该被当成 v5 显式开启。
  const e = makeEngine({ config: { memory: { enabled: false, engine: 'v5' } } })
  assert.notEqual(e.v5Cfg().enabled, false,
    'v5Cfg 不该把顶层 memory.enabled 当成 v5.enabled —— 语义不同，混用会误关双写')
  // 嵌套的 v5.enabled=false 才真关
  const f = makeEngine({ config: { memory: { enabled: true, v5: { enabled: false, engine: 'v5' } } } })
  assert.equal(f.v5ReadEnabled(), false, '嵌套 v5.enabled=false 必须真的关掉读路径')
})

// ── ② engine=v4：原路径零变化，不 import v5 模块 ──────────────────────────
test('engine=v4：直接走 memoryRecallBlock，不打开 v5 库、不 import search', async () => {
  const e = makeEngine({ config: CONFIG_V4, v4: () => '【你记得的事】v4 块' })
  const r = await e.memoryBlockForTurn({ peerKey: 'c2c:10001', senderQq: '10001', query: '猫' })
  assert.equal(r.engine, 'v4')
  assert.equal(r.fallback, false)
  assert.equal(r.block, '【你记得的事】v4 块')
  assert.equal(e.v4Calls.length, 1)
  assert.equal(e.openCalls.count, 0, 'engine=v4 不该打开 v5 库')
  assert.equal(e.searchCalls.count, 0, 'engine=v4 不该 import v5 search（零开销）')
})

test('engine=v4：v4 函数的调用参数与切换前一致（speaker/inGroup/query）', async () => {
  const e = makeEngine({ config: CONFIG_V4 })
  await e.memoryBlockForTurn({ peerKey: 'group:20001', senderQq: '30001', inGroup: true, query: '他说了啥' })
  assert.deepEqual(e.v4Calls[0], ['group:20001', { speaker: '30001', inGroup: true, query: '他说了啥' }])
})

// ── ③ engine=v5：成功注入 + touch ─────────────────────────────────────────
test('engine=v5 成功注入：块来自 buildMemoryBlocks，touch 只记真正渲染的条目', async () => {
  const store = freshStore()
  const m1 = store.insertMemory({ type: 'fact', subject: '10001', conv: 'c2c:10001', speaker: '10001', text: '他喜欢猫，养了一只橘猫叫团子', confidence: 0.9, salience: 0.8 })
  store.insertMemory({ type: 'fact', subject: '20002', conv: 'c2c:10001', speaker: '20002', text: '另一个人的记忆，和这次查询无关', confidence: 0.8, salience: 0.5 })
  const e = makeEngine({ config: CONFIG_V5, store })
  const r = await e.memoryBlockForTurn({ peerKey: 'c2c:10001', senderQq: '10001', query: '猫' })
  assert.equal(r.engine, 'v5')
  assert.equal(r.fallback, false)
  assert.match(r.block, /猫/, '注入块里应有命中的记忆')
  assert.equal(e.v4Calls.length, 0, 'v5 成功时不该再调 v4')

  const rows = store.db.prepare('SELECT id, access_count FROM memories ORDER BY id').all()
  const touched = rows.filter(x => Number(x.access_count) > 0)
  assert.equal(touched.length, 1, '只该 touch 真正注入的那条')
  assert.equal(Number(touched[0].id), m1.id)
  // 观测：debug 一行，含 字数/条数/耗时/engine
  assert.ok(e.logs.some(l => /memory-v5: 注入 \d+ 字 \/ \d+ 条 \/ \d+ms（engine=v5/.test(l)),
    `缺 v5 注入指标日志：${JSON.stringify(e.logs)}`)
  store.close()
})

test('engine=v5 空检索：不注入、不 touch（空块不是失败）', async () => {
  const store = freshStore()
  const m = store.insertMemory({ type: 'fact', subject: '10001', conv: 'c2c:10001', speaker: '10001', text: '他喜欢猫', salience: 0.8 })
  const e = makeEngine({ config: CONFIG_V5, store })
  const r = await e.memoryBlockForTurn({ peerKey: 'c2c:10001', senderQq: '10001', query: '量子力学' })
  assert.equal(r.engine, 'v5')
  assert.equal(r.fallback, false)
  assert.equal(r.block, '')
  const row = store.db.prepare('SELECT access_count FROM memories WHERE id = ?').get(m.id)
  assert.equal(Number(row.access_count), 0, '没注入就不该记访问')
  store.close()
})

test('engine=v5：contextSince 透传给 buildMemoryBlocks（ACP 上下文起点/水位线）', async () => {
  const store = freshStore()
  store.insertMemory({ type: 'fact', subject: '10001', conv: 'c2c:10001', speaker: '10001', text: '他喜欢猫', salience: 0.8 })
  const captured = []
  const wrapped = Object.create(realSearch)
  wrapped.buildMemoryBlocks = opts => { captured.push(opts); return realSearch.buildMemoryBlocks(opts) }
  const e = makeEngine({ config: CONFIG_V5, store, searchMod: wrapped })
  await e.memoryBlockForTurn({ peerKey: 'c2c:10001', senderQq: '10001', query: '猫', contextSince: 1700000000 })
  assert.equal(captured.length, 1)
  assert.equal(captured[0].contextSince, 1700000000)
  assert.equal(captured[0].conv, 'c2c:10001')
  assert.equal(captured[0].subject, '10001')
  assert.equal(captured[0].inGroup, false)
  store.close()
})

test('acpContextStartSec：取 state.peers[].createdAt（秒）；没有 → null（退回 events 水位线）', () => {
  const state = { peers: { 'c2c:10001': { createdAt: 1700000000123 } } }
  const e = makeEngine({ config: CONFIG_V5, state })
  assert.equal(e.acpContextStartSec('c2c:10001'), 1700000000)
  assert.equal(e.acpContextStartSec('c2c:404'), null)
  assert.equal(makeEngine({ config: CONFIG_V5, state: undefined }).acpContextStartSec('x'), null)
})

// ── ④ engine=v5 失败：自动回退 v4，不影响本轮 ─────────────────────────────
test('v5 检索抛错 → 回退 v4（block 用 v4 结果），只 warn 一次，不往外抛', async () => {
  const boom = { buildMemoryBlocks () { throw new Error('FTS 索引坏了') } }
  const e = makeEngine({ config: CONFIG_V5, store: freshStore(), searchMod: boom, v4: () => '【你记得的事】v4 兜底' })
  const r = await e.memoryBlockForTurn({ peerKey: 'c2c:10001', senderSq: '', query: '猫' })
  assert.equal(r.engine, 'v4')
  assert.equal(r.fallback, true)
  assert.equal(r.block, '【你记得的事】v4 兜底')
  assert.equal(e.warnings.length, 1, '回退要记一条（warn-once）')
  assert.match(String(e.warnings[0].msg), /回退 v4/)
})

test('v5 库打不开（v5OpenStore 返回 null）→ 回退 v4，不抛错', async () => {
  const e = makeEngine({ config: CONFIG_V5, openStore: async () => null, v4: () => 'v4 块' })
  const r = await e.memoryBlockForTurn({ peerKey: 'c2c:10001', query: '猫' })
  assert.equal(r.engine, 'v4')
  assert.equal(r.fallback, true)
  assert.equal(r.block, 'v4 块')
})

test('v5 失败时 touch 不会被调用（只有成功注入才记访问）', async () => {
  const store = freshStore()
  const m = store.insertMemory({ type: 'fact', subject: '10001', conv: 'c2c:10001', speaker: '10001', text: '他喜欢猫', salience: 0.8 })
  const touchCalls = []
  const origTouch = store.touchMemory
  store.touchMemory = (ids) => { touchCalls.push(ids); return origTouch(ids) }
  const e = makeEngine({
    config: CONFIG_V5,
    store,
    searchMod: Object.assign(Object.create(realSearch), { buildMemoryBlocks: () => { throw new Error('render 崩了') } }),
    v4: () => 'v4',
  })
  const r = await e.memoryBlockForTurn({ peerKey: 'c2c:10001', query: '猫' })
  assert.equal(r.fallback, true)
  assert.deepEqual(touchCalls, [], '失败回退时不该 touch')
  assert.equal(Number(store.db.prepare('SELECT access_count FROM memories WHERE id = ?').get(m.id).access_count), 0)
  store.close()
})

// ── ⑤ distill 调度：只在 engine=v5 时注册，参数/防重入正确 ─────────────────
test('startV5DistillLoop：engine=v5 → 建 10 分钟定时器并登记到 timers', () => {
  const e = makeEngine({ config: CONFIG_V5 })
  assert.equal(e.startV5DistillLoop(), true)
  assert.equal(e.intervals.length, 1)
  assert.equal(e.intervals[0].ms, 10 * 60000)
  assert.equal(e.timers.size, 1, '定时器要进桥的 timers 集合（shutdown 才能清）')
})

test('startV5DistillLoop：engine=v4 / v5 关着 / distill.enabled=false → 不建定时器（零开销）', () => {
  assert.equal(makeEngine({ config: CONFIG_V4 }).startV5DistillLoop(), false)
  const off = makeEngine({ config: { memory: { v5: { enabled: false, engine: 'v5' } } } })
  assert.equal(off.startV5DistillLoop(), false)
  const noDistill = makeEngine({ config: { memory: { v5: { enabled: true, engine: 'v5', distill: { enabled: false } } } } })
  assert.equal(noDistill.startV5DistillLoop(), false)
  assert.equal(noDistill.intervals.length, 0)
})

test('v5DistillCfg：intervalMin 默认 10、夹 1–120 分钟', () => {
  assert.equal(makeEngine({ config: CONFIG_V5 }).v5DistillCfg().intervalMin, 10)
  assert.equal(makeEngine({ config: { memory: { v5: { distill: { intervalMin: 5 } } } } }).v5DistillCfg().intervalMin, 5)
  assert.equal(makeEngine({ config: { memory: { v5: { distill: { intervalMin: 999 } } } } }).v5DistillCfg().intervalMin, 120)
  assert.equal(makeEngine({ config: { memory: { v5: { distill: { intervalMin: 0.1 } } } } }).v5DistillCfg().intervalMin, 1)
  assert.equal(makeEngine({ config: { memory: { v5: { distill: { intervalMin: 'abc' } } } } }).v5DistillCfg().intervalMin, 10)
})

test('v5DistillTick：调 distillOnce({store, configPath})，一次只跑一轮', async () => {
  const store = freshStore()
  let release
  const gate = new Promise(r => { release = r })
  const calls = []
  const distillMod = {
    distillOnce: async (opts) => { calls.push(opts); await gate; return { claimed: 1, results: [], status: {} } },
  }
  const e = makeEngine({ config: CONFIG_V5, store, distillMod, cfgPath: '/data/bridge/bridge-config.json' })
  const p1 = e.v5DistillTick()
  const p2 = await e.v5DistillTick()      // 第一轮还没结束 → busy
  assert.deepEqual(p2, { skipped: 'busy' })
  release()
  await p1
  assert.equal(calls.length, 1, '防重入：同一时间只该跑一轮')
  assert.equal(calls[0].store, store)
  assert.equal(calls[0].configPath, '/data/bridge/bridge-config.json', 'reflection_llm 读的是桥配置')
  assert.equal(typeof calls[0].log, 'function')
  store.close()
})

test('v5DistillTick：engine=v4 直接跳过（不起子进程/不打开库）', async () => {
  const e = makeEngine({ config: CONFIG_V4 })
  assert.deepEqual(await e.v5DistillTick(), { skipped: 'engine' })
  assert.equal(e.distillCalls.count, 0)
  assert.equal(e.openCalls.count, 0)
})

// ── ⑥ 两套路径互不影响 + 源码接线 ──────────────────────────────────────────
test('两套路径互不影响：v5 路径不碰 v4 函数，v4 路径不碰 v5 模块（已在上面覆盖，这里锁源码）', () => {
  const block = SRC.slice(SRC.indexOf('// ── 记忆 v5：桥读路径切换'), SRC.indexOf('构造一次 memory CLI 调用'))
  assert.doesNotMatch(block, /readMemoryDigestFor|crossChannelRecall/, 'v5 读路径不该绕过 v4 的 digest/跨通道实现')
  assert.match(SRC, /function memoryBlockForTurn/)
  assert.match(SRC, /block: memoryRecallBlock\(peerKey, \{ speaker: senderQq, inGroup, query \}\)/, 'v4 路径必须保持原样的 memoryRecallBlock 调用')
})

test('注入点已切到 memoryBlockForTurn（v4 默认/v5 可切），且 style/lexicon 保持不动', () => {
  const iCall = SRC.indexOf('await memoryBlockForTurn({')
  const iStyle = SRC.indexOf('const styleBlock = styleAnchorBlock(')
  assert.ok(iCall > 0 && iStyle > iCall, '记忆块应在 styleAnchor 之前（顺序与切换前一致）')
  assert.match(SRC, /const lexBlock = lexiconBlock\(\)/, 'lexiconBlock 不该被这次改动碰掉')
  assert.match(SRC, /startV5DistillLoop\(\)/, 'main 里没启动 distill 定时器')
})

// ── ⑦ 插件侧透传：bridgeConfig 的 memory.v5（默认 v4 / 间隔夹 1–120）──────
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'llminqq-v5cfg-'))
process.env.HOME = TMP_HOME
process.env.USERPROFILE = TMP_HOME
process.env.DSH_HOME = path.join(TMP_HOME, '.dsh')
const IDX = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)
const STORE = await import(pathToFileURL(path.join(ROOT, 'lib', 'store.js')).href)
after(() => fs.rmSync(TMP_HOME, { recursive: true, force: true }))

const V5_DEFAULTS = { enabled: true, engine: 'v4', distill: { enabled: true, intervalMin: 10 } }

test('memoryV5Config：缺省 → enabled + engine=v4 + distill 10 分钟（默认不切读路径）', () => {
  assert.deepEqual(IDX.memoryV5Config(undefined), V5_DEFAULTS)
  assert.deepEqual(IDX.memoryV5Config({}), V5_DEFAULTS)
})

test('memoryV5Config：engine=v5、distill 配置原样透传', () => {
  assert.deepEqual(
    IDX.memoryV5Config({ v5: { enabled: true, engine: 'v5', distill: { enabled: false, intervalMin: 5 } } }),
    { enabled: true, engine: 'v5', distill: { enabled: false, intervalMin: 5 } })
})

test('memoryV5Config：脏值回落（engine 只认 v5，大小写不敏感；间隔夹 1–120）', () => {
  assert.equal(IDX.memoryV5Config({ v5: { engine: 'V5' } }).engine, 'v5', '大小写不敏感（手改配置常见）')
  for (const bad of ['true', 'v5x', 1, null, '']) {
    assert.equal(IDX.memoryV5Config({ v5: { engine: bad } }).engine, 'v4')
  }
  assert.equal(IDX.memoryV5Config({ v5: { distill: { intervalMin: 999 } } }).distill.intervalMin, 120)
  assert.equal(IDX.memoryV5Config({ v5: { distill: { intervalMin: 0.1 } } }).distill.intervalMin, 1)
  assert.equal(IDX.memoryV5Config({ v5: { distill: { intervalMin: 'abc' } } }).distill.intervalMin, 10)
  assert.equal(IDX.memoryV5Config({ v5: { enabled: false } }).enabled, false)
})

test('缺省守卫：store 默认值（可能只有 enabled）喂进 memoryV5Config 仍得 v4 + 10 分钟', () => {
  // task-18 的写盘范围不含 lib/store.js，所以 engine/distill 的默认值由
  // memoryV5Config() 兜底：老配置/新装的 config.json 里没有这些键时也必须 v4，
  // 绝不能因为缺键就悄悄切成 v5。
  const m = STORE.defaults().memory
  assert.deepEqual(IDX.memoryV5Config(m), V5_DEFAULTS,
    'store 默认值喂进去必须落在 v4 + 10 分钟（缺键不能变成 v5）')
  // 如果以后有人把 engine 写进 store 默认值，那个值必须是 v4（Step 3 前不切默认）
  if (m.v5 && m.v5.engine !== undefined) assert.equal(m.v5.engine, 'v4')
})

test('源码级：bridgeConfig 把 memoryV5Config() 嵌在 v5 子对象里（不是摊平）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'index.js'), 'utf8')
  const start = src.indexOf('function bridgeConfig (cfg) {')
  assert.ok(start > 0)
  const memoryAt = src.indexOf('memory: (() => {', start)
  const chunk = src.slice(memoryAt, memoryAt + 4200)
  // 🔴 形状必须是 `v5: memoryV5Config(...)`。摊平的 `...memoryV5Config(...)`
  //    会让桥的 config.memory.v5.engine 永远是 undefined → 引擎永远 v4，
  //    设置页选 v5 / config.json 写 v5 全部失效（2026-11-05 线上实测踩到）。
  assert.match(chunk, /v5:\s*memoryV5Config\(cfg\.memory\)/,
    'bridgeConfig 必须把 v5 配置嵌在 memory.v5 下 —— 摊平会让桥的 engine 永远读不到')
  // 反面判据不能用正则扫全文：注释里就会写到那串反例（这条断言自己踩过）。
  // 改成「去掉注释行后再断言没有摊平写法」。
  const codeOnly = chunk.split('\n')
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .filter(line => !line.includes('memoryV5Config(cfg.memory)') || !/\/\/|\*/.test(line))
    .join('\n')
  assert.doesNotMatch(codeOnly, /\.\.\.memoryV5Config\(/,
    '不要再摊平 memoryV5Config：桥读的是 config.memory.v5.*，摊平等于没透传')
})

// ── 形状对齐：插件写出来的结构必须正好是桥读的结构 ──────────────────────────
//
// 背景（2026-11-05 线上实锤）：插件的 bridgeConfig() 把 v5 配置**摊平**写在
// `memory.enabled/engine/distill`，而桥读 `config.memory.v5.engine`。两边各写各的，
// 唯一的守卫是源码正则 —— 正则只证明「这行代码在」，不证明「产出的结构对」。
// 结果：设置页切 v5、config.json 写 engine=v5，桥起来仍然 `engine=v4`，无声无息。
//
// 这一组用例不看源码，直接**模拟桥的读取方式**取值，锁定那条契约。
test('形状对齐：memory.v5 能被桥的读取方式取到 engine', () => {
  // 复刻 lib/bridge/index.js 的 v5Cfg / memoryEngine 读法（不 import 桥：
  // 桥模块顶层就 loadConfig + 起副作用，单测不能碰）。
  const shape = IDX.memoryV5Config({ v5: { enabled: true, engine: 'v5', distill: { intervalMin: 5 } } })
  // 插件要把它放在 memory.v5 这个位置（就是 index.js 里 `v5: memoryV5Config(...)`）
  const memory = { enabled: true, dir: '/tmp/mem', v5: shape }

  const v5Cfg = (cfg) => {
    const v = cfg.memory?.v5
    return v && typeof v === 'object' ? v : {}
  }
  const memoryEngine = (cfg) => {
    const raw = String(cfg?.memory?.v5?.engine ?? '').trim().toLowerCase()
    return raw === 'v5' ? 'v5' : 'v4'
  }
  assert.equal(memoryEngine({ memory }), 'v5', '按桥的读法必须能取到 v5')
  assert.equal(v5Cfg({ memory }).enabled, true)
  assert.equal(v5Cfg({ memory }).distill.intervalMin, 5)

  // 反面：如果是摊平结构（历史 bug），桥的读法只能拿到 v4 —— 这就是当时的现场
  const flat = { enabled: true, ...IDX.memoryV5Config({ v5: { engine: 'v5' } }) }
  assert.equal(memoryEngine({ memory: flat }), 'v4',
    '摊平结构必然回落 v4 —— 这条断言把当年的事故固化成回归测试')
})

test('形状对齐：memory.enabled（记忆总开关）不被 v5.enabled 覆盖', () => {
  // 摊平写法除了 engine，还会用 v5.enabled 覆盖 memory.enabled：
  // 用户关掉记忆总开关后桥仍认为开着。嵌成子对象后两者互不干扰。
  const v5 = IDX.memoryV5Config({ enabled: false })       // 记忆总开关关，v5 段没显式关
  const memory = { enabled: false, v5 }
  assert.equal(memory.enabled, false, 'memory.enabled 必须保持用户的总开关值')
  assert.equal(memory.v5.enabled, true, 'v5.enabled 是独立的一层（默认开），不该被总开关连带')
})
