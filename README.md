# dsh-plugin-llminqq

让 LLM 接管一个**真实 QQ 号** —— 作为标准 DSH 插件安装，带图形设置页。

## 装

```bash
dsh plugin --profile web add file:/path/to/packages/dsh-plugin-llminqq
```

装完在 **设置 → QQ 通道**。

## 三件套

| 部分 | 干什么 |
|---|---|
| `lib/index.js` | 宿主侧：HTTP API、agent 工具、拉起桥子进程 |
| `lib/bridge/` | 真正的 OneBot↔LLM 转发（独立进程，崩了不影响 DSH） |
| `client.js` | 设置页图形界面 |

## 为什么桥是独立子进程

1. 它要长连接 + 常驻，进程内一崩就把整个 DSH 带下去
2. 它的生命周期跟 QQ 登录绑定，跟「DSH 开没开」不是一回事
3. 改配置重启桥不用重启 DSH 本身

## 数据放哪

`~/.dsh/dsh-plugin-llminqq/`（可用 `DSH_HOME` 改）

```
config.json     设置页改的东西（可分享、可进版本控制）
secrets.json    凭据，0600（QQ 号 / token，绝不外泄）
agent/          persona/ + memory/
napcat/         容器数据卷（登录态在这）
logs/           bridge.out
```

配置和凭据**分开存**的理由：config.json 是「可以发给别人求助」的那部分，混进凭据会让求助变泄密。
