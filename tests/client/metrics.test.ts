import { describe, expect, it } from 'vitest'
import { buildSessionReport, createRoundRecord, duration } from '../../src/lib/metrics'
import type { RedoRecord, SessionScenario } from '../../src/types'

const scenario: Pick<SessionScenario, 'id' | 'version' | 'variantId' | 'reveal'> = {
  id: 'dynamic-bank',
  version: 3,
  variantId: 'dynamic-variant',
  reveal: { titleZh: '银行开户', summaryZh: '询问开户材料。' },
}

describe('session metrics and export facts', () => {
  it('calculates observable intervals without inventing missing values', () => {
    expect(duration(1_000, 1_760)).toBe(760)
    expect(duration(null, 1_760)).toBeNull()
    expect(duration(2_000, 1_900)).toBe(0)
  })

  it('keeps listening and expression scaffolds separate and exports redo independently', () => {
    const first = createRoundRecord(1, '必要な書類はお持ちですか。', 1)
    first.listeningScaffoldLevel = 2
    first.transcriptRevealed = true
    first.expressionScaffoldLevel = 3
    first.ttsReplayCount = 2
    first.transcriptModificationCount = 1
    first.timing.audioCompletedAt = 1_000
    first.timing.firstSpeechAt = 1_600
    first.failureCount = 2
    first.retryCount = 1
    first.speechAssistEvents.push(
      {
        turn: 1,
        requestVersion: 1,
        observedTextJa: '口座を',
        cleanedObservedTextJa: '口座を',
        continuationSuggestionJa: '開設したいです。',
        displayed: true,
        latencyMs: 240,
        failureReason: null,
      },
      {
        turn: 1,
        requestVersion: 2,
        observedTextJa: '口座を開設したいです。',
        cleanedObservedTextJa: null,
        continuationSuggestionJa: null,
        displayed: false,
        latencyMs: 1_500,
        failureReason: 'timeout',
      },
    )

    const second = createRoundRecord(2, '住所を確認してもよろしいですか。', 0)
    second.expressionScaffoldLevel = 1
    second.timing.audioCompletedAt = 5_000
    second.timing.firstSpeechAt = 5_800
    second.failureCount = 1
    second.retryCount = 2
    second.speechAssistEvents.push({
      turn: 2,
      requestVersion: 1,
      observedTextJa: 'はい',
      cleanedObservedTextJa: 'はい',
      continuationSuggestionJa: null,
      displayed: false,
      latencyMs: 180,
      failureReason: null,
    })

    const redo: RedoRecord = {
      turn: 1,
      partnerPromptJa: first.aiPrompt,
      firstConfirmedJa: 'はい。',
      secondConfirmedJa: 'はい、パスポートと在留カードを持っています。',
      inputMode: 'text',
      listeningScaffoldLevel: 1,
      expressionScaffoldLevel: 2,
      comparisonZh: '第二稿补充了具体材料。',
      referenceExpressionJa: 'パスポートと在留カードを持参しました。',
    }

    const report = buildSessionReport('session-id', 'real', scenario, 1_000, 9_000, [first, second], [redo], 'user_exit')
    expect(report.rounds[0].listeningScaffoldLevel).toBe(2)
    expect(report.rounds[0].expressionScaffoldLevel).toBe(3)
    expect(report.totals.expressionScaffoldLevelTotal).toBe(4)
    expect(report.totals.expressionScaffoldRoundsCount).toBe(2)
    expect(report.redos).toEqual([redo])
    expect(report.completion).toEqual({
      maxTurns: 5,
      finalTurn: 2,
      reason: 'user_exit',
      closedNaturally: false,
    })
    expect(report.recovery).toEqual({
      failureCount: 3,
      retryCount: 3,
      speechAssistRequestCount: 3,
      speechAssistDisplayedCount: 1,
    })
    expect(report.rounds[0].userFinal).not.toBe(redo.secondConfirmedJa)
  })

  it('仅在最终回合达到五回合预算时标记自然结束', () => {
    const fifth = createRoundRecord(5, '最後に確認したいことはありますか。', 0)
    const report = buildSessionReport('complete-session', 'mock', scenario, 2_000, 8_000, [fifth], [], 'turn_budget')

    expect(report.completion).toEqual({
      maxTurns: 5,
      finalTurn: 5,
      reason: 'turn_budget',
      closedNaturally: true,
    })
    expect(report.recovery).toEqual({
      failureCount: 0,
      retryCount: 0,
      speechAssistRequestCount: 0,
      speechAssistDisplayedCount: 0,
    })
  })

  it('preserves an unrecoverable termination reason without marking it natural', () => {
    const report = buildSessionReport('failed-session', 'mock', scenario, 2_000, 8_000, [createRoundRecord(1, scenario.firstLine, 0)], [], 'unrecoverable_failure')

    expect(report.completion).toEqual({
      maxTurns: 5,
      finalTurn: 1,
      reason: 'unrecoverable_failure',
      closedNaturally: false,
    })
  })
})
