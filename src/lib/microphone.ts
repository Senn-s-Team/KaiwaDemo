import { microphoneReadinessFromError, requestMicrophoneStream } from './audio-engine'

export type MicrophoneReadiness = 'unknown' | 'requesting' | 'granted' | 'denied' | 'unavailable'

let cachedPermissionStatus: MicrophoneReadiness | null = null

export async function preflightMicrophone(forceRequest = false): Promise<MicrophoneReadiness> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return 'unavailable'
  }

  // 1. 如果此前已被明确拒绝，直接返回 denied
  if (cachedPermissionStatus === 'denied' && !forceRequest) {
    return 'denied'
  }

  // 2. 如果此前已授权且不强制重新取流，返回 granted
  if (cachedPermissionStatus === 'granted' && !forceRequest) {
    return 'granted'
  }

  // 3. 不强制请求硬件时，如果支持 Permissions API 则静默查询；不支持或异常时返回 'unknown'（允许后续用户点击时请求）
  if (!forceRequest) {
    if (typeof navigator.permissions?.query === 'function') {
      try {
        const status = await navigator.permissions.query({ name: 'microphone' as PermissionName })
        if (status.state === 'granted') {
          cachedPermissionStatus = 'granted'
          return 'granted'
        }
        if (status.state === 'denied') {
          cachedPermissionStatus = 'denied'
          return 'denied'
        }
      } catch {
        // iOS Safari 抛出异常是正常现象，忽略
      }
    }
    return cachedPermissionStatus ?? 'unknown'
  }

  // 4. 用户主动手势触发强制请求
  try {
    const stream = await requestMicrophoneStream()
    const [track] = stream.getAudioTracks()
    if (track && track.readyState === 'live') {
      cachedPermissionStatus = 'granted'
      return 'granted'
    }
    return 'unavailable'
  } catch (error) {
    const readiness = microphoneReadinessFromError(error)
    cachedPermissionStatus = readiness
    return readiness
  }
}

export function setCachedMicrophoneReadiness(readiness: MicrophoneReadiness): void {
  cachedPermissionStatus = readiness
}

export { microphoneReadinessFromError }
