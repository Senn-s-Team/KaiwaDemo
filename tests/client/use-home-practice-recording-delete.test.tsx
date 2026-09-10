/**
 * [INPUT]: useHomePractice、练习历史删除与关联录音删除替身
 * [OUTPUT]: 锁定关联录音优先删除，失败时保留历史记录的顺序契约
 * [POS]: tests/client 的首页本机录音关联删除回归
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
// @vitest-environment jsdom
import { createElement, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ deletePractice: vi.fn<() => Promise<void>>(), deleteVoice: vi.fn<() => Promise<void>>() }))
vi.mock('../../src/lib/practice-history', () => ({
  listPracticeAttempts: vi.fn(async () => [{ scenarioKey: 'key', scenario: { titleZh: '场景' }, report: { sessionId: 'session' } }]),
  savePracticeAttempt: vi.fn(), deletePracticeScenario: mocks.deletePractice,
}))
vi.mock('../../src/lib/voice-recordings', () => ({ deleteVoiceRecordingsForSessions: mocks.deleteVoice }))
vi.mock('../../src/lib/scenario-draft-task', () => ({ useScenarioDraftRecovery: () => ({ state: {}, submit: vi.fn(), discard: vi.fn(), retryTransport: vi.fn() }) }))
vi.mock('../../src/lib/home-practice-recovery', () => ({ clearPreparedRestart: vi.fn(), readPreparedRestart: () => null, writePreparedRestart: vi.fn() }))

import { useHomePractice } from '../../src/lib/use-home-practice'

function Harness({ expose }: { expose: (remove: () => Promise<void>) => void }): React.JSX.Element {
  const practice = useHomePractice({ online: true, activeSession: false, resetSession: () => undefined, setUiError: () => undefined })
  useEffect(() => {
    const attempt = practice.model.practiceHistory[0]
    if (attempt) expose(() => practice.actions.removePractice(attempt))
  }, [expose, practice.actions, practice.model.practiceHistory])
  return createElement('div')
}

describe('首页历史与录音关联删除', () => {
  let container: HTMLDivElement
  beforeEach(() => { container = document.createElement('div'); document.body.append(container); vi.stubGlobal('confirm', () => true); mocks.deletePractice.mockReset().mockResolvedValue(undefined); mocks.deleteVoice.mockReset().mockResolvedValue(undefined) })
  afterEach(() => { container.remove(); vi.unstubAllGlobals(); vi.clearAllMocks() })
  it('录音删除失败时不删除练习历史', async () => {
    mocks.deleteVoice.mockRejectedValueOnce(new Error('audio failed'))
    let remove: (() => Promise<void>) | undefined
    const root = createRoot(container)
    flushSync(() => root.render(createElement(Harness, { expose: (action) => { remove = action } })))
    await vi.waitFor(() => expect(remove).toBeDefined(), { interval: 0 })
    await remove?.()
    expect(mocks.deleteVoice).toHaveBeenCalledOnce()
    expect(mocks.deletePractice).not.toHaveBeenCalled()
    root.unmount()
  })
  it('成功时先删录音再删练习历史', async () => {
    const calls: string[] = []
    mocks.deleteVoice.mockImplementation(async () => { calls.push('voice') })
    mocks.deletePractice.mockImplementation(async () => { calls.push('practice') })
    let remove: (() => Promise<void>) | undefined
    const root = createRoot(container)
    flushSync(() => root.render(createElement(Harness, { expose: (action) => { remove = action } })))
    await vi.waitFor(() => expect(remove).toBeDefined(), { interval: 0 })
    await remove?.()
    expect(mocks.deleteVoice).toHaveBeenCalledOnce()
    expect(mocks.deletePractice).toHaveBeenCalledOnce()
    expect(calls).toEqual(['voice', 'practice'])
    root.unmount()
  })
})
