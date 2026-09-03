import { describe, expect, it } from 'vitest'
import { buildSessionReport, createRoundRecord, duration } from '../../src/lib/metrics'
import type { SessionScenario } from '../../src/types'

const scenario: Pick<SessionScenario, 'id' | 'version' | 'variantId' | 'reveal'> = {
  id: 'p0-cafe',
  version: 3,
  variantId: 'weekday',
  reveal: { titleZh: '咖啡店点单', summaryZh: '完成一次点单交流。' },
}

describe('session metrics', () => {
  it('calculates observable latency intervals without inventing missing values', () => {
    expect(duration(1_000, 1_760)).toBe(760)
    expect(duration(null, 1_760)).toBeNull()
    expect(duration(2_000, 1_900)).toBe(0)
  })

  it('aggregates counts and preserves unavailable token usage as null', () => {
    const first = createRoundRecord(1, '週末は何をしましたか？', 1)
    first.ttsReplayCount = 2
    first.sttSessionCount = 2
    first.sttAudioMilliseconds = 4_321
    first.llmRequestCount = 1
    first.ttsRequestCount = 1
    first.ttsCharacterCount = 24
    first.failureCount = 1
    first.retryCount = 1
    first.usage = { inputTokens: 82, outputTokens: 19, totalTokens: 101 }
    first.hintLevelUsed = 2
    first.transcriptModificationCount = 1
    first.timing.audioCompletedAt = 1_000
    first.timing.firstSpeechAt = 1_600

    const second = createRoundRecord(2, 'どこに行きましたか？', 0)
    second.hintLevelUsed = 0
    second.transcriptModificationCount = 0
    second.timing.audioCompletedAt = 5_000
    second.timing.firstSpeechAt = 5_800
    second.usage = { inputTokens: null, outputTokens: null, totalTokens: null }

    const report = buildSessionReport('abcdef1234567890', 'real', scenario, 'completed', 1_000, 9_000, [first, second])
    expect(report.durationMilliseconds).toBe(8_000)
    expect(report).toMatchObject({
      scenarioId: 'p0-cafe',
      scenarioVersion: 3,
      variantId: 'weekday',
      reveal: scenario.reveal,
      selfAssessment: 'completed',
    })
    expect(report.totals).toMatchObject({
      rerecordCount: 1,
      ttsReplayCount: 2,
      sttSessionCount: 2,
      sttAudioMilliseconds: 4_321,
      llmRequestCount: 1,
      ttsRequestCount: 1,
      ttsCharacterCount: 24,
      failureCount: 1,
      retryCount: 1,
      inputTokens: 82,
      outputTokens: 19,
      hintLevelTotal: 2,
      hintRoundsCount: 1,
      transcriptModificationCount: 1,
      avgSpeechStartLatencyMs: 700,
    })
  })
})
