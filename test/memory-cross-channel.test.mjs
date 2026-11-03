// test/memory-cross-channel.test.mjs —— 锁定桥侧「跨通道记忆注入」的可见性规则
//
// 为什么需要这个文件（docs/MEMORY-AUDIT-AND-V5.md P1-3 / §4 Step 0 第 12 条）：
//   `lib/bridge/index.js` 的记忆注入段注释里**承诺**这个测试存在（「测试靠这两个
//   注释锚点抠源码求值（test/memory-cross-channel.test.mjs）」），但文件从来没写。
//   于是「私聊记忆会不会被当众说出来」「群里别人的事会不会漏进私聊」这类**只靠
//   人工试聊才能发现**的行为，一直没有任何回归保护。
//
// 怎么测（和注释承诺的方式一致 —— 抠源码求值，不启动桥）：
//   桥是「一个巨大的脚本」，不能直接 import。所以从源码里按两个注释锚点抠出
//   「记忆读取与注入」整段，在 node:vm 的沙箱里求值（外部依赖用桩注入：fs/path/
//   config/logger/execFileSync），再把假的 digest.md、假的 mem.db 指过去。
//   `crossChannelRecall` 内部会**真的起 python** 读那个临时库（库是 memctl 自己
//   建的临时库），所以测到的是真实链路，不是纯 mock。
//
// ⚠️ 不碰生产：临时目录 + `?mode=ro` + 只读假库；锚点被改时直接报错（不会静默失配）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync, execFileSync } from 'node:child_process'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const BRIDGE = path.join(ROOT, 'lib', 'bridge', 'index.js')
const MEMCTL_DIR = path.join(ROOT, 'lib', 'agent', 'memory')

const { probePython } = await import(pathToFileURL(path.join(ROOT, 'lib', 'pyprobe.mjs')).href)
const probe = probePython({ log: () => {} })
const SKIP = probe.ok ? false : `本机没有可用的 python（${probe.reason}），跨通道用例无法起真实检索`

// 桥注释里承诺的**两个锚点**。改了就报错 —— 这正是注释想要的效果。
const ANCHOR_START = '// ── 记忆读取与注入（digest + 按人跨通道检索）'
const ANCHOR_END = '// ── 自我风格样本库（人格一致性）'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'llminqq-cc-'))
process.on('exit', () => {
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
})

/** 从 bridge/index.js 抠出「记忆读取与注入」段（含两个锚点的校验）。 */
function extractMemorySection () {
  const src = fs.readFileSync(BRIDGE, 'utf8')
  const i = src.indexOf(ANCHOR_START)
  const j = src.indexOf(ANCHOR_END)
  assert.ok(i >= 0, `bridge/index.js 里找不到记忆段起始锚点：「${ANCHOR_START}」`)
  assert.ok(j > i, `bridge/index.js 里找不到记忆段结束锚点（或在起始之前）：「${ANCHOR_END}」`)
  return src.slice(i, j)
}

/**
 * 在沙箱里求值记忆段，返回桥内部的函数/常量。
 *
 * 沙箱原型挂 globalThis：段内用到 Set/Map/JSON/Date 等内建直接可用；
 * 外部依赖（fs/path/config/logger/execFileSync/STYLE_ROOTS/LEXICON_ROOTS）显式注入，
 * 未预期的外部标识符不会被静默吞掉（求值/调用时会报 ReferenceError）。
 */
function loadSection ({ dir, db, digest, state }) {
  const code = extractMemorySection()
  const sandbox = Object.assign(Object.create(globalThis), {
    fs,
    path,
    execFileSync,
    process,
    // config 是段内 MOST 引用的「配置真源」，全部指到临时目录
    config: {
      dsh: { stateDir: dir, cwd: dir },
      memory: {
        dir,
        db,
        digestPath: digest,
        codeDir: MEMCTL_DIR,
        memctl: path.join(MEMCTL_DIR, 'memctl.py'),
        runner: '',
        pythonBin: probe.bin || 'python3',
      },
    },
    logger: { log () {}, debug () {}, warn () {} },
    STYLE_ROOTS: {},
    LEXICON_ROOTS: {},
    state,
  })
  vm.createContext(sandbox)
  vm.runInContext(
    `${code}\n;globalThis.__MEM = { readMemoryDigestFor, memoryRecallBlock, crossChannelRecall,`
    + ' MEMORY_PATHS, MEMORY_CC, MEMORY_CC_PY, buildTopicHints }',
    sandbox,
  )
  return vm.runInContext('__MEM', sandbox)
}

/**
 * 用**真实 memctl**（import，非 mock）在临时库里造记忆。
 * rows: [{peer, text, kind, owner, visibility, isSelf, importance, pin}]
 */
function seedMemoryDb ({ dir, db, rows }) {
  const py = [
    'import sys, json',
    'sys.dont_write_bytecode = True',
    `sys.path.insert(0, ${JSON.stringify(MEMCTL_DIR)})`,
    'import memctl as m',
    `m.DB = ${JSON.stringify(db)}`,
    `m.DIGEST = ${JSON.stringify(path.join(dir, 'digest.md'))}`,
    `m.LOG_DIR = ${JSON.stringify(path.join(dir, 'log'))}`,
    `m.CURSOR = ${JSON.stringify(path.join(dir, '.ingest_cursor'))}`,
    'conn = m.connect(m.DB)',
    'for r in json.loads(sys.argv[1]):',
    '    if r.get("isSelf"):',
    '        m.remember(conn, r["peer"], r["text"], kind=r.get("kind") or "episodic",',
    '                   outbound=True, importance=r.get("importance"))',
    '    else:',
    '        m.remember(conn, r["peer"], r["text"], kind=r.get("kind") or "semantic",',
    '                   pin=bool(r.get("pin")), owner=r.get("owner"),',
    '                   visibility=r.get("visibility"), is_self=0,',
    '                   importance=r.get("importance"))',
    'conn.commit()',
    'conn.close()',
  ].join('\n')
  const r = spawnSync(probe.bin, [...(probe.preArgs || []), '-c', py, JSON.stringify(rows)], {
    encoding: 'utf8', timeout: 120000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', MEMCTL_PROD: '', MEMCTL_PROD_DIR: '' },
  })
  assert.equal(r.status, 0, `造临时记忆库失败：${r.stderr || r.stdout}`)
}

/** 用真实 memctl 调一次检索（返回 [{text, peer, visibility, score}]）。 */
function recallViaPython ({ dir, db, peer, query, inGroup, speaker, includeSelf = false }) {
  const py = [
    'import sys, json, sqlite3, urllib.parse',
    'sys.dont_write_bytecode = True',
    `sys.path.insert(0, ${JSON.stringify(MEMCTL_DIR)})`,
    'import memctl as m',
    'args = json.loads(sys.argv[1])',
    "conn = sqlite3.connect('file:%s?mode=ro' % urllib.parse.quote(args['db'], safe='/'), uri=True)",
    'conn.row_factory = sqlite3.Row',
    'rows = m.recall_with_visibility(conn, args["peer"], args["query"], args.get("top", 10),',
    '    in_group=args["inGroup"], speaker=args["speaker"] or None,',
    '    include_self=args["includeSelf"])',
    'print(json.dumps([{"text": r["text"], "peer": r["peer"], "visibility": r["visibility"],',
    '                  "is_self": r["is_self"], "score": round(float(s), 4)} for s, r in rows],',
    '                 ensure_ascii=False))',
  ].join('\n')
  const args = { db, peer, query, inGroup, speaker: speaker || '', includeSelf }
  const r = spawnSync(probe.bin, [...(probe.preArgs || []), '-c', py, JSON.stringify(args)], {
    encoding: 'utf8', timeout: 120000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  })
  assert.equal(r.status, 0, `临时库检索失败：${r.stderr || r.stdout}`)
  return JSON.parse(String(r.stdout).trim().split('\n').pop())
}

// ── 固定 fixture：一个人（qq）在两个通道的几类记忆 ────────────────────────
const QQ = '1000000001'
const PEER_C2C = 'c2c-1000000001'
const PEER_GROUP = 'group-2000000002'
const TEXT = {
  secret: '私聊里说的秘密：我下周要去医院复查',
  like: '他喜欢喝不加糖的冰美式',
  groupPublic: '群里说的公开事：周末羽毛球局改到三点',
  otherPerson: '群里另一个人说的：他也想学吉他',
  groupLevel: '群级知识：这个群每周三开黑',
  selfC2c: '我说过：早点睡别熬夜',
  selfGroup: '我在群里说过：这局我来带',
}
const ROWS = [
  { peer: PEER_C2C, text: TEXT.secret, kind: 'semantic', owner: QQ, visibility: 'dm_only', importance: 0.8 },
  { peer: PEER_C2C, text: TEXT.like, kind: 'semantic', owner: QQ, visibility: 'public', importance: 0.7 },
  { peer: PEER_GROUP, text: TEXT.groupPublic, kind: 'semantic', owner: QQ, visibility: 'public', importance: 0.7 },
  { peer: PEER_GROUP, text: TEXT.otherPerson, kind: 'semantic', owner: '9999999999', visibility: 'public', importance: 0.7 },
  { peer: PEER_GROUP, text: TEXT.groupLevel, kind: 'semantic', owner: null, visibility: 'public', importance: 0.7 },
  { peer: PEER_C2C, text: TEXT.selfC2c, isSelf: true, importance: 0.5 },
  { peer: PEER_GROUP, text: TEXT.selfGroup, isSelf: true, importance: 0.5 },
]

function newFixture () {
  const dir = fs.mkdtempSync(path.join(TMP, 'case-'))
  const db = path.join(dir, 'mem.db')
  const digest = path.join(dir, 'digest.md')
  fs.writeFileSync(digest, [
    '# 记忆摘要（测试用）', '',
    '## c2c-1000000001', '',
    '- ★ [程序] 私聊节·程序记忆MARK',
    '- · [语义] 私聊节·语义记忆MARK',
    '', '## group-2000000002', '',
    '- ★ [程序] 群聊节·程序记忆MARK',
    '- · [语义] 群聊节·语义记忆MARK',
    '',
  ].join('\n'))
  seedMemoryDb({ dir, db, rows: ROWS })
  return { dir, db, digest }
}

test('记忆段锚点可提取，注入入口函数都在（注释承诺的测试锚点）', () => {
  const code = extractMemorySection()
  assert.ok(code.length > 500, '记忆段过短，锚点可能抠错了')
  const f = newFixture()
  const M = loadSection(f)
  for (const name of ['readMemoryDigestFor', 'memoryRecallBlock', 'crossChannelRecall']) {
    assert.equal(typeof M[name], 'function', `记忆段里缺少 ${name}()`)
  }
})

test('digest 按 peer 分节：私聊注入不夹带群聊节，群聊注入不夹带私聊节', { skip: SKIP }, () => {
  const f = newFixture()
  const M = loadSection(f)

  const c2c = M.readMemoryDigestFor('c2c:1000000001')
  assert.ok(c2c.includes('私聊节·程序记忆MARK'), `私聊 digest 应包含本会话节：${c2c}`)
  assert.ok(!c2c.includes('群聊节·'), `私聊 digest 不能夹带群聊节：${c2c}`)

  const group = M.readMemoryDigestFor('group:2000000002')
  assert.ok(group.includes('群聊节·程序记忆MARK'), `群聊 digest 应包含本会话节：${group}`)
  assert.ok(!group.includes('私聊节·'), `群聊 digest 不能夹带私聊节：${group}`)
})

test('私聊场合：按人取到跨通道记忆，但别人的群聊记忆与自己说过的话不进注入', { skip: SKIP }, () => {
  const f = newFixture()
  const M = loadSection(f)
  const block = M.memoryRecallBlock('c2c:1000000001', {
    speaker: '', inGroup: false, query: '秘密 冰美式 羽毛球 吉他 开黑',
  })
  assert.ok(block.includes(TEXT.secret), `私聊里自己说过的事应能想起来：${block}`)
  assert.ok(block.includes(TEXT.like), '同一个人私聊里的公开事实应能想起来')
  // 群聊记忆可以跨通道带入（这是设计目标），但只限「关于这个人」的；别人/群级不行
  assert.ok(!block.includes(TEXT.otherPerson), `别人的记忆不能按 owner 漏进来：${block}`)
  assert.ok(!block.includes(TEXT.groupLevel), `群级(owner=NULL)记忆不能在私聊场合注入：${block}`)
  // include_self=False 是硬约定：自己说过的话不进「关于对方」的检索
  assert.ok(!block.includes(TEXT.selfC2c), '默认不应注入自己说过的话')
  assert.ok(!block.includes(TEXT.selfGroup))
})

test('群聊场合：dm_only 的私聊记忆不进群，公开记忆仍可见（不搞「一律禁跨通道」）', { skip: SKIP }, () => {
  const f = newFixture()
  const M = loadSection(f)
  const block = M.memoryRecallBlock('group:2000000002', {
    speaker: QQ, inGroup: true, query: '秘密 冰美式 羽毛球 吉他 开黑',
  })
  assert.ok(!block.includes(TEXT.secret), `私聊标注 dm_only 的记忆绝不能当众说出来：${block}`)
  assert.ok(block.includes(TEXT.groupPublic), '群里公开说过的事应能想起来')
  assert.ok(!block.includes(TEXT.otherPerson), '别人的记忆不能按 owner 漏进来')
  assert.ok(!block.includes(TEXT.selfC2c), '默认不应注入自己说过的话')
})

test('群级(owner=NULL)记忆只在自己的群场合注入，不跨到别的群/私聊', { skip: SKIP }, () => {
  const f = newFixture()
  // 造第二个群：两个群各有一条「群级」记忆，各自的群只该看到自己那条
  const OTHER_GROUP = 'group-3000000003'
  const otherGroupLevel = '群级知识：那个群的自习室在四楼'
  seedMemoryDb({
    dir: f.dir,
    db: f.db,
    rows: [{ peer: OTHER_GROUP, text: otherGroupLevel, kind: 'semantic', owner: null, importance: 0.7 }],
  })
  const M = loadSection(f)
  const other = M.memoryRecallBlock('group:3000000003', { speaker: QQ, inGroup: true, query: '开黑 羽毛球 吉他 自习室 四楼' })
  const ownGroup = M.memoryRecallBlock('group:2000000002', { speaker: QQ, inGroup: true, query: '开黑 羽毛球 吉他 自习室 四楼' })
  assert.ok(ownGroup.includes(TEXT.groupLevel), `群级记忆应在自己的群场合可见：${ownGroup}`)
  assert.ok(!ownGroup.includes(otherGroupLevel), `别的群的群级记忆不能串进来：${ownGroup}`)
  assert.ok(other.includes(otherGroupLevel), `另一个群应看到自己的群级记忆：${other}`)
  assert.ok(!other.includes(TEXT.groupLevel), `群级记忆不能跨群注入：${other}`)
})

test('include_self：默认不取自发言；显式开启只取当前私聊 peer 的，不带群里的自发言', { skip: SKIP }, () => {
  const f = newFixture()
  const base = { db: f.db, peer: PEER_C2C, query: '早点睡 带 局 开黑' }

  const off = recallViaPython({ ...base, inGroup: false, speaker: '', includeSelf: false })
  assert.ok(!off.some(r => r.text.includes('早点睡')), `include_self=False 不应返回自发言：${JSON.stringify(off)}`)
  assert.ok(!off.some(r => r.text.includes('这局我来带')))

  const on = recallViaPython({ ...base, inGroup: false, speaker: '', includeSelf: true })
  assert.ok(on.some(r => r.text.includes('早点睡')), `include_self=True 应能取到自己在该私聊说过的话：${JSON.stringify(on)}`)
  assert.ok(!on.some(r => r.text.includes('这局我来带')), '群里的自发言不针对某个人，不能归到私聊这个人头上')
})

test('无法推断 owner 的 peer 退回老 recall()：行为与改动前一致（向后兼容）', { skip: SKIP }, () => {
  const f = newFixture()
  seedMemoryDb({
    dir: f.dir,
    db: f.db,
    rows: [{ peer: 'legacy-peer-1', text: '老布局下的手动记忆：测试用', kind: 'semantic', importance: 0.6 }],
  })
  const rows = recallViaPython({
    db: f.db, peer: 'legacy-peer-1', query: '手动记忆 测试', inGroup: false, speaker: '',
  })
  assert.ok(rows.some(r => r.text.includes('手动记忆')), `owner 算不出来时应退回 recall()：${JSON.stringify(rows)}`)
})

test('注入脚本的只读契约：mode=ro + 不写 __pycache__ + include_self=False', () => {
  const code = extractMemorySection()
  const py = /const MEMORY_CC_PY = \[([\s\S]*?)\]\.join/.exec(code)
  assert.ok(py, '记忆段里找不到 MEMORY_CC_PY（注入用的内联 python）')
  const body = py[1]
  assert.ok(/mode=ro/.test(body), '注入脚本必须用只读连接打开记忆库（物理上不可能写生产库）')
  assert.ok(/dont_write_bytecode/.test(body), '注入脚本必须禁止写 __pycache__（生产 memory/ 是只读包目录）')
  assert.ok(/include_self=False/.test(body), '注入脚本必须显式 include_self=False（自发言不进「关于他」的检索）')
  // 场合必须真的传进 python：group → in_group=(in_group=='1')
  assert.ok(/in_group=\(in_group=='1'\)/.test(body), 'in_group 必须传给 recall_with_visibility（否则私聊记忆会当众说）')
})
