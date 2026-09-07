/**
 * [INPUT]: 依赖完整动态场景、复练凭据、会话报告与反馈，以及浏览器 IndexedDB
 * [OUTPUT]: 提供本机练习历史保存、读取、按场景删除与稳定场景标识
 * [POS]: src/lib 的跨会话持久化边界，不保存会话或语音访问令牌
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import type { ConversationFeedbackResponse, DynamicScenarioData, SessionReport } from '../types'

export interface PracticeAttempt {
  scenario: DynamicScenarioData
  practiceToken: string
  report: SessionReport
  feedback: ConversationFeedbackResponse | null
}

export interface StoredPracticeAttempt extends PracticeAttempt {
  scenarioKey: string
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stableValue(item)]))
  }
  return value
}

export function getPracticeScenarioKey(scenario: DynamicScenarioData): string {
  return JSON.stringify(stableValue(scenario))
}

const databaseName = 'kaiwa-practice-history'
const storeName = 'attempts'

function openHistory(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error('当前浏览器无法保存练习历史'))
      return
    }
    const request = indexedDB.open(databaseName, 1)
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(storeName, { keyPath: 'report.sessionId' })
      store.createIndex('scenarioKey', 'scenarioKey')
    }
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close()
      resolve(request.result)
    }
    request.onerror = () => reject(request.error ?? new Error('无法打开练习历史'))
    request.onblocked = () => reject(new Error('请关闭其他页面后重试保存练习历史'))
  })
}

async function withStore<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore, result: (value: T) => void) => void): Promise<T> {
  const database = await openHistory()
  return new Promise<T>((resolve, reject) => {
    let result: T
    let transaction: IDBTransaction
    try {
      transaction = database.transaction(storeName, mode)
      transaction.oncomplete = () => { database.close(); resolve(result) }
      transaction.onabort = () => { database.close(); reject(transaction.error ?? new Error('练习历史操作未完成')) }
      transaction.onerror = () => { /* 事务中止后统一返回失败，避免成功请求掩盖提交失败。 */ }
      operation(transaction.objectStore(storeName), (value) => { result = value })
    } catch (error) {
      database.close()
      reject(error)
    }
  })
}

export function savePracticeAttempt(attempt: PracticeAttempt): Promise<void> {
  // 显式挑选持久化字段，不接受调用方附带的临时令牌。
  const record: StoredPracticeAttempt = {
    scenario: attempt.scenario,
    practiceToken: attempt.practiceToken,
    report: attempt.report,
    feedback: attempt.feedback,
    scenarioKey: getPracticeScenarioKey(attempt.scenario),
  }
  return withStore<void>('readwrite', (store, result) => {
    store.put(record)
    result(undefined)
  })
}

export function listPracticeAttempts(): Promise<StoredPracticeAttempt[]> {
  return withStore('readonly', (store, result) => {
    const request = store.getAll()
    request.onsuccess = () => result((request.result as StoredPracticeAttempt[]).sort((a, b) => b.report.startedAt - a.report.startedAt))
  })
}

export function deletePracticeScenario(scenarioKey: string): Promise<void> {
  return withStore<void>('readwrite', (store, result) => {
    const request = store.index('scenarioKey').openKeyCursor(IDBKeyRange.only(scenarioKey))
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) { result(undefined); return }
      store.delete(cursor.primaryKey)
      cursor.continue()
    }
  })
}
