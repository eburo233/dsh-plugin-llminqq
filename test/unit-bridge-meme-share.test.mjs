// unit-bridge-meme-share.test.mjs —— 表情包识别 + 分享场景判定（2026-11-06，P0-3 / P0-4）
//
// 用户反馈两条：
//   ① 「别人发表情包时，模型总是倾向于描述收到了一张怎么样的图片，而不是回一张
//      情形对应的表情，或是反应。」
//   ② 「分享视频/卡片时，模型总是倾向于分析视频。文本和卡片是分开的，一般请求会
//      过一会儿才发来；或者一段时间之后用引用补上。需要能正常处理。」
//
// 核实到的根因（详见各条测试的注释）：
//   · 表情包和照片在桥里**完全分不清** —— napcat 明明给了 sub_type/summary/emoji_id，
//     桥只读 url/file，把它们全丢了。于是 55 次收图，模型每次只收到
//     「他发了一张图片，能直接看到内容」→ 只能描述图。
//   · 分享场景的判定写成了**无条件祈使**（「有人发 BV 号/链接让你看 → 先 bili_subtitle」），
//     而且没有「他可能只是随手分享」这个分支；卡片还被桥预先抓成「[视频详情] 资料」。
//     另外请求常常是**下一轮**才发（或引用着卡片问），必须有跨轮状态。
//
// 测试分两层：
//   ① 纯函数（common.js）：isStickerImage / hasShareRequest / hasShareTarget / shareInfoFromCard
//   ② 源码接线锁（桥是长驻进程入口不能 import，照 unit-log-runaway / unit-outbound-split 的老办法抠源码）：
//      · 图片分类真的进了上下文（不是只算不用）
//      · face 段不再推空串（不再丢消息）
//      · 分享判定在引用解析**之后**（否则「引用着卡片问」永远判不到）
//      · 「他只是随手分享」这段提示真的存在，且 B站块不再是无条件祈使

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const COMMON = await import(pathToFileURL(path.join(PKG, 'lib', 'bridge', 'common.js')).href)
const SRC = fs.readFileSync(path.join(PKG, 'lib', 'bridge', 'index.js'), 'utf8')

/** 按花括号配平抠顶层函数（同 unit-proactive-time / unit-outbound-split 的老办法）。 */
function fnSource (name) {
  const i = SRC.search(new RegExp(`(?:async\\s+)?function ${name}\\s*\\(`))
  assert.ok(i > 0, `定位不到 ${name}`)
  let paren = 0
  let k = SRC.indexOf('(', i)
  for (; k < SRC.length; k++) {
    if (SRC[k] === '(') paren++
    else if (SRC[k] === ')') { paren--; if (paren === 0) break }
  }
  let depth = 0
  let started = false
  for (let j = k; j < SRC.length; j++) {
    const ch = SRC[j]
    if (ch === '{') { depth++; started = true } else if (ch === '}') {
      depth--
      if (started && depth === 0) return SRC.slice(i, j + 1)
    }
  }
  assert.fail(`${name} 的花括号不配平`)
}

// ══════════════════════════════════════════════════════════════════════════
// ① 表情包识别（isStickerImage）
// ══════════════════════════════════════════════════════════════════════════
test('isStickerImage：动画表情（sub_type != 0）判成表情包', () => {
  assert.equal(COMMON.isStickerImage({ sub_type: 1, url: 'http://x/1.jpg' }), true)
  assert.equal(COMMON.isStickerImage({ subType: 2 }), true, '驼峰写法也要认')
  assert.equal(COMMON.isStickerImage({ picSubType: 1 }), true)
})

test('isStickerImage：普通照片（sub_type 0 + summary [图片]）不判成表情', () => {
  assert.equal(COMMON.isStickerImage({ sub_type: 0, summary: '[图片]', url: 'http://x/p.jpg' }), false)
  assert.equal(COMMON.isStickerImage({ sub_type: '0', summary: '[照片]' }), false)
  assert.equal(COMMON.isStickerImage({ url: 'http://x/p.jpg' }), false, '没有元信息时按照片处理（保守）')
})

test('isStickerImage：商城/自定义表情（带 emoji_id）判成表情包', () => {
  assert.equal(COMMON.isStickerImage({ emoji_id: '9', emoji_package_id: '3', url: 'http://x/e.gif' }), true)
  assert.equal(COMMON.isStickerImage({ emojiId: '9' }), true)
})

test('isStickerImage：summary 兜底 —— napcat 自己填的 [动画表情] / 表情名', () => {
  assert.equal(COMMON.isStickerImage({ summary: '[动画表情]' }), true)
  assert.equal(COMMON.isStickerImage({ summary: '[表情包]' }), true)
  assert.equal(COMMON.isStickerImage({ summary: '咬死你' }), false, '纯文字名不是 [xxx] 形状，保守判成照片')
  assert.equal(COMMON.isStickerImage({ summary: '[咬死你]' }), true, '带方括号的表情名 → 表情')
  assert.equal(COMMON.isStickerImage(null), false)
  assert.equal(COMMON.isStickerImage('x'), false)
})

// ══════════════════════════════════════════════════════════════════════════
// ② 分享场景判定（hasShareRequest / hasShareTarget / shareInfoFromCard）
// ══════════════════════════════════════════════════════════════════════════
test('hasShareRequest：明确的「让我看」请求词能识别', () => {
  for (const t of ['BV1SBx96TECt，你看看', '这个帮我看看', '讲的啥', '怎么样', '你觉得呢',
    '有啥意思', '这是谁啊', '你听听', '评价一下', '好玩吗', '值得看吗']) {
    assert.equal(COMMON.hasShareRequest(t), true, `应判成有请求：${t}`)
  }
})

test('hasShareRequest：纯感叹/随手分享不算「让我看」', () => {
  // 这几句是用户真实说过的「分享」，不是请求 —— 它们不该触发深看。
  for (const t of ['我去！', '这视频挺好玩的', '嘿嘿', '哈哈', '好看', '这封面可以', '']) {
    assert.equal(COMMON.hasShareRequest(t), false, `不该判成请求：${t}`)
  }
})

test('hasShareTarget：卡片 / BV 号 / 常见视频站链接都能认出来', () => {
  assert.equal(COMMON.hasShareTarget({ cards: ['[卡片] x'] }), true)
  assert.equal(COMMON.hasShareTarget({ text: 'BV1SBx96TECt' }), true)
  assert.equal(COMMON.hasShareTarget({ text: 'https://b23.tv/th7TvRT' }), true)
  assert.equal(COMMON.hasShareTarget({ text: 'https://www.bilibili.com/video/BV1xx' }), true)
  assert.equal(COMMON.hasShareTarget({ text: 'https://youtu.be/abc' }), true)
  assert.equal(COMMON.hasShareTarget({ text: '今天好累' }), false)
  assert.equal(COMMON.hasShareTarget(null), false)
})

test('shareInfoFromCard：从卡片文本里抠标题 / URL / BV', () => {
  const a = COMMON.shareInfoFromCard('[卡片] 养鱼人现状：我要给鲸鲸完整的一生！（哔哩哔哩） https://b23.tv/th7TvRT')
  assert.equal(a.url, 'https://b23.tv/th7TvRT')
  assert.match(a.title, /养鱼人现状/)
  assert.ok(!a.title.includes('http'), '标题里不该留 URL')
  assert.ok(!/[（(]\s*哔哩哔哩/.test(a.title), '标题里不该留（哔哩哔哩）')

  const b = COMMON.shareInfoFromCard('[卡片] 影鲸之主 https://www.bilibili.com/video/BV1SBx96TECt')
  assert.equal(b.bvid, 'BV1SBx96TECt', '带真地址时要能抠出 BV 号')
})

test('shareInfoFromCard：乱输入不抛错（外部内容不可信）', () => {
  for (const x of ['', '没有链接的卡片', null, undefined, 123]) {
    assert.doesNotThrow(() => COMMON.shareInfoFromCard(x), `输入 ${JSON.stringify(x)} 不该抛错`)
  }
})

// ══════════════════════════════════════════════════════════════════════════
// ③ 源码接线锁：桥必须真的用了这些判定
// ══════════════════════════════════════════════════════════════════════════
test('表情：图片分类结果真的进了上下文（算了不用 = 白算）', () => {
  const body = fnSource('handleInboundAllowed')
  assert.match(body, /isStickerImage\(/, '入站路径要调用 isStickerImage 分类')
  assert.match(body, /stickerCount/, '要统计表情包数量并透传')
  // 上下文里必须有「表情包」这一块，且明确要求「别描述」
  assert.match(body, /其中 \$\{nSticker\} 张是表情包|张是表情包/, '上下文要区分表情包和照片')
  assert.match(body, /不要.*把表情包当照片去描述|表情包是用来接话的/, '要给「别描述、回一张」的期望')
})

test('表情：face 段不再推空串（不再因为一个 QQ 表情就丢整条消息）', () => {
  const body = fnSource('flattenMessage')
  assert.doesNotMatch(body, /seg\.type === 'face'\)\s*texts\.push\(''\)/,
    "face 段不能推空串 —— 生产实锤 2026-11-05T14:46:42 就是这样丢掉整条消息的")
  assert.match(body, /QQ表情/, 'face 段要给占位文本')
})

test('表情：合并轮透传 stickerCount（入队时算过，不必再算、也不能丢）', () => {
  const body = fnSource('handleInboundAllowed')
  assert.match(body, /mergedExtras\.stickerCount|stickerCount/, '合并轮要带上分类结果')
})

test('分享：判定必须在**引用解析之后**（否则「引用着卡片问」永远判不到）', () => {
  // 这是本次改动里最容易回归的一条：先写 shareCtx 再用 quotedText 就会永远为空。
  const quoteIdx = SRC.indexOf('let quotedText = \'\'')
  const shareIdx = SRC.indexOf('const curHasTarget = hasShareTarget(')
  assert.ok(quoteIdx > 0, '找不到 quotedText 解析')
  assert.ok(shareIdx > 0, '找不到分享判定')
  assert.ok(shareIdx > quoteIdx,
    `分享判定必须在引用解析之后（quoteIdx=${quoteIdx} shareIdx=${shareIdx}）——`
    + '否则「隔一段时间引用着卡片问」这个用户点名的场景永远判不到')
})

test('分享：跨轮状态存在（先发卡片、下一轮才说「你看看」要接得上）', () => {
  const body = fnSource('handleInboundAllowed')
  for (const fn of ['noteShare(', 'pendingShareOf(', 'clearShare(']) {
    assert.match(body, new RegExp(fn.replace('(', '\\(')), `要用 ${fn} 维护跨轮分享状态`)
  }
  assert.match(SRC, /const sharePending = new Map\(\)/, '需要 peerKey → 分享物 的会话内缓存')
  assert.match(SRC, /SHARE_PENDING_TTL_MS/, '要有 TTL（不能无限期挂着一张旧卡片）')
})

test('分享：「他明确让我看」和「他只是随手分享」是两条不同的提示', () => {
  const body = fnSource('handleInboundAllowed')
  assert.match(body, /【他明确让你看这个】/, '要给「让我看」的提示（这时才深看）')
  assert.match(body, /【他只是随手分享，没说让我干什么】/, '要给「随手分享」的提示（这时别分析）')
  assert.match(body, /别去分析它/, '随手分享这条必须明说「别去分析」')
})

test('分享：B站块不再是无条件祈使（原来「发了 = 让你看」正是「总在分析」的来源）', () => {
  const body = fnSource('handleInboundAllowed')
  // 旧文案必须消失
  assert.doesNotMatch(body, /有人发 BV 号\/链接让你看 → \*\*先 bili_subtitle 读字幕\*\*/,
    '旧的「发了就让你看」无条件祈使必须改掉')
  // 新文案：带条件
  assert.match(body, /\*\*他说「看看 \/ 讲讲 \/ 怎么样 \/ 这是啥」\*\*时才去读字幕/,
    '要明确「他说要我看时才读字幕」')
})

test('分享：卡片详情标明来源（是桥抓的，不是他说的）', () => {
  const body = fnSource('handleInboundAllowed')
  assert.match(body, /cardDetail/, '卡片抓到的详情要单独留档（不混进他的话）')
})

test('分享：合并轮里卡片在 mergedExtras 里 —— 判定必须把两边都算上', () => {
  // 用户反馈「文本和卡片是分开的，请求过一会儿才发来」，很可能正好落进同一个合并批：
  // 排空时合成虚拟事件，flat.cards 是空的，卡片在 mergedExtras.cards 里。
  // 只查 flat.cards 的话，这一批就永远判不出「他分享了东西」。
  const body = fnSource('handleInboundAllowed')
  assert.match(body, /mergedExtras\?\.cards/, '要读 mergedExtras.cards（合并轮的卡片在这里）')
  assert.match(body, /allCardsForShare/, '要合并两边再判定')
})
