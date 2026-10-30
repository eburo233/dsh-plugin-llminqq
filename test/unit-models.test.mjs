// unit-models.test.mjs —— lib/models.js 的单测（表驱动、不联网、不落盘）
//
// 这层是「设置页 ↔ 宿主 llm 服务」的适配：
//   · describeProviders / listModels 面对的是宿主返回的**不可信形状**（不同版本字段名不同），
//     出错必须变成 {ok:false, reason}，不能让设置页白屏
//   · validateRoutes 故意宽松（允许空链），但半填状态（只填 provider 不填 model）
//     必须在保存时就报错 —— 运行期静默不生效比报错更难查
//   · chainView 是设置页画降级链的数据源；source 标记「这条配置从哪来」

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const M = await import(pathToFileURL(path.join(PKG, 'lib', 'models.js')).href)

test('MODEL_CACHE_TTL 是 5 分钟', () => {
  assert.equal(M.MODEL_CACHE_TTL, 5 * 60 * 1000)
})

// ── describeProviders ─────────────────────────────────────────────────────
test('describeProviders: 没有 llm 服务 → ok=false + 可读原因', () => {
  for (const llm of [undefined, null, {}, { listProviders: 'not-a-fn' }]) {
    const got = M.describeProviders(llm)
    assert.equal(got.ok, false)
    assert.match(got.reason, /宿主没有提供 llm 服务/)
    assert.deepEqual(got.providers, [])
  }
})

test('describeProviders: 字段名兜底（provider/id、displayName/name）并过滤空 id', () => {
  const got = M.describeProviders({
    listProviders: () => [
      { provider: 'deepseek', name: 'DeepSeek' },
      { id: 'p2', displayName: 'P2' },
      { provider: 'p3' },          // 没有 displayName/name → 用 provider
      { provider: '' },            // 空 id 必须被过滤
      { id: '' },
    ],
  })
  assert.equal(got.ok, true)
  assert.deepEqual(got.providers, [
    { id: 'deepseek', displayName: 'DeepSeek', hasAdapter: true },
    { id: 'p2', displayName: 'P2', hasAdapter: true },
    { id: 'p3', displayName: 'p3', hasAdapter: true },
  ])
})

test('describeProviders: listProviders 抛错 → ok=false + 带原始 message', () => {
  const got = M.describeProviders({ listProviders: () => { throw new Error('boom') } })
  assert.equal(got.ok, false)
  assert.match(got.reason, /枚举 provider 失败：boom/)
  assert.deepEqual(got.providers, [])
})

test('describeProviders: listProviders 返回非数组 → ok=true 但 providers 为空（宿主怪形状不崩）', () => {
  const got = M.describeProviders({ listProviders: () => ({ nope: true }) })
  assert.deepEqual(got, { ok: true, providers: [] })
})

// ── listModels ────────────────────────────────────────────────────────────
test('listModels: 没有 listModels 能力 → ok=false', async () => {
  for (const llm of [undefined, {}, { listModels: 42 }]) {
    const got = await M.listModels(llm, 'p')
    assert.equal(got.ok, false)
    assert.match(got.reason, /不支持 listModels/)
    assert.deepEqual(got.models, [])
  }
})

const shaped = [
  { id: 'm1', name: 'Model One', description: 'desc', inputModalities: ['text'] },
  { id: 'm2', name: '', description: '', inputModalities: [] },
]

test('listModels: 成功时整形模型字段，并写入缓存', async () => {
  const calls = []
  const cache = new Map()
  const got = await M.listModels({
    listModels: async provider => { calls.push(provider); return [{ id: 'm1', name: 'Model One', description: 'desc', inputModalities: ['text'] }, { id: 'm2' }] },
  }, 'p', cache)
  assert.deepEqual(calls, ['p'])
  assert.equal(got.ok, true)
  assert.equal(got.cached, undefined)
  assert.deepEqual(got.models, [
    { id: 'm1', name: 'Model One', description: 'desc', inputModalities: ['text'] },
    { id: 'm2', name: 'm2', description: '', inputModalities: [] },
  ])
  assert.ok(cache.has('p'), '成功结果应写入缓存')
  assert.deepEqual(cache.get('p').models, got.models)
})

test('listModels: TTL 内命中缓存，不再打宿主', async () => {
  let called = 0
  const cache = new Map([['p', { at: Date.now(), models: [{ id: 'cached' }] }]])
  const got = await M.listModels({ listModels: async () => { called++; return [] } }, 'p', cache)
  assert.equal(called, 0, '缓存命中却又调了宿主')
  assert.deepEqual(got, { ok: true, models: [{ id: 'cached' }], cached: true })
})

test('listModels: 缓存过期（>TTL）→ 重新拉取', async () => {
  let called = 0
  const cache = new Map([['p', { at: Date.now() - M.MODEL_CACHE_TTL - 1, models: [{ id: 'stale' }] }]])
  const got = await M.listModels({ listModels: async () => { called++; return [{ id: 'fresh' }] } }, 'p', cache)
  assert.equal(called, 1)
  assert.deepEqual(got.models, [{ id: 'fresh', name: 'fresh', description: '', inputModalities: [] }])
})

test('listModels: 宿主抛错 → ok=false + 带原始 message（设置页要能显示）', async () => {
  const got = await M.listModels({ listModels: async () => { throw new Error('boom') } }, 'p')
  assert.equal(got.ok, false)
  assert.match(got.reason, /拿模型列表失败：boom/)
  assert.deepEqual(got.models, [])
})

test('listModels: 返回非数组 → 空列表而不是崩', async () => {
  const got = await M.listModels({ listModels: async () => null }, 'p')
  assert.deepEqual(got, { ok: true, models: [] })
})

// ── validateRoutes（表驱动）───────────────────────────────────────────────
const routeCases = [
  {
    name: '不是数组 → 直接报错',
    routes: undefined,
    want: { ok: false, issues: ['fallbackRoutes 必须是数组'] },
  },
  {
    name: '空数组 = 不降级，合法',
    routes: [],
    want: { ok: true, issues: [] },
  },
  {
    name: '完整的一条 → 合法',
    routes: [{ provider: 'deepseek', model: 'deepseek-flash' }],
    want: { ok: true, issues: [] },
  },
  {
    name: '缺 provider',
    routes: [{ model: 'm' }],
    want: { ok: false, issues: ['第 1 条：provider 为空'] },
  },
  {
    name: '缺 model（半填状态必须拦）',
    routes: [{ provider: 'p' }],
    want: { ok: false, issues: ['第 1 条：model 为空'] },
  },
  {
    name: 'provider 全是空白也算空',
    routes: [{ provider: '   ', model: 'm' }],
    want: { ok: false, issues: ['第 1 条：provider 为空'] },
  },
  {
    name: '条目不是对象',
    routes: [null, 'x'],
    want: { ok: false, issues: ['第 1 条：不是对象', '第 2 条：不是对象'] },
  },
  {
    name: '与前面重复 → 指出是第几条重复谁',
    routes: [
      { provider: 'p', model: 'm' },
      { provider: 'p', model: 'm' },
    ],
    want: { ok: false, issues: ['第 2 条：与前面重复（p/m）'] },
  },
  {
    name: '一条里多个问题按顺序报',
    routes: [{ model: 'm' }, { provider: 'p' }],
    want: {
      ok: false,
      issues: ['第 1 条：provider 为空', '第 2 条：model 为空'],
    },
  },
  {
    name: '数字型 provider/model 被 String() 接受（宽松）',
    routes: [{ provider: 1, model: 2 }],
    want: { ok: true, issues: [] },
  },
]

for (const c of routeCases) {
  test(`validateRoutes: ${c.name}`, () => {
    assert.deepEqual(M.validateRoutes(c.routes), c.want)
  })
}

// ── chainView ─────────────────────────────────────────────────────────────
test('chainView: 插件配置了主路由 → source=plugin-config，降级链逐条列出', () => {
  const view = M.chainView({
    dsh: {
      provider: 'p1',
      model: 'm1',
      reasoningEffort: 'high',
      fallbackRoutes: [
        { provider: 'p2', model: 'm2' },
        { provider: 'p3', model: 'm3', reasoningEffort: 'low' },
      ],
      failover: { enabled: true, consecutiveFailures: 2 },
    },
  })
  assert.deepEqual(view.main, {
    role: 'main', provider: 'p1', model: 'm1', reasoningEffort: 'high', source: 'plugin-config',
  })
  assert.deepEqual(view.fallbacks, [
    { role: 'fallback-1', provider: 'p2', model: 'm2', reasoningEffort: '', source: 'plugin-config' },
    { role: 'fallback-2', provider: 'p3', model: 'm3', reasoningEffort: 'low', source: 'plugin-config' },
  ])
  assert.deepEqual(view.failover, { enabled: true, consecutiveFailures: 2 })
})

test('chainView: 插件没配 → 回落到宿主当前选择（source=host-default）', () => {
  const view = M.chainView({ dsh: { provider: '', model: '' } }, { provider: 'hp', model: 'hm', reasoningEffort: 'low' })
  assert.equal(view.main.provider, 'hp')
  assert.equal(view.main.model, 'hm')
  assert.equal(view.main.source, 'host-default')
  assert.deepEqual(view.fallbacks, [])
})

test('chainView: 插件和宿主都没配 → source=unset', () => {
  const view = M.chainView({}, undefined)
  assert.deepEqual(view.main, { role: 'main', provider: '', model: '', reasoningEffort: '', source: 'unset' })
})

// ── applyModelSelection ───────────────────────────────────────────────────
test('applyModelSelection: 写进配置，保留其余键，不碰宿主（未要求同步）', async () => {
  const cfg = { dsh: { provider: 'old', model: 'old', reasoningEffort: 'high', protocol: 'acp' }, enabled: true }
  const got = await M.applyModelSelection(cfg, { provider: 'newp', model: 'newm' })
  assert.equal(got.config.dsh.provider, 'newp')
  assert.equal(got.config.dsh.model, 'newm')
  assert.equal(got.config.dsh.reasoningEffort, 'high', '没传的字段应保留原值')
  assert.equal(got.config.dsh.protocol, 'acp')
  assert.equal(got.config.enabled, true)
  assert.equal(got.hostSynced, false)
  assert.equal(got.hostError, '')
})

test('applyModelSelection: 空选择 → 全部保持原值', async () => {
  const cfg = { dsh: { provider: 'p', model: 'm', reasoningEffort: 'low' } }
  const got = await M.applyModelSelection(cfg, {})
  assert.deepEqual(got.config, cfg)
})

test('applyModelSelection: syncToHost → 调宿主 saveSelection 并回报成功', async () => {
  const saved = []
  const got = await M.applyModelSelection(
    { dsh: { provider: 'p', model: 'm', reasoningEffort: '' } },
    { provider: 'np', model: 'nm', reasoningEffort: 'medium', syncToHost: true },
    { saveSelection: async payload => saved.push(payload) },
  )
  assert.equal(got.hostSynced, true)
  assert.equal(got.hostError, '')
  assert.deepEqual(saved, [{ provider: 'np', model: 'nm', reasoningEffort: 'medium' }])
})

test('applyModelSelection: 宿主 saveSelection 抛错 → 不冒泡，转成 hostError', async () => {
  const got = await M.applyModelSelection(
    { dsh: { provider: 'p', model: 'm', reasoningEffort: '' } },
    { provider: 'np', model: 'nm', syncToHost: true },
    { saveSelection: async () => { throw new Error('denied') } },
  )
  assert.equal(got.config.dsh.provider, 'np', '宿主同步失败也应当先写进插件配置')
  assert.equal(got.hostSynced, false)
  assert.equal(got.hostError, 'denied')
})
