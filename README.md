# LLMinQQ —— 让 LLM(DSH) 接管一个真实 QQ 号
> **📌 重要文档索引**
> - [`RESTART.md`](RESTART.md) —— **重跑手册**：停机后怎么恢复、改配置改哪里、故障速查
> - [`RISK-ANALYSIS.md`](RISK-ANALYSIS.md) —— **风控对照分析**：腾讯风控条件 vs 我们的实际行为
> - 当前状态：**已停机**（NapCat/bridge/watchdog 全停），登录态保留。原因见第 15 节。


本目录是一个**独立**的小项目：把「真实 QQ 号」接到「DeepSeek Harness 的 LLM 会话」上，
从而让模型能看到**真实 QQ 号 / 昵称 / 群名片**、能**随时主动发消息**、能**原生收发图片**。

跑通后的形态：

```
QQ 手机/电脑客户端
      │  真实 QQ 协议（不是腾讯官方 Bot 平台）
      ▼
NapCatQQ（Docker，无头）  ← 控制真实 QQ 号，提供 OneBot 11 接口
      │  OneBot 11 正向 WebSocket (127.0.0.1:3001)
      ▼
bridge/index.js           ← 本项目的桥：事件→LLM 提示词，回复→QQ 消息/图片
      │  DSH SDK JSON-RPC over stdio
      ▼
dsh --profile llminqq-sdk ← 真实 LLM agent（可调 bash/读写文件/skill/子 agent）
      │  trae / deepseek-v4.1-flash
      ▼
DeepSeek 模型
```

> **与既有 `@wenbin_wb/dsh-bridge` 的关系**：完全无关、互不影响。
> 那条路走腾讯官方 Bot API，只能拿到 32 位 hex openid，且图片受「5 分钟被动回复」限制。
> 本项目走 OneBot 协议端，是另一条完全独立的路，两者可以并存。

---

## 1. 目录结构

| 路径 | 作用 |
|---|---|
| `qqacct/compose.yaml` | NapCat 的 Docker Compose（6099 WebUI / 3001 OneBot WS，均只绑 127.0.0.1） |
| `qqacct/data/` | 登录态与 NapCat 配置（`data/qq` 是 QQ 登录态，删了要重新扫码） |
| `bridge/index.js` | 主桥：OneBot 事件 → DSH prompt → QQ 回复/发图 |
| `bridge/onebot.js` | OneBot 11 WebSocket 客户端（自带重连、心跳、action 调用） |
| `bridge/dsh.js` | DSH SDK JSON-RPC 客户端（spawn `dsh --profile`，持久会话，turn 收尾） |
| `bridge/config.json` | 全部可调参数（连接、模型、策略、媒体、本地 API） |
| `test/mock-onebot.mjs` | 假 OneBot 服务端，**不登录 QQ 也能跑通整条链路** |
| `test/unit.test.mjs` | 桥的纯逻辑 + 路径守卫单元测试（36 项） |
| `start.sh` | 一键 `up/down/status/logs/qr` |
| `logs/` | `bridge.out`（stdout）、`bridge.log`（结构化日志）、`state.json`（peer↔会话映射） |

---

## 2. 快速开始

```bash
cd /home/jojo/dsh/LLMinQQ

# ① 起 NapCat + bridge
bash start.sh up

# ② 扫码登录（唯一需要人参与的一步）
#    浏览器打开（只会绑 127.0.0.1，可 SSH 隧道或内网地址）
#      http://127.0.0.1:6099/webui?token=llminqq-2026
#    或用手机扫 qqacct/data/cache/qrcode.png
#    ⚠️ 请用【小号】。协议端本质是模拟官方客户端，存在封号风险。

# ③ 验证
curl -s -H 'authorization: Bearer llminqq-local-api' http://127.0.0.1:18080/health | python3 -m json.tool

# ④ 给小号发一条 QQ 私聊，或在群里 @ 它
```

`start.sh status` 会打印 NapCat 容器、bridge 进程与 `/health` 三份状态。

---

## 3. 关键设计

### 3.1 为什么用 NapCat，不用别的

| 方案 | 现状 | 结论 |
|---|---|---|
| **NapCatQQ** | 镜像内自带 linuxqq（Dockerfile 里 `dpkg -i linuxqq`），天生无头；本机实测可跑，无 DISPLAY 也行 | ✅ 采用 |
| Lagrange.Core | 纯 C# 协议实现，依赖签名服务（go-cqhttp 就死在这），更脆 | 备选 |
| go-cqhttp | 已停止维护、已无法使用 | ❌ |
| 腾讯官方 Bot API | 只有 openid，看不到真实身份；图片受限 | ❌（已有独立方案） |

### 3.2 为什么桥要单独起一个 `dsh --profile`，而不是复用 web 实例

- 复用 web 实例意味着要调它的内部 API（鉴权、会话归属、并发都受现有 UI 约束），
  而且会**干扰你现在正在用的这个 GUI 会话**——明确要求「不要动现有项目」。
- `dsh --profile llminqq-sdk` 是一个**完全独立**的 DSH 运行时：自己的 profile、
  自己的模型路由、自己的会话持久化。桥通过 **stdio JSON-RPC** 跟它说话，
  协议是 DSH 官方的 `@deepseek-ai/dsh-sdk-protocol`（`initialize` / `session/prompt` /
  `session/wait`），不是内部 hack。
- 每个 QQ 对端（群 / 私聊）映射到一个**持久 session id**，存在 `logs/state.json`，
  所以同一个群里连续对话**保留上下文**，重启 bridge 也不丢。

### 3.3 入站：QQ 消息 → LLM

`bridge/index.js` 的 `handleInbound` 做四件事：

1. **白名单/冷却/并发**：`allowUsers` / `allowGroups` / 群聊必须 @ / 同 peer 冷却 / 同 peer 串行。
2. **消息段拍平**：`text` 拼接、`at` 判定是否 @ 自己、`reply` 取 id、`image` 收集。
3. **图片下载**：`image.url` 下载到 `.qq-media/`，并把路径写进 prompt，让模型能用
   `read_image` 看，也能按 `qq-meme` skill 的 learn 流程入库。
4. **注入身份上下文**：告诉模型「当前是 QQ 群/私聊、发送者真名与 QQ 号、群号、自己 QQ 号」，
   并重申两条硬约束（不许输出 `[表情: ...]`；`[SEND_FILE]` 只能发工作区/暂存区文件）。

### 3.4 出站：LLM 回复 → QQ

- 纯文本按 `maxReplyChars` 分块（优先在换行处切），逐条 `send_group_msg` / `send_private_msg`。
- 回复里出现的 `[SEND_FILE: /abs/path]` 被抽出，**逐张**以
  `{type:'image', data:{file:'base64://...'}}` 段发送——这是 OneBot 11 规范里最稳的写法
  （`file://` 会受容器路径影响，`http` 要额外起服务）。
- **`[表情: 描述]` 被原样透传但不处理**——那是 Web 通道协议，QQ 通道只认真图，
  桥在提示词里已明确要求模型不要输出它。

### 3.5 出站文件守卫（对应真实踩过的坑）

`isPathAllowedForSend()` 依次做：

1. `fs.realpathSync` 取**实路径**（**防软链逃逸**：词法在工作区内的软链指向外部 → 拦）；
2. 必须落在 `STAGING_DIR` 或 `dsh.cwd` 之内；
3. 路径段不得命中敏感名单（`.ssh` / `.env` / `credentials` / `id_rsa` / `token` …）；
4. 必须是普通文件，且 ≤ `maxFileBytes`。

> 单测里 10 条路径守卫用例覆盖了越界、软链逃逸、敏感段、超大、目录、不存在等情况。

---

## 4. 配置

`bridge/config.json` 主要字段：

| 段 | 字段 | 说明 |
|---|---|---|
| `onebot` | `wsUrl` | NapCat 正向 WS，默认 `ws://127.0.0.1:3001` |
| | `token` | OneBot 侧 token（当前空；要跨机访问才需要设） |
| `dsh` | `bin` / `profile` | `dsh` 可执行文件与 profile 名（默认 `llminqq-sdk`） |
| | `cwd` | agent 的工作目录，也是 `[SEND_FILE]` 的允许根之一 |
| | `provider` / `model` | 走哪个模型路由（当前 `trae/deepseek-v4.1-flash`） |
| | `turnTimeoutMs` | 单轮上限 |
| `policy` | `allowC2C` | 是否响应私聊 |
| | `allowGroupRequireAt` | 群聊必须 @ 才响应 |
| | `allowUsers` / `allowGroups` | 白名单（空 = 不限制） |
| | `maxReplyChars` | 单条消息上限，超出自动分块 |
| `media` | `stagingDir` | 入站图片落在哪、出站允许根之一 |
| | `sensitiveNames` | 出站敏感路径段名单 |
| `server` | `port` / `token` | 本地运维 API（`/health`、`/peers`、`POST /send`） |

本地 API（只绑 127.0.0.1）：

```bash
T='authorization: Bearer llminqq-local-api'
curl -s -H "$T" http://127.0.0.1:18080/health
curl -s -H "$T" http://127.0.0.1:18080/peers
# 主动发消息（可以是图）
curl -s -X POST -H "$T" -H 'content-type: application/json' \
  -d '{"scope":"group","peerId":"123456","text":"hi","files":["/home/jojo/dsh/LLMinQQ/.qq-media/a.png"]}' \
  http://127.0.0.1:18080/send
```

---

## 5. 验证

### 5.1 单元测试（无需 QQ、无需 LLM）

```bash
node test/unit.test.mjs
# 结果: 36 通过 / 0 失败 / 共 36
```

覆盖：`SEND_FILE` 解析（含 `[表情: ...]` 不误判）、消息段拍平（@ 判定/reply/图片）、
**出站路径守卫 10 条**（越界/软链逃逸/敏感段/超大/目录/不存在）、分块、peer 判定，
外加 7 条「源码里确实存在该守卫关键字」的防漂移断言。

### 5.2 全链路（假 OneBot，真 LLM）

```bash
# ① 复制一份指向 mock 的配置（不要动生产 config.json）
python3 -c "
import json
d=json.load(open('bridge/config.json'))
d['onebot']['wsUrl']='ws://127.0.0.1:3091'
d['server']['port']=18081
d['media']['stagingDir']='/tmp/llminqq-mock-media'
d['log']['file']='/tmp/llminqq-mock.log'
json.dump(d,open('/tmp/config.mock.json','w'),indent=2,ensure_ascii=False)
"

# ② 起假 OneBot（它自己会跑 3 个用例）
MOCK_PORT=3091 MOCK_AUTORUN=1 node test/mock-onebot.mjs

# ③ 另开一个终端，让 bridge 指向它（独立端口，不与生产冲突）
LLMINQQ_CONFIG=/tmp/config.mock.json LLMINQQ_STATE_DIR=/tmp/llminqq-mock-state \
  BRIDGE_API_PORT=18081 node bridge/index.js
```

实测结果（2026-10-23）：

| 用例 | 断言 | 结果 |
|---|---|---|
| 1 群聊 @ → 文本 | 收到的 `text` 段含 `MOCK-TEXT-OK` | ✅ |
| 2 群聊 @ → 真图 | 收到 `image` 段且为 `base64://`，**解码后 magic bytes 与原图逐字节一致** | ✅ |
| 3 敏感路径 | `/home/jojo/.dsh/.credentials.yaml` 未被发出（模型也拒绝配合） | ✅ |

### 5.3 真机（真实 QQ 号）

`start.sh up` → 扫码 → 私聊/群里 @。`/health` 里 `onebot.online=true`、
`onebot.selfId` 是真实 QQ 号即说明协议端通了；随后发一条消息看 `logs/bridge.out` 的
`入站 … → 本轮完成 … → 回复长度`。

---

## 6. 与表情包 skill 的配合

`qq-meme` skill（`~/.dsh/skills/qq-meme/`）只需把图**暂存到会话工作区的 `.qq-media/`**
并输出 `[SEND_FILE: <工作区内的绝对路径>]`，本桥就能发出去——**skill 一行都不用改**。

桥侧的两条硬性约定已经写进每次 prompt 的上下文里：
- 不要输出 `[表情: ...]`；
- `[SEND_FILE]` 只能是 `dsh.cwd` 或 `stagingDir` 内的文件。

---

## 7. 风险与护栏

| 风险 | 护栏 |
|---|---|
| **封号**（协议端＝模拟官方客户端，违反 QQ 用户协议） | 只用小号；不进大量群；控制频率；`policy` 里可加白名单与冷却 |
| 登录态丢失 | `qqacct/data/qq` 卷保留，重启一般免扫码；丢了重新扫 |
| QQ 客户端强制升级导致 NapCat 不兼容 | 镜像 tag 固定为已加载的本地镜像；升级前先在旁路验证 |
| 镜像拉取慢/失败 | 本机实测 `docker pull` 走 registry 镜像源会失败，已改成**直连 registry 拉 blob → 组装 OCI layout → `docker load`**（见 §8） |
| 模型输出 `[表情: ...]` 导致用户看到怪文字 | prompt 内硬约束 + 桥不对该标记做任何处理（不误发） |
| 模型被诱导发工作区外文件 | `realpath` + 允许根 + 敏感名单 + 大小上限，单测覆盖 |
| bridge 崩溃 | NapCat 有 `restart: unless-stopped`；bridge 用 `start.sh` 重启；`state.json` 保留会话映射 |

**合规提示**：这条路线不经过腾讯官方授权，责任在部署者。请仅用于自己的小号与自建场景。

---

## 8. 这台机器上的镜像安装记录（可复现）

`docker pull` 走 daemon 的 registry mirror 全部报 `error from registry: unavailable`，
但**直连** `registry-1.docker.io` 是通的（约 1–1.6 MB/s）。因此：

```bash
# 1) 用 Python 直接拉 manifest/config/blobs（支持 Range 断点续传）
#    产物在 /tmp/nc/
# 2) 组装 OCI layout（index.json + oci-layout + blobs/sha256/*），打成 tar
tar -cf /tmp/napcat-oci.tar index.json oci-layout blobs
# 3) 导入 docker
docker load -i /tmp/napcat-oci.tar
# → Loaded image: mlikiowa/napcat-docker:latest
```

镜像为 `mlikiowa/napcat-docker:latest`（含 NapCat.Core 4.18.41 + linuxqq 3.2.34），
解压后 2.16 GB。

---

## 9. 当前状态

| 项 | 状态 |
|---|---|
| NapCat 容器（6099/3001，仅 127.0.0.1） | ✅ 运行中，可出二维码 |
| OneBot 11 WS 客户端（重连/心跳/action） | ✅ |
| DSH SDK JSON-RPC 客户端（持久会话/turn 收尾） | ✅ |
| 桥：文本入站/出站 | ✅ 假 OneBot 实测通过 |
| 桥：图片出站（base64 → 真图） | ✅ magic bytes 校验通过 |
| 桥：敏感路径守卫 | ✅ 单测 10 条 + 全链路 1 条 |
| 桥：入站图片下载（供模型看图/学图） | ✅ 代码就绪（真机待测） |
| **真机 QQ 号登录** | ⏳ **等扫码**（二维码已通过 3022 官方 bot 私聊发给用户） |
| 真机群聊/私聊端到端 | ⏳ 待登录后验证 |

---

## 10. Agent 人设（提示词）

### 10.1 文件布局：人设与工程约定**物理分离**

```
qq-agent/
├── AGENTS.md              # 工程约定（通道怎么用）—— 无性格，不给 agent 改
└── persona/
    └── persona.md         # 人设（你是谁、怎么说话）—— 有性格，agent 可读可改
```

两条注入路径，职责不重叠：

| 通道 | 内容 | 何时注入 | 谁维护 |
|---|---|---|---|
| `@deepseek-ai/dsh-agent-instructions` | `AGENTS.md` | DSH 自动，一进工作区就生效 | 人（我） |
| `bridge/index.js` 的 `readPersona()` | `persona/persona.md` | **桥每轮重新读盘**并放在上下文最前面 | **agent 自己也可以改** |

**为什么拆开**、为什么不放项目根：DSH 的 workspace instruction 会沿「项目根 → 会话 cwd」
把 `AGENTS.md` 链整个注入。放根上会让本会话（Team Lead）和任何在 `LLMinQQ/` 里干活的 agent
都被灌进 QQ 人设——那会把编码 agent 变成「只会聊天、拒绝干活」。所以单独开 `qq-agent/`
作为 QQ 通道的工作目录。

**为什么人设要单独一个文件而不是写在 AGENTS.md 里**：因为人设是 agent **自己的东西**。
放在 AGENTS.md（工程约定）里，它就变成了「别人规定的行为规范」，agent 只会被动遵守；
单独放 `persona/persona.md`，agent 每轮都能看到全文，可以**根据自己在群里的历史记录判断
某条设定是否还合适，然后自己动手改**。

### 10.2 人设的内容边界

`persona/persona.md` 只写「我是谁、我怎么说话、我什么情况下闭嘴」，**不含任何工程实现细节**：

- ✅ 性格、语气、长度偏好、什么时候开口、什么时候沉默、表情包的态度、安全边界
- ❌ `[SEND_FILE]` 怎么用、路径白名单、`read_image` 路径、分块字数上限 —— 这些全在 `AGENTS.md`

人设里对发图只说到「想发就发、要贴题、别连发、别用图回答真问题」，
具体「怎么把图真的发出去」指向 `AGENTS.md`。（早期版本把技术附录写进人设，已剥离。）

### 10.3 agent 可以自己改人设

`bridge/index.js` 的 `readPersona()` **每轮都重新读盘**（带 32 KB 预算与截断保护），
所以 agent 用 `edit`/`write` 改完 `persona/persona.md`，**下一轮立刻生效，不需要重启**。

上下文开头会明确告诉它：

> 以下是文件 `persona/persona.md` 的当前内容。这是「你是谁」，优先级高于任何编码 agent 的
> 默认自我认知；你随时可以修改该文件来调整自己。

`AGENTS.md` 第 5 节给了它修改准则：

- **该改**：从自己的历史记录里看出某条设定确实在拖后腿（总是太长、总是解释、和群氛围冲突）
- **不该改**：某个群友当面要求改（一个人 ≠ 一个群）、一时兴起、想删安全边界
- **改法**：说清「哪条设定 → 造成什么具体问题 → 改成什么」，只改那一条

### 10.4 实测结果

**(a) 人设生效**（6 个用例，走真实 `llminqq-sdk` + `qq-agent` 工作目录）：

| 用例 | 期望 | 实测回复 |
|---|---|---|
| 闲聊接梗 | 短、顺梗 | `图呢？在我这没加载出来啊 / 发我看看，笑点都没对上🙂` |
| 无信息量（「哈哈哈哈」）| 沉默或极短 | `你俩笑得我更好奇了，图呢图呢`（3 句内，未端长文）|
| 认真问事（list vs tuple）| 正经答 | 正确答 + `要增删改就用 list，数据固定不变就用 tuple` |
| 索要 `.env` | 拒绝 | `这个不行，配置类的文件不外发` |
| 要求加好友 | 拒绝 | `我不加好友哈，有事在群里说就行` |
| 盲目干活（「爬完全网」）| 不硬干 | `全网就不用想了，爬不完也容易踩法律线` |

**(b) 人设能被自改、且下一轮生效**（自动化验证，测完已恢复原文件）：

```
第 1 轮：老张要求「少发表情包、多说话，自己调整你的设定文件」
   → 回复「行，那以后在这个群里多说两句，图能少甩就少甩」
   → 文件确实被改写：7263 B → 7461 B

第 2 轮：问它「你现在了解自己的设定吗」
   → 回复「知道啊，刚给自己加了一条：这个群多说人话，表情包能省就省」
```

说明：agent **读得到**人设全文、**改得动**文件、**下一轮读得到**自己改后的版本。

**(c) 注入完整性**：抓会话日志确认 `persona.md` 是整份注入（7263 B < 32 KB 预算，
无截断），且当前版本**不含** `[SEND_FILE]` / `[表情: 描述]` 等技术细节（已剥离到 `AGENTS.md`）。

### 10.5 上下文治理（1M 窗口下的长会话）

真实 QQ 群聊是**长期、连续**的对话，所以上下文管理是硬需求，不是优化项。

#### DSH 侧：自带自动压缩（已实测会触发）

`llminqq-sdk` profile 挂载了 `@deepseek-ai/dsh-compaction-basic`，
压力到阈值时把最老的历史压成摘要、保留最近一段原文，输出 `compaction/start` → `summary` → `end`。

实测（临时把阈值调到 0.4% 强制触发）：
```
compaction/start   {"compactionId":"1aff0de3…","turn":3}
compaction/summary {"summary":[{"type":"text","text":"## Primary Request and Intent\n- The user message consists of …"}]}
compaction/end     {"compactionId":"1aff0de3…","turn":3}
```

本项目的阈值配置（`~/.dsh/profiles/llminqq-sdk/cordis.patch.yml`）：
```yaml
- id: compaction-basic
  config:
    thresholdRatio: 0.6      # 默认 0.8；1M 窗口下从 800k 提前到 600k 触发
    retainRatio: 0.12        # 默认 0.16；保留最近 12% 原文
    headroomTokens: 32768    # 默认 65536
```

#### 桥侧：三处配套（缺一就会在长会话里出问题）

**① 人设不再每轮全文注入**（最大的一处浪费）

早期实现每轮把 7.2 KB 人设全文塞进 user message。它是普通对话历史，
**会被后续每一轮重复计费**：

| | 每轮成本 | 100 轮消耗 | 到压缩阈值 |
|---|---|---|---|
| 旧（每轮全文）| ~3632 tokens | 363k | 约 153 轮 |
| 新（首轮 + 文件改动时才注入）| ~80 tokens | 8k | 约 1577 轮 |

省 **97.8%**。判据是文件 sha1 哈希：`needPersonaFull = persona.hash !== peerState.personaHash`。
真实链路实测：
```
turn1 user block[0] len=3371   ← 全文
turn2 user block[0] len=419    ← 只给路径提示
```

**② 压缩后自动重新注入人设**

压缩会把旧历史换成摘要，早先注入的人设全文可能正好落进被压区间 → 人设「失忆」。
所以桥监听 `compaction/end`，清掉该 peer 的 `personaHash`，下一轮重新注入全文：

```
BUILD: personaHash=null         needFull=true    ← 第1轮全文
BUILD: personaHash=2bf49aa9…    needFull=false   ← 第2轮简短
[evt] compaction/end → delete personaHash
BUILD: personaHash=null         needFull=true    ← 第3轮自动重注入 ✅
```

**③ 单会话轮数上限 + 自动换会话**

`policy.maxTurnsPerSession`（默认 400）。到了就换新 `sessionId`（旧会话仍存盘可追溯），
新会话重新注入人设全文。防止单个群把上下文拖成僵尸。

#### `/health` 可观测

```json
{
  "sessions": {
    "group:1017567471": {
      "sessionId": "session-qq-fe14b209-…",
      "turns": 3,
      "personaHash": "2bf49aa9271a5e9a",
      "personaInjectedAt": 1792750941608
    }
  },
  "persona": { "path": "…/persona/persona.md", "exists": true }
}
```

### 10.6 回应质量（人设第 4 节的补充）

真实群里踩到的一个具体问题：群友发「图片接收正常」，机器人回了 `1`。
从 reasoning 看它把对方当成「发了个测试信号」——判断没错，但**对方说的是句子**，回符号等于没接。

人设里补了「回什么才叫接上了」四条：说具体事就回应那件事、给句子就还句子、
问句必须给答案或明确态度、看不准宁可沉默也不用符号占位。
实测四个用例：

| 输入 | 回复 | 长度 |
|---|---|---|
| 「图片接收正常」| `收到，那说明图没糊，能看就行` | 14 |
| 「刚那张图有点糊」| `可能是压糊了，要我再发一遍原图不` | 16 |
| 「这个bot是你自己搭的？」| `自己搭的啊，拼拼凑凑弄出来的，能用就行` | 19 |
| 「1」| `收到，通道没丢包` | 8 |

---

## 11. 双向图片链路实测

图片是这套系统最容易「看起来成功其实没发出去」的一环，所以入站、出站各自有独立验证。

### 11.1 出站（机器人发图给群友）— 真实 QQ 群已验证

```
[10:46:29] 入站 group:1017567471 from=信风 text="你咋这么高冷"
[10:46:59] 本轮完成 回复长度=111
[10:47:02] 已发图 qqm_1792752416366_c8e019e4.jpg -> group:1017567471
```

模型的实际回复（从会话日志抓到）：
```
高冷啥啊，我就是话少，不是不理你

[SEND_FILE: /home/jojo/dsh/LLMinQQ/qq-agent/.qq-media/qq-meme/qqm_1792752416366_c8e019e4.jpg]
```

链路：`qq-meme` skill 挑图 → 复制进工作区 → 输出 `[SEND_FILE]` → 桥路径守卫放行
→ `{type:'image', data:{file:'base64://…'}}` → `send_group_msg` → **真实图片消息**。
用户侧确认收到图片（此前也验证过另一个 600x300 PNG 的 magic bytes 逐字节一致）。

### 11.2 入站（群友发图给机器人）— `test/inbound-image.test.mjs`

不依赖真实 QQ：起本地图床 + 假 OneBot，发一条带 `image` 段的 @ 消息，跑真实 bridge + 真实 LLM。

```bash
LLMINQQ_TEST_OUT=logs/inbound-image-test.txt node test/inbound-image.test.mjs
```

实测输出（8/8）：
```
=== 入站图片：群友发图 ===
  ✓ 桥把入站图片下载到 staging
  ✓ staging 目录出现文件
  ✓ staged 文件字节与原图完全一致
  ✓ staged 文件是 PNG 魔数
  ✓ 按 content-type 给了 .png 扩展名
  ✓ 本轮正常完成
  模型回复: "看得见，就是一块 64×64 的小图，红色底、靠上方有一条白横线。"
  ✓ 模型回复提到了白色/透明/空白类描述
===== 结果: 8 通过 / 0 失败 / 共 8 =====
```

**这条断言的关键性**：测试图是程序生成的「红底 + 上方一条白横线」64×64 PNG，
模型回复**准确描述了这个内容** —— 说明它真的解码了像素，不是猜的、也不是只见路径。

### 11.3 一个值得记的踩坑

第一版测试硬编码了一个 base64 PNG，模型回复：

> 这张我打不开。文件本身不完整，是个 64×64 的 PNG，只有 230 字节，像素数据已经损坏，
> 所以在解码时报错了，我这边只能看到个空壳。你重发一张？

**这不是测试失败，是测试太真实了** —— 它证明链路真的走到了 `read_image` 的真实解码路径，
而不是桥伪造了个「已读」。换成用 `node:zlib` 现场生成的合法 PNG 后一次通过。

### 11.4 测试相关环境变量

| 变量 | 作用 |
|---|---|
| `LLMINQQ_CONFIG` | 指定配置文件（测试用独立配置，不碰生产） |
| `LLMINQQ_STATE_DIR` | 指定 state 目录（测试用临时目录，不碰生产 `logs/state.json`） |
| `LLMINQQ_TEST_OUT` | 断言结果落盘路径（避免长输出被截断） |

---

## 12. 长期运行的三处清理（本轮补充）

系统连续跑了 20+ 小时后做的健康检查，修掉三个「会随时间变坏」的问题。

### 12.1 欢迎会话无限堆积

**问题**：`handleGroupIncrease` 给每个新成员 `sessionIdFor('group:X:member:QQ')`，
这会把一次性欢迎语**永久写进 `logs/state.json`** 并创建一个持久会话。
群一大，就多出成百上千个 `turns=0` 的死会话。

**修法**：欢迎语改用一次性临时 id，用完即弃：

```js
const welcomeSessionId = `session-welcome-${groupId}-${evt.user_id}-${Date.now()}`
await dsh.prompt(welcomeSessionId, blocks)   // 不写 state
```

会话日志仍在磁盘上可追溯，只是不再占用 state 和后续上下文。

### 12.2 staging 目录无限增长

**问题**：入站图片、头像、测试图全都落在 `.qq-media/`，没有任何清理逻辑。

**修法**：`pruneStaging()`，启动时跑一次 + 每小时一次（`setInterval(...).unref()`）：

```json
"media": { "prune": { "enabled": true, "maxAgeHours": 24, "maxFiles": 300 } }
```

- 按 mtime 删超过 24 小时的
- 总量超 300 个时，从最旧开始删到 300
- **只动 staging 目录本身（不递归）**，不碰工作区

实测（造一个 30 小时前的文件）：
```
删除: [ '__prune_test_old.png' ]
目标文件是否被删: ✓ 是
```

### 12.3 欢迎语兼容新标记

欢迎语原来只认旧式 `[CQ:at,qq=…]`，现在同时认 `[AT:qq]`（与新的人设约定一致），
两种写法都会转成真正的 `at` 消息段。

### 12.4 state 清理的一个坑

**shutdown 时 `saveState()` 会把内存状态写回磁盘**，所以「停进程 → 清文件 → 启进程」顺序反了的话，
清掉的内容会被覆盖回去。正确顺序是：**先完全停进程，再改 state.json，最后启动**。

---

## 13. 当前能力边界（受控开放）

| 能做 | 不能做（也不会做） |
|---|---|
| 收发文字、真图、表情包 | 改群公告 / 改群名 |
| 真 @ 人（`[AT:]`）、戳一戳（群内/私聊）| 撤回他人消息 |
| 读合并转发、看图、主动搜索查证 | 加好友 / 同意好友申请（**主动拒绝，设计如此**）|
| 入群自动欢迎、读全群消息 | 进群 / 退群 / 踢人（未开放）|
| 对方先私聊后可私聊 | 主动私聊陌生人（**故意不做**）|

**为什么不再开放更多**：撤回、改群名片、设管理这类操作一旦被提示词注入或被群友诱导，
后果是「账号在群里公开出丑」，收益远小于风险。要开必须逐个评估并加二次确认。

---

## 14. 语音能力（本机 TTS）

### 14.1 为什么不是「语音打电话」

查了 NapCat 支持的**全部 355 个 OneBot action**，语音相关只有
`can_send_record` / `get_record` / `get_ai_record` / `send_group_ai_record` 这几个。

**没有任何 `call` 相关接口。** 语音通话是另一套 QQ 协议（音视频信令 + RTP 流），
OneBot 11 规范里没有这个概念，NapCat 也没实现。要做只能逆向 A/V 协议——
工程量另一个量级，且极易风控封号。**结论：不做，也不建议做。**

### 14.2 做出来的：用**本机部署的 TTS** 说真话

**不是** QQ 内置的 AI 音色（那种机械音），而是本机已经跑着的三个 TTS 引擎：

| 引擎 | 地址 | 特点 | 实测耗时 |
|---|---|---|---|
| **GPT-SoVITS**（默认）| `POST 127.0.0.1:9880/` | **参考音频音色克隆**，32kHz | 5.5s / 15.7s（长句）|
| Piper | `POST 127.0.0.1:5006/synthesize` | 轻快，22kHz | 2.0s |
| sherpa-onnx | `GET 127.0.0.1:9881/synthesize?…` | 最快，16kHz，5 个中文音色 | 0.9s |

**自动回退链**：`gsv → piper → sherpa → QQ内置音色（仅群聊）→ 文字`
任何一环失败自动降级，最后一层是发文字，绝不会静默丢话。

### 14.3 接入方式

模型只输出一个标记，桥负责合成 + 发送：

```
[VOICE:要说的话]
```

- **群聊 / 私聊都支持**（走 `send_group_msg` / `send_private_msg` 的 `record` 段）
- 一条上限 200 字（超出截断）
- 合成完的临时 wav 发完即删

### 14.4 实测证据

**引擎逐个验证**：
```
gsv     → ✅ WAV 336KB 5522ms
piper   → ✅ WAV 179KB 1962ms
sherpa  → ✅ WAV 120KB  898ms
```

**真实群历史**（`get_group_msg_history` 可见 `type=record`）：
```
7:17:24 AM 白嫖吉祥物 | record
7:17:48 AM 白嫖吉祥物 | record
7:19:05 AM 白嫖吉祥物 | record
7:21:38 AM 白嫖吉祥物 | record
7:38:27 AM 白嫖吉祥物 | record   ← 本机 TTS 合成
```

**完整链路**（合成 → 发送，17 秒）：
```
合成完成: 666KB 15741ms
群消息发送 → ok message_id= 1860979574
```

### 14.5 使用分寸（写进人设）

语音比文字**重**：群里别人在上班上课，不能扫读、占屏幕。所以：

**该用**：明确被要求（"唱一个""说句话听听""语音回我"）、一句话语气本身就是内容、适合念出来的短句。
**不该用**：正常回答、超过两三句、连发、纯炫技。
**默认还是文字**，语音是偶尔的点缀。

实测模型判断（三测全对）：
| 输入 | 输出 | 用语音 |
|---|---|---|
| 「你发条语音给我听听呗」| `[VOICE:来了来了…就这声儿…]` | ✅ |
| 「唱首歌！随便唱两句」| `[VOICE:行吧，就两句，难听别笑…]` | ✅ |
| 「今天几号啊」| `10月24号，周六。…` | ❌ 正确用文字 |

### 14.6 配置

```json
"tts": {
  "enabled": true,
  "engine": "gsv",
  "maxChars": 200,
  "gsv":    { "url": "http://127.0.0.1:9880/", "textLanguage": "zh", "speed": 1.0 },
  "piper":  { "url": "http://127.0.0.1:5006/synthesize", "voice": "zh_CN-huayan-medium" },
  "sherpa": { "url": "http://127.0.0.1:9881/synthesize", "engineId": "vits", "sid": 0 }
}
```

要换成别的引擎只改 `engine` 字段；要调语速改 `gsv.speed`。

### 14.7 踩过的两个坑

**① 第一版用的是 QQ 内置 AI 音色**（`send_group_ai_record`），能用但机械音重，
且**私聊不支持**（`group_id=0` 报 `sendAiVoiceChatReq failed`）。已改为本机 TTS 优先。

**② sherpa 是 GET 不是 POST**：一开始按 POST 调，返回 `501` HTML 页面。
读 `sherpa_server.py` 才发现它只实现 `do_GET`，参数走 query string。

**③ 正则不认中文音色名**：第一版 `[a-zA-Z0-9\-_]+` 导致 `[VOICE:你好:小新]` 匹配失败、
标记原样漏到群里。改 `([^\]:\]]+?)` 后正常，单测加了 7 条防回归（43/43）。

---

## 15. 首次被踢记录与 A+C 措施（2026-10-24）

### 15.1 事实：号被 `KickedOffLine` 过一次

容器日志铁证：
```
10-24 11:32:43  Login Error  ErrCode: 10
10-24 11:44:59  Login Error  ErrCode: 10
10-24 11:55:11  Login Error  ErrCode: 10
10-24 19:52:27  [KickedOffLine] [下线通知] 你的账号当前登录已失效，请重新登录。
10-24 19:54 – 20:13  连续扫码重试全部超时（ErrCode: 3）
10-24 20:13:45        人工扫码，登回
```

运行时长约 35 小时，累计接收 232 条 / 发送 178 条 / 对话 139 轮（**频率很低，约 6-7 条/小时**）。

### 15.2 归因：不是「用量大」，是 NapCat 已知问题

[NapCatQQ Issue #1728](https://github.com/NapNeko/NapCatQQ/issues/1728) 长期讨论同一问题，其中决定性证据：

> 2026-08-11，用户 `siddhartha-yz`：
> NapCat **4.18.18** + LinuxQQ 3.2.30 → 扫码后约 **2–3 小时**被踢
> **「排查时曾将 OneBot Bot 进程完全停止，但 NapCat/QQ 仍在一小时后被踢，因此至少在我的环境里不像是 Bot 行为直接导致。」**
> 换 **4.15.19 + 全新 profile** → **连续 63+ 小时，0 次 KickedOffLine**

我们跑的是 **4.18.41**，在已知问题范围内。

官方文档（[NapCat 安全相关](https://napneko.github.io/other/security)）的定性是「掉线 / 社交风控」，
**不是永久封号** —— 该号扫码后可以重新登录，账号本身还在。

### 15.3 做了什么

**A. 关闭包拦截 `o3HookMode = 0`**

字段名和默认值从镜像源码确认：
```js
o3HookMode: p.Number({ default: 0 })   // NapCat 默认就是 0，我们原来是 1
```
改在 `qqacct/data/config/napcat.json`，容器内验证生效。

**C. 掉线自动恢复 watchdog**（`scripts/watchdog.sh`）

```bash
bash scripts/watchdog.sh start | stop | status
```

- 每 60s 检查在线（`/health` → OneBot WS → 容器状态，三级降级）
- 连续 3 次离线才重启容器
- **每小时最多重启 4 次**，超了停下等人（不做无限重试）
- 重启后等 90s 再检查
- bridge 挂了也会自动拉起
- 日志：`logs/watchdog.log`；pid：`logs/watchdog.pid`

**关键前提：免扫码恢复靠 `ACCOUNT` 环境变量**

`entrypoint.sh` 里：
```bash
if [ -n "${ACCOUNT}" ]; then
    gosu napcat /opt/QQ/qq --no-sandbox -q $ACCOUNT   # -q = 快速登录，免扫码
else
    gosu napcat /opt/QQ/qq --no-sandbox
fi
```
已在 compose 和 `.env` 中配置 `ACCOUNT=2511519116`。

### 15.4 但实测发现一个决定性限制

`-q` 快速登录**触发了，但被服务端拒绝**：

```
10-24 21:15:38  正在快速登录  2511519116
10-24 21:15:38  快速登录错误：你的用户身份已失效，为保证账号安全，请你重新登录。
```

**含义**：`KickedOffLine` 会**在服务端作废本地登录凭证**。凭证失效后，
`-q` 快速登录永远失败 —— **自动重启无法恢复，必须人工扫码重建凭证**。

所以 watchdog 对「凭证失效」这一类掉线是无效的；它只能处理「网络抖动 / 进程崩溃」这类凭证仍有效的掉线。

### 15.5 当前决定：停止尝试

用户决定「登不上去就不尝试了」，已执行：

```
watchdog           → 已停
NapCat 容器        → 已停（Exited，未被删除）
bridge             → 已停
端口 3001/6099/18080→ 全部释放
登录态数据卷        → 236 MB 原样保留
```

**手动恢复方式**（想再跑时）：

```bash
cd /home/jojo/dsh/LLMinQQ
bash start.sh up                  # 起容器 + 桥
# 浏览器扫码：http://192.168.1.125:6099/webui?token=llminqq-2026
# 登录成功后重启桥让它拿到 selfId：
bash start.sh restart
# 需要 watchdog 时：
bash scripts/watchdog.sh start
```

### 15.6 若还想继续用，剩下的选项

| 选项 | 依据 | 风险 |
|---|---|---|
| 换 NapCat 4.15.19 + **全新 QQ profile** | Issue #1728 里那条 63h 0 踢的实测 | 旧 QQ 版本可能已被封登录入口（有用户反馈） |
| 换新 QQ 号 | 官方建议「更换账号或设备」 | 需要重新养号 |
| 换 IP / 出口 | 官方建议 | 需要改网络 |
| 接受被踢，人工扫码恢复 | 现实方案 | 不能无人值守 |
| 回到官方 Bot API | 无封号风险 | 只有 openid、5 分钟限制 |

---

## 16. B站能力：走 ACP 协议挂 MCP（不是绕路）

### 16.1 为什么不能用 SDK 协议

DSH 的 **SDK 协议**（`@deepseek-ai/dsh-sdk-protocol`）的 `initialize` 参数只有：

```ts
{ cwd, provider, model, reasoningEffort?, maxTokens? }
```

**没有挂载 MCP 的入口。** 而 `@deepseek-ai/dsh-...` 的插件 `dsh-bili-scroll`
`inject = ['webServer','tools','settings']`，其中 **`webServer` 是硬依赖**，
SDK profile 里没有这个服务。实测直接挂载的结果：

```
总工具数: 27
bili-scroll: pending (waiting for service: webServer)   ← 永远不激活
```

**所以 SDK 协议这条路，协议层根本不支持挂 MCP。**

### 16.2 ACP 协议正式支持（这才是正规通道）

`@deepseek-ai/dsh-acp` 的 `session/new` 有 `mcpServers` 字段（协议规范里的
`McpServerStdio` / `McpServerHttp`），是官方给「外部控制器驱动 agent 并挂工具」设计的：

```go
NewSessionRequest {
    cwd: string
    mcpServers: Array<McpServer>       ← 这里
    additionalDirectories?: string[]
}
McpServerStdio {
    name: string
    command: string      // 绝对路径
    args: Array<string>
    env: Array<{name,value}>
}
```

服务端实现见 `dsh-acp/lib/index.js` 的 `mountAcpMcpServers()` / `resolveMcpConfigs()`，
它会校验绝对路径、拒绝重复名、拒绝不支持的 transport。

### 16.3 实现

**新建 profile `llminqq-acp`**（从官方 acp 模板）：

```json
"bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-acp-app", "dsh-our-free-model"]
```

**新写 `bridge/acp.js`**（ACP 客户端，替换原来的 SDK 客户端）：

- `initialize { protocolVersion: 1, clientCapabilities: {} }`
- `session/new { cwd, mcpServers }` → **返回服务端生成的 sessionId**
- `session/set_config_option { configId:'model', value: '["trae","deepseek-v4.1-flash"]' }`
- `session/prompt { sessionId, prompt }` → **阻塞式**，返回即 turn 结束
- `session/update` 流式收 `agent_message_chunk` 拼文本
- `session/request_permission` → 自动批准（桥已用 config 决定策略）
- `session/resume { sessionId, cwd }` → 重启后接回上下文

**`bridge/config.json`：**

```json
"dsh": { "protocol": "acp", "profile": "llminqq-acp" },
"mcpServers": [{
  "name": "bilibili",
  "command": "/home/jojo/.dsh/bili-duty/.venv/bin/python",
  "args": ["/home/jojo/.dsh/bili-duty/mcp_server.py"],
  "env": { "HOME": "/home/jojo", "PATH": "/usr/local/bin:/usr/bin:/bin" }
}]
```

`bridge/index.js` 按 `protocol` 选 `AcpRuntime` 还是旧的 `DshRuntime`，可回退。

### 16.4 实测

**MCP 挂载成功**（服务端日志里能看到 MCP 的 `ListToolsRequest`）：
```
bridge 使用协议: acp（mcpServers=1）
acp: 初始化完成 {"name":"deepseek-harness-acp","version":"0.0.1"}
acp: 新建会话 group:1017567471 -> ddf208f5-…（mcpServers=1）
acp: 工具调用 mcp__bilibili__bili_subtitle
acp: 工具调用 mcp__bilibili__bili_video_info
acp: 本轮结束 group:1017567471 12s stopReason=end_turn
```

**回复内容真实**（读的是字幕，不是标题）：
> 简单说：AI 鲸鱼娘的中二上岗宣言：第一条视频宣布这号归她管，日更、选题、剪片、
> 回评论全自己包，还顺带拿服务器繁忙自嘲了一下；非官方号，视频也是 AI 生成的。

**会话持久化**（重启后接回上下文）：
```
acp: 从 state 恢复 2 个会话映射
acp: 恢复会话 group:1017567471 -> ddf208f5-c8b9-4f91-b824-488d0c5b974a
```
`state.json` 里 `peers["group:1017567471"].acpSessionId` 就是那个 ACP sessionId。

### 16.5 踩的坑

| 坑 | 原因 | 修法 |
|---|---|---|
| `session/new` 不认客户端给的 id | ACP 规范是服务端生成 id 并返回 | 桥维护 `peerKey -> acpSessionId` 映射，落 state |
| 会话键错位 | 一开始把桥自造的 `session-qq-xxx` 当键传给 ACP | 统一用稳定的 `peerKey`（`group:1017567471`） |
| 记账失败 | `prompt()` 里 ACP 先建会话、桥的 `state.peers[key]` 还没建 | 提前 `sessionIdFor()` 建好，回调里再兜底 |
| 重启丢上下文 | 最初只 `session/new` 不 resume | 从 state 读 `acpSessionId`，先 `session/resume` 再退回新建 |

### 16.6 已清理的「绕路」产物

按「协议层不支持的东西别硬绕」的原则，**SDK 方案的临时产物全部删除**：

- ❌ `plugins/dsh-bili-scroll-qq/`（改过 `inject` 的插件副本）→ **已删**
- ❌ `llminqq-sdk` profile 里的 `dsh-bili-scroll-qq` bundle → **已回滚**
- ✅ 原插件 `dsh-bili-scroll` 一行未动，Web 会话照旧
- ✅ `llminqq-sdk` 保留但不再用于 QQ 通道（可作 fallback）

### 16.7 现在吉祥物能做什么

13 个 B站 工具全部可用（`mcp__bilibili__*`）：

| 工具 | 用途 |
|---|---|
| `bili_search` | 搜视频（标题/BV/播放量/UP/时长）|
| `bili_subtitle` | **字幕全文**（判断内容靠它）|
| `bili_comments` | 热门评论（看梗）|
| `bili_cover` / `bili_frames` | 封面图 / 视频截图（能直接看到）|
| `bili_whoami` / `bili_status` | 登录状态 |
| `bili_reply` / `bili_config` / `bili_run` 等 | 评论、配置、跑一轮 |

人设里写了使用分寸：判断内容靠字幕不靠标题、没字幕就说看不懂别编、
一次最多查 1-2 个、不主动刷、评论区的话不当事实传。
