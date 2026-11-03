#!/usr/bin/env node
// scripts/memory-v4-to-v5.mjs —— 记忆 v4 → v5 历史数据迁移（docs §4 Step 3）
// ============================================================================
// 干什么：
//   把 v4 的 `mem.db.entries`（一张大表：原文、结论、规矩、自己的话全混在一起）
//   迁到 v5 的 `memories`（结论层）+ `utterances`（「我说过什么」）。v5 的
//   `events`（原文层）**不从 jsonl/日志回灌**：Step 1 双写已经在写新事件的
//   events，历史原文由 bridge 日志另走补写（不在这条脚本的职责里）。
//
// 安全边界（硬约束，改之前先想清楚）：
//   · v4 源**只读**打开（node:sqlite readOnly）。默认还拒绝直接指向生产路径，
//     要求先 `cp` 到 /tmp（生产库是活的，别人正在写；副本才是稳定快照）。
//   · 默认 **dry-run**：只读源 + 打印报告，不创建/不写任何文件。
//     `--apply` 才写 `--out`。
//   · `--out` 默认也拒绝生产路径；正式切换时显式 `--allow-prod`（并且先备份）。
//   · 绝不动 `~/.dsh` 下的任何东西、不删旧库、不碰 NapCat。
//   · `--out` 不许等于 `--v4`；`--out` 若看起来是 v4 库（有 entries 表）直接拒绝。
//
// 幂等（可以放心重跑）：
//   memories 按 `key` 去重（见下），utterances 按 (conv,text,at) 查重。
//   第二次 `--apply` 全部落进「已存在」分类，库不变。FTS 在 apply 末尾重建一次
//   （insertMemory 自己会写索引；重建是兜底：中途被杀也能自愈）。
//
// ── 映射规则（逐条给理由；和 task-19 的描述一一对应）────────────────────────
//
// ① kind → type（v4 三层 → v5 六类里的三类）
//      procedural → rule
//      semantic   → fact
//      episodic   → episode
//      其它/未知  → episode（v4 历史上还有 v1 的 fact/person/topic/task，
//                    memctl.py 的 connect() 早就把它们归一成三层了；真遇到就
//                    按「最保守、最可退场」的 episode 落，交给 distill 再升级）
//    为什么不做 preference/commitment 的语义重分类：迁移是「搬家」不是「再提炼」。
//    从文本猜 preference/commitment 一定会错，而错了之后 distill 会把错类型当输入；
//    让 distill 在 v5 里按它自己的 prompt 重判，比迁移时拍脑袋可靠。
//
// ② pinned → salience 0.9；否则 importance → salience（clamp 0..1，缺省 0.5）
//    v5 没有 pinned 列（文档约定：钉住 = salience 抬到 0.9）。0.9 是文档给的数，
//    不再用 v4 那套 `max(imp, 0.8)` —— 0.8 落在「很重要」和「钉住」之间没有区分度。
//
// ③ created → created + valid_from；last_seen → last_seen；valid_until = null
//    v5 的 valid_from 表示「这条结论从什么时候成立」。v4 只有 created（首次入库），
//    它就是这个语义。valid_until 留空：**迁移时不知道哪条会过期**，靠 expire job
//    按 distill 补上的时间边界去归档；迁移自己猜日期只会误杀（「明天三点开会」
//    解析错一次就永久归档一条真实记忆）。
//    ⚠️ v4 列名是 `created`（不是 audit 文字里的 created_at）。脚本按实际列读。
//
// ④ retired=1 → state='archived'，archived_reason：
//      文本以「已完成：」开头 → done（v4 的 done() 用文本前缀反推「完成」，
//                                 v5 有独立列了，正好把这层补丁洗掉）
//      其它                   → pruned（v4 的 retired 还兼着「低价值归档」；
//                                 v5 的 pruned 就是干这个的）
//    ⚠️ 文档 Step 3 原型还「新增 expired 归档 1 条（过期会议）」—— 本脚本**不做**：
//    那需要把「2026-10-26 下午三点」解析成 valid_until，迁移不该猜自然语言时间；
//    交给 expire job / distill（它们在 v5 里有结构化字段可写）。这条差异写进回执。
//
// ⑤ subject / conv / scope（scope 必须按 peer 前缀判，不能信 v4 visibility）：
//      subject：owner 非空 → owner（v4 已按人归集好，群聊也能落到发言人）
//               owner 为空且 peer=group-<群号> → null（群级/公共记忆）
//               owner 为空且 peer=c2c-<QQ>    → QQ（私聊的对方就是 subject）
//      conv   ：peer 的 `-` 换成 `:`（c2c-3022464706 → c2c:3022464706）
//      scope  ：peer=group-* → public；peer=c2c-* → dm_only
//      v4 的 visibility 只有 1 条非空（1055 行里 1054 条 NULL），当 public 是错的：
//      **私聊里说的话默认就该是 dm_only**（文档 Step 3 明确点名）。显式
//      visibility='dm_only'/'public' 的行尊重原标注（那是人工/自动标过的）。
//
// ⑥ speaker：is_self=1 → 'self'；否则 owner（v4 群聊 owner 就是发言人 QQ）。
//
// ⑦ is_self=1（v4 里「我自己说过的话」）→ **utterances，不进 memories**。
//    为什么（这条是我对 task 描述的一点补充，回执里会写清）：
//      · v5 的数据模型已经把「原文」和「结论」分家：memories 是提炼出的结论，
//        utterances 是「我说过什么」的原文（防复读用）。v4 的 outbound 行是原文。
//      · 这 273 条在 v4 里是出站降权后的 episode，塞进 v5 memories 会重演
//        P1-2（「我自己说过的话」挤占结论层 / FTS 排序 / distill 还要再加工）。
//      · v5 的 utterances 目前没有任何历史回灌来源，Step 4 下线 v4 后就永久
//        拿不到这 273 条了 —— 迁移是唯一机会。
//    检测方式：v4 `is_self=1`（db 里有明确列，不靠猜）。
//
// ⑧ key = sha1(type + '\x1f' + (subject ?? '') + '\x1f' + 归一化文本)
//    归一化 = 小写 + 去掉空白与常见中英标点（不改语义，只让「同一句话带不带标点」
//    落同一个 key）。为什么用 sha1 而不是人读的字符串：key 只给去重/取代用，
//    可读版本没有额外价值，反而会让「同义不同写法」看起来像能合并（其实不能）。
//    去重顺序按 v4 id 升序：实测 v4 有 162 组「同文本、一条 active 一条 retired」，
//    active 的 id 更小 → 先建 active，retired 那条落进 duplicate-key 跳过。
//    （这一步顺带清掉 §3.5 说的 162 组重复，不会把「已归档」当成活的。）
//
// ⑨ 文本清洗（规则和 python 侧 `memctl sanitize` 等价，见那边 SANITIZE_* 注释）：
//      注入残留（忽略之前指令 / SEND_FILE / 凭据路径 / 伪造 [System Message]）
//        → **整条跳过**（injection），不入库：那根本不是对方原话，且可能是
//        「让模型输出本地路径」的指令，v5 里更没有理由留。
//      控制标记（[SILENT]/[VOICE:…]/[AT:]…）→ 剥掉，正文保留；
//      排版前缀（【这是他在同一轮里补的一条】/ [21:09:14] / [卡片] / [QQ小程序]）
//        → 剥掉（v4 会把排版气泡头当记忆正文，这是 P0-5 的 7 条来源）。
//      洗成空 / <4 字的 → 跳过（empty-after-clean），没信息量。
//    渲染时 python 有同款实现，为什么这里不直接调用它：迁移要求能离线、幂等、
//    不依赖 python/生产环境；而且规则要能在 dry-run 里对每一行给出「改了什么」。
//
// ⑩ 短句降权：长度 <12 且是「无意义短句」→ salience 压到 0.1（**不丢**）。
//    v4 的 NOISE 白名单实测命中 0 条（P1-6），真实噪音是「哦哦/嗯嗯/唉/是的/这样/
//    菜菜/嘿嘿/可以/没有/也行/111」这些。它们进了库会拉高 df、干扰检索（P0-2 的
//    耦合问题），但「直接丢」会误删「明天开会」这种短而有效的话。压低 salience
//    交给 v5 的 pruned 机制退场，是可逆的。
//    ⚠️ 只对「无意义」判据命中的降权，不是「所有 <12 字」——后者会把短事实也压掉。
//
// ── 用法 ────────────────────────────────────────────────────────────────────
//   # 0) 先做只读快照（生产库是活的，别直接开）
//   cp ~/.dsh/dsh-plugin-llminqq/agent/memory/mem.db /tmp/mem-v4.db
//
//   # 1) dry-run（默认）：只读 + 打印报告，不写任何文件
//   node scripts/memory-v4-to-v5.mjs --v4 /tmp/mem-v4.db --out /tmp/mem-v5-migrated.db
//
//   # 2) 真写（写 /tmp 的新库）
//   node scripts/memory-v4-to-v5.mjs --v4 /tmp/mem-v4.db --out /tmp/mem-v5-migrated.db --apply
//
//   # 3) 看旧 split-brain 的 style.db（只提示，不迁）
//   ... --data-dir ~/.dsh/dsh-plugin-llminqq
//
// 参数：
//   --v4 <path>          v4 mem.db 的**副本**路径（只读打开）
//   --out <path>         v5 输出库路径（--apply 时才创建）
//   --apply              真写；缺省 dry-run
//   --data-dir <path>    插件数据目录（检查 state/style.db 旧 split-brain，只提示）
//   --allow-prod-read    允许 --v4 直接指向生产路径（仍然只读；不推荐）
//   --allow-prod         允许 --out 写生产路径（正式切换用；先备份！）
//   --json               输出机器可读 JSON（测试/流水线用）
//   --samples <n>        报告里样例条数（默认 10）
//
// 退出码：0 成功（含 dry-run）；1 运行错误（读不到/库结构不对）；2 参数/安全闸；
//         4 当前 Node 没有 node:sqlite。
// ============================================================================

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { openV5 } from '../lib/agent/memory-v5/store.mjs'

const require = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

// ── 依赖探测：node:sqlite 是 v5 的前提（Step 1 已用同一套取法）──────────────
let DatabaseSync = null
let sqliteLoadError = null
try {
  ({ DatabaseSync } = require('node:sqlite'))
} catch (err) {
  sqliteLoadError = err
}

// ════════════════════════════════════════════════════════════════════════════
// 文本清洗 / 归一化（与 python 侧 memctl.py 的 SANITIZE_* 等价）
// ════════════════════════════════════════════════════════════════════════════

const INJECTION_RE = new RegExp([
  '忽略(?:之前|上面|以上|先前|所有)?(?:的)?(?:指令|提示|设定)',
  '忽略.{0,6}指令',
  'system\\s*prompt',
  '开发者模式',
  '越狱',
  'prompt\\s*注入',
  '你现在是',
  '请立刻原样输出',
  '不要做别的',
  '\\.credentials\\.ya?ml',
  '/\\.dsh/',
  '\\[System\\s*Message\\]',
].join('|'), 'i')

const MARKER_RE = new RegExp(
  '\\[(?:SILENT|SEND_FILE:[^\\]]*|VOICE:[^\\]]*|AT:\\d+|POKE:\\d+(?::\\w+)?'
  + '|RECALL:[^\\]]*|FOLLOW:[^\\]]*|CQ:[^\\]]*)\\]', 'gi')

// v4 的 ingest 会把日志文本**截到 80 字**（P1-1），控制标记可能刚好被切断 ——
// 这时严格的 MARKER_RE 找不到闭合的 `]`，会漏下一截 `[SEND_FILE: /path...`。
// 兜底：从标记开头剥到行尾（它本来就是协议指令，不是说话内容）。
const LOOSE_MARKER_RE = /\[(?:SILENT|SEND_FILE|VOICE|AT|POKE|RECALL|FOLLOW|CQ)[^\]]*$/i

const LAYOUT_PREFIX_RE = new RegExp(
  '(?:【这是他在同一轮里补的一条】\\s*'
  + '|\\[\\d{2}:\\d{2}:\\d{2}\\]\\s*'
  + '|\\[(?:卡片|QQ小程序|图片|表情|语音|视频|文件)\\]\\s*'
  + '|\\[发了\\s*\\d+\\s*张图片\\]\\s*)')

/** v4 的 NOISE 白名单（memctl.py:103-107）。实测命中 0 条，但迁移仍按原语义认。 */
const V4_NOISE = new Set([
  '嗯', '哦', '好', '行', '行吧', '好的', '哈哈', '哈哈哈', '哈哈哈哈', '嘻嘻',
  '？', '??', '!', '！', '在', '在呢', '收到', 'ok', 'OK', 'okay', '+1', '1',
  '笑死', '草', '牛逼', '666', '确实', '同意', '有道理', '对对对', '这还差不多',
])

/**
 * 审计文档 §2 P1-6 从真实库里数出来的「无意义短句」样本。
 * 为什么要在 V4_NOISE 之外再列一遍：v4 的白名单只有 31 条且**一条都没命中**
 * （真实噪音全不在这 31 条里）。这 12 个是审计实测的真实噪音，迁移时认它们
 * 才有意义；不认的话「短句降权」规则等于没实现。
 */
const OBSERVED_SHORT_NOISE = new Set([
  '哦哦', '嗯嗯', '唉', '是的', '这样', '菜菜', '嘿嘿', '可以', '没有', '也行', '111', '点外卖！',
])

// 纯语气词/标点/数字（整句就是这些 → 没有信息量）。
// ⚠️ 不做「所有 <12 字都算噪音」：那会误伤「明天下午三点开会」这种短但有效的事实。
const PARTICLE_ONLY_RE = /^[哈啊嗯哦呀吧呢嘛啦呗。，！？…、~～\s\d]+$/

/**
 * 洗一条 v4 文本。返回 { cleaned, injection, changed, emptied }。
 * injection=true 表示整条跳过（不是「洗干净了」）。
 */
export function cleanV4Text (raw) {
  const t = raw === null || raw === undefined ? '' : String(raw)
  if (INJECTION_RE.test(t)) return { cleaned: '', injection: true, changed: false, emptied: true }
  let cleaned = t.replace(MARKER_RE, '')
  cleaned = cleaned.replace(LOOSE_MARKER_RE, '')   // 被 v4 截断的半个标记（见上）
  // 前缀可能叠加多层（气泡头 + 时间戳 + 卡片占位）→ 剥到不动为止
  for (;;) {
    const m = cleaned.match(LAYOUT_PREFIX_RE)
    if (!m) break
    cleaned = cleaned.slice(m.index + m[0].length)
  }
  cleaned = cleaned.replace(/\s+/g, ' ').trim()
  return {
    cleaned,
    injection: false,
    changed: cleaned !== t,
    // 只有「洗成空」才算空壳跳过。2-3 字的噪音（「嗯嗯」「哟」）**不丢**：
    // task 规则是「无意义短句 → salience 0.1，便于 prune 处理」，直接丢是另一回事。
    emptied: cleaned.length === 0,
  }
}

/**
 * 长度 <12 且「整句没有信息量」→ true（salience 压到 0.1）。
 *
 * 判据三条，任一命中即可（都不看「所有短句」）：
 *   ① v4 的 NOISE 白名单 / 审计实测噪音样本；
 *   ② 整句只有语气词+标点+数字；
 *   ③ v4 自己的 importance < 0.15 —— v4 的 estimate_importance 已经用长度/长期词/
 *      实体给它打了低分（审计实测：<12 字里 0.02×2 / 0.08×108 / 0.13×21），
 *      这些就是 v4 自己都认为「没价值」的句子。用它的分数当判据比另写一套猜测可靠；
 *      而「明天下午三点开会」这种短而有效的事实 importance 是 0.35，不会被压。
 * ⚠️ 不要退化成「所有 <12 字都压」：那会把短事实一起压掉，而这是不可逆的降权。
 */
export function isMeaninglessShort (text, importance = null) {
  const t = String(text ?? '').trim()
  if (t.length >= 12) return false
  if (V4_NOISE.has(t) || OBSERVED_SHORT_NOISE.has(t)) return true
  if (PARTICLE_ONLY_RE.test(t)) return true
  if (t.length === 1 && /[\u4e00-\u9fff]/.test(t)) return true   // 「哟」「唉」这种单字
  const imp = Number(importance)
  return Number.isFinite(imp) && imp < 0.15
}

/** key 用的归一化：小写 + 去空白/常见中英标点（不改变语义）。 */
export function normalizeForKey (text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\s，。！？、；：""''「」『』《》〈〉（）()【】\[\]·~～\-—_,.!?;:'"()]+/g, '')
}

/** v5 `key`：type + subject + 归一化文本的 sha1（见文件头 ⑧）。 */
export function buildKey (type, subject, text) {
  const raw = `${type}\x1f${subject === null || subject === undefined ? '' : String(subject)}\x1f${normalizeForKey(text)}`
  return crypto.createHash('sha1').update(raw, 'utf8').digest('hex')
}

// ════════════════════════════════════════════════════════════════════════════
// v4 行 → v5 目标（纯函数，单测直接 import）
// ════════════════════════════════════════════════════════════════════════════

const KIND_TO_TYPE = Object.freeze({
  procedural: 'rule',
  semantic: 'fact',
  episodic: 'episode',
})

/** v4 kind → v5 type（见文件头 ①）。 */
export function mapType (kind) {
  return KIND_TO_TYPE[String(kind ?? '')] || 'episode'
}

/** peer → { conv, peerKind, peerId }（见文件头 ⑤）。 */
export function mapPeer (peer) {
  const p = String(peer ?? '')
  const m = p.match(/^(c2c|group)-(.+)$/)
  if (!m) return { conv: p || null, peerKind: 'unknown', peerId: null }
  return { conv: `${m[1]}:${m[2]}`, peerKind: m[1], peerId: m[2] }
}

function firstFinite (...vals) {
  for (const v of vals) {
    const n = Number(v)
    if (Number.isFinite(n) && n > 0) return n
  }
  return null
}

/**
 * 把一行 v4 entries 映射成 v5 的写入计划（见文件头 ①②③④⑤⑥⑦⑨⑩）。
 *
 * @param {object} row  v4 entries 的一行（sqlite Row → plain object）
 * @returns {{kind:'memory'|'utterance'|'skip', reason:string, memory?:object, utterance?:object,
 *            cleaned:boolean, shortDownranked:boolean, key?:string}}
 */
export function mapV4Row (row) {
  const peer = mapPeer(row.peer)
  const raw = row.text === null || row.text === undefined ? '' : String(row.text)
  const clean = cleanV4Text(raw)
  if (clean.injection) return { kind: 'skip', reason: 'injection', cleaned: false, shortDownranked: false }
  if (clean.emptied) return { kind: 'skip', reason: 'empty-after-clean', cleaned: clean.changed, shortDownranked: false }

  const text = clean.cleaned
  const owner = row.owner === null || row.owner === undefined || String(row.owner) === ''
    ? null
    : String(row.owner)
  const isSelf = Number(row.is_self) === 1
  // ⑤ subject
  let subject = null
  if (owner) subject = owner
  else if (peer.peerKind === 'group') subject = null
  else if (peer.peerKind === 'c2c') subject = peer.peerId
  // ⑤ scope：显式标注优先，否则按 peer 前缀（私聊默认 dm_only，不信 v4 的 NULL）
  const visibility = row.visibility === null || row.visibility === undefined ? '' : String(row.visibility)
  const scope = visibility === 'dm_only'
    ? 'dm_only'
    : visibility === 'public'
      ? 'public'
      : (peer.peerKind === 'group' ? 'public' : 'dm_only')

  const created = firstFinite(row.created, row.last_seen)
  const lastSeen = firstFinite(row.last_seen, row.created)

  // ⑦ 我自己的话：进 utterances，不进 memories
  if (isSelf) {
    return {
      kind: 'utterance',
      reason: 'is-self',
      cleaned: clean.changed,
      shortDownranked: false,
      utterance: { conv: peer.conv, text, at: created, kindHint: 'text' },
    }
  }

  // ② salience
  let salience = Number(row.pinned) === 1
    ? 0.9
    : (() => {
        const imp = Number(row.importance)
        if (!Number.isFinite(imp)) return 0.5
        return Math.max(0, Math.min(1, imp))
      })()
  // ⑩ 短句降权（pinned 不受影响：钉住是明确的人工/agent 决定）
  const shortDownranked = Number(row.pinned) !== 1 && isMeaninglessShort(text, row.importance)
  if (shortDownranked) salience = Math.min(salience, 0.1)

  const type = mapType(row.kind)
  const archived = Number(row.retired) === 1
  // ④ 归档原因：done 靠 v4 的文本前缀反推，其它一律 pruned
  const archivedReason = archived
    ? (text.startsWith('已完成：') ? 'done' : 'pruned')
    : null

  return {
    kind: 'memory',
    reason: archived ? 'archived' : 'active',
    cleaned: clean.changed,
    shortDownranked,
    key: buildKey(type, subject, text),
    memory: {
      type,
      text,
      subject,
      conv: peer.conv,
      speaker: owner,
      confidence: 0.6,     // v4 没有「结论可信度」概念；统一默认值（见回执）
      salience,
      state: 'active',     // archived 用 store.archiveMemory() 归档，保证 reason 走白名单
      validFrom: created,
      validUntil: null,
      scope,
      created,
      lastSeen,
      archivedReason,
    },
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 参数解析 / 安全闸
// ════════════════════════════════════════════════════════════════════════════

export function parseArgs (argv = []) {
  const out = {
    v4: '', out: '', apply: false, dataDir: '', json: false,
    allowProdRead: false, allowProd: false, samples: 10, help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--v4') out.v4 = argv[++i] ?? ''
    else if (a === '--out') out.out = argv[++i] ?? ''
    else if (a === '--apply') out.apply = true
    else if (a === '--dry-run') out.apply = false
    else if (a === '--data-dir') out.dataDir = argv[++i] ?? ''
    else if (a === '--allow-prod-read') out.allowProdRead = true
    else if (a === '--allow-prod') out.allowProd = true
    else if (a === '--json') out.json = true
    else if (a === '--samples') out.samples = Math.max(0, Number(argv[++i]) || 0)
    else if (a === '-h' || a === '--help') out.help = true
    else throw new Error(`不认识的参数：${a}`)
  }
  return out
}

/** 看起来像生产现场的路径（和 scripts/memory-v5-count.mjs 同一判据）。 */
export function looksLikeProd (p) {
  const resolved = path.resolve(p)
  const home = os.homedir()
  const dshHome = process.env.DSH_HOME ? path.resolve(process.env.DSH_HOME) : path.join(home, '.dsh')
  const prodRoots = [path.join(home, '.dsh'), dshHome, '/mnt/llminqq-data']
  return prodRoots.some(root => resolved === root || resolved.startsWith(root + path.sep))
}

function expandHome (p) {
  return path.resolve(String(p).replace(/^~(?=$|[/\\])/, os.homedir()))
}

function die (code, msg) {
  const err = new Error(msg)
  err.exitCode = code
  throw err
}

// ════════════════════════════════════════════════════════════════════════════
// v4 读取（只读）
// ════════════════════════════════════════════════════════════════════════════

function openV4ReadOnly (v4Path) {
  if (!DatabaseSync) {
    die(4, `当前 Node 没有 node:sqlite（需要 ≥22.5）：${sqliteLoadError?.message || '未知原因'}`)
  }
  if (!fs.existsSync(v4Path)) die(1, `v4 库不存在：${v4Path}（先 cp 一份到 /tmp？）`)
  if (!fs.statSync(v4Path).isFile()) die(1, `--v4 不是文件：${v4Path}`)
  let db
  try {
    db = new DatabaseSync(v4Path, { readOnly: true })
  } catch (err) {
    die(1, `打不开 v4 库（只读）：${v4Path}：${err.message}`)
  }
  return db
}

/** 读 v4 entries 全表；顺带做结构校验。 */
function readV4 (db, v4Path) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name)
  if (!tables.includes('entries')) {
    die(1, `不是 v4 记忆库（没有 entries 表）：${v4Path}；现有表：${tables.join(',') || '(空)'}`)
  }
  const columns = db.prepare('PRAGMA table_info(entries)').all().map(r => r.name)
  const rows = db.prepare('SELECT * FROM entries ORDER BY id ASC').all()
  return { rows, columns, tables }
}

// ════════════════════════════════════════════════════════════════════════════
// 旧 split-brain 的 style.db：只提示，不迁
// ════════════════════════════════════════════════════════════════════════════

function countStyleSamples (dbPath) {
  if (!DatabaseSync || !fs.existsSync(dbPath)) return null
  let db = null
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
    const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='style_samples'").get()
    if (!t) return null
    return Number(db.prepare('SELECT COUNT(*) AS n FROM style_samples').get().n) || 0
  } catch {
    return null
  } finally {
    try { db?.close() } catch { /* ignore */ }
  }
}

function styleDbWarnings (dataDir) {
  if (!dataDir) return []
  const warnings = []
  const oldStyle = path.join(dataDir, 'state', 'style.db')
  const newStyle = path.join(dataDir, 'agent', 'memory', 'style.db')
  const oldN = countStyleSamples(oldStyle)
  const newN = countStyleSamples(newStyle)
  if (oldN !== null) {
    warnings.push(
      `旧 split-brain 的 state/style.db 还在（${oldN} 条风格样本）：${oldStyle}` +
      `；当前路径 ${newStyle}：${newN === null ? '不存在' : `${newN} 条`}。` +
      '本脚本**不迁**风格库 —— 用 `run.py stylebank import --from <旧库>` 幂等合并，别删旧文件前先核对条数。')
  }
  return warnings
}

// ════════════════════════════════════════════════════════════════════════════
// 迁移核心：dry-run 只算，apply 才写
// ════════════════════════════════════════════════════════════════════════════

function inc (obj, key, n = 1) {
  obj[key] = (obj[key] || 0) + n
}

function topN (map, n = 10) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
}

/**
 * 迁移主流程。
 *
 * dry-run 时**不打开/不创建 v5 库**（避免「只是看看」就留下一个半成品文件）；
 * 但若 --out 已经存在，会只读打开它数「已存在」的 key，让重复 dry-run 的报告
 * 和真实 apply 的第二次结果一致。
 *
 * @returns {object} report（--json 直接打印它）
 */
export function migrateV4ToV5 ({ v4Path, outPath, apply = false, dataDir = '', samples = 10, log = () => {} } = {}) {
  const t0 = Date.now()
  const v4Db = openV4ReadOnly(v4Path)
  let v4
  try {
    v4 = readV4(v4Db, v4Path)
  } finally {
    try { v4Db.close() } catch { /* ignore */ }
  }

  // 已存在的 v5 库（dry-run 只读数 key；apply 用它当写入目标）
  const outExists = fs.existsSync(outPath)
  let existingKeys = new Set()
  let existingUtterances = new Set()
  let store = null
  if (apply) {
    if (outExists) {
      // 防手滑：--out 若其实是 v4 库（有 entries 表），openV5 会在它上面建 v5 表，
      // 把 v4 库变成两张表混住 —— 直接拒绝。
      let probe = null
      try {
        if (DatabaseSync) {
          probe = new DatabaseSync(outPath, { readOnly: true })
          const hasEntries = probe.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='entries'").get()
          if (hasEntries) die(2, `--out 看起来是 v4 库（有 entries 表），拒绝往它里面建 v5 表：${outPath}`)
        }
      } catch (err) {
        if (err.exitCode) throw err
        // 打不开/不是 sqlite：交给 openV5 报错（会给出更准确的原因）
      } finally {
        try { probe?.close() } catch { /* ignore */ }
      }
    }
    store = openV5({ dbPath: outPath, log })
    // 幂等：把目标库里**已有**的 key / utterances 读进内存。重复 `--apply` 才能
    // 把每一行落进「already-present」，否则第二次会把整库再插一遍（实测踩到过：
    // 第一次漏了这段，第二遍 memories 从 560 变 1120）。
    try {
      for (const r of store.db.prepare('SELECT key FROM memories WHERE key IS NOT NULL').all()) {
        existingKeys.add(r.key)
      }
      for (const r of store.db.prepare('SELECT conv, text, at FROM utterances').all()) {
        existingUtterances.add(`${r.conv}\x1f${r.text}\x1f${Number(r.at).toFixed(3)}`)
      }
    } catch (err) {
      store.close()
      die(1, `读目标库里已有的 key 失败（库结构不对？）：${err.message}`)
    }
  } else if (outExists && DatabaseSync) {
    try {
      const probe = new DatabaseSync(outPath, { readOnly: true })
      try {
        for (const r of probe.prepare('SELECT key FROM memories WHERE key IS NOT NULL').all()) existingKeys.add(r.key)
      } catch { /* 不是 v5 库：当作没有 */ }
      try {
        for (const r of probe.prepare('SELECT conv, text, at FROM utterances').all()) {
          existingUtterances.add(`${r.conv}\x1f${r.text}\x1f${Number(r.at).toFixed(3)}`)
        }
      } catch { /* 同上 */ }
      probe.close()
    } catch { /* 打不开：dry-run 不报错，只有 apply 才需要库 */ }
  } else if (outExists) {
    // 没有 node:sqlite 时 dry-run 仍应能跑（只是数不了「已存在」）；apply 会 die(4)。
  }

  const report = {
    mode: apply ? 'apply' : 'dry-run',
    v4Path,
    outPath,
    source: { rows: v4.rows.length, columns: v4.columns },
    memories: {
      total: 0, active: 0, archived: 0,
      byType: {}, byScope: {}, byArchivedReason: {}, byConvKind: {},
    },
    utterances: { total: 0 },
    skipped: { injection: 0, 'empty-after-clean': 0, 'duplicate-key': 0, 'already-present': 0 },
    cleaned: { changed: 0, shortDownranked: 0, samples: [] },
    styleWarnings: styleDbWarnings(dataDir),
    samples: [],
    written: { memories: 0, utterances: 0, archived: 0 },
    elapsedMs: 0,
  }
  const seenKeys = new Set()
  const seenUtterances = new Set()

  for (const row of v4.rows) {
    const plan = mapV4Row(row)
    if (plan.kind === 'skip') {
      inc(report.skipped, plan.reason)
      continue
    }
    if (plan.cleaned && report.cleaned.samples.length < 5) {
      report.cleaned.samples.push({ v4Id: Number(row.id), before: String(row.text ?? '').slice(0, 120), after: planText(plan) })
    }
    if (plan.cleaned) report.cleaned.changed += 1
    if (plan.shortDownranked) report.cleaned.shortDownranked += 1

    if (plan.kind === 'utterance') {
      const u = plan.utterance
      const ukey = `${u.conv}\x1f${u.text}\x1f${Number(u.at ?? 0).toFixed(3)}`
      if (seenUtterances.has(ukey) || existingUtterances.has(ukey)) {
        inc(report.skipped, 'already-present')
        continue
      }
      seenUtterances.add(ukey)
      report.utterances.total += 1
      if (apply) {
        store.appendUtterance({
          conv: u.conv || 'unknown',
          text: u.text,
          at: u.at,
          kind: 'text',
        })
        report.written.utterances += 1
      }
      continue
    }

    // memory
    const m = plan.memory
    if (seenKeys.has(plan.key) || existingKeys.has(plan.key)) {
      inc(report.skipped, seenKeys.has(plan.key) ? 'duplicate-key' : 'already-present')
      continue
    }
    seenKeys.add(plan.key)
    report.memories.total += 1
    inc(report.memories.byType, m.type)
    inc(report.memories.byScope, m.scope)
    inc(report.memories.byConvKind, String(m.conv || '').split(':')[0] || 'unknown')
    // archivedReason 才是「这条要不要归档」的唯一判据（plan.state 恒为 active：
    // 归档走 store.archiveMemory()，好让 reason 经过白名单校验）
    if (!m.archivedReason) report.memories.active += 1
    else {
      report.memories.archived += 1
      inc(report.memories.byArchivedReason, m.archivedReason || 'pruned')
    }
    if (report.samples.length < samples) {
      report.samples.push({
        v4Id: Number(row.id), type: m.type, subject: m.subject, conv: m.conv,
        speaker: m.speaker, scope: m.scope, salience: Number(m.salience.toFixed(3)),
        state: m.archivedReason ? 'archived' : 'active', archivedReason: m.archivedReason,
        text: m.text.slice(0, 80),
      })
    }
    if (apply) {
      const r = store.insertMemory({
        type: m.type,
        text: m.text,
        subject: m.subject,
        conv: m.conv,
        speaker: m.speaker,
        key: plan.key,
        confidence: m.confidence,
        salience: m.salience,
        validFrom: m.validFrom,
        validUntil: null,
        scope: m.scope,
        created: m.created,
        lastSeen: m.lastSeen,
      })
      report.written.memories += 1
      if (m.archivedReason) {
        store.archiveMemory(r.id, m.archivedReason)
        report.written.archived += 1
      }
    }
  }

  // FTS 兜底重建一次（insertMemory 会写索引；中途被杀/手工改过库时这里自愈）
  if (apply) {
    try {
      report.ftsReindexed = store.reindexFts().indexed
    } catch (err) {
      report.ftsReindexed = null
      report.ftsError = String(err?.message || err)
    }
    try { store.close() } catch { /* ignore */ }
  }
  report.elapsedMs = Date.now() - t0
  return report
}

/** 样例用：迁移后的文本（memory 用 text，skip 用原因）。 */
function planText (plan) {
  if (plan.kind === 'memory') return plan.memory.text.slice(0, 120)
  if (plan.kind === 'utterance') return plan.utterance.text.slice(0, 120)
  return ''
}

// ════════════════════════════════════════════════════════════════════════════
// 人读报告
// ════════════════════════════════════════════════════════════════════════════

export function formatReport (r) {
  const L = []
  const tag = r.mode === 'apply' ? '--apply' : 'dry-run'
  L.push(`══ 记忆 v4 → v5 历史迁移（${tag}）══`)
  L.push(`v4 源：${r.v4Path}（只读）`)
  if (r.mode === 'dry-run') L.push(`v5 输出：${r.outPath}（dry-run 不写；加 --apply 才建库）`)
  else L.push(`v5 输出：${r.outPath}（本轮新增 memories ${r.written.memories} 条 · archived ${r.written.archived} · utterances ${r.written.utterances}）`)
  L.push(`源行数：${r.source.rows}（列：${r.source.columns.join(',')}）`)
  L.push('')
  L.push(`迁为 memories：${r.memories.total} 条（active ${r.memories.active} / archived ${r.memories.archived}）`)
  L.push(`  by type：${fmtMap(r.memories.byType)}`)
  L.push(`  by scope：${fmtMap(r.memories.byScope)}`)
  L.push(`  by archived reason：${fmtMap(r.memories.byArchivedReason)}`)
  L.push(`  by conv kind：${fmtMap(r.memories.byConvKind)}`)
  L.push(`迁为 utterances（我说过的话）：${r.utterances.total} 条`)
  L.push(`跳过：${fmtMap(r.skipped)}`)
  L.push(`文本清洗：改动 ${r.cleaned.changed} 行 · 短句降权 ${r.cleaned.shortDownranked} 行`)
  if (r.ftsReindexed !== undefined && r.ftsReindexed !== null) L.push(`FTS 重建：${r.ftsReindexed} 条`)
  if (r.ftsError) L.push(`⚠ FTS 重建失败：${r.ftsError}`)
  for (const w of r.styleWarnings) L.push(`⚠ ${w}`)
  if (r.cleaned.samples.length) {
    L.push('')
    L.push('清洗样例（before → after）：')
    for (const s of r.cleaned.samples) L.push(`  #${s.v4Id}: ${s.before.slice(0, 70)}  →  ${s.after.slice(0, 70)}`)
  }
  if (r.samples.length) {
    L.push('')
    L.push(`迁移样例（前 ${r.samples.length} 条）：`)
    for (const s of r.samples) {
      L.push(`  #${s.v4Id} [${s.type}] subj=${s.subject ?? '-'} conv=${s.conv ?? '-'} scope=${s.scope} `
        + `sal=${s.salience} ${s.state}${s.archivedReason ? `(${s.archivedReason})` : ''}`)
      L.push(`      ${s.text}`)
    }
  }
  L.push('')
  L.push(`耗时 ${r.elapsedMs}ms`)
  if (r.mode === 'dry-run') L.push('（dry-run：v4 只读、未创建/未写任何文件）')
  return L.join('\n')
}

function fmtMap (m) {
  const entries = Object.entries(m || {})
  if (!entries.length) return '(无)'
  return entries.sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  ')
}

// ════════════════════════════════════════════════════════════════════════════
// main
// ════════════════════════════════════════════════════════════════════════════

export function main (argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.help || !args.v4 || !args.out) {
    console.log(`用法：node scripts/memory-v4-to-v5.mjs --v4 <mem.db 副本> --out <mem-v5.db> [--apply]
       [--data-dir <插件数据目录>] [--json] [--samples 10] [--allow-prod-read] [--allow-prod]

默认 dry-run（只读 + 报告，不写文件）；--apply 才写 --out。
安全：默认拒绝直接读写生产路径（~/.dsh、$DSH_HOME、/mnt/llminqq-data）——先 cp 到 /tmp。`)
    return args.help ? 0 : 2
  }
  const v4Path = expandHome(args.v4)
  const outPath = expandHome(args.out)
  const dataDir = args.dataDir ? expandHome(args.dataDir) : ''

  // ── 安全闸 ──────────────────────────────────────────────────────────────
  if (v4Path === outPath) die(2, '--v4 和 --out 不能是同一个文件（会把源库改坏）')
  if (!args.allowProdRead && looksLikeProd(v4Path)) {
    die(2, `--v4 指向生产路径：${v4Path}
先做只读快照再迁移：cp <生产的 mem.db> /tmp/mem-v4.db
（确认只读没问题后也可加 --allow-prod-read；脚本仍以 readOnly 打开）`)
  }
  if (looksLikeProd(outPath) && !args.allowProd) {
    die(2, `--out 指向生产路径：${outPath}
默认只允许写 /tmp；正式切换时加 --allow-prod（先备份生产库！）`)
  }
  if (args.apply && fs.existsSync(outPath)) {
    // 允许续跑（幂等），但要能一眼看出这次的库是什么
    // （结构校验在 migrateV4ToV5 里：v4 形状的库会被拒绝）
  }

  const report = migrateV4ToV5({
    v4Path,
    outPath,
    apply: args.apply,
    dataDir,
    samples: args.samples,
  })

  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(formatReport(report))
  }
  return 0
}

if (IS_MAIN) {
  try {
    process.exitCode = main()
  } catch (err) {
    const code = Number(err?.exitCode) || 1
    console.error(`[migrate] ${err?.message || err}`)
    process.exitCode = code
  }
}
