// 撤回（[RECALL]）测试：全部走 mock，绝不碰真实 QQ / OneBot。
// 运行：node test/recall.test.mjs
//
// 做法与 card-parse.test.mjs 一致：从 bridge/index.js 里**抠出撤回那一段源码**求值，
// 这样测的就是线上同一份代码，不会出现「测试里的规则和实现漂移」。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const src = fs.readFileSync(path.join(ROOT, 'bridge/index.js'), 'utf8')
const lines = src.split('\n')
const start = lines.findIndex(l => l.startsWith('// ── 撤回（[RECALL]'))
const end = lines.findIndex(l => l.startsWith('// ── 媒体暂存'))
if (start < 0 || end < 0) throw new Error('抠不出撤回段落：注释锚点变了')
const section = lines.slice(start, end).join('\n')

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-test-'))
const STATUS_FILE = path.join(TMP, '.bridge', 'recall.log')

/** 每个用例一套全新的 mock 环境（模块级 Map 要重置）。 */
function makeEnv(opts = {}) {
  const calls = []        // 记录 delete_msg 调用
  const logs = []         // 记录 logger 输出
  const behavior = opts.behavior ?? (() => ({ ok: true }))
  const gateway = {
    callData: async (action, params) => {
      calls.push({ action, params })
      const r = behavior(action, params)
      if (r && r.throw) throw new Error(r.throw)
      return r?.data ?? {}
    },
  }
  const config = { dsh: { cwd: TMP }, recall: opts.recall ?? {} }
  const logger = { log: m => logs.push(String(m)) }
  // eslint-disable-next-line no-new-func
  const fn = new Function('config', 'logger', 'gateway', 'fs', 'path',
    `${section}\n; return { extractRecalls, performRecall, noteSentMessage,
      recallKeyOf, recallNoticeFor, recallPromptBlock, sentMessages, recallAttempts, recallNotes,
      RECALL_HISTORY_MAX, RECALL_TTL_MS, RECALL_RATE_MAX };`)
  const api = fn(config, logger, gateway, fs, path)
  api.calls = calls
  api.logs = logs
  return api
}

const GROUP = { id: '9137001122', scope: 'group' }
const C2C = { id: '2468003344', scope: 'c2c' }

console.log('\n=== 1. 标记解析：能被识别、且从正文里剥掉 ===')
{
  const env = makeEnv()
  const r1 = env.extractRecalls('说错了 [RECALL:last] 重来')
  ok('[RECALL:last] 被识别为倒数第 1 条', JSON.stringify(r1.specs) === '[1]', JSON.stringify(r1.specs))
  ok('[RECALL:last] 从正文剥掉', r1.text === '说错了  重来' || r1.text === '说错了 重来' || !r1.text.includes('RECALL'), JSON.stringify(r1.text))
  ok('剥掉后没有残留方括号', !/\[RECALL/.test(r1.text), r1.text)

  const r2 = env.extractRecalls('[RECALL:1]')
  ok('[RECALL:1] = 最近一条（与 last 等价）', JSON.stringify(r2.specs) === '[1]')
  ok('[RECALL:1] 剥成空正文', r2.text === '', JSON.stringify(r2.text))

  const r3 = env.extractRecalls('a [RECALL:2] b')
  ok('[RECALL:2] = 倒数第 2 条', JSON.stringify(r3.specs) === '[2]')

  const r4 = env.extractRecalls('[RECALL:last] 和 [RECALL:3] 一起')
  ok('一轮多个不同序号都保留', JSON.stringify(r4.specs) === '[1,3]', JSON.stringify(r4.specs))

  const r5 = env.extractRecalls('[RECALL:last][RECALL:last]')
  ok('重复序号去重', JSON.stringify(r5.specs) === '[1]', JSON.stringify(r5.specs))

  const r6 = env.extractRecalls('[RECALL:99]')
  ok('超出历史长度(>10)的序号不生效', r6.specs.length === 0, JSON.stringify(r6.specs))

  const r7 = env.extractRecalls('[RECALL:0]')
  ok('序号 0 非法，不生效', r7.specs.length === 0)

  const r8 = env.extractRecalls('[RECALL:12]')
  ok('两位数字被正则捕获但超上限后丢弃', r8.specs.length === 0 && r8.text === '', JSON.stringify(r8))

  const r9 = env.extractRecalls('大小写也要认 [recall:LAST]')
  ok('大小写不敏感', JSON.stringify(r9.specs) === '[1]', JSON.stringify(r9.specs))

  const many = env.extractRecalls('[RECALL:1][RECALL:2][RECALL:3][RECALL:4]')
  ok(`一轮超过 ${env.RECALL_RATE_MAX} 条时只保留前 ${env.RECALL_RATE_MAX} 个动作`,
    many.specs.length === env.RECALL_RATE_MAX, JSON.stringify(many.specs))
  ok('被丢弃的个数有计数（供调用方记日志）', many.dropped === 4 - env.RECALL_RATE_MAX, String(many.dropped))

  ok('普通方括号文本不受影响', env.extractRecalls('[图片] 好的').specs.length === 0)
}

console.log('\n=== 2. 发送后记账：message_id 被存下来，只留最近 10 条 ===')
{
  const env = makeEnv()
  ok('抽出 message_id 存进历史', (() => {
    env.noteSentMessage(GROUP, { message_id: 111 }, 'text')
    return (env.sentMessages.get('group:9137001122') ?? []).length === 1
  })())
  for (let i = 0; i < 15; i++) env.noteSentMessage(GROUP, { message_id: 200 + i }, 'text')
  const list = env.sentMessages.get('group:9137001122')
  ok(`历史上限 ${env.RECALL_HISTORY_MAX} 条`, list.length === env.RECALL_HISTORY_MAX, `len=${list.length}`)
  ok('留下的是最新的（最老的被挤出）', list[list.length - 1].message_id === '214', list[list.length - 1].message_id)
  ok('每条都带时间戳', list.every(x => Number.isFinite(x.ts) && x.ts > 0))
  ok('没有 message_id 的响应不记账', (() => {
    const before = list.length
    env.noteSentMessage(GROUP, {})
    return env.sentMessages.get('group:9137001122').length === before
  })())
  ok('不同 peer 各记各的', (() => {
    env.noteSentMessage(C2C, { message_id: 999 })
    return env.sentMessages.get('c2c:2468003344').length === 1 && env.sentMessages.get('group:9137001122').length === 10
  })())
  ok('noteSelfSent 内部复用同一记账（源码级验证）', /function noteSelfSent[\s\S]{0,400}?noteSentMessage\(peer, res/.test(src))
}

console.log('\n=== 3. 撤回成功：调 delete_msg，参数是 message_id ===')
{
  const env = makeEnv()
  env.noteSentMessage(GROUP, { message_id: 5001 })
  const r = await env.performRecall(GROUP, 1)
  ok('返回 ok', r.ok === true, JSON.stringify(r))
  ok('调的是 delete_msg', env.calls.length === 1 && env.calls[0].action === 'delete_msg', JSON.stringify(env.calls))
  ok('参数带 message_id 且是数字', env.calls[0]?.params?.message_id === 5001, JSON.stringify(env.calls[0]?.params))
  ok('撤回成功后从历史里移除（避免重复撤）', (env.sentMessages.get('group:9137001122') ?? []).length === 0)
  ok('日志里明确写了成功', env.logs.some(l => l.includes('[RECALL] 成功')), env.logs.join(' | '))
  ok('状态文件也写了（模型可 read 确认）', fs.existsSync(STATUS_FILE) && /\[RECALL\] 成功/.test(fs.readFileSync(STATUS_FILE, 'utf8')))
}

console.log('\n=== 4. 撤回失败：超时限 / id 不存在 / 协议报错，都要明确反馈 ===')
{
  // 超时：把历史项时间戳往前拨
  const env = makeEnv()
  env.noteSentMessage(GROUP, { message_id: 6001 })
  env.sentMessages.get('group:9137001122')[0].ts = Date.now() - (env.RECALL_TTL_MS + 60000)
  const late = await env.performRecall(GROUP, 1)
  ok('超时 → 失败（不调 delete_msg）', late.ok === false && env.calls.length === 0, JSON.stringify(late))
  ok('失败原因说清「超过时限」', /超过 QQ 撤回时限/.test(late.detail), late.detail)
  ok('失败文案含已发出秒数', /\d+ 秒/.test(late.detail), late.detail)
  ok('超时后不从历史移除（信息还在，只是撤不了）', (env.sentMessages.get('group:9137001122') ?? []).length === 1)

  // id 不存在：历史空
  const env2 = makeEnv()
  const none = await env2.performRecall(GROUP, 1)
  ok('历史为空 → 失败', none.ok === false && env2.calls.length === 0, JSON.stringify(none))
  ok('失败原因说清「没有可撤的」', /没有最近一条可撤/.test(none.detail), none.detail)
  ok('日志写失败', env2.logs.some(l => l.includes('[RECALL] 失败')))

  // 序号超出已记条数
  const env3 = makeEnv()
  env3.noteSentMessage(GROUP, { message_id: 7001 })
  const outOfRange = await env3.performRecall(GROUP, 5)
  ok('序号超出实际条数 → 失败', outOfRange.ok === false && env3.calls.length === 0)
  ok('提示里带了序号', /倒数第 5 条/.test(outOfRange.detail), outOfRange.detail)

  // OneBot 侧报错（消息已过期 / 无权限 / retcode 非 0）
  const env4 = makeEnv({ behavior: () => ({ throw: 'onebot delete_msg 失败: retcode=1404 msg not found' }) })
  env4.noteSentMessage(GROUP, { message_id: 8001 })
  const proto = await env4.performRecall(GROUP, 1)
  ok('协议报错 → 失败', proto.ok === false, JSON.stringify(proto))
  ok('把真实报错带出来（不吞）', /delete_msg 失败/.test(proto.detail) && /1404/.test(proto.detail), proto.detail)
  ok('协议失败后保留历史（还可以重试别的）', (env4.sentMessages.get('group:9137001122') ?? []).length === 1)
}

console.log('\n=== 5. 频率限制：同一 peer 每分钟最多 2 条 ===')
{
  const env = makeEnv()
  for (let i = 0; i < 6; i++) env.noteSentMessage(GROUP, { message_id: 9000 + i })
  const r1 = await env.performRecall(GROUP, 1)
  const r2 = await env.performRecall(GROUP, 1)
  const r3 = await env.performRecall(GROUP, 1)
  ok('前 2 条成功', r1.ok && r2.ok, `${r1.ok},${r2.ok}`)
  ok('第 3 条被限频拦下', r3.ok === false, JSON.stringify(r3))
  ok('限频时根本不调 delete_msg', env.calls.length === 2, `calls=${env.calls.length}`)
  ok('限频提示带「太频繁」和等待秒数', /撤回太频繁/.test(r3.detail) && /\d+ 秒/.test(r3.detail), r3.detail)
  ok('被拦下的那条没被从历史删掉', (env.sentMessages.get('group:9137001122') ?? []).length === 4)

  // 不同 peer 互不影响
  for (let i = 0; i < 2; i++) env.noteSentMessage(C2C, { message_id: 9500 + i })
  const c = await env.performRecall(C2C, 1)
  ok('另一个 peer 的额度独立', c.ok === true, JSON.stringify(c))

  // 窗口滑过去就恢复
  const env2 = makeEnv()
  env2.recallAttempts.set('group:9137001122', [Date.now() - 61000, Date.now() - 60500])
  env2.noteSentMessage(GROUP, { message_id: 9700 })
  const afterWindow = await env2.performRecall(GROUP, 1)
  ok('1 分钟窗口滑过后恢复额度', afterWindow.ok === true, JSON.stringify(afterWindow))
}

console.log('\n=== 6. 下一轮 prompt 反馈：结果会喂回去，且只喂一次 ===')
{
  const env = makeEnv()
  env.noteSentMessage(GROUP, { message_id: 1100 })
  ok('没有撤回时 notice 为空', env.recallNoticeFor('group:9137001122') === null)
  await env.performRecall(GROUP, 1)
  const notice = env.recallNoticeFor('group:9137001122')
  ok('撤回后能取到结果文案', typeof notice === 'string' && /撤回结果/.test(notice), String(notice))
  ok('结果里明确标了成功', /✅/.test(notice), String(notice))
  ok('同一批结果只喂一次（取完即清）', env.recallNoticeFor('group:9137001122') === null)
  ok('只给对应 peer 的', env.recallNoticeFor('c2c:2468003344') === null)

  // 失败也要喂回去，防止模型张嘴就说「我撤了」
  const env2 = makeEnv()
  await env2.performRecall(GROUP, 1)
  const bad = env2.recallNoticeFor('group:9137001122')
  ok('失败结果也会喂回去', typeof bad === 'string' && /❌/.test(bad), String(bad))
  ok('失败文案不含「成功」字样（防止误读）', !/✅|成功/.test(bad), String(bad))
}

console.log('\n=== 7. prompt 片段：给模型的说明稳定且简短 ===')
{
  const env = makeEnv()
  const b = env.recallPromptBlock('group:9137001122')
  ok('是 text block', b.type === 'text' && typeof b.text === 'string')
  ok('写明 [RECALL:last] 语法', b.text.includes('[RECALL:last]'), b.text)
  ok('写明倒序序号语法', b.text.includes('[RECALL:2]'), b.text)
  ok('写明 2 分钟时限', /2 分钟/.test(b.text), b.text)
  ok('写明每分钟 2 条', /每分钟最多撤 2 条/.test(b.text), b.text)
  ok('长度受控（< 400 字，不撑爆 prompt）', b.text.length < 400, `len=${b.text.length}`)
  const withNotice = (() => {
    const e = makeEnv()
    e.recallNotes.set('group:1', ['✅ 最近一条：message_id=1'])
    return e.recallPromptBlock('group:1').text
  })()
  ok('有上一轮结果时一并带上', withNotice.includes('撤回结果'))
}

console.log('\n=== 8. 与既有标记共存 / 源码防漂移 ===')
{
  const env = makeEnv()
  // [RECALL] 与 [AT]、[SEND_FILE] 混写：各自剥离，互不干扰
  const r = env.extractRecalls('[AT:123456] 说错了 [RECALL:last] [SEND_FILE: /x.png]')
  ok('[RECALL] 剥离后 [AT] 还在', r.text.includes('[AT:123456]'), r.text)
  ok('[RECALL] 剥离后 [SEND_FILE] 还在', r.text.includes('[SEND_FILE: /x.png]'), r.text)
  ok('[RECALL] 本身没残留', !/RECALL/.test(r.text), r.text)

  ok('index.js 声明 RECALL_RE', /const RECALL_RE = /.test(src))
  ok('index.js 调 OneBot delete_msg', /gateway\.callData\('delete_msg'/.test(src))
  ok('index.js 所有出站点都走统一记账 noteSelfSent',
    (src.match(/noteSelfSent\(/g) ?? []).length >= 4, `count=${(src.match(/noteSelfSent\(/g) ?? []).length}`)
  ok('index.js 主回复流程调 performRecall', /await performRecall\(peer, idx\)/.test(src))
  ok('入站净化会打散伪造的 [RECALL:', /\[RECALL\\s\*:/.test(src))
  ok('AGENTS.md 已登记 [RECALL] 语法', /\[RECALL:last\]/.test(fs.readFileSync(path.join(ROOT, 'qq-agent/AGENTS.md'), 'utf8')))
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
