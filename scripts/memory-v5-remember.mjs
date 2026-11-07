#!/usr/bin/env node
// scripts/memory-v5-remember.mjs —— engine=v5 时往 v5 库显式写一条记忆
// ============================================================================
// 为什么需要它（2026-11-07）：
//   AGENTS.md 教机器人用 `python3 run.py memctl remember "下周三帮他把服务器迁移到新机器"`
//   来「明确记住一件事」。但 memctl remember 只写 **v4** 的 entries 表；
//   engine=v5 之后读路径根本不看 v4 —— 于是机器人以为记住了，
//   下一轮却怎么也想不起来。这是继 utterances / pruned / done 之后
//   第四个「切引擎后静默失效的旧工作流」。
//
// 为什么不直接用 Python 写 v5 库：
//   v5 的记忆必须同步进 mem_fts 索引（contentless FTS5，tok 列是
//   **Node 侧 bigram 分词**的产物）。Python 直接 INSERT memories 会造出一条
//   「存进去了但永远搜不到」的记忆；在 Python 里复刻分词器则会变成两份词法
//   实现，迟早漂移（这个仓库反复栽在「两处各写一遍」上）。
//   所以：让 Node 用 store 自己写 —— 索引一定对，分词只有一份实现。
//
// 用法：
//   node scripts/memory-v5-remember.mjs --text "下周三帮他把服务器迁移到新机器" \
//        [--subject 3022464706] [--conv c2c:3022464706] [--type commitment] \
//        [--salience 0.7] [--data-dir <插件数据目录>] [--json]
//
// 退出码：0 成功（或幂等命中）/ 2 参数或库不可用 / 1 其它错误
//   幂等：同 (text, type, subject) 已存在 active 条目 → 不重复插入，返回已有 id。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { openV5, MEMORY_TYPES } from '../lib/agent/memory-v5/store.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const argOf = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : '' }
const has = n => argv.includes(n)

function die (code, msg) {
  process.stderr.write(`memory-v5-remember: ${msg}\n`)
  process.exit(code)
}

const text = String(argOf('--text') || '').trim()
if (!text) die(2, '缺 --text（要记的内容）')

const type = String(argOf('--type') || '').trim() || 'commitment'
if (!MEMORY_TYPES.includes(type)) die(2, `非法 --type=${type}（允许：${MEMORY_TYPES.join('|')}）`)

const subject = String(argOf('--subject') || '').trim() || null
const conv = String(argOf('--conv') || '').trim() || null
const salienceRaw = Number(argOf('--salience'))
const salience = Number.isFinite(salienceRaw) ? Math.max(0, Math.min(1, salienceRaw)) : 0.7

/** 数据目录（和 v5-health 同一套推导）。 */
function dataDir () {
  const explicit = argOf('--data-dir') || process.env.LLMINQQ_DATA_DIR || ''
  if (explicit) return path.resolve(explicit.replace(/^~/, os.homedir()))
  // 桥/调度器都会传 LLMINQQ_STATE_DIR = <dataDir>/agent/memory
  const st = process.env.LLMINQQ_STATE_DIR || ''
  if (st) return path.resolve(st.replace(/^~/, os.homedir()))
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(dshHome, 'dsh-plugin-llminqq', 'agent', 'memory')
}

const dir = dataDir()
const dbPath = path.join(dir, 'mem-v5.db')
if (!fs.existsSync(dbPath)) die(2, `v5 库不存在：${dbPath}（还没迁移？回滚到 v4 用 memctl remember）`)

let store
try {
  store = openV5({ dbPath })
} catch (err) {
  die(2, `打不开 v5 库：${err?.message ?? err}`)
}

try {
  // 幂等：同文 + 同类型 + 同 subject 已经 active 就不重复插（remember 会被重复调用，
  // 比如机器人同一件事说两遍，或它重试命令）。
  const dup = store.db.prepare(`SELECT id FROM memories
    WHERE state = 'active' AND text = ? AND type = ? AND (subject IS ? OR subject = ?)
    LIMIT 1`).get(text, type, subject, subject)
  let out
  if (dup) {
    store.touchMemory([Number(dup.id)])
    out = { ok: true, id: Number(dup.id), existed: true, type, text }
  } else {
    const ins = store.insertMemory({
      type, text, subject, conv, salience,
      scope: conv && String(conv).startsWith('c2c:') ? 'dm_only' : 'public',
    })
    out = { ok: true, id: ins.id, existed: false, type, text }
  }
  if (has('--json')) process.stdout.write(JSON.stringify(out) + '\n')
  else process.stdout.write(`memory-v5-remember: ${out.existed ? '已存在' : '已记住'} #${out.id} [${type}] ${text.slice(0, 60)}\n`)
  process.exit(0)
} catch (err) {
  die(1, `写 v5 失败：${err?.message ?? err}`)
} finally {
  try { store?.close() } catch { /* ignore */ }
}
