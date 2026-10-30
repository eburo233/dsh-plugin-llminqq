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
