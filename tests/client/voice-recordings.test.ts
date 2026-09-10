/**
 * [INPUT]: 录音开关、MediaRecorder 替身与独立录音存储入口
 * [OUTPUT]: 锁定开关拒绝、MIME 优先级、暂存 Blob 与重录废弃契约
 * [POS]: tests/client 的本机确认录音边界回归
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createVoiceCapture, deleteVoiceRecordingsForSessions, getVoiceRecording, hasVoiceRecording, readVoiceRecordingEnabled, saveVoiceRecording, selectVoiceRecordingMimeType, writeVoiceRecordingEnabled } from '../../src/lib/voice-recordings'

class FakeRecorder extends EventTarget {
  static supported = new Set<string>()
  static isTypeSupported(type: string): boolean { return FakeRecorder.supported.has(type) }
  state: RecordingState = 'inactive'
  mimeType: string
  ondataavailable: ((event: BlobEvent) => void) | null = null
  onstop: ((event: Event) => void) | null = null
  constructor(_stream: MediaStream, options?: MediaRecorderOptions) { super(); this.mimeType = options?.mimeType ?? 'audio/webm' }
  start(): void { this.state = 'recording' }
  stop(): void { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['voice'], { type: this.mimeType }) } as BlobEvent); this.onstop?.(new Event('stop')) }
}

afterEach(() => vi.unstubAllGlobals())

function installRecordingDatabase(records = new Map<string, Record<string, unknown>>(), fail = false): Map<string, Record<string, unknown>> {
  const open = () => {
    const request: { result?: IDBDatabase; onupgradeneeded?: () => void; onsuccess?: () => void; onerror?: () => void; onblocked?: () => void; error?: DOMException | null } = {}
    const store = {
      put: (value: Record<string, unknown>) => records.set(String(value.id), value),
      delete: (id: string) => records.delete(id),
      get: (id: string) => { const result = { result: undefined as unknown, onsuccess: undefined as (() => void) | undefined, onerror: undefined as (() => void) | undefined }; queueMicrotask(() => { result.result = records.get(id); result.onsuccess?.() }); return result },
      getKey: (id: string) => { const result = { result: undefined as unknown, onsuccess: undefined as (() => void) | undefined, onerror: undefined as (() => void) | undefined }; queueMicrotask(() => { result.result = records.has(id) ? id : undefined; result.onsuccess?.() }); return result },
      getAll: () => { const result = { result: undefined as unknown, onsuccess: undefined as (() => void) | undefined, onerror: undefined as (() => void) | undefined }; queueMicrotask(() => { result.result = [...records.values()]; result.onsuccess?.() }); return result },
    }
    const database = { close: vi.fn(), transaction: () => {
      const transaction = { objectStore: () => store, oncomplete: undefined as (() => void) | undefined, onabort: undefined as (() => void) | undefined, onerror: undefined as (() => void) | undefined, error: fail ? new DOMException('quota', 'QuotaExceededError') : null }
      queueMicrotask(() => queueMicrotask(() => fail ? transaction.onabort?.() : transaction.oncomplete?.()))
      return transaction
    } }
    queueMicrotask(() => { request.result = database as unknown as IDBDatabase; request.onsuccess?.() })
    return request
  }
  vi.stubGlobal('indexedDB', { open })
  return records
}
function installDelayedRecordingDatabase(): { records: Map<string, Record<string, unknown>>; releaseLatestOpen: () => void; waitForOpen: () => Promise<void> } {
  const records = new Map<string, Record<string, unknown>>()
  const opens: Array<{ result?: IDBDatabase; onsuccess?: () => void }> = []
  const openWaiters: Array<() => void> = []
  const open = () => {
    const request: { result?: IDBDatabase; onsuccess?: () => void } = {}
    opens.push(request)
    for (const resolve of openWaiters.splice(0)) resolve()
    return request
  }
  const store = {
    put: (value: Record<string, unknown>) => { queueMicrotask(() => records.set(String(value.id), value)) },
    delete: (id: string) => records.delete(id),
    getAll: () => { const result = { result: undefined as unknown, onsuccess: undefined as (() => void) | undefined }; queueMicrotask(() => { result.result = [...records.values()]; result.onsuccess?.() }); return result },
  }
  const database = { close: vi.fn(), transaction: () => {
    const transaction = { objectStore: () => store, oncomplete: undefined as (() => void) | undefined, onabort: undefined as (() => void) | undefined, onerror: undefined as (() => void) | undefined, error: null }
    queueMicrotask(() => queueMicrotask(() => transaction.oncomplete?.()))
    return transaction
  } }
  vi.stubGlobal('indexedDB', { open: () => { const request = open(); request.result = database as unknown as IDBDatabase; return request } })
  return {
    records,
    releaseLatestOpen: () => opens.pop()?.onsuccess?.(),
    waitForOpen: () => opens.length > 0 ? Promise.resolve() : new Promise(resolve => openWaiters.push(resolve)),
  }
}

describe('本机确认录音', () => {
  it('按 opus、mp4、浏览器默认的顺序选择 MIME', () => {
    FakeRecorder.supported = new Set(['audio/webm;codecs=opus', 'audio/mp4'])
    expect(selectVoiceRecordingMimeType(FakeRecorder as unknown as typeof MediaRecorder)).toBe('audio/webm;codecs=opus')
    FakeRecorder.supported = new Set(['audio/mp4'])
    expect(selectVoiceRecordingMimeType(FakeRecorder as unknown as typeof MediaRecorder)).toBe('audio/mp4')
    FakeRecorder.supported = new Set()
    expect(selectVoiceRecordingMimeType(FakeRecorder as unknown as typeof MediaRecorder)).toBeUndefined()
  })

  it('存储拒绝时保持默认关闭，写入不抛出', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } })
    expect(readVoiceRecordingEnabled()).toBe(false)
    expect(writeVoiceRecordingEnabled(true)).toBe(false)
  })

  it('停止后仅暂存 Blob，重新录音会让旧回调失效', async () => {
    vi.stubGlobal('MediaRecorder', FakeRecorder)
    const capture = createVoiceCapture(() => 100)
    const key = { sessionId: 'session', turn: 1, kind: 'round' as const }
    expect(capture.start({} as MediaStream, key)).toBe('started')
    const pending = await capture.stop()
    expect(pending).toMatchObject({ sessionId: 'session', turn: 1, kind: 'round', durationMs: 0, mimeType: 'audio/webm' })
    expect(pending?.blob).toBeInstanceOf(Blob)
    capture.start({} as MediaStream, { ...key, turn: 2 })
    capture.discard()
    expect(await capture.stop()).toBeNull()
  })

  it('只在显式保存后持久化 Blob，并懒读取存在性与内容', async () => {
    const records = installRecordingDatabase()
    const pending = { sessionId: 'session', turn: 1, kind: 'round' as const, blob: new Blob(['voice'], { type: 'audio/webm' }), createdAt: 1, durationMs: 20, mimeType: 'audio/webm' }
    expect(records.size).toBe(0)
    await saveVoiceRecording(pending)
    expect(await hasVoiceRecording(pending)).toBe(true)
    expect((await getVoiceRecording(pending))?.blob).toBe(pending.blob)
  })

  it('删除排在保存之后时不会留下迟到的录音', async () => {
    const delayed = installDelayedRecordingDatabase()
    const pending = { sessionId: 'deleted-session', turn: 1, kind: 'round' as const, blob: new Blob(['voice']), createdAt: 1, durationMs: 1, mimeType: 'audio/webm' }
    const firstOpen = delayed.waitForOpen()
    const save = saveVoiceRecording(pending)
    const deletion = deleteVoiceRecordingsForSessions([pending.sessionId])
    await firstOpen
    delayed.releaseLatestOpen()
    await delayed.waitForOpen()
    delayed.releaseLatestOpen()
    await Promise.all([save, deletion])
    expect(delayed.records.has('deleted-session:1:round')).toBe(false)
  })

  it('写入事务失败会拒绝', async () => {
    installRecordingDatabase(new Map(), true)
    await expect(saveVoiceRecording({ sessionId: 'session', turn: 1, kind: 'round', blob: new Blob(['voice']), createdAt: 1, durationMs: 1, mimeType: 'audio/webm' })).rejects.toThrow('quota')
  })

  it('仅保留最新二十个会话，并且按目标会话删除', async () => {
    const records = installRecordingDatabase()
    for (let index = 0; index < 21; index += 1) await saveVoiceRecording({ sessionId: `session-${index}`, turn: 1, kind: 'round', blob: new Blob([String(index)]), createdAt: index, durationMs: 1, mimeType: 'audio/webm' })
    expect(await hasVoiceRecording({ sessionId: 'session-0', turn: 1, kind: 'round' })).toBe(false)
    expect(await hasVoiceRecording({ sessionId: 'session-20', turn: 1, kind: 'round' })).toBe(true)
    await deleteVoiceRecordingsForSessions(['session-20'])
    expect(await hasVoiceRecording({ sessionId: 'session-20', turn: 1, kind: 'round' })).toBe(false)
    expect(await hasVoiceRecording({ sessionId: 'session-19', turn: 1, kind: 'round' })).toBe(true)
    expect(records.size).toBe(19)
  })
})
