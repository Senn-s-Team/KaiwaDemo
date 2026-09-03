import { describe, expect, it } from 'vitest'
import { consumePreparedScenario, prepareNextScenario, scenarioForPractice, type SessionStorageLike } from '../../src/scenarios/queue'
import { deriveScenarioReveal } from '../../src/scenarios/reveal'
import type { ScenarioCatalogEntry, SessionScenario } from '../../src/types'

const catalog: ScenarioCatalogEntry[] = [
  { id: 'p0-cafe', version: 1 },
  { id: 'p0-station', version: 1 },
  { id: 'p0-office', version: 1 },
]

function storageWith(value: string | null = null): SessionStorageLike {
  let stored = value
  return {
    getItem: () => stored,
    setItem: (_key, next) => {
      stored = next
    },
  }
}

describe('随机盲练场景队列', () => {
  it('在一轮队列内不重复消费场景', () => {
    const storage = storageWith()
    const random = () => 0
    const choices = Array.from({ length: catalog.length }, () => {
      const id = prepareNextScenario(catalog, storage, random)
      expect(id).not.toBeNull()
      consumePreparedScenario(catalog, storage, id!)
      return id
    })

    expect(new Set(choices).size).toBe(catalog.length)
  })

  it('消费完毕后重新洗牌，并避开上一场景', () => {
    const storage = storageWith(JSON.stringify({ queue: [], lastScenarioId: 'p0-cafe' }))

    expect(prepareNextScenario(catalog, storage, () => 0)).not.toBe('p0-cafe')
  })

  it('重练当前场景且不消费随机队列', () => {
    const storage = storageWith()
    const next = prepareNextScenario(catalog, storage, () => 0)

    expect(scenarioForPractice('p0-station', next)).toBe('p0-station')
    expect(prepareNextScenario(catalog, storage, () => 0)).toBe(next)
  })
})

describe('场景揭示', () => {
  const scenario: SessionScenario = {
    id: 'p0-cafe',
    version: 1,
    variantId: 'weekday',
    firstLine: 'いらっしゃいませ。',
    maxTurns: 5,
    reveal: { titleZh: '咖啡店点单', summaryZh: '完成一次简短点单。' },
  }

  it('只在完成态派生中文场景揭示', () => {
    expect(deriveScenarioReveal('waiting_user', scenario)).toBeNull()
    expect(deriveScenarioReveal('session_complete', scenario)).toEqual(scenario.reveal)
  })
})
