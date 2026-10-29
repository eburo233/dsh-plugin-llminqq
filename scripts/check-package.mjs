#!/usr/bin/env node
// 插件自检：把「装完才发现坏了」的问题，在提交前/打包前抓出来。
//
// 为什么需要这个脚本（真实教训）：
//   第一次把插件给用户装，结果「装在 Windows 上、装成功了、但重启 dsh 后
//   设置页里什么都没有」。根因是 lib/bridge/index.js import 了 './config.js'，
//   而我把 bridge 复制进插件包时**漏了那个文件** —— 静态 import 失败，
//   整个插件在加载阶段就挂了。
//
//   为什么我本机没发现：我本机是通过符号链接直接把「插件目录」指到源码树的，
//   一旦跑起来就都对了；而用户那边是 pnpm 把文件**复制**进 profile，
//   缺一个文件就是缺一个文件。**软链掩盖了缺文件**。
//
// 这个脚本做的事：
//   ① 找出包里所有相对 import，逐个确认目标文件真实存在（递归）
//   ② 确认 .js 文件里没有「声明了但没 import」的第三方包
//   ③ 确认 package.json 声明的 dependencies 都真的被 import 了（反向检查）
//   ④ 确认 dsh.bundle.patch 指向的文件存在
//   ⑤ 确认 exports 指向的文件都存在
//   ⑥ 确认 client.js 里注册了 settings.section（否则设置页不会出现）
//
// 用法：node scripts/check-package.mjs [包路径]

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG = path.resolve(process.argv[2] || path.join(HERE, '..'))

let fail = 0
let pass = 0
const ok = (m) => { pass++; console.log('  ✓ ' + m) }
const bad = (m, d = '') => { fail++; console.log('  ✗ ' + m + (d ? '\n      ' + d : '')) }


/** 剥掉 JS 注释，避免注释里的示例 import 被当成真 import（脚本自己踩过）。 */
function stripComments (src) {
  // 用状态机而不是正则：正则处理 `//` 出现在字符串里（比如 'http://x'）会误伤。
  let out = ''
  let i = 0
  let mode = 'code' // code | line | block | sq | dq | tpl
  while (i < src.length) {
    const c = src[i]
    const n = src[i + 1]
    if (mode === 'code') {
      if (c === '/' && n === '/') { mode = 'line'; i += 2; continue }
      if (c === '/' && n === '*') { mode = 'block'; i += 2; continue }
      if (c === "'") { mode = 'sq'; out += c; i++; continue }
      if (c === '"') { mode = 'dq'; out += c; i++; continue }
      if (c === '`') { mode = 'tpl'; out += c; i++; continue }
      out += c; i++; continue
    }
    if (mode === 'line') {
      if (c === '\n') { mode = 'code'; out += c }
      i++; continue
    }
    if (mode === 'block') {
      if (c === '*' && n === '/') { mode = 'code'; i += 2; continue }
      if (c === '\n') out += c
      i++; continue
    }
    // 字符串/模板里：处理转义，别把 \' 当结束
    if (c === '\\') { out += c + (n ?? ''); i += 2; continue }
    if (mode === 'sq' && c === "'") mode = 'code'
    else if (mode === 'dq' && c === '"') mode = 'code'
    else if (mode === 'tpl' && c === '`') mode = 'code'
    out += c; i++
  }
  return out
}

function walk (dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      // 跳过 node_modules / 隐藏目录 / scripts / vendor
      //   scripts：自检脚本自己的示例代码会被误判成 import
      //   vendor ：第三方代码，不是我们写的，也不由我们维护依赖声明
      //            （它的 import 是上游的事；我们只负责「原样复制 + 声明来源」。
      //             2026-10-29 实测：加 vendor 后这里报「import 了没声明的第三方包」，
      //             实际是把 storyboard 自己的代码当成我们插件代码了 —— 假阳性）
      if (e.name === 'node_modules' || e.name === 'scripts' || e.name === 'vendor' ||
          e.name.startsWith('.')) continue
      walk(p, out)
    } else if (e.name.endsWith('.js') || e.name.endsWith('.mjs')) {
      out.push(p)
    }
  }
  return out
}

const pkgJsonPath = path.join(PKG, 'package.json')
if (!fs.existsSync(pkgJsonPath)) {
  console.error(`找不到 ${pkgJsonPath}`)
  process.exit(1)
}
const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'))

console.log(`\n检查插件包：${pkg.name}@${pkg.version}`)
console.log(`路径：${PKG}\n`)

// ── ① 相对 import 全部存在（递归）─────────────────────────────────────────────
console.log('=== 1. 相对 import 的目标文件都存在 ===')
{
  const files = walk(PKG)
  if (files.length === 0) bad('包里没有任何 .js 文件')
  const missing = []
  for (const file of files) {
    const src = stripComments(fs.readFileSync(file, 'utf8'))
    const re = /(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g
    let m
    while ((m = re.exec(src))) {
      const target = path.resolve(path.dirname(file), m[1])
      // ESM 要求写扩展名；也容忍省略扩展名的写法
      const candidates = [target, target + '.js', target + '.mjs', path.join(target, 'index.js')]
      if (!candidates.some(c => fs.existsSync(c) && fs.statSync(c).isFile())) {
        missing.push(`${path.relative(PKG, file)} → ${m[1]}`)
      }
    }
  }
  if (missing.length) {
    bad(`有 ${missing.length} 处相对 import 指向不存在的文件`, missing.join('\n      '))
  } else {
    ok(`${files.length} 个文件，相对 import 全部可解析`)
  }
}

// ── ② 第三方 import 必须是 node: 内建 / 包声明过的 ─────────────────────────────
console.log('\n=== 2. 第三方依赖都有声明 ===')
{
  const builtin = /^node:/
  const declared = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ])
  const undeclared = new Set()
  for (const file of walk(PKG)) {
    const src = stripComments(fs.readFileSync(file, 'utf8'))
    // ⚠️ 正则必须锚定「import 语句的形状」，不能裸用 (from|import)。
    // 2026-10-29 实测踩到：原来写的是 /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g，
    // `\s*` 会**跨行**匹配，于是这句普通代码
    //     if (to > from) cliArgs.push('--to', String(to))
    // 命中了它：'from' + ')' + 换行 + 'cliArgs.push(' → 把 "--to" 当成模块名，
    // 报「import 了没声明的第三方包 --to」（假阳性）。
    // 改成要求：
    //   · 静态 import：`import ... from 'x'` 或 `import 'x'`（from 前必须有 import）
    //   · 动态 import：`import('x')`（括号紧贴 import，中间不许换行拼别的词）
    const RES = [
      /\bimport\s*\(\s*['"]([^'"]+)['"]/g,               // import('x')
      /\bimport\s+[^;'"]*?\bfrom\s+['"]([^'"]+)['"]/g,   // import ... from 'x'
      /\bimport\s+['"]([^'"]+)['"]/g,                     // import 'x'（副作用导入）
    ]
    for (const re of RES) {
      re.lastIndex = 0
      let m
      while ((m = re.exec(src))) {
        const spec = m[1]
        if (spec.startsWith('.') || builtin.test(spec)) continue
        // 取包名（scoped 包取前两段）
        const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
        if (!declared.has(name)) undeclared.add(name)
      }
    }
  }
  if (undeclared.size) {
    bad('import 了没声明的第三方包（pnpm 严格模式下会解析失败）',
      [...undeclared].join('\n      '))
  } else {
    ok('没有未声明的第三方 import')
  }
}

// ── ③ 声明的依赖必须真的被用到 ────────────────────────────────────────────────
console.log('\n=== 3. 声明的依赖都被用到了（没用的别声明）===')
{
  const allSrc = walk(PKG).map(f => stripComments(fs.readFileSync(f, 'utf8'))).join('\n')
  const unused = []
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    // 粗判：源码里出现这个包名即视为用到
    if (!allSrc.includes(name)) unused.push(name)
  }
  if (unused.length) {
    bad(`声明了但源码里没用到：${unused.join(', ')}（会让 pnpm 多装一堆东西,还可能引入 peer 警告）`)
  } else {
    ok('没有多余的 dependencies')
  }
  // peerDependencies 尤其危险：声明了但包里没提供，pnpm 会警告且可能挡加载
  const peers = Object.keys(pkg.peerDependencies ?? {})
  if (peers.length) {
    const missingPeers = peers.filter(p => !allSrc.includes(p))
    if (missingPeers.length) {
      bad(`peerDependencies 声明了但没用到：${missingPeers.join(', ')}（会触发 pnpm peer 警告）`)
    } else {
      ok('peerDependencies 都被用到')
    }
  }
}

// ── ④ dsh.bundle.patch 文件存在 ───────────────────────────────────────────────
console.log('\n=== 4. dsh.bundle 声明指向的文件存在 ===')
{
  const bundle = pkg.dsh?.bundle
  if (!bundle) {
    bad('package.json 没有 dsh.bundle —— 装进 profile 后不会成为 profile layer（插件不会加载）')
  } else {
    const patches = typeof bundle.patch === 'string' ? [bundle.patch] : bundle.patch
    if (!Array.isArray(patches) || patches.length === 0) {
      bad('dsh.bundle.patch 不是路径或路径数组')
    } else {
      const miss = patches.filter(p => !fs.existsSync(path.join(PKG, p)))
      if (miss.length) bad('dsh.bundle.patch 指向的文件不存在', miss.join(', '))
      else ok(`dsh.bundle.patch 存在：${patches.join(', ')}`)
    }
  }
}

// ── ⑤ exports 指向的文件存在 ─────────────────────────────────────────────────
console.log('\n=== 5. exports 指向的文件存在 ===')
{
  const ex = pkg.exports ?? {}
  const miss = []
  for (const [key, val] of Object.entries(ex)) {
    const target = typeof val === 'string' ? val : val?.default
    if (typeof target !== 'string' || !target.startsWith('./')) continue
    if (!fs.existsSync(path.join(PKG, target))) miss.push(`${key} → ${target}`)
  }
  if (miss.length) bad('exports 指向不存在的文件', miss.join('\n      '))
  else ok('exports 全部可解析')
}

// ── ⑥ files 清单不会裁掉运行时需要的文件 ─────────────────────────────────────
console.log('\n=== 6. files 白名单不会裁掉运行时文件 ===')
{
  const files = pkg.files
  if (!Array.isArray(files)) {
    ok('没有 files 白名单（全部文件都会发布）')
  } else {
    const need = ['lib', 'client.js', 'cordis.patch.yml']
    const absFiles = files.map(f => f.replace(/^\.\//, ''))
    const cut = need.filter(n => !absFiles.some(f => f === n || f.startsWith(n + '/')))
    if (cut.length) bad('files 白名单漏了运行时需要的东西', cut.join(', '))
    else ok('files 白名单覆盖了 lib / client.js / cordis.patch.yml')
  }
}

// ── ⑦ client.js 真的注册了设置分区 ───────────────────────────────────────────
console.log('\n=== 7. 设置页（client bundle）注册了 settings.section ===')
{
  const clientRel = typeof pkg.exports?.['./client'] === 'string'
    ? pkg.exports['./client']
    : (pkg.exports?.['./client']?.default)
  if (!clientRel) {
    bad('exports 里没有 ./client —— 不会有设置页')
  } else if (!fs.existsSync(path.join(PKG, clientRel))) {
    bad(`client 文件不存在：${clientRel}`)
  } else {
    const src = fs.readFileSync(path.join(PKG, clientRel), 'utf8')
    if (!src.includes('settings.section')) bad('client bundle 里没有 settings.section 注册（设置页不会出现）')
    else ok(`client bundle 注册了 settings.section（${clientRel}）`)
    if (!pkg.dsh?.client) bad('package.json 缺 dsh.client 声明（client bundle 不会被加载）')
    else ok('package.json 有 dsh.client 声明')
  }
}

// ── 汇总 ─────────────────────────────────────────────────────────────────────
console.log(`\n${'='.repeat(46)}`)
if (fail) {
  console.log(`  ✗ ${fail} 项失败 / ${pass} 项通过`)
  console.log('='.repeat(46) + '\n')
  process.exit(1)
}
console.log(`  ✓ 全部通过（${pass} 项）`)
console.log('='.repeat(46) + '\n')
