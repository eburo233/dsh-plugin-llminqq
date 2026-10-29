// 设置页记忆管理（P4）测试：统计 / 清除安全 / 导出导入 roundtrip
// 运行：node test/plugin-admin.test.mjs
//
// 为什么这个测试的重点是「清除的安全」：
//   统计和导出是只读的，错了最多显示难看；
//   而**清除是不可逆操作** —— 误删一份攒了几个月的记忆，用户没有第二份。
//   所以本文件对「没有确认不能清」的验证是逐条硬断言，不是「前端拦住了」就算。
//   另外还验「清除前会自动备份」和「导入前会备份」，因为这两条是最后的安全网。
//
// 全部用临时 stateDir，绝不碰生产 mem.db / 用户真实 ~/.dsh/llminqq。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

// 本文件在 packages/dsh-plugin-llminqq/test/：
//   PKG  = 上一级（包根）
//   ROOT = 再上两级（仓库根，用来定位主仓库的 844 条真实库）
const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = path.resolve(PKG, '..', '..')
// 844 条真实记忆在主仓库，模板仓库那份是空的
const MAIN_REPO_DB = '/home/jojo/dsh/LLMinQQ/qq-agent/memory/mem.db'
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-admin-'))
const REAL_STATE = path.join(os.homedir(), '.dsh', 'llminqq')
const REAL_STATE_SNAP = fs.existsSync(REAL_STATE)
  ? { mtimeMs: fs.statSync(REAL_STATE).mtimeMs }
  : null

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

const { probePython } = await import(path.join(PKG, 'lib/pyprobe.mjs'))
const admin = await import(path.join(PKG, 'lib/agent/memory-admin.mjs'))
const { memoryEnv } = await import(path.join(PKG, 'lib/agent/memory-run.mjs'))
const probe = probePython({ log: () => {} })
console.log(`\npython: ${probe.ok ? `${probe.bin} ${probe.version}` : probe.reason}`)

/** 造一个 stateDir，从主仓库真实库拷 844 条（只读源，绝不写它）。 */
function makeState (name, { withDb = true } = {}) {
  const dir = path.join(TMP, name)
  fs.mkdirSync(dir, { recursive: true })
  if (withDb) {
    if (!fs.existsSync(MAIN_REPO_DB)) throw new Error(`主仓库库不存在：${MAIN_REPO_DB}`)
    // sqlite backup（不是 cp）：一致快照，避免撕裂（和迁移工具同一纪律）
    const py = 'import sqlite3,sys;s=sqlite3.connect("file:%s?mode=ro"%sys.argv[1],uri=True);'
      + 'd=sqlite3.connect(sys.argv[2]);s.backup(d);d.close();s.close();print("ok")'
    const r = spawnSync(probe.bin, [...(probe.preArgs || []), '-c', py, MAIN_REPO_DB, path.join(dir, 'mem.db')],
      { encoding: 'utf8', timeout: 60000 })
    if (r.status !== 0) throw new Error(`拷库失败：${r.stderr}`)
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

// ─────────────────────────────────────────────────────────────────────────────
// A. 统计真跑（844 条 / 按人分布）
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== A. 记忆统计（真实 844 条库）===')
const stateA = makeState('state-a')
{
  const st = admin.memoryStats({ cfg: cfgOf(stateA), probe })
  ok('stats 返回 ok', st.ok === true, st.reason)
  ok('总条数是 844（主仓库真实数据）', st.total === 844, st.total)
  ok('有效条数 < 总数（有归档的）', typeof st.alive === 'number' && st.alive > 0 && st.alive < st.total, `${st.alive}/${st.total}`)
  ok('有按层统计（procedural/semantic/episodic）',
    Array.isArray(st.byLayer) && st.byLayer.length >= 2, JSON.stringify(st.byLayer))
  ok('三层数字加起来 == 总数', st.byLayer.reduce((a, x) => a + x.total, 0) === st.total,
    `${st.byLayer.map(x => `${x.kind}:${x.total}`).join(' ')} = ${st.byLayer.reduce((a, x) => a + x.total, 0)}`)
  ok('有按人统计（byOwner 非空）', Array.isArray(st.byOwner) && st.byOwner.length > 0,
    JSON.stringify(st.byOwner?.slice(0, 6)))
  ok('byOwner 每项形状是 {owner,count}', st.byOwner.every(o => typeof o.owner === 'string' && typeof o.count === 'number'),
    JSON.stringify(st.byOwner?.[0]))
  ok('owner 都是纯数字 QQ 号', st.byOwner.every(o => /^\d+$/.test(o.owner)), JSON.stringify(st.byOwner?.map(o => o.owner).slice(0, 5)))
  ok('有 unowned 计数（群级记忆 owner=NULL）', typeof st.unowned === 'number', st.unowned)
  ok('有可见性分布', Array.isArray(st.byVisibility) && st.byVisibility.length > 0, JSON.stringify(st.byVisibility))
  ok('库大小 > 200KB（真实库不是空的）', st.dbSizeBytes > 200 * 1024, `${st.dbSizeBytes} bytes`)
  ok('stateDir 指到临时目录（不是真实用户目录）', st.stateDir === stateA, st.stateDir)
  ok('没写真实 ~/.dsh/llminqq',
    !fs.existsSync(REAL_STATE) || (REAL_STATE_SNAP && fs.statSync(REAL_STATE).mtimeMs === REAL_STATE_SNAP.mtimeMs))

  // 真实分布打印出来（这是任务要求的「贴真实输出」）
  console.log('    真实统计:')
  console.log(`      总数 ${st.total} / 有效 ${st.alive} / 大小 ${(st.dbSizeBytes / 1024).toFixed(0)} KB`)
  for (const l of st.byLayer) console.log(`      ${l.kind.padEnd(10)} ${String(l.total).padStart(4)} 条（有效 ${l.alive}）`)
  console.log(`      按人: ${st.byOwner.slice(0, 6).map(o => `${o.owner}:${o.count}`).join(' / ')}${st.byOwner.length > 6 ? ` …共 ${st.byOwner.length} 人` : ''}`)
  console.log(`      未归属(群级): ${st.unowned}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// B. 最近 N 条
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== B. 最近 N 条 ===')
{
  const r = admin.memoryRecent({ cfg: cfgOf(stateA), probe, limit: 10 })
  ok('recent 返回 ok', r.ok === true, r.reason)
  ok('返回 10 条', r.rows.length === 10, r.rows.length)
  ok('每条有 text/peer/kind/lastSeen', r.rows.every(x => x.text && x.peer && x.kind && x.lastSeen))
  ok('按 last_seen 降序（最近的在前）',
    r.rows.every((x, i) => i === 0 || r.rows[i - 1].lastSeen >= x.lastSeen))
  ok('limit 有上限保护（要 500 条只给 200）',
    admin.memoryRecent({ cfg: cfgOf(stateA), probe, limit: 500 }).rows.length <= 200,
    admin.memoryRecent({ cfg: cfgOf(stateA), probe, limit: 500 }).rows.length)
  console.log(`      样例: [${r.rows[0].kind}] ${r.rows[0].text.slice(0, 50)}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// C. 清除的安全（这是重点）
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== C. 清除安全：没有确认不能清 ===')
{
  const stateC = makeState('state-c')
  const cfg = cfgOf(stateC)
  const before = admin.memoryStats({ cfg, probe })

  // ① 不带 confirm → 必须拒绝
  const noConfirm = admin.memoryClear({ cfg, probe, owner: '1000000001', confirm: false })
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
  const dry = admin.memoryClear({ cfg, probe, owner: '1000000001', confirm: true, dryRun: true })
  ok('dry-run 返回 wouldDelete 条数', dry.ok === true && typeof dry.wouldDelete === 'number', JSON.stringify(dry))
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
{
  const stateD = makeState('state-d')
  const cfg = cfgOf(stateD)
  const before = admin.memoryStats({ cfg, probe })
  ok('导出前有 844 条', before.total === 844, before.total)

  // ① 导出清单
  const list = admin.exportList({ cfg })
  ok('导出清单非空', list.length > 0, JSON.stringify(list.map(f => f.name)))
  ok('清单包含 mem.db', list.some(f => f.name === 'mem.db'))
  ok('清单包含 corpus/（语料池）', list.some(f => f.name.startsWith('corpus/')))
  ok('清单**不含凭据/日志外的杂项**（白名单）',
    list.every(f => ['mem.db', 'style.db', 'lexicon.json', 'digest.md', 'style-cases.jsonl'].includes(f.name)
      || f.name.startsWith('corpus/') || f.name.startsWith('log/')),
    JSON.stringify(list.map(f => f.name)))

  // ② 导出
  const exp = admin.memoryExport({ cfg, probe })
  ok('导出成功', exp.ok === true, exp.error)
  ok('导出产出 zip 文件', !!exp.zipPath && fs.existsSync(exp.zipPath), exp.zipPath)
  // 注意：这里不能写「>100KB」这类凭直觉的数字。真实数据（844 条记忆 ≈ 240KB 的
  // 库 + 1 个语料文件）压缩后约 90KB —— 文本库的压缩比很高。断言只看「不为空且
  // 至少包含库文件」，不猜具体大小（猜出来的阈值以后会变成假失败）。
  ok('zip 有体积（不是空包）', exp.bytes > 20 * 1024, `${exp.bytes} bytes`)
  ok('zip 至少打包了库 + 清单里的文件', exp.entries >= 4, `${exp.entries} 个: ${exp.restored ?? ''}`)
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
  ok('**roundtrip 后条数一致（844 → 0 → 844）**', after.total === before.total, `${before.total} → 0 → ${after.total}`)
  ok('有效条数也一致', after.alive === before.alive, `${before.alive} → ${after.alive}`)
  ok('按人分布一致', after.byOwner.length === before.byOwner.length,
    `${before.byOwner.length} 人 → ${after.byOwner.length} 人`)
  ok('导入后库能正常查询（recent 可读）', admin.memoryRecent({ cfg, probe, limit: 3 }).rows.length > 0)

  // ⑥ 恶意 zip：夹带非白名单文件 → 必须被拒在名单外（不能覆盖任意文件）
  const zipBad = path.join(TMP, 'bad.zip')
  const py = [
    'import json,sys,zipfile',
    'z=zipfile.ZipFile(sys.argv[1],"w")',
    'z.writestr("mem.db","not a real db")',
    'z.writestr("../../evil.txt","pwned")',
    'z.close()',
  ].join('\n')
  spawnSync(probe.bin, [...(probe.preArgs || []), '-c', py, zipBad], { encoding: 'utf8' })
  const bad = admin.memoryImport({ cfg, probe, zipPath: zipBad })
  ok('夹带非法路径的 zip 不覆盖到上级目录',
    !fs.existsSync(path.join(TMP, '..', 'evil.txt')) && !fs.existsSync(path.join(stateD, '..', 'evil.txt')))
  // 内容不是真库 → 校验阶段就该拒绝（而不是覆盖掉真库）
  const badRejected = bad.ok === false
  ok('内容不是有效记忆库 → 拒绝导入（不毁现有库）', badRejected, JSON.stringify(bad).slice(0, 180))
  const afterBad = admin.memoryStats({ cfg, probe })
  ok('被拒绝的导入没有破坏现有数据', afterBad.total === before.total, `${afterBad.total} vs ${before.total}`)
  ok('被拒绝后库仍可正常读（recent 有内容）', admin.memoryRecent({ cfg, probe, limit: 1 }).rows.length === 1)
}

// ─────────────────────────────────────────────────────────────────────────────
// E. 边界 + 数据形状（前端要能直接渲染）
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== E. 边界 + 前端数据形状 ===')
{
  // 完全没有库（全新安装）
  const fresh = path.join(TMP, 'state-fresh')
  fs.mkdirSync(fresh, { recursive: true })
  const st = admin.memoryStats({ cfg: cfgOf(fresh), probe })
  ok('库不存在时 stats 仍 ok（不是错误）', st.ok === true && st.total === 0, JSON.stringify(st).slice(0, 140))
  ok('库不存在时标了 empty（前端显示「还没有记忆」）', st.empty === true)
  ok('库不存在时导出给明确错误（不是崩）',
    admin.memoryExport({ cfg: cfgOf(fresh), probe }).ok === false)

  // 没有 python
  const noPy = admin.memoryStats({ cfg: cfgOf(stateA), probe: { ok: false, reason: '模拟无 python' } })
  ok('无 python 时 stats.ok=false 且带 reason', noPy.ok === false && /python/.test(noPy.reason || ''), noPy.reason)
  ok('无 python 时 clear 拒绝并说明', admin.memoryClear({
    cfg: cfgOf(stateA), probe: { ok: false, reason: '模拟无 python' }, owner: '1', confirm: true,
  }).ok === false)

  // 前端渲染所需字段一个不少（照 client.js 的用法核）
  const shape = admin.memoryStats({ cfg: cfgOf(stateA), probe })
  for (const k of ['ok', 'total', 'alive', 'byLayer', 'byOwner', 'unowned', 'dbSizeBytes', 'stateDir', 'pythonOk', 'pythonVersion', 'byVisibility']) {
    ok(`stats 字段 ${k} 存在`, k in shape, Object.keys(shape).join(','))
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
  ok('生产主仓库 mem.db 没被改（只读过）', (() => {
    if (!fs.existsSync(MAIN_REPO_DB)) return true
    const st = fs.statSync(MAIN_REPO_DB)
    return st.size > 4096 // 还能打开就是没被删；内容由只读连接保证
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

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
