/**
 * [INPUT]: 依赖 ./audio-engine 的 requestMicrophoneStream/releaseMicrophoneStream
 * [OUTPUT]: 对外提供 coordinateRecordingSetup 与 RecordingSetupOptions，支持共享流取得瞬间的并行本机采集接缝并允许已释放硬件的调用方关闭取消后的重复释放
 * [POS]: src/lib 的录音并发协调与资源所有权核心深模块，隐藏麦克风与 Token 并发获取、连接判定、失败作废回收与 live track 检查
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { releaseMicrophoneStream, requestMicrophoneStream } from './audio-engine'

export interface RecordingSetupOptions {
  acquireToken: () => Promise<string>
  connectStt: (token: string) => Promise<void>
  /** 共享麦克风一经取得即调用；不得阻塞 STT 准备。 */
  onMicrophoneStream?: (stream: MediaStream) => void
  isCancelled?: () => boolean
  /** 上层已主动 release 且会立即发起新录音时，避免旧 catch 二次释放其共享流。 */
  releaseOnCancelled?: boolean
}

/**
 * 协调录音准备生命周期：
 * 1. 并发获取麦克风流与 STT Token，准备时延取二者最大值；
 * 2. 只有麦克风与 Token 均成功后才连接 STT；
 * 3. 任意步骤失败统一释放硬件；取消默认也释放，已由上层完成释放时可显式关闭取消时的二次释放；
 * 4. 成功返回麦克风 track 是否为 live，供调用方同步状态。
 */
export async function coordinateRecordingSetup(
  options: RecordingSetupOptions,
): Promise<boolean> {
  const micPromise = requestMicrophoneStream()
  void micPromise.then((stream) => options.onMicrophoneStream?.(stream)).catch(() => undefined)
  const tokenPromise = options.acquireToken()

  let stream: MediaStream
  let token: string

  try {
    const results = await Promise.all([micPromise, tokenPromise])
    stream = results[0]
    token = results[1]


    if (options.isCancelled?.()) {
      throw new Error('Recording setup cancelled')
    }

    await options.connectStt(token)

    if (options.isCancelled?.()) {
      throw new Error('Recording setup cancelled')
    }
  } catch (error) {
    // 已由上层取消的旧 setup 不能二次释放共享流，否则会误伤随后开始的新录音。
    if (!options.isCancelled?.() || options.releaseOnCancelled !== false) releaseMicrophoneStream()
    throw error
  }

  const [track] = stream.getAudioTracks()
  return track !== undefined && track.readyState === 'live'
}
