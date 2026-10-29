// reflection_llm.mjs —— 给 memctl.py 用的「调一次模型」小工具
//
// 为什么单独一个 .mjs：记忆系统是 Python，而 DSH 的 ACP 客户端在 bridge/acp.js
// （JS）。让 Python 直接说 ACP 协议太重，所以这里做一个薄壳：
//   python 把 prompt 写进临时文件 → 起这个脚本 → 它读 prompt 调模型 → 把回复写进
//   结果文件 → python 读回来。
// 这样 Python 侧完全不需要知道 ACP/JSON-RPC 的存在，也方便测试时整块 mock 掉。
//
// 用法：
//   node reflection_llm.mjs --prompt-file P --out-file O [--config C] [--timeout S]
//
// 退出码：0 成功；2 模型不可用（没配置/启动失败）；3 调用超时；1 其它错误
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// ── 双布局定位（插件版 / 脚本版都能跑）──────────────────────────────────
// 这个文件有两处宿主位置，路径推导必须都认：
//
//   脚本版  <repo>/qq-agent/memory/reflection_llm.mjs
//           → config 在 <repo>/bridge/config.json，acp 在 <repo>/bridge/acp.js
//   插件版  <plugin>/lib/agent/memory/reflection_llm.mjs
//           → config 由桥 spawn 时用 LLMINQQ_CONFIG 指过来（在 dataDir 里生成，
//             不在包内），acp 在 <plugin>/lib/bridge/acp.js
//
// 原来只有 `path.resolve(HERE, '..', '..')` 这一种算法（= 假设「本文件往上两层
// 就是项目根」）。脚本版成立，**插件版指向包根**——那里既没有 bridge/config.json
// 也没有 bridge/acp.js，于是反思永远报
//   `cannot read config .../bridge/config.json`
// 而 memctl.py 那边只会看到「LLM 不可用 → 退回拼接法」，用户完全看不出原因。
//
// 所以改成**显式优先 + 候选探测**，不猜单一布局：
//   ① `LLMINQQ_CONFIG` 环境变量（桥 spawn python 时已经带了，最可靠）
//   ② `--config` 参数（手工跑时用）
//   ③ 各布局的候选默认路径，逐个存在性检查
function firstExisting(cands) {
  for (const c of cands) { if (c && fs.existsSync(c)) return c }
  return null
}

/** 包/仓库根的候选：「本文件往上 2 层」（脚本版）与「往上 4 层」（插件版 lib/agent/memory）。 */
const ROOT_CANDS = [
  path.resolve(HERE, '..', '..'),          // 脚本版：qq-agent/memory → 仓库根
  path.resolve(HERE, '..', '..', '..', '..'), // 插件版：lib/agent/memory → 包根
]

/** config.json 候选：env 最优先（桥生成的那份才是真配置）。 */
function resolveConfigPath() {
  const fromArg = arg('config')
  if (fromArg) return fromArg
  const fromEnv = process.env.LLMINQQ_CONFIG
  if (fromEnv) return fromEnv
  return firstExisting(ROOT_CANDS.map(r => path.join(r, 'bridge', 'config.json')))
}

/** acp.js 候选：插件版在 lib/bridge/acp.js，脚本版在 bridge/acp.js。 */
function resolveAcpPath() {
  const cands = [
    path.resolve(HERE, '..', '..', 'bridge', 'acp.js'),   // 插件版 lib/agent/memory → lib/bridge
    path.resolve(HERE, '..', '..', '..', 'bridge', 'acp.js'), // 兼容：往上三层
  ]
  for (const r of ROOT_CANDS) cands.push(path.join(r, 'bridge', 'acp.js'))
  return firstExisting(cands)
}

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def
}

function die(code, msg) {
  process.stderr.write(`reflection_llm: ${msg}\n`)
  const out = arg('out-file')
  if (out) {
    try {
      fs.writeFileSync(out, JSON.stringify({ ok: false, error: msg }), 'utf8')
    } catch { /* ignore */ }
  }
  process.exit(code)
}

const promptFile = arg('prompt-file')
const outFile = arg('out-file')
if (!promptFile || !outFile) die(1, 'missing --prompt-file or --out-file')

let prompt = ''
try {
  prompt = fs.readFileSync(promptFile, 'utf8')
} catch (e) {
  die(1, `cannot read prompt: ${e.message}`)
}

// ── 读桥的配置，复用主路由（别另配一套模型）──────────────────────────────
const cfgPath = resolveConfigPath()
if (!cfgPath) {
  die(2, '找不到桥配置：设 LLMINQQ_CONFIG 环境变量，或用 --config 指定'
    + `（试过：${ROOT_CANDS.map(r => path.join(r, 'bridge', 'config.json')).join(' | ')}）`)
}
let cfg = {}
try {
  cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
} catch (e) {
  die(2, `cannot read config ${cfgPath}: ${e.message}`)
}

const dsh = cfg.dsh ?? {}
if (!dsh.bin || !dsh.profile || !dsh.provider || !dsh.model) {
  die(2, 'config.json 的 dsh 段缺少 bin/profile/provider/model')
}

const acpPath = resolveAcpPath()
if (!acpPath) die(2, '找不到 bridge/acp.js（插件包不完整？试过 lib/bridge/acp.js 与 bridge/acp.js）')
const { AcpRuntime } = await import(acpPath)

const timeoutSec = Number(arg('timeout', '180'))

// 反思用**独立的小模型**，不占主路由。
// 实测（同一 prompt，2026-10-25）：
//   trae/glm-5.3-flashx      29.7s  ← 最快
//   qodercn/gmodel (GLM-5.3)  42.0s
//   qodercn/gfmodel          45.3s
//   trae/deepseek-v4.1-flash 77.8s  ← 主路由，太慢
//   trae/qwen3.8-flash       87.3s
//   qodercn/dfmodel / qfmodel / mimo / minimax  >100s 超时
// 反思是「读一堆对话 → 归纳几条」，不需要顶级模型，用小快模型足够，
// 而且不跟主对话抢额度。
const refl = cfg.memory?.reflection ?? {}
const useProvider = refl.provider || dsh.provider
const useModel = refl.model || dsh.model
const useEffort = refl.reasoningEffort ?? dsh.reasoningEffort

const rt = new AcpRuntime({
  bin: dsh.bin,
  profile: dsh.profile,
  // 工作目录：config 里显式给了就听它的；否则插件版用记忆数据目录（stateDir），
  // 脚本版用 <repo>/qq-agent。原来写死 PROJECT/qq-agent，插件版会指到包内（只读）。
  cwd: dsh.cwd
    || process.env.LLMINQQ_STATE_DIR
    || path.join(ROOT_CANDS[0], 'qq-agent'),
  provider: useProvider,
  model: useModel,
  reasoningEffort: useEffort,
  // 反思只需要「读记忆 + 想」→ 不需要挂 MCP，省启动时间和 token
  mcpServers: [],
  startTimeoutMs: Math.min(timeoutSec * 1000, 90000),
  turnTimeoutMs: timeoutSec * 1000,
  log: (m) => process.stderr.write(`[reflection_llm] ${m}\n`),
})

let result
try {
  await rt.start()
  // 用固定 peerKey：反思是内部任务，不该和任何真实对话共享会话
  const r = await rt.prompt('memory:reflection', [{ type: 'text', text: prompt }])
  result = { ok: true, text: r?.text ?? '', reason: r?.reason ?? 'end_turn' }
} catch (e) {
  const msg = String(e?.message || e)
  try { rt.stop() } catch { /* ignore */ }
  if (/超时|timeout/i.test(msg)) die(3, msg)
  die(2, msg)
}

try { rt.stop() } catch { /* ignore */ }
try {
  fs.writeFileSync(outFile, JSON.stringify(result), 'utf8')
} catch (e) {
  die(1, `cannot write out-file: ${e.message}`)
}
process.stderr.write('reflection_llm: done\n')
// 给子进程一点时间收尾，别卡在僵尸状态
setTimeout(() => process.exit(0), 300)
