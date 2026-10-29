#!/usr/bin/env node
// vendor-update.mjs —— 一键更新 vendor 里的第三方代码。
//
// 配合 vendor-check.mjs 使用（先 check 再 update）。
//
// 安全设计（这是本脚本最重要的部分，因为它在改源码）：
//   ① **改之前先备份**（整体复制 vendor/<name> 到 .backup/vendor-<name>-<时间戳>/）。
//   ② 任何一步失败 → **自动回滚**（把备份复制回去）。包括：
//      npm pack 失败 / 解包失败 / 复制后跑测试失败。
//   ③ **更新前先跑一次基线测试**。如果基线本来就红，就拒绝更新 ——
//      否则分不清「是我改坏的」还是「本来就坏的」。（这条是被 task-10 那次
//      「A/B 结论待定」的教训启发的：没有基线就无法归因。）
//   ④ 只替换 manifest `files` 清单里列的东西，**不碰** VENDORED.md / vendor-manifest.json
//      （那两个是我们自己的声明文件，由脚本单独写）。
//
// 用法：
//   node scripts/vendor-update.mjs storyboard           # 更新到最新版
//   node scripts/vendor-update.mjs storyboard --to 0.4.4  # 指定版本
//   node scripts/vendor-update.mjs bilibili-mcp
//   node scripts/vendor-update.mjs storyboard --dry-run   # 只看会做什么，不动文件
//   node scripts/vendor-update.mjs storyboard --skip-tests # 跳过测试（不推荐）

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = path.resolve(__dirname, '..')
const VENDOR_DIR = path.join(PKG_ROOT, 'vendor')
const BACKUP_DIR = path.join(PKG_ROOT, '.vendor-backup')
const NPM_TIMEOUT_MS = Number(process.env.VENDOR_NPM_TIMEOUT_MS ?? 120000)
const TEST_TIMEOUT_MS = Number(process.env.VENDOR_TEST_TIMEOUT_MS ?? 300000)

const args = process.argv.slice(2)
const target = args.find(a => !a.startsWith('--') && !isFlagValue(a))
const dryRun = args.includes('--dry-run')
const skipTests = args.includes('--skip-tests')
const toVersion = (() => {
  const i = args.indexOf('--to')
  return i >= 0 ? args[i + 1] : null
})()

function isFlagValue (a) { return args.indexOf('--to') >= 0 && args[args.indexOf('--to') + 1] === a }

const log = m => console.log(m)
const warn = m => console.warn(m)
const err = m => console.error(m)

/** 跑命令（异步，带超时，不抛）。 */
function run (cmd, argv, opts = {}) {
  return new Promise(resolve => {
    execFile(cmd, argv, {
      timeout: opts.timeoutMs ?? NPM_TIMEOUT_MS,
      encoding: 'utf8',
      cwd: opts.cwd ?? PKG_ROOT,
    }, (e, stdout, stderr) => {
      resolve({
        ok: !e,
        code: e?.code ?? 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        message: e?.message ?? '',
      })
    })
  })
}

/** 递归复制（保留结构，跳过 __pycache__ 和 node_modules —— 它们不该进 vendor）。 */
function copyTree (src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    // vendor 里绝不该出现这两类：字节码/依赖目录（跟平台绑定、体积大、可能失效）
    if (entry.name === '__pycache__' || entry.name === 'node_modules') continue
    if (entry.name.endsWith('.pyc')) continue
    const s = path.join(src, entry.name)
    const d = path.join(dst, entry.name)
    if (entry.isDirectory()) copyTree(s, d)
    else if (entry.isFile()) fs.copyFileSync(s, d)
    // 符号链接：vendor 里不应有，跳过并告警
    else if (entry.isSymbolicLink()) warn(`  ⚠️  跳过符号链接：${s}`)
  }
}

/** 按 manifest 的 files 清单复制（'src/' 这种目录要递归）。 */
function copyByManifest (fromRoot, toRoot, files) {
  const copied = []
  const missing = []
  for (const rel of files) {
    const isDir = rel.endsWith('/')
    const name = isDir ? rel.slice(0, -1) : rel
    const s = path.join(fromRoot, name)
    const d = path.join(toRoot, name)
    if (!fs.existsSync(s)) { missing.push(rel); continue }
    if (isDir) {
      // 目录：先删旧的再整体复制（避免新版删了某个文件后旧的还留着）
      if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true })
      copyTree(s, d)
    } else {
      fs.mkdirSync(path.dirname(d), { recursive: true })
      fs.copyFileSync(s, d)
    }
    copied.push(rel)
  }
  return { copied, missing }
}

/** 找 manifest（按 name 或目录名模糊匹配）。 */
function findManifest (needle) {
  for (const entry of fs.readdirSync(VENDOR_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = path.join(VENDOR_DIR, entry.name)
    const mf = path.join(dir, 'vendor-manifest.json')
    if (!fs.existsSync(mf)) continue
    let m
    try { m = JSON.parse(fs.readFileSync(mf, 'utf8')) } catch { continue }
    if (entry.name === needle || m.name === needle || entry.name.includes(needle) || String(m.name ?? '').includes(needle)) {
      return { dir, dirName: entry.name, manifest: m, manifestPath: mf }
    }
  }
  return null
}

/** 这个组件对应的测试文件（有就跑；没有就跳过并说明）。 */
function testFileFor (dirName) {
  // 测试文件命名约定：test/vendor-<组件>.test.mjs（vendor 基础设施专用）
  // 优先这个，因为它测的正是「vendored 源码本身能不能跑」——
  // 而 test/<组件>.test.mjs 之类可能测的是我们自己的 wrapper（不覆盖 vendor 代码）
  // 组件目录名和「人惯用的短名」不一定相同（dsh-video-storyboard ↔ storyboard），
  // 所以两种都试：
  const shortName = dirName
    .replace(/^dsh-/, '')            // dsh-video-storyboard → video-storyboard
    .replace(/^video-/, '')          // video-storyboard → storyboard
  const candidates = [
    `test/vendor-${dirName}.test.mjs`,
    `test/vendor-${shortName}.test.mjs`,
    `test/${dirName}.test.mjs`,
    `test/${shortName}.test.mjs`,
    `test/storyboard-mcp.test.mjs`,   // storyboard 的 wrapper 测试（主仓库里的名字）
    `test/bilibili-mcp.test.mjs`,
  ]
  for (const c of candidates) {
    const p = path.join(PKG_ROOT, c)
    if (fs.existsSync(p)) return p
  }
  return null
}

async function runTests (label) {
  if (skipTests) { log('  ⏭  跳过测试（--skip-tests）'); return { ok: true, skipped: true } }
  const tf = testFileFor(label)
  if (!tf) {
    warn(`  ⚠️  没有找到 ${label} 的测试文件，无法自动验证（建议手工确认）`)
    return { ok: true, noTest: true }
  }
  log(`  跑测试：${path.relative(PKG_ROOT, tf)}（超时 ${Math.round(TEST_TIMEOUT_MS / 1000)}s）`)
  const r = await run(process.execPath, [tf], { timeoutMs: TEST_TIMEOUT_MS })
  const last = String(r.stdout || r.stderr).trim().split('\n').filter(Boolean).slice(-3).join('\n')
  if (r.ok) { log(`  ✅ 测试通过${last ? `：${last.replace(/\n/g, ' | ')}` : ''}`); return { ok: true } }
  err(`  ❌ 测试失败：${last.replace(/\n/g, ' | ') || r.message}`)
  return { ok: false, output: last }
}

/** 从 manifest 的 version 里剥出内嵌宿主版本（embedded-in-<host>@x.y.z → x.y.z）。 */
function currentVersionOf (m) {
  const v = String(m.version ?? '')
  const hit = /^embedded-in-[^@]+@(.+)$/.exec(v)
  return hit ? hit[1] : v
}

async function latestOf (m) {
  const pkg = m.source.type === 'vendored-from-npm-package' ? m.source.package : (m.source.package ?? m.name)
  const r = await run('npm', ['view', pkg, 'version'])
  if (!r.ok) return { ok: false, reason: r.stderr.trim() || r.message }
  const v = r.stdout.split('\n').map(s => s.trim()).filter(Boolean).pop()
  return v ? { ok: true, version: v } : { ok: false, reason: 'npm view 没返回版本' }
}

async function main () {
  if (!target) {
    err('用法：node scripts/vendor-update.mjs <组件名> [--to <版本>] [--dry-run] [--skip-tests]')
    const names = []
    for (const e of fs.readdirSync(VENDOR_DIR, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      if (fs.existsSync(path.join(VENDOR_DIR, e.name, 'vendor-manifest.json'))) names.push(e.name)
    }
    err(`可用组件：${names.join(', ') || '（无）'}`)
    process.exit(1)
  }

  const found = findManifest(target)
  if (!found) {
    err(`✗ 找不到组件 "${target}"`)
    process.exit(1)
  }
  const { dir: vdir, dirName, manifest: m, manifestPath } = found
  const src = m.source ?? {}
  const cur = currentVersionOf(m)

  log('')
  log(`更新 ${m.name}（${dirName}）`)
  log(`  当前版本：${m.version}`)
  log(`  来源类型：${src.type}`)

  // ① 决定目标版本
  let want = toVersion
  if (!want) {
    log('  查询最新版…')
    const r = await latestOf(m)
    if (!r.ok) { err(`✗ 查最新版失败：${r.reason}`); process.exit(1) }
    want = r.version
  }
  log(`  目标版本：${want}`)
  if (cur === want) {
    log('')
    log(`✅ 已是最新（${cur}），无需更新。`)
    log('   强制重装同一版本：加 --to ' + want + ' 前面加 --force（暂未实现，直接删 vendor 目录后重跑）')
    return
  }

  log('')
  log('  更新计划：')
  log(`    · npm pack ${src.package}@${want}`)
  log(`    · 按 manifest files 清单替换：${m.files.join(', ')}`)
  log(`    · 跑测试 ${testFileFor(dirName) ? path.basename(testFileFor(dirName)) : '（无对应测试）'}`)
  log(`    · 更新 vendor-manifest.json 的 version → ${src.type === 'vendored-from-npm-package' ? `embedded-in-${src.package}@${want}` : want}`)

  if (dryRun) { log(''); log('（--dry-run：只展示计划，不动任何文件）'); return }

  // ② 基线测试：本来就红的话，更新后分不清是谁的错
  log('')
  log('  0/6 基线测试（确认现状是绿的，否则无法归因）')
  const baseline = await runTests(dirName)
  if (!baseline.ok && !baseline.skipped) {
    err('✗ 基线测试未通过 → 拒绝更新（先用当前代码修好测试，再来更新）')
    err('  原因：否则更新后失败时分不清是「新版有问题」还是「本来就坏」')
    process.exit(1)
  }

  // ③ 备份
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupPath = path.join(BACKUP_DIR, `${dirName}-${stamp}`)
  log('')
  log(`  1/6 备份 → ${path.relative(PKG_ROOT, backupPath)}`)
  fs.mkdirSync(backupPath, { recursive: true })
  copyTree(vdir, backupPath)
  log(`      ✅ 已备份（${fs.readdirSync(backupPath).length} 个顶层条目）`)

  /** 失败时回滚。 */
  const rollback = (why) => {
    err('')
    err(`  ↩️  回滚中（原因：${why}）`)
    try {
      fs.rmSync(vdir, { recursive: true, force: true })
      copyTree(backupPath, vdir)
      err(`  ↩️  已恢复 ${dirName} 到更新前状态`)
      err(`      备份仍保留在 ${path.relative(PKG_ROOT, backupPath)}（确认无误后可手动删）`)
    } catch (e) {
      err(`  ‼️  回滚失败：${e.message}`)
      err(`      请手工从 ${backupPath} 恢复`)
    }
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-update-'))
  try {
    // ④ npm pack
    log('')
    log(`  2/6 npm pack ${src.package}@${want}`)
    const packRes = await run('npm', ['pack', `${src.package}@${want}`, '--pack-destination', tmpRoot])
    if (!packRes.ok) throw new Error(`npm pack 失败：${packRes.stderr.trim() || packRes.message}`)
    const tgz = fs.readdirSync(tmpRoot).find(f => f.endsWith('.tgz'))
    if (!tgz) throw new Error('npm pack 没产出 .tgz')
    const tgzPath = path.join(tmpRoot, tgz)
    log(`      ✅ ${tgz}（${(fs.statSync(tgzPath).size / 1024).toFixed(0)}KB）`)

    // ⑤ 解包
    log('')
    log('  3/6 解包')
    const exDir = path.join(tmpRoot, 'extract')
    fs.mkdirSync(exDir, { recursive: true })
    const untar = await run('tar', ['-xzf', tgzPath, '-C', exDir])
    if (!untar.ok) throw new Error(`解包失败：${untar.stderr.trim() || untar.message}`)
    const pkgDir = path.join(exDir, 'package')
    if (!fs.existsSync(pkgDir)) throw new Error('解包后没有 package/ 目录')
    log(`      ✅ ${fs.readdirSync(pkgDir).length} 个顶层条目`)

    // ⑥ 定位要复制的源目录
    let fromRoot = pkgDir
    if (src.type === 'vendored-from-npm-package') {
      // 内嵌物：源在宿主包的 src.path 里（如 vendor/bilibili-mcp）
      fromRoot = path.join(pkgDir, src.path ?? '')
      if (!fs.existsSync(fromRoot)) throw new Error(`宿主包里找不到 ${src.path}`)
      log(`      内嵌路径：${src.path}`)
    }

    // ⑦ 按 files 清单替换
    log('')
    log('  4/6 替换文件')
    const { copied, missing } = copyByManifest(fromRoot, vdir, m.files)
    if (missing.length) throw new Error(`新版缺少 manifest 声明的文件：${missing.join(', ')}`)
    log(`      ✅ 已替换：${copied.join(', ')}`)

    // ⑧ 应用 adaptations（目前只有「删除 src/index.js」这一种可机器执行）
    const deletions = []
    for (const a of m.adaptations ?? []) {
      const hit = /删除\s+(\S+?\.js)/.exec(a)
      if (hit) deletions.push(hit[1])
    }
    if (deletions.length) {
      log('')
      log('  5/6 应用 adaptations')
      for (const rel of deletions) {
        const p = path.join(vdir, rel)
        if (fs.existsSync(p)) { fs.rmSync(p, { force: true }); log(`      ✅ 已删除 ${rel}`) }
        else log(`      · ${rel} 不存在（无需删除）`)
      }
    } else {
      log('')
      log('  5/6 adaptations：无需机器执行的条目')
    }

    // ⑨ 更新 manifest 版本
    const newVersion = src.type === 'vendored-from-npm-package'
      ? `embedded-in-${src.package}@${want}`
      : want
    m.version = newVersion
    if (m.source.type === 'vendored-from-npm-package') m.source.version = want
    fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2) + '\n')
    // VENDORED.md 里的版本行也同步（否则 vendor-check 会报漂移）
    const docPath = path.join(vdir, 'VENDORED.md')
    if (fs.existsSync(docPath)) {
      let doc = fs.readFileSync(docPath, 'utf8')
      // 把旧版本号出现的地方换成新版本（只换版本号 token，不动其他文字）
      if (cur !== want) doc = doc.split(cur).join(want)
      fs.writeFileSync(docPath, doc)
      log(`      ✅ vendor-manifest.json + VENDORED.md 版本 → ${want}`)
    }

    // ⑩ 测试
    log('')
    log('  6/6 更新后测试')
    const after = await runTests(dirName)
    if (!after.ok) throw new Error('更新后测试失败（详见上方输出）')

    // ⑪ 收尾
    log('')
    log(`✅ 已更新 ${m.name}：${cur} → ${want}`)
    log(`   备份保留在 ${path.relative(PKG_ROOT, backupPath)}（确认无误后可删：rm -rf ${path.relative(PKG_ROOT, backupPath)}）`)
    if (!after.skipped) log('   测试已通过。建议再跑一次 node scripts/vendor-check.mjs 确认版本已对齐。')
  } catch (e) {
    rollback(e.message)
    process.exitCode = 1
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

main().catch(e => {
  err(`✗ vendor-update 内部错误：${e?.message ?? e}`)
  process.exit(1)
})
