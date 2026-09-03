import type { ScenarioCatalogEntry } from '../types'

const STORAGE_KEY = 'kaiwa.scenario-queue.v1'

type Random = () => number

interface ScenarioQueueState {
  queue: string[]
  lastScenarioId: string | null
}

export interface SessionStorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}


function isQueueState(value: unknown, allowedIds: Set<string>): value is ScenarioQueueState {
  if (!value || typeof value !== 'object') return false
  const { queue, lastScenarioId } = value as Partial<ScenarioQueueState>
  return (
    Array.isArray(queue) &&
    queue.every((id) => typeof id === 'string' && allowedIds.has(id)) &&
    new Set(queue).size === queue.length &&
    (lastScenarioId === null || (typeof lastScenarioId === 'string' && allowedIds.has(lastScenarioId)))
  )
}

function shuffle(ids: string[], random: Random): string[] {
  const next = [...ids]
  for (let index = next.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1))
    ;[next[index], next[target]] = [next[target], next[index]]
  }
  return next
}

function refillQueue(ids: string[], lastScenarioId: string | null, random: Random): ScenarioQueueState {
  const queue = shuffle(ids, random)
  if (queue.length > 1 && queue[0] === lastScenarioId) {
    const alternateIndex = queue.findIndex((id) => id !== lastScenarioId)
    ;[queue[0], queue[alternateIndex]] = [queue[alternateIndex], queue[0]]
  }
  return { queue, lastScenarioId }
}

function readQueue(storage: SessionStorageLike, catalog: ScenarioCatalogEntry[]): ScenarioQueueState {
  const allowedIds = new Set(catalog.map(({ id }) => id))
  try {
    const parsed: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? 'null')
    if (isQueueState(parsed, allowedIds)) return parsed
  } catch {
    // 无效的随机队列缓存按新队列处理。
  }
  return { queue: [], lastScenarioId: null }
}

function saveQueue(storage: SessionStorageLike, state: ScenarioQueueState): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(state))
}

/** 返回本轮随机候选场景，直到会话真正开始前不消费队列。 */
export function prepareNextScenario(
  catalog: ScenarioCatalogEntry[],
  storage: SessionStorageLike,
  random: Random = Math.random,
): string | null {
  const ids = [...new Set(catalog.map(({ id }) => id))]
  if (ids.length === 0) return null

  let state = readQueue(storage, catalog)
  if (state.queue.length === 0) {
    state = refillQueue(ids, state.lastScenarioId, random)
    saveQueue(storage, state)
  }
  return state.queue[0] ?? null
}

/** 在成功创建随机会话后消费当前候选，保证同一浏览器会话内不重复。 */
export function consumePreparedScenario(
  catalog: ScenarioCatalogEntry[],
  storage: SessionStorageLike,
  scenarioId: string,
): void {
  const state = readQueue(storage, catalog)
  if (state.queue[0] !== scenarioId) return
  saveQueue(storage, { queue: state.queue.slice(1), lastScenarioId: scenarioId })
}

/** 重练保留当前场景，不触碰随机队列。 */
export function scenarioForPractice(currentScenarioId: string | null, nextScenarioId: string | null): string | null {
  return currentScenarioId ?? nextScenarioId
}
