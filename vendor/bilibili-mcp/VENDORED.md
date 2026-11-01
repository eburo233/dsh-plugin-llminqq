# VENDORED: bilibili-mcp

- **来源**：npm 包 `dsh-bili-scroll@2.3.0` 内嵌的 `vendor/bilibili-mcp/`（MIT）。
  复制后做了**少量本地适配**（见下面「本目录相对上游的改动」，
  每一条都是上游没有的，升级 vendor 时要重新打上）。
- **版本**：`embedded-in-dsh-bili-scroll@2.3.0`（升级时同步更新本行与 `vendor-manifest.json`）。
- **上游（宿主持有者）**：https://github.com/c1overzz/dsh-bili-scroll
- **原始作者**：**AGI_Ananas**（`bilibili-mcp`），`Copyright (c) 2026 AGI_Ananas`（见 `LICENSE`）

## 它是什么

一个 **Python MCP server**（`mcp_server.py`，约 59KB），提供 B站相关的 20+ 个 MCP 工具：
搜索、字幕、评论、封面、视频帧等。本项目把它挂在桥的 `mcpServers` 里，
让模型能直接调 `bili_search` / `bili_subtitle` / `bili_comments` / …

## 为什么它是 vendored rather than a dependency

它**没有独立的 npm 发布** —— 只作为 `dsh-bili-scroll` 的内部实现存在。
我们只需要那份 Python 源码，不需要 bili-scroll 的 Node 侧（扫描/排序/定时那些）。
所以从它的 `vendor/` 里把源码取出来放进本包。

## 本目录相对上游的改动

`requirements.txt` / `LICENSE` / `README.md` 原样未动。**`mcp_server.py` 有五处本地适配**
（都是 2026-11-01 用户实测/要求触发的，上游尚未合并）：

1. **`bili_frames` 帧数上限 6 → 200**（用户要求「上限顶格 200 帧，模型可以自己传」）。
   实际返回仍受 B站故事板格数限制 —— 实测一个 347 秒的视频只有 **43 格**。

2. **`bili_frames` 同格去重**。请求 200 帧而故事板只有 43 格时，按「时间最近」取
   会让多帧落到同一格；同一张 480×270 的图传多次，模型看不到任何新信息，
   只是白烧 token（每张 100-200 token，200 张就是 2-4 万）。
   现在同一个格子只给一张图，并在 `frames` 里如实反映「这一帧是故事板第几格」。

3. **`CRED_FILE` 优先读 `BILI_CREDENTIAL_PATH`**。原来硬编码 `<包目录>/bili_credential.json`，
   而插件下发的是 `~/.dsh/bili-duty/` 那份 → `load_credential()` 永远返回 None →
   `bili_subtitle` / `bili_comments` / `bili_reply` 全部退化成「未登录」。
   用户看到的表现是机器人说「视频没公开字幕」，其实有 86 段字幕读不到。

4. **`bili_subtitle` 保留时间戳**。原来只取 body 的 `content`，
   把 `from` / `to`（这句话在第几秒）扔了。现在新增 `timedText`（`[0:06] 台词`）
   与 `segmentsWithTime`（`[{from,to,text}]`），原 `text` 不变。
   这是「字幕和宫格图对时间戳」的前提 —— 不做这个，图文只能靠猜。

5. **`transcribe` 完成后写待送达标记** `<stateDir>/transcribe-ready/<job_id>.json`
   （临时文件 + 原子替换）。原因：ASR 是后台异步任务，而模型这一轮说完就结束了 ——
   实测转写 09:52 成功（3574 字节，文件都在），但**没有任何人再取**，用户永远等不到
   「那个视频讲了什么」。桥下一轮扫这个目录，把结果注入上下文，然后打 `.sent` 标记。

⚠️ **升级 vendor 时，上面五处要重新打上**（上游还没有）。

⚠️ **不复制 `__pycache__`**：那是 Python 字节码缓存，跟 Python 版本和平台绑定，
进 npm 包既变大又可能失效（换 Python 版本会读到不匹配的 .pyc）。首次运行自动生成即可。

## 运行依赖

Python 3 + `requirements.txt` 里的依赖。本项目**不在 npm 包里带 venv**
（太重，且跟平台绑定），而是在首次使用时由插件自动建 venv（见插件设置页 / 安装文档）。

## 一键检查 / 一键更新

```bash
# 在插件包根目录（packages/dsh-plugin-llminqq/）
node scripts/vendor-check.mjs bilibili-mcp    # 查宿主 dsh-bili-scroll 有没有新版
node scripts/vendor-update.mjs bilibili-mcp   # 一键更新（自动跑测试，失败自动回滚）
```

注意它的版本比较基准是**宿主包的版本**（因为自己没有独立版本号）：
`vendor-check.mjs` 会去查 `dsh-bili-scroll` 的最新版，而不是查 `bilibili-mcp`（那不存在）。
