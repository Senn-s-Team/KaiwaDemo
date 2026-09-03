import { describe, expect, it } from 'vitest'
import worker from '../../worker/index'
import { signScenarioToken, signSessionToken } from '../../worker/tokens'
import type { DynamicScenarioDefinition } from '../../worker/types'

const API_ORIGIN = 'https://kaiwa.example'
const env = {
  SCENARIO_SIGNING_SECRET: 'test-only-signing-secret',
  ALLOW_MOCK: 'true',
}

type WorkerFetch = (request: Request, env: unknown) => Response | Promise<Response>
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
  summaryZh: '向酒店前台出示预订并询问早餐时间。',
  aiRole: 'ホテルフロント係',
  userRole: '宿泊客',
  relationship: '初対面の接客',
  tone: '丁寧',
  firstLine: 'いらっしゃいませ。チェックインでございますか？',
  userGoal: 'チェックイン手続きを行い、朝食の時間を確認する。',
  coreGoals: [
    { id: 'checkin', titleZh: '办理入住', descriptionZh: '告知预订姓名并出示确认。' },
    { id: 'breakfast', titleZh: '询问早餐', descriptionZh: '确认早餐的时间和地点。' },
  ],
  optionalGoals: [],
  worldAnchors: ['チェックインは15時から', '朝食会場は2階で7時から9時半'],
  followUpPrinciples: ['丁寧に対応し、一つずつ確認する'],
  hintStrategy: 'まずは名前を伝え、その後に朝食について尋ねる。',
  feedbackFocus: ['丁寧語の使い分け', '質問の切り出し方'],
  safetyBoundary: '実在の個人情報やクレジットカード番号を求めない。',
  recommendedMinTurns: 6,
  recommendedMaxTurns: 8,
}

describe('Dynamic Session Start & Progression', () => {
  it('starts a dynamic session and returns session token and initial cap', async () => {
    const scenarioToken = await signScenarioToken(env, {
      scenario,
      expiresAt: Date.now() + 3600_000,
    })

    const response = await fetchWorker(post('/api/session/start', {
      type: 'dynamic',
      scenarioToken,
    }), env)

    expect(response.status).toBe(200)
    const body = (await response.json()) as { sessionToken?: string; sessionId?: string; scenarioType?: string; maxTurns?: number }
    expect(body).toMatchObject({
      scenarioType: 'dynamic',
      maxTurns: 10,
      firstLine: scenario.firstLine,
      scenario,
    })
    expect(body.sessionToken).toBeTruthy()
    expect(body.sessionId).toMatch(/^dyn_ses_/)
  })

  it('rejects dynamic start with invalid or expired scenario token', async () => {
    const response = await fetchWorker(post('/api/session/start', {
      type: 'dynamic',
      scenarioToken: 'invalid.token.payload',
    }), env)

    expect(response.status).toBe(400)
  })

  it('provides on-demand 4-tier hint', async () => {
    const sessionToken = await signSessionToken(env, {
      scenario,
      cap: 10,
      startedAt: Date.now(),
      expiresAt: Date.now() + 3600_000,
    })

    const response = await fetchWorker(post('/api/hint', {
      scenarioType: 'dynamic',
      sessionToken,
      lastAssistantText: scenario.firstLine,
      history: [{ role: 'assistant', text: scenario.firstLine }],
    }), env)

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toHaveProperty('directionZh')
    expect(body).toHaveProperty('keyPhrasesJa')
    expect(body).toHaveProperty('sentenceStarterJa')
    expect(body).toHaveProperty('fullExampleJa')
  })

  it('evaluates checkpoint and extends cap when goals are incomplete', async () => {
    const sessionToken = await signSessionToken(env, {
      scenario,
      cap: 10,
      startedAt: Date.now(),
      expiresAt: Date.now() + 3600_000,
    })

    const response = await fetchWorker(post('/api/session/checkpoint', {
      sessionToken,
      turn: 10,
      history: [
        { role: 'assistant', text: scenario.firstLine },
        { role: 'user', text: 'はい、予約した田中です。' },
      ],
    }), env)

    expect(response.status).toBe(200)
    const body = (await response.json()) as { isGoalCompleted: boolean; canExtend: boolean; nextCap?: number; newSessionToken?: string }
    expect(body).toHaveProperty('isGoalCompleted')
    expect(body).toHaveProperty('canExtend')
    if (body.canExtend) {
      expect(body.nextCap).toBe(14)
      expect(body.newSessionToken).toBeTruthy()
    }
  })
})
