#!/usr/bin/env node
/**
 * 把工作区的插件同步到「桌面版真正加载的那份」。
 *
 * 为什么需要它：桌面版从 profile 的 node_modules 里加载插件，而那是**真实拷贝**
 * （不是软链）。改了工作区没同步 → 用户看到的行为完全没变，却以为「改了没用」。
 * 今天已经因为这件事白排查过两轮（client.js 修好了、运行的还是旧的）。
 *
 * 做四件事：
 *   1. 逐文件比对，只拷不一致的（不整目录 rm -rf，避免把 node_modules 里的依赖链搞坏）
 *   2. 每个 .js/.mjs 拷完跑一次 `node --check`（语法错误在桌面上表现为「web boot 失败」，
 *      而不是一条清楚的报错 —— 必须在同步阶段就拦下）
 *   3. 再比一次 md5，输出最终一致性结论
 *   4. 提醒「桥/宿主是否需要重启」，但**不替你重启**（重启会话会把人踢掉）
 *
 * 用法：
 *   node scripts/sync-install.mjs                 # 自动找安装目录
 *   node scripts/sync-install.mjs --dest <dir>    # 指定
 *   node scripts/sync-install.mjs --dry-run       # 只看差异
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(HERE, '..')

const argv = process.argv.slice(2)
const argOf = name => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : ''
}
const DRY = argv.includes('--dry-run')

/** 安装副本的候选位置：跟着 DSH_HOME 走，实在找不到再扫已知布局。 */
function findDest () {
  const explicit = argOf('--dest') || process.env.LLMINQQ_INSTALL_DIR
  if (explicit) return explicit
  const roots = [process.env.DSH_HOME, path.join(os.homedir(), '.dsh'), 'D:/dsh-home', 'C:/dsh-home']
    .filter(Boolean)
  const candidates = []
  for (const root of roots) {
    for (const profile of ['desktop', 'acp']) {
      candidates.push(path.join(root, 'profiles', profile, 'node_modules', 'dsh-plugin-llminqq'))
    }
  }
  return candidates.find(p => fs.existsSync(p)) || ''
}

const DEST = findDest()
if (!DEST) {
  console.error('✗ 找不到安装副本。用 --dest <dir> 指定（一般是 <DSH_HOME>/profiles/desktop/node_modules/dsh-plugin-llminqq）')
  process.exit(2)
}

// 这些不进安装副本：node_modules 是依赖（安装目录自己装）、.git 是版本库、
// 日志和预览产物跟运行无关
const SKIP_DIRS = new Set(['node_modules', '.git', '.preview', 'logs', 'dist', '.cache', '__pycache__', '.vendor-backup'])
const SKIP_FILES = [/\.log$/i, /^\.DS_Store$/, /\.pyc$/i]

function walk (dir, base = dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name)
    const rel = path.relative(base, full)
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue
      walk(full, base, out)
    } else if (ent.isFile()) {
      if (SKIP_FILES.some(re => re.test(ent.name))) continue
      out.push(rel)
    }
  }
  return out
}

const md5 = p => crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex')

const files = walk(SRC)
const changed = []
const missing = []
for (const rel of files) {
  const a = path.join(SRC, rel)
  const b = path.join(DEST, rel)
  if (!fs.existsSync(b)) missing.push(rel)
  else if (md5(a) !== md5(b)) changed.push(rel)
}

console.log(`源：      ${SRC}`)
console.log(`目标：    ${DEST}`)
console.log(`文件数：  ${files.length}（新增 ${missing.length}，改动 ${changed.length}）`)
for (const f of [...missing.map(f => `+ ${f}`), ...changed.map(f => `~ ${f}`)]) console.log('  ' + f)

if (DRY) {
  console.log('\n--dry-run：没有写入。')
  process.exit(0)
}
if (!missing.length && !changed.length) {
  console.log('\n✓ 已经一致，不需要同步。')
  process.exit(0)
}

for (const rel of [...missing, ...changed]) {
  const to = path.join(DEST, rel)
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.copyFileSync(path.join(SRC, rel), to)
}

// 语法检查：只查拷贝过去的脚本（.json 之类不用）
const scripts = [...missing, ...changed].filter(f => /\.(m?js)$/i.test(f))
const bad = []
for (const rel of scripts) {
  try {
    execFileSync(process.execPath, ['--check', path.join(DEST, rel)], { stdio: 'pipe' })
  } catch (err) {
    bad.push(`${rel}: ${String(err.stderr || err.message).split('\n').slice(0, 3).join(' | ')}`)
  }
}
if (bad.length) {
  console.error('\n✗ 语法检查没过（桌面上这会变成「web boot 失败」，先修再重启）：')
  for (const b of bad) console.error('  ' + b)
  process.exit(1)
}

// 终检：再比一次
const still = files.filter(rel => md5(path.join(SRC, rel)) !== md5(path.join(DEST, rel)))
if (still.length) {
  console.error('\n✗ 同步后仍不一致：' + still.join(', '))
  process.exit(1)
}

console.log(`\n✓ 已同步 ${missing.length + changed.length} 个文件，语法检查通过，md5 全部一致。`)
console.log('  提醒：client.js 刷新设置页即可；lib/**（宿主侧）要完全退出并重开 DSH；')
console.log('        lib/bridge/**（桥侧）要重启桥才生效 —— 这次没有替你重启。')
