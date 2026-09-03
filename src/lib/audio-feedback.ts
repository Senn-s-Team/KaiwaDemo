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

export function shouldWarnSilence(recordingSeconds: number, speechDetected: boolean): boolean {
  return recordingSeconds >= 4 && !speechDetected
}
export const SILENCE_COUNTDOWN_START_SECONDS = 10
export const SILENCE_AUTO_STOP_SECONDS = 13

export function getSilenceCountdownSeconds(
  silentSeconds: number,
  meterAvailable: boolean,
): number | null {
  if (!meterAvailable || !Number.isFinite(silentSeconds)) return null
  if (silentSeconds < SILENCE_COUNTDOWN_START_SECONDS) return null

  return Math.max(0, Math.ceil(SILENCE_AUTO_STOP_SECONDS - silentSeconds))
}
