# dsh-plugin-llminqq

让 LLM 接管一个**真实 QQ 号**的 [DSH](https://github.com/deepseek-ai) 插件：
NapCat 负责登录 QQ 和收发消息，插件把消息交给配置好的模型，再用这个号回过去。
它不是关键词应答机器人 —— 有持久人格、跨天记忆、按人累积的好感度，
以及精力/情绪这类会随聊天变化的状态。

> 风险提醒：用非官方客户端接真实 QQ 号存在被风控、封号的可能。
> **建议用小号**，先不接重要群；本项目不承诺账号安全。

## 它是什么

装进 DSH 的插件包，装好后设置里多出「QQ 通道」，7 个分页：
**登录**（起停 NapCat、页面内扫码）、**模型**（provider / 推理强度 / 降级链）、
**行为**（白名单、群里是否 @、字数、冷却、免打扰、能力开关）、
**记忆**（看它记住什么、按人分布、导出导入、清理）、**人格**（编辑 `persona.md`，改完即生效）、
**运行**（桥进程起停与实时日志）、**高级**（总开关、数据目录、原始 JSON、恢复默认）。

同时注册两个 agent 工具，DSH 里的 agent 可以直接调用：

| 工具 | 作用 |
|---|---|
| `qq_status` | 查容器、QQ 登录、桥进程、模型路由的当前状态 |
| `qq_send` | 以这个 QQ 号的名义发消息（`scope=group\|c2c`、`peerId`、`text`） |

## 和普通 QQ 机器人有什么不同

| | 普通规则/插件式机器人 | 这个插件 |
|---|---|---|
| 回复怎么来 | 关键词匹配、固定模板、写好的指令 | 把人格 + 记忆 + 最近上下文交给模型生成 |
| 跨天连续吗 | 通常不记得昨天 | 记忆库（SQLite）+ 摘要，按人检索 |
| 有「状态」吗 | 没有 | 精力、情绪、对每个人的好感度，会影响回复长短和语气 |
| 会学说话方式吗 | 不会 | 可选：从聊天和语料里学词汇/句式（风格库、`lexicon.json`） |
| 主动说话吗 | 一般不会 | 可选：按概率和冷却主动发言（默认关） |
| 群里怎么触发 | 命令前缀 | 默认必须 @ 它；私聊直接聊 |

它不是「更像人的保证」，只是把上下文、关系、状态这些变量交给模型；
回复质量最终取决于你接的模型和人格文件写得好不好。

## 环境要求

- **DSH**：插件跑在 DSH 里，不是独立程序；设置页需要 Web profile（`dsh --profile web`）。
  桌面版能否显示设置页见 [DESKTOP.md](DESKTOP.md)。
- **Node.js ≥ 22.19.0**：`package.json` 的 `engines` 要求，用 DSH 自带运行时即可。
- **Docker + Compose v2**（可选）：让插件托管 NapCat 容器时用；已有本机版 NapCat
  就把 `napcat.managed` 设为 `false`，直接连它的 OneBot WS。
- **Python 3**（可选）：记忆功能需要；检测不到时记忆页显示不可用，收发消息不受影响。
- 一个 QQ 号（建议小号）+ 能在 DSH 里正常调用的模型 provider。

## 安装

1. 拿到仓库目录（`git clone` 或解压 zip），记住**绝对路径**；下面用 `<插件目录>` 代指，
   Windows 例：`C:\Users\你\code\dsh-plugin-llminqq`，macOS/Linux 例：`/home/you/code/dsh-plugin-llminqq`。

2. 装进 DSH 的 web profile：

   ```powershell
   # PowerShell
   dsh plugin --profile web add file:C:/Users/你/code/dsh-plugin-llminqq
   ```

   ```bash
   # Git Bash / macOS / Linux
   dsh plugin --profile web add file:/home/you/code/dsh-plugin-llminqq
   ```

   `file:` 后面必须是**目录本身**（含 `package.json` 的那层），不是 `packages/xxx` 子路径。

3. 确认它会作为 profile layer 加载：

   ```bash
   dsh --profile web --dump-config
   ```

   输出里应能找到 `dsh-plugin-llminqq`。`dsh plugin add` 只保证包装进 `node_modules`，
   不保证名字进了 `dsh.profile.bundles`；没进 bundles 就不会加载。手动修法见
   [INSTALL-PLUGIN.md](INSTALL-PLUGIN.md)。

4. 重启 `dsh --profile web`，刷新浏览器，打开 **设置 → QQ 通道**。启动日志应出现：

   ```
   [llminqq] v0.5.2 已加载 · 代码在 <插件目录> · 数据目录 <数据目录>
   [llminqq] 设置页 API 已挂载
   ```

## 装完先点哪

按这个顺序走，能最快判断链路通不通：

1. **登录页 → 启动 QQ 容器**。首次要拉 2 GB 以上镜像。二维码显示在页面里，用**小号**扫；
   状态变成「已登录」再往下。
2. **模型页**：选 provider 和模型（下拉里只有当前 profile 真正注册了的 provider）、推理强度。
3. **行为页**：先看白名单 —— **填的是对方的 QQ 号**，不是自己的。群聊默认要求 @ 它。
4. **人格页**：`persona.md` 决定它是谁、什么风格；默认骨架能用，建议改成你要的人设。
5. **运行页 → 启动桥**。桥起来后日志会出现 `入站 ...` 行，说明消息真的进来了。
6. **验证**：用另一个号给它发条私聊看有没有回；也可以让 agent 调 `qq_status`，一眼看到容器/登录/桥/模型四段状态。
7. **自检**（可选，但出问题先跑它）：

   ```bash
   node scripts/verify.mjs              # 只读体检：桥在不在 / OneBot 在不在线 / 最近一次收发有多旧
   node scripts/verify.mjs --kill-bridge # 额外验证「桥被杀后宿主会不会自己拉起来」
   node scripts/verify.mjs --json       # 机器可读，贴 issue 时用
   ```

   每项 FAIL 都带一行「下一步查什么」；`skip` 是当前没有条件测（比如桥没跑，就没法测连续收发），不算问题。

## 数据放在哪

默认数据目录 `~/.dsh/dsh-plugin-llminqq/`（设了 `DSH_HOME` 时是
`$DSH_HOME/dsh-plugin-llminqq/`；从 profile 的 `node_modules` 加载时，插件会优先从
安装路径反推 DSH home）。实际路径看设置页「高级」或启动日志那行「数据目录」。

| 路径 | 内容 | 说明 |
|---|---|---|
| `config.json` | 设置页保存的所有配置 | 可分享，不含凭据 |
| `secrets.json` | QQ 号、WebUI token、服务端 token | `0600`；设置页只写不读 |
| `bridge-config.json` | 给桥子进程的完整配置（含 token） | 自动生成，`0600`，不要手改 |
| `logs/bridge.out`、`logs/bridge.log` | 桥的输出与自己的日志 | 设置页「运行」页读 `bridge.out` 末尾 |
| `agent/persona/persona.md` | 人格文件 | 每轮重读，改完不用重启 |
| `agent/memory/` | 记忆与语料：`mem.db`、`digest.md`、风格样本、`lexicon.json`、`corpus/`、`log/`、`scheduler.json` | 默认记忆位置，可用 `memory.stateDir` 改 |
| `state/` | 桥运行态（会话映射等） | 删了会丢会话续接 |
| `.qq-media/`、`qr.png`、`compose.yaml`、`napcat/` | 图片暂存、二维码、容器编排与数据卷 | 删 `napcat/` 要重新扫码 |

**记忆位置**：默认 `<数据目录>/agent/memory/`。旧版本放在 `<数据目录>/memory/` 或
`~/.dsh/llminqq/`，插件加载时会自动**复制**迁移（不删旧目录、可重复执行）。
换盘改 `config.json` 的 `memory.stateDir`。
**备份**：记忆页「导出」把记忆库和语料打包成 zip；写入正忙时直接打包可能拿到不一致的库，要绝对稳就先停桥再导出（整目录拷贝同理）。备份含聊天内容，别随手发人。

## 架构

```
DSH 宿主进程
  lib/index.js ── 设置页 HTTP API /dsh-plugin-llminqq/api
               ├─ agent 工具 qq_status / qq_send
               ├─ 记忆调度器（ingest / reflect / learn）
               └─ 拉起并监控桥子进程
        │  本机 HTTP 127.0.0.1:18080（Bearer token）
        ▼
  lib/bridge/index.js（独立 node 子进程）
  ├─ 连 NapCat 的 OneBot 11 反向 WS :3001
  ├─ 白名单 / 冷却 / @ 规则、媒体下载
  ├─ 状态系统、人格、记忆读写
  └─ spawn dsh --profile <p> 跑模型会话
        │
      NapCat ── 真实 QQ 号
```

桥单独一个进程：它要长连接常驻，崩了不能把整个 DSH 带下去；生命周期跟 QQ 登录绑定，
跟「DSH 开没开」不是一回事；改桥配置只需重启桥。代价是**桥只在启动时读一次
`bridge-config.json`** —— 所以改完设置要重启桥：设置页保存后在桥运行时自动重启它，
桥当时没在跑就去「运行」页手动启动。会话协议默认 `acp`，也可切 DSH SDK 的
JSON-RPC（`protocol=dsh`）。

## 故障排查

三个统一入口：设置页**「运行」页日志**（`logs/bridge.out` 末尾 40 行）、
**数据目录下的 `logs/`**（完整历史）、**宿主日志里 `grep llminqq`**。
想看原始状态可直接访问 `http://127.0.0.1:<DSH 端口>/dsh-plugin-llminqq/api/overview`。

### 看不到「QQ 通道」

1. `dsh --profile web --dump-config` 里有没有 `dsh-plugin-llminqq`；
2. profile 的 `package.json` 里 `dsh.profile.bundles` 有没有它（有依赖不等于会加载）；
3. 宿主启动日志有没有 `[llminqq] v0.5.2 已加载 ...`；
4. 若只有 `[llminqq] webServer 不可用，设置页不挂载`，说明这个宿主没提供 web 设置能力
   （纯 CLI/桌面场景）—— 插件加载成功了、桥也能用，去 Web 端配置即可，配置和记忆共用同一份数据。

### 二维码不出来 / 扫了没反应

- 登录页「环境探测」会区分：没装 Docker、只有 docker 没 compose v2、daemon 没启动；
- `docker logs llminqq-napcat` 看容器真实输出；
- 默认 WebUI 6099、OneBot 3001，被占就在登录页改；
- 显示已登录但「运行」页桥连不上 → 桥还没启动，或 OneBot WS 不是 `ws://127.0.0.1:3001`
  （本机版 NapCat 按它实际配置改）。

### 消息进来了，但机器人不回

按可能性排：① **白名单填错**（要填**对方的** QQ 号）；② 群聊没 @（`requireAtInGroup` 默认开）；
③ 桥没跑或模型不可用（运行页看有没有 `入站` 行，`qq_status` 看模型路由）；
④ 降级链里全是没注册的 provider（看 `bridge.log` 报错原文）；
⑤ 冷却/免打扰静默不回；⑥ 总开关 `enabled` 没开，桥不会自动启动。

### 有回复，但记忆一直是 0 条

记忆页空态已给线索，原理是：① **消息根本没进来**：`logs/bridge.out` 里没有 `入站 ...` 行，
先修上一条；② **调度器没跑**：它只在插件总开关打开且 Python 可用时工作，看记忆页状态或读
`<数据目录>/agent/memory/scheduler.json` 的 `lastRunAt` / `lastSkippedAt` 与原因；
③ 库文件是 `<数据目录>/agent/memory/mem.db`，用 SQLite 客户端看 `entries` 表即可确认。
注意 `.prod-guard` 会让 `memctl` 拒绝写生产库，除非显式设 `MEMCTL_PROD=1`（正常调度会自动处理）。

### 桥起不来 / 反复退出

运行页日志末尾就是原因（端口占用、配置 JSON 坏、token 不匹配、连不上 NapCat）。
18080 被占就在高级里改 `server.port`；token 存在 `secrets.json`（0600），改过之后重启桥；
配置写坏了用高级 → 恢复默认（**不清凭据**），或手改 `config.json`；再确认 NapCat 的
OneBot 服务开着且地址/端口与登录页一致。

### provider 列表是空的 / 模型调不通

插件枚举的是**当前 profile 里真正注册了 adapter 的 provider**（`llm.listProviders()`）。
列表空说明这个 profile 没装对应 provider 插件，不是插件坏了；见 [DESKTOP.md](DESKTOP.md)。

### 改了配置没生效 / 加载的到底是哪份代码

桥相关（白名单、人格、模型、端口）保存后桥会重启，桥没在跑就手动启动；涉及宿主生命周期
（启用/禁用、装新 provider）建议重启 DSH；人格文件每轮重读，不用重启。
安装后 profile 的 `node_modules` 里是副本，改工作区不会自动生效 —— 宿主日志那行「代码在 …」
就是实际加载路径；`where-is-loaded.ps1`、`find-all-copies.ps1` 查重复副本，
`scripts/sync-install.mjs` 把工作区同步到安装副本（带语法检查与 md5 复核）。

## 隐私与安全边界

- **聊天内容会离开本机**：消息文本（及下载后的图片）作为 prompt 发给「模型」页配置的
  provider，默认 `deepseek-account` 走 DSH 已登录账号的凭据；prompt 还含人格、相关记忆和
  最近对话 —— 不要把这个号接进你不想让 provider 看到的群或私聊。
- **落盘未加密**：聊天原文、记忆库、风格样本、B 站语料都在数据目录里；`logs/bridge.out`
  会追加记收发消息片段。整盘备份、同步盘、共享电脑都会把这些带出去。
- **凭据**：`secrets.json` 与 `bridge-config.json` 均为 `0600`，设置页只写不读，但都是明文 ——
  能读文件的人就能拿到 token。
- **网络暴露面**：插件桥 HTTP 默认只听 `127.0.0.1:18080` 且要 Bearer token；插件生成的
  compose 把 OneBot 3001 只绑到 `127.0.0.1`，但 **NapCat WebUI（默认 6099）会映射到宿主机
  所有网卡**，靠 `WEBUI_TOKEN` 保护 —— 不想让局域网访问就用防火墙封掉 6099。自己改端口映射
  或加端口转发等于扩大暴露面，请自行加鉴权。
- **图片**：10 MB 上限并过滤敏感文件名，只是尽力而为，不是安全边界。
- **备份**：记忆页导出的 zip 含完整聊天记录，别当普通文件传。
- 不保证回复质量、不保证不重复、不保证账号不被风控；模型侧如何使用你的输入取决于 provider 政策。

## 开发

- 入口：`lib/index.js`（宿主）、`lib/bridge/index.js`（桥）、`lib/agent/`（记忆与 B 站工具）、
  `client.js`（设置页 UI）。
- `scripts/check-package.mjs` 检查 `package.json` 的 `files` / `exports` / `dsh` 声明是否自洽；
  `scripts/sync-install.mjs` 同步到安装副本（`--dry-run` 先看差异，`node --check` + md5 复核）；
  `scripts/vendor-check.mjs` / `vendor-update.mjs` 维护 `vendor/` 里的第三方组件 ——
  `vendor/` 不要手改，来源与许可证见 `THIRD-PARTY-NOTICES.md`。
- 测试在 `test/`，用 Node 内置 runner：`npm test`（等价于 `node --test test/*.test.mjs`；
  **不要**用目录形式 `node --test test/`，在 Windows 上会漏掉文件）。
  测试设计成「任意机器都能跑」：不依赖作者的本机路径，缺 Docker / Python / ffmpeg 时按跳过处理。

## 卸载与清理

```bash
dsh plugin --profile web remove dsh-plugin-llminqq
```

移除插件**不会删数据**；想只重装插件就什么都别删。彻底清理则删数据目录
（PowerShell：`Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\dsh-plugin-llminqq"`）：

```bash
rm -rf ~/.dsh/dsh-plugin-llminqq
```

这会同时清掉登录态（要重新扫码）和记忆（不可恢复，删前先去记忆页导出备份）。

## License

MIT，见 [LICENSE](LICENSE)。第三方组件与各自许可证见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
安装细节与 Windows/桌面版注意事项见 [INSTALL-PLUGIN.md](INSTALL-PLUGIN.md) 和 [DESKTOP.md](DESKTOP.md)。
