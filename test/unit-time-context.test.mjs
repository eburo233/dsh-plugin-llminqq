// test/unit-time-context.test.mjs —— 模型不该「不看时间瞎编场景」
//
// 背景（2026-11-01 用户实测）：
//   周日**下午** 5 点多，机器人问「加班加完了？这会儿是工位摸鱼还是已经躺下了」
//   —— 凭空把对方当成在加班。
//
// 查了记忆：3022464706 的记忆里**只有一条**含「加班」，就是它自己刚才说的那句
// （被记成情节记忆）。摘要里没有任何「他要加班」的事实。
// 所以「加班」是模型**自己编的**。
//
// 为什么它会编：提示词里确实有 `当前时间：2026/11/1 17:53:34`，
// 但那只是一串数字 —— 模型得自己算出「这是周日、下午」，
// 再推出「周日一般不上班」。LLM 最不擅长这种隐含推理。
//
// 修法：把结论**直接写给模型**（星期几 / 时段 / 这个点正常人一般在干嘛 /
// 明确警告别凭空假设在上班）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SRC = fs.readFileSync(path.join(ROOT, 'lib', 'bridge', 'index.js'), 'utf8')

/** 从源码里抠出 timeSceneHint 函数体并执行（它是模块私有的） */
function loadSceneHint () {
  const i = SRC.indexOf('function timeSceneHint')
  assert.ok(i > 0, '定位不到 timeSceneHint')
  const j = SRC.indexOf('/** 深夜时给模型的提示', i)
  assert.ok(j > i, '定位不到函数结尾')
  const body = SRC.slice(i, j).trim()
  // eslint-disable-next-line no-eval
  return eval(`(${body})`)
}

test('周日 17 点必须明确说「不是上班时间」并警告别脑补加班', () => {
  const hint = loadSceneHint()(17, 0)
  assert.match(hint, /周日/, '要说出星期几 —— 模型自己算「2026/11/1 是周日」会算错')
  assert.match(hint, /下午/, '要说出时段')
  assert.match(hint, /休息日/, '周末要标出来')
  assert.match(hint, /不是上班时间/,
    '这是本次事故的直接防线 —— 周日 17 点必须点明「不是上班时间」')
  assert.match(hint, /不要凭空假设对方在上班|别凭空假设/,
    '必须明确警告别脑补场景，否则模型还会自己编「加班」')
})

test('工作日晚上不能被说成上班时间', () => {
  const hint = loadSceneHint()(20, 1)
  assert.match(hint, /周一/, '星期要标对')
  assert.match(hint, /晚上/)
  assert.match(hint, /下班|休息/, '工作日晚上应该提「下班/休息」')
  assert.doesNotMatch(hint, /不是上班时间/, '工作日不该出现「不是上班时间」这句（那是周末专用）')
})

test('凌晨要有「正是睡觉的时间」的语义', () => {
  const hint = loadSceneHint()(3, 2)
  assert.match(hint, /凌晨|深夜/)
  assert.match(hint, /睡觉/, '凌晨要点明这是睡觉时间')
})

test('每个时段都能生成（不能有 undefined/空字符串）', () => {
  const fn = loadSceneHint()
  for (let h = 0; h < 24; h++) {
    for (const w of [0, 3, 6]) {
      const out = fn(h, w)
      assert.ok(typeof out === 'string' && out.length > 30,
        `hour=${h} weekday=${w} 生成了空内容`)
      assert.doesNotMatch(out, /undefined/,
        `hour=${h} weekday=${w} 输出里有 undefined`)
      assert.match(out, /【时间场景】/, `hour=${h} weekday=${w} 缺标题`)
    }
  }
})

test('时区必须按配置的来（UTC 容器里不能把下午算成上午）', () => {
  // 这是本次事故里差点又踩到的坑：本机 getHours() 是 9，用户那边是 17
  assert.match(SRC, /function hourNow/,
    '缺 hourNow —— 直接用 getHours() 在 UTC 容器里会把时段算错 8 小时')
  assert.match(SRC, /toLocaleString\('en-US',\s*\{\s*timeZone:\s*tz/,
    'hourNow 没按时区取小时')
  assert.match(SRC, /function weekdayNow/, '缺 weekdayNow')
  // 不能有裸的 new Date().getHours()
  const promptBlock = SRC.slice(SRC.indexOf('timeSceneHint(hourNow()'), SRC.indexOf('timeSceneHint(hourNow()') + 100)
  assert.match(promptBlock, /hourNow\(\),\s*weekdayNow\(\)/,
    '提示词里必须用 hourNow()/weekdayNow()，不能用本机时区')
})

test('时间场景要进到提示词里（不能只是定义了不用）', () => {
  assert.match(SRC, /timeSceneHint\(hourNow\(\), weekdayNow\(\)\)/,
    '定义了 timeSceneHint 却没接进提示词 —— 模型还是只看那串数字')
})

test('提示里要说明「这是背景常识，不是事实断言」', () => {
  const hint = loadSceneHint()(14, 0)
  assert.match(hint, /背景常识|不是事实断言/,
    '要区分「通常」和「此刻」—— 否则模型会把「周末一般不上班」当成「他此刻一定在家」')
})
