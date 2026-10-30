#!/usr/bin/env node
/**
 * dsh-plugin-llminqq 装完之后的三件事自检。
 *
 * 为什么需要这个脚本：这个插件「看起来在跑」和「真的在干活」差得很远 ——
 * 桥进程活着但 OneBot 掉线、桥被杀了没人拉起来、人设页读失败还允许保存，
 * 这三种情况在日志里都只是一行，用户侧只看到「机器人不说话」。
 *
 * 三项检查：
 *   1. 消息回不回        —— 读运行态：桥在不在、OneBot 在不在线、最近一次收发是什么时候
 *   2. 桥挂了会不会自愈   —— 杀一次桥进程，看宿主是否把它拉回来（需 --kill-bridge，默认只读）
 *   3. 人格页故障不许保存 —— 静态契约检查：后端失败必须 ok:false，前端必须禁用保存
 *
 * 用法：
 *   node scripts/verify.mjs                 # 只读体检（不杀进程、不发消息）
 *   node scripts/verify.mjs --kill-bridge   # 多做一次自愈测试（会 SIGTERM 桥子进程）
 *   node scripts/verify.mjs --json          # 机器可读输出（CI / 贴 issue 用）
 *
 * 退出码：0 = 全部通过（或跳过项不计失败）；1 = 有 FAIL；2 = 脚本自身出错。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  dataDir, STATE_FILE, readConfig, getSecret,
} from '../lib/store.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = new Set(process.argv.slice(2))
const asJson = args.has('--json')
const killBridge = args.has('--kill-bridge')

/** @type {{name:string, status:'pass'|'fail'|'skip', detail:string, hint?:string}[]} */
const results = []
const push = (name, status, detail, hint) => results.push({ name, status, detail, hint })

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function readJson (file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

/** 取日志尾部若干字节（日志可能几十 MB，不能整读）。 */
function tailText (file, bytes = 400_000) {
  try {
    const { size } = fs.statSync(file)
    const start = Math.max(0, size - bytes)
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(Math.min(bytes, size - start))
    fs.readSync(fd, buf, 0, buf.length, start)
    fs.closeSync(fd)
    return buf.toString('utf8')
  } catch { return '' }
}

function pidAlive (pid) {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch (err) { return err.code === 'EPERM' }
}

/* ── 1. 运行态：桥 / OneBot / 最近收发 ─────────────────────────────────── */
async function checkRuntime () {
  const state = readJson(STATE_FILE()) ?? {}
  const bridge = state.bridge ?? {}
  const logsDir = path.join(dataDir(), 'logs')

  if (bridge.running && pidAlive(bridge.pid)) {
    push('桥进程', 'pass', `running，pid=${bridge.pid}，启动于 ${new Date(bridge.startedAt || 0).toLocaleString()}`)
  } else if (bridge.gaveUp) {
    push('桥进程', 'fail', `已放弃自动重启：${bridge.error ?? '未知原因'}`,
      '看 logs/bridge.out 的 ERROR 行；修好后在设置页「运行」页手动重启一次')
  } else if (bridge.running) {
    push('桥进程', 'fail', `状态说 running，但 pid=${bridge.pid} 已经不在（状态文件过期）`,
      '在设置页「运行」页点重启；若反复出现，把 logs/ 打包提 issue')
  } else {
    push('桥进程', 'skip', `未运行（${bridge.disabled ? '插件已停用' : bridge.restarting ? '正在重启' : 'enabled=false 或宿主未加载'}）`)
  }

  // OneBot 连接态：问桥的本地 API（只读接口，不改任何东西）
  const cfg = readConfig() ?? {}
  const host = cfg.server?.host || '127.0.0.1'
  const port = cfg.server?.port || 18080
  const token = getSecret('serverToken') || cfg.server?.token || ''
  let health = null
  try {
    const res = await fetch(`http://${host}:${port}/health`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(5000),
    })
    health = await res.json()
  } catch (err) {
    push('桥 API', 'skip', `连不上 http://${host}:${port}（${err.name === 'TimeoutError' ? '超时 5s' : err.code || err.message}）`,
      '桥没起来时这一项跳过是正常的；桥在跑却连不上，检查 server.port/token 是否被改过')
  }

  if (health?.ok) {
    const ob = health.onebot ?? {}
    if (ob.online) push('OneBot', 'pass', `在线，selfId=${ob.selfId ?? '?'}（${ob.nickname ?? '?'}）`)
    else push('OneBot', 'fail', `未连上 NapCat：${ob.url ?? cfg.onebot?.wsUrl ?? '(未配置 wsUrl)'}`,
      'NapCat 没登录 / ws 地址或 token 不对 → 设置页「登录」页扫码，或核对 onebot.wsUrl')
    push('DSH 会话', health.dsh?.ready ? 'pass' : 'fail',
      `profile=${health.dsh?.profile ?? '?'} route=${health.dsh?.currentRoute ?? '?'} ready=${Boolean(health.dsh?.ready)}`,
      health.dsh?.ready ? undefined : '模型路由没就绪 → 设置页「模型」页选一个可用路由，或检查凭据')
  }

  // 最近一次入站 / 出站：直接回答「消息回不回」这个问题。
  // 日志行以 ISO 时间戳开头（`2026-10-29T13:27:01.114Z 入站 ...`），取出时间才能算新鲜度 ——
  // 只看「有过入站」会被一个月前的旧日志骗过去。
  const logText = tailText(path.join(logsDir, 'bridge.log')) + '\n' + tailText(path.join(logsDir, 'bridge.out'))
  const lastIn = [...logText.matchAll(/^(\S+) 入站 (\S+) from=(\S+)/gm)].pop()
  const lastOut = [...logText.matchAll(/^(\S+) 已发送含 \d+ 个真 @ 的消息 -> (\S+)/gm)].pop()
  const lastPlainSend = [...logText.matchAll(/^(\S+) 发送给 (\S+)/gm)].pop()
  const out = lastOut ?? lastPlainSend
  const ageText = (iso) => {
    const t = Date.parse(iso)
    if (!Number.isFinite(t)) return ''
    const min = Math.round((Date.now() - t) / 60000)
    if (min < 1) return '刚刚'
    if (min < 60) return `${min} 分钟前`
    if (min < 60 * 24) return `${Math.round(min / 60)} 小时前`
    return `${Math.round(min / 60 / 24)} 天前`
  }
  const staleHint = (iso) => {
    const t = Date.parse(iso)
    return Number.isFinite(t) && Date.now() - t > 24 * 3600_000
      ? '这条已经超过 24 小时 —— 桥或账号可能之后就没再工作过，别把它当「现在能收」。'
      : undefined
  }
  if (lastIn) {
    push('最近入站', 'pass', `${ageText(lastIn[1])}（${lastIn[1]}）${lastIn[2]} from=${lastIn[3]}`, staleHint(lastIn[1]))
  } else {
    push('最近入站', 'skip', '日志尾部没有「入站」记录 —— 可能刚装好，也可能白名单/静默期把消息全挡了',
      '发一条 @ 机器人的消息再看：日志里应有「入站 ...」；没有就检查 allowUsers/allowGroups、readAllGroupMessages')
  }
  if (out) push('最近出站', 'pass', `${ageText(out[1])}（${out[1]}）-> ${out[2]}`, staleHint(out[1]))
  else push('最近出站', 'skip', '日志尾部没有发送记录',
    '有「入站」但没有发送 → 看同一条消息后面是否跟着「冷却中」「flurry」「[SILENT]」或被 maxReplyChars 截空')
}

/* ── 2. 自愈：杀掉桥，宿主应该按退避把它拉回来 ────────────────────────── */
async function checkSelfHeal () {
  const state = readJson(STATE_FILE()) ?? {}
  const bridge = state.bridge ?? {}
  if (!killBridge) {
    push('桥自愈', 'skip', '默认不动你的进程；要真测一次加 --kill-bridge（会 SIGTERM 桥子进程）')
    return
  }
  if (!bridge.running || !pidAlive(bridge.pid)) {
    push('桥自愈', 'skip', '桥当前没在跑，无从杀起')
    return
  }
  const oldPid = bridge.pid
  try {
    process.kill(oldPid, 'SIGTERM')
  } catch (err) {
    push('桥自愈', 'fail', `杀不掉 pid=${oldPid}：${err.message}`)
    return
  }
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    await sleep(1000)
    const cur = readJson(STATE_FILE()) ?? {}
    const b = cur.bridge ?? {}
    if (b.gaveUp) {
      push('桥自愈', 'fail', `宿主放弃了自动重启：${b.error ?? '未知原因'}`,
        '检查 lib/index.js 的 BRIDGE_RESTART_MAX=5 —— 连崩 5 次会停手；先按 logs/bridge.out 的报错修根因')
      return
    }
    if (b.running && b.pid && b.pid !== oldPid && pidAlive(b.pid)) {
      push('桥自愈', 'pass', `杀掉 ${oldPid} 后 ${Math.round((Date.now() - deadline + 30_000) / 1000)}s 内自动拉起新 pid=${b.pid}`)
      return
    }
  }
  push('桥自愈', 'fail', `杀掉 ${oldPid} 后 30s 内没等到新 pid`,
    '看 logs/bridge.out 是否有「桥自动重启」；宿主进程被 SIGKILL 过的话 watchdog 也随之消失，需要重启 DSH')
}

/* ── 3. 人格页故障时不许保存（静态契约） ────────────────────────────────── */
function checkPersonaContract () {
  const serverSrc = fs.readFileSync(path.join(ROOT, 'lib', 'index.js'), 'utf8')
  const clientSrc = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8')

  const backendOkFalse = /读取人设失败/.test(serverSrc) &&
    /ok:\s*false/.test(serverSrc.slice(serverSrc.indexOf('读取人设失败') - 200, serverSrc.indexOf('读取人设失败') + 200))
  const frontendGuarded = /loadError/.test(clientSrc) &&
    /disabled:\s*!!loadError/.test(clientSrc) &&
    /disabled:\s*!dirty\s*\|\|\s*!!loadError/.test(clientSrc)

  if (backendOkFalse && frontendGuarded) {
    push('人格页故障保护', 'pass', '后端读失败返回 ok:false；前端编辑/保存/放弃三处按钮在 loadError 时禁用')
  } else {
    push('人格页故障保护', 'fail',
      `后端 ok:false=${backendOkFalse}，前端禁用=${frontendGuarded}`,
      '这是数据丢失级别的回归：读失败还允许保存会把原人格覆盖成空。改 client.js PersonaTab 与 lib/index.js 的 GET /persona')
  }
}

/* ── 输出 ─────────────────────────────────────────────────────────────── */
function render () {
  const icon = { pass: '✔', fail: '✘', skip: '·' }
  const lines = []
  for (const r of results) {
    lines.push(`${icon[r.status]} ${r.name}：${r.detail}`)
    if (r.hint) lines.push(`    → ${r.hint}`)
  }
  const fail = results.filter(r => r.status === 'fail').length
  lines.push('')
  lines.push(fail ? `有 ${fail} 项 FAIL —— 上面的 → 就是下一步。` : '没有 FAIL（skip 是没条件测，不算问题）。')
  lines.push(`数据目录：${dataDir()}`)
  return lines.join('\n')
}

async function main () {
  checkPersonaContract()
  await checkRuntime()
  await checkSelfHeal()
  const fail = results.filter(r => r.status === 'fail').length
  if (asJson) {
    process.stdout.write(JSON.stringify({ ok: fail === 0, results, dataDir: dataDir() }, null, 2) + '\n')
  } else {
    process.stdout.write(render() + '\n')
  }
  process.exit(fail ? 1 : 0)
}

main().catch(err => {
  console.error('[verify] 脚本自身出错：', err)
  process.exit(2)
})
