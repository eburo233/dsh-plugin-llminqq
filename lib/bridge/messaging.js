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
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { SEND_FILE_RE, formatBytes } from './common.js'

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
    // ⚠️ 2026-11-02 实测：GSV 的 api.py 对 refer_wav_path/prompt_text/prompt_language
    //    是**整组回退** —— 任意一项为空就全部改用启动参数 -dr/-dt/-dl。
    //    所以没填 promptText 时，设置页里选的参考音频会被启动参数写死的 ref.wav 顶掉，
    //    用户听到的永远是默认音色（表现："设置页换了声音，QQ 里没变"）。
    //    这里只警告一次，真正的修法是把参考文本填全 + 用 scripts/start-gsv.mjs 启动。
    if (!g.promptText) {
      logger?.log?.('WARN tts.gsv.promptText 为空：GSV 会把 refer_wav_path 一并回退到启动参数，设置页的参考音色不会生效')
    }
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

// ── 入站文件下载（群文件 / 私聊文件）─────────────────────────────────────────
//
// 2026-11-03 用户要求（task-6）：对方发来的**文件**不再只给占位 —— 真的下载到
// 暂存区，让模型能 read/read_image 看内容。
//
// 2026-11-03 晚间按**真机**形状修正（容器内 /app/napcat/napcat.mjs 的实际实现，
// 不是 OneBot 文档 —— 文档对字段名/接口参数的说法有出入）：
//   · file 段 = { file: <文件名>, file_id: <fileUuid>, file_size, url? }：
//     名字在 `file`（**不是** file_name）；packet 后端可用时**段里直接带 url**；
//   · 群文件地址接口真实入参只有 {group_id, file_id}（busid 被忽略，有就带、没有别造）；
//   · 私聊用 {user_id, file_id} → {url}；
//   · 通用兜底 get_file {file: <file_id>} → {file, url, file_size, file_name}；
//   · 群在线文件/文件夹是**另一个段** onlinefile（没有 url）→ 不进来，只占位。
//
// 所以下载顺序是：段内 url（省一次 API）→ get_*_file_url → get_file → 降级原因。
//
// 为什么放在 messaging.js：和 quoteOf / expandForwards 是同一类「入站消息形态处理」，
// 而且 createMessaging 已经注入了 gateway + security —— 单测用假 gateway 就能跑，
// 不用起整个桥。
//
// 安全边界：
//   · url 可能来自 OneBot 响应、也可能来自消息段，**一律**交给 security 的
//     checkUrlSafe/safeFetchBuffer（SSRF、重定向逐跳检查、大小上限）；
//   · 文件名是群友可控的 → security.downloadInboundFile 内部 sanitize；
//   · 只落暂存区，不执行；失败一律降级成「占位 + 原因」，绝不让整轮崩掉。
//
// 默认开启（用户明确同意），可用 config.media.inboundFileEnabled === false 关掉；
// 上限/条数/超时都能被 config.media.* 覆盖（见下面常量）。
const INBOUND_FILE_DEFAULTS = {
  maxBytes: 20 * 1024 * 1024,   // 单文件上限
  maxFiles: 5,                  // 单条消息最多处理几个（防刷屏/拖垮）
  timeoutMs: 30000,             // 取 url / 下载的超时
}

/** 读一个入站文件段（flattenMessage 收集的）的数值配置，非法值回落默认。 */
function inboundFileCfg () {
  const media = config.media ?? {}
  const num = (v, d) => (Number(v) > 0 ? Number(v) : d)
  return {
    enabled: media.inboundFileEnabled !== false,
    maxBytes: num(media.maxInboundFileBytes, INBOUND_FILE_DEFAULTS.maxBytes),
    maxFiles: Math.max(1, Math.floor(num(media.maxInboundFiles, INBOUND_FILE_DEFAULTS.maxFiles))),
    timeoutMs: num(media.inboundFileTimeoutMs, INBOUND_FILE_DEFAULTS.timeoutMs),
  }
}

/**
 * 一条文件段在日志里的「形状」：只列字段名，不列值。
 *
 * 为什么要它：真机字段名改过一次（文件名从 file_name 变成 file），失败日志只写
 * 「拿不到下载地址」的话，根本分不清是**字段对不上**还是接口/网络问题；而把整段
 * JSON 打出来又会把带 rkey 的下载 URL 漏进日志。
 *
 * @param {{segKeys?:string[]}} f flattenMessage 收集的文件段（带原始字段名）
 * @returns {string} 例如 "file,file_id,file_size,url"
 */
function inboundSegShape (f) {
  const keys = Array.isArray(f?.segKeys) && f.segKeys.length
    ? f.segKeys
    : Object.keys(f ?? {}).filter(k => k !== 'segKeys')
  return keys.slice(0, 12).join(',') || '-'
}

/**
 * 取文件下载地址。顺序按**真机**来：
 *   ① 段里直接给的 url —— 本机 packet 后端可用时就有，省一次 API、少一个失败点；
 *   ② 群文件 get_group_file_url / 私聊 get_private_file_url —— 真机群文件 handler
 *      只用 {group_id, file_id}（busid 被忽略），所以没有 busid 就**不要传 0**；
 *   ③ 通用兜底 get_file {file: <file_id>} → {file, url, file_size, file_name}，
 *      有些实现只在这一个接口返回 url。
 *
 * @returns {Promise<{url:string, via:string, name?:string, size?:number, reason?:string}>}
 *   拿不到 url 时 url 为空串、reason 给原因；不抛错（调用方负责降级成占位 + 原因）。
 */
async function resolveInboundFileUrl (peer, f, timeoutMs) {
  const shape = inboundSegShape(f)

  // ① 段内 url 优先：真机 packet 后端直接把下载地址放在段里
  const direct = String(f.url ?? '').trim()
  if (direct) return { url: direct, via: 'event' }

  const fid = String(f.file_id ?? '').trim()
  if (fid) {
    const action = peer.scope === 'group' ? 'get_group_file_url' : 'get_private_file_url'
    // 群文件：busid 有就带（部分实现要），没有就留空 —— 真机 handler 忽略它，
    // 传一个假的 0 只会让后来的人误以为它是必需参数。
    const params = peer.scope === 'group'
      ? {
          group_id: Number(peer.id),
          file_id: fid,
          ...(f.busid != null && f.busid !== '' ? { busid: Number(f.busid) || 0 } : {}),
        }
      : { user_id: Number(peer.id), file_id: fid }
    try {
      const data = await gateway.callData(action, params, timeoutMs)
      if (data?.url) return { url: String(data.url), via: action }
    } catch (err) {
      // 取不到 url 不算致命：下面还有 get_file 兜底（会把段形状写进日志）
      logger.log(`入站文件取 url 失败（${peer.scope} ${action}）段字段=[${shape}]: ${err.message}`)
    }
  }

  // ③ 通用兜底 get_file：真机返回 {file, url, file_size, file_name}
  if (fid) {
    try {
      const data = await gateway.callData('get_file', { file: fid }, timeoutMs)
      // 优先 data.url；个别实现把地址放在 data.file 里
      const url = String(data?.url ?? data?.file ?? '').trim()
      if (url) {
        return {
          url,
          via: 'get_file',
          name: String(data?.file_name ?? data?.name ?? '').trim(),
          size: Number(data?.file_size ?? 0) || 0,
        }
      }
    } catch (err) {
      logger.log(`入站文件 get_file 兜底失败（${peer.scope}）段字段=[${shape}]: ${err.message}`)
    }
  }
  return { url: '', via: '', reason: '拿不到下载地址（接口未返回 url，可能已过期）' }
}

/**
 * 下载一条消息里的全部文件段。
 *
 * @param {{id:string, scope:'group'|'c2c'}} peer
 * @param {Array<{file_id?:string, file_name?:string, file?:string, file_size?:number|string, busid?:number, url?:string, segKeys?:string[]}>} files
 *   flattenMessage 收集的文件段（真机形状见文件头注释）
 * @returns {Promise<Array<{name:string, size:number, ok:boolean, path:string, reason:string}>>}
 *   永远不 reject；每条文件对应一条结果（ok=false 时 reason 会进上下文）。
 */
async function downloadInboundFiles (peer, files) {
  const cfg = inboundFileCfg()
  const list = Array.isArray(files) ? files.filter(Boolean) : []
  const out = []
  if (!cfg.enabled || !list.length) return out
  for (const f of list.slice(0, cfg.maxFiles)) {
    // 真机：名字在 file（flattenMessage 已归一成 file_name），file_size 可能是字符串
    const name = String(f.file_name ?? f.file ?? f.name ?? '').trim() || '(未知文件名)'
    const size = Number(f.file_size ?? f.size) || 0
    const shape = inboundSegShape(f)
    const rec = { name, size, ok: false, path: '', reason: '' }
    let via = ''
    try {
      // 先按事件里给的大小挡一次：明显超限就不浪费一次下载
      if (size > cfg.maxBytes) {
        rec.reason = `超过大小上限 ${formatBytes(cfg.maxBytes)}，未下载`
        out.push(rec)
        logger.log(`入站文件跳过（超限）${peer.scope}:${peer.id} ${name} ${size}B > ${cfg.maxBytes}B 段字段=[${shape}]`)
        continue
      }
      const resolved = await resolveInboundFileUrl(peer, f, cfg.timeoutMs)
      via = resolved.via
      if (!resolved.url) {
        rec.reason = resolved.reason || '拿不到下载地址（可能已过期）'
        out.push(rec)
        logger.log(`入站文件拿不到下载地址 ${peer.scope}:${peer.id} ${name} 段字段=[${shape}]`)
        continue
      }
      // 段里没名字/没大小时，用兜底接口返回的补上（get_file 真机就带 file_name/file_size）
      if (rec.name === '(未知文件名)' && resolved.name) rec.name = resolved.name
      if (!rec.size && resolved.size) {
        rec.size = resolved.size
        if (rec.size > cfg.maxBytes) {
          rec.reason = `超过大小上限 ${formatBytes(cfg.maxBytes)}，未下载`
          out.push(rec)
          logger.log(`入站文件跳过（接口返回超限）${peer.scope}:${peer.id} ${rec.name} ${rec.size}B > ${cfg.maxBytes}B 段字段=[${shape}]`)
          continue
        }
      }
      const got = await security.downloadInboundFile(resolved.url, rec.name, {
        maxBytes: cfg.maxBytes,
        timeoutMs: cfg.timeoutMs,
      })
      rec.ok = true
      rec.path = got.path
      rec.size = got.size || rec.size
      logger.log(`入站文件已下载 ${peer.scope}:${peer.id} ${rec.name} → ${got.path}（${got.size}B，via ${via}）`)
    } catch (err) {
      // 失败降级：占位文本（flattenMessage 生成）还在，这里只补一句原因
      rec.reason = String(err?.message ?? err).slice(0, 120)
      // 段形状进日志：真机出问题时一眼看出是字段对不上还是网络/接口问题（url 不外泄）
      logger.log(`入站文件下载失败 ${peer.scope}:${peer.id} ${rec.name} 段字段=[${shape}]${via ? `（via ${via}）` : ''}: ${rec.reason}`)
    }
    out.push(rec)
  }
  const skipped = list.length - Math.min(list.length, cfg.maxFiles)
  if (skipped > 0) {
    out.push({
      name: `（另外 ${skipped} 个文件未处理）`, size: 0, ok: false, path: '',
      reason: `单条消息最多处理 ${cfg.maxFiles} 个文件`,
    })
  }
  return out
}

// ── 语音转文字（QQ 语音 ASR，2026-11-03 task-10）────────────────────────────
//
// 为什么做：QQ 语音消息以前只有 `[语音] 5s` 占位，模型完全不知道对方说了什么，
// 只能回「你说了啥」——用户明确问过「语音转写能不能用插件内现有的」。
// 插件里原本没有 QQ 语音 ASR，这里把 legacy 分支的 faster-whisper 方案搬进来。
//
// 为什么默认关（enabled 必须显式 true）：
//   · 要装依赖（faster-whisper）+ 首次下载模型（small ≈ 480MB）；
//   · CPU 转写要几秒 —— 不该在用户不知情时改变回复节奏；
//   · 关着时**完全不 spawn python、不下载音频**，零开销。
//
// 音频来源：真机 voice 段的 url 优先（走 security.downloadInboundFile，
// SSRF/大小上限/文件名净化全部复用入站文件那套）；没有 url 才用段里的 path ——
// 那是 NapCat 容器内路径，桥在宿主机上通常读不到，必须明确降级说明。
//
// 超时：index.js 给整条消息一个总预算（config.media.voiceTranscribe.timeoutMs），
// 这里内部按剩余时间 SIGKILL python；超时只返回 ok:false，绝不挂住整轮回复。
const VOICE_TRANSCRIBE_DEFAULTS = {
  enabled: false,                                  // 默认关：见上面注释
  engine: 'faster-whisper',
  model: 'small',                                  // 用户拍板：small（中文准确率/体积平衡点）
  lang: 'zh',
  pythonBin: process.platform === 'win32' ? 'python' : 'python3',
  // 插件自带脚本；bridgeConfig 会显式传绝对路径，这里只是兜底
  script: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'agent', 'asr', 'transcribe.py'),
  timeoutMs: 30000,                                // 整条消息的转写总预算
  maxBytes: 20 * 1024 * 1024,                      // 语音一般几十 KB，上限只是保险
}
const ASR_MODELS = ['tiny', 'base', 'small', 'medium']
const ASR_ENGINES = ['faster-whisper', 'funasr']
const ASR_MAX_VOICES = 3      // 单条消息最多转几条（防 3 条语音各耗 30s）
const ASR_CACHE_MAX = 100     // 内存去重缓存上限（只缓存成功结果）
// 同一 file_id 不重复转写。缓存放在 createMessaging 闭包里：每个桥实例一份，
// 测试之间天然隔离；不进 state，重启后重转一次也无所谓（语音很少）。
const asrCache = new Map()

/**
 * 读 config.media.voiceTranscribe，非法值回落默认。
 *
 * 桥侧只做「非法值回落」，**不做区间 clamp**（和入站文件、cooldown 一个约定）：
 * 真正的区间约束在插件侧 lib/index.js 的 voiceTranscribeMedia()。
 * enabled 只认显式 true —— 老 bridge-config.json 里没有这个键，默认就是关。
 */
function voiceTranscribeCfg () {
  const v = config.media?.voiceTranscribe ?? {}
  const num = (x, d) => (Number(x) > 0 ? Number(x) : d)
  const pick = (x, list, d) => (list.includes(String(x ?? '').trim()) ? String(x).trim() : d)
  return {
    enabled: v.enabled === true,
    engine: pick(v.engine, ASR_ENGINES, VOICE_TRANSCRIBE_DEFAULTS.engine),
    model: pick(v.model, ASR_MODELS, VOICE_TRANSCRIBE_DEFAULTS.model),
    lang: String(v.lang ?? '').trim() || VOICE_TRANSCRIBE_DEFAULTS.lang,
    pythonBin: String(v.pythonBin ?? '').trim() || VOICE_TRANSCRIBE_DEFAULTS.pythonBin,
    script: String(v.script ?? '').trim() || VOICE_TRANSCRIBE_DEFAULTS.script,
    timeoutMs: num(v.timeoutMs, VOICE_TRANSCRIBE_DEFAULTS.timeoutMs),
    maxBytes: num(v.maxBytes, VOICE_TRANSCRIBE_DEFAULTS.maxBytes),
    hfHome: String(v.hfHome ?? '').trim(),
    // NapCat 落盘目录（宿主机视角）。⭐ 2026-11-04 复盘第④层：消息段里的 url 是
    // QQ 多媒体 CDN 的**低码率重转码 AMR**（实测 5.6kbps），whisper+VAD 直接判
    // 「没人说话」；NapCat 自己收的原件（silk v3）在本地挂载盘里、音质正常。
    // 默认从 STAGING_DIR（<dataDir>/.qq-media）反推 <dataDir>/napcat/data/qq，
    // 设置页/bridge-config 可用 napcatDataDir 显式覆盖（NapCat 数据不在插件目录下时）。
    napcatDataDir: String(v.napcatDataDir ?? '').trim() ||
      path.join(path.dirname(STAGING_DIR), 'napcat', 'data', 'qq'),
  }
}

/**
 * 按段里的文件名在 NapCat 落盘目录里找**原件**：
 *   <dir>/<账号>/nt_data/Ptt/<月份>/Ori/<file>
 * 找到返回路径，找不到返回 ''。文件名先 basename（绝不拼出目录逃逸）。
 */
function findOrigVoice (name, root) {
  if (!root || !name) return ''
  const safe = path.basename(String(name).trim())
  if (!safe || safe === '.' || safe === '/') return ''
  let accounts
  try { accounts = fs.readdirSync(root) } catch { return '' } // 没挂 NapCat 目录 = 没原件可找
  for (const acct of accounts) {
    const ptt = path.join(root, acct, 'nt_data', 'Ptt')
    let months
    try { months = fs.readdirSync(ptt) } catch { continue }
    for (const mo of months) {
      const cand = path.join(ptt, mo, 'Ori', safe)
      try {
        const st = fs.statSync(cand)
        if (st.isFile() && st.size > 0) return cand
      } catch { /* 这个月份没有，继续 */ }
    }
  }
  return ''
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/**
 * 找原件带短重试：NapCat 是收到消息后才把语音落盘的，实测比桥拿到事件晚
 * ~100ms；查一次就放弃会经常踩空。最多等 ~1.5s（300ms × 5），踩到空窗也能救回。
 */
async function findOrigVoiceWait (v, cfg, budgetMs = 1000) {
  const name = String(v?.file ?? '').trim()
  if (!name) return ''
  if (!fs.existsSync(cfg.napcatDataDir)) return ''   // 没挂 NapCat 数据盘：秒退，别空等
  const cap = Math.min(1000, Number(budgetMs) || 0)  // 最多等 1s：找原件不该吃掉转写本身的时间
  const until = Date.now() + cap
  for (;;) {
    const hit = findOrigVoice(name, cfg.napcatDataDir)
    if (hit) return hit
    if (Date.now() + 300 > until) return ''
    await sleep(300)
  }
}

/** 去重键：有 file_id 用它；没有就退到 file / url。缓存按「模型+语言」分桶 —— 换模型后不能拿旧结果。 */
function asrCacheKey (v, cfg) {
  const id = String(v?.file_id ?? '').trim() ||
    String(v?.file ?? '').trim() ||
    String(v?.url ?? '').trim()
  return id ? `${cfg.engine}|${cfg.model}|${cfg.lang}|${id}` : ''
}

/**
 * 调 python 转写脚本，stdout 即文本。
 * @returns {Promise<{ok:boolean, text:string, reason:string}>} 永不 reject。
 */
function runTranscribeProcess (cfg, file, timeoutMs) {
  return new Promise(resolve => {
    const args = [
      cfg.script, '--file', file,
      '--model', cfg.model, '--lang', cfg.lang, '--engine', cfg.engine,
    ]
    // 空就不传：python 侧会回落到 HF_HOME 环境变量 / 自己的默认目录
    if (cfg.hfHome) args.push('--hf-home', cfg.hfHome)
    let child
    try {
      child = spawn(cfg.pythonBin, args, {
        windowsHide: true,
        // 子进程按 UTF-8 说话，别让 Windows 的 GBK 把中文搞成乱码
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      })
    } catch (err) {
      resolve({ ok: false, text: '', reason: `启动 python 失败：${err.message}` })
      return
    }
    let stdout = ''
    let stderrTail = ''
    let settled = false
    let timer = null
    const finish = (r) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(r)
    }
    // 超时：SIGKILL 并**立刻**降级。绝不 await 一个可能卡在模型下载上的进程 ——
    // 那会把整轮回复一起拖死，这是「不让转写阻塞正常流程」的硬边界。
    timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* 已经退出 */ }
      finish({ ok: false, text: '', reason: `转写超时（${Math.round(timeoutMs / 1000)}s），已放弃` })
    }, timeoutMs)
    child.stdout.on('data', d => { if (stdout.length < 200000) stdout += d })
    child.stderr.on('data', d => {
      stderrTail += d
      if (stderrTail.length > 4000) stderrTail = stderrTail.slice(-3000)
    })
    child.on('error', err => {
      const hint = err?.code === 'ENOENT'
        ? `找不到 python：${cfg.pythonBin}（在配置里改 media.voiceTranscribe.pythonBin）`
        : err.message
      finish({ ok: false, text: '', reason: String(hint).slice(0, 160) })
    })
    child.on('close', code => {
      const text = stdout.replace(/\u0000/g, '').trim()
      if (code !== 0) {
        const tail = stderrTail.trim().split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 160)
        return finish({ ok: false, text: '', reason: tail || `python 退出码 ${code}` })
      }
      if (!text) return finish({ ok: false, text: '', reason: '转写结果为空（可能没听清/静音）' })
      finish({ ok: true, text })
    })
  })
}

/**
 * 转写一段语音。
 *
 * @param {string|{url?:string, path?:string, file?:string, file_id?:string}} audio
 *   可以是一段 url / 本地路径字符串，也可以是语音段（url 优先，path 是容器内路径）
 * @param {{cfg?:object, budgetMs?:number}} [opts]
 *   cfg      = voiceTranscribeCfg() 的结果（不传就读当前 bridge config）
 *   budgetMs = 这次最多花多少毫秒（调用方按整条消息的总预算分配）
 * @returns {Promise<{ok:boolean, text:string, reason:string, via:string}>}
 */
async function transcribeVoice (audio, opts = {}) {
  const cfg = opts.cfg ?? voiceTranscribeCfg()
  const started = Date.now()
  const maxBudget = Number(opts.budgetMs) > 0 ? Number(opts.budgetMs) : cfg.timeoutMs
  const timeoutMs = Math.max(500, Math.min(maxBudget, cfg.timeoutMs))
  // 也接受「直接传 url / 本地路径字符串」——对外是 transcribeVoice(fileUrl|localPath)
  const a = typeof audio === 'string'
    ? (/^https?:\/\//i.test(audio) ? { url: audio } : { path: audio })
    : (audio ?? {})
  let downloaded = ''
  const url = String(a.url ?? '').trim()
  const local = String(a.path ?? '').trim()
  let via = ''
  try {
    let file = ''
    // ⭐ 原件优先（2026-11-04 复盘第④层）：url 是 QQ CDN 的低码率重转码 AMR，
    // whisper+VAD 常判空；NapCat 落盘的原件（silk v3）音质正常。段的 path 是
    // 容器视角（/app/...）宿主机读不到，所以按文件名到挂载盘里找。
    // 给找原件留出 ≤1s（NapCat 落盘比桥拿事件晚 ~100ms），但不许吃掉转写时间。
    const origBudget = Math.max(0, timeoutMs - 1000)
    const orig = await findOrigVoiceWait(a, cfg, timeoutMs - origBudget)
    if (orig) {
      via = 'orig'
      file = orig
    } else if (url) {
      via = 'url'
      // 复用入站文件的下载器：SSRF、重定向逐跳复检、边读边计数、文件名净化全都在
      const got = await security.downloadInboundFile(url, a.file || 'voice.amr', {
        maxBytes: cfg.maxBytes,
        timeoutMs,
      })
      file = got.path
      downloaded = got.path
    } else if (local) {
      via = 'path'
      // NapCat 跑在容器里，path 是容器内路径；桥在宿主机上 → 多半不存在。
      // 先看一眼再决定，把「读不到」说得明明白白，别静默失败。
      if (!fs.existsSync(local)) {
        return {
          ok: false, text: '', via,
          reason: '语音在 NapCat 容器里，宿主机读不到这个路径（语音段没带 url）',
        }
      }
      file = local
    } else {
      return { ok: false, text: '', via: '', reason: '语音段里既没有 url 也没有本机路径' }
    }
    const remain = Math.max(500, timeoutMs - (Date.now() - started))
    const r = await runTranscribeProcess(cfg, file, remain)
    return { ...r, via }
  } catch (err) {
    return { ok: false, text: '', via, reason: String(err?.message ?? err).slice(0, 160) }
  } finally {
    // 下到暂存区的音频转完就删：QQ 语音会攒很多，留着白占磁盘。
    // 段里给的 path 是别人的文件，绝不删。
    if (downloaded) {
      try { fs.unlinkSync(downloaded) } catch { /* 已经没了就算了 */ }
    }
  }
}

/**
 * 转写一条消息里的全部语音段（index.js 调用）。
 *
 * 总预算 = cfg.timeoutMs **整条消息合计**（不是每条 × N）：连发 3 条语音也最多
 * 花 30s，超出的直接降级「没转写成功」。默认关时立即返回 []，零开销。
 *
 * @param {Array<{file_id?:string, file?:string, path?:string, url?:string, duration?:number}>} voices
 * @returns {Promise<Array<{ok:boolean, text:string, reason:string, via:string, duration:number, name:string, cached?:boolean}>>}
 */
async function transcribeInboundVoices (voices) {
  const cfg = voiceTranscribeCfg()
  const out = []
  if (cfg.enabled !== true) return out
  const list = Array.isArray(voices) ? voices.filter(Boolean) : []
  if (!list.length) return out
  const deadline = Date.now() + cfg.timeoutMs
  for (const [i, v] of list.entries()) {
    const duration = Number(v.duration) || 0
    const name = String(v.file ?? '').trim()
    const base = { duration, name }
    if (i >= ASR_MAX_VOICES) {
      out.push({
        ...base, ok: false, text: '', via: '',
        reason: `单条消息最多转写 ${ASR_MAX_VOICES} 条语音`,
      })
      continue
    }
    const remain = deadline - Date.now()
    if (remain < 800) {
      out.push({
        ...base, ok: false, text: '', via: '',
        reason: `整条消息的转写预算（${Math.round(cfg.timeoutMs / 1000)}s）用完，这条没转`,
      })
      continue
    }
    const key = asrCacheKey(v, cfg)
    if (key && asrCache.has(key)) {
      const hit = asrCache.get(key)
      logger.log(`语音转写命中缓存（file=${String(v.file_id ?? v.file ?? '').slice(0, 16)}）`)
      out.push({ ...base, ...hit, cached: true })
      continue
    }
    const r = await transcribeVoice(v, { cfg, budgetMs: remain })
    const rec = { ...base, ...r }
    if (r.ok) {
      logger.log(`语音已转写（${r.via}）${r.text.length} 字：${String(v.file_id ?? v.file ?? '').slice(0, 16)}`)
      if (key) {
        asrCache.set(key, { ok: true, text: r.text, reason: '', via: r.via })
        if (asrCache.size > ASR_CACHE_MAX) asrCache.delete(asrCache.keys().next().value)
      }
    } else {
      logger.log(`语音转写降级（${r.via || '-'}）：${r.reason}`)
    }
    out.push(rec)
  }
  return out
}

  // ↑↑↑ 原样搬运结束 ↑↑↑

  return {
    VOICE_MAX_CHARS, DEFAULT_AUDIO_CHARACTER, VOICE_CHARACTERS,
    resolveVoiceCharacter, synthesizeToFile, sendRecordFile, sendVoiceTo,
    extractSendFiles,
    CARD_MAX_CHARS, cardJsonToText, xmlToText,
    FORWARD_MAX_MSGS, FORWARD_MAX_CHARS,
    segToPlainText, quoteOf, expandForwards,
    INBOUND_FILE_DEFAULTS, downloadInboundFiles,
    VOICE_TRANSCRIBE_DEFAULTS, voiceTranscribeCfg, transcribeVoice, transcribeInboundVoices,
  }
}
