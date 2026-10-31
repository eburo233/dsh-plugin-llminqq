// 消息形态处理：SEND_FILE/语音指令解析、卡片解析、合并转发展开。
//
// 从 index.js 拆出来（2026-10-29）。拆分原则：纯搬运，函数体一字不改。
//
// 为什么单独一个模块：
//   · 都是「把别人的消息形态转成可读文本 / 把自己的指令转成动作」的逻辑
//   · 依赖 security.js（净化、URL 守卫）和 common.js（拆句、段转换）—— 这正是
//     那两层存在的意义
//   · 以前测卡片解析要加载 177 KB 的 index.js
//
// 依赖注入：
//   config / logger / gateway —— 运行时对象
//   security                    —— createSecurity() 的返回值
//   deps                        —— 其他零散注入（TTS 路径等）

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { SEND_FILE_RE } from './common.js'

export function createMessaging ({ config, logger, gateway, security, noteSelfSent, sendTextTo }) {
  const { STAGING_DIR, SENSITIVE, MAX_FILE, checkUrlSafe, sanitizeUntrustedText } = security

  // ↓↓↓ 以下为原 index.js 三段原样搬运 ↓↓↓

// ── SEND_FILE / 语音指令 ────────────────────────────────────────────────────
const VOICE_MAX_CHARS = 120        // AI 语音单条上限（太长会被截断/拒绝）
const DEFAULT_AUDIO_CHARACTER = 'lucy-voice-male1' // 憨憨小弟，与「小吉祥物」自嘲定位最搭
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
  // ── 在线 API（OpenAI 兼容 /audio/speech）────────────────────────────────
  //   兼容: OpenAI、Azure OpenAI、硅基流动、DeepSeek 系、以及任何实现了
  //   POST /audio/speech {model,input,voice,response_format} 的服务。
  //   为什么要这个：本机 TTS 要模型+显存+下载，很多用户机器带不动；
  //   在线 API 只要一个 key 就能出声，是「开箱即用」最省事的一条路。
  if (engine === 'openai') {
    const o = tts.openai ?? {}
    const url = o.url || 'https://api.openai.com/v1/audio/speech'
    const headers = { 'content-type': 'application/json' }
    if (o.apiKey) headers.authorization = `Bearer ${o.apiKey}`
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: o.model || 'tts-1',
        input: text,
        voice: o.voice || 'alloy',
        response_format: o.format || 'mp3',
        speed: o.speed ?? 1.0,
      }),
      signal: AbortSignal.timeout(o.timeoutMs ?? 60000),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`${url} HTTP ${res.status}${detail ? ': ' + detail.slice(0, 120) : ''}`)
    }
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 200) throw new Error(`${url} 返回过小 (${buf.length}B)`)
    // 在线 API 多半给 mp3/opus；QQ 的 record 段吃这些没问题（NapCat 会转）
    const fmt = (o.format || 'mp3').toLowerCase()
    const out = path.join(STAGING_DIR, `tts_${Date.now()}_${crypto.randomBytes(3).toString('hex')}.${fmt}`)
    fs.writeFileSync(out, buf)
    return out
  }

  // ── MiniMax T2A v2（国内直连，返回 JSON + hex 音频）───────────────────────
  //   和 OpenAI 那套不一样：它是 POST /v1/t2a_v2?GroupId=xx，
  //   返回 { data: { audio: "<hex>" }, base_resp: { status_code, status_msg } }
  //   所以不能直接当二进制落盘，要 JSON 解析 + hex 解码。
  if (engine === 'minimax') {
    const mm = tts.minimax ?? {}
    if (!mm.apiKey) throw new Error('MiniMax 缺少 apiKey（在设置页「语音」里填）')
    const base = mm.url || 'https://api.minimaxi.com/v1/t2a_v2'
    const url = mm.groupId ? `${base}?GroupId=${encodeURIComponent(mm.groupId)}` : base
    const fmt = (mm.format || 'mp3').toLowerCase()
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${mm.apiKey}` },
      body: JSON.stringify({
        model: mm.model || 'speech-2.5-hd-preview',
        text,
        stream: false,
        // 非流式才能拿 hex；url 形式也行但 24h 过期，不如本地存
        output_format: 'hex',
        voice_setting: {
          voice_id: mm.voiceId || 'female-shaonv',
          speed: mm.speed ?? 1.0,
          vol: mm.vol ?? 1.0,
          pitch: mm.pitch ?? 0,
          ...(mm.emotion ? { emotion: mm.emotion } : {}),
        },
        audio_setting: {
          sample_rate: mm.sampleRate ?? 32000,
          bitrate: mm.bitrate ?? 128000,
          format: fmt,
          channel: 1,
        },
        language_boost: mm.languageBoost || 'auto',
      }),
      signal: AbortSignal.timeout(mm.timeoutMs ?? 120000),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`${url} HTTP ${res.status}${detail ? ': ' + detail.slice(0, 120) : ''}`)
    }
    const json = await res.json().catch(() => null)
    if (!json) throw new Error('MiniMax 返回不是 JSON')
    const code = json.base_resp?.status_code
    if (code !== 0 && code !== undefined) {
      throw new Error(`MiniMax status_code=${code}: ${json.base_resp?.status_msg || '未知错误'}`)
    }
    const hex = json.data?.audio
    if (!hex || typeof hex !== 'string') throw new Error('MiniMax 返回里没有 data.audio')
    const buf = Buffer.from(hex, 'hex')
    if (buf.length < 200) throw new Error(`MiniMax 音频过小 (${buf.length}B)`)
    const out = path.join(STAGING_DIR, `tts_${Date.now()}_${crypto.randomBytes(3).toString('hex')}.${fmt}`)
    fs.writeFileSync(out, buf)
    return out
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
  noteSelfSent(peer, res, 'record')
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
  for (const e of ['gsv', 'piper', 'sherpa', 'openai', 'minimax']) if (e !== preferred) engines.push({ kind: e })
  engines.push({ kind: 'qq' })

  for (const { kind } of engines) {
    try {
      if (kind === 'qq') {
        // QQ 内置音色只支持群聊
        if (peer.scope !== 'group') continue
        const character = resolveVoiceCharacter(characterName)
        const aiRes = await gateway.callData('send_group_ai_record', {
          group_id: Number(peer.id), character, text: clipped,
        }, 60000)
        noteSelfSent(peer, aiRes, 'voice')
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

// ── 卡片消息解析 ────────────────────────────────────────────────────────────
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

  // 卡片里的所有文字都是**别人构造的**，先净化再用
  const clean = (x) => sanitizeUntrustedText(x, { maxChars: 120 })
  // ⚠️ 顺序有讲究：obj.prompt 通常只是一句「[QQ小程序]哔哩哔哩」这种壳，
  // 真正的内容标题在 meta.* 里。所以 prompt 放最后兜底，别抢了标题。
  let title = clean(pick(
    d1.title, news.title, music.title, detail.title,
    obj.desc, obj.title,
    obj.prompt,
  ))
  let desc = clean(pick(
    d1.desc, news.desc, music.desc, detail.desc,
    obj.prompt,
  ))
  const source = clean(pick(d1.tag, d1.source, news.tag, music.tag, detail.tag))
  // 「哔哩哔哩 / 微信读书」这类小程序卡片，detail_1.title 放的是**应用名**，
  // 真标题（视频名、书名）在 desc 里。判据：title 和 tag 一样，或 desc 明显更长。
  const app = pick(obj.app, obj.meta?.detail_1?.app).toLowerCase()
  if (desc && (title === source || (app.includes('miniapp') && desc.length > title.length))) {
    const swapped = title
    title = desc
    desc = swapped === source ? '' : swapped
  }
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

function xmlToText(raw) {
  if (typeof raw !== 'string' || !raw) return '[卡片]'
  const m = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(raw)
  const d = /<summary[^>]*>([^<]{1,200})<\/summary>/i.exec(raw)
  const part = (m?.[1] || d?.[1] || '').trim()
  return part ? `[卡片] ${part}`.slice(0, CARD_MAX_CHARS) : '[卡片]'
}

// ── 合并转发展开 ────────────────────────────────────────────────────────────
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
/**
 * 取一条被引用消息的原文。
 *
 * 为什么需要：OneBot 的 `reply` 段**只有 message_id**，没有内容
 * （实测：`{"type":"reply","data":{"id":"1021708560"}}`）。
 * 所以「他回复了某条消息」这件事桥只知道发生了，不知道回复的是什么 ——
 * 模型会说「你回的那条我没看到」。
 * 这里用 `get_msg` 把内容取回来。
 *
 * @param {string} messageId
 * @returns {Promise<{ok:boolean, from?:string, text?:string, reason?:string}>}
 */
async function quoteOf(messageId) {
  if (!messageId) return { ok: false, reason: 'no id' }
  try {
    const data = await gateway.callData('get_msg', { message_id: Number(messageId) || messageId }, 10000)
    if (!data) return { ok: false, reason: 'get_msg 返回空' }
    const segs = Array.isArray(data.message) ? data.message : []
    // 复用现成的段→纯文本（会标 [图片]/[表情] 等）
    let text = segToPlainText(segs)
    if (!text) text = String(data.raw_message ?? '').trim()
    if (!text) return { ok: false, reason: '该消息没有文字内容' }
    const who = data.sender?.card || data.sender?.nickname || (data.sender?.user_id ? String(data.sender.user_id) : '某人')
    const isSelf = String(data.sender?.user_id ?? '') === String(gateway.selfId ?? '')
    return {
      ok: true,
      from: isSelf ? '我' : who,
      text: text.replace(/\s+/g, ' ').trim().slice(0, 300),
    }
  } catch (err) {
    return { ok: false, reason: String(err?.message ?? err).slice(0, 100) }
  }
}

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

  // ↑↑↑ 原样搬运结束 ↑↑↑

  return {
    VOICE_MAX_CHARS, DEFAULT_AUDIO_CHARACTER, VOICE_CHARACTERS,
    resolveVoiceCharacter, synthesizeToFile, sendRecordFile, sendVoiceTo,
    extractSendFiles,
    CARD_MAX_CHARS, cardJsonToText, xmlToText,
    FORWARD_MAX_MSGS, FORWARD_MAX_CHARS,
    segToPlainText, quoteOf, expandForwards,
  }
}
