/**
 * [INPUT]: audio-feedback 录音反馈与静音保全提示纯规则
 * [OUTPUT]: 锁定录音时间、音量映射、静音警告与静音保全提示阈值契约
 * [POS]: tests/client 的录音反馈纯规则回归
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { describe, expect, it } from 'vitest'
import {
  SILENCE_PROMPT_SECONDS,
  formatRecordingTime,
  microphoneLevelToBars,
  shouldShowSilencePrompt,
  shouldWarnSilence,
} from '../../src/lib/audio-feedback'

describe('录音反馈兼容导出', () => {
  it('保留既有录音时间、音量和静音告警行为', () => {
    expect(formatRecordingTime(65)).toBe('01:05')
    expect(microphoneLevelToBars(0.5)).toBe(4)
    expect(shouldWarnSilence(4, false)).toBe(true)
  })
})

describe('静音保全提示', () => {
  it('在持续静音10秒后显示提示', () => {
    expect(SILENCE_PROMPT_SECONDS).toBe(10)
    expect(shouldShowSilencePrompt(9.99, true)).toBe(false)
    expect(shouldShowSilencePrompt(10, true)).toBe(true)
    expect(shouldShowSilencePrompt(11, true)).toBe(true)
  })

  it('在计量不可用或静音时长无效时不显示提示', () => {
    expect(shouldShowSilencePrompt(10, false)).toBe(false)
    expect(shouldShowSilencePrompt(Number.NaN, true)).toBe(false)
  })
})
