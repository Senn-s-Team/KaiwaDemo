import { z } from 'zod'
import { LIMITS } from './constants'
import { getScenarioDefinition, getScenarioVariant, SCENARIO_IDS } from './scenarios'
import type {
  ConversationFeedbackRequest,
  ConversationFeedbackResponse,
  DynamicScenarioDefinition,
  HintRequest,
  HintResponse,
  ReplyRequest,
  ScenarioDraftModelResult,
  ScenarioDraftRequest,
  SessionCheckpointRequest,
  RescueRequest,
  RescueResponse,
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

const TokenRequestSchema = z
  .object({
    type: z.enum(['realtime_scribe', 'tts_websocket']),
  })
  .strict()

const CatalogSessionStartRequestSchema = z
  .object({
    type: z.literal('catalog').optional(),
    scenarioId: z.enum(SCENARIO_IDS),
  })
  .strict()

const DynamicSessionStartRequestSchema = z
  .object({
    type: z.literal('dynamic'),
    scenarioToken: z.string().trim().min(1),
  })
  .strict()

const SessionStartRequestSchema = z.union([
  CatalogSessionStartRequestSchema,
  DynamicSessionStartRequestSchema,
])

const ScenarioDraftClarificationSchema = z
  .object({
    questionZh: z.string().trim().min(1).max(120),
    answerZh: z.string().trim().min(1).max(300),
  })
  .strict()

const ScenarioDraftRequestSchema = z
  .object({
    inputZh: z.string().trim().min(1).max(300),
    clarifications: z.array(ScenarioDraftClarificationSchema).max(LIMITS.maxScenarioDraftClarifications),
    forceGenerate: z.boolean().optional(),
  })
  .strict()

const TrainingGoalSchema = z
  .object({
    id: z.string().trim().min(1).max(64),
    titleZh: z.string().trim().min(1).max(80),
    descriptionZh: z.string().trim().min(1).max(240),
  })
  .strict()

const DynamicScenarioDefinitionSchema = z
  .object({
    id: z.string().trim().min(1).max(64),
    version: z.number().int().positive(),
    titleZh: z.string().trim().min(1).max(100),
    summaryZh: z.string().trim().min(1).max(300),
    aiRole: z.string().trim().min(1).max(160),
    userRole: z.string().trim().min(1).max(160),
    relationship: z.string().trim().min(1).max(160),
    tone: z.string().trim().min(1).max(100),
    firstLine: z.string().trim().min(1).max(LIMITS.maxAssistantCharacters),
    userGoal: z.string().trim().min(1).max(240),
    coreGoals: z.array(TrainingGoalSchema).min(1).max(3),
    optionalGoals: z.array(TrainingGoalSchema).max(2),
    worldAnchors: z.array(z.string().trim().min(1).max(240)).min(1).max(6),
    followUpPrinciples: z.array(z.string().trim().min(1).max(240)).min(1).max(5),
    hintStrategy: z.string().trim().min(1).max(300),
    feedbackFocus: z.array(z.string().trim().min(1).max(160)).min(1).max(5),
    safetyBoundary: z.string().trim().min(1).max(300),
    recommendedMinTurns: z.number().int().min(6).max(8),
    recommendedMaxTurns: z.number().int().min(6).max(8),
  })
  .strict()
  .refine(
    ({ recommendedMinTurns, recommendedMaxTurns }) => recommendedMinTurns <= recommendedMaxTurns,
    'recommendedMinTurns must not exceed recommendedMaxTurns.',
  )

const ScenarioDraftModelResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('needs_clarification'),
      questionZh: z.string().trim().min(1).max(120),
      optionsZh: z.array(z.string().trim().min(1).max(120)).min(2).max(5),
    })
    .strict(),
  z
    .object({
      status: z.literal('ready'),
      scenario: DynamicScenarioDefinitionSchema,
    })
    .strict(),
])

const ConversationMessageSchema = z
  .object({
    role: z.enum(['assistant', 'user']),
    text: z.string().trim().min(1),
  })
  .strict()

const CatalogReplyRequestSchema = z
  .object({
    scenarioType: z.literal('catalog').optional(),
    sessionId: z.string().regex(/^[a-zA-Z0-9_-]{8,64}$/),
    scenarioId: z.enum(SCENARIO_IDS),
    scenarioVersion: z.number().int().positive(),
    variantId: z.string().trim().min(1).max(64),
    turn: z.number().int().min(1).max(LIMITS.maxTurns),
    model: z.string().trim().max(128).optional(),
    baseUrl: z.string().trim().max(512).optional(),
    history: z.array(ConversationMessageSchema).min(2).max(LIMITS.maxHistoryMessages),
  })
  .strict()
  .superRefine((request, context) => {
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
    if (userTurns !== request.turn || userTurns > LIMITS.maxTurns) {
      context.addIssue({ code: 'custom', message: 'History does not match the declared turn.' })
    }

    request.history.forEach((item, index) => {
      const max = item.role === 'user' ? LIMITS.maxUserCharacters : LIMITS.maxAssistantCharacters
      if (item.text.length > max) {
        context.addIssue({ code: 'custom', message: `History item ${index + 1} exceeds the text limit.` })
      }
    })
  })

const DynamicReplyRequestSchema = z
  .object({
    scenarioType: z.literal('dynamic'),
    sessionToken: z.string().trim().min(1),
    sessionId: z.string().regex(/^[a-zA-Z0-9_-]{8,64}$/),
    turn: z.number().int().min(1).max(LIMITS.maxCap),
    history: z.array(ConversationMessageSchema).min(2).max(LIMITS.maxDynamicHistoryMessages),
  })
  .strict()
  .superRefine((request, context) => {
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
    if (userTurns !== request.turn || userTurns > LIMITS.maxCap) {
      context.addIssue({ code: 'custom', message: 'History does not match the declared turn.' })
    }

    request.history.forEach((item, index) => {
      const max = item.role === 'user' ? LIMITS.maxUserCharacters : LIMITS.maxAssistantCharacters
      if (item.text.length > max) {
        context.addIssue({ code: 'custom', message: `History item ${index + 1} exceeds the text limit.` })
      }
    })
  })

const CatalogHintRequestSchema = z
  .object({
    scenarioType: z.literal('catalog'),
    scenarioId: z.enum(SCENARIO_IDS),
    variantId: z.string().trim().min(1).max(64),
    history: z.array(ConversationMessageSchema).min(1).max(LIMITS.maxHistoryMessages),
    lastAssistantText: z.string().trim().min(1).max(LIMITS.maxAssistantCharacters),
  })
  .strict()

const DynamicHintRequestSchema = z
  .object({
    scenarioType: z.literal('dynamic'),
    sessionToken: z.string().trim().min(1),
    history: z.array(ConversationMessageSchema).min(1).max(LIMITS.maxDynamicHistoryMessages),
    lastAssistantText: z.string().trim().min(1).max(LIMITS.maxAssistantCharacters),
  })
  .strict()

const HintRequestSchema = z.union([CatalogHintRequestSchema, DynamicHintRequestSchema])

const CatalogRescueRequestSchema = z
  .object({
    scenarioType: z.literal('catalog').optional(),
    scenarioId: z.enum(SCENARIO_IDS),
    variantId: z.string().trim().min(1).max(64),
    turn: z.number().int().min(1).max(LIMITS.maxCap),
    aiPrompt: z.string().trim().min(1).max(LIMITS.maxAssistantCharacters * 2),
    userFinal: z.string().trim().min(1).max(LIMITS.maxUserCharacters),
    history: z.array(ConversationMessageSchema).max(LIMITS.maxDynamicHistoryMessages),
  })
  .strict()

const DynamicRescueRequestSchema = z
  .object({
    scenarioType: z.literal('dynamic'),
    sessionToken: z.string().trim().min(1).optional(),
    dynamicData: DynamicScenarioDefinitionSchema.optional(),
    turn: z.number().int().min(1).max(LIMITS.maxCap),
    aiPrompt: z.string().trim().min(1).max(LIMITS.maxAssistantCharacters * 2),
    userFinal: z.string().trim().min(1).max(LIMITS.maxUserCharacters),
    history: z.array(ConversationMessageSchema).max(LIMITS.maxDynamicHistoryMessages),
  })
  .strict()
  .refine((data) => Boolean(data.sessionToken || data.dynamicData), {
    message: 'Either sessionToken or dynamicData must be provided for dynamic rescue request.',
  })

const RescueRequestSchema = z.union([CatalogRescueRequestSchema, DynamicRescueRequestSchema])

const FORBIDDEN_EVALUATION_PATTERNS = /(?:发音|声调|口音|语调|情绪|発音|声調|アクセント|イントネーション|\b(?:[1-9]\d?|100)分\b|★|⭐|星[1-5一二三四五]|得分)/

const RescueResponseSchema = z
  .object({
    interpretedIntentZh: z.string().trim().min(1).refine(
      (val) => !FORBIDDEN_EVALUATION_PATTERNS.test(val),
      'Forbidden mention of pronunciation, tone, accent, score, or emotion in rescue output.',
    ),
    suggestedJa: z.string().trim().min(1),
    politenessTipZh: z.string().trim().min(1).refine(
      (val) => !FORBIDDEN_EVALUATION_PATTERNS.test(val),
      'Forbidden mention of pronunciation, tone, accent, score, or emotion in rescue output.',
    ),
  })
  .strict()

const SessionCheckpointRequestSchema = z
  .object({
    sessionToken: z.string().trim().min(1),
    turn: z.number().int().min(1).max(LIMITS.maxCap),
    history: z.array(ConversationMessageSchema).min(2).max(LIMITS.maxDynamicHistoryMessages),
  })
  .strict()

const KANA_REGEX = /[\u3040-\u309F\u30A0-\u30FF]/

const HintResponseSchema = z
  .object({
    directionZh: z.string().trim().min(1).refine(
      (val) => !KANA_REGEX.test(val),
      'Level 1 directionZh must give thinking direction in Chinese without Japanese words or sentences.',
    ),
    keyPhrasesJa: z.array(z.string().trim().min(1)).min(2).max(5),
    sentenceStarterJa: z.string().trim().min(1),
    fullExampleJa: z.string().trim().min(1),
  })
  .strict()
const SessionCheckpointEvaluationSchema = z
  .object({
    isGoalCompleted: z.boolean(),
    completedGoals: z.array(
      z.object({
        id: z.string().trim().min(1),
        evidence: z.string().trim().min(1),
      }).strict(),
    ),
    remainingGoals: z.array(
      z.object({
        id: z.string().trim().min(1),
        titleZh: z.string().trim().min(1),
      }).strict(),
    ),
    factsSummary: z.array(z.string().trim().min(1)),
    nextDirection: z.string().trim().min(1),
  })
  .strict()

const TranscriptRecordSchema = z
  .object({
    turn: z.number().int().min(1).max(LIMITS.maxCap),
    aiPrompt: z.string().trim().min(1),
    userOriginal: z.string(),
    userCleaned: z.string(),
    userFinal: z.string().trim().min(1),
  })
  .strict()

const CatalogFeedbackRequestSchema = z
  .object({
    scenarioType: z.literal('catalog'),
    scenarioId: z.enum(SCENARIO_IDS),
    variantId: z.string().trim().min(1).max(64),
    totalTurns: z.number().int().min(1).max(LIMITS.maxTurns),
    history: z.array(ConversationMessageSchema).min(2).max(LIMITS.maxFeedbackHistoryMessages),
    transcriptRecords: z.array(TranscriptRecordSchema).min(1).max(LIMITS.maxTurns),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.history[0]?.role !== 'assistant') {
      context.addIssue({ code: 'custom', message: 'History must start with the assistant.' })
    }

    for (let index = 1; index < request.history.length; index += 1) {
      if (request.history[index]?.role === request.history[index - 1]?.role) {
        context.addIssue({ code: 'custom', message: 'Conversation roles must alternate.' })
        break
      }
    }

    const userTurns = request.history.filter((item) => item.role === 'user').length
    if (userTurns !== request.totalTurns || userTurns > LIMITS.maxTurns) {
      context.addIssue({ code: 'custom', message: 'History does not match declared totalTurns.' })
    }

    if (request.transcriptRecords.length !== request.totalTurns) {
      context.addIssue({ code: 'custom', message: 'Transcript records count does not match totalTurns.' })
    }

    request.transcriptRecords.forEach((record, index) => {
      if (record.turn !== index + 1) {
        context.addIssue({ code: 'custom', message: `Transcript record turn must be ${index + 1}.` })
      }
    })
  })

const DynamicFeedbackRequestSchema = z
  .object({
    scenarioType: z.literal('dynamic'),
    sessionToken: z.string().trim().min(1),
    totalTurns: z.number().int().min(1).max(LIMITS.maxCap),
    history: z.array(ConversationMessageSchema).min(2).max(LIMITS.maxFeedbackHistoryMessages),
    transcriptRecords: z.array(TranscriptRecordSchema).min(1).max(LIMITS.maxCap),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.history[0]?.role !== 'assistant') {
      context.addIssue({ code: 'custom', message: 'History must start with the assistant.' })
    }

    for (let index = 1; index < request.history.length; index += 1) {
      if (request.history[index]?.role === request.history[index - 1]?.role) {
        context.addIssue({ code: 'custom', message: 'Conversation roles must alternate.' })
        break
      }
    }

    const userTurns = request.history.filter((item) => item.role === 'user').length
    if (userTurns !== request.totalTurns || userTurns > LIMITS.maxCap) {
      context.addIssue({ code: 'custom', message: 'History does not match declared totalTurns.' })
    }

    if (request.transcriptRecords.length !== request.totalTurns) {
      context.addIssue({ code: 'custom', message: 'Transcript records count does not match totalTurns.' })
    }

    request.transcriptRecords.forEach((record, index) => {
      if (record.turn !== index + 1) {
        context.addIssue({ code: 'custom', message: `Transcript record turn must be ${index + 1}.` })
      }
    })
  })

const FeedbackStrengthItemSchema = z
  .object({
    quoteJa: z.string().trim().min(1),
    praiseZh: z.string().trim().min(1).refine(
      (val) => !FORBIDDEN_EVALUATION_PATTERNS.test(val),
      'Forbidden mention of pronunciation, tone, accent, score, or emotion in feedback.',
    ),
  })
  .strict()

const FeedbackImprovementItemSchema = z
  .object({
    turn: z.number().int().min(1),
    type: z.enum(['grammar_fix', 'naturalness_upgrade']),
    originalQuoteJa: z.string().trim().min(1),
    suggestedJa: z.string().trim().min(1),
    reasonZh: z.string().trim().min(1).refine(
      (val) => !FORBIDDEN_EVALUATION_PATTERNS.test(val),
      'Forbidden mention of pronunciation, tone, accent, score, or emotion in feedback.',
    ),
  })
  .strict()

const FeedbackReusableExpressionSchema = z
  .object({
    patternJa: z.string().trim().min(1),
    meaningZh: z.string().trim().min(1).refine(
      (val) => !FORBIDDEN_EVALUATION_PATTERNS.test(val),
      'Forbidden mention of pronunciation, tone, accent, score, or emotion in feedback.',
    ),
    usageExampleJa: z.string().trim().min(1),
  })
  .strict()

const FeedbackMasterUpgradeSchema = z
  .object({
    turn: z.number().int().min(1),
    originalJa: z.string().trim().min(1),
    upgradedJa: z.string().trim().min(1),
    explanationZh: z.string().trim().min(1).refine(
      (val) => !FORBIDDEN_EVALUATION_PATTERNS.test(val),
      'Forbidden mention of pronunciation, tone, accent, score, or emotion in feedback.',
    ),
  })
  .strict()

const FeedbackRetryTaskSchema = z
  .object({
    turn: z.number().int().min(1),
    targetAiPromptJa: z.string().trim().min(1),
    userOriginalJa: z.string().trim().min(1),
    recommendedReferenceJa: z.string().trim().min(1),
    hintZh: z.string().trim().min(1).refine(
      (val) => !FORBIDDEN_EVALUATION_PATTERNS.test(val),
      'Forbidden mention of pronunciation, tone, accent, score, or emotion in feedback.',
    ),
  })
  .strict()

export const ConversationFeedbackResponseSchema = z
  .object({
    isGoalCompleted: z.boolean(),
    goalSummaryZh: z.string().trim().min(1).refine(
      (val) => !FORBIDDEN_EVALUATION_PATTERNS.test(val),
      'Forbidden mention of pronunciation, tone, accent, score, or emotion in feedback.',
    ),
    strengths: z.array(FeedbackStrengthItemSchema).length(2),
    improvements: z.array(FeedbackImprovementItemSchema).min(1).max(3),
    reusableExpressions: z.array(FeedbackReusableExpressionSchema).length(2),
    masterUpgrade: FeedbackMasterUpgradeSchema,
    retryTask: FeedbackRetryTaskSchema,
  })
  .strict()


export function parseTokenRequest(value: unknown): TokenRequest {
  const parsed = TokenRequestSchema.safeParse(value)
  if (!parsed.success) {
    throw new ValidationError('invalid_token_type', 'Unsupported ElevenLabs token request.')
  }
  return parsed.data
}
export function parseSessionStartRequest(value: unknown): SessionStartRequest {
  const parsed = SessionStartRequestSchema.safeParse(value)
  if (!parsed.success) {
    throw new ValidationError('unknown_scenario', 'Scenario is not available.')
  }
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
    const details = parsed.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '<root>'}: ${issue.message}`)
      .join('; ')
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
  const isDynamic = typeof value === 'object' && value !== null && 'scenarioType' in value && (value as { scenarioType?: unknown }).scenarioType === 'dynamic'

  if (isDynamic) {
    const parsed = DynamicReplyRequestSchema.safeParse(value)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      const message = issue?.message || 'Dynamic conversation request is invalid.'
      const code = issue?.path[0] === 'turn' ? 'turn_limit' : issue?.path[0] === 'history' ? 'history_limit' : 'invalid_dynamic_reply'
      throw new ValidationError(code, message)
    }
    return parsed.data
  }

  const parsed = CatalogReplyRequestSchema.safeParse(value)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const message = issue?.message || 'Conversation request is invalid.'
    const field = issue?.path[0]
    const code =
      field === 'scenarioId'
        ? 'unknown_scenario'
        : field === 'scenarioVersion'
          ? 'scenario_version_mismatch'
          : field === 'variantId'
            ? 'scenario_variant_mismatch'
            : field === 'turn'
              ? 'turn_limit'
              : field === 'history'
                ? 'history_limit'
                : 'invalid_history'
    throw new ValidationError(code, message)
  }

  const scenario = getScenarioDefinition(parsed.data.scenarioId)
  if (parsed.data.scenarioVersion !== scenario.version) {
    throw new ValidationError('scenario_version_mismatch', 'Scenario version does not match the registered version.')
  }

  const variant = getScenarioVariant(parsed.data.scenarioId, parsed.data.variantId)
  if (!variant) {
    throw new ValidationError('scenario_variant_mismatch', 'Scenario variant does not belong to the registered scenario.')
  }
  if (parsed.data.history[0]?.text !== variant.firstLine) {
    throw new ValidationError('scenario_context_mismatch', 'Conversation history does not start with the registered scenario line.')
  }

  return parsed.data
}

export function parseHintRequest(value: unknown): HintRequest {
  const parsed = HintRequestSchema.safeParse(value)
  if (!parsed.success) {
    throw new ValidationError('invalid_hint_request', 'Hint request is invalid.')
  }
  return parsed.data
}

export function parseHintResponse(value: unknown): HintResponse {
  const parsed = HintResponseSchema.safeParse(value)
  if (!parsed.success) {
    throw new ValidationError('invalid_hint_output', 'Hint model output is invalid.')
  }
  return parsed.data
}

export function validateRescueRequest(value: unknown): RescueRequest {
  const parsed = RescueRequestSchema.safeParse(value)
  if (!parsed.success) {
    throw new ValidationError('invalid_rescue_request', 'Rescue request is invalid.')
  }
  return parsed.data
}

export function parseRescueRequest(value: unknown): RescueRequest {
  return validateRescueRequest(value)
}

export function parseRescueResponse(value: unknown): RescueResponse {
  const parsed = RescueResponseSchema.safeParse(value)
  if (!parsed.success) {
    throw new ValidationError('invalid_rescue_output', 'Rescue model output is invalid.')
  }
  return parsed.data
}

export function parseSessionCheckpointRequest(value: unknown): SessionCheckpointRequest {
  const parsed = SessionCheckpointRequestSchema.safeParse(value)
  if (!parsed.success) {
    throw new ValidationError('invalid_checkpoint_request', 'Session checkpoint request is invalid.')
  }
  return parsed.data
}

export function parseSessionCheckpointEvaluation(value: unknown): z.infer<typeof SessionCheckpointEvaluationSchema> {
  const parsed = SessionCheckpointEvaluationSchema.safeParse(value)
  if (!parsed.success) {
    throw new ValidationError('invalid_checkpoint_output', 'Checkpoint model output is invalid.')
  }
  return parsed.data
}

export function validateAssistantReply(value: string): string {
  const text = value.trim()
  if (text.length === 0 || text.length > LIMITS.maxAssistantCharacters) {
    throw new ValidationError('invalid_model_output', 'Model reply exceeded the configured text limit.')
  }
  if ((text.match(/[？?]/g) ?? []).length > 1 || /```|^\s*[-*#]\s/m.test(text)) {
    throw new ValidationError('invalid_model_output', 'Model reply did not follow the conversation format.')
  }
  return text
}

export function parseConversationFeedbackRequest(value: unknown): ConversationFeedbackRequest {
  const isDynamic = typeof value === 'object' && value !== null && 'scenarioType' in value && (value as { scenarioType?: unknown }).scenarioType === 'dynamic'

  if (isDynamic) {
    const parsed = DynamicFeedbackRequestSchema.safeParse(value)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      const message = issue?.message || 'Dynamic feedback request is invalid.'
      throw new ValidationError('invalid_feedback_request', message)
    }
    return parsed.data
  }

  const parsed = CatalogFeedbackRequestSchema.safeParse(value)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const message = issue?.message || 'Catalog feedback request is invalid.'
    const field = issue?.path[0]
    const code =
      field === 'scenarioId'
        ? 'unknown_scenario'
        : field === 'variantId'
          ? 'scenario_variant_mismatch'
          : 'invalid_feedback_request'
    throw new ValidationError(code, message)
  }

  const variant = getScenarioVariant(parsed.data.scenarioId, parsed.data.variantId)
  if (!variant) {
    throw new ValidationError('scenario_variant_mismatch', 'Scenario variant does not belong to the registered scenario.')
  }
  if (parsed.data.history[0]?.text !== variant.firstLine) {
    throw new ValidationError('scenario_context_mismatch', 'Conversation history does not start with the registered scenario line.')
  }

  return parsed.data
}

export function parseConversationFeedbackResponse(
  value: unknown,
  transcriptRecords: Array<{ userFinal: string }>,
): ConversationFeedbackResponse {
  const parsed = ConversationFeedbackResponseSchema.safeParse(value)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new ValidationError('invalid_feedback_output', issue?.message || 'Feedback model output is invalid.')
  }

  // Verify quotes in improvements actually exist in userFinal
  const userFinalTexts = transcriptRecords.map((r) => r.userFinal)
  for (const item of parsed.data.improvements) {
    const exists = userFinalTexts.some((text) => text.includes(item.originalQuoteJa))
    if (!exists) {
      throw new ValidationError(
        'invalid_feedback_output',
        `Improvement quote "${item.originalQuoteJa}" not found in user utterances.`,
      )
    }
  }

  return parsed.data
}
