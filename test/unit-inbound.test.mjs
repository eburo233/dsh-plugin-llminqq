// test/unit-inbound.test.mjs —— 入站非文字消息不再被静默丢弃
//
// 背景（2026-11-02 用户实测）：
//   往私聊发了一个文件，机器人**一声不吭**。日志里只有「空消息，忽略」。
//   查 flattenMessage：它只认 text/image/reply/forward/json/xml/at/face，
//   file/record/video/mface/contact/location/dice/rps 这些段被**静默跳过** →
//   text 为空、images=0 → handleInbound 的「空消息判定」把整条消息扔掉。
//
// 修法（本次改动）：
//   ① common.js segmentPlaceholder：非文字段生成人类可读占位
//      （[文件] 名字 (大小) / [语音] Ns / [视频] / [表情包] / ... / [不支持的消息类型: xxx]）；
//   ② flattenMessage 把占位并进 text，并单独返回 placeholders（提示词要用）；
//   ③ 上下文明确告诉模型「你只能看到占位描述，看不到内容」，且**不下载**文件。
//
// 注意：flattenMessage 是 index.js 的模块私有函数（import 整个 index.js 会起桥、
// 连 OneBot、读配置），所以这里沿用 unit-time-context 的做法：从源码里抠出函数体
// 用 eval 执行，只是给 gateway/卡片解析打最小 stub。这样测的是**真代码**。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// flattenMessage 引用了 index.js 从 common.js import 的 segmentPlaceholder；
// eval 出来的函数按作用域链找到这里的 import，不用把 index.js 整个跑起来。
import { segmentPlaceholder } from '../lib/bridge/common.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SRC = fs.readFileSync(path.join(ROOT, 'lib', 'bridge', 'index.js'), 'utf8')

/** 按花括号配平从源码里抠出一个顶层 function（跳过函数体里的 `{`）。 */
function fnSource (name) {
  const i = SRC.indexOf(`function ${name}`)
  assert.ok(i > 0, `定位不到 ${name}`)
  const start = SRC.indexOf('{', i)
  let depth = 0
  let end = start
  for (let k = start; k < SRC.length; k++) {
    if (SRC[k] === '{') depth++
    else if (SRC[k] === '}') { depth--; if (depth === 0) { end = k + 1; break } }
  }
  return SRC.slice(i, end)
}

/** 抠出 flattenMessage 并注入它依赖的最小 stub。 */
function loadFlatten () {
  const gateway = { selfId: '999' }                       // @自己判定用
  const selfMessageIds = new Set(['77'])                  // 「别人回复的是我」判定用
  const cardJsonToText = seg => `[卡片] ${JSON.stringify(seg.data ?? {})}`
  const xmlToText = () => '[卡片] xml'
  // eslint-disable-next-line no-eval
  return eval(`(${fnSource('flattenMessage')})`)
}

const flattenMessage = loadFlatten()

// ── ① 非文字段的占位文本 ────────────────────────────────────────────────────
// 表驱动：段类型 → 生成的占位。核心要求是「人类能读懂」+「绝不返回空串」
// （返回空串 = 这条消息又会被空消息判定丢掉）。
const placeholderCases = [
  {
    name: '文件：带名字和大小',
    seg: { type: 'file', data: { name: '周报.pdf', size: 1234 } },
    want: '[文件] 周报.pdf (1.2 KB)',
  },
  {
    name: '文件：file_size 字段（OneBot v11 的写法）',
    seg: { type: 'file', data: { file_name: 'a.zip', file_size: 2048 } },
    want: '[文件] a.zip (2 KB)',
  },
  {
    name: '文件：大小是字符串也认',
    seg: { type: 'file', data: { name: 'b.txt', size: '512' } },
    want: '[文件] b.txt (512 B)',
  },
  {
    name: '文件：只有 file 字段（可能是路径）→ 只留文件名',
    seg: { type: 'file', data: { file: '/tmp/x/receipt.png', size: 1024 } },
    want: '[文件] receipt.png (1 KB)',
  },
  {
    name: '文件：拿不到名字 → 明确说未知，而不是空',
    seg: { type: 'file', data: { size: 10 } },
    want: '[文件] (未知文件名) (10 B)',
  },
  { name: '语音：带时长', seg: { type: 'record', data: { duration: 5 } }, want: '[语音] 5s' },
  { name: '语音：时长为字符串', seg: { type: 'record', data: { duration: '3' } }, want: '[语音] 3s' },
  { name: '语音：没有时长只说语音，不编时长', seg: { type: 'record', data: {} }, want: '[语音]' },
  { name: '视频', seg: { type: 'video', data: {} }, want: '[视频]' },
  { name: '表情包（市场表情）', seg: { type: 'mface', data: {} }, want: '[表情包]' },
  { name: '名片', seg: { type: 'contact', data: {} }, want: '[名片]' },
  { name: '位置', seg: { type: 'location', data: {} }, want: '[位置]' },
  { name: '骰子', seg: { type: 'dice', data: {} }, want: '[骰子]' },
  { name: '猜拳', seg: { type: 'rps', data: {} }, want: '[猜拳]' },
  {
    name: '未知类型 → 带类型名，方便以后排查',
    seg: { type: 'markdown', data: {} },
    want: '[不支持的消息类型: markdown]',
  },
]

for (const c of placeholderCases) {
  test(`flattenMessage 占位：${c.name}`, () => {
    const flat = flattenMessage([c.seg])
    assert.equal(flat.text, c.want)
    assert.deepEqual(flat.placeholders, [c.want])
    assert.equal(flat.images.length, 0)
  })
}

test('flattenMessage：文件只给占位；元数据单独收集，不塞进正文', () => {
  // 明确锁住「不要自作主张下载」：即便 OneBot 给了 url/file_id，
  // 正文里也只出现名字/大小（模型想知道内容只能问人）。
  const flat = flattenMessage([{
    type: 'file',
    data: {
      name: '合同.docx', size: 999,
      url: 'http://192.168.1.9:3000/get_file?file_id=abc',
      file_id: 'abc',
    },
  }])
  assert.equal(flat.text, '[文件] 合同.docx (999 B)')
  assert.ok(!flat.text.includes('http'), '占位里不该出现下载链接')
  assert.ok(!flat.text.includes('file_id'), '占位里不该出现 file_id')
  // 下载需要的元数据单独放 flat.files（task-6），正文/占位保持干净
  assert.deepEqual(flat.files, [{
    file_id: 'abc',
    file_name: '合同.docx',
    file_size: 999,
    busid: undefined,
    url: 'http://192.168.1.9:3000/get_file?file_id=abc',
  }])
})

test('flattenMessage：多个文件段都收集，字段齐全（file_id/file_name/file_size/busid）', () => {
  const flat = flattenMessage([
    { type: 'file', data: { file_id: 'g1', file: 'a.pdf', file_size: '123', busid: 102 } },
    { type: 'file', data: { file_id: 'g2', name: 'b.pptx', size: 456, busid: 102 } },
    { type: 'text', data: { text: '两个都看看' } },
  ])
  assert.equal(flat.files.length, 2)
  assert.deepEqual(flat.files[0], {
    file_id: 'g1', file_name: 'a.pdf', file_size: 123, busid: 102, url: '',
  })
  assert.deepEqual(flat.files[1], {
    file_id: 'g2', file_name: 'b.pptx', file_size: 456, busid: 102, url: '',
  })
  // 文字消息没有文件段 → files 为空数组（不是 undefined）
  assert.deepEqual(flattenMessage([{ type: 'text', data: { text: 'hi' } }]).files, [])
})

// ── ② 不再被「空消息判定」丢掉 ──────────────────────────────────────────────
// handleInbound 里是 `if (!flat.text && imagePaths.length === 0 && !hasForward && !hasCard) return`
// 带文件的消息以前 text='' → 被丢掉。占位并进 text 后，这个条件不再成立。
test('只发一个文件：text 非空 → 不会被「空消息，忽略」丢掉', () => {
  const flat = flattenMessage([{ type: 'file', data: { name: 'a.pdf', size: 1 } }])
  assert.ok(flat.text.length > 0, 'text 必须非空（空消息判定的第一道条件）')
  assert.equal(flat.images.length, 0)
  assert.equal(flat.cards.length, 0)
})

test('只发一条语音：text 非空 → 不会被丢掉', () => {
  const flat = flattenMessage([{ type: 'record', data: { duration: 8 } }])
  assert.equal(flat.text, '[语音] 8s')
})

// ── ③ 现有行为不能变 ────────────────────────────────────────────────────────
test('文字 + 图片 + 引用：和以前一样（占位为空）', () => {
  const flat = flattenMessage([
    { type: 'text', data: { text: '看图' } },
    { type: 'image', data: { url: 'http://example.com/a.jpg' } },
    { type: 'reply', data: { id: '42' } },
  ])
  assert.equal(flat.text, '看图')
  assert.deepEqual(flat.placeholders, [])
  assert.equal(flat.images.length, 1)
  assert.equal(flat.replyId, '42')
})

test('回复了机器人的消息 = replyToMe（老行为不变）', () => {
  const flat = flattenMessage([
    { type: 'reply', data: { id: '77' } },
    { type: 'text', data: { text: '你刚才说的不对' } },
  ])
  assert.equal(flat.replyToMe, true)
})

test('纯图片：text 为空、images 非空（走「用户只发了图片」那条老路）', () => {
  const flat = flattenMessage([{ type: 'image', data: { url: 'http://example.com/a.jpg' } }])
  assert.equal(flat.text, '')
  assert.equal(flat.images.length, 1)
  assert.deepEqual(flat.placeholders, [])
})

test('@ 别人 / @ 自己：atList / atMe 判定不变', () => {
  const other = flattenMessage([{ type: 'at', data: { qq: '123' } }, { type: 'text', data: { text: ' hi' } }])
  assert.deepEqual(other.atList, ['123'])
  assert.equal(other.atMe, false)
  assert.equal(other.text, 'hi')
  const self = flattenMessage([{ type: 'at', data: { qq: '999' } }])
  assert.equal(self.atMe, true)
  assert.equal(self.text, '')
})

test('合并转发：forwardIds 不变，占位为空', () => {
  const flat = flattenMessage([{ type: 'forward', data: { id: 'fid-1' } }])
  assert.deepEqual(flat.forwardIds, ['fid-1'])
  assert.equal(flat.text, '')
  assert.deepEqual(flat.placeholders, [])
})

test('卡片（json/xml）：仍进 cards，不产生「不支持类型」占位', () => {
  const flat = flattenMessage([{ type: 'json', data: { data: '{"prompt":"B站分享"}' } }])
  assert.equal(flat.cards.length, 1)
  assert.match(flat.text, /\[卡片\]/)
  assert.deepEqual(flat.placeholders, [])
  const x = flattenMessage([{ type: 'xml', data: { data: '<msg>hi</msg>' } }])
  assert.equal(x.cards.length, 1)
  assert.deepEqual(x.placeholders, [])
})

test('文字/文件/文字混排：占位按消息段顺序插入，不丢任何一段', () => {
  const flat = flattenMessage([
    { type: 'text', data: { text: '发你看一下 ' } },
    { type: 'file', data: { name: 'a.pdf', size: 2 } },
    { type: 'text', data: { text: ' 帮忙改改' } },
  ])
  assert.equal(flat.text, '发你看一下 [文件] a.pdf (2 B) 帮忙改改')
  assert.deepEqual(flat.placeholders, ['[文件] a.pdf (2 B)'])
})

test('多个非文字段：placeholders 全记录（上下文逐条列出）', () => {
  const flat = flattenMessage([
    { type: 'file', data: { name: 'a.pdf', size: 1 } },
    { type: 'record', data: { duration: 2 } },
    { type: 'video', data: {} },
  ])
  assert.deepEqual(flat.placeholders, ['[文件] a.pdf (1 B)', '[语音] 2s', '[视频]'])
  assert.equal(flat.text, '[文件] a.pdf (1 B)[语音] 2s[视频]')
})

// ── ④ 提示词必须说清「只能看到占位 / 文件另给路径」────────────────────────
// 这部分是 prompt 文案，没法在这里跑一轮真实 LLM，只能锁住源码里有这句话 ——
// 和 unit-time-context 的做法一致（防止有人删掉上下文还让单测全绿）。
// 2026-11-03（task-6）改成「文件会下载、但不解析内容」，所以断言也跟着改。
test('上下文必须明确告诉模型：只能看到占位描述、桥不解析文件内容', () => {
  assert.match(SRC, /你只能看到占位描述/, '缺「只能看到占位描述」这句，模型会假装看过文件')
  assert.match(SRC, /不解析文件内容/, '必须说明桥不解析内容（不是看过了）')
  assert.match(SRC, /【对方发来了文件】/, '下载成功的文件必须在上下文里给出【对方发来了文件】+ 本地路径')
  assert.match(SRC, /别假装看过文件内容/, '要明确禁止编造文件内容')
})

test('上下文注入只在真有占位时发生（纯文字消息不能多出这段）', () => {
  // 用 flat.placeholders 判定，而不是「有 segTypes」之类 —— 图片/文字/卡片都不该触发
  assert.match(SRC, /const nonTextPlaceholders = \[\.\.\.\(flat\.placeholders \?\? \[\]\)/)
  assert.match(SRC, /if \(nonTextPlaceholders\.length\) \{/)
})

test('忙时排队/合并轮也要把占位带过去（否则那条文件消息的说明会丢）', () => {
  // 入队时 text 里已经有占位，但「只能看到占位」这段上下文只认真实段；
  // 合并轮是虚拟 text 段，所以要把 placeholders 单独透传到 _mergedExtras。
  assert.match(SRC, /placeholders: flat\.placeholders \?\? \[\]/, '入队时没带 placeholders')
  assert.match(SRC, /placeholders: allPlaceholders/, '合并轮 _mergedExtras 没带 placeholders')
  // 已下载的文件路径同理：合并轮不能再下（链接可能过期），必须透传
  assert.match(SRC, /inboundFiles,/, '入队时没带 inboundFiles')
  assert.match(SRC, /inboundFiles: allInboundFiles/, '合并轮 _mergedExtras 没带 inboundFiles')
})
