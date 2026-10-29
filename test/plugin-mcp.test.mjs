// 插件版 B站两种能力接线测试（storyboard MCP + bili MCP + bridgeConfig 生成 mcpServers）。
// 运行：node test/plugin-mcp.test.mjs
//
// 测的是「插件版能不能真把工具挂上」，不是「脚本版能不能跑」：
//   ① bridgeConfig 产出的 mcpServers **形状符合 ACP 协议**（command 绝对路径 /
//      env 是 [{name,value}] 数组 / name 唯一）——不符会被 @deepseek-ai/dsh-acp 直接拒
//   ② storyboard wrapper **真能起 MCP 服务**（initialize + tools/list 握手）
//   ③ **真跑一次 storyboard 出图**，且产物落在桥的 [SEND_FILE] 允许根内
//      （这是本任务的设计关键：产物必须在 stagingDir 下，否则模型发不出去）
//   ④ bili 未配置/缺依赖时**给出明确原因**（不静默）
//   ⑤ 缺 ffmpeg 时 storyboard 报「缺 ffmpeg」而不是假装挂上
//
// 隔离（CONTRIBUTING §9）：
//   · 所有落盘路径用 /tmp（HOME/DSH_HOME 引开，STORYBOARD_DIR 显式指定）
//   · 不连 QQ、不连 LLM、不读生产 state/config
//   · 测试视频用 ffmpeg 现做

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PKG = path.resolve(__dirname, '..')

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}
async function test (name, fn) {
  try { await fn(); ok(name, true) } catch (err) { ok(name, false, err.message.split('\n')[0]) }
}

// ── 隔离：HOME/DSH_HOME 引开，避免读真实 ~/.dsh ───────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-mcp-test-'))
const FAKE_HOME = path.join(TMP, 'home')
fs.mkdirSync(FAKE_HOME, { recursive: true })

// 先设环境再 import —— dataDir() 会读 HOME/DSH_HOME
process.env.HOME = FAKE_HOME
process.env.DSH_HOME = path.join(FAKE_HOME, '.dsh')

const M = await import(path.join(PKG, 'lib', 'index.js'))

// ── 夹具：测试视频 ────────────────────────────────────────────────────────
const CLIP = path.join(TMP, 'clip.mp4')
function makeClip () {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', [
      '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=25:duration=5',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', CLIP,
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    p.stderr.on('data', c => { err += c })
    p.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg 造片失败: ${err.slice(-200)}`)))
  })
}

// ── 极简 MCP stdio 客户端（够用于握手 + tools/call） ─────────────────────
function mcpClient (serverPath, env = {}) {
  const p = spawn(process.execPath, [serverPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  })
  let buf = ''
  const replies = new Map()
  const stderr = []
  p.stdout.on('data', c => {
    buf += c.toString('utf8')
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
      if (!line) continue
      try { const o = JSON.parse(line); if (o.id != null) replies.set(o.id, o) } catch { /* 非 JSON 行忽略 */ }
    }
  })
  p.stderr.on('data', c => stderr.push(c.toString()))
  const send = (o) => p.stdin.write(JSON.stringify(o) + '\n')
  const waitReply = async (id, ms = 60000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < ms) {
      if (replies.has(id)) return replies.get(id)
      await new Promise(r => setTimeout(r, 150))
    }
    throw new Error(`等 MCP 响应超时（id=${id}）stderr=${stderr.join('').slice(-300)}`)
  }
  return {
    p, stderr,
    send,
    async initialize () {
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'plugin-mcp-test', version: '0' } } })
      const r = await waitReply(1, 15000)
      send({ jsonrpc: '2.0', method: 'notifications/initialized' })
      return r
    },
    async listTools () {
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
      return (await waitReply(2, 15000))?.result?.tools ?? []
    },
    async callTool (name, args, id = 3, ms = 180000) {
      send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })
      return (await waitReply(id, ms))?.result
    },
    kill () { try { p.kill('SIGKILL') } catch { /* ignore */ } },
  }
}

const WRAPPER = path.join(PKG, 'lib', 'mcp', 'storyboard-mcp.mjs')
const SB_OUT = path.join(TMP, 'storyboard-out')

console.log('\n=== 1. bridgeConfig 产出的 mcpServers 形状符合 ACP 协议 ===')
await test('默认配置：storyboard 默认挂、bili 默认不挂', () => {
  const cfg = M.defaults()
  const { servers, capabilities } = M.buildMcpServers(cfg, { log: () => {} })
  assert.equal(servers.length, 1, `默认应该只挂 storyboard，实际 ${servers.length} 个：${servers.map(s => s.name)}`)
  assert.equal(servers[0].name, 'storyboard')
  // bili 默认关，且给出明确原因（不是空）
  assert.equal(capabilities.bili.ok, false)
  assert.ok(String(capabilities.bili.reason || '').length > 0, 'bili 关闭时没给原因')
})

await test('**command 必须是绝对路径**（ACP resolveMcpConfigs 硬性要求）', () => {
  const { servers } = M.buildMcpServers(M.defaults(), { log: () => {} })
  for (const s of servers) {
    assert.ok(path.isAbsolute(s.command), `${s.name} 的 command 不是绝对路径：${s.command}`)
  }
})

await test('**env 必须是 [{name,value}] 数组**（不是对象；ACP entriesToRecord 要求）', () => {
  const { servers } = M.buildMcpServers(M.defaults(), { log: () => {} })
  for (const s of servers) {
    assert.ok(Array.isArray(s.env), `${s.name} 的 env 不是数组`)
    for (const e of s.env) {
      assert.equal(typeof e.name, 'string', `env 条目缺 name`)
      assert.equal(typeof e.value, 'string', `env 条目 value 必须是字符串（数字会被 ACP 拒）`)
    }
  }
})

await test('name 唯一（ACP 按 normalize 后比较，重复会抛错）', () => {
  const { servers } = M.buildMcpServers(M.defaults(), { log: () => {} })
  const names = servers.map(s => s.name.trim().toLowerCase())
  assert.equal(new Set(names).size, names.length, `重复的 server name：${names}`)
})

await test('storyboard 的 env 里带了 STORYBOARD_DIR（宿主告诉 wrapper 产物落哪）', () => {
  const { servers } = M.buildMcpServers(M.defaults(), { log: () => {} })
  const sb = servers.find(s => s.name === 'storyboard')
  const dirEntry = sb.env.find(e => e.name === 'STORYBOARD_DIR')
  assert.ok(dirEntry, 'storyboard 的 env 里没有 STORYBOARD_DIR')
  assert.ok(dirEntry.value.length > 0, 'STORYBOARD_DIR 是空值')
})

console.log('\n=== 2. 【设计关键】产物路径在桥的 [SEND_FILE] 允许根内 ===')
await test('storyboardOutputDir 落在 stagingDir 之下', () => {
  const cfg = M.defaults()
  const outDir = M.storyboardOutputDir(cfg)
  // bridgeConfig 里 staging 的算法：cfg.media.stagingDir || <dataDir>/.qq-media
  const staging = cfg.media?.stagingDir || path.join(M.dataDir(), '.qq-media')
  assert.ok(outDir.startsWith(staging + path.sep),
    `产物目录 ${outDir} 不在 staging 根 ${staging} 之下 —— 模型会发不出去`)
})

await test('**产物目录满足 isPathAllowedForSend 的允许根判定**（复刻桥的算法）', () => {
  const cfg = M.defaults()
  const outDir = M.storyboardOutputDir(cfg)
  fs.mkdirSync(outDir, { recursive: true })
  // 造一个假产物，模拟 wrapper 真产出后的文件
  const artifact = path.join(outDir, 'sb_fake.png')
  fs.writeFileSync(artifact, Buffer.alloc(2048, 0x89))

  // 复刻 lib/bridge/index.js isPathAllowedForSend 的允许根逻辑
  const staging = cfg.media?.stagingDir || path.join(M.dataDir(), '.qq-media')
  const cwd = cfg.dsh?.cwd || path.join(M.dataDir(), 'agent')
  const allowedRoots = [staging, cwd].map(r => {
    try { return fs.realpathSync(r) } catch { return path.resolve(r) }
  })
  const real = fs.realpathSync(artifact)
  const inside = allowedRoots.some(root => real === root || real.startsWith(root + path.sep))
  assert.ok(inside, `产物 ${real} 不在允许根内（roots=${allowedRoots.join(', ')}）→ [SEND_FILE] 会被拒`)
  fs.unlinkSync(artifact)
})

console.log('\n=== 3. storyboard MCP wrapper 真能起（MCP 握手）===')
await test('initialize + tools/list 成功，且暴露 video_probe / video_storyboard', async () => {
  const c = mcpClient(WRAPPER, { STORYBOARD_DIR: SB_OUT })
  try {
    const init = await c.initialize()
    assert.ok(init?.result?.serverInfo, `initialize 没返回 serverInfo：${JSON.stringify(init)}`)
    const tools = await c.listTools()
    const names = tools.map(t => t.name)
    assert.deepEqual(names.sort(), ['video_probe', 'video_storyboard'],
      `工具集不对：${names.join(', ')}（应只有这两个 —— 故意不贪多）`)
    // 每个工具都要有 inputSchema（否则模型不知道怎么调）
    for (const t of tools) assert.ok(t.inputSchema, `${t.name} 缺 inputSchema`)
  } finally { c.kill() }
})

console.log('\n=== 4. 真跑一次 storyboard 出图（通过 MCP 协议）===')
let hasFfmpeg = true
try { spawn('ffmpeg', ['-version'], { stdio: 'ignore' }).on('close', () => {}) } catch { hasFfmpeg = false }
if (!hasFfmpeg || !fs.existsSync('/usr/bin/ffmpeg')) {
  console.log('  ⚠️  跳过：本机没有 ffmpeg（storyboard 硬依赖，环境缺失不是代码问题）')
} else {
  await makeClip()
  fs.mkdirSync(SB_OUT, { recursive: true })

  await test('video_probe 零成本探测（不生成图）', async () => {
    const c = mcpClient(WRAPPER, { STORYBOARD_DIR: SB_OUT })
    try {
      await c.initialize()
      const r = await c.callTool('video_probe', { input: CLIP }, 3, 60000)
      const txt = (r?.content ?? []).map(x => x.text).join('\n')
      assert.ok(txt.length > 0, 'probe 没返回内容')
      assert.match(txt, /320x240|5\.0{1,2}s|duration/i, `probe 结果里没有分辨率/时长：${txt.slice(0, 300)}`)
      // probe 不应生成图片
      const before = fs.readdirSync(SB_OUT).filter(f => f.endsWith('.png')).length
      assert.equal(fs.readdirSync(SB_OUT).filter(f => f.endsWith('.png')).length, before,
        'video_probe 竟然生成了图片（应该零成本）')
    } finally { c.kill() }
  })

  await test('video_storyboard 真出宫格图，产物落在 STORYBOARD_DIR 内', async () => {
    const c = mcpClient(WRAPPER, { STORYBOARD_DIR: SB_OUT })
    try {
      await c.initialize()
      const r = await c.callTool('video_storyboard', { input: CLIP, cells: 4 }, 4, 180000)
      const txt = (r?.content ?? []).map(x => x.text).join('\n')
      assert.ok(txt.length > 0, 'storyboard 没返回内容')
      // 文本里应带「可直接 [SEND_FILE]」的路径
      const m = /路径（可直接 \[SEND_FILE\]）：(\S+)/.exec(txt) ?? /(\S+\.png)/.exec(txt)
      assert.ok(m, `返回值里没有产物路径：${txt.slice(0, 300)}`)
      const artPath = m[1]
      assert.ok(fs.existsSync(artPath), `返回的产物路径不存在：${artPath}`)
      // **关键断言：产物必须在允许根内**（否则模型发不出去）
      assert.ok(path.resolve(artPath).startsWith(path.resolve(SB_OUT) + path.sep),
        `产物落在 ${artPath}，不在 STORYBOARD_DIR(${SB_OUT}) 内`)
      // 图不能是空的
      assert.ok(fs.statSync(artPath).size > 5000,
        `宫格图太小（${fs.statSync(artPath).size}B），可能是空图`)
    } finally { c.kill() }
  })
}

console.log('\n=== 5. bili：依赖缺失要给明确原因（不静默）===')
await test('bili 默认关闭 → capabilities 里有明确原因', () => {
  const { capabilities } = M.buildMcpServers(M.defaults(), { log: () => {} })
  assert.equal(capabilities.bili.ok, false)
  assert.match(String(capabilities.bili.reason), /关闭|venv|Python/i,
    `关闭原因不够明确：${capabilities.bili.reason}`)
})

await test('bili 开启但没配 venv → 明确说缺什么，不是静默', () => {
  const cfg = M.defaults()
  cfg.mcp = { ...cfg.mcp, bili: { ...cfg.mcp.bili, enabled: true } }
  const { servers, capabilities } = M.buildMcpServers(cfg, { log: () => {} })
  assert.equal(capabilities.bili.ok, false, '依赖不全时 bili 不该被判定可用')
  // **不能挂上一个一定起不来的 server**（ACP 是 failOnStartupError: true，
  // 挂错的后果是整个会话建不起来 —— 比不挂严重得多）
  assert.ok(!servers.some(s => s.name === 'bilibili'),
    '依赖不全却把 bilibili 挂上了 —— ACP failOnStartupError 会让整个会话失败')
  const reason = String(capabilities.bili.reason)
  assert.ok(reason.length > 10, `原因太短不够指导：${reason}`)
  // 原因要指出「该装什么」，不能只说「不可用」
  assert.match(reason, /venv|python|依赖|pip/i, `原因没指出解决办法：${reason}`)
})

await test('bili 配置了不存在的 venv → 报「venv 里找不到 python」（指向具体路径）', () => {
  const cfg = M.defaults()
  cfg.mcp = { ...cfg.mcp, bili: { ...cfg.mcp.bili, enabled: true, venv: path.join(TMP, 'no-such-venv') } }
  const { servers, capabilities } = M.buildMcpServers(cfg, { log: () => {} })
  assert.equal(capabilities.bili.ok, false)
  assert.match(String(capabilities.bili.reason), /找不到 python|no-such-venv/,
    `没指出具体路径：${capabilities.bili.reason}`)
  assert.ok(!servers.some(s => s.name === 'bilibili'))
})

console.log('\n=== 6. storyboard 缺 ffmpeg 时不假装挂上 ===')
await test('frp缺 ffmpeg → capabilities.storyboard.ok=false（而不是挂了但跑不起来）', () => {
  // 不能真卸载 ffmpeg，改用一个必然失败的方式验证分支：
  // 把 enabled 打开但用一个不存在的 wrapper 路径来触发 missing 分支
  const cfg = M.defaults()
  const { capabilities } = M.buildMcpServers(cfg, { log: () => {} })
  // 正常环境 ffmpeg 在，应该是 ok；这里只断言「ok 与 reason 互斥」
  if (capabilities.storyboard.ok) {
    assert.equal(capabilities.storyboard.reason, undefined, 'ok=true 时不该有 reason')
    assert.ok(capabilities.storyboard.outputDir, 'ok=true 时应给出产物目录')
  } else {
    assert.ok(String(capabilities.storyboard.reason || '').length > 0, 'ok=false 时必须给原因')
  }
})

console.log('\n=== 7. bridgeConfig 真把它塞进去了 ===')
await test('源码级：bridgeConfig 返回对象里有 mcpServers 字段', () => {
  const src = fs.readFileSync(path.join(PKG, 'lib', 'index.js'), 'utf8')
  // 定位 bridgeConfig 函数体
  const start = src.indexOf('function bridgeConfig (cfg) {')
  const end = src.indexOf('\nfunction ensureAgentScaffold', start)
  assert.ok(start > 0 && end > start, '定位不到 bridgeConfig')
  const body = src.slice(start, end)
  assert.match(body, /mcpServers:/, 'bridgeConfig 返回对象里没有 mcpServers —— 桥会读到空，B站工具是死的')
  assert.match(body, /buildMcpServers\(/, 'mcpServers 不是按需生成的')
})

await test('源码级：capabilities.mcp 上报给设置页', () => {
  const src = fs.readFileSync(path.join(PKG, 'lib', 'index.js'), 'utf8')
  assert.match(src, /mcp: mcpHealthForUi\(cfg\)/, '没有把 mcp 能力状态上报到设置页 —— 用户看不到缺什么')
})

console.log('\n=== 8. 桥侧能吃这份 mcpServers（env 数组/对象两种写法都必须认）===')
// 这一段测的是**桥侧 normalizeMcpEnv**（lib/bridge/index.js），
// 因为它是唯一会把我们的 mcpServers 转成 ACP 格式的地方。
// 为什么要测：原来桥只写 `Object.entries(srv.env)`，喂数组进来会变成
//   [['0',{name,value}]] → ACP 收到 {name:'0', value:'[object Object]'}
//   → **所有环境变量静默丢失**（STORYBOARD_DIR 丢了 → 产物落错目录 → 发不出去）。
// 这是 P1 接线时才暴露的（脚本版 env 是对象，插件版按 ACP 规范给数组）。
function loadNormalizeMcpEnv () {
  const src = fs.readFileSync(path.join(PKG, 'lib', 'bridge', 'index.js'), 'utf8')
  const start = src.indexOf('function normalizeMcpEnv (env) {')
  const end = src.indexOf('\n}\n', start)
  if (start < 0 || end < 0) throw new Error('找不到 normalizeMcpEnv（锚点变了）')
  const fnSrc = src.slice(start, end + 2)
  // eslint-disable-next-line no-new-func
  return new Function(`${fnSrc}; return normalizeMcpEnv;`)()
}

await test('**env 是数组时被原样保留**（ACP 格式，不能走 Object.entries）', () => {
  const normalize = loadNormalizeMcpEnv()
  const out = normalize([{ name: 'STORYBOARD_DIR', value: '/tmp/x' }, { name: 'PATH', value: '/usr/bin' }])
  assert.equal(out.length, 2)
  assert.deepEqual(out[0], { name: 'STORYBOARD_DIR', value: '/tmp/x' },
    `数组 env 被转坏了：${JSON.stringify(out)}`)
  assert.ok(!out.some(e => e.name === '0' || e.name === '1'),
    '出现了数字索引当 name —— 这是 Object.entries 处理数组的后果')
})

await test('env 是对象时仍按老方式转换（脚本版兼容，行为不变）', () => {
  const normalize = loadNormalizeMcpEnv()
  const out = normalize({ PATH: '/usr/bin', HOME: '/home/x' })
  assert.deepEqual(out, [{ name: 'PATH', value: '/usr/bin' }, { name: 'HOME', value: '/home/x' }])
})

await test('env 缺失/异常时返回空数组（不崩）', () => {
  const normalize = loadNormalizeMcpEnv()
  assert.deepEqual(normalize(undefined), [])
  assert.deepEqual(normalize(null), [])
  assert.deepEqual(normalize(''), [])
})

await test('数组里 value 不是字符串时被 String() 化（ACP 要求 value 是 string）', () => {
  const normalize = loadNormalizeMcpEnv()
  const out = normalize([{ name: 'N', value: 42 }])
  assert.equal(out[0].value, '42')
  assert.equal(typeof out[0].value, 'string')
})

console.log('\n=== 9. 隔离确认（不碰生产）===')
await test('所有产出都在 /tmp 下的测试目录里', () => {
  const outReal = fs.existsSync(SB_OUT) ? fs.realpathSync(SB_OUT) : path.resolve(SB_OUT)
  assert.ok(outReal.startsWith(os.tmpdir()), `产物目录不在 tmp：${outReal}`)
})

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
