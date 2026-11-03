#!/usr/bin/env node
// scripts/memory-ab.mjs —— 记忆 v4 / v5 **注入 A/B 盲评**工具（只读）
// ============================================================================
// 为什么需要它（docs/MEMORY-AUDIT-AND-V5.md §5 验收标准）：
//   「噪音率 79% → <30%」「每轮注入 1865 字 → <800 字」这类指标**不能靠感觉**，
//   也不能只统计条数 —— 必须拿同一批真实查询，把两个引擎各自注入的内容并排看，
//   人工盲评「相关 / 弱相关 / 噪音」，再统计算噪音率。这个脚本负责：
//     ① 从 bridge.out 抽最近的真实入站消息当查询（可分层抽样）；
//     ② v4 侧按**桥现在的真实口径**渲染（不是重新实现：按注释锚点从
//        lib/bridge/index.js 抠出「记忆读取与注入」段，在 vm 沙箱里求值，
//        调用真正的 memoryRecallBlock —— 含 crossChannelRecall + digest）；
//     ③ v5 侧用 lib/agent/memory-v5/search.mjs 的 rankMemories，预算 350 字
//        （§3.7 里「跨通道检索」那一块的 v5 对应物）；
//     ④ 默认输出**打乱顺序的两栏**（A/B 不标引擎名），供人工盲评；
//     ⑤ `--json` 输出机器可读的逐查询明细 + 汇总指标；
//     ⑥ 自动指标：字数、条数、P50/P99 耗时、两边交集/独有、与本轮上下文重复条数。
//
// ── 只读纪律（硬要求）──────────────────────────────────────────────────────
//   · `--v4 / --v5 / --log` 全部是**副本路径**；落在生产数据目录（~/.dsh /
//     DSH_HOME / LLMINQQ_DATA_DIR）下默认**拒绝**（exit 2），确需指过去时加
//     `--allow-prod-copy`（仍然只读，见下）。
//   · v4 库由 python 以 `mode=ro` 打开（bridge 的注入脚本本来就强制只读）。
//   · v5 的 store 打开时会写 WAL/journal（sqlite 物理行为，无法只读模式复用），
//     所以脚本先把 v5 库**复制到临时目录**再打开，源文件一个字节都不碰。
//   · 跑完比对 v4/v5/log 的 sha256，任何变化 → exit 1（自证「没写」）。
//   · 不写生产库、不部署、不启动桥、不碰 NapCat。
//
// ── 用法 ───────────────────────────────────────────────────────────────────
//   # 先做副本（生产只读）
//   cp ~/.dsh/dsh-plugin-llminqq/agent/memory/mem.db        /tmp/mem.db
//   cp ~/.dsh/dsh-plugin-llminqq/agent/memory/digest.md     /tmp/digest.md
//   cp /tmp/mem-v5-migrated.db                              /tmp/mem-v5.db
//   cp ~/.dsh/dsh-plugin-llminqq/logs/bridge.out            /tmp/bridge.out
//
//   node scripts/memory-ab.mjs --v4 /tmp/mem.db --v5 /tmp/mem-v5.db \
//     --log /tmp/bridge.out --limit 30 > /tmp/ab.md      # 盲评 markdown
//   node scripts/memory-ab.mjs ... --json > /tmp/ab.json  # 机器可读
//   node scripts/memory-ab.mjs ... --reveal                # 判读完再看引擎映射
//
//   # v4 只用跨通道段（不含 digest）对比 v5 检索块时的差异在报告里注明；
//   # --v4-digest 不给时默认找 v4 库旁边的 digest.md（没有就只用跨通道段）。
// ============================================================================
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import vm from 'node:vm'
import { spawnSync, execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const MEMCTL_DIR = path.join(ROOT, 'lib', 'agent', 'memory')
const V5_DIR = path.join(ROOT, 'lib', 'agent', 'memory-v5')
const BRIDGE_SRC = path.join(ROOT, 'lib', 'bridge', 'index.js')

// v4 注入段在 bridge/index.js 里的两个注释锚点（和 test/memory-cross-channel 用同一对；
// 锚点被改时直接报错，不静默失配）。
const V4_ANCHOR_START = '// ── 记忆读取与注入（digest + 按人跨通道检索）'
const V4_ANCHOR_END = '// ── 自我风格样本库（人格一致性）'

// §3.7：v5 检索块预算 350 字（用于和 v4 cross-channel 那一段对比）
const V5_RETRIEVAL_BUDGET = 350
// v4 桥现在的口径：crossChannel top=8 → minScore 0.15 + maxRows 6 + 每条 110 字 + 块上限 900
const V4_RECALL_TOP = 8
// 「本轮上下文」的近似窗口：查询对应时刻之前的 N 条同会话消息（用于重复注入指标）
const CONTEXT_WINDOW_MESSAGES = 20

// ── 小工具 ──────────────────────────────────────────────────────────────────
const charLen = s => [...String(s ?? '')].length

function sha256 (file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') } catch { return null }
}

/** 固定的可复现随机数（mulberry32）——盲评打乱必须可复现，否则评审结果没法复盘。 */
export function mulberry32 (seed) {
  let a = Number(seed) >>> 0
  return function () {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffle (arr, rng) {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function percentile (values, p) {
  if (!values.length) return 0
  const a = values.slice().sort((x, y) => x - y)
  return a[Math.min(a.length - 1, Math.floor(a.length * p))]
}

const fmtMs = ms => `${Number(ms).toFixed(1)} ms`
const fmtNum = n => (Number.isFinite(n) ? String(Math.round(n * 10) / 10) : '-')

/** 文本归一化（比较交集/重复用：去标签、去空白、小写）。 */
export function normalizeText (s) {
  return String(s ?? '')
    .replace(/【[^】]*】/g, ' ')          // 块标题
    .replace(/^[\s\-•*]+/, '')           // 行首列表符/tag 前缀
    .replace(/^\[[^\]]*\]\s*/, '')       // [事实·3 天前] 类型标签
    .replace(/^[^\s：:]{1,6}·/, '')       // 「群·」「私聊·」通道标签
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

// ── 命令行参数 ──────────────────────────────────────────────────────────────
function usage (msg) {
  if (msg) process.stderr.write(`memory-ab: ${msg}\n\n`)
  process.stderr.write([
    '用法: node scripts/memory-ab.mjs --v4 <mem.db副本> --v5 <mem-v5.db副本> --log <bridge.out副本> [选项]',
    '',
    '  --v4 <path>            v4 记忆库副本（mem.db）',
    '  --v5 <path>            v5 记忆库副本（mem-v5.db）',
    '  --log <path>           bridge.out 副本（从这里抽真实查询）',
    '  --v4-digest <path>     v4 digest.md 副本（默认找 v4 库旁边；没有就只用跨通道段）',
    '  --limit <n>            抽多少条查询（默认 30）',
    '  --sample <mode>        recent（取最近）| stratified（按类别分层，默认）',
    '  --seed <n>             盲评打乱种子（默认 1；同种子结果可复现）',
    '  --v5-context <mode>    off（默认，关闭水位线，公平比较检索）| window（按日志窗口模拟上下文）',
    '  --json                 输出 JSON（逐查询明细 + 汇总）',
    '  --reveal               markdown 末尾附「A/B 对应哪个引擎」的揭盲表（判读完再看）',
    '  --python <bin>         python 解释器（默认 python3，v4 侧用）',
    '  --code-dir <path>      memctl.py 所在目录（默认仓库 lib/agent/memory）',
    '  --allow-prod-copy      允许路径指到生产数据目录下（仍只读）',
    '  -h, --help             显示本帮助',
  ].join('\n') + '\n')
  process.exit(msg ? 2 : 0)
}

export function parseArgs (argv) {
  const out = {
    limit: 30, sample: 'stratified', seed: 1, json: false, reveal: false,
    v5Context: 'off', allowProdCopy: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const take = () => {
      const v = argv[++i]
      if (v == null || v.startsWith('--')) usage(`${a} 需要一个值`)
      return v
    }
    if (a === '--v4') out.v4 = take()
    else if (a === '--v5') out.v5 = take()
    else if (a === '--log') out.log = take()
    else if (a === '--v4-digest') out.v4Digest = take()
    else if (a === '--limit') out.limit = Math.max(1, Math.min(500, Number(take()) || 30))
    else if (a === '--sample') out.sample = take()
    else if (a === '--seed') out.seed = Number(take()) || 1
    else if (a === '--v5-context') out.v5Context = take()
    else if (a === '--json') out.json = true
    else if (a === '--reveal') out.reveal = true
    else if (a === '--python') out.python = take()
    else if (a === '--code-dir') out.codeDir = take()
    else if (a === '--allow-prod-copy') out.allowProdCopy = true
    else if (a === '-h' || a === '--help') usage('')
    else usage(`未知参数 ${a}`)
  }
  if (!out.v4 || !out.v5 || !out.log) usage('缺少 --v4 / --v5 / --log（都要副本路径）')
  if (!['recent', 'stratified'].includes(out.sample)) usage(`--sample 只能是 recent|stratified（收到 ${out.sample}）`)
  if (!['off', 'window'].includes(out.v5Context)) usage(`--v5-context 只能是 off|window（收到 ${out.v5Context}）`)
  return out
}

// ── 生产路径守卫（和 scripts/memory-audit.mjs 同一套口径）───────────────────
function prodRoots () {
  const roots = [path.join(os.homedir(), '.dsh')]
  for (const k of ['DSH_HOME', 'LLMINQQ_DATA_DIR']) if (process.env[k]) roots.push(process.env[k])
  return roots.map(r => { try { return path.resolve(r.replace(/^~/, os.homedir())) } catch { return '' } }).filter(Boolean)
}

export function isProdPath (p) {
  if (!p) return false
  const abs = path.resolve(p)
  return prodRoots().some(root => abs === root || abs.startsWith(root + path.sep))
}

// ── 查询抽取（bridge.out → 真实入站消息）───────────────────────────────────
// 真实 bridge.out 的入站行比早年的格式多了尾缀（实测现网）：
//   ... text="..." images=0 cards=0 segs=text
//   ... text="..." images=0 cards=1 segs=json
//   ... text="..." images=0 cards=0 segs=reply,text
// 尾缀必须可选（老测试 fixture 只写到 images=0），seg 类型用来过滤「不是人话」的消息。
const INBOUND_RE = /^(\d{4}-\d{2}-\d{2}T\S+)\s+入站\s+(\S+)\s+from=([^(]*)\((\d+)\)\s+text="(.*)"\s+images=\d+(?:\s+(.*))?\s*$/
const TAIL_SEGS_RE = /(?:^|\s)segs=([^\s]+)/
// 纯占位/控制标记：这些消息当查询没意义（模型看到的不是「话」）
const PLACEHOLDER_RE = /^\s*(?:\[(?:图片|文件|语音|视频|表情包|卡片|QQ小程序|位置|名片|骰子|猜拳|群在线文件|合并转发|回复|艾特)[^\]]*\]\s*)+$/
const NOISE_QUERIES = new Set([
  '嗯', '哦', '好的', '好', '在', '在吗', '在不在', '哈', '哈哈', '哈哈哈', '哈哈哈哈',
  '笑死', '草', '牛逼', '666', '确实', '同意', '收到', '1', '？', '??', '！', '!', '+1',
])

/** 查询类别启发式（只用于分层抽样与报告；不参与检索）。 */
export function classifyQuery (text) {
  const t = String(text ?? '')
  if (charLen(t) < 10 || NOISE_QUERIES.has(t.trim()) || /^[哈嗯哦啊噢]+$/u.test(t.trim())) return '噪音对照'
  if (/(上次|之前|以前|还记得|记不记得|那天|说过|提到|那个事|前阵子|当时|你记得)/u.test(t)) return '指代回忆'
  if (/(后来|然后|怎么样了|进展|搞定|弄完|结果|继续|后面|那个)/u.test(t)) return '话题延续'
  if (/(你觉得我|我是什么|我怎么样|你了解我|我这个人|记得我|我的性格|你懂我|在你眼里)/u.test(t)) return '人物画像'
  return '一般'
}

function cleanQueryText (raw) {
  let t = String(raw ?? '')
    .replace(/\\n/g, ' ')
    .replace(/\\"/g, '"')
  // 去掉控制标记/占位（查询里出现它们只会让检索跑偏，也不是「人话」）
  t = t.replace(/\[(?:SILENT|SEND_FILE:[^\]]*|VOICE:[^\]]*|AT:\d+|POKE:\d+(?::\w+)?|RECALL:[^\]]*|FOLLOW:[^\]]*|CQ:[^\]]*)\]/gi, ' ')
  t = t.replace(/\s+/g, ' ').trim()
  return t
}

/**
 * 从 bridge.out 文本里抽查询。
 * @returns {Array<{idx, at, conv, subject, name, query, category}>}
 */
export function extractQueries (logText, { limit = 30, sample = 'stratified', seed = 1 } = {}) {
  const lines = String(logText ?? '').split('\n')
  const all = []
  const seen = new Set()
  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const line = lines[lineNo].replace(/\r$/, '')
    const m = INBOUND_RE.exec(line.trim())
    if (!m) continue
    // 只取「有文字段」的消息当查询：图片/卡片/合并转发里的占位文本不是用户说的话，
    // 拿它们当 query 只会测出「检索对图片消息无感」这种没意义的结论。
    const segs = TAIL_SEGS_RE.exec(m[6] || '')?.[1] || ''
    if (segs && !segs.split(',').includes('text')) continue
    const query = cleanQueryText(m[5])
    if (!query) continue
    if (PLACEHOLDER_RE.test(query)) continue
    if (charLen(query) < 6) continue
    const conv = m[2] // 桥格式 c2c:QQ / group:群号（v4 的 memoryRecallBlock 自己转成 c2c-QQ）
    const key = `${conv}\u0001${query}`
    if (seen.has(key)) continue
    seen.add(key)
    const at = Date.parse(m[1]) / 1000
    all.push({
      idx: all.length,
      lineNo,
      at: Number.isFinite(at) ? at : null,
      conv,
      subject: m[4],
      name: m[3].trim(),
      query,
      category: classifyQuery(query),
    })
  }
  if (!all.length) return []
  const rng = mulberry32(seed)
  if (sample === 'recent') {
    return all.slice(-limit) // 最近 limit 条（保持日志里的时间顺序）
  }
  // stratified：每个类别内部打乱后轮流取，保证「指代回忆 / 话题延续 / 画像 / 噪音」
  // 都有样本（只取最近 N 条的话，噪音可能一条都抽不到）。
  const buckets = new Map()
  for (const q of all) {
    if (!buckets.has(q.category)) buckets.set(q.category, [])
    buckets.get(q.category).push(q)
  }
  const order = ['指代回忆', '话题延续', '人物画像', '一般', '噪音对照']
  const queues = order
    .filter(c => buckets.has(c))
    .map(c => shuffle(buckets.get(c), rng))
  const picked = []
  while (picked.length < limit && queues.some(q => q.length)) {
    for (const q of queues) {
      if (picked.length >= limit) break
      if (q.length) picked.push(q.shift())
    }
  }
  return picked.sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || a.lineNo - b.lineNo)
}

/** 查询时刻该会话的上下文近似：同 conv 且出现在查询行之前的最后 N 条。 */
function contextBefore (logText, query, window = CONTEXT_WINDOW_MESSAGES) {
  const lines = String(logText ?? '').split('\n')
  const out = []
  for (let i = 0; i < Math.min(query.lineNo, lines.length); i++) {
    const line = lines[i].replace(/\r$/, '').trim()
    const inb = INBOUND_RE.exec(line)
    const outm = /^(\d{4}-\d{2}-\d{2}T\S+)\s+出站\s+(\S+)\s+text="(.*)"\s+chars=\d+\s*$/.exec(line)
    const conv = inb ? inb[2] : outm ? outm[2] : null
    if (conv !== query.conv) continue
    const text = cleanQueryText(inb ? inb[5] : outm[3])
    if (text) out.push(text)
  }
  return out.slice(-window)
}

// ── v4 侧：抠 bridge 的真实注入段求值（保证口径就是线上口径）─────────────────
export function loadV4Evaluator ({ v4Db, digestPath, codeDir = MEMCTL_DIR, pythonBin = 'python3' } = {}) {
  const src = fs.readFileSync(BRIDGE_SRC, 'utf8')
  const i = src.indexOf(V4_ANCHOR_START)
  const j = src.indexOf(V4_ANCHOR_END)
  if (i < 0 || j <= i) {
    throw new Error(`lib/bridge/index.js 里找不到记忆注入段锚点（「${V4_ANCHOR_START}」/「${V4_ANCHOR_END}」），无法还原 v4 口径`)
  }
  const code = src.slice(i, j)
  const dir = path.dirname(path.resolve(v4Db))
  const digest = digestPath ? path.resolve(digestPath) : path.join(dir, 'digest.md')
  const sandbox = Object.assign(Object.create(globalThis), {
    fs,
    path,
    process,
    execFileSync,
    config: {
      dsh: { stateDir: dir, cwd: dir },
      memory: {
        dir,
        db: path.resolve(v4Db),
        digestPath: digest,
        codeDir: path.resolve(codeDir),
        memctl: path.join(path.resolve(codeDir), 'memctl.py'),
        runner: '',
        pythonBin,
        crossChannel: {},
      },
    },
    logger: { log () {}, debug () {}, warn () {}, info () {} },
    STYLE_ROOTS: {},
    LEXICON_ROOTS: {},
  })
  vm.createContext(sandbox)
  vm.runInContext(
    `${code}\n;globalThis.__V4 = { memoryRecallBlock, readMemoryDigestFor, MEMORY_PATHS }`,
    sandbox,
  )
  const X = vm.runInContext('__V4', sandbox)
  return {
    hasDigest: fs.existsSync(digest),
    digestPath: digest,
    memoryRecallBlock: X.memoryRecallBlock,
    readMemoryDigestFor: X.readMemoryDigestFor,
    paths: X.MEMORY_PATHS,
  }
}

/** 解析 v4 注入块：拆出「跨通道检索」段与「digest」段（对比时只看跨通道段）。 */
export function parseV4Block (block) {
  const text = String(block ?? '')
  const out = { retrieval: '', digest: '', items: [], chars: charLen(text), retrievalChars: 0, digestChars: 0 }
  if (!text) return out
  const retrStart = text.indexOf('【你记得的事·按人跨通道检索】')
  const digestStart = text.indexOf('【你的见闻录摘要】')
  const footerStart = text.indexOf('提到以前的事就照着说')
  if (retrStart >= 0) {
    const end = digestStart > retrStart ? digestStart : (footerStart > retrStart ? footerStart : text.length)
    out.retrieval = text.slice(retrStart, end).trim()
    out.items = out.retrieval
      .split('\n')
      .filter(l => /^\s{2}- /.test(l))
      .map(l => l.replace(/^\s{2}- /, '').trim())
      .filter(Boolean)
  }
  if (digestStart >= 0) {
    const end = footerStart > digestStart ? footerStart : text.length
    out.digest = text.slice(digestStart, end).trim()
  }
  out.retrievalChars = charLen(out.retrieval)
  out.digestChars = charLen(out.digest)
  return out
}

// ── v5 侧：复制到临时目录再打开（只读源文件）────────────────────────────────
function copyV5ToTemp (v5Path) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-ab-v5-'))
  const dst = path.join(dir, 'mem-v5.db')
  fs.copyFileSync(v5Path, dst)
  for (const suffix of ['-wal', '-shm']) {
    const s = v5Path + suffix
    if (fs.existsSync(s)) { try { fs.copyFileSync(s, dst + suffix) } catch { /* ignore */ } }
  }
  return { dir, dbPath: dst, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ } } }
}

async function openV5Evaluator (v5Path) {
  // 先验文件头：SQLite 文件以 16 字节 magic 开头。不验的话，空文件/坏文件会被
  // openV5 的 CREATE TABLE IF NOT EXISTS 悄悄建出一份空库，被当成「数据为空」。
  let head
  try {
    const fd = fs.openSync(v5Path, 'r')
    head = Buffer.alloc(16)
    fs.readSync(fd, head, 0, 16, 0)
    fs.closeSync(fd)
  } catch (err) {
    throw new Error(`v5 库读不了：${String(err?.message ?? err)}`)
  }
  if (head.toString('utf8') !== 'SQLite format 3\u0000') {
    throw new Error(`不是 SQLite 数据库（文件头不对）：${v5Path}`)
  }
  const storeMod = await import(pathToFileURL(path.join(V5_DIR, 'store.mjs')).href)
  const search = await import(pathToFileURL(path.join(V5_DIR, 'search.mjs')).href)
  const tmp = copyV5ToTemp(v5Path)
  let store
  try {
    store = storeMod.openV5({ dbPath: tmp.dbPath, log: () => {} })
    // 校验确实是 v5 库（空文件/坏文件会被 openV5 建表 → 不能当作「数据为空」）
    const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)
    if (!tables.includes('memories')) throw new Error('不是 v5 库（缺 memories 表）')
  } catch (err) {
    tmp.cleanup()
    throw new Error(`v5 库打不开：${String(err?.message ?? err)}`)
  }
  return { store, search, cleanup: () => { try { store.close() } catch { /* ignore */ } ; tmp.cleanup() } }
}

// ── 单查询两侧执行 ──────────────────────────────────────────────────────────
function v5ContextSinceFor (query, logText, mode) {
  if (mode !== 'window') return false
  const lines = String(logText ?? '').split('\n')
  const list = []
  for (let i = 0; i < Math.min(query.lineNo, lines.length); i++) {
    const line = lines[i].replace(/\r$/, '').trim()
    const inb = INBOUND_RE.exec(line)
    const outm = /^(\d{4}-\d{2}-\d{2}T\S+)\s+出站\s+(\S+)\s+text="(.*)"\s+chars=\d+\s*$/.exec(line)
    if (!inb && !outm) continue
    const conv = inb ? inb[2] : outm[2]
    if (conv !== query.conv) continue
    const at = Date.parse(inb ? inb[1] : outm[1]) / 1000
    if (Number.isFinite(at)) list.push(at)
  }
  if (!list.length) return false
  // 与 contextBefore() 同一个窗口：最后 N 条里最早的那条时间 = 「ACP 上下文起点」近似
  return list.slice(-CONTEXT_WINDOW_MESSAGES)[0]
}

function runV4Side (evaluator, query) {
  const t0 = performance.now()
  try {
    const block = evaluator.memoryRecallBlock(query.conv, {
      speaker: query.subject,
      inGroup: String(query.conv).startsWith('group:') || String(query.conv).startsWith('group-'),
      query: query.query,
    })
    const ms = performance.now() - t0
    const parsed = parseV4Block(block)
    return { ok: true, block: String(block ?? ''), ...parsed, elapsedMs: ms }
  } catch (err) {
    return { ok: false, block: '', items: [], chars: 0, elapsedMs: performance.now() - t0, error: String(err?.message ?? err) }
  }
}

function runV5Side (evaluator, query, { logText, v5Context = 'off' } = {}) {
  const t0 = performance.now()
  try {
    const opts = {
      store: evaluator.store,
      query: query.query,
      subject: query.subject,
      conv: query.conv,
      inGroup: String(query.conv).startsWith('group:') || String(query.conv).startsWith('group-'),
      now: query.at ?? Date.now() / 1000,
      contextSince: v5ContextSinceFor(query, logText, v5Context),
    }
    const ranked = evaluator.search.rankMemories(opts)
    const block = evaluator.search.renderMemories({ items: ranked.items, budgetChars: V5_RETRIEVAL_BUDGET })
    const ms = performance.now() - t0
    // 汇总用：v5 完整块（画像 120 + 检索 350 + 防复读 60，≤800）
    let fullChars = charLen(block)
    try {
      const full = evaluator.search.buildMemoryBlocks({ ...opts, totalBudgetChars: 800 })
      fullChars = full.chars
    } catch { /* 完整块失败不影响主指标 */ }
    return {
      ok: true,
      block: String(block ?? ''),
      items: (ranked.items ?? []).map(it => ({ id: it.id, type: it.type, text: it.text, score: it.score })),
      chars: charLen(block),
      fullChars,
      elapsedMs: ms,
      via: ranked.via,
      skippedContext: ranked.skippedContext,
      docCount: ranked.docCount,
    }
  } catch (err) {
    return { ok: false, block: '', items: [], chars: 0, fullChars: 0, elapsedMs: performance.now() - t0, error: String(err?.message ?? err) }
  }
}

// ── 指标 ────────────────────────────────────────────────────────────────────
const itemText = it => (typeof it === 'string' ? it : String(it?.text ?? ''))

function textIntersection (v4Items, v5Items) {
  const a = v4Items.map(it => normalizeText(itemText(it))).filter(s => charLen(s) >= 6)
  const b = v5Items.map(it => normalizeText(itemText(it))).filter(s => charLen(s) >= 6)
  let exact = 0
  let near = 0
  for (const x of a) {
    if (b.includes(x)) { exact += 1; continue }
    if (b.some(y => y.includes(x) || x.includes(y))) near += 1
  }
  return { exact, near, v4Only: a.length - exact - near, v5Only: b.length - exact - near }
}

/** 重复注入上下文：注入条目文本出现在该查询之前的 N 条同会话消息里。 */
function repeatCount (items, contextTexts) {
  const ctx = contextTexts.map(normalizeText).filter(s => charLen(s) >= 6)
  let n = 0
  for (const it of items) {
    const t = normalizeText(itemText(it))
    if (charLen(t) < 6) continue
    if (ctx.some(c => c === t || c.includes(t) || t.includes(c))) n += 1
  }
  return n
}

/**
 * 汇总一侧的指标。
 *   · avgChars  = **检索块**字数（v4 用跨通道段 retrievalChars、v5 用检索块 chars，
 *     两边口径对齐，才能公平比较 §3.7 的「跨通道 335 → 350」那一项）；
 *   · avgFullChars = **完整注入**字数（v4 = 跨通道 + digest；v5 = 画像+检索+防复读）。
 */
function summarizeSide (entries, { fullCharsOf = null, charsOf = e => charLen(e.block) } = {}) {
  const ok = entries.filter(e => e && e.ok)
  const chars = ok.map(charsOf).filter(Number.isFinite)
  const full = fullCharsOf ? ok.map(fullCharsOf).filter(Number.isFinite) : []
  const elapsed = ok.map(e => e.elapsedMs)
  return {
    queries: entries.length,
    ok: ok.length,
    errors: entries.length - ok.length,
    empty: ok.filter(e => !e.block || !charLen(e.block)).length,
    avgChars: chars.length ? chars.reduce((a, b) => a + b, 0) / chars.length : 0,
    avgFullChars: full.length ? full.reduce((a, b) => a + b, 0) / full.length : 0,
    avgItems: ok.length ? ok.reduce((a, e) => a + (e.items?.length ?? 0), 0) / ok.length : 0,
    p50Ms: percentile(elapsed, 0.5),
    p99Ms: percentile(elapsed, 0.99),
    avgRepeat: ok.length ? ok.reduce((a, e) => a + (e.repeatCount ?? 0), 0) / ok.length : 0,
  }
}

// ── 报告渲染 ────────────────────────────────────────────────────────────────
const mdEscape = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>')
const timeLabel = at => {
  if (!Number.isFinite(at)) return '时间未知'
  const d = new Date(at * 1000)
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function renderMarkdown (report) {
  const L = []
  L.push('# 记忆注入 A/B 盲评（同一批真实查询，A/B 两侧顺序已打乱）')
  L.push('')
  L.push(`- 生成时间：${report.generatedAt}`)
  L.push(`- 查询数：${report.queries.length}（抽样：${report.options.sample}，seed=${report.options.seed}）`)
  L.push(`- 只读自证：输入文件运行前后 sha256 一致 = ${report.readOnly.v4Unchanged && report.readOnly.v5Unchanged && report.readOnly.logUnchanged}`)
  L.push(`- 数据加载：${report.v4Available && report.v5Available ? '两侧均已加载' : '有引擎不可用（见 --json / --reveal）'}`)
  L.push('')
  L.push('> **盲评方法**：逐条只看 A/B 两栏内容，不看字数、不看运行日志；每栏先记一个判断——')
  L.push('> ① 有没有**正好能接上这句话**的记忆；② 有没有**明显无关/过时**的条目；③ 有没有**重复说同一件事**。')
  L.push('> 每栏可标「相关 / 弱相关 / 噪音」；判完再 `--reveal` 看汇总与引擎映射。')
  L.push('')
  for (let i = 0; i < report.queries.length; i++) {
    const q = report.queries[i]
    L.push(`## Q${String(i + 1).padStart(2, '0')} · ${q.category} · ${q.conv} · ${timeLabel(q.at)}`)
    L.push('')
    L.push(`> ${q.query}`)
    L.push('')
    const a = q.blind.A
    const b = q.blind.B
    L.push('| A 侧 | B 侧 |')
    L.push('|---|---|')
    L.push(`| ${mdEscape(String(a.block ?? '').trim()) || '（空）'} | ${mdEscape(String(b.block ?? '').trim()) || '（空）'} |`)
    L.push('')
  }
  // 汇总（引擎名用「引擎①/②」，默认不揭盲；口径/路径在 --reveal 里）
  const s = report.summary
  L.push('## 汇总指标（判读后再看；引擎名在 --reveal 前隐藏）')
  L.push('')
  L.push('| 指标 | 引擎① | 引擎② |')
  L.push('|---|---|---|')
  const row = (label, key, fmt = fmtNum) => L.push(`| ${label} | ${fmt(s.engine1[key])} | ${fmt(s.engine2[key])} |`)
  row('平均注入字数（检索块）', 'avgChars')
  row('平均完整注入字数', 'avgFullChars')
  row('平均条目数', 'avgItems')
  row('零命中查询数', 'empty')
  row('P50 检索耗时', 'p50Ms', v => fmtMs(v))
  row('P99 检索耗时', 'p99Ms', v => fmtMs(v))
  row('与本轮上下文重复条数（均）', 'avgRepeat')
  L.push('')
  L.push(`- 交集/独有（文本归一化后，按总查询累计）：完全重合 ${report.summary.intersection.exact} 条 · 近似重合 ${report.summary.intersection.near} 条 · 仅引擎① ${report.summary.intersection.v4Only} 条 · 仅引擎② ${report.summary.intersection.v5Only} 条`)
  L.push('')
  L.push('> 判读小抄（怎么快速判噪音）：')
  L.push('> - **过时**：条目里有「明天/下周/几点」但时间已过（有遗忘机制的引擎应该把它压掉）。')
  L.push('> - **别人的事**：主体不是这个 query 的人（跨通道召回最容易带进来的噪音）。')
  L.push('> - **重复**：一栏里 2 条以上在说同一件事（去冗余机制应该压掉的）。')
  L.push('> - **空泛**：只有程序记忆/规矩、和当前 query 完全接不上（摘要式注入占预算的典型症状）。')
  L.push('')
  if (report.options.reveal) {
    L.push('## 揭盲（判读完成后再看）')
    L.push('')
    L.push(`- 引擎① = ${report.reveal.engine1} · 引擎② = ${report.reveal.engine2}`)
    L.push(`- 输入副本：引擎① 库 = ${report.inputs.v4.path} · 引擎② 库 = ${report.inputs.v5.path} · 日志 = ${report.inputs.log.path}`)
    L.push(`- 口径：引擎① = 桥的真实 memoryRecallBlock（跨通道 top-${report.options.v4RecallTop} + digest）；引擎② = rankMemories + 预算 ${report.options.v5RetrievalBudget} 字（水位线 ${report.options.v5Context === 'window' ? '按日志窗口模拟' : '关闭'}）`)
    if (!report.v4Available) L.push(`- ⚠️ 引擎① 不可用：${report.v4Error}`)
    if (!report.v5Available) L.push(`- ⚠️ 引擎② 不可用：${report.v5Error}`)
    L.push('- 每查询 A/B 对应：')
    for (let i = 0; i < report.queries.length; i++) {
      const q = report.queries[i]
      L.push(`  - Q${String(i + 1).padStart(2, '0')}：A = ${q.blindMap ? q.blindMap.A : '?'}，B = ${q.blindMap ? q.blindMap.B : '?'}`)
    }
    L.push('')
  }
  return L.join('\n')
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
export async function runAb (opts) {
  const argv = parseArgs(opts.argv)
  const v4Path = path.resolve(argv.v4)
  const v5Path = path.resolve(argv.v5)
  const logPath = path.resolve(argv.log)
  const digestPath = argv.v4Digest ? path.resolve(argv.v4Digest) : null

  // 1) 只读守卫：默认拒绝生产路径
  for (const [flag, p] of [['--v4', v4Path], ['--v5', v5Path], ['--log', logPath], ['--v4-digest', digestPath]]) {
    if (p && isProdPath(p) && !argv.allowProdCopy) {
      process.stderr.write([
        `memory-ab: 拒绝直接读取生产路径（${flag}）：${p}`,
        '  · 先做副本：',
        '      cp ~/.dsh/dsh-plugin-llminqq/agent/memory/mem.db /tmp/mem.db',
        '      cp ~/.dsh/dsh-plugin-llminqq/agent/memory/digest.md /tmp/digest.md',
        '      cp ~/.dsh/dsh-plugin-llminqq/logs/bridge.out /tmp/bridge.out',
        '  · 确认那份「副本」就在生产目录下时，显式加 --allow-prod-copy（仍然只读）。',
        '',
      ].join('\n'))
      process.exit(2)
    }
  }
  for (const [flag, p] of [['--v4', v4Path], ['--v5', v5Path], ['--log', logPath], ['--v4-digest', digestPath]]) {
    if (p && !fs.existsSync(p)) usage(`${flag} 指向的文件不存在：${p}`)
  }

  const shaBefore = { v4: sha256(v4Path), v5: sha256(v5Path), log: sha256(logPath) }
  const logText = fs.readFileSync(logPath, 'utf8')
  const queries = extractQueries(logText, { limit: argv.limit, sample: argv.sample, seed: argv.seed })

  // 2) 侧初始化（失败不崩：记 error，另一侧照常输出）
  let v4e = null; let v4Error = null
  try {
    v4e = loadV4Evaluator({ v4Db: v4Path, digestPath, codeDir: argv.codeDir || MEMCTL_DIR, pythonBin: argv.python || 'python3' })
  } catch (err) { v4Error = String(err?.message ?? err) }

  let v5e = null; let v5Error = null
  try { v5e = await openV5Evaluator(v5Path) } catch (err) { v5Error = String(err?.message ?? err) }

  const rng = mulberry32(Number(argv.seed) || 1)
  const perQuery = []
  const intersection = { exact: 0, near: 0, v4Only: 0, v5Only: 0 }
  try {
  for (const q of queries) {
    const v4 = v4e ? runV4Side(v4e, q) : { ok: false, block: '', items: [], chars: 0, elapsedMs: 0, error: v4Error }
    const v5 = v5e ? runV5Side(v5e, q, { logText, v5Context: argv.v5Context }) : { ok: false, block: '', items: [], chars: 0, fullChars: 0, elapsedMs: 0, error: v5Error }
    v4.itemTexts = (v4.items ?? []).map(itemText)
    v5.itemTexts = (v5.items ?? []).map(itemText)
    const ctx = contextBefore(logText, q)
    if (v4.ok) v4.repeatCount = repeatCount(v4.items, ctx)
    if (v5.ok) v5.repeatCount = repeatCount(v5.items, ctx)
    const x = textIntersection(v4.items ?? [], v5.items ?? [])
    intersection.exact += x.exact
    intersection.near += x.near
    intersection.v4Only += x.v4Only
    intersection.v5Only += x.v5Only
    // 盲评：每查询随机决定 A 是哪边（可复现）；JSON 里保留引擎名以便机器分析
    const aIsV4 = rng() < 0.5
    const blindMap = aIsV4 ? { A: 'v4', B: 'v5' } : { A: 'v5', B: 'v4' }
    perQuery.push({
      id: q.idx,
      category: q.category,
      at: q.at,
      conv: q.conv,
      subject: q.subject,
      query: q.query,
      v4,
      v5,
      blindMap,
      blind: blindMap.A === 'v4'
        ? { A: { engine: 'v4', block: v4.block }, B: { engine: 'v5', block: v5.block } }
        : { A: { engine: 'v5', block: v5.block }, B: { engine: 'v4', block: v4.block } },
    })
  }
  } finally {
    // 临时 v5 副本一定要清（含查询中途抛错的情况）
    try { v5e?.cleanup() } catch { /* ignore */ }
  }

  // 3) 只读自证
  const shaAfter = { v4: sha256(v4Path), v5: sha256(v5Path), log: sha256(logPath) }
  const readOnly = {
    v4Unchanged: shaBefore.v4 === shaAfter.v4,
    v5Unchanged: shaBefore.v5 === shaAfter.v5,
    logUnchanged: shaBefore.log === shaAfter.log,
  }

  const engine1 = 'v4'; const engine2 = 'v5'
  const summary = {
    engine1: summarizeSide(perQuery.map(q => q.v4), {
      charsOf: e => Number(e.retrievalChars ?? charLen(e.block)),
      fullCharsOf: e => charLen(e.block),
    }),
    engine2: summarizeSide(perQuery.map(q => q.v5), {
      charsOf: e => charLen(e.block),
      fullCharsOf: e => Number(e.fullChars ?? charLen(e.block)),
    }),
    intersection,
  }

  const report = {
    generatedAt: new Date().toISOString(),
    options: {
      sample: argv.sample, seed: argv.seed, limit: argv.limit,
      v5Context: argv.v5Context, v5RetrievalBudget: V5_RETRIEVAL_BUDGET,
      v4RecallTop: V4_RECALL_TOP, contextWindow: CONTEXT_WINDOW_MESSAGES,
      reveal: argv.reveal,
    },
    inputs: {
      v4: { path: v4Path, sha256: shaBefore.v4, digest: v4e ? v4e.digestPath : null },
      v5: { path: v5Path, sha256: shaBefore.v5 },
      log: { path: logPath, sha256: shaBefore.log, bytes: fs.statSync(logPath).size },
    },
    v4Available: !!v4e,
    v4Error: v4Error || null,
    v5Available: !!v5e,
    v5Error: v5Error || null,
    readOnly,
    queries: perQuery,
    summary,
    reveal: argv.reveal ? { engine1, engine2 } : null,
  }

  if (!readOnly.v4Unchanged || !readOnly.v5Unchanged || !readOnly.logUnchanged) {
    process.stderr.write('memory-ab: ✗ 输入文件在运行前后 sha256 不一致 —— 脚本不该写任何库，请排查\n')
    process.exitCode = 1
  } else if (!argv.json) {
    process.exitCode = 0
  }
  if (argv.json) return report
  return report
}

export async function main (argv = process.argv.slice(2)) {
  const report = await runAb({ argv })
  if (argv.includes('--json')) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  } else {
    process.stdout.write(renderMarkdown(report) + '\n')
  }
  return report
}

// 只在被当脚本跑时执行（测试可以直接 import 上面的纯函数）
const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  main().catch(err => {
    process.stderr.write(`memory-ab: 未捕获错误：${err?.stack || err}\n`)
    process.exit(1)
  })
}
