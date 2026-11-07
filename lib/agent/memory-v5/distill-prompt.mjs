// lib/agent/memory-v5/distill-prompt.mjs —— 提炼的**输入/输出契约**（prompt 文本 + 解析）
// ============================================================================
// 为什么把 prompt 单独放一个文件：它是这个任务里唯一「靠文字约束模型」的东西，
// 改一行就可能让提炼质量整体变化（v4 的 reflect 吃过大亏：prompt 里没写「不要
// 推测」，产出里就混进了编造的事实）。单独放一起才好对着审计文档 §3.6 逐条核。
//
// v4 → v5 这里改了三件事（每件都对应文档里的一个问题）：
//   ① **输出从「一行文本」变成「JSON struct」**。v4 只让模型吐 `- 一句话`，于是
//      type/key/subject/valid_until 全部靠入库时猜 —— 而「猜」就是 P0-5 污染
//      （7 条因「他**在**」误判进 semantic 层）的来源。v5 让模型直接给结构化字段。
//   ② **不再有「最多 80 条 + 168 小时滑动窗口」**（P0-7 的单向传送带）。窗口由
//      调用方的 watermark 决定，这里只负责「给我这几十条、按时间顺序排好」。
//   ③ **显式要求忽略噪音**：v4 的 NOISE 白名单拦截率 0%（P1-6，322 条短句全进库）。
//      现在在 prompt 里明说「纯寒暄/语气词不要记」，并且代码侧先过滤一遍
//      （isUsableEvent），双保险。
//
// 输出契约（解析侧同样宽容，见 parseDistillOutput）：
//   {"memories":[{"type":"fact|preference|commitment|episode|rule|relation",
//                 "text":"一句话第三人称结论", "subject":"QQ号或null",
//                 "conv":"c2c:10086", "topic":"稳定主题词",
//                 "confidence":0.9, "salience":0.6,
//                 "valid_until":"2026-11-04T15:00:00", "src":3}]}
//   · valid_until 用**本地墙钟时间**（YYYY-MM-DDTHH:MM:SS），不带时区 ——
//     模型算 2026-11-04T15:00:00 这种绝对时刻是可靠的，但让它自己换算 epoch/UTC
//     偏移会错；时区换算由我们做（zonedWallTimeToEpoch）。
//   · src 是「这条记忆来自第几行」的序号（1-based）→ 落到 memories.source_event，
//     满足 §3.1「所有记忆都可追溯到一条原始消息」。
// ============================================================================

/** 默认时区（和插件 policy.timezone 的默认一致）。 */
export const DEFAULT_TZ = 'Asia/Shanghai'

/** 记忆类型（顺序即 prompt 里列的顺序）。 */
export const DISTILL_TYPES = Object.freeze([
  'fact', 'preference', 'commitment', 'episode', 'rule', 'relation',
])

/** 模型偶尔会把类型写成中文/同义词 —— 统一映射，避免整条被 store 校验拒掉。 */
const TYPE_ALIASES = Object.freeze({
  事实: 'fact', fact: 'fact',
  偏好: 'preference', 喜好: 'preference', preference: 'preference',
  承诺: 'commitment', 约定: 'commitment', 待办: 'commitment', commitment: 'commitment',
  事件: 'episode', 经历: 'episode', episode: 'episode',
  规矩: 'rule', 规则: 'rule', rule: 'rule',
  关系: 'relation', relation: 'relation',
})

/** 纯占位/控制标记：剥离后如果什么都不剩，就说明这条事件没有可提炼的内容。 */
const CONTROL_MARKERS = [
  /\[SILENT\]/g,
  /\[SEND_FILE:[^\]]*\]/g,
  /\[AT:[^\]]*\]/g,
  /\[POKE:[^\]]*\]/g,
  /\[VOICE:[^\]]*\]/g,
  /\[FOLLOW:[^\]]*\]/g,
  /\[RECALL:[^\]]*\]/g,
  /\[SPLIT(?::[^\]]*)?\]/g,
  // 好感度自评标记（2026-11-06）：模型输出里的 [AFF:±n:理由]。它是**桥的指令**，
  // 不是聊天内容 —— 不剥掉就会被当成「我说过的话」提炼成记忆，
  // 甚至把「他这句是在夸我」这种内部判断变成关于对方的「事实」。
  /\[AFF:[^\]]*\]/g,
  // 全角【SPLIT】（出站分条两种写法都认，提炼侧也要剥）
  /【SPLIT】/g,
]

/**
 * 模型内部推理块（伪工具 / thinking）。
 *
 * 为什么要剥：ACP 侧偶发把 `<thinking>…</thinking>` / `<bash>…</bash>` 当成正文
 * 一起吐出来（2026-11-05 生产日志实锤：`行，我看看。 <thinking> 用户说的是…`
 * 整段发到了 QQ）。桥的**出站侧故意不剥**（persona 里那点「小巧思」，用户明确
 * 要求保留、不管），但**提炼侧必须剥** —— 那是模型的内心独白，不是「谁说过的话」，
 * 记进记忆会污染画像（把「用户说的是那个影鲸之主的视频」当成对方说的事实）。
 */
const INTERNAL_BLOCK_RE = /<(thinking|bash|tool_call|tool_result)>[\s\S]*?<\/\1>/gi

/** 桥写的占位文本（v5InboundText）：这类事件本身没有内容，除非 meta 里有转写/卡片。 */
const PLACEHOLDER_RE = /^\[(图片|语音|文件|合并转发|群在线文件|群在线文件夹|表情|视频|卡片|音乐|红包)(\s*×\s*\d+)?\]$/

/**
 * 短句噪音（P1-6）。v4 用的是 31 条精确字符串白名单 → 拦截率 0%
 * （真实短句是 `哦哦` `嗯嗯` `唉` `是的` `这样` `菜菜` `嘿嘿` `可以` `没有` `也行`
 * `111` `点外卖！`，一条都不在名单里）。这里改成「长度阈值 + 常见语气词正则」，
 * 并且**只影响提炼**（events 原文照存，不可变是前提）。
 */
const NOISE_RE = /^(?:[哦嗯啊哈呵嘿唉哎诶呀额呃][哦嗯啊哈呵嘿唉哎诶呀额\s~～。.!！?？]*|在吗|在不在|在嘛|好的|好滴|好吧|行吧|可以|没有|也行|是的|是啊|对的|这样|那样|没事|哈哈+|hhh+|233+|6+|111+|[0-9]{1,3}|okk?|ok|收到|了解|明白|多谢|谢谢|thx|嗯哼|啦啦|略|emmm?|额+|草|牛|绝了|笑死)[。.!！~～\s]*$/i

/** 这条事件是不是纯噪音/占位（不喂给模型，也不产生记忆）。 */
export function isNoiseText (text) {
  const t = String(text ?? '').trim()
  if (!t) return true
  if (NOISE_RE.test(t)) return true
  // 2 个字以下基本只有「嗯」「好」；中文 2 字也可能是有效信息（「累死」），
  // 所以只把「1 个字」当铁定噪音。
  return t.replace(/[\s\p{P}]/gu, '').length < 1
}

/**
 * 从事件里抽出「模型该看到的正文」：
 *   · 剥掉控制标记（`[SILENT]` / `[SEND_FILE:...]` 等，P0-5 的污染源之一）；
 *   · 纯占位（`[语音]`）但有转写文本 → 用转写文本（否则这条语音的内容等于丢了）；
 *   · 其它占位（纯图/纯文件）→ 返回空串（没有可提炼内容）。
 *
 * @param {{text:string, kind_raw?:string, meta?:string|object}} ev
 * @returns {string}
 */
export function canonicalEventText (ev) {
  let text = String(ev?.text ?? '')
  const meta = typeof ev?.meta === 'string'
    ? (() => { try { return JSON.parse(ev.meta) } catch { return null } })()
    : (ev?.meta || null)

  // 语音转写：桥把「模型当时看到的那段文字」放在 meta.transcripts
  const transcripts = Array.isArray(meta?.transcripts)
    ? meta.transcripts.map(t => String(t ?? '').trim()).filter(Boolean)
    : []

  const placeholder = text.trim().match(PLACEHOLDER_RE)
  if (placeholder) {
    const kind = placeholder[1]
    if (kind === '语音' && transcripts.length) return transcripts.join(' / ')
    // 图片/文件/合并转发等：没有正文可提炼（它们的元信息不是「记忆」）
    return ''
  }

  for (const re of CONTROL_MARKERS) text = text.replace(re, ' ')
  // 内部推理块：宁可「剥掉后剩一句不完整的话」，也不能把内心独白记成记忆。
  text = text.replace(INTERNAL_BLOCK_RE, ' ')
  text = text.replace(/\s+/g, ' ').trim()
  if (text && transcripts.length) return `${text}（语音转写：${transcripts.join(' / ')}）`
  return text
}

/**
 * 这条事件该不该喂给模型。
 *
 * 跳过的情况（每一类都对应文档里的一个真实问题）：
 *   · meta.merged —— 桥的合并轮（busy 排队后把几条合成一段再写一次），内容与
 *     原始事件重叠；不跳就会**同一句话提炼两遍**（task-15 的约定）。
 *   · speaker='self' 且剥完标记什么都不剩 —— 我们自己发的工具标记/调试话术。
 *     P1-7 里那 273 条出站里有一批被钉成了「永久规矩」，就是这么来的。
 *   · 空正文 / 纯占位 / 短句噪音（P1-6）。
 *
 * @returns {{ok:boolean, reason:string, text:string}}
 */
export function isUsableEvent (ev) {
  const meta = typeof ev?.meta === 'string'
    ? (() => { try { return JSON.parse(ev.meta) } catch { return null } })()
    : (ev?.meta || null)
  if (meta?.merged === true) return { ok: false, reason: 'merged', text: '' }

  const text = canonicalEventText(ev)
  if (!text) return { ok: false, reason: 'empty', text: '' }
  if (isNoiseText(text)) return { ok: false, reason: 'noise', text }

  // self 的正文如果只剩「命令/标记」—— canonicalEventText 已经剥过标记，
  // 走到这里说明还有内容（比如正常的一句回复），保留当上下文。
  return { ok: true, reason: '', text }
}

/** 秒 → 「11-03 21:00」（给 prompt 用；同一批里只显示月日时分）。 */
export function fmtShortLocal (sec, tz = DEFAULT_TZ) {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(Number(sec) * 1000)).replace(/\//g, '-')
  } catch { return String(sec) }
}

/** 秒 → 「2026-11-03 21:00」（prompt 里给「现在」用，模型据此算「明天」）。 */
export function fmtLocal (sec, tz = DEFAULT_TZ) {
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(Number(sec) * 1000)).replace(/\//g, '-')
  } catch { return new Date(Number(sec) * 1000).toISOString() }
}

/** 把「本地墙钟时间字符串」按给定时区换算成 epoch 秒（无第三方库）。 */
export function zonedWallTimeToEpoch (wall, tz = DEFAULT_TZ) {
  const s = String(wall ?? '').trim()
  if (!s) return null
  // 允许纯数字 = 已经是 epoch 秒/毫秒
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s)
    if (!Number.isFinite(n) || n <= 0) return null
    return n > 1e11 ? n / 1000 : n
  }
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s)
  if (!m) return null
  const utcGuess = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0))
  const offset = (ms) => {
    try {
      const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      })
      const p = Object.fromEntries(dtf.formatToParts(new Date(ms))
        .filter(x => x.type !== 'literal').map(x => [x.type, x.value]))
      const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second)
      return asUTC - ms
    } catch { return 0 }
  }
  let ms = utcGuess - offset(utcGuess)
  const second = offset(ms)
  if (second !== offset(utcGuess)) ms = utcGuess - second   // DST 边界兜一下
  return ms / 1000
}

/**
 * 组 prompt。
 *
 * @param {object} opts
 * @param {Array<{id:number, conv:string, speaker:string, text:string, at:number, kind_raw?:string, meta?:string}>} opts.events
 *   已过滤（只含 usable 事件），按时间/ id 顺序。
 * @param {number} opts.now          秒（模型据此把「明天三点」换成绝对时间）
 * @param {string} [opts.tz]
 * @param {number} [opts.maxLineChars=400] 单行正文上限（全文仍在 events 里，这里只限 prompt）
 * @param {number} [opts.maxPromptChars=8000] 总预算：超了就**少喂几条**（返回的
 *   includedIds 决定 watermark 推进到哪，剩下的下一批再提炼 —— 绝不能「喂一半还
 *   把 watermark 推到最后」，那会永久丢事件）
 * @returns {{prompt:string, includedIds:number[], deferredIds:number[], lines:number}}
 */
export function buildDistillPrompt ({
  events = [], now = Math.floor(Date.now() / 1000), tz = DEFAULT_TZ,
  maxLineChars = 400, maxPromptChars = 8000,
} = {}) {
  const head = `你在为一段 QQ 聊天记录做记忆提炼。只做一件事：把对话里**值得长期记住**的、关于对话对方的信息，抽成结构化条目。

【时间】现在是 ${fmtLocal(now, tz)}（时区 ${tz}）。下面每行开头的 [MM-DD HH:MM] 是消息时间。
【会话】每行带 [conv=...] 标明来自哪个会话（私聊 c2c:<QQ> / 群聊 group:<群号>）；[speaker=...] 是说话人 QQ，self = 我自己。
【重要】带明确时间点的事（比如「明天下午三点开会」）请按上面的「现在」换算成**本地墙钟时间**填进 valid_until。

【只提炼这 6 类，type 用英文原词】
- fact        关于对方的稳定事实（身份、所在地、职业、作息、家庭成员、会什么）
- preference  对方明确的喜欢 / 讨厌 / 雷点
- commitment  约定、答应过的事、没做完的待办（写清楚谁答应谁）
- episode     值得记住的一次具体事件（发生了什么、结论是什么）
- rule        对方要求我怎么做 / 什么情况下不做什么（**只能来自对方的话**，不能从我自己说的话里推）
- relation    关系变化（称呼、亲疏、态度的变化）

【硬性要求】
1. text 一句话、第三人称、**能脱离上下文独立看懂**；别用「他说了那个」「上面提到的」这类指代，也别写「对方」以外的模糊称呼。
2. 只写对话里**真的出现过**的信息。不推测、不编造、不补充常识。没值得记的就输出 {"memories":[]}。
3. **不要记**：纯寒暄和语气词（哦哦/嗯/哈哈/在吗）、我自己发的指令与工具标记、重复出现过的同一件事、明显的玩笑（除非对方明确表示那是真的）。
4. subject 填这条记忆「关于谁」的 QQ 号（必须来自上面的 [speaker=...]，不要自己编）；群级公共信息填 null。
5. topic 填 3~12 字的**稳定主题词**。同一件事在不同时间出现时**必须用同一个 topic**（例如都写「周三会议」「猫的名字」），系统靠它判断「新版本取代旧版本」。
6. confidence 0~1：对方明确说的 0.9 以上；语境清楚的 0.7；拿不准的 ≤0.5。
7. salience 0~1：以后还会用到的打高（0.7+），一次性的打低（≤0.3）。rule 类天然高。
8. valid_until 只在**这条信息会过期**时填（会议、临时安排、期限），格式 YYYY-MM-DDTHH:MM:SS（本地时间，不带时区）；不会过期的填 null。
9. src 填支持这条记忆的**行号**（下面每行开头的 #N，取最早/最直接的那行）。

【输出】只输出一个 JSON 对象，不要解释、不要 markdown 代码块、不要多余文字：
{"memories":[{"type":"commitment","text":"对方约了明天下午三点在三楼开会","subject":"10086","conv":"c2c:10086","topic":"周三会议","confidence":0.9,"salience":0.7,"valid_until":"2026-11-04T15:00:00","src":1}]}

【对话（按时间顺序）】`

  const lines = []
  const includedIds = []
  const deferredIds = []
  let budget = Math.max(500, Number(maxPromptChars) || 8000) - head.length
  for (const ev of events) {
    let text = String(ev.text ?? '').replace(/\s+/g, ' ').trim()
    if (text.length > maxLineChars) text = text.slice(0, maxLineChars) + '…'
    const line = `#${lines.length + 1} [${fmtShortLocal(ev.at, tz)}] [conv=${ev.conv}] [speaker=${ev.speaker}] ${text}`
    if (line.length > budget && lines.length > 0) {   // 至少放一行，否则永远推进不了
      deferredIds.push(Number(ev.id))
      continue
    }
    budget -= line.length + 1
    lines.push(line)
    includedIds.push(Number(ev.id))
  }
  return {
    prompt: `${head}\n${lines.join('\n')}\n`,
    includedIds,
    deferredIds,
    lines: lines.length,
  }
}

/** 容错从模型输出里抠 JSON：容忍 ```json 围栏、前后废话、以及「给数组不给对象」。 */
function extractJson (raw) {
  let s = String(raw ?? '').trim()
  if (!s) return null
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  const firstObj = s.indexOf('{')
  const firstArr = s.indexOf('[')
  let start = -1
  let last = -1
  if (firstObj >= 0 && (firstArr < 0 || firstObj < firstArr)) {
    start = firstObj
    last = s.lastIndexOf('}')
  } else if (firstArr >= 0) {
    start = firstArr
    last = s.lastIndexOf(']')
  }
  if (start < 0 || last <= start) return null
  try { return JSON.parse(s.slice(start, last + 1)) } catch { return null }
}

function clamp01 (v, def) {
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  return Math.min(1, Math.max(0, n))
}

function normalizeType (raw) {
  const t = String(raw ?? '').trim().toLowerCase()
  if (DISTILL_TYPES.includes(t)) return t
  for (const [alias, canonical] of Object.entries(TYPE_ALIASES)) {
    if (t === alias.toLowerCase()) return canonical
  }
  return null
}

/**
 * 解析并**校验/归一化**模型的 JSON 输出。
 *
 * 为什么不「解析失败就抛」：模型输出偶发带围栏/废话是常态，容忍这些格式问题
 * 不等于容忍语义问题。真正语义不明的（JSON 结构都不对）仍然抛，交给 jobs 退避。
 *
 * @param {string} raw
 * @param {object} [opts]
 * @param {string[]} [opts.allowedConvs] 允许的 conv 集合（模型给了别的 → 置 null）
 * @param {string[]} [opts.speakers]     允许的 subject 集合（非 QQ 号/stranger → null）
 * @param {string} [opts.tz]
 * @param {number} [opts.now]
 * @returns {{memories:Array, warnings:string[], dropped:number}}
 */
export function parseDistillOutput (raw, { allowedConvs = null, speakers = null, tz = DEFAULT_TZ, now = null } = {}) {
  const data = extractJson(raw)
  if (!data) {
    const err = new Error(`模型输出不是 JSON（前 120 字：${String(raw ?? '').slice(0, 120)}）`)
    err.code = 'llm_output'
    throw err
  }
  const items = Array.isArray(data) ? data : (Array.isArray(data.memories) ? data.memories : null)
  if (!items) {
    const err = new Error('模型输出 JSON 里没有 memories 数组')
    err.code = 'llm_output'
    throw err
  }
  const convSet = allowedConvs ? new Set(allowedConvs.map(String)) : null
  const speakerSet = speakers ? new Set(speakers.map(String)) : null
  const warnings = []
  const out = []
  let dropped = 0
  for (const [i, it] of items.entries()) {
    if (!it || typeof it !== 'object') { dropped += 1; continue }
    const type = normalizeType(it.type)
    if (!type) { warnings.push(`#${i + 1} 类型不认识：${it.type}`); dropped += 1; continue }
    let text = String(it.text ?? '').replace(/\s+/g, ' ').trim()
    if (!text) { dropped += 1; continue }
    if (text.length < 4) { warnings.push(`#${i + 1} 太短（${text.length} 字）：${text}`); dropped += 1; continue }
    if (text.length > 200) { warnings.push(`#${i + 1} 超长截断：${text.slice(0, 24)}…`); text = text.slice(0, 200) }

    let subject = it.subject === null || it.subject === undefined ? null : String(it.subject).trim()
    if (subject && !/^\d{4,15}$/.test(subject)) { warnings.push(`#${i + 1} subject 不是 QQ 号：${subject}`); subject = null }
    if (subject && speakerSet && !speakerSet.has(subject)) { warnings.push(`#${i + 1} subject 不在本批说话人里：${subject}`); subject = null }

    let conv = it.conv === null || it.conv === undefined ? null : String(it.conv).trim()
    if (conv && convSet && !convSet.has(conv)) { warnings.push(`#${i + 1} conv 不在本批会话里：${conv}`); conv = null }

    const topic = String(it.topic ?? '').replace(/[\s:：]+/g, ' ').trim().slice(0, 40)
    // key = type:subject:topic —— 取代逻辑的唯一依据。没 topic 就只能是「同文去重」，
    // 所以给个警告（不丢条目，但能看出模型没按要求给稳定主题词）。
    const key = topic ? `${type}:${subject || 'global'}:${topic}` : null
    if (!topic) warnings.push(`#${i + 1} 缺 topic（这条只能靠同文去重）：${text.slice(0, 20)}`)

    let confidence = clamp01(it.confidence, 0.6)
    let salience = clamp01(it.salience, 0.5)
    if (type === 'rule') salience = Math.max(salience, 0.85)   // rule ≈ pinned 规矩
    if (type === 'relation') confidence = Math.max(confidence, 0.7)

    let validUntil = null
    if (it.valid_until !== null && it.valid_until !== undefined && String(it.valid_until).trim() !== '') {
      validUntil = zonedWallTimeToEpoch(it.valid_until, tz)
      if (validUntil === null) warnings.push(`#${i + 1} valid_until 解析不了：${it.valid_until}`)
      else if (now !== null && validUntil <= now) {
        // 已经过去的时间点：还写进去但没有意义（dueExpire 会立刻归档），
        // 直接当「没有时间边界」处理并告警更干净。
        warnings.push(`#${i + 1} valid_until 早于现在（丢弃时间边界）：${it.valid_until}`)
        validUntil = null
      }
    }

    const src = Number(it.src)
    const sourceEvent = Number.isInteger(src) && src > 0 ? src : null   // 1-based 行号；映射由调用方做

    out.push({ type, text, subject, conv, topic, key, confidence, salience, validUntil, sourceLine: sourceEvent })
  }
  return { memories: out, warnings, dropped }
}
