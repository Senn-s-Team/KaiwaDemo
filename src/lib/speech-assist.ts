/**
 * [INPUT]: 依赖录音状态、转写版本与语音活动时间等前端可观测信号
 * [OUTPUT]: 对外提供语音续说辅助触发阈值、日语字符计数、请求触发与迟到结果显示守卫
 * [POS]: src/lib 的实时语音辅助纯规则模块，不持有网络、录音或界面副作用
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
export const ASSIST_TIMING = {
  minJapaneseChars: 6,
  trailingSilenceMs: 900,
  minPartialQuietMs: 350,
  minRequestIntervalMs: 2500,
  timeoutMs: 1500,
} as const

export function countJapaneseCharacters(text: string): number {
  return text.match(/[\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf\uff66-\uff9f]/gu)?.length ?? 0
}

export interface ShouldTriggerSpeechAssistParams {
  isRecording: boolean
  transcript: string
  timeSinceLastSpeechSoundMs: number
  timeSinceLastPartialMs: number
  timeSinceLastRequestMs: number
  inFlight: boolean
  currentVersion: number
  lastAssistedVersion: number
}

export function shouldTriggerSpeechAssist({
  isRecording,
  transcript,
  timeSinceLastSpeechSoundMs,
  timeSinceLastPartialMs,
  timeSinceLastRequestMs,
  inFlight,
  currentVersion,
  lastAssistedVersion,
}: ShouldTriggerSpeechAssistParams): boolean {
  if (!isRecording) return false
  if (inFlight) return false
  if (currentVersion <= 0 || currentVersion === lastAssistedVersion) return false
  if (countJapaneseCharacters(transcript) < ASSIST_TIMING.minJapaneseChars) return false
  if (timeSinceLastSpeechSoundMs < ASSIST_TIMING.trailingSilenceMs) return false
  if (timeSinceLastPartialMs < ASSIST_TIMING.minPartialQuietMs) return false
  if (timeSinceLastRequestMs < ASSIST_TIMING.minRequestIntervalMs) return false
  return true
}

export interface ActiveSpeechAssistState {
  version: number
  observedTextJa: string
  cleanedObservedTextJa: string
  continuationSuggestionJa: string | null
}

export interface ShouldDisplaySpeechAssistResultParams {
  isRecording: boolean
  requestVersion: number
  currentVersion: number
  isAborted: boolean
  timeSinceLastSpeechSoundMs: number
  trailingSilenceMsThreshold?: number
}

export function shouldDisplaySpeechAssistResult({
  isRecording,
  requestVersion,
  currentVersion,
  isAborted,
  timeSinceLastSpeechSoundMs,
  trailingSilenceMsThreshold = ASSIST_TIMING.trailingSilenceMs,
}: ShouldDisplaySpeechAssistResultParams): boolean {
  if (!isRecording) return false
  if (isAborted) return false
  if (requestVersion <= 0 || requestVersion !== currentVersion) return false
  if (timeSinceLastSpeechSoundMs < trailingSilenceMsThreshold) return false
  return true
}
