/**
 * [INPUT]: shared feedback task wire contract 与 Node 可导入 durable task handler
 * [OUTPUT]: 验证严格 envelope、能力凭据边界及 Workflow 适配器行为
 * [POS]: tests/worker 的反馈 durable task 契约测试
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { describe, expect, it } from 'vitest'
import { FeedbackTaskRequestSchema, FeedbackTaskStatusSchema } from '../../shared/feedback-task'
import { handleFeedbackTaskPost } from '../../worker/feedback-task'
import type { Env } from '../../worker/env'

class FakeWorkflow {
  creates = 0
  async create(): Promise<never> { this.creates += 1; throw new Error('should not create') }
  async get(): Promise<never> { throw new Error('not found') }
}
const validEnvelope = {
  kind: 'conversation' as const,
  requestId: '11111111-1111-4111-8111-111111111111',
  createdAt: Date.now(),
  payload: {
    scenarioType: 'dynamic' as const,
    sessionToken: 'malformed-session',
    turnRecords: [{
      turn: 1, partnerPromptJa: 'こんにちは', userOriginal: 'こんにちは', userCleaned: 'こんにちは', userConfirmed: 'こんにちは',
      inputMode: 'stt' as const, transcriptModified: false, rerecordCount: 0, partnerAudioPlayCount: 1, ttsReplayCount: 0,
      transcriptRevealed: false, listeningScaffoldLevel: 0 as const, expressionScaffoldLevel: 0 as const,
      failureCount: 0, retryCount: 0, textFallback: false, speechAssistUsed: false,
    }],
  },
}

describe('feedback task shared contract', () => {
  it('accepts only the discriminated conversation/redo envelope', () => {
    expect(FeedbackTaskRequestSchema.safeParse({ kind: 'conversation', requestId: 'bad' }).success).toBe(false)
    expect(FeedbackTaskStatusSchema.safeParse({ status: 'pending' }).success).toBe(true)
    expect(FeedbackTaskStatusSchema.safeParse({ status: 'complete', kind: 'unknown', result: {} }).success).toBe(false)
  })

  it('does not schedule malformed submissions', async () => {
    const workflow = new FakeWorkflow()
    const env = { SCENARIO_SIGNING_SECRET: 'test-secret', FEEDBACK_TASK: workflow } as unknown as Env
    const request = new Request('https://kaiwa.example/api/feedback/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'conversation' }),
    })
    const response = await handleFeedbackTaskPost(request, env)
    expect(response.status).toBe(400)
    expect(workflow.creates).toBe(0)
  })

  it('returns 401 for malformed session credentials without retryable 503', async () => {
    const workflow = new FakeWorkflow()
    const env = { SCENARIO_SIGNING_SECRET: 'test-secret', FEEDBACK_TASK: workflow } as unknown as Env
    const request = new Request('https://kaiwa.example/api/feedback/tasks', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(validEnvelope),
    })
    const response = await handleFeedbackTaskPost(request, env)
    expect(response.status).toBe(401)
    expect(workflow.creates).toBe(0)
  })
})
