// test/unit-config.test.mjs —— policy.cooldownMsPerPeer 的默认值与边界
//
// 背景：默认 0 = 私聊/@ 零限流。LLM 一轮几百毫秒到几秒，同一会话连发两条
// 消息就会各起一轮 LLM，回复叠着发出去 —— 用户看到的是「机器人抢话/连发」。
// 现在默认 1500ms（同一会话最小回复间隔），0 仍然合法（显式关闭限流）。
//
// 同时保证：手改 config.json / .env 占位符展开成字符串 / 负数 / 超大值时
// 不会把桥拦在启动前，而是归一化（非法 → 默认，负数 → 0，超大 → 上限）。

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
