// 风格锚 A/B 实测：同一个真实场景，跑「不注入风格样本」vs「注入风格样本」。
//
// 目的不是跑测试，是回答一个问题：**风格锚到底有没有用**（不是靠嘴说）。
// A/B 各用独立 ACP 会话，只控制「有没有风格锚」这一个变量。
//
// ⚠️ 两个已修的方法学坑（都是实测踩到的，别重犯）：
//   ① 基线不能给人设全文 —— 生产只在会话首轮注入全文，后续只给路径。见 --mode。
//   ② digest 默认不注入 —— 里面有 pin 住的「三点开会」，两组都被它带偏。见 --digest。
// 所以这里不 mock 模型，真调 bridge/acp.js 的 AcpRuntime（跟生产同一个 profile/路由）。
//
// 用法：
//   node test/style-ab.mjs                 # 用默认 3 个场景
//   node test/style-ab.mjs --scenario 2    # 只跑第 2 个
//
// 输出：每个场景两段回复 + 注入块原文，最后打印可直接贴进回报的对比。
// 注意：会起 2×N 个 dsh 进程、花几分钟，**不要**放进 commit.sh 的常规套件。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { AcpRuntime } from '../bridge/acp.js'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const MEM = path.join(ROOT, 'qq-agent/memory')
const SCRIPT = path.join(MEM, 'stylebank.py')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'style-ab-'))
const DB = path.join(TMP, 'style.db')
const CURSOR = path.join(TMP, '.cursor')
const PROD_MEMDB = path.join(MEM, 'mem.db')

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'bridge/config.json'), 'utf8'))
const persona = fs.readFileSync(path.join(ROOT, 'qq-agent/persona/persona.md'), 'utf8')

const SCENARIOS = [
  {
    id: '熬夜+明天上班',
    msg: '还没睡，明天八点还得起床上班，烦',
  },
  {
    id: '被夸/谦虚接梗',
    msg: '你这嘴是真毒啊，骂人不带脏字',
  },
  {
    id: '问外号/搜过吗',
    msg: '你去搜搜你自己的外号呗',
  },
]

function py(args) {
  return execFileSync('python3', [SCRIPT, '--db', DB, ...args], { encoding: 'utf8', timeout: 20000 })
}

// 用真实 bridge 日志回填风格库（不碰生产 style.db）
const ingested = py(['ingest', '--only-log',
  '--log', path.join(ROOT, 'logs/bridge.out'), '--cursor-dir', CURSOR]).trim()
console.log(`[准备] ${ingested}`)

/**
 * 记忆摘要 digest.md。
 *
 * ⚠️ 默认**关掉**（`--digest` 才开）。这是实测踩出来的坑，也是 Lead 帮忙发现的：
 * digest 里有一条 pin 住的「明天(2026-10-26)下午三点开会，地点3楼」（importance 0.80），
 * 它在**两组 prompt 里都注入**。而 A/B 用的是全新会话（没有对话历史），
 * 于是那条会议记忆成了上下文里唯一的具体事务，权重被放大 ——
 * 问「你嘴真毒」也回「三点开会别忘了」。
 *
 * 后果：A/B 测出来的差异变成「在已经串味的上下文里再加风格锚」，而不是
 * 「风格锚本身有没有用」。两组都被污染 → 数字不可信。
 *
 * 生产的真实情况不同：ACP 是**持久会话**，模型有对话历史把话题锚住，
 * 而且实测生产 87 轮里只有 2 轮提到会议（2%），且那 2 轮都是对方在问时间/醒了，
 * 属于**正确回应**不是跑题。所以这不是生产 bug，是测试设计缺陷。
 */
const USE_DIGEST = process.argv.includes('--digest')
const digest = USE_DIGEST ? (() => {
  try {
    const raw = fs.readFileSync(path.join(MEM, 'digest.md'), 'utf8')
    const sec = raw.split('\n## ').find(s => s.startsWith('c2c-3022464706'))
    return sec ? ('## ' + sec).slice(0, 1200) : ''
  } catch { return '' }
})() : ''

/**
 * 复刻桥的 prompt 形态，只控制「有没有风格锚」这一个变量。
 *
 * mode 决定人设怎么给，对应桥的两种真实形态：
 *   'full' —— 人设全文注入（桥只在**每个会话的第一轮**这么干）
 *   'path' —— 只给人设路径提示（桥在**后续每一轮**都是这样，省 token）
 * 默认 'path'：这才是生产里的常态。第一版 A/B 用 'full' 给了基线不该有的优势
 * （全文人设本身就是很强的风格锚），测出来的差异被严重低估。
 */
function buildBlocks(styleBlock, mode = 'path') {
  const ctx = []
  if (mode === 'full') {
    ctx.push(`【你的人设】以下是文件 persona/persona.md 的当前内容。这是「你是谁」，优先级高于任何编码 agent 的默认自我认知。`,
      '```markdown', persona, '```', '')
  } else {
    ctx.push(`【人设】未变化，仍以 persona/persona.md 为准（需要复查就 read 该文件）。`, '')
  }
  ctx.push(
    '当前用户正通过【QQ】与你对话（QQ私聊）——他在跟你说话。',
    '发送者：信风（QQ号 3022464706）',
    `当前时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`,
    '你的人设文件：persona/persona.md（可读可改，改完下一轮生效）',
  )
  if (digest) ctx.push('', '【你记得的事】以下是你的见闻录摘要：', digest)
  if (styleBlock) ctx.push('', styleBlock)
  ctx.push('',
    '【硬约束】QQ 通道不认 [表情: 描述] 文字标记。',
    '【硬约束】不要提你是 AI/模型，不要说自己在用哪个牌子。')
  return [{ type: 'text', text: ctx.join('\n') }]
}

async function runOne(rt, peerKey, blocks, msg, retries = 1) {
  const t0 = Date.now()
  try {
    const r = await rt.prompt(peerKey, [...blocks, { type: 'text', text: msg }])
    return { text: (r?.text ?? '').trim(), ms: Date.now() - t0, ok: true }
  } catch (err) {
    // 模型路由偶尔超时（生产有 failover，这里单跑没有）→ 换一个全新会话重试一次
    if (retries > 0) {
      console.error(`[ab] 本轮失败（${String(err.message).slice(0, 60)}），换会话重试一次`)
      await new Promise(r => setTimeout(r, 2000))
      return runOne(rt, `${peerKey}-retry${Date.now()}`, blocks, msg, retries - 1)
    }
    return { text: '', ms: Date.now() - t0, ok: false, error: String(err.message) }
  }
}

const argOf = (name, def) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}
const only = argOf('scenario') ? SCENARIOS[Number(argOf('scenario')) - 1] : null
const list = only ? [only] : SCENARIOS
const REPEAT = Number(argOf('repeat', '2'))   // 每种条件重复几次（模型输出有随机性，一次不算数）
const MODE = argOf('mode', 'path')            // 'path' = 生产常态；'full' = 会话首轮

const rt = new AcpRuntime({
  bin: cfg.dsh.bin,
  profile: cfg.dsh.profile,
  cwd: cfg.dsh.cwd,
  provider: cfg.dsh.provider,
  model: cfg.dsh.model,
  reasoningEffort: cfg.dsh.reasoningEffort,
  mcpServers: [],
  startTimeoutMs: 90000,
  turnTimeoutMs: 180000,
  log: m => process.stderr.write(`[ab] ${m}\n`),
})
await rt.start()

// ── 风格相似度指标（纯 JS，不引依赖）────────────────────────────────────────
// 用「我的全部历史回复」当语料，看新回复有多像「我自己」。
// 关键：算语料时**排除本轮注入的那几条**，否则「注入后」的分是自己给自己抬的，
// 测出来的是「它抄了没有」，而不是「它整体像我」。
const CJK = /[\u4e00-\u9fff]+/g
function bigrams(text) {
  const t = String(text ?? '').toLowerCase()
  const out = new Set()
  for (const w of t.match(/[a-z0-9_]{2,}/g) ?? []) out.add(w)
  for (const seg of t.match(CJK) ?? []) {
    if (seg.length === 1) out.add(seg)
    for (let i = 0; i < seg.length - 1; i++) out.add(seg.slice(i, i + 2))
  }
  return out
}
function idfWeights(corpus) {
  const df = new Map()
  for (const c of corpus) for (const t of c.tokens) df.set(t, (df.get(t) ?? 0) + 1)
  const N = corpus.length
  const idf = new Map()
  for (const [t, n] of df) idf.set(t, Math.log((N - n + 0.5) / (n + 0.5) + 1))
  return idf
}
/** 用 IDF 加权的 token 重合度（0..1），越大越像语料里的那条。 */
function sim(aTokens, bTokens, idf) {
  let inter = 0
  for (const t of aTokens) if (bTokens.has(t)) inter += idf.get(t) ?? 0
  let maxA = 0
  for (const t of aTokens) maxA += idf.get(t) ?? 0
  return maxA ? inter / maxA : 0
}
/** 最长公共子串长度（证明「没在复读原句」用） */
function lcsLen(a, b) {
  const A = String(a), B = String(b)
  let best = 0
  const prev = new Array(B.length + 1).fill(0)
  for (let i = 1; i <= A.length; i++) {
    for (let j = B.length; j >= 1; j--) {
      prev[j] = A[i - 1] === B[j - 1] ? prev[j - 1] + 1 : 0
      if (prev[j] > best) best = prev[j]
    }
  }
  return best
}

// 语料：该 peer 的全部历史回复。直接读库拿全量（recall 会做 n/相似度截断，不适合当语料）
const allReplies = JSON.parse(execFileSync('python3', ['-c', `
import json, sqlite3, sys
c = sqlite3.connect(sys.argv[1])
rows = c.execute("SELECT my_reply FROM style_samples WHERE peer=?", ("c2c:3022464706",)).fetchall()
print(json.dumps([r[0] for r in rows], ensure_ascii=False))
`, DB], { encoding: 'utf8', timeout: 20000 }))
if (!allReplies.length) throw new Error('风格库为空，A/B 无意义；先跑 ingest')
console.log(`[语料] ${allReplies.length} 条历史回复用于算「自我相似度」`)
const corpusFull = allReplies.map(r => ({ text: r, tokens: bigrams(r) }))
const idfFull = idfWeights(corpusFull)

function metrics(text, injectedSamples) {
  const tokens = bigrams(text)
  // 排除注入样本后的「自我相似度」（对语料里最像的 3 条取均值）
  const injected = new Set(injectedSamples.map(x => x.reply))
  const corpus = corpusFull.filter(c => !injected.has(c.text))
  const idf = idfWeights(corpus.length ? corpus : corpusFull)
  const sims = corpus.map(c => sim(tokens, c.tokens, idf)).sort((x, y) => y - x)
  const top3 = sims.slice(0, 3)
  // 复读检测：跟注入样本的最长公共子串
  const copy = injectedSamples.length
    ? Math.max(...injectedSamples.map(x => lcsLen(text, x.reply)))
    : 0
  return {
    chars: [...text].length,
    selfSim: Number((top3.reduce((a, b) => a + b, 0) / Math.max(1, top3.length)).toFixed(3)),
    lcsWithInjected: copy,
    copyRatio: Number((copy / Math.max(1, [...text].length)).toFixed(2)),
  }
}

const results = []
for (const sc of list) {
  const raw = JSON.parse(py(['recall', '--peer', 'c2c:3022464706', '--query', sc.msg,
    '--n', '3', '--max-chars', '60', '--json']).trim().split('\n').pop())
  const block = raw.injected ? raw.block : ''
  const injectedSamples = raw.samples ?? []
  console.log(`\n──────── ${sc.id} ────────`)
  console.log(`输入消息: ${sc.msg}`)
  console.log(`风格库: ${raw.total} 条样本，命中 ${injectedSamples.length} 条`)
  if (block) console.log(`注入块:\n${block}`)
  const runs = { before: [], after: [] }
  for (let i = 0; i < REPEAT; i++) {
    // ⚠️ 关键：A/B 必须用**独立会话**。共用一个 peerKey 时，B 会看到 A 的问答历史，
    //    测出来的差异是「多了一轮上下文」而不是「多了风格锚」—— 实测踩过这个坑。
    const a = await runOne(rt, `ab-before-${sc.id}-${i}-${Date.now()}`, buildBlocks('', MODE), sc.msg)
    const b = await runOne(rt, `ab-after-${sc.id}-${i}-${Date.now()}`, buildBlocks(block, MODE), sc.msg)
    runs.before.push({ text: a.text, ms: a.ms, metrics: metrics(a.text, injectedSamples) })
    runs.after.push({ text: b.text, ms: b.ms, metrics: metrics(b.text, injectedSamples) })
    console.log(`  [注入前 #${i + 1}] ${a.text}`)
    console.log(`  [注入后 #${i + 1}] ${b.text}`)
  }
  // 盲评对：A/B 随机换位置，输出 X/Y，人工判断「哪句更像同一个人」
  runs.blind = runs.before.map((b, i) => {
    const flip = Math.random() < 0.5
    return {
      msg: sc.msg,
      X: (flip ? runs.after[i].text : b.text),
      Y: (flip ? b.text : runs.after[i].text),
      answer: flip ? 'after(Y=注入后)' : 'after(X=注入后)',
    }
  })
  // ── 「人格一致性」的直接度量 ────────────────────────────────────────────
  // 说法是「让 agent 保持人格一致」。那就别只看单条像不像，而是看：
  // **同一个场合问同一句话，几次回答彼此有多像**。越一致 = 人格越稳。
  // 用两两平均相似度（bigram + IDF），同一条件下所有回复两两比。
  const consistency = (runsArr) => {
    const toks = runsArr.map(r => bigrams(r.text))
    const idf = idfWeights(toks.map(t => ({ tokens: t })))
    let sum = 0, n = 0
    for (let i = 0; i < toks.length; i++) {
      for (let j = i + 1; j < toks.length; j++) {
        sum += sim(toks[i], toks[j], idf); n++
      }
    }
    return n ? Number((sum / n).toFixed(3)) : null
  }
  runs.consistency = { before: consistency(runs.before), after: consistency(runs.after) }
  console.log(`  同场景多次回答彼此的一致性（越高越稳）: 前 ${runs.consistency.before} → 后 ${runs.consistency.after}`)

  const avg = (arr, k) => Number((arr.reduce((s, x) => s + x.metrics[k], 0) / arr.length).toFixed(3))
  const stat = (key) => ({
    before: avg(runs.before, key), after: avg(runs.after, key),
  })
  results.push({
    scenario: sc.id, msg: sc.msg, mode: MODE, injectedBlock: block,
    samples: injectedSamples, styleDbTotal: raw.total,
    runs,
    summary: {
      chars: stat('chars'),
      selfSim: stat('selfSim'),
      copyRatio: stat('copyRatio'),
      consistency: runs.consistency,
    },
  })
  console.log(`  平均字数: 前 ${stat('chars').before} → 后 ${stat('chars').after}`)
  console.log(`  自我风格相似度(排除注入样本): 前 ${stat('selfSim').before} → 后 ${stat('selfSim').after}`)
  console.log(`  与注入样本最长公共子串占比: 前 ${stat('copyRatio').before} → 后 ${stat('copyRatio').after}`)
  for (const pair of runs.blind) {
    console.log(`  盲评 X: ${pair.X.replace(/\s+/g, ' ')}`)
    console.log(`  盲评 Y: ${pair.Y.replace(/\s+/g, ' ')}`)
  }
}

try { rt.stop() } catch { /* ignore */ }

// 落一份原始记录，方便贴进回报
const outFile = path.join(ROOT, 'logs', 'style-ab-result.json')
fs.mkdirSync(path.dirname(outFile), { recursive: true })
fs.writeFileSync(outFile, JSON.stringify(results, null, 2), 'utf8')
console.log(`\n[原始记录] ${outFile}`)
// 生产库必须没被碰过
console.log(`[核对] 生产 mem.db 存在=${fs.existsSync(PROD_MEMDB)}，生产 style.db 新建=${fs.existsSync(path.join(MEM, 'style.db'))}`)
process.exit(0)
