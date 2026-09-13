/**
 * [INPUT]: ActiveSession 的中文意图录音、在线状态切换、日语录音静音保全提示、表达提示与参考音频动作
 * [OUTPUT]: 锁定中文录音的输入保全、取消代际、在线离线取消、麦克风所有权、静音提示与参考音频边界
 * [POS]: tests/components 的活动会话录音挂载回归
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
  release: vi.fn(), releaseAi: vi.fn(), play: vi.fn<() => Promise<void>>(), startJapanese: vi.fn<() => Promise<void>>(), stopRecording: vi.fn<() => Promise<void>>(), adviceViewed: vi.fn(),
  setup: vi.fn<(options: { connectStt: (token: string) => Promise<void> }) => Promise<boolean>>(),
}))
vi.mock('../../src/lib/api', () => ({ requestElevenLabsToken: mocks.token }))
vi.mock('../../src/lib/audio-engine', () => ({ releaseMicrophoneStream: mocks.release, shouldTeardownOnVisibility: () => true }))
vi.mock('../../src/lib/recording-setup', () => ({ coordinateRecordingSetup: mocks.setup }))
vi.mock('../../src/lib/stt', () => ({ RealtimeSttSession: class { async start(_token: string, _model: string, handlers: typeof mocks.handlers): Promise<void> { mocks.handlers = handlers } stop = mocks.stop; close(): void {} } }))

import { ActiveSession, type ActiveSessionActions, type ActiveSessionModel } from '../../src/components/ActiveSession'

const flush = async () => { await Promise.resolve(); await Promise.resolve() }
const click = (box: HTMLElement, text: string) => Array.from(box.querySelectorAll('button')).find((item) => item.textContent?.includes(text)) as HTMLButtonElement
function Harness({ phase = 'waiting_user' as const, notice = '', previousAdvice = false, online = true, silencePromptVisible = false, userOpening = false, hintVisible = true, transcriptVisible = false }: { phase?: ActiveSessionModel['phase']; notice?: string; previousAdvice?: boolean; online?: boolean; silencePromptVisible?: boolean; userOpening?: boolean; hintVisible?: boolean; transcriptVisible?: boolean }): React.JSX.Element {
  const [sheet, setSheet] = useState(hintVisible)
  const [transcriptSheet, setTranscriptSheet] = useState(transcriptVisible)
  const model = {
    phase, scenario: { maxTurns: 5, dynamicData: { aiRole: '店员', titleZh: '测试', summaryZh: '', coreGoal: { titleZh: '', descriptionZh: '' }, opening: userOpening ? { speaker: 'user', planZh: '说明来意。' } : { speaker: 'assistant', partnerLineJa: 'いらっしゃいませ。', planZh: '迎客并询问需求。' } } }, turn: 1, controlsLocked: false, showGoalsSheet: false, sessionCoreGoal: null, recoveryMessage: '', interruptionRecovery: { status: 'idle' }, interruptionRecoveryAffordances: {}, recoveryTarget: null, online, effectiveForegroundNotice: '', messages: [], listeningRequestStates: {}, activeAiMessageId: null, pausedAiMessageId: null, playedAiMessageIds: new Set(), activeError: null, activeFailedStep: null, silencePromptVisible, activeAssistIsVisible: false, activeAssistState: null, confirmedTranscript: '', interimTranscript: '', partialTranscript: '', recordingSeconds: 0, dockInputMode: 'voice', dockTextValue: '', hintData: { directionZh: '说明', keyPhrasesJa: ['料金'], sentenceStarterJa: '料金は', fullExampleJa: '追加料金はかかりますか？' }, isLoadingHint: false, hintLevel: 4, showHintSheet: sheet, showTranscriptSheet: transcriptSheet, manualInput: false, transcript: { rawText: '原识别文本', cleanedText: '确认文本', finalText: '确认文本' }, showOriginalTranscript: false, inlineError: '测试错误', canConfirmTranscript: true, sttAvailable: true, sttModel: 'scribe', ttsAvailable: true, reviewAudioNotice: notice,
    previousAdvice: previousAdvice ? { expressionImprovement: { turn: 1, userConfirmedJa: 'これをください。', suggestedJa: 'こちらをお願いします。', reasonZh: '更礼貌。' }, sourceSessionId: 'source-session', sourceStartedAt: 1, viewed: false } : undefined,
  } as ActiveSessionModel
  const actions = {
    endSession: vi.fn(), setShowGoalsSheet: vi.fn(), dispatchInterruptionRecovery: vi.fn(), setAppForegroundNotice: vi.fn(), clearVoiceNotice: vi.fn(), getListeningLevel: vi.fn(() => 0), replayPartnerMessage: vi.fn(), advanceListeningScaffold: vi.fn(), setDockInputMode: vi.fn(), startRecording: mocks.startJapanese, enterTextInput: vi.fn(), enterLifecycleTextInput: vi.fn(), updateFinalText: vi.fn(), setDockTextValue: vi.fn(), openTranscriptSheet: () => setTranscriptSheet(true), handleRequestHint: vi.fn().mockResolvedValue(undefined), setShowHintSheet: setSheet, stopRecording: mocks.stopRecording, skipFailedTts: vi.fn(), retryFailedStep: vi.fn(), resetSession: vi.fn(), stopAiPlayback: vi.fn(), releaseAiPlayback: mocks.releaseAi, playReviewAudio: mocks.play, closeTranscriptSheet: () => setTranscriptSheet(false), rerecord: vi.fn(), confirmTranscript: vi.fn(), setInlineError: vi.fn(), toggleOriginalTranscript: vi.fn(), onPreviousAdviceViewed: mocks.adviceViewed,
  } as unknown as ActiveSessionActions
  return createElement(ActiveSession, { model, actions, messageListRef: { current: null }, chatBottomRef: { current: null } })
}

describe('ActiveSession 中文意图录音', () => {
  let root: Root; let container: HTMLDivElement
  beforeEach(() => {
    mocks.handlers = null; mocks.stop.mockReset().mockResolvedValue('想换热茶'); mocks.token.mockReset().mockResolvedValue('token'); mocks.release.mockReset(); mocks.releaseAi.mockReset(); mocks.play.mockReset().mockResolvedValue(undefined); mocks.startJapanese.mockReset().mockResolvedValue(undefined); mocks.stopRecording.mockReset().mockResolvedValue(undefined); mocks.adviceViewed.mockReset()
    mocks.setup.mockReset().mockImplementation(async ({ connectStt }) => { await connectStt('token'); return true })
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); flushSync(() => root.render(createElement(Harness)))
  })
  afterEach(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); flushSync(() => root.unmount()); container.remove(); vi.clearAllMocks() })
  it('确认稿阶段默认显示确认稿，关闭 X 后不会被 phase 强制重新打开', () => {
    flushSync(() => root.unmount()); root = createRoot(container)
    flushSync(() => root.render(createElement(Harness, { phase: 'confirming_transcript', hintVisible: false, transcriptVisible: true })))
    expect(container.querySelector<HTMLTextAreaElement>('#transcript-sheet-input')?.value).toBe('确认文本')
    flushSync(() => container.querySelector<HTMLButtonElement>('[aria-label="关闭转写确认"]')!.click())
    expect(container.querySelector('#transcript-sheet-input')).toBeNull()
  })

  it('确认稿中的怎么说切换到帮助，关闭帮助后可从确认稿入口恢复且保留文本', () => {
    flushSync(() => root.unmount()); root = createRoot(container)
    flushSync(() => root.render(createElement(Harness, { phase: 'confirming_transcript', hintVisible: false, transcriptVisible: true })))
    flushSync(() => click(container, '怎么说').click())
    expect(container.querySelector('#transcript-sheet-input')).toBeNull()
    expect(container.querySelector('.im-hint-intention-field')).not.toBeNull()
    flushSync(() => container.querySelector<HTMLButtonElement>('[aria-label="关闭表达帮助"]')!.click())
    expect(container.querySelector('.im-hint-intention-field')).toBeNull()
    expect(container.textContent).toContain('检查/修改回答内容')
    flushSync(() => click(container, '检查/修改回答内容').click())
    expect(container.querySelector<HTMLTextAreaElement>('#transcript-sheet-input')?.value).toBe('确认文本')
    expect(container.textContent).toContain('测试错误')
  })


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
  it('离线切换会取消中文录音、释放其麦克风并忽略迟到回调', async () => {
    click(container, '中文语音输入').click(); await flush()
    await vi.waitFor(() => expect(click(container, '说完了，返回表达帮助')).toBeDefined(), { interval: 0 })
    flushSync(() => root.render(createElement(Harness, { online: false })))
    await flush()
    expect(mocks.release).toHaveBeenCalledOnce()
    flushSync(() => mocks.handlers?.onPartial('迟到结果'))
    expect(container.querySelector<HTMLTextAreaElement>('.im-hint-intention-field textarea')?.value).toBe('')
    expect(container.textContent).not.toContain('正在连接，取消')
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
    click(container, '开始回答').click()
    expect(mocks.startJapanese).toHaveBeenCalledOnce()
  })

  it('静音提示保留录音停止入口，并由用户主动结束', () => {
    flushSync(() => root.unmount()); root = createRoot(container)
    flushSync(() => root.render(createElement(Harness, { phase: 'recording', silencePromptVisible: true })))
    expect(container.textContent).toContain('停顿中，继续说即可，当前内容已保留')
    expect(container.textContent).toContain('说完了，点击结束')
    expect(container.textContent).not.toContain('秒后自动结束')
    click(container, '说完了，点击结束').click()
    expect(mocks.stopRecording).toHaveBeenCalledOnce()
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

  it('user 开场首轮展示开场引导，而非 AI 消息与听力控件', () => {
    flushSync(() => root.unmount()); root = createRoot(container)
    flushSync(() => root.render(createElement(Harness, { userOpening: true })))
    expect(container.textContent).toContain('轮到你开场')
    expect(container.textContent).toContain('这轮由你先开场')
    expect(container.querySelector('.im-dock-main-btn')?.textContent).toContain('开始开场')
    expect(container.querySelector('.im-message-item.is-ai')).toBeNull()
    expect(container.querySelector('.im-listening-controls')).toBeNull()
  })
})
