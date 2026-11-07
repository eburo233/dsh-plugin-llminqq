// test/unit-memctl-v5-remember.test.mjs —— memctl remember 的 v5 镜像（2026-11-07）
//
// AGENTS.md 教机器人「明确记一件事」用 memctl remember。但它只写 v4 的 entries；
// engine=v5 之后读路径不看 v4 —— 机器人以为记住了，下一轮想不起来。
// 这是继 utterances / pruned / done 之后第四个「切引擎后静默失效的旧工作流」。
//
// 实现要点（测的就是这几条）：
//   · 镜像走 node 脚本（用 store 写，mem_fts 索引一定对）——不能在 python 里
//     直接 INSERT，否则是「存进去但搜不到」的记忆。
//   · 插件布局下 BASE/../.. 是 <pkg>/lib 而不是包根 —— 第一版就是这么静默
//     找不到脚本的，所以这里既要测成功，也要测「找不到脚本时留痕不报错」。
//   · v4 那条路必须照样成功（它仍是回滚目标），v5 失败不能连带失败。

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
const REMEMBER_SCRIPT = path.join(ROOT, 'scripts', 'memory-v5-remember.mjs')

function findPython () {
  for (const cmd of ['python3', 'python']) {
    const r = spawnSync(cmd, ['-c', 'import sqlite3;print(1)'], { encoding: 'utf8' })
    if (r.status === 0) return cmd
  }
  return null
}
const PY = findPython()
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'llminqq-memctl-v5rem-'))
const BASE_ENV = { ...process.env, PYTHONDONTWRITEBYTECODE: '1', MEMCTL_PROD: '', MEMCTL_PROD_DIR: '' }
const OPTS = PY ? {} : { skip: '没有可用的 python' }

const sqlite = (db, sql) => spawnSync('sqlite3', [db, sql], { encoding: 'utf8' })

/** 造隔离目录：memctl.py 副本 + 真 v4 库结构 + 复制来的 v5 库。 */
function newDir ({ withV5 = true } = {}) {
  const dir = fs.mkdtempSync(path.join(TMP, 'm-'))
  fs.copyFileSync(MEMCTL_SRC, path.join(dir, 'memctl.py'))
  // v4：用 memctl 自己的 connect 建表（最省事且结构一定正确）
  const r = spawnSync(PY, ['-c', [
    'import sys', 'sys.dont_write_bytecode = True',
    `sys.path.insert(0, ${JSON.stringify(dir)})`,
    'import memctl as m',
    `m.DB = ${JSON.stringify(path.join(dir, 'mem.db'))}`,
    `m.LOG_DIR = ${JSON.stringify(path.join(dir, 'log'))}`,
    `m.CURSOR = ${JSON.stringify(path.join(dir, '.ingest_cursor'))}`,
    'con = m.connect(m.DB); con.commit()',
  ].join('\n')], { encoding: 'utf8', env: BASE_ENV })
  assert.equal(r.status, 0, `建 v4 库失败：${r.stderr}`)
  if (withV5) {
    const s = spawnSync(process.execPath, ['-e', `
      const { openV5 } = await import(${JSON.stringify('file://' + path.join(ROOT, 'lib', 'agent', 'memory-v5', 'store.mjs'))});
      const st = openV5({ dbPath: ${JSON.stringify(path.join(dir, 'mem-v5.db'))} });
      st.close();
    `, '--input-type=module'], { encoding: 'utf8' })
    assert.equal(s.status, 0, `建 v5 库失败：${s.stderr}`)
  }
  return dir
}

/** 跑 run.py 的 memctl（这样路径常量才会被指到临时目录）。 */
function runRunPy (dir, args, extraEnv = {}) {
  return spawnSync(PY, [path.join(ROOT, 'lib', 'agent', 'memory', 'run.py'), 'memctl', ...args], {
    encoding: 'utf8', timeout: 120000,
    env: { ...BASE_ENV, LLMINQQ_STATE_DIR: dir, ...extraEnv },
  })
}
const v5Rows = (dir, like) => {
  const r = sqlite(path.join(dir, 'mem-v5.db'), `select count(*) from memories where text like '%${like}%';`)
  return Number(r.stdout.trim())
}

test('memctl remember：v4 和 v5 都要写（engine=v5 时只写 v4 等于没记住）', OPTIONS => {
  if (!PY) return OPTIONS.skip('没有 python')
  const dir = newDir()
  const r = runRunPy(dir, ['remember', '记住：下周三帮他把服务器迁移到新机器', '--peer', 'c2c-3022464706', '--pin'])
  assert.equal(r.status, 0, `remember 失败：${r.stderr}`)
  assert.equal(v5Rows(dir, '服务器迁移到新机器'), 1, 'v5 里必须有这条（否则 v5 检索永远找不到它）')
  // v4 必须也写了（回滚目标）
  const v4 = sqlite(path.join(dir, 'mem.db'), "select count(*) from entries where text like '%服务器迁移到新机器%';")
  assert.equal(Number(v4.stdout.trim()), 1, 'v4 那条也要写（它仍是回滚目标）')
})

test('memctl remember：v5 里能真的被 FTS 检索到（不是「存进去搜不到」）', OPTIONS => {
  if (!PY) return OPTIONS.skip('没有 python')
  const dir = newDir()
  runRunPy(dir, ['remember', '记住：下周三帮他把服务器迁移到新机器', '--peer', 'c2c-3022464706'])
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { openV5 } = await import(${JSON.stringify('file://' + path.join(ROOT, 'lib', 'agent', 'memory-v5', 'store.mjs'))});
    const st = openV5({ dbPath: ${JSON.stringify(path.join(dir, 'mem-v5.db'))} });
    const rows = st.searchFts({ query: '服务器迁移', limit: 5 });
    console.log(JSON.stringify(rows.map(r => r.text)));
    st.close();
  `], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const texts = JSON.parse(r.stdout.trim().split('\n').pop())
  assert.ok(texts.some(t => t.includes('服务器迁移到新机器')),
    `FTS 搜不到刚记住的内容 = 索引没写（实际命中：${JSON.stringify(texts)}）`)
})

test('memctl remember：幂等 —— 重复记同一句不会插两条', OPTIONS => {
  if (!PY) return OPTIONS.skip('没有 python')
  const dir = newDir()
  const args = ['remember', '记住：下周三迁移服务器', '--peer', 'c2c-3022464706']
  runRunPy(dir, args)
  runRunPy(dir, args)
  assert.equal(v5Rows(dir, '下周三迁移服务器'), 1, '重复 remember 不该插两条')
})

test('memctl remember：pin → v5 salience 0.9；peer → conv/subject 正确转换', OPTIONS => {
  if (!PY) return OPTIONS.skip('没有 python')
  const dir = newDir()
  runRunPy(dir, ['remember', '记住：他喜欢喝冰美式', '--peer', 'c2c-3022464706', '--pin'])
  const out = sqlite(path.join(dir, 'mem-v5.db'),
    "select subject, conv, salience from memories where text like '%他喜欢喝冰美式%';").stdout.trim()
  assert.match(out, /3022464706/, 'subject 应从 c2c-<QQ> 取到 QQ 号')
  assert.match(out, /c2c:3022464706/, 'conv 应把 c2c- 转成 c2c:')
  assert.match(out, /0\.9/, 'pin 对应 salience 0.9（v5 没有 pinned 列，钉住=抬 salience）')
})

test('memctl remember：没有 v5 库时只写 v4 且成功（回滚到 v4 的机器也要能用）', OPTIONS => {
  if (!PY) return OPTIONS.skip('没有 python')
  const dir = newDir({ withV5: false })
  const r = runRunPy(dir, ['remember', '记住：没有 v5 库也能记', '--peer', 'c2c-10001'])
  assert.equal(r.status, 0, `没有 v5 库时 remember 不该失败：${r.stderr}`)
  const v4 = sqlite(path.join(dir, 'mem.db'), "select count(*) from entries where text like '%没有 v5 库也能记%';")
  assert.equal(Number(v4.stdout.trim()), 1, 'v4 必须照常写入')
})

test('memctl remember：v5 写失败不能让 v4 的 remember 失败', OPTIONS => {
  if (!PY) return OPTIONS.skip('没有 python')
  const dir = newDir()
  // 让镜像脚本以失败退出：把脚本换成一个必然报错的桩
  const broken = path.join(dir, 'scripts')
  fs.mkdirSync(broken, { recursive: true })
  // 指向临时目录的桩不可行（脚本路径由 memctl 推导），改测 NODE_BIN 指向不存在的二进制
  const r = runRunPy(dir, ['remember', '记住：镜像炸了也要能记', '--peer', 'c2c-10001'], { NODE_BIN: '/nonexistent/node-binary' })
  assert.equal(r.status, 0, 'v5 镜像失败时 v4 的 remember 仍必须成功')
  const v4 = sqlite(path.join(dir, 'mem.db'), "select count(*) from entries where text like '%镜像炸了也要能记%';")
  assert.equal(Number(v4.stdout.trim()), 1, 'v4 写入不受影响')
})

test('镜像脚本本身：FTS 索引由 store 维护（不依赖调用方）', OPTIONS => {
  if (!PY) return OPTIONS.skip('没有 python')
  const dir = newDir()
  const r = spawnSync(process.execPath, [REMEMBER_SCRIPT, '--text', '镜像脚本直接写入测试', '--type', 'fact',
    '--data-dir', dir, '--json'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout.trim())
  assert.equal(out.ok, true)
  assert.ok(out.id > 0)
  // ⚠️ mem_fts 是 **contentless** FTS5（DDL 里 tok 不落盘），所以
  //   `select tok from mem_fts` 永远是 NULL —— 只能验「MATCH 能命中」。
  //   第一版就是拿 select ... where tok like 验的，必然假红。
  const fts = sqlite(path.join(dir, 'mem-v5.db'),
    "select count(*) from mem_fts where mem_fts match '镜像';")
  assert.ok(Number(fts.stdout.trim()) > 0, 'mem_fts 必须能用 MATCH 命中这条（否则搜不到）')
})
