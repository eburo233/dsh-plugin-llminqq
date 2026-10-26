#!/usr/bin/env node
// 假 ACP agent：只实现桥用到的最小协议，用来在**不接真 LLM** 的前提下验证
// 「入站消息 → [RECALL] 标记 → 桥真的撤上一条 → 再发新内容」的完整链路。
//
// 行为由环境变量控制：
//   FAKE_ACP_REPLY_FILE  每次 prompt 时从这个文件读这一轮要说的话
//                        （读文件而不是读 env，是为了让测试能逐轮改回复）
//   FAKE_ACP_REPLY       兜底固定回复（文件不存在时用）
//   FAKE_ACP_TRACE       收到的 RPC 往这个文件追加一行
import fs from 'node:fs'

const REPLY_FILE = process.env.FAKE_ACP_REPLY_FILE ?? ''
const FALLBACK = process.env.FAKE_ACP_REPLY ?? '好的'
const TRACE = process.env.FAKE_ACP_TRACE ?? ''
// FAKE_ACP_PROMPT_LOG（新增，可选）：把每轮**收到的完整 prompt 文本**追加到文件。
// 用来端到端验证「桥这一轮到底给模型注入了什么」—— 只落 trace 是不够的，
// trace 只记方法名，看不到 prompt 正文（lexicon 注入验证要靠它）。
const PROMPT_LOG = process.env.FAKE_ACP_PROMPT_LOG ?? ''
const currentReply = () => {
  try {
    const s = fs.readFileSync(REPLY_FILE, 'utf8').trim()
    return s || FALLBACK
  } catch { return FALLBACK }
}
let nextSession = 1

const write = obj => process.stdout.write(JSON.stringify(obj) + '\n')
const trace = line => { if (TRACE) fs.appendFileSync(TRACE, line + '\n') }

let buf = ''
process.stdin.on('data', chunk => {
  buf += chunk.toString('utf8')
  let idx
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim()
    buf = buf.slice(idx + 1)
    if (!line) continue
    let frame
    try { frame = JSON.parse(line) } catch { continue }
    handle(frame)
  }
})

function handle(frame) {
  const { id, method, params } = frame
  trace(`${method} ${JSON.stringify(params ?? {}).slice(0, 400)}`)
  switch (method) {
    case 'initialize':
      return write({ jsonrpc: '2.0', id, result: { protocolVersion: 1, agentInfo: { name: 'fake-acp', version: '0.0.1' } } })
    case 'session/new': {
      const sessionId = `fake-session-${nextSession++}`
      return write({ jsonrpc: '2.0', id, result: { sessionId } })
    }
    case 'session/resume':
      return write({ jsonrpc: '2.0', id, result: {} })
    case 'session/set_config_option':
      return write({ jsonrpc: '2.0', id, result: {} })
    case 'session/prompt': {
      const sessionId = params?.sessionId
      if (PROMPT_LOG) {
        // prompt 是 blocks 数组：[{type:'text', text:'...'}]（桥把上下文拼在 text 里）
        const text = (params?.prompt ?? []).map(b => b?.text ?? '').join('\n')
        try { fs.appendFileSync(PROMPT_LOG, text + '\n') } catch { /* ignore */ }
      }
      // ACP：prompt 是阻塞调用，先流式吐 session/update，再回 result
      write({
        jsonrpc: '2.0', method: 'session/update',
        params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: currentReply() } } },
      })
      return write({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })
    }
    default:
      if (id != null) write({ jsonrpc: '2.0', id, result: {} })
  }
}
