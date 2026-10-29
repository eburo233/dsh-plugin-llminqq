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

export function createState ({ config, logger, state, saveState, persona, nowHour }) {
  const { deriveTraits, OCEAN_DEFAULTS, PERSONA_ARCHETYPES, readPersonaArchetype } = persona

  // ↓↓↓ 原 index.js 1127-1885 行原样搬运 ↓↓↓

// ── 精力值（v2-1）───────────────────────────────────────────────────────────
// 需求：「状态有起伏」——连续发言递减、长时间静默回升，写进上下文供模型参考。
// 只做**倾向**，不做硬规则（避免机械）。
const ENERGY_DEFAULTS = {
  enabled: true,
  start: 0.75,       // 初始精力
  // ⚠️ 注意：这三个是**代码默认值**，生产生效值由 bridge/config.json 的 energy 段覆盖。
  // 现行生产配置是 perMsgDrop 0.025 / perHourRestore 0.35 / floor 0.35
  // （比这里的默认值「掉得慢、回得快、底更高」）。改注释时别引错成默认值。
  perMsgDrop: 0.06,  // 每发一条减多少
  perHourRestore: 0.15, // 每静默一小时回升多少
  floor: 0.15,
  ceil: 1.0,
  // 情绪联动：心情高涨时精力掉得少，低落时掉得多（见 moodEnergyFactor）
  moodLinked: true,
  moodLinkRange: 0.6,   // ±60%：最好心情 = 0.4x 消耗，最差 = 1.6x
}

function energyCfg () { return { ...ENERGY_DEFAULTS, ...(config.energy ?? {}) } }

function energyState (peerKey) {
  const ps = state.peers[peerKey]
  if (!ps) return null
  const c = energyCfg()
  if (!ps.energy) ps.energy = { value: c.start, at: Date.now() }
  // 静默恢复：按距今小时数回升
  const hours = (Date.now() - (ps.energy.at ?? Date.now())) / 3600000
  if (hours > 0.05) {
    ps.energy.value = Math.min(c.ceil, ps.energy.value + hours * c.perHourRestore)
    ps.energy.at = Date.now()
  }
  return ps.energy
}

/** 发了一条 → 精力下降。 */
/**
 * 情绪 → 精力的联动系数。
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

function energyDrop (peerKey) {
  const c = energyCfg()
  if (!c.enabled) return
  const e = energyState(peerKey)
  if (!e) return
  // 情绪联动：心情好掉得少、心情差掉得多
  const factor = moodEnergyFactor(peerKey)
  const drop = c.perMsgDrop * factor
  e.value = Math.max(c.floor, e.value - drop)
  e.at = Date.now()
  logger.debug?.(`energyDrop ${peerKey}: ${c.perMsgDrop.toFixed(3)} × 情绪${factor.toFixed(2)} = 掉 ${drop.toFixed(3)}`)
  saveState()
}

let energyTimer = null
function startEnergyLoop () {
  const c = energyCfg()
  if (!c.enabled) return
  // 每 10 分钟落一次盘（静默回升要能持久化，不能只在内存里涨）
  energyTimer = setInterval(() => {
    for (const k of Object.keys(state.peers)) energyState(k)
    saveState()
  }, 10 * 60000)
  energyTimer.unref?.()
}

/** 精力值的自然语言描述（写进上下文）。 */
function energyHint (peerKey) {
  const c = energyCfg()
  if (!c.enabled) return ''
  const e = energyState(peerKey)
  if (!e) return ''
  const v = e.value
  let desc
  if (v >= 0.85) desc = '很足，可以多说两句'
  else if (v >= 0.6) desc = '正常'
  else if (v >= 0.4) desc = '有点累'
  else if (v >= 0.25) desc = '挺累了'
  else desc = '快没电了'
  // ⚠️ 实测教训：只说「你累了，能短就短」模型会理解成「多解释一下你的状态」，反而更长。
  //    所以这里必须给**可执行的字数上限**，而不是形容词。
  const cap = v >= 0.85 ? '可以正常长度'
    : v >= 0.6 ? '正常长度'
    : v >= 0.4 ? '控制在 40 字以内'
    : v >= 0.25 ? '控制在 20 字以内'
    : '控制在 10 字以内，能一句就一句'
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

// 低精力时的硬性字数上限（兜底，防止模型无视提示）
function energyCharCap (peerKey) {
  const c = energyCfg()
  if (!c.enabled) return Infinity
  const e = energyState(peerKey)
  if (!e) return Infinity
  if (e.value >= 0.4) return Infinity
  return e.value >= 0.25 ? 20 : 10
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

/**
 * 记一次好感度事件。**分数只在这里改** —— 模型输出碰不到它。
 *
 * @param {string} qq        对方的 QQ 号（按人）
 * @param {string} kind      'checkin' | 'praise' | 'insult' | 'info' | 'decay'
 * @param {object} [ctx]     附加信息（peerKey 用于取 OCEAN/mood；streak 用于打卡）
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
      // 带新信息/有意义的内容
      delta = 1 * tr.soothe
      break
    }
    case 'insult': {
      // 三重阈值（用户确认的设计，三条一起）：
      //   ① 单次 -0.5，但同一人 2 小时内最多计 2 次
      //   ② 当日总量上限 -3（防一次情绪爆发掉到底）
      //   ③ 一周内超过 5 次小批评才开始计分（轻微吐槽/玩梗互怼不算）
      p.insultLog = (p.insultLog ?? []).filter(t => now - t < c.insultWeekMs)
      // ① 单次限流：2h 内已计满 → 不再计
      const inWindow = p.insultLog.filter(t => now - t < c.insultWindowMs).length
      if (inWindow >= c.insultPerWindowMax) {
        logger.log(`affection ${qq}: 2 小时内已被批评 ${inWindow} 次，本次不计分（防一次情绪爆发）`)
        return null
      }
      // ③ 周积累门槛
      if (p.insultLog.length + 1 <= c.insultWeeklyThreshold) {
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
      delta = -c.insultPenalty * moodMul * tr.grudge
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
 * 为什么写「完整对话片段」而不是「动作清单」：
 *   用户原话「主要交给 llm，这里不规定死」。而实测（2026-10-28 persona 那次）
 *   写口号式约束反而让模型变得刻意（叠梗 0/9 → 2/9）。片段能让模型模仿语气，
 *   清单会让它逐条执行、显得用力。
 *
 * L0 返回 ''（不注入）——生人就是 persona 默认的分寸，不用额外提示。
 * L4 只在私聊注入（群里当众损到 L4 分寸，旁观者观感不可控）。
 *
 * @param {string} qq
 * @param {object} opts { inGroup: boolean }
 */
function affectionHint (qq, opts = {}) {
  const c = affectionCfg()
  if (!c.enabled) return ''
  const tier = affectionTier(qq)
  const inGroup = opts.inGroup === true
  if (tier === 'l0' || tier === 'l4' && inGroup) return ''
  if (tier === 'hate') {
    return [
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
    ].join('\n')
  }
  if (tier === 'l1') {
    return [
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
    ].join('\n')
  }
  if (tier === 'l2') {
    return [
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
    ].join('\n')
  }
  if (tier === 'l3') {
    return [
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
  ].join('\n')
}

/**
 * 短句拆分的**代码兜底**（约束 2：硬规则优于形容词）。
 *
 * 为什么必须有：实测证明提示词约束不可靠（energyHint 说「15% 精力要短」，
 * 模型照样回 748 字；最后靠 energyCharCap 硬截才有效）。同理「少用标点、短句」
 * 光写提示词没用，得在出站前真的拆。
 *
 * 拆法（避免机械）：
 *   · 只在**句末标点**（。！？）或**换行**处拆，不在逗号处拆
 *     （「我觉得这个不行，因为成本太高」拆成两条会很机械，它本是一句话）
 *   · 每段必须能独立成句（长度 ≥ minChunk 才留，太短的并回上一段）
 *   · 只在**超过阈值**时才拆（正常短句不碰）
 *   · 最多拆成 maxParts 条（防一句话变五条刷屏）
 */
function splitLongSentence (text, opts = {}) {
  const cfg = affectionCfg()
  const threshold = opts.threshold ?? (config.affection?.splitChars ?? 30)
  const maxParts = opts.maxParts ?? (config.affection?.splitMaxParts ?? 2)
  const minChunk = opts.minChunk ?? 6
  const s = String(text ?? '').trim()
  if (!s || s.length <= threshold) return [s]
  // 已有换行 → 本来就分条，别再拆
  if (/\n/.test(s)) return s.split('\n').map(x => x.trim()).filter(Boolean)
  // 按句末标点切（保留标点）
  const parts = s.match(/[^。！？!?]+[。！？!?]*/g)?.map(x => x.trim()).filter(Boolean) ?? [s]
  if (parts.length <= 1) {
    // 没有句末标点 = 一整个长句。这种情况下**不硬拆**（拆了必然机械），
    // 但也不放任：交给 maxReplyChars 分块机制处理。
    return [s]
  }
  // 把太短的段落并回前一段，保证每段能独立成句
  const merged = []
  for (const p of parts) {
    if (merged.length && p.length < minChunk) merged[merged.length - 1] += p
    else merged.push(p)
  }
  if (merged.length > maxParts) {
    // 超条数：把后面的并进最后一条（避免刷屏）
    const head = merged.slice(0, maxParts - 1)
    const tail = merged.slice(maxParts - 1).join('')
    return [...head, tail]
  }
  logger.log(`affection: 长句拆分 ${s.length} 字 → ${merged.length} 条`)
  return merged
}


  return {
    // 精力
    energyCfg, energyState, energyDrop, energyHint, energyCharCap,
    startEnergyLoop, moodEnergyFactor,
    // 情绪
    moodCfg, moodState, moodEvent, moodHint, startMoodLoop,
    // 好感度
    affectionCfg, affectionTier, affectionEvent, affectionCheckin,
    affectionDailyTick, affectionHint, splitLongSentence, peopleState,
    dayIndex,
  }
}
