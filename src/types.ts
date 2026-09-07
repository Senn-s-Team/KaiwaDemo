/**
 * [INPUT]: 依赖浏览器会话编排、动态场景协议、共享听力支架协议与语音续说辅助观测数据
 * [OUTPUT]: 对外提供前端会话、四级支架、反馈、恢复、指标与报告领域类型
 * [POS]: src 的前端领域类型总入口，统一动态会话与可序列化消息缓存的数据形状
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import type { ListeningScaffoldResponse } from '../shared/listening-scaffold'

export type AppPhase =
  | 'loading_config'
  | 'idle'
  | 'fetching_token'
  | 'connecting_stt'
  | 'waiting_user'
  | 'recording'
  | 'finalizing_transcript'
  | 'confirming_transcript'
  | 'requesting_llm'
  | 'preparing_tts'
  | 'playing_ai'
  | 'round_complete'
  | 'session_complete'
  | 'error'

export type IntegrationMode = 'real' | 'partial' | 'mock'
export type ListeningScaffoldLevel = 0 | 1 | 2 | 3 | 4



export interface ScenarioReveal {
  titleZh: string
  summaryZh: string
}
export interface TrainingGoal {
  id: string
  titleZh: string
  descriptionZh: string
}

export interface DynamicScenarioData {
  id: string
  version: number
  titleZh: string
  summaryZh: string
  aiRole: string
  userRole: string
  relationship: string
  tone: string
  firstLine: string
  userGoal: string
  coreGoal: TrainingGoal
  communicationFunction: string
  initialFacts: readonly string[]
  partnerPrivateFacts: readonly string[]
  keyIntents: readonly string[]
  keyInformation: readonly string[]
  completionRules: {
    completed: readonly string[]
    partial: readonly string[]
    notCompleted: readonly string[]
  }
  closingRules: readonly string[]
  maxTurns: 5
  partnerOpeningPlan: string
  worldAnchors: readonly string[]
  followUpPrinciples: readonly string[]
  hintStrategy: string
  feedbackFocus: readonly string[]
  safetyBoundary: string
}

export interface SessionScenario {
  id: string
  version: number
  variantId: string
  firstLine: string
  maxTurns: 5
  reveal: ScenarioReveal
  scenarioType: 'dynamic'
  sessionToken: string
  scenarioToken: string
  dynamicData: DynamicScenarioData
}

export interface ScenarioDraftClarification {
  questionZh: string
  answerZh: string
}

export interface ScenarioDraftClarificationResponse {
  status: 'needs_clarification'
  questionZh: string
  optionsZh: readonly string[]
}

export interface ScenarioDraftReadyResponse {
  status: 'ready'
  scenario: DynamicScenarioData
  scenarioToken: string
}

export type ScenarioDraftResponse = ScenarioDraftClarificationResponse | ScenarioDraftReadyResponse

export interface HintResponse {
  directionZh: string
  keyPhrasesJa: string[]
  sentenceStarterJa: string
  fullExampleJa: string
}

export type FeedbackOutcome = 'completed' | 'partial' | 'not_completed' | 'insufficient_evidence'

export interface ListeningFinding {
  turn: number
  findingZh: string
  evidenceZh: string
}

export interface ExpressionImprovement {
  turn: number
  userConfirmedJa: string
  suggestedJa: string
  reasonZh: string
}

export interface RedoTask {
  turn: number
  partnerPromptJa: string
  firstConfirmedJa: string
  directionZh: string
}

export interface ConversationFeedbackResponse {
  outcome: FeedbackOutcome
  outcomeEvidenceZh: string
  listeningFinding: ListeningFinding | null
  expressionImprovement: ExpressionImprovement | null
  redoTask: RedoTask
}

export interface FeedbackTranscriptRecord {
  turn: number
  partnerPromptJa: string
  userOriginal: string
  userCleaned: string
  userConfirmed: string
  inputMode: 'stt' | 'text'
  transcriptModified: boolean
  rerecordCount: number
  partnerAudioPlayCount: number
  ttsReplayCount: number
  transcriptRevealed: boolean
  listeningScaffoldLevel: ListeningScaffoldLevel
  expressionScaffoldLevel: 0 | 1 | 2 | 3 | 4
  failureCount: number
  retryCount: number
  textFallback: boolean
  speechAssistUsed: boolean
}

export interface ConversationFeedbackRequest {
  scenarioType: 'dynamic'
  sessionToken: string
  turnRecords: FeedbackTranscriptRecord[]
}

export interface RedoFeedbackRequest {
  scenarioType: 'dynamic'
  sessionToken: string
  turn: number
  partnerPromptJa: string
  firstConfirmedJa: string
  secondConfirmedJa: string
  secondInputMode: 'stt' | 'text'
  secondListeningScaffoldLevel: ListeningScaffoldLevel
  secondExpressionScaffoldLevel: 0 | 1 | 2 | 3 | 4
}

export interface RedoFeedbackResponse {
  comparisonZh: string
  referenceExpressionJa: string
}

export type FeedbackLoadingState = 'idle' | 'loading' | 'success' | 'error'

export interface PrototypeConfig {
  mode: IntegrationMode
  limits: { maxTurns: 5 }
  elevenlabs: {
    sttAvailable: boolean
    ttsAvailable: boolean
    voiceId: string | null
    sttModel: string
    ttsModel: string
  }
  openai: {
    available: boolean
    model: string
    mockAllowed: boolean
  }
}

export interface TranscriptText {
  rawText: string
  cleanedText: string
  finalText: string
}

export interface ConversationMessage {
  id: string
  turn: number
  role: 'assistant' | 'user'
  text: string
  transcript?: TranscriptText
  listeningScaffold?: ListeningScaffoldResponse
}

export interface RoundTiming {
  firstSpeechAt: number | null
  recordingStartedAt: number | null
  recordingStoppedAt: number | null
  transcriptFinalizedAt: number | null
  transcriptConfirmedAt: number | null
  llmStartedAt: number | null
  llmFirstTextAt: number | null
  llmCompletedAt: number | null
  ttsStartedAt: number | null
  ttsFirstAudioAt: number | null
  audioStartedAt: number | null
  audioCompletedAt: number | null
}

export interface UsageSummary {
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
}

export interface SpeechAssistEvent {
  turn: number
  requestVersion: number
  observedTextJa: string
  cleanedObservedTextJa: string | null
  continuationSuggestionJa: string | null
  displayed: boolean
  latencyMs: number
  failureReason: 'timeout' | 'aborted' | 'stale_version' | 'network_error' | 'validation_error' | 'server_error' | null
}


export interface RoundRecord {
  turn: number
  aiPrompt: string
  inputMode: 'stt' | 'text'
  userOriginal: string
  userCleaned: string
  userFinal: string
  expressionScaffoldLevel: 0 | 1 | 2 | 3 | 4
  listeningScaffoldLevel: ListeningScaffoldLevel
  transcriptRevealed: boolean
  transcriptModified: boolean
  transcriptModificationCount: number
  rerecordCount: number
  ttsReplayCount: number
  sttSessionCount: number
  sttAudioMilliseconds: number
  llmRequestCount: number
  ttsRequestCount: number
  ttsCharacterCount: number
  failureCount: number
  retryCount: number
  nextAiReply: string | null
  llmModel: string | null
  llmMock: boolean
  usage: UsageSummary
  timing: RoundTiming
  speechAssistEvents: SpeechAssistEvent[]
}
export interface RedoRecord {
  turn: number
  partnerPromptJa: string
  firstConfirmedJa: string
  secondConfirmedJa: string
  inputMode: 'stt' | 'text'
  listeningScaffoldLevel: ListeningScaffoldLevel
  expressionScaffoldLevel: 0 | 1 | 2 | 3 | 4
  comparisonZh: string
  referenceExpressionJa: string
}


export interface SessionReport {
  schemaVersion: 3
  sessionId: string
  mode: IntegrationMode
  scenarioId: string
  scenarioVersion: number
  variantId: string
  reveal: ScenarioReveal
  startedAt: number
  endedAt: number
  durationMilliseconds: number
  rounds: RoundRecord[]
  redos: RedoRecord[]
  totals: {
    rerecordCount: number
    ttsReplayCount: number
    sttSessionCount: number
    sttAudioMilliseconds: number
    llmRequestCount: number
    ttsRequestCount: number
    ttsCharacterCount: number
    failureCount: number
    retryCount: number
    inputTokens: number | null
    outputTokens: number | null
    expressionScaffoldLevelTotal: number
    expressionScaffoldRoundsCount: number
    transcriptModificationCount: number
    avgSpeechStartLatencyMs: number | null
  }
  completion: {
    maxTurns: 5
    finalTurn: number
    reason: 'turn_budget'
    closedNaturally: boolean
  }
  recovery: {
    failureCount: number
    retryCount: number
    speechAssistRequestCount: number
    speechAssistDisplayedCount: number
  }
  costNotes: string[]
}

export interface UiError {
  code: string
  title: string
  message: string
  recovery: 'retry' | 'text_input' | 'restart' | 'skip_tts'
}
