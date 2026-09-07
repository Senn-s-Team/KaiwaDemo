/**
 * [INPUT]: 依赖 zod、./constants、./types、../shared/listening-scaffold 与 ../shared/speech-assist 的跨端 wire schema
 * [OUTPUT]: 校验版本化证据覆盖及确认稿引用； 对外提供 Worker 请求、动态场景、反馈、四级听力支架、模型输出与语音续说数据的严格解析和安全规整函数
 * [POS]: worker 的边界校验层，在路由与模型调用前后统一拒绝无效、越界或非原文协议数据
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { z } from 'zod'
import {
  ListeningScaffoldRequestSchema,
  ListeningScaffoldResponseSchema,
  type ListeningScaffoldRequest,
  type ListeningScaffoldResponse,
} from '../shared/listening-scaffold'
import {
  SpeechAssistRequestSchema,
  SpeechAssistResponseSchema,
  type SpeechAssistRequest,
  type SpeechAssistResponse,
} from '../shared/speech-assist'
import { LIMITS } from './constants'
import type {
  ConversationFeedbackRequest,
  ConversationFeedbackResponse,
  DynamicScenarioDefinition,
  HintRequest,
  HintResponse,
  RedoFeedbackRequest,
  RedoFeedbackResponse,
  ReplyRequest,
  ScenarioDraftModelResult,
  ScenarioDraftRequest,
  SessionStartRequest,
  TokenRequest,
} from './types'

export class ValidationError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

const TokenRequestSchema = z.object({
  type: z.enum(['realtime_scribe', 'tts_websocket']),
}).strict()

const SessionStartRequestSchema = z.object({
  type: z.literal('dynamic'),
  scenarioToken: z.string().trim().min(1),
}).strict()

const ScenarioDraftClarificationSchema = z.object({
  questionZh: z.string().trim().min(1).max(120),
  answerZh: z.string().trim().min(1).max(300),
}).strict()

const ScenarioDraftRequestSchema = z.object({
  inputZh: z.string().trim().min(1).max(300),
  clarifications: z.array(ScenarioDraftClarificationSchema).max(LIMITS.maxScenarioDraftClarifications),
  forceGenerate: z.boolean().optional(),
}).strict()

const TrainingGoalSchema = z.object({
  id: z.string().trim().min(1).max(64),
  titleZh: z.string().trim().min(1).max(80),
  descriptionZh: z.string().trim().min(1).max(240),
}).strict()

const DynamicScenarioDefinitionSchema = z.object({
  id: z.string().trim().min(1).max(64),
  version: z.number().int().positive(),
  evaluationVersion: z.number().int().positive().optional(),
  evidencePoints: z.array(TrainingGoalSchema).min(1).max(5).refine(points => new Set(points.map(p => p.id)).size === points.length).optional(),
  titleZh: z.string().trim().min(1).max(100),
  summaryZh: z.string().trim().min(1).max(300),
  aiRole: z.string().trim().min(1).max(160),
  userRole: z.string().trim().min(1).max(160),
  relationship: z.string().trim().min(1).max(160),
  tone: z.string().trim().min(1).max(100),
  firstLine: z.string().trim().min(1).max(LIMITS.maxAssistantCharacters),
  userGoal: z.string().trim().min(1).max(240),
  coreGoal: TrainingGoalSchema,
  communicationFunction: z.string().trim().min(1).max(300),
  initialFacts: z.array(z.string().trim().min(1).max(240)).min(1).max(8),
  partnerPrivateFacts: z.array(z.string().trim().min(1).max(240)).max(8),
  keyIntents: z.array(z.string().trim().min(1).max(160)).min(1).max(6),
  keyInformation: z.array(z.string().trim().min(1).max(240)).min(1).max(8),
  completionRules: z.object({
    completed: z.array(z.string().trim().min(1).max(240)).min(1).max(6),
    partial: z.array(z.string().trim().min(1).max(240)).min(1).max(6),
    notCompleted: z.array(z.string().trim().min(1).max(240)).min(1).max(6),
  }).strict(),
  closingRules: z.array(z.string().trim().min(1).max(240)).min(1).max(5),
  maxTurns: z.literal(5),
  partnerOpeningPlan: z.string().trim().min(1).max(300),
  worldAnchors: z.array(z.string().trim().min(1).max(240)).min(1).max(6),
  followUpPrinciples: z.array(z.string().trim().min(1).max(240)).min(1).max(5),
  hintStrategy: z.string().trim().min(1).max(300),
  feedbackFocus: z.array(z.string().trim().min(1).max(160)).min(1).max(5),
  safetyBoundary: z.string().trim().min(1).max(300),
}).strict().refine(scenario => (scenario.evaluationVersion === undefined) === (scenario.evidencePoints === undefined), 'Evaluation version and evidence points must be provided together.')

const ScenarioDraftModelResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('needs_clarification'),
    questionZh: z.string().trim().min(1).max(120),
    optionsZh: z.array(z.string().trim().min(1).max(120)).min(2).max(4),
  }).strict(),
  z.object({
    status: z.literal('ready'),
    scenario: DynamicScenarioDefinitionSchema.refine(scenario => Boolean(scenario.evaluationVersion && scenario.evidencePoints), 'New scenarios require versioned evidence points.'),
  }).strict(),
])

const ConversationMessageSchema = z.object({
  role: z.enum(['assistant', 'user']),
  text: z.string().trim().min(1),
}).strict()

const ReplyRequestSchema = z.object({
  scenarioType: z.literal('dynamic'),
  sessionToken: z.string().trim().min(1),
  sessionId: z.string().regex(/^[a-zA-Z0-9_-]{8,64}$/),
  turn: z.number().int().min(1).max(LIMITS.maxTurns),
  history: z.array(ConversationMessageSchema).min(2).max(LIMITS.maxHistoryMessages),
}).strict().superRefine((request, context) => {
  if (request.history[0]?.role !== 'assistant' || request.history.at(-1)?.role !== 'user') {
    context.addIssue({ code: 'custom', message: 'History must start with the assistant and end with the user.' })
  }
  for (let index = 1; index < request.history.length; index += 1) {
    if (request.history[index]?.role === request.history[index - 1]?.role) {
      context.addIssue({ code: 'custom', message: 'Conversation roles must alternate.' })
      break
    }
  }
  const userTurns = request.history.filter((item) => item.role === 'user').length
  if (userTurns !== request.turn) {
    context.addIssue({ code: 'custom', message: 'History does not match the declared turn.' })
  }
  request.history.forEach((item, index) => {
    const maximum = item.role === 'user' ? LIMITS.maxUserCharacters : LIMITS.maxAssistantCharacters
    if (item.text.length > maximum) {
      context.addIssue({ code: 'custom', message: `History item ${index + 1} exceeds the text limit.` })
    }
  })
})

const HintRequestSchema = z.object({
  scenarioType: z.literal('dynamic'),
  sessionToken: z.string().trim().min(1),
  history: z.array(ConversationMessageSchema).min(1).max(LIMITS.maxHistoryMessages),
  lastAssistantText: z.string().trim().min(1).max(LIMITS.maxAssistantCharacters),
}).strict()

const KANA_REGEX = /[\u3040-\u309F\u30A0-\u30FF]/
const HintResponseSchema = z.object({
  directionZh: z.string().trim().min(1).refine(
    (value) => !KANA_REGEX.test(value),
    'directionZh must give thinking direction in Chinese without Japanese words or sentences.',
  ),
  keyPhrasesJa: z.array(z.string().trim().min(1)).min(2).max(5),
  sentenceStarterJa: z.string().trim().min(1),
  fullExampleJa: z.string().trim().min(1),
}).strict()

const InputModeSchema = z.enum(['stt', 'text'])
const ListeningScaffoldLevelSchema = z.union([
  z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4),
])
const ExpressionScaffoldLevelSchema = z.union([
  z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4),
])

const FeedbackTurnRecordSchema = z.object({
  turn: z.number().int().min(1).max(LIMITS.maxTurns),
  partnerPromptJa: z.string().trim().min(1).max(LIMITS.maxAssistantCharacters),
  userOriginal: z.string().max(LIMITS.maxUserCharacters),
  userCleaned: z.string().max(LIMITS.maxUserCharacters),
  userConfirmed: z.string().trim().min(1).max(LIMITS.maxUserCharacters),
  inputMode: InputModeSchema,
  transcriptModified: z.boolean(),
  rerecordCount: z.number().int().nonnegative().max(50),
  partnerAudioPlayCount: z.number().int().nonnegative().max(100),
  ttsReplayCount: z.number().int().nonnegative().max(99),
  transcriptRevealed: z.boolean(),
  listeningScaffoldLevel: ListeningScaffoldLevelSchema,
  expressionScaffoldLevel: ExpressionScaffoldLevelSchema,
  failureCount: z.number().int().nonnegative().max(50),
  retryCount: z.number().int().nonnegative().max(50),
  textFallback: z.boolean(),
  speechAssistUsed: z.boolean(),
}).strict().superRefine((record, context) => {
  if (record.transcriptRevealed !== (record.listeningScaffoldLevel >= 3)) {
    context.addIssue({ code: 'custom', message: 'Transcript reveal must match listening scaffold level 3 or 4.' })
  }
  if (record.listeningScaffoldLevel === 1 && record.ttsReplayCount < 1) {
    context.addIssue({ code: 'custom', message: 'Listening scaffold level 1 requires a recorded replay.' })
  }
  if (!record.textFallback && record.partnerAudioPlayCount < 1) {
    context.addIssue({ code: 'custom', message: 'Audio-first rounds require at least one partner audio play.' })
  }
  if (record.textFallback && record.inputMode !== 'text') {
    context.addIssue({ code: 'custom', message: 'Text fallback rounds must record text input mode.' })
  }
})

const ConversationFeedbackRequestSchema = z.object({
  scenarioType: z.literal('dynamic'),
  sessionToken: z.string().trim().min(1),
  turnRecords: z.array(FeedbackTurnRecordSchema).min(1).max(LIMITS.maxTurns),
}).strict().superRefine((request, context) => {
  request.turnRecords.forEach((record, index) => {
    if (record.turn !== index + 1) {
      context.addIssue({ code: 'custom', message: `Turn record must be numbered ${index + 1}.` })
    }
  })
})

const FORBIDDEN_EVALUATION_PATTERNS = /(?:发音|声调|口音|语调|情绪|能力(?:水平|等级)|掌握|熟练度|肌肉记忆|発音|声調|アクセント|イントネーション|能力レベル|習得|マスター|筋肉記憶|\b(?:[1-9]\d?|100)分\b|★|⭐|星[1-5一二三四五]|得分)/

function evaluationTextSchema() {
  return z.string().trim().min(1).refine(
    (value) => !FORBIDDEN_EVALUATION_PATTERNS.test(value),
    'Forbidden evaluation dimension in feedback output.',
  )
}
const ChineseDirectionSchema = evaluationTextSchema().refine(
  (value) => !KANA_REGEX.test(value),
  'Redo direction must be Chinese guidance without Japanese words or sentences.',
)


export const ConversationFeedbackResponseSchema = z.object({
  evaluationVersion: z.number().int().positive().optional(),
  evidenceResults: z.array(z.object({
    pointId: z.string().trim().min(1),
    status: z.enum(['completed', 'not_completed', 'not_observed', 'insufficient_evidence']),
    evidence: z.array(z.object({turn: z.number().int().min(1).max(5), quoteJa: z.string().trim().min(1)}).strict()).max(5),
  }).strict()).max(5).optional(),
  outcome: z.enum(['completed', 'partial', 'not_completed', 'insufficient_evidence']),
  outcomeEvidenceZh: evaluationTextSchema(),
  listeningFinding: z.object({
    turn: z.number().int().min(1).max(LIMITS.maxTurns),
    findingZh: evaluationTextSchema(),
    evidenceZh: evaluationTextSchema(),
  }).strict().nullable(),
  expressionImprovement: z.object({
    turn: z.number().int().min(1).max(LIMITS.maxTurns),
    userConfirmedJa: z.string().trim().min(1),
    suggestedJa: evaluationTextSchema(),
    reasonZh: evaluationTextSchema(),
  }).strict().nullable(),
  redoTask: z.object({
    turn: z.number().int().min(1).max(LIMITS.maxTurns),
    partnerPromptJa: z.string().trim().min(1),
    firstConfirmedJa: z.string().trim().min(1),
    directionZh: ChineseDirectionSchema,
  }).strict(),
}).strict()

const RedoFeedbackRequestSchema = z.object({
  scenarioType: z.literal('dynamic'),
  sessionToken: z.string().trim().min(1),
  turn: z.number().int().min(1).max(LIMITS.maxTurns),
  partnerPromptJa: z.string().trim().min(1).max(LIMITS.maxAssistantCharacters),
  firstConfirmedJa: z.string().trim().min(1).max(LIMITS.maxUserCharacters),
  secondConfirmedJa: z.string().trim().min(1).max(LIMITS.maxUserCharacters),
  secondInputMode: InputModeSchema,
  secondListeningScaffoldLevel: ListeningScaffoldLevelSchema,
  secondExpressionScaffoldLevel: ExpressionScaffoldLevelSchema,
}).strict()

export const RedoFeedbackResponseSchema = z.object({
  comparisonZh: evaluationTextSchema(),
  referenceExpressionJa: evaluationTextSchema(),
}).strict()

export function parseTokenRequest(value: unknown): TokenRequest {
  const parsed = TokenRequestSchema.safeParse(value)
  if (!parsed.success) throw new ValidationError('invalid_token_type', 'Unsupported ElevenLabs token request.')
  return parsed.data
}

export function parseSessionStartRequest(value: unknown): SessionStartRequest {
  const parsed = SessionStartRequestSchema.safeParse(value)
  if (!parsed.success) throw new ValidationError('invalid_session_start', 'Dynamic session start request is invalid.')
  return parsed.data
}

export function parseScenarioDraftRequest(value: unknown): ScenarioDraftRequest {
  const parsed = ScenarioDraftRequestSchema.safeParse(value)
  if (!parsed.success) {
    throw new ValidationError('invalid_scenario_draft_request', 'Scenario draft request is invalid.')
  }
  return parsed.data
}

export function parseScenarioDraftModelResult(value: unknown): ScenarioDraftModelResult {
  const parsed = ScenarioDraftModelResultSchema.safeParse(value)
  if (!parsed.success) {
    const details = parsed.error.issues.slice(0, 3).map((issue) => (
      `${issue.path.length > 0 ? issue.path.join('.') : '<root>'}: ${issue.message}`
    )).join('; ')
    throw new ValidationError('invalid_scenario_draft_output', details || 'Scenario draft model output is invalid.')
  }
  return parsed.data
}

export function parseDynamicScenarioDefinition(value: unknown): DynamicScenarioDefinition {
  const parsed = DynamicScenarioDefinitionSchema.safeParse(value)
  if (!parsed.success) {
    throw new ValidationError('invalid_scenario_draft_output', 'Dynamic scenario definition is invalid.')
  }
  return parsed.data
}

export function parseReplyRequest(value: unknown): ReplyRequest {
  const parsed = ReplyRequestSchema.safeParse(value)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const field = issue?.path[0]
    const code = field === 'turn' ? 'turn_limit' : field === 'history' ? 'history_limit' : 'invalid_dynamic_reply'
    throw new ValidationError(code, issue?.message || 'Dynamic conversation request is invalid.')
  }
  return parsed.data
}

export function parseHintRequest(value: unknown): HintRequest {
  const parsed = HintRequestSchema.safeParse(value)
  if (!parsed.success) throw new ValidationError('invalid_hint_request', 'Hint request is invalid.')
  return parsed.data
}

export function parseHintResponse(value: unknown): HintResponse {
  const parsed = HintResponseSchema.safeParse(value)
  if (!parsed.success) throw new ValidationError('invalid_hint_output', 'Hint model output is invalid.')
  return parsed.data
}

export function parseListeningScaffoldRequest(value: unknown): ListeningScaffoldRequest {
  const parsed = ListeningScaffoldRequestSchema.safeParse(value)
  if (!parsed.success) {
    throw new ValidationError(
      'invalid_listening_scaffold_request',
      parsed.error.issues[0]?.message || 'Listening scaffold request is invalid.',
    )
  }
  return parsed.data
}

export function parseListeningScaffoldModelOutput(
  value: unknown,
  partnerPromptJa: string,
): ListeningScaffoldResponse {
  const parsed = ListeningScaffoldResponseSchema.safeParse(value)
  if (!parsed.success) {
    throw new ValidationError(
      'invalid_listening_scaffold_output',
      parsed.error.issues[0]?.message || 'Listening scaffold model output is invalid.',
    )
  }
  if (parsed.data.keyPhrasesJa.some((phrase) => !partnerPromptJa.includes(phrase))) {
    throw new ValidationError(
      'invalid_listening_scaffold_output',
      'Every listening scaffold key phrase must be an exact substring of the current partner prompt.',
    )
  }
  return parsed.data
}

export function validateAssistantReply(value: string, turn?: number): string {
  const text = value.trim()
  if (text.length === 0 || text.length > LIMITS.maxAssistantCharacters) {
    throw new ValidationError('invalid_model_output', 'Model reply exceeded the configured text limit.')
  }
  const questionCount = (text.match(/[？?]/g) ?? []).length
  if (questionCount > 1 || (turn === LIMITS.maxTurns && questionCount > 0) || /```|^\s*[-*#]\s/m.test(text)) {
    throw new ValidationError('invalid_model_output', 'Model reply did not follow the conversation format.')
  }
  return text
}

export function parseConversationFeedbackRequest(value: unknown): ConversationFeedbackRequest {
  const parsed = ConversationFeedbackRequestSchema.safeParse(value)
  if (!parsed.success) {
    throw new ValidationError('invalid_feedback_request', parsed.error.issues[0]?.message || 'Feedback request is invalid.')
  }
  return parsed.data
}

export function parseConversationFeedbackResponse(
  value: unknown,
  turnRecords: ConversationFeedbackRequest['turnRecords'],
  scenario?: DynamicScenarioDefinition,
): ConversationFeedbackResponse {
  const parsed = ConversationFeedbackResponseSchema.safeParse(value)
  if (!parsed.success) {
    throw new ValidationError('invalid_feedback_output', parsed.error.issues[0]?.message || 'Feedback output is invalid.')
  }

  const { evidenceResults, evaluationVersion } = parsed.data
  if (scenario?.evidencePoints) {
    const ids = scenario.evidencePoints.map(point => point.id)
    if (evaluationVersion !== scenario.evaluationVersion || !evidenceResults
      || evidenceResults.length !== ids.length
      || new Set(evidenceResults.map(result => result.pointId)).size !== ids.length
      || evidenceResults.some(result => !ids.includes(result.pointId))) {
      throw new ValidationError('invalid_feedback_output', 'Evaluation must cover the exact versioned scenario evidence points.')
    }
  } else if (scenario && (evidenceResults || evaluationVersion)) {
    throw new ValidationError('invalid_feedback_output', 'Legacy scenarios have no evaluation standard.')
  }
  for (const result of evidenceResults ?? []) {
    if (result.status === 'completed' && result.evidence.length === 0) {
      throw new ValidationError('invalid_feedback_output', 'Completed evidence points require a confirmed quotation.')
    }
    for (const quote of result.evidence) {
      const record = turnRecords.find(record => record.turn === quote.turn)
      if (!record || !record.userConfirmed.includes(quote.quoteJa)) {
        throw new ValidationError('invalid_feedback_output', 'Evidence must quote the referenced confirmed utterance.')
      }
    }
  }
  const matchingRecord = (turn: number) => turnRecords.find((record) => record.turn === turn)
  const outcomeHasRealQuote = turnRecords.some((record) => parsed.data.outcomeEvidenceZh.includes(record.userConfirmed))
  if (!outcomeHasRealQuote) {
    throw new ValidationError('invalid_feedback_output', 'Outcome evidence must quote a real confirmed utterance.')
  }

  if (parsed.data.listeningFinding) {
    const finding = parsed.data.listeningFinding
    const record = matchingRecord(finding.turn)
    if (!record) throw new ValidationError('invalid_feedback_output', 'Listening finding references an unknown turn.')
    const hasFindingEvidence = record.listeningScaffoldLevel > 0
      || record.rerecordCount > 0
      || record.failureCount > 0
      || record.retryCount > 0
      || record.textFallback
    if (!hasFindingEvidence) {
      throw new ValidationError('invalid_feedback_output', 'Listening finding requires a non-default observable event.')
    }
    const citesTurn = finding.evidenceZh.includes(`第${record.turn}轮`)
    const citesObservableFact = [
      `${record.rerecordCount}次`,
      `${record.partnerAudioPlayCount}次`,
      `${record.ttsReplayCount}次`,
      `L${record.listeningScaffoldLevel}`,
      record.transcriptRevealed ? '台词' : '',
      record.textFallback ? '文本' : '',
    ].some((token) => token.length > 0 && finding.evidenceZh.includes(token))
    if (!citesTurn || !citesObservableFact) {
      throw new ValidationError('invalid_feedback_output', 'Listening evidence must cite observable facts from its turn.')
    }
  }

  if (parsed.data.expressionImprovement) {
    const improvement = parsed.data.expressionImprovement
    const record = matchingRecord(improvement.turn)
    if (!record || improvement.userConfirmedJa !== record.userConfirmed) {
      throw new ValidationError('invalid_feedback_output', 'Expression improvement must quote its real confirmed utterance.')
    }
  }

  const redoRecord = matchingRecord(parsed.data.redoTask.turn)
  if (!redoRecord
    || parsed.data.redoTask.partnerPromptJa !== redoRecord.partnerPromptJa
    || parsed.data.redoTask.firstConfirmedJa !== redoRecord.userConfirmed) {
    throw new ValidationError('invalid_feedback_output', 'Redo task must reference one real conversation turn exactly.')
  }

  return parsed.data
}

export function parseRedoFeedbackRequest(value: unknown): RedoFeedbackRequest {
  const parsed = RedoFeedbackRequestSchema.safeParse(value)
  if (!parsed.success) {
    throw new ValidationError('invalid_redo_feedback_request', parsed.error.issues[0]?.message || 'Redo feedback request is invalid.')
  }
  return parsed.data
}

export function parseRedoFeedbackResponse(
  value: unknown,
  request: RedoFeedbackRequest,
): RedoFeedbackResponse {
  const parsed = RedoFeedbackResponseSchema.safeParse(value)
  if (!parsed.success) {
    throw new ValidationError('invalid_redo_feedback_output', parsed.error.issues[0]?.message || 'Redo feedback output is invalid.')
  }
  if (!parsed.data.comparisonZh.includes(request.firstConfirmedJa)
    || !parsed.data.comparisonZh.includes(request.secondConfirmedJa)) {
    throw new ValidationError('invalid_redo_feedback_output', 'Redo comparison must quote both confirmed attempts.')
  }
  return parsed.data
}


export function parseSpeechAssistRequest(value: unknown): SpeechAssistRequest {
  const parsed = SpeechAssistRequestSchema.safeParse(value)
  if (!parsed.success) {
    throw new ValidationError('invalid_speech_assist_request', parsed.error.issues[0]?.message || 'Speech assist request is invalid.')
  }
  return parsed.data
}

const ALLOWED_PUNCTUATION_AND_SPACE_REGEX = /[\s\u3000、。，．！？!?…·・〜~「」『』（）()[\]【】"''"]/gu

export function isCharacterSubsequence(sub: string, full: string): boolean {
  const subChars = Array.from(sub)
  const fullChars = Array.from(full)
  let subIndex = 0
  for (let fullIndex = 0; fullIndex < fullChars.length && subIndex < subChars.length; fullIndex += 1) {
    if (fullChars[fullIndex] === subChars[subIndex]) {
      subIndex += 1
    }
  }
  return subIndex === subChars.length
}

export function enforceCleanedSubsequence(cleaned: string, observed: string): string {
  const strippedCleaned = cleaned.replace(ALLOWED_PUNCTUATION_AND_SPACE_REGEX, '')
  const strippedObserved = observed.replace(ALLOWED_PUNCTUATION_AND_SPACE_REGEX, '')

  if (!strippedCleaned || !isCharacterSubsequence(strippedCleaned, strippedObserved)) {
    return observed
  }
  return cleaned.trim()
}

const FORBIDDEN_SUGGESTION_CONTENT = /\d|[０-９]|円|¥|ドル|ユーロ|ではない|ではありません|じゃない|ダメ|無理|約束|必ず|絶対|どっち|どちら/

export function sanitizeContinuationSuggestion(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const charCount = Array.from(trimmed).length
  if (charCount > 20) return null
  if (FORBIDDEN_SUGGESTION_CONTENT.test(trimmed)) return null
  return trimmed
}

export function parseSpeechAssistModelOutput(value: unknown, observedTextJa: string): SpeechAssistResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError('invalid_speech_assist_output', 'Speech assist model output must be an object.')
  }
  const raw = value as Record<string, unknown>
  const rawCleaned = typeof raw.cleanedObservedTextJa === 'string' ? raw.cleanedObservedTextJa : observedTextJa
  const cleanedObservedTextJa = enforceCleanedSubsequence(rawCleaned, observedTextJa)
  const continuationSuggestionJa = sanitizeContinuationSuggestion(raw.continuationSuggestionJa)

  return SpeechAssistResponseSchema.parse({
    cleanedObservedTextJa,
    continuationSuggestionJa,
  })
}

export function parsePracticeRestartRequest(value: unknown): { practiceToken: string } {
  const result = z.object({ practiceToken: z.string().trim().min(1) }).strict().safeParse(value)
  if (!result.success) throw new ValidationError('invalid_practice_restart_request', 'Practice restart request is invalid.')
  return result.data
}
