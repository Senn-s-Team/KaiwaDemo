/**
 * [INPUT]: 浏览器 localStorage 与用户明确选择
 * [OUTPUT]: 提供技术验证遥测的本地同意偏好；拒绝和撤销均不影响训练
 * [POS]: src/lib 的遥测隐私边界，不与 kaiwa-practice-history 共用存储
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
export type ValidationConsent = 'undecided' | 'accepted' | 'declined'

export const VALIDATION_CONSENT_STORAGE_KEY = 'kaiwa.validation-consent.v1'
export const VALIDATION_CLIENT_ID_STORAGE_KEY = 'kaiwa.validation-client.v1'
let invalidatedClientId: string | null = null

function isValidationConsent(value: unknown): value is ValidationConsent {
  return value === 'undecided' || value === 'accepted' || value === 'declined'
}

export function readValidationConsent(): ValidationConsent {
  try {
    const value = window.localStorage.getItem(VALIDATION_CONSENT_STORAGE_KEY)
    return isValidationConsent(value) ? value : 'undecided'
  } catch {
    return 'undecided'
  }
}

export function writeValidationConsent(consent: ValidationConsent): void {
  try {
    if (consent === 'undecided') window.localStorage.removeItem(VALIDATION_CONSENT_STORAGE_KEY)
    else window.localStorage.setItem(VALIDATION_CONSENT_STORAGE_KEY, consent)
  } catch {
    // Storage denial must never change training availability.
  }
}

export function readValidationClientId(): string | null {
  try {
    const value = window.localStorage.getItem(VALIDATION_CLIENT_ID_STORAGE_KEY)
    return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : null
  } catch {
    return null
  }
}

export function getOrCreateValidationClientId(): string | null {
  const stored = readValidationClientId()
  if (stored && stored !== invalidatedClientId) return stored
  try {
    const clientId = crypto.randomUUID()
    window.localStorage.setItem(VALIDATION_CLIENT_ID_STORAGE_KEY, clientId)
    invalidatedClientId = null
    return clientId
  } catch {
    return null
  }
}

export function clearValidationClientId(): void {
  try {
    invalidatedClientId = window.localStorage.getItem(VALIDATION_CLIENT_ID_STORAGE_KEY)
    window.localStorage.removeItem(VALIDATION_CLIENT_ID_STORAGE_KEY)
  } catch {
    // The captured UUID remains invalid within this page even when removal fails.
  }
}
