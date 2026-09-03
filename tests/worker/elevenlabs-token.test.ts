import { describe, expect, it } from 'vitest'
import { tokenFailureFromUpstream } from '../../worker/elevenlabs'

describe('ElevenLabs single-use token failures', () => {
  it('identifies a missing Speech to Text permission', () => {
    const failure = tokenFailureFromUpstream(
      403,
      {
        detail: {
          code: 'missing_permissions',
          message: 'The API key does not have permission to use speech to text.',
          status: 'restricted_api_key',
        },
      },
      'realtime_scribe',
    )

    expect(failure).toEqual({
      status: 502,
      code: 'elevenlabs_permission',
      message: 'ElevenLabs API Key 缺少 Speech to Text 权限。请在 ElevenLabs API Keys 中启用对应权限。',
    })
  })

  it('keeps invalid keys separate from permission failures', () => {
    const failure = tokenFailureFromUpstream(
      401,
      { detail: { code: 'invalid_api_key', message: 'Invalid API key.' } },
      'tts_websocket',
    )

    expect(failure.code).toBe('elevenlabs_auth')
    expect(failure.message).toContain('API Key 无效')
  })

  it('identifies quota and plan failures', () => {
    const failure = tokenFailureFromUpstream(
      429,
      { detail: { code: 'quota_exceeded', message: 'Quota exceeded.' } },
      'tts_websocket',
    )

    expect(failure.code).toBe('elevenlabs_quota')
    expect(failure.message).toContain('额度、套餐或频率限制')
  })
})
