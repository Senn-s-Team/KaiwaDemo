/**
 * [INPUT]: 场景生成路由、模型输出与草拟契约
 * [OUTPUT]: 验证一次澄清与版本化场景生成
 * [POS]: tests/worker 的场景草拟契约测试
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../../worker/index'
import type { Env } from '../../worker/env'
import type { DynamicScenarioDefinition } from '../../worker/types'
import { verifyScenarioToken } from '../../worker/tokens'

const API_ORIGIN = 'https://kaiwa.example'
const env: Env = {
  OPENAI_API_KEY: 'test-openai-key',
  SCENARIO_SIGNING_SECRET: 'test-scenario-signing-secret',
}

const scenario: DynamicScenarioDefinition = {
  id: 'dynamic-cafe-order',
  version: 1,
  evaluationVersion: 1,
  evidencePoints: [{ id: "need", titleZh: "说明需求", descriptionZh: "清楚表达主要需求" }],
  titleZh: '咖啡店点单',
  summaryZh: '在咖啡店用日语完成一杯饮品点单。',
  aiRole: '咖啡店店员',
  userRole: '顾客',
  relationship: '初次见面的服务关系',
  tone: '礼貌自然的丁寧体',
  communicationFunction: '在咖啡店礼貌提出具体饮品需求并完成确认',
  firstLine: 'いらっしゃいませ。ご注文はお決まりですか？',
  partnerOpeningPlan: '以店员问候建立点单场景，并邀请顾客先说明饮品。',
  userGoal: '用日语完成一杯燕麦奶拿铁的点单。',
  coreGoal: { id: 'order', titleZh: '完成点单', descriptionZh: '明确说明饮品与燕麦奶选项。' },
  initialFacts: ['顾客正在咖啡店点单', '店内可以制作拿铁'],
  partnerPrivateFacts: ['燕麦奶可以替换普通牛奶'],
  keyIntents: ['用户：点一杯燕麦奶拿铁', 'AI：确认饮品与奶类要求'],
  keyInformation: ['饮品为拿铁', '奶类选择为燕麦奶'],
  completionRules: {
    completed: ['确认稿同时明确拿铁与燕麦奶要求'],
    partial: ['确认稿只明确饮品或奶类中的一项'],
    notCompleted: ['确认稿没有提供可用于点单的饮品信息'],
  },
  closingRules: ['第4轮只确认最后一项必要点单信息', '第5轮不提问并礼貌确认点单内容'],
  maxTurns: 5,
  worldAnchors: ['午间高峰', '可以选择燕麦奶'],
  followUpPrinciples: ['一次只确认一个必要细节', '第四轮开始收束'],
  hintStrategy: '先说明饮品，再补充燕麦奶要求。',
  feedbackFocus: ['请求表达', '支架使用事实'],
  safetyBoundary: '不涉及真实支付信息。',
}

const readyModelResponse = {
  output: [{
    type: 'message',
    content: [{ type: 'output_text', text: JSON.stringify({ status: 'ready', scenario }) }],
  }],
}

type WorkerFetch = (request: Request, workerEnv: Env) => Response | Promise<Response>
const fetchWorker = worker.fetch as unknown as WorkerFetch

function post(body: unknown): Request {
  return new Request(`${API_ORIGIN}/api/scenario/draft`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('POST /api/scenario/draft', () => {
  it('generates and signs a five-turn single-goal scenario', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(readyModelResponse))))
    const response = await fetchWorker(post({ inputZh: '我想练习在咖啡店点燕麦奶拿铁。', clarifications: [] }), env)
    const body: unknown = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ status: 'ready', scenario })
    if (!body || typeof body !== 'object' || !('scenarioToken' in body) || typeof body.scenarioToken !== 'string') {
      throw new Error('Ready scenario draft did not include a token.')
    }
    await expect(verifyScenarioToken(env, body.scenarioToken)).resolves.toMatchObject({ scenario })
  })

  it('normalizes scalar contract collections without dropping new fields', async () => {
    const modelScenario = {
      ...scenario,
      version: '1',
      coreGoal: '清楚完成点单',
      initialFacts: '顾客正在咖啡店点单',
      partnerPrivateFacts: '燕麦奶可以替换普通牛奶',
      keyIntents: '用户：点一杯燕麦奶拿铁',
      keyInformation: '饮品和奶类要求',
      completionRules: {
        completed: '确认稿同时明确拿铁与燕麦奶要求',
        partial: '确认稿只明确饮品或奶类中的一项',
        notCompleted: '确认稿没有提供饮品信息',
      },
      closingRules: '第5轮不提问并礼貌确认点单内容',
      maxTurns: '5',
      worldAnchors: '日本咖啡店的普通服务场景',
      followUpPrinciples: '围绕唯一目标一次追问一个细节',
      hintStrategy: ['先说明饮品', '再补充奶类要求'],
      feedbackFocus: '礼貌请求',
      safetyBoundary: ['不处理真实支付信息'],
    }
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ status: 'ready', scenario: modelScenario }) } }],
    }))))

    const response = await fetchWorker(post({ inputZh: '练习咖啡店点单。', clarifications: [] }), env)
    const body = (await response.json()) as { scenario: DynamicScenarioDefinition }

    expect(response.status).toBe(200)
    expect(body.scenario).toMatchObject({
      communicationFunction: scenario.communicationFunction,
      partnerOpeningPlan: scenario.partnerOpeningPlan,
      initialFacts: ['顾客正在咖啡店点单'],
      partnerPrivateFacts: ['燕麦奶可以替换普通牛奶'],
      keyIntents: ['用户：点一杯燕麦奶拿铁'],
      keyInformation: ['饮品和奶类要求'],
      completionRules: {
        completed: ['确认稿同时明确拿铁与燕麦奶要求'],
        partial: ['确认稿只明确饮品或奶类中的一项'],
        notCompleted: ['确认稿没有提供饮品信息'],
      },
      closingRules: ['第5轮不提问并礼貌确认点单内容'],
      maxTurns: 5,
    })
    expect(body.scenario.version).toBe(1)
    expect(body.scenario.coreGoal).toEqual({ id: 'core_1', titleZh: '清楚完成点单', descriptionZh: '清楚完成点单' })
    expect(body.scenario.hintStrategy).toBe('先说明饮品；再补充奶类要求')
  })

  it('allows at most one clarification, then marks the next model call mustGenerate', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      output_text: JSON.stringify({ status: 'needs_clarification', questionZh: '你希望扮演哪一方？', optionsZh: ['顾客', '店员'] }),
    }))))
    const clarification = await fetchWorker(post({ inputZh: '日语练习', clarifications: [] }), env)
    expect(clarification.status).toBe(200)
    await expect(clarification.json()).resolves.toMatchObject({ status: 'needs_clarification' })

    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(readyModelResponse)))
    vi.stubGlobal('fetch', fetchMock)
    const ready = await fetchWorker(post({
      inputZh: '日语练习',
      clarifications: [{ questionZh: '你希望扮演哪一方？', answerZh: '顾客' }],
    }), env)
    expect(ready.status).toBe(200)
    const options = fetchMock.mock.calls[0]?.[1]
    if (!options || typeof options !== 'object' || !('body' in options) || typeof options.body !== 'string') {
      throw new Error('Scenario request body was not sent.')
    }
    expect(options.body).toMatch(/\\"mustGenerate\\":true/)
  })

  it('turns a second clarification response into a complete ready fallback after one answered clarification', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      output_text: JSON.stringify({ status: 'needs_clarification', questionZh: '还要练什么？', optionsZh: ['点单', '结账'] }),
    }))))
    const response = await fetchWorker(post({
      inputZh: '日语练习',
      clarifications: [{ questionZh: '你希望扮演哪一方？', answerZh: '顾客' }],
    }), env)
    const body = (await response.json()) as { status: string; scenario?: DynamicScenarioDefinition }

    expect(response.status).toBe(200)
    expect(body.status).toBe('ready')
    expect(body.scenario).toMatchObject({
      communicationFunction: expect.any(String),
      initialFacts: expect.any(Array),
      partnerPrivateFacts: expect.any(Array),
      keyIntents: expect.any(Array),
      keyInformation: expect.any(Array),
      completionRules: {
        completed: expect.any(Array),
        partial: expect.any(Array),
        notCompleted: expect.any(Array),
      },
      closingRules: expect.any(Array),
      maxTurns: 5,
      partnerOpeningPlan: expect.any(String),
    })
  })
  it('rejects a request containing more than one clarification', async () => {
    const response = await fetchWorker(post({
      inputZh: '日语练习',
      clarifications: [
        { questionZh: '你扮演谁？', answerZh: '顾客' },
        { questionZh: '练习什么？', answerZh: '点单' },
      ],
    }), env)
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'invalid_scenario_draft_request' } })
  })
  it('forces ready output when forceGenerate is true', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      output_text: JSON.stringify({ status: 'needs_clarification', questionZh: '还要什么？', optionsZh: ['点单', '结账'] }),
    }))))
    const response = await fetchWorker(post({ inputZh: '旅行日语', clarifications: [], forceGenerate: true }), env)
    const body = (await response.json()) as { status: string; scenario?: DynamicScenarioDefinition }
    expect(response.status).toBe(200)
    expect(body.status).toBe('ready')
    expect(body.scenario?.coreGoal).toBeTruthy()
  })



  it('rejects a ready model scenario missing a required contract field', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      output_text: JSON.stringify({
        status: 'ready',
        scenario: { ...scenario, communicationFunction: undefined },
      }),
    }))))
    const response = await fetchWorker(post({ inputZh: '咖啡店点单', clarifications: [] }), env)
    expect(response.status).toBe(502)
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'scenario_draft_schema_invalid' } })
  })

  it('does not normalize away legacy nested fields before strict validation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      output_text: JSON.stringify({
        status: 'ready',
        scenario: { ...scenario, coreGoal: { ...scenario.coreGoal, optional: true } },
      }),
    }))))
    const response = await fetchWorker(post({ inputZh: '咖啡店点单', clarifications: [] }), env)
    expect(response.status).toBe(502)
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'scenario_draft_schema_invalid' } })
  })

  it('rejects legacy multi-goal and recommended-turn fields', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      output_text: JSON.stringify({
        status: 'ready',
        scenario: { ...scenario, coreGoals: [scenario.coreGoal], recommendedMinTurns: 6 },
      }),
    }))))
    const response = await fetchWorker(post({ inputZh: '咖啡店点单', clarifications: [] }), env)
    expect(response.status).toBe(502)
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'scenario_draft_schema_invalid' } })
  })
})
