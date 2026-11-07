// test/unit-client-split-card.test.mjs —— 设置页「分条」卡片（task-24）
//
// 背景：桥侧拆条参数读的是 `config.affection.splitChars / splitMaxParts`
// （lib/bridge/index.js splitReplyForSend、lib/bridge/state.js splitLongSentence），
// 但插件侧以前**没有 affection 段、也不透传** → 用户只能在 bridge-config.json 里手改，
// 设置页没有入口（「假配置」的另一种形态：用户以为设置页能管，其实管不着）。
//
// 这张卡要防的回归很具体：
//   ① 卡片被删/被挪出「行为」页 → 用户找不到；
//   ② 字段名写错（affection.splitMaxParts → 桥收不到，改了白改）；
//   ③ 输入框范围与插件侧 clamp（lib/index.js AFFECTION_LIMITS 10–200 / 2–10）不一致；
//   ④ 规则文案丢失 → 用户改完不清楚「换行/[SPLIT] 是强制分条」「空格不算」
//      「超出上限并进最后一条」，会误以为参数没生效。
//
// 做法沿用 unit-client-inbound-files：静态断言 + 假 React 真渲染一次「行为」Tab。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const CLIENT_SRC = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8')

// 卡片锚点用相邻两条分节注释（不依赖行号）
const CARD_START = CLIENT_SRC.indexOf('// ── 分条：')
const CARD_END = CLIENT_SRC.indexOf('// ── 语音转文字（ASR）')
const BEHAVIOR_START = CLIENT_SRC.indexOf('function BehaviorTab (')
const TAB_END = CLIENT_SRC.indexOf('function TextAreaCommit (')

/** 去掉注释（判断代码时不该被注释里的字骗过）。 */
function stripComments (src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n')
}

function cardBlock () {
  assert.ok(CARD_START > 0, '定位不到「分条」卡片的分节注释')
  assert.ok(CARD_END > CARD_START, '定位不到卡片后面的「语音转文字」分节注释')
  return CLIENT_SRC.slice(CARD_START, CARD_END)
}

// ── ① 静态断言 ──────────────────────────────────────────────────────────────

test('卡片在「行为」页里，并且紧挨着「入站文件」（用户按「消息怎么发」这一类找）', () => {
  assert.ok(BEHAVIOR_START > 0 && TAB_END > BEHAVIOR_START, '定位不到 BehaviorTab 的边界')
  assert.ok(CARD_START > BEHAVIOR_START && CARD_START < TAB_END, '「分条」卡片不在 BehaviorTab 里')
  const inboundAt = CLIENT_SRC.indexOf('// ── 入站文件')
  assert.ok(inboundAt > 0, '定位不到「入站文件」卡片')
  assert.ok(CARD_START > inboundAt, '「分条」卡片应该放在「入站文件」之后（任务要求的附近）')
  assert.equal((CLIENT_SRC.match(/h\('div', \{ className: 'card-title' \}, '分条'/g) || []).length, 1,
    '「分条」卡片出现了多次（或者标题写错了）')
})

test('卡片用现有组件，保存走 saveConfig，且字段名就是 affection.splitChars / splitMaxParts', () => {
  const block = stripComments(cardBlock())
  assert.match(block, /h\('div', \{ className: 'card' \}/, '没用现有卡片样式')
  assert.match(block, /h\(Field,/, '字段没用现有 Field 组件')
  assert.match(block, /h\(NumberInput,/, '数字输入没用现有 NumberInput 组件')
  // 字段名错了 = 桥收不到（这是这张卡存在的全部意义）
  // 🔴 2026-11-06（P1-2 收尾）：改成**双写** —— `split:{...}`（正解）+ `affection:{...}`
  //   （兼容旧桥/旧插件；也是老配置能被读到的依赖）。所以这里断言两条链路都在，
  //   而不是只认 affection 段名（那正是「撞名」问题的源头）。
  assert.match(block, /clampInt\(v, 10, 200\)/, '单段阈值没夹区间（10–200）')
  assert.match(block, /split: \{ splitChars: n \}/, '单段阈值没写新 split 段')
  assert.match(block, /affection: \{ splitChars: n \}/, '单段阈值没写 affection 段（兼容旧版本）')
  assert.match(block, /clampInt\(v, 2, 10\)/, '每轮最多几条没夹区间（2–10）')
  assert.match(block, /split: \{ splitMaxParts: n \}/, '每轮最多几条没写新 split 段')
  assert.match(block, /affection: \{ splitMaxParts: n \}/, '每轮最多几条没写 affection 段（兼容旧版本）')
  // 只读数据来源是 cfg，不许自己发请求
  assert.doesNotMatch(block, /\bapi\(|\bpost\(|fetch\(/, '卡片自己发请求了 —— 应该走 saveConfig')
  // 当前值从 cfg.affection 读（`const aff = cfg.affection || {}` 在 BehaviorTab 顶部，
  // 卡片里只是引用 aff）—— 所以两处都查。
  const behaviorRegion = CLIENT_SRC.slice(BEHAVIOR_START, TAB_END)
  assert.match(stripComments(behaviorRegion), /const aff = cfg\.affection \|\| \{\}/,
    '没从 cfg.affection 读当前值（老配置会显示空白）')
  assert.match(block, /aff\.splitChars/, '卡片没读 aff.splitChars')
  assert.match(block, /aff\.splitMaxParts/, '卡片没读 aff.splitMaxParts')
})

test('输入框范围和插件侧 clamp 一致（10–200 / 2–10）', () => {
  const block = stripComments(cardBlock())
  assert.match(block, /min: 10, max: 200/, '单段阈值输入框范围不是 10–200')
  assert.match(block, /min: 2, max: 10/, '每轮条数输入框范围不是 2–10')
  assert.match(block, /aff\.splitChars \?\? 30/, '单段阈值兜底默认值不是 30（store 默认 30）')
  assert.match(block, /aff\.splitMaxParts \?\? 5/, '条数兜底默认值不是 5（用户 2026-11-05 定稿 5）')
})

test('规则文案齐全：换行/[SPLIT] 强制分条、空格不算、超出并进最后一条、需重启桥', () => {
  const block = cardBlock()
  assert.match(block, /换行和 \[SPLIT\] 出现就一定分条/, '没说明换行/[SPLIT] 是强制分条')
  assert.match(block, /空格不算分条/, '没说明空格不算分条（用户会以为空格也会拆）')
  assert.match(block, /并进最后一条/, '没说明超出上限时尾部合并')
  assert.match(block, /重启桥/, '没提示「改完要重启桥才生效」')
})

// ── ② 假 React 真渲染（确认卡片真的能跑出元素树、不白屏）──────────────────

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
      try {
        out = type(props)
      } finally {
        ctx.setSeq(prev)
      }
      walk(out)
      return
    }
    walk(props?.children)
  }
  walk(node)
}

/** 真渲染一次设置页并停在「行为」Tab。 */
function renderBehaviorTab (cfg) {
  const fake = makeFakeReact()
  const { React } = fake
  const data = { ok: true, config: cfg, env: {}, secrets: {} }
  // QQPanel 顶部 5 个 useState：tab / data / busy / msg / loading
  const overrides = { QQPanel: ['behavior', data, '', null, false] }
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

/** 按 Field 的 label 取出里面 NumberInput 的 props（value/min/max）。 */
function fieldInput (tree, label) {
  for (const e of tree.elements) {
    if (typeof e.type !== 'function') continue
    if (!/^function\s+Field/.test(String(e.type))) continue
    if (e.props.label !== label) continue
    const kid = Array.isArray(e.props.children) ? e.props.children[0] : e.props.children
    return kid?.props ?? null
  }
  return null
}

const baseCfg = (affection) => ({
  policy: {}, features: {}, tts: {}, mcp: {},
  media: { enabled: true, maxFileBytes: 10485760, sensitiveNames: ['.env'] },
  ...(affection ? { affection } : {}),
})

test('渲染「行为」Tab：「分条」卡片真的渲染出来，规则文案在', () => {
  const tree = renderBehaviorTab(baseCfg({ splitChars: 30, splitMaxParts: 5 }))
  assert.ok(tree.rendered.includes('BehaviorTab'), 'BehaviorTab 没被渲染')
  const txt = tree.text.join('')
  assert.ok(txt.includes('分条'), '渲染结果里没有「分条」卡片标题')
  assert.ok(txt.includes('换行和 [SPLIT] 出现就一定分条'), '规则文案缺失')
  assert.ok(txt.includes('空格不算分条'), '空格说明缺失')
  assert.ok(txt.includes('并进最后一条'), '尾部合并说明缺失')
  assert.ok(txt.includes('重启桥'), '重启提示缺失')
})

test('渲染：输入框显示 cfg 里的值，范围 10–200 / 2–10，兜底 30 / 5', () => {
  const tree = renderBehaviorTab(baseCfg({ splitChars: 45, splitMaxParts: 3 }))
  const chars = fieldInput(tree, '单段阈值（字）')
  assert.ok(chars, '找不到「单段阈值（字）」的输入框')
  assert.equal(chars.value, 45, '没显示配置里的 splitChars')
  assert.equal(chars.min, 10)
  assert.equal(chars.max, 200)

  const parts = fieldInput(tree, '每轮最多几条')
  assert.ok(parts, '找不到「每轮最多几条」的输入框')
  assert.equal(parts.value, 3, '没显示配置里的 splitMaxParts')
  assert.equal(parts.min, 2)
  assert.equal(parts.max, 10)
})

test('渲染：老配置没有 affection 段 → 显示默认 30 / 5（不是空白）', () => {
  const tree = renderBehaviorTab(baseCfg(null))
  assert.equal(fieldInput(tree, '单段阈值（字）')?.value, 30)
  assert.equal(fieldInput(tree, '每轮最多几条')?.value, 5)
})
