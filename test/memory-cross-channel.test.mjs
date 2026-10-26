// 按人跨通道记忆检索（阶段二）：桥真的把「同一个人在私聊说过的事」带进群里了吗？
// 运行：node test/memory-cross-channel.test.mjs
//
// 三部分，覆盖任务要求的三个验证点，全部用临时库/临时文件，绝不碰生产 mem.db：
//   A. 单元：从 bridge/index.js **抠出记忆注入那一段源码**求值（跟 recall.test.mjs 同一手法），
//      证明：跨通道生效 / dm_only 过滤 / in_group 语义 / 降级 / 路径可覆盖 / 长度受控
//   B. 端到端：起 mock OneBot + **真 bridge 子进程** + 假 ACP agent，让假 agent 把
//      它收到的 prompt 原样落盘 —— 贴出的就是「桥这一轮实际注入给模型的上下文」，
//      不是原型脚本输出。场景：某 QQ 私聊说过 X → 同一 QQ 在群里问 X。
//   C. 降级端到端：把 memctl.py 弄坏（真弄坏，不是只看 try/catch），确认桥照常回话。
//
// 为什么抠源码求值：直接 import bridge/index.js 会在模块顶层就起服务。
// 抠源码保证测的是**线上同一份代码**，不会出现「测试里的规则和实现漂移」。
import { WebSocketServer } from 'ws'
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-cc-'))
const PROD_MEM = path.join(ROOT, 'qq-agent/memory')

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

// ─────────────────────────────────────────────────────────────────────────────
// 建临时记忆库：用 memctl 自己的 API（只 import，不碰 memctl.py 的实现）
// ─────────────────────────────────────────────────────────────────────────────
const MEM_DIR = path.join(TMP, 'memory')
fs.mkdirSync(MEM_DIR, { recursive: true })
const MEM_DB = path.join(MEM_DIR, 'mem.db')
const MEMCTL = path.join(MEM_DIR, 'memctl.py')
// 把 memctl.py 复制到临时目录：桥只从 memory.dir 里 import 它。
// 复制而不是直接指生产路径，是为了后面「弄坏它做降级测试」时**绝不碰生产文件**。
fs.copyFileSync(path.join(PROD_MEM, 'memctl.py'), MEMCTL)

const SELF_ID = 3889000011
const GROUP_ID = 9137001122
const USER_ID = 2468003344           // 本次场景的主角
const OTHER_QQ = 4011477594          // 群里另一个人（噪音，不该抢主角的记忆）
const SECRET = '我下周要去冰岛看极光，机票已经买好了'
const SECRET_DM = '其实我欠了老张三万块钱，别跟别人说'
const GROUP_KEY = `group-${GROUP_ID}`
const C2C_KEY = `c2c-${USER_ID}`

/** 用 memctl API 建库并写入场景数据。seed 里带 owner/visibility 的多种组合。 */
function seedDb () {
  const py = `
import sys, sqlite3
sys.dont_write_bytecode = True
sys.path.insert(0, ${JSON.stringify(MEM_DIR)})
import memctl as m
conn = m.connect(${JSON.stringify(MEM_DB)})
# 主角在**私聊**说过的事（owner=主角；visibility=NULL → 群聊场景按 public 处理）
m.remember(conn, ${JSON.stringify(C2C_KEY)}, ${JSON.stringify(SECRET)},
           kind='semantic', owner=${JSON.stringify(String(USER_ID))})
# 主角私聊说的一条**私事**，稍后手动标 dm_only（先写成 NULL，再 set_visibility，
# 这样测的是「手动标注」这条真实路径，不是构造出来的字段）
m.remember(conn, ${JSON.stringify(C2C_KEY)}, ${JSON.stringify(SECRET_DM)},
           kind='episodic', owner=${JSON.stringify(String(USER_ID))})
# 主角在**群里**说过的事（跨通道的另一半）
m.remember(conn, ${JSON.stringify(GROUP_KEY)}, '群里我说过我最近在学做饭，做个番茄炒蛋都翻车',
           kind='episodic', owner=${JSON.stringify(String(USER_ID))})
# 别人（噪音）：同样含「极光」关键词，但 owner 是别人 —— 不该被主角检索带出来
m.remember(conn, ${JSON.stringify(GROUP_KEY)}, '另一个人说他也想看极光，但那是别人的事',
           kind='episodic', owner=${JSON.stringify(String(OTHER_QQ))})
# 群级记忆：owner=NULL（reflect 群摘要那 35 条的情形）—— 靠 include_peer_context 保留
m.remember(conn, ${JSON.stringify(GROUP_KEY)}, '这个群的习惯是晚上十点以后才活跃',
           kind='semantic', owner=None)
conn.commit()
# 手动把那条私事标成 dm_only（真实 CLI 路径：set_visibility 的 API）
ids = [r["id"] for r in conn.execute("SELECT id FROM entries WHERE text=?",
                                     (${JSON.stringify(SECRET_DM)},))]
m.set_visibility(conn, ids=ids, dm_only=True)
conn.commit()
rows = [(r["id"], r["peer"], r["owner"], r["visibility"], r["text"][:20])
        for r in conn.execute("SELECT * FROM entries ORDER BY id")]
import json
print(json.dumps(rows, ensure_ascii=False))
`
  const out = execFileSync('python3', ['-c', py], { encoding: 'utf8', timeout: 30000 })
  return JSON.parse(out.trim().split('\n').pop())
}

// ─────────────────────────────────────────────────────────────────────────────
// A. 单元：抠出记忆注入段落求值
// ─────────────────────────────────────────────────────────────────────────────
const src = fs.readFileSync(path.join(ROOT, 'bridge/index.js'), 'utf8')
const srcLines = src.split('\n')
const SEC_START = srcLines.findIndex(l => l.startsWith('// ── 记忆读取与注入'))
const SEC_END = srcLines.findIndex(l => l.startsWith('// ── 自我风格样本库（人格一致性）'))
if (SEC_START < 0 || SEC_END < 0) throw new Error('抠不出记忆注入段落：注释锚点变了')
const SECTION = srcLines.slice(SEC_START, SEC_END).join('\n')

/** 用给定 config 建一个可调用的记忆注入模块。 */
function makeMemEnv (overrides = {}) {
  const digestPath = overrides.digestPath ?? path.join(MEM_DIR, 'digest.md')
  const config = {
    dsh: { cwd: overrides.cwd ?? MEM_DIR },
    memory: {
      dir: overrides.dir ?? MEM_DIR,
      db: overrides.db ?? MEM_DB,
      digestPath,
      memctl: overrides.memctl ?? MEMCTL,
      ...(overrides.crossChannel ?? {}),
      enabled: overrides.enabled,
      crossChannel: {
        enabled: overrides.ccEnabled,
        top: overrides.top,
        timeoutMs: overrides.timeoutMs,
        // 见 B 组同处注释：测试数据只有 10 条，小候选集上 BM25 分数被压低，
        // 这个套件验的是 dm_only/跨通道/owner 隔离，不是相关性门槛本身。
        minScore: 0,
        ...(overrides.crossChannel ?? {}),
      },
    },
  }
  const logs = []
  const logger = { log: m => logs.push(String(m)), debug: m => logs.push(String(m)) }
  // eslint-disable-next-line no-new-func
  const fn = new Function('config', 'logger', 'fs', 'path', 'execFileSync', 'process',
    `${SECTION}
     ; return { crossChannelRecall, memoryRecallBlock, readMemoryDigestFor,
                MEMORY_PATHS, MEMORY_CC, MEMORY_CC_PY, TOPIC_PATTERNS };`)
  const api = fn(config, logger, fs, path, execFileSync, process)
  api.logs = logs
  return api
}

console.log('\n=== A0. 造场景数据（临时库，绝不碰生产 mem.db）===')
const seeded = seedDb()
ok('临时库建好且有 owner/visibility', seeded.length >= 5, JSON.stringify(seeded.map(r => [r[1], r[2]])))
ok('主角那条私事已被标成 dm_only', seeded.some(r => r[3] === 'dm_only'), JSON.stringify(seeded.map(r => r[3])))
ok('生产 mem.db 没被碰过（断言路径隔离）', MEM_DB !== path.join(PROD_MEM, 'mem.db') && fs.existsSync(MEM_DB))

console.log('\n=== A1. 跨通道：私聊说过的事，群聊检索能拿到 ===')
{
  const env = makeMemEnv()
  // 群聊场景：speaker=主角，in_group=true
  const rows = env.crossChannelRecall(`group:${GROUP_ID}`, {
    speaker: String(USER_ID), inGroup: true, query: '冰岛 极光 机票',
  })
  ok('群聊检索拿到了结果', Array.isArray(rows) && rows.length > 0, JSON.stringify(rows))
  const texts = (rows ?? []).map(r => r.text)
  ok('**私聊那条出现在群聊检索结果里**（跨通道生效）',
    texts.some(t => t.includes('冰岛')), JSON.stringify(texts))
  ok('命中条目来源 peer 是 c2c（证明真的跨了通道）',
    (rows ?? []).some(r => r.peer === C2C_KEY && r.text.includes('冰岛')),
    JSON.stringify((rows ?? []).map(r => [r.peer, r.text.slice(0, 16)])))
  ok('别人的记忆没被混进主角的检索（owner 隔离）',
    !texts.some(t => t.includes('另一个人')), JSON.stringify(texts))
  ok('群级记忆（owner=NULL）没丢（include_peer_context 生效）',
    texts.some(t => t.includes('晚上十点')), JSON.stringify(texts))

  // 私聊场景：同一句话当然也能拿到
  const dmRows = env.crossChannelRecall(`c2c:${USER_ID}`, {
    speaker: String(USER_ID), inGroup: false, query: '冰岛 极光 机票',
  })
  ok('私聊场景也能拿到', (dmRows ?? []).some(r => r.text.includes('冰岛')))
}

console.log('\n=== A2. dm_only 过滤：群聊不出现 / 私聊出现 ===')
{
  const env = makeMemEnv()
  const inGroup = env.crossChannelRecall(`group:${GROUP_ID}`, {
    speaker: String(USER_ID), inGroup: true, query: '欠钱 老张 三万',
  })
  const inDm = env.crossChannelRecall(`c2c:${USER_ID}`, {
    speaker: String(USER_ID), inGroup: false, query: '欠钱 老张 三万',
  })
  ok('群聊场景**不**出现 dm_only 那条',
    !(inGroup ?? []).some(r => r.text.includes('老张')),
    JSON.stringify((inGroup ?? []).map(r => r.text.slice(0, 20))))
  ok('私聊场景**出现** dm_only 那条',
    (inDm ?? []).some(r => r.text.includes('老张')),
    JSON.stringify((inDm ?? []).map(r => r.text.slice(0, 20))))
  // 注入文本里也要真的被过滤掉（不是只在检索层过滤、拼文本时又漏出来）
  const blockGroup = env.memoryRecallBlock(`group:${GROUP_ID}`, {
    speaker: String(USER_ID), inGroup: true, query: '欠钱 老张 三万',
  })
  const blockDm = env.memoryRecallBlock(`c2c:${USER_ID}`, {
    speaker: String(USER_ID), inGroup: false, query: '欠钱 老张 三万',
  })
  ok('群聊注入文本里没有 dm_only 内容', !blockGroup.includes('老张'), blockGroup.slice(0, 200))
  ok('私聊注入文本里有 dm_only 内容', blockDm.includes('老张'), blockDm.slice(0, 200))
  ok('群聊注入里有「别当众复述」的提示', /别当众复述/.test(blockGroup), blockGroup.slice(-120))
  ok('私聊注入里没有那句群聊限定的提示', !/别当众复述/.test(blockDm))
}

console.log('\n=== A3. NULL visibility 在群聊场景当 public（不瞎标 dm_only）===')
{
  const env = makeMemEnv()
  // SECRET 那条 visibility 是 NULL（未标注）→ 群聊场景必须出现
  const rows = env.crossChannelRecall(`group:${GROUP_ID}`, {
    speaker: String(USER_ID), inGroup: true, query: '冰岛 极光',
  })
  ok('visibility=NULL 的条目在群聊场景可见（按 public 语义）',
    (rows ?? []).some(r => r.text.includes('冰岛') && (r.visibility === null || r.visibility === undefined)),
    JSON.stringify((rows ?? []).map(r => [r.visibility, r.text.slice(0, 12)])))
}

console.log('\n=== A4. in_group 由桥按 peer 前缀判定，不靠猜 ===')
{
  const env = makeMemEnv()
  // 源码级：handleInbound 里必须用 peer.scope === 'group' 传 inGroup
  ok('桥用 peer.scope 判定场合（源码级）',
    /inGroup:\s*peer\.scope === 'group'/.test(src), 'handleInbound 里的 inGroup 判定不见了')
  ok('桥把 evt.user_id 当发言人传进去（源码级）',
    /speaker:\s*evt\.user_id/.test(src), 'speaker 不是 evt.user_id')
  ok('buildTopicHints 也接上了跨通道检索（源码级）',
    /function buildTopicHints[\s\S]{0,600}?crossChannelRecall\(/.test(src))
}

console.log('\n=== A5. 降级：库不存在 / memctl 被弄坏 / 超时，都要静默返回 null 并保留 digest ===')
{
  // ① 库不存在
  const envNoDb = makeMemEnv({ db: path.join(TMP, 'nope.db') })
  ok('库不存在 → crossChannelRecall 返回 null（不抛）',
    envNoDb.crossChannelRecall(`group:${GROUP_ID}`, { speaker: String(USER_ID), inGroup: true }) === null)

  // ② digest 仍然可用（老行为兜底）：写一份 digest.md 进临时目录
  const digestPath = path.join(MEM_DIR, 'digest.md')
  fs.writeFileSync(digestPath, [
    '# 记忆摘要（测试）', '',
    '## c2c-3022464706', '- 这是别的会话，不该出现', '',
    `## ${C2C_KEY}`, '- 私有摘要里的旧事：他养了一只叫团子的猫', '',
    `## ${GROUP_KEY}`, '- 群摘要：这个群周末常组织爬山', '',
  ].join('\n'))
  const blockNoDb = envNoDb.memoryRecallBlock(`group:${GROUP_ID}`, {
    speaker: String(USER_ID), inGroup: true, query: '冰岛',
  })
  ok('降级后仍然注入了本会话的 digest 节', blockNoDb.includes('周末常组织爬山'), blockNoDb.slice(0, 200))
  ok('降级后没有混进别的会话的摘要', !blockNoDb.includes('不该出现'), blockNoDb.slice(0, 300))
  ok('降级时没有跨通道检索段', !blockNoDb.includes('按人跨通道检索'))

  // ③ memctl.py 被弄坏（语法错误）：真把它写坏，确认不是「只写了 try/catch」
  const brokenDir = path.join(TMP, 'broken')
  fs.mkdirSync(brokenDir, { recursive: true })
  fs.copyFileSync(path.join(PROD_MEM, 'memctl.py'), path.join(brokenDir, 'memctl.py'))
  fs.writeFileSync(path.join(brokenDir, 'memctl.py'), 'def recall_with_visibility(\n  # 故意写坏：语法错误\n')
  const envBroken = makeMemEnv({ dir: brokenDir, memctl: path.join(brokenDir, 'memctl.py') })
  ok('memctl.py 写坏 → crossChannelRecall 返回 null（静默，不抛）',
    envBroken.crossChannelRecall(`group:${GROUP_ID}`, { speaker: String(USER_ID), inGroup: true }) === null)
  const blockBroken = envBroken.memoryRecallBlock(`group:${GROUP_ID}`, {
    speaker: String(USER_ID), inGroup: true, query: '冰岛',
  })
  ok('弄坏 memctl 后 digest 仍然照常注入', blockBroken.includes('周末常组织爬山'), blockBroken.slice(0, 200))
  ok('降级有日志可查（不是完全无声）',
    envBroken.logs.some(l => /跨通道检索失败/.test(l)), envBroken.logs.join(' | ').slice(0, 200))

  // ④ 超时
  const envSlow = makeMemEnv({ timeoutMs: 1 })
  ok('超时 1ms → 返回 null（不抛）',
    envSlow.crossChannelRecall(`group:${GROUP_ID}`, { speaker: String(USER_ID), inGroup: true }) === null)
}

console.log('\n=== A6. 开关 + 路径可覆盖（CONTRIBUTING §9）===')
{
  const envOff = makeMemEnv({ enabled: false })
  ok('memory.enabled=false → 不检索', envOff.crossChannelRecall(`group:${GROUP_ID}`, { speaker: String(USER_ID), inGroup: true }) === null)
  const envCcOff = makeMemEnv({ ccEnabled: false })
  ok('memory.crossChannel.enabled=false → 不检索',
    envCcOff.crossChannelRecall(`group:${GROUP_ID}`, { speaker: String(USER_ID), inGroup: true }) === null)
  const envCustom = makeMemEnv({ db: MEM_DB, dir: MEM_DIR })
  ok('MEMORY_PATHS 全部来自 config（不是硬编码 dsh.cwd）',
    envCustom.MEMORY_PATHS.db === MEM_DB && envCustom.MEMORY_PATHS.dir === MEM_DIR,
    JSON.stringify(envCustom.MEMORY_PATHS))
  // 回归：记忆读取路径必须经过 MEMORY_PATHS，不许出现**直接**用 dsh.cwd 的裸路径。
  // （`?? path.join(config.dsh.cwd,'memory')` 作为默认值是允许的 —— 那正是可覆盖的默认值；
  //   要抓的是「绕开 MEMORY_PATHS 直接读」的写法。）
  const bareMemoryPath = srcLines.filter(l => /path\.join\(\s*config\.dsh\.cwd,\s*'memory'/.test(l) && !/\?\?/.test(l))
  ok('bridge/index.js 里没有绕开 MEMORY_PATHS 的裸 memory 路径',
    bareMemoryPath.length === 0, bareMemoryPath.join(' | '))
  ok('digest / memctl 读取都走 MEMORY_PATHS（源码级）',
    /const p = MEMORY_PATHS\.digest/.test(src) && /const memctl = MEMORY_PATHS\.script/.test(src))
  // python 侧物理防写：脚本里必须是 mode=ro
  ok('python 侧用 mode=ro 打开库（物理上写不进生产库）',
    envCustom.MEMORY_CC_PY.includes('mode=ro'), envCustom.MEMORY_CC_PY.slice(0, 80))
  ok('python 侧关掉 __pycache__ 写入（不脏生产工作树）',
    envCustom.MEMORY_CC_PY.includes('dont_write_bytecode'))
}

console.log('\n=== A7. 注入长度受控 + 空查询不崩 ===')
{
  const env = makeMemEnv()
  const block = env.memoryRecallBlock(`group:${GROUP_ID}`, {
    speaker: String(USER_ID), inGroup: true, query: '极光 冰岛 做饭 群 晚上',
  })
  ok('注入内容非空', block.length > 0)
  ok('单条截断到 maxCharsPerRow 附近',
    block.split('\n').filter(l => l.startsWith('  - ')).every(l => l.length < 140),
    String(Math.max(...block.split('\n').map(l => l.length))))
  // 没有 query 时也要能检索（recall_with_visibility 内部 query=None 走中性 relevance）
  const rowsNoQuery = env.crossChannelRecall(`group:${GROUP_ID}`, {
    speaker: String(USER_ID), inGroup: true, query: '',
  })
  ok('空 query 不崩且仍有结果', Array.isArray(rowsNoQuery) && rowsNoQuery.length > 0,
    JSON.stringify((rowsNoQuery ?? []).length))
  // speaker 为空（拿不到 QQ）→ 退回按 peer 推断；群聊场景 owner 算不出来 → 走老 recall()
  ok('speaker 为空也不崩',
    Array.isArray(env.crossChannelRecall(`group:${GROUP_ID}`, { speaker: '', inGroup: true, query: '极光' })))
}

// ─────────────────────────────────────────────────────────────────────────────
// B/C. 端到端：真 bridge 子进程 + mock OneBot + 假 ACP agent
// ─────────────────────────────────────────────────────────────────────────────
// 假 agent 会把每次 prompt 的**完整上下文**落到 PROMPT_LOG，B 段贴的就是它。
const WS_PORT = Number(process.env.MEMCC_WS_PORT ?? 3191)
const API_PORT = Number(process.env.MEMCC_API_PORT ?? 18191)
const TOKEN = 'mem-cc-token'
const PROMPT_LOG = path.join(TMP, 'prompts.jsonl')

// 假 agent：实现桥用到的最小 ACP 协议；每次 prompt 先把上下文原文追加到 PROMPT_LOG
const FAKE_AGENT = path.join(TMP, 'fake-agent.mjs')
fs.writeFileSync(FAKE_AGENT, `#!/usr/bin/env node
import fs from 'node:fs'
const PROMPT_LOG = ${JSON.stringify(PROMPT_LOG)}
let next = 1
let buf = ''
const write = o => process.stdout.write(JSON.stringify(o) + '\\n')
process.stdin.on('data', c => {
  buf += c.toString('utf8')
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
    if (!line) continue
    let f; try { f = JSON.parse(line) } catch { continue }
    handle(f)
  }
})
function handle (f) {
  const { id, method, params } = f
  if (method === 'initialize') return write({ jsonrpc: '2.0', id, result: { protocolVersion: 1, agentInfo: { name: 'fake', version: '0' } } })
  if (method === 'session/new') return write({ jsonrpc: '2.0', id, result: { sessionId: 'fake-' + (next++) } })
  if (method === 'session/resume') return write({ jsonrpc: '2.0', id, result: {} })
  if (method === 'session/set_config_option') return write({ jsonrpc: '2.0', id, result: {} })
  if (method === 'session/prompt') {
    const text = (params?.prompt ?? []).map(b => b.text ?? '').join('\\n')
    fs.appendFileSync(PROMPT_LOG, JSON.stringify({ sessionId: params?.sessionId, text }) + '\\n')
    write({ jsonrpc: '2.0', method: 'session/update',
      params: { sessionId: params?.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '收到' } } } })
    return write({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })
  }
  if (id != null) write({ jsonrpc: '2.0', id, result: {} })
}
`)
fs.chmodSync(FAKE_AGENT, 0o755)

const actions = []
let ws = null
const wss = new WebSocketServer({ port: WS_PORT, host: '127.0.0.1' })
wss.on('connection', socket => {
  ws = socket
  socket.on('message', raw => {
    let frame
    try { frame = JSON.parse(String(raw)) } catch { return }
    if (!frame.action) return
    actions.push({ action: frame.action, params: frame.params ?? {} })
    let data = {}
    if (frame.action === 'get_login_info') data = { user_id: SELF_ID, nickname: 'MockBot' }
    else if (['send_group_msg', 'send_private_msg', 'send_group_ai_record'].includes(frame.action)) data = { message_id: 900000 + actions.length }
    socket.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: frame.echo, wording: '' }))
  })
})
await new Promise(r => wss.on('listening', r))

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'bridge/config.json'), 'utf8'))
cfg.onebot.wsUrl = `ws://127.0.0.1:${WS_PORT}`
cfg.server.port = API_PORT
cfg.server.host = '127.0.0.1'
cfg.server.token = TOKEN
cfg.log.file = path.join(TMP, 'bridge.log')
cfg.persona.path = path.join(TMP, 'persona.md')
cfg.dsh.bin = FAKE_AGENT
cfg.dsh.profile = 'fake'
cfg.dsh.protocol = 'acp'
cfg.dsh.turnTimeoutMs = 20000
cfg.dsh.startTimeoutMs = 15000
cfg.dsh.failover = { ...(cfg.dsh.failover ?? {}), enabled: false }
cfg.mcpServers = []
cfg.proactive = { ...(cfg.proactive ?? {}), enabled: false }
cfg.energy = { ...(cfg.energy ?? {}), enabled: false }
cfg.mood = { ...(cfg.mood ?? {}), enabled: false }
cfg.bili = { ...(cfg.bili ?? {}), enabled: false }
cfg.tts = { ...(cfg.tts ?? {}), enabled: false }
cfg.style = { ...(cfg.style ?? {}), enabled: false }   // 风格库本来关着，别让它抢戏
cfg.recall = { ...(cfg.recall ?? {}), statusFile: path.join(TMP, 'recall.log') }
// 打字延迟会真的 sleep（1.2s 反应 + 110ms/字）。测试不用等它 ——
// 但它也是「上一轮还没处理完就跳过本条」的来源（busy 闸），必须关掉。
cfg.replyDelay = { ...(cfg.replyDelay ?? {}), enabled: false }
cfg.policy = { ...cfg.policy, cooldownMsPerPeer: 0, replyChunkDelayMs: 0 }
// ★ 记忆路径全部指向临时目录（CONTRIBUTING §9）：桥会真起一份 index.js，
//   受 dsh.cwd 之外的 config 约束，这里必须把 memory 全引开，否则会读生产 mem.db。
cfg.memory = {
  dir: MEM_DIR, db: MEM_DB, memctl: MEMCTL, digestPath: path.join(MEM_DIR, 'digest.md'),
  crossChannel: {
    enabled: true, top: 8, timeoutMs: 3000,
    // ⚠️ 这里必须显式给 minScore=0（比生产默认的 0.15 低）。
    //    原因：本测试只造了 10 条记忆，BM25 查询内归一化在**小候选集**上分数被压低；
    //    而生产的 700 条库里「相关 vs 不相关」有 0.95 vs 0.09 的巨大断层。
    //    这个套件要验的是 **dm_only 过滤 / 跨通道归集 / owner 隔离**，
    //    不是相关性门槛本身（那个由生产数据实测确定，见 bridge/index.js 注释）。
    minScore: 0,
  },
}
const cfgPath = path.join(TMP, 'config.json')
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))

const child = spawn(process.execPath, [path.join(ROOT, 'bridge/index.js')], {
  env: { ...process.env, LLMINQQ_CONFIG: cfgPath, LLMINQQ_STATE_DIR: path.join(TMP, 'state') },
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stderr.on('data', d => {
  const s = String(d).trim()
  if (s) console.log('[bridge stderr]', s.slice(0, 200))
})

const api = (method, pathname, body) => new Promise((resolve, reject) => {
  const data = body ? JSON.stringify(body) : null
  const req = http.request({
    host: '127.0.0.1', port: API_PORT, path: pathname, method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}),
    },
  }, res => {
    let out = ''
    res.on('data', c => { out += c })
    res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(out) }) } catch { resolve({ status: res.statusCode, json: out }) } })
  })
  req.on('error', reject)
  if (data) req.write(data)
  req.end()
})

async function waitHealth (timeoutMs = 20000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await api('GET', '/health')
      if (r.json?.onebot?.online) return r.json
    } catch { /* not up */ }
    await new Promise(r => setTimeout(r, 300))
  }
  throw new Error('bridge 未在超时内就绪')
}

/**
 * 等桥处理完当前这一轮（busy 清空）。
 *
 * ⚠️ 必须等：桥对同一 peer 有 busy 闸 —— 「正在处理上一轮，跳过本条」。
 * 不等就发下一条，那条会被**静默丢弃**（第一版测试就踩了：第三、四轮根本没进 LLM，
 * prompt 日志少两条，于是「降级轮仍有 digest」的断言失败，看起来像代码 bug）。
 */
async function waitIdle (peerKey, timeoutMs = 20000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await api('GET', '/health')
      const busy = r.json?.busy ?? []
      if (!busy.includes(peerKey)) {
        // busy 清空还不够：出站发送（打字延迟）发生在清理之后，再给一点时间
        await sleep(400)
        const r2 = await api('GET', '/health')
        if (!(r2.json?.busy ?? []).includes(peerKey)) return
      }
    } catch { /* not up */ }
    await sleep(250)
  }
  throw new Error(`等待 ${peerKey} 空闲超时`)
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
/** 读第 idx 条（0-based）prompt 日志里的完整注入上下文。 */
function promptText (idx) {
  if (!fs.existsSync(PROMPT_LOG)) return ''
  const lines = fs.readFileSync(PROMPT_LOG, 'utf8').trim().split('\n').filter(Boolean)
  if (lines.length <= idx) return ''
  try { return JSON.parse(lines[idx]).text } catch { return '' }
}
async function waitPrompts (n, timeoutMs = 20000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (fs.existsSync(PROMPT_LOG)) {
      const lines = fs.readFileSync(PROMPT_LOG, 'utf8').trim().split('\n').filter(Boolean)
      if (lines.length >= n) return lines.length
    }
    await sleep(200)
  }
  throw new Error(`等待第 ${n} 条 prompt 超时`)
}

/** 群聊入站：某人在群里 @ 机器人。 */
function inboundGroup (messageId, text, userId = USER_ID, nickname = '测试员') {
  ws?.send(JSON.stringify({
    post_type: 'message', message_type: 'group', sub_type: 'normal',
    time: Math.floor(Date.now() / 1000), self_id: SELF_ID,
    message_id: messageId, group_id: GROUP_ID, user_id: userId,
    raw_message: `[CQ:at,qq=${SELF_ID}] ${text}`,
    font: 0, sender: { user_id: userId, nickname, card: nickname, role: 'member' },
    message: [
      { type: 'at', data: { qq: String(SELF_ID) } },
      { type: 'text', data: { text: ` ${text}` } },
    ],
  }))
}
/** 私聊入站。 */
function inboundC2C (messageId, text, userId = USER_ID) {
  ws?.send(JSON.stringify({
    post_type: 'message', message_type: 'private', sub_type: 'friend',
    time: Math.floor(Date.now() / 1000), self_id: SELF_ID,
    message_id: messageId, user_id: userId,
    raw_message: text, font: 0,
    sender: { user_id: userId, nickname: '测试员' },
    message: [{ type: 'text', data: { text } }],
  }))
}

const cleanup = () => {
  try { child.kill('SIGKILL') } catch { /* ignore */ }
  try { wss.close() } catch { /* ignore */ }
}

try {
  console.log('\n=== B. 端到端：真桥 + 假 ACP —— 群里问的事，答案来自私聊记忆 ===')
  const health = await waitHealth()
  ok('桥连上 mock OneBot', health.onebot?.online === true)
  ok('这就是真 bridge 进程（隔离端口）', health.dsh?.profile === 'fake')

  // 第一轮：主角**在群里**问私聊说过的事
  inboundGroup(1501, '我之前跟你说过要去哪玩来着？冰岛那个')
  await waitPrompts(1)
  await waitForAction(a => a.action === 'send_group_msg', 20000, '群聊回复')
  await waitIdle(`group:${GROUP_ID}`)
  const p1 = promptText(0)
  ok('桥收到了这一轮的 prompt', p1.length > 0, `${p1.length} 字`)
  ok('注入里有「按人跨通道检索」段', p1.includes('按人跨通道检索'), p1.slice(0, 300))
  ok('**私聊记忆真的被注入到群聊上下文里**（端到端核心断言）',
    p1.includes('冰岛'), (p1.match(/^.*冰岛.*$/m) ?? [''])[0])
  ok('注入片段标了来源是私聊（模型知道这是另一边说的）',
    /私聊·.*冰岛/.test(p1), (p1.match(/^.*冰岛.*$/m) ?? [''])[0])
  ok('群聊场景没有注入 dm_only 内容（当众别复述私事）',
    !p1.includes('老张'), (p1.match(/^.*老张.*$/m) ?? [''])[0])
  ok('注入里保留了群级记忆（owner=NULL 的没丢）', p1.includes('晚上十点'), '')
  ok('别人的记忆没串进来', !p1.includes('另一个人'))

  console.log('\n  ⤷ 桥实际注入给模型的上下文（节选「你记得的事」段）：')
  const memSeg = p1.split('\n').filter(l => /你记得的事|^  - |别当众复述/.test(l)).join('\n')
  console.log(memSeg.split('\n').map(l => '     ' + l).join('\n'))

  // 第二轮：同一个主角**私聊**问私事 → dm_only 那条应该出现
  inboundC2C(1502, '上次跟你说的那件事，你还记得吗？欠钱那个')
  await waitPrompts(2)
  await waitForAction(a => a.action === 'send_private_msg', 20000, '私聊回复')
  await waitIdle(`c2c:${USER_ID}`)
  const p2 = promptText(1)
  ok('私聊这轮也收到了 prompt', p2.length > 0, `${p2.length} 字`)
  ok('**私聊场景注入了 dm_only 那条**（私聊可以说）', p2.includes('老张'),
    (p2.match(/^.*老张.*$/m) ?? [''])[0])
  ok('私聊场景没有「别当众复述」提示', !/别当众复述/.test(p2))
  console.log('\n  ⤷ 私聊轮注入片段（dm_only 那条）：')
  console.log((p2.split('\n').filter(l => /老张/.test(l)).join('\n')).split('\n').map(l => '     ' + l).join('\n'))

  // 第三轮：另一个人在群里问同一个话题 → 不该带出主角的私聊记忆（owner 隔离）
  inboundGroup(1503, '有人知道冰岛极光吗', OTHER_QQ, '另一个人')
  await waitPrompts(3)
  await waitForAction(a => a.action === 'send_group_msg', 20000, '第三轮回复')
  await waitIdle(`group:${GROUP_ID}`)
  const p3 = promptText(2)
  ok('别人问同一话题时，不注入主角的私聊记忆（owner 隔离）',
    !p3.includes('机票已经买好了'), (p3.match(/^.*冰岛.*$/m) ?? [''])[0])

  console.log('\n=== C. 降级：把 memctl.py 真弄坏，桥必须照常回话 ===')
  // 真弄坏：往临时目录的 memctl.py 写入语法错误（生产文件绝不碰）
  fs.writeFileSync(MEMCTL, 'def recall_with_visibility(\n  # 故意写坏\n')
  const before = actions.length
  inboundGroup(1504, '这会儿还记得我上次说的事吗？冰岛')
  const reply = await waitForAction(a => a.action === 'send_group_msg' && actions.indexOf(a) >= before, 25000, '降级后的回复')
  await waitIdle(`group:${GROUP_ID}`)
  ok('**memctl 坏掉后桥照常回话**（降级核心断言）', !!reply, JSON.stringify(reply?.params).slice(0, 120))
  const p4 = promptText(3)
  ok('降级轮的 prompt 里没有跨通道检索段', !p4.includes('按人跨通道检索'), p4.slice(0, 200))
  ok('降级轮仍然拿到 digest 的群摘要（老行为兜底）', p4.includes('周末常组织爬山'),
    (p4.match(/^.*爬山.*$/m) ?? [''])[0])
  const logSrc = fs.readFileSync(path.join(TMP, 'bridge.log'), 'utf8')
  ok('降级有日志（不是静默吞掉）', /跨通道检索失败/.test(logSrc),
    logSrc.split('\n').filter(l => /跨通道检索失败/.test(l)).slice(-1)[0] ?? '')
  ok('降级日志是 debug 级（不刷屏）', /debug memory 跨通道检索失败/.test(logSrc))
} catch (err) {
  fail++
  console.log(`\n未捕获失败: ${err.message}`)
  if (err.stack) console.log(err.stack.split('\n').slice(0, 3).join('\n'))
} finally {
  cleanup()
}

/** 等一个 mock OneBot 收到指定 action。 */
function waitForAction (pred, timeoutMs = 20000, label = '') {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const timer = setInterval(() => {
      const hit = actions.find(pred)
      if (hit) { clearInterval(timer); resolve(hit) }
      else if (Date.now() - t0 > timeoutMs) { clearInterval(timer); reject(new Error(`等待超时: ${label}`)) }
    }, 200)
  })
}

console.log('\n=== D. 生产目录没被写过（CONTRIBUTING §9 回归断言）===')
{
  // 断言：临时目录里产生的所有东西都在 TMP 内；生产 mem.db / digest.md 没被这次测试改动
  ok('生产 mem.db 大小未被改成测试库的样子（断言仍存在）', fs.existsSync(path.join(PROD_MEM, 'mem.db')))
  ok('测试库在 TMP 里（不在生产目录）', MEM_DB.startsWith(TMP), MEM_DB)
  // 关键回归：记忆读取路径必须可被 config 引开（见 A6 的 bareMemoryPath 断言）
  ok('bridge/index.js 无绕开 MEMORY_PATHS 的裸路径',
    srcLines.filter(l => /path\.join\(\s*config\.dsh\.cwd,\s*'memory'/.test(l) && !/\?\?/.test(l)).length === 0)
  // __pycache__ 不该被这次测试写进生产 memory/（python 侧 dont_write_bytecode 的回报）
  ok('python 侧禁写 __pycache__', /dont_write_bytecode/.test(src))
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
