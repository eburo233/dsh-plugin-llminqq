// test/unit-acp-backoff.test.mjs —— 「ACP 子进程无限重启把 CPU 打满」的回归测试
//
// 背景（2026-10-31 用户实测：打开总开关后 CPU 很高）：
//   查日志发现 4 分钟里 **99 次**「=== LLMinQQ bridge 启动 ===」+
//   **99 次**「acp: 启动 dsh --profile web」，而日志里一条消息都没有。
//
// 两个 bug 叠在一起：
//
//   ① **profile 推导错了**。插件装在 `~/.dsh/profiles/web/node_modules/` 下，
//      detectProfileName() 因此反推出 `web`，而 `web` 是会起 HTTP 服务的 profile
//      （@deepseek-ai/dsh-host-webserver + ui-settings 全家桶），它要占 3080 ——
//      已经被正在运行的宿主占了：
//          listen EADDRINUSE: address already in use 127.0.0.1:3080
//          dsh: startup failed: 2 required plugins did not activate
//      原保留名单只有 `desktop`，漏了 `web` / `headless`。
//
//   ② **start() 没有失败退避**。失败时 `startPromise = null`，
//      而 `_ensureSession` / `prompt` 都是 `if (!this.ready) await this.start()`，
//      所以下一次调用立刻全量 spawn 一遍。每次 spawn = 加载整套 DSH + 9 个插件
//      + 撞端口 + exit 1。这就把 CPU 顶满了。
//
// 这里用「不存在的 bin」制造必然失败（不需要真装 DSH、不碰端口），
// 断言「连续多次 start() 只 spawn 一次」，以及冷却期内不再反复 spawn。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const { AcpRuntime } = await import(pathToFileURL(path.join(ROOT, 'lib', 'bridge', 'acp.js')).href)
const PI = await import(pathToFileURL(path.join(ROOT, 'lib', 'profile-info.js')).href)

/** 必失败的运行时：bin 不存在，spawn 会 exit 1 */
function makeFailingRuntime ({ log = () => {} } = {}) {
  return new AcpRuntime({
    bin: '/nonexistent/dsh-for-test-only',
    profile: PI.ACP_PROFILE_NAME,
    cwd: '/tmp',
    provider: 'qodercn',
    model: 'dfmodel',
    startTimeoutMs: 3000,
    turnTimeoutMs: 3000,
    log,
    patchFile: null,
    remembered: null,
    onSessionCreated: null,
  })
}

// ── ① profile 推导：会起端口的宿主 profile 必须落到 acp ──────────────────────

test('web / headless 都不能当 ACP 子进程的 profile（它们会抢宿主端口）', () => {
  // 这是本次 CPU 打满的直接原因：插件装在 profiles/web 下 → 反推出 web → 抢 3080
  for (const bad of ['web', 'desktop', 'headless', 'WEB', 'Web']) {
    assert.equal(PI.bridgeProfileName(bad), PI.ACP_PROFILE_NAME,
      `"${bad}" 应该落到 ${PI.ACP_PROFILE_NAME} —— 否则会起 HTTP 服务抢宿主端口`)
  }
})

test('正常 profile 名原样保留（不要把 llminqq-acp 也吞掉）', () => {
  for (const good of ['acp', 'llminqq-acp', 'bili-duty']) {
    assert.equal(PI.bridgeProfileName(good), good, `"${good}" 是合法 profile，不该被改写`)
  }
})

test('空值推导的兜底是 acp（不是 web）', () => {
  // 本机插件就装在 profiles/web 下，detectProfileName() 会反推出 web。
  // 修复后必须落到 acp。
  assert.equal(PI.bridgeProfileName(''), PI.ACP_PROFILE_NAME,
    '空 profile 自动推导时必须落到 acp —— 落到 web 就会抢宿主端口')
})

test('isHostProfile 能识别会起端口的 profile', () => {
  assert.equal(PI.isHostProfile('web'), true)
  assert.equal(PI.isHostProfile('headless'), true)
  assert.equal(PI.isHostProfile('desktop'), true)
  assert.equal(PI.isHostProfile('acp'), false)
  assert.equal(PI.isHostProfile('llminqq-acp'), false)
})

// ── ② 失败退避：连续调用只 spawn 一次 ───────────────────────────────────────

test('启动失败后进入冷却期：连续 5 次 start() 只 spawn 1 次', async () => {
  const r = makeFailingRuntime()
  const t0 = Date.now()
  let firstError = null
  let cooldownErrors = 0
  for (let i = 0; i < 5; i++) {
    try {
      await r.start()
    } catch (err) {
      if (i === 0) firstError = err
      else if (/冷却中/.test(String(err.message))) cooldownErrors++
    }
  }
  // 关键断言：只有第一次真的去 spawn 了
  assert.equal(r._startAttempts, 1,
    `5 次调用应该只尝试 1 次 spawn，实际 ${r._startAttempts} 次 —— 这就是 CPU 打满的根因`)
  assert.equal(cooldownErrors, 4, '后面 4 次应该在冷却期内直接报错（不再 spawn）')
  assert.ok(firstError, '第一次应该抛出真实的失败原因')
  // 冷却期内的调用必须立刻返回（不该等 spawn 的时间）
  assert.ok(Date.now() - t0 < 3000,
    `整个循环应该很快（<3s），实际 ${Date.now() - t0}ms —— 说明冷却期内还在反复 spawn`)
})

test('冷却期内的报错带上「上次失败原因」和剩余秒数', async () => {
  const r = makeFailingRuntime()
  try { await r.start() } catch { /* 第一次真实失败 */ }
  let msg = ''
  try { await r.start() } catch (err) { msg = String(err.message) }
  assert.match(msg, /冷却中/, '冷却期内的报错应说明在冷却')
  assert.match(msg, /还要等\s*\d+s/, '应告诉调用方还要等多久')
  // 失败原因现在可能是「找不到 dsh」或「acp exited」——关键是**要带上真实原因**，
  // 不能只说「冷却中」。这里放宽成「必须提到具体原因」而不是死绑某一种。
  assert.match(msg, /acp exited|cannot find dsh|路径不存在/,
    '应带上上次失败的真实原因，否则根本查不出根因')
})

test('退避是指数增长且有上限（不会退化成永久等待）', async () => {
  const r = makeFailingRuntime()
  const delays = []
  // 手动把时钟推到冷却结束，模拟「等到了」，观察下一轮退避间隔是否翻倍
  const realNow = Date.now
  for (let i = 0; i < 5; i++) {
    r._retryAt = 0            // 绕过冷却，强制允许再试
    try { await r.start() } catch { /* 预期失败 */ }
    delays.push(Math.round((r._retryAt - realNow()) / 1000))
  }
  assert.deepEqual(delays.slice(0, 4), [5, 10, 20, 40],
    `退避应该翻倍增长（5,10,20,40），实际 ${delays.join(',')}`)
  // 最后一次要封顶在 5 分钟内，不能无限翻倍
  assert.ok(delays.every(d => d <= 300), `退避应有上限（≤300s），实际 ${delays.join(',')}`)
})

test('启动成功后必须清零退避（否则下次失败会等很久）', async () => {
  const r = makeFailingRuntime()
  // 先失败两次，把退避推上去
  for (let i = 0; i < 2; i++) {
    r._retryAt = 0
    try { await r.start() } catch { /* 预期失败 */ }
  }
  assert.ok(r._startAttempts >= 2, '前置：应该失败了至少 2 次')
  const beforeRetryAt = r._retryAt
  assert.ok(beforeRetryAt > Date.now(), '前置：应该在冷却中')

  // 模拟一次成功的 _start：直接调 start() 的成功分支不好造，改为验证 then 分支的语义
  // —— 用一个假的 _start 让它成功
  r._start = async () => ({ agentInfo: { name: 'fake' } })
  r.startPromise = null
  r._retryAt = 0
  await r.start()
  assert.equal(r._startAttempts, 0, '成功后连续失败计数必须清零')
  assert.equal(r._retryAt, 0, '成功后冷却必须清除')
  assert.equal(r._lastStartError, null, '成功后上次错误必须清除')
})

// ── ③ 启动失败时 stderr 要被翻译成人话 ──────────────────────────────────────

test('源码里对 EADDRINUSE 有专门的诊断（不能只留 code=1）', async () => {
  const fs = await import('node:fs')
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'bridge', 'acp.js'), 'utf8')
  assert.match(src, /EADDRINUSE/, 'stderr 里出现 EADDRINUSE 时必须能识别并给出原因')
  assert.match(src, /抢同一个端口|抢宿主端口/, '要说明「冲突」这件事，否则用户只看到 code=1')
  // 诊断要能进到 exit 日志里
  const exitBlock = src.slice(src.indexOf("child.on('exit'"), src.indexOf("child.on('exit'") + 700)
  assert.match(exitBlock, /_startupHint/, 'exit 日志里必须带上诊断，否则根因还是查不出来')
})

// ── ④ 桥侧的第二道防线：已落盘的旧 "web" 配置也必须被纠正 ──────────────────
//
// 插件侧 bridgeProfileName() 修好只保证「新写进 bridge-config.json 的值是对的」。
// 但现实中**旧值已经落盘**（用户升级插件时，配置文件还在那儿），桥读到的
// 仍然是 `profile: "web"`。所以桥启动时必须自己再判一次。
//
// 这一条是端到端实测过的：拿一份 profile=web 的配置真跑桥，
// 日志会出现「已改用 "acp"」且 `acp: 启动 dsh --profile acp`。

test('桥源码对会起端口的 profile 有最终防线（不止插件侧判断）', async () => {
  const fs = await import('node:fs')
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'bridge', 'index.js'), 'utf8')

  // 必须有一份「会起端口的 profile 名单」+ 归一化后的常量
  assert.match(src, /HOST_PROFILES|SAFE_ACP_PROFILE/,
    '桥里没有 profile 最终防线 —— 旧配置里的 "web" 仍会去抢宿主端口')
  // 关键：AcpRuntime 的 profile 必须用归一化后的值，不能裸读 config
  const acpInit = src.slice(src.indexOf('new AcpRuntime({'), src.indexOf('new AcpRuntime({') + 400)
  assert.doesNotMatch(acpInit, /profile:\s*config\.dsh\.profile/,
    'AcpRuntime 还在裸读 config.dsh.profile —— 旧配置的 web 会被直接拿去 spawn')
  assert.match(acpInit, /profile:\s*DSH_PROFILE/,
    'AcpRuntime 应该用归一化后的 DSH_PROFILE')
})

// ── 配置的 dsh 路径不存在时，绝不能静默换用别的 dsh ─────────────────────────
//
// 2026-11-01 实测：测试里用 `bin: '/nonexistent/x'` 期望「启动必失败」，
// 结果它**真的启动成功了**并完成 ACP 初始化 —— 因为 resolveDshCommand 在
// 「配置了但文件不存在」时**继续往下找**，悄悄用了 PATH 里的那个 dsh。
//
// 这是最坏的一种失败：用户以为跑的是自己指定的 dsh（特定版本/profile），
// 实际跑的是另一个。版本或行为不一致时，根本查不出来。
//
// 而且它还有个副作用：测试会真的起一个 dsh 子进程挂在那儿（等 ACP 响应），
// 让整个测试套件卡死（实测超时 90s+）。

const FIND = await import(pathToFileURL(path.join(ROOT, 'lib', 'find-dsh.js')).href)

test('配置的路径不存在 → 直接失败，不自动换用 PATH 里的 dsh', () => {
  const r = FIND.resolveDshCommand('/nonexistent/definitely-not-here')
  assert.equal(r.kind, 'none',
    '配置了不存在的路径却返回了其他 kind —— 它会静默换用别的 dsh，用户永远查不出来')
  assert.match(String(r.reason), /不存在/,
    '报错要说明「路径不存在」，否则用户不知道该去填什么')
  assert.match(String(r.reason), /不会自动换用/,
    '要明确告知不会自动换用别的 dsh —— 否则用户会以为已经回退了')
})

test('默认值 "dsh" 仍然允许自动探测（那才是「没配置」）', () => {
  // configured === 'dsh' 是设置页的默认值，语义上等于「没指定」，
  // 这时应该正常往下探测 PATH，而不是报错。
  const r = FIND.resolveDshCommand('dsh')
  assert.notEqual(r.kind, 'none',
    '"dsh" 是默认值（等于没配），必须允许自动探测，否则装完就用不了了')
})

test('启动成本的回归：不存在的 bin 必须**快速**失败（不该真去 spawn）', async () => {
  const r = makeFailingRuntime()
  const t0 = Date.now()
  try { await r.start() } catch { /* 预期失败 */ }
  const ms = Date.now() - t0
  // 修复前：2135ms（它真的起了一个 dsh 在等 ACP 握手）
  // 修复后：几毫秒（解析阶段就失败了）
  assert.ok(ms < 500,
    `失败耗时 ${ms}ms（应 <500ms）—— 说明它还在真去 spawn 一个进程，测试会卡死`)
})
