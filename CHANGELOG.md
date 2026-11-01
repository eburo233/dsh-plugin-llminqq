# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> 说明：本仓库的公开历史从 `0.5.0` 开始。更早的迭代是作者自用阶段的脚本形态，
> 没有以版本号发布过，因此下面没有 `0.4.x` 之类的条目，也不会编造。

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
