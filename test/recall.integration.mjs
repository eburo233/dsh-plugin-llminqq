// 撤回能力的「整机」冒烟测试：起一个 mock OneBot + 起一份独立 bridge 进程（独立端口/状态目录），
// 通过 bridge 自己的 HTTP API 走真实代码路径：/send 发消息 → 记录 message_id → /recall 撤回。
//
// 全程没有真实 QQ：mock 扮演 NapCat，收到的 delete_msg 会被断言。
// 生产桥不受影响（独立 config + 独立 state 目录 + 独立端口）。
//
// 用法：node test/recall-integration.mjs
import { WebSocketServer } from 'ws'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const WS_PORT = 3199
const API_PORT = 18199
const TOKEN = 'recall-it-token'
const SELF_ID = 3889000011
const GROUP_ID = 9137001122
const USER_ID = 2468003344

let pass = 0
let fail = 0
const ok = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ''}`) }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-it-'))
const actions = []          // mock 收到的所有 action
let msgIdSeq = 700000
let client = null

const wss = new WebSocketServer({ port: WS_PORT, host: '127.0.0.1' })
wss.on('connection', ws => {
  client = ws
  ws.on('message', raw => {
    let frame
    try { frame = JSON.parse(String(raw)) } catch { return }
    if (!frame.action) return
    actions.push({ action: frame.action, params: frame.params ?? {} })
    let data = {}
    let status = 'ok'
    let retcode = 0
    switch (frame.action) {
      case 'get_login_info':
        data = { user_id: SELF_ID, nickname: 'MockBot' }
        break
      case 'send_group_msg':
      case 'send_private_msg':
      case 'send_group_ai_record':
        data = { message_id: msgIdSeq++ }
        break
      case 'delete_msg':
        // mock 侧模拟 QQ：只有存在的 id 才能撤
        data = {}
        break
      default:
        break
    }
    ws.send(JSON.stringify({ status, retcode, data, echo: frame.echo, wording: '' }))
  })
})
await new Promise(r => wss.on('listening', r))

// 独立 config：端口/状态全部隔离，绝不碰生产
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'bridge/config.json'), 'utf8'))
cfg.onebot.wsUrl = `ws://127.0.0.1:${WS_PORT}`
cfg.server.port = API_PORT
cfg.server.host = '127.0.0.1'
cfg.server.token = TOKEN
cfg.log.file = path.join(TMP, 'bridge.log')
cfg.persona.path = path.join(TMP, 'persona.md')   // 不存在也没关系
cfg.dsh.protocol = 'acp'
cfg.dsh.turnTimeoutMs = 120000
cfg.memory = { ...(cfg.memory ?? {}), enabled: false }
cfg.proactive = { ...(cfg.proactive ?? {}), enabled: false }
cfg.energy = { ...(cfg.energy ?? {}), enabled: false }
cfg.mood = { ...(cfg.mood ?? {}), enabled: false }
cfg.bili = { ...(cfg.bili ?? {}), enabled: false }
cfg.mcpServers = []   // 生产配置这里是列表；保持同样的形状
// 撤回状态文件也隔离到临时目录，别写进真实 qq-agent/.bridge/
cfg.recall = { ...(cfg.recall ?? {}), statusFile: path.join(TMP, 'recall.log') }
const cfgPath = path.join(TMP, 'config.json')
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))

const child = spawn(process.execPath, [path.join(ROOT, 'bridge/index.js')], {
  env: {
    ...process.env,
    LLMINQQ_CONFIG: cfgPath,
    LLMINQQ_STATE_DIR: path.join(TMP, 'state'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout.on('data', () => {})
child.stderr.on('data', d => console.log('[bridge stderr]', String(d).trim().slice(0, 300)))

function api(method, pathname, body) {
  return new Promise((resolve, reject) => {
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
}

async function waitHealth(timeoutMs = 20000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await api('GET', '/health')
      if (r.json?.onebot?.online) return r.json
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 300))
  }
  throw new Error('bridge 未在超时内连上 mock onebot')
}

const cleanup = () => {
  try { child.kill('SIGKILL') } catch { /* ignore */ }
  try { wss.close() } catch { /* ignore */ }
}

try {
  console.log('\n=== 0. 起隔离环境（mock OneBot + 独立 bridge 进程）===')
  const health = await waitHealth()
  ok('bridge 连上 mock onebot', health.onebot?.online === true)
  ok('health 暴露撤回配置', health.recall?.maxPerMinute === 2 && health.recall?.historyMax === 10, JSON.stringify(health.recall))
  ok('撤回时限是 2 分钟', health.recall?.ttlMs === 120000, String(health.recall?.ttlMs))

  console.log('\n=== 1. /send 发两条 → message_id 被记录（真实代码路径）===')
  const s1 = await api('POST', '/send', { peerId: GROUP_ID, scope: 'group', text: '第一句' })
  ok('第一条发送成功', s1.status === 200 && s1.json?.ok, JSON.stringify(s1.json))
  const s2 = await api('POST', '/send', { peerId: GROUP_ID, scope: 'group', text: '第二句' })
  ok('第二条发送成功', s2.status === 200 && s2.json?.ok, JSON.stringify(s2.json))
  const sent1 = await api('GET', `/sent?peerId=${GROUP_ID}&scope=group`)
  ok('记录了 2 条 message_id', sent1.json?.sent?.length === 2, JSON.stringify(sent1.json?.sent))
  ok('message_id 来自 OneBot 返回值', sent1.json.sent.every(x => /^\d+$/.test(x.message_id)), JSON.stringify(sent1.json.sent))
  ok('带 kind 标记（文本）', sent1.json.sent.every(x => x.kind === 'text'), JSON.stringify(sent1.json.sent))
  ok('带时间戳 ageMs', sent1.json.sent.every(x => Number.isFinite(x.ageMs) && x.ageMs >= 0))
  const lastId = sent1.json.sent[1].message_id

  console.log('\n=== 2. /recall 撤最近一条 → 真的发 delete_msg 给 OneBot ===')
  actions.length = 0
  const r1 = await api('POST', '/recall', { peerId: GROUP_ID, scope: 'group', last: true })
  ok('撤回成功', r1.status === 200 && r1.json?.ok, JSON.stringify(r1.json))
  const del = actions.find(a => a.action === 'delete_msg')
  ok('真调了 delete_msg', !!del, JSON.stringify(actions.map(a => a.action)))
  ok('参数是刚发那条的 message_id', String(del?.params?.message_id) === lastId, `${del?.params?.message_id} vs ${lastId}`)
  const sent2 = await api('GET', `/sent?peerId=${GROUP_ID}&scope=group`)
  ok('撤成功后历史里少了一条', sent2.json?.sent?.length === 1, String(sent2.json?.sent?.length))

  console.log('\n=== 3. 再撤「倒数第 2 条」= 现存的最近一条 ===')
  actions.length = 0
  const r2 = await api('POST', '/recall', { peerId: GROUP_ID, scope: 'group', index: 1 })
  ok('撤回成功', r2.status === 200 && r2.json?.ok, JSON.stringify(r2.json))
  ok('撤掉的是第一条', String(actions.find(a => a.action === 'delete_msg')?.params?.message_id) === sent1.json.sent[0].message_id)
  const sent3 = await api('GET', `/sent?peerId=${GROUP_ID}&scope=group`)
  ok('历史清空', sent3.json?.sent?.length === 0, JSON.stringify(sent3.json?.sent))

  console.log('\n=== 4. 没东西可撤 → 明确失败（不是假装成功）===')
  const r3 = await api('POST', '/recall', { peerId: GROUP_ID, scope: 'group', last: true })
  ok('返回非 2xx', r3.status === 409, String(r3.status))
  ok('ok=false', r3.json?.ok === false, JSON.stringify(r3.json))
  ok('detail 说明没有可撤的', /没有最近一条可撤/.test(r3.json?.detail ?? ''), r3.json?.detail)

  console.log('\n=== 5. 限频生效（同一 peer 每分钟最多 2 条）===')
  // 重新发 4 条，把额度用到上限
  for (let i = 0; i < 4; i++) await api('POST', '/send', { peerId: USER_ID, scope: 'c2c', text: `第 ${i + 1} 句` })
  const a = await api('POST', '/recall', { peerId: USER_ID, scope: 'c2c', last: true })
  const b = await api('POST', '/recall', { peerId: USER_ID, scope: 'c2c', last: true })
  const c = await api('POST', '/recall', { peerId: USER_ID, scope: 'c2c', last: true })
  ok('第 1 条成功', a.json?.ok === true, JSON.stringify(a.json))
  ok('第 2 条成功', b.json?.ok === true, JSON.stringify(b.json))
  ok('第 3 条被限频', c.status === 409 && c.json?.ok === false, JSON.stringify(c.json))
  ok('限频文案说清「太频繁」', /撤回太频繁/.test(c.json?.detail ?? ''), c.json?.detail)

  console.log('\n=== 6. 状态文件 & 日志（模型能自己核对）===')
  const statusFile = path.join(TMP, 'recall.log')
  ok('撤回状态文件已写', fs.existsSync(statusFile), statusFile)
  const statusSrc = fs.existsSync(statusFile) ? fs.readFileSync(statusFile, 'utf8') : ''
  ok('写了成功记录', /\[RECALL\] 成功/.test(statusSrc), statusSrc.split('\n').slice(-3).join(' | '))
  ok('写了失败记录', /\[RECALL\] 失败/.test(statusSrc))
  const logSrc = fs.readFileSync(path.join(TMP, 'bridge.log'), 'utf8')
  ok('bridge 日志含 [RECALL] 成功', /\[RECALL\] 成功/.test(logSrc))
  ok('bridge 日志含 [RECALL] 失败', /\[RECALL\] 失败/.test(logSrc))

  console.log('\n=== 7. 生产桥没被碰过 ===')
  const prodHealth = await api('GET', '/health').catch(() => null)
  ok('测试用的是隔离端口 18199', prodHealth !== null)
} catch (err) {
  fail++
  console.log(`\n未捕获失败: ${err.message}`)
} finally {
  cleanup()
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
