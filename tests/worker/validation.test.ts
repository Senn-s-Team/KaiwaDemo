import { describe, expect, it } from 'vitest'
import { parseReplyRequest, parseTokenRequest, validateAssistantReply, ValidationError } from '../../worker/validation'

const validRequest = {
  sessionId: 'abcdef1234567890',
  scenarioId: 'weekend-chat',
  scenarioVersion: 1,
  variantId: 'casual-coworker',
  turn: 2,
  history: [
    { role: 'assistant', text: '週末は何をして過ごしたんですか？' },
    { role: 'user', text: '映画を見ました。' },
    { role: 'assistant', text: 'どんな映画でしたか？' },
    { role: 'user', text: '日本の映画でした。' },
  ],
}

describe('parseTokenRequest', () => {
  it('only accepts the two browser-safe single-use token types', () => {
    expect(parseTokenRequest({ type: 'realtime_scribe' })).toEqual({ type: 'realtime_scribe' })
    expect(parseTokenRequest({ type: 'tts_websocket' })).toEqual({ type: 'tts_websocket' })
    expect(() => parseTokenRequest({ type: 'batch_scribe' })).toThrow(ValidationError)
  })
})

describe('parseReplyRequest', () => {
  it('accepts bounded alternating history with a matching turn', () => {
    expect(parseReplyRequest(validRequest)).toEqual(validRequest)
  })

  it('rejects a client-declared turn that does not match history', () => {
    expect(() => parseReplyRequest({ ...validRequest, turn: 3 })).toThrow('History does not match the declared turn.')
  })

  it('rejects more than five user turns even when the client asks for more', () => {
    const history = Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 === 0 ? 'assistant' : 'user',
      text: index % 2 === 0 ? '短い質問ですか？' : '短い回答です。',
    }))
    expect(() =>
      parseReplyRequest({
        sessionId: 'abcdef1234567890',
        scenarioId: 'weekend-chat',
        scenarioVersion: 1,
        variantId: 'casual-coworker',
        turn: 6,
        history,
      }),
    ).toThrow(ValidationError)
  })

  it('rejects oversized user text', () => {
    const history = [validRequest.history[0], { role: 'user', text: 'あ'.repeat(601) }]
    expect(() => parseReplyRequest({ ...validRequest, turn: 1, history })).toThrow('exceeds the text limit')
  })
})

describe('validateAssistantReply', () => {
  it('accepts a short natural reply with one question', () => {
    expect(validateAssistantReply('いいですね。誰と行ったんですか？')).toBe('いいですね。誰と行ったんですか？')
  })

  it('rejects multiple questions and markdown output', () => {
    expect(() => validateAssistantReply('どこですか？誰とですか？')).toThrow(ValidationError)
    expect(() => validateAssistantReply('# 返答')).toThrow(ValidationError)
  })
})
