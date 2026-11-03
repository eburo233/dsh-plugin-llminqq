#!/usr/bin/env node
// scripts/memory-audit.mjs —— 记忆库**只读**审计（记忆 v5 Step 0 的验收工具）
// ============================================================================
// 为什么要有这个脚本（docs/MEMORY-AUDIT-AND-V5.md §5/§6）：
//   审计文档里的关键指标（注入残留 / 80 字截断 / prune 可归档量 / digest 三层 /
//   重复组 / 短句噪音 / 两份 style.db）现在只能靠一篇文档里的 N 段 `python3 -c`
//   手工拼。验收要可重复、可对比、可进 CI，就必须有一个**一条命令跑完**的东西。
//
// 三条硬约束（违反任何一条这个脚本就没有意义）：
//   ① **默认只读**：库用 `file:...?mode=ro` 打开 + `PRAGMA query_only=ON`；
//      脚本不创建/不删除/不迁移任何文件。跑完还会比对库文件 sha256，
//      前后不一致直接非 0 退出（自证「真的没写」）。
//   ② **默认拒绝生产路径**：直接指到 `~/.dsh/...` 下会拒绝运行 —— 正确姿势是
//      `cp` 一份副本到 /tmp 再审计。只有显式 `--allow-prod-copy`（且仍然只读）
//      才放行，用于「我就是想看这份副本、但它放在生产目录旁边」的场景。
//   ③ 指标口径固定：每个数字都标注统计口径（active / 全表），避免「两个人都说
//      注入残留 2 条，一个算全表一个算有效条目」这种扯皮。
//
// 用法：
//   cp ~/.dsh/dsh-plugin-llminqq/agent/memory/mem.db /tmp/mem.db
//   node scripts/memory-audit.mjs --db /tmp/mem.db --data-dir /tmp/dsh-data-copy
//   node scripts/memory-audit.mjs --db /tmp/mem.db --json        # 机器可读
//   node scripts/memory-audit.mjs --db /tmp/mem.db --strict      # CI 用：有 P0 项即 exit 1
// ============================================================================
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const DEFAULT_CODE_DIR = path.join(ROOT, 'lib', 'agent', 'memory')

// ── 参数 ────────────────────────────────────────────────────────────────────
function usage (msg) {
  if (msg) process.stderr.write(`memory-audit: ${msg}\n\n`)
  process.stderr.write([
    '用法: node scripts/memory-audit.mjs --db <库副本路径> [选项]',
    '',
    '  --db <path>            必填。要审计的 mem.db（**建议 /tmp 副本**）',
    '  --digest <path>        digest.md 路径（默认取库旁边那份）',
    '  --data-dir <path>      插件数据目录（用于检查两份 style.db；可选）',
    '  --code-dir <path>      memctl.py 所在目录（默认仓库 lib/agent/memory）',
    '  --python <bin>         python 解释器（默认 python3）',
    '  --json                 输出 JSON（CI/脚本用）',
    '  --strict               有 P0 项（注入残留/截断/重复/style.db 分叉）时 exit 1',
    '  --allow-prod-copy      允许把路径指到生产目录下（仍只读打开）',
    '  -h, --help             显示本帮助',
  ].join('\n') + '\n')
  process.exit(msg ? 2 : 0)
}

function parseArgs (argv) {
  const out = { json: false, strict: false, allowProdCopy: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const take = () => {
      const v = argv[++i]
      if (v == null || v.startsWith('--')) usage(`${a} 需要一个值`)
      return v
    }
    if (a === '--db') out.db = take()
    else if (a === '--digest') out.digest = take()
    else if (a === '--data-dir') out.dataDir = take()
    else if (a === '--code-dir') out.codeDir = take()
    else if (a === '--python') out.python = take()
    else if (a === '--json') out.json = true
    else if (a === '--strict') out.strict = true
    else if (a === '--allow-prod-copy') out.allowProdCopy = true
    else if (a === '-h' || a === '--help') usage('')
    else usage(`未知参数 ${a}`)
  }
  if (!out.db) usage('缺少 --db')
  return out
}

// ── 生产路径守卫 ─────────────────────────────────────────────────────────────
/** 生产数据目录候选（和 lib/store.js dataDir() 的推导口径一致：DSH_HOME / ~/.dsh）。 */
function prodRoots () {
  const roots = [path.join(os.homedir(), '.dsh')]
  for (const k of ['DSH_HOME', 'LLMINQQ_DATA_DIR']) {
    if (process.env[k]) roots.push(process.env[k])
  }
  return roots.map(r => {
    try { return path.resolve(r.replace(/^~/, os.homedir())) } catch { return '' }
  }).filter(Boolean)
}

/** 这个路径是不是落在生产数据目录里（`.dsh/...`）。 */
function isProdPath (p) {
  const abs = path.resolve(p)
  return prodRoots().some(root => abs === root || abs.startsWith(root + path.sep))
}

// ── 只读打开 + 自证 ──────────────────────────────────────────────────────────
function sha256 (file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') } catch { return null }
}

/**
 * 用 python 跑只读查询（node:sqlite 在不同 Node 版本上可用性不一致，
 * 而记忆系统本来就依赖 python；统一走 python 少一条分支、口径也和 memctl 一致）。
 *
 * 传入的 python 片段必须只用 `conn` 做 SELECT；连接是 `mode=ro` + query_only，
 * 物理上不可能写库。
 */
function runPythonAudit ({ python, db, codeDir, styleDbs }) {
  const PY = `
import json, sqlite3, sys, urllib.parse
sys.dont_write_bytecode = True          # 别在只读的包里留 __pycache__
args = json.loads(sys.argv[1])

def ro(path):
    # mode=ro：物理上不可能写库；路径统一走 urllib 转义（中文/特殊字符都安全）
    return sqlite3.connect("file:%s?mode=ro" % urllib.parse.quote(path, safe="/"), uri=True)

sys.path.insert(0, args["codeDir"])
import memctl as m                      # 只用它的 NOISE/prune 判定，不碰 m.DB
conn = ro(args["db"])
conn.row_factory = sqlite3.Row
conn.execute("PRAGMA query_only=ON")    # 双保险：只读连接 + query_only
out = {}

def scalar(sql, args=()):
    return conn.execute(sql, args).fetchone()[0]

out["total"] = scalar("SELECT COUNT(*) FROM entries")
out["active"] = scalar("SELECT COUNT(*) FROM entries WHERE retired=0")
out["retired"] = out["total"] - out["active"]
out["pinnedActive"] = scalar("SELECT COUNT(*) FROM entries WHERE retired=0 AND pinned=1")
out["kinds"] = {r["kind"]: r["n"] for r in conn.execute(
    "SELECT kind, COUNT(*) n FROM entries WHERE retired=0 GROUP BY kind")}
out["maxTextLen"] = scalar("SELECT IFNULL(MAX(LENGTH(text)),0) FROM entries")
# 口径：P1-1「写入时截断到 80 字」→ 库里长度恰好 80 的行（active + 全表都给）
out["truncated80Active"] = scalar(
    "SELECT COUNT(*) FROM entries WHERE retired=0 AND LENGTH(text)=80")
out["truncated80Total"] = scalar("SELECT COUNT(*) FROM entries WHERE LENGTH(text)=80")

# 重复记忆组（同 peer + 同 text；历史 fp 算法变更遗留）
out["dupGroupsActive"] = scalar(
    "SELECT COUNT(*) FROM (SELECT 1 FROM entries WHERE retired=0 "
    "GROUP BY peer, text HAVING COUNT(*)>1)")
out["dupGroupsTotal"] = scalar(
    "SELECT COUNT(*) FROM (SELECT 1 FROM entries GROUP BY peer, text HAVING COUNT(*)>1)")

# 短句噪音 + NOISE 精确命中（P1-6 的口径：拦截率 = 命中白名单 / 短句数）
out["shortTextsActive"] = scalar(
    "SELECT COUNT(*) FROM entries WHERE retired=0 AND LENGTH(text)<12")
noise = sorted(m.NOISE)
ph = ",".join("?" * len(noise))
out["noiseSize"] = len(noise)
out["noiseExactHits"] = scalar(
    "SELECT COUNT(*) FROM entries WHERE retired=0 AND text IN (%s)" % ph, tuple(noise))
out["noiseInterceptionRate"] = round(
    (out["noiseExactHits"] / out["shortTextsActive"]) if out["shortTextsActive"] else 0.0, 4)

# 注入残留（P0-5 / §5「prompt 注入残留」）：控制标记 + 排版污染 + 注入句式
RESIDUE = [
    ("SEND_FILE 控制标记", "%SEND_FILE%"),
    ("SILENT 控制标记", "%[SILENT]%"),
    ("VOICE 控制标记", "%[VOICE:%"),
    ("「忽略之前」注入句式", "%忽略之前%"),
    ("「原样输出」注入句式", "%原样输出%"),
    ("卡片/小程序占位", "%[卡片]%"),
    ("合并轮排版前缀", "%【这是他在同一轮里补的一条】%"),
]
out["injectionResidue"] = []
for label, pat in RESIDUE:
    out["injectionResidue"].append({
        "label": label,
        "active": scalar("SELECT COUNT(*) FROM entries WHERE retired=0 AND text LIKE ?", (pat,)),
        "total": scalar("SELECT COUNT(*) FROM entries WHERE text LIKE ?", (pat,)),
    })

# prune 可归档量（口径随实现：新三元组 / 旧 combine 分数）
cand = conn.execute("SELECT * FROM entries WHERE retired=0 AND pinned=0").fetchall()
if hasattr(m, "_prune_verdict"):
    out["prune"] = {
        "method": "prune-verdict(salience+hits+age 三元组)",
        "archivable": sum(1 for r in cand if m._prune_verdict(r)),
        "candidates": len(cand),
    }
else:
    cutoff = 0.15
    out["prune"] = {
        "method": "legacy combine()<%.2f" % cutoff,
        "archivable": sum(1 for r in cand if m.combine(r) < cutoff),
        "candidates": len(cand),
    }
out["pinnedLowValue"] = scalar(
    "SELECT COUNT(*) FROM entries WHERE retired=0 AND pinned=1 AND importance<0.35")

# style.db（两份库分叉 = P1-4）：存在性 + 条数（表不存在时 rows=None）
out["styleDbs"] = []
for p in args["styleDbs"]:
    item = {"path": p, "exists": False, "rows": None, "error": None}
    try:
        import os
        if os.path.isfile(p):
            item["exists"] = True
            c2 = ro(p)
            c2.execute("PRAGMA query_only=ON")
            try:
                item["rows"] = c2.execute("SELECT COUNT(*) FROM style_samples").fetchone()[0]
            except sqlite3.Error:
                item["rows"] = None
            c2.close()
    except Exception as e:
        item["error"] = str(e)[:200]
    out["styleDbs"].append(item)

print(json.dumps(out, ensure_ascii=False))
`
  const r = spawnSync(python, ['-c', PY, JSON.stringify({ db, codeDir, styleDbs })], {
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, PYTHONIOENCODING: 'utf8', PYTHONDONTWRITEBYTECODE: '1' },
  })
  if (r.error) throw new Error(`起 python 失败：${r.error.message}`)
  if (r.status !== 0) throw new Error(`python 审计失败（退出码 ${r.status}）：${(r.stderr || r.stdout || '').slice(-800)}`)
  return JSON.parse(String(r.stdout).trim().split('\n').pop())
}

// ── digest 检查（P0-4：三层是否都在、逐层轮转是否生效）──────────────────────
function auditDigest (digestPath) {
  const out = { path: digestPath, exists: false, bytes: 0, peers: 0, layers: [], peersOnlyOneLayer: 0 }
  let raw
  try { raw = fs.readFileSync(digestPath, 'utf8') } catch { return out }
  out.exists = true
  out.bytes = Buffer.byteLength(raw, 'utf8')
  const tags = { 程序: '[程序]', 语义: '[语义]', 情节: '[情节]' }
  const legacy = { 程序: '程序记忆', 语义: '语义记忆', 情节: '情节记忆' }
  const present = new Set()
  const perPeer = new Map()
  let peer = null
  for (const line of raw.split('\n')) {
    if (line.startsWith('## ')) { peer = line.slice(3).trim(); perPeer.set(peer, new Set()); continue }
    if (!peer) continue
    for (const [name, tag] of Object.entries(tags)) {
      if (line.includes(tag) || line.includes(legacy[name])) {
        present.add(name)
        perPeer.get(peer).add(name)
      }
    }
  }
  out.layers = Object.keys(tags).filter(k => present.has(k))
  out.peers = perPeer.size
  // 只呈现一层的节 = P0-4 的典型症状（三层预算没生效时，420 字里只剩程序记忆）
  out.peersOnlyOneLayer = [...perPeer.values()].filter(s => s.size === 1).length
  return out
}

// ── main ───────────────────────────────────────────────────────────────────
function main () {
  const a = parseArgs(process.argv.slice(2))
  const db = path.resolve(a.db)
  const codeDir = path.resolve(a.codeDir || DEFAULT_CODE_DIR)
  const python = a.python || process.env.LLMINQQ_PYTHON || 'python3'
  const digest = path.resolve(a.digest || path.join(path.dirname(db), 'digest.md'))

  if (!fs.existsSync(db)) usage(`库不存在：${db}`)
  if (a.dataDir && isProdPath(a.dataDir) && !a.allowProdCopy) {
    usage(`拒绝直接扫描生产数据目录：${a.dataDir}（先 cp 成副本再加 --data-dir；或加 --allow-prod-copy，仍只读）`)
  }
  if (isProdPath(db) && !a.allowProdCopy) {
    process.stderr.write([
      `memory-audit: 拒绝直接审计生产路径：${db}`,
      '  · 生产库只读也不行 —— 用副本最安全：',
      '      cp ~/.dsh/dsh-plugin-llminqq/agent/memory/mem.db /tmp/mem.db',
      '      node scripts/memory-audit.mjs --db /tmp/mem.db',
      '  · 确认那份「副本」就在生产目录下（比如备份目录）时，显式加 --allow-prod-copy。',
      '',
    ].join('\n'))
    process.exit(2)
  }

  const shaBefore = sha256(db)

  // style.db 候选：插件版有两处历史位置（P1-4 分叉就发生在这两个目录之间）
  const styleDbs = []
  if (a.dataDir) {
    const dataDir = path.resolve(a.dataDir)
    for (const rel of [path.join('state', 'style.db'), path.join('agent', 'memory', 'style.db')]) {
      styleDbs.push(path.join(dataDir, rel))
    }
  }

  const dbMetrics = runPythonAudit({ python, db, codeDir, styleDbs })
  const digestMetrics = auditDigest(digest)

  // 自证只读：库文件前后 sha256 必须一致
  const shaAfter = sha256(db)
  const dbUnchanged = shaBefore === shaAfter && shaBefore !== null

  const styleExisting = (dbMetrics.styleDbs || []).filter(s => s.exists)
  const p0 = {
    injectionResidue: dbMetrics.injectionResidue.reduce((n, r) => n + (r.active || 0), 0),
    truncated80: dbMetrics.truncated80Active,
    dupGroups: dbMetrics.dupGroupsActive,
    styleDbSplitBrain: styleExisting.length > 1,
    digestLayersMissing: digestMetrics.exists ? (3 - digestMetrics.layers.length) : 3,
  }

  const report = {
    generatedAt: new Date().toISOString(),
    db: {
      path: db,
      bytes: fs.statSync(db).size,
      sha256: shaBefore,
      unchangedAfterAudit: dbUnchanged,
    },
    digest: digestMetrics,
    entries: {
      total: dbMetrics.total,
      active: dbMetrics.active,
      retired: dbMetrics.retired,
      pinnedActive: dbMetrics.pinnedActive,
      kinds: dbMetrics.kinds,
      maxTextLen: dbMetrics.maxTextLen,
    },
    checks: {
      truncated80: { active: dbMetrics.truncated80Active, total: dbMetrics.truncated80Total, note: '口径：LENGTH(text)=80（P1-1 写入截断）' },
      duplicateGroups: { active: dbMetrics.dupGroupsActive, total: dbMetrics.dupGroupsTotal, note: '口径：GROUP BY peer,text HAVING COUNT(*)>1（P1-4/reindex）' },
      shortTextNoise: {
        shortTextsActive: dbMetrics.shortTextsActive,
        noiseSize: dbMetrics.noiseSize,
        noiseExactHits: dbMetrics.noiseExactHits,
        interceptionRate: dbMetrics.noiseInterceptionRate,
        note: '拦截率 = NOISE 精确命中 / 短句数（P1-6 的原始口径）',
      },
      injectionResidue: { items: dbMetrics.injectionResidue, activeSum: p0.injectionResidue, note: '控制标记/排版污染/注入句式（P0-5、§5）' },
      prune: { ...dbMetrics.prune, note: '可归档量（P0-2；钉住的不算）' },
      pinnedLowValue: dbMetrics.pinnedLowValue,
      styleDbs: {
        candidates: dbMetrics.styleDbs,
        splitBrain: p0.styleDbSplitBrain,
        note: '两份 style.db 都存在 = P1-4 的桥/调度器 stateDir 分叉',
      },
      digestLayers: {
        ...digestMetrics,
        missing: p0.digestLayersMissing,
        note: '三层都要在；peersOnlyOneLayer 是 P0-4 的典型症状',
      },
    },
    p0,
    readOnly: dbUnchanged,
  }

  if (a.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  } else {
    printTable(report)
  }

  if (!dbUnchanged) {
    process.stderr.write('memory-audit: ✗ 库文件在审计前后 hash 不一致 —— 脚本不该写库，请立即排查\n')
    process.exit(1)
  }
  if (a.strict) {
    const bad = Object.entries(p0).filter(([, v]) => v)
    if (bad.length) {
      process.stderr.write(`memory-audit: --strict 未通过：${bad.map(([k]) => k).join(', ')}\n`)
      process.exit(1)
    }
  }
}

function printTable (r) {
  const pad = (s, n) => String(s).padEnd(n)
  const L = []
  L.push('=== 记忆库审计（只读）===')
  L.push(`库      ${r.db.path}（${(r.db.bytes / 1024).toFixed(1)} KB）`)
  L.push(`sha256  ${r.db.sha256?.slice(0, 16)}…  审计后未改动: ${r.readOnly ? '是' : '否 !!'}`)
  L.push(`条目    全表 ${r.entries.total} · 有效 ${r.entries.active} · 归档 ${r.entries.retired} · 钉住 ${r.entries.pinnedActive}`)
  L.push(`分层    ${Object.entries(r.entries.kinds).map(([k, n]) => `${k}=${n}`).join(' · ') || '(空)'}`)
  L.push('')
  const c = r.checks
  L.push(`① 注入残留     有效 ${c.injectionResidue.activeSum} 条`)
  for (const it of c.injectionResidue.items) {
    if (it.active || it.total) L.push(`   - ${pad(it.label, 18)} active=${it.active} total=${it.total}`)
  }
  L.push(`② 80 字截断    有效 ${c.truncated80.active} 条 / 全表 ${c.truncated80.total} 条`)
  L.push(`③ prune 可归档 ${c.prune.archivable} / ${c.prune.candidates} 条候选（${c.prune.method}）`)
  L.push(`④ digest 三层  存在=${r.digest.exists} 三层=${r.digest.layers.join('/') || '(无)'} peers=${r.digest.peers} 只有一层的节=${r.digest.peersOnlyOneLayer}`)
  L.push(`⑤ 重复记忆组   有效 ${c.duplicateGroups.active} 组 / 全表 ${c.duplicateGroups.total} 组`)
  L.push(`⑥ 短句噪音     有效短句(<12字) ${c.shortTextNoise.shortTextsActive} 条 · NOISE 命中 ${c.shortTextNoise.noiseExactHits} · 拦截率 ${(c.shortTextNoise.interceptionRate * 100).toFixed(1)}%`)
  if (c.styleDbs.candidates.length) {
    L.push(`⑦ style.db     ${c.styleDbs.splitBrain ? '✗ 存在两份（split-brain）' : '✓ 只有一份'}`)
    for (const s of c.styleDbs.candidates) {
      L.push(`   - ${pad(s.path, 52)} exists=${s.exists} rows=${s.rows == null ? '?' : s.rows}`)
    }
  } else {
    L.push('⑦ style.db     未检查（给 --data-dir 才检查两份库是否分叉）')
  }
  L.push('')
  const p0 = r.p0
  L.push(`P0 汇总  注入残留 ${p0.injectionResidue} · 截断 ${p0.truncated80} · 重复组 ${p0.dupGroups} · style.db分叉 ${p0.styleDbSplitBrain ? '是' : '否'} · digest缺层 ${p0.digestLayersMissing}`)
  process.stdout.write(L.join('\n') + '\n')
}

main()
