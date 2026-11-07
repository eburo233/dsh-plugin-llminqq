// 配置存储：设置页读写的那份 JSON。
//
// 设计取舍（都踩过坑）：
//   ① **独立文件，不写 profile 的 cordis.patch.yml**。
//      profile patch 是「组合层」，写它需要 configEditor、且格式一错整个 profile 起不来；
//      而这个插件的配置有几十项、还会被设置页频繁改。放在 ~/.dsh/dsh-plugin-llminqq/config.json
//      里，插件自己校验、自己迁移，坏了也只影响插件本身，不会把整个 DSH 拖死。
//   ② **文件里绝不存明文以外的惊喜**：就是普通 JSON，人能直接改、能 diff、能进版本控制
//      （除了 .env 那类凭据）。凭据（QQ 号/token）单独存 .env 风格的 secrets.json，
//      权限 0600，和 config.json 分开 —— 这样把 config.json 发给别人求助时不会泄露凭据。
//   ③ **写入原子化**：先写 .tmp 再 rename。设置页保存时如果进程被杀，
//      不会留下半个 JSON 把插件永久锁死（readConfig 解析失败会回落默认值，但那意味着丢配置）。

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

/** 插件数据目录：`$DSH_HOME/dsh-plugin-llminqq`，默认 `~/.dsh/dsh-plugin-llminqq`。 */
export function dataDir () {
  // 优先级：DSH_HOME > 从「插件自己所在路径」反推 > os.homedir()/.dsh
  //
  // 为什么不能直接用 process.env.HOME（真实踩坑）：
  //   Windows 上 HOME 常常没设，或者被 Git Bash / MSYS 设成别的路径；
  //   Electron 桌面版更可能把 DSH_HOME 指到 D:\dsh-home 这种非默认位置。
  //   结果插件把数据写到 C:\Users\X\.dsh\...，而 dsh 真正的 home 在 D:\dsh-home
  //   —— 表现为「设置页改了但桥读不到」「agent 工作区跑到 C 盘」。
  //
  //   这次就是从桥日志发现的：cwd=C:\Users\<你>\.dsh\dsh-plugin-llminqq\agent
  //   而用户的 dsh home 是 D:\dsh-home。
  // ⚠️ 顺序很重要：**先从安装路径反推，再退回 DSH_HOME**。
  //
  // 为什么反推优先（真实踩坑的教训）：
  //   DSH_HOME 环境变量常常「存在但不对」——比如 Electron 桌面版设的是
  //   C:\Users\X\.dsh，而用户实际的 dsh home 在 D:\dsh-home。
  //   按 DSH_HOME 写就会把数据/i人设/记忆写到另一个盘的另一份目录，
  //   表现为「设置页改了但没生效」「agent 工作区跑错地方」。
  //
  //   而「插件自己被装在哪里」是事实，不是猜测：
  //   <dshHome>/profiles/<profile>/node_modules/dsh-plugin-llminqq/lib
  //   反推出来的 dshHome 必然就是 dsh 真正在用的那个。
  //
  //   只有当反推不出来时（比如从源码目录直接跑），才用 DSH_HOME 兜底。
  try {
    const here = path.dirname(fileURLToPath(import.meta.url))   // .../lib
    const pkgRoot = path.dirname(here)                          // .../dsh-plugin-llminqq
    const nodeModules = path.dirname(pkgRoot)                   // .../node_modules
    const profileDir = path.dirname(nodeModules)                // .../profiles/<name>
    const profilesDir = path.dirname(profileDir)                // .../profiles
    if (path.basename(profilesDir) === 'profiles') {
      const dshHome = path.dirname(profilesDir)
      if (fs.existsSync(dshHome)) return path.join(dshHome, 'dsh-plugin-llminqq')
    }
  } catch { /* 反推失败，走下面的兜底 */ }

  // 兜底 ①：DSH_HOME（反推不出来时才信它）
  const explicit = process.env.DSH_HOME
  if (explicit) return path.join(explicit, 'dsh-plugin-llminqq')

  // 兜底 ②：用户主目录
  return path.join(os.homedir(), '.dsh', 'dsh-plugin-llminqq')
}

export const CONFIG_FILE = () => path.join(dataDir(), 'config.json')
export const SECRETS_FILE = () => path.join(dataDir(), 'secrets.json')
export const STATE_FILE = () => path.join(dataDir(), 'state.json')
export const QR_FILE = () => path.join(dataDir(), 'qr.png')

/** 默认配置。设置页「恢复默认」就是写回这一份。 */
/**
 * MiniMax T2A v2 的模型与音色清单（官方文档 2026-10）。
 *
 * 为什么硬编码在插件里而不是运行时拉：MiniMax 没有公开「列出音色」的 API，
 * 只能照文档抄。抄在插件里至少能保证下拉菜单有东西选；
 * 用户想用列表外的（比如自己复刻的音色），可以在设置页手填 voiceId。
 */
export const MINIMAX_MODELS = [
  { id: 'speech-2.5-hd-preview', label: 'speech-2.5-hd-preview（最新 HD，韵律最佳）' },
  { id: 'speech-2.5-turbo-preview', label: 'speech-2.5-turbo-preview（最新 Turbo，40 语种）' },
  { id: 'speech-02-hd', label: 'speech-02-hd（韵律/复刻最稳）' },
  { id: 'speech-02-turbo', label: 'speech-02-turbo（小语种更强，快）' },
  { id: 'speech-01-hd', label: 'speech-01-hd（复刻相似度高）' },
  { id: 'speech-01-turbo', label: 'speech-01-turbo（更快）' },
]

export const MINIMAX_VOICES = [
  { id: 'female-shaonv', label: '少女音色（female-shaonv）' },
  { id: 'female-yujie', label: '御姐音色（female-yujie）' },
  { id: 'female-chengshu', label: '成熟女性（female-chengshu）' },
  { id: 'female-tianmei', label: '甜美女性（female-tianmei）' },
  { id: 'male-qn-qingse', label: '青涩青年（male-qn-qingse）' },
  { id: 'male-qn-jingying', label: '精英青年（male-qn-jingying）' },
  { id: 'male-qn-badao', label: '霸道青年（male-qn-badao）' },
  { id: 'male-qn-daxuesheng', label: '青年大学生（male-qn-daxuesheng）' },
  { id: 'lovely_girl', label: '萌萌女童（lovely_girl）' },
  { id: 'cute_boy', label: '可爱男童（cute_boy）' },
  { id: 'clever_boy', label: '聪明男童（clever_boy）' },
  { id: 'qiaopi_mengmei', label: '俏皮萌妹（qiaopi_mengmei）' },
  { id: 'tianxin_xiaoling', label: '甜心小玲（tianxin_xiaoling）' },
  { id: 'diadia_xuemei', label: '嗲嗲学妹（diadia_xuemei）' },
  { id: 'danya_xuejie', label: '淡雅学姐（danya_xuejie）' },
  { id: 'wumei_yujie', label: '妩媚御姐（wumei_yujie）' },
  { id: 'bingjiao_didi', label: '病娇弟弟（bingjiao_didi）' },
  { id: 'junlang_nanyou', label: '俊朗男友（junlang_nanyou）' },
  { id: 'chunzhen_xuedi', label: '纯真学弟（chunzhen_xuedi）' },
  { id: 'lengdan_xiongzhang', label: '冷淡学长（lengdan_xiongzhang）' },
  { id: 'badao_shaoye', label: '霸道少爷（badao_shaoye）' },
  { id: 'presenter_male', label: '男性主持人（presenter_male）' },
  { id: 'presenter_female', label: '女性主持人（presenter_female）' },
  { id: 'audiobook_male_1', label: '男性有声书1（audiobook_male_1）' },
  { id: 'audiobook_female_1', label: '女性有声书1（audiobook_female_1）' },
  { id: 'Charming_Lady', label: 'Charming Lady（英文）' },
  { id: 'Sweet_Girl', label: 'Sweet Girl（英文）' },
  { id: 'Cute_Elf', label: 'Cute Elf（英文）' },
]

/** MiniMax 支持的情绪（只有部分模型生效） */
export const MINIMAX_EMOTIONS = [
  { id: '', label: '（不指定，模型自动判断）' },
  { id: 'happy', label: '高兴' },
  { id: 'sad', label: '悲伤' },
  { id: 'angry', label: '愤怒' },
  { id: 'fearful', label: '害怕' },
  { id: 'disgusted', label: '厌恶' },
  { id: 'surprised', label: '惊讶' },
  { id: 'calm', label: '中性' },
]

export function defaults () {
  return {
    // ── 总开关 ────────────────────────────────────────────────────────────
    enabled: false,

    // ── OneBot 连接（NapCat） ─────────────────────────────────────────────
    onebot: {
      wsUrl: 'ws://127.0.0.1:3001',
      token: '',
      reconnectMs: 3000,
      heartbeatTimeoutMs: 90000,
    },

    // ── NapCat 容器管理（插件可以替你拉起/停掉它） ──────────────────────────
    napcat: {
      // managed=true 时插件自己 docker compose 起容器；false 表示你手动管
      managed: true,
      composeFile: '',          // 留空 = 用插件自带的 compose 模板
      containerName: 'llminqq-napcat',
      image: 'mlikiowa/napcat-docker:v4.15.19',
      webuiPort: 6099,
      webuiToken: '',           // 留空 = 首次启动时随机生成并存进 secrets
      onebotPort: 3001,
      uid: 1000,
      gid: 1000,
      timezone: 'Asia/Shanghai',
      memLimit: '2g',
      // 机器人自己的 QQ 号：填了就用 `-q <号>` 快速登录（容器重启不必再扫码）。
      // 留空 = 每次重启都弹二维码。NapCat 的 entrypoint 只有在传了 -q 时才会用
      // 本地登录凭证，否则一律走扫码 —— 这是「重启后一直卡在二维码」的根因。
      account: '',
    },

    // ── LLM 运行时 ────────────────────────────────────────────────────────
    dsh: {
      // 空 = 用宿主进程自己的 dsh（多数情况如此）
      bin: '',
      profile: '',              // 空 = 用宿主 profile 名
      cwd: '',                  // 空 = 用插件数据目录下的 agent 工作区
      // 默认走 DSH 账号路由：它用的是桌面版里已经登录过的账号 token，
      // 不依赖环境变量。deepseek-official 需要 DEEPSEEK_API_KEY，没配就会在
      // turn 阶段报 `no API key for provider route`。
      provider: 'deepseek-account',
      model: 'deepseek-flash',
      reasoningEffort: 'high',
      // 降级链：主路由连续失败 N 次后依次切到这里
      fallbackRoutes: [],
      failover: {
        enabled: true,
        consecutiveFailures: 2,
        cooldownMs: 300000,
        probeBackMs: 180000,
      },
      protocol: 'acp',          // acp（支持 MCP）| sdk
      startTimeoutMs: 60000,
      turnTimeoutMs: 180000,
    },

    // ── 行为策略 ──────────────────────────────────────────────────────────
    policy: {
      allowC2C: true,
      allowUsers: [],
      allowGroups: [],
      requireAtInGroup: true,
      maxReplyChars: 1500,
      replyChunkDelayMs: 400,
      ignoreSelf: true,
      cooldownMsPerPeer: 1500,
      timezone: 'Asia/Shanghai',
      quietHours: { enabled: false, startHour: 1, endHour: 7 },
      maxTurnsPerSession: 400,
    },

    // ── 出站分条 ──────────────────────────────────────────────────────────
    // 一轮回复要不要拆成几条发。桥的规则（2026-11-05 用户定稿）：
    //   · 模型输出里的**换行**和 **[SPLIT] 标记**一律强制分条（不受阈值限制）；
    //   · **空格不算分条**（不会从空格处把一句话劈开）；
    //   · 单段超过 splitChars 才按标点兜底再拆；
    //   · 拆完超过 splitMaxParts → 多出来的**并进最后一条**（刷屏比超长烦）。
    //
    // 为什么默认 30 / 5：30 字差不多是「一句话」的自然长度（再长就该停顿换气了）；
    // 5 条是用户口味的折中 —— 真人补话一般 2~3 条，但模型一轮里出现 4~5 个短句
    // 也很自然，而 6 条以上就开始像刷屏。
    //
    // 🔴 区间约束在插件侧（lib/index.js 的 splitConfig，10–200 / 2–10），
    //    桥侧只做 `Number(v) > 0 ? v : 默认`（非法回落、**不设上限**）。
    //    手改 config.json 塞个 1 或 1000，会在生成 bridge-config.json 时被夹回来。
    //
    // 🔴 2026-11-06 task-1：分条参数**历史上借用了 affection 段的名字** ——
    //    那时 affection 段只是个占位，后来「关系参数」真的用上了这个段，
    //    两套语义挤在同一个 key 下。现在 `split` 是分条的正式段；
    //    `affection` 里**仍然保留** splitChars/splitMaxParts（设置页「分条」卡
    //    至今写这两个键、桥侧旧读取路径也在读它们），见 lib/index.js splitConfig
    //    的读取优先级说明。迁完 UI 之后可以把 affection 里那两个键删掉。
    affection: {
      // ── 好感度（关系）真参数（2026-11-06 task-1 / P1-2）──────────────
      // 和 lib/bridge/state.js 的 AFFECTION_DEFAULTS 对齐。以前桥全部走硬编码，
      // 设置页改不了；现在这几个键会被 bridgeConfig 透传给桥。
      // 只放「用户真会调」的少数几个：开/关、起始分、模型自评通道、日涨分上限、
      // 衰减地板；praiseGain / insultPenalty / 各冷却时间仍走桥自己的默认值。
      enabled: true,          // 关掉 = 桥完全不记好感度（不涨不降不注入）
      start: 30,              // 初始好感度 0..100；30 = 聊两句进 L1「点头之交」
      modelScoring: true,     // 模型自评通道（[AFF:±n:理由] 回写）总开关
      modelMaxPerRound: 2,    // 单轮 |Δ| 上限（0.5 步进；模型只能「提议幅度」，分由桥算）
      dailyGainCap: 10,       // 每天涨分总量闸（防刷）
      decayFloor: 20,         // 久不联系缓降的**地板**（关系不会因为没聊天就归零）
      // 档位分界线（0..100）；改小了会「升档变快」，改大了更难亲近。
      tiers: { l1: 25, l2: 50, l3: 70, l4: 85, hate: 10 },
      // ── 出站分条（历史遗留位置，见上面那段说明）─────────────────────
      splitChars: 30,        // 单段超过多少字才按标点兜底拆（换行/[SPLIT] 不受此限）
      splitMaxParts: 5,      // 每轮最多几条（含换行/[SPLIT] 拆出来的）
    },
    // 出站分条的**正式**段（2026-11-06 task-1）。bridgeConfig 产出 `split` 段，
    // 桥侧正在改成「split 优先、affection.splitChars 兜底」。
    // 默认值和上面 affection 里那两个键保持一致（老 UI 还写 affection，
    // 两边不一致会让「改了不生效」—— 改默认值必须两处一起改）。
    split: {
      splitChars: 30,
      splitMaxParts: 5,
    },

    // ── 媒体 ──────────────────────────────────────────────────────────────
    media: {
      enabled: true,
      stagingDir: '',           // 空 = 插件数据目录下 .qq-media
      maxFileBytes: 10485760,
      sensitiveNames: ['.ssh', '.env', 'credentials', 'id_rsa', 'id_ed25519', 'secret', 'token'],

      // ── 入站文件（对方发来的文件）──────────────────────────────────────
      // 2026-11-03 用户同意后加的：群里/私聊里**别人发来的文件**，桥会真的下载
      // 到暂存区，让模型能 read / read_image 看内容，而不是只看到一个占位。
      //
      // 为什么这四项要放进配置而不是写死在桥里：
      //   带宽、磁盘、耐心每台机器都不一样 —— 有人愿意为一份 20MB 的 PDF 等半分钟，
      //   有人只想让它收 2MB 的图。写死就只能改代码。
      //
      // 为什么默认值要保守（20MB / 5 个 / 30s）：
      //   入站下载在**消息主路径**上（订阅收消息 → 下载 → 再回），所以它一慢，
      //   整轮对话都慢。默认值取「够用但不至于拖垮」的中位数。
      //
      // 🔴 注意：桥侧（lib/bridge/messaging.js）只做「非法值回落默认」，
      //    **没有上限**（`Number(v) > 0 ? v : 默认`）。所以真正的区间约束在插件侧
      //    lib/index.js 的 inboundFileMedia()（1–100MB / 1–10 个 / 5–120s）。
      //    手改 config.json 塞一个巨大的值，会在生成 bridge-config.json 时被夹回来。
      inboundFileEnabled: true,          // 关掉 = 只留「收到文件」占位，不下载
      maxInboundFileBytes: 20971520,     // 单文件上限 20MB（设置页按 MB 显示）
      maxInboundFiles: 5,                // 单条消息最多处理几个（防一次发 50 个拖垮桥）
      inboundFileTimeoutMs: 30000,       // 取下载地址 + 下载的超时 30s

      // ── 语音转文字（ASR，2026-11-03 task-10）──────────────────────────
      // 对方发来的 QQ 语音，桥会调本机 faster-whisper 转成文字塞进上下文，
      // 模型才知道他说了什么（以前只有一个 [语音] 5s 占位）。
      //
      // 🔴 默认**关**，必须用户显式开：要装 faster-whisper 依赖，首次还要
      //    下载模型（tiny≈75MB / base≈145MB / small≈480MB / medium≈1.5GB），
      //    然后在 CPU 上转几秒。在用户不知情时干这些事，就是「偷偷下大文件 + 变慢」。
      //
      // 模型默认 small（用户 2026-11-03 拍板）：中文准确率和体积的平衡点；
      // tiny/base 更快但中文错字明显，medium 更准但 CPU 上慢到不划算。
      //
      // 和入站文件一样：桥侧只做「非法值回落」，区间约束在插件侧
      // lib/index.js 的 voiceTranscribeMedia()（超时 5–120s）。
      voiceTranscribe: {
        enabled: false,
        engine: 'faster-whisper',   // 备选 funasr（环境有才用，失败自动回退）
        model: 'small',             // tiny / base / small / medium
        lang: 'zh',                 // zh / en / auto…
        pythonBin: '',              // 空 = 桥按平台猜（POSIX python3 / Windows python）
        script: '',                 // 空 = 插件自带的 lib/agent/asr/transcribe.py
        timeoutMs: 30000,           // 整条消息的转写总预算
      },
    },

    // ── 本地运维 API ──────────────────────────────────────────────────────
    server: {
      enabled: true,
      host: '127.0.0.1',
      port: 18080,
      token: '',                // 空 = 首次启动随机生成并存进 secrets
    },

    // ── 人格 / 记忆 ───────────────────────────────────────────────────────
    persona: {
      path: '',                 // 空 = 插件数据目录下 agent/persona/persona.md
      maxBytes: 32768,
      // 每轮注入策略：'once'（首轮+变更时）| 'always'（每轮全文，费 token）
      injectMode: 'once',
    },
    memory: {
      enabled: true,
      dir: '',                  // 空 = <dataDir>/memory（~/.dsh/dsh-plugin-llminqq/memory），见 agent/dirs.mjs
      // 记忆数据目录。空 = <dataDir>/memory —— 和配置/日志/人格放同一个根，
      // 备份/迁移/排查只看一个地方（旧版本在 ~/.dsh/llminqq，启动时自动迁移）。
      stateDir: '',
      // 手动指定 python 解释器。空 = 自动探测 python3 → python → py -3
      pythonBin: '',
      // 记忆 v5（events 双写 + 可选新读路径）。
      //   enabled  只写不读那层（默认开：零风险+为切换攒数据；LLMINQQ_MEMORY_V5=0 可关）
      //   engine   读路径引擎：v4（默认，老 digest+跨通道）/ v5（新检索，失败自动回退 v4）
      //            ⚠️ 切 v5 前必须先跑历史迁移（scripts/memory-v4-to-v5.mjs），否则空库=不注入。
      //            环境变量 LLMINQQ_MEMORY_ENGINE 优先级最高（线上止血不用改配置）。
      //   distill  engine=v5 时的后台提炼心跳（默认 10 分钟一次）
      v5: {
        enabled: true,
        engine: 'v4',
        distill: { enabled: true, intervalMin: 10 },
      },
    },

    // ── 可选能力 ──────────────────────────────────────────────────────────
    features: {
      voice: false,             // [VOICE:] 语音
      poke: true,               // [POKE:] 戳一戳
      recall: true,             // [RECALL:] 撤回
      follow: true,             // [FOLLOW:] 补一句
      welcome: false,           // 入群欢迎
      proactive: false,         // 主动找人说话
      style: false,             // 自我风格样本库
      learning: false,          // 说话方式学习
      bili: false,              // B站 MCP
      // 🔴 P0b：桥内定时任务（反思 8h / 学习 12h），替代脚本版的 systemd timer。
      // 默认 **true**：这是「开箱即用」的一部分 —— 装完插件不用再配 cron/systemd。
      // 没有 python 时任务自动跳过，并在设置页说明原因（不是报错）。
      scheduler: true,
    },

    // ── 说话方式学习（语料抓取）──────────────────────────────────────────────
    // crawlSources 是「从哪儿抓语料」。三种写法都支持（见 crawl-bili-comments.mjs）：
    //   1. [{ bvid: "BV1xx", domain: "history" }]          精确指定
    //   2. ["BV1xx"]                                       只给 BV 号
    //   3. [{ keyword: "历史区UP主讲故事", domain: "history" }] 只给关键词 ← **推荐**
    //
    // 为什么推荐第 3 种：模型/用户通常只知道「想学哪个领域的说话方式」，
    // 不知道具体 BV 号。给关键词，抓取脚本自己调 bili_search 搜出视频。
    //
    // domain 仍建议手填（分区有几十个，靠标题猜会把历史猜成生活，
    // 分层采样就按错的组分配额度 —— 猜错比不填更糟）。
    learning: {
      enabled: false,
      // 默认给几个「说话内容密集」的领域，开箱即用；
      // 用户/模型可以改成自己的话题。清空成 [] 则抓取会明确报「清单为空」。
      crawlSources: [
        { keyword: '历史区 UP主 讲故事', domain: 'history' },
        { keyword: '科技区 数码 评测 解说', domain: 'tech' },
        { keyword: '生活区 vlog 分享', domain: 'life' },
      ],
      commentsPerVideo: 20,
    },

    // ── 语音合成（TTS） ──────────────────────────────────────────────────────
    // 为什么单独一段而不塞进 features.voice：
    //   features 只是「开/关」；真要用还得知道**用哪个引擎、连哪个地址、
    //   用哪段参考音频** —— 这些是资源位置与参数，混在布尔里设置页没法编辑。
    //
    // 桥侧 messaging.js 读的就是这一段（字段名与脚本版一致，互不冲突）：
    //   config.tts.engine / .maxChars / .gsv.{url,referWav,promptText,...}
    //
    // engine 优先级：gsv（GPT-SoVITS，支持音色克隆）→ piper → sherpa → qq（QQ 内置，仅群聊）
    tts: {
      enabled: false,
      engine: 'gsv',
      maxChars: 200,
      character: 'lucy-voice-male1',
      characterName: '憨憨小弟',
      // GPT-SoVITS：POST 到 url，用 referWav + promptText 做音色克隆。
      // 三个地址留空 = 用默认（127.0.0.1 对应端口）；填了就用填的。
      gsv: {
        url: 'http://127.0.0.1:9880/',
        referWav: '',
        promptText: '',
        textLanguage: 'zh',
        promptLanguage: 'zh',
        speed: 1.0,
        temperature: 1.0,
        timeoutMs: 120000,
      },
      piper: {
        url: 'http://127.0.0.1:5006/synthesize',
        voice: 'zh_CN-huayan-medium',
        timeoutMs: 60000,
      },
      sherpa: {
        url: 'http://127.0.0.1:9881/synthesize',
        engineId: 'vits',
        sid: 0,
        timeoutMs: 60000,
      },
      // ── MiniMax T2A v2（国内直连，音色最多，支持情绪）────────────────────
      // apiKey 建议走 secrets（ttsMinimaxKey）；groupId 从 MiniMax 控制台拿。
      minimax: {
        url: 'https://api.minimaxi.com/v1/t2a_v2',
        apiKey: '',
        groupId: '',
        model: 'speech-2.5-hd-preview',
        voiceId: 'female-shaonv',
        voiceIdCustom: '',   // 非空则覆盖 voiceId（复刻音色用）
        emotion: '',
        speed: 1.0,
        vol: 1.0,
        pitch: 0,
        format: 'mp3',
        sampleRate: 32000,
        bitrate: 128000,
        languageBoost: 'auto',
        timeoutMs: 120000,
      },
      // ── 在线 TTS（OpenAI 兼容 /audio/speech）────────────────────────────
      // 用户机器带不动本地 TTS 时，这条路只要一个 key 就能出声。
      // engine 选 'openai' 才会用它；apiKey 可以留在 config 里（或走 secrets）。
      openai: {
        url: 'https://api.openai.com/v1/audio/speech',
        apiKey: '',
        model: 'tts-1',
        voice: 'alloy',
        format: 'mp3',
        speed: 1.0,
        timeoutMs: 60000,
      },
    },

    // ── MCP 工具服务器（B站两种能力） ────────────────────────────────────────
    // 为什么单独一段而不是塞进 features：
    //   features 是「开/关」布尔；MCP 还要记路径、解释器、venv 这些**资源位置**。
    //   混在一起会让设置页没法分节显示，也让「依赖缺失给原因」无处存放。
    //
    // 两种能力依赖差异很大，所以默认值不同：
    //   storyboard：纯 Node + 系统 ffmpeg/ffprobe → **默认开**（装完就能用）
    //   bili      ：需要 Python + venv（mcp / bilibili-api-python 等）→ **默认关**
    //               （不能默认开：默认开会在没装依赖的用户那里变成「一直报错」）
    mcp: {
      storyboard: {
        enabled: true,
      },
      bili: {
        enabled: false,
        // 空 = 自动探测：优先用 venv 里的 python，其次 PATH 上的 python3/python
        pythonBin: '',
        // 空 = 用包内 vendor/bilibili-mcp/mcp_server.py
        serverPath: '',
        // 空 = <stateDir>/bili/bili_credential.json（扫码登录产物）
        credentialPath: '',
        // 用户自建 venv 的根目录（里面应有 bin/python 或 Scripts/python.exe）。
        // 空 = 没有 venv → bili 能力报「依赖缺失」而不是静默
        venv: '',
        // 首次安装依赖用（P3 才实现自动装；这一期只记录，供设置页显示命令）
        autoInstall: false,
      },
    },

    // ── 主动发言（features.proactive 打开后生效） ───────────────────────────
    proactive: {
      baseProb: 0.1,
      step: 0.05,
      maxProb: 0.6,
      guaranteeCount: 6,
      cooldownMin: 40,
      tickMin: 20,
      whitelist: [],
    },

    // ── 高级：透传给桥的原始配置（power user 用） ───────────────────────────
    advanced: {
      rawJson: '',              // 整段 JSON，会深合并覆盖上面所有默认值
    },
  }
}

/** 深合并：数组整体替换（不是拼接），对象递归合并，null 表示「显式清空」。 */
export function deepMerge (base, patch) {
  if (patch === null || patch === undefined) return base
  if (Array.isArray(patch)) return patch
  if (typeof patch !== 'object') return patch
  if (typeof base !== 'object' || base === null || Array.isArray(base)) base = {}
  const out = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(base[k], v) : v
  }
  return out
}

function ensureDir (dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
}

/** 原子写：先写临时文件再 rename。避免半个 JSON 把配置锁死。 */
function writeJsonAtomic (file, obj, mode = 0o600) {
  ensureDir(path.dirname(file))
  // 临时名带上 pid + 时间戳 + 随机数：同一个进程里两个请求并发保存时
  // 只带 pid 会让两次写共用同一个 tmp 文件，rename 之后内容可能互相踩。
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode })
    fs.renameSync(tmp, file)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch { /* 清理失败就算了，关键是别留半截文件 */ }
    throw err
  }
}

/**
 * 配置文件坏掉时把原文件另存一份（每个进程只做一次）。
 *
 * 为什么必须备份：readConfig 坏 JSON 时回落默认值，之后设置页随便保存一次
 * （POST /config → saveConfig 整体覆盖）就会把用户手改的配置**永久抹掉**。
 * 备份一次就够 —— 配置文件一直坏着的话，每读一次都备份会刷出一堆垃圾文件。
 */
let corruptConfigBackedUp = false
function backupCorruptConfig (why) {
  if (corruptConfigBackedUp) return ''
  corruptConfigBackedUp = true
  try {
    const file = CONFIG_FILE()
    if (!fs.existsSync(file)) return ''
    const bak = `${file}.corrupt-${Date.now()}`
    fs.copyFileSync(file, bak)
    try { fs.chmodSync(bak, 0o600) } catch { /* Windows 上可能不支持，忽略 */ }
    return bak
  } catch {
    return ''
  }
}

/**
 * 读配置。文件不存在/坏了都返回**默认值**（并带上 `_loadError` 说明原因），
 * 绝不抛错 —— 配置读失败不该让插件起不来，那时用户连设置页都打不开，
 * 也就没法修配置了。
 */
export function readConfig () {
  const fallback = defaults()
  let raw
  try {
    raw = fs.readFileSync(CONFIG_FILE(), 'utf8')
  } catch (err) {
    if (err.code !== 'ENOENT') {
      fallback._loadError = `读配置失败：${err.message}`
    }
    return fallback
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    const bak = backupCorruptConfig(err.message)
    fallback._loadError = `配置文件不是合法 JSON（${err.message}）。已用默认值启动，修好后保存即可覆盖。` +
      (bak ? `原文件已备份到 ${bak}（保存新配置不会丢）` : '')
    return fallback
  }
  let merged = deepMerge(defaults(), parsed)
  // advanced.rawJson：给 power user 一个「透传」口子。解析失败要明确报告而不是静默忽略。
  const rawJson = merged.advanced?.rawJson
  if (typeof rawJson === 'string' && rawJson.trim()) {
    try {
      merged = deepMerge(merged, JSON.parse(rawJson))
    } catch (err) {
      merged._loadError = `advanced.rawJson 不是合法 JSON：${err.message}（已忽略该段）`
    }
  }
  return merged
}

/** 保存配置（整体覆盖）。返回写入后的完整配置。 */
export function saveConfig (partial) {
  const before = readConfig()
  delete before._loadError
  const next = deepMerge(before, partial)
  delete next._loadError
  writeJsonAtomic(CONFIG_FILE(), next)
  return next
}

/** 重置为默认值（保留 secrets —— 凭据不该被「恢复默认」清掉）。 */
export function resetConfig () {
  const fresh = defaults()
  writeJsonAtomic(CONFIG_FILE(), fresh)
  return fresh
}

// ── 凭据：单独文件，0600 ─────────────────────────────────────────────────────
//
// 为什么分开存：config.json 是「可以发给别人看/进版本控制」的那部分
// （模型路由、策略、开关），secrets 是「绝对不能外泄」的那部分（QQ 号、token）。
// 混在一起会让「分享配置求助」变成泄密事故。

export function readSecrets () {
  try {
    return JSON.parse(fs.readFileSync(SECRETS_FILE(), 'utf8'))
  } catch {
    return {}
  }
}

export function writeSecrets (patch) {
  const next = { ...readSecrets(), ...patch }
  // 空字符串视为「删掉这个凭据」，不是「设成空」
  for (const [k, v] of Object.entries(next)) {
    if (v === '' || v === null || v === undefined) delete next[k]
  }
  writeJsonAtomic(SECRETS_FILE(), next, 0o600)
  return next
}

/** 取凭据：secret 文件优先，其次环境变量，最后空串。 */
export function getSecret (key, envName) {
  const s = readSecrets()
  if (s[key]) return s[key]
  if (envName && process.env[envName]) return process.env[envName]
  return ''
}

/** 生成随机 token（不需要 openssl，node crypto 就够）。 */
export function randomToken (bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex')
}

import crypto from 'node:crypto'

// ── 运行时状态（桥的当前状态，不是配置） ─────────────────────────────────────
export function readState () {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8'))
  } catch {
    return {}
  }
}

export function writeState (patch) {
  const next = { ...readState(), ...patch, updatedAt: Date.now() }
  writeJsonAtomic(STATE_FILE(), next)
  return next
}
