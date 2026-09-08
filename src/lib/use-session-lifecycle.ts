/**
 * [INPUT]: 在线/可见性事件与会话中断、媒体释放、恢复状态动作
 * [OUTPUT]: 安装并清理会话前后台与网络 lifecycle 监听，回到前台时静默保留当前交互状态
 * [POS]: src/lib 的 session lifecycle 监听边界；不拥有会话数据或 controller 实现
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { useEffect, useRef, type RefObject } from 'react'
import { shouldTeardownOnVisibility } from './audio-engine'
import { decideInterruptionRecovery } from './session'
import type { AppPhase, RoundRecord, UiError } from '../types'

const BACKGROUND_INTERRUPT_PHASES: readonly AppPhase[] = ['fetching_token', 'connecting_stt', 'recording', 'finalizing_transcript', 'requesting_llm', 'preparing_tts', 'playing_ai']

interface SessionLifecycleOptions {
  phaseRef: RefObject<AppPhase>
  setOnline(value: boolean): void
  setNotice(value: string): void
  beginOperation(): void
  abortSpeechAssist(reason: 'offline' | 'background'): void
  interruptPlayback(): void
  disposeVoice(): void
  dispatch(event: { type: 'interrupted'; target: ReturnType<typeof decideInterruptionRecovery> extends infer T ? Exclude<T, null> : never }): void
  touchRound(update: (round: RoundRecord) => void): void
  setUiError(error: UiError): void
  transitionTo(phase: AppPhase): boolean
  stopResources(): void
}

export function useSessionLifecycle(options: SessionLifecycleOptions) {
  const latestOptionsRef = useRef(options)
  latestOptionsRef.current = options

  useEffect(() => {
    const interruptActiveSession = (code: 'offline' | 'background_interruption') => {
      const options = latestOptionsRef.current
      const interruptedPhase = options.phaseRef.current
      const recoveryTarget = decideInterruptionRecovery(interruptedPhase)
      if (!recoveryTarget) return
      options.beginOperation()
      options.abortSpeechAssist(code === 'offline' ? 'offline' : 'background')
      if (recoveryTarget === 'llm' || recoveryTarget === 'tts') {
        options.interruptPlayback()
      }
      if (recoveryTarget === 'stt') {
        options.disposeVoice()
      }
      options.dispatch({ type: 'interrupted', target: recoveryTarget })
      options.touchRound((round) => {
        round.failureCount += 1
      })
      options.setUiError({
        code,
        title: code === 'offline' ? '网络连接已中断' : '连接已在后台停止',
        message: code === 'offline' ? '当前步骤已停止。网络恢复后重试，或改用文字回答。' : '返回页面后请恢复当前步骤。',
        recovery: interruptedPhase === 'recording' ? 'text_input' : 'retry',
      })
      options.transitionTo('error')
    }
    const handleOnline = () => {
      const options = latestOptionsRef.current
      options.setOnline(true)
      options.setNotice('网络已恢复，可以继续。')
    }
    const handleOffline = () => {
      const options = latestOptionsRef.current
      options.setOnline(false)
      interruptActiveSession('offline')
    }
    const handleVisibility = () => {
      const options = latestOptionsRef.current
      if (document.visibilityState === 'hidden' && BACKGROUND_INTERRUPT_PHASES.includes(options.phaseRef.current)) {
        // 如果正在等待用户麦克风系统权限弹窗，切出属于正常系统弹窗遮挡/切换行为，不能误杀刚获取的流或判定失败
        if (!shouldTeardownOnVisibility(document.hidden)) {
          return
        }
        interruptActiveSession('background_interruption')

      }
    }
    const handlePageHide = () => latestOptionsRef.current.stopResources()
    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    document.addEventListener('visibilitychange', handleVisibility)
    window.addEventListener('pagehide', handlePageHide)
    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener('pagehide', handlePageHide)
      latestOptionsRef.current.stopResources()
    }
  }, [])
}
