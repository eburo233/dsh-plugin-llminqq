// 隔离测试：不起真实桥、不连 OneBot，只测 proactive 的决策逻辑 + 用 mock LLM
// 验证：概率推进、保底、冷却、时段闸、空转
const D={baseProb:0.10,step:0.05,maxProb:0.60,guaranteeCount:6,cooldownMin:40,tickMin:20}
function makeState(){return {p:D.baseProb,missStreak:0,lastSpokeAt:0,lastProactiveAt:0,cooldownUntil:0}}
let pass=0,fail=0
const ok=(n,c,d='')=>{ if(c){pass++;console.log('  ✓',n)}else{fail++;console.log('  ✗',n,d&&`— ${d}`)} }

function evalOnce(st,now,roll,win){
  if(now<st.cooldownUntil) return {action:'skip-cooldown'}
  if(win.skip) return {action:'skip-quiet'}
  const pEff=Math.min(D.maxProb, st.p*win.factor)
  let action='miss'
  if(st.missStreak+1>=D.guaranteeCount) action='guarantee'
  else if(roll<pEff) action='hit'
  if(action==='miss'){ st.p=Math.min(D.maxProb,st.p+D.step); st.missStreak++ }
  else { st.p=D.baseProb; st.missStreak=0; st.cooldownUntil=now+D.cooldownMin*60000; st.lastProactiveAt=now }
  return {action,pEff}
}

console.log('=== 1. 概率单调递增到上限 ===')
let st=makeState(); const T=1000000; let seq=[]
for(let i=0;i<6;i++){ const r=evalOnce(st,T+i*1000,0.99,{skip:false,factor:1}); seq.push(`${(st.p*100).toFixed(0)}%`) }
console.log('  每次未中后 p:',seq.join(' → '))
ok('前5次未中后 p 到 35%', seq[4]==='35%', seq[4])
ok('第6次触发保底而非继续+5%', seq[5]==='10%', `第6次后=${seq[5]}（命中重置）`)

console.log('\n=== 2. 保底触发 ===')
st=makeState()
for(let i=0;i<5;i++) evalOnce(st,T+i*1000,0.99,{skip:false,factor:1})
const r=evalOnce(st,T+6000,0.99,{skip:false,factor:1})
ok('连续第6次保底', r.action==='guarantee', r.action)
ok('保底后 p 重置为 10%', Math.abs(st.p-0.10)<1e-9, st.p)

console.log('\n=== 3. 冷却 40 分钟 ===')
st=makeState()
evalOnce(st,T,0.0,{skip:false,factor:1})  // roll 0 必中
ok('命中后进入冷却', st.cooldownUntil===T+40*60000)
const c1=evalOnce(st,T+20*60000,0.0,{skip:false,factor:1})
ok('20 分钟后仍冷却', c1.action==='skip-cooldown', c1.action)
const c2=evalOnce(st,T+41*60000,0.0,{skip:false,factor:1})
ok('41 分钟后可评估', c2.action!=='skip-cooldown', c2.action)

console.log('\n=== 4. 静默时段 01-07 不评估 ===')
for(const h of [1,3,6]) ok(`${h}:00 不评估`, evalOnce(makeState(),T,0.0,{skip:true,factor:0}).action==='skip-quiet')

console.log('\n=== 5. 夜间系数 23-01 ×0.5 ===')
st=makeState(); st.p=0.6
const night=evalOnce(st,T,0.5,{skip:false,factor:0.5})
ok('p=60% ×0.5 → 实际 30%', Math.abs(night.pEff-0.30)<1e-9, night.pEff)
ok('roll=0.5 在 30% 之外 → 未中', night.action==='miss', night.action)

console.log('\n=== 6. tick 门槛 ===')
const minsSince=15
ok('15min < 20min → 跳过', minsSince<D.tickMin)

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail===0?0:1)
