/**
 * [INPUT]: 依赖 ./recovery-guards 的共享恢复形状守卫、含判别式开场与 nullable 相手回合事实的当前会话领域类型及浏览器 sessionStorage
 * [OUTPUT]: 严格校验、读取和清理单轨双开场可恢复会话快照，旧字段快照自然失效
 * [POS]: src/lib 的会话快照持久化边界；不拥有会话状态迁移或媒体资源
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { readScenarioOpening, isObject, isStoredRoundRecord } from './recovery-guards'
import { openingPartnerLineJa } from '../../shared/scenario-draft'
import type { AppPhase, ConversationMessage, RoundRecord, SessionScenario, TranscriptText } from '../types'

export const SESSION_SNAPSHOT_KEY = 'kaiwa.current-session.v1'
const SNAPSHOT_PHASES: readonly AppPhase[] = [
  'loading_config',
  'idle',
  'fetching_token',
  'connecting_stt',
  'waiting_user',
  'recording',
  'finalizing_transcript',
  'confirming_transcript',
  'requesting_llm',
  'preparing_tts',
  'playing_ai',
  'round_complete',
  'session_complete',
  'error',
]

export function clearSessionSnapshot(): void {
  try {
    window.sessionStorage.removeItem(SESSION_SNAPSHOT_KEY)
  } catch {
    return
  }
}

/**
 * 可解析快照在与会话状态机结合时才暴露的不一致，例如进入 TTS 阶段却没有可恢复的真实相手発話。
 * 携带 code 以复用 ./ui 的既有错误归一化，而不是抛裸 Error 落到通用兜底。
 */
export class SessionSnapshotIntegrityError extends Error {
  readonly code = 'session_snapshot_integrity'

  constructor(message: string) {
    super(message)
    this.name = 'SessionSnapshotIntegrityError'
  }
}

export interface SessionSnapshot {
  version: 1
  phase: AppPhase
  sessionId: string
  scenario: SessionScenario
  messages: ConversationMessage[]
  rounds: RoundRecord[]
  currentRound: RoundRecord | null
  turn: number
  sessionStartedAt: number
  transcript: TranscriptText
}

function isPreviousAdvice(value: unknown): boolean {
  if (value === undefined) return true
  if (typeof value !== 'object' || value === null) return false
  const advice = value as { expressionImprovement?: Record<string, unknown>; sourceSessionId?: unknown; sourceStartedAt?: unknown; viewed?: unknown }
  const improvement = advice.expressionImprovement
  return typeof advice.sourceSessionId === 'string' && advice.sourceSessionId.length > 0
    && typeof advice.sourceStartedAt === 'number' && Number.isFinite(advice.sourceStartedAt)
    && typeof advice.viewed === 'boolean'
    && typeof improvement === 'object' && improvement !== null
    && typeof improvement.turn === 'number' && Number.isInteger(improvement.turn) && improvement.turn >= 1 && improvement.turn <= 5
    && typeof improvement.userConfirmedJa === 'string' && typeof improvement.suggestedJa === 'string' && improvement.suggestedJa.trim().length > 0 && typeof improvement.reasonZh === 'string'
}

function isSessionSnapshot(value: unknown): value is SessionSnapshot {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<SessionSnapshot>
  const scenario = candidate.scenario
  const transcript = candidate.transcript
  const hasKnownPhase = typeof candidate.phase === 'string' && SNAPSHOT_PHASES.some((phase) => phase === candidate.phase)
  const opening = isObject(scenario) && isObject(scenario.dynamicData) ? readScenarioOpening(scenario.dynamicData.opening) : null
  const firstMessage = Array.isArray(candidate.messages) ? candidate.messages[0] : undefined
  const allRounds = [
    ...(Array.isArray(candidate.rounds) ? candidate.rounds : []),
    ...(candidate.currentRound ? [candidate.currentRound] : []),
  ]
  const openingMatches = opening?.speaker === 'assistant'
    ? isObject(firstMessage) && firstMessage.role === 'assistant' && firstMessage.text === opening.partnerLineJa
    : opening?.speaker === 'user' && (firstMessage === undefined || (isObject(firstMessage) && firstMessage.role === 'user'))
  const expectedOpeningPrompt = opening === null ? null : openingPartnerLineJa(opening)
  const roundsMatch = allRounds.every(isStoredRoundRecord)
    && allRounds.every((round) => round.turn > 1 ? round.partnerPromptJa !== null : true)
    && allRounds.filter((round) => round.turn === 1).every((round) => round.partnerPromptJa === expectedOpeningPrompt)
  return candidate.version === 1
    && hasKnownPhase
    && typeof candidate.sessionId === 'string'
    && candidate.sessionId.length > 0
    && typeof candidate.sessionStartedAt === 'number'
    && Number.isFinite(candidate.sessionStartedAt)
    && typeof candidate.turn === 'number'
    && candidate.turn >= 1
    && candidate.turn <= 5
    && Array.isArray(candidate.messages)
    && Array.isArray(candidate.rounds) && roundsMatch && openingMatches
    && typeof scenario === 'object'
    && scenario !== null
    && typeof scenario.id === 'string'
    && scenario.maxTurns === 5
    && typeof scenario.dynamicData === 'object'
    && scenario.dynamicData !== null
    && opening !== null
    && isPreviousAdvice((scenario as SessionScenario).previousAdvice)
    && typeof transcript === 'object'
    && transcript !== null
    && typeof transcript.rawText === 'string'
    && typeof transcript.cleanedText === 'string'
    && typeof transcript.finalText === 'string'
}

export function readSessionSnapshot(): SessionSnapshot | null {
  try {
    const raw = window.sessionStorage.getItem(SESSION_SNAPSHOT_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (isSessionSnapshot(parsed)) return parsed
    clearSessionSnapshot()
    return null
  } catch {
    return null
  }
}

export function removeLastSubmittedUserMessage(messages: ConversationMessage[], turn: number): ConversationMessage[] {
  const submittedIndex = messages.findLastIndex((message) => message.role === 'user' && message.turn === turn)
  if (submittedIndex < 0) return messages
  return messages.filter((_, index) => index !== submittedIndex)
}
