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
