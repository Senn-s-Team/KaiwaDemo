/**
 * [INPUT]: Worker 反馈路由、模型响应与签名会话
 * [OUTPUT]: 验证逐项评价版本、真实引用与回退事实
 * [POS]: tests/worker 的反馈与重做契约测试
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../../worker/index'
import { executeFeedbackTask } from '../../worker/feedback-task-execute'
import { handleFeedbackTaskGet, handleFeedbackTaskPost } from '../../worker/feedback-task'
import type { Env } from '../../worker/env'
import { signSessionToken } from '../../worker/tokens'
import type {
  ConversationFeedbackRequest,
  ConversationFeedbackResponse,
  DynamicScenarioDefinition,
  FeedbackTurnRecord,
  RedoFeedbackRequest,
  RedoFeedbackResponse,
} from '../../worker/types'

const API_ORIGIN = 'https://kaiwa.example'
const env: Env = {
  OPENAI_API_KEY: 'test-openai-key',
  SCENARIO_SIGNING_SECRET: 'test-scenario-signing-secret',
}

type WorkerFetch = (request: Request, workerEnv: Env) => Response | Promise<Response>
class FeedbackWorkflowAdapter {
  private readonly outputs = new Map<string, Promise<unknown>>()
  async create(options: { id?: string; params?: unknown }) {
    if (!options.id || this.outputs.has(options.id)) throw new Error('already exists')
    this.outputs.set(options.id, executeFeedbackTask((this as unknown as { env: Env }).env, options.params as never))
    return { id: options.id, status: async () => ({ status: 'complete', output: await this.outputs.get(options.id!) }) }
  }
  async get(id: string) {
    const output = this.outputs.get(id)
    if (!output) throw new Error('not found')
    return { id, status: async () => ({ status: 'complete', output: await output }) }
  }
  env!: Env
}
const fetchWorker: WorkerFetch = async (request, workerEnv) => {
  if (!request.url.includes('/api/conversation/feedback') && !request.url.includes('/api/conversation/redo-feedback')) return (worker.fetch as unknown as WorkerFetch)(request, workerEnv)
  const payload = await request.json() as Record<string, unknown>
  const adapter = new FeedbackWorkflowAdapter()
  const env = { ...workerEnv, FEEDBACK_TASK: adapter } as Env
  adapter.env = env
  const envelope = {
    kind: request.url.includes('redo-feedback') ? 'redo' : 'conversation',
    requestId: crypto.randomUUID(), createdAt: Date.now(), payload,
  }
  const accepted = await handleFeedbackTaskPost(new Request(`${API_ORIGIN}/api/feedback/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(envelope) }), env)
  if (accepted.status !== 202) return accepted
  const { taskToken } = await accepted.json() as { taskToken: string }
  const completed = await handleFeedbackTaskGet(new Request(`${API_ORIGIN}/api/feedback/tasks`, { headers: { authorization: `Bearer ${taskToken}` } }), env)
  const status = await completed.json() as { status: string; result?: unknown; error?: unknown }
  return new Response(JSON.stringify(status.status === 'complete' ? status.result : { error: status.error }), { status: status.status === 'complete' ? 200 : 502, headers: { 'content-type': 'application/json' } })
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${API_ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

const scenario: DynamicScenarioDefinition = {
  id: 'dynamic-hotel-checkin',
  version: 1,
  titleZh: '酒店办理入住',
  summaryZh: '向酒店前台出示预订并完成入住。',
  aiRole: 'ホテルフロント係',
  userRole: '宿泊客',
  relationship: '初対面の接客',
  tone: '丁寧体',
  firstLine: 'いらっしゃいませ。チェックインでございますか？',
  userGoal: '用日语完成酒店入住。',
  coreGoal: { id: 'checkin', titleZh: '完成入住', descriptionZh: '告知预订姓名并明确提出入住请求。' },
  communicationFunction: '在酒店前台确认预订信息并提出入住请求。',
  initialFacts: ['用户已预订当日一晚住宿', '入住办理从15时开始'],
  partnerPrivateFacts: ['前台可通过预订姓名核对订单'],
  keyIntents: ['告知预订姓名', '明确提出办理入住'],
  keyInformation: ['预订姓名为田中', '住宿一晚'],
  completionRules: {
    completed: ['告知预订姓名并明确提出入住请求'],
    partial: ['仅告知姓名或仅提出入住请求'],
    notCompleted: ['未提供可核对预订的信息，也未提出入住请求'],
  },
  closingRules: ['确认预订姓名和住宿晚数后结束办理'],
  maxTurns: 5,
  partnerOpeningPlan: '先确认客人是否要办理入住，再依次核对预订姓名和住宿晚数。',
  worldAnchors: ['チェックインは15時から'],
  followUpPrinciples: ['一つずつ確認する', '第4ターンから収束する'],
  hintStrategy: '先说明姓名，再提出入住请求。',
  feedbackFocus: ['请求是否清楚', '支架使用事实'],
  safetyBoundary: '不索取真实证件号码或支付信息。',
}

function turnRecord(turn: number, overrides: Partial<FeedbackTurnRecord> = {}): FeedbackTurnRecord {
  return {
    turn,
    partnerPromptJa: turn === 1 ? scenario.firstLine : `第${turn}ターンの相手発話です。`,
    userOriginal: `第${turn}轮原始转写`,
    userCleaned: `第${turn}轮整理稿`,
    userConfirmed: turn === 1 ? '田中です。チェックインをお願いします。' : `第${turn}ターンの確認稿です。`,
    inputMode: 'stt',
    transcriptModified: false,
    rerecordCount: 0,
    partnerAudioPlayCount: 1,
    ttsReplayCount: 0,
    transcriptRevealed: false,
    listeningScaffoldLevel: 0,
    expressionScaffoldLevel: 0,
    failureCount: 0,
    retryCount: 0,
    textFallback: false,
    speechAssistUsed: false,
    ...overrides,
  }
}

async function sessionToken(): Promise<string> {
  return signSessionToken(env, {
    scenario,
    startedAt: Date.now(),
    expiresAt: Date.now() + 3_600_000,
  })
}

async function feedbackRequest(): Promise<ConversationFeedbackRequest> {
  return {
    scenarioType: 'dynamic',
    sessionToken: await sessionToken(),
    turnRecords: [
      turnRecord(1),
      turnRecord(2, { ttsReplayCount: 1, listeningScaffoldLevel: 1 }),
      turnRecord(3),
      turnRecord(4),
      turnRecord(5),
    ],
  }
}

const validFeedback = (records: FeedbackTurnRecord[]): ConversationFeedbackResponse => ({
  performance: {
    version: 1,
    dimensions: {
      communicationAchievement: { rating: 3, status: 'observed', reasonZh: '确认稿完成了入住诉求。', evidence: [{ turn: 1, role: 'user', quoteJa: records[0]!.userConfirmed }] },
      responseRelevance: { rating: 3, status: 'observed', reasonZh: '确认稿回应了当前办理入住的话题。', evidence: [{ turn: 1, role: 'user', quoteJa: records[0]!.userConfirmed }] },
      expressionClarity: { rating: 2, status: 'observed', reasonZh: '确认稿的姓名和请求清楚。', evidence: [{ turn: 1, role: 'user', quoteJa: records[0]!.userConfirmed }] },
      clarificationRepair: { rating: null, status: 'not_needed', reasonZh: '本场没有需要修复的澄清。', evidence: [] },
    },
  },
  outcome: 'completed',
  outcomeEvidenceZh: `确认稿“${records[0]!.userConfirmed}”明确给出了姓名并提出入住请求。`,
  listeningFinding: {
    turn: 2,
    findingZh: '这一轮在原速重听后完成了确认。',
    evidenceZh: '第2轮记录为L1，重听1次。',
  },
  expressionImprovement: {
    turn: 1,
    userConfirmedJa: records[0]!.userConfirmed,
    suggestedJa: '予約している田中と申します。チェックインをお願いいたします。',
    reasonZh: '在前台场景中补充“予約している”并使用自谦式姓名表达更自然。',
  },
  redoTask: {
    turn: 1,
    partnerPromptJa: records[0]!.partnerPromptJa,
    firstConfirmedJa: records[0]!.userConfirmed,
    directionZh: '补充已经预约这一背景，并保持礼貌的入住请求。',
  },
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('POST /api/conversation/feedback', () => {
  it('returns conservative mock feedback instead of inventing completion', async () => {
    const request = await feedbackRequest()
    const response = await fetchWorker(post('/api/conversation/feedback', request), {
      ALLOW_MOCK: 'true',
      SCENARIO_SIGNING_SECRET: env.SCENARIO_SIGNING_SECRET,
    })
    const body = (await response.json()) as ConversationFeedbackResponse

    expect(response.status).toBe(200)
    expect(body.outcome).toBe('insufficient_evidence')
    expect(body.outcomeEvidenceZh).toContain(request.turnRecords[4]!.userConfirmed)
    expect(body.redoTask).toMatchObject({
      turn: 5,
      partnerPromptJa: request.turnRecords[4]!.partnerPromptJa,
      firstConfirmedJa: request.turnRecords[4]!.userConfirmed,
    })
  })

  it('accepts one to five sequential records and rejects inconsistent scaffold facts', async () => {
    const request = await feedbackRequest()
    const earlyReview = await fetchWorker(post('/api/conversation/feedback', {
      ...request,
      turnRecords: request.turnRecords.slice(0, 4),
    }), { ALLOW_MOCK: 'true', SCENARIO_SIGNING_SECRET: env.SCENARIO_SIGNING_SECRET })
    expect(earlyReview.status).toBe(200)

    const inconsistentReveal = await fetchWorker(post('/api/conversation/feedback', {
      ...request,
      turnRecords: request.turnRecords.map((record, index) => index === 1
        ? { ...record, transcriptRevealed: true, listeningScaffoldLevel: 1 }
        : record),
    }), { ALLOW_MOCK: 'true', SCENARIO_SIGNING_SECRET: env.SCENARIO_SIGNING_SECRET })
    expect(inconsistentReveal.status).toBe(400)
  })

  it('sends all observable turn facts and accepts a strictly grounded response', async () => {
    const request = await feedbackRequest()
    request.turnRecords[2] = turnRecord(3, { speechAssistUsed: true })
    const modelResponse = validFeedback(request.turnRecords)
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ output_text: JSON.stringify(modelResponse) })))
    vi.stubGlobal('fetch', fetchMock)

    const response = await fetchWorker(post('/api/conversation/feedback', request), env)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(modelResponse)

    const options = fetchMock.mock.calls[0]?.[1]
    if (!options || typeof options !== 'object' || !('body' in options) || typeof options.body !== 'string') {
      throw new Error('Feedback request body was not sent upstream.')
    }
    for (const field of [
      'partnerPromptJa', 'userConfirmed', 'inputMode', 'rerecordCount', 'partnerAudioPlayCount', 'ttsReplayCount',
      'transcriptRevealed', 'listeningScaffoldLevel', 'expressionScaffoldLevel', 'failureCount', 'retryCount', 'textFallback',
      'speechAssistUsed',
    ]) {
      expect(options.body).toContain(field)
    }
  })

  it('rejects fabricated quotes, mismatched turns, and forbidden evaluation dimensions', async () => {
    const request = await feedbackRequest()
    const base = validFeedback(request.turnRecords)
    for (const bad of [
      { ...base, outcomeEvidenceZh: '目标已经完成。' },
      { ...base, expressionImprovement: { ...base.expressionImprovement!, userConfirmedJa: '架空の発話' } },
      { ...base, redoTask: { ...base.redoTask, partnerPromptJa: '架空の相手発話' } },
      { ...base, outcomeEvidenceZh: `确认稿“${request.turnRecords[0]!.userConfirmed}”证明发音得分为90分。` },
    ]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ output_text: JSON.stringify(bad) }))))
      const response = await fetchWorker(post('/api/conversation/feedback', request), env)
      expect(response.status).toBe(502)
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'feedback_model_invalid' } })
    }
  })
})

describe('POST /api/conversation/redo-feedback', () => {
  async function redoRequest(): Promise<RedoFeedbackRequest> {
    return {
      scenarioType: 'dynamic',
      sessionToken: await sessionToken(),
      turn: 1,
      partnerPromptJa: scenario.firstLine,
      firstConfirmedJa: '田中です。チェックインをお願いします。',
      secondConfirmedJa: '予約している田中と申します。チェックインをお願いいたします。',
      secondInputMode: 'stt',
      secondListeningScaffoldLevel: 1,
      secondExpressionScaffoldLevel: 2,
    }
  }

  it('returns only comparisonZh and referenceExpressionJa in mock mode', async () => {
    const request = await redoRequest()
    const response = await fetchWorker(post('/api/conversation/redo-feedback', request), {
      ALLOW_MOCK: 'true',
      SCENARIO_SIGNING_SECRET: env.SCENARIO_SIGNING_SECRET,
    })
    const body = (await response.json()) as RedoFeedbackResponse

    expect(response.status).toBe(200)
    expect(Object.keys(body)).toEqual(['comparisonZh', 'referenceExpressionJa'])
    expect(body.comparisonZh).toContain(request.firstConfirmedJa)
    expect(body.comparisonZh).toContain(request.secondConfirmedJa)
  })

  it('rejects a first-turn redo that does not reference the signed scenario opening', async () => {
    const request = await redoRequest()
    const response = await fetchWorker(post('/api/conversation/redo-feedback', {
      ...request,
      partnerPromptJa: '架空の相手発話',
    }), { ALLOW_MOCK: 'true', SCENARIO_SIGNING_SECRET: env.SCENARIO_SIGNING_SECRET })
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'scenario_context_mismatch' } })
  })

  it('accepts a grounded comparison and rejects forbidden or unquoted model output', async () => {
    const request = await redoRequest()
    const valid: RedoFeedbackResponse = {
      comparisonZh: `第一稿“${request.firstConfirmedJa}”直接说明姓名；第二稿“${request.secondConfirmedJa}”补充预约背景并更符合前台关系。`,
      referenceExpressionJa: '予約しております田中と申します。チェックインをお願いいたします。',
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ output_text: JSON.stringify(valid) }))))
    const accepted = await fetchWorker(post('/api/conversation/redo-feedback', request), env)
    expect(accepted.status).toBe(200)
    await expect(accepted.json()).resolves.toEqual(valid)

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ output_text: JSON.stringify({
      ...valid,
      comparisonZh: '第二稿显示能力等级已经掌握，得分90分。',
    }) }))))
    const rejected = await fetchWorker(post('/api/conversation/redo-feedback', request), env)
    expect(rejected.status).toBe(502)
    await expect(rejected.json()).resolves.toMatchObject({ error: { code: 'redo_feedback_model_invalid' } })
  })
})

describe('versioned evidence validation', () => {
  it('requires complete rubric coverage and exact confirmed quotations', async () => {
    const { parseConversationFeedbackResponse } = await import('../../worker/validation')
    const records = [turnRecord(1), turnRecord(2, { listeningScaffoldLevel: 1, ttsReplayCount: 1 })]
    const rubricScenario = { ...scenario, evaluationVersion: 1, evidencePoints: [scenario.coreGoal] }
    const feedback = { ...validFeedback(records), evaluationVersion: 1, evidenceResults: [{ pointId: scenario.coreGoal.id, status: 'completed', evidence: [{ turn: 1, quoteJa: records[0]!.userConfirmed }] }] }
    expect(parseConversationFeedbackResponse(feedback, records, rubricScenario)).toEqual(feedback)
    for (const changed of [
      { ...feedback, evaluationVersion: 2 },
      { ...feedback, evidenceResults: [] },
      { ...feedback, evidenceResults: [...feedback.evidenceResults, ...feedback.evidenceResults] },
      { ...feedback, evidenceResults: [{ ...feedback.evidenceResults[0], evidence: [] }] },
      { ...feedback, evidenceResults: [{ ...feedback.evidenceResults[0], evidence: [{ turn: 1, quoteJa: '架空の発話' }] }] },
      { ...feedback, evidenceResults: [{ ...feedback.evidenceResults[0], evidence: [{ turn: 1, quoteJa: scenario.firstLine }] }] },
    ]) expect(() => parseConversationFeedbackResponse(changed, records, rubricScenario)).toThrow()
    expect(() => parseConversationFeedbackResponse(feedback, records, scenario)).toThrow()
    expect(parseConversationFeedbackResponse({ ...feedback, evidenceResults: [{ pointId: scenario.coreGoal.id, status: 'not_observed', evidence: [] }] }, records, rubricScenario).evidenceResults?.[0]?.status).toBe('not_observed')
  })

  it('keeps legacy feedback readable while requiring grounded performance for new generation', async () => {
    const { parseConversationFeedbackResponse } = await import('../../worker/validation')
    const records = [turnRecord(1), turnRecord(2, { listeningScaffoldLevel: 1, ttsReplayCount: 1 })]
    const legacy = validFeedback(records)
    delete legacy.performance
    expect(parseConversationFeedbackResponse(legacy, records, scenario)).toEqual(legacy)
    expect(() => parseConversationFeedbackResponse(legacy, records, scenario, true)).toThrow()

    const grounded = validFeedback(records)
    expect(parseConversationFeedbackResponse(grounded, records, scenario, true)).toEqual(grounded)
    const forged = structuredClone(grounded)
    forged.performance!.dimensions.responseRelevance.evidence[0] = { turn: 1, role: 'assistant', quoteJa: '架空の相手发话' }
    expect(() => parseConversationFeedbackResponse(forged, records, scenario, true)).toThrow()
    const assistantOnly = structuredClone(grounded)
    assistantOnly.performance!.dimensions.expressionClarity.evidence = [{ turn: 1, role: 'assistant', quoteJa: records[0]!.partnerPromptJa }]
    expect(() => parseConversationFeedbackResponse(assistantOnly, records, scenario, true)).toThrow()
  })
})
