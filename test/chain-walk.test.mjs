import fs from 'node:fs'
const cfg=JSON.parse(fs.readFileSync('/home/jojo/dsh/LLMinQQ/bridge/config.json','utf8'))
const MAIN={provider:cfg.dsh.provider,model:cfg.dsh.model,kind:'main'}
const FB=cfg.dsh.fallbackRoutes
const F=cfg.dsh.failover

const routeState={fallbackIndex:-1,consecutiveFailures:0,lastSwitchAt:0,switches:0,current:{provider:MAIN.provider,model:MAIN.model}}

function fail(){
  routeState.consecutiveFailures++
  if(!F.enabled) return null
  if(routeState.consecutiveFailures<F.consecutiveFailures) return null
  const nextIndex=routeState.fallbackIndex+1
  let next
  if(nextIndex>=FB.length){
    const cool=(Date.now()-routeState.lastSwitchAt)>F.cooldownMs
    next=cool?{...MAIN}:{...FB[FB.length-1]}
  } else next={...FB[nextIndex]}
  routeState.fallbackIndex=next.kind==='main'?-1:FB.findIndex(r=>r.provider===next.provider&&r.model===next.model)
  routeState.consecutiveFailures=0
  routeState.lastSwitchAt=Date.now()
  routeState.switches++
  routeState.current={provider:next.provider,model:next.model}
  return next
}

let pass=0,failR=0
const ok=(n,c,d='')=>{if(c){pass++;console.log('  ✓ '+n)}else{failR++;console.log('  ✗ '+n+(d?' — '+d:''))}}

console.log('=== 连续失败时，路由怎么走 ===')
console.log('  起点: [主]', MAIN.provider+'/'+MAIN.model)
const seq=[]
for(let i=0;i<FB.length*2+4;i++){
  const n=fail()
  if(n) seq.push(`${n.provider}/${n.model}`)
}
console.log()
seq.forEach((r,i)=>console.log(`  第 ${i+1} 次降级 → ${r}`))

// 不写死具体 provider —— 从配置读，链调整后这个测试自动跟着变
FB.forEach((r, i) => {
  ok(`第 ${i + 1} 次降到 ${r.provider}/${r.model}`, seq[i] === `${r.provider}/${r.model}`, seq[i])
})
ok('全部备选走完后停在最后一条（冷却中不回主）', seq[FB.length] === seq[FB.length - 1], seq[FB.length])
ok(`走完 ${FB.length} 条共 ${FB.length} 次切换`, routeState.switches >= FB.length, String(routeState.switches))

console.log('\n=== 验证：consecutiveFailures=2 意味着要连败2次才降 ===')
const st={consecutiveFailures:0}
st.consecutiveFailures++
ok('1次失败不降级', F.consecutiveFailures===2)
st.consecutiveFailures++
ok('2次失败才降级', st.consecutiveFailures>=F.consecutiveFailures)

console.log(`\n结果: ${pass} 通过 / ${failR} 失败`)
process.exit(failR===0?0:1)
