/**
 * [INPUT]: 依赖首页中文 STT 的纯生命周期规则
 * [OUTPUT]: 验证既有场景文字、迟到结果、取消离页、冲突切换与 300 字上限
 * [POS]: tests/client 的首页中文 STT 回归契约，不依赖真实麦克风或 ElevenLabs
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { describe, expect, it } from 'vitest'
import {
  appendHomeSttText,
  HOME_STT_MAX_LENGTH,
  shouldApplyHomeSttResult,
  shouldCancelHomeSttForTransition,
} from '../../src/lib/home-stt'

describe('home Chinese STT lifecycle', () => {
  it('appends a completed Chinese recognition result without replacing existing scenario text', () => {
    expect(appendHomeSttText('预约理发', '不要露出额头')).toEqual({ text: '预约理发\n不要露出额头', applied: true })
  })

  it('rejects late results after cancellation or page exit', () => {
    expect(shouldApplyHomeSttResult(4, 5)).toBe(false)
    expect(shouldApplyHomeSttResult(5, 5, true)).toBe(false)
    expect(shouldApplyHomeSttResult(5, 5)).toBe(true)
  })

  it('keeps all existing text when a recognition result would exceed the 300-character scenario contract', () => {
    const existing = '已写内容'.repeat(75)
    expect(existing).toHaveLength(HOME_STT_MAX_LENGTH)
    expect(appendHomeSttText(existing, '新的识别结果')).toEqual({ text: existing, applied: false })
  })

  it('requires active recording to be cancelled before ready, clarification, or draft transitions', () => {
    expect(shouldCancelHomeSttForTransition(true, false, false)).toBe(true)
    expect(shouldCancelHomeSttForTransition(false, true, false)).toBe(true)
    expect(shouldCancelHomeSttForTransition(false, false, true)).toBe(true)
    expect(shouldCancelHomeSttForTransition(false, false, false)).toBe(false)
  })
})
