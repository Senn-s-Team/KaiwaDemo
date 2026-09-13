import { describe, expect, it } from 'vitest'
import {
  parseConversationFeedbackRequest,
  parseHintRequest,
  parseListeningScaffoldModelOutput,
  parseListeningScaffoldRequest,
  parseRedoFeedbackRequest,
  parseReplyRequest,
  parseTokenRequest,
  validateAssistantReply,
  ValidationError,
} from '../../worker/validation'

const validReply = {
  scenarioType: 'dynamic' as const,
  sessionToken: 'signed-session-token',
  sessionId: 'abcdef1234567890',
  turn: 2,
  history: [
    { role: 'assistant' as const, text: 'いらっしゃいませ。ご注文はお決まりですか？' },
    { role: 'user' as const, text: 'ラテをお願いします。' },
    { role: 'assistant' as const, text: 'サイズはいかがなさいますか？' },
    { role: 'user' as const, text: 'トールでお願いします。' },
  ],
}

const record = (turn: number) => ({
  turn,
  partnerPromptJa: turn === 1 ? 'いらっしゃいませ。ご注文はお決まりですか？' : `相手の第${turn}発話`,
  userOriginal: 'らて おねがいします',
  userCleaned: 'ラテをお願いします。',
  userConfirmed: 'ラテをお願いします。',
  inputMode: 'stt' as const,
  transcriptModified: true,
  rerecordCount: 0,
  partnerAudioPlayCount: 2,
  ttsReplayCount: 1,
  transcriptRevealed: false,
  listeningScaffoldLevel: 1 as const,
  expressionScaffoldLevel: 4 as const,
  failureCount: 0,
  retryCount: 0,
  speechAssistUsed: false,
  textFallback: false,
})

describe('worker request validation', () => {
  it('only accepts browser-safe ElevenLabs token types', () => {
    expect(parseTokenRequest({ type: 'realtime_scribe' })).toEqual({ type: 'realtime_scribe' })
    expect(parseTokenRequest({ type: 'tts_websocket' })).toEqual({ type: 'tts_websocket' })
    expect(() => parseTokenRequest({ type: 'batch_scribe' })).toThrow(ValidationError)
  })

  it('accepts matching dynamic history and rejects catalog or a sixth turn', () => {
    expect(parseReplyRequest(validReply)).toEqual(validReply)
    expect(() => parseReplyRequest({ ...validReply, scenarioType: 'catalog' })).toThrow(ValidationError)
    expect(() => parseReplyRequest({ ...validReply, turn: 6 })).toThrow(ValidationError)
  })

  it('accepts one to five feedback records and L0-L4 listening levels while rejecting level 5', () => {
    const valid = {
      scenarioType: 'dynamic',
      sessionToken: 'signed-session-token',
      turnRecords: [1, 2, 3, 4, 5].map(record),
    }
    expect(parseConversationFeedbackRequest(valid)).toEqual(valid)
    expect(parseConversationFeedbackRequest({ ...valid, turnRecords: valid.turnRecords.slice(0, 1) }).turnRecords).toHaveLength(1)
    expect(() => parseConversationFeedbackRequest({ ...valid, turnRecords: [] })).toThrow(ValidationError)
    expect(parseConversationFeedbackRequest({
      ...valid,
      turnRecords: valid.turnRecords.map((item, index) => index === 0
        ? { ...item, listeningScaffoldLevel: 3, transcriptRevealed: true }
        : item),
    }).turnRecords[0]?.listeningScaffoldLevel).toBe(3)
    expect(() => parseConversationFeedbackRequest({
      ...valid,
      turnRecords: valid.turnRecords.map((item, index) => index === 0 ? { ...item, listeningScaffoldLevel: 5 } : item),
    })).toThrow(ValidationError)
    expect(() => parseConversationFeedbackRequest({
      ...valid,
      turnRecords: valid.turnRecords.map((item, index) => index === 0 ? { ...item, expressionScaffoldLevel: 5 } : item),
    })).toThrow(ValidationError)
  })

  it('accepts redo listening level 4 and rejects level 5', () => {
    const valid = {
      scenarioType: 'dynamic',
      sessionToken: 'signed-session-token',
      turn: 2,
      partnerPromptJa: 'サイズはいかがなさいますか？',
      firstConfirmedJa: 'トール。',
      secondConfirmedJa: 'トールでお願いします。',
      secondInputMode: 'stt',
      secondListeningScaffoldLevel: 4,
      secondExpressionScaffoldLevel: 2,
    }
    expect(parseRedoFeedbackRequest(valid).secondListeningScaffoldLevel).toBe(4)
    expect(() => parseRedoFeedbackRequest({ ...valid, secondListeningScaffoldLevel: 5 })).toThrow(ValidationError)
  })

  it('strictly parses listening scaffold requests and enforces turn limits', () => {
    const valid = {
      scenarioType: 'dynamic',
      sessionToken: 'signed-session-token',
      turn: 2,
      partnerPromptJa: 'サイズはいかがなさいますか？',
    }
    expect(parseListeningScaffoldRequest(valid)).toEqual(valid)
    expect(() => parseListeningScaffoldRequest({ ...valid, turn: 6 })).toThrow(ValidationError)
    expect(() => parseListeningScaffoldRequest({ ...valid, history: [] })).toThrow(ValidationError)
  })

  it('accepts an optional Chinese hint intention within the user text limit', () => {
    const valid = {
      scenarioType: 'dynamic',
      sessionToken: 'signed-session-token',
      history: [{ role: 'assistant', text: 'お飲み物はアイスコーヒーでよろしいですか？' }],
      lastPartnerText: 'お飲み物はアイスコーヒーでよろしいですか？',
      intentionZh: '我想问换成热茶要不要加钱',
    }
    expect(parseHintRequest(valid)).toEqual(valid)
    expect(() => parseHintRequest({ ...valid, intentionZh: '' })).toThrow(ValidationError)
    expect(() => parseHintRequest({ ...valid, unexpected: true })).toThrow(ValidationError)
    // 跨字段边界：无历史时 lastPartnerText 必须为 null 才通过。
    expect(parseHintRequest({ ...valid, history: [], lastPartnerText: null })).toEqual({ ...valid, history: [], lastPartnerText: null })
    // 跨字段边界：lastPartnerText 与历史最后一条 assistant 文本不一致时必须抛错。
    expect(() => parseHintRequest({ ...valid, lastPartnerText: 'サイズはいかがなさいますか？' })).toThrow(ValidationError)
  })

  it('accepts only model key phrases copied from the current partner prompt', () => {
    const partnerPromptJa = 'サイズはいかがなさいますか？'
    const valid = {
      keyInformationHintZh: '对方正在询问你想要的尺寸。',
      keyPhrasesJa: ['サイズ', 'いかがなさいますか'],
      intentSummaryZh: '请说明你想选择的尺寸。',
    }
    expect(parseListeningScaffoldModelOutput(valid, partnerPromptJa)).toEqual(valid)
    expect(() => parseListeningScaffoldModelOutput({
      ...valid,
      keyPhrasesJa: ['お飲み物'],
    }, partnerPromptJa)).toThrow(ValidationError)
  })
})

describe('validateAssistantReply', () => {
  it('accepts one question before the final turn', () => {
    expect(validateAssistantReply('サイズはいかがなさいますか？', 4)).toBe('サイズはいかがなさいますか？')
  })

  it('rejects multiple questions, markdown, and any final-turn question', () => {
    expect(() => validateAssistantReply('どこですか？誰とですか？', 2)).toThrow(ValidationError)
    expect(() => validateAssistantReply('# 返答', 2)).toThrow(ValidationError)
    expect(() => validateAssistantReply('この内容でよろしいですか？', 5)).toThrow(ValidationError)
  })
})
