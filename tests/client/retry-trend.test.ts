import { describe, expect, it } from 'vitest'
import { buildPracticeTrend } from '../../src/lib/trend'
import { buildSessionReport, createRoundRecord, createTiming } from '../../src/lib/metrics'
import type { RoundRecord, SessionScenario } from '../../src/types'

describe('retry-trend and practice comparison tests', () => {
  const scenario: Pick<SessionScenario, 'id' | 'version' | 'variantId' | 'reveal'> = {
    id: 'dynamic-hotel-checkin',
    version: 1,
    variantId: 'dynamic-variant',
    reveal: { titleZh: '酒店办理入住', summaryZh: '完成入住与早餐询问。' },
  }

  const timing = createTiming()

  const roundsFirst: RoundRecord[] = [
    {
      ...createRoundRecord(1, 'いらっしゃいませ。', 1),
      userOriginal: 'いえで みました',
      userCleaned: '家で見ました。',
      userFinal: '家で日本の映画を見ました。',
      hintLevelUsed: 2,
      transcriptModified: true,
      transcriptModificationCount: 1,
      timing: {
        ...timing,
        recordingStartedAt: 1000,
        firstSpeechAt: 2500, // latency 1500ms
        audioCompletedAt: 900,
      },
    },
    {
      ...createRoundRecord(2, 'どんな映画でしたか？', 1),
      userOriginal: 'おもしろかったです',
      userCleaned: '面白かったです。',
      userFinal: '面白かったです。',
      hintLevelUsed: 3,
      transcriptModified: false,
      transcriptModificationCount: 0,
      timing: {
        ...timing,
        recordingStartedAt: 5000,
        firstSpeechAt: 7000, // latency 2000ms
        audioCompletedAt: 4800,
      },
    },
  ]

  const reportFirst = buildSessionReport('s1', 'real', scenario, 'partial', 1000, 10000, roundsFirst)

  const roundsSecond: RoundRecord[] = [
    {
      ...createRoundRecord(1, 'いらっしゃいませ。', 0),
      userOriginal: 'チェックインお願いします',
      userCleaned: 'チェックインお願いします。',
      userFinal: 'チェックインお願いします。',
      hintLevelUsed: 0,
      transcriptModified: false,
      transcriptModificationCount: 0,
      timing: {
        ...timing,
        recordingStartedAt: 1000,
        firstSpeechAt: 1800, // latency 800ms
        audioCompletedAt: 900,
      },
    },
    {
      ...createRoundRecord(2, 'どんな映画でしたか？', 0),
      userOriginal: 'ストーリーが良かったです',
      userCleaned: 'ストーリーが良かったです。',
      userFinal: 'ストーリーが良かったです。',
      hintLevelUsed: 1,
      transcriptModified: false,
      transcriptModificationCount: 0,
      timing: {
        ...timing,
        recordingStartedAt: 5000,
        firstSpeechAt: 6000, // latency 1000ms
        audioCompletedAt: 4800,
      },
    },
  ]

  const reportSecond = buildSessionReport('s2', 'real', scenario, 'completed', 20000, 27000, roundsSecond)

  it('buildSessionReport computes correct new totals', () => {
    expect(reportFirst.totals.rerecordCount).toBe(2)
    expect(reportFirst.totals.hintLevelTotal).toBe(5)
    expect(reportFirst.totals.hintRoundsCount).toBe(2)
    expect(reportFirst.totals.transcriptModificationCount).toBe(1)
    expect(reportFirst.totals.avgSpeechStartLatencyMs).toBe(1750)

    expect(reportSecond.totals.rerecordCount).toBe(0)
    expect(reportSecond.totals.hintLevelTotal).toBe(1)
    expect(reportSecond.totals.hintRoundsCount).toBe(1)
    expect(reportSecond.totals.transcriptModificationCount).toBe(0)
    expect(reportSecond.totals.avgSpeechStartLatencyMs).toBe(900)
  })

  it('buildPracticeTrend returns empty trend when previous report is null', () => {
    const trend = buildPracticeTrend(null, reportFirst)
    expect(trend.hasPrevious).toBe(false)
    expect(trend.metrics).toHaveLength(0)
    expect(trend.narrativeZh).toContain('第一次练习')
  })

  it('buildPracticeTrend computes positive direction when performance improves in second run', () => {
    const trend = buildPracticeTrend(reportFirst, reportSecond)
    expect(trend.hasPrevious).toBe(true)
    const latencyMetric = trend.metrics.find((m) => m.labelZh === '平均回答启动时间')
    expect(latencyMetric?.previousDisplay).toBe('1.8 秒')
    expect(latencyMetric?.currentDisplay).toBe('0.9 秒')
    expect(latencyMetric?.deltaDisplay).toMatch(/快 0\.[89] 秒/)
    expect(latencyMetric?.direction).toBe('better')

    const rerecordMetric = trend.metrics.find((m) => m.labelZh === '重录次数')
    expect(rerecordMetric?.deltaDisplay).toBe('减少 2 次')
    expect(rerecordMetric?.direction).toBe('better')
    const hintMetric = trend.metrics.find((m) => m.labelZh === '提示使用轮数')
    expect(hintMetric?.deltaDisplay).toBe('减少 1 轮')
    expect(hintMetric?.direction).toBe('better')

    const modMetric = trend.metrics.find((m) => m.labelZh === '转写修改次数')
    expect(modMetric?.deltaDisplay).toBe('减少 1 次')
    expect(modMetric?.direction).toBe('better')

    expect(trend.narrativeZh).toContain('第二次练习呈现积极趋势')
  })

  it('handles missing latency gracefully without breaking', () => {
    const noLatencyRounds: RoundRecord[] = [
      createRoundRecord(1, 'こんにちは', 0),
    ]
    const reportNoLatency = buildSessionReport('s3', 'real', scenario, null, 1000, 5000, noLatencyRounds)
    expect(reportNoLatency.totals.avgSpeechStartLatencyMs).toBeNull()

    const trend = buildPracticeTrend(reportFirst, reportNoLatency)
    const latencyMetric = trend.metrics.find((m) => m.labelZh === '平均回答启动时间')
    expect(latencyMetric?.currentDisplay).toBe('未记录')
    expect(latencyMetric?.deltaDisplay).toBe('—')
  })
})
