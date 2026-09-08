/**
 * [INPUT]: 真实浏览器可见 App DOM、会话快照与 visibilitychange 生命周期事件
 * [OUTPUT]: 锁定会话草稿、录音前相手播放器释放顺序、反馈任务 transport/terminal 重试分流、重做录音及 hint/listening/redo 异步结果只写回其所属 App 会话的集成回归契约
 * [POS]: tests/client/ App 根组件生命周期集成测试
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
// @vitest-environment jsdom
import { type ComponentType, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildSessionReport, createRoundRecord } from '../../src/lib/metrics'
import { writePreparedRestart, type PreparedRestartData } from '../../src/lib/home-practice-recovery'
import type { ConversationFeedbackResponse, SessionScenario } from '../../src/types'
import type { StoredPracticeAttempt } from '../../src/lib/practice-history'

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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

function installWaitingSessionSnapshot(listeningScaffoldLevel = 0): void {
  const round = createRoundRecord(1, scenario.firstLine, 0)
  round.listeningScaffoldLevel = listeningScaffoldLevel
  round.timing.audioStartedAt = 1
  round.timing.audioCompletedAt = 2
  window.sessionStorage.setItem('kaiwa.current-session.v1', JSON.stringify({
    version: 1, phase: 'waiting_user', sessionId: 'guard-session', scenario,
    messages: [{ id: 'assistant-1', turn: 1, role: 'assistant', text: scenario.firstLine }], rounds: [],
    currentRound: round, turn: 1, sessionStartedAt: 1,
    transcript: { rawText: '', cleanedText: '', finalText: '' },
  }))
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
    const feedbackResult = {
      outcome: 'partial', outcomeEvidenceZh: '已完成一项沟通目标。', listeningFinding: null, expressionImprovement: null,
      redoTask: { turn: 1, partnerPromptJa: scenario.firstLine, firstConfirmedJa: '前髪は残してください。', directionZh: '保留请求并补充细节。' },
    }
    vi.doMock('../../src/lib/api', async () => ({
      ...(await vi.importActual<typeof import('../../src/lib/api')>('../../src/lib/api')),
      fetchConfig,
      submitFeedbackTask: vi.fn().mockResolvedValue({ taskToken: 'feedback-token', expiresAt: Date.now() + 86_400_000 }),
      getFeedbackTask: vi.fn().mockResolvedValue({ status: 'complete', kind: 'conversation', result: feedbackResult }),
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
    expect(container.querySelector('.im-notice-banner.info')).toBeNull()
    expect(container.textContent).not.toContain('未查看帮助')
    expect(container.textContent).not.toContain('已查看关键信息')
    expect(container.querySelector('.im-listening-controls button')).not.toBeNull()
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
    expect(container.querySelector('.im-notice-banner.info')).toBeNull()
    const visibleSendButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('确认发送'))
    expect(visibleSendButton).toBeDefined()
    expect((visibleSendButton as HTMLButtonElement).disabled).toBe(false)
    const restored: unknown = JSON.parse(window.sessionStorage.getItem('kaiwa.current-session.v1') ?? 'null')
    expect(readFailureCount(restored)).toBe(0)
  })
})

describe('App config lifecycle regression', () => {
  it('将选中练习的建议带到复练，并在查看后以 L4 开始且不污染重录次数', async () => {
    vi.resetModules()
    window.sessionStorage.clear()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
    const attempt: StoredPracticeAttempt = {
      scenario: scenario.dynamicData, practiceToken: 'practice-token', scenarioKey: 'haircut-key',
      report: buildSessionReport('source-session', 'mock', scenario, 123, 456, [createRoundRecord(1, scenario.firstLine, 0)]),
      feedback: { outcome: 'partial', outcomeEvidenceZh: '', listeningFinding: null, expressionImprovement: { turn: 1, userConfirmedJa: 'これをください。', suggestedJa: 'こちらをお願いします。', reasonZh: '更礼貌。' }, redoTask: { turn: 1, partnerPromptJa: scenario.firstLine, firstConfirmedJa: 'これをください。', directionZh: '' } },
    }
    vi.doMock('../../src/lib/api', async () => ({ ...(await vi.importActual<typeof import('../../src/lib/api')>('../../src/lib/api')), fetchConfig: vi.fn().mockResolvedValue({ mode: 'mock', limits: { maxTurns: 5 }, elevenlabs: { sttAvailable: false, ttsAvailable: false, voiceId: null, sttModel: 'scribe', ttsModel: 'tts' }, openai: { available: false, model: 'mock', mockAllowed: true } }), restartPractice: vi.fn().mockResolvedValue({ scenario: scenario.dynamicData, scenarioToken: 'repeat-token', practiceToken: 'practice-token' }), startScenarioSession: vi.fn().mockResolvedValue({ ...scenario, scenarioToken: 'repeat-token' }) }))
    vi.doMock('../../src/lib/practice-history', async () => ({ ...(await vi.importActual<typeof import('../../src/lib/practice-history')>('../../src/lib/practice-history')), listPracticeAttempts: vi.fn().mockResolvedValue([attempt]) }))
    const box = document.createElement('div'); document.body.appendChild(box)
    const appModule = await import('../../src/App'); const appRoot = createRoot(box); flushSync(() => appRoot.render(createElement(appModule.default)))
    const history = await vi.waitFor(() => { const button = box.querySelector<HTMLButtonElement>('.practice-history-open'); expect(button).not.toBeNull(); expect(button?.disabled).toBe(false); return button as HTMLButtonElement }, { interval: 0 })
    flushSync(() => history.click())
    const advice = await vi.waitFor(() => { const button = Array.from(box.querySelectorAll('button')).find((item) => item.textContent?.includes('查看上次建议')); expect(button).toBeDefined(); return button as HTMLButtonElement }, { interval: 0 })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    flushSync(() => advice.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await flush()
    expect(box.textContent).toContain('こちらをお願いします。')
    flushSync(() => (Array.from(box.querySelectorAll('button')).find((item) => item.textContent?.includes('开始对话')) as HTMLButtonElement).click())
    await vi.waitFor(() => {
      const saved = JSON.parse(window.sessionStorage.getItem('kaiwa.current-session.v1') ?? '{}') as { currentRound?: { expressionScaffoldLevel?: number; rerecordCount?: number } }
      expect(saved.currentRound?.expressionScaffoldLevel).toBe(4)
      expect(saved.currentRound?.rerecordCount).toBe(0)
    }, { interval: 0 })
    flushSync(() => (Array.from(box.querySelectorAll('button')).find((item) => item.textContent?.includes('提前复盘')) as HTMLButtonElement).click())
    const newScenario = await vi.waitFor(() => { const button = Array.from(box.querySelectorAll('button')).find((item) => item.textContent === '开始新场景'); expect(button).toBeDefined(); return button as HTMLButtonElement }, { interval: 0 })
    flushSync(() => newScenario.click())
    expect(box.textContent).not.toContain('上次建议')
    appRoot.unmount(); box.remove(); vi.doUnmock('../../src/lib/api'); vi.doUnmock('../../src/lib/practice-history')
  })
  it('restores a prepared same-scenario restart and clears it when starting', async () => {
    vi.resetModules()
    window.sessionStorage.clear()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
    const previousAdvice = { expressionImprovement: { turn: 1, userConfirmedJa: 'これをください。', suggestedJa: 'こちらをお願いします。', reasonZh: '更礼貌。' }, sourceSessionId: 'source-session', sourceStartedAt: 123, viewed: false }
    const prepared: PreparedRestartData = { scenario: scenario.dynamicData, scenarioToken: 'prepared-token', practiceToken: 'practice-token', previousAdvice }
    writePreparedRestart(prepared)
    const fetchConfigMock = vi.fn().mockResolvedValue({ mode: 'mock', limits: { maxTurns: 5 }, elevenlabs: { sttAvailable: false, ttsAvailable: false, voiceId: null, sttModel: 'scribe', ttsModel: 'tts' }, openai: { available: false, model: 'mock', mockAllowed: true } })
    const startScenarioSessionMock = vi.fn().mockResolvedValue({ ...scenario, scenarioToken: 'prepared-token' })
    vi.doMock('../../src/lib/api', async () => ({ ...(await vi.importActual<typeof import('../../src/lib/api')>('../../src/lib/api')), fetchConfig: fetchConfigMock, startScenarioSession: startScenarioSessionMock }))
    vi.doMock('../../src/lib/practice-history', async () => ({ ...(await vi.importActual<typeof import('../../src/lib/practice-history')>('../../src/lib/practice-history')), listPracticeAttempts: vi.fn().mockResolvedValue([]) }))
    const box = document.createElement('div'); document.body.appendChild(box)
    const appModule = await import('../../src/App'); const appRoot = createRoot(box); flushSync(() => appRoot.render(createElement(appModule.default)))
    await vi.waitFor(() => { const button = Array.from(box.querySelectorAll('button')).find((item) => item.textContent?.includes('查看上次建议')); expect(button).toBeDefined(); return button as HTMLButtonElement }, { interval: 0 })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    flushSync(() => (Array.from(box.querySelectorAll('button')).find((item) => item.textContent?.includes('查看上次建议')) as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true })))
    await flush()
    expect(box.textContent).toContain('こちらをお願いします。')
    const startButton = Array.from(box.querySelectorAll('button')).find((item) => item.textContent?.includes('开始对话')) as HTMLButtonElement | undefined
    expect(startButton).toBeDefined()
    flushSync(() => startButton?.click())
    expect(window.sessionStorage.getItem('kaiwa.home-practice-restart.v1')).toBeNull()
    await vi.waitFor(() => expect(startScenarioSessionMock).toHaveBeenCalledWith('prepared-token', expect.any(AbortSignal)), { interval: 0 })
    appRoot.unmount(); box.remove(); vi.doUnmock('../../src/lib/api'); vi.doUnmock('../../src/lib/practice-history')
  })


  it('恢复带建议的快照，且兼容旧快照并拒绝无效建议', async () => {
    vi.resetModules(); window.sessionStorage.clear(); Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
    const advice = { expressionImprovement: { turn: 1, userConfirmedJa: 'これ', suggestedJa: 'こちら', reasonZh: '更礼貌。' }, sourceSessionId: 'source', sourceStartedAt: 1, viewed: true }
    const snapshot = { version: 1, phase: 'waiting_user', sessionId: 'restored', scenario: { ...scenario, previousAdvice: advice }, messages: [], rounds: [], currentRound: createRoundRecord(1, scenario.firstLine, 0), turn: 1, sessionStartedAt: 1, transcript: { rawText: '', cleanedText: '', finalText: '' } }
    window.sessionStorage.setItem('kaiwa.current-session.v1', JSON.stringify(snapshot))
    vi.doMock('../../src/lib/api', async () => ({ ...(await vi.importActual<typeof import('../../src/lib/api')>('../../src/lib/api')), fetchConfig: vi.fn().mockResolvedValue({ mode: 'mock', limits: { maxTurns: 5 }, elevenlabs: { sttAvailable: false, ttsAvailable: false, voiceId: null, sttModel: 'scribe', ttsModel: 'tts' }, openai: { available: false, model: 'mock', mockAllowed: true } }) }))
    vi.doMock('../../src/lib/practice-history', async () => ({ ...(await vi.importActual<typeof import('../../src/lib/practice-history')>('../../src/lib/practice-history')), listPracticeAttempts: vi.fn().mockResolvedValue([]) }))
    const box = document.createElement('div'); document.body.appendChild(box); const appModule = await import('../../src/App'); const appRoot = createRoot(box); flushSync(() => appRoot.render(createElement(appModule.default)))
    const button = await vi.waitFor(() => { const item = box.querySelector<HTMLButtonElement>('[aria-label="查看上次建议"]'); expect(item).not.toBeNull(); return item as HTMLButtonElement }, { interval: 0 })
    flushSync(() => button.click()); expect(box.textContent).toContain('こちら')
    appRoot.unmount(); box.remove(); vi.doUnmock('../../src/lib/api'); vi.doUnmock('../../src/lib/practice-history')

    const { readSessionSnapshot } = await import('../../src/lib/session-snapshot')
    window.sessionStorage.setItem('kaiwa.current-session.v1', JSON.stringify({ ...snapshot, scenario: { ...scenario, previousAdvice: { ...advice, expressionImprovement: { ...advice.expressionImprovement, suggestedJa: '' } } } }))
    expect(readSessionSnapshot()).toBeNull()
    window.sessionStorage.setItem('kaiwa.current-session.v1', JSON.stringify({ ...snapshot, scenario }))
    expect(readSessionSnapshot()).not.toBeNull()
  })
  it('关闭提示 sheet 会中止请求，且迟到失败不显示前台提示', async () => {
    vi.resetModules()
    window.sessionStorage.clear()
    installWaitingSessionSnapshot()
    let rejectHint!: (error: Error) => void
    const hintRequest = new Promise<never>((_, reject) => { rejectHint = reject })
    const fetchHint = vi.fn((_scenario: SessionScenario, _aiText: string, _messages: unknown[], _intention: string | undefined, signal: AbortSignal) => {
      signal.addEventListener('abort', () => undefined)
      return hintRequest
    })
    vi.doMock('../../src/lib/api', async () => ({
      ...(await vi.importActual<typeof import('../../src/lib/api')>('../../src/lib/api')),
      fetchConfig: vi.fn().mockResolvedValue({ mode: 'mock', limits: { maxTurns: 5 }, elevenlabs: { sttAvailable: false, ttsAvailable: false, voiceId: null, sttModel: 'scribe', ttsModel: 'tts' }, openai: { available: false, model: 'mock', mockAllowed: true } }),
      fetchHint,
    }))
    vi.doMock('../../src/lib/practice-history', async () => ({ ...(await vi.importActual<typeof import('../../src/lib/practice-history')>('../../src/lib/practice-history')), listPracticeAttempts: vi.fn().mockResolvedValue([]) }))
    const box = document.createElement('div')
    document.body.appendChild(box)
    const appModule = await import('../../src/App')
    const appRoot = createRoot(box)
    try {
      flushSync(() => appRoot.render(createElement(appModule.default)))
      const hintButton = await vi.waitFor(() => {
        const button = box.querySelector<HTMLButtonElement>('[aria-label="怎么说，查看表达帮助"]')
        expect(button).not.toBeNull()
        return button as HTMLButtonElement
      }, { interval: 0 })
      flushSync(() => hintButton.click())
      await vi.waitFor(() => expect(fetchHint).toHaveBeenCalledOnce(), { interval: 0 })
      flushSync(() => box.querySelector<HTMLButtonElement>('.im-sheet-close-btn')?.click())
      expect(fetchHint.mock.calls[0]?.[4]?.aborted).toBe(true)
      rejectHint(new Error('late hint failure'))
      await flush()
      expect(box.textContent).not.toContain('获取提示暂时失败')
    } finally {
      appRoot.unmount()
      box.remove()
      window.sessionStorage.clear()
      vi.doUnmock('../../src/lib/api')
      vi.doUnmock('../../src/lib/practice-history')
      vi.clearAllMocks()
    }
  })
  it('点击开始语音时先释放已完成的相手播放器，再申请麦克风', async () => {
    vi.resetModules()
    window.sessionStorage.clear()
    installWaitingSessionSnapshot()
    const events: string[] = []
    const micGate = deferred<MediaStream>()
    const requestMicrophoneStream = vi.fn(() => {
      events.push('microphone')
      return micGate.promise
    })
    vi.doMock('../../src/lib/api', async () => ({
      ...(await vi.importActual<typeof import('../../src/lib/api')>('../../src/lib/api')),
      fetchConfig: vi.fn().mockResolvedValue({
        mode: 'mock', limits: { maxTurns: 5 },
        elevenlabs: { sttAvailable: true, ttsAvailable: false, voiceId: null, sttModel: 'scribe', ttsModel: 'tts' },
        openai: { available: false, model: 'mock', mockAllowed: true },
      }),
    }))
    vi.doMock('../../src/lib/practice-history', async () => ({
      ...(await vi.importActual<typeof import('../../src/lib/practice-history')>('../../src/lib/practice-history')),
      listPracticeAttempts: vi.fn().mockResolvedValue([]),
    }))
    vi.doMock('../../src/lib/audio-engine', async () => ({
      ...(await vi.importActual<typeof import('../../src/lib/audio-engine')>('../../src/lib/audio-engine')),
      requestMicrophoneStream,
    }))
    const scrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
    const { CachedTtsPlayer } = await import('../../src/lib/tts')
    const stop = vi.spyOn(CachedTtsPlayer.prototype, 'stop').mockImplementation(() => {
      events.push('release-ai')
    })
    const container = document.createElement('div')
    const root = createRoot(container)
    document.body.appendChild(container)
    try {
      const appModule = await import('../../src/App')
      flushSync(() => root.render(createElement(appModule.default)))
      await vi.waitFor(() => expect(container.textContent).toContain('点击开始回答 (语音)'), { interval: 0 })
      stop.mockClear()
      events.length = 0
      const button = Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.includes('点击开始回答'))
      expect(button).toBeDefined()
      ;(button as HTMLButtonElement).click()
      await vi.waitFor(() => expect(requestMicrophoneStream).toHaveBeenCalledOnce(), { interval: 0 })
      expect(events.slice(0, 2)).toEqual(['release-ai', 'microphone'])
    } finally {
      stop.mockRestore()
      root.unmount()
      container.remove()
      window.sessionStorage.clear()
      if (scrollIntoView) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollIntoView)
      else delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView
      vi.doUnmock('../../src/lib/api')
      vi.doUnmock('../../src/lib/practice-history')
      vi.doUnmock('../../src/lib/audio-engine')
      vi.clearAllMocks()
    }
  })

  it('keeps the initial config request and media resources alive across a root rerender', async () => {
    vi.resetModules()
    window.sessionStorage.clear()
    const configRequest = deferred<import('../../src/types').PrototypeConfig>()
    const configAbort = vi.fn()
    const releaseMicrophoneStream = vi.fn()
    const requestConfig = vi.fn((signal?: AbortSignal) => {
      signal?.addEventListener('abort', configAbort)
      return configRequest.promise
    })
    vi.doMock('../../src/lib/api', async () => ({
      ...(await vi.importActual<typeof import('../../src/lib/api')>('../../src/lib/api')),
      fetchConfig: requestConfig,
    }))
    vi.doMock('../../src/lib/practice-history', async () => ({
      ...(await vi.importActual<typeof import('../../src/lib/practice-history')>('../../src/lib/practice-history')),
      listPracticeAttempts: vi.fn().mockReturnValue(new Promise(() => undefined)),
    }))
    vi.doMock('../../src/lib/audio-engine', async () => ({
      ...(await vi.importActual<typeof import('../../src/lib/audio-engine')>('../../src/lib/audio-engine')),
      releaseMicrophoneStream,
    }))
    const container = document.createElement('div')
    const root = createRoot(container)
    document.body.appendChild(container)
    try {
      const appModule = await import('../../src/App')
      flushSync(() => root.render(createElement(appModule.default)))
      await vi.waitFor(() => expect(requestConfig).toHaveBeenCalledOnce(), { interval: 0 })
      configAbort.mockClear()
      releaseMicrophoneStream.mockClear()

      flushSync(() => root.render(createElement(appModule.default)))

      expect(configAbort).not.toHaveBeenCalled()
      expect(releaseMicrophoneStream).not.toHaveBeenCalled()
      configRequest.resolve({
        mode: 'mock', limits: { maxTurns: 5 },
        elevenlabs: { sttAvailable: false, ttsAvailable: false, voiceId: null, sttModel: 'scribe', ttsModel: 'tts' },
        openai: { available: false, model: 'mock', mockAllowed: true },
      })
      await vi.waitFor(() => {
        const input = container.querySelector<HTMLTextAreaElement>('#custom-topic-input')
        expect(input).not.toBeNull()
        expect(input?.disabled).toBe(false)
      }, { interval: 0 })
    } finally {
      root.unmount()
      container.remove()
      window.sessionStorage.clear()
      vi.doUnmock('../../src/lib/api')
      vi.doUnmock('../../src/lib/practice-history')
      vi.doUnmock('../../src/lib/audio-engine')
      vi.clearAllMocks()
    }
  })
})

describe('App async owner guards', () => {
  let root: Root | null = null
  let container: HTMLDivElement | null = null
  let scrollIntoView: PropertyDescriptor | undefined

  beforeEach(() => {
    scrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  })

  afterEach(() => {
    root?.unmount()
    container?.remove()
    root = null
    container = null
    window.sessionStorage.clear()
    if (scrollIntoView) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollIntoView)
    else delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView
    vi.doUnmock('../../src/lib/api')
    vi.doUnmock('../../src/lib/practice-history')
    vi.clearAllMocks()
  })

  it('drops late hint and listening scaffold results after the App unmounts', async () => {
    vi.resetModules()
    const hint = deferred({ directionZh: '旧提示不得显示', keyPhrasesJa: ['古い'], sentenceStarterJa: '古いです', fullExampleJa: '古い結果です。' })
    const scaffold = deferred({ keyInformationHintZh: '旧关键信息不得显示', keyPhrasesJa: ['古い'], intentSummaryZh: '旧结果' })
    vi.doMock('../../src/lib/api', async () => ({
      ...(await vi.importActual<typeof import('../../src/lib/api')>('../../src/lib/api')),
      fetchConfig: vi.fn().mockResolvedValue({ mode: 'mock', limits: { maxTurns: 5 }, elevenlabs: { sttAvailable: false, ttsAvailable: false, voiceId: null, sttModel: 'scribe', ttsModel: 'tts' }, openai: { available: false, model: 'mock', mockAllowed: true } }),
      fetchHint: vi.fn().mockImplementation(() => hint.promise),
      requestListeningScaffold: vi.fn().mockImplementation(() => scaffold.promise),
    }))
    vi.doMock('../../src/lib/practice-history', async () => ({ ...(await vi.importActual<typeof import('../../src/lib/practice-history')>('../../src/lib/practice-history')), listPracticeAttempts: vi.fn().mockResolvedValue([]) }))
    installWaitingSessionSnapshot(1)
    container = document.createElement('div'); document.body.appendChild(container)
    const appModule = await import('../../src/App')
    root = createRoot(container); flushSync(() => root?.render(createElement(appModule.default)))
    const hintButton = await vi.waitFor(() => {
      const button = container?.querySelector<HTMLButtonElement>('[aria-label="怎么说，查看表达帮助"]')
      expect(button).not.toBeNull()
      return button as HTMLButtonElement
    }, { interval: 0 })
    const scaffoldButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('查看关键信息'))
    expect(scaffoldButton).toBeDefined()
    flushSync(() => { hintButton.click(); (scaffoldButton as HTMLButtonElement).click() })
    root.unmount(); root = null
    hint.resolve({ directionZh: '旧提示不得显示', keyPhrasesJa: ['古い'], sentenceStarterJa: '古いです', fullExampleJa: '古い结果です。' })
    scaffold.resolve({ keyInformationHintZh: '旧关键信息不得显示', keyPhrasesJa: ['古い'], intentSummaryZh: '旧结果' })
    await flush(); await flush()
    expect(container.textContent).not.toContain('旧提示不得显示')
    expect(container.textContent).not.toContain('旧关键信息不得显示')
  })

  it('shows a listening scaffold response while its App session remains mounted', async () => {
    vi.resetModules()
    const scaffold = vi.fn().mockResolvedValue({ keyInformationHintZh: '当前会话关键信息', keyPhrasesJa: ['現在'], intentSummaryZh: '当前结果' })
    vi.doMock('../../src/lib/api', async () => ({
      ...(await vi.importActual<typeof import('../../src/lib/api')>('../../src/lib/api')),
      fetchConfig: vi.fn().mockResolvedValue({ mode: 'mock', limits: { maxTurns: 5 }, elevenlabs: { sttAvailable: false, ttsAvailable: false, voiceId: null, sttModel: 'scribe', ttsModel: 'tts' }, openai: { available: false, model: 'mock', mockAllowed: true } }),
      requestListeningScaffold: scaffold,
    }))
    vi.doMock('../../src/lib/practice-history', async () => ({ ...(await vi.importActual<typeof import('../../src/lib/practice-history')>('../../src/lib/practice-history')), listPracticeAttempts: vi.fn().mockResolvedValue([]) }))
    installWaitingSessionSnapshot(1)
    container = document.createElement('div'); document.body.appendChild(container)
    const appModule = await import('../../src/App')
    root = createRoot(container); flushSync(() => root?.render(createElement(appModule.default)))
    const button = await vi.waitFor(() => {
      const next = Array.from(container?.querySelectorAll('button') ?? []).find((item) => item.textContent?.includes('查看关键信息'))
      expect(next).toBeDefined()
      return next as HTMLButtonElement
    }, { interval: 0 })
    flushSync(() => button.click())
    await vi.waitFor(() => expect(scaffold).toHaveBeenCalledOnce(), { interval: 0 })
    await vi.waitFor(() => expect(container?.textContent).toContain('当前会话关键信息'), { interval: 0 })
  })

  it('replaces a pending generic hint with the learner intention', async () => {
    vi.resetModules()
    const genericHint = deferred({ directionZh: '旧的泛化方向', keyPhrasesJa: ['古い'], sentenceStarterJa: '古いです', fullExampleJa: '古い結果です。' })
    const intendedHint = deferred({ directionZh: '询问换成热茶是否加钱', keyPhrasesJa: ['温かいお茶'], sentenceStarterJa: '温かいお茶に', fullExampleJa: '温かいお茶に変更すると、追加料金はかかりますか？' })
    const fetchHint = vi.fn().mockImplementationOnce(() => genericHint.promise).mockImplementationOnce(() => intendedHint.promise)
    vi.doMock('../../src/lib/api', async () => ({ ...(await vi.importActual<typeof import('../../src/lib/api')>('../../src/lib/api')), fetchConfig: vi.fn().mockResolvedValue({ mode: 'mock', limits: { maxTurns: 5 }, elevenlabs: { sttAvailable: false, ttsAvailable: false, voiceId: null, sttModel: 'scribe', ttsModel: 'tts' }, openai: { available: false, model: 'mock', mockAllowed: true } }), fetchHint }))
    vi.doMock('../../src/lib/practice-history', async () => ({ ...(await vi.importActual<typeof import('../../src/lib/practice-history')>('../../src/lib/practice-history')), listPracticeAttempts: vi.fn().mockResolvedValue([]) }))
    installWaitingSessionSnapshot()
    container = document.createElement('div'); document.body.appendChild(container)
    const appModule = await import('../../src/App')
    root = createRoot(container); flushSync(() => root.render(createElement(appModule.default)))
    const hintButton = await vi.waitFor(() => {
      const button = container.querySelector<HTMLButtonElement>('[aria-label="怎么说，查看表达帮助"]')
      expect(button).not.toBeNull()
      return button as HTMLButtonElement
    }, { interval: 0 })
    await flush(); flushSync(() => hintButton.click())
    await vi.waitFor(() => expect(fetchHint).toHaveBeenCalledTimes(1), { interval: 0 })
    const intention = container.querySelector<HTMLTextAreaElement>('textarea')
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    flushSync(() => { setter?.call(intention, '我想问换成热茶要不要加钱'); intention?.dispatchEvent(new Event('input', { bubbles: true })) })
    const submit = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('给我日语说法')) as HTMLButtonElement
    expect(submit.disabled).toBe(false)
    flushSync(() => submit.click())
    await vi.waitFor(() => expect(fetchHint).toHaveBeenCalledTimes(2), { interval: 0 })
    expect(fetchHint.mock.calls[1]?.[3]).toBe('我想问换成热茶要不要加钱')
    genericHint.resolve({ directionZh: '旧的泛化方向', keyPhrasesJa: ['古い'], sentenceStarterJa: '古いです', fullExampleJa: '古い結果です。' })
    intendedHint.resolve({ directionZh: '询问换成热茶是否加钱', keyPhrasesJa: ['温かいお茶'], sentenceStarterJa: '温かいお茶に', fullExampleJa: '温かいお茶に変更すると、追加料金はかかりますか？' })
    await vi.waitFor(() => expect(container.textContent).toContain('温かいお茶に変更すると、追加料金はかかりますか？'), { interval: 0 })
    expect(container.textContent).not.toContain('旧的泛化方向')
    const snapshot = JSON.parse(window.sessionStorage.getItem('kaiwa.current-session.v1') ?? '{}') as { currentRound?: { expressionScaffoldLevel?: number } }
    expect(snapshot.currentRound?.expressionScaffoldLevel).toBe(4)
  })

  it('drops a hint that returns after its sheet has closed without recording expression help', async () => {
    vi.resetModules()
    const delayedHint = deferred({ directionZh: '关闭后不得显示', keyPhrasesJa: ['古い'], sentenceStarterJa: '古いです', fullExampleJa: '古い結果です。' })
    vi.doMock('../../src/lib/api', async () => ({
      ...(await vi.importActual<typeof import('../../src/lib/api')>('../../src/lib/api')),
      fetchConfig: vi.fn().mockResolvedValue({ mode: 'mock', limits: { maxTurns: 5 }, elevenlabs: { sttAvailable: false, ttsAvailable: false, voiceId: null, sttModel: 'scribe', ttsModel: 'tts' }, openai: { available: false, model: 'mock', mockAllowed: true } }),
      fetchHint: vi.fn().mockImplementation(() => delayedHint.promise),
    }))
    vi.doMock('../../src/lib/practice-history', async () => ({ ...(await vi.importActual<typeof import('../../src/lib/practice-history')>('../../src/lib/practice-history')), listPracticeAttempts: vi.fn().mockResolvedValue([]) }))
    installWaitingSessionSnapshot()
    container = document.createElement('div'); document.body.appendChild(container)
    const appModule = await import('../../src/App')
    root = createRoot(container); flushSync(() => root.render(createElement(appModule.default)))
    const hintButton = await vi.waitFor(() => {
      const button = container.querySelector<HTMLButtonElement>('[aria-label="怎么说，查看表达帮助"]')
      expect(button).not.toBeNull()
      return button as HTMLButtonElement
    }, { interval: 0 })
    await flush()
    flushSync(() => hintButton.click())
    const close = await vi.waitFor(() => {
      const button = container.querySelector<HTMLButtonElement>('.im-sheet-close-btn')
      expect(button).not.toBeNull()
      return button as HTMLButtonElement
    }, { interval: 0 })
    flushSync(() => close.click())
    delayedHint.resolve({ directionZh: '关闭后不得显示', keyPhrasesJa: ['古い'], sentenceStarterJa: '古いです', fullExampleJa: '古い結果です。' })
    await flush(); await flush()
    expect(container.textContent).not.toContain('关闭后不得显示')
    const snapshot = JSON.parse(window.sessionStorage.getItem('kaiwa.current-session.v1') ?? '{}') as { currentRound?: { expressionScaffoldLevel?: number } }
    expect(snapshot.currentRound?.expressionScaffoldLevel).toBe(0)
  })
})

describe('SessionComplete redo lifecycle', () => {
  let activeRoot: Root | null = null
  let activeContainer: HTMLDivElement | null = null
  let localStorageDescriptor: PropertyDescriptor | undefined

  beforeEach(() => {
    localStorageDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage')
    Object.defineProperty(window, 'localStorage', { configurable: true, value: new (class implements Storage {
      #entries = new Map<string, string>()
      get length(): number { return this.#entries.size }
      clear(): void { this.#entries.clear() }
      getItem(key: string): string | null { return this.#entries.get(key) ?? null }
      key(index: number): string | null { return [...this.#entries.keys()][index] ?? null }
      removeItem(key: string): void { this.#entries.delete(key) }
      setItem(key: string, value: string): void { this.#entries.set(key, value) }
    })() })
  })
  afterEach(() => {
    activeRoot?.unmount()
    activeRoot = null
    activeContainer?.remove()
    activeContainer = null
    window.sessionStorage.clear()
    window.localStorage.clear()
    if (localStorageDescriptor) Object.defineProperty(window, 'localStorage', localStorageDescriptor)
    else delete (window as { localStorage?: Storage }).localStorage
    vi.doUnmock('../../src/lib/api')
    vi.doUnmock('../../src/lib/stt')
    vi.clearAllMocks()
  })

  function installCompletedConversationTask(status: 'transport_error' | 'failed', taskToken: string): string {
    const round = createRoundRecord(1, scenario.firstLine, 0)
    round.userOriginal = '前髪は残してください。'
    round.userCleaned = round.userOriginal
    round.userFinal = round.userOriginal
    round.inputMode = 'text'
    round.timing.audioStartedAt = 1
    round.timing.audioCompletedAt = 2
    const endedAt = Date.now()
    const requestId = crypto.randomUUID()
    const report = buildSessionReport('feedback-retry-session', 'mock', scenario, 1, endedAt, [round], [])
    window.localStorage.setItem('kaiwa.completed-review.v1', JSON.stringify({
      version: 1, sessionId: 'feedback-retry-session', scenario,
      messages: [{ id: 'assistant-1', turn: 1, role: 'assistant', text: scenario.firstLine }, { id: 'user-1', turn: 1, role: 'user', text: round.userFinal, transcript: { rawText: round.userOriginal, cleanedText: round.userCleaned, finalText: round.userFinal } }],
      rounds: [round], startedAt: 1, endedAt, report, feedback: null, redoRecords: [],
      pending: { conversation: {
        request: { kind: 'conversation', requestId, createdAt: endedAt, payload: { scenarioType: 'dynamic', sessionToken: scenario.sessionToken, turnRecords: [{ turn: 1, partnerPromptJa: scenario.firstLine, userOriginal: round.userOriginal, userCleaned: round.userCleaned, userConfirmed: round.userFinal, inputMode: 'text', transcriptModified: false, rerecordCount: 0, partnerAudioPlayCount: 1, ttsReplayCount: 0, transcriptRevealed: false, listeningScaffoldLevel: 0, expressionScaffoldLevel: 0, failureCount: 0, retryCount: 0, textFallback: true, speechAssistUsed: false }] } },
        taskToken, status, error: { code: status, message: '反馈任务暂时不可用。' },
      } },
    }))
    return requestId
  }

  it('resumes a transport-error conversation feedback task with its original capability', async () => {
    vi.resetModules()
    const taskSubmit = vi.fn()
    const taskGet = vi.fn().mockRejectedValueOnce(new Error('网络中断')).mockRejectedValueOnce(new Error('网络中断')).mockResolvedValue({ status: 'pending' })
    vi.doMock('../../src/lib/api', async () => ({
      ...(await vi.importActual<typeof import('../../src/lib/api')>('../../src/lib/api')),
      fetchConfig: vi.fn().mockResolvedValue({ mode: 'mock', limits: { maxTurns: 5 }, elevenlabs: { sttAvailable: false, ttsAvailable: false, voiceId: null, sttModel: 'scribe', ttsModel: 'tts' }, openai: { available: false, model: 'mock', mockAllowed: true } }),
      submitFeedbackTask: taskSubmit, getFeedbackTask: taskGet, listPracticeAttempts: vi.fn().mockResolvedValue([]),
    }))
    installCompletedConversationTask('transport_error', 'original-token')
    const container = activeContainer = document.createElement('div'); document.body.appendChild(container)
    const appModule = await import('../../src/App'); const root = activeRoot = createRoot(container)
    flushSync(() => root.render(createElement(appModule.default)))
    const retry = await vi.waitFor(() => {
      const button = Array.from(container.querySelectorAll('button')).find((item) => item.textContent === '重新生成')
      expect(button, container.textContent).toBeDefined()
      return button as HTMLButtonElement
    }, { interval: 0 })
    flushSync(() => retry.click())
    await vi.waitFor(() => expect(taskGet).toHaveBeenCalledTimes(3), { interval: 0 })
    expect(taskSubmit).not.toHaveBeenCalled()
    expect(taskGet.mock.calls.map(([token]) => token)).toEqual(['original-token', 'original-token', 'original-token'])
  })

  it('creates a new conversation request only after an explicit terminal-failure retry', async () => {
    vi.resetModules()
    const { ApiError } = await vi.importActual<typeof import('../../src/lib/api')>('../../src/lib/api')
    const taskSubmit = vi.fn().mockResolvedValue({ taskToken: 'replacement-token', expiresAt: Date.now() + 86_400_000 })
    const taskGet = vi.fn().mockRejectedValueOnce(new ApiError('invalid_token', 'capability 无效', 401)).mockResolvedValue({ status: 'pending' })
    vi.doMock('../../src/lib/api', async () => ({
      ...(await vi.importActual<typeof import('../../src/lib/api')>('../../src/lib/api')),
      fetchConfig: vi.fn().mockResolvedValue({ mode: 'mock', limits: { maxTurns: 5 }, elevenlabs: { sttAvailable: false, ttsAvailable: false, voiceId: null, sttModel: 'scribe', ttsModel: 'tts' }, openai: { available: false, model: 'mock', mockAllowed: true } }),
      submitFeedbackTask: taskSubmit, getFeedbackTask: taskGet, listPracticeAttempts: vi.fn().mockResolvedValue([]),
    }))
    const originalRequestId = installCompletedConversationTask('failed', 'invalid-token')
    const container = activeContainer = document.createElement('div'); document.body.appendChild(container)
    const appModule = await import('../../src/App'); const root = activeRoot = createRoot(container)
    flushSync(() => root.render(createElement(appModule.default)))
    const retry = await vi.waitFor(() => {
      const button = Array.from(container.querySelectorAll('button')).find((item) => item.textContent === '重新生成')
      expect(button, container.textContent).toBeDefined()
      return button as HTMLButtonElement
    }, { interval: 0 })
    flushSync(() => retry.click())
    await vi.waitFor(() => expect(taskSubmit).toHaveBeenCalledOnce(), { interval: 0 })
    expect(taskSubmit.mock.calls[0][0].requestId).not.toBe(originalRequestId)
  })

  it('does not start a redo microphone session when the token resolves after unmount', async () => {
    vi.resetModules()
    const tokenDeferred = (() => {
      let resolve!: (value: string) => void
      const promise = new Promise<string>((next) => { resolve = next })
      return { promise, resolve }
    })()
    const sttStart = vi.fn().mockResolvedValue(undefined)
    const feedback: ConversationFeedbackResponse = {
      outcome: 'partial',
      outcomeEvidenceZh: '已完成一项沟通目标。',
      listeningFinding: null,
      expressionImprovement: null,
      redoTask: {
        turn: 1,
        partnerPromptJa: scenario.firstLine,
        firstConfirmedJa: '前髪は残してください。',
        directionZh: '保留请求并补充细节。',
      },
    }
    const round = createRoundRecord(1, scenario.firstLine, 0)
    round.userFinal = '前髪は残してください。'
    round.timing.audioStartedAt = 1
    round.timing.audioCompletedAt = 2
    vi.doMock('../../src/lib/api', async () => ({
      ...(await vi.importActual<typeof import('../../src/lib/api')>('../../src/lib/api')),
      fetchConfig: vi.fn().mockResolvedValue({
        mode: 'mock', limits: { maxTurns: 5 },
        elevenlabs: { sttAvailable: true, ttsAvailable: false, voiceId: null, sttModel: 'scribe', ttsModel: 'tts' },
        openai: { available: false, model: 'mock', mockAllowed: true },
      }),
      submitFeedbackTask: vi.fn().mockResolvedValue({ taskToken: 'feedback-token', expiresAt: Date.now() + 86_400_000 }),
      getFeedbackTask: vi.fn().mockResolvedValue({ status: 'complete', kind: 'conversation', result: feedback }),
      requestElevenLabsToken: vi.fn().mockImplementation(() => tokenDeferred.promise),
      listPracticeAttempts: vi.fn().mockResolvedValue([]),
    }))
    vi.doMock('../../src/lib/stt', async () => ({
      ...(await vi.importActual<typeof import('../../src/lib/stt')>('../../src/lib/stt')),
      RealtimeSttSession: class {
        start = sttStart
        stop = vi.fn().mockResolvedValue('')
        close = vi.fn()
      },
    }))
    window.sessionStorage.setItem('kaiwa.current-session.v1', JSON.stringify({
      version: 1,
      phase: 'preparing_tts',
      sessionId: 'session-id',
      scenario,
      messages: [{ id: 'assistant-1', turn: 1, role: 'assistant', text: scenario.firstLine }],
      rounds: [],
      currentRound: round,
      turn: 5,
      sessionStartedAt: 1,
      transcript: { rawText: '', cleanedText: '', finalText: '' },
    }))
    const container = activeContainer = document.createElement('div')
    document.body.appendChild(container)
    const appModule = await import('../../src/App')
    const root = activeRoot = createRoot(container)
    flushSync(() => root.render(createElement(appModule.default)))
    const redoButton = await vi.waitFor(() => {
      const button = Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.includes('再练这个回合'))
      expect(button).toBeDefined()
      return button as HTMLButtonElement
    }, { interval: 0 })
    flushSync(() => redoButton.click())
    const startButton = await vi.waitFor(() => {
      const button = Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.includes('开始回答'))
      expect(button).toBeDefined()
      return button as HTMLButtonElement
    }, { interval: 0 })
    flushSync(() => startButton.click())
    root.unmount()
    activeRoot = null
    container.remove()
    activeContainer = null
    tokenDeferred.resolve('late-token')
    await flush()
    expect(sttStart).not.toHaveBeenCalled()
  })

  it('starts the redo microphone session when the token resolves while mounted', async () => {
    vi.resetModules()
    const sttStart = vi.fn().mockResolvedValue(undefined)
    vi.doMock('../../src/lib/api', async () => ({
      ...(await vi.importActual<typeof import('../../src/lib/api')>('../../src/lib/api')),
      fetchConfig: vi.fn().mockResolvedValue({
        mode: 'mock', limits: { maxTurns: 5 },
        elevenlabs: { sttAvailable: true, ttsAvailable: false, voiceId: null, sttModel: 'scribe', ttsModel: 'tts' },
        openai: { available: false, model: 'mock', mockAllowed: true },
      }),
      submitFeedbackTask: vi.fn().mockResolvedValue({ taskToken: 'feedback-token', expiresAt: Date.now() + 86_400_000 }),
      getFeedbackTask: vi.fn().mockResolvedValue({ status: 'complete', kind: 'conversation', result: { outcome: 'partial', outcomeEvidenceZh: '已完成一项沟通目标。', listeningFinding: null, expressionImprovement: { turn: 1, userConfirmedJa: '前髪は残してください。', suggestedJa: '前髪を少し整えてください。', reasonZh: '补充具体程度。' }, redoTask: { turn: 1, partnerPromptJa: scenario.firstLine, firstConfirmedJa: '前髪は残してください。', directionZh: '保留请求并补充细节。' } } }),
      requestElevenLabsToken: vi.fn().mockResolvedValue('ready-token'),
      listPracticeAttempts: vi.fn().mockResolvedValue([]),
    }))
    vi.doMock('../../src/lib/stt', async () => ({
      ...(await vi.importActual<typeof import('../../src/lib/stt')>('../../src/lib/stt')),
      RealtimeSttSession: class {
        start = sttStart
        stop = vi.fn().mockResolvedValue('')
        close = vi.fn()
      },
    }))
    const round = createRoundRecord(1, scenario.firstLine, 0)
    round.userFinal = '前髪は残してください。'
    round.timing.audioStartedAt = 1
    round.timing.audioCompletedAt = 2
    window.sessionStorage.setItem('kaiwa.current-session.v1', JSON.stringify({
      version: 1, phase: 'preparing_tts', sessionId: 'session-id', scenario,
      messages: [{ id: 'assistant-1', turn: 1, role: 'assistant', text: scenario.firstLine }], rounds: [], currentRound: round,
      turn: 5, sessionStartedAt: 1, transcript: { rawText: '', cleanedText: '', finalText: '' },
    }))
    const container = activeContainer = document.createElement('div')
    document.body.appendChild(container)
    const appModule = await import('../../src/App')
    const root = activeRoot = createRoot(container)
    flushSync(() => root.render(createElement(appModule.default)))
    const fullReview = await vi.waitFor(() => {
      const details = container.querySelector<HTMLDetailsElement>('.complete-review-details')
      expect(details).not.toBeNull()
      return details as HTMLDetailsElement
    }, { interval: 0 })
    expect(fullReview.open).toBe(false)
    const redoCard = container.querySelector<HTMLElement>('.retry-task-card')
    expect(redoCard).not.toBeNull()
    expect(redoCard!.compareDocumentPosition(fullReview) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    fullReview.querySelector('summary')?.click()
    expect(fullReview.open).toBe(true)
    const suggestedExpression = Array.from(fullReview.querySelectorAll('p[lang="ja"]')).find((node) => node.textContent?.includes('前髪を少し整えてください。'))
    expect(suggestedExpression).not.toBeUndefined()
    const redoButton = await vi.waitFor(() => {
      const button = Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.includes('再练这个回合'))
      expect(button).toBeDefined()
      return button as HTMLButtonElement
    }, { interval: 0 })
    flushSync(() => redoButton.click())
    const expressionHelp = await vi.waitFor(() => {
      const button = Array.from(container.querySelectorAll('button')).find((item) => item.textContent === '看表达方向')
      expect(button).toBeDefined()
      return button as HTMLButtonElement
    }, { interval: 0 })
    flushSync(() => expressionHelp.click())
    expect(container.textContent).toContain('保留请求并补充细节。')
    expect(Array.from(container.querySelectorAll('button')).some((item) => item.textContent === '看表达方向')).toBe(false)
    const startButton = await vi.waitFor(() => {
      const button = Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.includes('开始回答'))
      expect(button).toBeDefined()
      return button as HTMLButtonElement
    }, { interval: 0 })
    flushSync(() => startButton.click())
    await vi.waitFor(() => expect(sttStart).toHaveBeenCalledOnce(), { interval: 0 })
    expect(sttStart).toHaveBeenCalledOnce()
    root.unmount()
    activeRoot = null
    container.remove()
    activeContainer = null
  })

  it('restores the completed review redo confirmation draft after refresh without starting a new task', async () => {
    vi.resetModules()
    const taskGet = vi.fn().mockResolvedValue({ status: 'pending' })
    const taskSubmit = vi.fn()
    vi.doMock('../../src/lib/api', async () => ({
      ...(await vi.importActual<typeof import('../../src/lib/api')>('../../src/lib/api')),
      fetchConfig: vi.fn().mockResolvedValue({ mode: 'mock', limits: { maxTurns: 5 }, elevenlabs: { sttAvailable: false, ttsAvailable: false, voiceId: null, sttModel: 'scribe', ttsModel: 'tts' }, openai: { available: false, model: 'mock', mockAllowed: true } }),
      submitFeedbackTask: taskSubmit, getFeedbackTask: taskGet, listPracticeAttempts: vi.fn().mockResolvedValue([]),
    }))
    const completedRound = createRoundRecord(1, scenario.firstLine, 1)
    completedRound.userOriginal = '前髪を少し短くしてください。'
    completedRound.userCleaned = completedRound.userOriginal
    completedRound.userFinal = completedRound.userOriginal
    completedRound.inputMode = 'text'
    completedRound.timing.audioStartedAt = 1
    completedRound.timing.audioCompletedAt = 2
    const endedAt = Date.now()
    const report = buildSessionReport('completed-session', 'mock', scenario, 1, endedAt, [completedRound], [])
    window.localStorage.setItem('kaiwa.completed-review.v1', JSON.stringify({
      version: 1, sessionId: 'completed-session', scenario, messages: [
        { id: 'assistant-1', turn: 1, role: 'assistant', text: scenario.firstLine },
        { id: 'user-1', turn: 1, role: 'user', text: completedRound.userFinal, transcript: { rawText: completedRound.userOriginal, cleanedText: completedRound.userCleaned, finalText: completedRound.userFinal } },
      ], rounds: [completedRound],
      startedAt: 1, endedAt, report, feedback: { outcome: 'partial', outcomeEvidenceZh: '证据', listeningFinding: null, expressionImprovement: null, redoTask: { turn: 1, partnerPromptJa: scenario.firstLine, firstConfirmedJa: '前髪は残してください。', directionZh: '补充细节。' } },
      redoRecords: [], pending: { redo: { request: { kind: 'redo', requestId: crypto.randomUUID(), createdAt: Date.now(), payload: { scenarioType: 'dynamic', sessionToken: scenario.sessionToken, turn: 1, partnerPromptJa: scenario.firstLine, firstConfirmedJa: '前髪は残してください。', secondConfirmedJa: '前髪を少し短くしてください。', secondInputMode: 'text', secondListeningScaffoldLevel: 0, secondExpressionScaffoldLevel: 0 } }, status: 'pending', taskToken: 'redo-token' } },
    }))
    const container = activeContainer = document.createElement('div'); document.body.appendChild(container)
    const appModule = await import('../../src/App'); const root = activeRoot = createRoot(container)
    flushSync(() => root.render(createElement(appModule.default)))
    const draft = await vi.waitFor(() => {
      const textarea = container.querySelector<HTMLTextAreaElement>('#redo-confirmed'); expect(textarea).not.toBeNull(); return textarea as HTMLTextAreaElement
    }, { interval: 0 })
    expect(draft.value).toBe('前髪を少し短くしてください。')
    expect(taskSubmit).not.toHaveBeenCalled()
    expect(taskGet).toHaveBeenCalledWith('redo-token', expect.any(AbortSignal))
  })

  it('does not save a late redo comparison after leaving its completed session', async () => {
    vi.resetModules()
    const accepted = deferred<{ taskToken: string; expiresAt: number }>()
    const taskSubmit = vi.fn().mockImplementation(() => accepted.promise)
    vi.doMock('../../src/lib/api', async () => ({
      ...(await vi.importActual<typeof import('../../src/lib/api')>('../../src/lib/api')),
      fetchConfig: vi.fn().mockResolvedValue({ mode: 'mock', limits: { maxTurns: 5 }, elevenlabs: { sttAvailable: false, ttsAvailable: false, voiceId: null, sttModel: 'scribe', ttsModel: 'tts' }, openai: { available: false, model: 'mock', mockAllowed: true } }),
      submitFeedbackTask: taskSubmit,
      getFeedbackTask: vi.fn().mockResolvedValue({ status: 'complete', kind: 'redo', result: { comparisonZh: '迟到比较不得写入', referenceExpressionJa: '新しい表現です。' } }),
      listPracticeAttempts: vi.fn().mockResolvedValue([]),
    }))
    const round = createRoundRecord(1, scenario.firstLine, 0)
    round.userOriginal = '前髪を短くしてください。'
    round.userCleaned = round.userOriginal
    round.userFinal = round.userOriginal
    round.inputMode = 'text'
    round.timing.audioStartedAt = 1
    round.timing.audioCompletedAt = 2
    const endedAt = Date.now()
    const report = buildSessionReport('redo-owner-session', 'mock', scenario, 1, endedAt, [round], [])
    window.localStorage.setItem('kaiwa.completed-review.v1', JSON.stringify({
      version: 1, sessionId: 'redo-owner-session', scenario,
      messages: [{ id: 'assistant-1', turn: 1, role: 'assistant', text: scenario.firstLine }], rounds: [round], startedAt: 1, endedAt, report,
      feedback: { outcome: 'partial', outcomeEvidenceZh: '证据', listeningFinding: null, expressionImprovement: null, redoTask: { turn: 1, partnerPromptJa: scenario.firstLine, firstConfirmedJa: '前髪は残してください。', directionZh: '补充细节。' } }, redoRecords: [], pending: {},
    }))
    const container = activeContainer = document.createElement('div'); document.body.appendChild(container)
    const appModule = await import('../../src/App'); const root = activeRoot = createRoot(container)
    flushSync(() => root.render(createElement(appModule.default)))
    const redoButton = await vi.waitFor(() => {
      const button = Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.includes('再练这个回合'))
      expect(button).toBeDefined()
      return button as HTMLButtonElement
    }, { interval: 0 })
    flushSync(() => redoButton.click())
    const textButton = await vi.waitFor(() => {
      const button = Array.from(container.querySelectorAll('button')).find((item) => item.textContent === '改用文字')
      expect(button).toBeDefined()
      return button as HTMLButtonElement
    }, { interval: 0 })
    flushSync(() => textButton.click())
    const textarea = await vi.waitFor(() => {
      const input = container.querySelector<HTMLTextAreaElement>('#redo-confirmed')
      expect(input).not.toBeNull()
      return input as HTMLTextAreaElement
    }, { interval: 0 })
    flushSync(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(textarea, '前髪をもっと短くしてください。')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const confirmButton = Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.includes('确认回答并查看比较'))
    expect(confirmButton).toBeDefined()
    flushSync(() => (confirmButton as HTMLButtonElement).click())
    await vi.waitFor(() => expect(taskSubmit).toHaveBeenCalled(), { interval: 0 })
    const leaveButton = Array.from(container.querySelectorAll('button')).find((item) => item.textContent === '开始新场景')
    expect(leaveButton).toBeDefined()
    flushSync(() => (leaveButton as HTMLButtonElement).click())
    accepted.resolve({ taskToken: 'late-redo-token', expiresAt: Date.now() + 86_400_000 })
    await flush(); await flush()
    expect(container.textContent).not.toContain('迟到比较不得写入')
    expect(window.localStorage.getItem('kaiwa.completed-review.v1')).toBeNull()
  })
})
