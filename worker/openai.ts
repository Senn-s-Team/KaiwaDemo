/**
 * [INPUT]: 依赖共享听力支架、语音续说与场景润色契约、Worker 环境、模型配置、场景 prompt、token 校验、mock 回退、领域类型与响应校验器
 * [OUTPUT]: 提供按场景版本校验的逐项评价； 对外提供场景草拟、流式回复、提示、反馈、重做、四级听力支架、语音辅助与场景润色的 OpenAI 编排函数及场景草拟错误
 * [POS]: worker 的模型网关层，负责请求 OpenAI、隔离听力支架上下文、归一化完整场景契约并交由严格校验
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { DEFAULT_MODELS, LIMITS, DEADLINES } from './constants'
import type { Env } from './env'
import {
  createMockFeedback,
  createMockListeningScaffold,
  createMockRedoFeedback,
  createMockReply,
  createMockSpeechAssist,
} from './mock'
import {
  buildDynamicDeveloperPrompt,
  buildFeedbackPrompt,
  buildHintPrompt,
  buildListeningScaffoldPrompt,
  buildRedoFeedbackPrompt,
  buildScenarioDraftPrompt,
  buildScenarioPolishPrompt,
  buildSpeechAssistPrompt,
} from './scenarios'
import { verifySessionToken } from './tokens'
import type { ListeningScaffoldRequest, ListeningScaffoldResponse } from '../shared/listening-scaffold'
import type { SpeechAssistRequest, SpeechAssistResponse } from '../shared/speech-assist'
import type { ScenarioPolishRequest, ScenarioPolishResponse } from '../shared/scenario-polish'
import type {
  ConversationFeedbackRequest,
  ConversationFeedbackResponse,
  DynamicScenarioDefinition,
  HintRequest,
  HintResponse,
  RedoFeedbackRequest,
  RedoFeedbackResponse,
  ReplyDoneEvent,
  ReplyRequest,
  ReplyStreamEvent,
  ScenarioDraftModelResult,
  ScenarioDraftRequest,
  UsageSummary,
} from './types'
import {
  parseConversationFeedbackResponse,
  parseHintResponse,
  parseListeningScaffoldModelOutput,
  parseRedoFeedbackResponse,
  parseScenarioDraftModelResult,
  parseScenarioPolishResponse,
  parseSpeechAssistModelOutput,
  validateAssistantReply,
  ValidationError,
} from './validation'
const encoder = new TextEncoder()
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1'

export class ScenarioDraftError extends Error {
  readonly code: string
  readonly status: 500 | 502 | 503 | 504

  constructor(code: string, message: string, status: 500 | 502 | 503 | 504) {
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
  if (scenario.maxTurns === '5') scenario.maxTurns = 5

  const collectionFields = [
    'initialFacts',
    'partnerPrivateFacts',
    'keyIntents',
    'keyInformation',
    'closingRules',
    'worldAnchors',
    'followUpPrinciples',
    'feedbackFocus',
  ] as const
  for (const field of collectionFields) {
    if (typeof scenario[field] === 'string') scenario[field] = [scenario[field]]
  }

  if (typeof scenario.coreGoal === 'string') {
    scenario.coreGoal = {
      id: 'core_1',
      titleZh: scenario.coreGoal,
      descriptionZh: scenario.coreGoal,
    }
  } else if (typeof scenario.coreGoal === 'object' && scenario.coreGoal !== null && !Array.isArray(scenario.coreGoal)) {
    const coreGoal = scenario.coreGoal as Record<string, unknown>
    scenario.coreGoal = {
      ...coreGoal,
      id: typeof coreGoal.id === 'string' && coreGoal.id.trim() ? coreGoal.id.trim() : 'core_1',
    }
  }

  if (typeof scenario.completionRules === 'object' && scenario.completionRules !== null && !Array.isArray(scenario.completionRules)) {
    const completionRules = { ...(scenario.completionRules as Record<string, unknown>) }
    for (const field of ['completed', 'partial', 'notCompleted'] as const) {
      if (typeof completionRules[field] === 'string') completionRules[field] = [completionRules[field]]
    }
    scenario.completionRules = completionRules
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
  const userGoal = inputZh || '用自然日语清晰传达主要需求'
  return {
    id: `dyn_${crypto.randomUUID().slice(0, 8)}`,
    version: 1,
    evaluationVersion: 1,
    evidencePoints: [{ id: 'express_need', titleZh: '表达主要需求', descriptionZh: `通过确认稿清楚表达：${userGoal}` }],
    titleZh: inputZh.slice(0, 30) || '日语情境会话',
    summaryZh: inputZh || '根据需求生成的五轮日语口语会话练习。',
    aiRole: '场景中的日语会话对象',
    userRole: '需要完成交际目标的日语学习者',
    relationship: '符合用户需求的礼貌关系',
    tone: '自然且符合双方社会距离的日语口语',
    communicationFunction: '在礼貌对话中提出主要需求并确认双方理解一致',
    firstLine: 'こんにちは。今日はどのようなご用件でしょうか？',
    partnerOpeningPlan: '以礼貌问候建立场景，并用一个开放问题邀请用户说明主要需求。',
    userGoal,
    coreGoal: {
      id: 'core_1',
      titleZh: '清晰传达主要需求',
      descriptionZh: `在五轮内围绕“${userGoal.slice(0, 80)}”向对方给出可确认的关键信息。`,
    },
    initialFacts: ['这是一次固定五轮的日语口语练习', '双方需要围绕用户给出的场景需求完成对话'],
    partnerPrivateFacts: [],
    keyIntents: ['用户：用日语清晰表达主要需求', 'AI：确认需求并在职责范围内自然回应'],
    keyInformation: ['用户的主要需求', '相手对该需求的明确理解或回应'],
    completionRules: {
      completed: ['确认稿清楚表达主要需求，且相手已作出明确理解或回应'],
      partial: ['确认稿表达了需求方向，但仍缺少相手完成确认所必需的信息'],
      notCompleted: ['确认稿未表达与场景相关的主要需求，或双方未形成可判断的理解'],
    },
    closingRules: ['第4轮只确认完成目标仍缺少的最后一项必要信息', '第5轮不提问、不新增条件，以确认或礼貌回应自然结束'],
    maxTurns: 5,
    worldAnchors: ['这是一次五轮的日语口语验证练习'],
    followUpPrinciples: ['每次只确认一项必要信息', '第四轮收束，第五轮不新增任务或问题'],
    hintStrategy: '先提示要表达的方向，再逐级提供关键词、起手式和完整例句。',
    feedbackFocus: ['确认稿是否完成唯一目标', '听力与表达支架的实际使用'],
    safetyBoundary: '不要求真实敏感信息，不承诺执行外部操作。',
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

  const mustGenerate = request.forceGenerate === true
    || request.clarifications.length >= LIMITS.maxScenarioDraftClarifications
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

  let upstream: Response
  try {
    upstream = await fetch(responsesUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(20_000),
    })
  } catch {
    if (mustGenerate) {
      return {
        status: 'ready',
        scenario: createFallbackReadyScenario(request.inputZh),
      }
    }
    throw new ScenarioDraftError('scenario_draft_request_timeout', 'Scenario draft request timed out. Please retry.', 504)
  }

  if (!upstream.ok) {
    if (mustGenerate) {
      return {
        status: 'ready',
        scenario: createFallbackReadyScenario(request.inputZh),
      }
    }
    let upstreamErrText = ''
    try {
      upstreamErrText = (await upstream.text()).slice(0, 500)
    } catch {
      upstreamErrText = ''
    }
    throw new ScenarioDraftError('scenario_draft_request_failed', upstreamErrText || 'OpenAI could not draft this scenario. Retry this request.', 502)
  }
  let modelPayload: unknown
  try {
    modelPayload = await upstream.json()
  } catch {
    if (mustGenerate) {
      return { status: 'ready', scenario: createFallbackReadyScenario(request.inputZh) }
    }
    throw new ScenarioDraftError('scenario_draft_model_invalid', 'Scenario draft model output is invalid. Retry this request.', 502)
  }

  let result: ScenarioDraftModelResult
  try {
    const text = responseTextFromCompletedJson(modelPayload)
    const modelJson = parseModelJson(text)
    result = parseScenarioDraftModelResult(normalizeScenarioDraftResult(modelJson))
  } catch (error) {
    if (mustGenerate) {
      return { status: 'ready', scenario: createFallbackReadyScenario(request.inputZh) }
    }
    if (error instanceof ScenarioDraftError) throw error
    if (error instanceof ValidationError) {
      throw new ScenarioDraftError('scenario_draft_schema_invalid', `Scenario draft model output failed validation: ${error.message}`, 502)
    }
    throw new ScenarioDraftError('scenario_draft_model_invalid', 'Scenario draft model output is invalid. Retry this request.', 502)
  }
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

export async function streamOpenAiReply(env: Env, request: ReplyRequest, callerSignal?: AbortSignal): Promise<Response> {
  const sessionPayload = await verifySessionToken(env, request.sessionToken)
  if (request.history[0]?.text !== sessionPayload.scenario.firstLine) {
    throw new ValidationError('scenario_context_mismatch', 'Conversation history does not start with the scenario first line.')
  }
  const model = env.OPENAI_MODEL || DEFAULT_MODELS.openai
  if (!env.OPENAI_API_KEY) {
    if (env.ALLOW_MOCK === 'true') return mockStream(request, model)
    return new Response(
      JSON.stringify({ error: { code: 'openai_unconfigured', message: 'OpenAI is not configured for this deployment.' } }),
      { status: 503, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } },
    )
  }
  let responsesUrl: string
  try {
    responsesUrl = resolveOpenAiResponsesUrl(env.OPENAI_BASE_URL)
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

  const developerPrompt = buildDynamicDeveloperPrompt(sessionPayload.scenario, request.turn)
  let messagesSlice = request.history
  if (request.history.length > 7) {
    const firstTurn = request.history[0]!
    messagesSlice = [firstTurn, ...request.history.slice(-6)]
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

  const streamController = new AbortController()
  const streamTimer = setTimeout(() => streamController.abort('reply_timeout'), DEADLINES.streamReplyMs)
  const abortUpstream = () => streamController.abort(callerSignal?.reason)
  callerSignal?.addEventListener('abort', abortUpstream, { once: true })
  const upstream = await fetch(responsesUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
    },
    body: JSON.stringify(streamBody),
    signal: streamController.signal,
  })
  if (!upstream.ok || !upstream.body) {
    let upstreamError = ''
    try {
      upstreamError = (await upstream.text()).slice(0, 500)
    } catch {
      upstreamError = ''
    }
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
      const cancelReader = () => { void reader.cancel() }
      streamController.signal.addEventListener('abort', cancelReader, { once: true })
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
                if (!streamController.signal.aborted) controller.enqueue(ndjson({ type: 'delta', text: parsed.delta }))
              } else if (Array.isArray(parsed.choices) && parsed.choices.length > 0) {
                // Standard ChatCompletions streaming chunk: { choices: [{ delta: { content: "..." } }] }
                const choice = parsed.choices[0] as Record<string, unknown>
                const deltaContent = (choice?.delta as { content?: string })?.content
                if (typeof deltaContent === 'string' && deltaContent.length > 0) {
                  output += deltaContent
                  if (!streamController.signal.aborted) controller.enqueue(ndjson({ type: 'delta', text: deltaContent }))
                }
              } else if (parsed.type === 'response.completed') {
                completedResponse = parsed.response
              } else if (parsed.type === 'response.failed' || parsed.type === 'error') {
                throw new Error('OpenAI stream failed before completion.')
              }
            }
          }
        }

        const text = validateAssistantReply(output, request.turn)
        if (!streamController.signal.aborted) controller.enqueue(
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
        if (!streamController.signal.aborted) controller.enqueue(
          ndjson({
            type: 'error',
            code,
            message: error instanceof ValidationError ? error.message : 'OpenAI streaming ended unexpectedly. Retry this step.',
          }),
        )
        controller.close()
      } finally {
        streamController.signal.removeEventListener('abort', cancelReader)
        reader.releaseLock()
        clearTimeout(streamTimer)
      }
    },
    cancel() {
      void streamController.abort('consumer_cancel')
    },
  })

  return streamResponse(stream)
}
export async function generateHint(env: Env, request: HintRequest, signal?: AbortSignal): Promise<HintResponse> {
  const sessionPayload = await verifySessionToken(env, request.sessionToken)
  if (request.history[0]?.text !== sessionPayload.scenario.firstLine) {
    throw new ValidationError('scenario_context_mismatch', 'Hint history does not start with the scenario first line.')
  }
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

  const prompt = buildHintPrompt(sessionPayload.scenario, request.lastAssistantText, request.history)
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
    signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(DEADLINES.interactiveModelMs)]),
  })

  if (!upstream.ok) {
    throw new ScenarioDraftError('hint_request_failed', 'OpenAI hint generation failed.', 502)
  }

  const payload: unknown = await upstream.json()
  const text = responseTextFromCompletedJson(payload)
  return parseHintResponse(parseModelJson(text))
}

export async function generateConversationFeedback(
  env: Env,
  request: ConversationFeedbackRequest,
  signal?: AbortSignal,
): Promise<ConversationFeedbackResponse> {
  const sessionPayload = await verifySessionToken(env, request.sessionToken)
  if (request.turnRecords[0]?.partnerPromptJa !== sessionPayload.scenario.firstLine) {
    throw new ValidationError('scenario_context_mismatch', 'Feedback records do not start with the scenario first line.')
  }

  if (!env.OPENAI_API_KEY) {
    if (env.ALLOW_MOCK === 'true') return createMockFeedback(request, sessionPayload.scenario)
    throw new ScenarioDraftError('openai_unconfigured', 'OpenAI is not configured for this deployment.', 503)
  }

  const prompt = buildFeedbackPrompt(sessionPayload.scenario, request)
  const parsedJson = await generateStructuredFeedbackJson(
    env,
    prompt,
    LIMITS.feedbackOutputTokens,
    'feedback_request_failed',
    'OpenAI conversation feedback generation failed.',
    'feedback_model_invalid',
    'Feedback model output is invalid. Retry this request.',
    DEADLINES.feedbackWorkflowModelMs,
    signal,
  )

  try {
    return parseConversationFeedbackResponse(parsedJson, request.turnRecords, sessionPayload.scenario)
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new ScenarioDraftError('feedback_model_invalid', error.message, 502)
    }
    throw error
  }
}

export async function generateRedoFeedback(
  env: Env,
  request: RedoFeedbackRequest,
  signal?: AbortSignal,
): Promise<RedoFeedbackResponse> {
  const sessionPayload = await verifySessionToken(env, request.sessionToken)
  if (request.turn === 1 && request.partnerPromptJa !== sessionPayload.scenario.firstLine) {
    throw new ValidationError('scenario_context_mismatch', 'Redo feedback does not reference the real first turn.')
  }

  if (!env.OPENAI_API_KEY) {
    if (env.ALLOW_MOCK === 'true') return createMockRedoFeedback(request)
    throw new ScenarioDraftError('openai_unconfigured', 'OpenAI is not configured for this deployment.', 503)
  }

  const prompt = buildRedoFeedbackPrompt(sessionPayload.scenario, request)
  const parsedJson = await generateStructuredFeedbackJson(
    env,
    prompt,
    LIMITS.redoFeedbackOutputTokens,
    'redo_feedback_request_failed',
    'OpenAI redo feedback generation failed.',
    'redo_feedback_model_invalid',
    'Redo feedback model output is invalid. Retry this request.',
    DEADLINES.feedbackWorkflowModelMs,
    signal,
  )

  try {
    return parseRedoFeedbackResponse(parsedJson, request)
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new ScenarioDraftError('redo_feedback_model_invalid', error.message, 502)
    }
    throw error
  }
}

export async function generateListeningScaffold(
  env: Env,
  request: ListeningScaffoldRequest,
  signal?: AbortSignal,
): Promise<ListeningScaffoldResponse> {
  const session = await verifySessionToken(env, request.sessionToken)
  if (!env.OPENAI_API_KEY) {
    if (env.ALLOW_MOCK === 'true') {
      return createMockListeningScaffold(request)
    }
    throw new ScenarioDraftError('openai_unconfigured', 'OpenAI is not configured for this deployment.', 503)
  }

  const prompt = buildListeningScaffoldPrompt(session.scenario, request)
  const parsedJson = await generateStructuredFeedbackJson(
    env,
    prompt,
    300,
    'listening_scaffold_request_failed',
    'OpenAI listening scaffold generation failed.',
    'listening_scaffold_model_invalid',
    'Listening scaffold model output is invalid.',
    DEADLINES.interactiveModelMs,
    signal,
  )

  try {
    return parseListeningScaffoldModelOutput(parsedJson, request.partnerPromptJa)
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new ScenarioDraftError('listening_scaffold_model_invalid', error.message, 502)
    }
    throw error
  }
}

export async function generateSpeechAssist(
  env: Env,
  request: SpeechAssistRequest,
  signal?: AbortSignal,
): Promise<SpeechAssistResponse> {
  const session = await verifySessionToken(env, request.sessionToken)
  if (!env.OPENAI_API_KEY) {
    if (env.ALLOW_MOCK === 'true') {
      return createMockSpeechAssist(request)
    }
    throw new ScenarioDraftError('openai_unconfigured', 'OpenAI is not configured for this deployment.', 503)
  }
  const prompt = buildSpeechAssistPrompt(session.scenario, request)
  const parsedJson = await generateStructuredFeedbackJson(
    env,
    prompt,
    150,
    'speech_assist_request_failed',
    'OpenAI speech assist generation failed.',
    'speech_assist_model_invalid',
    'Speech assist model output is invalid.',
    DEADLINES.interactiveModelMs,
    signal,
  )

  return parseSpeechAssistModelOutput(parsedJson, request.observedTextJa)
}

export async function polishScenarioText(
  env: Env,
  request: ScenarioPolishRequest,
  signal?: AbortSignal,
): Promise<ScenarioPolishResponse> {
  if (!env.OPENAI_API_KEY) {
    throw new ScenarioDraftError('openai_unconfigured', 'OpenAI is not configured for this deployment.', 503)
  }
  const parsedJson = await generateStructuredFeedbackJson(
    env,
    buildScenarioPolishPrompt(request),
    1_200,
    'scenario_polish_request_failed',
    'OpenAI scenario text polish failed.',
    'scenario_polish_model_invalid',
    'Scenario polish model output is invalid.',
    DEADLINES.interactiveModelMs,
    signal,
  )
  try {
    return parseScenarioPolishResponse(parsedJson)
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new ScenarioDraftError('scenario_polish_model_invalid', error.message, 502)
    }
    throw error
  }
}

async function generateStructuredFeedbackJson(
  env: Env,
  prompt: string,
  maxOutputTokens: number,
  requestErrorCode: string,
  requestErrorMessage: string,
  modelErrorCode: string,
  modelErrorMessage: string,
  deadlineMs: number = DEADLINES.interactiveModelMs,
  signal?: AbortSignal,
): Promise<unknown> {
  let responsesUrl: string
  try {
    responsesUrl = resolveOpenAiResponsesUrl(env.OPENAI_BASE_URL)
  } catch {
    throw new ScenarioDraftError('openai_base_url_invalid', 'OPENAI_BASE_URL is invalid.', 500)
  }
  const model = env.OPENAI_MODEL || DEFAULT_MODELS.openai
  const isResponsesEndpoint = responsesUrl.endsWith('/responses')
  const requestBody = isResponsesEndpoint
    ? {
        model,
        input: [{ role: 'developer', content: prompt }],
        reasoning: { effort: 'low' },
        max_output_tokens: maxOutputTokens,
        store: false,
        stream: false,
        tools: [],
        text: { format: { type: 'json_object' } },
      }
    : {
        model,
        messages: [{ role: 'system', content: prompt }],
        max_tokens: maxOutputTokens,
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
    signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(deadlineMs)]),
  })
  if (!upstream.ok) {
    throw new ScenarioDraftError(requestErrorCode, requestErrorMessage, 502)
  }

  let modelPayload: unknown
  try {
    modelPayload = await upstream.json()
  } catch {
    throw new ScenarioDraftError(modelErrorCode, modelErrorMessage, 502)
  }
  try {
    return parseModelJson(responseTextFromCompletedJson(modelPayload))
  } catch {
    throw new ScenarioDraftError(modelErrorCode, modelErrorMessage, 502)
  }
}
