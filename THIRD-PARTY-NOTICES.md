# 第三方代码与署名

本插件以 **MIT** 发布。包内含以下第三方代码，均保留原许可与版权行。

> 每个组件的机器可读版本信息在同目录的 `vendor-manifest.json`；
> 一键检查更新：`node scripts/vendor-check.mjs` / `node scripts/vendor-update.mjs <组件>`。
> 为什么要 vendor 而不是 npm install：见各组件的 `VENDORED.md`（两套机制不兼容 / 依赖树污染 / 内嵌无独立发布）。

---

## dsh-video-storyboard

- **上游**：https://github.com/SAOS-3624/dsh-video-storyboard
- **许可**：MIT，Copyright SAOS-3624（见 `vendor/dsh-video-storyboard/LICENSE`）
- **版本**：见 `vendor/dsh-video-storyboard/vendor-manifest.json`
- **用途**：看长视频 —— 把整片压成一张带编号+时间戳的宫格图（成本约一张图的 token）。
  配合 `video_probe` 先探测时长，再决定要不要跑宫格。
- **位置**：`vendor/dsh-video-storyboard/`
- **改动**：
  1. 删除 `src/index.js`（dsh 插件入口，依赖 `@deepseek-ai/dsh-tools`，本项目只当独立 CLI 用）
  2. 不带入 `cordis.patch.yml` / `dsh.plugin.json` / `docs/` / `scripts/` / `README.zh.md` /
     `README.en.md` / `CHANGELOG.md`（dsh 插件元数据与文档，运行不需要）
  3. `src/*`、`bin/*`、`package.json`、`README.md`、`LICENSE`、`CREDITS.md`、`NOTICE` **一行未改**
- **上游合规内容**：`CREDITS.md`（设计灵感来源清单）与 `NOTICE`（文档图片不随 MIT 授权）原样保留。

---

## bilibili-mcp

- **上游（宿主持有者）**：https://github.com/c1overzz/dsh-bili-scroll
  （`bilibili-mcp` 没有独立 npm 发布，是 `dsh-bili-scroll` 内嵌的 `vendor/bilibili-mcp/`）
- **原始作者**：**AGI_Ananas**
- **许可**：MIT，Copyright (c) 2026 AGI_Ananas（见 `vendor/bilibili-mcp/LICENSE`）
- **版本**：`embedded-in-dsh-bili-scroll@<x.y.z>`，见 `vendor/bilibili-mcp/vendor-manifest.json`
- **用途**：B站工具组 —— 搜索 / 字幕 / 评论 / 封面 / 视频帧等 20+ MCP 工具（Python MCP server）
- **位置**：`vendor/bilibili-mcp/`
- **改动**：**零**（原样复制）
- **不复制** `__pycache__`（Python 字节码缓存，跟解释器版本绑定，进包既变大又可能失效）

---

## 关于 `uvfetch.mjs`

**当前版本未采用**（本项目选择让用户/插件自行准备 Python 环境，见安装文档）。

如果将来引入 `dsh-bili-scroll` 的 `lib/uvfetch.mjs`（自动下载 uv，用户没 Python 时用），
需在此补充：

```
- 上游: https://github.com/c1overzz/dsh-bili-scroll
- 许可: MIT, Copyright c1overzz
- 用途: 自动下载 uv（用户没 python 时）
- 位置: lib/uvfetch.mjs
```

---

## lib/agent/memory/ —— vendored Python（本插件自带，非第三方包）

> ⚠️ 这一节的源码来自**本项目自己的脚本版**（`qq-agent/memory/`），
> 不是从上游项目 vendor 的，所以不在「第三方署名」范畴。
> 但它**相对脚本版有适配改动**，必须记录，否则「改动 vendor 行为」不透明。

- **来源**：本项目的脚本版 `qq-agent/memory/{memctl,lexicon,stylebank}.py` + `reflection_llm.mjs`
- **许可**：本项目自有（MIT）
- **位置**：`lib/agent/memory/`
- **改动（4 类，都是为了「能打包给别人用」）**：

| # | 改动 | 为什么 |
|---|---|---|
| 1 | **脱敏**：真实 QQ 号 `1000000001` → `1000000001`；「2026-10-26 实测事故」→「历史事故（本机个人实例）」；「吉祥物」→「机器人」 | 分享出去不泄露本机账号与使用史 |
| 2 | **去硬编码路径**：`BRIDGE_LOG` 从 `/home/<user>/dsh/LLMinQQ/logs/bridge.out` 改成 `<仓库根>/logs/bridge.out` + `LLMINQQ_BRIDGE_LOG` 环境变量覆盖 | 别人装到别的目录也能跑 |
| 3 | **生产库识别重构**：写死的 `_PROD_DIR_REAL` 改成 `.prod-guard` 哨兵文件 + `MEMCTL_PROD_DIR` 环境变量 | 同上：写死路径的另一种形式 |
| 4 | **新增 `run.py` launcher**（唯一新增文件）：import 包内代码，把 `BASE` 推导出的落盘路径常量改指 stateDir | **代码在包里（只读）、数据在 stateDir（可写）** 这两件事必须同时成立 |

**退休条件**：如果上游脚本版给这些路径加了环境变量支持，`run.py` 可以退休。

**验证方式**：`test/plugin-memory.test.mjs` 里有一条「vendored py 和脚本版逐字节一致」的断言，
但它比对的是**模板副本**（`.template-worktree/qq-agent/memory/`），不是主仓库。
模板副本与插件副本一致，而插件副本相对主仓库有上述 4 类改动 —— **这是有意为之，不是 bug**。

---

## 不是第三方代码的部分

以下内容是**本项目原创**，不在此声明范围内：

- `lib/`（桥、ACP 运行时、NapCat 探测、设置页后端）
- `client.js`（Web 端设置页）
- 插件对上述 vendor 组件的**接线层**（MCP server 包装脚本、启动自动追加配置等）——
  这些 wrapper 是我们自己写的，改动 vendor 行为的地方都在 wrapper 里，不改 vendor 源码。

---

## 升级时怎么维护这份文件

1. 跑 `node scripts/vendor-check.mjs` 看有没有新版
2. 跑 `node scripts/vendor-update.mjs <组件>` 更新（脚本会自动改 manifest 版本、跑测试、失败回滚）
3. **如果新版的 `adaptations` 有变化**（比如上游新增了需要删的文件），
   同步更新 `vendor-manifest.json` 的 `adaptations` 字段**和本文件对应条目**
4. 如果新增了第三方组件，在本文件加一节，并在 `vendor/<组件>/` 放
   `VENDORED.md` + `vendor-manifest.json`
