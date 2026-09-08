/**
 * [INPUT]: 依赖 scenario-draft 共享 wire schema、浏览器 localStorage、前端 API 通信层与页面可见性/联网状态
 * [OUTPUT]: 提供可恢复首页场景草稿控制器及 React hook，持久化幂等请求封套并在前台恢复提交与状态轮询
 * [POS]: src/lib 的首页动态场景草稿恢复边界，隔离草稿网络生命周期，避免与语音回合 phase 混用
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ZodError } from 'zod'
import {
  SCENARIO_DRAFT_TASK_TTL_MS,
  ScenarioDraftTaskRequestSchema,
  type ScenarioDraftResponse,
  type ScenarioDraftTaskAccepted,
  type ScenarioDraftTaskRequest,
  type ScenarioDraftTaskStatus,
} from '../../shared/scenario-draft'
import { ApiError, getScenarioDraftTask, submitScenarioDraft } from './api'

export const SCENARIO_DRAFT_STORAGE_KEY = 'kaiwa.scenario-draft-task.v1'
const POLL_INTERVAL_MS = 2_000
const NETWORK_TIMEOUT_MS = 25_000

type Clarification = { questionZh: string; answerZh: string }

interface StoredScenarioDraft {
  version: 1
  request: ScenarioDraftTaskRequest
  taskToken?: string
}

export type ScenarioDraftRecoveryState =
  | { status: 'idle'; request: null; result: null; error: null; storageNotice: string }
  | { status: 'submitting' | 'pending'; request: ScenarioDraftTaskRequest; result: null; error: null; storageNotice: string }
  | { status: 'ready'; request: ScenarioDraftTaskRequest; result: ScenarioDraftResponse; error: null; storageNotice: string }
  | { status: 'transport_error'; request: ScenarioDraftTaskRequest; result: null; error: string; storageNotice: string }
  | { status: 'failed'; request: ScenarioDraftTaskRequest; result: null; error: string; storageNotice: string }
  | { status: 'expired'; request: null; result: null; error: string; storageNotice: string }

export interface ScenarioDraftRecoveryApi {
  submit(request: ScenarioDraftTaskRequest, signal?: AbortSignal): Promise<ScenarioDraftTaskAccepted>
  get(taskToken: string, signal?: AbortSignal): Promise<ScenarioDraftTaskStatus>
}

export interface ScenarioDraftRecoveryRuntime {
  mount(): void
  dispose(): void
  replace(inputZh: string, clarifications: readonly Clarification[], forceGenerate: boolean): void
  retryTransport(): void
  discard(): void
  clearAfterStart(requestId: string): void
  setObservationAllowed(allowed: boolean): void
  getState(): ScenarioDraftRecoveryState
  subscribe(listener: (state: ScenarioDraftRecoveryState) => void): () => void
}

export interface ScenarioDraftRecoveryDependencies {
  api?: ScenarioDraftRecoveryApi
  now?: () => number
  storage?: Storage
  isForeground?: () => boolean
  isOnline?: () => boolean
  schedule?: (callback: () => void, delayMs: number) => number
  cancelSchedule?: (timer: number) => void
}

function parseStoredScenarioDraft(value: unknown): StoredScenarioDraft | null {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as Partial<StoredScenarioDraft>
  if (candidate.version !== 1 || (candidate.taskToken !== undefined && typeof candidate.taskToken !== 'string')) return null
  const request = ScenarioDraftTaskRequestSchema.safeParse(candidate.request)
  if (!request.success) return null
  return { version: 1, request: request.data, taskToken: candidate.taskToken }
}

function isLifecycleAbort(signal: AbortSignal): boolean {
  return signal.aborted && signal.reason !== 'timeout'
}

function isWireError(error: unknown): boolean {
  return error instanceof ZodError
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '连接暂时中断，请恢复网络后继续。'
}

function isTransportError(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status >= 500
}

export function createScenarioDraftRecoveryRuntime(dependencies: ScenarioDraftRecoveryDependencies = {}): ScenarioDraftRecoveryRuntime {
  const api = dependencies.api ?? { submit: submitScenarioDraft, get: getScenarioDraftTask }
  const now = dependencies.now ?? Date.now
  let storage = dependencies.storage ?? null
  let storageNotice = ''
  if (!storage) {
    try {
      storage = window.localStorage
    } catch {
      storageNotice = '浏览器无法使用本地恢复记录；离开页面后无法继续恢复。'
    }
  }
  const isForeground = dependencies.isForeground ?? (() => document.visibilityState === 'visible')
  const isOnline = dependencies.isOnline ?? (() => navigator.onLine)
  const schedule = dependencies.schedule ?? ((callback, delayMs) => window.setTimeout(callback, delayMs))
  const cancelSchedule = dependencies.cancelSchedule ?? ((timer) => window.clearTimeout(timer))
  const listeners = new Set<(state: ScenarioDraftRecoveryState) => void>()
  let state: ScenarioDraftRecoveryState = { status: 'idle', request: null, result: null, error: null, storageNotice }
  let stored: StoredScenarioDraft | null = null
  let epoch = 0
  let operation: AbortController | null = null
  let timer: number | null = null
  let mounted = false
  let observationAllowed = true

  const publish = (next: ScenarioDraftRecoveryState): void => {
    state = next
    listeners.forEach((listener) => listener(state))
  }
  const canObserve = (): boolean => mounted && observationAllowed && isForeground() && isOnline()
  const clearTimer = (): void => {
    if (timer !== null) cancelSchedule(timer)
    timer = null
  }
  const abortOperation = (): void => {
    operation?.abort()
    operation = null
  }
  const removeStored = (): void => {
    stored = null
    if (!storage) return
    try {
      storage.removeItem(SCENARIO_DRAFT_STORAGE_KEY)
    } catch {
      storageNotice = '浏览器无法清除恢复记录；本次仍可继续。'
    }
  }
  const persist = (): void => {
    if (!stored) return
    if (!storage) {
      storageNotice = '浏览器无法保存恢复记录；离开页面后无法继续恢复。'
      return
    }
    try {
      storage.setItem(SCENARIO_DRAFT_STORAGE_KEY, JSON.stringify(stored))
    } catch {
      storageNotice = '浏览器无法保存恢复记录；离开页面后无法继续恢复。'
    }
  }
  const pendingState = (status: 'submitting' | 'pending'): void => {
    if (!stored) return
    publish({ status, request: stored.request, result: null, error: null, storageNotice })
  }
  const expire = (): void => {
    removeStored()
    publish({ status: 'expired', request: null, result: null, error: '这份练习草稿已过期，请重新准备。', storageNotice })
  }
  const ensureUnexpired = (): boolean => {
    if (!stored) return false
    if (stored.request.createdAt + SCENARIO_DRAFT_TASK_TTL_MS <= now()) {
      expire()
      return false
    }
    return true
  }
  const scheduleNext = (): void => {
    clearTimer()
    if (!canObserve() || !stored?.taskToken) return
    timer = schedule(() => {
      timer = null
      void observe()
    }, POLL_INTERVAL_MS)
  }
  const failTransport = (request: ScenarioDraftTaskRequest, error: unknown): void => {
    publish({ status: 'transport_error', request, result: null, error: errorMessage(error), storageNotice })
    if (canObserve()) {
      clearTimer()
      timer = schedule(() => {
        timer = null
        if (stored?.taskToken) void observe()
        else void submit()
      }, POLL_INTERVAL_MS)
    }
  }
  const failTerminal = (request: ScenarioDraftTaskRequest, error: unknown): void => {
    publish({ status: 'failed', request, result: null, error: errorMessage(error), storageNotice })
  }
  const submit = async (): Promise<void> => {
    if (!stored || !ensureUnexpired() || !canObserve()) return
    const request = stored.request
    const requestEpoch = ++epoch
    abortOperation()
    const controller = new AbortController()
    operation = controller
    pendingState('submitting')
    const timeout = window.setTimeout(() => controller.abort('timeout'), NETWORK_TIMEOUT_MS)
    try {
      const accepted = await api.submit(request, controller.signal)
      if (requestEpoch !== epoch || controller.signal.aborted || !stored || stored.request.requestId !== request.requestId) return
      stored = { ...stored, taskToken: accepted.taskToken }
      persist()
      pendingState('pending')
      await observe()
    } catch (error) {
      if (requestEpoch !== epoch || isLifecycleAbort(controller.signal)) return
      if (controller.signal.aborted && controller.signal.reason === 'timeout') failTransport(request, new Error('请求超时，请稍后重试。'))
      else if (error instanceof ApiError && error.status === 410) expire()
      else if (isWireError(error)) failTerminal(request, new Error('服务返回的数据无效，请重新准备。'))
      else if (isTransportError(error)) failTransport(request, error)
      else failTerminal(request, error)
    } finally {
      window.clearTimeout(timeout)
      if (operation === controller) operation = null
    }
  }
  const observe = async (): Promise<void> => {
    if (!stored || !ensureUnexpired() || !stored.taskToken || !canObserve()) return
    const request = stored.request
    const requestEpoch = ++epoch
    abortOperation()
    const controller = new AbortController()
    operation = controller
    pendingState('pending')
    const timeout = window.setTimeout(() => controller.abort('timeout'), NETWORK_TIMEOUT_MS)
    try {
      const status = await api.get(stored.taskToken, controller.signal)
      if (requestEpoch !== epoch || controller.signal.aborted || !stored || stored.request.requestId !== request.requestId) return
      if (status.status === 'pending') {
        pendingState('pending')
        scheduleNext()
      } else if (status.status === 'complete') {
        publish({ status: 'ready', request, result: status.result, error: null, storageNotice })
      } else {
        publish({ status: 'failed', request, result: null, error: status.error.message, storageNotice })
      }
    } catch (error) {
      if (requestEpoch !== epoch || isLifecycleAbort(controller.signal)) return
      if (controller.signal.aborted && controller.signal.reason === 'timeout') failTransport(request, new Error('查询超时，请稍后重试。'))
      else if (error instanceof ApiError && error.status === 410) expire()
      else if (isWireError(error)) failTerminal(request, new Error('服务返回的数据无效，请重新准备。'))
      else if (isTransportError(error)) failTransport(request, error)
      else failTerminal(request, error)
    } finally {
      window.clearTimeout(timeout)
      if (operation === controller) operation = null
    }
  }
  const resume = (): void => {
    if (!mounted || !stored || !ensureUnexpired() || !canObserve()) return
    if (stored.taskToken) void observe()
    else void submit()
  }
  const discard = (): void => {
    epoch += 1
    clearTimer()
    abortOperation()
    removeStored()
    publish({ status: 'idle', request: null, result: null, error: null, storageNotice })
  }

  return {
    mount(): void {
      if (mounted) return
      mounted = true
      if (!storage) {
        publish({ status: 'idle', request: null, result: null, error: null, storageNotice })
        return
      }
      let raw: string | null
      try {
        raw = storage.getItem(SCENARIO_DRAFT_STORAGE_KEY)
      } catch {
        storageNotice = '浏览器无法读取恢复记录；本次仍可继续。'
        publish({ status: 'idle', request: null, result: null, error: null, storageNotice })
        return
      }
      if (!raw) {
        resume()
        return
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        removeStored()
        publish({ status: 'expired', request: null, result: null, error: '无法恢复已损坏的练习草稿，请重新准备。', storageNotice })
        return
      }
      const recovered = parseStoredScenarioDraft(parsed)
      if (!recovered) {
        removeStored()
        publish({ status: 'expired', request: null, result: null, error: '无法恢复已损坏的练习草稿，请重新准备。', storageNotice })
        return
      }
      stored = recovered
      if (!ensureUnexpired()) return
      pendingState(recovered.taskToken ? 'pending' : 'submitting')
      resume()
    },
    dispose(): void {
      mounted = false
      epoch += 1
      clearTimer()
      abortOperation()
    },
    replace(inputZh, clarifications, forceGenerate): void {
      discard()
      storageNotice = ''
      stored = {
        version: 1,
        request: {
          requestId: crypto.randomUUID(),
          createdAt: now(),
          inputZh: inputZh.trim(),
          clarifications: clarifications.map((item) => ({ questionZh: item.questionZh, answerZh: item.answerZh })),
          forceGenerate,
        },
      }
      persist()
      pendingState('submitting')
      void submit()
    },
    retryTransport(): void {
      if (!stored) return
      clearTimer()
      if (stored.taskToken) void observe()
      else void submit()
    },
    discard,
    clearAfterStart(requestId): void {
      if (stored?.request.requestId === requestId) discard()
    },
    setObservationAllowed(allowed): void {
      observationAllowed = allowed
      epoch += 1
      clearTimer()
      abortOperation()
      if (allowed) resume()
    },
    getState: () => state,
    subscribe(listener): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export interface UseScenarioDraftRecoveryOptions {
  activeSession: boolean
}

export function useScenarioDraftRecovery({ activeSession }: UseScenarioDraftRecoveryOptions): {
  state: ScenarioDraftRecoveryState
  submit(inputZh: string, clarifications: readonly Clarification[], forceGenerate: boolean): void
  retryTransport(): void
  discard(): void
  clearAfterStart(requestId: string): void
} {
  const runtimeRef = useRef<ScenarioDraftRecoveryRuntime | null>(null)
  if (!runtimeRef.current) runtimeRef.current = createScenarioDraftRecoveryRuntime()
  const runtime = runtimeRef.current
  const [state, setState] = useState<ScenarioDraftRecoveryState>(() => runtime.getState())

  useEffect(() => {
    const unsubscribe = runtime.subscribe(setState)
    const resume = () => runtime.setObservationAllowed(!activeSession)
    const pauseForPageHide = () => runtime.setObservationAllowed(false)
    runtime.setObservationAllowed(!activeSession)
    runtime.mount()
    window.addEventListener('online', resume)
    window.addEventListener('offline', resume)
    window.addEventListener('pageshow', resume)
    window.addEventListener('pagehide', pauseForPageHide)
    document.addEventListener('visibilitychange', resume)
    return () => {
      unsubscribe()
      window.removeEventListener('online', resume)
      window.removeEventListener('offline', resume)
      window.removeEventListener('pageshow', resume)
      window.removeEventListener('pagehide', pauseForPageHide)
      document.removeEventListener('visibilitychange', resume)
      runtime.dispose()
    }
  }, [activeSession, runtime])

  return {
    state,
    submit: useCallback((inputZh, clarifications, forceGenerate) => runtime.replace(inputZh, clarifications, forceGenerate), [runtime]),
    retryTransport: useCallback(() => runtime.retryTransport(), [runtime]),
    discard: useCallback(() => runtime.discard(), [runtime]),
    clearAfterStart: useCallback((requestId) => runtime.clearAfterStart(requestId), [runtime]),
  }
}
