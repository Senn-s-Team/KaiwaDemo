/**
 * [INPUT]: 反馈请求构造器、回合记录与 durable feedback task wire schema
 * [OUTPUT]: 验证确认稿事实传递及持久任务的提交、查询客户端契约
 * [POS]: tests/client 的反馈任务提交与查询契约测试
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { describe, expect, it, vi } from 'vitest'
import { buildFeedbackRequestPayload, getFeedbackTask, submitFeedbackTask } from '../../src/lib/api'
import { createRoundRecord } from '../../src/lib/metrics'
import {
  ConversationFeedbackResponseSchema,
  FeedbackTaskAcceptedSchema,
  FeedbackTaskStatusSchema,
  RedoFeedbackResponseSchema,
  type FeedbackTaskRequest,
} from '../../shared/feedback-task'

const response = {
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

  it('only reports displayed continuation suggestions as expression assistance', () => {
    const round = createRoundRecord(1, 'ご希望は？', 0)
    round.speechAssistEvents = [{
      turn: 1, requestVersion: 1, observedTextJa: 'あの予約', cleanedObservedTextJa: '予約',
      continuationSuggestionJa: null, displayed: true, latencyMs: 100, failureReason: null,
    }]
    const used = () => buildFeedbackRequestPayload({ sessionToken: 'session-token' }, [round]).turnRecords[0].speechAssistUsed
    expect(used()).toBe(false)
    round.speechAssistEvents[0].continuationSuggestionJa = 'お願いしたいのですが'
    expect(used()).toBe(true)
    round.speechAssistEvents[0].displayed = false
    expect(used()).toBe(false)
  })

  it('validates the five-part feedback and rejects forbidden ability claims', () => {
    expect(ConversationFeedbackResponseSchema.parse(response)).toEqual(response)
    expect(() => ConversationFeedbackResponseSchema.parse({ ...response, outcomeEvidenceZh: '日语能力等级提高了。' })).toThrow()
    expect(RedoFeedbackResponseSchema.parse({ comparisonZh: '第二稿补充了日期。', referenceExpressionJa: '来週の月曜日でしたら対応できます。' })).toEqual({ comparisonZh: '第二稿补充了日期。', referenceExpressionJa: '来週の月曜日でしたら対応できます。' })
  })

  it('submits and queries conversation and redo durable tasks', async () => {
    const conversationRequest: FeedbackTaskRequest = {
      kind: 'conversation', requestId: 'a1111111-1111-4111-8111-111111111111', createdAt: 1,
      payload: {
        scenarioType: 'dynamic', sessionToken: 'session-token', turnRecords: [{
          turn: 1, partnerPromptJa: 'いつがいいですか。', userOriginal: '月曜日です。', userCleaned: '月曜日です。', userConfirmed: '月曜日です。',
          inputMode: 'text', transcriptModified: false, rerecordCount: 0, partnerAudioPlayCount: 0, ttsReplayCount: 0,
          transcriptRevealed: false, listeningScaffoldLevel: 0, expressionScaffoldLevel: 0, failureCount: 0, retryCount: 0, textFallback: true, speechAssistUsed: false,
        }],
      },
    }
    const redoRequest: FeedbackTaskRequest = {
      kind: 'redo', requestId: 'b2222222-2222-4222-8222-222222222222', createdAt: 2,
      payload: {
        scenarioType: 'dynamic', sessionToken: 'session-token', turn: 1, partnerPromptJa: 'いつがいいですか。',
        firstConfirmedJa: '月曜日です。', secondConfirmedJa: '月曜日でお願いします。', secondInputMode: 'text', secondListeningScaffoldLevel: 1, secondExpressionScaffoldLevel: 2,
      },
    }
    const acceptedConversation = FeedbackTaskAcceptedSchema.parse({ taskToken: 'conversation-task-token', expiresAt: 86_400_001 })
    const acceptedRedo = FeedbackTaskAcceptedSchema.parse({ taskToken: 'redo-task-token', expiresAt: 86_400_002 })
    const conversationStatus = FeedbackTaskStatusSchema.parse({ status: 'complete', kind: 'conversation', result: response })
    const redoStatus = FeedbackTaskStatusSchema.parse({ status: 'complete', kind: 'redo', result: { comparisonZh: '第二稿补充了日期。', referenceExpressionJa: '来週の月曜日でしたら対応できます。' } })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(acceptedConversation), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(conversationStatus), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(acceptedRedo), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(redoStatus), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(submitFeedbackTask(conversationRequest)).resolves.toEqual(acceptedConversation)
    await expect(getFeedbackTask(acceptedConversation.taskToken)).resolves.toEqual(conversationStatus)
    await expect(submitFeedbackTask(redoRequest)).resolves.toEqual(acceptedRedo)
    await expect(getFeedbackTask(acceptedRedo.taskToken)).resolves.toEqual(redoStatus)

    expect(fetchMock.mock.calls[0][0]).toBe('/api/feedback/tasks')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual(conversationRequest)
    expect(fetchMock.mock.calls[1][0]).toBe('/api/feedback/tasks')
    expect(fetchMock.mock.calls[1][1].headers).toMatchObject({ authorization: 'Bearer conversation-task-token' })
    expect(fetchMock.mock.calls[2][0]).toBe('/api/feedback/tasks')
    expect(JSON.parse(fetchMock.mock.calls[2][1].body as string)).toEqual(redoRequest)
    expect(fetchMock.mock.calls[3][0]).toBe('/api/feedback/tasks')
    expect(fetchMock.mock.calls[3][1].headers).toMatchObject({ authorization: 'Bearer redo-task-token' })
    vi.unstubAllGlobals()
  })
})
