/**
 * [INPUT]: useVoiceTurnController 与可控 STT、本机录音暂存替身
 * [OUTPUT]: 锁定普通回合确认前不保存及各中断路径废弃暂存录音
 * [POS]: tests/client 的普通回合本机录音生命周期回归
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
// @vitest-environment jsdom
import { createElement, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  stop: vi.fn<() => Promise<string>>(), captureStart: vi.fn<() => 'started' | 'unavailable'>(), captureStop: vi.fn<() => Promise<{ sessionId: string; turn: number; kind: 'round'; blob: Blob; createdAt: number; durationMs: number; mimeType: string } | null>>(), captureDiscard: vi.fn(), save: vi.fn<() => Promise<void>>(),
}))
vi.mock('../../src/lib/api', () => ({ requestElevenLabsToken: vi.fn(async () => 'token') }))
vi.mock('../../src/lib/audio-engine', () => ({ releaseMicrophoneStream: vi.fn(), SttError: class SttError extends Error { code = 'no_speech_detected' }, unlockAudio: vi.fn(async () => undefined) }))
vi.mock('../../src/lib/recording-setup', () => ({ coordinateRecordingSetup: async (options: { acquireToken: () => Promise<string>; onMicrophoneStream?: (stream: MediaStream) => void; connectStt: (token: string) => Promise<void> }) => { options.onMicrophoneStream?.({} as MediaStream); await options.connectStt(await options.acquireToken()); return true } }))
vi.mock('../../src/lib/stt', () => ({ RealtimeSttSession: class { start = async (_token: string, _model: string, handlers: { onPipelineReady?: () => void }) => handlers.onPipelineReady?.(); stop = mocks.stop; close(): void {} }, SttTokenManager: class { acquireToken = (get: () => Promise<string>) => get(); prefetch = (get: () => Promise<string>) => get(); reset(): void {} }, SttError: class SttError extends Error { code = 'no_speech_detected' } }))
vi.mock('../../src/lib/voice-recordings', () => ({ createVoiceCapture: () => ({ start: mocks.captureStart, stop: mocks.captureStop, discard: mocks.captureDiscard }), saveVoiceRecording: mocks.save }))

import { useVoiceTurnController, type VoiceTurnController } from '../../src/lib/voice-turn-controller'

function Harness({ expose }: { expose: (controller: VoiceTurnController) => void }): React.JSX.Element {
  const [phase, setPhase] = useState<'waiting_user' | 'connecting_stt' | 'recording' | 'finalizing_transcript' | 'confirming_transcript' | 'error'>('waiting_user')
  const controller = useVoiceTurnController({ sttAvailable: true, sttModel: 'scribe', online: true, phase, operation: { begin: () => 1, isCurrent: () => true }, transitionTo: (next) => { setPhase(next as typeof phase); return true }, touchRound: () => undefined, saveRecordingsEnabled: true, sessionId: 'session', turn: 1 })
  useEffect(() => expose(controller), [controller, expose])
  return createElement('div')
}

describe('普通回合本机录音生命周期', () => {
  let container: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  let controller: VoiceTurnController | undefined
  beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); mocks.stop.mockReset().mockResolvedValue('こんにちは'); mocks.captureStart.mockReset().mockReturnValue('started'); mocks.captureStop.mockReset().mockResolvedValue({ sessionId: 'session', turn: 1, kind: 'round', blob: new Blob(['voice']), createdAt: 1, durationMs: 10, mimeType: 'audio/webm' }); mocks.captureDiscard.mockReset(); mocks.save.mockReset().mockResolvedValue(undefined); flushSync(() => root.render(createElement(Harness, { expose: (value) => { controller = value } }))) })
  afterEach(() => { root.unmount(); container.remove(); vi.clearAllMocks() })
  async function recordAndStop(): Promise<void> { await controller!.actions.startRecording(); await vi.waitFor(() => expect(controller?.state.recordingUiStartedAt).not.toBeNull(), { interval: 0 }); await controller!.actions.stopRecording() }

  it('停止仅产生暂存，确认才精确保存一次', async () => {
    await recordAndStop()
    expect(mocks.captureStop).toHaveBeenCalledOnce()
    expect(mocks.save).not.toHaveBeenCalled()
    controller!.actions.confirmRecording()
    await vi.waitFor(() => expect(mocks.save).toHaveBeenCalledOnce(), { interval: 0 })
    controller!.actions.confirmRecording()
    expect(mocks.save).toHaveBeenCalledOnce()
  })
  it('重录、文字输入、dispose 与最终转写失败都会废弃暂存且不能保存', async () => {
    await recordAndStop(); await controller!.actions.rerecord(); controller!.actions.confirmRecording()
    expect(mocks.save).not.toHaveBeenCalled()
    await recordAndStop(); controller!.actions.enterTextInput(); controller!.actions.confirmRecording()
    expect(mocks.save).not.toHaveBeenCalled()
    await recordAndStop(); controller!.actions.dispose(); controller!.actions.confirmRecording()
    expect(mocks.save).not.toHaveBeenCalled()
    mocks.stop.mockResolvedValueOnce('。。。'); await controller!.actions.startRecording(); await controller!.actions.stopRecording(); controller!.actions.confirmRecording()
    expect(mocks.save).not.toHaveBeenCalled()
    expect(mocks.captureDiscard).toHaveBeenCalled()
  })
})
