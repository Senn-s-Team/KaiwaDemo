/**
 * [INPUT]: 依赖 src/lib/stt 的转写状态规约、RealtimeSttSession 停止行为、连接关闭错误回调与最终文本选择策略
 * [OUTPUT]: 验证实时转写去重、提交收敛、streaming 连接关闭时错误可观察及 stop() 保全已观察文本的回归契约
 * [POS]: tests/client 的 STT 逻辑回归测试，以纯状态转换和无设备会话探针约束自动停止收尾与异常恢复
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { describe, expect, it, vi } from 'vitest'

const testConnections: Array<{ emit: (event: string) => void }> = []
vi.mock('@elevenlabs/client', () => ({
  AudioFormat: { PCM_16000: 'pcm_16000' },
  CommitStrategy: { MANUAL: 'manual' },
  RealtimeEvents: {
    SESSION_STARTED: 'session_started',
    PARTIAL_TRANSCRIPT: 'partial_transcript',
    FINAL_TRANSCRIPT: 'final_transcript',
    COMMITTED_TRANSCRIPT: 'committed_transcript',
    ERROR: 'error',
    CLOSE: 'close',
  },
  Scribe: {
    connect: () => {
      const handlers = new Map<string, () => void>()
      const connection = {
        on: (event: string, handler: () => void) => handlers.set(event, handler),
        send: () => undefined,
        commit: () => undefined,
        close: () => undefined,
        emit: (event: string) => handlers.get(event)?.(),
      }
      testConnections.push(connection)
      return connection
    },
  },
}))
vi.mock('../../src/lib/audio-engine', () => ({
  AudioRingBuffer: class {
    clear(): void {}
    flush(): Array<{ base64: string; rms: number }> { return [] }
    push(): void {}
  },
  MicrophoneAudioPipeline: class {
    async start(): Promise<void> {}
    stop(): void {}
  },
  SttError: class SttError extends Error {
    readonly code: string
    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  },
  isMicrophoneTrackReady: () => true,
  releaseMicrophoneStream: () => undefined,
  requestMicrophoneStream: async () => ({}),
  unlockAudio: async () => undefined,
}))

import {
  createInitialSttTranscriptState,
  reduceSttCommitted,
  reduceSttFinal,
  reduceSttPartial,
  RealtimeSttSession,
  selectFinalSttText,
} from '../../src/lib/stt'

describe('STT Observable State Contract', () => {
  it('replaces interim partial text rather than accumulating it', () => {
    let state = createInitialSttTranscriptState()

    const step1 = reduceSttPartial(state, 'こん')
    state = step1.state
    expect(step1.parts).toEqual({ confirmed: '', interim: 'こん' })
    expect(step1.combined).toBe('こん')

    const step2 = reduceSttPartial(state, 'こんにちは')
    state = step2.state
    expect(step2.parts).toEqual({ confirmed: '', interim: 'こんにちは' })
    expect(step2.combined).toBe('こんにちは')
  })

  it('solidifies text on final transcript and clears interim', () => {
    let state = createInitialSttTranscriptState()

    const partial = reduceSttPartial(state, 'こんにちは')
    state = partial.state
    expect(state.interim).toBe('こんにちは')

    const final = reduceSttFinal(state, 'こんにちは', 'seg-1')
    state = final.state
    expect(final.parts).toEqual({ confirmed: 'こんにちは', interim: '' })
    expect(final.combined).toBe('こんにちは')
    expect(state.confirmedSegments).toEqual(['こんにちは'])
    expect(state.interim).toBe('')
  })

  it('deduplicates final events that share the same non-empty eventId', () => {
    let state = createInitialSttTranscriptState()

    const final1 = reduceSttFinal(state, 'こんにちは', 'seg-1')
    state = final1.state
    expect(final1.added).toBe(true)
    expect(state.confirmedSegments).toEqual(['こんにちは'])

    // 同一真实 ID 重复到达时，不得重复追加
    const finalDuplicate = reduceSttFinal(state, 'こんにちは', 'seg-1')
    state = finalDuplicate.state
    expect(finalDuplicate.added).toBe(false)
    expect(state.confirmedSegments).toEqual(['こんにちは'])

    // 另一个不同 ID 的片段正常追加
    const final2 = reduceSttFinal(state, '今日はいい天気ですね', 'seg-2')
    state = final2.state
    expect(final2.added).toBe(true)
    expect(state.confirmedSegments).toEqual(['こんにちは', '今日はいい天気ですね'])
  })

  it('does NOT deduplicate consecutive final events with identical text when eventId is absent', () => {
    let state = createInitialSttTranscriptState()

    // 用户合法地连续说了两个相同的短句，且后端没有下发 eventId
    const first = reduceSttFinal(state, 'はい')
    state = first.state
    expect(first.added).toBe(true)
    expect(state.confirmedSegments).toEqual(['はい'])

    const second = reduceSttFinal(state, 'はい')
    state = second.state
    expect(second.added).toBe(true)
    expect(state.confirmedSegments).toEqual(['はい', 'はい'])
    expect(state.confirmedSegments).toHaveLength(2)
  })

  it('only resolves committed text once even if subsequent committed events arrive', () => {
    let state = createInitialSttTranscriptState()
    const final = reduceSttFinal(state, '注文をお願いします', 'seg-1')
    state = final.state

    // 第一次 committed 事件触发 resolve
    const committed1 = reduceSttCommitted(state, '注文をお願いします')
    state = committed1.state
    expect(committed1.shouldResolve).toBe(true)
    expect(committed1.committedText).toBe('注文をお願いします')

    // 第二次重复 committed 到达不应再次 resolve
    const committed2 = reduceSttCommitted(state, '注文をお願いします')
    expect(committed2.shouldResolve).toBe(false)
    expect(committed2.committedText).toBe('')
  })

  it('committed text falls back to confirmed segments when data.text is empty, without including interim', () => {
    let state = createInitialSttTranscriptState()
    state = reduceSttFinal(state, '確定セグメント', 'seg-1').state
    state = reduceSttPartial(state, '途中の中途半端な語句').state

    expect(state.interim).toBe('途中の中途半端な語句')
    expect(state.confirmedSegments).toEqual(['確定セグメント'])

    // committed 必须仅固化 confirmed 文本，不得吸收 interim 杂音
    const committed = reduceSttCommitted(state)
    expect(committed.shouldResolve).toBe(true)
    expect(committed.committedText).toBe('確定セグメント')
    expect(committed.committedText).not.toContain('途中の中途半端な語句')
  })

  it('自动停止时连接若已关闭，stop() 仍返回已观察转写并进入与手动说完相同的确认路径', async () => {
    const session = new RealtimeSttSession()
    Reflect.set(session, 'state', 'closed')
    Reflect.set(session, 'latestObservedText', '自動停止までに認識された回答')

    await expect(session.stop()).resolves.toBe('自動停止までに認識された回答')
    expect(selectFinalSttText('正式な確定結果', '途中の観測結果')).toBe('正式な確定結果')
    expect(selectFinalSttText('  ', '  ')).toBeNull()
  })

  it('resets transcript state to clean initial values across recording attempts', () => {
    let state = createInitialSttTranscriptState()
    state = reduceSttFinal(state, '前回の発言', 'seg-1').state
    state = reduceSttPartial(state, '前回の途中').state
    expect(state.confirmedSegments).toHaveLength(1)
    expect(state.interim).toBe('前回の途中')

    // 新的录音尝试由全新的初始状态开始
    const freshState = createInitialSttTranscriptState()
    expect(freshState.confirmedSegments).toEqual([])
    expect(freshState.interim).toBe('')
    expect(freshState.lastFinalId).toBeNull()
    expect(freshState.committedResolved).toBe(false)
  })

  it('notifies the caller when a streaming connection closes unexpectedly', async () => {
    const originalWindow = globalThis.window
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { setTimeout, clearTimeout } })
    const errors: Array<{ code: string }> = []
    try {
      const session = new RealtimeSttSession()
      const start = session.start('token', 'model', {
        onPartial: () => undefined,
        onConnectionState: () => undefined,
        onAudioLevel: () => undefined,
        onError: (error) => errors.push(error),
      })
      await vi.waitFor(() => expect(testConnections.length).toBeGreaterThan(0))
      const connection = testConnections.at(-1)
      connection?.emit('session_started')
      await start
      connection?.emit('close')
      expect(errors).toHaveLength(1)
      expect(errors[0]?.code).toBe('connection_failed')
    } finally {
      if (originalWindow === undefined) Reflect.deleteProperty(globalThis, 'window')
      else Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow })
    }
  })
})
