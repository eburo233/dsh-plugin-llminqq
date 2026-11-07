// test/unit-memctl-v5-done.test.mjs —— memctl done 的 v5 镜像（2026-11-07）
//
// 为什么需要：AGENTS.md §11 教机器人「待办完成就跑 memctl done --match …」。
// 但 done 只改 v4 的 mem.db；engine=v5 之后**读路径根本不看 v4** ——
// 于是 v5 里的 commitment 永远 active，机器人一直以为自己还欠着事，
// 而它明明执行过 done、也收到了成功输出。又一个「切引擎后静默失效的旧工作流」。
//
// 这一组锁住：dry-run 不写、真跑归档成 done、幂等、没有 v5 库时不炸、
// v4 没命中但 v5 有时也要处理（这条最容易被漏 —— 两条库的内容不保证一致）。
//
// 和 unit-memctl-pin 同一套做法：把 memctl.py 拷到临时目录跑真脚本，
// 它的 BASE 由自身位置推导，于是 mem.db / mem-v5.db 全落在临时目录，不碰生产。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const MEMCTL_SRC = path.join(ROOT, 'lib', 'agent', 'memory', 'memctl.py')

/** 找一个能跑的 python（找不到就整组 skip）。 */
function findPython () {
  for (const cand of [['python3'], ['python']]) {
    const r = spawnSync(cand[0], ['-c', 'import sqlite3;print(1)'], { encoding: 'utf8' })
    if (r.status === 0) return { bin: cand[0], preArgs: cand.slice(1) }
  }
  return null
}
const probe = findPython()
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'llminqq-memctl-v5done-'))
const OPTS = probe ? {} : { skip: '没有可用的 python（无法跑 memctl.py）' }

const BASE_ENV = { ...process.env, PYTHONDONTWRITEBYTECODE: '1', MEMCTL_PROD: '', MEMCTL_PROD_DIR: '' }

function newDir () {
  const dir = fs.mkdtempSync(path.join(TMP, 'm-'))
  fs.copyFileSync(MEMCTL_SRC, path.join(dir, 'memctl.py'))
  return dir
}
function runPy (dir, args) {
  return spawnSync(probe.bin, [...(probe.preArgs || []), path.join(dir, 'memctl.py'), ...args], {
    encoding: 'utf8', timeout: 120000, env: BASE_ENV, cwd: dir,
  })
}
function py (dir, body) {
  const prelude = [
    'import sys',
    'sys.dont_write_bytecode = True',
    `sys.path.insert(0, ${JSON.stringify(dir)})`,
    'import memctl as m',
    `m.DB = ${JSON.stringify(path.join(dir, 'mem.db'))}`,
    `m.LOG_DIR = ${JSON.stringify(path.join(dir, 'log'))}`,
    `m.CURSOR = ${JSON.stringify(path.join(dir, '.ingest_cursor'))}`,
  ].join('\n')
  const r = spawnSync(probe.bin, [...(probe.preArgs || []), '-c', prelude + '\n' + body], {
    encoding: 'utf8', timeout: 120000, env: BASE_ENV, cwd: dir,
  })
  assert.equal(r.status, 0, `临时 python 片段失败：\n${r.stderr || r.stdout}`)
  return r.stdout
}

/** 在临时目录里造一个最小 v5 库（只建本功能用到的列 + 一条待办）。 */
function mkV5 (dir, { rows = [{ text: '他让我把服务器迁移这件事盯着', conv: 'c2c:10001', state: 'active' }] } = {}) {
  const p = path.join(dir, 'mem-v5.db')
  const con = spawnSync(probe.bin, [...(probe.preArgs || []), '-c', `
import sqlite3
c = sqlite3.connect(${JSON.stringify(p)})
c.execute("CREATE TABLE memories (id INTEGER PRIMARY KEY, type TEXT, subject TEXT, conv TEXT, text TEXT, state TEXT, archived_reason TEXT)")
for t, conv, st in ${JSON.stringify(rows.map(r => [r.text, r.conv, r.state]))}:
    c.execute("INSERT INTO memories(type, conv, text, state) VALUES ('commitment', ?, ?, ?)", (conv, t, st))
c.commit(); c.close()
`], { encoding: 'utf8', timeout: 120000, env: BASE_ENV })
  assert.equal(con.status, 0, `造 v5 库失败：${con.stderr}`)
  return p
}
function v5Rows (dir) {
  const out = spawnSync(probe.bin, [...(probe.preArgs || []), '-c', `
import sqlite3, json
c = sqlite3.connect(${JSON.stringify(path.join(dir, 'mem-v5.db'))})
print(json.dumps([dict(zip([d[0] for d in c.execute("select * from memories limit 1").description], r)) for r in []]) if False else json.dumps(
  [ {"id": r[0], "state": r[1], "reason": r[2]} for r in c.execute("SELECT id, state, archived_reason FROM memories ORDER BY id") ]))
`], { encoding: 'utf8', timeout: 120000, env: BASE_ENV })
  assert.equal(out.status, 0, `读 v5 库失败：${out.stderr}`)
  return JSON.parse(out.stdout.trim().split('\n').pop())
}

test('done --match：dry-run 不写 v5 库，只报告命中', OPTIONS => {
  if (!probe) return OPTIONS.skip('没有 python')
  const dir = newDir()
  mkV5(dir)
  const r = runPy(dir, ['done', '--match', '服务器迁移', '--dry-run'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /v5 镜像：将归档 1 条/, `输出里应报告 v5 镜像（实际：${r.stdout}）`)
  assert.equal(v5Rows(dir)[0].state, 'active', 'dry-run 绝不能写库')
})

test('done --match：真跑把 v5 里命中的记忆归档成 done', OPTIONS => {
  if (!probe) return OPTIONS.skip('没有 python')
  const dir = newDir()
  mkV5(dir)
  const r = runPy(dir, ['done', '--match', '服务器迁移'])
  assert.equal(r.status, 0, r.stderr)
  const rows = v5Rows(dir)
  assert.equal(rows[0].state, 'archived', 'v5 里那条待办必须被归档')
  assert.equal(rows[0].reason, 'done', "归档原因必须是 'done'（不是 pruned/expired）")
})

test('done --match：幂等 —— 第二次不重复归档', OPTIONS => {
  if (!probe) return OPTIONS.skip('没有 python')
  const dir = newDir()
  mkV5(dir)
  assert.equal(runPy(dir, ['done', '--match', '服务器迁移']).status, 0)
  const r2 = runPy(dir, ['done', '--match', '服务器迁移'])
  assert.equal(r2.status, 0)
  // 第二次已无 active 命中，不该再报「已归档」
  assert.doesNotMatch(r2.stdout, /v5 镜像：已归档 [1-9]/, `第二次不该再归档（实际：${r2.stdout}）`)
})

test('v4 没命中但 v5 有命中 → 仍要处理（两条库内容不保证一致）', OPTIONS => {
  if (!probe) return OPTIONS.skip('没有 python')
  const dir = newDir()
  // 故意不建 v4 的 entries 表内容：v4 命中 0 条
  py(dir, 'con = m.connect(m.DB); con.commit()')
  mkV5(dir, { rows: [{ text: '服务器迁移这事我来盯', conv: 'c2c:10001', state: 'active' }] })
  const r = runPy(dir, ['done', '--match', '服务器迁移'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /v5 镜像：已归档 1 条/, 'v4 没命中不代表 v5 没命中 —— 这里最容易漏')
  assert.equal(v5Rows(dir)[0].state, 'archived')
})

test('没有 v5 库时静默跳过（不报错、不影响 v4 的 done）', OPTIONS => {
  if (!probe) return OPTIONS.skip('没有 python')
  const dir = newDir()
  py(dir, 'con = m.connect(m.DB); con.commit()')
  const r = runPy(dir, ['done', '--match', '服务器迁移'])
  assert.equal(r.status, 0, `没有 mem-v5.db 时不该失败：${r.stderr}`)
  assert.doesNotMatch(r.stdout, /v5 镜像/, '没有 v5 库时不该报镜像结果')
})

test('--peer 只处理对应会话的 v5 记忆（c2c-xxx → c2c:xxx）', OPTIONS => {
  if (!probe) return OPTIONS.skip('没有 python')
  const dir = newDir()
  py(dir, 'con = m.connect(m.DB); con.commit()')
  mkV5(dir, {
    rows: [
      { text: '服务器迁移 私聊那条', conv: 'c2c:10001', state: 'active' },
      { text: '服务器迁移 群聊那条', conv: 'group:20002', state: 'active' },
    ],
  })
  const r = runPy(dir, ['done', '--match', '服务器迁移', '--peer', 'c2c-10001'])
  assert.equal(r.status, 0, r.stderr)
  const rows = v5Rows(dir)
  assert.equal(rows[0].state, 'archived', 'c2c 那条应被归档')
  assert.equal(rows[1].state, 'active', '群聊那条不该被 --peer c2c 连带归档')
})
