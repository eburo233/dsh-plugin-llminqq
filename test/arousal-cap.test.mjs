import fs from 'node:fs'
const src=fs.readFileSync('/home/jojo/dsh/LLMinQQ/bridge/index.js','utf8')
const s1=src.indexOf('const OCEAN_DEFAULTS')
const s2=src.indexOf('let moodTimer = null')
const code=src.slice(s1,s2)
const state={peers:{'c2c:1':{}}}
const fn=new Function('state','config','saveState','nowHour','logger','fs','PERSONA_PATH',
  code+'; return {moodState,moodEvent};')(
  state,{mood:{enabled:true}},()=>{},()=>15,{log:()=>{}},fs,'/nonexistent')
const {moodState,moodEvent}=fn

let pass=0,fail=0
const ok=(n,c,d='')=>{if(c){pass++;console.log('  ✓ '+n)}else{fail++;console.log('  ✗ '+n+(d?' — '+d:''))}}

console.log('=== 模拟连续被 @ 20 次（修复前会卡在 1.00）===')
const m=moodState('c2c:1')
const trail=[]
for(let i=1;i<=20;i++){
  moodEvent('c2c:1','addressed','被点到')
  if(i<=5||i%5===0) trail.push(`第${i}次:${m.arousal.toFixed(3)}`)
}
console.log('  ', trail.join('  '))
ok('不会无脑涨到 1.00', m.arousal < 0.95, m.arousal.toFixed(3))
ok('渐进接近软上限但不越过', m.arousal > 0.75 && m.arousal <= 0.90, m.arousal.toFixed(3))

console.log('\n=== 但真正的大事件仍能冲到顶 ===')
moodEvent('c2c:1','praise','被夸')
console.log('  被夸一次后 arousal:', m.arousal.toFixed(3))
ok('被夸能突破软上限', m.arousal > 0.85, m.arousal.toFixed(3))

console.log('\n=== 边际递减：前几次加得多，后面加得少 ===')
const st2={peers:{'c2c:2':{}}}
const fm=new Function('state','config','saveState','nowHour','logger','fs','PERSONA_PATH',
  code+'; return {moodState,moodEvent};')(
  st2,{mood:{enabled:true}},()=>{},()=>15,{log:()=>{}},fs,'/nonexistent')
const m2=fm.moodState('c2c:2')
const gains=[]
for(let i=0;i<6;i++){
  const b=m2.arousal
  fm.moodEvent('c2c:2','addressed','')
  gains.push((m2.arousal-b).toFixed(4))
}
console.log('  每次增量:', gains.join(', '))
ok('增量递减', parseFloat(gains[0])>parseFloat(gains[4]), `${gains[0]} vs ${gains[4]}`)

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail===0?0:1)
