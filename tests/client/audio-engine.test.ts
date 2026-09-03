import { describe, expect, it } from 'vitest'
import {
  calculateRmsLevel,
  floatTo16BitPcm,
  floatTo16BitPcmBase64,
  resampleTo16kHz,
} from '../../src/lib/audio-engine'

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
