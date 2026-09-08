/**
 * [INPUT]: 依赖 zod、../types 与 shared/ 下跨端 wire schema
 * [OUTPUT]: 提供配置、动态会话、可恢复场景草稿、回复、提示、durable 反馈任务、听力支架、语音续说辅助与场景润色请求函数及响应校验
 * [POS]: src/lib 的 HTTP 通信边界，负责序列化前端请求并严格验证服务端结构化响应
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { z } from 'zod'
import {
  ListeningScaffoldResponseSchema,
  type ListeningScaffoldRequest,
  type ListeningScaffoldResponse,
} from '../../shared/listening-scaffold'
import {
  SpeechAssistResponseSchema,
  type SpeechAssistRequest,
  type SpeechAssistResponse,
} from '../../shared/speech-assist'
import { ScenarioPolishResponseSchema } from '../../shared/scenario-polish'
import {
  ScenarioDraftTaskAcceptedSchema,
  ScenarioDraftTaskRequestSchema,
  ScenarioDraftTaskStatusSchema,
  type ScenarioDraftTaskAccepted,
  type ScenarioDraftTaskRequest,
  type ScenarioDraftTaskStatus,
} from '../../shared/scenario-draft'
import {
  FeedbackTaskAcceptedSchema,
  FeedbackTaskRequestSchema,
  FeedbackTaskStatusSchema,
  type FeedbackTaskAccepted,
  type FeedbackTaskRequest,
  type FeedbackTaskStatus,
} from '../../shared/feedback-task'
import type {
  ConversationFeedbackRequest,
  ConversationMessage,
  PrototypeConfig,
  RoundRecord,
  SessionScenario,
  UsageSummary,
} from '../types'
const ConfigSchema = z.object({
  mode: z.enum(['real', 'partial', 'mock']),
  limits: z.object({ maxTurns: z.literal(5) }),
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
  scenarioToken: string,
  signal?: AbortSignal,
): Promise<SessionScenario> {
  const response = await fetch('/api/session/start', {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ type: 'dynamic', scenarioToken }),
  })
  if (!response.ok) throw await errorFromResponse(response)
  const data = (await response.json()) as Record<string, unknown>
  const dynamicData = data.scenario as SessionScenario['dynamicData']
  return {
    id: dynamicData.id,
    version: dynamicData.version,
    variantId: 'dynamic-variant',
    firstLine: data.firstLine as string,
    maxTurns: 5,
    scenarioType: 'dynamic',
    sessionToken: data.sessionToken as string,
    scenarioToken,
    practiceToken: data.practiceToken as string | undefined,
    dynamicData,
    reveal: data.reveal as SessionScenario['reveal'],
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
  scenario: Pick<SessionScenario, 'sessionToken'>,
  onFirstText: () => void,
  signal?: AbortSignal,
): Promise<ReplyResult> {
  const body = {
    scenarioType: 'dynamic',
    sessionId,
    sessionToken: scenario.sessionToken,
    turn,
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
export async function submitScenarioDraft(
  request: ScenarioDraftTaskRequest,
  signal?: AbortSignal,
): Promise<ScenarioDraftTaskAccepted> {
  const response = await fetch('/api/scenario/draft', {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(ScenarioDraftTaskRequestSchema.parse(request)),
  })
  if (!response.ok) throw await errorFromResponse(response)
  return ScenarioDraftTaskAcceptedSchema.parse(await response.json())
}

export async function getScenarioDraftTask(
  taskToken: string,
  signal?: AbortSignal,
): Promise<ScenarioDraftTaskStatus> {
  const response = await fetch('/api/scenario/draft', {
    signal,
    headers: { accept: 'application/json', authorization: `Bearer ${taskToken}` },
  })
  if (!response.ok) throw await errorFromResponse(response)
  return ScenarioDraftTaskStatusSchema.parse(await response.json())
}

export async function fetchHint(
  scenario: SessionScenario,
  lastAssistantText: string,
  history: ConversationMessage[],
  intentionZh?: string,
  signal?: AbortSignal,
): Promise<import('../types').HintResponse> {
  const body = {
    scenarioType: 'dynamic',
    sessionToken: scenario.sessionToken,
    lastAssistantText,
    history: history.map(({ role, text }) => ({ role, text })),
    ...(intentionZh?.trim() ? { intentionZh: intentionZh.trim() } : {}),
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

export async function requestListeningScaffold(
  request: ListeningScaffoldRequest,
  signal?: AbortSignal,
): Promise<ListeningScaffoldResponse> {
  const response = await fetch('/api/listening-scaffold', {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(request),
  })
  if (!response.ok) throw await errorFromResponse(response)
  return ListeningScaffoldResponseSchema.parse(await response.json())
}


export function buildFeedbackRequestPayload(
  scenario: Pick<SessionScenario, 'sessionToken'>,
  rounds: RoundRecord[],
): ConversationFeedbackRequest {
  return {
    scenarioType: 'dynamic',
    sessionToken: scenario.sessionToken,
    turnRecords: rounds.map((record, index) => ({
      turn: record.turn || index + 1,
      partnerPromptJa: record.aiPrompt,
      userOriginal: record.userOriginal,
      userCleaned: record.userCleaned,
      userConfirmed: record.userFinal,
      inputMode: record.inputMode,
      transcriptModified: record.transcriptModified,
      rerecordCount: record.rerecordCount,
      partnerAudioPlayCount: (record.timing.audioStartedAt === null ? 0 : 1) + record.ttsReplayCount,
      ttsReplayCount: record.ttsReplayCount,
      transcriptRevealed: record.transcriptRevealed,
      listeningScaffoldLevel: record.listeningScaffoldLevel,
      expressionScaffoldLevel: normalizeExpressionScaffoldLevel(record.expressionScaffoldLevel),
      failureCount: record.failureCount,
      retryCount: record.retryCount,
      textFallback: record.inputMode === 'text',
      speechAssistUsed: record.speechAssistEvents.some((event) => event.displayed && event.continuationSuggestionJa !== null),
    })),
  }
}

function normalizeExpressionScaffoldLevel(value: number): 0 | 1 | 2 | 3 | 4 {
  if (!Number.isFinite(value) || value <= 0) return 0
  const level = Math.floor(value)
  if (level >= 4) return 4
  if (level === 3) return 3
  if (level === 2) return 2
  if (level === 1) return 1
  return 0
}

export async function submitFeedbackTask(
  request: FeedbackTaskRequest,
  signal?: AbortSignal,
): Promise<FeedbackTaskAccepted> {
  const response = await fetch('/api/feedback/tasks', {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(FeedbackTaskRequestSchema.parse(request)),
  })
  if (!response.ok) throw await errorFromResponse(response)
  return FeedbackTaskAcceptedSchema.parse(await response.json())
}

export async function getFeedbackTask(
  taskToken: string,
  signal?: AbortSignal,
): Promise<FeedbackTaskStatus> {
  const response = await fetch('/api/feedback/tasks', {
    signal,
    headers: { accept: 'application/json', authorization: `Bearer ${taskToken}` },
  })
  if (!response.ok) throw await errorFromResponse(response)
  return FeedbackTaskStatusSchema.parse(await response.json())
}


export async function requestSpeechAssist(
  request: SpeechAssistRequest,
  signal?: AbortSignal,
): Promise<SpeechAssistResponse> {
  const response = await fetch('/api/speech/assist', {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(request),
  })
  if (!response.ok) throw await errorFromResponse(response)
  return SpeechAssistResponseSchema.parse(await response.json())
}

export async function polishScenarioText(textZh: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch('/api/scenario/polish', {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ textZh }),
  })
  if (!response.ok) throw await errorFromResponse(response)
  return ScenarioPolishResponseSchema.parse(await response.json()).textZh
}

export async function restartPractice(practiceToken: string, signal?: AbortSignal): Promise<import('../types').ScenarioDraftReadyResponse> {
  const response = await fetch('/api/practice/restart', {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ practiceToken }),
  })
  if (!response.ok) throw await errorFromResponse(response)
  return response.json() as Promise<import('../types').ScenarioDraftReadyResponse>
}
