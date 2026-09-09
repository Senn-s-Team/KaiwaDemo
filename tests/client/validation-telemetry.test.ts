/**
 * [INPUT]: React harness、匿名验证生命周期 hook 与可控出站边界
 * [OUTPUT]: 锁定无同意输入时 checkpoint 自动入队，并以 v2 collection wire batch 发送
 * [POS]: tests/client 的匿名技术验证自动收集契约
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
// @vitest-environment jsdom
import { createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ValidationRecord } from '../../shared/validation-telemetry'
import type { ValidationRecordSender } from '../../src/lib/validation-outbox'

const sendValidationBatch = vi.fn<(batch: unknown) => Promise<void>>().mockResolvedValue(undefined)
const enqueueValidationRecord = vi.fn<(batchId: string, sessionId: string, sentAt: number, record: ValidationRecord) => Promise<void>>().mockResolvedValue(undefined)
const flushValidationOutbox = vi.fn<(sender: ValidationRecordSender, sessionId: string) => Promise<void>>()
const getOrCreateValidationClientId = vi.fn<() => string | null>().mockReturnValue('00000000-0000-4000-8000-000000000001')

vi.mock('../../src/lib/api', () => ({ sendValidationBatch }))
vi.mock('../../src/lib/validation-outbox', () => ({ enqueueValidationRecord, flushValidationOutbox }))
vi.mock('../../src/lib/validation-client', () => ({ getOrCreateValidationClientId }))

describe('automatic validation telemetry lifecycle', () => {
  let root: Root | null = null
  let container: HTMLDivElement

  beforeEach(() => {
    vi.resetModules()
    sendValidationBatch.mockClear()
    enqueueValidationRecord.mockClear()
    flushValidationOutbox.mockReset()
    getOrCreateValidationClientId.mockClear().mockReturnValue('00000000-0000-4000-8000-000000000001')
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    root?.unmount()
    root = null
    container.remove()
    vi.clearAllMocks()
  })

  it('enqueues and sends a v2 batch without any consent decision', async () => {
    const { useValidationTelemetry } = await import('../../src/lib/use-validation-telemetry')
    const record: ValidationRecord = {
      kind: 'checkpoint', eventId: '15bd5b4c-8f69-4c86-a7d5-bfe0cfa40ae5', sequence: 1, occurredAt: 100,
      stage: 'session_starting', turn: null, event: 'session_started', failureDomain: null, failureCode: null,
      recoverable: false, recovered: false, latencyMs: null,
    }
    let queuedEntry: Parameters<ValidationRecordSender>[0] | null = null
    enqueueValidationRecord.mockImplementation(async (batchId, sessionId, sentAt, queuedRecord) => {
      queuedEntry = { batchId, sessionId, sentAt, record: queuedRecord }
    })
    flushValidationOutbox.mockImplementation(async (sender, sessionId) => {
      if (!queuedEntry || queuedEntry.sessionId !== sessionId) return
      const entry = queuedEntry
      queuedEntry = null
      await sender(entry)
    })
    function Harness(): React.JSX.Element {
      const telemetry = useValidationTelemetry({ telemetrySession: { sessionId: 'dyn_ses_1234567890abcdef', telemetryToken: 'telemetry-token' } })
      useEffect(() => { telemetry.checkpoint({ stage: 'session_starting', turn: null, event: 'session_started' }, 'session-started') }, [telemetry])
      return createElement('div')
    }
    const mounted = createRoot(container)
    root = mounted
    flushSync(() => mounted.render(createElement(Harness)))
    await Promise.resolve()
    await Promise.resolve()
    expect(enqueueValidationRecord).toHaveBeenCalledOnce()
    expect(sendValidationBatch).toHaveBeenCalledOnce()
    expect(sendValidationBatch.mock.calls[0]?.[0]).toMatchObject({
      schemaVersion: 2,
      anonymousMetricsCollection: true,
      sessionId: 'dyn_ses_1234567890abcdef',
      telemetryToken: 'telemetry-token',
    })
  })
})
