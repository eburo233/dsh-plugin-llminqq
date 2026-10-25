import importlib.util, os, tempfile
_HERE = os.path.dirname(os.path.abspath(__file__))
spec=importlib.util.spec_from_file_location('m', os.path.join(_HERE, 'memctl.py'))
m=importlib.util.module_from_spec(spec)
tmp=tempfile.mkdtemp()
m.DB=os.path.join(tmp,'mem.db'); m.LOG_DIR=os.path.join(tmp,'log'); m.CURSOR=os.path.join(tmp,'cursor')
spec.loader.exec_module(m)

# ⚠️ 必须在 exec_module **之后**再覆盖：模块加载时会把 DB 重设成生产路径。
_TMPDIR = tempfile.mkdtemp(prefix="memtest-isolated-")
m.DB = os.path.join(_TMPDIR, "mem.db")
m.LOG_DIR = os.path.join(_TMPDIR, "log")
m.CURSOR = os.path.join(_TMPDIR, "cursor")
m.DIGEST = os.path.join(_TMPDIR, "digest.md")
os.makedirs(m.LOG_DIR, exist_ok=True)
_PROD = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mem.db")
assert os.path.abspath(m.DB) != os.path.abspath(_PROD), "测试必须隔离，不能连生产库！"

pass_, fail_ = 0, 0
def ok(n, c, d=''):
    global pass_, fail_
    if c:
        pass_ += 1; print('  ✓', n)
    else:
        fail_ += 1; print('  ✗', n, ('— ' + str(d)) if d else '')

# 造一份模拟日志
log=os.path.join(tmp,'bridge.out')
open(log,'w',encoding='utf-8').write('''2026-10-25T12:00:00.000Z 入站 c2c:3022464706 from=信风(3022464706) text="记住，以后每次回我都短一点" images=0
2026-10-25T12:00:03.000Z 出站 c2c:3022464706 text="行，记住了" chars=6
2026-10-25T12:00:10.000Z 入站 c2c:3022464706 from=信风(3022464706) text="明天下午三点开会地点3楼" images=0
2026-10-25T12:00:12.000Z 出站 c2c:3022464706 text="好，我记下了，明天三点三楼" chars=13
2026-10-25T12:00:20.000Z 入站 c2c:3022464706 from=信风(3022464706) text="嗯" images=0
''')
conn=m.connect(m.DB)
n=m.ingest_bridge(conn,log)
print(f'入库 {n} 条（噪音"嗯"应被挡）')
print()
for r in conn.execute("SELECT kind,pinned,importance,text FROM entries ORDER BY id"):
    print(f'  [{r[0]:11}] pin={r[1]} imp={r[2]:.2f} | {r[3]}')
print()
print('=== 关键：出站被降权了吗 ===')
inb=conn.execute("SELECT importance FROM entries WHERE text LIKE '记住，以后%'").fetchone()[0]
out=conn.execute("SELECT importance FROM entries WHERE text LIKE '行，记住了%'").fetchone()[0]
print(f'  对方说的「记住以后每次...」imp={inb:.2f}')
print(f'  我说的「行，记住了」      imp={out:.2f}  ← 应更低')
ok('出站被降权', out < inb, f'{out:.2f} vs {inb:.2f}')
print()
print('=== 出站不会被 pin ===')
pinned_out=conn.execute("SELECT COUNT(*) FROM entries WHERE pinned=1 AND text LIKE '好，我记下了%'").fetchone()[0]
ok('自己说的话不会变成规矩', pinned_out==0, str(pinned_out))

print(f'\n结果: {pass_} 通过 / {fail_} 失败')
import sys; sys.exit(0 if fail_ == 0 else 1)
