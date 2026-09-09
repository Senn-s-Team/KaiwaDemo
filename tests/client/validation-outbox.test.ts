/**
 * [INPUT]: 严格 telemetry record、回合事实与可控 IndexedDB 替身
 * [OUTPUT]: 锁定无凭据出站、重复 record 幂等、退避投递、队列清空与内容严格脱敏
 * [POS]: tests/client 的遥测出站与脱敏契约
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ValidationRecord } from '../../shared/validation-telemetry'
import { createRoundRecord } from '../../src/lib/metrics'
import { createValidationDedupeRegistry, createValidationRoundSnapshot, createValidationSequenceClock } from '../../src/lib/use-validation-telemetry'
import { clearValidationOutbox, enqueueValidationRecord, flushValidationOutbox, listValidationRecords } from '../../src/lib/validation-outbox'

const record: ValidationRecord = { kind: 'checkpoint', eventId: '15bd5b4c-8f69-4c86-a7d5-bfe0cfa40ae5', sequence: 1, occurredAt: 1, stage: 'session_starting', turn: null, event: 'session_started', failureDomain: null, failureCode: null, recoverable: false, recovered: false, latencyMs: null }

function installDatabase() {
  const entries = new Map<string, unknown>()
  const transaction = () => {
    const result = { error: null, oncomplete: undefined as undefined | (() => void), onabort: undefined as undefined | (() => void), onerror: undefined as undefined | (() => void), objectStore: () => ({
      put: (value: { batchId: string; sessionId: string }) => { entries.set(value.batchId, structuredClone(value)); queueMicrotask(() => result.oncomplete?.()) },
      delete: (key: string) => { entries.delete(key); queueMicrotask(() => result.oncomplete?.()) },
      clear: () => { entries.clear(); queueMicrotask(() => result.oncomplete?.()) },
      getAll: () => { const request = { result: undefined as unknown, onsuccess: undefined as undefined | (() => void), onerror: undefined as undefined | (() => void), error: null }; queueMicrotask(() => { request.result = [...entries.values()]; request.onsuccess?.(); queueMicrotask(() => result.oncomplete?.()) }); return request },
    }) }
    return result
  }
  vi.stubGlobal('indexedDB', { open: () => { const request = { result: { close: vi.fn(), transaction, objectStoreNames: { contains: () => true } }, onsuccess: undefined as undefined | (() => void), onerror: undefined as undefined | (() => void), onupgradeneeded: undefined as undefined | (() => void), error: null }; queueMicrotask(() => request.onsuccess?.()); return request } })
}

afterEach(() => vi.unstubAllGlobals())

describe('validation telemetry outbox', () => {
  it('does not use unavailable IndexedDB as a training dependency', async () => { vi.stubGlobal('indexedDB', undefined); await expect(enqueueValidationRecord('batch', 'dyn_ses_current', 1, record)).rejects.toThrow('IndexedDB is unavailable') })
  it('persists no telemetry credentials and deduplicates stable batch IDs', async () => {
    installDatabase()
    await enqueueValidationRecord('batch', 'dyn_ses_current', 1, record)
    await enqueueValidationRecord('batch', 'dyn_ses_current', 1, record)
    const [queued] = await listValidationRecords()
    expect(queued).toMatchObject({ batchId: 'batch', sessionId: 'dyn_ses_current', record })
    expect(JSON.stringify(queued)).not.toContain('telemetryToken')
    expect(JSON.stringify(queued)).not.toContain('会泄漏')
  })
  it('retries failure without blocking then deletes successful delivery', async () => {
    installDatabase(); await enqueueValidationRecord('batch', 'dyn_ses_current', 10, record, 10)
    await expect(flushValidationOutbox(vi.fn().mockRejectedValue(new Error('offline')), 'dyn_ses_current', 10)).resolves.toBeUndefined()
    expect((await listValidationRecords())[0]?.attemptCount).toBe(1)
    await flushValidationOutbox(vi.fn().mockResolvedValue(undefined), 'dyn_ses_current', 1_010)
    expect(await listValidationRecords()).toHaveLength(0)
  })
  it('clears queued telemetry when requested', async () => { installDatabase(); await enqueueValidationRecord('batch', 'dyn_ses_current', 1, record); await clearValidationOutbox(); expect(await listValidationRecords()).toHaveLength(0) })
  it('projects fixed facts without dialogue or audio content', () => {
    const round = createRoundRecord(1, '会泄漏的相手文本', 0); round.userOriginal = '会泄漏的原始转写'; round.userCleaned = '会泄漏的清洗转写'; round.userFinal = '会泄漏的确认文本'; round.nextAiReply = '会泄漏的相手回复'
    const snapshot = createValidationRoundSnapshot(round, 1, 'b17d2e5a-4d9a-453e-9577-a1c7e508bac8', 1, false)
    expect(JSON.stringify(snapshot)).not.toContain('会泄漏')
  })
  it('never sends an old session record with the current session token', async () => {
    installDatabase()
    await enqueueValidationRecord('old-batch', 'dyn_ses_old', 1, record)
    const sender = vi.fn()
    await flushValidationOutbox(sender, 'dyn_ses_current', 1)
    expect(sender).not.toHaveBeenCalled()
    expect(await listValidationRecords()).toHaveLength(0)
  })
  it('allows identical turn dedupe keys after the telemetry session changes', () => {
    const registry = createValidationDedupeRegistry()
    registry.add('round-completed:1')
    expect(registry.has('round-completed:1')).toBe(true)
    registry.reset()
    expect(registry.has('round-completed:1')).toBe(false)
  })
  it('uses timestamp-derived sequences that never restart at zero or collide within a mount', () => {
    const clock = createValidationSequenceClock(() => 42)
    expect([clock(), clock(), clock()]).toEqual([42_000, 42_001, 42_002])
  })
})
