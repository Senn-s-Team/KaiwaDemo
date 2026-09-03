import { describe, expect, it, vi } from 'vitest'
import {
  FeedbackResponseSchema,
  buildFeedbackRequestPayload,
  requestConversationFeedback,
} from '../../src/lib/api'
import { createRoundRecord, createTiming } from '../../src/lib/metrics'
import type {
  ConversationFeedbackResponse,
  ConversationMessage,
  RoundRecord,
  SessionScenario,
} from '../../src/types'

describe('feedback-data & metrics tests', () => {
  const sampleTiming = createTiming()

  const sampleRounds: RoundRecord[] = [
    {
      ...createRoundRecord(1, '週末は何をして過ごしたんですか？', 0),
      userOriginal: 'いえで にほんの えいがを みました',
      userCleaned: '家で日本の映画を見ました。',
      userFinal: '家で日本の映画を見ました。',
      hintLevelUsed: 0,
      timing: { ...sampleTiming, firstSpeechAt: 123456 },
    },
    {
      ...createRoundRecord(2, 'どんな映画でしたか？', 1),
      userOriginal: 'あにめえいがで おもしろかったです',
      userCleaned: 'アニメ映画で、とても面白かったです。',
      userFinal: 'アニメ映画で、とても面白かったです。',
      hintLevelUsed: 2,
      timing: { ...sampleTiming, firstSpeechAt: 234567 },
    },
  ]

  const sampleMessages: ConversationMessage[] = [
    { id: 'm1', turn: 1, role: 'assistant', text: '週末は何をして過ごしたんですか？' },
    {
      id: 'm2',
      turn: 1,
      role: 'user',
      text: '家で日本の映画を見ました。',
      transcript: {
        rawText: 'いえで にほんの えいがを みました',
        cleanedText: '家で日本の映画を見ました。',
        finalText: '家で日本の映画を見ました。',
      },
    },
    { id: 'm3', turn: 2, role: 'assistant', text: 'どんな映画でしたか？' },
    {
      id: 'm4',
      turn: 2,
      role: 'user',
      text: 'アニメ映画で、とても面白かったです。',
      transcript: {
        rawText: 'あにめえいがで おもしろかったです',
        cleanedText: 'アニメ映画で、とても面白かったです。',
        finalText: 'アニメ映画で、とても面白かったです。',
      },
    },
  ]

  const sampleFeedbackResponse: ConversationFeedbackResponse = {
    isGoalCompleted: true,
    goalSummaryZh: '成功分享了周末观影经历，交流顺畅且准确传达了感想。',
    strengths: [
      {
        quoteJa: '家で日本の映画を見ました。',
        praiseZh: '准确使用了场所助词「で」和宾格助词「を」，叙述清晰。',
      },
      {
        quoteJa: 'アニメ映画で、とても面白かったです。',
        praiseZh: '使用「で」连接名词句和形容词句，表达连贯。',
      },
    ],
    improvements: [
      {
        turn: 2,
        type: 'naturalness_upgrade',
        originalQuoteJa: 'アニメ映画で、とても面白かったです。',
        suggestedJa: 'アニメの映画を見たんですが、すごく面白かったです。',
        reasonZh: '口语中使用「〜んですが」前置铺垫可以让语感更加地道自然。',
      },
    ],
    reusableExpressions: [
      {
        patternJa: '〜で、〜かったです',
        meaningZh: '用于罗列原因、背景并陈述过去体验的感受。',
        usageExampleJa: '友達と一緒で、とても楽しかったです。',
      },
      {
        patternJa: '〜を見たんですが',
        meaningZh: '在口语中提及某物作为话题引子。',
        usageExampleJa: '昨日新しい映画を見たんですが、良かったです。',
      },
    ],
    masterUpgrade: {
      turn: 1,
      originalJa: '家で日本の映画を見ました。',
      upgradedJa: '特にどこも出かけず、家でのんびり日本の映画を観て過ごしました。',
      explanationZh: '加入「のんびり〜して過ごす」让周末休闲的氛围感更生动丰富。',
    },
    retryTask: {
      turn: 2,
      targetAiPromptJa: 'どんな映画でしたか？',
      userOriginalJa: 'アニメ映画で、とても面白かったです。',
      recommendedReferenceJa: 'アニメ映画を観たんですが、ストーリーがすごく面白かったです。',
      hintZh: '尝试补充具体哪个方面有趣（如剧情、画面），丰富表达内容。',
    },
  }

  it('buildFeedbackRequestPayload produces correct catalog payload', () => {
    const scenario: Pick<SessionScenario, 'id' | 'variantId' | 'scenarioType' | 'sessionToken'> = {
      id: 'weekend-chat',
      variantId: 'casual-coworker',
      scenarioType: 'catalog',
    }
    const payload = buildFeedbackRequestPayload(scenario, sampleMessages, sampleRounds)
    expect(payload.scenarioType).toBe('catalog')
    if (payload.scenarioType === 'catalog') {
      expect(payload.scenarioId).toBe('weekend-chat')
      expect(payload.variantId).toBe('casual-coworker')
    }
    expect(payload.totalTurns).toBe(2)
    expect(payload.history).toEqual([
      { role: 'assistant', text: '週末は何をして過ごしたんですか？' },
      { role: 'user', text: '家で日本の映画を見ました。' },
      { role: 'assistant', text: 'どんな映画でしたか？' },
      { role: 'user', text: 'アニメ映画で、とても面白かったです。' },
    ])
    expect(payload.transcriptRecords).toEqual([
      {
        turn: 1,
        aiPrompt: '週末は何をして過ごしたんですか？',
        userOriginal: 'いえで にほんの えいがを みました',
        userCleaned: '家で日本の映画を見ました。',
        userFinal: '家で日本の映画を見ました。',
      },
      {
        turn: 2,
        aiPrompt: 'どんな映画でしたか？',
        userOriginal: 'あにめえいがで おもしろかったです',
        userCleaned: 'アニメ映画で、とても面白かったです。',
        userFinal: 'アニメ映画で、とても面白かったです。',
      },
    ])
  })

  it('buildFeedbackRequestPayload produces correct dynamic payload', () => {
    const scenario: Pick<SessionScenario, 'id' | 'variantId' | 'scenarioType' | 'sessionToken'> = {
      id: 'dynamic-hotel-checkin',
      variantId: 'default',
      scenarioType: 'dynamic',
      sessionToken: 'test-session-token-123',
    }
    const payload = buildFeedbackRequestPayload(scenario, sampleMessages, sampleRounds)
    expect(payload.scenarioType).toBe('dynamic')
    if (payload.scenarioType === 'dynamic') {
      expect(payload.sessionToken).toBe('test-session-token-123')
    }
    expect(payload.totalTurns).toBe(2)
    expect(payload.transcriptRecords[0]?.userCleaned).toBe('家で日本の映画を見ました。')
  })

  it('validates valid feedback response schema', () => {
    const parsed = FeedbackResponseSchema.parse(sampleFeedbackResponse)
    expect(parsed.isGoalCompleted).toBe(true)
    expect(parsed.strengths).toHaveLength(2)
    expect(parsed.improvements).toHaveLength(1)
    expect(parsed.reusableExpressions).toHaveLength(2)
    expect(parsed.masterUpgrade.turn).toBe(1)
    expect(parsed.retryTask.turn).toBe(2)
  })

  it('rejects feedback response containing forbidden scoring or pronunciation evaluation', () => {
    const badResponse = {
      ...sampleFeedbackResponse,
      goalSummaryZh: '表现不错，总得分95分。',
    }
    expect(() => FeedbackResponseSchema.parse(badResponse)).toThrow()

    const badPronunciation = {
      ...sampleFeedbackResponse,
      strengths: [
        {
          quoteJa: '家で日本の映画を見ました。',
          praiseZh: '发音非常纯正。',
        },
        sampleFeedbackResponse.strengths[1],
      ],
    }
    expect(() => FeedbackResponseSchema.parse(badPronunciation)).toThrow()
  })

  it('requestConversationFeedback makes POST call and returns validated response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(sampleFeedbackResponse), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const scenario: Pick<SessionScenario, 'id' | 'variantId' | 'scenarioType' | 'sessionToken'> = {
      id: 'weekend-chat',
      variantId: 'casual-coworker',
      scenarioType: 'catalog',
    }

    const result = await requestConversationFeedback(scenario, sampleMessages, sampleRounds)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/conversation/feedback')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string).scenarioId).toBe('weekend-chat')
    expect(result.goalSummaryZh).toBe(sampleFeedbackResponse.goalSummaryZh)

    vi.unstubAllGlobals()
  })

  it('createRoundRecord initializes new fields correctly', () => {
    const round = createRoundRecord(1, 'こんにちは', 0)
    expect(round.userCleaned).toBe('')
    expect(round.hintLevelUsed).toBe(0)
    expect(round.timing.firstSpeechAt).toBeNull()
  })
})
