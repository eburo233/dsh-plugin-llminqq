// 配置加载器：config.json + 根目录 .env → 展开占位符 → 规范化路径。
//
// 为什么要有这一层（而不是 index.js 里一行 JSON.parse）：
//   这个仓库要能被别人 clone 下来直接用，所以 **config.json 里不能出现任何
//   本机绝对路径**。它只写 `${LLMINQQ_ROOT}/qq-agent` 这种占位符，运行时才
//   展开成真实路径。于是同一份 config.json 在 /home/a/xxx、/opt/qq、~/deploy
//   下都能跑，不需要 clone 完手改 8 处路径。
//
// 占位符语法（故意做得极简，只支持两种）：
//   ${VAR}           环境变量/`.env` 里的值；缺失时留空并在 stderr 警告
//   ${VAR:-default}  缺失时用 default
//   ${LLMINQQ_ROOT}  自动注入，值为仓库根目录（bridge/ 的上一级）
//
// `.env` 加载规则：**只认最朴素的 KEY=VALUE**。
//   不支持 `export`、不支持命令替换、不支持嵌套引号 —— 因为 deploy 侧的
//   start.sh 也用 `set -a; . .env; set +a` 读同一份文件，两边的解析结果必须一致。
//   写复杂语法会让「bridge 读到的」和「shell 读到的」不一致，那是最难查的一类 bug。

import fs from 'node:fs'
import path from 'node:path'


/**
 * 找到从 `start` 位置（必须是 `${`）开始的占位符的结束下标（指向配对的 `}`）。
 * 支持嵌套括号：`${A:-${B}}` 的结束位置是最后一个 `}`。
 * 找不到配对就返回 -1。
 */
function findPlaceholderEnd (text, start) {
  let depth = 0
  for (let i = start; i < text.length; i++) {
    if (text[i] === '$' && text[i + 1] === '{') { depth++; i++; continue }
    if (text[i] === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * 把一段 `${NAME}` / `${NAME:-fallback}` 的内部文本拆成 [name, fallback]。
 * fallback 里的占位符**稍后**再递归展开（否则嵌套会解析错）。
 */
function splitPlaceholderBody (body) {
  const sep = body.indexOf(':-')
  if (sep === -1) return [body.trim(), undefined]
  return [body.slice(0, sep).trim(), body.slice(sep + 2)]
}

/**
 * 极简 `.env` 解析：KEY=VALUE 一行一条，忽略空行与 # 注释。
 * 去掉成对的首尾引号（"..." 或 '...'），其余原样保留。
 * @param {string} text
 * @returns {Record<string,string>}
 */
export function parseEnv (text) {
  const out = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

/**
 * 读 `.env`：环境变量优先于文件（这样 `FOO=1 bash start.sh` 这类临时覆盖仍然有效）。
 * 文件不存在是正常情况（纯环境变量模式），返回空。
 */
export function loadDotEnv (root, env = process.env) {
  const file = path.join(root, '.env')
  let fromFile = {}
  try {
    fromFile = parseEnv(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    if (err.code !== 'ENOENT') {
      process.stderr.write(`[config] 读 ${file} 失败，忽略：${err.message}\n`)
    }
  }
  // env 里已定义（含空字符串）的键优先 —— 空字符串也算「用户明确设了」，
  // 否则想用空值覆盖 .env 里的值时永远做不到。
  const merged = { ...fromFile }
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) merged[k] = v
  }
  return merged
}

/**
 * 展开字符串里的 `${VAR}` / `${VAR:-default}`。
 * 未定义且没有默认值 → 留空 + 警告（不抛错：缺一个可选配置不该让桥起不来）。
 *
 * 支持**嵌套**（`${A:-${B:-x}}`）：用 findPlaceholderEnd 配对括号，默认值里的
 * 占位符递归展开。不能用正则 —— 正则会在第一个 `}` 处截断，把 `${A:-${B}}`
 * 解析成 `${A:-${B}`，剩下的 `}` 留在字符串尾巴上。这个坑实际踩到过：
 * B站 MCP 的 command 变成 `${HOME/.dsh/...}` 这种既不是变量也不是路径的东西。
 */
export function expandPlaceholders (text, vars, warn = () => {}, depth = 0) {
  if (depth > 8) return text          // 自指配置的保护上限
  let out = ''
  let i = 0
  while (i < text.length) {
    const start = text.indexOf('${', i)
    if (start === -1) { out += text.slice(i); break }
    out += text.slice(i, start)
    const end = findPlaceholderEnd(text, start)
    if (end === -1) { out += text.slice(start); break }
    const body = text.slice(start + 2, end)
    // 名字必须是合法标识符；否则（比如是 shell 的 ${1}）原样保留，别乱展开
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(body.trim().split(':-')[0].trim())) {
      out += text.slice(start, end + 1)
      i = end + 1
      continue
    }
    const [name, fallback] = splitPlaceholderBody(body)
    const value = vars[name]
    if (value !== undefined) {
      out += value
    } else if (fallback !== undefined) {
      out += expandPlaceholders(fallback, vars, warn, depth + 1)
    } else {
      warn(`配置占位符 \${${name}} 未定义（.env / 环境变量里没有），已展开为空`)
    }
    i = end + 1
  }
  return out
}

/**
 * 递归展开对象里所有字符串值的占位符。数组/嵌套对象都走一遍。
 * 非字符串（数字、布尔、null）原样返回 —— 占位符只可能出现在字符串里。
 */
export function expandDeep (value, vars, warn) {
  if (typeof value === 'string') return expandPlaceholders(value, vars, warn)
  if (Array.isArray(value)) return value.map(v => expandDeep(v, vars, warn))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = expandDeep(v, vars, warn)
    return out
  }
  return value
}

/**
 * 需要规范化的「路径类」配置键。
 *
 * 规则：值不是以 `/` 开头的（相对路径）→ 相对**仓库根**解析。
 * 这样 `${LLMINQQ_ROOT}/...` 展开后是绝对路径（原样保留），而手写的
 * `qq-agent/memory/corpus` 这种相对写法也能正确落到仓库内。
 *
 * ⚠️ 刻意**不含** `dsh.bin`：它可能是裸命令名（`dsh`），要交给 PATH 查，
 *    当相对路径解析成 `<root>/dsh` 就找不到了。
 */
const PATH_KEYS = [
  'dsh.cwd',
  'media.stagingDir',
  'log.file',
  'persona.path',
  'memory.dir',
  'memory.db',
  'memory.digestPath',
  'memory.memctl',
  'style.dir',
  'style.script',
  'style.jsonl',
  'style.cursorDir',
  'learning.dir',
  'learning.script',
  'learning.json',
  'learning.corpusDir',
  'learning.logDir',
]

function getPath (obj, dotted) {
  return dotted.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj)
}

function setPath (obj, dotted, value) {
  const keys = dotted.split('.')
  let cur = obj
  for (const k of keys.slice(0, -1)) {
    if (!cur[k] || typeof cur[k] !== 'object') return
    cur = cur[k]
  }
  cur[keys[keys.length - 1]] = value
}

/** 把 PATH_KEYS 里的相对路径统一解析成绝对路径（相对仓库根）。 */
export function normalizePaths (config, root) {
  for (const key of PATH_KEYS) {
    const value = getPath(config, key)
    if (typeof value !== 'string' || !value) continue
    if (path.isAbsolute(value)) continue
    setPath(config, key, path.resolve(root, value))
  }
  return config
}

/**
 * 数字型配置键。
 *
 * 为什么需要这一步：占位符展开后 `"port": "${LLMINQQ_API_PORT:-18080}"` 会变成
 * 字符串 `"18080"`。`server.listen('18080')` 虽然能跑（Node 会转），但
 * `port === 18080` 这类比较、以及 `/health` 里回显的类型就会变得不一致。
 * 所以展开后统一把这些键转回 number；转不了（用户填了非数字）就抛出
 * 明确错误，别让它在 listen 时才炸。
 */
const NUMBER_KEYS = [
  'server.port',
  'onebot.reconnectMs',
  'onebot.heartbeatTimeoutMs',
  'dsh.startTimeoutMs',
  'dsh.turnTimeoutMs',
  'media.maxFileBytes',
  'persona.maxBytes',
  'policy.maxReplyChars',
  'policy.replyChunkDelayMs',
  // 注意：policy.cooldownMsPerPeer 不在这里 —— 它由 normalizePolicy 处理，
  // 非法值要**回落默认**而不是像这里一样抛错（设置页/手改 config 都不该把桥弄挂）。
  'proactive.tickMin',
  'proactive.cooldownMin',
  'learning.biliNum',
  'learning.timeout',
  'learning.totalTimeout',
  'tts.maxChars',
]

// ── policy.cooldownMsPerPeer ───────────────────────────────────────────────
// 「同一会话最小回复间隔」，防 LLM 延迟导致的连发（同一个 peer 短时间多条
// 请求会各起一轮 LLM，回复叠着发出去）。
//
// 默认 1500ms 而不是 0：0 = 完全关闭限流，默认开闸等于把连发问题交给用户自行发现。
// 0 仍然是合法值（显式关闭），所以用「缺省 → 默认」而不是「0 → 默认」。
/** 默认值（ms）。 */
export const DEFAULT_COOLDOWN_MS_PER_PEER = 1500
/** 下限：0 = 关闭限流。 */
export const MIN_COOLDOWN_MS_PER_PEER = 0
/** 上限 60s：再大就等于「这个会话基本不回」，多半是填错了。 */
export const MAX_COOLDOWN_MS_PER_PEER = 60000

/**
 * 归一化 policy.cooldownMsPerPeer：
 *   · 缺省 / null / 空串 / 非数字字符串 → 默认 1500
 *   · 负数 → 0（非负保证）
 *   · 超过上限 → 60000
 *   · 小数 → 四舍五入到整数 ms
 * 其余 policy 键原样保留（它们是布尔/数组，不需要动）。
 *
 * @param {object} config 就地修改并返回
 */
export function normalizePolicy (config) {
  if (!config || typeof config !== 'object') return config
  if (!config.policy || typeof config.policy !== 'object') config.policy = {}
  config.policy.cooldownMsPerPeer = normalizeCooldown(config.policy.cooldownMsPerPeer)
  return config
}

function normalizeCooldown (value) {
  if (value === undefined || value === null) return DEFAULT_COOLDOWN_MS_PER_PEER
  if (typeof value === 'string' && value.trim() === '') return DEFAULT_COOLDOWN_MS_PER_PEER
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return DEFAULT_COOLDOWN_MS_PER_PEER
  if (n <= MIN_COOLDOWN_MS_PER_PEER) return MIN_COOLDOWN_MS_PER_PEER
  if (n >= MAX_COOLDOWN_MS_PER_PEER) return MAX_COOLDOWN_MS_PER_PEER
  return Math.round(n)
}

export function normalizeNumbers (config) {
  for (const key of NUMBER_KEYS) {
    const value = getPath(config, key)
    if (value === undefined || value === null) continue
    if (typeof value === 'number') continue
    const n = Number(value)
    if (!Number.isFinite(n)) {
      throw new Error(`配置项 ${key} 必须是数字，实际得到 ${JSON.stringify(value)}（检查 .env 里对应的变量）`)
    }
    setPath(config, key, n)
  }
  return config
}

/**
 * 一次性加载：读文件 → 展开 `.env` → 展开占位符 → 规范化路径 → policy 默认值/边界 → 数字。
 *
 * @param {object} opts
 * @param {string} opts.root        仓库根目录（`${LLMINQQ_ROOT}` 的值，相对路径的基准）
 * @param {string} [opts.configPath] 配置文件路径，默认 `<root>/bridge/config.json`
 * @param {object} [opts.env]        环境变量来源，默认 process.env
 * @param {(msg:string)=>void} [opts.warn] 警告输出（默认写 stderr）
 * @returns {{config: object, vars: Record<string,string>, configPath: string, dotenvPath: string}}
 */
export function loadConfig ({ root, configPath, env = process.env, warn } = {}) {
  if (!root) throw new Error('loadConfig: 必须提供 root')
  const warnFn = warn ?? (msg => process.stderr.write(`[config] ${msg}\n`))
  const resolvedConfigPath = configPath ?? path.join(root, 'bridge', 'config.json')

  const raw = JSON.parse(fs.readFileSync(resolvedConfigPath, 'utf8'))

  const dotenvPath = path.join(root, '.env')
  const vars = loadDotEnv(root, env)
  // LLMINQQ_ROOT 永远是仓库根，允许环境变量覆盖（镜像/容器化部署时用得上）
  vars.LLMINQQ_ROOT = vars.LLMINQQ_ROOT || root

  const config = normalizePaths(expandDeep(raw, vars, warnFn), root)
  // policy 的默认值/边界在 normalizeNumbers **之前**补齐：这样 `"${X:-abc}"`
  // 这类非法字符串会回落默认，而不是让 normalizeNumbers 抛错把桥拦在启动前。
  normalizePolicy(config)
  normalizeNumbers(config)
  // MCP 服务器：过滤掉目标机上不存在的可选服务，别让一条可选依赖挡住整条通道。
  // 判据是 config 里显式写了 `optional: true` —— 没有这个标记的一律保留（缺了就该报错）。
  if (Array.isArray(config.mcpServers)) {
    const kept = []
    for (const srv of config.mcpServers) {
      if (srv?.optional && typeof srv.command === 'string' && srv.command && !fs.existsSync(srv.command)) {
        warnFn(`MCP 服务器 "${srv.name}" 标记为 optional 但找不到 command=${srv.command}，已跳过`)
        continue
      }
      kept.push(srv)
    }
    config.mcpServers = kept
  }
  return { config, vars, configPath: resolvedConfigPath, dotenvPath }
}
