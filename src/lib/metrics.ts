/**
 * [INPUT]: 依赖 ../types 的会话/回合记录契约与 ./session 的五回合终止规则
 * [OUTPUT]: 对外提供回合指标初始化、时长计算、含 completion/recovery 事实的会话报告构建与下载
 * [POS]: src/lib 的可观测会话指标聚合层，仅从既有回合、失败/重试与实时辅助事件导出事实
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { isFinalTurn } from './session'
import type { CompletionReason, IntegrationMode, RedoRecord, RoundRecord, RoundTiming, SessionReport, SessionScenario } from '../types'

export function createTiming(): RoundTiming {
  return {
    firstSpeechAt: null,
    recordingStartedAt: null,
    recordingStoppedAt: null,
    transcriptFinalizedAt: null,
    transcriptConfirmedAt: null,
    llmStartedAt: null,
    llmFirstTextAt: null,
    llmCompletedAt: null,
    ttsStartedAt: null,
    ttsFirstAudioAt: null,
    audioStartedAt: null,
    audioCompletedAt: null,
  }
}

export function createRoundRecord(turn: number, aiPrompt: string, rerecordCount: number): RoundRecord {
  return {
    turn,
    aiPrompt,
    userOriginal: '',
    userCleaned: '',
    userFinal: '',
    expressionScaffoldLevel: 0,
    listeningScaffoldLevel: 0,
    transcriptRevealed: false,
    transcriptModified: false,
    transcriptModificationCount: 0,
    rerecordCount,
    ttsReplayCount: 0,
    sttSessionCount: 0,
    sttAudioMilliseconds: 0,
    llmRequestCount: 0,
    ttsRequestCount: 0,
    ttsCharacterCount: 0,
    failureCount: 0,
    retryCount: 0,
    nextAiReply: null,
    llmModel: null,
    inputMode: 'stt',
    llmMock: false,
    usage: { inputTokens: null, outputTokens: null, totalTokens: null },
    timing: createTiming(),
    speechAssistEvents: [],
  }
}

export function duration(start: number | null, end: number | null): number | null {
  if (start === null || end === null) return null
  return Math.max(0, end - start)
}

function sumNullable(values: Array<number | null>): number | null {
  const available = values.filter((value): value is number => value !== null)
  return available.length === 0 ? null : available.reduce((total, value) => total + value, 0)
}

export function buildSessionReport(
  sessionId: string,
  mode: IntegrationMode,
  scenario: Pick<SessionScenario, 'id' | 'version' | 'variantId' | 'reveal'>,
  startedAt: number,
  endedAt: number,
  rounds: RoundRecord[],
  redos: RedoRecord[] = [],
  completionReason?: CompletionReason,
): SessionReport {
  const finalTurnCandidate = Math.max(0, ...rounds.map((round) => round.turn))
  const resolvedCompletionReason = completionReason ?? (isFinalTurn(finalTurnCandidate) ? 'turn_budget' : 'user_exit')
  const speechStartLatencies: number[] = []
  let finalTurn = 0
  let failureCount = 0
  let retryCount = 0
  let speechAssistRequestCount = 0
  let speechAssistDisplayedCount = 0
  for (const round of rounds) {
    finalTurn = Math.max(finalTurn, round.turn)
    failureCount += round.failureCount
    retryCount += round.retryCount
    speechAssistRequestCount += round.speechAssistEvents.length
    for (const event of round.speechAssistEvents) {
      if (event.displayed) speechAssistDisplayedCount += 1
    }

    if (round.timing.firstSpeechAt !== null) {
      const baseTime = round.timing.recordingStartedAt ?? round.timing.audioCompletedAt
      if (baseTime !== null && round.timing.firstSpeechAt >= baseTime) {
        speechStartLatencies.push(round.timing.firstSpeechAt - baseTime)
      }
    }
  }

  const avgSpeechStartLatencyMs =
    speechStartLatencies.length > 0
      ? Math.round(
          speechStartLatencies.reduce((total, val) => total + val, 0) / speechStartLatencies.length,
        )
      : null

  return {
    schemaVersion: 3,
    sessionId,
    mode,
    scenarioId: scenario.id,
    scenarioVersion: scenario.version,
    variantId: scenario.variantId,
    reveal: scenario.reveal,
    startedAt,
    endedAt,
    durationMilliseconds: Math.max(0, endedAt - startedAt),
    completion: {
      maxTurns: 5,
      finalTurn,
      reason: resolvedCompletionReason,
      closedNaturally: resolvedCompletionReason === 'turn_budget' && isFinalTurn(finalTurn),
    },
    recovery: {
      failureCount,
      retryCount,
      speechAssistRequestCount,
      speechAssistDisplayedCount,
    },
    rounds,
    redos,
    totals: {
      rerecordCount: rounds.reduce((total, round) => total + round.rerecordCount, 0),
      ttsReplayCount: rounds.reduce((total, round) => total + round.ttsReplayCount, 0),
      sttSessionCount: rounds.reduce((total, round) => total + round.sttSessionCount, 0),
      sttAudioMilliseconds: rounds.reduce((total, round) => total + round.sttAudioMilliseconds, 0),
      llmRequestCount: rounds.reduce((total, round) => total + round.llmRequestCount, 0),
      ttsRequestCount: rounds.reduce((total, round) => total + round.ttsRequestCount, 0),
      ttsCharacterCount: rounds.reduce((total, round) => total + round.ttsCharacterCount, 0),
      failureCount,
      retryCount,
      inputTokens: sumNullable(rounds.map((round) => round.usage.inputTokens)),
      outputTokens: sumNullable(rounds.map((round) => round.usage.outputTokens)),
      expressionScaffoldLevelTotal: rounds.reduce((total, round) => total + round.expressionScaffoldLevel, 0),
      expressionScaffoldRoundsCount: rounds.filter((round) => round.expressionScaffoldLevel > 0).length,
      transcriptModificationCount: rounds.reduce((total, round) => total + round.transcriptModificationCount, 0),
      avgSpeechStartLatencyMs,
    },
    costNotes: [
      'OpenAI token counts come from Responses API usage when available.',
      'ElevenLabs STT cost must be reconciled with audio duration and the supplier dashboard.',
      'ElevenLabs TTS cost must be reconciled with request count, generated characters, voice/model, and the supplier dashboard.',
      'No exact currency amount is estimated without confirmed account pricing.',
      ...(rounds.some((r) => r.speechAssistEvents?.some((e) => e.displayed && e.continuationSuggestionJa !== null))
        ? ['实时语音续说建议（B）在练习中已被展示；展示该建议的回合不可认定为无表达支架完成。']
        : []),
    ],
  }
}

export function downloadReport(report: SessionReport): void {
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `kaiwa-session-${report.sessionId}.json`
  anchor.click()
  URL.revokeObjectURL(url)
}
