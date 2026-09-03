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

export interface ScenarioCatalogEntry {
  id: string
  version: number
}

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
  coreGoals: readonly TrainingGoal[]
  optionalGoals: readonly TrainingGoal[]
  worldAnchors: readonly string[]
  followUpPrinciples: readonly string[]
  hintStrategy: string
  feedbackFocus: readonly string[]
  safetyBoundary: string
  recommendedMinTurns: number
  recommendedMaxTurns: number
}

export interface SessionScenario {
  id: string
  version: number
  variantId: string
  firstLine: string
  maxTurns: number
  reveal: ScenarioReveal
  scenarioType?: 'catalog' | 'dynamic'
  sessionToken?: string
  scenarioToken?: string
  dynamicData?: DynamicScenarioData
  recommendedMinTurns?: number
  recommendedMaxTurns?: number
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

export interface RescueResponse {
  interpretedIntentZh: string
  suggestedJa: string
  politenessTipZh: string
}

export interface RescueRequestPayload {
  scenarioType?: 'catalog' | 'dynamic'
  scenarioId?: string
  variantId?: string
  sessionToken?: string
  dynamicData?: DynamicScenarioData
  turn: number
  aiPrompt: string
  userFinal: string
  history: ConversationMessage[]
}

export interface RescueDrawerState {
  isOpen: boolean
  turn: number
  aiPrompt: string
  userFinal: string
  loading: boolean
  error: string | null
  data: RescueResponse | null
}

export interface CompletedGoal {
  id: string
  evidence: string
}

export interface RemainingGoal {
  id: string
  titleZh: string
}

export interface SessionCheckpointResponse {
  isGoalCompleted: boolean
  completedGoals: CompletedGoal[]
  remainingGoals: RemainingGoal[]
  factsSummary: string[]
  nextDirection: string
  canExtend: boolean
  nextCap: 14 | 20 | null
  newSessionToken: string | null
}

export interface FeedbackStrength {
  quoteJa: string
  praiseZh: string
}

export interface FeedbackImprovement {
  turn: number
  type: 'grammar_fix' | 'naturalness_upgrade'
  originalQuoteJa: string
  suggestedJa: string
  reasonZh: string
}

export interface FeedbackReusableExpression {
  patternJa: string
  meaningZh: string
  usageExampleJa: string
}

export interface FeedbackMasterUpgrade {
  turn: number
  originalJa: string
  upgradedJa: string
  explanationZh: string
}

export interface FeedbackRetryTask {
  turn: number
  targetAiPromptJa: string
  userOriginalJa: string
  recommendedReferenceJa: string
  hintZh: string
}

export interface ConversationFeedbackResponse {
  isGoalCompleted: boolean
  goalSummaryZh: string
  strengths: FeedbackStrength[]
  improvements: FeedbackImprovement[]
  reusableExpressions: FeedbackReusableExpression[]
  masterUpgrade: FeedbackMasterUpgrade
  retryTask: FeedbackRetryTask
}

export interface FeedbackTranscriptRecord {
  turn: number
  aiPrompt: string
  userOriginal: string
  userCleaned: string
  userFinal: string
}

export interface CatalogFeedbackRequest {
  scenarioType: 'catalog'
  scenarioId: string
  variantId: string
  totalTurns: number
  history: Array<{ role: 'assistant' | 'user'; text: string }>
  transcriptRecords: FeedbackTranscriptRecord[]
}

export interface DynamicFeedbackRequest {
  scenarioType: 'dynamic'
  sessionToken: string
  totalTurns: number
  history: Array<{ role: 'assistant' | 'user'; text: string }>
  transcriptRecords: FeedbackTranscriptRecord[]
}

export type ConversationFeedbackRequest = CatalogFeedbackRequest | DynamicFeedbackRequest

export type FeedbackLoadingState = 'idle' | 'loading' | 'success' | 'error'

export type RetryTaskAudioState = 'idle' | 'recording' | 'confirming' | 'completed'
export type SelfAssessment = 'completed' | 'partial' | 'not_completed' | null

export interface PrototypeConfig {
  mode: IntegrationMode
  limits: { maxTurns: number }
  scenarioCatalog: ScenarioCatalogEntry[]
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

export interface RoundRecord {
  turn: number
  aiPrompt: string
  inputMode: 'stt' | 'text'
  userOriginal: string
  userCleaned: string
  userFinal: string
  hintLevelUsed: 0 | 1 | 2 | 3 | 4
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
}

export interface SessionReport {
  schemaVersion: 2
  sessionId: string
  mode: IntegrationMode
  scenarioId: string
  scenarioVersion: number
  variantId: string
  reveal: ScenarioReveal
  selfAssessment: SelfAssessment
  startedAt: number
  endedAt: number
  durationMilliseconds: number
  rounds: RoundRecord[]
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
    hintLevelTotal: number
    hintRoundsCount: number
    transcriptModificationCount: number
    avgSpeechStartLatencyMs: number | null
  }
  costNotes: string[]
}

export interface UiError {
  code: string
  title: string
  message: string
  recovery: 'retry' | 'text_input' | 'restart' | 'skip_tts'
}
