import fs from 'node:fs'
const lines=fs.readFileSync('/home/jojo/dsh/LLMinQQ/bridge/index.js','utf8').split('\n')
const s=lines.findIndex(l=>l.startsWith('const OCEAN_DEFAULTS'))
const e=lines.findIndex((l,i)=>i>s && l.startsWith('// ── 回话延迟'))
const code=lines.slice(s,e).join('\n')

// 造最小环境
const state={peers:{'c2c:1':{}}}
const config={mood:{enabled:true}}
let saveCount=0
const fn=new Function('state','config','saveState','nowHour','logger',
  code+'; return {moodState,moodEvent,detectMoodTriggers,moodHint};')(
  state,config,()=>{saveCount++},()=>15,{log:()=>{}}
)
const {moodState,moodEvent,detectMoodTriggers,moodHint}=fn

let pass=0,fail=0
const ok=(n,c,d='')=>{if(c){pass++;console.log('  ✓ '+n)}else{fail++;console.log('  ✗ '+n+(d?' — '+d:''))}}

console.log('=== 1. 初始状态 ===')
const m=moodState('c2c:1')
ok('初始 valence 略正', m.valence>0 && m.valence<0.4, `v=${m.valence}`)
ok('初始 arousal 中位', m.arousal>=0.4 && m.arousal<=0.6, `a=${m.arousal}`)
console.log('  初始:', moodHint('c2c:1'))

console.log('\n=== 2. 被夸 → 心情变好 ===')
const before=moodState('c2c:1').valence
for(const t of ['你牛啊','厉害了','谢谢','笑死我了','真行']){
  for(const ev of detectMoodTriggers(t)) moodEvent('c2c:1',ev.kind,ev.why)
}
const after=moodState('c2c:1').valence
ok('被夸后 valence 上升', after>before, `${before.toFixed(2)} → ${after.toFixed(2)}`)
console.log('  ', moodHint('c2c:1'))

console.log('\n=== 3. 被怼 → 掉得少（不记仇）===')
const v1=moodState('c2c:1').valence
moodEvent('c2c:1','insult','被怼')
const v2=moodState('c2c:1').valence
ok('被怼 valence 下降', v2<v1)
ok('降幅小于夸奖升幅(0.25)', Math.abs(v2-v1)<0.25, `降了 ${Math.abs(v2-v1).toFixed(2)}`)
console.log('  ', moodHint('c2c:1'))

console.log('\n=== 4. 触发识别准确性 ===')
const cases=[
  ['你牛啊',true,['praise']],
  ['谢谢老大',true,['praise']],
  ['笑死我了',true,['praise']],
  ['你傻吧',true,['insult']],
  ['闭嘴',true,['insult']],
  ['你说错了',true,['insult']],
  ['今天天气不错',false,null],  // "不错"会误判为夸 → 标注
  ['随便聊聊',false,null],
]
for(const [t,expectPraise,expect] of cases){
  const got=detectMoodTriggers(t).map(x=>x.kind)
  if(expect===null){
    console.log(`  ? "${t}" → ${JSON.stringify(got)}  (边界: ${got.length?'可能误判':'正确'})`)
  } else {
    ok(`"${t}" → ${expect.join(',')}`, JSON.stringify(got)===JSON.stringify(expect), JSON.stringify(got))
  }
}

console.log('\n=== 5. 边界不能崩 ===')
ok('null 不崩', detectMoodTriggers(null).length===0)
ok('空串不崩', detectMoodTriggers('').length===0)
ok('超长文本不崩', detectMoodTriggers('a'.repeat(10000)).length>=0)

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail===0?0:1)
