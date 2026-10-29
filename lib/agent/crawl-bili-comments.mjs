#!/usr/bin/env node
/**
 * crawl-bili-comments.mjs —— 把 B站**公开评论区**抓成语料池，供 lexicon.py 分层学习。
 *
 * 为什么要有这个脚本（而不是让 lexicon.py 直接多抓几个源）：
 *   ① 语料池 ≠ 单次输入量。实测 learn 一轮 12 段/7000 字要 520s，把 4000 条评论
 *      直接喂进一轮必然超时且模型后半段退化。所以**抓取**和**学习**要分开：
 *      这里只负责把池子攒大（慢、低频、能断点续抓），学习每轮只吃 15-20 段。
 *   ② 抓取要跨分区防过拟合。吉祥物自己在二次元圈，只学动画区会越学越窄，
 *      所以要拼历史/科技/美食/游戏/生活/科普，动画区**少放**。
 *   ③ 风控。评论接口按 LIKE 排序翻页，翻多了会 -412。所以视频之间随机 sleep、
 *      每 3 个视频歇一会儿，**遇到限流立刻停**，绝不硬刷（重试只会把风控拖长）。
 *
 * 为什么复用 bili-duty 那份 mcp_server 的 bili_comments（同一个实现，不另写一套）：
 *   项目自带 python3 没装 bilibili_api，只有 bili-duty 的 venv 有；而且那份实现
 *   已经处理好了凭证读取和"抓取失败不能吞成 0 条"的语义（见它的注释）。
 *   所以这里跟 lexicon.fetch_bili 一样走 subprocess，只额外多拿一份视频信息（标题/分区用）。
 *
 * 落盘（CONTRIBUTING §9：路径必须能被 config 覆盖，测试才能全部引开）：
 *   config.learning.corpusDir      → 语料池目录（默认 qq-agent/memory/corpus）
 *   config.learning.crawlPython    → 跑 bili_comments 的 python（默认 bili-duty venv）
 *   config.learning.crawlMcpDir    → mcp_server.py 所在目录
 *   config.learning.crawlNum       → 每个视频抓多少条一级评论（默认 100）
 *   config.learning.crawlSources   → [{bvid, domain}, ...] 抓取清单
 * 也可以用命令行/环境变量覆盖（测试用 LLMINQQ_CRAWL_FAKE_PYTHON 假装是 venv）。
 *
 * 用法：
 *   node scripts/crawl-bili-comments.mjs                     # 配置里的清单，跳过已抓的
 *   node scripts/crawl-bili-comments.mjs --only 3            # 定时任务：这轮只抓 3 个新视频
 *   node scripts/crawl-bili-comments.mjs --dry-run           # 只看还要抓哪些，不发请求
 *   node scripts/crawl-bili-comments.mjs --force --num 120    # 重抓 + 每个视频 120 条
 *   node scripts/crawl-bili-comments.mjs --sources /tmp/s.json --out-dir /tmp/corpus
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolveBiliPython, resolveBiliRoot } from './bili-python.mjs'

// ── 插件化适配（PR 说明：这一处是唯一改动，其余原样）────────────────────────
// 原脚本在仓库 scripts/ 下，用「往上两级 = 仓库根」推 qq-agent/memory。
// 搬进插件后本文件在 lib/agent/ 下，那两个路径都不存在了，所以：
//   · 语料池默认落 stateDir（~/.dsh/llminqq/corpus），由调用方通过 --out-dir 传；
//   · ROOT 只作「相对路径的兜底基准」存在（保留原语义，不再用于算 memory 目录）。
// 不在这里硬编码 stateDir：这个脚本被 memory-admin 当子进程调，路径由它传，
// 脚本自己不去猜（CONTRIBUTING §9：路径必须能被调用方覆盖）。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const MEMORY_DIR = path.join(
  process.env.LLMINQQ_STATE_DIR || path.join(os.homedir(), '.dsh', 'llminqq'))

// ── 领域：分层采样的 key，也是 lexicon 里 source 的后缀（bili:<domain>）────────────
// 动画只留 1 个源：吉祥物自己就在二次元圈，学多了会过拟合到「本来的样子」。
const DOMAINS = ['history', 'tech', 'food', 'game', 'life', 'science', 'animation']

const DEFAULTS = {
  num: 100,                 // 一级评论条数（每条带最多 2 条楼中楼）
  gapMinMs: 3000,           // 视频之间 sleep 3-5s（随机）
  gapMaxMs: 5000,
  batchEvery: 3,            // 每 3 个视频…
  batchPauseMinMs: 15000,   // …歇 15-20s
  batchPauseMaxMs: 20000,
  fetchTimeoutMs: 240000,   // 单个视频（信息 + 5 页评论）的超时
}

// ─────────────────────────────────────────────────────────────────────────────
// 配置 / 路径（全部可覆盖，见文件头）
// ─────────────────────────────────────────────────────────────────────────────
function parseArgs (argv) {
  const a = { only: 0, force: false, dryRun: false, json: false, num: null, quiet: false }
  for (let i = 0; i < argv.length; i++) {
    const s = argv[i]
    if (s === '--config') a.config = argv[++i]
    else if (s === '--sources') a.sources = argv[++i]
    else if (s === '--out-dir') a.outDir = argv[++i]
    else if (s === '--python') a.python = argv[++i]
    else if (s === '--mcp-dir') a.mcpDir = argv[++i]
    else if (s === '--num') a.num = Number(argv[++i])
    else if (s === '--only') a.only = Number(argv[++i])
    else if (s === '--force') a.force = true
    else if (s === '--dry-run') a.dryRun = true
    else if (s === '--json') a.json = true
    else if (s === '--quiet') a.quiet = true
    else if (s === '--help' || s === '-h') { a.help = true }
    else { console.error(`未知参数: ${s}（--help 看用法）`); process.exit(2) }
  }
  return a
}

function loadConfig (p) {
  const cfgPath = p || process.env.LLMINQQ_CONFIG || path.join(ROOT, 'bridge/config.json')
  try { return JSON.parse(fs.readFileSync(cfgPath, 'utf8')) } catch { return {} }
}

function resolveFrom (base, v) {
  return path.isAbsolute(v) ? v : path.resolve(base, v)
}

function settings (args) {
  const cfg = loadConfig(args.config)
  const learn = cfg.learning || {}
  const cfgDir = args.config ? path.dirname(path.resolve(args.config)) : path.join(ROOT, 'bridge')
  const homedir = process.env.HOME || os.homedir()
  // python 交给 bili-python.mjs 解析：原来这里写死 `.venv/bin/python`（Linux 布局），
  // 而 Windows 的 venv 是 `Scripts/python.exe` —— 于是「装了依赖也永远找不到」。
  const resolved = resolveBiliPython(cfg)
  const explicitPython = process.env.LLMINQQ_CRAWL_PYTHON || learn.crawlPython || ''
  return {
    outDir: args.outDir || resolveFrom(ROOT,
      process.env.LLMINQQ_CORPUS_DIR || learn.corpusDir || path.join('qq-agent/memory/corpus')),
    python: args.python || (explicitPython ? resolveFrom(homedir, explicitPython) : resolved.bin),
    mcpDir: args.mcpDir
      || (learn.crawlMcpDir ? resolveFrom(homedir, learn.crawlMcpDir) : '')
      || resolveBiliRoot(cfg, resolved.bin),
    num: args.num ?? Number(process.env.LLMINQQ_CRAWL_NUM || learn.crawlNum || DEFAULTS.num),
    cfg,
    cfgDir,
  }
}

/**
 * 抓取清单。优先级：命令行 --sources > config.learning.crawlSources。
 * 接受两种写法：
 *   [{bvid:"BV1xx", domain:"history"}, ...]        ← 推荐（domain 是分层采样的 key）
 *   ["BV1xx", "BV1yy"]                            ← 只给 BV 号（domain 记 unknown）
 * 为什么 domain 一定要手填而不是猜：分区有几十个，靠标题猜会把历史区猜成生活区，
 * 分层采样就变成按错的组分配额度 —— 猜错比不填更糟。
 */
function loadSources (args, st) {
  let raw = []
  if (args.sources) {
    if (fs.existsSync(args.sources)) raw = JSON.parse(fs.readFileSync(args.sources, 'utf8'))
    else raw = JSON.parse(args.sources)          // 也支持内联 JSON
    if (raw && !Array.isArray(raw)) raw = raw.sources || raw.crawlSources || []
  } else {
    raw = (st.cfg.learning && st.cfg.learning.crawlSources) || []
  }
  const out = []
  const seen = new Set()
  for (const it of raw) {
    const bvid = typeof it === 'string' ? it : (it && it.bvid)
    if (!bvid || !/^BV[0-9A-Za-z]+$/.test(bvid)) { console.error(`跳过非法 BV 号: ${JSON.stringify(it)}`); continue }
    if (seen.has(bvid)) continue
    seen.add(bvid)
    const domain = (typeof it === 'object' && it.domain) ? String(it.domain) : 'unknown'
    if (!DOMAINS.includes(domain)) console.error(`⚠️ ${bvid} 的 domain=${domain} 不在已知领域里（${DOMAINS.join('/')}）`)
    out.push({ bvid, domain })
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// 抓一个视频（subprocess，复用 bili-duty 的 mcp_server）
// ─────────────────────────────────────────────────────────────────────────────
// 为什么把 bili_video_info 和 bili_comments 放同一个子进程里跑：
//   都走同一个已登录凭证，省一次解释器启动（每次 ~1s）；而且两个请求本来就要限速，
//   一个子进程一次待命更简单。任一失败都不让另一个的成果丢失 —— python 侧分开 try。
function fetchOne (bv, num, st) {
  const code = `
import asyncio, json, sys
sys.path.insert(0, ${JSON.stringify(st.mcpDir)})
import mcp_server as M
async def main():
    out = {}
    try:
        out["info"] = json.loads(await M.bili_video_info(${JSON.stringify(bv)}))
    except Exception as e:
        out["info_error"] = f"{type(e).__name__}: {e}"
    try:
        out["comments"] = json.loads(await M.bili_comments(${JSON.stringify(bv)}, ${Number(num)}))
    except Exception as e:
        out["comments_error"] = f"{type(e).__name__}: {e}"
    print(json.dumps(out, ensure_ascii=False))
asyncio.run(main())
`
  const r = spawnSync(st.python, ['-c', code], {
    encoding: 'utf8',
    timeout: DEFAULTS.fetchTimeoutMs,
    env: { ...process.env, PYTHONIOENCODING: 'utf8', LLMINQQ_CRAWL_BVID: bv },
    maxBuffer: 64 * 1024 * 1024,
  })
  if (r.error) return { error: `子进程失败: ${r.error.message}` }
  if (r.status !== 0) return { error: `python 退出码 ${r.status}: ${String(r.stderr || '').trim().slice(-300)}` }
  const lines = String(r.stdout || '').trim().split('\n')
  let d
  try { d = JSON.parse(lines[lines.length - 1]) } catch (e) { return { error: `输出解析失败: ${e.message}` } }
  if (d.comments_error) return { error: `comments 失败: ${d.comments_error}` }
  const c = d.comments || {}
  // ⚠️ 「有 error 字段」≠「这视频没评论」：风控/网络错必须能分辨出来并**立刻停**，
  //    否则定时任务会静默地每天写一份空语料，池子永远长不大还看不出来。
  if (c.error) return { error: `风控/抓取错误: ${c.error}`, rateLimited: true }
  return {
    info: d.info || {},
    infoError: d.info_error || null,
    comments: Array.isArray(c.comments) ? c.comments : [],
  }
}

/** 把原始评论整理成语料条目：只留说话用得上的字段，去掉 rpid/time 这类噪音。 */
function normalizeComments (raw) {
  const out = []
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue
    const content = String(c.content || '').replace(/\s+/g, ' ').trim()
    if (!content) continue
    const replies = []
    for (const s of (c.top_replies || [])) {
      const sc = String((s && s.content) || '').replace(/\s+/g, ' ').trim()
      if (!sc) continue
      replies.push({ user: String((s && s.user) || '').slice(0, 40), content: sc, like: Number(s.like) || 0 })
    }
    out.push({
      user: String(c.user || '').slice(0, 40),
      content,
      like: Number(c.like) || 0,
      reply_count: Number(c.reply_count) || 0,
      top_replies: replies,
    })
  }
  return out
}

function stats (comments) {
  let nodes = 0
  let chars = 0
  for (const c of comments) {
    nodes += 1
    chars += c.content.length
    for (const r of c.top_replies) { nodes += 1; chars += r.content.length }
  }
  return { nodes, chars }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rand = (a, b) => a + Math.floor(Math.random() * (b - a + 1))

// ─────────────────────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────────────────────
async function main () {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) { console.log(fs.readFileSync(new URL(import.meta.url).pathname, 'utf8').split(' */')[0].replace(/^\/\*\*?/, '')); return 0 }
  const st = settings(args)
  const sources = loadSources(args, st)
  fs.mkdirSync(st.outDir, { recursive: true })

  const fileOf = (bvid) => path.join(st.outDir, `bili-${bvid}.json`)
  // 去重闸：同一个 BV 已有文件就跳过 —— 语料池是「攒起来的」，重复抓同一批
  // 既浪费请求（风控风险）又不会让语料变多。想要新评论就 --force。
  const pending = []
  for (const s of sources) {
    if (!args.force && fs.existsSync(fileOf(s.bvid))) continue
    pending.push(s)
  }
  const todo = args.only > 0 ? pending.slice(0, args.only) : pending

  const log = (m) => { if (!args.quiet && !args.json) console.log(m) }
  log(`语料池目录: ${path.relative(ROOT, st.outDir) || st.outDir}`)
  log(`清单 ${sources.length} 个视频 · 已抓 ${sources.length - pending.length} · 待抓 ${pending.length}` +
      (args.only > 0 ? ` · 本轮取前 ${todo.length}` : '') + ` · 每视频 ${st.num} 条一级评论`)
  if (args.dryRun) {
    for (const s of todo) log(`  [${s.domain}] ${s.bvid}`)
    return 0
  }
  if (!todo.length) {
    log('没有待抓的视频（池子已覆盖清单；要重抓用 --force，要扩池就往 crawlSources 加）')
    if (args.json) console.log(JSON.stringify({ fetched: 0, failed: 0, skipped: sources.length, files: [] }))
    return 0
  }

  const t0 = Date.now()
  const fetched = []
  const failed = []
  let stoppedBy = null
  for (let i = 0; i < todo.length; i++) {
    const s = todo[i]
    const r = fetchOne(s.bvid, st.num, st)
    if (r.error) {
      failed.push({ bvid: s.bvid, domain: s.domain, error: r.error })
      console.error(`  ✗ [${s.domain}] ${s.bvid} ${r.error}`)
      // 限流：立刻停，不重试（重试只会把风控时间拖长，还会把剩下的请求也标记掉）
      if (r.rateLimited) { stoppedBy = `${s.bvid}: ${r.error}`; break }
      continue
    }
    const comments = normalizeComments(r.comments)
    const { nodes, chars } = stats(comments)
    if (!comments.length) {
      failed.push({ bvid: s.bvid, domain: s.domain, error: '真没评论（接口返回 0 条，非风控）' })
      console.error(`  ⚠️ [${s.domain}] ${s.bvid} 返回 0 条评论（跳过，不硬重试）`)
      continue
    }
    const info = r.info || {}
    const doc = {
      bvid: s.bvid,
      domain: s.domain,
      title: info.title || null,
      author: info.author || null,
      replyCount: Number((info.stat && info.stat.reply) || 0),
      tags: Array.isArray(info.tags) ? info.tags.slice(0, 12) : [],
      fetchedAt: Math.floor(Date.now() / 1000),
      numRequested: st.num,
      count: comments.length,
      nodes,
      chars,
      source: 'bilibili-public-comments',
      comments,
    }
    // 原子写：定时任务可能在学的同时被抓取，别让 lexicon 读到半个 JSON
    const tmp = fileOf(s.bvid) + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 1) + '\n', 'utf8')
    fs.renameSync(tmp, fileOf(s.bvid))
    fetched.push({ bvid: s.bvid, domain: s.domain, title: doc.title, count: comments.length, nodes, chars })
    log(`  ✓ [${s.domain}] ${s.bvid} ${comments.length} 条一级 / ${nodes} 条含楼中楼 / ${chars} 字 · ${doc.title || '(无标题)'}`)

    if (i < todo.length - 1) {
      if ((i + 1) % DEFAULTS.batchEvery === 0) {
        const ms = rand(DEFAULTS.batchPauseMinMs, DEFAULTS.batchPauseMaxMs)
        log(`  … 已抓 ${i + 1} 个，歇 ${Math.round(ms / 1000)}s 防风控`)
        await sleep(ms)
      } else {
        await sleep(rand(DEFAULTS.gapMinMs, DEFAULTS.gapMaxMs))
      }
    }
  }

  const elapsed = Math.round((Date.now() - t0) / 1000)
  const all = fetched.reduce((a, f) => ({ nodes: a.nodes + f.nodes, chars: a.chars + f.chars }), { nodes: 0, chars: 0 })
  const byDomain = {}
  for (const f of fetched) byDomain[f.domain] = (byDomain[f.domain] || 0) + 1
  const summary = {
    fetched: fetched.length, failed: failed.length,
    topLevel: fetched.reduce((a, f) => a + f.count, 0),
    nodes: all.nodes, chars: all.chars, elapsed,
    byDomain, files: fetched, errors: failed.map(f => `${f.bvid}: ${f.error}`),
    stoppedBy,
  }
  if (args.json) {
    console.log(JSON.stringify(summary))
  } else {
    log(`\n本轮：${fetched.length} 个视频 / ${summary.topLevel} 条一级评论 / ${all.nodes} 条含楼中楼 / ${all.chars} 字 / ${elapsed}s`)
    log(`分区分布：${JSON.stringify(byDomain)}`)
    if (stoppedBy) console.error(`\n⛔ 遇到限流，已停止本轮（不要立刻重试）：${stoppedBy}`)
    if (failed.length) console.error(`失败 ${failed.length} 个：${failed.map(f => f.bvid + ' ' + f.error).join('；')}`)
  }
  // 退出码：限流单独用 3（定时脚本据此告警/不重试），其它失败不阻断（下轮还会补）
  return stoppedBy ? 3 : 0
}

main().then((c) => process.exit(c)).catch((e) => { console.error('抓取失败:', e && e.stack || e); process.exit(1) })
