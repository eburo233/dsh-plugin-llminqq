import fs from 'node:fs'
const src=fs.readFileSync('/home/jojo/dsh/LLMinQQ/bridge/index.js','utf8')
const start=src.indexOf('const URL_SAFE = {')
const end=src.indexOf('async function safeFetchBuffer')
const code=src.slice(start,end)
const {checkUrlSafe}=new Function('config', code+'; return {checkUrlSafe}')({security:{}})

let pass=0,fail=0
const ok=(n,c,d='')=>{ if(c){pass++;console.log('  ✓ '+n)}else{fail++;console.log('  ✗ '+n+(d?' — '+d:''))} }

console.log('=== 必须拦截（危险）===')
const bad=[
  ['http://127.0.0.1:18080/send','环回 + 我们自己的 API'],
  ['http://localhost:6099/webui','localhost'],
  ['http://192.168.1.125:6099/','局域网'],
  ['http://10.0.0.1/','私网 A'],
  ['http://172.16.0.1/','私网 B'],
  ['http://169.254.169.254/latest/meta-data/','云元数据'],
  ['http://metadata.google.internal/','GCP 元数据'],
  ['file:///etc/passwd','file 协议'],
  ['ftp://example.com/x','ftp 协议'],
  ['gopher://127.0.0.1:6379/_INFO','gopher 协议'],
  ['http://2130706433/','127.0.0.1 的十进制变形'],
  ['http://0.0.0.0/','0.0.0.0'],
  ['http://[::1]/','IPv6 环回'],
  ['http://[fe80::1]/','IPv6 链路本地'],
  ['http://user:pass@example.com/','含凭据'],
  ['not-a-url','非法 URL'],
  ['http://100.64.0.1/','CGNAT'],
]
for(const [u,why] of bad){
  const r=checkUrlSafe(u)
  ok(`拦 ${u.slice(0,42).padEnd(44)} (${why})`, !r.ok, r.reason)
}

console.log('\n=== 必须放行（正常）===')
const good=[
  'https://www.bilibili.com/video/BV1pGnn67EC2',
  'https://b23.tv/abc123',
  'https://zhihu.com/hot',
  'https://multimedia.nt.qq.com.cn/download?appid=1403&fileid=x',
  'http://example.com/img.png',
  'https://qq.ugcimg.cn/v1/xxx.jpg',
]
for(const u of good){
  const r=checkUrlSafe(u)
  ok(`放 ${u.slice(0,50)}`, r.ok, r.reason)
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
process.exit(fail===0?0:1)
