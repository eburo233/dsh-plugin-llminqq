// 模型路由：枚举可用 provider、探测模型、维护「主路由 + 降级链」。
//
// 这个模块是设置页「配置模型 provider 和降级链」那部分的实现。
//
// 关键设计（为什么这么做）：
//
//   ① **provider 列表来自宿主的 llm 服务，不是插件自己维护一份**。
//      `ctx.llm.listProviders()` 返回当前真正注册了 adapter 的 provider。
//      自己维护一份的话，用户装了新插件（比如 dsh-our-free-model）这里看不到，
//      设置页会显示一个过时的列表 —— 那是最让人困惑的一类 bug。
//
//   ② **每个 provider 的模型列表是懒探测的**。`llm.listModels(provider)` 可能要发
//      网络请求（列模型接口），对所有 provider 一次性拉会卡住设置页。
//      所以只在你点开某个 provider 时才拉，并缓存结果。
//
//   ③ **降级链是「有序数组」，不是「优先级数字」**。顺序就是切换顺序，
//      设置页用上下移动改顺序。用数字表示优先级会让「2 和 3 之间插一个」变得难受。
//
//   ④ **探测（test）是独立动作**。保存配置不需要 provider 连得通 ——
//      用户可能先配好、回头再修网络。保存只校验结构，不校验连通性。

export const MODEL_CACHE_TTL = 5 * 60 * 1000

/** 把宿主的 provider 元数据整理成设置页要的形状。 */
export function describeProviders (llm) {
  if (!llm || typeof llm.listProviders !== 'function') {
    return { ok: false, reason: '宿主没有提供 llm 服务（这个插件需要在 DSH 里跑才有意义）', providers: [] }
  }
  let raw
  try {
    raw = llm.listProviders()
  } catch (err) {
    return { ok: false, reason: `枚举 provider 失败：${err.message}`, providers: [] }
  }
  const providers = (Array.isArray(raw) ? raw : []).map(p => ({
    // 不同版本字段名可能不同，都兜一下
    id: p.provider ?? p.id ?? '',
    displayName: p.displayName ?? p.name ?? p.provider ?? p.id ?? '',
    hasAdapter: true,
  })).filter(p => p.id)

  return { ok: true, providers }
}

/**
 * 列某个 provider 的模型（带缓存）。
 * 失败不抛错 —— 设置页要能把「这个 provider 的模型列表拿不到」显示出来，
 * 而不是整页白屏。
 */
export async function listModels (llm, provider, cache) {
  if (!llm || typeof llm.listModels !== 'function') {
    return { ok: false, reason: 'llm 服务不支持 listModels', models: [] }
  }
  const hit = cache?.get(provider)
  if (hit && Date.now() - hit.at < MODEL_CACHE_TTL) {
    return { ok: true, models: hit.models, cached: true }
  }
  try {
    const models = await llm.listModels(provider)
    const shaped = (Array.isArray(models) ? models : []).map(m => ({
      id: m.id,
      name: m.name || m.id,
      description: m.description || '',
      inputModalities: m.inputModalities || [],
    }))
    cache?.set(provider, { at: Date.now(), models: shaped })
    return { ok: true, models: shaped }
  } catch (err) {
    return { ok: false, reason: `拿模型列表失败：${err.message}`, models: [] }
  }
}

/**
 * 降级链的校验。
 *
 * 规则（故意宽松）：允许空项链（=不降级），但每一项必须 provider 和 model 都非空。
 * 不允许「只填 provider 不填 model」—— 那种半填状态在运行时会静默不生效，
 * 比直接报错更难查。
 */
export function validateRoutes (routes) {
  const issues = []
  if (!Array.isArray(routes)) {
    return { ok: false, issues: ['fallbackRoutes 必须是数组'] }
  }
  const seen = new Set()
  routes.forEach((r, i) => {
    const at = `第 ${i + 1} 条`
    if (!r || typeof r !== 'object') { issues.push(`${at}：不是对象`); return }
    if (!String(r.provider || '').trim()) issues.push(`${at}：provider 为空`)
    if (!String(r.model || '').trim()) issues.push(`${at}：model 为空`)
    const key = `${r.provider}/${r.model}`
    if (seen.has(key)) issues.push(`${at}：与前面重复（${key}）`)
    seen.add(key)
  })
  // 主路由不能出现在降级链里 —— 循环降级到自己是配错了
  return { ok: issues.length === 0, issues }
}

/**
 * 主路由 + 降级链的完整链路视图（设置页用它画那条链）。
 * 把「当前实际在用哪一条」也标出来，靠宿主 agentDefaultModel 读。
 */
export function chainView (cfg, hostSelection) {
  const main = {
    role: 'main',
    provider: cfg.dsh?.provider || hostSelection?.provider || '',
    model: cfg.dsh?.model || hostSelection?.model || '',
    reasoningEffort: cfg.dsh?.reasoningEffort || hostSelection?.reasoningEffort || '',
    source: cfg.dsh?.provider ? 'plugin-config' : (hostSelection?.provider ? 'host-default' : 'unset'),
  }
  const fallbacks = (cfg.dsh?.fallbackRoutes || []).map((r, i) => ({
    role: `fallback-${i + 1}`,
    provider: r.provider,
    model: r.model,
    reasoningEffort: r.reasoningEffort || '',
    source: 'plugin-config',
  }))
  return { main, fallbacks, failover: cfg.dsh?.failover || {} }
}

/**
 * 把设置页选的模型写进配置。
 * 同时也同步一份到宿主的 agentDefaultModel —— 这样「改 QQ 通道的模型」
 * 和「改 DSH 默认模型」不会变成两个互相矛盾的地方。
 */
export async function applyModelSelection (cfg, selection, agentDefaultModel) {
  const next = {
    ...cfg,
    dsh: {
      ...cfg.dsh,
      provider: selection.provider || cfg.dsh.provider,
      model: selection.model || cfg.dsh.model,
      reasoningEffort: selection.reasoningEffort || cfg.dsh.reasoningEffort,
    },
  }
  let hostSynced = false
  let hostError = ''
  if (selection.syncToHost && agentDefaultModel && typeof agentDefaultModel.saveSelection === 'function') {
    try {
      await agentDefaultModel.saveSelection({
        provider: next.dsh.provider,
        model: next.dsh.model,
        ...(next.dsh.reasoningEffort ? { reasoningEffort: next.dsh.reasoningEffort } : {}),
      })
      hostSynced = true
    } catch (err) {
      hostError = err.message
    }
  }
  return { config: next, hostSynced, hostError }
}
