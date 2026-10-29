#!/usr/bin/env node
// vendor-check.mjs —— 检查 vendor 目录里的第三方代码有没有新版本。
//
// 为什么需要（用户原话）：「需要注明能力来自哪里，并能够一键更新，便宜的那个也是」
//   · 「注明来自哪里」→ 每个 vendor 目录的 VENDORED.md + vendor-manifest.json
//   · 「一键更新」→ 本脚本 + vendor-update.mjs
//   · 「便宜的那个」→ dsh-video-storyboard（看视频成本约一张图的 token）
//
// 设计要点：
//   ① **版本事实源是 vendor-manifest.json**，不是包里的 package.json。
//      理由：vendored 代码可能被裁剪过（files 清单只带一部分），
//      而且 bilibili-mcp 根本没有自己的 package.json（它是宿主包的内嵌物）。
//   ② 两种 source type 的「最新版」含义不同：
//      · npm                      → 查这个包自己的最新版
//      · vendored-from-npm-package → 查**宿主包**的最新版（内嵌物没有独立版本）
//   ③ **网络失败不能崩**。离线环境下应该明确说「检查失败：网络不可用」，
//      而不是抛异常走栈 —— 用户可能只是想看看当前版本。
//   ④ 顺带校验 VENDORED.md 和 manifest 的版本号是否一致（防「文档说 0.4.3、
//      manifest 说 0.4.4」这种静默漂移）。
//
// 用法：
//   node scripts/vendor-check.mjs            # 检查全部
//   node scripts/vendor-check.mjs storyboard # 只查一个（按 name 的模糊匹配）
//   node scripts/vendor-check.mjs --json     # 机器可读输出（CI 用）

import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = path.resolve(__dirname, '..')
const VENDOR_DIR = path.join(PKG_ROOT, 'vendor')

// npm view 可能慢（国内网络尤其），给足超时但要能失败
const NPM_TIMEOUT_MS = Number(process.env.VENDOR_NPM_TIMEOUT_MS ?? 30000)

const args = process.argv.slice(2)
const jsonMode = args.includes('--json')
const filter = args.filter(a => !a.startsWith('--'))[0] ?? null

/** 跑一条命令，返回 {ok, stdout, stderr, code}。超时/不存在都不抛。 */
function run(cmd, argv, timeoutMs = NPM_TIMEOUT_MS) {
  return new Promise(resolve => {
    execFile(cmd, argv, { timeout: timeoutMs, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) {
        const timedOut = err.killed || err.signal === 'SIGTERM'
        resolve({
          ok: false,
          stdout: String(stdout ?? '').trim(),
          stderr: String(stderr ?? '').trim(),
          code: err.code ?? null,
          reason: timedOut ? `超时（${timeoutMs}ms）` : (String(stderr ?? '').trim() || err.message),
        })
        return
      }
      resolve({ ok: true, stdout: String(stdout ?? '').trim(), stderr: String(stderr ?? '').trim(), code: 0 })
    })
  })
}

/** 读 vendor 目录下所有 manifest（跳过没有 manifest 的目录，给出提示）。 */
function loadManifests() {
  if (!fs.existsSync(VENDOR_DIR)) return { manifests: [], skipped: [] }
  const manifests = []
  const skipped = []
  for (const entry of fs.readdirSync(VENDOR_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = path.join(VENDOR_DIR, entry.name)
    const mf = path.join(dir, 'vendor-manifest.json')
    if (!fs.existsSync(mf)) { skipped.push(entry.name); continue }
    try {
      const m = JSON.parse(fs.readFileSync(mf, 'utf8'))
      manifests.push({ dir, dirName: entry.name, manifest: m, manifestPath: mf })
    } catch (err) {
      skipped.push(`${entry.name}（manifest 解析失败：${err.message}）`)
    }
  }
  return { manifests, skipped }
}

/** 取 npm 上某包的最新版。失败返回 {ok:false, reason}。 */
async function latestNpmVersion(pkg) {
  const r = await run('npm', ['view', pkg, 'version'])
  if (!r.ok) return { ok: false, reason: r.reason || 'npm view 失败' }
  // 新版包可能返回多行（dist-tags），取最后一行非空
  const v = r.stdout.split('\n').map(s => s.trim()).filter(Boolean).pop()
  if (!v) return { ok: false, reason: 'npm view 没返回版本' }
  return { ok: true, version: v }
}

/**
 * 比较两个 semver 风格版本。返回 1（a>b）/ 0（相等）/ -1（a<b）。
 * 只处理 x.y.z 和带 prerelease 的简单情况 —— 够用就行（vendor 都是常规版本号）。
 */
function cmpVersion(a, b) {
  const norm = v => String(v).replace(/^v/, '').split('-')[0].split('.').map(n => Number(n) || 0)
  const A = norm(a), B = norm(b)
  const len = Math.max(A.length, B.length)
  for (let i = 0; i < len; i++) {
    const x = A[i] ?? 0, y = B[i] ?? 0
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

/** 从 manifest 里取「当前版本」的规范化形式（去掉 embedded-in-<host>@ 前缀）。 */
function currentVersionOf(manifest) {
  const v = String(manifest.version ?? '')
  const m = /^embedded-in-[^@]+@(.+)$/.exec(v)
  return m ? m[1] : v
}

/** 校验 VENDORED.md 里写的版本和 manifest 是否一致（防静默漂移）。 */
function checkDocConsistency(entry) {
  const docPath = path.join(entry.dir, 'VENDORED.md')
  if (!fs.existsSync(docPath)) return { ok: false, reason: '缺少 VENDORED.md（来源声明义务未履行）' }
  const doc = fs.readFileSync(docPath, 'utf8')
  const cur = currentVersionOf(entry.manifest)
  // VENDORED.md 里应当出现这个版本号
  if (!doc.includes(cur)) {
    return { ok: false, reason: `VENDORED.md 里找不到当前版本号 ${cur}（文档与 manifest 可能漂移）` }
  }
  return { ok: true }
}

async function checkOne(entry) {
  const m = entry.manifest
  const src = m.source ?? {}
  const cur = currentVersionOf(m)
  const docCheck = checkDocConsistency(entry)
  let latest = null
  let probeFail = null

  if (src.type === 'npm') {
    const r = await latestNpmVersion(src.package ?? m.name)
    if (r.ok) latest = r.version
    else probeFail = r.reason
  } else if (src.type === 'vendored-from-npm-package') {
    // 内嵌物：查**宿主包**的最新版（自己没有独立版本号）
    const r = await latestNpmVersion(src.package)
    if (r.ok) latest = r.version
    else probeFail = r.reason
  } else {
    probeFail = `未知 source type: ${src.type}`
  }

  let status = 'unknown'
  if (probeFail) status = 'failed'
  else if (latest == null) status = 'unknown'
  else {
    const c = cmpVersion(cur, latest)
    status = c < 0 ? 'outdated' : 'latest'
  }

  return {
    name: m.name ?? entry.dirName,
    dirName: entry.dirName,
    type: src.type ?? '?',
    // 展示用：内嵌物要标明宿主
    versionLabel: src.type === 'vendored-from-npm-package'
      ? `${cur}（内嵌于 ${src.package}@${src.version ?? '?'}）`
      : cur,
    current: cur,
    hostPackage: src.type === 'vendored-from-npm-package' ? src.package : null,
    latest,
    status,
    upgradeCmd: status === 'outdated' || status === 'latest'
      ? `node scripts/vendor-update.mjs ${entry.dirName}`
      : null,
    docCheck,
    probeFail,
  }
}

async function main() {
  const { manifests, skipped } = loadManifests()
  if (!manifests.length) {
    console.error(`✗ ${VENDOR_DIR} 下没有找到任何 vendor-manifest.json`)
    console.error('  vendor 目录应该长这样：vendor/<component>/{VENDORED.md,vendor-manifest.json,...}')
    process.exit(1)
  }

  const selected = filter
    ? manifests.filter(e => e.dirName === filter || e.manifest.name === filter ||
        e.dirName.includes(filter) || String(e.manifest.name ?? '').includes(filter))
    : manifests

  if (!selected.length) {
    console.error(`✗ 没有匹配 "${filter}" 的 vendor 组件`)
    console.error(`  可用：${manifests.map(e => e.dirName).join(', ')}`)
    process.exit(1)
  }

  const results = []
  for (const entry of selected) results.push(await checkOne(entry))

  if (jsonMode) {
    console.log(JSON.stringify({ ok: true, results, skipped }, null, 2))
    return
  }

  // ── 人读输出 ──
  console.log('')
  console.log('vendor 第三方组件版本检查')
  console.log(`包根：${PKG_ROOT}`)
  console.log('')
  const nameW = Math.max(4, ...results.map(r => r.name.length))
  const verW = Math.max(7, ...results.map(r => r.versionLabel.length))
  for (const r of results) {
    const mark = r.status === 'latest' ? '✅ 最新'
      : r.status === 'outdated' ? '⬆️  有新版'
        : r.status === 'failed' ? '⚠️  检查失败'
          : '❔ 未知'
    console.log(`  ${r.name.padEnd(nameW)}  当前 ${r.versionLabel.padEnd(verW)}  ${mark}` +
      (r.latest != null && r.status !== 'latest' ? `（最新 ${r.latest}）` : ''))
    if (r.status === 'outdated') console.log(`      → 更新：${r.upgradeCmd}`)
    if (r.probeFail) console.log(`      → ${r.probeFail}`)
    if (!r.docCheck.ok) console.log(`      ⚠️  ${r.docCheck.reason}`)
  }
  if (skipped.length) {
    console.log('')
    for (const s of skipped) console.log(`  ⚠️  跳过 ${s}（没有可用的 vendor-manifest.json）`)
  }

  const outdated = results.filter(r => r.status === 'outdated')
  const failed = results.filter(r => r.status === 'failed')
  const docBad = results.filter(r => !r.docCheck.ok)
  const allGood = !outdated.length && !failed.length && !docBad.length

  console.log('')
  if (allGood) {
    console.log(`✅ 全部 ${results.length} 个第三方组件都是最新，来源声明完整。`)
  } else {
    if (outdated.length) console.log(`⬆️  ${outdated.length} 个组件有新版本：${outdated.map(r => r.name).join(', ')}`)
    if (failed.length) console.log(`⚠️  ${failed.length} 个组件检查失败（可能网络不可用）：${failed.map(r => r.name).join(', ')}`)
    if (docBad.length) console.log(`⚠️  ${docBad.length} 个组件来源声明和版本不一致：${docBad.map(r => r.name).join(', ')}`)
  }
  console.log('')
}

main().catch(err => {
  // 兜底：任何未预期异常都优雅退出，不甩栈给用户
  console.error(`✗ vendor-check 内部错误：${err?.message ?? err}`)
  process.exit(1)
})
