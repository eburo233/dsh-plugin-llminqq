// test/unit-memory-env.test.mjs —— P1-4：桥和调度器跑在不同 stateDir（两套 style.db）
// 以及 memoryEnv 缺 LLMINQQ_CONFIG（reflect 永远退回拼接法）
//
// 背景（docs/MEMORY-AUDIT-AND-V5.md §2 P1-4 / §4 Step 0 第 3·4·11 条）：
//   两处 stateDir 推导不一致：
//     lib/index.js 起桥时   LLMINQQ_STATE_DIR = <dataDir>/state          ← 桥传给 python
//     调度器 memory-run.mjs LLMINQQ_STATE_DIR = memoryStateDir(cfg)      ← <dataDir>/agent/memory
//   桥把 env 原样透给 python（execFileSync 继承 process.env），于是：
//     · 桥写的 style.db 在 <dataDir>/state（活的那份，106 条）
//     · 导出 zip / 设置页 / 调度器读 <dataDir>/agent/memory（停的那份，16 条）
//   两份库**共用一个游标** → 谁先跑谁推进，另一个就跳过。
//
// 另外 memoryEnv 的注释写着「LLMINQQ_STATE_DIR / LLMINQQ_CONFIG」，但代码里
// 只设了前者 → reflection_llm.mjs 找不到桥配置 → reflect 静默退回拼接法。
//
// 这组测试锁住三件事：
//   ① 只有 memoryStateDir() 一个真源（桥 / 调度器 / 导出 / 设置页同一个 style.db）；
//   ② memoryEnv 真的把 LLMINQQ_STATE_DIR 和 LLMINQQ_CONFIG 都给了子进程；
//   ③ 桥自己的 state.json（会话映射 + 好感度）会被迁移，不会因为换目录归零。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'llminqq-memenv-'))
process.env.HOME = TMP_HOME
process.env.USERPROFILE = TMP_HOME
process.env.DSH_HOME = path.join(TMP_HOME, '.dsh')
// 这个测试要自己控制 LLMINQQ_CONFIG 的有无，先清掉环境里的（CI/开发机可能有）
const PREV_CFG_ENV = process.env.LLMINQQ_CONFIG
delete process.env.LLMINQQ_CONFIG

const STORE = await import(pathToFileURL(path.join(ROOT, 'lib', 'store.js')).href)
const DIRS = await import(pathToFileURL(path.join(ROOT, 'lib', 'agent', 'dirs.mjs')).href)
const MEMRUN = await import(pathToFileURL(path.join(ROOT, 'lib', 'agent', 'memory-run.mjs')).href)
const IDX = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)

test.after(() => {
  if (PREV_CFG_ENV === undefined) delete process.env.LLMINQQ_CONFIG
  else process.env.LLMINQQ_CONFIG = PREV_CFG_ENV
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }) } catch { /* ignore */ }
})

const cfgOf = () => STORE.defaults()

// ── ① stateDir 只有一个真源 ────────────────────────────────────────────────
test('memoryStateDir 是唯一真源：默认 <dataDir>/agent/memory', () => {
  const dir = DIRS.memoryStateDir(cfgOf())
  assert.equal(dir, path.join(STORE.dataDir(), 'agent', 'memory'))
  // 所有「数据在哪」的推导都必须经过它
  const paths = DIRS.memoryPaths(cfgOf())
  assert.equal(paths.dir, dir)
  assert.equal(paths.style, path.join(dir, 'style.db'), 'style.db 必须在 stateDir 里（P1-4 的那个文件）')
  assert.equal(paths.db, path.join(dir, 'mem.db'))
})

test('memoryEnv 的 LLMINQQ_STATE_DIR 就是 memoryStateDir（桥/调度器同一套）', () => {
  const cfg = cfgOf()
  const env = MEMRUN.memoryEnv({ cfg })
  assert.equal(env.LLMINQQ_STATE_DIR, DIRS.memoryStateDir(cfg),
    'memoryEnv 没有用 memoryStateDir —— 桥和调度器又会各写一套 style.db')
  // python 侧 run.py 用 LLMINQQ_STATE_DIR + 'style.db' 拼路径，和 memoryPaths 必须一致
  assert.equal(path.join(env.LLMINQQ_STATE_DIR, 'style.db'), DIRS.memoryPaths(cfg).style)
})

test('显式 stateDir 覆盖仍然有效（测试隔离/多实例用），且换成它的 style.db', () => {
  const cfg = cfgOf()
  const other = path.join(TMP_HOME, '另一个目录')
  const env = MEMRUN.memoryEnv({ cfg, stateDir: other })
  assert.equal(env.LLMINQQ_STATE_DIR, other)
  assert.equal(path.join(env.LLMINQQ_STATE_DIR, 'style.db'), path.join(other, 'style.db'))
})

test('源码级：起桥不再把 <dataDir>/state 当 LLMINQQ_STATE_DIR', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'index.js'), 'utf8')
  const start = src.indexOf('async function startBridge')
  const region = src.slice(start, start + 7000)
  assert.match(region, /LLMINQQ_STATE_DIR: memStateDir/,
    '桥进程的 LLMINQQ_STATE_DIR 没指到记忆数据目录 —— python 又会写 <dataDir>/state/style.db')
  assert.match(region, /const memStateDir = memoryStateDir\(cfg\)/,
    'startBridge 里没有用 memoryStateDir(cfg) 推导')
  assert.doesNotMatch(region, /LLMINQQ_STATE_DIR: stateDir/,
    'startBridge 里还留着老的 stateDir 变量（= <dataDir>/state，split-brain 的源头）')
  // 调度器那边同理
  assert.match(src, /stateDir: memoryStateDir\(cfgNow\)/, '调度器没用 memoryStateDir')
})

test('运行态目录和记忆目录是两个东西，各自由一个函数给出（谁读谁写不靠猜）', () => {
  const rt = IDX.bridgeRuntimeStateDir()
  assert.equal(rt, path.join(STORE.dataDir(), 'state'))
  const mem = DIRS.memoryStateDir(cfgOf())
  assert.notEqual(rt, mem, '运行态目录和记忆目录必须分开（否则又把 python 数据卷进桥的运行态里）')
  assert.equal(IDX.bridgeConfigFilePath(), path.join(STORE.dataDir(), 'bridge-config.json'))
  // 桥配置里 memory.stateDir 指向运行态目录（transcribe-ready 的读写方）
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'index.js'), 'utf8')
  assert.match(src, /stateDir: bridgeRuntimeStateDir\(\),\s*\n\s*\/\/ 代码目录 \+ launcher/,
    'bridgeConfig 的 memory.stateDir 没指向 bridgeRuntimeStateDir()')
  // bili MCP 必须显式拿到同一个目录（否则它继承桥的 LLMINQQ_STATE_DIR = 记忆目录，
  // 转写结果写进记忆目录、桥在运行态目录里永远扫不到）
  const mcpRegion = src.slice(src.indexOf("name: 'bilibili'"), src.indexOf("name: 'bilibili'") + 1200)
  assert.match(mcpRegion, /LLMINQQ_STATE_DIR', value: bridgeRuntimeStateDir\(\)/,
    'bili MCP 的 env 里没显式给 LLMINQQ_STATE_DIR —— 转写结果会写到错目录')
})

// ── ② memoryEnv 必须带 LLMINQQ_CONFIG ─────────────────────────────────────
test('memoryEnv 带 LLMINQQ_CONFIG（指向 <dataDir>/bridge-config.json）', () => {
  const bridgeCfg = path.join(STORE.dataDir(), 'bridge-config.json')
  fs.mkdirSync(STORE.dataDir(), { recursive: true })
  fs.writeFileSync(bridgeCfg, JSON.stringify({ dsh: { bin: 'dsh', profile: 'acp', provider: 'p', model: 'm' } }))
  try {
    const env = MEMRUN.memoryEnv({ cfg: cfgOf() })
    assert.equal(env.LLMINQQ_CONFIG, bridgeCfg,
      'memoryEnv 没给 LLMINQQ_CONFIG —— reflection_llm.mjs 只能在包里找 bridge/config.json（不存在）'
      + ' → 反思静默退回拼接法（P0-1）')
  } finally {
    try { fs.unlinkSync(bridgeCfg) } catch { /* ignore */ }
  }
})

test('显式 configPath 优先于默认探测（调度器走这条）', () => {
  const explicit = path.join(TMP_HOME, '显式配置.json')
  fs.writeFileSync(explicit, '{}')
  const env = MEMRUN.memoryEnv({ cfg: cfgOf(), configPath: explicit })
  assert.equal(env.LLMINQQ_CONFIG, explicit)
})

test('process.env.LLMINQQ_CONFIG 优先于默认探测（桥的子进程走这条）', () => {
  const fromEnv = path.join(TMP_HOME, '环境变量配置.json')
  fs.writeFileSync(fromEnv, '{}')
  process.env.LLMINQQ_CONFIG = fromEnv
  try {
    const env = MEMRUN.memoryEnv({ cfg: cfgOf() })
    assert.equal(env.LLMINQQ_CONFIG, fromEnv, '桥自己 spawn python 时带的 LLMINQQ_CONFIG 要被保留')
  } finally {
    delete process.env.LLMINQQ_CONFIG
  }
})

test('找不到任何配置时**不设**这个变量（别指一个不存在的路径去误导排查）', () => {
  const env = MEMRUN.memoryEnv({ cfg: cfgOf(), configPath: '', stateDir: path.join(TMP_HOME, 'x') })
  assert.equal('LLMINQQ_CONFIG' in env, false, '空串比「未设置」更糟：子进程会去读一个不存在的文件')
})

test('memoryEnv 的其它约定没被破坏（UTF-8 / 不写 pyc / 生产声明 / NODE_BIN）', () => {
  const env = MEMRUN.memoryEnv({ cfg: cfgOf() })
  assert.equal(env.PYTHONIOENCODING, 'utf8')
  assert.equal(env.PYTHONUTF8, '1')
  assert.equal(env.PYTHONDONTWRITEBYTECODE, '1')
  assert.equal(env.MEMCTL_PROD, '1', '不声明生产身份的话 memctl 会拒绝写库')
  assert.ok(env.NODE_BIN, 'NODE_BIN 缺了 → reflection_llm.mjs 找不到 node → 静默退拼接法')
  assert.ok(env.LLMINQQ_BRIDGE_LOG, 'LLMINQQ_BRIDGE_LOG 缺了 → ingest 永远「新增 0 条」')
})

// ── ③ ensureBridgeConfigFile：调度器起跑前桥配置要存在 ────────────────────
test('ensureBridgeConfigFile：缺了就生成，有了就不动（幂等）', () => {
  const file = IDX.bridgeConfigFilePath()
  try { fs.unlinkSync(file) } catch { /* ignore */ }
  const got = IDX.ensureBridgeConfigFile()
  assert.equal(got, file)
  assert.equal(fs.existsSync(file), true, '首次安装时 ensureScheduler 先于 startBridge 跑，配置得在这里生成')
  const first = fs.readFileSync(file, 'utf8')
  const mtime1 = fs.statSync(file).mtimeMs
  const again = IDX.ensureBridgeConfigFile()
  assert.equal(again, file)
  assert.equal(fs.statSync(file).mtimeMs, mtime1, '已存在时不该重写（否则每次启动都刷 mtime）')
  assert.equal(fs.readFileSync(file, 'utf8'), first)
})

// ── ④ 桥的 state.json 迁移（换目录不能把好感度清零）──────────────────────
test('migrateBridgeStateFile：把 <dataDir>/state/state.json 拷到记忆目录（源保留）', () => {
  const cfg = cfgOf()
  const from = path.join(IDX.bridgeRuntimeStateDir(), 'state.json')
  const to = path.join(DIRS.memoryStateDir(cfg), 'state.json')
  fs.mkdirSync(path.dirname(from), { recursive: true })
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.writeFileSync(from, JSON.stringify({ peers: { 'c2c:1': 'sess-1' }, people: { '1': { aff: 12 } } }))
  try { fs.unlinkSync(to) } catch { /* ignore */ }

  const r = IDX.migrateBridgeStateFile(cfg)
  assert.equal(r.moved, true)
  assert.equal(fs.existsSync(to), true, '没迁移的话桥在新目录看不到 state.json → 好感度/会话映射全归零')
  const moved = JSON.parse(fs.readFileSync(to, 'utf8'))
  assert.equal(moved.peers['c2c:1'], 'sess-1')
  assert.equal(moved.people['1'].aff, 12, '好感度必须一起搬过去（这是用户攒了几个月的关系）')
  assert.equal(fs.existsSync(from), true, '源文件要保留（回滚/手工捞都靠它）')

  // 幂等：目标已存在就不再覆盖（否则会拿旧拷贝盖掉桥正在写的新状态）
  fs.writeFileSync(to, JSON.stringify({ peers: {}, people: {}, 新的: true }))
  const r2 = IDX.migrateBridgeStateFile(cfg)
  assert.equal(r2.moved, false)
  assert.equal(JSON.parse(fs.readFileSync(to, 'utf8')).新的, true, '目标已存在时不能被源覆盖')
  fs.rmSync(from, { force: true })
})

test('migrateBridgeStateFile：源不存在时什么都不做（新用户）', () => {
  const cfg = cfgOf()
  const from = path.join(IDX.bridgeRuntimeStateDir(), 'state.json')
  const to = path.join(DIRS.memoryStateDir(cfg), 'state.json')
  try { fs.unlinkSync(from) } catch { /* ignore */ }
  try { fs.unlinkSync(to) } catch { /* ignore */ }
  const r = IDX.migrateBridgeStateFile(cfg)
  assert.equal(r.moved, false)
  assert.equal(fs.existsSync(to), false)
})
