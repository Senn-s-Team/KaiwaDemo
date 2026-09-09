/**
 * [INPUT]: 前端 AppPhase 领域类型
 * [OUTPUT]: 提供根编排使用的合法阶段迁移与恢复提示
 * [POS]: src/lib 的纯 App 阶段规则，不拥有 React 或会话副作用
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import type { AppPhase } from '../types'

export const PHASE_TRANSITIONS: Record<AppPhase, readonly AppPhase[]> = {
  loading_config: ['idle', 'preparing_tts', 'error'], idle: ['loading_config', 'error'], fetching_token: ['connecting_stt', 'recording', 'confirming_transcript', 'error', 'session_complete'], connecting_stt: ['recording', 'confirming_transcript', 'error', 'session_complete'], waiting_user: ['recording', 'fetching_token', 'connecting_stt', 'confirming_transcript', 'preparing_tts', 'error', 'session_complete'], recording: ['finalizing_transcript', 'confirming_transcript', 'waiting_user', 'error', 'session_complete'], finalizing_transcript: ['confirming_transcript', 'waiting_user', 'error', 'session_complete'], confirming_transcript: ['waiting_user', 'recording', 'fetching_token', 'requesting_llm', 'error', 'session_complete'], requesting_llm: ['preparing_tts', 'waiting_user', 'error', 'session_complete'], preparing_tts: ['playing_ai', 'waiting_user', 'error', 'session_complete'], playing_ai: ['waiting_user', 'error', 'session_complete'], round_complete: ['waiting_user', 'recording', 'fetching_token', 'session_complete', 'error'], session_complete: ['loading_config', 'idle', 'error'], error: ['loading_config', 'idle', 'fetching_token', 'connecting_stt', 'waiting_user', 'recording', 'confirming_transcript', 'requesting_llm', 'preparing_tts', 'session_complete'],
}

export function recoveryStatusText(status: 'idle' | 'interrupted' | 'retrying' | 'recovered' | 'failed'): string {
  if (status === 'interrupted') return '当前步骤已中断，请选择重试或安全回退。'
  if (status === 'retrying') return '正在重新建立当前步骤，请稍候。'
  return status === 'failed' ? '恢复当前步骤失败，请重试或改用文字回答。' : ''
}
