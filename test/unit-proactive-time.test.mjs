// test/unit-proactive-time.test.mjs —— 主动搭话/接话必须知道「现在几点」
//
// 背景（2026-11-02）：
//   入站回复的 prompt 里早就有一套时间上下文（2026-11-01「周日加班」事故的修复：
//   hourNow/weekdayNow/timeSceneHint，见 unit-time-context.test.mjs）。
//   但**主动搭话（proactiveSpeak）和接话（chatFollowSpeak）**的 prompt 里没有时间 ——
//   模型只能从「上次说话多久之前」猜现在几点，于是半夜说「中午吃啥」、
//   上午的事硬接到夜里。而且 proactive 里还有一句「核对现在时间，过了就问结果」，
//   没有时间这就是一句空话。
//
// 修法：复用入站那套 helper，在两条主动路径 prompt 顶部加一行
//   【当前时间】当前时间：2026-11-03 12:35 周一（下午）
// 时段划分（timePhaseName）和日期格式化（formatClockMinute）都搬进 common.js，
// 入站/主动共用同一份，避免两边算出不同的「现在是什么时段」。
//
// 这里锁三件事：
//   ① 共用的时段划分 / 时间格式化本身正确（含时区）
//   ② currentTimeLine 的输出格式和「星期/时段」口径
//   ③ 两条主动路径的 prompt 顶部真的用了它（不能只是定义了不用）

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  timePhaseName, formatClockMinute, WEEKDAY_NAMES,
} from '../lib/bridge/common.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SRC = fs.readFileSync(path.join(ROOT, 'lib', 'bridge', 'index.js'), 'utf8')

/** 按花括号配平从源码里抠出一个顶层 function（含 async 函数）。 */
function fnSource (name) {
  const i = SRC.indexOf(`function ${name}`)
  assert.ok(i > 0, `定位不到 ${name}`)
  const start = SRC.indexOf('{', i)
  let depth = 0
  let end = start
  for (let k = start; k < SRC.length; k++) {
    if (SRC[k] === '{') depth++
    else if (SRC[k] === '}') { depth--; if (depth === 0) { end = k + 1; break } }
  }
  return SRC.slice(i, end)
}

/** 抠出 currentTimeLine 及其依赖，注入 config stub 后返回函数。 */
function loadCurrentTimeLine () {
  const config = { policy: { timezone: 'Asia/Shanghai' } }
  const code = [
    fnSource('hourNow'),
    fnSource('weekdayNow'),
    fnSource('currentTimeLine'),
  ].join('\n')
  // eslint-disable-next-line no-eval
  return eval(`${code}\n;currentTimeLine`)
}

// ── ① 时段划分（共用 helper）───────────────────────────────────────────────
// 和 index.js timeSceneHint 原来的 if 链条逐档对齐 —— 这次只是把判定搬出来，
// 不能顺手改语义：0 点是「深夜」（还醒着），1–4 点才算「凌晨」。
const phaseCases = [
  [0, '深夜'], [1, '凌晨'], [4, '凌晨'], [5, '清早'], [8, '清早'],
  [9, '上午'], [11, '上午'], [12, '中午'], [13, '中午'],
  [14, '下午'], [17, '下午'], [18, '晚上'], [21, '晚上'],
  [22, '深夜'], [23, '深夜'],
]
for (const [hour, want] of phaseCases) {
  test(`timePhaseName(${hour}) → ${want}`, () => {
    assert.equal(timePhaseName(hour), want)
  })
}

test('timePhaseName 覆盖 0–23 全部小时，不会返回空', () => {
  for (let h = 0; h < 24; h++) {
    assert.ok(['清早', '上午', '中午', '下午', '晚上', '深夜', '凌晨'].includes(timePhaseName(h)),
      `hour=${h} 返回了非法时段：${timePhaseName(h)}`)
  }
})

// ── ② 时间格式化：必须按目标时区 ──────────────────────────────────────────
// 桥常跑在 UTC 容器里，而用户在中国。用本机时区会把「下午 5 点」算成「上午 9 点」，
// 和 2026-11-01 那次「周日加班」事故同一个根因。
test('formatClockMinute：UTC 04:35 → 上海 12:35（按时区，不是本机）', () => {
  const d = new Date('2026-11-03T04:35:00Z')
  assert.equal(formatClockMinute(d, 'Asia/Shanghai'), '2026-11-03 12:35')
  assert.equal(formatClockMinute(d, 'UTC'), '2026-11-03 04:35')
})

test('formatClockMinute：跨日边界也按时区', () => {
  // UTC 2026-11-02 17:30 = 上海 2026-11-03 01:30
  const d = new Date('2026-11-02T17:30:00Z')
  assert.equal(formatClockMinute(d, 'Asia/Shanghai'), '2026-11-03 01:30')
})

test('WEEKDAY_NAMES：0=周日 … 6=周六（和 weekdayNow 的约定一致）', () => {
  assert.deepEqual(WEEKDAY_NAMES, ['周日', '周一', '周二', '周三', '周四', '周五', '周六'])
})

// ── ③ currentTimeLine：格式 + 口径 ─────────────────────────────────────────
test('currentTimeLine 输出格式：当前时间：YYYY-MM-DD HH:mm 周X（时段）', () => {
  const line = loadCurrentTimeLine()()
  assert.match(
    line,
    /^当前时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2} 周[一二三四五六日]（(清早|上午|中午|下午|晚上|深夜|凌晨)）$/,
    `【当前时间】格式不对：${line}`,
  )
  // 时段必须和这一行里的「HH 点」自洽（同一个 helper 算出来的，不能互相打架）
  const hour = Number(line.slice(line.indexOf('：') + 1).slice(11, 13))
  assert.equal(line.slice(line.indexOf('（') + 1, line.indexOf('）')), timePhaseName(hour))
})

test('currentTimeLine 的星期和上海时区一致（不信本机时区）', () => {
  const line = loadCurrentTimeLine()()
  const tz = 'Asia/Shanghai'
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  const short = new Date().toLocaleString('en-US', { timeZone: tz, weekday: 'short' })
  assert.ok(line.includes(WEEKDAY_NAMES[map[String(short).slice(0, 3)]]),
    `星期算错了：${line}（上海时区应为 ${short}）`)
})

// ── ④ 两条主动路径的 prompt 顶部必须注入 ──────────────────────────────────
test('proactiveSpeak 的 prompt 顶部有【当前时间】', () => {
  const body = fnSource('proactiveSpeak')
  // lines 数组的第一项就是 currentTimeLine()（前面允许有注释行）
  assert.match(body, /const lines = \[\s*(?:\/\/[^\n]*\n\s*)*currentTimeLine\(\)/,
    'proactiveSpeak 的 prompt 第一项不是 currentTimeLine()')
  // 「摘要已存在，别动」：memDigest 注入要保留
  assert.match(body, /【你的记忆摘要】/, '别把记忆摘要弄丢了')
})

test('chatFollowSpeak 的 prompt 顶部有【当前时间】', () => {
  const body = fnSource('chatFollowSpeak')
  assert.match(body, /const lines = \[\s*(?:\/\/[^\n]*\n\s*)*currentTimeLine\(\)/,
    'chatFollowSpeak 的 prompt 第一项不是 currentTimeLine()')
  assert.match(body, /【你的记忆摘要】/, '别把记忆摘要弄丢了')
})

test('入站回复也用同一行（三条路径一个时间口径）', () => {
  // handleInbound 里原来的 toLocaleString('zh-CN') 那行已换成 currentTimeLine()，
  // 否则入站和主动搭话会给模型两个不同格式的「现在」。
  assert.ok(
    (SRC.match(/currentTimeLine\(\)/g) ?? []).length >= 3,
    'currentTimeLine() 至少要在入站/主动搭话/接话三处使用',
  )
  assert.match(SRC, /timeSceneHint\(hourNow\(\), weekdayNow\(\)\)/,
    '时间场景（时段结论）不能丢 —— 只给一行时间还是会让模型瞎推')
})
