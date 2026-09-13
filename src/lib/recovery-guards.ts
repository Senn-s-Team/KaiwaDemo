/**
 * [INPUT]: 依赖 ../types 的 RoundRecord 领域形状与 shared/scenario-draft 的判别式开场契约
 * [OUTPUT]: 对外提供 isObject、readScenarioOpening、isStoredRoundRecord 三个本机恢复载荷形状守卫
 * [POS]: src/lib 的本机恢复载荷形状守卫唯一来源，供会话快照、首页复练恢复与完成复盘恢复共用，避免同一形状被各自重新推导而漂移
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import type { ScenarioOpening } from '../../shared/scenario-draft'
import type { RoundRecord } from '../types'

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * 从存储值中读取可用的判别式开场。user 分支携带 partnerLineJa 时视为旧形状或伪造数据，
 * 与缺失 planZh 一样整体判为不可恢复。
 */
export function readScenarioOpening(value: unknown): ScenarioOpening | null {
  if (!isObject(value) || typeof value.planZh !== 'string' || value.planZh.trim().length === 0) return null
  if (value.speaker === 'user') return 'partnerLineJa' in value ? null : { speaker: 'user', planZh: value.planZh }
  if (value.speaker === 'assistant' && typeof value.partnerLineJa === 'string' && value.partnerLineJa.trim().length > 0) {
    return { speaker: 'assistant', partnerLineJa: value.partnerLineJa, planZh: value.planZh }
  }
  return null
}

/**
 * 回合记录的本机恢复形状。null 相手発話只允许出现在第 1 轮，且该轮不得携带任何听力、
 * 重听或台词展开事实，否则说明事实被伪造或来自旧契约。
 */
export function isStoredRoundRecord(value: unknown): value is RoundRecord {
  if (!isObject(value)) return false
  const promptIsValid = typeof value.partnerPromptJa === 'string'
    ? value.partnerPromptJa.trim().length > 0
    : value.partnerPromptJa === null && value.turn === 1
  return Number.isInteger(value.turn) && promptIsValid
    && (value.inputMode === 'stt' || value.inputMode === 'text')
    && typeof value.userOriginal === 'string' && typeof value.userCleaned === 'string' && typeof value.userFinal === 'string'
    && typeof value.listeningScaffoldLevel === 'number' && typeof value.expressionScaffoldLevel === 'number'
    && (value.partnerPromptJa !== null || (value.listeningScaffoldLevel === 0 && value.ttsReplayCount === 0 && value.transcriptRevealed === false))
    && isObject(value.timing) && Array.isArray(value.speechAssistEvents)
}
