import { describe, expect, it, vi } from 'vitest'
import {
  FeedbackResponseSchema,
  buildFeedbackRequestPayload,
  requestConversationFeedback,
  requestRedoFeedback,
} from '../../src/lib/api'
import { createRoundRecord } from '../../src/lib/metrics'
import type { ConversationFeedbackResponse } from '../../src/types'

const response: ConversationFeedbackResponse = {
  outcome: 'partial',
  outcomeEvidenceZh: '用户完成了主要询问，但没有确认最后一项条件。',
  listeningFinding: {
    turn: 2,
    findingZh: '第二轮展开台词后才确认对方的问题。',
    evidenceZh: '该轮记录了台词展开，确认稿回答了问题中的日期。',
  },
  expressionImprovement: {
    turn: 3,
    userConfirmedJa: '来週できます。',
    suggestedJa: '来週でしたら対応できます。',
    reasonZh: '补充条件形式后，与对方协商时更明确。',
  },
  redoTask: {
    turn: 3,
    partnerPromptJa: '来週はいつ対応できますか。',
    firstConfirmedJa: '来週できます。',
    directionZh: '说明具体日期，并保留协商余地。',
  },
}

describe('conversation feedback client contract', () => {
  it('sends every observable turn fact in the dynamic-only payload', () => {
    const round = createRoundRecord(1, 'ご希望の日程を教えてください。', 1)
    round.userOriginal = 'らいしゅう げつようび'
    round.userCleaned = '来週月曜日'
    round.userFinal = '来週の月曜日でお願いします。'
    round.inputMode = 'text'
    round.transcriptModified = true
    round.ttsReplayCount = 2
    round.transcriptRevealed = true
    round.listeningScaffoldLevel = 2
    round.expressionScaffoldLevel = 3
    round.failureCount = 1
    round.retryCount = 2
    round.timing.audioStartedAt = 100

    expect(buildFeedbackRequestPayload({ sessionToken: 'session-token' }, [round])).toEqual({
      scenarioType: 'dynamic',
      sessionToken: 'session-token',
      turnRecords: [{
        turn: 1,
        partnerPromptJa: 'ご希望の日程を教えてください。',
        userOriginal: 'らいしゅう げつようび',
        userCleaned: '来週月曜日',
        userConfirmed: '来週の月曜日でお願いします。',
        inputMode: 'text',
        transcriptModified: true,
        rerecordCount: 1,
        partnerAudioPlayCount: 3,
        ttsReplayCount: 2,
        transcriptRevealed: true,
        listeningScaffoldLevel: 2,
        expressionScaffoldLevel: 3,
        failureCount: 1,
        retryCount: 2,
        textFallback: true,
        speechAssistUsed: false,
      }],
    })
  })

  it('validates the five-part feedback and rejects forbidden ability claims', () => {
    expect(FeedbackResponseSchema.parse(response)).toEqual(response)
    expect(() => FeedbackResponseSchema.parse({ ...response, outcomeEvidenceZh: '日语能力等级提高了。' })).toThrow()
  })

  it('posts feedback and redo requests to their separate endpoints', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(response), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ comparisonZh: '第二稿补充了日期。', referenceExpressionJa: '来週の月曜日でしたら対応できます。' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const round = createRoundRecord(1, 'いつがいいですか。', 0)
    round.userFinal = '月曜日です。'

    await requestConversationFeedback({ sessionToken: 'session-token' }, [round])
    await requestRedoFeedback({
      scenarioType: 'dynamic',
      sessionToken: 'session-token',
      turn: 1,
      partnerPromptJa: 'いつがいいですか。',
      firstConfirmedJa: '月曜日です。',
      secondConfirmedJa: '月曜日でお願いします。',
      secondInputMode: 'text',
      secondListeningScaffoldLevel: 1,
      secondExpressionScaffoldLevel: 2,
    })

    expect(fetchMock.mock.calls[0][0]).toBe('/api/conversation/feedback')
    expect(fetchMock.mock.calls[1][0]).toBe('/api/conversation/redo-feedback')
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string).secondConfirmedJa).toBe('月曜日でお願いします。')
    vi.unstubAllGlobals()
  })
})
