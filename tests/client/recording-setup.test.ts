/**
 * [INPUT]: 真实录音协调器、受控麦克风 promise 与 Token/连接 stub
 * [OUTPUT]: 锁定共享麦克风并发准备、连接失败回收及本机录音回调契约
 * [POS]: tests/client 的录音准备深模块回归契约
 * [PROTOCOL]: 变更时更新此头部,然后检查 AGENTS.md
 */

import { describe, expect, it } from 'vitest'
import { releaseMicrophoneStream, requestMicrophoneStream } from '../../src/lib/audio-engine'
import { coordinateRecordingSetup } from '../../src/lib/recording-setup'

describe('coordinateRecordingSetup deep module', () => {
  it('并发启动麦克风与 Token 获取，并在二者成功后建立 STT 连接', async () => {
    const originalNavigatorDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    releaseMicrophoneStream()

    let gumCalls = 0
    const micGate = Promise.withResolvers<{
      active: boolean
      getAudioTracks: () => Array<{ readyState: string; enabled: boolean; muted: boolean; stop: () => void }>
      getTracks: () => Array<{ stop: () => void }>
    }>()

    const mockTrack = {
      readyState: 'live',
      enabled: true,
      muted: false,
      stop: () => undefined,
    }

    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      writable: true,
      value: {
        mediaDevices: {
          getUserMedia: async () => {
            gumCalls += 1
            return micGate.promise
          },
        },
      },
    })

    const tokenGate = Promise.withResolvers<string>()
    let tokenAcquireCalls = 0
    let connectedToken = ''
    const setupEvents: string[] = []

    try {
      const setupPromise = coordinateRecordingSetup({
        acquireToken: async () => {
          tokenAcquireCalls += 1
          return tokenGate.promise
        },
        connectStt: async (tok) => {
          setupEvents.push('stt')
          connectedToken = tok
        },
        onMicrophoneStream: () => {
          setupEvents.push('microphone')
        },
      })

      // 验证麦克风与 Token 请求并发发出
      expect(gumCalls).toBe(1)
      expect(tokenAcquireCalls).toBe(1)
      expect(connectedToken).toBe('')

      // resolve 二者
      micGate.resolve({
        active: true,
        getAudioTracks: () => [mockTrack],
        getTracks: () => [mockTrack],
      })
      tokenGate.resolve('valid_token_xyz')

      const isLive = await setupPromise
      expect(isLive).toBe(true)
      expect(setupEvents).toEqual(['microphone', 'stt'])
      expect(connectedToken).toBe('valid_token_xyz')
    } finally {
      releaseMicrophoneStream()
      if (originalNavigatorDesc) {
        Object.defineProperty(globalThis, 'navigator', originalNavigatorDesc)
      } else {
        Reflect.deleteProperty(globalThis, 'navigator')
      }
    }
  })

  it('Token 先失败且 mic pending：抛出原始错误，迟到的麦克风流被 stop 且不可复用', async () => {
    const originalNavigatorDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    releaseMicrophoneStream()

    let trackStopped = false
    const micGate = Promise.withResolvers<{
      active: boolean
      getAudioTracks: () => Array<{ readyState: string; enabled: boolean; muted: boolean; stop: () => void }>
      getTracks: () => Array<{ stop: () => void }>
    }>()

    const mockTrack = {
      readyState: 'live',
      enabled: true,
      muted: false,
      stop: () => {
        trackStopped = true
      },
    }

    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      writable: true,
      value: {
        mediaDevices: {
          getUserMedia: () => micGate.promise,
        },
      },
    })

    try {
      const setupPromise = coordinateRecordingSetup({
        acquireToken: async () => {
          throw new Error('Network error: 401 Unauthorized')
        },
        connectStt: async () => undefined,
      })

      await expect(setupPromise).rejects.toThrow('Network error: 401 Unauthorized')

      // 迟到的麦克风流 resolve
      micGate.resolve({
        active: true,
        getAudioTracks: () => [mockTrack],
        getTracks: () => [mockTrack],
      })

      // 稍作微任务刷新，确保迟到流被作废并停止
      await Promise.resolve()
      expect(trackStopped).toBe(true)

      // 验证全局共享池未被污染，后续重新调用 getUserMedia
      let secondGumCalled = false
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        writable: true,
        value: {
          mediaDevices: {
            getUserMedia: async () => {
              secondGumCalled = true
              return {
                active: true,
                getAudioTracks: () => [mockTrack],
                getTracks: () => [mockTrack],
              }
            },
          },
        },
      })
      await requestMicrophoneStream()
      expect(secondGumCalled).toBe(true)
    } finally {
      releaseMicrophoneStream()
      if (originalNavigatorDesc) {
        Object.defineProperty(globalThis, 'navigator', originalNavigatorDesc)
      } else {
        Reflect.deleteProperty(globalThis, 'navigator')
      }
    }
  })

  it('mic 先成功后 STT 连接失败：麦克风流立即被 stop 且抛出原始连接错误', async () => {
    const originalNavigatorDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    releaseMicrophoneStream()

    let trackStopped = false
    const mockTrack = {
      readyState: 'live',
      enabled: true,
      muted: false,
      stop: () => {
        trackStopped = true
      },
    }

    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      writable: true,
      value: {
        mediaDevices: {
          getUserMedia: async () => ({
            active: true,
            getAudioTracks: () => [mockTrack],
            getTracks: () => [mockTrack],
          }),
        },
      },
    })

    try {
      const setupPromise = coordinateRecordingSetup({
        acquireToken: async () => 'sample_token',
        connectStt: async () => {
          throw new Error('ElevenLabs WebSocket connection failed')
        },
      })

      await expect(setupPromise).rejects.toThrow('ElevenLabs WebSocket connection failed')
      expect(trackStopped).toBe(true)
    } finally {
      releaseMicrophoneStream()
      if (originalNavigatorDesc) {
        Object.defineProperty(globalThis, 'navigator', originalNavigatorDesc)
      } else {
        Reflect.deleteProperty(globalThis, 'navigator')
      }
    }
  })

  it('等待期间判定已取消：释放麦克风硬件并抛出取消错误', async () => {
    const originalNavigatorDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    releaseMicrophoneStream()

    let trackStopped = false
    const mockTrack = {
      readyState: 'live',
      enabled: true,
      muted: false,
      stop: () => {
        trackStopped = true
      },
    }

    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      writable: true,
      value: {
        mediaDevices: {
          getUserMedia: async () => ({
            active: true,
            getAudioTracks: () => [mockTrack],
            getTracks: () => [mockTrack],
          }),
        },
      },
    })

    try {
      const setupPromise = coordinateRecordingSetup({
        acquireToken: async () => 'sample_token',
        connectStt: async () => undefined,
        isCancelled: () => true,
      })

      await expect(setupPromise).rejects.toThrow('Recording setup cancelled')
      expect(trackStopped).toBe(true)
    } finally {
      releaseMicrophoneStream()
      if (originalNavigatorDesc) {
        Object.defineProperty(globalThis, 'navigator', originalNavigatorDesc)
      } else {
        Reflect.deleteProperty(globalThis, 'navigator')
      }
    }
  })

  it('已由上层释放的取消 setup 不会二次停止随后复用的共享流', async () => {
    const originalNavigatorDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    releaseMicrophoneStream()
    let stopped = false
    const track = { readyState: 'live', enabled: true, muted: false, stop: () => { stopped = true } }
    const stream = { active: true, getAudioTracks: () => [track], getTracks: () => [track] }
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      writable: true,
      value: { mediaDevices: { getUserMedia: async () => stream } },
    })
    try {
      await expect(coordinateRecordingSetup({
        acquireToken: async () => 'old-token',
        connectStt: async () => undefined,
        isCancelled: () => true,
        releaseOnCancelled: false,
      })).rejects.toThrow('Recording setup cancelled')
      expect(stopped).toBe(false)

      const reused = await requestMicrophoneStream()
      expect(reused).toBe(stream as unknown as MediaStream)
      expect(stopped).toBe(false)
    } finally {
      releaseMicrophoneStream()
      if (originalNavigatorDesc) Object.defineProperty(globalThis, 'navigator', originalNavigatorDesc)
      else Reflect.deleteProperty(globalThis, 'navigator')
    }
  })
})
