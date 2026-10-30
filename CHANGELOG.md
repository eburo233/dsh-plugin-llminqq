# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> 说明：本仓库的公开历史从 `0.5.0` 开始。更早的迭代是作者自用阶段的脚本形态，
> 没有以版本号发布过，因此下面没有 `0.4.x` 之类的条目，也不会编造。

## [Unreleased]

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
