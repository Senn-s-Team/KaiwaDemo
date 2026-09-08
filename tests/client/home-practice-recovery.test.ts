/**
 * [INPUT]: 首页同场景复练准备数据与可控 sessionStorage
 * [OUTPUT]: 验证准备卡片恢复、建议 viewed 状态、非法记录拒绝与清理
 * [POS]: tests/client 首页准备恢复纯存储契约
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { describe, expect, it } from 'vitest'
import {
  HOME_PRACTICE_RECOVERY_STORAGE_KEY,
  clearPreparedRestart,
  readPreparedRestart,
  writePreparedRestart,
  type PreparedRestartData,
} from '../../src/lib/home-practice-recovery'

class MemoryStorage implements Storage {
  #entries = new Map<string, string>()
  get length(): number { return this.#entries.size }
  getItem(key: string): string | null { return this.#entries.get(key) ?? null }
  key(index: number): string | null { return [...this.#entries.keys()][index] ?? null }
  removeItem(key: string): void { this.#entries.delete(key) }
  setItem(key: string, value: string): void { this.#entries.set(key, value) }
  clear(): void { this.#entries.clear() }
}

const prepared: PreparedRestartData = {
  scenario: {
    id: 'scenario-1', version: 1, titleZh: '场景', summaryZh: '摘要', aiRole: '店员', userRole: '顾客', relationship: '顾客与店员', tone: '礼貌', firstLine: 'いらっしゃいませ', userGoal: '预订',
    coreGoal: { id: 'goal-1', titleZh: '目标', descriptionZh: '完成预订' }, communicationFunction: '请求', initialFacts: ['事实'], partnerPrivateFacts: ['隐情'], keyIntents: ['意图'], keyInformation: ['信息'],
    completionRules: { completed: ['完成'], partial: ['部分'], notCompleted: ['未完成'] }, closingRules: ['结束'], maxTurns: 5, partnerOpeningPlan: '开场', worldAnchors: ['地点'], followUpPrinciples: ['追问'], hintStrategy: '提示', feedbackFocus: ['表达'], safetyBoundary: '边界',
  },
  scenarioToken: 'scenario-token', practiceToken: 'practice-token',
  previousAdvice: { expressionImprovement: { turn: 1, userConfirmedJa: '予約したい', suggestedJa: '予約をお願いします', reasonZh: '更自然' }, sourceSessionId: 'session-1', sourceStartedAt: 100, viewed: false },
}

describe('home practice prepared restart storage', () => {
  it('round-trips prepared data and preserves viewed state', () => {
    const storage = new MemoryStorage()
    writePreparedRestart(prepared, storage)
    expect(readPreparedRestart(storage)).toEqual(prepared)
    const viewed = { ...prepared, previousAdvice: { ...prepared.previousAdvice!, viewed: true } }
    writePreparedRestart(viewed, storage)
    expect(readPreparedRestart(storage)?.previousAdvice?.viewed).toBe(true)
  })

  it('rejects malformed JSON and invalid nested schema, clearing the record', () => {
    const storage = new MemoryStorage()
    storage.setItem(HOME_PRACTICE_RECOVERY_STORAGE_KEY, '{bad json')
    expect(readPreparedRestart(storage)).toBeNull()
    storage.setItem(HOME_PRACTICE_RECOVERY_STORAGE_KEY, JSON.stringify({ version: 1, ready: { ...prepared, scenario: { ...prepared.scenario, completionRules: {} } } }))
    expect(readPreparedRestart(storage)).toBeNull()
    expect(storage.getItem(HOME_PRACTICE_RECOVERY_STORAGE_KEY)).toBeNull()
  })

  it('rejects unsupported versions and clears prepared state explicitly', () => {
    const storage = new MemoryStorage()
    storage.setItem(HOME_PRACTICE_RECOVERY_STORAGE_KEY, JSON.stringify({ version: 2, ready: prepared }))
    expect(readPreparedRestart(storage)).toBeNull()
    writePreparedRestart(prepared, storage)
    clearPreparedRestart(storage)
    expect(storage.getItem(HOME_PRACTICE_RECOVERY_STORAGE_KEY)).toBeNull()
  })
})
