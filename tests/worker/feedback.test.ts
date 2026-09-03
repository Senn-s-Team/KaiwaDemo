import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../../worker/index'
import type { Env } from '../../worker/env'
import { signSessionToken } from '../../worker/tokens'
import type {
  ConversationFeedbackRequest,
  ConversationFeedbackResponse,
  DynamicScenarioDefinition,
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
  worldAnchors: ['チェックインは15時から', '朝食は2階で7時から9時半'],
  followUpPrinciples: ['丁寧に対応し、一つずつ確認する'],
  hintStrategy: 'まずは名前を伝え、その後に朝食について尋ねる。',
  feedbackFocus: ['丁寧語の使い分け', '質問の切り出し方'],
  safetyBoundary: '実在の個人情報やクレジットカード番号を求めない。',
  recommendedMinTurns: 6,
  recommendedMaxTurns: 8,
}

const validCatalogRequest: ConversationFeedbackRequest = {
  scenarioType: 'catalog',
  scenarioId: 'weekend-chat',
  variantId: 'casual-coworker',
  totalTurns: 2,
  history: [
    { role: 'assistant', text: '週末は何をして過ごしたんですか？' },
    { role: 'user', text: '家で日本の映画を見ました。' },
    { role: 'assistant', text: 'どんな映画でしたか？' },
    { role: 'user', text: 'アニメ映画で、とても面白かったです。' },
  ],
  transcriptRecords: [
    {
      turn: 1,
      aiPrompt: '週末は何をして過ごしたんですか？',
      userOriginal: 'いえで にほんの えいがを みました',
      userCleaned: '家で日本の映画を見ました。',
      userFinal: '家で日本の映画を見ました。',
    },
    {
      turn: 2,
      aiPrompt: 'どんな映画でしたか？',
      userOriginal: 'あにめえいがで おもしろかったです',
      userCleaned: 'アニメ映画で、とても面白かったです。',
      userFinal: 'アニメ映画で、とても面白かったです。',
    },
  ],
}

const validFeedbackModelResponse: ConversationFeedbackResponse = {
  isGoalCompleted: true,
  goalSummaryZh: '成功分享了周末观影经历，交流顺畅且准确传达了感想。',
  strengths: [
    {
      quoteJa: '家で日本の映画を見ました。',
      praiseZh: '准确使用了场所助词「で」和宾格助词「を」，叙述清晰。',
    },
    {
      quoteJa: 'アニメ映画で、とても面白かったです。',
      praiseZh: '使用「で」连接名词句和形容词句，表达连贯。',
    },
  ],
  improvements: [
    {
      turn: 2,
      type: 'naturalness_upgrade',
      originalQuoteJa: 'アニメ映画で、とても面白かったです。',
      suggestedJa: 'アニメの映画を見たんですが、すごく面白かったです。',
      reasonZh: '口语中使用「〜んですが」前置铺垫可以让语感更加地道自然。',
    },
  ],
  reusableExpressions: [
    {
      patternJa: '〜で、〜かったです',
      meaningZh: '用于罗列原因、背景并陈述过去体验的感受。',
      usageExampleJa: '友達と一緒で、とても楽しかったです。',
    },
    {
      patternJa: '〜を見たんですが',
      meaningZh: '在口语中提及某物作为话题引子。',
      usageExampleJa: '昨日新しい映画を見たんですが、良かったです。',
    },
  ],
  masterUpgrade: {
    turn: 1,
    originalJa: '家で日本の映画を見ました。',
    upgradedJa: '特にどこも出かけず、家でのんびり日本の映画を観て過ごしました。',
    explanationZh: '加入「のんびり〜して過ごす」让周末休闲的氛围感更生动丰富。',
  },
  retryTask: {
    turn: 2,
    targetAiPromptJa: 'どんな映画でしたか？',
    userOriginalJa: 'アニメ映画で、とても面白かったです。',
    recommendedReferenceJa: 'アニメ映画を観たんですが、ストーリーがすごく面白かったです。',
    hintZh: '尝试补充具体哪个方面有趣（如剧情、画面），丰富表达内容。',
  },
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('POST /api/conversation/feedback', () => {
  describe('Mock mode', () => {
    it('returns complete valid structured feedback for catalog scenario', async () => {
      const response = await fetchWorker(
        post('/api/conversation/feedback', validCatalogRequest),
        { ALLOW_MOCK: 'true' },
      )

      expect(response.status).toBe(200)
      const data = (await response.json()) as ConversationFeedbackResponse
      expect(data.isGoalCompleted).toBe(true)
      expect(data.goalSummaryZh).toBeTruthy()
      expect(data.strengths).toHaveLength(2)
      expect(data.improvements.length).toBeGreaterThanOrEqual(1)
      expect(data.improvements.length).toBeLessThanOrEqual(3)
      expect(data.reusableExpressions).toHaveLength(2)
      expect(data.masterUpgrade).toHaveProperty('upgradedJa')
      expect(data.retryTask).toHaveProperty('recommendedReferenceJa')

      // Quotes in improvements must exist in userFinal
      const userFinals = validCatalogRequest.transcriptRecords.map((r) => r.userFinal)
      for (const imp of data.improvements) {
        expect(userFinals.some((text) => text.includes(imp.originalQuoteJa))).toBe(true)
      }
    })

    it('returns complete valid structured feedback for dynamic scenario', async () => {
      const sessionToken = await signSessionToken(env, {
        scenario: dynamicScenario,
        cap: 10,
        startedAt: Date.now(),
        expiresAt: Date.now() + 3600_000,
      })

      const dynamicFeedbackRequest: ConversationFeedbackRequest = {
        scenarioType: 'dynamic',
        sessionToken,
        totalTurns: 1,
        history: [
          { role: 'assistant', text: dynamicScenario.firstLine },
          { role: 'user', text: 'はい、予約した田中です。チェックインをお願いします。' },
        ],
        transcriptRecords: [
          {
            turn: 1,
            aiPrompt: dynamicScenario.firstLine,
            userOriginal: 'はい よやくした たなかです',
            userCleaned: 'はい、予約した田中です。',
            userFinal: 'はい、予約した田中です。チェックインをお願いします。',
          },
        ],
      }

      const response = await fetchWorker(
        post('/api/conversation/feedback', dynamicFeedbackRequest),
        { ALLOW_MOCK: 'true', SCENARIO_SIGNING_SECRET: env.SCENARIO_SIGNING_SECRET },
      )

      expect(response.status).toBe(200)
      const data = (await response.json()) as ConversationFeedbackResponse
      expect(data.isGoalCompleted).toBe(true)
      expect(data.strengths).toHaveLength(2)
      expect(data.improvements).toHaveLength(1)
      expect(data.reusableExpressions).toHaveLength(2)
    })

    it('returns 503 when OpenAI is not configured and mock mode is disabled', async () => {
      const response = await fetchWorker(
        post('/api/conversation/feedback', validCatalogRequest),
        {},
      )

      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({
        error: {
          code: 'openai_unconfigured',
          message: 'OpenAI is not configured for this deployment.',
        },
      })
    })
  })

  describe('Input validation', () => {
    it('rejects cross-site requests', async () => {
      const response = await fetchWorker(
        post('/api/conversation/feedback', validCatalogRequest, { 'sec-fetch-site': 'cross-site' }),
        { ALLOW_MOCK: 'true' },
      )
      expect(response.status).toBe(403)
    })

    it('rejects non-POST methods', async () => {
      const req = new Request(`${API_ORIGIN}/api/conversation/feedback`, { method: 'GET' })
      const response = await fetchWorker(req, { ALLOW_MOCK: 'true' })
      expect(response.status).toBe(405)
    })

    it('rejects catalog request with unknown scenario', async () => {
      const response = await fetchWorker(
        post('/api/conversation/feedback', { ...validCatalogRequest, scenarioId: 'unknown-scenario' }),
        { ALLOW_MOCK: 'true' },
      )
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: { code: 'unknown_scenario' } })
    })

    it('rejects catalog request with variant mismatch', async () => {
      const response = await fetchWorker(
        post('/api/conversation/feedback', { ...validCatalogRequest, variantId: 'invalid-variant' }),
        { ALLOW_MOCK: 'true' },
      )
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: { code: 'scenario_variant_mismatch' } })
    })

    it('rejects history not starting with scenario firstLine', async () => {
      const response = await fetchWorker(
        post('/api/conversation/feedback', {
          ...validCatalogRequest,
          history: [
            { role: 'assistant', text: '間違った最初の発話' },
            { role: 'user', text: '映画を見ました。' },
          ],
          totalTurns: 1,
          transcriptRecords: [validCatalogRequest.transcriptRecords[0]],
        }),
        { ALLOW_MOCK: 'true' },
      )
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: { code: 'scenario_context_mismatch' } })
    })

    it('rejects non-alternating history roles', async () => {
      const response = await fetchWorker(
        post('/api/conversation/feedback', {
          ...validCatalogRequest,
          history: [
            { role: 'assistant', text: '週末は何をして過ごしたんですか？' },
            { role: 'assistant', text: '映画を見ました。' },
          ],
        }),
        { ALLOW_MOCK: 'true' },
      )
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: { code: 'invalid_feedback_request' } })
    })

    it('rejects mismatch between totalTurns and user history turns', async () => {
      const response = await fetchWorker(
        post('/api/conversation/feedback', {
          ...validCatalogRequest,
          totalTurns: 3, // History only has 2 user turns
        }),
        { ALLOW_MOCK: 'true' },
      )
      expect(response.status).toBe(400)
    })

    it('rejects mismatch between totalTurns and transcriptRecords length', async () => {
      const response = await fetchWorker(
        post('/api/conversation/feedback', {
          ...validCatalogRequest,
          totalTurns: 2,
          transcriptRecords: [validCatalogRequest.transcriptRecords[0]], // Only 1 record
        }),
        { ALLOW_MOCK: 'true' },
      )
      expect(response.status).toBe(400)
    })

    it('rejects non-sequential turns in transcriptRecords', async () => {
      const response = await fetchWorker(
        post('/api/conversation/feedback', {
          ...validCatalogRequest,
          transcriptRecords: [
            { ...validCatalogRequest.transcriptRecords[0], turn: 1 },
            { ...validCatalogRequest.transcriptRecords[1], turn: 3 }, // Skipped turn 2
          ],
        }),
        { ALLOW_MOCK: 'true' },
      )
      expect(response.status).toBe(400)
    })

    it('rejects dynamic request with invalid session token', async () => {
      const response = await fetchWorker(
        post('/api/conversation/feedback', {
          scenarioType: 'dynamic',
          sessionToken: 'invalid.jwt.token',
          totalTurns: 1,
          history: [
            { role: 'assistant', text: dynamicScenario.firstLine },
            { role: 'user', text: 'こんにちは' },
          ],
          transcriptRecords: [
            {
              turn: 1,
              aiPrompt: dynamicScenario.firstLine,
              userOriginal: 'こんにちは',
              userCleaned: 'こんにちは',
              userFinal: 'こんにちは',
            },
          ],
        }),
        { ALLOW_MOCK: 'true', SCENARIO_SIGNING_SECRET: env.SCENARIO_SIGNING_SECRET },
      )
      expect(response.status).toBe(400)
    })
  })

  describe('OpenAI integration and Safety Red Lines', () => {
    it('calls OpenAI, passes structured developer prompt, and returns parsed feedback', async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            output: [
              {
                type: 'message',
                content: [
                  {
                    type: 'output_text',
                    text: JSON.stringify(validFeedbackModelResponse),
                  },
                ],
              },
            ],
          }),
        ),
      )
      vi.stubGlobal('fetch', fetchMock)

      const response = await fetchWorker(
        post('/api/conversation/feedback', validCatalogRequest),
        env,
      )

      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data).toEqual(validFeedbackModelResponse)

      // Verify request payload sent to OpenAI
      expect(fetchMock).toHaveBeenCalledOnce()
      const requestOptions = fetchMock.mock.calls[0]?.[1]
      if (!requestOptions || typeof requestOptions !== 'object' || !('body' in requestOptions)
        || typeof requestOptions.body !== 'string') {
        throw new Error('Feedback request did not include a JSON body.')
      }
      const parsedBody = JSON.parse(requestOptions.body) as { input?: Array<{ content?: string }> }
      const promptContent = parsedBody.input?.[0]?.content || ''
      expect(promptContent).toContain('発音、声調、イントネーション、アクセント、感情・表情に関する言及・評価は一切禁止')
      expect(promptContent).toContain('数値スコアや虚偽の数字評価は一切禁止')
      expect(promptContent).toContain('improvements（改善点）の originalQuoteJa は、ユーザーの userFinal（確定発話）の中に実際に存在する部分文字列')
    })

    it('rejects feedback when improvement quotes non-existent user text', async () => {
      const fakeQuoteResponse = {
        ...validFeedbackModelResponse,
        improvements: [
          {
            turn: 1,
            type: 'grammar_fix',
            originalQuoteJa: 'まったく言っていない架空のフレーズ',
            suggestedJa: '正しい表現',
            reasonZh: '语法修改说明。',
          },
        ],
      }

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              output_text: JSON.stringify(fakeQuoteResponse),
            }),
          ),
        ),
      )

      const response = await fetchWorker(
        post('/api/conversation/feedback', validCatalogRequest),
        env,
      )

      expect(response.status).toBe(502)
      const data = (await response.json()) as { error: { code: string; message: string } }
      expect(data.error.code).toBe('feedback_model_invalid')
      expect(data.error.message).toContain('not found in user utterances')
    })

    it('rejects feedback when model mentions forbidden evaluation dimensions like pronunciation or score', async () => {
      const forbiddenResponse = {
        ...validFeedbackModelResponse,
        strengths: [
          {
            quoteJa: '家で日本の映画を見ました。',
            praiseZh: '发音非常标准清晰，语调自然。', // Contains forbidden word "发音"
          },
          validFeedbackModelResponse.strengths[1],
        ],
      }

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              output_text: JSON.stringify(forbiddenResponse),
            }),
          ),
        ),
      )

      const response = await fetchWorker(
        post('/api/conversation/feedback', validCatalogRequest),
        env,
      )

      expect(response.status).toBe(502)
      const data = (await response.json()) as { error: { code: string; message: string } }
      expect(data.error.code).toBe('feedback_model_invalid')
    })

    it('rejects feedback when model gives numerical scores', async () => {
      const scoreResponse = {
        ...validFeedbackModelResponse,
        goalSummaryZh: '本次对话综合得分为90分，表现良好。', // Contains forbidden word "90分"
      }

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              output_text: JSON.stringify(scoreResponse),
            }),
          ),
        ),
      )

      const response = await fetchWorker(
        post('/api/conversation/feedback', validCatalogRequest),
        env,
      )

      expect(response.status).toBe(502)
      const data = (await response.json()) as { error: { code: string; message: string } }
      expect(data.error.code).toBe('feedback_model_invalid')
    })

    it('handles upstream OpenAI network errors gracefully', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Upstream error', { status: 500 })))

      const response = await fetchWorker(
        post('/api/conversation/feedback', validCatalogRequest),
        env,
      )

      expect(response.status).toBe(502)
      expect(await response.json()).toEqual({
        error: {
          code: 'feedback_request_failed',
          message: 'OpenAI conversation feedback generation failed.',
        },
      })
    })

    it('handles invalid JSON from OpenAI gracefully', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not a json')))

      const response = await fetchWorker(
        post('/api/conversation/feedback', validCatalogRequest),
        env,
      )

      expect(response.status).toBe(502)
      expect(await response.json()).toEqual({
        error: {
          code: 'feedback_model_invalid',
          message: 'Feedback model output is invalid. Retry this request.',
        },
      })
    })
  })
})
