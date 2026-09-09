/**
 * [INPUT]: shared 严格 record 契约与浏览器 IndexedDB
 * [OUTPUT]: 独立且不含会话凭据的遥测事实出站队列与有界重试
 * [POS]: src/lib 的遥测交付边界；凭据仅由内存调用方在发送时提供
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { ValidationRecordSchema, type ValidationRecord } from '../../shared/validation-telemetry'

const DATABASE_NAME = 'kaiwa-validation-telemetry'
const DATABASE_VERSION = 2
const STORE_NAME = 'records'
const MAX_RETRY_ATTEMPTS = 5
const INITIAL_RETRY_DELAY_MS = 1_000
const MAX_RETRY_DELAY_MS = 60_000

export interface QueuedValidationRecord {
  batchId: string
  sessionId: string
  sentAt: number
  record: ValidationRecord
  attemptCount: number
  nextAttemptAt: number
}

export type ValidationRecordSender = (entry: Pick<QueuedValidationRecord, 'batchId' | 'sessionId' | 'sentAt' | 'record'>) => Promise<void>

function openDatabase(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB) return Promise.reject(new Error('IndexedDB is unavailable.'))
  const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>()
  const request = globalThis.indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
  request.onerror = () => reject(request.error ?? new Error('Unable to open telemetry storage.'))
  request.onupgradeneeded = () => {
    if (request.result.objectStoreNames.contains('batches')) request.result.deleteObjectStore('batches')
    if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME, { keyPath: 'batchId' })
  }
  request.onsuccess = () => resolve(request.result)
  return promise
}

function completeTransaction(transaction: IDBTransaction): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  transaction.oncomplete = () => resolve()
  transaction.onabort = () => reject(transaction.error ?? new Error('Telemetry storage transaction aborted.'))
  transaction.onerror = () => reject(transaction.error ?? new Error('Telemetry storage transaction failed.'))
  return promise
}

function retryDelay(attemptCount: number): number {
  return Math.min(INITIAL_RETRY_DELAY_MS * 2 ** Math.max(0, attemptCount - 1), MAX_RETRY_DELAY_MS)
}

async function readAll(database: IDBDatabase): Promise<QueuedValidationRecord[]> {
  const transaction = database.transaction(STORE_NAME, 'readonly')
  const request = transaction.objectStore(STORE_NAME).getAll()
  const { promise, resolve, reject } = Promise.withResolvers<QueuedValidationRecord[]>()
  request.onsuccess = () => resolve(request.result as QueuedValidationRecord[])
  request.onerror = () => reject(request.error ?? new Error('Unable to read telemetry storage.'))
  const records = await promise
  await completeTransaction(transaction)
  return records
}

export async function enqueueValidationRecord(batchId: string, sessionId: string, sentAt: number, record: ValidationRecord, now = Date.now()): Promise<void> {
  const parsed = ValidationRecordSchema.parse(record)
  const database = await openDatabase()
  try {
    const transaction = database.transaction(STORE_NAME, 'readwrite')
    transaction.objectStore(STORE_NAME).put({ batchId, sessionId, sentAt, record: parsed, attemptCount: 0, nextAttemptAt: now } satisfies QueuedValidationRecord)
    await completeTransaction(transaction)
  } finally { database.close() }
}

export async function listValidationRecords(): Promise<QueuedValidationRecord[]> {
  const database = await openDatabase()
  try { return await readAll(database) } finally { database.close() }
}

export async function clearValidationOutbox(): Promise<void> {
  const database = await openDatabase()
  try {
    const transaction = database.transaction(STORE_NAME, 'readwrite')
    transaction.objectStore(STORE_NAME).clear()
    await completeTransaction(transaction)
  } finally { database.close() }
}

export async function flushValidationOutbox(sender: ValidationRecordSender, sessionId: string, now = Date.now()): Promise<void> {
  const database = await openDatabase()
  try {
    for (const entry of await readAll(database)) {
      if (entry.sessionId !== sessionId) {
        const transaction = database.transaction(STORE_NAME, 'readwrite')
        transaction.objectStore(STORE_NAME).delete(entry.batchId)
        await completeTransaction(transaction)
        continue
      }
      if (entry.nextAttemptAt > now) continue
      try {
        await sender(entry)
        const transaction = database.transaction(STORE_NAME, 'readwrite')
        transaction.objectStore(STORE_NAME).delete(entry.batchId)
        await completeTransaction(transaction)
      } catch {
        const attemptCount = entry.attemptCount + 1
        const transaction = database.transaction(STORE_NAME, 'readwrite')
        if (attemptCount >= MAX_RETRY_ATTEMPTS) transaction.objectStore(STORE_NAME).delete(entry.batchId)
        else transaction.objectStore(STORE_NAME).put({ ...entry, attemptCount, nextAttemptAt: now + retryDelay(attemptCount) } satisfies QueuedValidationRecord)
        await completeTransaction(transaction)
      }
    }
  } finally { database.close() }
}
