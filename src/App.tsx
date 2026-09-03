import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import {
  formatRecordingTime,
  SILENCE_AUTO_STOP_SECONDS,
  SILENCE_COUNTDOWN_START_SECONDS,
} from './lib/audio-feedback'
import { cleanTranscript } from './lib/text-cleaner'
import {
  checkSessionCheckpoint,
  draftScenario,
  fetchConfig,
  fetchHint,
  requestConversationFeedback,
  requestElevenLabsToken,
  startScenarioSession,
  streamReply,
} from './lib/api'
import { buildSessionReport, createRoundRecord, downloadReport, duration } from './lib/metrics'
import { buildPracticeTrend } from './lib/trend'
import { preflightMicrophone, type MicrophoneReadiness } from './lib/microphone'
import { requestMicrophoneStream } from './lib/audio-engine'
import { createMessageId, createSessionId } from './lib/session'
import { RealtimeSttSession, SttError } from './lib/stt'
import { CachedTtsPlayer, TtsCancelledError } from './lib/tts'
import { formatDuration, toUiError } from './lib/ui'
import { consumePreparedScenario, prepareNextScenario, scenarioForPractice } from './scenarios/queue'
import { deriveScenarioReveal } from './scenarios/reveal'
import type {
  AppPhase,
  ConversationFeedbackResponse,
  ConversationMessage,
  FeedbackImprovement,
  FeedbackLoadingState,
  PrototypeConfig,
  RoundRecord,
  SelfAssessment,
  SessionReport,
  SessionScenario,
  TranscriptText,
  UiError,
} from './types'
const BUILD_ID = '2026-09-02-random-blind-practice-1'

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

const ACTIVE_SESSION_PHASES: AppPhase[] = [
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
  requesting_llm: ['preparing_tts', 'error', 'session_complete'],
  preparing_tts: ['playing_ai', 'waiting_user', 'error', 'session_complete'],
  playing_ai: ['waiting_user', 'error', 'session_complete'],
  round_complete: ['waiting_user', 'recording', 'fetching_token', 'session_complete', 'error'],
  session_complete: ['loading_config', 'idle', 'error'],
  error: ['loading_config', 'idle', 'fetching_token', 'connecting_stt', 'waiting_user', 'recording', 'confirming_transcript', 'requesting_llm', 'preparing_tts', 'session_complete'],
}
const EMPTY_TRANSCRIPT: TranscriptText = {
  rawText: '',
  cleanedText: '',
  finalText: '',
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
  const [, setCurrentRoundView] = useState<RoundRecord | null>(null)
  const [online, setOnline] = useState(navigator.onLine)
  const [microphoneReadiness, setMicrophoneReadiness] = useState<MicrophoneReadiness>('unknown')
  const [currentAiText, setCurrentAiText] = useState('')
  const [aiTextRevealed, setAiTextRevealed] = useState(false)
  const [partialTranscript, setPartialTranscript] = useState('')
  const [transcript, setTranscript] = useState<TranscriptText>(EMPTY_TRANSCRIPT)
  const [manualInput, setManualInput] = useState(false)
  const [showOriginalTranscript, setShowOriginalTranscript] = useState(false)
  const [, setMicrophoneLevel] = useState(0)
  const [microphoneMeterAvailable, setMicrophoneMeterAvailable] = useState(true)
  const [, setSpeechDetected] = useState(false)
  const [recordingSeconds, setRecordingSeconds] = useState(0)
  const [silentSeconds, setSilentSeconds] = useState(0)
  const [recordingUiStartedAt, setRecordingUiStartedAt] = useState<number | null>(null)
  const [foregroundNotice, setForegroundNotice] = useState('')
  const [uiError, setUiError] = useState<UiError | null>(null)
  const [inlineError, setInlineError] = useState('')
  const [lastFailedStep, setLastFailedStep] = useState<'config' | 'scenario' | 'token' | 'stt' | 'llm' | 'tts' | null>(null)
  const [copyStatus, setCopyStatus] = useState('')
  const [selfAssessment, setSelfAssessment] = useState<SelfAssessment>(null)
  const [previousReport, setPreviousReport] = useState<SessionReport | null>(null)
  const [reviewAudioNotice, setReviewAudioNotice] = useState('')
  const [homeMode, setHomeMode] = useState<'catalog' | 'custom'>('catalog')
  const [customInputZh, setCustomInputZh] = useState('')
  const [clarifications, setClarifications] = useState<Array<{ questionZh: string; answerZh: string }>>([])
  const [pendingClarification, setPendingClarification] = useState<{ questionZh: string; optionsZh: readonly string[] } | null>(null)
  const [readyScenarioData, setReadyScenarioData] = useState<{ scenario: import('./types').DynamicScenarioData; scenarioToken: string } | null>(null)
  const [isDraftingScenario, setIsDraftingScenario] = useState(false)
  const [hintData, setHintData] = useState<import('./types').HintResponse | null>(null)
  const [hintLevel, setHintLevel] = useState<number>(0)
  const [isLoadingHint, setIsLoadingHint] = useState(false)
  const [showHintSheet, setShowHintSheet] = useState(false)
  const [showGoalsSheet, setShowGoalsSheet] = useState(false)
  const [showTranscriptSheet, setShowTranscriptSheet] = useState(false)
  const [dockInputMode, setDockInputMode] = useState<'voice' | 'text'>('voice')
  const [dockTextValue, setDockTextValue] = useState('')
  const [expandedAiMessageIds, setExpandedAiMessageIds] = useState<Set<string>>(new Set())
  const [activeAiMessageId, setActiveAiMessageId] = useState<string | null>(null)
  const [playedAiMessageIds, setPlayedAiMessageIds] = useState<Set<string>>(new Set())
  const [checkpointData, setCheckpointData] = useState<import('./types').SessionCheckpointResponse | null>(null)
  const [, setIsCheckingCheckpoint] = useState(false)
  const [feedbackData, setFeedbackData] = useState<ConversationFeedbackResponse | null>(null)
  const [feedbackStatus, setFeedbackStatus] = useState<FeedbackLoadingState>('idle')
  const [feedbackErrorMsg, setFeedbackErrorMsg] = useState('')
  const feedbackFetchedRef = useRef(false)
  const phaseRef = useRef(phase)
  const messagesRef = useRef<ConversationMessage[]>([])
  const roundsRef = useRef<RoundRecord[]>([])
  const currentRoundRef = useRef<RoundRecord | null>(null)
  const pendingHistoryRef = useRef<ConversationMessage[]>([])
  const pendingAdvanceReplyRef = useRef<string | null>(null)
  const requestAbortRef = useRef<AbortController | null>(null)
  const sttRef = useRef(new RealtimeSttSession())
  const ttsRef = useRef(new CachedTtsPlayer())
  const sessionStartLockRef = useRef(false)
  const recordingStartLockRef = useRef(false)
  const submitLockRef = useRef(false)
  const ttsActionLockRef = useRef(false)
  const operationIdRef = useRef(0)
  const lastSoundAtRef = useRef<number | null>(null)
  const silenceStopLockRef = useRef(false)
  const prefetchedTokenRef = useRef<{ token: string; expiresAt: number } | null>(null)
  const messageListRef = useRef<HTMLDivElement | null>(null)
  const chatBottomRef = useRef<HTMLDivElement | null>(null)

  // 后台静默预取下一轮 STT 临时 Token
  const prefetchSttToken = useCallback(async () => {
    if (!config?.elevenlabs.sttAvailable || !online) return
    const now = Date.now()
    if (prefetchedTokenRef.current && prefetchedTokenRef.current.expiresAt > now + 60_000) {
      return
    }
    try {
      const token = await requestElevenLabsToken('realtime_scribe')
      prefetchedTokenRef.current = { token, expiresAt: now + 800_000 } // ~13分钟有效期
    } catch {
      // 静默失败，用户点击时会平滑重试
    }
  }, [config?.elevenlabs.sttAvailable, online])
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
    sttRef.current.close()
    ttsRef.current.stop()
    return operationIdRef.current
  }, [])

  const isCurrentOperation = useCallback((operationId: number) => operationId === operationIdRef.current, [])
  const unlockAudio = useCallback(() => ttsRef.current.unlock(), [])

  useEffect(() => {
    phaseRef.current = phase
  }, [phase])

  useEffect(() => {
    scrollToBottom(messages.length <= 1 ? 'auto' : 'smooth')
  }, [messages, phase, partialTranscript, hintData, hintLevel, uiError, scrollToBottom])

  useEffect(() => {
    if (phase !== 'recording' || recordingUiStartedAt === null) return
    const updateElapsed = () => {
      const now = Date.now()
      setRecordingSeconds(Math.floor((now - recordingUiStartedAt) / 1_000))
      setSilentSeconds(Math.floor((now - (lastSoundAtRef.current ?? recordingUiStartedAt)) / 1_000))
    }
    updateElapsed()
    const interval = window.setInterval(updateElapsed, 100)
    return () => window.clearInterval(interval)
  }, [phase, recordingUiStartedAt])
  const replaceMessages = useCallback((next: ConversationMessage[]) => {
    messagesRef.current = next
    setMessages(next)
  }, [])

  const resetTranscript = useCallback(() => {
    setTranscript({ ...EMPTY_TRANSCRIPT })
    setShowOriginalTranscript(false)
  }, [])

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

  const prepareTranscript = useCallback((rawText: string) => {
    const cleaned = cleanTranscript(rawText)
    setTranscript({
      rawText: cleaned.rawText,
      cleanedText: cleaned.cleanedText,
      finalText: cleaned.cleanedText,
    })
    touchRound((round) => {
      round.userCleaned = cleaned.cleanedText.trim()
    })
    setShowOriginalTranscript(false)
  }, [touchRound])
  const stopActiveResources = useCallback(() => {
    beginOperation()
  }, [beginOperation])

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
      transitionTo('idle')
      setLastFailedStep(null)
    } catch (error) {
      if (controller.signal.aborted || !isCurrentOperation(operationId)) return
      setUiError(toUiError(error))
      setLastFailedStep('config')
      transitionTo('error')
    } finally {
      if (requestAbortRef.current === controller) requestAbortRef.current = null
    }
  }, [beginOperation, isCurrentOperation, transitionTo])

  useEffect(() => {
    const timer = window.setTimeout(() => void loadConfig(), 0)
    return () => window.clearTimeout(timer)
  }, [loadConfig])

  useEffect(() => {
    const tts = ttsRef.current
    const handleOnline = () => {
      setOnline(true)
      setForegroundNotice('网络已恢复，可以继续。')
    }
    const handleOffline = () => {
      setOnline(false)
      stopActiveResources()
      if (!ACTIVE_SESSION_PHASES.includes(phaseRef.current)) return
      touchRound((round) => {
        round.failureCount += 1
      })
      setUiError({
        code: 'offline',
        title: '网络连接已中断',
        message: '当前步骤已停止。网络恢复后重试，或改用文字回答。',
        recovery: phaseRef.current === 'recording' ? 'text_input' : 'retry',
      })
      transitionTo('error')
    }
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden' && ACTIVE_SESSION_PHASES.includes(phaseRef.current)) {
        const interruptedPhase = phaseRef.current
        stopActiveResources()
        touchRound((round) => {
          round.failureCount += 1
        })
        setLastFailedStep(
          interruptedPhase === 'requesting_llm' ? 'llm' : interruptedPhase === 'preparing_tts' || interruptedPhase === 'playing_ai' ? 'tts' : 'stt',
        )
        setUiError({
          code: 'background_interruption',
          title: '连接已在后台停止',
          message: '返回页面后请恢复当前步骤。',
          recovery: interruptedPhase === 'recording' ? 'text_input' : 'retry',
        })
        transitionTo('error')
      } else if (document.visibilityState === 'visible') {
        setForegroundNotice('已回到页面，请确认当前状态后继续。')
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
      tts.dispose()
    }
  }, [stopActiveResources, touchRound, transitionTo])

  const finalizeAndAdvance = useCallback((reply: string) => {
    const activeRound = currentRoundRef.current
    if (activeRound) appendRound(activeRound)
    const nextTurn = turn + 1
    replaceCurrentRound(createRoundRecord(nextTurn, reply, 0))
    pendingAdvanceReplyRef.current = null
    setTurn(nextTurn)
    transitionTo('waiting_user')
    setUiError(null)
    setLastFailedStep(null)
  }, [appendRound, replaceCurrentRound, transitionTo, turn])

  const playAiText = useCallback(async (
    text: string,
    replay: boolean,
    advanceAfterPlayback: boolean,
    existingOperationId?: number,
    messageId?: string,
  ) => {
    if (!config || ttsActionLockRef.current) return
    const operationId = existingOperationId ?? beginOperation()
    if (!isCurrentOperation(operationId)) return
    ttsActionLockRef.current = true
    setActiveAiMessageId(messageId ?? null)
    sttRef.current.close()
    setUiError(null)
    setInlineError('')
    if (replay) {
      touchRound((round) => {
        round.ttsReplayCount += 1
      })
    }
    if (!config.elevenlabs.ttsAvailable || !config.elevenlabs.voiceId) {
      pendingAdvanceReplyRef.current = advanceAfterPlayback ? text : null
      setUiError({
        code: 'tts_unconfigured',
        title: '相手语音暂不可用',
        message: '暂时无法播放相手语音。可以显示文字继续。',
        recovery: 'skip_tts',
      })
      setLastFailedStep('tts')
      transitionTo('error')
      ttsActionLockRef.current = false
      setActiveAiMessageId(null)
      return
    }

    transitionTo('preparing_tts')
    try {
      await ttsRef.current.speak({
        text,
        voiceId: config.elevenlabs.voiceId,
        modelId: config.elevenlabs.ttsModel,
        onGenerationStarted: () => {
          if (!isCurrentOperation(operationId)) return
          touchRound((round) => {
            round.timing.ttsStartedAt = Date.now()
          })
        },
        onFirstAudio: () => {
          if (!isCurrentOperation(operationId)) return
          touchRound((round) => {
            round.timing.ttsFirstAudioAt = Date.now()
          })
        },
        onAudioStarted: () => {
          if (!isCurrentOperation(operationId)) return
          touchRound((round) => {
            round.timing.audioStartedAt = Date.now()
          })
          transitionTo('playing_ai')
          void prefetchSttToken() // AI 开始发话时，后台静默预取下一轮 Token
        },
        onAudioEnded: () => {
          if (!isCurrentOperation(operationId)) return
          touchRound((round) => {
            round.timing.audioCompletedAt = Date.now()
          })
          if (messageId) {
            setPlayedAiMessageIds((previous) => {
              if (previous.has(messageId)) return previous
              const next = new Set(previous)
              next.add(messageId)
              return next
            })
          }
        },
        onTtsRequest: (characters) => {
          if (!isCurrentOperation(operationId)) return
          touchRound((round) => {
            round.ttsRequestCount += 1
            round.ttsCharacterCount += characters
          })
        },
      })
      if (!isCurrentOperation(operationId)) return
      if (advanceAfterPlayback) finalizeAndAdvance(text)
      else transitionTo('waiting_user')
    } catch (error) {
      if (error instanceof TtsCancelledError || !isCurrentOperation(operationId)) return
      touchRound((round) => {
        round.failureCount += 1
      })
      pendingAdvanceReplyRef.current = advanceAfterPlayback ? text : null
      setUiError(toUiError(error))
      setLastFailedStep('tts')
      transitionTo('error')
    } finally {
      ttsActionLockRef.current = false
      setActiveAiMessageId(null)
    }
  }, [beginOperation, config, finalizeAndAdvance, isCurrentOperation, touchRound, transitionTo])
  const playReviewAudio = useCallback(async (text: string) => {
    if (!config?.elevenlabs.ttsAvailable || !config.elevenlabs.voiceId || ttsActionLockRef.current) return
    ttsActionLockRef.current = true
    setReviewAudioNotice('')
    try {
      await ttsRef.current.speak({
        text,
        voiceId: config.elevenlabs.voiceId,
        modelId: config.elevenlabs.ttsModel,
        onGenerationStarted: () => {},
        onFirstAudio: () => {},
        onAudioStarted: () => {},
        onAudioEnded: () => {},
        onTtsRequest: () => {},
      })
    } catch (error) {
      if (!(error instanceof TtsCancelledError)) {
        setReviewAudioNotice('参考语音暂时无法播放，请直接阅读文字。')
      }
    } finally {
      ttsActionLockRef.current = false
    }
  }, [config])

  const stopAiPlayback = useCallback(() => {
    if (phaseRef.current !== 'playing_ai' && phaseRef.current !== 'preparing_tts') return
    const pendingReply = pendingAdvanceReplyRef.current
    stopActiveResources()
    touchRound((round) => {
      if (round.timing.audioStartedAt !== null) round.timing.audioCompletedAt = Date.now()
    })
    if (pendingReply) finalizeAndAdvance(pendingReply)
    else transitionTo('waiting_user')
  }, [finalizeAndAdvance, stopActiveResources, touchRound, transitionTo])

  const startSession = useCallback(async (practiceTarget?: string | { scenarioToken: string } | null) => {
    if (!config || !online || sessionStartLockRef.current) return

    let scenarioParam: { scenarioId: string } | { scenarioToken: string }
    let isDynamic = false
    if (practiceTarget && typeof practiceTarget === 'object' && 'scenarioToken' in practiceTarget) {
      scenarioParam = { scenarioToken: practiceTarget.scenarioToken }
      isDynamic = true
    } else {
      const scenarioId = scenarioForPractice(
        typeof practiceTarget === 'string' ? practiceTarget : null,
        prepareNextScenario(config.scenarioCatalog, sessionStorage),
      )
      if (!scenarioId) {
        setUiError({
          code: 'scenario_unavailable',
          title: '暂时无法开始',
          message: '练习场景还没有准备好，请稍后重试。',
          recovery: 'retry',
        })
        transitionTo('error')
        return
      }
      scenarioParam = { scenarioId }
    }

    sessionStartLockRef.current = true
    const operationId = beginOperation()
    setSessionId('')
    setScenario(null)
    setSessionStartedAt(null)
    setSessionEndedAt(null)
    setTurn(1)
    replaceMessages([])
    roundsRef.current = []
    setRounds([])
    replaceCurrentRound(null)
    pendingHistoryRef.current = []
    pendingAdvanceReplyRef.current = null
    setCurrentAiText('')
    setAiTextRevealed(false)
    setActiveAiMessageId(null)
    setPlayedAiMessageIds(new Set())
    setExpandedAiMessageIds(new Set())
    setPartialTranscript('')
    resetTranscript()
    setManualInput(false)
    setMicrophoneLevel(0)
    setRecordingSeconds(0)
    setSilentSeconds(0)
    lastSoundAtRef.current = null
    setUiError(null)
    setInlineError('')
    setCopyStatus('')
    setCheckpointData(null)
    setShowGoalsSheet(false)
    setFeedbackData(null)
    setFeedbackStatus('idle')
    setFeedbackErrorMsg('')
    feedbackFetchedRef.current = false
    const controller = new AbortController()
    requestAbortRef.current = controller
    transitionTo('loading_config')
    setMicrophoneReadiness(config.elevenlabs.sttAvailable ? 'unknown' : 'unavailable')

    // 同一次点击手势内并发完成音频上下文激活与场景初始化（不主动弹窗抢占麦克风，录音时再请求）
    const audioUnlock = unlockAudio().catch(() => undefined)
    const microphonePreflight = config.elevenlabs.sttAvailable
      ? preflightMicrophone(false)
      : Promise.resolve<MicrophoneReadiness>('unavailable')
    const scenarioRequest = startScenarioSession(scenarioParam, controller.signal)

    try {
      const [, readiness, nextScenario] = await Promise.all([audioUnlock, microphonePreflight, scenarioRequest])
      if (controller.signal.aborted || !isCurrentOperation(operationId)) return
      setMicrophoneReadiness(readiness)
      if (!isDynamic && 'scenarioId' in scenarioParam && typeof practiceTarget !== 'string') {
        consumePreparedScenario(config.scenarioCatalog, sessionStorage, scenarioParam.scenarioId)
      }

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
      setSessionEndedAt(null)
      setTurn(1)
      replaceMessages([firstMessage])
      roundsRef.current = []
      setRounds([])
      replaceCurrentRound(createRoundRecord(1, nextScenario.firstLine, 0))
      pendingHistoryRef.current = []
      pendingAdvanceReplyRef.current = null
      setAiTextRevealed(false)
      setCurrentAiText(nextScenario.firstLine)
      setPartialTranscript('')
      resetTranscript()
      setManualInput(false)
      setSelfAssessment(null)
      setUiError(null)
      setForegroundNotice(
        readiness === 'denied'
          ? '未允许麦克风。回答时会直接切换到文字输入。'
          : readiness === 'unavailable'
            ? '没有检测到可用麦克风，回答时会直接切换到文字输入。'
            : '',
      )
      await playAiText(nextScenario.firstLine, false, false, operationId, firstMessage.id)
    } catch (error) {
      if (controller.signal.aborted || !isCurrentOperation(operationId)) return
      setUiError(toUiError(error))
      setLastFailedStep('config')
      transitionTo('error')
    } finally {
      if (requestAbortRef.current === controller) requestAbortRef.current = null
      sessionStartLockRef.current = false
    }
  }, [beginOperation, config, isCurrentOperation, online, playAiText, replaceCurrentRound, replaceMessages, resetTranscript, transitionTo, unlockAudio])

  const handleDraftScenario = useCallback(async (customPrompt?: string, clarificationsList?: Array<{ questionZh: string; answerZh: string }>, forceGen?: boolean) => {
    const text = customPrompt ?? customInputZh
    if (!text.trim()) return
    setIsDraftingScenario(true)
    setUiError(null)
    const list = clarificationsList ?? clarifications

    try {
      const res = await draftScenario(text.trim(), list, forceGen ?? false)
      if (res.status === 'needs_clarification') {
        setPendingClarification({ questionZh: res.questionZh, optionsZh: res.optionsZh })
      } else {
        setPendingClarification(null)
        setReadyScenarioData({ scenario: res.scenario, scenarioToken: res.scenarioToken })
      }
    } catch (error) {
      setUiError(toUiError(error))
    } finally {
      setIsDraftingScenario(false)
    }
  }, [clarifications, customInputZh])

  const handleAnswerClarification = useCallback((answer: string) => {
    if (!pendingClarification) return
    const updated = [...clarifications, { questionZh: pendingClarification.questionZh, answerZh: answer.trim() }]
    setClarifications(updated)
    setPendingClarification(null)
    void handleDraftScenario(customInputZh, updated)
  }, [clarifications, customInputZh, handleDraftScenario, pendingClarification])

  const handleRequestHint = useCallback(async () => {
    if (!scenario || isLoadingHint) return
    if (hintData) {
      const nextLevel = Math.min(4, hintLevel + 1) as 1 | 2 | 3 | 4
      setHintLevel(nextLevel)
      touchRound((round) => {
        if (nextLevel > round.hintLevelUsed) {
          round.hintLevelUsed = nextLevel
        }
      })
      return
    }
    setIsLoadingHint(true)
    try {
      const res = await fetchHint(scenario, currentAiText, messagesRef.current)
      setHintData(res)
      setHintLevel(1)
      touchRound((round) => {
        if (round.hintLevelUsed < 1) {
          round.hintLevelUsed = 1
        }
      })
    } catch {
      setForegroundNotice('获取提示暂时失败，可继续自行回答。')
    } finally {
      setIsLoadingHint(false)
    }
  }, [currentAiText, hintData, hintLevel, isLoadingHint, scenario, touchRound])

  const startRecording = useCallback(async () => {
    if (!config || !online || recordingStartLockRef.current || phaseRef.current === 'recording' || phaseRef.current === 'connecting_stt') return
    recordingStartLockRef.current = true
    const operationId = beginOperation()
    setUiError(null)
    setInlineError('')
    setPartialTranscript('')
    resetTranscript()
    setManualInput(false)
    setMicrophoneLevel(0)
    setMicrophoneMeterAvailable(true)
    setSpeechDetected(false)
    setRecordingSeconds(0)
    setSilentSeconds(0)
    setRecordingUiStartedAt(null)
    lastSoundAtRef.current = null
    silenceStopLockRef.current = false

    const recordingStartedAt = Date.now()
    touchRound((round) => {
      round.inputMode = 'stt'
      round.timing.recordingStartedAt = recordingStartedAt
      round.timing.recordingStoppedAt = null
      round.timing.transcriptFinalizedAt = null
      round.timing.transcriptConfirmedAt = null
    })

    if (!config.elevenlabs.sttAvailable || microphoneReadiness === 'denied') {
      setManualInput(true)
      touchRound((round) => {
        round.inputMode = 'text'
        round.timing.recordingStoppedAt = recordingStartedAt
        round.timing.transcriptFinalizedAt = recordingStartedAt
      })
      setShowTranscriptSheet(true)
      transitionTo('confirming_transcript')
      recordingStartLockRef.current = false
      return
    }

    const controller = new AbortController()
    requestAbortRef.current = controller

    try {
      transitionTo('connecting_stt')
      await requestMicrophoneStream()
      if (controller.signal.aborted || !isCurrentOperation(operationId)) return
      setMicrophoneReadiness('granted')

      // 2. 硬件流就绪后，正式切入录音状态与计时
      const connectedAt = Date.now()
      lastSoundAtRef.current = connectedAt
      setRecordingUiStartedAt(connectedAt)
      transitionTo('recording')

      // 3. 优先复用后台预取的鲜活 Token，若无则快速获取
      let token = prefetchedTokenRef.current?.token
      const isTokenFresh = prefetchedTokenRef.current && prefetchedTokenRef.current.expiresAt > Date.now()
      if (!token || !isTokenFresh) {
        token = await requestElevenLabsToken('realtime_scribe', controller.signal)
      } else {
        prefetchedTokenRef.current = null
      }

      if (controller.signal.aborted || !isCurrentOperation(operationId)) return
      await sttRef.current.start(token, config.elevenlabs.sttModel, {
        onPartial: (text) => {
          if (!isCurrentOperation(operationId)) return
          setPartialTranscript(text)
          if (text.trim()) {
            const now = Date.now()
            lastSoundAtRef.current = now
            setSilentSeconds(0)
            setSpeechDetected(true)
            silenceStopLockRef.current = false
            touchRound((round) => {
              if (round.timing.firstSpeechAt === null) {
                round.timing.firstSpeechAt = now
              }
            })
          }
        },
        onConnectionState: (state) => {
          if (!isCurrentOperation(operationId)) return
          if (state === 'connected') {
            const now = Date.now()
            lastSoundAtRef.current = now
          }
        },
        onAudioLevel: (level) => {
          if (!isCurrentOperation(operationId)) return
          if (level < 0) {
            setMicrophoneMeterAvailable(false)
            setMicrophoneLevel(0)
            return
          }
          setMicrophoneMeterAvailable(true)
          setMicrophoneLevel(level)
          if (level >= 0.12) {
            const now = Date.now()
            lastSoundAtRef.current = now
            setSilentSeconds(0)
            setSpeechDetected(true)
            silenceStopLockRef.current = false
            touchRound((round) => {
              if (round.timing.firstSpeechAt === null) {
                round.timing.firstSpeechAt = now
              }
            })
          }
        },
      })
      if (!isCurrentOperation(operationId)) return
      touchRound((round) => {
        round.sttSessionCount += 1
      })
      setLastFailedStep(null)
    } catch (error) {
      if (controller.signal.aborted || !isCurrentOperation(operationId)) return
      sttRef.current.close()
      touchRound((round) => {
        round.failureCount += 1
      })
      if (error instanceof SttError && (error.code === 'permission_denied' || error.code === 'device_missing')) {
        const now = Date.now()
        setMicrophoneReadiness(error.code === 'permission_denied' ? 'denied' : 'unavailable')
        setManualInput(true)
        touchRound((round) => {
          round.inputMode = 'text'
          round.timing.recordingStoppedAt = now
          round.timing.transcriptFinalizedAt = now
        })
        setForegroundNotice(error.code === 'permission_denied' ? '麦克风权限未开启，已切换到文字回答。' : '没有可用麦克风，已切换到文字回答。')
        setLastFailedStep(null)
        transitionTo('confirming_transcript')
        return
      }
      setUiError(toUiError(error))
      setLastFailedStep('stt')
      transitionTo('error')
    } finally {
      if (requestAbortRef.current === controller) requestAbortRef.current = null
      recordingStartLockRef.current = false
    }
  }, [beginOperation, config, isCurrentOperation, microphoneReadiness, online, resetTranscript, touchRound, transitionTo])

  const stopRecording = useCallback(async () => {
    if (phaseRef.current !== 'recording') return
    const operationId = operationIdRef.current
    const stoppedAt = Date.now()
    setMicrophoneLevel(0)
    setSilentSeconds(0)
    setRecordingUiStartedAt(null)
    transitionTo('finalizing_transcript')
    touchRound((round) => {
      round.timing.recordingStoppedAt = stoppedAt
      const startedAt = round.timing.recordingStartedAt
      if (startedAt !== null) round.sttAudioMilliseconds += Math.max(0, stoppedAt - startedAt)
    })

    try {
      const finalText = await sttRef.current.stop()
      if (!isCurrentOperation(operationId)) return
      const finalizedAt = Date.now()
      setPartialTranscript('')
      prepareTranscript(finalText)
      touchRound((round) => {
        round.timing.transcriptFinalizedAt = finalizedAt
      })
      transitionTo('confirming_transcript')
    } catch (error) {
      if (!isCurrentOperation(operationId)) return
      touchRound((round) => {
        round.failureCount += 1
      })
      setUiError(toUiError(error))
      setLastFailedStep('stt')
      transitionTo('error')
    }
  }, [isCurrentOperation, prepareTranscript, touchRound, transitionTo])

  const enterTextInput = useCallback(() => {
    const now = Date.now()
    beginOperation()
    setMicrophoneLevel(0)
    setSilentSeconds(0)
    setRecordingUiStartedAt(null)
    setManualInput(true)
    prepareTranscript(partialTranscript.trim())
    touchRound((round) => {
      round.inputMode = 'text'
      if (round.timing.recordingStartedAt === null) round.timing.recordingStartedAt = now
      if (round.timing.recordingStoppedAt === null) round.timing.recordingStoppedAt = now
      if (round.timing.transcriptFinalizedAt === null) round.timing.transcriptFinalizedAt = now
    })
    setUiError(null)
    setLastFailedStep(null)
    transitionTo('confirming_transcript')
  }, [beginOperation, partialTranscript, prepareTranscript, touchRound, transitionTo])

  const rerecord = useCallback(async () => {
    touchRound((round) => {
      round.rerecordCount += 1
      round.retryCount += 1
    })
    setPartialTranscript('')
    resetTranscript()
    setUiError(null)
    transitionTo('waiting_user')
    await startRecording()
  }, [resetTranscript, startRecording, touchRound, transitionTo])

  const generateNextReply = useCallback(async (history: ConversationMessage[], retry: boolean) => {
    if (!config || !scenario) return
    const operationId = beginOperation()
    setUiError(null)
    setLastFailedStep(null)
    setHintData(null)
    setHintLevel(0)
    pendingHistoryRef.current = history
    transitionTo('requesting_llm')
    touchRound((round) => {
      round.llmRequestCount += 1
      if (retry) round.retryCount += 1
      round.timing.llmStartedAt = Date.now()
      round.timing.llmFirstTextAt = null
      round.timing.llmCompletedAt = null
    })

    const controller = new AbortController()
    requestAbortRef.current = controller
    try {
      const result = await streamReply(
        sessionId,
        turn,
        history,
        scenario,
        () => {
          if (!isCurrentOperation(operationId)) return
          touchRound((round) => {
            if (round.timing.llmFirstTextAt === null) round.timing.llmFirstTextAt = Date.now()
          })
        },
        controller.signal,
      )
      if (controller.signal.aborted || !isCurrentOperation(operationId)) return

      touchRound((round) => {
        round.timing.llmCompletedAt = Date.now()
        round.nextAiReply = result.text
        round.llmModel = result.model
        round.llmMock = result.mock
        round.usage = result.usage
      })
      const assistantMessage: ConversationMessage = {
        id: createMessageId(turn + 1, 'assistant'),
        turn: turn + 1,
        role: 'assistant',
        text: result.text,
      }
      replaceMessages([...history, assistantMessage])
      setAiTextRevealed(false)
      setCurrentAiText(result.text)
      pendingAdvanceReplyRef.current = result.text

      await playAiText(result.text, false, true, operationId, assistantMessage.id)
    } catch (error) {
      if (controller.signal.aborted || !isCurrentOperation(operationId)) return
      touchRound((round) => {
        round.failureCount += 1
      })
      setUiError(toUiError(error))
      setLastFailedStep('llm')
      transitionTo('error')
    } finally {
      if (requestAbortRef.current === controller) requestAbortRef.current = null
    }
  }, [beginOperation, config, isCurrentOperation, playAiText, replaceMessages, scenario, sessionId, touchRound, transitionTo, turn])

  const endSession = useCallback((includeConfirmedCurrent: boolean) => {
    stopActiveResources()
    const activeRound = currentRoundRef.current
    if (includeConfirmedCurrent && activeRound?.userFinal) appendRound(activeRound)
    replaceCurrentRound(null)
    pendingAdvanceReplyRef.current = null
    setSessionEndedAt(Date.now())
    setUiError(null)
    transitionTo('session_complete')
  }, [appendRound, replaceCurrentRound, stopActiveResources, transitionTo])

  const fetchFeedback = useCallback(async () => {
    if (!scenario || roundsRef.current.length === 0) return
    setFeedbackStatus('loading')
    setFeedbackErrorMsg('')
    try {
      const res = await requestConversationFeedback(scenario, messagesRef.current, roundsRef.current)
      setFeedbackData(res)
      setFeedbackStatus('success')
    } catch (error) {
      setFeedbackStatus('error')
      setFeedbackErrorMsg(error instanceof Error ? error.message : '反馈生成失败，可点击重试。')
    }
  }, [scenario])

  useEffect(() => {
    if (phase === 'session_complete' && !feedbackFetchedRef.current && scenario && roundsRef.current.length > 0) {
      feedbackFetchedRef.current = true
      void fetchFeedback()
    }
  }, [fetchFeedback, phase, scenario])

  const handleExtendSession = useCallback(async (newCap: number, newSessionToken: string) => {
    if (!scenario) return
    const updatedScenario = { ...scenario, maxTurns: newCap, sessionToken: newSessionToken }
    setScenario(updatedScenario)
    setCheckpointData(null)
    setForegroundNotice(`练习已延长至 ${newCap} 轮，继续加油！`)
    const history = pendingHistoryRef.current.length > 0 ? pendingHistoryRef.current : messagesRef.current
    await generateNextReply(history, false)
  }, [generateNextReply, scenario])

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
    touchRound((round) => {
      round.userOriginal = transcript.rawText.trim()
      round.userFinal = finalText
      round.transcriptModified = round.inputMode === 'stt' && finalText !== transcript.cleanedText.trim()
      round.transcriptModificationCount = round.transcriptModified ? 1 : 0
      round.timing.transcriptConfirmedAt = confirmedAt
    })

    const userMessage: ConversationMessage = {
      id: createMessageId(turn, 'user'),
      turn,
      role: 'user',
      text: finalText,
      transcript: {
        rawText: transcript.rawText,
        cleanedText: transcript.cleanedText,
        finalText,
      },
    }
    const history = [...messagesRef.current, userMessage]
    pendingHistoryRef.current = history
    replaceMessages(history)

    const isDynamic = scenario?.scenarioType === 'dynamic' && Boolean(scenario.sessionToken)
    const isCapTurn = isDynamic && (turn === 10 || turn === 14)

    if (isCapTurn && scenario?.sessionToken) {
      const activeRound = currentRoundRef.current
      if (activeRound) appendRound(activeRound)
      replaceCurrentRound(null)
      setIsCheckingCheckpoint(true)
      try {
        const checkpointRes = await checkSessionCheckpoint(scenario.sessionToken, turn, history)
        setCheckpointData(checkpointRes)
        if (checkpointRes.isGoalCompleted) {
          submitLockRef.current = false
          endSession(false)
          return
        }
        if (checkpointRes.canExtend && checkpointRes.newSessionToken && checkpointRes.nextCap) {
          submitLockRef.current = false
          return
        }
        submitLockRef.current = false
        endSession(false)
        return
      } catch {
        setCheckpointData({
          isGoalCompleted: false,
          completedGoals: [],
          remainingGoals: [],
          factsSummary: [],
          nextDirection: '检查点评估暂时不可用，可选择直接结算。',
          canExtend: false,
          nextCap: null,
          newSessionToken: null,
        })
        submitLockRef.current = false
        return
      } finally {
        setIsCheckingCheckpoint(false)
      }
    }

    if (turn >= (scenario?.maxTurns ?? config?.limits.maxTurns ?? 5)) {
      const activeRound = currentRoundRef.current
      if (activeRound) appendRound(activeRound)
      replaceCurrentRound(null)
      submitLockRef.current = false
      endSession(false)
      return
    }

    await generateNextReply(history, false)
    submitLockRef.current = false
  }, [appendRound, config?.limits.maxTurns, endSession, generateNextReply, replaceCurrentRound, replaceMessages, scenario, touchRound, transcript, turn])
  const retryFailedStep = useCallback(async () => {
    setUiError(null)
    if (lastFailedStep === 'config') {
      if (config) await startSession()
      else await loadConfig()
      return
    }
    if (lastFailedStep === 'stt') {
      await startRecording()
      return
    }
    if (lastFailedStep === 'llm') {
      await generateNextReply(pendingHistoryRef.current, true)
      return
    }
    if (lastFailedStep === 'tts') {
      touchRound((round) => {
        round.retryCount += 1
      })
      const reply = pendingAdvanceReplyRef.current
      const latestAssistantId = messagesRef.current.findLast((message) => message.role === 'assistant')?.id
      await playAiText(reply ?? currentAiText, false, Boolean(reply), undefined, latestAssistantId)
    }
  }, [config, currentAiText, generateNextReply, lastFailedStep, loadConfig, playAiText, startRecording, startSession, touchRound])

  const skipFailedTts = useCallback(() => {
    const pendingReply = pendingAdvanceReplyRef.current
    stopActiveResources()
    setAiTextRevealed(true)
    setUiError(null)
    if (pendingReply) finalizeAndAdvance(pendingReply)
    else transitionTo('waiting_user')
  }, [finalizeAndAdvance, stopActiveResources, transitionTo])

  const resetSession = useCallback(() => {
    stopActiveResources()
    setSessionId('')
    setScenario(null)
    setSessionStartedAt(null)
    setSessionEndedAt(null)
    setTurn(1)
    replaceMessages([])
    roundsRef.current = []
    setRounds([])
    setMicrophoneReadiness('unknown')
    replaceCurrentRound(null)
    pendingHistoryRef.current = []
    pendingAdvanceReplyRef.current = null
    setCurrentAiText('')
    setMicrophoneLevel(0)
    setMicrophoneMeterAvailable(true)
    setSpeechDetected(false)
    setRecordingSeconds(0)
    setSilentSeconds(0)
    setRecordingUiStartedAt(null)
    lastSoundAtRef.current = null
    setAiTextRevealed(false)
    setActiveAiMessageId(null)
    setPlayedAiMessageIds(new Set())
    setExpandedAiMessageIds(new Set())
    setPartialTranscript('')
    resetTranscript()
    setManualInput(false)
    setUiError(null)
    setInlineError('')
    setCopyStatus('')
    setSelfAssessment(null)
    sessionStartLockRef.current = false
    recordingStartLockRef.current = false
    submitLockRef.current = false
    ttsActionLockRef.current = false
    silenceStopLockRef.current = false
    transitionTo(config ? 'idle' : 'loading_config')
  }, [config, replaceCurrentRound, replaceMessages, resetTranscript, stopActiveResources, transitionTo])

  const report: SessionReport | null = useMemo(() => {
    if (!config || !scenario || !sessionId || sessionStartedAt === null || sessionEndedAt === null) return null
    return buildSessionReport(sessionId, config.mode, scenario, selfAssessment, sessionStartedAt, sessionEndedAt, rounds)
  }, [config, rounds, scenario, selfAssessment, sessionEndedAt, sessionId, sessionStartedAt])

  const copyReport = useCallback(async () => {
    if (!report) return
    await navigator.clipboard.writeText(JSON.stringify(report, null, 2))
    setCopyStatus('JSON 已复制')
  }, [report])

  const isSessionActive = sessionStartedAt !== null && sessionEndedAt === null
  const controlsLocked = ['fetching_token', 'connecting_stt', 'finalizing_transcript', 'requesting_llm', 'preparing_tts'].includes(phase)
  const reveal = deriveScenarioReveal(phase, scenario)
  const canConfirmTranscript = transcript.finalText.trim().length > 0
  const silenceCountdownSeconds = phase === 'recording'
    && microphoneMeterAvailable
    && silentSeconds >= SILENCE_COUNTDOWN_START_SECONDS
    ? Math.max(1, SILENCE_AUTO_STOP_SECONDS - silentSeconds)
    : null

  useEffect(() => {
    if (
      phase !== 'recording'
      || !microphoneMeterAvailable
      || silentSeconds < SILENCE_AUTO_STOP_SECONDS
      || silenceStopLockRef.current
    ) return
    silenceStopLockRef.current = true
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
        {(phase === 'idle' || phase === 'loading_config' || (phase === 'error' && !isSessionActive)) && (
          <section className="conversation-panel" aria-labelledby="conversation-heading">
            {!online && <p className="network-notice" role="status">网络已断开。恢复连接后可以继续。</p>}
            <Home
              loading={phase === 'loading_config'}
              ready={config !== null}
              online={online}
              error={uiError}
              homeMode={homeMode}
              setHomeMode={setHomeMode}
              customInputZh={customInputZh}
              setCustomInputZh={setCustomInputZh}
              clarifications={clarifications}
              pendingClarification={pendingClarification}
              readyScenarioData={readyScenarioData}
              isDraftingScenario={isDraftingScenario}
              onDraftScenario={handleDraftScenario}
              onAnswerClarification={handleAnswerClarification}
              onStart={() => void startSession()}
              onStartDynamic={(tok) => void startSession({ scenarioToken: tok })}
              onResetCustom={() => { setClarifications([]); setPendingClarification(null); setReadyScenarioData(null) }}
              onRetry={() => void retryFailedStep()}
            />
          </section>
        )}

        {phase === 'session_complete' && report && reveal && (
          <section className="conversation-panel" aria-labelledby="conversation-heading">
            <SessionComplete
              messages={messages}
              rounds={rounds}
              report={report}
              previousReport={previousReport}
              reveal={reveal}
              config={config}
              selfAssessment={selfAssessment}
              feedbackData={feedbackData}
              feedbackStatus={feedbackStatus}
              feedbackErrorMsg={feedbackErrorMsg}
              onRetryFeedback={() => void fetchFeedback()}
              copyStatus={copyStatus}
              onAssess={setSelfAssessment}
              onNext={() => {
                setPreviousReport(null)
                void startSession()
              }}
              onPractice={() => {
                setPreviousReport(report)
                if (scenario?.scenarioType === 'dynamic' && scenario.scenarioToken) {
                  void startSession({ scenarioToken: scenario.scenarioToken })
                } else {
                  void startSession(scenario?.id ?? null)
                }
              }}
              onCopy={() => void copyReport()}
              onDownload={() => downloadReport(report)}
              onReplayAi={(text) => void playReviewAudio(text)}
              onStopAudio={() => ttsRef.current.stop()}
              audioNotice={reviewAudioNotice}
            />
          </section>
        )}

        {isSessionActive && (
          <section className="im-chat-app" aria-label="会话">
            {/* 顶部极简 IM 导航栏 */}
            <header className="im-top-bar">
              <div className="im-top-info">
                <div className="im-top-avatar" aria-hidden="true">
                  {scenario?.dynamicData ? '💇' : '💬'}
                </div>
                <div className="im-top-meta">
                  <h2 className="im-top-name" title={scenario?.dynamicData?.aiRole || '相手'}>
                    {scenario?.dynamicData ? '相手 (発注・相談担当)' : '日本同事'}
                  </h2>
                  <span className="im-top-status" aria-live="polite">
                    {STATUS_LABELS[phase]} · 第 {turn}/{scenario?.maxTurns ?? 5} 轮
                  </span>
                </div>
              </div>
              <div className="im-top-actions">
                {scenario?.dynamicData && (
                  <button
                    className={`im-icon-pill-btn ${showGoalsSheet ? 'is-active' : ''}`}
                    type="button"
                    onClick={() => setShowGoalsSheet((show) => !show)}
                    aria-label="查看训练目标"
                  >
                    🎯 目标
                  </button>
                )}
                <button
                  className="im-finish-pill-btn"
                  type="button"
                  onClick={() => endSession(true)}
                  disabled={controlsLocked}
                >
                  {turn >= 6 ? '完成' : '退出'}
                </button>
              </div>
            </header>

            {/* 消息滚动主视口（自顶向下自然排列） */}
            <div className="im-message-viewport" ref={messageListRef}>
              {!online && <p className="im-notice-banner warning" role="status">网络已断开。恢复连接后可以继续。</p>}
              {foregroundNotice && (
                <div className="im-notice-banner info" role="status">
                  <span>{foregroundNotice}</span>
                  <button className="text-button" type="button" onClick={() => setForegroundNotice('')}>关闭</button>
                </div>
              )}

              {checkpointData && checkpointData.canExtend && checkpointData.newSessionToken && checkpointData.nextCap && (
                <div className="im-checkpoint-card">
                  <p><strong>🎯 阶段目标检查：</strong>还有 {checkpointData.remainingGoals.length} 项小目标未完成，要延长 4 轮吗？</p>
                  <div className="im-checkpoint-btns">
                    <button className="primary-button" type="button" onClick={() => handleExtendSession(checkpointData.nextCap!, checkpointData.newSessionToken!)}>
                      继续 4 轮 (至 {checkpointData.nextCap} 轮)
                    </button>
                    <button className="text-button" type="button" onClick={() => endSession(true)}>
                      直接结算
                    </button>
                  </div>
                </div>
              )}

              <div className="im-messages-list">
                {messages.map((message, index) => {
                  const isAssistant = message.role === 'assistant'
                  const isLatestAi = isAssistant && index === messages.length - 1
                  const isExpanded = expandedAiMessageIds.has(message.id) || (isLatestAi && aiTextRevealed)
                  const isActiveAudio = activeAiMessageId === message.id
                  const isPlayingThisAi = phase === 'playing_ai' && isActiveAudio
                  const isPreparingThisAi = phase === 'preparing_tts' && isActiveAudio
                  const hasPlayed = playedAiMessageIds.has(message.id)

                  return (
                    <div className={`im-message-item ${isAssistant ? 'is-ai' : 'is-user'}`} key={message.id}>
                      {isAssistant && (
                        <div className="im-sender-avatar" aria-hidden="true">
                          {scenario?.dynamicData ? '💇' : 'AI'}
                        </div>
                      )}
                      <div className="im-msg-column">
                        {isAssistant ? (
                          <>
                            {/* 微信风格相手语音条 */}
                            <button
                              className={`im-voice-bubble ${isPlayingThisAi ? 'is-playing' : ''} ${isPreparingThisAi ? 'is-preparing' : ''} ${hasPlayed ? 'is-played' : 'is-unplayed'} ${isExpanded ? 'is-expanded' : ''}`}
                              type="button"
                              onClick={() => void playAiText(message.text, true, false, undefined, message.id)}
                              aria-label={isPlayingThisAi ? '相手语音正在播放' : hasPlayed ? '重播相手语音' : '播放相手语音'}
                            >
                              <span className="im-voice-unread-dot" aria-hidden="true" />
                              <span className="im-voice-icon-box">
                                <span className="im-voice-waves" aria-hidden="true">
                                  <span /><span /><span />
                                </span>
                              </span>
                              <span className="im-voice-duration">
                                {Math.max(2, Math.round(message.text.length * 0.18))}″
                              </span>
                              <span className="im-voice-status-tip" aria-live="polite">
                                {isPlayingThisAi ? '播放中' : isPreparingThisAi ? '载入中' : hasPlayed ? '重听' : '未播放'}
                              </span>
                            </button>

                            {/* 切换台词展开 */}
                            <button
                              className="im-voice-expand-toggle"
                              type="button"
                              aria-expanded={isExpanded}
                              onClick={() => {
                                if (isLatestAi) {
                                  setAiTextRevealed((revealed) => !revealed)
                                }
                                setExpandedAiMessageIds((previous) => {
                                  const next = new Set(previous)
                                  if (next.has(message.id)) next.delete(message.id)
                                  else next.add(message.id)
                                  return next
                                })
                              }}
                            >
                              <span aria-hidden="true">{isExpanded ? '−' : '+'}</span>
                              {isExpanded ? '收起台词' : '查看台词'}
                            </button>

                            {/* 展开的文本 */}
                            {isExpanded && (
                              <div className="im-expanded-transcript">
                                <p lang="ja">{message.text}</p>
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
                {!uiError && phase === 'recording' && (
                  <div className="im-message-item is-user">
                    <div className="im-msg-column">
                      <div className={`im-recording-bubble ${silenceCountdownSeconds !== null ? 'is-counting-down' : ''}`}>
                        <span className="im-recording-pulse-dot" aria-hidden="true" />
                        <div className="im-recording-info" aria-live="polite">
                          <strong>
                            {silenceCountdownSeconds !== null
                              ? `停顿中，${silenceCountdownSeconds} 秒后结束`
                              : '正在录音中'}
                          </strong>
                          <span>{partialTranscript || '请说日语，说完点击结束'}</span>
                        </div>
                        <time className="im-recording-time">
                          {formatRecordingTime(recordingSeconds)}
                        </time>
                      </div>
                    </div>
                  </div>
                )}

                {/* 错误提示卡片 */}
                {uiError && (
                  <div className="im-error-card" role="alert">
                    <strong>⚠️ {uiError.title}</strong>
                    <p>{uiError.message}</p>
                  </div>
                )}
                <div ref={chatBottomRef} style={{ height: '1px' }} />
              </div>
            </div>

            {/* 单行极简 IM 底部控制栏 */}
            <footer className="im-bottom-dock" aria-label="操作栏">
              {uiError ? (
                <div className="im-action-row" style={{ width: '100%' }}>
                  {uiError.recovery === 'text_input' && <button className="secondary-button" type="button" onClick={enterTextInput}>改用文字</button>}
                  {uiError.recovery === 'skip_tts' && <button className="secondary-button" type="button" onClick={skipFailedTts}>显示文字继续</button>}
                  {(uiError.recovery === 'retry' || lastFailedStep) && online && <button className="primary-button" type="button" onClick={() => void retryFailedStep()}>重试</button>}
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
                    {dockInputMode === 'voice' ? '⌨️' : '🎙️'}
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
                        setTranscript({
                          rawText: dockTextValue.trim(),
                          cleanedText: dockTextValue.trim(),
                          finalText: dockTextValue.trim(),
                        })
                        setDockTextValue('')
                        setShowTranscriptSheet(true)
                        setManualInput(true)
                        transitionTo('confirming_transcript')
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
                    title="获取表达提示"
                    disabled={isLoadingHint}
                  >
                    💡
                  </button>
                </>
              ) : phase === 'recording' ? (
                <div className="im-dock-row">
                  <button
                    className={`im-dock-main-btn is-recording ${silenceCountdownSeconds !== null ? 'is-counting-down' : ''}`}
                    type="button"
                    onClick={async () => {
                      await stopRecording()
                      setShowTranscriptSheet(true)
                    }}
                  >
                    <span className="im-dock-recording-indicator" aria-hidden="true">
                      {silenceCountdownSeconds ?? '■'}
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
                    ⌨️
                  </button>
                </div>
              ) : phase === 'confirming_transcript' ? (
                <div style={{ display: 'flex', width: '100%', gap: '8px' }}>
                  <button
                    className="im-dock-main-btn"
                    type="button"
                    style={{ background: 'var(--butter)' }}
                    onClick={() => setShowTranscriptSheet(true)}
                  >
                    📝 检查/修改回答内容 ➔
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
                      <button type="button" onClick={() => setAiTextRevealed((r) => !r)}>
                        {aiTextRevealed ? '隐藏' : '显示'}
                      </button>
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
              <div className="im-bottom-sheet-backdrop" onClick={() => setShowTranscriptSheet(false)}>
                <div className="im-bottom-sheet" onClick={(e) => e.stopPropagation()}>
                  <div className="im-sheet-drag-handle" />
                  <div className="im-sheet-header">
                    <h3 className="im-sheet-title">{manualInput ? '✍️ 确认文字回答' : '🎙️ 确认语音转写'}</h3>
                    <button className="im-sheet-close-btn" type="button" onClick={() => setShowTranscriptSheet(false)}>✕</button>
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
                        setTranscript((cur: TranscriptText) => ({ ...cur, finalText: e.target.value }))
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
                          onClick={() => setShowOriginalTranscript((s) => !s)}
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
                        setShowTranscriptSheet(false)
                        void rerecord()
                      }}
                    >
                      🎙️ 重录
                    </button>
                    <button
                      className="primary-button"
                      type="button"
                      disabled={!canConfirmTranscript}
                      onClick={() => {
                        setShowTranscriptSheet(false)
                        void confirmTranscript()
                      }}
                    >
                      确认发送 ➔
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
                    <h3 className="im-sheet-title">💡 表达提示 ({Math.max(1, hintLevel)}/4 级)</h3>
                    <button className="im-sheet-close-btn" type="button" onClick={() => setShowHintSheet(false)}>✕</button>
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
                        onClick={() => setHintLevel((l) => Math.min(4, l + 1))}
                      >
                        进阶下一级提示 ➔
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
            {showGoalsSheet && scenario?.dynamicData && (
              <div className="im-bottom-sheet-backdrop" onClick={() => setShowGoalsSheet(false)}>
                <div className="im-bottom-sheet" onClick={(e) => e.stopPropagation()}>
                  <div className="im-sheet-drag-handle" />
                  <div className="im-sheet-header">
                    <h3 className="im-sheet-title">🎯 场景目标：{scenario.dynamicData.titleZh}</h3>
                    <button className="im-sheet-close-btn" type="button" onClick={() => setShowGoalsSheet(false)}>✕</button>
                  </div>
                  <div className="im-sheet-content">
                    <p style={{ fontSize: '0.85rem', color: 'var(--muted)', marginTop: 0 }}>
                      {scenario.dynamicData.summaryZh}
                    </p>
                    <div style={{ marginTop: '12px' }}>
                      <h4 style={{ fontSize: '0.85rem', color: 'var(--ink)', marginBottom: '8px' }}>核心交流任务：</h4>
                      {scenario.dynamicData.coreGoals.map((g) => (
                        <div key={g.id} className="im-goals-sheet-item is-core">
                          <h4>[核心] {g.titleZh}</h4>
                          <p>{g.descriptionZh}</p>
                        </div>
                      ))}
                    </div>
                    {scenario.dynamicData.optionalGoals.length > 0 && (
                      <div style={{ marginTop: '12px' }}>
                        <h4 style={{ fontSize: '0.85rem', color: 'var(--muted)', marginBottom: '8px' }}>进阶挑战（可选）：</h4>
                        {scenario.dynamicData.optionalGoals.map((g) => (
                          <div key={g.id} className="im-goals-sheet-item is-optional">
                            <h4>[可选] {g.titleZh}</h4>
                            <p>{g.descriptionZh}</p>
                          </div>
                        ))}
                      </div>
                    )}
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
  onStart: () => void
  onRetry: () => void
}

function Home({
  loading,
  ready,
  online,
  error,
  homeMode,
  setHomeMode,
  customInputZh,
  setCustomInputZh,
  clarifications,
  pendingClarification,
  readyScenarioData,
  isDraftingScenario,
  onDraftScenario,
  onAnswerClarification,
  onStart,
  onStartDynamic,
  onResetCustom,
  onRetry,
}: HomeProps & {
  homeMode: 'catalog' | 'custom'
  setHomeMode: (mode: 'catalog' | 'custom') => void
  customInputZh: string
  setCustomInputZh: (val: string) => void
  clarifications: Array<{ questionZh: string; answerZh: string }>
  pendingClarification: { questionZh: string; optionsZh: readonly string[] } | null
  readyScenarioData: { scenario: import('./types').DynamicScenarioData; scenarioToken: string } | null
  isDraftingScenario: boolean
  onDraftScenario: (prompt?: string, clarList?: Array<{ questionZh: string; answerZh: string }>, force?: boolean) => void
  onAnswerClarification: (ans: string) => void
  onStartDynamic: (scenarioToken: string) => void
  onResetCustom: () => void
}): React.JSX.Element {
  const [customClarifyInput, setCustomClarifyInput] = useState('')

  return (
    <div className="intro-block">
      <h1 id="conversation-heading">日语语音会话</h1>
      <p>听懂对方，完成这段交流。</p>

      <div className="mode-tabs">
        <button
          className={`mode-tab ${homeMode === 'catalog' ? 'is-active' : ''}`}
          type="button"
          onClick={() => { setHomeMode('catalog'); onResetCustom() }}
        >
          🎲 随机场景
        </button>
        <button
          className={`mode-tab ${homeMode === 'custom' ? 'is-active' : ''}`}
          type="button"
          onClick={() => setHomeMode('custom')}
        >
          ✨ 自定义场景
        </button>
      </div>

      {homeMode === 'catalog' && (
        <>
          <p className="session-length">预计 3-5 分钟 · 5 轮</p>
          <p className="microphone-hint">开始后会请求麦克风权限，录音完成后会自动释放硬件占用。</p>
          {error && (
            <div className="error-panel" role="alert">
              <div>
                <p className="error-title">{error.title}</p>
                <p>{error.message}</p>
              </div>
              <div className="error-actions">
                {online && (
                  <button className="primary-button" type="button" onClick={onRetry}>
                    重试
                  </button>
                )}
              </div>
            </div>
          )}

          <button
            className="primary-button start-button"
            type="button"
            onClick={onStart}
            disabled={loading || !ready || !online}
          >
            {loading ? '正在准备' : '开始随机练习'}
          </button>
        </>
      )}

      {homeMode === 'custom' && (
        <div className="custom-scenario-box">
          {error && (
            <div className="error-panel" role="alert">
              <div>
                <p className="error-title">{error.title}</p>
                <p>{error.message}</p>
              </div>
              <div className="error-actions">
                {online && (
                  <button className="primary-button" type="button" onClick={() => onDraftScenario()}>
                    重试生成
                  </button>
                )}
              </div>
            </div>
          )}

          {!pendingClarification && !readyScenarioData && (
            <>
              <label htmlFor="custom-topic-input"><strong>想练习什么场景？</strong>（中文描述，如：我想在日本理发店说明想要的发型）</label>
              <textarea
                id="custom-topic-input"
                className="custom-textarea"
                rows={3}
                maxLength={300}
                placeholder="例如：我马上要去日本银行开户，想询问需要哪些证件和流程"
                value={customInputZh}
                onChange={(e) => setCustomInputZh(e.target.value)}
              />
              <div className="char-count">{customInputZh.length} / 300</div>
              <button
                className="primary-button start-button"
                type="button"
                onClick={() => onDraftScenario()}
                disabled={!customInputZh.trim() || isDraftingScenario || !online}
              >
                {isDraftingScenario ? '正在设计场景...' : '生成定制练习'}
              </button>
            </>
          )}

          {pendingClarification && (
            <div className="clarification-panel">
              <p className="clarification-question"><strong>🤔 确认意图：</strong>{pendingClarification.questionZh}</p>
              <div className="clarification-options">
                {pendingClarification.optionsZh.map((opt) => (
                  <button key={opt} className="secondary-button clarify-opt-btn" type="button" onClick={() => onAnswerClarification(opt)}>
                    {opt}
                  </button>
                ))}
              </div>
              <div className="clarify-custom-row">
                <input
                  type="text"
                  className="clarify-input"
                  placeholder="或者自己输入说明..."
                  value={customClarifyInput}
                  onChange={(e) => setCustomClarifyInput(e.target.value)}
                />
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => { if (customClarifyInput.trim()) { onAnswerClarification(customClarifyInput); setCustomClarifyInput('') } }}
                  disabled={!customClarifyInput.trim()}
                >
                  回答
                </button>
              </div>
              <button className="text-button skip-clarify-btn" type="button" onClick={() => onDraftScenario(customInputZh, clarifications, true)}>
                跳过追问，直接生成 ➔
              </button>
            </div>
          )}

          {readyScenarioData && (
            <div className="ready-scenario-card">
              <p className="ready-badge">✨ 定制场景已就绪</p>
              <h3>{readyScenarioData.scenario.titleZh}</h3>
              <p className="ready-desc">{readyScenarioData.scenario.summaryZh}</p>
              <div className="ready-meta">
                <p><strong>相手身份：</strong>{readyScenarioData.scenario.aiRole}</p>
                <p><strong>你的角色：</strong>{readyScenarioData.scenario.userRole}</p>
              </div>
              <div className="ready-goals">
                <strong>🎯 训练目标 (6~8 轮自适应)：</strong>
                <ul>
                  {readyScenarioData.scenario.coreGoals.map((g) => (
                    <li key={g.id}><strong>[核心]</strong> {g.titleZh}: {g.descriptionZh}</li>
                  ))}
                  {readyScenarioData.scenario.optionalGoals.map((g) => (
                    <li key={g.id}><span>[可选]</span> {g.titleZh}: {g.descriptionZh}</li>
                  ))}
                </ul>
              </div>
              <div className="ready-actions">
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => onStartDynamic(readyScenarioData.scenarioToken)}
                  disabled={loading || !online}
                >
                  开始对练 (相手先发话)
                </button>
                <button className="text-button" type="button" onClick={onResetCustom}>
                  修改描述
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}


interface SessionCompleteProps {
  messages: ConversationMessage[]
  rounds: RoundRecord[]
  report: SessionReport
  previousReport: SessionReport | null
  reveal: SessionScenario['reveal']
  config: PrototypeConfig | null
  selfAssessment: SelfAssessment
  feedbackData: ConversationFeedbackResponse | null
  feedbackStatus: FeedbackLoadingState
  feedbackErrorMsg: string
  onRetryFeedback: () => void
  copyStatus: string
  onAssess: (assessment: SelfAssessment) => void
  onNext: () => void
  onPractice: () => void
  onCopy: () => void
  onDownload: () => void
  onReplayAi: (text: string) => void
  onStopAudio: () => void
  audioNotice: string
}

function SessionComplete({
  messages,
  rounds,
  report,
  previousReport,
  reveal,
  config,
  selfAssessment,
  feedbackData,
  feedbackStatus,
  feedbackErrorMsg,
  onRetryFeedback,
  copyStatus,
  onAssess,
  onNext,
  onPractice,
  onCopy,
  onDownload,
  onReplayAi,
  onStopAudio,
  audioNotice,
}: SessionCompleteProps): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<'conversation' | 'feedback'>('conversation')
  const [expandedTurns, setExpandedTurns] = useState<Record<number, boolean>>({})
  const [expandedSuggestions, setExpandedSuggestions] = useState<Record<string, boolean>>({})

  // Retry Task state
  const [retryAudioState, setRetryAudioState] = useState<'idle' | 'recording' | 'confirming' | 'completed'>('idle')
  const [retryTranscript, setRetryTranscript] = useState('')
  const [, setRetryInputMode] = useState<'stt' | 'text'>('stt')
  const [retryFinalText, setRetryFinalText] = useState('')
  const [retryErrorMsg, setRetryErrorMsg] = useState('')
  const retrySttRef = useRef<RealtimeSttSession | null>(null)
  useEffect(() => () => {
    retrySttRef.current?.close()
    retrySttRef.current = null
  }, [])

  const practiceTrend = useMemo(() => buildPracticeTrend(previousReport, report), [previousReport, report])

  const handleStartRetryRecord = async () => {
    onStopAudio()
    setRetryErrorMsg('')
    if (!config?.elevenlabs.sttAvailable) {
      setRetryInputMode('text')
      setRetryAudioState('confirming')
      return
    }
    try {
      setRetryAudioState('recording')
      setRetryTranscript('')
      const token = await requestElevenLabsToken('realtime_scribe')
      const session = new RealtimeSttSession()
      retrySttRef.current = session
      await session.start(token, config.elevenlabs.sttModel, {
        onPartial: (text) => {
          setRetryTranscript(text)
        },
        onConnectionState: () => {},
        onAudioLevel: () => {},
      })
    } catch (err) {
      retrySttRef.current?.close()
      retrySttRef.current = null
      setRetryInputMode('text')
      setRetryAudioState('confirming')
      setRetryErrorMsg(err instanceof Error ? err.message : '麦克风启动失败，已切换为文字重说。')
    }
  }

  const handleStopRetryRecord = async () => {
    if (!retrySttRef.current) return
    try {
      setRetryAudioState('confirming')
      const finalRaw = await retrySttRef.current.stop()
      retrySttRef.current.close()
      retrySttRef.current = null
      const cleaned = cleanTranscript(finalRaw)
      setRetryTranscript(cleaned.cleanedText)
    } catch {
      retrySttRef.current?.close()
      retrySttRef.current = null
      setRetryAudioState('confirming')
    }
  }

  const handleConfirmRetry = (confirmedText: string) => {
    if (!confirmedText.trim()) {
      setRetryErrorMsg('重说内容不能为空。')
      return
    }
    setRetryFinalText(confirmedText.trim())
    setRetryAudioState('completed')
    setRetryErrorMsg('')
  }

  const improvementsByTurn = useMemo(() => {
    if (!feedbackData?.improvements) return {}
    const map: Record<number, FeedbackImprovement[]> = {}
    for (const item of feedbackData.improvements) {
      if (!map[item.turn]) map[item.turn] = []
      map[item.turn].push(item)
    }
    return map
  }, [feedbackData])
  const roundsByTurn = useMemo(() => {
    const map: Record<number, RoundRecord> = {}
    for (const r of rounds) {
      map[r.turn] = r
    }
    return map
  }, [rounds])

  return (
    <div className="complete-view">
      <p className="brand-mark">完成</p>
      <h1 id="conversation-heading">{reveal.titleZh}</h1>
      <p className="reveal-summary">{reveal.summaryZh}</p>
      {audioNotice && <p className="network-notice" role="status">{audioNotice}</p>}

      <div className="review-tabs">
        <button
          className={`review-tab ${activeTab === 'conversation' ? 'is-active' : ''}`}
          type="button"
          onClick={() => setActiveTab('conversation')}
        >
          💬 完整对话
        </button>
        <button
          className={`review-tab ${activeTab === 'feedback' ? 'is-active' : ''}`}
          type="button"
          onClick={() => setActiveTab('feedback')}
        >
          ✨ 反馈重点
          {feedbackStatus === 'loading' && <span className="tab-badge">生成中</span>}
          {feedbackStatus === 'success' && <span className="tab-badge is-ready">就绪</span>}
          {feedbackStatus === 'error' && <span className="tab-badge is-error">失败</span>}
        </button>
      </div>

      {activeTab === 'conversation' && (
        <div className="review-conversation-tab">
          {practiceTrend.hasPrevious && (
            <section className="practice-trend-card" aria-labelledby="trend-heading">
              <h2 id="trend-heading">📈 同场景二刷趋势对比</h2>
              <p className="trend-narrative">{practiceTrend.narrativeZh}</p>
              <div className="trend-grid">
                {practiceTrend.metrics.map((m, idx) => (
                  <div key={idx} className={`trend-item is-${m.direction}`}>
                    <span className="trend-metric-label">{m.labelZh}</span>
                    <div className="trend-metric-values">
                      <span>上次：{m.previousDisplay}</span>
                      <span>本次：{m.currentDisplay}</span>
                    </div>
                    <strong className="trend-metric-delta">变化：{m.deltaDisplay}</strong>
                  </div>
                ))}
              </div>
            </section>
          )}

          <section className="self-assessment" aria-labelledby="assessment-heading">
            <h2 id="assessment-heading">这段交流完成得怎么样？</h2>
            <div>
              {([
                ['completed', '完成了'],
                ['partial', '部分完成'],
                ['not_completed', '没完成'],
              ] as const).map(([value, label]) => (
                <button
                  className={`assessment-button ${selfAssessment === value ? 'is-selected' : ''}`}
                  type="button"
                  key={value}
                  onClick={() => onAssess(value)}
                  aria-pressed={selfAssessment === value}
                >
                  {label}
                </button>
              ))}
            </div>
          </section>

          <ol className="review-transcript-list" aria-label="完整对话回顾">
            {messages.map((message) => {
              if (message.role === 'assistant') {
                return (
                  <li key={message.id} className="review-message assistant">
                    <div className="review-message-header">
                      <span className="speaker-tag">相手 (第 {message.turn} 轮)</span>
                      <button
                        className="text-button replay-button"
                        type="button"
                        onClick={() => onReplayAi(message.text)}
                      >
                        🔊 再听
                      </button>
                    </div>
                    <p className="review-message-text" lang="ja">{message.text}</p>
                  </li>
                )
              }

              const turnRecord = roundsByTurn[message.turn]
              const isTurnExpanded = Boolean(expandedTurns[message.turn])
              const turnImprovements = improvementsByTurn[message.turn] ?? []

              return (
                <li key={message.id} className="review-message user">
                  <div className="review-message-header">
                    <span className="speaker-tag">你 (第 {message.turn} 轮)</span>
                    <button
                      className="text-button toggle-details-btn"
                      type="button"
                      onClick={() =>
                        setExpandedTurns((prev) => ({
                          ...prev,
                          [message.turn]: !prev[message.turn],
                        }))
                      }
                    >
                      {isTurnExpanded ? '收起详情' : '展开详情'}
                    </button>
                  </div>

                  <p className="review-message-text" lang="ja">{message.text}</p>

                  {turnImprovements.length > 0 && (
                    <div className="turn-improvements-box">
                      {turnImprovements.map((imp, idx) => {
                        const sugKey = `${message.turn}-${idx}`
                        const isSugOpen = Boolean(expandedSuggestions[sugKey])
                        return (
                          <div key={sugKey} className="improvement-chip-block">
                            <button
                              className="improvement-chip"
                              type="button"
                              onClick={() =>
                                setExpandedSuggestions((prev) => ({
                                  ...prev,
                                  [sugKey]: !prev[sugKey],
                                }))
                              }
                            >
                              💡 建议 {idx + 1}：{imp.type === 'grammar_fix' ? '语法修正' : '地道表达'} {isSugOpen ? '▲' : '▼'}
                            </button>
                            {isSugOpen && (
                              <div className="improvement-dropdown">
                                <p><strong>原句：</strong><span lang="ja">{imp.originalQuoteJa}</span></p>
                                <p><strong>建议：</strong><span lang="ja">{imp.suggestedJa}</span></p>
                                <p><strong>原因：</strong>{imp.reasonZh}</p>
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}

                  {isTurnExpanded && (
                    <div className="transcript-details-panel">
                      <p><strong>STT 识别原文：</strong><span lang="ja">{turnRecord?.userOriginal || message.transcript?.rawText || '（无）'}</span></p>
                      <p><strong>系统整理稿：</strong><span lang="ja">{turnRecord?.userCleaned || message.transcript?.cleanedText || '（无）'}</span></p>
                      <p><strong>最终提交稿：</strong><span lang="ja">{message.text}</span></p>
                      <p><strong>是否手动修改：</strong>{turnRecord?.transcriptModified ? '是（手动调整过）' : '否（直接确认）'}</p>
                      <p><strong>使用提示等级：</strong>{turnRecord?.hintLevelUsed ? `第 ${turnRecord.hintLevelUsed} 级` : '未用提示'}</p>
                    </div>
                  )}
                </li>
              )
            })}
          </ol>
        </div>
      )}

      {activeTab === 'feedback' && (
        <div className="review-feedback-tab">
          {feedbackStatus === 'loading' && (
            <div className="feedback-loading-card">
              <span className="pulse-dot" />
              <p>AI 教练正在分析这段对话并生成针对性反馈...</p>
            </div>
          )}

          {feedbackStatus === 'error' && (
            <div className="feedback-error-card" role="alert">
              <p><strong>反馈获取失败：</strong>{feedbackErrorMsg || '网络波动或服务繁忙。'}</p>
              <button className="primary-button" type="button" onClick={onRetryFeedback}>
                重新生成反馈
              </button>
            </div>
          )}

          {feedbackStatus === 'success' && feedbackData && (
            <div className="feedback-content">
              <section className="feedback-section goal-summary-card">
                <h2>🎯 交流目标达成总结</h2>
                <p>{feedbackData.goalSummaryZh}</p>
              </section>

              <section className="feedback-section strengths-card">
                <h2>👏 表现出色的两处（Strengths）</h2>
                <ul className="feedback-list">
                  {feedbackData.strengths.map((item, idx) => (
                    <li key={idx}>
                      <p className="feedback-quote" lang="ja">「{item.quoteJa}」</p>
                      <p className="feedback-desc">{item.praiseZh}</p>
                    </li>
                  ))}
                </ul>
              </section>

              <section className="feedback-section improvements-card">
                <h2>🔧 改进与地道表达建议（Improvements）</h2>
                <ul className="feedback-list">
                  {feedbackData.improvements.map((item, idx) => (
                    <li key={idx}>
                      <div className="improvement-tag-row">
                        <span className="improvement-turn-tag">第 {item.turn} 轮</span>
                        <span className="improvement-type-tag">
                          {item.type === 'grammar_fix' ? '语法修正' : '地道表达'}
                        </span>
                      </div>
                      <p className="feedback-quote" lang="ja">原句：{item.originalQuoteJa}</p>
                      <p className="feedback-suggestion" lang="ja">👉 推荐：{item.suggestedJa}</p>
                      <p className="feedback-desc">原因：{item.reasonZh}</p>
                    </li>
                  ))}
                </ul>
              </section>

              <section className="feedback-section expressions-card">
                <h2>📚 值得复用的句型表达（Reusable Expressions）</h2>
                <div className="expressions-grid">
                  {feedbackData.reusableExpressions.map((item, idx) => (
                    <div key={idx} className="expression-item">
                      <p className="expression-pattern" lang="ja"><strong>{item.patternJa}</strong></p>
                      <p className="expression-meaning">{item.meaningZh}</p>
                      <p className="expression-example" lang="ja">例：{item.usageExampleJa}</p>
                    </div>
                  ))}
                </div>
              </section>

              <section className="feedback-section master-upgrade-card">
                <h2>⭐ 整体升级回答（Master Upgrade）</h2>
                <p className="upgrade-meta">基于第 {feedbackData.masterUpgrade.turn} 轮回答的高阶进阶版本：</p>
                <div className="upgrade-compare">
                  <div className="compare-col original">
                    <span>原表达</span>
                    <p lang="ja">{feedbackData.masterUpgrade.originalJa}</p>
                  </div>
                  <div className="compare-col upgraded">
                    <span>高阶表达</span>
                    <p lang="ja">{feedbackData.masterUpgrade.upgradedJa}</p>
                  </div>
                </div>
                <p className="upgrade-explanation">{feedbackData.masterUpgrade.explanationZh}</p>
              </section>

              <section className="feedback-section retry-task-card">
                <h2>🎯 针对性单句重说（Targeted Retry）</h2>
                <div className="retry-task-context">
                  <p><strong>相手当时问题 (第 {feedbackData.retryTask.turn} 轮)：</strong><span lang="ja">{feedbackData.retryTask.targetAiPromptJa}</span></p>
                  <p><strong>你的第一次回答：</strong><span lang="ja">{feedbackData.retryTask.userOriginalJa}</span></p>
                  <div className="retry-ref-row">
                    <p><strong>推荐参考句：</strong><span lang="ja">{feedbackData.retryTask.recommendedReferenceJa}</span></p>
                    <button
                      className="text-button play-ref-btn"
                      type="button"
                      onClick={() => onReplayAi(feedbackData.retryTask.recommendedReferenceJa)}
                    >
                      🔊 听参考表达
                    </button>
                  </div>
                  <p className="retry-hint">💡 中文思路提示：{feedbackData.retryTask.hintZh}</p>
                </div>

                {retryErrorMsg && <p className="inline-error" role="alert">{retryErrorMsg}</p>}

                {retryAudioState === 'idle' && (
                  <div className="retry-actions">
                    <button className="primary-button retry-mic-btn" type="button" onClick={() => void handleStartRetryRecord()}>
                      🎙️ 开始重说 (录音)
                    </button>
                    <button
                      className="text-button retry-text-toggle"
                      type="button"
                      onClick={() => {
                        setRetryInputMode('text')
                        setRetryAudioState('confirming')
                        setRetryTranscript('')
                      }}
                    >
                      改用文字重说
                    </button>
                  </div>
                )}

                {retryAudioState === 'recording' && (
                  <div className="retry-recording-panel">
                    <div className="recording-label">
                      <span />
                      <strong>正在听你重说...</strong>
                    </div>
                    <p className="live-transcript" lang="ja">{retryTranscript || '（请开口说话）'}</p>
                    <button className="primary-button finish-button" type="button" onClick={() => void handleStopRetryRecord()}>
                      说完了，确认转写
                    </button>
                  </div>
                )}

                {retryAudioState === 'confirming' && (
                  <div className="retry-confirming-panel">
                    <label htmlFor="retry-text-input"><strong>确认重说内容：</strong></label>
                    <textarea
                      id="retry-text-input"
                      className="retry-textarea"
                      value={retryTranscript}
                      onChange={(e) => setRetryTranscript(e.target.value)}
                      lang="ja"
                      rows={3}
                    />
                    <div className="retry-confirm-buttons">
                      <button className="secondary-button" type="button" onClick={() => void handleStartRetryRecord()}>
                        重新录音
                      </button>
                      <button className="primary-button" type="button" onClick={() => handleConfirmRetry(retryTranscript)}>
                        确认完成重说
                      </button>
                    </div>
                  </div>
                )}

                {retryAudioState === 'completed' && (
                  <div className="retry-completed-panel">
                    <h3>✨ 第一次 vs 这次重说 文本对比</h3>
                    <div className="retry-comparison-grid">
                      <div className="retry-comp-col original">
                        <span>第一次回答</span>
                        <p lang="ja">{feedbackData.retryTask.userOriginalJa}</p>
                      </div>
                      <div className="retry-comp-col retried">
                        <span>重说回答</span>
                        <p lang="ja">{retryFinalText}</p>
                      </div>
                    </div>
                    <div className="retry-re-actions">
                      <button
                        className="text-button"
                        type="button"
                        onClick={() => {
                          setRetryAudioState('idle')
                          setRetryFinalText('')
                          setRetryTranscript('')
                        }}
                      >
                        再重说一次
                      </button>
                    </div>
                  </div>
                )}
              </section>
            </div>
          )}
        </div>
      )}

      <details className="developer-disclosure">
        <summary>开发信息</summary>
        <div className="completion-totals">
          <div><span>总时长</span><strong>{formatDuration(report.durationMilliseconds)}</strong></div>
          <div><span>重录</span><strong>{report.totals.rerecordCount}</strong></div>
          <div><span>失败 / 重试</span><strong>{report.totals.failureCount} / {report.totals.retryCount}</strong></div>
        </div>
        <div className="round-table-wrap">
          <table className="round-table">
            <thead>
              <tr>
                <th>轮次</th>
                <th>说完→转写</th>
                <th>提交→首字</th>
                <th>回复→播放</th>
                <th>修改</th>
                <th>重录</th>
                <th>提示</th>
              </tr>
            </thead>
            <tbody>
              {report.rounds.map((round) => (
                <tr key={round.turn}>
                  <td>{round.turn}</td>
                  <td>{formatDuration(duration(round.timing.recordingStoppedAt, round.timing.transcriptFinalizedAt))}</td>
                  <td>{formatDuration(duration(round.timing.transcriptConfirmedAt, round.timing.llmFirstTextAt))}</td>
                  <td>{formatDuration(duration(round.timing.llmCompletedAt, round.timing.audioStartedAt))}</td>
                  <td>{round.transcriptModified ? '是' : '否'}</td>
                  <td>{round.rerecordCount}</td>
                  <td>{round.hintLevelUsed > 0 ? `L${round.hintLevelUsed}` : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <dl className="usage-list">
          <div><dt>输入 token</dt><dd>{report.totals.inputTokens ?? '未返回'}</dd></div>
          <div><dt>输出 token</dt><dd>{report.totals.outputTokens ?? '未返回'}</dd></div>
          <div><dt>录音会话 / 音频</dt><dd>{report.totals.sttSessionCount} / {formatDuration(report.totals.sttAudioMilliseconds)}</dd></div>
          <div><dt>语音请求 / 字符</dt><dd>{report.totals.ttsRequestCount} / {report.totals.ttsCharacterCount}</dd></div>
        </dl>
        <div className="developer-actions">
          <button className="secondary-button" type="button" onClick={onCopy}>复制 JSON</button>
          <button className="text-button" type="button" onClick={onDownload}>下载 JSON</button>
          {copyStatus && <span role="status">{copyStatus}</span>}
        </div>
        <div className="data-note"><p>对话记录和用量只用于本次开发观察。</p></div>
      </details>

      <div className="complete-actions">
        <button className="primary-button" type="button" onClick={onNext}>再来一个</button>
        <button className="secondary-button" type="button" onClick={onPractice}>重练这个</button>
      </div>
    </div>
  )
}

export default App
