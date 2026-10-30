// test/unit-carddetail.test.mjs —— 卡片链接抓取的 SSRF 防护
//
// 背景：卡片里的链接是**群成员可控**的，之前 carddetail 直接
// `fetch(url, { redirect: 'follow' })`，绕过了 lib/bridge/security.js 的
// checkUrlSafe。现在每一次 fetch（含重定向的每一跳）都必须先过守卫，
// 被拒绝时跳过抓取 + warn，绝不发请求。
//
// 全程离线：只替换 globalThis.fetch，不发真请求。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const M = await import(pathToFileURL(path.join(ROOT, 'lib', 'bridge', 'carddetail.js')).href)
const { createSecurity } = await import(pathToFileURL(path.join(ROOT, 'lib', 'bridge', 'security.js')).href)

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'llminqq-carddetail-test-'))
const sec = createSecurity({ config: {}, root: path.join(TMP, 'security') })

function withFetch (impl, fn) {
  const original = globalThis.fetch
  globalThis.fetch = impl
  return Promise.resolve().then(fn).finally(() => { globalThis.fetch = original })
}

function redirectTo (location) {
  return { status: 302, ok: false, url: '', headers: new Headers({ location }) }
}

function jsonResponse (body, url = 'https://api.bilibili.com/x/web-interface/view') {
  return {
    status: 200,
    ok: true,
    url,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

test('carddetail: checkUrlSafe 不通过时不发任何 fetch，只 warn', async () => {
  let fetchCalls = 0
  const logs = []
  await withFetch(async () => { fetchCalls += 1; throw new Error('不该发请求') }, async () => {
    const out = await M.enrichCardUrls(['看看这个 https://b23.tv/AbCdE12'], {
      checkUrlSafe: () => ({ ok: false, reason: '测试拒绝' }),
      log: m => logs.push(m),
    })
    assert.deepEqual(out, [], '被拒的链接不能产出详情')
    assert.equal(fetchCalls, 0, '安全守卫不通过时绝不能 fetch')
    assert.ok(logs.some(l => l.includes('安全策略拒绝') && l.includes('测试拒绝')), '必须有 warn 日志')
  })
})

test('carddetail: 默认守卫拒绝内网地址（不 fetch）', async () => {
  let fetchCalls = 0
  await withFetch(async () => { fetchCalls += 1; throw new Error('不该发请求') }, async () => {
    // 不注入 checkUrlSafe：走 carddetail 内置的保守默认守卫（security.js 实例）
    const res = await M.__test.fetchWithTimeout('http://127.0.0.1:18080/send', 1000, { log: () => {} })
    assert.equal(res, null, '内网地址必须被守卫拦下')
    assert.equal(fetchCalls, 0)
  })
})

test('carddetail: 重定向到内网时逐跳校验拦下（manual，不跟随）', async () => {
  const requested = []
  const logs = []
  await withFetch(async (url) => {
    requested.push(String(url))
    return redirectTo('http://127.0.0.1:18080/secret')
  }, async () => {
    const out = await M.enrichCardUrls(['https://b23.tv/SsRf132'], {
      checkUrlSafe: sec.checkUrlSafe,
      log: m => logs.push(m),
    })
    assert.deepEqual(out, [])
    assert.equal(requested.length, 1, '只请求首个公网链接，绝不跟随到内网')
    assert.ok(requested[0].includes('b23.tv'))
    assert.ok(logs.some(l => l.includes('拒绝') && l.includes('127.0.0.1')), '被拒的重定向目标要写进 warn')
  })
})

test('carddetail: 重定向超过 2 跳停止跟随（与 security.js maxRedirects 一致）', async () => {
  const requested = []
  await withFetch(async (url) => {
    requested.push(String(url))
    return redirectTo('https://www.bilibili.com/video/BV1xx411c7mD')
  }, async () => {
    const out = await M.enrichCardUrls(['https://b23.tv/Loop001'], {
      checkUrlSafe: () => ({ ok: true }),
      log: () => {},
    })
    assert.deepEqual(out, [])
    assert.equal(requested.length, M.__test.MAX_REDIRECT_HOPS + 1, '最多跟 2 跳（共 3 次请求）')
  })
})

test('carddetail: 合法短链（302 → BV → API）能展开出详情', async () => {
  const requested = []
  await withFetch(async (url) => {
    requested.push(String(url))
    if (String(url).includes('b23.tv')) return redirectTo('https://www.bilibili.com/video/BV1xx411c7mD')
    return jsonResponse({
      code: 0,
      data: { title: '测试视频', owner: { name: 'UP主' }, duration: 125, stat: { view: 12345 }, desc: '简介' },
    }, String(url))
  }, async () => {
    const out = await M.enrichCardUrls(['分享 https://b23.tv/Good001'], {
      checkUrlSafe: sec.checkUrlSafe,
      log: () => {},
    })
    assert.equal(out.length, 1)
    assert.match(out[0], /^\[视频详情\] 《测试视频》/)
    assert.match(out[0], /UP主/)
    assert.match(out[0], /2:05/)
    assert.match(out[0], /播放 1\.2万/)
    assert.equal(requested.length, 3, '短链 → 真地址 → API 共三次请求')
  })
})
