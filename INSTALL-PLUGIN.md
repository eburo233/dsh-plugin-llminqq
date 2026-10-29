# 把 LLMinQQ 做成 DSH 插件

> 状态：**插件已实现并在真实 DSH 中验证通过**，剩下「装进你的 profile」这一步需要你执行
> （agent 的沙箱不能写 `~/.dsh/`，所以最后一条命令得你来敲）。

---

## 1. 它是什么

原来这个仓库是「一套脚本 + 几份配置文件」。现在它是一个**标准 DSH 插件**：

```
dsh-plugin-llminqq/
├── lib/index.js       宿主侧：HTTP API、agent 工具、拉起桥子进程
├── lib/bridge/        OneBot↔LLM 转发（独立子进程）
├── client.js          设置页「QQ 通道」
└── cordis.patch.yml   bundle 挂载声明
```

装完在 **设置 → QQ 通道** 里，有六个分页：

| 分页 | 能干什么 |
|---|---|
| **登录** | 一键起停 NapCat 容器、显示登录二维码（手机直接扫）、看登录状态（等待扫码 / 已登录 / 被踢下线）、配端口/镜像/容器名、填凭据 |
| **模型** | provider 下拉（来自宿主真实注册的路由）、模型列表、推理强度、可选同步为 DSH 默认模型、**降级链增删 + 上下移动改顺序 + 逐条编辑 + 连续失败阈值/冷却时间** |
| **行为** | 私聊开关、群里要不要 @、用户/群白名单、单条字数、连发间隔、冷却、免打扰时段、8 个能力开关（戳一戳/撤回/补一句/语音/入群欢迎/B站/风格库/学习）、主动发言（白名单+概率+冷却） |
| **人格** | 直接编辑 `persona.md`，即时生效（桥每轮重读盘，不用重启） |
| **运行** | 桥进程起停/重启、日志实时刷新 |
| **高级** | 总开关、数据目录、原始 JSON 深合并覆盖、恢复默认（**不清凭据**） |

---

## 2. 装（你来执行这一条）

```bash
dsh plugin --profile web add file:/home/jojo/dsh/LLMinQQ/.template-worktree/packages/dsh-plugin-llminqq
```

装完：

1. **刷新** `http://192.168.1.125:3080/`
2. 设置里找 **「QQ 通道」**（排在「表情包」前面）
3. 先点 **「① 启动 QQ 容器」**，等二维码出来，用**小号**扫
4. 登录成功后去 **「运行」** 页点 **「启动桥」**

> 如果你只想先在旁路试，不要动正在用的 web profile：
> ```bash
> DSH_HOME=/tmp/tryit dsh plugin --profile web add file:.../dsh-plugin-llminqq
> DSH_HOME=/tmp/tryit dsh --profile web --port 3099
> ```

---

## 3. 数据放哪

```
~/.dsh/dsh-plugin-llminqq/         ← 插件自己的数据（配置/凭据/容器）
├── config.json     设置页改的东西（可分享、可进版本控制）
├── secrets.json    凭据，权限 0600（QQ 号 / token）
├── agent/
│   └── persona/persona.md
├── napcat/         容器数据卷（登录态在这，删了要重新扫码）
└── logs/bridge.out

~/.dsh/llminqq/                    ← 记忆数据（**和上面分开放**）
├── mem.db          记忆库（SQLite，几百条对话归纳）
├── style.db        自我风格样本
├── lexicon.json    学来的说话方式（词汇/梗/句式）
├── digest.md       记忆摘要（按人分节）
├── corpus/         B站评论语料池（可选）
├── log/            入站消息语料（喂给 learn）
└── scheduler.json  定时任务上次跑的时间
```

**为什么记忆单独放 `~/.dsh/llminqq/`**（这也是「卸载/重装」时要看的关键）：

- 记忆是**攒出来的资产**（几个月才有几百上千条），而配置是**随手可改的**。
  两者放一起的话，用户「重置配置」或「重装插件」就有可能顺手把记忆端掉。
- 这个目录**独立于 npm 包**：升级插件、`npm uninstall` 都不会碰它。
- 可用 `config.json` 里的 `memory.stateDir` 改到别处（比如放到大容量盘）。

**为什么配置和凭据分开存**：`config.json` 是「可以发给别人求助」的那部分；
把 QQ 号和 token 混进去，会让一次求助变成泄密。所以凭据单独一个 0600 文件，
设置页**只写不读**（你填了新值它就存，页面上永远只显示「已设置」）。

---

## 4. 和旧版（脚本形态）的关系

旧的那套（`start.sh` / `bridge/config.json` / `setup.sh`）**还在，没删**，两条路并存：

| | 旧版脚本 | 新版插件 |
|---|---|---|
| 装法 | clone 仓库，跑 `setup.sh` | `dsh plugin add` |
| 配置 | 手改 `bridge/config.json` | 设置页点 |
| 扫码 | 开浏览器进 NapCat WebUI | 设置页里直接出图 |
| 适合 | 想自己掌控每一个文件、或部署到没有 GUI 的服务器 | 日常用 |

插件不读旧版的配置，两者数据目录完全独立，互不干扰。

---

## 5. 已验证到什么程度（真实运行，不是模拟）

测试方式：临时 profile + 真 `dsh --profile web` 起在 3099 端口，**不碰你的生产实例**。

| 验证项 | 结果 |
|---|---|
| `dsh --dump-config` 能列出插件 | ✅ |
| `/api/overview` | ✅ HTTP 200，Docker 探测到 v29.5.3 / compose v5.1.4 |
| provider 枚举 | ✅ 拿到真实注册的 `deepseek-official` / `deepseek-account` |
| 宿主当前模型识别 | ✅ `deepseek-official/deepseek-flash` |
| 保存配置 | ✅ HTTP 200，落盘正确 |
| 坏降级链被拒 | ✅ HTTP 400 + `["第 1 条：model 为空"]` |
| 人设读写 | ✅ 读到骨架、写入生效 |
| **client bundle 交付** | ✅ boot 清单含 `dsh-plugin-llminqq`，49KB 正确返回 |
| 设置分区注册 | ✅ bundle 内含 `settings.section` 注册 |

**没验证的**（这台机器上做不到）：真正扫码登录、桥连上真 QQ 收消息。
那需要真实小号 + 启动容器，属于你装完之后自己验的部分。

---

## 6. 踩过的三个坑（都是只有真跑才暴露的）

1. **`inject` 不能是空数组**
   cordis 的守卫：要读某个服务，必须先在 `inject` 里声明，否则
   `cannot get property "webServer" without inject`。
   我用桩对象测的时候完全没暴露 —— 桩不实现这个守卫。**桩测不出框架约束**。

2. **`defineTool` 不是服务**
   我一开始写 `ctx.get('defineTool')`，错了。它来自 `@deepseek-ai/dsh-tools` 包。
   改成动态 `import` + try/catch，拿不到就按约定自己拼最小 definition ——
   工具是锦上添花，不能因为它缺失让设置页挂掉。

3. **client bundle 的路径要让加载器认得出**
   路径来自 `exports["./client"]`，且 `files` 清单要列对。
   改成根目录 `client.js`（跟 `dsh-expression` 同款）。

---

## 7. 如果装完看不到「QQ 通道」

按顺序查：

```bash
# 1. 插件进 profile 了吗
python3 -c "import json;print(json.load(open('$HOME/.dsh/profiles/web/package.json'))['dsh']['profile']['bundles'])"

# 2. DSH 认得它吗（应该能 dump 出 dsh-plugin-llminqq 那一条）
dsh --profile web --dump-config | grep -A2 llminqq

# 3. 启动时有没有报错（看 stderr，不是 stdout）
dsh --profile web 2>&1 | grep -iE "llminqq|Failed plugins|waiting"
```

「waiting for services」里如果出现它，说明某个 `inject` 的服务没加载
（比如没有 `webServer` 的服务端场景），设置页就不会出现，但插件本身不算失败。

---

## 8. 装完插件不出现？先看清这一点（真实踩过）

**`dsh plugin add` 只装包，不保证把它加进 `dsh.profile.bundles`。**
而只有列在 `bundles` 里的包才会被当作 profile layer 加载。

实测复现：`dependencies` 里有、`node_modules` 里也有，但重启后
`dsh --dump-config` 里搜不到 —— 因为 `bundles` 数组里没有它。

`dsh plugin-manager` 里那句 `if (beforeDeps.has(name)) continue` 意味着
**remove 再 add 有可能不补进 bundles**（它的 reconcile 会跳过已经出现过的名字）。

### 一条命令诊断

```bash
node diagnose.mjs              # 检查 web profile
node diagnose.mjs web --dsh-home D:\.dsh
```

它会按顺序检查：profile 存在 → 包进了 dependencies → 包真的在 node_modules →
**是否列在 bundles** → 安装副本的 `dsh.bundle` 声明 → 静态 import 是否全解析
→ 真 import 一次 → `dump-config` 认不认。哪一步断会直接告诉你修法。

### 手动修（最稳）

编辑 `%USERPROFILE%\.dsh\profiles\web\package.json`：

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-plugin-llminqq"
      ]
    }
  }
}
```

改完重启 dsh，刷新浏览器（Ctrl+F5）。

---

## 9. Windows 特有注意事项

### Docker Desktop

能用，但有两道坎：

1. **必须是 Docker Desktop**（不是只装 docker CLI）。它提供 WSL2 后端，NapCat 容器跑在里面。
2. **文件共享白名单**：如果项目在 `D:` 盘，要进
   Docker Desktop → Settings → Resources → File sharing 把 `D:` 加进去。
   否则挂载会报 `Path ... is not shared from the host`。
   插件已把这个错误翻译成人话提示（不再是一串英文报错）。

首次 `启动 QQ 容器` 要拉 2GB+ 镜像，慢的话等几分钟。

### 桌面版 DSH 没有设置页

Web 版有、桌面版没有 —— 这是 DSH 宿主差异：`settings.section` 这个 slot
由 web 前端提供。桌面版如果没挂 `dsh-client-ui-settings`，插件注册不上就看不到。
插件本身没做区分（`ctx.get('slots')` 拿不到就静默跳过），不会报错。
**目前请用 Web 版配置。**

---

## 10. 卸载（以及「为什么重装后记忆还在」）

```bash
# 1. 停桥、移除插件
dsh plugin remove dsh-plugin-llminqq
```

移除后**数据不会被删**，它们在这两个地方：

```
~/.dsh/dsh-plugin-llminqq/   ← 配置、凭据、NapCat 登录态、persona
~/.dsh/llminqq/              ← 记忆库（mem.db / lexicon.json / corpus / …）
```

**想彻底清理**：把那两个目录删掉即可。

```bash
rm -rf ~/.dsh/dsh-plugin-llminqq ~/.dsh/llminqq
```

⚠️ 删 `~/.dsh/dsh-plugin-llminqq/napcat/` 之后**要重新扫码登录**；
删 `~/.dsh/llminqq/` 则**记忆清零、无法恢复** —— 删之前建议先去设置页「记忆」
导出备份 zip。

**不删的话重装后记忆还在** —— 这是故意的：插件是「工具」，记忆是「你的东西」，
工具换了不该把东西扔掉。

### 从旧版脚本迁移记忆过来

旧脚本版的记忆在仓库的 `qq-agent/memory/` 下。插件装好后手动迁一次：

```bash
node ~/.dsh/profiles/web/node_modules/dsh-plugin-llminqq/lib/agent/memory-migrate.mjs \
  --from /path/to/LLMinQQ/qq-agent/memory
```

它会用 SQLite backup API（不是 `cp`，热拷会撕裂）拷库、校验条数，
并且会提示你先停掉旧脚本版（两边同时写会互相抢）。
