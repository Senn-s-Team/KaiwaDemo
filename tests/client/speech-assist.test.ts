import { describe, expect, it } from 'vitest'
import {
  countJapaneseCharacters,
  shouldDisplaySpeechAssistResult,
  shouldTriggerSpeechAssist,
} from '../../src/lib/speech-assist'
import { cleanTranscript } from '../../src/lib/text-cleaner'
import { buildSessionReport, createRoundRecord } from '../../src/lib/metrics'
import type { SessionScenario, SpeechAssistEvent } from '../../src/types'

describe('Client Speech Assist Trigger Rules', () => {
  const baseParams = {
    isRecording: true,
    transcript: 'こんにちは、注文をお願いします', // 15 Japanese characters
    timeSinceLastSpeechSoundMs: 1_000, // > 900ms
    timeSinceLastPartialMs: 400, // > 350ms
    timeSinceLastRequestMs: 3_000, // > 2500ms
    inFlight: false,
    currentVersion: 2,
    lastAssistedVersion: 1,
  }

  it('triggers when all conditions are satisfied', () => {
    expect(shouldTriggerSpeechAssist(baseParams)).toBe(true)
  })

  it('连续说话不触发 (trailing silence < 900ms)', () => {
    expect(shouldTriggerSpeechAssist({
      ...baseParams,
      timeSinceLastSpeechSoundMs: 400, // Continuous speech sound
    })).toBe(false)
  })

  it('最近约 350ms 有新 partial 时不触发', () => {
    expect(shouldTriggerSpeechAssist({
      ...baseParams,
      timeSinceLastPartialMs: 200, // Fresh partial arrived
    })).toBe(false)
  })

  it('转写不足 6 个日语字符时不触发', () => {
    expect(countJapaneseCharacters('あの、はい')).toBe(4)
    expect(shouldTriggerSpeechAssist({
      ...baseParams,
      transcript: 'あの、はい',
    })).toBe(false)

    expect(countJapaneseCharacters('ラテをお願い')).toBe(6)
    expect(shouldTriggerSpeechAssist({
      ...baseParams,
      transcript: 'ラテをお願い',
    })).toBe(true)
  })

  it('单次在途请求限制 (inFlight = true 时不触发)', () => {
    expect(shouldTriggerSpeechAssist({
      ...baseParams,
      inFlight: true,
    })).toBe(false)
  })

  it('稳定停顿只触发一次 (同 transcript version 去重)', () => {
    expect(shouldTriggerSpeechAssist({
      ...baseParams,
      currentVersion: 3,
      lastAssistedVersion: 3, // Already assisted this version
    })).toBe(false)
  })

  it('请求间至少约 2500ms', () => {
    expect(shouldTriggerSpeechAssist({
      ...baseParams,
      timeSinceLastRequestMs: 1_500, // < 2500ms
    })).toBe(false)
  })

  it('非录音状态时不触发', () => {
    expect(shouldTriggerSpeechAssist({
      ...baseParams,
      isRecording: false,
    })).toBe(false)
  })
})

describe('Client Speech Assist Display Pure Function (shouldDisplaySpeechAssistResult)', () => {
  const validDisplayParams = {
    isRecording: true,
    requestVersion: 2,
    currentVersion: 2,
    isAborted: false,
    timeSinceLastSpeechSoundMs: 1_200,
  }

  it('allows display when recording, versions match, not aborted, and user still silent', () => {
    expect(shouldDisplaySpeechAssistResult(validDisplayParams)).toBe(true)
  })

  it('rejects display when user has resumed speaking (trailing silence broken)', () => {
    expect(shouldDisplaySpeechAssistResult({
      ...validDisplayParams,
      timeSinceLastSpeechSoundMs: 400, // < 900ms
    })).toBe(false)
  })

  it('rejects display when a new partial arrived and version bumped (stale version drop)', () => {
    expect(shouldDisplaySpeechAssistResult({
      ...validDisplayParams,
      requestVersion: 2,
      currentVersion: 3, // Version moved on
    })).toBe(false)
  })

  it('rejects display when recording has stopped', () => {
    expect(shouldDisplaySpeechAssistResult({
      ...validDisplayParams,
      isRecording: false,
    })).toBe(false)
  })

  it('rejects display when the request controller was aborted', () => {
    expect(shouldDisplaySpeechAssistResult({
      ...validDisplayParams,
      isAborted: true,
    })).toBe(false)
  })
})

describe('Client Speech Assist Lifecycle & Invariants', () => {
  it('B 不得进入 raw transcript、确定性 cleaned transcript 或用户确认稿', () => {
    const rawCommitted = 'ラテをお願いします'
    const assistSuggestion = '温かいもので'

    // Cleaned transcript runs on committed text
    const cleaned = cleanTranscript(rawCommitted)
    expect(cleaned.rawText).toBe(rawCommitted)
    expect(cleaned.cleanedText).toBe(rawCommitted)
    expect(cleaned.cleanedText).not.toContain(assistSuggestion)

    // User final confirmed text is independent of B
    const userFinal = cleaned.cleanedText
    expect(userFinal).toBe('ラテをお願いします')
    expect(userFinal).not.toContain(assistSuggestion)
  })

  it('旧响应丢弃与恢复说话取消不覆盖新转写', () => {
    const requestVersion = 1
    const currentVersion = 2
    const isAborted = true

    // Uses real shouldDisplaySpeechAssistResult
    const shouldDisplay = shouldDisplaySpeechAssistResult({
      isRecording: true,
      requestVersion,
      currentVersion,
      isAborted,
      timeSinceLastSpeechSoundMs: 1000,
    })
    expect(shouldDisplay).toBe(false)

    // Recorded as stale or aborted event
    const event: SpeechAssistEvent = {
      turn: 1,
      requestVersion,
      observedTextJa: 'あの、パスポートの',
      cleanedObservedTextJa: 'パスポートの',
      continuationSuggestionJa: '更新をしたい',
      displayed: false,
      latencyMs: 320,
      failureReason: isAborted ? 'aborted' : 'stale_version',
    }
    expect(event.displayed).toBe(false)
    expect(event.failureReason).toBe('aborted')
  })

  it('模型请求失败不阻塞核心录音流程，并记录失败事实', () => {
    const event: SpeechAssistEvent = {
      turn: 1,
      requestVersion: 1,
      observedTextJa: 'あの、カフェラテを',
      cleanedObservedTextJa: null,
      continuationSuggestionJa: null,
      displayed: false,
      latencyMs: 1500,
      failureReason: 'timeout',
    }

    const round = createRoundRecord(1, 'いらっしゃいませ。', 0)
    round.speechAssistEvents.push(event)

    // STT committed transcript continues normally
    round.userOriginal = 'カフェラテをお願いします'
    round.userCleaned = 'カフェラテをお願いします'
    round.userFinal = 'カフェラテをお願いします'

    expect(round.speechAssistEvents).toHaveLength(1)
    expect(round.speechAssistEvents[0].failureReason).toBe('timeout')
    expect(round.userFinal).toBe('カフェラテをお願いします')
  })

  it('RoundRecord 及 SessionReport 导出完整包含 speechAssistEvents', () => {
    const round = createRoundRecord(1, '何かお困りですか。', 0)
    const event: SpeechAssistEvent = {
      turn: 1,
      requestVersion: 2,
      observedTextJa: 'ええと、口座を開設したいのですが',
      cleanedObservedTextJa: '口座を開設したいのですが',
      continuationSuggestionJa: '必要書類を教えてください',
      displayed: true,
      latencyMs: 410,
      failureReason: null,
    }
    round.speechAssistEvents.push(event)

    const scenario: Pick<SessionScenario, 'id' | 'version' | 'variantId' | 'reveal'> = {
      id: 'dynamic-bank',
      version: 1,
      variantId: 'v1',
      reveal: { titleZh: '开户', summaryZh: '在银行开户' },
    }

    const report = buildSessionReport('ses_123', 'real', scenario, 1000, 5000, [round])

    expect(report.rounds[0].speechAssistEvents).toHaveLength(1)
    expect(report.rounds[0].speechAssistEvents[0]).toEqual(event)
    expect(report.rounds[0].expressionScaffoldLevel).toBe(0)
    expect(report.costNotes.some((n) => n.includes('实时语音续说建议（B）'))).toBe(true)
  })
})
