// 安全相关：URL 守卫 + 不可信文本净化。
//
// 从 index.js 拆出来（2026-10-29）。拆分原则：**纯搬运，函数体一字不改**。
//
// 为什么单独一个模块：
//   · 这两个区块是纯函数，零副作用，但安全性关键（防 SSRF / 防提示注入）
//   · 以前测它们要加载整个 22 万字节的 index.js
//   · 拆出来后可以独立测，也能被其他模块安全复用
//
// 依赖：只有 config（媒体配置）+ fs/path。没有 state、没有 gateway。
//
// ⚠️ 用工厂函数而不是顶层常量：这些函数依赖运行时传入的 config，
//    而 config 在 index.js 里是启动时加载的（不是 import 时）。

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

export function createSecurity ({ config, root }) {
  const SENSITIVE = (config.media?.sensitiveNames ?? []).map(s => s.toLowerCase())
  const STAGING_DIR = config.media?.stagingDir ?? path.join(root, '.qq-media')
  const MAX_FILE = config.media?.maxFileBytes ?? 10 * 1024 * 1024
  fs.mkdirSync(STAGING_DIR, { recursive: true })

  // ↓↓↓ 以下为原 index.js 455-611 行原样搬运 ↓↓↓

// ── URL 安全守卫（防 SSRF / 链接投毒）────────────────────────────────────────
// 威胁：入站图片 url、卡片里的链接都来自**别人**。如果直接 fetch，攻击者可以让我们
//   1) 打内网：http://127.0.0.1:18080/send（我们自己的 API）、192.168.x、169.254.169.254（云元数据）
//   2) 打 file:// 之类协议
//   3) 用超长/重定向把我们拖住
// 做法：协议白名单 + 主机黑名单（私网/环回/链路本地）+ 禁止带凭据 + 限制大小/超时。
const URL_SAFE = {
  protocols: ['http:', 'https:'],
  // 明确禁止访问的主机/网段（用前缀和正则双保险）
  blockedHosts: [
    'localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback',
    'metadata.google.internal', 'metadata',
  ],
  blockedCidrs: [
    /^127\./,                    // 环回
    /^10\./,                     // 私网 A
    /^192\.168\./,               // 私网 C
    /^172\.(1[6-9]|2\d|3[01])\./, // 私网 B
    /^169\.254\./,               // 链路本地 / 云元数据
    /^0\./,                      // 0.x
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT
  ],
  maxRedirects: 2,
}

/** 这个 URL 能不能安全地由桥主动 fetch？返回 {ok, reason} */
function checkUrlSafe(rawUrl) {
  if (config.security?.allowPrivateUrls === true) return { ok: true } // 显式放开（自建场景）
  let u
  try { u = new URL(String(rawUrl)) } catch { return { ok: false, reason: 'URL 解析失败' } }

  if (!URL_SAFE.protocols.includes(u.protocol)) {
    return { ok: false, reason: `协议不允许: ${u.protocol}` }
  }
  // 禁止 URL 里带账号密码
  if (u.username || u.password) return { ok: false, reason: 'URL 含凭据' }

  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host) return { ok: false, reason: 'URL 无主机名' }
  if (URL_SAFE.blockedHosts.includes(host)) return { ok: false, reason: `主机被禁: ${host}` }
  // 域名不以点开头/结尾，防止解析歧义
  if (host.startsWith('.') || host.endsWith('.')) return { ok: false, reason: `主机名可疑: ${host}` }

  // IPv4 字面量 → 网段检查
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    if (URL_SAFE.blockedCidrs.some(re => re.test(host))) {
      return { ok: false, reason: `私网地址被禁: ${host}` }
    }
  }
  // IPv6 字面量 → 只允许公网（拒绝 ::1 / fe80 / fc00 / fd00）
  if (host.includes(':')) {
    if (/^(::1|::|fe80:|fc00:|fd00:)/i.test(host)) return { ok: false, reason: `IPv6 私网被禁: ${host}` }
  }
  // 纯数字主机（如 2130706433 = 127.0.0.1 的十进制变形）
  if (/^\d+$/.test(host)) return { ok: false, reason: `数字形式主机: ${host}` }

  return { ok: true }
}

/**
 * 安全地下载一个 URL 到 staging。
 * - 先过 checkUrlSafe
 * - 手动跟重定向（每次重定向都重新检查，防止 302 到内网）
 * - 限制响应体大小，边读边计数，超了就中止
 */
async function safeFetchBuffer(rawUrl, { timeoutMs = 30000, maxBytes = MAX_FILE } = {}) {
  let current = String(rawUrl)
  let redirects = 0
  while (true) {
    const chk = checkUrlSafe(current)
    if (!chk.ok) throw new Error(`URL 被安全策略拒绝: ${chk.reason}`)

    const res = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'LLMinQQ/1.0 (+qq-bridge)' },
    })

    // 3xx：跟一次重定向，但每一跳都要重新检查
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (!loc) throw new Error(`重定向无 Location (HTTP ${res.status})`)
      redirects += 1
      if (redirects > URL_SAFE.maxRedirects) throw new Error('重定向次数过多')
      current = new URL(loc, current).toString()
      continue
    }

    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)

    // Content-Length 先粗筛
    const cl = Number(res.headers.get('content-length') ?? 0)
    if (cl && cl > maxBytes) throw new Error(`文件过大 ${cl} > ${maxBytes}`)

    // 边读边计数（防止 Content-Length 撒谎）
    const reader = res.body?.getReader?.()
    if (!reader) {
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length > maxBytes) throw new Error(`文件过大 ${buf.length} > ${maxBytes}`)
      return { buffer: buf, contentType: res.headers.get('content-type'), finalUrl: current }
    }
    const chunks = []
    let total = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > maxBytes) {
        try { await reader.cancel() } catch { /* ignore */ }
        throw new Error(`文件过大（已读 ${total} > ${maxBytes}）`)
      }
      chunks.push(Buffer.from(value))
    }
    return { buffer: Buffer.concat(chunks), contentType: res.headers.get('content-type'), finalUrl: current }
  }
}


// ── 卡片/转发等「他人可控文本」的净化 ───────────────────────────────────────
// 威胁：卡片标题、描述、链接、合并转发内容都是别人能随意构造的。
//   他们可以塞：
//     - 「忽略以上指令」这类提示注入
//     - 伪造成桥的控制标记：[SEND_FILE:...] [VOICE:...] [AT:...] [POKE:...] [SILENT]
//       ← 最危险：模型要是复述出来，桥会真的执行！
//     - 伪造成系统消息的排版（【系统】【硬约束】等）
// 做法：把控制标记和系统样式的括号**打散/转义**，让它们失去语义但不失真。
const SYS_MARKERS = ['【系统', '【硬约束', '【人设', '【你在旁听', '【你的人设', '【你的精力', '【这条消息是个分享卡片']

function sanitizeUntrustedText(text, { maxChars = 500 } = {}) {
  if (typeof text !== 'string' || !text) return ''
  let out = text
  // ① 拆掉桥自己的控制标记，防止被复述后执行
  out = out.replace(/\[SEND_FILE\s*:/gi, '[SEND_FILE：')   // 全角冒号 → 正则不匹配
  out = out.replace(/\[VOICE\s*:/gi, '[VOICE：')
  out = out.replace(/\[POKE\s*:/gi, '[POKE：')
  out = out.replace(/\[AT\s*:/gi, '[AT：')
  out = out.replace(/\[RECALL\s*:/gi, '[RECALL：')
  out = out.replace(/\[SILENT\]/gi, '[SILENT_]')
  // ② 把可能冒充系统提示的粗方括号标题换成普通写法
  for (const m of SYS_MARKERS) {
    out = out.split(m).join(m.replace('【', '\u3010\u200b')) // 插入零宽字符，语义断开
  }
  // ③ 去掉换行里的强制指令式开头（常见注入模式）
  out = out.replace(/^\s*(忽略|无视|忘记).{0,10}(指令|设定|规则|prompt)/gim, '[过滤]')
  // ④ 长度与换行收敛
  out = out.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim()
  if (out.length > maxChars) out = out.slice(0, maxChars) + '…'
  return out
}

async function downloadUrlToStaging(url, tag = 'in') {
  const { buffer, contentType } = await safeFetchBuffer(url, { maxBytes: MAX_FILE })
  const ext = extFor(contentType)
  const name = `qq_${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`
  const dst = path.join(STAGING_DIR, name)
  fs.writeFileSync(dst, buffer)
  return dst
}

/** Content-Type → 文件后缀。取不到类型就按 jpg 存（QQ 图片 99% 是 jpeg/png）。 */
function extFor(contentType) {
  const ct = String(contentType || '').toLowerCase()
  if (ct.includes('png')) return '.png'
  if (ct.includes('webp')) return '.webp'
  if (ct.includes('gif')) return '.gif'
  if (ct.includes('bmp')) return '.bmp'
  if (ct.includes('heic')) return '.heic'
  if (ct.includes('jpeg') || ct.includes('jpg')) return '.jpg'
  return '.jpg'
}

  // ↑↑↑ 原样搬运结束 ↑↑↑

  return {
    SENSITIVE,
    STAGING_DIR,
    MAX_FILE,
    URL_SAFE,
    checkUrlSafe,
    safeFetchBuffer,
    SYS_MARKERS,
    sanitizeUntrustedText,
    downloadUrlToStaging,
  }
}
