/**
 * [INPUT]: 依赖 ./audio-engine 的 requestMicrophoneStream/releaseMicrophoneStream
 * [OUTPUT]: 对外提供 coordinateRecordingSetup 函数与 RecordingSetupOptions 类型定义
 * [POS]: src/lib 的录音并发协调与资源所有权核心深模块，隐藏麦克风与 Token 并发获取、连接判定、失败作废回收与 live track 检查
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { releaseMicrophoneStream, requestMicrophoneStream } from './audio-engine'

export interface RecordingSetupOptions {
  acquireToken: () => Promise<string>
  connectStt: (token: string) => Promise<void>
  isCancelled?: () => boolean
}

/**
 * 协调录音准备生命周期：
 * 1. 并发获取麦克风流与 STT Token，准备时延取二者最大值；
 * 2. 只有麦克风与 Token 均成功后才连接 STT；
 * 3. 任意步骤失败或被取消，统一由单一 catch 调用 releaseMicrophoneStream 作废 pending 流并释放已就绪流；
 * 4. 成功返回麦克风 track 是否为 live，供调用方同步状态。
 */
export async function coordinateRecordingSetup(
  options: RecordingSetupOptions,
): Promise<boolean> {
  const micPromise = requestMicrophoneStream()
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
    releaseMicrophoneStream()
    throw error
  }

  const [track] = stream.getAudioTracks()
  return track !== undefined && track.readyState === 'live'
}
