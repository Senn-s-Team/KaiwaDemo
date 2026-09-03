import { DEFAULT_MODELS, LIMITS } from './constants'
import type { Env } from './env'
import { createMockFeedback, createMockReply } from './mock'
import {
  buildDeveloperPrompt,
  buildDynamicDeveloperPrompt,
  buildFeedbackPrompt,
  buildHintPrompt,
  buildCheckpointPrompt,
  buildScenarioDraftPrompt,
  getScenarioVariant,
} from './scenarios'
import {
  signSessionToken,
  verifySessionToken,
} from './tokens'
import type {
  ConversationFeedbackRequest,
  ConversationFeedbackResponse,
  HintRequest,
  HintResponse,
  ReplyDoneEvent,
  ReplyRequest,
  ReplyStreamEvent,
  ScenarioDraftModelResult,
  ScenarioDraftRequest,
  DynamicScenarioDefinition,
  SessionCheckpointRequest,
  SessionCheckpointResponse,
  TrainingGoal,
  UsageSummary,
} from './types'
import {
  parseConversationFeedbackResponse,
  parseHintResponse,
  parseScenarioDraftModelResult,
  parseSessionCheckpointEvaluation,
  validateAssistantReply,
  ValidationError,
} from './validation'
const encoder = new TextEncoder()
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1'

export class ScenarioDraftError extends Error {
  readonly code: string
  readonly status: 500 | 502 | 503

  constructor(code: string, message: string, status: 500 | 502 | 503) {
    super(message)
    this.code = code
    this.status = status
  }
}

export function resolveOpenAiResponsesUrl(configuredBaseUrl?: string): string {
  const rawUrl = configuredBaseUrl?.trim() || DEFAULT_OPENAI_BASE_URL
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error('OPENAI_BASE_URL must be a valid absolute URL.')
  }

  if (url.protocol !== 'https:') {
    throw new Error('OPENAI_BASE_URL must use HTTPS.')
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('OPENAI_BASE_URL cannot contain credentials, query parameters, or a fragment.')
  }

  const path = url.pathname.replace(/\/+$/, '')
  if (path.endsWith('/chat/completions') || path.endsWith('/responses')) {
    url.pathname = path
  } else if (rawUrl.includes('api.openai.com')) {
    url.pathname = `${path}/responses`
  } else {
    // Standard third-party OpenAI-compatible gateway (e.g. OneAPI / NewAPI / sub2api / proxy)
    url.pathname = `${path}/chat/completions`
  }
  return url.toString()
}

function textFromMessageContent(value: unknown): string | null {
  if (typeof value === 'string' && value.trim().length > 0) return value
  if (!Array.isArray(value)) return null
  const text = value
    .filter((part): part is Record<string, unknown> => typeof part === 'object' && part !== null && !Array.isArray(part))
    .filter((part) => part.type === 'text' || part.type === 'output_text')
    .map((part) => part.text)
    .filter((part): part is string => typeof part === 'string')
    .join('')
  return text.trim().length > 0 ? text : null
}

function responseTextFromCompletedJson(value: unknown): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ScenarioDraftError('scenario_draft_model_invalid', 'Scenario draft model output is invalid. Retry this request.', 502)
  }
  const obj = value as Record<string, unknown>
  if (typeof obj.output_text === 'string' && obj.output_text.trim().length > 0) {
    return obj.output_text
  }
  // Standard ChatCompletions response format compatibility
  if (Array.isArray(obj.choices) && obj.choices.length > 0) {
    const choice = obj.choices[0]
    if (typeof choice === 'object' && choice !== null && !Array.isArray(choice)) {
      const message = (choice as Record<string, unknown>).message
      if (typeof message === 'object' && message !== null && !Array.isArray(message)) {
        const content = textFromMessageContent((message as Record<string, unknown>).content)
        if (content) return content
      }
    }
  }
  if (Array.isArray(obj.output)) {
    for (const output of obj.output) {
      if (typeof output !== 'object' || output === null || Array.isArray(output)
        || !('content' in output) || !Array.isArray(output.content)) {
        continue
      }
      const content = textFromMessageContent(output.content)
      if (content) return content
    }
  }

  throw new ScenarioDraftError('scenario_draft_model_invalid', `Scenario draft model output structure is unexpected: ${JSON.stringify(value).slice(0, 300)}`, 502)
}

function parseModelJson(text: string): unknown {
  const trimmed = text.trim()
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  try {
    return JSON.parse(unfenced)
  } catch {
    const start = unfenced.indexOf('{')
    const end = unfenced.lastIndexOf('}')
    if (start < 0 || end <= start) throw new Error('Model output did not contain a JSON object.')
    return JSON.parse(unfenced.slice(start, end + 1))
  }
}
export function normalizeScenarioDraftResult(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value
  const raw = value as Record<string, unknown>

  if (raw.status === 'needs_clarification') {
    const questionZh = typeof raw.questionZh === 'string' ? raw.questionZh.trim() : raw.questionZh
    const optionsZh = Array.isArray(raw.optionsZh)
      ? raw.optionsZh.map((x) => (typeof x === 'string' ? x.trim() : x))
      : raw.optionsZh
    return {
      ...raw,
      questionZh,
      optionsZh,
    }
  }

  if (raw.status !== 'ready' || typeof raw.scenario !== 'object' || raw.scenario === null || Array.isArray(raw.scenario)) {
    return value
  }

  const scenario = { ...(raw.scenario as Record<string, unknown>) }
  if (typeof scenario.version === 'string') {
    const versionMatch = scenario.version.match(/\d+/)
    const numericVersion = versionMatch ? Number(versionMatch[0]) : NaN
    if (Number.isInteger(numericVersion) && numericVersion > 0) scenario.version = numericVersion
  }

  for (const field of ['worldAnchors', 'followUpPrinciples', 'feedbackFocus'] as const) {
    if (typeof scenario[field] === 'string') scenario[field] = [scenario[field]]
  }

  for (const field of ['coreGoals', 'optionalGoals'] as const) {
    const goals = scenario[field]
    if (!Array.isArray(goals)) continue
    scenario[field] = goals.map((goal, index) => {
      if (typeof goal === 'object' && goal !== null && !Array.isArray(goal)) {
        const g = goal as Record<string, unknown>
        return {
          id: typeof g.id === 'string' && g.id.trim() ? g.id.trim() : `${field === 'coreGoals' ? 'core' : 'optional'}_${index + 1}`,
          titleZh: g.titleZh,
          descriptionZh: g.descriptionZh,
        }
      }
      if (typeof goal === 'string') {
        return {
          id: `${field === 'coreGoals' ? 'core' : 'optional'}_${index + 1}`,
          titleZh: goal,
          descriptionZh: goal,
        }
      }
      return goal
    })
  }

  if (Array.isArray(scenario.hintStrategy)) {
    scenario.hintStrategy = scenario.hintStrategy
      .filter((item): item is string => typeof item === 'string')
      .join('；')
  }
  if (Array.isArray(scenario.safetyBoundary)) {
    scenario.safetyBoundary = scenario.safetyBoundary
      .filter((item): item is string => typeof item === 'string')
      .join('；')
  }

  return {
    ...raw,
    scenario,
  }
}

export function createFallbackReadyScenario(inputZh: string): DynamicScenarioDefinition {
  return {
    id: `dyn_${crypto.randomUUID().slice(0, 8)}`,
    version: 1,
    titleZh: inputZh.slice(0, 30) || '日语情境会话',
    summaryZh: inputZh || '根据您的需求生成的日语日常口语会话练习。',
    aiRole: '日本の店員・同僚',
    userRole: '日本語学習者',
    relationship: '丁寧な関係',
    tone: '丁寧で自然な日常会話',
    firstLine: 'こんにちは！お疲れ様です。',
    userGoal: inputZh || '自然な日本語で相手とコミュニケーションをとる',
    coreGoals: [
      { id: 'core_1', titleZh: '清晰传达主要想法', descriptionZh: '用自然的日语表达自己的观点与需求' },
      { id: 'core_2', titleZh: '积极回应对方提问', descriptionZh: '针对对方说的话给予合适回应并顺畅推进交流' },
    ],
    optionalGoals: [
      { id: 'optional_1', titleZh: '进阶表达与追问', descriptionZh: '在交流中自然运用所学表达并主动提问' },
    ],
    worldAnchors: ['日常生活或职场交流背景'],
    followUpPrinciples: ['根据用户回答自然追问，每次只问一个问题'],
    hintStrategy: '先明确表达观点，再展开具体细节。',
    feedbackFocus: ['用词地道性', '对话流畅度'],
    safetyBoundary: '遵守日常礼貌，不涉及敏感隐私。',
    recommendedMinTurns: 6,
    recommendedMaxTurns: 8,
  }
}

export async function draftScenario(env: Env, request: ScenarioDraftRequest): Promise<ScenarioDraftModelResult> {
  if (!env.OPENAI_API_KEY) {
    if (env.ALLOW_MOCK === 'true') {
      return {
        status: 'ready',
        scenario: createFallbackReadyScenario(request.inputZh),
      }
    }
    throw new ScenarioDraftError('openai_unconfigured', 'OpenAI is not configured for this deployment.', 503)
  }
  let responsesUrl: string
  try {
    responsesUrl = resolveOpenAiResponsesUrl(env.OPENAI_BASE_URL)
  } catch {
    throw new ScenarioDraftError('openai_base_url_invalid', 'OPENAI_BASE_URL is invalid.', 500)
  }

  const promptContent = buildScenarioDraftPrompt(request)
  const isResponsesEndpoint = responsesUrl.endsWith('/responses')
  
  const requestBody = isResponsesEndpoint
    ? {
        model: env.OPENAI_MODEL || DEFAULT_MODELS.openai,
        input: [{ role: 'developer', content: promptContent }],
        reasoning: { effort: 'low' },
        max_output_tokens: LIMITS.scenarioDraftOutputTokens,
        store: false,
        stream: false,
        tools: [],
        text: { format: { type: 'json_object' } },
      }
    : {
        model: env.OPENAI_MODEL || DEFAULT_MODELS.openai,
        messages: [{ role: 'system', content: promptContent }],
        max_tokens: LIMITS.scenarioDraftOutputTokens,
        response_format: { type: 'json_object' },
      }

  const upstream = await fetch(responsesUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(requestBody),
  })

  if (!upstream.ok) {
    let upstreamErrText = ''
    try {
      upstreamErrText = (await upstream.text()).slice(0, 500)
    } catch {}
    throw new ScenarioDraftError('scenario_draft_request_failed', upstreamErrText || 'OpenAI could not draft this scenario. Retry this request.', 502)
  }
  let modelPayload: unknown
  try {
    modelPayload = await upstream.json()
  } catch {
    throw new ScenarioDraftError('scenario_draft_model_invalid', 'Scenario draft model output is invalid. Retry this request.', 502)
  }

  let result: ScenarioDraftModelResult
  try {
    const text = responseTextFromCompletedJson(modelPayload)
    const modelJson = parseModelJson(text)
    result = parseScenarioDraftModelResult(normalizeScenarioDraftResult(modelJson))
  } catch (error) {
    if (error instanceof ScenarioDraftError) {
      throw error
    }
    if (error instanceof ValidationError) {
      throw new ScenarioDraftError('scenario_draft_schema_invalid', `Scenario draft model output failed validation: ${error.message}`, 502)
    }
    throw new ScenarioDraftError('scenario_draft_model_invalid', 'Scenario draft model output is invalid. Retry this request.', 502)
  }

  const mustGenerate = request.forceGenerate === true
    || request.clarifications.length >= LIMITS.maxScenarioDraftClarifications
  if (mustGenerate && result.status === 'needs_clarification') {
    return {
      status: 'ready',
      scenario: createFallbackReadyScenario(request.inputZh),
    }
  }

  return result
}

function ndjson(event: ReplyStreamEvent): Uint8Array {
  return encoder.encode(`${JSON.stringify(event)}\n`)
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function usageFromResponse(value: unknown): UsageSummary {
  if (typeof value !== 'object' || value === null) {
    return { inputTokens: null, outputTokens: null, totalTokens: null }
  }
  const usage = (value as { usage?: unknown }).usage
  if (typeof usage !== 'object' || usage === null) {
    return { inputTokens: null, outputTokens: null, totalTokens: null }
  }
  const record = usage as Record<string, unknown>
  return {
    inputTokens: numberOrNull(record.input_tokens),
    outputTokens: numberOrNull(record.output_tokens),
    totalTokens: numberOrNull(record.total_tokens),
  }
}

function mockStream(request: ReplyRequest, model: string): Response {
  const text = createMockReply(request)
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(ndjson({ type: 'delta', text }))
      const done: ReplyDoneEvent = {
        type: 'done',
        text,
        model: `${model} (mock)`,
        mock: true,
        usage: { inputTokens: null, outputTokens: null, totalTokens: null },
      }
      controller.enqueue(ndjson(done))
      controller.close()
    },
  })
  return streamResponse(stream)
}

function streamResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  })
}

export async function streamOpenAiReply(env: Env, request: ReplyRequest): Promise<Response> {
  const model = env.OPENAI_MODEL || DEFAULT_MODELS.openai
  if (!env.OPENAI_API_KEY) {
    if (env.ALLOW_MOCK === 'true') {
      return mockStream(request, model)
    }
    return new Response(
      JSON.stringify({ error: { code: 'openai_unconfigured', message: 'OpenAI is not configured for this deployment.' } }),
      { status: 503, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } },
    )
  }
  let responsesUrl: string
  try {
    const configuredBaseUrl = (request.scenarioType === 'catalog' ? request.baseUrl?.trim() : undefined) || env.OPENAI_BASE_URL
    responsesUrl = resolveOpenAiResponsesUrl(configuredBaseUrl)
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: {
          code: 'openai_base_url_invalid',
          message: error instanceof Error ? error.message : 'OPENAI_BASE_URL is invalid.',
        },
      }),
      { status: 500, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } },
    )
  }

  let developerPrompt: string
  let messagesSlice = request.history

  if (request.scenarioType === 'dynamic') {
    const sessionPayload = await verifySessionToken(env, request.sessionToken)
    if (request.turn > sessionPayload.cap) {
      throw new ValidationError('turn_limit', `Turn exceeds the authorized cap of ${sessionPayload.cap}.`)
    }
    if (request.history[0]?.text !== sessionPayload.scenario.firstLine) {
      throw new ValidationError('scenario_context_mismatch', 'Conversation history does not start with the scenario first line.')
    }
    developerPrompt = buildDynamicDeveloperPrompt(sessionPayload.scenario, request.turn, sessionPayload.cap)

    if (request.history.length > 7) {
      const firstTurn = request.history[0]!
      const recent = request.history.slice(-6)
      messagesSlice = [firstTurn, ...recent]
    }
  } else {
    developerPrompt = buildDeveloperPrompt(request)
  }

  const input = [
    { role: 'developer', content: developerPrompt },
    ...messagesSlice.map((item) => ({ role: item.role, content: item.text })),
  ]
  const isResponsesEndpoint = responsesUrl.endsWith('/responses')
  const streamBody = isResponsesEndpoint
    ? {
        model,
        input,
        reasoning: { effort: 'low' },
        max_output_tokens: LIMITS.maxOutputTokens,
        store: false,
        stream: true,
        tools: [],
      }
    : {
        model,
        messages: [
          { role: 'system', content: developerPrompt },
          ...messagesSlice.map((item) => ({ role: item.role, content: item.text })),
        ],
        max_tokens: LIMITS.maxOutputTokens,
        stream: true,
      }

  const upstream = await fetch(responsesUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
    },
    body: JSON.stringify(streamBody),
  })
  if (!upstream.ok || !upstream.body) {
    let upstreamError = ''
    try {
      upstreamError = (await upstream.text()).slice(0, 500)
    } catch {}
    const status = upstream.status === 401 || upstream.status === 403 ? 502 : upstream.status
    return new Response(
      JSON.stringify({
        error: {
          code: upstream.status === 401 || upstream.status === 403 ? 'openai_auth' : 'openai_request_failed',
          message: upstreamError || 'OpenAI did not generate a reply. Check the model, key permissions, quota, and request logs.',
          upstreamStatus: upstream.status,
        },
      }),
      { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } },
    )
  }
  const upstreamBody = upstream.body

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstreamBody.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let output = ''
      let completedResponse: unknown = null

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })

          const events = buffer.split('\n\n')
          buffer = events.pop() ?? ''
          for (const event of events) {
            for (const line of event.split('\n')) {
              if (!line.startsWith('data: ')) continue
              const data = line.slice(6)
              if (data === '[DONE]') continue

              let parsed: Record<string, unknown>
              try {
                parsed = JSON.parse(data) as Record<string, unknown>
              } catch {
                continue
              }

              if (parsed.type === 'response.output_text.delta' && typeof parsed.delta === 'string') {
                output += parsed.delta
                controller.enqueue(ndjson({ type: 'delta', text: parsed.delta }))
              } else if (Array.isArray(parsed.choices) && parsed.choices.length > 0) {
                // Standard ChatCompletions streaming chunk: { choices: [{ delta: { content: "..." } }] }
                const choice = parsed.choices[0] as Record<string, unknown>
                const deltaContent = (choice?.delta as { content?: string })?.content
                if (typeof deltaContent === 'string' && deltaContent.length > 0) {
                  output += deltaContent
                  controller.enqueue(ndjson({ type: 'delta', text: deltaContent }))
                }
              } else if (parsed.type === 'response.completed') {
                completedResponse = parsed.response
              } else if (parsed.type === 'response.failed' || parsed.type === 'error') {
                throw new Error('OpenAI stream failed before completion.')
              }
            }
          }
        }

        const text = validateAssistantReply(output)
        controller.enqueue(
          ndjson({
            type: 'done',
            text,
            model,
            mock: false,
            usage: usageFromResponse(completedResponse),
          }),
        )
        controller.close()
      } catch (error) {
        const code = error instanceof ValidationError ? error.code : 'openai_stream_failed'
        controller.enqueue(
          ndjson({
            type: 'error',
            code,
            message: error instanceof ValidationError ? error.message : 'OpenAI streaming ended unexpectedly. Retry this step.',
          }),
        )
        controller.close()
      } finally {
        reader.releaseLock()
      }
    },
    cancel() {
      void upstreamBody.cancel()
    },
  })

  return streamResponse(stream)
}
export async function generateHint(env: Env, request: HintRequest): Promise<HintResponse> {
  if (!env.OPENAI_API_KEY) {
    if (env.ALLOW_MOCK === 'true') {
      return {
        directionZh: '明确表达自己的需求并礼貌确认',
        keyPhrasesJa: ['お願いします', '〜できますか', '確認したいです'],
        sentenceStarterJa: 'あの、すみません、',
        fullExampleJa: 'あの、すみませんが、確認していただけますか？',
      }
    }
    throw new ScenarioDraftError('openai_unconfigured', 'OpenAI is not configured for this deployment.', 503)
  }

  let scenarioInfo: {
    titleZh?: string
    aiRole: string
    userRole?: string
    userGoal: string
    worldFacts?: string
    worldAnchors?: readonly string[]
    hintStrategy?: string
  }

  if (request.scenarioType === 'dynamic') {
    const sessionPayload = await verifySessionToken(env, request.sessionToken)
    scenarioInfo = {
      titleZh: sessionPayload.scenario.titleZh,
      aiRole: sessionPayload.scenario.aiRole,
      userRole: sessionPayload.scenario.userRole,
      userGoal: sessionPayload.scenario.userGoal,
      worldAnchors: sessionPayload.scenario.worldAnchors,
      hintStrategy: sessionPayload.scenario.hintStrategy,
    }
  } else {
    const variant = getScenarioVariant(request.scenarioId, request.variantId)
    if (!variant) throw new ValidationError('scenario_variant_mismatch', 'Variant not found.')
    scenarioInfo = {
      titleZh: variant.titleZh,
      aiRole: variant.aiRole,
      userGoal: variant.userGoal,
      worldFacts: variant.worldFacts,
    }
  }

  const prompt = buildHintPrompt(scenarioInfo, request.lastAssistantText, request.history)
  const responsesUrl = resolveOpenAiResponsesUrl(env.OPENAI_BASE_URL)
  const isResponsesEndpoint = responsesUrl.endsWith('/responses')

  const requestBody = isResponsesEndpoint
    ? {
        model: env.OPENAI_MODEL || DEFAULT_MODELS.openai,
        input: [{ role: 'developer', content: prompt }],
        reasoning: { effort: 'low' },
        max_output_tokens: LIMITS.hintOutputTokens,
        store: false,
        stream: false,
        tools: [],
        text: { format: { type: 'json_object' } },
      }
    : {
        model: env.OPENAI_MODEL || DEFAULT_MODELS.openai,
        messages: [{ role: 'system', content: prompt }],
        max_tokens: LIMITS.hintOutputTokens,
        response_format: { type: 'json_object' },
      }

  const upstream = await fetch(responsesUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(requestBody),
  })

  if (!upstream.ok) {
    throw new ScenarioDraftError('hint_request_failed', 'OpenAI hint generation failed.', 502)
  }

  const payload: unknown = await upstream.json()
  const text = responseTextFromCompletedJson(payload)
  return parseHintResponse(parseModelJson(text))
}

export async function generateSessionCheckpoint(
  env: Env,
  request: SessionCheckpointRequest,
): Promise<SessionCheckpointResponse> {
  const sessionPayload = await verifySessionToken(env, request.sessionToken)
  if (request.history[0]?.text !== sessionPayload.scenario.firstLine) {
    throw new ValidationError('scenario_context_mismatch', 'Conversation history does not start with the scenario first line.')
  }

  let evalResult: {
    isGoalCompleted: boolean
    completedGoals: Array<{ id: string; evidence: string }>
    remainingGoals: Array<{ id: string; titleZh: string }>
    factsSummary: string[]
    nextDirection: string
  }

  if (!env.OPENAI_API_KEY) {
    if (env.ALLOW_MOCK === 'true') {
      evalResult = {
        isGoalCompleted: request.turn >= 6,
        completedGoals: sessionPayload.scenario.coreGoals.map((g) => ({ id: g.id, evidence: 'Mock evidence' })),
        remainingGoals: [],
        factsSummary: ['Mock summary'],
        nextDirection: '自然に会話を締めくくってください。',
      }
    } else {
      throw new ScenarioDraftError('openai_unconfigured', 'OpenAI is not configured for this deployment.', 503)
    }
  } else {
    const prompt = buildCheckpointPrompt(sessionPayload.scenario, request.turn, request.history)
    const responsesUrl = resolveOpenAiResponsesUrl(env.OPENAI_BASE_URL)
    const isResponsesEndpoint = responsesUrl.endsWith('/responses')

    const requestBody = isResponsesEndpoint
      ? {
          model: env.OPENAI_MODEL || DEFAULT_MODELS.openai,
          input: [{ role: 'developer', content: prompt }],
          reasoning: { effort: 'low' },
          max_output_tokens: LIMITS.checkpointOutputTokens,
          store: false,
          stream: false,
          tools: [],
          text: { format: { type: 'json_object' } },
        }
      : {
          model: env.OPENAI_MODEL || DEFAULT_MODELS.openai,
          messages: [{ role: 'system', content: prompt }],
          max_tokens: LIMITS.checkpointOutputTokens,
          response_format: { type: 'json_object' },
        }

    const upstream = await fetch(responsesUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(requestBody),
    })

    if (!upstream.ok) {
      throw new ScenarioDraftError('checkpoint_request_failed', 'OpenAI checkpoint evaluation failed.', 502)
    }

    const payload: unknown = await upstream.json()
    const text = responseTextFromCompletedJson(payload)
    evalResult = parseSessionCheckpointEvaluation(parseModelJson(text))
  }

  let canExtend = false
  let nextCap: 14 | 20 | null = null
  let newSessionToken: string | null = null

  if (!evalResult.isGoalCompleted && sessionPayload.cap < LIMITS.maxCap) {
    canExtend = true
    nextCap = sessionPayload.cap === 10 ? 14 : 20
    const now = Date.now()
    newSessionToken = await signSessionToken(env, {
      scenario: sessionPayload.scenario,
      cap: nextCap,
      startedAt: sessionPayload.startedAt,
      expiresAt: now + LIMITS.sessionTokenTtlMs,
    })
  }

  return {
    ...evalResult,
    canExtend,
    nextCap,
    newSessionToken,
  }
}

export async function generateConversationFeedback(
  env: Env,
  request: ConversationFeedbackRequest,
): Promise<ConversationFeedbackResponse> {
  let scenarioInfo: {
    titleZh?: string
    summaryZh?: string
    aiRole: string
    userRole?: string
    userGoal: string
    coreGoals?: readonly TrainingGoal[]
    optionalGoals?: readonly TrainingGoal[]
    worldFacts?: string
    worldAnchors?: readonly string[]
    feedbackFocus?: readonly string[]
  }

  if (request.scenarioType === 'dynamic') {
    const sessionPayload = await verifySessionToken(env, request.sessionToken)
    if (request.history[0]?.text !== sessionPayload.scenario.firstLine) {
      throw new ValidationError('scenario_context_mismatch', 'Conversation history does not start with the scenario first line.')
    }
    scenarioInfo = {
      titleZh: sessionPayload.scenario.titleZh,
      summaryZh: sessionPayload.scenario.summaryZh,
      aiRole: sessionPayload.scenario.aiRole,
      userRole: sessionPayload.scenario.userRole,
      userGoal: sessionPayload.scenario.userGoal,
      coreGoals: sessionPayload.scenario.coreGoals,
      optionalGoals: sessionPayload.scenario.optionalGoals,
      worldAnchors: sessionPayload.scenario.worldAnchors,
      feedbackFocus: sessionPayload.scenario.feedbackFocus,
    }
  } else {
    const variant = getScenarioVariant(request.scenarioId, request.variantId)
    if (!variant) throw new ValidationError('scenario_variant_mismatch', 'Variant not found.')
    if (request.history[0]?.text !== variant.firstLine) {
      throw new ValidationError('scenario_context_mismatch', 'Conversation history does not start with the registered scenario line.')
    }
    scenarioInfo = {
      titleZh: variant.titleZh,
      summaryZh: variant.summaryZh,
      aiRole: variant.aiRole,
      userGoal: variant.userGoal,
      worldFacts: variant.worldFacts,
    }
  }

  if (!env.OPENAI_API_KEY) {
    if (env.ALLOW_MOCK === 'true') {
      return createMockFeedback(request)
    }
    throw new ScenarioDraftError('openai_unconfigured', 'OpenAI is not configured for this deployment.', 503)
  }

  const prompt = buildFeedbackPrompt(scenarioInfo, request.totalTurns, request.transcriptRecords)
  let responsesUrl: string
  try {
    responsesUrl = resolveOpenAiResponsesUrl(env.OPENAI_BASE_URL)
  } catch {
    throw new ScenarioDraftError('openai_base_url_invalid', 'OPENAI_BASE_URL is invalid.', 500)
  }
  const isResponsesEndpoint = responsesUrl.endsWith('/responses')
  const requestBody = isResponsesEndpoint
    ? {
        model: env.OPENAI_MODEL || DEFAULT_MODELS.openai,
        input: [{ role: 'developer', content: prompt }],
        reasoning: { effort: 'low' },
        max_output_tokens: LIMITS.feedbackOutputTokens,
        store: false,
        stream: false,
        tools: [],
        text: { format: { type: 'json_object' } },
      }
    : {
        model: env.OPENAI_MODEL || DEFAULT_MODELS.openai,
        messages: [{ role: 'system', content: prompt }],
        max_tokens: LIMITS.feedbackOutputTokens,
        response_format: { type: 'json_object' },
      }

  const upstream = await fetch(responsesUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(requestBody),
  })
  if (!upstream.ok) {
    throw new ScenarioDraftError('feedback_request_failed', 'OpenAI conversation feedback generation failed.', 502)
  }

  let modelPayload: unknown
  try {
    modelPayload = await upstream.json()
  } catch {
    throw new ScenarioDraftError('feedback_model_invalid', 'Feedback model output is invalid. Retry this request.', 502)
  }

  let parsedJson: unknown
  try {
    const text = responseTextFromCompletedJson(modelPayload)
    parsedJson = parseModelJson(text)
  } catch (error) {
    if (error instanceof ScenarioDraftError) {
      throw error
    }
    throw new ScenarioDraftError('feedback_model_invalid', 'Feedback model output is invalid. Retry this request.', 502)
  }

  try {
    return parseConversationFeedbackResponse(parsedJson, request.transcriptRecords)
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new ScenarioDraftError('feedback_model_invalid', error.message, 502)
    }
    throw error
  }
}
