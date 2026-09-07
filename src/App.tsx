/**
 * [INPUT]: 依赖 lib/practice-history 本机历史、lib/practice-progress 表现比较、lib/api 接口请求、shared/listening-scaffold 内部四级听力协议、lib/stt 中文场景输入识别、lib/voice-turn-controller 语音回合控制器深模块、lib/ai-turn-controller 相手回合控制器深模块、lib/microphone 权限探测、lib/session 会话状态与显式中断恢复状态机
 * [OUTPUT]: 对外提供 App 根组件，驱动可编辑中文语音场景输入、原场景复练与证据对比、KaiwaDemo 固定五回合会话、渐进帮助、可暂停继续的相手语音与安全生命周期交互
 * [POS]: src/ 核心入口与主控制器，编排可持久化会话业务状态、内部四级帮助、不可恢复媒体资源的显式释放与 offline/background 业务中断恢复；pagehide 仅释放资源，真实活动阶段才回滚业务状态
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { AlertCircle, ArrowRight, Keyboard, Lightbulb, MessageCircle, Mic, Pencil, Square, Target, Volume2, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import './App.css'
import type { SpeechAssistAbortReason } from '../shared/speech-assist'
import type { ListeningScaffoldResponse } from '../shared/listening-scaffold'
import {
  formatRecordingTime,
  SILENCE_AUTO_STOP_SECONDS,
  SILENCE_COUNTDOWN_START_SECONDS,
} from './lib/audio-feedback'
import { cleanTranscript } from './lib/text-cleaner'
import {
  ApiError,
  draftScenario,
  fetchConfig,
  fetchHint,
  requestConversationFeedback,
  requestListeningScaffold,
  requestElevenLabsToken,
  requestRedoFeedback,
  requestSpeechAssist,
  startScenarioSession,
  restartPractice,
} from './lib/api'
import { buildSessionReport, createRoundRecord, downloadReport } from './lib/metrics'
import { savePracticeAttempt, listPracticeAttempts, deletePracticeScenario, type PracticeAttempt, type StoredPracticeAttempt } from './lib/practice-history'
import { comparePracticeAttempts } from './lib/practice-progress'
import { buildSparkPrompt, drawPracticeExamples } from './lib/spark-practice'
import { appendHomeSttText, shouldApplyHomeSttResult, shouldCancelHomeSttForTransition } from './lib/home-stt'
import { queryMicrophonePermission } from './lib/microphone'
import { releaseMicrophoneStream, shouldTeardownOnVisibility } from './lib/audio-engine'
import { createMessageId, createSessionId, decideInterruptionRecovery, decideInterruptionRecoveryAffordances, executeInterruptionRecovery, INITIAL_INTERRUPTION_RECOVERY_STATE, reduceInterruptionRecovery } from './lib/session'
import { RealtimeSttSession } from './lib/stt'
import { toUiError } from './lib/ui'
import { useVoiceTurnController } from './lib/voice-turn-controller'
import { useAiTurnController } from './lib/ai-turn-controller'
import { ASSIST_TIMING, shouldDisplaySpeechAssistResult, shouldTriggerSpeechAssist, type ActiveSpeechAssistState } from './lib/speech-assist'
import type {
  AppPhase,
  ConversationFeedbackResponse,
  ConversationMessage,
  DynamicScenarioData,
  FeedbackLoadingState,
  HintResponse,
  ListeningScaffoldLevel,
  PrototypeConfig,
  RedoRecord,
  RoundRecord,
  SessionReport,
  SessionScenario,
  SpeechAssistEvent,
  UiError,
  TranscriptText,
} from './types'
const BUILD_ID = '2026-09-07-listening-scaffold-l4'

const SESSION_SNAPSHOT_KEY = 'kaiwa.current-session.v1'
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

function clearSessionSnapshot(): void {
  try {
    window.sessionStorage.removeItem(SESSION_SNAPSHOT_KEY)
  } catch {
    return
  }
}


interface SessionSnapshot {
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

function readSessionSnapshot(): SessionSnapshot | null {
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

function removeLastSubmittedUserMessage(messages: ConversationMessage[], turn: number): ConversationMessage[] {
  const submittedIndex = messages.findLastIndex((message) => message.role === 'user' && message.turn === turn)
  if (submittedIndex < 0) return messages
  return messages.filter((_, index) => index !== submittedIndex)
}

function recoveryStatusText(status: 'idle' | 'interrupted' | 'retrying' | 'recovered' | 'failed'): string {
  switch (status) {
    case 'idle': return ''
    case 'interrupted': return '当前步骤已中断，请选择重试或安全回退。'
    case 'retrying': return '正在重新建立当前步骤，请稍候。'
    case 'recovered': return '当前步骤已恢复，可以继续会话。'
    case 'failed': return '恢复当前步骤失败，请重试或改用文字回答。'
  }
}

const STATUS_LABELS: Record<AppPhase, string> = {
  loading_config: '正在准备练习',
  idle: '准备开始',
  fetching_token: '正在连接麦克风',
  connecting_stt: '正在准备录音',
  waiting_user: '轮到你回答',
  recording: '正在听你说话',
  finalizing_transcript: '正在整理你的回答',
  confirming_transcript: '确认你的回答',
  requesting_llm: '正在等待相手回复',
  preparing_tts: '正在准备相手语音',
  playing_ai: '相手正在说话',
  round_complete: '本轮完成',
  session_complete: '会话完成',
  error: '需要处理',
}

const BACKGROUND_INTERRUPT_PHASES: readonly AppPhase[] = [
  'fetching_token',
  'connecting_stt',
  'recording',
  'finalizing_transcript',
  'requesting_llm',
  'preparing_tts',
  'playing_ai',
]
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

interface ListeningRequestState {
  loading: boolean
  error: string
}

const LISTENING_LEVEL_LABELS: Record<ListeningScaffoldLevel, string> = {
  0: '未查看帮助',
  1: '已重听',
  2: '已查看关键信息',
  3: '已查看日语台词',
  4: '已查看中文意图',
}

function nextListeningAction(level: ListeningScaffoldLevel): string | null {
  switch (level) {
    case 0: return '没听懂'
    case 1: return '查看关键信息'
    case 2: return '查看日语台词'
    case 3: return '查看中文意图'
    case 4: return null
  }
}




function MicIcon(): React.JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      aria-hidden="true"
    >
      <rect x="8" y="3" width="8" height="12" rx="4" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8" />
    </svg>
  )
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
  const [activeAssistState, setActiveAssistState] = useState<ActiveSpeechAssistState | null>(null)
  const [uiError, setUiError] = useState<UiError | null>(null)
  const [inlineError, setInlineError] = useState('')
  const [lastFailedStep, setLastFailedStep] = useState<'config' | 'scenario' | 'token' | 'stt' | 'llm' | 'tts' | null>(null)
  const pendingAssistEventRef = useRef<SpeechAssistEvent | null>(null)
  const [copyStatus, setCopyStatus] = useState('')
  const [pendingHistory, setPendingHistory] = useState<ConversationMessage[]>([])
  const requestAbortRef = useRef<AbortController | null>(null)
  const [customInputZh, setCustomInputZh] = useState('')
  const [clarifications, setClarifications] = useState<Array<{ questionZh: string; answerZh: string }>>([])
  const [pendingClarification, setPendingClarification] = useState<{ questionZh: string; optionsZh: readonly string[] } | null>(null)
  const [readyScenarioData, setReadyScenarioData] = useState<{ scenario: DynamicScenarioData; scenarioToken: string; practiceToken?: string } | null>(null)
  const [isDraftingScenario, setIsDraftingScenario] = useState(false)
  const [practiceHistory, setPracticeHistory] = useState<StoredPracticeAttempt[]>([])
  const [historyNotice, setHistoryNotice] = useState('')
  const [historySaving, setHistorySaving] = useState(false)
  const [historySaveFailed, setHistorySaveFailed] = useState(false)
  const historyWriteRef = useRef<Promise<void>>(Promise.resolve())
  const deletedPracticeSessionsRef = useRef(new Set<string>())
  const feedbackRequestVersionRef = useRef(0)
  const draftRequestRef = useRef<AbortController | null>(null)

  useEffect(() => {
    let active = true
    void listPracticeAttempts().then((attempts) => {
      if (active) setPracticeHistory(attempts)
    }).catch(() => {
      if (active) setHistoryNotice('无法读取本机历史，仍可开始新练习。')
    })
    return () => { active = false; draftRequestRef.current?.abort() }
  }, [])
  const [hintData, setHintData] = useState<HintResponse | null>(null)
  const [hintLevel, setHintLevel] = useState<0 | 1 | 2 | 3 | 4>(0)
  const [isLoadingHint, setIsLoadingHint] = useState(false)
  const [showHintSheet, setShowHintSheet] = useState(false)
  const [showGoalsSheet, setShowGoalsSheet] = useState(false)
  const [dockInputMode, setDockInputMode] = useState<'voice' | 'text'>('voice')
  const [dockTextValue, setDockTextValue] = useState('')

  const [feedbackData, setFeedbackData] = useState<ConversationFeedbackResponse | null>(null)
  const [feedbackStatus, setFeedbackStatus] = useState<FeedbackLoadingState>('idle')
  const [feedbackErrorMsg, setFeedbackErrorMsg] = useState('')
  const [redoRecords, setRedoRecords] = useState<RedoRecord[]>([])
  const feedbackFetchedRef = useRef(false)
  const [listeningLevels, setListeningLevels] = useState<Record<string, ListeningScaffoldLevel>>({})
  const [listeningRequestStates, setListeningRequestStates] = useState<Record<string, ListeningRequestState>>({})
  const phaseRef = useRef(phase)
  const messagesRef = useRef<ConversationMessage[]>([])
  const roundsRef = useRef<RoundRecord[]>([])
  const currentRoundRef = useRef<RoundRecord | null>(null)

  const sessionStartLockRef = useRef(false)
  const submitLockRef = useRef(false)

  const operationIdRef = useRef(0)
  const messageListRef = useRef<HTMLDivElement | null>(null)

  const sessionSnapshotRef = useRef<SessionSnapshot | null>(readSessionSnapshot())
  const chatBottomRef = useRef<HTMLDivElement | null>(null)
  const transcriptVersionRef = useRef(0)

  const lastAssistRequestAtRef = useRef(0)
  const lastAssistedVersionRef = useRef(0)
  const assistInFlightRef = useRef(false)
  const assistAbortControllerRef = useRef<AbortController | null>(null)
  const restoredTranscriptRef = useRef<TranscriptText | null>(null)
  const flushPendingAssistRef = useRef<(displayed: boolean, failureReason: SpeechAssistEvent['failureReason']) => void>(() => undefined)
  const listeningRequestsInFlightRef = useRef<Set<string>>(new Set())


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


  const abortSpeechAssist = useCallback((reason: SpeechAssistAbortReason) => {
    if (assistAbortControllerRef.current) {
      assistAbortControllerRef.current.abort(reason)
      assistAbortControllerRef.current = null
      assistInFlightRef.current = false
    }
    flushPendingAssistRef.current(false, 'aborted')
    setActiveAssistState(null)
  }, [])

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
  const flushPendingAssistEvent = useCallback((displayed: boolean, failureReason: SpeechAssistEvent['failureReason']) => {
    const pendingEvent = pendingAssistEventRef.current
    if (!pendingEvent) return
    pendingAssistEventRef.current = null
    touchRound((round) => {
      round.speechAssistEvents.push({
        ...pendingEvent,
        displayed,
        failureReason: displayed ? null : failureReason,
      })
    })
  }, [touchRound])
  useEffect(() => {
    flushPendingAssistRef.current = flushPendingAssistEvent
  }, [flushPendingAssistEvent])

  const voiceTurn = useVoiceTurnController({
    sttAvailable: Boolean(config?.elevenlabs.sttAvailable),
    sttModel: config?.elevenlabs.sttModel ?? '',
    online,
    phase,
    operation: operationCapability,
    transitionTo,
    touchRound,
    abortSpeechAssist,
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


  useEffect(() => {
    transcriptVersionRef.current = voiceTurn.meta.transcriptVersion
  }, [voiceTurn.meta.transcriptVersion])

  const activeAssistIsVisible = activeAssistState !== null
    && phase === 'recording'
    && activeAssistState.version === voiceTurn.meta.transcriptVersion

  useEffect(() => {
    if (!pendingAssistEventRef.current) return
    flushPendingAssistEvent(activeAssistIsVisible, activeAssistIsVisible ? null : 'stale_version')
  }, [activeAssistIsVisible, flushPendingAssistEvent])

  useEffect(() => {
    if (phase !== 'recording' || recordingUiStartedAt === null) return
    const now = Date.now()
    const fullTranscript = [confirmedTranscript.trim(), interimTranscript.trim()].filter(Boolean).join(' ') || partialTranscript.trim()
    const currentVersion = voiceTurn.meta.transcriptVersion
    const shouldTrigger = shouldTriggerSpeechAssist({
      isRecording: phaseRef.current === 'recording',
      transcript: fullTranscript,
      timeSinceLastSpeechSoundMs: now - (voiceTurn.meta.lastSpeechSoundAt ?? now),
      timeSinceLastPartialMs: now - (voiceTurn.meta.lastPartialAt ?? now),
      timeSinceLastRequestMs: now - lastAssistRequestAtRef.current,
      inFlight: assistInFlightRef.current,
      currentVersion,
      lastAssistedVersion: lastAssistedVersionRef.current,
    })

    if (shouldTrigger && scenario) {
      lastAssistedVersionRef.current = currentVersion
      lastAssistRequestAtRef.current = now
      assistInFlightRef.current = true

      const assistController = new AbortController()
      assistAbortControllerRef.current = assistController
      const timeoutId = window.setTimeout(() => {
        assistController.abort('timeout')
      }, ASSIST_TIMING.timeoutMs)

      const triggerTurn = turn
      const requestVersion = currentVersion
      const observedText = fullTranscript
      const startTime = Date.now()

      void (async () => {
        let assistEvent: SpeechAssistEvent | null = null
        try {
          const trailingSilenceMs = Math.min(10_000, Math.max(900, now - (voiceTurn.meta.lastSpeechSoundAt ?? now)))
          const lastAssistantTextJa = currentRoundRef.current?.aiPrompt || scenario.firstLine
          const res = await requestSpeechAssist({
            requestId: `sa_${crypto.randomUUID()}`,
            transcriptVersion: requestVersion,
            observedTextJa: observedText,
            lastAssistantTextJa,
            trailingSilenceMs,
            sessionToken: scenario.sessionToken,
            turn: triggerTurn,
          }, assistController.signal)

          const latencyMs = Date.now() - startTime
          const shouldDisplay = shouldDisplaySpeechAssistResult({
            isRecording: phaseRef.current === 'recording',
            requestVersion,
            currentVersion: transcriptVersionRef.current,
            isAborted: assistController.signal.aborted,
            timeSinceLastSpeechSoundMs: Date.now() - (voiceTurn.meta.lastSpeechSoundAt ?? 0),
          })
          assistEvent = {
            turn: triggerTurn,
            requestVersion,
            observedTextJa: observedText,
            cleanedObservedTextJa: res.cleanedObservedTextJa,
            continuationSuggestionJa: res.continuationSuggestionJa,
            displayed: false,
            latencyMs,
            failureReason: shouldDisplay ? null : assistController.signal.aborted ? 'aborted' : 'stale_version',
          }

          if (shouldDisplay) {
            pendingAssistEventRef.current = assistEvent
            assistEvent = null
            setActiveAssistState({
              version: requestVersion,
              observedTextJa: observedText,
              cleanedObservedTextJa: res.cleanedObservedTextJa,
              continuationSuggestionJa: res.continuationSuggestionJa,
            })
          }
        } catch (err) {
          const latencyMs = Date.now() - startTime
          const isTimeout = assistController.signal.aborted && assistController.signal.reason === 'timeout'
          const isAborted = assistController.signal.aborted && !isTimeout
          let failureReason: SpeechAssistEvent['failureReason'] = 'network_error'
          if (isTimeout) failureReason = 'timeout'
          else if (isAborted) failureReason = 'aborted'
          else if (err instanceof ApiError && err.status >= 500) failureReason = 'server_error'
          else if (err instanceof ApiError && err.status >= 400) failureReason = 'validation_error'

          assistEvent = {
            turn: triggerTurn,
            requestVersion,
            observedTextJa: observedText,
            cleanedObservedTextJa: null,
            continuationSuggestionJa: null,
            displayed: false,
            latencyMs,
            failureReason,
          }
        } finally {
          window.clearTimeout(timeoutId)
          if (assistAbortControllerRef.current === assistController) {
            assistAbortControllerRef.current = null
            assistInFlightRef.current = false
          }
          const completedEvent = assistEvent
          if (completedEvent) {
            touchRound((round) => {
              round.speechAssistEvents.push(completedEvent)
            })
          }
        }
      })()
    }
  }, [confirmedTranscript, interimTranscript, partialTranscript, phase, recordingUiStartedAt, scenario, touchRound, turn, voiceTurn.meta])
  const updateRoundByTurn = useCallback((targetTurn: number, update: (round: RoundRecord) => void) => {
    if (currentRoundRef.current?.turn === targetTurn) {
      touchRound(update)
      return
    }
    const next = roundsRef.current.map((round) => {
      if (round.turn !== targetTurn) return round
      const updated = structuredClone(round)
      update(updated)
      return updated
    })
    roundsRef.current = next
    setRounds(next)
  }, [touchRound])

  const setListeningLevelAtLeast = useCallback((messageId: string, level: ListeningScaffoldLevel) => {
    setListeningLevels((current) => {
      const existing = current[messageId] ?? 0
      return existing >= level ? current : { ...current, [messageId]: level }
    })
  }, [])

  const updateRoundListeningLevel = useCallback((targetTurn: number, level: ListeningScaffoldLevel, transcriptRevealed = false) => {
    updateRoundByTurn(targetTurn, (round) => {
      if (round.listeningScaffoldLevel < level) round.listeningScaffoldLevel = level
      if (transcriptRevealed) round.transcriptRevealed = true
    })
  }, [updateRoundByTurn])

  const cacheListeningScaffold = useCallback((messageId: string, scaffold: ListeningScaffoldResponse) => {
    const next = messagesRef.current.map((message) => message.id === messageId
      ? { ...message, listeningScaffold: scaffold }
      : message)
    replaceMessages(next)
  }, [replaceMessages])

  const getListeningLevel = useCallback((message: ConversationMessage): ListeningScaffoldLevel => {
    const tracked = listeningLevels[message.id] ?? 0
    const round = currentRoundView?.turn === message.turn
      ? currentRoundView
      : rounds.find((item) => item.turn === message.turn)
    const recorded = round?.listeningScaffoldLevel ?? 0
    const cached: ListeningScaffoldLevel = message.listeningScaffold ? 2 : 0
    let level = tracked
    if (recorded > level) level = recorded
    if (cached > level) level = cached
    return level
  }, [currentRoundView, listeningLevels, rounds])

  const replayPartnerMessage = useCallback((message: ConversationMessage) => {
    const isActiveMessage = activeAiMessageId === message.id
    if (isActiveMessage && pausedAiMessageId === message.id) {
      void resumeAiPlayback()
      return
    }
    if (isActiveMessage && aiTurn.meta.isTtsActionLocked) {
      pauseAiPlayback()
      return
    }
    if (aiTurn.meta.isTtsActionLocked) return
    setListeningLevelAtLeast(message.id, 1)
    updateRoundByTurn(message.turn, (round) => {
      round.ttsReplayCount += 1
      if (round.listeningScaffoldLevel < 1) round.listeningScaffoldLevel = 1
    })
    void playAiText(message.text, false, undefined, message.id)
  }, [activeAiMessageId, aiTurn.meta.isTtsActionLocked, pausedAiMessageId, pauseAiPlayback, playAiText, resumeAiPlayback, setListeningLevelAtLeast, updateRoundByTurn])

  const advanceListeningScaffold = useCallback(async (message: ConversationMessage) => {
    const level = getListeningLevel(message)
    if (level === 0) {
      replayPartnerMessage(message)
      return
    }
    if (level === 1) {
      if (message.listeningScaffold) {
        setListeningLevelAtLeast(message.id, 2)
        updateRoundListeningLevel(message.turn, 2)
        return
      }
      if (!scenario || listeningRequestsInFlightRef.current.has(message.id)) return
      listeningRequestsInFlightRef.current.add(message.id)
      setListeningRequestStates((current) => ({ ...current, [message.id]: { loading: true, error: '' } }))
      try {
        const scaffold = await requestListeningScaffold({
          scenarioType: 'dynamic',
          sessionToken: scenario.sessionToken,
          turn: message.turn,
          partnerPromptJa: message.text,
        })
        cacheListeningScaffold(message.id, scaffold)
        setListeningLevelAtLeast(message.id, 2)
        updateRoundListeningLevel(message.turn, 2)
        setListeningRequestStates((current) => ({ ...current, [message.id]: { loading: false, error: '' } }))
      } catch (error) {
        setListeningRequestStates((current) => ({
          ...current,
          [message.id]: {
            loading: false,
            error: error instanceof Error ? error.message : '关键信息获取失败，请重试。',
          },
        }))
      } finally {
        listeningRequestsInFlightRef.current.delete(message.id)
      }
      return
    }
    if (level === 2) {
      setListeningLevelAtLeast(message.id, 3)
      updateRoundListeningLevel(message.turn, 3, true)
      return
    }
    if (level === 3) {
      setListeningLevelAtLeast(message.id, 4)
      updateRoundListeningLevel(message.turn, 4)
    }
  }, [cacheListeningScaffold, getListeningLevel, replayPartnerMessage, scenario, setListeningLevelAtLeast, updateRoundListeningLevel])

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
        transitionTo('idle')
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
    if (sessionSnapshotRef.current) return
    if (!sessionId || !scenario || sessionStartedAt === null || sessionEndedAt !== null) {
      clearSessionSnapshot()
      return
    }
    const snapshot: SessionSnapshot = {
      version: 1,
      phase,
      sessionId,
      scenario,
      messages,
      rounds,
      currentRound: currentRoundView,
      turn,
      sessionStartedAt,
      transcript,
    }
    try {
      window.sessionStorage.setItem(SESSION_SNAPSHOT_KEY, JSON.stringify(snapshot))
    } catch {
      // sessionStorage 可能被浏览器策略或容量限制禁用；会话本身继续运行。
    }
  }, [currentRoundView, messages, phase, rounds, scenario, sessionEndedAt, sessionId, sessionStartedAt, transcript, turn])
  useEffect(() => {
    const interruptActiveSession = (code: 'offline' | 'background_interruption') => {
      const interruptedPhase = phaseRef.current
      const recoveryTarget = decideInterruptionRecovery(interruptedPhase)
      if (!recoveryTarget) return

      beginOperation()
      abortSpeechAssist(code === 'offline' ? 'offline' : 'background')
      if (recoveryTarget === 'llm' || recoveryTarget === 'tts') {
        aiTurn.actions.interruptPlaybackForBackground()
      }
      if (recoveryTarget === 'stt') {
        disposeVoiceTurn()
      }

      dispatchInterruptionRecovery({ type: 'interrupted', target: recoveryTarget })
      touchRound((round) => {
        round.failureCount += 1
      })
      setUiError({
        code,
        title: code === 'offline' ? '网络连接已中断' : '连接已在后台停止',
        message: code === 'offline' ? '当前步骤已停止。网络恢复后重试，或改用文字回答。' : '返回页面后请恢复当前步骤。',
        recovery: interruptedPhase === 'recording' ? 'text_input' : 'retry',
      })
      transitionTo('error')
    }

    const handleOnline = () => {
      setOnline(true)
      setAppForegroundNotice('网络已恢复，可以继续。')
    }
    const handleOffline = () => {
      setOnline(false)
      interruptActiveSession('offline')
    }
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden' && BACKGROUND_INTERRUPT_PHASES.includes(phaseRef.current)) {
        // 如果正在等待用户麦克风系统权限弹窗，切出属于正常系统弹窗遮挡/切换行为，不能误杀刚获取的流或判定失败
        if (!shouldTeardownOnVisibility(document.hidden)) {
          return
        }
        interruptActiveSession('background_interruption')
      } else if (document.visibilityState === 'visible') {
        setAppForegroundNotice('已回到页面，请确认当前状态后继续。')
      }
    }

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    document.addEventListener('visibilitychange', handleVisibility)
    window.addEventListener('pagehide', stopActiveResources)
    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener('pagehide', stopActiveResources)
      stopActiveResources()
    }
  }, [abortSpeechAssist, aiTurn.actions, beginOperation, disposeVoiceTurn, stopActiveResources, touchRound, transitionTo])


  const startSession = useCallback(async (scenarioToken: string) => {
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
    setRedoRecords([])
    setListeningLevels({})
    setListeningRequestStates({})
    replaceCurrentRound(null)
    setPendingHistory([])
    resetVoiceTurn()
    resetAiTurn()
    setUiError(null)
    setInlineError('')
    setCopyStatus('')
    feedbackRequestVersionRef.current++
    setFeedbackData(null)
    setFeedbackStatus('idle')
    setFeedbackErrorMsg('')
    feedbackFetchedRef.current = false
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
  }, [beginOperation, clearVoiceNotice, config, initFirstLine, isCurrentOperation, online, replaceCurrentRound, replaceMessages, resetAiTurn, resetVoiceTurn, syncMicrophoneReadiness, transitionTo, unlockAudio])
  const handleDraftScenario = useCallback(async (customPrompt?: string, clarificationsList?: Array<{ questionZh: string; answerZh: string }>, forceGen?: boolean) => {
    const text = customPrompt ?? customInputZh
    if (!text.trim()) return
    draftRequestRef.current?.abort()
    const controller = new AbortController()
    draftRequestRef.current = controller
    setIsDraftingScenario(true)
    setUiError(null)
    const list = clarificationsList ?? clarifications

    try {
      const res = await draftScenario(text.trim(), list, forceGen ?? false, AbortSignal.any([controller.signal, AbortSignal.timeout(25_000)]))
      if (controller.signal.aborted) return
      if (res.status === 'needs_clarification') {
        setPendingClarification({ questionZh: res.questionZh, optionsZh: res.optionsZh })
      } else {
        setPendingClarification(null)
        setReadyScenarioData({ scenario: res.scenario, scenarioToken: res.scenarioToken, practiceToken: res.practiceToken })
      }
    } catch (error) {
      if (controller.signal.aborted) return
      setUiError(toUiError(error))
      setLastFailedStep('scenario')
    } finally {
      if (draftRequestRef.current === controller) setIsDraftingScenario(false)
    }
  }, [clarifications, customInputZh])


  const handleAnswerClarification = useCallback((answerZh: string) => {
    if (!pendingClarification) return
    const next = [...clarifications, { questionZh: pendingClarification.questionZh, answerZh }]
    setClarifications(next)
    setPendingClarification(null)
    void handleDraftScenario(undefined, next, false)
  }, [clarifications, handleDraftScenario, pendingClarification])

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
    setIsLoadingHint(true)
    try {
      if (!scenario) return
      const res = await fetchHint(scenario, currentAiText, messagesRef.current)
      setHintData(res)
      setHintLevel(1)
      touchRound((round) => {
        if (round.expressionScaffoldLevel < 1) {
          round.expressionScaffoldLevel = 1
        }
      })
    } catch {
      setAppForegroundNotice('获取提示暂时失败，可继续自行回答。')
    } finally {
      setIsLoadingHint(false)
    }
  }, [currentAiText, hintData, hintLevel, scenario, touchRound])

  const endSession = useCallback((includeConfirmedCurrent: boolean) => {
    stopActiveResources()
    const activeRound = currentRoundRef.current
    if (includeConfirmedCurrent && activeRound?.userFinal) appendRound(activeRound)
    replaceCurrentRound(null)
    setSessionEndedAt(Date.now())
    setUiError(null)
    transitionTo('session_complete')
  }, [appendRound, replaceCurrentRound, stopActiveResources, transitionTo])

  const persistPractice = useCallback((attempt: PracticeAttempt) => {
    if (deletedPracticeSessionsRef.current.has(attempt.report.sessionId)) return Promise.resolve()
    setHistorySaving(true)
    setHistorySaveFailed(false)
    const pending = historyWriteRef.current.then(async () => {
      if (deletedPracticeSessionsRef.current.has(attempt.report.sessionId)) return
      await savePracticeAttempt(attempt)
      setPracticeHistory(await listPracticeAttempts())
      setHistorySaveFailed(false)
      setHistoryNotice('已保存到当前浏览器。')
    }).catch(() => {
      setHistorySaveFailed(true)
      setHistoryNotice('本次未保存到浏览器，请重试或导出训练报告。')
    }).finally(() => {
      if (historyWriteRef.current === pending) setHistorySaving(false)
    })
    historyWriteRef.current = pending
    return pending
  }, [])

  const fetchFeedback = useCallback(async () => {
    if (!scenario || roundsRef.current.length === 0) return
    const requestVersion = ++feedbackRequestVersionRef.current
    const completedReport = config && sessionStartedAt !== null && sessionEndedAt !== null
      ? buildSessionReport(sessionId, config.mode, scenario, sessionStartedAt, sessionEndedAt, roundsRef.current, redoRecords)
      : null
    setFeedbackStatus('loading')
    setFeedbackErrorMsg('')
    try {
      const res = await requestConversationFeedback(scenario, roundsRef.current)
      if (requestVersion !== feedbackRequestVersionRef.current) {
        if (completedReport && scenario.practiceToken) {
          await persistPractice({ scenario: scenario.dynamicData, practiceToken: scenario.practiceToken, report: completedReport, feedback: res })
        }
        return
      }
      setFeedbackData(res)
      setFeedbackStatus('success')
    } catch (error) {
      if (requestVersion !== feedbackRequestVersionRef.current) return
      setFeedbackStatus('error')
      setFeedbackErrorMsg(error instanceof Error ? error.message : '反馈生成失败，可点击重试。')
    }
  }, [config, persistPractice, redoRecords, scenario, sessionEndedAt, sessionId, sessionStartedAt])

  useEffect(() => {
    if (phase === 'session_complete' && !feedbackFetchedRef.current && scenario && roundsRef.current.length > 0) {
      feedbackFetchedRef.current = true
      void fetchFeedback()
    }
  }, [fetchFeedback, phase, scenario])


  const confirmTranscript = useCallback(async () => {
    const finalText = transcript.finalText.trim()
    if (!finalText) {
      setInlineError('回答为空。请再说一次、改用文字回答，或重新录制。')
      return
    }
    if (submitLockRef.current) return
    submitLockRef.current = true

    setInlineError('')
    const confirmedAt = Date.now()
    const transcriptSource = restoredTranscriptRef.current ?? transcript
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
    feedbackRequestVersionRef.current++
    setFeedbackData(null)
    setFeedbackStatus('idle')
    setFeedbackErrorMsg('')
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
    setRedoRecords([])
    setListeningLevels({})
    setListeningRequestStates({})
    setReadyScenarioData(null)
    setClarifications([])
    setPendingClarification(null)
    setHintData(null)
    setHintLevel(0)
    setShowHintSheet(false)
    setShowGoalsSheet(false)
    sessionStartLockRef.current = false
    submitLockRef.current = false
    transitionTo(config ? 'idle' : 'loading_config')
  }, [config, replaceCurrentRound, replaceMessages, resetAiTurn, resetVoiceTurn, stopActiveResources, syncMicrophoneReadiness, transitionTo])

  const report: SessionReport | null = useMemo(() => {
    if (!config || !scenario || !sessionId || sessionStartedAt === null || sessionEndedAt === null) return null
    return buildSessionReport(sessionId, config.mode, scenario, sessionStartedAt, sessionEndedAt, rounds, redoRecords)
  }, [config, redoRecords, rounds, scenario, sessionEndedAt, sessionId, sessionStartedAt])

  const currentPractice = useMemo<PracticeAttempt | null>(() => {
    if (!report || !scenario?.practiceToken || report.rounds.length === 0) return null
    return { scenario: scenario.dynamicData, practiceToken: scenario.practiceToken, report, feedback: feedbackData }
  }, [feedbackData, report, scenario])
  const practiceComparison = useMemo(() => currentPractice ? comparePracticeAttempts(currentPractice, practiceHistory) : null, [currentPractice, practiceHistory])
  const recentPractices = useMemo(() => {
    const seen = new Set<string>()
    return practiceHistory.filter((attempt) => {
      if (seen.has(attempt.scenarioKey)) return false
      seen.add(attempt.scenarioKey)
      return true
    })
  }, [practiceHistory])

  useEffect(() => {
    if (currentPractice) void persistPractice(currentPractice)
  }, [currentPractice, persistPractice])

  const preparePracticeAgain = useCallback(async (attempt: PracticeAttempt) => {
    if (!online || isDraftingScenario) return
    resetSession()
    setCustomInputZh(attempt.scenario.userGoal)
    draftRequestRef.current?.abort()
    const controller = new AbortController()
    draftRequestRef.current = controller
    setIsDraftingScenario(true)
    try {
      const ready = await restartPractice(attempt.practiceToken, AbortSignal.any([controller.signal, AbortSignal.timeout(25_000)]))
      if (!controller.signal.aborted) setReadyScenarioData(ready)
    } catch (error) {
      if (!controller.signal.aborted) {
        setUiError(toUiError(error))
        setHistoryNotice('原场景暂时无法载入，可从最近练过中重试。')
      }
    } finally {
      if (draftRequestRef.current === controller) setIsDraftingScenario(false)
    }
  }, [isDraftingScenario, online, resetSession])

  const removePractice = useCallback(async (attempt: StoredPracticeAttempt) => {
    if (!window.confirm(`删除“${attempt.scenario.titleZh}”及其全部本机练习记录？`)) return
    await historyWriteRef.current
    try {
      const deleted = practiceHistory.filter((item) => item.scenarioKey === attempt.scenarioKey).map((item) => item.report.sessionId)
      await deletePracticeScenario(attempt.scenarioKey)
      deleted.forEach((id) => deletedPracticeSessionsRef.current.add(id))
      setPracticeHistory(await listPracticeAttempts())
      setHistoryNotice('已删除该场景的本机练习记录。')
    } catch {
      setHistoryNotice('删除失败，练习记录仍保留，请重试。')
    }
  }, [practiceHistory])

  const copyReport = useCallback(async () => {
    if (!report) return
    await navigator.clipboard.writeText(JSON.stringify(report, null, 2))
    setCopyStatus('JSON 已复制')
  }, [report])
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
              onDraftScenario={handleDraftScenario}
              onAnswerClarification={handleAnswerClarification}
              onStartDynamic={(token) => void startSession(token)}
              onResetCustom={() => { setClarifications([]); setPendingClarification(null); setReadyScenarioData(null) }}
              recentPracticeSlot={<section className="practice-history" aria-label="本机练习历史">
              {recentPractices.length > 0 && <>
                <h2>最近练过</h2>
                <ul className="practice-history-list">{recentPractices.map((attempt) => (
                  <li key={attempt.scenarioKey}>
                    <button className="practice-history-open" type="button" disabled={isDraftingScenario || !online || phase === 'loading_config'} onClick={() => void preparePracticeAgain(attempt)}>
                      <strong>{attempt.scenario.titleZh}</strong>
                      <span>{new Date(attempt.report.startedAt).toLocaleDateString('zh-CN')} · {practiceHistory.filter((item) => item.scenarioKey === attempt.scenarioKey).length} 次练习</span>
                    </button>
                    <button className="text-button" type="button" disabled={isDraftingScenario || historySaving} onClick={() => void removePractice(attempt)} aria-label={`删除${attempt.scenario.titleZh}的练习记录`}>删除</button>
                  </li>
                ))}</ul>
              </>}
              {recentPractices.length > 0 && <p className="practice-storage-note">练习记录仅保存在当前浏览器，清理浏览器数据会删除记录。</p>}
              {historyNotice && <p role="status" className="practice-storage-note">{historyNotice}</p>}
            </section>}
            />

          </section>
        )}

        {phase === 'session_complete' && report && reveal && scenario && (
          <section className="conversation-panel" aria-labelledby="conversation-heading">
            <SessionComplete
              messages={messages}
              rounds={rounds}
              report={report}
              scenario={scenario}
              reveal={reveal}
              config={config}
              feedbackData={feedbackData}
              feedbackStatus={feedbackStatus}
              feedbackErrorMsg={feedbackErrorMsg}
              onRetryFeedback={() => void fetchFeedback()}
              copyStatus={copyStatus}
              onCopy={() => void copyReport()}
              onDownload={() => downloadReport(report)}
              onReplayAi={(text) => void playReviewAudio(text)}
              onStopAudio={stopAiPlayback}
              onSaveRedo={(record) => setRedoRecords((current) => [...current.filter((item) => item.turn !== record.turn), record])}
              onRequestRedo={requestRedoFeedback}
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

        {isSessionActive && (
          <section className="im-chat-app" aria-label="会话">
            {/* 顶部极简 IM 导航栏 */}
            <header className="im-top-bar">
              <div className="im-top-info">
                <div className="im-top-avatar" aria-hidden="true"><MessageCircle size={18} /></div>
                <div className="im-top-meta">
                  <h2 className="im-top-name" title={scenario?.dynamicData.aiRole ?? '相手'}>
                    {scenario?.dynamicData.aiRole ?? '相手'}
                  </h2>
                  <span className="im-top-status" aria-live="polite">
                    {STATUS_LABELS[phase]} · 第 {turn}/{scenario?.maxTurns ?? 5} 轮
                  </span>
                </div>
              </div>
              <div className="im-top-actions">
                <button
                  className={`im-icon-pill-btn ${showGoalsSheet ? 'is-active' : ''}`}
                  type="button"
                  onClick={() => setShowGoalsSheet((show) => !show)}
                  aria-label={sessionCoreGoal ? `查看会话目标：${sessionCoreGoal.titleZh}` : '查看会话目标'}
                >
                  <Target size={15} />
                  <span className="im-btn-text-full">目标</span>
                </button>
                <button
                  className="im-finish-pill-btn"
                  type="button"
                  onClick={() => endSession(true)}
                  disabled={controlsLocked}
                >
                  提前复盘
                </button>
              </div>
            </header>

            {/* 消息滚动主视口（自顶向下自然排列） */}
            <div className="im-message-viewport" ref={messageListRef}>
              {recoveryMessage && (
                <div className={`im-recovery-banner is-${interruptionRecovery.status}`} role="status" aria-live="polite">
                  <span>{recoveryMessage}</span>
                  {(interruptionRecovery.status === 'recovered' || interruptionRecovery.status === 'failed') && (
                    <button className="text-button" type="button" onClick={() => dispatchInterruptionRecovery({ type: 'reset' })}>关闭</button>
                  )}
                </div>
              )}
              {!online && <p className="im-notice-banner warning" role="status">网络已断开。恢复连接后可以继续。</p>}
              {effectiveForegroundNotice && (
                <div className="im-notice-banner info" role="status">
                  <span>{effectiveForegroundNotice}</span>
                  <button
                    className="text-button"
                    type="button"
                    onClick={() => {
                      setAppForegroundNotice('')
                      clearVoiceNotice()
                    }}
                  >
                    关闭
                  </button>
                </div>
              )}

              <div className="im-messages-list">
                {messages.map((message) => {
                  const isAssistant = message.role === 'assistant'
                  const listeningLevel = isAssistant ? getListeningLevel(message) : 0
                  const nextAction = isAssistant ? nextListeningAction(listeningLevel) : null
                  const requestState = listeningRequestStates[message.id]
                  const isActiveAudio = activeAiMessageId === message.id
                  const isPlayingThisAi = phase === 'playing_ai' && isActiveAudio
                  const isPreparingThisAi = phase === 'preparing_tts' && isActiveAudio
                  const hasPlayed = playedAiMessageIds.has(message.id)

                  return (
                    <div className={`im-message-item ${isAssistant ? 'is-ai' : 'is-user'}`} key={message.id}>
                      {isAssistant && (
                        <div className="im-sender-avatar" aria-hidden="true">
                          {scenario?.dynamicData ? <MessageCircle size={18} /> : 'AI'}
                        </div>
                      )}
                      <div className="im-msg-column">
                        {isAssistant ? (
                          <>
                            {/* 微信风格相手语音条 */}
                            <button
                              className={`im-voice-bubble ${isPlayingThisAi ? 'is-playing' : ''} ${isPreparingThisAi ? 'is-preparing' : ''} ${hasPlayed ? 'is-played' : 'is-unplayed'}`}
                              type="button"
                              onClick={() => replayPartnerMessage(message)}
                              aria-label={isActiveAudio && pausedAiMessageId === message.id ? '继续播放相手语音' : isPlayingThisAi ? '暂停相手语音' : hasPlayed ? '从头重听相手语音' : '播放相手语音'}
                            >
                              <span className="im-voice-unread-dot" aria-hidden="true" />
                              <span className="im-voice-icon-box"><span className="im-voice-waves" aria-hidden="true"><span /><span /><span /></span></span>
                              <span className="im-voice-duration">{Math.max(2, Math.round(message.text.length * 0.18))}″</span>
                              <span className="im-voice-status-tip" aria-live="polite">
                                {isActiveAudio && pausedAiMessageId === message.id ? '继续播放' : isPlayingThisAi ? '暂停' : isPreparingThisAi ? '载入中' : hasPlayed ? '从头重听' : '播放'}
                              </span>
                            </button>

                            <div className="im-listening-controls" aria-live="polite">
                              <span className="im-listening-level">{LISTENING_LEVEL_LABELS[listeningLevel]}</span>
                              {nextAction && (
                                <button
                                  className="im-voice-expand-toggle"
                                  type="button"
                                  disabled={requestState?.loading}
                                  onClick={() => void advanceListeningScaffold(message)}
                                >
                                  <span aria-hidden="true">+</span>
                                  {requestState?.loading ? '正在获取关键信息…' : nextAction}
                                </button>
                              )}
                            </div>
                            {requestState?.error && (
                              <p className="im-listening-error" role="alert">
                                {requestState.error} 未显示新帮助，可再次尝试。
                              </p>
                            )}
                            {listeningLevel >= 2 && message.listeningScaffold && (
                              <div className="im-listening-scaffold is-hint">
                                <strong>关键信息</strong>
                                <p>{message.listeningScaffold.keyInformationHintZh}</p>
                                <p className="im-listening-key-phrases" lang="ja">原文线索：{message.listeningScaffold.keyPhrasesJa.join(' / ')}</p>
                              </div>
                            )}
                            {listeningLevel >= 3 && (
                              <div className="im-expanded-transcript">
                                <strong>日语台词</strong>
                                <p lang="ja">{message.text}</p>
                              </div>
                            )}
                            {listeningLevel >= 4 && message.listeningScaffold && (
                              <div className="im-listening-scaffold is-intent">
                                <strong>这句话想表达</strong>
                                <p>{message.listeningScaffold.intentSummaryZh}</p>
                              </div>
                            )}
                          </>
                        ) : (
                          <div className="im-user-text-bubble">
                            <p lang="ja">{message.text}</p>
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}

                {/* 正在录音中的气泡 */}
                {!activeError && phase === 'recording' && (
                  <div className="im-message-item is-user">
                    <div className="im-msg-column">
                      <div className={`im-recording-bubble ${silenceCountdownSeconds !== null ? 'is-counting-down' : ''}`}>
                        <span className="im-recording-pulse-dot" aria-hidden="true" />
                        <div className="im-recording-info">
                          <strong aria-live="polite">
                            {silenceCountdownSeconds !== null
                              ? `停顿中，${silenceCountdownSeconds} 秒后结束`
                              : '正在录音中'}
                          </strong>
                          <span className="im-recording-transcript-row" lang="ja">
                            {activeAssistIsVisible && activeAssistState ? (
                              <span className="im-speech-assist-container">
                                <span className="im-assist-block im-assist-block-heard">
                                  <span className="im-assist-source-badge" aria-hidden="true">你的转写</span>
                                  <span className="im-transcript-live" aria-live="polite">
                                    {activeAssistState.cleanedObservedTextJa}
                                  </span>
                                  <span className="im-streaming-cursor" aria-hidden="true" />
                                </span>
                                {activeAssistState.continuationSuggestionJa && (
                                  <span className="im-assist-block im-assist-block-suggestion">
                                    <span className="im-assist-source-badge is-suggestion" aria-hidden="true">续说建议</span>
                                    <span
                                      className="im-speech-assist-suggestion"
                                      aria-label="续说建议"
                                    >
                                      {activeAssistState.continuationSuggestionJa}
                                    </span>
                                  </span>
                                )}
                              </span>
                            ) : confirmedTranscript.trim() || interimTranscript.trim() || partialTranscript.trim() ? (
                              <>
                                {confirmedTranscript.trim() && (
                                  <span className="im-transcript-live" aria-live="polite">
                                    {confirmedTranscript}
                                  </span>
                                )}
                                {confirmedTranscript.trim() && interimTranscript.trim() && ' '}
                                {interimTranscript.trim() ? (
                                  <span className="transcript-interim" aria-hidden="true">
                                    {interimTranscript}
                                  </span>
                                ) : !confirmedTranscript.trim() && partialTranscript.trim() ? (
                                  <span className="transcript-interim" aria-hidden="true">
                                    {partialTranscript}
                                  </span>
                                ) : null}
                                <span className="im-streaming-cursor" aria-hidden="true" />
                              </>
                            ) : (
                              <span className="im-transcript-placeholder">请说日语，说完点击结束</span>
                            )}
                          </span>
                        </div>
                        <time className="im-recording-time">
                          {formatRecordingTime(recordingSeconds)}
                        </time>
                      </div>
                    </div>
                  </div>
                )}

                {/* 错误提示卡片 */}
                {activeError && (
                  <div className="im-error-card" role="alert">
                    <strong><AlertCircle size={16} /> {activeError.title}</strong>
                    <p>{activeError.message}</p>
                  </div>
                )}
                <div ref={chatBottomRef} style={{ height: '1px' }} />
              </div>
            </div>

            {/* 单行极简 IM 底部控制栏 */}
            <footer className="im-bottom-dock" aria-label="操作栏">
              {activeError ? (
                <div className="im-action-row" style={{ width: '100%' }}>
                  {(activeError.recovery === 'text_input' || interruptionRecoveryAffordances.textInput) && <button className="secondary-button" type="button" onClick={recoveryTarget === 'stt' ? enterLifecycleTextInput : enterTextInput}>改用文字</button>}
                  {activeError.recovery === 'skip_tts' && <button className="secondary-button" type="button" onClick={skipFailedTts}>显示文字继续</button>}
                  {(activeError.recovery === 'retry' || activeFailedStep || interruptionRecoveryAffordances.retry) && online && <button className="primary-button" type="button" onClick={() => void retryFailedStep()}>重试</button>}
                  <button className="text-button" type="button" onClick={resetSession}>返回首页</button>
                </div>
              ) : (phase === 'waiting_user' || phase === 'round_complete') ? (
                <>
                  {/* 模式切换 (键盘 / 语音) */}
                  <button
                    className="im-dock-icon-btn"
                    type="button"
                    onClick={() => setDockInputMode((m) => m === 'voice' ? 'text' : 'voice')}
                    title={dockInputMode === 'voice' ? '切换为键盘打字' : '切换为语音输入'}
                  >
                    {dockInputMode === 'voice' ? <Keyboard size={18} /> : <Mic size={18} />}
                  </button>

                  {dockInputMode === 'voice' ? (
                    <button
                      className="im-dock-main-btn"
                      type="button"
                      onClick={() => void startRecording()}
                      disabled={!online}
                    >
                      <MicIcon />
                      <span>点击开始回答 (语音)</span>
                    </button>
                  ) : (
                    <form
                      className="im-dock-text-input-wrap"
                      onSubmit={(e) => {
                        e.preventDefault()
                        if (!dockTextValue.trim()) return
                        enterTextInput()
                        updateFinalText(dockTextValue.trim())
                        setDockTextValue('')
                        openTranscriptSheet()
                      }}
                    >
                      <input
                        className="im-dock-input"
                        type="text"
                        lang="ja"
                        placeholder="日本語で入力してください..."
                        value={dockTextValue}
                        onChange={(e) => setDockTextValue(e.target.value)}
                        autoFocus
                      />
                      <button
                        className="im-dock-send-btn"
                        type="submit"
                        disabled={!dockTextValue.trim()}
                      >
                        发送
                      </button>
                    </form>
                  )}

                  {/* 提示按钮 */}
                  <button
                    className="im-dock-icon-btn"
                    type="button"
                    onClick={() => {
                      if (!hintData) {
                        void handleRequestHint()
                      }
                      setShowHintSheet(true)
                    }}
                    title="不知道怎么说"
                    aria-label="不知道怎么说，查看表达帮助"
                  >
                    <Lightbulb size={18} />
                  </button>
                </>
              ) : phase === 'recording' ? (
                <div className="im-dock-row">
                  <button
                    className={`im-dock-main-btn is-recording ${silenceCountdownSeconds !== null ? 'is-counting-down' : ''}`}
                    type="button"
                    onClick={() => void stopRecording()}
                  >
                    <span className="im-dock-recording-indicator" aria-hidden="true">
                      {silenceCountdownSeconds ?? <Square size={14} fill="currentColor" />}
                    </span>
                    <span className="im-dock-recording-copy">
                      {silenceCountdownSeconds !== null ? '秒后自动结束，说话可继续' : '说完了，点击结束'}
                    </span>
                  </button>
                  <button
                    className="im-dock-icon-btn"
                    type="button"
                    onClick={enterTextInput}
                    title="放弃录音改用打字"
                  >
                    <Keyboard size={18} />
                  </button>
                </div>
              ) : phase === 'confirming_transcript' ? (
                <div style={{ display: 'flex', width: '100%', gap: '8px' }}>
                  <button
                    className="im-dock-main-btn"
                    type="button"
                    style={{ background: 'var(--butter)' }}
                    onClick={openTranscriptSheet}
                  >
                    <Pencil size={16} /> 检查/修改回答内容 <ArrowRight size={14} />
                  </button>
                </div>
              ) : (
                <div className="im-dock-working-bar">
                  <div className="im-dock-working-left">
                    <span className="pulse-dot" />
                    <span>{STATUS_LABELS[phase]}</span>
                  </div>
                  {(phase === 'preparing_tts' || phase === 'playing_ai') && (
                    <div className="im-working-actions-mini">
                      <button type="button" onClick={stopAiPlayback}>停止</button>
                    </div>
                  )}
                  {(phase === 'fetching_token' || phase === 'connecting_stt') && (
                    <div className="im-working-actions-mini">
                      <button type="button" onClick={enterTextInput}>改用文字</button>
                    </div>
                  )}
                </div>
              )}
            </footer>

            {/* ================================================================
                Bottom Sheet 1: 转写确认与编辑弹窗 (Bottom Sheet)
                ================================================================ */}
            {(showTranscriptSheet || phase === 'confirming_transcript') && (
              <div className="im-bottom-sheet-backdrop" onClick={closeTranscriptSheet}>
                <div className="im-bottom-sheet" onClick={(e) => e.stopPropagation()}>
                  <div className="im-sheet-drag-handle" />
                  <div className="im-sheet-header">
                    <h3 className="im-sheet-title">{manualInput ? '确认文字回答' : <><Mic size={18} /> 确认语音转写</>}</h3>
                    <button className="im-sheet-close-btn" type="button" onClick={closeTranscriptSheet}><X size={18} /></button>
                  </div>
                  <div className="im-sheet-content">
                    <label htmlFor="transcript-sheet-input" style={{ fontSize: '0.85rem', fontWeight: 700, display: 'block', marginBottom: '6px' }}>
                      回答内容（可直接修改）：
                    </label>
                    <textarea
                      id="transcript-sheet-input"
                      className="im-transcript-edit-area"
                      lang="ja"
                      rows={4}
                      maxLength={600}
                      value={transcript.finalText}
                      onChange={(e) => {
                        updateFinalText(e.target.value)
                        setInlineError('')
                      }}
                      placeholder="ここに日本語で入力してください..."
                      autoFocus
                    />
                    <div className="im-transcript-meta">
                      <span>{transcript.finalText.length} / 600 字</span>
                      {transcript.rawText && (
                        <button
                          className="im-raw-toggle-btn"
                          type="button"
                          onClick={toggleOriginalTranscript}
                        >
                          {showOriginalTranscript ? '隐藏识别原句' : '查看原识别'}
                        </button>
                      )}
                    </div>
                    {showOriginalTranscript && transcript.rawText && (
                      <div className="im-raw-text-panel">
                        <strong>原识别：</strong>{transcript.rawText}
                      </div>
                    )}
                    {inlineError && <p className="im-inline-error" role="alert">{inlineError}</p>}
                  </div>
                  <div className="im-sheet-footer">
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => {
                        closeTranscriptSheet()
                        void rerecord()
                      }}
                    >
                      <Mic size={18} /> 重录
                    </button>
                    <button
                      className="primary-button"
                      type="button"
                      disabled={!canConfirmTranscript}
                      onClick={() => {
                        closeTranscriptSheet()
                        void confirmTranscript()
                      }}
                    >
                      确认发送 <ArrowRight size={14} />
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* ================================================================
                Bottom Sheet 2: 表达提示弹窗 (Bottom Sheet)
                ================================================================ */}
            {showHintSheet && (
              <div className="im-bottom-sheet-backdrop" onClick={() => setShowHintSheet(false)}>
                <div className="im-bottom-sheet" onClick={(e) => e.stopPropagation()}>
                  <div className="im-sheet-drag-handle" />
                  <div className="im-sheet-header">
                    <h3 className="im-sheet-title"><Lightbulb size={18} /> 不知道怎么说</h3>
                    <button className="im-sheet-close-btn" type="button" onClick={() => setShowHintSheet(false)}><X size={18} /></button>
                  </div>
                  <div className="im-sheet-content">
                    {isLoadingHint && !hintData && (
                      <p style={{ textAlign: 'center', color: 'var(--muted)', padding: '20px 0' }}>正在设计提示...</p>
                    )}
                    {hintData && (
                      <>
                        <div className="im-hint-sheet-tier">
                          <strong>① 思考方向</strong>
                          <p style={{ margin: 0 }}>{hintData.directionZh}</p>
                        </div>
                        {hintLevel >= 2 && (
                          <div className="im-hint-sheet-tier">
                            <strong>② 核心词汇</strong>
                            <p style={{ margin: 0 }}>{hintData.keyPhrasesJa.join(' / ')}</p>
                          </div>
                        )}
                        {hintLevel >= 3 && (
                          <div className="im-hint-sheet-tier">
                            <strong>③ 句首参考</strong>
                            <p style={{ margin: 0 }} lang="ja">{hintData.sentenceStarterJa}</p>
                          </div>
                        )}
                        {hintLevel >= 4 && (
                          <div className="im-hint-sheet-tier">
                            <strong>④ 完整例句</strong>
                            <p style={{ margin: 0 }} lang="ja">{hintData.fullExampleJa}</p>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                  <div className="im-sheet-footer">
                    {hintLevel < 4 && hintData && (
                      <button
                        className="secondary-button"
                        type="button"
                        onClick={() => void handleRequestHint()}
                      >
                        再多给一点帮助 <ArrowRight size={14} />
                      </button>
                    )}
                    <button
                      className="primary-button"
                      type="button"
                      onClick={() => setShowHintSheet(false)}
                    >
                      明白了，去回答
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* ================================================================
                Bottom Sheet 3: 训练目标弹窗 (Bottom Sheet)
                ================================================================ */}
            {showGoalsSheet && scenario && sessionCoreGoal && (
              <div className="im-bottom-sheet-backdrop" onClick={() => setShowGoalsSheet(false)}>
                <div className="im-bottom-sheet" onClick={(e) => e.stopPropagation()}>
                  <div className="im-sheet-drag-handle" />
                  <div className="im-sheet-header">
                    <h3 className="im-sheet-title"><Target size={16} /> 场景目标：{scenario.dynamicData.titleZh}</h3>
                    <button className="im-sheet-close-btn" type="button" onClick={() => setShowGoalsSheet(false)}><X size={18} /></button>
                  </div>
                  <div className="im-sheet-content">
                    <p style={{ fontSize: '0.85rem', color: 'var(--muted)', marginTop: 0 }}>
                      {scenario.dynamicData.summaryZh}
                    </p>
                    <div style={{ marginTop: '12px' }}>
                      <h4 style={{ fontSize: '0.85rem', color: 'var(--ink)', marginBottom: '8px' }}>唯一目标：</h4>
                      <div className="im-goals-sheet-item is-core">
                        <h4>{sessionCoreGoal.titleZh}</h4>
                        <p>{sessionCoreGoal.descriptionZh}</p>
                      </div>
                    </div>
                  </div>
                  <div className="im-sheet-footer">
                    <button className="primary-button" type="button" onClick={() => setShowGoalsSheet(false)}>
                      关闭
                    </button>
                  </div>
                </div>
              </div>
            )}

          </section>
        )}
      </main>
    </div>
  )
}

interface HomeProps {
  loading: boolean
  ready: boolean
  online: boolean
  error: UiError | null
  sttAvailable: boolean
  sttModel: string
  customInputZh: string
  setCustomInputZh: React.Dispatch<React.SetStateAction<string>>
  clarifications: Array<{ questionZh: string; answerZh: string }>
  pendingClarification: { questionZh: string; optionsZh: readonly string[] } | null
  readyScenarioData: { scenario: DynamicScenarioData; scenarioToken: string } | null
  isDraftingScenario: boolean
  onDraftScenario: (prompt?: string, clarifications?: Array<{ questionZh: string; answerZh: string }>, force?: boolean) => void
  onAnswerClarification: (answer: string) => void
  onStartDynamic: (scenarioToken: string) => void
  onResetCustom: () => void
  recentPracticeSlot?: React.ReactNode
}

function Home({
  loading, ready, online, error, sttAvailable, sttModel, customInputZh, setCustomInputZh,
  clarifications, pendingClarification, readyScenarioData, isDraftingScenario,
  onDraftScenario, onAnswerClarification, onStartDynamic, onResetCustom, recentPracticeSlot,
}: HomeProps): React.JSX.Element {
  const [clarificationInput, setClarificationInput] = useState('')
  const [examples, setExamples] = useState(() => drawPracticeExamples())
  const topicInputRef = useRef<HTMLTextAreaElement>(null)
  const [homeSttState, setHomeSttState] = useState<'idle' | 'connecting' | 'recording' | 'stopping'>('idle')
  const [homeSttText, setHomeSttText] = useState('')
  const [homeSttError, setHomeSttError] = useState('')
  const homeSttRef = useRef<RealtimeSttSession | null>(null)
  const homeSttGenerationRef = useRef(0)
  const busy = loading || isDraftingScenario
  const unavailable = busy || !ready || !online

  const cancelHomeStt = useCallback(() => {
    homeSttGenerationRef.current += 1
    homeSttRef.current?.close()
    homeSttRef.current = null
    releaseMicrophoneStream()
    setHomeSttText('')
    setHomeSttState('idle')
  }, [])

  useEffect(() => cancelHomeStt, [cancelHomeStt])

  useEffect(() => {
    const stopForPageExit = () => cancelHomeStt()
    const stopForBackground = () => {
      if (document.visibilityState === 'hidden') cancelHomeStt()
    }
    window.addEventListener('pagehide', stopForPageExit)
    document.addEventListener('visibilitychange', stopForBackground)
    return () => {
      window.removeEventListener('pagehide', stopForPageExit)
      document.removeEventListener('visibilitychange', stopForBackground)
    }
  }, [cancelHomeStt])

  useEffect(() => {
    if (shouldCancelHomeSttForTransition(Boolean(readyScenarioData), Boolean(pendingClarification), busy)) cancelHomeStt()
  }, [busy, cancelHomeStt, pendingClarification, readyScenarioData])
  const startHomeStt = useCallback(async () => {
    if (!sttAvailable || !sttModel || homeSttState !== 'idle' || readyScenarioData || pendingClarification || busy) return
    const generation = ++homeSttGenerationRef.current
    const session = new RealtimeSttSession()
    homeSttRef.current = session
    setHomeSttError('')
    setHomeSttText('')
    setHomeSttState('connecting')
    try {
      const token = await requestElevenLabsToken('realtime_scribe')
      if (generation !== homeSttGenerationRef.current) return
      await session.start(token, sttModel, {
        onPartial: (text) => {
          if (shouldApplyHomeSttResult(generation, homeSttGenerationRef.current, document.hidden)) setHomeSttText(text)
        },
        onConnectionState: (state) => {
          if (state === 'connected' && shouldApplyHomeSttResult(generation, homeSttGenerationRef.current, document.hidden)) setHomeSttState('recording')
        },
        onAudioLevel: () => undefined,
      }, 'zh')
    } catch (error) {
      if (shouldApplyHomeSttResult(generation, homeSttGenerationRef.current, document.hidden)) {
        setHomeSttError(error instanceof Error ? error.message : '中文识别暂时无法启动，请改为输入文字。')
        cancelHomeStt()
      }
    }
  }, [busy, cancelHomeStt, homeSttState, pendingClarification, readyScenarioData, sttAvailable, sttModel])

  const stopHomeStt = useCallback(async () => {
    const session = homeSttRef.current
    const generation = homeSttGenerationRef.current
    if (!session || homeSttState !== 'recording') return
    setHomeSttState('stopping')
    try {
      const recognized = await session.stop()
      if (shouldApplyHomeSttResult(generation, homeSttGenerationRef.current, document.hidden) && recognized.trim()) {
        setCustomInputZh((current) => {
          const merged = appendHomeSttText(current, recognized)
          if (!merged.applied) setHomeSttError('输入框已接近 300 字，未写入本次识别结果；原有内容已保留。')
          return merged.text
        })
      }
    } catch (error) {
      if (shouldApplyHomeSttResult(generation, homeSttGenerationRef.current, document.hidden)) {
        setHomeSttError(error instanceof Error ? error.message : '中文识别失败，已保留原有内容。')
      }
    } finally {
      if (generation === homeSttGenerationRef.current) cancelHomeStt()
    }
  }, [cancelHomeStt, homeSttState, setCustomInputZh])


  return (
    <div className="intro-block home-launch-layout">
      <header className="home-header">
        <h1 id="conversation-heading">今天想练哪段日语对话？</h1>
        <p className="home-subtitle">写下一个场景，或一件你想说清楚的事。</p>
      </header>
      {error && <div className="error-panel" role="alert"><div><p className="error-title">{error.title}</p><p>{error.message}</p></div></div>}
      {readyScenarioData ? (
        <section className="ready-scenario-card" aria-labelledby="ready-scenario-title">
          <p className="ready-badge">准备好了</p>
          <h2 id="ready-scenario-title">{readyScenarioData.scenario.titleZh}</h2>
          <p className="ready-desc">{readyScenarioData.scenario.summaryZh}</p>
          <div className="ready-meta">
            <p><strong>你是：</strong>{readyScenarioData.scenario.userRole}</p>
            <p><strong>对方是：</strong>{readyScenarioData.scenario.aiRole}</p>
          </div>
          <div className="ready-goal"><strong>这次想做到</strong><p>{readyScenarioData.scenario.coreGoal.descriptionZh}</p></div>
          <div className="ready-actions">
            <button className="primary-button" type="button" onClick={() => { cancelHomeStt(); onStartDynamic(readyScenarioData.scenarioToken) }} disabled={unavailable}>开始对话 <ArrowRight size={18} aria-hidden="true" /></button>
            <button className="text-button" type="button" onClick={() => { cancelHomeStt(); onResetCustom() }} disabled={busy}>修改描述</button>
          </div>
          <p className="session-length">最多五轮，也可随时提前复盘。</p>
        </section>
      ) : (
        <>
          <form className="custom-scenario-box" aria-busy={isDraftingScenario} onSubmit={(event) => { event.preventDefault(); if (!unavailable && customInputZh.trim() && !pendingClarification) { cancelHomeStt(); onDraftScenario() } }}>
            <label className="visually-hidden" htmlFor="custom-topic-input">想练习的场景</label>
            <textarea ref={topicInputRef} id="custom-topic-input" className="custom-textarea" rows={3} maxLength={300} aria-describedby="topic-help topic-count" placeholder="比如：明天去剪头发，想说明剪短一点，但不要露出额头。" value={customInputZh} disabled={busy || Boolean(pendingClarification)} onChange={(event) => setCustomInputZh(event.target.value)} />
            <div className="topic-footer">
              <span id="topic-count" className="char-count">{customInputZh.length} / 300</span>
              <div className="topic-actions">
                {sttAvailable && <button className="text-button" type="button" disabled={busy || !online || Boolean(pendingClarification) || homeSttState === 'stopping'} onClick={() => void (homeSttState === 'connecting' ? cancelHomeStt() : homeSttState === 'idle' ? startHomeStt() : stopHomeStt())}><Mic size={16} aria-hidden="true" /> {homeSttState === 'idle' ? '中文语音输入' : homeSttState === 'connecting' ? '正在连接，取消' : homeSttState === 'stopping' ? '正在填入输入框…' : '说完了，填入输入框'}</button>}
                {!pendingClarification && <button className="primary-button" type="submit" disabled={!customInputZh.trim() || unavailable}>{isDraftingScenario ? '正在准备…' : '准备练习'} <ArrowRight size={18} aria-hidden="true" /></button>}
              </div>
            </div>
            {(homeSttState !== 'idle' || homeSttText || homeSttError) && <div className="topic-stt-status" role={homeSttError ? 'alert' : 'status'}>{homeSttError || (homeSttState === 'connecting' ? '正在连接中文语音识别…' : homeSttState === 'stopping' ? '正在整理识别结果…' : homeSttText || '正在听你说话…')}</div>}
            {pendingClarification && (
              <div className="clarification-panel">
                <p className="clarification-question" id="clarification-question">{pendingClarification.questionZh}</p>
                <div className="clarification-options">{pendingClarification.optionsZh.map((option) => <button key={option} className="secondary-button clarify-opt-btn" type="button" disabled={unavailable} onClick={() => { cancelHomeStt(); onAnswerClarification(option) }}>{option}</button>)}</div>
                <div className="clarify-custom-row">
                  <input className="clarify-input" aria-labelledby="clarification-question" value={clarificationInput} maxLength={300} disabled={unavailable} onChange={(event) => setClarificationInput(event.target.value)} placeholder="或者自己补充" />
                  <button className="secondary-button" type="button" disabled={!clarificationInput.trim() || unavailable} onClick={() => { cancelHomeStt(); onAnswerClarification(clarificationInput.trim()); setClarificationInput('') }}>提交</button>
                </div>
                <button className="text-button skip-clarify-btn" type="button" disabled={unavailable} onClick={() => { cancelHomeStt(); onDraftScenario(customInputZh, clarifications, true) }}>跳过，直接准备</button>
              </div>
            )}
          </form>
          <p id="topic-help" className="topic-help">中文描述即可，只写“美容院”也可以。</p>
          {recentPracticeSlot}
          {!pendingClarification && <section className="practice-examples" aria-labelledby="practice-examples-heading">
            <div className="examples-heading"><h2 id="practice-examples-heading">从一个场景开始</h2><button className="text-button" type="button" disabled={busy} onClick={() => setExamples(drawPracticeExamples(examples.map((example) => example.id)))}>换一组</button></div>
            <ul>{examples.map((example) => <li key={example.id}><button className="practice-example" type="button" disabled={busy} onClick={() => { setCustomInputZh(buildSparkPrompt(example)); topicInputRef.current?.focus() }}><span><strong>{example.challengeZh}</strong><small>{example.titleZh} · {example.domainZh}</small></span><ArrowRight size={18} aria-hidden="true" /></button></li>)}</ul>
          </section>}
        </>
      )}
    </div>
  )
}


interface SessionCompleteProps {
  messages: ConversationMessage[]
  rounds: RoundRecord[]
  report: SessionReport
  scenario: SessionScenario
  reveal: SessionScenario['reveal']
  config: PrototypeConfig | null
  feedbackData: ConversationFeedbackResponse | null
  feedbackStatus: FeedbackLoadingState
  feedbackErrorMsg: string
  onRetryFeedback: () => void
  copyStatus: string
  onCopy: () => void
  onDownload: () => void
  onReplayAi: (text: string) => void
  onStopAudio: () => void
  onSaveRedo: (record: RedoRecord) => void
  onRequestRedo: typeof requestRedoFeedback
  onRequestListeningScaffold: typeof requestListeningScaffold
  onCacheListeningScaffold: (messageId: string, scaffold: ListeningScaffoldResponse) => void
  onNewScenario: () => void
  audioNotice: string
  practiceComparison: ReturnType<typeof comparePracticeAttempts> | null
  onRepeatScenario?: () => void
  historyNotice: string
  onRetrySave?: () => void
}

function SessionComplete({
  messages,
  rounds,
  report,
  scenario,
  reveal,
  config,
  feedbackData,
  feedbackStatus,
  feedbackErrorMsg,
  onRetryFeedback,
  copyStatus,
  onCopy,
  onDownload,
  onReplayAi,
  onStopAudio,
  onSaveRedo,
  onRequestRedo,
  onRequestListeningScaffold,
  onCacheListeningScaffold,
  onNewScenario,
  audioNotice,
  practiceComparison,
  onRepeatScenario,
  historyNotice,
  onRetrySave,
}: SessionCompleteProps): React.JSX.Element {
  const [redoState, setRedoState] = useState<'idle' | 'ready' | 'recording' | 'confirming' | 'loading' | 'complete'>('idle')
  const [redoTranscript, setRedoTranscript] = useState('')
  const [redoInputMode, setRedoInputMode] = useState<'stt' | 'text'>('stt')
  const [redoListeningLevel, setRedoListeningLevel] = useState<ListeningScaffoldLevel>(0)
  const [redoExpressionLevel, setRedoExpressionLevel] = useState<0 | 1 | 2 | 3 | 4>(0)
  const [redoResult, setRedoResult] = useState<{ comparisonZh: string; referenceExpressionJa: string } | null>(null)
  const [redoError, setRedoError] = useState('')
  const [redoScaffold, setRedoScaffold] = useState<ListeningScaffoldResponse | null>(null)
  const [redoScaffoldLoading, setRedoScaffoldLoading] = useState(false)
  const [redoScaffoldError, setRedoScaffoldError] = useState('')
  const redoSttRef = useRef<RealtimeSttSession | null>(null)
  const redoScaffoldRequestInFlightRef = useRef(false)

  useEffect(() => () => redoSttRef.current?.close(), [])
  const redoAssistantMessage = feedbackData
    ? messages.find((message) => message.role === 'assistant' && message.turn === feedbackData.redoTask.turn)
    : undefined
  const effectiveRedoScaffold = redoScaffold ?? redoAssistantMessage?.listeningScaffold ?? null


  const startRedo = () => {
    if (!feedbackData) return
    onStopAudio()
    redoSttRef.current?.close()
    setRedoState('ready')
    setRedoInputMode('stt')
    setRedoListeningLevel(1)
    setRedoExpressionLevel(0)
    setRedoResult(null)
    setRedoError('')
    setRedoScaffold(redoAssistantMessage?.listeningScaffold ?? null)
    setRedoScaffoldLoading(false)
    setRedoScaffoldError('')
    onReplayAi(feedbackData.redoTask.partnerPromptJa)
  }

  const advanceRedoListeningScaffold = async () => {
    if (!feedbackData || redoScaffoldRequestInFlightRef.current) return
    if (redoListeningLevel === 0) {
      setRedoListeningLevel(1)
      onReplayAi(feedbackData.redoTask.partnerPromptJa)
      return
    }
    if (redoListeningLevel === 1) {
      if (effectiveRedoScaffold) {
        setRedoListeningLevel(2)
        setRedoScaffoldError('')
        return
      }
      setRedoScaffoldLoading(true)
      setRedoScaffoldError('')
      redoScaffoldRequestInFlightRef.current = true
      try {
        const scaffold = await onRequestListeningScaffold({
          scenarioType: 'dynamic',
          sessionToken: scenario.sessionToken,
          turn: feedbackData.redoTask.turn,
          partnerPromptJa: feedbackData.redoTask.partnerPromptJa,
        })
        setRedoScaffold(scaffold)
        setRedoListeningLevel(2)
        if (redoAssistantMessage) onCacheListeningScaffold(redoAssistantMessage.id, scaffold)
      } catch (error) {
        setRedoScaffoldError(error instanceof Error ? error.message : '关键信息获取失败，请重试。')
      } finally {
        redoScaffoldRequestInFlightRef.current = false
        setRedoScaffoldLoading(false)
      }
      return
    }
    if (redoListeningLevel === 2) {
      setRedoListeningLevel(3)
      return
    }
    if (redoListeningLevel === 3) setRedoListeningLevel(4)
   }

  const startRedoRecording = async () => {
    setRedoError('')
    if (!config?.elevenlabs.sttAvailable) {
      setRedoInputMode('text')
      setRedoState('confirming')
      return
    }
    try {
      const token = await requestElevenLabsToken('realtime_scribe')
      const session = new RealtimeSttSession()
      redoSttRef.current = session
      setRedoTranscript('')
      setRedoState('recording')
      await session.start(token, config.elevenlabs.sttModel, {
        onPartial: setRedoTranscript,
        onConnectionState: () => {},
        onAudioLevel: () => {},
      })
    } catch (error) {
      redoSttRef.current?.close()
      redoSttRef.current = null
      setRedoInputMode('text')
      setRedoState('confirming')
      setRedoError(error instanceof Error ? error.message : '麦克风不可用，已切换为文字输入。')
    }
  }

  const stopRedoRecording = async () => {
    const session = redoSttRef.current
    if (!session) return
    try {
      const rawText = await session.stop()
      setRedoTranscript(cleanTranscript(rawText).cleanedText)
    } finally {
      session.close()
      if (redoSttRef.current === session) redoSttRef.current = null
      setRedoState('confirming')
    }
  }

  const confirmRedo = async () => {
    if (!feedbackData || !redoTranscript.trim()) {
      setRedoError('回答不能为空，请修改或重新录音。')
      return
    }
    setRedoState('loading')
    setRedoError('')
    try {
      const result = await onRequestRedo({
        scenarioType: 'dynamic',
        sessionToken: scenario.sessionToken,
        turn: feedbackData.redoTask.turn,
        partnerPromptJa: feedbackData.redoTask.partnerPromptJa,
        firstConfirmedJa: feedbackData.redoTask.firstConfirmedJa,
        secondConfirmedJa: redoTranscript.trim(),
        secondInputMode: redoInputMode,
        secondListeningScaffoldLevel: redoListeningLevel,
        secondExpressionScaffoldLevel: redoExpressionLevel,
      })
      setRedoResult(result)
      setRedoState('complete')
      onSaveRedo({
        turn: feedbackData.redoTask.turn,
        partnerPromptJa: feedbackData.redoTask.partnerPromptJa,
        firstConfirmedJa: feedbackData.redoTask.firstConfirmedJa,
        secondConfirmedJa: redoTranscript.trim(),
        inputMode: redoInputMode,
        listeningScaffoldLevel: redoListeningLevel,
        expressionScaffoldLevel: redoExpressionLevel,
        comparisonZh: result.comparisonZh,
        referenceExpressionJa: result.referenceExpressionJa,
      })
    } catch (error) {
      setRedoState('confirming')
      setRedoError(error instanceof Error ? error.message : '重做反馈生成失败，请重试。')
    }
  }

  const outcomeLabel: Record<ConversationFeedbackResponse['outcome'], string> = {
    completed: '目标完成',
    partial: '部分完成',
    not_completed: '目标未完成',
    insufficient_evidence: '证据不足',
  }

  return (
    <div className="complete-view">
      <p className="brand-mark">复盘</p>
      <h1 id="conversation-heading">{reveal.titleZh}</h1>
      <p className="reveal-summary">{reveal.summaryZh}</p>
      {audioNotice && <p className="network-notice" role="status">{audioNotice}</p>}
      {practiceComparison && feedbackStatus === 'success' && <section className="practice-comparison" aria-labelledby="practice-comparison-heading">
        <h2 id="practice-comparison-heading">本场景表现</h2>
        {practiceComparison.current.validEvaluation ? <>
          <p>{practiceComparison.baselineAttempt
            ? `与 ${new Date(practiceComparison.baselineAttempt.report.startedAt).toLocaleDateString('zh-CN')} 的首次完整有效练习比较。`
            : report.completion.closedNaturally ? '已记录本次表现。再次完整练习同一场景后，可与首次有效记录比较。' : '本次提前结束，仅展示已观察到的表现。'}</p>
          <details className="practice-details">
            <summary>查看详细统计</summary>
            <table className="practice-comparison-table">
              <thead><tr><th scope="col">沟通证据点</th>{practiceComparison.baseline && <th scope="col">首次</th>}<th scope="col">本次</th></tr></thead>
              <tbody>
                <tr><th scope="row">已完成</th>{practiceComparison.baseline && <td>{practiceComparison.baseline.completed}/{practiceComparison.baseline.total}</td>}<td>{practiceComparison.current.completed}/{practiceComparison.current.total}</td></tr>
                <tr><th scope="row">听力未查看帮助</th>{practiceComparison.baseline && <td>{practiceComparison.baseline.listeningIndependent}</td>}<td>{practiceComparison.current.listeningIndependent}</td></tr>
                <tr><th scope="row">表达未查看帮助</th>{practiceComparison.baseline && <td>{practiceComparison.baseline.expressionIndependent}</td>}<td>{practiceComparison.current.expressionIndependent}</td></tr>
                <tr><th scope="row">独立性证据不足</th>{practiceComparison.baseline && <td>{practiceComparison.baseline.independenceUnknown}</td>}<td>{practiceComparison.current.independenceUnknown}</td></tr>
              </tbody>
            </table>
            <p className="practice-storage-note">帮助统计仅针对已完成的证据点。编辑、重录、文字输入、音频证据缺失，或无法排除先前表达帮助的影响时，独立性保留为证据不足。</p>
            <p className="practice-storage-note">本次未观察 {practiceComparison.current.notObserved} 项，完成情况证据不足 {practiceComparison.current.insufficientEvidence} 项。原场景复练反映熟练情况，不代表整体日语水平。</p>
          </details>
        </> : <p>本次缺少可比较的评价证据，保留对话事实与复盘。</p>}
        {scenario.dynamicData.evidencePoints && feedbackData?.evidenceResults && <ul className="practice-evidence-list">
          {scenario.dynamicData.evidencePoints.map((point) => {
            const result = feedbackData.evidenceResults?.find((item) => item.pointId === point.id)
            const labels = { completed: '已完成', not_completed: '未完成', not_observed: '未观察', insufficient_evidence: '证据不足' }
            return <li key={point.id}><strong>{point.titleZh}</strong><span>{result ? labels[result.status] : '证据不足'}</span>
              {result?.evidence.map((item, index) => <p key={`${item.turn}-${index}`} lang="ja">第 {item.turn} 轮：「{item.quoteJa}」</p>)}
            </li>
          })}
        </ul>}
      </section>}

      {feedbackStatus === 'loading' && <div className="feedback-loading-card"><span className="pulse-dot" /><p>正在整理本场反馈...</p></div>}
      {feedbackStatus === 'error' && <div className="feedback-error-card" role="alert"><p>{feedbackErrorMsg}</p><button className="primary-button" type="button" onClick={onRetryFeedback}>重新生成</button></div>}
      {feedbackStatus === 'success' && feedbackData && (
        <div className="feedback-content">
          <section className="feedback-section goal-summary-card"><h2>这次收获</h2><p><strong>{outcomeLabel[feedbackData.outcome]}</strong></p></section>
          <section className="feedback-section"><h2>做到这一点的证据</h2><p>{feedbackData.outcomeEvidenceZh}</p></section>
          <section className="feedback-section"><h2>听力收获</h2>{feedbackData.listeningFinding ? <><p>第 {feedbackData.listeningFinding.turn} 轮：{feedbackData.listeningFinding.findingZh}</p><p>{feedbackData.listeningFinding.evidenceZh}</p></> : <p>本场没有足够证据形成听力发现。</p>}</section>
          <section className="feedback-section"><h2>下次可以这样说</h2>{feedbackData.expressionImprovement ? <><p lang="ja">{feedbackData.expressionImprovement.userConfirmedJa}</p><p lang="ja">建议：{feedbackData.expressionImprovement.suggestedJa}</p><p>{feedbackData.expressionImprovement.reasonZh}</p></> : <p>本场没有必须改写的表达。</p>}</section>
          <section className="feedback-section retry-task-card">
            <h2>再练一个关键回合</h2>
            <p lang="ja"><strong>这次回答：</strong>{feedbackData.redoTask.firstConfirmedJa}</p>
            {redoState === 'idle' && <div className="retry-actions"><button className="primary-button" type="button" onClick={startRedo}><Volume2 size={16} /> 再练这个回合</button></div>}
            {redoState === 'ready' && <div className="retry-actions"><button className="primary-button" type="button" onClick={() => void startRedoRecording()}><Mic size={16} /> 开始回答</button><button className="text-button" type="button" onClick={() => { setRedoInputMode('text'); setRedoState('confirming') }}>改用文字</button></div>}
            {(redoState === 'ready' || redoState === 'recording' || redoState === 'confirming') && (
              <div className="retry-scaffold" aria-live="polite">
                <div className="retry-scaffold-status">
                  <strong>{LISTENING_LEVEL_LABELS[redoListeningLevel]}</strong>
                  <span>{nextListeningAction(redoListeningLevel) ?? '已显示全部帮助'}</span>
                </div>
                <div className="retry-actions">
                  <button className="text-button" type="button" onClick={() => { onReplayAi(feedbackData.redoTask.partnerPromptJa); setRedoListeningLevel((level) => level < 1 ? 1 : level) }}>从头重听</button>
                  {nextListeningAction(redoListeningLevel) && redoListeningLevel > 0 && (
                    <button className="secondary-button" type="button" disabled={redoScaffoldLoading} onClick={() => void advanceRedoListeningScaffold()}>
                      {redoScaffoldLoading ? '正在获取关键信息…' : nextListeningAction(redoListeningLevel)}
                    </button>
                  )}
                  <button className="text-button" type="button" onClick={() => setRedoExpressionLevel((level) => level === 4 ? 4 : (level + 1) as 1 | 2 | 3 | 4)}>再多给一点表达帮助</button>
                </div>
                {redoScaffoldError && <p className="im-listening-error" role="alert">{redoScaffoldError} 未显示新帮助，可重试。</p>}
                {redoListeningLevel >= 2 && effectiveRedoScaffold && (
                  <div className="retry-scaffold-reveal is-hint">
                    <strong>关键信息</strong>
                    <p>{effectiveRedoScaffold.keyInformationHintZh}</p>
                    <p lang="ja">原文线索：{effectiveRedoScaffold.keyPhrasesJa.join(' / ')}</p>
                  </div>
                )}
                {redoListeningLevel >= 3 && (
                  <div className="retry-scaffold-reveal">
                    <strong>日语台词</strong>
                    <p lang="ja">{feedbackData.redoTask.partnerPromptJa}</p>
                  </div>
                )}
                {redoListeningLevel >= 4 && effectiveRedoScaffold && (
                  <div className="retry-scaffold-reveal is-intent">
                    <strong>这句话想表达</strong>
                    <p>{effectiveRedoScaffold.intentSummaryZh}</p>
                  </div>
                )}
              </div>
            )}
            {redoState === 'recording' && <div className="retry-recording-panel"><p lang="ja">{redoTranscript || '请开始说话'}</p><button className="primary-button" type="button" onClick={() => void stopRedoRecording()}>说完了，确认转写</button></div>}
            {redoExpressionLevel > 0 && redoState !== 'complete' && <p><strong>表达方向：</strong>{feedbackData.redoTask.directionZh}</p>}
            {redoState === 'confirming' && <div className="retry-confirming-panel"><label htmlFor="redo-confirmed"><strong>确认这次回答：</strong></label><textarea id="redo-confirmed" className="retry-textarea" lang="ja" value={redoTranscript} onChange={(event) => setRedoTranscript(event.target.value)} /><div className="retry-confirm-buttons"><button className="secondary-button" type="button" onClick={() => void startRedoRecording()}>重新录音</button><button className="primary-button" type="button" onClick={() => void confirmRedo()}>确认回答并查看比较</button></div></div>}
            {redoState === 'loading' && <p>正在比较两次回答…</p>}
            {redoError && <p className="inline-error" role="alert">{redoError}</p>}
            {redoState === 'complete' && redoResult && <div className="retry-completed-panel"><p>{redoResult.comparisonZh}</p><p lang="ja"><strong>参考表达：</strong>{redoResult.referenceExpressionJa}</p><button className="text-button" type="button" onClick={startRedo}>再做一次</button></div>}
          </section>
        </div>
      )}

      <details className="developer-disclosure">
        <summary>开发信息</summary>
        <p>会话 {messages.length} 条消息，{rounds.length} 个原始回合，{report.redos.length} 个重做记录。</p>
        <div className="developer-actions"><button className="secondary-button" type="button" onClick={onCopy}>复制 JSON</button><button className="text-button" type="button" onClick={onDownload}>下载 JSON</button>{copyStatus && <span role="status">{copyStatus}</span>}</div>
      </details>
      {historyNotice && <p role="status" className="practice-storage-note">{historyNotice}</p>}
      {onRetrySave && <button className="secondary-button" type="button" onClick={onRetrySave}>重试保存</button>}
      <div className="complete-actions">
        {onRepeatScenario && <button className="primary-button" type="button" onClick={onRepeatScenario}>再练这个场景</button>}
        <button className="secondary-button" type="button" onClick={onNewScenario}>开始新场景</button>
      </div>
    </div>
  )
}

export default App
