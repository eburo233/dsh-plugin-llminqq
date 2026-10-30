// 设置页记忆管理（P4）测试：统计 / 清除安全 / 导出导入 roundtrip
// 运行：node test/plugin-admin.test.mjs
//
// 为什么测试库是**现场生成的合成库**，而不是读主仓库那份 844 条真实库：
//   那份库只存在于作者那台机器（/home/<user>/...），任何别的机器/CI 都没有。
//   原来硬编码它的路径 → 在别的机器上直接 ENOENT 崩掉（连 skip 都来不及）。
//   现在用 python sqlite3 按 lib/agent/memory/memctl.py 的 schema 现造一份
//   结构等价的合成库（条数固定为夹具常量），被测的 SQL / 清除 / 导入逻辑一字不改。
//
// 环境缺失时**跳过而不是失败**：没有 python（或 python 里没有 sqlite3）时，
// A~E 中依赖真库的段整段 skip，F/G 照常跑；导出/临时文件只落 os.tmpdir()。
//
// 为什么这个测试的重点是「清除的安全」：
//   统计和导出是只读的，错了最多显示难看；
//   而**清除是不可逆操作** —— 误删一份攒了几个月的记忆，用户没有第二份。
//   所以本文件对「没有确认不能清」的验证是逐条硬断言，不是「前端拦住了」就算。
//   另外还验「清除前会自动备份」和「导入前会备份」，因为这两条是最后的安全网。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

// 本文件在 dsh-plugin-llminqq/test/：PKG = 上一级（包根）
const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-admin-'))
const REAL_STATE = path.join(os.homedir(), '.dsh', 'llminqq')
const REAL_STATE_SNAP = fs.existsSync(REAL_STATE)
  ? { mtimeMs: fs.statSync(REAL_STATE).mtimeMs }
  : null

let pass = 0
let fail = 0
let skipCount = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}
const skip = (name, reason = '') => {
  skipCount++
  console.log(`  ○ 跳过 ${name}${reason ? ` — ${reason}` : ''}`)
}

// ESM 动态 import 在 Windows 上必须用 file:// URL：
//   `await import(path.join(...))` 在 Windows 抛 ERR_UNSUPPORTED_ESM_URL_SCHEME。
const { probePython } = await import(pathToFileURL(path.join(PKG, 'lib/pyprobe.mjs')).href)
const admin = await import(pathToFileURL(path.join(PKG, 'lib/agent/memory-admin.mjs')).href)
const probe = probePython({ log: () => {} })
console.log(`\npython: ${probe.ok ? `${probe.bin} ${probe.version}` : probe.reason}`)

// ─────────────────────────────────────────────────────────────────────────────
// 合成夹具：条数/分布都来自这里，断言不写死魔数
// ─────────────────────────────────────────────────────────────────────────────
const FIXTURE = Object.freeze({
  total: 300,
  alive: 260,          // 其中 40 条 retired=1（归档），用来验「有效 < 总数」
  owners: ['10001', '10002', '10003'],
  kinds: ['procedural', 'semantic', 'episodic'],
})

const FIXTURE_PY = `
import json, sqlite3, sys

db = sys.argv[1]
cfg = json.loads(sys.argv[2])
total = cfg['total']
alive = cfg['alive']
owners = cfg['owners']
kinds = cfg['kinds']
vis = ['dm_only', 'group', 'public']

c = sqlite3.connect(db)
c.executescript('''
CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    peer TEXT NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    fp TEXT NOT NULL,
    importance REAL NOT NULL DEFAULT 0.5,
    strength REAL NOT NULL DEFAULT 1.0,
    pinned INTEGER NOT NULL DEFAULT 0,
    hits INTEGER NOT NULL DEFAULT 1,
    created REAL NOT NULL,
    last_seen REAL NOT NULL,
    retired INTEGER NOT NULL DEFAULT 0,
    reflected INTEGER NOT NULL DEFAULT 0,
    owner TEXT,
    visibility TEXT,
    is_self INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_peer ON entries(peer);
CREATE INDEX IF NOT EXISTS idx_kind ON entries(kind);
CREATE INDEX IF NOT EXISTS idx_owner ON entries(owner);
''')

rows = []
for i in range(total):
    retired = 0 if i < alive else 1
    # i % 7 == 0 → owner=NULL，模拟「群级记忆没有归属人」
    owner = owners[i % len(owners)] if i % 7 != 0 else None
    kind = kinds[i % len(kinds)]
    ts = 1600000000 + i
    rows.append((
        'peer-%d' % i, kind, '测试记忆条目 %d：设置页管理用的合成数据。' % i,
        'fp-%d' % i, 0.5, 1.0, 0, 1, ts, ts, retired, 0, owner, vis[i % 3], 0,
    ))

c.executemany(
    'INSERT INTO entries (peer,kind,text,fp,importance,strength,pinned,hits,created,'
    'last_seen,retired,reflected,owner,visibility,is_self) '
    'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', rows)
c.commit()
n = c.execute('SELECT COUNT(*) FROM entries').fetchone()[0]
a = c.execute('SELECT COUNT(*) FROM entries WHERE retired=0').fetchone()[0]
c.close()
if n != total or a != alive:
    raise SystemExit('fixture 不一致: total=%d alive=%d' % (n, a))
print(json.dumps({'total': n, 'alive': a}))
`

let FIXTURE_SRC = null
let FIXTURE_ERR = ''
if (!probe.ok) {
  FIXTURE_ERR = `本机没有可用的 python（${probe.reason}），无法运行记忆库相关断言`
} else {
  try {
    const dir = path.join(TMP, 'fixture')
    fs.mkdirSync(dir, { recursive: true })
    const script = path.join(dir, 'make-fixture.py')
    fs.writeFileSync(script, FIXTURE_PY, 'utf8')
    const dbPath = path.join(dir, 'mem.db')
    const r = spawnSync(probe.bin, [...(probe.preArgs || []), script, dbPath, JSON.stringify(FIXTURE)], {
      encoding: 'utf8', timeout: 60000,
    })
    if (r.error) throw new Error(String(r.error.message || r.error))
    if (r.status !== 0) throw new Error(`造夹具库失败（退出码 ${r.status}）：${String(r.stderr || r.stdout).slice(-400)}`)
    FIXTURE_SRC = dbPath
    console.log(`夹具库: ${FIXTURE.total} 条（有效 ${FIXTURE.alive}）`)
  } catch (err) {
    FIXTURE_ERR = `造合成夹具库失败：${err.message}`
  }
}
const DB_READY = !!FIXTURE_SRC

/** 造一个 stateDir：拷一份夹具库 + 记忆目录里常见的伴生文件。 */
function makeState (name, { withDb = true } = {}) {
  const dir = path.join(TMP, name)
  fs.mkdirSync(dir, { recursive: true })
  if (withDb) {
    fs.copyFileSync(FIXTURE_SRC, path.join(dir, 'mem.db'))
    fs.writeFileSync(path.join(dir, '.prod-guard'), 'test', { mode: 0o600 })
    fs.mkdirSync(path.join(dir, 'log'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'lexicon.json'), JSON.stringify({ entries: [], updatedAt: 'test' }), 'utf8')
    fs.writeFileSync(path.join(dir, 'digest.md'), '# 测试摘要\n', 'utf8')
    fs.mkdirSync(path.join(dir, 'corpus'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'corpus', 'bili-test.json'), '{"bvid":"test"}', 'utf8')
  }
  return dir
}
const cfgOf = stateDir => ({ memory: { stateDir, enabled: true } })
const NO_PY_PROBE = { ok: false, reason: '模拟无 python' }

// ─────────────────────────────────────────────────────────────────────────────
// A. 统计真跑（合成 N 条 / 按人分布）
// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n=== A. 记忆统计（合成 ${FIXTURE.total} 条库）===`)
const stateA = DB_READY ? makeState('state-a') : null
if (!DB_READY) {
  skip('A. 记忆统计', FIXTURE_ERR)
} else {
  const st = admin.memoryStats({ cfg: cfgOf(stateA), probe })
  ok('stats 返回 ok', st.ok === true, st.reason)
  ok(`总条数是 ${FIXTURE.total}（夹具）`, st.total === FIXTURE.total, st.total)
  ok(`有效条数 == ${FIXTURE.alive} 且 < 总数（有归档的）`,
    st.alive === FIXTURE.alive && st.alive > 0 && st.alive < st.total, `${st.alive}/${st.total}`)
  ok('有按层统计（procedural/semantic/episodic）',
    Array.isArray(st.byLayer) && st.byLayer.length >= 2, JSON.stringify(st.byLayer))
  ok('三层数字加起来 == 总数', st.byLayer.reduce((a, x) => a + x.total, 0) === st.total,
    `${st.byLayer.map(x => `${x.kind}:${x.total}`).join(' ')} = ${st.byLayer.reduce((a, x) => a + x.total, 0)}`)
  ok('有按人统计（byOwner 非空）', Array.isArray(st.byOwner) && st.byOwner.length > 0,
    JSON.stringify(st.byOwner?.slice(0, 6)))
  ok('byOwner 每项形状是 {owner,count}', st.byOwner.every(o => typeof o.owner === 'string' && typeof o.count === 'number'),
    JSON.stringify(st.byOwner?.[0]))
  ok('owner 都是纯数字 QQ 号', st.byOwner.every(o => /^\d+$/.test(o.owner)), JSON.stringify(st.byOwner?.map(o => o.owner).slice(0, 5)))
  ok('按人分布覆盖夹具里的 3 个 owner', st.byOwner.length === FIXTURE.owners.length,
    JSON.stringify(st.byOwner.map(o => o.owner)))
  ok('有 unowned 计数（群级记忆 owner=NULL）', typeof st.unowned === 'number' && st.unowned > 0, st.unowned)
  ok('有可见性分布', Array.isArray(st.byVisibility) && st.byVisibility.length > 0, JSON.stringify(st.byVisibility))
  ok('库大小 > 4KB（不是空库）', st.dbSizeBytes > 4096, `${st.dbSizeBytes} bytes`)
  ok('库大小与实际文件一致', st.dbSizeBytes === fs.statSync(path.join(stateA, 'mem.db')).size,
    `${st.dbSizeBytes} vs ${fs.statSync(path.join(stateA, 'mem.db')).size}`)
  ok('stateDir 指到临时目录（不是真实用户目录）', st.stateDir === stateA, st.stateDir)
  ok('没写真实 ~/.dsh/llminqq',
    !fs.existsSync(REAL_STATE) || (REAL_STATE_SNAP && fs.statSync(REAL_STATE).mtimeMs === REAL_STATE_SNAP.mtimeMs))

  // 合成分布打印出来（便于排查断言失败）
  console.log('    合成统计:')
  console.log(`      总数 ${st.total} / 有效 ${st.alive} / 大小 ${(st.dbSizeBytes / 1024).toFixed(0)} KB`)
  for (const l of st.byLayer) console.log(`      ${l.kind.padEnd(10)} ${String(l.total).padStart(4)} 条（有效 ${l.alive}）`)
  console.log(`      按人: ${st.byOwner.map(o => `${o.owner}:${o.count}`).join(' / ')}`)
  console.log(`      未归属(群级): ${st.unowned}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// B. 最近 N 条
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== B. 最近 N 条 ===')
if (!DB_READY) {
  skip('B. 最近 N 条', FIXTURE_ERR)
} else {
  const r = admin.memoryRecent({ cfg: cfgOf(stateA), probe, limit: 10 })
  ok('recent 返回 ok', r.ok === true, r.reason)
  ok('返回 10 条', r.rows.length === 10, r.rows.length)
  ok('每条有 text/peer/kind/lastSeen', r.rows.every(x => x.text && x.peer && x.kind && x.lastSeen))
  ok('按 last_seen 降序（最近的在前）',
    r.rows.every((x, i) => i === 0 || r.rows[i - 1].lastSeen >= x.lastSeen))
  const capped = admin.memoryRecent({ cfg: cfgOf(stateA), probe, limit: 500 })
  ok('limit 有上限保护（要 500 条只给 200）', capped.rows.length === 200, capped.rows.length)
  console.log(`      样例: [${r.rows[0].kind}] ${r.rows[0].text.slice(0, 50)}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// C. 清除的安全（这是重点）
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== C. 清除安全：没有确认不能清 ===')
if (!DB_READY) {
  skip('C. 清除安全', FIXTURE_ERR)
} else {
  const stateC = makeState('state-c')
  const cfg = cfgOf(stateC)
  const before = admin.memoryStats({ cfg, probe })
  ok('夹具清点：按人分布 3 人', before.byOwner.length === FIXTURE.owners.length,
    JSON.stringify(before.byOwner))

  // ① 不带 confirm → 必须拒绝
  const noConfirm = admin.memoryClear({ cfg, probe, owner: FIXTURE.owners[0], confirm: false })
  ok('不带 confirm 拒绝清除', noConfirm.ok === false && /二次确认/.test(noConfirm.error || ''), noConfirm.error)
  const stillThere = admin.memoryStats({ cfg, probe })
  ok('被拒绝后数据**一条都没动**', stillThere.total === before.total, `${before.total} → ${stillThere.total}`)

  // ② 清全部但没给确认词 → 拒绝
  const noText = admin.memoryClear({ cfg, probe, owner: '', confirm: true })
  ok('清全部但没给 DELETE-ALL → 拒绝', noText.ok === false && /DELETE-ALL/.test(noText.error || ''), noText.error)
  ok('拒绝后数据未动', admin.memoryStats({ cfg, probe }).total === before.total)

  // ③ owner 不是 QQ 号 → 拒绝（防前端传错字段导致误清全部）
  const badOwner = admin.memoryClear({ cfg, probe, owner: 'not-a-qq', confirm: true })
  ok('owner 非数字 → 拒绝（防误清全部）', badOwner.ok === false && /QQ 号/.test(badOwner.error || ''), badOwner.error)

  // ④ dry-run：算影响面但不删
  const target0 = before.byOwner[0]
  const dry = admin.memoryClear({ cfg, probe, owner: target0.owner, confirm: true, dryRun: true })
  ok('dry-run 返回 wouldDelete 条数', dry.ok === true && dry.wouldDelete === target0.count,
    `${JSON.stringify(dry).slice(0, 120)}（应 ${target0.count}）`)
  ok('dry-run 真的没删', admin.memoryStats({ cfg, probe }).total === before.total)

  // ⑤ 确认后真清（清某个人）
  const target = before.byOwner[0]
  const confirmed = admin.memoryClear({ cfg, probe, owner: target.owner, confirm: true })
  ok('确认后清除成功', confirmed.ok === true && confirmed.deleted > 0, JSON.stringify(confirmed).slice(0, 160))
  ok('删的条数 == 该 owner 原有条数', confirmed.deleted === target.count, `${confirmed.deleted} vs ${target.count}`)
  ok('清除前自动备份了库文件', !!confirmed.backup && fs.existsSync(path.join(stateC, confirmed.backup)),
    confirmed.backup)
  ok('清除是「归档」不是物理删（数据还在，可恢复）',
    /retired/.test(confirmed.note || '') && fs.existsSync(path.join(stateC, confirmed.backup)))
  const afterOwner = admin.memoryStats({ cfg, probe })
  ok('该 owner 从按人统计里消失', !afterOwner.byOwner.some(o => o.owner === target.owner),
    JSON.stringify(afterOwner.byOwner.slice(0, 4)))
  ok('总数不变（归档不物理删）', afterOwner.total === before.total, `${before.total} → ${afterOwner.total}`)
  ok('**有效条数减少了对应数量**', afterOwner.alive === before.alive - target.count,
    `${before.alive} → ${afterOwner.alive}（应减 ${target.count}）`)
  ok('其他人没被连累', afterOwner.byOwner.length === before.byOwner.length - 1,
    `${before.byOwner.length} → ${afterOwner.byOwner.length}`)

  // ⑥ 清全部：必须 DELETE-ALL，且清完 alive=0
  const stateAll = makeState('state-all')
  const allOk = admin.memoryClear({ cfg: cfgOf(stateAll), probe, owner: '', confirm: true, confirmText: 'DELETE-ALL' })
  ok('确认词正确才清全部', allOk.ok === true, JSON.stringify(allOk).slice(0, 140))
  ok('清完全部后 alive=0', admin.memoryStats({ cfg: cfgOf(stateAll), probe }).alive === 0)
}

// ─────────────────────────────────────────────────────────────────────────────
// D. 导出 / 导入 roundtrip
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== D. 导出 / 导入 roundtrip ===')
if (!DB_READY) {
  skip('D. 导出 / 导入 roundtrip', FIXTURE_ERR)
} else {
  const stateD = makeState('state-d')
  const cfg = cfgOf(stateD)
  const expOut = path.join(TMP, 'exports')
  const before = admin.memoryStats({ cfg, probe })
  ok(`导出前有 ${FIXTURE.total} 条`, before.total === FIXTURE.total, before.total)

  // ① 导出清单
  const list = admin.exportList({ cfg })
  ok('导出清单非空', list.length > 0, JSON.stringify(list.map(f => f.name)))
  ok('清单包含 mem.db', list.some(f => f.name === 'mem.db'))
  ok('清单包含 corpus/（语料池）', list.some(f => f.name.startsWith('corpus/')))
  ok('清单**不含凭据/日志外的杂项**（白名单）',
    list.every(f => ['mem.db', 'style.db', 'lexicon.json', 'digest.md', 'style-cases.jsonl'].includes(f.name)
      || f.name.startsWith('corpus/') || f.name.startsWith('log/')),
    JSON.stringify(list.map(f => f.name)))

  // ② 导出（显式 outDir → 产物只在 os.tmpdir() 的测试目录里）
  const exp = admin.memoryExport({ cfg, probe, outDir: expOut })
  ok('导出成功', exp.ok === true, exp.error)
  ok('导出产出 zip 文件', !!exp.zipPath && fs.existsSync(exp.zipPath), exp.zipPath)
  ok('zip 有体积（不是空包）', exp.bytes > 1024 && exp.bytes === fs.statSync(exp.zipPath).size,
    `${exp.bytes} bytes`)
  ok('zip 打全了清单里的文件', exp.entries === list.length, `${exp.entries} vs ${list.length}`)
  ok('文件名带日期', /llminqq-memory-\d{8}-\d{4}\.zip/.test(exp.filename), exp.filename)

  // ③ 清空（用 DELETE-ALL 的归档语义，然后把库删掉模拟「换了台机器」）
  admin.memoryClear({ cfg, probe, owner: '', confirm: true, confirmText: 'DELETE-ALL' })
  // 真把库文件删掉，模拟全新安装
  fs.rmSync(path.join(stateD, 'mem.db'), { force: true })
  ok('模拟清空：库文件已删', !fs.existsSync(path.join(stateD, 'mem.db')))
  const emptyState = admin.memoryStats({ cfg, probe })
  ok('清空后条数 0', emptyState.total === 0, emptyState.total)

  // ④ 导入
  const imp = admin.memoryImport({ cfg, probe, zipPath: exp.zipPath })
  ok('导入成功', imp.ok === true, imp.error)
  ok('导入前自动备份了现有数据（任务硬要求）', !!imp.backupDir && fs.existsSync(path.join(stateD, imp.backupDir)),
    imp.backupDir)
  ok('恢复了 mem.db', imp.restored.includes('mem.db'), JSON.stringify(imp.restored))
  ok('恢复了 corpus/', imp.restored.some(x => x.startsWith('corpus/')), JSON.stringify(imp.restored.slice(0, 4)))

  // ⑤ 关键判据：条数一致
  const after = admin.memoryStats({ cfg, probe })
  ok(`**roundtrip 后条数一致（${FIXTURE.total} → 0 → ${FIXTURE.total}）**`,
    after.total === before.total, `${before.total} → 0 → ${after.total}`)
  ok('有效条数也一致', after.alive === before.alive, `${before.alive} → ${after.alive}`)
  ok('按人分布一致', after.byOwner.length === before.byOwner.length,
    `${before.byOwner.length} 人 → ${after.byOwner.length} 人`)
  ok('导入后库能正常查询（recent 可读）', admin.memoryRecent({ cfg, probe, limit: 3 }).rows.length > 0)

  // ⑥ 恶意 zip：内容不是真库 + 夹带 ../ 路径 → 拒绝且不覆盖
  const zipBad = path.join(TMP, 'bad.zip')
  const pyBad = [
    'import sys,zipfile',
    'z=zipfile.ZipFile(sys.argv[1],"w")',
    'z.writestr("mem.db","not a real db")',
    'z.writestr("../../evil.txt","pwned")',
    'z.close()',
  ].join('\n')
  spawnSync(probe.bin, [...(probe.preArgs || []), '-c', pyBad, zipBad], { encoding: 'utf8', timeout: 60000 })
  const bad = admin.memoryImport({ cfg, probe, zipPath: zipBad })
  ok('夹带非法路径的 zip 不往上级目录写文件',
    !fs.existsSync(path.resolve(os.tmpdir(), '..', 'evil.txt'))
    && !fs.existsSync(path.resolve(stateD, '..', 'evil.txt'))
    && !fs.existsSync(path.join(stateD, 'evil.txt')))
  // 内容不是真库 → 校验阶段就该拒绝（而不是覆盖掉真库）
  const badRejected = bad.ok === false
  ok('内容不是有效记忆库 → 拒绝导入（不毁现有库）', badRejected, JSON.stringify(bad).slice(0, 180))
  ok('拒绝原因指出是库校验失败', /校验失败|不是有效记忆库/.test(bad.error || ''), bad.error)
  const afterBad = admin.memoryStats({ cfg, probe })
  ok('被拒绝的导入没有破坏现有数据', afterBad.total === before.total, `${afterBad.total} vs ${before.total}`)
  ok('被拒绝后库仍可正常读（recent 有内容）', admin.memoryRecent({ cfg, probe, limit: 1 }).rows.length === 1)

  // ⑦ 恶意 zip 变体：库是好的，但夹带 ../../evil.txt → 只恢复白名单内的，
  //    越界文件必须被跳过（skipped 里有它）且不落盘到上级目录。
  const zipEvil = path.join(TMP, 'evil-but-valid.zip')
  const pyEvil = [
    'import sys,zipfile',
    'z=zipfile.ZipFile(sys.argv[1],"w")',
    'z.write(sys.argv[2],arcname="mem.db")',
    'z.writestr("../../evil.txt","pwned")',
    'z.close()',
  ].join('\n')
  spawnSync(probe.bin, [...(probe.preArgs || []), '-c', pyEvil, zipEvil, FIXTURE_SRC], { encoding: 'utf8', timeout: 60000 })
  const evilImp = admin.memoryImport({ cfg, probe, zipPath: zipEvil })
  ok('带越界路径但库有效的 zip 能导入（只恢复白名单）', evilImp.ok === true, evilImp.error)
  ok('越界文件被 skipped（没被当数据恢复）', (evilImp.skipped || []).includes('../../evil.txt'),
    JSON.stringify(evilImp.skipped))
  ok('越界文件没有落盘到上级目录',
    !fs.existsSync(path.resolve(os.tmpdir(), '..', 'evil.txt'))
    && !fs.existsSync(path.resolve(stateD, '..', 'evil.txt'))
    && !fs.existsSync(path.join(stateD, 'evil.txt')))
  ok('恢复后条数仍一致', admin.memoryStats({ cfg, probe }).total === before.total)
}

// ─────────────────────────────────────────────────────────────────────────────
// E. 边界 + 数据形状（前端要能直接渲染）
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== E. 边界 + 前端数据形状 ===')
{
  // 完全没有库（全新安装）—— 不需要库文件，只需要 python 可用（stats 先判 probe）
  if (!DB_READY) {
    skip('E. 库不存在时的 stats 边界', FIXTURE_ERR)
  } else {
    const fresh = path.join(TMP, 'state-fresh')
    fs.mkdirSync(fresh, { recursive: true })
    const st = admin.memoryStats({ cfg: cfgOf(fresh), probe })
    ok('库不存在时 stats 仍 ok（不是错误）', st.ok === true && st.total === 0, JSON.stringify(st).slice(0, 140))
    ok('库不存在时标了 empty（前端显示「还没有记忆」）', st.empty === true)
    ok('库不存在时导出给明确错误（不是崩）',
      admin.memoryExport({ cfg: cfgOf(fresh), probe }).ok === false)
  }

  // 没有 python（模拟探针结果，不需要真库）
  const noPy = admin.memoryStats({ cfg: cfgOf(path.join(TMP, 'state-nopy')), probe: NO_PY_PROBE })
  ok('无 python 时 stats.ok=false 且带 reason', noPy.ok === false && /python/.test(noPy.reason || ''), noPy.reason)
  ok('无 python 时 clear 拒绝并说明', admin.memoryClear({
    cfg: cfgOf(path.join(TMP, 'state-nopy')), probe: NO_PY_PROBE, owner: '1', confirm: true,
  }).ok === false)

  // 前端渲染所需字段一个不少（照 client.js 的用法核）
  if (!DB_READY) {
    skip('E. stats 字段形状', FIXTURE_ERR)
  } else {
    const shape = admin.memoryStats({ cfg: cfgOf(stateA), probe })
    for (const k of ['ok', 'total', 'alive', 'byLayer', 'byOwner', 'unowned', 'dbSizeBytes', 'stateDir', 'pythonOk', 'pythonVersion', 'byVisibility']) {
      ok(`stats 字段 ${k} 存在`, k in shape, Object.keys(shape).join(','))
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// G. B站语料抓取（第 ③ 项）：只手动 + 一天 ≤3 次限频
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== G. 语料抓取限频（防连点撞风控）===')
{
  const stateG = path.join(TMP, 'state-g')
  fs.mkdirSync(stateG, { recursive: true })
  const cfg = cfgOf(stateG)

  const u0 = admin.crawlUsage({ cfg })
  ok('初始剩余次数 = 3', u0.remaining === 3 && u0.used === 0, JSON.stringify(u0))
  ok('上限常量是 3/天', admin.CRAWL_PER_DAY === 3, admin.CRAWL_PER_DAY)

  // 真实「点一次」会跑几分钟且请求 B站 —— 测试里只验限频记账逻辑：
  // 用 dry-run（不发请求、也不记账）先确认 dry-run 不消耗次数
  const dry = await admin.runCrawl({ cfg, only: 1, dryRun: true })
  ok('dry-run 不消耗今日次数', admin.crawlUsage({ cfg }).used === 0, JSON.stringify(admin.crawlUsage({ cfg })))
  ok('dry-run 不报错（或明确说明依赖缺失）', dry.ok || /依赖|python|缺失/.test(dry.error || ''), dry.error)

  // 直接验证「次数用完后拒绝」：手工把状态写成 3 次
  fs.writeFileSync(path.join(stateG, 'crawl-state.json'), JSON.stringify({
    date: admin.crawlUsage({ cfg }).today, count: 3, lastRunAt: Date.now(),
  }), 'utf8')
  const blocked = await admin.runCrawl({ cfg, only: 1 })
  ok('**用满 3 次后拒绝抓取**', blocked.ok === false && /上限|明天/.test(blocked.error || ''), blocked.error)
  ok('拒绝时不消耗/不越界', admin.crawlUsage({ cfg }).used === 3, admin.crawlUsage({ cfg }).used)

  // 跨天重置
  fs.writeFileSync(path.join(stateG, 'crawl-state.json'), JSON.stringify({
    date: '1999-1-1', count: 3, lastRunAt: 0,
  }), 'utf8')
  ok('跨天后次数重置为 0（新的一天又能抓）', admin.crawlUsage({ cfg }).used === 0, JSON.stringify(admin.crawlUsage({ cfg })))

  // 依赖探测：必须真 import 校验（文件存在 ≠ 依赖装了）
  const env = admin.probeCrawlEnv({ cfg })
  ok('依赖探测返回结构化结论（ok + reason）',
    typeof env.ok === 'boolean' && (env.ok || typeof env.reason === 'string'), JSON.stringify(env).slice(0, 160))
  if (env.ok) {
    console.log(`      抓取环境就绪: ${env.python}`)
    ok('探测到的 python 存在', fs.existsSync(env.python), env.python)
  } else {
    console.log(`      抓取环境未就绪（会明确提示，不静默）: ${String(env.reason).slice(0, 80)}`)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// F. 目录隔离 + 前端语法
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== F. 隔离 + 前端语法 ===')
{
  ok('没写真实 ~/.dsh/llminqq',
    !fs.existsSync(REAL_STATE) || (REAL_STATE_SNAP && fs.statSync(REAL_STATE).mtimeMs === REAL_STATE_SNAP.mtimeMs))
  ok('测试全程没碰生产主仓库库（本机不存在或未被改写）', (() => {
    const mainDb = path.join(path.resolve(PKG, '..', '..'), 'qq-agent', 'memory', 'mem.db')
    if (!fs.existsSync(mainDb)) return true
    return fs.statSync(mainDb).size > 4096 // 还能打开就是没被删
  })())
  // client.js 语法：它走 window.__ModuleLoader__，不是标准 ESM，只能做文本级检查
  const clientSrc = fs.readFileSync(path.join(PKG, 'client.js'), 'utf8')
  ok('client.js 含记忆管理区块', /记忆/.test(clientSrc))
  ok('client.js 调了 /memory/stats', /\/memory\/stats/.test(clientSrc))
  ok('client.js 调了 /memory/crawl（手动抓取按钮）', /\/memory\/crawl/.test(clientSrc))
  ok('client.js 用了现有设计系统类（qq-panel/card）', /qq-panel/.test(clientSrc) && /className: 'card'/.test(clientSrc))
  // 括号配平（JS 语法最低门槛：拿不到 AST 时先抓明显的手滑）
  const balanced = (s, a, b) => {
    let d = 0
    for (const ch of s) { if (ch === a) d++; else if (ch === b) { d--; if (d < 0) return false } }
    return d === 0
  }
  ok('client.js 大括号配平', balanced(clientSrc.replace(/`(?:[^`\\]|\\.)*`/g, '``').replace(/\/\*[\s\S]*?\*\//g, ''), '{', '}'))
  ok('client.js 圆括号配平', balanced(clientSrc.replace(/`(?:[^`\\]|\\.)*`/g, '``'), '(', ')'))
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败 / ${skipCount} 跳过`)
// 成功时清掉临时目录（失败时保留现场供排查）
if (fail === 0) {
  try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* ignore */ }
}
process.exit(fail === 0 ? 0 : 1)
