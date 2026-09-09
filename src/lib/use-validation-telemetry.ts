/**
 * [INPUT]: 既有会话/回合/复盘事实、内存中的服务端遥测凭据、明确同意与 shared 严格 wire schema
 * [OUTPUT]: 派生匿名技术验证记录；幂等出站、存储与网络失败均不影响训练
 * [POS]: src/lib 的遥测传输与事实投影边界；不读取或写入练习/会话恢复数据
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { VALIDATION_SCHEMA_VERSION, ValidationBatchSchema, type ValidationBatch, type ValidationCheckpointRecord, type ValidationFailureCode, type ValidationFailureDomain, type ValidationRecord, type ValidationReviewResultRecord, type ValidationSessionSummaryRecord, type ValidationStage } from '../../shared/validation-telemetry'
import type { ConversationFeedbackResponse, PrototypeConfig, RedoRecord, RoundRecord, SessionReport } from '../types'
import { sendValidationBatch } from './api'
import { getOrCreateValidationClientId, type ValidationConsent } from './validation-consent'
import { clearValidationOutbox, enqueueValidationRecord, flushValidationOutbox } from './validation-outbox'

export interface ValidationTelemetrySession { sessionId: string; telemetryToken: string }
interface TelemetryOptions { consent: ValidationConsent; telemetrySession: ValidationTelemetrySession | null }
interface CheckpointInput { stage: ValidationStage; turn: number | null; event: ValidationCheckpointRecord['event']; failureDomain?: ValidationFailureDomain | null; failureCode?: ValidationFailureCode | null; recoverable?: boolean; recovered?: boolean; latencyMs?: number | null }

export function createValidationSequenceClock(now: () => number = Date.now): () => number {
  let previous = 0
  return () => {
    const timestamp = Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(now())) * 1_000)
    previous = Math.max(previous + 1, timestamp)
    return previous
  }
}

function classifyEnvironment(): Pick<ValidationSessionSummaryRecord, 'deviceClass' | 'osFamily' | 'browserFamily' | 'browserMajor' | 'networkClass' | 'audioDeviceClass'> {
  const userAgent = navigator.userAgent
  const osFamily = /Android/i.test(userAgent) ? 'android' : /iPhone|iPad|iPod/i.test(userAgent) ? 'ios' : /Mac OS X/i.test(userAgent) ? 'macos' : /Windows/i.test(userAgent) ? 'windows' : /Linux/i.test(userAgent) ? 'linux' : 'other'
  const browserMatch = /Edg\/([0-9]+)/.exec(userAgent) ?? /Chrome\/([0-9]+)/.exec(userAgent) ?? /Firefox\/([0-9]+)/.exec(userAgent) ?? /Version\/([0-9]+).*Safari/.exec(userAgent)
  const browserFamily = /Edg\//.test(userAgent) ? 'edge' : /Chrome\//.test(userAgent) ? 'chrome' : /Firefox\//.test(userAgent) ? 'firefox' : /Safari\//.test(userAgent) ? 'safari' : 'other'
  const browserMajor = Number(browserMatch?.[1] ?? 0)
  return { deviceClass: navigator.maxTouchPoints > 0 && Math.min(window.innerWidth, window.innerHeight) < 768 ? 'phone' : navigator.maxTouchPoints > 0 ? 'tablet' : 'desktop', osFamily, browserFamily, browserMajor: Number.isSafeInteger(browserMajor) ? browserMajor : 0, networkClass: navigator.onLine ? 'online' : 'offline', audioDeviceClass: 'unknown' }
}

function latency(startedAt: number | null, endedAt: number | null): number | null { return startedAt === null || endedAt === null || endedAt < startedAt ? null : endedAt - startedAt }

export function createValidationRoundSnapshot(round: RoundRecord, occurredAt: number, eventId: string, sequence: number, roundCompleted: boolean): ValidationRecord {
  return { kind: 'round_snapshot', eventId, sequence, occurredAt, turn: round.turn, inputMode: round.inputMode, listeningScaffoldLevel: round.listeningScaffoldLevel, expressionScaffoldLevel: round.expressionScaffoldLevel, speechAssistDisplayed: round.speechAssistEvents.some((event) => event.displayed), transcriptModified: round.transcriptModified, transcriptModificationCount: round.transcriptModificationCount, rerecordCount: round.rerecordCount, ttsReplayCount: round.ttsReplayCount, failureCount: round.failureCount, retryCount: round.retryCount, speechStartLatencyMs: latency(round.timing.recordingStartedAt ?? round.timing.audioCompletedAt, round.timing.firstSpeechAt), sttFinalizeLatencyMs: latency(round.timing.recordingStoppedAt, round.timing.transcriptFinalizedAt), transcriptConfirmLatencyMs: latency(round.timing.transcriptFinalizedAt, round.timing.transcriptConfirmedAt), llmFirstTextLatencyMs: latency(round.timing.llmStartedAt, round.timing.llmFirstTextAt), llmCompleteLatencyMs: latency(round.timing.llmStartedAt, round.timing.llmCompletedAt), ttsFirstAudioLatencyMs: latency(round.timing.ttsStartedAt, round.timing.ttsFirstAudioAt), roundWaitLatencyMs: latency(round.timing.audioCompletedAt, round.timing.recordingStartedAt), roundCompleted }
}

export function createValidationDedupeRegistry() {
  const seen = new Set<string>()
  return {
    has(key: string): boolean { return seen.has(key) },
    add(key: string): void { seen.add(key) },
    reset(): void { seen.clear() },
  }
}

export function createValidationSessionRegistry() {
  const revoked = new Set<string>()
  return {
    revoke(sessionId: string): void { revoked.add(sessionId) },
    allows(sessionId: string): boolean { return !revoked.has(sessionId) },
  }
}

export function useValidationTelemetry({ consent, telemetrySession }: TelemetryOptions) {
  const consentRef = useRef(consent)
  const sessionRef = useRef<ValidationTelemetrySession | null>(telemetrySession)
  const seenRef = useRef(createValidationDedupeRegistry())
  const nextSequenceRef = useRef(createValidationSequenceClock())
  const sessionRegistryRef = useRef(createValidationSessionRegistry())
  consentRef.current = consent
  sessionRef.current = telemetrySession
  useEffect(() => { seenRef.current.reset() }, [telemetrySession?.sessionId])

  const flush = useCallback(() => {
    const session = sessionRef.current
    if (consentRef.current !== 'accepted' || !navigator.onLine || !session || !sessionRegistryRef.current.allows(session.sessionId)) return
    void flushValidationOutbox(async (entry) => {
      const anonymousClientId = getOrCreateValidationClientId()
      if (!anonymousClientId) throw new Error('Anonymous client identifier unavailable.')
      const batch: ValidationBatch = ValidationBatchSchema.parse({ schemaVersion: VALIDATION_SCHEMA_VERSION, batchId: entry.batchId, sessionId: entry.sessionId, telemetryToken: session.telemetryToken, anonymousClientId, anonymousMetricsConsent: true, sentAt: entry.sentAt, records: [entry.record] })
      await sendValidationBatch(batch)
    }, session.sessionId).catch(() => undefined)
  }, [])

  useEffect(() => {
    const retry = () => flush()
    window.addEventListener('online', retry)
    window.addEventListener('focus', retry)
    flush()
    return () => { window.removeEventListener('online', retry); window.removeEventListener('focus', retry) }
  }, [flush])

  const enqueue = useCallback((dedupeKey: string, record: ValidationRecord) => {
    const session = sessionRef.current
    if (consentRef.current !== 'accepted' || !session || !sessionRegistryRef.current.allows(session.sessionId) || seenRef.current.has(dedupeKey)) return
    const anonymousClientId = getOrCreateValidationClientId()
    if (!anonymousClientId) return
    const batchId = crypto.randomUUID()
    const sentAt = Date.now()
    try {
      ValidationBatchSchema.parse({ schemaVersion: VALIDATION_SCHEMA_VERSION, batchId, sessionId: session.sessionId, telemetryToken: session.telemetryToken, anonymousClientId, anonymousMetricsConsent: true, sentAt, records: [record] })
    } catch { return }
    seenRef.current.add(dedupeKey)
    void enqueueValidationRecord(batchId, session.sessionId, sentAt, record).then(() => {
      if (consentRef.current === 'accepted') flush()
      else void clearValidationOutbox().catch(() => undefined)
    }).catch(() => undefined)
  }, [flush])

  const checkpoint = useCallback((input: CheckpointInput, dedupeKey: string) => {
    const occurredAt = Date.now()
    enqueue(dedupeKey, { kind: 'checkpoint', eventId: crypto.randomUUID(), sequence: nextSequenceRef.current(), occurredAt, stage: input.stage, turn: input.turn, event: input.event, failureDomain: input.failureDomain ?? null, failureCode: input.failureCode ?? null, recoverable: input.recoverable ?? false, recovered: input.recovered ?? false, latencyMs: input.latencyMs ?? null })
  }, [enqueue])
  const roundSnapshot = useCallback((round: RoundRecord, completed: boolean, dedupeKey: string) => { const occurredAt = Date.now(); enqueue(dedupeKey, createValidationRoundSnapshot(round, occurredAt, crypto.randomUUID(), nextSequenceRef.current(), completed)) }, [enqueue])
  const sessionSummary = useCallback((report: SessionReport, feedbackCompleted: boolean, redoStarted: boolean, redoCompleted: boolean, dedupeKey: string) => {
    const occurredAt = Date.now()
    const record: ValidationRecord = { kind: 'session_summary', eventId: crypto.randomUUID(), sequence: nextSequenceRef.current(), occurredAt, scenarioId: report.scenarioId, scenarioVersion: report.scenarioVersion, variantId: report.variantId, mode: report.mode, scenarioSource: 'unknown', practiceTrigger: 'unknown', ...classifyEnvironment(), startedAt: report.startedAt, endedAt: report.endedAt, durationMilliseconds: report.durationMilliseconds, lastStage: 'complete', completionReason: report.completion.reason, closedNaturally: report.completion.closedNaturally, feedbackCompleted, redoStarted, redoCompleted, roundCount: report.rounds.length, failureCount: report.totals.failureCount, retryCount: report.totals.retryCount, textFallbackCount: report.rounds.filter((round) => round.inputMode === 'text').length, listeningScaffoldRoundsCount: report.rounds.filter((round) => round.listeningScaffoldLevel > 0).length, expressionScaffoldRoundsCount: report.totals.expressionScaffoldRoundsCount, speechAssistRequestCount: report.recovery.speechAssistRequestCount, speechAssistDisplayedCount: report.recovery.speechAssistDisplayedCount, inputTokens: report.totals.inputTokens, outputTokens: report.totals.outputTokens, sttAudioMilliseconds: report.totals.sttAudioMilliseconds, llmRequestCount: report.totals.llmRequestCount, ttsRequestCount: report.totals.ttsRequestCount, ttsCharacterCount: report.totals.ttsCharacterCount }
    enqueue(dedupeKey, record)
  }, [enqueue])
  const reviewResult = useCallback((feedback: ConversationFeedbackResponse, config: PrototypeConfig | null, evaluationVersion: string, dedupeKey: string) => { const occurredAt = Date.now(); const record: ValidationReviewResultRecord = { kind: 'review_result', eventId: crypto.randomUUID(), sequence: nextSequenceRef.current(), occurredAt, reviewKind: 'conversation', turn: null, evaluationVersion, modelVersion: config?.openai.model ?? 'unknown', promptVersion: 'unknown', outcome: feedback.outcome, improvement: null, citationValid: null, modelHumanAgreement: null }; enqueue(dedupeKey, record) }, [enqueue])
  const redoReview = useCallback((redo: RedoRecord, config: PrototypeConfig | null, evaluationVersion: string, dedupeKey: string) => { const occurredAt = Date.now(); const record: ValidationReviewResultRecord = { kind: 'review_result', eventId: crypto.randomUUID(), sequence: nextSequenceRef.current(), occurredAt, reviewKind: 'redo', turn: redo.turn, evaluationVersion, modelVersion: config?.openai.model ?? 'unknown', promptVersion: 'unknown', outcome: null, improvement: 'not_assessed', citationValid: null, modelHumanAgreement: null }; enqueue(dedupeKey, record) }, [enqueue])
  const revokeCurrentSession = useCallback(() => {
    const session = sessionRef.current
    if (session) sessionRegistryRef.current.revoke(session.sessionId)
    void clearValidationOutbox().catch(() => undefined)
  }, [])
  return useMemo(() => ({ checkpoint, roundSnapshot, sessionSummary, reviewResult, redoReview, flush, revokeCurrentSession }), [checkpoint, flush, redoReview, redoReview, reviewResult, revokeCurrentSession, roundSnapshot, sessionSummary])
}
