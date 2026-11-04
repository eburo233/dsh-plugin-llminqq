# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> 说明：本仓库的公开历史从 `0.5.0` 开始。更早的迭代是作者自用阶段的脚本形态，
> 没有以版本号发布过，因此下面没有 `0.4.x` 之类的条目，也不会编造。

## [未发布]

### Fixed（语音转写全链路修复，2026-11-04）

- **QQ 语音转写上线以来从未成功过**（每条都「转写超时（30s），已放弃」），复盘是三层叠加，
  详见 [docs/VOICE-ASR-POSTMORTEM-2026-11-04.md](docs/VOICE-ASR-POSTMORTEM-2026-11-04.md)：
  ① whisper-small（484MB）在 30s 预算下永远下不完——桥超时 SIGKILL、下次从头再下，死循环；
  已清 `.incomplete` 残留并完成预下载（`agent/asr-models/hub/`）。
  ② asr-venv 里 `av==19.0.2` 与 faster-whisper 1.2.1 不兼容
  （`av.open(metadata_errors=…)` 参数已删，一解码就炸），降到 `av==14.0.1`。
  ③ **QQ 语音 `.amr` 实际是 silk v3**（头 `\x02#!SILK_V3`），ffmpeg/whisper 整条解不了；
  `transcribe.py` 新增 silk 嗅探 + `pysilk`（pip 名 `silk-python`）转临时 wav，
  非 silk 文件路径不变，临时文件用完即删。真机 3 条语音全部转成功，单条含模型加载 4.3s。

### Added（记忆 v5 · Step 3：迁移 + 盲评）

- **v4→v5 历史迁移脚本**（`scripts/memory-v4-to-v5.mjs`）：默认 dry-run、v4 只读、生产路径默认拒绝、
  幂等可重跑。映射：procedural→rule / semantic→fact / episodic→episode；pinned→salience 0.9；
  `retired=1`→archived（「已完成：」→done，否则 pruned）；scope 按来源显式定
  （私聊→dm_only、群→public，不因 v4 visibility 全 NULL 就当 public）；is_self 的 273 条进
  `utterances`（「我说过什么」原文层）而不是 memories；同一批里 162 组重复被合并；
  注入残留整条跳过；连「v4 截断切掉闭合 `]`」的半个控制标记也有兜底清洗。
  生产只读快照试跑：`1055 = 612 memories(active 605/archived 7) + 266 utterances + 163 去重 + 8 注入 + 6 空壳`，
  第二次 `--apply` written=0。
- **显式日期过期归档**（保守版）：只认文本里自带完整日期（`YYYY-MM-DD`/`YYYY年M月D日`/`M月D日`
  + created 年推断）且同句 48 字内有时间词的情况；歧义/区间/非法日期一律不猜。
  试跑新增 archived(expired) 2 条（含「明天(2026-10-26)下午三点开会」）、未来事件设 `valid_until` 1 条、
  按设计不猜 4 条；`--no-expire-parse` 可回退。
- **distill supersede 对齐迁移 key**：迁移条目 key 是 sha1、distill 是 `type:subject:topic`，
  精确匹配不上。新增「同 type+同 subject 相似度」回退（`max(Jaccard, containment)`，阈值 0.5），
  并加 topic 冲突闸防并列事实误合并、只归档一条、可捞回。迁移副本端到端验证：
  迁移来的「安全底裤」旧结论被新提炼结论取代（`supersededFromMigratedKey=1`、`brokenChain=0`）。
- **设置页「记忆引擎」选择卡**：v4（默认）/ v5 二选一，带前置条件提示（先迁移 + 盲评）；
  保存走 `memory.v5.engine` 透传；提示 `LLMINQQ_MEMORY_ENGINE=v4` 线上秒回退。
- **v4/v5 注入 A/B 盲评工具**（`scripts/memory-ab.mjs`）：只读、生产路径默认拒绝、跑完 sha256 自证；
  v4 侧走线上真实 `memoryRecallBlock` 口径（注释锚点 + vm 沙箱），v5 侧 `rankMemories`；
  输出打乱顺序的两栏盲评 markdown（不泄引擎名）+ `--json` 明细 + `--reveal` 揭盲。
  30 条真实查询盲评（独立判官）：v5 噪音 4/30 vs v4 6/30、相关 19 vs 18、
  重复注入 13 vs 30、完整注入字数 240 vs 668、P99 5.7ms vs 103ms。

### Added（记忆 v5 · Step 2：提炼 + 检索 + 读路径切换）

- **提炼 worker**（`lib/agent/memory-v5/distill.mjs` + `distill-prompt.mjs`）：
  events → memories + profiles，jobs 驱动。中文结构化 prompt（六类 type、必须复用 topic、
  valid_until 用本地墙钟换算），输出强校验 JSON（结构不对就抛错交给 jobs，不静默降级）；
  失败分 `unavailable`（没配模型 → 跳过不算失败但 30min 后重试、留痕）与 `runtime`
  （超时/坏输出 → 退避 60s→120s、3 次进死信），**失败可见**；同 key 新版本走
  superseded 链；水位线只在写库成功后推进（崩溃重跑安全）。
- **检索 + 注入渲染**（`lib/agent/memory-v5/search.mjs`）：绝对量打分
  `score = TYPE_WEIGHT[type]·(0.55·rel(全库归一) + 0.22·salience + 0.18·recency + 0.10·pinned) − 0.25·MMR`；
  按字数预算装填（默认 800，三块 350/120/60）；跳过当前上下文（events 水位线 / 桥传
  contextSince）；`dm_only` 只在私聊注入；单字/短查询回退 LIKE；防复读块与人物画像块。
  实测 886 条库 **p50 2.7ms / p99 4.3ms**（目标 P99<5ms）。
- **桥读路径可切换**（`lib/bridge/index.js`）：`LLMINQQ_MEMORY_ENGINE=v4|v5`
  （环境变量优先，默认仍 **v4**）+ `config.memory.v5.engine`；v5 任何失败自动回退 v4、
  本轮回复不受影响；注入成功后只对真正渲染进块的条目 `touchMemory`。
- **distill 定时任务**：仅 engine=v5 时挂到桥定时器（默认 10 分钟，防重入，进 shutdown
  清理），失败交给 jobs 退避/死信。

### Fixed

- `test/unit-split.test.mjs`「静默恢复」用例的浮点 flaky：容差 1e-9 → 1e-3
  （`Date.now()` 跨 1ms 就会超差，约 1/8 概率偶发失败）。

### Added（记忆 v5 · Step 1：双写）

- **v5 数据层**（`lib/agent/memory-v5/store.mjs`，node:sqlite）：events / memories /
  mem_fts / profiles / utterances / jobs 六张表（WAL + `busy_timeout=3000`）。
  `appendEvent` 靠 `UNIQUE(conv,msg_id)` 幂等（重放不重复、不抛错）；jobs 带退避与死信
  （claim 即计一次、3 次进 dead）；中文 2-gram FTS5（「开会」能命中「明天下午三点开会」，
  单字查不到时回退 LIKE）。
- **桥侧双写 events**（`lib/bridge/index.js`）：入站（含合并轮）与出站（文本/图片/语音）
  各写一条进 `<记忆数据目录>/mem-v5.db`；`config.memory.v5.enabled` 透传 + 环境变量
  `LLMINQQ_MEMORY_V5=0` 急停；**读路径完全不动**（注入仍走 v4），写库失败只告警一次并
  永久降级，绝不影响收发消息。
- **只读计量脚本** `scripts/memory-v5-count.mjs`：对比 v5.events 条数与 bridge.out 可解析
  行数（默认拒绝生产路径，库/日志 cp 到 /tmp 即可跑）。

## [未发布]

### Fixed（记忆 v5 · Step 0 止血）

- **反思（reflect）在 fallback 下会随机烧掉未覆盖的记忆**：`mark_ids` 只在真正成功的
  LLM 批次里打标；`_fallback_summaries` 的分桶改 `sorted(tokenize())`，消除
  `PYTHONHASHSEED` 导致的「一半概率白跑、一半概率烧 80 条」。
- **ingest 游标先写后提交**：游标移到 DB commit 之后 —— 崩溃时宁可重放，不可漏。
- **`prune` 数学上永远归档 0 条**：改为独立三元组（低 importance + 少 hit + 超两个
  半衰期），pinned 永不归档；生产库副本实测从 0 变成可归档 258 条。
- **digest 被整体截断丢掉两层**：改为每层各 1/3 预算 + 逐层轮转，三层在 420 字窗口内
  都可见。
- **日志轮转后从行中间读**：轮转时归零 `.ingest_cursor` 并写 inode/size 指纹；
  起桥前自愈（游标 > 日志大小或 inode 变了 → 归零），正常追加不动游标。
- **style.db split-brain**：桥的 `LLMINQQ_STATE_DIR` 统一到 `memoryStateDir()`，
  运行态目录（state.json）与记忆目录分开；桥 state.json 首次启动单向迁移（源保留）。
- **`memoryEnv` 缺 `LLMINQQ_CONFIG`**：reflect/learn 子进程现在能读到
  `bridge-config.json`（也保证首次安装时调度器启动前它已存在）。
- **调度器把失败当成功、把空转当失败**：按「退出码 + 输出语义」判（none/llm-empty=成功、
  mode=error 即使退出码 0 也判失败、fallback=降级），`scheduler.json` 记连续失败与死信，
  设置页「记忆」页新增只读「定时任务」卡片。
- **新增 `memctl sanitize`**（默认 dry-run）：扫/清 prompt 注入残留与排版污染。
- **新增只读审计脚本 `scripts/memory-audit.mjs`** 与跨通道注入回归测试。

### Note

- 桥的状态文件从 `<dataDir>/state/state.json` 迁到 `<dataDir>/agent/memory/state.json`
  （`migrateBridgeStateFile` 单向拷贝、源保留）。**回滚到 0.5.5 之前版本**会读旧快照，
  可能丢掉迁移之后的新好感度/会话映射 —— 回滚前先备份新文件。

## [0.5.5] - 2026-11-03

### Added

- **长句按标点切分（v2-3）**：新增纯函数 `splitAtBoundary`（`lib/bridge/common.js`），
  只在**中文逗号/顿号、英文逗号、句号、英文句点、半角/全角空格、换行**处断句，
  **绝不把一句正常的话从词中间劈成两段**。用户原例：阈值 20 时
  「今天下午的天气真的好好啊，你要不要和我一起出门去公园散散步」必须切成
  「今天下午的天气真的好好啊，」+「你要不要和我一起出门去公园散散步」，
  不能切成「…你要 / 不要…」。全文没有切点时**整条不切**（宁长不残），最多 3 段。
- **模型可标 `[SPLIT]` 断点（混合方案）**：想分几条发就在断点处写 `[SPLIT]`，
  桥按标记拆段并剥掉标记；某一段仍然超阈值时再走 `splitAtBoundary` 按标点二次拆。
  `sanitizeUntrustedText` 会把群友可控文本里的 `[SPLIT]` 打散，防伪造断点注入。

- **表情包图库随插件分发**（`lib/memepack.js` + `qq-agent/meme-pack/`）：
  脚本版自带的 99 张图 + 含义索引（caption / keywords / tag）在封装成插件时漏搬了 ——
  AGENTS.md 让模型去工作区 `meme-pack/` 找图，那里却不存在，只能去借第三方插件
  dsh-expression 的 node_modules 图库，学到的表情也写进那个包目录（升级即丢）。
  现在：插件启动时把随包图库落到 agent 工作区（`<dataDir>/agent/meme-pack`），
  用 `meanings.json` 重建与 dsh-expression 同 schema 的 `index.db`（含 FTS5），
  **幂等**：已存在的图片不重拷、已有索引行不覆盖 —— 升级不会冲掉学到的表情。
- 第三方插件 `dsh-expression` 的 `memeRoot` 指向同一份图库（Web 面板与 QQ 共用），
  `qq-meme` skill 的学习结果也落在这里。
- AGENTS.md 表情包章节改成「按 caption/keywords 找含义」，并写明学习走 `qq_meme.py learn`。
- **入站非图片消息不再被丢掉**：`file / voice / video / mface / contact /
  location / dice / rps / onlinefile / 未知段` 都生成人类可读占位（`[文件] 名字 (大小)`、
  `[语音] 5s`、`[群在线文件] ...`），带这些段的消息不再命中「空消息，忽略」被整条丢弃；
  上下文明确告诉模型「你只能看到占位描述，看不到文件/语音内容」。
- **入站文件真机下载**：按 NapCat 真机段形状实现（文件名在 `data.file`、段内可能直接带
  `url`）。下载顺序：段内 url → `get_group_file_url` / `get_private_file_url` →
  `get_file` 兜底 → 降级原因。落暂存区，走 `safeFetchBuffer`（SSRF/私网/重定向复检），
  单文件 20MB / 单条 5 个 / 30s 超时，失败只降级不炸轮次；群在线文件（`onlinefile`）
  无 url，只占位并说明「拿不到内容，让他私聊传或截图」。
- **设置页「入站文件」卡片**：开关 / 单文件上限 / 单条数量 / 超时，经 `bridgeConfig()`
  透传到桥（此前只有桥侧默认值，设置页改了不生效 = 假配置）。
- **QQ 语音转文字（可选，默认关）**：语音段 url 下到暂存区 → faster-whisper（CPU int8，
  默认 `small` + `zh`）→ 注入【对方发来一条语音】+ 转写文本；同一 `file_id` 去重、
  整条消息 30s 总预算、超时/失败降级为「没转写成功」。首次开启下载 ~480MB 模型，
  可用 tiny/base/medium，funasr 作为可选引擎（import 失败自动回退）。
- **待办完成后可更新**：新增 `memctl done --match/关键词 | --id`：归档旧待办（`retired=1`）
  并留一条「已完成：…」结论；`digest.md` 用 ✅ 渲染已了结事项，主动搭话的话题线索
  跳过 `已完成：` 条目。

### Changed

- **精力改成全局一份**（`state.energy = { value, at }`）：不再按会话各存一份 ——
  同一个号在群里/私聊耗的是同一个「人」的力气。加载旧 state 时用各 peer 精力值的
  **最小值**迁移（一个都没有才用 start），不会凭空回血；扣减/恢复都是同步函数，
  多会话并发时不会交错丢更新。
- **精力参数重调**：start 0.9 / floor 0.15 / ceil 1.0 / perMsgDrop 0.007 /
  perHourRestore 0.45（约 2 小时回满）。每条扣减 = perMsgDrop × 长度系数 × 情绪系数；
  长度系数 = 0.5 + 字数/150（上限 3），单条扣减上限 0.25。典型 30 字回复掉约 0.005，
  连聊约 150 条从 0.9 掉到 0.15。
- **精力硬截断改为按标点截断**：cap 内找最后一个切点截断、**丢弃右段、不再加「…」**；
  cap 内无切点则找 cap 后第一个切点；全文无切点就整条发（宁长不残）。
- **低精力档位与提示词对齐**：`ENERGY_DEFAULTS.energyCaps` 统一为
  >=35% 不截 / 20~35% 40 字 / 10~20% 20 字 / <10% 10 字，
  `energyHint` 的字数上限直接从同一份档位推导（避免提示说 40 字、硬截断按 20 字）。
- **主动路径也扣精力**：接话/主动搭话/戳一戳（`dispatchOutbound`）发送后扣一次；
  入站路径的扣减从 `handleInbound` 挪到 `deliverReply` 真正发出之后，
  按**实际发出的正文**长度算，不会重复扣、也不会在静默时白扣。
- **主动搭话 / 接话补上【当前时间】**：与入站回复共用 `currentTimeLine()`
  （`当前时间：2026-11-03 12:35 周一（下午）`）—— 之前两条主动路径拿不到任何时间信息，
  容易说错「你昨天……」这类时间锚。
- **`chunkText` 改为边界感知（不再句中腰斩）**：优先在 `，、,。. 空格 换行` 处切；
  limit 内没有切点就往后找、全文没有切点才硬切；`[AT:] / [SEND_FILE:] / [VOICE:]`
  控制标记不被劈开。用户实测「像个人」被切成「像个 / 人」的根因是生产
  `maxReplyChars=50` 处硬切（现已由用户调到 120，代码侧不再硬切正常句子）。

### Fixed

- **GSV 语音参考音色不生效**：GSV 的 `api.py` 对 `refer_wav_path / prompt_text / prompt_language` 是**整组回退** —— 任意一项为空就全部改用启动参数 `-dr/-dt`。桥在参考文本没填时传 `prompt_text: null`，于是设置页选的音频被启动参数里写死的 `reference/ref.wav` 顶掉（「设置页换了声音、QQ 里没变」的根因）。修复：`scripts/start-gsv.mjs` 按设置页参数启动并同步 ref.wav；`messaging.js` 在 promptText 为空时告警而不是静默失败。
- **NapCat 重启后卡二维码**：`napcat-docker` 的 entrypoint 只有收到 `-q <号>` 才会用本地凭证登录，否则一律扫码 → 容器一重启机器人就失联。新增 `napcat.account` 配置 → compose `ACCOUNT` env（纯数字才写入，防注入）。
- **NapCat 日志重启就丢**：`fileLog` 写在容器内 `/app/napcat/logs`，但该目录从未挂到宿主机，容器重建即清空。新增 `data/logs:/app/napcat/logs` 挂载 + docker json-file 日志轮转（20m × 3）。
- **AGENTS.md 记忆目录说明过期**：改为区分「记忆代码目录」（插件包 `lib/agent/memory/`）与「记忆数据目录」（`<数据目录>/agent/memory/`），并给出一条读 `bridge-config.json` 的定位命令。

## [0.5.4] - 2026-10-31

> 这一版收的都是「打开总开关之后才暴露」的问题。0.5.3 的功能都通了，
> 但真正把总开关打开、让桥跑起来，才会踩到下面这些。

### Fixed

- **打开总开关后 CPU 被打满（4 分钟 99 次进程启动）**。这是两个 bug 叠在一起：

  **① profile 推导错了。** 插件装在 `~/.dsh/profiles/web/node_modules/` 下，
  `detectProfileName()` 反推出 `web`，桥就用 `dsh --profile web` 起 ACP 子进程。
  而 **`web` 是会起 HTTP 服务的那个 profile**（`@deepseek-ai/dsh-host-webserver`
  + ui-settings 全家桶），它要占 3080 端口 —— 已被正在运行的宿主占了：

  ```
  listen EADDRINUSE: address already in use 127.0.0.1:3080
  dsh: startup failed: 2 required plugins did not activate
  ```

  原来的保留名单只有 `desktop`，漏了 `web`（和同样会组装 web 服务的 `headless`）。
  现在 `desktop` / `web` / `headless` 一律落到随附的 `acp`（纯 stdio，不起端口）。

  **② `start()` 没有失败退避。** 失败时 `startPromise = null`，而
  `_ensureSession` / `prompt` 都是 `if (!this.ready) await this.start()` ——
  所以下一次调用立刻又全量 spawn 一遍。每次 spawn = 加载整套 DSH + 9 个插件
  + 撞端口 + exit 1。实测日志里 **99 次**「bridge 启动」+ **99 次** `dsh` 启动，
  而里面一条消息都没有，CPU 就是这么顶满的。
  现在失败进入指数退避（5s → 10s → 20s → … 上限 5 分钟），冷却期内直接报
  「上次失败」而**不再 spawn**；成功一次就清零。

  **③ 桥侧还有第二道防线。** 只修插件侧推导不够 —— `bridge-config.json` 是
  「插件写、桥读」的，旧版本写进去的 `profile: "web"` **已经落盘**，升级插件后
  桥读到的仍是旧值。所以桥启动时自己再判一次（`DSH_PROFILE`），
  把会起端口的 profile 名也改写成 `acp`。实测拿一份 `profile: "web"` 的配置
  真跑桥，日志出现「已改用 "acp"」且 `acp: 启动 dsh --profile acp`。

  **④ 根因不再只留 `code=1`。** 起不来时 stderr 里的 `EADDRINUSE` /
  `startup failed` 现在会被翻译成一句人话并挂到 exit 日志上，
  直接点明「profile 抢了宿主端口，把 ACP profile 留空或填 acp」。
  原来用户只能看到 `acp exited code=1`，根本查不出原因。

  **实测对比**（同一份 `profile: "web"` 的配置，跑 60 秒）：
  修复前 4 分钟 99 次 spawn；修复后 **1 次**，全程 CPU 0.0%。

- **配的模型一个都没被调用过（`-32603` 的真因）**。用户反馈「为什么整自动回复」，
  日志里三个模型全报 `Internal error (code -32603)`。
  查下来是**上游 profile 根本没有那个 provider**：
  - 插件配 `trae/deepseek-v4.1-flash`，而 trae 是由 `dsh-our-free-model`
    注册进 **web** profile 的；
  - 桥起的 ACP 子进程用的是 **acp** profile —— bundles 只有 `dsh-base` +
    `dsh-acp-app`，里面**只注册了 `deepseek-official`**；
  - 于是 `session/set_config_option` 设 `trae` **静默失败** → 回落到
    `deepseek-official` → 而它没有 API key →
    `llm-deepseek: no API key for provider route "deepseek-official"`。

  **没有任何一处报出真正原因**，用户只能看到「模型暂时不可用」，换模型、重试都没用。
  修复：本机已把 `dsh-our-free-model` 挂进 acp profile（凭据在全局
  `~/.dsh/.credentials.yaml`，不用重登），ACP 现在能看到
  `trae/qodercn/cline/gemini/our-free-model` 共 5 组 provider。
  三个路由实测全部可用（ds41f 7.4s / dfmodel 7.0s / glm-5.3-flashx 9.8s）。
  `INSTALL-PLUGIN.md` 补了完整自查与修复步骤 —— 否则换台机器还会踩。

- **图片能力被误判成不可用（provider 注册竞态）**。用户指出「ds41f 应该支持图片」，
  而宿主模型目录确实写着 `inputModalities: ['text','image']`，但 ACP 一直报
  `inline image prompts were not advertised by this connection`。

  根因在 `dsh-acp` 的 `initialize`：
  ```js
  imagePromptEnabled = await supportsAcpImagePrompts(ctx, config.provider, config.model)
  ```
  它调 `llm.resolveModelInfo(provider, model)` 查 inputModalities。而桥**一 spawn
  就立刻发 initialize** —— 那时第三方 provider 插件还没注册完，查询抛错被 catch
  吞掉 → 返回 `false`，**这个值在整个子进程生命周期内不再更新**。

  实测（同一份配置，只改 initialize 时机）：
  | 延迟 | image |
  |---|---|
  | 500ms | false |
  | 1000ms | false |
  | 1500ms | false |
  | 2000ms | false |
  | **2500ms** | **true** |

  修法：initialize 前先等 provider 注册就绪（实测约 2.5s，取 3s 留余量），
  只对**非内置** provider 生效（`deepseek-official` 由宿主自注册，没有竞态，
  白等 3 秒没必要）。实测修复后：
  ```
  acp: 已等 3002ms 让 provider 注册就绪（路由 trae/deepseek-v4.1-flash）
  acp: 图片输入 可用
  ```

- **打开总开关后调度器不启动（又是「只在加载时读一次配置」）**。用户把总开关打开、
  桥也跑起来了，但 `/overview` 里始终是 `{"enabled": false, "tasks": []}` ——
  两个字段都空，正是 `scheduler ? scheduler.status() : {enabled:false,tasks:[]}`
  的默认值，说明 `scheduler` 变量是 null，调度器**根本没被创建**。

  根因：调度器只在 `apply` 里创建，判断用的是
  `const cfg = readConfig(); if (cfg.enabled) { ... }` —— 而 `cfg` 是**插件加载
  那一刻的快照**。用户在加载**之后**才打开开关，那个 `if` 早就过去了。
  于是桥起来了（`startBridge` 走实时配置），但
  `ingest(5min) / reflect(8h) / digest(30min) / learn(12h)` **全部停摆**，
  而设置页完全看不出来 —— 用户以为「打开开关就全好了」。

  实测佐证：总开关为 true、桥跑了近 4 小时，但 `mem.db` 一条没增（ingest 该 5 分钟
  跑一次）、`digest.md` 三小时没更新。

  修法：抽出 `ensureScheduler(enabled)` 状态机 ——
  `off→on` 创建并 start、`on→off` 停掉（SIGTERM 子进程不留孤儿 python）、
  `on→on` 幂等 no-op（不重建，避免正在跑的任务被打断）。
  三个触发点：插件加载、`POST /config` 保存、`POST /config/reset` 恢复默认。
  现在开关是**真正实时生效**的，不用重启。

  实测（重启后）：`enabled: true`、4 个任务都在、`ingest` 在 15:14:21 真的跑了一轮
  且 `lastError: null`。

- **`bridge.log` 涨到 35GB 写满磁盘（EPIPE 自激死循环）**。日志里是这样的：

  ```
  ERROR 未捕获异常（第 50130295 次，桥继续运行）: Error: write EPIPE
  ...完整堆栈...
  ```

  **五千万次**，一行约 700 字节 ≈ 35GB。根因是一个闭环：

  1. 宿主关掉了桥的 stdout 管道 → `console.log` 抛 `EPIPE`
  2. 异常变成 `uncaughtException` → `crashGuard()` 记一条 ERROR
  3. crashGuard 里又 `logger.log` → 又 `console.log` → stdout **仍是断的** → 再抛 EPIPE
  4. 回到 2，无限循环

  三层修复（缺一层循环都还能转起来）：
  - **stdout 熔断**：`console.log` 裹 try/catch；一旦 EPIPE 就**永久停写**并计数
    （管道断了不会自己恢复，继续试就是烧磁盘）。
  - **crashGuard 防重入 + 限流**：处理异常期间再来的异常只计数不写日志；
    同一类错误每分钟最多写 20 条。
  - **`bridge.log` 体积上限**：这个文件**从来没被轮转过**（宿主只给 `bridge.out`
    做了 8MB 轮转），现在 16MB 上限、保留 2 份，启动时检查一次 + 运行期每写 4MB 复查一次。

  实测（10 万次异常风暴）：旧逻辑写 10 万行（≈70MB），新逻辑 **console.log 只调 1 次、
  日志只写 20 行**。

- **自动清理孤儿**那段**从没生效过**（路径少上溯一级）。`index.js` 在
  `<pkg>/lib/bridge/`，脚本在 `<pkg>/scripts/`，但代码只上溯一级 →
  算出 `<pkg>/lib/scripts/`（那个目录不存在）→ `existsSync` 为 false →
  整段清理被**静默跳过**（连日志都没有，所以这个 bug 藏了很久）。

  实测后果：同时有 **4 个桥**在跑（3 个 PPid=1 的孤儿），
  - 同一条 QQ 消息「好无聊啊」被处理 **4 次**（4 条 `入站` 日志、2 个不同 session）
  - 发出多条互相矛盾的回复
  - 其中一路失败时插一句「脑子卡了一下」

  现在：路径上溯两级 + **脚本缺失时打 WARN**（不再静默），并已清掉现存孤儿。

- **ASR 转写完了，结果却回不到会话**（用户实测）。用户发了个 B站视频链接，
  模型调 `bili_transcribe_start` 拿了 `job_id`，说了句「视频没公开字幕，
  我还在后台从视频里转文字，等转好了看看它怎么说」就**结束了这一轮**（37 秒）。

  ASR 在后台继续跑，09:52 转完（3574 字节，成功，`~/.dsh/bili-duty/tmp/BV163xB6zEwF.txt`
  文件就在那儿），但**没有任何人再去取**：
  - 模型这一轮已结束，没有「下次工具调用」的机会；
  - `_TRANSCRIBE_JOBS` 只在 MCP 进程内存里，桥根本看不到；
  - 用户那边就永远等不到「那个视频讲了什么」。

  修法（磁盘是 MCP 和桥唯一能碰的共同面）：
  - MCP 转完把结果**落盘**到 `<stateDir>/transcribe-ready/<job_id>.json`
    （临时文件 + 原子替换，桥不会读到半个文件）；error 也写，带错误原因。
  - 桥在**拼下一轮上下文时**扫这个目录，把没送达的结果作为系统提示注入，
    然后打个 `.sent` 标记（不删文件，留着排障）。
  - 已 sent 的不再重复注入 —— 否则每轮都会把整段视频全文再喂一遍，白烧 context。
  - 路径必须两边一致：桥从 `memory.dir` 反推 `<dataDir>/state/transcribe-ready`，
    MCP 用 `$LLMINQQ_STATE_DIR`，实测两边算出来完全相同。
  - 不选「桥起定时器主动推给用户」：主动说话会打断对方，而且同一份结果
    可能被多个 peer 看到；挂在「下一轮上下文」最自然 —— 对方下次说话时模型就知道了。

- **恢复会话时丢掉全部 MCP 工具**（2026-11-01 用户实测「他给我回的就不沾边」）。
  用户发了个图文讲解视频，机器人答得完全不相关。

  查会话原始记录（`~/.dsh/sessions/.../session.v4.jsonl.zstd`）拿到决定性证据 ——
  turn 8 有一条 `tool-registry` 事件：

  ```
  一次性移除 39 个工具（全是 mcp__bilibili__* 和 mcp__storyboard__*），新增 0
  ```

  之后模型调 `bili_search` 直接报 `unknown tool "mcp__bilibili__bili_search"`，
  只能退回用 `bash` 瞎猜 —— 所以它答不出视频内容。

  根因在 `lib/bridge/acp.js` 的 `_ensureSession`：

  ```js
  // 修复前
  await this._request('session/resume', { sessionId: remembered, cwd: this.cwd }, 60000)
  ```

  **没传 `mcpServers`。** 而 `dsh-acp` 的 `AcpSession.resume()` 里是

  ```js
  await mountAcpMcpServers(agentCtx, options.mcpServers, options.cwd);
  ```

  传空数组 = 一个 MCP 都不挂 = 所有 MCP 工具消失。而 `session/new` 那边**是传了的**，
  所以只有「恢复会话」这一路会丢 —— 这就是它「时好时坏」的原因：
  新会话正常，老 peer 只要恢复过一次就永久没工具。

  ⚠️ 这个 bug 特别难发现，因为桥日志只记「恢复会话 xxx」，看不出工具没了；
  而模型不会报错，它会**优雅降级**（用 bash 猜），表现为「答得很离谱」而非「明确失败」。

  实测对比（同一会话，只改传不传 `mcpServers`）：
  | | dsh 子进程 | 系统里 MCP 进程 |
  |---|---|---|
  | 不传 | 0 | 0 |
  | 传了 | 2 | 2 |

- **升级后 `AGENTS.md` 不更新，新规则永远到不了模型**（同一个事故的另一半）。
  上面那次答非所问，除了 MCP 工具丢了，还有一层：我当天在 `AGENTS.md` 里新加的
  §5.2「什么时候必须看图」**压根没到模型手里**。

  原因：`ensureAgentScaffold` 里是 `if (!fs.existsSync(agentsFile)) { 写一次 }`，
  注释还写着「升级插件不会重写它」。于是 agent 工作区那份永远是 10-31 的旧版。

  但「升级就覆盖」也不对 —— 用户可能自己改过。改成**三态判断**：
  - 不存在 → 写入
  - 我们写的且是旧版（用文件末尾的 sha256 指纹判断）→ 升级
  - 用户改过（指纹不符）→ **不覆盖**，只记一条日志提示
  - 无指纹（旧版插件写的或用户改过）→ 不覆盖，提示「想用新版就删掉它重建」

  每次写入都在文件末尾打指纹注释，下次就能区分「谁写的、有没有被改」。

- **字幕一直在丢时间戳**（用户问「字幕有时间戳吗」）。B站字幕 body 每段本来是
  `{"from": 0.3, "to": 3.31, "content": "..."}`，但代码只取 `content` ——
  **把「这句话在第几秒说的」这条最有用的信息删掉了**。

  为什么这是「图文理解」的前提：宫格图每格标着时间戳，字幕不带时间戳就**对不上**；
  用户问「第 30 秒那个东西是啥」也答不了。

  现在返回三种形式：
  - `text`        纯文本（老行为不变）
  - `timedText`   `[0:06] 台词` 每行带时间
  - `segmentsWithTime`  `[{from, to, text}]` 结构化

- **凭据路径硬编码，导致所有需要登录的工具全废**（真 bug，藏了很久）。
  `CRED_FILE` 写成 `<包目录>/bili_credential.json`，而插件通过
  `BILI_CREDENTIAL_PATH` 下发的是 `~/.dsh/bili-duty/bili_credential.json` ——
  **那个变量根本没被读取**。于是 `load_credential()` 返回 None，
  `bili_subtitle` / `bili_comments` / `bili_reply` 全部退化成「未登录」。

  用户看到的表现：机器人说「视频没公开字幕，我还在后台从视频里转文字」——
  **其实有字幕（86 段），是工具没登录读不到**。

  现在优先读 `BILI_CREDENTIAL_PATH`，空值才退回包目录（手工跑的老行为不坏）。

- **yt-dlp 实测收益显著，已安装并调整工具优先级**（用户要求「测一下收益，
  如果效果好就把优先级提前」）。

  实测（同一个图文讲解视频 `BV163xB6zEwF`，347 秒）：

  | | `bili_frames`（B站故事板） | `video_storyboard`（下载后扫描）|
  |---|---|---|
  | 尺寸 | 480×270 | 874×701 / 1009×620（每格 286-331px）|
  | 来源 | B站为进度条预览做的 | 真扫全片 10380 帧，按画面变化选帧 |
  | 效果 | **看不出内容**（只看到「EP02 12/22」页码和残缺词条）| 一眼看出「7+8=15 划掉改 13」这种对话示例 |

  耗时：下载 360p 4.2MB 约 **2.6 秒**，storyboard 出图 **4-9 秒**。
  storyboard 本来就内置 URL 支持（`if (isHttpUrl(input)) resolveInput(...)`），
  **只缺 yt-dlp 二进制**（它刻意不打包，见 vendor 的 `fetch.js` 注释）。

  安装方式（本机）：PEP 668 挡住 `pip --user`，改用 venv + 软链
  （`~/.local/share/yt-dlp-venv` → `~/.local/bin/yt-dlp`，已在 PATH 里）。
  `AGENTS.md` §5.2 已改成 **storyboard 优先、bili_frames 只作快速预览**。
  `INSTALL-PLUGIN.md` 补了完整安装章节（PEP 668 警告 / 三平台装法 /
  venv 拷贝后的 shebang 坑 / PATH 验证 / 「成功与失败各长什么样」的日志特征）。

- **「很多视频需要图片才能理解意思」：帧数上限 6 → 200 + 提示词补「必须看图」规则**
  （用户要求）。
  - `bili_frames` 的 `_FRAME_MAX` 6 → **200**，模型可以自己传 `num`。
    但**实际返回受 B站故事板格数限制** —— 实测一个 347 秒的视频只有 **43 格**。
  - 加**同格去重**：请求 200 帧而故事板只有 43 格时，按「时间最近」取会让多帧
    落到同一格，同一张图传多次模型看不到新信息，只是白烧 token（每张 100-200，
    200 张就是 2-4 万）。实测：请求 6→6 张、50→40 张、200→42 张，都是去重后的真实数量。
  - `AGENTS.md` 新增 §5.2「什么时候**必须**看图」：教程/手工/做饭（步骤在动作里）、
    舞蹈/表演、游戏实况、对方问「这个怎么样」、字幕为空或与标题不符、图里有图表数据 ——
    这些只看文字会理解错。并给了「先 3 张看大概 → 不够再加 → 定点用 at」的省法。
  - 工具自描述里也带上「什么场景必须看图」：模型未必会读到 AGENTS.md。
  - **关键前提已就绪**：日志实测 `acp: 图片输入 可用`（provider 注册竞态修好之后），
    不然图拿到也看不见。

- **断句去掉句号 + 多发几条**（用户要求：「断句的时候去掉句号，没人在聊天工具里用句号，
  而是多发几条」）。这不是审美问题 —— 真人 QQ 聊天几乎不打「。」，
  带句号会立刻透出「这是生成文本」的味道。
  - 新增 `stripPeriod()`：删中文句号，**保留 ！？**（真人也会打问号感叹号，
    删了反而让语气变平）；英文句点只删行尾（别把 3.14 / BV 号拆坏）。
  - ⚠️ 顺序很关键：**先在带句号的原文上切分，再逐段去句号**。
    如果「先去句号再切」，中文长句会切不动（实测 48 字长句变成 1 条，
    正好和用户要的「多发几条」相反）。
  - `splitMaxParts` 默认 2 → **3**（真人连发 2-3 条自然，4 条以上开始刷屏）。

- **模型失败不再回兜底文案**（用户明确要求「失败就不回复了」）。原来失败会发
  「脑子卡了一下，等下再说」/「刚刚没接住，你再说一遍？」。
  兜底的触发率远高于真实故障（多桥并存时只要一路失败就插一句废话），
  现在静默失败 + 日志留痕。

- **打字延迟只有第一段有**（用户实测「补发的那条没有延时」）。旧顺序是
  「先算延迟 → 等一次 → 再 split 连发」，所以拆出来的第 2、3 段只走
  `sleep(400+random*600)`（约 0.4-1 秒），看起来就是「第一条有打字时间，补发的秒出」。
  改成**先拆再逐段计时**：每段按自己的字数算延迟（短句快、长句慢），
  段间再加一个「敲完一句的停顿」。日志会标出「第 N/M 段，X 字」。

- **模型凭空假设场景（周日说你在加班）**（用户实测：周日 17 点问「加班加完了？
  这会儿是工位摸鱼还是已经躺下了」）。查记忆：只有一条含「加班」，
  **就是它自己刚才说的那句**，摘要里没有任何相关事实 —— 是模型自己编的。

  为什么它会编：提示词里有 `当前时间：2026/11/1 17:53:34`，但只是**一串数字**，
  模型得自己算出「这是周日、下午」再推出「周日一般不上班」。LLM 最不擅长这个。
  现在新增 `timeSceneHint()`：把结论**直接写给模型** —— 星期几、时段、
  这个点正常人一般在干嘛，并明确警告「不要凭空假设对方在上班/加班/开会」。
  同时区分「背景常识」和「事实断言」，别让模型把「通常」当成「此刻」。

  顺带修了时区：`hourNow()` / `weekdayNow()` 按 `policy.timezone` 取，
  **不用本机 `getHours()`** —— 这台机器 `getHours()` 是 9（UTC），
  而用户那边是 17，差 8 小时会让时段语义整个错位。

- **重启后留下孤儿桥进程没人管**。实测两个桥并存：
  `PID 561089 PPid=1（孤儿，CPU 45.9%、内存 1.9GB、累计 CPU 3h13m）` +
  `PID 626677`（本次 dsh 的子进程）。它们死连同一个 OneBot 端口，
  孤儿还占着 18080 → 新桥 `EADDRINUSE`。

  根因：`lib/bridge/index.js` 里本来就有「启动前清孤儿」的调用，
  但它引用的 `scripts/cleanup-orphan-acp.mjs` **从来没被创建过** ——
  那段代码一直是死代码（`if (fs.existsSync(script))` 判断不过，静默跳过）。
  而且原设计只管 `dsh --profile` 子进程，**根本不管桥自己**。

  现在补上这个脚本，判据保守（三条全中才算孤儿）：
  `PPid == 1` + 命令行里有本插件桥入口路径 + 不是当前进程自己。
  默认**只看不杀**，要杀必须 `--kill`。实测能准确识别孤儿，
  且不碰活桥（活桥 PPid 不是 1）和不相关的 PPid=1 进程（dockerd 之类）。

- **配置了不存在的 dsh 路径时，会静默换用另一个 dsh**。实测配置
  `/nonexistent/x` 不仅没报错，还**真的启动成功并完成了 ACP 初始化** ——
  因为 `resolveDshCommand()` 在「配置了但文件不存在」时**继续往下探测 PATH**，
  悄悄用掉了系统里的那个 `dsh`。

  这是最坏的一种失败：用户以为跑的是自己指定的那个 dsh（可能是特定版本或
  特定 profile），实际跑的是另一个；行为不一致时根本查不出来。
  现在**显式配置的路径不存在就直接失败**，报错里写明「不会自动换用别的 dsh」
  并带上全部探测记录。只有默认值 `dsh`（等于没配）才继续自动探测。

  副作用修复：测试用不存在的 bin 期望「必然失败」，结果它真起了一个 dsh
  挂在那儿等 ACP 响应，把整个测试套件卡死（超时 90s+）。
  现在失败耗时 **2135ms → 4ms**。

- **孤儿清理判据有盲区（不带 `--patch` 的 ACP 子进程漏掉）**。实测有个孤儿是
  `dsh --profile acp`（没有 `--patch` 参数），原判据只认「命令行含
  dsh-plugin-llminqq 或 patch 路径」，于是它被判成「不匹配本插件特征」——
  扫 437 个进程报「0 个孤儿」，孤儿还在跑。
  现在加一条可靠判据：**cwd 落在插件数据目录内**（我们桥起的 ACP 子进程 cwd
  一定在 `.../dsh-plugin-llminqq/` 下，别人家的 dsh 不会恰好跑在那里）。
  实测三种场景都对：我们的孤儿认得出、别人家的 `dsh --profile acp` 不碰。

### Tests

- 新增 `test/unit-acp-backoff.test.mjs`（10 条）：会起端口的 profile 必须落到 acp、
  正常 profile 名不被吞、空值兜底、`isHostProfile`、**连续 5 次 start() 只 spawn 1 次**、
  冷却期报错带原因和剩余秒数、退避指数增长且有上限、成功后清零、`EADDRINUSE`
  诊断、桥侧最终防线。
- 新增 `test/unit-log-runaway.test.mjs`（7 条）：console.log 必须裹 try/catch、
  stdout 熔断 + 计数、crashGuard 防重入与限流、`bridge.log` 体积上限、
  运行期轮转、**10 万次异常风暴只写有限行**。
- 新增 `test/unit-orphan-cleanup.test.mjs`（13 条）：脚本存在、能列进程、
  PPid=1+本插件路径=孤儿、**父进程还活着绝不能杀（防误杀活桥）**、
  PPid=1 但不是我们插件不碰、不认死某一条绝对路径、自己受保护、默认不杀、
  桥启动时确实调用。
- 新增 `test/unit-scheduler-hot.test.mjs`（6 条）：关闭时不创建、**开启时真的创建
  （并要求任务表里有 ingest/reflect/digest/learn）**、重复调用幂等、on→off 真停、
  off→on 能再起、保存配置路径确实调了 ensureScheduler。
- `test/unit-scheduler.test.mjs` 补 digest 相关 5 条；并把一条依赖 1000ms 定时器
  的测试超时从 10s 放宽到 25s —— 它和全量测试并行跑时，宿主负载高会偶发误报
  「任务停摆」（单独跑 100% 通过），断言强度不变。


- **「重新获取二维码」以前根本没换码**。`POST /qr/refresh` 走的是 `fetchQrCode()`，
  而它只是 `docker cp` 容器里那张 `qrcode.png` —— 全程没调 NapCat 的刷新接口。
  于是接口诚实地回了 `ok: true`（cp 成功），但图片字节级和上一张一模一样，
  用户看到的就是「点了没反应」。现在真的调 `POST /api/QQLogin/RefreshQRcode`，
  并等文件落盘后比对 md5 才算成功；换不动就如实回 `changed: false` + 原因。
  顺带修了 WebUI 凭证要缓存（NapCat 的 `loginRate` 默认 3，每次刷新都重登会撞限流）。
- **WebUI token 会和容器里实际那张分叉**。实测 `secrets.json` 和容器 `webui.json` 里的 token 不是同一个；用前者调 `/api/auth/login` 返回
  `token is invalid`，于是设置页「打开 NapCat WebUI」打不开、刷新二维码也鉴权失败。
  现在以盘上的 `webui.json` 为唯一真源（`resolveWebuiToken`），并把 secrets 镜像过去。
- **打开设置页慢**，实测拆出来是三件事叠加：
  - 预热带用 `cfg.mcp?.bili?.pythonBin || cfg.memory?.pythonBin` 自己算缓存 key，
    而 `buildMcpServers` 实际解析出的是 bili-duty 的 venv python —— key 对不上，
    预热永远命中不了，第一次 `/overview` 仍然同步 `execFileSync(python -c "import…")`，
    **实测钉住宿主事件循环 1141ms**。两边改成共用 `pickBiliPython()`，
    并让 `/overview` 走 `blockOnMiss: false`（缓存空就报「探测中」，绝不同步等）。
    冷启动构建耗时 1141ms → 126ms。
  - `tailBridgeLog` 每次 `readFileSync` 整个桥日志（能到 8MB），而 `/overview`
    每 4 秒轮询一次。改成从文件尾按行回读：17MB 日志 94ms/次 → 0ms/次。
  - 折叠块（`<details>`）里的组件照常挂载，于是 `SetupWizard` 在用户没展开时
    也会打一次 `/env/probe`（实测 380ms，内含 `docker images` + 扫七个端口）。
    改成第一次展开前只渲染空壳。
- **取二维码不再每个请求都起 `docker cp`**：容器缓存目录本来就 bind mount 到宿主机，
  直接读那份是 1ms，而 `docker cp` 要起一个 docker 进程（76~103ms）。
  `docker cp` 保留为「挂载不符合预期」时的兜底。
- 设置页二维码区显示「这张是多久前拿到的 / 可能已过期，点一下换新码」——
  QQ 的登录码约 2 分钟过期，过期后扫码没反应，用户会误以为是插件坏了。

### Added

- **B站语料抓取：关键词改由模型根据 persona 自己决定，并带历史记录**
  （2026-11-01 用户需求）。原来关键词是手填在 `config.learning.crawlSources` 里，
  设置页连这一栏都没有，抓什么跟人设无关。

  **顺带修了一个让功能完全失效的 bug**：`runCrawl` 起子进程时没传
  `LLMINQQ_CONFIG`，脚本于是去读包里那份 `lib/bridge/config.json` ——
  那份连 `learning` 段都没有，所以 `crawlSources` 永远是 `[]`。
  实测 dry-run：修复前 `{"total":0}`，修复后 `{"total":15}`。
  这正是用户说的「keyword 是空的」。

  新行为：
  - 点抓取时，**模型看着 persona 挑 1-3 个关键词**（调宿主 `llm.stream`，
    不是起 `dsh headless` 子进程 —— 后者会再踩一遍「provider 隔离」的坑）。
  - 每次决定记进 `crawl-history.json`：选了哪些词、为什么、抓到多少。
  - **下次决定时把历史喂回给模型**（关键词 + 领域 + 结果）。不喂历史的话，
    模型每轮都挑「最典型」的那几个话题，语料永远是同一批词的重复采样 ——
    这是采样退化，不是「顺便存个日志」。
  - 抓到 0 条的历史会标「没抓到内容」，这也是让模型避开该方向的信号。
  - 模型不可用（没配路由 / 调用失败）→ **回退到配置里的 `crawlSources`**，
    不让抓取直接死掉。
  - 解析模型输出很宽容：去 ```json 围栏、抠第一个 `{` 到最后一个 `}`、
    支持 `["kw"]` 字符串数组写法、非法 domain 纠正成 `unknown`、最多取 3 个。
  - 设置页显示「模型挑了 …：reasoning」，并有可展开的历史记录。

- **`/env/probe` 加了 30 秒缓存**。它每次要跑六项探测（实测 251~294ms，
  `docker images` 一项就 151ms），而「还没连上 OneBot」时 SetupWizard 在每次
  打开设置页都会无条件调一次 —— 用户只是来看二维码，却先等 270ms。
  现在默认读缓存（实测 274ms → 1ms）；「测试连接 / 一键装完」传 `force=1` 真跑，
  并发的多个请求只跑一次探测。缓存**必须**能被 force 打穿，否则又是
  「按钮点了不生效」——和这次二维码刷新同一类错误，测试里锁了这条。
- **日志改成「贴底才跟随」**：停在最底部时新日志自动滚到底；往上翻看历史时
  新日志**不会**把你弹回底部，并显示「已暂停跟随 / 回到底部」。
  关键是判断时机——必须在内容更新**之前**记住当时是否贴底（用 scroll 事件
  维护 ref，`useLayoutEffect` 里读 ref 再滚）。等 DOM 更新完再判断的话，
  新行一追加 `scrollHeight` 就变大、容器立刻「不在底部」，于是永远不跟随、
  日志看起来像死的。阈值取 24px 而不是 0：高 DPI 下底部可能差零点几像素，
  严判 0 会「明明在底部却不跟随」。
- `scripts/sync-install.mjs` 过滤 `.git`：git worktree 里 `.git` 是**普通文件**，
  原来会被当普通文件拷进安装副本，报 EACCES 中断同步（真拷成功更糟，
  安装目录会变成指回源码仓库的 git 链接）。
- 回归测试：`test/unit-napcat.test.mjs` 新增 5 条（刷新必须真调接口 / 凭证要缓存 /
  token 取自 webui.json / 文件没变要如实报错 / 取码先走 bind mount），
  `test/unit-panel-perf.test.mjs` 新增 14 条（预热的 key、`blockOnMiss` 语义、
  日志尾读的正确性与速度、折叠块延迟挂载、`/env/probe` 的 force 打穿、
  桥日志行数单一真源、滚动跟随的判断时机）。
- **桥日志显示行数收成一个常量 `BRIDGE_LOG_LINES = 100`**。原来三处各写各的
  （overview 40 / status 60 / log 200）：前端「运行」页一进来显示 40 行、
  5 秒后轮询一次突然变成 200 行，用户会看到日志自己「长出来」；而且改行数
  要改三处，漏一处就不一致。现在统一「最后 100 行」，界面上标明范围，
  日志框高度 260px → 420px（100 行的可读性比 40 行需要的空间大）。
- ⚠️ **不兼容字段变更**：`GET /overview` 的 `env.qrCached`（布尔）换成
  `env.qr`（`{ cached, ageMs }`）。原因是要显示「这张码多久前拿到的」，
  一个布尔表达不了。插件自己的前端是唯一消费者，已同步；
  但**如果你有外部脚本在读 `qrCached`，需要改读 `env.qr.cached`**。
  这是本次唯一一处破坏性变更。
- **`digest.md` 现在会被自动生成**。用户导入 844 条记忆后发现摘要文件仍然不存在 ——
  根因和 ingest 一模一样：脚本版靠手工跑 `memctl digest`，插件化时只搬了
  reflect/learn，digest 从没进过任务表。
  后果是**静默**的：桥的 `memoryRecallBlock` 读 digest 走
  `if (!existsSync) return ''`，不报任何错。用户能看到「记忆 844 条」，
  但桥注入的「群级背景 / 程序记忆」那段永远为空，只有按人检索在工作。
  - 新增 `digest` 定时任务，30 分钟一轮（实测 14ms @ 844 条，纯本地 SQLite +
    一次文件写，不调 LLM 不走网络）。间隔取 30min 的理由：比 ingest（5min）慢，
    摘要不会比库里数据新太多；又比 reflect（8h）密得多，反思刚提炼出的
    语义记忆半小时内就能进摘要。
  - 新增 `runIfMissing` 机制：任务可声明「产物路径」，启动时若产物不存在就
    **立刻补跑一轮**，不等排程。这是调度器纪律 ②（重启不该立刻重跑一轮）
    的一个有依据的例外 —— 那条针对的是昂贵任务（reflect 2-6min / learn 10-20min），
    而 digest 是 14ms，且缺失时桥读到的就是空。
  - 补跑只作用于声明了 `runIfMissing` 的任务；ingest/reflect/learn 都不声明，
    保持原行为。

## [0.5.3] - 2026-10-31

> 说明：这一版开发时曾用 0.5.4~0.5.7 等本地打包号试过，都没对外发布，
> 最终统一收敛到 `0.5.3`（`cd007d9`）。下面的条目几乎全是**用户实测反馈出来的
> bug**，不是计划内的新功能 —— 所以按「坏在哪」而不是「加了什么」来排。

### Added

- **语音（TTS）从「只有一个开关」变成能真调音色**。之前插件版只把
  `features.voice` 这一个布尔传给桥，引擎名/地址/参考音频全部丢失，桥只能走
  默认的 GPT-SoVITS + `127.0.0.1:9880`。脚本版有 8 个字段，插件版只剩 1 个布尔。
  - `config.tts` 现在是完整配置段：`engine` / `maxChars` / `character`
    + `gsv` / `piper` / `sherpa` / `openai` / `minimax` 五套引擎参数。
  - 两个**在线**引擎（机器带不动本地 TTS 时只要一个 key 就能出声）：
    `openai`（OpenAI 兼容 `POST /audio/speech`，直接拿二进制）、
    `minimax`（T2A v2，URL 带 GroupId，返回 JSON + hex 音频，
    支持 29 种音色 + 情绪 + 语速 + 音调）。
  - 设置页新增「语音」卡片：引擎下拉 + 各引擎专属字段 + 「拉取模型」按钮
    （`POST /tts/openai-models` 从服务的 `/v1/models` 按 `tts`/`audio`/`speech`
    关键字过滤；OpenAI 的 /models 没有 type 字段，拉不到时回传全量 id 供手选）。
  - API key 走 `secrets.json`，不落明文进 `config.json`。
- **抓取清单支持「关键词」而不只认 BV 号**。需求是让模型自己挑话题 ——
  它只知道「想学哪个领域的说话方式」，不知道具体 BV 号，硬要它先查再填
  等于把搜索这步甩回给用户。`crawl-bili-comments.mjs` 的 `loadSources`
  现在接受三种写法：`{bvid,domain}` / `"BV1xx"` /
  `{keyword,domain}`（脚本自己调 `bili_search` 解析，搜不到就跳过，不硬编造）。
- **AGENTS.md 补上并随包发布**。远端仓库里根本没有这个文件，但
  `DEFAULT_PERSONA` 写着「可选项见 AGENTS.md」—— 指向一个不存在的文件。
  - 新增 `qq-agent/AGENTS.md`（脱敏版）：去掉真实 QQ 号和本机路径，
    换成 `<工作区>/`、`<插件数据目录>/`、示例号 `1000000001`；
    保留 12 条通道约束 + 4 条安全红线 + 39 种性格 + OCEAN 机制。
  - `ensureAgentScaffold` 启动时把包内那份复制到 agent 工作区，
    **只在不存在时写**，不覆盖用户改过的；包里没带时还有一份极简兜底。
  - `package.json` 的 `files` 加 `qq-agent/AGENTS.md`
    （只带这一个文件，不带那 1.9M 图片）。

### Fixed

- **设置页「行为」Tab 白屏**。`BehaviorTab` 用了 `secrets` 但组件没接 `data`
  → render 时 `ReferenceError` → React 卸掉整棵子树 → 用户看到整页空白。
  现在 `data` 传进去，`secrets` 用 `data?.secrets || {}` 兜底。
- **折叠块「DOM 在、但看不见」**。现象是「B站工具（MCP）」下面一块 41px 空白：
  查 DOM 元素存在、文字在、颜色也正常，就是看不见。根因是宿主的全局内联样式
  有一条 `.collapse { visibility: collapse }`，而插件 `Collapse` 组件裸用了
  `className: 'collapse'`（`visibility:collapse` 对非 table 元素等价于 `hidden`，
  元素还占位但整块不可见）。
  修法：类名改 `qq-collapse`（`collapse` 这词太常见，迟早还会撞）
  + `visibility: visible !important` 双保险。**只加 `!important` 不算修好**——
  那是靠兜底，宿主改规则或换个主题插件再插一条就又会命中。
  注意这是 **web 侧独有的坑**：Windows desktop 的 v0.5.2 上完全正常，
  因为 desktop 没加载那条全局规则，只看代码看不出来。
- **B站语料抓取：点一下 0 秒完成、还扣了次数**。用户点「现在抓 2 个视频」，
  提示「用时 0 秒，学到 若干 个词汇」，但语料目录里一个文件都没有。
  三个问题叠加：
  1. `learning.crawlSources` **没有默认值** → 清单永远是空的，脚本直接 return 0；
  2. `memory-admin.mjs` 只要脚本退出码 0 就 `bumpCrawlUsage`，哪怕 `fetched=0`；
  3. 前端用 `?? '若干'` 兜底，把「什么都没抓到」显示成「学到 若干 个」，等于骗用户。
  修法：`store.js` 补 3 个开箱即用的关键词条目；`index.js` 把
  `crawlSources`/`commentsPerVideo` 透传进 bridge-config（之前压根没传，
  脚本永远读不到）；只有 `fetched > 0` 才计次，空跑返回 `note` 说明原因；
  前端不再用「若干」兜底。
- **`messaging.js` 缺 3 个 import**（`fs`/`path`/`crypto`）：`synthesizeToFile`
  一调就 `ReferenceError: path is not defined`。这是**原有 bug**，
  一直没人走通那条路径所以没暴露。
- **`bili_search` 返回字段认错**：实际是 `videos`，之前只认
  `results`/`data`/`items`，导致关键词搜索一直「搜不到」。
- **`--json` + dryRun 不输出结构化结果**：dryRun 分支只 `log()`（而 `--json`
  模式下 log 是静默的）→ 调用方 `JSON.parse('')` 得到 null。

### Changed

- `DEFAULT_PERSONA` 的性格从写死「搞怪」改成留空待填，并说明可以自己改。

## [0.5.2] - 2026-10-30

0.5.1 之后把「已知但没做」的那批尾巴清掉了：传输层可靠性、工具调用权限可见性、
结构拆分、以及一个能自动回答「消息到底回不回」的自检脚本。没有不兼容变更
（限流默认值从 800ms 调到 1500ms，属于默认行为变化，0 仍是「关闭」）。

### Added

- **`scripts/verify.mjs`：装完之后的三件事自检**。`node scripts/verify.mjs` 只读体检
  （桥在不在 / OneBot 在不在线 / 最近一次收发是什么时候、有多旧），
  `--kill-bridge` 额外杀一次桥验证宿主的自动重启，`--json` 给 CI 用。
  每一项 FAIL 都带一行「下一步查什么」。
- **工具调用权限可配**：`config.security.toolPolicy`（`auto` / `allowlist` / `deny`）。
  `auto` 是旧行为但**第一次自动批准时会打一条 WARN**，让人知道「QQ 里的人可以让模型跑本机工具」；
  `allowlist` 只放行 `allowed` 里列出的工具名片段，`deny` 一律拒绝。
- **Token 不再回显**：`/overview` 与 `GET /config` 返回的 `onebot.token` / `server.token`
  变成掩码；`POST /config` 收到掩码值会当成「不修改」，不会把真凭据覆盖成星号。
- **发送失败不再静默丢后半段**：桥的本地 API 有 1MB body 上限（超限 413），
  `/send`、`/recall` 与入站消息走同一套 allowUsers/allowGroups 白名单。

### Fixed

- **OneBot 传输层**：`meta_event` 提前 `return` 让 `lifecycle` 分支成了死代码（现在可达）；
  重连收敛到单一 `_openSocket()` 入口，旧 socket 的 close/message 会被忽略，不再叠加两条连接；
  入站按 `message_id` 做 200 条环形去重。
- **未连接时发送直接 reject**：`call()` 现在入队（上限 200、15s 超时），连上后按序 flush。
- **`dsh.js` 的 prompt 超时**：30s 超时改 `Promise.race` 并清理全部 waiter，外层不再永挂。
- **卡片展开的 SSRF**：`carddetail.js` 每跳先过 `checkUrlSafe`、`redirect: 'manual'` 最多跟 2 跳；
  桥里把带用户配置的守卫注入进去（之前它只能用保守默认实例）。
- **`bili-python` 硬编码 `D:/dsh-home`**：改为从 `LLMINQQ_DATA_DIR` / `DSH_HOME` / `dataDir()` 推导，
  旧路径仅在真实存在时兜底。
- **`scheduler` 卡 running 后再也不跑**：`try/catch/finally` 保证复位，`status()` 暴露
  `lastError` / `lastDurationMs` / `skippedCount`；忙时跳过会记账而不是静默丢。
- **`cooldownMsPerPeer` 默认 0 = 无限流**：默认改为 **1500ms**（0 仍表示关闭），
  非负、上限 60s、非法值回落默认；`lib/store.js`、`lib/index.js`、`client.js` 三处默认值已对齐。

### Changed

- **`handleInbound` 拆分**：出站那一段（约 120 行）抽成 `deliverReply()`，
  `chatFollowSpeak` / `proactiveSpeak` / `handlePoke` 三份重复的出站流水线合并成 `dispatchOutbound()`
  —— 原来改一处发送逻辑要同步改三个地方，漏一个就是「某个入口不发消息」。
- **能力探测彻底离开同步路径**：`probePython` 增加异步版 `probePythonAsync()`（进程内 inflight 合并 +
  5 分钟缓存），启动预热改为异步填缓存，设置页轮询不再触发 `spawnSync`。

### Tests

- 177 个用例全绿（新增 onebot / dsh / carddetail / bili-python / scheduler / config / napcat 等单测）。

## [0.5.1] - 2026-10-30

一次以「静默失效 / 崩溃 / 数据丢失 / 越权面」为主的修复发布，顺便把设置页轮询对
DSH 宿主的阻塞干掉了。没有不兼容变更（`config.security.toolPolicy` 默认仍是 `auto`）。

### Fixed

- **接话链路 100% 哑火**：`lib/bridge/index.js` 的 chatFollow 时间窗判断把 `d.age` 写成了
  `age`，每轮抛 `ReferenceError` 被 `.catch` 吞成一行日志 —— 表现是「配了接话但从不接」。
- **桥崩了就不再来**：宿主 `exit` 回调无条件清空 `bridgeChild`、`stopBridge` 里
  `if (!child.killed)` 是死代码。现在退出不会误杀新进程，崩溃后按 1/2/4/8/16s 退避自动重启
  （60s 稳定后重置计数，连续 5 次失败停止并标 `gaveUp`）。
- **状态落盘失败直接杀进程**：`saveState()` 的 `writeFileSync` 原来裸跑（Windows 杀软/索引器
  占用会抛 `EPERM`/`EBUSY`）；现在失败只记日志并 1s 后重试。补上日志流 `'error'` 监听与
  `unhandledRejection` / `uncaughtException` 兜底。
- **人格可能被空内容覆盖**：读人设失败时后端仍返回 `ok: true, text: ''`，设置页把空串当成功，
  用户一保存就写没了原人格。现在读失败返回 500 并禁用保存，保存前备份到 `persona.md.bak`。
- **首次装机点「一键拉镜像」后按钮永久转圈**：失败路径不执行 `setStep('')`，而按钮
  `disabled: !!step`。改成 `try/finally` 保证复位并给出可重试提示。
- **长消息把功能标记切断**：`chunkText` 按字符数硬切，会把 `[AT:123456]`、`[SEND_FILE:...]`
  切一半发到 QQ。现在切点避开未闭合的 `[...]`。
- **`allowPrivateUrls` 连协议白名单一起放开**：开启后 `file://`、`ftp://` 也能过
  `checkUrlSafe`。现在它只放开内网地址。
- **设置页白屏**：provider 列表出现 `null` 时 `describeProviders` 抛 TypeError；渲染期若干
  对 `probe.*` / `stats.*` 的裸解引用。已加过滤与可选链。

### Security

- 桥 HTTP API：**鉴权前移到所有路由之前**。原来 `/qr`、`/qr.png` 免鉴权，而二维码带着
  登录用的 `uin` + `token`。token 比较改为 sha256 + `crypto.timingSafeEqual`。
- 入站请求体加上限（默认 1 MiB，`config.server.bodyLimitBytes` 可调，超限 413）；
  畸形 URL 返回 400 而不是变成 `unhandledRejection`。
- `/send`、`/recall` 与入站消息走同一套 `allowUsers` / `allowGroups` 白名单（403）；
  `/send` 的附件路径过 `isPathAllowedForSend`。
- 宿主 30+ 个无鉴权写接口（`/config`、`/secrets`、`/memory/clear` …）加跨站守卫：
  `Origin` 与 `Host` 不同源一律拒绝（`Origin: null` 只放行 GET/HEAD）。
- ACP 工具授权：`session/request_permission` 原来无条件选第一个 allow 选项，等于群成员
  一句话就能让模型在本机执行工具。现支持 `config.security.toolPolicy`：
  `auto`（默认，保持旧行为并在首次调用时提示）/ `allowlist` / `deny`。
  默认保持 `auto` 是刻意的——直接全量 deny 会让现有用户的所有工具立刻报错。

### Changed

- **能力探测不再钉住 DSH 宿主**：`probeFfmpeg` / `biliDepsInstalled` / `setupBiliVenv` /
  `buildMcpServers` 里的同步子进程调用改成异步（`execFile` + `promisify`），加 5 分钟缓存与
  同 key in-flight 合并。此前设置页每 4 秒轮询 `/overview` 都要同步跑 `ffmpeg -version`、
  `python -c "import mcp, bilibili_api"`（超时 20s）与三个候选解释器探测。
- 启动时预热探测缓存：`setImmediate` 里先用**异步**探测填缓存再跑一次能力判断，
  用户打开设置页时基本只剩读缓存（如果直接调同步探测，等于把「首次打开设置页卡一下」
  换成「DSH 启动卡一下」）。
- `dockerAvailable()` / `loginStatus()` 加 in-flight 合并，4 秒轮询不再叠成无界并发。
- 设置页 `api()` 加 30s 超时与超时文案；`/overview` 轮询加 in-flight 守卫。
- 桥日志 `bridge.out` 超过 8 MiB 自动轮转（原来只增不减，而「运行」页是全量读文件）。
- 坏掉的 `config.json` 在回落默认值前备份成 `config.json.corrupt-<时间戳>`，避免下次保存把
  原文件抹掉；原子写临时名加 pid + 时间戳 + 随机串。
- `MEMORY_PATHS` 的 python 默认值在 Windows 上取 `python`（无 `python3.exe` 会让跨通道
  记忆静默为 0 条）。
- 文档：README 重写，新增 `LICENSE`（MIT）与 `CHANGELOG.md`，修掉 `INSTALL-PLUGIN.md`
  里写死的作者本机路径与不存在的 `diagnose.mjs`；`package.json` 补 `repository` / `bugs` /
  `homepage` / `keywords` 与 `scripts.test`。

### Tests

- 测试不再依赖作者机器：动态 import 走 `pathToFileURL`（Windows 上原来直接
  `ERR_UNSUPPORTED_ESM_URL_SCHEME`）、记忆库用合成 fixture、python/ffmpeg 跨平台探测、
  源码锚点匹配兼容 CRLF。
- 新增纯函数单测：`chunkText` / `textToSegments`、`checkUrlSafe`、配置合并与坏 JSON 回退、
  `validateRoutes`、docker 探测 in-flight 合并。`npm test` 即可跑（136 项）。

## [0.5.0] - 2026-10-29

首个公开发布版本：从「一套脚本 + 几份配置」整理成标准 DSH 插件。

### Added

- 标准 DSH 插件形态：`package.json` 声明 `dsh.bundle.patch`（`cordis.patch.yml`）
  与 `dsh.client`（web 设置页），装进 profile 后作为 profile layer 加载。
- 设置页「QQ 通道」，共 7 个分页：登录 / 模型 / 行为 / 记忆 / 人格 / 运行 / 高级。
- NapCat 容器托管（`managed: true`）：探测 Docker 与 compose v2，生成 `<数据目录>/compose.yaml`，
  起停容器、把登录二维码回传到设置页。
- OneBot 11 反向 WS 桥（`lib/bridge/`）：独立子进程，崩溃不影响 DSH 宿主；
  宿主通过 HTTP（默认 `127.0.0.1:18080`，Bearer token）发消息。
- 模型接入：provider / model / 推理强度可选，支持 `acp` 与 DSH SDK 两种会话协议，
  以及带连续失败阈值、冷却时间的降级链。
- 人格：`<数据目录>/agent/persona/persona.md`，设置页可直接编辑，桥每轮重读。
- 记忆：情节/语义记忆（SQLite）、`digest.md` 摘要、风格库、说话方式学习；
  `ingest` / `reflect` / `learn` 三个定时任务（分别约 5 分钟 / 8 小时 / 12 小时）。
- 记忆页：条数统计、按人分布、最近记忆、导出 zip、导入（导入前自动备份）、
  清除（软删除，归档为 `retired=1`，并留 `mem.db.bak-*` 备份）、B 站语料抓取。
- agent 工具：`qq_status`（容器 / 登录 / 桥 / 模型路由状态）、`qq_send`（按群或私聊发消息）。
- 人设化的状态系统：精力、情绪、按发言人计的好感度，以及主动发言概率。
- 第三方组件：`vendor/bilibili-mcp`、`vendor/dsh-video-storyboard`（见 `THIRD-PARTY-NOTICES.md`）。

### Changed

- 记忆数据并入插件数据目录：默认位置改为 `<数据目录>/agent/memory/`，
  旧位置 `<数据目录>/memory/` 与 `~/.dsh/llminqq/` 会在加载时自动**复制**迁移（幂等，不删旧数据）。
  可用配置项 `memory.stateDir` 覆盖。
- B 站 MCP 依赖安装入口常驻在设置页「行为」分页，不再随开关显隐。
- 设置页「记忆」分页的空态补充了两条排查线索（消息没进来 / 调度器没跑）和库文件路径。

### Fixed

- 修复记忆一直 0 条：`memctl ingest` 任务此前从未被调度器注册（`lib/scheduler.mjs`）。
- 修复记忆数据散落在多个位置：统一到 `agent/memory`，并补上旧目录的自动迁移。
- 修复白名单文案：明确要求填**对方的** QQ 号 —— 这是「消息进来但机器人不回」的头号原因。
- 清理文档中的作者本机绝对路径与不存在的诊断脚本（本文件即该次整理的一部分）。

### Security

- `secrets.json` 以 `0600` 保存，设置页**只写不读**（QQ 号 / WebUI token / 服务端 token）。
- 桥自带的 HTTP 服务默认只监听 `127.0.0.1:18080`，且要求 `Authorization: Bearer <token>`。
- 图片暂存有 10 MB 上限，并过滤敏感文件名（`.ssh` / `.env` / `credentials` / `id_rsa` 等）。
