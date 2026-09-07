import { describe, expect, it } from 'vitest'
import worker from '../../worker/index'
import { buildDynamicDeveloperPrompt } from '../../worker/scenarios'
import { signScenarioToken, signSessionToken } from '../../worker/tokens'
import type { DynamicScenarioDefinition } from '../../worker/types'

const API_ORIGIN = 'https://kaiwa.example'
const env = {
  SCENARIO_SIGNING_SECRET: 'test-only-signing-secret',
  ALLOW_MOCK: 'true',
}

type WorkerFetch = (request: Request, workerEnv: typeof env) => Response | Promise<Response>
const fetchWorker = worker.fetch as unknown as WorkerFetch

function post(path: string, body: unknown): Request {
  return new Request(`${API_ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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
  hintStrategy: '先说明姓名，再明确提出入住请求。',
  feedbackFocus: ['请求是否清楚', '支架使用事实'],
  safetyBoundary: '不索取真实证件号码或支付信息。',
}

async function sessionToken(): Promise<string> {
  return signSessionToken(env, {
    scenario,
    startedAt: Date.now(),
    expiresAt: Date.now() + 3_600_000,
  })
}

describe('dynamic five-turn session', () => {
  it('omits the removed scenario catalog from config', async () => {
    const response = await fetchWorker(new Request(`${API_ORIGIN}/api/config`), env)
    const body = (await response.json()) as Record<string, unknown>
    expect(response.status).toBe(200)
    expect(body).not.toHaveProperty('scenarioCatalog')
    expect(body).toMatchObject({ limits: { maxTurns: 5 } })
  })

  it('starts only from a signed ready scenario and fixes maxTurns to five', async () => {
    const scenarioToken = await signScenarioToken(env, {
      scenario,
      expiresAt: Date.now() + 3_600_000,
    })
    const response = await fetchWorker(post('/api/session/start', { type: 'dynamic', scenarioToken }), env)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      scenarioType: 'dynamic',
      maxTurns: 5,
      firstLine: scenario.firstLine,
      scenario,
    })
  })

  it('rejects catalog starts and turns beyond five', async () => {
    const catalogStart = await fetchWorker(post('/api/session/start', { scenarioId: 'weekend-chat' }), env)
    expect(catalogStart.status).toBe(400)

    const token = await sessionToken()
    const history = Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 === 0 ? 'assistant' : 'user',
      text: index % 2 === 0 ? '短い質問ですか？' : '短い回答です。',
    }))
    const response = await fetchWorker(post('/api/respond', {
      scenarioType: 'dynamic',
      sessionToken: token,
      sessionId: 'dynamic123456',
      turn: 6,
      history,
    }), env)
    expect(response.status).toBe(400)
  })

  it('keeps all four expression scaffold fields', async () => {
    const token = await sessionToken()
    const response = await fetchWorker(post('/api/hint', {
      scenarioType: 'dynamic',
      sessionToken: token,
      lastAssistantText: scenario.firstLine,
      history: [{ role: 'assistant', text: scenario.firstLine }],
    }), env)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      directionZh: expect.any(String),
      keyPhrasesJa: expect.any(Array),
      sentenceStarterJa: expect.any(String),
      fullExampleJa: expect.any(String),
    })
  })

  it('instructs turn four to converge and turn five to close without questions or new tasks', () => {
    const fourth = buildDynamicDeveloperPrompt(scenario, 4)
    const fifth = buildDynamicDeveloperPrompt(scenario, 5)

    expect(fourth).toContain('次がユーザーの最後の回答')
    expect(fourth).toContain('最後の確認を一つだけ')
    expect(fifth).toContain('新しい課題・条件・障害・話題を一切追加せず')
    expect(fifth).toContain('質問もせず')
  })

  it('returns no question in the mock fifth reply', async () => {
    const token = await sessionToken()
    const response = await fetchWorker(post('/api/respond', {
      scenarioType: 'dynamic',
      sessionToken: token,
      sessionId: 'dynamic123456',
      turn: 5,
      history: [
        { role: 'assistant', text: scenario.firstLine },
        { role: 'user', text: '田中です。チェックインをお願いします。' },
        { role: 'assistant', text: 'ご予約を確認しました。' },
        { role: 'user', text: 'ありがとうございます。' },
        { role: 'assistant', text: '一泊でよろしいですか？' },
        { role: 'user', text: 'はい、一泊です。' },
        { role: 'assistant', text: 'お名前と宿泊日数は以上で相違ありませんか？' },
        { role: 'user', text: 'はい、相違ありません。' },
        { role: 'assistant', text: '最後に内容をご確認ください。' },
        { role: 'user', text: '確認しました。' },
      ],
    }), env)
    const body = await response.text()

    expect(response.status).toBe(200)
    expect(body).not.toContain('？')
    expect(body).not.toContain('?')
  })

  it('removes rescue and checkpoint routes instead of keeping compatibility handlers', async () => {
    const rescue = await fetchWorker(post('/api/rescue', {}), env)
    const checkpoint = await fetchWorker(post('/api/session/checkpoint', {}), env)
    expect(rescue.status).toBe(404)
    expect(checkpoint.status).toBe(404)
  })
})
