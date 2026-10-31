// lib/agent/memory-admin.mjs —— 设置页「记忆管理」的后端实现
// ============================================================================
// 做四件事（全部是**只读查询**之外，只有 clear/import 会写）：
//   stats()   条数 / 按层 / 按人 / 库大小 / 目录 / python 状态
//   recent()  最近 N 条（让用户「看看它到底记了啥」）
//   clear()   清除某人的记忆（或全部）—— **必须二次确认**
//   export()  打包 zip（备份/换机迁移）
//   import()  从 zip 恢复 —— **导入前自动备份现有数据**
//
// 三个设计决定（都不是随手写的，各自对应一个真实的坑）：
//
// ① **统计/清库都走 python sqlite3，不调 `memctl stats` CLI**
//    理由：`memctl stats` 是给人看的中文输出（「有效记忆 844 条」），拿去解析
//    是脆的（改个文案就崩）。而这些数字**本来就在库里**，用一条 SQL 就够。
//    改成结构化 JSON 输出，前端拿到的就是数据，不是需要正则抠的文本。
//    ⚠️ 但**不改 memctl.py**（它是 vendored、还有别的任务在依赖它）——
//    所以这里用 `python3 -c` 内联小脚本，跟桥的跨通道检索是同一套手法。
//
// ② **清除必须显式确认，且默认拒绝**
//    用户明确要求「不能一键清空」。所以：
//      · 不带 `confirm` → 直接 400 拒绝（不是「前端拦一下」——
//        前端拦得住按钮，拦不住 curl/其他客户端）
//      · 清全部还要 `confirm === 'DELETE-ALL'` 这种**打字确认**，
//        避免「勾了个框手滑点确定」
//      · 清除前先在库里做一次备份（同目录 `mem.db.bak-<时间戳>`），
//        误删能捞回来 —— 删除是不可逆操作，必须留后路
//
// ③ **导出只打包「数据」，绝不打包代码/凭据**
//    stateDir 下有 mem.db/lexicon.json/digest.md/corpus，也可能有日志。
//    代码在包里、凭据在 secrets.json（另一个目录），都不该进这个 zip。
//    白名单法而不是黑名单法：黑名单永远会漏（以后加了新文件就漏），
//    白名单漏了只是少打包一个文件（可发现、无害）。
// ============================================================================
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { memoryPaths, memoryStateDir, memoryCode } from './dirs.mjs'
import { resolveBiliPython, resolveBiliRoot } from './bili-python.mjs'

/** 导出/导入允许进 zip 的东西（白名单，见文件头 ③）。 */
const EXPORT_FILES = ['mem.db', 'style.db', 'lexicon.json', 'digest.md', 'style-cases.jsonl']
const EXPORT_DIRS = ['corpus', 'log']
/** 导出文件名里带上日期，多次导出不会互相覆盖。 */
function exportName () {
  const d = new Date()
  const pad = n => String(n).padStart(2, '0')
  return `llminqq-memory-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.zip`
}

/**
 * 在 python 里跑一段只读 SQL，返回 JSON。
 *
 * 为什么用 `mode=ro` 打开：设置页随时会被点开，如果这时候桥正在写库，
 * 只读连接不会加写锁、也不会因为写事务而卡住（SQLite 的 WAL/rollback
 * journal 都支持读并发）。更重要的是——**设置页绝不该有写生产库的能力**，
 * 写操作只有 clear/import 两条，且它们走的是显式 SQL。
 */
function queryJson ({ cfg = {}, probe, sql, timeoutMs = 8000, write = false }) {
  if (!probe?.ok) return { ok: false, reason: probe?.reason || 'python 不可用' }
  const paths = memoryPaths(cfg)
  if (!fs.existsSync(paths.db)) return { ok: false, reason: 'db-missing', db: paths.db }

  // 参数通过环境变量传，不拼进 SQL —— 避免引号/注入问题（owner 是用户输入）
  const py = [
    'import json,os,sqlite3,sys,urllib.parse',
    'db=os.environ["ADMIN_DB"]',
    'mode=os.environ.get("ADMIN_MODE","ro")',
    'sql=os.environ["ADMIN_SQL"]',
    `uri='file:%s?mode=%s'%(urllib.parse.quote(db,safe="/"),mode) if mode=='ro' else db`,
    'c=sqlite3.connect(uri,uri=(mode=="ro"))',
    `c.row_factory=sqlite3.Row`,
    'out=[]',
    'for stmt in json.loads(sql):',
    '  try: out.append([dict(r) for r in c.execute(stmt[0], stmt[1] if len(stmt)>1 else ()).fetchall()])',
    '  except Exception as e: out.append([{"__error__": str(e)}])',
    'c.commit();c.close()',
    'print(json.dumps(out,ensure_ascii=False))',
  ].join('\n')
  const r = spawnSync(probe.bin, [...(probe.preArgs || []), '-c', py], {
    encoding: 'utf8',
    timeout: timeoutMs,
    env: {
      ...process.env,
      ADMIN_DB: paths.db,
      ADMIN_SQL: JSON.stringify(sql),
      ADMIN_MODE: write ? 'rw' : 'ro',
      PYTHONIOENCODING: 'utf8',
      PYTHONDONTWRITEBYTECODE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  if (r.error) return { ok: false, reason: String(r.error.code || r.error.message) }
  if (r.status !== 0) {
    return { ok: false, reason: `python 退出码 ${r.status}`, stderr: String(r.stderr || '').slice(0, 400) }
  }
  try {
    const results = JSON.parse(String(r.stdout).trim().split('\n').pop())
    // ⚠️ 单条 SQL 失败时 python 侧不退出（它逐条 try），把错误塞进 `__error__` 行。
    //    如果这里只看退出码，就把「库不是数据库 / 表不存在」当成成功了 ——
    //    实测后果：导入一个内容是垃圾文件的 zip 时，「校验 mem.db 可读」这一步
    //    会**误判通过**，然后拿垃圾覆盖掉用户真实的库。所以必须在这里判失败。
    const errRow = Array.isArray(results)
      ? results.flat().find(r => r && typeof r === 'object' && r.__error__)
      : null
    if (errRow) return { ok: false, reason: `SQL 失败: ${errRow.__error__}` }
    return { ok: true, results }
  } catch (e) {
    return { ok: false, reason: `输出解析失败: ${e.message}`, stdout: String(r.stdout).slice(0, 300) }
  }
}

/** 库文件大小（含 -wal/-shm，用户看到的「占用」应该是真实占用）。 */
function dbSizeBytes (dbPath) {
  let total = 0
  for (const suffix of ['', '-wal', '-shm']) {
    try { total += fs.statSync(dbPath + suffix).size } catch { /* 没有就算了 */ }
  }
  return total
}

/**
 * 记忆统计。
 *
 * @returns {{ok:boolean, total?, alive?, byLayer?, byOwner?, dbSizeBytes?, stateDir?, ...}}
 */
export function memoryStats ({ cfg = {}, probe } = {}) {
  const paths = memoryPaths(cfg)
  const stateDir = memoryStateDir(cfg)
  const base = {
    stateDir,
    db: paths.db,
    dbExists: fs.existsSync(paths.db),
    pythonOk: !!probe?.ok,
    pythonVersion: probe?.version || '',
    dbSizeBytes: fs.existsSync(paths.db) ? dbSizeBytes(paths.db) : 0,
  }
  if (!probe?.ok) {
    return { ok: false, ...base, reason: probe?.reason || 'python 不可用', total: 0, alive: 0, byLayer: [], byOwner: [] }
  }
  if (!base.dbExists) {
    // 库不存在**不是错误**：新装用户还没攒到记忆。返回 0 条 + degraded 语义，
    // 让前端显示「还没有记忆」，而不是弹一个红色错误。
    return { ok: true, ...base, total: 0, alive: 0, byLayer: [], byOwner: [], empty: true }
  }
  const q = queryJson({
    cfg, probe,
    sql: [
      ['SELECT COUNT(*) AS n FROM entries', []],
      ["SELECT COUNT(*) AS n FROM entries WHERE retired=0", []],
      ['SELECT kind, COUNT(*) AS n, SUM(CASE WHEN retired=0 THEN 1 ELSE 0 END) AS alive FROM entries GROUP BY kind ORDER BY n DESC', []],
      ["SELECT owner, COUNT(*) AS n FROM entries WHERE retired=0 AND owner IS NOT NULL GROUP BY owner ORDER BY n DESC", []],
      ["SELECT COUNT(*) AS n FROM entries WHERE retired=0 AND owner IS NULL", []],
      // 可见性分布：给用户一个「有多少条只在私聊说过」的感觉（dm_only）
      ["SELECT COALESCE(visibility,'(未标注)') AS v, COUNT(*) AS n FROM entries WHERE retired=0 GROUP BY v ORDER BY n DESC", []],
    ],
  })
  if (!q.ok) return { ok: false, ...base, reason: q.reason, stderr: q.stderr, total: 0, alive: 0, byLayer: [], byOwner: [] }

  const [total, alive, byLayer, byOwner, unowned, byVisibility] = q.results
  const first = arr => (Array.isArray(arr) && arr[0] && !arr[0].__error__ ? arr[0] : null)
  const rows = arr => (Array.isArray(arr) ? arr.filter(r => !r.__error__) : [])
  const bad = q.results.find(a => Array.isArray(a) && a[0] && a[0].__error__)
  if (bad) return { ok: false, ...base, reason: `SQL 失败: ${bad[0].__error__}` }

  return {
    ok: true,
    ...base,
    total: first(total)?.n ?? 0,
    alive: first(alive)?.n ?? 0,
    byLayer: rows(byLayer).map(r => ({ kind: r.kind, total: r.n, alive: r.alive ?? 0 })),
    byOwner: rows(byOwner).map(r => ({ owner: String(r.owner), count: r.n })),
    unowned: first(unowned)?.n ?? 0,
    byVisibility: rows(byVisibility).map(r => ({ visibility: r.v, count: r.n })),
  }
}

/** 最近 N 条（默认 20）。只给「有效」的，按最近出现排序。 */
export function memoryRecent ({ cfg = {}, probe, limit = 20 } = {}) {
  const n = Math.max(1, Math.min(200, Number(limit) || 20))
  const q = queryJson({
    cfg, probe,
    sql: [[
      'SELECT id, peer, kind, owner, visibility, pinned, importance, retired, last_seen, text '
      + 'FROM entries WHERE retired=0 ORDER BY last_seen DESC LIMIT ?', [n]],
    ],
  })
  if (!q.ok) return { ok: false, reason: q.reason, rows: [] }
  const rows = (q.results?.[0] || []).filter(r => !r.__error__)
  return {
    ok: true,
    rows: rows.map(r => ({
      id: r.id, peer: r.peer, kind: r.kind, owner: r.owner,
      visibility: r.visibility, pinned: !!r.pinned,
      importance: r.importance, lastSeen: r.last_seen,
      text: String(r.text ?? '').slice(0, 300),
    })),
  }
}

/**
 * 清除某人 / 全部记忆。**危险操作，必须显式确认。**
 *
 * @param {object} opts
 * @param {string} [opts.owner]    要清的 QQ 号；不传 = 清全部
 * @param {boolean} [opts.confirm] 必须为 true
 * @param {string} [opts.confirmText] 清全部时必须 === 'DELETE-ALL'
 * @returns {{ok:boolean, deleted?, backup?, error?}}
 */
export function memoryClear ({ cfg = {}, probe, owner = '', confirm = false, confirmText = '', dryRun = false } = {}) {
  const paths = memoryPaths(cfg)
  if (!probe?.ok) return { ok: false, error: `python 不可用：${probe?.reason || ''}` }
  if (!fs.existsSync(paths.db)) return { ok: false, error: '记忆库还不存在（没东西可清）' }

  const ownerStr = String(owner ?? '').trim()
  const clearingAll = ownerStr === ''

  // ── 二次确认（后端强制，不依赖前端）────────────────────────────────────
  if (!confirm) {
    return { ok: false, error: '清除记忆需要二次确认（confirm=true）——这是不可逆操作' }
  }
  if (clearingAll && confirmText !== 'DELETE-ALL') {
    return {
      ok: false,
      error: '清空**全部**记忆需要输入确认词 DELETE-ALL（只清某个人的话传 owner 即可）',
      needConfirmText: 'DELETE-ALL',
    }
  }
  if (!clearingAll && !/^\d{4,12}$/.test(ownerStr)) {
    return { ok: false, error: `owner 必须是 QQ 号（纯数字），收到的是：${ownerStr.slice(0, 40)}` }
  }

  // ── 先数命中多少条（dry-run 也走这里，前端「确认前」要先知道影响面）──────
  // ⚠️ 计数用的谓词必须和下面 UPDATE 的谓词**逐字一致**（都带 retired=0）。
  //    实测踩到：这里只写了 `WHERE owner=?`，而 UPDATE 带 retired=0 ——
  //    于是「已归档的条目」被算进 deleted 里，返回 440 但实际只归档了 365。
  //    用户看到「删了 440 条」却发现按人统计只少 365，会以为程序在骗人。
  const countSql = clearingAll
    ? ['SELECT COUNT(*) AS n FROM entries WHERE retired=0', []]
    : ['SELECT COUNT(*) AS n FROM entries WHERE retired=0 AND owner=?', [ownerStr]]
  const cnt = queryJson({ cfg, probe, sql: [countSql] })
  const hits = cnt.ok ? (cnt.results?.[0]?.[0]?.n ?? 0) : null
  if (dryRun) {
    return { ok: true, dryRun: true, wouldDelete: hits, owner: clearingAll ? null : ownerStr, all: clearingAll }
  }

  // ── 清除前备份（删除不可逆，必须留后路）──────────────────────────────
  let backup = null
  try {
    backup = path.join(paths.dir, `mem.db.bak-${Date.now()}`)
    // 用 SQLite backup API（不是 cp）——热拷会撕裂，见 memory-migrate.mjs 的同一段说明。
    // 这里复用简单版：VACUUM INTO 是 SQLite 3.27+ 的一致性快照，比 cp 安全。
    const bk = queryJson({ cfg, probe, write: true, sql: [[`VACUUM INTO ?`, [backup]]] })
    if (!bk.ok) {
      // VACUUM INTO 老版本不支持 → 退到 python 的 backup API
      const py = [
        'import sqlite3,sys',
        's=sqlite3.connect(sys.argv[1]);d=sqlite3.connect(sys.argv[2]);s.backup(d);d.close();s.close()',
        'print("ok")',
      ].join('\n')
      const r = spawnSync(probe.bin, [...(probe.preArgs || []), '-c', py, paths.db, backup], { encoding: 'utf8', timeout: 60000 })
      if (r.status !== 0) { backup = null }
    }
  } catch { backup = null }

  // ── 真正删除 ────────────────────────────────────────────────────────────
  // 语义：**标记 retired=1 而不是 DELETE**。理由：
  //   · 记忆之间没有外键，但「删了能不能捞回来」是用户最在意的事；
  //   · retired 行的 fp 会撞 UNIQUE(peer,fp) 约束，所以同时改写 fp（同 reindex 的手法）；
  //   · 真正物理清空留给「导出后删文件」那条路。
  // 对用户来说效果一样（检索/统计都过滤 retired=0），但挽回成本从「没救」变成「改一行 SQL」。
  const q = queryJson({
    cfg, probe, write: true,
    sql: clearingAll
      ? [
        ["UPDATE entries SET retired=1, fp=fp||'#cleared'||id WHERE retired=0", []],
      ]
      : [
        ["UPDATE entries SET retired=1, fp=fp||'#cleared'||id WHERE retired=0 AND owner=?", [ownerStr]],
      ],
  })
  if (!q.ok) return { ok: false, error: `清除失败：${q.reason}`, backup }

  return {
    ok: true,
    deleted: hits,
    owner: clearingAll ? null : ownerStr,
    all: clearingAll,
    backup: backup ? path.basename(backup) : null,
    // 说明清除的语义，前端原样显示（别让用户以为物理删除了）
    note: '记忆已标记为归档（retired=1）：检索与统计里不再出现，但数据仍在库里、随时可恢复。',
  }
}

/** 排出要打包的文件清单（白名单，见文件头 ③）。 */
export function exportList ({ cfg = {} } = {}) {
  const paths = memoryPaths(cfg)
  const out = []
  for (const f of EXPORT_FILES) {
    const p = path.join(paths.dir, f)
    let st = null
    try { st = fs.statSync(p) } catch { continue }
    if (!st.isFile()) continue
    out.push({ name: f, path: p, size: st.size })
  }
  for (const d of EXPORT_DIRS) {
    const p = path.join(paths.dir, d)
    let names = []
    try { names = fs.readdirSync(p) } catch { continue }
    for (const name of names) {
      const f = path.join(p, name)
      let st = null
      try { st = fs.statSync(f) } catch { continue }
      if (!st.isFile()) continue
      out.push({ name: `${d}/${name}`, path: f, size: st.size })
    }
  }
  return out
}

/**
 * 生成导出 zip。用 python 的 zipfile（标准库，跨平台，Windows 也不用装 zip 命令）。
 *
 * @returns {{ok:boolean, zipPath?, filename?, bytes?, entries?, error?}}
 */
export function memoryExport ({ cfg = {}, probe, outDir = null } = {}) {
  if (!probe?.ok) return { ok: false, error: `python 不可用：${probe?.reason || ''}` }
  const paths = memoryPaths(cfg)
  const files = exportList({ cfg })
  if (!files.length) return { ok: false, error: '没有可导出的记忆数据（库还没建？）' }

  const dir = outDir || path.join(os.tmpdir(), 'llminqq-exports')
  fs.mkdirSync(dir, { recursive: true })
  const filename = exportName()
  const zipPath = path.join(dir, filename)

  // 清单通过 JSON 文件传给 python：不拼命令行（文件名可能有空格/中文）
  const manifest = path.join(dir, `.export-manifest-${Date.now()}.json`)
  fs.writeFileSync(manifest, JSON.stringify({ out: zipPath, files: files.map(f => ({ name: f.name, path: f.path })) }), 'utf8')
  const py = [
    'import json,sys,zipfile,os',
    'm=json.load(open(sys.argv[1],encoding="utf-8"))',
    'z=zipfile.ZipFile(m["out"],"w",zipfile.ZIP_DEFLATED)',
    'n=0',
    'for f in m["files"]:',
    '  if os.path.exists(f["path"]):',
    '    z.write(f["path"],arcname=f["name"]); n+=1',
    'z.close()',
    'print(json.dumps({"entries":n,"bytes":os.path.getsize(m["out"])}))',
  ].join('\n')
  try {
    const r = spawnSync(probe.bin, [...(probe.preArgs || []), '-c', py, manifest], {
      encoding: 'utf8', timeout: 120000,
      env: { ...process.env, PYTHONIOENCODING: 'utf8', PYTHONDONTWRITEBYTECODE: '1' },
    })
    if (r.status !== 0) return { ok: false, error: `打包失败：${String(r.stderr || '').slice(0, 300)}` }
    const info = JSON.parse(String(r.stdout).trim().split('\n').pop())
    return { ok: true, zipPath, filename, bytes: info.bytes, entries: info.entries }
  } catch (err) {
    return { ok: false, error: `打包异常：${err.message}` }
  } finally {
    try { fs.unlinkSync(manifest) } catch { /* ignore */ }
  }
}

/**
 * 从 zip 恢复。**导入前自动备份现有数据**（任务明确要求，避免覆盖丢数据）。
 *
 * @param {object} opts
 * @param {string} opts.zipPath  上传后落盘的 zip 路径
 * @returns {{ok:boolean, restored?, backupDir?, error?}}
 */
export function memoryImport ({ cfg = {}, probe, zipPath } = {}) {
  if (!probe?.ok) return { ok: false, error: `python 不可用：${probe?.reason || ''}` }
  if (!zipPath || !fs.existsSync(zipPath)) return { ok: false, error: '没收到 zip 文件' }
  const paths = memoryPaths(cfg)
  const stateDir = memoryStateDir(cfg)
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })

  // ── ① 先备份现有数据（哪怕现在是空的也备份，动作统一好排查）──────────────
  let backupDir = null
  try {
    backupDir = path.join(stateDir, `backup-before-import-${Date.now()}`)
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 })
    for (const f of exportList({ cfg })) {
      const dest = path.join(backupDir, f.name)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.copyFileSync(f.path, dest)
    }
  } catch (err) {
    return { ok: false, error: `导入前备份失败，已中止（不冒险覆盖）：${err.message}` }
  }

  // ── ② 解压到临时目录，**先校验**再覆盖（半个 zip 不能毁掉现有库）────────
  const tmp = path.join(os.tmpdir(), `llminqq-import-${Date.now()}`)
  const py = [
    'import json,sys,zipfile,os',
    'src,dst=sys.argv[1],sys.argv[2]',
    'ALLOWED={"mem.db","style.db","lexicon.json","digest.md","style-cases.jsonl"}',
    'z=zipfile.ZipFile(src)',
    'bad=[]',
    'names=[]',
    'for n in z.namelist():',
    '  base=n.split("/")[0] if "/" in n else n',
    '  if n.startswith("corpus/") or n.startswith("log/") or base in ALLOWED:',
    '    names.append(n)',
    '  else: bad.append(n)',
    'z.extractall(dst,members=names)',
    'print(json.dumps({"restored":names,"skipped":bad}))',
  ].join('\n')
  let extracted = null
  try {
    const r = spawnSync(probe.bin, [...(probe.preArgs || []), '-c', py, zipPath, tmp], {
      encoding: 'utf8', timeout: 120000,
      env: { ...process.env, PYTHONIOENCODING: 'utf8', PYTHONDONTWRITEBYTECODE: '1' },
    })
    if (r.status !== 0) {
      fs.rmSync(tmp, { recursive: true, force: true })
      return { ok: false, error: `解压失败：${String(r.stderr || '').slice(0, 300)}`, backupDir: path.basename(backupDir) }
    }
    extracted = JSON.parse(String(r.stdout).trim().split('\n').pop())
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true })
    return { ok: false, error: `解压异常：${err.message}`, backupDir: path.basename(backupDir) }
  }

  // ── ③ 校验关键库可读（能打开 + 有 entries 表）─────────────────────────
  const dbTmp = path.join(tmp, 'mem.db')
  if (fs.existsSync(dbTmp)) {
    const chk = queryJson({ cfg: { memory: { stateDir: tmp } }, probe, sql: [['SELECT COUNT(*) AS n FROM entries', []]] })
    if (!chk.ok) {
      fs.rmSync(tmp, { recursive: true, force: true })
      return { ok: false, error: `导入的 mem.db 校验失败（不是有效记忆库）：${chk.reason}`, backupDir: path.basename(backupDir) }
    }
  }

  // ── ④ 覆盖到 stateDir ──────────────────────────────────────────────────
  const restored = []
  try {
    for (const name of extracted.restored) {
      const src = path.join(tmp, name)
      const dest = path.join(stateDir, name)
      if (!fs.existsSync(src)) continue
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.copyFileSync(src, dest)
      restored.push(name)
    }
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true })
    return {
      ok: false,
      error: `覆盖失败：${err.message}。原数据已备份在 ${path.basename(backupDir)}，可手动恢复`,
      backupDir: path.basename(backupDir),
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true })

  // ── ⑤ 校验条数（导入唯一有意义的判据）────────────────────────────────
  const after = memoryStats({ cfg, probe })
  return {
    ok: true,
    restored,
    skipped: extracted.skipped,
    backupDir: path.basename(backupDir),
    total: after.ok ? after.total : null,
    alive: after.ok ? after.alive : null,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// B站语料抓取（第四期第 ③ 项，**只做手动按钮，绝不自动定时**）
// ─────────────────────────────────────────────────────────────────────────────
//
// 为什么只手动：
//   PLAN §9 明确写了「crawl 自动定时 = 风控风险放大」。抓评论是按 LIKE 翻页，
//   翻多了会 -412；自动跑意味着「每天都去敲 B站的门」，风险是会累积的。
//   手动按钮 = 用户在场、想要才点，最坏情况也只是他今天多点了一次。
//
// 为什么还要限频（一天 ≤3 次）：
//   限频不是为了防用户，是为了防**连点**。按钮点一下要跑几分钟（12 个视频 ×
//   随机 sleep），用户等不及容易再点一次 —— 两次并发抓取会一起撞风控。
//   所以这里用状态文件记「今天点了几次」，超过就拒绝并说明。
//
// 依赖：bili-duty venv 里装了 bilibili_api + mcp（P1/P3 的产物）。
//   拿不到就**明确说缺什么**，不静默（和 P0b 同一条纪律）。
const CRAWL_STATE = 'crawl-state.json'
const CRAWL_PER_DAY = 3

function crawlRateKey (now = Date.now()) {
  const d = new Date(now)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

/** 读/写「今天点了几次」的状态（落在 stateDir，跨重启保留）。 */
function crawlStatePath (cfg) {
  return path.join(memoryStateDir(cfg), CRAWL_STATE)
}
export function crawlUsage ({ cfg = {} } = {}) {
  const file = crawlStatePath(cfg)
  let st = {}
  try { st = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { st = {} }
  const today = crawlRateKey()
  const used = st.date === today ? Number(st.count || 0) : 0
  return { today, used, limit: CRAWL_PER_DAY, remaining: Math.max(0, CRAWL_PER_DAY - used), lastRunAt: st.lastRunAt || null }
}

function bumpCrawlUsage ({ cfg }) {
  const file = crawlStatePath(cfg)
  const cur = crawlUsage({ cfg })
  const next = { date: cur.today, count: cur.used + 1, lastRunAt: Date.now() }
  try { fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 }) } catch { /* ignore */ }
  return next
}

/** 探测抓取所需的 python（bili-duty venv，不是系统 python —— 依赖装在那份里）。 */
export function probeCrawlEnv ({ cfg = {} } = {}) {
  // 路径解析交给 bili-python.mjs：以前这里写死 `~/.dsh/bili-duty/.venv/bin/python`，
  // 那是 Linux 布局，Windows 上永远找不到（venv 里是 Scripts/python.exe）。
  const resolved = resolveBiliPython(cfg)
  const venvPython = resolved.bin
  const mcpDir = resolveBiliRoot(cfg, venvPython)
  if (!venvPython) {
    const sample = resolved.tried.slice(0, 3).join('、')
    return {
      ok: false,
      reason: `没找到 bili-duty 的 python（找过：${sample}…）。先在 bili-duty 里建 venv 并装依赖，或用 learning.crawlPython 显式指定。`,
      tried: resolved.tried,
    }
  }
  // 真跑一次 import：文件存在不等于依赖装了（这正是本插件反复踩的坑）
  const r = spawnSync(venvPython, ['-c', 'import bilibili_api, mcp; print("ok")'], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] })
  if (r.status !== 0) {
    return {
      ok: false,
      reason: `B站抓取依赖没装全（${String(r.stderr || '').trim().split('\n').pop()?.slice(0, 160) || 'import 失败'}）。先装好 bilibili_api + mcp。`,
      python: venvPython,
    }
  }
  return { ok: true, python: venvPython, mcpDir }
}

/**
 * 跑一次抓取。**异步**（几分钟），失败不抛。
 *
 * @param {object} opts
 * @param {number} [opts.only]    只抓几个新视频（默认 2 —— 按钮跑一次别太久）
 * @param {boolean} [opts.dryRun] 只列清单，不发请求
 */
export async function runCrawl ({ cfg = {}, only = 2, dryRun = false, onChild = () => {} } = {}) {
  const usage = crawlUsage({ cfg })
  if (!dryRun && usage.remaining <= 0) {
    return { ok: false, error: `今天已经抓过 ${usage.used} 次（上限 ${CRAWL_PER_DAY} 次/天）。明天再来 —— 这是防连点撞 B站风控。`, usage }
  }
  const env = probeCrawlEnv({ cfg })
  if (!env.ok) return { ok: false, error: env.reason, usage }

  const paths = memoryPaths(cfg)
  const script = path.join(memoryCode(cfg).dir, '..', 'crawl-bili-comments.mjs')
  if (!fs.existsSync(script)) return { ok: false, error: `抓取脚本缺失：${script}（插件包不完整？）` }

  // 语料池落 stateDir（不是包里，见 crawl-bili-comments.mjs 顶部说明）
  const args = [
    script,
    '--out-dir', paths.corpus,
    '--python', env.python,
    '--mcp-dir', env.mcpDir,
    '--only', String(Math.max(1, Math.min(8, Number(only) || 2))),
    ...(dryRun ? ['--dry-run'] : []),
    '--json',
  ]
  const { spawn } = await import('node:child_process')
  const t0 = Date.now()
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, LLMINQQ_STATE_DIR: memoryStateDir(cfg), PYTHONIOENCODING: 'utf8' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    onChild(child)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* ignore */ } }, 20 * 60 * 1000)
    timer.unref?.()
    child.on('error', err => { clearTimeout(timer); resolve({ ok: false, error: String(err.message || err), usage }) })
    child.on('close', code => {
      clearTimeout(timer)
      let parsed = null
      try { parsed = JSON.parse(String(stdout).trim().split('\n').pop()) } catch { parsed = null }
      const ms = Date.now() - t0
      if (code !== 0) {
        const tail = String(stderr || '').trim().split('\n').filter(Boolean).pop() || `退出码 ${code}`
        // 风控（-412）要原样透出去：用户需要知道「是被限流了，不是程序坏了」
        const throttled = /-412|风控|412/.test(tail) || /-412|风控/.test(String(stdout))
        resolve({ ok: false, error: `${throttled ? 'B站限流（-412），已停止不再重试' : '抓取失败'}：${tail.slice(0, 200)}`, throttled, usage, ms })
        return
      }
      // ⚠️ 只有**真抓到东西**才计次。
      //   之前只要脚本退出码是 0 就 bump —— 清单为空 / 搜索没搜到 /
      //   全被风控跳过，这几种都退出 0 但一条没抓，用户点几下次数就没了。
      const got = Number(parsed?.fetched ?? 0) + Number(parsed?.files?.length ?? 0)
      const nothing = parsed?.skipped != null && Number(parsed?.fetched ?? 0) === 0
      if (!dryRun && got > 0) bumpCrawlUsage({ cfg })
      const usageNow = crawlUsage({ cfg })
      // 空跑要给明确原因，别让界面显示「学到 若干 个」
      const note = (() => {
        if (dryRun) return null
        if (got > 0) return null
        if (parsed?.skipped != null && Number(parsed?.skipped) > 0) {
          return `清单里的 ${parsed.skipped} 个视频都已经抓过了。要重抓加 --force，要扩池给 crawlSources 加新条目。`
        }
        if (parsed?.failed?.length) {
          return `${parsed.failed.length} 个视频没抓到：${parsed.failed.slice(0, 3).map(f => f.bvid + ' ' + f.error).join('；')}`
        }
        return '什么都没抓到（清单为空或搜索没结果）—— 检查 crawlSources 里是不是只写了空的 keyword。'
      })()
      resolve({ ok: true, result: parsed, ms, usage: usageNow, note: note || undefined, counted: !dryRun && got > 0 })
    })
  })
}

export { exportName, dbSizeBytes, queryJson, CRAWL_PER_DAY }
