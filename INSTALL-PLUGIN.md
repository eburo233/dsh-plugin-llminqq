# 安装与排障细节（INSTALL-PLUGIN）

这是 [README](README.md) 安装部分的加长版，面向「装完没出现 / 出现了但连不上」的情况。
先读 README 的「安装」和「装完先点哪」，按那里的顺序走；这里补充每一步的判断依据。

---

## 1. 它是什么形态

这个仓库是**一个标准 DSH 插件**，不是独立程序：

```
dsh-plugin-llminqq/
├── lib/index.js       宿主侧：HTTP API、agent 工具、拉起桥子进程
├── lib/bridge/        OneBot ↔ LLM 转发（独立子进程）
├── lib/agent/         记忆、B 站语料等
├── client.js          设置页「QQ 通道」（exports["./client"]）
└── cordis.patch.yml   bundle 挂载声明
```

装完在 **设置 → QQ 通道**，共 7 个分页：

| 分页 | 能干什么 |
|---|---|
| **登录** | 一键起停 NapCat 容器、显示登录二维码（手机扫）、看登录状态、配端口/镜像/容器名、填凭据 |
| **模型** | provider 下拉（来自宿主真实注册的路由）、模型列表、推理强度、可同步为 DSH 默认模型、降级链增删与排序、连续失败阈值/冷却时间 |
| **行为** | 私聊开关、群里是否必须 @、用户/群白名单、单条字数、连发间隔、冷却、免打扰时段、能力开关（戳一戳/撤回/补一句/语音/入群欢迎/主动发言/风格库/说话方式学习/B 站工具）、B 站 MCP 依赖安装 |
| **记忆** | 条数、按人分布、最近记忆、导出 zip、导入、清除、B 站语料抓取 |
| **人格** | 编辑 `persona.md`，即时生效（桥每轮重读盘） |
| **运行** | 桥进程起停/重启、日志实时刷新 |
| **高级** | 总开关、数据目录、原始 JSON 深合并覆盖、恢复默认（不清凭据） |

---

## 2. 装（一条命令）

把 `<插件目录>` 换成你 clone/解压出来的目录**绝对路径**（含 `package.json` 的那层）：

bash（Git Bash / macOS / Linux）：

```bash
dsh plugin --profile web add file:/home/you/code/dsh-plugin-llminqq
```

PowerShell：

```powershell
dsh plugin --profile web add file:C:/Users/你/code/dsh-plugin-llminqq
```

装完：

1. 重启 `dsh --profile web`；
2. 打开 DSH Web 界面（命令启动时打印的地址，默认在本机端口上）；
3. 设置里找「QQ 通道」；
4. 先点「① 启动 QQ 容器」，等二维码出来，用**小号**扫；
5. 登录成功后去「运行」页点「启动桥」。

### ⚠️ 桥用哪个 profile：配的模型可能根本不存在

桥会起一个 **`dsh --profile acp` 子进程**来跑对话。`acp` 是 DSH 随附的**最精简**
profile，bundles 只有：

```
@deepseek-ai/dsh-base
@deepseek-ai/dsh-acp-app
```

**它不认识你装在任何第三方渠道插件里的 provider。** 如果你的模型路由指向
`trae/xxx`、`qodercn/xxx` 这类（由 `dsh-our-free-model` 等插件注册到 **web** profile），
而 `acp` profile 里没装那些插件，就会出现：

```
Internal error (code -32603)
→ 再往下翻日志才看到：
llm-deepseek: no API key for provider route "deepseek-official"
```

**看起来是「所有模型都不可用」，真相是你配的模型一个都没被调用过** ——
`session/set_config_option` 设一个不存在的 provider 会**静默失败**，
自动回落到 profile 的默认路由（通常是 `deepseek-official`），而它没有凭据。

自查（看 acp profile 到底认识哪些 provider）：

```bash
dsh --profile acp --dump-config | grep -A3 "id: acp"
```

如果只有 `deepseek-official`，而你配的是 trae/qodercn，就需要把提供 provider 的
插件也挂进 acp profile。以 `dsh-our-free-model` 为例（凭据在全局
`~/.dsh/.credentials.yaml`，**不用重新登录**）：

```bash
# 1) 软链过去（不用重装，省几百 MB）
mkdir -p ~/.dsh/profiles/acp/node_modules
ln -sfn ~/.dsh/profiles/web/node_modules/dsh-our-free-model \
        ~/.dsh/profiles/acp/node_modules/dsh-our-free-model

# 2) 把 bundle 加进 acp profile
python3 - <<'EOF'
import json, os
p = os.path.expanduser('~/.dsh/profiles/acp/package.json')
d = json.load(open(p))
b = d['dsh']['profile']['bundles']
if 'dsh-our-free-model' not in b:
    b.append('dsh-our-free-model')
json.dump(d, open(p, 'w'), ensure_ascii=False, indent=2)
EOF

# 3) 重启 dsh web 让它生效
```

验证（应该能看到 trae / qodercn 等分组）：

```bash
dsh --profile acp --dump-config | grep "our-free-model"
```

> 也可以把「高级 → ACP profile」直接填成 `web`，那样所有 provider 都在 ——
> 但 `web` 会起 HTTP 服务抢宿主端口（`EADDRINUSE 3080`），**不推荐**，
> 插件已经把 `web`/`headless`/`desktop` 都重定向到 `acp` 了。

### 图片输入（发图给机器人看）

模型支持归模型支持，**能不能用还取决于 ACP 这条链路**。

`dsh-acp` 在 `initialize` 时按 profile 配置的 provider/model 查一次
`inputModalities`，结论**在整个子进程生命周期内固定**。所以：

- 模型目录里 `deepseek-v4.1-flash` 明明写着 `['text','image']`，
  但 ACP 可能报 `inline image prompts were not advertised by this connection`；
- 如果这一步算得太早（第三方 provider 还没注册完），会被判成不支持。

插件已做两件事：**启动时先等 provider 注册就绪（实测约 2.5 秒）再 initialize**；
并且**只在配了非内置 provider 时等**（`deepseek-official` 是宿主自注册的，没有竞态）。

如果还是报不可用，先看桥日志有没有这两行：

```
acp: 已等 3002ms 让 provider 注册就绪（路由 trae/deepseek-v4.1-flash）
acp: 图片输入 可用
```

没有「已等」那行 → 说明等逻辑没跑到（profile 是内置 provider 或版本旧）；
有「已等」但仍报不可用 → 那个模型的 `inputModalities` 确实不含 `image`
（去设置页「模型」页看该模型的标签有没有「看图」）。

### 看视频画面：要装 `yt-dlp`（可选，但强烈建议）

「这视频讲了啥」这类问题，**光有字幕不够** —— 教程/手工/做饭/舞蹈/游戏实况，
内容全在画面里。

插件有 **两个看画面的工具**，但它们的清晰度差得很远（2026-11-01 实测）：

| | `bili_frames` | `video_storyboard` |
|---|---|---|
| 输入 | 只要 BV 号 | **B站 URL 或本地文件** |
| 来源 | B站自带故事板（为进度条预览做的）| 真扫全片（如 10380 帧），按**画面变化**选帧 |
| 尺寸 | 480×270 | 874×701（每格 286-331px）|
| 效果 | **字小到看不清** | 能读清画面上的文字 |

同一个图文讲解视频，`bili_frames` 给的帧只能看到「EP02 12/22」这种页码和
残缺词条；`storyboard` 一眼能看出「7+8=15 被划掉改成 13」这种具体对话示例。

**`video_storyboard` 只缺一个外部命令 `yt-dlp`**（它刻意不打包，见
`vendor/dsh-video-storyboard/src/fetch.js` 的注释）。装了之后就能直接吃 URL：

```
[fetch] downloaded 4.2MB → 360p (source max 1080p, auth=anonymous)
[scan]  10380 帧 → 22 个切点
[sheet] 874x701  3x4  cell≈286x159
[done]  9090ms
```

一次「下载 + 出图」约 11 秒（下载 360p 只有 4.2MB，它不需要高分辨率）。

#### 怎么装

> ⚠️ **不要** `pip install --user yt-dlp`。Ubuntu 24.04+ 等系统有 PEP 668 保护，
> 会直接报 `externally-managed-environment` 拒绝。

**Linux / macOS（用 venv，最干净）：**

```bash
python3 -m venv ~/.local/share/yt-dlp-venv
~/.local/share/yt-dlp-venv/bin/pip install -U yt-dlp
mkdir -p ~/.local/bin
ln -sfn ~/.local/share/yt-dlp-venv/bin/yt-dlp ~/.local/bin/yt-dlp
~/.local/bin/yt-dlp --version     # 能打印版本就成了
```

⚠️ 如果 venv 是**从别处拷来的**（而不是原地新建），`yt-dlp` 脚本第一行的
shebang 还指向老路径，会报 `cannot execute: required file not found`。
修一下：

```bash
sed -i '1s|.*|#!/home/你/.local/share/yt-dlp-venv/bin/python3|' \
  ~/.local/share/yt-dlp-venv/bin/yt-dlp
```

**Windows：**

```powershell
winget install yt-dlp
# 或者
scoop install yt-dlp
```

**macOS（更省事）：**

```bash
brew install yt-dlp
```

#### 验证它真的能被找到

插件是按 **PATH + `~/.local/bin`** 去找的（见 `fetch.js` 的 `findOnPath`）。
确认 `~/.local/bin` 在 PATH 里：

```bash
echo "$PATH" | tr ':' '\n' | grep -F "$HOME/.local/bin"
```

没有就加到 shell 配置里（`~/.bashrc` 或 `~/.zshrc`）：

```bash
export PATH="$HOME/.local/bin:$PATH"
```

装完怎么验：让对方发个 B站链接问「这视频讲了啥」，然后看桥日志有没有

```
[fetch] downloaded …MB → 360p
```

有就是成了；报 `yt-dlp not found` 就是 PATH 没配好。

> **不装也能用**：`bili_frames` 不依赖 yt-dlp（直接裁 B站故事板）。
> 只是清晰度差、看不清画面里的字。字幕（`bili_subtitle`）也不依赖它。

#### 字幕带时间戳（和宫格图对得上）

`bili_subtitle` 返回三种形式，**带时间戳的那两种是「图文理解」的关键**：

| 字段 | 内容 |
|---|---|
| `text` | 纯文本（老行为） |
| `timedText` | `[0:06] Agent，你被人类抱怨过吗？` 每行带时间 |
| `segmentsWithTime` | `[{from: 6.65, to: 9.04, text: "…"}]` 结构化 |

宫格图每格都标着时间戳，字幕也带时间戳，模型才能说清
「第 3 格（15-23 秒）在演示什么、对应字幕哪一句」。

### 想旁路试，不动正在用的 web profile

给一个临时 `DSH_HOME`，数据和依赖都会落在临时目录：

bash：

```bash
DSH_HOME=/tmp/tryit dsh plugin --profile web add file:/home/you/code/dsh-plugin-llminqq
DSH_HOME=/tmp/tryit dsh --profile web --port 3099
```

PowerShell：

```powershell
$env:DSH_HOME = "C:\tmp\tryit"
dsh plugin --profile web add file:C:/Users/你/code/dsh-plugin-llminqq
dsh --profile web --port 3099
```

---

## 3. 数据放哪

默认数据目录 `~/.dsh/dsh-plugin-llminqq/`（设置 `DSH_HOME` 时在
`$DSH_HOME/dsh-plugin-llminqq/`；从 profile 的 `node_modules` 加载时，
插件优先从安装路径反推 DSH home）。实际路径看设置页「高级」，或宿主启动日志里的
`[llminqq] v0.5.2 已加载 · 代码在 … · 数据目录 …`。

```
<数据目录>/
├── config.json         设置页改的东西（可分享、可进版本控制）
├── secrets.json        凭据，权限 0600（QQ 号 / token，设置页只写不读）
├── bridge-config.json  给桥子进程的完整配置，0600（自动生成，不要手改）
├── state.json          宿主侧运行态
├── qr.png              最近一次登录二维码
├── compose.yaml        托管 NapCat 时自动生成
├── agent/
│   ├── persona/persona.md   人格文件
│   └── memory/              记忆库与语料（默认 stateDir）
│       ├── mem.db           情节 + 语义记忆（SQLite）
│       ├── digest.md        记忆摘要（按人分节）
│       ├── style-cases.jsonl 风格样本
│       ├── lexicon.json     学来的说话方式（词汇/梗/句式）
│       ├── corpus/          B 站评论语料池（可选）
│       ├── log/             入站消息语料（喂给 learn）
│       └── scheduler.json   定时任务上次跑的时间
├── state/              桥的运行态（会话映射、风格库等）
├── logs/
│   ├── bridge.out      桥的 stdout/stderr（设置页「运行」页读它）
│   └── bridge.log      桥自己的日志文件
├── .qq-media/          图片暂存（10 MB 上限）
└── bili-venv/          可选：B 站工具用的独立 Python 虚拟环境
```

**记忆现在就在 `<数据目录>/agent/memory/`**，不再单独放 `~/.dsh/llminqq/`。
旧版本的两个位置（`<数据目录>/memory/` 与 `~/.dsh/llminqq/`）会在插件加载时
自动**复制**迁移过来；迁移是幂等的，旧目录不删也不影响使用。
想换盘就改 `config.json` 里的 `memory.stateDir`（或设置页「高级 → 原始 JSON」）。

**为什么配置和凭据分开存**：`config.json` 是「可以发给别人求助」的那部分；
把 QQ 号和 token 混进去，会让一次求助变成泄密。所以凭据单独一个 0600 文件，
设置页**只写不读**（你填了新值它就存，页面上永远只显示「已设置」）。

---

## 4. 和旧版（脚本形态）的关系

早先这个项目是「一套脚本 + 几份手改配置」，那个形态不在本仓库里了。
插件不读旧脚本的配置，两者数据目录独立；需要保留旧聊天记忆的话，
按第 10 节末尾的命令手动迁移一次。

---

## 5. 已验证到什么程度

作者在真实 DSH 里跑过（临时 profile + 真 `dsh --profile web` 起在 3099 端口，
不碰生产实例）。当时的结果：

| 验证项 | 结果 |
|---|---|
| `dsh --dump-config` 能列出插件 | 通过 |
| `/dsh-plugin-llminqq/api/overview` | HTTP 200，Docker 探测到本机版本 |
| provider 枚举 | 拿到当前 profile 真实注册的 provider |
| 宿主当前模型识别 | 通过 |
| 保存配置 | HTTP 200，落盘正确 |
| 坏降级链被拒 | HTTP 400 + 具体错误（如「第 1 条：model 为空」） |
| 人设读写 | 读到骨架、写入生效 |
| client bundle 交付 | boot 清单包含插件，bundle 正确返回 |
| 设置分区注册 | bundle 内含 `settings.section` 注册 |

**没有替用户验证的部分**：真正扫码登录、桥连上真 QQ 收消息、模型真实回复。
那需要真实小号 + 启动容器，属于装完之后自己验的部分。

---

## 6. 三个设计上的坑（都是只有真跑才暴露的）

1. **`inject` 不能是空数组**
   cordis 的守卫：要读某个服务，必须先在 `inject` 里声明，否则
   `cannot get property "webServer" without inject`。
   用桩对象测不出来 —— 桩不实现这个守卫。

2. **`defineTool` 不是服务**
   它来自 `@deepseek-ai/dsh-tools` 包，不是 `ctx.get('defineTool')`。
   插件改成动态 `import` + try/catch，拿不到就按约定自己拼最小 definition ——
   工具是锦上添花，不能因为它缺失让设置页挂掉。

3. **client bundle 的路径要让加载器认得出**
   路径来自 `exports["./client"]`，且 `files` 清单要列对。
   现在固定在根目录 `client.js`（和 `dsh-expression` 同款）。

---

## 7. 装完看不到「QQ 通道」

按顺序查：

```bash
# 1. 插件进 profile 了吗（dump 里应该能搜到 dsh-plugin-llminqq）
dsh --profile web --dump-config | grep -i llminqq

# 2. 它真的注册进 bundles 了吗（看 dsh.profile.bundles 数组）
node -e "const o=require('os'),p=require('path'),f=require('fs');const j=JSON.parse(f.readFileSync(p.join(o.homedir(),'.dsh','profiles','web','package.json'),'utf8'));console.log(j.dsh?.profile?.bundles)"

# 3. 启动时有没有报错（看 stderr，不是 stdout）
dsh --profile web 2>&1 | grep -iE "llminqq|Failed plugins|waiting"
```

PowerShell 把管道末尾换成 `Select-String -Pattern "llminqq"` 即可。

「waiting for services」里如果出现它，说明某个 `inject` 的服务没加载
（比如没有 `webServer` 的服务端场景），设置页就不会出现，但插件本身不算失败。

---

## 8. 装完还是没出现？检查 bundles（真实踩过）

**`dsh plugin add` 只装包，不保证把它加进 `dsh.profile.bundles`。**
只有列在 `bundles` 里的包才会被当作 profile layer 加载。

实测复现：`dependencies` 里有、`node_modules` 里也有，但重启后
`dsh --dump-config` 里搜不到 —— 因为 `bundles` 数组里没有它。

`dsh plugin-manager` 里有一句 `if (beforeDeps.has(name)) continue`，
意味着 **remove 再 add 有可能不补进 bundles**（reconcile 会跳过已经出现过的名字）。

### 手动修（最稳）

编辑 `%USERPROFILE%\.dsh\profiles\web\package.json`
（macOS/Linux 是 `~/.dsh/profiles/web/package.json`；
设了 `DSH_HOME` 就是 `$DSH_HOME/profiles/web/package.json`）：

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

改完重启 dsh，刷新浏览器（Ctrl+F5）。不确定 bundles 里原有哪几项时，
先备份文件、只追加 `"dsh-plugin-llminqq"`，不要整段替换。

---

## 9. Windows 特有注意事项

### Docker Desktop

能用，但有两道坎：

1. **必须是 Docker Desktop**（不只是 docker CLI）。它提供 WSL2 后端，NapCat 容器跑在里面。
2. **文件共享白名单**：如果项目/数据目录在 `D:` 盘，要进
   Docker Desktop → Settings → Resources → File sharing 把 `D:` 加进去。
   否则挂载会报 `Path ... is not shared from the host`。
   插件会把这个错误翻译成人话提示。

首次「启动 QQ 容器」要拉 2 GB 以上的镜像，慢的话等几分钟。

### 桌面版 DSH 没有设置页

Web 版有、桌面版不一定有 —— 这是 DSH 宿主差异：`settings.section` 这个 slot
由 web 前端提供。桌面版如果没挂 `dsh-client-ui-settings`，插件注册不上就看不到。
插件本身没做区分（拿不到 slot 就静默跳过），不会报错。
桌面版的手动安装方式见 [DESKTOP.md](DESKTOP.md)。

---

## 10. 卸载（以及「为什么重装后记忆还在」）

```bash
dsh plugin --profile web remove dsh-plugin-llminqq
```

移除后**数据不会被删**，它们都在数据目录里（见第 3 节）。

**想彻底清理**：

bash：

```bash
rm -rf ~/.dsh/dsh-plugin-llminqq
```

PowerShell：

```powershell
Remove-Item -Recurse -Force "$env:USERPROFILE\.dsh\dsh-plugin-llminqq"
```

注意：删 `napcat/` 之后**要重新扫码登录**；删 `agent/memory/` 则**记忆清零、无法恢复** ——
删之前建议先去设置页「记忆」导出备份 zip。

**不删的话重装后记忆还在** —— 这是故意的：插件是「工具」，记忆是「你的东西」，
工具换了不该把东西扔掉。

### 从旧脚本形态迁移记忆

旧脚本版的记忆通常放在仓库外的 `qq-agent/memory/` 目录下。插件装好后手动迁一次
（把 `<插件安装目录>` 换成 `node_modules/dsh-plugin-llminqq` 的实际路径，
一般就是 `~/.dsh/profiles/web/node_modules/dsh-plugin-llminqq`）：

```bash
node "<插件安装目录>/lib/agent/memory-migrate.mjs" \
  --from "/path/to/LLMinQQ/qq-agent/memory"
```

默认目标就是插件当前的记忆 `stateDir`；要指定别的目录用 `--to <dir>`，
先看差异用 `--dry-run`，覆盖已有数据用 `--force`。

它会用 SQLite backup API（不是 `cp`，热拷会撕裂）拷库、校验条数，
并且会提示你先停掉旧脚本版（两边同时写会互相抢）。
如果本机既没有 Python 3 也没有 `sqlite3` 命令行，脚本会明确报错而不是退化成 `cp`。
