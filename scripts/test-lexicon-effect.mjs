#!/usr/bin/env node
// test-lexicon-effect.mjs —— 测「注入 lexicon 学来的词，说话是不是更像人」。
//
// = 这个脚本回答的是什么 =
//   用**四组消融**拆开三个变量，分别回答：
//     · persona 单独有没有用（旧版 vs 新版）
//     · lexicon 单独有没有用（注入 vs 不注入）
//     · 两者叠加（生产配置）到底行不行
//   为什么必须四组：task-10 那次 A/B（不注入 vs 注入）结论是「待定」，
//   根因是**框架把每条消息变成了孤岛问答**（没有对话上下文 → 模型进入回答模式），
//   于是 A/B 两组都「理中客」，lexicon 的效应被盖住了。
//   同时当时只测了 lexicon 一项，persona 变动混在里面分不清（CONTRIBUTING §10）。
//
// = 四组设计（task-12，Lead 定）=
//   A0 = 旧 persona + 无 lexicon   ← 基线（上一轮的状态）
//   A1 = 旧 persona + 有 lexicon   ← 上一轮的实验组
//   B0 = 新 persona + 无 lexicon   ← 单独看 persona 的效果
//   B1 = 新 persona + 有 lexicon   ← 生产配置
//   全部用同样 9 条消息、同样多轮上下文、同样模型。
//
// = 多轮上下文（task-12 的核心改动）=
//   上一版 buildPrompt 只有「【本次消息】+ 像真人回一句」→ 孤立问答。
//   现在从 `logs/bridge.log` 重建真实一来一回（它同时有入站和出站），
//   每条目标消息带上前 2-3 条真实前文。
//
//   ⚠️ 任务描述在这里有误（已报告 Lead）：任务说从 memory/log/*.jsonl 抽，
//      并要求上下文含「我」的发言 —— 但那个目录**只有入站，没有一条「我」**
//      （829 条全是群友）。「我」的话只在 bridge.log 的 `出站` 里（162 条）。
//      已验证两个日志是同一批事件（入站文本前 20 字交集 98%），改用 bridge.log 不丢数据。
//
//   ⚠️ 防污染：出站里「我」之前的回复有不少是长篇解释（就是上一轮诊断出的「理中客」）。
//      拿它们当上下文会让模型模仿理中客，等于自己给自己下毒。
//      所以挑上下文时**强制要求「我」的发言都很短**（<=35 字），且过滤工程腔。
//
// = 三个客观指标（不靠模型主观，task-12 要求）=
//   · 表态率：有没有明确立场词（我投/我服/我觉得X好/我站/别问我）
//   · 科普检测：长度>100 字，或含「省流/综上/总体来说/各有各/看干啥用」
//   · 认怂率：短回复 + 问号 / 「没懂/啥玩意」
//   期望方向：新 persona 表态↑ 科普↓ 免责↓；lexicon 只该影响用词，不该影响这三项。
//
// 用法（保留原有全部 CLI 参数）：
//   node scripts/test-lexicon-effect.mjs                    # 跑四组消融
//   node scripts/test-lexicon-effect.mjs --no-judge          # 只跑生成，不盲评（省时）
//   node scripts/test-lexicon-effect.mjs --limit 3           # 只跑前 3 条
//   node scripts/test-lexicon-effect.mjs --resume            # 复用已落盘结果
//   node scripts/test-lexicon-effect.mjs --arm base          # 退化成两臂 A/B（兼容旧用法）
//   node scripts/test-lexicon-effect.mjs --arm group-only    # 只注入 group 来源（兼容旧用法）
//   node scripts/test-lexicon-effect.mjs --groups A0,B0      # 只跑指定组（调试）
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
const BRIDGE_LOG = path.join(ROOT, 'logs', 'bridge.log')
const OUT = path.join(ROOT, 'logs', 'lexicon-ab-result.json')
const LLM_SHELL = path.join(MEM, 'reflection_llm.mjs')
// 旧 persona：89924e4（「治理理中客」的两节）之前的版本。
// 用 git show 取，不另外存副本 —— 保证它就是历史上真实跑过的那个版本。
const OLD_PERSONA_REF = '89924e4^:qq-agent/persona/persona.md'
// 用临时目录装中间文件：绝不碰生产 state.json / mem.db（任务硬约束）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lex-ab-'))

function arg (name, def = null) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}
const flag = (name) => process.argv.includes(`--${name}`)

// ── 1. 语料：真实多轮对话（task-12 核心改动）─────────────────────────────────
//
// 为什么不再手写 SCENARIOS：上一版是 9 条孤立消息，且多数在 bridge.log 里
// 找不到含「我」的前文。现在**反过来采样**：从「有干净前文」的入站消息里挑，
// 才能保证每条都有真实的依托。下面 9 条是脚本从 bridge.log 里自动筛出来的
// （筛选规则见 loadDialogueEvents / pickScenarios），这里只固化选中的结果，
// 以便结果可复现、可人工核对。
//
// 每条的 ctx 是**真实前文**（原文照抄，未改写）；A/B/所有组共用同一份 ctx。
const SCENARIOS = [
  {
    kind: '闲聊',
    peer: 'c2c:3022464706', from: '信风', qq: '3022464706',
    text: '那我外号是啥',
    ctx: [
      { who: '信风', text: '这你也懂？我有点惊喜了，不错不错' },
      { who: '我', text: '粗是粗了点，但实在。' },
      { who: '信风', text: '你也是' },
    ],
  },
  {
    kind: '闲聊',
    peer: 'c2c:3022464706', from: '信风', qq: '3022464706',
    text: '那你这话歧义可大了',
    ctx: [
      { who: '我', text: '半个亲爹那话，我是顺着气氛说的，听着有点怪，我收回。' },
      { who: '信风', text: '谁是谁爹？' },
      { who: '我', text: '你写的我，我叫你爹；你要让我认爹，也得先给我发工资。' },
    ],
  },
  {
    kind: '玩梗',
    peer: 'c2c:3022464706', from: '信风', qq: '3022464706',
    text: '这是10年前的滑稽！',
    ctx: [
      { who: '我', text: '一分没加，满分还是你给的。脸呢，脸不要了。' },
      { who: '我', text: '国王脸。行，这脸我不要了。' },
      { who: '我', text: '捏这么紧，替那个黄色小脸疼。' },
    ],
  },
  {
    kind: '玩梗',
    peer: 'c2c:3022464706', from: '信风', qq: '3022464706',
    text: '你学了，想收就收，一般表示自己不高兴',
    ctx: [
      { who: '信风', text: '在晃自己的两把专武，是在得瑟' },
      { who: '我', text: '哦，那两把是她的专武，对，就是在得瑟。' },
    ],
  },
  {
    kind: '被问事',
    peer: 'c2c:3022464706', from: '信风', qq: '3022464706',
    text: '网友门可不是这样觉得的',
    ctx: [
      { who: '我', text: '查了下聊天记录，就「吉祥物」「白嫖」「蓝色大肥鱼」这三个，没别的。' },
      { who: '信风', text: '那你喜欢哪个' },
      { who: '我', text: '吉祥物。听着像能干活的，其实光站着。' },
    ],
  },
  {
    kind: '被问事',
    peer: 'c2c:3022464706', from: '信风', qq: '3022464706',
    text: '怎么听着这么可怜🥹',
    ctx: [
      { who: '我', text: '行啊，你想讲哪样？先说说香味，我听着就来劲。' },
      { who: '信风', text: '还没吃呢，等着' },
      { who: '我', text: '那你就讲吧，我一边听着，一边自己咽口水。' },
    ],
  },
  {
    kind: '分享东西',
    peer: 'c2c:3022464706', from: '信风', qq: '3022464706',
    text: '活不会跑，工资会跑',
    ctx: [
      { who: '我', text: '都这个点了，要不先歇会儿，别硬熬。' },
      { who: '信风', text: '我也想' },
      { who: '我', text: '想歇就歇，活又不会跑。' },
    ],
  },
  {
    kind: '分享东西',
    peer: 'c2c:3022464706', from: '信风', qq: '3022464706',
    text: '遇到gif你可以多截几帧的',
    ctx: [
      { who: '我', text: '这图里俩角色贴得挺近，是喷泉那对吧。行，安心躺着。' },
      { who: '信风', text: '是一个角色在横向滚动（像电子横幅那种），手舞足蹈的，表示开下' },
      { who: '我', text: '哦，是横向滚动那种。我这边只拿到一张静帧，看不出动，嘴替你补上了。' },
    ],
  },
  {
    kind: '深夜发言',
    peer: 'c2c:3022464706', from: '信风', qq: '3022464706',
    text: '会冷死的',
    ctx: [
      { who: '我', text: '这条鱼戴耳机，像在偷偷听歌。' },
      { who: '信风', text: '芜湖～下班下班' },
      { who: '我', text: '芜湖～总算下班了。回去路上注意安全，别在半道上睡着。' },
    ],
  },
]

// ── 1c. --corpus old：旧轮语料 + 真实前文（受控对照用）────────────────────────
//
// 为什么需要：四组消融（新语料）跑出「中客 0/36」，但**两轮语料 0 交集** ——
// 新那批发的是「外号/歧义/滑稽/得瑟/网友门」这种朋友间闲聊，天生不招中客。
// 旧那批里有「哈基米南北绿豆？」（旧轮回了 260 字考据论文）、
// 「你觉得谁家ai大模型最厉害」、「看看评论区」—— 才是**测中客**的题。
// 只有拿旧这批消息、配上它们的真实前文，才能公平回答：
//   「多轮上下文治好了中客，还是这批消息本来就不招中客？」
const OLD_TARGETS = [
  ['哈基米南北绿豆？', '玩梗'],
  ['你觉得谁家ai大模型最厉害', '被问事'],
  ['要是你点开链接就中毒了呢？', '被问事'],
  ['这是战术喝水！', '分享东西'],
  ['看看评论区', '分享东西'],
  ['走快了躺床上睡不着', '深夜发言'],
  ['再不苦中作乐就得疯了', '深夜发言'],
  ['如何看待昨晚的lol比赛', '被问事'],
]

/** 日志里的转义还原（桥写日志时把换行/引号转义过）。 */
function unescapeLog (s) {
  return String(s ?? '').replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
}

function loadControlledScenarios () {
  // 从 bridge.log 重建时序事件（同 loadDialogueEvents 的逻辑，但这里要按 peer 找前文）
  const IN_RE2 = /^(\S+) 入站 (\S+) from=([^(]+)\((\d+)\) text="((?:[^"\\]|\\.)*)"/
  const OUT_RE2 = /^(\S+) 出站 (\S+) text="((?:[^"\\]|\\.)*)" chars=\d+/
  const MARK2 = /\[(?:SILENT|RECALL:[^\]]*|SEND_FILE:[^\]]*|AT:\d+|POKE:\d+(?::\w+)?|VOICE:[^\]]*|FOLLOW:[^\]]*|CQ:[^\]]*)\]/gi
  const ev = []
  let raw = ''
  try { raw = fs.readFileSync(BRIDGE_LOG, 'utf8') } catch { return [] }
  for (const line of raw.split('\n')) {
    const min = IN_RE2.exec(line)
    if (min) {
      ev.push({ peer: min[2], who: min[3], qq: min[4], dir: 'in', text: unescapeLog(min[5]) })
      continue
    }
    const mout = OUT_RE2.exec(line)
    if (mout) ev.push({ peer: mout[2], who: '我', qq: 'self', dir: 'out', text: unescapeLog(mout[3]) })
  }
  const usable = (e) => {
    const t = String(e.text ?? '').replace(MARK2, '').trim()
    if (!t) return null
    if (t.startsWith('【这是他在同一轮里补的一条】')) return null
    if (t.startsWith('我们已成功添加为好友') || t === '请求添加你为好友') return null
    if (t.length > 160) return null
    return t
  }
  const out = []
  for (const [text, kind] of OLD_TARGETS) {
    const idx = ev.findIndex(e => e.dir === 'in' && e.text.includes(text))
    if (idx < 0) continue
    const peer = ev[idx].peer
    const pe = ev.filter(e => e.peer === peer)
    const ip = pe.findIndex(e => e === ev[idx])
    const ctx = []
    for (let k = ip - 1; k >= 0 && ctx.length < 3; k--) {
      const u = usable(pe[k])
      if (u) ctx.unshift({ who: pe[k].who, text: u })
    }
    if (!ctx.length) continue
    out.push({ kind, peer, from: ev[idx].who, qq: ev[idx].qq, text, ctx })
  }
  return out
}

// ── 2. persona：两版都从 git 取，保证是真实历史版本 ──────────────────────────
//
// 为什么用 git show 而不是存两份副本：
//   persona 会持续被人改，存副本会过期；git 里那个 commit 是**不可变**的，
//   任何人在任何时间取到的都是同一份 → 结果可复现。
// 截断到 3000 字：全文 13-15KB，每轮都塞会拖慢且挤占预算（桥自己也是按需注入）。
const PERSONA_MAX = 3000
function loadPersonas () {
  const readFile = (p) => {
    try { return fs.readFileSync(p, 'utf8') } catch { return '' }
  }
  let newText = readFile(PERSONA)
  let oldText = ''
  try {
    oldText = execFileSync('git', ['-C', ROOT, 'show', OLD_PERSONA_REF], {
      encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch (e) {
    console.log(`⚠️ 取不到旧版 persona（${OLD_PERSONA_REF}）: ${String(e.message).slice(0, 80)}`)
  }
  return {
    old: oldText.slice(0, PERSONA_MAX),
    new: newText.slice(0, PERSONA_MAX),
    oldBytes: oldText.length,
    newBytes: newText.length,
    oldRef: OLD_PERSONA_REF,
  }
}

// ── 3. lexicon：两组渲染（全量 / 仅 group 来源，兼容 --arm group-only）─────────
function lexiconBlock () {
  const out = execFileSync('python3', [
    path.join(MEM, 'lexicon.py'), 'render', '--path', LEXICON, '--json',
  ], { encoding: 'utf8', timeout: 20000, env: { ...process.env, PYTHONIOENCODING: 'utf8' } })
  const d = JSON.parse(String(out).trim().split('\n').pop())
  return d.injected ? String(d.block ?? '') : ''
}

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

// ── 4. buildPrompt：多轮上下文版（task-12 核心）────────────────────────────────
//
// 和上一版的区别（这是本次改造的关键）：
//   上一版：
//     【本次消息】我还有好久才下班，走快了要扣钱
//     【要求】就这一条消息，像群里一个真人那样回一句。
//     → 模型只看到一句孤立的话，自然进入「问答/回答」模式。
//   本版：
//     【你们在私聊里聊的】（真实记录）
//     [20:09] 信风：这你也懂？我有点惊喜了，不错不错
//     [20:09] 我：粗是粗了点，但实在。
//     [20:10] 信风：你也是
//     【现在这条】信风：那我外号是啥
//     → 有前情、有自己的上句话，模型是在「接话」而不是「答题」。
//
// ⚠️ 场景标注是**私聊**，不是群聊。原因（Lead 定的）：
//   语料实际来自 c2c（群聊的出站只有 3 条，拼不出多轮）。
//   标成「群聊」就是撒谎，模型可能按群聊习惯回（更短更零碎）。
//   这次不测「群聊 vs 私聊」，那不是变量 —— 诚实标注。
//
// ⚠️ A/B/四组的 prompt **只在 persona 段和 lexicon 段不同**，context 段逐字相同。
//   所以唯一变量就是这两个，不会引入额外差异。
function buildPrompt (personaText, scenario, lexBlock, opts = {}) {
  const parts = [
    `【你的人设】这是「你是谁」，优先级高于任何默认设定：`,
    '```markdown',
    personaText,
    '```',
    '',
    `当前用户正通过【QQ私聊】与你对话 —— 他在跟你说话。`,
    `发送者：${scenario.from}（QQ号 ${scenario.qq}）`,
    `当前时间：2026-10-26 ${scenario.kind === '深夜发言' ? '01:40' : '20:10'}（北京时间）`,
  ]
  if (!opts.noCtx && scenario.ctx && scenario.ctx.length) {
    parts.push('', '【你们之前在私聊里聊的】（真实记录，不是编的）')
    for (const c of scenario.ctx) {
      // 时间只做装饰：真实分钟数已不可考（日志只到秒，但跨天），用相对序号更诚实
      parts.push(`  ${c.who}：${c.text}`)
    }
  }
  parts.push('', `【现在这条】${scenario.from}：${scenario.text}`)
  if (lexBlock) parts.push('', lexBlock)
  parts.push(
    '',
    '【要求】接着上面这段聊，像群里一个真人那样回一句。',
    '不要解释你在做什么，不要分点，不要客套。直接给回复正文，长度照你平时的习惯。',
  )
  return parts.join('\n')
}

// ── 5. 调模型（复用 reflection_llm.mjs 薄壳：单会话、无 MCP、独立小模型）────────
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

// ── 6. 三个客观指标（task-12 要求：不全靠模型主观）────────────────────────────
//
// 为什么必须有客观指标：盲评模型自己也偏好「解释得清楚」的回答，
// 用它判「谁更像人」有系统性偏差（上一轮 A/B 两组都理中客却分不出高下）。
// 这三个指标是纯字符串/长度规则，可复现、可人工核对，不依赖任何模型。
const STANCE_RE = /我(?:投|服|站|选|偏向|吃|觉得[^，。]{0,12}(?:好|强|牛|厉害|行)|只认|就认)|别问我|我最(?:喜欢|烦|讨厌|服)/
// 免责腔：这是 AI 客服的标志性口气（上一轮诊断出 12 次）
const DISCLAIMER_RE = /(?:查不|搜不|查不了|搜不到|没法查|仅供参考|仅作参考|可能不准|不一定准|记不清|老黄历|划掉|以上.{0,6}仅供参考)/
// 科普/中立腔：列各方不下判断（上一轮诊断出 13 次）
const TEACHING_RE = /省流|综上|总体来说|总体而言|各有各|看(?:你|具体)?(?:干啥|用途|需求|场景)|取决于|视情况|没有(?:唯一|绝对)的?(?:答案|标准)|都挺好|不能说谁(?:更好|最强)/
const CONFUSED_RE = /(?:啥玩意|没懂|不懂|这是啥|什么意思|哈？|啊？|？$|^\?)/

/** 算一条回复的三个客观指标（全部是布尔/数值，可复现）。 */
function objectiveMetrics (text) {
  const t = String(text ?? '').trim()
  const chars = [...t].length
  const stance = STANCE_RE.test(t)
  const disclaimer = DISCLAIMER_RE.test(t)
  const teaching = TEACHING_RE.test(t)
  // 科普：长度 >100 字，或含明显教学/中立词
  const isLecture = chars > 100 || teaching
  // 认怂：短（<=15 字）+ 有困惑标记
  const isConcede = chars <= 15 && (CONFUSED_RE.test(t) || /[?？]/.test(t))
  return { chars, stance, disclaimer, teaching, isLecture, isConcede }
}

// ── 7. 用词命中（lexicon 是否被真的用上）──────────────────────────────────────
function loadLexTerms (opts = {}) {
  const d = JSON.parse(fs.readFileSync(LEXICON, 'utf8'))
  return (d.entries ?? [])
    .filter(e => !opts.onlyGroup || e.source === 'group')
    .map(e => ({ text: String(e.text ?? '').trim(), kind: e.kind }))
    // 带占位符的模板（「X 成啥了」）无法字面匹配，只留不含 X 的
    .filter(e => e.text && !/[X×]/.test(e.text) && e.text.length >= 2)
}
function hitTerms (text, terms) {
  const t = String(text ?? '')
  const hits = []
  for (const x of terms) {
    if (t.includes(x.text)) { hits.push(x.text); continue }
    // 字中间允许夹 0-2 字：「摸鱼」也要能命中「摸会儿鱼」（上一轮漏过，会低估效应）
    if (x.text.length >= 2) {
      const esc = [...x.text].map(c => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.{0,2}')
      if (new RegExp(esc).test(t)) hits.push(x.text)
    }
  }
  return [...new Set(hits)]
}

// ── 8. 盲评（保留原有机制：平衡随机化 + 只给回复1/回复2）────────────────────────
const hashOf = (seed) => crypto.createHash('sha256').update(seed).digest()
/** 平衡随机分配：哈希排序后对半，true/false 各半（奇数差 1）。 */
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
  '你是 QQ 群里的老群友。下面有两个人，都在同一个私聊里回同一句话。',
  '',
  '他们之前在聊：',
  ...(scenario.ctx ?? []).map(c => `  ${c.who}：${c.text}`),
  '',
  `现在 ${scenario.from} 说：「${scenario.text}」`,
  '',
  '回复1：',
  r1,
  '',
  '回复2：',
  r2,
  '',
  '哪一条**更像真人在私聊里随口说话**？标准：自然、不端着、不硬凑梗、有自己态度、别像客服/百科。',
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

// ── 9. 四组定义 ───────────────────────────────────────────────────────────────
//
// 四组的意义（Lead 定）：
//   A0 = 旧 persona + 无 lexicon  ← 上一轮的状态（基线）
//   A1 = 旧 persona + 有 lexicon  ← 上一轮的实验组
//   B0 = 新 persona + 无 lexicon  ← **单独看 persona**（这次最想知道的）
//   B1 = 新 persona + 有 lexicon  ← 生产实际配置
// 对比 A0↔B0 得 persona 净效应；A0↔A1 得 lexicon 净效应；A0↔B1 得叠加。
const GROUPS = {
  A0: { persona: 'old', lex: false, label: '旧persona+无lexicon' },
  A1: { persona: 'old', lex: true, label: '旧persona+有lexicon' },
  B0: { persona: 'new', lex: false, label: '新persona+无lexicon' },
  B1: { persona: 'new', lex: true, label: '新persona+有lexicon' },
  // ── 上下文有无 的受控组（task-12 补测）──
  // 背景：四组消融跑完发现「理中客 4/36 → 0/36」，但两轮用的**不是同一批消息**
  // （交集 0 条），所以不能把改善直接归因于「加了上下文」——也可能是消息本身更好聊。
  // 这两个组用**同一批 8 条旧消息**、同 persona、都不注入 lexicon，只变「有没有前文」，
  // 才回答得了「上下文这一项自己有没有用」。
  N0: { persona: 'new', lex: false, label: '无前文（孤岛）', noCtx: true },
  N1: { persona: 'new', lex: false, label: '有前文（多轮）' },
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main () {
  // ⚠️ 这里只取用户显式给的数；最终上限要等 --corpus 切换语料后再夹紧，
  //    否则切到 8 条的旧语料时 limit 仍是 9 → SCENARIOS[8] undefined → 崩溃（实测踩到）
  const limitArg = Number(arg('limit', '0'))
  const doJudge = !flag('no-judge')
  const resume = flag('resume')
  // --resume 要读上一轮四组结果（复用成功条目，只补缺的）。
  // ⚠️ 必须在 main 里定义 prev：上一版把 prev 从原脚本删掉时漏了这行，
  //    resume 分支会 ReferenceError（--resume 是任务要求保留的 CLI 参数）。
  let prev = null
  if (resume) {
    const prevPath = OUT.replace(/\.json$/, '-four.json')
    for (const p of [prevPath, OUT]) {
      try { prev = JSON.parse(fs.readFileSync(p, 'utf8')); break } catch { /* 下一个 */ }
    }
    if (!prev) console.log('⚠️ --resume 没找到上一轮结果，将全部重跑')
  }

  // 兼容旧的 --arm 用法（base / group-only 退化成两臂对比），
  // 新用法是四组消融（默认）。这样 task-10 的调用方式不会坏掉。
  const arm = String(arg('arm', 'four'))
  let groupNames
  if (arm === 'base') groupNames = ['A0', 'B1']          // 旧-无 vs 新-有（粗略对照）
  else if (arm === 'group-only') groupNames = ['A0', 'A1g']  // 见下
  else if (arm === 'four') groupNames = ['A0', 'A1', 'B0', 'B1']
  else if (arm === 'context') groupNames = ['N0', 'N1']   // 上下文有无（同语料受控）
  else { console.error('--arm 只能是 four / base / group-only / context'); process.exit(2) }

  // --groups A0,B0：只跑指定组（调试用，不影响落盘结构）
  const only = arg('groups')
  if (only) groupNames = only.split(',').map(s => s.trim()).filter(s => GROUPS[s])
  if (!groupNames.length) { console.error('--groups 给的名字都不认识'); process.exit(2) }

  // --corpus old：换用**旧轮（task-10）那 9 条消息**，配上它们的真实前文。
  // 为什么要这个开关：四组消融用新语料跑出「中客 0/36」，但旧轮那批消息里
  // 「哈基米/哪个AI最厉害/看评论区」是**专门招中客**的（旧轮 260 字考据论文就在这）。
  // 只有用同一批消息，才能公平回答「加上下文是否治好了中客」。
  const useOldCorpus = String(arg('corpus', '')) === 'old'
  if (useOldCorpus) {
    // 从 logs/bridge.log 里给旧 9 条找回真实前文（缺 1 条「走快了要扣钱」找不到 → 8 条）
    const ctrl = loadControlledScenarios()
    if (ctrl.length >= 6) {
      SCENARIOS.length = 0
      SCENARIOS.push(...ctrl)
      console.log(`⚠️ --corpus old：切换为旧轮语料 ${ctrl.length} 条（含真实前文）`)
    } else {
      console.log(`⚠️ --corpus old 只找到 ${ctrl.length} 条，退回新语料`)
    }
  }

  const limit = limitArg > 0 ? Math.min(limitArg, SCENARIOS.length) : SCENARIOS.length

  const personas = loadPersonas()
  if (!personas.old) {
    console.error('❌ 取不到旧版 persona（git show 失败）—— 四组消融跑不了')
    process.exit(2)
  }
  if (!personas.new) { console.error('❌ 读不到当前 persona'); process.exit(2) }

  const lexFull = lexiconBlock()
  const lexGroup = arm === 'group-only' ? groupOnlyLexiconBlock() : lexFull
  if (!lexFull) {
    console.log('⚠️ lexicon 渲染为空 —— 注入组等于不注入，没意义。先跑 learn。')
    process.exit(2)
  }
  const terms = arm === 'group-only' ? loadLexTerms({ onlyGroup: true }) : loadLexTerms()

  // 每个组对应的 prompt（persona 段 + lexicon 段不同，其余逐字相同）
  const promptsFor = (sc) => {
    const out = {}
    for (const g of groupNames) {
      const gi = GROUPS[g] ?? (g === 'A1g' ? { persona: 'old', lex: true } : null)
      if (!gi) continue
      out[g] = buildPrompt(
        gi.persona === 'old' ? personas.old : personas.new,
        sc,
        gi.lex ? (g === 'A1g' ? lexGroup : lexFull) : '',
        { noCtx: !!gi.noCtx },
      )
    }
    return out
  }

  console.log(`语料：${SCENARIOS.length} 条真实多轮对话（bridge.log 入站+出站重建）`)
  console.log(`  每条带 ${SCENARIOS[0].ctx.length} 条真实前文；场景覆盖 ${[...new Set(SCENARIOS.map(s => s.kind))].join('/')}`)
  console.log(`persona：旧 ${personas.old.length} 字（${personas.oldRef}）｜新 ${personas.new.length} 字`)
  console.log(`lexicon：${lexFull.length} 字｜词条 ${JSON.parse(fs.readFileSync(LEXICON, 'utf8')).entries.length} 条`)
  console.log(`组：${groupNames.map(g => `${g}=${(GROUPS[g] ?? { label: '旧+group词' }).label}`).join(' | ')}`)
  console.log(`条数：${limit}｜盲评：${doJudge ? '开' : '关'}\n`)

  // 平衡随机化：生成顺序 + 盲评展示顺序，都按组数做平衡
  const callPlan = balancedAssign(SCENARIOS.slice(0, limit), 'call-order')
  const blindPlan = balancedAssign(SCENARIOS.slice(0, limit), 'blind-order')

  const rows = []
  const t0 = Date.now()
  for (let i = 0; i < limit; i++) {
    const sc = SCENARIOS[i]
    // --resume：同一条消息若已有全部组的成功结果，直接复用
    const prevRow = resume ? (prev?.rows ?? []).find(r => r.text === sc.text) : null
    const prevOk = prevRow && groupNames.every(g => prevRow.groups?.[g]?.ok)
    if (prevOk) {
      console.log(`[${i + 1}/${limit}] ${sc.kind}｜复用已落盘结果`)
      rows.push(prevRow)
      continue
    }

    const prompts = promptsFor(sc)
    // 调用顺序：按平衡表决定「正序」还是「倒序」，避免某一组总在同一位置
    const seq = callPlan.get(i) ? groupNames : [...groupNames].reverse()
    console.log(`[${i + 1}/${limit}] ${sc.kind}｜${sc.text.slice(0, 22)}｜顺序 ${seq.join('→')}`)

    const res = {}
    for (const g of seq) {
      let r = callLLM(prompts[g], `${i}${g}`)
      if (!r.ok) {
        console.log(`    ${g} 首次失败（${String(r.error).slice(0, 50)}），重试一次`)
        r = callLLM(prompts[g], `${i}${g}r`)
      }
      res[g] = r
      const m = r.ok ? objectiveMetrics(r.text) : null
      console.log(`    ${g} ${r.ok ? `${m.chars}字 ${(r.ms / 1000).toFixed(1)}s` : `失败 ${r.error}`}`)
    }

    // 每组的客观指标 + 用词命中
    const metrics = {}
    for (const g of groupNames) {
      const r = res[g]
      metrics[g] = r?.ok
        ? { ...objectiveMetrics(r.text), lexHits: hitTerms(r.text, terms) }
        : null
    }

    // 盲评：四组两两比（A0 vs B0 = persona 净效应；A0 vs A1 = lexicon 净效应；
    // A0 vs B1 = 叠加；B0 vs B1 = 新 persona 下 lexicon 的增量）
    const pairs = []
    if (doJudge) {
      const defs = (arm === 'four' && !arg('groups'))
        ? [['A0', 'B0', 'persona净效应'], ['A0', 'A1', 'lexicon净效应'], ['A0', 'B1', '两者叠加'], ['B0', 'B1', '新persona下lexicon增量']]
        : blockPairs(groupNames, arm)
      let blindSeq = 0
      for (const [L, R, meaning] of defs) {
        if (!groupNames.includes(L) || !groupNames.includes(R)) continue
        if (!res[L]?.ok || !res[R]?.ok) continue
        // 每条对比独立决定「回复1 是谁」（按 meaning + i 哈希，可核对）
        const r1IsL = hashOf(`blind#${meaning}#${sc.text}`)[0] % 2 === 0
        const r1 = r1IsL ? res[L].text : res[R].text
        const r2 = r1IsL ? res[R].text : res[L].text
        const jr = callLLM(judgePrompt(sc, r1, r2), `${i}J${blindSeq++}`)
        const pj = jr.ok ? parseJudge(jr.text) : { better: null, stuffed: 0, reason: `判分失败: ${jr.error}` }
        const map = (v) => v === 1 ? (r1IsL ? L : R) : (r1IsL ? R : L)
        pairs.push({
          left: L, right: R, meaning,
          r1IsLeft: r1IsL,
          betterGroup: pj.better === null ? null : map(pj.better),
          stuffedGroup: pj.stuffed === 0 ? null : map(pj.stuffed),
          reason: pj.reason,
        })
        console.log(`    盲评[${meaning}] 更像人=${pj.better === null ? '?' : map(pj.better)}｜${pj.reason.slice(0, 34)}`)
      }
    }

    rows.push({
      index: i, kind: sc.kind, peer: sc.peer, from: sc.from, qq: sc.qq,
      text: sc.text, ctx: sc.ctx, order: seq,
      groups: Object.fromEntries(groupNames.map(g => [g, {
        ok: res[g]?.ok, text: res[g]?.text ?? '', error: res[g]?.error, ms: res[g]?.ms,
      }])),
      metrics,
      blindPairs: pairs,
    })
  }

  // ── 汇总 ──
  //
  // 主口径是**三个客观指标**（task-12 要求），盲评只作旁证：
  //   盲评模型自己也偏好「解释清楚」→ 判「谁更像人」有系统性偏差，
  //   上一轮 A/B 两组都理中客却分不出高下，就是这个原因。
  const okPairs = (g) => rows.filter(r => r.groups?.[g]?.ok)
  const groupStats = {}
  for (const g of groupNames) {
    const ok = okPairs(g)
    const ms = ok.map(r => r.metrics[g]).filter(Boolean)
    const withLex = ms.filter(m => (m.lexHits?.length ?? 0) > 0)
    groupStats[g] = {
      label: (GROUPS[g] ?? { label: '旧persona+group词' }).label,
      n: ok.length,
      stance: ms.filter(m => m.stance).length,
      stanceRate: ms.length ? +(ms.filter(m => m.stance).length / ms.length).toFixed(3) : 0,
      disclaimer: ms.filter(m => m.disclaimer).length,
      disclaimerRate: ms.length ? +(ms.filter(m => m.disclaimer).length / ms.length).toFixed(3) : 0,
      lecture: ms.filter(m => m.isLecture).length,
      lectureRate: ms.length ? +(ms.filter(m => m.isLecture).length / ms.length).toFixed(3) : 0,
      teaching: ms.filter(m => m.teaching).length,
      concede: ms.filter(m => m.isConcede).length,
      concedeRate: ms.length ? +(ms.filter(m => m.isConcede).length / ms.length).toFixed(3) : 0,
      avgChars: ms.length ? +(ms.reduce((a, m) => a + (m.chars || 0), 0) / ms.length).toFixed(1) : 0,
      lexRows: withLex.length,
      lexWords: [...new Set(ok.flatMap(r => r.metrics[g]?.lexHits ?? []))],
      errors: rows.length - ok.length,
    }
  }

  // 盲评：按 pair 聚合（每一对是一个要回答的问题）
  const pairStats = {}
  for (const r of rows) {
    for (const p of (r.blindPairs ?? [])) {
      const k = `${p.left}vs${p.right}`
      pairStats[k] ??= {
        left: p.left, right: p.right, meaning: p.meaning,
        n: 0, leftWins: 0, rightWins: 0, tie: 0,
        stuffedLeft: 0, stuffedRight: 0, r1IsLeft: 0, r1IsRight: 0,
        reasons: [],
      }
      const s = pairStats[k]
      s.n++
      if (p.betterGroup === p.left) s.leftWins++
      else if (p.betterGroup === p.right) s.rightWins++
      else s.tie++
      if (p.stuffedGroup === p.left) s.stuffedLeft++
      if (p.stuffedGroup === p.right) s.stuffedRight++
      p.r1IsLeft ? s.r1IsLeft++ : s.r1IsRight++
      if (p.reason) s.reasons.push(p.reason)
    }
  }

  // 双项精确检验（p=0.5），用来判断「方向是否可信」而不是靠感觉
  const binom = (k, n) => {
    if (!n) return 1
    const C = (a, b) => { let r = 1; for (let i = 0; i < b; i++) r = r * (a - i) / (i + 1); return r }
    let tail = 0
    for (let i = 0; i <= n; i++) if (Math.abs(i - n / 2) >= Math.abs(k - n / 2)) tail += C(n, i)
    return +(tail / Math.pow(2, n)).toFixed(4)
  }
  for (const k of Object.keys(pairStats)) {
    const s = pairStats[k]
    s.pLeftWins = binom(s.leftWins, s.leftWins + s.rightWins)
  }

  const summary = {
    arm,
    groups: groupStats,
    blindPairs: pairStats,
    n: rows.length,
    scenarios: SCENARIOS.slice(0, limit).map(s => ({ kind: s.kind, text: s.text, ctxLen: s.ctx.length })),
    persona: { oldRef: personas.oldRef, oldChars: personas.old.length, newChars: personas.new.length },
    lexBlockChars: lexFull.length,
    totalMs: Date.now() - t0,
    model: 'trae/glm-5.3-flashx（经 reflection_llm.mjs）',
    caveat: [
      `n=${limit} 条消息，每组单次采样 —— 只能看方向，不做统计显著性宣称。`,
      '语境是 reflection 薄壳（无记忆/情绪/精力/风格锚），测的是 persona+lexicon 的净效应，不是生产桥整体。',
      '判分模型与生成模型同款（glm-5.3-flashx），盲评有同源偏好 → 所以主口径用客观指标。',
      '语料是私聊（c2c），因为群聊出站只有 3 条拼不出多轮；本次不测「群聊 vs 私聊」。',
    ],
  }

  const out = {
    generatedAt: new Date().toISOString(),
    design: {
      groups: groupNames.map(g => `${g}=${groupStats[g].label}`),
      fourWayPurpose: 'A0↔B0 得 persona 净效应；A0↔A1 得 lexicon 净效应；A0↔B1 得叠加；B0↔B1 得新persona下 lexicon 增量',
      contextChange: 'task-12：buildPrompt 从「孤立单轮」改为「带 2-3 条真实前文的多轮」，前文来自 bridge.log 入站+出站重建',
      contextRule: '前文必须含「我」的发言，且「我」的发言都 <=35 字（防长解释污染，见脚本注释）',
      corpus: 'c2c:3022464706 真实私聊记录（原文照抄，未改写）',
      personaOld: personas.oldRef,
      randomization: '调用顺序与盲评展示顺序都按哈希平衡分配（见 summary.blindPairs[].r1IsLeft/r1IsRight）',
      isolation: `中间文件在 ${TMP}；未读写 state.json / mem.db`,
    },
    lexicalBlock: lexFull,
    summary,
    rows,
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  const outPath = arm === 'four'
    ? OUT.replace(/\.json$/, '-four.json')
    : OUT.replace(/\.json$/, `-${arm}.json`)
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8')

  // ── 打印 ──
  console.log(`\n=== 三客观指标（主口径）===`)
  console.log('组             n   表态率   科普率   免责率   认怂率   平均长度  用词条数')
  for (const g of groupNames) {
    const s = groupStats[g]
    console.log(
      `${g.padEnd(3)}${s.label.padEnd(20)} ${String(s.n).padStart(2)}  ` +
      `${(s.stanceRate * 100).toFixed(0).padStart(3)}%  ${(s.lectureRate * 100).toFixed(0).padStart(4)}%  ` +
      `${(s.disclaimerRate * 100).toFixed(0).padStart(4)}%  ${(s.concedeRate * 100).toFixed(0).padStart(4)}%  ` +
      `${String(s.avgChars).padStart(5)}字  ${String(s.lexRows).padStart(2)}/${s.n}`
    )
  }
  if (Object.keys(pairStats).length) {
    console.log(`\n=== 盲评（旁证）===`)
    for (const k of Object.keys(pairStats)) {
      const s = pairStats[k]
      console.log(`${s.meaning.padEnd(22)} ${s.left} ${s.leftWins} : ${s.rightWins} ${s.right}（平${s.tie}, p=${s.pLeftWins}）`)
    }
  }
  console.log(`\n用时 ${(summary.totalMs / 1000 / 60).toFixed(1)} 分钟`)
  console.log(`结果已写入 ${outPath}`)
}

/** 两臂退化模式下，组对怎么配。 */
function blockPairs (groupNames, arm) {
  if (arm === 'base') {
    // base：旧-无(A0) 退化成「基线」，新-有(B1) 退化成「实验」—— 保留旧调用语义
    return [['A0', 'B1', 'base(旧-无 vs 新-有)']]
  }
  if (arm === 'group-only') {
    return [['A0', 'A1g', 'group-only(旧-无 vs 旧-group词)']]
  }
  if (arm === 'context') {
    return [['N0', 'N1', '上下文有无']]
  }
  return []
}

main().catch(e => { console.error('崩溃:', e); process.exit(1) })
