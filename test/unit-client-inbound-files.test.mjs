// test/unit-client-inbound-files.test.mjs —— 设置页「入站文件」卡片的静态断言
//
// 为什么只能做静态断言：client.js 走宿主的 window.__ModuleLoader__.load({factory})
// 加载，不是标准 ESM，也不导出任何东西 —— 没有测试能直接 import 它，更没有
// DOM 可以 render（宿主没提供 jsdom，仓库也刻意不引入测试依赖）。
// 所以照 test/unit-panel-perf.test.mjs / plugin-admin.test.mjs 的老办法：
// 读源码，断言「该有的接线都在、该用的组件都用了、没有自己发明新样式」。
//
// 这个卡片要防的回归很具体（task-9）：
//   桥侧早就实现了入站文件下载，但插件侧没透传参数 → 设置页是**假配置**。
//   现在链路是：这张卡 → config.media.* → lib/index.js bridgeConfig() →
//   bridge-config.json → lib/bridge/messaging.js 读它。任何一环断了，
//   用户看到的都是「改了不生效」。这里锁住前端这一环。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const CLIENT_SRC = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8')

// 卡片的锚点用相邻的两条分节注释，不依赖行号（行号每改一次就要跟着改）
const CARD_START = CLIENT_SRC.indexOf('// ── 入站文件')
const CARD_END = CLIENT_SRC.indexOf('// ── 语音（TTS）')
const BEHAVIOR_START = CLIENT_SRC.indexOf('function BehaviorTab (')
const TAB_END = CLIENT_SRC.indexOf('function TextAreaCommit (')

/** 去掉 // 行注释和 /* *\/ 块注释（判断代码时不该被注释里的字骗过）。 */
function stripComments (src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n')
}

function cardBlock () {
  assert.ok(CARD_START > 0, '定位不到「入站文件」卡片的分节注释')
  assert.ok(CARD_END > CARD_START, '定位不到卡片后面的「语音（TTS）」分节注释')
  return CLIENT_SRC.slice(CARD_START, CARD_END)
}

test('卡片在「行为」Tab 里（不是新开一个 Tab）', () => {
  assert.ok(BEHAVIOR_START > 0, '定位不到 BehaviorTab')
  assert.ok(TAB_END > BEHAVIOR_START, '定位不到 BehaviorTab 的结束边界')
  assert.ok(CARD_START > BEHAVIOR_START && CARD_START < TAB_END,
    '入站文件卡片不在 BehaviorTab 里 —— 放错 Tab 用户找不到')
  // Tab 列表没被改动（还是原来那 7 个）。窗口取 800 字符：
  // 数组本身约 8 行，够用；用 indexOf(']') 会命中第一项自己的 ']'（这里踩过）。
  const tabsAt = CLIENT_SRC.indexOf('const tabs = [')
  assert.ok(tabsAt > 0, '定位不到 Tab 列表')
  const tabsBlock = CLIENT_SRC.slice(tabsAt, tabsAt + 800)
  assert.match(tabsBlock, /\['behavior', '行为'\]/)
  assert.equal((tabsBlock.match(/\['\w+',/g) || []).length, 7,
    'Tab 数量变了 —— 这次只该在「行为」里加卡片，不加新 Tab')
})

test('卡片标题 / 开关 / 三个数字输入都在，且用的是现有组件', () => {
  const block = stripComments(cardBlock())
  assert.match(block, /card-title' }, '入站文件'/, '没有「入站文件」卡片标题')
  assert.match(block, /h\(SwitchRow,/, '开关没用现有 SwitchRow 组件')
  assert.match(block, /h\(Field,/, '字段没用现有 Field 组件')
  assert.match(block, /h\(NumberInput,/, '数字输入没用现有 NumberInput 组件')
  // 别自己造样式系统：卡片就是 className: 'card'
  assert.match(block, /className: 'card'/)
  // 关掉开关时数字输入要跟着藏起来，否则用户分不清「开关关了还算不算数」
  assert.match(block, /media\.inboundFileEnabled !== false \? h\(React\.Fragment/, '开关关掉后数字输入没有隐藏')
})

test('四个字段名和 config.media 对齐（对不上 = 桥收不到）', () => {
  const block = stripComments(cardBlock())
  for (const key of ['inboundFileEnabled', 'maxInboundFileBytes', 'maxInboundFiles', 'inboundFileTimeoutMs']) {
    assert.ok(block.includes(key), `卡片里没有 ${key} —— 和 lib/store.js defaults 的键名对不上`)
  }
  // 保存必须走现有的 saveConfig（POST /config），不能自己发请求
  assert.match(block, /onChange: v => saveConfig\(\{ media: \{ inboundFileEnabled: v \} \}\)/)
  assert.match(block, /saveConfig\(\{ media: \{ maxInboundFileBytes:/)
  assert.match(block, /saveConfig\(\{ media: \{ maxInboundFiles:/)
  assert.match(block, /saveConfig\(\{ media: \{ inboundFileTimeoutMs:/)
  assert.doesNotMatch(block, /fetch\(|\/config['"]/, '卡片自己发了请求 —— 应该走 saveConfig')
})

test('输入区间和 lib/index.js 的 clamp 一致（1–100MB / 1–10 / 5–120）', () => {
  const block = stripComments(cardBlock())
  // 前端 min/max 只是浏览器提示，真正的收敛在 clampInt + 插件侧 bridgeConfig 两层
  assert.match(block, /clampInt\(v, 1, 100\) \* 1048576/, '单文件上限没按 MB→字节换算/夹区间')
  assert.match(block, /clampInt\(v, 1, 10\)/, '单条条数没夹区间')
  assert.match(block, /clampInt\(v, 5, 120\) \* 1000/, '超时没按 秒→毫秒 换算/夹区间')
  // 显示时反向换算：配置里存字节/毫秒，页面显示 MB/秒
  assert.match(block, /\(media\.maxInboundFileBytes \?\? 20971520\) \/ 1048576/,
    'MB 显示没有从字节换算 —— 用户会在输入框里看到 20971520')
  assert.match(block, /\(media\.inboundFileTimeoutMs \?\? 30000\) \/ 1000/,
    '秒显示没有从毫秒换算')
})

test('UI 里的兜底默认值和 lib/store.js defaults 一致', () => {
  const block = stripComments(cardBlock())
  // 老配置里没有这些键时，页面不能显示空白（空白会让用户以为坏了）
  assert.ok(block.includes('?? 20971520'), 'UI 里单文件默认值不是 20MB（20971520 字节）')
  assert.ok(block.includes('?? 5'), 'UI 里单条默认值不是 5')
  assert.ok(block.includes('?? 30000'), 'UI 里超时默认值不是 30000ms')
  // 开关默认「开」：桥的判定是 !== false，UI 必须同一条规则
  assert.match(block, /on: media\.inboundFileEnabled !== false/,
    '开关默认值和桥不一致 —— 新用户会看到「关」但桥其实在下载')
})

test('提示了「改完要重启桥」', () => {
  const block = stripComments(cardBlock())
  // 桥只在启动时读一次 bridge-config.json（lib/index.js 里有注释说明），
  // 不提示重启的话用户会以为没保存成功，反复点。
  assert.match(block, /重启桥/, '没有提示「改完要重启桥才生效」')
})

test('client.js 括号仍配平（静态断言的最低门槛）', () => {
  const balanced = (s, a, b) => {
    let d = 0
    for (const ch of s) { if (ch === a) d++; else if (ch === b) { d--; if (d < 0) return false } }
    return d === 0
  }
  // 先抹掉模板字符串和块注释，避免字符串里的括号干扰
  const noTpl = CLIENT_SRC.replace(/`(?:[^`\\]|\\.)*`/g, '``').replace(/\/\*[\s\S]*?\*\//g, '')
  assert.ok(balanced(noTpl, '{', '}'), 'client.js 大括号不配平 —— 设置页会整页白屏')
  assert.ok(balanced(noTpl, '(', ')'), 'client.js 圆括号不配平')
})

// ═══════════════════════════════════════════════════════════════════════════
// 真渲染一次「行为」Tab：卡片不是「源码里看着有」，而是真能跑出 DOM 树
// ═══════════════════════════════════════════════════════════════════════════
//
// 为什么要费劲做一个假 React：这个文件（client.js）历史上两次把整个 Tab
// 搞白屏，都是**引用未声明标识符**（`secrets` / `Buffer`）—— 静态断言看不出
// 这种错，只有真执行一遍组件函数才会抛 ReferenceError。用假 React 跑一遍
// BehaviorTab 是最便宜的「真执行」：能抓住 `media is not defined` 这类手滑。
//
// 假 React 只做「执行组件函数 + 收集元素树」，不模拟状态更新/副作用
// （useEffect 是空的），所以它是冒烟测试，不是渲染测试库。

function makeFakeReact () {
  // 当前正在渲染的组件用哪组 useState 覆盖值（只给 QQPanel 用，见下）
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
    useEffect () {},          // 冒烟测试不跑副作用（那会发 HTTP 请求）
    useLayoutEffect () {},
    useCallback: fn => fn,
    useMemo: fn => fn(),
    useRef: v => ({ current: v }),
    // 真 useState 需要重渲染；这里只要「组件函数能安全跑完」，
    // 所以返回初始值 + 空 setter。SEQ 给 QQPanel 注入非初始状态。
    useState (init) {
      if (!SEQ) return [init, () => {}]
      const i = SEQ.i++
      const ov = SEQ.overrides
      return [ov && i < ov.length ? ov[i] : init, () => {}]
    },
  }
  return { React, setSeq: s => { SEQ = s }, getSeq: () => SEQ, el }
}

/** 把元素树里的函数组件都执行一遍（深度优先），收集文本和所有元素。 */
function runTree (node, React, ctx) {
  ctx.setTextSeq(null)
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
      const prev = ctx.getTextSeq()
      const overrides = ctx.overrides[name] || null
      ctx.setTextSeq(overrides ? { i: 0, overrides } : null)
      let out
      try {
        out = type(props)                       // ← 真正执行组件函数
      } finally {
        ctx.setTextSeq(prev)
      }
      walk(out)
      return
    }
    walk(props?.children)                       // 宿主元素（'div' 等）：只往下走
  }
  walk(node)
}

/** 用假 React 跑一遍设置页（QQPanel），并强制它渲染「行为」Tab。 */
function renderPanel (cfg, data = {}) {
  const fake = makeFakeReact()
  const { React } = fake
  const fakeData = {
    ok: true,
    config: cfg,
    env: {},
    secrets: {},
    ...data,
  }
  // QQPanel 顶部 5 个 useState 的顺序：tab / data / busy / msg / loading。
  // 覆盖成「直接看行为页、数据已就绪、不 loading」——不覆盖的话 QQPanel
  // 会停在 loading 分支，BehaviorTab 根本不会被执行。
  const overrides = { QQPanel: ['behavior', fakeData, '', null, false] }

  let render = null
  const windowStub = {
    __ModuleLoader__: {
      load ({ factory }) {
        // factory 里会往 document.head 塞样式表，所以 document 也要给
        windowStub.__loaderExports = factory(() => React)
      },
    },
  }
  const documentStub = {
    // 样式表注入会写 styleEl.textContent 和 styleEl.dataset.llminqq
    createElement: () => ({ dataset: {}, textContent: '' }),
    head: { appendChild () {} },
  }
  // 直接执行 client.js 源码：它只做一件事 —— 调 window.__ModuleLoader__.load(...)
  const run = new Function('window', 'require', 'document', CLIENT_SRC) // eslint-disable-line no-new-func
  run(windowStub, () => React, documentStub)

  // 从 apply 里把 QQPanel 的 render 函数抠出来（apply 只注册不渲染）
  const mod = windowStub.__loaderExports
  assert.ok(mod && typeof mod.apply === 'function', 'client 没导出 apply')
  mod.apply({
    get: () => ({
      inject: (name, cb) => cb(),
      register: (meta, fn) => { render = fn },
    }),
  })
  assert.ok(typeof render === 'function', 'apply 没有注册设置页组件')

  const ctx = {
    text: [], elements: [], rendered: [],
    overrides,
    setTextSeq: fake.setSeq,
    getTextSeq: fake.getSeq,
  }
  runTree(render(), React, ctx)
  return ctx
}

/**
 * 按 Field 的 label 取出里面 NumberInput 的 value。
 * 不能直接收集整棵树里的 NumberInput：「行为」页的「说话方式」卡片也有
 * 三个 NumberInput（1500 / 400 / 1500），会把断言搅浑（这个测试踩过）。
 */
const INBOUND_LABELS = ['单文件上限（MB）', '单条最多几个', '下载超时（秒）']
function inboundFieldValues (tree) {
  const got = {}
  for (const e of tree.elements) {
    if (typeof e.type !== 'function') continue
    if (!/^function\s+Field/.test(String(e.type))) continue
    if (!INBOUND_LABELS.includes(e.props.label)) continue
    const kid = Array.isArray(e.props.children) ? e.props.children[0] : e.props.children
    got[e.props.label] = kid?.props?.value
  }
  return got
}

test('真渲染「行为」Tab：入站文件卡片能跑出元素树（不白屏）', () => {
  const cfg = {
    policy: {}, features: {}, tts: {}, mcp: {},
    // 故意**不带** media 的 4 个新键：模拟老配置 / 新用户
    media: { enabled: true, maxFileBytes: 10485760, sensitiveNames: ['.env'] },
  }
  const tree = renderPanel(cfg)
  assert.ok(tree.rendered.includes('BehaviorTab'), 'BehaviorTab 没有被渲染（Tab 切不过去？）')
  assert.ok(tree.rendered.includes('NumberInput'), '卡片里的 NumberInput 没被渲染')
  assert.ok(tree.text.join('').includes('入站文件'), '渲染结果里没有「入站文件」卡片标题')
  assert.ok(tree.text.join('').includes('允许接收并下载文件'), '渲染结果里没有开关文案')
  assert.ok(tree.text.join('').includes('重启桥'), '渲染结果里没有「重启桥才生效」的提示')

  // 老配置没这几个键时，页面显示的必须是和 store.js defaults 一致的默认值
  assert.deepEqual(inboundFieldValues(tree), {
    '单文件上限（MB）': 20,
    '单条最多几个': 5,
    '下载超时（秒）': 30,
  })

  // 开关默认开（和桥的 !== false 一致）
  const swRows = tree.elements.filter(e => typeof e.type === 'function' &&
    /^function\s+SwitchRow/.test(String(e.type)) && e.props.label === '允许接收并下载文件')
  assert.equal(swRows.length, 1, `「允许接收并下载文件」开关数量不对：${swRows.length}`)
  assert.equal(swRows[0].props.on, true, '老配置（没有 inboundFileEnabled 键）时开关必须默认开')
})

test('真渲染：开关关掉后三个数字输入不渲染（不留「关了还算数吗」的疑问）', () => {
  const cfg = {
    policy: {}, features: {}, tts: {}, mcp: {},
    media: {
      enabled: true, maxFileBytes: 10485760, sensitiveNames: ['.env'],
      inboundFileEnabled: false,
      maxInboundFileBytes: 5 * 1024 * 1024,
      maxInboundFiles: 2,
      inboundFileTimeoutMs: 10000,
    },
  }
  const tree = renderPanel(cfg)
  assert.deepEqual(inboundFieldValues(tree), {},
    '开关关掉后不该再渲染入站文件的数字输入')
  const swRows = tree.elements.filter(e => typeof e.type === 'function' &&
    /^function\s+SwitchRow/.test(String(e.type)) && e.props.label === '允许接收并下载文件')
  assert.equal(swRows[0].props.on, false, '显式 false 时开关必须显示关')
  assert.ok(tree.text.join('').includes('重启桥'), '关掉开关后也仍要提示重启')
})

test('真渲染：配置了的值会正确换算成 MB / 秒显示', () => {
  const cfg = {
    policy: {}, features: {}, tts: {}, mcp: {},
    media: {
      enabled: true, maxFileBytes: 10485760, sensitiveNames: ['.env'],
      inboundFileEnabled: true,
      maxInboundFileBytes: 7 * 1024 * 1024,
      maxInboundFiles: 3,
      inboundFileTimeoutMs: 45000,
    },
  }
  const tree = renderPanel(cfg)
  assert.deepEqual(inboundFieldValues(tree), {
    '单文件上限（MB）': 7,
    '单条最多几个': 3,
    '下载超时（秒）': 45,
  }, '字节/毫秒没有换算成 MB/秒 —— 用户会在输入框里看到 7340032')
})
