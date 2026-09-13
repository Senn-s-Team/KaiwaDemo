/**
 * [INPUT]: 被 mock 的 src/lib/stt、src/lib/audio-engine、src/lib/voice-recordings、src/lib/api 与真实 createRoundRecord
 * [OUTPUT]: 锁定录音建立后 STT 异常关闭进入可重试 error 阶段、旧会话不污染新操作、失败不保留临时录音的用户可见契约
 * [POS]: tests/client 的语音回合错误传播回归，守护「听写连接已中断」不再停留在假录音状态
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  sessions: [] as Array<{ handlers: Record<string, (value: unknown) => void> }>,
  requestToken: vi.fn(async () => 'token'),
  micFails: false,
  discardCalls: 0,
}))

vi.mock('../../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/api')>('../../src/lib/api')
  return { ...actual, requestElevenLabsToken: mocks.requestToken }
})

vi.mock('../../src/lib/audio-engine', () => {
  class SttError extends Error {
    readonly code: string
    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  }
  return {
    SttError,
    releaseMicrophoneStream: () => undefined,
    unlockAudio: async () => undefined,
    requestMicrophoneStream: async () => {
      if (mocks.micFails) throw new SttError('connection_failed', '麦克风获取失败')
      return { active: true, getAudioTracks: () => [{ readyState: 'live' }], getTracks: () => [] }
    },
  }
})

vi.mock('../../src/lib/voice-recordings', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/voice-recordings')>('../../src/lib/voice-recordings')
  return {
    ...actual,
    createVoiceCapture: () => ({
      start: () => 'started' as const,
      stop: async () => null,
      discard: () => { mocks.discardCalls += 1 },
    }),
  }
})

vi.mock('../../src/lib/stt', async () => {
  const audioEngine = await vi.importMock<typeof import('../../src/lib/audio-engine')>('../../src/lib/audio-engine')
  return {
    SttError: audioEngine.SttError,
    SttTokenManager: class {
      async acquireToken(fetcher: () => Promise<string>): Promise<string> {
        return fetcher()
      }
      async prefetch(fetcher: () => Promise<string>): Promise<string> {
        return fetcher()
      }
      reset(): void {}
    },
    RealtimeSttSession: class {
      close(): void {}
      async start(_token: string, _model: string, handlers: Record<string, (value: unknown) => void>): Promise<void> {
        mocks.sessions.push({ handlers })
      }
      async stop(): Promise<string> { return '' }
    },
  }
})

import { createRoundRecord } from '../../src/lib/metrics'
import { SttError } from '../../src/lib/stt'
import { useVoiceTurnController, type VoiceTurnController } from '../../src/lib/voice-turn-controller'
import type { AppPhase, RoundRecord } from '../../src/types'

function createHarness(): {
  deps: Parameters<typeof useVoiceTurnController>[0]
  round: RoundRecord
  transitions: AppPhase[]
  invalidate: () => void
} {
  const round = createRoundRecord(1, null, 0)
  const transitions: AppPhase[] = []
  let latestOperation = 0
  return {
    deps: {
      sttAvailable: true,
      sttModel: 'model',
      online: true,
      phase: 'waiting_user',
      operation: { begin: () => ++latestOperation, isCurrent: (id: number) => id === latestOperation },
      transitionTo: (next) => { transitions.push(next); return true },
      touchRound: (update) => { update(round) },
      saveRecordingsEnabled: false,
      sessionId: 'session',
      turn: 1,
    },
    round,
    transitions,
    invalidate: () => { latestOperation += 1 },
  }
}

function renderProbe(deps: Parameters<typeof useVoiceTurnController>[0]): { root: Root; container: HTMLDivElement; controller: () => VoiceTurnController } {
  let captured: VoiceTurnController | null = null
  function Probe(): ReactNode {
    captured = useVoiceTurnController(deps)
    return null
  }
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  flushSync(() => root.render(createElement(Probe)))
  return { root, container, controller: () => captured! }
}

describe('voice turn STT failure propagation', () => {
  let mounted: { root: Root; container: HTMLDivElement } | null = null

  afterEach(() => {
    if (mounted) flushSync(() => mounted?.root.unmount())
    mounted?.container.remove()
    mounted = null
    mocks.sessions.length = 0
    mocks.micFails = false
    mocks.discardCalls = 0
    vi.clearAllMocks()
  })

  it('录音建立后 STT 异常关闭进入可重试 error 阶段并计入失败', async () => {
    const harness = createHarness()
    const probe = renderProbe(harness.deps)
    mounted = probe

    await probe.controller().actions.startRecording()
    expect(mocks.sessions).toHaveLength(1)

    mocks.sessions[0]!.handlers.onError!(new SttError('connection_failed', 'STT connection closed unexpectedly.'))

    await vi.waitFor(() => expect(probe.controller().state.voiceError).not.toBeNull(), { interval: 0 })
    expect(probe.controller().state.lastFailedStep).toBe('stt')
    expect(probe.controller().state.voiceError?.code).toBe('connection_failed')
    expect(harness.transitions).toContain('error')
    expect(harness.round.failureCount).toBe(1)
  })

  it('已被新操作取代的旧录音会话不得把界面推入 error', async () => {
    const harness = createHarness()
    const probe = renderProbe(harness.deps)
    mounted = probe

    await probe.controller().actions.startRecording()
    const handlers = mocks.sessions[0]!.handlers
    harness.invalidate()
    handlers.onError!(new SttError('connection_failed', 'late close'))

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(harness.transitions).not.toContain('error')
    expect(probe.controller().state.voiceError).toBeNull()
    expect(harness.round.failureCount).toBe(0)
  })

  it('录音建立失败时不保留临时录音', async () => {
    const harness = createHarness()
    const probe = renderProbe(harness.deps)
    mounted = probe
    mocks.micFails = true
    const discardsBefore = mocks.discardCalls

    await probe.controller().actions.startRecording()

    await vi.waitFor(() => expect(probe.controller().state.voiceError).not.toBeNull(), { interval: 0 })
    expect(harness.transitions).toContain('error')
    // 起点清理一次；失败路径必须再丢弃一次，避免本地录音器继续持有已失效的流。
    expect(mocks.discardCalls).toBe(discardsBefore + 2)
  })
})
