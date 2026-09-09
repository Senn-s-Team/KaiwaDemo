/**
 * [INPUT]: 浏览器 localStorage 与匿名客户端标识生成
 * [OUTPUT]: 提供技术验证遥测的本地匿名客户端 UUID
 * [POS]: src/lib 的遥测身份边界，不与 kaiwa-practice-history 共用存储
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */

export const VALIDATION_CLIENT_ID_STORAGE_KEY = 'kaiwa.validation-client.v1'

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

export function readValidationClientId(): string | null {
  try {
    const value = window.localStorage.getItem(VALIDATION_CLIENT_ID_STORAGE_KEY)
    return isUuid(value) ? value : null
  } catch {
    return null
  }
}

export function getOrCreateValidationClientId(): string | null {
  const stored = readValidationClientId()
  if (stored) return stored
  try {
    const clientId = crypto.randomUUID()
    window.localStorage.setItem(VALIDATION_CLIENT_ID_STORAGE_KEY, clientId)
    return clientId
  } catch {
    return null
  }
}
