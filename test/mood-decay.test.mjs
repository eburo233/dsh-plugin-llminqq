import fs from 'node:fs'
const lines=fs.readFileSync('/home/jojo/dsh/LLMinQQ/bridge/index.js','utf8').split('\n')
const s=lines.findIndex(l=>l.startsWith('const OCEAN_DEFAULTS'))
const e=lines.findIndex((l,i)=>i>s && l.startsWith('// ── 回话延迟'))
const code=lines.slice(s,e).join('\n')
const state={peers:{'c2c:1':{}}}
const {moodState,moodEvent,moodHint}=new Function('state','config','saveState','nowHour','logger',
  code+'; return {moodState,moodEvent,moodHint};')(state,{mood:{enabled:true}},()=>{},()=>15,{log:()=>{}})

let pass=0,fail=0
const ok=(n,c,d='')=>{if(c){pass++;console.log('  ✓ '+n)}else{fail++;console.log('  ✗ '+n+(d?' — '+d:''))}}

console.log('=== 衰减：情绪不会永久挂着 ===')
const m=moodState('c2c:1')
m.valence=0.9; m.arousal=0.9; m.at=Date.now()
console.log('  人为设成 valence=0.9 arousal=0.9')
console.log('  立刻:', moodHint('c2c:1').slice(0,40))

// 模拟 1 小时后（衰减 35%）
m.at=Date.now()-3600*1000
moodState('c2c:1')
console.log('  1小时后:', `v=${m.valence.toFixed(2)} a=${m.arousal.toFixed(2)}`)
ok('1小时后明显衰减', m.valence<0.9 && m.valence>0.3, `v=${m.valence.toFixed(2)}`)

// 模拟 3 小时后
m.at=Date.now()-3*3600*1000
moodState('c2c:1')
console.log('  3小时后:', `v=${m.valence.toFixed(2)} a=${m.arousal.toFixed(2)}`)
ok('3小时后基本回归基线', Math.abs(m.valence-0.15)<0.1, `v=${m.valence.toFixed(2)}`)

console.log('\n=== 无聊有底线（不会真抑郁）===')
const m2=moodState('c2c:1')
m2.valence=-1; m2.at=Date.now()
for(let i=0;i<20;i++) moodEvent('c2c:1','lonely','没人理')
ok('长期没人理不会跌破底线(-0.25)', m2.valence>=-0.26, `v=${m2.valence.toFixed(2)}`)
console.log('  ', moodHint('c2c:1').slice(0,50))

console.log('\n=== 二维组合的说法都合理 ===')
const combos=[
  [0.7,0.8,'心情很好，有点来劲'],
  [0.7,0.3,'挺高兴，但不算亢奋'],
  [0.3,0.7,'心情不错，聊得挺起劲'],
  [0.2,0.5,'平稳，正常状态'],
  [-0.05,0.7,'有点躁，但不算不高兴'],
  [-0.05,0.4,'一般，没什么特别的'],
  [-0.3,0.4,'有点闷'],
  [-0.6,0.3,'心情不太好'],
]
for(const [v,a,expect] of combos){
  const mm=moodState('c2c:1'); mm.valence=v; mm.arousal=a; mm.at=Date.now()
  const h=moodHint('c2c:1')
  ok(`v=${v} a=${a} → ${expect}`, h.includes(expect), h.slice(0,60))
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail===0?0:1)
