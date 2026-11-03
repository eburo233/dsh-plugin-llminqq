// test/unit-client-voice-asr.test.mjs —— 设置页「语音转文字」卡片的静态断言
//
// 为什么只能做静态断言：client.js 走宿主的 window.__ModuleLoader__.load({factory})
// 加载，不是标准 ESM，也没导出任何东西（没有 DOM/jsdom 可渲染）。所以照
// unit-client-inbound-files / unit-panel-perf 的老办法：读源码，断言「该有的接线都在、
// 该用的组件都用了」。
//
// 这个卡片要防的回归很具体（task-10）：
//   桥侧已经能转写语音，但如果设置页没把配置写进 config.media.voiceTranscribe，
//   用户开了也没用 —— 又一次「假配置」。链路：
//   这张卡 → config.media.voiceTranscribe.* → lib/index.js bridgeConfig()
//   → bridge-config.json → lib/bridge/messaging.js transcribeInboundVoices()。
// 真渲染冒烟由 unit-client-inbound-files.test.mjs 覆盖（同一个 BehaviorTab）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const CLIENT_SRC = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8')

// 用相邻分节注释当锚点（行号每改一次就得跟着改，注释稳定）
const CARD_START = CLIENT_SRC.indexOf('// ── 语音转文字（ASR）')
const CARD_END = CLIENT_SRC.indexOf('// ── 语音（TTS）')
const BEHAVIOR_START = CLIENT_SRC.indexOf('function BehaviorTab (')
const TAB_END = CLIENT_SRC.indexOf('function TextAreaCommit (')

function stripComments (src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n')
}
function cardBlock () {
  assert.ok(CARD_START > 0, '定位不到「语音转文字（ASR）」分节注释')
  assert.ok(CARD_END > CARD_START, '定位不到卡片后面的「语音（TTS）」分节注释')
  return CLIENT_SRC.slice(CARD_START, CARD_END)
}

test('卡片在「行为」Tab 里、且在「入站文件」卡片旁边（不是新开一个 Tab）', () => {
  assert.ok(BEHAVIOR_START > 0, '定位不到 BehaviorTab')
  assert.ok(TAB_END > BEHAVIOR_START, '定位不到 BehaviorTab 结束边界')
  assert.ok(CARD_START > BEHAVIOR_START && CARD_START < TAB_END,
    '语音转文字卡片不在 BehaviorTab 里 —— 放错 Tab 用户找不到')
  // 紧跟在入站文件卡片后面（语音和文件都是「收进来的消息怎么处理」同一类）
  const inbound = CLIENT_SRC.indexOf('// ── 入站文件')
  assert.ok(inbound > 0 && inbound < CARD_START, '卡片没放在「入站文件」卡片附近')
  // Tab 数量不能被这次改动影响
  const tabsAt = CLIENT_SRC.indexOf('const tabs = [')
  const tabsBlock = CLIENT_SRC.slice(tabsAt, tabsAt + 800)
  assert.equal((tabsBlock.match(/\['\w+',/g) || []).length, 7,
    'Tab 数量变了 —— 这次只该在「行为」里加卡片，不加新 Tab')
})

test('卡片标题 / 开关 / 模型选择 / 语言 / 超时都用现有组件', () => {
  const block = stripComments(cardBlock())
  assert.match(block, /card-title' }, '语音转文字'/, '没有「语音转文字」卡片标题')
  assert.match(block, /h\(SwitchRow,/, '开关没用现有 SwitchRow 组件')
  assert.match(block, /h\(Field,/, '字段没用现有 Field 组件')
  assert.match(block, /h\(NumberInput,/, '超时输入没用现有 NumberInput')
  assert.match(block, /h\('select'/, '模型选择没用现有的原生 select 写法')
  assert.match(block, /h\(TextInput,/, '语言输入没用现有 TextInput')
  assert.match(block, /className: 'card'/)
})

test('字段名和 config.media.voiceTranscribe 对齐（对不上 = 桥收不到）', () => {
  const block = stripComments(cardBlock())
  for (const key of ['voiceTranscribe', 'enabled', 'model', 'lang', 'timeoutMs']) {
    assert.ok(block.includes(key), `卡片里没有 ${key} —— 和 store/bridgeConfig 的键名对不上`)
  }
  assert.match(block, /saveConfig\(\{ media: \{ voiceTranscribe: \{ enabled: v \} \} \}\)/)
  assert.match(block, /saveConfig\(\{ media: \{ voiceTranscribe: \{ model: e\.target\.value \} \} \}\)/)
  assert.match(block, /saveConfig\(\{ media: \{ voiceTranscribe: \{ lang:/)
  assert.match(block, /saveConfig\(\{ media: \{ voiceTranscribe: \{ timeoutMs:/)
  assert.doesNotMatch(block, /fetch\(|\/config['"]/, '卡片自己发了请求 —— 应该走 saveConfig')
})

test('默认值与桥/插件一致：默认关、small、zh、30s', () => {
  const block = stripComments(cardBlock())
  // 桥侧判定是 `enabled === true`；开关 UI 必须同一条规则（否则显示开、桥却是关）
  assert.match(block, /on: media\.voiceTranscribe\?\.enabled === true/,
    '开关默认值和桥不一致 —— 新用户会看到「开」但其实没转写')
  assert.match(block, /media\.voiceTranscribe\?\.model \|\| 'small'/, '模型默认值不是 small')
  assert.match(block, /media\.voiceTranscribe\?\.lang \|\| 'zh'/, '语言默认值不是 zh')
  assert.match(block, /media\.voiceTranscribe\?\.timeoutMs \?\? 30000/, '超时默认值不是 30000ms')
  // 关掉开关时把下面的输入藏起来，否则用户分不清「关了还算数吗」
  assert.match(block, /media\.voiceTranscribe\?\.enabled === true \? h\(React\.Fragment/,
    '开关关掉后输入项没有隐藏')
})

test('模型选项有 tiny/base/small/medium，且 small 标成推荐（用户拍板的默认）', () => {
  const block = stripComments(cardBlock())
  for (const m of ['tiny', 'base', 'small', 'medium']) {
    assert.match(block, new RegExp(`value: '${m}'`), `模型下拉里没有 ${m}`)
  }
  assert.match(block, /small（推荐/, 'small 没标推荐（用户 2026-11-03 拍板默认 small）')
  // 体积要标给用户看：不说体积，用户不知道首次会下 480MB
  assert.match(block, /75MB/)
  assert.match(block, /480MB/)
})

test('写清了首次使用成本：装依赖 + 下载模型 + 要重启桥', () => {
  const block = stripComments(cardBlock())
  assert.match(block, /faster-whisper/, '没提依赖名 —— 用户不知道要 pip install 什么')
  assert.match(block, /pip install faster-whisper/, '没给安装命令')
  assert.match(block, /首次使用/, '没写「首次使用要下载模型」')
  assert.match(block, /480MB/, '没写默认模型的体积')
  assert.match(block, /重启桥/, '没提示改完要重启桥才生效')
  // 超时口径要和桥一致：整条消息合计，而不是每条语音各 30s
  assert.match(block, /合计超过这个时间/, '超时的口径没写清（整条消息合计）')
})

test('client.js 括号仍配平（静态断言的最低门槛）', () => {
  const balanced = (s, a, b) => {
    let d = 0
    for (const ch of s) { if (ch === a) d++; else if (ch === b) { d--; if (d < 0) return false } }
    return d === 0
  }
  const noTpl = CLIENT_SRC.replace(/`(?:[^`\\]|\\.)*`/g, '``').replace(/\/\*[\s\S]*?\*\//g, '')
  assert.ok(balanced(noTpl, '{', '}'), 'client.js 大括号不配平 —— 设置页会整页白屏')
  assert.ok(balanced(noTpl, '(', ')'), 'client.js 圆括号不配平')
})
