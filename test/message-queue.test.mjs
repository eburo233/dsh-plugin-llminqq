// 连发消息不再被丢弃（task-9 核心修复）—— 真 bridge 子进程 + mock OneBot + 假 ACP。
//
// 修复前的 bug（已由生产日志证实，出现 43 次）：
//   `if (busy.has(peerKey)) { return }`  ← 模型回一条要 10-30 秒，
//   用户在这段时间连发 3-5 条，**第 2 条之后全被直接丢弃**，模型根本没见过。
//
// 本测试证明三件事：
//   A. 修复前行为（复现）：忙时到达的消息不进 prompt
//   B. 修复后：连发 4 条 → 4 条全都进 prompt（合并成一轮）
//   C. 队列上限 20：发 25 条只保留最新 20 条，且日志明确记下丢弃条数
//
// 关键手法：假 ACP agent 每轮**故意慢 2.5 秒**回复 —— 这样测试有稳定的窗口
// 在「上一轮还没处理完」时把后续消息塞进去。它还把收到的 prompt 原文落盘，
// 断言直接读落盘的 prompt，测的就是「桥到底给模型看了什么」。
//
// 用法：node test/message-queue.test.mjs
import { WebSocketServer } from 'ws'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-queue-'))
const WS_PORT = Number(process.env.MQ_WS_PORT ?? 3192)
const API_PORT = Number(process.env.MQ_API_PORT ?? 18192)
const TOKEN = 'msg-queue-token'
const SELF_ID = 3889000011
const GROUP_ID = 9137001122
const USER_ID = 2468003344
const PROMPT_LOG = path.join(TMP, 'prompts.jsonl')
const REPLY_DELAY_MS = 2500   // 假 ACP 每轮耗时：制造稳定的「忙」窗口

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── 假 ACP agent：慢回复 + prompt 原文落盘 ────────────────────────────────────
const FAKE_AGENT = path.join(TMP, 'fake-agent.mjs')
fs.writeFileSync(FAKE_AGENT, `#!/usr/bin/env node
import fs from 'node:fs'
const PROMPT_LOG = ${JSON.stringify(PROMPT_LOG)}
const DELAY = ${REPLY_DELAY_MS}
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
    fs.appendFileSync(PROMPT_LOG, JSON.stringify({ at: Date.now(), text }) + '\\n')
    // 故意慢：给测试留出「这一轮还在处理时继续发消息」的窗口
    setTimeout(() => {
      write({ jsonrpc: '2.0', method: 'session/update',
        params: { sessionId: params?.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '收到' } } } })
      write({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })
    }, DELAY)
    return
  }
  if (id != null) write({ jsonrpc: '2.0', id, result: {} })
}
`)
fs.chmodSync(FAKE_AGENT, 0o755)

// ── mock OneBot ──────────────────────────────────────────────────────────────
const actions = []
let ws = null
let msgSeq = 900000
const wss = new WebSocketServer({ port: WS_PORT, host: '127.0.0.1' })
wss.on('connection', socket => {
  ws = socket
  socket.on('message', raw => {
    let frame
    try { frame = JSON.parse(String(raw)) } catch { return }
    if (!frame.action) return
    actions.push({ action: frame.action, params: frame.params ?? {}, at: Date.now() })
    let data = {}
    if (frame.action === 'get_login_info') data = { user_id: SELF_ID, nickname: 'MockBot' }
    else if (['send_group_msg', 'send_private_msg'].includes(frame.action)) data = { message_id: msgSeq++ }
    socket.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: frame.echo, wording: '' }))
  })
})
await new Promise(r => wss.on('listening', r))

// ── 隔离 config：端口/状态/记忆/风格/打字延迟全部引开（CONTRIBUTING §9）──────
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
cfg.dsh.turnTimeoutMs = 30000
cfg.dsh.startTimeoutMs = 15000
cfg.dsh.failover = { ...(cfg.dsh.failover ?? {}), enabled: false }
cfg.mcpServers = []
cfg.proactive = { ...(cfg.proactive ?? {}), enabled: false }   // 主动搭话会干扰断言，关掉
cfg.energy = { ...(cfg.energy ?? {}), enabled: false }
cfg.mood = { ...(cfg.mood ?? {}), enabled: false }
cfg.bili = { ...(cfg.bili ?? {}), enabled: false }
cfg.tts = { ...(cfg.tts ?? {}), enabled: false }
cfg.style = { ...(cfg.style ?? {}), enabled: false }
cfg.learning = { ...(cfg.learning ?? {}), enabled: false }
cfg.recall = { ...(cfg.recall ?? {}), statusFile: path.join(TMP, 'recall.log') }
// 打字延迟会真的 sleep，且会让「忙」窗口结束得更晚 —— 这里关掉，靠假 ACP 的延迟控制节奏
cfg.replyDelay = { ...(cfg.replyDelay ?? {}), enabled: false }
cfg.policy = { ...cfg.policy, cooldownMsPerPeer: 0, replyChunkDelayMs: 0, pendingIngressMax: 20 }
// 记忆指向不存在的库 → 不注入记忆，断言只看消息本身（避免记忆文本干扰匹配）
cfg.memory = { ...(cfg.memory ?? {}), dir: path.join(TMP, 'memory'), db: path.join(TMP, 'memory', 'nope.db'),
  digestPath: path.join(TMP, 'memory', 'nope.md'), memctl: path.join(TMP, 'memory', 'nope.py'),
  crossChannel: { enabled: false } }
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
    await sleep(300)
  }
  throw new Error('bridge 未在超时内就绪')
}

/** 读所有已落盘的 prompt。 */
function allPrompts () {
  if (!fs.existsSync(PROMPT_LOG)) return []
  return fs.readFileSync(PROMPT_LOG, 'utf8').trim().split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
}
async function waitPrompts (n, timeoutMs = 40000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const p = allPrompts()
    if (p.length >= n) return p
    await sleep(150)
  }
  throw new Error(`等待第 ${n} 条 prompt 超时（现有 ${allPrompts().length}）`)
}

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

const cleanup = () => {
  try { child.kill('SIGKILL') } catch { /* ignore */ }
  try { wss.close() } catch { /* ignore */ }
}

try {
  console.log('\n=== 0. 环境：mock OneBot + 真 bridge + 慢速假 ACP（每轮 2.5s）===')
  const health = await waitHealth()
  ok('桥连上 mock OneBot', health.onebot?.online === true)
  ok('fake ACP 就绪（这轮慢回复制造的"忙"窗口是真的）', health.dsh?.profile === 'fake')

  console.log('\n=== A. 连发 4 条 → 4 条全都进 prompt（核心断言）===')
  ok('一开始 prompt 日志是空的（干净起点）', allPrompts().length === 0, String(allPrompts().length))
  // 第 1 条触发处理（假 ACP 要 2.5s 才回完）
  inboundGroup(3001, '第一句：今天好累啊')
  await sleep(400)   // 确保第 1 条已进入 busy
  // 在这 2.5 秒的窗口里连发 3 条
  inboundGroup(3002, '第二句：加班到十点')
  await sleep(150)
  inboundGroup(3003, '第三句：明天还得早起')
  await sleep(150)
  inboundGroup(3004, '第四句：不想上班了')

  // 第 1 轮 prompt（只含第 1 句）+ 排空后的第 2 轮（含第 2~4 句）
  const prompts = await waitPrompts(2, 45000)
  ok('第 1 轮 prompt 到了', prompts.length >= 1, String(prompts.length))

  const p1 = prompts[0].text
  ok('第 1 轮 prompt 里有第一句', p1.includes('今天好累啊'), p1.slice(-300))
  // 排空轮：合并后的第 2 轮
  const p2 = prompts[1].text
  const merged = prompts.slice(1).map(p => p.text).join('\n')
  ok('**第 2/3/4 句都没被丢**（修复核心）',
    ['加班到十点', '明天还得早起', '不想上班了'].every(s => merged.includes(s)),
    `合并轮里只有：${merged.includes('加班到十点') ? '' : '缺[加班到十点] '}${merged.includes('明天还得早起') ? '' : '缺[明天还得早起] '}${merged.includes('不想上班了') ? '' : '缺[不想上班了]'}`)
  ok('它们被合并进**同一轮**（不是每句一轮）', prompts.length === 2, `共 ${prompts.length} 轮`)

  console.log('\n=== B. 合并格式（贴真实注入片段）===')
  const mergeLines = p2.split('\n').filter(l => /连着发了几条|^\[\d{2}:\d{2}:\d{2}\]/.test(l))
  ok('有「他连着发了几条」的抬头', /他连着发了几条/.test(p2), mergeLines.join(' | '))
  ok('有带条数和时间跨度的说明', /（3 条，(\d+ 秒内|几秒内)）/.test(p2),
    (p2.match(/（3 条，[^）]*）/) ?? [''])[0])
  ok('每条都带 HH:MM:SS 时间戳', mergeLines.filter(l => /^\[\d{2}:\d{2}:\d{2}\]/.test(l)).length === 3,
    JSON.stringify(mergeLines))
  ok('时间戳顺序正确（先发在前）', (() => {
    const times = mergeLines.map(l => (l.match(/^\[(\d{2}:\d{2}:\d{2})\]/) ?? [])[1]).filter(Boolean)
    return times.length === 3 && times.every((t, i) => i === 0 || t >= times[i - 1])
  })(), JSON.stringify(mergeLines))
  ok('明确告诉模型「当成一个整体回应，别逐条点评」', /不要.*一句一句点评|当成一个整体的意思来回应/.test(p2), '')
  ok('私聊/单人连发不标人名（省 token）', !/\[15:.*测试员：/.test(p2), '')
  console.log('\n  ⤷ 桥实际注入的合并片段：')
  console.log(p2.split('\n').filter(l => /连着发了几条|^\[\d{2}:\d{2}:\d{2}\]|当成一个整体|不要.*点评/.test(l))
    .map(l => '     ' + l).join('\n'))

  console.log('\n=== C. 队列上限 20 条（发 25 条，只留最新 20）===')
  // 先等桥空闲，然后用第 1 条制造一个长的忙窗口，在这期间灌 25 条
  await sleep(REPLY_DELAY_MS + 1500)
  const beforePrompts = allPrompts().length
  inboundGroup(3100, '上限测试-触发句')
  await sleep(400)
  // 灌 25 条：编号 1..25，前 5 条应该被挤掉，后 20 条保留
  for (let i = 1; i <= 25; i++) {
    inboundGroup(3100 + i, `上限测试-第${i}条`)
    await sleep(30)
  }
  const prompts2 = await waitPrompts(beforePrompts + 1, 45000)
  // 等排空轮也落盘
  let pDrain = ''
  for (let i = 0; i < 60; i++) {
    const all = allPrompts()
    const mergedOne = all.slice(beforePrompts).map(p => p.text).join('\n')
    if (/上限测试-第20条/.test(mergedOne) || /上限测试-第20条/.test(mergedOne)) { pDrain = mergedOne; break }
    await sleep(300)
  }
  if (!pDrain) pDrain = allPrompts().slice(beforePrompts).map(p => p.text).join('\n')
  ok('第 25 条（最新的）进了 prompt', pDrain.includes('上限测试-第25条'), pDrain.slice(-400))
  ok('第 20 条也在（保留最新 20 条）', pDrain.includes('上限测试-第20条'), '')
  ok('**第 1 条被挤掉了**（超上限丢最旧）', !pDrain.includes('上限测试-第1条'),
    pDrain.match(/上限测试-第\d+条/g)?.slice(0, 8).join(' '))
  const logSrc = fs.readFileSync(path.join(TMP, 'bridge.log'), 'utf8')
  ok('日志明确记下丢弃条数（不静默）', /积压超过 20 条，丢弃最旧 \d+ 条/.test(logSrc),
    (logSrc.match(/积压超过 20 条[^\n]*/) ?? [''])[0])
  ok('日志说清了队列上限就是 20', (logSrc.match(/积压超过 (\d+) 条/) ?? [])[1] === '20', '')

  console.log('\n=== D. 排队期间的入站日志（证明不丢而非静默）===')
  const queueLogs = logSrc.split('\n').filter(l => /排队 group:9137001122: 本轮还在处理/.test(l))
  ok('每次入队都有 info 级日志', queueLogs.length >= 20, `${queueLogs.length} 条`)
  ok('日志里写了当前积压条数', /入队（积压 \d+ 条）/.test(queueLogs[0] ?? ''), queueLogs[0] ?? '')
  ok('**没有**旧的「跳过本条」丢弃日志', !/正在处理上一轮，跳过本条/.test(logSrc),
    (logSrc.match(/正在处理上一轮[^\n]*/) ?? [''])[0])
} catch (err) {
  fail++
  console.log(`\n未捕获失败: ${err.message}`)
  if (err.stack) console.log(err.stack.split('\n').slice(0, 3).join('\n'))
} finally {
  cleanup()
}

console.log('\n=== E. 生产目录没被写（CONTRIBUTING §9）===')
{
  const PROD_MEM = path.join(ROOT, 'qq-agent/memory')
  ok('测试库/日志都在 TMP 内', path.join(TMP, 'bridge.log').startsWith(TMP))
  ok('生产 memory/ 没有本测试的产物', !fs.existsSync(path.join(PROD_MEM, 'prompts.jsonl')))
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
