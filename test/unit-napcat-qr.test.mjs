// test/unit-napcat-qr.test.mjs —— scripts/napcat-qr.mjs（被踢后取新登录码）
//
// 这个脚本的意义：2026-11-07 QQ 被腾讯踢下线（code=1006），以前恢复要靠
// 「开浏览器进 NapCat WebUI」或「翻 docker logs」，两条路都要人肉折腾。
// 现在一条命令：调 NapCat 的 /api/QQLogin/RefreshQRcode 换新码 → 写盘。
//
// 这里**不 mock 网络**：调用真实 NapCat 会让测试依赖本机容器状态（时有时无），
// 所以只测「参数/配置出错时的行为」和「不联网也能安全失败」。
// 真拿到码的那条路靠生产实测（见 commit message 里的实测输出）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SCRIPT = path.join(ROOT, 'scripts', 'napcat-qr.mjs')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'llminqq-qr-'))

const run = (args, opts = {}) => spawnSync(process.execPath, [SCRIPT, ...args], {
  encoding: 'utf8', timeout: 60000, ...opts,
})

test('缺 config.json → 退出码 2 且说明清楚（不能静默失败）', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'empty-'))
  const r = run(['--data-dir', dir, '--json'])
  assert.equal(r.status, 2, `应退出码 2，实际 ${r.status}：${r.stdout}${r.stderr}`)
  assert.match(r.stderr + r.stdout, /config\.json/, '要指出缺的是哪个文件')
})

test('配置损坏 → 退出码 2，不抛未捕获异常', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'bad-'))
  fs.writeFileSync(path.join(dir, 'config.json'), '{ not json')
  const r = run(['--data-dir', dir])
  assert.equal(r.status, 2)
  assert.doesNotMatch(r.stderr, /Uncaught|ERR_/, '不能把 JSON 解析错误直接抛出来')
})

test('拿不到码时退出码 2，且不留下半截/空文件', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'out-'))
  // ⚠️ 数据目录不由 --data-dir 决定：它来自 lib/store.js 的 dataDir()
  //   （优先从安装路径反推，兜底才看 DSH_HOME）。所以隔离要用 DSH_HOME。
  //   这是第一版测试踩到的：以为自己隔离了，其实读到了本机真实二维码、退出码 0。
  const fakeHome = fs.mkdtempSync(path.join(TMP, 'home-'))
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    // 故意给一个不存在的容器名 + 不存在的 WebUI 端口：
    // 刷新会失败，docker cp 也失败 → 确定性地拿不到码
    napcat: { webuiPort: 1, containerName: 'no-such-container-xyz', webuiToken: 'x' },
  }))
  const out = path.join(dir, 'deep', 'nested', 'qr.png')
  const r = run(['--data-dir', dir, '--out', out, '--no-refresh'], {
    env: { ...process.env, DSH_HOME: fakeHome },
  })
  assert.equal(r.status, 2, `拿不到码时退出码应为 2（实际 ${r.status}）：${r.stdout}${r.stderr}`)
  assert.equal(fs.existsSync(out), false, '拿不到码时绝不能留下半截/空文件')
})
