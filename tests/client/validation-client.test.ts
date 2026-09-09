/**
 * [INPUT]: 浏览器 localStorage 可用与拒绝两种状态
 * [OUTPUT]: 锁定匿名客户端 ID 存储与生成边界
 * [POS]: tests/client 的遥测本地匿名身份契约
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VALIDATION_CLIENT_ID_STORAGE_KEY, getOrCreateValidationClientId, readValidationClientId } from '../../src/lib/validation-client'

afterEach(() => {
  window.localStorage.clear()
  vi.restoreAllMocks()
})

describe('validation client identifier', () => {
  it('keeps only a locally generated anonymous UUID', () => {
    const clientId = getOrCreateValidationClientId()
    expect(clientId).toMatch(/^[0-9a-f-]{36}$/i)
    expect(getOrCreateValidationClientId()).toBe(clientId)
    expect(readValidationClientId()).toBe(clientId)
  })
  it('treats storage denial as unavailable and never throws into training', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    expect(readValidationClientId()).toBeNull()
    expect(() => getOrCreateValidationClientId()).not.toThrow()
  })
  it('stores the identifier under the dedicated telemetry key', () => {
    const clientId = getOrCreateValidationClientId()
    expect(window.localStorage.getItem(VALIDATION_CLIENT_ID_STORAGE_KEY)).toBe(clientId)
  })
})
