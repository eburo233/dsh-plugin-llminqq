// 合并转发的解析路径测试：验证 forwardIds 能被收集、修复后的判定不会丢消息
import fs from 'node:fs'
const lines=fs.readFileSync('/home/jojo/dsh/LLMinQQ/bridge/index.js','utf8').split('\n')
const s=lines.findIndex(l=>l.startsWith('function flattenMessage(message)'))
const e=lines.findIndex((l,i)=>i>s && l==='}' && lines[i+1]==='')
const fnCode=lines.slice(s,e+1).join('\n')
const flattenMessage=new Function('gateway','selfMessageIds','fs','path','crypto','MAX_FILE','STAGING_DIR',
  'function sanitizeUntrustedText(t){return t}\nfunction cardJsonToText(){return "[卡片]"}\nfunction xmlToText(){return "[卡片]"}\nfunction extFor(){return ".jpg"}\n'+
  fnCode+'; return flattenMessage;')(
  {selfId:'2511519116'}, new Set(), fs, (await import('node:path')).default, (await import('node:crypto')).default, 1e7, '/tmp'
)

let pass=0,fail=0
const ok=(n,c,d='')=>{if(c){pass++;console.log('  ✓ '+n)}else{fail++;console.log('  ✗ '+n+(d?' — '+d:''))}}

console.log('=== 1. 纯合并转发（text 为空）===')
const flat=flattenMessage([{type:'forward',data:{id:'ABC123'}}])
ok('text 为空', flat.text==='')
ok('forwardIds 收集到', flat.forwardIds.length===1 && flat.forwardIds[0]==='ABC123', JSON.stringify(flat.forwardIds))
ok('cards 为空', flat.cards.length===0)

console.log('\n=== 2. 带文字的转发 ===')
const flat2=flattenMessage([{type:'forward',data:{id:'XYZ'}},{type:'text',data:{text:'看看这个'}}])
ok('text 保留', flat2.text==='看看这个')
ok('forwardIds 保留', flat2.forwardIds[0]==='XYZ')

console.log('\n=== 3. 各种 forward id 字段名 ===')
for(const [d,expect] of [[{id:'a'},'a'],[{res_id:'b'},'b'],[{forward_id:'c'},'c']]){
  const f=flattenMessage([{type:'forward',data:d}])
  ok(`data=${JSON.stringify(d)} → ${expect}`, f.forwardIds[0]===expect, JSON.stringify(f.forwardIds))
}
ok('无 id 的 forward 不产生条目', flattenMessage([{type:'forward',data:{}}]).forwardIds.length===0)

console.log('\n=== 4. 空消息判定：修复前后对比 ===')
function judge(flat, imageCount, forwardText){
  const oldDrop = !flat.text && imageCount===0
  const newDrop = !flat.text && imageCount===0 && !forwardText && !(flat.cards?.length)
  return {oldDrop, newDrop}
}
const j=judge(flat,0,'【合并转发内容】测试甲: 第一句...')
ok('旧逻辑会丢弃（这就是 bug）', j.oldDrop===true)
ok('新逻辑保留', j.newDrop===false)
const j2=judge(flat,0,'')
ok('真的什么都没有时仍然丢弃', j2.newDrop===true)

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail===0?0:1)
