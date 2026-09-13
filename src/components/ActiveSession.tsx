/**
 * [INPUT]: 含判别式开场的活动会话 view model、控制器派生状态与会话动作
 * [OUTPUT]: 渲染双开场活动聊天、仅真实相手消息的听力支架、录音、转写确认与提示/目标 sheet
 * [POS]: src/components 的活动会话纯视图；不拥有网络、存储或媒体 controller 生命周期
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { AlertCircle, ArrowRight, Keyboard, Lightbulb, MessageCircle, Mic, Pencil, Square, Target, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { requestElevenLabsToken } from '../lib/api'
import { releaseMicrophoneStream, shouldTeardownOnVisibility } from '../lib/audio-engine'
import { coordinateRecordingSetup } from '../lib/recording-setup'
import { RealtimeSttSession } from '../lib/stt'
import { formatRecordingTime } from '../lib/audio-feedback'
import type { ActiveSpeechAssistState } from '../lib/speech-assist'
import type { InterruptionRecoveryAffordances, InterruptionRecoveryEvent, InterruptionRecoveryState, InterruptionRecoveryTarget } from '../lib/session'
import type { AppPhase, ConversationMessage, HintResponse, ListeningScaffoldLevel, PreviousAdvice, ScenarioOpening, TranscriptText, UiError } from '../types'

interface ListeningRequestState {
  loading: boolean
  error: string
}

const STATUS_LABELS: Record<AppPhase, string> = {
  loading_config: '正在准备练习', idle: '准备开始', fetching_token: '正在准备语音识别连接…',
  connecting_stt: '正在启动语音输入', waiting_user: '轮到你回答', recording: '正在听你说话',
  finalizing_transcript: '正在整理你的回答', confirming_transcript: '确认你的回答',
  requesting_llm: '正在等待相手回复', preparing_tts: '正在准备相手语音', playing_ai: '相手正在说话',
  round_complete: '本轮完成', session_complete: '会话完成', error: '需要处理',
}

function nextListeningAction(level: ListeningScaffoldLevel): string | null {
  if (level === 0) return '没听懂'
  if (level === 1) return '查看关键信息'
  if (level === 2) return '查看日语台词'
  if (level === 3) return '查看这句话想表达什么'
  return null
}

function MicIcon(): React.JSX.Element {
  return <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" focusable="false" aria-hidden="true"><rect x="8" y="3" width="8" height="12" rx="4" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8" /></svg>
}

export interface ActiveSessionModel {
  phase: AppPhase
  scenario: { maxTurns: number; dynamicData: { aiRole: string; titleZh: string; summaryZh: string; coreGoal: { titleZh: string; descriptionZh: string }; opening: ScenarioOpening } } | null
  turn: number
  controlsLocked: boolean
  showGoalsSheet: boolean
  sessionCoreGoal: { titleZh: string; descriptionZh: string } | null
  recoveryMessage: string
  interruptionRecovery: InterruptionRecoveryState
  interruptionRecoveryAffordances: InterruptionRecoveryAffordances
  recoveryTarget: InterruptionRecoveryTarget | null
  online: boolean
  effectiveForegroundNotice: string
  messages: ConversationMessage[]
  listeningRequestStates: Record<string, ListeningRequestState>
  activeAiMessageId: string | null
  pausedAiMessageId: string | null
  playedAiMessageIds: ReadonlySet<string>
  activeError: UiError | null
  activeFailedStep: 'config' | 'scenario' | 'token' | 'stt' | 'llm' | 'tts' | null
  silencePromptVisible: boolean
  activeAssistIsVisible: boolean
  activeAssistState: ActiveSpeechAssistState | null
  confirmedTranscript: string
  interimTranscript: string
  partialTranscript: string
  recordingSeconds: number
  dockInputMode: 'voice' | 'text'
  dockTextValue: string
  hintData: HintResponse | null
  isLoadingHint: boolean
  hintLevel: 0 | 1 | 2 | 3 | 4
  showHintSheet: boolean
  showTranscriptSheet: boolean
  manualInput: boolean
  transcript: TranscriptText
  showOriginalTranscript: boolean
  inlineError: string
  canConfirmTranscript: boolean
  sttAvailable: boolean
  sttModel: string
  ttsAvailable: boolean
  reviewAudioNotice: string
  previousAdvice?: PreviousAdvice
}

export interface ActiveSessionActions {
  endSession(includeConfirmedCurrent: boolean): void
  setShowGoalsSheet: Dispatch<SetStateAction<boolean>>
  dispatchInterruptionRecovery: Dispatch<InterruptionRecoveryEvent>
  setAppForegroundNotice: Dispatch<SetStateAction<string>>
  clearVoiceNotice(): void
  getListeningLevel(message: ConversationMessage): ListeningScaffoldLevel
  replayPartnerMessage(message: ConversationMessage): void
  advanceListeningScaffold(message: ConversationMessage): Promise<void>
  setDockInputMode: Dispatch<SetStateAction<'voice' | 'text'>>
  startRecording(): Promise<void>
  enterTextInput(): void
  enterLifecycleTextInput(): void
  updateFinalText(value: string): void
  setDockTextValue: Dispatch<SetStateAction<string>>
  openTranscriptSheet(): void
  handleRequestHint(intentionZh?: string): Promise<void>
  setShowHintSheet: Dispatch<SetStateAction<boolean>>
  stopRecording(): Promise<void>
  skipFailedTts(): void
  retryFailedStep(): Promise<void>
  resetSession(): void
  stopAiPlayback(): void
  releaseAiPlayback(): void
  playReviewAudio(text: string): Promise<void>
  closeTranscriptSheet(): void
  rerecord(): Promise<void>
  confirmTranscript(): Promise<void>
  setInlineError: Dispatch<SetStateAction<string>>
  toggleOriginalTranscript(): void
  onPreviousAdviceViewed?(): void
}

export interface ActiveSessionProps {
  model: ActiveSessionModel
  actions: ActiveSessionActions
  messageListRef: RefObject<HTMLDivElement | null>
  chatBottomRef: RefObject<HTMLDivElement | null>
}

export function ActiveSession({ model, actions, messageListRef, chatBottomRef }: ActiveSessionProps): React.JSX.Element {
  const {
    phase, scenario, turn, controlsLocked, showGoalsSheet, sessionCoreGoal, recoveryMessage, interruptionRecovery,
    interruptionRecoveryAffordances, recoveryTarget, online, effectiveForegroundNotice, messages, listeningRequestStates,
    activeAiMessageId, pausedAiMessageId, playedAiMessageIds, activeError, activeFailedStep, silencePromptVisible, activeAssistIsVisible,
    activeAssistState, confirmedTranscript, interimTranscript, partialTranscript, recordingSeconds, dockInputMode,
    dockTextValue, hintData, isLoadingHint, hintLevel, showHintSheet, showTranscriptSheet, manualInput, transcript,
    showOriginalTranscript, inlineError, canConfirmTranscript,
  } = model
  const {
    endSession, setShowGoalsSheet, dispatchInterruptionRecovery, setAppForegroundNotice, clearVoiceNotice,
    getListeningLevel, replayPartnerMessage, advanceListeningScaffold, setDockInputMode, startRecording, enterTextInput, enterLifecycleTextInput,
    updateFinalText, setDockTextValue, openTranscriptSheet, handleRequestHint, setShowHintSheet, stopRecording,
    skipFailedTts, retryFailedStep, resetSession, stopAiPlayback, closeTranscriptSheet, rerecord, confirmTranscript,
    setInlineError, toggleOriginalTranscript, releaseAiPlayback, playReviewAudio, onPreviousAdviceViewed,
  } = actions
  const [intentionZh, setIntentionZh] = useState('')
  const [intentionRecording, setIntentionRecording] = useState(false)
  const [intentionConnected, setIntentionConnected] = useState(false)
  const [intentionError, setIntentionError] = useState('')
  const [intentionSubmitted, setIntentionSubmitted] = useState(false)
  const [showPreviousAdvice, setShowPreviousAdvice] = useState(false)
  const [showTopMoreMenu, setShowTopMoreMenu] = useState(false)
  const topMoreMenuRef = useRef<HTMLDivElement | null>(null)
  const topMoreButtonRef = useRef<HTMLButtonElement | null>(null)
  const intentionSttRef = useRef<RealtimeSttSession | null>(null)
  const intentionAbortRef = useRef<AbortController | null>(null)
  const intentionGenerationRef = useRef(0)
  const intentionOwnsMicRef = useRef(false)
  const intentionBaseRef = useRef('')
  const intentionSessionRef = useRef<RealtimeSttSession | null>(null)
  const intentionStoppingRef = useRef<RealtimeSttSession | null>(null)
  const intentionConnectedRef = useRef<RealtimeSttSession | null>(null)
  const previousTurnRef = useRef(turn)
  const previousPhaseRef = useRef<AppPhase | null>(null)
  const cancelIntentionRecording = useCallback((session = intentionSttRef.current, controller = intentionAbortRef.current) => {
    if (!session || intentionSttRef.current !== session) return
    intentionGenerationRef.current += 1
    controller?.abort()
    session.close()
    if (intentionOwnsMicRef.current) releaseMicrophoneStream()
    intentionOwnsMicRef.current = false
    intentionAbortRef.current = null
    intentionSttRef.current = null
    intentionSessionRef.current = null
    intentionStoppingRef.current = null
    intentionConnectedRef.current = null
    intentionBaseRef.current = ''
    setIntentionRecording(false)
    setIntentionConnected(false)
  }, [])
  useEffect(() => cancelIntentionRecording, [cancelIntentionRecording])
  useEffect(() => {
    const stop = () => { if (document.hidden && shouldTeardownOnVisibility(true)) cancelIntentionRecording() }
    document.addEventListener('visibilitychange', stop)
    return () => document.removeEventListener('visibilitychange', stop)
  }, [cancelIntentionRecording])
  useEffect(() => {
    if (!online) cancelIntentionRecording()
  }, [cancelIntentionRecording, online])
  useEffect(() => {
    const stop = () => cancelIntentionRecording()
    window.addEventListener('pagehide', stop)
    return () => window.removeEventListener('pagehide', stop)
  }, [cancelIntentionRecording])
  useEffect(() => {
    if (previousTurnRef.current === turn) return
    previousTurnRef.current = turn
    cancelIntentionRecording()
    setIntentionZh('')
    setIntentionSubmitted(false)
    setShowPreviousAdvice(false)
  }, [cancelIntentionRecording, turn])
  useEffect(() => {
    if (!showTopMoreMenu) return
    const closeOnPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Node) || topMoreMenuRef.current?.contains(target) || topMoreButtonRef.current?.contains(target)) return
      setShowTopMoreMenu(false)
    }
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setShowTopMoreMenu(false)
    }
    document.addEventListener('pointerdown', closeOnPointerDown)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [showTopMoreMenu])
  useEffect(() => { if (!showHintSheet) cancelIntentionRecording() }, [cancelIntentionRecording, showHintSheet])
  useEffect(() => {
    const enteredConfirmation = phase === 'confirming_transcript' && previousPhaseRef.current !== 'confirming_transcript'
    previousPhaseRef.current = phase
    if (enteredConfirmation && !showTranscriptSheet) openTranscriptSheet()
  }, [openTranscriptSheet, phase, showTranscriptSheet])
  const startIntentionRecording = useCallback(async () => {
    if (!model.sttAvailable || !model.sttModel || phase === 'recording' || intentionSttRef.current) return
    releaseAiPlayback()
    const generation = ++intentionGenerationRef.current
    const session = new RealtimeSttSession()
    const controller = new AbortController()
    intentionSttRef.current = session
    intentionSessionRef.current = session
    intentionConnectedRef.current = null
    intentionBaseRef.current = intentionZh.trim() ? `${intentionZh.trim()} ` : ''
    intentionAbortRef.current = controller
    intentionOwnsMicRef.current = true
    setIntentionError('')
    setIntentionRecording(true)
    setIntentionConnected(false)
    try {
      await coordinateRecordingSetup({
        acquireToken: () => requestElevenLabsToken('realtime_scribe', controller.signal),
        isCancelled: () => controller.signal.aborted || generation !== intentionGenerationRef.current,
        releaseOnCancelled: false,
        connectStt: async (token) => {
          await session.start(token, model.sttModel, { onPartial: (text) => { if (generation === intentionGenerationRef.current && intentionSttRef.current === session && !document.hidden) setIntentionZh(`${intentionBaseRef.current}${text}`.slice(0, 500)) }, onConnectionState: () => undefined, onAudioLevel: () => undefined }, 'zh')
          if (generation === intentionGenerationRef.current && intentionSttRef.current === session) {
            intentionConnectedRef.current = session
            setIntentionConnected(true)
          }
        },
      })
    } catch (error) {
      if (generation === intentionGenerationRef.current && !controller.signal.aborted) setIntentionError(error instanceof Error ? error.message : '中文语音暂时无法启动。')
      cancelIntentionRecording(session, controller)
    }
  }, [cancelIntentionRecording, intentionZh, model.sttAvailable, model.sttModel, phase, releaseAiPlayback])
  const stopIntentionRecording = useCallback(async () => {
    const session = intentionSttRef.current
    const generation = intentionGenerationRef.current
    if (!session || intentionSessionRef.current !== session || intentionStoppingRef.current) return
    if (intentionConnectedRef.current !== session) {
      cancelIntentionRecording(session)
      return
    }
    intentionStoppingRef.current = session
    try {
      const text = await session.stop()
      if (generation === intentionGenerationRef.current && intentionSttRef.current === session && text.trim() && !document.hidden) setIntentionZh(`${intentionBaseRef.current}${text.trim()}`.slice(0, 500))
    } catch (error) {
      if (generation === intentionGenerationRef.current && intentionSttRef.current === session) setIntentionError(error instanceof Error ? error.message : '中文语音识别失败。')
    } finally {
      if (generation === intentionGenerationRef.current && intentionSttRef.current === session) cancelIntentionRecording(session)
    }
  }, [cancelIntentionRecording])
  const submitIntentionHint = (): void => {
    const value = intentionZh.trim()
    if (!value) return
    setIntentionSubmitted(true)
    void handleRequestHint(value)
  }
  const startJapaneseRecording = (): void => {
    void startRecording()
  }
  const toggleGoalsSheet = (): void => {
    setShowGoalsSheet((show) => !show)
  }
  const togglePreviousAdvice = (): void => {
    if (!showPreviousAdvice) onPreviousAdviceViewed?.()
    setShowPreviousAdvice((shown) => !shown)
  }
  const endSessionEarly = (): void => {
    endSession(true)
  }
  const toggleTopMoreMenu = (): void => {
    setShowTopMoreMenu((shown) => !shown)
  }
  const showPreviousAdviceFromMenu = (): void => {
    setShowTopMoreMenu(false)
    togglePreviousAdvice()
  }
  const endSessionFromMenu = (): void => {
    setShowTopMoreMenu(false)
    endSessionEarly()
  }
  return (
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
                    {phase === 'waiting_user' && turn === 1 && scenario?.dynamicData.opening.speaker === 'user' ? '轮到你开场' : STATUS_LABELS[phase]} · 第 {turn}/{scenario?.maxTurns ?? 5} 轮
                  </span>
                </div>
              </div>
              <div className="im-top-actions">
                <div className="im-top-desktop-actions">
                  {model.previousAdvice && (phase === 'waiting_user' || phase === 'round_complete') && <button className="im-icon-pill-btn" type="button" onClick={togglePreviousAdvice} aria-label="查看上次建议">上次建议</button>}
                  <button
                    className={`im-icon-pill-btn ${showGoalsSheet ? 'is-active' : ''}`}
                    type="button"
                    onClick={toggleGoalsSheet}
                    aria-label={sessionCoreGoal ? `查看会话目标：${sessionCoreGoal.titleZh}` : '查看会话目标'}
                  >
                    <Target size={15} />
                    <span className="im-btn-text-full">目标</span>
                  </button>
                  <button className="im-finish-pill-btn" type="button" onClick={endSessionEarly} disabled={controlsLocked} aria-label="提前复盘并结束会话">提前复盘</button>
                </div>
                <button
                  className={`im-icon-pill-btn im-top-mobile-target-btn ${showGoalsSheet ? 'is-active' : ''}`}
                  type="button"
                  onClick={toggleGoalsSheet}
                  aria-label={sessionCoreGoal ? `查看会话目标：${sessionCoreGoal.titleZh}` : '查看会话目标'}
                >
                  <Target size={15} />
                  <span className="im-btn-text-full">目标</span>
                </button>
                <button ref={topMoreButtonRef} className="im-icon-pill-btn im-top-more-btn" type="button" aria-label="更多会话选项" aria-expanded={showTopMoreMenu} aria-controls="im-top-more-menu" aria-haspopup="true" onClick={toggleTopMoreMenu}>
                  <span aria-hidden="true">•••</span>
                </button>
                {showTopMoreMenu && (
                  <div ref={topMoreMenuRef} id="im-top-more-menu" className="im-top-more-menu" aria-label="更多会话选项">
                    {model.previousAdvice && (phase === 'waiting_user' || phase === 'round_complete') && <button type="button" onClick={showPreviousAdviceFromMenu} aria-label="查看上次建议">上次建议</button>}
                    <button type="button" onClick={endSessionFromMenu} disabled={controlsLocked} aria-label="提前复盘并结束会话">提前复盘</button>
                  </div>
                )}
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
              {showPreviousAdvice && model.previousAdvice && (
                <div className="im-notice-banner info">
                  <strong>上次建议</strong>
                  <p lang="ja">原句：{model.previousAdvice.expressionImprovement.userConfirmedJa}</p>
                  <p lang="ja">参考：{model.previousAdvice.expressionImprovement.suggestedJa}</p>
                  <p>{model.previousAdvice.expressionImprovement.reasonZh}</p>
                  <p>来源：{new Date(model.previousAdvice.sourceStartedAt).toLocaleDateString('zh-CN')}</p>
                  <button className="text-button" type="button" disabled={intentionRecording || phase === 'recording' || !model.ttsAvailable} onClick={() => void playReviewAudio(model.previousAdvice!.expressionImprovement.suggestedJa)}>听一听</button>
                </div>
              )}

              <div className="im-messages-list">
                {messages.length === 0 && scenario?.dynamicData.opening.speaker === 'user' && (
                  <p className="im-notice-banner info" role="status">这轮由你先开场，请直接用日语说明来意。</p>
                )}
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
                      <div className={`im-recording-bubble ${silencePromptVisible ? 'is-silence-prompt' : ''}`}>
                        <span className="im-recording-pulse-dot" aria-hidden="true" />
                        <div className="im-recording-info">
                          <strong aria-live="polite">
                            {silencePromptVisible ? '停顿中，继续说即可，当前内容已保留' : '正在录音中'}
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
              {hintData && !showHintSheet && (phase === 'waiting_user' || phase === 'round_complete' || phase === 'recording') && (
                <button className="im-dock-hint-preview" type="button" onClick={() => setShowHintSheet(true)}>
                  <Lightbulb size={15} />
                  <span>{hintLevel >= 4 ? hintData.fullExampleJa : hintLevel >= 3 ? hintData.sentenceStarterJa : hintLevel >= 2 ? hintData.keyPhrasesJa.join(' / ') : hintData.directionZh}</span>
                </button>
              )}
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
                    aria-label={dockInputMode === 'voice' ? '切换为键盘打字' : '切换为语音输入'}
                  >
                    {dockInputMode === 'voice' ? <Keyboard size={18} /> : <Mic size={18} />}
                  </button>



                  {dockInputMode === 'voice' ? (
                    <button
                      className="im-dock-main-btn"
                      type="button"
                      onClick={startJapaneseRecording}
                      disabled={!online}
                    >
                      <MicIcon />
                      <span>{turn === 1 && scenario?.dynamicData.opening.speaker === 'user' ? '开始开场' : '开始回答'}</span>
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
                    className="im-dock-icon-btn im-dock-hint-btn"
                    type="button"
                    onClick={() => {
                      if (!hintData) {
                        void handleRequestHint()
                      }
                      setShowHintSheet(true)
                    }}
                    title="怎么说"
                    aria-label="怎么说，查看表达帮助"
                  >
                    <Lightbulb size={18} />
                    <span>怎么说</span>
                  </button>
                </>
              ) : phase === 'recording' ? (
                <div className="im-dock-row">
                  <button
                    className="im-dock-main-btn is-recording"
                    type="button"
                    onClick={() => void stopRecording()}
                  >
                    <span className="im-dock-recording-indicator" aria-hidden="true">
                      <Square size={14} fill="currentColor" />
                    </span>
                    <span className="im-dock-recording-copy">说完了，点击结束</span>
                  </button>
                  <button
                    className="im-dock-icon-btn"
                    type="button"
                    onClick={enterTextInput}
                    title="放弃录音改用打字"
                    aria-label="放弃录音并改用打字"
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
                <div className="im-dock-working-bar" role="status" aria-live="polite">
                  <div className="im-dock-working-left">
                    <span className="pulse-dot" />
                    <span>{STATUS_LABELS[phase]}{phase === 'connecting_stt' && <small className="im-working-hint">首次连接可能需要几秒</small>}</span>
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
            {showTranscriptSheet && (
              <div className="im-bottom-sheet-backdrop" onClick={closeTranscriptSheet}>
                <div className="im-bottom-sheet" onClick={(e) => e.stopPropagation()}>
                  <div className="im-sheet-drag-handle" />
                  <div className="im-sheet-header">
                    <h3 className="im-sheet-title">{manualInput ? '确认文字回答' : <><Mic size={18} /> 确认语音转写</>}</h3>
                    <button className="im-sheet-close-btn" type="button" onClick={closeTranscriptSheet} aria-label="关闭转写确认"><X size={18} /></button>
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
                    <button
                      className="secondary-button im-transcript-hint-button"
                      type="button"
                      onClick={() => {
                        closeTranscriptSheet()
                        setShowHintSheet(true)
                      }}
                    >
                      <Lightbulb size={16} /> 怎么说
                    </button>
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
                    <h3 className="im-sheet-title"><Lightbulb size={18} /> 怎么说</h3>
                    <button className="im-sheet-close-btn" type="button" onClick={() => setShowHintSheet(false)} aria-label="关闭表达帮助"><X size={18} /></button>
                  </div>
                  <div className="im-sheet-content">
                    <label className="im-hint-intention-field">
                      <span>你想表达什么？（可选）</span>
                      <textarea
                        value={intentionZh}
                        onChange={(event) => setIntentionZh(event.target.value)}
                        maxLength={500}
                        readOnly={intentionRecording}
                        placeholder="用中文说说你现在想表达的意思"
                        rows={2}
                      />
                    </label>
                    {model.sttAvailable && <button className={`secondary-button ${intentionRecording ? 'is-recording' : ''}`} type="button" disabled={phase === 'recording'} onClick={() => void (intentionRecording ? stopIntentionRecording() : startIntentionRecording())}>{intentionRecording ? (intentionConnected ? '说完了，返回表达帮助' : '正在连接，取消') : '中文语音输入'}</button>}
                    {intentionError && <p className="im-inline-error" role="alert">{intentionError} 已保留输入内容。</p>}
                    <button
                      className="secondary-button im-hint-intention-submit"
                      type="button"
                      disabled={!intentionZh.trim() || intentionRecording}
                      onClick={submitIntentionHint}
                    >
                      给我日语说法 <ArrowRight size={14} />
                    </button>
                    {isLoadingHint && !hintData && (
                      <p style={{ textAlign: 'center', color: 'var(--muted)', padding: '20px 0' }}>正在设计提示...</p>
                    )}
                    {hintData && intentionSubmitted ? (
                      <div className="im-hint-sheet-tier is-intent">
                        <strong>完整说法</strong>
                        <p style={{ margin: 0 }} lang="ja">{hintData.fullExampleJa}</p>
                        <button className="text-button" type="button" disabled={intentionRecording || phase === 'recording' || !model.ttsAvailable} onClick={() => void playReviewAudio(hintData.fullExampleJa)}>听一听</button>
                      </div>
                    ) : hintData && (
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
                            <button className="text-button" type="button" disabled={intentionRecording || phase === 'recording' || !model.ttsAvailable} onClick={() => void playReviewAudio(hintData.fullExampleJa)}>听一听</button>
                          </div>
                        )}
                      </>
                    )}
                    {model.reviewAudioNotice && <p className="im-inline-error" role="status">{model.reviewAudioNotice}</p>}
                  </div>
                  <div className="im-sheet-footer">
                    {hintLevel < 4 && hintData && (
                      <button
                        className="secondary-button"
                        type="button"
                        onClick={() => void handleRequestHint()}
                      >
                        {hintLevel === 1 ? '查看关键词' : hintLevel === 2 ? '看句子开头' : '看完整说法'} <ArrowRight size={14} />
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
                    <button className="im-sheet-close-btn" type="button" onClick={() => setShowGoalsSheet(false)} aria-label="关闭训练目标"><X size={18} /></button>
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
  )
}
