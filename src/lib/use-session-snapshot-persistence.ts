/**
 * [INPUT]: 当前会话可序列化状态、sessionStorage 快照键与读取期间标志
 * [OUTPUT]: 在可恢复阶段写入快照，并在无活动会话时清理快照
 * [POS]: src/lib 的 session snapshot 持久化 lifecycle；不拥有会话迁移或媒体资源
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { useEffect } from 'react'
import { clearSessionSnapshot, SESSION_SNAPSHOT_KEY, type SessionSnapshot } from './session-snapshot'
import type { AppPhase, ConversationMessage, RoundRecord, SessionScenario, TranscriptText } from '../types'

export function useSessionSnapshotPersistence({ reading, phase, sessionId, scenario, messages, rounds, currentRound, turn, startedAt, endedAt, transcript }: { reading: boolean; phase: AppPhase; sessionId: string; scenario: SessionScenario | null; messages: ConversationMessage[]; rounds: RoundRecord[]; currentRound: RoundRecord | null; turn: number; startedAt: number | null; endedAt: number | null; transcript: TranscriptText }) {
  useEffect(() => {
    if (reading) return
    if (!sessionId || !scenario || startedAt === null || endedAt !== null) { clearSessionSnapshot(); return }
    const snapshot: SessionSnapshot = { version: 1, phase, sessionId, scenario, messages, rounds, currentRound, turn, sessionStartedAt: startedAt, transcript }
    try { window.sessionStorage.setItem(SESSION_SNAPSHOT_KEY, JSON.stringify(snapshot)) } catch { /* sessionStorage 不可用时会话继续 */ }
  }, [currentRound, endedAt, messages, phase, reading, rounds, scenario, sessionId, startedAt, transcript, turn])
}
