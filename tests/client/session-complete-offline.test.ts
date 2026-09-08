/**
 * [INPUT]: 真实 SessionComplete 挂载、离线状态切换与 mock 的 token/STT 外部动作
 * [OUTPUT]: 锁定重做 token/STT 离线回收、转写保全、文字确认回退、迟到结果隔离与恢复重试契约
 * [POS]: tests/client/ 完成页重做媒体生命周期组件回归测试
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildSessionReport, createRoundRecord } from '../../src/lib/metrics'
import type { ConversationFeedbackResponse, PrototypeConfig, SessionScenario } from '../../src/types'

const mocks = vi.hoisted(() => ({
  token: vi.fn(),
  starts: [] as Array<ReturnType<typeof vi.fn>>,
  sessions: [] as Array<{ close: ReturnType<typeof vi.fn>; emit: (text: string) => void; stop: ReturnType<typeof vi.fn> }>,
}))

vi.mock('../../src/lib/api', async () => ({
  ...(await vi.importActual<typeof import('../../src/lib/api')>('../../src/lib/api')),
  requestElevenLabsToken: mocks.token,
}))
vi.mock('../../src/lib/stt', () => ({
  RealtimeSttSession: class {
    readonly close = vi.fn()
    readonly stop = vi.fn()
    private partial: ((text: string) => void) | undefined
    constructor() {
      mocks.sessions.push({ close: this.close, stop: this.stop, emit: (text) => this.partial?.(text) })
    }
    async start(_token: string, _model: string, handlers: { onPartial: (text: string) => void }): Promise<void> {
      this.partial = handlers.onPartial
      mocks.starts.push(vi.fn())
    }
  },
}))

import { SessionComplete } from '../../src/components/SessionComplete'

const scenario: SessionScenario = {
  id: 'haircut', version: 1, variantId: 'default', firstLine: 'いらっしゃいませ。', maxTurns: 5,
  reveal: { titleZh: '理发店', summaryZh: '说明要求。' }, scenarioType: 'dynamic', sessionToken: 'session-token', scenarioToken: 'scenario-token',
  dynamicData: {
    id: 'haircut', version: 1, titleZh: '理发店', summaryZh: '说明要求。', aiRole: '理发师', userRole: '顾客', relationship: '顾客与店员', tone: '礼貌', firstLine: 'いらっしゃいませ。', userGoal: '说明要求。',
    coreGoal: { id: 'goal', titleZh: '说明要求', descriptionZh: '清楚说明。' }, communicationFunction: '提出要求', initialFacts: [], partnerPrivateFacts: [], keyIntents: [], keyInformation: [], completionRules: { completed: [], partial: [], notCompleted: [] }, closingRules: [], maxTurns: 5, partnerOpeningPlan: '询问要求', worldAnchors: [], followUpPrinciples: [], hintStrategy: 'direct', feedbackFocus: [], safetyBoundary: 'none',
  },
}
const feedbackData: ConversationFeedbackResponse = {
  outcome: 'partial', outcomeEvidenceZh: '部分完成。', listeningFinding: null, expressionImprovement: null,
  redoTask: { turn: 1, partnerPromptJa: scenario.firstLine, firstConfirmedJa: '短くしてください。', directionZh: '保留要求。' },
}
const config: PrototypeConfig = { mode: 'real', limits: { maxTurns: 5 }, elevenlabs: { sttAvailable: true, ttsAvailable: false, voiceId: null, sttModel: 'scribe', ttsModel: 'tts' }, openai: { available: false, model: 'mock', mockAllowed: true } }
const report = buildSessionReport('session-id', 'real', scenario, 1, 2, [createRoundRecord(1, scenario.firstLine, 0)])
const flush = async (): Promise<void> => { await Promise.resolve(); await new Promise<void>((resolve) => queueMicrotask(resolve)) }

function props(online: boolean) {
  return {
    messages: [{ id: 'assistant-1', turn: 1, role: 'assistant' as const, text: scenario.firstLine }], rounds: [], report, sessionId: 'session-id', scenario, reveal: scenario.reveal, config, online, feedbackData, feedbackStatus: 'success' as const, feedbackErrorMsg: '',
    onRetryFeedback: vi.fn(), copyStatus: '', onCopy: vi.fn(), onDownload: vi.fn(), onReplayAi: vi.fn(), onStopAudio: vi.fn(), onRequestRedo: vi.fn(), onRequestListeningScaffold: vi.fn(), onCacheListeningScaffold: vi.fn(), onNewScenario: vi.fn(), audioNotice: '', practiceComparison: null, historyNotice: '',
  }
}

describe('SessionComplete offline redo lifecycle', () => {
  let root: Root
  let container: HTMLDivElement
  beforeEach(() => {
    mocks.token.mockReset()
    mocks.starts.length = 0
    mocks.sessions.length = 0
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    flushSync(() => root.render(createElement(SessionComplete, props(true))))
  })
  afterEach(() => { root.unmount(); container.remove() })

  it('aborts pending token, suppresses late start, and retries after reconnecting', async () => {
    let resolveToken!: (token: string) => void
    mocks.token.mockImplementation((_type: string, signal: AbortSignal) => new Promise<string>((resolve) => { signal.addEventListener('abort', () => undefined); resolveToken = resolve }))
    flushSync(() => Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('再练这个回合'))?.click())
    flushSync(() => Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('开始回答'))?.click())
    await flush()
    const signal = mocks.token.mock.calls[0]?.[1] as AbortSignal
    flushSync(() => root.render(createElement(SessionComplete, props(false))))
    await vi.waitFor(() => {
      expect(signal.aborted).toBe(true)
      expect(container.querySelector<HTMLTextAreaElement>('#redo-confirmed')).not.toBeNull()
      expect(container.textContent).toContain('网络已断开，已切换为文字输入。')
    }, { interval: 0 })
    expect(container.querySelector<HTMLTextAreaElement>('#redo-confirmed')?.value).toBe('')
    resolveToken('late-token')
    await flush()
    expect(mocks.sessions).toHaveLength(0)

    flushSync(() => root.render(createElement(SessionComplete, props(true))))
    flushSync(() => container.querySelector<HTMLButtonElement>('#redo-confirmed')?.parentElement?.querySelector('button')?.click())
    await flush()
    expect(mocks.token).toHaveBeenCalledTimes(2)
  })

  it('closes active recording, preserves partial text, and suppresses late stop/partials', async () => {
    let resolveToken!: (token: string) => void
    mocks.token.mockImplementation(() => new Promise<string>((resolve) => { resolveToken = resolve }))
    flushSync(() => Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('再练这个回合'))?.click())
    flushSync(() => Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('开始回答'))?.click())
    resolveToken('active-token')
    await flush()
    const session = mocks.sessions[0]
    session.emit('保留这段')
    await flush()
    let resolveStop!: (text: string) => void
    session.stop.mockReturnValue(new Promise<string>((resolve) => { resolveStop = resolve }))
    flushSync(() => Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('说完了，确认转写'))?.click())
    await flush()
    flushSync(() => root.render(createElement(SessionComplete, props(false))))
    await vi.waitFor(() => {
      expect(session.close).toHaveBeenCalled()
      expect(container.querySelector<HTMLTextAreaElement>('#redo-confirmed')).not.toBeNull()
      expect(container.textContent).toContain('网络已断开，已切换为文字输入。')
    }, { interval: 0 })
    expect(container.querySelector<HTMLTextAreaElement>('#redo-confirmed')?.value).toBe('保留这段')
    session.emit('迟到覆盖')
    resolveStop('迟到停止结果')
    await flush()
    expect(container.querySelector<HTMLTextAreaElement>('#redo-confirmed')?.value).toBe('保留这段')
  })
})
