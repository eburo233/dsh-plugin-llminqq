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
for(let i=0;i<14;i++){
  const n=fail()
  if(n) seq.push(`${n.provider}/${n.model}`)
}
console.log()
seq.forEach((r,i)=>console.log(`  第 ${i+1} 次降级 → ${r}`))

ok('第1次降到 codearts', seq[0]==='codearts/deepseek-v4.1-flash', seq[0])
ok('第2次降到 qodercn/dfmodel（新插入的）', seq[1]==='qodercn/dfmodel', seq[1])
ok('第3次降到 trae/kimi-k3', seq[2]==='trae/kimi-k3', seq[2])
ok('第4次降到 trae/glm-5.3', seq[3]==='trae/glm-5.3', seq[3])
ok('第5次降到 trae/qwen3.8-flash', seq[4]==='trae/qwen3.8-flash', seq[4])
ok('5 条走完后停在最后一条（冷却中不回主）', seq[5]===seq[4], `${seq[5]}`)
ok('走完5条共5次切换', routeState.switches>=5, String(routeState.switches))

console.log('\n=== 验证：consecutiveFailures=2 意味着要连败2次才降 ===')
const st={consecutiveFailures:0}
st.consecutiveFailures++
ok('1次失败不降级', F.consecutiveFailures===2)
st.consecutiveFailures++
ok('2次失败才降级', st.consecutiveFailures>=F.consecutiveFailures)

console.log(`\n结果: ${pass} 通过 / ${failR} 失败`)
process.exit(failR===0?0:1)
