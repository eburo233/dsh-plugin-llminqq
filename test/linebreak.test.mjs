import fs from 'node:fs'
const src=fs.readFileSync('/home/jojo/dsh/LLMinQQ/bridge/index.js','utf8')
const i=src.indexOf('function tidyLineBreaks')
const j=src.indexOf('async function sendTextTo')
const code=src.slice(i,j)
const tidy=new Function(code+'; return tidyLineBreaks;')()
let pass=0,fail=0
const ok=(n,c,d='')=>{if(c){pass++;console.log('  ✓ '+n)}else{fail++;console.log('  ✗ '+n+(d?' — '+d:''))}}

console.log('=== 实际被吐槽的那种格式（两句中间空行）===')
const cases=[
  ['吉祥物这边握个爪，这行我资历比你老。\n\n不过说真的，一周三回十一点。',
   '吉祥物这边握个爪，这行我资历比你老。\n不过说真的，一周三回十一点。'],
  ['一点半了还没睡。\n\n现在躺下还能睡十几个钟头。\n\n再拖就废了。',
   '一点半了还没睡。\n现在躺下还能睡十几个钟头。\n再拖就废了。'],
  ['明白。 那我先不动了。', '明白。 那我先不动了。'],   // 没换行的不变
  ['1. 刷牙\n2. 洗脸\n3. 睡觉', '1. 刷牙\n2. 洗脸\n3. 睡觉'],  // 单换行列表保留
]
for(const [inp,exp] of cases){
  const got=tidy(inp)
  ok(`压空行: ${JSON.stringify(inp.slice(0,20))}…`, got===exp, JSON.stringify(got))
}

console.log('\n=== 边界 ===')
ok('空串不崩', tidy('')==='')
ok('null 不崩', tidy(null)===null)
ok('只有空行变空', tidy('\n\n\n')==='')
ok('CRLF 统一成 LF', tidy('a\r\n\r\nb')==='a\nb')
ok('行尾空白去掉', tidy('a   \nb')==='a\nb')

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail===0?0:1)
