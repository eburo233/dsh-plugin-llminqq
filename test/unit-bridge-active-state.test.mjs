// unit-bridge-active-state.test.mjs —— 主动/接话路径的状态可见性 + 记忆源（2026-11-06）
//
// 用户反馈 ①「模型看不到好感度」的**真正**原因之一：三条主动路径
// （proactiveSpeak 主动搭话 / chatFollowSpeak 接话 / handlePoke 戳一戳）
// 原来**完全没有**注入精力/心情/好感度 —— 模型主动开口时用的是陌生人分寸。
// 而且这三条路径的记忆源是 readMemoryDigest()（读整份 digest 截 3000 字，不分 peer），
// 实测 342/342 条 prompt 都带着别人的会话节 + 一个月前那条已结束的「三点开会」。
//
// 本测试就是锁这两件事（桥是长驻进程不能 import，照惯例抠源码断言）：
//   ① 三条路径都注入 affectionBriefHints（关系状态 + 分寸 + 回写用法）
//   ② 三条路径都走 memoryBlockForActive，不再调用 readMemoryDigest()
//   ③ [AFF] 标记在三条路径里都被剥掉再用（否则会被当正文发到 QQ）
//   ④ 模型自评只在「内容真的发出去了」之后才计分（和打卡同一个时机）

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = fs.readFileSync(path.join(PKG, 'lib', 'bridge', 'index.js'), 'utf8')

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
    if (SRC[j] === '{') { depth++; started = true } else if (SRC[j] === '}') {
      depth--
      if (started && depth === 0) return SRC.slice(i, j + 1)
    }
  }
  assert.fail(`${name} 的花括号不配平`)
}

// ══════════════════════════════════════════════════════════════════════════
// ① 三条主动路径的关系状态注入
// ══════════════════════════════════════════════════════════════════════════
test('proactiveSpeak：注入关系状态（原来主动开口时它不知道自己跟这人什么关系）', () => {
  const body = fnSource('proactiveSpeak')
  assert.match(body, /affectionBriefHints\(/, '要注入 equation 状态/分寸')
  assert.match(body, /stateLines/, '要拼进 prompt 的 lines 数组')
})

test('chatFollowSpeak：注入关系状态（接话也一样）', () => {
  const body = fnSource('chatFollowSpeak')
  assert.match(body, /affectionBriefHints\(/, '要注入关系状态/分寸')
  assert.match(body, /stateLines/, '要拼进 prompt 的 lines 数组')
})

test('handlePoke：注入关系状态（提示里写着「看你和这人的关系」，但原来根本拿不到）', () => {
  const body = fnSource('handlePoke')
  assert.match(body, /affectionBriefHints\(/, '戳一戳也要给关系状态')
  assert.doesNotMatch(body, /readMemoryDigest\(\)/,
    '戳一戳不该再读整份 digest')
})

// ══════════════════════════════════════════════════════════════════════════
// ② 记忆源：三条路径都走 memoryBlockForActive（v5 / 本人那一节）
// ══════════════════════════════════════════════════════════════════════════
test('proactiveSpeak / chatFollowSpeak 走 memoryBlockForActive，不再读整份 digest', () => {
  for (const fn of ['proactiveSpeak', 'chatFollowSpeak']) {
    const body = fnSource(fn)
    assert.match(body, /memoryBlockForActive\(/, `${fn} 要走 memoryBlockForActive()`)
    assert.doesNotMatch(body, /=\s*readMemoryDigest\(\)/,
      `${fn} 不能再用「整份 digest 截 3000 字」（会带别人的会话 + 已过期的钉子记忆）`)
  }
})

test('memoryBlockForActive：v4 兜底只读**本人那一节**（不是整份 digest）', () => {
  const body = fnSource('memoryBlockForActive')
  assert.match(body, /readMemoryDigestFor\(peerKey\)/, 'v4 兜底要用按 peer 分节的读法')
  assert.doesNotMatch(body, /=\s*readMemoryDigest\(\)/, '不许退回整份 digest')
  assert.match(body, /v5MemoryRecallBlock\(/, '优先走 v5 检索')
})

test('memoryBlockForActive：主动轮没有「当前消息」，要用本会话最近的原文当检索词', () => {
  // 原因：v5 的 rankMemories 对空 query 直接返回空（search.mjs: `if (!q) return out`）。
  // 不补这几条原文，主动/接话轮的 v5 检索会永远 0 条。
  const body = fnSource('memoryBlockForActive')
  assert.match(body, /v5RecentConvText\(/, '要补一个非空 query')
  const helper = fnSource('v5RecentConvText')
  assert.match(helper, /FROM events WHERE conv = \?/, '按会话取最近的原文')
  assert.match(helper, /catch/, '取不到要静默返回空（不能拖垮搭话）')
})

// ══════════════════════════════════════════════════════════════════════════
// ③ [AFF] 在主动路径里先剥后发
// ══════════════════════════════════════════════════════════════════════════
test('[AFF] 在 proactive / chatFollow / poke 三条路径里都被剥掉（否则会当正文发出去）', () => {
  for (const fn of ['proactiveSpeak', 'chatFollowSpeak', 'handlePoke']) {
    const body = fnSource(fn)
    assert.match(body, /peelAffMarker\(/, `${fn} 要用 peelAffMarker 剥 [AFF]`)
  }
  const helper = fnSource('peelAffMarker')
  assert.match(helper, /extractAffMarkers\(/, 'peelAffMarker 内部要走统一的 extractAffMarkers')
})

test('dispatchOutbound 本身不认识 [AFF] —— 所以必须在调用它之前剥（顺序锁）', () => {
  // 直接查源码顺序：peelAffMarker 在 dispatchOutbound 之前调。
  // （用 handlePoke 这一处，因为它是最短的一条主动路径，顺序最好读。）
  const body = fnSource('handlePoke')
  const iPeel = body.indexOf('peelAffMarker(')
  const iSend = body.indexOf('await dispatchOutbound(')
  assert.ok(iPeel > 0, 'handlePoke 里找不到 peelAffMarker')
  assert.ok(iSend > 0, 'handlePoke 里找不到 dispatchOutbound')
  assert.ok(iSend > iPeel, 'peelAffMarker 必须在 dispatchOutbound 之前（否则标记会发到 QQ）')
})

// ══════════════════════════════════════════════════════════════════════════
// ④ 模型自评只在「内容真的发出去了」之后计分
// ══════════════════════════════════════════════════════════════════════════
test('入站路径：模型自评在打卡之后（发送成功才计分，和打卡同一时机）', () => {
  // 直接在源码里按索引比（deliverReply 有嵌套解构，fnSource 配平容易取到别处）
  const iCheckin = SRC.indexOf('affectionCheckin(senderQq, { peerKey })')
  assert.ok(iCheckin > 0, '找不到打卡')
  // ⚠️ 第一处 applyModelAffection 在「沉默分支」里（只写了标记不出声也要计分），
  // 主流程那处必须**在打卡之后**。所以从打卡位置往后找。
  const iModel = SRC.indexOf('applyModelAffection(senderQq, affMarker', iCheckin)
  assert.ok(iModel > 0, '打卡之后找不到模型自评计分')
  assert.ok(iModel > iCheckin,
    '模型自评必须在打卡之后 —— 那里才是「正文真的发出去了」的位置（假打卡同理防假涨分）')
})

test('入站路径：只有 [AFF] 没有正文 → 按沉默处理，但仍可计分（模型可能只想表个态）', () => {
  const body = fnSource('deliverReply')
  // 沉默分支里也要应用（否则「只写标记不出声」的提议全丢）
  const iSilent = body.indexOf('旁听→沉默')
  assert.ok(iSilent > 0)
  assert.match(body.slice(iSilent, iSilent + 900), /applyModelAffection\(/,
    '沉默分支也要应用模型提议')
})

test('主动路径：模型自评在 dispatchOutbound 成功之后', () => {
  for (const fn of ['proactiveSpeak', 'chatFollowSpeak']) {
    const body = fnSource(fn)
    const iSend = body.indexOf('const { sent } = await dispatchOutbound')
    const iApply = body.indexOf('applyActiveModelAffection(')
    assert.ok(iSend > 0, `${fn} 找不到 dispatchOutbound`)
    assert.ok(iApply > 0, `${fn} 要找 applyActiveModelAffection`)
    assert.ok(iApply > iSend, `${fn}：内容真的发出去之后才计分`)
  }
})

test('[AFF] 写在 [VOICE:…] / [FOLLOW:…] 里也要被剥掉（它们会单独发出去，晚剥就漏）', () => {
  // 模型完全可能写成 `[VOICE:夸你一句 [AFF:+1:他夸我]]`。如果先抽 VOICE、
  // 再剥 AFF，那 AFF 就跟着语音文本一起进了 TTS；而 TTS 那条不会再过任何正则。
  // 所以剥离必须在**最前面**（extractAffMarkers 之后才是 VOICE/POKE/FOLLOW）。
  const iAff = SRC.indexOf('const affParsed = extractAffMarkers(bodyText)')
  const iVoice = SRC.indexOf('VOICE_RE.lastIndex = 0', iAff - 4000)
  assert.ok(iAff > 0, '找不到 [AFF] 剥离')
  assert.ok(iVoice > 0, '找不到 VOICE 抽取')
  assert.ok(iAff < iVoice,
    `[AFF] 必须在 VOICE/POKE/FOLLOW 抽取之前剥（aff=${iAff} voice=${iVoice}）`)
  const iFollow = SRC.indexOf('FOLLOW_RE.lastIndex = 0', iAff - 4000)
  assert.ok(iAff < iFollow, '[AFF] 必须在 FOLLOW 抽取之前剥')
})

test('handleInbound 必须是 async（否则 onEvent 的 .catch 会炸在 undefined 上）', () => {
  // 2026-11-06 实锤回归：把 handleInbound 拆成两层时误写成非 async，
  // 于是 early-return 分支（notice/non-message 事件）返回 undefined，
  // onEvent 里 `handleInbound(evt).catch(...)` → TypeError →
  // 生产日志 `onebot: 事件处理异常 Cannot read properties of undefined (reading 'catch')`。
  // 这类错误会让**每一条 notice 事件**都丢，且只留一行不像 bug 的日志。
  assert.match(SRC, /async function handleInbound\s*\(/, 'handleInbound 必须是 async')
  assert.doesNotMatch(SRC, /(^|\n)function handleInbound\s*\(/, 'handleInbound 不能是非 async 的普通函数')
})

test('onEvent 给 handleInbound 挂了 catch（未捕获异常要有堆栈线索）', () => {
  const body = SRC.slice(SRC.indexOf('gateway.onEvent'))
  assert.match(body.slice(0, 1200), /handleInbound\(evt\)\.catch\(/, 'onEvent 要 .catch（这是发现上面那个 async 回归的方式）')
})
