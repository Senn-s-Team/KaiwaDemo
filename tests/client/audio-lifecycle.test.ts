/**
 * [INPUT]: 依赖浏览器音频、麦克风与 TTS 生命周期公开接口
 * [OUTPUT]: 验证共享麦克风释放、权限并发、TTS 操作取消及真实 HTMLAudioElement 暂停继续位置
 * [POS]: tests/client 的浏览器媒体生命周期契约，保护资源释放和不重置播放位置的交互事实
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { describe, expect, it } from 'vitest'
import { formatRecordingTime, microphoneLevelToBars, shouldWarnSilence } from '../../src/lib/audio-feedback'
import { microphoneReadinessFromError, queryMicrophonePermission, setCachedMicrophoneReadiness } from '../../src/lib/microphone'
import { isMicrophoneTrackReady, SttTokenManager } from '../../src/lib/stt'
import { assertCurrentTtsOperation, CachedTtsPlayer, createSilentWavBytes, TtsCancelledError } from '../../src/lib/tts'
import { isPermissionRequesting, releaseMicrophoneStream, requestMicrophoneStream, shouldTeardownOnVisibility, SttError } from '../../src/lib/audio-engine'

describe('Safari audio unlock data', () => {
  it('creates a valid PCM WAV header for gesture-time playback', () => {
    const bytes = createSilentWavBytes()
    const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end))

    expect(ascii(0, 4)).toBe('RIFF')
    expect(ascii(8, 12)).toBe('WAVE')
    expect(ascii(36, 40)).toBe('data')
    expect(bytes.length).toBeGreaterThan(44)
  })
})

describe('TTS operation cancellation', () => {
  it('allows the current operation and rejects stale async playback', () => {
    expect(() => assertCurrentTtsOperation(4, 4)).not.toThrow()
    expect(() => assertCurrentTtsOperation(3, 4)).toThrow(TtsCancelledError)
  })
})

describe('microphone permission classification', () => {
  it('distinguishes a denied permission from an unavailable device', () => {
    expect(microphoneReadinessFromError(new DOMException('Permission denied', 'NotAllowedError'))).toBe('denied')
    expect(microphoneReadinessFromError(new DOMException('No device', 'NotFoundError'))).toBe('unavailable')
  })
})

describe('microphone feedback', () => {
  it('formats elapsed time and maps real levels to visible bars', () => {
    expect(formatRecordingTime(0)).toBe('00:00')
    expect(formatRecordingTime(65)).toBe('01:05')
    expect(microphoneLevelToBars(0)).toBe(0)
    expect(microphoneLevelToBars(0.2)).toBe(2)
    expect(microphoneLevelToBars(1)).toBe(7)
  })

  it('warns only after sustained silence', () => {
    expect(shouldWarnSilence(3, false)).toBe(false)
    expect(shouldWarnSilence(4, false)).toBe(true)
    expect(shouldWarnSilence(8, true)).toBe(false)
  })
})

describe('microphone capture readiness', () => {
  it('does not enter recording until the real audio track is live and unmuted', () => {
    expect(isMicrophoneTrackReady(undefined)).toBe(false)
    expect(isMicrophoneTrackReady({ readyState: 'live', enabled: true, muted: true })).toBe(false)
    expect(isMicrophoneTrackReady({ readyState: 'ended', enabled: true, muted: false })).toBe(false)
    expect(isMicrophoneTrackReady({ readyState: 'live', enabled: true, muted: false })).toBe(true)
  })

  it('CachedTtsPlayer.unlock() 具备幂等性，连续调用不会重复执行耗时解锁', async () => {
    const originalAudioDesc = Object.getOwnPropertyDescriptor(globalThis, 'Audio')
    const originalAudioContextDesc = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext')

    let audioPlayCount = 0
    class FakeAudio {
      muted = false
      src = ''
      preload = ''
      setAttribute(): void {}
      removeAttribute(): void {}
      load(): void {}
      pause(): void {}
      async play(): Promise<void> {
        audioPlayCount += 1
      }
    }

    class FakeAudioContext {
      state = 'suspended'
      async resume(): Promise<void> {
        this.state = 'running'
      }
      async close(): Promise<void> {
        this.state = 'closed'
      }
    }

    Object.defineProperty(globalThis, 'Audio', {
      configurable: true,
      writable: true,
      value: FakeAudio,
    })
    Object.defineProperty(globalThis, 'AudioContext', {
      configurable: true,
      writable: true,
      value: FakeAudioContext,
    })

    try {
      const player = new CachedTtsPlayer()
      await player.unlock()
      expect(audioPlayCount).toBe(1)

      // 第二次调用应被 unlocked 守卫拦截，不再触发 fake audio play
      await player.unlock()
      expect(audioPlayCount).toBe(1)
      player.dispose()
    } finally {
      if (originalAudioDesc) {
        Object.defineProperty(globalThis, 'Audio', originalAudioDesc)
      } else {
        Reflect.deleteProperty(globalThis, 'Audio')
      }
      if (originalAudioContextDesc) {
        Object.defineProperty(globalThis, 'AudioContext', originalAudioContextDesc)
      } else {
        Reflect.deleteProperty(globalThis, 'AudioContext')
      }
    }
  })

  it('CachedTtsPlayer pauses and resumes the same HTMLAudioElement at its current position', async () => {
    const originalAudioDesc = Object.getOwnPropertyDescriptor(globalThis, 'Audio')
    const listeners = new Map<string, Set<() => void>>()
    let createdAudio: FakeAudio | null = null

    class FakeAudio {
      paused = true
      currentTime = 0
      src = ''
      preload = ''
      muted = false
      setAttribute(): void {}
      removeAttribute(): void {}
      load(): void {}
      pause(): void { this.paused = true }
      async play(): Promise<void> { this.paused = false }
      addEventListener(type: string, listener: () => void): void {
        const registered = listeners.get(type) ?? new Set<() => void>()
        registered.add(listener)
        listeners.set(type, registered)
      }
      removeEventListener(type: string, listener: () => void): void {
        listeners.get(type)?.delete(listener)
      }
      emit(type: string): void {
        for (const listener of listeners.get(type) ?? []) listener()
      }
    }

    Object.defineProperty(globalThis, 'Audio', {
      configurable: true,
      writable: true,
      value: class extends FakeAudio {
        constructor() {
          super()
          createdAudio = this
        }
      },
    })

    try {
      const player = new CachedTtsPlayer()
      const cache = Reflect.get(player, 'cache') as Map<string, { url: string; bytes: number }>
      cache.set('voice:model:テスト', { url: 'blob:test', bytes: 1 })
      const playback = player.speak({
        text: 'テスト', voiceId: 'voice', modelId: 'model',
        onGenerationStarted: () => undefined, onFirstAudio: () => undefined,
        onAudioStarted: () => undefined, onAudioEnded: () => undefined, onTtsRequest: () => undefined,
      })
      await Promise.resolve()
      expect(createdAudio?.paused).toBe(false)
      if (!createdAudio) throw new Error('Expected CachedTtsPlayer to create an HTMLAudioElement.')
      createdAudio.currentTime = 12.5
      expect(player.pause()).toBe(true)
      expect(createdAudio.paused).toBe(true)
      expect(createdAudio.currentTime).toBe(12.5)
      expect(await player.resume()).toBe(true)
      expect(createdAudio.paused).toBe(false)
      expect(createdAudio.currentTime).toBe(12.5)
      createdAudio.emit('ended')
      await playback
      player.dispose()
    } finally {
      if (originalAudioDesc) Object.defineProperty(globalThis, 'Audio', originalAudioDesc)
      else Reflect.deleteProperty(globalThis, 'Audio')
    }
  })

  it('requestMicrophoneStream 复用 live 共享流，显式 releaseMicrophoneStream 停止并清理', async () => {
    const originalNavigatorDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    let gumCalls = 0
    let trackStopped = false

    const mockTrack = {
      readyState: 'live',
      enabled: true,
      muted: false,
      stop(): void {
        trackStopped = true
      },
    }
    const mockStream = {
      active: true,
      getAudioTracks(): unknown[] {
        return [mockTrack]
      },
      getTracks(): unknown[] {
        return [mockTrack]
      },
    }

    const mockNavigator = {
      mediaDevices: {
        async getUserMedia(): Promise<unknown> {
          gumCalls += 1
          return mockStream
        },
      },
    }

    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      writable: true,
      value: mockNavigator,
    })

    try {
      releaseMicrophoneStream()
      const stream1 = await requestMicrophoneStream()
      expect(gumCalls).toBe(1)
      expect(stream1).toBe(mockStream as unknown as MediaStream)

      // 第二次获取同一 live 流：直接复用，不重复调用 getUserMedia
      const stream2 = await requestMicrophoneStream()
      expect(gumCalls).toBe(1)
      expect(stream2).toBe(stream1)

      // 显式释放：停止 track 并清空共享流引用
      releaseMicrophoneStream()
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

  it('queryMicrophonePermission 能够安全处理 granted、denied 及未实现 TypeError', async () => {
    const originalNavigatorDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    setCachedMicrophoneReadiness('unknown')

    try {
      // Case 1: granted
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        writable: true,
        value: {
          mediaDevices: { getUserMedia: async () => ({}) },
          permissions: {
            query: async () => ({ state: 'granted' }),
          },
        },
      })
      expect(await queryMicrophonePermission()).toBe('granted')

      // Case 2: denied
      setCachedMicrophoneReadiness('unknown')
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        writable: true,
        value: {
          mediaDevices: { getUserMedia: async () => ({}) },
          permissions: {
            query: async () => ({ state: 'denied' }),
          },
        },
      })
      expect(await queryMicrophonePermission()).toBe('denied')

      // Case 3: iOS Safari / Firefox 不支持 microphone query 抛出 TypeError，平滑回退 unknown
      setCachedMicrophoneReadiness('unknown')
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        writable: true,
        value: {
          mediaDevices: { getUserMedia: async () => ({}) },
          permissions: {
            query: async () => {
              throw new TypeError("Failed to execute 'query' on 'Permissions': 'microphone' is not a valid PermissionName")
            },
          },
        },
      })
      expect(await queryMicrophonePermission()).toBe('unknown')
    } finally {
      setCachedMicrophoneReadiness('unknown')
      if (originalNavigatorDesc) {
        Object.defineProperty(globalThis, 'navigator', originalNavigatorDesc)
      } else {
        Reflect.deleteProperty(globalThis, 'navigator')
      }
    }
  })

  it('requestMicrophoneStream pending 时 isPermissionRequesting 为 true，并在 resolve/reject 后恢复 false', async () => {
    const originalNavigatorDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    releaseMicrophoneStream()

    try {
      // Case 1: resolve 流程
      const resolveGate = Promise.withResolvers<{
        active: boolean
        getAudioTracks: () => Array<{ readyState: string; enabled: boolean; muted: boolean; stop: () => void }>
        getTracks: () => Array<{ stop: () => void }>
      }>()

      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        writable: true,
        value: {
          mediaDevices: {
            getUserMedia: () => resolveGate.promise,
          },
        },
      })
      expect(isPermissionRequesting()).toBe(false)
      expect(shouldTeardownOnVisibility(true)).toBe(true)

      const streamPromise = requestMicrophoneStream()
      // pending 挂起期间，必须真实反映为 true，且此时即使 visibility hidden 也不应 teardown
      expect(isPermissionRequesting()).toBe(true)
      expect(shouldTeardownOnVisibility(true)).toBe(false)

      const mockTrack = {
        readyState: 'live',
        enabled: true,
        muted: false,
        stop: () => undefined,
      }
      resolveGate.resolve({
        active: true,
        getAudioTracks: () => [mockTrack],
        getTracks: () => [mockTrack],
      })

      await streamPromise
      // resolve 完成后，必须自动恢复为 false，此时 hidden 必须允许 teardown
      expect(isPermissionRequesting()).toBe(false)
      expect(shouldTeardownOnVisibility(true)).toBe(true)
      releaseMicrophoneStream()
      const rejectGate = Promise.withResolvers<never>()
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        writable: true,
        value: {
          mediaDevices: {
            getUserMedia: () => rejectGate.promise,
          },
        },
      })
      expect(isPermissionRequesting()).toBe(false)
      expect(shouldTeardownOnVisibility(true)).toBe(true)

      const errorPromise = requestMicrophoneStream().catch((err: unknown) => err)
      expect(isPermissionRequesting()).toBe(true)
      expect(shouldTeardownOnVisibility(true)).toBe(false)

      rejectGate.reject(new DOMException('Permission denied', 'NotAllowedError'))
      const err = await errorPromise
      expect(err).toBeInstanceOf(SttError)
      // reject 完成后，必须同样恢复为 false，此时 hidden 必须允许 teardown
      expect(isPermissionRequesting()).toBe(false)
      expect(shouldTeardownOnVisibility(true)).toBe(true)
    } finally {
      releaseMicrophoneStream()
      if (originalNavigatorDesc) {
        Object.defineProperty(globalThis, 'navigator', originalNavigatorDesc)
      } else {
        Reflect.deleteProperty(globalThis, 'navigator')
      }
    }
  })

  it('shouldTeardownOnVisibility 在前台与权限请求中均决定不清理，仅在无弹窗的真后台清理', () => {
    // 前台不可见：页面可见时不应 teardown
    expect(shouldTeardownOnVisibility(false)).toBe(false)
    // 页面 hidden 且无权限弹窗：必须 teardown
    expect(shouldTeardownOnVisibility(true)).toBe(true)
  })

  it('requestMicrophoneStream single-flight 机制：并发调用只触发一次 getUserMedia 并返回相同流', async () => {
    const originalNavigatorDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    releaseMicrophoneStream()
    let gumCalls = 0
    const gate = Promise.withResolvers<{
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
            return gate.promise
          },
        },
      },
    })

    try {
      const req1 = requestMicrophoneStream()
      const req2 = requestMicrophoneStream()

      gate.resolve({
        active: true,
        getAudioTracks: () => [mockTrack],
        getTracks: () => [mockTrack],
      })

      const [s1, s2] = await Promise.all([req1, req2])
      expect(gumCalls).toBe(1)
      expect(s1).toBe(s2)
    } finally {
      releaseMicrophoneStream()
      if (originalNavigatorDesc) {
        Object.defineProperty(globalThis, 'navigator', originalNavigatorDesc)
      } else {
        Reflect.deleteProperty(globalThis, 'navigator')
      }
    }
  })

  it('requestMicrophoneStream pending 期间 release 会废弃请求，后 resolve 的 tracks 立即被 stop 且不可复用', async () => {
    const originalNavigatorDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    releaseMicrophoneStream()
    let trackStopped = false
    const gate = Promise.withResolvers<{
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
          getUserMedia: () => gate.promise,
        },
      },
    })

    try {
      const pendingReq = requestMicrophoneStream()
      expect(isPermissionRequesting()).toBe(true)

      // 用户离开或发生取消/重置
      releaseMicrophoneStream()
      expect(isPermissionRequesting()).toBe(false)

      // 随后 getUserMedia 姗姗来迟 resolve
      gate.resolve({
        active: true,
        getAudioTracks: () => [mockTrack],
        getTracks: () => [mockTrack],
      })

      // 旧请求被判定为作废抛错，且其返回的 track 必须立即调用 stop() 销毁硬件占用
      await expect(pendingReq).rejects.toThrow('麦克风请求已被取消或重置。')
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

  it('Token 或 STT 启动失败触发 release 后，pending 中的麦克风迟到 resolve 会被 stop 且不可复用', async () => {
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
      // 模拟并发启动：micPromise 挂起，而 tokenPromise 率先因网络错误 reject
      const micPromise = requestMicrophoneStream()
      const tokenPromise = Promise.reject(new Error('Token fetch failed: 401 Unauthorized'))

      // 模拟与 App.tsx:startRecording 生产行为一致的组合流程：
      // 当 Promise.all 失败进入 catch 时，显式执行 releaseMicrophoneStream()
      let caughtError: unknown = null
      try {
        await Promise.all([micPromise, tokenPromise])
      } catch (err) {
        caughtError = err
        releaseMicrophoneStream()
      }

      expect(caughtError).toBeInstanceOf(Error)
      expect((caughtError as Error).message).toContain('Token fetch failed')

      // 验证在 catch 执行 releaseMicrophoneStream 之后，麦克风迟到 resolve
      micGate.resolve({
        active: true,
        getAudioTracks: () => [mockTrack],
        getTracks: () => [mockTrack],
      })

      // micPromise 应当被作废，其 track 应当被立即 stop
      await expect(micPromise).rejects.toThrow('麦克风请求已被取消或重置。')
      expect(trackStopped).toBe(true)

      // 验证共享流未被污染/不可复用，下一次请求必须重新调用 getUserMedia
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
})

describe('SttTokenManager production single-flight & caching', () => {
  it('并发预取与前台获取仅请求一次（single-flight 复用）', async () => {
    const manager = new SttTokenManager(600_000)
    let fetchCalls = 0
    const gate = Promise.withResolvers<string>()

    const fetcher = async () => {
      fetchCalls += 1
      return gate.promise
    }

    // 模拟后台静默预取与前台录音并发启动
    const prefetchPromise = manager.prefetch(fetcher)
    const acquirePromise = manager.acquireToken(fetcher)

    gate.resolve('shared_token_abc')
    const [prefetched, acquired] = await Promise.all([prefetchPromise, acquirePromise])

    expect(fetchCalls).toBe(1)
    expect(prefetched).toBe('shared_token_abc')
    expect(acquired).toBe('shared_token_abc')
  })

  it('请求失败时不留下坏缓存，并允许后续平滑重试', async () => {
    const manager = new SttTokenManager(600_000)
    let attempts = 0
    const fetcher = async () => {
      attempts += 1
      if (attempts === 1) {
        throw new Error('Network error on first attempt')
      }
      return 'recovered_token'
    }

    const failedPrefetch = await manager.prefetch(fetcher)
    expect(failedPrefetch).toBeNull()
    expect(manager.getCached()).toBeNull()

    // 第二次请求成功恢复
    const successfulToken = await manager.acquireToken(fetcher)
    expect(successfulToken).toBe('recovered_token')
    expect(attempts).toBe(2)
  })

  it('鲜活缓存只被消费一次，过期缓存不被复用', async () => {
    const manager = new SttTokenManager(100_000)
    let fetchCount = 0
    const fetcher = async () => {
      fetchCount += 1
      return `token_${fetchCount}`
    }

    const baseTime = 1_000_000
    // 预取 Token 并注入当前时间 baseTime
    await manager.prefetch(fetcher, baseTime)
    expect(fetchCount).toBe(1)
    expect(manager.getCached()?.token).toBe('token_1')

    // 1. 鲜活消费：首次消费成功获取 token_1，消费后缓存被清空
    const consumed = manager.consumeFreshToken(baseTime + 10_000)
    expect(consumed).toBe('token_1')
    expect(manager.getCached()).toBeNull()

    // 再次尝试消费返回 null
    expect(manager.consumeFreshToken(baseTime + 10_000)).toBeNull()

    // 2. 过期缓存不复用：存入有效期为 100_000ms 的 token_2
    await manager.prefetch(fetcher, baseTime)
    expect(fetchCount).toBe(2)
    // 模拟时间流逝 150_000ms，已经过期
    const expired = manager.consumeFreshToken(baseTime + 150_000)
    expect(expired).toBeNull()
    expect(manager.getCached()).toBeNull()
  })

  it('reset 能够隔离旧 pending promise，防止迟到的旧请求污染新代缓存', async () => {
    const manager = new SttTokenManager(600_000)
    const oldGate = Promise.withResolvers<string>()
    const newGate = Promise.withResolvers<string>()

    // 1. 第一个请求（旧时代）发起并挂起
    const oldPrefetchPromise = manager.prefetch(() => oldGate.promise)

    // 2. 会话发生重置，epoch 递增
    manager.reset()
    expect(manager.getCached()).toBeNull()

    // 3. 在新时代发起新请求
    const newPrefetchPromise = manager.prefetch(() => newGate.promise)

    // 4. 新请求先完成，写入新时代 token
    newGate.resolve('new_token_123')
    const newResult = await newPrefetchPromise
    expect(newResult).toBe('new_token_123')
    expect(manager.getCached()?.token).toBe('new_token_123')

    // 5. 旧请求后完成，虽然返回值会给旧 caller，但绝不能覆盖 manager 的新缓存
    oldGate.resolve('old_stale_token')
    const oldResult = await oldPrefetchPromise
    expect(oldResult).toBe('old_stale_token')
    expect(manager.getCached()?.token).toBe('new_token_123')
  })
})

describe('录音入口权限预检回归', () => {
  it('获取硬件流前查询当前权限，已拒绝时不再次申请', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    let queries = 0
    let requests = 0
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
      permissions: { query: async () => { queries += 1; return { state: 'denied' } } },
      mediaDevices: { getUserMedia: async () => { requests += 1; throw new DOMException('Permission denied', 'NotAllowedError') } },
    } })
    releaseMicrophoneStream()
    try {
      await expect(requestMicrophoneStream()).rejects.toMatchObject({ code: 'permission_denied' })
      expect(queries).toBe(1)
      expect(requests).toBe(0)
    } finally {
      releaseMicrophoneStream()
      if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor)
      else Reflect.deleteProperty(globalThis, 'navigator')
    }
  })

  it('已授权时预检后只申请一次硬件流，并发调用复用同一预检', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    let queries = 0
    let requests = 0
    const track = { readyState: 'live', enabled: true, muted: false, stop: () => undefined }
    const stream = {
      active: true,
      getAudioTracks: () => [track],
      getTracks: () => [track],
    }
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
      permissions: { query: async () => { queries += 1; return { state: 'granted' } } },
      mediaDevices: { getUserMedia: async () => { requests += 1; return stream } },
    } })
    releaseMicrophoneStream()
    try {
      const [first, second] = await Promise.all([requestMicrophoneStream(), requestMicrophoneStream()])
      expect(first).toBe(second)
      expect(queries).toBe(1)
      expect(requests).toBe(1)
    } finally {
      releaseMicrophoneStream()
      if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor)
      else Reflect.deleteProperty(globalThis, 'navigator')
    }
  })

  it('权限查询挂起期间取消，不会在迟到查询完成后申请硬件流', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    const queryGate = Promise.withResolvers<{ state: 'granted' }>()
    let requests = 0
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {
      permissions: { query: () => queryGate.promise },
      mediaDevices: { getUserMedia: async () => { requests += 1; throw new Error('unreachable') } },
    } })
    releaseMicrophoneStream()
    try {
      const request = requestMicrophoneStream()
      releaseMicrophoneStream()
      queryGate.resolve({ state: 'granted' })
      await expect(request).rejects.toThrow('麦克风请求已被取消或重置。')
      expect(requests).toBe(0)
    } finally {
      releaseMicrophoneStream()
      if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor)
      else Reflect.deleteProperty(globalThis, 'navigator')
    }
  })
})
