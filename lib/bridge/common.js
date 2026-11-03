// 跨模块共用的**纯函数 + 纯常量**。
//
// 从 index.js 拆出来（2026-10-29）。拆分原则：纯搬运，函数体一字不改。
//
// 为什么单独一个模块：
//   · 这些是「多个模块都要用、且无状态」的东西（标记正则、拆句、段转换）
//   · 全部是纯函数/纯常量，不碰 config、不碰 state、不碰 logger
//   · 有状态的东西（config/logger/state）**不走这里**——那些用工厂参数注入，
//     因为它们是运行时可变对象，共享引用容易出错
//
// 依赖：零。只导出常量与纯函数。

export const SEND_FILE_RE = /\[SEND_FILE:\s*([^\]\n]+?)\s*\]/g

// 模型可以输出这些控制标记，桥负责转成真正的 OneBot 动作：
//   [AT:123456]            → 真 @（会弹出提醒）
//   [POKE:123456]          → 群内戳一戳（拍一拍）
//   [POKE:123456:c2c]      → 私聊戳一戳
// 标记本身会从正文里剥掉，群友看不到。
export const AT_RE = /\[AT:(\d+)\]/g
export const POKE_RE = /\[POKE:(\d+)(?::(c2c|group))?\]/g

// 语音（TTS）：模型输出 [VOICE:要说的文字] 或 [VOICE:文字:音色id]
// 桥调 QQ 内置 AI 音色把文字合成语音，以 record 消息发出去。
// 只支持群聊（NapCat 的 send_group_ai_record 仅群）；私聊自动降级为普通文字。
// 「补一句」：主消息发完后隔一会儿再补一条（真人说漏了又补 / 想起来补充）
export const FOLLOW_RE = /\[FOLLOW:\s*([^\]]+?)\s*\]/g
export const VOICE_RE = /\[VOICE:\s*([^\]:]+?)(?::([^\]:\]]+?))?\s*\]/g
const VOICE_MAX_CHARS = 120        // AI 语音单条上限（太长会被截断/拒绝）

// 模型自己标「这里断一条」：出站前桥按标记拆段，并把标记本身剥掉。
//
// 为什么要有：纯代码按标点拆有硬伤（实测把「你要不要……」从词中间劈成
// 「你要」「不要……」）—— 代码不知道哪句在语气上是完整的一口气。
// 但纯交给模型也不靠谱（它可能从词中间劈）。所以混合：
// 模型只负责**标断点**，代码负责校验断点必须落在标点/空白旁（见 splitAtBoundary）。
export const SPLIT_RE = /\[SPLIT\]/gi

// 自然停顿的切点集合。**故意不含 ！？**：
// 真人常把「你吃了吗？」作为一条发，从问号后断开会把一口气的话拆碎；
// 逗号/句号/空格/换行才是真正换气的位置。
const BOUNDARY_CHARS = '，、,。. \u3000\n'
// 右段开头若还粘着切点（连续标点），一并剥掉 —— 不然会出现「，你要……」这种段
const LEADING_BOUNDARY_RE = /^[，、,。. \u3000\n]+/

/**
 * 把一段正文切成若干条**尽量不超过 max** 的消息，在自然停顿处断。
 *
 * 🔴 2026-11-02 用户实测（生产 maxReplyChars=50）：
 *    一段 105 字的话被切成「……反而更像个」+「人；真正让人出戏的还是记性差……」——
 *    「像个人」从词中间劈开。根因是这里**只认 '\n'**：没有换行就 slice(0, max) 硬切。
 *    现在改成边界感知：用和 splitAtBoundary **同一套** BOUNDARY_CHARS 找切点。
 *
 * 规则（按优先级）：
 *   · 在 max 之前找**最后一个**切点（，、,。. 空格 换行），切点字符留在左段；
 *     换行例外（吃掉，下一段不以空行开头）；换行点太靠前（< max/2）就不用它；
 *   · max 之前没有任何切点 → 往后找**第一个**切点（左段可超 max，宁长不劈词）；
 *   · 全文一个切点都没有 → 硬切 max 个字（此时只能劈词，见下）；
 *   · 任何情况下都不把 [AT:xxx]/[SEND_FILE:]/[VOICE:] 控制标记劈开。
 *
 * 和 splitAtBoundary 的区别（别混）：
 *   · splitAtBoundary 是「宁可整条不切」——没有切点就原样返回，绝不劈词；
 *   · chunkText 是**必须切**（这是单条消息的兜底上限）——全文一个切点都没有时
 *     只能硬切 max 个字，哪怕劈词。任何调用方都不能把它换成 splitAtBoundary。
 *
 * 和出站拆句三个参数的关系（生产值：maxReplyChars=120 / splitChars=30 / splitMaxParts=3）：
 *   · splitChars / splitMaxParts（index.js 的 splitReplyForSend）先把一轮回复按 [SPLIT]
 *     或标点拆成 ≤3 段、每段尽量 ≤30 字；无标点的长句会整条超 30（宁长不残）；
 *   · maxReplyChars 是 sendTextTo 里的**最后一道**兜底：每段再按它切一次。
 *   正常路径走不到这里（30 < 120）。触发它的只有两种异常：
 *     ① splitAtBoundary 找不到标点、整段超长；
 *     ② splitMaxParts 把超出的段并回最后一条（`out.slice(maxParts-1).join('')`），
 *        模型标了很多 [SPLIT] 时最后一条可能拼到 100+ 字。
 *   ⚠️ 2026-11-03 用户已把生产 maxReplyChars 从 50 上调到 120 —— 按 50 算时兜底
 *      离正常段长太近（30×3=90 的合并尾段在 50 上限下必被切，而且切得很碎），
 *      上面那次「像个人」事故就是 50 的锅。120 给 30 字一段 + 合并尾段留了足够余量。
 *      推荐区间：≥ splitChars × splitMaxParts（90）、120–150 都合理。
 *      **这里只改切法，不改配置**（配置是用户的，桥不该替用户定风格）。
 *
 * @param {string} text
 * @param {number} max
 * @returns {string[]}
 */
export function chunkText(text, max) {
  const out = []
  let rest = text
  while (rest.length > max) {
    // ① 先找切点。范围含 max 位置（= max+1）：连续换行时和旧行为一致，
    //    「换行恰好在第 max 个字符」也应该在这里断。
    let cut = lastBoundaryBefore(rest, max + 1)
    // ② limit 内切点太靠前，这一条就只剩半行/半句话，反而更像「打了一半」。
    //    换行沿用旧做法：不在这里断，往后找（找不到就按 max 硬切）；
    //    逗号/句号不跳过 —— 中文逗号后本来就是真人换气的位置，短一点不违和。
    if (cut >= 0 && cut < max * 0.5 && rest[cut] === '\n') {
      cut = firstBoundaryAtOrAfter(rest, max)
    }
    // ③ limit 内一个切点都没有 → 往后找第一个切点（左段可以超 max，别劈词）；
    //    全文一个切点都没有 → 只能硬切（chunkText 是「必须切」语义）。
    if (cut < 0) cut = firstBoundaryAtOrAfter(rest, max)
    if (cut < 0) cut = max
    // ⚠️ 别把 [AT:123456] / [SEND_FILE:路径] / [VOICE:...] 这类控制标记从中间切两半：
    // 半截标记会作为**可见乱码**发到 QQ（群友看到 "[AT:12"），而且 textToSegments
    // 认不出被切开的标记 → @ 人和发文件静默失效 —— 只在长回复里偶发，极难排查。
    let markerStart = -1   // 切点被保护逻辑退到 '[' 上：这一刀不能把 '[' 带进左段
    const open = rest.lastIndexOf('[', cut - 1)
    if (open >= 0) {
      const closeAfterOpen = rest.indexOf(']', open)
      if (closeAfterOpen === -1 || closeAfterOpen >= cut) {
        // 切点落在标记内部：优先退到 '['（标记整体进下一段）；
        // 退得太靠前会让这一条只剩几个字，那就往前补到 ']' 之后。
        if (open > 0 && cut - open <= 256) {
          cut = open
          markerStart = open
        } else {
          const close = rest.indexOf(']', cut)
          // 标记本身就比 max 长（比如很长的 SEND_FILE 路径）：宁可这一条超长，
          // 也不要切成两半 —— 半截标记发出去是可见乱码，而且功能直接失效。
          if (close >= 0 && close - cut <= 1024) cut = Math.min(close + 1, rest.length)
        }
      }
    }
    if (cut <= 0) cut = Math.min(max, rest.length)
    // ④ 落刀：
    //   · 换行处断 → 换行本身吃掉（下一段不以空行开头）；
    //   · 逗号/句号/空格处断 → 切点字符留在**左段**（句尾标点不能甩到下一段，
    //     空格留着也保证原文一个字符不丢）；
    //   · 硬切/标记保护 → 原样从 cut 处分开。
    let left
    if (markerStart < 0 && rest[cut] === '\n') {
      left = rest.slice(0, cut)
      rest = rest.slice(cut).replace(/^\n+/, '')
    } else if (markerStart < 0 && rest[cut] !== undefined && BOUNDARY_CHARS.includes(rest[cut])) {
      left = rest.slice(0, cut + 1)
      rest = rest.slice(cut + 1)
    } else {
      left = rest.slice(0, cut)
      rest = rest.slice(cut)
    }
    if (left) out.push(left)
  }
  if (rest) out.push(rest)
  return out
}

/**
 * 按**自然停顿**切分长句（v2-3）。这是「绝不把一句话从词中间劈成两段」的实现。
 *
 * 规则（用户原话：「按标点截，不要切成『你要』『不要』」）：
 *   · text.length <= limit → 不切
 *   · limit 内找**最后一个**切点切左段；limit 内一个切点都没有 → 找 limit 之后
 *     第一个切点（宁可左段超 limit，也不从词中间砍）
 *   · 全文没有任何切点 → **整条不切**（宁长不残）
 *   · 右段若仍 > limit 且含切点 → 继续对右段递归
 *   · 最多 maxParts 条（默认 3）；不产生空段/首尾空白
 *
 * @param {string} text
 * @param {number} limit
 * @param {{maxParts?:number}} [opts]
 * @returns {string[]} 切好的段（无切点时返回 [原文]）
 */
export function splitAtBoundary (text, limit, opts = {}) {
  const s = String(text ?? '')
  const maxParts = Math.max(1, Math.floor(opts.maxParts ?? 3))
  if (!Number.isFinite(limit) || limit <= 0 || s.length <= limit) return [s]
  const out = []
  let rest = s
  while (rest.length > limit && out.length < maxParts - 1) {
    let cut = lastBoundaryBefore(rest, limit)
    if (cut < 0) cut = firstBoundaryAtOrAfter(rest, limit)
    if (cut < 0) break                       // 全文无切点：整条不切，宁长不残
    const left = rest.slice(0, cut + 1).trim()
    const right = rest.slice(cut + 1).replace(LEADING_BOUNDARY_RE, '').trim()
    if (!left) { rest = right; continue }    // 切点在最前面（前导空格）：跳过，别产生空段
    if (!right) break
    out.push(left)
    rest = right
  }
  if (rest) out.push(rest)
  return out.length ? out : [s]
}

/** 在 [0, end) 里找**最后一个**切点，找不到返回 -1。 */
function lastBoundaryBefore (s, end) {
  for (let i = Math.min(end, s.length) - 1; i >= 0; i--) {
    if (BOUNDARY_CHARS.includes(s[i])) return i
  }
  return -1
}

/** 从 from 起找**第一个**切点，找不到返回 -1。 */
function firstBoundaryAtOrAfter (s, from) {
  for (let i = Math.max(0, from); i < s.length; i++) {
    if (BOUNDARY_CHARS.includes(s[i])) return i
  }
  return -1
}

/**
 * 低精力时的硬截断（按切点，**丢弃右段、不加省略号**）。
 *
 * 用户原话：「宁长不残」—— 一条被句尾「…」截断的消息，比稍微长一点更像
 * 被打断的生成文本。所以：
 *   · limit 内有切点 → 在最后一个切点截断（保留切点，句子是完整的）
 *   · limit 内没有 → 找 limit 之后第一个切点截断（保住完整的一句）
 *   · 全文没有切点 → 整条发，不截（从词中间砍断比超长更糟）
 *
 * @param {string} text
 * @param {number} limit
 * @returns {string}
 */
export function truncateAtBoundary (text, limit) {
  const s = String(text ?? '')
  if (!Number.isFinite(limit) || limit <= 0 || s.length <= limit) return s
  let cut = lastBoundaryBefore(s, limit)
  if (cut < 0) cut = firstBoundaryAtOrAfter(s, limit)
  if (cut < 0) return s
  const left = s.slice(0, cut + 1).trim()
  // 切点在第 0 个字符（开头的空格）→ 截完是空串，等于把整句丢掉；不截。
  return left || s
}

/**
 * 按模型写的 [SPLIT] 拆段，并把标记剥掉（不留在正文里）。
 *
 * 模型只负责标断点，不负责「切得对不对」—— 真正的切点校验和超长二次拆分
 * 在出站流程里做（splitAtBoundary），所以这里只做拆分。
 *
 * @param {string} text
 * @returns {{marked:boolean, parts:string[]}} 没有标记时 marked=false、parts=[原文]
 */
export function splitBySplitMarker (text) {
  const s = String(text ?? '')
  if (!/\[SPLIT\]/i.test(s)) return { marked: false, parts: [s] }
  SPLIT_RE.lastIndex = 0
  const parts = s.split(SPLIT_RE).map(x => x.trim()).filter(Boolean)
  return { marked: true, parts }
}

/**
 * 把一段文本里内嵌的 [AT:qq] 标记转成消息段，实现「真 @」。
 * @returns {Array<{type:string,data:object}>}
 */
export function textToSegments(text) {
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

// ── 入站「非文字消息」占位描述 ────────────────────────────────────────────────
//
// 🔴 2026-11-02：用户发文件/语音/视频，机器人**完全没反应**，日志里只有
//    「空消息，忽略」。根因在 flattenMessage：它只认 text/image/reply/forward/
//    json/xml/at/face，file/record/video/mface/... 这些段被**静默跳过** →
//    text 为空、images=0 → 空消息判定把整条消息扔掉。
//
// 修法：给这些段生成人类可读的占位文本，让消息「看得见」，并让提示词明确告诉
// 模型「你只能看到占位描述，看不到内容」。
//
// ⚠️ 这里**只描述、不下载**：段解析阶段不碰网络。真机 file 段自带 url/file_id，
//    「下载到暂存区给模型读」在 messaging.downloadInboundFiles 里做（2026-11-03 task-6），
//    SSRF/大文件边界也都在那一层守。
const SEG_PLACEHOLDER_LABEL = {
  video: '[视频]',
  mface: '[表情包]',
  contact: '[名片]',
  location: '[位置]',
  dice: '[骰子]',
  rps: '[猜拳]',
}

/**
 * 把字节数写成「12.3 KB」这种好读的样子；拿不到大小返回空串（不要 NaN）。
 * 入站文件占位和「文件已下载」上下文共用这一份格式化，别各写一套。
 */
export function formatBytes (bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  // 整数就别写成「2.0 KB」（聊天里没人这么打）；非整数且小于 10 才留一位小数
  const num = Number.isInteger(v) ? String(v) : (v >= 10 ? String(Math.round(v)) : v.toFixed(1))
  return `${num} ${units[i]}`
}

/**
 * 文件名兜底：不同 OneBot 实现/真机给的字段名不统一，都要认 ——
 *   · 真机 file 段（napcat.mjs fileElement）：`{ file: <文件名>, file_id, file_size, url? }`
 *     —— **名字在 `file`**，不是 `file_name`；
 *   · 群在线文件（onlinefile 段）：`{ fileName, fileSize, isDir }`；
 *   · 老 OneBot v11 文档写法：`file_name` / `name`。
 * `file` 字段可能带目录或协议前缀（甚至 base64://），只留最后一段；太长截断。
 */
function humanFileName (d) {
  const raw = String(d.file_name ?? d.name ?? d.fileName ?? d.file ?? '').trim()
  if (!raw) return ''
  // file 字段有时带目录或协议前缀，只留最后一段；base64 之类的一眼不是名字，不展示
  const base = raw.split(/[\\/]/).filter(Boolean).pop() ?? raw
  if (/^(base64:|file:|https?:)/i.test(base)) return ''
  return base.replace(/\s+/g, ' ').slice(0, 40)
}

/**
 * 非文字/非图片消息段 → 人类可读占位文本。
 *
 * 返回 '' 表示该段由 flattenMessage 自己处理（text/image/reply/... 不该来这里）；
 * 其余类型一定返回非空字符串 —— 否则消息又会被当成「空消息」丢掉。
 *
 * @param {{type?:string, data?:object}} seg
 * @returns {string}
 */
export function segmentPlaceholder (seg) {
  const type = String(seg?.type ?? '')
  const d = seg?.data ?? {}
  if (type === 'file') {
    const name = humanFileName(d)
    const size = formatBytes(d.size ?? d.file_size ?? d.fileSize)
    return `[文件] ${name || '(未知文件名)'}${size ? ` (${size})` : ''}`
  }
  if (type === 'onlinefile') {
    // 群在线文件/文件夹（真机独立的 onlinefile 段，napcat.mjs）：
    //   `{ msgId, elementId, fileName, fileSize, isDir }` —— **没有 url**。
    // 所以它永远走不了下载，只能靠这句占位让消息「看得见」；
    // 「拿不到内容、让人私聊传/截图」这层解释由 index.js 的上下文负责。
    const name = humanFileName(d)
    const size = formatBytes(d.fileSize ?? d.file_size ?? d.size)
    const label = d.isDir === true || d.is_dir === true ? '[群在线文件夹]' : '[群在线文件]'
    return `${label} ${name || '(未知文件名)'}${size ? ` (${size})` : ''}`
  }
  if (type === 'record' || type === 'voice') {
    // OneBot v11 文档叫 record；**真机 NapCat 发的是 voice**
    // （`{file, path, url?, file_size}`，见 2026-11-03 task-10）。
    // 两个都认，否则真机语音会变成「[不支持的消息类型: voice]」被丢掉。
    // 有 duration 就带上（秒），没有就只说「语音」——不要编一个时长
    // （真机 voice 段常常没有 duration，时长要从语音文件里算，不值得为占位去读）。
    const dur = Number(d.duration)
    return Number.isFinite(dur) && dur > 0 ? `[语音] ${Math.round(dur)}s` : '[语音]'
  }
  if (SEG_PLACEHOLDER_LABEL[type]) return SEG_PLACEHOLDER_LABEL[type]
  return `[不支持的消息类型: ${type || '未知'}]`
}

// ── 时间口径（入站回复 / 主动搭话共用）──────────────────────────────────────
//
// 时段划分只有这一份。为什么必须共用：
//   · 入站提示词早就有「当前时间 + 星期 + 时段」这一套（2026-11-01「周日加班」
//     事故的修复，见 index.js timeSceneHint 的注释），但**主动搭话/接话**的
//     prompt 里没有时间 —— 模型只能瞎猜，半夜说「中午吃啥」就是这么来的；
//   · 如果两边各写一套，迟早会出现「入站说下午、主动搭话说上午」的错位。
export const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/**
 * 当前小时属于哪个时段（5–9 清早 / 9–12 上午 / 12–14 中午 / 14–18 下午 /
 * 18–22 晚上 / 22–1 深夜 / 1–5 凌晨）。
 * 注意 0 点算深夜、1–4 点算凌晨 —— 和 index.js timeSceneHint 原来的链条一致，
 * 那是「几点还醒着」的语义：0 点通常还没睡，3 点属于「熬夜到凌晨」。
 * @param {number} hour 0-23
 */
export function timePhaseName (hour) {
  if (hour >= 5 && hour < 9) return '清早'
  if (hour >= 9 && hour < 12) return '上午'
  if (hour >= 12 && hour < 14) return '中午'
  if (hour >= 14 && hour < 18) return '下午'
  if (hour >= 18 && hour < 22) return '晚上'
  if (hour >= 22 || hour < 1) return '深夜'
  return '凌晨'
}

/**
 * 目标时区下的「YYYY-MM-DD HH:mm」。
 *
 * 为什么不用 `new Date().toLocaleString('zh-CN')`：桥常常跑在 UTC 容器里，
 * 本机时区会把「下午 5 点」算成「上午 9 点」（2026-11-01 事故）。
 * sv-SE 的日期格式天然是 ISO 形状（2026-11-03 12:35），省得自己补零拼接。
 *
 * @param {Date} date
 * @param {string} tz IANA 时区
 */
export function formatClockMinute (date, tz) {
  const fmt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: tz || 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  })
  // 不同 Node/ICU 版本里日期与时间之间的分隔可能是空格或 'T'，统一成空格
  return fmt.format(date ?? new Date()).replace('T', ' ').replace(/\s+/g, ' ').trim()
}
