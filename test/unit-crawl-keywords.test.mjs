// test/unit-crawl-keywords.test.mjs —— 「模型根据 persona 自己决定抓什么」+ 历史记录
//
// 背景（2026-11-01 用户需求）：
//   原来抓取关键词是手填在 config.learning.crawlSources 里的，设置页连「关键词」
//   这一栏都没有 —— 抓什么跟人设无关。
//
//   更糟的是 `runCrawl` 起子进程时**没传 LLMINQQ_CONFIG**，脚本于是去读包里那份
//   `lib/bridge/config.json`（那份连 learning 段都没有）→ crawlSources 永远为空
//   → dry-run 返回 {"total":0}。用户实测「keyword 是空的」就是这里。
//
// 现在：点「抓取」→ 模型看着 persona 自己挑关键词 → 抓完记历史 →
//       下次把历史喂回给模型，避免每轮都挑同样的典型话题（采样退化）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const K = await import(pathToFileURL(path.join(ROOT, 'lib', 'agent', 'crawl-keywords.mjs')).href)
const ADMIN_SRC = fs.readFileSync(path.join(ROOT, 'lib', 'agent', 'memory-admin.mjs'), 'utf8')
const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'lib', 'index.js'), 'utf8')

function mkStateDir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'llminqq-crawl-kw-'))
}

// ── ① 模型输出解析（最容易被模型「多说一句话」坑到的地方）─────────────────

test('能解析纯 JSON', () => {
  const r = K.parseKeywordsJson('{"keywords":[{"keyword":"Vlog 日常","domain":"life"}],"reasoning":"贴近人设"}')
  assert.equal(r.ok, true)
  assert.equal(r.keywords.length, 1)
  assert.equal(r.keywords[0].keyword, 'Vlog 日常')
  assert.equal(r.keywords[0].domain, 'life')
  assert.equal(r.reasoning, '贴近人设')
})

test('能解析 ```json 围栏包着的', () => {
  const r = K.parseKeywordsJson('```json\n{"keywords":[{"keyword":"数码评测","domain":"tech"}]}\n```')
  assert.equal(r.ok, true, '带 markdown 围栏必须能解析 —— 模型很爱加围栏')
  assert.equal(r.keywords[0].keyword, '数码评测')
})

test('能解析前面有废话的', () => {
  const r = K.parseKeywordsJson('好的，我选了这些：{"keywords":[{"keyword":"历史故事","domain":"history"}]}')
  assert.equal(r.ok, true, '模型在前面写一句「好的」很常见，必须能抠出来')
  assert.equal(r.keywords[0].keyword, '历史故事')
})

test('能解析「字符串数组」写法（模型不一定听话）', () => {
  const r = K.parseKeywordsJson('{"keywords":["美食探店"]}')
  assert.equal(r.ok, true)
  assert.equal(r.keywords[0].keyword, '美食探店')
  assert.equal(r.keywords[0].domain, 'unknown', '没给 domain 就标 unknown')
})

test('非法 domain 会被纠正成 unknown（不能把脏数据喂给抓取）', () => {
  const r = K.parseKeywordsJson('{"keywords":[{"keyword":"某个东西","domain":"不存在的分区"}]}')
  assert.equal(r.ok, true)
  assert.equal(r.keywords[0].domain, 'unknown')
})

test('最多只取 3 个关键词（防模型一次给一堆）', () => {
  const many = { keywords: Array.from({ length: 8 }, (_, i) => ({ keyword: `kw${i}`, domain: 'tech' })) }
  const r = K.parseKeywordsJson(JSON.stringify(many))
  assert.equal(r.keywords.length, 3)
})

test('空内容 / 坏 JSON 要给出可读的原因（而不是抛错）', () => {
  assert.equal(K.parseKeywordsJson('').ok, false)
  const r = K.parseKeywordsJson('{"keywords":[')
  assert.equal(r.ok, false)
  assert.match(r.reason, /找不到 JSON|解析失败/)
})

// ── ② 历史记录 ──────────────────────────────────────────────────────────────

test('历史能追加、能读回', () => {
  const dir = mkStateDir()
  try {
    K.appendCrawlHistory(dir, {
      keywords: [{ keyword: '数码评测', domain: 'tech' }],
      reasoning: '因为人设喜欢科技',
      fetched: 5,
    })
    const h = K.readCrawlHistory(dir)
    assert.equal(h.runs.length, 1)
    assert.equal(h.runs[0].keywords[0].keyword, '数码评测')
    assert.equal(h.runs[0].fetched, 5)
    assert.ok(h.runs[0].at > 0, '必须记时间戳')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('历史只保留最近 N 轮（不能无限膨胀把 prompt 撑大）', () => {
  const dir = mkStateDir()
  try {
    for (let i = 0; i < K.HISTORY_KEEP + 5; i++) {
      K.appendCrawlHistory(dir, { keywords: [{ keyword: `kw${i}`, domain: 'tech' }], fetched: 1 })
    }
    const h = K.readCrawlHistory(dir)
    assert.equal(h.runs.length, K.HISTORY_KEEP,
      `应该只留 ${K.HISTORY_KEEP} 轮，实际 ${h.runs.length}`)
    // 留下的应该是最新的那批
    assert.equal(h.runs[h.runs.length - 1].keywords[0].keyword, `kw${K.HISTORY_KEEP + 4}`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('历史渲染给模型看时，要包含「抓过什么」和「结果如何」', () => {
  const dir = mkStateDir()
  try {
    K.appendCrawlHistory(dir, { keywords: [{ keyword: '数码评测', domain: 'tech' }], fetched: 5 })
    const text = K.renderHistoryForPrompt(dir)
    assert.match(text, /数码评测/, '要告诉模型抓过什么')
    assert.match(text, /抓到 5 个视频/, '要告诉模型结果如何')
    assert.match(text, /已覆盖过的领域/, '要让模型知道哪些领域已经覆盖')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('抓到 0 条的历史也要显示「没抓到」（这是「该避开」的信号）', () => {
  const dir = mkStateDir()
  try {
    K.appendCrawlHistory(dir, { keywords: [{ keyword: '搜不到的词', domain: 'tech' }], fetched: 0 })
    const text = K.renderHistoryForPrompt(dir)
    assert.match(text, /没抓到内容/,
      '抓 0 条必须标出来 —— 模型下次才知道这个词没用，别重复挑')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('没有历史时给明确的占位（别让模型看到空白）', () => {
  const dir = mkStateDir()
  try {
    assert.match(K.renderHistoryForPrompt(dir), /还没有抓取记录/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ── ③ 决定关键词的入口要能容错（模型不可用不能让抓取死掉）───────────────────

test('没有 llm 服务时返回失败原因，不抛错', async () => {
  const r = await K.decideKeywords({ llm: null, provider: 'p', model: 'm', persona: '', stateDir: mkStateDir() })
  assert.equal(r.ok, false)
  assert.match(r.reason, /llm|模型/)
})

test('没配路由时返回失败原因', async () => {
  const r = await K.decideKeywords({
    llm: { stream: () => (async function * () {})() },
    provider: '', model: '', persona: '', stateDir: mkStateDir(),
  })
  assert.equal(r.ok, false)
  assert.match(r.reason, /路由|provider/)
})

test('能消费 llm.stream 的 text-delta 拼出完整回复', async () => {
  const fakeLlm = {
    stream: () => (async function * () {
      yield { type: 'text-delta', index: 0, text: '{"keywords":[{"keyword":"' }
      yield { type: 'text-delta', index: 0, text: '读书 分享","domain":"knowledge"}]}' }
      yield { type: 'finish' }
    })(),
  }
  const r = await K.decideKeywords({
    llm: fakeLlm, provider: 'p', model: 'm', persona: '我是个爱读书的人', stateDir: mkStateDir(),
  })
  assert.equal(r.ok, true)
  assert.equal(r.keywords[0].keyword, '读书 分享')
})

// ── ④ 关键接线（这两个 bug 曾经都在）───────────────────────────────────────

test('runCrawl 必须把 LLMINQQ_CONFIG 传给子进程（否则脚本读包里那份空配置）', () => {
  assert.match(ADMIN_SRC, /LLMINQQ_CONFIG:\s*configPathForCrawl/,
    '没传 LLMINQQ_CONFIG —— 脚本会去读包里那份没有 learning 段的配置，crawlSources 永远为空')
  assert.match(ADMIN_SRC, /function configPathForCrawl/,
    '缺 configPathForCrawl 实现')
})

test('runCrawl 支持外部传入 sources（模型现决定的清单）', () => {
  assert.match(ADMIN_SRC, /export async function runCrawl \(\{[\s\S]{0,200}sources = null/,
    'runCrawl 签名里没有 sources 参数')
  assert.match(ADMIN_SRC, /'--sources', JSON\.stringify\(sources\)/,
    '没把 sources 传给脚本（脚本支持 --sources 内联 JSON）')
})

test('抓取接口会调模型决定关键词，并在失败时回退到配置清单', () => {
  assert.match(INDEX_SRC, /decideKeywords\(/,
    '接口里没调 decideKeywords —— 关键词又变回手填/预置')
  // 必须有回退：模型挂了不能让抓取直接失败
  const block = INDEX_SRC.slice(INDEX_SRC.indexOf("route === '/memory/crawl' && method === 'POST'"))
  const seg = block.slice(0, 4000)
  assert.match(seg, /回退到配置清单/, '模型不可用时要回退，不能直接失败')
})

test('抓完要记历史，并把本轮决定回给设置页', () => {
  const block = INDEX_SRC.slice(INDEX_SRC.indexOf("route === '/memory/crawl' && method === 'POST'"))
  const seg = block.slice(0, 4000)
  assert.match(seg, /appendCrawlHistory\(/, '抓完没记历史 —— 下次模型不知道抓过什么')
  assert.match(seg, /decided:/, '没把「这轮选了哪些词」回给设置页')
})

test('有独立的 /memory/crawl/history 接口（设置页展示历史用）', () => {
  assert.match(INDEX_SRC, /route === '\/memory\/crawl\/history'/,
    '缺历史查询接口 —— 设置页看不到抓取历史')
})
