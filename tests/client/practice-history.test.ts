/**
 * [INPUT]: 依赖本机练习历史 API 与可控 IndexedDB 事务替身
 * [OUTPUT]: 验证完整场景隔离、提交失败传播和持久化字段边界
 * [POS]: tests/client 的浏览器历史持久化契约测试
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getPracticeScenarioKey, listPracticeAttempts, savePracticeAttempt, type PracticeAttempt } from '../../src/lib/practice-history'

function installDatabase(abort = false) {
  let transaction: { oncomplete?: () => void; onabort?: () => void; error: Error | null; objectStore: () => unknown }
  const put = vi.fn()
  const database = {
    close: vi.fn(),
    transaction: () => {
      transaction = {
        error: abort ? new Error('quota exhausted') : null,
        objectStore: () => ({ put }),
      }
      queueMicrotask(() => { if (abort) transaction.onabort?.(); else transaction.oncomplete?.() })
      return transaction
    },
  }
  vi.stubGlobal('indexedDB', {
    open: () => {
      const request = { result: database, onsuccess: undefined as undefined | (() => void) }
      queueMicrotask(() => request.onsuccess?.())
      return request
    },
  })
  return { put, database }
}

afterEach(() => vi.unstubAllGlobals())

describe('local practice history', () => {
  it('uses the whole scenario with stable property ordering for identity', () => {
    const left = { id: 'same-id', version: 1, partnerPrivateFacts: ['上午已满'], coreGoal: { id: 'goal', titleZh: '改期' } } as PracticeAttempt['scenario']
    const reordered = { coreGoal: { titleZh: '改期', id: 'goal' }, partnerPrivateFacts: ['上午已满'], version: 1, id: 'same-id' } as PracticeAttempt['scenario']
    expect(getPracticeScenarioKey(left)).toBe(getPracticeScenarioKey(reordered))
    expect(getPracticeScenarioKey(left)).not.toBe(getPracticeScenarioKey({ ...left, partnerPrivateFacts: ['下午已满'] }))
  })

  it('rejects unavailable browser storage', async () => {
    vi.stubGlobal('indexedDB', undefined)
    await expect(listPracticeAttempts()).rejects.toThrow('当前浏览器无法保存')
  })

  it('persists only explicit fields and closes the database after commit', async () => {
    const { put, database } = installDatabase()
    const value = {
      scenario: { id: 'scenario' }, practiceToken: 'reusable-signature',
      report: { sessionId: 'session' }, feedback: null,
      sessionToken: 'must-not-persist', voiceToken: 'must-not-persist',
    } as unknown as PracticeAttempt
    await savePracticeAttempt(value)
    expect(put).toHaveBeenCalledWith({ scenario: value.scenario, practiceToken: value.practiceToken, report: value.report, feedback: null, scenarioKey: getPracticeScenarioKey(value.scenario) })
    expect(database.close).toHaveBeenCalledOnce()
  })

  it('does not report success when a successful put is followed by transaction abort', async () => {
    const { put, database } = installDatabase(true)
    await expect(savePracticeAttempt({ scenario: { id: 'scenario' }, practiceToken: 'token', report: { sessionId: 'session' }, feedback: null } as unknown as PracticeAttempt)).rejects.toThrow('quota exhausted')
    expect(put).toHaveBeenCalledOnce()
    expect(database.close).toHaveBeenCalledOnce()
  })
})
