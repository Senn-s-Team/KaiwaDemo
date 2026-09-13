/**
 * [INPUT]: 依赖 zod、./constants、./types，以及 shared 下判别式场景、反馈、听力支架、语音续说与场景润色的跨端 wire schema
 * [OUTPUT]: 对外提供 scenario-draft、feedback-task、双开场动态会话、四级听力支架、语音续说与场景润色数据的严格解析；校验版本化证据覆盖、确认稿引用及跨字段协议约束
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
import {
  ScenarioPolishRequestSchema,
  ScenarioPolishResponseSchema,
  type ScenarioPolishRequest,
  type ScenarioPolishResponse,
} from '../shared/scenario-polish'
import { ScenarioDraftTaskRequestSchema, ScenarioDraftModelResultSchema as SharedScenarioDraftModelResultSchema, DynamicScenarioDefinitionSchema as SharedDynamicScenarioDefinitionSchema } from '../shared/scenario-draft'
import {
  ConversationFeedbackRequestSchema,
  ConversationFeedbackResponseSchema,
  RedoFeedbackRequestSchema,
  RedoFeedbackResponseSchema,
} from '../shared/feedback-task'
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

const ScenarioDraftRequestSchema = ScenarioDraftTaskRequestSchema
const DynamicScenarioDefinitionSchema = SharedDynamicScenarioDefinitionSchema
const ScenarioDraftModelResultSchema = SharedScenarioDraftModelResultSchema

const ConversationMessageSchema = z.object({
  role: z.enum(['assistant', 'user']),
  text: z.string().trim().min(1),
}).strict()

const ReplyRequestSchema = z.object({
  scenarioType: z.literal('dynamic'),
  sessionToken: z.string().trim().min(1),
  sessionId: z.string().regex(/^[a-zA-Z0-9_-]{8,64}$/),
  turn: z.number().int().min(1).max(LIMITS.maxTurns),
  history: z.array(ConversationMessageSchema).min(1).max(LIMITS.maxHistoryMessages),
}).strict().superRefine((request, context) => {
  if (request.history.at(-1)?.role !== 'user') {
    context.addIssue({ code: 'custom', message: 'History must end with the confirmed user turn.' })
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
  history: z.array(ConversationMessageSchema).max(LIMITS.maxHistoryMessages),
  lastPartnerText: z.string().trim().min(1).max(LIMITS.maxAssistantCharacters).nullable(),
  intentionZh: z.string().trim().min(1).max(LIMITS.maxUserCharacters).optional(),
}).strict().superRefine((request, context) => {
  for (let index = 1; index < request.history.length; index += 1) {
    if (request.history[index]?.role === request.history[index - 1]?.role) {
      context.addIssue({ code: 'custom', message: 'Hint history roles must alternate.' })
      break
    }
  }
  const lastPartnerMessage = request.history.findLast((item) => item.role === 'assistant')
  if ((lastPartnerMessage?.text ?? null) !== request.lastPartnerText) {
    context.addIssue({ code: 'custom', message: 'Last partner text must match the latest real assistant message.' })
  }
})

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
  requirePerformance = false,
): ConversationFeedbackResponse {
  const parsed = ConversationFeedbackResponseSchema.safeParse(value)
  if (!parsed.success) {
    throw new ValidationError('invalid_feedback_output', parsed.error.issues[0]?.message || 'Feedback output is invalid.')
  }

  const { evidenceResults, evaluationVersion } = parsed.data
  if (requirePerformance && !parsed.data.performance) {
    throw new ValidationError('invalid_feedback_output', 'New feedback must include performance version 1.')
  }
  if (parsed.data.performance) {
    for (const dimension of Object.values(parsed.data.performance.dimensions)) {
      if (dimension.rating !== null && !dimension.evidence.some(evidence => evidence.role === 'user')) {
        throw new ValidationError('invalid_feedback_output', 'Rated performance dimensions require user-confirmed evidence.')
      }
      for (const evidence of dimension.evidence) {
        const record = turnRecords.find(item => item.turn === evidence.turn)
        const source = evidence.role === 'assistant' ? record?.partnerPromptJa : record?.userConfirmed
        if (!source || !source.includes(evidence.quoteJa)) {
          throw new ValidationError('invalid_feedback_output', 'Performance evidence must quote its referenced real turn exactly.')
        }
      }
    }
  }
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

export function parseScenarioPolishRequest(value: unknown): ScenarioPolishRequest {
  const parsed = ScenarioPolishRequestSchema.safeParse(value)
  if (!parsed.success) {
    throw new ValidationError('invalid_scenario_polish_request', parsed.error.issues[0]?.message || 'Scenario polish request is invalid.')
  }
  return parsed.data
}

export function parseScenarioPolishResponse(value: unknown): ScenarioPolishResponse {
  const parsed = ScenarioPolishResponseSchema.safeParse(value)
  if (!parsed.success) {
    throw new ValidationError('invalid_scenario_polish_output', parsed.error.issues[0]?.message || 'Scenario polish model output is invalid.')
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
