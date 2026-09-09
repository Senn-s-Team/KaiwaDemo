/**
 * [INPUT]: ValidationConsent 的三态 props 与用户操作
 * [OUTPUT]: 锁定明确选择、原生隐私详情与撤销可访问交互
 * [POS]: tests/components 的遥测同意界面契约
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
// @vitest-environment jsdom
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ValidationConsent } from '../../src/components/ValidationConsent'

describe('ValidationConsent', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    root.unmount()
    container.remove()
  })

  it('offers explicit keyboard-reachable choices and native privacy details when undecided', () => {
    const onDecision = vi.fn()
    flushSync(() => root.render(createElement(ValidationConsent, { consent: 'undecided', onDecision, onRevoke: vi.fn() })))
    const buttons = Array.from(container.querySelectorAll('button'))
    expect(buttons.map((button) => button.textContent)).toEqual(['暂不参与', '同意参与'])
    expect(container.querySelector('details summary')?.textContent).toBe('查看隐私说明')
    buttons[1]?.click()
    expect(onDecision).toHaveBeenCalledWith('accepted')
  })

  it('discloses retention and the local scope of revocation', () => {
    flushSync(() => root.render(createElement(ValidationConsent, { consent: 'undecided', onDecision: vi.fn(), onRevoke: vi.fn() })))
    const details = container.querySelector('details')
    expect(details?.textContent).toContain('180 天')
    expect(details?.textContent).toContain('365 天')
    expect(details?.textContent).toContain('不会删除已送达记录')
    expect(details?.textContent).toContain('payload 没有 IP 字段')
    expect(details?.textContent).toContain('Cloudflare 网络日志')
  })

  it('provides an explicit revocation control only after consent', () => {
    const onRevoke = vi.fn()
    flushSync(() => root.render(createElement(ValidationConsent, { consent: 'accepted', onDecision: vi.fn(), onRevoke })))
    const button = container.querySelector<HTMLButtonElement>('button')
    expect(button?.textContent).toBe('撤销同意')
    button?.click()
    expect(onRevoke).toHaveBeenCalledOnce()
  })

  it('does not render a telemetry prompt after declining', () => {
    flushSync(() => root.render(createElement(ValidationConsent, { consent: 'declined', onDecision: vi.fn(), onRevoke: vi.fn() })))
    expect(container.textContent).toBe('')
  })
})
