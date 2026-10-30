// vendor/dsh-video-storyboard 的可用性测试（真起 CLI，真出宫格图）。
// 运行：node test/vendor-storyboard.test.mjs
//
// 为什么需要这个测试：
//   `scripts/vendor-update.mjs` 更新完 vendor 代码后会**自动跑对应测试**，
//   否则「一键更新」等于「一键把它改坏」。这个测试就是那个安全网。
//
// 测的是**vendored 源码本身能不能跑**，不是我们的 wrapper：
//   · 直接 `node vendor/dsh-video-storyboard/bin/storyboard.mjs`
//   · 不经过 MCP、不连 QQ、不连 LLM
//
// 隔离（CONTRIBUTING §9）：测试视频用 ffmpeg 现做在 /tmp，产物也写 /tmp，
// 不碰生产 .qq-media、不读写生产 state.json。
//
// 另一个职责：**校验 vendor 目录与 manifest 声明一致**
//   （版本号、files 清单、被删的 src/index.js 确实不在、没有 __pycache__）。

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const VENDOR = path.join(ROOT, 'vendor', 'dsh-video-storyboard')
const CLI = path.join(VENDOR, 'bin', 'storyboard.mjs')

let pass = 0
let fail = 0
let skip = 0
async function test (name, fn) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`) } catch (err) {
    fail++; console.log(`  ✗ ${name}\n    ${err.message}`)
  }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-sb-test-'))
const CLIP = path.join(TMP, 'clip.mp4')
const CLIP_SECONDS = 6

function hasFfmpeg () {
  // 跨平台探测：不假设 /usr/bin/ffmpeg（Windows 上没有这个路径）。
  // spawnSync 找不到命令时 error=ENOENT、没有异常，比 spawn+error 监听靠谱。
  const r = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 10000 })
  return !r.error && r.status === 0
}

async function makeClip () {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', [
      '-f', 'lavfi', '-i', `testsrc2=size=320x240:rate=25:duration=${CLIP_SECONDS}`,
      '-f', 'lavfi', '-i', `sine=frequency=440:duration=${CLIP_SECONDS}`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-y', CLIP,
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    p.stderr.on('data', c => { err += c })
    p.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg 造片失败: ${err.slice(-300)}`)))
  })
}

async function runCli (args, timeoutMs = 180000) {
  // ⚠️ cwd 必须指到 TMP：storyboard 在某些参数组合下会把产物（storyboard.png /
  // storyboard.evidence.json）写到**当前工作目录**。实测踩到过 ——
  // 跑完测试发现包根目录多了这两个文件（253KB）。测试绝不能污染仓库。
  return new Promise(resolve => {
    const p = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'], cwd: TMP })
    let out = '', err = ''
    p.stdout.on('data', c => { out += c })
    p.stderr.on('data', c => { err += c })
    const timer = setTimeout(() => { try { p.kill('SIGKILL') } catch { /* ignore */ } }, timeoutMs)
    p.on('close', code => {
      clearTimeout(timer)
      resolve({ code, out, err })
    })
  })
}

console.log('\n=== 1. 来源声明完整性（vendor 基础设施的合规义务）===')
await test('VENDORED.md 存在（人读的来源说明）', () => {
  assert.ok(fs.existsSync(path.join(VENDOR, 'VENDORED.md')))
})
await test('vendor-manifest.json 存在（机器读的版本声明）', () => {
  assert.ok(fs.existsSync(path.join(VENDOR, 'vendor-manifest.json')))
})
await test('manifest 是合法 JSON 且必填字段齐全', () => {
  const m = JSON.parse(fs.readFileSync(path.join(VENDOR, 'vendor-manifest.json'), 'utf8'))
  for (const k of ['name', 'version', 'source', 'upstream', 'license', 'files', 'adaptations']) {
    assert.ok(m[k] !== undefined, `manifest 缺字段: ${k}`)
  }
  assert.equal(m.source.type, 'npm', 'storyboard 的 source type 应为 npm')
  assert.ok(m.source.package, 'source.package 必填')
})
await test('LICENSE 随包（MIT 合规义务）', () => {
  const lic = fs.readFileSync(path.join(VENDOR, 'LICENSE'), 'utf8')
  assert.match(lic, /MIT License/)
})
await test('manifest 版本与 vendor 内 package.json 一致', () => {
  const m = JSON.parse(fs.readFileSync(path.join(VENDOR, 'vendor-manifest.json'), 'utf8'))
  const p = JSON.parse(fs.readFileSync(path.join(VENDOR, 'package.json'), 'utf8'))
  assert.equal(m.version, p.version, `manifest=${m.version} package.json=${p.version}`)
})
await test('VENDORED.md 里写着当前版本（文档与 manifest 不漂移）', () => {
  const m = JSON.parse(fs.readFileSync(path.join(VENDOR, 'vendor-manifest.json'), 'utf8'))
  const doc = fs.readFileSync(path.join(VENDOR, 'VENDORED.md'), 'utf8')
  assert.ok(doc.includes(m.version), `VENDORED.md 里找不到 ${m.version}`)
})

console.log('\n=== 2. adaptations 真的被应用了 ===')
await test('src/index.js 已删除（dsh 插件入口，本项目不用）', () => {
  assert.ok(!fs.existsSync(path.join(VENDOR, 'src', 'index.js')),
    'src/index.js 还在 —— 它依赖 @deepseek-ai/dsh-tools，本项目不应保留')
})
await test('src/ 和 bin/ 里没有 dsh 硬依赖（只有注释可提）', () => {
  const hits = []
  for (const sub of ['src', 'bin']) {
    for (const f of fs.readdirSync(path.join(VENDOR, sub))) {
      if (!f.endsWith('.js') && !f.endsWith('.mjs')) continue
      const src = fs.readFileSync(path.join(VENDOR, sub, f), 'utf8')
      // 只看 import / from 语句（注释里提及不算）
      const importLines = src.split('\n').filter(l => /^\s*(import|const .*=\s*require)\b/.test(l))
      if (importLines.some(l => l.includes('@deepseek'))) hits.push(`${sub}/${f}`)
    }
  }
  assert.deepEqual(hits, [], `这些文件真的 import 了 @deepseek：${hits.join(', ')}`)
})
await test('没有带入 __pycache__ / .pyc（Python 字节码不该进 vendor）', () => {
  const found = []
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === '__pycache__' || e.name.endsWith('.pyc')) found.push(path.join(d, e.name))
      else if (e.isDirectory()) walk(path.join(d, e.name))
    }
  }
  walk(VENDOR)
  assert.deepEqual(found, [], `发现字节码缓存：${found.join(', ')}`)
})

console.log('\n=== 3. manifest 的 files 清单与实际存在的文件对得上 ===')
await test('files 里声明的条目全部存在', () => {
  const m = JSON.parse(fs.readFileSync(path.join(VENDOR, 'vendor-manifest.json'), 'utf8'))
  const missing = []
  for (const rel of m.files) {
    const p = path.join(VENDOR, rel.endsWith('/') ? rel.slice(0, -1) : rel)
    if (!fs.existsSync(p)) missing.push(rel)
  }
  assert.deepEqual(missing, [], `manifest 声明但不存在：${missing.join(', ')}`)
})

console.log('\n=== 4. CLI 真能跑（这是更新后自动测试的核心价值）===')
if (!hasFfmpeg()) {
  skip += 4   // --help / 真跑出图 / probe / 非视频优雅报错
  console.log('  ⚠️  跳过 CLI 测试：本机没有 ffmpeg（storyboard 依赖它，属环境缺失不是代码问题）')
} else {
  await makeClip()

  await test('--help 能起来（模块加载链路完好）', async () => {
    const r = await runCli(['--help'], 60000)
    const txt = r.out + r.err
    assert.match(txt, /usage:/i, `--help 输出异常：${txt.slice(0, 200)}`)
  })

  await test('真跑：6 秒测试片 → 产出宫格图 + manifest', async () => {
    const outPng = path.join(TMP, 'sheet.png')
    const outJson = path.join(TMP, 'sheet.json')
    const r = await runCli([CLIP, '--cells', '4', '--out', outPng, '--manifest', outJson])
    assert.equal(r.code, 0, `CLI 退出码 ${r.code}：${(r.err || r.out).slice(-400)}`)
    assert.ok(fs.existsSync(outPng), '没产出宫格图 PNG')
    assert.ok(fs.statSync(outPng).size > 1000, `PNG 太小（${fs.statSync(outPng).size}B），可能是空图`)
    assert.ok(fs.existsSync(outJson), '没产出 manifest JSON')
    // manifest 应该是合法 JSON 且带格子信息。
    // 实际结构（0.4.4 实测）：格子不在顶层，而在 sheets[].cells[] ——
    //   { plan: { cells: N }, sheets: [ { cols, rows, cells: [{ i, t_start, t_end, t_frame }] } ] }
    // 之前断言找顶层 mf.cells 是错的（那是 0.4.3 的猜测，0.4.4 实测纠正）。
    const mf = JSON.parse(fs.readFileSync(outJson, 'utf8'))
    assert.ok(mf, 'manifest 解析失败')
    const sheets = mf.sheets
    assert.ok(Array.isArray(sheets) && sheets.length > 0,
      `manifest 里没有 sheets 数组（keys=${Object.keys(mf).join(',')}）`)
    const cells = sheets.flatMap(s => s.cells ?? [])
    assert.ok(cells.length > 0, 'sheets 里没有格子（每张图应有 cells[]）')
    // 每格应带时间戳区间（这是「知道第几秒发生了什么」的唯一依据）
    assert.ok(cells.every(c => Number.isFinite(c.t_start) && Number.isFinite(c.t_end)),
      `格子缺时间戳：${JSON.stringify(cells.slice(0, 2))}`)
    // plan.cells 声明的数量和实际产出的格子数量应一致（或按窗口裁剪后合理）
    assert.ok(Number.isFinite(mf.plan?.cells), 'plan.cells 不是数字')
  })

  await test('probe 路径可用（零成本探测，不生成图）', async () => {
    // 显式给 --out：即便 probe-only 不生成图，也要确保它不会写到 cwd
    const r = await runCli([CLIP, '--probe-only', '--out', path.join(TMP, 'probe.png')], 60000)
    const txt = r.out + r.err
    // probe-only 不是所有版本都有；有输出且提到分辨率/时长就算过
    assert.equal(r.code, 0, `probe 退出码 ${r.code}`)
    assert.match(txt, /\d+ ?x ?\d+|\d+\.\d+s|duration/i, `probe 输出里没有时长/分辨率：${txt.slice(0, 300)}`)
  })

  await test('非视频文件不会崩（优雅报错）', async () => {
    const fake = path.join(TMP, 'fake.mp4')
    fs.writeFileSync(fake, 'not a video\n'.repeat(10))
    const r = await runCli([fake, '--cells', '2', '--out', path.join(TMP, 'fake.png')], 60000)
    const txt = r.out + r.err
    // 关键：不能是「未捕获异常/栈」，要有可读的失败说明
    assert.ok(!/Unhandled|TypeError|Cannot read propert/.test(txt),
      `非视频输入产生了未捕获异常：${txt.slice(-300)}`)
    assert.ok(r.code !== 0 || /error|fail|invalid|无法|失败/i.test(txt),
      '非视频输入既没非零退出也没错误提示')
  })
}

console.log('\n=== 5. 测试不污染仓库（产物必须落在 TMP）===')
await test('包根目录没有测试产生的 storyboard 产物', () => {
  // 这两个文件是 storyboard CLI 在「没给 --out / 没限制 cwd」时的默认落点。
  // 我们已把 runCli 的 cwd 指到 TMP 并显式给 --out；如果这里仍出现，说明有调用漏了约束。
  const bad = ['storyboard.png', 'storyboard.evidence.json']
    .filter(f => fs.existsSync(path.join(ROOT, f)))
  assert.deepEqual(bad, [],
    `测试把产物写进了包根目录：${bad.join(', ')}（应落在 ${TMP}）`)
})

console.log('\n=== 6. 与来源一致性（防止有人在 vendor 里偷偷改代码）===')
await test('vendor 目录里的代码和「原样复制」声明一致（除声明文件外无额外文件）', () => {
  // 允许的文件集合：manifest 声明的 + 我们自己加的两个声明文件
  const m = JSON.parse(fs.readFileSync(path.join(VENDOR, 'vendor-manifest.json'), 'utf8'))
  const allowed = new Set(['VENDORED.md', 'vendor-manifest.json', 'instrument-manifest.json'])
  for (const rel of m.files) allowed.add(rel.endsWith('/') ? rel.slice(0, -1) : rel)
  const extra = []
  for (const e of fs.readdirSync(VENDOR, { withFileTypes: true })) {
    const name = e.name + (e.isDirectory() ? '/' : '')
    const plain = e.isDirectory() ? e.name : e.name
    if (!allowed.has(plain) && !allowed.has(name)) extra.push(name)
  }
  assert.deepEqual(extra, [], `vendor 里有 manifest 没声明的多余条目：${extra.join(', ')}（应为「原样复制+声明文件」）`)
})

// 测试产物必须清掉：TMP 里可能留着几十 MB 的测试视频/宫格图
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* ignore */ }
console.log(`\n结果: ${pass} 通过 / ${fail} 失败 / ${skip} 跳过`)
process.exit(fail === 0 ? 0 : 1)
