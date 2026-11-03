// test/unit-inbound-files.test.mjs —— 入站文件真的下载下来给模型读（task-6）
//
// 背景（2026-11-03）：
//   task-4 修好后，对方发文件时机器人至少会回一句（[文件] 名字 (大小) 占位）。
//   但用户要的是「真的读文件」——所以这里把文件下载到暂存区，上下文给本机路径，
//   模型可以 read/read_image 看内容。
//
// 安全是重点（这也是测试的重点）：
//   · URL 是**群友可控**的（OneBot 响应/消息段），可能指向内网/元数据/file://
//     → 必须走 security 的 checkUrlSafe/safeFetchBuffer，不是裸 fetch；
//   · 文件名也是群友可控的，可能带 ../ 或绝对路径 → 必须净化，最终路径只能在暂存区；
//   · 超大小上限、下载失败、取 url 失败 → 全部降级成占位 + 原因，绝不能让整轮崩掉。
//
// 全部用**假 gateway + 假 fetch**：不连 NapCat、不连网络（NapCat 现在还是离线状态，
// 这也不该成为测试前提）。

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSecurity, sanitizeInboundFileName } from '../lib/bridge/security.js'
import { createMessaging } from '../lib/bridge/messaging.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SRC = fs.readFileSync(path.join(ROOT, 'lib', 'bridge', 'index.js'), 'utf8')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'llminqq-inbound-file-'))
after(() => fs.rmSync(TMP, { recursive: true, force: true }))

/** 组装一套「假 gateway + 真 security + 真 messaging」，日志收在数组里方便断言。 */
function makeStack ({ media = {}, gateway = null } = {}) {
  const config = {
    media: { stagingDir: TMP, ...media },
    tts: {}, onebot: {},
  }
  const security = createSecurity({ config, root: TMP })
  const logs = []
  const logger = { log: m => logs.push(String(m)), debug: () => {}, warn: () => {} }
  const gw = gateway ?? fakeGateway()
  const messaging = createMessaging({
    config, logger, gateway: gw, security,
    noteSelfSent: () => {}, sendTextTo: async () => {},
  })
  return { config, security, logger, gateway: gw, messaging, logs }
}

/** 假 gateway：记录每次 callData，返回值由 handler 决定（可以是抛错）。 */
function fakeGateway (handler = async () => ({ url: 'https://example.com/f.bin' })) {
  const calls = []
  return {
    calls,
    selfId: '999',
    async callData (action, params) {
      calls.push({ action, params })
      return handler(action, params, calls.length)
    },
  }
}

/** 假 fetch：只在测试体内替换 globalThis.fetch，结束必须 restore()。 */
function stubFetch (impl) {
  const orig = globalThis.fetch
  let count = 0
  globalThis.fetch = async (...args) => {
    count += 1
    return impl(...args, count)
  }
  return {
    count: () => count,
    restore: () => { globalThis.fetch = orig },
  }
}

const okResponse = (body = 'hello', contentType = 'application/pdf') => new Response(body, {
  status: 200,
  headers: { 'content-type': contentType },
})

// ── ① 文件名净化（纯函数，路径穿越的第一道防线）────────────────────────────
const nameCases = [
  ['../../etc/passwd', 'passwd', '相对路径穿越'],
  ['/etc/cron.d/evil', 'evil', '绝对路径'],
  ['C:\\Windows\\System32\\evil.exe', 'evil.exe', 'Windows 盘符路径'],
  ['..\\..\\boot.ini', 'boot.ini', '反斜杠穿越'],
  ['a\u0000b\n.jpg', 'ab.jpg', '控制字符'],
  ['.bashrc', 'bashrc', '隐藏文件的前导点'],
  ['..', 'file', '纯点点 → 回落到 file'],
  ['', 'file', '空名字 → 回落到 file'],
  ['a<b>c|d?.txt', 'a_b_c_d_.txt', '文件系统保留字符'],
  ['https://example.com/files/%E6%8A%A5%E5%91%8A.pdf?x=1', '报告.pdf', 'URL 形式只留文件名'],
  ['CON', 'file_CON', 'Windows 保留设备名'],
]
for (const [raw, want, why] of nameCases) {
  test(`sanitizeInboundFileName：${why}`, () => {
    assert.equal(sanitizeInboundFileName(raw), want)
  })
}

test('sanitizeInboundFileName：超长名字截断但保住后缀', () => {
  const name = 'x'.repeat(300) + '.pdf'
  const out = sanitizeInboundFileName(name)
  assert.ok(out.length <= 80, `截断后仍超长：${out.length}`)
  assert.ok(out.endsWith('.pdf'), `后缀没保住：${out}`)
})

test('sanitizeInboundFileName：结果永不含路径分隔符（这是路径穿越的硬边界）', () => {
  for (const [raw] of nameCases) {
    const out = sanitizeInboundFileName(raw)
    assert.ok(!/[/\\]/.test(out), `净化后仍含分隔符：${JSON.stringify(out)}`)
    assert.ok(out.length > 0, '净化后不能是空串')
  }
})

// ── ② 正常下载：群文件 ────────────────────────────────────────────────────
test('群文件：调 get_group_file_url → 下载 → 落暂存区，返回本机路径', async () => {
  const gw = fakeGateway(async () => ({ url: 'https://example.com/files/report.pdf' }))
  const { messaging } = makeStack({ gateway: gw })
  const f = stubFetch(async url => {
    assert.equal(url, 'https://example.com/files/report.pdf')
    return okResponse('PDF-CONTENT', 'application/pdf')
  })
  try {
    const out = await messaging.downloadInboundFiles(
      { id: '2000000001', scope: 'group' },
      [{ file_id: 'fid-1', file_name: '报告.pdf', file_size: 11, busid: 102 }],
    )
    assert.equal(out.length, 1)
    assert.equal(out[0].ok, true, `应下载成功：${JSON.stringify(out[0])}`)
    assert.ok(fs.existsSync(out[0].path), '文件没落盘')
    assert.equal(path.dirname(out[0].path), TMP, '文件必须落在暂存区')
    assert.equal(fs.readFileSync(out[0].path, 'utf8'), 'PDF-CONTENT', '内容不对')
    assert.match(path.basename(out[0].path), /报告\.pdf$/, '文件名没保留')
    // 群文件接口参数：group_id + file_id + busid（漏 busid 群文件会失败）
    assert.equal(gw.calls[0].action, 'get_group_file_url')
    assert.deepEqual(gw.calls[0].params, { group_id: 2000000001, file_id: 'fid-1', busid: 102 })
  } finally {
    f.restore()
  }
})

// ── ③ 正常下载：私聊文件 ──────────────────────────────────────────────────
test('私聊文件：调 get_private_file_url（参数是 user_id，不是 group_id）', async () => {
  const gw = fakeGateway(async () => ({ url: 'https://example.com/a.zip' }))
  const { messaging } = makeStack({ gateway: gw })
  const f = stubFetch(async () => okResponse('ZIP', 'application/zip'))
  try {
    const out = await messaging.downloadInboundFiles(
      { id: '10001', scope: 'c2c' },
      [{ file_id: 'fid-2', file_name: 'a.zip', file_size: 3 }],
    )
    assert.equal(out[0].ok, true)
    assert.equal(gw.calls[0].action, 'get_private_file_url')
    assert.deepEqual(gw.calls[0].params, { user_id: 10001, file_id: 'fid-2' })
  } finally {
    f.restore()
  }
})

// ── ④ 大小上限 ────────────────────────────────────────────────────────────
test('事件里给的大小超上限：不下载、返回原因、不调 gateway/fetch', async () => {
  const gw = fakeGateway()
  const { messaging } = makeStack({ gateway: gw, media: { maxInboundFileBytes: 1024 } })
  const f = stubFetch(async () => okResponse('x'))
  try {
    const out = await messaging.downloadInboundFiles(
      { id: '2000000001', scope: 'group' },
      [{ file_id: 'big', file_name: 'big.iso', file_size: 2048 }],
    )
    assert.equal(out[0].ok, false)
    assert.match(out[0].reason, /超过大小上限/)
    assert.equal(gw.calls.length, 0, '超限的文件不该再去要 url')
    assert.equal(f.count(), 0, '超限的文件不该下载')
  } finally {
    f.restore()
  }
})

test('事件没给大小但响应体超上限：边读边计数挡住，降级为原因', async () => {
  const { messaging } = makeStack({
    gateway: fakeGateway(async () => ({ url: 'https://example.com/big.bin' })),
    media: { maxInboundFileBytes: 16 },
  })
  const f = stubFetch(async () => okResponse('y'.repeat(100), 'application/octet-stream'))
  try {
    const out = await messaging.downloadInboundFiles(
      { id: '2000000001', scope: 'group' },
      [{ file_id: 'big2', file_name: 'big.bin' }],
    )
    assert.equal(out[0].ok, false)
    assert.match(out[0].reason, /文件过大/)
  } finally {
    f.restore()
  }
})

// ── ⑤ SSRF：内网 / file:// 必须被 security 拦下 ───────────────────────────
test('SSRF：OneBot 返回内网地址 → 拒绝下载（fetch 一次都不发）', async () => {
  const { messaging } = makeStack({
    gateway: fakeGateway(async () => ({ url: 'http://127.0.0.1:18080/api/send' })),
  })
  const f = stubFetch(async () => okResponse('secret'))
  try {
    const out = await messaging.downloadInboundFiles(
      { id: '2000000001', scope: 'group' },
      [{ file_id: 'f', file_name: 'a.pdf' }],
    )
    assert.equal(out[0].ok, false)
    assert.match(out[0].reason, /安全策略拒绝|私网/)
    assert.equal(f.count(), 0, '被安全策略拒绝的 URL 不能进 fetch')
  } finally {
    f.restore()
  }
})

test('SSRF：file:// 协议被拒绝（不能读本机文件）', async () => {
  const { messaging } = makeStack({
    gateway: fakeGateway(async () => ({ url: 'file:///etc/passwd' })),
  })
  const f = stubFetch(async () => okResponse('root:x:0:0'))
  try {
    const out = await messaging.downloadInboundFiles(
      { id: '10001', scope: 'c2c' },
      [{ file_id: 'f', file_name: 'passwd' }],
    )
    assert.equal(out[0].ok, false)
    assert.match(out[0].reason, /协议不允许/)
    assert.equal(f.count(), 0)
  } finally {
    f.restore()
  }
})

// ── ⑥ 失败降级：下载失败/取 url 失败都不能让整轮崩 ─────────────────────────
test('HTTP 500：不抛错，返回原因（占位文本由 flattenMessage 保留）', async () => {
  const { messaging } = makeStack({
    gateway: fakeGateway(async () => ({ url: 'https://example.com/500.bin' })),
  })
  const f = stubFetch(async () => new Response('oops', { status: 500 }))
  try {
    const out = await messaging.downloadInboundFiles(
      { id: '2000000001', scope: 'group' },
      [{ file_id: 'f', file_name: 'a.bin' }],
    )
    assert.equal(out[0].ok, false)
    assert.match(out[0].reason, /HTTP 500/)
  } finally {
    f.restore()
  }
})

test('取 url 的接口失败 → 回退用消息段里的 url', async () => {
  const gw = fakeGateway(async () => { throw new Error('onebot get_group_file_url 失败: retcode=100') })
  const { messaging, logs } = makeStack({ gateway: gw })
  const f = stubFetch(async () => okResponse('FALLBACK', 'text/plain'))
  try {
    const out = await messaging.downloadInboundFiles(
      { id: '2000000001', scope: 'group' },
      [{ file_id: 'f', file_name: 'a.txt', url: 'https://example.com/direct.txt' }],
    )
    assert.equal(out[0].ok, true, `应回退成功：${JSON.stringify(out[0])}`)
    assert.ok(logs.some(l => /取 url 失败/.test(l)), '失败要留日志（否则线上没法排查）')
  } finally {
    f.restore()
  }
})

test('既没有 file_id 也没有 url → 失败原因明确，不抛错', async () => {
  const { messaging } = makeStack()
  const out = await messaging.downloadInboundFiles(
    { id: '2000000001', scope: 'group' },
    [{ file_name: 'a.bin', file_size: 1 }],
  )
  assert.equal(out[0].ok, false)
  assert.match(out[0].reason, /拿不到下载地址/)
})

// ── ⑦ 条数上限 / 开关 ─────────────────────────────────────────────────────
test('单条消息最多处理 5 个文件，多出来的给原因', async () => {
  const gw = fakeGateway(async (_a, p) => ({ url: `https://example.com/${p.file_id}.bin` }))
  const { messaging } = makeStack({ gateway: gw })
  const f = stubFetch(async () => okResponse('x'))
  try {
    const files = Array.from({ length: 7 }, (_, i) => ({ file_id: `f${i}`, file_name: `f${i}.bin`, file_size: 1 }))
    const out = await messaging.downloadInboundFiles({ id: '2000000001', scope: 'group' }, files)
    assert.equal(out.filter(r => r.ok).length, 5, '只该下载 5 个')
    assert.equal(gw.calls.length, 5)
    const skipped = out.find(r => r.ok === false && /最多处理/.test(r.reason))
    assert.ok(skipped, '超出条数要有明确原因')
  } finally {
    f.restore()
  }
})

test('config.media.inboundFileEnabled=false → 整段关闭，什么都不做', async () => {
  const gw = fakeGateway()
  const { messaging } = makeStack({ gateway: gw, media: { inboundFileEnabled: false } })
  const out = await messaging.downloadInboundFiles({ id: '2000000001', scope: 'group' },
    [{ file_id: 'f', file_name: 'a.bin' }])
  assert.deepEqual(out, [])
  assert.equal(gw.calls.length, 0)
})

test('文件名穿越：落盘仍在暂存区，文件名已净化', async () => {
  const { messaging } = makeStack({
    gateway: fakeGateway(async () => ({ url: 'https://example.com/evil' })),
  })
  const f = stubFetch(async () => okResponse('#!/bin/sh', 'text/plain'))
  try {
    const out = await messaging.downloadInboundFiles(
      { id: '2000000001', scope: 'group' },
      [{ file_id: 'f', file_name: '../../../../tmp/evil.sh', file_size: 9 }],
    )
    assert.equal(out[0].ok, true)
    assert.equal(path.dirname(out[0].path), TMP, '路径穿越了！')
    assert.ok(!path.basename(out[0].path).includes('..'), '文件名没净化')
    assert.match(path.basename(out[0].path), /evil\.sh$/)
  } finally {
    f.restore()
  }
})

// ── ⑧ index.js 接线（下载时机 + 上下文注入）──────────────────────────────
test('index.js：先下载、再判空、再进 LLM（下载失败不能丢消息）', () => {
  assert.match(SRC, /const inboundFiles = flat\.files\?\.length \? await downloadInboundFiles\(peer, flat\.files\) : \[\]/,
    'handleInbound 里没接 downloadInboundFiles')
  const iDownload = SRC.indexOf('await downloadInboundFiles(peer, flat.files)')
  // 注意：flattenMessage 的注释里也出现过「空消息，忽略」，这里只找真正的日志行
  const iEmpty = SRC.indexOf('logger.log(`空消息，忽略')
  assert.ok(iDownload > 0 && iEmpty > iDownload, '下载必须发生在空消息判定之前')
})

test('index.js：上下文注入【对方发来了文件】+ 本机路径 + 阅读叮嘱', () => {
  assert.match(SRC, /【对方发来了文件】/)
  assert.match(SRC, /本机路径：\$\{f\.path\}/)
  assert.match(SRC, /文件下载失败：/, '失败原因必须进上下文')
  assert.match(SRC, /read_image/)
  assert.match(SRC, /不要把文件内容原样贴出去/)
})
