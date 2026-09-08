/**
 * [INPUT]: 当前会话领域类型与浏览器 sessionStorage
 * [OUTPUT]: 校验、读取和清理可恢复会话快照
 * [POS]: src/lib 的会话快照持久化边界；不拥有会话状态迁移或媒体资源
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
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

function isSessionSnapshot(value: unknown): value is SessionSnapshot {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<SessionSnapshot>
  const scenario = candidate.scenario
  const transcript = candidate.transcript
  const hasKnownPhase = typeof candidate.phase === 'string' && SNAPSHOT_PHASES.some((phase) => phase === candidate.phase)
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
    && Array.isArray(candidate.rounds)
    && typeof scenario === 'object'
    && scenario !== null
    && typeof scenario.id === 'string'
    && scenario.maxTurns === 5
    && typeof scenario.dynamicData === 'object'
    && scenario.dynamicData !== null
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
