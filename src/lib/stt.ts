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

interface SttHandlers {
  onPartial: (text: string) => void
  onConnectionState: (state: 'connecting' | 'connected' | 'closed') => void
  onAudioLevel: (level: number) => void
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
  private state: SttSessionState = 'idle'
  private sessionGeneration = 0

  async start(token: string, modelId: string, handlers: SttHandlers): Promise<void> {
    this.close()
    const currentGen = ++this.sessionGeneration
    this.state = 'connecting'
    this.committedText = ''
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
        includeTimestamps: true,
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

    const showTranscript = (data: { text: string }) => {
      if (currentGen !== this.sessionGeneration) return
      handlers.onPartial(data.text)
    }

    const handleCommitted = (data: { text: string }) => {
      if (currentGen !== this.sessionGeneration) return
      this.clearFinalizeTimer()
      this.committedText = `${this.committedText} ${data.text}`.trim()
      const resolver = this.stopResolve
      this.stopResolve = null
      this.stopReject = null
      this.close()
      if (resolver) {
        resolver(this.committedText)
      }
    }

    connection.on(RealtimeEvents.PARTIAL_TRANSCRIPT, showTranscript)
    connection.on(RealtimeEvents.FINAL_TRANSCRIPT, showTranscript)
    connection.on(RealtimeEvents.FINAL_TRANSCRIPT_WITH_TIMESTAMPS, showTranscript)
    connection.on(RealtimeEvents.COMMITTED_TRANSCRIPT, handleCommitted)
    connection.on(RealtimeEvents.COMMITTED_TRANSCRIPT_WITH_TIMESTAMPS, handleCommitted)

    connection.on(RealtimeEvents.ERROR, (event) => {
      if (currentGen !== this.sessionGeneration) return
      const raw = typeof event === 'object' && event !== null && 'message' in event ? String(event.message) : ''
      const mapped = this.mapServiceError(raw)
      if (!settled) {
        rejectStart(mapped)
      } else if (this.stopReject) {
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
        this.clearFinalizeTimer()
        const rejector = this.stopReject
        this.stopResolve = null
        this.stopReject = null
        this.close()
        rejector(new SttError('connection_failed', 'STT connection closed before the final transcript arrived.'))
      }
    })

    return startGate.promise
  }

  stop(): Promise<string> {
    this.pipeline.stop()
    this.ringBuffer.clear()
    const connection = this.connection
    if (!connection || this.state === 'closed') {
      return Promise.reject(new SttError('connection_failed', 'No transcription connection is active.'))
    }

    this.state = 'stopping'
    const stopGate = Promise.withResolvers<string>()
    this.stopResolve = stopGate.resolve
    this.stopReject = stopGate.reject
    this.finalizeTimer = window.setTimeout(() => {
      this.stopResolve = null
      this.stopReject = null
      this.close()
      stopGate.reject(new SttError('finalize_timeout', 'STT did not return a final transcript in time.'))
    }, 10_000)

    try {
      connection.commit()
    } catch (error) {
      this.clearFinalizeTimer()
      this.stopResolve = null
      this.stopReject = null
      stopGate.reject(this.mapStartError(error))
    }
    return stopGate.promise
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
