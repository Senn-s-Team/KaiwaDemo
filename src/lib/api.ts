import { z } from 'zod'
import type {
  ConversationFeedbackRequest,
  ConversationFeedbackResponse,
  ConversationMessage,
  PrototypeConfig,
  RoundRecord,
  SessionScenario,
  UsageSummary,
} from '../types'
const ScenarioCatalogSchema = z.array(z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
}))

const ConfigSchema = z.object({
  mode: z.enum(['real', 'partial', 'mock']),
  limits: z.object({ maxTurns: z.number().int().min(1).max(5) }),
  scenarioCatalog: ScenarioCatalogSchema,
  elevenlabs: z.object({
    sttAvailable: z.boolean(),
    ttsAvailable: z.boolean(),
    voiceId: z.string().nullable(),
    sttModel: z.string().min(1),
    ttsModel: z.string().min(1),
  }),
  openai: z.object({
    available: z.boolean(),
    model: z.string().min(1),
    mockAllowed: z.boolean(),
  }),
})

const SessionStartSchema = z.object({
  scenarioId: z.string().min(1),
  scenarioVersion: z.number().int().positive(),
  variantId: z.string().min(1),
  firstLine: z.string().min(1),
  maxTurns: z.number().int().min(1).max(5),
  reveal: z.object({ titleZh: z.string().min(1), summaryZh: z.string().min(1) }),
})

const TokenSchema = z.object({ token: z.string().min(10), expiresInSeconds: z.number().positive() })
const UsageSchema = z.object({
  inputTokens: z.number().nullable(),
  outputTokens: z.number().nullable(),
  totalTokens: z.number().nullable(),
})
const StreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('delta'), text: z.string() }),
  z.object({
    type: z.literal('done'),
    text: z.string(),
    model: z.string(),
    mock: z.boolean(),
    usage: UsageSchema,
  }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
])

const FORBIDDEN_EVALUATION_PATTERNS = /(?:发音|声调|口音|语调|情绪|発音|声調|アクセント|イントネーション|\b(?:[1-9]\d?|100)分\b|★|⭐|星[1-5一二三四五]|得分)/

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

export const FeedbackResponseSchema = z
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
export class ApiError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status: number) {
    super(message)
    this.code = code
    this.status = status
  }
}

async function errorFromResponse(response: Response): Promise<ApiError> {
  let code = 'request_failed'
  let message = `Request failed with status ${response.status}.`
  try {
    const payload: unknown = await response.json()
    const schema = z.object({ error: z.object({ code: z.string(), message: z.string() }) })
    const parsed = schema.safeParse(payload)
    if (parsed.success) {
      code = parsed.data.error.code
      message = parsed.data.error.message
    }
  } catch {
    message = 'The server returned an unreadable error response.'
  }
  return new ApiError(code, message, response.status)
}

export async function fetchConfig(signal?: AbortSignal): Promise<PrototypeConfig> {
  const response = await fetch('/api/config', { signal, headers: { accept: 'application/json' } })
  if (!response.ok) throw await errorFromResponse(response)
  return ConfigSchema.parse(await response.json())
}

export async function startScenarioSession(
  scenarioIdOrToken: { scenarioId: string } | { scenarioToken: string },
  signal?: AbortSignal,
): Promise<SessionScenario> {
  const isDynamic = 'scenarioToken' in scenarioIdOrToken
  const body = isDynamic
    ? { type: 'dynamic', scenarioToken: scenarioIdOrToken.scenarioToken }
    : { type: 'catalog', scenarioId: scenarioIdOrToken.scenarioId }

  const response = await fetch('/api/session/start', {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw await errorFromResponse(response)
  const data = (await response.json()) as Record<string, unknown>

  if (isDynamic) {
    return {
      id: (data.scenario as { id: string }).id,
      version: (data.scenario as { version: number }).version,
      variantId: 'dynamic-variant',
      firstLine: data.firstLine as string,
      maxTurns: data.maxTurns as number,
      recommendedMinTurns: data.recommendedMinTurns as number,
      recommendedMaxTurns: data.recommendedMaxTurns as number,
      scenarioType: 'dynamic',
      sessionToken: data.sessionToken as string,
      scenarioToken: scenarioIdOrToken.scenarioToken,
      dynamicData: data.scenario as SessionScenario['dynamicData'],
      reveal: data.reveal as SessionScenario['reveal'],
    }
  }
  const session = SessionStartSchema.parse(data)
  return {
    id: session.scenarioId,
    version: session.scenarioVersion,
    variantId: session.variantId,
    firstLine: session.firstLine,
    maxTurns: session.maxTurns,
    scenarioType: 'catalog',
    reveal: session.reveal,
  }
}
export async function requestElevenLabsToken(
  type: 'realtime_scribe' | 'tts_websocket',
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch('/api/elevenlabs/token', {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ type }),
  })
  if (!response.ok) throw await errorFromResponse(response)
  return TokenSchema.parse(await response.json()).token
}

export interface ReplyResult {
  text: string
  model: string
  mock: boolean
  usage: UsageSummary
}

export async function streamReply(
  sessionId: string,
  turn: number,
  messages: ConversationMessage[],
  scenario: Pick<SessionScenario, 'id' | 'version' | 'variantId' | 'scenarioType' | 'sessionToken'>,
  onFirstText: () => void,
  signal?: AbortSignal,
  model?: string,
  baseUrl?: string,
): Promise<ReplyResult> {
  const isDynamic = scenario.scenarioType === 'dynamic' && Boolean(scenario.sessionToken)
  const body = isDynamic
    ? {
        scenarioType: 'dynamic',
        sessionId,
        sessionToken: scenario.sessionToken,
        turn,
        history: messages.map(({ role, text }) => ({ role, text })),
      }
    : {
        scenarioType: 'catalog',
        sessionId,
        turn,
        scenarioId: scenario.id,
        scenarioVersion: scenario.version,
        variantId: scenario.variantId,
        model: model?.trim() || undefined,
        baseUrl: baseUrl?.trim() || undefined,
        history: messages.map(({ role, text }) => ({ role, text })),
      }

  const response = await fetch('/api/respond', {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw await errorFromResponse(response)
  if (!response.body) throw new ApiError('empty_stream', 'The response stream was empty.', 502)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let sawText = false

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.trim()) continue
      const event = StreamEventSchema.parse(JSON.parse(line) as unknown)
      if (event.type === 'delta' && event.text.length > 0 && !sawText) {
        sawText = true
        onFirstText()
      }
      if (event.type === 'done') {
        return event
      }
      if (event.type === 'error') {
        throw new ApiError(event.code, event.message, 502)
      }
    }
  }

  throw new ApiError('incomplete_stream', 'The model response ended before completion.', 502)
}
export async function draftScenario(
  inputZh: string,
  clarifications: readonly { questionZh: string; answerZh: string }[] = [],
  forceGenerate = false,
  signal?: AbortSignal,
): Promise<import('../types').ScenarioDraftResponse> {
  const response = await fetch('/api/scenario/draft', {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      inputZh,
      clarifications,
      forceGenerate,
    }),
  })
  if (!response.ok) throw await errorFromResponse(response)
  return response.json() as Promise<import('../types').ScenarioDraftResponse>
}

export async function fetchHint(
  scenario: SessionScenario,
  lastAssistantText: string,
  history: ConversationMessage[],
  signal?: AbortSignal,
): Promise<import('../types').HintResponse> {
  const isDynamic = scenario.scenarioType === 'dynamic' && Boolean(scenario.sessionToken)
  const body = isDynamic
    ? {
        scenarioType: 'dynamic',
        sessionToken: scenario.sessionToken,
        lastAssistantText,
        history: history.map(({ role, text }) => ({ role, text })),
      }
    : {
        scenarioType: 'catalog',
        scenarioId: scenario.id,
        variantId: scenario.variantId,
        lastAssistantText,
        history: history.map(({ role, text }) => ({ role, text })),
      }

  const response = await fetch('/api/hint', {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw await errorFromResponse(response)
  return response.json() as Promise<import('../types').HintResponse>
}

export async function checkSessionCheckpoint(
  sessionToken: string,
  turn: number,
  history: ConversationMessage[],
  signal?: AbortSignal,
): Promise<import('../types').SessionCheckpointResponse> {
  const response = await fetch('/api/session/checkpoint', {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sessionToken,
      turn,
      history: history.map(({ role, text }) => ({ role, text })),
    }),
  })
  if (!response.ok) throw await errorFromResponse(response)
  return response.json() as Promise<import('../types').SessionCheckpointResponse>
}

export function buildFeedbackRequestPayload(
  scenario: Pick<SessionScenario, 'id' | 'variantId' | 'scenarioType' | 'sessionToken'>,
  messages: ConversationMessage[],
  rounds: RoundRecord[],
): ConversationFeedbackRequest {
  const isDynamic = scenario.scenarioType === 'dynamic' || Boolean(scenario.sessionToken)
  const history = messages.map(({ role, text }) => ({ role, text }))
  const transcriptRecords = rounds.map((record, index) => ({
    turn: record.turn || index + 1,
    aiPrompt: record.aiPrompt,
    userOriginal: record.userOriginal,
    userCleaned: record.userCleaned,
    userFinal: record.userFinal,
  }))
  const totalTurns = rounds.length

  if (isDynamic) {
    return {
      scenarioType: 'dynamic',
      sessionToken: scenario.sessionToken ?? '',
      totalTurns,
      history,
      transcriptRecords,
    }
  }

  return {
    scenarioType: 'catalog',
    scenarioId: scenario.id,
    variantId: scenario.variantId,
    totalTurns,
    history,
    transcriptRecords,
  }
}

export async function requestConversationFeedback(
  scenario: Pick<SessionScenario, 'id' | 'variantId' | 'scenarioType' | 'sessionToken'>,
  messages: ConversationMessage[],
  rounds: RoundRecord[],
  signal?: AbortSignal,
): Promise<ConversationFeedbackResponse> {
  const payload = buildFeedbackRequestPayload(scenario, messages, rounds)
  const response = await fetch('/api/conversation/feedback', {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!response.ok) throw await errorFromResponse(response)
  const rawJson = await response.json()
  return FeedbackResponseSchema.parse(rawJson)
}
