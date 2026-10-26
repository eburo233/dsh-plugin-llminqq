import fs from 'node:fs'
const src=fs.readFileSync('/home/jojo/dsh/LLMinQQ/bridge/index.js','utf8')
const s1=src.indexOf('const ENERGY_DEFAULTS')
const s2=src.indexOf('let proactiveTimer = null')
const code=src.slice(s1,s2)

function mk(moodInit, energyCfg={}){
  const state={peers:{'c2c:1':{mood:moodInit, energy:{value:0.8, at:Date.now()}}}}
  const cfg={mood:{enabled:true}, energy:{enabled:true, perMsgDrop:0.025, floor:0.15, ...energyCfg}}
  const fn=new Function('state','config','saveState','nowHour','logger','fs','PERSONA_PATH',
    code+'; return {energyDrop, moodEnergyFactor, energyState, moodState};')(
    state,cfg,()=>{},()=>15,{log:()=>{},debug:()=>{}},fs,'/nonexistent')
  return {state, ...fn}
}
let pass=0,fail=0
const ok=(n,c,d='')=>{if(c){pass++;console.log('  ✓ '+n)}else{fail++;console.log('  ✗ '+n+(d?' — '+d:''))}}

console.log('=== 1. 心情高涨 → 精力掉得少 ===')
const happy=mk({valence:0.9,arousal:0.9,at:Date.now(),lastWhy:''})
const f1=happy.moodEnergyFactor('c2c:1')
happy.energyDrop('c2c:1')
const d1=0.8-happy.energyState('c2c:1').value
console.log(`  心情好: 系数 ${f1.toFixed(2)} → 掉 ${d1.toFixed(4)}`)
ok('系数 < 1（掉得少）', f1<1, f1.toFixed(2))
ok('实际掉幅小于基础值 0.025', d1<0.025, d1.toFixed(4))

console.log('\n=== 2. 心情低落 → 精力掉得多 ===')
const sad=mk({valence:-0.8,arousal:0.3,at:Date.now(),lastWhy:''})
const f2=sad.moodEnergyFactor('c2c:1')
sad.energyDrop('c2c:1')
const d2=0.8-sad.energyState('c2c:1').value
console.log(`  心情差: 系数 ${f2.toFixed(2)} → 掉 ${d2.toFixed(4)}`)
ok('系数 > 1（掉得多）', f2>1, f2.toFixed(2))
ok('实际掉幅大于基础值 0.025', d2>0.025, d2.toFixed(4))

console.log('\n=== 3. 中性心情 ≈ 不改变 ===')
const neutral=mk({valence:0.15,arousal:0.5,at:Date.now(),lastWhy:''})
const f3=neutral.moodEnergyFactor('c2c:1')
console.log(`  中性: 系数 ${f3.toFixed(3)}`)
ok('接近 1.0', Math.abs(f3-1)<0.2, f3.toFixed(3))

console.log('\n=== 4. 对比：同样发一条，好心情 vs 坏心情 ===')
console.log(`  好心情掉 ${d1.toFixed(4)} | 坏心情掉 ${d2.toFixed(4)} | 差 ${((d2/d1-1)*100).toFixed(0)}%`)
ok('坏心情掉得明显更多', d2 > d1*1.5, `比值 ${(d2/d1).toFixed(2)}`)

console.log('\n=== 5. 边界 ===')
const extremeBad=mk({valence:-1,arousal:0,at:Date.now(),lastWhy:''})
const fb=extremeBad.moodEnergyFactor('c2c:1')
console.log(`  最差心情系数: ${fb.toFixed(2)}`)
ok('不超过 2.0', fb<=2.0, fb.toFixed(2))
const extremeGood=mk({valence:1,arousal:1,at:Date.now(),lastWhy:''})
const fg=extremeGood.moodEnergyFactor('c2c:1')
console.log(`  最好心情系数: ${fg.toFixed(2)}`)
ok('不低于 0.2', fg>=0.2, fg.toFixed(2))

console.log('\n=== 6. 开关能关掉联动 ===')
const off=mk({valence:0.9,arousal:0.9,at:Date.now(),lastWhy:''},{moodLinked:false})
console.log(`  moodLinked=false 时系数: ${off.moodEnergyFactor('c2c:1')}`)
ok('关掉后恒为 1', off.moodEnergyFactor('c2c:1')===1)

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail===0?0:1)
