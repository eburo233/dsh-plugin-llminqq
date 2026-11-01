// test/unit-bili-frames.test.mjs —— 「看画面」的上限与去重
//
// 背景（2026-11-01 用户要求）：
//   「上限顶格 200 帧，模型可以自己传，很多视频都需要有图片才能理解意思」
//
// 但这里有个必须处理的现实：B站故事板不是无限的 ——
// 实测一个 347 秒的视频只有 **43 格**。所以：
//   · 请求 200 帧 ≠ 返回 200 张图；
//   · 按时间最近取会让多帧落到同一格 → 同一张图传 5 次，模型看不到新信息，
//     纯粹白烧 token（每张图 100-200 token，200 张就是 2-4 万）。
//
// 所以「上限 200」的正确含义是：**模型最多可以要多少**，
// 实际返回 = min(请求数, 故事板格数)，且**同格去重**。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const PY = fs.readFileSync(path.join(ROOT, 'vendor', 'bilibili-mcp', 'mcp_server.py'), 'utf8')
const AGENTS = fs.readFileSync(path.join(ROOT, 'qq-agent', 'AGENTS.md'), 'utf8')

test('帧数上限必须是 200（用户明确要求）', () => {
  const m = PY.match(/_FRAME_MAX = (\d+)/)
  assert.ok(m, '找不到 _FRAME_MAX')
  assert.equal(Number(m[1]), 200, `上限应该是 200，实际 ${m[1]}`)
})

test('上限只作用于请求；真实帧数还要被故事板格数限制', () => {
  // 文档里必须说清楚这件事，否则模型会以为「要 200 就一定给 200」，
  // 拿不到就以为工具坏了
  assert.match(PY, /实际能拿到多少取决于 B站故事板有几格|故事板有几格/,
    'docstring 没说明「实际帧数受故事板格数限制」')
})

test('必须同格去重（否则 200 帧会变成同一张图传很多遍）', () => {
  assert.match(PY, /seen_tiles/, '没有去重集合')
  const i = PY.indexOf('picked = []')
  const block = PY.slice(i, i + 400)
  assert.match(block, /if tile in seen_tiles:\s*\n\s*continue/,
    '没有「同格跳过」的逻辑 —— 请求 200 帧会返回大量重复图片')
})

test('去重后仍保留原始顺序（不是乱序）', () => {
  const i = PY.indexOf('picked = []')
  const block = PY.slice(i, i + 400)
  // seen_tiles.add 必须在 append 之后/同时，且循环是按 targets 顺序走的
  assert.match(block, /for t in targets:/, '必须按目标时间顺序遍历')
  assert.match(block, /picked\.append/, '要收集到 picked')
})

test('AGENTS.md 必须写「什么时候必须看图」（用户要求加）', () => {
  assert.match(AGENTS, /## 5\.2 什么时候\*\*必须\*\*看图/,
    '缺 5.2 节 —— 模型还是只靠文字判断')
  // 必须覆盖用户提到的场景类型
  for (const kw of ['教程', '舞蹈', '游戏', '字幕为空']) {
    assert.ok(AGENTS.includes(kw), `5.2 节里没提到「${kw}」这类必须看图的情况`)
  }
})

test('AGENTS.md 要写清楚 200 上限 + 去重（别让模型误会工具坏了）', () => {
  assert.match(AGENTS, /上限 200 帧/, '没写上限')
  assert.match(AGENTS, /同一格不会重复给你|同格/, '没写去重行为')
})

test('tools 描述里也要带上「什么时候该用」和上限', () => {
  const i = PY.indexOf('async def bili_frames')
  const doc = PY.slice(i, i + 1500)
  assert.match(doc, /1-200/, '工具自描述里没写 1-200')
  assert.match(doc, /教程|舞蹈|游戏实况/,
    '工具自描述里没提「什么场景必须看图」—— 模型未必会读到 AGENTS.md')
})
