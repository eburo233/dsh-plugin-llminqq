// test/unit-v5-health.test.mjs —— scripts/v5-health.mjs（记忆 v5 体检/自愈脚本）
//
// 为什么值得测：这个脚本的定位是「人不用手工敲那 13 条检查」，所以它自己错更危险 ——
// 报了绿灯但实际有问题 = 比不检查还糟。这里用**临时数据目录**跑真脚本，验三件事：
//   1. 缺 bridge-config → 退出码 2（严重），且 JSON 里 bad > 0
//   2. 正常配置 → 能读出引擎/路由，退出码 0 或 1（1=有警告）
//   3. --fix 把用户配置里已有的 v5/reflection 补进 bridge-config，并清掉摊平残留
//
// 注意：进程检查（pgrep bridge/index.js）是**看整机**的，测试里不断言它的具体值，
// 只断言 JSON 里有这一项 —— 否则测试会随「本机有没有在跑桥」而红绿不定。

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SCRIPT = path.join(ROOT, 'scripts', 'v5-health.mjs')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'llminqq-v5health-'))
after(() => fs.rmSync(TMP, { recursive: true, force: true }))

let seq = 0
/** 造一个假的数据目录；返回它的路径。 */
function mkData (files = {}) {
  const dir = path.join(TMP, `d${seq++}`)
  fs.mkdirSync(path.join(dir, 'agent', 'memory'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true })
  for (const [name, obj] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), JSON.stringify(obj, null, 2))
  }
  return dir
}

function run (dir, extraArgs = []) {
  const r = spawnSync(process.execPath, [SCRIPT, '--data-dir', dir, '--json', ...extraArgs], { encoding: 'utf8' })
  let json = null
  try { json = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))) } catch { json = null }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr }
}

const OK_BRIDGE_CFG = {
  memory: {
    enabled: true,
    v5: { enabled: true, engine: 'v5', distill: { enabled: true, intervalMin: 10 } },
    reflection: { provider: 'trae', model: 'glm-5.3-flashx', reasoningEffort: 'low' },
  },
  affection: { splitChars: 30, splitMaxParts: 5 },
}
const OK_USER_CFG = {
  memory: {
    enabled: true,
    v5: { enabled: true, engine: 'v5', distill: { enabled: true, intervalMin: 10 } },
    reflection: { provider: 'trae', model: 'glm-5.3-flashx', reasoningEffort: 'low' },
  },
}

test('缺 bridge-config → 退出码 2，且报告里是 bad', () => {
  const dir = mkData()
  const { code, json } = run(dir)
  assert.equal(code, 2, '缺核心配置必须是非零严重码')
  const hit = json.results.find(r => r.name === 'bridge-config.json')
  assert.ok(hit, '报告里应该提到 bridge-config.json')
  assert.equal(hit.level, 'bad')
})

test('正常配置：能读出 engine=v5 和记忆子进程路由', () => {
  const dir = mkData({ 'bridge-config.json': OK_BRIDGE_CFG, 'config.json': OK_USER_CFG })
  const { json } = run(dir)
  const engine = json.results.find(r => r.name === '引擎')
  assert.ok(engine, '没有引擎检查项')
  assert.equal(engine.level, 'ok')
  assert.match(engine.detail, /v5/)
  const refl = json.results.find(r => r.name === '记忆子进程路由')
  assert.ok(refl, '没有路由检查项')
  assert.equal(refl.level, 'ok')
  assert.match(refl.detail, /glm-5\.3-flashx/)
})

test('旧插件摊平的 engine 也能被认出来（不能误报成 v4）', () => {
  // 现场就是这么卡住的：桥配置里只有顶层 memory.engine，没有 memory.v5
  const dir = mkData({
    'bridge-config.json': { memory: { enabled: true, engine: 'v5', distill: { intervalMin: 10 } } },
    'config.json': OK_USER_CFG,
  })
  const { json } = run(dir)
  const engine = json.results.find(r => r.name === '引擎')
  assert.equal(engine.level, 'ok', '兼容旧形状时不该报 v4')
})

test('路由缺失但用户配置里有 → 报 warn（宿主旧代码会抹掉它）', () => {
  const dir = mkData({
    'bridge-config.json': { memory: { enabled: true, v5: { enabled: true, engine: 'v5' } } },
    'config.json': OK_USER_CFG,
  })
  const { json } = run(dir)
  const refl = json.results.find(r => r.name === '记忆子进程路由')
  assert.equal(refl.level, 'warn')
  assert.match(refl.detail, /缺失/)
})

test('--fix：把用户配置里的 v5/reflection 补进 bridge-config，并清掉摊平残留', () => {
  const dir = mkData({
    // 宿主旧代码写出来的样子：摊平 + 没有 reflection
    'bridge-config.json': { memory: { enabled: true, engine: 'v5', distill: { intervalMin: 10 } }, affection: { splitChars: 30 } },
    'config.json': OK_USER_CFG,
  })
  const { code, json } = run(dir, ['--fix'])
  // 注意：假目录里没有真 sqlite 库，所以「v4 库缺失」会合理地报 bad（退出码 2）。
  // 这里不拿总退出码当断言，只验 --fix 该改的东西改了 —— 否则测的是环境而不是逻辑。
  assert.ok(json, '--fix 也要能输出 JSON')
  void code
  const fixed = JSON.parse(fs.readFileSync(path.join(dir, 'bridge-config.json'), 'utf8'))
  assert.ok(fixed.memory.v5, '应补出嵌套的 memory.v5')
  assert.equal(fixed.memory.v5.engine, 'v5')
  assert.equal(fixed.memory.engine, undefined, '摊平的 engine 应被清掉（避免两套并存被误读）')
  assert.equal(fixed.memory.distill, undefined, '摊平的 distill 应被清掉')
  assert.equal(fixed.memory.reflection.model, 'glm-5.3-flashx', 'reflection 应被补上')
  assert.deepEqual(fixed.affection, { splitChars: 30 }, '别的段不能被改动')
})

test('--fix 在没缺字段时不改文件（幂等）', () => {
  const dir = mkData({ 'bridge-config.json': OK_BRIDGE_CFG, 'config.json': OK_USER_CFG })
  const p = path.join(dir, 'bridge-config.json')
  const before = fs.readFileSync(p, 'utf8')
  run(dir, ['--fix'])
  assert.equal(fs.readFileSync(p, 'utf8'), before, '没有需要补的字段时不该重写文件')
})

test('v4 库缺失要报 bad（回滚能力没了，必须显眼）', () => {
  const dir = mkData({ 'bridge-config.json': OK_BRIDGE_CFG, 'config.json': OK_USER_CFG })
  const { json } = run(dir)
  const v4 = json.results.find(r => r.name === 'v4 库（回滚用）')
  assert.ok(v4, '没有 v4 库检查项')
  assert.equal(v4.level, 'bad', 'v4 库是回滚唯一依据，缺了必须报严重')
})

// 回归：进程检查不能被「命令行里提到 bridge/index.js 的进程」骗到
// 第一版用 `pgrep -f bridge/index.js` 直接数，结果把 shell 包装/父 shell 也算成桥，
// 报「2 个桥」（实际只有 1 个）—— 这种假严重比漏报更耗人：会让人去杀正确的进程。
test('进程检查只认「node + 以 lib/bridge/index.js 结尾的参数」', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8')
  assert.match(src, /pgrep/, '还是用 pgrep 找候选（没问题）')
  assert.match(src, /basename|node\(\\\.exe\)\?\$|node/, '要有 argv[0] 是 node 的判定')
  assert.match(src, /lib\[\\\\\/\]bridge\[\\\\\/\]index\\\.js\$/, '脚本参数必须**以** lib/bridge/index.js **结尾**，不能是「包含」')
  assert.doesNotMatch(src, /pgrep'\s*,\s*\['-c'\]/, '不要用 pgrep -c 计数（它按命令行子串匹配）')
})

// 死信作业要分「还挡着进度」和「历史残留」
// 现场困扰：3 个死信作业的 watermark 早已被后续成功作业越过（1178/1538/1558
// vs 当前 2122），事件其实都处理过了 —— 但健康检查每次都报「3 个死信」，
// 变成永远不会消失的假警报。人不该被训练成忽略警告。
test('死信分类：watermark 已过的历史死信不该报警', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8')
  assert.match(src, /staleDead/, '要有「历史死信」分类')
  assert.match(src, /liveDead/, '要有「仍在挡进度」分类')
  assert.match(src, /json_extract\(payload,'\$\.watermark'\)/, '要读作业 payload 里的 watermark 才能判断')
  // 历史死信走 ok，仍挡进度才 warn
  const staleBlock = src.slice(src.indexOf('else if (staleDead.length > 0)'), src.indexOf('else if (staleDead.length > 0)') + 200)
  assert.match(staleBlock, /add\('ok'/, '历史死信应报 ok 而不是 warn')
})
