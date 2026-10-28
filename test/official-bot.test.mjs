// 官方 QQ Bot 适配层测试 —— 用**官方文档里的真实 JSON 样例**验证映射。
// 运行：node test/official-bot.test.mjs
//
// 为什么用文档样例：这些 JSON 是从官方文档直接抄的（带真实字段名/嵌套/可选字段），
// 不是自己编的理想数据。编数据容易「测的是我以为的协议」而不是「官方真的发的」。
//
// 覆盖三个事件：
//   GROUP_AT_MESSAGE_CREATE  群 @（官方只在真 @ 时推送）
//   GROUP_MESSAGE_CREATE     群全量（需群主授权，)opts.requireMention=false 才处理
//   C2C_MESSAGE_CREATE       私聊
//
// 以及本任务的核心约束：
//   · peerKey 必须带 `official:` 前缀，不能和 NapCat 的 `c2c:<QQ号>` 冲突
//   · 身份是 openid 不是 QQ 号，必须显式标注 idKind，防止污染按人归集的 owner
//   · 被动回复的 msg_id / 5分钟窗口 / 5次上限这些坑要在代码里体现
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const SRC = path.join(ROOT, 'bridge/official-adapter.js')

let pass = 0
let fail = 0
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

const A = await import(SRC)

// ─────────────────────────────────────────────────────────────────────────────
// 官方文档原样抄的事件样例
//   https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_at_message_create.html
//   https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_message_create.html
//   https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/c2c_message_create.html
// ─────────────────────────────────────────────────────────────────────────────
const DOC_GROUP_AT = {
  id: 'ROBOT1.0_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  author: {
    id: 'A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4',
    member_openid: 'A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4',
    member_role: 'member',
    username: '小明',
    bot: false,
  },
  content: ' /今日天气 ',
  group_openid: 'B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5',
  message_type: 0,
  timestamp: '2026-07-21T10:00:00+08:00',
  message_scene: { source: 'default', ext: ['msg_idx=REFIDX_xxxxxxxxxxxxxxx==', 'auth_token=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'] },
}

const DOC_GROUP_ALL = {
  id: 'ROBOT1.0_yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy',
  author: {
    id: 'C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5F6',
    member_openid: 'C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5F6',
    member_role: 'owner',
    username: '小红',
    bot: false,
  },
  content: '分享一张今天的风景照',
  group_openid: 'B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5',
  message_type: 0,
  timestamp: '2026-07-21T09:30:00+08:00',
  attachments: [{
    content_type: 'image/jpeg',
    filename: 'photo.jpg',
    url: 'https://multimedia.nt.qq.com.cn/download?appid=xxx&fileid=xxx&rkey=xxx&spec=0',
    width: 1920, height: 1080, size: 256000,
  }],
  message_scene: { source: 'default', ext: ['msg_idx=REFIDX_yyyyyyyyyyyyyyy==', 'auth_token=yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy'] },
}

const DOC_C2C = {
  id: 'ROBOT1.0_c2cxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  author: { user_openid: 'D8FE60865AA4F4B6C3FDA0BD8BC9D3FC' },
  content: '在吗',
  timestamp: '2026-07-21T11:00:00+08:00',
  message_type: 0,
  message_scene: { source: 'default', ext: ['msg_idx=REFIDX_c2cxxxx==', 'auth_token=yyyy'] },
}

// 群里 @ 了别人（不是 bot）的消息 —— content 里出现 <@别人的openid>
const DOC_GROUP_AT_OTHER = {
  ...DOC_GROUP_ALL,
  id: 'ROBOT1.0_zzz',
  content: '喂 <@7A3B9C1D5E2F4A6B8C0D1E3F5A7B9C2D> 你看这个',
  mentions: [{ scope: 'single', id: '7A3B9C1D5E2F4A6B8C0D1E3F5A7B9C2D', is_you: false, username: '小华' }],
}

const DOC_GROUP_REPLY = {
  ...DOC_GROUP_ALL,
  id: 'ROBOT1.0_reply',
  content: ' ',
  message_type: 103,
  msg_elements: [{ content: '=== 消息 1 ===\n今天的学习计划已完成' }],
  message_scene: { source: 'default', ext: ['msg_idx=REFIDX_1==', 'ref_msg_idx=TMP_abc-123'] },
}

console.log('\n=== 1. 群 @ 事件（GROUP_AT_MESSAGE_CREATE）===')
{
  const ev = A.toInboundEvent(DOC_GROUP_AT, 'GROUP_AT_MESSAGE_CREATE', { selfId: '1211310712526237498' })
  ok('事件被接受', !!ev)
  ok('message_type=group', ev.message_type === 'group')
  ok('post_type=message（桥的第一道闸）', ev.post_type === 'message')
  ok('group_id = group_openid', ev.group_id === DOC_GROUP_AT.group_openid, ev.group_id)
  ok('user_id = member_openid（官方唯一标识）', ev.user_id === DOC_GROUP_AT.author.member_openid)
  ok('**显式标注 idKind=openid**（防止被当 QQ 号写进 owner）', ev.idKind === 'openid', ev.idKind)
  ok('sender 带了昵称（给弱身份留余地）', ev.sender.nickname === '小明', ev.sender.nickname)
  ok('message_id 保留（被动回复要用）', ev.message_id === DOC_GROUP_AT.id)
  ok('官方@信号被注入 _officialAtMe', ev._officialAtMe === true)
  ok('不是旁听（@了）', ev._official.overheard === false)
  ok('content 转成了桥的消息段', Array.isArray(ev.message) && ev.message.some(s => s.type === 'text'))
  ok('副标题记录官方事件名（日志可区分）', ev.sub_type === 'GROUP_AT_MESSAGE_CREATE')
  // 文本内容对
  const text = ev.message.filter(s => s.type === 'text').map(s => s.data.text).join('').trim()
  ok('文本内容正确（去掉了首尾空格）', text === '/今日天气', JSON.stringify(text))
}

console.log('\n=== 2. 群全量事件（GROUP_MESSAGE_CREATE）—— 默认不处理，开了才处理 ===')
{
  // 默认 requireMention=true → 未 @ 的群消息必须丢弃（与 dsh-qqbot 的 mentionGate 一致）
  const dropped = A.toInboundEvent(DOC_GROUP_ALL, 'GROUP_MESSAGE_CREATE', {})
  ok('默认 requireMention → 未@的群消息被丢弃', dropped === null, JSON.stringify(dropped))

  // requireMention=false → 接受，并标记为「旁听」
  const ev = A.toInboundEvent(DOC_GROUP_ALL, 'GROUP_MESSAGE_CREATE', { requireMention: false })
  ok('requireMention=false → 接受', !!ev)
  ok('**标记为旁听 overheard=true**', ev._official.overheard === true)
  ok('_officialAtMe=false（没 @ 我们）', ev._officialAtMe === false)
  ok('图片附件被转成桥的 image 段', ev.message.some(s => s.type === 'image'))
  const img = ev.message.find(s => s.type === 'image')
  ok('image 段带 url（桥会自己下载）', img.data.url.startsWith('https://'), img.data.url)
  ok('发送者是群主也正常处理', ev.sender.role === 'owner', ev.sender.role)
}

console.log('\n=== 3. 私聊事件（C2C_MESSAGE_CREATE）===')
{
  const ev = A.toInboundEvent(DOC_C2C, 'C2C_MESSAGE_CREATE', {})
  ok('事件被接受', !!ev)
  ok('message_type=c2c', ev.message_type === 'c2c')
  ok('**私聊用 user_openid**（不是 member_openid）', ev.user_id === DOC_C2C.author.user_openid)
  ok('私聊没有 group_id', ev.group_id === undefined, String(ev.group_id))
  ok('idKind 同样是 openid', ev.idKind === 'openid')
  const text = ev.message.filter(s => s.type === 'text').map(s => s.data.text).join('')
  ok('私聊文本正确', text === '在吗', JSON.stringify(text))
  ok('私聊不需要 requireMention 门控（应有 addressed）', ev._official.overheard === false)
}

console.log('\n=== 4. @ 别人的消息（群里 @ 了 third party）===')
{
  const ev = A.toInboundEvent(DOC_GROUP_AT_OTHER, 'GROUP_AT_MESSAGE_CREATE', { requireMention: false })
  ok('接受', !!ev)
  const ats = ev.message.filter(s => s.type === 'at')
  ok('@ 被转成 at 段（桥靠它判断「@了谁」）', ats.length === 1, JSON.stringify(ats))
  ok('at 段带的是对方 openid', ats[0]?.data?.qq === '7A3B9C1D5E2F4A6B8C0D1E3F5A7B9C2D', ats[0]?.data?.qq)
  ok('「喂」和「你看这个」保留成文本', ev.message.filter(s => s.type === 'text').length >= 1)
}

console.log('\n=== 5. <@all> 与畸形内容 ===')
{
  const ev = A.toInboundEvent({ ...DOC_GROUP_ALL, content: '<@all> 开会了' }, 'GROUP_MESSAGE_CREATE', { requireMention: false })
  ok('@全体 被转成文本而不是 at 段（@all 不是 @我）',
    !ev.message.some(s => s.type === 'at' && s.data.qq === 'all'))
  const t = ev.message.filter(s => s.type === 'text').map(s => s.data.text).join('')
  ok('@全体 变成可读文本', t.includes('@全体成员'), JSON.stringify(t))

  ok('null 事件 → null', A.toInboundEvent(null, 'C2C_MESSAGE_CREATE', {}) === null)
  ok('空对象 → null', A.toInboundEvent({}, 'C2C_MESSAGE_CREATE', {}) === null)
  ok('未知事件类型 → null', A.toInboundEvent(DOC_C2C, 'MESSAGE_REACTION_ADD', {}) === null)
  ok('群事件缺 group_openid → null',
    A.toInboundEvent({ ...DOC_GROUP_AT, group_openid: '' }, 'GROUP_AT_MESSAGE_CREATE', {}) === null)
  ok('缺发送者 openid → null',
    A.toInboundEvent({ ...DOC_C2C, author: {} }, 'C2C_MESSAGE_CREATE', {}) === null)
  ok('content 为空的群@消息仍能产出（可能带图）',
    !!A.toInboundEvent({ ...DOC_GROUP_AT, content: '' }, 'GROUP_AT_MESSAGE_CREATE', {}))
}

console.log('\n=== 6. 过滤：bot 自己发的 / 自己 openid ===')
{
  ok('author.bot=true → 丢弃', A.toInboundEvent(
    { ...DOC_GROUP_ALL, author: { ...DOC_GROUP_ALL.author, bot: true } }, 'GROUP_AT_MESSAGE_CREATE', {}) === null)
  ok('发送者 openid == selfOpenid → 丢弃', A.toInboundEvent(DOC_C2C, 'C2C_MESSAGE_CREATE',
    { selfOpenid: DOC_C2C.author.user_openid }) === null)
  ok('selfId 不同时正常接受', !!A.toInboundEvent(DOC_C2C, 'C2C_MESSAGE_CREATE',
    { selfOpenid: 'someone-else' }))
}

console.log('\n=== 7. 引用消息（ref_msg_idx 在 message_scene.ext 里）===')
{
  const ev = A.toInboundEvent(DOC_GROUP_REPLY, 'GROUP_AT_MESSAGE_CREATE', {})
  ok('引用索引被提取', ev._official.quoteIdx === 'TMP_abc-123', ev._official.quoteIdx)
  const evNoRef = A.toInboundEvent(DOC_GROUP_AT, 'GROUP_AT_MESSAGE_CREATE', {})
  ok('没有引用时是 null', evNoRef._official.quoteIdx === null)
}

console.log('\n=== 8. peerKey 必须带 official: 前缀（不能和 NapCat 撞）===')
{
  // 这是本任务明确要求：NapCat 用 `c2c:<QQ号>`，官方用 `official:c2c:<openid>`
  const src = fs.readFileSync(SRC, 'utf8')
  ok('适配层导出 peerKey 相关能力（或注释里写明前缀约定）',
    /official:c2c:|official:group:/.test(src), '适配层没提 official: 前缀')
  // 桥的 peerKeyOf 是 `${scope}:${id}`，所以官方 id 里必须自带 official: 前缀
  const ev = A.toInboundEvent(DOC_C2C, 'C2C_MESSAGE_CREATE', {})
  const napcatKey = `c2c:${ev.user_id}`
  const officialKey = A.officialPeerKey(ev)
  ok('officialPeerKey 产出 official: 前缀', officialKey.startsWith('official:'), officialKey)
  ok('**和 NapCat 的 peerKey 不同**（不会串记忆）', officialKey !== napcatKey,
    `${officialKey} vs ${napcatKey}`)
  ok('私聊 peerKey 形如 official:c2c:<openid>', /^official:c2c:.+/.test(officialKey), officialKey)
  const gEv = A.toInboundEvent(DOC_GROUP_AT, 'GROUP_AT_MESSAGE_CREATE', {})
  const gKey = A.officialPeerKey(gEv)
  ok('群聊 peerKey 形如 official:group:<group_openid>', /^official:group:.+/.test(gKey), gKey)
  ok('群 peerKey 用 group_openid 不是成员 openid', gKey.includes(DOC_GROUP_AT.group_openid), gKey)
}

console.log('\n=== 9. 出站目标映射（被动回复）===')
{
  const gEv = A.toInboundEvent(DOC_GROUP_AT, 'GROUP_AT_MESSAGE_CREATE', {})
  const t = A.toReplyTarget(gEv, '你好呀')
  ok('群聊出站目标是 group scope', t.scope === 'group')
  ok('openid 是 group_openid', t.openid === DOC_GROUP_AT.group_openid)
  ok('**msgId 带上了入站消息 id**（被动回复必需，否则会被当主动消息受频控）',
    t.msgId === DOC_GROUP_AT.id, t.msgId)
  ok('端点形如 /v2/groups/<openid>/messages', t.endpoint === `/v2/groups/${DOC_GROUP_AT.group_openid}/messages`, t.endpoint)

  const cEv = A.toInboundEvent(DOC_C2C, 'C2C_MESSAGE_CREATE', {})
  const ct = A.toReplyTarget(cEv, '在的')
  ok('私聊出站目标是 c2c scope', ct.scope === 'c2c')
  ok('私聊端点是 /v2/users/<openid>/messages', ct.endpoint === `/v2/users/${DOC_C2C.author.user_openid}/messages`)
  ok('私聊也带 msg_id', ct.msgId === DOC_C2C.id)
  ok('空事件 → null', A.toReplyTarget(null, 'x') === null)
}

console.log('\n=== 10. 能力边界常量（来自官方文档，别改成估的）===')
{
  const L = A.OFFICIAL_BOT_LIMITS
  ok('**明确记录：群全量消息需要群主授权**', L.groupOverheardNeedsOwnerGrant === true)
  ok('**明确记录：没有真实 QQ 号**', L.hasRealQqNumber === false)
  ok('群被动回复窗口 5 分钟', L.passiveReplyTtlMsGroup === 5 * 60 * 1000)
  ok('私聊被动回复窗口 60 分钟', L.passiveReplyTtlMsC2C === 60 * 60 * 1000)
  ok('群每条消息最多回 5 次', L.passiveReplyMaxGroup === 5)
  ok('私聊每条消息最多回 4 次', L.passiveReplyMaxC2C === 4)
  ok('撤回时限 2 分钟', L.recallTtlMs === 2 * 60 * 1000)
  ok('主动消息每群每天 1000 条', L.proactivePerDayPerGroup === 1000)
  ok('常量对象被冻结（防运行时改）', Object.isFrozen(L))
}

console.log('\n=== 11. 附件类型映射 ===')
{
  const { images, others } = A.flattenAttachments([
    { content_type: 'image/png', url: 'https://x/1.png' },
    { content_type: 'voice', voice_wav_url: 'https://x/2.wav', asr_refer_text: '你好' },
    { content_type: 'video/mp4', url: 'https://x/3.mp4' },
    { content_type: 'file', filename: 'a.pdf', url: 'https://x/4.pdf' },
  ])
  ok('图片进 images（桥能处理）', images.length === 1 && images[0].type === 'image')
  ok('语音降级成 ASR 文本（桥不认语音段，诚实降级）',
    others.some(o => o.includes('你好')), JSON.stringify(others))
  ok('视频标记成占位', others.some(o => o.includes('[视频消息]')))
  ok('文件带文件名', others.some(o => o.includes('a.pdf')))
  ok('空附件不崩', (() => { const r = A.flattenAttachments(undefined); return r.images.length === 0 && r.others.length === 0 })())
}

console.log('\n=== 12. 生产隔离（CONTRIBUTING §9）===')
{
  ok('适配层是**纯函数模块**，不写文件/不连网',
    !/fs\.writeFileSync|createWriteStream|new WebSocket|fetch\(/.test(fs.readFileSync(SRC, 'utf8')),
    '适配层里出现了 IO 调用，应该只有纯映射')
  ok('适配层不读凭据（appSecret 不该出现在这里）',
    !/appSecret|clientSecret|access_token/.test(fs.readFileSync(SRC, 'utf8')))
  ok('不 require 生产 bridge 的其它模块（解耦）',
    !/from '\.\/index\.js'|from '\.\/onebot\.js'/.test(fs.readFileSync(SRC, 'utf8')))
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
