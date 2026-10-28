// 官方 QQ Bot 通道入口：把官方网关事件喂给现有桥的业务逻辑。
//
// 定位（2026-10-28 用户拍板）：**bot 只是多条路之一，先验证学习效果。**
// 所以这里做成**最小可用的私聊通路**，不做群旁听/主动搭话/按人记忆。
//
// 设计上的三个关键选择：
//   ① **不改 bridge/index.js**。NapCat 主线一行不动，随时可回滚；
//      官方通道作为**独立进程**跑，桥的核心逻辑通过 IMPORT 复用（不是复制）。
//   ② **peerKey 带 official: 前缀**。NapCat 是 `c2c:<QQ号>`，官方是
//      `official:c2c:<openid>` —— 两套身份体系永远不串。
//   ③ **凭据只在运行时读**。从 `~/.dsh/dsh-bridge/config.json` 读 appId/appSecret，
//      绝不写进本文件、绝不提交。CONFIG 路径可用环境变量覆盖（测试要能引开）。
//
// 用法：
//   node bridge/official-bot.js                    # 用默认凭据跑
//   OFFICIAL_BOT_CONFIG=/tmp/x.json node ...       # 指定凭据文件（测试用）
//   OFFICIAL_BOT_DRY_RUN=1 node ...                # 只连不回复（验证连通性）

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  toInboundEvent, officialPeerKey, toReplyTarget, contentToSegments,
  OFFICIAL_BOT_LIMITS,
} from './official-adapter.js'

// ── 官方网关常量（来自 @tencent-connect/qqbot-nodejs 的 protocol/gateway）────────
// GROUP_AND_C2C (1<<25) 同时覆盖 GROUP_AT_MESSAGE_CREATE / GROUP_MESSAGE_CREATE /
// C2C_MESSAGE_CREATE，也就是说开这一个就够收三种消息（能不能真收到群全量，
// 还取决于群主是否授权「接收全量消息」，见 OFFICIAL_BOT_LIMITS）。
const INTENT_GROUP_AND_C2C = 1 << 25
const INTENT_INTERACTION = 1 << 26
const DEFAULT_INTENTS = INTENT_GROUP_AND_C2C | INTENT_INTERACTION

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
const API_BASE = 'https://api.sgroup.qq.com'
const GATEWAY_URL = 'wss://api.sgroup.qq.com/websocket'

/** 默认凭据路径：dsh-bridge 的配置（官方 bot 账号就存在这儿）。 */
export function defaultCredentialPath () {
  return process.env.OFFICIAL_BOT_CONFIG ??
    path.join(process.env.HOME ?? os.homedir(), '.dsh', 'dsh-bridge', 'config.json')
}

/**
 * 读官方 bot 凭据。**只读不写**，且返回值不打印 secret。
 *
 * 为什么从 dsh-bridge 的配置读、而不是自己维护一份：
 *   那边已经有两个官方账号在跑（第一个dsbot / 3022），扫码绑定的结果都存这儿。
 *   再存一份就会出现「两份凭据不一致」的事故 —— 实测已经踩到过：
 *   profile 的 cordis.patch.yml 里那份 appSecret 是**过期的**（换 token 报
 *   invalid appid or secret），只有这份是有效的。所以以这份为准，别自己抄。
 */
export function loadCredentials (cfgPath = defaultCredentialPath()) {
  const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
  const accounts = raw?.qq?.accounts ?? []
  const target = process.env.OFFICIAL_BOT_ACCOUNT ?? accounts[0]?.name
  const acc = accounts.find(a => a.name === target) ?? accounts[0]
  if (!acc?.appId || !acc?.appSecret) {
    throw new Error(`凭据不完整：${cfgPath} 里没有可用的 appId/appSecret`)
  }
  return {
    appId: String(acc.appId),
    appSecret: String(acc.appSecret),   // 绝不 log
    name: String(acc.name ?? ''),
    accountId: String(acc.accountId ?? ''),
    allowFrom: Array.isArray(acc.allowFrom) ? acc.allowFrom.map(String) : [],
  }
}

/** 换 access_token（官方 oauth 方式；Token 鉴权已废弃）。 */
export async function fetchAccessToken ({ appId, appSecret }, fetchImpl = fetch) {
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ appId, clientSecret: appSecret }),
  })
  const json = await res.json().catch(() => ({}))
  if (!json?.access_token) {
    throw new Error(`换 token 失败: ${json?.message ?? json?.code ?? 'unknown'}（appId=${appId}）`)
  }
  return { token: json.access_token, expiresIn: Number(json.expires_in) || 7200 }
}

/**
 * 发一条消息（出站）。默认走**被动回复**（带 msg_id），因为：
 *   · 被动回复不占主动消息额度，且不受用户「允许主动发送」开关影响
 *   · 主动消息有 1000/天/用户 的硬限，私聊还能被用户关掉
 * 只有拿不到 msg_id（如主动开场）时才降级主动消息 —— 降级是显式选择，不是默认。
 */
export async function sendC2C ({ token, openid, content, msgId = null, fetchImpl = fetch }) {
  const body = { content: String(content ?? ''), msg_type: 0 }
  if (msgId) {
    body.msg_id = String(msgId)
    body.msg_seq = 1   // 同一条 msg_id 多次回复要递增；首条固定 1
  }
  const res = await fetchImpl(`${API_BASE}/v2/users/${openid}/messages`, {
    method: 'POST',
    headers: { authorization: `QQBot ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  return {
    ok: res.ok,
    status: res.status,
    messageId: json?.id ?? null,
    // 被动回复失败时的官方错误码（40034005 = msg_id 过期；11255 = 用户不存在）
    code: json?.code ?? null,
    error: res.ok ? null : (json?.message ?? `HTTP ${res.status}`),
  }
}

/**
 * 官方事件 → 桥的入站事件，并补齐「官方通道特有」的字段。
 *
 * 与适配层的区别：适配层只做格式转换（纯函数）；这里再加**通道语义**：
 *   · peerKey 用 official: 前缀
 *   · 记录 replyTarget（被动回复锚点，供回复时用）
 *   · 私聊默认放行，群聊默认只处理 @（requireMention 默认 true）
 */
export function toBridgeInbound (officialEv, eventType, opts = {}) {
  const ev = toInboundEvent(officialEv, eventType, opts)
  if (!ev) return null
  const peerKey = officialPeerKey(ev)
  const reply = toReplyTarget(ev, '')
  return { ev, peerKey, reply }
}

/**
 * 起一个官方 bot 通道进程。
 *
 * @param {object} opts
 * @param {(inbound:object)=>Promise<string|null>} opts.onMessage
 *        业务处理：收到入站事件，返回要发出去的文本（null = 不回复）。
 *        这里刻意做成**回调**，好让上层注入「桥的 handleInbound + 取回复」逻辑，
 *        也方便测试塞假实现。
 * @param {object} [opts.creds]    凭据（不传则从默认路径读）
 * @param {boolean} [opts.dryRun]  只连不回复
 * @param {(m:string)=>void} [opts.log]
 */
export async function startOfficialBot (opts = {}) {
  const log = opts.log ?? (m => console.log(`[official] ${m}`))
  const creds = opts.creds ?? loadCredentials()
  const dryRun = opts.dryRun ?? process.env.OFFICIAL_BOT_DRY_RUN === '1'
  const requireMention = opts.requireMention !== false

  log(`账号=${creds.name} appId=${creds.appId}（secret 不打印）`)
  log(`能力边界：群全量消息需群主授权=${OFFICIAL_BOT_LIMITS.groupOverheardNeedsOwnerGrant}；` +
    `有真实QQ号=${OFFICIAL_BOT_LIMITS.hasRealQqNumber}`)

  const { token, expiresIn } = await fetchAccessToken(creds)
  log(`token 已获取（${expiresIn}s 有效）`)

  // 动态 import：ws 从 dsh profile 的 node_modules 拿（本仓 package.json 没有它）
  const wsUrl = opts.wsUrl ?? GATEWAY_URL
  const { WebSocket } = await loadWs()
  const ws = new WebSocket(wsUrl)

  let seq = null
  let heartbeatTimer = null

  const send = (op, d) => ws.send(JSON.stringify({ op, d }))

  ws.on('open', () => log('网关已连接'))
  ws.on('error', err => log(`网关错误: ${err.message}`))
  ws.on('close', (code, reason) => {
    log(`网关断开 code=${code} reason=${String(reason)}`)
    if (heartbeatTimer) clearInterval(heartbeatTimer)
  })

  ws.on('message', async raw => {
    let frame
    try { frame = JSON.parse(String(raw)) } catch { return }
    if (frame.s != null) seq = frame.s

    // op10 = HELLO：拿 heartbeat_interval 并 IDENTIFY
    if (frame.op === 10) {
      const hbMs = Number(frame.d?.heartbeat_interval) || 30000
      const intents = opts.intents ?? DEFAULT_INTENTS
      send(2, {
        token: `QQBot ${token}`,
        intents,
        shard: [0, 1],
        properties: {},
      })
      log(`IDENTIFY 已发送 intents=0x${intents.toString(16)} heartbeat=${hbMs}ms`)
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      heartbeatTimer = setInterval(() => { try { send(1, seq) } catch { /* ignore */ } }, hbMs)
      heartbeatTimer.unref?.()
      return
    }
    if (frame.op === 11) return          // HEARTBEAT_ACK
    if (frame.op === 7) { log('网关要求重连'); try { ws.close() } catch { /* ignore */ } ; return }
    if (frame.op === 9) { log('INVALID_SESSION，需要重新 IDENTIFY'); try { ws.close() } catch { /* ignore */ }; return }

    if (frame.op !== 0) return

    if (frame.t === 'READY') {
      const u = frame.d?.user ?? {}
      log(`READY：bot=${u.username ?? '?'} id=${u.id ?? '?'} session=${frame.d?.session_id ?? '?'}`)
      opts.onReady?.(frame.d)
      return
    }

    // 消息事件 → 转成桥的入站格式
    const inbound = toBridgeInbound(frame.d, frame.t, {
      requireMention,
      selfId: opts.selfId ?? null,
      selfOpenid: opts.selfOpenid ?? null,
    })
    if (!inbound) {
      log(`忽略事件 ${frame.t}（未通过门控：群聊非@/自己发的/未知类型）`)
      return
    }

    log(`入站 ${inbound.peerKey} from=${inbound.ev.sender?.nickname ?? '?'} ` +
      `text=${JSON.stringify(String(inbound.ev.raw_message ?? '').slice(0, 60))}`)

    if (dryRun) { log('[dry-run] 不处理这条'); return }

    try {
      const replyText = await opts.onMessage?.(inbound)
      if (!replyText) { log(`入站 ${inbound.peerKey} 无回复（模型选择沉默/空）`); return }
      const r = await sendC2C({
        token,
        openid: inbound.reply?.openid,
        content: replyText,
        msgId: inbound.reply?.msgId,
        fetchImpl: opts.fetchImpl,
      })
      if (r.ok) log(`已回复 ${inbound.peerKey} message_id=${r.messageId}`)
      else log(`回复失败 ${inbound.peerKey}: ${r.error}（code=${r.code}）`)
    } catch (err) {
      log(`处理入站异常 ${inbound.peerKey}: ${err.message}`)
    }
  })

  return {
    ws,
    creds,
    stop: () => { if (heartbeatTimer) clearInterval(heartbeatTimer); try { ws.close() } catch { /* ignore */ } },
  }
}

/** 动态加载 ws（优先 profile 的 node_modules，其次本仓）。 */
async function loadWs () {
  const candidates = [
    path.join(process.env.HOME ?? os.homedir(), '.dsh/profiles/web/node_modules/ws/index.js'),
    'ws',
  ]
  let lastErr = null
  for (const c of candidates) {
    try {
      const mod = await import(c)
      return mod.WebSocket ? mod : (mod.default ?? mod)
    } catch (e) { lastErr = e }
  }
  throw new Error(`找不到 ws 模块: ${lastErr?.message ?? ''}`)
}

// ── 直接运行时：起通道（业务处理留给调用方注入；这里给个 echo 兜底便于冒烟）──
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  startOfficialBot({
    // 冒烟模式：只证明「连得上 + 收到事件能打印」，不接桥的业务逻辑。
    // 真正的业务接线在 bridge/official-entry.js（见该文件）。
    onMessage: async inbound => {
      console.log(`[smoke] 收到 ${inbound.peerKey}: ${inbound.ev.raw_message}`)
      return null
    },
  }).catch(err => { console.error('启动失败:', err.message); process.exit(1) })
}
