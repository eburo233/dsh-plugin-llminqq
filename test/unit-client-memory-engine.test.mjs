// test/unit-client-memory-engine.test.mjs —— 设置页「记忆引擎」选择卡（v4/v5）
//
// 为什么需要：切引擎是记忆系统换心脏，但默认必须是 v4（v5 需要先跑历史迁移）。
// 这个卡片是用户唯一能看到/切换引擎的地方；配置链路（store 默认值 → bridgeConfig
// 的 memoryV5Config → 桥）任何一环断了都会变成「设置页能点、实际没变」的假配置。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SRC = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8')

test('设置页有 EngineCard，且挂在「记忆」页里', () => {
  assert.match(SRC, /function EngineCard \(/, '没有 EngineCard 组件')
  const memTab = SRC.indexOf('function MemoryTab (')
  const card = SRC.indexOf('h(EngineCard, {')
  assert.ok(memTab > 0 && card > memTab, 'EngineCard 不在 MemoryTab 里')
  assert.match(SRC, /tab === 'memory' && h\(MemoryTab, \{[^}]*saveConfig[^}]*\}\)/,
    'MemoryTab 没拿到 saveConfig —— 切引擎保存不了')
})

test('切换走 saveConfig({ memory: { v5: { engine } } })，且默认/非法值落 v4', () => {
  assert.match(SRC, /saveConfig\(\{ memory: \{ v5: \{ engine: next \} \} \}\)/)
  assert.match(SRC, /=== 'v5' \? 'v5' : 'v4'/, '引擎值必须白名单归一化（只认 v5）')
  assert.match(SRC, /LLMINQQ_MEMORY_ENGINE=v4/, '卡片要提示环境变量秒回退')
})

test('store 默认值：engine=v4（不迁移也不切）、distill 默认 10 分钟', async () => {
  const { defaults } = await import(pathToFileURL(path.join(ROOT, 'lib', 'store.js')).href)
  const d = defaults()
  assert.equal(d.memory?.v5?.enabled, true)
  assert.equal(d.memory?.v5?.engine, 'v4', '默认必须 v4 —— 空库切 v5 等于不注入记忆')
  assert.equal(d.memory?.v5?.distill?.enabled, true)
  assert.equal(d.memory?.v5?.distill?.intervalMin, 10)
})

test('bridgeConfig 透传 engine（经 memoryV5Config），别只吃桥侧默认值', () => {
  const idx = fs.readFileSync(path.join(ROOT, 'lib', 'index.js'), 'utf8')
  assert.match(idx, /function memoryV5Config \(/)
  assert.match(idx, /engine: String\(v5\.engine \?\? ''\)\.trim\(\)\.toLowerCase\(\) === 'v5' \? 'v5' : 'v4'/)
})
