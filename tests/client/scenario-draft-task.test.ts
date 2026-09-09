/**
 * [INPUT]: 可恢复场景草稿控制器、内存 storage、可控草稿 task API
 * [OUTPUT]: 验证未完成草稿请求持久化、前后台恢复、成功与失败终态清理、同封套重试、代际隔离及错误分类
 * [POS]: tests/client 的首页场景草稿恢复回归契约，不依赖真实网络或浏览器刷新
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { ZodError } from 'zod'
import { ApiError } from '../../src/lib/api'
import {
  SCENARIO_DRAFT_STORAGE_KEY,
  createScenarioDraftRecoveryRuntime,
  type ScenarioDraftRecoveryApi,
} from '../../src/lib/scenario-draft-task'
import type { ScenarioDraftTaskRequest } from '../../shared/scenario-draft'

class MemoryStorage implements Storage {
  #entries = new Map<string, string>()

  get length(): number { return this.#entries.size }
  clear(): void { this.#entries.clear() }
  getItem(key: string): string | null { return this.#entries.get(key) ?? null }
  key(index: number): string | null { return [...this.#entries.keys()][index] ?? null }
  removeItem(key: string): void { this.#entries.delete(key) }
  setItem(key: string, value: string): void { this.#entries.set(key, value) }
}

function acceptedApi(onSubmit?: (request: ScenarioDraftTaskRequest) => void): ScenarioDraftRecoveryApi {
  return {
    submit: async (request) => {
      onSubmit?.(request)
      return { taskToken: 'task-token', expiresAt: Date.now() + 86_400_000 }
    },
    get: async () => ({ status: 'pending' }),
  }
}

function tick(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  queueMicrotask(resolve)
  return promise
}

describe('recoverable scenario draft controller', () => {
  it('persists the idempotency envelope before requesting acceptance and restores its pending token', async () => {
    const storage = new MemoryStorage()
    let submitted: ScenarioDraftTaskRequest | null = null
    const runtime = createScenarioDraftRecoveryRuntime({ api: acceptedApi((request) => { submitted = request }), storage })

    runtime.mount()
    runtime.replace('预约理发', [], false)

    const raw = storage.getItem(SCENARIO_DRAFT_STORAGE_KEY)
    expect(raw).not.toBeNull()
    const beforeAcceptance = JSON.parse(raw ?? 'null') as { request: ScenarioDraftTaskRequest }
    expect(beforeAcceptance.request.requestId).toMatch(/^[0-9a-f-]{36}$/)
    await tick()
    await tick()
    expect(submitted).toEqual(beforeAcceptance.request)
    expect(JSON.parse(storage.getItem(SCENARIO_DRAFT_STORAGE_KEY) ?? 'null').taskToken).toBe('task-token')

    const reloaded = createScenarioDraftRecoveryRuntime({ api: acceptedApi(), storage })
    reloaded.mount()
    await tick()
    expect(reloaded.getState()).toMatchObject({ status: 'pending', request: beforeAcceptance.request })
  })

  it('ignores legacy draft pointers so they cannot replace the homepage', async () => {
    const storage = new MemoryStorage()
    const request = { requestId: crypto.randomUUID(), createdAt: Date.now(), inputZh: '旧理发场景', clarifications: [], forceGenerate: false }
    storage.setItem('kaiwa.scenario-draft-task.v1', JSON.stringify({ version: 1, request, taskToken: 'completed-token' }))
    storage.setItem('kaiwa.scenario-draft-task.v2', JSON.stringify({ version: 2, request, taskToken: 'failed-token' }))
    const get = vi.fn().mockResolvedValue({ status: 'complete', result: { status: 'needs_clarification', questionZh: '想约哪一天？', optionsZh: ['周末'] } })
    const runtime = createScenarioDraftRecoveryRuntime({
      storage,
      api: {
        submit: async () => ({ taskToken: 'unused', expiresAt: Date.now() + 86_400_000 }),
        get,
      },
    })

    runtime.mount()
    await tick()
    expect(get).not.toHaveBeenCalled()
    expect(runtime.getState().status).toBe('idle')
    expect(storage.getItem('kaiwa.scenario-draft-task.v1')).toBeNull()
    expect(storage.getItem('kaiwa.scenario-draft-task.v2')).toBeNull()
  })

  it('clears the current envelope when its result becomes ready', async () => {
    const storage = new MemoryStorage()
    const runtime = createScenarioDraftRecoveryRuntime({
      storage,
      api: {
        submit: async () => ({ taskToken: 'task-token', expiresAt: Date.now() + 86_400_000 }),
        get: async () => ({ status: 'complete', result: { status: 'needs_clarification', questionZh: '想约哪一天？', optionsZh: ['周末'] } }),
      },
    })

    runtime.mount()
    runtime.replace('预约理发', [], false)
    await tick()
    await tick()
    expect(runtime.getState()).toMatchObject({ status: 'ready', result: { status: 'needs_clarification' } })
    expect(storage.getItem(SCENARIO_DRAFT_STORAGE_KEY)).toBeNull()
  })

  it('pauses local observation while hidden and resumes the existing task without generating a new request', async () => {
    const storage = new MemoryStorage()
    let foreground = true
    let submitCount = 0
    let getCount = 0
    const api: ScenarioDraftRecoveryApi = {
      submit: async () => {
        submitCount += 1
        return { taskToken: 'task-token', expiresAt: Date.now() + 86_400_000 }
      },
      get: async () => {
        getCount += 1
        return { status: 'pending' }
      },
    }
    const runtime = createScenarioDraftRecoveryRuntime({ api, storage, isForeground: () => foreground })

    runtime.mount()
    runtime.replace('预约理发', [], false)
    await tick()
    await tick()
    runtime.setObservationAllowed(false)
    foreground = false
    const pausedGetCount = getCount
    runtime.retryTransport()
    await tick()
    expect(getCount).toBe(pausedGetCount)

    foreground = true
    runtime.setObservationAllowed(true)
    await tick()
    expect(submitCount).toBe(1)
    expect(getCount).toBeGreaterThan(pausedGetCount)
  })

  it('reuses the same envelope after a lost acceptance response, while terminal retry creates a new UUID', async () => {
    const storage = new MemoryStorage()
    const requests: ScenarioDraftTaskRequest[] = []
    let first = true
    const api: ScenarioDraftRecoveryApi = {
      submit: async (request) => {
        requests.push(request)
        if (first) {
          first = false
          throw new TypeError('connection lost after acceptance')
        }
        return { taskToken: 'task-token', expiresAt: Date.now() + 86_400_000 }
      },
      get: async () => ({ status: 'failed', error: { code: 'generation_failed', message: '生成失败' } }),
    }
    const runtime = createScenarioDraftRecoveryRuntime({ api, storage })

    runtime.mount()
    runtime.replace('预约理发', [], false)
    await tick()
    expect(runtime.getState().status).toBe('transport_error')
    runtime.retryTransport()
    await tick()
    await tick()
    expect(requests[1]).toEqual(requests[0])
    expect(runtime.getState().status).toBe('failed')
    expect(storage.getItem(SCENARIO_DRAFT_STORAGE_KEY)).toBeNull()

    runtime.replace('预约理发', [], false)
    await tick()
    expect(requests[2].requestId).not.toBe(requests[0].requestId)
  })

  it('ignores a stale completed response after input replacement', async () => {
    const storage = new MemoryStorage()
    const oldStatus = Promise.withResolvers<{ status: 'complete'; result: { status: 'needs_clarification'; questionZh: string; optionsZh: readonly string[] } }>()
    let getCall = 0
    const api: ScenarioDraftRecoveryApi = {
      submit: async (request) => ({ taskToken: `task-${request.inputZh}`, expiresAt: Date.now() + 86_400_000 }),
      get: () => {
        getCall += 1
        if (getCall === 1) return oldStatus.promise
        return Promise.resolve({ status: 'pending' })
      },
    }
    const runtime = createScenarioDraftRecoveryRuntime({ api, storage })

    runtime.mount()
    runtime.replace('旧输入', [], false)
    await tick()
    runtime.replace('新输入', [], false)
    await tick()
    await tick()
    oldStatus.resolve({ status: 'complete', result: { status: 'needs_clarification', questionZh: '要什么时间？', optionsZh: ['上午'] } })
    await tick()
    expect(runtime.getState()).toMatchObject({ status: 'pending', request: { inputZh: '新输入' } })
  })

  it('surfaces corrupt, expired, denied-storage, transport, and terminal task states without leaving busy forever', async () => {
    const corruptStorage = new MemoryStorage()
    corruptStorage.setItem(SCENARIO_DRAFT_STORAGE_KEY, '{broken')
    const corrupt = createScenarioDraftRecoveryRuntime({ api: acceptedApi(), storage: corruptStorage })
    corrupt.mount()
    expect(corrupt.getState()).toMatchObject({ status: 'expired', error: '无法恢复已损坏的练习草稿，请重新准备。' })

    const expiredStorage = new MemoryStorage()
    expiredStorage.setItem(SCENARIO_DRAFT_STORAGE_KEY, JSON.stringify({ version: 3, request: { requestId: crypto.randomUUID(), createdAt: 0, inputZh: '过期', clarifications: [], forceGenerate: false } }))
    const expired = createScenarioDraftRecoveryRuntime({ api: acceptedApi(), storage: expiredStorage, now: () => 86_400_001 })
    expired.mount()
    expect(expired.getState().status).toBe('expired')

    const deniedStorage = new MemoryStorage()
    deniedStorage.setItem = () => { throw new DOMException('denied', 'SecurityError') }
    const denied = createScenarioDraftRecoveryRuntime({ api: acceptedApi(), storage: deniedStorage })
    denied.mount()
    denied.replace('存储受限', [], false)
    await tick()
    expect(denied.getState()).toMatchObject({ status: 'pending' })
    expect(denied.getState().storageNotice).toContain('无法保存')

    const transport = createScenarioDraftRecoveryRuntime({
      api: { submit: async () => { throw new TypeError('offline') }, get: async () => ({ status: 'pending' }) },
      storage: new MemoryStorage(),
    })
    transport.mount()
    transport.replace('网络失败', [], false)
    await tick()
    expect(transport.getState().status).toBe('transport_error')

    const terminal = createScenarioDraftRecoveryRuntime({
      api: { submit: async () => { throw new ApiError('invalid_request', '请求无效', 400) }, get: async () => ({ status: 'pending' }) },
      storage: new MemoryStorage(),
    })
    terminal.mount()
    terminal.replace('请求失败', [], false)
    await tick()
    const deniedCapability = createScenarioDraftRecoveryRuntime({
      api: {
        submit: async () => ({ taskToken: 'bad-token', expiresAt: Date.now() + 86_400_000 }),
        get: async () => { throw new ApiError('unauthorized', '恢复凭据无效', 401) },
      },
      storage: new MemoryStorage(),
    })
    deniedCapability.mount()
    deniedCapability.replace('凭据失效', [], false)
    await tick()
    await tick()
    expect(deniedCapability.getState()).toMatchObject({ status: 'failed', error: '恢复凭据无效' })

    const expiredTask = createScenarioDraftRecoveryRuntime({
      api: {
        submit: async () => ({ taskToken: 'expired-token', expiresAt: Date.now() + 86_400_000 }),
        get: async () => { throw new ApiError('gone', '任务已过期', 410) },
      },
      storage: new MemoryStorage(),
    })
    expiredTask.mount()
    expiredTask.replace('任务过期', [], false)
    await tick()
    await tick()
    expect(expiredTask.getState().status).toBe('expired')
    expect(terminal.getState()).toMatchObject({ status: 'failed', error: '请求无效' })
  })

  it('handles unavailable browser storage without crashing the homepage runtime', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage')
    Object.defineProperty(window, 'localStorage', { configurable: true, get: () => { throw new DOMException('denied', 'SecurityError') } })
    try {
      const runtime = createScenarioDraftRecoveryRuntime({ api: acceptedApi() })
      runtime.mount()
      runtime.replace('存储访问受限', [], false)
      await tick()
      expect(runtime.getState()).toMatchObject({ status: 'pending' })
      expect(runtime.getState().storageNotice).toContain('无法保存')
      runtime.dispose()
    } finally {
      if (descriptor) Object.defineProperty(window, 'localStorage', descriptor)
      else Reflect.deleteProperty(window, 'localStorage')
    }
  })

  it('rejects invalid persisted envelopes and expires an in-memory envelope before a later retry', async () => {
    const invalidRequests = [
      { requestId: 'not-a-uuid', createdAt: 1, inputZh: '有效', clarifications: [], forceGenerate: false },
      { requestId: crypto.randomUUID(), createdAt: -1, inputZh: '有效', clarifications: [], forceGenerate: false },
      { requestId: crypto.randomUUID(), createdAt: 1.5, inputZh: '有效', clarifications: [], forceGenerate: false },
      { requestId: crypto.randomUUID(), createdAt: 1, inputZh: '', clarifications: [], forceGenerate: false },
      { requestId: crypto.randomUUID(), createdAt: 1, inputZh: '过'.repeat(301), clarifications: [], forceGenerate: false },
      { requestId: crypto.randomUUID(), createdAt: 1, inputZh: '有效', clarifications: [], forceGenerate: 'false' },
    ]
    for (const request of invalidRequests) {
      const storage = new MemoryStorage()
      storage.setItem(SCENARIO_DRAFT_STORAGE_KEY, JSON.stringify({ version: 3, request }))
      const runtime = createScenarioDraftRecoveryRuntime({ api: acceptedApi(), storage })
      runtime.mount()
      expect(runtime.getState().status).toBe('expired')
    }

    let now = 1
    const runtime = createScenarioDraftRecoveryRuntime({ api: acceptedApi(), storage: new MemoryStorage(), now: () => now })
    runtime.mount()
    runtime.replace('稍后过期', [], false)
    await tick()
    now += 86_400_000
    runtime.retryTransport()
    expect(runtime.getState().status).toBe('expired')
  })

  it('turns submit and status-query deadline aborts into transport recovery, while malformed wire data is terminal', async () => {
    vi.useFakeTimers()
    const pendingSubmit = Promise.withResolvers<{ taskToken: string; expiresAt: number }>()
    const submitRuntime = createScenarioDraftRecoveryRuntime({
      api: {
        submit: (_request, signal) => {
          signal?.addEventListener('abort', () => pendingSubmit.reject(new DOMException('aborted', 'AbortError')), { once: true })
          return pendingSubmit.promise
        },
        get: async () => ({ status: 'pending' }),
      },
      storage: new MemoryStorage(),
    })
    try {
      submitRuntime.mount()
      submitRuntime.replace('提交超时', [], false)
      await vi.advanceTimersByTimeAsync(25_000)
      expect(submitRuntime.getState()).toMatchObject({ status: 'transport_error', error: '请求超时，请稍后重试。' })
    } finally {
      submitRuntime.dispose()
      vi.useRealTimers()
    }

    vi.useFakeTimers()
    const pendingQuery = Promise.withResolvers<{ status: 'pending' }>()
    const queryRuntime = createScenarioDraftRecoveryRuntime({
      api: {
        submit: async () => ({ taskToken: 'query-token', expiresAt: Date.now() + 86_400_000 }),
        get: (_token, signal) => {
          signal?.addEventListener('abort', () => pendingQuery.reject(new DOMException('aborted', 'AbortError')), { once: true })
          return pendingQuery.promise
        },
      },
      storage: new MemoryStorage(),
    })
    try {
      queryRuntime.mount()
      queryRuntime.replace('查询超时', [], false)
      await tick()
      await vi.advanceTimersByTimeAsync(25_000)
      expect(queryRuntime.getState()).toMatchObject({ status: 'transport_error', error: '查询超时，请稍后重试。' })
    } finally {
      queryRuntime.dispose()
      vi.useRealTimers()
    }

    const malformed = createScenarioDraftRecoveryRuntime({
      api: { submit: async () => { throw new ZodError([]) }, get: async () => ({ status: 'pending' }) },
      storage: new MemoryStorage(),
    })
    malformed.mount()
    malformed.replace('错误响应', [], false)
    await tick()
    expect(malformed.getState()).toMatchObject({ status: 'failed', error: '服务返回的数据无效，请重新准备。' })
  })
})
