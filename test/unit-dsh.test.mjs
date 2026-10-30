// test/unit-dsh.test.mjs —— DshRuntime.prompt() 的超时竞速
//
// 背景：`session/prompt` 受理有 30s 上限。之前的写法超时只从 turnWaiters 里删项，
// 不给 waiter 结算 —— 外层 `await dsh.prompt(...)` 可能永远挂住。
// 现在改成「受理 promise 与显式超时 promise 竞速」，超时路径必须 reject 并清理状态。
//
// 全程离线：不 spawn dsh 进程，_request 直接打桩。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const { DshRuntime } = await import(pathToFileURL(path.join(ROOT, 'lib', 'bridge', 'dsh.js')).href)

function makeRuntime (overrides = {}) {
  const rt = new DshRuntime({
    bin: 'dsh',
    profile: 'test',
    cwd: ROOT,
    provider: 'p',
    model: 'm',
    promptRequestTimeoutMs: 60,
    turnTimeoutMs: 5000,
    log: () => {},
    ...overrides,
  })
  rt.ready = true
  return rt
}

test('dsh.prompt: 受理超时 → reject（prompt timeout + session + 耗时）并清空 turnWaiters', async () => {
  const rt = makeRuntime()
  rt._resumed.add('s1')             // 跳过 resume 请求
  rt._request = async () => new Promise(() => {})   // 永不返回，模拟 SDK 不响应
  const t0 = Date.now()
  await assert.rejects(
    rt.prompt('s1', [{ type: 'text', text: 'hi' }]),
    err => {
      assert.match(err.message, /prompt timeout/)
      assert.match(err.message, /s1/)
      assert.match(err.message, /已等待 \d+ms/)
      assert.equal(err.code, 'PROMPT_TIMEOUT')
      return true
    },
  )
  assert.equal(rt.turnWaiters.has('s1'), false, '超时后 waiter 必须从 map 清掉')
  assert.ok(Date.now() - t0 < 3000, '必须真的超时返回，不能挂住')
})

test('dsh.prompt: 正常路径（受理 → assistant/message → turn/end）返回合并文本', async () => {
  const rt = makeRuntime()
  rt._resumed.add('s2')
  rt._request = async () => ({ ok: true })
  const p = rt.prompt('s2', [{ type: 'text', text: 'hi' }])
  await new Promise(r => setTimeout(r, 10))
  assert.equal(rt.turnWaiters.get('s2')?.length, 1, '受理成功后 waiter 应在 map 里')
  rt._onSessionEvent({
    sessionId: 's2',
    event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '你好' }] } } },
  })
  rt._onSessionEvent({ sessionId: 's2', event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } })
  const res = await p
  assert.equal(res.text, '你好')
  assert.equal(res.reason, 'completed')
  assert.equal(rt.turnWaiters.has('s2'), false)
})

test('dsh.prompt: 受理失败（非超时）也清空 waiter 并 reject 调用方', async () => {
  const rt = makeRuntime()
  rt._resumed.add('s3')
  rt._request = async (method) => {
    if (method === 'session/prompt') throw new Error('session not found')
    return {}
  }
  await assert.rejects(rt.prompt('s3', [{ type: 'text', text: 'hi' }]), /session not found/)
  assert.equal(rt.turnWaiters.has('s3'), false)
})

test('dsh.prompt: turn/end 迟迟不来时按 turnTimeoutMs reject（带 session 与耗时）', async () => {
  const rt = makeRuntime({ turnTimeoutMs: 40, promptRequestTimeoutMs: 500 })
  rt._resumed.add('s4')
  rt._request = async () => ({ ok: true })
  await assert.rejects(rt.prompt('s4', [{ type: 'text', text: 'hi' }]), err => {
    assert.match(err.message, /turn 超时/)
    assert.match(err.message, /s4/)
    return true
  })
  assert.equal(rt.turnWaiters.has('s4'), false)
})

test('dsh.prompt: 进程退出（_failAll）会 reject 正在等待的 waiter', async () => {
  const rt = makeRuntime({ promptRequestTimeoutMs: 500, turnTimeoutMs: 5000 })
  rt._resumed.add('s5')
  rt._request = async () => ({ ok: true })
  const p = rt.prompt('s5', [{ type: 'text', text: 'hi' }])
  await new Promise(r => setTimeout(r, 10))
  rt._failAll(new Error('dsh exited'))
  await assert.rejects(p, /dsh exited/)
})
