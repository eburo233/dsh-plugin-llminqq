// test/unit-memctl-done.test.mjs —— memctl done（待办完成 → 归档 + 结论）的行为测试
//
// 为什么要单独测 done：
//   · 它直接决定「模型下一轮能看到哪些记忆」。旧待办还留在 digest / recall 里，
//     模型就会反复拿已完成的事当话题（用户实测反馈过：「定了一件待办，完成之后
//     怎么更新」—— 更新不了，旧条目一直显示未了结）。
//   · 这种退化**不报错**：聊天看起来正常，只是不停翻旧账，所以只能靠测试钉住
//     「归档生效 / 结论写入 / digest 不再展示旧待办 / 重复执行幂等」。
//
// 为什么用子进程跑真实 memctl.py，而不是 import 后 mock：
//   要验证的正是 retired 字段、digest 渲染、幂等跨函数的联动效果。
//   把 memctl.py **拷到 os.tmpdir() 下**再跑：它的 BASE 由自身位置推导，
//   DB=tmp/mem.db、digest=tmp/digest.md，碰不到真实的 ~/.dsh/.../memory/mem.db，
//   也不需要 MEMCTL_PROD 守卫（没有 .prod-guard 哨兵 = 非生产库）。
//
// 没有 python 的机器：整组 skip（和 plugin-admin.test.mjs 的处理一致），不失败。

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
const SKIP = probe.ok ? false : `本机没有可用的 python（${probe.reason}），跳过 done 行为用例`

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'llminqq-memctl-done-'))
process.on('exit', () => {
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* 清理失败不影响结果 */ }
})

/**
 * 造一个隔离的「记忆目录」：只放一份 memctl.py 副本。
 * 之后所有 CLI 调用都在这个目录里跑，DB / digest / 游标全落到这里。
 */
function newMemoryDir () {
  const dir = fs.mkdtempSync(path.join(TMP, 'mem-'))
  fs.copyFileSync(MEMCTL_SRC, path.join(dir, 'memctl.py'))
  return dir
}

/** 直接跑 memctl.py（返回完整 spawn 结果，给要断退出码的用例用）。 */
function runPy (dir, args) {
  return spawnSync(probe.bin, [...(probe.preArgs || []), path.join(dir, 'memctl.py'), ...args], {
    encoding: 'utf8',
    timeout: 120000,
    // 把生产守卫相关环境变量清空：临时目录本来就是非生产，避免 CI 里被外部设置带偏。
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', MEMCTL_PROD: '', MEMCTL_PROD_DIR: '' },
  })
}

/** 跑 memctl.py 并要求成功，返回 stdout。 */
function memctl (dir, ...args) {
  const r = runPy(dir, args)
  assert.equal(r.status, 0,
    `memctl ${args.join(' ')} 应成功，实际退出码 ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`)
  return r.stdout
}

/** 记一条记忆（命令行等价于 agent 用的 `memctl remember`）。 */
function remember (dir, text, peer, extra = []) {
  memctl(dir, 'remember', text, '--peer', peer, ...extra)
}

// 读库用 python 自带的 sqlite3（避免在 node 里引 sqlite 依赖）。
const DUMP_PY = [
  'import sqlite3, json, sys',
  'con = sqlite3.connect(sys.argv[1])',
  'con.row_factory = sqlite3.Row',
  'rows = [dict(r) for r in con.execute(',
  '    "SELECT id, peer, kind, text, importance, pinned, retired, hits "',
  '    "FROM entries ORDER BY id")]',
  'print(json.dumps(rows, ensure_ascii=False))',
].join('\n')

/** 把临时库整表导出成对象数组（断言用）。 */
function dump (dir) {
  const r = spawnSync(probe.bin,
    [...(probe.preArgs || []), '-c', DUMP_PY, path.join(dir, 'mem.db')],
    { encoding: 'utf8', timeout: 60000 })
  assert.equal(r.status, 0, `读临时库失败：${r.stderr}`)
  return JSON.parse(r.stdout)
}

const conclusions = rows => rows.filter(r => r.text.startsWith('已完成：'))

test('done --match：归档命中的待办 + 补 pinned 语义结论，不动无关条目和其它 peer', { skip: SKIP }, () => {
  const dir = newMemoryDir()
  remember(dir, '下周三帮他把服务器迁移到新机器', 'c2c-1000000001', ['--kind', 'procedural', '--pin'])
  remember(dir, '他喜欢喝冰美式，不加糖', 'c2c-1000000001', ['--kind', 'semantic'])
  remember(dir, '周末想去看那家新开的烤肉店', 'c2c-2000000002', ['--kind', 'procedural', '--pin'])

  const out = memctl(dir, 'done', '--match', '服务器迁移')
  const rows = dump(dir)

  const todo = rows.find(r => r.text.includes('服务器迁移'))
  assert.equal(todo.retired, 1, '命中的待办应被归档（retired=1，不删）')

  const done = conclusions(rows)
  assert.equal(done.length, 1, '应写入且只写入一条「已完成：」结论')
  assert.equal(done[0].peer, 'c2c-1000000001', '结论要落在原待办所属 peer 的摘要节里')
  assert.equal(done[0].kind, 'semantic', '结论是稳定事实 → semantic 层')
  assert.equal(done[0].pinned, 1, '结论要钉住，否则会被 prune 清掉')
  assert.equal(done[0].retired, 0, '结论必须可见（不能是归档状态）')
  assert.ok(done[0].importance >= 0.8, `结论重要性应为中高，实际 ${done[0].importance}`)

  // 无关条目、其它 peer 的同记忆不能被「顺手」归档
  assert.equal(rows.find(r => r.text.includes('冰美式')).retired, 0)
  assert.equal(rows.find(r => r.text.includes('烤肉店')).retired, 0)
  // 命令输出要让人能核对命中（否则一次 --match 误伤多条时无从发现）
  assert.ok(out.includes('归档 1 条待办'), `输出应报告归档条数：${out}`)
  assert.ok(out.includes('#'), `输出应列出命中的 id：${out}`)
})

test('done --id：按 id 精确归档，不误伤同关键词的其它条目', { skip: SKIP }, () => {
  const dir = newMemoryDir()
  remember(dir, '把报价单发给张姐', 'c2c-1000000001', ['--kind', 'procedural', '--pin'])
  remember(dir, '把考勤表发给张姐', 'c2c-1000000001', ['--kind', 'procedural', '--pin'])
  const target = dump(dir).find(r => r.text.includes('报价单'))

  memctl(dir, 'done', '--id', String(target.id))
  const rows = dump(dir)

  assert.equal(rows.find(r => r.id === target.id).retired, 1, '指定的 id 应被归档')
  assert.equal(rows.find(r => r.text.includes('考勤表')).retired, 0, '不在 --id 里的同关键词条目不动')
  const done = conclusions(rows)
  assert.equal(done.length, 1)
  assert.ok(done[0].text.includes('报价单'), `结论应描述被了结的那件事：${done[0].text}`)
})

test('done --match + --peer：只了结指定会话，别的 peer 的同名待办不受影响', { skip: SKIP }, () => {
  const dir = newMemoryDir()
  remember(dir, '周五下班前把周报交了', 'c2c-1000000001', ['--kind', 'procedural', '--pin'])
  remember(dir, '周五下班前把周报交了', 'group-2000000002', ['--kind', 'procedural', '--pin'])

  memctl(dir, 'done', '--match', '周报', '--peer', 'c2c-1000000001')
  const rows = dump(dir)

  assert.equal(rows.find(r => r.peer === 'c2c-1000000001').retired, 1, '指定 peer 的待办应归档')
  assert.equal(rows.find(r => r.peer === 'group-2000000002').retired, 0, '其它 peer 的那件事还没完成，不能一并归档')
  const done = conclusions(rows)
  assert.equal(done.length, 1)
  assert.equal(done[0].peer, 'c2c-1000000001')
})

test('done 幂等：重复执行不重复归档、不重复写结论（不会套娃出「已完成：已完成：」）', { skip: SKIP }, () => {
  const dir = newMemoryDir()
  remember(dir, '下周三帮他把服务器迁移到新机器', 'c2c-1000000001', ['--kind', 'procedural', '--pin'])

  const first = memctl(dir, 'done', '--match', '服务器迁移')
  const snapshot = dump(dir)
  const second = memctl(dir, 'done', '--match', '服务器迁移')
  const after = dump(dir)

  assert.ok(first.includes('归档 1 条待办'))
  assert.ok(second.includes('没有匹配到未归档的待办'), `第二次应报告无命中：${second}`)
  assert.deepEqual(after, snapshot, '第二次 done 不允许改动库（重复归档/重复结论都算 bug）')
  assert.equal(conclusions(after).length, 1)
  assert.ok(!conclusions(after)[0].text.includes('已完成：已完成：'),
    `结论不能套娃：${conclusions(after)[0].text}`)
})

test('归档后同一条再被 remember：只强化、不复活（digest 不会重新翻旧账）', { skip: SKIP }, () => {
  const dir = newMemoryDir()
  remember(dir, '下周三帮他把服务器迁移到新机器', 'c2c-1000000001', ['--kind', 'procedural', '--pin'])
  memctl(dir, 'done', '--match', '服务器迁移')
  const before = dump(dir)

  // 模拟「同一句话又从日志里 ingest 了一遍」：remember 的 (peer, fp) 去重会命中
  // 已归档那行，只做强化（hits/strength/importance），绝不能把 retired 改回 0。
  remember(dir, '下周三帮他把服务器迁移到新机器', 'c2c-1000000001', ['--kind', 'procedural', '--pin'])
  const after = dump(dir)

  assert.equal(after.length, before.length, '不应新增行（同一 fp 应去重）')
  const todo = after.find(r => r.text.includes('服务器迁移'))
  assert.equal(todo.retired, 1, '归档是粘性的：再出现也不能复活')
  assert.ok(todo.hits > 1, '应走强化分支（hits 增加）')
})

test('done --dry-run：只报命中，不写库', { skip: SKIP }, () => {
  const dir = newMemoryDir()
  remember(dir, '下周三帮他把服务器迁移到新机器', 'c2c-1000000001', ['--kind', 'procedural', '--pin'])
  const before = dump(dir)

  const out = memctl(dir, 'done', '--match', '服务器迁移', '--dry-run')
  const after = dump(dir)

  assert.deepEqual(after, before, '--dry-run 不允许写库')
  assert.equal(conclusions(after).length, 0)
  assert.ok(out.includes('[dry-run]'), `输出应标明 dry-run：${out}`)
  assert.ok(out.includes('服务器迁移'), `应列出将命中的条目：${out}`)
})

test('digest：旧待办消失、已完成结论用 ✅ 展示、无关记忆照常保留', { skip: SKIP }, () => {
  const dir = newMemoryDir()
  remember(dir, '下周三帮他把服务器迁移到新机器', 'c2c-1000000001', ['--kind', 'procedural', '--pin'])
  remember(dir, '他喜欢喝冰美式，不加糖', 'c2c-1000000001', ['--kind', 'semantic'])
  remember(dir, '周末想去看那家新开的烤肉店', 'c2c-2000000002', ['--kind', 'procedural', '--pin'])

  memctl(dir, 'done', '--match', '服务器迁移')
  memctl(dir, 'digest')
  const md = fs.readFileSync(path.join(dir, 'digest.md'), 'utf8')

  // 旧待办那句话只能作为「已完成」结论的一部分出现，不能单独作为一条待办再出现
  const hitLines = md.split('\n').filter(l => l.includes('服务器迁移'))
  assert.equal(hitLines.length, 1, `「服务器迁移」应只在结论里出现一次：\n${md}`)
  assert.ok(hitLines[0].includes('✅'), `结论行应有 ✅ 标记：${hitLines[0]}`)
  assert.ok(hitLines[0].includes('已完成：'))
  // 结论落在「语义记忆 · 稳定事实」层（了结的是事实，不是新的约定）
  assert.ok(md.includes('已完成：'), md)

  assert.ok(md.includes('冰美式'), '无关语义记忆不能被 done 波及')
  assert.ok(md.includes('烤肉店'), '其它 peer 的待办不能被 done 波及')
  assert.ok(md.includes('✅ = **已完成**'), '摘要头部应解释 ✅ 的含义（模型才看得懂）')
})

test('--match 里的 LIKE 通配符会被转义（「100%」不会匹配整库）', { skip: SKIP }, () => {
  const dir = newMemoryDir()
  remember(dir, '他说成功率只有 100% 才动手', 'c2c-1000000001', ['--kind', 'procedural', '--pin'])
  remember(dir, '随便一条跟他没关系的闲聊内容', 'c2c-1000000001', ['--kind', 'episodic'])

  memctl(dir, 'done', '--match', '100%')
  const rows = dump(dir)

  assert.equal(rows.find(r => r.text.includes('100%')).retired, 1)
  assert.equal(rows.find(r => r.text.includes('闲聊')).retired, 0, '% 被当通配符会误伤整库，必须转义')
})

test('done 不带 --match / --id：明确报用法错误（退出码 2），不静默成功', { skip: SKIP }, () => {
  const dir = newMemoryDir()
  remember(dir, '下周三帮他把服务器迁移到新机器', 'c2c-1000000001', ['--kind', 'procedural', '--pin'])

  const r = runPy(dir, ['done'])
  assert.equal(r.status, 2, `应退出码 2，实际 ${r.status}`)
  assert.ok(String(r.stderr).includes('--match'), `stderr 应提示用法：${r.stderr}`)
  assert.equal(dump(dir).find(r2 => r2.text.includes('服务器迁移')).retired, 0, '报错时不能动库')
})
