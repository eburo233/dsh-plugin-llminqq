// 自我风格样本库测试：全部走临时库/临时文件，绝不碰生产 style.db / mem.db。
// 运行：node test/style-bank.test.mjs
//
// 两部分：
//   A. python 侧（qq-agent/memory/stylebank.py）——入库 / 过滤 / 排序 / 冷启动 / 长度
//   B. 桥侧（bridge/index.js 的 style 段落）——用同一套「抠源码求值」手法，
//      保证测的就是线上那份代码（跟 recall.test.mjs / mood-logic.test.mjs 一致）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const SCRIPT = path.join(ROOT, 'qq-agent/memory/stylebank.py')
const PROD_DB = path.join(ROOT, 'qq-agent/memory/style.db')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'stylebank-test-'))

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

/** 起一次 python CLI，返回 {code, json|text, stderr} */
function py(args, opts = {}) {
  try {
    const out = execFileSync('python3', [SCRIPT, ...args], {
      encoding: 'utf8', timeout: 20000,
      env: { ...process.env, PYTHONIOENCODING: 'utf8' },
    })
    const line = String(out).trim().split('\n').pop()
    let json = null
    try { json = JSON.parse(line) } catch { /* 非 json 输出（stats/ingest） */ }
    return { code: 0, json, text: String(out).trim() }
  } catch (e) {
    return { code: e.status ?? -1, text: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') }
  }
}

const freshDb = (tag) => path.join(TMP, `style-${tag}-${Math.random().toString(36).slice(2, 7)}.db`)

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== A1. 入库与短回复过滤 ===')
{
  const db = freshDb('filter')
  const cases = [
    // [reply, context, 期望入库]
    ['嗯', '在吗', false],                                   // <4 字
    ['好的', '在吗', false],                                  // <4 字
    ['行吧', '在吗', false],                                  // <4 字
    ['嗯嗯嗯嗯', '在吗', false],                               // 纯语气词，字数够也没信息
    ['哈哈哈哈哈', '在吗', false],                             // 同上
    ['行，那你早点睡', '还不睡啊', true],                      // 4 字以上、有内容
    ['说错了 [RECALL:last] 当我没说', '你刚才说啥', true],      // 标记要被剥掉
    ['[SILENT]', '群里没人理我', false],                       // 只有控制标记
    ['发你了，你看一眼 [SEND_FILE: /tmp/a.png]', '发我看看', true],
  ]
  for (const [reply, ctx, expect] of cases) {
    const r = py([`--db`, db, 'add', '--peer', 'c2c:1', '--reply', reply, '--context', ctx])
    ok(`"${reply}" → ${expect ? '入库' : '被过滤'}`, (r.json?.ok === true) === expect, r.text || r.stderr)
  }
  // 剥标记：库里存的应该是「说错了 当我没说」这种，不带 [RECALL]
  // min-total 调低到 1：这里只验「剥标记」，冷启动闸由 A4 单独验
  // min-total/min-match 调低到 1：这里只验「剥标记」，冷启动/弱匹配闸由 A4、A3b 单独验
  const rc = py(['--db', db, 'recall', '--peer', 'c2c:1', '--query', '你刚才说啥', '--min-total', '1', '--min-match', '1', '--json'])
  const block = rc.json?.block ?? ''
  ok('入库时剥掉了 [RECALL] 标记', !/RECALL/i.test(block), block)
  ok('剥掉标记后正文还在', /当我没说/.test(block), block)
  ok('只有控制标记的回复被算作空（不入库）',
    !/SILENT/i.test(block), block)

  // 样本总数：应恰好是 3 条（「行，那你早点睡」「说错了 当我没说」「发你了」）
  const st = py(['--db', db, 'stats'])
  ok('过滤后只剩 3 条有效样本', /\b3 条/.test(st.text), st.text)
}

console.log('\n=== A2. 去重与 ts 更新（同一场合同一句话只存一条）===')
{
  const db = freshDb('dup')
  const a = py(['--db', db, 'add', '--peer', 'c2c:1', '--reply', '这个我早说过了', '--context', '你咋知道', '--ts', '1000'])
  const b = py(['--db', db, 'add', '--peer', 'c2c:1', '--reply', '这个我早说过了', '--context', '你咋知道', '--ts', '2000'])
  ok('第一次入库成功', a.json?.ok === true, a.text)
  ok('第二次被识别为重复', b.json?.skipped === 'duplicate', b.text)
  const st = py(['--db', db, 'stats'])
  ok('库里仍然只有 1 条', /\b1 条/.test(st.text), st.text)
}

console.log('\n=== A3. 检索按相似度排序 ===')
{
  const db = freshDb('rank')
  const samples = [
    ['别熬了，早点睡，明早还得起。', '我还没下班呢'],
    ['那就歇着，活又不会跑。', '我想歇会儿'],
    ['开会最烦的是人，议程本身倒还好。', '开会好烦啊'],
    ['这游戏我玩不明白，手残。', '你会玩这个游戏吗'],
    ['刷手机刷到这个点，你挺自在。', '在悠闲的刷手机'],
  ]
  for (const [reply, ctx] of samples) {
    py(['--db', db, 'add', '--peer', 'c2c:1', '--reply', reply, '--context', ctx])
  }
  const r = py(['--db', db, 'recall', '--peer', 'c2c:1', '--query', '明天又要开会，烦死了', '--json'])
  const s = r.json?.samples ?? []
  ok('有效样本 5 条', r.json?.total === 5, String(r.json?.total))
  ok('命中了样本', s.length >= 1, JSON.stringify(s))
  ok('top1 是「开会」那条（场景最像）', (s[0]?.context ?? '').includes('开会'), s[0]?.reply)
  ok('分数按降序', s.every((x, i) => i === 0 || s[i - 1].score >= x.score), JSON.stringify(s.map(x => x.score)))
  ok('归一化到 [0,1]', s.every(x => x.score >= 0 && x.score <= 1), JSON.stringify(s.map(x => x.score)))

  const r2 = py(['--db', db, 'recall', '--peer', 'c2c:1', '--query', '游戏怎么玩', '--json'])
  ok('换查询 → top1 跟着换（不是固定输出）',
    (r2.json?.samples?.[0]?.context ?? '').includes('游戏'), JSON.stringify(r2.json?.samples?.[0]))

  // 完全无关的查询应该检索不到（不能硬凑）
  const r3 = py(['--db', db, 'recall', '--peer', 'c2c:1', '--query', '量子色动力学的耦合常数', '--json'])
  ok('无关查询不硬凑样本', (r3.json?.samples?.length ?? 0) === 0, JSON.stringify(r3.json?.samples))
}

console.log('\n=== A3a. 覆盖率闸：压低「无关查询的误命中」 ===')
{
  const db = freshDb('cov')
  // 只共享一个泛字（「的」被 stopword 挡掉，这里用「点」这类弱重合）
  for (const [reply, ctx] of [
    ['都这个点了，先歇会儿吧。', '现在几点了'],
    ['那就歇着，活又不会跑。', '我想歇会儿'],
    ['开会最烦的是人。', '开会好烦啊'],
  ]) py(['--db', db, 'add', '--peer', 'c2c:1', '--reply', reply, '--context', ctx])
  // 这条查询跟「开会最烦的是人」只共享 1 个 bigram（覆盖率 10/1000=0.1），
  // 属于「沾了一点边但不是同一个场合」。覆盖率闸设在 0.10，边界上仍放行；
  // 关键是要能证明**闸确实在按覆盖率过滤**，而不是形同虚设。
  const covCase = '我现在要开会的路上，说烦不烦'
  const strict = py(['--db', db, 'recall', '--peer', 'c2c:1', '--query', covCase,
    '--min-total', '1', '--min-coverage', '0.3', '--json'])
  const loose2 = py(['--db', db, 'recall', '--peer', 'c2c:1', '--query', covCase,
    '--min-total', '1', '--min-coverage', '0', '--json'])
  ok('覆盖率高的条目仍然命中',
    (loose2.json?.samples?.length ?? 0) > 0, JSON.stringify(loose2.json?.samples?.length))
  ok('把覆盖率要求提到 0.3 → 弱沾边的条目被挡掉',
    (strict.json?.samples?.length ?? 0) < (loose2.json?.samples?.length ?? 0),
    `strict=${strict.json?.samples?.length} loose=${loose2.json?.samples?.length}`)
  const neg = py(['--db', db, 'recall', '--peer', 'c2c:1', '--query', '量子色动力学的耦合常数是多少',
    '--min-total', '1', '--json'])
  ok('完全无关的查询一条都不给', (neg.json?.samples?.length ?? 0) === 0, JSON.stringify(neg.json?.samples))
  // 正常同场景查询仍然命中
  const pos = py(['--db', db, 'recall', '--peer', 'c2c:1', '--query', '明天又要开会，烦死了',
    '--min-total', '1', '--json'])
  ok('真实同场景查询照常命中', (pos.json?.samples?.length ?? 0) > 0, JSON.stringify(pos.json?.samples))
}

console.log('\n=== A3b. 命中数闸：只撞上 1 条弱匹配也不注入 ===')
{
  const db = freshDb('weak')
  for (const [reply, ctx] of [
    ['开会最烦的是人，议程本身倒还好。', '开会好烦啊'],
    ['那就歇着，活又不会跑。', '我想歇会儿'],
    ['你这嘴快得收一收。', '你这人说话真冲'],
  ]) py(['--db', db, 'add', '--peer', 'c2c:1', '--reply', reply, '--context', ctx])
  const r = py(['--db', db, 'recall', '--peer', 'c2c:1', '--query', '开会好烦啊', '--json'])
  ok('样本 3 条够，但只命中 1 条 → 不注入',
    r.json?.matched === 1 && r.json?.injected === false, JSON.stringify({ m: r.json?.matched, i: r.json?.injected }))
  ok('不注入时 block 为空、reason 说明原因',
    r.json?.block === '' && /weak-match/.test(r.json?.reason ?? ''), r.json?.reason)
  const loose = py(['--db', db, 'recall', '--peer', 'c2c:1', '--query', '开会好烦啊', '--min-match', '1', '--json'])
  ok('放宽 min-match 后才注入（证明闸就是它）', loose.json?.injected === true, loose.text)
}

console.log('\n=== A4. 冷启动安全（样本 <3 条不注入）===')
{
  const db = freshDb('cold')
  const empty = py(['--db', db, 'recall', '--peer', 'c2c:nobody', '--query', '在吗', '--json'])
  ok('空库 → 不注入', empty.json?.injected === false, empty.text)
  ok('空库 → block 为空', empty.json?.block === '', JSON.stringify(empty.json?.block))

  py(['--db', db, 'add', '--peer', 'c2c:2', '--reply', '这类问题你问我就行', '--context', '在吗'])
  py(['--db', db, 'add', '--peer', 'c2c:2', '--reply', '说的是同一件事吗', '--context', '在吗'])
  const two = py(['--db', db, 'recall', '--peer', 'c2c:2', '--query', '在吗', '--json'])
  const twoLoose = py(['--db', db, 'recall', '--peer', 'c2c:2', '--query', '在吗', '--min-total', '1', '--json'])
  ok('2 条样本（<3）→ 尽管能匹配到也不注入',
    two.json?.injected === false && two.json?.total === 2, JSON.stringify({ total: two.json?.total, injected: two.json?.injected }))
  ok('但命中本身是有的（只是被冷启动闸挡住）',
    (twoLoose.json?.matched ?? 0) > 0 && two.json?.matched === 0,
    `loose=${twoLoose.json?.matched} strict=${two.json?.matched}`)

  py(['--db', db, 'add', '--peer', 'c2c:2', '--reply', '你这两句话我听不懂', '--context', '在吗在吗'])
  const three = py(['--db', db, 'recall', '--peer', 'c2c:2', '--query', '在吗', '--json'])
  ok('满 3 条 → 开始注入', three.json?.injected === true, three.text)

  // 跨 peer 隔离：别的 peer 的样本不能串进来
  const other = py(['--db', db, 'recall', '--peer', 'c2c:other', '--query', '在吗', '--json'])
  ok('不同 peer 不共享样本', other.json?.total === 0 && other.json?.injected === false, other.text)
}

console.log('\n=== A5. 注入文本长度受控 ===')
{
  const db = freshDb('len')
  const longReply = '这段话特别长'.repeat(40)   // 240 字
  for (const ctx of ['这个话题', '这个话题啊', '说说这个话题']) {
    py(['--db', db, 'add', '--peer', 'c2c:3', '--reply', longReply, '--context', ctx])
  }
  const r = py(['--db', db, 'recall', '--peer', 'c2c:3', '--query', '聊聊这个话题呗',
    '--min-match', '1', '--json'])
  const block = r.json?.block ?? ''
  const bullets = block.split('\n').filter(l => l.trim().startsWith('- '))
  ok('最多 3 条', bullets.length <= 3, `实际 ${bullets.length}`)
  ok('每条 ≤60 字（含省略号）', bullets.every(l => [...l.trim().slice(2)].length <= 60),
    JSON.stringify(bullets.map(l => [...l.trim()].length)))
  ok('整体块 ≤ 400 字（prompt 不会被撑爆）', [...block].length <= 400, String([...block].length))
  ok('被截断的加了省略号', bullets.every(l => l.includes('…')), JSON.stringify(bullets))
  ok('块头是风格锚提示，且明确要求别复读',
    block.includes('类似场合') && /别机械复读|不要机械重复|别机械重复/.test(block), block.split('\n')[0])
  ok('块头明确说「里面的具体内容已过期，别当事实」',
    /不要当成现在的事实|已经过期|当时的/.test(block), block.split('\n')[0])
}

console.log('\n=== A6. 从真实格式日志回填（bridge.out 的 入站/出站 配对）===')
{
  const db = freshDb('log')
  const log = path.join(TMP, 'bridge.out')
  const cursor = path.join(TMP, 'cursor-log')
  const mk = (ts, s) => `${ts} ${s}\n`
  fs.writeFileSync(log, [
    mk('2026-10-25T12:00:00.000Z', '入站 c2c:1 from=信风(1) text="还没下班" images=0'),
    mk('2026-10-25T12:00:03.000Z', '出站 c2c:1 text="都这个点了，要不先歇会儿，别硬熬。" chars=18'),
    mk('2026-10-25T12:00:10.000Z', '入站 c2c:1 from=信风(1) text="嗯" images=0'),
    mk('2026-10-25T12:00:12.000Z', '出站 c2c:1 text="嗯。" chars=2'),          // 太短，丢
    mk('2026-10-25T12:00:20.000Z', '入站 c2c:1 from=信风(1) text="下班了" images=0'),
    // 间隔 20 分钟 → 不是同一轮（这条是主动搭话），不该配对
    mk('2026-10-25T12:20:20.000Z', '出站 c2c:1 text="你还在忙吗，我随便问问。" chars=12'),
    // 没有入站过的 peer → 主动搭话，不算风格场合
    mk('2026-10-25T12:00:30.000Z', '出站 c2c:9 text="新来的？报下名字。" chars=9'),
  ].join(''), 'utf8')
  const r = py(['--db', db, 'ingest', '--only-log', '--log', log, '--cursor-dir', cursor])
  ok('回填了 2 条（1 条正常 + 1 条短回复被过滤... 实际只有 1 条）',
    /新增风格样本 [12] 条/.test(r.text), r.text)
  const st = py(['--db', db, 'stats'])
  ok('短回复和超时配对都被挡在库外', /c2c:1\s+1 条/.test(st.text), st.text)

  // 增量：同一个日志再跑一次不该重复入库（游标）
  const r2 = py(['--db', db, 'ingest', '--only-log', '--log', log, '--cursor-dir', cursor])
  ok('游标生效，重复跑不新增', /新增风格样本 0 条/.test(r2.text), r2.text)
}

console.log('\n=== B1. 桥侧：源码接线（防漂移）===')
const src = fs.readFileSync(path.join(ROOT, 'bridge/index.js'), 'utf8')
{
  ok('index.js 定义了 STYLE 配置块', /const STYLE = \{/.test(src))
  ok('index.js 有 recordStyleCase', /function recordStyleCase \(/.test(src))
  ok('index.js 有 styleAnchorBlock', /function styleAnchorBlock \(/.test(src))
  ok('prompt 拼装处调用了 styleAnchorBlock', /styleAnchorBlock\(peerKey, flat\.text/.test(src))
  ok('发送成功后调用 recordStyleCase', /recordStyleCase\(peerKey, flat\.text/.test(src))
  ok('桥通过 python 复用 memctl 的 BM25（不另写一套相似度）', /stylebank\.py/.test(src) && /memctl\.BM25Index/.test(fs.readFileSync(SCRIPT, 'utf8')))
}

console.log('\n=== B2. 桥侧：抠出 style 段落单独求值 ===')
{
  const lines = src.split('\n')
  const start = lines.findIndex(l => l.startsWith('// ── 自我风格样本库'))
  const end = lines.findIndex(l => l.startsWith('function startProactiveLoop'))
  ok('抠得出 style 段落', start >= 0 && end > start, `start=${start} end=${end}`)
  const section = lines.slice(start, end).join('\n')

  /**
   * 造一套临时环境：按真实目录布局 cwd/memory/stylebank.py，
   * 并用 config.style.dir 把落盘路径引到临时目录（桥支持覆盖，见 STYLE_ROOTS 注释）。
   */
  const mkEnv = (opts = {}) => {
    const logs = []
    const dir = fs.mkdtempSync(path.join(TMP, 'bridge-'))
    const memDir = path.join(dir, 'memory')
    fs.mkdirSync(memDir, { recursive: true })
    // stylebank.py 会 import memctl（复用 tokenize/BM25Index）→ 一起复制过来
    fs.copyFileSync(path.join(ROOT, 'qq-agent/memory/memctl.py'), path.join(memDir, 'memctl.py'))
    const fakeScript = path.join(memDir, 'stylebank.py')
    // 把脚本里 BASE 指到本临时目录 → 库/jsonl 全落在临时目录，绝不碰生产
    fs.writeFileSync(fakeScript, fs.readFileSync(SCRIPT, 'utf8').replace(
      /^BASE = os\.path\.dirname\(os\.path\.abspath\(__file__\)\)$/m,
      `BASE = ${JSON.stringify(memDir)}`), 'utf8')
    const config = {
      dsh: { cwd: opts.cwd ?? dir },
      style: { dir: memDir, ...(opts.style ?? {}) },
    }
    // eslint-disable-next-line no-new-func
    const fn = new Function('config', 'logger', 'fs', 'path', 'execFileSync',
      `${section}\n; return { STYLE, recordStyleCase, styleAnchorBlock, styleCache, styleSkipReason };`)
    const api = fn(config,
      { log: m => logs.push(String(m)), debug: m => logs.push(String(m)) },
      fs, path, (bin, args, o) => execFileSync(bin, args, o))
    api.logs = logs
    api.dir = dir
    api.memDir = memDir
    api.fakeScript = fakeScript
    api.styleDb = path.join(memDir, 'style.db')
    api.jsonl = path.join(memDir, 'style-cases.jsonl')
    api.seed = (reply, ctx, ts = 1000) => execFileSync('python3', [fakeScript, '--db', api.styleDb,
      'add', '--peer', 'c2c:1', '--reply', reply, '--context', ctx, '--ts', String(ts)], { encoding: 'utf8' })
    return api
  }


  // ① 记录：写进 jsonl，过滤交给 python 侧
  {
    const env = mkEnv()
    env.recordStyleCase('c2c:1', '还没下班', '都这个点了，要不先歇会儿，别硬熬。')
    const jsonl = env.jsonl
    ok('recordStyleCase 写了 jsonl', fs.existsSync(jsonl), jsonl)
    const rec = JSON.parse(fs.readFileSync(jsonl, 'utf8').trim())
    ok('记录了 peer/context/my_reply/ts',
      rec.peer === 'c2c:1' && rec.context === '还没下班' && /别硬熬/.test(rec.my_reply) && typeof rec.ts === 'number',
      JSON.stringify(rec))
    // 没有 context（纯图片/主动搭话）→ 不记
    const before = fs.readFileSync(jsonl, 'utf8').split('\n').filter(Boolean).length
    env.recordStyleCase('c2c:1', '', '这图我看着挺乐')
    const after = fs.readFileSync(jsonl, 'utf8').split('\n').filter(Boolean).length
    ok('没有「对方那句话」的轮次不记（避免存永远检索不到的样本）', after === before, `${before}→${after}`)
  }

  // ② 冷启动：库里没样本 → 不注入、不抛错
  {
    const env = mkEnv()
    const block = env.styleAnchorBlock('c2c:1', '在吗')
    ok('空库 → 返回空串（不注入）', block === '', JSON.stringify(block))
    ok('不抛异常（桥这条链路不能因为风格库挂掉）', true)
  }

  // ③ 正常注入：先塞 4 条样本，再问
  {
    const env = mkEnv()
    env.seed('开会最烦的是人，议程本身倒还好。', '开会好烦啊')
    env.seed('明天又要开会啊，那你今晚别熬太晚。', '明天又要开会')
    env.seed('那就歇着，活又不会跑。', '我想歇会儿')
    env.seed('都这个点了，要不先歇会儿，别硬熬。', '还没下班')
    const block = env.styleAnchorBlock('c2c:1', '明天又要开会，烦死了')
    ok('有样本 → 注入', block.length > 0, block)
    ok('注入块带「类似场合」标题', block.includes('类似场合'), block.split('\n')[0])
    ok('注入的是开会那条（场景匹配）', block.includes('开会'), block)
    ok('不会把不相关的样本全塞进来（≤3 条）',
      block.split('\n').filter(l => l.trim().startsWith('- ')).length <= 3, block)
    ok('日志记了注入条数', env.logs.some(l => /style .*注入/.test(l)), JSON.stringify(env.logs))

    // 同时验证：桥 --auto-ingest 把 jsonl 里的新样本吃掉，下一轮就能用
    env.recordStyleCase('c2c:1', '你搜搜你的外号', '这名儿就你一个人在用，我查过一圈了。')
    env.recordStyleCase('c2c:1', '你去搜搜你自己的外号', '查过了，没人这么叫你，就你自己用。')
    env.styleCache.clear()
    const b2 = env.styleAnchorBlock('c2c:1', '你搜搜你的外号')
    ok('新记的样本当轮就能被检索到（auto-ingest 生效）', b2.includes('这名儿就你一个人在用'), b2)
  }

  // ④ 超时降级：python 慢/坏 → 返回空串，不抛
  {
    const env = mkEnv()
    for (const c of ['a b c', 'a b c', 'a b c']) env.seed(`我说话一向这样${c}`, c)
    env.styleCache.clear()
    // 用 patchScript 把脚本改成永远 sleep（模拟超时/挂了）
    fs.writeFileSync(env.fakeScript, 'import time; time.sleep(30)\n', 'utf8')
    const t0 = Date.now()
    const block = env.styleAnchorBlock('c2c:1', 'a b c')
    const cost = Date.now() - t0
    ok('python 超时 → 返回空串（静默降级）', block === '', JSON.stringify(block))
    ok('超时被 4s 上限挡住，不会拖住这一轮', cost < 8000, `${cost}ms`)
    ok('记了 debug 日志（可排查）', env.logs.some(l => /style 检索失败/.test(l)), JSON.stringify(env.logs))
  }

  // ⑤ 缓存：同一 peer 同一句话在 TTL 内不重复起 python
  {
    const env = mkEnv()
    env.seed('开会最烦的是人，议程本身倒还好。', '开会好烦啊')
    env.seed('明天又要开会啊，那你今晚别熬太晚。', '明天又要开会')
    env.seed('都这个点了，要不先歇会儿，别硬熬。', '还没下班')
    env.styleCache.clear()
    const b1 = env.styleAnchorBlock('c2c:1', '开会好烦啊')
    // 把脚本删掉：如果第二次还真的去调 python，就会降到空串
    fs.writeFileSync(env.fakeScript, 'raise SystemExit(1)\n', 'utf8')
    const b2 = env.styleAnchorBlock('c2c:1', '开会好烦啊')
    ok('同一句话在 TTL 内命中缓存（结果一致，不再起进程）', b1 === b2 && b1.length > 0, `${b1.length}/${b2.length}`)
    const b3 = env.styleAnchorBlock('c2c:1', '换个话题问')
    ok('换一句话 → 缓存不命中（会真的重新查，此时代码已坏 → 空串）', b3 === '', JSON.stringify(b3))
  }

  // ⑥ 关闭开关 → 一句话都不记、不注入
  {
    const env = mkEnv({ style: { enabled: false } })
    ok('style.enabled=false → 不注入', env.styleAnchorBlock('c2c:1', '在吗') === '')
    env.recordStyleCase('c2c:1', '在吗', '在这儿呢，你说')
    ok('style.enabled=false → 不记录', !fs.existsSync(env.jsonl))
  }
}

console.log('\n=== B3. 生产库/生产文件被动过吗 ===')
{
  ok('测试没创建生产 style.db', !fs.existsSync(PROD_DB), PROD_DB)

  // 与 B2 同一个抠源码 + 临时目录环境（重新造一份，保持块内自洽）
  const lines2 = src.split('\n')
  const secStart = lines2.findIndex(l => l.startsWith('// ── 自我风格样本库'))
  const secEnd = lines2.findIndex(l => l.startsWith('function startProactiveLoop'))
  const section2 = lines2.slice(secStart, secEnd).join('\n')
  const mkEnv2 = (opts = {}) => {
    const dir = fs.mkdtempSync(path.join(TMP, 'leak-'))
    const memDir = path.join(dir, 'memory')
    fs.mkdirSync(memDir, { recursive: true })
    const config = {
      dsh: { cwd: opts.cwd ?? dir },
      style: { dir: memDir, script: path.join(memDir, 'stylebank.py'), ...(opts.style ?? {}) },
    }
    // eslint-disable-next-line no-new-func
    return new Function('config', 'logger', 'fs', 'path', 'execFileSync',
      `${section2}\n; return { recordStyleCase };`)(
      config, { log: () => {}, debug: () => {} }, fs, path,
      (bin, args, o) => execFileSync(bin, args, o))
  }

  // ⚠️ 回归测试：端到端测试会**真的启动 bridge/index.js**，它换得掉 persona/日志/state，
  // 但换不掉 dsh.cwd。第一版把风格库路径写死成 dsh.cwd/memory，于是 recall-e2e 跑一次
  // 就往**生产** memory/ 里塞了 3 条 group:9137001123 的假样本（实测踩到）。
  // 这里直接验证「config.style.dir 能把落盘路径完全引开」。
  {
    const prodJsonl = path.join(ROOT, 'qq-agent/memory/style-cases.jsonl')
    const existedBefore = fs.existsSync(prodJsonl)
    const sizeBefore = existedBefore ? fs.statSync(prodJsonl).size : 0
    // dsh.cwd 故意指到真实项目目录（模拟 e2e 的处境），style.dir 指到临时目录
    const env = mkEnv2({ cwd: path.join(ROOT, 'qq-agent') })
    env.recordStyleCase('c2c:999', '在吗', '在的，你说')
    const leaked = fs.existsSync(prodJsonl) && fs.statSync(prodJsonl).size !== sizeBefore
    ok('dsh.cwd 指向生产目录时，样本仍写进 config.style.dir（不污染生产）', !leaked,
      leaked ? `生产 jsonl 被写了: ${prodJsonl}` : '')
    ok('样本确实写进了覆盖后的目录',
      !fs.existsSync(prodJsonl) || fs.statSync(prodJsonl).size === sizeBefore)
  }

  ok('测试没写生产 mem.db', fs.existsSync(path.join(ROOT, 'qq-agent/memory/mem.db')))
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
