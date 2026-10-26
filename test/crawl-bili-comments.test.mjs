// crawl-bili-comments.mjs 测试
// 运行：node test/crawl-bili-comments.test.mjs
//
// 为什么这里要假装一个 python：真实抓取会请求 B站（风控 + 不稳定 + 有网络依赖），
// 测试必须**完全离线**。脚本本来就把「跑 bili_comments 的那个 python」做得可覆盖
// （config.learning.crawlPython / --python），这里塞一个假的可执行文件进去，
// 它按 LLMINQQ_CRAWL_BVID 环境变量吐出预设的 JSON —— 走的是跟线上**同一份**
// 子进程调用/解析/落盘代码，只是数据是造的。
//
// 验的是「抓取端」的四件事（学习端的 A7 在 lexicon.test.mjs）：
//   ① 落盘格式：domain 必填、含楼中楼、字段齐全
//   ② 去重：同一 BV 已有文件 → 跳过，不重复请求
//   ③ 限流立刻停：返回 error → 停止本轮、退出码 3、不重试
//   ④ 路径全可覆盖（CONTRIBUTING §9）：--out-dir 指到 /tmp，绝不写生产 corpus/
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const SCRIPT = path.join(ROOT, 'scripts/crawl-bili-comments.mjs')
const PROD_CORPUS = path.join(ROOT, 'qq-agent/memory/corpus')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crawl-test-'))

// 生产 corpus 快照：跑前记下文件列表+大小，跑完比对（CONTRIBUTING §9）
const PROD_SNAP = (() => {
  if (!fs.existsSync(PROD_CORPUS)) return null
  const names = fs.readdirSync(PROD_CORPUS).sort()
  return names.map(n => `${n}:${fs.statSync(path.join(PROD_CORPUS, n)).size}`).join('|')
})()

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

/**
 * 造一个假 python：读 LLMINQQ_CRAWL_BVID，按 MODE 决定返回什么。
 *   MODE=ok          → 正常 3 条评论（第 1 条带 2 条楼中楼）
 *   MODE=rate_limited → 评论接口返回 error（模拟 -412）
 *   MODE=empty        → 0 条评论（模拟「真没评论」，不该被当成限流）
 */
function writeFakePython (mode) {
  // 为什么假 python 自己用 python3 写（而不是 bash）：
  // 第一版用 bash + 层层转义拼 JSON，直接拼坏了（多出来的引号让输出变成两段 JSON）。
  // 假实现本身也得是可读的代码，否则「测试失败」到底是脚本的锅还是这坨转义的锅分不清。
  const p = path.join(TMP, `fake-python-${mode}-${Math.random().toString(36).slice(2, 7)}`)
  const script = `#!/usr/bin/env python3
# 假 bili_comments：不联网，按 LLMINQQ_CRAWL_BVID 造数据
import json, os, sys

mode = ${JSON.stringify(mode)}
bv = os.environ.get("LLMINQQ_CRAWL_BVID", "BVunknown")
info = {"bvid": bv, "title": "假标题-" + bv, "author": "假UP",
        "stat": {"reply": 999}, "tags": ["测试"]}
if mode == "rate_limited":
    print(json.dumps({"info": info, "comments": {
        "bvid": bv, "count": 0, "comments": [],
        "error": "Exception: 请求被拦截 -412"}}, ensure_ascii=False))
    sys.exit(0)
if mode == "empty":
    print(json.dumps({"info": info, "comments": {"bvid": bv, "count": 0, "comments": []}},
                     ensure_ascii=False))
    sys.exit(0)
print(json.dumps({"info": info, "comments": {"bvid": bv, "count": 3, "comments": [
    {"rpid": 1, "user": "用户甲", "content": "绷不住了这什么操作", "like": 12, "reply_count": 2,
     "top_replies": [{"user": "用户乙", "content": "真的离谱", "like": 3},
                     {"user": "用户丙", "content": "省流：别学", "like": 1}]},
    {"rpid": 2, "user": "用户丁", "content": "第一次见这么玩的", "like": 5, "top_replies": []},
    {"rpid": 3, "user": "用户戊", "content": "蹲一个后续", "like": 2, "top_replies": []}]}},
    ensure_ascii=False))
`
  fs.writeFileSync(p, script, { mode: 0o755 })
  return p
}

function run (args, opts = {}) {
  const r = { code: 0, out: '', err: '' }
  try {
    r.out = execFileSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8', timeout: 60000, env: { ...process.env, ...(opts.env || {}) },
    })
  } catch (e) {
    r.code = e.status ?? -1
    r.out = String(e.stdout || '')
    r.err = String(e.stderr || '')
  }
  return r
}

const lastJson = (text) => {
  const line = String(text || '').trim().split('\n').filter(Boolean).pop() || ''
  try { return JSON.parse(line) } catch { return null }
}

// 每轮一个独立 out-dir，互不干扰
const freshOut = (tag) => {
  const d = path.join(TMP, `out-${tag}-${Math.random().toString(36).slice(2, 7)}`)
  fs.mkdirSync(d, { recursive: true })
  return d
}

console.log('\n=== C1. 落盘格式：domain 必填 / 含楼中楼 / 字段齐全 ===')
{
  const out = freshOut('ok')
  const fake = writeFakePython('ok')
  const src = JSON.stringify([
    { bvid: 'BV1aa1aa1aa1', domain: 'history' },
    { bvid: 'BV1bb1bb1bb1', domain: 'science' },
  ])
  const r = run(['--sources', src, '--out-dir', out, '--python', fake, '--json', '--num', '10'])
  const j = lastJson(r.out)
  ok('抓取跑完（退出码 0）', r.code === 0, r.err || r.out)
  ok('两个视频都抓了', j?.fetched === 2, JSON.stringify(j))
  ok('每个视频 3 条一级评论', j?.topLevel === 6, JSON.stringify(j))
  ok('楼中楼被算进 nodes（3 条+2 楼中楼 = 5/视频）', j?.nodes === 10, JSON.stringify(j))
  const f1 = path.join(out, 'bili-BV1aa1aa1aa1.json')
  ok('文件名是 bili-<bvid>.json', fs.existsSync(f1), f1)
  const doc = JSON.parse(fs.readFileSync(f1, 'utf8'))
  ok('落盘带 domain（分层采样靠它）', doc.domain === 'history', String(doc.domain))
  ok('落盘带 bvid/title/author/fetchedAt/count', doc.bvid === 'BV1aa1aa1aa1' &&
    doc.title === '假标题-BV1aa1aa1aa1' && doc.author === '假UP' &&
    typeof doc.fetchedAt === 'number' && doc.count === 3, JSON.stringify(doc).slice(0, 200))
  ok('落盘只留说话用得上的字段（rpid/time 等噪音不落盘）',
    doc.comments.every(c => !('rpid' in c) && !('time' in c)), JSON.stringify(doc.comments[0]))
  ok('楼中楼真的落盘了（top_replies 有内容）',
    (doc.comments[0].top_replies || []).length === 2, JSON.stringify(doc.comments[0]))
  ok('楼中楼带 user/content/like', doc.comments[0].top_replies.every(x =>
    typeof x.user === 'string' && typeof x.content === 'string' && typeof x.like === 'number'),
    JSON.stringify(doc.comments[0].top_replies))
  ok('不许有 domain 缺失的文件', fs.readdirSync(out).filter(n => n.endsWith('.json'))
    .every(n => JSON.parse(fs.readFileSync(path.join(out, n), 'utf8')).domain), out)
}

console.log('\n=== C2. 去重：同一 BV 已有文件就跳过 ===')
{
  const out = freshOut('dedup')
  const fake = writeFakePython('ok')
  const src = JSON.stringify([{ bvid: 'BV1cc1cc1cc1', domain: 'game' }])
  run(['--sources', src, '--out-dir', out, '--python', fake, '--json'], {})
  const before = fs.readFileSync(path.join(out, 'bili-BV1cc1cc1cc1.json'), 'utf8')
  const r2 = run(['--sources', src, '--out-dir', out, '--python', fake, '--json'], {})
  const j2 = lastJson(r2.out)
  ok('第二次跑跳过已抓的 BV（不重复请求）', j2?.fetched === 0 && j2?.skipped === 1, JSON.stringify(j2))
  ok('跳过时文件没被改写', fs.readFileSync(path.join(out, 'bili-BV1cc1cc1cc1.json'), 'utf8') === before, '')
  const r3 = run(['--sources', src, '--out-dir', out, '--python', fake, '--json', '--force'], {})
  ok('--force 才重抓', lastJson(r3.out)?.fetched === 1, r3.out)
}

console.log('\n=== C3. 限流：立刻停，不重试（重试只会把风控拖长）===')
{
  const out = freshOut('limited')
  const fake = writeFakePython('rate_limited')
  const src = JSON.stringify([
    { bvid: 'BV1dd1dd1dd1', domain: 'tech' },
    { bvid: 'BV1ee1ee1ee1', domain: 'food' },
    { bvid: 'BV1ff1ff1ff1', domain: 'life' },
  ])
  const r = run(['--sources', src, '--out-dir', out, '--python', fake, '--json'], {})
  const j = lastJson(r.out)
  ok('限流时退出码 3（定时脚本据此不重试）', r.code === 3, `code=${r.code} ${r.err.slice(0, 200)}`)
  ok('限流后立刻停（后面的视频一个都没抓）', j?.fetched === 0 && j?.failed === 1, JSON.stringify(j))
  ok('报告里明确写 stoppedBy（不是静默失败）', /-412|风控/.test(String(j?.stoppedBy)), String(j?.stoppedBy))
  ok('限流时一个文件都不落盘（不留半截语料）', fs.readdirSync(out).length === 0, out)
}
{
  const out = freshOut('empty')
  const fake = writeFakePython('empty')
  const src = JSON.stringify([{ bvid: 'BV1gg1gg1gg1', domain: 'food' }])
  const r = run(['--sources', src, '--out-dir', out, '--python', fake, '--json'], {})
  const j = lastJson(r.out)
  ok('「真没评论」不算限流（退出码 0，不中断其它视频）', r.code === 0, String(r.code))
  ok('「真没评论」不落空文件', j?.fetched === 0 && fs.readdirSync(out).length === 0, JSON.stringify(j))
}

console.log('\n=== C4. config 覆盖 + 非法输入 ===')
{
  // 落盘路径 / python / 清单都能从 config 读（CONTRIBUTING §9）
  const out = freshOut('cfg')
  const fake = writeFakePython('ok')
  const cfgP = path.join(TMP, 'cfg-crawl.json')
  fs.writeFileSync(cfgP, JSON.stringify({
    learning: {
      crawlSources: [{ bvid: 'BV1hh1hh1hh1', domain: 'animation' }],
      crawlPython: fake,
      crawlNum: 10,
    },
  }), 'utf8')
  const r = run(['--config', cfgP, '--out-dir', out, '--json'], {})
  const j = lastJson(r.out)
  ok('config.learning.crawlSources 生效', j?.fetched === 1, JSON.stringify(j))
  ok('config.learning.crawlPython 生效（用的是配置文件里的假 python）', j?.byDomain?.animation === 1,
    JSON.stringify(j?.byDomain))
  ok('config 覆盖时也没写生产 corpus（--out-dir 指到 /tmp）',
    fs.existsSync(path.join(out, 'bili-BV1hh1hh1hh1.json')), out)
}
{
  const out = freshOut('bad')
  const fake = writeFakePython('ok')
  const r = run(['--sources', JSON.stringify([{ bvid: 'not-a-bvid', domain: 'game' },
    { bvid: 'BV1ii1ii1ii1', domain: 'no-such-domain' }]),
  '--out-dir', out, '--python', fake, '--json'], {})
  const j = lastJson(r.out)
  ok('非法 BV 号被跳过（不请求）', j?.fetched === 1, JSON.stringify(j))
  // 告警打到 stderr，但退出码 0 时 execFileSync 不抛、stderr 在 e.stderr 里拿不到 ——
  // 所以断言「依旧落盘 + 不阻塞」即可，不必抓那句告警（抓不到会是假失败）。
  ok('未知 domain 也落盘（不阻塞整轮）', j?.byDomain?.['no-such-domain'] === 1,
    JSON.stringify(j?.byDomain))
}
{
  const r = run(['--sources', JSON.stringify([{ bvid: 'BV1jj1jj1jj1', domain: 'game' }]),
    '--dry-run', '--json'], {})
  ok('--dry-run 不发请求也能跑（退出码 0）', r.code === 0, r.err)
}

console.log('\n=== C5. 生产 corpus 没被测试写过吗 ===')
{
  const now = (() => {
    if (!fs.existsSync(PROD_CORPUS)) return null
    const names = fs.readdirSync(PROD_CORPUS).sort()
    return names.map(n => `${n}:${fs.statSync(path.join(PROD_CORPUS, n)).size}`).join('|')
  })()
  if (PROD_SNAP === null) {
    ok('测试没创建生产 corpus 目录', now === null, PROD_CORPUS)
  } else {
    ok('测试没改动生产 corpus（比对文件列表+大小）', now === PROD_SNAP,
      `${String(PROD_SNAP).split('|').length} → ${String(now).split('|').length} 个文件`)
  }
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
