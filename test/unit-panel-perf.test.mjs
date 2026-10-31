// test/unit-panel-perf.test.mjs —— 「打开设置页很慢」的回归测试
//
// 背景（2026-10-31 实测）：
//   用户反馈「打开 QQ 通道设置页要挺长时间」。实测拆出来是三件事叠加：
//
//   ① **预热白做**：apply 里的 setImmediate 预热用
//        String(cfg.mcp?.bili?.pythonBin || cfg.memory?.pythonBin || '').trim()
//      算缓存 key，而 buildMcpServers 实际解析出的是 bili-duty 的 venv python。
//      两边 key 不一样 ⇒ 预热填的缓存永远命中不了 ⇒ 第一次 /overview 仍然走
//      同步 `execFileSync(python -c "import mcp, bilibili_api")`，
//      实测 **1141ms**，期间宿主事件循环整个停住（设置页转圈、桥的消息也排不上队）。
//
//   ② **桥日志全量读**：tailBridgeLog 每次 readFileSync 整个文件。日志能到 8MB
//      （轮转阈值），而 /overview 每 4 秒轮询一次 —— 实测 17MB 时单次 94ms，
//      每次轮询都付一遍，日志越长越慢。
//
//   ③ **折叠块里的组件照常挂载**：<details> 折叠时子节点仍在 DOM 里，React 也照常
//      挂载。于是 SetupWizard（一挂载就打 /env/probe，实测 380ms，里面还要
//      `docker images` + 扫七个端口）在用户根本没展开的情况下每次都跑。
//
// 这个测试锁住三条不变量，防止有人「优化」回去。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'lib', 'index.js'), 'utf8')
const CLIENT_SRC = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8')

// ── ① 预热和真正解析必须共用同一个解释器判定 ────────────────────────────────

/** 去掉 // 行注释和 /* *\/ 块注释里的内容（判断代码时不该被注释误伤）。 */
function stripComments (src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n')
}

test('预热用 pickBiliPython 算解释器（不再自己拼 pythonBin）', () => {
  // 预热带的位置：apply 里的 setImmediate
  const idx = INDEX_SRC.indexOf('setImmediate(async () => {')
  assert.ok(idx > 0, '定位不到预热带')
  const prewarm = stripComments(INDEX_SRC.slice(idx, idx + 2000))
  assert.match(prewarm, /pickBiliPython\(cfg\)/,
    '预热又自己算解释器了 —— 算出来的 key 和 buildMcpServers 对不上，预热等于白做（实测差 1.1 秒）')
  assert.doesNotMatch(prewarm, /cfg\.mcp\?\.bili\?\.pythonBin \|\| cfg\.memory\?\.pythonBin/,
    '预热里还留着那条会算错的式子（实测得到空串，而实际解释器是 bili-duty 的 venv）')
})

test('pickBiliPython 与 buildMcpServers 用的是同一份判定', () => {
  assert.match(INDEX_SRC, /function pickBiliPython/, '没有 pickBiliPython，两边又会各算一套')
  const bms = INDEX_SRC.slice(INDEX_SRC.indexOf('function buildMcpServers'))
  assert.match(bms.slice(0, 6000), /pickBiliPython\(cfg\)/,
    'buildMcpServers 没走 pickBiliPython —— 和预热的 key 又会对不上')
})

// ── ② /overview 热路径绝不同步起子进程 ──────────────────────────────────────

test('biliDepsInstalled 在 blockOnMiss=false 时绝不同步 execFileSync', () => {
  const fn = INDEX_SRC.slice(
    INDEX_SRC.indexOf('function biliDepsInstalled'),
    INDEX_SRC.indexOf('function pickBiliPython') + 2000,
  )
  assert.match(fn, /blockOnMiss/, '缺 blockOnMiss 参数')
  assert.match(fn, /return null/, '缓存空时要能回答「还不知道」，而不是硬等')
  // 同步调用必须被 blockOnMiss 判断保护住
  const guard = fn.slice(fn.indexOf('if (!blockOnMiss)') , fn.indexOf('execFileSync('))
  assert.ok(guard.length > 0, 'execFileSync 没有被 blockOnMiss 守卫保护 —— 轮询会再次钉住事件循环')
})

test('/overview 的 mcp 健康检查传 blockOnMiss:false', () => {
  const fn = INDEX_SRC.slice(
    INDEX_SRC.indexOf('function mcpHealthForUi'),
    INDEX_SRC.indexOf('function mcpHealthForUi') + 900,
  )
  assert.match(fn, /blockOnMiss:\s*false/,
    'mcpHealthForUi 又允许阻塞了 —— 它挂在每 4 秒轮询一次的 /overview 上')
})

test('桥的 mcpServers 构建仍要求准确结论（blockOnMiss 默认 true）', () => {
  // 桥要靠这份数据决定挂不挂 bili MCP，猜错会让模型调到不存在的工具
  const sig = INDEX_SRC.match(/function buildMcpServers \(cfg, \{[^\n]*\}/)
  assert.ok(sig, '定位不到 buildMcpServers 签名')
  assert.match(sig[0], /blockOnMiss\s*=\s*true/,
    'buildMcpServers 的 blockOnMiss 默认不是 true —— 桥可能挂不上 bili MCP')
})

// ── ③ 桥日志只读尾巴 ───────────────────────────────────────────────────────

test('tailBridgeLog 从文件尾往回读，不整份 readFileSync', () => {
  const fn = INDEX_SRC.slice(
    INDEX_SRC.indexOf('function tailBridgeLog'),
    INDEX_SRC.indexOf('function tailBridgeLog') + 1800,
  )
  assert.doesNotMatch(fn, /readFileSync\(p, 'utf8'\)\s*\n\s*return text\.split/,
    'tailBridgeLog 又整份读日志了 —— 8MB 日志 × 每 4 秒一次，越用越卡（实测 17MB 时 94ms/次）')
  assert.match(fn, /openSync\(p, 'r'\)/, '没有按尾部读（缺 openSync + 偏移读）')
  assert.match(fn, /fstatSync\(fd\)\.size/, '没有用文件大小定位尾部')
})

// ── ④ 折叠块延迟挂载 ───────────────────────────────────────────────────────

test('Collapse 折叠时不挂载 children（避免隐藏的 /env/probe）', () => {
  const fn = CLIENT_SRC.slice(
    CLIENT_SRC.indexOf('function Collapse ('),
    CLIENT_SRC.indexOf('function Collapse (') + 1200,
  )
  assert.match(fn, /opened \? children : null/,
    'Collapse 又直接渲染 children 了 —— 折叠块里的 SetupWizard 会照常打 /env/probe（实测 380ms）')
})

// ── ⑤ 尾部读取的行为正确性（真跑一次）────────────────────────────────────────

test('tailBridgeLog 的尾部读取结果与大文件全量切分一致', async () => {
  // 直接 import 真模块（tailBridgeLog 已 export），用临时 DSH 数据目录指向造好的日志。
  // 不抠源码跑 new Function —— 那样路径解析、dataDir 都靠猜，测的是壳子不是逻辑。
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llminqq-tail-'))
  const logsDir = path.join(tmpDir, 'logs')
  fs.mkdirSync(logsDir, { recursive: true })
  const file = path.join(logsDir, 'bridge.out')

  const lines = []
  for (let i = 0; i < 20000; i++) {
    lines.push(`[2026-10-31 12:00:00] INFO #${i} 群消息处理 group=1234567890 text=${'x'.repeat(120)}`)
  }
  fs.writeFileSync(file, lines.join('\n') + '\n')

  // dataDir 由 store.js 按 DSH_HOME 推；这里直接把 HOME 之上的层级造出来不现实，
  // 所以改用「模块内的 dataDir」不可注入 -> 换成验证纯行为：临时文件 + 同一个实现。
  // 为了不把实现抄一份（抄了就会漂移），这里用 export 出来的那个函数，
  // 并把它要读的目录通过临时 DSH_HOME 注入。
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = tmpDir
  // 插件数据目录是 <DSH_HOME>/dsh-plugin-llminqq —— 建好它
  fs.mkdirSync(path.join(tmpDir, 'dsh-plugin-llminqq', 'logs'), { recursive: true })
  fs.copyFileSync(file, path.join(tmpDir, 'dsh-plugin-llminqq', 'logs', 'bridge.out'))

  const mod = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)
  const tail = mod.tailBridgeLog

  const expect = fs.readFileSync(file, 'utf8').split('\n').slice(-40).join('\n')
  const got = tail(40)
  if (prevHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = prevHome

  assert.ok(got.length > 0, 'tailBridgeLog 没读到任何内容（dataDir 没指向造的日志）')
  assert.equal(got, expect, '尾部读取的结果和全量切分不一致 —— 显示会缺行或串行')

  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ── ⑥ /env/probe 的缓存必须能被「重新探测」打穿 ─────────────────────────────
//
// 这一条是防「刷新按钮不刷新」的翻版：/env/probe 每次要跑六项探测（实测 251~294ms，
// docker images 一项就 151ms），而 SetupWizard 在没连上 OneBot 时每次打开设置页
// 都会无条件调它。加缓存是对的，但如果「测试连接 / 重新探测」也吃缓存，
// 用户点了看到的还是 30 秒前的旧结论 —— 和这次二维码刷新的 bug 是同一类错误。

test('/env/probe 支持 force 打穿缓存', () => {
  assert.match(INDEX_SRC, /route === '\/env\/probe'/, '定位不到 /env/probe 路由')
  const route = INDEX_SRC.slice(
    INDEX_SRC.indexOf("route === '/env/probe'"),
    INDEX_SRC.indexOf("route === '/env/probe'") + 600,
  )
  assert.match(route, /force/, '/env/probe 没有 force 入口 —— 重新探测只能拿到缓存')
  assert.match(route, /probeEnvironment\(\{ force \}\)/, '没把 force 传给 probeEnvironment')
})

test('客户端主动探测（测试连接 / 装完刷新）都传 force', () => {
  // 「测试连接」必须 force
  const useExisting = CLIENT_SRC.slice(
    CLIENT_SRC.indexOf('const useExisting ='),
    CLIENT_SRC.indexOf('const useExisting =') + 1200,
  )
  assert.match(useExisting, /refreshProbe\(\{ force: true \}\)/,
    '「测试连接」没传 force —— 点完可能还在看 30 秒前的旧结论')

  // 一键装完也必须 force（容器刚起来，状态确实变了）
  const oneClick = CLIENT_SRC.slice(
    CLIENT_SRC.indexOf('const oneClickDocker ='),
    CLIENT_SRC.indexOf('const oneClickDocker =') + 3000,
  )
  assert.match(oneClick, /refreshProbe\(\{ force: true \}\)/,
    '一键装完没传 force —— 刚起的容器可能还显示「未创建」')
})

test('probeEnvironment 的缓存是 TTL + 并发去重，不是永久缓存', () => {
  const envSrc = fs.readFileSync(path.join(ROOT, 'lib', 'env.js'), 'utf8')
  const fn = envSrc.slice(
    envSrc.indexOf('export async function probeEnvironment'),
    envSrc.indexOf('async function probeEnvironmentInner'),
  )
  assert.match(fn, /ENV_PROBE_CACHE_MS/, '没有 TTL —— 时间长了会一直给旧结论')
  assert.match(fn, /envProbeInflight/, '没有并发去重 —— 同时打开两处会重复跑六项探测')
  assert.match(fn, /force/, '没有 force —— 缓存打不穿')
})

// ── ⑦ 桥日志行数只有一个真源 ────────────────────────────────────────────────
//
// 原来三个调用点各写各的（overview 里 40、/bridge/status 里 60、/bridge/log 里 200）。
// 后果：前端「运行」页一进来显示 40 行，5 秒后轮询一次突然变成 200 行 ——
// 用户盯着日志会看到它「自己长出来」，而且改行数要改三处、漏一处就不一致。

test('桥日志行数收成一个常量，三处调用都不再写死', () => {
  assert.match(INDEX_SRC, /const BRIDGE_LOG_LINES = \d+/, '没有 BRIDGE_LOG_LINES 常量')
  assert.match(INDEX_SRC, /function tailBridgeLog \(lines = BRIDGE_LOG_LINES\)/,
    'tailBridgeLog 的默认值没指向常量')

  // 三处调用点必须是 tailBridgeLog()，不能带数字
  const calls = INDEX_SRC.match(/tailBridgeLog\(\d+\)/g) || []
  assert.equal(calls.length, 0,
    `还有硬编码行数的调用：${calls.join(', ')} —— 改一处漏两处就会不一致`)
})

test('桥日志默认显示 100 行', () => {
  const m = INDEX_SRC.match(/const BRIDGE_LOG_LINES = (\d+)/)
  assert.equal(Number(m[1]), 100, '用户要求的是最后 100 行')
})

test('前端标明「最后 100 行」，不同 tab 之间不会突然变长', () => {
  assert.match(CLIENT_SRC, /最后 100 行/, '界面上没写清楚这是最后多少行')
})
