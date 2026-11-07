// test/unit-memctl-pin.test.mjs —— v4 钉子机制（P1-3，2026-11-06 task-2）
//
// 背景（生产库实锤，id=222）：
//   `明天(2026-10-26)下午三点开会，地点3楼` 被 is_pin() 规则②钉住 →
//   remember 把 kind 强制成 procedural（365 天半衰期）→ prune 对 pinned 直接放行
//   → digest 无条件给 ★ 排最前 → **一个月后还在主动搭话 prompt 里**。
//   而且全仓没有任何命令能把 pinned 改回 0（只有 done 会归档 + 写结论）。
//
// 这个测试锁住四件事（每一条都对应上面链条的一个环节）：
//   ① pin 判定闸：带**绝对日期**的安排不钉（能被后续过期规则解析），
//      只有相对时间（明天/下周/周X）才钉 —— 相对时间没法被解析，钉住才有意义；
//   ② 钉住的「一次性安排」kind 必须是 semantic（60 天半衰期），不再强制 procedural；
//      而「规矩类」仍然是 procedural（365 天）—— 两者不能混；
//   ③ digest 渲染对**过期钉住条目**降星（★→·），未来/今天的日期**不降级**；
//   ④ `unpin` 命令：pinned 1→0，不归档、不删除、importance 不变；幂等；dry-run 不写库。
//
// 为什么用子进程跑真实 memctl.py（而不是 import 后 mock）：
//   要验的正是 pinned 字段、kind、digest 渲染、幂等这些**跨函数联动**效果。
//   把 memctl.py **拷到 os.tmpdir() 下**再跑：它的 BASE 由自身位置推导，
//   DB=tmp/mem.db、digest=tmp/digest.md，碰不到真实 ~/.dsh/.../memory/mem.db。
//   同步：MEMCTL_PROD / MEMCTL_PROD_DIR 清空（临时目录本来就是非生产）。
//
// 没有 python 的机器：整组 skip（和 unit-memctl-done.test.mjs 同一处理）。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const MEMCTL_SRC = path.join(ROOT, 'lib', 'agent', 'memory', 'memctl.py')

const { probePython } = await import(pathToFileURL(path.join(ROOT, 'lib', 'pyprobe.mjs')).href)
const probe = probePython({ log: () => {} })
const SKIP = probe.ok ? false : `本机没有可用的 python（${probe.reason}），跳过钉子机制用例`

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'llminqq-memctl-pin-'))
process.on('exit', () => {
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* 清理失败不影响结果 */ }
})

/** 造一个隔离的「记忆目录」：只放一份 memctl.py 副本（DB/digest 全落到这里）。 */
function newMemoryDir () {
  const dir = fs.mkdtempSync(path.join(TMP, 'mem-'))
  fs.copyFileSync(MEMCTL_SRC, path.join(dir, 'memctl.py'))
  return dir
}

const BASE_ENV = { ...process.env, PYTHONDONTWRITEBYTECODE: '1', MEMCTL_PROD: '', MEMCTL_PROD_DIR: '' }

/** 直接跑 memctl.py（返回完整 spawn 结果，给要断退出码的用例用）。 */
function runPy (dir, args) {
  return spawnSync(probe.bin, [...(probe.preArgs || []), path.join(dir, 'memctl.py'), ...args], {
    encoding: 'utf8',
    timeout: 120000,
    env: BASE_ENV,
  })
}

/** 跑 memctl.py 并要求成功，返回 stdout。 */
function memctl (dir, ...args) {
  const r = runPy(dir, args)
  assert.equal(r.status, 0,
    `memctl ${args.join(' ')} 应成功，实际退出码 ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`)
  return r.stdout
}

/** 在临时目录里跑一段 python 代码（路径常量指到临时库，不碰生产）。 */
function pyIn (dir, body) {
  const prelude = [
    'import sys, json',
    'sys.dont_write_bytecode = True',
    `sys.path.insert(0, ${JSON.stringify(dir)})`,
    'import memctl as m',
    `m.DB = ${JSON.stringify(path.join(dir, 'mem.db'))}`,
    `m.DIGEST = ${JSON.stringify(path.join(dir, 'digest.md'))}`,
    `m.LOG_DIR = ${JSON.stringify(path.join(dir, 'log'))}`,
    `m.CURSOR = ${JSON.stringify(path.join(dir, '.ingest_cursor'))}`,
  ].join('\n')
  const r = spawnSync(probe.bin, [...(probe.preArgs || []), '-c', prelude + '\n' + body], {
    encoding: 'utf8', timeout: 120000, env: BASE_ENV,
  })
  assert.equal(r.status, 0, `跑临时 python 片段失败：\n${r.stderr || r.stdout}`)
  return r.stdout
}

// ── 库读写工具 ──────────────────────────────────────────────────────────────
const DUMP_PY = [
  'import json',
  'con = m.connect(m.DB)',
  'rows = [dict(r) for r in con.execute(',
  '    "SELECT id, peer, kind, text, importance, pinned, retired, hits, created "',
  '    "FROM entries ORDER BY id")]',
  'print(json.dumps(rows, ensure_ascii=False))',
].join('\n')

/** 把临时库整表导出成对象数组（断言用）。 */
function dump (dir) {
  return JSON.parse(pyIn(dir, DUMP_PY))
}

/** 直接插一行（绕过 ingest，为了能精确控制 created/pinned/kind）。 */
function insertRow (dir, { text, peer = 'c2c-1000000001', kind = 'semantic', pinned = 1,
  importance = 0.8, created = null, retired = 0 }) {
  const now = Math.floor(Date.now() / 1000)
  const createdTs = created === null ? now : created
  pyIn(dir, [
    'import hashlib, re',
    `txt = ${JSON.stringify(text)}`,
    `fp = hashlib.sha1(re.sub(r"\\s+", "", txt).encode("utf-8")).hexdigest()[:16]`,
    'con = m.connect(m.DB)',
    'con.execute(',
    '  "INSERT INTO entries(peer,kind,text,fp,importance,strength,pinned,hits,created,last_seen,retired,"',
    '  "owner,visibility,is_self) VALUES(?,?,?,?,?,?,?,1,?,?,?,?,?,0)",',
    `  (${JSON.stringify(peer)}, ${JSON.stringify(kind)}, txt, fp, ${Number(importance)}, 1.0,`,
    `   ${Number(pinned)}, ${createdTs}, ${createdTs}, ${Number(retired)}, '1000000001', 'public'))`,
    'con.commit()',
    'print("ok")',
  ].join('\n'))
}

/** 记一条记忆（走 CLI，等价于真实 ingest 里那一跳的 remember 调用）。 */
function rememberCli (dir, text, extra = ['--kind', 'episodic']) {
  memctl(dir, 'remember', text, '--peer', 'c2c-1000000001', ...extra)
}

// ═══════════════════════════════════════════════════════════════════════════
// ① pin 判定闸（纯函数）：绝对日期不钉、相对时间钉、纯规矩钉
// ═══════════════════════════════════════════════════════════════════════════
//
// 这是整个修复的第一环：判定错了，后面 kind / digest / prune 全部跟着错。
// 断言的是 pin_decision()（唯一真相），is_pin() 只是它的布尔投影。

const PIN_CASES_PY = [
  'cases = [',
  '    ("absolute-dash", "明天(2026-10-26)下午三点开会，地点3楼", False, "semantic", 0.8),',
  '    ("absolute-cn", "2026年10月26日下午三点开会，地点3楼", False, "semantic", 0.8),',
  '    ("absolute-md", "10月26日下午三点开会，地点3楼", False, "semantic", 0.8),',
  '    ("relative", "明天下午三点开会，地点3楼", True, "arrangement", None),',
  '    ("relative-week", "下周三上午十点见面，别忘带合同", True, "arrangement", None),',
  '    ("rule", "记住以后每晚十点提醒我睡觉", True, "rule", None),',
  '    ("rule-2", "以后每次开会都必须先说结论", True, "rule", None),',
  '    ("question", "你觉得明天下午三点开会怎么样？", False, None, None),',
  '    ("noise", "已开启：proactive 定时任务", False, None, None),',
  ']',
  'out = []',
  'for name, txt, want_pin, want_kind, want_floor in cases:',
  '    pd = m.pin_decision(txt)',
  '    out.append({',
  '        "name": name, "text": txt,',
  '        "pin": pd["pin"], "is_pin": m.is_pin(txt),',
  '        "kind": pd["kind"], "floor": pd["importance_floor"],',
  '        "want_pin": want_pin, "want_kind": want_kind, "want_floor": want_floor,',
  '    })',
  'print(json.dumps(out, ensure_ascii=False))',
].join('\n')

test('pin 判定：绝对日期不钉（kind=semantic, importance 抬到 0.8）；相对时间 / 纯规矩才钉', { skip: SKIP }, () => {
  const dir = newMemoryDir()
  const cases = JSON.parse(pyIn(dir, PIN_CASES_PY))

  for (const c of cases) {
    assert.equal(c.pin, c.want_pin, `${c.name}「${c.text}」pin 期望 ${c.want_pin}，实际 ${c.pin}`)
    assert.equal(c.is_pin, c.want_pin, `is_pin() 和 pin_decision() 不一致（${c.name}）`)
    assert.equal(c.kind, c.want_kind, `${c.name}「${c.text}」kind 期望 ${c.want_kind}，实际 ${c.kind}`)
    assert.equal(c.floor, c.want_floor, `${c.name}「${c.text}」importance_floor 期望 ${c.want_floor}，实际 ${c.floor}`)
  }

  // 逐条点名（防「表驱动里少写一行就悄悄不漏」）：
  // 生产库 id=222 那条原文，是最重要的一条回归样本。
  const byName = Object.fromEntries(cases.map(c => [c.name, c]))
  assert.equal(byName['absolute-dash'].pin, false,
    '生产库 id=222 原文（明天(2026-10-26)下午三点开会，地点3楼）仍然会被钉住 —— 这就是这次要修的死循环')
  assert.ok(byName['absolute-dash'].floor >= 0.8, '不钉了但仍是重要事实，importance 不能掉下来')
  assert.equal(byName.relative.pin, true, '只有相对时间（明天下午三点）没法定格，必须仍能钉住')
  assert.equal(byName.rule.pin, true, '纯规矩（记住以后每晚十点提醒）必须继续钉住 —— 这不是本次要削掉的东西')
})

// ═══════════════════════════════════════════════════════════════════════════
// ② ingest 落库：带时间锚的 pin 条目 kind 是 semantic；规矩仍是 procedural
// ═══════════════════════════════════════════════════════════════════════════
//
// 这一环对应「pinned 的代价不可逆」：以前 pin 一律强转 procedural（365 天）。
// 一次性安排只该活 60 天 —— 它本来就是「过期就结束」的事。

test('ingest 落库：带时间锚的 pin 条目 kind 是 semantic（不再强制 procedural）', { skip: SKIP }, () => {
  const dir = newMemoryDir()
  // 真 bridge.out 格式（和 lib/bridge/index.js 写的一致）
  fs.writeFileSync(path.join(dir, 'bridge.out'), [
    '2026-10-25T20:00:00.000Z 入站 c2c:1000000001 from=信风(1000000001) text="明天(2026-10-26)下午三点开会，地点3楼" images=0',
    '2026-11-06T04:00:00.000Z 入站 c2c:1000000001 from=信风(1000000001) text="明天下午三点开会，记得带电脑" images=0',
    '2026-11-06T04:01:00.000Z 入站 c2c:1000000001 from=信风(1000000001) text="记住以后每晚十点提醒我睡觉" images=0',
    '2026-11-06T04:02:00.000Z 入站 c2c:1000000001 from=信风(1000000001) text="他喜欢喝冰美式不加糖" images=0',
  ].join('\n'))
  memctl(dir, 'ingest', '--path', path.join(dir, 'bridge.out'))
  const rows = dump(dir)
  const byText = Object.fromEntries(rows.map(r => [r.text, r]))

  // 绝对日期（生产库 id=222 原文）：不钉 + semantic + importance >= 0.8
  const absolute = byText['明天(2026-10-26)下午三点开会，地点3楼']
  assert.ok(absolute, '绝对日期那条没入库')
  assert.equal(absolute.pinned, 0, '带绝对日期的安排不该钉住（能被过期规则解析，钉住只会卡死）')
  assert.equal(absolute.kind, 'semantic')
  assert.ok(absolute.importance >= 0.8, `不钉但它仍是重要事实，importance 应 >=0.8，实际 ${absolute.importance}`)

  // 相对时间（明天下午三点）：钉住 + **semantic**（60 天半衰期，不是 procedural 365 天）
  const relative = byText['明天下午三点开会，记得带电脑']
  assert.ok(relative, '相对时间那条没入库')
  assert.equal(relative.pinned, 1, '相对时间没法被解析，钉住才有意义 —— 必须仍然钉')
  assert.equal(relative.kind, 'semantic', '带时间锚的一次性安排必须是 semantic（60 天），不能是 procedural（365 天）')

  // 纯规矩：钉住 + procedural（半年/一年不衰减，这是它该有的样子）
  const rule = byText['记住以后每晚十点提醒我睡觉']
  assert.equal(rule.pinned, 1)
  assert.equal(rule.kind, 'procedural', '规矩类必须仍是 procedural —— 这次只给「一次性安排」开 semantic 分支')

  // 普通事实：不该被这些判定波及
  const plain = byText['他喜欢喝冰美式不加糖']
  assert.equal(plain.pinned, 0)
})

// ═══════════════════════════════════════════════════════════════════════════
// ③ digest：过期钉住条目降星（★→·）；未来 / 今天的日期不降级
// ═══════════════════════════════════════════════════════════════════════════

/** 本地时区的今天（python 侧也是本地时区，两边口径必须一致）。 */
function localToday () {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 取 digest.md 里含某关键词的那一行。 */
function digestLine (dir, keyword) {
  const md = fs.readFileSync(path.join(dir, 'digest.md'), 'utf8')
  const hits = md.split('\n').filter(l => l.includes(keyword))
  assert.equal(hits.length, 1, `digest 里含「${keyword}」的行应恰好一条，实际 ${hits.length}：\n${md}`)
  return hits[0]
}

test('digest：过期钉住条目 ★ 降成 ·（未来 / 今天的日期不降级）', { skip: SKIP }, () => {
  const dir = newMemoryDir()
  // 显式插 4 行 pinned，绕过 ingest —— 为了精确控制「文本自带日期」与 created。
  // 每行用**不同的楼层**当唯一锚（断言行时用 3楼/5楼/8楼/9楼 精确取，不靠
  // 「含某个公共子串」——那样三行都命中，这个测试第一次就踩到这个坑）。
  insertRow(dir, { text: '2026-10-26 下午三点开会，地点3楼' })                       // 过去 → 降级
  insertRow(dir, { text: '2099-12-31 下午三点开会，地点5楼' })                       // 未来 → 不降级
  const td = localToday()
  insertRow(dir, { text: `${Number(td.slice(0, 4))}年${Number(td.slice(5, 7))}月${Number(td.slice(8, 10))}日下午三点开会，地点8楼` }) // 今天 → 不降级
  insertRow(dir, { text: '明天下午三点开会，地点9楼' })                               // 相对时间无绝对日期 → 不降级

  memctl(dir, 'digest')

  const past = digestLine(dir, '地点3楼')
  assert.ok(past.startsWith('- · '), `过期钉住条目应降成 ·（仍是可见的一行，不是删除）：${past}`)
  assert.ok(past.includes('[语义]'), `降级不能改变分层标记：${past}`)

  const future = digestLine(dir, '地点5楼')
  assert.ok(future.startsWith('- ★ '), `未来日期的钉住条目绝不能降级：${future}`)

  const today = digestLine(dir, '地点8楼')
  assert.ok(today.startsWith('- ★ '), `今天的安排不算过期（当天还没过完）：${today}`)

  const relative = digestLine(dir, '地点9楼')
  assert.ok(relative.startsWith('- ★ '), '没有绝对日期的相对时间条目不能降级（判定不猜）：' + relative)

  // 头部说明也要写清「降级规则」，否则模型/人看不懂 · 和 ★ 的差别
  const md = fs.readFileSync(path.join(dir, 'digest.md'), 'utf8')
  assert.match(md, /★ 会降成 ·/, 'digest 头部没解释过期降级（模型会以为那行只是「不重要」）')
})

test('digest：降级只对 pinned 生效（普通条目本来就会衰减，不受日期降级影响）', { skip: SKIP }, () => {
  const dir = newMemoryDir()
  // 同一句过期文本：一条 pinned、一条普通。普通条目即使 importance 高也**不**走
  // 「日期降级」这条（它本来就按 importance/recency 排序，双层惩罚不合理）。
  insertRow(dir, { text: '2026-10-26 下午三点开会，地点3楼', pinned: 1, importance: 0.9 })
  insertRow(dir, { text: '2026-10-27 下午四点开会，地点2楼', pinned: 0, importance: 0.9 })
  memctl(dir, 'digest')

  const pinnedLine = digestLine(dir, '2026-10-26')
  assert.ok(pinnedLine.startsWith('- · '), `过期 pinned 条目应降级：${pinnedLine}`)
  const plainLine = digestLine(dir, '2026-10-27')
  assert.ok(plainLine.startsWith('- ★ '),
    `普通条目（importance>=0.85）不该被日期降级规则再罚一次：${plainLine}`)
})

// ═══════════════════════════════════════════════════════════════════════════
// ④ unpin 命令：pinned 1→0（不归档、不删除、importance 不变）；幂等；dry-run
// ═══════════════════════════════════════════════════════════════════════════

test('unpin --match：解除钉住但不归档、不删除、importance 不变', { skip: SKIP }, () => {
  const dir = newMemoryDir()
  insertRow(dir, { text: '明天(2026-10-26)下午三点开会，地点3楼', kind: 'procedural', pinned: 1, importance: 0.8 })
  insertRow(dir, { text: '记住以后每周五交周报', kind: 'procedural', pinned: 1, importance: 0.7 })
  insertRow(dir, { text: '他喜欢喝冰美式不加糖', kind: 'semantic', pinned: 0, importance: 0.5, created: 1_700_000_000 })
  const before = dump(dir)

  const out = memctl(dir, 'unpin', '--match', '开会')
  const after = dump(dir)

  // ① 命中那条：pinned 0，但行还在、retired 仍 0、kind/importance 都没变
  const target = after.find(r => r.text.includes('开会'))
  assert.equal(target.pinned, 0, 'pinned 没被置 0')
  assert.equal(target.retired, 0, 'unpin 不允许归档（那是 done 的语义）')
  assert.equal(target.kind, 'procedural', 'unpin 不该改 kind')
  assert.equal(target.importance, before.find(r => r.text.includes('开会')).importance,
    'unpin 不该动 importance（那是独立判断，改它就是双重惩罚）')
  // ② 行数不变（不删除）
  assert.equal(after.length, before.length, 'unpin 不允许删除条目')
  // ③ 无关条目逐字段不变
  const other = after.find(r => r.text.includes('周报'))
  assert.deepEqual(other, before.find(r => r.text.includes('周报')), '无关的钉住条目被动了')
  assert.deepEqual(after.find(r => r.text.includes('冰美式')), before.find(r => r.text.includes('冰美式')),
    '未钉住的普通条目被动了')
  // ④ 输出要让人能核对命中
  assert.ok(out.includes('#'), `输出应列出命中的 id：${out}`)
  assert.ok(out.includes('解除钉住 1 条'), `输出应报告解除条数：${out}`)
})

test('unpin 幂等：第二次执行命中 0 条，库一个字节都不变', { skip: SKIP }, () => {
  const dir = newMemoryDir()
  insertRow(dir, { text: '明天(2026-10-26)下午三点开会，地点3楼', kind: 'procedural', pinned: 1 })

  const first = memctl(dir, 'unpin', '--match', '开会')
  const snapshot = dump(dir)
  const second = memctl(dir, 'unpin', '--match', '开会')
  const after = dump(dir)

  assert.ok(first.includes('解除钉住 1 条'))
  assert.ok(second.includes('没有匹配到仍被钉住的条目'), `第二次应报告无命中：${second}`)
  assert.deepEqual(after, snapshot, '第二次 unpin 不允许改动库（幂等就废了）')
})

test('unpin --dry-run：只报命中，不写库', { skip: SKIP }, () => {
  const dir = newMemoryDir()
  insertRow(dir, { text: '明天(2026-10-26)下午三点开会，地点3楼', kind: 'procedural', pinned: 1 })
  const before = dump(dir)

  const out = memctl(dir, 'unpin', '--match', '开会', '--dry-run')
  const after = dump(dir)

  assert.deepEqual(after, before, '--dry-run 不允许写库')
  assert.ok(out.includes('[dry-run]'), `输出应标明 dry-run：${out}`)
  assert.ok(out.includes('开会'), `应列出将命中的条目：${out}`)
})

test('unpin --id：按 id 精确解除，不误伤同关键词的其它条目', { skip: SKIP }, () => {
  const dir = newMemoryDir()
  insertRow(dir, { text: '把报价单发给张姐，周五前完成', kind: 'procedural', pinned: 1 })
  insertRow(dir, { text: '把考勤表发给张姐，周五前完成', kind: 'procedural', pinned: 1 })
  const target = dump(dir).find(r => r.text.includes('报价单'))

  memctl(dir, 'unpin', '--id', String(target.id))
  const rows = dump(dir)

  assert.equal(rows.find(r => r.id === target.id).pinned, 0)
  assert.equal(rows.find(r => r.text.includes('考勤表')).pinned, 1, '不在 --id 里的同关键词条目不该被解除')
})

test('unpin --match + --peer：只解除指定会话的钉子', { skip: SKIP }, () => {
  const dir = newMemoryDir()
  insertRow(dir, { text: '明天下午三点开会，地点3楼', peer: 'c2c-1000000001', pinned: 1 })
  insertRow(dir, { text: '明天下午三点开会，地点3楼', peer: 'group-2000000002', pinned: 1 })

  memctl(dir, 'unpin', '--match', '开会', '--peer', 'c2c-1000000001')
  const rows = dump(dir)

  assert.equal(rows.find(r => r.peer === 'c2c-1000000001').pinned, 0)
  assert.equal(rows.find(r => r.peer === 'group-2000000002').pinned, 1, '其它 peer 的钉子不该被一并解除')
})

test('unpin 不带 --match / --id：明确报用法错误（退出码 2），不静默成功', { skip: SKIP }, () => {
  const dir = newMemoryDir()
  insertRow(dir, { text: '明天(2026-10-26)下午三点开会，地点3楼', kind: 'procedural', pinned: 1 })

  const r = runPy(dir, ['unpin'])
  assert.equal(r.status, 2, `应退出码 2，实际 ${r.status}`)
  assert.ok(String(r.stderr).includes('--match'), `stderr 应提示用法：${r.stderr}`)
  assert.equal(dump(dir).find(x => x.text.includes('开会')).pinned, 1, '报错时不能动库')
})

// ═══════════════════════════════════════════════════════════════════════════
// ⑤ 端到端：生产库那条 id=222 的复现链路，修复后整条链路都是干净的
// ═══════════════════════════════════════════════════════════════════════════

test('端到端：id=222 样本走完整 ingest→digest 链路后不再带 ★', { skip: SKIP }, () => {
  const dir = newMemoryDir()
  fs.writeFileSync(path.join(dir, 'bridge.out'),
    '2026-10-25T20:00:00.000Z 入站 c2c:1000000001 from=信风(1000000001) ' +
    'text="明天(2026-10-26)下午三点开会，地点3楼" images=0')
  memctl(dir, 'ingest', '--path', path.join(dir, 'bridge.out'))
  memctl(dir, 'digest')
  const line = digestLine(dir, '开会')
  assert.ok(!line.includes('★'),
    `复现样本修复后仍带 ★（再过一个月它会继续泄漏进主动搭话 prompt）：${line}`)
  assert.ok(line.includes('·') || line.includes('✅'), `应降成 · 或已完成标记：${line}`)
})
