# 桌面版（Electron）能不能用这个插件？

> 结论先说：**能装，但要手动；设置页能不能出现取决于桌面端有没有 webServer。
> 桥本身一定能用（它不依赖 webServer）。**

---

## 1. 为什么 CLI 装不了 desktop

DSH 的 CLI 里有一条**硬保护**（`lib/bin.js:35`）：

```js
function rejectElectronProfile(program, profile) {
  if (profile.toLowerCase() === 'desktop')
    program.error('error: profile "desktop" is managed exclusively by the Electron application')
}
```

字面意思：`desktop` profile 归 Electron 应用独占管理，**命令行不许碰**。

所以 `dsh plugin --profile desktop add ...` 和 `dsh --profile desktop --dump-config`
都会直接报这个错、什么都不做。

> ⚠️ 这也解释了一个容易误判的现象：如果你跑
> `dsh --profile desktop --dump-config | findstr /i "webserver ui-settings"`
> 看不到任何输出，**不是因为 desktop 里没有 webserver**，而是因为这条命令
> 一开头就报错退出了，错误信息里不含那两个词，被 findstr 过滤掉了。

---

## 2. 手动装（唯一可行的路）

桌面端自己会读 `~/.dsh/profiles/desktop/` 下的 `package.json` 和 `node_modules`，
所以**手动改这两处**是可行的 —— 只要 Electron 不去重写它。

### 第 1 步：把插件拷进 desktop 的 node_modules

在 PowerShell 里（`$env:USERPROFILE` 就是 `C:\Users\<你>`）：

```powershell
$src  = "D:\DSH-WORKSPACE\LLMinQQ\dsh-plugin-llminqq"
$dst  = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-plugin-llminqq"

New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item -Recurse -Force "$src\*" $dst
```

### 第 2 步：把插件名加进 bundles

先看一眼现有内容：

```powershell
Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\package.json"
```

然后在 `dsh.profile.bundles` 数组末尾加一项 `"dsh-plugin-llminqq"`。
用这段 PowerShell 自动加（会先备份）：

```powershell
$f = "$env:USERPROFILE\.dsh\profiles\desktop\package.json"
Copy-Item $f "$f.bak" -Force
$j = Get-Content $f -Raw | ConvertFrom-Json

# 确保结构存在
if (-not $j.dsh) { $j | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) }
if (-not $j.dsh.profile) { $j.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) }
if (-not $j.dsh.profile.bundles) { $j.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue @() }

# 去重后加入
$bundles = @($j.dsh.profile.bundles | Where-Object { $_ -ne 'dsh-plugin-llminqq' })
$bundles += 'dsh-plugin-llminqq'
$j.dsh.profile.bundles = $bundles

$j | ConvertTo-Json -Depth 20 | Set-Content $f -Encoding UTF8
Get-Content $f -Raw
```

### 第 3 步：重启桌面端

关掉桌面应用再开（不是关窗口，要退进程）。

---

## 3. 装完怎么判断成没成

桌面端有自己的控制台 / 日志。找它的 stdout，看有没有这两类行：

**成功**会打（插件自己的日志）：
```
[llminqq] 设置页 API 已挂载
[llminqq] 已加载，数据目录 C:\Users\你\.dsh\dsh-plugin-llminqq
```

**没有 webServer** 会打：
```
[llminqq] webServer 不可用，设置页不挂载（工具与其他功能不受影响）
```

后者说明：插件加载了、桥能用，但界面出不来。这时可以：

1. **去 Web 端配**（`dsh --profile web`），配置文件是同一个数据目录
2. 或者直接手改 `%USERPROFILE%\.dsh\dsh-plugin-llminqq\config.json`

---

## 4. 关于「web 里看不到桌面端装的插件」

这是**设计如此**，不是 bug。

每个 profile 是独立的 Node 项目：

```
~/.dsh/profiles/web/package.json      ← web 的插件清单
~/.dsh/profiles/desktop/package.json  ← 桌面端的插件清单
~/.dsh/profiles/web/node_modules/     ← web 自己的依赖
~/.dsh/profiles/desktop/node_modules/
```

两边的 `bundles`、`node_modules`、模型 provider **完全不共享**。
所以在 web 里配的 provider，桌面端不会知道，反之亦然。

**插件自己的数据目录倒是共享的**（都是 `~/.dsh/dsh-plugin-llminqq/`），
所以 QQ 号、token、人格、记忆在这些 profile 之间是同一份。

---

## 5. 为什么 provider 列表可能两边不一样

插件枚举 provider 用的是**宿主 llm 服务**（`ctx.llm.listProviders()`），
只返回「当前这个 profile 里真正注册了 adapter 的」那些。

- web profile 装了 `dsh-our-free-model` → 能看到 `trae` / `qodercn` / `our-free-model` 等 17 个
- desktop profile 没装 → 只能看到 `deepseek-official` 这种官方自带的

**这不是插件的问题，是那个 profile 没装对应插件。**

想在桌面端也能用 thosefree providers，就在 desktop profile 里也装一份：

```powershell
# 手动装（CLI 被禁）—— 同第 2 步的思路，但装的是 dsh-our-free-model
# 或者更简单：从 web profile 的 node_modules 里拷过去
Copy-Item -Recurse -Force `
  "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-our-free-model" `
  "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\"
```
然后把 `"dsh-our-free-model"` 加进 desktop 的 bundles。
