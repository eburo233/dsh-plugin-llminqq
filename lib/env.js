// 环境探测与一键安装引导。
//
// 这个模块回答一个问题：**这台机器上，用哪种方式把 NapCat 跑起来最省事？**
//
// 为什么不是「一个按钮装完所有东西」：
//   Windows 上 Docker Desktop 需要 GUI 交互 + 管理员权限 + 重启，
//   任何插件都不可能替你点完那些「下一步」。硬做一个「自动安装」按钮，
//   结果只会是「转圈半天然后失败」，比不做更糟。
//
//   所以这里的设计是：**探测真实状态 → 选出最优路径 → 给出**可以直接复制执行**的命令**。
//   能自动做的（起容器、拉镜像、写配置、启动 NapCat 进程）就自动做；
//   不能自动做的（装 Docker Desktop）就说清楚「去点哪里」，并给准确命令。
//
// 四条路径（按省事程度排序）：
//   ① docker      已有 Docker → 直接起容器（最省事，插件全自动）
//   ② local       没有 Docker 但有 QQ/NapCat → 直接用本机 NapCat（全自动）
//   ③ install-docker  没有 Docker 但能装 → 给出各平台的准确安装方式
//   ④ install-napcat  没有 Docker 也不想装 → 装 NapCat Shell（Linux 一条命令）

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import net from 'node:net'
import { randomBytes } from 'node:crypto'
import { dataDir, readConfig } from './store.js'

const IS_WIN = process.platform === 'win32'
const IS_MAC = process.platform === 'darwin'
const IS_LINUX = process.platform === 'linux'

/** 跑命令，永不抛错。 */
function run (cmd, args, { timeout = 15000, env } = {}) {
  return new Promise(resolve => {
    execFile(cmd, args, {
      timeout,
      env: { ...process.env, ...env },
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
      windowsHide: true,
    }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, code: typeof err.code === 'number' ? err.code : -1,
          stdout: String(stdout || ''), stderr: String(stderr || '') || err.message })
        return
      }
      resolve({ ok: true, code: 0, stdout: String(stdout || ''), stderr: String(stderr || '') })
    })
  })
}

// ── 各平台「装 Docker」的准确指引 ─────────────────────────────────────────────
//
// 全部是**可复制的命令**或**明确的 GUI 路径**，不给模糊建议。
// Windows/macOS 的 Docker Desktop 必须手动装（GUI + 重启），Linux 可以脚本装。

function dockerInstallGuide (platform) {
  if (platform === 'win32') {
    return {
      canAutoInstall: false,
      title: 'Windows：装 Docker Desktop',
      why: 'Docker Desktop 需要 GUI 安装向导、管理员权限、装完要重启。这些插件替你做不了。',
      steps: [
        '打开 https://www.docker.com/products/docker-desktop/',
        '下载 Windows 版（amd64 / arm64 按你的机器选）',
        '双击安装，勾选 "Use WSL 2 based engine"',
        '装完重启电脑',
        '启动 Docker Desktop，等左下角状态变成 "Engine running"',
        '',
        '⚠️ 关键一步（很多人卡在这）：',
        '  Docker Desktop → Settings → Resources → File sharing',
        '  把插件数据目录所在的盘加进去（例如 D:），否则挂载会报',
        '  "Path ... is not shared from the host"',
      ],
      verify: 'docker version',
      dataDirHint: true,
    }
  }
  if (platform === 'darwin') {
    return {
      canAutoInstall: false,
      title: 'macOS：装 Docker Desktop',
      why: 'Docker Desktop 需要 GUI 安装向导，插件替你做不了。',
      steps: [
        '打开 https://www.docker.com/products/docker-desktop/',
        '下载 Mac 版（Apple Silicon 选 Apple chip，Intel 选 Intel chip）',
        '把 Docker.app 拖进 Applications',
        '打开它，首次会让你授权系统扩展，同意即可',
        '等菜单栏鲸鱼图标变成 "Engine running"',
      ],
      verify: 'docker version',
    }
  }
  if (platform === 'linux') {
    return {
      canAutoInstall: true,
      title: 'Linux：一条命令装 Docker',
      why: '官方提供了免交互安装脚本，可以自动跑（需要 sudo）。',
      steps: [
        '这条命令来自 Docker 官方文档（get.docker.com）',
      ],
      command: 'curl -fsSL https://get.docker.com | sudo sh',
      postSteps: [
        '把当前用户加进 docker 组，否则每次都要 sudo：',
        '  sudo usermod -aG docker $USER',
        '然后**注销重新登录**（组变更要重登才生效）',
        '',
        '验证：docker version',
      ],
      verify: 'docker version',
      // 这些是常见的 Linux 前置依赖缺失
      hints: [
        'Debian/Ubuntu 缺依赖：sudo apt-get install -y ca-certificates curl gnupg',
        'RHEL/CentOS 缺依赖：sudo dnf install -y dnf-plugins-core',
        '国内拉镜像慢：给 /etc/docker/daemon.json 配 registry-mirrors',
      ],
    }
  }
  return {
    canAutoInstall: false,
    title: `未知平台（${platform}）`,
    why: '没有为这个平台准备安装指引。',
    steps: ['参考 https://docs.docker.com/engine/install/'],
    verify: 'docker version',
  }
}

/** 「不装 Docker，直接跑 NapCat」的指引（按平台）。 */
function localNapcatGuide (platform) {
  if (platform === 'win32') {
    return {
      title: 'Windows：不装 Docker，直接跑 NapCat',
      recommended: true,
      why: 'Windows 上 NapCat 有官方一键安装器，比装 Docker Desktop 轻得多（不用重启、不用 WSL2）。',
      steps: [
        '【方式 A】一键安装器（推荐，不用先装 QQ）',
        '  1. 下载 NapCat.Shell.Windows.OneKey.zip',
        '     https://github.com/NapNeko/NapCatQQ/releases/latest',
        '  2. 解压，运行 NapCatInstaller.exe',
        '  3. 完成后进入生成的 NapCat.XXXX.Shell 目录',
        '  4. 双击 napcat.bat 启动（可带 QQ 号快速登录：napcat.bat 123456789）',
        '',
        '【方式 B】手动（已经装了 QQ）',
        '  1. 下载 NapCat.Shell.zip 解压',
        '  2. 双击 launcher.bat（Win10 用 launcher-win10.bat）',
        '',
        '启动后在控制台里能看到 WebUI 地址和二维码。',
        '然后把本插件的连接方式改成「本机 NapCat」，端口 3001。',
      ],
    }
  }
  if (platform === 'darwin') {
    return {
      title: 'macOS：不装 Docker，直接跑 NapCat',
      recommended: true,
      steps: [
        '1. 先装 QQ 到 /Applications/QQ.app',
        '2. 下载并打开 NapCat-Mac-Installer',
        '   https://github.com/NapNeko/NapCat-Mac-Installer/releases/latest',
        '3. 按提示授权修改 QQ 入口',
        '4. 切换到 NapCat 后启动',
        '',
        '配置和插件在安装器更新时会保留；FFmpeg 已随 NapCat 提供。',
      ],
    }
  }
  if (platform === 'linux') {
    return {
      title: 'Linux：不装 Docker，一条命令装 NapCat Shell',
      recommended: true,
      why: '官方 Installer 支持 apt/dnf 的 amd64/arm64，装到 ~/Napcat，不需要 root 跑 Docker。',
      command: 'curl -fL --connect-timeout 20 --max-time 1800 -o napcat.sh https://raw.githubusercontent.com/NapNeko/NapCat-Installer/main/script/install.sh && bash napcat.sh --docker n --cli y --github-proxy 0',
      postSteps: [
        '装完运行 `napcat` 管理服务。',
        '如果系统没提供 Xvfb，这个方式会失败 —— 那就转用 Docker。',
        '',
        '国内网络下 GitHub 可能慢，可以加 --github-proxy <加速地址>；',
        '直连就保持 --github-proxy 0。',
      ],
      altCommand: {
        label: 'AppImage（连 QQ 一起打包，最省事）',
        steps: [
          '先装 xvfb-run 和 xauth：',
          '  sudo apt-get install -y xvfb xauth     # Debian/Ubuntu',
          '  sudo dnf install -y xorg-x11-server-Xvfb xauth   # RHEL/Fedora',
          '然后从 https://github.com/NapNeko/NapCatAppImageBuild/releases/latest 下载',
          '保存为 NapCat.AppImage，chmod +x 后直接跑：',
          '  ./NapCat.AppImage -q 你的小号QQ',
          '（没有 FUSE 就加 --appimage-extract-and-run）',
        ],
      },
    }
  }
  return { title: `未知平台（${platform}）`, steps: ['参考 https://napneko.github.io/guide/boot/Shell'] }
}

// ── 探测 ─────────────────────────────────────────────────────────────────────

/** Docker 是否可用（命令行 + compose + daemon 都通）。 */
export async function probeDocker () {
  const v = await run('docker', ['--version'], { timeout: 8000 })
  if (!v.ok) {
    return { present: false, usable: false, reason: '命令不存在' }
  }
  const c = await run('docker', ['compose', 'version'], { timeout: 8000 })
  const d = await run('docker', ['ps', '--format', '{{.Names}}'], { timeout: 12000 })
  return {
    present: true,
    usable: c.ok && d.ok,
    version: v.stdout.trim(),
    compose: c.ok ? c.stdout.trim() : '',
    composeOk: c.ok,
    daemonOk: d.ok,
    daemonReason: d.ok ? '' : d.stderr.trim().slice(0, 300),
  }
}

/**
 * 本机 NapCat 是否在跑。
 *
 * 判据是「OneBot 的 WS 端口有人听」，不是「进程名匹配」——
 * 进程名在不同版本 / 不同启动方式下都不一样，端口才是稳定契约。
 * 用 Node 的 net 连一下比 netstat 解析可靠（也不用管 Windows/Linux 差异）。
 */
export function probeLocalOneBotPort (port = 3001, host = '127.0.0.1', timeoutMs = 1500) {
  return new Promise(resolve => {
    let settled = false
    const done = (open, detail) => {
      if (settled) return
      settled = true
      resolve({ open, host, port, detail })
    }
    let socket
    try {
      socket = net.connect({ host, port })
      socket.setTimeout(timeoutMs)
      socket.once('connect', () => { socket.destroy(); done(true, '端口有服务在听') })
      socket.once('timeout', () => { socket.destroy(); done(false, '连接超时') })
      socket.once('error', e => done(false, e.code || e.message))
    } catch (e) {
      done(false, e.message)
    }
  })
}

/** 扫一遍机器上有没有 NapCat / QQ（给「已有 NapCat」的判定加证据）。 */

/**
 * 真的去问一句「你是不是 OneBot」。
 *
 * 为什么不能只靠「端口能连」：
 *   3001 上有服务 ≠ 那是 OneBot。用户机器上 3001 也可能被别的程序占着，
 *   或者 NapCat 起了但**没开正向 WebSocket 服务**（NapCat 默认不监听任何端口，
 *   要在 WebUI 里手动加一个「WebSocket 服务器」配置，端口默认才是 3001）。
 *
 *   这两种情况在「只测端口」的探测里长得一模一样（都显示「端口有服务」或
 *   「端口空闲」），用户根本没法判断问题在哪。
 *
 * 探测手段（从便宜到贵，任一成功即可）：
 *   ① HTTP GET /get_status  → OneBot 11 的 HTTP 接口，返回 JSON 带 self_id
 *   ② WebSocket 握手（带 Sec-WebSocket-Key）→ 能 101 升级就是 WS 服务
 *   两者都失败 = 这个端口不是 OneBot。
 */
export async function probeOneBotHttp (port, host = '127.0.0.1', timeoutMs = 3000, token = '') {
  const url = `http://${host}:${port}/get_status`
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: '{}',
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!r.ok) return { ok: false, reason: `HTTP ${r.status}` }
    const body = await r.json().catch(() => null)
    // OneBot 11 响应形如 {status:"ok", retcode:0, data:{online:true, good:true}}
    if (body && typeof body === 'object' && 'retcode' in body) {
      return {
        ok: true,
        kind: 'onebot-http',
        status: body.status,
        retcode: body.retcode,
        data: body.data ?? {},
      }
    }
    return { ok: false, reason: 'HTTP 有响应但不是 OneBot 格式' }
  } catch (err) {
    return { ok: false, reason: err.name === 'TimeoutError' ? 'HTTP 超时' : err.message }
  }
}

/** 裸 WebSocket 握手：能升级成 101 就说明这是个 WS 服务（很可能就是 OneBot 正向 WS）。 */
export function probeWebSocketHandshake (port, host = '127.0.0.1', timeoutMs = 3000, token = '') {
  return new Promise(resolve => {
    let settled = false
    const done = (ok, detail) => {
      if (settled) return
      settled = true
      try { socket.destroy() } catch { /* ignore */ }
      resolve({ ok, detail })
    }
    let socket
    try {
      socket = net.connect({ host, port })
      socket.setTimeout(timeoutMs)
      socket.once('connect', () => {
        // 手写最小握手头，看服务会不会回 101。
        // ⚠️ Sec-WebSocket-Key 必须是**恰好 16 字节随机数**的 base64。
        // 之前用 `Math.random().toString(36).slice(2) + '123456'` 凑 16 个字符，
        // 长度会随随机数前缀变化（16 或 17 个字符），17 字节时服务端回
        // `400 Missing or invalid Sec-WebSocket-Key header`，探测就永远失败 ——
        // 表现是「NapCat 明明连着，设置页却说没连上」。
        const key = randomBytes(16).toString('base64')
        // token 两种方式都带：query（OneBot 规范）+ Authorization header（NapCat 认这个）。
        // 不带 token 的话，配了 Token 的 NapCat 会直接断连，探测就会误报「不是 OneBot」。
        const pathWithToken = token
          ? `/?access_token=${encodeURIComponent(token)}`
          : '/'
        socket.write(
          `GET ${pathWithToken} HTTP/1.1\r\n` +
          `Host: ${host}:${port}\r\n` +
          `Upgrade: websocket\r\n` +
          `Connection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\n` +
          `Sec-WebSocket-Version: 13\r\n` +
          (token ? `Authorization: Bearer ${token}\r\n` : '') +
          `\r\n`,
        )
      })
      let buf = ''
      socket.on('data', d => {
        buf += String(d)
        const m = /^HTTP\/1\.[01] (\d{3})/.exec(buf)
        if (!m) return
        const code = Number(m[1])
        if (code === 101) done(true, 'WebSocket 握手成功 (101)')
        // 400/401/403/426：端口上确实是 WS 服务，只是这次握手被拒（key/token/路径）。
        // 别把它说成「不是 WebSocket」—— 那是误报，会把人引去查错方向。
        else if (code === 400 || code === 401 || code === 403 || code === 426) {
          done(false, `端口上有 WebSocket 服务，但握手被拒（HTTP ${code}，多半是 token 或路径不对）`)
        } else done(false, `HTTP ${code}`)
      })
      socket.once('timeout', () => done(false, '握手超时'))
      socket.once('error', e => done(false, e.code || e.message))
      // ⚠️ 必须监听 close：服务端鉴权失败时会**直接销毁 socket**（不发响应），
      // 这时既不触发 timeout 也不触发 error 的某些路径，Promise 会永远挂着。
      // 实测踩到过：整个探测（乃至设置页的「重新探测」）就此卡死不返回。
      socket.once('close', () => done(false, '连接被服务端关闭（可能是鉴权失败）'))
    } catch (e) {
      done(false, e.message)
    }
  })
}

/**
 * 扫常见 OneBot 端口，找出「真的是 OneBot」的那个。
 *
 * 为什么要扫而不是只试一个：
 *   NapCat 的端口是可配置的，用户可能设成 3001 / 3000 / 6099 / 8080…
 *   只试 3001 然后报「没找到」，用户会以为 NapCat 没起来。
 *
 * 判定优先级：HTTP 接口认出 OneBot > WS 握手成功。
 */
export const COMMON_ONEBOT_PORTS = [3001, 3000, 6099, 8080, 5700, 5701, 6700]

export async function findOneBot (preferredPort, token = '') {
  const ports = [...new Set([Number(preferredPort) || 3001, ...COMMON_ONEBOT_PORTS])]
  const hits = []
  // 并行扫，每个都带自己的超时，整体就 3 秒左右
  const results = await Promise.all(ports.map(async port => {
    const ws = await probeWebSocketHandshake(port, '127.0.0.1', 2500, token)
    if (ws.ok) return { port, kind: 'websocket', detail: ws.detail }
    const http = await probeOneBotHttp(port, '127.0.0.1', 2500, token)
    if (http.ok) return { port, kind: 'http', detail: `retcode=${http.retcode}`, selfId: http.data?.self_id }
    return null
  }))
  for (const r of results) if (r) hits.push(r)
  return {
    found: hits.length > 0,
    hits,
    // 优先返回用户配置的端口，其次第一个找到的
    best: hits.find(h => h.port === Number(preferredPort)) ?? hits[0] ?? null,
    scanned: ports,
  }
}

export async function probeNapcatArtifacts () {
  const found = []
  const home = os.homedir()
  const candidates = []

  if (IS_WIN) {
    candidates.push(
      path.join(home, 'Napcat'),
      path.join(home, 'NapCat'),
      'C:\\NapCat',
      path.join(process.env.LOCALAPPDATA || '', 'NapCat'),
      path.join(process.env.PROGRAMFILES || '', 'Tencent', 'QQNT'),
      path.join(process.env['PROGRAMFILES(X86)'] || '', 'Tencent', 'QQNT'),
    )
  } else if (IS_LINUX) {
    candidates.push(
      path.join(home, 'Napcat'),
      path.join(home, 'NapCat'),
      '/opt/QQ',
      '/opt/napcat',
      path.join(home, '.local/share/NapCat'),
    )
  } else if (IS_MAC) {
    candidates.push('/Applications/QQ.app', path.join(home, 'Napcat'))
  }

  for (const c of candidates) {
    if (!c) continue
    try { if (fs.existsSync(c)) found.push(c) } catch { /* 权限问题忽略 */ }
  }
  return found
}

/** 有没有 docker 镜像已经在本地（有的话起容器不用等拉镜像）。 */
export async function probeLocalImages (image) {
  const r = await run('docker', ['images', '--format', '{{.Repository}}:{{.Tag}}'], { timeout: 12000 })
  if (!r.ok) return { ok: false, images: [] }
  const images = r.stdout.split('\n').map(s => s.trim()).filter(Boolean)
  return { ok: true, images, hasTarget: images.some(i => i === image || i.startsWith(image + ':')) }
}

/** 有没有已在运行的容器（不管是不是我们起的）。 */
export async function probeRunningContainers () {
  const r = await run('docker', ['ps', '--format', '{{.Names}}\t{{.Image}}\t{{.Status}}'], { timeout: 12000 })
  if (!r.ok) return []
  return r.stdout.split('\n').filter(Boolean).map(line => {
    const [name, image, status] = line.split('\t')
    return { name, image, status }
  })
}

// ── 综合体检 ─────────────────────────────────────────────────────────────────

/**
 * 一次拿全「这台机器能怎么跑」。
 *
 * 前端拿这个渲染「环境体检」卡片：哪项有、哪项缺、推荐哪条路、下一步点什么。
 * 不做任何有副作用的操作 —— 纯探测，可以随便刷新。
 *
 * @param {{force?:boolean, maxAgeMs?:number}} [opts]
 *   force=true    跳过缓存，真跑一遍（「测试 OneBot 连接」「重新探测」用这个）
 *   maxAgeMs      缓存多久内算新鲜，默认 CACHE_MS
 *
 * 为什么要缓存：这个函数每次要跑六项探测，实测 251~294ms，其中 `docker images`
 * 一项就 151ms。而它在「还没连上 OneBot」时会被 SetupWizard 在**每次**打开设置页
 * 时无条件调用一次 —— 用户只是来看看二维码，却先等 270ms。
 *
 * ⚠️ 缓存必须能被显式打穿：设置页的「重新探测 / 测试连接」传 force，
 *    否则就又变成「按钮点了不生效」——那正是这次要修的二维码刷新踩过的坑。
 */
const ENV_PROBE_CACHE_MS = 30 * 1000
let envProbeCache = { at: 0, value: null }
let envProbeInflight = null

export async function probeEnvironment ({ force = false, maxAgeMs = ENV_PROBE_CACHE_MS } = {}) {
  if (!force && envProbeCache.value && Date.now() - envProbeCache.at < maxAgeMs) {
    return { ...envProbeCache.value, cached: true, cacheAgeMs: Date.now() - envProbeCache.at }
  }
  // 并发去重：设置页可能同时有 SetupWizard 和别的地方在问
  if (envProbeInflight) return envProbeInflight
  envProbeInflight = probeEnvironmentInner()
    .then(value => {
      envProbeCache = { at: Date.now(), value }
      return { ...value, cached: false, cacheAgeMs: 0 }
    })
    .finally(() => { envProbeInflight = null })
  return envProbeInflight
}

async function probeEnvironmentInner () {
  const cfg = readConfig()
  const onebotPort = Number(cfg.napcat?.onebotPort) || 3001
  const image = cfg.napcat?.image || 'mlikiowa/napcat-docker:v4.15.19'

  const token = readConfig()?.onebot?.token || ''
  const [docker, localPort, artifacts, onebot] = await Promise.all([
    probeDocker(),
    probeLocalOneBotPort(onebotPort),
    probeNapcatArtifacts(),
    // 真的去问「你是不是 OneBot」，而不是只看端口通不通。
    // 三种情况在「只测端口」时长得一样，用户没法判断：
    //   ① 端口空 → NapCat 没起来 / 没开 WS 服务
    //   ② 端口通但不是 OneBot → 别的程序占了
    //   ③ 端口通且是 OneBot → 可以连
    findOneBot(onebotPort, token),
  ])

  // 有 docker 才继续查镜像/容器（没有就别白跑命令）
  let images = { ok: false, images: [], hasTarget: false }
  let containers = []
  if (docker.usable) {
    ;[images, containers] = await Promise.all([probeLocalImages(image), probeRunningContainers()])
  }

  // ── 选推荐路径 ──────────────────────────────────────────────────────────
  //
  // 优先级：**已经能连的 OneBot 永远排第一**。
  // 理由：docker 可用不代表该再起一个容器 —— 用户可能已经在用本机 NapCat，
  // 再起容器会抢 3001 端口，互相打架。能用现成的就别装新的。
  let recommended
  if (onebot.found) {
    const b = onebot.best
    recommended = {
      id: 'existing',
      label: '已经探测到 OneBot，直接连它',
      auto: true,
      why: `端口 ${b.port} 认出是 OneBot` +
        (b.selfId ? `（账号 ${b.selfId}）` : '') +
        ' —— 去「运行」页点「启动桥」即可' +
        (docker.usable ? '。已经有服务在跑，不用再起 Docker 容器（会抢端口）' : ''),
    }
  } else if (docker.usable) {
    recommended = {
      id: 'docker',
      label: '用 Docker 跑 NapCat（插件全自动）',
      auto: true,
      why: images.hasTarget
        ? '镜像已经在本地，起容器只要几秒'
        : '镜像还没拉过，第一次要下载 2GB+（网络慢的话几分钟）',
    }
  } else if (artifacts.length > 0) {
    recommended = {
      id: 'local',
      label: '用本机已装的 NapCat',
      auto: false,
      why: `在 ${artifacts[0]} 发现了 NapCat/QQ，启动它再回来点「连接」`,
    }
  } else if (IS_WIN || IS_MAC) {
    recommended = {
      id: 'install-napcat-local',
      label: '装 NapCat 本机版（比 Docker 轻，不用重启）',
      auto: false,
      why: '这台机器没有 Docker。Windows/macOS 上装 Docker Desktop 很重（要重启），本机 NapCat 更省事',
    }
  } else {
    recommended = {
      id: 'install-docker',
      label: '装 Docker（Linux 可以一条命令装完）',
      auto: false,
      why: 'Linux 上 Docker 有免交互安装脚本，装完插件就能全自动了',
    }
  }

  return {
    platform: process.platform,
    platformLabel: IS_WIN ? 'Windows' : IS_MAC ? 'macOS' : IS_LINUX ? 'Linux' : process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    dataDir: dataDir(),
    onebotPort,
    image,

    docker,
    localPort,
    onebot,
    artifacts,
    localImages: images,
    runningContainers: containers,

    recommended,
    // 各条路的详细指引，前端按需展开
    guides: {
      docker: dockerInstallGuide(process.platform),
      localNapcat: localNapcatGuide(process.platform),
    },
  }
}

// ── 能自动做的那部分 ─────────────────────────────────────────────────────────

/**
 * 拉镜像（单独一步，让用户知道在等什么）。
 * 起容器时如果没有镜像会自动拉，但那样「转圈几分钟」看不出进度；
 * 拆出来可以先告诉用户「正在下载 2GB」。
 */
export async function pullImage (image, onProgress) {
  onProgress?.('开始拉取镜像（首次约 2GB，慢的话几分钟）')
  const r = await new Promise(resolve => {
    const child = spawn('docker', ['pull', image], { windowsHide: true })
    let tail = ''
    child.stdout.on('data', d => {
      const s = String(d)
      tail = (tail + s).slice(-2000)
      // docker pull 的输出每行一个层，取最后一行给前端做「正在…」
      const last = s.trim().split('\n').filter(Boolean).pop()
      if (last) onProgress?.(last.slice(0, 200))
    })
    child.stderr.on('data', d => { tail = (tail + String(d)).slice(-2000) })
    child.on('exit', code => resolve({ ok: code === 0, code, tail }))
    child.on('error', e => resolve({ ok: false, code: -1, tail: e.message }))
  })
  return r
}

/**
 * 检测 OneBot WS 端口是否可连（起完容器 / 起完本机 NapCat 后的验收）。
 * 容器起来不代表 NapCat 就绪 —— 它内部还要启动完整个 QQ 客户端，几十秒。
 */
export async function waitForOneBot (port = 3001, host = '127.0.0.1', timeoutMs = 90000, token = '') {
  const deadline = Date.now() + timeoutMs
  let lastDetail = ''
  while (Date.now() < deadline) {
    // 光看「端口有人听」不够：6099 那种 WebUI 端口也开着，会说「通了」但根本连不上 QQ。
    // 走一次真 WebSocket 握手才算数。
    const p = await probeWebSocketHandshake(port, host, 1200, token)
    if (p.ok) return { ok: true, detail: p.detail, waitedMs: timeoutMs - (deadline - Date.now()) }
    lastDetail = p.detail || ''
    await new Promise(r => setTimeout(r, 2000))
  }
  return { ok: false, timeoutMs, detail: lastDetail }
}

export { run as _run, IS_WIN, IS_MAC, IS_LINUX }
