// unit-store.test.mjs —— lib/store.js 的单测（表驱动 + 临时目录隔离）
//
// store.js 是插件唯一的「配置/凭据/状态」落盘层，踩过的坑都写在注释里：
//   · 配置文件坏掉必须回落默认值（不能让插件起不来），并且必须把坏文件备份一次
//     —— 否则设置页随手保存一次就把用户手改的配置永久抹掉
//   · 写入必须原子（先写 .tmp 再 rename），不能留半截 JSON
//   · 凭据单独文件；空串 = 删除，而不是设成空
//
// 所有落盘断言都只在 os.tmpdir() 下的临时 DSH_HOME 里做。
// ⚠️ dataDir() 会优先从「插件安装路径」反推 dshHome：如果哪天这个测试被装进
//   ~/.dsh/profiles/<p>/node_modules/ 下跑，反推会命中真实目录 —— 那种情况下
//   直接 skip 落盘断言，绝不在真实 ~/.dsh 里写测试数据。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-store-'))
const DSH_HOME = path.join(TMP, '.dsh')
process.env.DSH_HOME = DSH_HOME

const M = await import(pathToFileURL(path.join(PKG, 'lib', 'store.js')).href)
const DIR = M.dataDir()
const EXPECTED_DIR = path.join(DSH_HOME, 'dsh-plugin-llminqq')
const ISOLATED = DIR === EXPECTED_DIR
const skipDisk = ISOLATED
  ? false
  : `dataDir() 反推到了 ${DIR}（不是临时 DSH_HOME）—— 跳过落盘断言，避免写真实 ~/.dsh`

// 每条落盘用例前清空临时数据目录，用例之间互不影响
function resetDir () {
  fs.rmSync(DIR, { recursive: true, force: true })
  fs.mkdirSync(DIR, { recursive: true })
}
function writeConfigFile (obj) {
  fs.writeFileSync(M.CONFIG_FILE(), typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2), 'utf8')
}
function tmpLeftovers () {
  if (!fs.existsSync(DIR)) return []
  return fs.readdirSync(DIR).filter(n => n.includes('.tmp-'))
}
function corruptBackups () {
  if (!fs.existsSync(DIR)) return []
  return fs.readdirSync(DIR).filter(n => /^config\.json\.corrupt-\d+$/.test(n))
}

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }))

// ── deepMerge：纯函数，跟环境无关 ─────────────────────────────────────────
const mergeCases = [
  {
    name: '对象浅合并',
    base: { a: 1, b: 2 }, patch: { b: 3, c: 4 },
    want: { a: 1, b: 3, c: 4 },
  },
  {
    name: '嵌套对象递归合并（不丢没提到的键）',
    base: { a: { b: 1, c: 2 } }, patch: { a: { b: 9 } },
    want: { a: { b: 9, c: 2 } },
  },
  {
    name: '数组整体替换，不是拼接',
    base: { a: [1, 2, 3] }, patch: { a: [9] },
    want: { a: [9] },
  },
  {
    name: '顶层给数组 → 直接替换整个 base',
    base: { a: 1 }, patch: [1, 2],
    want: [1, 2],
  },
  {
    name: '顶层给基本类型 → 直接替换',
    base: { a: 1 }, patch: 'x',
    want: 'x',
  },
  {
    name: '嵌套 null → 显式清空成 null',
    base: { a: { b: 1 } }, patch: { a: null },
    want: { a: null },
  },
  {
    name: 'base 不是对象（null）→ 当成空对象再合并',
    base: null, patch: { x: 1 },
    want: { x: 1 },
  },
  {
    name: 'base 是数组 → 当成空对象再合并',
    base: [1, 2], patch: { y: 2 },
    want: { y: 2 },
  },
  {
    name: '空 patch → 等于浅拷贝',
    base: { a: 1 }, patch: {},
    want: { a: 1 },
  },
]

for (const c of mergeCases) {
  test(`deepMerge: ${c.name}`, () => {
    assert.deepEqual(M.deepMerge(c.base, c.patch), c.want)
  })
}

test('deepMerge: patch 为 undefined/null → 原样返回 base（顶层不是「清空」）', () => {
  const base = { a: 1, nested: { b: 2 } }
  assert.equal(M.deepMerge(base, undefined), base)
  assert.equal(M.deepMerge(base, null), base)
})

test('deepMerge: 不修改传入的 base / patch', () => {
  const base = { a: { b: 1 }, list: [1] }
  const patch = { a: { c: 2 }, list: [2] }
  const baseSnap = JSON.parse(JSON.stringify(base))
  const patchSnap = JSON.parse(JSON.stringify(patch))
  M.deepMerge(base, patch)
  assert.deepEqual(base, baseSnap, 'base 被改动了')
  assert.deepEqual(patch, patchSnap, 'patch 被改动了')
})

// ── defaults / 路径常量 ───────────────────────────────────────────────────
test('defaults: 关键默认值稳定（改默认值必须是有意识的行为）', () => {
  const d = M.defaults()
  assert.equal(d.enabled, false)
  assert.equal(d.dsh.provider, 'deepseek-account')
  assert.equal(d.dsh.model, 'deepseek-flash')
  assert.deepEqual(d.dsh.fallbackRoutes, [])
  assert.equal(d.advanced.rawJson, '')
  assert.ok(Array.isArray(d.media.sensitiveNames))
  assert.equal(typeof d.onebot.wsUrl, 'string')
})

// ── 入站文件（2026-11-03）：对方发来的文件要不要下载 ───────────────────────
//
// 为什么这组默认值要单独立一条测试：这 4 个键是「设置页 → config.media →
// bridgeConfig → 桥」这条链路的起点。起点写错（比如忘了加键、或者把 20MB 写成
// 20 字节），后面所有层都跟着错，而且**表现是静默的** —— 桥只会走自己的默认值，
// 用户看到的是「设置页改了不生效」，最难查。
test('defaults.media: 入站文件 4 项（开 / 20MB / 5 个 / 30s）', () => {
  const m = M.defaults().media
  assert.equal(m.inboundFileEnabled, true,
    '默认必须是开 —— 用户 2026-11-03 已明确同意「文件直接下载给模型读」')
  assert.equal(m.maxInboundFileBytes, 20 * 1024 * 1024, '单文件默认上限 20MB')
  assert.equal(m.maxInboundFiles, 5, '单条最多 5 个（防一次发 50 个拖垮桥）')
  assert.equal(m.inboundFileTimeoutMs, 30000, '默认超时 30s')
  // 和后端 clamp 区间一致性：默认值必须落在 lib/index.js INBOUND_FILE_LIMITS 里，
  // 否则「默认值自己会被 clamp 改掉」—— 改一个数字要同时想清楚两边。
  assert.ok(m.maxInboundFileBytes >= 1 * 1024 * 1024 && m.maxInboundFileBytes <= 100 * 1024 * 1024)
  assert.ok(m.maxInboundFiles >= 1 && m.maxInboundFiles <= 10)
  assert.ok(m.inboundFileTimeoutMs >= 5000 && m.inboundFileTimeoutMs <= 120000)
})

test('readConfig: 老配置（还没有入站文件键）→ 默认值补齐，不崩', { skip: skipDisk }, () => {
  resetDir()
  // 模拟升级前存下来的配置：media 段只有旧的三个键
  writeConfigFile({ media: { enabled: true, maxFileBytes: 1048576 } })
  const cfg = M.readConfig()
  assert.equal(cfg.media.inboundFileEnabled, true)
  assert.equal(cfg.media.maxInboundFileBytes, 20 * 1024 * 1024)
  assert.equal(cfg.media.maxInboundFiles, 5)
  assert.equal(cfg.media.inboundFileTimeoutMs, 30000)
  assert.equal(cfg.media.maxFileBytes, 1048576, '老键不能被新键挤掉')
})

test('saveConfig: 只改一个入站文件键时，同段其余键保留', { skip: skipDisk }, () => {
  resetDir()
  M.saveConfig({ media: { inboundFileEnabled: false } })
  M.saveConfig({ media: { maxInboundFiles: 2 } })
  const cfg = M.readConfig()
  assert.equal(cfg.media.inboundFileEnabled, false, '第二次保存把开关丢了')
  assert.equal(cfg.media.maxInboundFiles, 2)
  assert.equal(cfg.media.maxInboundFileBytes, 20 * 1024 * 1024, '没提到的同段键必须留在磁盘上')
  assert.equal(cfg.media.maxFileBytes, 10485760)
})

test('路径常量: 全部落在 dataDir() 下', { skip: skipDisk }, () => {
  resetDir()
  assert.equal(M.dataDir(), EXPECTED_DIR)
  assert.equal(M.CONFIG_FILE(), path.join(DIR, 'config.json'))
  assert.equal(M.SECRETS_FILE(), path.join(DIR, 'secrets.json'))
  assert.equal(M.STATE_FILE(), path.join(DIR, 'state.json'))
  assert.equal(M.QR_FILE(), path.join(DIR, 'qr.png'))
})

// ── readConfig ────────────────────────────────────────────────────────────
test('readConfig: 文件不存在 → 默认值，且没有 _loadError', { skip: skipDisk }, () => {
  resetDir()
  const cfg = M.readConfig()
  assert.deepEqual(cfg, M.defaults())
  assert.equal('_loadError' in cfg, false)
  assert.deepEqual(corruptBackups(), [], '文件不存在不该产生备份')
})

test('readConfig: 部分配置深合并进默认值（没写的键保留默认）', { skip: skipDisk }, () => {
  resetDir()
  writeConfigFile({ persona: { name: '小Q' }, dsh: { model: 'my-model' } })
  const cfg = M.readConfig()
  assert.equal(cfg.persona.name, '小Q')
  assert.equal(cfg.dsh.model, 'my-model')
  assert.equal(cfg.dsh.provider, 'deepseek-account', '没写的嵌套键必须保留默认值')
  assert.equal(cfg.enabled, false)
  assert.equal('_loadError' in cfg, false)
})

test('readConfig: 坏 JSON → 回落默认值 + _loadError + 只备份一次', { skip: skipDisk }, () => {
  resetDir()
  writeConfigFile('{ 这不是 JSON')
  const cfg = M.readConfig()
  assert.match(String(cfg._loadError), /不是合法 JSON/)
  assert.equal(cfg.enabled, false)
  assert.equal(cfg.dsh.provider, 'deepseek-account', '坏文件时必须是完整默认值')
  const backups = corruptBackups()
  assert.equal(backups.length, 1, `坏文件应备份一次，实际 ${JSON.stringify(backups)}`)
  assert.match(String(cfg._loadError), /原文件已备份到/, '没告诉用户备份位置')
  // 再读一次：同一个进程只备份一次，不能刷出一堆垃圾文件
  M.readConfig()
  assert.equal(corruptBackups().length, 1, '重复读取又备份了一份')
})

test('readConfig: advanced.rawJson 是合法 JSON → 深合并覆盖', { skip: skipDisk }, () => {
  resetDir()
  writeConfigFile({ advanced: { rawJson: JSON.stringify({ enabled: true, policy: { extra: 1 } }) } })
  const cfg = M.readConfig()
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.policy.extra, 1)
  assert.equal('_loadError' in cfg, false)
})

test('readConfig: advanced.rawJson 坏 JSON → 明确报错但其余配置照常返回', { skip: skipDisk }, () => {
  resetDir()
  writeConfigFile({ advanced: { rawJson: '{oops' }, persona: { name: '照常' } })
  const cfg = M.readConfig()
  assert.match(String(cfg._loadError), /advanced\.rawJson 不是合法 JSON/)
  assert.equal(cfg.persona.name, '照常', 'rawJson 坏了不该把整份配置丢掉')
})

// ── saveConfig：原子写 + 合并语义 ─────────────────────────────────────────
test('saveConfig: 写入后可读回，且不留 .tmp 临时文件', { skip: skipDisk }, () => {
  resetDir()
  const next = M.saveConfig({ persona: { name: '张三' } })
  assert.equal(next.persona.name, '张三')
  const onDisk = JSON.parse(fs.readFileSync(M.CONFIG_FILE(), 'utf8'))
  assert.equal(onDisk.persona.name, '张三')
  assert.deepEqual(tmpLeftovers(), [], `残留临时文件：${tmpLeftovers()}`)
  assert.deepEqual(M.readConfig(), next)
})

test('saveConfig: 只传一段时保留其余已存配置', { skip: skipDisk }, () => {
  resetDir()
  M.saveConfig({ dsh: { model: 'm1' } })
  M.saveConfig({ dsh: { reasoningEffort: 'low' } })
  const cfg = M.readConfig()
  assert.equal(cfg.dsh.model, 'm1', '第二次保存把第一次的键丢了')
  assert.equal(cfg.dsh.reasoningEffort, 'low')
  assert.equal(cfg.dsh.provider, 'deepseek-account')
})

test('saveConfig: 能覆盖掉坏配置（坏文件不阻塞保存）', { skip: skipDisk }, () => {
  resetDir()
  writeConfigFile('{ 坏')
  M.readConfig() // 触发一次备份（模块级只备份一次）
  const next = M.saveConfig({ enabled: true })
  assert.equal(next.enabled, true)
  assert.equal(M.readConfig().enabled, true)
  assert.equal(JSON.parse(fs.readFileSync(M.CONFIG_FILE(), 'utf8')).enabled, true)
})

// ── 凭据 ──────────────────────────────────────────────────────────────────
test('secrets: 读写 / 空串=删除 / 文件优先于环境变量', { skip: skipDisk }, () => {
  resetDir()
  assert.deepEqual(M.readSecrets(), {}, '没有文件时应返回空对象')

  M.writeSecrets({ qq: 12345, token: 'abc' })
  assert.deepEqual(M.readSecrets(), { qq: 12345, token: 'abc' })
  assert.equal(M.getSecret('token'), 'abc')
  assert.equal(M.getSecret('qq'), 12345)

  process.env.LLMINQQ_TEST_SECRET = 'from-env'
  assert.equal(M.getSecret('missing', 'LLMINQQ_TEST_SECRET'), 'from-env', '环境变量兜底失效')
  assert.equal(M.getSecret('token', 'LLMINQQ_TEST_SECRET'), 'abc', '文件应优先于环境变量')
  assert.equal(M.getSecret('missing'), '', '取不到凭据应返回空串而不是 undefined')

  M.writeSecrets({ qq: '' })
  assert.equal('qq' in M.readSecrets(), false, '空串必须删除键，而不是设成空')
  M.writeSecrets({ token: null })
  assert.equal('token' in M.readSecrets(), false, 'null 必须删除键')
  delete process.env.LLMINQQ_TEST_SECRET
})

test('secrets: 坏文件 → 空对象（不抛错），之后写入可恢复', { skip: skipDisk }, () => {
  resetDir()
  fs.writeFileSync(M.SECRETS_FILE(), '{bad', 'utf8')
  assert.deepEqual(M.readSecrets(), {})
  M.writeSecrets({ token: 'new' })
  assert.equal(M.getSecret('token'), 'new')
})

// ── 运行时状态 ────────────────────────────────────────────────────────────
test('state: 写状态自动合并 + 带 updatedAt 时间戳', { skip: skipDisk }, () => {
  resetDir()
  assert.deepEqual(M.readState(), {}, '没有 state 文件时应返回空对象')
  const first = M.writeState({ bridge: 'up' })
  assert.equal(first.bridge, 'up')
  assert.equal(typeof first.updatedAt, 'number')
  const second = M.writeState({ connected: true })
  assert.equal(second.bridge, 'up', '第二次写状态把第一次的键丢了')
  assert.equal(second.connected, true)
  assert.deepEqual(M.readState().connected, true)
})

test('state: 坏文件 → 空对象（不抛错）', { skip: skipDisk }, () => {
  resetDir()
  fs.writeFileSync(M.STATE_FILE(), '{{{', 'utf8')
  assert.deepEqual(M.readState(), {})
})

// ── resetConfig / randomToken ─────────────────────────────────────────────
test('resetConfig: 写回默认值（凭据不受影响）', { skip: skipDisk }, () => {
  resetDir()
  M.saveConfig({ enabled: true, persona: { name: '被重置' } })
  M.writeSecrets({ token: 'keep-me' })
  const fresh = M.resetConfig()
  assert.deepEqual(fresh, M.defaults())
  assert.equal(M.readConfig().persona.name, undefined, 'reset 没生效')
  assert.equal(M.getSecret('token'), 'keep-me', '重置配置不该清凭据')
})

test('randomToken: 十六进制、长度 = 2*bytes、两次不重复', () => {
  assert.match(M.randomToken(), /^[0-9a-f]{32}$/)
  assert.match(M.randomToken(8), /^[0-9a-f]{16}$/)
  assert.notEqual(M.randomToken(16), M.randomToken(16))
})

// ── 出站分条（task-24）：默认值 + 老配置补齐 ────────────────────────────────
//
// 为什么默认值是 30 / 5：桥侧的老代码写死 `splitChars ?? 30`、
// `splitMaxParts ?? 3`，而用户 2026-11-05 定稿「每轮最多 5 条」。
// 插件侧不给默认值的话，设置页读到 undefined、bridgeConfig 也透传不了 ——
// 用户改了也不生效（假配置）。这条锁住「新用户/老配置都拿到 30/5」。
test('defaults.affection: 分条默认 30 / 5（用户 2026-11-05 定稿）', () => {
  const a = M.defaults().affection
  assert.ok(a, 'defaults 里没有 affection 段 —— bridgeConfig 也就没法透传')
  assert.equal(a.splitChars, 30, '单段阈值默认 30 字')
  assert.equal(a.splitMaxParts, 5, '每轮最多 5 条（用户定稿；桥侧写死的旧默认是 3）')
})

test('readConfig: 老配置（没有 affection 段）→ 默认值补齐', { skip: skipDisk }, () => {
  resetDir()
  writeConfigFile({ policy: { maxReplyChars: 800 } })
  const cfg = M.readConfig()
  assert.equal(cfg.affection.splitChars, 30)
  assert.equal(cfg.affection.splitMaxParts, 5)
  assert.equal(cfg.policy.maxReplyChars, 800, '老键不能被新段挤掉')
})

test('saveConfig: 只改一个分条键时同段另一个键保留', { skip: skipDisk }, () => {
  resetDir()
  M.saveConfig({ affection: { splitChars: 40 } })
  M.saveConfig({ affection: { splitMaxParts: 4 } })
  const cfg = M.readConfig()
  assert.equal(cfg.affection.splitChars, 40, '第二次保存把第一次的键丢了')
  assert.equal(cfg.affection.splitMaxParts, 4)
})

// ── 好感度参数（2026-11-06 task-1 / P1-2）：设置页必须能改桥的关系参数 ────────
//
// 背景：桥侧 lib/bridge/state.js 的 AFFECTION_DEFAULTS 把 enabled/start/
// modelScoring/... 全写死，而插件侧 bridgeConfig 的 affection 段以前只有
// splitChars/splitMaxParts（那是分条，不是关系）→ 用户在设置页根本没有入口。
// 这一段锁住「store 默认值和桥对齐」这一环；bridgeConfig 的行为断言在
// test/unit-affection-config.test.mjs（那个文件能 import lib/index.js）。
//
// 为什么默认值要写成字面量：和 state.js 的 AFFECTION_DEFAULTS 对齐是**约定**，
// 谁悄悄改一处就应该有一条测试失败，而不是两边自动漂移。
test('defaults.affection: 好感度参数默认值和桥的 AFFECTION_DEFAULTS 对齐', () => {
  const a = M.defaults().affection
  assert.ok(a, 'defaults 里没有 affection 段')
  assert.equal(a.enabled, true, '好感度默认开（桥侧 AFFECTION_DEFAULTS.enabled=true）')
  assert.equal(a.start, 30, '起始 30（桥侧 start=30）')
  assert.equal(a.modelScoring, true, '模型自评通道默认开（桥侧 modelScoring=true）')
  assert.equal(a.modelMaxPerRound, 2, '单轮上限 2（桥侧 modelMaxPerRound=2）')
  assert.equal(a.dailyGainCap, 10, '日涨分上限 10（桥侧 dailyGainCap=10）')
  assert.equal(a.decayFloor, 20, '衰减地板 20（桥侧 decayFloor=20）')
  assert.deepEqual({ ...a.tiers }, { l1: 25, l2: 50, l3: 70, l4: 85, hate: 10 },
    '档位分界线必须和桥一致（不一致 = 设置页显示的分档和桥真的分档不同）')
})

test('defaults.split: 分条的正式段默认 30 / 5（和 affection 里的历史键一致）', () => {
  const s = M.defaults().split
  assert.ok(s, 'defaults 里没有 split 段 —— bridgeConfig 就没法产出新段')
  assert.equal(s.splitChars, 30)
  assert.equal(s.splitMaxParts, 5)
  // 两处默认值必须一致：设置页「分条」卡还写 affection.*，而桥侧会读 split.*。
  // 不一致的直接后果是「设置页显示 30、桥拿到 45」这种最难查的假配置。
  const a = M.defaults().affection
  assert.equal(s.splitChars, a.splitChars, 'split 和 affection 的 splitChars 默认值不一致')
  assert.equal(s.splitMaxParts, a.splitMaxParts, 'split 和 affection 的 splitMaxParts 默认值不一致')
})

test('readConfig: 老配置（没有 affection 新参数 / 没有 split 段）→ 默认值补齐', { skip: skipDisk }, () => {
  resetDir()
  // 模拟升级前存下来的配置：affection 段只有分条那两个历史键
  writeConfigFile({ affection: { splitChars: 45, splitMaxParts: 4 } })
  const cfg = M.readConfig()
  // 用户改过的老键不能被默认值盖掉
  assert.equal(cfg.affection.splitChars, 45, '老配置里用户改过的 splitChars 被默认值覆盖了')
  assert.equal(cfg.affection.splitMaxParts, 4)
  // 新键必须补齐（否则设置页显示空白、bridgeConfig 透传 undefined）
  assert.equal(cfg.affection.enabled, true)
  assert.equal(cfg.affection.start, 30)
  assert.equal(cfg.affection.modelScoring, true)
  assert.equal(cfg.affection.modelMaxPerRound, 2)
  assert.equal(cfg.affection.dailyGainCap, 10)
  assert.equal(cfg.affection.decayFloor, 20)
  assert.deepEqual({ ...cfg.affection.tiers }, { l1: 25, l2: 50, l3: 70, l4: 85, hate: 10 })
  // split 段也要补齐（新段对老配置同样是默认值）
  assert.equal(cfg.split.splitChars, 30)
  assert.equal(cfg.split.splitMaxParts, 5)
})

test('saveConfig: 只改一个好感度键时，同段其它键（含分条历史键、tiers）都保留', { skip: skipDisk }, () => {
  resetDir()
  M.saveConfig({ affection: { start: 50 } })
  M.saveConfig({ affection: { tiers: { l1: 30 } } })
  M.saveConfig({ affection: { modelScoring: false } })
  const cfg = M.readConfig()
  assert.equal(cfg.affection.start, 50, '第二次保存把 start 丢了')
  assert.equal(cfg.affection.modelScoring, false)
  // tiers 深合并：只改了 l1，其余档位边界必须留着（丢了桥会按默认分档）
  assert.deepEqual({ ...cfg.affection.tiers }, { l1: 30, l2: 50, l3: 70, l4: 85, hate: 10 },
    'tiers 没做深合并 —— 只改一个档位会把其它档位冲掉')
  // 分条的历史键和 split 段不能被「保存好感度参数」顺手抹掉
  assert.equal(cfg.affection.splitChars, 30)
  assert.equal(cfg.affection.splitMaxParts, 5)
  assert.equal(cfg.split.splitChars, 30)
  assert.equal(cfg.split.splitMaxParts, 5)
})

// ── bridgeConfig 的行为断言（2026-11-06 task-1 / P1-2）──────────────────────
//
// 为什么必须是**行为**断言而不是源码正则：v5 摊平那次事故（memory.v5 写成
// `...memoryV5Config(cfg.memory)` 摊平到 memory 顶层）源码断言是绿的 ——
// 正则只证明「这行代码写了」，不证明「产出的结构对」。所以这里真的调一次
// bridgeConfig()，用 Array/对象取值验结果。
//
// 隔离：这个文件顶部已经把 DSH_HOME 引到 os.tmpdir()，且 dataDir() 从安装路径
// 反推不出来时才会用 DSH_HOME —— 所以这里的 bridgeConfig() 只读不写，绝不会
// 碰真实 ~/.dsh。它内部会跑一次 pythonProbe（约 100-200ms，缓存后不再跑），
// 对单测是可接受的成本。
const IDX = await import(pathToFileURL(path.join(PKG, 'lib', 'index.js')).href)

/** 取 bridgeConfig 产出的对象（没传 config 时用一份最小配置）。 */
function bcOf (cfg = {}) {
  return IDX.bridgeConfig({
    onebot: {}, dsh: {}, policy: {}, media: {}, server: {}, log: {},
    persona: {}, memory: {}, features: {}, tts: {}, style: {}, learning: {},
    ...cfg,
  })
}

test('bridgeConfig: affection 段真的是行为透传（start/开关/模型自评）', () => {
  const bc = bcOf({ affection: { start: 50 } })
  assert.equal(bc.affection.start, 50, '设置页把 start 改到 50，桥却拿不到 —— 又是假配置')
  assert.equal(bc.affection.enabled, true, '老配置没有 enabled → 默认开')
  assert.equal(bc.affection.modelScoring, true)
  assert.equal(bc.affection.modelMaxPerRound, 2)
  assert.equal(bc.affection.dailyGainCap, 10)
  assert.equal(bc.affection.decayFloor, 20)
  assert.deepEqual({ ...bc.affection.tiers }, { l1: 25, l2: 50, l3: 70, l4: 85, hate: 10 },
    '档位分界线没透传 —— 桥会按自己的默认分档，设置页改的档位不生效')

  const off = bcOf({ affection: { enabled: false, modelScoring: false } })
  assert.equal(off.affection.enabled, false, '显式关掉好感度，桥必须看到 false')
  assert.equal(off.affection.modelScoring, false)
})

test('bridgeConfig: affection 段仍带分条键（桥侧旧读取路径不破）', () => {
  const bc = bcOf({ affection: { splitChars: 45, splitMaxParts: 3 } })
  // 桥侧 lib/bridge/index.js 的 splitForSend 至今读 config.affection.splitChars，
  // 所以哪怕 split 新段已经有了，affection 里这两个键也必须继续存在。
  assert.equal(bc.affection.splitChars, 45, 'affection 段丢了 splitChars —— 桥的分条读取会回落到硬编码 30')
  assert.equal(bc.affection.splitMaxParts, 3, 'affection 段丢了 splitMaxParts')
})

test('bridgeConfig: split 新段存在且与 affection 里的历史键一致（双写期）', () => {
  const bc = bcOf({ affection: { splitChars: 45, splitMaxParts: 3 } })
  assert.equal(bc.split.splitChars, 45, 'split 新段没透传 —— 桥侧迁移后拿不到分条参数')
  assert.equal(bc.split.splitMaxParts, 3)
  assert.notEqual(bc.split, bc.affection, 'split 段不该和 affection 是同一个对象（否则合并会互踩）')

  // 默认配置：新段 30/5，且和 affection 里的历史键**同值**（双写期必须一致）
  const d = bcOf()
  assert.equal(d.split.splitChars, 30)
  assert.equal(d.split.splitMaxParts, 5)
  assert.equal(d.affection.splitChars, d.split.splitChars)
  assert.equal(d.affection.splitMaxParts, d.split.splitMaxParts)
})

test('bridgeConfig: 用户改用 config.split 段时，新段优先（分条迁移的读取规则）', () => {
  // 用户开始用新入口：split=45，affection 仍是默认 30 → 必须取 45
  const bc = bcOf({ split: { splitChars: 45 } })
  assert.equal(bc.split.splitChars, 45)
  assert.equal(bc.affection.splitChars, 45, '新段 45 时旧路径也要跟上（双写期桥两边都可能读）')

  // 反过来：用户改的是老入口（affection=45），split 是默认 30 → 必须取 45，
  // 不能被 split 里那份默认值盖掉（这正是「设置页改了不生效」的经典形态）。
  const bc2 = bcOf({ affection: { splitChars: 45 } })
  assert.equal(bc2.split.splitChars, 45, 'affection 改到 45 被 split 的默认 30 盖掉了 —— 设置页假配置')
})

test('bridgeConfig: 好感度参数越界/非法值被夹回区间（手改 config.json 也拦得住）', () => {
  const bc = bcOf({
    affection: {
      start: 999, modelMaxPerRound: 99, dailyGainCap: 999, decayFloor: -5,
      tiers: { l1: 130, l2: 'abc' },
    },
  })
  assert.equal(bc.affection.start, 80, 'start 上限 80 没夹住')
  assert.equal(bc.affection.modelMaxPerRound, 5, 'modelMaxPerRound 上限 5 没夹住')
  assert.equal(bc.affection.dailyGainCap, 30, 'dailyGainCap 上限 30 没夹住')
  assert.equal(bc.affection.decayFloor, 0, 'decayFloor 的合法下界是 0（不能把 0 当非法值回落成 20）')
  assert.equal(bc.affection.tiers.l1, 100, 'tiers 没夹到 0..100')
  assert.equal(bc.affection.tiers.l2, 50, 'tiers 非数字应回落默认值')
})

test('bridgeConfig: modelMaxPerRound 保留 0.5 步进（不能四舍五入成整数）', () => {
  const bc = bcOf({ affection: { modelMaxPerRound: 1.5 } })
  assert.equal(bc.affection.modelMaxPerRound, 1.5, '0.5 步进被抹成整数了 —— 用户选 1.5 会变成 2')
  const bc2 = bcOf({ affection: { modelMaxPerRound: 1.3 } })
  assert.equal(bc2.affection.modelMaxPerRound, 1.5, '非 0.5 整数倍应归到最近的 0.5 档')
})
