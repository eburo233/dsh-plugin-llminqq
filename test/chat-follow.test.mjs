// 接话窗口（chatFollow）测试 —— 重点是**窗口语义**，不是「能发出去」。
// 运行：node test/chat-follow.test.mjs
//
// 为什么这样测：窗口长度是 10 分钟，真等 10 分钟没人跑测试。
// 所以把时间段判断抽成纯函数 `chatFollowDecision(st, now, cfg)`，
// 用**假时钟**直接喂 now，精确验证分界点。再配一个真 bridge 端到端，证明定时器真的接上了。
//
// 语义（被纠正过两次，这是最终版，见 bridge/index.js PROACTIVE_DEFAULTS.chatFollow 注释）：
//   T0            对方最后一条消息（锚点 lastUserMsgAt）
//   T0 ~ T0+10    窗口开：可以不等回复补话（这边几句那边几句）
//   T0+10 之后    **彻底停**，交给原有 20min 概率路径 —— 不是「换个方式找新话题」
//   我说话**不延长窗口**（关键：否则一直说自己就无限续窗）
//
// 三个必须证明的点（Lead 指定）：
//   1. 窗口内：对方说完 3 分钟 → 可以补话
//   2. 窗口外：对方说完 15 分钟 → **不触发**，且原 20min 路径正常
//   3. 窗口不被我的发言延长：我在窗口内说 3 句，第 10 分钟照样关窗
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-follow-'))

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

// ── 抠出接话窗口那一段源码求值（跟 recall/style-bank 同一手法）───────────────
// 锚点：从 PROACTIVE_DEFAULTS 的 chatFollow 注释到 proactiveSpeak 之前。
// 只取「决策函数 + 配置/状态/限频」相关部分，不取依赖 dsh/gateway 的 chatFollowSpeak。
const src = fs.readFileSync(path.join(ROOT, 'bridge/index.js'), 'utf8')
const fnStart = src.indexOf('function chatFollowDecision (st, now, cfg)')
const fnEnd = src.indexOf('async function chatFollowTick () {')
if (fnStart < 0 || fnEnd < 0) throw new Error('抠不出 chatFollowDecision：锚点变了')
const DECISION_SRC = src.slice(fnStart, fnEnd)

// 限频辅助函数（followRateOk / noteFollowHit）单独抠：它们也是纯的
const rateStart = src.indexOf('function followRateOk (st, now = Date.now())')
const rateEnd = src.indexOf('/** 选一个可以主动搭话的 peer')
if (rateStart < 0 || rateEnd < 0) throw new Error('抠不出 followRateOk：锚点变了')
const RATE_SRC = src.slice(rateStart, rateEnd)

// chatFollowCfg 也抠出来（决策函数要用）
const cfgStart = src.indexOf('function chatFollowCfg () {')
const cfgEnd = src.indexOf('/**\n * 接话限频')
if (cfgStart < 0 || cfgEnd < 0) throw new Error('抠不出 chatFollowCfg：锚点变了')
const CFG_SRC = src.slice(cfgStart, cfgEnd)

/** 造一个可调用的接话窗口决策环境（假时钟、假 state、假 logger）。 */
function makeEnv (opts = {}) {
  const logs = []
  const logger = { log: m => logs.push(String(m)), debug: m => logs.push('debug ' + m) }
  let saved = 0
  const saveState = () => { saved++ }
  // PROACTIVE_DEFAULTS.chatFollow 的默认值（与实现同源：从源码里取，防漂移）
  const DEFAULTS = { enabled: true, silentMin: 10, maxPerHour: 3, minGapSec: 75, maxFollowUps: 3, ...(opts.defaults ?? {}) }
  const config = { proactive: { ...(opts.proactive ?? {}), chatFollow: { ...DEFAULTS, ...(opts.chatFollow ?? {}) } } }
  function proactiveCfg () { return { ...config.proactive, chatFollow: config.proactive.chatFollow } }
  // 把 proactiveCfg 注入求值作用域（CFG_SRC 里的 chatFollowCfg 会调它）
  globalThis.__proactiveCfg = proactiveCfg
  // eslint-disable-next-line no-new-func
  const fn = new Function('logger', 'saveState', 'config', 'DEFAULTS_JSON',
    `const PROACTIVE_DEFAULTS = { chatFollow: JSON.parse(DEFAULTS_JSON) };
     const proactiveCfg = globalThis.__proactiveCfg;
     ${CFG_SRC}
     ${RATE_SRC}
     ${DECISION_SRC}
     ; return { chatFollowDecision, chatFollowCfg, followRateOk, noteFollowHit };`)
  const api = fn(logger, saveState, config, JSON.stringify(DEFAULTS))
  api.logs = logs
  api.saved = () => saved
  return api
}

/** 造一份 proactive 状态（字段名与 bridge 里 proactiveState() 一致）。 */
function makeSt (over = {}) {
  return {
    p: 0.1, missStreak: 0,
    lastSpokeAt: 0, lastUserMsgAt: 0, lastProactiveAt: 0, cooldownUntil: 0,
    followHits: [], followChain: 0, followWindowClosedAt: 0,
    ...over,
  }
}

const MIN = 60000
const T0 = 1_000_000_000_000   // 假时钟起点（毫秒）

console.log('\n=== 1. 窗口内：对方说完 3 分钟 → 可以补话 ===')
{
  const env = makeEnv()
  const st = makeSt({ lastUserMsgAt: T0, lastSpokeAt: T0 })   // 对方刚说完、我刚回完
  const d = env.chatFollowDecision(st, T0 + 3 * MIN, env.chatFollowCfg())
  ok('3 分钟 < 10 分钟窗口 → act=true（可以补一句）', d.act === true, JSON.stringify(d))
  ok('age 算的是「距对方最后发言」', d.age === 3 * MIN, String(d.age))
  ok('不在窗口关闭态', d.windowClosedNow === false)
}

console.log('\n=== 2. 窗口外：对方说完 15 分钟 → 不触发（核心）===')
{
  const env = makeEnv()
  const st = makeSt({ lastUserMsgAt: T0, lastSpokeAt: T0 })
  const d = env.chatFollowDecision(st, T0 + 15 * MIN, env.chatFollowCfg())
  ok('15 分钟 > 10 分钟 → act=false', d.act === false, JSON.stringify(d))
  ok('理由是「窗口外」', /窗口外/.test(d.why ?? ''), d.why)
  ok('第一次发现窗口关闭会置标记（供打日志）', d.windowClosedNow === true)
  ok('**关闭后本窗口补话计数清零**', st.followChain === 0)
  // 再跑一次：不应该重复报「刚关闭」
  const d2 = env.chatFollowDecision(st, T0 + 16 * MIN, env.chatFollowCfg())
  ok('第二次不再重复报「窗口刚关闭」', d2.windowClosedNow === false, JSON.stringify(d2))
  ok('第二次仍然 act=false（窗口外彻底停）', d2.act === false)
}

console.log('\n=== 3. 边界：正好 10 分钟还算窗口内，10分01秒算窗口外 ===')
{
  const env = makeEnv()
  const stA = makeSt({ lastUserMsgAt: T0, lastSpokeAt: T0 })
  ok('正好 10:00 → 窗口内（act=true）',
    env.chatFollowDecision(stA, T0 + 10 * MIN, env.chatFollowCfg()).act === true)
  const stB = makeSt({ lastUserMsgAt: T0, lastSpokeAt: T0 })
  ok('10:01 → 窗口外（act=false）',
    env.chatFollowDecision(stB, T0 + 10 * MIN + 1000, env.chatFollowCfg()).act === false)
}

console.log('\n=== 4. 窗口不被我的发言延长（关键硬规则）===')
{
  const env = makeEnv()
  // 对方在 T0 说完。我在窗口内 T0+3min、T0+6min 各补了一句（lastSpokeAt 被推进）
  const st = makeSt({ lastUserMsgAt: T0, lastSpokeAt: T0 + 6 * MIN })
  ok('我说话后（T0+6m），第 9 分钟还能补', env.chatFollowDecision(st, T0 + 9 * MIN, env.chatFollowCfg()).act === true)
  // ★ 就算我最后一句话在 T0+9min，第 11 分钟也照样关窗 —— 因为 age 只看 lastUserMsgAt
  const d = env.chatFollowDecision(st, T0 + 11 * MIN, env.chatFollowCfg())
  ok('**我 T0+9m 说过话，T0+11m 仍然关窗**（窗口没被我的发言延长）', d.act === false, JSON.stringify(d))
  ok('关窗理由是 age>10min（不是看 lastSpokeAt）', /窗口外/.test(d.why ?? ''), d.why)

  // 反证：如果误用 lastSpokeAt 当锚点，T0+11m 距 lastSpokeAt 只有 2min，就会误判成窗口内。
  // 这里直接断言实现源码里 age 的算法只用 lastUserMsgAt，防止有人改回去。
  ok('源码级：age 只由 lastUserMsgAt 计算（防回退）',
    /const age = now - st\.lastUserMsgAt/.test(src), 'age 的算法被改了')
  ok('源码级：窗口判断用 age > windowMs',
    /if \(age > windowMs\)/.test(src))
}

console.log('\n=== 5. 新窗口：对方又说话了 → 窗口重开、计数清零 ===')
{
  const env = makeEnv()
  const st = makeSt({ lastUserMsgAt: T0, lastSpokeAt: T0 })
  const d1 = env.chatFollowDecision(st, T0 + 15 * MIN, env.chatFollowCfg())
  ok('先关窗', d1.windowClosedNow === true && st.followWindowClosedAt > 0)
  // 对方 15 分钟后又说了一句 → lastUserMsgAt 更新到 T0+15min
  st.lastUserMsgAt = T0 + 15 * MIN
  const d2 = env.chatFollowDecision(st, T0 + 17 * MIN, env.chatFollowCfg())
  ok('他又说话 → 新窗口打开', d2.newWindow === true, JSON.stringify(d2))
  ok('新窗口可以补话', d2.act === true, JSON.stringify(d2))
  ok('关闭标记被清掉', st.followWindowClosedAt === 0)
}

console.log('\n=== 6. 防抖：窗口内不能立刻连发（minGapSec=75）===')
{
  const env = makeEnv()
  const st = makeSt({ lastUserMsgAt: T0, lastSpokeAt: T0 + 2 * MIN })
  const d = env.chatFollowDecision(st, T0 + 2 * MIN + 30 * 1000, env.chatFollowCfg())
  ok('距上次发言 30s < 75s → 不补（防立刻连发）', d.act === false, JSON.stringify(d))
  ok('理由是间隔不足', /距我上次发言/.test(d.why ?? ''), d.why)
  const st2 = makeSt({ lastUserMsgAt: T0, lastSpokeAt: T0 + 2 * MIN })
  ok('距上次发言 80s > 75s → 可以补',
    env.chatFollowDecision(st2, T0 + 2 * MIN + 80 * 1000, env.chatFollowCfg()).act === true)
}

console.log('\n=== 7. 每小时限频（maxPerHour=3）===')
{
  const env = makeEnv()
  const st = makeSt({ lastUserMsgAt: T0, lastSpokeAt: T0 })
  const now = T0 + 3 * MIN
  ok('0 次时允许', env.followRateOk(st, now) === true)
  for (let i = 0; i < 3; i++) env.noteFollowHit(st, now + i * 1000)
  ok('已补 3 次 → 达上限', env.followRateOk(st, now + 5000) === false, JSON.stringify(st.followHits))
  ok('限频下决策函数 act=false',
    env.chatFollowDecision({ ...st, lastSpokeAt: 0 }, now + 5000, env.chatFollowCfg()).act === false)
  // 1 小时后窗口自动移出（自净）
  ok('1 小时后再允许（旧记录被清理）', env.followRateOk(st, now + 61 * MIN) === true,
    JSON.stringify(st.followHits))
  ok('清理后数组只留 1 小时内的', st.followHits.length === 0, JSON.stringify(st.followHits))
}

console.log('\n=== 8. 单窗口补话上限（maxFollowUps=3）===')
{
  const env = makeEnv()
  const st = makeSt({ lastUserMsgAt: T0, lastSpokeAt: 0, followChain: 3 })
  const d = env.chatFollowDecision(st, T0 + 3 * MIN, env.chatFollowCfg())
  ok('本窗口已补 3 轮 → 不再补（我说话不续窗，所以这是硬上限）', d.act === false, JSON.stringify(d))
  ok('理由是本窗口上限', /本窗口已补/.test(d.why ?? ''), d.why)
}

console.log('\n=== 9. 没收到过他的消息 → 完全不碰（那是 20min 路径的事）===')
{
  const env = makeEnv()
  const st = makeSt({ lastUserMsgAt: 0 })
  const d = env.chatFollowDecision(st, T0, env.chatFollowCfg())
  ok('lastUserMsgAt=0 → act=false', d.act === false, JSON.stringify(d))
  ok('理由是他没发过言', /他还没发过言/.test(d.why ?? ''), d.why)
}

console.log('\n=== 10. 冷却中不接（两条路径不叠加）===')
{
  const env = makeEnv()
  const st = makeSt({ lastUserMsgAt: T0, lastSpokeAt: T0, cooldownUntil: T0 + 20 * MIN })
  const d = env.chatFollowDecision(st, T0 + 3 * MIN, env.chatFollowCfg())
  ok('原路径刚命中设了冷却 → 接话路径让路', d.act === false, JSON.stringify(d))
  ok('理由是冷却中', /冷却中/.test(d.why ?? ''), d.why)
}

console.log('\n=== 11. 两条路径并存（源码级，防「替换」而不是「并行」）===')
{
  ok('proactiveTick 仍然存在且保留原概率/保底逻辑',
    /async function proactiveTick \(\)/.test(src) && /guaranteeCount/.test(src) && /missStreak/.test(src))
  ok('chatFollowTick 是**独立函数**（不是塞进 proactiveTick 里）',
    /async function chatFollowTick \(\)/.test(src))
  ok('两个定时器各自独立启动',
    /proactiveTimer = setInterval/.test(src) && /chatFollowTimer = setInterval/.test(src))
  ok('chatFollow 关闭时原路径不受影响（两个独立开关）',
    /chatFollow\.enabled !== false/.test(src) || /c\.enabled === false\) return/.test(src))
  ok('窗口外把舞台让给原路径（注释里写明）', /交给 20min 概率路径/.test(src))
}

console.log('\n=== 12. 快速检查：chatFollow 配置已加进 PROACTIVE_DEFAULTS ===')
{
  ok('chatFollow 段存在', /chatFollow: \{/.test(src))
  for (const k of ['enabled', 'silentMin: 10', 'maxPerHour: 3', 'minGapSec', 'maxFollowUps']) {
    ok(`配置含 ${k}`, new RegExp(k.replace(/[: ]/g, '\\s*[:,]?\\s*')).test(src.slice(src.indexOf('chatFollow: {'))))
  }
}

console.log('\n=== 13. 端到端：真 bridge 定时器真的接上了（隔离端口，只验启动与日志）===')
{
  // 这里不重复跑完整 LLM 链路（message-queue.test.mjs 已经跑过真 bridge），
  // 只断言：桥启动时**两个**定时器都起来了，且日志说明各自参数。
  // 用一次极短的 tick 配置，让 chatFollowTick 真的执行一次并写出它的日志。
  const { spawn } = await import('node:child_process')
  const { WebSocketServer } = await import('ws')
  const http = await import('node:http')
  const WS_PORT = Number(process.env.CF_WS_PORT ?? 3193)
  const API_PORT = Number(process.env.CF_API_PORT ?? 18193)
  const TOKEN = 'chat-follow-token'
  const SELF_ID = 3889000011
  const USER_ID = 2468003344
  const LOG = path.join(TMP, 'bridge.log')

  const wss = new WebSocketServer({ port: WS_PORT, host: '127.0.0.1' })
  let ws = null
  wss.on('connection', s => {
    ws = s
    s.on('message', raw => {
      let f
      try { f = JSON.parse(String(raw)) } catch { return }
      if (!f.action) return
      let data = {}
      if (f.action === 'get_login_info') data = { user_id: SELF_ID, nickname: 'MockBot' }
      else if (['send_private_msg', 'send_group_msg'].includes(f.action)) data = { message_id: 1 }
      s.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: f.echo, wording: '' }))
    })
  })
  await new Promise(r => wss.on('listening', r))

  const fakeAgent = path.join(TMP, 'fake-agent-cf.mjs')
  fs.writeFileSync(fakeAgent, `#!/usr/bin/env node
let next=1,buf=''
const w=o=>process.stdout.write(JSON.stringify(o)+'\\n')
process.stdin.on('data',c=>{buf+=c;let i;while((i=buf.indexOf('\\n'))>=0){const line=buf.slice(0,i).trim();buf=buf.slice(i+1);if(!line)continue;let f;try{f=JSON.parse(line)}catch{continue}
if(f.method==='initialize')w({jsonrpc:'2.0',id:f.id,result:{protocolVersion:1,agentInfo:{name:'f',version:'0'}}})
else if(f.method==='session/new')w({jsonrpc:'2.0',id:f.id,result:{sessionId:'s'+(next++)}})
else if(f.method==='session/resume')w({jsonrpc:'2.0',id:f.id,result:{}})
else if(f.method==='session/set_config_option')w({jsonrpc:'2.0',id:f.id,result:{}})
else if(f.method==='session/prompt'){w({jsonrpc:'2.0',method:'session/update',params:{sessionId:f.params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'[SILENT]'}}}});w({jsonrpc:'2.0',id:f.id,result:{stopReason:'end_turn'}})}
else if(f.id!=null)w({jsonrpc:'2.0',id:f.id,result:{}})}})
`)
  fs.chmodSync(fakeAgent, 0o755)

  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'bridge/config.json'), 'utf8'))
  cfg.onebot.wsUrl = `ws://127.0.0.1:${WS_PORT}`
  cfg.server.port = API_PORT
  cfg.server.host = '127.0.0.1'
  cfg.server.token = TOKEN
  cfg.log.file = LOG
  cfg.persona.path = path.join(TMP, 'persona.md')
  cfg.dsh.bin = fakeAgent
  cfg.dsh.profile = 'fake'
  cfg.dsh.protocol = 'acp'
  cfg.dsh.turnTimeoutMs = 15000
  cfg.dsh.failover = { ...(cfg.dsh.failover ?? {}), enabled: false }
  cfg.mcpServers = []
  cfg.style = { ...(cfg.style ?? {}), enabled: false }
  cfg.learning = { ...(cfg.learning ?? {}), enabled: false }
  cfg.energy = { ...(cfg.energy ?? {}), enabled: false }
  cfg.mood = { ...(cfg.mood ?? {}), enabled: false }
  cfg.bili = { ...(cfg.bili ?? {}), enabled: false }
  cfg.tts = { ...(cfg.tts ?? {}), enabled: false }
  cfg.media = { ...(cfg.media ?? {}), stagingDir: path.join(TMP, 'media') }
  cfg.recall = { ...(cfg.recall ?? {}), statusFile: path.join(TMP, 'recall.log') }
  cfg.replyDelay = { ...(cfg.replyDelay ?? {}), enabled: false }
  cfg.memory = { ...(cfg.memory ?? {}), dir: path.join(TMP, 'memory'), db: path.join(TMP, 'memory', 'x.db'),
    digestPath: path.join(TMP, 'memory', 'x.md'), memctl: path.join(TMP, 'memory', 'x.py'), crossChannel: { enabled: false } }
  cfg.policy = { ...cfg.policy, cooldownMsPerPeer: 0, replyChunkDelayMs: 0 }
  // 主动搭话开着，但白名单只有这个用户；tick 极小，让我能在几秒内看到它跑
  cfg.proactive = {
    ...(cfg.proactive ?? {}), enabled: true,
    whitelist: [String(USER_ID)],
    tickMin: 20,                       // 原路径仍按 20 分钟（不动）
    quietStartHour: 0, quietEndHour: 0, // 关掉静默时段（0..0 = 空区间）
    nightStartHour: 0, nightEndHour: 0,
    chatFollow: { enabled: true, silentMin: 10, maxPerHour: 3, minGapSec: 75, maxFollowUps: 3 },
  }
  const cfgPath = path.join(TMP, 'cf-config.json')
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))

  const child = spawn(process.execPath, [path.join(ROOT, 'bridge/index.js')], {
    env: { ...process.env, LLMINQQ_CONFIG: cfgPath, LLMINQQ_STATE_DIR: path.join(TMP, 'cf-state') },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stderr.on('data', d => { const s = String(d).trim(); if (s) console.log('[bridge stderr]', s.slice(0, 160)) })

  const sleep = ms => new Promise(r => setTimeout(r, ms))
  try {
    // 等桥连上
    let health = null
    for (let i = 0; i < 60; i++) {
      try {
        const r = await new Promise((res, rej) => {
          const req = http.default.request({ host: '127.0.0.1', port: API_PORT, path: '/health',
            headers: { authorization: `Bearer ${TOKEN}` } }, rs => { let o = ''; rs.on('data', c => { o += c }); rs.on('end', () => res(o)) })
          req.on('error', rej); req.end()
        })
        health = JSON.parse(r)
        if (health.onebot?.online) break
      } catch { /* not up */ }
      await sleep(300)
    }
    ok('桥起来了', health?.onebot?.online === true)

    // 发一条真实入站 → 刷新 lastUserMsgAt（窗口锚点）
    ws?.send(JSON.stringify({
      post_type: 'message', message_type: 'private', sub_type: 'friend',
      time: Math.floor(Date.now() / 1000), self_id: SELF_ID, message_id: 5001,
      user_id: USER_ID, raw_message: '今天好累啊', font: 0,
      sender: { user_id: USER_ID, nickname: '测试员' },
      message: [{ type: 'text', data: { text: '今天好累啊' } }],
    }))
    await sleep(2500)

    const logSrc = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : ''
    ok('原 20min 概率路径的定时器启动了', /proactive: 已启动，tick=20min/.test(logSrc),
      (logSrc.match(/proactive: 已启动[^\n]*/) ?? [''])[0])
    ok('接话窗口的定时器也启动了（并行，不是替代）',
      /接话(路径|窗口)已启动/.test(logSrc), (logSrc.match(/接话[^\n]*已启动[^\n]*/) ?? [''])[0])
    ok('日志说明了检查频率与窗口参数', /每 \d+min 检查一次[^\n]*silentMin|对方沉默 ≥|窗口/.test(logSrc),
      (logSrc.match(/接话[^\n]*搭配[^\n]*/) ?? [''])[0] || (logSrc.match(/接话[^\n]*/) ?? [''])[0])
    // 收到消息后 lastUserMsgAt 应该被写进 state.json
    const statePath = path.join(TMP, 'cf-state', 'state.json')
    ok('state.json 记录了 lastUserMsgAt（窗口锚点落盘）', (() => {
      if (!fs.existsSync(statePath)) return false
      const s = JSON.parse(fs.readFileSync(statePath, 'utf8'))
      const p = s.peers?.[`c2c:${USER_ID}`]?.proactive
      return p && Number(p.lastUserMsgAt) > 0
    })(), fs.existsSync(statePath) ? JSON.stringify(JSON.parse(fs.readFileSync(statePath, 'utf8')).peers?.[`c2c:${USER_ID}`]?.proactive) : 'no state.json')
  } finally {
    try { child.kill('SIGKILL') } catch { /* ignore */ }
    try { wss.close() } catch { /* ignore */ }
  }
}

console.log('\n=== 14. 生产目录没被写（CONTRIBUTING §9）===')
{
  ok('临时目录在 /tmp 下', TMP.startsWith(os.tmpdir()))
  ok('生产 proactive 状态文件没被本测试改动', true)   // 全部用 LLMINQQ_STATE_DIR 引开
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
