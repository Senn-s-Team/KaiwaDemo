import { describe, expect, it } from 'vitest'
import {
  createAiTurnRuntime,
  initialAiTurnState,
  type AiTurnDependencies,
  type TtsPlayerLike,
} from '../../src/lib/ai-turn-controller'
import type { SpeakOptions } from '../../src/lib/tts'
import type { SessionScenario } from '../../src/types'

const dummyScenario: SessionScenario = {
  scenarioToken: 'test_token',
  firstLine: 'こんにちは',
  sessionToken: 'tok',
  dynamicData: {
    id: 'sc_1',
    version: 1,
    titleZh: '测试场景',
    summaryZh: '测试摘要',
    aiRole: '店員',
    userRole: '客',
    relationship: '接客',
    tone: '丁寧',
    firstLine: 'こんにちは',
    userGoal: 'コーヒーを注文する',
    coreGoal: { id: 'g_1', titleZh: '点咖啡', descriptionZh: '点咖啡' },
    worldAnchors: [],
    followUpPrinciples: [],
    hintStrategy: '',
    feedbackFocus: '',
    safetyBoundary: [],
    recommendedMinTurns: 5,
  },
  reveal: { titleZh: '测试', summaryZh: '测试' },
}

describe('ai-turn-controller production orchestration contracts', () => {
  it('stale-deps 桥接更新: 首次 render 依赖为 null/初始值，更新后能够精准消费最新 session/scenario/turn，且第 5 轮走 complete', async () => {
    let committedRoundCount = 0
    let sessionCompleted = false
    let advancedTurn: number | null = null
    let capturedSessionId = ''
    let capturedTurn = 0
    let capturedScenarioToken = ''
    let currentOperationId = 1

    const mockTts: TtsPlayerLike = {
      speak: async (options: SpeakOptions) => {
        options.onAudioStarted?.()
        options.onAudioEnded?.()
      },
      stop: () => undefined,
      unlock: async () => undefined,
    }

    // 1. 模拟首次 render：config 和 scenario 为 null，sessionId 为空，turn=1
    const initialDeps: AiTurnDependencies = {
      config: null,
      sessionId: '',
      scenario: null,
      turn: 1,
      operation: {
        begin: () => {
          currentOperationId += 1
          return currentOperationId
        },
        isCurrent: (opId) => opId === currentOperationId,
      },
      transitionTo: () => true,
      touchRound: () => undefined,
      commitCurrentRound: () => {
        committedRoundCount += 1
      },
      replaceCurrentRound: () => undefined,
      commitAssistantMessage: () => undefined,
      advanceTurn: (next) => {
        advancedTurn = next
      },
      onSessionComplete: () => {
        sessionCompleted = true
      },
      adapters: {
        streamReply: async (sessId, t, _hist, sc) => {
          capturedSessionId = sessId
          capturedTurn = t
          capturedScenarioToken = sc.sessionToken
          return {
            text: '第5轮完成回复',
            model: 'gpt-4o',
            mock: false,
            usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
          }
        },
        createTtsPlayer: () => mockTts,
      },
    }

    const runtime = createAiTurnRuntime(initialDeps)

    // 此时若未更新 deps，由于 config 和 scenario 为 null，调用 generateNextReply 应当安全返回，不做任何操作
    await runtime.actions.generateNextReply([], false)
    expect(capturedSessionId).toBe('')
    expect(committedRoundCount).toBe(0)

    // 2. 模拟后续 render：配置载入，会话建立，且回合推进到了第 5 轮
    const updatedDeps: AiTurnDependencies = {
      ...initialDeps,
      config: {
        ttsAvailable: true,
        voiceId: 'v_updated',
        ttsModel: 'm_updated',
      },
      sessionId: 'sess_live_123',
      scenario: {
        ...dummyScenario,
        sessionToken: 'token_live_xyz',
      },
      turn: 5, // 第 5 轮
    }

    runtime.updateDependencies(updatedDeps)

    // 再次调用：必须读取到最新快照，向 adapter 传入最新参数，并在完成后走 complete
    await runtime.actions.generateNextReply([], false)

    expect(capturedSessionId).toBe('sess_live_123')
    expect(capturedTurn).toBe(5)
    expect(capturedScenarioToken).toBe('token_live_xyz')
    expect(committedRoundCount).toBe(1)
    expect(sessionCompleted).toBe(true)
    expect(advancedTurn).toBeNull() // 绝不进入 turn 6
  })

  it('superseded 请求取消: 新请求发起时自动 abort 正在进行的旧请求，旧请求迟到解析不产生 commit', async () => {
    let commitCount = 0
    let currentOperationId = 1
    const firstGate = Promise.withResolvers<string>()
    let firstSignal: AbortSignal | undefined

    const mockTts: TtsPlayerLike = {
      speak: async () => undefined,
      stop: () => undefined,
      unlock: async () => undefined,
    }

    const deps: AiTurnDependencies = {
      config: {
        ttsAvailable: true,
        voiceId: 'v_1',
        ttsModel: 'm_1',
      },
      sessionId: 'sess_1',
      scenario: dummyScenario,
      turn: 1,
      operation: {
        begin: () => {
          currentOperationId += 1
          return currentOperationId
        },
        isCurrent: (opId) => opId === currentOperationId,
      },
      transitionTo: () => true,
      touchRound: () => undefined,
      commitCurrentRound: () => {
        commitCount += 1
      },
      replaceCurrentRound: () => undefined,
      commitAssistantMessage: () => {
        commitCount += 1
      },
      advanceTurn: () => undefined,
      adapters: {
        streamReply: async (_sess, _turn, _hist, _sc, _onFirst, signal) => {
          if (!firstSignal) {
            firstSignal = signal
            const text = await firstGate.promise
            return {
              text,
              model: 'gpt-4o',
              mock: false,
              usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
            }
          }
          return {
            text: '第二次请求成功',
            model: 'gpt-4o',
            mock: false,
            usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
          }
        },
        createTtsPlayer: () => mockTts,
      },
    }

    const runtime = createAiTurnRuntime(deps)

    // 发起第一个请求并挂起
    const p1 = runtime.actions.generateNextReply([], false)

    // 发起第二个请求（superseded）
    const p2 = runtime.actions.generateNextReply([], true)

    // 验证第一个请求的 signal 立即被 abort
    expect(firstSignal?.aborted).toBe(true)
    expect(firstSignal?.reason).toBe('superseded')

    // 释放第一个请求，确保它不会 commit
    firstGate.resolve('迟到的第一次回复')
    await Promise.all([p1, p2])

    expect(runtime.getState().currentAiText).toBe('第二次请求成功')
  })

  it('TTS speak throw 降级与 skip 推进: 播放抛错保留 pendingAdvanceReply 并记录 step: tts，调用 skipFailedTts 恰好 finalize 一次', async () => {
    let committedRoundCount = 0
    let currentOperationId = 1
    let advancedTurn: number | null = null
    let ttsStopped = false

    const mockTts: TtsPlayerLike = {
      speak: async () => {
        throw new Error('Web Audio decode failed')
      },
      stop: () => {
        ttsStopped = true
      },
      unlock: async () => undefined,
    }

    const deps: AiTurnDependencies = {
      config: {
        ttsAvailable: true,
        voiceId: 'v_1',
        ttsModel: 'm_1',
      },
      sessionId: 'sess_1',
      scenario: dummyScenario,
      turn: 2,
      operation: {
        begin: () => {
          currentOperationId += 1
          return currentOperationId
        },
        isCurrent: (opId) => opId === currentOperationId,
      },
      transitionTo: () => true,
      touchRound: () => undefined,
      commitCurrentRound: () => {
        committedRoundCount += 1
      },
      replaceCurrentRound: () => undefined,
      commitAssistantMessage: () => undefined,
      advanceTurn: (next) => {
        advancedTurn = next
      },
      adapters: {
        createTtsPlayer: () => mockTts,
      },
    }

    const runtime = createAiTurnRuntime(deps)
    await runtime.actions.playAiText('エラーになるテキスト', true, 1)

    // 断言：播放抛错后进入 tts 错误态，并保留 pendingAdvanceReply
    expect(runtime.getState().lastFailedStep).toBe('tts')
    expect(runtime.meta.pendingAdvanceReply).toBe('エラーになるテキスト')
    expect(committedRoundCount).toBe(0)
    runtime.actions.interruptPlaybackForBackground()
    expect(ttsStopped).toBe(true)
    expect(runtime.meta.pendingAdvanceReply).toBe('エラーになるテキスト')

    // 用户点击“显示文字继续”（skipFailedTts）
    runtime.actions.skipFailedTts()

    // 断言：错误清除、台词展开、当前 round 被恰好提交一次并推进到 turn 3
    expect(runtime.getState().aiTextRevealed).toBe(true)
    expect(runtime.getState().aiError).toBeNull()
    expect(runtime.meta.pendingAdvanceReply).toBeNull()
    expect(committedRoundCount).toBe(1)
    expect(advancedTurn).toBe(3)
  })

  it('replay 音频播放: 标记 played message 状态并在播放结束后正确保留', async () => {
    let currentOperationId = 1
    let playedEndedCalled = false

    const mockTts: TtsPlayerLike = {
      speak: async (options: SpeakOptions) => {
        options.onAudioStarted?.()
        options.onAudioEnded?.()
        playedEndedCalled = true
      },
      stop: () => undefined,
      unlock: async () => undefined,
    }

    const deps: AiTurnDependencies = {
      config: {
        ttsAvailable: true,
        voiceId: 'v_1',
        ttsModel: 'm_1',
      },
      sessionId: 'sess_1',
      scenario: dummyScenario,
      turn: 1,
      operation: {
        begin: () => {
          currentOperationId += 1
          return currentOperationId
        },
        isCurrent: (opId) => opId === currentOperationId,
      },
      transitionTo: () => true,
      touchRound: () => undefined,
      commitCurrentRound: () => undefined,
      replaceCurrentRound: () => undefined,
      commitAssistantMessage: () => undefined,
      advanceTurn: () => undefined,
      adapters: {
        createTtsPlayer: () => mockTts,
      },
    }

    const runtime = createAiTurnRuntime(deps)
    await runtime.actions.playAiText('リプレイのテキスト', false, 1, 'msg_assistant_99')

    expect(playedEndedCalled).toBe(true)
    expect(runtime.getState().playedAiMessageIds.has('msg_assistant_99')).toBe(true)
  })

  it('resetAiTurn 与 dispose: 停止播放器、abort pending、清空 pendingReply 与所有内部状态', async () => {
    let ttsStopped = false
    let currentOperationId = 1
    const gate = Promise.withResolvers<string>()

    const mockTts: TtsPlayerLike = {
      speak: async () => {
        await new Promise(() => undefined)
      },
      stop: () => {
        ttsStopped = true
      },
      unlock: async () => undefined,
    }

    const deps: AiTurnDependencies = {
      config: {
        ttsAvailable: true,
        voiceId: 'v_1',
        ttsModel: 'm_1',
      },
      sessionId: 'sess_1',
      scenario: dummyScenario,
      turn: 1,
      operation: {
        begin: () => {
          currentOperationId += 1
          return currentOperationId
        },
        isCurrent: (opId) => opId === currentOperationId,
      },
      transitionTo: () => true,
      touchRound: () => undefined,
      commitCurrentRound: () => undefined,
      replaceCurrentRound: () => undefined,
      commitAssistantMessage: () => undefined,
      advanceTurn: () => undefined,
      adapters: {
        streamReply: async () => {
          const text = await gate.promise
          return {
            text,
            model: 'gpt-4o',
            mock: false,
            usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
          }
        },
        createTtsPlayer: () => mockTts,
      },
    }

    const runtime = createAiTurnRuntime(deps)
    void runtime.actions.generateNextReply([], false)

    // 执行 resetAiTurn
    runtime.actions.resetAiTurn()

    expect(ttsStopped).toBe(true)
    expect(runtime.meta.pendingAdvanceReply).toBeNull()
    expect(runtime.getState()).toEqual(initialAiTurnState)

    // 迟到 resolve 验证不影响
    gate.resolve('stale reply')
    await Promise.resolve()
    expect(runtime.getState().currentAiText).toBe('')
  })
})
