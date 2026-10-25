import importlib.util
spec=importlib.util.spec_from_file_location('m', __import__('os').path.join(__import__('os').path.dirname(__import__('os').path.abspath(__file__)),'memctl.py'))
m=importlib.util.module_from_spec(spec)
# 用临时库测试，绝不碰生产 mem.db
import os, tempfile
_tmpdir=tempfile.mkdtemp(prefix='memtest-')
m.DB=os.path.join(_tmpdir,'mem.db')
m.LOG_DIR=os.path.join(_tmpdir,'log')
m.CURSOR=os.path.join(_tmpdir,'cursor')
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
conn=m.connect(m.DB)
pass_,fail=0,0
def ok(n,c,d=''):
    global pass_,fail
    if c: pass_+=1; print('  ✓',n)
    else: fail+=1; print('  ✗',n,('— '+str(d)) if d else '')

print('=== 1. importance 有区分度 ===')
vals=[m.estimate_importance(t) for t in ['嗯','哈哈','我在开会','明天下午三点开会地点3楼','规矩：以后每次都要先问我']]
ok('单调递增（信息量越大越重要）', vals==sorted(vals), vals)
ok('纯语气 < 0.1', vals[0]<0.1, vals[0])
ok('规矩 > 0.6', vals[-1]>0.6, vals[-1])
ok('分布跨度 > 0.4', vals[-1]-vals[0]>0.4, round(vals[-1]-vals[0],2))

print('\n=== 2. 三层分类 ===')
ok('procedural', m.classify('记住以后每次都要先问我')=='procedural')
ok('semantic', m.classify('我住在杭州，养了只猫')=='semantic')
ok('episodic', m.classify('今天好累啊')=='episodic')

print('\n=== 3. pin：真规矩留、讨论过程挡 ===')
for t in ['那我以后给你正个咋样','已开启：proactive 已启动','我觉得这样挺好']:
    ok(f'拒绝: {t[:20]}', not m.is_pin(t))
for t in ['规矩：只接信风的活，别人一概不接','明天(2026-10-26)下午三点开会，地点3楼']:
    ok(f'接受: {t[:20]}', m.is_pin(t))

print('\n=== 4. 去重：同一句话重复记只算一条 ===')
# 用独立 peer，避免和别的用例互相污染
conn.execute("DELETE FROM entries WHERE peer='dup'"); conn.commit()
before=conn.execute("SELECT COUNT(*) FROM entries WHERE peer='dup'").fetchone()[0]
for i in range(3): m.remember(conn,'dup','明天下午三点开会地点3楼',kind='procedural')
conn.commit()
after=conn.execute("SELECT COUNT(*) FROM entries WHERE peer='dup'").fetchone()[0]
ok('重复说话只存一条', after-before==1, f'{before}→{after}')
hits=conn.execute("SELECT hits FROM entries WHERE peer='dup'").fetchone()[0]
ok('但 hits 累加到 3', hits==3, hits)

print('\n=== 5. 噪音不入库 ===')
for t in ['嗯','好','哈哈','？']:
    ok(f'拒绝噪音: {t}', m.remember(conn,'noise',t) is None)

print('\n=== 6. recall 问什么答什么 ===')
m.remember(conn,'q1','明天下午三点开会，地点3楼',kind='procedural',pin=True)
m.remember(conn,'q1','撤回要加 delete_msg 才行',kind='procedural')
m.remember(conn,'q1','我给你加个情绪系统',kind='episodic')
conn.commit()
for q,expect in [('开会','开会'),('撤回','撤回'),('情绪','情绪')]:
    res=m.recall(conn,'q1',q,top=1)
    ok(f'query={q} → 命中「{expect}」', res and expect in res[0][1]['text'], res[0][1]['text'][:30] if res else '(无)')

print('\n=== 7. 边界不崩 ===')
ok('空 query', len(m.recall(conn,'q1',None,top=2))>0)
ok('空字符串不崩', m.estimate_importance('')>=0)
ok('超长文本不崩', m.estimate_importance('啊'*5000)>=0)
ok('不存在的 peer 不崩', len(m.recall(conn,'nope'))==0)

print(f'\n结果: {pass_} 通过 / {fail} 失败')
import sys; sys.exit(0 if fail==0 else 1)
