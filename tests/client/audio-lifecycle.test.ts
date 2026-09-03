import { describe, expect, it } from 'vitest'
import { formatRecordingTime, microphoneLevelToBars, shouldWarnSilence } from '../../src/lib/audio-feedback'
import { microphoneReadinessFromError } from '../../src/lib/microphone'
import { isMicrophoneTrackReady } from '../../src/lib/stt'
import { assertCurrentTtsOperation, createSilentWavBytes, TtsCancelledError } from '../../src/lib/tts'

describe('Safari audio unlock data', () => {
  it('creates a valid PCM WAV header for gesture-time playback', () => {
    const bytes = createSilentWavBytes()
    const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end))

    expect(ascii(0, 4)).toBe('RIFF')
    expect(ascii(8, 12)).toBe('WAVE')
    expect(ascii(36, 40)).toBe('data')
    expect(bytes.length).toBeGreaterThan(44)
  })
})

describe('TTS operation cancellation', () => {
  it('allows the current operation and rejects stale async playback', () => {
    expect(() => assertCurrentTtsOperation(4, 4)).not.toThrow()
    expect(() => assertCurrentTtsOperation(3, 4)).toThrow(TtsCancelledError)
  })
})

describe('microphone permission classification', () => {
  it('distinguishes a denied permission from an unavailable device', () => {
    expect(microphoneReadinessFromError(new DOMException('Permission denied', 'NotAllowedError'))).toBe('denied')
    expect(microphoneReadinessFromError(new DOMException('No device', 'NotFoundError'))).toBe('unavailable')
  })
})

describe('microphone feedback', () => {
  it('formats elapsed time and maps real levels to visible bars', () => {
    expect(formatRecordingTime(0)).toBe('00:00')
    expect(formatRecordingTime(65)).toBe('01:05')
    expect(microphoneLevelToBars(0)).toBe(0)
    expect(microphoneLevelToBars(0.2)).toBe(2)
    expect(microphoneLevelToBars(1)).toBe(7)
  })

  it('warns only after sustained silence', () => {
    expect(shouldWarnSilence(3, false)).toBe(false)
    expect(shouldWarnSilence(4, false)).toBe(true)
    expect(shouldWarnSilence(8, true)).toBe(false)
  })
})

describe('microphone capture readiness', () => {
  it('does not enter recording until the real audio track is live and unmuted', () => {
    expect(isMicrophoneTrackReady(undefined)).toBe(false)
    expect(isMicrophoneTrackReady({ readyState: 'live', enabled: true, muted: true })).toBe(false)
    expect(isMicrophoneTrackReady({ readyState: 'ended', enabled: true, muted: false })).toBe(false)
    expect(isMicrophoneTrackReady({ readyState: 'live', enabled: true, muted: false })).toBe(true)
  })
})
