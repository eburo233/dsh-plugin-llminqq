#!/usr/bin/env python3
"""P0-1 补充的探针：验证 _fallback_summaries 的分桶随 PYTHONHASHSEED 翻转。

用法（在仓库根跑）：
    for seed in 0 1 2 3 4 5; do PYTHONHASHSEED=$seed python3 scripts/_seedprobe.py; done

预期：一半种子 created=1 且 reflected 被标 3/3，另一半 created=0 且 3/3 全不被标。
"""
import os
import sqlite3
import sys
import time

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'lib', 'agent', 'memory'))

import memctl as m  # noqa: E402

c = sqlite3.connect(':memory:')
c.row_factory = sqlite3.Row
c.executescript('''
CREATE TABLE entries (
  id INTEGER PRIMARY KEY, peer TEXT, kind TEXT, text TEXT, fp TEXT,
  importance REAL DEFAULT .5, strength REAL DEFAULT 1.0, pinned INTEGER DEFAULT 0,
  hits INTEGER DEFAULT 1, created REAL, last_seen REAL, retired INTEGER DEFAULT 0,
  reflected INTEGER DEFAULT 0, owner TEXT, visibility TEXT, is_self INTEGER DEFAULT 0
)''')
now = time.time()
for text, imp in [('记住以后每晚十点提醒我睡觉', .8),
                  ('记住以后别在群里叫我真名', .8),
                  ('哈哈哈', .02)]:
    c.execute('INSERT INTO entries(peer,kind,text,fp,importance,created,last_seen) VALUES(?,?,?,?,?,?,?)',
              ('c2c-900', 'episodic', text, m.fp(text), imp, now, now))

res = m.reflect(c, 'c2c-900', hours=168, use_llm=True, timeout=5)
marked = c.execute('select count(*) from entries where reflected=1').fetchone()[0]
print('SEED=%-3s created=%d skipped=%s reflected被标=%d/3'
      % (os.environ.get('PYTHONHASHSEED', '?'), res['created'], res.get('skipped'), marked))
