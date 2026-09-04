import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildRescuePrompt } from '../../worker/scenarios'
import worker from '../../worker/index'
import type { Env } from '../../worker/env'
import { signSessionToken } from '../../worker/tokens'
import type {
  CatalogRescueRequest,
  DynamicRescueRequest,
  DynamicScenarioDefinition,
  RescueResponse,
} from '../../worker/types'

const API_ORIGIN = 'https://kaiwa.example'
const env: Env = {
  OPENAI_API_KEY: 'test-openai-key',
  SCENARIO_SIGNING_SECRET: 'test-scenario-signing-secret',
}

type WorkerFetch = (request: Request, workerEnv: Env) => Response | Promise<Response>
const fetchWorker = worker.fetch as unknown as WorkerFetch

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${API_ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

const dynamicScenario: DynamicScenarioDefinition = {
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
  coreGoals: [{ id: 'checkin', titleZh: '完成入住', descriptionZh: '告知预订姓名与天数。' }],
  optionalGoals: [],
  worldAnchors: ['チェックインは15時から', '朝食は2階で7時から9时半'],
  followUpPrinciples: ['丁寧に対応し、一つずつ確認する'],
  hintStrategy: 'まずは名前を伝え、その後に朝食について尋ねる。',
  feedbackFocus: ['丁寧語の使い分け', '質問の切り出し方'],
  safetyBoundary: '実在の個人情報やクレジットカード番号を求めない。',
  recommendedMinTurns: 6,
  recommendedMaxTurns: 8,
}

const validCatalogRequest: CatalogRescueRequest = {
  scenarioType: 'catalog',
  scenarioId: 'weekend-chat',
  variantId: 'casual-coworker',
  turn: 1,
  aiPrompt: '週末は何をして過ごしたんですか？',
  userFinal: '家で日本の映画を見ました。',
  history: [
    { role: 'assistant', text: '週末は何をして過ごしたんですか？' },
  ],
}

const validRescueModelResponse: RescueResponse = {
  interpretedIntentZh: '对方理解你周末待在家里观赏了日本电影并分享了该经历。',
  suggestedJa: '家でのんびり日本の映画を観て過ごしました。',
  suggestedJaRuby: '[家|いえ]でのんびり[日本|にほん]の[映画|えいが]を[観|み]て[過|す]ごしました。',
  politenessTipZh: '使用「〜てのんびり過ごしました」能更自然地传达周末放松的闲适氛围。',
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('POST /api/rescue', () => {
  describe('Input validation', () => {
    it('rejects GET requests', async () => {
      const response = await fetchWorker(
        new Request(`${API_ORIGIN}/api/rescue`, { method: 'GET' }),
        { ALLOW_MOCK: 'true' },
      )
      expect(response.status).toBe(405)
    })

    it('rejects cross-site requests', async () => {
      const response = await fetchWorker(
        post('/api/rescue', validCatalogRequest, { 'sec-fetch-site': 'cross-site' }),
        { ALLOW_MOCK: 'true' },
      )
      expect(response.status).toBe(403)
      const data = (await response.json()) as { error: { code: string } }
      expect(data.error.code).toBe('cross_site_request')
    })

    it('rejects empty body', async () => {
      const response = await fetchWorker(
        new Request(`${API_ORIGIN}/api/rescue`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '',
        }),
        { ALLOW_MOCK: 'true' },
      )
      expect(response.status).toBe(400)
    })

    it('rejects missing userFinal', async () => {
      const { userFinal: _, ...bad } = validCatalogRequest
      const response = await fetchWorker(post('/api/rescue', bad), { ALLOW_MOCK: 'true' })
      expect(response.status).toBe(400)
      const data = (await response.json()) as { error: { code: string } }
      expect(data.error.code).toBe('invalid_rescue_request')
    })

    it('rejects dynamic request without token or dynamicData', async () => {
      const badDynamic: DynamicRescueRequest = {
        scenarioType: 'dynamic',
        turn: 1,
        aiPrompt: 'いらっしゃいませ。',
        userFinal: 'チェックインをお願いします。',
        history: [{ role: 'assistant', text: 'いらっしゃいませ。' }],
      }
      const response = await fetchWorker(post('/api/rescue', badDynamic), { ALLOW_MOCK: 'true' })
      expect(response.status).toBe(400)
      const data = (await response.json()) as { error: { code: string } }
      expect(data.error.code).toBe('invalid_rescue_request')
    })
  })

  describe('Mock mode (ALLOW_MOCK=true)', () => {
    it('returns structured mock rescue response when OpenAI key is missing', async () => {
      const response = await fetchWorker(post('/api/rescue', validCatalogRequest), {
        ALLOW_MOCK: 'true',
      })

      expect(response.status).toBe(200)
      const data = (await response.json()) as RescueResponse
      expect(data.interpretedIntentZh).toBeTruthy()
      expect(data.suggestedJa).toBeTruthy()
      expect(data.politenessTipZh).toBeTruthy()
      expect(data.suggestedJa).toContain('家で日本の映画を見ました。')
    })

    it('returns mock response for dynamic request with dynamicData', async () => {
      const dynamicReq: DynamicRescueRequest = {
        scenarioType: 'dynamic',
        dynamicData: dynamicScenario,
        turn: 1,
        aiPrompt: dynamicScenario.firstLine,
        userFinal: '田中と申します。予約しています。',
        history: [{ role: 'assistant', text: dynamicScenario.firstLine }],
      }
      const response = await fetchWorker(post('/api/rescue', dynamicReq), {
        ALLOW_MOCK: 'true',
      })

      expect(response.status).toBe(200)
      const data = (await response.json()) as RescueResponse
      expect(data.interpretedIntentZh).toBeTruthy()
      expect(data.suggestedJa).toBeTruthy()
      expect(data.politenessTipZh).toBeTruthy()
    })
  })

  describe('Real mode with OpenAI mock', () => {
    it('calls OpenAI endpoint and returns parsed structured rescue analysis', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              output_text: JSON.stringify(validRescueModelResponse),
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        ),
      )

      const response = await fetchWorker(post('/api/rescue', validCatalogRequest), env)
      expect(response.status).toBe(200)
      const data = (await response.json()) as RescueResponse
      expect(data).toEqual(validRescueModelResponse)
    })

    it('supports dynamic scenario with sessionToken verification', async () => {
      const sessionToken = await signSessionToken(env, {
        scenario: dynamicScenario,
        cap: 10,
        startedAt: Date.now(),
        expiresAt: Date.now() + 3600_000,
      })

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              output_text: JSON.stringify(validRescueModelResponse),
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        ),
      )

      const dynamicReq: DynamicRescueRequest = {
        scenarioType: 'dynamic',
        sessionToken,
        turn: 1,
        aiPrompt: dynamicScenario.firstLine,
        userFinal: '予約の確認をお願いします。',
        history: [{ role: 'assistant', text: dynamicScenario.firstLine }],
      }

      const response = await fetchWorker(post('/api/rescue', dynamicReq), env)
      expect(response.status).toBe(200)
      const data = (await response.json()) as RescueResponse
      expect(data).toEqual(validRescueModelResponse)
    })

    it('returns 502 when OpenAI call fails', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response('Internal Server Error', { status: 500 }),
        ),
      )

      const response = await fetchWorker(post('/api/rescue', validCatalogRequest), env)
      expect(response.status).toBe(502)
      const data = (await response.json()) as { error: { code: string } }
      expect(data.error.code).toBe('rescue_request_failed')
    })

    it('returns 503 when OpenAI key is missing and ALLOW_MOCK is false', async () => {
      const response = await fetchWorker(post('/api/rescue', validCatalogRequest), {})
      expect(response.status).toBe(503)
      const data = (await response.json()) as { error: { code: string } }
      expect(data.error.code).toBe('openai_unconfigured')
    })
  })
  describe('buildRescuePrompt', () => {
    it('generates prompt with upgrade challenge instructions and native nuance expectations', () => {
      const prompt = buildRescuePrompt(
        {
          titleZh: '周末闲聊',
          aiRole: '同僚',
          userGoal: '分享周末',
        },
        1,
        '週末は何をして過ごしたんですか？',
        '家で映画を見ました。',
        [{ role: 'assistant', text: '週末は何をして過ごしたんですか？' }],
      )
      expect(prompt).toContain('地道アップグレード')
      expect(prompt).toContain('大人の自然な口語やクッション言葉')
      expect(prompt).toContain('洗練された表現にアップグレード')
      expect(prompt).toContain('suggestedJaRuby')
      expect(prompt).toContain('[漢字|かんじ]')
    })

    it('parses valid rescue response with or without optional suggestedJaRuby', async () => {
      const responseWithRuby = {
        interpretedIntentZh: '意图理解',
        suggestedJa: '映画を観ました',
        suggestedJaRuby: '[映画|えいが]を[観|み]ました',
        politenessTipZh: '更自然',
      }
      const responseWithoutRuby = {
        interpretedIntentZh: '意图理解',
        suggestedJa: '映画を観ました',
        politenessTipZh: '更自然',
      }

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              output_text: JSON.stringify(responseWithRuby),
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        ),
      )
      const res1 = await fetchWorker(post('/api/rescue', validCatalogRequest), env)
      expect(res1.status).toBe(200)
      const data1 = (await res1.json()) as RescueResponse
      expect(data1.suggestedJaRuby).toBe('[映画|えいが]を[観|み]ました')

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              output_text: JSON.stringify(responseWithoutRuby),
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        ),
      )
      const res2 = await fetchWorker(post('/api/rescue', validCatalogRequest), env)
      expect(res2.status).toBe(200)
      const data2 = (await res2.json()) as RescueResponse
      expect(data2.suggestedJaRuby).toBeUndefined()
      expect(data2.suggestedJa).toBe('映画を観ました')
    })
  })
})
