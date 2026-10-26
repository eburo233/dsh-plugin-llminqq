import fs from 'node:fs'
const src=fs.readFileSync('/home/jojo/dsh/LLMinQQ/bridge/index.js','utf8')
const s1=src.indexOf('function segToPlainText')
const q1=src.indexOf('async function quoteOf')
const q2=src.indexOf('async function expandForwards')
const code=src.slice(s1,q1)+'\n'+src.slice(q1,q2)

function makeQuoteOf(gw){
  const factory=new Function('gateway', code+'\nreturn { quoteOf };')
  return factory(gw).quoteOf
}
const mkGw=(data,err)=>({selfId:'2511519116',callData:async()=>{if(err)throw new Error(err);return data}})

let pass=0,fail=0
const ok=(n,c,d='')=>{if(c){pass++;console.log('  ✓ '+n)}else{fail++;console.log('  ✗ '+n+(d?' — '+d:''))}}

console.log('=== 1. 正常取回（别人说的）===')
const q1f=makeQuoteOf(mkGw({message:[{type:'text',data:{text:'原始内容 ABC'}}],raw_message:'原始内容 ABC',sender:{nickname:'信风',user_id:3022464706}}))
const r1=await q1f('123')
ok('成功', r1.ok, JSON.stringify(r1))
ok('带发送者', r1.from==='信风', String(r1.from))
ok('带原文', r1.text==='原始内容 ABC', String(r1.text))

console.log('\n=== 2. 引用的是我自己的消息 ===')
const q2f=makeQuoteOf(mkGw({message:[{type:'text',data:{text:'我说的话'}}],sender:{nickname:'白嫖吉祥物',user_id:2511519116}}))
const r2=await q2f('456')
ok('from 标成「我」', r2.from==='我', String(r2.from))

console.log('\n=== 3. 引用图片（无文字）===')
const q3f=makeQuoteOf(mkGw({message:[{type:'image',data:{file:'x.jpg'}}],sender:{nickname:'信风',user_id:3022464706}}))
const r3=await q3f('789')
ok('返回段预览（含[图片]）', r3.ok && r3.text.includes('图片'), String(r3.text))

console.log('\n=== 4. 取不到 ===')
const q4f=makeQuoteOf(mkGw(null,'消息不存在'))
const r4=await q4f('999')
ok('ok=false', r4.ok===false)
ok('有 reason', !!r4.reason, String(r4.reason))

console.log('\n=== 5. 空 id ===')
const q5f=makeQuoteOf(mkGw({}))
const r5=await q5f('')
ok('直接 false 不崩', r5.ok===false)

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail===0?0:1)
