// NapCat 容器管理：起停容器、拿登录二维码、看登录状态。
//
// 为什么插件要管容器（而不是让用户手敲 docker compose）：
//   「点一下开始，出个二维码让我扫」是设置页该做的事。让使用者自己去
//   `docker compose up -d` 再 `docker logs` 里翻二维码，等于把运维成本全丢给用户。
//
// 关键约束（都踩过）：
//   ① **只用 docker CLI，不引 dockerode 之类 SDK**。容器管理的需求就这么点
//      （up/down/ps/logs/cp），引 SDK 只会多一层版本兼容问题。
//   ② **所有命令都带超时**。docker daemon 卡住时 `docker ps` 会永久挂起，
//      设置页点一下就转圈到天荒地老，用户以为插件坏了。
//   ③ **不吞 stderr**。失败时把 docker 的原话带回去 —— 「容器起不来」这种话
//      对排查毫无价值，真正有用的是 `port is already allocated` 或镜像拉不下来。

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { dataDir, readConfig, readSecrets, writeSecrets, randomToken } from './store.js'

const DEFAULT_TIMEOUT = 30000

/**
 * 跑一条命令，带超时，永不抛错（把失败也当成一种结果返回）。
 * @returns {Promise<{ok:boolean, code:number, stdout:string, stderr:string, timedOut?:boolean}>}
 */
function run (cmd, args, { timeout = DEFAULT_TIMEOUT, cwd, env } = {}) {
  return new Promise(resolve => {
    execFile(cmd, args, {
      timeout,
      cwd,
      env: { ...process.env, ...env },
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8',
    }, (err, stdout, stderr) => {
      if (err) {
        const timedOut = err.killed && err.signal === 'SIGTERM'
        resolve({
          ok: false,
          code: typeof err.code === 'number' ? err.code : -1,
          stdout: String(stdout || ''),
          stderr: String(stderr || '') || err.message,
          timedOut,
        })
        return
      }
      resolve({ ok: true, code: 0, stdout: String(stdout || ''), stderr: String(stderr || '') })
    })
  })
}

/** docker 可用吗？不可用时给出人话说明（而不是让后面的命令一个个超时）。 */
export async function dockerAvailable () {
  const r = await run('docker', ['--version'], { timeout: 8000 })
  if (!r.ok) {
    return {
      ok: false,
      reason: '没装 Docker（不是必须的：本机版 NapCat 也行）',
      detail: r.stderr.trim(),
    }
  }
  const c = await run('docker', ['compose', 'version'], { timeout: 8000 })
  if (!c.ok) {
    return {
      ok: false,
      reason: '有 docker 但没有 compose v2 插件',
      detail: c.stderr.trim(),
    }
  }
  // daemon 是否活着：docker ps 是最直接的探测
  const d = await run('docker', ['ps', '--format', '{{.Names}}'], { timeout: 10000 })
  if (!d.ok) {
    return {
      ok: false,
      reason: 'docker daemon 没在跑（或当前用户没有权限连它）',
      detail: d.stderr.trim(),
    }
  }
  return { ok: true, version: r.stdout.trim(), compose: c.stdout.trim() }
}

/**
 * 把宿主机路径转成 docker compose 能用的形式（Windows 上必须转）。
 *
 * Windows 上三个坑，缺一个容器就起不来或者挂载了个空目录：
 *   ① `path.join` 产出反斜杠 `D:\DSH-WORKSPACE\x`，compose 解析 `\` 会当转义
 *      → 必须全部换成正斜杠 `D:/DSH-WORKSPACE/x`
 *   ② `D:/...` 带冒号的路径在 YAML 里不像普通字符串
 *      → 交给下面的 JSON.stringify + 外层引号保证
 *   ③ Docker Desktop 要求挂载路径在「文件共享」白名单里，否则报
 *      `Path ... is not shared from the host` → 运行时探测并给提示
 */
function hostPathForCompose (p) {
  const abs = path.resolve(p)
  return process.platform === 'win32' ? abs.replace(/\\/g, '/') : abs
}

/**
 * 生成 compose 文件内容。
 *
 * 为什么不复用仓库里那份 qqacct/compose.yaml：
 *   插件是独立安装的，不能假设仓库目录存在。所以由插件**按当前配置生成**一份，
 *   写在插件数据目录里。这样设置页改了端口/镜像/token，compose 跟着变，
 *   也不需要用户去手改 YAML。
 */
export function renderCompose (cfg) {
  const n = cfg.napcat || {}
  const containerName = n.containerName || 'llminqq-napcat'
  const image = n.image || 'mlikiowa/napcat-docker:v4.15.19'
  const webuiPort = Number(n.webuiPort) || 6099
  const onebotPort = Number(n.onebotPort) || 3001
  const tz = n.timezone || 'Asia/Shanghai'
  const uid = Number(n.uid) || 1000
  const gid = Number(n.gid) || 1000
  const memLimit = n.memLimit || '2g'
  const webuiToken = n.webuiToken || ''

  // 数据卷都落在插件数据目录下 —— 登录态要留着，删了就得重新扫码。
  // 用绝对路径，因为 compose 文件在插件数据目录里，相对路径会解析错。
  const base = path.join(dataDir(), 'napcat')
  const t = s => JSON.stringify(String(s))
  // 卷映射的宿主机侧必须走 hostPathForCompose（Windows 转正斜杠），
  // 整行再用双引号包住 —— D:/ 里的冒号在 YAML 里需要保护。
  const vol = (sub, target) => `      - "${hostPathForCompose(path.join(base, sub))}:${target}"`

  return `# 由 dsh-plugin-llminqq 生成 —— 不要手改，改设置页（保存后会重新生成）
services:
  napcat:
    image: ${t(image)}
    container_name: ${t(containerName)}
    restart: unless-stopped
    environment:
      MODE: ws
      WEBUI_TOKEN: ${t(webuiToken)}
      NAPCAT_UID: ${t(uid)}
      NAPCAT_GID: ${t(gid)}
      TZ: ${t(tz)}
    ports:
      - "${webuiPort}:6099"
      - "127.0.0.1:${onebotPort}:3001"
    volumes:
${vol('data/qq', '/app/.config/QQ')}
${vol('data/config', '/app/napcat/config')}
${vol('data/plugins', '/app/napcat/plugins')}
${vol('data/cache', '/app/napcat/cache')}
    shm_size: 256m
    mem_limit: ${t(memLimit)}
`
}

/** 把 compose 写到插件数据目录，返回文件路径。已存在且内容相同就不重写。 */
export function writeComposeFile (cfg) {
  const dir = path.join(dataDir(), 'napcat')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, 'compose.yaml')
  const content = renderCompose(cfg)
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== content) {
    fs.writeFileSync(file, content, { mode: 0o600 })
  }
  // 数据目录也要预先建好，否则 docker 会以 root 建、之后权限打架
  for (const sub of ['data/qq', 'data/config', 'data/plugins', 'data/cache']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true })
  }
  return file
}

/** 容器状态：running / exited / not-created / docker-unavailable。 */
export async function containerStatus (cfg) {
  const name = cfg.napcat?.containerName || 'llminqq-napcat'
  const r = await run('docker', ['ps', '-a', '--filter', `name=^${name}$`, '--format', '{{.State}}\t{{.Status}}'], { timeout: 10000 })
  if (!r.ok) return { state: 'docker-unavailable', detail: r.stderr.trim() }
  const line = r.stdout.trim()
  if (!line) return { state: 'not-created' }
  const [state, status] = line.split('\t')
  return { state: state || 'unknown', status: status || '' }
}

/** 起容器。幂等：已经在跑就直接返回。 */
export async function startContainer (cfg) {
  const probe = await dockerAvailable()
  if (!probe.ok) return { ok: false, reason: probe.reason, detail: probe.detail }

  // WebUI token 为空时生成一个并持久化 —— 空 token 的 WebUI 等于把登录二维码公开
  let effective = cfg
  if (!cfg.napcat?.webuiToken) {
    const token = randomToken(8)
    writeSecrets({ webuiToken: token })
    effective = { ...cfg, napcat: { ...cfg.napcat, webuiToken: token } }
  }

  const composeFile = writeComposeFile(effective)
  const r = await run('docker', ['compose', '-f', composeFile, 'up', '-d'], {
    timeout: 180000,   // 第一次要拉镜像（2GB+），给足时间
  })
  if (!r.ok) {
    const raw = (r.stderr || r.stdout)
    // Windows / Docker Desktop 的专项诊断：这两种错误信息对用户毫无指向性，
    // 必须翻译成「你该去点哪里」。
    if (/is not shared from the host|not shared from the host|path.*not shared/i.test(raw)) {
      return {
        ok: false,
        reason: 'Docker Desktop 没有共享这个磁盘',
        detail: [
          '插件的数据目录在 ' + dataDir(),
          '',
          'Windows 上的 Docker Desktop 只能挂载「已共享」的盘。修法：',
          '  Docker Desktop → 右上齿轮 Settings → Resources → File sharing',
          '  把该盘（例如 D:）加进列表 → Apply & restart',
          '',
          '如果你的项目在 C: 之外，这是 Windows 上最常见的一道坎。',
        ].join('\n'),
        composeFile,
      }
    }
    if (/error during connect|Is the docker daemon running|cannot connect to the Docker daemon/i.test(raw)) {
      return {
        ok: false,
        reason: 'Docker daemon 没在跑',
        detail: 'Windows 上要先把 Docker Desktop 启动起来，等它状态变成 Running，再回来点这个按钮。',
        composeFile,
      }
    }
    if (/port is already allocated|address already in use/i.test(raw)) {
      return {
        ok: false,
        reason: '端口被占用了（6099 或 3001）',
        detail: [
          '可能是之前的 NapCat 容器还在跑，或者别的程序占了这两个端口。',
          '查一下：docker ps  然后 docker stop <容器名>',
          '或改设置页里的端口（WebUI 端口 / OneBot WS 端口）。',
          '',
          raw.trim().slice(-600),
        ].join('\n'),
        composeFile,
      }
    }
    return {
      ok: false,
      reason: r.timedOut ? '拉镜像/启动超时（可能是网络慢，稍后重试）' : '容器起不来',
      detail: raw.trim().slice(-2000),
      composeFile,
    }
  }
  const status = await containerStatus(effective)
  return { ok: true, status, composeFile, webuiToken: effective.napcat.webuiToken }
}

/** 停容器（不删数据卷 —— 登录态要保留）。 */
export async function stopContainer (cfg) {
  const composeFile = writeComposeFile(cfg)
  const r = await run('docker', ['compose', '-f', composeFile, 'down'], { timeout: 60000 })
  return r.ok
    ? { ok: true }
    : { ok: false, reason: '停止失败', detail: (r.stderr || r.stdout).trim().slice(-1000) }
}

// ── 登录二维码 ───────────────────────────────────────────────────────────────
//
// NapCat 的二维码有两种拿法：
//   ① WebUI 页面里看（需要 token，要开浏览器）
//   ② 数据卷里的 qrcode.png（容器写好文件）
// 这里走 ②：从容器里把 qrcode.png 拷出来。设置页直接显示图片，用户手机扫，
// 不用开第二个浏览器标签、也不用传 token。

const QR_CANDIDATES = [
  '/app/napcat/cache/qrcode.png',
  '/app/.config/QQ/qrcode.png',
]

/**
 * 从容器里取登录二维码。
 * @returns {Promise<{ok:boolean, png?:Buffer, source?:string, reason?:string, detail?:string}>}
 */
export async function fetchQrCode (cfg) {
  const name = cfg.napcat?.containerName || 'llminqq-napcat'
  const st = await containerStatus(cfg)
  if (st.state === 'not-created') {
    return { ok: false, reason: '容器还没创建。点「启动 QQ」先把它起起来' }
  }
  if (st.state === 'docker-unavailable') {
    return { ok: false, reason: 'docker 不可用', detail: st.detail }
  }

  let lastDetail = ''
  for (const candidate of QR_CANDIDATES) {
    // docker cp 把容器里的文件拷到本地临时路径 —— 比 exec + base64 简单可靠
    const tmp = path.join(dataDir(), 'qr-tmp.png')
    const r = await run('docker', ['cp', `${name}:${candidate}`, tmp], { timeout: 15000 })
    if (!r.ok) { lastDetail = r.stderr.trim(); continue }
    try {
      const png = fs.readFileSync(tmp)
      fs.rmSync(tmp, { force: true })
      // PNG 魔数校验：docker cp 在容器里没有该文件时可能拷出一个空文件
      if (png.length < 100 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
        lastDetail = `${candidate} 不是有效 PNG（${png.length} 字节）`
        continue
      }
      // 存一份到插件目录，设置页 /qr 路由直接读这个，避免每次都去 cp
      fs.writeFileSync(path.join(dataDir(), 'qr.png'), png)
      return { ok: true, png, source: candidate }
    } catch (err) {
      lastDetail = err.message
    }
  }
  return {
    ok: false,
    reason: '拿不到二维码。可能还在启动（等 10~30 秒再试），或已经登录成功（已登录不再出码）',
    detail: lastDetail,
  }
}

/** 读最近一次缓存的二维码（不碰 docker，设置页轮询用这个更轻）。 */
export function cachedQr () {
  try {
    const p = path.join(dataDir(), 'qr.png')
    const st = fs.statSync(p)
    return { png: fs.readFileSync(p), mtime: st.mtimeMs }
  } catch {
    return null
  }
}

// ── 登录状态 ─────────────────────────────────────────────────────────────────
//
// 「登录成功了吗」不能只看容器在跑 —— 容器 running 但没扫码是常见状态。
// 可靠判据是容器日志里出现登录成功字样，或者 OneBot WS 连上了（后者由 bridge 报）。
export async function loginStatus (cfg) {
  const name = cfg.napcat?.containerName || 'llminqq-napcat'
  const st = await containerStatus(cfg)
  if (st.state === 'not-created') return { loggedIn: false, state: 'not-created' }
  if (st.state === 'docker-unavailable') return { loggedIn: false, state: 'docker-unavailable', detail: st.detail }
  if (st.state !== 'running') return { loggedIn: false, state: st.state, status: st.status }

  const r = await run('docker', ['logs', '--tail', '200', name], { timeout: 15000 })
  const log = (r.stdout || '') + (r.stderr || '')

  // 成功标志（NapCat 不同版本措辞不同，覆盖几种）
  const okRe = /登录成功|已登录|login success|Online|账号已上线|快速登录成功/i
  // 需要扫码的标志
  const needQrRe = /请扫码|二维码|扫码登录|QRCode|scan/i
  // 掉线/被踢
  const kickedRe = /KickedOffLine|被踢下线|登录失效|下线/i

  if (kickedRe.test(log)) return { loggedIn: false, state: 'kicked', detail: '被踢下线（凭证已作废，需要重新扫码）' }
  if (okRe.test(log)) return { loggedIn: true, state: 'online' }
  if (needQrRe.test(log)) return { loggedIn: false, state: 'waiting-scan' }
  return { loggedIn: false, state: 'starting', detail: '容器在跑但还没到扫码/登录阶段，稍等' }
}

/** WebUI 访问地址（设置页给用户一个可点的链接，备用扫码入口）。 */
export function webuiUrl (cfg) {
  const token = readSecrets().webuiToken || cfg.napcat?.webuiToken || ''
  const port = cfg.napcat?.webuiPort || 6099
  return `http://127.0.0.1:${port}/webui${token ? `?token=${encodeURIComponent(token)}` : ''}`
}

export { run as _run }
