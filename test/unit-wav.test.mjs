// test/unit-wav.test.mjs —— GSV wav 体检/裁尾静音（2026-11-07）
//
// 背景：GSV v2 的「半句 + 几十秒静音」退化样本只有听感证据，没有单元测试就没法防回归。
// 这里用合成 PCM16 WAV 断言：时长/尾部静音算得对、退化样本判得出来、裁完之后
// 文件头和 data 大小仍然自洽（能继续被 QQ 当语音发）。

import test from 'node:test'
import assert from 'node:assert/strict'
import { parsePcmWav, analyzeWav, isSuspiciousWav, trimTrailingSilence } from '../lib/bridge/wav.js'

/**
 * 拼一个最小 PCM16 WAV。
 * @param {object} opts
 * @param {number[]} opts.toneFrames 有声段帧数（方波 amplitude=0.5）
 * @param {number[]} opts.silentFrames 静音段帧数数组
 */
function buildWav ({ sampleRate = 32000, channels = 1, segments = [] } = {}) {
  const frameBytes = 2 * channels
  const totalFrames = segments.reduce((a, s) => a + s.frames, 0)
  const dataSize = totalFrames * frameBytes
  const buf = Buffer.alloc(44 + dataSize)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)            // PCM
  buf.writeUInt16LE(channels, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * frameBytes, 28)
  buf.writeUInt16LE(frameBytes, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(dataSize, 40)
  let off = 44
  let i = 0
  for (const seg of segments) {
    for (let f = 0; f < seg.frames; f++) {
      const v = seg.amp ? Math.round(seg.amp * 32767 * (i % 2 ? 1 : -1)) : 0
      for (let c = 0; c < channels; c++) { buf.writeInt16LE(v, off); off += 2 }
      i++
    }
  }
  return buf
}

test('wav: 解析 PCM16 头与时长', () => {
  const buf = buildWav({ sampleRate: 32000, segments: [{ frames: 32000, amp: 0.5 }] })
  const info = parsePcmWav(buf)
  assert.ok(info)
  assert.equal(info.channels, 1)
  assert.equal(info.sampleRate, 32000)
  assert.equal(info.durationSec, 1)
  assert.equal(info.dataOffset, 44)
})

test('wav: 尾部静音时长算得对（退化样本的核心指标）', () => {
  // 0.2s 有声 + 2s 静音
  const buf = buildWav({
    sampleRate: 32000,
    segments: [{ frames: 6400, amp: 0.5 }, { frames: 64000, amp: 0 }],
  })
  const a = analyzeWav(buf)
  assert.ok(a.ok)
  assert.ok(Math.abs(a.durationSec - 2.2) < 0.01)
  assert.ok(Math.abs(a.tailSilenceSec - 2) < 0.02, `尾部静音应约 2s，实际 ${a.tailSilenceSec}`)
})

test('wav: 正常样本不误报（15 字 / 2.8s / 0.3s 尾静音）', () => {
  const buf = buildWav({
    sampleRate: 32000,
    segments: [{ frames: 80000, amp: 0.5 }, { frames: 9600, amp: 0 }], // 2.5s + 0.3s
  })
  const a = analyzeWav(buf)
  assert.equal(isSuspiciousWav(a, 15), false)
})

test('wav: 退化样本判得出来（43 字 / 60s / 尾部 59s 近静音）', () => {
  const frames = 60 * 32000
  const buf = buildWav({
    sampleRate: 32000,
    segments: [{ frames: 32000, amp: 0.5 }, { frames: frames - 32000, amp: 0 }],
  })
  const a = analyzeWav(buf)
  assert.equal(isSuspiciousWav(a, 43), true)
  assert.ok(a.tailSilenceSec > 50)
})

test('wav: 总时长超字数预算也算异常（即便尾声不全是静音）', () => {
  const buf = buildWav({ sampleRate: 32000, segments: [{ frames: 320000, amp: 0.5 }] }) // 10s 有声
  const a = analyzeWav(buf)
  assert.equal(isSuspiciousWav(a, 10), true, '10 字不该说 10 秒（预算 max(6, 4.5)）')
  assert.equal(isSuspiciousWav(a, 60), false, '60 字说 10 秒正常')
})

test('wav: 裁尾静音后文件头/data 大小自洽，且保留自然收尾', () => {
  const sr = 32000
  const keep = 0.12
  const buf = buildWav({
    sampleRate: sr,
    segments: [{ frames: 6400, amp: 0.5 }, { frames: 64000, amp: 0 }], // 0.2s + 2s
  })
  const out = trimTrailingSilence(buf, { keepSec: keep })
  assert.notEqual(out, buf)
  const info = parsePcmWav(out)
  assert.ok(info, '裁完还必须是合法 WAV')
  assert.equal(out.length, info.dataOffset + info.dataSize, '文件长度应等于头+data')
  assert.equal(out.readUInt32LE(4), out.length - 8, 'RIFF size 要跟着改')
  const a = analyzeWav(out)
  assert.ok(Math.abs(a.tailSilenceSec - keep) < 0.02, `保留约 ${keep}s 尾静音，实际 ${a.tailSilenceSec}`)
  assert.ok(Math.abs(a.durationSec - (0.2 + keep)) < 0.02)
})

test('wav: 没有多余静音时原样返回（不重写文件）', () => {
  const buf = buildWav({
    sampleRate: 32000,
    segments: [{ frames: 32000, amp: 0.5 }, { frames: 3200, amp: 0 }], // 1s + 0.1s
  })
  assert.equal(trimTrailingSilence(buf), buf)
})

test('wav: 非 WAV/截断输入不抛异常、返回 null 或 ok:false', () => {
  assert.equal(parsePcmWav(Buffer.from('not a wav at all, really')), null)
  assert.equal(parsePcmWav(Buffer.alloc(0)), null)
  const a = analyzeWav(Buffer.from('garbage'))
  assert.equal(a.ok, false)
  assert.equal(isSuspiciousWav(a, 10), false, '解析不了按正常处理（不能把语音搞丢）')
  assert.equal(trimTrailingSilence(Buffer.from('garbage')).toString(), 'garbage')
})

test('wav: 立体声也按双声道帧算尾部静音', () => {
  const buf = buildWav({
    sampleRate: 16000,
    channels: 2,
    segments: [{ frames: 1600, amp: 0.5 }, { frames: 32000, amp: 0 }], // 2s 静音
  })
  const a = analyzeWav(buf)
  assert.ok(a.ok)
  assert.ok(Math.abs(a.tailSilenceSec - 2) < 0.02)
})
