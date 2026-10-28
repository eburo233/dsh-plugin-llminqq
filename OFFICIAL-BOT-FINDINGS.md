# 官方 QQ Bot 通道调研结论

> 调研时间：2026-10-28
> 分支：`feat/official-bot`
> 起因：NapCat 真实号方案连续两次掉线（35h / 48h），且腾讯官方发视频警告「第三方工具可能被封号」

---

## 一、结论先行

**官方 bot 只能当「干净的对话跑道」，不能当吉祥物本体。**

| 目标 | 可行性 |
|---|---|
| 用插件跑「官方 bot 私聊 + 群 @」基本对话 | ✅ 完全可行，配置现成 |
| 拿到**工程规矩**（`qq-agent/AGENTS.md`） | ✅ **可行**（cwd 指过去，DSH 核心按 cwd 发现）|
| 承载吉祥物**人格 + 记忆 + 情绪 + B站 MCP** | ❌ **不可行**（人格/记忆/MCP 见 §二③、§三）|
| 和 NapCat 桥**同群共存** | ❌ **不可行**（会重复回复，人格分裂）|
| 当「测试跑道」验证 lexicon 学习效果 | ✅ **可行 ← 这才是正确用法** |

> 更正记录：本表在首次提交（`1674b59`）时把「拿到工程规矩」也标成了 ❌。
> 那是错的 —— 当时只查了插件、漏查 DSH 核心的 `dsh-agent-instructions`。
> 详见 §二③ 的更正说明。

---

## 二、决定性证据（代码级，不是推测）

### ① 人格来自 `agentPreset`，不是 cwd

**我们这条正在对话的通道，session header 是这样的：**

```json
{
  "id": "session-10e368cb-61fc-42b5-a569-f6f2c1d443d6",
  "cwd": "/home/jojo/dsh/LLMinQQ",
  "agentPreset": "standard"
}
```

**注意 `agentPreset: "standard"`** —— 人格由它决定，**和 cwd 无关**。

### ② `cwd` 只进 `meta.cwd`

`lib/platform/conversation-bridge.js:341-343`：
```js
const meta = { cwd }
if (composition.agentPreset) meta.agentPreset = composition.agentPreset
const handle = await this.ctx.agents.create(createOptions)
```

`cwd` 决定 agent 的**工作目录**（读写文件的根），**不决定加载哪份配置**。

### ③ 插件不读 AGENTS.md / persona.md —— 但 **DSH 核心会按 cwd 读 AGENTS.md**

⚠️ **本节首次提交时写错过，已更正**。当时的错误：只 grep 了插件、没查 DSH 核心，
就断言「改 cwd 没用」。结论是错的，保留这段更正记录以免后人重犯。

**正确答案分两层：**

**第一层：插件自己确实不读**（原判断这部分是对的）
```
grep AGENTS.md / persona / systemPrompt → 插件里零命中
```
插件只负责把 IM 消息转发给 DSH 的 agent，不掺和指令文件加载。

**第二层：但 DSH 核心会读 —— 由 cwd 驱动**（首次提交漏掉的关键事实）

`@deepseek-ai/dsh-agent-instructions` 是 **dsh 主包的直接依赖**：
```
/home/jojo/.local/lib/node_modules/@deepseek-ai/dsh/package.json
deps: [ ... '@deepseek-ai/dsh-agent-instructions' ... ]
```
→ 所有 profile 都会加载，不是可选项。

它按 **cwd 沿目录树向上**发现指令文件：
```js
const DEFAULT_INSTRUCTION_FILE_CANDIDATES = ["AGENTS.md", "CLAUDE.md"];
const DEFAULT_LOCAL_INSTRUCTION_FILE_CANDIDATES = ["AGENTS.local.md", "CLAUDE.local.md"];
// @param cwd - absolute session working directory where the walk begins
async function findProjectRoot(cwd, markers, fileSystem, signal) { ... }
```
预算配在 `dsh-base/cordis.patch.yml`：`agent-instructions: maxBytes: 65536`（64KB）。

**所以 `cwd` 指到 `qq-agent` 后，agent 会真的加载 `qq-agent/AGENTS.md`**
（13KB ≪ 64KB 预算，完整加载）。

**但必须区分两个文件：**

| 文件 | 大小 | cwd 改过去会加载吗 |
|---|---|---|
| `qq-agent/AGENTS.md` | 13KB | ✅ **会**（dsh-agent-instructions 按 cwd 发现） |
| `qq-agent/persona/persona.md` | 15KB | ❌ **不会**（DSH 没有 persona 概念，零命中） |

`persona.md` 的注入是**我们自己桥**做的（`bridge/index.js` 的 `readPersona()` 拼进
`contextLines`）。官方插件通道上没有这段逻辑，所以人格不会自动过来。

**修正后的结论**：
- ✅ 工程规矩（AGENTS.md）—— cwd 改过去就有
- ❌ 人格（persona.md）—— 仍需额外工作
- ❌ 记忆/情绪/精力/风格锚/lexicon —— 全在 `bridge/index.js`，官方通道上没有
- ❌ B站 MCP —— 插件通道无 mcpServers 传参（B站 MCP 现在走我们桥的 ACP 链路）

### ④ 配置的 cwd ≠ 实际 cwd（重要细节）

```
config.json 里 3022.cwd = /home/jojo/dsh/dsbot
实际 session 的 cwd  = /home/jojo/dsh/LLMinQQ
```

**原因**：`cwd` 是**创建会话时的默认值**。会话一旦建好，`cwd` 就固定在 session 里，
之后改配置**只影响新会话**，不影响已存在的。

---

## 三、能力边界（官方 bot vs NapCat 真实号）

| 能力 | NapCat（真实号）| 官方 bot |
|---|---|---|
| 群聊普通消息（不 @）| ✅ 全部收到 | ⚠️ **需群主在手机 QQ 授权「接收全量消息」** |
| 主动发消息 | ✅ 自由 | ⚠️ 1000 条/群/天、20 条/分/群 |
| @ 人 | ✅ `[AT:QQ号]` | ❌ 只能用 openid |
| 戳一戳 | ✅ `[POKE:QQ号]` | ❌ 官方无 poke |
| 真实 QQ 号 | ✅ 有 | ❌ **只有 openid**（应用隔离的哈希 ID）|
| MCP 工具 | ✅ 能挂（走 `bridge/config.json` 的 `mcpServers` → ACP 协议）| ❌ **本插件的通道挂不上**（插件里 `mcpServers` grep 零命中）|
| 撤回 | ✅ 2 分钟内 | ✅ 2 分钟内 |
| 发图片 | ✅ | ✅ 但要先上传拿 file_info |

### ⚠️ OpenID 问题（最致命）

官方事件体里，发送者只有：
```typescript
// 群消息
author: { member_openid: string; username?: string; bot?: boolean }
// 私聊
author: { user_openid: string }
```

**没有 `uin`（真实 QQ 号）字段。** SDK 源码全库确认。

**后果**：
- 我们 `mem.db` 的 `owner` 列全是真实 QQ 号（`3022464706` 这类），**官方通道完全对不上**
- `member_openid`（群）和 `user_openid`（私聊）是**两套不同的 ID**，同一个人无法关联
- 前两个任务刚做完的「按人跨通道归集」**在官方通道上失效**
- `[AT:QQ号]`、`[POKE:QQ号]`、`proactive.whitelist` 全部要改

---

## 四、三个风险（按严重程度）

### 风险 1（最严重）：两套桥同群会重复回复

- NapCat 桥：监听 OneBot 网关，群里**所有消息**都处理（含旁听）
- 官方 bot：监听官方 WebSocket，`@` 必处理，全量消息（若授权）也处理

**用户 @ 一次 → 两边都收到 → 都调 LLM → 都发一条不同的回复**
→ 群里看起来像两个人格

**唯一能共存的形态**：
- 在不同群，或
- 官方 bot **只做私聊**

### 风险 2：状态完全隔离，记忆会分裂

```
NapCat 桥状态：logs/state.json（peerKey = c2c:3022464706）
官方插件状态：~/.dsh/dsh-bridge/config.json 的 activeSessionId + DSH session 存储
```

**两边完全不共享**：情绪/精力/记忆/人设注入全各自独立。
官方通道拿不到 QQ 号 → `mem.db` 归集/跨通道检索**不可用**。

**结论**：官方 bot 会是一个「没有记忆、没有情绪、没有人设」的空壳吉祥物，
除非重做一套。

### 风险 3：两个 profile 运行时不同，混不了

| | NapCat 桥 | 官方插件 |
|---|---|---|
| 跑在哪 | 独立进程 `bridge/index.js` | **dsh web 进程内**（PID 145481）|
| profile | `llminqq-acp`（ACP 服务端）| `web`（完整 agent 平面）|
| 工具集 | 由 ACP 侧决定（MCP 靠这挂）| 由 web profile preset 决定（**无 MCP**）|
| 我们的代码 | 全在我们手里 | **在 node_modules 里，升级会被覆盖** |

**最后一条很实际**：插件是 npm 包，README 写着「一键升级」。**任何 patch 都会在升级时丢失。**

---

## 五、正确用法（已采用的方案）

**把官方 bot 定位成「干净的对话跑道」，不是吉祥物本体。**

- ✅ 价值：**真实 QQ 链路 + 真实对话节奏**，用来跑 lexicon A/B 消融
- ✅ **不需要人设/记忆/MCP** —— 反而**去掉这些，消融实验的变量更干净**
- ✅ `cwd` **不用改**（改了没用），保持 `/home/jojo/dsh/dsbot`
- ❌ **不要和 NapCat 同群**（重复回复 + 人格分裂）

### 具体分工

| 通道 | 用途 |
|---|---|
| **NapCat 真实号**（主）| 吉祥物本体：人格 + 记忆 + 情绪 + B站 MCP + 主动搭话 + 旁听 |
| **官方 bot**（辅/跑道）| 真实链路测试：lexicon A/B 消融、私聊对话验证 |

---

## 六、如果要让官方 bot 真当吉祥物本体

**需要一个新的 agent preset**：
- ~~读 `qq-agent/AGENTS.md`~~ → **cwd 指过去就会自动加载**（§二③ 已更正）
- 读 `persona/persona.md`（DSH 不认识这个文件名，需要 preset 或 AGENTS.md 里加指引）
- 挂 MCP（B站 MCP 目前写在 `bridge/config.json` 里走 ACP；插件通道要用
  `dsh-mcp-client` 的 profile 级配置，是另一条路）
- 处理 openid → 弱身份映射（用 `username`/`nickname` 兜底）

比起「改个 cwd」要复杂，但**不是完全做不到** —— 只是人格/记忆/情绪这一大块
需要重做注入逻辑。**不建议现在做**（用户明确说先验证学习效果）。

---

## 七、`bridge/official-adapter.js` 的去留

插件路线下它是**多余的**，但**保留**（用户决定 A）：

- 已提交（`0d59974`），删掉要额外工作
- 万一插件升级/不可用，有自研备份通路
- 它对「openid 不能当 QQ 号」的处理是好设计（`idKind: 'openid'` 显式标注，
  防止 openid 被写进 `mem.db` 的 `owner` 列污染按人检索）

---

## 八、遗留

1. `allowFrom[1] = 61243D55...` 已失效（`11255 已注销`），**等确认路线后清理**
2. 「第一个dsbot」所在的群 openid **未知**（它不在 `8F6A5E0B...` 那个群）
3. 曾误发一条 3000 字符全是 `xxxx` 的探测消息（不该用「发消息」验证 openid 有效性）
