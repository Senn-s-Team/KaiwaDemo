/**
 * [INPUT]: 依赖 shared/feedback-task 任务 wire schema、练习完成页可序列化上下文、浏览器 localStorage 与页面前后台生命周期
 * [OUTPUT]: 提供完成复盘状态的本机恢复、反馈/重做任务 start/resume 与轮询 runtime，结果只写回原 sessionId/requestId
 * [POS]: src/lib 的 durable completed-review 边界；不启动麦克风、音频或模型，不拥有 App 当前活动会话
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ZodError } from 'zod'
import {
  FEEDBACK_TASK_TTL_MS,
  ConversationFeedbackResponseSchema,
  FeedbackTaskRequestSchema,
  RedoFeedbackResponseSchema,
  type FeedbackTaskAccepted,
  type FeedbackTaskRequest,
  type FeedbackTaskStatus,
} from '../../shared/feedback-task'
import { ApiError, getFeedbackTask, submitFeedbackTask } from './api'
import type {
  ConversationFeedbackResponse,
  ConversationMessage,
  RedoRecord,
  RoundRecord,
  SessionReport,
  SessionScenario,
} from '../types'

export const COMPLETED_REVIEW_STORAGE_KEY = 'kaiwa.completed-review.v1'
const POLL_INTERVAL_MS = 2_000
const REQUEST_TIMEOUT_MS = 25_000

export type FeedbackTaskKind = FeedbackTaskRequest['kind']

export interface StoredFeedbackTask {
  request: FeedbackTaskRequest
  taskToken?: string
  status: 'pending' | 'transport_error' | 'failed' | 'complete'
  error?: { code: string; message: string }
  result?: ConversationFeedbackResponse | { comparisonZh: string; referenceExpressionJa: string }
}

export interface CompletedReviewSnapshot {
  version: 1
  sessionId: string
  scenario: SessionScenario
  messages: ConversationMessage[]
  rounds: RoundRecord[]
  startedAt: number
  endedAt: number
  report: SessionReport
  feedback: ConversationFeedbackResponse | null
  redoRecords: RedoRecord[]
  pending: Partial<Record<FeedbackTaskKind, StoredFeedbackTask>>
}

export type CompletedReviewRecoveryState =
  | { status: 'idle'; record: null; notice: string }
  | { status: 'restored' | 'pending' | 'complete' | 'failed'; record: CompletedReviewSnapshot; notice: string }
  | { status: 'expired'; record: null; notice: string }

export interface FeedbackTaskRecoveryApi {
  submit(request: FeedbackTaskRequest, signal?: AbortSignal): Promise<FeedbackTaskAccepted>
  get(taskToken: string, signal?: AbortSignal): Promise<FeedbackTaskStatus>
}

export interface CompletedReviewRecoveryDependencies {
  api?: FeedbackTaskRecoveryApi
  now?: () => number
  storage?: Storage
  isForeground?: () => boolean
  isOnline?: () => boolean
  schedule?: (callback: () => void, delayMs: number) => number
  cancelSchedule?: (timer: number) => void
}

export interface CompletedReviewRecoveryRuntime {
  mount(): void
  dispose(): void
  save(record: CompletedReviewSnapshot): void
  update(record: CompletedReviewSnapshot): void
  discard(): void
  /** 用户明确确认的新任务；替换同 kind 的终态封套。 */
  startTask(request: FeedbackTaskRequest): void
  /** 前台重新可观察时续用原封套和 capability。 */
  resumeTask(kind: FeedbackTaskKind): void
  setObservationAllowed(allowed: boolean): void
  getState(): CompletedReviewRecoveryState
  subscribe(listener: (state: CompletedReviewRecoveryState) => void): () => void
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isStoredScenario(value: unknown): value is SessionScenario {
  if (!isObject(value)) return false
  return typeof value.id === 'string' && value.id.length > 0
    && isFiniteNumber(value.version) && typeof value.variantId === 'string'
    && typeof value.firstLine === 'string' && value.maxTurns === 5
    && value.scenarioType === 'dynamic' && typeof value.sessionToken === 'string'
    && typeof value.scenarioToken === 'string' && isObject(value.dynamicData)
    && isObject(value.reveal)
}

function isStoredMessage(value: unknown): value is ConversationMessage {
  if (!isObject(value)) return false
  return typeof value.id === 'string' && value.id.length > 0
    && isFiniteNumber(value.turn) && (value.role === 'assistant' || value.role === 'user')
    && typeof value.text === 'string'
    && (value.transcript === undefined || (isObject(value.transcript) && typeof value.transcript.rawText === 'string' && typeof value.transcript.cleanedText === 'string' && typeof value.transcript.finalText === 'string'))
    && (value.listeningScaffold === undefined || isObject(value.listeningScaffold))
}

function isStoredRound(value: unknown): value is RoundRecord {
  if (!isObject(value)) return false
  return isFiniteNumber(value.turn) && typeof value.aiPrompt === 'string'
    && (value.inputMode === 'stt' || value.inputMode === 'text')
    && typeof value.userOriginal === 'string' && typeof value.userCleaned === 'string' && typeof value.userFinal === 'string'
    && isFiniteNumber(value.listeningScaffoldLevel) && isFiniteNumber(value.expressionScaffoldLevel)
    && isObject(value.timing) && Array.isArray(value.speechAssistEvents)
}

function isStoredReport(value: unknown): value is SessionReport {
  if (!isObject(value)) return false
  return value.schemaVersion === 3 && typeof value.sessionId === 'string'
    && typeof value.scenarioId === 'string' && isFiniteNumber(value.startedAt)
    && isFiniteNumber(value.endedAt) && Array.isArray(value.rounds) && value.rounds.every(isStoredRound)
    && Array.isArray(value.redos) && isObject(value.totals)
    && isObject(value.completion) && isObject(value.recovery)
}

function isStoredRedo(value: unknown): value is RedoRecord {
  if (!isObject(value)) return false
  return isFiniteNumber(value.turn) && typeof value.partnerPromptJa === 'string'
    && typeof value.firstConfirmedJa === 'string' && typeof value.secondConfirmedJa === 'string'
    && (value.inputMode === 'stt' || value.inputMode === 'text')
    && isFiniteNumber(value.listeningScaffoldLevel) && isFiniteNumber(value.expressionScaffoldLevel)
    && typeof value.comparisonZh === 'string' && typeof value.referenceExpressionJa === 'string'
}

function parseStored(value: unknown): CompletedReviewSnapshot | null {
  if (!isObject(value) || value.version !== 1 || typeof value.sessionId !== 'string' || value.sessionId.length === 0) return null
  if (!isStoredScenario(value.scenario) || !Array.isArray(value.messages) || !value.messages.every(isStoredMessage)
    || !Array.isArray(value.rounds) || !value.rounds.every(isStoredRound) || !isStoredReport(value.report)) return null
  if (typeof value.startedAt !== 'number' || typeof value.endedAt !== 'number') return null
  if (!Array.isArray(value.redoRecords) || !value.redoRecords.every(isStoredRedo) || !isObject(value.pending)) return null
  if (value.feedback !== null && value.feedback !== undefined && !ConversationFeedbackResponseSchema.safeParse(value.feedback).success) return null
  const pending: Partial<Record<FeedbackTaskKind, StoredFeedbackTask>> = {}
  for (const kind of ['conversation', 'redo'] as const) {
    const task = value.pending[kind]
    if (task === undefined) continue
    if (!isObject(task) || !['pending', 'transport_error', 'failed', 'complete'].includes(String(task.status))) return null
    const parsedRequest = FeedbackTaskRequestSchema.safeParse(task.request)
    if (!parsedRequest.success || parsedRequest.data.kind !== kind) return null
    if (task.taskToken !== undefined && (typeof task.taskToken !== 'string' || task.taskToken.length === 0)) return null
    if ((task.status === 'failed' || task.status === 'transport_error')
      && (!isObject(task.error) || typeof task.error.code !== 'string' || typeof task.error.message !== 'string')) return null
    if (task.status === 'complete') {
      const resultSchema = kind === 'conversation' ? ConversationFeedbackResponseSchema : RedoFeedbackResponseSchema
      if (!resultSchema.safeParse(task.result).success) return null
    }
    pending[kind] = {
      request: parsedRequest.data,
      taskToken: typeof task.taskToken === 'string' ? task.taskToken : undefined,
      status: task.status as StoredFeedbackTask['status'],
      error: isObject(task.error) && typeof task.error.code === 'string' && typeof task.error.message === 'string'
        ? { code: task.error.code, message: task.error.message }
        : undefined,
      result: task.result as StoredFeedbackTask['result'],
    }
  }
  return {
    version: 1,
    sessionId: value.sessionId,
    scenario: value.scenario as SessionScenario,
    messages: value.messages as ConversationMessage[],
    rounds: value.rounds as RoundRecord[],
    startedAt: value.startedAt,
    endedAt: value.endedAt,
    report: value.report as SessionReport,
    feedback: (value.feedback ?? null) as ConversationFeedbackResponse | null,
    redoRecords: value.redoRecords as RedoRecord[],
    pending,
  }
}

function randomRequestId(): string {
  if (!globalThis.crypto?.randomUUID) throw new Error('当前浏览器无法生成安全任务标识。')
  return globalThis.crypto.randomUUID()
}

function isLifecycleAbort(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason !== 'timeout'
}

function isTransportError(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status === 408 || error.status === 503 || error.status >= 500
}

function errorMessage(error: unknown): string {
  if (error instanceof ZodError) return '服务返回的数据无效，请稍后重试。'
  return error instanceof Error ? error.message : '连接暂时中断，请恢复网络后继续。'
}

export function createCompletedReviewRecoveryRuntime(dependencies: CompletedReviewRecoveryDependencies = {}): CompletedReviewRecoveryRuntime {
  const api = dependencies.api ?? {
    submit: submitFeedbackTask,
    get: getFeedbackTask,
  }
  const now = dependencies.now ?? Date.now
  let storage = dependencies.storage ?? null
  let notice = ''
  if (!storage) {
    try { storage = window.localStorage } catch { notice = '浏览器无法使用本地复盘恢复记录；离开页面后无法继续恢复。' }
  }
  const isForeground = dependencies.isForeground ?? (() => document.visibilityState === 'visible')
  const isOnline = dependencies.isOnline ?? (() => navigator.onLine)
  const schedule = dependencies.schedule ?? ((callback, delayMs) => window.setTimeout(callback, delayMs))
  const cancelSchedule = dependencies.cancelSchedule ?? ((timer) => window.clearTimeout(timer))
  const listeners = new Set<(state: CompletedReviewRecoveryState) => void>()
  let state: CompletedReviewRecoveryState = { status: 'idle', record: null, notice }
  let record: CompletedReviewSnapshot | null = null
  let mounted = false
  let observationAllowed = true
  let epoch = 0
  let timer: number | null = null
  const operations = new Map<FeedbackTaskKind, AbortController>()

  const publish = (next: CompletedReviewRecoveryState): void => {
    state = next
    listeners.forEach((listener) => listener(state))
  }
  const canObserve = (): boolean => mounted && observationAllowed && isForeground() && isOnline()
  const clearTimer = (): void => {
    if (timer !== null) cancelSchedule(timer)
    timer = null
  }
  const abortAll = (): void => {
    operations.forEach((controller) => controller.abort())
    operations.clear()
  }
  const persist = (): void => {
    if (!record || !storage) return
    try { storage.setItem(COMPLETED_REVIEW_STORAGE_KEY, JSON.stringify(record)) } catch { notice = '浏览器无法保存复盘恢复记录；当前页面仍可继续。' }
  }
  const removeStored = (): void => {
    if (storage) {
      try { storage.removeItem(COMPLETED_REVIEW_STORAGE_KEY) } catch { notice = '浏览器无法清除复盘恢复记录；本次仍可继续。' }
    }
    record = null
  }
  const expire = (): void => {
    clearTimer(); abortAll(); removeStored()
    publish({ status: 'expired', record: null, notice })
  }
  const ensureValid = (): boolean => {
    if (!record) return false
    if (record.endedAt + FEEDBACK_TASK_TTL_MS <= now()) { expire(); return false }
    for (const task of Object.values(record.pending)) {
      if (task && task.request.createdAt + FEEDBACK_TASK_TTL_MS <= now()) { expire(); return false }
    }
    return true
  }
  const updateTask = (kind: FeedbackTaskKind, task: StoredFeedbackTask): void => {
    if (!record) return
    record = { ...record, pending: { ...record.pending, [kind]: task } }
    persist()
    publish({ status: task.status === 'complete' ? 'complete' : task.status === 'failed' ? 'failed' : 'pending', record, notice })
  }
  const scheduleObservation = (): void => {
    if (!canObserve() || timer !== null) return
    timer = schedule(() => { timer = null; void observeAll() }, POLL_INTERVAL_MS)
  }
  const observeTask = async (kind: FeedbackTaskKind): Promise<void> => {
    if (!record || !ensureValid() || !canObserve()) return
    const task = record.pending[kind]
    if (!task || task.status === 'complete' || task.status === 'failed') return
    if (operations.has(kind)) return
    const observedSessionId = record.sessionId
    const observedRequestId = task.request.requestId
    const operationEpoch = epoch
    const controller = new AbortController()
    let nextTask = task
    operations.set(kind, controller)
    const timeout = window.setTimeout(() => controller.abort('timeout'), REQUEST_TIMEOUT_MS)
    try {
      if (!task.taskToken) {
        const accepted = await api.submit(task.request, controller.signal)
        nextTask = { ...task, taskToken: accepted.taskToken, status: 'pending' }
        if (!record || controller.signal.aborted || operations.get(kind) !== controller || record.sessionId !== observedSessionId || record.pending[kind]?.request.requestId !== observedRequestId || operationEpoch !== epoch) return
        updateTask(kind, nextTask)
      }
      if (!nextTask.taskToken) return
      const status = await api.get(nextTask.taskToken, controller.signal)
      if (!record || controller.signal.aborted || operations.get(kind) !== controller || record.sessionId !== observedSessionId || record.pending[kind]?.request.requestId !== observedRequestId || operationEpoch !== epoch) return
      if (status.status === 'pending') updateTask(kind, { ...nextTask, status: 'pending' })
      else if (status.status === 'failed') updateTask(kind, { ...nextTask, status: 'failed', error: status.error })
      else if (status.kind !== kind || status.kind !== nextTask.request.kind) {
        updateTask(kind, { ...nextTask, status: 'failed', error: { code: 'task_kind_mismatch', message: '任务返回类型与原请求不一致，请重试。' } })
      } else {
        const completed = { ...nextTask, status: 'complete' as const, result: status.result }
        record = { ...record, feedback: status.kind === 'conversation' ? status.result : record.feedback }
        if (status.kind === 'redo') {
          const payload = nextTask.request.kind === 'redo' ? nextTask.request.payload : null
          if (payload) {
            const redo: RedoRecord = { turn: payload.turn, partnerPromptJa: payload.partnerPromptJa, firstConfirmedJa: payload.firstConfirmedJa, secondConfirmedJa: payload.secondConfirmedJa, inputMode: payload.secondInputMode, listeningScaffoldLevel: payload.secondListeningScaffoldLevel, expressionScaffoldLevel: payload.secondExpressionScaffoldLevel, comparisonZh: status.result.comparisonZh, referenceExpressionJa: status.result.referenceExpressionJa }
            const nextRedos = [...record.redoRecords.filter((item) => item.turn !== redo.turn), redo]
            record = { ...record, redoRecords: nextRedos, report: { ...record.report, redos: nextRedos } }
          }
        }
        record = { ...record, pending: { ...record.pending, [kind]: completed } }
        persist()
        publish({ status: 'complete', record, notice })
      }
      if (status.status === 'pending') scheduleObservation()
    } catch (error) {
      if (!record || controller.signal.aborted || operations.get(kind) !== controller || isLifecycleAbort(controller.signal) || operationEpoch !== epoch) return
      if (error instanceof ApiError && error.status === 410) { expire(); return }
      if (error instanceof ZodError) updateTask(kind, { ...task, status: 'failed', error: { code: 'invalid_wire', message: '服务返回的数据无效，请重新生成。' } })
      else if (error instanceof ApiError && error.status === 401) updateTask(kind, { ...task, status: 'failed', error: { code: 'invalid_capability', message: errorMessage(error) } })
      else if (controller.signal.reason === 'timeout' || isTransportError(error)) {
        updateTask(kind, { ...nextTask, status: 'transport_error', error: { code: 'transport_error', message: controller.signal.reason === 'timeout' ? '查询超时，请稍后重试。' : errorMessage(error) } })
        scheduleObservation()
      }
      else updateTask(kind, { ...task, status: 'failed', error: { code: 'task_failed', message: errorMessage(error) } })
    } finally {
      window.clearTimeout(timeout)
      if (operations.get(kind) === controller) operations.delete(kind)
    }
  }
  const observeAll = async (): Promise<void> => {
    if (!record || !ensureValid() || !canObserve()) return
    await Promise.all((['conversation', 'redo'] as const).map((kind) => observeTask(kind)))
  }

  return {
    mount(): void {
      if (mounted) return
      mounted = true
      if (!storage) { publish({ status: 'idle', record: null, notice }); return }
      try {
        const raw = storage.getItem(COMPLETED_REVIEW_STORAGE_KEY)
        if (!raw) return
        const parsed = parseStored(JSON.parse(raw))
        if (!parsed) { removeStored(); publish({ status: 'expired', record: null, notice: '无法恢复损坏的复盘记录，请重新开始。' }); return }
        record = parsed
        if (!ensureValid()) return
        publish({ status: 'restored', record, notice })
        void observeAll()
      } catch { notice = '无法读取复盘恢复记录；当前页面仍可继续。'; publish({ status: 'idle', record: null, notice }) }
    },
    dispose(): void { mounted = false; epoch += 1; clearTimer(); abortAll() },
    save(next): void {
      if (next.endedAt + FEEDBACK_TASK_TTL_MS <= now()) return
      record = structuredClone(next); persist(); publish({ status: 'pending', record, notice }); void observeAll()
    },
    update(next): void {
      if (!record || record.sessionId !== next.sessionId) return
      record = structuredClone(next); persist(); publish({ status: 'pending', record, notice }); void observeAll()
    },
    discard(): void { epoch += 1; clearTimer(); abortAll(); removeStored(); publish({ status: 'idle', record: null, notice }) },
    startTask(request): void {
      if (!record) return
      epoch += 1; const nextTask: StoredFeedbackTask = { request, status: 'pending' }
      record = { ...record, pending: { ...record.pending, [request.kind]: nextTask } }; persist(); publish({ status: 'pending', record, notice }); void observeTask(request.kind)
    },
    resumeTask(kind): void { void observeTask(kind) },
    setObservationAllowed(allowed): void { observationAllowed = allowed; epoch += 1; clearTimer(); abortAll(); if (allowed) void observeAll() },
    getState: () => state,
    subscribe(listener): () => void { listeners.add(listener); return () => listeners.delete(listener) },
  }
}

export interface UseCompletedReviewRecoveryOptions {
  activeSession: boolean
  enabled?: boolean
}

export function useCompletedReviewRecovery({ activeSession, enabled = true }: UseCompletedReviewRecoveryOptions): {
  state: CompletedReviewRecoveryState
  save(record: CompletedReviewSnapshot): void
  update(record: CompletedReviewSnapshot): void
  discard(): void
  startTask(request: FeedbackTaskRequest): void
  resumeTask(kind: FeedbackTaskKind): void
} {
  const runtimeRef = useRef<CompletedReviewRecoveryRuntime | null>(null)
  if (!runtimeRef.current) runtimeRef.current = createCompletedReviewRecoveryRuntime()
  const runtime = runtimeRef.current
  const [state, setState] = useState<CompletedReviewRecoveryState>(() => runtime.getState())
  useEffect(() => {
    if (!enabled) return
    const unsubscribe = runtime.subscribe(setState)
    const resume = () => runtime.setObservationAllowed(!activeSession && !document.hidden)
    const pause = () => runtime.setObservationAllowed(false)
    runtime.mount(); resume()
    window.addEventListener('online', resume); window.addEventListener('offline', resume); window.addEventListener('pageshow', resume); window.addEventListener('pagehide', pause)
    document.addEventListener('visibilitychange', resume)
    return () => { unsubscribe(); window.removeEventListener('online', resume); window.removeEventListener('offline', resume); window.removeEventListener('pageshow', resume); window.removeEventListener('pagehide', pause); document.removeEventListener('visibilitychange', resume); runtime.dispose() }
  }, [activeSession, enabled, runtime])
  return { state, save: useCallback((record) => runtime.save(record), [runtime]), update: useCallback((record) => runtime.update(record), [runtime]), discard: useCallback(() => runtime.discard(), [runtime]), startTask: useCallback((request) => runtime.startTask(request), [runtime]), resumeTask: useCallback((kind) => runtime.resumeTask(kind), [runtime]) }
}

export function createFeedbackTaskRequest(kind: FeedbackTaskKind, payload: Extract<FeedbackTaskRequest, { kind: FeedbackTaskKind }>['payload'], createdAt = Date.now()): FeedbackTaskRequest {
  return FeedbackTaskRequestSchema.parse({ kind, requestId: randomRequestId(), createdAt, payload })
}
