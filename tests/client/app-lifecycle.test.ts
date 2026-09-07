/**
 * [INPUT]: 真实浏览器可见 App DOM、会话快照与 visibilitychange 生命周期事件
 * [OUTPUT]: 锁定 confirming_transcript 草稿、发送控件及前后台切换不误入错误 UI 的集成回归契约
 * [POS]: tests/client/ App 根组件生命周期集成测试
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
// @vitest-environment jsdom
import { type ComponentType, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoundRecord } from '../../src/lib/metrics'
import type { SessionScenario } from '../../src/types'

let App: ComponentType
let fetchConfig: ReturnType<typeof vi.fn>
let listPracticeAttempts: ReturnType<typeof vi.fn>

const scenario: SessionScenario = {
  id: 'haircut',
  version: 1,
  variantId: 'default',
  firstLine: 'いらっしゃいませ。今日はどうされましたか。',
  maxTurns: 5,
  reveal: { titleZh: '理发店', summaryZh: '说明你的理发要求。' },
  scenarioType: 'dynamic',
  sessionToken: 'session-token',
  scenarioToken: 'scenario-token',
  dynamicData: {
    id: 'haircut', version: 1, titleZh: '理发店', summaryZh: '说明你的理发要求。', aiRole: '理发师', userRole: '顾客', relationship: '顾客与店员', tone: '礼貌',
    firstLine: 'いらっしゃいませ。今日はどうされましたか。', userGoal: '我想剪短一点，但不要露出额头。',
    coreGoal: { id: 'goal', titleZh: '说明要求', descriptionZh: '清楚说明理发要求。' }, communicationFunction: '提出要求',
    initialFacts: [], partnerPrivateFacts: [], keyIntents: [], keyInformation: [], completionRules: { completed: [], partial: [], notCompleted: [] }, closingRules: [], maxTurns: 5,
    partnerOpeningPlan: '询问要求', worldAnchors: [], followUpPrinciples: [], hintStrategy: 'direct', feedbackFocus: [], safetyBoundary: 'none',
  },
}

function installSessionSnapshot(): void {
  window.sessionStorage.setItem('kaiwa.current-session.v1', JSON.stringify({
    version: 1, phase: 'confirming_transcript', sessionId: 'session-id', scenario,
    messages: [{ id: 'assistant-1', turn: 1, role: 'assistant', text: scenario.firstLine }], rounds: [],
    currentRound: createRoundRecord(1, scenario.firstLine, 0), turn: 1, sessionStartedAt: 1,
    transcript: { rawText: '前髪は残して、少し短くしてください。', cleanedText: '前髪は残して、少し短くしてください。', finalText: '前髪は残して、少し短くしてください。' },
  }))
}

const flush = async (): Promise<void> => {
  await Promise.resolve()
  await new Promise<void>((resolve) => queueMicrotask(resolve))
}
function readFailureCount(snapshot: unknown): number {
  if (typeof snapshot !== 'object' || snapshot === null || !('currentRound' in snapshot)) throw new Error('Missing currentRound in session snapshot')
  const currentRound: unknown = snapshot.currentRound
  if (typeof currentRound !== 'object' || currentRound === null || !('failureCount' in currentRound) || typeof currentRound.failureCount !== 'number') throw new Error('Missing numeric failureCount in currentRound')
  return currentRound.failureCount
}

describe('App lifecycle integration', () => {
  let root: Root
  let container: HTMLDivElement
  let hidden: PropertyDescriptor | undefined
  let visibility: PropertyDescriptor | undefined
  let scrollIntoView: PropertyDescriptor | undefined

  beforeEach(async () => {
    scrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
    fetchConfig = vi.fn().mockResolvedValue({
      mode: 'mock', limits: { maxTurns: 5 },
      elevenlabs: { sttAvailable: false, ttsAvailable: false, voiceId: null, sttModel: 'scribe', ttsModel: 'tts' },
      openai: { available: false, model: 'mock', mockAllowed: true },
    })
    listPracticeAttempts = vi.fn().mockResolvedValue([])
    vi.doMock('../../src/lib/api', async () => ({
      ...(await vi.importActual<typeof import('../../src/lib/api')>('../../src/lib/api')),
      fetchConfig,
    }))
    vi.doMock('../../src/lib/practice-history', async () => ({
      ...(await vi.importActual<typeof import('../../src/lib/practice-history')>('../../src/lib/practice-history')),
      listPracticeAttempts,
    }))
    hidden = Object.getOwnPropertyDescriptor(document, 'hidden')
    visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState')
    installSessionSnapshot()
    expect(window.sessionStorage.getItem('kaiwa.current-session.v1')).not.toBeNull()
    container = document.createElement('div')
    const appModule = await import('../../src/App')
    App = appModule.default
    document.body.appendChild(container)
    root = createRoot(container)
    flushSync(() => root.render(createElement(App)))
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    await flush()
    await flush()
    expect(fetchConfig).toHaveBeenCalled()
    expect(container.querySelector<HTMLTextAreaElement>('#transcript-sheet-input')).not.toBeNull()
  })

  afterEach(() => {
    root.unmount()
    container.remove()
    window.sessionStorage.clear()
    if (scrollIntoView) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollIntoView)
    else delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView
    if (hidden) Object.defineProperty(document, 'hidden', hidden)
    else delete (document as { hidden?: boolean }).hidden
    if (visibility) Object.defineProperty(document, 'visibilityState', visibility)
    else delete (document as { visibilityState?: DocumentVisibilityState }).visibilityState
    vi.doUnmock('../../src/lib/api')
    vi.doUnmock('../../src/lib/practice-history')
    vi.clearAllMocks()
  })

  it('keeps the restored draft and send action when hidden then visible', async () => {
    expect(container.querySelector<HTMLTextAreaElement>('#transcript-sheet-input')?.value).toBe('前髪は残して、少し短くしてください。')

    flushSync(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true })
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await flush()

    expect(container.textContent).not.toContain('连接已在后台停止')
    expect(container.querySelector<HTMLTextAreaElement>('#transcript-sheet-input')?.value).toBe('前髪は残して、少し短くしてください。')
    const sendButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('确认发送'))
    expect(sendButton).toBeDefined()
    expect((sendButton as HTMLButtonElement).disabled).toBe(false)

    flushSync(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: false })
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await flush()
    expect(container.textContent).not.toContain('连接已在后台停止')
    expect(container.querySelector<HTMLTextAreaElement>('#transcript-sheet-input')?.value).toBe('前髪は残して、少し短くしてください。')
    const visibleSendButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('确认发送'))
    expect(visibleSendButton).toBeDefined()
    expect((visibleSendButton as HTMLButtonElement).disabled).toBe(false)
    const restored: unknown = JSON.parse(window.sessionStorage.getItem('kaiwa.current-session.v1') ?? 'null')
    expect(readFailureCount(restored)).toBe(0)
  })
})
