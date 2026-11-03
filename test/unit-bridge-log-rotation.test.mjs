// test/unit-bridge-log-rotation.test.mjs —— P0-6(B)：日志轮转后 ingest 从行中间读
//
// 背景（docs/MEMORY-AUDIT-AND-V5.md §2 P0-6(B)）：
//   `memctl ingest` 用字节游标 `<stateDir>/.ingest_cursor` 记「读到哪」。
//   我们会轮转 bridge.out（8MB → bridge.out.1 + 新建空文件），而 python 那边的
//   兜底只有 `if size < offset: offset = 0`。问题在于**新文件会继续增长**：
//   一旦新文件比旧游标大，兜底不成立，它就从新文件的第 offset 字节开始读 ——
//   也就是从**某一行中间**，静默跳过前面一大段。
//
//   审计文档里的自证：旧文件 7090 字节、游标 7090，轮转后新文件长到 7290：
//     size(7290) >= offset(7090) → 兜底不触发 → seek 落在 `b'.000Z å¥ç« c2c:1 ...'`
//
// 修法在 lib/index.js：轮转后**归零游标**（老格式：纯十进制文本，python 读法不变），
// 另外写一份 inode/size 指纹，起桥时做一次自愈检查（覆盖「别人轮转过」「日志被
// 手工截断」这些我们没有参与的情况）。
//
// 这些测试全部在 os.tmpdir() 里造日志和状态目录，不碰真实 ~/.dsh。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

// import 插件模块会连带加载 store/napcat/pyprobe 等一串子模块。
// 按 CONTRIBUTING §9 把 HOME/DSH_HOME 引到临时目录再 import。
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'llminqq-rotate-'))
process.env.HOME = TMP_HOME
process.env.USERPROFILE = TMP_HOME
process.env.DSH_HOME = path.join(TMP_HOME, '.dsh')
const M = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)
test.after(() => { try { fs.rmSync(TMP_HOME, { recursive: true, force: true }) } catch { /* ignore */ } })

function mkFixture () {
  const dir = fs.mkdtempSync(path.join(TMP_HOME, 'case-'))
  const stateDir = path.join(dir, 'agent', 'memory')
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })  // 记忆目录存在 = 可以写游标
  const logFile = path.join(dir, 'logs', 'bridge.out')
  fs.mkdirSync(path.dirname(logFile), { recursive: true })
  return { dir, stateDir, logFile, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

/** python 读游标的语义（memctl.py:1004-1011 + seek）：游标是**字节**偏移。 */
function readFromCursor (logFile, stateDir) {
  const cursorPath = path.join(stateDir, '.ingest_cursor')
  let offset = 0
  if (fs.existsSync(cursorPath)) {
    offset = Number(String(fs.readFileSync(cursorPath, 'utf8')).trim() || 0) || 0
  }
  const size = fs.statSync(logFile).size
  if (size < offset) offset = 0            // python 现有的唯一兜底
  const buf = fs.readFileSync(logFile)
  return buf.subarray(offset).toString('utf8')
}

const writeCursor = (stateDir, n) => fs.writeFileSync(path.join(stateDir, '.ingest_cursor'), String(n))
const readCursor = (stateDir) => String(fs.readFileSync(path.join(stateDir, '.ingest_cursor'), 'utf8')).trim()
const meta = (stateDir) => JSON.parse(fs.readFileSync(path.join(stateDir, '.ingest_cursor.meta'), 'utf8'))

test('没超上限：不轮转、游标不动（绝大多数启动走这条）', () => {
  const f = mkFixture()
  try {
    fs.writeFileSync(f.logFile, 'OLD-1\nOLD-2\n')
    writeCursor(f.stateDir, 12)
    const r = M.rotateBridgeLogIfNeeded({ logFile: f.logFile, stateDir: f.stateDir })
    assert.equal(r.rotated, false)
    assert.equal(fs.existsSync(`${f.logFile}.1`), false, '没超上限不该产生 .1')
    assert.equal(readCursor(f.stateDir), '12', '没轮转不该动游标')
  } finally { f.cleanup() }
})

test('日志不存在：不轮转、不报错（首次启动）', () => {
  const f = mkFixture()
  try {
    const r = M.rotateBridgeLogIfNeeded({ logFile: f.logFile, stateDir: f.stateDir })
    assert.equal(r.rotated, false)
    assert.match(r.reason, /不存在/)
    assert.equal(fs.existsSync(path.join(f.stateDir, '.ingest_cursor')), false, '不该凭空造游标')
  } finally { f.cleanup() }
})

test('超上限：轮转成 .1，并把 ingest 游标归零（老格式：纯十进制文本）', () => {
  const f = mkFixture()
  try {
    const old = Array.from({ length: 2000 }, (_, i) => `OLD-${i}\n`).join('')
    fs.writeFileSync(f.logFile, old)
    writeCursor(f.stateDir, old.length)          // ingest 刚好吃完
    const r = M.rotateBridgeLogIfNeeded({ logFile: f.logFile, stateDir: f.stateDir, maxBytes: 1024 })
    assert.equal(r.rotated, true, '超上限必须轮转')
    assert.equal(r.oldSize, old.length)
    assert.equal(r.cursorReset, true, '轮转后必须归零游标，否则下次从行中间读')

    // .1 是完整旧日志，新日志从空开始（轮转时就建出来了，好让指纹能记 inode）
    assert.equal(fs.readFileSync(`${f.logFile}.1`, 'utf8'), old)
    assert.equal(fs.statSync(f.logFile).size, 0, '轮转后新日志应该是空的')

    // 游标必须是**老格式**（python 直接 int() 读），否则跨版本会炸
    assert.equal(readCursor(f.stateDir), '0')
    assert.match(readCursor(f.stateDir), /^\d+$/)

    // 指纹：给「下一次启动的自愈检查」看，python 不读也没关系
    const m2 = meta(f.stateDir)
    assert.match(String(m2.reason), /轮转/)
    assert.equal(m2.size, 0)
    if (process.platform !== 'win32') {
      assert.ok(Number(m2.ino) > 0, `指纹里必须记下新文件 inode（实际 ${m2.ino}）—— 否则「文件被换过」检测不出来`)
      assert.equal(Number(m2.ino), Number(fs.statSync(f.logFile).ino))
    }
  } finally { f.cleanup() }
})

test('【核心症状】轮转后新文件长得比旧游标还大 —— 归零才能从行首读', () => {
  const f = mkFixture()
  try {
    // ① 旧日志 + 游标停在末尾（= 已经吃完）
    const old = Array.from({ length: 700 }, (_, i) => `OLD-${i}\n`).join('')
    fs.writeFileSync(f.logFile, old)
    const oldCursor = old.length
    writeCursor(f.stateDir, oldCursor)

    // ② 轮转（模拟 startBridge 的那一步）
    M.rotateBridgeLogIfNeeded({ logFile: f.logFile, stateDir: f.stateDir, maxBytes: 1024 })

    // ③ 新文件继续增长，且**比旧游标大** —— 这正是 doc 里 7090 → 7290 的场景
    const after = Array.from({ length: 1100 }, (_, i) => `AFTER-${i}\n`).join('')
    fs.writeFileSync(f.logFile, after)
    assert.ok(fs.statSync(f.logFile).size > oldCursor,
      '前置：新文件必须比旧游标大，否则 python 的 size<offset 兜底会替我们兜住，测不出问题')

    const got = readFromCursor(f.logFile, f.stateDir)
    // 修复前：会从第 oldCursor 字节开始，第一行是半截（可能以数字/换行开头）
    assert.ok(got.startsWith('AFTER-0\n'),
      `游标没有归零 → 从行中间读，丢了新消息的开头：${JSON.stringify(got.slice(0, 40))}`)
    assert.ok(got.split('\n')[0] === 'AFTER-0', '第一行必须是完整的一行')
  } finally { f.cleanup() }
})

test('guardIngestCursor：游标大于日志大小 → 归零（日志被截断/换过）', () => {
  const f = mkFixture()
  try {
    fs.writeFileSync(f.logFile, 'x'.repeat(100))
    writeCursor(f.stateDir, 9999)
    const g = M.guardIngestCursor({ stateDir: f.stateDir, logFile: f.logFile })
    assert.equal(g.reset, true)
    assert.match(g.reason, /截断/)
    assert.equal(readCursor(f.stateDir), '0')
  } finally { f.cleanup() }
})

test('guardIngestCursor：正常追加时绝不动游标（否则每轮重读整份日志）', () => {
  const f = mkFixture()
  try {
    fs.writeFileSync(f.logFile, 'line1\nline2\n')
    writeCursor(f.stateDir, 12)
    const g1 = M.guardIngestCursor({ stateDir: f.stateDir, logFile: f.logFile })
    assert.equal(g1.reset, false)
    assert.equal(readCursor(f.stateDir), '12', '正常追加时游标被改了 —— 会重读、白烧 IO')

    fs.appendFileSync(f.logFile, 'line3\n')
    const g2 = M.guardIngestCursor({ stateDir: f.stateDir, logFile: f.logFile })
    assert.equal(g2.reset, false, '追加了几行也还是「正常追加」')
    assert.equal(readCursor(f.stateDir), '12')
  } finally { f.cleanup() }
})

test('guardIngestCursor：没有游标 / 坏游标 → 不抛错、不瞎写', () => {
  const f = mkFixture()
  try {
    fs.writeFileSync(f.logFile, 'abc\n')
    const g1 = M.guardIngestCursor({ stateDir: f.stateDir, logFile: f.logFile })
    assert.equal(g1.reset, false)
    assert.equal(g1.cursor, null)
    assert.equal(fs.existsSync(path.join(f.stateDir, '.ingest_cursor')), false)

    // 坏内容（手工改坏 / 半截写）：当成「没有游标」，不清零也不炸
    fs.writeFileSync(path.join(f.stateDir, '.ingest_cursor'), 'not-a-number')
    const g2 = M.guardIngestCursor({ stateDir: f.stateDir, logFile: f.logFile })
    assert.equal(g2.reset, false)
    assert.equal(readCursor(f.stateDir), 'not-a-number', '坏内容不该被顺手覆盖（先保留现场）')
  } finally { f.cleanup() }
})

test('guardIngestCursor：日志 inode 变了（别人轮转过）→ 归零',
  { skip: process.platform === 'win32' ? 'Windows 上 stat.ino 恒为 0，本项目按大小兜底' : false },
  () => {
    const f = mkFixture()
    try {
      fs.writeFileSync(f.logFile, 'NEW-A\nNEW-B-longer\n')
      writeCursor(f.stateDir, 3)
      // ⚠️ 不能靠「unlink 再 create」去制造不同 inode：实测 overlayfs/tmpfs 会
      //    **立刻复用刚释放的 inode**（本机 ino1 === ino2），那样的测试是假绿的。
      //    这里直接伪造一份「上一次轮转记的 inode」，精确地打这条判据。
      const realIno = Number(fs.statSync(f.logFile).ino)
      fs.writeFileSync(path.join(f.stateDir, '.ingest_cursor.meta'), JSON.stringify({
        at: Date.now(), reason: '上一次轮转', log: f.logFile, size: 0, ino: realIno + 1,
      }, null, 2))
      const g = M.guardIngestCursor({ stateDir: f.stateDir, logFile: f.logFile })
      assert.equal(g.reset, true, 'inode 变了必须归零（新文件里的 offset 没有意义）')
      assert.match(g.reason, /inode/)
      assert.equal(readCursor(f.stateDir), '0')
      // 归零后指纹也更新成**当前**文件，下一轮不会反复归零
      const m2 = meta(f.stateDir)
      assert.equal(Number(m2.ino), realIno, '归零后要把指纹更新成当前 inode，否则每次启动都误判')
      const g2 = M.guardIngestCursor({ stateDir: f.stateDir, logFile: f.logFile })
      assert.equal(g2.reset, false, '第二次检查不该再归零（否则每轮都重读日志）')
    } finally { f.cleanup() }
  })

test('游标写入是原子的：不留 .tmp 残留', () => {
  const f = mkFixture()
  try {
    fs.writeFileSync(f.logFile, 'x'.repeat(2000))
    writeCursor(f.stateDir, 100)
    M.rotateBridgeLogIfNeeded({ logFile: f.logFile, stateDir: f.stateDir, maxBytes: 10 })
    const leftovers = fs.readdirSync(f.stateDir).filter(n => n.includes('.tmp-'))
    assert.deepEqual(leftovers, [], `残留临时文件：${leftovers}`)
  } finally { f.cleanup() }
})

test('记忆目录不存在时不写游标（不凭空造目录）', () => {
  const f = mkFixture()
  try {
    fs.writeFileSync(f.logFile, 'x'.repeat(2000))
    const missing = path.join(f.dir, '不存在的记忆目录')
    const r = M.rotateBridgeLogIfNeeded({ logFile: f.logFile, stateDir: missing, maxBytes: 10 })
    assert.equal(r.rotated, true, '日志还是要轮转')
    assert.equal(r.cursorReset, false, '目录不存在就没法归零，要如实报告')
    assert.equal(fs.existsSync(missing), false, '不该顺手把目录建出来')
  } finally { f.cleanup() }
})

test('源码级：startBridge 走的是 rotateBridgeLogIfNeeded，不是内联 rename', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'index.js'), 'utf8')
  const start = src.indexOf('async function startBridge')
  const region = src.slice(start, start + 6000)
  assert.match(region, /rotateBridgeLogIfNeeded\(/, 'startBridge 没调轮转函数 —— 游标又不会归零了')
  assert.match(region, /guardIngestCursor\(/, 'startBridge 没做游标自愈检查')
  assert.doesNotMatch(region, /fs\.renameSync\(logFile, old\)/,
    'startBridge 里还留着内联 rename（那条不会归零游标，就是 P0-6(B) 的现场）')
})
