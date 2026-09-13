/**
 * [INPUT]: 真实 SessionComplete 挂载、离线状态切换、可控 STT/录音/播放外部动作
 * [OUTPUT]: 锁定重做 token/STT/本机录音的确认保存与中断废弃、懒播放 URL 回收、转写保全、文字确认回退、迟到结果隔离与恢复重试契约
 * [POS]: tests/client/ 完成页重做媒体与本机录音生命周期组件回归测试
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
  captureStart: vi.fn<() => 'started' | 'unavailable'>(), captureStop: vi.fn<() => Promise<null | { sessionId: string; turn: number; kind: 'redo'; blob: Blob; createdAt: number; durationMs: number; mimeType: string }>>(), captureDiscard: vi.fn(), saveRecording: vi.fn<() => Promise<void>>(), hasRecording: vi.fn<() => Promise<boolean>>(), getRecording: vi.fn<() => Promise<{ blob: Blob } | null>>(),
}))
vi.mock('../../src/lib/voice-recordings', () => ({
  createVoiceCapture: () => ({ start: mocks.captureStart, stop: mocks.captureStop, discard: mocks.captureDiscard }),
  saveVoiceRecording: mocks.saveRecording, hasVoiceRecording: mocks.hasRecording, getVoiceRecording: mocks.getRecording,
}))
vi.mock('../../src/lib/recording-setup', () => ({
  coordinateRecordingSetup: async ({ acquireToken, connectStt, isCancelled, onMicrophoneStream }: { acquireToken: () => Promise<string>; connectStt: (token: string) => Promise<void>; isCancelled?: () => boolean; onMicrophoneStream?: (stream: MediaStream) => void }) => {
    const token = await acquireToken()
    if (isCancelled?.()) throw new Error('cancelled')
    onMicrophoneStream?.({} as MediaStream)
    await connectStt(token)
    return true
  },
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
  id: 'haircut', version: 1, variantId: 'default', maxTurns: 5,
  reveal: { titleZh: '理发店', summaryZh: '说明要求。' }, scenarioType: 'dynamic', sessionToken: 'session-token', scenarioToken: 'scenario-token',
  dynamicData: {
    id: 'haircut', version: 1, titleZh: '理发店', summaryZh: '说明要求。', aiRole: '理发师', userRole: '顾客', relationship: '顾客与店员', tone: '礼貌', opening: { speaker: 'assistant', partnerLineJa: 'いらっしゃいませ。', planZh: '迎接到店顾客' }, userGoal: '说明要求。',
    coreGoal: { id: 'goal', titleZh: '说明要求', descriptionZh: '清楚说明。' }, communicationFunction: '提出要求', initialFacts: [], partnerPrivateFacts: [], keyIntents: [], keyInformation: [], completionRules: { completed: [], partial: [], notCompleted: [] }, closingRules: [], maxTurns: 5, worldAnchors: [], followUpPrinciples: [], hintStrategy: 'direct', feedbackFocus: [], safetyBoundary: 'none',
  },
}
const feedbackData: ConversationFeedbackResponse = {
  outcome: 'partial', outcomeEvidenceZh: '部分完成。', listeningFinding: null, expressionImprovement: null,
  redoTask: { turn: 1, partnerPromptJa: 'いらっしゃいませ。', firstConfirmedJa: '短くしてください。', directionZh: '保留要求。' },
}
const config: PrototypeConfig = { mode: 'real', limits: { maxTurns: 5 }, elevenlabs: { sttAvailable: true, ttsAvailable: false, voiceId: null, sttModel: 'scribe', ttsModel: 'tts' }, openai: { available: false, model: 'mock', mockAllowed: true } }
const report = buildSessionReport('session-id', 'real', scenario, 1, 2, [createRoundRecord(1, 'いらっしゃいませ。', 0)])
const flush = async (): Promise<void> => { await Promise.resolve(); await new Promise<void>((resolve) => queueMicrotask(resolve)) }

function props(online: boolean, saveRecordingsEnabled = false, overrides: { scenario?: SessionScenario; feedbackData?: ConversationFeedbackResponse; report?: ReturnType<typeof buildSessionReport> } = {}) {
  const activeScenario = overrides.scenario ?? scenario
  const activeFeedback = overrides.feedbackData ?? feedbackData
  const activeReport = overrides.report ?? report
  return {
    messages: activeScenario.dynamicData.opening.speaker === 'assistant' ? [{ id: 'assistant-1', turn: 1, role: 'assistant' as const, text: activeScenario.dynamicData.opening.partnerLineJa }] : [], rounds: [], report: activeReport, sessionId: 'session-id', scenario: activeScenario, reveal: activeScenario.reveal, config, online, feedbackData: activeFeedback, feedbackStatus: 'success' as const, feedbackErrorMsg: '',
    onRetryFeedback: vi.fn(), copyStatus: '', onCopy: vi.fn(), onDownload: vi.fn(), onReplayAi: vi.fn(), onStopAudio: vi.fn(), onRequestRedo: vi.fn(), onRequestListeningScaffold: vi.fn(), onCacheListeningScaffold: vi.fn(), onNewScenario: vi.fn(), audioNotice: '', practiceComparison: null, historyNotice: '', saveRecordingsEnabled,
  }
}

const userOpeningScenario: SessionScenario = {
  ...scenario,
  dynamicData: { ...scenario.dynamicData, opening: { speaker: 'user', planZh: '用户先说明遗失物品并请求查询。' } },
}
const userOpeningFeedback: ConversationFeedbackResponse = {
  ...feedbackData,
  redoTask: { ...feedbackData.redoTask, partnerPromptJa: null },
}

describe('SessionComplete offline redo lifecycle', () => {
  let root: Root
  let container: HTMLDivElement
  beforeEach(() => {
    mocks.token.mockReset()
    mocks.starts.length = 0
    mocks.sessions.length = 0
    mocks.captureStart.mockReset().mockReturnValue('started'); mocks.captureStop.mockReset().mockResolvedValue(null); mocks.captureDiscard.mockReset(); mocks.saveRecording.mockReset().mockResolvedValue(undefined); mocks.hasRecording.mockReset().mockResolvedValue(false); mocks.getRecording.mockReset().mockResolvedValue(null)
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

  it('本机录音不可用时提示但仍保持 STT 录音可用', async () => {
    mocks.captureStart.mockReturnValue('unavailable')
    mocks.token.mockResolvedValue('token')
    flushSync(() => root.render(createElement(SessionComplete, props(true, true))))
    flushSync(() => Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('再练这个回合'))?.click())
    flushSync(() => Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('开始回答'))?.click())
    await vi.waitFor(() => expect(container.textContent).toContain('当前浏览器无法保存录音，练习仍可继续。'), { interval: 0 })
    expect(container.textContent).toContain('说完了，确认转写')
  })

  it('停止只保留 redo 暂存录音，确认回答才保存一次', async () => {
    const pending = { sessionId: 'session-id', turn: 1, kind: 'redo' as const, blob: new Blob(['voice']), createdAt: 1, durationMs: 10, mimeType: 'audio/webm' }
    mocks.captureStop.mockResolvedValue(pending)
    mocks.token.mockResolvedValue('token')
    const view = props(true, true)
    flushSync(() => root.render(createElement(SessionComplete, view)))
    flushSync(() => Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.includes('再练这个回合'))?.click())
    flushSync(() => Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.includes('开始回答'))?.click())
    await vi.waitFor(() => expect(mocks.sessions).toHaveLength(1), { interval: 0 })
    mocks.sessions[0]!.stop.mockResolvedValue('短くしてください。')
    flushSync(() => Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.includes('说完了，确认转写'))?.click())
    await vi.waitFor(() => expect(container.querySelector('#redo-confirmed')).not.toBeNull(), { interval: 0 })
    expect(mocks.saveRecording).not.toHaveBeenCalled()
    flushSync(() => Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.includes('确认回答并查看比较'))?.click())
    await vi.waitFor(() => expect(mocks.saveRecording).toHaveBeenCalledOnce(), { interval: 0 })
    expect(mocks.saveRecording).toHaveBeenCalledWith(pending)
  })

  it('重新录音、改文字、离线或卸载都会丢弃 redo 暂存而不保存', async () => {
    const pending = { sessionId: 'session-id', turn: 1, kind: 'redo' as const, blob: new Blob(['voice']), createdAt: 1, durationMs: 10, mimeType: 'audio/webm' }
    mocks.captureStop.mockResolvedValue(pending)
    mocks.token.mockResolvedValue('token')
    flushSync(() => root.render(createElement(SessionComplete, props(true, true))))
    flushSync(() => Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.includes('再练这个回合'))?.click())
    flushSync(() => Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.includes('开始回答'))?.click())
    await vi.waitFor(() => expect(mocks.sessions).toHaveLength(1), { interval: 0 })
    mocks.sessions[0]!.stop.mockResolvedValue('短くしてください。')
    flushSync(() => Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.includes('说完了，确认转写'))?.click())
    await vi.waitFor(() => expect(container.querySelector('#redo-confirmed')).not.toBeNull(), { interval: 0 })
    flushSync(() => Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.includes('重新录音'))?.click())
    expect(mocks.captureDiscard).toHaveBeenCalled()
    expect(mocks.saveRecording).not.toHaveBeenCalled()
    flushSync(() => root.render(createElement(SessionComplete, props(false, true))))
    root.unmount()
    expect(mocks.saveRecording).not.toHaveBeenCalled()
  })

  it('播放按点击懒读取，并在替换、停止、ended 与卸载时释放对象 URL', async () => {
    const urls = ['blob:first', 'blob:second', 'blob:third', 'blob:fourth']
    const createUrl = vi.fn(() => urls.shift()!)
    const revokeUrl = vi.fn()
    const audios: FakeAudio[] = []
    vi.stubGlobal('URL', { createObjectURL: createUrl, revokeObjectURL: revokeUrl })
    class FakeAudio {
      onended: (() => void) | null = null
      pause = vi.fn()
      play = vi.fn(async () => undefined)
      constructor(_url: string) { audios.push(this) }
    }
    vi.stubGlobal('Audio', FakeAudio)
    mocks.hasRecording.mockResolvedValue(true)
    mocks.getRecording.mockResolvedValue({ blob: new Blob(['voice']) })
    flushSync(() => root.render(createElement(SessionComplete, props(true))))
    await vi.waitFor(() => expect(container.textContent).toContain('播放重做录音'), { interval: 0 })
    expect(mocks.getRecording).not.toHaveBeenCalled()
    const play = () => Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.includes('播放重做录音'))?.click()
    flushSync(play)
    await vi.waitFor(() => expect(createUrl).toHaveBeenCalledOnce(), { interval: 0 })
    expect(mocks.getRecording).toHaveBeenCalledOnce()
    flushSync(play)
    await vi.waitFor(() => expect(revokeUrl).toHaveBeenCalledWith('blob:first'), { interval: 0 })
    const stop = Array.from(container.querySelectorAll('button')).find((item) => item.textContent === '停止')
    flushSync(() => stop?.click())
    expect(revokeUrl).toHaveBeenCalledWith('blob:second')
    flushSync(play)
    await vi.waitFor(() => expect(createUrl).toHaveBeenCalledTimes(3), { interval: 0 })
    audios[2]?.onended?.()
    expect(revokeUrl).toHaveBeenCalledWith('blob:third')
    flushSync(play)
    await vi.waitFor(() => expect(createUrl).toHaveBeenCalledTimes(4), { interval: 0 })
    root.unmount()
    expect(revokeUrl).toHaveBeenCalledWith('blob:fourth')
  })

  it('user-opening first redo skips nonexistent partner replay and listening scaffold', async () => {
    const onReplayAi = vi.fn()
    const view = props(true, false, { scenario: userOpeningScenario, feedbackData: userOpeningFeedback, report: buildSessionReport('session-id', 'real', userOpeningScenario, 1, 2, [createRoundRecord(1, null, 0)]) })
    view.onReplayAi = onReplayAi
    flushSync(() => root.render(createElement(SessionComplete, view)))
    flushSync(() => Array.from(container.querySelectorAll('button')).find((item) => item.textContent?.includes('再练这个回合'))?.click())
    expect(onReplayAi).not.toHaveBeenCalled()
    expect(container.textContent).toContain('这是你先开场的回合，请直接重做开场表达。')
    expect(container.textContent).toContain('看表达方向')
    expect(container.textContent).not.toContain('从头重听')
    expect(container.textContent).not.toContain('先重听一遍')
    expect(container.textContent).not.toContain('关键信息')
  })
})
