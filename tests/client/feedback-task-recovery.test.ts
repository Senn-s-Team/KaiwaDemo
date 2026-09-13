/**
 * [INPUT]: 完成复盘快照、feedback task envelope 与可控生命周期/网络依赖
 * [OUTPUT]: 验证完成页恢复、同封套传输续查、HTTP 终态映射、过期清理及迟到结果代际隔离
 * [POS]: tests/client durable completed-review recovery contract
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
// @vitest-environment jsdom
import { createElement, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  COMPLETED_REVIEW_STORAGE_KEY,
  createCompletedReviewRecoveryRuntime,
  createFeedbackTaskRequest,
  type FeedbackTaskRecoveryApi,
  type CompletedReviewRecoveryState,
  type CompletedReviewSnapshot,
} from '../../src/lib/feedback-task-recovery'
import { submitFeedbackTask, getFeedbackTask } from '../../src/lib/api'
import { ApiError } from '../../src/lib/api'
import { buildSessionReport, createRoundRecord } from '../../src/lib/metrics'
import type { ConversationFeedbackResponse, ConversationMessage, RedoRecord, RoundRecord, SessionScenario } from '../../src/types'

class MemoryStorage implements Storage {
  #entries = new Map<string, string>()
  get length(): number { return this.#entries.size }
  clear(): void { this.#entries.clear() }
  getItem(key: string): string | null { return this.#entries.get(key) ?? null }
  key(index: number): string | null { return [...this.#entries.keys()][index] ?? null }
  removeItem(key: string): void { this.#entries.delete(key) }
  setItem(key: string, value: string): void { this.#entries.set(key, value) }
}

const payload = {
  scenarioType: 'dynamic' as const,
  sessionToken: 'session-token',
  turnRecords: [{
    turn: 1, partnerPromptJa: 'ご希望は？', userOriginal: '月曜', userCleaned: '月曜', userConfirmed: '月曜日でお願いします。',
    inputMode: 'text' as const, transcriptModified: false, rerecordCount: 0, partnerAudioPlayCount: 0, ttsReplayCount: 0,
    transcriptRevealed: false, listeningScaffoldLevel: 0, expressionScaffoldLevel: 0, failureCount: 0, retryCount: 0,
    textFallback: true, speechAssistUsed: false,
  }],
}

function snapshot(now: number, pending = {}, sessionId = 'original-session'): CompletedReviewSnapshot {
  return {
    version: 1, sessionId, scenario: { id: 'scenario', version: 1, variantId: 'v', maxTurns: 5, scenarioType: 'dynamic', sessionToken: 'session-token', scenarioToken: 'scenario-token', dynamicData: { opening: { speaker: 'assistant', partnerLineJa: 'ご希望は？', planZh: '询问需求' } } } as never,
    messages: [], rounds: [], startedAt: now - 1000, endedAt: now, report: { sessionId } as never,
    feedback: null, redoRecords: [], pending,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('completed review recovery runtime', () => {
  it('reposts the same envelope after a lost POST response and retains its request id', async () => {
    const storage = new MemoryStorage(); const scheduled: Array<() => void> = []
    const request = createFeedbackTaskRequest('conversation', payload, 1000)
    const api: FeedbackTaskRecoveryApi = {
      submit: vi.fn().mockRejectedValueOnce(new Error('network lost')).mockResolvedValue({ taskToken: 'token-1', expiresAt: 86_401_000 }),
      get: vi.fn().mockResolvedValue({ status: 'pending' }),
    }
    const runtime = createCompletedReviewRecoveryRuntime({ storage, api, now: () => 1000, schedule: (callback) => { scheduled.push(callback); return scheduled.length } })
    runtime.mount(); runtime.save(snapshot(1000)); runtime.startTask(request)
    await Promise.resolve(); await Promise.resolve()
    expect(runtime.getState().record?.pending.conversation).toMatchObject({ request, status: 'transport_error' })
    expect(scheduled).toHaveLength(1)
    scheduled.shift()?.()
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect((api.submit as ReturnType<typeof vi.fn>).mock.calls.map(([envelope]) => envelope.requestId)).toEqual([request.requestId, request.requestId])
    expect(runtime.getState().record?.pending.conversation?.taskToken).toBe('token-1')
  })

  it('maps gone capability to expired, removes its completed-review record, and does not retry', async () => {
    const storage = new MemoryStorage(); const scheduled: Array<() => void> = []
    const request = createFeedbackTaskRequest('conversation', payload, 1000)
    const api: FeedbackTaskRecoveryApi = { submit: vi.fn(), get: vi.fn().mockRejectedValue(new ApiError('task_expired', '已过期', 410)) }
    const runtime = createCompletedReviewRecoveryRuntime({ storage, api, now: () => 1000, schedule: (callback) => { scheduled.push(callback); return scheduled.length } })
    runtime.mount(); runtime.save(snapshot(1000, { conversation: { request, taskToken: 'token-1', status: 'pending' } }))
    await Promise.resolve(); await Promise.resolve()
    expect(runtime.getState().status).toBe('expired')
    expect(storage.getItem(COMPLETED_REVIEW_STORAGE_KEY)).toBeNull()
    expect(scheduled).toHaveLength(0)
  })

  it('maps 401 to a terminal invalid capability instead of transport recovery', async () => {
    const storage = new MemoryStorage(); const scheduled: Array<() => void> = []
    const request = createFeedbackTaskRequest('conversation', payload, 1000)
    const api: FeedbackTaskRecoveryApi = { submit: vi.fn(), get: vi.fn().mockRejectedValue(new ApiError('invalid_token', '无效 capability', 401)) }
    const runtime = createCompletedReviewRecoveryRuntime({ storage, api, now: () => 1000, schedule: (callback) => { scheduled.push(callback); return scheduled.length } })
    runtime.mount(); runtime.save(snapshot(1000, { conversation: { request, taskToken: 'token-1', status: 'pending' } }))
    await Promise.resolve(); await Promise.resolve()
    expect(runtime.getState().record?.pending.conversation).toMatchObject({ status: 'failed', error: { code: 'invalid_capability' } })
    expect(scheduled).toHaveLength(0)
  })

  it('maps 503 to transport_error and resumes the existing token without a second submit', async () => {
    const storage = new MemoryStorage(); const scheduled: Array<() => void> = []
    const request = createFeedbackTaskRequest('conversation', payload, 1000)
    const api: FeedbackTaskRecoveryApi = { submit: vi.fn(), get: vi.fn().mockRejectedValueOnce(new ApiError('unavailable', '忙碌', 503)).mockResolvedValue({ status: 'pending' }) }
    const runtime = createCompletedReviewRecoveryRuntime({ storage, api, now: () => 1000, schedule: (callback) => { scheduled.push(callback); return scheduled.length } })
    runtime.mount(); runtime.save(snapshot(1000, { conversation: { request, taskToken: 'token-1', status: 'pending' } }))
    await Promise.resolve(); await Promise.resolve()
    expect(runtime.getState().record?.pending.conversation).toMatchObject({ request, taskToken: 'token-1', status: 'transport_error' })
    scheduled.shift()?.()
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(api.submit).not.toHaveBeenCalled()
    expect((api.get as ReturnType<typeof vi.fn>).mock.calls.map(([token]) => token)).toEqual(['token-1', 'token-1'])
  })

  it('persists the validated envelope before acceptance and restores the same pending task', async () => {
    const storage = new MemoryStorage()
    const request = createFeedbackTaskRequest('conversation', payload, 1000)
    const api: FeedbackTaskRecoveryApi = { submit: vi.fn().mockResolvedValue({ taskToken: 'token-1', expiresAt: 1000 + 86_400_000 }), get: vi.fn().mockResolvedValue({ status: 'pending' }) }
    const runtime = createCompletedReviewRecoveryRuntime({ storage, api, now: () => 1000 })
    runtime.mount()
    runtime.save(snapshot(1000, { conversation: { request, status: 'pending' } }))
    const persisted = JSON.parse(storage.getItem(COMPLETED_REVIEW_STORAGE_KEY) ?? 'null')
    expect(persisted.pending.conversation.request).toEqual(request)
    await Promise.resolve(); await Promise.resolve()
    expect(api.submit).toHaveBeenCalledWith(request, expect.any(AbortSignal))
    expect(JSON.parse(storage.getItem(COMPLETED_REVIEW_STORAGE_KEY) ?? 'null').pending.conversation.taskToken).toBe('token-1')
  })

  it('ignores a late result after the original record is discarded or replaced', async () => {
    const storage = new MemoryStorage(); const late = deferred<ReturnType<FeedbackTaskRecoveryApi['get']> extends Promise<infer T> ? T : never>()
    const request = createFeedbackTaskRequest('conversation', payload, 1000)
    const api: FeedbackTaskRecoveryApi = { submit: vi.fn().mockResolvedValue({ taskToken: 'token-1', expiresAt: 86_401_000 }), get: vi.fn(() => late.promise) }
    const runtime = createCompletedReviewRecoveryRuntime({ storage, api, now: () => 1000 })
    runtime.mount(); runtime.save(snapshot(1000, { conversation: { request, taskToken: 'token-1', status: 'pending' } }))
    runtime.discard()
    runtime.mount()
    runtime.setObservationAllowed(false)
    runtime.save(snapshot(1000, { conversation: { request: createFeedbackTaskRequest('conversation', payload, 1000), status: 'pending' } }, 'replacement-session'))
    late.resolve({ status: 'complete', kind: 'conversation', result: { outcome: 'partial', outcomeEvidenceZh: '证据', listeningFinding: null, expressionImprovement: null, redoTask: { turn: 1, partnerPromptJa: 'ご希望は？', firstConfirmedJa: '月曜です。', directionZh: '补充日期。' } } })
    await Promise.resolve(); await Promise.resolve()
    expect(runtime.getState().record?.sessionId).toBe('replacement-session')
    expect(runtime.getState().record?.pending.conversation?.status).toBe('pending')
  })

  it('pauses hidden observation and resumes the existing task without a new request id', async () => {
    const storage = new MemoryStorage(); let foreground = true; const request = createFeedbackTaskRequest('conversation', payload, 1000)
    const api: FeedbackTaskRecoveryApi = { submit: vi.fn().mockResolvedValue({ taskToken: 'token-1', expiresAt: 86_401_000 }), get: vi.fn().mockResolvedValue({ status: 'pending' }) }
    const runtime = createCompletedReviewRecoveryRuntime({ storage, api, now: () => 1000, isForeground: () => foreground })
    runtime.mount(); runtime.save(snapshot(1000, { conversation: { request, status: 'pending' } })); await Promise.resolve(); await Promise.resolve()
    runtime.setObservationAllowed(false); foreground = false; const id = request.requestId
    runtime.setObservationAllowed(true); foreground = true; await Promise.resolve(); await Promise.resolve()
    expect((api.submit as ReturnType<typeof vi.fn>).mock.calls.every(([received]) => received.requestId === id)).toBe(true)
  })

  it('expires completed review records at the 24 hour boundary', () => {
    const storage = new MemoryStorage(); const runtime = createCompletedReviewRecoveryRuntime({ storage, now: () => 86_401_000 })
    storage.setItem(COMPLETED_REVIEW_STORAGE_KEY, JSON.stringify(snapshot(1000)))
    runtime.mount()
    expect(runtime.getState().status).toBe('expired')
    expect(storage.getItem(COMPLETED_REVIEW_STORAGE_KEY)).toBeNull()
  })

  it('restores a complete snapshot with the same report shape written by App', () => {
    const storage = new MemoryStorage()
    const base = snapshot(1000)
    const scenario = { ...base.scenario, reveal: { titleZh: '场景', summaryZh: '复盘场景' } }
    const round = createRoundRecord(1, 'ご希望は？', 0)
    round.userOriginal = '月曜'
    round.userCleaned = '月曜'
    round.userFinal = '月曜日でお願いします。'
    round.inputMode = 'text'
    const report = buildSessionReport('writer-session', 'mock', scenario, 1, 1000, [round], [])
    const written: CompletedReviewSnapshot = { ...base, sessionId: 'writer-session', scenario, messages: [{ id: 'assistant-1', turn: 1, role: 'assistant', text: 'ご希望は？' }, { id: 'user-1', turn: 1, role: 'user', text: round.userFinal, transcript: { rawText: '', cleanedText: '', finalText: round.userFinal } }], rounds: [round], report }
    storage.setItem(COMPLETED_REVIEW_STORAGE_KEY, JSON.stringify(written))
    const runtime = createCompletedReviewRecoveryRuntime({ storage, now: () => 1000 })
    runtime.mount()
    expect(runtime.getState().record?.sessionId).toBe('writer-session')
  })
})

describe('completed practice rerender stability', () => {
  it('syncs one completed recovery record once across parent rerenders', async () => {
    vi.resetModules()
    const completedScenario: SessionScenario = {
      id: 'haircut', version: 1, variantId: 'default', maxTurns: 5,
      reveal: { titleZh: '理发店', summaryZh: '说明理发要求。' }, scenarioType: 'dynamic', sessionToken: 'session-token', scenarioToken: 'scenario-token', practiceToken: 'practice-token',
      dynamicData: {
        id: 'haircut', version: 1, titleZh: '理发店', summaryZh: '说明理发要求。', aiRole: '理发师', userRole: '顾客', relationship: '顾客与店员', tone: '礼貌', opening: { speaker: 'assistant', partnerLineJa: 'いらっしゃいませ。今日はどうされますか。', planZh: '迎客并询问需求' }, userGoal: '前髪は残してください。',
        coreGoal: { id: 'request', titleZh: '说明要求', descriptionZh: '清楚说明理发要求。' }, communicationFunction: '提出要求', initialFacts: [], partnerPrivateFacts: [], keyIntents: [], keyInformation: [], completionRules: { completed: [], partial: [], notCompleted: [] }, closingRules: [], maxTurns: 5,
        worldAnchors: [], followUpPrinciples: [], hintStrategy: 'direct', feedbackFocus: [], safetyBoundary: 'none',
      },
    }
    const completedRound = createRoundRecord(1, 'いらっしゃいませ。今日はどうされますか。', 0)
    completedRound.userOriginal = '前髪は残してください。'; completedRound.userCleaned = completedRound.userOriginal; completedRound.userFinal = completedRound.userOriginal; completedRound.inputMode = 'text'; completedRound.timing.audioStartedAt = 1; completedRound.timing.audioCompletedAt = 2
    const redo: RedoRecord = { turn: 1, partnerPromptJa: 'いらっしゃいませ。今日はどうされますか。', firstConfirmedJa: completedRound.userFinal, secondConfirmedJa: 'もう少し短くしてください。', inputMode: 'text', listeningScaffoldLevel: 0, expressionScaffoldLevel: 0, comparisonZh: '细节更完整。', referenceExpressionJa: 'もう少し短くしてください。' }
    const feedback: ConversationFeedbackResponse = { outcome: 'partial', outcomeEvidenceZh: '已完成核心请求。', listeningFinding: null, expressionImprovement: null, redoTask: { turn: 1, partnerPromptJa: 'いらっしゃいませ。今日はどうされますか。', firstConfirmedJa: completedRound.userFinal, directionZh: '补充长度细节。' } }
    const report = buildSessionReport('completed-session', 'mock', completedScenario, 1, 2, [completedRound], [redo])
    const record: CompletedReviewSnapshot = { version: 1, sessionId: 'completed-session', scenario: completedScenario, messages: [], rounds: [completedRound], startedAt: 1, endedAt: 2, report, feedback, redoRecords: [redo], pending: {} }
    const recoveryState: CompletedReviewRecoveryState = { status: 'restored', record, notice: '' }
    const recovery = { state: recoveryState, save: vi.fn(), update: vi.fn(), discard: vi.fn(), startTask: vi.fn(), resumeTask: vi.fn() }
    vi.doMock('../../src/lib/feedback-task-recovery', async () => ({
      ...(await vi.importActual<typeof import('../../src/lib/feedback-task-recovery')>('../../src/lib/feedback-task-recovery')),
      useCompletedReviewRecovery: () => recovery,
    }))
    const { useCompletedPractice } = await import('../../src/lib/use-completed-practice')
    const persistPractice = vi.fn().mockResolvedValue(undefined)
    const messages: ConversationMessage[] = []
    const rounds: RoundRecord[] = [completedRound]
    const config = { mode: 'mock' as const }
    const practiceHistory: import('../../src/lib/practice-history').StoredPracticeAttempt[] = []
    let redoStateSynchronizations = 0
    const container = document.createElement('div')
    const root = createRoot(container)
    document.body.appendChild(container)
    function Harness(): React.JSX.Element {
      const [parentRender, setParentRender] = useState(0)
      const messagesRef = useRef(messages)
      const roundsRef = useRef(rounds)
      const completed = useCompletedPractice({
        config, phase: 'session_complete', scenario: completedScenario, sessionId: 'completed-session', startedAt: 1, endedAt: 2,
        messages, messagesRef, rounds, roundsRef, practiceHistory, persistPractice, restoreCompletedSession: () => undefined,
      })
      const previousRedoRecords = useRef(completed.model.redoRecords)
      if (previousRedoRecords.current !== completed.model.redoRecords) {
        redoStateSynchronizations += 1
        previousRedoRecords.current = completed.model.redoRecords
      }
      return createElement('button', { type: 'button', onClick: () => setParentRender((value) => value + 1), 'data-redo-count': completed.model.redoRecords.length }, String(parentRender))
    }
    try {
      flushSync(() => root.render(createElement(Harness)))
      const button = await vi.waitFor(() => {
        const target = container.querySelector<HTMLButtonElement>('button')
        expect(target?.dataset.redoCount).toBe('1')
        expect(persistPractice).toHaveBeenCalled()
        return target as HTMLButtonElement
      }, { interval: 0 })
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      const persistedBeforeRerender = persistPractice.mock.calls.length
      const redoSynchronizationsBeforeRerender = redoStateSynchronizations

      flushSync(() => button.click())
      await new Promise<void>((resolve) => setTimeout(resolve, 0))

      expect(persistPractice).toHaveBeenCalledTimes(persistedBeforeRerender)
      expect(redoStateSynchronizations).toBe(redoSynchronizationsBeforeRerender)
      expect(button.dataset.redoCount).toBe('1')
    } finally {
      root.unmount()
      container.remove()
      vi.doUnmock('../../src/lib/feedback-task-recovery')
      vi.clearAllMocks()
    }
  })
})

describe('feedback task API client', () => {
  it('uses the durable task endpoints and bearer capability', async () => {
    const request = createFeedbackTaskRequest('conversation', payload, 1000)
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ taskToken: 'token-1', expiresAt: 86_401_000 }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'pending' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await submitFeedbackTask(request)
    await getFeedbackTask('token-1')
    expect(fetchMock.mock.calls[0][0]).toBe('/api/feedback/tasks')
    expect(fetchMock.mock.calls[0][1].method).toBe('POST')
    expect(fetchMock.mock.calls[1][0]).toBe('/api/feedback/tasks')
    expect(fetchMock.mock.calls[1][1].headers.authorization).toBe('Bearer token-1')
  })
})
