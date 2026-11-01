// test/unit-agents-scaffold.test.mjs —— AGENTS.md 升级策略
//
// 背景（2026-11-01 真实事故）：
//   用户问「这视频讲了啥」，机器人回得完全不沾边。查下来它**根本没看画面** ——
//   我当天新加的 §5.2「什么时候必须看图」**压根没到模型手里**。
//
//   原因：`ensureAgentScaffold` 里是
//       if (!fs.existsSync(agentsFile)) { 写一次 }
//   注释还写着「升级插件不会重写它」。于是 agent 工作区那份永远是 10-31 的旧版，
//   而我 11-01 才加的新规则永远进不去。
//
//   但「升级就覆盖」也不对 —— 用户可能自己改过。所以改成三态：
//     ① 不存在            → 写
//     ② 我们写的且是旧版   → 升级（用指纹判断）
//     ③ 用户改过           → 不覆盖，只提示

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SRC = fs.readFileSync(path.join(ROOT, 'lib', 'index.js'), 'utf8')
const AGENTS = fs.readFileSync(path.join(ROOT, 'qq-agent', 'AGENTS.md'), 'utf8')

test('AGENTS.md 必须有 §5.2（什么时候必须看图）', () => {
  assert.match(AGENTS, /## 5\.2 什么时候\*\*必须\*\*看图/,
    '缺 5.2 节 —— 模型不会知道该看画面（这次答非所问的直接原因）')
})

test('scaffold 不能再是「只在不存在时写一次」', () => {
  // 关键：必须有升级逻辑，不能只有 if (!exists) 分支
  const i = SRC.indexOf('const agentsFile = path.join(agentDir')
  assert.ok(i > 0, '定位不到 agentsFile')
  const block = SRC.slice(i, i + 3000)
  assert.match(block, /已升级|升级/, '没有升级分支 —— 新规则永远到不了模型')
  assert.match(block, /STAMP_PREFIX|llminqq-agents-sha256/,
    '没有版本指纹 —— 无法区分「我们写的旧版」和「用户改过的」')
})

test('用户改过就不能覆盖（指纹不符要保护用户改动）', () => {
  const i = SRC.indexOf('const agentsFile = path.join(agentDir')
  const block = SRC.slice(i, i + 3000)
  assert.match(block, /被你改过|以你的版本为准/,
    '没有保护用户改动的分支')
})

test('升级要留日志（否则「新规则没生效」根本查不出来）', () => {
  const i = SRC.indexOf('const agentsFile = path.join(agentDir')
  const block = SRC.slice(i, i + 3000)
  assert.match(block, /log\(`\[llminqq\] 工程约定文档已升级/,
    '升级没有日志 —— 这次就是「静默没更新」才查了半天')
})

test('写入要带指纹（下次才知道这份是不是我们写的）', () => {
  const i = SRC.indexOf('const agentsFile = path.join(agentDir')
  const block = SRC.slice(i, i + 3000)
  assert.match(block, /sha256/, '写入时没算指纹')
  assert.match(block, /mode: 0o600|0o600/, 'AGENTS.md 应当只有本人可读（0600）')
})
