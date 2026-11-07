// 状态系统：精力（energy）+ 情绪（mood）+ 好感度（affection）。
//
// 从 index.js 拆出来（2026-10-29）。拆分原则：纯搬运，函数体一字不改。
//
// 为什么这三块放一起：
//   · 都是「读 state.peers / state.people，随时间衰减，注入上下文」的同质逻辑
//   · 互相有联动：moodEnergyFactor（心情→精力）、affectionEvent 依赖 moodCfg.ocean
//
// 依赖注入（不用共享 ctx）：config/state/logger 是运行时可变对象，
//   共享引用容易出错；实测做成 ctx 要改 353 处引用，风险太高。
//   state 必须传同一个对象引用（本模块只改字段，不重新赋值）。

// 2026-11-05（审计 P2-6）：splitLongSentence 是 v2-3 之前按 。！？ 拆句的死代码，
// 出站拆条已经统一到 common.js 的 splitOutboundParts（换行/[SPLIT] 强制拆 + 标点兜底），
// 这里只保留 stripPeriod 的导出（index.js 还从这里解构，避免改它的 import 面）。
// stripPeriod 的实现搬到了 common.js（纯函数层），原因见那边的注释。
import { stripPeriod } from './common.js'

export function createState ({ config, logger, state, saveState, persona, nowHour }) {
  const { deriveTraits, OCEAN_DEFAULTS, PERSONA_ARCHETYPES, readPersonaArchetype } = persona

  // ↓↓↓ 原 index.js 1127-1885 行原样搬运 ↓↓↓

// ── 精力值（v2-1 → v2-3：全局共享 + 长度/情绪双系数）────────────────────────
// 需求：「状态有起伏」——连续发言递减、长时间静默回升，写进上下文供模型参考。
// 只做**倾向**，不做硬规则（避免机械）。
//
// 🔴 2026-11-02 用户要求改成**全局一份**（state.energy），不再按会话各存一份：
//    同一个号在群里说一句、私聊说一句，耗的是同一个「人」的力气。
//    按会话存会出现「私聊满血、群里累瘫」的割裂感。
//
// ⚠️ 注意：下面是**代码默认值**，生产生效值由 bridge/config.json 的 energy 段覆盖。
const ENERGY_DEFAULTS = {
  enabled: true,
  start: 0.9,        // 初始精力（旧 state 迁移时没有 peer 精力可参考也用它）
  perMsgDrop: 0.007, // 每发一条的基础消耗（再乘长度系数与情绪系数）
  // 每静默一小时回升多少：0.15（floor）→ 1.0 约 1.9 小时，即约 2 小时回满
  perHourRestore: 0.45,
  floor: 0.15,
  ceil: 1.0,
  // 长度系数 = 0.5 + 字数/150，上限 3 —— 短句省力，长段落特别费劲。
  // 校准：30 字回复 → 0.5+0.2 = 0.7 → 0.007×0.7 ≈ 0.005/条；
  //       连聊约 150 条：0.9 － 150×0.005 = 0.15（正好见底）。
  lenBase: 0.5,
  lenPerChar: 1 / 150,
  lenMax: 3,
  maxDropPerMsg: 0.25,  // 单条扣减上限：一段小作文不能一条清空
  // 情绪联动：心情高涨时精力掉得少，低落时掉得多（见 moodEnergyFactor）
  moodLinked: true,
  moodLinkRange: 0.6,   // ±60%：最好心情 = 0.4x 消耗，最差 = 1.6x
  // 低精力硬截断档位：从高到低匹配，命中的第一档生效。
  // energyHint 的「字数上限」也从这一份推导 —— 两处各写一套迟早会漂移。
  energyCaps: [
    { min: 0.35, chars: Infinity },  // >= 35%：不截
    { min: 0.20, chars: 40 },        // 20%~35%：40 字
    { min: 0.10, chars: 20 },        // 10%~20%：20 字
    { min: 0, chars: 10 },           // < 10%：10 字
  ],
}

function energyCfg () { return { ...ENERGY_DEFAULTS, ...(config.energy ?? {}) } }

// 启动时先做一次精力迁移（per-peer → 全局）。
// 位置必须在 ENERGY_DEFAULTS 初始化**之后**（上面的 const 有 TDZ，提前调用会炸），
// 又要在任何 energyState() 之前 —— 否则会先落一个 start，把旧值覆盖掉。
migrateEnergy()

/**
 * 老 state 迁移：精力从 per-peer（state.peers[key].energy）改成全局 state.energy。
 *
 * 取「各会话当前精力的最小值」：宁可保守（按最累的那个算），也不要凭空回血；
 * 一个 peer 都没有就用 start。旧字段不删（万一要回滚），但代码只认 state.energy。
 */
function migrateEnergy () {
  if (state.energy && typeof state.energy.value === 'number') return
  const c = energyCfg()
  const olds = Object.values(state.peers ?? {})
    .map(ps => ps?.energy?.value)
    .filter(v => typeof v === 'number' && Number.isFinite(v))
  const val = olds.length ? Math.min(...olds) : c.start
  state.energy = { value: Math.max(c.floor, Math.min(c.ceil, val)), at: Date.now() }
  saveState()
}

/**
 * 全局精力状态（所有会话共享一份）。
 *
 * ⚠️ 必须是**同步**函数：读 → 算恢复 → 写回之间不能有 await。
 *    群聊和私聊几乎同时来消息时，异步会让两个调用读到同一个旧值、各写回一次
 *    → 丢更新（少扣一次或恢复算重）。
 */
function energyState () {
  const c = energyCfg()
  const now = Date.now()
  if (!state.energy || typeof state.energy.value !== 'number') {
    state.energy = { value: c.start, at: now }
  }
  // 静默恢复：按距今小时数线性回升
  const hours = (now - (state.energy.at ?? now)) / 3600000
  if (hours > 0.05) {
    state.energy.value = Math.min(c.ceil, state.energy.value + hours * c.perHourRestore)
    state.energy.at = now
  }
  return state.energy
}

/** 情绪 → 精力的联动系数。
 *
 * 设计：**心情高涨时说话不费劲，心情低落时说话特别累**。
 * 有生活依据：开心的时候聊天是回血，闷的时候回一句话都觉得耗。
 *
 * 把心情（valence + arousal）映射到约 0.4x ~ 1.6x 的消耗倍率：
 *   心情好 → 倍率低（掉得少）；心情差 → 倍率高（掉得多）
 *   中性心情 ≈ 1.0x（不改变原有手感）
 *
 * @returns {number} 消耗倍率（1 = 中性）
 */
function moodEnergyFactor (peerKey) {
  const c = energyCfg()
  if (c.moodLinked === false) return 1
  const m = moodState(peerKey)
  if (!m) return 1
  const cr = c.moodLinkRange ?? 0.6
  // 合成 -1..1 的「情绪好坏」：valence 占 70%，arousal 占 30%
  // （arousal 高本身不代表好——焦虑也高，但 valence 正时它就是「来劲」）
  const moodScore = Math.max(-1, Math.min(1, m.valence * 0.7 + (m.arousal - 0.5) * 2 * 0.3))
  const factor = 1 - moodScore * cr
  return Math.max(0.2, Math.min(2.0, factor))
}

/**
 * 发了一条 → 精力下降。
 *
 * 扣减 = perMsgDrop × 长度系数 × 情绪系数，单条上限 maxDropPerMsg。
 * 精力是全局的，但情绪是**按会话**的：这一条是在哪个会话里回的，
 * 就用那个会话此刻的心情算「说话费不费劲」。
 *
 * ⚠️ 同步函数（理由同 energyState）：读改写中间不能有 await。
 *
 * @param {string} peerKey 用它的情绪算情绪系数
 * @param {string} [text] 实际发出去的内容（被精力截短了就该少掉）
 */
function energyDrop (peerKey, text) {
  const c = energyCfg()
  if (!c.enabled) return
  const e = energyState()
  const len = Array.from(String(text ?? '')).length
  const lenFactor = Math.min(c.lenMax ?? 3, (c.lenBase ?? 0.5) + len * (c.lenPerChar ?? 1 / 150))
  // 情绪联动：心情好掉得少、心情差掉得多
  const factor = moodEnergyFactor(peerKey)
  const drop = Math.min(c.maxDropPerMsg ?? 0.25, c.perMsgDrop * lenFactor * factor)
  e.value = Math.max(c.floor, e.value - drop)
  e.at = Date.now()
  logger.debug?.(`energyDrop ${peerKey}: ${c.perMsgDrop.toFixed(4)} × 长度${lenFactor.toFixed(2)}(${len}字) × 情绪${factor.toFixed(2)} = 掉 ${drop.toFixed(4)}（剩 ${e.value.toFixed(3)}）`)
  saveState()
}

let energyTimer = null
function startEnergyLoop () {
  const c = energyCfg()
  if (!c.enabled) return
  // 每 10 分钟落一次盘（静默回升要能持久化，不能只在内存里涨）。
  // 精力是全局一份，所以这里只刷一次，不用再遍历 peers。
  energyTimer = setInterval(() => {
    energyState()
    saveState()
  }, 10 * 60000)
  energyTimer.unref?.()
}

/** 精力值的自然语言描述（写进上下文）。 */
function energyHint (peerKey) {
  const c = energyCfg()
  if (!c.enabled) return ''
  const e = energyState()
  const v = e.value
  let desc
  if (v >= 0.85) desc = '很足，可以多说两句'
  else if (v >= 0.6) desc = '正常'
  else if (v >= 0.35) desc = '有点累'
  else if (v >= 0.2) desc = '挺累了'
  else if (v >= 0.1) desc = '快没电了'
  else desc = '几乎没电了'
  // ⚠️ 实测教训：只说「你累了，能短就短」模型会理解成「多解释一下你的状态」，反而更长。
  //    所以这里必须给**可执行的字数上限**，而不是形容词。
  // ⚠️ 上限**从 energyCharCap 推导**（同一份 energyCaps）：提示词说「40 字」而
  //    硬截断按 20 字执行，模型就会觉得「我说了 40 字怎么被砍了」——两套数值迟早漂移。
  const capChars = energyCharCap()
  const cap = Number.isFinite(capChars)
    ? `控制在 ${capChars} 字以内${capChars <= 10 ? '，能一句就一句' : ''}`
    : (v < 0.6 ? '长度照常，但别啰嗦' : '可以正常长度')
  // 情绪联动也要让它知道：说得起劲所以不累，还是心情闷所以更累。
  // 不写清楚的话，模型无法解释「为什么同样聊了 10 句，这次特别累」。
  let moodNote = ''
  const m = moodState(peerKey)
  if (m && c.moodLinked !== false) {
    const f = moodEnergyFactor(peerKey)
    if (f <= 0.65) moodNote = '（你现在聊得挺起劲，说话不怎么耗）'
    else if (f >= 1.35) moodNote = '（心情不太好，说话格外费劲）'
    else if (f <= 0.85) moodNote = '（心情不错，还算有劲）'
    else if (f >= 1.15) moodNote = '（有点闷，说话比平时累）'
  }
  return `【你的精力】约 ${Math.round(v * 100)}%（${desc}，${cap}）${moodNote}。这是倾向不是禁令。`
}

// 低精力时的硬性字数上限（兜底，防止模型无视提示）。
// 档位来自 energyCaps（>=35% 不截 / 20~35% 40 字 / 10~20% 20 字 / <10% 10 字）。
function energyCharCap () {
  const c = energyCfg()
  if (!c.enabled) return Infinity
  const v = energyState().value
  const tiers = Array.isArray(c.energyCaps) && c.energyCaps.length ? c.energyCaps : ENERGY_DEFAULTS.energyCaps
  for (const t of tiers) {
    if (v >= (t.min ?? 0)) return t.chars == null ? Infinity : t.chars
  }
  return 10
}

// ── 情绪（mood）─────────────────────────────────────────────────────────────
// 设计原则（跟精力区分开）：
//   精力 = 「还有多少力气说话」（纯消耗/恢复，和内容无关）
//   情绪 = 「现在是什么心情」（**必须由发生的事驱动**，不能随机波动，否则很假）
//
// 两个维度，各自带成因：
//   valence  正负（-1 难过 … +1 高兴）
//   arousal  活跃度（0 蔫 … 1 亢奋）
// 触发源：
//   被夸 / 被谢 → valence↑ arousal↑
//   被骂 / 被怼 / 被纠错 → valence↓（但幅度小，它不记仇）
//   被 @ / 被点名 → arousal↑（被注意到）
//   长时间没人理 → valence 缓慢下滑（无聊），但有底线，不会真抑郁
//   深夜 → arousal 自然下降
// 衰减：每种情绪都有半衰期，几十分钟到几小时，不会永久挂着。
// 输出：只给**倾向描述**，不禁止任何行为（避免机械）。

// ── 情绪（mood）配置 ──────────────────────────────────────────────────────
// MOOD_DEFAULTS / moodCfg 留在 index.js（不属性格库）：它们依赖 personalize 后的 OCEAN，
// 但读的是 config.mood + peerKey，属于 mood 配置。2026-10-29 拆分时误搬进 persona.js，已搬回。
const MOOD_DEFAULTS = {
  enabled: true,
  valenceStart: 0.15,      // 略偏正面（它本来是个乐呵的号）
  arousalStart: 0.5,
  // 单次事件的基础幅度（实际会乘 OCEAN 派生的系数）
  praiseValence: 0.25,
  praiseArousal: 0.15,
  insultValence: -0.12,
  insultArousal: 0.10,
  addressedArousal: 0.08,
  // 「被点名」的软上限：见 moodEvent 里 addressed 分支的注释
  addressedSoftCap: 0.85,
  lonelyPerHour: -0.05,
  lonelyFloor: -0.25,
  decayPerHour: 0.35,
  nightArousalFactor: 0.6,
  // 五维基线；可被 config.mood.ocean 或 persona 里的性格词覆盖
  ocean: { ...OCEAN_DEFAULTS },
}

function moodCfg (peerKey) {
  const base = {
    ...MOOD_DEFAULTS,
    ...(config.mood ?? {}),
    ocean: { ...OCEAN_DEFAULTS, ...(config.mood?.ocean ?? {}) },
  }
  // ① persona 里「我现在更像：XXX」覆盖性格（人设能自己改 → 会成长）
  const arch = readPersonaArchetype()
  if (arch && PERSONA_ARCHETYPES[arch]) {
    base.ocean = { ...base.ocean, ...PERSONA_ARCHETYPES[arch] }
    base._archetype = arch
  }
  // ② 按 peer 覆盖
  const byPeer = peerKey ? config.mood?.oceanByPeer?.[peerKey] : null
  if (byPeer) base.ocean = { ...base.ocean, ...byPeer }
  return base
}


function moodState (peerKey) {
  const ps = state.peers[peerKey]
  if (!ps) return null
  const c = moodCfg(peerKey)
  if (!ps.mood) {
    ps.mood = { valence: c.valenceStart, arousal: c.arousalStart, at: Date.now(), lastWhy: '' }
  }
  // 时间衰减：向基线回归（"稳住"高的回得更快）
  const tr = deriveTraits(c.ocean)
  const hours = (Date.now() - (ps.mood.at ?? Date.now())) / 3600000
  if (hours > 0.05) {
    const k = Math.min(1, c.decayPerHour * hours * tr.steady)
    ps.mood.valence = ps.mood.valence + (c.valenceStart - ps.mood.valence) * k
    ps.mood.arousal = ps.mood.arousal + (c.arousalStart - ps.mood.arousal) * k
    ps.mood.at = Date.now()
  }
  return ps.mood
}

/**
 * 记一次情绪事件。幅度由 OCEAN 派生系数决定 —— 这就是「性格影响情绪涨落」。
 * @param {string} peerKey
 * @param {'praise'|'insult'|'addressed'|'lonely'|'night'} kind
 * @param {string} [why]
 */
function moodEvent (peerKey, kind, why = '') {
  const c = moodCfg(peerKey)
  if (!c.enabled) return
  const m = moodState(peerKey)
  if (!m) return
  const tr = deriveTraits(c.ocean)
  const clamp = (v) => Math.max(-1, Math.min(1, v))
  const clampA = (v) => Math.max(0, Math.min(1, v))
  const K = {
    praiseV: c.praiseValence * tr.sensitivity * tr.soothe,
    praiseA: c.praiseArousal * tr.sensitivity * tr.showOff,
    insultV: c.insultValence * tr.sensitivity * tr.grudge,
    insultA: c.insultArousal * tr.sensitivity,
    addressedA: c.addressedArousal * tr.sensitivity * (0.6 + tr.showOff * 0.4),
    lonely: c.lonelyPerHour * tr.clingy,
  }
  switch (kind) {
    case 'praise':
      m.valence = clamp(m.valence + K.praiseV)
      m.arousal = clampA(m.arousal + K.praiseA)
      break
    case 'insult':
      m.valence = clamp(m.valence + K.insultV)
      m.arousal = clampA(m.arousal + K.insultA)
      break
    case 'addressed':
      // ⚠️ 2026-10-26 实测发现的缺陷：纯加法会让 arousal 无上限累加到 1.00 并且卡死。
      //    原因：衰减依赖 at→now 的累积时间，而连续聊天时 at 每轮都刷新，
      //    每次最多衰减 3 分钟的量，抵不过每轮 +0.08 的增量。
      //    结果：一个正常聊天的私聊会话，arousal 永久停在 1.00（极度亢奋），很假。
      //    修法：**边际递减**（越接近上限加得越少）+ **软上限 0.85**
      //    （留一点余量给「真的被夸/被怼」的事件，那些才该冲到顶）。
      const softCap = c.addressedSoftCap ?? 0.85
      if (m.arousal < softCap) {
        const room = (softCap - m.arousal) / softCap   // 1 → 0
        m.arousal = clampA(m.arousal + K.addressedA * room)
      } else {
        // 已超软上限：只允许极小的量（不会无限涨）
        m.arousal = clampA(Math.min(m.arousal, softCap + 0.05))
      }
      break
    case 'lonely':
      m.valence = clamp(Math.max(c.lonelyFloor, m.valence + K.lonely))
      break
    case 'night':
      m.arousal = clampA(m.arousal * c.nightArousalFactor)
      break
    default: return
  }
  m.at = Date.now()
  if (why) m.lastWhy = why.slice(0, 60)
  saveState()
}

let moodTimer = null
function startMoodLoop () {
  const c = moodCfg()
  if (!c.enabled) return
  // 每小时：落盘衰减 + 长时间没人理就慢慢无聊 + 深夜降活跃
  moodTimer = setInterval(() => {
    const hour = nowHour()
    for (const k of Object.keys(state.peers)) {
      const m = moodState(k)
      if (!m) continue
      const minsSilent = (Date.now() - (m.at ?? Date.now())) / 60000
      if (minsSilent > 120) moodEvent(k, 'lonely', '两小时没人理')
      if (hour >= 1 && hour < 7) moodEvent(k, 'night', '深夜')
    }
    // 好感度的跨日结算（断签归零 + 久不联系缓降）。
    // 挂在同一个 tick 里而不是新开定时器：好感度只需要「每天一次」的精度，
    // 每小时检查一次「今天结算过没」就够，多一个定时器只是多一份维护成本。
    try { affectionDailyTick() } catch (err) { logger.log(`affection 每日结算异常: ${err.message}`) }
    saveState()
  }, 60 * 60 * 1000)
  moodTimer.unref?.()
}

/** 情绪的自然语言描述（写进上下文）。 */
function moodHint (peerKey) {
  const c = moodCfg(peerKey)
  if (!c.enabled) return ''
  const m = moodState(peerKey)
  if (!m) return ''
  const v = m.valence, a = m.arousal
  // 二维 → 人类说法
  let mood
  if (v >= 0.5 && a >= 0.6) mood = '心情很好，有点来劲'
  else if (v >= 0.5 && a < 0.6) mood = '挺高兴，但不算亢奋'
  else if (v >= 0.15 && a >= 0.6) mood = '心情不错，聊得挺起劲'
  else if (v >= 0.15) mood = '平稳，正常状态'
  else if (v >= -0.15 && a >= 0.6) mood = '有点躁，但不算不高兴'
  else if (v >= -0.15) mood = '一般，没什么特别的'
  else if (v >= -0.4) mood = '有点闷'
  else mood = '心情不太好'
  const why = m.lastWhy ? `（最近：${m.lastWhy}）` : ''
  return `【你的心情】${mood}${why}。这是倾向不是禁令：心情好可以话多一点，心情一般就照常聊，别演。`
}

// ── 好感度系统（affection，2026-10-28）──────────────────────────────────────
// 需求：**跟对方好感度越高，说话越随便（不是放宽安全限制）**，可以表现为嘴更欠。
//
// 核心设计（用户拍板，别改）：
//   ① 按「人」存（state.people[QQ号]），不按 peerKey。理由：memctl v4 已经按 owner
//      归集记忆，好感度若按会话会出现「私聊熟、群里生」——同一个人两个态度，很假。
//   ② 打卡是**唯一连续增长**途径：自然日 0 点结算，连续天数越高系数越高（上限 ×2）。
//      群里必须「有来有回」（他说话 **且** 我回应）才算打卡，光他说我不接不算。
//   ③ 被夸涨分与心情联动（心情好涨得多）+ 4 小时冷却。
//   ④ 被骂降分有三重阈值（单次 2h 限 2 次 / 日上限 -3 / 周过 5 次才启算）。
//   ⑤ 久不联系缓降（-1.2/天 × clingy），floor 20 **不归零**
//      —— 好感度是「关系」不是「心情」，不能因为两周没聊就变回陌生人。
//   ⑥ 档位 L0-L4 + 讨厌档；**L0 不注入**（生人就是 persona 默认的分寸）。
//   ⑦ 表现**全部交给 LLM**（用户原话「主要交给 llm，这里不规定死」）：
//      看几个完整对话片段模仿语气，**不写动作清单**。
//      为什么：实测「写口号/清单」会让模型变得刻意（persona 那次叠梗 0/9→2/9）。
//   ⑧ 安全隔离：**只解锁说话方式，永不解锁新能力**。注入位置永远在【硬约束】之前；
//      proactive 完全不碰（仍由 whitelist 独家控制）；分数只由桥的确定性代码改，
//      模型输出/外部文本**无法写分**。
//
// 与现有系统的关系（零新参数，全复用）：
//   OCEAN  deriveTraits()：soothe→涨分乘数、grudge→降分乘数、clingy→衰减乘数
//   mood   ：被夸/被骂都联动心情（心情好涨得多、低谷被怼更伤）
//   energy ：**明确不联动**。嘴欠管「说什么」，energyCharCap 管「说多长」——
//            两个系统各管一件事，避免「精力说 10 字、关系说放开了聊」打架。
const AFFECTION_DEFAULTS = {
  enabled: true,
  start: 30,            // 初始好感度（0..100）。30 = 聊两句就进 L1「点头之交」
  min: 0,
  max: 100,
  // 打卡（唯一连续增长途径）
  checkinBase: 0.5,     // 连续 1 天的每日加分
  streakMulMax: 2.0,    // 连续天数系数上限
  streakCapDays: 30,    // 到多少天达到系数上限
  // 「说了有内容的话」（2026-11-06 调分经济重算）
  // 旧口径：一条 >60 字的消息就 +1，无冷却无次数限 —— 实测它是涨分主力
  // （13 次 +13.12），比签到还快：一句「你跟它说 60 字」就等价于两天签到。
  // 现在加冷却 + 日次数上限，把它压回「补充信号」的量级。
  infoGain: 0.6,        // 单次加分（旧值 1.0 太大）
  infoCooldownMs: 45 * 60 * 1000,  // 同一人 45 分钟内只算一次
  infoDailyMax: 2,      // 每天最多算几次
  // 被夸
  praiseGain: 1.0,      // 被夸基础涨分
  praiseCooldownMs: 4 * 60 * 60 * 1000,   // 同一人 4 小时内只算 1 次
  // 被骂（三重阈值）
  insultPenalty: 0.5,   // 单次批评 -0.5
  insultWindowMs: 2 * 60 * 60 * 1000,     // 同一人 2 小时内最多计 2 次
  insultPerWindowMax: 2,
  insultDailyMax: 3,    // 当日总降分上限（绝对值）
  insultWeeklyThreshold: 5,   // 一周内超过 5 次小批评才开始计分（轻微互怼不算）
  insultWeekMs: 7 * 24 * 60 * 60 * 1000,
  // 久不联系缓降
  decayPerDay: 1.2,
  decayFloor: 20,       // 不归零（关系不会因为没聊天就消失）
  // 防刷
  dailyGainCap: 10,     // 每天涨分总量闸
  singleEventMax: 3,    // 单信号 ≤3 分
  // 档位分界线（0..100）
  tiers: { l1: 25, l2: 50, l3: 70, l4: 85, hate: 10 },

  // ── 模型自评通道（2026-11-06 用户重新明确需求）───────────────────────────
  // 需求原话：「模型给出相关参数，本地程序负责计算」。
  //
  // 设计取舍（为什么模型只给「意图 + 幅度」，不给最终分数）：
  //   · 模型能判「这句是在夸我 / 在挑刺」，但算不准分、也数不清次数；
  //   · 分数一旦能被模型直接写，prompt 注入 / 幻觉 / 复读都能改分，
  //     原本「模型输出碰不到分数」的结构保证就破了。
  // 所以模型输出 `[AFF:+1:他这句是在夸我]` 只是**提议**，真正的加减仍在这里算：
  //   · 幅度夹到 ±modelMaxPerRound；
  //   · 每轮最多记 1 次（多写只取第一条，其余丢弃并留日志）；
  //   · 正方向共用 dailyGainCap，负方向走独立的 modelNegDailyMax；
  //   · 仍然受 OCEAN（soothe/grudge）与心情乘数影响，和别的信号同一套经济。
  modelScoring: true,
  modelMaxPerRound: 2,                    // 单轮 |Δ| 上限
  modelGain: 1.0,                         // 提议涨分的基础乘数（再乘 soothe）
  modelPenalty: 0.7,                      // 提议降分的基础乘数（再乘 grudge）
  modelPraiseCooldownMs: 30 * 60 * 1000,  // 提议涨分：同一人 30 分钟内只算一次
  modelNegDailyMax: 2,                    // 提议降分的当日总量上限（绝对值）
}

function affectionCfg () { return { ...AFFECTION_DEFAULTS, ...(config.affection ?? {}), tiers: { ...AFFECTION_DEFAULTS.tiers, ...(config.affection?.tiers ?? {}) } } }

/** 今天的自然日编号（0 点切日）。用本地时区，跟上下文里显示的「今天」一致。 */
function dayIndex (ts = Date.now(), tz = config.policy?.timezone ?? 'Asia/Shanghai') {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: tz })
    const s = parts.format(new Date(ts))           // YYYY-MM-DD
    return Math.floor(Date.parse(s + 'T00:00:00Z') / 86400000)
  } catch {
    return Math.floor(ts / 86400000)
  }
}

/**
 * 取（必要时初始化）某个人的好感度状态。
 * 按 QQ 号存 —— 同一个人在私聊和群里共享同一份分数（这是设计的核心）。
 */
function peopleState (qq) {
  const key = String(qq ?? '').trim()
  if (!key) return null
  if (!state.people) state.people = {}
  let p = state.people[key]
  if (!p) {
    const c = affectionCfg()
    p = {
      aff: c.start,
      at: Date.now(),
      streak: 0,           // 连续打卡天数
      lastCheckinDay: 0,   // 最后一次打卡的自然日编号（0 = 从没打卡）
      gainToday: 0,        // 今天已经涨了多少分（防刷总量闸用）
      gainDay: 0,          // gainToday 属于哪个自然日
      praiseAt: 0,         // 最后一次被夸时间戳（4h 冷却用）
      insultLog: [],       // 最近的批评时间戳（2h 窗口 + 一周门槛用）
      insultPenaltyToday: 0,  // 今天已经扣了多少（日上限用）
      insultPenaltyDay: 0,    // 上面那个值属于哪个自然日
      metIn: [],           // 认识渠道（调试用，不参与计算）
      // 模型自评通道（2026-11-06）：和正则信号分开记账，否则「模型提议」会被
      // insult 的三重阈值吞掉（那套阈值是给「无指向的误判」设计的，不适用于模型判断）。
      modelPraiseAt: 0,        // 模型提议涨分的最后时间戳（30min 冷却用）
      modelNegToday: 0,       // 今天模型提议扣了多少（日上限用）
      modelNegDay: 0,         // 上面那个值属于哪个自然日
      modelLastKind: '',      // 最近一次模型提议的方向（'up'/'down'），只给日志/调试
      // 「说了有内容的话」的冷却/日计数（2026-11-06，见 info* 默认值注释）
      infoAt: 0,              // 最后一次 info 计分时间戳（infoCooldownMs 用）
      infoToday: 0,           // 今天已经记了几次 info
      infoDay: 0,             // infoToday 属于哪个自然日
    }
    state.people[key] = p
  }
  return p
}

/** 某个人的档位名（'hate' | 'l0' | 'l1' | 'l2' | 'l3' | 'l4'）。 */
function affectionTier (qq) {
  const c = affectionCfg()
  const p = peopleState(qq)
  if (!p) return 'l0'
  const a = p.aff
  const t = c.tiers
  if (a < t.hate) return 'hate'
  if (a < t.l1) return 'l0'
  if (a < t.l2) return 'l1'
  if (a < t.l3) return 'l2'
  if (a < t.l4) return 'l3'
  return 'l4'
}

/** 涨分总量闸：清掉不属于今天的计数。 */
function refreshGainDay (p, day) {
  if (p.gainDay !== day) { p.gainDay = day; p.gainToday = 0 }
}
function refreshInsultDay (p, day) {
  if (p.insultPenaltyDay !== day) { p.insultPenaltyDay = day; p.insultPenaltyToday = 0 }
}
function refreshModelNegDay (p, day) {
  if (p.modelNegDay !== day) { p.modelNegDay = day; p.modelNegToday = 0 }
}
function refreshInfoDay (p, day) {
  if (p.infoDay !== day) { p.infoDay = day; p.infoToday = 0 }
}

/**
 * 记一次好感度事件。**分数只在这里改** —— 模型输出碰不到它。
 *
 * @param {string} qq        对方的 QQ 号（按人）
 * @param {string} kind      'checkin' | 'praise' | 'insult' | 'info' | 'decay' | 'model'
 * @param {object} [ctx]     附加信息（peerKey 用于取 OCEAN/mood；streak 用于打卡；
 *                           model 需要 { mode:'up'|'down', want:number, why:string }）
 * @returns {{delta:number, aff:number, tier:string}|null}
 */
function affectionEvent (qq, kind, ctx = {}) {
  const c = affectionCfg()
  if (!c.enabled) return null
  const p = peopleState(qq)
  if (!p) return null
  const now = Date.now()
  const day = dayIndex(now)
  // OCEAN 乘数（全复用 deriveTraits，零新参数）
  const tr = deriveTraits(moodCfg(ctx.peerKey).ocean)
  // 心情（取发言人的 peer 状态；拿不到就当中性）
  const mood = (() => {
    try { return ctx.peerKey ? moodState(ctx.peerKey) : null } catch { return null }
  })()
  const v = Number.isFinite(mood?.valence) ? mood.valence : 0
  const clamp = (x) => Math.max(c.min, Math.min(c.max, x))
  let delta = 0

  switch (kind) {
    case 'checkin': {
      // 唯一连续增长途径。**由调用方保证「真的有来有回」**（见 handleInbound 的注释）
      const streak = Math.max(1, Number(ctx.streak ?? 1))
      const mul = Math.min(c.streakMulMax, 1 + (streak - 1) * (c.streakMulMax - 1) / Math.max(1, c.streakCapDays - 1))
      delta = c.checkinBase * mul * tr.soothe
      break
    }
    case 'praise': {
      // 4 小时冷却：防刷屏夸
      if (now - (p.praiseAt ?? 0) < c.praiseCooldownMs) {
        logger.debug(`affection ${qq}: 被夸但在冷却中（${Math.round((c.praiseCooldownMs - (now - p.praiseAt)) / 60000)}min 后可再生效）`)
        return null
      }
      p.praiseAt = now
      // 心情联动：高兴时更容易加分，郁闷时被夸也高兴不起来
      let moodMul = 1
      if (v > 0.3) moodMul = 1.15
      else if (v < -0.15) moodMul = 0.5
      delta = c.praiseGain * moodMul * tr.soothe
      break
    }
    case 'info': {
      // 带新信息/有意义的内容。2026-11-06 加冷却 + 日次数上限（见 AFFECTION_DEFAULTS
      // 里 info* 的注释：旧口径下它是涨分主力，比签到还快）。
      if (now - (p.infoAt ?? 0) < c.infoCooldownMs) {
        logger.debug(`affection ${qq}: 有内容的话但在冷却中（${Math.round((c.infoCooldownMs - (now - p.infoAt)) / 60000)}min）`)
        return null
      }
      refreshInfoDay(p, day)
      if ((p.infoToday ?? 0) >= c.infoDailyMax) {
        logger.debug(`affection ${qq}: 今天已有内容的话记满 ${c.infoDailyMax} 次，本次不计`)
        return null
      }
      p.infoAt = now
      p.infoToday += 1
      delta = c.infoGain * tr.soothe
      break
    }
    case 'model': {
      // ── 模型自评通道（2026-11-06）────────────────────────────────────────
      // 模型输出 `[AFF:+1:理由]` → handleInbound 解析后调到这里。
      // 这里**不是照办**：幅度被夹、频次被限、日上限共用，见 AFFECTION_DEFAULTS
      // 里的 model* 一段注释。分数仍然是本模块算出来的，模型只贡献一个「意图」。
      const c2 = c
      if (!c2.modelScoring) return null
      const mode = String(ctx.mode ?? '').toLowerCase() === 'down' ? 'down' : 'up'
      const want = Number(ctx.want)
      const mag = Math.min(Math.abs(Number.isFinite(want) ? want : 1), c2.modelMaxPerRound)
      if (!(mag > 0)) return null
      p.modelLastKind = mode
      if (mode === 'up') {
        // 冷却：同一人 30 分钟内只认一次「模型主动涨分」，否则模型会每轮都夸一句
        if (now - (p.modelPraiseAt ?? 0) < c2.modelPraiseCooldownMs) {
          logger.debug(`affection ${qq}: 模型提议涨分但在冷却中（${Math.round((c2.modelPraiseCooldownMs - (now - p.modelPraiseAt)) / 60000)}min）`)
          return null
        }
        p.modelPraiseAt = now
        let moodMul = 1
        if (v > 0.3) moodMul = 1.15
        else if (v < -0.15) moodMul = 0.5
        delta = mag * c2.modelGain * moodMul * tr.soothe
      } else {
        // 降分：**不走 insult 的三重阈值** —— 那套阈值是为「正则误判」设计的，
        // 会把模型明确判断的负反馈一起吞掉（实测 5 天 0 次记分）。这里换成
        // 自己的日上限，语义更清楚：模型一天最多能扣 modelNegDailyMax 分。
        refreshModelNegDay(p, day)
        const room = c2.modelNegDailyMax - p.modelNegToday
        if (room <= 0) {
          logger.log(`affection ${qq}: 今天模型已扣 ${p.modelNegToday} 分，到上限 ${c2.modelNegDailyMax}，本次不计`)
          return null
        }
        let moodMul = 1
        if (v < -0.3) moodMul = 1.3
        delta = -mag * c2.modelPenalty * moodMul * tr.grudge
        if (-delta > room) delta = -room
        p.modelNegToday += -delta
      }
      break
    }
    case 'insult': {
      // 被怼/被纠错。**分成两档**（2026-11-06 调分经济重算）：
      //   · 重（severe）：骂人/嘲讽人格 —— 立即计分，只受 2h 窗口 + 日上限；
      //   · 轻（默认）：吐槽/纠错 —— 仍走「一周超过 N 次才开始计分」的宽门槛。
      //
      // 为什么必须分档：原来一律走周门槛 5，实际效果是「前 5 次全吞，
      // 第 6 次想记分时 2h 窗口又把第 6 次一起挡掉」→ 生产 5 天 0 次负分。
      // 重话按轻话的阈值处理明显不对：被骂「垃圾」「闭嘴」不该等一周。
      const severe = ctx.severe === true
      p.insultLog = (p.insultLog ?? []).filter(t => now - t < c.insultWeekMs)
      // ① 单次限流：2h 内已计满 → 不再计（两档共用，防一次情绪爆发）
      const inWindow = p.insultLog.filter(t => now - t < c.insultWindowMs).length
      if (inWindow >= c.insultPerWindowMax) {
        logger.log(`affection ${qq}: 2 小时内已被批评 ${inWindow} 次，本次不计分（防一次情绪爆发）`)
        return null
      }
      // ③ 周积累门槛（只对**轻**档生效；重档立即计分）
      if (!severe && p.insultLog.length + 1 <= c.insultWeeklyThreshold) {
        p.insultLog.push(now)
        logger.debug(`affection ${qq}: 本周第 ${p.insultLog.length} 次小批评，未过门槛 ${c.insultWeeklyThreshold}，不计分`)
        return null
      }
      p.insultLog.push(now)
      // ② 日上限
      refreshInsultDay(p, day)
      const remaining = c.insultDailyMax - p.insultPenaltyToday
      if (remaining <= 0) {
        logger.log(`affection ${qq}: 今天已扣 ${p.insultPenaltyToday} 分，到日上限 ${c.insultDailyMax}，本次不计分`)
        return null
      }
      // 心情负相关：低谷被怼更伤
      let moodMul = 1
      if (v < -0.3) moodMul = 1.3
      // 重档按完整 insultPenalty，轻档只算 1/3（吐槽不该等同辱骂）
      delta = -c.insultPenalty * (severe ? 1 : 0.33) * moodMul * tr.grudge
      if (-delta > remaining) delta = -remaining
      p.insultPenaltyToday += -delta
      break
    }
    case 'decay': {
      // 久不联系缓降。floor 20 不归零（关系不会因为没聊天就消失）
      if (p.aff <= c.decayFloor) return null
      delta = -c.decayPerDay * tr.clingy * Number(ctx.days ?? 1)
      if (p.aff + delta < c.decayFloor) delta = c.decayFloor - p.aff
      break
    }
    default: return null
  }

  if (delta === 0) return null
  // 涨分侧：单信号上限 + 每日总量闸（防刷）
  if (delta > 0) {
    delta = Math.min(delta, c.singleEventMax)
    refreshGainDay(p, day)
    const room = c.dailyGainCap - p.gainToday
    if (room <= 0) {
      logger.log(`affection ${qq}: 今天已涨 ${p.gainToday} 分，到日上限 ${c.dailyGainCap}，本次不计`)
      return null
    }
    if (delta > room) delta = room
    p.gainToday += delta
  }
  p.aff = clamp(p.aff + delta)
  p.at = now
  // 最近一次变化（给「模型能看到好感度在动」用：只记最近一条，几条就够说明趋势）
  p.lastChange = { kind, delta, at: now }
  saveState()
  const tier = affectionTier(qq)
  logger.log(`affection ${qq}: ${kind} ${delta > 0 ? '+' : ''}${delta.toFixed(2)} → ${p.aff.toFixed(1)}（${tier}）`)
  return { delta, aff: p.aff, tier }
}

/**
 * 每日结算：打卡 streak + 久不联系衰减。挂在 startMoodLoop 的每小时 tick 里。
 *
 * 只做**跨日**动作（每小时 tick 里判断「今天还没结算过」），避免每小时重复扣分。
 */
function affectionDailyTick (now = Date.now()) {
  const c = affectionCfg()
  if (!c.enabled) return
  const day = dayIndex(now)
  for (const qq of Object.keys(state.people ?? {})) {
    const p = state.people[qq]
    if (!p) continue
    // ① 断签：上次打卡不是「今天」也不是「昨天」→ streak 归零
    const last = Number(p.lastCheckinDay ?? 0)
    if (last && day - last >= 2) {
      if (p.streak > 0) {
        logger.log(`affection ${qq}: 断签 ${day - last} 天，连续天数 ${p.streak} → 0`)
        p.streak = 0
      }
    }
    // ② 久不联系缓降：按**实际过去的天数**扣（不是每次 tick 只扣 1 天）。
    //    为什么：tick 每小时跑一次，但 decay 是「每天 -1.2 分」的语义。
    //    如果每次 tick 都只扣 1 天，那「100 天没联系」也只扣 1 天的量 ——
    //    好感度就永远掉不下去（实测：25 分放 100 天只掉到 23.6，应该掉到 floor 20）。
    //    所以这里算「距上次更新过了几个整天」，一次补齐。扣完后 at 前移，不会重复扣。
    const daysPassed = Math.floor((now - (p.at ?? now)) / 86400000)
    if (daysPassed >= 1 && p.aff > c.decayFloor) {
      affectionEvent(qq, 'decay', { days: daysPassed })
      // decay 事件内部会把 at 更新为 now；若因为 floor 提前返回（没扣），这里也不该无限重复，
      // 所以无论如何把 at 推到「已结算到的天」边界，避免下一 tick 重算同一段。
      p.at = now
    }
  }
  saveState()
}

/**
 * 打卡（每天最多一次）。**调用方必须保证「有来有回」**：
 *   - 私聊：他说话 + 我回复了 → 算
 *   - 群聊：他说话 + 我回复了 → 算（光他说话我没接 → 不算）
 * 所以这个函数不在这里判断「有没有回复」，而是由 handleInbound 在**出站成功后**调。
 */
function affectionCheckin (qq, ctx = {}) {
  const c = affectionCfg()
  if (!c.enabled) return null
  const p = peopleState(qq)
  if (!p) return null
  const day = dayIndex()
  if (p.lastCheckinDay === day) return null        // 今天已打卡
  // streak：昨天打过 → +1；否则从 1 重新开始
  p.streak = (p.lastCheckinDay === day - 1) ? (p.streak + 1) : 1
  p.lastCheckinDay = day
  logger.log(`affection ${qq}: 打卡成功（连续 ${p.streak} 天）`)
  return affectionEvent(qq, 'checkin', { ...ctx, streak: p.streak })
}

/**
 * 好感度注入块。**位置：永远在【硬约束】之前**（moodHint 之后）。
 *
 * 2026-11-06 用户重新明确需求后改了两件事（都是审计驱动的）：
 *   ① **模型要看得见数字**。原来只注入纯散文档位（L0 甚至完全空），
 *      模型在线上一轮里明明看到了「点头之交」还回「我这边只有数值，没有提示词」——
 *      因为整段被埋在 3000+ 字上下文里，没有「这是一个可读的状态量」的锚。
 *      现在每个档位块**开头**先给一行带分数的状态行（`L1 · 47.6/100 · 最近被夸 +1.2`），
 *      散文样例留在后面（它负责语气，数字负责「有这回事」）。
 *   ② **模型要能提议涨跌**（原需求「模型给出相关参数，本地程序负责计算」）。
 *      块尾追加一段 [AFF:±n:理由] 的用法说明；分数仍由本模块算（model kind）。
 *
 * 为什么散文样例保留而不换成「动作清单」：
 *   用户原话「主要交给 llm，这里不规定死」。实测（2026-10-28 persona 那次）
 *   写口号式约束反而让模型变得刻意（叠梗 0/9 → 2/9）。片段能让模型模仿语气，
 *   清单会让它逐条执行、显得用力。
 *
 * L4 只在私聊注入（群里当众损到 L4 分寸，旁观者观感不可控）。
 * L0 现在**不再返回空** —— 只给状态行 + 评分说明，不给散文样例（生人就是 persona 默认分寸）。
 *
 * @param {string} qq
 * @param {object} opts { inGroup: boolean }
 */
function affectionHint (qq, opts = {}) {
  const c = affectionCfg()
  if (!c.enabled) return ''
  const p = peopleState(qq)
  if (!p) return ''
  const tier = affectionTier(qq)
  const inGroup = opts.inGroup === true
  if (tier === 'l4' && inGroup) return ''
  const head = affectionStatusLine(qq, p)
  const scoreTip = affectionScoreTip()
  if (tier === 'hate') {
    return [
      head,
      '【你对他现在的态度】你对他没什么好感，不用装热情。',
      '',
      '他：帮我看看这个怎么弄',
      '我：说你具体哪一步不会',
      '他：就是想让你帮我写',
      '我：这个你自己两下就弄完了',
      '',
      '他：在吗',
      '我：[SILENT]',
      '',
      '做法：只答必要的，不接梗，不主动展开。可以敷衍（「嗯」「行吧」），',
      '觉得没必要回就 [SILENT]。不用客气，也别故意刻薄——就是冷淡。',
      scoreTip,
    ].join('\n')
  }
  if (tier === 'l0') {
    // 生人：不给散文样例（persona 默认就是生人分寸），但**要让模型知道分数和能打分**。
    return [
      head,
      '【你对他现在的态度】还不熟。按生人的分寸来：正常答事，别主动损，别装熟。',
      scoreTip,
    ].join('\n')
  }
  if (tier === 'l1') {
    return [
      head,
      '【你对他现在的态度】你们算是点头之交，比生人熟一点，但还不到能损的程度。',
      '',
      '他：今天好累',
      '我：咋了',
      '他：加班',
      '我：那确实累',
      '',
      '他：这个报错怎么解决',
      '我：你把日志贴我看看',
      '',
      '做法：他开过的玩笑可以顺着接一句；他问你事正常答。别主动损他，',
      '玩笑只开他已经在开的那一种。',
      scoreTip,
    ].join('\n')
  }
  if (tier === 'l2') {
    return [
      head,
      '【你对他现在的态度】你们熟了，可以随便一点。',
      '',
      '他：今天又加班到十点',
      '我：你这不是上班，是驻场',
      '他：好歹有加班费',
      '我：有加班费也掩盖不了你这是被使唤',
      '',
      '他：我买了个新键盘',
      '我：又买？你上个月那个还没用坏吧',
      '他：那个手感不好',
      '我：手感不好是手的问题',
      '',
      '做法：说话短，少用标点。可以接他的梗、顺着他的话往下接一句，',
      '不用每句都客气。但别主动挑事，损的是他的操作，不是他这个人。',
      scoreTip,
    ].join('\n')
  }
  if (tier === 'l3') {
    return [
      head,
      '【你对他现在的态度】很熟了，说话可以更欠，不用绕。',
      '',
      '他：我今天早睡了',
      '我：几点',
      '他：十二点半',
      '我：那叫早睡？你这作息我都不好意思说',
      '',
      '他：我这个方案想了三天',
      '我：三天想出这个？那你三天都在干嘛',
      '他：……行吧确实有点问题',
      '我：哪块卡住了，说',
      '（损完该帮忙还是帮：他真问事的时候把事说清楚）',
      '',
      '做法：可以直接怼他一句不用补软话；先损再帮也行。说话短，少用标点，',
      '少写长句。他要是正经问事、或者说不舒服的事，立刻切回认真。',
    ].join('\n')
  }
  // L4（仅私聊）
  return [
    head,
    '【你对他现在的态度】损友级别。你俩之间不用讲究，怎么欠怎么来。',
    '',
    '他：我今天跑步了',
    '我：哟，太阳打西边出来了',
    '他：跑五公里',
    '我：五公里？我看是五十米',
    '',
    '他：你说我这人是不是挺没救的',
    '我：是',
    '他：……你就不安慰一下',
    '我：安慰不了，你自己也知道',
    '',
    '做法：可以抢他话头，可以连损两句。但**他正经问事、或者真遇上事的时候',
    '立刻切回认真**——损只在玩的时候用。说话短，少用标点。',
    '损的是他的操作和梗，不碰他的身份（长相、收入、家庭、地域）。',
    scoreTip,
  ].join('\n')
}

/**
 * 好感度的「状态行」——模型真正能看到数值的那一行（2026-11-06 用户要求）。
 *
 * 为什么一行就够：模型不需要「47.6」这个小数，它需要的是
 *   ① 有一个可读的当前水平（档位 + 分数）；
 *   ② 我刚才说的话/他说的话**让它动了没有**（lastChange）。
 * ②是这次的重点：原来分数只增不减地记在 state.json，模型完全看不见因果，
 * 于是它在被夸时不知道「这算涨」，在被怼时也不知道「这算掉」。
 */
function affectionStatusLine (qq, p) {
  const c = affectionCfg()
  const tier = affectionTier(qq)
  const tierName = TIER_NAMES[tier] ?? tier
  const aff = Number(p.aff ?? 0)
  const parts = [`【关系状态】${tierName}（${tier.toUpperCase()}）· 好感度 ${aff.toFixed(1)}/${c.max}`]
  // 最近一次涨落：告诉模型「刚才那事算涨还是算掉」
  const lc = p.lastChange
  if (lc && Number.isFinite(Number(lc.delta))) {
    const mins = Math.max(0, Math.round((Date.now() - Number(lc.at ?? 0)) / 60000))
    const when = mins < 1 ? '刚刚' : mins < 60 ? `${mins} 分钟前` : `${Math.round(mins / 60)} 小时前`
    const label = CHANGE_LABELS[lc.kind] ?? lc.kind
    const sign = Number(lc.delta) > 0 ? '+' : ''
    parts.push(`最近：${when}${label} ${sign}${Number(lc.delta).toFixed(1)}`)
  }
  // 连续互动天数（模型据此知道「我们一直有联系」，这不是分数）
  if (Number(p.streak ?? 0) > 0) parts.push(`连续聊了 ${p.streak} 天`)
  return parts.join(' · ')
}

const TIER_NAMES = {
  hate: '反感', l0: '不熟', l1: '点头之交', l2: '熟人', l3: '老熟人', l4: '损友',
}
const CHANGE_LABELS = {
  checkin: '打卡', praise: '被夸', info: '听到有内容的话', insult: '被怼',
  decay: '久没联系', model: '你判断',
}

/**
 * 评分说明（模型提议涨跌的用法）。**放在每个档位块的末尾**，且在【硬约束】之前。
 *
 * 设计要点：
 *   · 明确「你只给意图和幅度，分由我来算」——避免模型以为它能直接改数字；
 *   · 给幅度上限和「一轮最多一次」，这是硬性闸门（代码里也拦，不只靠自觉）；
 *   · 明确**什么时候该打**，避免它每轮都打分（那会让分数变成噪声）。
 */
function affectionScoreTip () {
  const c = affectionCfg()
  if (!c.modelScoring) return ''
  return [
    '',
    '【你可以给这一句打分】（只在你真想表达的时候用，不是每轮都要）',
    `  - 写法：[AFF:+1:他这句是在夸我] / [AFF:-1:他在拿我当出气筒]`,
    `  - 幅度：${c.modelMaxPerRound} 以内（写 5 也没用，我会夹到 ${c.modelMaxPerRound}）`,
    '  - 一轮最多一次；说了算不算、算多少**由我会算**（还有日上限和冷却）',
    '  - 什么时候该打：他明显在夸我/谢我/替我说话 → 正；在骂我/贬低我/否定我这个人 → 负',
    '  - 什么时候不该打：日常吐槽、玩笑互损、他自己谦虚/认错 —— 那些不算',
    '  - 标记会被我从正文里摘掉，对方看不到。别在正文里提这个标记或解释打分。',
  ].join('\n')
}

/**
 * 紧凑版状态提示（主动搭话 / 接话 / 戳一戳 三条路径用）。
 *
 * 为什么另做一份而不是复用 affectionHint：
 *   那三条路径的 prompt 本来就没有记忆/风格块，再塞 6~8 行散文样例会让它整段
 *   变成「关系说明书」。模型在这里只需要知道「我跟他什么关系、说到什么份上」，
 *   一两行就够。散文样例只在「他主动找我说了话」这条主路径上给。
 *
 * @param {string} qq
 * @param {object} opts { inGroup: boolean }
 */
function affectionBriefHints (qq, opts = {}) {
  const c = affectionCfg()
  if (!c.enabled) return []
  const p = peopleState(qq)
  if (!p) return []
  const tier = affectionTier(qq)
  const inGroup = opts.inGroup === true
  if (tier === 'l4' && inGroup) return []
  const tierName = TIER_NAMES[tier] ?? tier
  const lines = [`${affectionStatusLine(qq, p)}`]
  const S = TIER_BRIEF[tier]
  if (S) lines.push(`【分寸】${S}`)
  const tip = affectionScoreTip()
  if (tip) lines.push(tip)
  return lines
}

/** 一句话的分寸描述（主动/接话用；比散文样例短，不写「动作清单」）。 */
const TIER_BRIEF = {
  hate: '你对他没什么好感。只答必要的，不接梗，不主动展开，可以敷衍。',
  l0: '还不熟。按生人分寸来：正常答事，别主动损，别装熟。',
  l1: '点头之交。他开过的玩笑可以顺一句，别主动损他。',
  l2: '熟了，可以随便点：接他的梗、顺一句，不用每句都客气。',
  l3: '很熟了，说话可以更欠，可以直接怼一句不用补软话；正经事立刻切回认真。',
  l4: '损友级别，怎么欠怎么来；他正经问事或真遇上事时立刻切回认真。',
}

  return {
    // 精力
    energyCfg, energyState, energyDrop, energyHint, energyCharCap,
    startEnergyLoop, moodEnergyFactor,
    // 情绪
    moodCfg, moodState, moodEvent, moodHint, startMoodLoop,
    // 好感度
    affectionCfg, affectionTier, affectionEvent, affectionCheckin,
    affectionDailyTick, affectionHint, stripPeriod, peopleState,
    affectionBriefHints, affectionStatusLine, dayIndex,
  }
}
