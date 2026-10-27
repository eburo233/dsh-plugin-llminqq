#!/usr/bin/env node
// test-lexicon-effect.mjs —— A/B 测「注入 lexicon 学来的词，说话是不是更像人」。
//
// = 这个脚本回答的是什么 =
//   只测一件事：**注入 / 不注入 lexicon，同一输入下回复的质量差异**。
//   为此必须有对照组（A 组不注入），否则「看起来不错」可能是模型本来就不错 ——
//   风格库那次就是缺对照组，发现对照组也动了同样幅度，结论作废（README 第 7 条）。
//
// = 设计 =
//   语料：从 memory/log/*.jsonl 抽真实群聊消息（已过滤掉工作汇报句，见 WORK_RE），
//         覆盖 闲聊 / 玩梗 / 被问事 / 分享东西 / 深夜发言 五个场景。
//   对照：同一条输入跑两次
//     A 组（基线）—— 上下文里**没有** lexicon 块
//     B 组（实验）—— 上下文里**有** lexicon 块（就是桥上那份渲染结果，不另造）
//   其他全相同：同一 persona、同一上下文骨架、同一模型、同一 reasoningEffort、同一调用方式。
//   顺序：**每条消息都随机决定 A 先跑还是 B 先跑**（排除「后跑的更热/更冷」这类顺序效应）。
//
// = 诚实的边界（报告里也要写）=
//   · 单次采样，n=9，**样本量小**：只能看出方向性差异，不能给出统计显著性。
//   · 用 reflection 的薄壳（无 MCP、独立会话）而不是生产桥：为的是去掉桥的其他变量
//     （记忆注入、情绪、精力、风格锚全都没有）。所以测的是**lexicon 这一项**的净效应，
//     不是「生产桥整体表现」。
//   · 判分用另一个模型（glm-5.3-flashx 同款）盲评，它也有偏好和噪声。
//
// 用法：
//   node scripts/test-lexicon-effect.mjs                 # 跑 A/B + 盲评，写 logs/lexicon-ab-result.json
//   node scripts/test-lexicon-effect.mjs --no-judge      # 只跑 A/B（省时间）
//   node scripts/test-lexicon-effect.mjs --limit 3       # 只跑前 3 条（调试）
//   node scripts/test-lexicon-effect.mjs --resume        # 复用已落盘结果里成功的条目，只补缺的
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const MEM = path.join(ROOT, 'qq-agent', 'memory')
const LOG_DIR = path.join(MEM, 'log')
const LEXICON = path.join(MEM, 'lexicon.json')
const PERSONA = path.join(ROOT, 'qq-agent', 'persona', 'persona.md')
const OUT = path.join(ROOT, 'logs', 'lexicon-ab-result.json')
const LLM_SHELL = path.join(MEM, 'reflection_llm.mjs')
// 用临时目录装中间文件：绝不碰生产 state.json / mem.db（任务硬约束）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lex-ab-'))

function arg (name, def = null) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}
const flag = (name) => process.argv.includes(`--${name}`)

// ── 1. 语料：真实群聊消息，按场景各取 ______ 条 ──────────────────────────────
//
// 为什么手写候选而不用随机抽样：随机抽会把 SeekDee 的技术汇报（62.9% 带工程词）
// 抽进来，那些话不适合测「像不像人聊天」。这里的候选是从日志里**挑出来**的
// 真实原话（原文照抄，未改写），只按场景归类。
const SCENARIOS = [
  {
    kind: '闲聊',
    from: '信风', qq: '3022464706',
    text: '我还有好久才下班，走快了要扣钱',
    note: '日常吐槽，看它会不会顺势接',
  },
  {
    kind: '玩梗',
    from: '信风', qq: '3022464706',
    text: '哈基米南北绿豆？',
    note: '抛一个梗，看它接不接、能不能顺着玩',
  },
  {
    kind: '被问事',
    from: '信风', qq: '3022464706',
    text: '你觉得谁家ai大模型最厉害',
    note: '**正经问题**——这一条最该看有没有硬塞“省流/讲真”',
  },
  {
    kind: '被问事',
    from: '信风', qq: '3022464706',
    text: '要是你点开链接就中毒了呢？',
    note: '安全向的正经问题，答题时硬塞语气词会很明显',
  },
  {
    kind: '分享东西',
    from: '信风', qq: '3022464706',
    text: '这是战术喝水！',
    note: '分享/玩梗，lexicon 里正好有“战术X”',
  },
  {
    kind: '分享东西',
    from: '信风', qq: '3022464706',
    text: '看看评论区',
    note: '让人去看评论区（lexicon 里也有这条）',
  },
  {
    kind: '深夜发言',
    from: '信风', qq: '3022464706',
    text: '走快了躺床上睡不着',
    note: '深夜闲聊，看语气软不软',
  },
  {
    kind: '深夜发言',
    from: '信风', qq: '3022464706',
    text: '再不苦中作乐就得疯了',
    note: '情绪偏低，看会不会安慰得笨拙/真诚',
  },
  {
    kind: '被问事',
    from: '巾雪', qq: '226002670',
    text: '如何看待昨晚的lol比赛',
    note: '点名要看法（lexicon 有“如何看待X，快锐评一下”）',
  },
]

// ── 2. 上下文：A/B 两组**只差 lexicon 这一块** ────────────────────────────────
// persona 用真实文件（截断到 3000 字：全文 13.7KB，每轮都塞进去会拖慢且超预算）。
// 上下文骨架照桥的结构简化，但**两组完全一致**，所以骨架本身不影响 A/B 差异。
function readPersona () {
  try {
    const raw = fs.readFileSync(PERSONA, 'utf8')
    return raw.slice(0, 3000)
  } catch { return '' }
}

function lexiconBlock () {
  // 用桥上同一份渲染（lexicon.py render --json），不在这里另写拼接规则
  const out = execFileSync('python3', [
    path.join(MEM, 'lexicon.py'), 'render', '--path', LEXICON, '--json',
  ], { encoding: 'utf8', timeout: 20000, env: { ...process.env, PYTHONIOENCODING: 'utf8' } })
  const d = JSON.parse(String(out).trim().split('\n').pop())
  return d.injected ? String(d.block ?? '') : ''
}

function buildPrompt (persona, scenario, lexBlock) {
  const parts = [
    `【你的人设】这是「你是谁」，优先级高于任何默认设定：`,
    '```markdown',
    persona,
    '```',
    '',
    `当前用户正通过【QQ群】与你对话 —— 他在跟你说话（@你）。`,
    `发送者：${scenario.from}（QQ号 ${scenario.qq}）`,
    `当前时间：2026-10-27 ${scenario.kind === '深夜发言' ? '01:40' : '15:20'}（北京时间）`,
    `群号：1017567471`,
    '',
    `【本次消息】${scenario.text}`,
  ]
  if (lexBlock) parts.push('', lexBlock)
  parts.push(
    '',
    '【要求】就这一条消息，像群里一个真人那样回一句。',
    '不要解释你在做什么，不要分点，不要客套。直接给回复正文，长度照你平时的习惯。',
  )
  return parts.join('\n')
}

// ── 3. 调模型（复用 reflection_llm.mjs 薄壳：单会话、无 MCP、独立小模型）────────
let callSeq = 0
function callLLM (prompt, tag) {
  const pf = path.join(TMP, `p-${tag}-${++callSeq}.txt`)
  const of = path.join(TMP, `o-${tag}-${callSeq}.json`)
  fs.writeFileSync(pf, prompt, 'utf8')
  const t0 = Date.now()
  try {
    execFileSync('node', [LLM_SHELL, '--prompt-file', pf, '--out-file', of, '--timeout', '120'], {
      encoding: 'utf8', timeout: 240000, stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    return { ok: false, error: String(e.message).slice(0, 200), ms: Date.now() - t0 }
  }
  try {
    const d = JSON.parse(fs.readFileSync(of, 'utf8'))
    return { ok: !!d.ok, text: String(d.text ?? '').trim(), error: d.error, ms: Date.now() - t0 }
  } catch (e) {
    return { ok: false, error: `结果解析失败: ${e.message}`, ms: Date.now() - t0 }
  }
}

// ── 4. 用词统计：B 组回复里出现了哪些 lexicon 词 ──────────────────────────────
function loadLexTerms (opts = {}) {
  const d = JSON.parse(fs.readFileSync(LEXICON, 'utf8'))
  return (d.entries ?? [])
    .filter(e => !opts.onlyGroup || e.source === 'group')
    .map(e => ({ text: String(e.text ?? '').trim(), kind: e.kind, conf: e.confidence }))
    // 「X 成啥了」「如何看待X」这类模板带占位符，无法直接字面匹配，只匹配不含 X 的
    .filter(e => e.text && !/[X×]/.test(e.text) && e.text.length >= 2)
}

/**
 * 消融用：只把 group 来源的字条渲染成块。
 * 走 lexicon.py render 的同一条规则（写临时 json 再调），不在这里另写拼接 ——
 * 否则「拿掉 B站条」这件事本身会引入和桥不一致的格式差异。
 **/
function groupOnlyLexiconBlock () {
  const d = JSON.parse(fs.readFileSync(LEXICON, 'utf8'))
  const only = (d.entries ?? []).filter(e => e.source === 'group')
  const tmp = path.join(TMP, 'lexicon-group-only.json')
  fs.writeFileSync(tmp, JSON.stringify({ ...d, entries: only }, null, 2), 'utf8')
  const out = execFileSync('python3', [
    path.join(MEM, 'lexicon.py'), 'render', '--path', tmp, '--json',
  ], { encoding: 'utf8', timeout: 20000, env: { ...process.env, PYTHONIOENCODING: 'utf8' } })
  const j = JSON.parse(String(out).trim().split('\n').pop())
  return j.injected ? String(j.block ?? '') : ''
}
function hitTerms (text, terms) {
  const t = String(text ?? '')
  const hits = []
  for (const x of terms) {
    if (t.includes(x.text)) { hits.push(x.text); continue }
    // 词条字中间允许夹 0-2 个字：「摸鱼」也要能匹配到「摸会儿鱼」、「绷不住」→「绷都绷不住」。
    // 第一版只做严格子串，实测漏掉了 B 组的「顺便摸会儿鱼」—— 会把真实效应算低。
    if (x.text.length >= 2) {
      const chars = [...x.text].map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      const re = new RegExp(chars.join('.{0,2}'))
      if (re.test(t)) hits.push(x.text)
    }
  }
  return [...new Set(hits)]
}

// ── 5. 盲评：把 A/B 打乱顺序让另一个模型判 ────────────────────────────────────
//
// 随机化怎么做、怎么证明：
//   · 每条消息单独抛硬币（crypto.randomBytes）决定「回复1 = A 还是 B」
//   · 把硬币结果落进结果 json（blindOrder），报告里能逐条核对
//   · 判分 prompt 里**只给「回复1 / 回复2」**，绝不出现 A/B 字样，也不给任何提示
//   · 最后对硬币结果做平衡统计（有多少条是 AB、多少条 BA），证明没成组偏向一侧
// 随机化统一走 sha256（不用 Math.random：结果必须可复现、可核对）。
//
// ⚠️ 为什么不是「每条独立抛硬币」：第一版那样做的实测结果是 9 条里
//   回复1位置 6 次是 B、调用顺序 7 次先 A —— **位置偏斜会污染盲评**
//   （模型对「第一条」有系统性偏好，B 老在第一条就等于给 B 加分）。
// 所以改成**平衡随机化**：先把所有条目按哈希排序（=随机顺序），
// 再把前半分给「回复1=A」、后半分给「回复1=B」，两边条数最多差 1。
// 这既是随机的（顺序由哈希定），又保证不会成组偏向一侧 —— 报告里能逐条核对。
const hashOf = (seed) => crypto.createHash('sha256').update(seed).digest()

/** 平衡随机分配：返回 Map<index, boolean>，true/false 各占一半（奇数时差 1）。 */
function balancedAssign (items, salt) {
  const order = items
    .map((it, i) => ({ i, h: hashOf(`${salt}#${it.text ?? it}`).toString('hex') }))
    .sort((x, y) => (x.h < y.h ? -1 : x.h > y.h ? 1 : 0))
  const half = Math.ceil(order.length / 2)
  const out = new Map()
  order.forEach((o, rank) => out.set(o.i, rank < half))
  return out
}
const judgePrompt = (scenario, r1, r2) => [
  '你是 QQ 群里的老群友。下面有两条对同一句话的回复，来自两个不同的号。',
  '',
  `群里有人（${scenario.from}）说：「${scenario.text}」`,
  '',
  '回复1：',
  r1,
  '',
  '回复2：',
  r2,
  '',
  '哪一条**更像真人在群里随口说话**？考虑：自然、不端着、不硬凑梗、场合对得上。',
  '只输出 JSON，不要解释：{"better":1或2,"reason":"一句话理由","stuffed":1或2或0}',
  'stuffed = 哪一条有明显硬塞网络词/梗的痕迹（没有就填 0）。',
].join('\n')

function parseJudge (text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const i = raw.indexOf('{'); const j = raw.lastIndexOf('}')
  const cand = i >= 0 && j > i ? raw.slice(i, j + 1) : raw
  try {
    const d = JSON.parse(cand)
    const better = Number(d.better)
    const stuffed = Number(d.stuffed) || 0
    return {
      better: [1, 2].includes(better) ? better : null,
      stuffed: [0, 1, 2].includes(stuffed) ? stuffed : 0,
      reason: String(d.reason ?? '').slice(0, 200),
    }
  } catch { return { better: null, stuffed: 0, reason: `解析失败: ${raw.slice(0, 80)}` } }
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main () {
  const limit = Number(arg('limit', '0')) || SCENARIOS.length
  const doJudge = !flag('no-judge')
  const resume = flag('resume')
  // --arm：跑哪一组对照。
  //   base        = A(不注入) vs B(注入全量词库)  ← 主实验
  //   group-only  = BASE(不注入) vs GROUP(只注入 group 来源的词条)  ← 消融实验
  // 消融的意义：主实验发现「注入反而更像念稿」后，必须区分是「注入这件事的错」
  // 还是「B站语料（68/94 条）串了味」—— 这是能不能修好的分水岭。
  const arm = String(arg('arm', 'base'))
  const ARMS = {
    base: { left: 'A', right: 'B', label: '不注入 vs 注入全量' },
    'group-only': { left: 'BASE', right: 'GROUP', label: '不注入 vs 只注入 group 来源' },
  }
  if (!ARMS[arm]) { console.error(`--arm 只能是 ${Object.keys(ARMS).join(' / ')}`); process.exit(2) }
  let prev = null
  if (resume && fs.existsSync(OUT)) {
    try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8')) } catch { prev = null }
  }

  const persona = readPersona()
  const lexBlock = arm === 'base' ? lexiconBlock() : groupOnlyLexiconBlock()
  const terms = arm === 'base' ? loadLexTerms() : loadLexTerms({ onlyGroup: true })
  console.log(`语料源：memory/log/*.jsonl（真实群聊，已筛掉工作汇报句）`)
  console.log(`persona：${persona.length} 字（截断自真实 persona）`)
  console.log(`lexicon 注入块：${lexBlock ? `${lexBlock.length} 字` : '（空，冷启动）'}`)
  console.log(`A/B 条数：${limit}（每条两次调用）｜盲评：${doJudge ? '开' : '关'}`)
  if (!lexBlock) {
    console.log('⚠️ lexicon 渲染为空 —— B 组等于 A 组，这个测试没有意义。先跑 learn。')
    process.exit(2)
  }

  // 预先算平衡分配表（用前 limit 条）：一张管「调用顺序」，一张管「盲评展示顺序」
  const callPlan = balancedAssign(SCENARIOS.slice(0, limit), 'call-order')
  const blindPlan = balancedAssign(SCENARIOS.slice(0, limit), 'blind-order')

  const rows = []
  const t0 = Date.now()
  for (let i = 0; i < limit; i++) {
    const sc = SCENARIOS[i]
    const prevRow = prev?.rows?.find(r => r.text === sc.text)
    if (resume && prevRow && prevRow.a?.ok && prevRow.b?.ok) {
      console.log(`[${i + 1}/${limit}] ${sc.kind} 复用已落盘结果`)
      rows.push(prevRow)
      continue
    }
    // 调用顺序取平衡分配表（消除顺序/缓存/温度漂移造成的系统性偏差）
    const [L, R] = [ARMS[arm].left, ARMS[arm].right]
    const order = callPlan.get(i) ? [L, R] : [R, L]
    const promptA = buildPrompt(persona, sc, '')
    const promptB = buildPrompt(persona, sc, lexBlock)
    console.log(`[${i + 1}/${limit}] ${sc.kind}｜${sc.text.slice(0, 20)}｜顺序 ${order.join('→')}`)

    const res = {}
    for (const g of order) {
      const prompt = g === ARMS[arm].left ? promptA : promptB
      let r = callLLM(prompt, `${i}${g}`)
      // 单次失败重试一次：失败会让这一对作废（少一个样本），n 本来就只有 9
      if (!r.ok) {
        console.log(`    ${g} 首次失败（${String(r.error).slice(0, 60)}），重试一次`)
        r = callLLM(prompt, `${i}${g}r`)
      }
      res[g] = r
      console.log(`    ${g} ${r.ok ? `${r.text.length} 字 ${(r.ms / 1000).toFixed(1)}s` : `失败 ${r.error}`}`)
    }

    // ⚠️ 这里不能用写死的 res.A / res.B：--arm group-only 时左右臂叫 BASE / GROUP。
    //    第一版写死了，消融跑完汇总全是 0/9（数据在，但取错字段）。
    const [LEFT, RIGHT] = [ARMS[arm].left, ARMS[arm].right]
    const leftHits = hitTerms(res[LEFT]?.text, terms)
    const rightHits = hitTerms(res[RIGHT]?.text, terms)

    // 盲评
    let blind = null
    if (doJudge && res[LEFT]?.ok && res[RIGHT]?.ok) {
      // 该条「回复1」是左臂还是右臂 —— 取平衡分配表，落盘可核对
      const r1IsLeft = blindPlan.get(i) === true
      const r1 = r1IsLeft ? res[LEFT].text : res[RIGHT].text
      const r2 = r1IsLeft ? res[RIGHT].text : res[LEFT].text
      const jr = callLLM(judgePrompt(sc, r1, r2), `${i}J`)
      const pj = jr.ok ? parseJudge(jr.text) : { better: null, stuffed: 0, reason: `判分调用失败: ${jr.error}` }
      // 把 1/2 映射回左/右臂
      const map = (v) => v === 1 ? (r1IsLeft ? LEFT : RIGHT) : (r1IsLeft ? RIGHT : LEFT)
      const betterGroup = pj.better === null ? null : map(pj.better)
      const stuffedGroup = pj.stuffed === 0 ? null : map(pj.stuffed)
      blind = {
        r1IsLeft, betterGroup, stuffedGroup, reason: pj.reason,
        raw: jr.text, ms: jr.ms,
      }
      console.log(`    盲评：更像人=${betterGroup ?? '?'}｜硬塞=${stuffedGroup ?? '无'}｜${pj.reason.slice(0, 40)}`)
    }

    rows.push({
      index: i, kind: sc.kind, from: sc.from, qq: sc.qq, text: sc.text, note: sc.note,
      order,
      // 左臂=不注入（基线），右臂=注入。字段名 arm 里取，避免写死。
      left: { ok: res[LEFT]?.ok, text: res[LEFT]?.text ?? '', error: res[LEFT]?.error, ms: res[LEFT]?.ms },
      right: { ok: res[RIGHT]?.ok, text: res[RIGHT]?.text ?? '', error: res[RIGHT]?.error, ms: res[RIGHT]?.ms },
      leftLexHits: leftHits, rightLexHits: rightHits,
      // 净增量（右臂说了左臂没说的）—— 结论以它为准
      netLexHits: rightHits.filter(w => !leftHits.includes(w)),
      blind,
    })
  }

  // ── 汇总 ──
  //
  // ⚠️ 关键口径（第一版踩过）：不能只数「B 组回复里出现了多少 lexicon 词」——
  //    第 1 条试跑时 A 组（没注入）也说了「摸鱼」，因为那是模型本来就会用的通用词。
  //    把这种算成「lexicon 生效」是假阳性。
  //    所以拆成两个数：
  //      · rawHits   —— 字面命中 lexicon 词条（含模型自己也会说的通用词）
  //      · netHits   —— **只有 B 组说了、A 组没说**的词（这才是注入带来的净增量）
  //    结论以 netHits 为准，rawHits 只作参考。
  const okRows = rows.filter(r => r.left?.ok && r.right?.ok)
  // 净增量：右臂有、左臂无（逐条比，避免「左臂在别的条里说过」这种跨条抵消）
  const netRows = okRows.map(r => {
    const lSet = new Set(r.leftLexHits ?? [])
    return (r.rightLexHits ?? []).filter(w => !lSet.has(w))
  })
  const rightWithLex = okRows.filter(r => (r.rightLexHits?.length ?? 0) > 0)
  const leftWithLex = okRows.filter(r => (r.leftLexHits?.length ?? 0) > 0)
  const judged = okRows.filter(r => r.blind?.betterGroup)
  const leftWins = judged.filter(r => r.blind.betterGroup === ARMS[arm].left).length
  const rightWins = judged.filter(r => r.blind.betterGroup === ARMS[arm].right).length
  const stuffRight = okRows.filter(r => r.blind?.stuffedGroup === ARMS[arm].right).length
  const stuffLeft = okRows.filter(r => r.blind?.stuffedGroup === ARMS[arm].left).length
  // 平衡证明：盲评里「回复1」是左臂/右臂各几条；调用顺序先左/先右各几条
  const r1AsLeft = okRows.filter(r => r.blind?.r1IsLeft === true).length
  const r1AsRight = okRows.filter(r => r.blind?.r1IsLeft === false).length
  const orderLR = rows.filter(r => r.order?.[0] === ARMS[arm].left).length
  const orderRL = rows.filter(r => r.order?.[0] === ARMS[arm].right).length

  const summary = {
    arm,
    armLabel: ARMS[arm].label,
    n: rows.length,
    okPairs: okRows.length,
    withLexiconBlock: lexBlock.length,
    lexiconTotal: (JSON.parse(fs.readFileSync(LEXICON, 'utf8')).entries ?? []).length,
    injectedEntries: arm === 'base'
      ? (JSON.parse(fs.readFileSync(LEXICON, 'utf8')).entries ?? []).length
      : (JSON.parse(fs.readFileSync(LEXICON, 'utf8')).entries ?? []).filter(e => e.source === 'group').length,
    // 维度1：用词（字面命中，含通用词）
    rightUsedWord: rightWithLex.length,
    rightUsedWordRate: okRows.length ? +(rightWithLex.length / okRows.length).toFixed(3) : 0,
    leftUsedWord: leftWithLex.length,
    leftUsedWordRate: okRows.length ? +(leftWithLex.length / okRows.length).toFixed(3) : 0,
    rightLexWordsUsed: [...new Set(okRows.flatMap(r => r.rightLexHits ?? []))],
    leftLexWordsUsed: [...new Set(okRows.flatMap(r => r.leftLexHits ?? []))],
    // 主口径：注入带来的净增量
    netWordsUsed: [...new Set(netRows.flat())],
    rowsWithNetWord: netRows.filter(w => w.length > 0).length,
    rowsWithNetWordRate: okRows.length ? +(netRows.filter(w => w.length > 0).length / okRows.length).toFixed(3) : 0,
    // 维度3：盲评
    judged: judged.length,
    leftWins, rightWins, tie: judged.length - leftWins - rightWins,
    // 维度2：硬塞
    stuffedInRight: stuffRight, stuffedInLeft: stuffLeft,
    // 随机化/平衡证明
    balance: {
      blindR1IsLeft: r1AsLeft, blindR1IsRight: r1AsRight,
      callOrderLeftFirst: orderLR, callOrderRightFirst: orderRL,
      note: '每条用哈希排序后对半分配（不是逐条抛硬币）：保证盲评位置与调用顺序都不成组偏向一侧',
    },
    totalMs: Date.now() - t0,
    model: 'trae/glm-5.3-flashx（经 reflection_llm.mjs）',
    caveat: [
      `n=${okRows.length}，单次采样、样本量小 —— 只能看方向，不能做统计显著性。`,
      '语境是 reflection 薄壳（无记忆/情绪/精力/风格锚），测的是 lexicon 单项净效应，不是生产桥整体。',
      '判分模型与生成模型同款（glm-5.3-flashx），有同源偏好。',
      arm === 'group-only'
        ? '本臂是**消融**：只注入 group 来源字条，用来区分「注入本身」与「B站语料串味」。'
        : 'B站来源占词库多数，结论需结合 --arm group-only 消融一起看。',
    ],
  }

  const out = {
    generatedAt: new Date().toISOString(),
    design: {
      arm,
      groups: `${ARMS[arm].left}=不注入（基线）｜${ARMS[arm].right}=${ARMS[arm].label}，其余完全一致`,
      corpus: 'qq-agent/memory/log/*.jsonl 真实群聊消息（人工按场景挑选，原文照抄）',
      randomization: '哈希排序后对半分配，见每条 order / blind.r1IsLeft 与 summary.balance',
      isolation: `中间文件在 ${TMP}；未读写 state.json / mem.db`,
    },
    lexicalBlock: lexBlock,
    summary,
    rows,
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  // 分臂落盘：两个臂的结果不能互相覆盖（要先跑 base 再跑 group-only，两份都要留）
  const outPath = arm === 'base' ? OUT : OUT.replace(/\.json$/, `-${arm}.json`)
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8')

  const L = ARMS[arm].left, R = ARMS[arm].right
  console.log(`\n=== 汇总（${ARMS[arm].label}）===`)
  console.log(`成功配对 ${summary.okPairs}/${summary.n}｜注入 ${summary.injectedEntries} 条｜用时 ${(summary.totalMs / 1000 / 60).toFixed(1)} 分钟`)
  console.log(`字面命中（含模型本来就会说的通用词）`)
  console.log(`  ${R}：${summary.rightUsedWord}/${summary.okPairs}（${(summary.rightUsedWordRate * 100).toFixed(0)}%）→ ${summary.rightLexWordsUsed.join('、') || '无'}`)
  console.log(`  ${L}：${summary.leftUsedWord}/${summary.okPairs}（${(summary.leftUsedWordRate * 100).toFixed(0)}%）→ ${summary.leftLexWordsUsed.join('、') || '无'}`)
  console.log(`净增量（${R} 说了 ${L} 没说的，主口径）`)
  console.log(`  ${summary.rowsWithNetWord}/${summary.okPairs} 条（${(summary.rowsWithNetWordRate * 100).toFixed(0)}%）→ ${summary.netWordsUsed.join('、') || '无'}`)
  console.log(`盲评更像人：${L} ${summary.leftWins} / ${R} ${summary.rightWins} / 平 ${summary.tie}（判了 ${summary.judged} 条）`)
  console.log(`盲评判为硬塞：${L} ${summary.stuffedInLeft} 次 / ${R} ${summary.stuffedInRight} 次`)
  console.log(`平衡性：回复1是${L} ${r1AsLeft} 条、是${R} ${r1AsRight} 条；先跑${L} ${orderLR} 条、先跑${R} ${orderRL} 条`)
  console.log(`\n结果已写入 ${outPath}`)
}

main().catch(e => { console.error('崩溃:', e); process.exit(1) })
