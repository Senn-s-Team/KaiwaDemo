/**
 * [INPUT]: 依赖 Worker 环境、HTTP 边界、token、严格请求校验及各模型编排入口
 * [OUTPUT]: 对外提供配置、场景、长期复练凭据续签、会话、回复、反馈、四级听力支架、场景润色与语音服务的同源 API 路由
 * [POS]: Worker 请求入口，统一执行方法、同源、JSON 大小、鉴权与错误响应边界
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { DEFAULT_MODELS, LIMITS } from './constants'
import { createElevenLabsToken } from './elevenlabs'
import type { Env } from './env'
import {
  assertSameOriginRequest,
  errorJson,
  json,
  methodNotAllowed,
  readJsonBody,
  RequestBodyError,
} from './http'
import {
  generateHint,
  generateListeningScaffold,
  polishScenarioText,
  generateSpeechAssist,
  ScenarioDraftError,
  streamOpenAiReply,
} from './openai'
import {
  signPracticeToken,
  verifyPracticeToken,
  signScenarioToken,
  signSessionToken,
  TokenError,
  verifyScenarioToken,
} from './tokens'
import {
  parseHintRequest,
  parseListeningScaffoldRequest,
  parseReplyRequest,
  parseScenarioPolishRequest,
  parsePracticeRestartRequest,
  parseSessionStartRequest,
  parseSpeechAssistRequest,
  parseTokenRequest,
  ValidationError,
} from './validation'
import { handleScenarioDraftGet, handleScenarioDraftPost, ScenarioDraftTaskError } from './scenario-draft-task'
import { handleFeedbackTaskGet, handleFeedbackTaskPost, FeedbackTaskError } from './feedback-task'
function configResponse(env: Env): Response {
  const elevenlabsConfigured = Boolean(env.ELEVENLABS_API_KEY)
  const ttsConfigured = elevenlabsConfigured && Boolean(env.ELEVENLABS_VOICE_ID)
  const openaiConfigured = Boolean(env.OPENAI_API_KEY)
  const mode = elevenlabsConfigured && ttsConfigured && openaiConfigured
    ? 'real'
    : env.ALLOW_MOCK === 'true'
      ? 'mock'
      : 'partial'

  return json({
    mode,
    limits: { maxTurns: LIMITS.maxTurns },
    elevenlabs: {
      sttAvailable: elevenlabsConfigured,
      ttsAvailable: ttsConfigured,
      voiceId: ttsConfigured ? env.ELEVENLABS_VOICE_ID : null,
      sttModel: env.ELEVENLABS_STT_MODEL || DEFAULT_MODELS.stt,
      ttsModel: env.ELEVENLABS_TTS_MODEL || DEFAULT_MODELS.tts,
    },
    openai: {
      available: openaiConfigured,
      model: env.OPENAI_MODEL || DEFAULT_MODELS.openai,
      mockAllowed: env.ALLOW_MOCK === 'true',
    },
  })
}

async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)

  if (url.pathname === '/api/config') {
    return request.method === 'GET' ? configResponse(env) : methodNotAllowed('GET')
  }

  const originError = assertSameOriginRequest(request)
  if (originError) return originError

  if (url.pathname === '/api/elevenlabs/token') {
    if (request.method !== 'POST') return methodNotAllowed('POST')
    const body = await readJsonBody(request, LIMITS.requestBytes)
    return createElevenLabsToken(env, parseTokenRequest(body), request.signal)
  }

  if (url.pathname === '/api/scenario/draft') {
    if (request.method === 'POST') return handleScenarioDraftPost(request, env)
    if (request.method === 'GET') return handleScenarioDraftGet(request, env)
    return methodNotAllowed('GET, POST')
  }

  if (url.pathname === '/api/practice/restart') {
    if (request.method !== 'POST') return methodNotAllowed('POST')
    const restartRequest = parsePracticeRestartRequest(await readJsonBody(request, LIMITS.requestBytes))
    const payload = await verifyPracticeToken(env, restartRequest.practiceToken)
    const scenarioToken = await signScenarioToken(env, { scenario: payload.scenario, expiresAt: Date.now() + LIMITS.scenarioTokenTtlMs })
    return json({ status: 'ready', scenario: payload.scenario, scenarioToken, practiceToken: restartRequest.practiceToken })
  }

  if (url.pathname === '/api/session/start') {
    if (request.method !== 'POST') return methodNotAllowed('POST')
    const body = await readJsonBody(request, LIMITS.requestBytes)
    const startRequest = parseSessionStartRequest(body)
    const scenarioPayload = await verifyScenarioToken(env, startRequest.scenarioToken)
    const startedAt = Date.now()
    const sessionId = `dyn_ses_${crypto.randomUUID().replaceAll('-', '')}`
    const sessionToken = await signSessionToken(env, {
      scenario: scenarioPayload.scenario,
      startedAt,
      expiresAt: startedAt + LIMITS.sessionTokenTtlMs,
    })

    return json({
      sessionId,
      scenarioType: 'dynamic',
      ...(scenarioPayload.scenario.evidencePoints ? { practiceToken: await signPracticeToken(env, scenarioPayload.scenario) } : {}),
      sessionToken,
      scenario: scenarioPayload.scenario,
      firstLine: scenarioPayload.scenario.firstLine,
      maxTurns: LIMITS.maxTurns,
      reveal: {
        titleZh: scenarioPayload.scenario.titleZh,
        summaryZh: scenarioPayload.scenario.summaryZh,
      },
    })
  }

  if (url.pathname === '/api/respond') {
    if (request.method !== 'POST') return methodNotAllowed('POST')
    const body = await readJsonBody(request, LIMITS.requestBytes)
    return streamOpenAiReply(env, parseReplyRequest(body), request.signal)
  }

  if (url.pathname === '/api/hint') {
    if (request.method !== 'POST') return methodNotAllowed('POST')
    const body = await readJsonBody(request, LIMITS.requestBytes)
    return json(await generateHint(env, parseHintRequest(body), request.signal))
  }

  if (url.pathname === '/api/listening-scaffold') {
    if (request.method !== 'POST') return methodNotAllowed('POST')
    const body = await readJsonBody(request, LIMITS.requestBytes)
    return json(await generateListeningScaffold(env, parseListeningScaffoldRequest(body), request.signal))
  }

  if (url.pathname === '/api/feedback/tasks') {
    if (request.method === 'POST') return handleFeedbackTaskPost(request, env)
    if (request.method === 'GET') return handleFeedbackTaskGet(request, env)
    return methodNotAllowed('GET, POST')
  }

  if (url.pathname === '/api/speech/assist') {
    if (request.method !== 'POST') return methodNotAllowed('POST')
    const body = await readJsonBody(request, LIMITS.requestBytes)
    return json(await generateSpeechAssist(env, parseSpeechAssistRequest(body), request.signal))
  }

  if (url.pathname === '/api/scenario/polish') {
    if (request.method !== 'POST') return methodNotAllowed('POST')
    const body = await readJsonBody(request, LIMITS.requestBytes)
    return json(await polishScenarioText(env, parseScenarioPolishRequest(body), request.signal))
  }

  return errorJson(404, 'not_found', 'API route not found.')
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      return await handleApi(request, env)
    } catch (error) {
      if (error instanceof RequestBodyError) {
        return errorJson(error.status, error.code, error.message)
      }
      if (error instanceof ValidationError) {
        return errorJson(400, error.code, error.message)
      }
      if (error instanceof TokenError || error instanceof ScenarioDraftError || error instanceof ScenarioDraftTaskError || error instanceof FeedbackTaskError) {
        return errorJson(error.status, error.code, error.message)
      }
      return errorJson(500, 'internal_error', 'The prototype could not complete this request. Retry the current step.')
    }
  },
} satisfies ExportedHandler<Env>
