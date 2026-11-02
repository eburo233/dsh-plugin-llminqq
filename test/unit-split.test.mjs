// test/unit-split.test.mjs —— 长句按标点切分 + 精力全局化（v2-3）
//
// 用户原始诉求（2026-11-02）：
//   「一条话被从词中间劈成两条发出来」—— 例：一句话被拆成「……你要」「不要……」。
//   要求**按标点截**，宁可长一点，也不要从词中间砍。
//
// 这个文件锁住三件事：
//   ① splitAtBoundary：只在标点/空白处切、绝不劈词；无切点就整条不切
//   ② [SPLIT] 标记：模型标的断点要能被提取、标记本身要能剥掉
//   ③ 精力全局化：所有会话共享 state.energy；长度系数/情绪系数/单条上限/150 条见底

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  splitAtBoundary, truncateAtBoundary, splitBySplitMarker, SPLIT_RE,
} from '../lib/bridge/common.js'
import { createState } from '../lib/bridge/state.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = fs.readFileSync(path.join(ROOT, 'lib', 'bridge', 'index.js'), 'utf8')

// 用户原例（前半句 13 字含逗号，后半句 16 字）
const USER_CASE = '今天下午的天气真的好好啊，你要不要和我一起出门去公园散散步'

// ══════════════════════════════════════════════════════════════════════════
// ① splitAtBoundary：按标点切，绝不劈词
// ══════════════════════════════════════════════════════════════════════════

test('用户原例：阈值 20 必须在逗号处断开，不能切成「你要 / 不要」', () => {
  const parts = splitAtBoundary(USER_CASE, 20)
  assert.deepEqual(parts, [
    '今天下午的天气真的好好啊，',
    '你要不要和我一起出门去公园散散步',
  ])
  // 关键语义：后半句的第一个字是「你」，不是把「你要不要」拆开
  assert.ok(!parts.some(p => p === '你要' || p === '不要'), '被从词中间劈开了')
})

test('text.length <= limit 不切', () => {
  assert.deepEqual(splitAtBoundary('今天天气不错', 20), ['今天天气不错'])
  assert.deepEqual(splitAtBoundary('今天天气不错', 6), ['今天天气不错'])
})

test('全文没有切点：整条不切（宁长不残）', () => {
  const s = '哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈哈'
  assert.deepEqual(splitAtBoundary(s, 10), [s])
  // 一整段不含空格/标点的英文同理
  const en = 'abcdefghijklmnopqrstuvwxyz'
  assert.deepEqual(splitAtBoundary(en, 10), [en])
})

test('英文按空格切，不把单词劈开', () => {
  const parts = splitAtBoundary('hello world this is a test', 12)
  assert.deepEqual(parts, ['hello world', 'this is a', 'test'])
  for (const p of parts) assert.ok(!/^\s|\s$/.test(p), `有首尾空白：${JSON.stringify(p)}`)
})

test('limit 内无切点 → 找 limit 之后第一个切点（左段可超 limit）', () => {
  // 前 30 个 A 之后才有逗号：limit 20 时不能在 A 中间切
  const text = 'A'.repeat(30) + '，' + 'B'.repeat(30)
  const parts = splitAtBoundary(text, 20)
  assert.equal(parts[0], 'A'.repeat(30) + '，', '左段必须是完整的「一逗号句」')
  assert.equal(parts[1], 'B'.repeat(30), '右段不该被切成两半（B 段无切点）')
})

test('右段仍超阈值会继续递归拆（最多 3 条）', () => {
  const long = 'A'.repeat(50) + '，' + 'B'.repeat(50) + '，' + 'C'.repeat(50)
  const parts = splitAtBoundary(long, 20)
  assert.equal(parts.length, 3)
  assert.ok(parts[0].endsWith('，') && parts[1].endsWith('，'), '前两段应在逗号处结束')
  assert.equal(parts[2], 'C'.repeat(50), '最后一段原样收尾')
})

test('maxParts 生效：超出的部分并进最后一条（不刷屏）', () => {
  const parts = splitAtBoundary('aaaa,bbbb,cccc,dddd,eeee,ffff', 5, { maxParts: 2 })
  assert.equal(parts.length, 2)
  assert.equal(parts[0], 'aaaa,')
  assert.equal(parts[1], 'bbbb,cccc,dddd,eeee,ffff', '剩余全部并进最后一条')
})

test('不产生空段 / 首尾空白', () => {
  // 连续标点、前导空格这类边界都不能产出空段
  const parts = splitAtBoundary('  你好，，世界，今天，天气，不错，', 6)
  assert.ok(parts.length > 1)
  for (const p of parts) {
    assert.ok(p.length > 0, '出现空段')
    assert.ok(!/^\s|\s$/.test(p), `有首尾空白：${JSON.stringify(p)}`)
  }
  assert.ok(!parts.some(p => p === '，'), '不该出现只由标点组成的段')
})

test('句号/顿号/换行也都能当切点', () => {
  assert.equal(splitAtBoundary('第一句。第二句。', 4)[0], '第一句。')
  assert.equal(splitAtBoundary('苹果、香蕉、橘子', 3)[0], '苹果、')
  // 换行本身是空白：切完之后会被 trim 掉（不留尾随换行），但断点生效
  assert.deepEqual(splitAtBoundary('第一行\n第二行', 4), ['第一行', '第二行'])
})

// ══════════════════════════════════════════════════════════════════════════
// ② [SPLIT]：模型标的断点 → 提取 + 剥离
// ══════════════════════════════════════════════════════════════════════════

test('[SPLIT] 能被提取，标记本身不留在正文里', () => {
  const r = splitBySplitMarker('今天好热，[SPLIT]咱们去游泳吧')
  assert.equal(r.marked, true)
  assert.deepEqual(r.parts, ['今天好热，', '咱们去游泳吧'])
  assert.ok(!/\[SPLIT\]/i.test(r.parts.join('')), '[SPLIT] 没剥掉')
})

test('没有 [SPLIT] 时原样返回单段（marked=false）', () => {
  const r = splitBySplitMarker('没有标记的一句话')
  assert.equal(r.marked, false)
  assert.deepEqual(r.parts, ['没有标记的一句话'])
})

test('标记大小写混写也能识别（模型偶尔会写 [split]）', () => {
  const r = splitBySplitMarker('前半句。[split]后半句。')
  assert.equal(r.marked, true)
  assert.deepEqual(r.parts, ['前半句。', '后半句。'])
})

test('SPLIT_RE 是全局正则（能一次拆多段）', () => {
  assert.deepEqual('a[SPLIT]b[SPLIT]c'.split(SPLIT_RE), ['a', 'b', 'c'])
})

test('标记在首尾/连续出现时不产生空段', () => {
  const r = splitBySplitMarker('[SPLIT]你好[SPLIT][SPLIT]世界[SPLIT]')
  assert.equal(r.marked, true)
  assert.deepEqual(r.parts, ['你好', '世界'])
})

test('桥真的在出站前用了 [SPLIT] 拆分（不能只定义了函数）', () => {
  // 源码断言：helper 定义 + deliverReply 真调用 + 提示词里真有使用说明，
  // 三处缺一不可（少一处就是「功能写了但没接上」）。
  assert.match(SRC, /function splitReplyForSend \(text\)/, '缺 splitReplyForSend')
  assert.match(SRC, /splitBySplitMarker\(text\)/, 'splitReplyForSend 没调用 splitBySplitMarker')
  assert.match(SRC, /const parts = splitReplyForSend\(cappedPlain\)/, 'deliverReply 没接上拆句函数')
  assert.match(SRC, /\[SPLIT\] 只能写在逗号\/句号\/空格\/换行旁边/, '提示词里没有 [SPLIT] 的使用约束')
})

// ══════════════════════════════════════════════════════════════════════════
// ③ 低精力硬截断：按切点截、无省略号、宁长不残
// ══════════════════════════════════════════════════════════════════════════

test('cap 内找最后一个切点截断，丢右段、不加省略号', () => {
  assert.equal(truncateAtBoundary(USER_CASE, 20), '今天下午的天气真的好好啊，')
})

test('cap 内无切点 → 找 cap 后第一个切点（保住完整一句）', () => {
  const text = 'A'.repeat(30) + '，' + 'B'.repeat(30)
  assert.equal(truncateAtBoundary(text, 20), 'A'.repeat(30) + '，')
})

test('全文无切点 → 整条发，不截（从词中间砍比超长更糟）', () => {
  const noPunc = 'A'.repeat(50)
  assert.equal(truncateAtBoundary(noPunc, 20), noPunc)
})

test('短于 limit 原样返回；截断结果不带「…」', () => {
  assert.equal(truncateAtBoundary('短句', 20), '短句')
  const out = truncateAtBoundary(USER_CASE, 20)
  assert.ok(!out.includes('…'), '不该再用省略号收尾')
  assert.ok(!out.endsWith('你要'), '不能从词中间截断')
})

// ══════════════════════════════════════════════════════════════════════════
// ④ 精力：全局一份 + 扣减公式 + 150 条见底
// ══════════════════════════════════════════════════════════════════════════

/**
 * 造一个 createState 实例（不带真实 config/persona 依赖）。
 * @param {{energy?:object, peers?:object, people?:object}} [init]
 */
function mkState (init = {}) {
  const config = { energy: init.energy ?? {} }
  const state = { peers: init.peers ?? {}, people: init.people ?? {} }
  const saves = []
  const logger = { log () {}, debug () {} }
  const persona = {
    OCEAN_DEFAULTS: {},
    PERSONA_ARCHETYPES: {},
    readPersonaArchetype: () => '',
    deriveTraits: () => ({
      steady: 1, sensitivity: 1, soothe: 1, showOff: 1, grudge: 1, clingy: 1,
    }),
  }
  const mod = createState({
    config, logger, state, saveState: () => saves.push(1), persona, nowHour: () => 12,
  })
  return { state, saves, ...mod }
}

test('旧 state 迁移：取各 peer 精力的最小值（宁可保守，不凭空回血）', () => {
  const s = mkState({
    peers: {
      'c2c:1': { energy: { value: 0.6, at: 1 } },
      'group:2': { energy: { value: 0.22, at: 1 } },
      'group:3': {},                       // 没有精力字段的 peer 忽略
    },
  })
  assert.ok(Math.abs(s.state.energy.value - 0.22) < 1e-9,
    `迁移结果应是最小值 0.22，实际 ${s.state.energy.value}`)
})

test('旧 state 里一个精力都没有 → 用 start(0.9)', () => {
  const s = mkState()
  assert.equal(s.state.energy.value, 0.9)
})

test('精力是全局一份：两个会话各发一条，掉的是同一个值', () => {
  const s = mkState()
  s.state.peers['c2c:1'] = {}
  s.state.peers['group:2'] = {}
  const start = s.energyState().value
  s.energyDrop('c2c:1', 'x'.repeat(30))
  const afterA = s.energyState().value
  s.energyDrop('group:2', 'x'.repeat(30))
  const afterB = s.energyState().value

  assert.ok(afterA < start, '第一条没掉精力')
  assert.ok(afterB < afterA, '第二条没在同一个全局值上继续掉')
  // 不再有 per-peer 的 energy 字段（迁移后的新代码只认 state.energy）
  assert.equal(s.state.peers['c2c:1'].energy, undefined)
  assert.equal(s.state.peers['group:2'].energy, undefined)
})

test('典型 30 字一条掉约 0.005（长度系数 0.7）', () => {
  const s = mkState()
  const before = s.energyState().value
  // peerKey 不存在 → 情绪系数 = 1，只看长度
  s.energyDrop('nobody', 'x'.repeat(30))
  const drop = before - s.energyState().value
  assert.ok(Math.abs(drop - 0.005) < 0.0005, `30 字应掉约 0.005，实际 ${drop}`)
})

test('长度系数 = 0.5 + 字数/150，上限 3', () => {
  const s = mkState()
  const dropOf = (chars) => {
    const before = s.energyState().value
    s.energyDrop('nobody', 'x'.repeat(chars))
    return before - s.energyState().value
  }
  const d6 = dropOf(6)       // 0.54 × 0.007 ≈ 0.00378
  const d30 = dropOf(30)     // 0.70 × 0.007 ≈ 0.0049
  const d150 = dropOf(150)   // 1.50 × 0.007 = 0.0105
  const d600 = dropOf(600)   // 本应 4.5，被上限 3 压到 0.021
  assert.ok(d6 < d30 && d30 < d150 && d150 < d600, `长度越长应该掉越多：${[d6, d30, d150, d600]}`)
  assert.ok(Math.abs(d150 - 0.0105) < 0.0005, `150 字的扣减不对：${d150}`)
  assert.ok(Math.abs(d600 - 0.021) < 0.0005, `长度系数上限 3 没生效：${d600}`)
})

test('单条扣减上限 0.25（小作文不能一条清空）', () => {
  const s = mkState({ energy: { perMsgDrop: 1 } })
  const before = s.energyState().value
  s.energyDrop('nobody', 'x'.repeat(600))
  assert.ok(Math.abs(before - s.energyState().value - 0.25) < 1e-9)
})

test('连聊约 150 条从 0.9 掉到 0.15（floor），见底不穿', () => {
  const s = mkState()
  for (let i = 0; i < 150; i++) s.energyDrop('nobody', 'x'.repeat(30))
  const v150 = s.energyState().value
  assert.ok(v150 <= 0.2, `150 条后应接近 floor，实际 ${v150}`)
  assert.ok(v150 >= 0.15, `不该穿过 floor，实际 ${v150}`)
  // 继续聊：封在 floor，不会掉成负数
  for (let i = 0; i < 100; i++) s.energyDrop('nobody', 'x'.repeat(30))
  assert.equal(s.energyState().value, 0.15)
})

test('静默恢复：按小时线性回升，封顶 ceil', () => {
  const s = mkState()
  s.state.energy = { value: 0.3, at: Date.now() - 3600000 }
  assert.ok(Math.abs(s.energyState().value - 0.75) < 1e-9,
    `1 小时应恢复 0.45，实际 ${s.energyState().value}`)
  s.state.energy = { value: 0.9, at: Date.now() - 10 * 3600000 }
  assert.equal(s.energyState().value, 1.0, '恢复不能超过 ceil')
})

test('低精力硬截断档位：35% 以上不截 / 40 / 20 / 10 字', () => {
  const s = mkState()
  const capAt = (v) => {
    s.state.energy = { value: v, at: Date.now() }
    return s.energyCharCap()
  }
  assert.equal(capAt(0.5), Infinity)
  assert.equal(capAt(0.35), Infinity)
  assert.equal(capAt(0.34), 40)
  assert.equal(capAt(0.2), 40)
  assert.equal(capAt(0.19), 20)
  assert.equal(capAt(0.1), 20)
  assert.equal(capAt(0.09), 10)
})

test('energyHint 的字数上限和 energyCharCap 一致（同一份 energyCaps）', () => {
  const s = mkState()
  s.state.energy = { value: 0.3, at: Date.now() }
  assert.match(s.energyHint('nobody'), /40 字以内/)
  s.state.energy = { value: 0.15, at: Date.now() }
  assert.match(s.energyHint('nobody'), /20 字以内/)
  s.state.energy = { value: 0.05, at: Date.now() }
  assert.match(s.energyHint('nobody'), /10 字以内/)
  s.state.energy = { value: 0.5, at: Date.now() }
  assert.ok(!/字以内/.test(s.energyHint('nobody')), '35% 以上不该再给字数上限')
})
