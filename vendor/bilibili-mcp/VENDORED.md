# VENDORED: bilibili-mcp

- **来源**：npm 包 `dsh-bili-scroll@2.3.0` 内嵌的 `vendor/bilibili-mcp/`（MIT）。
  原样复制，未做任何改动。
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

**零改动。** `mcp_server.py` / `requirements.txt` / `LICENSE` / `README.md` 全部原样。

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
