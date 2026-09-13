/**
 * [INPUT]: 依赖 ../shared wire contracts 的判别式开场、反馈与听力支架协议，以及 Worker 会话及报告约定
 * [OUTPUT]: 除 shared/ 外的 Worker 动态场景、双开场会话、响应与模型领域类型（会话启动含 telemetry token）
 * [POS]: Worker 内部领域类型边界
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */

export type {
  FeedbackTurnRecord,
  ConversationFeedbackRequest,
  ConversationFeedbackResponse,
  RedoFeedbackRequest,
  RedoFeedbackResponse,
} from '../shared/feedback-task'
import type {
  FeedbackTurnRecord,
} from '../shared/feedback-task'
import type { ScenarioOpening } from '../shared/scenario-draft'

export interface TrainingGoal {
  id: string
  titleZh: string
  descriptionZh: string
}

export interface DynamicScenarioDefinition {
  id: string
  version: number
  evaluationVersion?: number
  evidencePoints?: readonly TrainingGoal[]
  titleZh: string
  summaryZh: string
  aiRole: string
  userRole: string
  relationship: string
  tone: string
  opening: ScenarioOpening
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

export interface ScenarioDraftCapabilityPayload {
  schemaVersion: 1
  kind: 'scenario_draft'
  issuedAt: number
  expiresAt: number
  taskId: string
}

export interface FeedbackTaskCapabilityPayload {
  schemaVersion: 1
  kind: 'feedback_task'
  issuedAt: number
  expiresAt: number
  taskId: string
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
  practiceToken?: string
}

export type ScenarioDraftResponse = ScenarioDraftClarificationResponse | ScenarioDraftReadyResponse

export type ScenarioDraftModelResult =
  | ScenarioDraftClarificationResponse
  | Omit<ScenarioDraftReadyResponse, 'scenarioToken' | 'practiceToken'>

export interface SessionStartRequest {
  type: 'dynamic'
  scenarioToken: string
}

export interface SessionStartResponse {
  practiceToken?: string
  telemetryToken: string
  sessionId: string
  scenarioType: 'dynamic'
  sessionToken: string
  scenario: DynamicScenarioDefinition
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
  lastPartnerText: string | null
  intentionZh?: string
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

export type InputMode = FeedbackTurnRecord['inputMode']
export type ListeningScaffoldLevel = FeedbackTurnRecord['listeningScaffoldLevel']
export type ExpressionScaffoldLevel = FeedbackTurnRecord['expressionScaffoldLevel']

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
  partnerPromptJa: string | null
  firstConfirmedJa: string
  directionZh: string
}

export interface EvidenceResult {
  pointId: string
  status: 'completed' | 'not_completed' | 'not_observed' | 'insufficient_evidence'
  evidence: { turn: number; quoteJa: string }[]
}
