/**
 * [INPUT]: 依赖 ./audio-engine 的 requestMicrophoneStream 与 microphoneReadinessFromError
 * [OUTPUT]: 对外提供 MicrophoneReadiness 类型、queryMicrophonePermission、preflightMicrophone、setCachedMicrophoneReadiness、microphoneReadinessFromError
 * [POS]: src/lib 的麦克风权限抽象层，封装 Permissions API 授权状态同步与内存缓存，静默反映 granted/denied/unknown 状态
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { microphoneReadinessFromError, requestMicrophoneStream } from './audio-engine'

export type MicrophoneReadiness = 'unknown' | 'requesting' | 'granted' | 'denied' | 'unavailable'

let cachedPermissionStatus: MicrophoneReadiness | null = null

export async function queryMicrophonePermission(): Promise<MicrophoneReadiness> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return 'unavailable'
  }
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
      return 'unknown'
    } catch {
      // 部分浏览器（如 iOS Safari / Firefox）对 microphone query 抛 TypeError，属于已知未实现行为，安全回退
    }
  }
  return cachedPermissionStatus ?? 'unknown'
}

export async function preflightMicrophone(forceRequest = false): Promise<MicrophoneReadiness> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return 'unavailable'
  }

  // 1. 不申请硬件时，优先读取浏览器当前授权，避免以旧缓存覆盖用户刚刚变更的设置。
  if (!forceRequest) {
    return queryMicrophonePermission()
  }

  // 2. 用户主动手势触发取流；requestMicrophoneStream 会在真正申请前再次检查当前权限。
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
