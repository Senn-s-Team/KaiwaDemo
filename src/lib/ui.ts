/**
 * [INPUT]: 依赖 ./api 的 ApiError、./stt 的 SttError、./tts 的 TtsError、../types 的 UiError
 * [OUTPUT]: 对外提供 formatDuration、formatClock、scenarioDraftErrorMessage 与 toUiError 错误归一化纯函数
 * [POS]: src/lib 的界面错误呈现与时间格式化工具，将各引擎与 API 底层错误映射为不泄露服务端正文、具有明确引导和恢复动作的 UiError
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import type { ApiError } from './api'
import type { SttError } from './stt'
import type { TtsError } from './tts'
import type { UiError } from '../types'

export function formatDuration(milliseconds: number | null): string {
  if (milliseconds === null) return '未记录'
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`
  return `${(milliseconds / 1_000).toFixed(2)} s`
}

export function formatClock(timestamp: number | null): string {
  if (timestamp === null) return '未记录'
  return new Date(timestamp).toLocaleTimeString('zh-CN', { hour12: false })
}
export function scenarioDraftErrorMessage(code: string): string {
  if (code === 'scenario_draft_request_timeout') return '场景准备时间比预期更久，请重新准备。'
  if (code === 'scenario_draft_request_failed' || code === 'workflow_unavailable' || code === 'workflow_unconfigured') {
    return '场景服务暂时不可用，请稍后重新准备。'
  }
  if (code === 'scenario_draft_model_invalid' || code === 'scenario_draft_schema_invalid' || code === 'scenario_draft_invalid_result') {
    return '场景服务返回的数据无效，请重新准备。'
  }
  if (code === 'scenario_draft_unavailable' || code === 'scenario_draft_missing') return '这份场景草稿已不可用，请重新准备。'
  return '场景准备失败，请重新准备。'
}


export function toUiError(error: unknown): UiError {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    const code = error.code
    if (code === 'no_speech_detected') {
      return {
        code,
        title: '没有识别到有效语音',
        message: '刚才没有收到清晰的声音。请重新录制，或改用文字回答。',
        recovery: 'text_input',
      }
    }
    if (code === 'permission_denied' || code === 'device_missing') {
      return { code, title: '无法使用麦克风', message: '请允许麦克风权限，或改用文字回答。', recovery: 'text_input' }
    }
    if (code.includes('stt') || code === 'connection_failed' || code === 'finalize_timeout') {
      return { code, title: '听写连接已中断', message: '这次回答没有完整记录。可以重新录制，或改用文字回答。', recovery: 'text_input' }
    }
    if (
      code.includes('tts') ||
      code === 'voice_missing' ||
      code === 'payment_required' ||
      code === 'playback_blocked' ||
      code === 'generation_failed' ||
      code === 'network'
    ) {
      return { code, title: '相手语音未完成', message: '暂时无法播放相手语音。可以显示文字继续。', recovery: 'skip_tts' }
    }
    if (code.includes('scenario_draft') || code.includes('draft')) {
      return { code, title: '场景设计失败', message: scenarioDraftErrorMessage(code), recovery: 'retry' }
    }
    if (code.includes('openai') || code.includes('model') || code.includes('stream')) {
      return { code, title: '相手暂时没有回复', message: '请重试当前步骤。', recovery: 'retry' }
    }
    if (code.includes('token') || code.includes('auth')) {
      return { code, title: '连接已过期', message: '请重试当前步骤。', recovery: 'retry' }
    }
  }
  return {
    code: 'unknown_error',
    title: '当前步骤未完成',
    message: '请重试当前步骤，或重新开始练习。',
    recovery: 'retry',
  }
}

export type KnownIntegrationError = ApiError | SttError | TtsError
