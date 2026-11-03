// test/unit-client-scheduler-card.test.mjs —— 设置页「定时任务」状态卡片（P1-5 / §4-8）
//
// 背景：docs 里 P1-5 的结论是「绿着坏」——两个后台任务其实都没在工作，而设置页
// 完全不渲染 scheduler 状态（审计时 `grep -c scheduler client.js` = **0**）。
// 用户唯一的发现途径是去翻 scheduler.json。
//
// 所以这次在「记忆」页加了一块只读卡片：每任务的上次运行 / 成功失败 / 连续失败 /
// 死信。数据只从 `/overview` 的 `env.scheduler` 来（已有的 4 秒轮询顺手带回），
// **不新增路由、不额外 fetch** —— 见 test/unit-panel-perf.test.mjs 的三条性能不变量。
//
// 测试分两层（和 unit-client-inbound-files 一样）：
//   ① 静态断言：卡片用了现有组件、没自己发请求、数据来源是 props；
//   ② 假 React 真渲染一次「记忆」Tab：确认文案/徽标真的出来了，而且不白屏
//      （client.js 历史上两次因为 ReferenceError 整页白屏，静态断言看不出来）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const CLIENT_SRC = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8')

// ── ① 静态断言 ──────────────────────────────────────────────────────────────

test('client.js 里真的有 scheduler 状态渲染（审计时这个数字是 0）', () => {
  assert.ok((CLIENT_SRC.match(/scheduler/g) || []).length > 0,
    'client.js 里一个 scheduler 都没有 —— 用户又没有任何途径发现后台任务坏了')
  assert.match(CLIENT_SRC, /function SchedulerCard/, '没有 SchedulerCard 组件')
  // 卡片挂进「记忆」页，并且拿到 /overview 的数据
  const memTabAt = CLIENT_SRC.indexOf('function MemoryTab (')
  assert.ok(memTabAt > 0)
  assert.match(CLIENT_SRC, /h\(SchedulerCard, \{ scheduler: data\?\.env\?\.scheduler \}\)/,
    '卡片没接到 /overview 的 env.scheduler（数据来源要一次轮询带回，别自己再发请求）')
  assert.match(CLIENT_SRC, /tab === 'memory' && h\(MemoryTab, \{ run, setMsg, data \}\)/,
    'MemoryTab 没拿到 data —— 卡片会永远是空')
})

test('卡片塞在「记忆」页里（紧跟记忆库概览），而且用现有组件/类名', () => {
  const memStart = CLIENT_SRC.indexOf('function MemoryTab (')
  const cardAt = CLIENT_SRC.indexOf('h(SchedulerCard, {')
  assert.ok(memStart > 0 && cardAt > memStart, '卡片不在 MemoryTab 里')
  // 只该出现在「记忆」页：不能又在「运行」页塞一份
  assert.equal((CLIENT_SRC.match(/h\(SchedulerCard, \{/g) || []).length, 1, '卡片被挂了多次')

  const block = CLIENT_SRC.slice(CLIENT_SRC.indexOf('function SchedulerCard'), memStart)
  assert.match(block, /className: 'card'/, '没用现有卡片样式')
  assert.match(block, /h\(Badge,/, '状态徽标没用现有 Badge 组件')
  assert.match(block, /className: 'switchrow'/, '行布局没沿用现有 switchrow 样式')
  // 只读：不许有输入框/开关，也不许发请求
  assert.doesNotMatch(block, /h\((NumberInput|Switch|TextInput|TextAreaCommit)/, '这块应该是只读状态，不该有输入控件')
  assert.doesNotMatch(block, /\bapi\(|\bpost\(|fetch\(|\/overview/, '卡片自己发请求了 —— 数据应从 props 来（否则每 4 秒多一次轮询）')
})

// ── ② 假 React 真渲染 ──────────────────────────────────────────────────────

function makeFakeReact () {
  let SEQ = null
  const el = (type, props, ...children) => {
    const p = props ? { ...props } : {}
    if (children.length === 1) p.children = children[0]
    else if (children.length > 1) p.children = children
    return { $$el: true, type, props: p }
  }
  const React = {
    createElement: el,
    Fragment: Symbol.for('qq.fragment'),
    useEffect () {},
    useLayoutEffect () {},
    useCallback: fn => fn,
    useMemo: fn => fn(),
    useRef: v => ({ current: v }),
    useState (init) {
      if (!SEQ) return [init, () => {}]
      const i = SEQ.i++
      const ov = SEQ.overrides
      return [ov && i < ov.length ? ov[i] : init, () => {}]
    },
  }
  return { React, setSeq: s => { SEQ = s }, getSeq: () => SEQ }
}

function runTree (node, React, ctx) {
  const walk = (n) => {
    if (n === null || n === undefined || typeof n === 'boolean') return
    if (typeof n === 'string' || typeof n === 'number') { ctx.text.push(String(n)); return }
    if (Array.isArray(n)) { n.forEach(walk); return }
    const { type, props } = n
    ctx.elements.push({ type, props })
    if (type === React.Fragment) { walk(props.children); return }
    if (typeof type === 'function') {
      const name = (String(type).match(/^function\s+(\w+)/) || [])[1] || 'anonymous'
      ctx.rendered.push(name)
      const prev = ctx.getSeq()
      const overrides = ctx.overrides[name] || null
      ctx.setSeq(overrides ? { i: 0, overrides } : null)
      let out
      try { out = type(props) } finally { ctx.setSeq(prev) }
      walk(out)
      return
    }
    walk(props?.children)
  }
  walk(node)
}

const FAKE_STATS = {
  ok: true, dbExists: true, empty: false,
  total: 10, alive: 9, unowned: 2, dbSizeBytes: 4096,
  stateDir: '/tmp/记忆目录', pythonOk: true, pythonVersion: '3.12.1',
  byLayer: [{ kind: 'episodic', total: 9 }],
  byVisibility: [], byOwner: [],
}

/** 真渲染一次设置页，并强制停在「记忆」Tab。 */
function renderMemoryTab (scheduler) {
  const fake = makeFakeReact()
  const { React } = fake
  const data = { ok: true, config: {}, env: { scheduler }, secrets: {} }
  // QQPanel: tab / data / busy / msg / loading
  // MemoryTab: stats / recent / loading / clearOwner / confirmAll / pending / exportList / importing
  const overrides = {
    QQPanel: ['memory', data, '', null, false],
    MemoryTab: [FAKE_STATS, null, false, '', '', null, null, false],
  }
  let render = null
  const windowStub = {
    __ModuleLoader__: {
      load ({ factory }) { windowStub.__loaderExports = factory(() => React) },
    },
  }
  const documentStub = {
    createElement: () => ({ dataset: {}, textContent: '' }),
    head: { appendChild () {} },
  }
  new Function('window', 'require', 'document', CLIENT_SRC)(windowStub, () => React, documentStub) // eslint-disable-line no-new-func
  windowStub.__loaderExports.apply({
    get: () => ({ inject: (_n, cb) => cb(), register: (_m, fn) => { render = fn } }),
  })
  const ctx = { text: [], elements: [], rendered: [], overrides, setSeq: fake.setSeq, getSeq: fake.getSeq }
  runTree(render(), React, ctx)
  return ctx
}

const textOf = tree => tree.text.join('')
test('渲染「记忆」Tab：定时任务卡片把每任务的状态都显示出来', () => {
  const tree = renderMemoryTab({
    enabled: true,
    python: { ok: true, bin: 'python3', version: '3.12' },
    deadLetterAfter: 5,
    deadLetters: [{ name: 'learn', at: Date.now() - 3600_000, consecutiveFailures: 5, reason: '模型全部失败' }],
    tasks: [
      {
        name: 'ingest', tool: 'memctl', enabled: true, intervalMin: 5, running: false,
        ok: true, kind: null, mode: null, summary: '新增 12 条', consecutiveFailures: 0,
        deadLetter: false, lastRunAt: Date.now() - 60_000, lastError: null,
      },
      {
        name: 'learn', tool: 'lexicon', enabled: true, intervalMin: 720, running: false,
        ok: false, kind: 'exit', mode: 'error', reason: '模型全部失败', consecutiveFailures: 5,
        deadLetter: true, lastRunAt: Date.now() - 7200_000, lastError: '模型全部失败',
      },
      {
        name: 'reflect', tool: 'memctl', enabled: true, intervalMin: 480, running: false,
        ok: true, kind: 'degraded', mode: 'fallback', summary: 'mode=fallback',
        consecutiveFailures: 0, deadLetter: false, lastRunAt: Date.now() - 300_000, lastError: null,
      },
    ],
  })
  assert.ok(tree.rendered.includes('MemoryTab'), '记忆页没被渲染')
  const txt = textOf(tree)
  assert.ok(txt.includes('定时任务'), '没有「定时任务」卡片标题')
  for (const label of ['抓取', '反思', '学习']) {
    assert.ok(txt.includes(label), `任务「${label}」没显示出来`)
  }
  // 三态：死信/失败/降级/成功都要看得见
  assert.ok(txt.includes('死信'), '连续失败达到阈值要显示「死信」')
  assert.ok(txt.includes('连续失败 5'), '要显示连续失败次数')
  assert.ok(txt.includes('降级'), 'fallback 的降级状态要显示成「降级」（不能混进绿色成功）')
  assert.ok(txt.includes('成功'), '成功的任务要显示成功')
  assert.ok(txt.includes('上次'), '要显示上次运行时间')
  assert.ok(txt.includes('每 12 小时'), '要显示执行间隔（12*60 分钟 → 每 12 小时）')
  assert.ok(txt.includes('模型全部失败'), '失败原因要显示出来（否则用户不知道为什么坏）')
  assert.ok(txt.includes('下一轮成功会自动清掉死信'), '死信横幅要说明「不会停跑、会自愈」')

  // 徽标颜色：死信/失败 = bad，降级 = warn，成功 = ok
  const badgeKinds = tree.elements
    .filter(e => typeof e.type === 'function' && /^function\s+Badge/.test(String(e.type)))
    .map(e => e.props.kind)
  assert.ok(badgeKinds.includes('bad'), '死信没有红色徽标')
  assert.ok(badgeKinds.includes('warn'), '降级没有黄色徽标')
  assert.ok(badgeKinds.includes('ok'), '没有绿色徽标')
})

test('渲染：调度器没启用时也要说一句（别让用户以为记忆页坏了）', () => {
  const tree = renderMemoryTab({ enabled: false, tasks: [] })
  const txt = textOf(tree)
  assert.ok(txt.includes('定时任务'), '没有「定时任务」卡片')
  assert.ok(txt.includes('未启用'), '没启用时要有「未启用」徽标')
  assert.ok(/后台任务不会跑/.test(txt), '要解释「记忆只靠桥每轮增量写入」—— 否则用户以为功能坏了')
})

test('渲染：python 不可用要显性提示（否则所有任务静默跳过）', () => {
  const tree = renderMemoryTab({
    enabled: true,
    python: { ok: false, reason: '找不到 python3' },
    deadLetterAfter: 5,
    deadLetters: [],
    tasks: [{
      name: 'ingest', tool: 'memctl', enabled: true, intervalMin: 5, running: false,
      ok: null, kind: null, mode: null, summary: null, consecutiveFailures: 0,
      deadLetter: false, lastRunAt: null, lastError: null,
    }],
  })
  const txt = textOf(tree)
  assert.ok(txt.includes('python 不可用'), 'python 不可用要显示出来')
  assert.ok(txt.includes('找不到 python3'), '要带上具体原因')
  assert.ok(txt.includes('还没跑过'), '从没跑过的任务要显示「还没跑过」，不能是空白')
})

test('渲染：/overview 里没有 scheduler（老宿主/异常）不白屏', () => {
  const tree = renderMemoryTab(null)
  assert.ok(tree.rendered.includes('MemoryTab'))
  assert.ok(!textOf(tree).includes('相关'), '占位文案不对') // 只是确保渲染没炸
  assert.ok(tree.rendered.includes('SchedulerCard'), 'SchedulerCard 还是要被调用（返回 null 即可）')
})
