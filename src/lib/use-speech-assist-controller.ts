/**
 * [INPUT]: 录音转写、会话上下文、含 nullable 相手发话的当前回合与语音 controller 元数据
 * [OUTPUT]: 管理有或无相手上下文时的续说辅助请求、超时/失败事件、可见结果与中止动作；首轮只清理已说内容
 * [POS]: src/lib 的 speech assist 生命周期控制器；不拥有语音媒体或会话状态迁移
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { SpeechAssistAbortReason } from '../../shared/speech-assist'
import { ApiError, requestSpeechAssist } from './api'
import { ASSIST_TIMING, shouldDisplaySpeechAssistResult, shouldTriggerSpeechAssist, type ActiveSpeechAssistState } from './speech-assist'
import type { AppPhase, RoundRecord, SessionScenario, SpeechAssistEvent } from '../types'

export interface UseSpeechAssistControllerOptions {
  phase: AppPhase; scenario: SessionScenario | null; turn: number; confirmedTranscript: string; interimTranscript: string; partialTranscript: string; recordingUiStartedAt: number | null
  transcriptVersion: number; lastSpeechSoundAt: number | null; lastPartialAt: number | null; currentRound: RoundRecord | null
  isRecording(): boolean; touchRound(update: (round: RoundRecord) => void): void
}

export function useSpeechAssistController(options: UseSpeechAssistControllerOptions) {
  const [active, setActive] = useState<ActiveSpeechAssistState | null>(null)
  const pendingAssistEventRef = useRef<SpeechAssistEvent | null>(null)
  const lastAssistRequestAtRef = useRef(0); const lastAssistedVersionRef = useRef(0); const assistInFlightRef = useRef(false)
  const assistAbortControllerRef = useRef<AbortController | null>(null); const transcriptVersionRef = useRef(options.transcriptVersion)
  const flushPendingAssistEvent = useCallback((displayed: boolean, failureReason: SpeechAssistEvent['failureReason']) => {
    const pendingEvent = pendingAssistEventRef.current; if (!pendingEvent) return
    pendingAssistEventRef.current = null
    options.touchRound((round) => { round.speechAssistEvents.push({ ...pendingEvent, displayed, failureReason: displayed ? null : failureReason }) })
  }, [options])
  const abort = useCallback((reason: SpeechAssistAbortReason) => {
    if (assistAbortControllerRef.current) { assistAbortControllerRef.current.abort(reason); assistAbortControllerRef.current = null; assistInFlightRef.current = false }
    flushPendingAssistEvent(false, 'aborted'); setActive(null)
  }, [flushPendingAssistEvent])
  const visible = active !== null && options.phase === 'recording' && active.version === options.transcriptVersion
  useEffect(() => { transcriptVersionRef.current = options.transcriptVersion }, [options.transcriptVersion])
  useEffect(() => { if (pendingAssistEventRef.current) flushPendingAssistEvent(visible, visible ? null : 'stale_version') }, [flushPendingAssistEvent, visible])
  useEffect(() => {
    if (options.phase !== 'recording' || options.recordingUiStartedAt === null) return
    const now = Date.now(); const fullTranscript = [options.confirmedTranscript.trim(), options.interimTranscript.trim()].filter(Boolean).join(' ') || options.partialTranscript.trim(); const currentVersion = options.transcriptVersion
    const shouldTrigger = shouldTriggerSpeechAssist({ isRecording: options.isRecording(), transcript: fullTranscript, timeSinceLastSpeechSoundMs: now - (options.lastSpeechSoundAt ?? now), timeSinceLastPartialMs: now - (options.lastPartialAt ?? now), timeSinceLastRequestMs: now - lastAssistRequestAtRef.current, inFlight: assistInFlightRef.current, currentVersion, lastAssistedVersion: lastAssistedVersionRef.current })
    const currentPartnerPrompt = options.currentRound?.partnerPromptJa ?? null
    if (!shouldTrigger || !options.scenario) return
    lastAssistedVersionRef.current = currentVersion; lastAssistRequestAtRef.current = now; assistInFlightRef.current = true
    const assistController = new AbortController(); assistAbortControllerRef.current = assistController
    const timeoutId = window.setTimeout(() => { assistController.abort('timeout') }, ASSIST_TIMING.timeoutMs)
    const triggerTurn = options.turn; const requestVersion = currentVersion; const observedText = fullTranscript; const startTime = Date.now(); const scenario = options.scenario
    void (async () => {
      let assistEvent: SpeechAssistEvent | null = null
      try {
        const trailingSilenceMs = Math.min(10_000, Math.max(900, now - (options.lastSpeechSoundAt ?? now)))
        const lastAssistantTextJa = currentPartnerPrompt
        const res = await requestSpeechAssist({ requestId: `sa_${crypto.randomUUID()}`, transcriptVersion: requestVersion, observedTextJa: observedText, lastAssistantTextJa, trailingSilenceMs, sessionToken: scenario.sessionToken, turn: triggerTurn }, assistController.signal)
        const latencyMs = Date.now() - startTime
        const shouldDisplay = shouldDisplaySpeechAssistResult({ isRecording: options.isRecording(), requestVersion, currentVersion: transcriptVersionRef.current, isAborted: assistController.signal.aborted, timeSinceLastSpeechSoundMs: Date.now() - (options.lastSpeechSoundAt ?? 0) })
        assistEvent = { turn: triggerTurn, requestVersion, observedTextJa: observedText, cleanedObservedTextJa: res.cleanedObservedTextJa, continuationSuggestionJa: res.continuationSuggestionJa, displayed: false, latencyMs, failureReason: shouldDisplay ? null : assistController.signal.aborted ? 'aborted' : 'stale_version' }
        if (shouldDisplay) { pendingAssistEventRef.current = assistEvent; assistEvent = null; setActive({ version: requestVersion, observedTextJa: observedText, cleanedObservedTextJa: res.cleanedObservedTextJa, continuationSuggestionJa: res.continuationSuggestionJa }) }
      } catch (err) {
        const latencyMs = Date.now() - startTime; const isTimeout = assistController.signal.aborted && assistController.signal.reason === 'timeout'; const isAborted = assistController.signal.aborted && !isTimeout
        let failureReason: SpeechAssistEvent['failureReason'] = 'network_error'; if (isTimeout) failureReason = 'timeout'; else if (isAborted) failureReason = 'aborted'; else if (err instanceof ApiError && err.status >= 500) failureReason = 'server_error'; else if (err instanceof ApiError && err.status >= 400) failureReason = 'validation_error'
        assistEvent = { turn: triggerTurn, requestVersion, observedTextJa: observedText, cleanedObservedTextJa: null, continuationSuggestionJa: null, displayed: false, latencyMs, failureReason }
      } finally {
        window.clearTimeout(timeoutId); if (assistAbortControllerRef.current === assistController) { assistAbortControllerRef.current = null; assistInFlightRef.current = false }
        if (assistEvent) options.touchRound((round) => { round.speechAssistEvents.push(assistEvent as SpeechAssistEvent) })
      }
    })()
  }, [options])
  return { state: { active, visible }, actions: { abort, flushPendingAssistEvent } }
}
