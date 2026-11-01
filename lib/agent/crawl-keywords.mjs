// lib/agent/crawl-keywords.mjs —— 「让模型根据 persona 自己决定抓什么」
//
// ============================================================================
// 为什么需要这个（2026-11-01 用户需求）
// ============================================================================
//
// 原来的 B站语料抓取，关键词是**手填在 config.learning.crawlSources 里**的，
// 设置页上根本没有「关键词」这一栏 —— 用户看到的按钮只有「现在抓 2 个视频」，
// 抓什么完全由那份预置清单决定，跟机器人的人设毫无关系。
//
// 更糟的是：`runCrawl` 启动子进程时**没传 LLMINQQ_CONFIG**，脚本于是去读
// 包里那份 `lib/bridge/config.json` —— 那份里连 `learning` 段都没有，
// 所以 `crawlSources` 永远是 `[]`，dry-run 直接返回 `{"total":0}`。
// 用户实测「keyword 是空的」，根因就在这里。
//
// 这次要做的是：
//   ① 点「抓取」时，**让模型看着 persona 自己决定关键词**（而不是手填）；
//   ② 每次决定都**留历史**（选了什么、为什么、抓到多少）；
//   ③ 下次调用时**把历史喂回给模型**，让它知道「上次抓过这些，别重复」。
//
// ============================================================================
// 为什么把历史喂给模型很重要（不是「顺便存个日志」）
// ============================================================================
//
// 不喂历史，模型每轮都会挑「最典型」的那几个话题（历史/科技/生活），
// 于是语料永远是同一批词的重复采样，学不到新表达 —— 这是**采样退化**。
//
// 喂了历史之后，模型能主动避开抓过的方向。所以历史里要存三样东西：
//   · keywords   抓过的关键词（最直接的「别重复」信号）
//   · domain     领域（避免总在同一个分区打转）
//   · fetched    抓到多少 —— 抓 0 条的说明这个词搜不出有用内容，也该避开
//
// ============================================================================
// 为什么用宿主的 llm 服务，而不用 `dsh headless` 子进程
// ============================================================================
//
// 试过 `dsh --profile headless "任务"`，它报：
//     MISSING_CREDENTIAL: no API key for provider route "deepseek-official"
// 因为 headless profile 和 acp profile 一样，**只注册了宿主内置 provider**。
// 用户配的 trae/qodercn 都在 web profile 里 —— 起子进程等于又踩一遍
// 「provider 隔离」的坑（这个坑刚在 ACP 上修过）。
//
// 而插件本身就跑在宿主里，`ctx.get('llm')` 直接拿到**当前 profile 全部已注册路由**。
// 所以这里直接用宿主 llm，零额外进程、零隔离问题。
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'

/** 历史文件（和 crawl-state.json 放一起，但**独立文件**，不干扰限流计数）。 */
const HISTORY_FILE = 'crawl-history.json'
/** 最多保留多少轮历史（太多了会把 prompt 撑大，也会让模型只看老记录）。 */
const HISTORY_KEEP = 12

/** 已知领域（和 crawl-bili-comments.mjs 里的 DOMAINS 保持一致）。 */
export const DOMAINS = [
  'history', 'tech', 'life', 'game', 'food', 'science',
  'animation', 'music', 'movie', 'sports', 'knowledge', 'entertainment',
]

/**
 * 读抓取历史。
 * @param {string} stateDir 记忆状态目录
 * @returns {{runs: Array}}
 */
export function readCrawlHistory (stateDir) {
  const p = path.join(stateDir, HISTORY_FILE)
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'))
    if (Array.isArray(raw?.runs)) return raw
    return { runs: [] }
  } catch {
    return { runs: [] }
  }
}

/**
 * 追加一轮历史（保留最近 HISTORY_KEEP 轮）。
 * @param {string} stateDir
 * @param {{keywords: Array<{keyword:string, domain:string}>, reasoning?:string, fetched?:number, skipped?:number, model?:string}} run
 */
export function appendCrawlHistory (stateDir, run) {
  const hist = readCrawlHistory(stateDir)
  hist.runs.push({
    at: Date.now(),
    keywords: Array.isArray(run.keywords) ? run.keywords : [],
    domain: run.domain || '',
    reasoning: String(run.reasoning || '').slice(0, 500),
    fetched: Number(run.fetched || 0),
    skipped: Number(run.skipped || 0),
    model: run.model || '',
  })
  // 只留最近 N 轮
  if (hist.runs.length > HISTORY_KEEP) hist.runs = hist.runs.slice(-HISTORY_KEEP)
  try {
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(stateDir, HISTORY_FILE), JSON.stringify(hist, null, 2) + '\n', { mode: 0o600 })
  } catch { /* 写历史失败不该阻断抓取 */ }
  return hist
}

/**
 * 把历史渲染成给模型看的文本。
 *
 * 刻意做成「短、结构化」：只列关键词和结果，不贴推理原文 ——
 * 推理是给**人**看的（设置在页里展示），喂给模型只要「抓过什么、结果如何」。
 */
export function renderHistoryForPrompt (stateDir, { limit = 8 } = {}) {
  const hist = readCrawlHistory(stateDir)
  const runs = hist.runs.slice(-limit)
  if (runs.length === 0) return '（还没有抓取记录）'
  const lines = []
  for (const r of runs) {
    const when = new Date(r.at).toISOString().slice(0, 10)
    const kws = (r.keywords || []).map(k => `「${k.keyword}」(${k.domain || '?'})`).join('、') || '（无）'
    const result = r.fetched > 0 ? `抓到 ${r.fetched} 个视频` : '没抓到内容'
    lines.push(`- ${when} 抓过 ${kws} → ${result}`)
  }
  // 汇总「已经覆盖过的领域」，让模型别老在一个分区打转
  const used = new Set()
  for (const r of runs) for (const k of r.keywords || []) if (k.domain) used.add(k.domain)
  if (used.size) lines.push(`\n已覆盖过的领域：${[...used].join('、')}`)
  return lines.join('\n')
}

/** 给模型的系统提示。语气要求：只要 JSON，不要解释。 */
const SYSTEM_PROMPT = `你是 B站语料采集的选题助手。你要根据「机器人的人设」，挑选适合学习的 B站视频搜索关键词，目的是让机器人学到更自然的说话方式。

要求：
1. 只输出一个 JSON 对象，不要 markdown、不要解释、不要多余文字。
2. 格式：{"keywords":[{"keyword":"...","domain":"..."}],"reasoning":"..."}
3. keywords 数量 1-3 个。keyword 是**在 B站能搜出真实视频的中文短语**（像「Vlog 日常 记录」这种），不要写抽象主题词（像「生活」这种搜不出东西）。
4. domain 必须从这些里选一个：${DOMAINS.join(' / ')}
5. **不要重复历史里已经抓过的关键词，也尽量避免重复已覆盖的领域** —— 目的是扩大采样面，不是重复学习。
6. reasoning 一句话，说清为什么选这些（给用户看的）。`

/**
 * 让模型根据 persona + 历史，决定这轮抓什么。
 *
 * @param {object} opts
 * @param {object} opts.llm        宿主 llm 服务（ctx.get('llm')）
 * @param {string} opts.provider   模型路由
 * @param {string} opts.model
 * @param {string} [opts.reasoningEffort]
 * @param {string} opts.persona    人设全文
 * @param {string} opts.stateDir   记忆状态目录（读历史）
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ok:boolean, keywords?:Array, reasoning?:string, raw?:string, reason?:string}>}
 */
export async function decideKeywords ({ llm, provider, model, reasoningEffort, persona, stateDir, timeoutMs = 45000 }) {
  if (!llm || typeof llm.stream !== 'function') {
    return { ok: false, reason: '宿主没有提供 llm 服务，无法让模型决定关键词' }
  }
  if (!provider || !model) {
    return { ok: false, reason: '没配置模型路由（provider/model），无法让模型决定关键词' }
  }

  const historyText = renderHistoryForPrompt(stateDir)
  const userText = [
    '【机器人的人设】',
    String(persona || '').trim().slice(0, 4000) || '（人设为空，按一个普通年轻人来挑）',
    '',
    '【最近抓过的（不要重复）】',
    historyText,
    '',
    '请根据上面的人设和抓取历史，挑 1-3 个新的搜索关键词。只输出 JSON。',
  ].join('\n')

  // 收集流式文本
  let text = ''
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), Math.max(5000, timeoutMs))
  try {
    const stream = llm.stream({
      provider,
      model,
      ...(reasoningEffort ? { reasoningEffort } : {}),
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
      temperature: 0.8,     // 稍高一点，避免每轮都挑同样的话题
      maxTokens: 400,
    })
    for await (const chunk of stream) {
      if (ac.signal.aborted) break
      if (chunk?.type === 'text-delta') text += chunk.text
    }
  } catch (err) {
    clearTimeout(timer)
    return { ok: false, reason: `调用模型失败：${String(err?.message || err).slice(0, 200)}` }
  } finally {
    clearTimeout(timer)
  }

  const parsed = parseKeywordsJson(text)
  if (!parsed.ok) return { ok: false, reason: parsed.reason, raw: text }
  return { ok: true, keywords: parsed.keywords, reasoning: parsed.reasoning, raw: text }
}

/**
 * 从模型输出里抠出 JSON。
 *
 * 为什么要「抠」而不是直接 JSON.parse：模型经常把 JSON 包在 ```json ... ``` 里，
 * 或者在前面先写一句「好的」—— 直接 parse 必然失败。
 * 策略：去掉 markdown 代码块标记 → 找第一个 { 到最后一个 } → parse。
 */
export function parseKeywordsJson (text) {
  const raw = String(text || '')
  if (!raw.trim()) return { ok: false, reason: '模型返回空内容' }
  // 去 markdown 围栏
  let s = raw.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim()
  const i = s.indexOf('{')
  const j = s.lastIndexOf('}')
  if (i < 0 || j <= i) return { ok: false, reason: `模型输出里找不到 JSON：${raw.slice(0, 120)}` }
  s = s.slice(i, j + 1)
  let obj
  try { obj = JSON.parse(s) } catch (err) {
    return { ok: false, reason: `JSON 解析失败：${err.message}（原文 ${s.slice(0, 120)}）` }
  }
  const list = obj?.keywords
  if (!Array.isArray(list) || list.length === 0) {
    return { ok: false, reason: `JSON 里没有 keywords 数组：${s.slice(0, 120)}` }
  }
  const keywords = []
  for (const it of list.slice(0, 3)) {
    const kw = typeof it === 'string' ? it : String(it?.keyword || '')
    const domain = typeof it === 'string' ? 'unknown' : String(it?.domain || 'unknown')
    const k = kw.trim()
    if (!k) continue
    keywords.push({ keyword: k, domain: DOMAINS.includes(domain) ? domain : 'unknown' })
  }
  if (keywords.length === 0) return { ok: false, reason: '模型给的关键词全是空的' }
  return { ok: true, keywords, reasoning: String(obj?.reasoning || '').slice(0, 500) }
}

export { HISTORY_FILE, HISTORY_KEEP }
