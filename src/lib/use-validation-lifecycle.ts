/**
 * [INPUT]: App 已有的稳定会话、回合、复盘与失败事实，以及仅在内存中的遥测会话凭据
 * [OUTPUT]: 协调同意、撤销、生命周期记录和可更新 session summary，不改变训练控制流
 * [POS]: src/lib 的 App 遥测生命周期编排边界；不持久化遥测凭据
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { useCallback, useEffect, useState } from 'react'
import type { ConversationFeedbackResponse, PrototypeConfig, RedoRecord, RoundRecord, SessionReport } from '../types'
import { clearValidationClientId, readValidationConsent, writeValidationConsent, type ValidationConsent } from './validation-consent'
import { useValidationTelemetry, type ValidationTelemetrySession } from './use-validation-telemetry'

interface ValidationLifecycleOptions {
  telemetrySession: ValidationTelemetrySession | null
  sessionStartedAt: number | null
  rounds: RoundRecord[]
  currentRound: RoundRecord | null
  report: SessionReport | null
  feedback: ConversationFeedbackResponse | null
  redoRecords: RedoRecord[]
  config: PrototypeConfig | null
  activeFailure: { code: string; step: 'config' | 'scenario' | 'token' | 'stt' | 'llm' | 'tts' | null } | null
  recoveredTarget: string | null
  evaluationVersion?: string
}

export function useValidationLifecycle(options: ValidationLifecycleOptions) {
  const [consent, setConsent] = useState<ValidationConsent>(() => readValidationConsent())
  const [redoStartedSessionId, setRedoStartedSessionId] = useState<string | null>(null)
  const redoStarted = options.telemetrySession !== null && redoStartedSessionId === options.telemetrySession.sessionId
  const telemetry = useValidationTelemetry({ consent, telemetrySession: options.telemetrySession })
  const feedbackCompleted = options.feedback !== null
  const redoCompleted = options.redoRecords.length > 0
  const evaluationVersion = options.evaluationVersion ?? 'unknown'

  useEffect(() => {
    if (!options.telemetrySession || options.sessionStartedAt === null) return
    telemetry.checkpoint({ stage: 'session_starting', turn: null, event: 'session_started' }, `session-started:${options.telemetrySession.sessionId}`)
  }, [options.sessionStartedAt, options.telemetrySession, telemetry])

  useEffect(() => {
    for (const round of options.rounds) {
      telemetry.roundSnapshot(round, true, `round-completed:${round.turn}`)
      telemetry.checkpoint({ stage: 'partner_speaking', turn: round.turn, event: 'round_completed' }, `round-completed-checkpoint:${round.turn}`)
    }
  }, [options.rounds, telemetry])

  useEffect(() => {
    if (!options.currentRound?.userFinal.trim()) return
    telemetry.roundSnapshot(options.currentRound, false, `round-confirmed:${options.currentRound.turn}`)
    telemetry.checkpoint({ stage: 'transcript_confirming', turn: options.currentRound.turn, event: 'round_confirmed' }, `round-confirmed-checkpoint:${options.currentRound.turn}`)
  }, [options.currentRound, telemetry])

  useEffect(() => {
    if (!options.activeFailure || !options.telemetrySession) return
    const domain = options.activeFailure.step === 'stt' ? 'stt' : options.activeFailure.step === 'tts' ? 'tts' : options.activeFailure.step === 'llm' ? 'llm' : 'product_state'
    telemetry.checkpoint({ stage: 'waiting_user', turn: options.currentRound?.turn ?? null, event: 'failure_occurred', failureDomain: domain, failureCode: options.activeFailure.step ?? 'product_state', recoverable: true }, `failure:${options.activeFailure.step ?? 'product_state'}:${options.currentRound?.turn ?? 0}:${options.activeFailure.code}`)
  }, [options.activeFailure, options.currentRound?.turn, options.telemetrySession, telemetry])

  useEffect(() => {
    if (!options.recoveredTarget) return
    telemetry.checkpoint({ stage: 'waiting_user', turn: options.currentRound?.turn ?? null, event: 'failure_recovered', recoverable: true, recovered: true }, `recovery:${options.recoveredTarget}:${options.currentRound?.turn ?? 0}`)
  }, [options.currentRound?.turn, options.recoveredTarget, telemetry])

  useEffect(() => {
    if (!options.report || !options.telemetrySession) return
    const flags = `${feedbackCompleted}:${redoStarted}:${redoCompleted}`
    telemetry.sessionSummary(options.report, feedbackCompleted, redoStarted, redoCompleted, `session-summary:${options.report.sessionId}:${flags}`)
    telemetry.checkpoint({ stage: 'complete', turn: null, event: 'session_completed' }, `session-completed:${options.report.sessionId}`)
  }, [feedbackCompleted, options.report, options.telemetrySession, redoCompleted, redoStarted, telemetry])

  useEffect(() => {
    if (!options.feedback || !options.telemetrySession) return
    telemetry.reviewResult(options.feedback, options.config, evaluationVersion, `feedback-review:${options.telemetrySession.sessionId}`)
    telemetry.checkpoint({ stage: 'feedback_ready', turn: null, event: 'feedback_completed' }, `feedback-completed:${options.telemetrySession.sessionId}`)
  }, [evaluationVersion, options.config, options.feedback, options.telemetrySession, telemetry])

  useEffect(() => {
    for (const redo of options.redoRecords) {
      telemetry.redoReview(redo, options.config, evaluationVersion, `redo-review:${redo.turn}`)
      telemetry.checkpoint({ stage: 'redo_feedback', turn: redo.turn, event: 'redo_completed' }, `redo-completed:${redo.turn}`)
    }
  }, [evaluationVersion, options.config, options.redoRecords, telemetry])

  const decide = useCallback((decision: 'accepted' | 'declined') => {
    writeValidationConsent(decision)
    setConsent(decision)
  }, [])

  const revoke = useCallback(() => {
    telemetry.revokeCurrentSession()
    writeValidationConsent('undecided')
    clearValidationClientId()
    setConsent('undecided')
  }, [telemetry])

  const trackRedoStarted = useCallback((turn: number) => {
    const sessionId = options.telemetrySession?.sessionId
    if (sessionId) setRedoStartedSessionId(sessionId)
    telemetry.checkpoint({ stage: 'redo_feedback', turn, event: 'redo_started' }, `redo-started:${turn}`)
  }, [options.telemetrySession?.sessionId, telemetry])

  return { consent, decide, revoke, trackRedoStarted }
}
