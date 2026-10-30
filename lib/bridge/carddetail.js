// 卡片链接「点开」：B站 分享卡片的文字只有标题，视频讲了什么、UP 是谁、
// 多长、多少播放，模型都看不到。这里自己抓一次公开接口补进上下文。
//
// 为什么不走 MCP：bili MCP（D:\dsh-home\bili-duty\mcp_server.py）是给「刷B站」
// 那套用的（搜索/字幕/评论/上传），挂进 QQ 桥等于每轮都塞一堆工具说明；
// 而这里只需要「一张卡片的元信息」，一个 GET 就够。
//
// 约束：全部失败静默（QQ 里发张卡不能因为 B站 接口抖了就整条消息丢掉）。
// 但**安全策略拒绝**不能静默：卡片链接来自群成员，是他人可控输入，
// 必须走 lib/bridge/security.js 的 checkUrlSafe（防 SSRF），拒绝时 warn 一条。

import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSecurity } from './security.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const BILI_URL_RE = /https?:\/\/(?:[a-z0-9-]+\.)*(?:bilibili\.com|b23\.tv)\/[^\s"'）)]+/gi
const BV_RE = /BV[0-9A-Za-z]{10}/
const CACHE_TTL = 10 * 60 * 1000      // 同一张卡片短时间内重复发，别重复打接口
const MAX_DETAIL_CHARS = 220
// 与 security.js 的 URL_SAFE.maxRedirects 保持一致：最多跟 2 跳，每跳都重新校验
const MAX_REDIRECT_HOPS = 2
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36'

const cache = new Map() // url -> { at, text }

// security.js 的 checkUrlSafe 在 createSecurity() 工厂里，config 由 index.js 启动时加载。
// carddetail 只被 enrichCardUrls(flat.cards) 调用（拿不到 config），所以这里懒汉式建一个
// **保守默认**的守卫：config={} → allowPrivateUrls 不放开，内网/环回/非 http(s) 全部拒绝。
// root 只影响 createSecurity 里建 staging 目录的副作用，用临时目录避免在包里留垃圾。
let defaultGuard = null
function defaultCheckUrlSafe (rawUrl) {
  if (!defaultGuard) {
    defaultGuard = createSecurity({ config: {}, root: path.join(os.tmpdir(), 'llminqq-carddetail') }).checkUrlSafe
  }
  return defaultGuard(rawUrl)
}

function fmtCount (n) {
  if (!Number.isFinite(n)) return ''
  if (n >= 100000000) return `${(n / 100000000).toFixed(1)}亿`
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`
  return String(n)
}

function fmtDuration (sec) {
  if (!Number.isFinite(sec) || sec <= 0) return ''
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  const two = (x) => String(x).padStart(2, '0')
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`
}

/**
 * 带超时 + 安全校验的 GET。
 * - 每一跳（含重定向目标）都先过 checkUrlSafe，不通过就返回 null（不 fetch）
 * - redirect: 'manual'，自己跟跳，最多 MAX_REDIRECT_HOPS 跳
 * @returns {Promise<Response|null>} 被安全策略拒绝/跳太多时返回 null
 */
async function fetchWithTimeout (url, ms, { checkUrlSafe, log } = {}) {
  const check = typeof checkUrlSafe === 'function' ? checkUrlSafe : defaultCheckUrlSafe
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), ms)
  try {
    let current = String(url)
    let hops = 0
    while (true) {
      let chk
      try { chk = check(current) } catch (err) { chk = { ok: false, reason: `守卫异常: ${err?.message ?? err}` } }
      if (!chk || chk.ok !== true) {
        log?.(`WARN carddetail: 链接被安全策略拒绝，跳过抓取 url=${current} reason=${chk?.reason ?? 'unknown'}`)
        return null
      }
      const res = await fetch(current, {
        redirect: 'manual',
        signal: ac.signal,
        headers: { 'user-agent': UA },
      })
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location')
        if (!loc) {
          log?.('WARN carddetail: 重定向缺 Location，跳过抓取')
          return null
        }
        hops += 1
        if (hops > MAX_REDIRECT_HOPS) {
          log?.(`WARN carddetail: 重定向超过 ${MAX_REDIRECT_HOPS} 跳，跳过抓取 url=${current}`)
          return null
        }
        current = new URL(loc, current).toString()
        continue
      }
      return res
    }
  } finally {
    clearTimeout(timer)
  }
}

// 短链（b23.tv/xxx）→ 真地址 → BV 号
async function resolveBvid (url, opts = {}) {
  const direct = BV_RE.exec(url)
  if (direct) return direct[0]
  try {
    const res = await fetchWithTimeout(url, 5000, opts)
    if (!res) return ''
    const fromFinal = BV_RE.exec(res.url || '')
    if (fromFinal) return fromFinal[0]
    // 少数情况下跳转页里带 bvid
    const html = await res.text()
    const fromHtml = BV_RE.exec(html) || /"bvid":"(BV[0-9A-Za-z]{10})"/.exec(html)
    if (fromHtml) return fromHtml[0].length === 12 ? fromHtml[0] : fromHtml[1]
  } catch {}
  return ''
}

async function biliDetail (url, opts = {}) {
  const bvid = await resolveBvid(url, opts)
  if (!bvid) return ''
  let json
  try {
    const res = await fetchWithTimeout(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, 6000, opts)
    if (!res) return ''
    json = await res.json()
  } catch {
    return ''
  }
  if (!json || json.code !== 0 || !json.data) return ''
  const d = json.data
  const bits = [`《${d.title ?? bvid}》`]
  if (d.owner?.name) bits.push(`UP ${d.owner.name}`)
  const dur = fmtDuration(d.duration)
  if (dur) bits.push(dur)
  const view = fmtCount(d.stat?.view)
  if (view) bits.push(`播放 ${view}`)
  const desc = String(d.desc ?? '').replace(/\s+/g, ' ').trim()
  if (desc) bits.push(`简介 ${desc.length > 60 ? `${desc.slice(0, 60)}…` : desc}`)
  return `[视频详情] ${bits.join(' · ')}`.slice(0, MAX_DETAIL_CHARS)
}

/**
 * 从若干条卡片文本里挑出 B站 链接，抓一次元信息。
 * @param {string[]} cards flattenMessage 得到的卡片文本数组
 * @param {{checkUrlSafe?: (url:string)=>{ok:boolean,reason?:string}, log?: (msg:string)=>void}} [opts]
 *   checkUrlSafe 用于注入 security.js 的守卫（默认用保守默认实例）；log 缺省走 console.warn
 * @returns {Promise<string[]>} 每条链接一行可读详情（失败返回空数组）
 */
export async function enrichCardUrls (cards, opts = {}) {
  if (!Array.isArray(cards) || !cards.length) return []
  const log = typeof opts.log === 'function' ? opts.log : (m) => console.warn(m)
  const fetchOpts = {
    checkUrlSafe: typeof opts.checkUrlSafe === 'function' ? opts.checkUrlSafe : undefined,
    log,
  }
  const urls = new Set()
  for (const text of cards) {
    if (typeof text !== 'string') continue
    for (const m of text.matchAll(BILI_URL_RE)) urls.add(m[0].replace(/[)），。]+$/, ''))
  }
  if (!urls.size) return []
  const out = []
  for (const url of [...urls].slice(0, 2)) {        // 一条消息最多展开 2 个链接
    const hit = cache.get(url)
    if (hit && Date.now() - hit.at < CACHE_TTL) {
      if (hit.text) out.push(hit.text)
      continue
    }
    const text = await biliDetail(url, fetchOpts)
    cache.set(url, { at: Date.now(), text })
    if (text) out.push(text)
  }
  return out
}

export const __test = { fmtCount, fmtDuration, resolveBvid, fetchWithTimeout, MAX_REDIRECT_HOPS }
