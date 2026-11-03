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

// ── ② 正常下载：群文件（真机形状）──────────────────────────────────────────
// 真机 file 段（容器内 napcat.mjs 实际实现）：
//   { file: <文件名>, file_id: <fileUuid>, file_size: <number|string>, url?: <str> }
// 名字在 file（不是 file_name）；packet 后端可用时直接带 url。
test('群文件：真机 file 段（名字在 file、file_size 字符串、无 url）→ get_group_file_url → 下载', async () => {
  const gw = fakeGateway(async () => ({ url: 'https://example.com/files/report.pdf' }))
  const { messaging } = makeStack({ gateway: gw })
  const f = stubFetch(async url => {
    assert.equal(url, 'https://example.com/files/report.pdf')
    return okResponse('PDF-CONTENT', 'application/pdf')
  })
  try {
    const out = await messaging.downloadInboundFiles(
      { id: '2000000001', scope: 'group' },
      [{ segKeys: ['file', 'file_id', 'file_size'], file: '报告.pdf', file_id: 'uuid-1', file_size: '11' }],
    )
    assert.equal(out.length, 1)
    assert.equal(out[0].ok, true, `应下载成功：${JSON.stringify(out[0])}`)
    assert.ok(fs.existsSync(out[0].path), '文件没落盘')
    assert.equal(path.dirname(out[0].path), TMP, '文件必须落在暂存区')
    assert.equal(fs.readFileSync(out[0].path, 'utf8'), 'PDF-CONTENT', '内容不对')
    assert.match(path.basename(out[0].path), /报告\.pdf$/, '文件名没保留')
    // 真机 handler 只用 {group_id, file_id}：段里没有 busid 就**不能**传 busid: 0
    assert.equal(gw.calls[0].action, 'get_group_file_url')
    assert.deepEqual(gw.calls[0].params, { group_id: 2000000001, file_id: 'uuid-1' })
  } finally {
    f.restore()
  }
})

test('群文件：段里带了 busid 就透传（真机忽略它，但别当它必需）', async () => {
  const gw = fakeGateway(async () => ({ url: 'https://example.com/b.pdf' }))
  const { messaging } = makeStack({ gateway: gw })
  const f = stubFetch(async () => okResponse('B'))
  try {
    await messaging.downloadInboundFiles(
      { id: '2000000001', scope: 'group' },
      [{ file: 'b.pdf', file_id: 'fid-1', file_size: 1, busid: 102 }],
    )
    assert.deepEqual(gw.calls[0].params, { group_id: 2000000001, file_id: 'fid-1', busid: 102 })
  } finally {
    f.restore()
  }
})

test('段里直接带 url（真机 packet 后端）→ 不调任何接口，直接用段 url 下载', async () => {
  const gw = fakeGateway(async () => { throw new Error('段里有 url 时不该再调接口') })
  const { messaging, logs } = makeStack({ gateway: gw })
  const f = stubFetch(async url => {
    assert.equal(url, 'https://example.com/direct.pdf?rkey=abc')
    return okResponse('DIRECT', 'application/pdf')
  })
  try {
    const out = await messaging.downloadInboundFiles(
      { id: '10001', scope: 'c2c' },
      [{
        segKeys: ['file', 'file_id', 'file_size', 'url'],
        file: '直接.pdf', file_id: 'uuid-2', file_size: '6',
        url: 'https://example.com/direct.pdf?rkey=abc',
      }],
    )
    assert.equal(out[0].ok, true, `应直接用段 url：${JSON.stringify(out[0])}`)
    assert.equal(gw.calls.length, 0, '段里有 url 就不该调 gateway（省一次 API、少一个失败点）')
    assert.ok(logs.some(l => /via event/.test(l)), '日志要记下 url 来源，排查时才知道走的是哪条路')
  } finally {
    f.restore()
  }
})

// ── ③ 正常下载：私聊文件 ──────────────────────────────────────────────────
test('私聊文件：真机形状 → get_private_file_url（参数是 user_id，不是 group_id）', async () => {
  const gw = fakeGateway(async () => ({ url: 'https://example.com/a.zip' }))
  const { messaging } = makeStack({ gateway: gw })
  const f = stubFetch(async () => okResponse('ZIP', 'application/zip'))
  try {
    const out = await messaging.downloadInboundFiles(
      { id: '10001', scope: 'c2c' },
      [{ file: 'a.zip', file_id: 'fid-2', file_size: '3' }],
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
      [{ file: 'big.iso', file_id: 'big', file_size: '2048' }],
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
      [{ file: 'big.bin', file_id: 'big2' }],
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

test('取 url 接口失败 → get_file 兜底成功，并补上名字/大小（真机兜底返回形状）', async () => {
  const gw = fakeGateway(async action => {
    if (action === 'get_group_file_url') throw new Error('onebot get_group_file_url 失败: retcode=100')
    // 真机 get_file 返回 {file, url, file_size, file_name}
    return { file: 'fid-3', url: 'https://example.com/fallback.txt', file_size: '4', file_name: '兜底.txt' }
  })
  const { messaging, logs } = makeStack({ gateway: gw })
  const f = stubFetch(async () => okResponse('OK', 'text/plain'))
  try {
    const out = await messaging.downloadInboundFiles(
      { id: '2000000001', scope: 'group' },
      [{ segKeys: ['file_id', 'file_size'], file_id: 'fid-3', file_size: 0 }],
    )
    assert.equal(out[0].ok, true, `应兜底成功：${JSON.stringify(out[0])}`)
    assert.equal(out[0].name, '兜底.txt', '段里没名字时要用 get_file 返回的 file_name 补上')
    assert.deepEqual(gw.calls.map(c => c.action), ['get_group_file_url', 'get_file'])
    assert.deepEqual(gw.calls[1].params, { file: 'fid-3' })
    assert.ok(logs.some(l => /取 url 失败/.test(l)), '失败要留日志（否则线上没法排查）')
  } finally {
    f.restore()
  }
})

test('所有接口都失败 → 降级原因 + 日志带段字段名（不打印 url 全文）', async () => {
  const gw = fakeGateway(async () => { throw new Error('timeout') })
  const { messaging, logs } = makeStack({ gateway: gw })
  const f = stubFetch(async () => okResponse('x'))
  try {
    const out = await messaging.downloadInboundFiles(
      { id: '2000000001', scope: 'group' },
      [{ segKeys: ['file', 'file_id', 'file_size', 'url'], file: 'a.bin', file_id: 'fid-x', file_size: 1, url: '' }],
    )
    assert.equal(out[0].ok, false)
    assert.match(out[0].reason, /拿不到下载地址/)
    const shapeLine = logs.find(l => /段字段=\[file,file_id,file_size,url\]/.test(l))
    assert.ok(shapeLine, `失败日志必须带段形状，才能分清字段对不上还是网络问题：\n${logs.join('\n')}`)
    assert.ok(!/https?:\/\//.test(shapeLine), '日志里不该出现下载 URL')
    assert.equal(f.count(), 0, '连地址都没有就不该发下载请求')
  } finally {
    f.restore()
  }
})

test('下载失败：日志带段字段名，且不打印带 rkey 的 url 全文', async () => {
  const secret = 'https://example.com/x?rkey=SECRET-VALUE'
  const { messaging, logs } = makeStack()   // 段里直接给 url，不调 gateway
  const f = stubFetch(async () => { throw new Error('network down') })
  try {
    const out = await messaging.downloadInboundFiles(
      { id: '2000000001', scope: 'group' },
      [{ segKeys: ['file', 'file_id', 'file_size', 'url'], file: 'a.bin', file_id: 'fid-x', file_size: 1, url: secret }],
    )
    assert.equal(out[0].ok, false)
    assert.ok(logs.some(l => /段字段=\[file,file_id,file_size,url\]/.test(l)), '失败日志必须带段形状')
    assert.ok(!logs.some(l => l.includes('SECRET-VALUE')), '日志不能打印下载 URL（带 rkey 的凭证）')
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
    const files = Array.from({ length: 7 }, (_, i) => ({ file: `f${i}.bin`, file_id: `f${i}`, file_size: 1 }))
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
      [{ file: '../../../../tmp/evil.sh', file_id: 'f', file_size: '9' }],
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

test('index.js：群在线文件/文件夹 → 只占位、不走下载，上下文说明拿不到内容', () => {
  // 真机 onlinefile 段（群在线文件/文件夹）没有 url，进 files 只会白调一轮接口再失败
  assert.match(SRC, /seg\.type === 'onlinefile'/, 'flattenMessage 没接 onlinefile 段')
  assert.match(SRC, /const onlineFiles = \[\]/, '没有单独收集 onlinefile 元数据')
  assert.match(SRC, /onlineFiles\.push\(\{/, 'onlinefile 没进 onlineFiles')
  assert.match(SRC, /segKeys: Object\.keys\(d\)\.slice\(0, 12\)/, '文件段要记原始字段名，失败日志才看得出字段对不上')
  // 上下文：拿不到内容 + 让人怎么传
  assert.match(SRC, /【他发的是群在线文件\/文件夹，桥拿不到内容】/)
  assert.match(SRC, /没有下载地址/)
  assert.match(SRC, /私聊发给你/)
  assert.match(SRC, /截图/)
  // 忙时排队/合并轮透传（否则合并轮里这段说明会丢）
  assert.match(SRC, /onlineFiles: flat\.onlineFiles \?\? \[\]/, '入队时没带 onlineFiles')
  assert.match(SRC, /onlineFiles: allOnlineFiles/, '合并轮 _mergedExtras 没带 onlineFiles')
})
