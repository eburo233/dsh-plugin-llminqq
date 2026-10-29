# VENDORED: dsh-video-storyboard

- **来源**：npm 包 `dsh-video-storyboard@0.4.4`（MIT，作者 SAOS-3624）。
  本地由上游 `npm pack` 解包到 `/tmp/sb-eval/package`，再原样复制进来。
- **版本**：0.4.4（与 `package.json` 一致；升级时同步更新本行）。
- **上游仓库**：https://github.com/SAOS-3624/dsh-video-storyboard

## 为什么 vendor 而不是 npm install

它是 **dsh cordis 插件**（`peerDependencies: @deepseek-ai/dsh-tools`）。本仓库的 QQ 桥
走 ACP 协议挂 MCP（`bridge/acp.js` 的 `session/new mcpServers`），两套机制不兼容：

- `npm install` 会把 dsh-tools 的 peer 依赖图拖进来，污染本项目依赖树；
- 它作为 dsh 插件的注册入口（原 `src/index.js`）在本项目**完全用不上**——
  我们只把它当**独立 CLI** 用（`bin/storyboard.mjs`），逻辑全在 `src/pipeline.js`，
  经核实 `src/*` + `bin/*` **零 dsh import**（仅注释提及）。

## 本目录相对上游的改动（除删除外零改动）

1. **删除** `src/index.js`（dsh 插件入口，依赖 dsh-tools，本项目不用）。
   删前核实：它是叶子模块，CLI 链路（`bin/*.mjs`）不 import 它。
2. **不带入**上游的 `cordis.patch.yml`、`dsh.plugin.json`、`docs/`、`scripts/`、
   `README.zh.md`、`README.en.md`、`CHANGELOG.md`（dsh 插件元数据与文档，运行不需要）。
3. `src/*`、`bin/*`、`package.json`、`README.md`、`LICENSE`、`CREDITS.md`、`NOTICE`
   **一行未改**。要适配（路径、超时、输出格式）一律在我们自己的
   `scripts/storyboard-mcp.mjs`（wrapper）里做，不改 vendored 源码。

## 怎么用

```bash
node vendor/dsh-video-storyboard/bin/storyboard.mjs <video-or-url> --cells 6 \
  --out /tmp/x.png --manifest /tmp/x.json
```

依赖：`ffmpeg` / `ffprobe` 在 PATH（本机 6.1.1，已验证）；Node ≥ 20。

## 一键检查 / 一键更新（插件包内，2026-10-29 新增）

本目录随 npm 插件分发，所以除了上面的手工步骤，还有机器可读的版本声明和一键脚本：

```bash
# 在插件包根目录（packages/dsh-plugin-llminqq/）
node scripts/vendor-check.mjs            # 检查全部第三方组件有没有新版
node scripts/vendor-check.mjs storyboard # 只查这一个
node scripts/vendor-update.mjs storyboard  # 一键更新（自动跑测试，失败自动回滚）
```

版本事实源是 `vendor-manifest.json`（机器可读），本文件（VENDORED.md）是给人看的说明。
两者版本号必须一致 —— `scripts/vendor-check.mjs` 会校验这一点。

## 怎么升级

1. `npm pack dsh-video-storyboard@<新版本>`，解包到临时目录；
2. 确认新版的 `src/*`、`bin/*` 仍零 dsh 硬依赖（`grep -rn "@deepseek" src/ bin/`，
   命中应只有注释）；确认 `src/index.js` 仍是叶子模块后删除；
3. 原样替换本目录的 `src/`、`bin/`、`package.json`、`README.md`、`LICENSE`、
   `CREDITS.md`、`NOTICE`，重跑 `node test/storyboard-mcp.test.mjs`；
4. 更新本文件的「版本」行，再提交。

## 运行时产物

storyboard 每次调用产出宫格图 + manifest JSON。本项目的 MCP wrapper
（`scripts/storyboard-mcp.mjs`）把这些产物固定落在 `STORYBOARD_DIR`
（默认 `<repo根>/.qq-media/storyboard/`，可用 `STORYBOARD_DIR` 环境变量覆盖），
该目录在桥的 `[SEND_FILE]` 允许根（`bridge/index.js isPathAllowedForSend`）之内，
模型可以直接把图发进 QQ；prune（24h / 300 文件）由桥对 staging 根统一负责，
wrapper 自身只做单次调用内的失败清理。
