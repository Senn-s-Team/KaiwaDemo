/**
 * [INPUT]: 依赖音频转换、AudioContext 生命周期公开接口
 * [OUTPUT]: 验证 PCM 转换、RMS 计算与后台恢复后的 AudioContext 可用性
 * [POS]: tests/client 的音频底层回归测试，保护 closed context 不复用及恢复失败不静默
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { describe, expect, it } from 'vitest'
import {
  calculateRmsLevel,
  floatTo16BitPcm,
  floatTo16BitPcmBase64,
  getSharedAudioContext,
  resampleTo16kHz,
  unlockAudio,
} from '../../src/lib/audio-engine'

describe('AudioContext recovery', () => {
  it('replaces a closed context and reports a suspended context that cannot resume', async () => {
    const originalWindow = globalThis.window
    const contexts: Array<{ state: AudioContextState; resume: () => Promise<void> }> = []
    class FakeAudioContext {
      readonly state: AudioContextState
      constructor() {
        const index = contexts.length
        this.state = index === 0 ? 'closed' : 'suspended'
        contexts.push({ state: this.state, resume: async () => Promise.reject(new Error('blocked')) })
      }
    }
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { AudioContext: FakeAudioContext },
    })

    try {
      const closed = getSharedAudioContext()
      expect(closed.state).toBe('closed')
      const replacement = getSharedAudioContext()
      expect(contexts).toHaveLength(2)
      expect(replacement.state).toBe('suspended')
      await expect(unlockAudio()).rejects.toMatchObject({ code: 'connection_failed' })
      const retry = getSharedAudioContext()
      expect(contexts).toHaveLength(3)
      expect(retry).not.toBe(replacement)
      expect(retry.state).toBe('suspended')
    } finally {
      if (originalWindow === undefined) {
        Reflect.deleteProperty(globalThis, 'window')
      } else {
        Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow })
      }
    }
  })
})

describe('PCM16 audio conversion', () => {
  it('linearly resamples 48 kHz input to 16 kHz', () => {
    const input = new Float32Array([0, 0.2, 0.4, 0.6, 0.8, 1])
    const output = resampleTo16kHz(input, 48_000)
    expect(output).toHaveLength(2)
    expect(output[0]).toBeCloseTo(0)
    expect(output[1]).toBeCloseTo(0.6)
  })

  it('clamps Float32 samples to the PCM16 range', () => {
    const pcm = floatTo16BitPcm(new Float32Array([-2, -1, 0, 1, 2]))

    expect(Array.from(pcm)).toEqual([-32_768, -32_768, 0, 32_767, 32_767])
    expect(Math.min(...pcm)).toBe(-32_768)
    expect(Math.max(...pcm)).toBe(32_767)
  })

  it('encodes PCM16 samples as little-endian Base64', () => {
    const encoded = floatTo16BitPcmBase64(new Float32Array([-1, 0, 1]))

    expect(encoded).toBe('AIAAAP9/')
  })
})

describe('RMS audio level', () => {
  it('returns zero for silence', () => {
    expect(calculateRmsLevel(new Float32Array([0, 0, 0]))).toBe(0)
  })

  it('returns one for full-scale samples', () => {
    expect(calculateRmsLevel(new Float32Array([1, -1, 1, -1]))).toBe(1)
  })
})
