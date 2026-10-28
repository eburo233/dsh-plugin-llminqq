// 官方 QQ Bot → 桥入站格式 的适配层。
//
// 背景（2026-10-28，任务 task-11）：NapCat（第三方协议端）连续掉线两次（35h / 48h），
// 且腾讯官方明确警告第三方工具可能导致封号，用户担心连坐大号。所以要在保留 NapCat
// 代码（随时可回滚）的前提下，接入腾讯官方 QQ Bot 接口。
//
// 这个文件**只做事件格式转换**，不连接、不鉴权、不发消息：
//   · 连接/鉴权/心跳/重连 —— 全交给官方链路（dsh-bridge → @tencent-connect/qqbot-nodejs）
//   · 业务逻辑（人格/记忆/情绪/回复） —— 全复用 bridge/index.js 的 handleInbound
// 这样官方 bot 只是「换了一个入站来源」，桥的核心一行都不用改。
//
// ⚠️ 身份体系（这是接入官方 bot 最大的坑，必须先记住）：
//   官方事件里**拿不到真实 QQ 号**，只有 OpenID：
//     · 群聊 → author.member_openid（群成员 OpenID）
//     · 私聊 → author.user_openid（用户 OpenID）
//   这两个 ID 是**应用隔离的哈希**，而且**群聊/私聊是两套不同的标识**，
//   同一个真人在群里和私聊里拿到的 openid 不一样。
//   后果：现有记忆系统按 owner=真实QQ号 归集（跨通道按人检索）在这条通道上**失效**。
//   本文件的做法：不假装它是 QQ 号，而是**显式标注**（idKind: 'openid'），
//   让上层能区分「这是真实QQ号」还是「这是官方 openid」，避免把 openid 写进
//   mem.db 的 owner 列污染按人检索。
//
// 官网依据：
//   https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_message_create.html
//   https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_at_message_create.html
//   https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/c2c_message_create.html

// 官方内容里的 @ 会被替换成 `<@member_openid>` / `<@all>` 形式（见官方文档）。
const MENTION_RE = /<@!?([A-Za-z0-9_-]+)>/g

/**
 * 把官方事件里的 attachments 转成桥的图片段。
 *
 * 官方图片是 URL（multimedia.nt.qq.com.cn/download?...），桥的图片处理逻辑认
 * `{ type:'image', data:{ url } }`，所以直接映射即可（桥会自己下载到 staging）。
 * 语音（content_type='voice'）带 `voice_wav_url`（SILK 已转 WAV）—— 桥不认语音段，
 * 这里降级成文本提示，不假装能播。
 */
export function flattenAttachments(attachments) {
  const images = []
  const others = []
  for (const a of attachments ?? []) {
    const ct = String(a?.content_type ?? '')
    if (ct.startsWith('image/')) {
      if (a?.url) images.push({ type: 'image', data: { url: String(a.url), file: String(a.url) } })
    } else if (ct === 'voice') {
      // 桥没有语音识别入站通道；官方给了 ASR 参考文本就直接用，这是最诚实的降级
      const asr = String(a?.asr_refer_text ?? '').trim()
      others.push(asr ? `[语音] ${asr}` : '[语音消息（没有转写文本）]')
    } else if (ct === 'video/mp4') {
      others.push('[视频消息]')
    } else if (ct === 'file') {
      others.push(`[文件] ${a?.filename ?? ''}`.trim())
    } else {
      others.push(`[附件 ${ct || '未知类型'}]`)
    }
  }
  return { images, others }
}

/**
 * 把官方消息的 content 转成桥能理解的消息段数组。
 *
 * 官方 content 是**纯字符串**（不是分段数组），@ 以 `<@openid>` 内联文本形式出现。
 * 桥的 flattenMessage 期望 OneBot 的分段数组，所以这里负责「文本 → 分段」：
 *   · `<@openid>`  → { type:'at', data:{ qq } }  （桥靠 atList 判断「@了谁」）
 *   · `<@all>`    → 文本（@全体不是 @我）
 *   · 其余        → { type:'text', data:{ text } }
 *
 * ⚠️ 注意：官方 content 里的 @ 只是**文本占位**，桥的 atMe 判定靠
 * `qq === String(gateway.selfId)`。官方通道的 selfId 是 openid，不是 QQ 号，
 * 所以**不要**指望桥自己判断「有没有 @ 我」——
 * 事件类型 GROUP_AT_MESSAGE_CREATE 本身就是权威信号（官方只在真 @ 时才发这个事件），
 * 见 toInboundEvent() 里的 atMe 显式注入。
 */
export function contentToSegments(content, attachments) {
  const text = String(content ?? '')
  const segs = []
  let last = 0
  MENTION_RE.lastIndex = 0
  let m
  while ((m = MENTION_RE.exec(text)) !== null) {
    const before = text.slice(last, m.index)
    if (before) segs.push({ type: 'text', data: { text: before } })
    const id = m[1]
    if (id === 'all') segs.push({ type: 'text', data: { text: '@全体成员' } })
    else segs.push({ type: 'at', data: { qq: id } })
    last = m.index + m[0].length
  }
  const tail = text.slice(last)
  if (tail) segs.push({ type: 'text', data: { text: tail } })

  const { images, others } = flattenAttachments(attachments)
  segs.push(...images)
  if (others.length) segs.push({ type: 'text', data: { text: (segs.length && others.length ? ' ' : '') + others.join(' ') } })
  return segs
}

/**
 * 官方事件 → 桥的入站事件（handleInbound 期望的形状）。
 *
 * 官方事件类型（都是 intent 1<<25 = GROUP_AND_C2C）：
 *   GROUP_AT_MESSAGE_CREATE  —— 群里 @ 了 bot（**官方只在真 @ 时推送**）
 *   GROUP_MESSAGE_CREATE     —— 群里任意消息（**需群主授权「接收全量消息」**，否则不推）
 *   C2C_MESSAGE_CREATE       —— 私聊
 *
 * 返回 null = 这条不该处理（未知类型 / bot 自己发的 / 缺关键字段）。
 *
 * @param {object} ev       官方事件体（ws 的 d 字段）
 * @param {string} eventType 事件名（ws 的 t 字段）
 * @param {object} opts
 * @param {string} [opts.selfOpenid] bot 自己的 openid（用于过滤自己发的消息）
 * @param {boolean} [opts.requireMention=true] 群聊是否只处理 @ 的
 * @returns {object|null}
 */
export function toInboundEvent(ev, eventType, opts = {}) {
  if (!ev || typeof ev !== 'object') return null
  const isGroupAt = eventType === 'GROUP_AT_MESSAGE_CREATE'
  const isGroupAll = eventType === 'GROUP_MESSAGE_CREATE'
  const isC2C = eventType === 'C2C_MESSAGE_CREATE'
  if (!isGroupAt && !isGroupAll && !isC2C) return null

  const isGroup = isGroupAt || isGroupAll

  // 发言人标识：群聊用 member_openid，私聊用 user_openid（官方唯一可用标识）
  const senderOpenid = String(
    isGroup ? (ev.author?.member_openid ?? ev.author?.id ?? '') : (ev.author?.user_openid ?? ev.author?.id ?? ''),
  )
  if (!senderOpenid) return null
  // 过滤 bot 自己（官方事件里 author.bot=true，或 openid 与自己相同）
  if (ev.author?.bot === true) return null
  if (opts.selfOpenid && senderOpenid === String(opts.selfOpenid)) return null

  const groupOpenid = isGroup ? String(ev.group_openid ?? '') : ''
  if (isGroup && !groupOpenid) return null

  // 群里不 @ 的消息：当 requireMention=true 时直接丢弃（与 dsh-qqbot 的 mentionGate 语义一致）
  // 注意 isGroupAt 一定是「@了」，isGroupAll 则不一定 —— 后者正是旁听来源。
  const wasMentioned = isGroupAt
  if (isGroup && opts.requireMention !== false && !wasMentioned) return null

  const message = contentToSegments(ev.content, ev.attachments)

  return {
    post_type: 'message',
    // 用官方事件类型当子类型，便于日志区分「@触发」还是「旁听」
    sub_type: eventType,
    message_type: isGroup ? 'group' : 'c2c',
    self_id: opts.selfId ?? null,
    // 桥用 evt.user_id 当「发言人 QQ」——这里给的是 openid，**不是 QQ 号**。
    // 所以额外带 idKind 标记，上层（记忆/白名单/@）必须据此区别对待，不要混用。
    user_id: senderOpenid,
    idKind: 'openid',
    group_id: isGroup ? groupOpenid : undefined,
    sender: {
      user_id: senderOpenid,
      nickname: String(ev.author?.username ?? ''),
      card: String(ev.author?.username ?? ''),
      role: ev.author?.member_role ?? undefined,
    },
    // 官方的时间是 RFC3339 字符串，桥只看 message_id / 内容，这里保留原始值
    time: ev.timestamp ?? null,
    message_id: String(ev.id ?? ''),
    message,
    raw_message: String(ev.content ?? ''),
    // 官方权威信号：GROUP_AT_MESSAGE_CREATE 就意味着 @ 了 bot
    // （content 里的 @ 只是文本占位，桥的 atMe 判定在这个通道不可靠，直接注入）
    _officialAtMe: wasMentioned,
    _official: {
      eventType,
      groupOpenid,
      senderOpenid,
      // 旁听标记：true = 群里没 @ 我们的普通消息（仅当群主授权全量消息时才可能收到）
      overheard: isGroup && !wasMentioned,
      quoteIdx: extractRefIdx(ev.message_scene?.ext),
    },
  }
}

/**
 * 官方事件 → 桥的 peerKey。
 *
 * ⚠️ **必须带 `official:` 前缀**，理由很实际：
 *   桥原生的 peerKey 是 `${scope}:${id}`，NapCat 通道下 id 是**真实 QQ 号**（如 `c2c:3022464706`）。
 *   官方通道下 id 是 **openid**（32 位十六进制）。虽然格式上很难撞，但一旦撞了就会
 *   **串记忆**——把 openid 的对话写进 QQ 号那份记忆里，或者反过来。
 *   加前缀是最便宜、最不可能出错的分隔：两套身份体系永远各在各的命名空间。
 *
 *   群聊用 group_openid（不是成员 openid）：peerKey 表示「哪个会话」，
 *   group 会话的身份是群，成员身份另放在 user_id 里。
 */
export function officialPeerKey (inboundEv) {
  if (!inboundEv) return null
  if (inboundEv.message_type === 'group') {
    return `official:group:${inboundEv.group_id ?? ''}`
  }
  return `official:c2c:${inboundEv.user_id ?? ''}`
}

/** 从 peerKey 反解出 scope（给上层做分支用，避免到处切字符串）。 */
export function parseOfficialPeerKey (peerKey) {
  const m = /^official:(c2c|group):(.+)$/.exec(String(peerKey ?? ''))
  if (!m) return null
  return { scope: m[1], id: m[2], peerKey: String(peerKey) }
}

/**
 * 从 message_scene.ext 里取引用消息索引（官方把引用放在这里，不是独立的段）。 */
function extractRefIdx(ext) {
  if (!Array.isArray(ext)) return null
  for (const s of ext) {
    const m = /^ref_msg_idx=([^\s]+)/.exec(String(s))
    if (m) return m[1]
  }
  return null
}

/**
 * 官方事件 → 桥的**出站**目标（发消息用）。
 *
 * 官方发消息要 openid + msg_id（被动回复锚点），桥原本要 QQ 号 + message_id，
 * 所以出站也需要一层映射。这里只产出参数，不真发。
 *
 * ⚠️ 被动回复限制（官方文档）：群聊 5 分钟内、每条消息最多回 5 次；私聊 60 分钟、4 次。
 * 超限必须降级主动消息（不带宽 msg_id），否则发送会失败。
 */
export function toReplyTarget(inboundEv, text) {
  if (!inboundEv) return null
  const isGroup = inboundEv.message_type === 'group'
  const target = isGroup ? String(inboundEv.group_id ?? '') : String(inboundEv.user_id ?? '')
  if (!target) return null
  return {
    scope: isGroup ? 'group' : 'c2c',
    openid: target,
    // 被动回复锚点（官方叫 msg_id，值就是入站事件的 id）
    msgId: inboundEv.message_id || null,
    msgType: 0,          // 0 = 文本
    content: String(text ?? ''),
    endpoint: isGroup ? `/v2/groups/${target}/messages` : `/v2/users/${target}/messages`,
  }
}

/**
 * 能力边界自述（给日志/健康检查/文档用）。
 * 这些数字全部来自官方文档，不是估的：
 *   https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html
 */
export const OFFICIAL_BOT_LIMITS = Object.freeze({
  // 收：群全量消息需要群主在手机QQ「设置权限」里授权「接收全量消息」，否则只会收到 @ 事件
  groupOverheardNeedsOwnerGrant: true,
  // 主动消息：群 1000 条/群/天；私聊 1000 条/用户/天
  proactivePerDayPerGroup: 1000,
  proactivePerDayPerUser: 1000,
  proactivePerMinPerGroup: 20,
  proactivePerMinPerBot: 60,
  // 被动回复窗口/次数
  passiveReplyTtlMsGroup: 5 * 60 * 1000,
  passiveReplyTtlMsC2C: 60 * 60 * 1000,
  passiveReplyMaxGroup: 5,
  passiveReplyMaxC2C: 4,
  // 撤回：2 分钟内
  recallTtlMs: 2 * 60 * 1000,
  // 身份：只有 openid，没有真实 QQ 号
  hasRealQqNumber: false,
})
