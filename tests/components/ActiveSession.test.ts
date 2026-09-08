/**
 * [INPUT]: ActiveSession 的中文意图录音、表达提示与参考音频动作
 * [OUTPUT]: 锁定中文录音的输入保全、取消代际、麦克风所有权与参考音频边界
 * [POS]: tests/components 的活动会话中文意图输入挂载回归
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
// @vitest-environment jsdom
import { createElement, useState } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: null as null | { onPartial: (text: string) => void },
  stop: vi.fn<() => Promise<string>>(),
  token: vi.fn<() => Promise<string>>(),
  release: vi.fn(), releaseAi: vi.fn(), play: vi.fn<() => Promise<void>>(), startJapanese: vi.fn<() => Promise<void>>(), adviceViewed: vi.fn(),
  setup: vi.fn<(options: { connectStt: (token: string) => Promise<void> }) => Promise<boolean>>(),
}))
vi.mock('../../src/lib/api', () => ({ requestElevenLabsToken: mocks.token }))
vi.mock('../../src/lib/audio-engine', () => ({ releaseMicrophoneStream: mocks.release, shouldTeardownOnVisibility: () => true }))
vi.mock('../../src/lib/recording-setup', () => ({ coordinateRecordingSetup: mocks.setup }))
vi.mock('../../src/lib/stt', () => ({ RealtimeSttSession: class { async start(_token: string, _model: string, handlers: typeof mocks.handlers): Promise<void> { mocks.handlers = handlers } stop = mocks.stop; close(): void {} } }))

import { ActiveSession, type ActiveSessionActions, type ActiveSessionModel } from '../../src/components/ActiveSession'

const flush = async () => { await Promise.resolve(); await Promise.resolve() }
const click = (box: HTMLElement, text: string) => Array.from(box.querySelectorAll('button')).find((item) => item.textContent?.includes(text)) as HTMLButtonElement
function Harness({ phase = 'waiting_user' as const, notice = '', previousAdvice = false }: { phase?: ActiveSessionModel['phase']; notice?: string; previousAdvice?: boolean }): React.JSX.Element {
  const [sheet, setSheet] = useState(true)
  const model = {
    phase, scenario: { maxTurns: 5, dynamicData: { aiRole: '店员', titleZh: '测试', summaryZh: '', coreGoal: { titleZh: '', descriptionZh: '' } } }, turn: 1, controlsLocked: false, showGoalsSheet: false, sessionCoreGoal: null, recoveryMessage: '', interruptionRecovery: { status: 'idle' }, interruptionRecoveryAffordances: {}, recoveryTarget: null, online: true, effectiveForegroundNotice: '', messages: [], listeningRequestStates: {}, activeAiMessageId: null, pausedAiMessageId: null, playedAiMessageIds: new Set(), activeError: null, activeFailedStep: null, silenceCountdownSeconds: null, activeAssistIsVisible: false, activeAssistState: null, confirmedTranscript: '', interimTranscript: '', partialTranscript: '', recordingSeconds: 0, dockInputMode: 'voice', dockTextValue: '', hintData: { directionZh: '说明', keyPhrasesJa: ['料金'], sentenceStarterJa: '料金は', fullExampleJa: '追加料金はかかりますか？' }, isLoadingHint: false, hintLevel: 4, showHintSheet: sheet, showTranscriptSheet: false, manualInput: false, transcript: { rawText: '', finalText: '' }, showOriginalTranscript: false, inlineError: '', canConfirmTranscript: false, sttAvailable: true, sttModel: 'scribe', ttsAvailable: true, reviewAudioNotice: notice,
    previousAdvice: previousAdvice ? { expressionImprovement: { turn: 1, userConfirmedJa: 'これをください。', suggestedJa: 'こちらをお願いします。', reasonZh: '更礼貌。' }, sourceSessionId: 'source-session', sourceStartedAt: 1, viewed: false } : undefined,
  } as ActiveSessionModel
  const actions = {
    endSession: vi.fn(), setShowGoalsSheet: vi.fn(), dispatchInterruptionRecovery: vi.fn(), setAppForegroundNotice: vi.fn(), clearVoiceNotice: vi.fn(), getListeningLevel: vi.fn(() => 0), replayPartnerMessage: vi.fn(), advanceListeningScaffold: vi.fn(), setDockInputMode: vi.fn(), startRecording: mocks.startJapanese, enterTextInput: vi.fn(), enterLifecycleTextInput: vi.fn(), updateFinalText: vi.fn(), setDockTextValue: vi.fn(), openTranscriptSheet: vi.fn(), handleRequestHint: vi.fn().mockResolvedValue(undefined), setShowHintSheet: setSheet, stopRecording: vi.fn(), skipFailedTts: vi.fn(), retryFailedStep: vi.fn(), resetSession: vi.fn(), stopAiPlayback: vi.fn(), releaseAiPlayback: mocks.releaseAi, playReviewAudio: mocks.play, closeTranscriptSheet: vi.fn(), rerecord: vi.fn(), confirmTranscript: vi.fn(), setInlineError: vi.fn(), toggleOriginalTranscript: vi.fn(), onPreviousAdviceViewed: mocks.adviceViewed,
  } as unknown as ActiveSessionActions
  return createElement(ActiveSession, { model, actions, messageListRef: { current: null }, chatBottomRef: { current: null } })
}

describe('ActiveSession 中文意图录音', () => {
  let root: Root; let container: HTMLDivElement
  beforeEach(() => {
    mocks.handlers = null; mocks.stop.mockReset().mockResolvedValue('想换热茶'); mocks.token.mockReset().mockResolvedValue('token'); mocks.release.mockReset(); mocks.releaseAi.mockReset(); mocks.play.mockReset().mockResolvedValue(undefined); mocks.startJapanese.mockReset().mockResolvedValue(undefined); mocks.adviceViewed.mockReset()
    mocks.setup.mockReset().mockImplementation(async ({ connectStt }) => { await connectStt('token'); return true })
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); flushSync(() => root.render(createElement(Harness)))
  })
  afterEach(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); flushSync(() => root.unmount()); container.remove(); vi.clearAllMocks() })

  it('保留已有输入，并在停止后写入最终中文', async () => {
    const area = container.querySelector<HTMLTextAreaElement>('.im-hint-intention-field textarea')!
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    flushSync(() => { setter.call(area, '我想问'); area.dispatchEvent(new Event('input', { bubbles: true })) })
    click(container, '中文语音输入').click(); await flush()
    await vi.waitFor(() => expect(click(container, '说完了，返回表达帮助')).toBeDefined(), { interval: 0 })
    expect(area.readOnly).toBe(true)
    flushSync(() => mocks.handlers?.onPartial('换热茶'))
    expect(area.value).toBe('我想问 换热茶')
    flushSync(() => click(container, '说完了，返回表达帮助').click())
    await vi.waitFor(() => expect(area.value).toBe('我想问 想换热茶'), { interval: 0 })
    expect(mocks.release).toHaveBeenCalledOnce()
  })

  it('关闭会取消连接；迟到的旧失败不释放后续麦克风', async () => {
    let rejectSetup!: (error: Error) => void
    mocks.setup.mockImplementationOnce(() => new Promise<boolean>((_, reject) => { rejectSetup = reject })).mockImplementationOnce(async ({ connectStt }) => { await connectStt('token'); return true })
    click(container, '中文语音输入').click(); await flush()
    container.querySelector<HTMLButtonElement>('.im-sheet-close-btn')!.click(); await flush()
    expect(mocks.release).toHaveBeenCalledOnce()
    flushSync(() => root.unmount()); root = createRoot(container)
    flushSync(() => root.render(createElement(Harness)))
    click(container, '中文语音输入').click(); await flush()
    rejectSetup(new Error('late'))
    await flush()
    expect(mocks.release).toHaveBeenCalledOnce()
  })

  it('关闭和后台取消后会忽略迟到的 stop 结果', async () => {
    let resolveStop!: (text: string) => void
    mocks.stop.mockReturnValueOnce(new Promise<string>((resolve) => { resolveStop = resolve }))
    click(container, '中文语音输入').click(); await flush()
    await vi.waitFor(() => expect(click(container, '说完了，返回表达帮助')).toBeDefined(), { interval: 0 })
    click(container, '说完了，返回表达帮助').click(); await flush()
    container.querySelector<HTMLButtonElement>('.im-sheet-close-btn')!.click(); await flush()
    resolveStop('迟到结果')
    await flush()
    expect(container.textContent).not.toContain('迟到结果')
    expect(mocks.release).toHaveBeenCalledOnce()

  })

  it('后台会取消中文录音', async () => {
    click(container, '中文语音输入').click(); await flush()
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    document.dispatchEvent(new Event('visibilitychange'))
    await flush()
    expect(mocks.release).toHaveBeenCalledOnce()
  })

  it('日语录音中禁用中文录音，并通过既有控制器播放参考音频和显示错误', () => {
    flushSync(() => root.unmount()); root = createRoot(container)
    flushSync(() => root.render(createElement(Harness, { phase: 'recording', notice: '参考语音暂时无法播放，请直接阅读文字。' })))
    expect(click(container, '中文语音输入').disabled).toBe(true)
    expect(container.textContent).toContain('参考语音暂时无法播放，请直接阅读文字。')
    // 当前录音状态下不会出现参考例句播放入口；重新渲染到等待状态验证调用边界。
    flushSync(() => root.render(createElement(Harness)))
    click(container, '听一听').click()
    expect(mocks.play).toHaveBeenCalledWith('追加料金はかかりますか？')
    click(container, '点击开始回答').click()
    expect(mocks.startJapanese).toHaveBeenCalledOnce()
  })

  it('展开上次建议才记录帮助，并在录音中隐藏播放入口', () => {
    flushSync(() => root.unmount()); root = createRoot(container)
    flushSync(() => root.render(createElement(Harness, { previousAdvice: true })))
    flushSync(() => click(container, '上次建议').click())
    expect(mocks.adviceViewed).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('こちらをお願いします。')
    click(container, '听一听').click()
    expect(mocks.play).toHaveBeenCalledWith('こちらをお願いします。')
    flushSync(() => root.render(createElement(Harness, { phase: 'recording', previousAdvice: true })))
    expect(click(container, '听一听').disabled).toBe(true)
  })
})
