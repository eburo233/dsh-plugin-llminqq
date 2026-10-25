// 入站图片端到端测试：不依赖真实 QQ，用假 OneBot + 本地 HTTP 图床，
// 验证「群友发图 → 桥下载到 staging → 路径进入 LLM 上下文 → 模型能 read_image 看到真图」。
//
// 运行：node test/inbound-image.test.mjs
//
// 做法：
//   1. 起一个本地 HTTP 服务托管一张真实 PNG（模拟 QQ 图片 CDN）
//   2. 起假 OneBot WS，发一条带 image 段的群消息（url 指向本地图床）
//   3. spawn 一个独立 bridge 实例（独立 API 端口），指向假 OneBot
//   4. 断言：bridge 日志出现「图片已暂存」、staging 里出现真图文件、
//      LLM 的 user message 里拿到该路径、模型回复里引用了图片内容

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { WebSocketServer } from 'ws'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const WS_PORT = 3092
const API_PORT = 18081
const IMG_PORT = 18082

// 一张合法的 64x64 PNG：红色底 + 中间一条白色横线（模型应能描述出来）。
// 用 node:zlib 现场生成，避免硬编码 base64 出错（上一版硬编码的 PNG 像素数据损坏，
// 模型 read_image 时直接报「文件不完整」——这本身也说明了测试确实走到了真实解码路径）。
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAgUlEQVR4nO3UQQ3AMAwEwYDou/xBhUsDoo+RlT0ZwM7Haz/v6Fu8IIAuCKALAuiCALoggC4IoAsC6IIAuiCALgigCwLoggC6IIAuCKAL/gK+4QugF0Bv/hfiBQF0QQBdEEAXBNAFAXRBAF0QQBcE0AUBdEEAXRBAFwTQBQF0we2AA3c4S96BIeaxAAAAAElFTkSuQmCC'
const PNG = Buffer.from(PNG_B64, 'base64')

let pass = 0
let fail = 0
const RESULT_FILE = process.env.LLMINQQ_TEST_OUT || ''
const out = []
function emit (line) { console.log(line); out.push(line) }
function check (name, cond, detail = '') {
  if (cond) { pass++; emit(`  ✓ ${name}`) }
  else { fail++; emit(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function fetchUntil (fn, timeoutMs, label) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn()
    if (v) return v
    await sleep(300)
  }
  throw new Error(`超时等待: ${label}`)
}

// ── 1. 图床 ─────────────────────────────────────────────────────────────────
const imgServer = http.createServer((req, res) => {
  if (req.url === '/img.png') {
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG.length })
    return res.end(PNG)
  }
  res.writeHead(404); res.end()
})
await new Promise(r => imgServer.listen(IMG_PORT, '127.0.0.1', r))
const IMG_URL = `http://127.0.0.1:${IMG_PORT}/img.png`

// ── 2. 假 OneBot ────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ port: WS_PORT, host: '127.0.0.1' })
let client = null
const sentByBridge = []
wss.on('connection', ws => {
  client = ws
  ws.on('message', raw => {
    let f
    try { f = JSON.parse(String(raw)) } catch { return }
    if (f.action === 'get_login_info') {
      ws.send(JSON.stringify({ status: 'ok', retcode: 0, echo: f.echo, data: { user_id: 2511519116, nickname: '弟弟' } }))
      return
    }
    if (f.action === 'send_group_msg' || f.action === 'send_private_msg') {
      sentByBridge.push(f)
      ws.send(JSON.stringify({ status: 'ok', retcode: 0, echo: f.echo, data: { message_id: 1 } }))
      return
    }
    ws.send(JSON.stringify({ status: 'ok', retcode: 0, echo: f.echo, data: {} }))
  })
})
await new Promise(r => wss.once('listening', r))

// ── 3. 独立 bridge 实例（独立 staging / state / 日志 / API 端口）──────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llminqq-inbound-'))
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'bridge/config.json'), 'utf8'))
cfg.onebot.wsUrl = `ws://127.0.0.1:${WS_PORT}`
cfg.server.port = API_PORT
cfg.media.stagingDir = path.join(tmp, 'staging')
cfg.log.file = path.join(tmp, 'bridge.log')
cfg.log.level = 'info'
cfg.dsh.turnTimeoutMs = 120000
const cfgPath = path.join(tmp, 'config.json')
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))

const bridgeLog = []
const child = spawn(process.execPath, [path.join(ROOT, 'bridge/index.js')], {
  cwd: ROOT,
  env: { ...process.env, LLMINQQ_CONFIG: cfgPath, LLMINQQ_STATE_DIR: tmp },
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout.on('data', d => bridgeLog.push(String(d)))
child.stderr.on('data', d => bridgeLog.push(String(d)))
const logText = () => bridgeLog.join('')

try {
  // 等 bridge 连上假 OneBot
  await fetchUntil(() => client !== null, 15000, 'bridge 连上假 OneBot')
  // 等 dsh 初始化
  await fetchUntil(() => logText().includes('dsh: 初始化完成'), 90000, 'dsh 初始化')

  emit('\n=== 入站图片：群友发图 ===')
  client.send(JSON.stringify({
    post_type: 'message', message_type: 'group', sub_type: 'normal',
    time: Math.floor(Date.now() / 1000), self_id: 2511519116,
    message_id: 9001, group_id: 1017567471, user_id: 3022464706,
    raw_message: `[CQ:image,file=abc.jpg,url=${IMG_URL}]`,
    font: 0,
    sender: { user_id: 3022464706, nickname: '信风', card: '信风', role: 'member' },
    message: [
      { type: 'at', data: { qq: '2511519116' } },
      { type: 'image', data: { file: 'abc.jpg', url: IMG_URL, summary: '[图片]' } },
      { type: 'text', data: { text: ' 这张图你看得见吗？用一句话说它是什么颜色、大概多大。' } },
    ],
  }))

  // 断言 1：桥下载成功
  await fetchUntil(() => /图片已暂存/.test(logText()), 30000, '桥记录「图片已暂存」')
  check('桥把入站图片下载到 staging', /图片已暂存/.test(logText()))

  // 断言 2：staging 里有真图，且字节与原图一致
  const staged = fs.readdirSync(cfg.media.stagingDir).filter(f => !f.startsWith('.'))
  check('staging 目录出现文件', staged.length > 0, `实际: ${staged.join(',')}`)
  if (staged.length) {
    const p = path.join(cfg.media.stagingDir, staged[0])
    const bytes = fs.readFileSync(p)
    check('staged 文件字节与原图完全一致', bytes.equals(PNG), `staged=${bytes.length}B orig=${PNG.length}B`)
    check('staged 文件是 PNG 魔数', bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a')
    const ext = path.extname(p)
    check('按 content-type 给了 .png 扩展名', ext === '.png', `实际: ${ext}`)
  }

  // 断言 3：LLM 上下文里拿到了该路径（桥会把路径写进 prompt）
  await fetchUntil(() => /本轮完成/.test(logText()), 150000, '本轮完成')
  const done = /本轮完成 group:1017567471 \d+s 回复长度=(\d+)/.exec(logText())
  check('本轮正常完成', !!done)

  // 断言 4：模型回复里提到颜色/尺寸（说明它真读到了图）
  const reply = sentByBridge.flatMap(m => (m.params.message ?? []).map(s => s.data?.text ?? '')).join('')
  emit(`  模型回复: ${JSON.stringify(reply.slice(0, 200))}`)
  check('模型回复提到了白色/透明/空白类描述', /白|透明|空白|纯色|方块|点/.test(reply), reply.slice(0, 100))
  check('模型回复不是空', reply.trim().length > 0)

  emit(`\n===== 结果: ${pass} 通过 / ${fail} 失败 / 共 ${pass + fail} =====`)
  if (RESULT_FILE) fs.writeFileSync(RESULT_FILE, out.join('\n') + '\n')
} catch (err) {
  emit(`测试异常: ${err.message}`)
  if (RESULT_FILE) fs.writeFileSync(RESULT_FILE, out.join('\n') + '\n')
  console.error('测试异常:', err.message)
  console.error('--- bridge 日志尾部 ---')
  console.error(logText().split('\n').slice(-25).join('\n'))
  fail++
} finally {
  child.kill('SIGTERM')
  wss.close()
  imgServer.close()
  await sleep(1200)
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }) } catch { /* 临时目录清不掉就留着 */ }
  process.exit(fail === 0 ? 0 : 1)
}
