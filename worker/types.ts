export type ScenarioId =
  | 'weekend-chat'
  | 'order-change'
  | 'schedule-change'
  | 'work-progress'
  | 'conversation-repair'

export interface ScenarioCatalogItem {
  id: ScenarioId
  version: number
}

export interface ScenarioVariantDefinition {
  id: string
  titleZh: string
  summaryZh: string
  aiRole: string
  firstLine: string
  userGoal: string
  completionCriteria: string
  followUpStrategy: string
  worldFacts: string
  safetyNote: string
}

export interface ScenarioDefinition {
  id: ScenarioId
  version: number
  variants: readonly ScenarioVariantDefinition[]
}

export interface TrainingGoal {
  id: string
  titleZh: string
  descriptionZh: string
}

export interface DynamicScenarioDefinition {
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

export interface ScenarioTokenPayload {
  schemaVersion: 1
  kind: 'scenario'
  issuedAt: number
  expiresAt: number
  scenario: DynamicScenarioDefinition
}

export interface SessionTokenPayload {
  schemaVersion: 1
  kind: 'session'
  issuedAt: number
  expiresAt: number
  scenario: DynamicScenarioDefinition
  cap: 10 | 14 | 20
  startedAt: number
}

export interface ScenarioDraftClarification {
  questionZh: string
  answerZh: string
}

export interface ScenarioDraftRequest {
  inputZh: string
  clarifications: readonly ScenarioDraftClarification[]
  forceGenerate?: boolean
}

export interface ScenarioDraftClarificationResponse {
  status: 'needs_clarification'
  questionZh: string
  optionsZh: readonly string[]
}

export interface ScenarioDraftReadyResponse {
  status: 'ready'
  scenario: DynamicScenarioDefinition
  scenarioToken: string
}

export type ScenarioDraftResponse = ScenarioDraftClarificationResponse | ScenarioDraftReadyResponse

export type ScenarioDraftModelResult =
  | ScenarioDraftClarificationResponse
  | Omit<ScenarioDraftReadyResponse, 'scenarioToken'>

export interface CatalogSessionStartRequest {
  type?: 'catalog'
  scenarioId: ScenarioId
}

export interface DynamicSessionStartRequest {
  type: 'dynamic'
  scenarioToken: string
}

export type SessionStartRequest = CatalogSessionStartRequest | DynamicSessionStartRequest

export interface CatalogSessionStartResponse {
  scenarioType?: 'catalog'
  scenarioId: ScenarioId
  scenarioVersion: number
  variantId: string
  firstLine: string
  maxTurns: number
  reveal: {
    titleZh: string
    summaryZh: string
  }
}

export interface DynamicSessionStartResponse {
  sessionId: string
  scenarioType: 'dynamic'
  sessionToken: string
  scenario: DynamicScenarioDefinition
  firstLine: string
  maxTurns: number
  recommendedMinTurns: number
  recommendedMaxTurns: number
  reveal: {
    titleZh: string
    summaryZh: string
  }
}

export type SessionStartResponse = CatalogSessionStartResponse | DynamicSessionStartResponse

export type ConversationRole = 'assistant' | 'user'

export interface ConversationMessage {
  role: ConversationRole
  text: string
}

export interface CatalogReplyRequest {
  scenarioType?: 'catalog'
  sessionId: string
  scenarioId: ScenarioId
  scenarioVersion: number
  variantId: string
  turn: number
  model?: string
  baseUrl?: string
  history: ConversationMessage[]
}

export interface DynamicReplyRequest {
  scenarioType: 'dynamic'
  sessionToken: string
  sessionId: string
  turn: number
  history: ConversationMessage[]
}

export type ReplyRequest = CatalogReplyRequest | DynamicReplyRequest

export interface CatalogHintRequest {
  scenarioType: 'catalog'
  scenarioId: ScenarioId
  variantId: string
  history: ConversationMessage[]
  lastAssistantText: string
}

export interface DynamicHintRequest {
  scenarioType: 'dynamic'
  sessionToken: string
  history: ConversationMessage[]
  lastAssistantText: string
}

export type HintRequest = CatalogHintRequest | DynamicHintRequest

export interface HintResponse {
  directionZh: string
  keyPhrasesJa: string[]
  sentenceStarterJa: string
  fullExampleJa: string
}

export interface CatalogRescueRequest {
  scenarioType?: 'catalog'
  scenarioId: ScenarioId
  variantId: string
  turn: number
  aiPrompt: string
  userFinal: string
  history: ConversationMessage[]
}

export interface DynamicRescueRequest {
  scenarioType: 'dynamic'
  sessionToken?: string
  dynamicData?: DynamicScenarioDefinition
  turn: number
  aiPrompt: string
  userFinal: string
  history: ConversationMessage[]
}

export type RescueRequest = CatalogRescueRequest | DynamicRescueRequest

export interface RescueResponse {
  interpretedIntentZh: string
  suggestedJa: string
  politenessTipZh: string
}

export interface SessionCheckpointRequest {
  sessionToken: string
  turn: number
  history: ConversationMessage[]
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

export interface TokenRequest {
  type: 'realtime_scribe' | 'tts_websocket'
}

export interface UsageSummary {
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
}

export interface ReplyDoneEvent {
  type: 'done'
  text: string
  model: string
  mock: boolean
  usage: UsageSummary
}

export type ReplyStreamEvent =
  | { type: 'delta'; text: string }
  | ReplyDoneEvent
  | { type: 'error'; code: string; message: string }

export interface TranscriptRecord {
  turn: number
  aiPrompt: string
  userOriginal: string
  userCleaned: string
  userFinal: string
}

export interface CatalogFeedbackRequest {
  scenarioType: 'catalog'
  scenarioId: ScenarioId
  variantId: string
  totalTurns: number
  history: ConversationMessage[]
  transcriptRecords: TranscriptRecord[]
}

export interface DynamicFeedbackRequest {
  scenarioType: 'dynamic'
  sessionToken: string
  totalTurns: number
  history: ConversationMessage[]
  transcriptRecords: TranscriptRecord[]
}

export type ConversationFeedbackRequest = CatalogFeedbackRequest | DynamicFeedbackRequest

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

