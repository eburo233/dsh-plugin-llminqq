// test/unit-chunk.test.mjs —— chunkText 必须「按标点切」，不能从词中间劈开
//
// 背景（2026-11-02 用户实测，生产 maxReplyChars=50）：
//   NapCat 日志里一条回复被切成
//     「……反而更像个」
//     「人；真正让人出戏的还是记性差……」
//   「像个人」从**词中间**劈成了两条。
//
//   根因：chunkText 只认 '\n' 这一个切点，找不到就 slice(0, max) 硬切。
//   而 splitAtBoundary/splitChars=30 那套「按标点切」只作用于「拆几条发」，
//   全角逗号在 50 字上限这一层根本没人看 —— 兜底反而成了最伤人的那一刀。
//
// 这个文件锁住三件事：
//   ① 有标点就在标点处断（中文逗号/句号/顿号/空格/换行都算）
//   ② limit 内没标点 → 往后找第一个标点（宁长不劈词）；全文没标点才硬切
//   ③ [AT:xxx] / [SEND_FILE:] / [VOICE:] 控制标记不被劈开（发文件/@ 静默失效的根因）
//
// ⚠️ chunkText 是「**必须切**」语义（单条消息的兜底上限），和 splitAtBoundary
//    的「宁可整条不切」不同，所以这里绝不能断言「无标点就不切」。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  chunkText, splitAtBoundary,
} from '../lib/bridge/common.js'

// 断点字符（和 common.js BOUNDARY_CHARS 一致，故意不含 ！？）
const BOUNDARY = '，、,。. \u3000\n'

/** 除末段外，每段都应该在自然停顿处收尾。 */
function assertAllButLastEndAtBoundary (parts) {
  for (let i = 0; i < parts.length - 1; i++) {
    assert.ok(
      BOUNDARY.includes(parts[i].slice(-1)),
      `第 ${i + 1} 段没有在标点/空白处收尾（可能劈词了）：${JSON.stringify(parts[i].slice(-12))}`,
    )
  }
}

test('用户实测回归：50 字上限不能把「像个人」劈成「像个 / 人；」', () => {
  // 句子里第一个逗号在 20 字处，之后是一段没有标点的长句 —— 旧代码会一直
  // 硬切到 50 字，正好落在「真的很像个人」中间。
  const text = 'A'.repeat(20) + '，' + '真的很像个人；' + 'B'.repeat(40)
  const parts = chunkText(text, 50)
  assert.deepEqual(parts, [
    'A'.repeat(20) + '，',
    '真的很像个人；' + 'B'.repeat(40),
  ])
  assert.ok(!parts.some(p => p === 'A'.repeat(20) || p.endsWith('像个')),
    `被从词中间劈开了：${JSON.stringify(parts)}`)
})

test('中文逗号/句号都能当切点，切点留在左段', () => {
  const text = '甲'.repeat(30) + '，' + '乙'.repeat(40) + '。' + '丙'.repeat(30)
  const parts = chunkText(text, 50)
  assert.deepEqual(parts, [
    '甲'.repeat(30) + '，',
    '乙'.repeat(40) + '。',
    '丙'.repeat(30),
  ])
  assertAllButLastEndAtBoundary(parts)
  assert.equal(parts.join(''), text, '切块不能丢字符')
})

test('limit 内没有切点 → 往后找第一个，宁可超长也不劈词', () => {
  const text = 'x'.repeat(80) + '，' + 'y'.repeat(10)
  const parts = chunkText(text, 50)
  assert.equal(parts[0], 'x'.repeat(80) + '，', '左段必须是完整的一逗号句（可超 limit）')
  assert.equal(parts[1], 'y'.repeat(10))
})

test('英文按空格切，不把单词劈开', () => {
  const text = 'hello world this is a test'
  const parts = chunkText(text, 12)
  assert.deepEqual(parts.map(p => p.trim()), ['hello world', 'this is a', 'test'])
  for (const p of parts) {
    assert.match(p.trim(), /^[A-Za-z]+(?: [A-Za-z]+)*$/, `英文单词被劈开了：${JSON.stringify(p)}`)
  }
  // 空格留在上一段末尾，所以拼回去一个字符不丢（旧行为：只吃换行）
  assert.equal(parts.join(''), text)
})

test('全文没有任何切点 → 仍然要切（必须切语义），硬切 max', () => {
  const parts = chunkText('x'.repeat(130), 50)
  assert.deepEqual(parts.map(p => p.length), [50, 50, 30])
  assert.equal(parts.join(''), 'x'.repeat(130))
})

test('换行点太靠前（< limit/2）沿用旧行为：不在这里断', () => {
  // unit-common 里有同样的回归用例（chunkText: 换行在左半边）；这里再锁一句：
  // 别在「边界感知」改造里把「第一段只剩 ab」这种碎句放回来。
  const text = 'ab\n' + 'c'.repeat(20)
  assert.equal(chunkText(text, 10)[0], 'ab\nccccccc')
})

test('中文逗号太靠前也照切（真人就是逗号后换口气）', () => {
  const parts = chunkText('好，' + 'A'.repeat(100), 50)
  assert.equal(parts[0], '好，')
  assert.equal(parts.slice(1).join(''), 'A'.repeat(100))
})

test('[AT:] 标记跨过边界时不被切断', () => {
  // 旧代码就有的保护，别在这次改造里弄丢
  const text = 'x'.repeat(9) + '[AT:12345]'
  const parts = chunkText(text, 10)
  assert.deepEqual(parts, ['x'.repeat(9), '[AT:12345]'])
})

test('[VOICE:] 标记跨过边界时不被切断', () => {
  const text = 'x'.repeat(9) + '[VOICE:你好呀]'
  const parts = chunkText(text, 10)
  assert.deepEqual(parts, ['x'.repeat(9), '[VOICE:你好呀]'])
  assert.ok(parts.some(p => /\[VOICE:[^\]]+\]/.test(p)), '语音标记被劈开了（功能会静默失效）')
})

test('[SEND_FILE:] 标记跨块时完整保留，且字符不丢', () => {
  const text = 'y'.repeat(8) + '[SEND_FILE: /tmp/long-path.png]' + 'z'.repeat(20)
  const parts = chunkText(text, 12)
  assert.equal(parts.join(''), text, '切块不能丢字符')
  assert.ok(parts.some(p => p.includes('[SEND_FILE: /tmp/long-path.png]')),
    `SEND_FILE 标记被劈开了：${JSON.stringify(parts)}`)
  // 任何一段里出现的 '[' 都必须有配对的 ']' —— 半截标记 = QQ 上的可见乱码 + 功能失效
  for (const p of parts) {
    if (p.includes('[')) {
      assert.ok(p.includes(']'), `这段里有个没闭合的标记：${JSON.stringify(p)}`)
    }
  }
})

test('标记本身比 max 还长 → 整条发（宁长不残，绝不发半截乱码）', () => {
  const marker = '[SEND_FILE: ' + '/d/'.repeat(20) + 'a.png]'
  const parts = chunkText(marker, 10)
  assert.deepEqual(parts, [marker])
})

test('混合标点长文：除末段外都在标点处收尾，且字符不丢', () => {
  const text = '今天真的好累啊，加班到九点。'
    + '地铁上还被人踩了一脚。'
    + '不过回家路上买到了想吃的草莓，'
    + '算是有点安慰吧'
  const parts = chunkText(text, 20)
  assertAllButLastEndAtBoundary(parts)
  assert.equal(parts.join(''), text)
  for (const p of parts) assert.ok(p.length > 0, '不能产出空段')
})

test('chunkText 和 splitAtBoundary 的语义不同（别把两者互换）', () => {
  // 无切点：splitAtBoundary 整条不切（宁长不残）；chunkText 必须切（平台/风格上限）
  const noBoundary = '哈'.repeat(40)
  assert.deepEqual(splitAtBoundary(noBoundary, 10), [noBoundary])
  assert.equal(chunkText(noBoundary, 10).length, 4)
})
