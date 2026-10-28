// 好感度系统测试（task-14）。
// 运行：node test/affection.test.mjs
//
// 为什么用「抠源码求值」而不是 import 整个 bridge/index.js：
// 那个模块顶层就会起服务（网关/HTTP/定时器），直接 import 会污染环境。
// 抠出来求值测的仍是**线上同一份代码**，不会出现「测试和实现漂移」
// （跟 recall.test.mjs / memory-cross-channel.test.mjs / chat-follow.test.mjs 同一手法）。
//
// 覆盖用户/任务要求的全部要点：
//   · 打卡 streak（连续、跨天、断签归零、群里必须有来有回）
//   · 被夸 4 小时冷却 + 心情联动
//   · 被骂三重阈值（2h 限 2 次 / 日上限 -3 / 周过 5 次才启算）
//   · 档位边界（hate/l0/l1/l2/l3/l4 每条分界线）
//   · 按人隔离（同一人在 c2c 和 group 共享同一份分数）
//   · L0 不注入 / L4 群聊不注入（代码强制，不是提示词自觉）
//   · 注入位置在【硬约束】之前（源码级断言）
//   · 拆句不机械
//   · 防刷（日上限 / 单信号 ≤3 / flurry 不计分）
//   · 安全隔离（分数只由确定性代码改；prompt 里的分数改不了它）
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'affection-'))
const src = fs.readFileSync(path.join(ROOT, 'bridge/index.js'), 'utf8')

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

// ── 抠出好感度相关的源码段 ────────────────────────────────────────────────────
// 从 AFFECTION_DEFAULTS 到 detectMoodTriggers 之前 = 整个好感度实现
const SEC_START = src.indexOf('// ── 好感度系统（affection，2026-10-28）')
const SEC_END = src.indexOf('/**\n * 从一条消息里识别情绪触发')
if (SEC_START < 0 || SEC_END < 0) throw new Error('抠不出好感度段落：注释锚点变了')
const SECTION = src.slice(SEC_START, SEC_END)

/**
 * 造一个可调用的好感度环境（假 state / 假 config / 假 logger / 可控时钟）。
 *
 * deriveTraits / moodCfg / moodState 是现有模块的函数，这里给可控替身：
 *   · deriveTraits 用**真实实现**（从源码抠，保证 OCEAN 乘数测得准）
 *   · moodCfg 给固定 ocean（排除 persona 读取的 IO）
 *   · moodState 给可控 valence（测试心情联动）
 */
function makeEnv (opts = {}) {
  const logs = []
  const logger = { log: m => logs.push(String(m)), debug: m => logs.push('debug ' + m) }
  const state = { peers: {}, people: {} }
  let saves = 0
  const saveState = () => { saves++ }
  let nowMs = opts.now ?? 1_700_000_000_000
  const DateRef = { now: () => nowMs }
  const config = {
    policy: { timezone: opts.tz ?? 'Asia/Shanghai' },
    affection: { ...(opts.affection ?? {}) },
  }
  const moodValence = { v: opts.valence ?? 0 }
  const OCEAN = { O: 0.6, C: 0.4, E: 0.55, A: 0.65, N: 0.45 }

  // 真实 deriveTraits（从源码抠，避免测试自己实现一份）
  const dtStart = src.indexOf('function deriveTraits (ocean)')
  const dtEnd = src.indexOf('// ── 性格原型库')
  const DERIVE_SRC = src.slice(dtStart, dtEnd)
  const OCEAN_DEFAULTS = { O: 0.6, C: 0.4, E: 0.55, A: 0.65, N: 0.45 }

  // eslint-disable-next-line no-new-func
  // 用假 Date 替换全局 Date（SECTION 里大量 Date.now() 调用必须走假时钟）
  const FakeDate = class extends Date {
    constructor (...args) { if (args.length === 0) super(nowMs); else super(...args) }
    static now () { return nowMs }
  }
  const fn = new Function('state', 'config', 'logger', 'saveState', 'Date', 'OCEAN_JSON',
    `const OCEAN_DEFAULTS = JSON.parse(OCEAN_JSON);
     ${DERIVE_SRC}
     function moodCfg (peerKey) { return { ocean: ${JSON.stringify(OCEAN)} } }
     function moodState (peerKey) { return { valence: __valence.v } }
     const __valence = globalThis.__affTestValence;
     ${SECTION}
     ; return { AFFECTION_DEFAULTS, affectionCfg, dayIndex, peopleState, affectionTier,
                affectionEvent, affectionCheckin, affectionDailyTick, affectionHint,
                splitLongSentence, deriveTraits };`)
  globalThis.__affTestValence = moodValence
  const api = fn(state, config, logger, saveState, FakeDate, JSON.stringify(OCEAN_DEFAULTS))
  api.state = state
  api.logs = logs
  api.saves = () => saves
  api.setNow = t => { nowMs = t }
  api.getNow = () => nowMs
  api.valence = moodValence
  return api
}

const DAY = 86400000
const MIN = 60000
const HOUR = 3600000

console.log('\n=== 0. 抠段完整性（防锚点漂移）===')
{
  ok('好感度段落包含全部核心函数', [
    'function peopleState', 'function affectionTier', 'function affectionEvent',
    'function affectionCheckin', 'function affectionDailyTick', 'function affectionHint',
    'function splitLongSentence', 'const AFFECTION_DEFAULTS',
  ].every(n => SECTION.includes(n)), '缺函数')
  ok('段落里不含 inject 语句以外的副作用（无 setInterval/网络）',
    !/setInterval|new WebSocket|fetch\(/.test(SECTION))
}

console.log('\n=== 1. 初始化与按人隔离 ===')
{
  const env = makeEnv()
  const p = env.peopleState('3022464706')
  ok('初始分 = 30', p.aff === 30, String(p.aff))
  ok('初始档位 = L1（30 ≥ 25）', env.affectionTier('3022464706') === 'l1', env.affectionTier('3022464706'))
  ok('同一 QQ 拿到同一份状态（按人）', env.peopleState('3022464706') === p)
  ok('不同 QQ 各自独立', env.peopleState('999') !== p)
  ok('空 qq → null（不崩）', env.peopleState('') === null)
  ok('state.people 是顶层键', env.state.people && typeof env.state.people === 'object')
  // 「同一人在 c2c 和 group 共享」= 按人存，与 peerKey 无关
  const p2 = env.peopleState('3022464706')
  p2.metIn.push('c2c:3022464706')
  p2.metIn.push('group:1017567471')
  ok('**同一人跨通道共享同一份分数**（metIn 记录两个渠道，aff 是同一个）',
    p2.aff === 30 && p2.metIn.length === 2, JSON.stringify(p2.metIn))
}

console.log('\n=== 2. 档位边界（每条分界线）===')
{
  const env = makeEnv()
  const t = env.AFFECTION_DEFAULTS.tiers   // l1:25 l2:50 l3:70 l4:85 hate:10
  const cases = [
    [0, 'hate'], [9.9, 'hate'], [10, 'l0'], [24.9, 'l0'],
    [25, 'l1'], [49.9, 'l1'], [50, 'l2'], [69.9, 'l2'],
    [70, 'l3'], [84.9, 'l3'], [85, 'l4'], [100, 'l4'],
  ]
  for (const [score, want] of cases) {
    const qq = `t${score}`
    env.peopleState(qq).aff = score
    ok(`${score} → ${want}`, env.affectionTier(qq) === want, env.affectionTier(qq))
  }
  ok('讨厌档阈值是 <10', t.hate === 10)
  ok('L4 阈值是 85', t.l4 === 85)
}

console.log('\n=== 3. 打卡 streak（唯一连续增长途径）===')
{
  const env = makeEnv()
  const qq = '3022464706'
  // 第 1 天打卡
  env.setNow(1_700_000_000_000)
  const r1 = env.affectionCheckin(qq, {})
  ok('第 1 次打卡成功', r1 !== null, JSON.stringify(r1))
  ok('streak = 1', env.peopleState(qq).streak === 1, String(env.peopleState(qq).streak))
  ok('加分 = 0.5 × 1.0 × soothe', Math.abs(r1.delta - 0.5 * 1.0 * 0.65 * 0.8) < 0.5 && r1.delta > 0,
    `delta=${r1.delta}`)

  // 同一天再打卡 → 不再加
  const r2 = env.affectionCheckin(qq, {})
  ok('**同一天第二次打卡不加分**（一天只算一次）', r2 === null)

  // 第 2 天
  env.setNow(1_700_000_000_000 + DAY)
  const r3 = env.affectionCheckin(qq, {})
  ok('第 2 天打卡 → streak = 2', env.peopleState(qq).streak === 2, String(env.peopleState(qq).streak))
  ok('第 2 天加分 > 第 1 天（streak 系数高）', r3.delta > r1.delta, `${r3.delta} vs ${r1.delta}`)

  // 连续到第 30 天 → 系数封顶
  env.setNow(1_700_000_000_000 + 30 * DAY)
  env.peopleState(qq).lastCheckinDay = env.dayIndex(1_700_000_000_000 + 29 * DAY)
  env.peopleState(qq).streak = 29
  const r30 = env.affectionCheckin(qq, {})
  ok('第 30 天 streak = 30', env.peopleState(qq).streak === 30, String(env.peopleState(qq).streak))
  ok('第 30 天系数封顶 ×2（加分是第 1 天的两倍）', Math.abs(r30.delta / r1.delta - 2) < 0.05,
    `${r30.delta} vs ${r1.delta}（比值 ${(r30.delta / r1.delta).toFixed(3)}）`)
}

console.log('\n=== 4. 断签归零 ===')
{
  const env = makeEnv()
  const qq = '3022464706'
  const t0 = 1_700_000_000_000
  env.setNow(t0)
  env.affectionCheckin(qq, {})
  env.setNow(t0 + DAY)
  env.affectionCheckin(qq, {})
  ok('连续 2 天 → streak=2', env.peopleState(qq).streak === 2, String(env.peopleState(qq).streak))
  // 跳过第 3 天，第 4 天才来 → 断签
  env.setNow(t0 + 3 * DAY)
  env.affectionDailyTick()
  ok('**断签 → streak 归零**', env.peopleState(qq).streak === 0, String(env.peopleState(qq).streak))
  const r = env.affectionCheckin(qq, {})
  ok('断签后重新打卡 → streak 从 1 开始', env.peopleState(qq).streak === 1, String(env.peopleState(qq).streak))
}

console.log('\n=== 5. 被夸：4 小时冷却 + 心情联动 ===')
{
  const env = makeEnv()
  const qq = '3022464706'
  const t0 = 1_700_000_000_000
  env.setNow(t0)
  const r1 = env.affectionEvent(qq, 'praise', {})
  ok('第 1 次被夸加分', r1 !== null && r1.delta > 0, JSON.stringify(r1))
  // 1 小时后（冷却中）
  env.setNow(t0 + HOUR)
  const r2 = env.affectionEvent(qq, 'praise', {})
  ok('**4 小时内第二次被夸不加分（冷却）**', r2 === null, JSON.stringify(r2))
  // 4 小时后
  env.setNow(t0 + 4 * HOUR + 1000)
  const r3 = env.affectionEvent(qq, 'praise', {})
  ok('冷却过后再加分', r3 !== null, JSON.stringify(r3))

  // 心情联动：高兴时涨得多
  const envGood = makeEnv({ valence: 0.6 })
  const rGood = envGood.affectionEvent(qq, 'praise', { peerKey: 'c2c:3022464706' })
  const envBad = makeEnv({ valence: -0.4 })
  const rBad = envBad.affectionEvent(qq, 'praise', { peerKey: 'c2c:3022464706' })
  ok('心情高（valence 0.6）涨 1.15 倍', rGood.delta > rBad.delta * 1.5,
    `好心情=${rGood.delta.toFixed(3)} 坏心情=${rBad.delta.toFixed(3)}`)
  ok('心情差（valence -0.4）涨 0.5 倍', rBad.delta < 0.5 * rGood.delta, `bad=${rBad.delta}`)
}

console.log('\n=== 6. 被骂：三重阈值 ===')
{
  const env = makeEnv()
  const qq = '3022464706'
  const t0 = 1_700_000_000_000
  env.setNow(t0)
  // 门槛：一周内超过 5 次才开始计分。前 5 次都不扣。
  const results = []
  for (let i = 0; i < 5; i++) {
    env.setNow(t0 + i * 3 * HOUR)          // 每次隔 3h（避开 2h 窗限流）
    results.push(env.affectionEvent(qq, 'insult', {}))
  }
  ok('前 5 次小批评**不计分**（未过周门槛 5）', results.every(r => r === null),
    JSON.stringify(results.map(r => r && r.delta)))
  ok('但都记进了 insultLog（用于周门槛判断）',
    env.peopleState(qq).insultLog.length === 5, String(env.peopleState(qq).insultLog.length))

  // 第 6 次 → 开始计分
  env.setNow(t0 + 18 * HOUR)
  const r6 = env.affectionEvent(qq, 'insult', {})
  ok('**第 6 次（超过门槛 5）开始扣分**', r6 !== null && r6.delta < 0, JSON.stringify(r6))
  ok('单次扣分 ≤ 0.5 × grudge', Math.abs(r6.delta) <= 0.5 * 1.6, `delta=${r6.delta}`)

  // 2 小时窗口限流：同窗口第 3 次不计
  const env2 = makeEnv()
  env2.setNow(t0)
  // 先造过门槛
  env2.peopleState(qq).insultLog = [t0 - 6 * HOUR, t0 - 5 * HOUR, t0 - 4 * HOUR, t0 - 3 * HOUR, t0 - 2 * HOUR]
  const a = env2.affectionEvent(qq, 'insult', {})
  const b = env2.affectionEvent(qq, 'insult', {})
  const c = env2.affectionEvent(qq, 'insult', {})
  ok('同一 2h 窗口内第 1、2 次计分', a !== null && b !== null, JSON.stringify([a?.delta, b?.delta]))
  ok('**同一 2h 窗口内第 3 次不计分（单次限流）**', c === null, JSON.stringify(c))

  // 日上限 -3
  const env3 = makeEnv()
  env3.setNow(t0)
  const p = env3.peopleState(qq)
  p.insultLog = Array.from({ length: 6 }, (_, i) => t0 - (i + 1) * 3 * HOUR)
  // 连续多天、每窗口 2 次，累计到日上限
  // 同一个自然日内多轮（每轮隔 2h 避开窗口限流），累计应被日上限 -3 截断。
  // ⚠️ 只在**同一天**内累计：跨天之后那次属于新的一天、额度已重置，不能算进"当日"。
  const baseDay = env3.dayIndex(t0)
  let total = 0
  for (let h = 0; h < 12; h++) {
    const t = t0 + h * 2 * HOUR + 1
    if (env3.dayIndex(t) !== baseDay) break        // 先判断跨天，再调（避免把新一天的量算进来）
    env3.setNow(t)
    const r = env3.affectionEvent(qq, 'insult', {})
    if (r && r.delta < 0) total += -r.delta
  }
  ok('**当日扣分到上限 -3 就停**', total <= 3 + 1e-6, `实际扣了 ${total.toFixed(2)}`)
  ok('到上限后确实停止计分（扣分恰好用满 3）', total > 2.5, `只扣了 ${total.toFixed(2)}，闸可能没生效`)
  ok('日上限常量是 3', env3.AFFECTION_DEFAULTS.insultDailyMax === 3)
}

console.log('\n=== 7. 久不联系缓降 + floor 20 不归零 ===')
{
  const env = makeEnv()
  const qq = '3022464706'
  const t0 = 1_700_000_000_000
  env.peopleState(qq).aff = 60
  env.peopleState(qq).at = t0
  env.setNow(t0 + 2 * DAY)          // 2 天没联系
  env.affectionDailyTick()
  const p = env.peopleState(qq)
  ok('2 天没联系 → 掉了一点分', p.aff < 60, String(p.aff))
  ok('但没掉光（缓降）', p.aff > 55, String(p.aff))

  // 长期不联系 → 停在 floor 20
  env.peopleState(qq).aff = 25
  env.peopleState(qq).at = t0
  env.setNow(t0 + 100 * DAY)
  env.affectionDailyTick()
  ok('**长期不联系停在 floor 20，不归零**', env.peopleState(qq).aff === 20,
    String(env.peopleState(qq).aff))
  ok('floor 常量是 20', env.AFFECTION_DEFAULTS.decayFloor === 20)
}

console.log('\n=== 8. 防刷 ===')
{
  const env = makeEnv()
  const qq = '3022464706'
  const t0 = 1_700_000_000_000
  env.setNow(t0)
  // 单信号 ≤3 分
  const r = env.affectionEvent(qq, 'info', {})
  ok('单信号不超过 3 分', r.delta <= 3, String(r.delta))
  // 日总量闸 +10：狂刷被夸也不超
  // 同一天内狂刷：每次绕开 4h 冷却（手动清 praiseAt），但都在同一天内
  let gained = 0
  for (let i = 0; i < 12; i++) {
    env.setNow(t0 + i * 20 * MIN)   // 20 分钟一次：12 次共 4h，全在同一天内
    env.peopleState(qq).praiseAt = 0    // 绕开冷却，专测日总量闸
    const x = env.affectionEvent(qq, 'praise', {})
    if (x && x.delta > 0) gained += x.delta
  }
  ok('**同一天内涨分总量 ≤ 10（防刷）**', gained <= 10 + 1e-6, `实际涨了 ${gained.toFixed(2)}`)
  // 12 次 × 单信号 1.12 分 ≈ 13.4；被日闸 10 截断后实际应是 8.88（第 9 次被 room 截到 1.04，
  // 之后 room<=0 全部拒绝）。所以断言「明显少于 12 次的无闸值」而不是「约等于 10」。
  ok('日闸确实拦住了（< 无闸时的 13.4）', gained < 12, `涨了 ${gained.toFixed(2)}，接近无闸值说明闸没生效`)
  ok('日上限常量是 10', env.AFFECTION_DEFAULTS.dailyGainCap === 10)
}

console.log('\n=== 9. 「一天」= 自然日 0 点（不是 24h 滚动）===')
{
  const env = makeEnv()
  // 用真实时区解析验证
  const tz = 'Asia/Shanghai'
  // 2026-10-28 23:59 和 2026-10-29 00:01（本地时间）应该是不同的天
  const d1 = env.dayIndex(new Date('2026-10-28T23:59:00+08:00').getTime(), tz)
  const d2 = env.dayIndex(new Date('2026-10-29T00:01:00+08:00').getTime(), tz)
  ok('跨 0 点 → 天编号 +1', d2 - d1 === 1, `${d1} → ${d2}`)
  // 同一天内不同时刻 → 同一天
  const dA = env.dayIndex(new Date('2026-10-28T00:01:00+08:00').getTime(), tz)
  const dB = env.dayIndex(new Date('2026-10-28T23:59:00+08:00').getTime(), tz)
  ok('同一天内不同时刻 → 同一天编号（不是 24h 滚动）', dA === dB, `${dA} vs ${dB}`)
}

console.log('\n=== 10. 注入：L0 不注入 / L4 群聊不注入（代码强制）===')
{
  const env = makeEnv()
  const qq = '3022464706'
  // L0
  env.peopleState(qq).aff = 20
  ok('**L0 → 注入空字符串**（生人就是 persona 默认分寸）',
    env.affectionHint(qq, { inGroup: false }) === '', env.affectionHint(qq, { inGroup: false }).slice(0, 40))
  // L1-L3 私聊都注入
  for (const [score, tier] of [[30, 'l1'], [55, 'l2'], [75, 'l3']]) {
    env.peopleState(qq).aff = score
    const h = env.affectionHint(qq, { inGroup: false })
    ok(`${tier} 私聊注入非空`, h.length > 0 && h.includes('你对他现在的态度'), `${score} 分`)
  }
  // L4 私聊注入 / 群聊不注入
  env.peopleState(qq).aff = 90
  ok('L4 私聊注入', env.affectionHint(qq, { inGroup: false }).length > 0)
  ok('**L4 群聊不注入**（损友分寸只在私聊）', env.affectionHint(qq, { inGroup: true }) === '',
    env.affectionHint(qq, { inGroup: true }).slice(0, 50))
  // 讨厌档私聊/群聊都注入（冷淡是普适的）
  env.peopleState(qq).aff = 5
  ok('讨厌档私聊注入', env.affectionHint(qq, { inGroup: false }).includes('没什么好感'))
  ok('讨厌档群聊也注入（冷淡不需要分场合）', env.affectionHint(qq, { inGroup: true }).includes('没什么好感'))
}

console.log('\n=== 11. 注入内容是「对话片段」不是「动作清单」 ===')
{
  const env = makeEnv()
  const qq = '3022464706'
  for (const [score, tier] of [[30, 'l1'], [55, 'l2'], [75, 'l3'], [90, 'l4'], [5, 'hate']]) {
    env.peopleState(qq).aff = score
    const h = env.affectionHint(qq, { inGroup: false })
    // 必须有「他：/我：」形式的完整对话片段（用户明确要求「写样例给 llm」）
    const hasDialogue = /他[：:].+\n[\s]*我[：:]/m.test(h)
    ok(`${tier} 含完整对话片段（他：…/我：…）`, hasDialogue, h.split('\n').slice(0, 6).join(' | '))
    // 不能写成编号动作清单（约束 1：动作清单会让模型刻意）
    const hasNumberedActions = /^\s*[①②③④⑤]/m.test(h)
    ok(`${tier} 不是编号动作清单`, !hasNumberedActions, '出现了 ①②③ 编号')
  }
  // 提示词里要有短句引导（约束 2 的提示词部分）
  env.peopleState(qq).aff = 55
  ok('L2+ 提示词含「短」相关引导', /短/.test(env.affectionHint(qq, { inGroup: false })))
}

console.log('\n=== 12. 短句拆分兜底（拆得不机械）===')
{
  const env = makeEnv()
  // 短句不拆
  const short = '行吧'
  ok('短句不拆', env.splitLongSentence(short).length === 1, JSON.stringify(env.splitLongSentence(short)))
  // 刚好 30 字不拆
  const just30 = '一'.repeat(30)
  ok('30 字以内不拆', env.splitLongSentence(just30).length === 1, `${just30.length}`)
  // 长句但有多句 → 拆
  const long = '这个报错我知道是什么原因了。是你配置里少写了一个字段，补上就行。'
  const parts = env.splitLongSentence(long)
  ok('**长句（多句）→ 拆成 2 条**', parts.length === 2, JSON.stringify(parts))
  ok('每段能独立成句（不少于 6 字）', parts.every(p => p.length >= 6), JSON.stringify(parts))
  ok('不丢内容（拼起来等于原文）', parts.join('').replace(/\s/g, '') === long.replace(/\s/g, ''),
    JSON.stringify(parts))
  // 带句末标点的一整句长文（无逗号断点）→ 不硬拆
  const oneLong = '我觉得这个方案根本不行因为成本太高而且时间也来不及再评估一遍风险也没有意义'
  ok('**单个长句（无句末标点）不硬拆** —— 硬拆必然机械',
    env.splitLongSentence(oneLong).length === 1, JSON.stringify(env.splitLongSentence(oneLong)))
  // 已有换行 → 按换行分成多条，不再二次拆
  // 超过阈值的长文本 + 已含换行 → 按换行分，不再二次拆
  const multi = '第一句在这里写得比较长一些让它超过阈值\n第二句在那里也写得比较长一些超过阈值'
  ok('已有换行 → 按换行分（不二次拆）', env.splitLongSentence(multi).length === 2,
    JSON.stringify(env.splitLongSentence(multi)))
  // 超条数上限：不会拆成一堆
  const many = '一。二。三。四。五。六。七。八。九。十。'
  const mp = env.splitLongSentence(many)
  ok('**最多拆 2 条（防一句话变多条刷屏）**', mp.length <= 2, `${mp.length} 条`)
}

console.log('\n=== 13. 源码级：安全隔离与注入位置 ===')
{
  // 注入位置：必须在【硬约束】之前
  const affIdx = src.indexOf("const aff = affectionHint(senderQq")
  const hardIdx = src.indexOf('【硬约束】QQ 通道不认 [表情: 描述] 文字标记')
  ok('affectionHint 调用点存在', affIdx > 0, String(affIdx))
  ok('**注入位置在【硬约束】之前**（安全隔离的结构保证）', affIdx < hardIdx,
    `affection@${affIdx} vs 硬约束@${hardIdx}`)
  // 紧跟 moodHint（跟它同层）
  const moodIdx = src.indexOf('if (mh) contextLines.push(mh)')
  ok('紧跟 moodHint 之后（同层注入）', affIdx > moodIdx && affIdx - moodIdx < 400,
    `mood@${moodIdx} affection@${affIdx}`)

  // 分数只由确定性代码改：模型输出变量（text）绝不能出现在 affectionEvent 调用里
  const eventCalls = src.match(/affectionEvent\([^)]*\)/g) ?? []
  ok('affectionEvent 调用参数里没有模型输出（text/body/reply）',
    eventCalls.every(c => !/\btext\b|\bbody\b|\breply\b/.test(c)),
    eventCalls.join(' | '))

  // proactive 完全不碰
  ok('**proactive 相关函数里不出现 affection**（v1 好感度不碰主动搭话）', (() => {
    const start = src.indexOf('async function proactiveSpeak')
    const end = src.indexOf('// ── 接话窗口（chatFollow）', start)
    const seg = src.slice(start, end > start ? end : start + 3000)
    return !/affection/i.test(seg)
  })(), 'proactiveSpeak 里出现了 affection')

  // 打卡在真正发送之后（不在 touchLastSpoke 旁边）
  const checkinIdx = src.indexOf('affectionCheckin(senderQq')
  const sendIdx = src.indexOf('if (cappedPlain) {', checkinIdx - 3000)
  ok('**打卡在正文真正发出之后**（不是模型回完就算）', checkinIdx > sendIdx && sendIdx > 0,
    `send@${sendIdx} checkin@${checkinIdx}`)

  // flurry 期间不计分
  ok('flurry 期间不计好感度（连发十条不算陪我聊）',
    /if \(senderQq && !flurryMode\)/.test(src))

  // 带图不作为涨分依据
  ok('带图不作为「新信息」涨分依据（除非图里对 LLM 有评价）',
    /!flat\.images\?\.length/.test(src))
}

console.log('\n=== 14. 全局开关（enabled=false 行为与今天一致）===')
{
  const envOff = makeEnv({ affection: { enabled: false } })
  ok('enabled=false → affectionEvent 返回 null',
    envOff.affectionEvent('3022464706', 'praise', {}) === null)
  ok('enabled=false → affectionCheckin 返回 null',
    envOff.affectionCheckin('3022464706', {}) === null)
  ok('enabled=false → affectionHint 返回空（不注入）',
    envOff.affectionHint('3022464706', {}) === '')
  ok('enabled=false → 不改分数', envOff.peopleState('3022464706').aff === 30)
}

console.log('\n=== 15. 配置与勘误 ===')
{
  ok('config.json 有 affection 段', (() => {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'bridge/config.json'), 'utf8'))
    return cfg.affection && cfg.affection.enabled !== false
  })())
  ok('**config.json 的 mood.traits 死配置已清掉**', (() => {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'bridge/config.json'), 'utf8'))
    return !('traits' in (cfg.mood ?? {}))
  })(), JSON.stringify(JSON.parse(fs.readFileSync(path.join(ROOT, 'bridge/config.json'), 'utf8')).mood))
  ok('energy 注释已说明生效值以 config 为准', /perMsgDrop 0\.025|生效值.*config/.test(src))
  const env = makeEnv()
  ok('affectionCfg 能合并 config 覆盖', env.affectionCfg().start === 30)
  const env2 = makeEnv({ affection: { start: 50 } })
  ok('config 覆盖生效', env2.affectionCfg().start === 50, String(env2.affectionCfg().start))
}

console.log('\n=== 16. 各档注入块实拍（供回报用）===')
{
  const env = makeEnv()
  const qq = '3022464706'
  for (const [label, score] of [['L1 点头之交', 30], ['L2 熟人', 55], ['L3 老熟人', 75], ['L4 损友', 90], ['讨厌档', 5]]) {
    env.peopleState(qq).aff = score
    const h = env.affectionHint(qq, { inGroup: false })
    console.log(`\n  ── ${label}（${score} 分）──`)
    console.log(h.split('\n').map(l => '     ' + l).join('\n'))
  }
  console.log('\n  ── L0 生人（20 分）──')
  console.log('     （空：不注入任何提示）')
  console.log('\n  ── L4 群聊（90 分，inGroup=true）──')
  console.log('     （空：L4 只在私聊注入）')
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
