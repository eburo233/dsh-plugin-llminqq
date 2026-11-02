// lib/memepack.js —— 表情包图库「随包分发 → 首次落位」。
//
// 背景（为什么会有这个模块）：
//   脚本版自带一份图库 `qq-agent/meme-pack/`（99 张图 + index.db 含义表），
//   AGENTS.md 里也写着「用插件自带的图库（工作区 meme-pack/ 下）」。
//   但封装成插件时**只搬了 AGENTS.md 那句话，图库本体没跟过来** ——
//   实测模型被告知去 ls meme-pack/memes/，那里根本不存在；只能去借第三方插件
//   dsh-expression 的 node_modules 图库，于是「学到的表情」也写进第三方包目录，
//   升级/重装那个包就一起没了。
//
// 这个模块把图库收回来：
//   1. 把随包的图片复制到 agent 工作区（= <dataDir>/agent/meme-pack）
//      —— 放在工作区里，[SEND_FILE] 白名单才放行（只允许 cwd 与暂存目录）；
//   2. 用随包的 meanings.json 重建 index.db（schema 与 dsh-expression 完全一致，
//      含 memes_fts，第三方面板/skill 都能直接读）；
//   3. **幂等**：已存在的图片不重拷、已存在的 DB 行 INSERT OR IGNORE ——
//      升级插件不能把用户/agent 后来自学进去的表情冲掉。
//
// 为什么用 python3 建 DB：Node 22 的 node:sqlite 还是实验特性，且插件本来就已经
// 依赖 python3（记忆系统）。python3 不在就只告警降级（图片照样可用，只是没有
// 索引表），不阻塞插件启动。

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

/** 随包图库相对插件根目录的位置 */
export const BUNDLED_PACK_REL = path.join('qq-agent', 'meme-pack')
/** 图库落位相对 agent 工作区的位置（AGENTS.md 与 skill 都按这个路径找） */
export const AGENT_PACK_REL = 'meme-pack'

// 与 dsh-expression 的 index.db 完全一致的 schema。
// 为什么不能自创字段：Web 端面板、qq-meme skill、以及将来的导入工具都按这份读；
// 多一列少一列都会让某一方静默读不到数据。
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memes (
  path TEXT PRIMARY KEY,
  tag TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_hash TEXT,
  caption TEXT NOT NULL DEFAULT '',
  keywords TEXT NOT NULL DEFAULT '',
  mtime REAL,
  captioned_at REAL
);
CREATE INDEX IF NOT EXISTS idx_memes_tag ON memes(tag);
CREATE INDEX IF NOT EXISTS idx_memes_captioned ON memes(captioned_at);
CREATE VIRTUAL TABLE IF NOT EXISTS memes_fts USING fts5(
  path UNINDEXED,
  tag,
  caption,
  keywords,
  file_name,
  tokenize = 'unicode61'
);
`

/**
 * 用 meanings.json 把 DB 建起来（或补齐缺的行）。
 * 单独抽出来是为了能单测：传入一个假的 pythonBin 就能验证「失败只告警不炸」。
 *
 * @param {object} opts
 * @param {string} opts.dbPath
 * @param {string} opts.meaningsPath
 * @param {string} [opts.pythonBin]
 * @returns {{ok:boolean, before?:number, after?:number, reason?:string}}
 */
export function buildIndexDb ({ dbPath, meaningsPath, pythonBin = 'python3' }) {
  const script = `
import sys, json, time, sqlite3
db, meanings_path = sys.argv[1], sys.argv[2]
rows = json.load(open(meanings_path, encoding='utf-8'))
con = sqlite3.connect(db)
con.executescript(sys.argv[3])
now = time.time()
before = con.execute('SELECT COUNT(*) FROM memes').fetchone()[0]
con.executemany(
    'INSERT OR IGNORE INTO memes (path, tag, file_name, file_hash, caption, keywords, mtime, captioned_at) '
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [(r['path'], r['tag'], r['file_name'], r.get('file_hash'), r.get('caption') or '',
      r.get('keywords') or '', now, now) for r in rows],
)
after = con.execute('SELECT COUNT(*) FROM memes').fetchone()[0]
# FTS 表整表重建：行数很少（~100），比维护触发器简单可靠，也不会漏行
con.execute('DELETE FROM memes_fts')
con.execute('INSERT INTO memes_fts (path, tag, caption, keywords, file_name) '
            'SELECT path, tag, caption, keywords, file_name FROM memes')
con.commit()
print(json.dumps({'before': before, 'after': after}))
`
  try {
    const out = execFileSync(pythonBin, ['-c', script, dbPath, meaningsPath, SCHEMA_SQL], {
      encoding: 'utf8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const r = JSON.parse(String(out).trim() || '{}')
    return { ok: true, before: r.before ?? 0, after: r.after ?? 0 }
  } catch (err) {
    return { ok: false, reason: String(err?.stderr || err?.message || err).trim().slice(0, 300) }
  }
}

/**
 * 把随包图库落位到 agent 工作区（幂等）。
 *
 * @param {object} opts
 * @param {string} opts.pluginRoot 插件根目录（含 qq-agent/meme-pack）
 * @param {string} opts.agentDir   agent 工作区（= 模型 cwd）
 * @param {(msg:string)=>void} [opts.log]
 * @param {string} [opts.pythonBin]
 * @returns {{ok:boolean, dir?:string, copied?:number, added?:number, reason?:string}}
 */
export function ensureMemePack ({ pluginRoot, agentDir, log = () => {}, pythonBin = 'python3' } = {}) {
  if (!pluginRoot || !agentDir) return { ok: false, reason: '缺少 pluginRoot 或 agentDir' }
  const src = path.join(pluginRoot, BUNDLED_PACK_REL)
  const srcImages = path.join(src, 'memes')
  const dst = path.join(agentDir, AGENT_PACK_REL)

  if (!fs.existsSync(srcImages)) {
    // 打包丢了图库（就是这个模块要修的问题）—— 明确告警，别静默
    log(`WARN 随包表情库不存在：${srcImages}（表情包功能将只能借用第三方插件图库）`)
    return { ok: false, reason: '随包图库不存在' }
  }

  fs.mkdirSync(dst, { recursive: true, mode: 0o700 })

  // ① 复制图片：只补缺失，不覆盖已有文件（用户可能自己换过图/加过同路径图）
  let copied = 0
  for (const tag of fs.readdirSync(srcImages, { withFileTypes: true })) {
    if (!tag.isDirectory()) continue
    const fromDir = path.join(srcImages, tag.name)
    const toDir = path.join(dst, 'memes', tag.name)
    fs.mkdirSync(toDir, { recursive: true, mode: 0o700 })
    for (const f of fs.readdirSync(fromDir, { withFileTypes: true })) {
      if (!f.isFile()) continue
      const from = path.join(fromDir, f.name)
      const to = path.join(toDir, f.name)
      if (fs.existsSync(to)) continue
      fs.copyFileSync(from, to)
      copied++
    }
  }

  // ② 建/补 index.db
  const meaningsPath = path.join(src, 'meanings.json')
  if (!fs.existsSync(meaningsPath)) {
    log(`WARN 随包图库缺 meanings.json：${meaningsPath}（只有图片，没有含义索引）`)
    return { ok: false, dir: dst, copied, reason: '缺 meanings.json' }
  }
  const dbPath = path.join(dst, 'index.db')
  const built = buildIndexDb({ dbPath, meaningsPath, pythonBin })
  if (!built.ok) {
    log(`WARN 表情库 index.db 构建失败（图片已就位）：${built.reason}`)
    return { ok: false, dir: dst, copied, reason: built.reason }
  }
  const added = Math.max(0, (built.after ?? 0) - (built.before ?? 0))
  if (copied || added) {
    log(`表情库就位：${dst}（新图 ${copied} 张，新索引 ${added} 行，共 ${built.after} 行）`)
  }
  return { ok: true, dir: dst, copied, added, total: built.after ?? 0 }
}
