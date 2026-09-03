import type { IntegrationMode, RoundRecord, RoundTiming, SelfAssessment, SessionReport, SessionScenario } from '../types'

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
    hintLevelUsed: 0,
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
  selfAssessment: SelfAssessment,
  startedAt: number,
  endedAt: number,
  rounds: RoundRecord[],
): SessionReport {
  const speechStartLatencies: number[] = []
  for (const round of rounds) {
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
    schemaVersion: 2,
    sessionId,
    mode,
    scenarioId: scenario.id,
    scenarioVersion: scenario.version,
    variantId: scenario.variantId,
    reveal: scenario.reveal,
    selfAssessment,
    startedAt,
    endedAt,
    durationMilliseconds: Math.max(0, endedAt - startedAt),
    rounds,
    totals: {
      rerecordCount: rounds.reduce((total, round) => total + round.rerecordCount, 0),
      ttsReplayCount: rounds.reduce((total, round) => total + round.ttsReplayCount, 0),
      sttSessionCount: rounds.reduce((total, round) => total + round.sttSessionCount, 0),
      sttAudioMilliseconds: rounds.reduce((total, round) => total + round.sttAudioMilliseconds, 0),
      llmRequestCount: rounds.reduce((total, round) => total + round.llmRequestCount, 0),
      ttsRequestCount: rounds.reduce((total, round) => total + round.ttsRequestCount, 0),
      ttsCharacterCount: rounds.reduce((total, round) => total + round.ttsCharacterCount, 0),
      failureCount: rounds.reduce((total, round) => total + round.failureCount, 0),
      retryCount: rounds.reduce((total, round) => total + round.retryCount, 0),
      inputTokens: sumNullable(rounds.map((round) => round.usage.inputTokens)),
      outputTokens: sumNullable(rounds.map((round) => round.usage.outputTokens)),
      hintLevelTotal: rounds.reduce((total, round) => total + round.hintLevelUsed, 0),
      hintRoundsCount: rounds.filter((round) => round.hintLevelUsed > 0).length,
      transcriptModificationCount: rounds.reduce((total, round) => total + round.transcriptModificationCount, 0),
      avgSpeechStartLatencyMs,
    },
    costNotes: [
      'OpenAI token counts come from Responses API usage when available.',
      'ElevenLabs STT cost must be reconciled with audio duration and the supplier dashboard.',
      'ElevenLabs TTS cost must be reconciled with request count, generated characters, voice/model, and the supplier dashboard.',
      'No exact currency amount is estimated without confirmed account pricing.',
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
