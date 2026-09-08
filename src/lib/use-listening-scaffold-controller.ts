/**
 * [INPUT]: 消息/回合读写、会话所有权守卫、相手播放动作与听力支架 endpoint
 * [OUTPUT]: 提供会话内听力等级、请求状态、缓存、重听与渐进支架动作
 * [POS]: src/lib 的听力支架控制器；不拥有消息/回合 store、媒体 controller 或会话生命周期
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { useCallback, useRef, useState, type RefObject } from 'react'
import { requestListeningScaffold } from './api'
import type { ListeningScaffoldResponse } from '../../shared/listening-scaffold'
import type { ConversationMessage, ListeningScaffoldLevel, RoundRecord, SessionScenario } from '../types'

export interface ListeningRequestState { loading: boolean; error: string }

export interface UseListeningScaffoldControllerOptions {
  messagesRef: RefObject<ConversationMessage[]>
  rounds: RoundRecord[]
  currentRound: RoundRecord | null
  scenario: SessionScenario | null
  sessionId: string
  activeAiMessageId: string | null
  pausedAiMessageId: string | null
  isTtsActionLocked: boolean
  replaceMessages(messages: ConversationMessage[]): void
  updateRoundByTurn(turn: number, update: (round: RoundRecord) => void): void
  playAiText(text: string, replay: boolean, operationId?: number, messageId?: string): Promise<void>
  pauseAiPlayback(): void
  resumeAiPlayback(): Promise<void>
}

export function useListeningScaffoldController(options: UseListeningScaffoldControllerOptions) {
  const [levels, setLevels] = useState<Record<string, ListeningScaffoldLevel>>({})
  const [requestStates, setRequestStates] = useState<Record<string, ListeningRequestState>>({})
  const inFlight = useRef(new Set<string>())
  const setLevelAtLeast = useCallback((messageId: string, level: ListeningScaffoldLevel) => {
    setLevels((current) => (current[messageId] ?? 0) >= level ? current : { ...current, [messageId]: level })
  }, [])
  const updateRoundLevel = useCallback((turn: number, level: ListeningScaffoldLevel, transcriptRevealed = false) => {
    options.updateRoundByTurn(turn, (round) => { if (round.listeningScaffoldLevel < level) round.listeningScaffoldLevel = level; if (transcriptRevealed) round.transcriptRevealed = true })
  }, [options])
  const cache = useCallback((messageId: string, scaffold: ListeningScaffoldResponse) => {
    options.replaceMessages(options.messagesRef.current.map((message) => message.id === messageId ? { ...message, listeningScaffold: scaffold } : message))
  }, [options])
  const getLevel = useCallback((message: ConversationMessage): ListeningScaffoldLevel => {
    const round = options.currentRound?.turn === message.turn ? options.currentRound : options.rounds.find((item) => item.turn === message.turn)
    return Math.max(levels[message.id] ?? 0, round?.listeningScaffoldLevel ?? 0, message.listeningScaffold ? 2 : 0) as ListeningScaffoldLevel
  }, [levels, options])
  const replay = useCallback((message: ConversationMessage) => {
    if (options.activeAiMessageId === message.id && options.pausedAiMessageId === message.id) { void options.resumeAiPlayback(); return }
    if (options.activeAiMessageId === message.id && options.isTtsActionLocked) { options.pauseAiPlayback(); return }
    if (options.isTtsActionLocked) return
    setLevelAtLeast(message.id, 1)
    options.updateRoundByTurn(message.turn, (round) => { round.ttsReplayCount += 1; if (round.listeningScaffoldLevel < 1) round.listeningScaffoldLevel = 1 })
    void options.playAiText(message.text, false, undefined, message.id)
  }, [options, setLevelAtLeast])
  const advance = useCallback(async (message: ConversationMessage) => {
    const level = getLevel(message)
    if (level === 0) { replay(message); return }
    if (level === 1) {
      if (message.listeningScaffold) { setLevelAtLeast(message.id, 2); updateRoundLevel(message.turn, 2); return }
      if (!options.scenario || inFlight.current.has(message.id)) return
      const sessionId = options.sessionId
      inFlight.current.add(message.id); setRequestStates((current) => ({ ...current, [message.id]: { loading: true, error: '' } }))
      try {
        const scaffold = await requestListeningScaffold({ scenarioType: 'dynamic', sessionToken: options.scenario.sessionToken, turn: message.turn, partnerPromptJa: message.text })
        if (options.sessionId !== sessionId || options.messagesRef.current.every((item) => item.id !== message.id)) return
        cache(message.id, scaffold); setLevelAtLeast(message.id, 2); updateRoundLevel(message.turn, 2); setRequestStates((current) => ({ ...current, [message.id]: { loading: false, error: '' } }))
      } catch (error) {
        if (options.sessionId !== sessionId) return
        setRequestStates((current) => ({ ...current, [message.id]: { loading: false, error: error instanceof Error ? error.message : '关键信息获取失败，请重试。' } }))
      } finally { inFlight.current.delete(message.id); if (options.sessionId === sessionId) setRequestStates((current) => ({ ...current, [message.id]: { loading: false, error: current[message.id]?.error ?? '' } })) }
      return
    }
    if (level === 2) { setLevelAtLeast(message.id, 3); updateRoundLevel(message.turn, 3, true); return }
    if (level === 3) { setLevelAtLeast(message.id, 4); updateRoundLevel(message.turn, 4) }
  }, [cache, getLevel, options, replay, setLevelAtLeast, updateRoundLevel])
  const reset = useCallback(() => { inFlight.current.clear(); setLevels({}); setRequestStates({}) }, [])
  return { requestStates, cache, getLevel, replay, advance, reset }
}
