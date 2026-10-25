import fs from 'node:fs'
const lines=fs.readFileSync('/home/jojo/dsh/LLMinQQ/bridge/index.js','utf8').split('\n')
const s=lines.findIndex(l=>l.startsWith('const DELAY_DEFAULTS'))
const e=lines.findIndex((l,i)=>i>s && l.startsWith('let proactiveTimer'))
const code=lines.slice(s,e).join('\n')
// 桩：精力/情绪
let ENERGY=0.8, AROUSAL=0.5
const energyState=()=>({value:ENERGY})
const moodState=()=>({arousal:AROUSAL})
const {replyDelayMs}=new Function('config','energyState','moodState',
  code+'; return {replyDelayMs};')({replyDelay:{enabled:true}},energyState,moodState)

let pass=0,fail=0
const ok=(n,c,d='')=>{if(c){pass++;console.log('  ✓ '+n)}else{fail++;console.log('  ✗ '+n+(d?' — '+d:''))}}
const avg=(t,k,n=200)=>{let s=0;for(let i=0;i<n;i++)s+=replyDelayMs(t,k);return Math.round(s/n)}
const avgWith=(e,a,t,n=200)=>{ENERGY=e;AROUSAL=a;let s=0;for(let i=0;i<n;i++)s+=replyDelayMs(t,'c2c:test');return Math.round(s/n)}

console.log('=== 1. 字数越多，等得越久 ===')
console.log('  "嗯"        (1字) →', avg('嗯'),'ms')
console.log('  "行吧你说"   (4字) →', avg('行吧你说'),'ms')
console.log('  "我觉得这个"  (20字) →', avg('我觉得这个事情吧我觉得这个事情吧',4),'ms')
console.log('  一段话      (100字) →', avg('啊'.repeat(100)),'ms')
const d1=avg('嗯'), d2=avg('啊'.repeat(100))
ok('100字明显比1字久', d2>d1*2, `${d1} → ${d2}`)
ok('短消息在 3 秒内', d1<3000, `${d1}ms`)
ok('不会超过 15 秒上限', d2<=15000, `${d2}ms`)

console.log('\n=== 2. 精力低 → 打得慢 ===')
const fast=avgWith(0.9,0.5,'这是一句测试的话')
const slow=avgWith(0.15,0.5,'这是一句测试的话')
console.log(`  精力 90%: ${fast}ms`)
console.log(`  精力 15%: ${slow}ms`)
ok('精力低时更慢', slow>fast, `${fast} vs ${slow}`)

console.log('\n=== 3. 情绪亢奋 → 打得快 ===')
const calm=avgWith(0.8,0.4,'这是一句测试的话')
const hype=avgWith(0.8,0.95,'这是一句测试的话')
console.log(`  平稳: ${calm}ms`)
console.log(`  亢奋: ${hype}ms`)
ok('亢奋时更快', hype<calm, `${calm} vs ${hype}`)

console.log('\n=== 4. 抖动：不是每次都一样 ===')
ENERGY=0.8;AROUSAL=0.5
const samples=Array.from({length:12},()=>replyDelayMs('这是一句测试的话'))
const uniq=new Set(samples).size
console.log('  12 次采样:', samples.join(','))
ok('有随机抖动（不是固定值）', uniq>=8, `不同值 ${uniq}/12`)

console.log('\n=== 5. 边界 ===')
ok('空串不崩且不超 min', replyDelayMs('')>=900, String(replyDelayMs('')))
ok('超长文本被截到 max', replyDelayMs('啊'.repeat(5000))<=15000)
ok('enabled=false 时返回 0', (()=>{
  const {replyDelayMs:r}=new Function('config','energyState','moodState',
    code+'; return {replyDelayMs};')({replyDelay:{enabled:false}},energyState,moodState)
  return r('测试')===0
})())

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail===0?0:1)
