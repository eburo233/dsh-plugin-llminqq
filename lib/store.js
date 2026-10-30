// 配置存储：设置页读写的那份 JSON。
//
// 设计取舍（都踩过坑）：
//   ① **独立文件，不写 profile 的 cordis.patch.yml**。
//      profile patch 是「组合层」，写它需要 configEditor、且格式一错整个 profile 起不来；
//      而这个插件的配置有几十项、还会被设置页频繁改。放在 ~/.dsh/dsh-plugin-llminqq/config.json
//      里，插件自己校验、自己迁移，坏了也只影响插件本身，不会把整个 DSH 拖死。
//   ② **文件里绝不存明文以外的惊喜**：就是普通 JSON，人能直接改、能 diff、能进版本控制
//      （除了 .env 那类凭据）。凭据（QQ 号/token）单独存 .env 风格的 secrets.json，
//      权限 0600，和 config.json 分开 —— 这样把 config.json 发给别人求助时不会泄露凭据。
//   ③ **写入原子化**：先写 .tmp 再 rename。设置页保存时如果进程被杀，
//      不会留下半个 JSON 把插件永久锁死（readConfig 解析失败会回落默认值，但那意味着丢配置）。

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

/** 插件数据目录：`$DSH_HOME/dsh-plugin-llminqq`，默认 `~/.dsh/dsh-plugin-llminqq`。 */
export function dataDir () {
  // 优先级：DSH_HOME > 从「插件自己所在路径」反推 > os.homedir()/.dsh
  //
  // 为什么不能直接用 process.env.HOME（真实踩坑）：
  //   Windows 上 HOME 常常没设，或者被 Git Bash / MSYS 设成别的路径；
  //   Electron 桌面版更可能把 DSH_HOME 指到 D:\dsh-home 这种非默认位置。
  //   结果插件把数据写到 C:\Users\X\.dsh\...，而 dsh 真正的 home 在 D:\dsh-home
  //   —— 表现为「设置页改了但桥读不到」「agent 工作区跑到 C 盘」。
  //
  //   这次就是从桥日志发现的：cwd=C:\Users\<你>\.dsh\dsh-plugin-llminqq\agent
  //   而用户的 dsh home 是 D:\dsh-home。
  // ⚠️ 顺序很重要：**先从安装路径反推，再退回 DSH_HOME**。
  //
  // 为什么反推优先（真实踩坑的教训）：
  //   DSH_HOME 环境变量常常「存在但不对」——比如 Electron 桌面版设的是
  //   C:\Users\X\.dsh，而用户实际的 dsh home 在 D:\dsh-home。
  //   按 DSH_HOME 写就会把数据/i人设/记忆写到另一个盘的另一份目录，
  //   表现为「设置页改了但没生效」「agent 工作区跑错地方」。
  //
  //   而「插件自己被装在哪里」是事实，不是猜测：
  //   <dshHome>/profiles/<profile>/node_modules/dsh-plugin-llminqq/lib
  //   反推出来的 dshHome 必然就是 dsh 真正在用的那个。
  //
  //   只有当反推不出来时（比如从源码目录直接跑），才用 DSH_HOME 兜底。
  try {
    const here = path.dirname(fileURLToPath(import.meta.url))   // .../lib
    const pkgRoot = path.dirname(here)                          // .../dsh-plugin-llminqq
    const nodeModules = path.dirname(pkgRoot)                   // .../node_modules
    const profileDir = path.dirname(nodeModules)                // .../profiles/<name>
    const profilesDir = path.dirname(profileDir)                // .../profiles
    if (path.basename(profilesDir) === 'profiles') {
      const dshHome = path.dirname(profilesDir)
      if (fs.existsSync(dshHome)) return path.join(dshHome, 'dsh-plugin-llminqq')
    }
  } catch { /* 反推失败，走下面的兜底 */ }

  // 兜底 ①：DSH_HOME（反推不出来时才信它）
  const explicit = process.env.DSH_HOME
  if (explicit) return path.join(explicit, 'dsh-plugin-llminqq')

  // 兜底 ②：用户主目录
  return path.join(os.homedir(), '.dsh', 'dsh-plugin-llminqq')
}

export const CONFIG_FILE = () => path.join(dataDir(), 'config.json')
export const SECRETS_FILE = () => path.join(dataDir(), 'secrets.json')
export const STATE_FILE = () => path.join(dataDir(), 'state.json')
export const QR_FILE = () => path.join(dataDir(), 'qr.png')

/** 默认配置。设置页「恢复默认」就是写回这一份。 */
export function defaults () {
  return {
    // ── 总开关 ────────────────────────────────────────────────────────────
    enabled: false,

    // ── OneBot 连接（NapCat） ─────────────────────────────────────────────
    onebot: {
      wsUrl: 'ws://127.0.0.1:3001',
      token: '',
      reconnectMs: 3000,
      heartbeatTimeoutMs: 90000,
    },

    // ── NapCat 容器管理（插件可以替你拉起/停掉它） ──────────────────────────
    napcat: {
      // managed=true 时插件自己 docker compose 起容器；false 表示你手动管
      managed: true,
      composeFile: '',          // 留空 = 用插件自带的 compose 模板
      containerName: 'llminqq-napcat',
      image: 'mlikiowa/napcat-docker:v4.15.19',
      webuiPort: 6099,
      webuiToken: '',           // 留空 = 首次启动时随机生成并存进 secrets
      onebotPort: 3001,
      uid: 1000,
      gid: 1000,
      timezone: 'Asia/Shanghai',
      memLimit: '2g',
    },

    // ── LLM 运行时 ────────────────────────────────────────────────────────
    dsh: {
      // 空 = 用宿主进程自己的 dsh（多数情况如此）
      bin: '',
      profile: '',              // 空 = 用宿主 profile 名
      cwd: '',                  // 空 = 用插件数据目录下的 agent 工作区
      // 默认走 DSH 账号路由：它用的是桌面版里已经登录过的账号 token，
      // 不依赖环境变量。deepseek-official 需要 DEEPSEEK_API_KEY，没配就会在
      // turn 阶段报 `no API key for provider route`。
      provider: 'deepseek-account',
      model: 'deepseek-flash',
      reasoningEffort: 'high',
      // 降级链：主路由连续失败 N 次后依次切到这里
      fallbackRoutes: [],
      failover: {
        enabled: true,
        consecutiveFailures: 2,
        cooldownMs: 300000,
        probeBackMs: 180000,
      },
      protocol: 'acp',          // acp（支持 MCP）| sdk
      startTimeoutMs: 60000,
      turnTimeoutMs: 180000,
    },

    // ── 行为策略 ──────────────────────────────────────────────────────────
    policy: {
      allowC2C: true,
      allowUsers: [],
      allowGroups: [],
      requireAtInGroup: true,
      maxReplyChars: 1500,
      replyChunkDelayMs: 400,
      ignoreSelf: true,
      cooldownMsPerPeer: 1500,
      timezone: 'Asia/Shanghai',
      quietHours: { enabled: false, startHour: 1, endHour: 7 },
      maxTurnsPerSession: 400,
    },

    // ── 媒体 ──────────────────────────────────────────────────────────────
    media: {
      enabled: true,
      stagingDir: '',           // 空 = 插件数据目录下 .qq-media
      maxFileBytes: 10485760,
      sensitiveNames: ['.ssh', '.env', 'credentials', 'id_rsa', 'id_ed25519', 'secret', 'token'],
    },

    // ── 本地运维 API ──────────────────────────────────────────────────────
    server: {
      enabled: true,
      host: '127.0.0.1',
      port: 18080,
      token: '',                // 空 = 首次启动随机生成并存进 secrets
    },

    // ── 人格 / 记忆 ───────────────────────────────────────────────────────
    persona: {
      path: '',                 // 空 = 插件数据目录下 agent/persona/persona.md
      maxBytes: 32768,
      // 每轮注入策略：'once'（首轮+变更时）| 'always'（每轮全文，费 token）
      injectMode: 'once',
    },
    memory: {
      enabled: true,
      dir: '',                  // 空 = <dataDir>/memory（~/.dsh/dsh-plugin-llminqq/memory），见 agent/dirs.mjs
      // 记忆数据目录。空 = <dataDir>/memory —— 和配置/日志/人格放同一个根，
      // 备份/迁移/排查只看一个地方（旧版本在 ~/.dsh/llminqq，启动时自动迁移）。
      stateDir: '',
      // 手动指定 python 解释器。空 = 自动探测 python3 → python → py -3
      pythonBin: '',
    },

    // ── 可选能力 ──────────────────────────────────────────────────────────
    features: {
      voice: false,             // [VOICE:] 语音
      poke: true,               // [POKE:] 戳一戳
      recall: true,             // [RECALL:] 撤回
      follow: true,             // [FOLLOW:] 补一句
      welcome: false,           // 入群欢迎
      proactive: false,         // 主动找人说话
      style: false,             // 自我风格样本库
      learning: false,          // 说话方式学习
      bili: false,              // B站 MCP
      // 🔴 P0b：桥内定时任务（反思 8h / 学习 12h），替代脚本版的 systemd timer。
      // 默认 **true**：这是「开箱即用」的一部分 —— 装完插件不用再配 cron/systemd。
      // 没有 python 时任务自动跳过，并在设置页说明原因（不是报错）。
      scheduler: true,
    },

    // ── MCP 工具服务器（B站两种能力） ────────────────────────────────────────
    // 为什么单独一段而不是塞进 features：
    //   features 是「开/关」布尔；MCP 还要记路径、解释器、venv 这些**资源位置**。
    //   混在一起会让设置页没法分节显示，也让「依赖缺失给原因」无处存放。
    //
    // 两种能力依赖差异很大，所以默认值不同：
    //   storyboard：纯 Node + 系统 ffmpeg/ffprobe → **默认开**（装完就能用）
    //   bili      ：需要 Python + venv（mcp / bilibili-api-python 等）→ **默认关**
    //               （不能默认开：默认开会在没装依赖的用户那里变成「一直报错」）
    mcp: {
      storyboard: {
        enabled: true,
      },
      bili: {
        enabled: false,
        // 空 = 自动探测：优先用 venv 里的 python，其次 PATH 上的 python3/python
        pythonBin: '',
        // 空 = 用包内 vendor/bilibili-mcp/mcp_server.py
        serverPath: '',
        // 空 = <stateDir>/bili/bili_credential.json（扫码登录产物）
        credentialPath: '',
        // 用户自建 venv 的根目录（里面应有 bin/python 或 Scripts/python.exe）。
        // 空 = 没有 venv → bili 能力报「依赖缺失」而不是静默
        venv: '',
        // 首次安装依赖用（P3 才实现自动装；这一期只记录，供设置页显示命令）
        autoInstall: false,
      },
    },

    // ── 主动发言（features.proactive 打开后生效） ───────────────────────────
    proactive: {
      baseProb: 0.1,
      step: 0.05,
      maxProb: 0.6,
      guaranteeCount: 6,
      cooldownMin: 40,
      tickMin: 20,
      whitelist: [],
    },

    // ── 高级：透传给桥的原始配置（power user 用） ───────────────────────────
    advanced: {
      rawJson: '',              // 整段 JSON，会深合并覆盖上面所有默认值
    },
  }
}

/** 深合并：数组整体替换（不是拼接），对象递归合并，null 表示「显式清空」。 */
export function deepMerge (base, patch) {
  if (patch === null || patch === undefined) return base
  if (Array.isArray(patch)) return patch
  if (typeof patch !== 'object') return patch
  if (typeof base !== 'object' || base === null || Array.isArray(base)) base = {}
  const out = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(base[k], v) : v
  }
  return out
}

function ensureDir (dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
}

/** 原子写：先写临时文件再 rename。避免半个 JSON 把配置锁死。 */
function writeJsonAtomic (file, obj, mode = 0o600) {
  ensureDir(path.dirname(file))
  // 临时名带上 pid + 时间戳 + 随机数：同一个进程里两个请求并发保存时
  // 只带 pid 会让两次写共用同一个 tmp 文件，rename 之后内容可能互相踩。
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode })
    fs.renameSync(tmp, file)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch { /* 清理失败就算了，关键是别留半截文件 */ }
    throw err
  }
}

/**
 * 配置文件坏掉时把原文件另存一份（每个进程只做一次）。
 *
 * 为什么必须备份：readConfig 坏 JSON 时回落默认值，之后设置页随便保存一次
 * （POST /config → saveConfig 整体覆盖）就会把用户手改的配置**永久抹掉**。
 * 备份一次就够 —— 配置文件一直坏着的话，每读一次都备份会刷出一堆垃圾文件。
 */
let corruptConfigBackedUp = false
function backupCorruptConfig (why) {
  if (corruptConfigBackedUp) return ''
  corruptConfigBackedUp = true
  try {
    const file = CONFIG_FILE()
    if (!fs.existsSync(file)) return ''
    const bak = `${file}.corrupt-${Date.now()}`
    fs.copyFileSync(file, bak)
    try { fs.chmodSync(bak, 0o600) } catch { /* Windows 上可能不支持，忽略 */ }
    return bak
  } catch {
    return ''
  }
}

/**
 * 读配置。文件不存在/坏了都返回**默认值**（并带上 `_loadError` 说明原因），
 * 绝不抛错 —— 配置读失败不该让插件起不来，那时用户连设置页都打不开，
 * 也就没法修配置了。
 */
export function readConfig () {
  const fallback = defaults()
  let raw
  try {
    raw = fs.readFileSync(CONFIG_FILE(), 'utf8')
  } catch (err) {
    if (err.code !== 'ENOENT') {
      fallback._loadError = `读配置失败：${err.message}`
    }
    return fallback
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    const bak = backupCorruptConfig(err.message)
    fallback._loadError = `配置文件不是合法 JSON（${err.message}）。已用默认值启动，修好后保存即可覆盖。` +
      (bak ? `原文件已备份到 ${bak}（保存新配置不会丢）` : '')
    return fallback
  }
  let merged = deepMerge(defaults(), parsed)
  // advanced.rawJson：给 power user 一个「透传」口子。解析失败要明确报告而不是静默忽略。
  const rawJson = merged.advanced?.rawJson
  if (typeof rawJson === 'string' && rawJson.trim()) {
    try {
      merged = deepMerge(merged, JSON.parse(rawJson))
    } catch (err) {
      merged._loadError = `advanced.rawJson 不是合法 JSON：${err.message}（已忽略该段）`
    }
  }
  return merged
}

/** 保存配置（整体覆盖）。返回写入后的完整配置。 */
export function saveConfig (partial) {
  const before = readConfig()
  delete before._loadError
  const next = deepMerge(before, partial)
  delete next._loadError
  writeJsonAtomic(CONFIG_FILE(), next)
  return next
}

/** 重置为默认值（保留 secrets —— 凭据不该被「恢复默认」清掉）。 */
export function resetConfig () {
  const fresh = defaults()
  writeJsonAtomic(CONFIG_FILE(), fresh)
  return fresh
}

// ── 凭据：单独文件，0600 ─────────────────────────────────────────────────────
//
// 为什么分开存：config.json 是「可以发给别人看/进版本控制」的那部分
// （模型路由、策略、开关），secrets 是「绝对不能外泄」的那部分（QQ 号、token）。
// 混在一起会让「分享配置求助」变成泄密事故。

export function readSecrets () {
  try {
    return JSON.parse(fs.readFileSync(SECRETS_FILE(), 'utf8'))
  } catch {
    return {}
  }
}

export function writeSecrets (patch) {
  const next = { ...readSecrets(), ...patch }
  // 空字符串视为「删掉这个凭据」，不是「设成空」
  for (const [k, v] of Object.entries(next)) {
    if (v === '' || v === null || v === undefined) delete next[k]
  }
  writeJsonAtomic(SECRETS_FILE(), next, 0o600)
  return next
}

/** 取凭据：secret 文件优先，其次环境变量，最后空串。 */
export function getSecret (key, envName) {
  const s = readSecrets()
  if (s[key]) return s[key]
  if (envName && process.env[envName]) return process.env[envName]
  return ''
}

/** 生成随机 token（不需要 openssl，node crypto 就够）。 */
export function randomToken (bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex')
}

import crypto from 'node:crypto'

// ── 运行时状态（桥的当前状态，不是配置） ─────────────────────────────────────
export function readState () {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8'))
  } catch {
    return {}
  }
}

export function writeState (patch) {
  const next = { ...readState(), ...patch, updatedAt: Date.now() }
  writeJsonAtomic(STATE_FILE(), next)
  return next
}
