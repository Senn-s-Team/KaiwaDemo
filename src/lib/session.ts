export function createSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function createMessageId(turn: number, role: 'assistant' | 'user'): string {
  return `${turn}-${role}-${crypto.randomUUID()}`
}
