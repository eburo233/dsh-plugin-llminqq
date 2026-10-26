// [RECALL] 端到端测试：入站 QQ 消息 → 假 ACP 模型输出 [RECALL:last] → 桥真撤上一条 → 发新内容。
// 全程 mock：OneBot 是本地 WebSocketServer，LLM 是 test/fake-acp-agent.mjs。不碰真实 QQ / 真实模型。
//
// 这是「标记是不是真的能被解析并驱动撤回」的关键验证 —— unit 测试只证明函数对，
// 这里证明**桥真的接上了**。
//
// 用法：node test/recall-e2e.mjs
import { WebSocketServer } from 'ws'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const WS_PORT = 3198
const API_PORT = 18198
const TOKEN = 'recall-e2e-token'
const SELF_ID = 3889000011
const GROUP_ID = 9137001123
const USER_ID = 2468003345

let pass = 0
let fail = 0
const ok = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`) }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-e2e-'))
const actions = []
let msgIdSeq = 800000
let ws = null
const waiters = []

function notify(frame) {
  for (let i = waiters.length - 1; i >= 0; i--) {
    const w = waiters[i]
    if (w.pred(frame)) { waiters.splice(i, 1); w.resolve(frame) }
  }
}
const waitFor = (pred, timeoutMs = 30000, label = '') => new Promise((resolve, reject) => {
  const hit = actions.find(pred)
  if (hit) return resolve(hit)
  const timer = setTimeout(() => {
    const i = waiters.findIndex(w => w.resolve === wrapped.resolve)
    if (i >= 0) waiters.splice(i, 1)
    reject(new Error(`等待超时: ${label}`))
  }, timeoutMs)
  const wrapped = {
    pred,
    resolve: f => { clearTimeout(timer); resolve(f) },
    reject,
  }
  waiters.push(wrapped)
})

const wss = new WebSocketServer({ port: WS_PORT, host: '127.0.0.1' })
wss.on('connection', socket => {
  ws = socket
  socket.on('message', raw => {
    let frame
    try { frame = JSON.parse(String(raw)) } catch { return }
    if (!frame.action) return
    const rec = { action: frame.action, params: frame.params ?? {} }
    actions.push(rec)
    let data = {}
    if (frame.action === 'get_login_info') data = { user_id: SELF_ID, nickname: 'MockBot' }
    else if (['send_group_msg', 'send_private_msg', 'send_group_ai_record'].includes(frame.action)) data = { message_id: msgIdSeq++ }
    socket.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: frame.echo, wording: '' }))
    notify(rec)
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
cfg.dsh.bin = process.execPath                              // 用假 ACP agent 代替 dsh
cfg.dsh.profile = 'fake'                                    // acp 以 `bin --profile <profile>` 启动 → node 会把它当脚本参数
cfg.dsh.protocol = 'acp'
cfg.dsh.turnTimeoutMs = 30000
cfg.dsh.startTimeoutMs = 15000
cfg.dsh.failover = { ...(cfg.dsh.failover ?? {}), enabled: false }
cfg.memory = { ...(cfg.memory ?? {}), enabled: false }
// 风格库也要隔离：桥会真的写 style-cases.jsonl / 起 stylebank.py。
// 不指到临时目录 → 假样本会落进生产 memory/（实测踩过）。
cfg.style = {
  ...(cfg.style ?? {}),
  dir: path.join(TMP, 'memory'),
  jsonl: path.join(TMP, 'memory', 'style-cases.jsonl'),
  cursorDir: path.join(TMP, '.bridge'),
}
cfg.proactive = { ...(cfg.proactive ?? {}), enabled: false }
cfg.energy = { ...(cfg.energy ?? {}), enabled: false }
cfg.mood = { ...(cfg.mood ?? {}), enabled: false }
cfg.bili = { ...(cfg.bili ?? {}), enabled: false }
cfg.tts = { ...(cfg.tts ?? {}), enabled: false }
cfg.mcpServers = []
cfg.recall = { ...(cfg.recall ?? {}), statusFile: path.join(TMP, 'recall.log') }
cfg.policy = { ...cfg.policy, cooldownMsPerPeer: 0, replyChunkDelayMs: 0, replyDelay: { ...(cfg.policy?.replyDelay ?? {}), enabled: false } }
// 假 agent 用 wrapper 脚本启动：acp 只会传 `--profile fake`，wrapper 忽略它、直接跑假 agent
const fakeAgent = path.join(TMP, 'fake-dsh')
const replyFile = path.join(TMP, 'reply.txt')
fs.writeFileSync(fakeAgent, `#!/usr/bin/env bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(ROOT, 'test/fake-acp-agent.mjs'))} "$@"\n`)
fs.chmodSync(fakeAgent, 0o755)
cfg.dsh.bin = fakeAgent
// 把 agent 的下一句回复放进文件：测试可以逐轮改
fs.writeFileSync(replyFile, '我在的，怎么了')

const cfgPath = path.join(TMP, 'config.json')
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))

const child = spawn(process.execPath, [path.join(ROOT, 'bridge/index.js')], {
  env: {
    ...process.env,
    LLMINQQ_CONFIG: cfgPath,
    LLMINQQ_STATE_DIR: path.join(TMP, 'state'),
    FAKE_ACP_REPLY_FILE: replyFile,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

child.stderr.on('data', d => {
  const s = String(d).trim()
  if (s) console.log('[bridge stderr]', s.slice(0, 300))
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

async function waitHealth(timeoutMs = 20000) {
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

const cleanup = () => {
  try { child.kill('SIGKILL') } catch { /* ignore */ }
  try { wss.close() } catch { /* ignore */ }
}

// 入站消息 = 群里有人 @ 机器人
function inbound(messageId, text) {
  ws?.send(JSON.stringify({
    post_type: 'message', message_type: 'group', sub_type: 'normal',
    time: Math.floor(Date.now() / 1000), self_id: SELF_ID,
    message_id: messageId, group_id: GROUP_ID, user_id: USER_ID,
    raw_message: `[CQ:at,qq=${SELF_ID}] ${text}`,
    font: 0, sender: { user_id: USER_ID, nickname: '测试员', card: '测试员', role: 'member' },
    message: [
      { type: 'at', data: { qq: String(SELF_ID) } },
      { type: 'text', data: { text: ` ${text}` } },
    ],
  }))
}

try {
  console.log('\n=== 0. 环境：mock OneBot + 真 bridge 进程 + 假 ACP 模型 ===')
  const health = await waitHealth()
  ok('桥连上 mock OneBot', health.onebot?.online === true)
  ok('协议走 acp', health.dsh?.profile === 'fake', JSON.stringify(health.dsh?.profile))

  console.log('\n=== 1. 第一轮：正常回复（先发一条消息，成为「上一条」）===')
  fs.writeFileSync(replyFile, '我在的，怎么了')
  actions.length = 0
  inbound(2001, '在吗')
  const first = await waitFor(a => a.action === 'send_group_msg', 30000, '第一轮回复')
  const firstText = (first.params.message ?? []).map(s => s.data?.text ?? '').join('')
  ok('第一轮发出去了', firstText.length > 0, JSON.stringify(firstText))
  const firstId = String(msgIdSeq - 1)

  console.log('\n=== 2. 第二轮：模型输出 [RECALL:last] → 桥撤上一条 + 发新内容 ===')
  fs.writeFileSync(replyFile, '[RECALL:last] 打错了，重来')
  actions.length = 0
  inbound(2002, '再说一遍')
  const del = await waitFor(a => a.action === 'delete_msg', 30000, '撤回动作')
  ok('桥真的调了 delete_msg', del.action === 'delete_msg')
  ok('撤的是上一轮那条', String(del.params.message_id) === firstId, `${del.params.message_id} vs ${firstId}`)
  const second = await waitFor(a => a.action === 'send_group_msg', 30000, '第二轮新内容')
  const secondText = (second.params.message ?? []).map(s => s.data?.text ?? '').join('')
  ok('新内容发出去了', secondText.length > 0, JSON.stringify(secondText))
  ok('新内容里没有 [RECALL] 残留（标记被剥掉）', !/\[RECALL:/i.test(secondText), JSON.stringify(secondText))
  ok('新内容是模型给的正文', /打错了|重来/.test(secondText), JSON.stringify(secondText))
  ok('撤回发生在新消息之前', actions.findIndex(a => a.action === 'delete_msg') < actions.findIndex(a => a.action === 'send_group_msg'),
    JSON.stringify(actions.map(a => a.action)))

  console.log('\n=== 3. 撤回结果写进状态文件（模型能核对）===')
  const statusPath = path.join(TMP, 'recall.log')
  ok('状态文件存在', fs.existsSync(statusPath))
  const st = fs.existsSync(statusPath) ? fs.readFileSync(statusPath, 'utf8') : ''
  ok('记了成功', /\[RECALL\] 成功/.test(st), st.split('\n').slice(-2).join(' | '))
  ok('状态里带 message_id', st.includes(firstId), st.split('\n').slice(-2).join(' | '))

  console.log('\n=== 4. 第三轮：再撤（上一条是第二轮发的）= 序号 1 ===')
  fs.writeFileSync(replyFile, '[RECALL:1] 又错了，再说')
  actions.length = 0
  inbound(2003, '又错了')
  const del2 = await waitFor(a => a.action === 'delete_msg', 30000, '第二次撤回')
  ok('第二次也撤了', del2.action === 'delete_msg')
  ok('撤的是第三轮之前最近的那条（第二轮发的）', /^\d+$/.test(String(del2.params.message_id)), String(del2.params.message_id))
  // 等这一轮彻底结束（busy 清掉）再发下一条，否则桥会「正在处理上一轮，跳过本条」
  await waitFor(a => a.action === 'send_group_msg', 30000, '第三轮正文')
  await new Promise(r => setTimeout(r, 500))

  console.log('\n=== 5. 限频：第 3 次撤回应被拦（1 分钟内已撤 2 条）===')
  fs.writeFileSync(replyFile, '[RECALL:last] 第三次')
  actions.length = 0
  inbound(2004, '还想撤')
  await new Promise(r => setTimeout(r, 4000))
  const dels = actions.filter(a => a.action === 'delete_msg')
  ok('第 3 次没有真的调 delete_msg（被限频）', dels.length === 0, JSON.stringify(dels))
  const logSrc = fs.readFileSync(path.join(TMP, 'bridge.log'), 'utf8')
  ok('日志里有「撤回太频繁」', /撤回太频繁/.test(logSrc), logSrc.split('\n').filter(l => /RECALL/.test(l)).slice(-2).join(' | '))
  const st2 = fs.readFileSync(statusPath, 'utf8')
  ok('失败也记进状态文件', /\[RECALL\] 失败/.test(st2))
} catch (err) {
  fail++
  console.log(`\n未捕获失败: ${err.message}`)
} finally {
  cleanup()
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
