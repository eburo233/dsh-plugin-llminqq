// test/unit-config.test.mjs —— 配置的默认值与边界
//
// ① policy.cooldownMsPerPeer 的默认值与边界
//
// 背景：默认 0 = 私聊/@ 零限流。LLM 一轮几百毫秒到几秒，同一会话连发两条
// 消息就会各起一轮 LLM，回复叠着发出去 —— 用户看到的是「机器人抢话/连发」。
// 现在默认 1500ms（同一会话最小回复间隔），0 仍然合法（显式关闭限流）。
//
// 同时保证：手改 config.json / .env 占位符展开成字符串 / 负数 / 超大值时
// 不会把桥拦在启动前，而是归一化（非法 → 默认，负数 → 0，超大 → 上限）。
//
// ② 入站文件下载的 4 个参数（task-9）
//
// 背景：桥侧（lib/bridge/messaging.js）早就实现了「把对方发来的文件真的下载到
// 暂存区给模型读」，读的是 config.media.inboundFileEnabled / maxInboundFileBytes /
// maxInboundFiles / inboundFileTimeoutMs —— 但插件侧 bridgeConfig() 一直没把这 4 个
// 键透传过去。于是设置页怎么改都不生效，桥永远走自己的默认值：**假配置**。
// 这一段锁住「透传 + 非法值回落」，防止下次重构又把白名单漏掉。
//
// ⚠️ 这里跟 ① 不是一个模块：① 测的是 lib/bridge/config.js（桥自己的读配置），
// ② 测的是 lib/index.js（插件生成给桥的那份 config）。bridgeConfig 没导出
// （它要 dataDir/凭据/pythonProbe，调用成本高），所以 ② 分两层：
//    · inboundFileMedia() 是真函数 → 直接调，验 clamp 行为；
//    · bridgeConfig 里那句 spread → 源码断言（照 unit-log-runaway / plugin-mcp 的写法）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const CFG = await import(pathToFileURL(path.join(ROOT, 'lib', 'bridge', 'config.js')).href)
const {
  normalizePolicy, loadConfig,
  DEFAULT_COOLDOWN_MS_PER_PEER, MAX_COOLDOWN_MS_PER_PEER,
} = CFG

const cooldownOf = policy => normalizePolicy({ policy }).policy.cooldownMsPerPeer

test('默认 cooldownMsPerPeer = 1500（0 = 显式关闭限流，仍合法）', () => {
  assert.equal(DEFAULT_COOLDOWN_MS_PER_PEER, 1500)
  assert.equal(normalizePolicy({}).policy.cooldownMsPerPeer, 1500)
  assert.equal(cooldownOf({ cooldownMsPerPeer: 0 }), 0)
  assert.equal(cooldownOf({ cooldownMsPerPeer: '0' }), 0)
})

test('字符串数字被归一化成 number', () => {
  assert.equal(cooldownOf({ cooldownMsPerPeer: '2500' }), 2500)
  assert.equal(cooldownOf({ cooldownMsPerPeer: ' 2500 ' }), 2500)
})

test('负数 → 0（非负保证）', () => {
  assert.equal(cooldownOf({ cooldownMsPerPeer: -5 }), 0)
  assert.equal(cooldownOf({ cooldownMsPerPeer: '-5000' }), 0)
})

test('非法值回落默认（不会抛错把桥拦在启动前）', () => {
  assert.equal(cooldownOf({ cooldownMsPerPeer: 'abc' }), 1500)
  assert.equal(cooldownOf({ cooldownMsPerPeer: '' }), 1500)
  assert.equal(cooldownOf({ cooldownMsPerPeer: null }), 1500)
  assert.equal(cooldownOf({ cooldownMsPerPeer: NaN }), 1500)
  assert.equal(cooldownOf({ cooldownMsPerPeer: Infinity }), 1500)
})

test('超大值截到上限 60000', () => {
  assert.equal(MAX_COOLDOWN_MS_PER_PEER, 60000)
  assert.equal(cooldownOf({ cooldownMsPerPeer: 999999 }), 60000)
  assert.equal(cooldownOf({ cooldownMsPerPeer: '1000000' }), 60000)
})

test('小数四舍五入到整数 ms', () => {
  assert.equal(cooldownOf({ cooldownMsPerPeer: 1500.4 }), 1500)
  assert.equal(cooldownOf({ cooldownMsPerPeer: 1500.6 }), 1501)
})

test('其它 policy 键原样保留', () => {
  const c = normalizePolicy({ policy: { cooldownMsPerPeer: '2000', maxReplyChars: 800, allowC2C: false } })
  assert.equal(c.policy.maxReplyChars, 800)
  assert.equal(c.policy.allowC2C, false)
})

test('loadConfig 全链路：缺省补 1500、占位符字符串归一化', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llminqq-cfg-'))
  try {
    fs.mkdirSync(path.join(dir, 'bridge'), { recursive: true })
    const file = path.join(dir, 'bridge', 'config.json')

    // ① 完全缺省 → 默认 1500
    fs.writeFileSync(file, '{}')
    const a = loadConfig({ root: dir, env: {}, warn: () => {} })
    assert.equal(a.config.policy.cooldownMsPerPeer, 1500)

    // ② .env / 占位符展开后是字符串，也要变成 number
    fs.writeFileSync(file, JSON.stringify({ policy: { cooldownMsPerPeer: '${COOL_MS}' } }))
    const b = loadConfig({ root: dir, env: { COOL_MS: '2500' }, warn: () => {} })
    assert.equal(b.config.policy.cooldownMsPerPeer, 2500)
    assert.equal(typeof b.config.policy.cooldownMsPerPeer, 'number')

    // ③ 非法占位符值 → 回落默认，不抛错
    const c = loadConfig({ root: dir, env: { COOL_MS: 'abc' }, warn: () => {} })
    assert.equal(c.config.policy.cooldownMsPerPeer, 1500)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ═══════════════════════════════════════════════════════════════════════════
// ② 入站文件下载：插件侧必须把 4 个参数真的透传给桥
// ═══════════════════════════════════════════════════════════════════════════

// import 整个插件模块会连带加载 store/models/napcat 等一串子模块。这里只用到
// 纯函数（inboundFileMedia / defaults），但按 CONTRIBUTING §9 仍把 HOME / DSH_HOME
// 引到临时目录再 import —— 保证这个测试在任何机器上都不会碰真实 ~/.dsh。
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'llminqq-inbound-cfg-'))
process.env.HOME = TMP_HOME
process.env.USERPROFILE = TMP_HOME      // Windows 的 os.homedir() 看这个
process.env.DSH_HOME = path.join(TMP_HOME, '.dsh')

const IDX = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)
const STORE = await import(pathToFileURL(path.join(ROOT, 'lib', 'store.js')).href)
test.after(() => fs.rmSync(TMP_HOME, { recursive: true, force: true }))

// 一份和 lib/store.js defaults 对齐的期望值。故意写成字面量而不是读 defaults()：
// 如果哪天有人悄悄改默认值，这条断言应该**失败**，而不是自动跟着变。
const INBOUND_DEFAULTS = {
  inboundFileEnabled: true,
  maxInboundFileBytes: 20 * 1024 * 1024,
  maxInboundFiles: 5,
  inboundFileTimeoutMs: 30000,
}

test('inboundFileMedia: 缺省（老配置没有这些键）→ 默认值', () => {
  assert.deepEqual(IDX.inboundFileMedia(undefined), INBOUND_DEFAULTS)
  assert.deepEqual(IDX.inboundFileMedia({}), INBOUND_DEFAULTS)
  assert.deepEqual(IDX.inboundFileMedia(null), INBOUND_DEFAULTS)
})

test('inboundFileMedia: 合法值原样透传（「设置页改了能到桥」就靠这条）', () => {
  assert.deepEqual(
    IDX.inboundFileMedia({
      inboundFileEnabled: false,
      maxInboundFileBytes: 5 * 1024 * 1024,
      maxInboundFiles: 3,
      inboundFileTimeoutMs: 10000,
    }),
    {
      inboundFileEnabled: false,
      maxInboundFileBytes: 5 * 1024 * 1024,
      maxInboundFiles: 3,
      inboundFileTimeoutMs: 10000,
    })
  // 其它 media 键不该被这个函数吃掉/改写（它只负责这 4 个）
  const only = IDX.inboundFileMedia({ enabled: false, stagingDir: '/x', maxFileBytes: 1 })
  assert.deepEqual(Object.keys(only).sort(), Object.keys(INBOUND_DEFAULTS).sort())
})

test('inboundFileMedia: 字符串数字也认（.env 展开 / 手改 JSON 常见）', () => {
  const r = IDX.inboundFileMedia({
    maxInboundFileBytes: '10485760',
    maxInboundFiles: '2',
    inboundFileTimeoutMs: ' 5000 ',
  })
  assert.equal(r.maxInboundFileBytes, 10485760)
  assert.equal(r.maxInboundFiles, 2)
  assert.equal(r.inboundFileTimeoutMs, 5000)
  assert.equal(typeof r.maxInboundFileBytes, 'number', '透传出去的必须是 number（桥拿去比大小）')
})

test('inboundFileMedia: 非法值回落默认（负数 / 0 / 非数字 / NaN / Infinity）', () => {
  const bads = [-1, 0, '-5', 'abc', '', null, NaN, Infinity, -Infinity, {}, []]
  for (const bad of bads) {
    const r = IDX.inboundFileMedia({
      maxInboundFileBytes: bad, maxInboundFiles: bad, inboundFileTimeoutMs: bad,
    })
    assert.deepEqual(r, INBOUND_DEFAULTS, `非法值 ${String(bad)} 没有回落默认`)
  }
})

test('inboundFileMedia: 越界值夹到边界（不是回落默认 —— 用户意图要保留）', () => {
  const hi = IDX.inboundFileMedia({
    maxInboundFileBytes: 500 * 1024 * 1024,
    maxInboundFiles: 99,
    inboundFileTimeoutMs: 999999,
  })
  assert.equal(hi.maxInboundFileBytes, 100 * 1024 * 1024, '单文件上限必须夹到 100MB')
  assert.equal(hi.maxInboundFiles, 10, '单条条数必须夹到 10')
  assert.equal(hi.inboundFileTimeoutMs, 120000, '超时必须夹到 120s')

  const lo = IDX.inboundFileMedia({
    maxInboundFileBytes: 1,          // 1 字节 → 下限 1MB
    maxInboundFiles: 0.1,            // 小于 1 → 1
    inboundFileTimeoutMs: 100,       // 100ms → 下限 5s
  })
  assert.equal(lo.maxInboundFileBytes, 1 * 1024 * 1024)
  assert.equal(lo.maxInboundFiles, 1)
  assert.equal(lo.inboundFileTimeoutMs, 5000)
})

test('inboundFileMedia: 只有显式 false 才算关（和桥的 !== false 同一条规则）', () => {
  assert.equal(IDX.inboundFileMedia({ inboundFileEnabled: true }).inboundFileEnabled, true)
  assert.equal(IDX.inboundFileMedia({ inboundFileEnabled: false }).inboundFileEnabled, false)
  // 下面这些在桥那边都是「开」（桥写的是 media.inboundFileEnabled !== false），
  // 插件侧必须一致，否则会出现「设置页显示关、桥还在下载」这种假配置
  for (const v of ['false', 0, null, undefined, '']) {
    assert.equal(IDX.inboundFileMedia({ inboundFileEnabled: v }).inboundFileEnabled, true,
      `inboundFileEnabled=${JSON.stringify(v)} 应该按「开」处理`)
  }
})

test('INBOUND_FILE_LIMITS 区间和设置页输入框一致（1–100MB / 1–10 / 5–120s）', () => {
  const L = IDX.INBOUND_FILE_LIMITS
  assert.deepEqual({ ...L.maxBytes }, { min: 1 * 1024 * 1024, max: 100 * 1024 * 1024, def: 20 * 1024 * 1024 })
  assert.deepEqual({ ...L.maxFiles }, { min: 1, max: 10, def: 5 })
  assert.deepEqual({ ...L.timeoutMs }, { min: 5000, max: 120000, def: 30000 })
})

test('漂移守卫：store 默认值喂进 clamp 后必须一字不变', () => {
  // 两个文件各存一份「默认值」（store 是配置 schema，index 是 clamp 的 def）。
  // 只改一边就会出现「新用户默认 20MB、clamp 却按 30MB 兜底」这类鬼故事。
  const m = STORE.defaults().media
  assert.deepEqual(IDX.inboundFileMedia(m), {
    inboundFileEnabled: m.inboundFileEnabled,
    maxInboundFileBytes: m.maxInboundFileBytes,
    maxInboundFiles: m.maxInboundFiles,
    inboundFileTimeoutMs: m.inboundFileTimeoutMs,
  })
  assert.deepEqual(IDX.inboundFileMedia(m), INBOUND_DEFAULTS,
    'store.js 的默认值和这里的期望值不一致 —— 要么改默认值，要么改这条断言（别只改一处）')
})

test('源码级：bridgeConfig 的 media 段确实 spread 了 inboundFileMedia(cfg.media)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'index.js'), 'utf8')
  const start = src.indexOf('function bridgeConfig (cfg) {')
  assert.ok(start > 0, '定位不到 bridgeConfig')
  // 只取 media 那一块：从函数体里的 `media: {` 往后 1200 字符
  const mediaAt = src.indexOf('media: {', start)
  assert.ok(mediaAt > start, 'bridgeConfig 里找不到 media 段')
  const block = src.slice(mediaAt, mediaAt + 1200)
  assert.match(block, /\.\.\.inboundFileMedia\(cfg\.media\)/,
    'bridgeConfig 的 media 段没有透传入站文件 4 项 —— 桥会收到 undefined，设置页又变成假配置')
})

// ── 记忆 v5 双写开关的透传（Step 1）────────────────────────────────────────
// 桥侧 Step 1 只写 mem-v5.db（读路径仍是 v4），但开关必须能从插件配置到桥：
// 之前的 inboundFile 4 个键就是这样「桥有默认值、插件不透传 → 设置页假配置」。
test('源码级：bridgeConfig 的 memory 段透传了 v5.enabled（不是只有桥侧默认值）', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'index.js'), 'utf8')
  const start = src.indexOf('function bridgeConfig (cfg) {')
  assert.ok(start > 0, '定位不到 bridgeConfig')
  const memAt = src.indexOf('memory: (() => {', start)
  assert.ok(memAt > start, 'bridgeConfig 里找不到 memory 段')
  const seg = src.slice(memAt, memAt + 3000)
  // task-18 起 v5 段抽成了 memoryV5Config()（多出 engine/distill，单测直接验纯函数），
  // 所以这里断言「bridgeConfig 确实 spread 了它」+「helper 里保留默认语义」。
  assert.match(seg, /\.\.\.memoryV5Config\(cfg\.memory\)/, 'memory 段没透传 v5 —— 桥只能吃默认值，设置页关不掉')
  const helperAt = src.indexOf('function memoryV5Config')
  assert.ok(helperAt > 0, 'memoryV5Config helper 不见了')
  const helperSeg = src.slice(helperAt, helperAt + 2000)
  assert.match(helperSeg, /enabled: v5\.enabled !== false/, 'v5.enabled 的默认语义必须是「只有显式 false 才关」')
})

test('store 默认值：memory.v5.enabled 默认 true', async () => {
  const { defaults } = await import(pathToFileURL(path.join(ROOT, 'lib', 'store.js')).href)
  const d = defaults()
  assert.equal(d.memory?.v5?.enabled, true, '记忆 v5 双写默认应开启（只写不读，零风险）')
})
