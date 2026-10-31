// test/unit-napcat.test.mjs —— docker 探测的 in-flight 合并
//
// 背景（为什么值得单独测）：
//   `/overview` 每 4 秒被前端轮询一次，而 dockerAvailable() 内部要顺序跑
//   `docker --version` / `docker compose version` / `docker ps` 三条命令，
//   单条超时 8~10 秒。原来的实现没有任何合并：上一轮还没回来、下一轮就发出去，
//   请求一层层叠起来；docker daemon 半死时表现是「设置页越用越慢，最后转圈」。
//   现在的实现保证**同一个 key 的并发调用共享同一个 Promise**。
//
// 这个测试不打桩也不 mock 子进程：它只验证「同一个 Promise」这条契约，
// 在任何机器上都能跑（没装 docker 时 dockerAvailableInner 会快速返回 ok:false）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const M = await import(pathToFileURL(path.join(ROOT, 'lib', 'napcat.js')).href)

test('dockerAvailable 并发调用复用同一个 Promise（不再叠加子进程）', async () => {
  const p1 = M.dockerAvailable()
  const p2 = M.dockerAvailable()
  assert.equal(p1, p2, '第二个调用应该拿到同一个 Promise，而不是再起一轮 docker 命令')
  const r = await p1
  assert.equal(typeof r, 'object')
  assert.equal(typeof r.ok, 'boolean')
})

test('dockerAvailable 完成后可以重新探测（in-flight 表被清理）', async () => {
  const p1 = M.dockerAvailable()
  await p1
  const p2 = M.dockerAvailable()
  assert.notEqual(p1, p2, '上一次结束后应该能重新探测（否则状态永远刷新不了）')
  await p2
})

test('loginStatus 并发调用复用同一个 Promise', async () => {
  const cfg = { napcat: { containerName: 'llminqq-napcat-test' } }
  const p1 = M.loginStatus(cfg)
  const p2 = M.loginStatus(cfg)
  assert.equal(p1, p2, '同一个容器的登录状态探测应该合并')
  const r = await p1
  assert.equal(typeof r.loggedIn, 'boolean')
})

test('loginStatus 对不同容器名分别探测', async () => {
  const a = M.loginStatus({ napcat: { containerName: 'llminqq-a' } })
  const b = M.loginStatus({ napcat: { containerName: 'llminqq-b' } })
  assert.notEqual(a, b, '不同容器的探测结果不能混用')
  await Promise.all([a, b])
})

// ── 二维码刷新：必须真的让 NapCat 换码，而不是重新拷一次旧文件 ──────────────
//
// 背景（2026-10-31 用户报的 bug）：
//   「点击刷新二维码接口返回 true，也给了二维码，但是新二维码和旧二维码一样」
//   实测根因：`/qr/refresh` 以前走的是 fetchQrCode()，而它只是 `docker cp`
//   容器里的 qrcode.png —— 全程没有调用 NapCat 的 RefreshQRcode。
//   于是接口当然回 true（cp 成功了），但图片字节级不变。
//
// 这组测试守住三件事：
//   ① 源码里必须真的有调用 NapCat 的刷新接口
//   ② 鉴权必须带缓存（NapCat 的 loginRate 默认 3，每次刷新都重登会 429）
//   ③ token 必须取自 webui.json（盘上那份），不是 secrets 里可能分叉的那份

import fs from 'node:fs'

const SRC = fs.readFileSync(path.join(ROOT, 'lib', 'napcat.js'), 'utf8')

test('刷新二维码真的调用 NapCat 的 RefreshQRcode 接口', () => {
  assert.match(SRC, /\/api\/QQLogin\/RefreshQRcode/,
    '没有调用 NapCat 的刷新接口 —— 那「刷新」只会重新拷一次旧图，用户看到的就是没反应')
})

test('刷新走 WebUI 鉴权，且凭证有缓存（避免撞 loginRate 限流）', () => {
  assert.match(SRC, /\/api\/auth\/login/, '没有登录 WebUI，调不动需要鉴权的接口')
  assert.match(SRC, /webuiCredCache/, '凭证没有缓存 —— 每次刷新都重登会撞上 NapCat 的 loginRate')
  // NapCat 的密码算法：sha256(token + '.napcat')
  assert.match(SRC, /'\.napcat'/, '鉴权 hash 不是 sha256(token + \'.napcat\')，NapCat 会回 token is invalid')
})

test('WebUI token 以盘上的 webui.json 为准（实测会和 secrets 分叉）', () => {
  assert.match(SRC, /export function resolveWebuiToken/, '缺 resolveWebuiToken —— token 又会分叉')
  // webuiUrl 必须走 resolveWebuiToken，不能再直接读 secrets
  const m = SRC.match(/export function webuiUrl[\s\S]{0,600}?\n}/)
  assert.ok(m, '定位不到 webuiUrl')
  assert.match(m[0], /resolveWebuiToken\(/, 'webuiUrl 还在直接读 secrets —— 实测分叉后 WebUI 链接打不开')
})

test('刷新后要确认文件真的变了（不能接口说成功就当成功）', () => {
  assert.match(SRC, /changed: true/, '没有回报 changed —— 前端无法区分「换了」和「没换」')
  assert.match(SRC, /二维码文件没变/, '文件没变时要如实报错，而不是假装刷新成功')
})

test('取二维码默认走 bind mount 直读，不再每个请求都 docker cp', () => {
  assert.match(SRC, /function readQrFromHost/, '缺 bind mount 直读路径 —— 每次打开设置页都要起一个 docker 进程')
  // 快路径必须在 docker cp 之前
  const body = SRC.slice(SRC.indexOf('export async function fetchQrCode'))
  const hostIdx = body.indexOf('readQrFromHost()')
  const cpIdx = body.indexOf("'docker', ['cp'")
  assert.ok(hostIdx > 0 && cpIdx > hostIdx, 'bind mount 快路径不在 docker cp 之前')
})
