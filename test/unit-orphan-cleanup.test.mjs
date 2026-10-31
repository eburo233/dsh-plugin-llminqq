// test/unit-orphan-cleanup.test.mjs —— 重启动留下孤儿桥的回归测试
//
// 背景（2026-10-31 用户实测）：
//   用户重启 dsh 后 CPU 反而更高，日志里 OneBot 重连计数飙到 387 次。
//   查下来：**两个桥进程并存**
//     PID 561089  PPid=1（孤儿）  存活 4h32m  **CPU 13.7%、内存 386MB**
//     PID 626677  PPid=626585     本次 dsh 起的正常桥
//   它们都死连同一个 OneBot 端口，孤儿还占着 18080 → 新桥 EADDRINUSE。
//
// 为什么之前没人清理：`lib/bridge/index.js` 里本来就有「启动前清孤儿」的调用，
// 但它引用的 `scripts/cleanup-orphan-acp.mjs` **从来没被创建过** ——
// 那段代码是死代码（`if (fs.existsSync(script))` 判断不过，静默跳过）。
// 而且原设计只管 `dsh --profile` 子进程，根本不管桥自己。
//
// 这个测试锁两件事：
//   ① 清理脚本必须存在且能识别孤儿（防止又变成死代码）
//   ② 判据必须保守 —— 绝不能误杀活桥 / dsh 主进程

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SCRIPT = path.join(ROOT, 'scripts', 'cleanup-orphan-acp.mjs')

test('清理脚本真实存在（之前是代码里引用了一个不存在的文件）', () => {
  assert.ok(fs.existsSync(SCRIPT),
    'scripts/cleanup-orphan-acp.mjs 不存在 —— 桥启动时那段「清孤儿」又是死代码')
})

const M = await import(pathToFileURL(SCRIPT).href)

test('能列出进程（Linux 走 /proc）', () => {
  const procs = M.listProcesses()
  assert.ok(Array.isArray(procs), 'listProcesses 要返回数组')
  assert.ok(procs.length > 1, `应该扫到多个进程，实际 ${procs.length}`)
  const self = procs.find(p => p.pid === process.pid)
  assert.ok(self, '连自己都扫不到，判据有问题')
  assert.equal(typeof self.ppid, 'number')
})

test('判据：PPid=1 + 本插件桥路径 → 孤儿', () => {
  const fake = {
    pid: 99999, ppid: 1,
    cmd: '/usr/bin/node /home/x/.dsh/profiles/web/node_modules/dsh-plugin-llminqq/lib/bridge/index.js',
  }
  const c = M.classify(fake)
  assert.equal(c.orphan, true, 'PPid=1 且是我们桥的进程必须判为孤儿')
  assert.equal(c.kind, 'bridge')
})

test('判据：父进程还活着 → 绝不是孤儿（这是防误杀活桥的关键）', () => {
  const fake = {
    pid: 88888, ppid: 4242,   // 父进程 pid 还在
    cmd: '/usr/bin/node /home/x/.dsh/profiles/web/node_modules/dsh-plugin-llminqq/lib/bridge/index.js',
  }
  const c = M.classify(fake)
  assert.equal(c.orphan, false,
    'PPid 不是 1 就不是孤儿 —— 正常运行时桥是 dsh 的子进程，杀了就是杀活桥')
  assert.match(c.why, /父进程还活着/)
})

test('判据：PPid=1 但不是我们插件 → 不碰（可能是别人的守护进程）', () => {
  const cases = [
    { pid: 777, ppid: 1, cmd: '/usr/bin/dockerd' },
    { pid: 778, ppid: 1, cmd: '/opt/ts3audiobot/TS3AudioBot.dll' },
    { pid: 779, ppid: 1, cmd: '/usr/bin/node /opt/other-qq-bridge/bridge/index.js' }, // 别人的桥
  ]
  for (const f of cases) {
    assert.equal(M.classify(f).orphan, false,
      `不该动非本插件的进程：${f.cmd}`)
  }
})

test('判据：不认死某一条绝对路径（仓库那份和安装副本那份都要认）', () => {
  // 真实踩坑：脚本在仓库里，但跑着的桥是 pnpm 拷进 profile 的那份。
  // 只比对 PKG_ROOT 推出来的路径 → 扫 404 个进程报「0 个孤儿」，
  // 而孤儿明明还在吃着 13.7% 的 CPU。
  assert.ok(Array.isArray(M.BRIDGE_MARKERS) && M.BRIDGE_MARKERS.length >= 2,
    'BRIDGE_MARKERS 要同时覆盖仓库路径和安装副本路径')
  assert.ok(M.BRIDGE_MARKERS.some(m => m.includes('dsh-plugin-llminqq/lib/bridge/index.js')),
    '缺「安装副本」那条 marker —— 真在跑的桥通常就是安装副本')
  // 两个路径都要被认成「我们的桥」
  assert.equal(M.isOurBridge(`node ${path.join(ROOT, 'lib/bridge/index.js')}`), true)
  assert.equal(M.isOurBridge('node /home/x/.dsh/profiles/web/node_modules/dsh-plugin-llminqq/lib/bridge/index.js'), true)
  assert.equal(M.isOurBridge('node /opt/other/bridge/index.js'), false)
})

test('判据：当前进程自己受保护（不会自杀）', () => {
  const self = { pid: process.pid, ppid: 1, cmd: `node ${path.join(ROOT, 'lib/bridge/index.js')}` }
  const c = M.classify(self)
  assert.equal(c.orphan, false, '当前进程即使 ppid=1 也必须被保护，不能杀自己')
  assert.match(c.why, /protected/)
})

test('默认只看不杀（必须显式 --kill）', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8')
  assert.match(src, /const KILL = argv\.includes\('--kill'\)/,
    'KILL 开关必须由 --kill 决定')
  assert.match(src, /dryRun:\s*!KILL/, '结果里要标明是否 dryRun')
})

test('桥启动时调用清理脚本，且不再依赖「文件存在才跑」而静默跳过', () => {
  const bridgeSrc = fs.readFileSync(path.join(ROOT, 'lib', 'bridge', 'index.js'), 'utf8')
  assert.match(bridgeSrc, /cleanup-orphan-acp\.mjs/,
    '桥启动时没有调用清理脚本')
  // 文件现在已经存在，所以那个 existsSync 守卫不会再静默跳过；
  // 但脚本缺失时要**说出来**，而不是默默什么都不做
  const block = bridgeSrc.slice(
    bridgeSrc.indexOf('cleanup-orphan-acp.mjs') - 400,
    bridgeSrc.indexOf('cleanup-orphan-acp.mjs') + 800,
  )
  assert.match(block, /log/i, '清理失败/缺失时要有日志，不能静默')
})
