import { describe, expect, it } from 'vitest'
import {
  INITIAL_INTERRUPTION_RECOVERY_STATE,
  decideInterruptionRecovery,
  decideInterruptionRecoveryAffordances,
  executeInterruptionRecovery,
  reduceInterruptionRecovery,
  type InterruptionRecoveryTarget,
} from '../../src/lib/session'

describe('decideInterruptionRecovery pure domain model', () => {
  it('对 ACTIVE_SESSION_PHASES 中的所有 phase 进行精准且穷尽的恢复目标映射', () => {
    // waiting_user / round_complete 映射到 waiting_user，绝不能误映射为 stt
    expect(decideInterruptionRecovery('waiting_user')).toBe('waiting_user')
    expect(decideInterruptionRecovery('round_complete')).toBe('waiting_user')

    // confirming_transcript 映射到 confirming_transcript，以便保留已就绪草稿
    expect(decideInterruptionRecovery('confirming_transcript')).toBe('confirming_transcript')

    // 录音前中后阶段映射到 stt
    expect(decideInterruptionRecovery('fetching_token')).toBe('stt')
    expect(decideInterruptionRecovery('connecting_stt')).toBe('stt')
    expect(decideInterruptionRecovery('recording')).toBe('stt')
    expect(decideInterruptionRecovery('finalizing_transcript')).toBe('stt')

    // LLM 请求中映射到 llm
    expect(decideInterruptionRecovery('requesting_llm')).toBe('llm')

    // TTS 准备与播放中映射到 tts
    expect(decideInterruptionRecovery('preparing_tts')).toBe('tts')
    expect(decideInterruptionRecovery('playing_ai')).toBe('tts')
  })

  it('对非 active 的 phase 返回 null', () => {
    expect(decideInterruptionRecovery('idle')).toBeNull()
    expect(decideInterruptionRecovery('loading_config')).toBeNull()
    expect(decideInterruptionRecovery('session_complete')).toBeNull()
    expect(decideInterruptionRecovery('error')).toBeNull()
  })
})

describe('reduceInterruptionRecovery explicit state machine', () => {
  it('通过结构化事件完成 interrupted -> retrying -> recovered 成功路径', () => {
    const interrupted = reduceInterruptionRecovery(INITIAL_INTERRUPTION_RECOVERY_STATE, {
      type: 'interrupted',
      target: 'llm',
    })
    expect(interrupted).toEqual({ status: 'interrupted', target: 'llm' })

    const retrying = reduceInterruptionRecovery(interrupted, { type: 'retry_started' })
    expect(retrying).toEqual({ status: 'retrying', target: 'llm' })

    const recovered = reduceInterruptionRecovery(retrying, { type: 'recovery_succeeded' })
    expect(recovered).toEqual({ status: 'recovered', target: 'llm' })
    expect(reduceInterruptionRecovery(recovered, { type: 'reset' })).toEqual(
      INITIAL_INTERRUPTION_RECOVERY_STATE,
    )
  })

  it('通过结构化事件完成失败与重试恢复路径，并保留原恢复目标', () => {
    const interrupted = reduceInterruptionRecovery(INITIAL_INTERRUPTION_RECOVERY_STATE, {
      type: 'interrupted',
      target: 'stt',
    })
    const retrying = reduceInterruptionRecovery(interrupted, { type: 'retry_started' })
    const failed = reduceInterruptionRecovery(retrying, { type: 'recovery_failed' })
    expect(failed).toEqual({ status: 'failed', target: 'stt' })

    const retryingAgain = reduceInterruptionRecovery(failed, { type: 'retry_started' })
    expect(retryingAgain).toEqual({ status: 'retrying', target: 'stt' })
    expect(reduceInterruptionRecovery(retryingAgain, { type: 'recovery_succeeded' })).toEqual({
      status: 'recovered',
      target: 'stt',
    })
  })

  it('不让无效成功事件跳过 retrying 状态', () => {
    const interrupted = reduceInterruptionRecovery(INITIAL_INTERRUPTION_RECOVERY_STATE, {
      type: 'interrupted',
      target: 'tts',
    })
    expect(reduceInterruptionRecovery(interrupted, { type: 'recovery_succeeded' })).toBe(interrupted)
  })
})

describe('executeInterruptionRecovery', () => {
  it('每个恢复目标只调用其唯一对应动作', async () => {
    const targets: Array<[InterruptionRecoveryTarget, string]> = [
      ['waiting_user', 'waiting_user'],
      ['confirming_transcript', 'confirming_transcript'],
      ['stt', 'stt'],
      ['llm', 'llm'],
      ['tts', 'tts'],
    ]

    for (const [target, expected] of targets) {
      const calls: string[] = []
      await executeInterruptionRecovery(target, {
        waitingUser: () => calls.push('waiting_user'),
        confirmingTranscript: () => calls.push('confirming_transcript'),
        stt: async () => { calls.push('stt') },
        llm: async () => { calls.push('llm') },
        tts: async () => { calls.push('tts') },
      })

      expect(calls).toEqual([expected])
    }
  })
})

describe('decideInterruptionRecoveryAffordances', () => {
  it('为被中断的 recording/STT 同时提供重试录音与文字回退', () => {
    expect(decideInterruptionRecoveryAffordances('stt')).toEqual({ retry: true, textInput: true })
  })

  it('保持其他恢复目标的既有单一重试入口', () => {
    expect(decideInterruptionRecoveryAffordances('waiting_user')).toEqual({ retry: true, textInput: false })
    expect(decideInterruptionRecoveryAffordances('confirming_transcript')).toEqual({ retry: true, textInput: false })
    expect(decideInterruptionRecoveryAffordances('llm')).toEqual({ retry: true, textInput: false })
    expect(decideInterruptionRecoveryAffordances('tts')).toEqual({ retry: true, textInput: false })
    expect(decideInterruptionRecoveryAffordances(null)).toEqual({ retry: false, textInput: false })
  })
})
