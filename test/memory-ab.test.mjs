// test/memory-ab.test.mjs —— v4/v5 注入 A/B 盲评工具（scripts/memory-ab.mjs）的测试
//
// 为什么值得测：
//   · A/B 的结论会决定「v5 能不能切默认」，所以工具本身必须可信：
//     查询抽取不能混进占位/短句（否则噪音率被稀释）、盲评打乱必须可复现
//     （否则评审结果没法复盘）、**只读守卫**不能形同虚设（v4/v5/日志都是
//     生产库的副本，工具一旦写库就是事故）。
//   · 这个工具同时是「坏输入不能崩」的运维工具：空日志、垃圾日志、坏库、
//     没给参数都应该给清晰退出码，而不是抛 stack。
//
// 全部 fixture 在 os.tmpdir() 里现造：v4 迷你库（真 memctl schema，python 造）、
// v5 迷你库（真 openV5）、合成 bridge.out。**不碰生产库/生产日志**。
// 没有 python 的机器整组 skip（v4 侧本来就是 python 检索）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SCRIPT = path.join(ROOT, 'scripts', 'memory-ab.mjs')
const MEMCTL_DIR = path.join(ROOT, 'lib', 'agent', 'memory')

const { probePython } = await import(pathToFileURL(path.join(ROOT, 'lib', 'pyprobe.mjs')).href)
const probe = probePython({ log: () => {} })
const SKIP = probe.ok ? false : `本机没有可用的 python（${probe.reason}），v4 侧无法执行`

const A = await import(pathToFileURL(SCRIPT).href)
const { extractQueries, classifyQuery, parseV4Block, isProdPath, mulberry32 } = A

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'llminqq-mem-ab-'))
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* ignore */ } })

const sha256 = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')

// ── fixture：v4 迷你库 + v5 迷你库 + 合成 bridge.out ─────────────────────────
const FIXTURE = path.join(TMP, 'fixture')
const F = {
  dir: FIXTURE,
  v4: path.join(FIXTURE, 'mem.db'),
  digest: path.join(FIXTURE, 'digest.md'),
  v5: path.join(FIXTURE, 'mem-v5.db'),
  log: path.join(FIXTURE, 'bridge.out'),
}
let FIXTURE_READY = false

function buildFixtures () {
  fs.mkdirSync(FIXTURE, { recursive: true })
  // ① v4 迷你库（真 memctl schema）
  const py = [
    'import sys',
    'sys.dont_write_bytecode = True',
    `sys.path.insert(0, ${JSON.stringify(MEMCTL_DIR)})`,
    'import memctl as m',
    `m.DB = ${JSON.stringify(F.v4)}`,
    `m.DIGEST = ${JSON.stringify(F.digest)}`,
    `m.LOG_DIR = ${JSON.stringify(path.join(FIXTURE, 'log'))}`,
    `m.CURSOR = ${JSON.stringify(path.join(FIXTURE, '.cursor'))}`,
    'conn = m.connect(m.DB)',
    "qq = '1000000001'",
    "m.remember(conn, 'c2c-1000000001', '上次说的服务器迁移已经做完了，周末请你吃饭', kind='semantic', owner=qq, visibility='public', is_self=0, importance=0.8)",
    "m.remember(conn, 'c2c-1000000001', '明天下午三点开会，地点三楼会议室，记得带电脑', kind='semantic', owner=qq, visibility='public', is_self=0, importance=0.7)",
    "m.remember(conn, 'group-2000000002', '群里说周末羽毛球局改到三点，场地已经订好了', kind='semantic', owner=qq, visibility='public', is_self=0, importance=0.6)",
    "m.remember(conn, 'c2c-1000000001', '他喜欢喝不加糖的冰美式，早上必点', kind='semantic', owner=qq, visibility='public', is_self=0, importance=0.5)",
    // dm_only：群聊场合不该出现在 v4 的跨通道段里
    "m.remember(conn, 'c2c-1000000001', '私聊里说的秘密：下周要去医院复查', kind='semantic', owner=qq, visibility='dm_only', is_self=0, importance=0.7)",
    'conn.commit(); conn.close()',
  ].join('\n')
  const r = spawnSync(probe.bin, [...(probe.preArgs || []), '-c', py], {
    encoding: 'utf8', timeout: 120000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', MEMCTL_PROD: '', MEMCTL_PROD_DIR: '' },
  })
  if (r.status !== 0) throw new Error(`造 v4 fixture 失败：${r.stderr || r.stdout}`)
  fs.writeFileSync(F.digest, [
    '# 记忆摘要（测试）', '',
    '## c2c-1000000001', '',
    '- ★ [程序] 开会记得带电脑', '- · [语义] 他喜欢冰美式', '',
    '## group-2000000002', '',
    '- ★ [程序] 每周三开黑', '',
  ].join('\n'))

  // ② v5 迷你库（真 openV5 + FTS）
  return import(pathToFileURL(path.join(ROOT, 'lib', 'agent', 'memory-v5', 'store.mjs')).href)
    .then(({ openV5 }) => {
      const store = openV5({ dbPath: F.v5, log: () => {} })
      const NOW = Date.now() / 1000
      const DAY = 86400
      store.insertMemory({ type: 'fact', text: '上次说的服务器迁移已经做完了，周末一起吃饭', subject: '1000000001', conv: 'c2c:1000000001', salience: 0.8, created: NOW - DAY, lastSeen: NOW - DAY, scope: 'public' })
      store.insertMemory({ type: 'commitment', text: '他答应周末请吃饭作为庆祝', subject: '1000000001', conv: 'c2c:1000000001', salience: 0.7, created: NOW - 3600, lastSeen: NOW - 3600, scope: 'public' })
      store.insertMemory({ type: 'fact', text: '他喜欢喝不加糖的冰美式，早上必点', subject: '1000000001', conv: 'c2c:1000000001', salience: 0.6, created: NOW - 5 * DAY, lastSeen: NOW - 5 * DAY, scope: 'public' })
      store.insertMemory({ type: 'fact', text: '群里说周末羽毛球局改到三点，场地已订好', subject: '1000000001', conv: 'group:2000000002', salience: 0.6, created: NOW - 2 * DAY, lastSeen: NOW - 2 * DAY, scope: 'public' })
      store.insertMemory({ type: 'fact', text: '私聊里说的秘密：下周要去医院复查', subject: '1000000001', conv: 'c2c:1000000001', salience: 0.7, created: NOW - DAY, lastSeen: NOW - DAY, scope: 'dm_only' })
      store.upsertProfile({ subject: '1000000001', summary: '他是夜猫子，说话直接，喜欢把事说清楚。', prefs: ['冰美式', '爬山'] })
      store.appendUtterance({ conv: 'c2c:1000000001', text: '这局我来带', at: NOW - 7200 })
      store.close()

      // ③ 合成 bridge.out：12 条有效查询（4 类）+ 会被过滤的噪音/占位
      const ts = (minAgo) => new Date(Date.now() - minAgo * 60000).toISOString()
      const inbound = (minAgo, conv, text, qq = '1000000001') =>
        `${ts(minAgo)} 入站 ${conv} from=小明(${qq}) text="${text}" images=0`
      const outbound = (minAgo, conv, text) =>
        `${ts(minAgo)} 出站 ${conv} text="${text}" chars=${[...text].length}`
      const lines = [
        inbound(300, 'c2c:1000000001', '你还记得上次说的服务器迁移那个事吗'),
        outbound(299, 'c2c:1000000001', '记得，已经迁移完了'),
        inbound(290, 'c2c:1000000001', '后来那个迁移结果怎么样了啊'),
        inbound(280, 'group:2000000002', '周末羽毛球局后来怎么样了'),
        inbound(270, 'c2c:1000000001', '你觉得我这个人怎么样啊'),
        inbound(260, 'c2c:1000000001', '他最近还在准备考研吗，晚上还熬夜吗'),
        inbound(250, 'c2c:1000000001', '之前说过的那本书你还记得叫什么吗'),
        inbound(240, 'group:2000000002', '那个事情后来有结果了吗'),
        inbound(230, 'c2c:1000000001', '在你眼里我是什么样的人呢'),
        inbound(220, 'c2c:1000000001', '哈'.repeat(8)),                 // 过长噪声 → 噪音对照
        inbound(210, 'c2c:1000000001', '嗯'),                           // 太短 → 过滤
        inbound(200, 'c2c:1000000001', '在吗'),                         // 太短 → 过滤
        inbound(190, 'c2c:1000000001', '[图片]'),                       // 纯占位 → 过滤
        inbound(180, 'c2c:1000000001', '这张图我昨天是不是已经发给你看过了'), // 一般
      ]
      fs.writeFileSync(F.log, lines.join('\n') + '\n')
      FIXTURE_READY = true
    })
}

let fixtureError = ''
if (probe.ok) {
  try { await buildFixtures() } catch (err) { fixtureError = String(err?.message || err) }
} else {
  fixtureError = SKIP
}
const CLI_SKIP = FIXTURE_READY ? false : `fixture 未就绪：${fixtureError}`

function runCli (args, { timeout = 180000 } = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8', timeout,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  })
}

const baseArgs = () => ['--v4', F.v4, '--v5', F.v5, '--log', F.log, '--limit', '8']

// ── ① 查询抽取（纯函数）────────────────────────────────────────────────────
test('extractQueries：只取真实入站，过滤占位/短句，分类并去重', () => {
  const text = [
    '2026-11-03T10:00:00.000Z 入站 c2c:1000000001 from=小明(1000000001) text="你还记得上次说的服务器迁移那个事吗" images=0',
    '2026-11-03T10:01:00.000Z 入站 c2c:1000000001 from=小明(1000000001) text="嗯" images=0',
    '2026-11-03T10:02:00.000Z 入站 c2c:1000000001 from=小明(1000000001) text="[图片]" images=0',
    '2026-11-03T10:03:00.000Z 入站 c2c:1000000001 from=小明(1000000001) text="后来那个迁移结果怎么样了啊" images=0',
    '2026-11-03T10:04:00.000Z 入站 group:2000000002 from=小明(1000000001) text="你觉得我这个人怎么样啊" images=0',
    '2026-11-03T10:05:00.000Z 入站 c2c:1000000001 from=小明(1000000001) text="哈哈哈哈哈哈哈哈" images=0',
    // 重复一条（应该去重）
    '2026-11-03T10:06:00.000Z 入站 c2c:1000000001 from=小明(1000000001) text="后来那个迁移结果怎么样了啊" images=0',
    // 不是入站格式：忽略
    '2026-11-03T10:07:00.000Z 出站 c2c:1000000001 text="记得，已经迁移完了" chars=9',
    'garbage line',
  ].join('\n')
  const qs = extractQueries(text, { limit: 10, sample: 'stratified', seed: 1 })
  const texts = qs.map(q => q.query)
  assert.ok(!texts.includes('嗯'), '太短的消息要被过滤')
  assert.ok(!texts.includes('[图片]'), '纯占位要被过滤')
  assert.equal(texts.filter(t => t === '后来那个迁移结果怎么样了啊').length, 1, '同一会话的同一句要去重')
  assert.ok(texts.includes('你还记得上次说的服务器迁移那个事吗'))
  assert.ok(texts.includes('你觉得我这个人怎么样啊'))
  assert.equal(qs.length, 4, `过滤后应剩 4 条，实际 ${JSON.stringify(texts)}`)
  const byText = Object.fromEntries(qs.map(q => [q.query, q]))
  assert.equal(byText['你还记得上次说的服务器迁移那个事吗'].category, '指代回忆')
  assert.equal(byText['你觉得我这个人怎么样啊'].category, '人物画像')
  assert.equal(byText['后来那个迁移结果怎么样了啊'].category, '话题延续')
  assert.equal(byText['哈哈哈哈哈哈哈哈'].category, '噪音对照')
  // 结构：conv/subject/at 都要有（后续检索要用）
  for (const q of qs) {
    assert.match(q.conv, /^(c2c|group):/)
    assert.match(q.subject, /^\d+$/)
    assert.ok(Number.isFinite(q.at), '查询要带时间（用于渲染「多久以前」与上下文窗口）')
  }
})

test('extractQueries：兼容现网 bridge.out 尾缀（cards/segs），非文字段不当查询', () => {
  const text = [
    // 现网真实格式：尾部多了 cards= segs=；只有 segs 里有 text 的才是「人说的话」
    '2026-11-03T04:24:46.880Z 入站 c2c:3022464706 from=信风(3022464706) text="明天下午三点开会记得带电脑" images=0 cards=0 segs=text',
    '2026-11-03T04:26:55.639Z 入站 c2c:3022464706 from=信风(3022464706) text="[卡片] 某个视频分享 https://b23.tv/x" images=0 cards=1 segs=json',
    '2026-11-03T04:27:01.000Z 入站 c2c:3022464706 from=信风(3022464706) text="[图片]" images=1 cards=0 segs=image',
    '2026-11-03T04:28:01.000Z 入站 c2c:3022464706 from=信风(3022464706) text="他说这个方案后来还可以继续推进" images=0 cards=0 segs=reply,text',
  ].join('\n')
  const qs = extractQueries(text, { limit: 10, sample: 'recent', seed: 1 })
  assert.deepEqual(qs.map(q => q.query), [
    '明天下午三点开会记得带电脑',
    '他说这个方案后来还可以继续推进',
  ], '卡片/图片消息（segs 无 text）不应作为查询；reply+text 应保留')
})

test('classifyQuery：四类启发式 + 噪音', () => {
  assert.equal(classifyQuery('你还记得上次那个事吗'), '指代回忆')
  assert.equal(classifyQuery('后来那件事到底怎么样了呀'), '话题延续')
  assert.equal(classifyQuery('在你眼里我是什么样的人呢'), '人物画像')
  assert.equal(classifyQuery('嗯'), '噪音对照')
  assert.equal(classifyQuery('哈哈哈'), '噪音对照')
  assert.equal(classifyQuery('明天下午三点开会的地点确认了吗'), '一般')
})

test('extractQueries：limit 生效 + structured 抽样覆盖多类别 + 同 seed 可复现', () => {
  const lines = []
  for (let i = 0; i < 30; i++) {
    const t = i % 4 === 0 ? '你还记得上次第 ' + i + ' 件事吗'
      : i % 4 === 1 ? '后来第 ' + i + ' 件事怎么样了'
        : i % 4 === 2 ? '你觉得我这个人第 ' + i + ' 次问你怎么样啊'
          : '这就是一条普通的第 ' + i + ' 条消息内容'
    lines.push(`2026-11-03T10:${String(i).padStart(2, '0')}:00.000Z 入站 c2c:1000000001 from=小明(1000000001) text="${t}" images=0`)
  }
  const text = lines.join('\n')
  const a = extractQueries(text, { limit: 8, sample: 'stratified', seed: 3 })
  const b = extractQueries(text, { limit: 8, sample: 'stratified', seed: 3 })
  assert.equal(a.length, 8)
  assert.deepEqual(a.map(q => q.query), b.map(q => q.query), '同 seed 抽样必须可复现')
  assert.ok(new Set(a.map(q => q.category)).size >= 3, '分层抽样应覆盖多个类别')
  const recent = extractQueries(text, { limit: 5, sample: 'recent', seed: 1 })
  assert.equal(recent.length, 5)
  assert.equal(recent[recent.length - 1].query, '后来第 29 件事怎么样了', 'recent 应取最后几条')
})

// ── ② v4 块解析 / 生产路径守卫（纯函数）────────────────────────────────────
test('parseV4Block：跨通道段与 digest 段分开，条目解析出来', () => {
  const block = [
    '',
    '【你记得的事·按人跨通道检索】（同一个人在私聊和群里的记忆合并检索，停在「私聊」场合）',
    '  - 上次说的服务器迁移已经做完了',
    '  - 群·群里说周末羽毛球局改到三点',
    '',
    '【你的见闻录摘要】（memory/digest.md 中本会话的部分）',
    '## c2c-1000000001',
    '- ★ [程序] 开会记得带电脑',
    '提到以前的事就照着说，不确定就别硬编。',
  ].join('\n')
  const p = parseV4Block(block)
  assert.equal(p.items.length, 2)
  assert.ok(p.retrieval.includes('【你记得的事·按人跨通道检索】'))
  assert.ok(!p.retrieval.includes('你的见闻录摘要'), '跨通道段不能混进 digest')
  assert.ok(p.digest.includes('【你的见闻录摘要】'))
  assert.ok(p.retrievalChars > 0 && p.digestChars > 0)
  assert.equal(parseV4Block('').items.length, 0)
})

test('isProdPath：~/.dsh 下的路径 = 生产；/tmp 不是', () => {
  assert.equal(isProdPath(path.join(os.homedir(), '.dsh', 'dsh-plugin-llminqq', 'agent', 'memory', 'mem.db')), true)
  assert.equal(isProdPath('/tmp/mem.db'), false)
  assert.equal(isProdPath('/tmp/.dsh-like/mem.db'), false)
})

test('mulberry32：同 seed 序列一致、不同 seed 不同（盲评可复现的基础）', () => {
  const a = mulberry32(7); const b = mulberry32(7); const c = mulberry32(8)
  const sa = [a(), a(), a()]; const sb = [b(), b(), b()]; const sc = [c(), c(), c()]
  assert.deepEqual(sa, sb)
  assert.notDeepEqual(sa, sc)
})

// ── ③ 端到端：JSON / 盲评 markdown / 只读自证 ───────────────────────────────
test('端到端 --json：两侧条目/字数/耗时/汇总/交集都在，且只读自证为 true', { skip: CLI_SKIP }, () => {
  const before = { v4: sha256(F.v4), v5: sha256(F.v5), log: sha256(F.log) }
  const r = runCli([...baseArgs(), '--json'])
  assert.equal(r.status, 0, `应 exit 0：${r.stderr}`)
  const out = JSON.parse(r.stdout)
  assert.ok(out.queries.length >= 6, `应有 >=6 条查询：${out.queries.length}`)
  for (const q of out.queries) {
    assert.ok(q.query && q.conv && q.subject, '查询字段完整')
    assert.ok(q.v4 && q.v5, '两侧结果都存在（即使失败也要有 error 字段）')
    assert.ok(Number.isFinite(q.v4.elapsedMs) && Number.isFinite(q.v5.elapsedMs))
    assert.ok(q.blind && q.blind.A && q.blind.B, '盲评 A/B 都存在')
    assert.notEqual(q.blind.A.engine, q.blind.B.engine, 'A/B 必须是不同引擎')
    assert.equal(q.blindMap.A, q.blind.A.engine, 'blindMap 与 blind 一致')
  }
  const s = out.summary
  assert.ok(Number.isFinite(s.engine1.avgChars) && Number.isFinite(s.engine2.avgChars))
  assert.ok(Number.isFinite(s.engine1.p50Ms) && Number.isFinite(s.engine1.p99Ms))
  assert.ok(Number.isFinite(s.engine2.p50Ms) && Number.isFinite(s.engine2.p99Ms))
  assert.ok(s.intersection && Number.isFinite(s.intersection.exact))
  assert.equal(out.readOnly.v4Unchanged, true)
  assert.equal(out.readOnly.v5Unchanged, true)
  assert.equal(out.readOnly.logUnchanged, true)
  // 源文件确实没变（脚本自证之外再独立验一次）
  assert.equal(sha256(F.v4), before.v4)
  assert.equal(sha256(F.v5), before.v5)
  assert.equal(sha256(F.log), before.log)
})

test('端到端默认 markdown：两栏盲评不出现引擎名，判完 --reveal 才给映射', { skip: CLI_SKIP }, () => {
  const blind = runCli(baseArgs())
  assert.equal(blind.status, 0, blind.stderr)
  const md = blind.stdout
  assert.ok(md.includes('# 记忆注入 A/B 盲评'))
  assert.ok(!/\bv4\b|\bv5\b/i.test(md), `默认输出不能出现引擎名（盲评）：\n${md.slice(0, 500)}`)
  assert.ok(md.includes('| A 侧 | B 侧 |'), '两栏对比表')
  assert.ok(md.includes('## 汇总指标'), '末尾要有汇总指标表')
  const qCount = (md.match(/^## Q\d+/gm) || []).length
  assert.ok(qCount >= 6, `每个查询一节：${qCount}`)

  const reveal = runCli([...baseArgs(), '--limit', '5', '--reveal'])
  assert.equal(reveal.status, 0, reveal.stderr)
  assert.ok(reveal.stdout.includes('引擎① = v4'), '--reveal 要给出引擎映射')
  assert.ok(reveal.stdout.includes('每查询 A/B 对应'), '--reveal 要给出逐查询映射')
  assert.ok(reveal.stdout.includes('memoryRecallBlock'), '--reveal 要说明两侧口径')
})

test('端到端：同 seed 盲评打乱可复现；不同 seed 仍保证 A 位两侧都出现', { skip: CLI_SKIP }, () => {
  const run = (...extra) => {
    const r = runCli([...baseArgs(), '--limit', '10', '--json', ...extra])
    assert.equal(r.status, 0, r.stderr)
    return JSON.parse(r.stdout)
  }
  const a = run('--seed', '11')
  const b = run('--seed', '11')
  assert.deepEqual(a.queries.map(q => q.blindMap.A), b.queries.map(q => q.blindMap.A), '同 seed 的打乱必须一致（可复盘）')
  // 10 条查询里 A 位两侧都出现的概率 = 1 - 2/1024，足够稳
  const aEngines = new Set(a.queries.map(q => q.blindMap.A))
  assert.equal(aEngines.size, 2, `A 位应两侧都出现（打乱生效），实际 ${JSON.stringify([...aEngines])}`)
})

test('端到端：--sample recent 取最近，--limit 生效', { skip: CLI_SKIP }, () => {
  const r = runCli([...baseArgs(), '--limit', '4', '--sample', 'recent', '--json'])
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.queries.length, 4)
  assert.equal(out.queries[out.queries.length - 1].query, '这张图我昨天是不是已经发给你看过了',
    `recent 应取日志最后几条：${JSON.stringify(out.queries.map(q => q.query))}`)
})

// ── ④ 守卫 / 坏输入 ────────────────────────────────────────────────────────
test('只读守卫：路径指到生产数据目录默认拒绝（exit 2，给出 cp 副本的姿势）', { skip: CLI_SKIP }, (t) => {
  const prodDb = path.join(os.homedir(), '.dsh', 'dsh-plugin-llminqq', 'agent', 'memory', 'mem.db')
  if (!fs.existsSync(prodDb)) { t.skip('本机没有生产库，无法验证生产路径守卫'); return }
  const r = runCli(['--v4', prodDb, '--v5', F.v5, '--log', F.log, '--limit', '2'])
  assert.equal(r.status, 2, `默认应拒绝生产路径（exit 2），实际 ${r.status}：${r.stderr}`)
  assert.ok(/cp .*mem\.db/.test(r.stderr), `应给出 cp 副本的姿势：${r.stderr}`)
  assert.ok(/allow-prod-copy/.test(r.stderr), `应提示 --allow-prod-copy：${r.stderr}`)
})

test('坏输入：空日志 → exit 0 + 空查询列表（不崩）', { skip: CLI_SKIP }, () => {
  const emptyLog = path.join(TMP, 'empty.log')
  fs.writeFileSync(emptyLog, '')
  const r = runCli(['--v4', F.v4, '--v5', F.v5, '--log', emptyLog, '--json'])
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.deepEqual(out.queries, [])
  assert.equal(out.summary.engine1.ok, 0)
})

test('坏输入：垃圾日志 → exit 0（忽略解析不了的行）', { skip: CLI_SKIP }, () => {
  const badLog = path.join(TMP, 'bad.log')
  fs.writeFileSync(badLog, 'hello world\n\u0000\u0001 garbage\n2026-13-99T99:99:99.999Z 入站 ???\n')
  const r = runCli(['--v4', F.v4, '--v5', F.v5, '--log', badLog, '--json'])
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout).queries, [])
})

test('坏输入：v5 库坏了 → 不崩，v5Available=false + v5Error 说明原因', { skip: CLI_SKIP }, () => {
  const badV5 = path.join(TMP, 'bad-v5.db')
  fs.writeFileSync(badV5, 'not a sqlite database, honestly')
  const r = runCli(['--v4', F.v4, '--v5', badV5, '--log', F.log, '--limit', '3', '--json'])
  assert.equal(r.status, 0, `坏 v5 库不应崩：${r.stderr}`)
  const out = JSON.parse(r.stdout)
  assert.equal(out.v5Available, false)
  assert.match(String(out.v5Error), /v5 库|SQLite|数据库/)
  assert.ok(out.queries.length > 0, 'v4 一侧仍应继续出结果')
})

test('坏输入：v4 库坏了 → 不崩（v4 侧静默降级为空块，正是 P0 的「绿着坏」）', { skip: CLI_SKIP }, () => {
  const badV4 = path.join(TMP, 'bad-v4.db')
  fs.writeFileSync(badV4, 'not a sqlite database either')
  const r = runCli(['--v4', badV4, '--v5', F.v5, '--log', F.log, '--limit', '3', '--json'])
  assert.equal(r.status, 0, `坏 v4 库不应崩：${r.stderr}`)
  const out = JSON.parse(r.stdout)
  assert.ok(out.queries.length > 0, 'v5 一侧仍应继续出结果')
  // v4 桥的真实行为：python 读不了库 → crossChannelRecall 返回 null → 只注入 digest；
  // 这里连 digest 都没给 → 空块。工具如实反映这种「静默降级」，不编造 error。
  assert.ok(out.queries.every(q => q.v4.ok !== false || q.v4.error), '失败要有 error（若有）')
  assert.ok(out.summary.engine2.ok > 0, 'v5 侧应正常')
})

test('参数校验：缺少 --v4/--v5/--log / 文件不存在 → exit 2（清晰用法，不抛 stack）', { skip: CLI_SKIP }, () => {
  const missingArg = runCli(['--v4', F.v4, '--v5', F.v5])
  assert.equal(missingArg.status, 2)
  assert.ok(/缺少 --v4 \/ --v5 \/ --log/.test(missingArg.stderr))
  const missingFile = runCli(['--v4', F.v4, '--v5', path.join(TMP, 'nope.db'), '--log', F.log])
  assert.equal(missingFile.status, 2)
  assert.ok(/不存在/.test(missingFile.stderr))
})
