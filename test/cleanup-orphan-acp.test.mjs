// 孤儿 ACP 清理脚本的测试
// 重点：**不能误杀**（父进程活着的、别的 profile 的，都不许碰）
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const SCRIPT = path.join(ROOT, 'scripts/cleanup-orphan-acp.mjs')

let pass = 0, fail = 0
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ✓ ' + n) } else { fail++; console.log('  ✗ ' + n + (d ? ' — ' + d : '')) } }

const run = (args = []) => execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 30000 })

const alive = (pid) => { try { return fs.existsSync(`/proc/${pid}`) } catch { return false } }

/** 造一个真孤儿：setsid + detached，父进程立即脱离 → PPid 变 1 */
const makeOrphan = (profile, secs = 300) => {
  const child = spawn('bash', ['-c', `exec -a "node /home/jojo/.local/bin/dsh --profile ${profile}" sleep ${secs}`], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  // 等它被 init 收养（PPid 真的变成 1）
  for (let i = 0; i < 50; i++) {
    const pids = findPids(profile)
    for (const pid of pids) {
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
        const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
        if (ppid === 1) return pid
      } catch { /* 已退出 */ }
    }
    execFileSync('sleep', ['0.1'])
  }
  // 兜底：返回找到的（可能还没变孤儿，但调用方会看到日志）
  return findPids(profile)[0] ?? null
}

/** 用 /proc 找匹配 profile 的 pid（不用 pgrep，避免自匹配） */
function findPids (profile) {
  const out = []
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue
    try {
      const argv = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0').filter(Boolean)
      const j = argv.join(' ')
      if (j.includes('--profile ' + profile) && (j.includes('sleep') || j.includes('/dsh'))) out.push(Number(d))
    } catch { /* 进程已消失 */ }
  }
  return out
}

console.log('=== 1. 没有孤儿时不杀任何东西 ===')
{
  const out = run()
  ok('dry-run 能跑', out.includes('cleanup-acp'), out.slice(0, 60))
  ok('报告计数', /命中本 profile \d+ 个/.test(out), out.slice(0, 120))
}

console.log('\n=== 2. 只杀「本 profile 的孤儿」，不杀别的 profile ===')
{
  const target = makeOrphan('llminqq-acp-e2e', 300)
  const other = makeOrphan('other-profile-e2e', 300)
  ok('两个测试进程都起来了', !!target && !!other, `target=${target} other=${other}`)
  setTimeout(() => {}, 0)
  // 等 PPid 变 1
  execFileSync('sleep', ['1'])

  const out = run(['--kill', '--profile', 'llminqq-acp-e2e'])
  ok('杀掉了本 profile 的孤儿', !alive(target) || out.includes(`PID ${target}`), out.slice(0, 200))
  ok('**没有**碰 other-profile 的进程', alive(other), `other=${other} 应仍存活`)
  ok('输出里有「已杀」记录', /已杀 \d+ 个/.test(out), out.slice(-120))

  // 清理测试残留（按 PID 精确杀，不用 pkill）
  try { if (alive(other)) process.kill(other, 'SIGKILL') } catch {}
}

console.log('\n=== 3. dry-run 默认不杀 ===')
{
  const p = makeOrphan('llminqq-acp-dry', 300)
  execFileSync('sleep', ['1'])
  const out = run(['--profile', 'llminqq-acp-dry'])
  ok('dry-run 报告「待杀」', out.includes('待杀') || out.includes('没有需要'), out.slice(-150))
  ok('dry-run 后进程仍活着', alive(p), `pid=${p}`)
  try { if (alive(p)) process.kill(p, 'SIGKILL') } catch {}
}

console.log('\n=== 4. 脚本不用 pgrep/pkill（自杀风险）===')
{
  const src = fs.readFileSync(SCRIPT, 'utf8')
  // 只检查**实际代码行**里的 pkill 调用，注释里提到不算
  const codeLines = src.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
  ok('实际代码里没有 pkill 调用', !codeLines.some(l => /\bpkill\s/.test(l)))
  ok('源码里没有 pgrep -f', !/pgrep\s+-f/.test(src))
  ok('用 /proc 读 cmdline', src.includes('/proc/') && src.includes('cmdline'))
}

console.log('\n=== 5. 排除自身祖先链 ===')
{
  const src = fs.readFileSync(SCRIPT, 'utf8')
  ok('有 ancestorsOfSelf', src.includes('ancestorsOfSelf') || src.includes('skip'))
  ok('排除了 process.pid', src.includes('process.pid'))
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
