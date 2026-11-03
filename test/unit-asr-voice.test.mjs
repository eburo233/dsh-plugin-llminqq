// test/unit-asr-voice.test.mjs —— QQ 语音转文字（task-10）
//
// 背景（2026-11-03）：
//   对方发语音时，桥以前只有 `[语音] 5s` 占位，模型完全不知道他说了什么。
//   这里把 legacy 分支的 faster-whisper 方案搬进插件：语音段里的 url 先下到暂存区
//   （走 safeFetchBuffer，SSRF/大小上限复用入站文件那套），再调 python 脚本转写，
//   stdout 即文本；失败/超时一律降级成「没转写成功」，绝不拖住整轮回复。
//
// 测试原则（和 unit-inbound-files 一致）：
//   · **假 python 脚本 + 假 fetch**：不装 faster-whisper、不下模型、不连网络；
//   · 音频来源两种都要覆盖：段内 url（真机 packet 后端会给）和 path（容器内路径，
//     宿主机通常读不到 → 必须明确降级）；
//   · 开关默认关：关着时**一个 python 都不许起、一个请求都不许发**；
//   · 同一 file_id 不重复转写（内存 LRU），否则连发/合并轮会重复烧 CPU。

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createSecurity } from '../lib/bridge/security.js'
import { createMessaging } from '../lib/bridge/messaging.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'llminqq-asr-'))
const COUNTER = path.join(TMP, 'asr-calls.log')
process.env.LLMINQQ_TEST_ASR_COUNTER = COUNTER
after(() => {
  delete process.env.LLMINQQ_TEST_ASR_COUNTER
  fs.rmSync(TMP, { recursive: true, force: true })
})

// python 是可选环境依赖：没有它就不该让整个测试套件红掉（真机实现仍然可用）
const PYTHON = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
const HAS_PYTHON = (() => {
  try {
    const r = spawnSync(PYTHON, ['-V'], { timeout: 5000, windowsHide: true })
    return r.status === 0
  } catch { return false }
})()
/** 需要 python 的用例；没有 python 时跳过（附原因，不静默）。 */
const pythonTest = HAS_PYTHON ? test : (name, fn) => test(name, { skip: `本机没有 ${PYTHON}` }, fn)

// ── 假 python 脚本（只打印固定文本 / 睡觉 / 报错，绝不 import whisper）────────
const FAKE = path.join(TMP, 'fake-asr.py')
fs.writeFileSync(FAKE, [
  'import os, sys',
  "log = os.environ.get('LLMINQQ_TEST_ASR_COUNTER')",
  'if log:',
  "    open(log, 'a', encoding='utf-8').write(' '.join(sys.argv[1:]) + '\\n')",
  "print('你好呀，在吗')",
  '',
].join('\n'))
const SLOW = path.join(TMP, 'slow-asr.py')
fs.writeFileSync(SLOW, 'import time\ntime.sleep(5)\nprint("慢")\n')
const FAIL = path.join(TMP, 'fail-asr.py')
fs.writeFileSync(FAIL, [
  'import sys',
  "sys.stderr.write('[asr] 模型下载失败：connection reset\\n')",
  'sys.exit(1)',
  '',
].join('\n'))
const EMPTY = path.join(TMP, 'empty-asr.py')
fs.writeFileSync(EMPTY, 'pass\n')

function calls () {
  try { return fs.readFileSync(COUNTER, 'utf8').trim().split('\n').filter(Boolean) } catch { return [] }
}
function resetCalls () { try { fs.unlinkSync(COUNTER) } catch { /* 没有就算了 */ } }

/** 组装「假 gateway + 真 security + 真 messaging」。 */
function makeStack (vt) {
  const media = { stagingDir: TMP }
  // vt === null → 老配置：完全没有 voiceTranscribe 段（默认必须是关）
  if (vt !== null) {
    media.voiceTranscribe = {
      enabled: true,
      pythonBin: PYTHON,
      script: FAKE,
      timeoutMs: 5000,
      ...(vt || {}),
    }
  }
  const config = { media, tts: {}, onebot: {} }
  const security = createSecurity({ config, root: TMP })
  const logs = []
  const logger = { log: m => logs.push(String(m)), debug: () => {}, warn: () => {} }
  const gateway = {
    calls: [],
    selfId: '999',
    async callData () { throw new Error('语音转写不该调 OneBot 接口') },
  }
  const messaging = createMessaging({
    config, logger, gateway, security,
    noteSelfSent: () => {}, sendTextTo: async () => {},
  })
  return { config, security, logger, gateway, messaging, logs }
}

/** 假 fetch：只在测试体内替换 globalThis.fetch。 */
function stubFetch (impl) {
  const orig = globalThis.fetch
  let count = 0
  globalThis.fetch = async (...args) => { count += 1; return impl(...args, count) }
  return { count: () => count, restore: () => { globalThis.fetch = orig } }
}
const okAudio = () => new Response('AUDIO-BYTES', {
  status: 200,
  headers: { 'content-type': 'audio/amr' },
})

// ── ① 开关：默认关，关着零开销 ──────────────────────────────────────────────
test('默认关（老配置没有 voiceTranscribe 段）→ 不转写、不起 python、不发请求', async () => {
  resetCalls()
  const { messaging } = makeStack(null)
  const f = stubFetch(async () => okAudio())
  try {
    const out = await messaging.transcribeInboundVoices([
      { file_id: 'v1', url: 'https://example.com/a.amr', duration: 5 },
    ])
    assert.deepEqual(out, [])
    assert.equal(f.count(), 0, '关着时不该下载音频')
    assert.deepEqual(calls(), [], '关着时不该起 python')
  } finally { f.restore() }
})

test('显式 enabled=false → 同样什么都不做（和显式开同一条规则的两端）', async () => {
  resetCalls()
  const { messaging } = makeStack({ enabled: false })
  const out = await messaging.transcribeInboundVoices([{ url: 'https://example.com/a.amr' }])
  assert.deepEqual(out, [])
  assert.deepEqual(calls(), [])
})

// ── ② 有 url：下载 → python → 文本 ──────────────────────────────────────────
pythonTest('段内带 url → 用 safeFetchBuffer 下载 → python 转写成功 → 返回文本', async () => {
  resetCalls()
  const { messaging, logs } = makeStack()
  const f = stubFetch(async url => {
    assert.equal(url, 'https://example.com/7a.amr?rkey=x')
    return okAudio()
  })
  try {
    const out = await messaging.transcribeInboundVoices([
      {
        file_id: 'uuid-voice-1', file: '7a.amr', duration: 5,
        url: 'https://example.com/7a.amr?rkey=x', file_size: 11,
      },
    ])
    assert.equal(out.length, 1)
    assert.equal(out[0].ok, true, `应转写成功：${JSON.stringify(out[0])}`)
    assert.equal(out[0].text, '你好呀，在吗')
    assert.equal(out[0].via, 'url')
    assert.equal(out[0].duration, 5)
    assert.equal(f.count(), 1, '只该下载一次')
    // python 参数要带上模型/语言/脚本（桥侧透传配置的最后一环）
    const line = calls()[0] || ''
    assert.match(line, /--file /)
    assert.match(line, /--model small/)
    assert.match(line, /--lang zh/)
    assert.ok(logs.some(l => /语音已转写/.test(l)), '成功也要留日志（真机排查用）')
    // 下到暂存区的音频用完就删：语音攒起来会白占磁盘
    assert.deepEqual(fs.readdirSync(TMP).filter(n => /\.amr$/.test(n)), [], '临时音频没清理')
  } finally { f.restore() }
})

pythonTest('hfHome/model/lang 配置透传到 python（--hf-home / --model / --lang）', async () => {
  resetCalls()
  const { messaging } = makeStack({ model: 'base', lang: 'en', hfHome: path.join(TMP, 'hf') })
  const f = stubFetch(async () => okAudio())
  try {
    const out = await messaging.transcribeInboundVoices([{ file: 'a.amr', url: 'https://example.com/a.amr' }])
    assert.equal(out[0].ok, true)
    const line = calls()[0] || ''
    assert.match(line, /--model base/)
    assert.match(line, /--lang en/)
    assert.match(line, /--hf-home /, '模型缓存目录没传给脚本 —— HF_HOME 会落回 ~/.cache')
  } finally { f.restore() }
})

pythonTest('对外 API：transcribeVoice 接受 url / 本地路径字符串 + {cfg, budgetMs}', async () => {
  resetCalls()
  const { messaging } = makeStack()
  const cfg = messaging.voiceTranscribeCfg()
  const f = stubFetch(async () => okAudio())
  try {
    const r = await messaging.transcribeVoice('https://example.com/x.amr', { cfg, budgetMs: 3000 })
    assert.equal(r.ok, true, `url 字符串应能直接转：${JSON.stringify(r)}`)
    assert.equal(r.text, '你好呀，在吗')
    assert.equal(r.via, 'url')
    const local = path.join(TMP, 'api-path.amr')
    fs.writeFileSync(local, 'AUDIO')
    const r2 = await messaging.transcribeVoice(local, { cfg })
    assert.equal(r2.ok, true)
    assert.equal(r2.via, 'path')
  } finally { f.restore() }
})

// ── ③ 无 url：path（容器内路径）能读就用，读不到要明确降级 ──────────────────
pythonTest('无 url、段里 path 在宿主机可读 → 直接转写，不下载', async () => {
  resetCalls()
  const local = path.join(TMP, 'local-voice.amr')
  fs.writeFileSync(local, 'AUDIO')
  const { messaging } = makeStack()
  const f = stubFetch(async () => okAudio())
  try {
    const out = await messaging.transcribeInboundVoices([{ file: 'local-voice.amr', path: local }])
    assert.equal(out[0].ok, true, `路径可读时应成功：${JSON.stringify(out[0])}`)
    assert.equal(out[0].via, 'path')
    assert.equal(f.count(), 0, '有本地路径就不该再发下载请求')
    assert.ok(fs.existsSync(local), '段里给的 path 不是我们下的，绝不能删')
  } finally { f.restore() }
})

test('无 url、path 是 NapCat 容器内路径（宿主机读不到）→ 明确降级，不起 python', async () => {
  resetCalls()
  const { messaging, logs } = makeStack()
  const f = stubFetch(async () => okAudio())
  try {
    const out = await messaging.transcribeInboundVoices([
      { file: 'x.amr', path: '/app/napcat/data/x.amr' },
    ])
    assert.equal(out[0].ok, false)
    assert.match(out[0].reason, /容器/, `降级原因要说清是容器路径：${out[0].reason}`)
    assert.match(out[0].reason, /读不到/)
    assert.equal(f.count(), 0)
    assert.deepEqual(calls(), [], '读不到路径就不该浪费时间起 python')
    assert.ok(logs.some(l => /语音转写降级/.test(l)), '降级要留日志')
  } finally { f.restore() }
})

test('既没有 url 也没有 path → 失败原因明确', async () => {
  const { messaging } = makeStack()
  const out = await messaging.transcribeInboundVoices([{ file: 'x.amr' }])
  assert.equal(out[0].ok, false)
  assert.match(out[0].reason, /既没有 url 也没有本机路径/)
})

// ── ④ python 失败 / 超时 / 空输出：全部降级，不抛错 ─────────────────────────
pythonTest('python 退出码非 0（缺依赖/模型下载失败）→ 降级，原因取 stderr', async () => {
  resetCalls()
  const { messaging } = makeStack({ script: FAIL })
  const f = stubFetch(async () => okAudio())
  try {
    const out = await messaging.transcribeInboundVoices([{ url: 'https://example.com/a.amr' }])
    assert.equal(out[0].ok, false)
    assert.match(out[0].reason, /模型下载失败/)
  } finally { f.restore() }
})

pythonTest('python 卡死 → 到超时点被杀掉并降级（不拖住整轮回复）', async () => {
  resetCalls()
  const { messaging } = makeStack({ script: SLOW, timeoutMs: 800 })
  const f = stubFetch(async () => okAudio())
  try {
    const t0 = Date.now()
    const out = await messaging.transcribeInboundVoices([{ url: 'https://example.com/a.amr' }])
    const cost = Date.now() - t0
    assert.equal(out[0].ok, false)
    assert.match(out[0].reason, /超时/)
    assert.ok(cost < 4000, `超时后必须立刻返回，实际花了 ${cost}ms`)
  } finally { f.restore() }
})

pythonTest('python 没输出（静音/没听清）→ 降级「转写结果为空」', async () => {
  resetCalls()
  const { messaging } = makeStack({ script: EMPTY })
  const f = stubFetch(async () => okAudio())
  try {
    const out = await messaging.transcribeInboundVoices([{ url: 'https://example.com/a.amr' }])
    assert.equal(out[0].ok, false)
    assert.match(out[0].reason, /转写结果为空/)
  } finally { f.restore() }
})

pythonTest('pythonBin 不存在 → 降级说明找不到 python，不抛错', async () => {
  resetCalls()
  const { messaging } = makeStack({ pythonBin: 'definitely-not-a-python-xyz' })
  const f = stubFetch(async () => okAudio())
  try {
    const out = await messaging.transcribeInboundVoices([{ url: 'https://example.com/a.amr' }])
    assert.equal(out[0].ok, false)
    assert.match(out[0].reason, /找不到 python/)
  } finally { f.restore() }
})

// ── ⑤ 去重 / 条数上限 ───────────────────────────────────────────────────────
pythonTest('同一 file_id 不重复转写：第二次命中缓存，不再下载/起 python', async () => {
  resetCalls()
  const { messaging, logs } = makeStack()
  const f = stubFetch(async () => okAudio())
  try {
    const v = { file_id: 'same-id', file: 'a.amr', url: 'https://example.com/a.amr' }
    const first = await messaging.transcribeInboundVoices([v])
    const second = await messaging.transcribeInboundVoices([v])
    assert.equal(first[0].ok, true)
    assert.equal(second[0].ok, true)
    assert.equal(second[0].cached, true, '第二次应命中缓存')
    assert.equal(f.count(), 1, '缓存命中不该再下载')
    assert.equal(calls().length, 1, '缓存命中不该再起 python')
    assert.ok(logs.some(l => /命中缓存/.test(l)))
  } finally { f.restore() }
})

test('单条消息最多转写 3 条语音，多出来的给原因（不叠加 30s 预算）', async () => {
  resetCalls()
  const { messaging } = makeStack({ script: EMPTY })
  const voices = [0, 1, 2, 3].map(i => ({ file_id: `v${i}`, url: `https://example.com/${i}.amr` }))
  const f = stubFetch(async () => okAudio())
  try {
    const out = await messaging.transcribeInboundVoices(voices)
    assert.equal(out.length, 4)
    assert.equal(out[3].ok, false)
    assert.match(out[3].reason, /最多转写 3 条/)
  } finally { f.restore() }
})

// ── ⑥ 配置透传（插件 → 桥）+ 脚本/文档本身 ─────────────────────────────────
// import 整个插件模块会连带加载 store/models/napcat 一串子模块。照 unit-config 的
// 做法先把 HOME / DSH_HOME 引到临时目录，保证不碰真实 ~/.dsh。
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'llminqq-asr-cfg-'))
process.env.HOME = TMP_HOME
process.env.USERPROFILE = TMP_HOME
process.env.DSH_HOME = path.join(TMP_HOME, '.dsh')
const IDX = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)
const STORE = await import(pathToFileURL(path.join(ROOT, 'lib', 'store.js')).href)
after(() => fs.rmSync(TMP_HOME, { recursive: true, force: true }))

const VT_DEFAULTS = {
  enabled: false,
  engine: 'faster-whisper',
  model: 'small',
  lang: 'zh',
  pythonBin: process.platform === 'win32' ? 'python' : 'python3',
  script: '',
  timeoutMs: 30000,
  hfHome: '',
}

test('voiceTranscribeMedia: 缺省（老配置没有这个段）→ 默认关 + small', () => {
  assert.deepEqual(IDX.voiceTranscribeMedia(undefined), VT_DEFAULTS)
  assert.deepEqual(IDX.voiceTranscribeMedia({}), VT_DEFAULTS)
})

test('voiceTranscribeMedia: 合法值原样透传（设置页改了能到桥）', () => {
  assert.deepEqual(
    IDX.voiceTranscribeMedia({
      voiceTranscribe: {
        enabled: true, engine: 'funasr', model: 'base', lang: 'en',
        pythonBin: '/opt/py/bin/python', script: '/x/transcribe.py', timeoutMs: 60000,
      },
    }, { script: '/bundle/asr.py', hfHome: '/data/asr-models' }),
    {
      enabled: true, engine: 'funasr', model: 'base', lang: 'en',
      pythonBin: '/opt/py/bin/python', script: '/x/transcribe.py', timeoutMs: 60000,
      hfHome: '/data/asr-models',
    })
})

test('voiceTranscribeMedia: enabled 只认显式 true（默认必须关）', () => {
  for (const v of ['true', 1, 'yes', null, undefined, '']) {
    assert.equal(IDX.voiceTranscribeMedia({ voiceTranscribe: { enabled: v } }).enabled, false,
      `enabled=${JSON.stringify(v)} 不该算开 —— 会偷偷下 480MB 模型`)
  }
})

test('voiceTranscribeMedia: 非法值回落 / 越界夹边界（超时 5–120s）', () => {
  const r = IDX.voiceTranscribeMedia({
    voiceTranscribe: {
      engine: 'x', model: 'large', lang: 'ZH-CN', timeoutMs: 999999,
    },
  })
  assert.equal(r.engine, 'faster-whisper')
  assert.equal(r.model, 'small', '非法模型名必须回落 small，别把 large 传给 whisper')
  assert.equal(r.lang, 'zh')
  assert.equal(r.timeoutMs, 120000)
  const lo = IDX.voiceTranscribeMedia({ voiceTranscribe: { timeoutMs: 100 } })
  assert.equal(lo.timeoutMs, 5000)
  const bad = IDX.voiceTranscribeMedia({ voiceTranscribe: { timeoutMs: 'abc' } })
  assert.equal(bad.timeoutMs, 30000)
})

test('漂移守卫：store.js 的默认值和 clamp 的默认值一致', () => {
  const m = STORE.defaults().media
  assert.deepEqual(IDX.voiceTranscribeMedia(m), VT_DEFAULTS,
    'store.js 的 voiceTranscribe 默认值和这里不一致 —— 只改一处会出现「新用户默认 base」这种鬼故事')
  assert.equal(m.voiceTranscribe.enabled, false, '默认必须是关的')
  assert.equal(m.voiceTranscribe.model, 'small', '用户拍板：默认 small')
})

test('源码级：bridgeConfig 的 media 段确实透传了 voiceTranscribe（脚本/HF_HOME 落对位置）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'index.js'), 'utf8')
  const start = src.indexOf('function bridgeConfig (cfg) {')
  assert.ok(start > 0, '定位不到 bridgeConfig')
  const mediaAt = src.indexOf('media: {', start)
  assert.ok(mediaAt > start)
  const chunk = src.slice(mediaAt, mediaAt + 4000)
  assert.match(chunk, /voiceTranscribe: voiceTranscribeMedia\(cfg\.media, \{/,
    'bridgeConfig 没透传 voiceTranscribe —— 设置页会变成假配置')
  assert.match(chunk, /transcribe\.py/, '脚本路径没指向自带的 lib/agent/asr/transcribe.py')
  assert.match(chunk, /asr-models/, 'HF_HOME 没落到插件数据目录的 agent/asr-models/')
})

test('自带的 ASR 脚本存在、语法通过、并且钉了 HF 镜像（别删）', { skip: HAS_PYTHON ? false : `本机没有 ${PYTHON}` }, () => {
  const script = path.join(ROOT, 'lib', 'agent', 'asr', 'transcribe.py')
  assert.ok(fs.existsSync(script), 'lib/agent/asr/transcribe.py 不见了')
  const src = fs.readFileSync(script, 'utf8')
  assert.match(src, /from faster_whisper import WhisperModel/, '默认引擎必须是 faster-whisper')
  assert.match(src, /hf-mirror\.com/, 'HF 镜像没了 —— 国内会拉不动模型')
  assert.match(src, /HF_HUB_DISABLE_XET/, '没关 Xet 会 401')
  assert.match(src, /funasr/, '可选 funasr 引擎没保留')
  // py_compile 只验语法（不 import 依赖、不下模型）；PYTHONPYCACHEPREFIX 把
  // __pycache__ 指到临时目录，别弄脏工作区。
  const r = spawnSync(PYTHON, ['-m', 'py_compile', script], {
    timeout: 20000, windowsHide: true,
    env: { ...process.env, PYTHONPYCACHEPREFIX: TMP },
  })
  assert.equal(r.status, 0, `python 语法检查失败：${String(r.stderr || r.stdout).slice(0, 400)}`)
})

test('README 写清了首次使用成本（依赖 + 模型体积 + 默认关）', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')
  assert.match(readme, /faster-whisper/, 'README 没提 faster-whisper')
  assert.match(readme, /480\s*MB/, 'README 没写 small 模型 ≈480MB —— 用户不知道首次会下大文件')
  assert.match(readme, /默认关/, 'README 要写清语音转写默认关')
  assert.match(readme, /agent\/asr-models/, 'README 没写模型缓存在哪')
})
