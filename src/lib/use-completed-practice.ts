/**
 * [INPUT]: 已结束会话快照、练习历史与持久化回调、完成页恢复写回动作
 * [OUTPUT]: 提供 durable feedback/redo 协调、报告、复练模型及完成页动作
 * [POS]: src/lib 的完成复盘编排；复用 feedback recovery 作为唯一任务轮询所有者
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { FeedbackTaskRequestSchema } from '../../shared/feedback-task'
import { buildFeedbackRequestPayload } from './api'
import { comparePracticeAttempts } from './practice-progress'
import { buildSessionReport } from './metrics'
import { COMPLETED_REVIEW_STORAGE_KEY, useCompletedReviewRecovery, type CompletedReviewSnapshot } from './feedback-task-recovery'
import type { PracticeAttempt, StoredPracticeAttempt } from './practice-history'
import type { AppPhase, CompletionReason, ConversationFeedbackResponse, ConversationMessage, FeedbackLoadingState, RedoFeedbackRequest, RedoRecord, RoundRecord, SessionReport, SessionScenario } from '../types'

export interface CompletedPracticeOptions {
  config: { mode: 'real' | 'partial' | 'mock' } | null; phase: AppPhase; scenario: SessionScenario | null; sessionId: string; startedAt: number | null; endedAt: number | null
  messages: ConversationMessage[]; messagesRef: RefObject<ConversationMessage[]>; rounds: RoundRecord[]; roundsRef: RefObject<RoundRecord[]>; practiceHistory: StoredPracticeAttempt[]
  completionReason: CompletionReason | null
  persistPractice(attempt: PracticeAttempt): Promise<void>; restoreCompletedSession(record: CompletedReviewSnapshot): void
}

export function useCompletedPractice(options: CompletedPracticeOptions) {
  const {
    config, phase, scenario, sessionId, startedAt, endedAt, messagesRef, rounds, roundsRef, practiceHistory, completionReason, persistPractice, restoreCompletedSession,
  } = options
  const [feedbackData, setFeedbackData] = useState<ConversationFeedbackResponse | null>(null)
  const [feedbackStatus, setFeedbackStatus] = useState<FeedbackLoadingState>('idle'); const [feedbackErrorMsg, setFeedbackErrorMsg] = useState(''); const [redoRecords, setRedoRecords] = useState<RedoRecord[]>([])
  const requestVersion = useRef(0); const fetched = useRef(false)
  const persistPracticeRef = useRef(persistPractice); persistPracticeRef.current = persistPractice
  const restoreCompletedSessionRef = useRef(restoreCompletedSession); restoreCompletedSessionRef.current = restoreCompletedSession
  const recovery = useCompletedReviewRecovery({ activeSession: scenario !== null && phase !== 'session_complete' })
  const { state: recoveryState, save: saveRecovery, discard: discardRecovery, startTask: startRecoveryTask, resumeTask: resumeRecoveryTask } = recovery
  const recoveryRecord = recoveryState.record
  const report = useMemo<SessionReport | null>(() => !config || !scenario || !sessionId || startedAt === null || endedAt === null || completionReason === null ? null : buildSessionReport(sessionId, config.mode, scenario, startedAt, endedAt, rounds, redoRecords, completionReason), [completionReason, config, endedAt, rounds, scenario, sessionId, startedAt, redoRecords])
  const currentPractice = useMemo<PracticeAttempt | null>(() => !report || !scenario?.practiceToken || report.rounds.length === 0 ? null : { scenario: scenario.dynamicData, practiceToken: scenario.practiceToken, report, feedback: feedbackData }, [feedbackData, scenario, report])
  const practiceComparison = useMemo(() => currentPractice ? comparePracticeAttempts(currentPractice, practiceHistory) : null, [currentPractice, practiceHistory])
  const fetchFeedback = useCallback(() => {
    if (!scenario || roundsRef.current.length === 0 || !report) return
    const version = ++requestVersion.current; setFeedbackStatus('loading'); setFeedbackErrorMsg('')
    try {
      const task = FeedbackTaskRequestSchema.parse({ kind: 'conversation', requestId: crypto.randomUUID(), createdAt: Date.now(), payload: buildFeedbackRequestPayload(scenario, roundsRef.current) })
      const snapshot: CompletedReviewSnapshot = { version: 1, sessionId, scenario: structuredClone(scenario), messages: structuredClone(messagesRef.current), rounds: structuredClone(roundsRef.current), startedAt: startedAt ?? report.startedAt, endedAt: endedAt ?? report.endedAt, report, feedback: feedbackData, redoRecords: structuredClone(redoRecords), pending: {} }
      saveRecovery(snapshot); startRecoveryTask(task)
    } catch (error) { if (version === requestVersion.current) { setFeedbackStatus('error'); setFeedbackErrorMsg(error instanceof Error ? error.message : '反馈生成失败，可点击重试。') } }
  }, [endedAt, feedbackData, messagesRef, redoRecords, report, roundsRef, saveRecovery, scenario, sessionId, startRecoveryTask, startedAt])
  const retryConversationFeedback = useCallback(() => { const task = recoveryRecord?.pending.conversation; if (task?.status === 'transport_error') resumeRecoveryTask('conversation'); else if (task?.status === 'failed') fetchFeedback() }, [fetchFeedback, recoveryRecord, resumeRecoveryTask])
  const startRedoTask = useCallback((request: RedoFeedbackRequest) => {
    if (!scenario || !report || sessionId !== report.sessionId) return
    const task = FeedbackTaskRequestSchema.parse({ kind: 'redo', requestId: crypto.randomUUID(), createdAt: Date.now(), payload: { ...request, secondExpressionScaffoldLevel: request.secondExpressionScaffoldLevel } })
    saveRecovery({ version: 1, sessionId, scenario: structuredClone(scenario), messages: structuredClone(messagesRef.current), rounds: structuredClone(roundsRef.current), startedAt: startedAt ?? report.startedAt, endedAt: endedAt ?? report.endedAt, report: structuredClone(report), feedback: feedbackData, redoRecords: structuredClone(redoRecords), pending: { ...(recoveryRecord?.pending ?? {}) } }); startRecoveryTask(task)
  }, [endedAt, feedbackData, messagesRef, recoveryRecord, redoRecords, report, roundsRef, saveRecovery, scenario, sessionId, startRecoveryTask, startedAt])
  const copyReport = useCallback(async () => { if (!report) return; await navigator.clipboard.writeText(JSON.stringify(report, null, 2)) }, [report])
  useEffect(() => { if (recoveryRecord && !scenario) restoreCompletedSessionRef.current(recoveryRecord) }, [recoveryRecord, scenario])
  useEffect(() => { if (!recoveryRecord || recoveryRecord.sessionId !== sessionId) return; if (recoveryRecord.feedback) { setFeedbackData(recoveryRecord.feedback); setFeedbackStatus('success') }; const task = recoveryRecord.pending.conversation; if (task?.status === 'failed' || task?.status === 'transport_error') { setFeedbackStatus('error'); setFeedbackErrorMsg(task.error?.message ?? '反馈生成失败，可点击重试。') }; setRedoRecords(structuredClone(recoveryRecord.redoRecords)) }, [recoveryRecord, sessionId])
  useEffect(() => { let stored = false; try { stored = Boolean(window.localStorage.getItem(COMPLETED_REVIEW_STORAGE_KEY)) } catch { /* recovery owns storage denial */ }; if (stored && !recoveryRecord) return; const task = recoveryRecord?.sessionId === sessionId ? (recoveryRecord.pending.conversation ?? recoveryRecord.pending.redo) : undefined; if (phase === 'session_complete' && !fetched.current && !task && !recoveryRecord?.feedback && scenario && roundsRef.current.length > 0) { fetched.current = true; fetchFeedback() } }, [fetchFeedback, phase, recoveryRecord, roundsRef, scenario, sessionId])
  useEffect(() => { if (currentPractice) void persistPracticeRef.current(currentPractice) }, [currentPractice])
  const reset = useCallback(() => { requestVersion.current += 1; fetched.current = false; discardRecovery(); setFeedbackData(null); setFeedbackStatus('idle'); setFeedbackErrorMsg(''); setRedoRecords([]) }, [discardRecovery])
  return { model: { feedbackData, feedbackStatus, feedbackErrorMsg, redoRecords, report, currentPractice, practiceComparison, restoredRedoTask: recoveryRecord?.pending.redo }, actions: { fetchFeedback, retryConversationFeedback, startRedoTask, copyReport, reset } }
}
