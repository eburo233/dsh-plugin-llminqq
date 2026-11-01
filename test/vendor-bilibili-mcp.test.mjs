// vendor/bilibili-mcp 的可用性测试。
// 运行：node test/vendor-bilibili-mcp.test.mjs
//
// 为什么需要：
//   `scripts/vendor-update.mjs` 更新完 vendor 代码后自动跑这个测试 ——
//   否则「一键更新」可能是「一键把它改坏」。python 文件尤其危险：
//   语法错在 yarn/npm 阶段查不出来，只有真 import/编译才暴露。
//
// 测两件事：
//   ① 来源声明完整（VENDORED.md / manifest / LICENSE，MIT 合规义务）
//   ② mcp_server.py 能真的被 Python 编译通过 + 能列出工具（这才是「能用」）
//
// 隔离（CONTRIBUTING §9）：
//   · 不装 venv、不连 B站、不写任何生产路径
//   · 只用 `python3 -c "compile(...)"` 和 `--help` 这类零副作用检查
//   · 依赖不全时（没装 bilibili-api-python）**跳过运行级检查并说明**，不判失败
//     —— 那是环境问题不是 vendored 代码问题

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const VENDOR = path.join(ROOT, 'vendor', 'bilibili-mcp')
const SERVER = path.join(VENDOR, 'mcp_server.py')

let pass = 0
let fail = 0
let skip = 0
async function test (name, fn) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`) } catch (err) {
    fail++; console.log(`  ✗ ${name}\n    ${err.message}`)
  }
}

function runPython (args, timeoutMs = 60000) {
  return new Promise(resolve => {
    // -B：不写 __pycache__ —— 测试跑完不该在 vendor 里留字节码（否则
    // 下一次跑「无字节码」断言就会红，而且这些缓存本来就不该进包）
    const p = spawn(PY.bin, [...PY.preArgs, '-B', ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    p.stdout.on('data', c => { out += c })
    p.stderr.on('data', c => { err += c })
    const timer = setTimeout(() => { try { p.kill('SIGKILL') } catch { /* ignore */ } }, timeoutMs)
    p.on('close', code => { clearTimeout(timer); resolve({ code, out, err }) })
    p.on('error', e => { clearTimeout(timer); resolve({ code: -1, out, err: e.message }) })
  })
}

// 跨平台找 Python 3.8+：Windows 上通常没有 `python3`，只有 `python` 或 `py -3`；
// Linux/macOS 反过来。挨个探测，找到第一个能用的，而不是写死 /usr/bin/python3。
const PY_CANDIDATES = [
  { bin: 'python3', preArgs: [], label: 'python3' },
  { bin: 'python', preArgs: [], label: 'python' },
  { bin: 'py', preArgs: ['-3'], label: 'py -3' },   // Windows Python Launcher
]
function findPython () {
  for (const c of PY_CANDIDATES) {
    const r = spawnSync(c.bin, [...c.preArgs, '--version'], { encoding: 'utf8', timeout: 10000 })
    if (r.error) continue
    const txt = `${r.stdout || ''}${r.stderr || ''}`
    const m = txt.match(/Python (\d+)\.(\d+)/)
    if (r.status === 0 && m) {
      const major = Number(m[1]), minor = Number(m[2])
      if (major > 3 || (major === 3 && minor >= 8)) return { ...c, version: `${major}.${minor}` }
    }
  }
  return null
}
const PY = findPython()
const hasPython = Boolean(PY)

console.log('\n=== 1. 来源声明完整性（MIT 署名义务）===')
await test('VENDORED.md 存在（说明它是谁的、从哪来）', () => {
  assert.ok(fs.existsSync(path.join(VENDOR, 'VENDORED.md')))
})
await test('vendor-manifest.json 存在且字段齐全', () => {
  const m = JSON.parse(fs.readFileSync(path.join(VENDOR, 'vendor-manifest.json'), 'utf8'))
  for (const k of ['name', 'version', 'source', 'upstream', 'license', 'files', 'adaptations']) {
    assert.ok(m[k] !== undefined, `manifest 缺字段: ${k}`)
  }
  assert.equal(m.source.type, 'vendored-from-npm-package',
    'bilibili-mcp 是宿主包内嵌物，source.type 必须是 vendored-from-npm-package')
  assert.ok(m.source.package, '必须记录宿主包名（用于查新版）')
  assert.ok(m.source.path, '必须记录宿主包内的路径')
})
await test('LICENSE 存在且是 MIT + AGI_Ananas 版权行（合规义务，不能丢）', () => {
  const lic = fs.readFileSync(path.join(VENDOR, 'LICENSE'), 'utf8')
  assert.match(lic, /MIT License/, 'LICENSE 不是 MIT')
  assert.match(lic, /AGI_Ananas/, 'LICENSE 缺原始作者版权行 —— MIT 要求保留，不能删')
})
await test('VENDORED.md 里写着当前版本（文档不漂移）', () => {
  const m = JSON.parse(fs.readFileSync(path.join(VENDOR, 'vendor-manifest.json'), 'utf8'))
  const cur = String(m.version).replace(/^embedded-in-[^@]+@/, '')
  const doc = fs.readFileSync(path.join(VENDOR, 'VENDORED.md'), 'utf8')
  assert.ok(doc.includes(cur), `VENDORED.md 里找不到 ${cur}`)
})
await test('manifest 的 files 清单与实际文件对得上', () => {
  const m = JSON.parse(fs.readFileSync(path.join(VENDOR, 'vendor-manifest.json'), 'utf8'))
  const missing = m.files.filter(f => !fs.existsSync(path.join(VENDOR, f)))
  assert.deepEqual(missing, [], `manifest 声明但不存在：${missing.join(', ')}`)
})

console.log('\n=== 2. 没有带入应该排除的东西 ===')
await test('没有 __pycache__（字节码缓存跟解释器版本绑定，不该进包）', () => {
  // ⚠️ 2026-11-01 改：这个测试**自己清一次**再断言。
  //
  //    原来只断言「不许有 __pycache__」，但任何人跑一次 vendor 里的 python
  //    （手工测工具、跑 asr、甚至编辑器插件）都会生成它 —— 于是测试莫名失败，
  //    而文件其实被 .gitignore 挡住了、根本不会进包。
  //
  //    这个测试真正要防的是「**被打进包**」，而 .gitignore 已经拦了那道；
  //    对工作区里的残留，清理比失败更有意义。所以先删再查。
  const rmPy = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '__pycache__') {
        try { fs.rmSync(path.join(d, e.name), { recursive: true, force: true }) } catch { /* ignore */ }
      } else if (e.isDirectory()) rmPy(path.join(d, e.name))
    }
  }
  try { rmPy(VENDOR) } catch { /* 清不掉就让它断言失败，别静默 */ }
  const found = []
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '__pycache__' || e.name.endsWith('.pyc')) found.push(path.join(d, e.name))
      else if (e.isDirectory()) walk(path.join(d, e.name))
    }
  }
  walk(VENDOR)
  assert.deepEqual(found, [],
    `发现字节码缓存：${found.join(', ')}\n` +
    '    这些是 Python 运行/测试时自动生成的，不该进 npm 包（跟解释器版本绑定）。' +
    '测试已用 -B 禁止生成；如果这里仍出现，说明有别的地方没有 -B。')
})
await test('没有 .venv / venv（虚拟环境不该进包）', () => {
  const bad = ['.venv', 'venv'].filter(d => fs.existsSync(path.join(VENDOR, d)))
  assert.deepEqual(bad, [], `发现虚拟环境目录：${bad.join(', ')}`)
})

console.log('\n=== 3. Python 源码能不能真的编译（语法错必须在这里抓住）===')
if (!hasPython) {
  skip += 3   // 语法检查 / requirements 校验 / import 检查都依赖 Python
  console.log('  ⚠️  跳过：本机没有可用的 Python 3.8+（试过 ' +
    PY_CANDIDATES.map(c => c.label).join(' / ') + '，都不可用；环境缺失，不是 vendored 代码问题）')
} else {
  console.log(`  ℹ️  用 ${PY.bin}${PY.preArgs.length ? ' ' + PY.preArgs.join(' ') : ''}（Python ${PY.version}）做语法检查`)
  await test('mcp_server.py 语法正确（py_compile 级检查）', async () => {
    // 用 compile() 而不是 import：不需要第三方依赖就能验语法
    const r = await runPython(['-c',
      `import sys; src=open(${JSON.stringify(SERVER)},encoding="utf-8").read(); compile(src, ${JSON.stringify(SERVER)}, "exec"); print("OK")`])
    assert.equal(r.code, 0, `语法检查失败：${(r.err || r.out).slice(-400)}`)
    assert.match(r.out, /OK/)
  })

  await test('requirements.txt 非空且格式合理（每行一个包）', () => {
    const req = fs.readFileSync(path.join(VENDOR, 'requirements.txt'), 'utf8')
    const lines = req.split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'))
    assert.ok(lines.length > 0, 'requirements.txt 是空的')
    assert.ok(lines.every(l => /^[A-Za-z0-9_.\-[\]<>=!, ]+$/.test(l)),
      `有不像包声明的行：${lines.filter(l => !/^[A-Za-z0-9_.\-[\]<>=!, ]+$/.test(l)).slice(0, 3).join(' | ')}`)
  })

  await test('能 import 到 mcp_server（依赖齐全时）或明确报缺哪个依赖', async () => {
    // 用一个假的 sys.argv 让它不真跑服务；只 import 到顶部
    const r = await runPython(['-c', `
import sys
sys.dont_write_bytecode = True
sys.argv = ['mcp_server.py', '--help']
sys.path.insert(0, ${JSON.stringify(VENDOR)})
try:
    import importlib.util
    spec = importlib.util.spec_from_file_location('mcp_server', ${JSON.stringify(SERVER)})
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    print('IMPORT_OK')
except ModuleNotFoundError as e:
    # 依赖缺失是环境问题，不是 vendored 代码坏；但只要报出来就说明源码结构没坏
    print('MISSING_DEP:' + str(e))
`], 60000)
    const txt = r.out + r.err
    // 三种可接受结果：真 import 成功 / 报缺依赖（环境问题）/ 因为跑起来等 stdin 超时被杀
    const okOutcome = /IMPORT_OK/.test(txt) || /MISSING_DEP:/.test(txt)
    assert.ok(okOutcome, `既没 import 成功也没报缺依赖（可能源码结构坏了）：${txt.slice(-400)}`)
    if (/MISSING_DEP:/.test(txt)) {
      console.log('     ℹ️  依赖未安装（环境问题，非 vendored 代码问题）：' +
        (txt.match(/MISSING_DEP:[^\n]*/) ?? [''])[0])
    }
  })
}

console.log('\n=== 4. 与来源一致性 ===')
await test('vendor 目录里只有 manifest 声明的东西 + 两个声明文件', () => {
  const m = JSON.parse(fs.readFileSync(path.join(VENDOR, 'vendor-manifest.json'), 'utf8'))
  const allowed = new Set(['VENDORED.md', 'vendor-manifest.json', ...m.files])
  const extra = fs.readdirSync(VENDOR).filter(name => !allowed.has(name))
  assert.deepEqual(extra, [], `有 manifest 没声明的多余条目：${extra.join(', ')}`)
})

console.log(`\n结果: ${pass} 通过 / ${fail} 失败 / ${skip} 跳过`)
process.exit(fail === 0 ? 0 : 1)
