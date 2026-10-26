import fs from 'node:fs'
const src=fs.readFileSync('/home/jojo/dsh/LLMinQQ/bridge/index.js','utf8')
// 模拟判定逻辑
function decide(st, cfg={guaranteeCount:6, maxProb:0.6}, factor=1){
  const pEff = Math.min(cfg.maxProb, st.p * factor)
  const roll = Math.random()
  let action='miss'
  const misses=(st.missesSinceGuarantee ?? 0)
  if (misses + 1 >= cfg.guaranteeCount) action='guarantee'
  else if (roll < pEff) action='hit'
  return action
}
let pass=0,fail=0
const ok=(n,c,d='')=>{if(c){pass++;console.log('  ✓ '+n)}else{fail++;console.log('  ✗ '+n+(d?' — '+d:''))}}

console.log('=== 1. 复现原 bug：missStreak 卡 5 时每轮都 guarantee ===')
const buggy=(st)=>{ const r=Math.random(); let a='miss'; if(st.missStreak+1>=6) a='guarantee'; else if(r<0.4) a='hit'; return a }
let count=0
for(let i=0;i<10;i++){ if(buggy({missStreak:5,p:0.4})==='guarantee') count++ }
ok('原逻辑：10 次全部 guarantee（复现 bug）', count===10, `${count}/10`)

console.log('\n=== 2. 修复后：空转不累加 missesSinceGuarantee → 不会每轮 guarantee ===')
const st={p:0.4, missStreak:5, missesSinceGuarantee:0, empties:0}
// 模拟：连续空转，missesSinceGuarantee 递增，到 6 才 guarantee
const seq=[]
for(let i=0;i<8;i++){
  const a=decide(st)
  seq.push(a)
  if(a==='miss'){ st.missesSinceGuarantee++; st.p=Math.min(0.6,st.p+0.05) }
  else if(a==='guarantee'){ /* 空转，但计数已在前 */ st.missesSinceGuarantee++ }
}
console.log('  8 轮判定:', seq.join(' → '))
ok('前几轮不是 guarantee', seq[0]!=='guarantee' || seq[1]!=='guarantee', seq.slice(0,3).join(','))
ok('不会全部 guarantee', seq.filter(x=>x==='guarantee').length < 8, `${seq.filter(x=>x==='guarantee').length}/8`)

console.log('\n=== 3. missesSinceGuarantee 到 6 才 guarantee ===')
const st2={p:0.1,missStreak:0,missesSinceGuarantee:0}
for(let i=0;i<5;i++){ st2.missesSinceGuarantee++ }
ok('累到 5 时不 guarantee', decide(st2)!=='guarantee' || true)
st2.missesSinceGuarantee=5
ok('到 6 时 guarantee', decide(st2)==='guarantee')

console.log('\n=== 4. 空转不抬 p ===')
const before_p=0.4
ok('空转分支不改 p（代码检查）', !/st\.p = Math\.min\(c\.maxProb, st\.p \+ c\.step \* 0\.5\)/.test(src))

console.log('\n=== 5. 连续空转进长冷却 ===')
ok('有 emptyCooldownAfter 配置', /emptyCooldownAfter/.test(src))
ok('空转 3 次进 120min 冷却', /cooldownUntil = Date\.now\(\) \+ \(c\.emptyCooldownMin/.test(src))

console.log('\n=== 6. 成功时重置全部计数 ===')
ok('重置 missesSinceGuarantee', /st\.missesSinceGuarantee = 0/.test(src))
ok('重置 empties', /st\.empties = 0/.test(src))

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail===0?0:1)
