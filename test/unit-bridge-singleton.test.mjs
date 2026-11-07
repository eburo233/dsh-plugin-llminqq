// unit-bridge-singleton.test.mjs —— 桥「单实例」闸（2026-11-06 线上事故回归）
//
// 🔴 真实事故（本文件的由来，别删这条注释）：
//   修复当天线上跑起了**两个**桥进程，两个都连着同一个 OneBot 网关 →
//   同一条 QQ 消息被处理两遍、回复发两遍（生产 bridge.log 里入站行逐行重复），
//   第二个还撞上 `EADDRINUSE 127.0.0.1:18080`。
//
//   根因：`startBridge()` 开头的 `if (bridgeChild) return` **挡不住并发**。
//   `bridgeChild` 要到函数末尾 `spawn()` 才赋值，它前面隔着
//   writeBridgeConfig / 日志轮转 / guardIngestCursor / 记忆目录迁移 一长串步骤。
//   两次调用在这段窗口里重叠（配置保存的去抖重启撞上自动重启 / 宿主连续触发），
//   两边都看到 `bridgeChild == null` → 各 spawn 一份，且两份都活着。
//   另外宿主重启后内存里的 bridgeChild 是 null，但桥进程还在 → 必然再起一个。
//
// 修法两层（本测试锁这两层）：
//   ① 进程内 `bridgeStarting` 闸 + try/finally 保证任何路径都释放
//   ② 跨进程：spawn 后**立刻**落盘 pid；startBridge 进门时核对磁盘 pid 是否还活着
//      （宿主重启/双宿主场景靠它认领「已有一个在跑」而不是再起一个）
//
// lib/index.js 是插件宿主的模块（import 会拉 cordis 依赖），不能直接 import，
// 所以按惯例抠源码断言 —— 这类断言的价值在于「接线没被删」，不是测运行时行为。

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SRC = fs.readFileSync(path.join(PKG, 'lib', 'index.js'), 'utf8')

/** 按花括号配平抠顶层函数（同 unit-proactive-time 的老办法）。 */
function fnSource (name) {
  const i = SRC.search(new RegExp(`(?:async\\s+)?function ${name}\\s*\\(`))
  assert.ok(i > 0, `定位不到 ${name}`)
  let paren = 0
  let k = SRC.indexOf('(', i)
  for (; k < SRC.length; k++) {
    if (SRC[k] === '(') paren++
    else if (SRC[k] === ')') { paren--; if (paren === 0) break }
  }
  let depth = 0
  let started = false
  for (let j = k; j < SRC.length; j++) {
    if (SRC[j] === '{') { depth++; started = true } else if (SRC[j] === '}') {
      depth--
      if (started && depth === 0) return SRC.slice(i, j + 1)
    }
  }
  assert.fail(`${name} 的花括号不配平`)
}

// ══════════════════════════════════════════════════════════════════════════
// ① 进程内并发闸
// ══════════════════════════════════════════════════════════════════════════
test('startBridge：有「正在启动」闸，且任何路径都会释放（try/finally）', () => {
  const body = fnSource('startBridge')
  assert.match(body, /if \(bridgeStarting\)/, '缺少「正在启动」闸 —— 并发调用会成对 spawn')
  assert.match(body, /bridgeStarting = true/, '进门前要置位')
  assert.match(body, /finally\s*\{/, '必须用 try/finally 释放闸（否则一次异常会把闸卡死）')
  assert.match(body, /finally[\s\S]{0,200}bridgeStarting = false/, 'finally 里要清标志')
})

test('单实例闸是模块级变量（不是函数内局部），否则并发调用看不到', () => {
  assert.match(SRC, /\nlet bridgeStarting = false/, 'bridgeStarting 必须是模块级 let')
})

// ══════════════════════════════════════════════════════════════════════════
// ② 跨进程闸：磁盘 pid 认领
// ══════════════════════════════════════════════════════════════════════════
test('startBridge：进门先核对磁盘 pid（宿主重启后能认出已在跑的桥）', () => {
  const body = fnSource('startBridge')
  assert.match(body, /liveBridgeFromDisk\(\)/, '要核对磁盘上的 pid，否则宿主重启后必然双桥')
  assert.match(body, /adopted/, '认领路径要标记 adopted（可观测/可排障）')
})

test('liveBridgeFromDisk：0 信号探活 + 命令行核对（防 pid 被复用）', () => {
  const body = fnSource('liveBridgeFromDisk')
  assert.match(body, /process\.kill\(\s*pid\s*,\s*0\s*\)/, '用 0 信号探活')
  assert.match(body, /bridge\/index\.js/, '要核对命令行，防止 pid 被系统复用后认领了别的进程')
  assert.match(body, /readState\(\)/, '从 state.json 读 pid')
})

test('spawn 之后**立刻**落盘 pid（不能等到函数末尾）', () => {
  const body = fnSource('startBridge')
  const iSpawn = body.indexOf('bridgeChild = spawn(')
  const iWrite = body.search(/writeState\(\{\s*bridge:\s*\{[^}]*pid:\s*bridgeChild\.pid/)
  assert.ok(iSpawn > 0, '找不到 spawn')
  assert.ok(iWrite > 0, 'spawn 之后没有立刻写 pid')
  assert.ok(iWrite > iSpawn, 'pid 必须在 spawn 之后写')
  // 关键：中间不能再隔一长段（用「两个位置之间字符数」做粗闸）
  const gap = body.slice(iSpawn, iWrite)
  assert.ok(gap.length < 600,
    `pid 落盘离 spawn 太远（${gap.length} 字符）—— 这段窗口就是并发起双桥的机会`)
})

test('stopBridge：显式清 pid（否则死 pid 会挡住下次启动 / 或认领了复用 pid）', () => {
  const body = fnSource('stopBridge')
  assert.match(body, /pid:\s*null/, 'stopBridge 要把 pid 置 null')
})

// ══════════════════════════════════════════════════════════════════════════
// ③ 事故痕迹：这些注释要留着（否则下一轮有人「清理注释」时会把教训删掉）
// ══════════════════════════════════════════════════════════════════════════
test('事故背景写在源码里（双桥 = 消息处理两遍 + EADDRINUSE）', () => {
  assert.match(SRC, /两个桥进程/, '要写明「同时跑起两个桥进程」这个事实')
  assert.match(SRC, /EADDRINUSE/, '要写明 18080 端口冲突这条可观测症状')
  assert.match(SRC, /同一条 QQ 消息被处理两遍|消息被处理两遍/, '要写明用户可见的后果')
})
