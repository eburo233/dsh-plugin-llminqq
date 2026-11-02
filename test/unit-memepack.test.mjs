// test/unit-memepack.test.mjs —— 随包表情库落位（v2-4）
//
// 背景：脚本版自带 qq-agent/meme-pack（图片 + index.db 含义表），封装成插件时
// 只留下了 AGENTS.md 的一句话，图库本体漏搬 —— 模型被告知去 `meme-pack/memes/`
// 找图，那里却是空的。这个模块负责把随包图库放到 agent 工作区并建索引。
//
// 这个文件锁住四件事：
//   ① 首次落位：图片复制到 <agentDir>/meme-pack/memes/ 且 index.db 有行
//   ② 幂等：第二次调用不重拷、不重复插行（升级不能冲掉学到的表情）
//   ③ python 不可用：只降级告警，不抛异常（不能让插件起不来）
//   ④ 随包图库缺失：明确 ok:false + reason（不能静默当成功）

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { ensureMemePack, buildIndexDb, BUNDLED_PACK_REL, AGENT_PACK_REL } from '../lib/memepack.js'

function tmpDir (prefix = 'memepack-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** 造一个最小「随包图库」：2 张图 + meanings.json */
function makeBundledPack (root) {
  const pack = path.join(root, BUNDLED_PACK_REL)
  fs.mkdirSync(path.join(pack, 'memes', 'happy'), { recursive: true })
  fs.mkdirSync(path.join(pack, 'memes', 'sad'), { recursive: true })
  fs.writeFileSync(path.join(pack, 'memes', 'happy', 'a.jpg'), Buffer.from('fake-jpg-a'))
  fs.writeFileSync(path.join(pack, 'memes', 'sad', 'b.jpg'), Buffer.from('fake-jpg-b'))
  const meanings = [
    { path: 'memes/happy/a.jpg', tag: 'happy', file_name: 'a.jpg', caption: '开心', keywords: '开心 笑' },
    { path: 'memes/sad/b.jpg', tag: 'sad', file_name: 'b.jpg', caption: '难过', keywords: '难过 哭' },
  ]
  fs.writeFileSync(path.join(pack, 'meanings.json'), JSON.stringify(meanings), 'utf8')
  return pack
}

function countRows (dbPath) {
  const out = execFileSync('python3', ['-c',
    'import sys,sqlite3;print(sqlite3.connect(sys.argv[1]).execute("select count(*) from memes").fetchone()[0])',
    dbPath], { encoding: 'utf8' })
  return Number(String(out).trim())
}

test('首次落位：图片复制到工作区，index.db 建出 2 行', () => {
  const root = tmpDir()
  makeBundledPack(root)
  const agentDir = path.join(root, 'agent')
  fs.mkdirSync(agentDir, { recursive: true })

  const logs = []
  const r = ensureMemePack({ pluginRoot: root, agentDir, log: m => logs.push(m) })
  assert.equal(r.ok, true, `落位失败：${r.reason}`)
  const dst = path.join(agentDir, AGENT_PACK_REL)
  assert.equal(r.dir, dst)
  assert.ok(fs.existsSync(path.join(dst, 'memes', 'happy', 'a.jpg')), '图片没复制过去')
  assert.ok(fs.existsSync(path.join(dst, 'memes', 'sad', 'b.jpg')), '图片没复制过去')
  assert.ok(fs.existsSync(path.join(dst, 'index.db')), 'index.db 没建出来')
  assert.equal(countRows(path.join(dst, 'index.db')), 2)
  assert.ok(logs.some(l => l.includes('表情库就位')), '没有落位日志')
})

test('幂等：第二次调用不重拷、不重复插行', () => {
  const root = tmpDir()
  makeBundledPack(root)
  const agentDir = path.join(root, 'agent')
  fs.mkdirSync(agentDir, { recursive: true })
  ensureMemePack({ pluginRoot: root, agentDir, log: () => {} })
  const db = path.join(agentDir, AGENT_PACK_REL, 'index.db')
  const mtimeAfter1 = fs.statSync(path.join(agentDir, AGENT_PACK_REL, 'memes', 'happy', 'a.jpg')).mtimeMs

  const r2 = ensureMemePack({ pluginRoot: root, agentDir, log: () => {} })
  assert.equal(r2.ok, true)
  assert.equal(r2.copied, 0, '第二次不该再复制图片')
  assert.equal(r2.added, 0, '第二次不该再插行')
  assert.equal(countRows(db), 2, '行数变了（重复插入或丢了）')
  assert.equal(fs.statSync(path.join(agentDir, AGENT_PACK_REL, 'memes', 'happy', 'a.jpg')).mtimeMs, mtimeAfter1,
    '已有图片被覆盖了（升级会冲掉用户自己换的图）')
})

test('学到的表情不会被升级冲掉：已有行 + 新行共存', () => {
  const root = tmpDir()
  makeBundledPack(root)
  const agentDir = path.join(root, 'agent')
  fs.mkdirSync(agentDir, { recursive: true })
  ensureMemePack({ pluginRoot: root, agentDir, log: () => {} })
  const db = path.join(agentDir, AGENT_PACK_REL, 'index.db')
  // 模拟「agent 后来学了一张新图」
  const learned = path.join(agentDir, AGENT_PACK_REL, 'memes', 'happy', 'learned.jpg')
  fs.writeFileSync(learned, Buffer.from('learned'))
  execFileSync('python3', ['-c',
    'import sys,sqlite3;c=sqlite3.connect(sys.argv[1]);'
    + 'c.execute("insert into memes(path,tag,file_name,caption,keywords) values(?,?,?,?,?)",'
    + '("memes/happy/learned.jpg","happy","learned.jpg","学到的","新词"));c.commit()', db])

  const r = ensureMemePack({ pluginRoot: root, agentDir, log: () => {} })
  assert.equal(r.ok, true)
  assert.equal(countRows(db), 3, '升级后学到的表情行没了')
  assert.ok(fs.existsSync(learned), '学到的图片被删了')
})

test('python 不可用：只降级告警，不抛异常、图片照样复制', () => {
  const root = tmpDir()
  makeBundledPack(root)
  const agentDir = path.join(root, 'agent')
  fs.mkdirSync(agentDir, { recursive: true })
  const logs = []
  const r = ensureMemePack({
    pluginRoot: root, agentDir, pythonBin: '__definitely_not_a_python__', log: m => logs.push(m),
  })
  assert.equal(r.ok, false)
  assert.ok(String(r.reason).length > 0, '失败必须带 reason')
  assert.ok(fs.existsSync(path.join(agentDir, AGENT_PACK_REL, 'memes', 'happy', 'a.jpg')), '图片该照常复制')
  assert.ok(logs.some(l => l.includes('index.db 构建失败')), '没有降级告警')
})

test('随包图库缺失：ok:false + reason（不能静默当成功）', () => {
  const root = tmpDir()
  const agentDir = path.join(root, 'agent')
  fs.mkdirSync(agentDir, { recursive: true })
  const logs = []
  const r = ensureMemePack({ pluginRoot: root, agentDir, log: m => logs.push(m) })
  assert.equal(r.ok, false)
  assert.match(String(r.reason), /随包图库不存在/)
  assert.ok(logs.some(l => l.includes('随包表情库不存在')), '缺失时要有明确告警')
})

test('buildIndexDb：建 FTS 表并按 words 查询能命中', () => {
  const root = tmpDir()
  makeBundledPack(root)
  const pack = path.join(root, BUNDLED_PACK_REL)
  const db = path.join(root, 't.db')
  const r = buildIndexDb({ dbPath: db, meaningsPath: path.join(pack, 'meanings.json') })
  assert.equal(r.ok, true)
  assert.equal(r.after, 2)
  // FTS 能按关键词命中（skill / Web 面板搜索都依赖它）
  const hit = execFileSync('python3', ['-c',
    'import sys,sqlite3;c=sqlite3.connect(sys.argv[1]);'
    + 'print(c.execute("select count(*) from memes_fts where memes_fts match ?", (sys.argv[2],)).fetchone()[0])',
    db, '开心'], { encoding: 'utf8' })
  assert.equal(Number(String(hit).trim()), 1)
})
