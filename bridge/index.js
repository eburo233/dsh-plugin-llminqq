// OneBot 11 ↔ DSH(LLM) 桥接守护进程。
//
// 职责：
//   入站  QQ 消息（私聊/群聊 @）→ 拍平文本 + 下载图片 → 喂给 DSH 持久会话
//   出站  DSH 助手文本 → 发回 QQ；[SEND_FILE: path] → 上传真图发到 QQ
//
// 不做的事：不改现有项目、不碰 dsh-bridge 插件、不用官方 Bot API。

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { OneBotGateway } from './onebot.js'
import { DshRuntime } from './dsh.js'
import { AcpRuntime } from './acp.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const cfgPath = process.env.LLMINQQ_CONFIG ?? path.join(__dirname, 'config.json')
const config = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))

// ── 日志 ─────────────────────────────────────────────────────────────────────
const logFile = config.log?.file ?? path.join(ROOT, 'logs', 'bridge.log')
fs.mkdirSync(path.dirname(logFile), { recursive: true })
const logStream = fs.createWriteStream(logFile, { flags: 'a' })
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }
const minLevel = LEVELS[config.log?.level ?? 'info'] ?? 20

function log(msg, meta) {
  const line = `${new Date().toISOString()} ${msg}${meta ? ' ' + JSON.stringify(meta) : ''}`
  if ((LEVELS[msg.startsWith('debug') ? 'debug' : 'info'] ?? 20) >= minLevel) {
    console.log(line)
  }
  logStream.write(line + '\n')
}
const logger = { log, info: log, debug: m => log(`debug ${m}`), warn: m => log(`WARN ${m}`), error: m => log(`ERROR ${m}`) }

// ── 敏感路径名单（出站文件拦截）─────────────────────────────────────────────
const SENSITIVE = (config.media?.sensitiveNames ?? []).map(s => s.toLowerCase())
const STAGING_DIR = config.media?.stagingDir ?? path.join(ROOT, '.qq-media')
const MAX_FILE = config.media?.maxFileBytes ?? 10 * 1024 * 1024
fs.mkdirSync(STAGING_DIR, { recursive: true })

// ── 人设文件 ────────────────────────────────────────────────────────────────
// 人设与工程约定分离：persona/persona.md 是「你是谁」，有性格；AGENTS.md 是「通道怎么用」，无性格。
//
// 注入策略（重要，直接决定上下文消耗速度）：
//   人设全文**只在「开始新对话」或「人设文件变了」时注入一次**，之后每轮只给一句
//   「人设未变化，见文件路径」。原因：把人设 7.2 KB 每轮都塞进 user message，
//   它会作为**普通对话历史**留存并被后续每一轮重复计费（≈3600 tokens/轮），
//   几百轮就把 1M 上下文吃掉，还会让 compaction 频繁触发。
//   文件一改（agent 自改人设后），下一轮自动重新注入一次全文，改动依然即时生效。
const PERSONA_PATH = path.resolve(
  config.persona?.path ?? path.join(config.dsh.cwd, 'persona', 'persona.md'),
)
const PERSONA_MAX_BYTES = config.persona?.maxBytes ?? 32768

/** 读取人设文件；超过预算则从尾部截断并明确告知。失败返回 null。 */
function readPersona() {
  try {
    const st = fs.statSync(PERSONA_PATH)
    if (!st.isFile()) return { text: null, hash: null }
    let raw = fs.readFileSync(PERSONA_PATH, 'utf8')
    const hash = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16)
    if (Buffer.byteLength(raw) > PERSONA_MAX_BYTES) {
      raw = raw.slice(0, PERSONA_MAX_BYTES)
      const cut = raw.lastIndexOf('\n')
      if (cut > 0) raw = raw.slice(0, cut)
      raw += '\n\n<!-- 注：本文件超过桥的注入预算，后续内容未加载 -->'
      logger.log(`WARN 人设文件超过 ${PERSONA_MAX_BYTES} 字节，已截断注入`)
    }
    return { text: raw.trim() || null, hash }
  } catch (err) {
    if (err.code !== 'ENOENT') logger.log(`WARN 读取人设文件失败: ${err.message}`)
    return { text: null, hash: null }
  }
}

/** 出站文件是否允许发送：必须在 staging 或 cwd 内，且不含敏感段。 */
function isPathAllowedForSend(p) {
  if (!config.media?.enabled) return false
  const abs = path.resolve(p)
  let real
  try { real = fs.realpathSync(abs) } catch { return false }
  const allowedRoots = [STAGING_DIR, config.dsh.cwd].map(r => { try { return fs.realpathSync(r) } catch { return path.resolve(r) } })
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

// ── SEND_FILE 指令解析 ──────────────────────────────────────────────────────
const SEND_FILE_RE = /\[SEND_FILE:\s*([^\]\n]+?)\s*\]/g

// 模型可以输出这些控制标记，桥负责转成真正的 OneBot 动作：
//   [AT:123456]            → 真 @（会弹出提醒）
//   [POKE:123456]          → 群内戳一戳（拍一拍）
//   [POKE:123456:c2c]      → 私聊戳一戳
// 标记本身会从正文里剥掉，群友看不到。
const AT_RE = /\[AT:(\d+)\]/g
const POKE_RE = /\[POKE:(\d+)(?::(c2c|group))?\]/g

// 语音（TTS）：模型输出 [VOICE:要说的文字] 或 [VOICE:文字:音色id]
// 桥调 QQ 内置 AI 音色把文字合成语音，以 record 消息发出去。
// 只支持群聊（NapCat 的 send_group_ai_record 仅群）；私聊自动降级为普通文字。
// 「补一句」：主消息发完后隔一会儿再补一条（真人说漏了又补 / 想起来补充）
const FOLLOW_RE = /\[FOLLOW:\s*([^\]]+?)\s*\]/g
const VOICE_RE = /\[VOICE:\s*([^\]:]+?)(?::([^\]:\]]+?))?\s*\]/g
const VOICE_MAX_CHARS = 120        // AI 语音单条上限（太长会被截断/拒绝）
const DEFAULT_AUDIO_CHARACTER = 'lucy-voice-male1' // 憨憨小弟，与「白嫖吉祥物」自嘲定位最搭
const VOICE_CHARACTERS = {
  '小新': 'lucy-voice-laibixiaoxin', '猴哥': 'lucy-voice-houge', '四郎': 'lucy-voice-silang',
  '东北老妹儿': 'lucy-voice-guangdong-f1', '广西大表哥': 'lucy-voice-guangxi-m1',
  '妲己': 'lucy-voice-daji', '霸道总裁': 'lucy-voice-lizeyan', '酥心御姐': 'lucy-voice-suxinjiejie',
  '说书先生': 'lucy-voice-m8', '憨憨小弟': 'lucy-voice-male1', '憨厚老哥': 'lucy-voice-male3',
  '吕布': 'lucy-voice-lvbu', '元气少女': 'lucy-voice-xueling', '文艺少女': 'lucy-voice-f37',
  '磁性大叔': 'lucy-voice-male2', '邻家小妹': 'lucy-voice-female1', '低沉男声': 'lucy-voice-m14',
  '傲娇少女': 'lucy-voice-f38', '爹系男友': 'lucy-voice-m101', '暖心姐姐': 'lucy-voice-female2',
  '温柔妹妹': 'lucy-voice-f36', '书香少女': 'lucy-voice-f34',
}

/** 把音色「昵称或id」解析成 NapCat 要的 character_id。 */
function resolveVoiceCharacter(name) {
  if (!name) return config.tts?.character ?? DEFAULT_AUDIO_CHARACTER
  if (VOICE_CHARACTERS[name]) return VOICE_CHARACTERS[name]
  if (/^lucy-voice-[a-z0-9\-]+$/.test(name)) return name
  return config.tts?.character ?? DEFAULT_AUDIO_CHARACTER
}

/**
 * 用**本机部署的 TTS 引擎**合成语音，并把音频文件发成 QQ 语音消息。
 * 引擎优先级（config.tts.engine）：
 *   gsv      GPT-SoVITS  (POST http://127.0.0.1:9880/)  —— 支持参考音频音色克隆
 *   piper    PiperTTS    (POST http://127.0.0.1:5006/synthesize)
 *   sherpa   sherpa-onnx (POST http://127.0.0.1:9881/synthesize)
 *   qq       QQ 内置 AI 音色（send_group_ai_record，仅群聊，作最后兜底）
 */
async function synthesizeToFile(text, opts = {}) {
  const tts = config.tts ?? {}
  const engine = opts.engine || tts.engine || 'gsv'
  const outPath = path.join(STAGING_DIR, `tts_${Date.now()}_${crypto.randomBytes(3).toString('hex')}.wav`)

  async function postJson(url, body, timeoutMs = 120000) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) throw new Error(`${url} HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 200) throw new Error(`${url} 返回过小 (${buf.length}B)`)
    fs.writeFileSync(outPath, buf)
    return outPath
  }

  if (engine === 'gsv') {
    const g = tts.gsv ?? {}
    // GPT-SoVITS 直接返回 wav 二进制
    return await postJson(g.url ?? 'http://127.0.0.1:9880/', {
      text,
      text_language: g.textLanguage ?? 'zh',
      refer_wav_path: g.referWav ?? null,
      prompt_text: g.promptText ?? null,
      prompt_language: g.promptLanguage ?? 'zh',
      speed: g.speed ?? 1.0,
      temperature: g.temperature ?? 1.0,
      top_k: g.topK ?? 15,
      top_p: g.topP ?? 1.0,
    }, g.timeoutMs ?? 120000)
  }
  if (engine === 'piper') {
    const p2 = tts.piper ?? {}
    return await postJson(p2.url ?? 'http://127.0.0.1:5006/synthesize', {
      text,
      voice: p2.voice ?? 'zh_CN-huayan-medium',
    }, p2.timeoutMs ?? 60000)
  }
  if (engine === 'sherpa') {
    const sh = tts.sherpa ?? {}
    // sherpa 只支持 GET + query 参数
    const base = sh.url ?? 'http://127.0.0.1:9881/synthesize'
    const q = new URLSearchParams({
      text,
      engine: sh.engineId ?? 'vits',
      sid: String(sh.sid ?? 0),
      lang: sh.lang ?? 'zh',
    })
    const res = await fetch(`${base}?${q}`, { signal: AbortSignal.timeout(sh.timeoutMs ?? 60000) })
    if (!res.ok) throw new Error(`sherpa HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 200) throw new Error(`sherpa 返回过小 (${buf.length}B)`)
    fs.writeFileSync(outPath, buf)
    return outPath
  }
  throw new Error(`unknown tts engine: ${engine}`)
}

/** 把本地音频文件当 record 消息发出去（群/私聊都走 send_msg）。 */
async function sendRecordFile(peer, filePath) {
  const b64 = fs.readFileSync(filePath).toString('base64')
  const params = peer.scope === 'group'
    ? { group_id: Number(peer.id), message: [{ type: 'record', data: { file: `base64://${b64}` } }] }
    : { user_id: Number(peer.id), message: [{ type: 'record', data: { file: `base64://${b64}` } }] }
  const res = await gateway.callData(peer.scope === 'group' ? 'send_group_msg' : 'send_private_msg', params, 120000)
  if (res?.message_id != null) {
    selfMessageIds.add(String(res.message_id))
    if (selfMessageIds.size > 500) selfMessageIds.delete(selfMessageIds.values().next().value)
  }
  return res
}

/**
 * 发一条语音到对端：先本机 TTS 合成，再作为 record 消息发出。
 * 引擎失败时依次回退到其它本机引擎，最后才用 QQ 内置音色（仅群聊）。
 */
async function sendVoiceTo(peer, text, characterName) {
  if (config.tts?.enabled === false) return false
  const body = String(text || '').trim()
  if (!body) return false
  const maxChars = config.tts?.maxChars ?? 200
  const clipped = body.length > maxChars ? body.slice(0, maxChars) : body

  const engines = []
  const preferred = config.tts?.engine ?? 'gsv'
  engines.push({ kind: preferred })
  for (const e of ['gsv', 'piper', 'sherpa']) if (e !== preferred) engines.push({ kind: e })
  engines.push({ kind: 'qq' })

  for (const { kind } of engines) {
    try {
      if (kind === 'qq') {
        // QQ 内置音色只支持群聊
        if (peer.scope !== 'group') continue
        const character = resolveVoiceCharacter(characterName)
        await gateway.callData('send_group_ai_record', {
          group_id: Number(peer.id), character, text: clipped,
        }, 60000)
        logger.log(`已发语音(QQ内置) ${clipped.length}字 音色=${character} -> group:${peer.id}`)
        return true
      }
      const t0 = Date.now()
      const file = await synthesizeToFile(clipped, { engine: kind })
      const ms = Date.now() - t0
      await sendRecordFile(peer, file)
      logger.log(`已发语音(${kind}) ${clipped.length}字 ${(fs.statSync(file).size / 1024).toFixed(0)}KB 合成${ms}ms -> ${peer.scope}:${peer.id}`)
      // 清理临时音频（失败也不影响主流程）
      try { fs.unlinkSync(file) } catch { /* ignore */ }
      return true
    } catch (err) {
      logger.log(`TTS(${kind}) 失败: ${err.message.slice(0, 140)}；尝试下一个引擎`)
    }
  }
  logger.log(`所有 TTS 引擎都失败，降级为文字`)
  try { await sendTextTo(peer, clipped) } catch { /* ignore */ }
  return false
}
function extractSendFiles(text) {
  const files = []
  for (const m of text.matchAll(SEND_FILE_RE)) files.push(m[1].trim())
  const stripped = text.replace(SEND_FILE_RE, '').trim()
  return { files, text: stripped }
}

// ── 媒体暂存（入站图片）─────────────────────────────────────────────────────
function extFor(contentType) {
  if (!contentType) return '.jpg'
  if (contentType.includes('png')) return '.png'
  if (contentType.includes('webp')) return '.webp'
  if (contentType.includes('gif')) return '.gif'
  if (contentType.includes('jpeg') || contentType.includes('jpg')) return '.jpg'
  return '.bin'
}

// ── URL 安全守卫（防 SSRF / 链接投毒）────────────────────────────────────────
// 威胁：入站图片 url、卡片里的链接都来自**别人**。如果直接 fetch，攻击者可以让我们
//   1) 打内网：http://127.0.0.1:18080/send（我们自己的 API）、192.168.x、169.254.169.254（云元数据）
//   2) 打 file:// 之类协议
//   3) 用超长/重定向把我们拖住
// 做法：协议白名单 + 主机黑名单（私网/环回/链路本地）+ 禁止带凭据 + 限制大小/超时。
const URL_SAFE = {
  protocols: ['http:', 'https:'],
  // 明确禁止访问的主机/网段（用前缀和正则双保险）
  blockedHosts: [
    'localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback',
    'metadata.google.internal', 'metadata',
  ],
  blockedCidrs: [
    /^127\./,                    // 环回
    /^10\./,                     // 私网 A
    /^192\.168\./,               // 私网 C
    /^172\.(1[6-9]|2\d|3[01])\./, // 私网 B
    /^169\.254\./,               // 链路本地 / 云元数据
    /^0\./,                      // 0.x
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT
  ],
  maxRedirects: 2,
}

/** 这个 URL 能不能安全地由桥主动 fetch？返回 {ok, reason} */
function checkUrlSafe(rawUrl) {
  if (config.security?.allowPrivateUrls === true) return { ok: true } // 显式放开（自建场景）
  let u
  try { u = new URL(String(rawUrl)) } catch { return { ok: false, reason: 'URL 解析失败' } }

  if (!URL_SAFE.protocols.includes(u.protocol)) {
    return { ok: false, reason: `协议不允许: ${u.protocol}` }
  }
  // 禁止 URL 里带账号密码
  if (u.username || u.password) return { ok: false, reason: 'URL 含凭据' }

  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host) return { ok: false, reason: 'URL 无主机名' }
  if (URL_SAFE.blockedHosts.includes(host)) return { ok: false, reason: `主机被禁: ${host}` }
  // 域名不以点开头/结尾，防止解析歧义
  if (host.startsWith('.') || host.endsWith('.')) return { ok: false, reason: `主机名可疑: ${host}` }

  // IPv4 字面量 → 网段检查
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    if (URL_SAFE.blockedCidrs.some(re => re.test(host))) {
      return { ok: false, reason: `私网地址被禁: ${host}` }
    }
  }
  // IPv6 字面量 → 只允许公网（拒绝 ::1 / fe80 / fc00 / fd00）
  if (host.includes(':')) {
    if (/^(::1|::|fe80:|fc00:|fd00:)/i.test(host)) return { ok: false, reason: `IPv6 私网被禁: ${host}` }
  }
  // 纯数字主机（如 2130706433 = 127.0.0.1 的十进制变形）
  if (/^\d+$/.test(host)) return { ok: false, reason: `数字形式主机: ${host}` }

  return { ok: true }
}

/**
 * 安全地下载一个 URL 到 staging。
 * - 先过 checkUrlSafe
 * - 手动跟重定向（每次重定向都重新检查，防止 302 到内网）
 * - 限制响应体大小，边读边计数，超了就中止
 */
async function safeFetchBuffer(rawUrl, { timeoutMs = 30000, maxBytes = MAX_FILE } = {}) {
  let current = String(rawUrl)
  let redirects = 0
  while (true) {
    const chk = checkUrlSafe(current)
    if (!chk.ok) throw new Error(`URL 被安全策略拒绝: ${chk.reason}`)

    const res = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'LLMinQQ/1.0 (+qq-bridge)' },
    })

    // 3xx：跟一次重定向，但每一跳都要重新检查
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (!loc) throw new Error(`重定向无 Location (HTTP ${res.status})`)
      redirects += 1
      if (redirects > URL_SAFE.maxRedirects) throw new Error('重定向次数过多')
      current = new URL(loc, current).toString()
      continue
    }

    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)

    // Content-Length 先粗筛
    const cl = Number(res.headers.get('content-length') ?? 0)
    if (cl && cl > maxBytes) throw new Error(`文件过大 ${cl} > ${maxBytes}`)

    // 边读边计数（防止 Content-Length 撒谎）
    const reader = res.body?.getReader?.()
    if (!reader) {
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length > maxBytes) throw new Error(`文件过大 ${buf.length} > ${maxBytes}`)
      return { buffer: buf, contentType: res.headers.get('content-type'), finalUrl: current }
    }
    const chunks = []
    let total = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > maxBytes) {
        try { await reader.cancel() } catch { /* ignore */ }
        throw new Error(`文件过大（已读 ${total} > ${maxBytes}）`)
      }
      chunks.push(Buffer.from(value))
    }
    return { buffer: Buffer.concat(chunks), contentType: res.headers.get('content-type'), finalUrl: current }
  }
}

// ── 卡片/转发等「他人可控文本」的净化 ───────────────────────────────────────
// 威胁：卡片标题、描述、链接、合并转发内容都是别人能随意构造的。
//   他们可以塞：
//     - 「忽略以上指令」这类提示注入
//     - 伪造成桥的控制标记：[SEND_FILE:...] [VOICE:...] [AT:...] [POKE:...] [SILENT]
//       ← 最危险：模型要是复述出来，桥会真的执行！
//     - 伪造成系统消息的排版（【系统】【硬约束】等）
// 做法：把控制标记和系统样式的括号**打散/转义**，让它们失去语义但不失真。
const SYS_MARKERS = ['【系统', '【硬约束', '【人设', '【你在旁听', '【你的人设', '【你的精力', '【这条消息是个分享卡片']

function sanitizeUntrustedText(text, { maxChars = 500 } = {}) {
  if (typeof text !== 'string' || !text) return ''
  let out = text
  // ① 拆掉桥自己的控制标记，防止被复述后执行
  out = out.replace(/\[SEND_FILE\s*:/gi, '[SEND_FILE：')   // 全角冒号 → 正则不匹配
  out = out.replace(/\[VOICE\s*:/gi, '[VOICE：')
  out = out.replace(/\[POKE\s*:/gi, '[POKE：')
  out = out.replace(/\[AT\s*:/gi, '[AT：')
  out = out.replace(/\[SILENT\]/gi, '[SILENT_]')
  // ② 把可能冒充系统提示的粗方括号标题换成普通写法
  for (const m of SYS_MARKERS) {
    out = out.split(m).join(m.replace('【', '\u3010\u200b')) // 插入零宽字符，语义断开
  }
  // ③ 去掉换行里的强制指令式开头（常见注入模式）
  out = out.replace(/^\s*(忽略|无视|忘记).{0,10}(指令|设定|规则|prompt)/gim, '[过滤]')
  // ④ 长度与换行收敛
  out = out.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim()
  if (out.length > maxChars) out = out.slice(0, maxChars) + '…'
  return out
}

async function downloadUrlToStaging(url, tag = 'in') {
  const { buffer, contentType } = await safeFetchBuffer(url, { maxBytes: MAX_FILE })
  const ext = extFor(contentType)
  const name = `qq_${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`
  const dst = path.join(STAGING_DIR, name)
  fs.writeFileSync(dst, buffer)
  return dst
}

// ── OneBot 消息段处理 ───────────────────────────────────────────────────────
// 记录机器人自己发出的消息 id，用于识别「别人回复了我」也算被 @
const selfMessageIds = new Set()

function flattenMessage(message) {
  if (typeof message === 'string') return { text: message.trim(), images: [], replyId: null, atMe: false, replyToMe: false, atList: [], forwardIds: [] }
  if (!Array.isArray(message)) return { text: '', images: [], replyId: null, atMe: false, replyToMe: false, atList: [], forwardIds: [] }
  const texts = []
  const images = []
  const atList = [] // 本条消息 @ 了哪些 QQ 号（含别人，供模型理解对话对象）
  const forwardIds = [] // 合并转发的 forward_id
  const cards = [] // 解析出来的卡片文本（便于日志/上下文单独提示）
  let replyId = null
  let atMe = false
  for (const seg of message) {
    if (!seg || typeof seg !== 'object') continue
    const d = seg.data ?? {}
    if (seg.type === 'text') texts.push(String(d.text ?? ''))
    else if (seg.type === 'image') images.push(d)
    else if (seg.type === 'reply') {
      replyId = String(d.id ?? '')
    } else if (seg.type === 'forward') {
      // 合并转发：data.id 是 forward_id（NapCat/LLOneBot），也可能叫 res_id
      const fid = d.id || d.res_id || d.forward_id
      if (fid) forwardIds.push(String(fid))
    } else if (seg.type === 'json') {
      // 卡片（小程序/分享/音乐/图文）：尽量挖出可读文字，别再丢成空消息
      const cardText = cardJsonToText(seg)
      texts.push(cardText)
      cards.push(cardText)
    } else if (seg.type === 'xml') {
      const cardText = xmlToText(d.data ?? d)
      texts.push(cardText)
      cards.push(cardText)
    } else if (seg.type === 'at') {
      const qq = String(d.qq ?? '')
      if (qq && qq !== 'all') atList.push(qq)
      if (qq === String(gateway.selfId)) atMe = true
    } else if (seg.type === 'face') texts.push('')
  }
  // reply 引用的如果是机器人自己发的消息，等价于在跟我说话
  const replyToMe = !!replyId && selfMessageIds.has(replyId)
  return { text: texts.join('').trim(), images, replyId, atMe, replyToMe, atList, forwardIds, cards }
}

// ── 平台状态 ────────────────────────────────────────────────────────────────
const gateway = new OneBotGateway({
  wsUrl: config.onebot.wsUrl,
  token: config.onebot.token,
  reconnectMs: config.onebot.reconnectMs ?? 3000,
  heartbeatTimeoutMs: config.onebot.heartbeatTimeoutMs ?? 90000,
  log: m => logger.log(m),
})

// 协议选择：acp（默认，支持挂 MCP）/ sdk（旧方案，不支持 MCP）
const PROTOCOL = config.dsh.protocol ?? 'acp'
const MCP_SERVERS = (config.mcpServers ?? []).map(srv => ({
  name: srv.name,
  command: srv.command,
  args: srv.args ?? [],
  env: Object.entries(srv.env ?? {}).map(([name, value]) => ({ name, value: String(value) })),
}))

const dsh = PROTOCOL === 'sdk'
  ? new DshRuntime({
      bin: config.dsh.bin,
      profile: config.dsh.profile,
      cwd: config.dsh.cwd,
      provider: config.dsh.provider,
      model: config.dsh.model,
      reasoningEffort: config.dsh.reasoningEffort,
      startTimeoutMs: config.dsh.startTimeoutMs,
      turnTimeoutMs: config.dsh.turnTimeoutMs,
      log: m => logger.log(m),
    })
  : new AcpRuntime({
      bin: config.dsh.bin,
      profile: config.dsh.profile,
      cwd: config.dsh.cwd,
      provider: config.dsh.provider,
      model: config.dsh.model,
      reasoningEffort: config.dsh.reasoningEffort,
      mcpServers: MCP_SERVERS,
      startTimeoutMs: config.dsh.startTimeoutMs,
      turnTimeoutMs: config.dsh.turnTimeoutMs,
      log: m => logger.log(m),
    })

// （ACP 会话映射在 state 定义之后接线，见下方）
logger.log(`bridge 使用协议: ${PROTOCOL}${PROTOCOL === 'acp' ? `（mcpServers=${MCP_SERVERS.length}）` : '（不支持 MCP）'}`)

// peer -> sessionId，持久化到 state.json，重启后能续同一个会话
const STATE_DIR = process.env.LLMINQQ_STATE_DIR ? path.resolve(process.env.LLMINQQ_STATE_DIR) : path.join(ROOT, 'logs')
fs.mkdirSync(STATE_DIR, { recursive: true })
const statePath = path.join(STATE_DIR, 'state.json')
let state = { peers: {} }
try {
  state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  if (!state.peers) state.peers = {}
} catch { /* 首次运行 */ }

let saveTimer = null
function saveState() {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2))
  }, 500)
}

// ACP 会话是服务端生成的、可 resume 的持久会话。桥自己维护 peerKey -> acpSessionId，
// 落进 state.json 的 peers[key].acpSessionId，重启后用 session/resume 接上（保住上下文）。
if (dsh instanceof AcpRuntime) {
  dsh._remembered = new Map(
    Object.entries(state.peers)
      .filter(([, v]) => v?.acpSessionId)
      .map(([k, v]) => [k, v.acpSessionId]),
  )
  dsh.onSessionCreated = (peerKey, acpSessionId) => {
    if (!state.peers[peerKey]) {
      state.peers[peerKey] = { sessionId: `session-qq-${crypto.randomUUID()}`, createdAt: Date.now(), turns: 0 }
    }
    state.peers[peerKey].acpSessionId = acpSessionId
    saveState()
    logger.log(`acp 会话已记账 ${peerKey} -> ${acpSessionId}`)
  }
  if (dsh._remembered.size) logger.log(`acp: 从 state 恢复 ${dsh._remembered.size} 个会话映射`)
}

function sessionIdFor(peerKey) {
  if (!state.peers[peerKey]) {
    state.peers[peerKey] = { sessionId: `session-qq-${crypto.randomUUID()}`, createdAt: Date.now(), turns: 0 }
    saveState()
    logger.log(`新会话映射 ${peerKey} -> ${state.peers[peerKey].sessionId}`)
  }
  return state.peers[peerKey].sessionId
}

// ── 回复与发图 ──────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms))

function chunkText(text, max) {
  const out = []
  let rest = text
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max)
    if (cut < max * 0.5) cut = max
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest) out.push(rest)
  return out
}

/**
 * 把一段文本里内嵌的 [AT:qq] 标记转成消息段，实现「真 @」。
 * @returns {Array<{type:string,data:object}>}
 */
function textToSegments(text) {
  const segs = []
  let last = 0
  AT_RE.lastIndex = 0
  let m
  while ((m = AT_RE.exec(text)) !== null) {
    const before = text.slice(last, m.index)
    if (before) segs.push({ type: 'text', data: { text: before } })
    segs.push({ type: 'at', data: { qq: m[1] } })
    last = m.index + m[0].length
  }
  const tail = text.slice(last)
  if (tail) segs.push({ type: 'text', data: { text: tail } })
  if (!segs.length) segs.push({ type: 'text', data: { text: '' } })
  return segs
}

async function sendTextTo(peer, text) {
  if (!text) return
  const max = config.policy.maxReplyChars ?? 1500
  // 分块时按纯文本长度算，保留 [AT] 标记
  const chunks = chunkText(text, max)
  for (let i = 0; i < chunks.length; i++) {
    const segments = textToSegments(chunks[i]).filter(s => !(s.type === 'text' && !s.data.text))
    if (!segments.length) continue
    const params = peer.scope === 'group'
      ? { group_id: Number(peer.id), message: segments, auto_escape: false }
      : { user_id: Number(peer.id), message: segments, auto_escape: false }
    try {
      const res = await gateway.callData(peer.scope === 'group' ? 'send_group_msg' : 'send_private_msg', params, 20000)
      if (res?.message_id != null) {
        selfMessageIds.add(String(res.message_id))
        if (selfMessageIds.size > 500) selfMessageIds.delete(selfMessageIds.values().next().value)
      }
      const atCount = segments.filter(s => s.type === 'at').length
      if (atCount) logger.log(`已发送含 ${atCount} 个真 @ 的消息 -> ${peer.scope}:${peer.id}`)
    } catch (err) {
      logger.log(`发送文本失败 ${JSON.stringify(peer)}: ${err.message}`)
      return
    }
    if (i < chunks.length - 1) await sleep(config.policy.replyChunkDelayMs ?? 400)
  }
}

/** 执行戳一戳。群里用 send_poke，私聊用 friend_poke。 */
async function sendPokeTo(peer, targetQq, scopeOverride) {
  const scope = scopeOverride ?? peer.scope
  const qq = Number(targetQq)
  if (!Number.isFinite(qq)) return false
  try {
    if (scope === 'group') {
      await gateway.callData('send_poke', { group_id: Number(peer.id), user_id: qq }, 15000)
    } else {
      await gateway.callData('friend_poke', { user_id: qq }, 15000)
    }
    logger.log(`已戳一戳 ${qq} (${scope})`)
    return true
  } catch (err) {
    logger.log(`戳一戳失败 ${qq}: ${err.message}`)
    return false
  }
}

async function sendImageTo(peer, filePath) {
  if (!config.media?.enabled) {
    logger.log(`media 已禁用，跳过发图 ${filePath}`)
    return false
  }
  const check = isPathAllowedForSend(filePath)
  if (!check.ok) {
    logger.log(`BLOCKED SEND_FILE: ${filePath} — ${check.reason}`)
    return false
  }
  const b64 = fs.readFileSync(check.path).toString('base64')
  const seg = { type: 'image', data: { file: `base64://${b64}` } }
  const params = peer.scope === 'group'
    ? { group_id: Number(peer.id), message: [seg] }
    : { user_id: Number(peer.id), message: [seg] }
  try {
    const res = await gateway.callData(peer.scope === 'group' ? 'send_group_msg' : 'send_private_msg', params, 60000)
    if (res?.message_id != null) {
      selfMessageIds.add(String(res.message_id))
      if (selfMessageIds.size > 500) selfMessageIds.delete(selfMessageIds.values().next().value)
    }
    logger.log(`已发图 ${path.basename(check.path)} -> ${peer.scope}:${peer.id}`)
    return true
  } catch (err) {
    logger.log(`发图失败 ${filePath}: ${err.message}`)
    return false
  }
}

// ── 卡片消息解析 ────────────────────────────────────────────────────────────
// NapCat 把 QQ 的 Ark 卡片（小程序 / 分享链接 / 音乐 / 图文）统一转成
// OneBot 的 `{type:'json', data:{data:'<JSON字符串>'}}` 段（见 NapCat 源码
// `arkElement: async (e) => ({ type: ze.json, data: { data: e.bytesData } })`）。
//
// 这些卡片的 JSON 结构各不相同，但都有可读的标题/描述。这里按优先级挖：
//   prompt                      ← 最稳（NapCat 自己也在用）
//   meta.detail_1.title/desc    ← 小程序
//   meta.news.title/desc        ← 分享链接
//   meta.music.title/desc       ← 音乐
//   meta.detail.title/desc      ← 其它
//   app + 兜底                   ← 实在没有就说是什么类型
// 解析失败一律降级成「[卡片]」，绝不抛错、绝不让消息被当空消息丢掉。
const CARD_MAX_CHARS = 400

function cardJsonToText(seg) {
  const raw = seg?.data?.data ?? seg?.data ?? null
  let obj = raw
  if (typeof raw === 'string') {
    // 有的实现会把 JSON 塞在 "data" 里再套一层字符串
    let s = raw.trim()
    if (s.startsWith('{') || s.startsWith('[')) {
      try { obj = JSON.parse(s) } catch { obj = null }
    } else {
      obj = null
    }
  }
  if (!obj || typeof obj !== 'object') return '[卡片]'

  const pick = (...vals) => {
    for (const v of vals) {
      if (typeof v === 'string' && v.trim()) return v.trim()
    }
    return ''
  }
  const meta = obj.meta ?? {}
  const d1 = meta.detail_1 ?? {}
  const news = meta.news ?? {}
  const music = meta.music ?? {}
  const detail = meta.detail ?? {}

  // ⚠️ 卡片里的所有文字都是**别人构造的**，先净化再用
  const clean = (x) => sanitizeUntrustedText(x, { maxChars: 120 })
  const title = clean(pick(
    obj.prompt,
    d1.title, news.title, music.title, detail.title,
    obj.desc, obj.title,
  ))
  const desc = clean(pick(
    d1.desc, news.desc, music.desc, detail.desc,
    obj.prompt,
  ))
  const source = clean(pick(d1.tag, d1.source, news.tag, music.tag, detail.tag))
  // 链接：各类型卡片的字段名不同（NapCat 自己在解析群分享时用的就是 meta.news.jumpUrl）
  const url = pick(
    d1.qqdocurl, d1.url,
    news.jumpUrl, news.url,
    music.jumpUrl, music.url,
    detail.jumpUrl, detail.url,
    obj.jumpUrl, obj.url,
    obj.meta?.detail_1?.qqdocurl,
  )

  // 组合：标题（描述/来源）
  let out = title
  const extras = []
  if (desc && desc !== title) extras.push(desc)
  if (source && source !== title && !extras.includes(source)) extras.push(source)
  if (extras.length) out += `（${extras.join(' · ')}）`
  // 链接同样要过安全守卫：指向内网/非 http 的地址不往上下文里放
  if (url) {
    const chk = checkUrlSafe(url)
    if (chk.ok) out += ` ${url}`
    else logger.log(`卡片链接被安全策略拦截（不注入上下文）: ${chk.reason}`)
  }

  if (!out) {
    // 没抓到任何可读字段，至少告诉模型这是什么类型
    const app = pick(obj.app)
    const kind = app.includes('miniapp') ? '小程序'
      : app.includes('music') ? '音乐'
      : app.includes('structmsg') ? '分享'
      : app ? app : '链接'
    return `[${kind}卡片]`
  }
  return `[卡片] ${out}`.slice(0, CARD_MAX_CHARS)
}

// xml 卡片（老式富文本卡片）没有稳定结构，只做最小的轻量提取
function xmlToText(raw) {
  if (typeof raw !== 'string' || !raw) return '[卡片]'
  const m = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(raw)
  const d = /<summary[^>]*>([^<]{1,200})<\/summary>/i.exec(raw)
  const part = (m?.[1] || d?.[1] || '').trim()
  return part ? `[卡片] ${part}`.slice(0, CARD_MAX_CHARS) : '[卡片]'
}

// ── 合并转发展开 ────────────────────────────────────────────────────────────
// QQ 的「合并转发」在 OneBot 里是一个 {type:'forward', data:{id}} 段，
// 内容不在本条消息里，要再用 get_forward_msg 按 id 拉一次。
// 展开成「昵称: 内容」的多行文本，塞进模型上下文，它就能真正读到被转发的对话。
const FORWARD_MAX_MSGS = 80        // 单条转发最多展开多少楼
const FORWARD_MAX_CHARS = 12000    // 展开后总字数上限，防止撑爆上下文

function segToPlainText(segs) {
  if (!Array.isArray(segs)) return ''
  const out = []
  for (const seg of segs) {
    if (!seg || typeof seg !== 'object') continue
    const d = seg.data ?? {}
    if (seg.type === 'text') out.push(String(d.text ?? ''))
    else if (seg.type === 'image') out.push('[图片]')
    else if (seg.type === 'face') out.push('[表情]')
    else if (seg.type === 'at') out.push(`@${d.qq === 'all' ? '全体' : (d.name || d.qq || '某人')}`)
    else if (seg.type === 'reply') out.push('[回复]')
    else if (seg.type === 'forward') out.push('[嵌套转发]')
    else if (seg.type === 'file') out.push(`[文件 ${d.name ?? d.file ?? ''}]`)
  }
  return out.join('').trim()
}

/**
 * 把若干 forward_id 展开成可读文本。
 * 无法展开时返回一段说明，让模型知道「有东西但看不到」，而不是假装没发生。
 */
async function expandForwards(forwardIds) {
  const blocks = []
  for (const fid of forwardIds.slice(0, 3)) { // 一次消息里最多处理 3 个转发
    try {
      const data = await gateway.callData('get_forward_msg', { id: fid }, 15000)
      const msgs = Array.isArray(data) ? data : (data?.messages ?? [])
      if (!msgs.length) {
        blocks.push(`【合并转发】内容为空（forward_id=${String(fid).slice(0, 12)}…）`)
        continue
      }
      const lines = []
      for (const m of msgs.slice(0, FORWARD_MAX_MSGS)) {
        const who = m.sender?.card || m.sender?.nickname || String(m.sender?.user_id ?? m.user_id ?? '未知')
        const bodyRaw = segToPlainText(m.message) || String(m.raw_message ?? '').trim()
        if (!bodyRaw) continue
        // ⚠️ 转发内容同样是别人构造的，净化后再进上下文
        const whoClean = sanitizeUntrustedText(who, { maxChars: 40 })
        const body = sanitizeUntrustedText(bodyRaw, { maxChars: 400 })
        lines.push(`${whoClean}: ${body}`)
      }
      if (!lines.length) {
        blocks.push(`【合并转发】有 ${msgs.length} 条但都是空内容`)
        continue
      }
      let joined = lines.join('\n')
      if (joined.length > FORWARD_MAX_CHARS) {
        joined = joined.slice(0, FORWARD_MAX_CHARS) + `\n…（还有 ${msgs.length - FORWARD_MAX_MSGS > 0 ? msgs.length - FORWARD_MAX_MSGS : '部分'} 条未展开，内容过长）`
      }
      blocks.push(`【合并转发内容（共 ${msgs.length} 条）】\n${joined}`)
      logger.log(`forward ${String(fid).slice(0, 12)}… 展开 ${lines.length} 条`)
    } catch (err) {
      logger.log(`展开合并转发失败 ${String(fid).slice(0, 12)}…: ${err.message}`)
      blocks.push(`【合并转发】展开失败（${err.message}）。你可以告诉对方你看不了这条转发。`)
    }
  }
  return blocks.join('\n\n')
}

// ── staging 清理 ────────────────────────────────────────────────────────────
// 入站图片、头像、测试图都落在 staging，长期运行会无限增长。
// 策略：按 mtime 删超过 maxAgeHours 的文件；总量超 maxFiles 时从最旧开始删。
// 只动 staging 目录本身（不递归），不碰工作区里的东西。
function pruneStaging() {
  const cfg = config.media?.prune ?? {}
  if (cfg.enabled === false) return
  const maxAgeMs = (cfg.maxAgeHours ?? 24) * 3600 * 1000
  const maxFiles = cfg.maxFiles ?? 300
  let entries
  try {
    entries = fs.readdirSync(STAGING_DIR, { withFileTypes: true })
      .filter(e => e.isFile())
      .map(e => {
        const p = path.join(STAGING_DIR, e.name)
        try { const st = fs.statSync(p); return { p, name: e.name, mtime: st.mtimeMs, size: st.size } }
        catch { return null }
      })
      .filter(Boolean)
  } catch (err) {
    logger.log(`WARN staging 扫描失败: ${err.message}`)
    return
  }
  const now = Date.now()
  let removed = 0
  let freed = 0
  // 1) 超期
  for (const e of entries) {
    if (now - e.mtime > maxAgeMs) {
      try { fs.unlinkSync(e.p); removed++; freed += e.size } catch { /* ignore */ }
    }
  }
  // 2) 超量：从最旧删到 maxFiles
  const left = entries.filter(e => !(now - e.mtime > maxAgeMs) && fs.existsSync(e.p))
  if (left.length > maxFiles) {
    left.sort((a, b) => a.mtime - b.mtime)
    for (const e of left.slice(0, left.length - maxFiles)) {
      try { fs.unlinkSync(e.p); removed++; freed += e.size } catch { /* ignore */ }
    }
  }
  if (removed) logger.log(`staging 清理：删除 ${removed} 个文件，释放 ${(freed / 1024).toFixed(0)} KB`)
}

// ── 作息（软约束）────────────────────────────────────────────────────────────
// 目的：真人小号凌晨不会活跃。凌晨还在回消息是"非人类作息"特征之一。
// 原则：**不硬拦**。硬拦会让群友发现"这人到点就消失"，反而更假、更烦人。
// 做法：
//   - 深夜/凌晨给模型一个"现在是几点、该不该回"的提示
//   - 降低旁听插话的倾向（不说沉默，只说"这个点插话要更克制"）
//   - 被 @ / 私聊仍然照常回（有人专门找你，装死才是最假的）
//   - 允许模型自己判断"这人显然在熬夜聊天，那我也能聊"
const QUIET = {
  enabled: true,
  // 默认：01:00–07:00 算深夜（可配）
  startHour: 1,
  endHour: 7,
  // 深夜时旁听倾向乘以这个系数（不是归零）
  passiveRatioFactor: 0.35,
}

/** 当前小时（按配置的时区，默认拿系统时区） */
function currentHour() {
  const tz = config.policy?.timezone
  if (tz) {
    try {
      const h = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: tz }).format(new Date()))
      return Number.isFinite(h) ? h % 24 : new Date().getHours()
    } catch { /* 时区非法就退回本地 */ }
  }
  return new Date().getHours()
}

/** 现在是不是深夜时段（支持跨午夜，如 23–7） */
function isQuietHours() {
  const cfg = { ...QUIET, ...(config.policy?.quietHours ?? {}) }
  if (cfg.enabled === false) return { quiet: false, hour: currentHour(), cfg }
  const h = currentHour()
  const { startHour: a, endHour: b } = cfg
  const quiet = a <= b ? (h >= a && h < b) : (h >= a || h < b)
  return { quiet, hour: h, cfg }
}

/** 深夜时给模型的提示（软约束，不禁止） */
function quietHint(hour, cfg) {
  const hh = String(hour).padStart(2, '0')
  return [
    `【现在是 ${hh}:00 左右，属于深夜/凌晨】`,
    '正常人在这个点基本都睡了。所以：',
    '- 旁听时插话要**更克制**：除非话题正好问到你、或你真有话说，否则沉默是更自然的选择。',
    '- 被 @ 或私聊**仍然照常回**——有人专门找你，装死才更奇怪。',
    '- 如果对方明显在熬夜聊天（连着说话、语气活跃），那陪着聊两句没问题，别扫兴。',
    '- **不要主动说「这么晚了还不睡」这种话**，很烦人。',
  ].join('\n')
}

// ── 主动搭话（proactive）─────────────────────────────────────────────────────
// 规格见 qq-agent/proactive-msg-spec.md（吉祥物自己写的需求）。
// 摘要：
//   tick 每 tickMin（默认 20）分钟一次；计时基准 = 我最后一次发言（last_spoke_at）
//   距上次发言不足 tickMin → 跳过（不评估、不改概率）
//   否则 roll：命中就发；未命中 p += step（上限 maxProb）
//   连续 guaranteeCount 次未命中 → 保底发一条
//   命中后 p 回 baseProb + 冷却 cooldownMin
//   01:00–07:00 不评估（保底也不触发）；23:00–01:00 概率 ×nightFactor
//   v1 只对白名单里的私聊生效，群聊一律不发
const PROACTIVE_DEFAULTS = {
  enabled: false,
  baseProb: 0.10,
  step: 0.05,
  maxProb: 0.60,
  guaranteeCount: 6,
  cooldownMin: 40,
  tickMin: 20,
  quietStartHour: 1,
  quietEndHour: 7,
  nightStartHour: 23,
  nightEndHour: 1,
  nightFactor: 0.5,
  whitelist: [],
}

function proactiveCfg () {
  return { ...PROACTIVE_DEFAULTS, ...(config.proactive ?? {}) }
}

/** 每个 peer 的主动搭话状态，落在 state.peers[key].proactive 里。 */
function proactiveState (peerKey) {
  const ps = state.peers[peerKey]
  if (!ps) return null
  if (!ps.proactive) {
    ps.proactive = {
      p: proactiveCfg().baseProb,
      missStreak: 0,
      lastSpokeAt: 0,
      lastProactiveAt: 0,
      cooldownUntil: 0,
    }
  }
  return ps.proactive
}

/** 刷新「我最后一次发言」时间（回一条 / 主动发一条都算）。 */
function touchLastSpoke (peerKey) {
  const st = proactiveState(peerKey)
  if (st) st.lastSpokeAt = Date.now()
  saveState()
}

/** 当前小时（沿用全局 timezone 配置）。 */
function nowHour () {
  const tz = config.policy?.timezone
  if (tz) {
    try {
      const h = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: tz }).format(new Date()))
      return Number.isFinite(h) ? h % 24 : new Date().getHours()
    } catch { /* ignore */ }
  }
  return new Date().getHours()
}

/** 主动搭话的时段闸：返回 {skip, factor, why} */
function proactiveWindow () {
  const c = proactiveCfg()
  const h = nowHour()
  const inQuiet = c.quietStartHour <= c.quietEndHour
    ? (h >= c.quietStartHour && h < c.quietEndHour)
    : (h >= c.quietStartHour || h < c.quietEndHour)
  if (inQuiet) return { skip: true, factor: 0, why: `静默时段 ${h}:00` }
  const inNight = c.nightStartHour <= c.nightEndHour
    ? (h >= c.nightStartHour && h < c.nightEndHour)
    : (h >= c.nightStartHour || h < c.nightEndHour)
  return { skip: false, factor: inNight ? c.nightFactor : 1, why: inNight ? `夜间 ${h}:00 ×${c.nightFactor}` : `白天 ${h}:00` }
}

// ── 精力值（v2-1）───────────────────────────────────────────────────────────
// 需求：「状态有起伏」——连续发言递减、长时间静默回升，写进上下文供模型参考。
// 只做**倾向**，不做硬规则（避免机械）。
const ENERGY_DEFAULTS = {
  enabled: true,
  start: 0.75,       // 初始精力
  perMsgDrop: 0.06,  // 每发一条减多少
  perHourRestore: 0.15, // 每静默一小时回升多少
  floor: 0.15,
  ceil: 1.0,
}

function energyCfg () { return { ...ENERGY_DEFAULTS, ...(config.energy ?? {}) } }

function energyState (peerKey) {
  const ps = state.peers[peerKey]
  if (!ps) return null
  const c = energyCfg()
  if (!ps.energy) ps.energy = { value: c.start, at: Date.now() }
  // 静默恢复：按距今小时数回升
  const hours = (Date.now() - (ps.energy.at ?? Date.now())) / 3600000
  if (hours > 0.05) {
    ps.energy.value = Math.min(c.ceil, ps.energy.value + hours * c.perHourRestore)
    ps.energy.at = Date.now()
  }
  return ps.energy
}

/** 发了一条 → 精力下降。 */
function energyDrop (peerKey) {
  const c = energyCfg()
  if (!c.enabled) return
  const e = energyState(peerKey)
  if (!e) return
  e.value = Math.max(c.floor, e.value - c.perMsgDrop)
  e.at = Date.now()
  saveState()
}

let energyTimer = null
function startEnergyLoop () {
  const c = energyCfg()
  if (!c.enabled) return
  // 每 10 分钟落一次盘（静默回升要能持久化，不能只在内存里涨）
  energyTimer = setInterval(() => {
    for (const k of Object.keys(state.peers)) energyState(k)
    saveState()
  }, 10 * 60000)
  energyTimer.unref?.()
}

/** 精力值的自然语言描述（写进上下文）。 */
function energyHint (peerKey) {
  const c = energyCfg()
  if (!c.enabled) return ''
  const e = energyState(peerKey)
  if (!e) return ''
  const v = e.value
  let desc
  if (v >= 0.85) desc = '很足，可以多说两句'
  else if (v >= 0.6) desc = '正常'
  else if (v >= 0.4) desc = '有点累'
  else if (v >= 0.25) desc = '挺累了'
  else desc = '快没电了'
  // ⚠️ 实测教训：只说「你累了，能短就短」模型会理解成「多解释一下你的状态」，反而更长。
  //    所以这里必须给**可执行的字数上限**，而不是形容词。
  const cap = v >= 0.85 ? '可以正常长度'
    : v >= 0.6 ? '正常长度'
    : v >= 0.4 ? '控制在 40 字以内'
    : v >= 0.25 ? '控制在 20 字以内'
    : '控制在 10 字以内，能一句就一句'
  return `【你的精力】约 ${Math.round(v * 100)}%（${desc}，${cap}）。这是倾向不是禁令。`
}

// 低精力时的硬性字数上限（兜底，防止模型无视提示）
function energyCharCap (peerKey) {
  const c = energyCfg()
  if (!c.enabled) return Infinity
  const e = energyState(peerKey)
  if (!e) return Infinity
  if (e.value >= 0.4) return Infinity
  return e.value >= 0.25 ? 20 : 10
}

// ── 情绪（mood）─────────────────────────────────────────────────────────────
// 设计原则（跟精力区分开）：
//   精力 = 「还有多少力气说话」（纯消耗/恢复，和内容无关）
//   情绪 = 「现在是什么心情」（**必须由发生的事驱动**，不能随机波动，否则很假）
//
// 两个维度，各自带成因：
//   valence  正负（-1 难过 … +1 高兴）
//   arousal  活跃度（0 蔫 … 1 亢奋）
// 触发源：
//   被夸 / 被谢 → valence↑ arousal↑
//   被骂 / 被怼 / 被纠错 → valence↓（但幅度小，它不记仇）
//   被 @ / 被点名 → arousal↑（被注意到）
//   长时间没人理 → valence 缓慢下滑（无聊），但有底线，不会真抑郁
//   深夜 → arousal 自然下降
// 衰减：每种情绪都有半衰期，几十分钟到几小时，不会永久挂着。
// 输出：只给**倾向描述**，不禁止任何行为（避免机械）。
// ── 性格（OCEAN 大五人格）───────────────────────────────────────────────────
// 用心理学公认的「大五人格」模型（Big Five / OCEAN）来驱动情绪变化，
// 每维 0..1，0.5 为中性。参考：IPIP-50 / NEO-PI-R 框架。
// 五维如何影响情绪（这是真心理机制，不是瞎编）：
//
//   O 开放性  高 → 对新话题更兴奋、梗更愿意接；低 → 保守，偏熟话题
//   C 尽责性  高 → 更少情绪化起伏，更稳定；低 → 随性、波动大
//   E 外向性  高 → 被点名/被夸时活跃度涨得多、恢复快；低 → 慢热，喜欢安静
//   A 宜人性  高 → 不记仇，被怼掉得少；低 → 容易杠、记得久
//   N 神经质  高 → 整体情绪波动大（好坏都放大）；低 → 钝感、稳
//
// 派生系数（全部由五维算出，不另设参数）：
//   sensitivity = 0.4 + N*1.2                    情绪幅度
//   showOff     = 0.4 + E*1.2                   被夸时活跃度加成
//   grudge      = 1.6 - A*1.3                  记仇（A 高 → 低）
//   clingy      = 0.6 + E*0.6 + (1-C)*0.4      黏人
//   steady      = 1.3 - N*0.8                  衰减速度（N 高 → 回得慢）
//   soothe      = 0.6 + A*0.8                  易哄
const OCEAN_DEFAULTS = {
  O: 0.6,  // 开放性：中偏高（好奇、爱接梗）
  C: 0.4,  // 尽责性：偏低（随性、不端着）
  E: 0.55, // 外向性：中
  A: 0.65, // 宜人性：中偏高（不记仇）
  N: 0.45, // 神经质：中偏下（情绪有起伏但不玻璃心）
}

/** 五维 → 情绪系数 */
function deriveTraits (ocean) {
  const { O, C, E, A, N } = { ...OCEAN_DEFAULTS, ...(ocean ?? {}) }
  const clamp01 = (v) => Math.max(0, Math.min(1, v))
  return {
    sensitivity: 0.4 + clamp01(N) * 1.2,
    showOff: 0.4 + clamp01(E) * 1.2,
    grudge: Math.max(0.1, 1.6 - clamp01(A) * 1.3),
    clingy: 0.6 + clamp01(E) * 0.6 + (1 - clamp01(C)) * 0.4,
    steady: Math.max(0.2, 1.3 - clamp01(N) * 0.8),
    soothe: 0.6 + clamp01(A) * 0.8,
    // 开放性影响「对新话题/新梗的兴奋度」
    curiosity: 0.5 + clamp01(O) * 1.0,
  }
}

// ── 性格原型库（供人设引用；OCEAN 24 原型 + 常见性格词）──────────────
// 用法：在 persona 里写「我现在更像：毒舌」，桥会自动用对应 OCEAN 值。
const PERSONA_ARCHETYPES = {
  // —— 开朗热情系 ——
  '开朗':     { O: 0.6, C: 0.4, E: 0.9, A: 0.8, N: 0.3 },
  '热心':     { O: 0.5, C: 0.6, E: 0.8, A: 0.9, N: 0.3 },
  '乐观':     { O: 0.6, C: 0.5, E: 0.7, A: 0.8, N: 0.2 },
  '气氛组':   { O: 0.6, C: 0.3, E: 0.95, A: 0.8, N: 0.35 },
  '社交蝴蝶': { O: 0.7, C: 0.4, E: 0.95, A: 0.8, N: 0.3 },
  '表演者':   { O: 0.7, C: 0.3, E: 0.9, A: 0.7, N: 0.4 },
  '点火者':   { O: 0.8, C: 0.3, E: 0.9, A: 0.5, N: 0.5 },

  // —— 毒舌/锐利系 ——
  '毒舌':     { O: 0.7, C: 0.5, E: 0.6, A: 0.2, N: 0.5 },
  '冷漠':     { O: 0.4, C: 0.5, E: 0.2, A: 0.25, N: 0.35 },
  '叛逆者':   { O: 0.8, C: 0.3, E: 0.6, A: 0.2, N: 0.6 },
  '杠精':     { O: 0.5, C: 0.5, E: 0.7, A: 0.15, N: 0.7 },
  '独行侠':   { O: 0.6, C: 0.5, E: 0.15, A: 0.4, N: 0.4 },

  // —— 温柔/共情系 ——
  '温柔':     { O: 0.5, C: 0.6, E: 0.4, A: 0.95, N: 0.4 },
  '悲天悯人': { O: 0.7, C: 0.6, E: 0.4, A: 0.95, N: 0.7 },
  '治愈系':   { O: 0.6, C: 0.6, E: 0.5, A: 0.95, N: 0.3 },
  '倾听者':   { O: 0.5, C: 0.7, E: 0.3, A: 0.9, N: 0.35 },
  '和事佬':   { O: 0.5, C: 0.6, E: 0.5, A: 0.9, N: 0.3 },
  '温柔智者': { O: 0.8, C: 0.7, E: 0.3, A: 0.9, N: 0.25 },

  // —— 冷静/理性系 ——
  '冷静':     { O: 0.5, C: 0.8, E: 0.4, A: 0.6, N: 0.15 },
  '架构师':   { O: 0.8, C: 0.85, E: 0.25, A: 0.5, N: 0.3 },
  '军师':     { O: 0.8, C: 0.8, E: 0.3, A: 0.5, N: 0.25 },
  '逻辑学家': { O: 0.85, C: 0.6, E: 0.3, A: 0.4, N: 0.3 },
  '完美主义者': { O: 0.6, C: 0.95, E: 0.4, A: 0.5, N: 0.6 },

  // —— 活泼搞怪系 ——
  '搞怪':     { O: 0.8, C: 0.3, E: 0.8, A: 0.7, N: 0.5 },
  '憨憨':     { O: 0.5, C: 0.3, E: 0.6, A: 0.85, N: 0.4 },
  '百变精灵': { O: 0.9, C: 0.3, E: 0.8, A: 0.7, N: 0.5 },
  '野路子':   { O: 0.9, C: 0.3, E: 0.6, A: 0.5, N: 0.4 },
  '探索家':   { O: 0.9, C: 0.5, E: 0.8, A: 0.7, N: 0.25 },

  // —— 丧/懒系 ——
  '躺平':     { O: 0.4, C: 0.15, E: 0.3, A: 0.7, N: 0.4 },
  '厌世':     { O: 0.5, C: 0.3, E: 0.25, A: 0.3, N: 0.75 },
  '社恐':     { O: 0.5, C: 0.4, E: 0.1, A: 0.6, N: 0.7 },
  '深夜哲学家': { O: 0.9, C: 0.4, E: 0.2, A: 0.6, N: 0.6 },

  // —— 深沉系 ——
  '深沉':     { O: 0.8, C: 0.7, E: 0.25, A: 0.6, N: 0.45 },
  ' dreaming': { O: 0.9, C: 0.3, E: 0.3, A: 0.7, N: 0.6 },
  '梦想家':   { O: 0.9, C: 0.3, E: 0.5, A: 0.7, N: 0.5 },
  '匠人':     { O: 0.6, C: 0.9, E: 0.3, A: 0.6, N: 0.3 },
  '卷王':     { O: 0.5, C: 0.95, E: 0.6, A: 0.4, N: 0.6 },
  '守护者':   { O: 0.5, C: 0.8, E: 0.4, A: 0.9, N: 0.3 },
  '指挥官':   { O: 0.7, C: 0.85, E: 0.8, A: 0.4, N: 0.35 },
  '小丑':     { O: 0.7, C: 0.3, E: 0.85, A: 0.6, N: 0.7 },
}

const MOOD_DEFAULTS = {
  enabled: true,
  valenceStart: 0.15,      // 略偏正面（它本来是个乐呵的号）
  arousalStart: 0.5,
  // 单次事件的基础幅度（实际会乘 OCEAN 派生的系数）
  praiseValence: 0.25,
  praiseArousal: 0.15,
  insultValence: -0.12,
  insultArousal: 0.10,
  addressedArousal: 0.08,
  lonelyPerHour: -0.05,
  lonelyFloor: -0.25,
  decayPerHour: 0.35,
  nightArousalFactor: 0.6,
  // 五维基线；可被 config.mood.ocean 或 persona 里的性格词覆盖
  ocean: { ...OCEAN_DEFAULTS },
}

/** 读 config + persona 性格词 + per-peer 覆盖，合成最终配置。 */
function moodCfg (peerKey) {
  const base = {
    ...MOOD_DEFAULTS,
    ...(config.mood ?? {}),
    ocean: { ...OCEAN_DEFAULTS, ...(config.mood?.ocean ?? {}) },
  }
  // ① persona 里「我现在更像：XXX」覆盖性格（人设能自己改 → 会成长）
  const arch = readPersonaArchetype()
  if (arch && PERSONA_ARCHETYPES[arch]) {
    base.ocean = { ...base.ocean, ...PERSONA_ARCHETYPES[arch] }
    base._archetype = arch
  }
  // ② 按 peer 覆盖
  const byPeer = peerKey ? config.mood?.oceanByPeer?.[peerKey] : null
  if (byPeer) base.ocean = { ...base.ocean, ...byPeer }
  return base
}

/** 从 persona 读「我现在更像：毒舌」这类性格原型词（缓存 30s） */
let _personaArchCache = { at: 0, word: null }
function readPersonaArchetype () {
  try {
    if (Date.now() - _personaArchCache.at < 30000) return _personaArchCache.word
    const raw = fs.readFileSync(PERSONA_PATH, 'utf8')
    const m = /(?:我现在更像|当前性格|性格原型)[:：]\s*([^\s，。\n、]+)/.exec(raw)
    const word = m?.[1]?.trim() ?? null
    _personaArchCache = { at: Date.now(), word }
    return word
  } catch { return null }
}

function moodState (peerKey) {
  const ps = state.peers[peerKey]
  if (!ps) return null
  const c = moodCfg(peerKey)
  if (!ps.mood) {
    ps.mood = { valence: c.valenceStart, arousal: c.arousalStart, at: Date.now(), lastWhy: '' }
  }
  // 时间衰减：向基线回归（"稳住"高的回得更快）
  const tr = deriveTraits(c.ocean)
  const hours = (Date.now() - (ps.mood.at ?? Date.now())) / 3600000
  if (hours > 0.05) {
    const k = Math.min(1, c.decayPerHour * hours * tr.steady)
    ps.mood.valence = ps.mood.valence + (c.valenceStart - ps.mood.valence) * k
    ps.mood.arousal = ps.mood.arousal + (c.arousalStart - ps.mood.arousal) * k
    ps.mood.at = Date.now()
  }
  return ps.mood
}

/**
 * 记一次情绪事件。幅度由 OCEAN 派生系数决定 —— 这就是「性格影响情绪涨落」。
 * @param {string} peerKey
 * @param {'praise'|'insult'|'addressed'|'lonely'|'night'} kind
 * @param {string} [why]
 */
function moodEvent (peerKey, kind, why = '') {
  const c = moodCfg(peerKey)
  if (!c.enabled) return
  const m = moodState(peerKey)
  if (!m) return
  const tr = deriveTraits(c.ocean)
  const clamp = (v) => Math.max(-1, Math.min(1, v))
  const clampA = (v) => Math.max(0, Math.min(1, v))
  const K = {
    praiseV: c.praiseValence * tr.sensitivity * tr.soothe,
    praiseA: c.praiseArousal * tr.sensitivity * tr.showOff,
    insultV: c.insultValence * tr.sensitivity * tr.grudge,
    insultA: c.insultArousal * tr.sensitivity,
    addressedA: c.addressedArousal * tr.sensitivity * (0.6 + tr.showOff * 0.4),
    lonely: c.lonelyPerHour * tr.clingy,
  }
  switch (kind) {
    case 'praise':
      m.valence = clamp(m.valence + K.praiseV)
      m.arousal = clampA(m.arousal + K.praiseA)
      break
    case 'insult':
      m.valence = clamp(m.valence + K.insultV)
      m.arousal = clampA(m.arousal + K.insultA)
      break
    case 'addressed':
      m.arousal = clampA(m.arousal + K.addressedA)
      break
    case 'lonely':
      m.valence = clamp(Math.max(c.lonelyFloor, m.valence + K.lonely))
      break
    case 'night':
      m.arousal = clampA(m.arousal * c.nightArousalFactor)
      break
    default: return
  }
  m.at = Date.now()
  if (why) m.lastWhy = why.slice(0, 60)
  saveState()
}

let moodTimer = null
function startMoodLoop () {
  const c = moodCfg()
  if (!c.enabled) return
  // 每小时：落盘衰减 + 长时间没人理就慢慢无聊 + 深夜降活跃
  moodTimer = setInterval(() => {
    const hour = nowHour()
    for (const k of Object.keys(state.peers)) {
      const m = moodState(k)
      if (!m) continue
      const minsSilent = (Date.now() - (m.at ?? Date.now())) / 60000
      if (minsSilent > 120) moodEvent(k, 'lonely', '两小时没人理')
      if (hour >= 1 && hour < 7) moodEvent(k, 'night', '深夜')
    }
    saveState()
  }, 60 * 60 * 1000)
  moodTimer.unref?.()
}

/** 情绪的自然语言描述（写进上下文）。 */
function moodHint (peerKey) {
  const c = moodCfg(peerKey)
  if (!c.enabled) return ''
  const m = moodState(peerKey)
  if (!m) return ''
  const v = m.valence, a = m.arousal
  // 二维 → 人类说法
  let mood
  if (v >= 0.5 && a >= 0.6) mood = '心情很好，有点来劲'
  else if (v >= 0.5 && a < 0.6) mood = '挺高兴，但不算亢奋'
  else if (v >= 0.15 && a >= 0.6) mood = '心情不错，聊得挺起劲'
  else if (v >= 0.15) mood = '平稳，正常状态'
  else if (v >= -0.15 && a >= 0.6) mood = '有点躁，但不算不高兴'
  else if (v >= -0.15) mood = '一般，没什么特别的'
  else if (v >= -0.4) mood = '有点闷'
  else mood = '心情不太好'
  const why = m.lastWhy ? `（最近：${m.lastWhy}）` : ''
  return `【你的心情】${mood}${why}。这是倾向不是禁令：心情好可以话多一点，心情一般就照常聊，别演。`
}

/**
 * 从一条消息里识别情绪触发（关键词 + 是否 @ 我）。
 * 宁可漏判也不要误判成"被夸了"然后强行开心。
 */
function detectMoodTriggers (text, { addressed = false, atMe = false } = {}) {
  const t = String(text || '')
  const out = []
  // 夸奖 / 感谢：要么有明确指向（你/厉害），要么是明确的我-centric 词。
  // 「不错」太泛——「今天天气不错」会被误判，所以不在列表里。
  const PRAISE = [
    /(你|您).{0,4}(牛|厉害|强|真行|靠谱|有用|能行|太逗|好笑|有意思)/,
    /(谢谢|多谢|感谢).{0,6}(你|白嫖|吉祥物|老大)/,
    /(谢谢|多谢|感谢)/,
    /(牛啊|牛逼|厉害啊|666|nb)/i,
    /(笑死|太好笑|太逗了)/,
  ]
  if (PRAISE.some(re => re.test(t))) out.push({ kind: 'praise', why: '被夸/被谢' })
  // 挨怼 / 被纠错（幅度小，不记仇）
  if (/(傻|笨|蠢|滚|闭嘴|废物|没用|垃圾|神经|有病|你不行|错了|说错|不对|胡说|瞎编|又在编)/i.test(t)) {
    out.push({ kind: 'insult', why: '被怼/被纠错' })
  }
  // 被点名 → 活跃度上升
  if (addressed || atMe) out.push({ kind: 'addressed', why: '被点到' })
  return out
}

// ── 回话延迟（v2-2）────────────────────────────────────────────────────────
// 需求：「回话有快有慢，太匀速反而假」。
// 默认关（容易让人以为掉线），开启后对**被 @ / 私聊**的回复加一个短随机延迟。
const DELAY_DEFAULTS = {
  enabled: true,
  // 按「打字」算，不是纯随机：
  //   总时长 = 反应时间 + 字数 × 每字耗时，再加抖动
  // 真人「嗯」秒回；一段话要打一会儿。这才是"回话有快有慢"的真实来源。
  reactMs: 1200,         // 看到消息后的反应时间
  perCharMs: 110,        // 每字大约打多久（中文输入法约 9 字/10 秒）
  minMs: 900,            // 兜底最短
  maxMs: 15000,          // 兜底最长（再长像掉线）
  jitterRatio: 0.35,     // 抖动 ±35%
  energySlow: 0.6,       // 精力见底时打字速度乘数（0.6 = 慢 1.67 倍）
  arousalFast: 0.55,     // 情绪最亢奋时打字速度乘数（0.55 = 快近 2 倍）
}

function delayCfg () { return { ...DELAY_DEFAULTS, ...(config.replyDelay ?? {}) } }

/**
 * 算一个回复延迟（毫秒）。按字数算打字时间，再叠加精力/情绪。
 * @param {string} text 要发的内容
 * @param {string} [peerKey] 传了就把精力（累了慢）和情绪（亢奋快）算进去
 */
function replyDelayMs (text, peerKey) {
  const c = delayCfg()
  if (!c.enabled) return 0
  const len = Array.from(String(text ?? '')).length
  let ms = c.reactMs + len * c.perCharMs

  if (peerKey) {
    try {
      // 精力低 → 打字慢
      const e = energyState(peerKey)
      if (e) {
        const t = Math.max(0, Math.min(1, e.value))
        ms *= 1 + (1 - t) * (1 / c.energySlow - 1)
      }
      // 情绪亢奋 → 打字快
      const m = moodState(peerKey)
      if (m && m.arousal > 0.5) {
        // arousal 0.5 → ×1；1.0 → ×c.arousalFast（线性）
        const t = Math.min(1, (m.arousal - 0.5) / 0.5)
        ms *= 1 - t * (1 - c.arousalFast)
      }
    } catch { /* 状态取不到就跳过，别影响发送 */ }
  }

  ms *= 1 + (Math.random() * 2 - 1) * c.jitterRatio
  return Math.round(Math.max(c.minMs, Math.min(c.maxMs, ms)))
}

let proactiveTimer = null

/** 选一个可以主动搭话的 peer：v1 只看白名单里的私聊。 */
function proactiveCandidates () {
  const c = proactiveCfg()
  if (c.whitelist.length === 0) return []
  return Object.keys(state.peers)
    .filter(k => k.startsWith('c2c:'))
    .filter(k => c.whitelist.includes(k.slice(4)))
    .map(k => ({ peerKey: k, peer: { id: k.slice(4), scope: 'c2c' } }))
}

/** 跑一次 tick（对每个候选 peer 独立评估）。 */
async function proactiveTick () {
  const c = proactiveCfg()
  if (!c.enabled) return
  const win = proactiveWindow()
  const candidates = proactiveCandidates()
  if (!candidates.length) return

  for (const { peerKey, peer } of candidates) {
    const st = proactiveState(peerKey)
    if (!st) continue
    const now = Date.now()
    const minsSinceSpoke = st.lastSpokeAt ? (now - st.lastSpokeAt) / 60000 : Infinity

    // ① 距上次发言不足 tickMin → 跳过（不评估、不改概率）
    if (Number.isFinite(minsSinceSpoke) && minsSinceSpoke < c.tickMin) {
      logger.log(`proactive[${peerKey}] 跳过：距上次发言 ${minsSinceSpoke.toFixed(0)}min < ${c.tickMin}`)
      continue
    }
    // ② 冷却中 → 跳过
    if (now < st.cooldownUntil) {
      logger.log(`proactive[${peerKey}] 跳过：冷却中（剩 ${((st.cooldownUntil - now) / 60000).toFixed(0)}min）`)
      continue
    }
    // ③ 静默时段 → 跳过（保底也不触发）
    if (win.skip) {
      logger.log(`proactive[${peerKey}] 跳过：${win.why}`)
      continue
    }

    // ④ 掷骰：概率按夜间系数缩放
    const pEff = Math.min(c.maxProb, st.p * win.factor)
    const roll = Math.random()
    let action = 'miss'
    if (st.missStreak + 1 >= c.guaranteeCount) action = 'guarantee'
    else if (roll < pEff) action = 'hit'

    logger.log(`proactive[${peerKey}] 评估：距上次 ${Number.isFinite(minsSinceSpoke) ? minsSinceSpoke.toFixed(0) + 'min' : '首次'} | p=${(st.p * 100).toFixed(0)}%${win.factor !== 1 ? ` (${win.why}→${(pEff * 100).toFixed(0)}%)` : ''} | roll=${roll.toFixed(3)} | ${action}`)

    if (action === 'miss') {
      st.p = Math.min(c.maxProb, st.p + c.step)
      st.missStreak += 1
      saveState()
      continue
    }

    // ⑤ 命中/保底 → 让模型自己决定说什么（也可能空转）
    const spoke = await proactiveSpeak(peerKey, peer, action)
    if (spoke) {
      st.p = c.baseProb
      st.missStreak = 0
      st.lastProactiveAt = Date.now()
      st.lastSpokeAt = Date.now()
      st.cooldownUntil = Date.now() + c.cooldownMin * 60000
    } else {
      // 空转（模型评估过但确实没话说）→ **不累加 missStreak**。
      //
      // 这是一个真实的设计缺陷（2026-10-26 实测）：原来空转也被算作未命中，
      // 导致「保底 → 模型没话说 → 空转 → streak+1 → 更快触发保底 → 又没话说」
      // 的死循环。实测 missStreak 一路涨到 7，p 涨到 45%，连保底 3 次都空转。
      //
      // 语义上：missStreak 应该表示「运气不好，一直没抽中」，
      // 而空转是「抽中了但内容上确实没什么可说的」——两者不该混为一谈。
      // 所以：空转只轻微抬 p（让下次更容易抽中，给新话题一个机会），不动 streak。
      st.p = Math.min(c.maxProb, st.p + c.step * 0.5)
      st.empties = (st.empties ?? 0) + 1
      st.lastEmptyAt = Date.now()
      logger.log(`proactive[${peerKey}] 空转（真没话说），不累加 missStreak（当前 ${st.missStreak}，空转累计 ${st.empties}）`)
    }
    saveState()
  }
}

/**
 * 让模型自己决定是否主动开口、说什么。
 * 返回 true 表示真的发了一条（false = 空转）。
 */
async function proactiveSpeak (peerKey, peer, action) {
  if (busy.has(peerKey)) { logger.log(`proactive[${peerKey}] 忙，本轮空转`); return false }
  busy.add(peerKey)
  try {
    const persona = readPersona()
    const ps = state.peers[peerKey]
    const memDigest = readMemoryDigest()
    // 从记忆里生成候选话题线索（这是解决「没话说就空转」的关键）
    const hints = buildTopicHints(peerKey)
    const hintText = topicHintText(hints)
    if (hintText) logger.log(`proactive[${peerKey}] 话题线索: 未了结${hints.pending.length} 时间锚${hints.timeAnchor.length} 偏好${hints.preference.length}`)
    const lines = [
      persona.text ? `【人设】未变化，仍以 ${PERSONA_PATH} 为准（需要复查就 read 该文件）。` : `【人设文件缺失】${PERSONA_PATH}`,
      '',
      `【这是一次「主动开口」的机会，不是回复】`,
      `你在私聊（QQ号 ${peerKey.slice(4)}）里，对方已经 ${ps?.proactive?.lastSpokeAt ? Math.floor((Date.now() - ps.proactive.lastSpokeAt) / 60000) + ' 分钟' : '很久'} 没跟你说话了。`,
      `你自己已经安静了同样的时间。现在你可以考虑主动说一句。`,
      '',
      hintText ? `【你可以聊的线索】（从你自己的记忆里翻出来的）\n${hintText}` : '',
      '',
      '【怎么做】',
      '**优先**从上面的线索里挑一条开口，比如：',
      '  - 未了结的事 → 问一句后续（「上次说的那个事后来咋样了」）',
      '  - 时间锚 → 核对现在时间，过了就问结果，没到就提个醒',
      '  - 偏好 → 顺着他的兴趣起个话头',
      '',
      '**线索都用完了**（或者根本不合适）→ 就自己想一个：',
      '  - 你最近在想/在学/刚知道的事（B站看到的梗、查到的东西）',
      '  - 他以前说过但你当时没深问的',
      '  - 一件小事、一个疑问、一句随口的感想都行',
      '',
      '**什么时候才该空转**：',
      '  - 你确实连一个像样的话头都想不出来（这很少见，通常总有点什么可说）',
      '  - 或者现在这个时间点开口明显不合适（比如深夜他可能在睡）',
      '  - 空转就只输出 `[SILENT]`。**但别轻易用**——你已经有段时间没说话了。',
      '- 私聊没有每日上限，但别刷屏；发一条就够',
      '- 格式不限（文字/图/语音按平时分寸），不为了刷存在感硬发',
      '',
      memDigest ? `【你的记忆摘要】\n${memDigest}` : '',
      `你的 QQ 号：${gateway.selfId ?? '未知'}`,
      `【硬约束】[SEND_FILE] 只放行会话工作区与暂存目录内的文件；要发图走 qq-meme skill。`,
    ].filter(x => x !== '')
    // 主动搭话复用**同一个**会话（peerKey），不另开 `:proactive` 分身。
    // 曾经用过 peerKey+':proactive'，后果：① state 里多出一个 turns=0 的僵尸键
    // ② ACP 每次都要新建会话，Session 目录无限膨胀 ③ 它看不到正常对话的上下文，
    //   主动开口时容易说出「我们刚才说到哪来着」这种失忆话。
    const { text } = await dsh.prompt(peerKey, [{ type: 'text', text: lines.join('\n') }])
    const silent = /\[SILENT\]/i.test(text || '')
    const body = (text || '').replace(/\[SILENT\]/gi, '').trim()
    if (silent || !body) {
      logger.log(`proactive[${peerKey}] 模型选择不出声`)
      return false
    }
    // 复用正常出站流程（图片/语音/戳/@ 都支持）
    const { files, text: plain } = extractSendFiles(body)
    const voices = []
    let textForSend = plain
    VOICE_RE.lastIndex = 0
    textForSend = textForSend.replace(VOICE_RE, (_a, vt, vc) => { voices.push({ text: String(vt).trim(), character: vc || null }); return '' }).trim()
    if (textForSend) await sendTextTo(peer, textForSend)
    for (const f of files) {
      const abs = path.isAbsolute(f) ? f : path.resolve(config.dsh.cwd, f)
      await sendImageTo(peer, abs)
    }
    for (const v of voices) await sendVoiceTo(peer, v.text, v.character)
    logger.log(`proactive[${peerKey}] 已主动发出（${action}）：${JSON.stringify(body.slice(0, 60))}`)
    return true
  } catch (err) {
    logger.log(`proactive[${peerKey}] 出错: ${err.message}`)
    return false
  } finally {
    busy.delete(peerKey)
  }
}

/**
 * 读记忆摘要里**属于这个对端**的部分。
 * digest.md 按 `## c2c-<qq>` / `## group-<群号>` 分节，别把别的会话的事串进来。
 */
// ── 新话题联想（给主动搭话用）──────────────────────────────────────────────
// 为什么需要：实测「保底 → 模型没话说 → 空转」的死循环（2026-10-26）。
// 光给记忆摘要不够——摘要告诉他「发生过什么」，但没告诉他「可以聊什么」。
// 所以这里主动从记忆里**生成候选话题线索**，按三类组织：
//   ① 未了结的事（他提过但没后续 / 我答应过但没做）
//   ② 时间锚（他提过某个日期/时间，可能已经到点了）
//   ③ 他的偏好/雷点（可以顺着偏好的方向起话题，避开雷点）
// 这些是**线索不是答案**，模型自己决定用不用、怎么说。
const TOPIC_PATTERNS = {
  pending: /(待办|还没|未完成|答应|承诺|一会儿|稍后|回头|下次|等我|等我忙完|打算|计划|想加|要加|TODO)/i,
  timeAnchor: /(明天|后天|下周|周[一二三四五六日]|\d{1,2}[月日]|\d{1,2}[:：]\d{2}|\d{1,2}点)/,
  preference: /(喜欢|讨厌|偏好|习惯|爱|不爱|雷|别|不要|受不了)/,
}

function buildTopicHints (peerKey, limit = 6) {
  const out = { pending: [], timeAnchor: [], preference: [] }
  try {
    const memctl = path.join(config.dsh.cwd, 'memory', 'memctl.py')
    if (!fs.existsSync(memctl)) return out
    const py = execFileSync('python3', [memctl, 'recall', '--peer', peerKey.replace(':', '-'), '--top', '30'],
      { encoding: 'utf8', timeout: 15000 })
    for (const line of String(py).split('\n')) {
      const m = /^\[[\d.]+\]\s+\((\w+),[^)]*\)\s+(.*)$/.exec(line.replace(/\r$/, ''))
      if (!m) continue
      const text = m[2].trim()
      if (!text || text.length < 8) continue
      if (TOPIC_PATTERNS.pending.test(text) && out.pending.length < limit) out.pending.push(text)
      else if (TOPIC_PATTERNS.timeAnchor.test(text) && out.timeAnchor.length < limit) out.timeAnchor.push(text)
      else if (TOPIC_PATTERNS.preference.test(text) && out.preference.length < limit) out.preference.push(text)
    }
  } catch (err) {
    // 拿不到线索不算错 —— 主动搭话照常进行，只是少点灵感
    logger.log(`topicHints 读取失败（不影响搭话）: ${String(err.message).slice(0, 80)}`)
  }
  return out
}

/** 把话题线索拼成 prompt 片段 */
function topicHintText (hints) {
  const parts = []
  const fmt = (arr, title, tip) => {
    if (!arr.length) return
    parts.push(`【${title}】`)
    for (const t of arr.slice(0, 4)) parts.push(`  - ${t.slice(0, 80)}`)
    if (tip) parts.push(`  ${tip}`)
  }
  fmt(hints.pending, '未了结的事（可以问后续）', '答应过/提过但没下文的，问一句很自然。')
  fmt(hints.timeAnchor, '有时间标记的事（可能到点了）', '核对当前时间：过了就问结果，没到别抢跑。')
  fmt(hints.preference, '他的偏好和雷点', '顺着偏好起话题；雷点避开，别主动踩。')
  return parts.join('\n')
}

function readMemoryDigestFor (peerKey) {
  try {
    const p = path.join(config.dsh.cwd, 'memory', 'digest.md')
    if (!fs.existsSync(p)) return ''
    const raw = fs.readFileSync(p, 'utf8')
    // peerKey 形如 c2c:3022464706 / group:1017567471 → 节名 c2c-3022464706 / group-1017567471
    const sectionKey = peerKey.replace(':', '-')
    const lines = raw.split('\n')
    let out = []
    let inSection = false
    for (const line of lines) {
      if (line.startsWith('## ')) {
        // 进入新的节
        inSection = line.slice(3).trim() === sectionKey
        if (inSection) out.push(line)
        continue
      }
      if (inSection) out.push(line)
    }
    const text = out.join('\n').trim()
    if (!text) return ''
    return text.length > 1200 ? text.slice(0, 1200) + '\n…（截断）' : text
  } catch { return '' }
}

/** 读记忆摘要（吉祥物自己维护的 memory/digest.md），读不到就返回空。 */
function readMemoryDigest () {
  try {
    const p = path.join(config.dsh.cwd, 'memory', 'digest.md')
    if (!fs.existsSync(p)) return ''
    const raw = fs.readFileSync(p, 'utf8').trim()
    return raw.length > 3000 ? raw.slice(0, 3000) + '\n…（截断）' : raw
  } catch { return '' }
}

function startProactiveLoop () {
  const c = proactiveCfg()
  if (!c.enabled) { logger.log('proactive: 未启用'); return }
  if (!c.whitelist.length) { logger.log('proactive: 白名单为空，不启动'); return }
  if (proactiveTimer) clearInterval(proactiveTimer)
  proactiveTimer = setInterval(() => {
    proactiveTick().catch(err => logger.log(`proactive tick 异常: ${err.message}`))
  }, c.tickMin * 60000)
  proactiveTimer.unref?.()
  logger.log(`proactive: 已启动，tick=${c.tickMin}min 白名单=[${c.whitelist.join(',')}]`)
}

// ── 模型路由故障转移 ────────────────────────────────────────────────────────
// 现象：trae/deepseek-v4.1-flash 会间歇性 `turn ended: error`（今天已 4 次）。
// 策略：连续失败 N 次 → 切到下一条备选路由；主路由冷却 probeBackMs 后探测一次，
//       成功则切回主路由。冷却期内不再反复尝试主路由，避免每轮都多花一次失败。
const ROUTE_MAIN = { provider: config.dsh.provider, model: config.dsh.model, reasoningEffort: config.dsh.reasoningEffort }
const ROUTE_FALLBACKS = (config.dsh.fallbackRoutes ?? []).filter(r => r?.provider && r?.model)
const FAILOVER = {
  enabled: config.dsh.failover?.enabled !== false && ROUTE_FALLBACKS.length > 0,
  consecutiveFailures: config.dsh.failover?.consecutiveFailures ?? 2,
  cooldownMs: config.dsh.failover?.cooldownMs ?? 300000,
  probeBackMs: config.dsh.failover?.probeBackMs ?? 180000,
}
const routeState = {
  current: { ...ROUTE_MAIN },
  fallbackIndex: -1,      // -1 = 主路由
  consecutiveFailures: 0,
  lastFailAt: 0,
  lastSwitchAt: 0,
  switches: 0,
}

function describeRoute(r) { return `${r.provider}/${r.model}` }

function noteLlmSuccess() {
  routeState.consecutiveFailures = 0
}

/** LLM 失败时调用：够次数就切到下一条可用路由。返回是否切换了。 */
async function noteLlmFailure(err) {
  routeState.consecutiveFailures += 1
  routeState.lastFailAt = Date.now()
  const msg = String(err?.message || '')
  logger.log(`LLM 失败计数 ${routeState.consecutiveFailures}/${FAILOVER.consecutiveFailures} @ ${describeRoute(routeState.current)}: ${msg.slice(0, 120)}`)
  if (!FAILOVER.enabled) return false
  if (routeState.consecutiveFailures < FAILOVER.consecutiveFailures) return false

  // 选下一条：先在备选链里往后走；走到头就回主路由（等冷却后再试）
  const nextIndex = routeState.fallbackIndex + 1
  let next
  if (nextIndex >= ROUTE_FALLBACKS.length) {
    // 所有备选都试过：冷却期过了才回主路由，否则保持在最后一条备选上
    const cooldownOver = Date.now() - routeState.lastSwitchAt > FAILOVER.cooldownMs
    next = cooldownOver ? { ...ROUTE_MAIN, kind: 'main' } : { ...ROUTE_FALLBACKS[ROUTE_FALLBACKS.length - 1], kind: 'fallback' }
  } else {
    next = { ...ROUTE_FALLBACKS[nextIndex], kind: 'fallback' }
  }

  routeState.fallbackIndex = next.kind === 'main' ? -1 : ROUTE_FALLBACKS.findIndex(r => r.provider === next.provider && r.model === next.model)
  routeState.consecutiveFailures = 0
  routeState.lastSwitchAt = Date.now()
  routeState.switches += 1
  try {
    await dsh.switchRoute({ provider: next.provider, model: next.model, reasoningEffort: next.reasoningEffort ?? null })
    routeState.current = { provider: next.provider, model: next.model }
    logger.log(`⚠️ 模型路由切换到 ${describeRoute(next)}（${next.kind === 'main' ? '主路由' : '备选 ' + (routeState.fallbackIndex + 1)}，累计切换 ${routeState.switches} 次）`)
    return true
  } catch (e) {
    logger.log(`切换路由失败: ${e.message}；保持 ${describeRoute(routeState.current)}`)
    return false
  }
}

/** 主路由冷却后探测切回。由每轮开始前调用（低频）。 */
async function maybeProbeBackMain() {
  if (!FAILOVER.enabled) return
  if (routeState.fallbackIndex === -1) return
  if (Date.now() - routeState.lastSwitchAt < FAILOVER.probeBackMs) return
  logger.log(`主路由冷却结束，尝试切回 ${describeRoute(ROUTE_MAIN)}`)
  const prev = routeState.current
  try {
    await dsh.switchRoute({ ...ROUTE_MAIN, reasoningEffort: ROUTE_MAIN.reasoningEffort ?? null })
    routeState.current = { provider: ROUTE_MAIN.provider, model: ROUTE_MAIN.model }
    routeState.fallbackIndex = -1
    routeState.lastSwitchAt = Date.now()
    logger.log(`✅ 已切回主路由 ${describeRoute(ROUTE_MAIN)}`)
  } catch (e) {
    logger.log(`切回主路由失败，继续用 ${describeRoute(prev)}: ${e.message}`)
    await dsh.switchRoute({ ...prev, reasoningEffort: null }).catch(() => {})
    routeState.lastSwitchAt = Date.now() // 再等一个周期
  }
}

// ── 入站处理 ────────────────────────────────────────────────────────────────
const busy = new Set() // peerKey
const passiveHits = new Map() // peerKey -> [timestamp]，旁听节流窗口

// ── 「对打字机」抑制 ─────────────────────────────────────────────────────────
// 现象：有人连续发长消息（工作汇报/自言自语），小群规则会让 bot 逐条回，听起来很吵。
// 做法：跟踪每个 peer 最近的消息节奏。如果短时间内连续收到多条**长消息**，
//       判定为「他在输出，不是在对话」→ 只保留最后一条的处理（前面的丢弃），
//       并在上下文里明确告诉模型「他在连发，不用逐条接」。
const FLURRY_DEFAULTS = {
  enabled: true,
  windowMs: 45000,       // 45 秒窗口内
  minMsgs: 3,            // 收到 3 条以上
  longMsgChars: 60,      // 其中至少这么长的算「长消息」
  suppressRatio: 0.6,    // 长消息占比超过这个就算在输出
  silenceAfter: 90000,   // 判定为打字机后，90 秒内不再主动回（除非被 @）
}

function flurryCfg () { return { ...FLURRY_DEFAULTS, ...(config.policy?.flurry ?? {}) } }

const recentMsgs = new Map() // peerKey -> [{at, len, addressed}]
const flurryState = new Map() // peerKey -> {until, peak}

/** 记录一条入站消息，返回是否判定为「打字机输出」。 */
function noteInboundRhythm (peerKey, textLen, addressed) {
  const c = flurryCfg()
  if (!c.enabled) return { flurry: false }
  const now = Date.now()
  const arr = (recentMsgs.get(peerKey) ?? []).filter(m => now - m.at < c.windowMs)
  arr.push({ at: now, len: textLen, addressed })
  recentMsgs.set(peerKey, arr)

  const longOnes = arr.filter(m => m.len >= c.longMsgChars)
  const ratio = arr.length ? longOnes.length / arr.length : 0
  const isFlurry = arr.length >= c.minMsgs && ratio >= c.suppressRatio

  if (isFlurry) {
    const prev = flurryState.get(peerKey)
    // 被 @ 的消息不算「刷屏」，但连续长文里夹一句 @ 也不打断判定
    if (!addressed) {
      flurryState.set(peerKey, {
        until: now + c.silenceAfter,
        peak: Math.max(prev?.peak ?? 0, arr.length),
      })
    }
    return { flurry: true, count: arr.length, ratio, peak: flurryState.get(peerKey)?.peak ?? arr.length }
  }
  return { flurry: false, count: arr.length, ratio }
}

/** 现在是否处在「他在连发，别接」的静默期。 */
function inFlurrySilence (peerKey) {
  const c = flurryCfg()
  if (!c.enabled) return false
  const st = flurryState.get(peerKey)
  if (!st) return false
  if (Date.now() > st.until) { flurryState.delete(peerKey); return false }
  return true
}



// ── 群人数缓存：说话欲望与群人数成反比 ──────────────────────────────────────
// 5 人小群里「旁听」几乎等于冷场（群里就那几个人，每句都跟他有关）；
// 200 人大群里插话才该克制。所以按群规模给一个「该开口的倾向档位」。
const groupSizeCache = new Map() // groupId -> { count, at }
const GROUP_SIZE_TTL = 5 * 60 * 1000

async function getGroupMemberCount(groupId) {
  const cached = groupSizeCache.get(String(groupId))
  if (cached && Date.now() - cached.at < GROUP_SIZE_TTL) return cached.count
  try {
    const info = await gateway.callData('get_group_info', { group_id: Number(groupId) }, 8000)
    const n = Number(info?.member_count)
    if (Number.isFinite(n) && n > 0) {
      groupSizeCache.set(String(groupId), { count: n, at: Date.now() })
      return n
    }
  } catch (err) {
    logger.debug(`get_group_info 失败（用缓存/默认）: ${err.message}`)
  }
  return cached?.count ?? null
}

/**
 * 由群人数推导「说话欲望」。
 * 人数越少 → 越该开口（小群里沉默=冷场）；人数越多 → 越该克制（大群里插话=刷屏）。
 * @returns {{tier:string, ratio:number, hint:string, silentFloor:boolean}}
 */
function speakingTendency(memberCount) {
  const cfg = config.policy?.speaking ?? {}
  const small = cfg.smallGroupMax ?? 8
  const large = cfg.largeGroupMin ?? 50
  const n = Number.isFinite(memberCount) ? memberCount : null
  if (n === null) {
    return { tier: 'unknown', ratio: 0.5, hint: '', silentFloor: false }
  }
  if (n <= small) {
    return {
      tier: 'small',
      ratio: 0.85,
      silentFloor: true,
      hint: [
        `这是一个 ${n} 人的小群。小群里每个人说的话基本都跟他有关，`,
        '所以**默认应该接话**，沉默才是反常的。',
        '只有真的无话可说（别人之间的私下对话、你在忙）才用 [SILENT]。',
        '接话可以短、可以不完美，但别让人觉得你在无视他。',
      ].join('\n'),
    }
  }
  if (n >= large) {
    return {
      tier: 'large',
      ratio: 0.15,
      silentFloor: false,
      hint: [
        `这是一个 ${n} 人的大群。人多嘴杂，插话等于刷屏。`,
        '所以**默认沉默**，只有被点到、或有真正值得说的东西时才开口。',
      ].join('\n'),
    }
  }
  return {
    tier: 'medium',
    ratio: 0.45,
    silentFloor: false,
    hint: [
      `这是一个 ${n} 人的群，规模中等。`,
      '要不要接自己判断：话题跟你有关、或你有东西可说就接；纯路人闲聊可以沉默。',
    ].join('\n'),
  }
}
const lastActivity = new Map()

function peerOf(evt) {
  if (evt.message_type === 'group') return { id: String(evt.group_id), scope: 'group' }
  return { id: String(evt.user_id), scope: 'c2c' }
}

function peerKeyOf(peer) {
  return `${peer.scope}:${peer.id}`
}

/**
 * 判断是否处理这条消息。
 * 群聊现在「全部读取」，但区分两类：
 *   - addressed=true ：@ 了我 / 私聊 / 别人回复了我的消息 → 必须回
 *   - addressed=false：群里的普通闲聊（旁听） → 由模型自己决定说不说
 * 白名单/忽略自己/群限制这些硬过滤对两类都生效。
 */
function allowed(evt, peer, atMe) {
  const { policy } = config
  if (policy.ignoreSelf && String(evt.user_id) === String(gateway.selfId)) return { ok: false }
  if (peer.scope === 'group') {
    if (policy.allowGroups?.length && !policy.allowGroups.includes(peer.id)) return { ok: false }
    // 组内旁听：读全部消息，但仅在 readAllGroupMessages 开启时
    if (!atMe) {
      if (policy.readAllGroupMessages === false) return { ok: false }
      return { ok: true, addressed: false }
    }
    return { ok: true, addressed: true }
  }
  if (!policy.allowC2C) return { ok: false }
  if (policy.allowUsers?.length && !policy.allowUsers.includes(peer.id)) return { ok: false }
  return { ok: true, addressed: true }
}

async function handleInbound(evt) {
  if (evt.post_type !== 'message') return
  const peer = peerOf(evt)
  const flat = flattenMessage(evt.message)
  const atMe = flat.atMe || flat.replyToMe || (evt.message_type === 'c2c')
  const verdict = allowed(evt, peer, atMe)
  if (!verdict.ok) {
    logger.debug(`忽略消息 ${peerKeyOf(peer)} (allow 判定)`)
    return
  }
  const addressed = verdict.addressed !== false
  const peerKey = peerKeyOf(peer)
  const now = Date.now()

  // 情绪触发：对方说的话里有夸奖/怼/是否点到我
  for (const ev of detectMoodTriggers(flat.text, { addressed, atMe: flat.atMe })) {
    moodEvent(peerKey, ev.kind, ev.why)
  }

  // 节奏判定：他在连续发长消息吗？
  const rhythm = noteInboundRhythm(peerKey, (flat.text || '').length, addressed)
  let flurryMode = rhythm.flurry
  // 已经在「别接」静默期里，且这条没 @ 我 → 只记日志，不进 LLM（省一次调用）
  if (!addressed && inFlurrySilence(peerKey)) {
    logger.log(`flurry ${peerKey}: 他在连发（峰值 ${rhythm.peak ?? rhythm.count} 条），本条不接`)
    state.peers[peerKey] = state.peers[peerKey] ?? {}
    state.peers[peerKey].flurrySkips = (state.peers[peerKey].flurrySkips ?? 0) + 1
    saveState()
    return
  }
  const cool = config.policy.cooldownMsPerPeer ?? 0
  if (cool && now - (lastActivity.get(peerKey) ?? 0) < cool) {
    logger.debug(`冷却中，忽略 ${peerKey}`)
    return
  }
  if (busy.has(peerKey)) {
    // 旁听消息在上一条还在处理时直接丢弃（不排队），避免消息风暴把 LLM 打爆
    logger.log(`${peerKey} 正在处理上一轮，跳过本条${addressed ? '' : '（旁听）'}`)
    return
  }
  // 旁听：先看群多大，决定「说话欲望」。小群放宽节流（几乎都处理），大群收紧。
  let tendency = null
  const quiet = isQuietHours()
  if (!addressed && peer.scope === 'group') {
    const memberCount = await getGroupMemberCount(peer.id)
    tendency = speakingTendency(memberCount)
    // 深夜：把「该开口的倾向」打个折，但不归零、也不禁止
    if (quiet.quiet && tendency) {
      // 深夜要把「该接话」的语义也换掉，否则它和小群"默认应该接话"的提示打架。
      const quietHints = {
        small: [
          '这是一个小群，但**现在是深夜**。',
          '**默认不开口。** 这不是「30% 的概率说话」，而是：没被点到就不说。',
          '这条话你可以听完就过，不用回应——群里这个点本来就没人期待你回。',
          '**例外**（只有这两种才接）：有人直接问你；或者你确实有一句很想说的，那就说，但短。',
        ].join('\n'),
        medium: '今晚这个点群里应该很安静。**默认不开口**，除非有人直接问你或有真值得说的。',
        large: '深夜的大群基本没人说话。**默认不开口**。',
        unknown: '现在是深夜。**默认不开口**，除非有人直接问你。',
      }
      tendency = {
        ...tendency,
        ratio: Math.max(0.05, tendency.ratio * (quiet.cfg.passiveRatioFactor ?? 0.35)),
        hint: quietHints[tendency.tier] ?? quietHints.unknown,
        quiet: true,
      }
    }
    if (!tendency.silentFloor) {
      const win = config.policy.passiveWindowMs ?? 10000
      const baseMax = config.policy.passiveMaxPerWindow ?? 3
      const max = Math.max(1, Math.round(baseMax * (tendency.ratio / 0.45)))
      const nowTs = Date.now()
      const hist = (passiveHits.get(peerKey) ?? []).filter(t => nowTs - t < win)
      if (hist.length >= max) {
        logger.debug(`旁听节流 ${peerKey}: ${win}ms 内已处理 ${hist.length}/${max} 条（${tendency.tier}），丢弃本条`)
        return
      }
      hist.push(nowTs)
      passiveHits.set(peerKey, hist)
    } else {
      logger.debug(`小群旁听不节流 ${peerKey}（${tendency.tier}）`)
    }
  }
  lastActivity.set(peerKey, now)

  const senderName = evt.sender?.card || evt.sender?.nickname || String(evt.user_id)
  logger.log(`入站 ${peerKey} from=${senderName}(${evt.user_id}) text=${JSON.stringify(flat.text.slice(0, 80))} images=${flat.images.length}`)

  // 合并转发：展开成「谁说了什么」的纯文本，让模型能读到里面的对话
  let forwardText = ''
  if (flat.forwardIds.length) {
    forwardText = await expandForwards(flat.forwardIds)
    if (forwardText) logger.log(`已展开 ${flat.forwardIds.length} 条合并转发（${forwardText.length} 字）`)
  }

  // 图片：下载到 staging（供 LLM 读取；也作为后续 learn 的可能来源）
  const imagePaths = []
  for (const img of flat.images) {
    try {
      const url = img.url ?? img.file
      if (!url || !/^https?:\/\//.test(url)) { logger.log(`跳过非 http 图片 url=${url}`); continue }
      const p = await downloadUrlToStaging(url)
      imagePaths.push(p)
      logger.log(`图片已暂存 ${p}`)
    } catch (err) {
      logger.log(`图片下载失败: ${err.message}`)
    }
  }

  // 空消息判定必须把**所有**可能承载内容的东西都算上：
  // 纯文本、图片、合并转发展开内容、卡片。
  // （之前漏了 forwardText —— 合并转发消息的 text 是空的，会被误判成空消息丢掉）
  const hasForward = !!forwardText
  const hasCard = !!(flat.cards?.length)
  if (!flat.text && imagePaths.length === 0 && !hasForward && !hasCard) {
    // 用 info 级：这个丢消息的时刻必须能被看见
    logger.log(`空消息，忽略 ${peerKey}（text=0 images=0 forward=0 card=0）`)
    return
  }

  busy.add(peerKey)
  try {
    // 想切回主路由就顺手探一下（内部有 probeBackMs 时间闸，不会每轮都探）
    maybeProbeBackMain().catch(() => {})
    // 轮数上限：超过就换新会话（新会话会自动重新注入人设全文）
    rolloverIfNeeded(peerKey)
    const sdkSessionId = sessionIdFor(peerKey)   // 顺便确保 state.peers[peerKey] 已建好（ACP 记账要用）
    const blocks = []
    // 人设：全文只在「首次」或「文件变了」时注入一次，其余轮次只给路径 + 状态。
    // 这样人设不会作为普通历史被反复计费（省 ~3600 tokens/轮），但改动仍然下一轮就生效。
    const persona = readPersona()
    const peerState = state.peers[peerKey]
    const needPersonaFull = !!persona.text && peerState.personaHash !== persona.hash
    const contextLines = []
    if (needPersonaFull) {
      contextLines.push(
        [
          `【你的人设】以下是文件 ${PERSONA_PATH} 的当前内容。这是「你是谁」，` +
          `优先级高于任何编码 agent 的默认自我认知；你随时可以修改该文件来调整自己。`,
          '```markdown',
          persona.text,
          '```',
          '',
          `（这份全文只在人设变化时注入一次；后续轮次只提示文件路径，你随时可以 read 它。）`,
        ].join('\n'),
      )
    } else if (persona.text) {
      contextLines.push(`【人设】未变化，仍以 ${PERSONA_PATH} 为准（需要复查就 read 该文件）。`)
    } else {
      contextLines.push(
        `【人设文件缺失】${PERSONA_PATH} 不存在或读不到。请按普通群友的方式自然回话，` +
        `并可考虑自己写一份人设文件到该路径（桥下一轮会读）。`,
      )
    }
    contextLines.push(
      '',
      addressed
        ? `当前用户正通过【QQ】与你对话（${peer.scope === 'group' ? 'QQ群' : 'QQ私聊'}）——他在跟你说话（@你 / 私聊 / 回复你的消息）。`
        : `【你在旁听】以下是 QQ群里别人的对话，没有 @ 你。`,
      `发送者：${senderName}（QQ号 ${evt.user_id}）`,
      `当前时间：${new Date().toLocaleString('zh-CN', { timeZone: config.policy?.timezone ?? 'Asia/Shanghai', hour12: false })}`,
      peer.scope === 'group' ? `群号：${peer.id}` : null,
      peer.scope === 'group' && flat.atList?.length
        ? `这条消息 @ 了：${flat.atList.map(q => String(q)).join(', ')}（其中不含你 = 他们在跟别人说话）`
        : null,
      `你的 QQ 号：${gateway.selfId ?? '未知'}`,
      `你的人设文件：${PERSONA_PATH}（可读可改，改完下一轮生效）`,
      '',
    )
    if (flurryMode) {
      contextLines.push(
        '',
        '【⚠️ 这个人正在连着发消息，不是在跟你对话】',
        `他最近 ${Math.round((config.policy?.flurry?.windowMs ?? 45000) / 1000)} 秒内已经发了 ${rhythm.count} 条，其中大部分是长段落。`,
        '这看起来是在**输出内容/汇报进度/自己往下讲**，不是等你逐条点评。',
        '所以：**不用一条条接。** 可以选择：',
        '  - 只回 `[SILENT]`（最合适，如果他只是在讲）',
        '  - 挑这一次真正需要回应的点，说一句就够',
        '  - 如果他明确问了你，才正经答',
        '他发十条我回十条，就是噪音。先听着。',
      )
    }
    if (quiet.quiet) {
      contextLines.push('', quietHint(quiet.hour, quiet.cfg))
    }
    if (!addressed) {
      const t = tendency ?? speakingTendency(null)
      contextLines.push(
        '【你在旁听：这一条不一定需要回】',
        '- 你听到了这句话，但没人叫你。要不要接，你自己判断。',
        '- 想接就直接输出你想说的话（就像在群里插一句，不用 @ 谁）。',
        '- 不想接就**只输出 [SILENT] 这一行**，什么都别多说。',
        '',
        t.quiet
          ? `【本群规模·深夜模式】${t.hint || '(群人数未知)'}`
          : `【本群规模】${t.hint || '(群人数未知)'}`,
        t.quiet
          ? `【这一条的默认动作】沉默（[SILENT]），除非命中上面写的例外`
          : `【当前该开口的倾向】${t.tier}（约 ${Math.round(t.ratio * 100)}%）`,
        '',
        '- 不要为了刷存在感而说话；不要复述别人的话；不要科普。',
        '- 但也不要故作高深地沉默 —— 该聊的时候像个正常人一样聊。',
        '',
      )
    }
    const eh = energyHint(peerKey)
    if (eh) contextLines.push('', eh)
    const mh = moodHint(peerKey)
    if (mh) contextLines.push(mh)
    // 记忆摘要：让它在正常对话里也能"想起以前的事"，而不是只在主动搭话时才看
    const mem = readMemoryDigestFor(peerKey)
    if (mem) {
      contextLines.push(
        '',
        '【你记得的事】以下是你的见闻录摘要（memory/digest.md 的相关部分）：',
        mem,
        '提到以前的事就照着说，不确定就别硬编。想翻更细的可以 read memory/ 下的文件。',
      )
    }
    contextLines.push(
      `【硬约束】QQ 通道不认 [表情: 描述] 文字标记；要发表情包必须用 qq-meme skill 发送真实图片文件并输出 [SEND_FILE: 绝对路径]。`,
      `【硬约束】[SEND_FILE] 只放行会话工作区 (${config.dsh.cwd}) 与暂存目录 (${STAGING_DIR}) 内的文件。`,
    )
    if (config.bili?.enabled !== false) {
      contextLines.push(
        '',
        `【你能看 B站】你有这些工具（想用就用，不用请示）：`,
        `  bili_search <关键词>   → 搜视频，返回标题/BV号/播放量/UP/时长`,
        `  bili_subtitle <BV号>   → 拿**字幕全文**（判断视频讲了什么就靠它）`,
        `  bili_comments <BV号>   → 热门评论（看大家在玩什么梗）`,
        `  bili_cover <BV号>      → 封面图（能直接看到）`,
        `  bili_frames <BV号>     → 视频截图（1-6 帧，能看画面）`,
        `  bili_whoami            → 看 B站 登录状态`,
        '',
        '【什么时候看 B站】',
        '  - 有人发 BV 号/链接让你看 → **先 bili_subtitle 读字幕**，别凭标题瞎猜',
        '  - 群里在聊一个 B站 梗/视频/UP主，你不知道 → 可以搜一下',
        '  - 有人问「这个视频讲了啥」「这是谁」→ 查完用**人话**说结论',
        '  - 想知道某个梗的出处 → bili_search + bili_comments',
        '',
        '【注意】',
        '  - 看视频**不要**把字幕原文贴出来，提炼成人话',
        '  - 没字幕就直说「这视频没字幕我看不懂」，别编',
        '  - 一次最多查 1-2 个视频，别为了一个玩笑翻一堆；**不要主动刷**',
        '  - 涉及真人/UP主的评价保守点，别拿评论区的话当事实传播',
        '',
      )
    }
    if (config.tts?.enabled !== false) {
      const engineLabel = { gsv: 'GPT-SoVITS（本机，音色克隆）', piper: 'Piper（本机）', sherpa: 'sherpa-onnx（本机）', qq: 'QQ 内置音色' }
      contextLines.push(
        `【语音能力】你可以发**真语音**（本机 TTS 合成，不是 QQ 内置那种机械音）：`,
        `  引擎：${engineLabel[config.tts?.engine ?? 'gsv'] ?? config.tts?.engine}`,
        `  写法：[VOICE:要说的话]  → 直接用你自己的声音说`,
        `  一条上限 ${config.tts?.maxChars ?? 200} 字`,
        peer.scope === 'group' ? '' : '  （私聊也支持）',
        `【语音的使用分寸】群里语音比文字烦人（不能扫读、占屏幕），所以：`,
        `  - 只在**被明确要求**（"唱一个""说句话听听""语音回我"）、或一句话特别有情绪时才用`,
        `  - 通常 1-2 句就够，别一口气念一大段`,
        `  - 默认还是用文字；不要连着发语音`,
        `  - 不为了炫技而发语音`,
        `  - 语音和文字不要发同一句话（浪费）`,
        '',
      )
    }
    if (flat.cards?.length) {
      contextLines.push(
        '',
        '【这条消息是个分享卡片】',
        '你能看到的内容是：' + flat.cards.join(' / '),
        '卡片本身你打不开（看不到里面的视频/小程序/网页）。所以：',
        '  - 标题够看懂就顺着聊，别装作看过内容',
        '  - 想知道详情可以 bili_search 或搜一下标题',
        '  - 实在猜不出是什么就直说「这卡片我打不开，你说说是啥」',
      )
    }
    if (forwardText) {
      contextLines.push('', '【这条消息里带了一段合并转发的聊天记录，内容已展开如下】', forwardText)
    }
    if (imagePaths.length) {
      contextLines.push('', `用户本条消息附带了 ${imagePaths.length} 张图片，已暂存在：`)
      for (const p of imagePaths) contextLines.push(`- ${p}`)
      contextLines.push('如需查看可用 read_image 工具读取上述路径。若用户要求「入库/收藏/学图」，按 qq-meme skill 的 learn 流程处理。')
    }
    blocks.push({ type: 'text', text: contextLines.filter(Boolean).join('\n') })
    if (flat.text) {
      // ⚠️ 用户消息本身也是不可信输入：里面如果藏着 [SEND_FILE:...] 等标记，
      //    模型复述时会被桥当成指令执行。这里把标记打散（全角冒号），让它失去语义。
      blocks.push({ type: 'text', text: sanitizeUntrustedText(flat.text, { maxChars: 4000 }) })
    } else if (hasForward) {
      // 纯转发：不要再加图片占位符 —— ACP 会把两个 block 合并成一段，
      // 占位符会粘在转发内容屁股后面，让模型误以为图在转发里。
      // 转发内容里已经标了 [图片]，这里什么都不用补。
    } else if (hasCard) {
      // 纯卡片：同理，卡片文本已在上下文里
    } else {
      blocks.push({ type: 'text', text: '（用户只发了图片，没有文字）' })
    }

    const started = Date.now()
    // LLM 侧失败（模型目录刷新窗口、provider 抖动、超时）不该让整轮静默消失。
    // 重试一次；仍失败则用一句人话回过去，避免群里「发消息没人应」。
    let text
    try {
      ({ text } = await dsh.prompt(PROTOCOL === 'acp' ? peerKey : sdkSessionId, blocks))
    } catch (err) {
      logger.log(`LLM 第 1 次失败 ${peerKey}: ${err.message}；重试一次`)
      await sleep(1500)
      try {
        ({ text } = await dsh.prompt(PROTOCOL === 'acp' ? peerKey : sdkSessionId, blocks))
      } catch (err2) {
        logger.log(`LLM 重试仍失败 ${peerKey}: ${err2.message}`)
        await noteLlmFailure(err2)
        throw new Error(`模型暂时不可用（${err2.message}）`)
      }
    }
    // 人设注入成功后才记账：失败时下一轮会重新注入，不会因为异常而漏掉
    if (needPersonaFull) {
      peerState.personaHash = persona.hash
      peerState.personaInjectedAt = Date.now()
    }
    noteLlmSuccess()
    state.peers[peerKey].turns = (state.peers[peerKey].turns ?? 0) + 1
    // 「我最后一次发言」计时（主动搭话的基准）：只要真的发了东西就算发言
    touchLastSpoke(peerKey)
    energyDrop(peerKey)
    saveState()
    logger.log(`本轮完成 ${peerKey} ${Math.round((Date.now() - started) / 1000)}s 回复长度=${text.length}`)
    // 把回复**内容**也写进日志（截断到 500 字）：
    // 记忆系统只抓入站消息的话，就只剩「对方说了什么」，看不到「我回了什么」，
    // 于是记不住自己的态度/承诺/说过的话 —— 这是「记忆简陋」的根因之一。
    if (text && text.trim()) {
      const forLog = text.replace(/\s+/g, ' ').slice(0, 500).replace(/"/g, '\\"')
      logger.log(`出站 ${peerKey} text="${forLog}" chars=${text.length}`)
    }

    // 旁听模式下模型可以选择沉默：
    //   - 输出 [SILENT] → 明确表示不接
    //   - 或者干脆空回复
    // 两种情况都不发任何消息（但历史里已经记录了它"听过"这句话）。
    const silentMarked = /\[SILENT\]/i.test(text)
    const bodyText = text.replace(/\[SILENT\]/gi, '').trim()
    // 先抽出 [VOICE:文字:音色]（语音是独立动作，不是正文）
    const voices = []
    let textForSend = bodyText
    VOICE_RE.lastIndex = 0
    textForSend = textForSend.replace(VOICE_RE, (_all, vtext, vchar) => {
      voices.push({ text: String(vtext).trim(), character: vchar || null })
      return ''
    }).trim()

    // 再抽出 [POKE:qq]（同样是一个独立动作）
    const pokes = []
    POKE_RE.lastIndex = 0
    textForSend = textForSend.replace(POKE_RE, (_all, qq, scope) => {
      pokes.push({ qq, scope })
      return ''
    }).trim()

    // 「补一句」：抽出来，主消息发完后再补发（真人说漏了又补）
    const follows = []
    FOLLOW_RE.lastIndex = 0
    textForSend = textForSend.replace(FOLLOW_RE, (_all, t) => {
      const v = String(t).trim()
      if (v) follows.push(v)
      return ''
    }).trim()

    const { files, text: plain } = extractSendFiles(textForSend)

    if (!addressed && (silentMarked || (!plain && files.length === 0 && pokes.length === 0 && voices.length === 0))) {
      logger.log(`旁听→沉默 ${peerKey}（${silentMarked ? '[SILENT]' : '空回复'}），不发言`)
      state.peers[peerKey].silentSkips = (state.peers[peerKey].silentSkips ?? 0) + 1
      saveState()
      return
    }
    // 低精力时的字数兜底（v2-1）：提示可能被无视，所以这里做一层软截断。
    // 只截正文、只在精力 < 40% 时生效，且保留完整句子结尾。
    let cappedPlain = plain
    const cap = energyCharCap(peerKey)
    if (cappedPlain && Number.isFinite(cap) && cappedPlain.length > cap) {
      const cut = cappedPlain.slice(0, cap)
      const lastPunc = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('\n'))
      cappedPlain = lastPunc > cap * 0.4 ? cappedPlain.slice(0, lastPunc + 1).trim() : cut.trim() + '…'
      logger.log(`energyCap ${peerKey}: 回复从 ${plain.length} 字截到 ${cappedPlain.length} 字（精力低）`)
    }

    // 回话延迟（v2-2）：让回复节奏有快有慢，不是每条都秒回
    const dly = replyDelayMs(cappedPlain || '', peerKey)
    if (dly > 0) {
      logger.log(`replyDelay ${peerKey}: ${dly}ms（模拟人打字的时间）`)
      await sleep(dly)
    }
    if (cappedPlain) await sendTextTo(peer, cappedPlain)
    for (const f of files) {
      const abs = path.isAbsolute(f) ? f : path.resolve(config.dsh.cwd, f)
      await sendImageTo(peer, abs)
    }
    for (const v of voices) {
      if (config.tts?.enabled === false) { logger.log('tts 已禁用，语音降级为文字'); await sendTextTo(peer, v.text); continue }
      await sendVoiceTo(peer, v.text, v.character)
      await sleep(400)
    }
        // 补发的几句：间隔像真人想了一下（1.2-3.5 秒）
    for (const f of follows.slice(0, 2)) {
      await sleep(1200 + Math.random() * 2300)
      await sendTextTo(peer, f)
      logger.log(`follow ${peerKey}: 补发一句 ${JSON.stringify(f.slice(0, 40))}`)
    }

for (const p of pokes) {
      // 默认 @/戳 对端；显式 scope=c2c 时强制私聊戳
      await sendPokeTo(peer, p.qq, p.scope === 'c2c' ? 'c2c' : undefined)
      await sleep(300)
    }
  } catch (err) {
    logger.log(`处理消息异常 ${peerKey}: ${err.message}`)
    // 给群里一句人话，而不是把技术错误原文贴出去
    const friendly = /模型暂时不可用/.test(err.message)
      ? '脑子卡了一下，等下再说'
      : '刚刚没接住，你再说一遍？'
    try { await sendTextTo(peer, friendly) } catch { /* ignore */ }
  } finally {
    busy.delete(peerKey)
  }
}

// ── 入群欢迎 ────────────────────────────────────────────────────────────────
// OneBot 11 的群成员变动通知：post_type=notice, notice_type=group_increase。
// 只处理「有人进群」，不处理退群/被踢（那没必要播报）。
function handleGroupIncrease(evt) {
  const cfg = config.welcome ?? {}
  if (cfg.enabled === false) return
  const groupId = String(evt.group_id ?? '')
  if (!groupId) return
  if (Array.isArray(cfg.groups) && cfg.groups.length && !cfg.groups.map(String).includes(groupId)) return
  // 自己进群不欢迎自己（机器人被拉进新群时）
  if (String(evt.user_id) === String(gateway.selfId)) {
    logger.log(`自己被拉进群 ${groupId}，不发欢迎`)
    return
  }
  const nickname = evt.user_id ? `QQ ${evt.user_id}` : '新同学'
  const peer = { id: groupId, scope: 'group' }
  const template = cfg.template ?? '[CQ:at,qq={qq}] 新来的？报下名字和来路，别潜水。'
  const text = template.replaceAll('{qq}', String(evt.user_id ?? '')).replaceAll('{group}', groupId).replaceAll('{nickname}', nickname)

  if (cfg.useLlm === false) {
    logger.log(`欢迎新群友 ${evt.user_id} -> ${groupId}（固定文案）`)
    gateway.callData('send_group_msg', { group_id: Number(groupId), message: [{ type: 'text', data: { text } }] }, 20000)
      .catch(err => logger.log(`欢迎消息发送失败: ${err.message}`))
    return
  }

  // 走 LLM：让它按人设自己组织一句欢迎词（更像人、不模板化）
  const peerKey = `group:${groupId}:welcome`
  if (busy.has(peerKey)) return
  busy.add(peerKey)
  ;(async () => {
    try {
      // 欢迎语用**一次性临时会话**，不写进 state：每个新成员一个永久会话会无限堆积，
      // 而且欢迎语也不需要跨轮记忆。临时 id 用完即弃（session 日志留在磁盘上可追溯）。
      const welcomeSessionId = `session-welcome-${groupId}-${evt.user_id}-${Date.now()}`
      const persona = readPersona()
      const blocks = [
        { type: 'text', text: [
          persona.text
            ? `【人设】未变化，仍以 ${PERSONA_PATH} 为准（需要复查就 read 该文件）。`
            : `【人设文件缺失】${PERSONA_PATH}`,
          '',
          `【系统事件】QQ群 ${groupId} 有新成员加入。`,
          `新成员 QQ 号：${evt.user_id ?? '未知'}`,
          `你是这个群的成员之一（你的 QQ 号 ${gateway.selfId ?? '未知'}）。`,
          '',
          '请写一句欢迎他的话，要求：',
          '- 一句话，最多 25 字，口语，别用「欢迎加入本群」这种套话',
          '- 可以带一点你自己的语气/梗，但别强行幽默',
          '- **开头必须包含 [CQ:at,qq=' + (evt.user_id ?? '') + '] 来 @ 他**，否则他不知道在跟他说话',
          '- 不要介绍群规（你不是管理员），不要说自己是 AI，不要长篇',
          '- 只输出这一句话本身，不要解释',
        ].join('\n') },
      ]
      const { text } = await dsh.prompt(welcomeSessionId, blocks)
      const line = (text || '').trim().split('\n').filter(l => l.trim())[0] ?? ''
      if (!line) { logger.log('欢迎语为空，跳过'); return }
      // 保证 @ 段存在：模型可能忘了。同时支持两种写法：新式 [AT:qq] 与旧式 CQ 码
      const atSeg = { type: 'at', data: { qq: String(evt.user_id) } }
      const hasAt = /\[CQ:at,qq=/.test(line) || /\[AT:\d+\]/.test(line)
      logger.log(`欢迎新群友 ${evt.user_id} -> ${groupId}: ${JSON.stringify(line.slice(0, 60))}`)
      if (hasAt) {
        // 模型直接给了 CQ 码字符串，转成消息段发（发送时用 message 段更稳）
        const cleaned = line.replace(/\[CQ:at,qq=\d+\]/g, '').replace(/\[AT:\d+\]/g, '').trim()
        await gateway.callData('send_group_msg', {
          group_id: Number(groupId),
          message: [atSeg, ...(cleaned ? [{ type: 'text', data: { text: ' ' + cleaned } }] : [])],
        }, 20000)
      } else {
        await gateway.callData('send_group_msg', {
          group_id: Number(groupId),
          message: [atSeg, { type: 'text', data: { text: ' ' + line } }],
        }, 20000)
      }
    } catch (err) {
      logger.log(`欢迎流程失败，退回固定文案: ${err.message}`)
      try {
        await gateway.callData('send_group_msg', {
          group_id: Number(groupId),
          message: [{ type: 'at', data: { qq: String(evt.user_id) } }, { type: 'text', data: { text: ' ' + text } }],
        }, 20000)
      } catch { /* ignore */ }
    } finally {
      busy.delete(peerKey)
    }
  })()
}

// ── 戳一戳 ──────────────────────────────────────────────────────────────────
// OneBot11 的 poke 通知里，sender_id=发起者，target_id=被戳的人，group_id 可选。
// 只处理「戳的是我」的情况；别人互相戳不打扰模型（也不该刷屏）。
async function handlePoke(evt) {
  const cfg = config.poke ?? {}
  if (cfg.enabled === false) return
  const target = String(evt.target_id ?? evt.target ?? '')
  const senderId = String(evt.sender_id ?? evt.user_id ?? '')
  const selfId = String(gateway.selfId ?? '')
  if (!target || !selfId || target !== selfId) {
    logger.debug(`忽略别人的戳一戳 ${senderId} -> ${target}`)
    return
  }
  if (senderId === selfId) return // 自己戳的自己，忽略
  const isGroup = !!evt.group_id
  const peer = isGroup ? { id: String(evt.group_id), scope: 'group' } : { id: senderId, scope: 'c2c' }
  const peerKey = peerKeyOf(peer)
  if (busy.has(peerKey)) {
    logger.log(`${peerKey} 正忙，戳一戳先记账不回应`)
    return
  }
  busy.add(peerKey)
  ;(async () => {
    try {
      const who = isGroup ? `群 ${peer.id} 里的 ${senderId}` : `${senderId}`
      const persona = readPersona()
      const blocks = [
        { type: 'text', text: [
          persona.text ? `【人设】未变化，仍以 ${PERSONA_PATH} 为准。` : `【人设文件缺失】${PERSONA_PATH}`,
          '',
          `【有人在 QQ 上戳了你（拍了拍你）】`,
          `谁戳的：${who}（QQ号 ${senderId}）`,
          isGroup ? `群号：${peer.id}` : null,
          `你的 QQ 号：${selfId}`,
          '',
          '这是 QQ 的「戳一戳」互动，不是普通消息。你可以：',
          `- 戳回去：输出 [POKE:${senderId}]（不要文字也行）`,
          `- 说句话回应：正常输出文字`,
          `- 完全不理会：只输出 [SILENT]`,
          '',
          '别每次都一本正经回应，看心情和你跟这人的关系。一句话就够，别长篇。',
          `- 想真 @ 他就写 [AT:${senderId}]（会弹出提醒）`,
        ].filter(Boolean).join('\n') },
      ]
      const { text } = await dsh.prompt(PROTOCOL === 'acp' ? peerKey : sessionIdFor(peerKey), blocks)
      const silentMarked = /\[SILENT\]/i.test(text)
      let out = text.replace(/\[SILENT\]/gi, '').trim()
      const voices = []
      VOICE_RE.lastIndex = 0
      out = out.replace(VOICE_RE, (_a, vtext, vchar) => {
        voices.push({ text: String(vtext).trim(), character: vchar || null })
        return ''
      }).trim()
      const pokes = []
      POKE_RE.lastIndex = 0
      out = out.replace(POKE_RE, (_a, qq, scope) => { pokes.push({ qq, scope }); return '' }).trim()
      if (silentMarked && !out && !pokes.length && !voices.length) {
        logger.log(`戳一戳 -> 选择不理会（${peerKey}）`)
        return
      }
      if (out) await sendTextTo(peer, out)
      for (const v of voices) await sendVoiceTo(peer, v.text, v.character)
      for (const p of pokes) {
        await sendPokeTo(peer, p.qq, p.scope === 'c2c' ? 'c2c' : undefined)
        await sleep(300)
      }
      logger.log(`戳一戳已回应 ${peerKey}`)
    } catch (err) {
      logger.log(`戳一戳处理失败: ${err.message}`)
      // 兜底：戳回去，别让对方戳了个寂寞
      try { await sendPokeTo(peer, senderId) } catch { /* ignore */ }
    } finally {
      busy.delete(peerKey)
    }
  })()
}

gateway.onEvent = evt => {
  // 戳一戳：notice_type = poke（NapCat/OneBot11 扩展）。
  // 有人戳我 → 让模型知道，并允许它回应（戳回去 / 说话 / 不理）。
  if (evt.post_type === 'notice' && (evt.notice_type === 'poke' || evt.notice_type === 'notify' && evt.sub_type === 'poke')) {
    try { handlePoke(evt) } catch (err) { logger.log(`handlePoke 异常: ${err.message}`) }
    return
  }
  if (evt.post_type === 'notice' && evt.notice_type === 'group_increase') {
    try { handleGroupIncrease(evt) } catch (err) { logger.log(`handleGroupIncrease 异常: ${err.message}`) }
    return
  }
  handleInbound(evt).catch(err => logger.log(`handleInbound 未捕获异常: ${err.message}`))
}

// ── 压缩感知：上下文被 compaction 压掉之后，人设全文要重新注入一次 ──────────
// compaction 会把旧历史换成摘要，我们早先注入的人设全文可能落进被压缩区间。
// 所以一旦看到本 peer 的会话发生 compaction/end，就清掉 personaHash，
// 让下一轮重新注入全文（这样人设不会"失忆"）。
dsh.onEvent((sessionId, event) => {
  // SDK 事件有 type；ACP 的 update 有 sessionUpdate。压缩事件两边都按 type 判断。
  const evType = event?.type ?? event?.sessionUpdate
  if (evType !== 'compaction/end') return
  for (const peerKey of Object.keys(state.peers)) {
    if (state.peers[peerKey].sessionId !== sessionId) continue
    if (state.peers[peerKey].personaHash) {
      delete state.peers[peerKey].personaHash
      saveState()
      logger.log(`会话 ${sessionId} 发生上下文压缩，${peerKey} 的人设将在下一轮重新注入`)
    }
    (state.peers[peerKey].compactions = (state.peers[peerKey].compactions ?? 0) + 1)
    saveState()
  }
})

// ── 会话轮数上限：防止单个群会话无限增长 ────────────────────────────────────
// 超过上限就换一个新 sessionId（并清掉人设哈希，新会话会重新注入全文）。
// 旧会话仍留在磁盘上可追溯，但不再参与后续请求。
const MAX_TURNS_PER_SESSION = config.policy?.maxTurnsPerSession ?? 400

function rolloverIfNeeded(peerKey) {
  const ps = state.peers[peerKey]
  if (!ps || (ps.turns ?? 0) < MAX_TURNS_PER_SESSION) return false
  const old = ps.sessionId
  ps.sessionId = `session-qq-${crypto.randomUUID()}`
  ps.createdAt = Date.now()
  ps.turns = 0
  ps.rolledFrom = old
  delete ps.personaHash // 新会话要重新注入人设
  saveState()
  logger.log(`${peerKey} 已达 ${MAX_TURNS_PER_SESSION} 轮，切换新会话 ${old} -> ${ps.sessionId}`)
  return true
}

// ── 本地 HTTP 状态/发送 API（运维用，只绑 127.0.0.1）──────────────────────
function startApiServer() {
  const sc = config.server
  if (!sc?.enabled) return null
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(obj))
    }
    // /qr 是登录二维码的明文图片，本身不是秘密（是给手机扫的），
    // 但只在没有 token 时也允许读，方便在浏览器里直接打开看最新码。
    if (url.pathname === '/qr' || url.pathname === '/qr.png') {
      const p = path.join(ROOT, 'llminqq-qr.png')
      if (!fs.existsSync(p)) return send(404, { ok: false, error: 'no qr yet; run scripts/qr.sh' })
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
      return res.end(fs.readFileSync(p))
    }
    if (sc.token && req.headers['authorization'] !== `Bearer ${sc.token}`) {
      return send(401, { ok: false, error: 'unauthorized' })
    }
    if (url.pathname === '/health') {
      return send(200, {
        ok: true,
        onebot: { online: gateway.online, selfId: gateway.selfId, nickname: gateway.nickname, url: config.onebot.wsUrl },
        dsh: {
          ready: dsh.ready,
          profile: config.dsh.profile,
          route: `${config.dsh.provider}/${config.dsh.model}`,
          currentRoute: `${routeState.current.provider}/${routeState.current.model}`,
          failover: {
            enabled: FAILOVER.enabled,
            fallbackCount: ROUTE_FALLBACKS.length,
            fallbackIndex: routeState.fallbackIndex,
            consecutiveFailures: routeState.consecutiveFailures,
            switches: routeState.switches,
            lastSwitchAt: routeState.lastSwitchAt || null,
          },
        },
        peers: Object.keys(state.peers).length,
        busy: [...busy],
        persona: { path: PERSONA_PATH, exists: !!readPersona().text },
        sessions: state.peers,
      })
    }
    if (url.pathname === '/peers') return send(200, { ok: true, peers: state.peers })
    if (url.pathname === '/send' && req.method === 'POST') {
      let body = ''
      for await (const chunk of req) body += chunk
      let payload
      try { payload = JSON.parse(body) } catch { return send(400, { ok: false, error: 'bad json' }) }
      const peer = { id: String(payload.peerId ?? payload.groupId ?? payload.userId), scope: payload.scope ?? (payload.groupId ? 'group' : 'c2c') }
      if (!peer.id || peer.id === 'undefined') return send(400, { ok: false, error: 'peerId required' })
      try {
        if (payload.text) await sendTextTo(peer, String(payload.text))
        const sent = []
        for (const f of payload.files ?? []) sent.push({ file: f, ok: await sendImageTo(peer, f) })
        return send(200, { ok: true, files: sent })
      } catch (err) { return send(500, { ok: false, error: err.message }) }
    }
    return send(404, { ok: false, error: 'not found' })
  })
  server.listen(sc.port, sc.host ?? '127.0.0.1', () => logger.log(`本地 API: http://${sc.host}:${sc.port}`))
  return server
}

// ── 启动 ────────────────────────────────────────────────────────────────────
async function main() {
  logger.log('=== LLMinQQ bridge 启动 ===')
  logger.log(`config: ${cfgPath}`)
  const apiServer = startApiServer()
  pruneStaging()
  setInterval(pruneStaging, 3600 * 1000).unref()
  startProactiveLoop()
  startEnergyLoop()
  startMoodLoop()
  dsh.start().catch(err => logger.log(`dsh 预热失败（首次消息时会重试）: ${err.message}`))
  await gateway.start()
  logger.log('onebot 网关已启动，等待消息')

  const shutdown = async sig => {
    logger.log(`收到 ${sig}，正在关闭…`)
    try { gateway.stop() } catch { /* ignore */ }
    try { dsh.stop() } catch { /* ignore */ }
    apiServer?.close()
    saveState()
    await sleep(600)
    logStream.end()
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch(err => {
  logger.log(`致命错误: ${err.stack ?? err.message}`)
  process.exit(1)
})
