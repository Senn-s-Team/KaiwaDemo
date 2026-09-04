import { describe, expect, it } from 'vitest'
import { getExpressionPrimers } from '../../src/data/expression-primers'
import { VOCAB_BANK } from '../../src/data/vocab-bank'

describe('getExpressionPrimers theme matching', () => {
  it('returns cafe primers when dynamic scenario title is about cafe', () => {
    const primers = getExpressionPrimers('dynamic', undefined, {
      titleZh: '咖啡定制',
      summaryZh: '在小型独立咖啡馆向店主描述口味偏好',
      aiRole: '咖啡爱好者店主',
      tone: '丁寧語',
    })
    expect(primers).toHaveLength(3)
    expect(primers[0].phraseJa).toContain('甘さ控えめ')
    expect(primers[1].phraseJa).toContain('おすすめ')
    expect(primers[2].phraseJa).toContain('テイクアウト')
  })

  it('returns train delay primers when title contains 电车延误', () => {
    const primers = getExpressionPrimers('dynamic', undefined, {
      titleZh: '电车延误',
      summaryZh: '询问替代路线并索取延误证明',
      aiRole: '忙碌但尽职的站务员',
      tone: '丁寧語',
    })
    expect(primers).toHaveLength(3)
    expect(primers.some((p) => p.phraseJa.includes('遅延証明'))).toBe(true)
  })

  it('uses activeSpark scenario directly if provided', () => {
    const spark = VOCAB_BANK.find((v) => v.id === 'daily-salon')
    expect(spark).toBeDefined()
    const primers = getExpressionPrimers('dynamic', undefined, null, spark)
    expect(primers).toHaveLength(3)
    expect(primers[0].phraseJa).toContain('短め')
  })

  it('returns catalog fixed primers for fixed catalog scenario', () => {
    const primers = getExpressionPrimers('weekend-chat', 'casual-coworker', null)
    expect(primers).toHaveLength(3)
    expect(primers[0].phraseJa).toContain('のんびり')
  })
})
