import { describe, expect, it, vi } from 'vitest'
import { SttError } from '../../src/lib/audio-engine'
import { toUiError } from '../../src/lib/ui'

vi.mock('../../src/lib/api', () => ({
  requestElevenLabsToken: vi.fn(),
}))
import {
  createRecordingStartLock,
  initialVoiceTurnState,
  parseFinalTranscript,
  voiceTurnReducer,
  type VoiceTurnState,
} from '../../src/lib/voice-turn-controller'

describe('voiceTurnReducer production state machine contracts', () => {
  it('START_RECORDING: 开始录音时重置语音域流式片段、错误及计时状态', () => {
    const dirtyState: VoiceTurnState = {
      ...initialVoiceTurnState,
      confirmedTranscript: '前回の発話',
      interimTranscript: '続き',
      partialTranscript: '前回の発話 続き',
      manualInput: true,
      showOriginalTranscript: true,
      showTranscriptSheet: true,
      recordingSeconds: 15,
      silentSeconds: 4,
      voiceError: {
        code: 'stt_error',
        title: '识别失败',
        message: '连接中断',
        recovery: 'retry',
      },
      lastFailedStep: 'stt',
    }

    const nextState = voiceTurnReducer(dirtyState, {
      type: 'START_RECORDING',
      startedAt: 100_000,
    })

    expect(nextState.confirmedTranscript).toBe('')
    expect(nextState.interimTranscript).toBe('')
    expect(nextState.partialTranscript).toBe('')
    expect(nextState.manualInput).toBe(false)
    expect(nextState.showOriginalTranscript).toBe(false)
    expect(nextState.showTranscriptSheet).toBe(false)
    expect(nextState.recordingSeconds).toBe(0)
    expect(nextState.silentSeconds).toBe(0)
    expect(nextState.voiceError).toBeNull()
    expect(nextState.lastFailedStep).toBeNull()
  })

  it('FALLBACK_TO_MANUAL_INPUT: 权限拒绝或无麦克风时进入 manualInput 并弹出草稿弹窗', () => {
    const state = voiceTurnReducer(initialVoiceTurnState, {
      type: 'FALLBACK_TO_MANUAL_INPUT',
      readiness: 'denied',
      notice: '麦克风权限未开启，已切换到文字回答。',
    })

    expect(state.microphoneReadiness).toBe('denied')
    expect(state.manualInput).toBe(true)
    expect(state.showTranscriptSheet).toBe(true)
    expect(state.foregroundNotice).toBe('麦克风权限未开启，已切换到文字回答。')
    expect(state.lastFailedStep).toBeNull()
  })

  it('ENTER_TEXT_INPUT: 打断语音输入，继承 confirmed + interim 组合草稿，清空流式片段并设置 manualInput', () => {
    const streamingState: VoiceTurnState = {
      ...initialVoiceTurnState,
      confirmedTranscript: 'こんにちは',
      interimTranscript: '田中です',
      partialTranscript: 'こんにちは 田中です',
      recordingSeconds: 5,
      silentSeconds: 1,
    }

    const nextState = voiceTurnReducer(streamingState, {
      type: 'ENTER_TEXT_INPUT',
    })

    expect(nextState.manualInput).toBe(true)
    expect(nextState.confirmedTranscript).toBe('')
    expect(nextState.interimTranscript).toBe('')
    expect(nextState.partialTranscript).toBe('')
    expect(nextState.transcript.finalText).toBe('こんにちは 田中です')
    expect(nextState.transcript.cleanedText).toBe('こんにちは 田中です')
    expect(nextState.recordingUiStartedAt).toBeNull()
    expect(nextState.voiceError).toBeNull()
  })

  it('RERECORD_RESET: 重录时重置草稿文本、流式片段与错误，准备新一轮录音', () => {
    const confirmingState: VoiceTurnState = {
      ...initialVoiceTurnState,
      confirmedTranscript: '古いテキスト',
      transcript: {
        rawText: '古いテキスト',
        cleanedText: '古いテキスト',
        finalText: '編集したテキスト',
      },
      voiceError: {
        code: 'stt_error',
        title: '错误',
        message: '网络异常',
        recovery: 'retry',
      },
      lastFailedStep: 'stt',
    }

    const nextState = voiceTurnReducer(confirmingState, {
      type: 'RERECORD_RESET',
    })

    expect(nextState.confirmedTranscript).toBe('')
    expect(nextState.transcript.finalText).toBe('')
    expect(nextState.transcript.rawText).toBe('')
    expect(nextState.voiceError).toBeNull()
    expect(nextState.lastFailedStep).toBeNull()
  })

  it('parseFinalTranscript: 空白或仅有符号时抛出 no_speech_detected，有效文本生成规整 TranscriptText', () => {
    // 空输入或仅空白字符
    expect(() => parseFinalTranscript('')).toThrowError(SttError)
    expect(() => parseFinalTranscript('   \n\t  ')).toThrowError(SttError)
    expect(() => parseFinalTranscript('。。。')).toThrowError(SttError)

    try {
      parseFinalTranscript('  ')
    } catch (err) {
      expect(err).toBeInstanceOf(SttError)
      expect((err as SttError).code).toBe('no_speech_detected')
      const uiErr = toUiError(err)
      expect(uiErr.title).toBe('没有识别到有效语音')
      expect(uiErr.recovery).toBe('text_input')
      expect(uiErr.message).toContain('没有收到清晰的声音')
    }

    // 有效日语文本
    const valid = parseFinalTranscript(' こんにちは、田中です。 ')
    expect(valid.rawText).toBe(' こんにちは、田中です。 ')
    expect(valid.cleanedText).toBe('こんにちは、田中です。')
    expect(valid.finalText).toBe('こんにちは、田中です。')
  })

  it('FINALIZE_SUCCESS 与 SET_VOICE_ERROR: 录音停止成功直接使用已解析 transcript，失败产生 voice error 与 lastFailedStep', () => {
    // 成功路径
    const finalizingState: VoiceTurnState = {
      ...initialVoiceTurnState,
      confirmedTranscript: 'ありがとう',
      interimTranscript: 'ございます',
      recordingUiStartedAt: 12345,
    }

    const parsedTranscript = {
      rawText: 'ありがとうございます。',
      cleanedText: 'ありがとうございます。',
      finalText: 'ありがとうございます。',
    }

    const successState = voiceTurnReducer(finalizingState, {
      type: 'FINALIZE_SUCCESS',
      transcript: parsedTranscript,
    })

    expect(successState.confirmedTranscript).toBe('')
    expect(successState.interimTranscript).toBe('')
    expect(successState.transcript).toEqual(parsedTranscript)

    // 失败路径：测试当初始 showTranscriptSheet 为 true 时，派发 SET_VOICE_ERROR 必须将其置为 false
    const stateWithSheetOpen: VoiceTurnState = {
      ...finalizingState,
      showTranscriptSheet: true,
    }

    const failedState = voiceTurnReducer(stateWithSheetOpen, {
      type: 'SET_VOICE_ERROR',
      error: {
        code: 'no_speech_detected',
        title: '没有识别到有效语音',
        message: '刚才没有收到清晰的声音。请重新录制，或改用文字回答。',
        recovery: 'text_input',
      },
    })

    expect(failedState.voiceError?.code).toBe('no_speech_detected')
    expect(failedState.voiceError?.title).toBe('没有识别到有效语音')
    expect(failedState.lastFailedStep).toBe('stt')
    expect(failedState.showTranscriptSheet).toBe(false)
  })

  it('RESET_ALL: 会话重置彻底清空语音域全部状态回初始值', () => {
    const dirtyState: VoiceTurnState = {
      ...initialVoiceTurnState,
      confirmedTranscript: 'abc',
      manualInput: true,
      recordingSeconds: 10,
      showTranscriptSheet: true,
      microphoneReadiness: 'granted',
    }

    const resetState = voiceTurnReducer(dirtyState, { type: 'RESET_ALL' })
    expect(resetState).toEqual(initialVoiceTurnState)
  })
})

describe('recording start lock lifecycle', () => {
  it('dispose 作废当前启动所有权后允许立即重试，旧 finally 不得释放新启动锁', () => {
    const lock = createRecordingStartLock()
    const interruptedStart = lock.tryAcquire()

    expect(interruptedStart).not.toBeNull()
    lock.invalidate()

    const retryStart = lock.tryAcquire()
    expect(retryStart).not.toBeNull()
    expect(retryStart).not.toBe(interruptedStart)

    lock.releaseIfOwner(interruptedStart!)
    expect(lock.tryAcquire()).toBeNull()

    lock.releaseIfOwner(retryStart!)
    expect(lock.tryAcquire()).not.toBeNull()
  })
})
