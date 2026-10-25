// 纯逻辑测试：flurry 判定是否正确
const D={enabled:true,windowMs:45000,minMsgs:3,longMsgChars:60,suppressRatio:0.6,silenceAfter:90000}
function makeTracker(){
  const recent=new Map(), state=new Map()
  return {
    note(k,len,addressed,now){
      const arr=(recent.get(k)??[]).filter(m=>now-m.at<D.windowMs)
      arr.push({at:now,len,addressed})
      recent.set(k,arr)
      const longOnes=arr.filter(m=>m.len>=D.longMsgChars)
      const ratio=arr.length?longOnes.length/arr.length:0
      const isFlurry=arr.length>=D.minMsgs&&ratio>=D.suppressRatio
      if(isFlurry){
        const prev=state.get(k)
        if(!addressed) state.set(k,{until:now+D.silenceAfter,peak:Math.max(prev?.peak??0,arr.length)})
        return {flurry:true,count:arr.length,ratio}
      }
      return {flurry:false,count:arr.length,ratio}
    },
    inSilence(k,now){const s=state.get(k);if(!s)return false;if(now>s.until){state.delete(k);return false}return true},
  }
}
let pass=0,fail=0
const ok=(n,c,d='')=>{if(c){pass++;console.log('  ✓',n)}else{fail++;console.log('  ✗',n,d)}}
const T=1000000

console.log('=== 1. 群友发 3 条长消息（应判定刷屏）===')
let t=makeTracker()
let r
for(let i=0;i<3;i++){ r=t.note('g',200,false,T+i*5000) }
ok('3 条长消息 → flurry', r.flurry, `count=${r.count} ratio=${r.ratio}`)
ok('进入静默期', t.inSilence('g',T+10000))

console.log('\n=== 2. 正常聊天（短消息，不该误判）===')
t=makeTracker()
for(let i=0;i<5;i++){ r=t.note('g',10,false,T+i*3000) }
ok('5 条短消息 → 不刷屏', !r.flurry, `ratio=${r.ratio}`)
ok('不在静默期', !t.inSilence('g',T+20000))

console.log('\n=== 3. 被 @ 的长消息不触发静默 ===')
t=makeTracker()
for(let i=0;i<3;i++){ r=t.note('g',200,true,T+i*5000) }
ok('被 @ → 判定为 flurry', r.flurry)
ok('被 @ 不进入静默（还是要回）', !t.inSilence('g',T+10000))

console.log('\n=== 4. 长短混合（1 长 2 短 = 33%，不该判）===')
t=makeTracker()
t.note('g',200,false,T); t.note('g',10,false,T+2000); t.note('g',10,false,T+4000)
r=t.note('g',10,false,T+6000)
ok('长消息占比 25% → 不判刷屏', !r.flurry, `ratio=${r.ratio.toFixed(2)}`)

console.log('\n=== 5. 静默期过后恢复 ===')
t=makeTracker()
for(let i=0;i<3;i++) t.note('g',200,false,T+i*5000)
// 静默期从最后一条消息（T+10000）开始，+90000 → T+100000
ok('刚判完在静默', t.inSilence('g',T+50000))
ok('91 秒后解除', !t.inSilence('g',T+10000+91000))

console.log('\n=== 6. 窗口外的旧消息不算 ===')
t=makeTracker()
for(let i=0;i<3;i++) t.note('g',200,false,T+i*5000)
r=t.note('g',200,false,T+60000)  // 前面的已超 45s 窗口
ok('窗口外旧消息被清掉', !r.flurry, `count=${r.count}`)

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail===0?0:1)
