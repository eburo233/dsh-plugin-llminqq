// test/memory-v5-search.test.mjs —— 记忆 v5 检索 + 注入渲染层（Step 2）
//
// 测的是 lib/agent/memory-v5/search.mjs：绝对量打分、MMR 去冗余、字数预算装填、
// 会话水位线跳过、dm_only/scope 过滤、单字 LIKE 回退、渲染时间/类型标签、
// 防复读块、人物画像块、总预算 ≤800。全部在 os.tmpdir() 的临时 v5 库里跑，
// 不碰生产库，也不 import v4 的任何东西。
//
// 为什么值得逐项钉住（每条都对应审计文档里的一个实测问题）：
//   · rel 全库归一（§3.3b）—— v4 用「本次查询最高分」做分母 → top1 恒 1.0，
//     阈值形同虚设（P0-3 精度 2.3%）。这里用公式复算，防止有人改回相对归一。
//   · 预算装填（§3.3c）—— v4 maxRows=6 硬砍，长记忆挤掉短记忆。这里断言
//     `charLen(block) <= budgetChars` 且不会把半行硬塞进去。
//   · 水位线（§3.3c）—— v4 把当前会话正在聊的内容又当回忆注入（171 条重复）。
//   · dm_only 场合（P1-3）—— 私聊内容不能在群里被当众复述。
//   · 类型权重/时间标签（§3.7）—— 模型要分得清「规矩」和「上周的闲聊」。
//
// 打分公式的期望值在本文件里**独立复算**（不直接读被测常量当答案），
// 这样把公式改坏时测试真的会红。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const { openV5 } = await import(pathToFileURL(path.join(ROOT, 'lib', 'agent', 'memory-v5', 'store.mjs')).href)
const S = await import(pathToFileURL(path.join(ROOT, 'lib', 'agent', 'memory-v5', 'search.mjs')).href)
const {
  searchForPrompt, rankMemories, renderMemories, utteranceBlock, profileBlock,
  buildMemoryBlocks, scoreMemory, recencyScore, relativeTimeLabel, charLen,
  similarity, contextWatermark, TYPE_HALF_LIFE_DAYS, W_SALIENCE, W_PINNED, LIKE_REL,
} = S

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'llminqq-v5-search-'))
test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* ignore */ } })

let caseNo = 0
/** 每个用例一个独立库（互不影响，也避免 FTS/WAL 状态串味）。 */
function mkStore () {
  caseNo += 1
  const dir = path.join(TMP, String(caseNo))
  fs.mkdirSync(dir, { recursive: true })
  const store = openV5({ dbPath: path.join(dir, 'mem-v5.db'), log: () => {} })
  return { store, dir }
}

// 固定「现在」（秒）。用固定值而不是 Date.now()，否则 recency/时间标签断言会飘。
const NOW = 1_800_000_000
const DAY = 86400
const HOUR = 3600
const QQ = '1000000001'
const PEER_C2C = 'c2c:1000000001'
const PEER_GROUP = 'group:2000000002'

/** 插一条记忆（默认：关于 QQ、私聊、1 小时前、中等重要）。 */
function addMem (store, m = {}) {
  return store.insertMemory({
    type: 'fact',
    text: '默认记忆内容',
    subject: QQ,
    conv: PEER_C2C,
    salience: 0.5,
    created: NOW - 3600,
    lastSeen: NOW - 3600,
    ...m,
  }).id
}

/** 独立复算期望分数（不用被测函数的输出当答案）。 */
function expectedScore ({ mem, rel, now }) {
  const weight = { rule: 1.0, fact: 1.0, preference: 1.0, commitment: 0.97, relation: 0.95, episode: 0.9 }[mem.type] ?? 1
  const halfLife = { rule: 365, relation: 120, preference: 90, fact: 60, commitment: 30, episode: 3 }[mem.type] ?? 30
  const ageDays = Math.max(0, (now - mem.last_seen) / DAY)
  const recency = Math.pow(0.5, ageDays / halfLife)
  const pinned = mem.salience >= 0.9 ? 1 : 0
  const base = 0.55 * rel + 0.22 * mem.salience + 0.18 * recency + 0.10 * pinned
  return { score: weight * base, recency, pinned }
}

// ── ① 中文 bigram 检索 ─────────────────────────────────────────────────────

test('中文 bigram 命中：query「开会」能检索到「明天下午三点开会」', () => {
  const { store } = mkStore()
  const id = addMem(store, { text: '明天下午三点开会，地点三楼会议室', type: 'fact' })
  addMem(store, { text: '他喜欢喝不加糖的冰美式', type: 'preference' })

  const ranked = rankMemories({ store, query: '开会', subject: QQ, conv: PEER_C2C, now: NOW, contextSince: false })
  assert.equal(ranked.via, 'fts', '应该走 FTS（bigram 预分词）')
  assert.ok(ranked.items.some(it => it.id === id), `应命中开会那条：${JSON.stringify(ranked.items.map(i => i.text))}`)
  assert.equal(ranked.items[0].id, id, '命中的那条应排第一')
})

test('rel 用**全库归一**（-bm25/log(1+N)），不是「本次查询最高分」；分数可按公式复算', () => {
  const { store } = mkStore()
  // 造够多的填充记忆，让 N 足够大 → log(1+N) 有意义，rel 不会被 clamp 成 1
  for (let i = 0; i < 30; i++) addMem(store, { text: `填充事实第${i}条：他平时不太聊这个`, type: 'fact', salience: 0.4 })
  const id = addMem(store, { text: '明天下午三点开会，地点三楼会议室', type: 'fact', salience: 0.6 })

  const ranked = rankMemories({ store, query: '开会', subject: QQ, conv: PEER_C2C, now: NOW, contextSince: false })
  const item = ranked.items.find(i => i.id === id)
  assert.ok(item, '开会那条应命中')

  // 从 store 的原始 BM25 复算（这是「全库归一」的公式，不是本次查询 max）
  const N = store.stats().memories.active
  assert.equal(ranked.docCount, N, 'N 应是全库 active 条数')
  const raw = store.searchFts({ query: '开会', limit: 10 }).find(r => r.id === id)
  assert.ok(raw, '原始 FTS 应能查到同一条')
  const rel = Math.min(1, Math.max(0, raw.score / Math.log(1 + N)))
  assert.ok(Math.abs(item.rel - rel) < 1e-9, `rel 应按全库归一：期望 ${rel}，实际 ${item.rel}`)

  const exp = expectedScore({ mem: store.getMemory(id), rel, now: NOW })
  assert.ok(Math.abs(item.score - exp.score) < 1e-9,
    `分数应按公式 0.55rel+0.22sal+0.18rec+0.10pinned（×类型权重）：期望 ${exp.score}，实际 ${item.score}`)
  // 反例保护：如果实现改回「本次查询最高分」的归一，top1 的 rel 会恒等于 1
  assert.ok(item.rel < 0.999, `全库归一下 rel 不应恒为 1（实际 ${item.rel}）——那说明用的是本次查询最高分`)
})

test('类型权重：rule/fact/preference 优先于 episode（同相关度下稳的排前面）', () => {
  const { store } = mkStore()
  // 同一句话、同一个时间、同一重要性，只有 type 不同 → rel 完全一样，只比类型权重
  const text = '开黑前先说一句'
  const ruleId = addMem(store, { text, type: 'rule', salience: 0.5 })
  const epId = addMem(store, { text, type: 'episode', salience: 0.5 })

  const ranked = rankMemories({ store, query: '开黑', subject: QQ, conv: PEER_C2C, now: NOW, contextSince: false })
  const rule = ranked.items.find(i => i.id === ruleId)
  const ep = ranked.items.find(i => i.id === epId)
  assert.ok(rule && ep)
  assert.ok(rule.score > ep.score, `rule 分数应高于 episode：${rule.score} vs ${ep.score}`)
  assert.ok(rule.score / ep.score > 1.05, '类型权重差应可见（约 1.0 vs 0.9）')
})

// ── ② MMR 去冗余 ───────────────────────────────────────────────────────────

test('MMR 去冗余：近似重复的第二条被惩罚，让位给信息增量更大的条目', () => {
  const { store } = mkStore()
  const dupA = addMem(store, { text: '他喜欢喝冰美式，不加糖，每天早上一杯', type: 'preference', salience: 0.6 })
  const dupB = addMem(store, { text: '他喜欢喝冰美式，不加糖，每天早上一杯，偶尔加奶', type: 'preference', salience: 0.6 })
  const distinct = addMem(store, { text: '他下周要去北京出差三天', type: 'fact', salience: 0.6 })

  const ranked = rankMemories({ store, query: '冰美式 出差 北京', subject: QQ, conv: PEER_C2C, now: NOW, contextSince: false })
  const ids = ranked.items.map(i => i.id)
  assert.ok(ids.includes(dupA) && ids.includes(dupB) && ids.includes(distinct), `三条都应在候选里：${ids}`)

  // 两条近重复里，先入选的那条会占住「高相似度」的坑；第二条因此被 MMR 惩罚，
  // 排序应掉到独立条目后面（这正是「按信息增量装填」的意义）。
  const dupItems = ranked.items.filter(i => i.id === dupA || i.id === dupB)
  assert.equal(dupItems.length, 2, `两条近重复都应在结果里：${ids}`)
  const secondDup = dupItems[1]
  assert.ok(secondDup.mmrSim > 0, '第二条近重复应有冗余相似度')
  assert.ok(secondDup.adjusted < secondDup.score, 'MMR 后分数应被惩罚')
  assert.ok(ids.indexOf(distinct) < ids.indexOf(secondDup.id),
    `独立条目应排在第二条近重复前面：${ranked.items.map(i => `${i.id}:${i.text.slice(0, 6)}(${i.mmrSim?.toFixed(2)})`).join(' | ')}`)
})

test('similarity() 用 bigram Jaccard：同义改写高、无关低、空文本 0', () => {
  assert.ok(similarity('他喜欢喝冰美式', '他喜欢喝冰美式不加糖') > 0.3)
  assert.ok(similarity('他喜欢喝冰美式', '明天下午三点开会') < 0.05)
  assert.equal(similarity('', '随便什么'), 0)
})

// ── ③ 预算装填 ─────────────────────────────────────────────────────────────

test('预算装填：总字数 ≤ budgetChars，装不下就停（不会硬塞半行）', () => {
  const { store } = mkStore()
  for (let i = 0; i < 20; i++) {
    addMem(store, { text: `这是第 ${i} 条比较长的记忆内容，用来把预算撑满看看会不会超出去多少`, type: 'fact', salience: 0.6 - i * 0.01 })
  }
  const block = searchForPrompt({
    store, query: '预算 记忆 内容', subject: QQ, conv: PEER_C2C, now: NOW,
    contextSince: false, budgetChars: 200,
  })
  assert.ok(block.length > 0, '应能装进至少一条')
  assert.ok(charLen(block) <= 200, `总字数必须 ≤ 200，实际 ${charLen(block)}`)
  assert.ok(block.startsWith('【你记得的事】'))
  // 每条都是完整的 `- [类型·时间] 正文` 行（截断只可能发生在最后一行，且带省略号）
  for (const line of block.split('\n').slice(1)) {
    assert.match(line, /^- \[[^\]]+·[^\]]+\] .+/, `行格式不对：${line}`)
  }
})

test('预算极小时：单条长记忆被截断到刚好放得下，返回 ≤ budget 的块', () => {
  const { store } = mkStore()
  addMem(store, { text: '他上周末去爬山了，说山顶风很大，差点着凉，回来之后一直咳嗽，准备这周末去医院看看', type: 'episode', salience: 0.8 })
  const block = searchForPrompt({
    store, query: '爬山 山顶 咳嗽', subject: QQ, conv: PEER_C2C, now: NOW,
    contextSince: false, budgetChars: 60,
  })
  assert.ok(block.length > 0, '应该给出截断后的内容，而不是空块')
  assert.ok(charLen(block) <= 60, `必须 ≤60 字，实际 ${charLen(block)}：${block}`)
  assert.ok(block.includes('…'), `截断应有省略号：${block}`)
})

// ── ④ 会话水位线 ───────────────────────────────────────────────────────────

test('水位线：来源在当前会话上下文里的记忆不重复注入，更早的照常注入', () => {
  const { store } = mkStore()
  // 本会话最早一条 = NOW-10d（水位线）。旧记忆的来源在**别的会话、更早**（30 天前），
  // 所以它不在当前上下文里 → 该注入；新记忆的来源就是本会话刚刚那条 → 已在上下文 → 跳过。
  const oldEv = store.appendEvent({ conv: 'group:2000000002', msgId: 'old-1', speaker: QQ, text: '很久以前在群里说过开会的事', at: NOW - 30 * DAY }).id
  const newEv = store.appendEvent({ conv: PEER_C2C, msgId: 'new-1', speaker: QQ, text: '刚刚又说了一句开会', at: NOW - 60 }).id
  const oldId = addMem(store, { text: '很久以前：他提过要开项目会', type: 'episode', salience: 0.7, created: NOW - 30 * DAY, lastSeen: NOW - 30 * DAY, sourceEvent: oldEv })
  const newId = addMem(store, { text: '刚刚：他又提到开项目会', type: 'episode', salience: 0.7, created: NOW - 60, lastSeen: NOW - 60, sourceEvent: newEv })

  // 水位线 = 本会话 events 最早一条（newEv，NOW-60）；来源晚于它的记忆视为已在上下文
  const wm = contextWatermark({ store, conv: PEER_C2C })
  assert.equal(wm, NOW - 60)

  const ranked = rankMemories({ store, query: '项目会', subject: QQ, conv: PEER_C2C, now: NOW })
  const ids = ranked.items.map(i => i.id)
  assert.ok(ids.includes(oldId), '更早的记忆应照常注入')
  assert.ok(!ids.includes(newId), `来自当前会话上下文的记忆应被跳过：${JSON.stringify(ranked.items.map(i => i.text))}`)
  assert.ok(ranked.skippedContext >= 1, `应记录 skippedContext：${ranked.skippedContext}`)

  // 显式关掉水位线 → 两条都在（桥侧「重读历史」场景要能关）
  const all = rankMemories({ store, query: '项目会', subject: QQ, conv: PEER_C2C, now: NOW, contextSince: false })
  assert.ok(all.items.some(i => i.id === newId), 'contextSince=false 应不跳过')
})

// ── ⑤ dm_only / scope 过滤 ────────────────────────────────────────────────

test('dm_only 场合过滤：私聊记忆不进群聊注入；public 可跨通道', () => {
  const { store } = mkStore()
  const secret = addMem(store, { text: '私聊里说的秘密：下周要去医院复查', type: 'fact', scope: 'dm_only', conv: PEER_C2C })
  const publicC2c = addMem(store, { text: '他喜欢喝不加糖的冰美式', type: 'preference', scope: 'public', conv: PEER_C2C })

  const group = rankMemories({
    store, query: '复查 冰美式', subject: QQ, conv: PEER_GROUP, inGroup: true, now: NOW, contextSince: false,
  })
  assert.ok(!group.items.some(i => i.id === secret), 'dm_only 记忆绝不能注入群聊')
  assert.ok(group.items.some(i => i.id === publicC2c), 'public 记忆可以跨通道注入群聊')

  const priv = rankMemories({
    store, query: '复查 冰美式', subject: QQ, conv: PEER_C2C, inGroup: false, now: NOW, contextSince: false,
  })
  assert.ok(priv.items.some(i => i.id === secret), '私聊场合应能想起私聊记忆')
})

test('scope/会话归属：别人的记忆不注入；群级知识只在自己的群；全局知识处处可用', () => {
  const { store } = mkStore()
  const otherPerson = addMem(store, { text: '另一个人说的：他想学吉他', subject: '9999999999', conv: PEER_GROUP })
  const groupLevel = addMem(store, { text: '群级知识：这个群每周三开黑', subject: null, conv: PEER_GROUP })
  const globalRule = addMem(store, { text: '全局规矩：别在凌晨三点发消息', type: 'rule', subject: null, conv: null })

  const here = rankMemories({ store, query: '吉他 开黑 凌晨', subject: QQ, conv: PEER_GROUP, inGroup: true, now: NOW, contextSince: false })
  const ids = here.items.map(i => i.id)
  assert.ok(!ids.includes(otherPerson), '别人的记忆不能按 subject 漏进来')
  assert.ok(ids.includes(groupLevel), '本群的群级知识应注入')
  assert.ok(ids.includes(globalRule), '全局知识（conv=NULL）处处可用')

  const otherGroup = rankMemories({ store, query: '吉他 开黑 凌晨', subject: QQ, conv: 'group:3000000003', inGroup: true, now: NOW, contextSince: false })
  assert.ok(!otherGroup.items.some(i => i.id === groupLevel), '群级知识不能跨群注入')
})

// ── ⑥ 单字回退 LIKE ───────────────────────────────────────────────────────

test('单字查询走 LIKE 回退（bigram 索引里没有 1-gram）', () => {
  const { store } = mkStore()
  const id = addMem(store, { text: '今天真的好累啊，什么都不想动', type: 'episode' })
  const ranked = rankMemories({ store, query: '累', subject: QQ, conv: PEER_C2C, now: NOW, contextSince: false })
  assert.equal(ranked.via, 'like', `单字查询应走 LIKE 回退，实际 ${ranked.via}`)
  assert.ok(ranked.items.some(i => i.id === id))
  assert.ok(Math.abs(ranked.items[0].rel - LIKE_REL) < 1e-9, 'LIKE 命中给固定相关度（低于强 FTS 命中）')
})

// ── ⑦ 空结果 ──────────────────────────────────────────────────────────────

test('空库 / 无命中 / 空 query：返回空串（不注入空壳）', () => {
  const { store } = mkStore()
  assert.equal(searchForPrompt({ store, query: '开会', subject: QQ, conv: PEER_C2C, now: NOW }), '')
  assert.equal(utteranceBlock({ store, conv: PEER_C2C, now: NOW }), '')
  assert.equal(profileBlock({ store, subject: QQ, now: NOW }), '')

  addMem(store, { text: '他喜欢喝冰美式' })
  assert.equal(searchForPrompt({ store, query: '完全无关的量子力学', subject: QQ, conv: PEER_C2C, now: NOW }), '')
  assert.equal(searchForPrompt({ store, query: '', subject: QQ, conv: PEER_C2C, now: NOW }), '')
})

test('无关的高 salience 新记忆不会因为「salience+recency」被注入（rel=0 直接拒）', () => {
  const { store } = mkStore()
  addMem(store, { text: '他喜欢喝冰美式', type: 'preference', salience: 1.0 })
  const ranked = rankMemories({ store, query: '量子纠缠', subject: QQ, conv: PEER_C2C, now: NOW, contextSince: false })
  assert.equal(ranked.items.length, 0, `零相关条目不该被注入：${JSON.stringify(ranked.items.map(i => i.text))}`)
})

// ── ⑧ 渲染格式 / 时间 / 半衰期 ────────────────────────────────────────────

test('渲染：每条带类型标签 + 「多久以前」，总字数受 budgetChars 约束', () => {
  const { store } = mkStore()
  addMem(store, { text: '每次开黑前先问我在不在', type: 'rule', lastSeen: NOW - 3 * DAY })
  addMem(store, { text: '他喜欢喝不加糖的冰美式', type: 'preference', lastSeen: NOW - 2 * HOUR })
  const block = searchForPrompt({
    store, query: '开黑 冰美式', subject: QQ, conv: PEER_C2C, now: NOW, contextSince: false, budgetChars: 800,
  })
  assert.ok(block.includes('[规矩·3 天前]'), `应有 规矩 + 相对时间：${block}`)
  assert.ok(block.includes('[偏好·2 小时前]'), `应有 偏好 + 相对时间：${block}`)
  assert.ok(charLen(block) <= 800)
})

test('relativeTimeLabel：刚刚/分钟/小时/天/周/月/年 的分档正确', () => {
  const now = NOW
  assert.equal(relativeTimeLabel(now - 10, now), '刚刚')
  assert.equal(relativeTimeLabel(now - 5 * 60, now), '5 分钟前')
  assert.equal(relativeTimeLabel(now - 3 * 3600, now), '3 小时前')
  assert.equal(relativeTimeLabel(now - 2 * DAY, now), '2 天前')
  assert.equal(relativeTimeLabel(now - 10 * DAY, now), '1 周前')
  assert.equal(relativeTimeLabel(now - 100 * DAY, now), '3 个月前')
  assert.equal(relativeTimeLabel(now - 400 * DAY, now), '1 年前')
  assert.equal(relativeTimeLabel(null, now), '时间未知')
})

test('recency 按 type 半衰期：同年龄下 rule 比 episode 衰减慢得多（各类型半衰期可断言）', () => {
  const age = 30 * DAY
  const lastSeen = NOW - age
  const ruleRec = recencyScore('rule', lastSeen, NOW)
  const episodeRec = recencyScore('episode', lastSeen, NOW)
  assert.ok(Math.abs(ruleRec - Math.pow(0.5, 30 / TYPE_HALF_LIFE_DAYS.rule)) < 1e-12)
  assert.ok(Math.abs(episodeRec - Math.pow(0.5, 30 / TYPE_HALF_LIFE_DAYS.episode)) < 1e-12)
  assert.ok(ruleRec > 0.9, `rule 30 天应几乎不衰减（实际 ${ruleRec}）`)
  assert.ok(episodeRec < 0.01, `episode 30 天应基本衰减完（实际 ${episodeRec}）`)
})

test('pinned（salience≥0.9）比普通条目多 0.10 分（权重复算）', () => {
  const base = { type: 'fact', last_seen: NOW - 3600 }
  const normal = scoreMemory({ mem: { ...base, salience: 0.5 }, rel: 0.5, now: NOW })
  const pinned = scoreMemory({ mem: { ...base, salience: 0.9 }, rel: 0.5, now: NOW })
  assert.equal(normal.pinned, 0)
  assert.equal(pinned.pinned, 1)
  assert.ok(Math.abs((pinned.score - normal.score) - (W_PINNED + W_SALIENCE * 0.4)) < 1e-9,
    `分差应 = 0.10(pinned) + 0.22×0.4(salience 差)，实际 ${pinned.score - normal.score}`)
})

// ── ⑨ 防复读块 ────────────────────────────────────────────────────────────

test('utteranceBlock：最近自发言 + 时间标签，≤60 字；没有 utterances 时退回 events 的 self', () => {
  const { store } = mkStore()
  store.appendUtterance({ conv: PEER_C2C, text: '早点睡别熬夜', at: NOW - 2 * 3600 })
  store.appendUtterance({ conv: PEER_C2C, text: '这张图我已经夸过了', at: NOW - 2 * DAY })
  store.appendUtterance({ conv: PEER_C2C, text: '今天有点忙', at: NOW - 10 * DAY })

  const block = utteranceBlock({ store, conv: PEER_C2C, limit: 3, now: NOW, budgetChars: 60 })
  assert.ok(block.startsWith('【你最近说过的话（别复读）】'), block)
  assert.ok(block.includes('2 小时前：早点睡别熬夜'), block)
  assert.ok(charLen(block) <= 60, `防复读块应 ≤60 字：${charLen(block)}`)

  // Step 1 双写只保证 events：没有 utterances 时要从 events 里 speaker='self' 取
  const { store: store2 } = mkStore()
  const conv = 'c2c:1000000002'
  store2.appendEvent({ conv, msgId: 'self-1', speaker: 'self', text: '我说过：这局我来带', at: NOW - 3600 })
  const fallback = utteranceBlock({ store: store2, conv, now: NOW })
  assert.ok(fallback.includes('这局我来带'), `应能从 events 的 self 发言兜底：${fallback}`)
  assert.equal(utteranceBlock({ store: store2, conv: 'c2c:9', now: NOW }), '')
})

// ── ⑩ 人物画像块 ──────────────────────────────────────────────────────────

test('profileBlock：summary + 偏好/雷点渲染，≤120 字；没有画像返回空串', () => {
  const { store } = mkStore()
  store.upsertProfile({
    subject: QQ,
    nickname: '小明',
    summary: '他是夜猫子，凌晨还在线；话不多但很在意别人有没有听懂；遇到技术问题会一直追问到弄明白。',
    prefs: ['冰美式', '爬山', 'B站数码区'],
    dislikes: ['噪音', '被催'],
    facts: [{ k: '作息', v: '凌晨两点睡', confidence: 0.8 }],
  })
  const block = profileBlock({ store, subject: QQ, now: NOW, budgetChars: 120 })
  assert.ok(block.startsWith('【关于他】'), block)
  assert.ok(block.includes('夜猫子'), '画像应包含 summary')
  assert.ok(block.includes('偏好：冰美式'), '画像应包含偏好')
  assert.ok(block.includes('雷点：噪音'), '画像应包含雷点')
  assert.ok(charLen(block) <= 120, `画像块应 ≤120 字：${charLen(block)}`)
  assert.equal(profileBlock({ store, subject: '9999999999', now: NOW }), '')
})

// ── ⑪ 组合注入：§3.7 的 ~800 字上限 ────────────────────────────────────────

test('buildMemoryBlocks：三块合计 ≤800 字，且每块在各自预算内', () => {
  const { store } = mkStore()
  store.upsertProfile({
    subject: QQ,
    summary: '他是夜猫子，晚上十点后基本不回消息，别去打扰他；说话直接，不喜欢绕弯子。',
    prefs: ['冰美式'],
  })
  for (let i = 0; i < 15; i++) {
    addMem(store, { text: `关于开黑第 ${i} 条记忆：我们一般周五晚上开黑，打完各自睡觉`, type: 'episode', salience: 0.5 })
  }
  store.appendUtterance({ conv: PEER_C2C, text: '这局我 carry', at: NOW - 3600 })

  const out = buildMemoryBlocks({
    store, query: '开黑 记忆', subject: QQ, conv: PEER_C2C, now: NOW,
  })
  assert.ok(out.chars <= 800, `总字数必须 ≤800，实际 ${out.chars}`)
  assert.equal(charLen(out.block), out.chars)
  assert.ok(out.charsByBlock.profile <= 120, `画像块 ≤120，实际 ${out.charsByBlock.profile}`)
  assert.ok(out.charsByBlock.retrieval <= 350, `检索块 ≤350，实际 ${out.charsByBlock.retrieval}`)
  assert.ok(out.charsByBlock.utterances <= 60, `防复读块 ≤60，实际 ${out.charsByBlock.utterances}`)
  assert.ok(out.block.includes('【关于他】') && out.block.includes('【你记得的事】'))
  // 顺序：画像（稳定层）→ 检索（贴话题）→ 防复读
  assert.ok(out.block.indexOf('【关于他】') < out.block.indexOf('【你记得的事】'))
})

test('buildMemoryBlocks：总预算被压低时按优先级砍（先防复读→检索→画像），含块间分隔符也不超', () => {
  const { store } = mkStore()
  store.upsertProfile({ subject: QQ, summary: '他是夜猫子，晚上十点后基本不回消息，别去打扰他。', prefs: ['冰美式'] })
  for (let i = 0; i < 10; i++) {
    addMem(store, { text: `第 ${i} 条记忆：我们周五晚上开黑，打完就各睡各的`, type: 'episode', salience: 0.5 })
  }
  store.appendUtterance({ conv: PEER_C2C, text: '这局我来带节奏', at: NOW - 600 })

  // 350+120+60+分隔符已经 > 400，必须真的触发总量修剪
  const out = buildMemoryBlocks({
    store, query: '开黑 记忆 周五', subject: QQ, conv: PEER_C2C, now: NOW, totalBudgetChars: 400,
  })
  assert.ok(out.chars <= 400, `含分隔符的总字数必须 ≤400，实际 ${out.chars}`)
  assert.equal(charLen(out.block), out.chars)
  assert.ok(out.blocks.profile.length > 0, '画像优先保留')
})

test('renderMemories：预算比标题还小 → 返回空串（不注入空壳）', () => {
  const { store } = mkStore()
  const id = addMem(store, { text: '他喜欢喝冰美式', type: 'preference' })
  const ranked = rankMemories({ store, query: '冰美式', subject: QQ, conv: PEER_C2C, now: NOW, contextSince: false })
  assert.ok(ranked.items.some(i => i.id === id))
  assert.equal(renderMemories({ items: ranked.items, budgetChars: 3 }), '')
  assert.equal(renderMemories({ items: [], budgetChars: 800 }), '')
})

test('buildMemoryBlocks：空库返回空 block（不注入任何标题）', () => {
  const { store } = mkStore()
  const out = buildMemoryBlocks({ store, query: '开会', subject: QQ, conv: PEER_C2C, now: NOW })
  assert.equal(out.block, '')
  assert.equal(out.chars, 0)
})

// ── ⑫ 其它契约 ────────────────────────────────────────────────────────────

test('rankMemories 缺 store 明确报错；searchForPrompt 不传 store 也走同一条错', () => {
  assert.throws(() => rankMemories({ query: '开会' }), /store/)
  assert.throws(() => searchForPrompt({ query: '开会' }), /store/)
})

test('charLen/truncateChars 按 code point 计字数（emoji 不会被算成 2 个字）', () => {
  assert.equal(charLen('中文'), 2)
  assert.equal(charLen('😀😀'), 2)
  assert.equal(charLen('a😀中'), 3)
})
