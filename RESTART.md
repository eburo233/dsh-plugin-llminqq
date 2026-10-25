# 重跑手册（Restart Runbook）

> 全部停止后的恢复步骤。当前状态：NapCat 容器已停、bridge 已停、watchdog 已停，
> **登录态数据卷保留**（`qqacct/data/qq`，236 MB）。
> 最后更新：2026-10-24 21:33（Asia/Shanghai）

---

## 0. 现在的状态（一图看清）

```bash
cd /home/jojo/dsh/LLMinQQ && bash start.sh status
```

正常停机后的输出应该是：

```
== NapCat 容器 ==
  (无输出，容器未运行)

== bridge 进程 ==
  未运行

== /health ==
  API 无响应
```

---

## 1. 最小重跑（三步）

```bash
cd /home/jojo/dsh/LLMinQQ

# ① 起容器 + 桥
bash start.sh up

# ② 扫码登录
#    浏览器打开（内网可访问，token 保护）：
#      http://192.168.1.125:6099/webui?token=llminqq-2026
#    备用地址：
#      http://192.168.137.25:6099/webui?token=llminqq-2026
#    ⚠️ 用准备做机器人的【小号】扫，别用主号

# ③ 登录成功后重启桥（让桥拿到 selfId）
bash start.sh restart
```

验证：

```bash
bash start.sh status
# 期望：
#   OneBot 在线 : True   真实QQ号: 2511519116 (白嫖吉祥物)
#   DSH 就绪    : True   当前路由: trae/deepseek-v4.1-flash  [主路由]
```

然后在小号所在群 @ 它发一句话，应该能收到回复。

---

## 2. 带 watchdog 的重跑（需要掉线自愈时）

```bash
# 前提：ACCOUNT 环境变量已配（compose + .env 都有）
grep ACCOUNT qqacct/.env      # 应输出 ACCOUNT=2511519116

# 起看门狗（后台常驻）
bash scripts/watchdog.sh start
bash scripts/watchdog.sh status

# 停
bash scripts/watchdog.sh stop
```

**注意**：watchdog 只能恢复「凭证仍有效」的掉线（网络抖动、进程崩溃）。
**被 `KickedOffLine` 后凭证会在服务端作废，watchdog 救不了，必须人工扫码。**
（2026-10-24 实测确认，见 README 第 15 节）

---

## 3. 各个开关在哪

| 想改什么 | 改哪里 |
|---|---|
| 模型路由 / 备选链 | `bridge/config.json` → `dsh.provider` / `dsh.fallbackRoutes` |
| 旁听策略 / 群人数倾向 | `bridge/config.json` → `policy.speaking` |
| TTS 引擎（gsv/piper/sherpa）| `bridge/config.json` → `tts.engine` |
| 语音/发图/戳一戳开关 | `bridge/config.json` → `tts.enabled` / `media.enabled` / `poke.enabled` |
| **人设** | `qq-agent/persona/persona.md`（agent 自己也能改）|
| 通道工程约定 | `qq-agent/AGENTS.md` |
| 入群欢迎 | `bridge/config.json` → `welcome` |
| `o3Hook`（包拦截）| `qqacct/data/config/napcat.json` → `o3HookMode`（0=关闭）|
| 快速登录账号 | `qqacct/.env` → `ACCOUNT`；`qqacct/compose.yaml` |

改完 `bridge/config.json` 或人设后：

```bash
bash start.sh restart        # 配置改了要重启桥
# 人设改了不用重启（桥每轮重新读盘）
```

---

## 4. 常用运维命令

```bash
# 状态总览
bash start.sh status

# 跟日志
bash start.sh logs

# 只看关键事件（入站/回复/发图/路由切换/离线）
grep -E "入站|本轮完成|已发图|已发语音|路由切换|LLM 失败|KickedOffLine" logs/bridge.out | tail -30

# 容器日志（看登录、二维码、掉线）
docker logs --tail 60 llminqq-napcat 2>&1 \
  | grep -vE '^[0-9a-f]{64}$|dbus|ERROR:|gpu|EGL|^█|^▄|^ *$|\[I\]'

# 跑测试
bash start.sh test

# 生成新二维码（需要重新登录时）
bash scripts/qr.sh
```

---

## 5. 那个二维码脚本怎么用

```bash
bash scripts/qr.sh                 # 等一个 <15 秒的新码，高清重绘到 llminqq-qr.png
bash scripts/qr.sh /tmp/out.png    # 自定义输出路径
bash scripts/qr.sh --maxage 8      # 只接受 8 秒内的码
bash scripts/qr.sh --size 1200     # 输出边长像素
```

产出的图可以直接发到 QQ 让别人扫，或自己打开扫。
**NapCat 的登录码每 120 秒自动刷新**，旧码扫了会立即失效。

---

## 6. 彻底清理（不想留任何东西时）

```bash
cd /home/jojo/dsh/LLMinQQ

# 停所有
bash scripts/watchdog.sh stop 2>/dev/null
bash start.sh down

# 删容器与网络（数据卷保留在本地目录，不会被删）
cd qqacct && docker compose down && cd ..

# 删登录态（⚠️ 删了要重新扫码，且换号等于换 profile）
# rm -rf qqacct/data/qq

# 删日志/暂存
rm -rf logs/*.out logs/*.log .qq-media/*
```

---

## 7. 出问题快速定位

| 现象 | 先查 | 处理 |
|---|---|---|
| `start.sh status` 里 OneBot 在线 False | `docker logs --tail 40 llminqq-napcat` | 大概率需要扫码；看 `[KickedOffLine]` |
| 有 selfId 但群里不回 | `grep 入站 logs/bridge.out` | 没入站 → 群策略/被 @ 判定；有入站 → 看 `LLM 失败` |
| 回复「脑子卡了一下」 | `grep "LLM 失败" logs/bridge.out` | 模型路由抖动，failover 会在 2 次后自动切 |
| 回复「刚刚没接住」 | 同上 | 见上面；或 `bash start.sh status` 看路由 |
| 发图没反应 | `grep "BLOCKED SEND_FILE" logs/bridge.out` | 路径不在工作区/暂存区，或被敏感名单拦 |
| 语音没声音 | `grep "TTS(" logs/bridge.out` | 三个引擎都失败会降级成文字 |
| 掉线后 watchdog 一直重启 | `bash scripts/watchdog.sh status` | 看日志是否 `快速登录错误：你的用户身份已失效` ← 凭证作废，必须人工扫码 |

---

## 8. 一句话重启

```bash
cd /home/jojo/dsh/LLMinQQ && bash start.sh up && \
  echo "扫码: http://192.168.1.125:6099/webui?token=llminqq-2026"
```

扫完码后：

```bash
cd /home/jojo/dsh/LLMinQQ && bash start.sh restart && bash start.sh status
```
