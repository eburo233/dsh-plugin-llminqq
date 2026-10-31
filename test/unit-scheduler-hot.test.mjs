// test/unit-scheduler-hot.test.mjs —— 「打开总开关后调度器没起来」的回归测试
//
// 背景（2026-10-31 用户实测）：
//   用户在设置页把总开关打开，桥起来了、CPU 问题也修好了，
//   但 /overview 里始终是：
//       {"enabled": false, "tasks": []}
//   —— 两个字段都空，正是 `scheduler ? scheduler.status() : {enabled:false,tasks:[]}`
//   的默认值，说明 **scheduler 变量是 null，调度器根本没被创建**。
//
// 根因：调度器只在 apply 里创建，判断用的是
//       const cfg = readConfig()      ← 插件加载那一刻的快照
//       if (cfg.enabled) { ... }
//   用户在**加载之后**才打开开关，那个 if 早就过去了。
//   于是 ingest(5min)/reflect(8h)/digest(30min)/learn(12h) 全部停摆，
//   而设置页完全看不出来 —— 用户以为「打开开关就全好了」。
//
// 修法：抽出 ensureScheduler(enabled)，启动时调一次、保存配置时再调一次，
//   让开关真正实时生效。这个测试直接打这个状态机。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

/** 极简 logger：把日志收集起来，方便断言「有没有提示用户」 */
function mkLogger () {
  const lines = []
  return {
    lines,
    logger: {
      info: m => lines.push(String(m)),
      warn: m => lines.push(String(m)),
      debug: () => {},
    },
  }
}

// ensureScheduler 会用到 readConfig()/dataDir()，这些都指向真实数据目录。
// 为了不碰生产状态，先把 DSH_HOME 指到临时目录（store.js 按它反推 dataDir）。
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'llminqq-hot-'))
const prevHome = process.env.DSH_HOME
process.env.DSH_HOME = tmpHome
// 造出插件数据目录（store.js 的 dataDir 是 <DSH_HOME>/dsh-plugin-llminqq）
fs.mkdirSync(path.join(tmpHome, 'dsh-plugin-llminqq'), { recursive: true })

const IDX = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)
const { ensureScheduler, _schedulerState } = IDX
const { saveConfig, readConfig } = await import(pathToFileURL(path.join(ROOT, 'lib', 'store.js')).href)

function restoreHome () {
  if (prevHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = prevHome
  try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch { /* ignore */ }
}
process.on('exit', restoreHome)

test('关闭状态调 ensureScheduler → 不创建调度器', async () => {
  const { logger } = mkLogger()
  // 先确保是关的
  saveConfig({ enabled: false })
  const r = await ensureScheduler({ logger }, false)
  assert.equal(r.ok, true)
  assert.equal(r.running, false, '关闭时不该有调度器在跑')
  assert.equal(_schedulerState(), null, 'scheduler 变量应该保持 null')
})

test('开启状态调 ensureScheduler → 真的创建调度器（这是本次修复的核心）', async () => {
  const { logger } = mkLogger()
  saveConfig({ enabled: true })
  const r = await ensureScheduler({ logger }, true)
  assert.equal(r.ok, true, `启动失败：${r.reason || ''}`)
  assert.equal(r.running, true, '打开开关后必须有调度器在跑')
  const s = _schedulerState()
  assert.ok(s, 'scheduler 变量必须是非 null —— 否则 /overview 又会显示 enabled:false')

  // status() 要能给出真实任务表（这正是设置页看到的东西）
  const st = s.status()
  assert.equal(st.enabled, true, 'status().enabled 必须是 true')
  assert.ok(Array.isArray(st.tasks) && st.tasks.length > 0,
    'status().tasks 不能为空 —— 空就是外面看到的 {"enabled":false,"tasks":[]}')

  // 我这次加的 digest 任务必须在里面
  const names = st.tasks.map(t => t.name)
  for (const want of ['ingest', 'reflect', 'digest', 'learn']) {
    assert.ok(names.includes(want), `任务表里缺 ${want}（实际：${names.join(',')}）`)
  }
})

test('重复调用必须幂等（不能每次都新建一个调度器）', async () => {
  const { logger } = mkLogger()
  saveConfig({ enabled: true })
  const before = _schedulerState()
  const r2 = await ensureScheduler({ logger }, true)
  assert.equal(r2.running, true)
  assert.equal(r2.reason, '已在运行', '第二次调用应该识别「已在运行」而不是重建')
  assert.equal(_schedulerState(), before, '必须是同一个实例 —— 重建会让正在跑的任务被 SIGTERM')
})

test('on → off 会真的停掉调度器', async () => {
  const { logger } = mkLogger()
  saveConfig({ enabled: true })
  await ensureScheduler({ logger }, true)
  assert.ok(_schedulerState(), '前置：应该有调度器')

  saveConfig({ enabled: false })
  const r = await ensureScheduler({ logger }, false)
  assert.equal(r.ok, true)
  assert.equal(r.running, false)
  assert.equal(_schedulerState(), null, '关闭后 scheduler 变量必须清掉')
})

test('off → on 能重新起来（不是一次性）', async () => {
  const { logger } = mkLogger()
  // 关
  saveConfig({ enabled: false })
  await ensureScheduler({ logger }, false)
  assert.equal(_schedulerState(), null)
  // 再开
  saveConfig({ enabled: true })
  const r = await ensureScheduler({ logger }, true)
  assert.equal(r.running, true, '关掉之后必须还能再打开（不能永久失效）')
  assert.ok(_schedulerState())
  // 清理：停掉，避免测试间互相影响
  await ensureScheduler({ logger }, false)
})

test('/overview 的 scheduler 字段必须来自实时状态（而不是写死的默认值）', async () => {
  const fsMod = fs
  const src = fsMod.readFileSync(path.join(ROOT, 'lib', 'index.js'), 'utf8')
  // 默认值那条是可接受的（scheduler 为 null 时），但**创建逻辑**必须是实时的
  assert.match(src, /async function ensureScheduler/,
    '缺 ensureScheduler —— 调度器又只能在加载时创建，开关改了就不同步')
  assert.match(src, /void ensureScheduler\(ctx, cfg\.enabled\)/,
    'apply 里没有调 ensureScheduler')
  // 保存配置的路径上必须也调一次
  const saveBlock = src.slice(src.indexOf("route === '/config' && method === 'POST'"),
    src.indexOf("route === '/config' && method === 'POST'") + 3000)
  assert.match(saveBlock, /ensureScheduler\(ctx, nowOn\)/,
    '保存配置时没有同步调度器 —— 用户点「保存」开关不会立刻生效')
})
