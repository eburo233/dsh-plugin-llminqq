// test/unit-bili-subtitle-ts.test.mjs —— 字幕时间戳 + 凭据路径
//
// 背景（2026-11-01 用户问「字幕有时间戳吗」）：
//   B站字幕的 body 每段本来就是 {"from": 0.3, "to": 3.31, "content": "..."}，
//   但代码只取了 content，**把「这句话在第几秒说的」这条最有用的信息删掉了**。
//
//   为什么重要：宫格图每格标着时间戳，字幕不带时间戳就**对不上** ——
//   模型只能说「图里有几个对话示例」而说不出「第 3 格在 15-23 秒演示的是什么」。
//   这才是「图文理解」的前提。
//
// 顺带查出第二个 bug：`CRED_FILE` 硬编码成 `<包目录>/bili_credential.json`，
// 而插件通过 `BILI_CREDENTIAL_PATH` 下发的是 `~/.dsh/bili-duty/` 那份 ——
// 那个路径**根本没被读取**。于是 load_credential() 返回 None，
// 所有需要登录的工具（bili_subtitle / bili_comments / bili_reply）全部退化成
// 「未登录」。用户看到的表现是机器人说「视频没公开字幕」，其实有字幕读不到。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const PY = fs.readFileSync(path.join(ROOT, 'vendor', 'bilibili-mcp', 'mcp_server.py'), 'utf8')
const AGENTS = fs.readFileSync(path.join(ROOT, 'qq-agent', 'AGENTS.md'), 'utf8')

// ── ① 凭据路径必须听环境变量 ────────────────────────────────────────────────

test('凭据路径要读 BILI_CREDENTIAL_PATH（不能硬编码在包里）', () => {
  assert.match(PY, /BILI_CREDENTIAL_PATH/,
    '没读 BILI_CREDENTIAL_PATH —— 凭据会指向包里那个不存在的文件，所有登录工具全废')
  const i = PY.indexOf('CRED_FILE =')
  const block = PY.slice(i - 500, i + 200)
  assert.match(block, /_cred_env|BILI_CREDENTIAL_PATH/, 'CRED_FILE 的定义里没有用环境变量')
  // 空值时要有兜底（手工跑的老行为不能坏）
  assert.match(block, /Path\(__file__\)\.parent/,
    '环境变量没设时要退回包目录 —— 否则手工跑就找不到凭据')
})

// ── ② 字幕必须带时间戳 ──────────────────────────────────────────────────────

test('字幕要保留 from/to（原来只取 content 全丢了）', () => {
  assert.match(PY, /"from"/, '没保留 from')
  assert.match(PY, /"to"/, '没保留 to')
  const i = PY.indexOf('body = sub_data.get("body"')
  assert.ok(i > 0, '定位不到字幕 body 解析')
  const block = PY.slice(i, i + 600)
  assert.match(block, /float\(item\.get\("from"/, '没从 body 读 from')
})

test('要同时给三种形式（纯文本 / 带时间戳文本 / 结构化）', () => {
  assert.match(PY, /"text": full_text/, '缺纯文本（老调用方要用）')
  assert.match(PY, /"timedText": timed_text/, '缺带时间戳的文本')
  assert.match(PY, /"segmentsWithTime": segs/, '缺结构化的 segments')
})

test('带时间戳的文本要是 [mm:ss] 前缀（好和宫格图对）', () => {
  const i = PY.indexOf('def _mmss')
  assert.ok(i > 0, '缺 _mmss 时间格式化')
  const block = PY.slice(i, i + 300)
  assert.match(block, /divmod/, '_mmss 应该用 divmod 算分秒')
  assert.match(PY, /\[%s\] %s/, '每行应该是 [时间] 台词 的格式')
})

test('空 content / 坏 from 要跳过而不是产出脏数据', () => {
  const i = PY.indexOf('body = sub_data.get("body"')
  const block = PY.slice(i, i + 900)
  assert.match(block, /if not t:\s*\n\s*continue/, '空内容要跳过')
  assert.match(block, /except \(TypeError, ValueError\)/, 'from/to 解析失败要兜底')
})

// ── ③ 提示词：storyboard 优先 + 说明时间戳用法 ──────────────────────────────

test('AGENTS.md 要把 storyboard 排在 bili_frames 前面', () => {
  assert.match(AGENTS, /优先用 storyboard/,
    '没写优先级 —— 模型还会先用分辨率低的故事板帧')
  // 两个工具的对比要写清楚（为什么 storyboard 更好）
  assert.match(AGENTS, /画面变化/, '没说明 storyboard 是按画面变化选帧')
  assert.match(AGENTS, /看不清|字小到看不清/, '没说清 bili_frames 的清晰度问题')
})

test('AGENTS.md 要说明字幕时间戳怎么和宫格图配合', () => {
  assert.match(AGENTS, /timedText/, '没提 timedText')
  assert.match(AGENTS, /segmentsWithTime/, '没提 segmentsWithTime')
  assert.match(AGENTS, /对得上|对时间戳/,
    '没说明「字幕时间戳 + 宫格时间戳」怎么配合 —— 这才是图文理解的关键')
})
