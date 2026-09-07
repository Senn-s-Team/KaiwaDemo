/**
 * [INPUT]: 依赖 Worker 路由、模型与 token 流程约定的动态场景、四级支架和会话数据形状
 * [OUTPUT]: 对外提供 Worker 动态场景、会话、反馈与模型交互领域类型
 * [POS]: worker 的服务端领域协议入口，约束五回合动态场景、L0-L4 支架及请求响应数据形状
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */

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

export interface SessionStartRequest {
  type: 'dynamic'
  scenarioToken: string
}

export interface SessionStartResponse {
  sessionId: string
  scenarioType: 'dynamic'
  sessionToken: string
  scenario: DynamicScenarioDefinition
  firstLine: string
  maxTurns: 5
  reveal: {
    titleZh: string
    summaryZh: string
  }
}

export type ConversationRole = 'assistant' | 'user'

export interface ConversationMessage {
  role: ConversationRole
  text: string
}

export interface ReplyRequest {
  scenarioType: 'dynamic'
  sessionToken: string
  sessionId: string
  turn: number
  history: ConversationMessage[]
}

export interface HintRequest {
  scenarioType: 'dynamic'
  sessionToken: string
  history: ConversationMessage[]
  lastAssistantText: string
}

export interface HintResponse {
  directionZh: string
  keyPhrasesJa: string[]
  sentenceStarterJa: string
  fullExampleJa: string
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

export type InputMode = 'stt' | 'text'
export type ListeningScaffoldLevel = 0 | 1 | 2 | 3 | 4
export type ExpressionScaffoldLevel = 0 | 1 | 2 | 3 | 4

export interface FeedbackTurnRecord {
  turn: number
  partnerPromptJa: string
  userOriginal: string
  userCleaned: string
  userConfirmed: string
  inputMode: InputMode
  transcriptModified: boolean
  rerecordCount: number
  partnerAudioPlayCount: number
  ttsReplayCount: number
  transcriptRevealed: boolean
  listeningScaffoldLevel: ListeningScaffoldLevel
  expressionScaffoldLevel: ExpressionScaffoldLevel
  failureCount: number
  retryCount: number
  textFallback: boolean
  speechAssistUsed: boolean
}

export interface ConversationFeedbackRequest {
  scenarioType: 'dynamic'
  sessionToken: string
  turnRecords: FeedbackTurnRecord[]
}

export type FeedbackOutcome = 'completed' | 'partial' | 'not_completed' | 'insufficient_evidence'

export interface FeedbackListeningFinding {
  turn: number
  findingZh: string
  evidenceZh: string
}

export interface FeedbackExpressionImprovement {
  turn: number
  userConfirmedJa: string
  suggestedJa: string
  reasonZh: string
}

export interface FeedbackRedoTask {
  turn: number
  partnerPromptJa: string
  firstConfirmedJa: string
  directionZh: string
}

export interface ConversationFeedbackResponse {
  outcome: FeedbackOutcome
  outcomeEvidenceZh: string
  listeningFinding: FeedbackListeningFinding | null
  expressionImprovement: FeedbackExpressionImprovement | null
  redoTask: FeedbackRedoTask
}

export interface RedoFeedbackRequest {
  scenarioType: 'dynamic'
  sessionToken: string
  turn: number
  partnerPromptJa: string
  firstConfirmedJa: string
  secondConfirmedJa: string
  secondInputMode: InputMode
  secondListeningScaffoldLevel: ListeningScaffoldLevel
  secondExpressionScaffoldLevel: ExpressionScaffoldLevel
}

export interface RedoFeedbackResponse {
  comparisonZh: string
  referenceExpressionJa: string
}

