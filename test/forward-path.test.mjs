// 直接测桥里"收到合并转发"的完整路径（不依赖真实送信）
// 复现：flattenMessage → expandForwards → 空消息判定
import fs from 'node:fs'
import { spawn } from 'node:child_process'

const lines=fs.readFileSync('/home/jojo/dsh/LLMinQQ/bridge/index.js','utf8').split('\n')
// 只要 flattenMessage 的 forward 部分：验证 forwardIds 能被收集
const s=lines.findIndex(l=>l.startsWith('function flattenMessage(message)'))
const e=lines.findIndex((l,i)=>i>s && l==='}' && lines[i+1]==='')
const fnCode=lines.slice(s,e+1).join('\n')
const flattenMessage=new Function('gateway','selfMessageIds','fs','path','crypto','MAX_FILE','STAGING_DIR',
  'async function dummy(){}\n'+fnCode+'; return flattenMessage;')(
  {selfId:'2511519116'}, new Set(), fs, (await import('node:path')).default, (await import('node:crypto')).default, 1e7, '/tmp'
)

console.log('=== 1. 纯合并转发消息（text 为空）===')
const msg=[
  {type:'forward',data:{id:'ABC123'}},
]
const flat=flattenMessage(msg)
console.log('  text:', JSON.stringify(flat.text))
console.log('  forwardIds:', flat.forwardIds)
console.log('  cards:', flat.cards)

console.log('\n=== 2. 带文字的合并转发 ===')
const flat2=flattenMessage([{type:'forward',data:{id:'XYZ'}},{type:'text',data:{text:'看看这个'}}])
console.log('  text:', JSON.stringify(flat2.text), '| forwardIds:', flat2.forwardIds)

console.log('\n=== 3. 各种 forward id 字段名 ===')
for(const d of [{id:'a'},{res_id:'b'},{forward_id:'c'}]){
  const f=flattenMessage([{type:'forward',data:d}])
  console.log(`  data=${JSON.stringify(d)} → ${JSON.stringify(f.forwardIds)}`)
}

console.log('\n=== 4. 修复前后对比（空消息判定）===')
function judge(flat, imageCount, forwardText){
  // 旧逻辑
  const oldDrop = !flat.text && imageCount===0
  // 新逻辑
  const newDrop = !flat.text && imageCount===0 && !forwardText && !(flat.cards?.length)
  return {oldDrop, newDrop}
}
const j=judge(flat,0,'【合并转发内容】测试甲: 第一句...')
console.log('  纯转发消息：旧逻辑丢弃?', j.oldDrop?'❌ 丢弃（bug）':'保留', '| 新逻辑:', j.newDrop?'丢弃':'✅ 保留')
