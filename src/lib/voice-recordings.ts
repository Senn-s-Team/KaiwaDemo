/**
 * [INPUT]: 浏览器 MediaRecorder、IndexedDB 与可选的本机保存开关
 * [OUTPUT]: 提供录音开关、压缩录音暂存、独立 Blob 存储、会话裁剪与懒读取接口
 * [POS]: src/lib 的本机录音边界；录音 Blob 永不进入练习历史、报告或网络请求
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
export type VoiceRecordingKind = 'round' | 'redo'

export interface VoiceRecordingKey {
  sessionId: string
  turn: number
  kind: VoiceRecordingKind
}

export interface StoredVoiceRecording extends VoiceRecordingKey {
  id: string
  blob: Blob
  createdAt: number
  durationMs: number
  mimeType: string
}

export interface PendingVoiceRecording extends VoiceRecordingKey {
  blob: Blob
  createdAt: number
  durationMs: number
  mimeType: string
}

const settingKey = 'kaiwa-save-voice-recordings'
const databaseName = 'kaiwa-voice-recordings'
const storeName = 'recordings'
const maxSessions = 20

function recordingId(key: VoiceRecordingKey): string {
  return `${key.sessionId}:${key.turn}:${key.kind}`
}

export function readVoiceRecordingEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem(settingKey) === 'true'
  } catch {
    return false
  }
}

export function writeVoiceRecordingEnabled(enabled: boolean): boolean {
  try {
    globalThis.localStorage?.setItem(settingKey, String(enabled))
    return true
  } catch {
    return false
  }
}

export function selectVoiceRecordingMimeType(Recorder: typeof MediaRecorder | undefined = globalThis.MediaRecorder): string | undefined {
  if (!Recorder) return undefined
  if (Recorder.isTypeSupported('audio/webm;codecs=opus')) return 'audio/webm;codecs=opus'
  if (Recorder.isTypeSupported('audio/mp4')) return 'audio/mp4'
  return undefined
}

function openRecordings(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('当前浏览器无法保存录音')); return }
    const request = indexedDB.open(databaseName, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(storeName, { keyPath: 'id' })
    request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result) }
    request.onerror = () => reject(request.error ?? new Error('无法打开本机录音'))
    request.onblocked = () => reject(new Error('本机录音存储被占用'))
  })
}

export async function saveVoiceRecording(pending: PendingVoiceRecording): Promise<void> {
  const database = await openRecordings()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readwrite')
    const store = transaction.objectStore(storeName)
    transaction.oncomplete = () => { database.close(); resolve() }
    transaction.onabort = () => { database.close(); reject(transaction.error ?? new Error('本机录音未保存')) }
    transaction.onerror = () => undefined
    store.put({ ...pending, id: recordingId(pending) } satisfies StoredVoiceRecording)
    const all = store.getAll()
    all.onsuccess = () => {
      const sessions = new Map<string, number>()
      for (const item of all.result as StoredVoiceRecording[]) {
        sessions.set(item.sessionId, Math.max(sessions.get(item.sessionId) ?? 0, item.createdAt))
      }
      const retained = new Set([...sessions.entries()].sort((left, right) => right[1] - left[1]).slice(0, maxSessions).map(([sessionId]) => sessionId))
      for (const item of all.result as StoredVoiceRecording[]) {
        if (!retained.has(item.sessionId)) store.delete(item.id)
      }
    }
  })
}

export async function getVoiceRecording(key: VoiceRecordingKey): Promise<StoredVoiceRecording | null> {
  const database = await openRecordings()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readonly')
    const request = transaction.objectStore(storeName).get(recordingId(key))
    request.onsuccess = () => resolve((request.result as StoredVoiceRecording | undefined) ?? null)
    request.onerror = () => reject(request.error ?? new Error('无法读取本机录音'))
    transaction.oncomplete = () => database.close()
    transaction.onabort = () => { database.close(); reject(transaction.error ?? new Error('无法读取本机录音')) }
  })
}

export async function hasVoiceRecording(key: VoiceRecordingKey): Promise<boolean> {
  const database = await openRecordings()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readonly')
    const request = transaction.objectStore(storeName).getKey(recordingId(key))
    request.onsuccess = () => resolve(request.result !== undefined)
    request.onerror = () => reject(request.error ?? new Error('无法读取本机录音'))
    transaction.oncomplete = () => database.close()
    transaction.onabort = () => { database.close(); reject(transaction.error ?? new Error('无法读取本机录音')) }
  })
}

export async function deleteVoiceRecordingsForSessions(sessionIds: readonly string[]): Promise<void> {
  if (sessionIds.length === 0) return
  const targets = new Set(sessionIds)
  const database = await openRecordings()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readwrite')
    const store = transaction.objectStore(storeName)
    const all = store.getAll()
    all.onsuccess = () => {
      for (const item of all.result as StoredVoiceRecording[]) if (targets.has(item.sessionId)) store.delete(item.id)
    }
    transaction.oncomplete = () => { database.close(); resolve() }
    transaction.onabort = () => { database.close(); reject(transaction.error ?? new Error('本机录音删除失败')) }
  })
}

export interface VoiceCapture {
  start(stream: MediaStream, key: VoiceRecordingKey): 'started' | 'unavailable'
  stop(): Promise<PendingVoiceRecording | null>
  discard(): void
}

export function createVoiceCapture(now: () => number = Date.now): VoiceCapture {
  let recorder: MediaRecorder | null = null
  let generation = 0
  let startedAt = 0
  let activeKey: VoiceRecordingKey | null = null
  let chunks: Blob[] = []
  let pending: PendingVoiceRecording | null = null

  const discard = () => {
    generation += 1
    pending = null
    chunks = []
    activeKey = null
    if (recorder && recorder.state !== 'inactive') recorder.stop()
    recorder = null
  }

  return {
    start(stream, key) {
      discard()
      if (!globalThis.MediaRecorder) return 'unavailable'
      const currentGeneration = ++generation
      const mimeType = selectVoiceRecordingMimeType()
      try {
        recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
      } catch {
        recorder = null
        return 'unavailable'
      }
      activeKey = key
      chunks = []
      startedAt = now()
      recorder.ondataavailable = (event) => {
        if (currentGeneration === generation && event.data.size > 0) chunks.push(event.data)
      }
      recorder.onstop = () => {
        if (currentGeneration !== generation || !activeKey) return
        const blob = new Blob(chunks, { type: recorder?.mimeType || mimeType || 'audio/webm' })
        pending = blob.size > 0 ? { ...activeKey, blob, createdAt: now(), durationMs: Math.max(0, now() - startedAt), mimeType: blob.type } : null
        chunks = []
      }
      recorder.start()
      return 'started'
    },
    stop() {
      const currentGeneration = generation
      const activeRecorder = recorder
      if (!activeRecorder || activeRecorder.state === 'inactive') return Promise.resolve(pending)
      return new Promise((resolve) => {
        const previousStop = activeRecorder.onstop
        activeRecorder.onstop = (event) => { previousStop?.call(activeRecorder, event); resolve(currentGeneration === generation ? pending : null) }
        activeRecorder.stop()
      })
    },
    discard,
  }
}
