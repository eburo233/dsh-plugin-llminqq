import importlib.util, os, tempfile
spec = importlib.util.spec_from_file_location('m', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'memctl.py'))
m = importlib.util.module_from_spec(spec)
_tmpdir = tempfile.mkdtemp(prefix='memtest-')
m.DB = os.path.join(_tmpdir, 'mem.db')
m.LOG_DIR = os.path.join(_tmpdir, 'log')
m.CURSOR = os.path.join(_tmpdir, 'cursor')
m.DIGEST = os.path.join(_tmpdir, 'digest.md')
spec.loader.exec_module(m)
# 加载后再覆盖（模块加载时会把 DB 重设成生产路径）
_TMP2 = tempfile.mkdtemp(prefix='bm25test-')
m.DB = os.path.join(_TMP2, 'mem.db')
m.LOG_DIR = os.path.join(_TMP2, 'log')
m.CURSOR = os.path.join(_TMP2, 'cursor')
m.DIGEST = os.path.join(_TMP2, 'digest.md')
os.makedirs(m.LOG_DIR, exist_ok=True)
m.invalidate_bm25()

_PROD = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'mem.db')
assert os.path.abspath(m.DB) != os.path.abspath(_PROD), "测试必须隔离，不能连生产库！"
conn = m.connect(m.DB)
pass_, fail = 0, 0
def ok(n, c, d=''):
    global pass_, fail
    if c: pass_ += 1; print('  ✓', n)
    else: fail += 1; print('  ✗', n, ('— '+str(d)) if d else '')

print('=== 1. BM25Index 基础：词频保留、文档长度 ===')
idx = m.BM25Index([(1, '今天开会'), (2, '开会明天开会')])
ok('tf 保留重复次数', idx.tf[2]['开会'] == 2, idx.tf[2])
# '开会明天开会' 的 bigram = 开会/会明/明天/天开/开会 = 5 个词位
ok('dl 是含重复词数', idx.dl[2] == 5, idx.dl)
ok('df 统计文档数', idx.df['开会'] == 2)
ok('avgdl 正确', abs(idx.avgdl - (3 + 5) / 2) < 1e-9, idx.avgdl)

print('\n=== 2. IDF 生效：低频词权重高 ===')
# 构造：文档1 含唯一高频词「是的」，文档2 含低频「同意」，两文档长度一致
docs = [(1, '是的 是的 是的 是的 是的 是的 是的 是的 是的 是的 是的 是的'),   # 高频词, 12次
        (2, '星期二 通过 一个 方案 电话 会议 同意 同意 安排 信息 原文 地方')]  # 低频词, 各词一次
idx2 = m.BM25Index(docs)
idf_common = idx2.idf('是的')    # 只出现在 1 个文档
idf_rare = idx2.idf('同意')      # 只出现在 1 个文档
ok('两个词都在 1 个文档, 理论上同权', abs(idf_common - idf_rare) < 1e-9, (idf_common, idf_rare))
# 再构造有区分度的：同一词在不同的 df 下 IDF 不同
idx3 = m.BM25Index([(1, '开会'), (2, '开会'), (3, '开会'), (4, '撤回'), (5, '撤回'), (6, '撤回'), (7, '撤回'), (8, '撤回'), (9, '撤回'), (10, '开始')])
idf_t2 = idx3.idf('开会')    # df=3/10
idf_t5 = idx3.idf('撤回')    # df=6/10
idf_t1 = idx3.idf('开始')    # df=1/10
ok('df 越小 IDF 越大', idf_t1 > idf_t2 > idf_t5, (idf_t1, idf_t2, idf_t5))
ok('idf>0', idf_t1 > 0 and idf_t5 > 0)

print('\n=== 3. 归一化：同查询内最高分归一到 1，其余 <= 1 ===')
# ⚠️ BM25 的 b 参数会让「同样含查询词的短文档」得分更高（长度归一），
# 所以这里不能用「文档1一定最高」做断言 —— 那是我第一版写错的预期。
idxN = m.BM25Index([(1, '开会明天开会'), (2, '开会'), (3, '完全不相干的东西')])
sc = {i: idxN.score(i, {'开会'}) for i in (1, 2, 3)}
ok('含查询词的条目都在 (0,1]', 0 < sc[1] <= 1 and 0 < sc[2] <= 1, sc)
ok('最高分条目正好 = 1.0', max(sc[1], sc[2]) == 1.0, sc)
ok('零重合条目 = 0', sc[3] == 0.0, sc[3])
ok('短文档获得长度加成（b=0.75 的预期行为）', sc[2] == 1.0 and sc[1] < 1.0, sc)

print('\n=== 4. 归一化正确性：除以同一个 max 再 clamp ===')
idxM = m.BM25Index([(1, '开会开会开会开会'), (2, '开会'), (3, '开工开会'), (4, '天气不错'), (5, '开会吧')])
scores, mx = idxM._compute({'开会'})
# 归一化定义：score = raw / max，且 max 必须是本查询最高原始分
ok('max 等于最高原始分', mx == max(scores.values()), (mx, max(scores.values())))
ok('最高分条目 score = 1.0', max(idxM.score(i, {'开会'}) for i in scores) == 1.0)
for i, raw in scores.items():
    ok(f'#{i} 满足 raw/max 关系', abs(idxM.score(i, {'开会'}) - raw / mx) < 1e-12)
ok('全部归一值在 (0,1]', all(0 < v <= 1 for v in (idxM.score(i, {'开会'}) for i in scores)))

print('\n=== 5. relevance 函数：no-query 中性 0.5 / 空查询不崩 ===')
row = {'id': 1, 'text': '开会'}
ok('空 query → 0.5', m.relevance(row, None) == 0.5)
ok('空集合 query → 0.5', m.relevance(row, set()) == 0.5)
ok('token 与文档零重合 → 0', m.relevance({'id': 1, 'text': '睡觉'}, {'开会'}) == 0)

print('\n=== 6. recall 走 BM25：问什么答什么（至少不倒退） ===')
m.invalidate_bm25()
conn.execute("DELETE FROM entries"); conn.commit()
m.remember(conn, 'q', '规矩：只接信风的活', kind='procedural', pin=True)
m.remember(conn, 'q', '明天下午三点开会地点3楼', kind='procedural')
m.remember(conn, 'q', '你试试撤回一句', kind='procedural')
conn.commit()
for q, expect in [('开会', '开会'), ('撤回', '撤回'), ('信风', '信风')]:
    res = m.recall(conn, 'q', q, top=1)
    ok(f'query={q} → 命中「{expect}」', res and expect in res[0][1]['text'], res[0][1]['text'][:40] if res else '(无)')

print('\n=== 7. 索引缓存：语料变化自动失效 ===')
m.invalidate_bm25()
sig0 = m.bm25_signature(conn)
idx_a = m.bm25_index(conn)
ok('语料未变 → 复用同一个索引对象', idx_a is m.bm25_index(conn))
# 加一条记忆 → 未归档条数/max(id) 变化 → 指纹变
m.remember(conn, 'q', '新增一条记忆用于缓存失效测试', kind='episodic')
conn.commit()
sig1 = m.bm25_signature(conn)
ok('加条记忆后签名变化', sig0 != sig1, (sig0, sig1))
idx_b = m.bm25_index(conn)
ok('指纹变后重建（对象不同）', idx_b is not idx_a)
ok('重建后索引包含新条目', len(idx_b.tf) == len(idx_a.tf) + 1,
   (len(idx_a.tf), len(idx_b.tf)))

print('\n=== 8. 显式 invalidate 后重建 ===')
m.remember(conn, 'q', '再来一条', kind='episodic'); conn.commit()
before = m.bm25_index(conn)
m.invalidate_bm25()
after = m.bm25_index(conn)
ok('invalidate 强制重建', before is not after)

print('\n=== 9. 归档（prune/retired=1）后索引自动失效 ===')
m.invalidate_bm25()
a = m.remember(conn, 'arc', '这条记录专门用来测试归档后索引失效', kind='episodic')
m.remember(conn, 'arc', '另一条留着的记录', kind='episodic')
conn.commit()
idx_with = m.bm25_index(conn)
ok('归档前索引包含该条', a in idx_with.tf, a)
conn.execute("UPDATE entries SET retired=1 WHERE id=?", (a,)); conn.commit()
idx_after = m.bm25_index(conn)
ok('真实归档后索引重建', idx_after is not idx_with)
ok('归档条目从索引移除', a not in idx_after.tf, list(idx_after.tf)[:5])
got = [r['id'] for _, r in m.recall(conn, 'arc', '归档', top=10)]
ok('归档条目检索不到', a not in got, got)

print('\n=== 10. 无 query 路径：relevance 恒 0.5（与旧公式逐位一致）===')
row = {'id': 1, 'text': '随便什么内容', 'importance': 0.5, 'pinned': 0,
       'kind': 'episodic', 'strength': 1.0, 'last_seen': 1750000000.0}
AT_FIXED = 1750000100.0
sc_new = m.combine(row, None, at=AT_FIXED)
# 手算旧公式：0.6*0.5 + 0.25*0.5 + 0.15*recency
exp = 0.6 * 0.5 + 0.25 * 0.5 + 0.15 * m.recency(row, AT_FIXED)
ok('无 query combine 与手算一致', abs(sc_new - exp) < 1e-15, (sc_new, exp))

print('\n=== 11. 零重合折损 25% 规则保留 ===')
r_zz = {'id': 2, 'text': '完全不相关的内容', 'importance': 1.0, 'pinned': 0,
        'kind': 'episodic', 'strength': 1.0, 'last_seen': AT_FIXED}
cons = m.BM25Index([(2, '完全不相关的内容')])
s_zero = m.combine(r_zz, {'不存在的词zzz'}, at=AT_FIXED, index=cons)
# 精确期望：base = 0.6*0 + 0.25*1.0 + 0.15*recency，然后整条 *0.25
rec = m.recency(r_zz, AT_FIXED)
exp_zero = (0.60 * 0.0 + 0.25 * 1.0 + 0.15 * rec) * 0.25
ok('零重合精确折到 25%', abs(s_zero - exp_zero) < 1e-12, (s_zero, exp_zero))
r_hit = {'id': 3, 'text': '开会相关', 'importance': 1.0, 'pinned': 0,
         'kind': 'episodic', 'strength': 1.0, 'last_seen': AT_FIXED}
cons2 = m.BM25Index([(3, '开会相关')])
s_hit = m.combine(r_hit, {'开会'}, at=AT_FIXED, index=cons2)
ok('零重合分数 < 命中分数', s_zero < s_hit, (s_zero, s_hit))

print('\n=== 12. 生产库隔离确认 ===')
prod = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'mem.db')
path = conn.execute("PRAGMA database_list").fetchone()[2]
ok('测试连接指向临时库, 不是生产库', os.path.abspath(path) != os.path.abspath(prod), path)

print(f'\n结果: {pass_} 通过 / {fail} 失败')
import sys; sys.exit(0 if fail == 0 else 1)