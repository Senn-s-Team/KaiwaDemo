/**
 * [INPUT]: 依赖 @elevenlabs/client 的 Scribe 实时连接、./audio-engine 的麦克风音频采集流水线与缓冲环
 * [OUTPUT]: 对外提供 RealtimeSttSession 类、SttTokenManager 类（含 single-flight 与代际隔离）、SttHandlers 接口（含 onPipelineReady 就绪回调）、selectFinalSttText 与转写规约纯函数
 * [POS]: src/lib 的语音识别核心模块，负责低延迟音频缓冲、实时转写 WebSocket 流处理，并在最终提交连接关闭或超时时保全已观察到的有效转写
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { AudioFormat, CommitStrategy, RealtimeEvents, Scribe, type RealtimeConnection } from '@elevenlabs/client'
import {
  AudioRingBuffer,
  isMicrophoneTrackReady,
  MicrophoneAudioPipeline,
  requestMicrophoneStream,
  SttError,
  unlockAudio,
} from './audio-engine'
export { isMicrophoneTrackReady, SttError }

export interface SttTranscriptParts {
  confirmed: string
  interim: string
}

export interface SttHandlers {
  onPartial: (text: string, parts?: SttTranscriptParts) => void
  onConnectionState: (state: 'connecting' | 'connected' | 'closed') => void
  onAudioLevel: (level: number) => void
  onPipelineReady?: () => void
}

export interface SttTranscriptState {
  confirmedSegments: string[]
  interim: string
  lastFinalId: string | null
  committedResolved: boolean
}

export function createInitialSttTranscriptState(): SttTranscriptState {
  return {
    confirmedSegments: [],
    interim: '',
    lastFinalId: null,
    committedResolved: false,
  }
}

export function reduceSttPartial(
  state: SttTranscriptState,
  text: string,
): { state: SttTranscriptState; parts: SttTranscriptParts; combined: string } {
  const nextState: SttTranscriptState = {
    ...state,
    interim: text || '',
  }
  const confirmed = nextState.confirmedSegments.join(' ').trim()
  const interim = nextState.interim.trim()
  const combined = [confirmed, interim].filter(Boolean).join(' ')
  return {
    state: nextState,
    parts: { confirmed, interim },
    combined,
  }
}

export function reduceSttFinal(
  state: SttTranscriptState,
  text: string,
  eventId?: string | null,
): { state: SttTranscriptState; parts: SttTranscriptParts; combined: string; added: boolean } {
  const cleanText = text?.trim() || ''
  const id = (eventId && eventId.trim()) ? eventId.trim() : null
  if (id !== null && state.lastFinalId === id) {
    const confirmed = state.confirmedSegments.join(' ').trim()
    const interim = state.interim.trim()
    const combined = [confirmed, interim].filter(Boolean).join(' ')
    return {
      state,
      parts: { confirmed, interim },
      combined,
      added: false,
    }
  }

  const nextSegments = cleanText ? [...state.confirmedSegments, cleanText] : state.confirmedSegments
  const nextState: SttTranscriptState = {
    ...state,
    confirmedSegments: nextSegments,
    interim: '',
    lastFinalId: id,
  }
  const confirmed = nextSegments.join(' ').trim()
  const interim = ''
  const combined = confirmed
  return {
    state: nextState,
    parts: { confirmed, interim },
    combined,
    added: Boolean(cleanText),
  }
}

export function reduceSttCommitted(
  state: SttTranscriptState,
  text?: string | null,
): { state: SttTranscriptState; committedText: string; shouldResolve: boolean } {
  if (state.committedResolved) {
    return {
      state,
      committedText: '',
      shouldResolve: false,
    }
  }
  const resolvedText = text?.trim() || state.confirmedSegments.join(' ').trim()
  return {
    state: {
      ...state,
      committedResolved: true,
    },
    committedText: resolvedText,
    shouldResolve: true,
  }
}

export function selectFinalSttText(committedText: string, observedText: string): string | null {
  const committed = committedText.trim()
  if (committed) return committed
  const observed = observedText.trim()
  return observed || null
}


type SttSessionState = 'idle' | 'connecting' | 'streaming' | 'stopping' | 'closed'

export class RealtimeSttSession {
  private connection: RealtimeConnection | null = null
  private pipeline: MicrophoneAudioPipeline = new MicrophoneAudioPipeline()
  private ringBuffer: AudioRingBuffer = new AudioRingBuffer(15) // ~2秒音频缓冲
  private stopResolve: ((text: string) => void) | null = null
  private stopReject: ((error: Error) => void) | null = null
  private finalizeTimer: number | null = null
  private committedText = ''
  private latestObservedText = ''
  private state: SttSessionState = 'idle'
  private sessionGeneration = 0

  async start(token: string, modelId: string, handlers: SttHandlers): Promise<void> {
    this.close()
    const currentGen = ++this.sessionGeneration
    this.state = 'connecting'
    this.committedText = ''
    this.latestObservedText = ''
    this.ringBuffer.clear()

    handlers.onConnectionState('connecting')

    let stream: MediaStream
    try {
      await unlockAudio()
      stream = await requestMicrophoneStream()
    } catch (error) {
      this.state = 'closed'
      throw this.mapStartError(error)
    }

    if (currentGen !== this.sessionGeneration || this.state !== 'connecting') {
      return
    }

    // 0ms 关键架构：拿到流瞬间立即启动本地采样并写入环形缓冲，不等待 WebSocket 握手
    await this.pipeline.start(stream, (base64, rms) => {
      if (currentGen !== this.sessionGeneration) return
      handlers.onAudioLevel(rms)

      if (this.state === 'connecting') {
        // WebSocket 未通：存入本地 Buffer
        this.ringBuffer.push(base64, rms)
      } else if (this.state === 'streaming' && this.connection) {
        // WebSocket 已通：直通发送
        try {
          this.connection.send({ audioBase64: base64 })
        } catch {
          // ignore transient send error
        }
      }
    })

    if (currentGen !== this.sessionGeneration) return
    handlers.onPipelineReady?.()
    // 并发发起 WebSocket TLS 握手
    let connection: RealtimeConnection
    try {
      connection = Scribe.connect({
        token,
        modelId,
        languageCode: 'ja',
        audioFormat: AudioFormat.PCM_16000,
        sampleRate: 16_000,
        commitStrategy: CommitStrategy.MANUAL,
      })
    } catch (error) {
      this.close()
      throw this.mapStartError(error)
    }

    this.connection = connection

    const startGate = Promise.withResolvers<void>()
    let settled = false

    const rejectStart = (error: Error) => {
      if (settled || currentGen !== this.sessionGeneration) return
      settled = true
      this.close()
      startGate.reject(error)
    }

    const startTimer = window.setTimeout(() => {
      rejectStart(new SttError('connection_failed', '麦克风音频没有开始传输。请重试或改用文字回答。'))
    }, 12_000)

    connection.on(RealtimeEvents.SESSION_STARTED, () => {
      if (settled || currentGen !== this.sessionGeneration) return
      settled = true
      window.clearTimeout(startTimer)

      if (this.state === 'connecting') {
        this.state = 'streaming'
        handlers.onConnectionState('connected')

        // 瞬间 Flush 并补发握手期间积累的全部句首音频
        const buffered = this.ringBuffer.flush()
        for (const item of buffered) {
          try {
            connection.send({ audioBase64: item.base64 })
          } catch {}
        }
        startGate.resolve()
      } else if (this.state === 'stopping') {
        // 用户在建连完成前就已经点了“说完了”：直接把缓冲全部推完并提交
        const buffered = this.ringBuffer.flush()
        for (const item of buffered) {
          try {
            connection.send({ audioBase64: item.base64 })
          } catch {}
        }
        try {
          connection.commit()
        } catch {}
        startGate.resolve()
      }
    })

    let transcriptState = createInitialSttTranscriptState()

    const handlePartial = (data: { text: string }) => {
      if (currentGen !== this.sessionGeneration || this.state === 'closed') return
      const reduced = reduceSttPartial(transcriptState, data.text || '')
      transcriptState = reduced.state
      this.latestObservedText = reduced.combined
      handlers.onPartial(reduced.combined, reduced.parts)
    }

    const handleFinal = (data: { text: string; id?: string; segment_id?: string }) => {
      if (currentGen !== this.sessionGeneration || this.state === 'closed') return
      const eventId = data.id || data.segment_id || null
      const reduced = reduceSttFinal(transcriptState, data.text || '', eventId)
      transcriptState = reduced.state
      this.latestObservedText = reduced.combined
      handlers.onPartial(reduced.combined, reduced.parts)
    }

    const handleCommitted = (data: { text?: string }) => {
      if (currentGen !== this.sessionGeneration || this.state === 'closed') return
      const reduced = reduceSttCommitted(transcriptState, data?.text)
      transcriptState = reduced.state
      if (!reduced.shouldResolve) return

      this.clearFinalizeTimer()
      const text = selectFinalSttText(reduced.committedText, this.latestObservedText) ?? ''
      this.committedText = `${this.committedText} ${text}`.trim()
      const resolver = this.stopResolve
      this.stopResolve = null
      this.stopReject = null
      this.close()
      if (resolver) {
        resolver(this.committedText)
      }
    }

    connection.on(RealtimeEvents.PARTIAL_TRANSCRIPT, handlePartial)
    connection.on(RealtimeEvents.FINAL_TRANSCRIPT, handleFinal)
    connection.on(RealtimeEvents.COMMITTED_TRANSCRIPT, handleCommitted)
    connection.on(RealtimeEvents.ERROR, (event) => {
      if (currentGen !== this.sessionGeneration) return
      const raw = typeof event === 'object' && event !== null && 'message' in event ? String(event.message) : ''
      const mapped = this.mapServiceError(raw)
      if (!settled) {
        rejectStart(mapped)
      } else if (this.stopReject) {
        if (this.resolveStopWithObservedText()) return
        this.clearFinalizeTimer()
        const rejector = this.stopReject
        this.stopResolve = null
        this.stopReject = null
        this.close()
        rejector(mapped)
      }
    })

    connection.on(RealtimeEvents.CLOSE, () => {
      if (currentGen !== this.sessionGeneration) return
      if (this.state !== 'closed' && this.state !== 'stopping' && !settled) {
        rejectStart(new SttError('connection_failed', 'STT connection closed unexpectedly.'))
      } else if (this.state === 'stopping' && this.stopReject) {
        if (this.resolveStopWithObservedText()) return
        this.clearFinalizeTimer()
        const rejector = this.stopReject
        this.stopResolve = null
        this.stopReject = null
        this.close()
        rejector(new SttError('connection_failed', 'STT connection closed before the final transcript arrived.'))
      } else if (this.state === 'streaming') {
        this.state = 'closed'
        this.connection = null
        this.pipeline.stop()
        handlers.onConnectionState('closed')
      }
    })

    return startGate.promise
  }

  stop(): Promise<string> {
    this.pipeline.stop()
    this.ringBuffer.clear()
    const connection = this.connection
    if (!connection || this.state === 'closed') {
      const observedText = selectFinalSttText(this.committedText, this.latestObservedText)
      return observedText
        ? Promise.resolve(observedText)
        : Promise.reject(new SttError('connection_failed', 'No transcription connection is active.'))
    }

    this.state = 'stopping'
    const stopGate = Promise.withResolvers<string>()
    this.stopResolve = stopGate.resolve
    this.stopReject = stopGate.reject
    this.finalizeTimer = window.setTimeout(() => {
      if (this.resolveStopWithObservedText()) return
      this.stopResolve = null
      this.stopReject = null
      this.close()
      stopGate.reject(new SttError('finalize_timeout', 'STT did not return a final transcript in time.'))
    }, 10_000)

    try {
      connection.commit()
    } catch (error) {
      if (this.resolveStopWithObservedText()) return stopGate.promise
      this.clearFinalizeTimer()
      this.stopResolve = null
      this.stopReject = null
      stopGate.reject(this.mapStartError(error))
    }
    return stopGate.promise
  }

  private resolveStopWithObservedText(): boolean {
    const resolver = this.stopResolve
    const text = selectFinalSttText(this.committedText, this.latestObservedText)
    if (!resolver || text === null) return false

    this.stopResolve = null
    this.stopReject = null
    this.close()
    resolver(text)
    return true
  }

  close(): void {
    this.sessionGeneration += 1
    this.state = 'closed'
    this.clearFinalizeTimer()
    this.pipeline.stop()
    this.ringBuffer.clear()
    if (this.connection) {
      try {
        this.connection.close()
      } catch {}
      this.connection = null
    }
  }
  private clearFinalizeTimer(): void {
    if (this.finalizeTimer !== null) {
      window.clearTimeout(this.finalizeTimer)
      this.finalizeTimer = null
    }
  }

  private mapStartError(error: unknown): SttError {
    if (error instanceof SttError) return error
    const message = error instanceof Error ? error.message : String(error)
    if (/NotAllowed|Permission|denied/i.test(message)) {
      return new SttError('permission_denied', '麦克风权限被拒绝。请在 Safari 网站设置中允许麦克风，或改用文字输入。')
    }
    if (/NotFound|device|microphone/i.test(message)) {
      return new SttError('device_missing', '没有可用麦克风。请连接输入设备，或改用文字输入。')
    }
    return new SttError('connection_failed', '无法启动 ElevenLabs STT。请检查网络后重试。')
  }

  private mapServiceError(message: string): SttError {
    if (/token|auth|expired/i.test(message)) {
      return new SttError('token_expired', '临时 STT 令牌无效或已过期。请重新连接。')
    }
    return new SttError('connection_failed', 'ElevenLabs STT 连接失败。请重试或改用文字输入。')
  }
}

export interface CachedSttToken {
  token: string
  expiresAt: number
}

export class SttTokenManager {
  private cached: CachedSttToken | null = null
  private inFlightPromise: Promise<string> | null = null
  private epoch = 0
  private readonly tokenLifetimeMs: number

  constructor(tokenLifetimeMs = 800_000) {
    this.tokenLifetimeMs = tokenLifetimeMs
  }

  getCached(): CachedSttToken | null {
    return this.cached
  }

  consumeFreshToken(now = Date.now()): string | null {
    if (this.cached && this.cached.expiresAt > now) {
      const { token } = this.cached
      this.cached = null
      return token
    }
    this.cached = null
    return null
  }

  async prefetch(fetcher: () => Promise<string>, now = Date.now()): Promise<string | null> {
    if (this.cached && this.cached.expiresAt > now + 60_000) {
      return this.cached.token
    }
    try {
      return await this.fetchSingleFlight(fetcher, now)
    } catch {
      return null
    }
  }

  async acquireToken(fetcher: () => Promise<string>, now = Date.now()): Promise<string> {
    const fresh = this.consumeFreshToken(now)
    if (fresh) {
      return fresh
    }
    const inFlight = this.inFlightPromise
    if (inFlight) {
      const token = await inFlight
      if (this.cached?.token === token) {
        this.cached = null
      }
      return token
    }
    return this.fetchSingleFlight(fetcher, now, true)
  }

  reset(): void {
    this.epoch += 1
    this.cached = null
    this.inFlightPromise = null
  }

  private fetchSingleFlight(
    fetcher: () => Promise<string>,
    now: number,
    consumeImmediately = false,
  ): Promise<string> {
    if (this.inFlightPromise) {
      return this.inFlightPromise
    }
    const currentEpoch = this.epoch
    const promise = fetcher()
      .then((token) => {
        if (this.epoch === currentEpoch && !consumeImmediately) {
          this.cached = { token, expiresAt: now + this.tokenLifetimeMs }
        }
        return token
      })
      .finally(() => {
        if (this.epoch === currentEpoch && this.inFlightPromise === promise) {
          this.inFlightPromise = null
        }
      })
    this.inFlightPromise = promise
    return promise
  }
}
