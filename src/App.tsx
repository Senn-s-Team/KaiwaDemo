/**
 * [INPUT]: 依赖首页/会话/复盘控制器、既有本机练习历史、独立技术验证遥测同意与出站控制器
 * [OUTPUT]: 对外提供 App 根组件，驱动训练流程并仅在明确同意后于稳定生命周期 seam 派生匿名技术验证 checkpoint/汇总
 * [POS]: src/ 核心入口；训练状态始终独立于遥测存储与传输失败
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type SetStateAction } from 'react'
import './App.css'
import { ActiveSession } from './components/ActiveSession'
import { ValidationConsent } from './components/ValidationConsent'
import { Home } from './components/Home'
import { SessionComplete } from './components/SessionComplete'
import { PHASE_TRANSITIONS, recoveryStatusText } from './lib/app-phase'
import { shouldShowSilencePrompt } from './lib/audio-feedback'
import {
  fetchConfig,
  fetchHint,
  requestListeningScaffold,
  startScenarioSession,
} from './lib/api'
import { createRoundRecord } from './lib/metrics'
import { queryMicrophonePermission } from './lib/microphone'
import { createMessageId, createSessionId, decideInterruptionRecoveryAffordances, executeInterruptionRecovery, INITIAL_INTERRUPTION_RECOVERY_STATE, reduceInterruptionRecovery } from './lib/session'
import { toUiError } from './lib/ui'
import { useVoiceTurnController } from './lib/voice-turn-controller'
import { useAiTurnController } from './lib/ai-turn-controller'
import { useSpeechAssistController } from './lib/use-speech-assist-controller'
import { useListeningScaffoldController } from './lib/use-listening-scaffold-controller'
import { useCompletedPractice } from './lib/use-completed-practice'
import { useHomePractice } from './lib/use-home-practice'
import { useSessionSnapshotPersistence } from './lib/use-session-snapshot-persistence'
import { useSessionLifecycle } from './lib/use-session-lifecycle'
import { useValidationLifecycle } from './lib/use-validation-lifecycle'
import type { ValidationTelemetrySession } from './lib/use-validation-telemetry'
import { clearSessionSnapshot, readSessionSnapshot, removeLastSubmittedUserMessage, type SessionSnapshot } from './lib/session-snapshot'
import type {
  AppPhase,
  ConversationMessage,
  HintResponse,
  PrototypeConfig,
  CompletionReason, RoundRecord,
  SessionScenario,
  PreviousAdvice,
  UiError,
  TranscriptText,
} from './types'
function App() {
  const [config, setConfig] = useState<PrototypeConfig | null>(null)
  const [phase, setPhase] = useState<AppPhase>('loading_config')
  const [messages, setMessages] = useState<ConversationMessage[]>([])
  const [sessionId, setSessionId] = useState('')
  const [scenario, setScenario] = useState<SessionScenario | null>(null)
  const [sessionStartedAt, setSessionStartedAt] = useState<number | null>(null)
  const [sessionEndedAt, setSessionEndedAt] = useState<number | null>(null); const [completionReason, setCompletionReason] = useState<CompletionReason | null>(null)
  const [turn, setTurn] = useState(1)
  const [rounds, setRounds] = useState<RoundRecord[]>([])
  const [interruptionRecovery, dispatchInterruptionRecovery] = useReducer(reduceInterruptionRecovery, INITIAL_INTERRUPTION_RECOVERY_STATE)
  const [currentRoundView, setCurrentRoundView] = useState<RoundRecord | null>(null)
  const [online, setOnline] = useState(navigator.onLine)
  const [appForegroundNotice, setAppForegroundNotice] = useState('')
  const [uiError, setUiError] = useState<UiError | null>(null)
  const [inlineError, setInlineError] = useState('')
  const [lastFailedStep, setLastFailedStep] = useState<'config' | 'scenario' | 'token' | 'stt' | 'llm' | 'tts' | null>(null)
  const [telemetrySession, setTelemetrySession] = useState<ValidationTelemetrySession | null>(null)
  const [pendingHistory, setPendingHistory] = useState<ConversationMessage[]>([])
  const requestAbortRef = useRef<AbortController | null>(null)
  const resetSessionRef = useRef<() => void>(() => undefined)
  const [hintData, setHintData] = useState<HintResponse | null>(null)
  const [hintLevel, setHintLevel] = useState<0 | 1 | 2 | 3 | 4>(0)
  const [isLoadingHint, setIsLoadingHint] = useState(false)
  const [showHintSheet, setShowHintSheet] = useState(false)
  const [showGoalsSheet, setShowGoalsSheet] = useState(false)
  const [dockInputMode, setDockInputMode] = useState<'voice' | 'text'>('voice')
  const [dockTextValue, setDockTextValue] = useState('')
  const phaseRef = useRef(phase)
  const messagesRef = useRef<ConversationMessage[]>([])
  const roundsRef = useRef<RoundRecord[]>([])
  const currentRoundRef = useRef<RoundRecord | null>(null)
  const sessionStartLockRef = useRef(false)
  const operationIdRef = useRef(0)
  const preparedStartRef = useRef<{ scenarioToken: string; draftRequestId?: string; previousAdvice?: PreviousAdvice } | null>(null)
  const submitLockRef = useRef(false)
  const messageListRef = useRef<HTMLDivElement | null>(null)
  const sessionSnapshotRef = useRef<SessionSnapshot | null>(readSessionSnapshot())
  const homePractice = useHomePractice({ online, activeSession: scenario !== null || sessionSnapshotRef.current !== null, resetSession: () => resetSessionRef.current(), setUiError })
  const { customInputZh, clarifications, pendingClarification, readyScenarioData, isDraftingScenario, draftState, practiceHistory, recentPractices, historyNotice, historySaving, historySaveFailed } = homePractice.model
  const { setCustomInputZh, submitDraft: handleDraftScenario, answerClarification: handleAnswerClarification, resetCustom, retryDraftTransport, discardDraft, persistPractice, preparePracticeAgain, markReadyAdviceViewed, consumeReadyScenario, removePractice } = homePractice.actions
  const chatBottomRef = useRef<HTMLDivElement | null>(null)
  const restoredTranscriptRef = useRef<TranscriptText | null>(null)
  const abortSpeechAssistRef = useRef<(reason: import('../shared/speech-assist').SpeechAssistAbortReason) => void>(() => undefined)
  const hintRequestRef = useRef<AbortController | null>(null)
  const hintSheetVisibleRef = useRef(false)
  const hintedTurnRef = useRef(1)
  const setHintSheetVisible = useCallback((value: SetStateAction<boolean>) => {
    const previous = hintSheetVisibleRef.current
    const next = typeof value === 'function' ? value(previous) : value
    if (previous && !next) {
      hintRequestRef.current?.abort('sheet_closed')
      setIsLoadingHint(false)
    }
    hintSheetVisibleRef.current = next
    setShowHintSheet(next)
  }, [])
  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    if (chatBottomRef.current) {
      chatBottomRef.current.scrollIntoView({ behavior, block: 'end' })
    }
  }, [])
  const transitionTo = useCallback((nextPhase: AppPhase) => {
    const currentPhase = phaseRef.current
    if (currentPhase === nextPhase) return true
    if (!PHASE_TRANSITIONS[currentPhase].includes(nextPhase)) {
      console.error(`Invalid app phase transition: ${currentPhase} -> ${nextPhase}`)
      return false
    }
    phaseRef.current = nextPhase
    setPhase(nextPhase)
    return true
  }, [])
  const beginOperation = useCallback(() => {
    operationIdRef.current += 1
    requestAbortRef.current?.abort()
    requestAbortRef.current = null
    return operationIdRef.current
  }, [])
  const isCurrentOperation = useCallback((operationId: number) => operationId === operationIdRef.current, [])
  const operationCapability = useMemo(
    () => ({
      begin: beginOperation,
      isCurrent: isCurrentOperation,
    }),
    [beginOperation, isCurrentOperation],
  )
  const appendRound = useCallback((round: RoundRecord) => {
    const next = [...roundsRef.current, structuredClone(round)]
    roundsRef.current = next
    setRounds(next)
  }, [])
  const replaceCurrentRound = useCallback((round: RoundRecord | null) => {
    currentRoundRef.current = round
    setCurrentRoundView(round ? structuredClone(round) : null)
  }, [])
  const touchRound = useCallback((update: (round: RoundRecord) => void) => {
    const activeRound = currentRoundRef.current
    if (!activeRound) return
    update(activeRound)
    setCurrentRoundView(structuredClone(activeRound))
  }, [])
  const updateRoundByTurn = useCallback((targetTurn: number, update: (round: RoundRecord) => void) => {
    if (currentRoundRef.current?.turn === targetTurn) { touchRound(update); return }
    const next = roundsRef.current.map((round) => {
      if (round.turn !== targetTurn) return round
      const updated = structuredClone(round); update(updated); return updated
    })
    roundsRef.current = next; setRounds(next)
  }, [touchRound])
  const releaseAiPlaybackRef = useRef<() => void>(() => undefined)
  const voiceTurn = useVoiceTurnController({
    sttAvailable: Boolean(config?.elevenlabs.sttAvailable),
    sttModel: config?.elevenlabs.sttModel ?? '',
    online,
    phase,
    operation: operationCapability,
    transitionTo,
    touchRound,
    abortSpeechAssist: (reason) => abortSpeechAssistRef.current(reason),
    releaseAiPlayback: () => releaseAiPlaybackRef.current(),
  })
  const {
    confirmedTranscript,
    interimTranscript,
    partialTranscript,
    transcript,
    manualInput,
    showOriginalTranscript,
    showTranscriptSheet,
    recordingSeconds,
    silentSeconds,
    microphoneMeterAvailable,
    recordingUiStartedAt,
    foregroundNotice: voiceForegroundNotice,
    voiceError,
  } = voiceTurn.state
  const {
    startRecording,
    stopRecording,
    enterTextInput,
    rerecord,
    updateFinalText,
    toggleOriginalTranscript,
    openTranscriptSheet,
    closeTranscriptSheet,
    syncMicrophoneReadiness,
    clearVoiceNotice,
    resetVoiceTurn,
    dispose: disposeVoiceTurn,
    prefetchSttToken,
  } = voiceTurn.actions
  const speechAssist = useSpeechAssistController({
    phase, scenario, turn, confirmedTranscript, interimTranscript, partialTranscript, recordingUiStartedAt,
    transcriptVersion: voiceTurn.meta.transcriptVersion, lastSpeechSoundAt: voiceTurn.meta.lastSpeechSoundAt,
    lastPartialAt: voiceTurn.meta.lastPartialAt, currentRound: currentRoundRef.current,
    isRecording: () => phaseRef.current === 'recording', touchRound,
  })
  abortSpeechAssistRef.current = speechAssist.actions.abort
  const { active: activeAssistState, visible: activeAssistIsVisible } = speechAssist.state
  const abortSpeechAssist = speechAssist.actions.abort
  const commitAssistantMessage = useCallback(
    (message: ConversationMessage) => {
      const next = [...messagesRef.current, message]
      messagesRef.current = next
      setMessages(next)
    },
    [],
  )
  const aiTurnConfig = useMemo(() => {
    if (!config) return null
    return {
      ttsAvailable: config.elevenlabs.ttsAvailable,
      voiceId: config.elevenlabs.voiceId,
      ttsModel: config.elevenlabs.ttsModel,
    }
  }, [config])
  const commitCurrentRound = useCallback(() => {
    const active = currentRoundRef.current
    if (active) {
      const next = [...roundsRef.current, structuredClone(active)]
      roundsRef.current = next
      setRounds(next)
    }
  }, [])
  const aiTurn = useAiTurnController({
    config: aiTurnConfig,
    sessionId,
    scenario,
    turn,
    operation: operationCapability,
    transitionTo,
    touchRound,
    commitCurrentRound,
    replaceCurrentRound,
    commitAssistantMessage,
    advanceTurn: (nextTurn) => setTurn(nextTurn),
    prefetchSttToken,
    onSessionComplete: () => { setCompletionReason('turn_budget'); setSessionEndedAt(Date.now()); transitionTo('session_complete') },
  })
  const {
    currentAiText,
    activeAiMessageId,
    pausedAiMessageId,
    playedAiMessageIds,
    reviewAudioNotice,
    aiError,
  } = aiTurn.state
  const {
    generateNextReply,
    playAiText,
    stopAiPlayback,
    releaseAiPlayback,
    pauseAiPlayback,
    resumeAiPlayback,
    skipFailedTts,
    playReviewAudio,
    initFirstLine,
    resetAiTurn,
    dispose: disposeAiTurn,
    unlockAudio,
  } = aiTurn.actions
  releaseAiPlaybackRef.current = releaseAiPlayback
  const stopReviewAudio = useCallback(() => {
    if (phaseRef.current === 'session_complete') {
      disposeAiTurn()
      return
    }
    stopAiPlayback()
  }, [disposeAiTurn, stopAiPlayback])
  useEffect(() => {
    phaseRef.current = phase
  }, [phase])
  useEffect(() => {
    scrollToBottom(messages.length <= 1 ? 'auto' : 'smooth')
  }, [messages, phase, partialTranscript, hintData, hintLevel, uiError, scrollToBottom])
  const replaceMessages = useCallback((next: ConversationMessage[]) => {
    messagesRef.current = next
    setMessages(next)
  }, [])
  const completedPractice = useCompletedPractice({
    config, phase, scenario, sessionId, startedAt: sessionStartedAt, endedAt: sessionEndedAt, messages, messagesRef, rounds, roundsRef, practiceHistory, completionReason,
    persistPractice,
    restoreCompletedSession: (record) => {
      setSessionId(record.sessionId); setScenario(structuredClone(record.scenario)); setSessionStartedAt(record.startedAt); setSessionEndedAt(record.endedAt); setCompletionReason(record.report.completion.reason)
      replaceMessages(structuredClone(record.messages)); roundsRef.current = structuredClone(record.rounds); setRounds(structuredClone(record.rounds)); setPhase('session_complete'); phaseRef.current = 'session_complete'; sessionSnapshotRef.current = null; setAppForegroundNotice('')
    },
  })
  const { feedbackData, feedbackStatus, feedbackErrorMsg, report, currentPractice, practiceComparison, restoredRedoTask, redoRecords } = completedPractice.model
  const listeningScaffold = useListeningScaffoldController({
    messagesRef, rounds, currentRound: currentRoundView, scenario, sessionId,
    activeAiMessageId, pausedAiMessageId, isTtsActionLocked: aiTurn.meta.isTtsActionLocked,
    replaceMessages, updateRoundByTurn,
    playAiText, pauseAiPlayback, resumeAiPlayback,
  })
  const { requestStates: listeningRequestStates, cache: cacheListeningScaffold, getLevel: getListeningLevel, replay: replayPartnerMessage, advance: advanceListeningScaffold } = listeningScaffold
  const stopActiveResources = useCallback(() => {
    beginOperation()
    disposeVoiceTurn()
    disposeAiTurn()
    abortSpeechAssist('stopped')
  }, [abortSpeechAssist, beginOperation, disposeAiTurn, disposeVoiceTurn])
  const loadConfig = useCallback(async () => {
    const operationId = beginOperation()
    transitionTo('loading_config')
    setUiError(null)
    const controller = new AbortController()
    requestAbortRef.current = controller
    try {
      const nextConfig = await fetchConfig(controller.signal)
      if (!isCurrentOperation(operationId)) return
      setConfig(nextConfig)
      const snapshot = sessionSnapshotRef.current
      sessionSnapshotRef.current = null
      if (snapshot) {
        let restoredMessages = structuredClone(snapshot.messages)
        let restoredRounds = structuredClone(snapshot.rounds)
        let restoredRound = snapshot.currentRound ? structuredClone(snapshot.currentRound) : null
        let restoredTurn = snapshot.turn
        let restoredPhase: AppPhase = 'waiting_user'; let restoredEndedAt: number | null = null; let restoredCompletionReason: CompletionReason | null = null
        let restoredTranscript: TranscriptText | null = null
        if (snapshot.phase === 'confirming_transcript' && snapshot.transcript.finalText.trim()) {
          restoredPhase = 'confirming_transcript'
          restoredTranscript = structuredClone(snapshot.transcript)
        } else if (snapshot.phase === 'requesting_llm' && snapshot.transcript.finalText.trim()) {
          restoredMessages = removeLastSubmittedUserMessage(restoredMessages, snapshot.turn)
          restoredPhase = 'confirming_transcript'
          restoredTranscript = structuredClone(snapshot.transcript)
        } else if ((snapshot.phase === 'preparing_tts' || snapshot.phase === 'playing_ai') && restoredRound?.userFinal.trim()) {
          if (!restoredRounds.some((round) => round.turn === restoredRound?.turn)) {
            restoredRounds = [...restoredRounds, structuredClone(restoredRound)]
          }
          if (snapshot.turn >= snapshot.scenario.maxTurns) {
            restoredRound = null
            restoredPhase = 'session_complete'
            restoredEndedAt = Date.now()
            restoredCompletionReason = 'turn_budget'
          } else {
            const nextTurn = snapshot.turn + 1
            const nextPrompt = restoredMessages.findLast((message) => message.role === 'assistant' && message.turn === nextTurn)?.text
              ?? restoredRound.nextAiReply
              ?? snapshot.scenario.firstLine
            restoredTurn = nextTurn
            restoredRound = createRoundRecord(nextTurn, nextPrompt, 0)
          }
        }
        setSessionId(snapshot.sessionId)
        setScenario(structuredClone(snapshot.scenario))
        setSessionStartedAt(snapshot.sessionStartedAt)
        setSessionEndedAt(restoredEndedAt)
        setCompletionReason(restoredCompletionReason)
        setTurn(restoredTurn)
        replaceMessages(restoredMessages)
        roundsRef.current = restoredRounds
        setRounds(restoredRounds)
        replaceCurrentRound(restoredRound)
        setPendingHistory(restoredMessages)
        updateFinalText(restoredTranscript?.finalText ?? '')
        restoredTranscriptRef.current = restoredTranscript
        if (restoredPhase === 'confirming_transcript') openTranscriptSheet()
        phaseRef.current = restoredPhase
        setPhase(restoredPhase)
        setAppForegroundNotice('')
      } else {
        if (phaseRef.current !== 'session_complete') transitionTo('idle')
      }
      setLastFailedStep(null)
    } catch (error) {
      if (controller.signal.aborted || !isCurrentOperation(operationId)) return
      setUiError(toUiError(error))
      setLastFailedStep('config')
      transitionTo('error')
    } finally {
      if (requestAbortRef.current === controller) requestAbortRef.current = null
    }
  }, [beginOperation, isCurrentOperation, openTranscriptSheet, replaceCurrentRound, replaceMessages, transitionTo, updateFinalText])
  useEffect(() => {
    const timer = window.setTimeout(() => void loadConfig(), 0)
    return () => window.clearTimeout(timer)
  }, [loadConfig])
  useEffect(() => {
    if (hintedTurnRef.current === turn) return
    hintedTurnRef.current = turn
    hintRequestRef.current?.abort('turn_changed')
    hintRequestRef.current = null
    setHintData(null)
    setHintLevel(0)
    setIsLoadingHint(false)
    setHintSheetVisible(false)
  }, [setHintSheetVisible, turn])
  useSessionSnapshotPersistence({ reading: sessionSnapshotRef.current !== null, phase, sessionId, scenario, messages, rounds, currentRound: currentRoundView, turn, startedAt: sessionStartedAt, endedAt: sessionEndedAt, transcript })
  useSessionLifecycle({ phaseRef, setOnline, setNotice: setAppForegroundNotice, beginOperation, abortSpeechAssist, interruptPlayback: aiTurn.actions.interruptPlaybackForBackground, disposeVoice: disposeVoiceTurn, dispatch: dispatchInterruptionRecovery, touchRound, setUiError, transitionTo, stopResources: stopActiveResources })
  const startSession = useCallback(async (scenarioToken: string, draftRequestId?: string, previousAdvice?: PreviousAdvice) => {
    if (!config || !online || sessionStartLockRef.current) return
    dispatchInterruptionRecovery({ type: 'reset' })
    clearSessionSnapshot()
    sessionStartLockRef.current = true
    const operationId = beginOperation()
    hintRequestRef.current?.abort('session_started')
    hintRequestRef.current = null
    setHintData(null)
    setHintLevel(0)
    setHintSheetVisible(false)
    setSessionId('')
    setScenario(null)
    setSessionStartedAt(null); setSessionEndedAt(null); setCompletionReason(null)
    setTurn(1)
    replaceMessages([])
    roundsRef.current = []
    setRounds([])
    listeningScaffold.reset()
    replaceCurrentRound(null)
    setPendingHistory([])
    resetVoiceTurn()
    resetAiTurn()
    setUiError(null)
    setInlineError('')
    completedPractice.actions.reset()
    const controller = new AbortController()
    requestAbortRef.current = controller
    setTelemetrySession(null)
    transitionTo('loading_config')
    if (!config.elevenlabs.sttAvailable) {
      syncMicrophoneReadiness('unavailable')
    } else {
      void queryMicrophonePermission().then((status) => {
        if (isCurrentOperation(operationId)) {
          syncMicrophoneReadiness(status)
        }
      }).catch(() => undefined)
    }
    void unlockAudio().catch(() => undefined)
    try {
      const startedSession = await startScenarioSession(scenarioToken, controller.signal)
      if (controller.signal.aborted || !isCurrentOperation(operationId)) return
      const nextScenario = startedSession.scenario
      const id = createSessionId()
      const startedAt = Date.now()
      const firstMessage: ConversationMessage = {
        id: createMessageId(1, 'assistant'),
        turn: 1,
        role: 'assistant',
        text: nextScenario.firstLine,
      }
      const localScenario = previousAdvice ? { ...nextScenario, previousAdvice } : nextScenario
      setTelemetrySession(startedSession.telemetrySession)
      setScenario(localScenario)
      if (draftRequestId) discardDraft()
      setSessionId(id)
      setSessionStartedAt(startedAt)
      setTurn(1)
      replaceMessages([firstMessage])
      const firstRound = createRoundRecord(1, nextScenario.firstLine, 0)
      if (previousAdvice?.viewed) firstRound.expressionScaffoldLevel = 4
      replaceCurrentRound(firstRound)
      setAppForegroundNotice('')
      clearVoiceNotice()
      await initFirstLine(nextScenario.firstLine, operationId, firstMessage.id)
      preparedStartRef.current = null
    } catch (error) {
      if (controller.signal.aborted || !isCurrentOperation(operationId)) return
      setUiError(toUiError(error))
      setLastFailedStep('scenario')
      transitionTo('idle')
    } finally {
      if (requestAbortRef.current === controller) requestAbortRef.current = null
      sessionStartLockRef.current = false
    }
  }, [beginOperation, clearVoiceNotice, config, discardDraft, initFirstLine, isCurrentOperation, online, replaceCurrentRound, replaceMessages, resetAiTurn, resetVoiceTurn, setHintSheetVisible, syncMicrophoneReadiness, transitionTo, unlockAudio])
  const handleRequestHint = useCallback(async (intentionZh?: string) => {
    const trimmedIntention = intentionZh?.trim()
    const nextLevel = Math.min(4, hintLevel + 1) as 0 | 1 | 2 | 3 | 4
    if (hintData && !trimmedIntention) {
      setHintLevel(nextLevel)
      touchRound((round) => {
        if (nextLevel > round.expressionScaffoldLevel) {
          round.expressionScaffoldLevel = nextLevel
        }
      })
      return
    }
    if (!scenario) return
    hintRequestRef.current?.abort('superseded')
    const controller = new AbortController()
    hintRequestRef.current = controller
    const requestOperation = operationIdRef.current
    const requestSessionId = sessionId
    const requestTurn = turn
    if (trimmedIntention) {
      setHintData(null)
      setHintLevel(0)
    }
    setIsLoadingHint(true)
    try {
      const res = await fetchHint(scenario, currentAiText, messagesRef.current, trimmedIntention, controller.signal)
      if (controller.signal.aborted || hintRequestRef.current !== controller || !hintSheetVisibleRef.current || !isCurrentOperation(requestOperation) || sessionId !== requestSessionId || turn !== requestTurn || currentRoundRef.current?.turn !== requestTurn) return
      setHintData(res)
      // 明确说出想表达的意思后，直接给完整例句；泛化求助仍按四级渐进。
      const resolvedLevel = trimmedIntention ? 4 : 1
      setHintLevel(resolvedLevel)
      touchRound((round) => {
        if (round.expressionScaffoldLevel < resolvedLevel) {
          round.expressionScaffoldLevel = resolvedLevel
        }
      })
    } catch {
      if (controller.signal.aborted || hintRequestRef.current !== controller || !isCurrentOperation(requestOperation) || sessionId !== requestSessionId || currentRoundRef.current?.turn !== requestTurn) return
      setAppForegroundNotice('获取提示暂时失败，可继续自行回答。')
    } finally {
      if (hintRequestRef.current === controller) {
        hintRequestRef.current = null
        setIsLoadingHint(false)
      }
    }
  }, [currentAiText, hintData, hintLevel, isCurrentOperation, scenario, sessionId, touchRound, turn])
  const endSession = useCallback((includeConfirmedCurrent: boolean) => {
    stopActiveResources()
    const activeRound = currentRoundRef.current
    if (includeConfirmedCurrent && activeRound?.userFinal) appendRound(activeRound)
    replaceCurrentRound(null)
    setCompletionReason('user_exit'); setSessionEndedAt(Date.now())
    setUiError(null)
    transitionTo('session_complete')
  }, [appendRound, replaceCurrentRound, stopActiveResources, transitionTo])
  const confirmTranscript = useCallback(async () => {
    const finalText = transcript.finalText.trim()
    if (!finalText) { setInlineError('回答为空。请再说一次、改用文字回答，或重新录制。'); return }
    if (submitLockRef.current) return
    submitLockRef.current = true
    setInlineError('')
    const confirmedAt = Date.now(); const transcriptSource = restoredTranscriptRef.current ?? transcript
    touchRound((round) => {
      round.userOriginal = transcriptSource.rawText.trim()
      round.userFinal = finalText
      round.transcriptModified = round.inputMode === 'stt' && finalText !== transcriptSource.cleanedText.trim()
      round.transcriptModificationCount = round.transcriptModified ? 1 : 0
      round.timing.transcriptConfirmedAt = confirmedAt
    })
    const userMessage: ConversationMessage = {
      id: createMessageId(turn, 'user'),
      turn,
      role: 'user',
      text: finalText,
      transcript: {
        rawText: transcriptSource.rawText,
        cleanedText: transcriptSource.cleanedText,
        finalText,
      },
    }
    const history = [...messagesRef.current, userMessage]
    setPendingHistory(history)
    replaceMessages(history)
    restoredTranscriptRef.current = null
    await generateNextReply(history, false)
    submitLockRef.current = false
  }, [generateNextReply, replaceMessages, touchRound, transcript, turn])
  const activeError = uiError ?? voiceError ?? aiError
  const activeFailedStep = lastFailedStep ?? voiceTurn.state.lastFailedStep ?? aiTurn.state.lastFailedStep
  const validationLifecycle = useValidationLifecycle({
    telemetrySession,
    sessionStartedAt,
    rounds,
    currentRound: currentRoundView,
    report,
    feedback: feedbackData,
    redoRecords,
    config,
    activeFailure: activeError ? { code: activeError.code, step: activeFailedStep } : null,
    recoveredTarget: interruptionRecovery.status === 'recovered' ? interruptionRecovery.target : null,
    evaluationVersion: scenario?.dynamicData.evaluationVersion === undefined ? undefined : String(scenario.dynamicData.evaluationVersion),
  })
  const recoveryTarget = interruptionRecovery.target
  const recoveryCanAct = interruptionRecovery.status === 'interrupted' || interruptionRecovery.status === 'failed'
  const interruptionRecoveryAffordances = decideInterruptionRecoveryAffordances(recoveryCanAct ? recoveryTarget : null)
  const retryFailedStep = useCallback(async () => {
    setUiError(null)
    voiceTurn.actions.clearVoiceError()
    aiTurn.actions.clearAiError()
    const interruptedTarget = interruptionRecovery.target
    if (interruptedTarget && (interruptionRecovery.status === 'interrupted' || interruptionRecovery.status === 'failed')) {
      dispatchInterruptionRecovery({ type: 'retry_started' })
      try {
        await executeInterruptionRecovery(interruptedTarget, {
          waitingUser: () => transitionTo('waiting_user'),
          confirmingTranscript: () => transitionTo('confirming_transcript'),
          stt: startRecording,
          llm: () => generateNextReply(pendingHistory, true),
          tts: async () => {
            touchRound((round) => {
              round.retryCount += 1
            })
            const reply = aiTurn.meta.pendingAdvanceReply
            const latestAssistantId = messagesRef.current.findLast((message) => message.role === 'assistant')?.id
            await playAiText(reply ?? currentAiText, Boolean(reply), undefined, latestAssistantId)
          },
        })
        dispatchInterruptionRecovery({ type: phaseRef.current === 'error' ? 'recovery_failed' : 'recovery_succeeded' })
      } catch (error) {
        dispatchInterruptionRecovery({ type: 'recovery_failed' })
        setUiError(toUiError(error))
        transitionTo('error')
      }
      return
    }
    if (activeFailedStep === 'stt') {
      await startRecording()
      return
    }
    if (activeFailedStep === 'llm') {
      await generateNextReply(pendingHistory, true)
      return
    }
    if (activeFailedStep === 'tts') {
      touchRound((round) => {
        round.retryCount += 1
      })
      const reply = aiTurn.meta.pendingAdvanceReply
      const latestAssistantId = messagesRef.current.findLast((message) => message.role === 'assistant')?.id
      await playAiText(reply ?? currentAiText, Boolean(reply), undefined, latestAssistantId)
      return
    }
    if (activeFailedStep === 'config' || activeFailedStep === 'scenario') {
      if (preparedStartRef.current) await startSession(preparedStartRef.current.scenarioToken, preparedStartRef.current.draftRequestId, preparedStartRef.current.previousAdvice)
      else if (readyScenarioData) await startSession(readyScenarioData.scenarioToken)
      else await loadConfig()
    }
  }, [activeFailedStep, aiTurn.actions, aiTurn.meta.pendingAdvanceReply, currentAiText, generateNextReply, interruptionRecovery, loadConfig, pendingHistory, playAiText, readyScenarioData, startSession, startRecording, touchRound, transitionTo, voiceTurn.actions])
  const enterLifecycleTextInput = useCallback(() => {
    setUiError(null)
    voiceTurn.actions.clearVoiceError()
    aiTurn.actions.clearAiError()
    dispatchInterruptionRecovery({ type: 'retry_started' })
    enterTextInput()
    dispatchInterruptionRecovery({ type: 'recovery_succeeded' })
  }, [aiTurn.actions, enterTextInput, voiceTurn.actions])
  const resetSession = useCallback(() => {
    completedPractice.actions.reset()
    hintRequestRef.current?.abort('session_reset')
    hintRequestRef.current = null
    listeningScaffold.reset()
    setUiError(null)
    stopActiveResources()
    dispatchInterruptionRecovery({ type: 'reset' })
    clearSessionSnapshot()
    setSessionId('')
    setTelemetrySession(null)
    setScenario(null)
    restoredTranscriptRef.current = null
    setSessionStartedAt(null); setSessionEndedAt(null); setCompletionReason(null)
    setTurn(1)
    replaceMessages([])
    roundsRef.current = []
    setRounds([])
    resetVoiceTurn()
    if (config?.elevenlabs.sttAvailable) {
      void queryMicrophonePermission().then((status) => {
        syncMicrophoneReadiness(status)
      }).catch(() => undefined)
    } else {
      syncMicrophoneReadiness('unavailable')
    }
    resetAiTurn()
    replaceCurrentRound(null)
    setInlineError('')
    listeningScaffold.reset()
    resetCustom()
    setHintData(null)
    setHintLevel(0)
    setHintSheetVisible(false)
    setShowGoalsSheet(false)
    sessionStartLockRef.current = false
    submitLockRef.current = false
    transitionTo(config ? 'idle' : 'loading_config')
  }, [completedPractice.actions, config, replaceCurrentRound, replaceMessages, resetAiTurn, resetCustom, resetVoiceTurn, setHintSheetVisible, stopActiveResources, syncMicrophoneReadiness, transitionTo])
  resetSessionRef.current = resetSession
  const sessionCoreGoal = scenario?.dynamicData.coreGoal ?? null
  const recoveryMessage = recoveryStatusText(interruptionRecovery.status)
  const isSessionActive = sessionStartedAt !== null && sessionEndedAt === null
  const controlsLocked = ['fetching_token', 'connecting_stt', 'finalizing_transcript', 'requesting_llm', 'preparing_tts'].includes(phase)
  const reveal = phase === 'session_complete' ? scenario?.reveal ?? null : null
  const canConfirmTranscript = transcript.finalText.trim().length > 0
  const silencePromptVisible = phase === 'recording' && shouldShowSilencePrompt(silentSeconds, microphoneMeterAvailable)
  const effectiveForegroundNotice = voiceForegroundNotice.trim() || appForegroundNotice.trim()
  const handleStartDynamic = useCallback((token: string, previousAdvice?: PreviousAdvice) => {
    const draftRequestId = draftState.request?.requestId
    consumeReadyScenario()
    preparedStartRef.current = { scenarioToken: token, draftRequestId, previousAdvice }
    void startSession(token, draftRequestId, previousAdvice)
  }, [consumeReadyScenario, draftState.request?.requestId, startSession])
  return (
    <div className={`app-shell ${isSessionActive ? 'is-session-active' : ''} ${validationLifecycle.consent === 'accepted' ? 'is-validation-accepted' : ''}`} data-build="2026-09-07-listening-scaffold-l4">
      <a className="skip-link" href="#main-content">跳到主要内容</a>
      <header className="topbar">
        <p>Kaiwa</p>
        {isSessionActive && validationLifecycle.consent === 'accepted' && <ValidationConsent consent={validationLifecycle.consent} onDecision={validationLifecycle.decide} onRevoke={validationLifecycle.revoke} />}
        {isSessionActive && (
          <button className="text-button quiet-exit" type="button" onClick={() => endSession(true)} disabled={controlsLocked}>
            结束练习
          </button>
        )}
      </header>
      <main id="main-content" className="main-layout">
        {!isSessionActive && phase !== 'session_complete' && (
          <section className="conversation-panel" aria-labelledby="conversation-heading">
            {!online && <p className="network-notice" role="status">网络已断开。恢复连接后可以继续。</p>}
            {validationLifecycle.consent === 'undecided' && <ValidationConsent consent={validationLifecycle.consent} onDecision={validationLifecycle.decide} onRevoke={validationLifecycle.revoke} />}
            <Home
              loading={phase === 'loading_config'}
              ready={config !== null}
              online={online}
              error={uiError}
              sttAvailable={Boolean(config?.elevenlabs.sttAvailable)}
              sttModel={config?.elevenlabs.sttModel ?? ''}
              customInputZh={customInputZh}
              setCustomInputZh={setCustomInputZh}
              clarifications={clarifications}
              onStartDynamic={handleStartDynamic}
              pendingClarification={pendingClarification}
              readyScenarioData={readyScenarioData}
              isDraftingScenario={isDraftingScenario}
              draftState={draftState}
              onRetryDraftTransport={retryDraftTransport}
              onInputEdited={discardDraft}
              onDraftScenario={handleDraftScenario}
              onAnswerClarification={handleAnswerClarification}
              onPreviousAdviceViewed={markReadyAdviceViewed}
              onResetCustom={resetCustom}
              recentPractices={recentPractices}
              practiceHistory={practiceHistory}
              historyNotice={historyNotice}
              historySaving={historySaving}
              onPreparePractice={(attempt) => void preparePracticeAgain(attempt)}
              onRemovePractice={(attempt) => void removePractice(attempt)}
            />
            {validationLifecycle.consent === 'accepted' && <ValidationConsent consent={validationLifecycle.consent} onDecision={validationLifecycle.decide} onRevoke={validationLifecycle.revoke} />}
          </section>
        )}
        {phase === 'session_complete' && report && reveal && scenario && (
          <section className="conversation-panel" aria-labelledby="conversation-heading">
            <SessionComplete
              messages={messages}
              rounds={rounds}
              report={report}
              sessionId={sessionId}
              scenario={scenario}
              reveal={reveal}
              config={config}
              online={online}
              feedbackData={feedbackData}
              feedbackStatus={feedbackStatus}
              feedbackErrorMsg={feedbackErrorMsg}
              restoredRedoTask={restoredRedoTask}
              onRetryFeedback={completedPractice.actions.retryConversationFeedback}
              onReplayAi={(text) => void playReviewAudio(text)}
              onStopAudio={stopReviewAudio}
              onRequestRedo={(request) => { validationLifecycle.trackRedoStarted(request.turn); completedPractice.actions.startRedoTask(request) }}
              onRequestListeningScaffold={requestListeningScaffold}
              onCacheListeningScaffold={cacheListeningScaffold}
              onNewScenario={resetSession}
              audioNotice={reviewAudioNotice}
              practiceComparison={practiceComparison}
              onRepeatScenario={currentPractice ? () => void preparePracticeAgain(currentPractice) : undefined}
              historyNotice={historySaving ? '正在保存本次练习…' : historyNotice}
              onRetrySave={historySaveFailed && currentPractice ? () => void persistPractice(currentPractice) : undefined}
            />
            {validationLifecycle.consent === 'accepted' && <ValidationConsent consent={validationLifecycle.consent} onDecision={validationLifecycle.decide} onRevoke={validationLifecycle.revoke} />}
          </section>
        )}
        {isSessionActive && <ActiveSession
          model={{
            phase, scenario, turn, controlsLocked, showGoalsSheet, sessionCoreGoal, recoveryMessage, interruptionRecovery,
            interruptionRecoveryAffordances, recoveryTarget, online, effectiveForegroundNotice, messages, listeningRequestStates,
            activeAiMessageId, pausedAiMessageId, playedAiMessageIds, activeError, activeFailedStep, silencePromptVisible, activeAssistIsVisible,
            activeAssistState, confirmedTranscript, interimTranscript, partialTranscript, recordingSeconds, dockInputMode,
            dockTextValue, hintData, isLoadingHint, hintLevel, showHintSheet, showTranscriptSheet, manualInput, transcript,
            showOriginalTranscript, inlineError, canConfirmTranscript, sttAvailable: Boolean(config?.elevenlabs.sttAvailable), sttModel: config?.elevenlabs.sttModel ?? '', ttsAvailable: Boolean(config?.elevenlabs.ttsAvailable), reviewAudioNotice,
            previousAdvice: scenario?.previousAdvice,
          }}
          actions={{
            endSession, setShowGoalsSheet, dispatchInterruptionRecovery, setAppForegroundNotice, clearVoiceNotice,
            getListeningLevel, replayPartnerMessage, advanceListeningScaffold, setDockInputMode, startRecording, enterTextInput, enterLifecycleTextInput,
            updateFinalText, setDockTextValue, openTranscriptSheet, handleRequestHint, setShowHintSheet: setHintSheetVisible, stopRecording,
            skipFailedTts, retryFailedStep, resetSession, stopAiPlayback, releaseAiPlayback, playReviewAudio, closeTranscriptSheet, rerecord, confirmTranscript,
            setInlineError, toggleOriginalTranscript, onPreviousAdviceViewed: () => { if (!scenario?.previousAdvice) return; touchRound((round) => { round.expressionScaffoldLevel = 4 }); setScenario((current) => current?.previousAdvice && !current.previousAdvice.viewed ? { ...current, previousAdvice: { ...current.previousAdvice, viewed: true } } : current) },
          }}
          messageListRef={messageListRef}
          chatBottomRef={chatBottomRef}
        />}
      </main>
    </div>
  )
}
export default App
