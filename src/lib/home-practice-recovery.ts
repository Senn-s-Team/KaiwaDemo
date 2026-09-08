/**
 * [INPUT]: 首页复练准备响应、复练建议与浏览器 sessionStorage
 * [OUTPUT]: 严格校验、读取、写入和清理同场景准备恢复记录
 * [POS]: src/lib 的首页准备恢复边界；仅限当前标签页，不保存账户或跨设备状态
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import type { DynamicScenarioData, ExpressionImprovement, PreviousAdvice, TrainingGoal } from '../types'

export const HOME_PRACTICE_RECOVERY_STORAGE_KEY = 'kaiwa.home-practice-restart.v1'

export interface PreparedRestartData {
  scenario: DynamicScenarioData
  scenarioToken: string
  practiceToken?: string
  previousAdvice?: PreviousAdvice
}

interface StoredPreparedRestart {
  version: 1
  ready: PreparedRestartData
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isTrainingGoal(value: unknown): value is TrainingGoal {
  if (typeof value !== 'object' || value === null) return false
  const goal = value as Partial<TrainingGoal>
  return nonEmptyString(goal.id) && nonEmptyString(goal.titleZh) && nonEmptyString(goal.descriptionZh)
}

function isExpressionImprovement(value: unknown): value is ExpressionImprovement {
  if (typeof value !== 'object' || value === null) return false
  const improvement = value as Partial<ExpressionImprovement>
  return typeof improvement.turn === 'number' && Number.isInteger(improvement.turn) && improvement.turn >= 1 && improvement.turn <= 5
    && typeof improvement.userConfirmedJa === 'string'
    && nonEmptyString(improvement.suggestedJa)
    && typeof improvement.reasonZh === 'string'
}

function isPreviousAdvice(value: unknown): value is PreviousAdvice {
  if (typeof value !== 'object' || value === null) return false
  const advice = value as Partial<PreviousAdvice>
  return isExpressionImprovement(advice.expressionImprovement)
    && nonEmptyString(advice.sourceSessionId)
    && typeof advice.sourceStartedAt === 'number' && Number.isFinite(advice.sourceStartedAt)
    && typeof advice.viewed === 'boolean'
}

function isDynamicScenarioData(value: unknown): value is DynamicScenarioData {
  if (typeof value !== 'object' || value === null) return false
  const scenario = value as Partial<DynamicScenarioData>
  const rules = scenario.completionRules
  return nonEmptyString(scenario.id)
    && typeof scenario.version === 'number' && Number.isInteger(scenario.version)
    && (scenario.evaluationVersion === undefined || (typeof scenario.evaluationVersion === 'number' && Number.isFinite(scenario.evaluationVersion)))
    && (scenario.evidencePoints === undefined || (Array.isArray(scenario.evidencePoints) && scenario.evidencePoints.every(isTrainingGoal)))
    && nonEmptyString(scenario.titleZh) && typeof scenario.summaryZh === 'string'
    && nonEmptyString(scenario.aiRole) && nonEmptyString(scenario.userRole)
    && nonEmptyString(scenario.relationship) && nonEmptyString(scenario.tone)
    && nonEmptyString(scenario.firstLine) && nonEmptyString(scenario.userGoal)
    && isTrainingGoal(scenario.coreGoal) && nonEmptyString(scenario.communicationFunction)
    && isStringArray(scenario.initialFacts) && isStringArray(scenario.partnerPrivateFacts)
    && isStringArray(scenario.keyIntents) && isStringArray(scenario.keyInformation)
    && typeof rules === 'object' && rules !== null
    && isStringArray(rules.completed) && isStringArray(rules.partial) && isStringArray(rules.notCompleted)
    && isStringArray(scenario.closingRules) && scenario.maxTurns === 5
    && nonEmptyString(scenario.partnerOpeningPlan) && isStringArray(scenario.worldAnchors)
    && isStringArray(scenario.followUpPrinciples) && nonEmptyString(scenario.hintStrategy)
    && isStringArray(scenario.feedbackFocus) && nonEmptyString(scenario.safetyBoundary)
}

function isPreparedRestartData(value: unknown): value is PreparedRestartData {
  if (typeof value !== 'object' || value === null) return false
  const ready = value as Partial<PreparedRestartData>
  return isDynamicScenarioData(ready.scenario)
    && nonEmptyString(ready.scenarioToken)
    && (ready.practiceToken === undefined || nonEmptyString(ready.practiceToken))
    && (ready.previousAdvice === undefined || isPreviousAdvice(ready.previousAdvice))
}

function parseStoredPreparedRestart(value: unknown): StoredPreparedRestart | null {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as Partial<StoredPreparedRestart>
  return candidate.version === 1 && isPreparedRestartData(candidate.ready)
    ? { version: 1, ready: candidate.ready }
    : null
}

function sessionStorageOrNull(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage
  } catch {
    return null
  }
}

export function readPreparedRestart(storage: Storage | null = sessionStorageOrNull()): PreparedRestartData | null {
  if (!storage) return null
  try {
    const raw = storage.getItem(HOME_PRACTICE_RECOVERY_STORAGE_KEY)
    if (!raw) return null
    const parsed = parseStoredPreparedRestart(JSON.parse(raw) as unknown)
    if (parsed) return parsed.ready
    storage.removeItem(HOME_PRACTICE_RECOVERY_STORAGE_KEY)
  } catch {
    try {
      storage.removeItem(HOME_PRACTICE_RECOVERY_STORAGE_KEY)
    } catch {
      return null
    }
    return null
  }
  return null
}

export function writePreparedRestart(ready: PreparedRestartData, storage: Storage | null = sessionStorageOrNull()): void {
  if (!storage || !isPreparedRestartData(ready)) return
  try {
    storage.setItem(HOME_PRACTICE_RECOVERY_STORAGE_KEY, JSON.stringify({ version: 1, ready } satisfies StoredPreparedRestart))
  } catch {
    return
  }
}

export function clearPreparedRestart(storage: Storage | null = sessionStorageOrNull()): void {
  try {
    storage?.removeItem(HOME_PRACTICE_RECOVERY_STORAGE_KEY)
  } catch {
    return
  }
}
