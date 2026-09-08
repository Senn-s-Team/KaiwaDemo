/**
 * [INPUT]: 录音时长、麦克风电平与静音时长、计量可用性
 * [OUTPUT]: 提供录音反馈格式化、音量格数与非阻断静音保全提示纯规则
 * [POS]: src/lib 的录音反馈纯规则边界，不拥有录音生命周期或停止决策
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
export function formatRecordingTime(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(safeSeconds / 60)
  const remainder = safeSeconds % 60
  return `${minutes.toString().padStart(2, '0')}:${remainder.toString().padStart(2, '0')}`
}

export function microphoneLevelToBars(level: number, barCount = 7): number {
  if (!Number.isFinite(level) || level <= 0) return 0
  return Math.min(barCount, Math.max(1, Math.ceil(level * barCount)))
}

// 静音判定与软提示策略：
// - 以 STT 实时转写事件（lastTextAtRef）为主驱动（语义级）
// - 麦克风能量达标事件（lastVoiceAtRef）为辅助兜底
export function shouldWarnSilence(recordingSeconds: number, speechDetected: boolean): boolean {
  return recordingSeconds >= 4 && !speechDetected
}

export const SILENCE_PROMPT_SECONDS = 10

export function shouldShowSilencePrompt(silentSeconds: number, meterAvailable: boolean): boolean {
  return meterAvailable && Number.isFinite(silentSeconds) && silentSeconds >= SILENCE_PROMPT_SECONDS
}
