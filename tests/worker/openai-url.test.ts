import { describe, expect, it } from 'vitest'
import { resolveOpenAiResponsesUrl } from '../../worker/openai'

describe('resolveOpenAiResponsesUrl', () => {
  it('uses the official Responses endpoint by default', () => {
    expect(resolveOpenAiResponsesUrl()).toBe('https://api.openai.com/v1/responses')
  })
  it('routes to chat/completions for third-party gateways or responses for official', () => {
    expect(resolveOpenAiResponsesUrl('https://api.openai.com/v1/')).toBe(
      'https://api.openai.com/v1/responses',
    )
    expect(resolveOpenAiResponsesUrl('https://sub2api.chinnsenn.com/v1/')).toBe(
      'https://sub2api.chinnsenn.com/v1/chat/completions',
    )
    expect(resolveOpenAiResponsesUrl('https://gateway.example.com/custom/responses')).toBe(
      'https://gateway.example.com/custom/responses',
    )
    expect(resolveOpenAiResponsesUrl('https://gateway.example.com/custom/chat/completions')).toBe(
      'https://gateway.example.com/custom/chat/completions',
    )
  })

  it('rejects insecure or credential-bearing URLs before sending the API key', () => {
    expect(() => resolveOpenAiResponsesUrl('http://gateway.example.com/v1')).toThrow('must use HTTPS')
    expect(() => resolveOpenAiResponsesUrl('https://user:secret@gateway.example.com/v1')).toThrow(
      'cannot contain credentials',
    )
    expect(() => resolveOpenAiResponsesUrl('https://gateway.example.com/v1?target=other')).toThrow(
      'cannot contain credentials',
    )
  })
})
