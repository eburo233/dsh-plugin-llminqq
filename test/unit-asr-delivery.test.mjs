// test/unit-asr-delivery.test.mjs —— ASR 转写的结果必须能回到会话
//
// 背景（2026-11-01 用户实测）：
//   用户发了个 B站视频链接，模型调 bili_transcribe_start 拿到 job_id，
//   说了句「视频没公开字幕，我还在后台从视频里转文字，等转好了看看它怎么说」
//   就**结束了这一轮**（37 秒）。
//
//   ASR 在后台继续跑，09:52 转完（3574 字节，成功，文件都在），
//   但**没有任何人再去取**：
//     · 模型这一轮已结束，没有「下次工具调用」的机会；
//     · MCP 的 _TRANSCRIBE_JOBS 只在它自己进程内存里，桥看不到；
//     · 结果就永远躺在 ~/.dsh/bili-duty/tmp/BV163xB6zEwF.txt 里没人用。
//
// 解法：MCP 转完把结果落盘到 <stateDir>/transcribe-ready/<job_id>.json；
//       桥在拼下一轮上下文时扫这个目录，把没送达的结果注入，然后打 .sent 标记。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 2026-11-05：拆句重构后，stripPeriod / splitOutboundParts 都在 common.js（纯函数层），
// state.js 里的 splitLongSentence 已删 —— 这几条断句断言跟着搬到新函数上。
import { splitOutboundParts, stripPeriod } from '../lib/bridge/common.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SRC = fs.readFileSync(path.join(ROOT, 'lib', 'bridge', 'index.js'), 'utf8')
const MCP = fs.readFileSync(path.join(ROOT, 'vendor', 'bilibili-mcp', 'mcp_server.py'), 'utf8')

/** 从源码里抠出三个函数并用 stub 执行 */
function loadFns (memoryDir) {
  const start = SRC.indexOf('function transcribeReadyDir')
  assert.ok(start > 0, '定位不到 transcribeReadyDir')
  const end = SRC.indexOf('/** 深夜时给模型的提示', start)
  assert.ok(end > start, '定位不到函数结尾')
  const body = SRC.slice(start, end)
  const fn = new Function('path', 'fs', 'config', 'ROOT', 'logger', `${body}; return { transcribeReadyDir, pickTranscribeReady, markTranscribeSent }`)
  return fn(path, fs, { memory: { dir: memoryDir } }, '/tmp', { log: () => {} })
}

function mkFixture () {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llminqq-asr-'))
  const memoryDir = path.join(dataDir, 'agent', 'memory')
  fs.mkdirSync(memoryDir, { recursive: true })
  const ready = path.join(dataDir, 'state', 'transcribe-ready')
  fs.mkdirSync(ready, { recursive: true })
  return { dataDir, memoryDir, ready }
}

test('待送达目录的路径必须和 MCP 侧一致（否则一边写一边读永远对不上）', () => {
  const f = mkFixture()
  try {
    const m = loadFns(f.memoryDir)
    const got = m.transcribeReadyDir()
    assert.equal(got, path.join(f.dataDir, 'state', 'transcribe-ready'),
      `桥算出的目录不对：${got}`)
    // MCP 侧也必须落在同一个地方
    assert.match(MCP, /LLMINQQ_STATE_DIR|dsh-plugin-llminqq"\s*\/\s*"state/,
      'MCP 没有用 LLMINQQ_STATE_DIR 推导目录')
    assert.match(MCP, /transcribe-ready/, 'MCP 没写 transcribe-ready 目录')
  } finally {
    fs.rmSync(f.dataDir, { recursive: true, force: true })
  }
})

test('能读到 done 状态的转写结果', () => {
  const f = mkFixture()
  try {
    fs.writeFileSync(path.join(f.ready, 'tj1.json'), JSON.stringify({
      job_id: 'tj1', bvid: 'BV163xB6zEwF', state: 'done', text: '这个视频讲怎么说话',
    }))
    const m = loadFns(f.memoryDir)
    const items = m.pickTranscribeReady()
    assert.equal(items.length, 1)
    assert.equal(items[0].bvid, 'BV163xB6zEwF')
    assert.equal(items[0].text, '这个视频讲怎么说话')
  } finally {
    fs.rmSync(f.dataDir, { recursive: true, force: true })
  }
})

test('注入过的结果不再重复注入（否则每轮都烧一遍完整视频文本）', () => {
  const f = mkFixture()
  try {
    fs.writeFileSync(path.join(f.ready, 'tj2.json'), JSON.stringify({
      job_id: 'tj2', bvid: 'BV2', state: 'done', text: '内容',
    }))
    const m = loadFns(f.memoryDir)
    const first = m.pickTranscribeReady()
    assert.equal(first.length, 1, '前置：第一次应该能读到')
    m.markTranscribeSent(first)
    assert.equal(m.pickTranscribeReady().length, 0, '打过 .sent 标记后不该再注入')
    // 文件本身要留着（排障用），不能删
    assert.ok(fs.existsSync(path.join(f.ready, 'tj2.json')), '不该删结果文件，只打标记')
    assert.ok(fs.existsSync(path.join(f.ready, 'tj2.sent')), '应该建了 .sent 标记')
  } finally {
    fs.rmSync(f.dataDir, { recursive: true, force: true })
  }
})

test('error 状态不注入内容（但也不要每轮重试，打标记跳过）', () => {
  const f = mkFixture()
  try {
    fs.writeFileSync(path.join(f.ready, 'tj3.json'), JSON.stringify({
      job_id: 'tj3', bvid: 'BV3', state: 'error', text: '转写异常：xxx',
    }))
    const m = loadFns(f.memoryDir)
    assert.equal(m.pickTranscribeReady().length, 0,
      'error 不该把技术错误喂给模型让它对用户复述')
    assert.ok(fs.existsSync(path.join(f.ready, 'tj3.sent')),
      'error 也要打标记 —— 否则每轮都白扫一遍')
  } finally {
    fs.rmSync(f.dataDir, { recursive: true, force: true })
  }
})

test('目录不存在 / 坏 JSON 都不能让本轮崩掉', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llminqq-asr2-'))
  try {
    const memoryDir = path.join(dataDir, 'agent', 'memory')
    fs.mkdirSync(memoryDir, { recursive: true })
    const m = loadFns(memoryDir)
    assert.deepEqual(m.pickTranscribeReady(), [], '目录不存在时返回空数组，不抛错')
    // 造一个坏 JSON
    const ready = path.join(dataDir, 'state', 'transcribe-ready')
    fs.mkdirSync(ready, { recursive: true })
    fs.writeFileSync(path.join(ready, 'bad.json'), '{不是 json')
    assert.deepEqual(m.pickTranscribeReady(), [], '坏 JSON 跳过，不抛错')
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('桥必须在拼上下文时调用注入（不能只定义了函数）', () => {
  assert.match(SRC, /pickTranscribeReady\(\)/, '桥里没调用 pickTranscribeReady')
  const i = SRC.indexOf('pickTranscribeReady()')
  const block = SRC.slice(Math.max(0, i - 1200), i + 800)
  assert.match(block, /contextLines\.push/, '读到的结果要 push 进 contextLines（否则模型看不到）')
  assert.match(block, /markTranscribeSent/, '注入后要打标记，否则每轮重复注入')
})

test('MCP 转写完成时要把结果写到待送达目录', () => {
  assert.match(MCP, /_write_ready_marker/, 'MCP 里没有 _write_ready_marker')
  // _job_run 的成功与失败分支都要写
  const jobRun = MCP.slice(MCP.indexOf('async def _job_run'), MCP.indexOf('async def _job_run') + 700)
  assert.match(jobRun, /_write_ready_marker\(.*"done"/, '成功时要写 done 标记')
  assert.match(jobRun, /_write_ready_marker\(.*"error"/, '失败时也要写（带错误原因）')
  // 写要用原子替换，桥不能读到半个文件
  assert.match(MCP, /\.tmp/, '写标记要用临时文件 + 原子替换')
})

// ── 断句：去句号 + 多发几条（用户要求）────────────────────────────────────────
//
// 用户原话：「断句的时候去掉句号，没人在聊天工具里用句号，而是多发几条」。
//
// 这不是审美问题 —— 真人 QQ 聊天确实几乎不打「。」，一条回复里带句号
// 会立刻透出「这是生成文本」的味道。
//
// 2026-11-05 重构：splitLongSentence 删除，拆条 = common.splitOutboundParts
// （换行/[SPLIT] 强制拆 + 标点兜底 + 每轮最多 5 条）。以下断言跟着新函数走。

test('分条默认每轮最多 5 条（2026-11-05 用户定稿，从 3 提到 5）', () => {
  // 8 行换行（=8 个强制断点）→ 前 4 条各自独立，尾部并成第 5 条
  const lines = Array.from({ length: 8 }, (_, i) => `第${i + 1}句`)
  const { parts } = splitOutboundParts(lines.join('\n'))
  assert.equal(parts.length, 5, '默认上限应该是 5 条（刷屏比超长烦）')
})

test('超阈值的长句仍按标点兜底拆（不然一坨发出去）', () => {
  const { parts } = splitOutboundParts('A'.repeat(20) + '，' + 'B'.repeat(20), { threshold: 10 })
  assert.deepEqual(parts, ['A'.repeat(20) + '，', 'B'.repeat(20)],
    '超过 splitChars 的段必须按标点再拆，且不能劈词')
})

test('发出去的每一段都要去掉句号，但保留 ！？', () => {
  assert.equal(stripPeriod('好的。'), '好的', '中文句号要删掉 —— 聊天工具里没人打句号')
  assert.equal(stripPeriod('真的？'), '真的？', '问号要保留（去掉语气就变平了）')
  assert.equal(stripPeriod('牛！'), '牛！', '感叹号要保留')
  assert.doesNotMatch(stripPeriod('你在吗？？？'), /[？？？]{2}/, '连排问号压成一个')
})

test('英文句点只删行尾（别把 3.14 / 域名拆坏）', () => {
  assert.equal(stripPeriod('3.14 和 example.com 都不动'), '3.14 和 example.com 都不动')
  assert.equal(stripPeriod('句号在末尾.'), '句号在末尾', '行尾英文句点可以删')
})

test('已 sent 的标记要能扛住「桥重启」（文件系统持久）', () => {
  const f = mkFixture()
  try {
    fs.writeFileSync(path.join(f.ready, 'tj9.json'), JSON.stringify({
      job_id: 'tj9', bvid: 'BV9', state: 'done', text: '内容',
    }))
    // 第一次「进程」打标记
    const m1 = loadFns(f.memoryDir)
    m1.markTranscribeSent(m1.pickTranscribeReady())
    // 「重启」后新实例读同一个目录
    const m2 = loadFns(f.memoryDir)
    assert.equal(m2.pickTranscribeReady().length, 0,
      '标记必须落在磁盘上 —— 否则桥一重启就把老视频全文又注入一遍')
  } finally {
    fs.rmSync(f.dataDir, { recursive: true, force: true })
  }
})
