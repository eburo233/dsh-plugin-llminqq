import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

let hit=false
const trap=http.createServer((req,res)=>{ hit=true; res.end('SECRET_DATA_LEAKED') })
await new Promise(r=>trap.listen(19999,'127.0.0.1',r))
console.log('蜜罐已起: http://127.0.0.1:19999/')

const lines=fs.readFileSync('/home/jojo/dsh/LLMinQQ/bridge/index.js','utf8').split('\n')
// 抓 274-439 行（extFor + URL_SAFE + checkUrlSafe + sanitize + safeFetchBuffer + downloadUrlToStaging）
const code=lines.slice(273,439).join('\n')
const STAGING='/tmp/ssrf-staging'; fs.mkdirSync(STAGING,{recursive:true})
const MAX_FILE=10*1024*1024

const {downloadUrlToStaging,checkUrlSafe}=new Function('config','fs','path','crypto','MAX_FILE','STAGING_DIR','logger',
  code+'\n; return {downloadUrlToStaging, checkUrlSafe};')(
  {security:{}}, fs, path, crypto, MAX_FILE, STAGING, {log:()=>{}}
)

const attacks=[
  'http://127.0.0.1:19999/secret',
  'http://localhost:19999/secret',
  'http://2130706433:19999/secret',
  'http://[::1]:19999/secret',
]
let blocked=0
for(const u of attacks){
  try{
    await downloadUrlToStaging(u)
    console.log(`  ✗ ${u} → 下载成功了！（防护失败）`)
  }catch(e){
    console.log(`  ✓ ${u.padEnd(38)} → 拦: ${e.message.slice(0,55)}`)
    blocked++
  }
}
trap.close()
console.log(`\n蜜罐被访问: ${hit?'❌ 是（泄露）':'✅ 否（守卫生效）'}`)
console.log(`拦截 ${blocked}/${attacks.length}`)
process.exit(!hit && blocked===attacks.length ? 0 : 1)
