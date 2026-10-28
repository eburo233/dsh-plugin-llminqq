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
| 承载吉祥物**人格 + 记忆 + 情绪 + B站 MCP** | ❌ **不可行**（见下）|
| 和 NapCat 桥**同群共存** | ❌ **不可行**（会重复回复，人格分裂）|
| 当「测试跑道」验证 lexicon 学习效果 | ✅ **可行 ← 这才是正确用法** |

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

### ③ 插件根本不读 AGENTS.md / persona.md

整个插件 grep `AGENTS.md` / `persona` / `systemPrompt` → **零命中**
（只有 feishu 模块的 `personal_settings` 是无关同形词）

**所以「改 cwd 到 qq-agent 就能用上吉祥物人格」这个假设是错的。**

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
| MCP 工具 | ✅ 能挂 | ❌ **插件不支持 mcpServers**（grep 零命中）|
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
- 读 `qq-agent/AGENTS.md` + `persona/persona.md`
- 挂 MCP（`mcpServers`）
- 处理 openid → 弱身份映射（用 `username`/`nickname` 兜底）

这是**另一个工程**，不是改个 cwd 能解决的。**不建议现在做**（用户明确说先验证学习效果）。

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
