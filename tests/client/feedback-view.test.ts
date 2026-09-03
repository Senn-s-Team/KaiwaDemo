import { describe, expect, it } from 'vitest'
import { mapImprovementsByTurn, formatImprovementType, getRoundForTurn } from '../../src/lib/feedback'
import type { FeedbackImprovement, RoundRecord } from '../../src/types'
import { createRoundRecord } from '../../src/lib/metrics'

describe('feedback helpers and view models', () => {
  it('mapImprovementsByTurn correctly indexes multiple improvements by turn', () => {
    const improvements: FeedbackImprovement[] = [
      {
        turn: 1,
        type: 'grammar_fix',
        originalQuoteJa: '映画を見ました',
        suggestedJa: '映画を観ました',
        reasonZh: '用字建议',
      },
      {
        turn: 2,
        type: 'naturalness_upgrade',
        originalQuoteJa: '面白かったです',
        suggestedJa: 'すごく面白かったです',
        reasonZh: '地道口语',
      },
      {
        turn: 2,
        type: 'grammar_fix',
        originalQuoteJa: 'いい天気でした',
        suggestedJa: 'いい天気でしたね',
        reasonZh: '语气词',
      },
    ]

    const mapped = mapImprovementsByTurn(improvements)
    expect(mapped[1]).toHaveLength(1)
    expect(mapped[1][0].type).toBe('grammar_fix')
    expect(mapped[2]).toHaveLength(2)
    expect(mapped[2][0].type).toBe('naturalness_upgrade')
    expect(mapped[3]).toBeUndefined()
  })

  it('formatImprovementType returns user-friendly label', () => {
    expect(formatImprovementType('grammar_fix')).toBe('语法修正')
    expect(formatImprovementType('naturalness_upgrade')).toBe('地道表达')
  })

  it('getRoundForTurn matches corresponding RoundRecord or undefined', () => {
    const r1 = createRoundRecord(1, 'こんにちは', 0)
    const r2 = createRoundRecord(2, 'お元気ですか', 1)
    const rounds: RoundRecord[] = [r1, r2]

    expect(getRoundForTurn(rounds, 1)).toEqual(r1)
    expect(getRoundForTurn(rounds, 2)).toEqual(r2)
    expect(getRoundForTurn(rounds, 3)).toBeUndefined()
  })

  it('handles empty improvements array gracefully', () => {
    const mapped = mapImprovementsByTurn([])
    expect(mapped).toEqual({})
  })
})
