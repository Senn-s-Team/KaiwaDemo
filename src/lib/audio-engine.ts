export class SttError extends Error {
  readonly code: 'permission_denied' | 'device_missing' | 'token_expired' | 'connection_failed' | 'finalize_timeout'

  constructor(code: SttError['code'], message: string) {
    super(message)
    this.code = code
  }
}

export function microphoneReadinessFromError(error: unknown): 'denied' | 'unavailable' {
  const name = error instanceof DOMException ? error.name : ''
  const message = error instanceof Error ? error.message : String(error)
  if (name === 'NotAllowedError' || /permission|denied|notallowed/i.test(message)) return 'denied'
  return 'unavailable'
}

export interface AudioChunkCallback {
  (base64Chunk: string, rmsLevel: number): void
}
const TARGET_SAMPLE_RATE = 16_000

let sharedAudioContext: AudioContext | null = null
let sharedMicrophoneStream: MediaStream | null = null
let isRequestingPermission = false

export function setPermissionRequesting(state: boolean): void {
  isRequestingPermission = state
}

export function getSharedAudioContext(): AudioContext {
  if (!sharedAudioContext) {
    const AudioContextClass = window.AudioContext
    sharedAudioContext = new AudioContextClass()
  }
  return sharedAudioContext
}

export async function unlockAudio(): Promise<void> {
  const ctx = getSharedAudioContext()
  if (ctx.state !== 'running') {
    await ctx.resume().catch(() => undefined)
  }
}

export async function requestMicrophoneStream(): Promise<MediaStream> {
  if (sharedMicrophoneStream && sharedMicrophoneStream.active) {
    const [track] = sharedMicrophoneStream.getAudioTracks()
    if (track && track.readyState === 'live' && track.enabled && !track.muted) {
      return sharedMicrophoneStream
    }
    // 轨已失效或被系统静音，先清理旧流
    releaseMicrophoneStream()
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    throw new SttError('device_missing', '当前设备不支持网页录音。')
  }

  try {
    isRequestingPermission = true
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
      video: false,
    })

    sharedMicrophoneStream = stream
    return stream
  } catch (error) {
    const readiness = microphoneReadinessFromError(error)
    if (readiness === 'denied') {
      throw new SttError('permission_denied', '麦克风权限被拒绝。请在浏览器设置中允许麦克风。')
    }
    throw new SttError('device_missing', '没有可用麦克风。请连接输入设备或改用文字回答。')
  } finally {
    isRequestingPermission = false
  }
}

export function isMicrophoneTrackReady(
  track: Pick<MediaStreamTrack, 'readyState' | 'enabled' | 'muted'> | undefined,
): track is MediaStreamTrack {
  return track?.readyState === 'live' && track.enabled && !track.muted
}

export function getMicrophoneTrack(): MediaStreamTrack | null {
  if (!sharedMicrophoneStream || !sharedMicrophoneStream.active) return null
  const [track] = sharedMicrophoneStream.getAudioTracks()
  return isMicrophoneTrackReady(track) ? track : null
}

export function releaseMicrophoneStream(): void {
  if (sharedMicrophoneStream) {
    for (const track of sharedMicrophoneStream.getTracks()) {
      track.stop()
    }
    sharedMicrophoneStream = null
  }
}

// 监听页面可见性与卸载事件，离开前台或关闭页面时立即彻底销毁硬件占用
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && !isRequestingPermission) {
      releaseMicrophoneStream()
    }
  })
  window.addEventListener('pagehide', () => {
    releaseMicrophoneStream()
  })
}
export function calculateRmsLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i += 1) {
    const val = samples[i] ?? 0
    sum += val * val
  }
  const rms = Math.sqrt(sum / samples.length)
  return Math.min(1, rms * 8)
}

export function resampleFloat32(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || input.length === 0) return input
  const ratio = fromRate / toRate
  const outLength = Math.floor(input.length / ratio)
  const result = new Float32Array(outLength)

  for (let i = 0; i < outLength; i += 1) {
    const srcIndex = i * ratio
    const srcFloor = Math.floor(srcIndex)
    const srcCeil = Math.min(input.length - 1, srcFloor + 1)
    const weight = srcIndex - srcFloor
    const sampleFloor = input[srcFloor] ?? 0
    const sampleCeil = input[srcCeil] ?? 0
    result[i] = sampleFloor * (1 - weight) + sampleCeil * weight
  }

  return result
}

export function resampleTo16kHz(input: Float32Array, fromRate: number): Float32Array {
  return resampleFloat32(input, fromRate, TARGET_SAMPLE_RATE)
}

export function floatTo16BitPcm(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length)
  for (let i = 0; i < input.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, input[i] ?? 0))
    output[i] = sample < 0 ? sample * 32_768 : sample * 32_767
  }
  return output
}

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 8_192
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  const globalObj = globalThis as {
    btoa?: (s: string) => string
    Buffer?: { from(s: string, enc: string): { toString(enc: string): string } }
  }
  if (typeof globalObj.btoa === 'function') {
    return globalObj.btoa(binary)
  }
  if (globalObj.Buffer) {
    return globalObj.Buffer.from(binary, 'binary').toString('base64')
  }
  return ''
}

export function floatTo16BitPcmBase64(input: Float32Array): string {
  const pcm = floatTo16BitPcm(input)
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  return uint8ArrayToBase64(bytes)
}
export class AudioRingBuffer {
  private buffer: Array<{ base64: string; rms: number }> = []
  private readonly maxChunks: number

  constructor(maxChunks = 15) { // 15 chunks @ 4096 samples ≈ 2 秒
    this.maxChunks = maxChunks
  }

  push(base64: string, rms: number): void {
    if (this.buffer.length >= this.maxChunks) {
      this.buffer.shift()
    }
    this.buffer.push({ base64, rms })
  }

  flush(): Array<{ base64: string; rms: number }> {
    const items = [...this.buffer]
    this.buffer = []
    return items
  }

  clear(): void {
    this.buffer = []
  }

  get length(): number {
    return this.buffer.length
  }
}

export class MicrophoneAudioPipeline {
  private sourceNode: MediaStreamAudioSourceNode | null = null
  private processorNode: ScriptProcessorNode | null = null
  private isRunning = false
  private callback: AudioChunkCallback | null = null
  private generation = 0

  async start(stream: MediaStream, callback: AudioChunkCallback): Promise<void> {
    this.stop()
    const currentGen = ++this.generation
    this.callback = callback
    this.isRunning = true

    const ctx = getSharedAudioContext()
    if (ctx.state !== 'running') {
      await ctx.resume().catch(() => undefined)
    }

    if (!this.isRunning || currentGen !== this.generation) {
      return
    }

    const source = ctx.createMediaStreamSource(stream)
    const processor = ctx.createScriptProcessor(4_096, 1, 1)

    processor.onaudioprocess = (event: AudioProcessingEvent) => {
      if (!this.isRunning || currentGen !== this.generation || !this.callback) return
      const inputBuffer = event.inputBuffer
      const inputData = inputBuffer.getChannelData(0)
      if (!inputData || inputData.length === 0) return

      const rms = calculateRmsLevel(inputData)
      const resampled = resampleFloat32(inputData, inputBuffer.sampleRate, TARGET_SAMPLE_RATE)
      const base64 = floatTo16BitPcmBase64(resampled)

      this.callback(base64, rms)
    }

    source.connect(processor)
    processor.connect(ctx.destination)

    this.sourceNode = source
    this.processorNode = processor
  }

  stop(): void {
    this.generation += 1
    this.isRunning = false
    this.callback = null
    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect()
      } catch {}
      this.sourceNode = null
    }
    if (this.processorNode) {
      try {
        this.processorNode.disconnect()
        this.processorNode.onaudioprocess = null
      } catch {}
      this.processorNode = null
    }
  }

  dispose(): void {
    this.stop()
  }
}
