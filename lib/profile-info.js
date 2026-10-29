// 推断「当前插件跑在哪个 profile 里」—— 用于自动填 dsh.profile。
//
// 为什么需要（真实踩坑）：
//   桥启动 LLM 运行时用的是 `dsh --profile <name>`。这个 name 原来是空配置，
//   于是桥拼出 `dsh --profile  `（后面空），dsh 会用它自己的默认值 —— 但那个
//   默认值跟「当前桌面版跑的是哪个 profile」未必一致，结果启动超时。
//
//   而 profile 名其实**可以从插件自己所在路径反推**：
//     <dshHome>/profiles/<profileName>/node_modules/dsh-plugin-llminqq/lib
//                                                   ↑ 往上数就到 profileName
//   这比让用户手填可靠得多 —— 用户根本不知道自己跑在哪个 profile。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 从本模块路径反推 profile 名。
 * @returns {{ name: string|null, dshHome: string|null, how: string }}
 */
export function detectProfileName () {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url))       // .../dsh-plugin-llminqq/lib
    const pkgRoot = path.dirname(here)                              // .../dsh-plugin-llminqq
    const nodeModules = path.dirname(pkgRoot)                       // .../node_modules
    const profileDir = path.dirname(nodeModules)                    // .../profiles/<name>
    const profilesDir = path.dirname(profileDir)                    // .../profiles
    if (path.basename(profilesDir) === 'profiles') {
      const name = path.basename(profileDir)
      const dshHome = path.dirname(profilesDir)
      if (fs.existsSync(path.join(profileDir, 'package.json'))) {
        return { name, dshHome, how: '从插件安装路径反推' }
      }
    }
  } catch { /* 忽略 */ }
  return { name: null, dshHome: null, how: '反推失败' }
}

// ── 桥该用哪个 profile 名 ────────────────────────────────────────────────
//
// 「反推出什么就传什么」是错的：插件装在 desktop profile 里时反推结果是
// `desktop`，而 DSH 的 CLI 对这个名字有硬保护（Electron 应用独占加载，
// 只走 loadProfileDirectory，不暴露给 CLI profile 查找）：
//   error: profile "desktop" is managed exclusively by the Electron application
// 进程直接 exit 1 —— 表现就是桥「预热失败」，QQ 那边一条消息都收不到回复。
//
// 桥要的是一个「纯自动化 ACP stdio」profile，DSH 随附的 `acp` 就是干这个的
// （bundles = dsh-base + dsh-acp-app，`dsh --profile acp` 首次使用自动创建）。

/** CLI 保留、不接受命令行传入的 profile 名（小写）。 */
const CLI_RESERVED_PROFILES = new Set(['desktop'])

/** 随附的自动化 ACP profile 名。 */
export const ACP_PROFILE_NAME = 'acp'

/**
 * 决定 `dsh --profile <name>` 里的 name。
 *
 * @param {string} [explicit] 设置页里手填的值（空 = 自动）
 * @returns {string} 永远返回一个非空、且不会被 CLI 拒绝的名字
 */
export function bridgeProfileName (explicit) {
  const want = String(explicit ?? '').trim()
  if (want) {
    if (CLI_RESERVED_PROFILES.has(want.toLowerCase())) return ACP_PROFILE_NAME
    return want
  }
  const detected = detectProfileName().name
  // 反推失败也别给空串 —— `dsh` 不带 --profile 会报「--profile <name> is required」
  if (!detected) return ACP_PROFILE_NAME
  return CLI_RESERVED_PROFILES.has(detected.toLowerCase()) ? ACP_PROFILE_NAME : detected
}

/** profile 的 package.json 路径（找不到返回 null）。 */
export function profileManifestPath (dshHome, profileName) {
  if (!dshHome || !profileName) return null
  const p = path.join(dshHome, 'profiles', profileName, 'package.json')
  return fs.existsSync(p) ? p : null
}
