/**
 * [INPUT]: 浏览器 localStorage 可用与拒绝两种状态
 * [OUTPUT]: 锁定遥测同意的三态、存储拒绝降级与匿名客户端 ID 边界
 * [POS]: tests/client 的遥测本地隐私偏好契约
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VALIDATION_CLIENT_ID_STORAGE_KEY, VALIDATION_CONSENT_STORAGE_KEY, clearValidationClientId, getOrCreateValidationClientId, readValidationConsent, writeValidationConsent } from '../../src/lib/validation-consent'

afterEach(() => {
  window.localStorage.clear()
  vi.restoreAllMocks()
})

describe('validation consent', () => {
  it('defaults to undecided and persists explicit accepted or declined choices', () => {
    expect(readValidationConsent()).toBe('undecided')
    writeValidationConsent('accepted')
    expect(readValidationConsent()).toBe('accepted')
    writeValidationConsent('declined')
    expect(readValidationConsent()).toBe('declined')
    writeValidationConsent('undecided')
    expect(window.localStorage.getItem(VALIDATION_CONSENT_STORAGE_KEY)).toBeNull()
  })

  it('treats storage denial as undecided and never throws into training', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    expect(readValidationConsent()).toBe('undecided')
    expect(() => writeValidationConsent('accepted')).not.toThrow()
  })

  it('keeps only a locally generated anonymous UUID, not training content', () => {
    const clientId = getOrCreateValidationClientId()
    expect(clientId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(getOrCreateValidationClientId()).toBe(clientId)
    expect(window.localStorage.getItem(VALIDATION_CLIENT_ID_STORAGE_KEY)).toBe(clientId)
  })

  it('removes the anonymous client UUID when consent is revoked', () => {
    getOrCreateValidationClientId()
    clearValidationClientId()
    expect(window.localStorage.getItem(VALIDATION_CLIENT_ID_STORAGE_KEY)).toBeNull()
  })

  it('never reuses a client UUID whose storage deletion failed', () => {
    const stale = getOrCreateValidationClientId()
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('denied') })
    clearValidationClientId()
    removeItem.mockRestore()
    expect(getOrCreateValidationClientId()).not.toBe(stale)
  })
})
