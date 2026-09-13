/**
 * [INPUT]: 实时续说辅助控制器、真实回合上下文与录音阶段信号
 * [OUTPUT]: 锁定 user-opening 首轮无相手发话时仍发起辅助请求，且以 null 表达相手発話的缺失
 * [POS]: tests/client 的实时语音辅助触发契约回归，守护第 1 轮清理能力不被静默移除
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
// @vitest-environment jsdom
import { createElement, useEffect, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requestSpeechAssist: vi.fn() }))
vi.mock('../../src/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../src/lib/api')>('../../src/lib/api')
  return { ...actual, ApiError: actual.ApiError, requestSpeechAssist: mocks.requestSpeechAssist }
})

import { useSpeechAssistController } from '../../src/lib/use-speech-assist-controller'
import type { RoundRecord, SessionScenario } from '../../src/types'

const scenario: SessionScenario = {
  id: 'lost-item', version: 1, variantId: 'default', maxTurns: 5, scenarioType: 'dynamic',
  sessionToken: 'session-token', scenarioToken: 'scenario-token',
  reveal: { titleZh: '图书馆报失', summaryZh: '向前台询问遗失物。' },
  dynamicData: {
    id: 'lost-item', version: 1, titleZh: '图书馆报失', summaryZh: '向前台询问遗失物。',
    aiRole: '前台工作人员', userRole: '读者', relationship: '初次接待', tone: '丁寧体',
    opening: { speaker: 'user', planZh: '用户先说明来意。' }, userGoal: '说明遗失物并请求查询。',
    coreGoal: { id: 'report', titleZh: '报告遗失', descriptionZh: '说明特征并获知结果。' },
    communicationFunction: '在前台报告遗失物。', initialFacts: ['用户正在前台'], partnerPrivateFacts: [],
    keyIntents: ['说明遗失物'], keyInformation: ['遗失物特征'],
    completionRules: { completed: ['说明特征'], partial: ['部分说明'], notCompleted: ['未说明'] },
    closingRules: ['第5轮不提问'], maxTurns: 5, worldAnchors: ['前台可查询'], followUpPrinciples: ['每次一个信息'],
    hintStrategy: '说明特征', feedbackFocus: ['说明清楚'], safetyBoundary: '不索取个人信息',
  },
}

function userOpeningFirstRound(): RoundRecord {
  return {
    turn: 1, partnerPromptJa: null, inputMode: 'stt', userOriginal: '', userCleaned: '', userFinal: '',
    expressionScaffoldLevel: 0, listeningScaffoldLevel: 0, transcriptRevealed: false, transcriptModified: false,
    transcriptModificationCount: 0, rerecordCount: 0, ttsReplayCount: 0, sttSessionCount: 0, sttAudioMilliseconds: 0,
    llmRequestCount: 0, ttsRequestCount: 0, ttsCharacterCount: 0, failureCount: 0, retryCount: 0, nextAiReply: null,
    llmModel: null, llmMock: false, usage: { inputTokens: null, outputTokens: null, totalTokens: null },
    timing: {
      firstSpeechAt: null, recordingStartedAt: null, recordingStoppedAt: null, transcriptFinalizedAt: null,
      transcriptConfirmedAt: null, llmStartedAt: null, llmFirstTextAt: null, llmCompletedAt: null,
      ttsStartedAt: null, ttsFirstAudioAt: null, audioStartedAt: null, audioCompletedAt: null,
    },
    speechAssistEvents: [],
  }
}

function Probe({ round }: { round: RoundRecord }): ReactNode {
  const controller = useSpeechAssistController({
    phase: 'recording', scenario, turn: round.turn,
    confirmedTranscript: 'すみません、忘れ物を', interimTranscript: 'したかもしれなくて', partialTranscript: '',
    recordingUiStartedAt: Date.now() - 5_000, transcriptVersion: 1,
    lastSpeechSoundAt: Date.now() - 1_500, lastPartialAt: Date.now() - 800, currentRound: round,
    isRecording: () => true, touchRound: () => undefined,
  })
  useEffect(() => () => controller.actions.abort('stopped'))
  return null
}

describe('speech assist trigger with a real partner turn context', () => {
  let root: Root | null = null
  let container: HTMLDivElement | null = null

  afterEach(() => {
    if (root) flushSync(() => root?.unmount())
    container?.remove(); root = null; container = null
    vi.clearAllMocks()
  })

  it('requests assist on a user-opening first turn and reports the absent partner utterance as null', async () => {
    mocks.requestSpeechAssist.mockReset().mockResolvedValue({ cleanedObservedTextJa: 'すみません、忘れ物をしたかもしれなくて', continuationSuggestionJa: null })
    container = document.createElement('div'); document.body.appendChild(container)
    root = createRoot(container); flushSync(() => root.render(createElement(Probe, { round: userOpeningFirstRound() })))
    await vi.waitFor(() => expect(mocks.requestSpeechAssist).toHaveBeenCalledOnce(), { interval: 0 })
    expect(mocks.requestSpeechAssist.mock.calls[0][0]).toMatchObject({ lastAssistantTextJa: null, turn: 1, sessionToken: 'session-token' })
  })

  it('still sends the real partner utterance when the round has one', async () => {
    mocks.requestSpeechAssist.mockReset().mockResolvedValue({ cleanedObservedTextJa: 'すみません、忘れ物をしたかもしれなくて', continuationSuggestionJa: 'と思います' })
    const round = { ...userOpeningFirstRound(), turn: 2, partnerPromptJa: 'どのような落とし物でしょうか？' }
    container = document.createElement('div'); document.body.appendChild(container)
    root = createRoot(container); flushSync(() => root.render(createElement(Probe, { round })))
    await vi.waitFor(() => expect(mocks.requestSpeechAssist).toHaveBeenCalledOnce(), { interval: 0 })
    expect(mocks.requestSpeechAssist.mock.calls[0][0]).toMatchObject({ lastAssistantTextJa: 'どのような落とし物でしょうか？', turn: 2 })
  })
})
