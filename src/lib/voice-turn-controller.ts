/**
 * [INPUT]: 依赖 ./recording-setup、./stt、./api、./audio-engine、./voice-recordings、./text-cleaner、./ui、../types、相手播放资源释放回调与 ../../shared/speech-assist 的固定中止原因契约
 * [OUTPUT]: 对外提供 useVoiceTurnController 语音回合 Hook、录音前相手播放资源释放接缝、确认后本机录音保存、voiceTurnReducer 状态纯机、parseFinalTranscript 校验及 RecordingStartLock 所有权锁契约；将 STT 流异常关闭转为可观察 error 阶段
 * [POS]: src/lib 的用户语音回合核心控制器，内聚麦克风、转写、可选本机压缩录音暂存、语音辅助中止、文本回退、资源释放与单轮生命周期闭环
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { useCallback, useEffect, useReducer, useRef } from 'react'
import type { SpeechAssistAbortReason } from '../../shared/speech-assist'
import { requestElevenLabsToken } from './api'
import { releaseMicrophoneStream } from './audio-engine'
import type { MicrophoneReadiness } from './microphone'
import { coordinateRecordingSetup } from './recording-setup'
import { RealtimeSttSession, SttError, SttTokenManager } from './stt'
import { cleanTranscript } from './text-cleaner'
import { toUiError } from './ui'
import { createVoiceCapture, saveVoiceRecording, type PendingVoiceRecording } from './voice-recordings'
import type { AppPhase, RoundRecord, TranscriptText, UiError } from '../types'

export interface VoiceTurnDependencies {
  sttAvailable: boolean
  sttModel: string
  online: boolean
  phase: AppPhase
  operation: {
    begin: () => number
    isCurrent: (operationId: number) => boolean
  }
  transitionTo: (nextPhase: AppPhase) => boolean
  touchRound: (update: (round: RoundRecord) => void) => void
  abortSpeechAssist?: (reason: SpeechAssistAbortReason) => void
  releaseAiPlayback?: () => void
  saveRecordingsEnabled: boolean
  sessionId: string
  turn: number
  onRecordingNotice?: (notice: string) => void
}

export interface VoiceTurnState {
  microphoneReadiness: MicrophoneReadiness
  confirmedTranscript: string
  interimTranscript: string
  partialTranscript: string
  transcript: TranscriptText
  manualInput: boolean
  showOriginalTranscript: boolean
  showTranscriptSheet: boolean
  recordingSeconds: number
  silentSeconds: number
  microphoneMeterAvailable: boolean
  recordingUiStartedAt: number | null
  foregroundNotice: string
  voiceError: UiError | null
  lastFailedStep: 'stt' | null
}

export type VoiceTurnAction =
  | { type: 'START_RECORDING'; startedAt: number }
  | { type: 'ENTER_RECORDING_PIPELINE'; connectedAt: number }
  | { type: 'UPDATE_STREAMING_PARTIAL'; confirmed: string; interim: string; partial: string }
  | { type: 'SET_MICROPHONE_METER_AVAILABLE'; available: boolean }
  | { type: 'FALLBACK_TO_MANUAL_INPUT'; readiness: MicrophoneReadiness; notice: string }
  | { type: 'FINALIZE_START' }
  | { type: 'FINALIZE_SUCCESS'; transcript: TranscriptText }
  | { type: 'ENTER_TEXT_INPUT' }
  | { type: 'RERECORD_RESET' }
  | { type: 'UPDATE_FINAL_TEXT'; text: string }
  | { type: 'TOGGLE_ORIGINAL_TRANSCRIPT' }
  | { type: 'SET_TRANSCRIPT_SHEET'; show: boolean }
  | { type: 'SYNC_MICROPHONE_READINESS'; readiness: MicrophoneReadiness }
  | { type: 'CLEAR_VOICE_NOTICE' }
  | { type: 'CLEAR_VOICE_ERROR' }
  | { type: 'SET_VOICE_ERROR'; error: UiError }
  | { type: 'UPDATE_TIMERS'; recordingSeconds: number; silentSeconds: number }
  | { type: 'RESET_ALL' }

const EMPTY_TRANSCRIPT: TranscriptText = {
  rawText: '',
  cleanedText: '',
  finalText: '',
}

export function parseFinalTranscript(rawText: string): TranscriptText {
  const cleaned = cleanTranscript(rawText)
  // 检查是否包含至少一个非标点、非空白的实际语言字符
  const hasMeaningfulSpeech = /[^\s、。！？!?，,；;：:「」『』【】（）()[\]《》〈〉…—.．]/u.test(cleaned.cleanedText)
  if (!hasMeaningfulSpeech) {
    throw new SttError('no_speech_detected', '没有识别到有效语音。请重新录制，或改用文字回答。')
  }
  return {
    rawText: cleaned.rawText,
    cleanedText: cleaned.cleanedText,
    finalText: cleaned.cleanedText,
  }
}

export const initialVoiceTurnState: VoiceTurnState = {
  microphoneReadiness: 'unknown',
  confirmedTranscript: '',
  interimTranscript: '',
  partialTranscript: '',
  transcript: EMPTY_TRANSCRIPT,
  manualInput: false,
  showOriginalTranscript: false,
  showTranscriptSheet: false,
  recordingSeconds: 0,
  silentSeconds: 0,
  microphoneMeterAvailable: true,
  recordingUiStartedAt: null,
  foregroundNotice: '',
  voiceError: null,
  lastFailedStep: null,
}
export function voiceTurnReducer(state: VoiceTurnState, action: VoiceTurnAction): VoiceTurnState {
  switch (action.type) {
    case 'START_RECORDING':
      return {
        ...state,
        confirmedTranscript: '',
        interimTranscript: '',
        partialTranscript: '',
        transcript: EMPTY_TRANSCRIPT,
        manualInput: false,
        showOriginalTranscript: false,
        showTranscriptSheet: false,
        recordingSeconds: 0,
        silentSeconds: 0,
        microphoneMeterAvailable: true,
        recordingUiStartedAt: null,
        voiceError: null,
        lastFailedStep: null,
      }
    case 'ENTER_RECORDING_PIPELINE':
      return {
        ...state,
        recordingUiStartedAt: action.connectedAt,
        microphoneReadiness: 'granted',
      }
    case 'UPDATE_STREAMING_PARTIAL':
      return {
        ...state,
        confirmedTranscript: action.confirmed,
        interimTranscript: action.interim,
        partialTranscript: action.partial,
        silentSeconds: 0,
      }
    case 'SET_MICROPHONE_METER_AVAILABLE':
      return {
        ...state,
        microphoneMeterAvailable: action.available,
      }
    case 'FALLBACK_TO_MANUAL_INPUT':
      return {
        ...state,
        microphoneReadiness: action.readiness,
        manualInput: true,
        showTranscriptSheet: true,
        foregroundNotice: action.notice,
        lastFailedStep: null,
        voiceError: null,
      }
    case 'FINALIZE_START':
      return {
        ...state,
        silentSeconds: 0,
        recordingUiStartedAt: null,
      }
    case 'FINALIZE_SUCCESS':
      return {
        ...state,
        confirmedTranscript: '',
        interimTranscript: '',
        partialTranscript: '',
        transcript: action.transcript,
        showOriginalTranscript: false,
      }
    case 'ENTER_TEXT_INPUT': {
      const draftText =
        [state.confirmedTranscript.trim(), state.interimTranscript.trim()].filter(Boolean).join(' ') ||
        state.partialTranscript.trim()
      const cleaned = cleanTranscript(draftText)
      return {
        ...state,
        confirmedTranscript: '',
        interimTranscript: '',
        partialTranscript: '',
        manualInput: true,
        silentSeconds: 0,
        recordingUiStartedAt: null,
        transcript: {
          rawText: cleaned.rawText,
          cleanedText: cleaned.cleanedText,
          finalText: cleaned.cleanedText,
        },
        showOriginalTranscript: false,
        voiceError: null,
        lastFailedStep: null,
      }
    }
    case 'RERECORD_RESET':
      return {
        ...state,
        confirmedTranscript: '',
        interimTranscript: '',
        partialTranscript: '',
        transcript: EMPTY_TRANSCRIPT,
        voiceError: null,
        lastFailedStep: null,
      }
    case 'UPDATE_FINAL_TEXT':
      return {
        ...state,
        transcript: {
          ...state.transcript,
          finalText: action.text,
        },
      }
    case 'TOGGLE_ORIGINAL_TRANSCRIPT':
      return {
        ...state,
        showOriginalTranscript: !state.showOriginalTranscript,
      }
    case 'SET_TRANSCRIPT_SHEET':
      return {
        ...state,
        showTranscriptSheet: action.show,
      }
    case 'SYNC_MICROPHONE_READINESS':
      return {
        ...state,
        microphoneReadiness: action.readiness,
      }
    case 'CLEAR_VOICE_NOTICE':
      return {
        ...state,
        foregroundNotice: '',
      }
    case 'CLEAR_VOICE_ERROR':
      return {
        ...state,
        voiceError: null,
        lastFailedStep: null,
      }
    case 'SET_VOICE_ERROR':
      return {
        ...state,
        showTranscriptSheet: false,
        voiceError: action.error,
        lastFailedStep: 'stt',
      }
    case 'UPDATE_TIMERS':
      return {
        ...state,
        recordingSeconds: action.recordingSeconds,
        silentSeconds: action.silentSeconds,
      }
    case 'RESET_ALL':
      return {
        ...initialVoiceTurnState,
      }
  }
}

export interface VoiceTurnActions {
  startRecording: () => Promise<void>
  stopRecording: () => Promise<void>
  enterTextInput: () => void
  rerecord: () => Promise<void>
  updateFinalText: (text: string) => void
  toggleOriginalTranscript: () => void
  openTranscriptSheet: () => void
  closeTranscriptSheet: () => void
  syncMicrophoneReadiness: (readiness: MicrophoneReadiness) => void
  clearVoiceNotice: () => void
  clearVoiceError: () => void
  resetVoiceTurn: () => void
  dispose: () => void
  prefetchSttToken: () => Promise<string | null>
  confirmRecording: () => void
}

export interface VoiceTurnController {
  state: VoiceTurnState
  actions: VoiceTurnActions
  meta: {
    lastSoundAt: number | null
    lastSpeechSoundAt: number | null
    lastPartialAt: number | null
    transcriptVersion: number
  }
}

export interface RecordingStartLock {
  tryAcquire: () => number | null
  invalidate: () => void
  releaseIfOwner: (owner: number) => void
}

export function createRecordingStartLock(): RecordingStartLock {
  let activeOwner: number | null = null
  let nextOwner = 0

  return {
    tryAcquire() {
      if (activeOwner !== null) return null
      activeOwner = ++nextOwner
      return activeOwner
    },
    invalidate() {
      activeOwner = null
    },
    releaseIfOwner(owner) {
      if (activeOwner === owner) activeOwner = null
    },
  }
}

export function useVoiceTurnController(deps: VoiceTurnDependencies): VoiceTurnController {
  const [state, dispatch] = useReducer(voiceTurnReducer, initialVoiceTurnState)

  const sttRef = useRef(new RealtimeSttSession())
  const sttTokenManagerRef = useRef<SttTokenManager>(new SttTokenManager())
  const requestAbortRef = useRef<AbortController | null>(null)
  const recordingStartLockRef = useRef(createRecordingStartLock())
  const silenceStopLockRef = useRef(false)
  const lastSoundAtRef = useRef<number | null>(null)
  const lastSpeechSoundAtRef = useRef<number | null>(null)
  const lastPartialAtRef = useRef<number | null>(null)
  const transcriptVersionRef = useRef(0)
  const voiceCaptureRef = useRef(createVoiceCapture())
  const pendingRecordingRef = useRef<PendingVoiceRecording | null>(null)

  const syncMicrophoneReadiness = useCallback((readiness: MicrophoneReadiness) => {
    dispatch({ type: 'SYNC_MICROPHONE_READINESS', readiness })
  }, [])

  const clearVoiceNotice = useCallback(() => {
    dispatch({ type: 'CLEAR_VOICE_NOTICE' })
  }, [])

  const clearVoiceError = useCallback(() => {
    dispatch({ type: 'CLEAR_VOICE_ERROR' })
  }, [])

  const toggleOriginalTranscript = useCallback(() => {
    dispatch({ type: 'TOGGLE_ORIGINAL_TRANSCRIPT' })
  }, [])

  const openTranscriptSheet = useCallback(() => {
    dispatch({ type: 'SET_TRANSCRIPT_SHEET', show: true })
  }, [])

  const closeTranscriptSheet = useCallback(() => {
    dispatch({ type: 'SET_TRANSCRIPT_SHEET', show: false })
  }, [])

  const dispose = useCallback(() => {
    requestAbortRef.current?.abort()
    requestAbortRef.current = null
    recordingStartLockRef.current.invalidate()
    sttRef.current.close()
    sttTokenManagerRef.current.reset()
    voiceCaptureRef.current.discard()
    pendingRecordingRef.current = null
    releaseMicrophoneStream()
  }, [])

  // Hook 在组件销毁 unmount 时自动执行资源清理
  useEffect(() => {
    return () => {
      dispose()
    }
  }, [dispose])

  const resetVoiceTurn = useCallback(() => {
    dispose()
    dispatch({ type: 'RESET_ALL' })

    lastSoundAtRef.current = null
    lastSpeechSoundAtRef.current = null
    lastPartialAtRef.current = null
    transcriptVersionRef.current = 0
    silenceStopLockRef.current = false
    recordingStartLockRef.current.invalidate()
  }, [dispose])

  const updateFinalText = useCallback((text: string) => {
    dispatch({ type: 'UPDATE_FINAL_TEXT', text })
  }, [])

  const prefetchSttToken = useCallback(async (): Promise<string | null> => {
    if (!deps.sttAvailable || !deps.online) return null
    return sttTokenManagerRef.current.prefetch(() => requestElevenLabsToken('realtime_scribe'))
  }, [deps.online, deps.sttAvailable])

  const startRecording = useCallback(async () => {
    if (!deps.online) return
    const recordingStartOwner = recordingStartLockRef.current.tryAcquire()
    if (recordingStartOwner === null) return
    deps.releaseAiPlayback?.()
    const operationId = deps.operation.begin()
    const recordingStartedAt = Date.now()
    voiceCaptureRef.current.discard()
    pendingRecordingRef.current = null

    dispatch({ type: 'START_RECORDING', startedAt: recordingStartedAt })

    deps.touchRound((round) => {
      round.inputMode = 'stt'
      round.timing.recordingStartedAt = recordingStartedAt
      round.timing.recordingStoppedAt = null
      round.timing.firstSpeechAt = null
      round.timing.transcriptFinalizedAt = null
      round.timing.transcriptConfirmedAt = null
    })

    // 内存中的 denied 只用于展示上次结果；用户可能已在浏览器设置中改回授权，
    // 所以每次点击都交由唯一取流入口读取当前权限。
    if (!deps.sttAvailable) {
      dispatch({
        type: 'FALLBACK_TO_MANUAL_INPUT',
        readiness: 'unavailable',
        notice: '',
      })
      deps.touchRound((round) => {
        round.inputMode = 'text'
        round.timing.recordingStoppedAt = recordingStartedAt
        round.timing.transcriptFinalizedAt = recordingStartedAt
      })
      deps.transitionTo('confirming_transcript')
      recordingStartLockRef.current.releaseIfOwner(recordingStartOwner)
      return
    }

    const controller = new AbortController()
    requestAbortRef.current = controller

    try {
      deps.transitionTo('connecting_stt')

      const microphoneTrackLive = await coordinateRecordingSetup({
        acquireToken: () =>
          sttTokenManagerRef.current.acquireToken(
            () => requestElevenLabsToken('realtime_scribe', controller.signal),
          ),
        isCancelled: () => controller.signal.aborted || !deps.operation.isCurrent(operationId),
        onMicrophoneStream: (stream) => {
          if (!deps.operation.isCurrent(operationId) || !deps.saveRecordingsEnabled) return
          const status = voiceCaptureRef.current.start(stream, { sessionId: deps.sessionId, turn: deps.turn, kind: 'round' })
          if (status === 'unavailable') deps.onRecordingNotice?.('当前浏览器无法保存录音，练习仍可继续。')
        },
        connectStt: (token) =>
          sttRef.current.start(token, deps.sttModel, {
            onPipelineReady: () => {
              if (!deps.operation.isCurrent(operationId)) return
              const connectedAt = Date.now()
              lastSoundAtRef.current = connectedAt
              dispatch({ type: 'ENTER_RECORDING_PIPELINE', connectedAt })
              deps.transitionTo('recording')
            },
            onPartial: (text, parts) => {
              if (!deps.operation.isCurrent(operationId)) return
              const nextConfirmed = parts?.confirmed ?? ''
              const nextInterim = parts?.interim ?? ''
              dispatch({
                type: 'UPDATE_STREAMING_PARTIAL',
                confirmed: nextConfirmed,
                interim: nextInterim,
                partial: text,
              })
              if (text.trim()) {
                const now = Date.now()
                lastSoundAtRef.current = now
                lastPartialAtRef.current = now
                transcriptVersionRef.current += 1
                deps.abortSpeechAssist?.('new_partial')
                silenceStopLockRef.current = false
                deps.touchRound((round) => {
                  if (round.timing.firstSpeechAt === null) {
                    round.timing.firstSpeechAt = now
                  }
                })
              }
            },
            onConnectionState: (connectionState) => {
              if (!deps.operation.isCurrent(operationId)) return
              if (connectionState === 'connected') {
                const now = Date.now()
                lastSoundAtRef.current = now
                lastSpeechSoundAtRef.current = now
                lastPartialAtRef.current = now
              }
            },
            onError: (error) => {
              if (!deps.operation.isCurrent(operationId)) return
              deps.touchRound((round) => {
                round.failureCount += 1
              })
              dispatch({ type: 'SET_VOICE_ERROR', error: toUiError(error) })
              deps.transitionTo('error')
            },
            onAudioLevel: (level) => {
              if (!deps.operation.isCurrent(operationId)) return
              if (level < 0) {
                dispatch({ type: 'SET_MICROPHONE_METER_AVAILABLE', available: false })
                return
              }
              dispatch({ type: 'SET_MICROPHONE_METER_AVAILABLE', available: true })
              if (level >= 0.12) {
                const now = Date.now()
                lastSoundAtRef.current = now
                lastSpeechSoundAtRef.current = now
                deps.abortSpeechAssist?.('user_speaking')
                silenceStopLockRef.current = false
                deps.touchRound((round) => {
                  if (round.timing.firstSpeechAt === null) {
                    round.timing.firstSpeechAt = now
                  }
                })
              }
            },
          }),
      })

      if (controller.signal.aborted || !deps.operation.isCurrent(operationId)) return
      if (microphoneTrackLive) {
        dispatch({ type: 'SYNC_MICROPHONE_READINESS', readiness: 'granted' })
      }
      deps.touchRound((round) => {
        round.sttSessionCount += 1
      })
    } catch (error) {
      if (controller.signal.aborted || !deps.operation.isCurrent(operationId)) return
      sttRef.current.close()
      // 失败路径绝不保留临时录音：既满足「失败不保存」的契约，也避免本地录音器继续占用硬件流。
      voiceCaptureRef.current.discard()
      pendingRecordingRef.current = null
      deps.touchRound((round) => {
        round.failureCount += 1
      })
      if (error instanceof SttError && (error.code === 'permission_denied' || error.code === 'device_missing')) {
        const now = Date.now()
        const readiness = error.code === 'permission_denied' ? 'denied' : 'unavailable'
        const notice =
          error.code === 'permission_denied'
            ? '麦克风权限未开启，已切换到文字回答。'
            : '没有可用麦克风，已切换到文字回答。'
        dispatch({ type: 'FALLBACK_TO_MANUAL_INPUT', readiness, notice })
        deps.touchRound((round) => {
          round.inputMode = 'text'
          round.timing.recordingStoppedAt = now
          round.timing.transcriptFinalizedAt = now
        })
        deps.transitionTo('confirming_transcript')
        return
      }
      dispatch({ type: 'SET_VOICE_ERROR', error: toUiError(error) })
      deps.transitionTo('error')
    } finally {
      if (requestAbortRef.current === controller) requestAbortRef.current = null
      recordingStartLockRef.current.releaseIfOwner(recordingStartOwner)
    }
  }, [deps, state.microphoneReadiness])

  const stopRecording = useCallback(async () => {
    if (deps.phase !== 'recording') return
    const operationId = deps.operation.begin()
    const stoppedAt = Date.now()

    deps.abortSpeechAssist?.('recording_stopped')
    dispatch({ type: 'FINALIZE_START' })
    deps.transitionTo('finalizing_transcript')
    const pendingRecording = await voiceCaptureRef.current.stop()

    deps.touchRound((round) => {
      round.timing.recordingStoppedAt = stoppedAt
      const startedAt = round.timing.recordingStartedAt
      if (startedAt !== null) round.sttAudioMilliseconds += Math.max(0, stoppedAt - startedAt)
    })

    try {
      const rawText = await sttRef.current.stop()
      if (!deps.operation.isCurrent(operationId)) return
      const parsed = parseFinalTranscript(rawText)
      const finalizedAt = Date.now()
      dispatch({ type: 'FINALIZE_SUCCESS', transcript: parsed })
      deps.touchRound((round) => {
        round.userCleaned = parsed.cleanedText.trim()
        round.timing.transcriptFinalizedAt = finalizedAt
      })
      deps.transitionTo('confirming_transcript')
      pendingRecordingRef.current = pendingRecording
    } catch (error) {
      voiceCaptureRef.current.discard()
      pendingRecordingRef.current = null
      if (!deps.operation.isCurrent(operationId)) return
      deps.touchRound((round) => {
        round.failureCount += 1
      })
      dispatch({ type: 'SET_VOICE_ERROR', error: toUiError(error) })
      deps.transitionTo('error')
    }
  }, [deps])

  const enterTextInput = useCallback(() => {
    const now = Date.now()
    deps.operation.begin()
    deps.abortSpeechAssist?.('text_input')
    voiceCaptureRef.current.discard()
    pendingRecordingRef.current = null
    dispatch({ type: 'ENTER_TEXT_INPUT' })

    deps.touchRound((round) => {
      round.inputMode = 'text'
      if (round.timing.recordingStartedAt === null) round.timing.recordingStartedAt = now
      if (round.timing.recordingStoppedAt === null) round.timing.recordingStoppedAt = now
      if (round.timing.transcriptFinalizedAt === null) round.timing.transcriptFinalizedAt = now
    })

    deps.transitionTo('confirming_transcript')
  }, [deps])

  const rerecord = useCallback(async () => {
    voiceCaptureRef.current.discard()
    pendingRecordingRef.current = null
    deps.touchRound((round) => {
      round.rerecordCount += 1
      round.retryCount += 1
    })
    dispatch({ type: 'RERECORD_RESET' })
    deps.transitionTo('waiting_user')
    await startRecording()
  }, [deps, startRecording])

  const confirmRecording = useCallback(() => {
    const pending = pendingRecordingRef.current
    pendingRecordingRef.current = null
    if (!pending || !deps.saveRecordingsEnabled) return
    void saveVoiceRecording(pending).catch(() => deps.onRecordingNotice?.('录音未能保存到此设备，练习已继续。'))
  }, [deps])

  // 录音计时周期更新
  useEffect(() => {
    if (deps.phase !== 'recording' || state.recordingUiStartedAt === null) return
    const updateElapsed = () => {
      const now = Date.now()
      dispatch({
        type: 'UPDATE_TIMERS',
        recordingSeconds: Math.floor((now - state.recordingUiStartedAt!) / 1_000),
        silentSeconds: Math.floor((now - (lastSoundAtRef.current ?? state.recordingUiStartedAt!)) / 1_000),
      })
    }
    updateElapsed()
    const interval = window.setInterval(updateElapsed, 50)
    return () => window.clearInterval(interval)
  }, [deps.phase, state.recordingUiStartedAt])

  return {
    state,
    actions: {
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
      clearVoiceError,
      resetVoiceTurn,
      dispose,
      prefetchSttToken,
      confirmRecording,
    },
    meta: {
      get lastSoundAt() {
        return lastSoundAtRef.current
      },
      get lastSpeechSoundAt() {
        return lastSpeechSoundAtRef.current
      },
      get lastPartialAt() {
        return lastPartialAtRef.current
      },
      get transcriptVersion() {
        return transcriptVersionRef.current
      },
    },
  }
}
