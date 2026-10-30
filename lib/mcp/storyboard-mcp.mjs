#!/usr/bin/env node
// storyboard MCP server — 把 vendored 的 dsh-video-storyboard CLI 以 MCP stdio 工具
// 暴露给 QQ 桥（bridge/acp.js 通过 ACP session/new 的 mcpServers 挂载，协议正式支持）。
//
//   工具（故意只有两个，别贪多）：
//     video_probe      —— ffprobe 级别的元信息（时长/分辨率/帧率/有无音轨），零图片零 token
//     video_storyboard —— 跑完整管线，产出宫格图 + manifest 摘要
//
//   ⚠️ 返回的是**本地文件路径**，不是图片内容：
//     桥（bridge/index.js）只收集 agent 的文本输出，图片要走 [SEND_FILE: 路径] 机制，
//     而 [SEND_FILE] 只放行 staging（<repo>/.qq-media）与 config.dsh.cwd 两个根
//     （isPathAllowedForSend，bridge/index.js:101-119）。所以宫格图固定落在
//     STORYBOARD_DIR（默认 <repo>/.qq-media/storyboard/，staging 根之内），模型拿到路径
//     后输出 [SEND_FILE: <路径>] 即可发出去。prune 由桥对 staging 根统一负责。
//
//   依赖：vendored CLI（../vendor/dsh-video-storyboard/bin/storyboard.mjs）+ PATH 上的
//   ffmpeg/ffprobe。不 npm install 任何东西（vendor 目录一行不改，适配全在这里）。
//
// 配置（bridge/config.json mcpServers 里这样挂，与 bilibili 条目同形态）：
//   {"name":"storyboard","command":"node",
//    "args":["/home/<user>/dsh/LLMinQQ/scripts/storyboard-mcp.mjs"],
//    "env":{"HOME":"/home/<user>","PATH":"/usr/local/bin:/usr/bin:/bin"}}

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── 插件包内的路径关系（与脚本版不同，别照抄）────────────────────────────────
// 脚本版：  <repo>/scripts/storyboard-mcp.mjs  →  ROOT = <repo>，vendor 在 <repo>/vendor/
// 插件版：  <pkg>/lib/mcp/storyboard-mcp.mjs   →  PKG_ROOT = <pkg>，vendor 在 <pkg>/vendor/
//   __dirname = <pkg>/lib/mcp
//   '..'      = <pkg>/lib
//   '../..'   = <pkg>          ← vendor 在这里
const PKG_ROOT = path.resolve(__dirname, '..', '..')
const VENDOR_DIR = path.join(PKG_ROOT, 'vendor', 'dsh-video-storyboard')
const STORYBOARD_CLI = path.join(VENDOR_DIR, 'bin', 'storyboard.mjs')

// 产物目录：默认 staging 根的 storyboard/ 子目录。
// 为什么不用 /tmp：桥的 [SEND_FILE] 白名单只认 staging 根和 dsh.cwd（见文件头注释），
// 图落 /tmp 模型拿得到路径也发不出去。
// 为什么可用 STORYBOARD_DIR 覆盖：CONTRIBUTING §9 —— 测试必须能把落盘路径引开。
// 🔴 产物目录：**必须在桥的 [SEND_FILE] 允许根之内**，否则模型拿到路径也发不出去。
// 桥的 isPathAllowedForSend（lib/bridge/index.js:107-119）允许根是：
//     STAGING_DIR = config.media.stagingDir
//     config.dsh.cwd
// 插件版里 bridgeConfig() 生成的 staging 是 `<dataDir>/.qq-media`，
// 所以产物落 `stagingDir/storyboard/` 就**天然在允许根内**，不需要改桥的守卫。
//
// 怎么知道 staging 在哪？宿主通过 **STORYBOARD_DIR** 环境变量传进来
// （见 lib/index.js buildMcpServers()）——这是唯一可靠的来源：
// wrapper 自己不猜 dataDir（猜错了产物就落在允许根外，模型发不出去且很难查）。
// 单跑 wrapper（无宿主 env）时才退回「包旁的 .qq-media」，仅供手工调试。
const STORYBOARD_DIR = process.env.STORYBOARD_DIR
  ? path.resolve(process.env.STORYBOARD_DIR)
  : path.join(PKG_ROOT, '.qq-media', 'storyboard')

// 长视频（60 分钟级）也要留足余量；ffmpeg 扫描是 CPU 密集但单调用不会跑飞。
const CALL_TIMEOUT_MS = Number(process.env.STORYBOARD_TIMEOUT_MS) || 180_000
// 单格最大秒数：超出会自动加 sheets 分窗（CLI 的 --plan 行为），避免 60 格糊成一张图。
const DEFAULT_PLAN_SECONDS = 300

// ── 小工具 ──────────────────────────────────────────────────────────────────

function fmtDuration (s) {
  if (!(s > 0)) return '0s'
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s - h * 3600 - m * 60
  const ss = sec >= 10 || h > 0 || m > 0 ? sec.toFixed(1) + 's' : sec.toFixed(2) + 's'
  return h > 0 ? `${h}h${m}m${ss}` : m > 0 ? `${m}m${ss}` : ss
}

/** spawn 一个进程，收集 stdout/stderr，带超时（到点 SIGKILL，防止 ffmpeg 僵尸）。 */
function runProcess (cmd, args, { timeoutMs = CALL_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: process.env })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGKILL') } catch { /* ignore */ }
    }, timeoutMs)
    child.stdout.on('data', c => { stdout += c })
    child.stderr.on('data', c => { stderr += c })
    child.on('error', err => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: stderr + '\n' + err.message, timedOut })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr, timedOut })
    })
  })
}

/** 输入校验：返回错误文案，或 null。必须是本机已有文件——本工具不做网络下载。 */
function validateInput (input) {
  if (typeof input !== 'string' || input.trim() === '') return '缺少参数 input（本地视频绝对路径）'
  const abs = path.resolve(input.trim())
  let st
  try { st = fs.statSync(abs) } catch { return `文件不存在：${abs}` }
  if (!st.isFile()) return `不是常规文件：${abs}`
  if (st.size === 0) return `文件是空的：${abs}`
  return null
}

/**
 * 清理单次调用的产物。成功时**不删**（模型还要拿去 [SEND_FILE]；过期由桥的 staging
 * prune 统一回收）。失败/超时时删掉半成品——落一张坏图在 staging 里会误导模型去发它。
 */
function cleanupOutputs (files) {
  for (const f of files) {
    try { fs.unlinkSync(f) } catch { /* ignore */ }
  }
}

// ── video_probe：零图片、零 token 的元信息 ───────────────────────────────────

async function toolVideoProbe (args) {
  const err = validateInput(args.input)
  if (err) return { isError: true, text: `video_probe 失败：${err}` }

  // 直接用 vendored 包里的 probeVideo（与 CLI 同一份实现，零改动只 import），
  // 省一次 spawn，也天然带上竖拍转正/帧率消歧这些上游处理过的坑。
  const { probeVideo } = await import(
    pathToFileURL(path.join(VENDOR_DIR, 'src', 'probe.js')).href
  )
  let info
  try {
    info = await probeVideo(path.resolve(args.input.trim()))
  } catch (e) {
    return { isError: true, text: `video_probe 失败：ffprobe 读不了这个文件 —— ${e.message}` }
  }
  const lines = [
    `文件 ${path.resolve(args.input.trim())}`,
    `时长 ${fmtDuration(info.duration)} (${Number(info.duration).toFixed(2)}s)`,
    `分辨率 ${info.width}x${info.height}${info.rotation ? `（旋转 ${info.rotation}° 已转正）` : ''}`,
    `帧率 ${info.fps ? info.fps.toFixed(2) : '?'} fps  编码 ${info.videoCodec}/${info.container}`,
    `音轨 ${info.hasAudio ? `有（${info.audioCodec ?? '?'}）` : '无'}`,
    `建议：>10 分钟的长视频建议用 from/to 先看片段；调 video_storyboard 即可拿宫格图`,
  ]
  return { text: lines.join('\n') }
}

// ── video_storyboard：宫格图 + manifest 摘要 ────────────────────────────────

async function toolVideoStoryboard (args) {
  const err = validateInput(args.input)
  if (err) return { isError: true, text: `video_storyboard 失败：${err}` }

  const input = path.resolve(args.input.trim())
  fs.mkdirSync(STORYBOARD_DIR, { recursive: true })

  // 命名带 pid+随机后缀：并发调用（同peer多轮/不同peer）不会互相覆盖。
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const base = `sb_${stamp}_${process.pid}_${Math.random().toString(36).slice(2, 6)}`
  const outPng = path.join(STORYBOARD_DIR, `${base}.png`)
  const outJson = path.join(STORYBOARD_DIR, `${base}.json`)

  const cliArgs = [
    STORYBOARD_CLI, input,
    '--out', outPng, '--manifest', outJson,
  ]
  const cells = Number(args.cells) || 0
  if (cells > 0) cliArgs.push('--cells', String(Math.min(cells, 36)))
  // transcript 只透传合法值；默认 auto（本机无 ASR key 时上游自己降级 asr-empty，不外传音频）
  if (args.transcript === 'off' || args.transcript === 'auto') cliArgs.push('--transcript', args.transcript)
  const from = Number(args.from)
  const to = Number(args.to)
  if (from > 0) cliArgs.push('--from', String(from))
  if (to > from) cliArgs.push('--to', String(to))

  const res = await runProcess(process.execPath, cliArgs)
  if (res.timedOut) {
    cleanupOutputs([outPng, outJson])
    return {
      isError: true,
      text: `video_storyboard 超时（>${Math.round(CALL_TIMEOUT_MS / 1000)}s，已终止）。视频可能太长/太大，建议用 from/to 先看一个 5 分钟内的片段，或用 video_probe 确认时长。`,
    }
  }
  if (res.code !== 0 || !fs.existsSync(outPng)) {
    cleanupOutputs([outPng, outJson])
    const detail = (res.stderr || res.stdout || '').trim().split('\n').filter(Boolean).slice(-4).join(' | ')
    return { isError: true, text: `video_storyboard 失败（exit ${res.code}）：${detail || '未知错误（无 stderr）'}` }
  }

  let manifest = null
  try { manifest = JSON.parse(fs.readFileSync(outJson, 'utf8')) } catch { /* 摘要降级 */ }

  const pngSize = fs.statSync(outPng).size
  // 上游 saveStoryboards 默认还会写一个 `<名字>.evidence.json`（逐格帧时刻存证），
  // 且 CLI 没暴露关它的开关。cells 里已有 t_frame，这份 sidecar 对我们纯属冗余；
  // staging 有 300 文件总量上限（config.media.prune），一次调用占 3 个额度太浪费。
  // vendor 一行不改（约束），在这里清。
  cleanupOutputs([outPng.replace(/\.png$/, '.evidence.json')])
  const sheet = manifest?.sheets?.[0]
  const lines = []
  if (manifest) {
    const w = manifest.window ?? {}
    const tr = manifest.transcript ?? {}
    const au = manifest.audio
    lines.push(`storyboard 完成：${path.basename(outPng)}（${(pngSize / 1024).toFixed(0)}KB）`)
    lines.push(`宫格图路径（可直接 [SEND_FILE]）：${outPng}`)
    lines.push(`片段 ${fmtDuration(w.from ?? 0)} → ${fmtDuration(w.to ?? w.duration ?? 0)}（共 ${fmtDuration(w.duration ?? 0)}）`)
    lines.push(`布局 ${sheet ? `${sheet.cols}x${sheet.rows} 共 ${sheet.cells?.length ?? '?'} 格，每格 ${fmtDuration((sheet.cells?.[0]?.t_end ?? 0) - (sheet.cells?.[0]?.t_start ?? 0))}` : '未知'}`)
    if (sheet?.cells?.length) {
      lines.push('时间轴：' + sheet.cells.map(c => `#${c.i} ${Number(c.t_start).toFixed(0)}s-${Number(c.t_end).toFixed(0)}s`).join('  '))
    }
    if (au) lines.push(`音频：${au.mean != null ? `mean ${Number(au.mean).toFixed(1)} LUFS` : 'n/a'}${au.silences?.length ? `，${au.silences.length} 段静音` : ''}`)
    lines.push(`转写：${tr.source ?? 'n/a'}${tr.chars ? `（${tr.chars} 字）` : tr.source === 'asr-empty' ? '（本机无 ASR key，已降级，音频未外传）' : ''}`)
    lines.push(`manifest：${outJson}`)
  } else {
    // manifest 读不出来（理论上 CLI 失败才发生）：降级成裸路径 + CLI 尾部日志
    lines.push(`storyboard 完成：${outPng}（${(pngSize / 1024).toFixed(0)}KB），manifest 解析失败`)
    lines.push((res.stderr || '').trim().split('\n').slice(-3).join(' | '))
  }
  return { text: lines.join('\n') }
}

// ── MCP stdio 骨架（jsonrpc 2.0，一行一帧）──────────────────────────────────
// 手写协议面（不引 @modelcontextprotocol/sdk）：工具只有两个、方法只有五个，
// 引 SDK 反而给这个零依赖项目加 node_modules。与 bilibili MCP 的行为面保持一致。

const PROTOCOL_VERSION = '2024-11-05'
const SERVER_INFO = { name: 'storyboard', version: '0.1.0' }

const TOOLS = [
  {
    name: 'video_probe',
    description:
      '读取本地视频的元信息（时长/分辨率/帧率/有无音轨），纯文本、不产图、几乎零耗时。' +
      '决定要不要看内容之前先用它确认「这视频多长、值不值得看」。',
    inputSchema: {
      type: 'object',
      properties: {
        input: { type: 'string', description: '本地视频文件的绝对路径' },
      },
      required: ['input'],
    },
  },
  {
    name: 'video_storyboard',
    description:
      '给本地视频生成一张带编号格+时间戳条的宫格图（scene-aware storyboard），' +
      '返回宫格图的本地绝对路径（可用 [SEND_FILE] 直接发给 QQ 用户）+ 时间轴/音频/转写摘要。' +
      '长视频建议用 from/to 限定片段（默认最多看前 ' + DEFAULT_PLAN_SECONDS + ' 秒/张的量，超出会自动分窗）。',
    inputSchema: {
      type: 'object',
      properties: {
        input: { type: 'string', description: '本地视频文件的绝对路径' },
        cells: { type: 'number', description: '宫格数（默认自动，1-36）' },
        from: { type: 'number', description: '起始秒（默认 0）' },
        to: { type: 'number', description: '结束秒（默认到片尾）' },
        transcript: { type: 'string', enum: ['auto', 'off'], description: '是否尝试语音转写（默认 auto，无 ASR key 时自动降级）' },
      },
      required: ['input'],
    },
  },
]

function rpcResult (id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}

function rpcError (id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n')
}

async function dispatch (method, params) {
  switch (method) {
    case 'initialize':
      return { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO }
    case 'notifications/initialized':
      return null // 通知，无响应
    case 'tools/list':
      return { tools: TOOLS }
    case 'tools/call': {
      const name = params?.name
      const args = params?.arguments ?? {}
      const r = name === 'video_probe' ? await toolVideoProbe(args)
        : name === 'video_storyboard' ? await toolVideoStoryboard(args)
        : null
      if (r == null) throw Object.assign(new Error(`未知工具：${name}`), { code: -32602 })
      // MCP 规范的 tools/call 结果面：content 数组 + isError 标记。
      // 之前直接返回 {text} 是错的——宿主的 MCP 客户端按 content 读，裸 text 会读成空。
      return {
        content: [{ type: 'text', text: r.text ?? '' }],
        ...(r.isError ? { isError: true } : {}),
      }
    }
    case 'ping':
      return {}
    default:
      throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 })
  }
}

let buf = ''
// 在途调用计数：宿主关掉 stdin 时，等已经在跑的工具调用落地再退
// （否则管道一关 process.exit 会把跑了十几秒的 storyboard 连图带进程一起杀掉）。
let inFlight = 0
let exitTimer = null
function maybeExit () {
  if (inFlight === 0) process.exit(0)
  if (!exitTimer) {
    exitTimer = setTimeout(() => process.exit(0), 15000) // 兜底：最坏再等 15s
  }
}
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buf += chunk
  let idx
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim()
    buf = buf.slice(idx + 1)
    if (!line) continue
    let frame
    try { frame = JSON.parse(line) } catch (e) {
      rpcError(null, -32700, `parse error: ${e.message}`)
      continue
    }
    const { id, method, params } = frame
    if (method == null) continue // 我们不会向宿主发请求，忽略所有响应帧
    inFlight++
    dispatch(method, params).then(
      (result) => {
        if (id != null) rpcResult(id, result ?? {})
        inFlight--
        if (stdinEnded) maybeExit()
      },
      (err) => {
        if (id == null) return
        if (err.code === -32601 || err.code === -32602) rpcError(id, err.code, err.message)
        else rpcError(id, -32603, `internal error: ${err.message}`)
        inFlight--
        if (stdinEnded) maybeExit()
      },
    )
  }
})
let stdinEnded = false
process.stdin.on('end', () => { stdinEnded = true; maybeExit() })
// stderr 只放日志，别污染 stdout（那是协议通道）。bridge/acp.js 会过滤 MCP 的常规日志。
process.stderr.write(`[storyboard-mcp] ready cli=${STORYBOARD_CLI} out=${STORYBOARD_DIR} timeout=${CALL_TIMEOUT_MS}ms\n`)
process.on('SIGTERM', () => process.exit(0))
