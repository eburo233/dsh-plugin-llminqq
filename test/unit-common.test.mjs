// unit-common.test.mjs —— lib/bridge/common.js 的纯函数单测（表驱动、零副作用、不联网）
//
// 这些是「模型输出 → 消息段」链路的最后一道关：
//   · chunkText 切错 → QQ 单条上限炸 / 把 [SEND_FILE:] 标记切成两半
//   · textToSegments 的共享全局正则 lastIndex 没重置 → 第二次调用会漏 @
// 以前它们埋在整个 index.js 里，只能靠端到端测；拆出来后这里直接打表。
//
// 用 node:test（不是仓库里老的自定义 harness）—— 新单测走标准接口，
// 断言失败会带诊断信息，`node --test` 也能直接聚合。

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const COMMON = await import(pathToFileURL(path.join(PKG, 'lib', 'bridge', 'common.js')).href)
const {
  chunkText, textToSegments,
  SEND_FILE_RE, AT_RE, POKE_RE, FOLLOW_RE, VOICE_RE,
} = COMMON

// ── chunkText：按上限切分，尽量在换行处断 ──────────────────────────────────
// 契约（读代码得到，不是猜的）：
//   · 每段长度 ≤ max；唯一例外不存在（换行点永远不会 > max）
//   · 优先在 `max` 之前最后一个 '\n' 处断，但断点太靠前（< max/2）就放弃换行、按 max 硬切
//   · 断在换行处时，那段换行本身被吃掉（避免下一段开头是空行）
//   · 空串 → []（不是 ['']）
const chunkCases = [
  { name: '短文本原样返回', text: 'hello', max: 10, want: ['hello'] },
  { name: '恰好等于上限不切', text: 'x'.repeat(10), max: 10, want: ['x'.repeat(10)] },
  { name: '空文本 → 空数组（不产出空段）', text: '', max: 10, want: [] },
  {
    name: '没有换行 → 按 max 硬切',
    text: 'x'.repeat(25), max: 10,
    want: ['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)],
  },
  {
    name: '换行在右半边 → 在换行处切，且吃掉分隔换行',
    text: 'a'.repeat(10) + '\n' + 'b'.repeat(10), max: 12,
    want: ['a'.repeat(10), 'b'.repeat(10)],
  },
  {
    name: '换行在左半边 → 放弃换行点，按 max 硬切',
    text: 'ab\n' + 'c'.repeat(20), max: 10,
    want: ['ab\nccccccc', 'c'.repeat(10), 'ccc'],
  },
  {
    name: '多个连续换行 → 断点仍在上限内，段尾换行保留、下一段不以空行开头',
    text: 'a'.repeat(8) + '\n\n\n' + 'b'.repeat(8), max: 10,
    want: ['a'.repeat(8) + '\n\n', 'b'.repeat(8)],
  },
]

for (const c of chunkCases) {
  test(`chunkText: ${c.name}`, () => {
    const got = chunkText(c.text, c.max)
    assert.deepEqual(got, c.want)
    for (const [i, seg] of got.entries()) {
      assert.ok(seg.length <= c.max, `第 ${i + 1} 段长度 ${seg.length} 超过上限 ${c.max}`)
    }
  })
}

test('chunkText: 不丢字符（除了断点处被吃掉的换行）', () => {
  const text = 'line one\nline two\nline three\nline four'
  const got = chunkText(text, 9)
  // 拼回去必须等于原文去掉断点换行；用「去掉全部换行」做不变量更稳
  assert.equal(got.join('').replace(/\n/g, ''), text.replace(/\n/g, ''))
})

// ── 控制标记的回归用例：桥把模型输出分块后**逐块**跑 textToSegments ─────
// lib/bridge/index.js:616 `chunkText(text, max)` 的注释写着「保留 [AT] 标记」，
// 所以标记跨块被切成两半 = 线上真实事故（用户会看到字面量 "[AT:12" 和 "3]"）。
test('chunkText: 标记完整落在同一块内 → 原样保留（正常路径）', () => {
  const text = '第一段文字\n[AT:12345] 你好呀'
  const got = chunkText(text, 60)
  assert.equal(got.length, 1)
  assert.ok(got[0].includes('[AT:12345]'), `AT 标记被破坏了：${JSON.stringify(got)}`)
})

test('chunkText: 换行在标记之前断 → 标记整体留在下一块', () => {
  const text = 'x'.repeat(20) + '\n[AT:12345]hi'
  const got = chunkText(text, 25)
  assert.deepEqual(got, ['x'.repeat(20), '[AT:12345]hi'])
})

// ✅ 已修：chunkText 现在把 [AT:qq] / [SEND_FILE: ...] 当不可分割单元 ——
// 切点落在标记内部时退到 '['（标记整体进下一块），或在标记不太长时补到 ']' 之后。
// 修复前这两条是「已知缺陷」的特征化断言，现在改成期望行为。
test('chunkText: 单个 AT 标记跨过边界时不被切断', () => {
  const text = 'x'.repeat(9) + '[AT:12345]'
  const got = chunkText(text, 10)
  assert.deepEqual(got, ['x'.repeat(9), '[AT:12345]'])
  assert.ok(got.some(c => /\[AT:\d+\]/.test(c)), '标记必须完整地留在某一块里')
})

test('chunkText: [SEND_FILE:] 标记跨块时不被切断，且字符不丢', () => {
  const text = 'y'.repeat(8) + '[SEND_FILE: /tmp/long-path.png]'
  const got = chunkText(text, 12)
  assert.equal(got.join(''), text, '切块不能丢字符')
  assert.equal(got.some(c => /\[SEND_FILE:\s*[^\]\n]+?\]/.test(c)), true,
    'SEND_FILE 标记必须完整保留在单块内，否则发文件会静默失效')
})

// ── textToSegments：把 [AT:qq] 转成真 @ 段 ─────────────────────────────────
const tm = text => ({ type: 'text', data: { text } })
const at = qq => ({ type: 'at', data: { qq } })

const segCases = [
  { name: '纯文本 → 单个 text 段', text: 'hello', want: [tm('hello')] },
  { name: '空文本 → 一个空 text 段（不是空数组）', text: '', want: [tm('')] },
  {
    name: '中间有 AT → text / at / text',
    text: 'hi [AT:12345] there',
    want: [tm('hi '), at('12345'), tm(' there')],
  },
  { name: '开头 AT → at + text', text: '[AT:123]tail', want: [at('123'), tm('tail')] },
  { name: '结尾 AT → text + at', text: 'head[AT:9]', want: [tm('head'), at('9')] },
  {
    name: '连续 AT → 不插入空 text 段',
    text: '[AT:1][AT:2]',
    want: [at('1'), at('2')],
  },
  {
    name: '非数字 QQ 不识别（原样留在文本里）',
    text: '[AT:abc]',
    want: [tm('[AT:abc]')],
  },
]

for (const c of segCases) {
  test(`textToSegments: ${c.name}`, () => {
    assert.deepEqual(textToSegments(c.text), c.want)
  })
}

test('textToSegments: 共享全局正则的 lastIndex 每次重置（连调两次结果一致）', () => {
  const text = 'a[AT:111]b[AT:222]c'
  const first = textToSegments(text)
  const second = textToSegments(text)
  assert.deepEqual(second, first, '第二次调用漏了 @ —— AT_RE.lastIndex 没重置')
  // 文本段里不能再残留 [AT: 标记
  const textBlob = first.filter(s => s.type === 'text').map(s => s.data.text).join('')
  assert.ok(!textBlob.includes('[AT:'), `文本段里残留了 AT 标记：${textBlob}`)
})

// ── 标记正则表驱动 ─────────────────────────────────────────────────────────
// 这些正则被多个模块共享（global 标志有状态），这里验证「匹配 + 捕获组」本身。
function firstMatch (re, text) {
  re.lastIndex = 0
  const m = re.exec(text)
  return m ? Array.from(m) : null
}

const regexCases = [
  {
    name: 'SEND_FILE_RE 捕获路径（允许冒号后空格）',
    re: SEND_FILE_RE, text: '看这个 [SEND_FILE: /tmp/a b.png] 好看',
    want: ['[SEND_FILE: /tmp/a b.png]', '/tmp/a b.png'],
  },
  {
    name: 'AT_RE 捕获 QQ 号（字符串）',
    re: AT_RE, text: 'hi [AT:12345]',
    want: ['[AT:12345]', '12345'],
  },
  {
    name: 'POKE_RE 不带场景时只有 QQ 号',
    re: POKE_RE, text: '[POKE:10086]',
    want: ['[POKE:10086]', '10086', undefined],
  },
  {
    name: 'POKE_RE 带 c2c 场景',
    re: POKE_RE, text: '[POKE:10086:c2c]',
    want: ['[POKE:10086:c2c]', '10086', 'c2c'],
  },
  {
    name: 'POKE_RE 带 group 场景',
    re: POKE_RE, text: '[POKE:10086:group]',
    want: ['[POKE:10086:group]', '10086', 'group'],
  },
  {
    name: 'FOLLOW_RE 捕获补充文字',
    re: FOLLOW_RE, text: '正文 [FOLLOW: 想起来补一句]',
    want: ['[FOLLOW: 想起来补一句]', '想起来补一句'],
  },
  {
    name: 'VOICE_RE 捕获文字与音色 id',
    re: VOICE_RE, text: '[VOICE:你好呀:音色1]',
    want: ['[VOICE:你好呀:音色1]', '你好呀', '音色1'],
  },
  {
    name: 'VOICE_RE 不带音色 id',
    re: VOICE_RE, text: '[VOICE:你好呀]',
    want: ['[VOICE:你好呀]', '你好呀', undefined],
  },
]

for (const c of regexCases) {
  test(`正则: ${c.name}`, () => {
    assert.deepEqual(firstMatch(c.re, c.text), c.want)
  })
}

test('正则: SEND_FILE_RE 不会跨行吞掉后面的正文', () => {
  SEND_FILE_RE.lastIndex = 0
  const text = '[SEND_FILE: /tmp/a.png]\n第二行'
  const matches = []
  let m
  while ((m = SEND_FILE_RE.exec(text)) !== null) matches.push(m[1])
  assert.deepEqual(matches, ['/tmp/a.png'])
})
