#!/usr/bin/env node
/**
 * 按「设置页里选的参考音色」启动 GPT-SoVITS 语音服务。
 *
 * 为什么需要这个脚本（2026-11-02 实测踩坑）：
 *   GSV 的 api.py 里 handle() 的判断是 —— 请求体里的
 *   refer_wav_path / prompt_text / prompt_language **任意一项为空**，
 *   就把这三项**整组回退**到启动参数 `-dr/-dt/-dl`。
 *
 *   桥在 settings 没填 promptText 时会传 `prompt_text: null` →
 *   整组回退 → 实际用的是 api.py 启动参数里写死的 `reference/ref.wav`。
 *   于是设置页里选好的参考音频彻底不生效，QQ 里出来的还是默认音色。
 *   （把 ref.wav 换成目标音频能"碰巧"修好，但那是绕开启动参数，换个设置页就又不灵了。）
 *
 * 这个脚本做的四件事：
 *   1. 读 <dataDir>/bridge-config.json 的 tts.gsv（referWav / promptText / 语言 / url）
 *   2. 把 referWav 同步成 gsv 的 reference/ref.wav（原文件先备份，只备份一次）
 *      —— 兜底：即使有别的调用方不带 refer_wav_path，也不会退回旧默认音色
 *   3. 用**与设置页一致**的 -dr/-dt/-dl 启动 api.py（detached + 日志 + pid 文件）
 *   4. 等端口起来并做一次试合成；服务已在跑时默认不重复启动
 *
 * 用法：
 *   node scripts/start-gsv.mjs                 # 用生产配置启动
 *   node scripts/start-gsv.mjs --dry-run       # 只打印将要执行的命令
 *   node scripts/start-gsv.mjs --stop          # 停掉 pid 文件里记录的服务
 *   node scripts/start-gsv.mjs --force         # 端口被占用也重启
 *   node scripts/start-gsv.mjs --no-sync-ref   # 不同步 reference/ref.wav
 *   node scripts/start-gsv.mjs --no-check      # 跳过试合成
 *
 * 环境变量（一般不用改）：
 *   LLMINQQ_DATA_DIR   插件数据目录（默认 ~/.dsh/dsh-plugin-llminqq）
 *   GSV_HOME           GPT-SoVITS 安装目录（默认 /home/jojo/app/gpt-sovits）
 *   GSV_PYTHON         解释器（默认 $GSV_HOME/.venv/bin/python）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'

const argv = process.argv.slice(2)
const has = f => argv.includes(f)
const val = f => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null }

const DATA_DIR = val('--data-dir') || process.env.LLMINQQ_DATA_DIR ||
  path.join(os.homedir(), '.dsh', 'dsh-plugin-llminqq')
const GSV_HOME = val('--gsv-home') || process.env.GSV_HOME || '/home/jojo/app/gpt-sovits'
const PYTHON = val('--python') || process.env.GSV_PYTHON || path.join(GSV_HOME, '.venv/bin/python')

// GPT-SoVITS v2final 的预训练模型（跟 api.py 默认一致，可用 --sovits/--gpt 覆盖）
const SOVITS = val('--sovits') || 'GPT_SoVITS/pretrained_models/gsv-v2final-pretrained/s2G2333k.pth'
const GPT = val('--gpt') || 'GPT_SoVITS/pretrained_models/gsv-v2final-pretrained/s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt'

const PID_FILE = path.join(DATA_DIR, 'gsv-api.pid')
const LOG_FILE = path.join(DATA_DIR, 'gsv-api.log')

function die (msg) { console.error(`✗ ${msg}`); process.exit(1) }
function log (msg) { console.log(msg) }

function readBridgeConfig () {
  const file = path.join(DATA_DIR, 'bridge-config.json')
  if (!fs.existsSync(file)) die(`找不到 bridge-config.json：${file}`)
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function portOf (url) {
  try { return Number(new URL(url || 'http://127.0.0.1:9880/').port) || 9880 } catch { return 9880 }
}

async function portOpen (port, timeoutMs = 1500) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(timeoutMs) })
    return res.status > 0
  } catch { return false }
}

/** 等端口就绪（GSV 在 CPU 上冷启动可能要 1-3 分钟） */
async function waitPort (port, timeoutMs = 240000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await portOpen(port)) return true
    await new Promise(r => setTimeout(r, 2000))
  }
  return false
}

function runningPid () {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim())
    if (!pid) return null
    process.kill(pid, 0)   // 只是探活，不真的发信号
    return pid
  } catch { return null }
}

async function stop () {
  const pid = runningPid()
  if (!pid) { log('没有在跑的记录（pid 文件不存在或进程已退出）'); return }
  try { process.kill(pid, 'SIGTERM') } catch { /* 已经没了 */ }
  for (let i = 0; i < 20; i++) {
    try { process.kill(pid, 0); await new Promise(r => setTimeout(r, 500)) } catch { break }
  }
  try { fs.unlinkSync(PID_FILE) } catch { /* ignore */ }
  log(`已停止 GSV（pid ${pid}）`)
}

async function main () {
  if (has('--stop')) return stop()

  const cfg = readBridgeConfig()
  const g = cfg.tts?.gsv ?? {}
  const port = portOf(g.url)
  const referWav = g.referWav ? path.resolve(g.referWav) : null
  const promptText = g.promptText || ''
  const promptLang = g.promptLanguage || 'zh'

  if (!referWav) die('配置里 tts.gsv.referWav 为空 —— 先在设置页选参考音频')
  if (!fs.existsSync(referWav)) die(`参考音频不存在：${referWav}`)
  if (!promptText) {
    log('⚠️ 配置里 tts.gsv.promptText 为空。GSV 会把 refer_wav_path 也一起回退到启动参数，')
    log('   等于设置页选的音色不生效。建议在设置页把参考文本填上（就是那段音频里说的原话）。')
  }

  // ── 2. 同步 reference/ref.wav（兜底，防止别的调用方走默认路径）──
  const gsvRef = path.join(GSV_HOME, 'reference/ref.wav')
  const byMd5 = f => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex')
  if (!has('--no-sync-ref') && fs.existsSync(gsvRef)) {
    if (byMd5(gsvRef) !== byMd5(referWav)) {
      const bak = `${gsvRef}.bak`
      if (!fs.existsSync(bak)) {
        fs.copyFileSync(gsvRef, bak)
        log(`已备份 GSV 原参考音频 → ${bak}`)
      }
      fs.copyFileSync(referWav, gsvRef)
      log(`已把设置页参考音频同步到 ${gsvRef}`)
    } else {
      log('reference/ref.wav 已与设置页参考音频一致，跳过同步')
    }
  }

  // ── 3. 起服务 ──
  if (await portOpen(port)) {
    if (!has('--force')) {
      log(`GSV 已在 ${port} 端口运行（pid 记录：${runningPid() ?? '未知'}）。加 --force 可重启。`)
      return
    }
    await stop()
    await new Promise(r => setTimeout(r, 1500))
  }

  const args = [
    'api.py',
    '-s', SOVITS, '-g', GPT,
    '-dr', path.join('reference', path.basename(referWav)),   // 与设置页一致
    ...(promptText ? ['-dt', promptText] : []),
    '-dl', promptLang,
    '-d', process.env.GSV_DEVICE || 'cpu',
    '-a', '0.0.0.0',
    '-p', String(port),
  ]

  if (has('--dry-run')) {
    log(`[dry-run] cd ${GSV_HOME} && ${PYTHON} ${args.join(' ')}`)
    return
  }

  fs.mkdirSync(DATA_DIR, { recursive: true })
  const out = fs.openSync(LOG_FILE, 'a')
  const child = spawn(PYTHON, args, {
    cwd: GSV_HOME,
    detached: true,
    stdio: ['ignore', out, out],
  })
  child.unref()
  fs.writeFileSync(PID_FILE, String(child.pid))
  log(`GSV 启动中 pid=${child.pid}，日志：${LOG_FILE}`)
  log(`参考音频：${referWav}`)
  log(`参考文本：${promptText || '(空 —— 会回退到启动参数)'}`)

  const ok = await waitPort(port, Number(process.env.GSV_START_TIMEOUT_MS || 240000))
  if (!ok) die(`GSV 在 4 分钟内没有监听 ${port}，看日志：${LOG_FILE}`)
  log(`✓ 端口 ${port} 已就绪`)

  // ── 4. 试合成（确认音色链路真的通）──
  if (!has('--no-check') && promptText) {
    try {
      const t0 = Date.now()
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: '声音测试好了',
          text_language: 'zh',
          refer_wav_path: referWav,
          prompt_text: promptText,
          prompt_language: promptLang,
        }),
        signal: AbortSignal.timeout(180000),
      })
      const buf = Buffer.from(await res.arrayBuffer())
      if (!res.ok || buf.length < 200) throw new Error(`HTTP ${res.status}，${buf.length}B`)
      log(`✓ 试合成通过（${buf.length}B，${((Date.now() - t0) / 1000).toFixed(1)}s）`)
    } catch (err) {
      die(`试合成失败：${err.message}（服务已起，但语音链路有问题，看 ${LOG_FILE}）`)
    }
  }
}

main().catch(err => die(err.stack || err.message))
