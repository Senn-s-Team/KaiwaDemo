import { describe, expect, it } from 'vitest'
import {
  SILENCE_AUTO_STOP_SECONDS,
  SILENCE_COUNTDOWN_START_SECONDS,
  formatRecordingTime,
  getSilenceCountdownSeconds,
  microphoneLevelToBars,
  shouldWarnSilence,
} from '../../src/lib/audio-feedback'

describe('录音反馈兼容导出', () => {
  it('保留既有录音时间、音量和静音告警行为', () => {
    expect(formatRecordingTime(65)).toBe('01:05')
    expect(microphoneLevelToBars(0.5)).toBe(4)
    expect(shouldWarnSilence(4, false)).toBe(true)
  })
})

describe('静音自动结束倒计时', () => {
  it('在持续静音10秒时开始倒计时3秒', () => {
    expect(SILENCE_COUNTDOWN_START_SECONDS).toBe(10)
    expect(SILENCE_AUTO_STOP_SECONDS).toBe(13)
    expect(getSilenceCountdownSeconds(9.99, true)).toBeNull()
    expect(getSilenceCountdownSeconds(10, true)).toBe(3)
    expect(getSilenceCountdownSeconds(11, true)).toBe(2)
    expect(getSilenceCountdownSeconds(12, true)).toBe(1)
  })

  it('在13秒到0，并在更久静音时保持0', () => {
    expect(getSilenceCountdownSeconds(13, true)).toBe(0)
    expect(getSilenceCountdownSeconds(14, true)).toBe(0)
  })
  it('计量不可用或非有效数字时返回null', () => {
    expect(getSilenceCountdownSeconds(11, false)).toBeNull()
    expect(getSilenceCountdownSeconds(Number.NaN, true)).toBeNull()
  })
})
