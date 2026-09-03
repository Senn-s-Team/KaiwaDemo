import { describe, expect, it } from 'vitest'
import { parseTtsMessage, ttsInputMessages, ttsServiceError } from '../../src/lib/tts'
import { toUiError } from '../../src/lib/ui'

describe('ElevenLabs TTS service errors', () => {
  it('reports an unavailable Voice ID instead of blaming the temporary token', () => {
    const error = ttsServiceError(
      'voice_id_does_not_exist',
      'A voice with voice_id invalid does not exist.',
    )

    expect(error.code).toBe('voice_missing')
    expect(error.message).toContain('Voice ID 不存在')
    expect(toUiError(error)).toMatchObject({
      title: '相手语音未完成',
      recovery: 'skip_tts',
    })
  })

  it('reports a plan restriction separately from authentication failure', () => {
    const error = ttsServiceError(
      'payment_required',
      'Free users cannot use library voices via the API.',
    )

    expect(error.code).toBe('payment_required')
    expect(error.message).toContain('套餐不能通过 API 使用该声音')
  })

  it('keeps real token failures classified as token errors', () => {
    const error = ttsServiceError('auth_error', 'The single use token has expired.')
    expect(error.code).toBe('token_expired')
  })
})

describe('ElevenLabs TTS input protocol', () => {
  it('closes the input stream after the complete Japanese question', () => {
    const messages = ttsInputMessages('週末は何をしましたか？').map((message) => JSON.parse(message) as { text: string })

    expect(messages).toHaveLength(3)
    expect(messages[0]?.text).toBe(' ')
    expect(messages[1]?.text).toBe('週末は何をしましたか？ ')
    expect(messages[2]?.text).toBe('')
  })
})

describe('ElevenLabs TTS output protocol', () => {
  it('accepts nullable fields used by real audio and final frames', () => {
    expect(parseTtsMessage({ audio: 'base64', isFinal: null })).toMatchObject({ audio: 'base64', isFinal: null })
    expect(parseTtsMessage({ audio: null, isFinal: true })).toMatchObject({ audio: null, isFinal: true })
  })
})
