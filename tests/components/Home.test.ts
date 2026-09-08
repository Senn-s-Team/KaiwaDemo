/**
 * [INPUT]: Home 组件、可控 STT 生命周期和可控润色请求
 * [OUTPUT]: 验证实时转写、录音释放、润色代际、手编撤回及生成互斥
 * [POS]: tests/components 的首页语音输入挂载回归
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
// @vitest-environment jsdom
import { createElement, useState } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  events: [] as string[],
  handlers: null as null | { onPartial: (text: string) => void; onConnectionState: (state: 'connecting' | 'connected' | 'closed') => void; onAudioLevel: (level: number) => void },
  stop: vi.fn<() => Promise<string>>(), polish: vi.fn<(text: string, signal?: AbortSignal) => Promise<string>>(), token: vi.fn<() => Promise<string>>(), release: vi.fn(),
}))
vi.mock('../../src/lib/api', () => ({ requestElevenLabsToken: mocks.token, polishScenarioText: mocks.polish }))
vi.mock('../../src/lib/audio-engine', () => ({ releaseMicrophoneStream: mocks.release, shouldTeardownOnVisibility: () => true }))
vi.mock('../../src/lib/recording-setup', () => ({ coordinateRecordingSetup: async (options: { acquireToken: () => Promise<string>; connectStt: (token: string) => Promise<void> }) => { mocks.events.push('microphone'); await options.connectStt(await options.acquireToken()); return true } }))
vi.mock('../../src/lib/stt', () => ({ RealtimeSttSession: class { async start(_token: string, _model: string, handlers: typeof mocks.handlers): Promise<void> { mocks.handlers = handlers; handlers?.onConnectionState('connected') } stop = mocks.stop; close(): void { mocks.events.push('close') } } }))

import { Home } from '../../src/components/Home'

const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (reason?: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
function props(setCustomInputZh: React.Dispatch<React.SetStateAction<string>>, customInputZh: string, onDraftScenario = vi.fn()): React.ComponentProps<typeof Home> { return { loading: false, ready: true, online: true, error: null, sttAvailable: true, sttModel: 'scribe', customInputZh, setCustomInputZh, clarifications: [], pendingClarification: null, readyScenarioData: null, isDraftingScenario: false, onDraftScenario, onAnswerClarification: vi.fn(), onStartDynamic: vi.fn(), onResetCustom: vi.fn(), recentPractices: [], practiceHistory: [], historyNotice: '', historySaving: false, onPreparePractice: vi.fn(), onRemovePractice: vi.fn(), draftState: { status: 'idle', request: null, result: null, error: null, storageNotice: '' }, onRetryDraftTransport: vi.fn(), onInputEdited: vi.fn() } }
function Harness({ initial = '预约理发', onDraftScenario }: { initial?: string; onDraftScenario?: ReturnType<typeof vi.fn> }): React.JSX.Element { const [value, setValue] = useState(initial); return createElement(Home, props(setValue, value, onDraftScenario)) }
const flush = async () => { await Promise.resolve(); await Promise.resolve() }
const button = (box: HTMLElement, copy: string) => Array.from(box.querySelectorAll('button')).find((item) => item.textContent?.includes(copy)) as HTMLButtonElement
const textarea = (box: HTMLElement) => box.querySelector<HTMLTextAreaElement>('#custom-topic-input')!

describe('Home realtime STT', () => {
  let root: Root; let container: HTMLDivElement
  beforeEach(() => { mocks.events.length = 0; mocks.handlers = null; mocks.stop.mockReset().mockResolvedValue('我想剪短一点'); mocks.polish.mockReset().mockResolvedValue('请帮我剪短一点'); mocks.token.mockReset().mockResolvedValue('token'); mocks.release.mockReset(); container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); flushSync(() => root.render(createElement(Harness))) })
  afterEach(() => { flushSync(() => root.unmount()); container.remove(); vi.clearAllMocks() })
  async function startAndStop(final = '我想剪短一点') { mocks.stop.mockResolvedValue(final); button(container, '中文语音输入').click(); await flush(); flushSync(() => mocks.handlers?.onPartial('我想剪短')); expect(textarea(container).value).toBe('预约理发\n我想剪短'); button(container, '说完了').click(); await vi.waitFor(() => expect(mocks.polish).toHaveBeenCalled(), { interval: 0 }) }

  it('partial 基于录音前草稿覆盖，final 先释放录音再等待润色', async () => { const polish = deferred<string>(); mocks.polish.mockReturnValue(polish.promise); await startAndStop(); await vi.waitFor(() => expect(container.textContent).toContain('正在润色'), { interval: 0 }); expect(textarea(container).value).toBe('预约理发\n我想剪短一点'); expect(mocks.events).toContain('close'); expect(mocks.release).toHaveBeenCalledOnce(); polish.resolve('请帮我剪短一点'); await vi.waitFor(() => expect(textarea(container).value).toBe('预约理发\n请帮我剪短一点'), { interval: 0 }); expect(button(container, '撤回润色')).toBeDefined() })
  it('润色失败保留最终识别文本并显示友好中文', async () => { mocks.polish.mockRejectedValue(new Error('network')); await startAndStop(); await flush(); expect(textarea(container).value).toBe('预约理发\n我想剪短一点'); expect(container.textContent).toContain('润色暂时失败，已保留原识别内容。') })
  it('跳过润色后手动编辑，迟到结果不能覆盖当前输入', async () => { const polish = deferred<string>(); mocks.polish.mockReturnValue(polish.promise); await startAndStop(); await vi.waitFor(() => expect(button(container, '跳过润色')).toBeDefined(), { interval: 0 }); button(container, '跳过润色').click(); const input = textarea(container); const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!; setter.call(input, '手动编辑后的场景'); input.dispatchEvent(new Event('input', { bubbles: true })); await vi.waitFor(() => expect(textarea(container).value).toBe('手动编辑后的场景'), { interval: 0 }); polish.resolve('迟到的润色'); await flush(); expect(textarea(container).value).toBe('手动编辑后的场景') })
  it('跳过后启动新录音，旧润色 finally 不会重置新录音', async () => { const polish = deferred<string>(); mocks.polish.mockReturnValueOnce(polish.promise).mockResolvedValueOnce('第二次润色'); await startAndStop(); await vi.waitFor(() => expect(button(container, '跳过润色')).toBeDefined(), { interval: 0 }); button(container, '跳过润色').click(); await vi.waitFor(() => expect(button(container, '中文语音输入')).toBeDefined(), { interval: 0 }); button(container, '中文语音输入').click(); await vi.waitFor(() => expect(container.textContent).toContain('说完了'), { interval: 0 }); polish.resolve('旧润色'); await flush(); expect(container.textContent).toContain('说完了') })
  it('后台取消录音，300 字上限保留已存在内容', async () => { flushSync(() => root.unmount()); root = createRoot(container); flushSync(() => root.render(createElement(Harness, { initial: '甲'.repeat(299) }))); button(container, '中文语音输入').click(); await flush(); flushSync(() => mocks.handlers?.onPartial('超过')); expect(textarea(container).value).toBe('甲'.repeat(299)); expect(container.textContent).toContain('输入框已接近 300 字'); Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); await flush(); expect(mocks.release).toHaveBeenCalled() })
  it('录音期间不能提交生成', async () => { const onDraftScenario = vi.fn(); flushSync(() => root.unmount()); root = createRoot(container); flushSync(() => root.render(createElement(Harness, { onDraftScenario }))); button(container, '中文语音输入').click(); await flush(); container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); expect(onDraftScenario).not.toHaveBeenCalled() })
  it('点击场景例子直接准备，并保留开始对话前的准备阶段', async () => {
    const onDraftScenario = vi.fn()
    flushSync(() => root.unmount()); root = createRoot(container)
    flushSync(() => root.render(createElement(Harness, { onDraftScenario })))
    const example = container.querySelector<HTMLButtonElement>('.practice-example')!
    expect(example).toBeDefined()
    example.click()
    await flush()
    expect(onDraftScenario).toHaveBeenCalledOnce()
    expect(onDraftScenario.mock.calls[0]?.[0]).toMatch(/理发|剪|头发/)
  })
})
