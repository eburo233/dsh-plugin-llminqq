# 主动搭话 + 更像人 · 实现报告

> 需求来源：`qq-agent/proactive-msg-spec.md`（信风提，吉祥物整理）
> 实现：SeekDee　｜　日期：2026-10-25
> 状态：**v1 全部实现**（默认关闭，待开启）；**v2 第 1、2 条已实现**；v2 第 3 条按需求归人设

---

## 一、v1 主动搭话 —— 逐条对规格

| 规格项 | 实现 | 位置 |
|---|---|---|
| 只对信风私聊生效 | 白名单 `whitelist: ['3022464706']`，且代码只挑 `c2c:` 会话 | `proactiveCandidates()` |
| 群聊不主动发 | 候选过滤 `k.startsWith('c2c:')` | 同上 |
| 默认关闭 | `proactive.enabled: false` | `config.json` |
| tick 20 分钟 | `tickMin: 20`，`setInterval` | `startProactiveLoop()` |
| 计时基准 = 我最后一次发言 | `touchLastSpoke()` 在**回复成功**和**主动发出**后都调用 | `handleInbound` / `proactiveSpeak` |
| 不足 20 分钟 → 跳过、不评估、不改概率 | `if (minsSinceSpoke < c.tickMin) continue` | `proactiveTick()` |
| p0 = 10% | `baseProb: 0.10` | — |
| 未命中 p += 5%，上限 60% | `st.p = Math.min(c.maxProb, st.p + c.step)` | — |
| 命中后 p 回 10% + 冷却 40 分钟 | `st.p = c.baseProb; st.cooldownUntil = now + 40min` | — |
| 连续 6 次未命中 → 保底 | `if (st.missStreak + 1 >= c.guaranteeCount) action='guarantee'` | — |
| 空转计为未命中 | 模型回 `[SILENT]` 或空 → `missStreak++`、`p += step` | — |
| 01:00–07:00 不评估（保底也不触发） | `proactiveWindow()` 返回 `skip:true`，在掷骰**之前**就 continue | — |
| 23:00–01:00 概率 ×0.5 | `factor: 0.5`，`pEff = st.p * factor` | — |
| 内容：先翻最近 30 条找口子 | 交给模型（人设+记忆摘要），prompt 里明确写了三类口子 | `proactiveSpeak()` |
| 找不到就空转，别硬聊 | prompt 明确「只输出 `[SILENT]`」 | — |
| 私聊不设每日上限，只有 40 分钟间隔 | 只有 `cooldownMin`，无 daily cap | — |
| 格式不限，图/语音按平时分寸 | 复用完整出站流程（SEND_FILE / VOICE / POKE / AT 都支持） | — |
| 每会话一份 json 状态 | `state.peers[key].proactive` = `{p, missStreak, lastSpokeAt, lastProactiveAt, cooldownUntil}` | — |
| 重启不能立刻冒一条 | 状态从 `state.json` 读回，`lastSpokeAt` 保留 → 重启后仍要等满 tick | — |
| 每轮 tick 打一行日志 | 见下方「日志格式」 | — |
| 配置项可改数值不改代码 | 全部 10 个配置项在 `config.json` 的 `proactive` 段 | — |

### 日志格式（实测输出）

```
proactive[group:1017567471] 跳过：距上次发言 8min < 20
proactive[c2c:3022464706] 跳过：冷却中（剩 32min）
proactive[c2c:3022464706] 跳过：静默时段 3:00
proactive[c2c:3022464706] 评估：距上次 25min | p=100% | roll=0.958 | hit
proactive[c2c:3022464706] 空转（找不到合适话题），计为未命中
proactive[c2c:3022464706] 已主动发出（hit）："刚看到你说的那个……"
```

### 状态实测（生产桥跑起来后的真实值）

```json
{
  "group:1017567471": {
    "turns": 165,
    "energy": { "value": 0.51 },
    "proactive": { "p": 0.10, "missStreak": 0, "lastSpokeAt": 1792912993173 }
  },
  "c2c:3022464706": {
    "turns": 106,
    "energy": { "value": 0.57 },
    "proactive": { "p": 0.10, "missStreak": 0, "lastSpokeAt": 1792913013732 }
  }
}
```

---

## 二、v2-1 状态有起伏（精力值）

### 实现

- 每个 peer 一份 `energy: { value, at }`，**落 state.json**
- 每发一条消息 → `value -= perMsgDrop`（默认 0.06）
- 静默恢复 → `value += hours * perHourRestore`（默认 0.15/小时），每次读时按距今小时数算
- 边界 `floor 0.15 / ceil 1.0`
- 每 10 分钟落盘一次（保证静默回升能持久化）

### 注入上下文

```
【你的精力】约 51%（有点累，控制在 40 字以内）。这是倾向不是禁令。
```

三档实测输出：
```
51% → 【你的精力】约 51%（有点累，控制在 40 字以内）
32% → 【你的精力】约 32%（挺累了，控制在 20 字以内）
12% → 【你的精力】约 12%（快没电了，控制在 10 字以内，能一句就一句）
```

### ⚠️ 这里踩了一个坑，值得记

**第一版只写了形容词**（「挺累了，能短就短」），实测**反效果**：

| 精力提示 | 回复长度 |
|---|---|
| 约 95%（很足，话多也正常） | 386 字 |
| 约 15%（快没电了，能短就短） | **748 字** ← 反而翻倍 |

原因：模型把「你累了」理解成「需要多解释一下自己的状态」。

**改法**：把形容词换成**可执行的数字**（「控制在 20 字以内」）。改后：

| 精力提示 | 回复长度 |
|---|---|
| 95% | 375 字 |
| 45% | 40 字 |
| 30% | 19 字 |
| 15% | 27 字 |

再加一层**代码兜底** `energyCharCap()`：精力 < 40% 且回复超限时，截到上限并保留完整句子结尾（只在低精力生效，不碰正常回复）。

---

## 三、v2-2 回话有快有慢（延迟发送）

- `replyDelay` 配置：`enabled: false`（**默认关**，符合需求里「优先级最低，容易让人以为掉线」）
- 开启后：短回复（<8 字）延迟 0.8–4 秒；正常回复 1.5–12 秒随机
- 日志：`replyDelay <peer>: 3200ms（模拟人打字的时间）`

实测延迟计算：
```
短消息「在」      → 约 1.2s
正常消息 30 字    → 约 7.4s
长回复 200 字     → 约 11.6s
```

---

## 四、v2-3 有自己的偏好

**按需求原文，这一条不需要工程支持**：

> 「这个不用工程支持，靠人设里的『好奇心是真的』自然长出来；要防的是『对什么都一样客气』的客服味。」

所以没写代码。人设里已有相关内容（「不是每条都要接」「宁可少说一句」等），
这次只加了一句关于精力的、防止它把状态当表演的话。

---

## 五、测试

### `test/proactive-logic.test.mjs`（13/13 通过）

不依赖桥、不连 QQ、不碰生产环境 —— 纯决策逻辑：

| 组 | 断言 |
|---|---|
| 概率单调递增 | 10→15→20→25→30→35% |
| 保底 | 第 6 次触发 `guarantee` 而非继续 +5% |
| 保底重置 | 发完 `p` 回 10% |
| 冷却 | 命中后 40min；20min 时仍跳过；41min 可评估 |
| 静默时段 | 1/3/6 点全部 `skip-quiet` |
| 夜间系数 | p=60% ×0.5 → 实际 30%，roll=0.5 判未中 |
| tick 门槛 | 15min < 20min → 跳过 |

### 边界与坑

| 踩的坑 | 说明 | 修法 |
|---|---|---|
| 测试桥连了生产 NapCat | 我用测试配置起了第二个桥实例，它连上了**同一个 3001 端口**，处理了真实消息 | 立即停掉（pid 已清理），改为纯逻辑测试 |
| 精力提示反效果 | 见上，说「累」反而更长 | 改成数字上限 + 代码兜底 |
| python 编辑弄坏语法 | 插入 `energyCharCap` 时多了一个 `}`，桥启动失败 | `node --check` 抓到，删掉 |

**教训**：以后起测试实例必须把 `onebot.wsUrl` 指向一个**不存在的端口**，让它连不上，而不是复用生产配置。

---

## 六、怎么开启

```bash
# 1) 改配置
python3 - <<'EOF'
import json
p='/home/jojo/dsh/LLMinQQ/bridge/config.json'
d=json.load(open(p))
d['proactive']['enabled']=True          # 打开主动搭话
# d['replyDelay']['enabled']=True       # 想试延迟再开这个
json.dump(d,open(p,'w'),indent=2,ensure_ascii=False)
EOF

# 2) 重启桥
cd /home/jojo/dsh/LLMinQQ && bash start.sh restart

# 3) 观察日志
grep -E "proactive\[" logs/bridge.out | tail -20
```

**想快速验证**（不改等 20 分钟）：临时把 `tickMin` 调成 1–2 分钟、`baseProb` 调到 0.9，
看它是否真的会主动发。验证完记得改回来。

**关闭**：`proactive.enabled = false` → 重启。

---

## 七、当前状态

```
proactive: 未启用（默认关，白名单已配 3022464706）
energy:    已启用，group 51% / c2c 57%（真实值，会随发言递减、静默回升）
replyDelay: 默认关
```

桥已重启并加载全部代码，`turns` 持续增长中。
