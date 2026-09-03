import { z } from 'zod'
import { requestElevenLabsToken } from './api'

const TtsMessageSchema = z.object({
  audio: z.string().nullable().optional(),
  isFinal: z.boolean().nullable().optional(),
  error: z.string().nullable().optional(),
  message: z.string().nullable().optional(),
  code: z.number().nullable().optional(),
})

export function parseTtsMessage(payload: unknown): z.infer<typeof TtsMessageSchema> | null {
  const parsed = TtsMessageSchema.safeParse(payload)
  return parsed.success ? parsed.data : null
}

interface CachedAudio {
  url: string
  bytes: number
}

interface SpeakOptions {
  text: string
  voiceId: string
  modelId: string
  onGenerationStarted: () => void
  onFirstAudio: () => void
  onAudioStarted: () => void
  onAudioEnded: () => void
  onTtsRequest: (characters: number) => void
}

export class TtsCancelledError extends Error {}

export class TtsError extends Error {
  readonly code: 'token_expired' | 'voice_missing' | 'payment_required' | 'generation_failed' | 'playback_blocked' | 'network'

  constructor(code: TtsError['code'], message: string) {
    super(message)
    this.code = code
  }
}

export function ttsServiceError(errorCode: string | undefined, message: string | undefined): TtsError {
  const detail = message?.trim() || 'ElevenLabs TTS 请求失败。'
  if (errorCode === 'voice_id_does_not_exist') {
    return new TtsError('voice_missing', `配置的 ElevenLabs Voice ID 不存在或当前账户无权使用：${detail}`)
  }
  if (errorCode === 'payment_required') {
    return new TtsError('payment_required', `当前 ElevenLabs 套餐不能通过 API 使用该声音：${detail}`)
  }
  if (/token|auth|expired|unauthorized/i.test(`${errorCode ?? ''} ${detail}`)) {
    return new TtsError('token_expired', `临时 TTS 令牌无效或已过期：${detail}`)
  }
  return new TtsError('generation_failed', detail)
}

export function ttsInputMessages(text: string): string[] {
  return [
    JSON.stringify({
      text: ' ',
      voice_settings: { stability: 0.55, similarity_boost: 0.75, style: 0, use_speaker_boost: true, speed: 1 },
      generation_config: { chunk_length_schedule: [50, 80, 120] },
    }),
    JSON.stringify({ text: `${text} ` }),
    JSON.stringify({ text: '' }),
  ]
}

export function createSilentWavBytes(): Uint8Array {
  const sampleRate = 8_000
  const sampleCount = 400
  const bytes = new Uint8Array(44 + sampleCount * 2)
  const view = new DataView(bytes.buffer)
  const writeAscii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index))
  }

  writeAscii(0, 'RIFF')
  view.setUint32(4, bytes.length - 8, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(36, 'data')
  view.setUint32(40, sampleCount * 2, true)
  return bytes
}

export function assertCurrentTtsOperation(expected: number, current: number): void {
  if (expected !== current) throw new TtsCancelledError('A newer audio action replaced this TTS operation.')
}

export class CachedTtsPlayer {
  private readonly cache = new Map<string, CachedAudio>()
  private audio: HTMLAudioElement | null = null
  private playbackAbort: AbortController | null = null
  private audioContext: AudioContext | null = null
  private generationSocket: WebSocket | null = null
  private generationReject: ((error: Error) => void) | null = null
  private operationId = 0

  async unlock(): Promise<void> {
    if (!this.audio) {
      this.audio = new Audio()
      this.audio.preload = 'auto'
      this.audio.setAttribute('playsinline', '')
    }

    const silentUrl = URL.createObjectURL(new Blob([createSilentWavBytes().slice().buffer], { type: 'audio/wav' }))
    this.audio.muted = true
    this.audio.src = silentUrl
    try {
      await this.audio.play()
    } finally {
      this.audio.pause()
      this.audio.removeAttribute('src')
      this.audio.load()
      this.audio.muted = false
      URL.revokeObjectURL(silentUrl)
    }

    const AudioContextConstructor = window.AudioContext
    if (!this.audioContext) this.audioContext = new AudioContextConstructor()
    if (this.audioContext.state === 'suspended') await this.audioContext.resume()
  }

  async speak(options: SpeakOptions): Promise<{ generated: boolean; bytes: number }> {
    this.stop()
    const operationId = this.operationId
    const key = `${options.voiceId}:${options.modelId}:${options.text}`
    let cached = this.cache.get(key)
    let generated = false

    if (!cached) {
      options.onGenerationStarted()
      cached = await this.generate(options, operationId)
      assertCurrentTtsOperation(operationId, this.operationId)
      this.cache.set(key, cached)
      options.onTtsRequest(options.text.length)
      generated = true
    }

    assertCurrentTtsOperation(operationId, this.operationId)
    await this.play(cached.url, options, operationId)
    return { generated, bytes: cached.bytes }
  }

  stop(): void {
    this.operationId += 1
    if (this.generationReject) {
      const reject = this.generationReject
      this.generationReject = null
      reject(new TtsCancelledError('TTS generation was stopped.'))
    }
    this.generationSocket?.close()
    this.generationSocket = null
    this.playbackAbort?.abort()
    this.playbackAbort = null
    if (this.audio) {
      this.audio.pause()
      this.audio.removeAttribute('src')
      this.audio.load()
    }
  }

  dispose(): void {
    this.stop()
    for (const item of this.cache.values()) URL.revokeObjectURL(item.url)
    this.cache.clear()
    void this.audioContext?.close()
    this.audioContext = null
    this.audio = null
  }

  private async generate(options: SpeakOptions, operationId: number): Promise<CachedAudio> {
    const token = await requestElevenLabsToken('tts_websocket')
    assertCurrentTtsOperation(operationId, this.operationId)
    const query = new URLSearchParams({
      model_id: options.modelId,
      language_code: 'ja',
      output_format: 'mp3_44100_128',
      single_use_token: token,
    })
    const url = `wss://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(options.voiceId)}/stream-input?${query}`

    return new Promise<CachedAudio>((resolve, reject) => {
      const socket = new WebSocket(url)
      this.generationSocket = socket
      this.generationReject = reject
      const chunks: Uint8Array[] = []
      let firstAudioSeen = false
      let settled = false
      const timeout = window.setTimeout(() => {
        socket.close()
        if (!settled) reject(new TtsError('generation_failed', 'ElevenLabs TTS 生成超时。可以跳过语音并继续。'))
      }, 25_000)

      const fail = (error: Error) => {
        if (settled) return
        settled = true
        window.clearTimeout(timeout)
        this.generationSocket = null
        this.generationReject = null
        socket.close()
        reject(error)
      }

      socket.addEventListener('open', () => {
        for (const message of ttsInputMessages(options.text)) {
          socket.send(message)
        }
      })

      socket.addEventListener('message', (event) => {
        let payload: unknown
        try {
          payload = JSON.parse(String(event.data)) as unknown
        } catch {
          fail(new TtsError('generation_failed', 'ElevenLabs TTS 返回了无法读取的数据。'))
          return
        }
        const parsed = parseTtsMessage(payload)
        if (!parsed) return
        if (parsed.error) {
          fail(ttsServiceError(parsed.error, parsed.message ?? undefined))
          return
        }

        if (parsed.audio) {
          const binary = window.atob(parsed.audio)
          const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
          chunks.push(bytes)
          if (!firstAudioSeen) {
            firstAudioSeen = true
            options.onFirstAudio()
          }
        }

        if (parsed.isFinal) {
          settled = true
          window.clearTimeout(timeout)
          this.generationSocket = null
          this.generationReject = null
          const blob = new Blob(chunks.map((chunk) => chunk.slice().buffer), { type: 'audio/mpeg' })
          resolve({ url: URL.createObjectURL(blob), bytes: blob.size })
        }
      })

      socket.addEventListener('error', () => fail(new TtsError('network', 'ElevenLabs TTS 连接失败。可以重试或只阅读文字。')))
      socket.addEventListener('close', (event) => {
        if (!settled && event.code === 1000) return
        if (!settled && event.code === 1008) {
          fail(ttsServiceError(undefined, event.reason))
        } else if (!settled) {
          fail(new TtsError('generation_failed', `ElevenLabs TTS 在音频完成前断开：${event.reason || `WebSocket ${event.code}`}`))
        }
      })
    })
  }

  private async play(url: string, options: SpeakOptions, operationId: number): Promise<void> {
    assertCurrentTtsOperation(operationId, this.operationId)
    if (!this.audio) {
      this.audio = new Audio()
      this.audio.preload = 'auto'
      this.audio.setAttribute('playsinline', '')
    }
    const audio = this.audio
    audio.src = url
    const abort = new AbortController()
    this.playbackAbort = abort

    try {
      await audio.play()
      assertCurrentTtsOperation(operationId, this.operationId)
      options.onAudioStarted()
    } catch (error) {
      this.playbackAbort = null
      assertCurrentTtsOperation(operationId, this.operationId)
      if (error instanceof TtsCancelledError) throw error
      throw new TtsError('playback_blocked', 'Safari 阻止了音频播放。请再次点击“重新播放”。')
    }

    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        audio.removeEventListener('ended', onEnded)
        audio.removeEventListener('error', onError)
        abort.signal.removeEventListener('abort', onAbort)
      }
      const onEnded = () => {
        cleanup()
        options.onAudioEnded()
        resolve()
      }
      const onError = () => {
        cleanup()
        try {
          assertCurrentTtsOperation(operationId, this.operationId)
          reject(new TtsError('generation_failed', '浏览器无法播放生成的音频。'))
        } catch (error) {
          reject(error)
        }
      }
      const onAbort = () => {
        cleanup()
        reject(new TtsCancelledError('Audio playback was stopped.'))
      }
      audio.addEventListener('ended', onEnded, { once: true })
      audio.addEventListener('error', onError, { once: true })
      abort.signal.addEventListener('abort', onAbort, { once: true })
    }).finally(() => {
      if (this.playbackAbort === abort) this.playbackAbort = null
    })
  }
}
