// 最小 PCM WAV 体检 / 裁尾静音（GPT-SoVITS 用）
//
// ── 为什么需要 ──────────────────────────────────────────────────────────────
// 2026-11-07 实测：GSV v2 的语音时长 = AR 语义 token 数 × 40ms + 0.3s（api.py 每段
// 末尾固定补 0.3s 零）。时长抖动 100% 来自 AR 采样，`speed` 只做特征线性插值。
//
// 极端采样有两种尾巴：
//   ① 正常范围内的快慢：同一句 15 字文本 53~75 token（2.42~3.30s）—— 听感「时快时慢」；
//   ② **退化样本**：EOS 被采样排除，模型一直吐「近静音 token」直到 1500 上限，
//      变成「前 0.5~3s 正常说话，后面 30~60s 几乎没声」。t0.6/p0.6 下实测长句 4/4 退化。
//
// 桥这边控制不了采样，但拿到 wav 之后可以做两件事：
//   · 体检：尾部静音异常长 / 总时长明显超出字数预算 → 当作坏样本
//   · 修：重试一次（坏样本通常换一次采样就正常）；仍有长尾静音 → 直接裁掉
//
// 这个模块只处理标准 PCM（audioFormat=1）16-bit WAV —— GSV api.py 返回的就是它。
// 解析失败一律返回 ok:false，调用方按「不知道」处理，绝不因为体检把语音搞丢。

const RIFF = 0x52494646
const WAVE = 0x57415645
const FMT = 0x666d7420
const DATA = 0x64617461

/**
 * 解析 WAV 头和 data chunk 位置。非 PCM/异常文件返回 null。
 * @param {Buffer} buf
 * @returns {null | {audioFormat:number, channels:number, sampleRate:number, bitsPerSample:number,
 *   dataOffset:number, dataSize:number, frameBytes:number, frames:number, durationSec:number}}
 */
export function parsePcmWav (buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44) return null
  if (buf.readUInt32BE(0) !== RIFF || buf.readUInt32BE(8) !== WAVE) return null
  let off = 12
  let fmt = null
  let data = null
  while (off + 8 <= buf.length) {
    const id = buf.readUInt32BE(off)
    let size = buf.readUInt32LE(off + 4)
    const body = off + 8
    if (size < 0 || body + size > buf.length) size = buf.length - body   // 截断文件容错
    if (id === FMT && size >= 16) {
      fmt = {
        audioFormat: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      }
    } else if (id === DATA) {
      data = { offset: body, size }
    }
    off = body + size + (size % 2)   // chunk 按 word 对齐
  }
  if (!fmt || !data || !fmt.channels || !fmt.sampleRate) return null
  const bytesPerSample = Math.ceil(fmt.bitsPerSample / 8)
  const frameBytes = bytesPerSample * fmt.channels
  const frames = Math.floor(data.size / frameBytes)
  if (!frames) return null
  return {
    ...fmt,
    dataOffset: data.offset,
    dataSize: data.size,
    frameBytes,
    frames,
    durationSec: frames / fmt.sampleRate,
  }
}

/**
 * 体检：总时长 + 尾部连续静音时长。
 * @param {Buffer} buf
 * @param {{silenceRms?: number}} [opts] 静音阈值（归一化 RMS，默认 0.003）
 * @returns {{ok:boolean, pcm:boolean, durationSec:number, tailSilenceSec:number, sampleRate?:number}}
 */
export function analyzeWav (buf, { silenceRms = 0.003 } = {}) {
  const info = parsePcmWav(buf)
  if (!info) return { ok: false, pcm: false, durationSec: 0, tailSilenceSec: 0 }
  if (info.audioFormat !== 1 || info.bitsPerSample !== 16) {
    // 非 16-bit PCM：时长可信，尾部静音不判（不冒险）
    return { ok: true, pcm: false, durationSec: info.durationSec, tailSilenceSec: 0, sampleRate: info.sampleRate }
  }
  const threshold = silenceRms
  let silentFrames = 0
  for (let f = info.frames - 1; f >= 0; f--) {
    const base = info.dataOffset + f * info.frameBytes
    let sumSq = 0
    for (let c = 0; c < info.channels; c++) {
      const v = buf.readInt16LE(base + c * 2) / 32768
      sumSq += v * v
    }
    const rms = Math.sqrt(sumSq / info.channels)
    if (rms > threshold) break
    silentFrames++
  }
  return {
    ok: true,
    pcm: true,
    durationSec: info.durationSec,
    tailSilenceSec: silentFrames / info.sampleRate,
    sampleRate: info.sampleRate,
  }
}

/**
 * 这个样本值不值得重试/修剪。
 * 判据（来自 2026-11-07 实测）：
 *   · 尾部静音 > 1.0s：正常样本只有 api.py 固定补的 0.3s；超过 1s 基本就是退化样本。
 *   · 总时长 > max(6s, 字数 × 0.35s + 1)：43 字音正常约 8s，退化样本 36~60s。
 * @param {{ok:boolean, pcm?:boolean, durationSec:number, tailSilenceSec:number}} analysis
 * @param {number} textLen 原文字数
 */
export function isSuspiciousWav (analysis, textLen) {
  if (!analysis?.ok) return false
  if (analysis.tailSilenceSec > 1.0) return true
  const budget = Math.max(6, Number(textLen || 0) * 0.35 + 1)
  return analysis.durationSec > budget
}

/**
 * 裁掉尾部多余静音（保留 keepSec 自然收尾）。
 * 只处理「data chunk 是最后一个 chunk」的标准文件；其它原样返回（不冒险）。
 * @param {Buffer} buf
 * @param {{keepSec?: number}} [opts]
 * @returns {Buffer}
 */
export function trimTrailingSilence (buf, { keepSec = 0.12 } = {}) {
  const info = parsePcmWav(buf)
  if (!info || info.audioFormat !== 1 || info.bitsPerSample !== 16) return buf
  // data 必须是最后一个 chunk，否则改大小会破坏后续 chunk
  if (info.dataOffset + info.dataSize !== buf.length) return buf
  const a = analyzeWav(buf)
  if (!a.ok || !a.pcm || a.tailSilenceSec <= keepSec) return buf
  const dropFrames = Math.floor((a.tailSilenceSec - keepSec) * info.sampleRate)
  if (dropFrames <= 0) return buf
  const newDataSize = info.dataSize - dropFrames * info.frameBytes
  if (newDataSize <= 0) return buf
  const out = Buffer.from(buf.subarray(0, info.dataOffset + newDataSize))
  out.writeUInt32LE(newDataSize, info.dataOffset - 4)   // data chunk size
  out.writeUInt32LE(out.length - 8, 4)                  // RIFF size
  return out
}
