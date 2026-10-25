// 验证：OCEAN 五维如何影响情绪涨落（性格影响情绪的直接证据）
import fs from 'node:fs'
const lines=fs.readFileSync('/home/jojo/dsh/LLMinQQ/bridge/index.js','utf8').split('\n')
const s=lines.findIndex(l=>l.startsWith('const OCEAN_DEFAULTS'))
const e=lines.findIndex((l,i)=>i>s && l.startsWith('let moodTimer = null'))
const code=lines.slice(s,e).join('\n')

function mk(ocean){
  const state={peers:{'c2c:1':{}}}
  const api=new Function('state','config','saveState','nowHour','logger','fs','PERSONA_PATH',
    code+'; return {moodState,moodEvent,deriveTraits};')(
    state,{mood:{enabled:true,ocean}},()=>{},()=>15,{log:()=>{}},fs,'/nonexistent'
  )
  return {state,...api}
}
let pass=0,fail=0
const ok=(n,c,d='')=>{if(c){pass++;console.log('  ✓ '+n)}else{fail++;console.log('  ✗ '+n+(d?' — '+d:''))}}

console.log('=== 1. 五维派生系数（可解释性）===')
const nerf=mk({N:0.9}), calm=mk({N:0.1})
const t1=nerf.deriveTraits({N:0.9}), t2=calm.deriveTraits({N:0.1})
console.log('  神经质 0.9 → sensitivity =', t1.sensitivity.toFixed(2), ', steady =', t1.steady.toFixed(2))
console.log('  神经质 0.1 → sensitivity =', t2.sensitivity.toFixed(2), ', steady =', t2.steady.toFixed(2))
ok('N 高 → 情绪幅度大', t1.sensitivity>t2.sensitivity)
ok('N 高 → 恢复慢(steady小)', t1.steady<t2.steady)

const agr=mk({A:0.9}), host=mk({A:0.15})
const ta=agr.deriveTraits({A:0.9}), th=host.deriveTraits({A:0.15})
console.log('  宜人 0.9 → grudge =', ta.grudge.toFixed(2))
console.log('  宜人 0.15 → grudge =', th.grudge.toFixed(2))
ok('A 高 → 不记仇(grudge小)', ta.grudge<th.grudge)

const ext=mk({E:0.95}), intr=mk({E:0.1})
const te=ext.deriveTraits({E:0.95}), ti=intr.deriveTraits({E:0.1})
ok('E 高 → 被夸更飘(showOff大)', te.showOff>ti.showOff)
ok('E 高 → 更黏人(clingy大)', te.clingy>ti.clingy)

console.log('\n=== 2. 同一件事，不同性格反应不同 ===')
const highN=mk({N:0.9}), lowN=mk({N:0.1})
highN.moodEvent('c2c:1','insult','被怼')
lowN.moodEvent('c2c:1','insult','被怼')
const v1=highN.moodState('c2c:1').valence, v2=lowN.moodState('c2c:1').valence
console.log(`  高神经质 被怼 → v=${v1.toFixed(3)}`)
console.log(`  低神经质 被怼 → v=${v2.toFixed(3)}`)
ok('高神经质掉更多', v1<v2)

const highA=mk({A:0.95}), lowA=mk({A:0.1})
for(let i=0;i<3;i++){ highA.moodEvent('c2c:1','insult','怼'); lowA.moodEvent('c2c:1','insult','怼') }
const a1=highA.moodState('c2c:1').valence, a2=lowA.moodState('c2c:1').valence
console.log(`  高宜人 连怼3次 → v=${a1.toFixed(3)}`)
console.log(`  低宜人 连怼3次 → v=${a2.toFixed(3)}`)
ok('低宜人记仇更明显', a2<a1)

const highE=mk({E:0.95}), lowE=mk({E:0.1})
highE.moodEvent('c2c:1','praise','夸'); lowE.moodEvent('c2c:1','praise','夸')
const e1=highE.moodState('c2c:1').arousal, e2=lowE.moodState('c2c:1').arousal
console.log(`  外向 被夸 → a=${e1.toFixed(3)}`)
console.log(`  内向 被夸 → a=${e2.toFixed(3)}`)
ok('外向被夸更兴奋', e1>e2)

console.log('\n=== 3. 性格原型库可用 ===')
const archSource=fs.readFileSync('/home/jojo/dsh/LLMinQQ/bridge/index.js','utf8')
const guardArch=mk({})
ok('原型库存在', archSource.includes('PERSONA_ARCHETYPES'))
const count=(archSource.match(/'\S+':\s*\{\s*O:/g)||[]).length
console.log('  原型数量:', count)
ok('原型 ≥ 30 个', count>=30, `实际 ${count}`)

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail===0?0:1)
