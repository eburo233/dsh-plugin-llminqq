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

export function chunkText(text, max) {
  const out = []
  let rest = text
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max)
    if (cut < max * 0.5) cut = max
    // ⚠️ 别把 [AT:123456] / [SEND_FILE:路径] / [VOICE:...] 这类控制标记从中间切两半：
    // 半截标记会作为**可见乱码**发到 QQ（群友看到 "[AT:12"），而且 textToSegments
    // 认不出被切开的标记 → @ 人和发文件静默失效 —— 只在长回复里偶发，极难排查。
    const open = rest.lastIndexOf('[', cut - 1)
    if (open >= 0) {
      const closeAfterOpen = rest.indexOf(']', open)
      if (closeAfterOpen === -1 || closeAfterOpen >= cut) {
        // 切点落在标记内部：优先退到 '['（标记整体进下一段）；
        // 退得太靠前会让这一条只剩几个字，那就往前补到 ']' 之后。
        if (open > 0 && cut - open <= 256) {
          cut = open
        } else {
          const close = rest.indexOf(']', cut)
          // 标记本身就比 max 长（比如很长的 SEND_FILE 路径）：宁可这一条超长，
          // 也不要切成两半 —— 半截标记发出去是可见乱码，而且功能直接失效。
          if (close >= 0 && close - cut <= 1024) cut = Math.min(close + 1, rest.length)
        }
      }
    }
    if (cut <= 0) cut = Math.min(max, rest.length)
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
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
