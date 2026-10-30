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
