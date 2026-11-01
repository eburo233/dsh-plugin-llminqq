// test/unit-bili-subtitle-ts.test.mjs —— 字幕时间戳 + 凭据路径
//
// 背景（2026-11-01 用户问「字幕有时间戳吗」）：
//   B站字幕的 body 每段本来就是 {"from": 0.3, "to": 3.31, "content": "..."}，
//   但代码只取了 content，**把「这句话在第几秒说的」这条最有用的信息删掉了**。
//
//   为什么重要：宫格图每格标着时间戳，字幕不带时间戳就**对不上** ——
//   模型只能说「图里有几个对话示例」而说不出「第 3 格在 15-23 秒演示的是什么」。
//   这才是「图文理解」的前提。
//
// 顺带查出第二个 bug：`CRED_FILE` 硬编码成 `<包目录>/bili_credential.json`，
// 而插件通过 `BILI_CREDENTIAL_PATH` 下发的是 `~/.dsh/bili-duty/` 那份 ——
// 那个路径**根本没被读取**。于是 load_credential() 返回 None，
// 所有需要登录的工具（bili_subtitle / bili_comments / bili_reply）全部退化成
// 「未登录」。用户看到的表现是机器人说「视频没公开字幕」，其实有字幕读不到。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const PY = fs.readFileSync(path.join(ROOT, 'vendor', 'bilibili-mcp', 'mcp_server.py'), 'utf8')
const AGENTS = fs.readFileSync(path.join(ROOT, 'qq-agent', 'AGENTS.md'), 'utf8')

// ── ① 凭据路径必须听环境变量 ────────────────────────────────────────────────

test('凭据路径要读 BILI_CREDENTIAL_PATH（不能硬编码在包里）', () => {
  assert.match(PY, /BILI_CREDENTIAL_PATH/,
    '没读 BILI_CREDENTIAL_PATH —— 凭据会指向包里那个不存在的文件，所有登录工具全废')
  const i = PY.indexOf('CRED_FILE =')
  const block = PY.slice(i - 500, i + 200)
  assert.match(block, /_cred_env|BILI_CREDENTIAL_PATH/, 'CRED_FILE 的定义里没有用环境变量')
  // 空值时要有兜底（手工跑的老行为不能坏）
  assert.match(block, /Path\(__file__\)\.parent/,
    '环境变量没设时要退回包目录 —— 否则手工跑就找不到凭据')
})

// ── ② 字幕必须带时间戳 ──────────────────────────────────────────────────────

test('字幕要保留 from/to（原来只取 content 全丢了）', () => {
  assert.match(PY, /"from"/, '没保留 from')
  assert.match(PY, /"to"/, '没保留 to')
  const i = PY.indexOf('body = sub_data.get("body"')
  assert.ok(i > 0, '定位不到字幕 body 解析')
  const block = PY.slice(i, i + 600)
  assert.match(block, /float\(item\.get\("from"/, '没从 body 读 from')
})

test('要同时给三种形式（纯文本 / 带时间戳文本 / 结构化）', () => {
  assert.match(PY, /"text": full_text/, '缺纯文本（老调用方要用）')
  assert.match(PY, /"timedText": timed_text/, '缺带时间戳的文本')
  assert.match(PY, /"segmentsWithTime": segs/, '缺结构化的 segments')
})

test('带时间戳的文本要是 [mm:ss] 前缀（好和宫格图对）', () => {
  const i = PY.indexOf('def _mmss')
  assert.ok(i > 0, '缺 _mmss 时间格式化')
  const block = PY.slice(i, i + 300)
  assert.match(block, /divmod/, '_mmss 应该用 divmod 算分秒')
  assert.match(PY, /\[%s\] %s/, '每行应该是 [时间] 台词 的格式')
})

test('空 content / 坏 from 要跳过而不是产出脏数据', () => {
  const i = PY.indexOf('body = sub_data.get("body"')
  const block = PY.slice(i, i + 900)
  assert.match(block, /if not t:\s*\n\s*continue/, '空内容要跳过')
  assert.match(block, /except \(TypeError, ValueError\)/, 'from/to 解析失败要兜底')
})

// ── ③ 提示词：storyboard 优先 + 说明时间戳用法 ──────────────────────────────

test('AGENTS.md 要把 storyboard 排在 bili_frames 前面', () => {
  assert.match(AGENTS, /优先用 storyboard/,
    '没写优先级 —— 模型还会先用分辨率低的故事板帧')
  // 两个工具的对比要写清楚（为什么 storyboard 更好）
  assert.match(AGENTS, /画面变化/, '没说明 storyboard 是按画面变化选帧')
  assert.match(AGENTS, /看不清|字小到看不清/, '没说清 bili_frames 的清晰度问题')
})

test('AGENTS.md 要说明字幕时间戳怎么和宫格图配合', () => {
  assert.match(AGENTS, /timedText/, '没提 timedText')
  assert.match(AGENTS, /segmentsWithTime/, '没提 segmentsWithTime')
  assert.match(AGENTS, /对得上|对时间戳/,
    '没说明「字幕时间戳 + 宫格时间戳」怎么配合 —— 这才是图文理解的关键')
})

// ── ④ 安装文档必须写清 yt-dlp（否则换台机器不会知道要装）─────────────────────
//
// 2026-11-01 实测发现：`video_storyboard` 能直接吃 URL 拿高清帧，
// 但**只缺 yt-dlp 这个外部命令**（vendor 刻意不打包它）。
// 不写进安装文档的话，换台机器只会发现「画面看不清」，不知道差什么。

const INSTALL = fs.readFileSync(path.join(ROOT, 'INSTALL-PLUGIN.md'), 'utf8')

test('INSTALL-PLUGIN.md 要说清楚 why：storyboard 比 bili_frames 强在哪', () => {
  assert.match(INSTALL, /yt-dlp/, '安装文档里完全没提 yt-dlp')
  assert.match(INSTALL, /video_storyboard/, '没提 storyboard')
  assert.match(INSTALL, /bili_frames/, '没提 bili_frames（读者不知道还有个更弱的现成工具）')
  // 要让读者明白「不装也能用，只是看不清」
  assert.match(INSTALL, /不装也能用/, '没说明「不装也能用」—— 会让读者以为插件缺依赖')
})

test('要给三种平台的安装方式（Linux/Windows/macOS）', () => {
  for (const kw of ['python3 -m venv', 'winget install yt-dlp', 'brew install yt-dlp']) {
    assert.ok(INSTALL.includes(kw), `缺安装方式：${kw}`)
  }
})

test('要警告 PEP 668（apt 管的 python 不让 pip --user）', () => {
  assert.match(INSTALL, /PEP 668|externally-managed-environment/,
    '没警告 PEP 668 —— 读者会照着 pip --user 装然后失败')
})

test('要写 venv 拷贝后的 shebang 坑（实测踩过）', () => {
  assert.match(INSTALL, /shebang/, '没提 shebang 问题')
  assert.match(INSTALL, /cannot execute/, '没写实际报错文案 —— 读者对不上自己的错误')
  assert.match(INSTALL, /sed -i .*1s\|.*\|/, '没给修 shebang 的命令')
})

test('要教怎么验证它被找到了（PATH 检查 + 日志特征）', () => {
  assert.match(INSTALL, /\.local\/bin/, '没提 ~/.local/bin')
  assert.match(INSTALL, /findOnPath|PATH/, '没说明查找方式')
  assert.match(INSTALL, /\[fetch\] downloaded/, '没给「成功长什么样」的日志特征')
  assert.match(INSTALL, /yt-dlp not found/, '没给「失败长什么样」')
})
