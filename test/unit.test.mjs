// 桥单元测试：不依赖 QQ/NapCat/LLM，只测纯逻辑与路径守卫。
// 运行：node test/unit.test.mjs

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

let pass = 0
let fail = 0
function test(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`) }
  catch (err) { fail++; console.log(`  ✗ ${name}\n    ${err.message}`) }
}
async function testAsync(name, fn) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`) }
  catch (err) { fail++; console.log(`  ✗ ${name}\n    ${err.message}`) }
}

// ── 复制 bridge/index.js 里的纯函数（保持与实现同源，改动时两边都要动）──
// 这里直接 import 会让模块顶层就启动服务，所以用抽取的方式验证。
// 抽取方式：读源码求值不方便，故此处把逻辑以「同一份规则」重新实现，
// 并额外断言实现源码里确实存在这些规则关键字，防止漂移。
const indexSrc = fs.readFileSync(path.join(ROOT, 'bridge/index.js'), 'utf8')

console.log('\n=== 静态一致性（防规则漂移）===')
test('index.js 含 SEND_FILE 解析', () => assert.match(indexSrc, /SEND_FILE_RE/))
test('index.js 含敏感名单守卫', () => assert.match(indexSrc, /sensitive path segment/))
test('index.js 含 allowedRoots 双重限制', () => assert.match(indexSrc, /allowedRoots/))
test('index.js 含实路径校验（realpath）', () => assert.match(indexSrc, /realpathSync/))
test('index.js 含 base64 图片段', () => assert.match(indexSrc, /base64:\/\//))
test('index.js 含群 @ 判定', () => assert.match(indexSrc, /atMe/))
test('index.js 含自消息忽略', () => assert.match(indexSrc, /ignoreSelf/))

console.log('\n=== TTS 语音标记（源码级防漂移）===')
test('index.js 含 VOICE 标记解析', () => assert.match(indexSrc, /VOICE_RE/))
test('index.js 含音色映射表', () => assert.match(indexSrc, /lucy-voice-male1/))
test('index.js 含 send_group_ai_record 调用', () => assert.match(indexSrc, /send_group_ai_record/))
test('index.js 含本机 TTS 引擎（gsv）', () => assert.match(indexSrc, /127\.0\.0\.1:9880/))
test('index.js 含 piper 引擎回退', () => assert.match(indexSrc, /127\.0\.0\.1:5006/))
test('index.js 含 sherpa 引擎回退', () => assert.match(indexSrc, /127\.0\.0\.1:9881/))
test('index.js 含 record 段发送', () => assert.match(indexSrc, /type: 'record'/))
test('VOICE 正则支持中文音色名', () => {
  const m = /\[VOICE:\s*([^\]:]+?)(?::([^\]:\]]+?))?\s*\]/g
  const out = []
  '先说 [VOICE:你好:小新] 后说'.replace(m, (_a, t, ch) => { out.push([t, ch]); return '' })
  assert.deepEqual(out, [['你好', '小新']])
})
test('VOICE 正则支持长中文句子', () => {
  const m = /\[VOICE:\s*([^\]:]+?)(?::([^\]:\]]+?))?\s*\]/g
  const out = []
  '[VOICE:行吧就两句难听别笑]'.replace(m, (_a, t, ch) => { out.push([t, ch ?? null]); return '' })
  assert.deepEqual(out, [['行吧就两句难听别笑', null]])
})
test('VOICE 与 POKE/AT 可共存', () => {
  const vr = /\[VOICE:\s*([^\]:]+?)(?::([^\]:\]]+?))?\s*\]/g
  const ar = /\[AT:(\d+)\]/g
  let txt = '[AT:123] [VOICE:你好:小新] 结束'
  const voices = []
  txt = txt.replace(vr, (_a, t, ch) => { voices.push(t); return '' })
  const ats = []
  txt = txt.replace(ar, (_a, q) => { ats.push(q); return '' })
  assert.deepEqual(voices, ['你好']); assert.deepEqual(ats, ['123'])
})

console.log('\n=== SEND_FILE 解析 ===')
const SEND_FILE_RE = /\[SEND_FILE:\s*([^\]\n]+?)\s*\]/g
function extractSendFiles(text) {
  const files = []
  for (const m of text.matchAll(SEND_FILE_RE)) files.push(m[1].trim())
  return { files, text: text.replace(SEND_FILE_RE, '').trim() }
}

test('单条 SEND_FILE', () => {
  const r = extractSendFiles('图来了\n[SEND_FILE: /tmp/a.jpg]')
  assert.deepEqual(r.files, ['/tmp/a.jpg'])
  assert.equal(r.text, '图来了')
})
test('多条 SEND_FILE', () => {
  const r = extractSendFiles('[SEND_FILE: /a.png] 中间 [SEND_FILE: /b.png]')
  assert.deepEqual(r.files, ['/a.png', '/b.png'])
  assert.equal(r.text, '中间')
})
test('无 SEND_FILE 时不改动原文', () => {
  const r = extractSendFiles('纯文字 [表情: happy]')
  assert.deepEqual(r.files, [])
  assert.equal(r.text, '纯文字 [表情: happy]')
})
test('[表情: ...] 不会被误判成 SEND_FILE', () => {
  const r = extractSendFiles('[表情: 猫猫]')
  assert.deepEqual(r.files, [])
})
test('路径带空格', () => {
  const r = extractSendFiles('[SEND_FILE: /tmp/a b.jpg]')
  assert.deepEqual(r.files, ['/tmp/a b.jpg'])
})

console.log('\n=== 消息段拍平 ===')
function flattenMessage(message) {
  if (typeof message === 'string') return { text: message.trim(), images: [], replyId: null, atMe: false }
  if (!Array.isArray(message)) return { text: '', images: [], replyId: null, atMe: false }
  const texts = []; const images = []
  let replyId = null; let atMe = false
  const SELF = 3889000011
  for (const seg of message) {
    if (!seg || typeof seg !== 'object') continue
    const d = seg.data ?? {}
    if (seg.type === 'text') texts.push(String(d.text ?? ''))
    else if (seg.type === 'image') images.push(d)
    else if (seg.type === 'reply') replyId = String(d.id ?? '')
    else if (seg.type === 'at' && String(d.qq) === String(SELF)) atMe = true
  }
  return { text: texts.join('').trim(), images, replyId, atMe }
}

test('纯文本段', () => {
  const r = flattenMessage([{ type: 'text', data: { text: '你好' } }])
  assert.equal(r.text, '你好'); assert.equal(r.images.length, 0)
})
test('@ 自己 → atMe', () => {
  const r = flattenMessage([{ type: 'at', data: { qq: '3889000011' } }, { type: 'text', data: { text: ' hi' } }])
  assert.equal(r.atMe, true); assert.equal(r.text, 'hi')
})
test('@ 别人 → atMe false', () => {
  const r = flattenMessage([{ type: 'at', data: { qq: '999' } }, { type: 'text', data: { text: 'x' } }])
  assert.equal(r.atMe, false)
})
test('图片段被收集', () => {
  const r = flattenMessage([{ type: 'image', data: { url: 'https://x/1.jpg', file: '1.jpg' } }])
  assert.equal(r.images.length, 1); assert.equal(r.images[0].url, 'https://x/1.jpg')
})
test('reply 段', () => {
  const r = flattenMessage([{ type: 'reply', data: { id: '42' } }, { type: 'text', data: { text: 'q' } }])
  assert.equal(r.replyId, '42')
})
test('字符串消息格式', () => {
  const r = flattenMessage('  裸字符串  ')
  assert.equal(r.text, '裸字符串')
})
test('非法输入不崩', () => {
  assert.deepEqual(flattenMessage(null).text, '')
  assert.deepEqual(flattenMessage({}).text, '')
})

console.log('\n=== 敏感路径守卫（真实文件系统）===')
const STAGING = path.join(ROOT, '.qq-media')
const CWD = ROOT
fs.mkdirSync(STAGING, { recursive: true })
const SENSITIVE = ['.ssh', '.env', 'credentials', 'id_rsa', 'id_ed25519', '.credentials.yaml', '.credentials.json', 'secret', 'token']
const MAX_FILE = 10 * 1024 * 1024

function isPathAllowedForSend(p) {
  const abs = path.resolve(p)
  let real
  try { real = fs.realpathSync(abs) } catch { return { ok: false, reason: 'realpath failed' } }
  const allowedRoots = [STAGING, CWD].map(r => { try { return fs.realpathSync(r) } catch { return path.resolve(r) } })
  const inside = allowedRoots.some(root => real === root || real.startsWith(root + path.sep))
  if (!inside) return { ok: false, reason: `path outside allowed roots: ${real}` }
  const segs = real.split(path.sep).map(s => s.toLowerCase())
  for (const s of SENSITIVE) {
    if (segs.some(seg => seg === s || seg.includes(s))) return { ok: false, reason: `sensitive path segment: ${s}` }
  }
  try {
    const st = fs.statSync(real)
    if (!st.isFile()) return { ok: false, reason: 'not a regular file' }
    if (st.size > MAX_FILE) return { ok: false, reason: `file too large: ${st.size}` }
  } catch (e) { return { ok: false, reason: e.message } }
  return { ok: true, path: real }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llminqq-unit-'))
const goodFile = path.join(STAGING, 'unit-good.png')
fs.writeFileSync(goodFile, Buffer.from('89504e470d0a1a0a', 'hex'))
const outsideFile = path.join(tmpDir, 'outside.png')
fs.writeFileSync(outsideFile, Buffer.from('89504e470d0a1a0a', 'hex'))
const bigFile = path.join(STAGING, 'big.bin')
fs.writeFileSync(bigFile, Buffer.alloc(MAX_FILE + 1, 0))
const sensitiveFile = path.join(CWD, '.env')
fs.writeFileSync(sensitiveFile, 'SECRET=1')
const credFile = path.join(tmpDir, '.credentials.yaml')
fs.writeFileSync(credFile, 'x')
const cwdFile = path.join(CWD, 'README-unit-test.png')
fs.writeFileSync(cwdFile, Buffer.from('89504e470d0a1a0a', 'hex'))
const linkToSensitive = path.join(STAGING, 'link.env')
try { fs.symlinkSync(sensitiveFile, linkToSensitive) } catch { /* ignore */ }
const linkToOutside = path.join(STAGING, 'link-outside.png')
try { fs.symlinkSync(outsideFile, linkToOutside) } catch { /* ignore */ }

test('staging 内正常图片 → 放行', () => {
  const r = isPathAllowedForSend(goodFile)
  assert.equal(r.ok, true, r.reason)
})
test('cwd 内正常图片 → 放行', () => {
  const r = isPathAllowedForSend(cwdFile)
  assert.equal(r.ok, true, r.reason)
})
test('工作区外文件 → 拦', () => {
  const r = isPathAllowedForSend(outsideFile)
  assert.equal(r.ok, false)
  assert.match(r.reason, /outside allowed roots/)
})
test('a) 词法在盘内但软链指向工作区外 → 拦（realpath 生效）', () => {
  const r = isPathAllowedForSend(linkToOutside)
  assert.equal(r.ok, false, '软链逃逸未被拦')
})
test('b) 软链指向 .env → 拦', () => {
  const r = isPathAllowedForSend(linkToSensitive)
  assert.equal(r.ok, false, '.env 软链未被拦')
})
test('cwd 内 .env 文件 → 拦（敏感段）', () => {
  const r = isPathAllowedForSend(sensitiveFile)
  assert.equal(r.ok, false)
  assert.match(r.reason, /sensitive/)
})
test('库外 .credentials.yaml → 拦（先因越界）', () => {
  const r = isPathAllowedForSend(credFile)
  assert.equal(r.ok, false)
})
test('超大文件 → 拦', () => {
  const r = isPathAllowedForSend(bigFile)
  assert.equal(r.ok, false)
  assert.match(r.reason, /too large/)
})
test('不存在的路径 → 拦', () => {
  const r = isPathAllowedForSend(path.join(STAGING, 'nope.png'))
  assert.equal(r.ok, false)
})
test('目录而非文件 → 拦', () => {
  const r = isPathAllowedForSend(STAGING)
  assert.equal(r.ok, false)
})
test('相对路径按 cwd 解析', () => {
  const rel = path.relative(process.cwd(), goodFile)
  const r = isPathAllowedForSend(rel)
  // 只断言不崩且有明确结论
  assert.equal(typeof r.ok, 'boolean')
})

console.log('\n=== 分块与 peer 逻辑 ===')
function chunkText(text, max) {
  const out = []; let rest = text
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max)
    if (cut < max * 0.5) cut = max
    out.push(rest.slice(0, cut)); rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}
test('短文本不分块', () => assert.deepEqual(chunkText('abc', 10), ['abc']))
test('长文本分块且内容不丢', () => {
  const s = 'a'.repeat(25)
  const c = chunkText(s, 10)
  assert.ok(c.length >= 3)
  assert.equal(c.join(''), s)
})
test('优先在换行处切', () => {
  const s = 'aaaa\nbbbb\ncccc'
  const c = chunkText(s, 12)
  assert.ok(c[0].includes('\n') || c[0].length === 12)
})
test('空文本 → 空数组', () => assert.deepEqual(chunkText('', 10), []))

function peerOf(evt) {
  if (evt.message_type === 'group') return { id: String(evt.group_id), scope: 'group' }
  return { id: String(evt.user_id), scope: 'c2c' }
}
test('群消息 peer 用 group_id', () => {
  assert.deepEqual(peerOf({ message_type: 'group', group_id: 123, user_id: 9 }), { id: '123', scope: 'group' })
})
test('私聊 peer 用 user_id', () => {
  assert.deepEqual(peerOf({ message_type: 'private', user_id: 9 }), { id: '9', scope: 'c2c' })
})

console.log('\n=== cleanup ===')
fs.rmSync(tmpDir, { recursive: true, force: true })
for (const f of [goodFile, bigFile, sensitiveFile, cwdFile, linkToSensitive, linkToOutside]) {
  try { fs.rmSync(f, { force: true }) } catch { /* ignore */ }
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败 / 共 ${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
