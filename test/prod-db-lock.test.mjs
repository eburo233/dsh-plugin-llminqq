// 生产库写锁测试：开发和测试绝不能写生产 mem.db
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const MEMCTL = path.join(ROOT, 'qq-agent/memory/memctl.py')
const PROD_DB = path.join(ROOT, 'qq-agent/memory/mem.db')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-'))

let pass = 0, fail = 0
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  ✓ ' + n) } else { fail++; console.log('  ✗ ' + n + (d ? ' — ' + d : '')) } }

const run = (code, env = {}) => execFileSync('python3', ['-c', code], {
  encoding: 'utf8', timeout: 30000,
  env: { ...process.env, ...env },
})

const py = (db, extra = '') => `
import importlib.util, sys
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('m', ${JSON.stringify(MEMCTL)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
try:
    conn = m.connect(${JSON.stringify(db)})
    ${extra || "conn.execute('SELECT 1')"}
    print('ALLOWED')
except PermissionError as e:
    print('DENIED')
except Exception as e:
    print('OTHER:' + type(e).__name__ + ':' + str(e)[:80])
`

console.log('=== 1. 写生产库：没有 MEMCTL_PROD → 必须拒绝 ===')
{
  const out = run(py(PROD_DB)).trim()
  ok('无环境变量连生产库 → DENIED', out === 'DENIED', out)
}

console.log('\n=== 2. 生产进程（MEMCTL_PROD=1）→ 必须允许 ===')
{
  const out = run(py(PROD_DB), { MEMCTL_PROD: '1' }).trim()
  ok('有 MEMCTL_PROD=1 → ALLOWED', out === 'ALLOWED', out)
}

console.log('\n=== 3. 副本库 → 永远允许（不管环境变量）===')
{
  const copy = path.join(TMP, 'copy.db')
  fs.copyFileSync(PROD_DB, copy)
  const out = run(py(copy)).trim()
  ok('主体逻辑：副本不需要环境变量', out === 'ALLOWED', out)
}

console.log('\n=== 4. 只读模式连生产库 → 允许（桥只读场景）===')
{
  const code = py(PROD_DB).replace('m.connect(', 'm.connect(').replace(
    `conn = m.connect(${JSON.stringify(PROD_DB)})`,
    `conn = m.connect(${JSON.stringify(PROD_DB)}, read_only=True)`)
  const out = run(code).trim()
  ok('read_only=True 连生产库 → ALLOWED', out === 'ALLOWED', out)
}

console.log('\n=== 5. 只读连接真的写不了（不是假只读）===')
{
  const code = `
import importlib.util, sys
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('m', ${JSON.stringify(MEMCTL)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
conn = m.connect(${JSON.stringify(PROD_DB)}, read_only=True)
try:
    conn.execute("UPDATE entries SET hits=hits WHERE id=1")
    print('WRITABLE')
except Exception as e:
    print('READONLY')
`
  const out = run(code).trim()
  ok('只读连接写库 → 报错（真只读）', out === 'READONLY', out)
}

console.log('\n=== 6. 生产库内容没被本测试改动 ===')
{
  const before = fs.statSync(PROD_DB)
  run(py(path.join(TMP, 'copy.db')), {})
  const after = fs.statSync(PROD_DB)
  ok('生产库 mtime+size 未变', before.mtimeMs === after.mtimeMs && before.size === after.size,
    `${before.mtimeMs} vs ${after.mtimeMs}`)
}

console.log('\n=== 7. 错误信息足够指导（含副本建议）===')
{
  const code = `
import importlib.util, sys
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('m', ${JSON.stringify(MEMCTL)})
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
try:
    m.connect(${JSON.stringify(PROD_DB)})
except PermissionError as e:
    print(str(e))
`
  const msg = run(code)
  ok('提示里有「副本」指导', msg.includes('副本'), msg.slice(0, 60))
  ok('提示里有环境变量说明', msg.includes('MEMCTL_PROD'), msg.slice(0, 60))
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
