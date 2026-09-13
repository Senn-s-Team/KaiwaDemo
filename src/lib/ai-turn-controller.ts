/**
 * [INPUT]: 依赖 ./api 的 streamReply 与 ReplyResult，./tts 的 CachedTtsPlayer/TtsCancelledError，./session 的 decideNextSessionStep/createMessageId，./metrics 的 createRoundRecord，./ui 的 toUiError
 * [OUTPUT]: 对外提供 useAiTurnController、自包含运行时与判别式相手开场初始化动作，保持暂停/继续、播放降级及五次用户确认推进
 * [POS]: src/lib 的相手 AI 回合控制器深模块，闭环拥有真实相手发话、TTS 语音播放/暂停/继续/降级、五次用户确认后的自然收束
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { useEffect, useLayoutEffect, useReducer, useState } from 'react'
import { streamReply, type ReplyResult } from './api'
import { createMessageId, decideNextSessionStep } from './session'
import { createRoundRecord } from './metrics'
import { CachedTtsPlayer, TtsCancelledError, type SpeakOptions } from './tts'
import { toUiError } from './ui'
import type { AppPhase, ConversationMessage, RoundRecord, SessionScenario, UiError } from '../types'

export interface TtsPlayerLike {
  speak: (options: SpeakOptions) => Promise<unknown>
  stop: () => void
  pause?: () => boolean
  resume?: () => Promise<boolean>
  unlock: () => Promise<void>
}
export interface AiTurnAdapters {
  streamReply?: (
    sessionId: string,
    turn: number,
    messages: ConversationMessage[],
    scenario: Pick<SessionScenario, 'sessionToken'>,
    onFirstText: () => void,
    signal?: AbortSignal,
  ) => Promise<ReplyResult>
  createTtsPlayer?: () => TtsPlayerLike
}

export interface AiTurnDependencies {
  config: {
    ttsAvailable: boolean
    voiceId: string | null
    ttsModel: string
  } | null
  sessionId: string
  scenario: SessionScenario | null
  turn: number
  operation: {
    begin: () => number
    isCurrent: (operationId: number) => boolean
  }
  transitionTo: (nextPhase: AppPhase) => boolean
  touchRound: (update: (round: RoundRecord) => void) => void
  commitCurrentRound: () => void
  replaceCurrentRound: (round: RoundRecord | null) => void
  commitAssistantMessage: (message: ConversationMessage) => void
  advanceTurn: (nextTurn: number) => void
  prefetchSttToken?: () => Promise<string | null>
  onSessionComplete?: () => void
  adapters?: AiTurnAdapters
}

export interface AiTurnState {
  currentAiText: string
  aiTextRevealed: boolean
  activeAiMessageId: string | null
  playedAiMessageIds: Set<string>
  expandedAiMessageIds: Set<string>
  pausedAiMessageId: string | null
  reviewAudioNotice: string
  aiError: UiError | null
  lastFailedStep: 'llm' | 'tts' | null
}

export type AiTurnAction =
  | { type: 'LLM_START' }
  | { type: 'LLM_SUCCESS'; replyText: string }
  | { type: 'SET_ACTIVE_AI_MESSAGE'; messageId: string | null }
  | { type: 'MARK_AI_MESSAGE_PLAYED'; messageId: string }
  | { type: 'SET_PAUSED_AI_MESSAGE'; messageId: string | null }
  | { type: 'TOGGLE_EXPAND_AI_MESSAGE'; messageId: string }
  | { type: 'SET_AI_TEXT_REVEALED'; revealed: boolean }
  | { type: 'TOGGLE_AI_TEXT_REVEALED' }
  | { type: 'SET_REVIEW_AUDIO_NOTICE'; notice: string }
  | { type: 'SET_AI_ERROR'; error: UiError; step: 'llm' | 'tts' }
  | { type: 'CLEAR_AI_ERROR' }
  | { type: 'RESET_AI_TURN' }

export const initialAiTurnState: AiTurnState = {
  currentAiText: '',
  aiTextRevealed: false,
  activeAiMessageId: null,
  playedAiMessageIds: new Set<string>(),
  expandedAiMessageIds: new Set<string>(),
  pausedAiMessageId: null,
  reviewAudioNotice: '',
  aiError: null,
  lastFailedStep: null,
}

export function aiTurnReducer(state: AiTurnState, action: AiTurnAction): AiTurnState {
  switch (action.type) {
    case 'LLM_START':
      return {
        ...state,
        aiError: null,
        lastFailedStep: null,
      }
    case 'LLM_SUCCESS':
      return {
        ...state,
        currentAiText: action.replyText,
        aiTextRevealed: false,
        aiError: null,
        lastFailedStep: null,
      }
    case 'SET_ACTIVE_AI_MESSAGE':
      return {
        ...state,
        activeAiMessageId: action.messageId,
      }
    case 'SET_PAUSED_AI_MESSAGE':
      return {
        ...state,
        pausedAiMessageId: action.messageId,
      }
    case 'MARK_AI_MESSAGE_PLAYED': {
      if (state.playedAiMessageIds.has(action.messageId)) return state
      const next = new Set(state.playedAiMessageIds)
      next.add(action.messageId)
      return {
        ...state,
        playedAiMessageIds: next,
      }
    }
    case 'TOGGLE_EXPAND_AI_MESSAGE': {
      const next = new Set(state.expandedAiMessageIds)
      if (next.has(action.messageId)) {
        next.delete(action.messageId)
      } else {
        next.add(action.messageId)
      }
      return {
        ...state,
        expandedAiMessageIds: next,
      }
    }
    case 'SET_AI_TEXT_REVEALED':
      return {
        ...state,
        aiTextRevealed: action.revealed,
      }
    case 'TOGGLE_AI_TEXT_REVEALED':
      return {
        ...state,
        aiTextRevealed: !state.aiTextRevealed,
      }
    case 'SET_REVIEW_AUDIO_NOTICE':
      return {
        ...state,
        reviewAudioNotice: action.notice,
      }
    case 'SET_AI_ERROR':
      return {
        ...state,
        aiError: action.error,
        lastFailedStep: action.step,
      }
    case 'CLEAR_AI_ERROR':
      return {
        ...state,
        aiError: null,
        lastFailedStep: null,
      }
    case 'RESET_AI_TURN':
      return {
        ...initialAiTurnState,
        playedAiMessageIds: new Set<string>(),
        expandedAiMessageIds: new Set<string>(),
      }
  }
}

export interface AiTurnActions {
  generateNextReply: (history: ConversationMessage[], retry: boolean) => Promise<void>
  playAiText: (
    text: string,
    advanceAfterPlayback: boolean,
    existingOperationId?: number,
    messageId?: string,
  ) => Promise<void>
  stopAiPlayback: () => void
  releaseAiPlayback: () => void
  pauseAiPlayback: () => void
  resumeAiPlayback: () => Promise<void>
  skipFailedTts: () => void
  playReviewAudio: (text: string) => Promise<void>
  toggleExpandAiMessage: (messageId: string) => void
  toggleAiTextRevealed: () => void
  setAiTextRevealed: (revealed: boolean) => void
  initPartnerOpening: (partnerLineJa: string, operationId: number, messageId: string) => Promise<void>
  clearAiError: () => void
  interruptPlaybackForBackground: () => void
  resetAiTurn: () => void
  dispose: () => void
  unlockAudio: () => Promise<void>
}

export interface AiTurnController {
  state: AiTurnState
  actions: AiTurnActions
  meta: {
    pendingAdvanceReply: string | null
    isTtsActionLocked: boolean
    isPlaybackPaused: boolean
  }
}

export interface AiTurnRuntime {
  getState: () => AiTurnState
  dispatch: (action: AiTurnAction) => void
  actions: AiTurnActions
  updateDependencies: (nextDeps: AiTurnDependencies) => void
  meta: {
    pendingAdvanceReply: string | null
    isTtsActionLocked: boolean
    isPlaybackPaused: boolean
  }
}

export function createAiTurnRuntime(
  initialDeps: AiTurnDependencies,
  initialState = initialAiTurnState,
  onStateChange?: (state: AiTurnState) => void,
): AiTurnRuntime {
  let currentDeps = initialDeps
  let state = initialState
  const dispatch = (action: AiTurnAction) => {
    state = aiTurnReducer(state, action)
    onStateChange?.(state)
  }

  const streamFn = initialDeps.adapters?.streamReply ?? streamReply
  const ttsPlayer: TtsPlayerLike = initialDeps.adapters?.createTtsPlayer
    ? initialDeps.adapters.createTtsPlayer()
    : new CachedTtsPlayer()

  let ttsActionLock = false
  let pendingAdvanceReply: string | null = null
  let llmAbortController: AbortController | null = null
  let playbackGeneration = 0

  const updateDependencies = (nextDeps: AiTurnDependencies) => {
    currentDeps = nextDeps
  }

  const clearAiError = () => {
    dispatch({ type: 'CLEAR_AI_ERROR' })
  }

  const toggleExpandAiMessage = (messageId: string) => {
    dispatch({ type: 'TOGGLE_EXPAND_AI_MESSAGE', messageId })
  }

  const toggleAiTextRevealed = () => {
    dispatch({ type: 'TOGGLE_AI_TEXT_REVEALED' })
  }

  const setAiTextRevealed = (revealed: boolean) => {
    dispatch({ type: 'SET_AI_TEXT_REVEALED', revealed })
  }

  const unlockAudio = () => ttsPlayer.unlock()

  const interruptPlaybackForBackground = () => {
    playbackGeneration += 1
    llmAbortController?.abort('background_interruption')
    llmAbortController = null
    ttsPlayer.stop()
    ttsActionLock = false
  }

  const dispose = () => {
    playbackGeneration += 1
    dispatch({ type: 'SET_PAUSED_AI_MESSAGE', messageId: null })
    llmAbortController?.abort('disposed')
    llmAbortController = null
    ttsPlayer.stop()
    ttsActionLock = false
    pendingAdvanceReply = null
  }

  const resetAiTurn = () => {
    dispose()
    dispatch({ type: 'RESET_AI_TURN' })
  }

  const finalizeAndAdvance = (reply: string) => {
    pendingAdvanceReply = null
    currentDeps.commitCurrentRound()

    const decision = decideNextSessionStep(currentDeps.turn)
    if (decision.action === 'complete') {
      currentDeps.replaceCurrentRound(null)
      currentDeps.onSessionComplete?.()
      return
    }

    const nextTurn = decision.nextTurn ?? currentDeps.turn + 1
    const nextRound = createRoundRecord(nextTurn, reply, 0)
    currentDeps.replaceCurrentRound(nextRound)
    currentDeps.advanceTurn(nextTurn)
    currentDeps.transitionTo('waiting_user')
  }

  const playAiText = async (
    text: string,
    advanceAfterPlayback: boolean,
    existingOperationId?: number,
    messageId?: string,
  ) => {
    if (!currentDeps.config || ttsActionLock) return
    const operationId = existingOperationId ?? currentDeps.operation.begin()
    if (!currentDeps.operation.isCurrent(operationId)) return

    playbackGeneration += 1
    dispatch({ type: 'SET_PAUSED_AI_MESSAGE', messageId: null })
    const currentGeneration = playbackGeneration

    ttsActionLock = true
    if (advanceAfterPlayback) {
      pendingAdvanceReply = text
    }
    dispatch({ type: 'SET_ACTIVE_AI_MESSAGE', messageId: messageId ?? null })
    dispatch({ type: 'CLEAR_AI_ERROR' })

    if (!currentDeps.config.ttsAvailable || !currentDeps.config.voiceId) {
      dispatch({
        type: 'SET_AI_ERROR',
        error: {
          code: 'tts_unconfigured',
          title: '相手语音暂不可用',
          message: '暂时无法播放相手语音。可以显示文字继续。',
          recovery: 'skip_tts',
        },
        step: 'tts',
      })
      currentDeps.transitionTo('error')
      ttsActionLock = false
      dispatch({ type: 'SET_ACTIVE_AI_MESSAGE', messageId: null })
      return
    }

    currentDeps.transitionTo('preparing_tts')
    try {
      await ttsPlayer.speak({
        text,
        voiceId: currentDeps.config.voiceId,
        modelId: currentDeps.config.ttsModel,
        onGenerationStarted: () => {
          if (!currentDeps.operation.isCurrent(operationId) || playbackGeneration !== currentGeneration) return
          currentDeps.touchRound((round) => {
            round.timing.ttsStartedAt = Date.now()
          })
        },
        onFirstAudio: () => {
          if (!currentDeps.operation.isCurrent(operationId) || playbackGeneration !== currentGeneration) return
          currentDeps.touchRound((round) => {
            round.timing.ttsFirstAudioAt = Date.now()
          })
        },
        onAudioStarted: () => {
          if (!currentDeps.operation.isCurrent(operationId) || playbackGeneration !== currentGeneration) return
          currentDeps.touchRound((round) => {
            round.timing.audioStartedAt = Date.now()
          })
          currentDeps.transitionTo('playing_ai')
          void currentDeps.prefetchSttToken?.()
        },
        onAudioEnded: () => {
          if (!currentDeps.operation.isCurrent(operationId) || playbackGeneration !== currentGeneration) return
          currentDeps.touchRound((round) => {
            round.timing.audioCompletedAt = Date.now()
          })
          if (messageId) {
            dispatch({ type: 'MARK_AI_MESSAGE_PLAYED', messageId })
          }
        },
        onTtsRequest: (characters: number) => {
          if (!currentDeps.operation.isCurrent(operationId) || playbackGeneration !== currentGeneration) return
          currentDeps.touchRound((round) => {
            round.ttsRequestCount += 1
            round.ttsCharacterCount += characters
          })
        },
      })

      if (!currentDeps.operation.isCurrent(operationId) || playbackGeneration !== currentGeneration) return
      if (advanceAfterPlayback) {
        finalizeAndAdvance(text)
      } else {
        currentDeps.transitionTo('waiting_user')
      }
    } catch (error) {
      if (
        error instanceof TtsCancelledError ||
        !currentDeps.operation.isCurrent(operationId) ||
        playbackGeneration !== currentGeneration
      ) {
        return
      }
      currentDeps.touchRound((round) => {
        round.failureCount += 1
      })
      pendingAdvanceReply = advanceAfterPlayback ? text : null
      dispatch({
        type: 'SET_AI_ERROR',
        error: toUiError(error),
        step: 'tts',
      })
      currentDeps.transitionTo('error')
    } finally {
      if (playbackGeneration === currentGeneration) {
        ttsActionLock = false
        dispatch({ type: 'SET_ACTIVE_AI_MESSAGE', messageId: null })
      }
    }
  }

  const pauseAiPlayback = () => {
    const activeMessageId = state.activeAiMessageId
    if (!activeMessageId || !ttsPlayer.pause?.()) return
    dispatch({ type: 'SET_PAUSED_AI_MESSAGE', messageId: activeMessageId })
  }

  const resumeAiPlayback = async () => {
    const activeMessageId = state.pausedAiMessageId
    if (!activeMessageId) return
    if (await ttsPlayer.resume?.()) {
      dispatch({ type: 'SET_PAUSED_AI_MESSAGE', messageId: null })
    }
  }


  const stopAiPlayback = () => {
    playbackGeneration += 1
    ttsPlayer.stop()
    ttsActionLock = false
    const pendingReply = pendingAdvanceReply
    currentDeps.touchRound((round) => {
      if (round.timing.audioStartedAt !== null) {
        round.timing.audioCompletedAt = Date.now()
      }
    })
    dispatch({ type: 'SET_PAUSED_AI_MESSAGE', messageId: null })
    if (pendingReply) {
      finalizeAndAdvance(pendingReply)
    } else {
      currentDeps.transitionTo('waiting_user')
    }
  }

  // 录音切换前只释放已完成或暂停的播放资源，不推进回合或改写当前阶段。
  const releaseAiPlayback = () => {
    playbackGeneration += 1
    ttsPlayer.stop()
    ttsActionLock = false
    dispatch({ type: 'SET_ACTIVE_AI_MESSAGE', messageId: null })
    dispatch({ type: 'SET_PAUSED_AI_MESSAGE', messageId: null })
  }

  const skipFailedTts = () => {
    playbackGeneration += 1
    const pendingReply = pendingAdvanceReply
    ttsPlayer.stop()
    ttsActionLock = false
    dispatch({ type: 'SET_AI_TEXT_REVEALED', revealed: true })
    dispatch({ type: 'CLEAR_AI_ERROR' })
    if (pendingReply) {
      finalizeAndAdvance(pendingReply)
    } else {
      currentDeps.transitionTo('waiting_user')
    }
    dispatch({ type: 'SET_PAUSED_AI_MESSAGE', messageId: null })
  }

  const playReviewAudio = async (text: string) => {
    if (!currentDeps.config?.ttsAvailable || !currentDeps.config.voiceId || ttsActionLock) return
    ttsActionLock = true
    playbackGeneration += 1
    const currentGeneration = playbackGeneration

    dispatch({ type: 'SET_REVIEW_AUDIO_NOTICE', notice: '' })
    try {
      await ttsPlayer.speak({
        text,
        voiceId: currentDeps.config.voiceId,
        modelId: currentDeps.config.ttsModel,
        onGenerationStarted: () => {},
        onFirstAudio: () => {},
        onAudioStarted: () => {},
        onAudioEnded: () => {},
        onTtsRequest: () => {},
      })
    } catch (error) {
      if (!(error instanceof TtsCancelledError) && playbackGeneration === currentGeneration) {
        dispatch({
          type: 'SET_REVIEW_AUDIO_NOTICE',
          notice: '参考语音暂时无法播放，请直接阅读文字。',
        })
      }
    } finally {
      if (playbackGeneration === currentGeneration) {
        ttsActionLock = false
      }
    }
  }

  const generateNextReply = async (history: ConversationMessage[], retry: boolean) => {
    if (!currentDeps.config || !currentDeps.scenario) return
    const operationId = currentDeps.operation.begin()
    dispatch({ type: 'LLM_START' })
    currentDeps.transitionTo('requesting_llm')

    currentDeps.touchRound((round) => {
      round.llmRequestCount += 1
      if (retry) round.retryCount += 1
      round.timing.llmStartedAt = Date.now()
      round.timing.llmFirstTextAt = null
      round.timing.llmCompletedAt = null
    })

    // 若此前已有正在进行中的旧 LLM 请求，先安全 abort 它，避免并发与迟到覆盖
    llmAbortController?.abort('superseded')
    const controller = new AbortController()
    llmAbortController = controller

    try {
      const result: ReplyResult = await streamFn(
        currentDeps.sessionId,
        currentDeps.turn,
        history,
        currentDeps.scenario,
        () => {
          if (!currentDeps.operation.isCurrent(operationId)) return
          currentDeps.touchRound((round) => {
            if (round.timing.llmFirstTextAt === null) {
              round.timing.llmFirstTextAt = Date.now()
            }
          })
        },
        controller.signal,
      )

      if (controller.signal.aborted || !currentDeps.operation.isCurrent(operationId)) return

      currentDeps.touchRound((round) => {
        round.timing.llmCompletedAt = Date.now()
        round.nextAiReply = result.text
        round.llmModel = result.model
        round.llmMock = result.mock
        round.usage = result.usage
      })

      const assistantMessage: ConversationMessage = {
        id: createMessageId(currentDeps.turn + 1, 'assistant'),
        turn: currentDeps.turn + 1,
        role: 'assistant',
        text: result.text,
      }

      currentDeps.commitAssistantMessage(assistantMessage)
      dispatch({ type: 'LLM_SUCCESS', replyText: result.text })
      pendingAdvanceReply = result.text

      await playAiText(result.text, true, operationId, assistantMessage.id)
    } catch (error) {
      if (controller.signal.aborted || !currentDeps.operation.isCurrent(operationId)) return
      currentDeps.touchRound((round) => {
        round.failureCount += 1
      })
      dispatch({
        type: 'SET_AI_ERROR',
        error: toUiError(error),
        step: 'llm',
      })
      currentDeps.transitionTo('error')
    } finally {
      if (llmAbortController === controller) {
        llmAbortController = null
      }
    }
  }

  const initPartnerOpening = async (partnerLineJa: string, operationId: number, messageId: string) => {
    dispatch({ type: 'LLM_SUCCESS', replyText: partnerLineJa })
    await playAiText(partnerLineJa, false, operationId, messageId)
  }

  const actions: AiTurnActions = {
    generateNextReply,
    playAiText,
    stopAiPlayback,
    releaseAiPlayback,
    pauseAiPlayback,
    resumeAiPlayback,
    skipFailedTts,
    playReviewAudio,
    toggleExpandAiMessage,
    toggleAiTextRevealed,
    setAiTextRevealed,
    initPartnerOpening,
    clearAiError,
    interruptPlaybackForBackground,
    resetAiTurn,
    dispose,
    unlockAudio,
  }

  return {
    getState: () => state,
    dispatch,
    actions,
    updateDependencies,
    meta: {
      get pendingAdvanceReply() {
        return pendingAdvanceReply
      },
      get isTtsActionLocked() {
        return ttsActionLock
      },
      get isPlaybackPaused() {
        return state.pausedAiMessageId !== null
      },
    },
  }
}

export function useAiTurnController(deps: AiTurnDependencies): AiTurnController {
  const [, forceRender] = useReducer((s: number) => s + 1, 0)
  const [runtime] = useState(() =>
    createAiTurnRuntime(deps, initialAiTurnState, () => forceRender()),
  )

  useLayoutEffect(() => {
    runtime.updateDependencies(deps)
  })

  useEffect(() => {
    return () => {
      runtime.actions.dispose()
    }
  }, [runtime])

  return {
    state: runtime.getState(),
    actions: runtime.actions,
    meta: runtime.meta,
  }
}
