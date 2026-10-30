// test/unit-bili-python.test.mjs —— bili venv python 的候选根推导（纯函数）
//
// 背景：bili-python.mjs 以前把 `D:/dsh-home`、`C:/dsh-home` 写死成回退根。
// 换台机器这两个目录根本不存在，于是「找不到 bili-duty 的 python」——
// 用户按提示装依赖也修不好，因为找的地方从一开始就不对。
// 现在候选根按优先级推导（LLMINQQ_DATA_DIR → DSH_HOME → dataDir() → ~/.dsh），
// 旧的硬编码根只在**真实存在**时兜底。
//
// 这些用例只测纯函数（注入 homedir/exists/dataDirPath），不依赖本机布局。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const M = await import(pathToFileURL(path.join(ROOT, 'lib', 'agent', 'bili-python.mjs')).href)
const { biliRoots, resolveBiliPython, VENV_PYTHON_REL } = M

const LEGACY_D = path.resolve('D:/dsh-home')
const LEGACY_C = path.resolve('C:/dsh-home')

test('旧硬编码根不存在时不会成为候选（不会返回 D:/dsh-home）', () => {
  const roots = biliRoots({}, {
    homedir: 'C:/Users/llminqq-test',
    exists: () => false,
    dataDirPath: 'C:/Users/llminqq-test/.dsh/dsh-plugin-llminqq',
  })
  assert.ok(!roots.includes(LEGACY_D), `不应包含 ${LEGACY_D}: ${JSON.stringify(roots)}`)
  assert.ok(!roots.includes(LEGACY_C), `不应包含 ${LEGACY_C}: ${JSON.stringify(roots)}`)
})

test('LLMINQQ_DATA_DIR / DSH_HOME 环境变量覆盖生效且优先', () => {
  const roots = biliRoots(
    { LLMINQQ_DATA_DIR: 'X:/data-custom', DSH_HOME: 'Y:/dsh-home-custom' },
    { homedir: 'Z:/home', exists: () => false, dataDirPath: 'Z:/home/.dsh/dsh-plugin-llminqq' },
  )
  assert.equal(roots[0], path.resolve('X:/data-custom'), 'LLMINQQ_DATA_DIR 应是第一优先级')
  assert.ok(roots.includes(path.resolve('Y:/dsh-home-custom')))
  assert.ok(roots.includes(path.resolve('Y:/dsh-home-custom/dsh-plugin-llminqq')))
  // 插件数据目录约定（lib/store.js dataDir() 的结果）
  assert.ok(roots.includes(path.resolve('Z:/home/.dsh/dsh-plugin-llminqq')))
  // 老布局 ~/.dsh 仍然在
  assert.ok(roots.includes(path.resolve('Z:/home/.dsh')))
})

test('旧硬编码根真实存在时才作为最后兜底', () => {
  const exists = p => path.resolve(p) === LEGACY_D
  const roots = biliRoots({}, {
    homedir: 'C:/Users/llminqq-test',
    exists,
    dataDirPath: 'C:/Users/llminqq-test/.dsh/dsh-plugin-llminqq',
  })
  assert.equal(roots.at(-1), LEGACY_D, '存在的旧根应排在最后（最低优先级）')
  assert.ok(!roots.includes(LEGACY_C), '不存在的旧根不该混进来')
})

test('候选根去重（DSH_HOME 与 dataDir 推导结果重叠时）', () => {
  const roots = biliRoots(
    { DSH_HOME: 'C:/Users/u/.dsh' },
    { homedir: 'C:/Users/u', exists: () => false, dataDirPath: 'C:/Users/u/.dsh/dsh-plugin-llminqq' },
  )
  assert.equal(new Set(roots).size, roots.length, `候选根有重复: ${JSON.stringify(roots)}`)
})

test('venv python 相对路径按平台（Windows Scripts/python.exe，Unix bin/python）', () => {
  assert.ok(VENV_PYTHON_REL.includes('Scripts/python.exe'))
  assert.ok(VENV_PYTHON_REL.includes('bin/python'))
  if (process.platform === 'win32') {
    assert.equal(VENV_PYTHON_REL[0], 'Scripts/python.exe')
  } else {
    assert.equal(VENV_PYTHON_REL[0], 'bin/python')
  }
})

test('显式配置 learning.crawlPython 优先，且能反推 bili-duty 根', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llminqq-bilipy-'))
  try {
    // 用当前平台对应的相对布局建一个假 python
    const rel = VENV_PYTHON_REL[0]
    const bin = path.join(dir, 'bili-duty', '.venv', ...rel.split('/'))
    fs.mkdirSync(path.dirname(bin), { recursive: true })
    fs.writeFileSync(bin, '')
    const r = resolveBiliPython({ learning: { crawlPython: bin } })
    assert.equal(r.bin, bin)
    assert.equal(r.root, path.join(dir, 'bili-duty'))
    assert.deepEqual(r.tried, [bin])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
