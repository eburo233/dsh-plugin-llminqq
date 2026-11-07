#!/usr/bin/env node
// scripts/napcat-qr.mjs —— 取一张**新的** NapCat 登录二维码，落到指定路径
// ============================================================================
// 场景（2026-11-07）：QQ 账号被腾讯踢下线（bridge.log 里 `code=1006`，
// NapCat 日志是 `[KickedOffLine] 你的账号当前登录已失效`）。此时桥会一直
// 重连失败、机器人静默离线，**只能人拿手机重新扫码**。
//
// 以前这件事只有两条路：开浏览器进 NapCat WebUI（要 token、要 GUI），
// 或者 `docker logs` 里找码。这个脚本把第三件事做顺手：
//   调 NapCat 自己的 `/api/QQLogin/RefreshQRcode` 换一张新码 → 读到 PNG →
//   写到指定路径，然后你（或 agent）把图片推给人扫。
//
// 为什么不是「读现有的 qrcode.png」：QQ 登录码约 2 分钟就过期，
// 读到的那张很可能已经死了；必须**主动刷新**一次。
//
// 用法：
//   node scripts/napcat-qr.mjs                      # 刷新并写到 <cwd>/napcat-qr.png
//   node scripts/napcat-qr.mjs --out /tmp/qr.png    # 指定输出
//   node scripts/napcat-qr.mjs --no-refresh         # 不强制换码，只读当前那张
//   node scripts/napcat-qr.mjs --json               # 机器可读
//
// ⚠️ `--data-dir` 只影响**读哪份 config.json**。真正的数据目录来自
//   lib/store.js 的 dataDir()（它优先从安装路径反推，兜底才看 DSH_HOME），
//   所以「把整套路径指到别处」要设 `DSH_HOME=<假的 dsh home>`。
//   第一版测试就栽在这：以为 --data-dir 隔离了，结果读到了本机真实二维码。
//
// 退出码：0 拿到码 / 2 拿不到（含原因）/ 1 其它错误
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const REPO = path.resolve(HERE, '..')
const argv = process.argv.slice(2)
const argOf = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : '' }
const has = n => argv.includes(n)

function die (code, msg) {
  process.stderr.write(`napcat-qr: ${msg}\n`)
  process.exit(code)
}

/** 插件数据目录（和别的脚本同一套推导）。 */
function dataDir () {
  const explicit = argOf('--data-dir') || process.env.LLMINQQ_DATA_DIR || ''
  if (explicit) return path.resolve(explicit.replace(/^~/, os.homedir()))
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(dshHome, 'dsh-plugin-llminqq')
}

const DATA = dataDir()
let cfg = {}
try {
  cfg = JSON.parse(fs.readFileSync(path.join(DATA, 'config.json'), 'utf8'))
} catch (err) {
  die(2, `读不到插件配置 ${path.join(DATA, 'config.json')}：${err.message}`)
}

const { fetchQrCode } = await import(path.join(REPO, 'lib', 'napcat.js'))

const force = !has('--no-refresh')
const r = await fetchQrCode(cfg, { force })

if (!r?.ok || !r.png) {
  const detail = [r?.reason, r?.detail].filter(Boolean).join(' · ')
  if (has('--json')) process.stdout.write(JSON.stringify({ ok: false, reason: r?.reason || '', detail: r?.detail || '' }) + '\n')
  die(2, `拿不到二维码：${detail || r?.reason || '未知原因'}`)
}

const out = path.resolve(argOf('--out') || path.join(process.cwd(), 'napcat-qr.png'))
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, r.png, { mode: 0o600 })

if (has('--json')) {
  process.stdout.write(JSON.stringify({
    ok: true, out, bytes: r.png.length, source: r.source || null,
    changed: r.changed ?? null, refreshError: r.refreshError || null,
  }) + '\n')
} else {
  process.stdout.write(`napcat-qr: 已写入 ${out}（${r.png.length} 字节${r.changed === false ? '，注意：这次其实没换新码' : ''}）\n`)
  process.stdout.write('提示：QQ 登录码约 2 分钟过期，扫之前别等太久。\n')
}
process.exit(0)
