// test/unit-outbound-split.test.mjs —— 出站分条新规则（2026-11-05 用户定稿）
//
// 用户原话（定稿规则）：
//   · **换行一律拆成多条**（连续空行不产生空条）；空格**不算**切点；
//   · [SPLIT] 与换行同级（全角【SPLIT】也认），所有出站路径都要剥掉标记；
//   · 每段 > splitChars(30) 再按标点兜底拆；
//   · 每轮最多 5 条，超出**尾部合并**成最后一条，合并处的行内换行变空格；
//   · 段尾/切点处的中文句号删掉（！？保留）；
//   · 正常回复 / 主动搭话 / 接话 / [FOLLOW] 全走同一套；主动路径条间 600–1200ms。
//
// 历史教训（为什么换行要强制拆）：模型一轮写一大段（甚至带换行排版），
// 旧逻辑只有 [SPLIT] 才拆，没写标记就整坨塞进一条 —— 用户看到的是「一段话」，不是
// 「人在打字」。桥只能按 30 字硬拆，拆出来经常是「像个/人」这种半句话。
// 现在换行本身就是一个明确的「这里该断」信号，直接照做。
//
// 这些测试只打纯函数（common.splitOutboundParts）+ 源码接线断言，不连 LLM/QQ。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  splitOutboundParts, splitAtBoundary, stripPeriod, splitBySplitMarker, SPLIT_RE,
} from '../lib/bridge/common.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SRC = fs.readFileSync(path.join(ROOT, 'lib', 'bridge', 'index.js'), 'utf8')
const COMMON = fs.readFileSync(path.join(ROOT, 'lib', 'bridge', 'common.js'), 'utf8')
const AGENTS = fs.readFileSync(path.join(ROOT, 'qq-agent', 'AGENTS.md'), 'utf8')

/** 按花括号配平从源码里抠出一个 function（含 async）。 */
function fnSource (name) {
  const i = SRC.indexOf(`function ${name}`)
  assert.ok(i > 0, `定位不到 ${name}`)
  // ⚠️ 不能直接 indexOf('{', i)：带解构参数的函数（deliverReply({ peer, ... })）
  //    第一个 '{' 是参数解构，按花括号配平只会截到签名。先配平参数括号，再取函数体。
  let depthP = 0
  let k = SRC.indexOf('(', i)
  assert.ok(k > 0, `${name} 没有参数括号`)
  for (; k < SRC.length; k++) {
    if (SRC[k] === '(') depthP++
    else if (SRC[k] === ')') { depthP--; if (depthP === 0) break }
  }
  const start = SRC.indexOf('{', k)
  let depth = 0
  let end = start
  for (let j = start; j < SRC.length; j++) {
    if (SRC[j] === '{') depth++
    else if (SRC[j] === '}') { depth--; if (depth === 0) { end = j + 1; break } }
  }
  return SRC.slice(i, end)
}

// ══════════════════════════════════════════════════════════════════════════
// ① 换行强制分条
// ══════════════════════════════════════════════════════════════════════════

test('换行一律拆成多条（不再要求模型写 [SPLIT]）', () => {
  const { parts, stats } = splitOutboundParts('第一句\n第二句\n第三句')
  assert.deepEqual(parts, ['第一句', '第二句', '第三句'])
  assert.equal(stats.byNewline, 2, 'stats 要能看出是换行拆的（观察模型行为用）')
})

test('连续空行不产生空条；CRLF 也认', () => {
  assert.deepEqual(splitOutboundParts('第一句\n\n\n第二句').parts, ['第一句', '第二句'])
  assert.deepEqual(splitOutboundParts('第一句\r\n第二句').parts, ['第一句', '第二句'])
  // 首尾空白/纯空行不能产出空段
  assert.deepEqual(splitOutboundParts('\n\n  第一句  \n\n').parts, ['第一句'])
})

test('空格不算分条（短的一行里有空格也必须是一条）', () => {
  const { parts } = splitOutboundParts('hello world foo bar')
  assert.deepEqual(parts, ['hello world foo bar'], '空格不该把一句话拆开')
})

// ══════════════════════════════════════════════════════════════════════════
// ② [SPLIT] 与换行同级 + 全角
// ══════════════════════════════════════════════════════════════════════════

test('[SPLIT] 与换行都能拆，且先剥标记再按换行拆', () => {
  const { parts, stats } = splitOutboundParts('甲[SPLIT]乙\n丙')
  assert.deepEqual(parts, ['甲', '乙', '丙'])
  assert.equal(stats.byMarker, 1)
  assert.equal(stats.byNewline, 1)
})

test('全角【SPLIT】也认，标记不留在正文里', () => {
  const { parts } = splitOutboundParts('今天好热，【SPLIT】咱们去游泳吧')
  assert.deepEqual(parts, ['今天好热，', '咱们去游泳吧'])
  for (const p of parts) assert.ok(!/\[SPLIT\]|【SPLIT】/.test(p), `标记泄漏到正文：${p}`)
})

test('连续标记/首尾标记不产生空段', () => {
  assert.deepEqual(splitOutboundParts('[SPLIT]你好[SPLIT][SPLIT]世界[SPLIT]').parts, ['你好', '世界'])
})

test('splitBySplitMarker / SPLIT_RE 同时支持半角与全角', () => {
  assert.equal(splitBySplitMarker('a【SPLIT】b').marked, true)
  assert.deepEqual(splitBySplitMarker('a【SPLIT】b').parts, ['a', 'b'])
  assert.deepEqual('a【SPLIT】b[SPLIT]c'.split(SPLIT_RE), ['a', 'b', 'c'])
  assert.equal(splitBySplitMarker('没有标记').marked, false)
})

// ══════════════════════════════════════════════════════════════════════════
// ③ 阈值兜底 + 句号删除
// ══════════════════════════════════════════════════════════════════════════

test('单段超过阈值才按标点兜底拆，且不劈词', () => {
  const text = '今天下午的天气真的好好啊，你要不要和我一起出门去公园散散步'
  const { parts, stats } = splitOutboundParts(text, { threshold: 20 })
  assert.deepEqual(parts, ['今天下午的天气真的好好啊，', '你要不要和我一起出门去公园散散步'])
  assert.equal(stats.byThreshold, 1)
})

test('不超过阈值的长段不拆（宁长不残）', () => {
  assert.deepEqual(splitOutboundParts('啊'.repeat(30)).parts, ['啊'.repeat(30)])
})

test('段尾/切点处的中文句号删掉，！？保留', () => {
  assert.deepEqual(splitOutboundParts('今天好热。咱们去游泳吧！').parts, ['今天好热咱们去游泳吧！'])
  // 拆开的段各自也要去句号
  const { parts } = splitOutboundParts('第一句。\n第二句！')
  assert.deepEqual(parts, ['第一句', '第二句！'])
  assert.equal(stripPeriod('句号在末尾.'), '句号在末尾', '行尾英文句点也删')
})

// ══════════════════════════════════════════════════════════════════════════
// ④ 每轮最多 5 条 + 尾部合并
// ══════════════════════════════════════════════════════════════════════════

test('默认每轮最多 5 条：尾部并成最后一条，行内换行替换成空格', () => {
  const lines = ['一', '二', '三', '四', '五', '六', '七', '八']
  const { parts } = splitOutboundParts(lines.join('\n'))
  assert.equal(parts.length, 5)
  assert.deepEqual(parts.slice(0, 4), ['一', '二', '三', '四'])
  assert.equal(parts[4], '五 六 七 八', '尾部必须合并，且换行变空格（不能原样带 \\n）')
  for (const p of parts) assert.ok(!p.includes('\n'), '合并后的段里不能残留换行')
})

test('maxParts 可配（设置页会传 2–10）；超过时同样尾部合并', () => {
  const { parts } = splitOutboundParts('1\n2\n3\n4\n5\n6', { maxParts: 3 })
  assert.deepEqual(parts, ['1', '2', '3 4 5 6'])
  const only = splitOutboundParts('a\nb\nc', { maxParts: 1 })
  assert.deepEqual(only.parts, ['a b c'])
})

test('非法 maxParts / threshold 回落默认（30 / 5），不会抛错', () => {
  for (const bad of [0, -1, '', NaN, Infinity]) {
    const r = splitOutboundParts('一\n二\n三', { threshold: bad, maxParts: bad })
    assert.equal(r.parts.length, 3, `threshold/maxParts=${String(bad)} 时不该崩溃`)
  }
})

// ══════════════════════════════════════════════════════════════════════════
// ⑤ 审计项：ASCII 句点不劈 URL/版本号（P1-4）
// ══════════════════════════════════════════════════════════════════════════

test('ASCII 句点只在句末算切点：URL/版本号完好', () => {
  // 域名里的点不是句末
  assert.deepEqual(splitAtBoundary('aaaaaa.bbbbbb', 10), ['aaaaaa.bbbbbb'], 'URL/文件名里的点不能当切点')
  // 版本号里的点同理（整段没有别切点）
  assert.deepEqual(splitAtBoundary('版本v1.2.3', 5), ['版本v1.2.3'])
  // 句末的「. 」才是切点
  assert.deepEqual(splitAtBoundary('aaaaaa. bbbbbb', 10), ['aaaaaa.', 'bbbbbb'])
})

test('长回复里带 URL：按空格/逗号拆，URL 不能被句点劈开', () => {
  const url = 'https://example.com/a.b?x=1.2'
  const { parts } = splitOutboundParts(`看这个 ${url} 真的很好用，我强烈推荐给你`, { threshold: 12 })
  assert.ok(parts.some(p => p.includes(url)), `URL 被拆坏了：${JSON.stringify(parts)}`)
  assert.ok(!parts.some(p => /example\.$|v1\.$/.test(p)), '不能从点处劈 URL')
})

// ══════════════════════════════════════════════════════════════════════════
// ⑥ 审计项：chunkText max<=0 不死循环（P0-1）
// ══════════════════════════════════════════════════════════════════════════

test('chunkText: max 配成 0/空串/负数也绝不死循环（P0-1）', async () => {
  const { chunkText } = await import('../lib/bridge/common.js')
  // 0 / 空串 / 负数 / NaN 都必须退回到安全上限，而不是 while 死循环卡死发送线程。
  for (const bad of [0, -1, '', null, NaN, 'abc']) {
    const got = chunkText('x'.repeat(10), bad)
    assert.deepEqual(got, ['x'.repeat(10)], `max=${String(bad)} 时切分异常`)
  }
  // 超长文本也能正常切（默认上限 1500）
  const got = chunkText('x'.repeat(1600), 0)
  assert.deepEqual(got.map(s => s.length), [1500, 100])
})

// ══════════════════════════════════════════════════════════════════════════
// ⑦ 所有出站路径接同一套（源码接线断言）
// ══════════════════════════════════════════════════════════════════════════

test('deliverReply / dispatchOutbound / FOLLOW 都走 splitForSend', () => {
  const deliver = fnSource('deliverReply')
  assert.match(deliver, /splitForSend\(cappedPlain, '正常回复'\)/, '正常回复没接新分条')
  assert.match(deliver, /splitForSend\(f, 'FOLLOW'\)/, '[FOLLOW] 补发没接新分条（会原样发标记）')

  const dispatch = fnSource('dispatchOutbound')
  assert.match(dispatch, /splitForSend\(textForSend, tag\)/, '主动搭话/接话/戳没接新分条')
  // 主动路径条间延迟 600–1200ms（模拟真人一句一句打）
  assert.match(dispatch, /600 \+ Math\.random\(\) \* 600/, '主动路径的条间延迟不是 600–1200ms')
  assert.match(dispatch, /for \(let i = 0; i < parts\.length; i\+\+\)/, '主动路径没有逐条发送')
})

test('拆分来源 debug 日志（[SPLIT] / 换行 / 阈值 各多少）', () => {
  const body = fnSource('splitForSend')
  assert.match(body, /本轮拆分：来源=\[SPLIT\]×\$\{stats\.byMarker\} \/ 换行×\$\{stats\.byNewline\}/,
    '缺「本轮拆分来源」日志 —— 改提示词后没法观察模型到底用没用换行/[SPLIT]')
  assert.match(body, /共 \$\{parts\.length\} 条/, '日志里要有最终条数')
  assert.match(body, /logger\.debug\(/, '这是观察用日志，走 debug 级别即可（别刷 info）')
})

// ══════════════════════════════════════════════════════════════════════════
// ⑧ 提示词：三处注入 + AGENTS.md
// ══════════════════════════════════════════════════════════════════════════

test('「分条怎么写」块定义一次、三处 prompt 都注入（入站/主动搭话/接话）', () => {
  assert.match(SRC, /function splitStyleBlock \(\)/, '缺统一的「分条怎么写」提示块')
  const style = fnSource('splitStyleBlock')
  assert.match(style, /空格不算分条/, '提示块必须写明「空格不算分条」')
  assert.match(style, /\[SPLIT\]/, '提示块要给 [SPLIT] 用法')
  assert.match(style, /换行 = 分条|换行也是断点|直接换行 = 分条/, '提示块要说明换行也能分条')
  // 正例 ≥2：用户要求「2 行规则 + 2 个正例」
  assert.ok((style.match(/正例/g) ?? []).length >= 2, '提示块要有两个正例')
  // 三处注入（handleInbound 是 async function，fnSource 也能抠）
  // 2026-11-06：入站 prompt 的主体拆到 handleInboundAllowed（入口只做 allow 判定 + 分流）
  assert.match(fnSource('handleInboundAllowed'), /splitStyleBlock\(\)/, '入站回复 prompt 没注入分条写法')
  assert.match(fnSource('proactiveSpeak'), /splitStyleBlock\(\)/, '主动搭话 prompt 没注入分条写法')
  assert.match(fnSource('chatFollowSpeak'), /splitStyleBlock\(\)/, '接话 prompt 没注入分条写法')
  // 旧硬约束里那段 SPLIT 文案应该已经挪走（硬约束只留「不能做什么」）
  assert.doesNotMatch(fnSource('handleInboundAllowed'), /\[SPLIT\] 只能写在逗号/, '旧的硬约束 SPLIT 文案还留着')
})

test('AGENTS.md 写了分条写法 + 单条上限改成实际值（P2-5）', () => {
  assert.match(AGENTS, /空格不算分条/, 'AGENTS.md 没写「空格不算分条」')
  assert.match(AGENTS, /\[SPLIT\]/, 'AGENTS.md 没写 [SPLIT]')
  assert.match(AGENTS, /直接换行 = 分条/, 'AGENTS.md 没写换行即分条')
  assert.match(AGENTS, /每轮最多 5 条/, 'AGENTS.md 没写每轮 5 条上限')
  assert.doesNotMatch(AGENTS, /单条上限约 1500 字/, 'P2-5：还写着过期的「单条上限约 1500 字」')
  assert.match(AGENTS, /policy\.maxReplyChars/, '单条上限要写「以桥配置为准」')
  assert.match(AGENTS, /生产配置为 120 字/, '要写实际值（生产 120）')
})

test('security 里两种 SPLIT 写法都被打散（群友注入不能伪造断点）', () => {
  const security = fs.readFileSync(path.join(ROOT, 'lib', 'bridge', 'security.js'), 'utf8')
  assert.match(security, /out = out\.replace\(\/\\\[SPLIT\\\]\/gi, '\[SPLIT_\]'\)/, '半角 [SPLIT] 没打散')
  assert.match(security, /【SPLIT_】/, '全角【SPLIT】没打散（出站分条认全角，注入也能生效！）')
})
