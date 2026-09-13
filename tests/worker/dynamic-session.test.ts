/**
 * [INPUT]: Worker 路由、签名凭据与场景定义
 * [OUTPUT]: 验证双开场固定五次用户确认会话和原场景复练的信任边界
 * [POS]: tests/worker 的动态会话集成测试
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { describe, expect, it } from 'vitest'
import worker from '../../worker/index'
import { buildDynamicDeveloperPrompt } from '../../worker/scenarios'
import { signPracticeToken, signScenarioToken, signSessionToken, verifyScenarioToken, verifySessionToken } from '../../worker/tokens'
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

function request(path: string, method: string, init: RequestInit = {}): Request {
  return new Request(`${API_ORIGIN}${path}`, { method, ...init })
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
  opening: { speaker: 'assistant', partnerLineJa: 'いらっしゃいませ。チェックインでございますか？', planZh: '以前台可观察的到店事实迎客并确认流程。' },
  userGoal: '用日语完成酒店入住。',
  coreGoal: { id: 'checkin', titleZh: '完成入住', descriptionZh: '告知预订姓名并明确提出入住请求。' },
  communicationFunction: '在酒店前台确认预订信息并提出入住请求。',
  initialFacts: ['用户正在酒店前台', '入住办理从15时开始'],
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
  worldAnchors: ['チェックインは15時から'],
  followUpPrinciples: ['一つずつ確認する', '第4ターンから収束する'],
  hintStrategy: '先说明姓名，再明确提出入住请求。',
  feedbackFocus: ['请求是否清楚', '支架使用事实'],
  safetyBoundary: '不索取真实证件号码或支付信息。',
}
const scenarioOpeningLine = scenario.opening.speaker === 'assistant'
  ? scenario.opening.partnerLineJa
  : (() => { throw new Error('Dynamic session fixture requires assistant opening.') })()

const practiceScenario: DynamicScenarioDefinition = {
  ...scenario,
  evaluationVersion: 1,
  evidencePoints: [
    { id: 'state_name', titleZh: '说明姓名', descriptionZh: '从确认稿判断是否说明预订姓名。' },
    { id: 'request_checkin', titleZh: '提出入住', descriptionZh: '从确认稿判断是否明确提出入住请求。' },
  ],
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
    const body = await response.json() as Record<string, unknown>
    expect(body).toMatchObject({
      scenarioType: 'dynamic',
      maxTurns: 5,
      scenario,
    })
    expect(body).not.toHaveProperty('firstLine')
  })

  it('renews an expired scenario through a signed practice token and starts an empty new session', async () => {
    const firstScenarioToken = await signScenarioToken(env, {
      scenario: practiceScenario,
      expiresAt: Date.now() + 3_600_000,
    })
    const firstResponse = await fetchWorker(post('/api/session/start', { type: 'dynamic', scenarioToken: firstScenarioToken }), env)
    const firstSession = await firstResponse.json() as { sessionId: string; sessionToken: string }
    const oldAnswer = '田中です。チェックインをお願いします。'
    const oldReply = await fetchWorker(post('/api/respond', {
      scenarioType: 'dynamic',
      sessionToken: firstSession.sessionToken,
      sessionId: firstSession.sessionId,
      turn: 1,
      history: [
        { role: 'assistant', text: scenarioOpeningLine },
        { role: 'user', text: oldAnswer },
      ],
    }), env)
    const expiredScenarioToken = await signScenarioToken(env, {
      scenario: practiceScenario,
      issuedAt: Date.now() - 60_000,
      expiresAt: Date.now() - 1,
    })
    const expiredResponse = await fetchWorker(post('/api/session/start', { type: 'dynamic', scenarioToken: expiredScenarioToken }), env)
    const practiceToken = await signPracticeToken(env, practiceScenario)

    expect(oldReply.status).toBe(200)
    expect(expiredResponse.status).toBe(401)
    await expect(expiredResponse.json()).resolves.toMatchObject({ error: { code: 'token_expired' } })

    const restartResponse = await fetchWorker(post('/api/practice/restart', { practiceToken }), env)
    const restart = await restartResponse.json() as {
      status: string
      scenario: DynamicScenarioDefinition
      scenarioToken: string
      practiceToken: string
    }
    const renewedScenario = await verifyScenarioToken(env, restart.scenarioToken)

    expect(restartResponse.status).toBe(200)
    expect(restart).toMatchObject({ status: 'ready', scenario: practiceScenario, practiceToken })
    expect(renewedScenario.scenario).toEqual(practiceScenario)

    const renewedResponse = await fetchWorker(post('/api/session/start', { type: 'dynamic', scenarioToken: restart.scenarioToken }), env)
    const renewedSession = await renewedResponse.json() as { sessionId: string; sessionToken: string; scenario: DynamicScenarioDefinition }
    const renewedClaims = await verifySessionToken(env, renewedSession.sessionToken)

    expect(renewedResponse.status).toBe(200)
    expect(renewedSession.sessionId).not.toBe(firstSession.sessionId)
    expect(renewedSession.sessionToken).not.toBe(firstSession.sessionToken)
    expect(renewedSession).not.toHaveProperty('history')
    expect(renewedSession).not.toHaveProperty('turnRecords')
    expect(JSON.stringify(renewedSession)).not.toContain(oldAnswer)
    expect(renewedClaims).toMatchObject({ scenario: practiceScenario })
    expect(renewedClaims).not.toHaveProperty('history')
  })

  it('rejects wrong-kind and forged practice tokens, disallowed methods, and cross-site restarts', async () => {
    const scenarioToken = await signScenarioToken(env, {
      scenario: practiceScenario,
      expiresAt: Date.now() + 3_600_000,
    })
    const practiceToken = await signPracticeToken(env, practiceScenario)
    // 署名段末尾の base64url 文字は下位 2 ビットが切り捨てられるため、末尾だけを変えても
    // デコード結果が同一のまま署名検証を通ってしまう。有意ビットを確実に変えるため中ほどを改竄する。
    const forgedToken = `${practiceToken.slice(0, 20)}${practiceToken[20] === 'a' ? 'b' : 'a'}${practiceToken.slice(21)}`

    const wrongKind = await fetchWorker(post('/api/practice/restart', { practiceToken: scenarioToken }), env)
    const forged = await fetchWorker(post('/api/practice/restart', { practiceToken: forgedToken }), env)
    const wrongMethod = await fetchWorker(request('/api/practice/restart', 'GET'), env)
    const crossSite = await fetchWorker(request('/api/practice/restart', 'POST', {
      headers: {
        'content-type': 'application/json',
        origin: 'https://attacker.example',
        'sec-fetch-site': 'cross-site',
      },
      body: JSON.stringify({ practiceToken }),
    }), env)

    expect(wrongKind.status).toBe(401)
    await expect(wrongKind.json()).resolves.toMatchObject({ error: { code: 'token_kind_mismatch' } })
    expect(forged.status).toBe(401)
    await expect(forged.json()).resolves.toMatchObject({ error: { code: 'token_invalid_signature' } })
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.get('allow')).toBe('POST')
    expect(crossSite.status).toBe(403)
    await expect(crossSite.json()).resolves.toMatchObject({ error: { code: 'cross_site_request' } })
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
      lastPartnerText: scenarioOpeningLine,
      history: [{ role: 'assistant', text: scenarioOpeningLine }],
    }), env)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      directionZh: expect.any(String),
      keyPhrasesJa: expect.any(Array),
      sentenceStarterJa: expect.any(String),
      fullExampleJa: expect.any(String),
    })
  })

  it('accepts a user-opening first confirmation without an assistant history item', async () => {
    const userOpeningScenario: DynamicScenarioDefinition = {
      ...scenario,
      id: 'dynamic-lost-item',
      titleZh: '车站报失',
      opening: { speaker: 'user', planZh: '用户先说明遗失事件并请求工作人员协助。' },
      userGoal: '询问遗失物是否被找到。',
      initialFacts: ['双方正在车站服务窗口交谈'],
      keyIntents: ['用户：报失并求助', 'AI：根据已确认信息协助查询'],
    }
    const token = await signSessionToken(env, {
      scenario: userOpeningScenario,
      startedAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
    })
    const response = await fetchWorker(post('/api/respond', {
      scenarioType: 'dynamic',
      sessionToken: token,
      sessionId: 'dynamic123456',
      turn: 1,
      history: [{ role: 'user', text: '傘をなくしたので、探していただけますか。' }],
    }), env)

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('"type":"done"')
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
        { role: 'assistant', text: scenarioOpeningLine },
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
