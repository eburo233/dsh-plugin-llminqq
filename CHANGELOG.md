# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> 说明：本仓库的公开历史从 `0.5.0` 开始。更早的迭代是作者自用阶段的脚本形态，
> 没有以版本号发布过，因此下面没有 `0.4.x` 之类的条目，也不会编造。

## [Unreleased]

### Fixed

- **「重新获取二维码」以前根本没换码**。`POST /qr/refresh` 走的是 `fetchQrCode()`，
  而它只是 `docker cp` 容器里那张 `qrcode.png` —— 全程没调 NapCat 的刷新接口。
  于是接口诚实地回了 `ok: true`（cp 成功），但图片字节级和上一张一模一样，
  用户看到的就是「点了没反应」。现在真的调 `POST /api/QQLogin/RefreshQRcode`，
  并等文件落盘后比对 md5 才算成功；换不动就如实回 `changed: false` + 原因。
  顺带修了 WebUI 凭证要缓存（NapCat 的 `loginRate` 默认 3，每次刷新都重登会撞限流）。
- **WebUI token 会和容器里实际那张分叉**。实测 `secrets.json` 是 `c26704…`，
  而容器 `webui.json` 是 `c5a4838a…`；用前者调 `/api/auth/login` 返回
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

- `scripts/sync-install.mjs` 过滤 `.git`：git worktree 里 `.git` 是**普通文件**，
  原来会被当普通文件拷进安装副本，报 EACCES 中断同步（真拷成功更糟，
  安装目录会变成指回源码仓库的 git 链接）。
- 回归测试：`test/unit-napcat.test.mjs` 新增 5 条（刷新必须真调接口 / 凭证要缓存 /
  token 取自 webui.json / 文件没变要如实报错 / 取码先走 bind mount），
  `test/unit-panel-perf.test.mjs` 新增 8 条（预热的 key、`blockOnMiss` 语义、
  日志尾读的正确性与速度、折叠块延迟挂载）。

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
