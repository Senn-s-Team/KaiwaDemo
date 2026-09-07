/**
 * [INPUT]: 依赖 Web Crypto API、AppPhase 与显式中断恢复事件
 * [OUTPUT]: 对外提供会话标识/五回合推进规则、恢复目标与 affordance API，以及 idle/interrupted/retrying/recovered/failed 纯状态机
 * [POS]: src/lib 的会话核心规则定义，裁决会话推进、外部生命周期中断映射与可观测恢复状态转换，不依赖界面文案
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import type { AppPhase } from '../types'
const assertNever = (value: never): never => {
  throw new Error(`Unhandled AppPhase: ${value}`)
}


export function createSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function createMessageId(turn: number, role: 'assistant' | 'user'): string {
  return `${turn}-${role}-${crypto.randomUUID()}`
}

export function isFinalTurn(turn: number): boolean {
  return turn >= 5
}

export interface SessionAdvanceDecision {
  action: 'complete' | 'advance'
  nextTurn: number | null
}

export function decideNextSessionStep(turn: number): SessionAdvanceDecision {
  if (isFinalTurn(turn)) {
    return { action: 'complete', nextTurn: null }
  }
  return { action: 'advance', nextTurn: turn + 1 }
}

export type InterruptionRecoveryTarget = 'waiting_user' | 'confirming_transcript' | 'stt' | 'llm' | 'tts'
export type InterruptionRecoveryStatus = 'idle' | 'interrupted' | 'retrying' | 'recovered' | 'failed'

export type InterruptionRecoveryState =
  | { status: 'idle'; target: null }
  | { status: 'interrupted'; target: InterruptionRecoveryTarget }
  | { status: 'retrying'; target: InterruptionRecoveryTarget }
  | { status: 'recovered'; target: InterruptionRecoveryTarget }
  | { status: 'failed'; target: InterruptionRecoveryTarget }

export type InterruptionRecoveryEvent =
  | { type: 'interrupted'; target: InterruptionRecoveryTarget }
  | { type: 'retry_started' }
  | { type: 'recovery_succeeded' }
  | { type: 'recovery_failed' }
  | { type: 'reset' }

export const INITIAL_INTERRUPTION_RECOVERY_STATE: InterruptionRecoveryState = {
  status: 'idle',
  target: null,
}

export function reduceInterruptionRecovery(
  state: InterruptionRecoveryState,
  event: InterruptionRecoveryEvent,
): InterruptionRecoveryState {
  if (event.type === 'reset') return INITIAL_INTERRUPTION_RECOVERY_STATE
  if (event.type === 'interrupted') {
    return { status: 'interrupted', target: event.target }
  }

  switch (state.status) {
    case 'idle':
    case 'recovered':
      return state
    case 'interrupted':
    case 'failed':
      return event.type === 'retry_started'
        ? { status: 'retrying', target: state.target }
        : state
    case 'retrying':
      if (event.type === 'recovery_succeeded') {
        return { status: 'recovered', target: state.target }
      }
      if (event.type === 'recovery_failed') {
        return { status: 'failed', target: state.target }
      }
      return state
    default:
      return assertNever(state)
  }
}

export interface InterruptionRecoveryActions {
  waitingUser: () => void
  confirmingTranscript: () => void
  stt: () => Promise<void>
  llm: () => Promise<void>
  tts: () => Promise<void>
}

export interface InterruptionRecoveryAffordances {
  retry: boolean
  textInput: boolean
}

export function decideInterruptionRecoveryAffordances(
  target: InterruptionRecoveryTarget | null,
): InterruptionRecoveryAffordances {
  if (target === 'stt') return { retry: true, textInput: true }
  if (target === null) return { retry: false, textInput: false }
  return { retry: true, textInput: false }
}


export function decideInterruptionRecovery(phase: AppPhase): InterruptionRecoveryTarget | null {
  switch (phase) {
    case 'waiting_user':
    case 'round_complete':
      return 'waiting_user'
    case 'confirming_transcript':
      return 'confirming_transcript'
    case 'fetching_token':
    case 'connecting_stt':
    case 'recording':
    case 'finalizing_transcript':
      return 'stt'
    case 'requesting_llm':
      return 'llm'
    case 'preparing_tts':
    case 'playing_ai':
      return 'tts'
    case 'loading_config':
    case 'idle':
    case 'session_complete':
    case 'error':
      return null
    default:
      return assertNever(phase)
  }
}

export async function executeInterruptionRecovery(
  target: InterruptionRecoveryTarget,
  actions: InterruptionRecoveryActions,
): Promise<void> {
  switch (target) {
    case 'waiting_user':
      actions.waitingUser()
      return
    case 'confirming_transcript':
      actions.confirmingTranscript()
      return
    case 'stt':
      await actions.stt()
      return
    case 'llm':
      await actions.llm()
      return
    case 'tts':
      await actions.tts()
  }
}
