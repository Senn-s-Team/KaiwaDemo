/**
 * [INPUT]: 依赖 lib/scenario-draft-task 首页恢复、lib/feedback-task-recovery 完成复盘恢复、lib/practice-history 本机历史、lib/practice-progress 表现比较、lib/api 接口请求、shared/listening-scaffold 内部四级听力协议、lib/stt 中文场景输入识别、lib/voice-turn-controller 语音回合控制器深模块、lib/ai-turn-controller 相手回合控制器深模块、lib/microphone 权限探测、lib/session 会话状态与显式中断恢复状态机
 * [OUTPUT]: 对外提供 App 根组件，驱动可编辑中文语音场景输入、原场景复练与证据对比、统一 recovery 反馈任务展示、KaiwaDemo 固定五回合会话、渐进帮助、可暂停继续的相手语音与安全生命周期交互
 * [POS]: src/ 核心入口与主控制器，编排可持久化会话业务状态、内部四级帮助、不可恢复媒体资源的显式释放与 offline/background 业务中断恢复；pagehide 仅释放资源，真实活动阶段才回滚业务状态
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import './App.css'
import { ActiveSession } from './components/ActiveSession'
import { Home } from './components/Home'
import { SessionComplete } from './components/SessionComplete'
import { SILENCE_AUTO_STOP_SECONDS, SILENCE_COUNTDOWN_START_SECONDS } from './lib/audio-feedback'
import {
  fetchConfig,
  fetchHint,
  requestListeningScaffold,
  startScenarioSession,
} from './lib/api'
import { createRoundRecord, downloadReport } from './lib/metrics'
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
import { clearSessionSnapshot, readSessionSnapshot, removeLastSubmittedUserMessage, type SessionSnapshot } from './lib/session-snapshot'
import type {
  AppPhase,
  ConversationMessage,
  HintResponse,
  PrototypeConfig,
  RoundRecord,
  SessionScenario,
  UiError,
  TranscriptText,
} from './types'
const BUILD_ID = '2026-09-07-listening-scaffold-l4'
function recoveryStatusText(status: 'idle' | 'interrupted' | 'retrying' | 'recovered' | 'failed'): string {
  switch (status) {
    case 'idle': return ''
    case 'interrupted': return '当前步骤已中断，请选择重试或安全回退。'
    case 'retrying': return '正在重新建立当前步骤，请稍候。'
    case 'recovered': return '当前步骤已恢复，可以继续会话。'
    case 'failed': return '恢复当前步骤失败，请重试或改用文字回答。'
  }
}
const PHASE_TRANSITIONS: Record<AppPhase, readonly AppPhase[]> = {
  loading_config: ['idle', 'preparing_tts', 'error'],
  idle: ['loading_config', 'error'],
  fetching_token: ['connecting_stt', 'recording', 'confirming_transcript', 'error', 'session_complete'],
  connecting_stt: ['recording', 'confirming_transcript', 'error', 'session_complete'],
  waiting_user: ['recording', 'fetching_token', 'connecting_stt', 'confirming_transcript', 'preparing_tts', 'error', 'session_complete'],
  recording: ['finalizing_transcript', 'confirming_transcript', 'waiting_user', 'error', 'session_complete'],
  finalizing_transcript: ['confirming_transcript', 'waiting_user', 'error', 'session_complete'],
  confirming_transcript: ['waiting_user', 'recording', 'fetching_token', 'requesting_llm', 'error', 'session_complete'],
  requesting_llm: ['preparing_tts', 'waiting_user', 'error', 'session_complete'],
  preparing_tts: ['playing_ai', 'waiting_user', 'error', 'session_complete'],
  playing_ai: ['waiting_user', 'error', 'session_complete'],
  round_complete: ['waiting_user', 'recording', 'fetching_token', 'session_complete', 'error'],
  session_complete: ['loading_config', 'idle', 'error'],
  error: ['loading_config', 'idle', 'fetching_token', 'connecting_stt', 'waiting_user', 'recording', 'confirming_transcript', 'requesting_llm', 'preparing_tts', 'session_complete'],
}
function App() {
  const [config, setConfig] = useState<PrototypeConfig | null>(null)
  const [phase, setPhase] = useState<AppPhase>('loading_config')
  const [messages, setMessages] = useState<ConversationMessage[]>([])
  const [sessionId, setSessionId] = useState('')
  const [scenario, setScenario] = useState<SessionScenario | null>(null)
  const [sessionStartedAt, setSessionStartedAt] = useState<number | null>(null)
  const [sessionEndedAt, setSessionEndedAt] = useState<number | null>(null)
  const [turn, setTurn] = useState(1)
  const [rounds, setRounds] = useState<RoundRecord[]>([])
  const [interruptionRecovery, dispatchInterruptionRecovery] = useReducer(reduceInterruptionRecovery, INITIAL_INTERRUPTION_RECOVERY_STATE)
  const [currentRoundView, setCurrentRoundView] = useState<RoundRecord | null>(null)
  const [online, setOnline] = useState(navigator.onLine)
  const [appForegroundNotice, setAppForegroundNotice] = useState('')
  const [uiError, setUiError] = useState<UiError | null>(null)
  const [inlineError, setInlineError] = useState('')
  const [lastFailedStep, setLastFailedStep] = useState<'config' | 'scenario' | 'token' | 'stt' | 'llm' | 'tts' | null>(null)
  const [copyStatus, setCopyStatus] = useState('')
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
  const submitLockRef = useRef(false)
  const operationIdRef = useRef(0)
  const messageListRef = useRef<HTMLDivElement | null>(null)
  const sessionSnapshotRef = useRef<SessionSnapshot | null>(readSessionSnapshot())
  const homePractice = useHomePractice({ online, activeSession: scenario !== null || sessionSnapshotRef.current !== null, resetSession: () => resetSessionRef.current(), setUiError })
  const { customInputZh, clarifications, pendingClarification, readyScenarioData, isDraftingScenario, draftState, practiceHistory, recentPractices, historyNotice, historySaving, historySaveFailed } = homePractice.model
  const { setCustomInputZh, submitDraft: handleDraftScenario, answerClarification: handleAnswerClarification, resetCustom, retryDraftTransport, discardDraft, persistPractice, preparePracticeAgain, removePractice } = homePractice.actions
  const chatBottomRef = useRef<HTMLDivElement | null>(null)
  const restoredTranscriptRef = useRef<TranscriptText | null>(null)
  const abortSpeechAssistRef = useRef<(reason: import('../shared/speech-assist').SpeechAssistAbortReason) => void>(() => undefined)
  const hintRequestRef = useRef<AbortController | null>(null)

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
  const voiceTurn = useVoiceTurnController({
    sttAvailable: Boolean(config?.elevenlabs.sttAvailable),
    sttModel: config?.elevenlabs.sttModel ?? '',
    online,
    phase,
    operation: operationCapability,
    transitionTo,
    touchRound,
    abortSpeechAssist: (reason) => abortSpeechAssistRef.current(reason),
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
    onSessionComplete: () => {
      setSessionEndedAt(Date.now())
      transitionTo('session_complete')
    },
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
    pauseAiPlayback,
    resumeAiPlayback,
    skipFailedTts,
    playReviewAudio,
    initFirstLine,
    resetAiTurn,
    dispose: disposeAiTurn,
    unlockAudio,
  } = aiTurn.actions
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
    config, phase, scenario, sessionId, startedAt: sessionStartedAt, endedAt: sessionEndedAt, messages, messagesRef, rounds, roundsRef, practiceHistory,
    persistPractice,
    restoreCompletedSession: (record) => {
      setSessionId(record.sessionId); setScenario(structuredClone(record.scenario)); setSessionStartedAt(record.startedAt); setSessionEndedAt(record.endedAt)
      replaceMessages(structuredClone(record.messages)); roundsRef.current = structuredClone(record.rounds); setRounds(structuredClone(record.rounds)); setPhase('session_complete'); phaseRef.current = 'session_complete'; sessionSnapshotRef.current = null; setAppForegroundNotice('已恢复上一场复盘。未重放录音、网络请求或语音。')
    },
  })
  const { feedbackData, feedbackStatus, feedbackErrorMsg, report, currentPractice, practiceComparison, restoredRedoTask } = completedPractice.model
  const { retryConversationFeedback, startRedoTask, copyReport } = completedPractice.actions
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
        let restoredPhase: AppPhase = 'waiting_user'
        let restoredEndedAt: number | null = null
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
        setAppForegroundNotice(restoredPhase === 'session_complete'
          ? '已恢复并完成上一轮。未重放网络请求或语音。'
          : '已从本次标签页的会话快照安全恢复。未重放录音、网络请求或语音。')
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
  useSessionSnapshotPersistence({ reading: sessionSnapshotRef.current !== null, phase, sessionId, scenario, messages, rounds, currentRound: currentRoundView, turn, startedAt: sessionStartedAt, endedAt: sessionEndedAt, transcript })
  useSessionLifecycle({ phaseRef, setOnline, setNotice: setAppForegroundNotice, beginOperation, abortSpeechAssist, interruptPlayback: aiTurn.actions.interruptPlaybackForBackground, disposeVoice: disposeVoiceTurn, dispatch: dispatchInterruptionRecovery, touchRound, setUiError, transitionTo, stopResources: stopActiveResources })

  const startSession = useCallback(async (scenarioToken: string, draftRequestId?: string) => {
    if (!config || !online || sessionStartLockRef.current) return
    dispatchInterruptionRecovery({ type: 'reset' })
    clearSessionSnapshot()
    sessionStartLockRef.current = true
    const operationId = beginOperation()
    setHintData(null)
    setHintLevel(0)
    setShowHintSheet(false)
    setSessionId('')
    setScenario(null)
    setSessionStartedAt(null)
    setSessionEndedAt(null)
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
    setCopyStatus('')
    completedPractice.actions.reset()
    const controller = new AbortController()
    requestAbortRef.current = controller
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
      const nextScenario = await startScenarioSession(scenarioToken, controller.signal)
      if (controller.signal.aborted || !isCurrentOperation(operationId)) return
      const id = createSessionId()
      const startedAt = Date.now()
      const firstMessage: ConversationMessage = {
        id: createMessageId(1, 'assistant'),
        turn: 1,
        role: 'assistant',
        text: nextScenario.firstLine,
      }
      setScenario(nextScenario)
      if (draftRequestId) discardDraft()
      setSessionId(id)
      setSessionStartedAt(startedAt)
      setTurn(1)
      replaceMessages([firstMessage])
      replaceCurrentRound(createRoundRecord(1, nextScenario.firstLine, 0))
      setAppForegroundNotice('')
      clearVoiceNotice()
      await initFirstLine(nextScenario.firstLine, operationId, firstMessage.id)
    } catch (error) {
      if (controller.signal.aborted || !isCurrentOperation(operationId)) return
      setUiError(toUiError(error))
      setLastFailedStep('scenario')
      transitionTo('idle')
    } finally {
      if (requestAbortRef.current === controller) requestAbortRef.current = null
      sessionStartLockRef.current = false
    }
  }, [beginOperation, clearVoiceNotice, config, discardDraft, initFirstLine, isCurrentOperation, online, replaceCurrentRound, replaceMessages, resetAiTurn, resetVoiceTurn, syncMicrophoneReadiness, transitionTo, unlockAudio])
  const handleRequestHint = useCallback(async () => {
    const nextLevel = Math.min(4, hintLevel + 1) as 0 | 1 | 2 | 3 | 4
    if (hintData) {
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
    setIsLoadingHint(true)
    try {
      const res = await fetchHint(scenario, currentAiText, messagesRef.current, controller.signal)
      if (controller.signal.aborted || !isCurrentOperation(requestOperation) || sessionId !== requestSessionId || turn !== requestTurn) return
      setHintData(res)
      setHintLevel(1)
      touchRound((round) => {
        if (round.expressionScaffoldLevel < 1) {
          round.expressionScaffoldLevel = 1
        }
      })
    } catch {
      if (controller.signal.aborted || !isCurrentOperation(requestOperation) || sessionId !== requestSessionId) return
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
    setSessionEndedAt(Date.now())
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
      if (readyScenarioData) await startSession(readyScenarioData.scenarioToken)
      else await loadConfig()
    }
  }, [activeFailedStep, aiTurn.actions, aiTurn.meta.pendingAdvanceReply, currentAiText, generateNextReply, interruptionRecovery, loadConfig, playAiText, pendingHistory, readyScenarioData, startRecording, startSession, touchRound, transitionTo, voiceTurn.actions])
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
    setScenario(null)
    restoredTranscriptRef.current = null
    setSessionStartedAt(null)
    setSessionEndedAt(null)
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
    setCopyStatus('')
    listeningScaffold.reset()
    resetCustom()
    setHintData(null)
    setHintLevel(0)
    setShowHintSheet(false)
    setShowGoalsSheet(false)
    sessionStartLockRef.current = false
    submitLockRef.current = false
    transitionTo(config ? 'idle' : 'loading_config')
  }, [completedPractice.actions, config, replaceCurrentRound, replaceMessages, resetAiTurn, resetCustom, resetVoiceTurn, stopActiveResources, syncMicrophoneReadiness, transitionTo])
  resetSessionRef.current = resetSession
  const copyCompletedReport = useCallback(async () => { await copyReport(); setCopyStatus('JSON 已复制') }, [copyReport])
  const sessionCoreGoal = scenario?.dynamicData.coreGoal ?? null
  const recoveryMessage = recoveryStatusText(interruptionRecovery.status)
  const isSessionActive = sessionStartedAt !== null && sessionEndedAt === null
  const controlsLocked = ['fetching_token', 'connecting_stt', 'finalizing_transcript', 'requesting_llm', 'preparing_tts'].includes(phase)
  const reveal = phase === 'session_complete' ? scenario?.reveal ?? null : null
  const canConfirmTranscript = transcript.finalText.trim().length > 0
  const silenceCountdownSeconds = phase === 'recording'
    && microphoneMeterAvailable
    && silentSeconds >= SILENCE_COUNTDOWN_START_SECONDS
    ? Math.max(1, SILENCE_AUTO_STOP_SECONDS - silentSeconds)
    : null
  const effectiveForegroundNotice = voiceForegroundNotice.trim() || appForegroundNotice.trim()
  useEffect(() => {
    if (
      phase !== 'recording'
      || !microphoneMeterAvailable
      || silentSeconds < SILENCE_AUTO_STOP_SECONDS
    ) return
    void stopRecording()
  }, [microphoneMeterAvailable, phase, silentSeconds, stopRecording])
  return (
    <div className={`app-shell ${isSessionActive ? 'is-session-active' : ''}`} data-build={BUILD_ID}>
      <a className="skip-link" href="#main-content">跳到主要内容</a>
      <header className="topbar">
        <p>Kaiwa</p>
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
              pendingClarification={pendingClarification}
              readyScenarioData={readyScenarioData}
              isDraftingScenario={isDraftingScenario}
              draftState={draftState}
              onRetryDraftTransport={retryDraftTransport}
              onInputEdited={discardDraft}
              onDraftScenario={handleDraftScenario}
              onAnswerClarification={handleAnswerClarification}
              onStartDynamic={(token) => void startSession(token, draftState.request?.requestId)}
              onResetCustom={resetCustom}
              recentPractices={recentPractices}
              practiceHistory={practiceHistory}
              historyNotice={historyNotice}
              historySaving={historySaving}
              onPreparePractice={(attempt) => void preparePracticeAgain(attempt)}
              onRemovePractice={(attempt) => void removePractice(attempt)}
            />
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
              feedbackData={feedbackData}
              feedbackStatus={feedbackStatus}
              feedbackErrorMsg={feedbackErrorMsg}
              restoredRedoTask={restoredRedoTask}
              onRetryFeedback={retryConversationFeedback}
              copyStatus={copyStatus}
              onCopy={() => void copyCompletedReport()}
              onDownload={() => downloadReport(report)}
              onReplayAi={(text) => void playReviewAudio(text)}
              onStopAudio={stopReviewAudio}
              onRequestRedo={startRedoTask}
              onRequestListeningScaffold={requestListeningScaffold}
              onCacheListeningScaffold={cacheListeningScaffold}
              onNewScenario={resetSession}
              audioNotice={reviewAudioNotice}
              practiceComparison={practiceComparison}
              onRepeatScenario={currentPractice ? () => void preparePracticeAgain(currentPractice) : undefined}
              historyNotice={historySaving ? '正在保存本次练习…' : historyNotice}
              onRetrySave={historySaveFailed && currentPractice ? () => void persistPractice(currentPractice) : undefined}
            />
          </section>
        )}
        {isSessionActive && <ActiveSession
          model={{
            phase, scenario, turn, controlsLocked, showGoalsSheet, sessionCoreGoal, recoveryMessage, interruptionRecovery,
            interruptionRecoveryAffordances, recoveryTarget, online, effectiveForegroundNotice, messages, listeningRequestStates,
            activeAiMessageId, pausedAiMessageId, playedAiMessageIds, activeError, activeFailedStep, silenceCountdownSeconds, activeAssistIsVisible,
            activeAssistState, confirmedTranscript, interimTranscript, partialTranscript, recordingSeconds, dockInputMode,
            dockTextValue, hintData, isLoadingHint, hintLevel, showHintSheet, showTranscriptSheet, manualInput, transcript,
            showOriginalTranscript, inlineError, canConfirmTranscript,
          }}
          actions={{
            endSession, setShowGoalsSheet, dispatchInterruptionRecovery, setAppForegroundNotice, clearVoiceNotice,
            getListeningLevel, replayPartnerMessage, advanceListeningScaffold, setDockInputMode, startRecording, enterTextInput, enterLifecycleTextInput,
            updateFinalText, setDockTextValue, openTranscriptSheet, handleRequestHint, setShowHintSheet, stopRecording,
            skipFailedTts, retryFailedStep, resetSession, stopAiPlayback, closeTranscriptSheet, rerecord, confirmTranscript,
            setInlineError, toggleOriginalTranscript,
          }}
          messageListRef={messageListRef}
          chatBottomRef={chatBottomRef}
        />}
      </main>
    </div>
  )
}
export default App
