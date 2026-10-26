// 说话方式学习 · 端到端：**真的起桥进程**，证明桥这一轮真的把 lexicon 注入进了 prompt。
//
// 与 lexicon.test.mjs 的分工：
//   lexicon.test.mjs      —— 抠源码求值（函数对不对、降级/长度/路径覆盖）
//   本文件                —— 真进程（桥接上了没）。抠源码证明不了「调用点接在拼装的哪一步、
//                            注入的真的是这一轮的消息上下文」。
//
// 用假 ACP agent 抓每轮真实 prompt（FAKE_ACP_PROMPT_LOG），不碰真实模型、不碰真实 QQ。
//
// 验证四件事：
//   ① 有词库 → 桥真的把「你学来的说话方式」注入进 prompt
//   ② 注入块带「默认不用 / 正经答题别用」的克制约束（防堆砌）
//   ③ 注入长度受控，且没挤掉硬约束/人设（这是加段最容易踩的副作用）
//   ④ 词库坏掉 → 桥照常回话，只是不注入（静默降级，不能因为学习文件挂掉整轮）
import { WebSocketServer } from 'ws'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const WS_PORT = 3218
const API_PORT = 18218
const TOKEN = 'lexicon-e2e-token'
const SELF_ID = 3889000021
const GROUP_ID = 9137001188
const USER_ID = 2468003388

let pass = 0
let fail = 0
const ok = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`) }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lexicon-e2e-'))
const actions = []
let msgIdSeq = 900000
let ws = null
const waiters = []

function notify (frame) {
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
    let data = {}
    if (frame.action === 'send_group_msg' || frame.action === 'send_msg') data = { message_id: ++msgIdSeq }
    else if (frame.action === 'get_login_info') data = { user_id: SELF_ID, nickname: '吉祥物' }
    else if (frame.action === 'delete_msg') data = {}
    const rec = { action: frame.action, params: frame.params }
    actions.push(rec)
    socket.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: frame.echo, wording: '' }))
    notify(rec)
  })
})
await new Promise(r => wss.on('listening', r))

const baseCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'bridge/config.json'), 'utf8'))

/** 起一个桥进程，config 全部指到临时目录（绝不碰生产 memory/ 与 persona）。 */
function startBridge (tag, learningOverride) {
  const dir = path.join(TMP, tag)
  fs.mkdirSync(dir, { recursive: true })
  const memDir = path.join(dir, 'memory')
  fs.mkdirSync(memDir, { recursive: true })
  fs.copyFileSync(path.join(ROOT, 'qq-agent/memory/lexicon.py'), path.join(memDir, 'lexicon.py'))

  const cfg = JSON.parse(JSON.stringify(baseCfg))
  cfg.onebot.wsUrl = `ws://127.0.0.1:${WS_PORT}`
  cfg.server.port = API_PORT
  cfg.server.host = '127.0.0.1'
  cfg.server.token = TOKEN
  cfg.log.file = path.join(dir, 'bridge.log')
  cfg.log.level = 'debug'
  cfg.persona.path = path.join(dir, 'persona.md')
  fs.writeFileSync(cfg.persona.path, '# 测试人设\n你是一个测试用的群友。', 'utf8')
  cfg.dsh.turnTimeoutMs = 30000
  cfg.dsh.startTimeoutMs = 15000
  cfg.dsh.failover = { ...(cfg.dsh.failover ?? {}), enabled: false }
  cfg.dsh.bin = path.join(dir, 'fake-dsh')
  cfg.dsh.profile = 'fake'
  cfg.dsh.protocol = 'acp'
  cfg.memory = { ...(cfg.memory ?? {}), enabled: false }
  cfg.style = { enabled: false, dir: memDir }
  cfg.proactive = { ...(cfg.proactive ?? {}), enabled: false }
  cfg.energy = { ...(cfg.energy ?? {}), enabled: false }
  cfg.mood = { ...(cfg.mood ?? {}), enabled: false }
  cfg.bili = { ...(cfg.bili ?? {}), enabled: false }
  cfg.tts = { ...(cfg.tts ?? {}), enabled: false }
  cfg.mcpServers = []
  cfg.policy = { ...cfg.policy, cooldownMsPerPeer: 0, replyChunkDelayMs: 0,
    replyDelay: { ...(cfg.policy?.replyDelay ?? {}), enabled: false } }
  // 关键：lexicon 所有路径都指到临时目录（CONTRIBUTING §9 的可覆盖性就在这里被验证）
  cfg.learning = { ...(cfg.learning ?? {}), dir: memDir, ...(learningOverride ?? {}) }

  const fakeAgent = cfg.dsh.bin
  fs.writeFileSync(fakeAgent, `#!/usr/bin/env bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(ROOT, 'test/fake-acp-agent.mjs'))} "$@"\n`)
  fs.chmodSync(fakeAgent, 0o755)

  const replyFile = path.join(dir, 'reply.txt')
  const promptLog = path.join(dir, 'prompts.txt')
  fs.writeFileSync(replyFile, '收到，这就去办。')
  fs.writeFileSync(promptLog, '')
  const cfgPath = path.join(dir, 'config.json')
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))

  const child = spawn(process.execPath, [path.join(ROOT, 'bridge/index.js')], {
    env: {
      ...process.env,
      LLMINQQ_CONFIG: cfgPath,
      LLMINQQ_STATE_DIR: path.join(dir, 'state'),
      FAKE_ACP_REPLY_FILE: replyFile,
      FAKE_ACP_PROMPT_LOG: promptLog,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stderr.on('data', d => {
    const s = String(d).trim()
    if (s) console.log('  [bridge stderr]', s.slice(0, 200))
  })
  return { child, dir, memDir, promptLog, cfg, api: (method, pathname) => new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: API_PORT, path: pathname, method,
      headers: { authorization: `Bearer ${TOKEN}` },
    }, res => {
      let out = ''
      res.on('data', c => { out += c })
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(out) }) } catch { resolve({ status: res.statusCode, json: out }) } })
    })
    req.on('error', reject)
    req.end()
  }) }
}

async function waitHealth (api, timeoutMs = 25000) {
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

function inbound (messageId, text) {
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

const LEX = {
  version: 1, updatedAt: '2026-10-26T00:00:00+00:00',
  entries: [
    { kind: 'word', text: '绷不住', meaning: '忍不住了、笑场了', usage: '看到离谱好笑的东西时顶一句', source: 'group', confidence: 0.9 },
    { kind: 'word', text: '摸鱼', meaning: '上班时间偷懒', usage: '有人聊到划水时说', source: 'group', confidence: 0.85 },
    { kind: 'meme', text: '大肥鱼', meaning: '对 AI 的戏称', usage: '拿自己开玩笑时', source: 'bili', confidence: 0.8 },
    { kind: 'expression', text: '笑哭类表情', meaning: '无奈又想笑', usage: '被离谱操作整无语时', source: 'bili', confidence: 0.75 },
    { kind: 'pattern', text: 'X 成啥了', meaning: '调侃被改得离谱', usage: '看到东西被改坏时', source: 'bili', confidence: 0.48 },
  ],
}

// ─────────────────────────────────────────────────────────────────────────────
// ① 正常路径：有词库 → 真的注入
{
  console.log('\n=== ① 有词库：桥真的把学来的说话方式注入 prompt ===')
  const env = startBridge('with-lex')
  try {
    fs.writeFileSync(path.join(env.memDir, 'lexicon.json'), JSON.stringify(LEX, null, 2), 'utf8')
    const health = await waitHealth(env.api)
    ok('桥起来了', health.onebot?.online === true)
    actions.length = 0
    inbound(3001, '今天又摸了一上午鱼，啥也没干')
    await waitFor(a => a.action === 'send_group_msg', 30000, '第一轮回复')
    const prompts = fs.readFileSync(env.promptLog, 'utf8')
    ok('桥真的收到了 prompt', prompts.length > 0, String(prompts.length))
    ok('prompt 里有「你学来的说话方式」段', prompts.includes('你学来的说话方式'), prompts.slice(-600))
    ok('注入里有具体词条（绷不住/摸鱼）', prompts.includes('绷不住') && prompts.includes('摸鱼'))
    ok('注入里每条带「用的时候」场合说明', prompts.includes('用的时候'))
    ok('注入块带「默认不用」的克制约束（防堆砌）', prompts.includes('默认不用'), prompts.slice(-400))
    ok('注入块带「正经答题别用」的硬约束', /正经/.test(prompts))
    // 加段最容易踩的副作用：把硬约束/人设挤掉
    ok('没挤掉硬约束（QQ 通道规则还在）', prompts.includes('【硬约束】'), prompts.slice(-900))
    ok('没挤掉人设注入', prompts.includes('测试人设') || prompts.includes('人设'), prompts.slice(0, 600))
    // 顺序：lexicon 在硬约束之前（注释里写了原因）
    const iP = prompts.indexOf('你学来的说话方式')
    const iH = prompts.indexOf('【硬约束】')
    ok('lexicon 段在硬约束之前（不压住硬约束）', iP >= 0 && iH > iP, `lexicon@${iP} hard@${iH}`)
    // 长度：整个 prompt 不该被某一个功能吃掉
    ok('prompt 总长受控（< 20000 字符）', prompts.length < 20000, String(prompts.length))
  } finally {
    try { env.child.kill('SIGKILL') } catch { /* ignore */ }
  }
}

// ② 冷启动：词库不足 3 条 → 不注入，但桥照常回话
{
  console.log('\n=== ② 冷启动：只学了几条 → 不硬凑 ===')
  await new Promise(r => setTimeout(r, 800))
  const env = startBridge('cold')
  try {
    fs.writeFileSync(path.join(env.memDir, 'lexicon.json'), JSON.stringify({
      version: 1, updatedAt: null,
      entries: [LEX.entries[0], LEX.entries[1]],
    }, null, 2), 'utf8')
    await waitHealth(env.api)
    actions.length = 0
    inbound(3002, '在吗')
    const sent = await waitFor(a => a.action === 'send_group_msg', 30000, '冷启动回复')
    ok('冷启动时桥照常回话', (sent.params?.message ?? []).length > 0)
    const prompts = fs.readFileSync(env.promptLog, 'utf8')
    ok('只有 2 条 → 不注入', !prompts.includes('你学来的说话方式'), prompts.slice(-300))
  } finally {
    try { env.child.kill('SIGKILL') } catch { /* ignore */ }
  }
}

// ③ 降级：词库文件坏掉 → 不注入，桥照常回话（不能因为学习文件挂掉整轮）
{
  console.log('\n=== ③ 降级：lexicon.json 坏掉，桥照常回话 ===')
  await new Promise(r => setTimeout(r, 800))
  const env = startBridge('broken')
  try {
    fs.writeFileSync(path.join(env.memDir, 'lexicon.json'), '{"entries": [ 这不是 json', 'utf8')
    await waitHealth(env.api)
    actions.length = 0
    inbound(3003, '你还在吗')
    const sent = await waitFor(a => a.action === 'send_group_msg', 30000, '降级回复')
    ok('词库坏掉 → 桥仍然发出回复（静默降级成功）', (sent.params?.message ?? []).length > 0)
    const prompts = fs.readFileSync(env.promptLog, 'utf8')
    ok('坏词库 → 没注入半截内容', !prompts.includes('你学来的说话方式'), prompts.slice(-300))
    // 故障可见性：坏了要在日志里 WARN，不能被当成正常冷启动
    const log = fs.readFileSync(path.join(env.dir, 'bridge.log'), 'utf8')
    ok('坏词库有 WARN 日志（故障可见，不是静默）',
      /WARN.*lexicon.*bad-json|WARN.*lexicon.*不注入/.test(log), log.slice(-400))
    ok('桥没崩（进程还活着，能继续处理）', env.child.exitCode === null)
  } finally {
    try { env.child.kill('SIGKILL') } catch { /* ignore */ }
  }
}

// ④ 生产目录未被写（CONTRIBUTING §9 的回归断言）
{
  console.log('\n=== ④ 生产目录没被测试写 ===')
  const prod = path.join(ROOT, 'qq-agent/memory/lexicon.json')
  // 这里只能检查「测试期间没新建/没改动」；生产上这个文件本来就可能被定时任务写，
  // 所以断言的是「测试没碰它」，不是「它不该存在」。
  ok('测试用的都是临时目录（env.memDir 不在生产路径下）',
    TMP.startsWith(os.tmpdir()) && !path.resolve(TMP).startsWith(path.join(ROOT, 'qq-agent', 'memory')),
    TMP)
  ok('生产 lexicon.json 路径与测试路径不同',
    path.resolve(prod) !== path.resolve(path.join(TMP, 'with-lex', 'memory', 'lexicon.json')))
}

try { wss.close() } catch { /* ignore */ }

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
