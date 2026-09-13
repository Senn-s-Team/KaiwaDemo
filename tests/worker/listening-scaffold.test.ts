import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ListeningScaffoldRequest,
  ListeningScaffoldResponse,
} from '../../shared/listening-scaffold'
import type { Env } from '../../worker/env'
import worker from '../../worker/index'
import { createMockListeningScaffold } from '../../worker/mock'
import { buildListeningScaffoldPrompt } from '../../worker/scenarios'
import { signSessionToken } from '../../worker/tokens'
import type { DynamicScenarioDefinition } from '../../worker/types'

const API_ORIGIN = 'https://kaiwa.example'
const env: Env = {
  OPENAI_API_KEY: 'test-openai-key',
  SCENARIO_SIGNING_SECRET: 'test-listening-scaffold-signing-secret',
}

const scenario: DynamicScenarioDefinition = {
  id: 'dynamic-listening-test',
  version: 1,
  titleZh: '酒店入住',
  summaryZh: '在前台确认预约并办理入住。',
  aiRole: 'ホテルフロント係',
  userRole: '宿泊客',
  relationship: '初対面の接客',
  tone: '丁寧体',
  opening: { speaker: 'assistant', partnerLineJa: 'いらっしゃいませ。ご予約のお名前を伺ってもよろしいでしょうか？', planZh: '根据用户到达前台这一可观察事实迎客并询问预约姓名。' },
  userGoal: '告知预约姓名并办理入住。',
  coreGoal: {
    id: 'check-in',
    titleZh: '办理入住',
    descriptionZh: '向前台说明预约姓名。',
  },
  communicationFunction: '予約者の名前を丁寧に確認する',
  initialFacts: ['SECRET_INITIAL_FACT_9f3a'],
  partnerPrivateFacts: ['SECRET_PRIVATE_FACT_7c2b'],
  keyIntents: ['予約名を確認する'],
  keyInformation: ['SECRET_KEY_INFORMATION_4e1d'],
  completionRules: {
    completed: ['SECRET_COMPLETED_RULE_aa11'],
    partial: ['SECRET_PARTIAL_RULE_bb22'],
    notCompleted: ['SECRET_NOT_COMPLETED_RULE_cc33'],
  },
  closingRules: ['確認後に会話を収束する'],
  maxTurns: 5,
  worldAnchors: ['ホテルのフロントで対応中'],
  followUpPrinciples: ['一度に一つだけ確認する'],
  hintStrategy: '固有名詞を答えとして与えない',
  feedbackFocus: ['依頼の明確さ'],
  safetyBoundary: '実在の個人情報を要求しない',
}
const scenarioOpeningLine = scenario.opening.speaker === 'assistant'
  ? scenario.opening.partnerLineJa
  : (() => { throw new Error('Listening scaffold fixture requires assistant opening.') })()

type WorkerFetch = (request: Request, workerEnv: Env) => Response | Promise<Response>
const fetchWorker = worker.fetch as unknown as WorkerFetch

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${API_ORIGIN}/api/listening-scaffold`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

async function listeningRequest(overrides: Partial<ListeningScaffoldRequest> = {}): Promise<ListeningScaffoldRequest> {
  const sessionToken = await signSessionToken(env, {
    scenario,
    startedAt: Date.now(),
    expiresAt: Date.now() + 3_600_000,
  })
  return {
    scenarioType: 'dynamic',
    sessionToken,
    turn: 1,
    partnerPromptJa: scenarioOpeningLine,
    ...overrides,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('POST /api/listening-scaffold', () => {
  it('returns a deterministic, current-utterance-only contract response in mock mode', async () => {
    const request = await listeningRequest({
      turn: 3,
      partnerPromptJa: '朝食は七時から十時まで一階のレストランでご用意しております。',
    })
    const workerEnv: Env = {
      ALLOW_MOCK: 'true',
      SCENARIO_SIGNING_SECRET: env.SCENARIO_SIGNING_SECRET,
    }

    const first = await fetchWorker(post(request), workerEnv)
    const second = await fetchWorker(post(request), workerEnv)
    const firstBody = (await first.json()) as ListeningScaffoldResponse
    const secondBody = (await second.json()) as ListeningScaffoldResponse

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(firstBody).toEqual(secondBody)
    expect(Object.keys(firstBody).sort()).toEqual([
      'intentSummaryZh',
      'keyInformationHintZh',
      'keyPhrasesJa',
    ])
    expect(firstBody.keyPhrasesJa).toHaveLength(1)
    expect(request.partnerPromptJa).toContain(firstBody.keyPhrasesJa[0])
    expect(JSON.stringify(firstBody)).not.toContain('SECRET_')
    expect(createMockListeningScaffold(request)).toEqual(firstBody)
  })

  it('uses only the allowed current-turn context in the real model prompt', async () => {
    const request = await listeningRequest()
    const modelResponse: ListeningScaffoldResponse = {
      keyInformationHintZh: '请留意对方在询问哪一项预约信息。',
      keyPhrasesJa: ['ご予約のお名前', '伺ってもよろしいでしょうか'],
      intentSummaryZh: '对方正在礼貌询问预约人的姓名。',
    }
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      output_text: JSON.stringify(modelResponse),
    })))
    vi.stubGlobal('fetch', fetchMock)

    const response = await fetchWorker(post(request), env)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(modelResponse)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const options = fetchMock.mock.calls[0]?.[1]
    if (!options || typeof options !== 'object' || !('body' in options) || typeof options.body !== 'string') {
      throw new Error('Listening scaffold request body was not sent upstream.')
    }
    expect(options.body).toContain(request.partnerPromptJa)
    for (const allowedValue of [
      scenario.aiRole,
      scenario.userRole,
      scenario.relationship,
      scenario.tone,
      scenario.communicationFunction,
    ]) {
      expect(options.body).toContain(allowedValue)
    }
    for (const forbiddenValue of [
      ...scenario.initialFacts,
      ...scenario.partnerPrivateFacts,
      ...scenario.keyInformation,
      ...scenario.completionRules.completed,
      ...scenario.completionRules.partial,
      ...scenario.completionRules.notCompleted,
    ]) {
      expect(options.body).not.toContain(forbiddenValue)
    }
    for (const forbiddenField of [
      '"history"',
      '"initialFacts"',
      '"partnerPrivateFacts"',
      '"keyInformation"',
      '"completionRules"',
    ]) {
      expect(options.body).not.toContain(forbiddenField)
    }
  })

  it('makes verbatim phrases supplement L2, excludes the client-local L3 transcript, and keeps L4 advice-free', () => {
    const request: ListeningScaffoldRequest = {
      scenarioType: 'dynamic',
      sessionToken: 'opaque-token',
      turn: 2,
      partnerPromptJa: 'お荷物はこちらでお預かりしましょうか？',
    }
    const prompt = buildListeningScaffoldPrompt(scenario, request)

    expect(prompt).toContain('L2')
    expect(prompt).toContain('答え')
    expect(prompt).toContain('L2の手掛かりを補助')
    expect(prompt).toContain('一字一句そのまま連続して含まれる')
    expect(prompt).toContain('L3で表示する日本語の全文はクライアント')
    expect(prompt).toContain('モデルは生成せず、この出力にも含めてはいけません')
    expect(prompt).toContain('L4')
    expect(prompt).toContain('返答例、返答方針、行動提案')
    expect(prompt).not.toContain(request.sessionToken)
  })

  it('returns a 502 model error when a key phrase is not an exact prompt substring or output is not strict', async () => {
    const request = await listeningRequest()
    for (const invalidResponse of [
      {
        keyInformationHintZh: '请留意对方询问的预约信息。',
        keyPhrasesJa: ['予約番号を教えてください'],
        intentSummaryZh: '对方正在确认预约信息。',
      },
      {
        keyInformationHintZh: '请留意对方询问的预约信息。',
        keyPhrasesJa: ['ご予約のお名前'],
        intentSummaryZh: '对方正在确认预约信息。',
        extra: 'not allowed',
      },
    ]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
        output_text: JSON.stringify(invalidResponse),
      }))))

      const response = await fetchWorker(post(request), env)

      expect(response.status).toBe(502)
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'listening_scaffold_model_invalid' },
      })
    }
  })

  it('requires a valid session token and preserves JSON, method, and same-origin boundaries', async () => {
    const invalidTokenResponse = await fetchWorker(post({
      scenarioType: 'dynamic',
      sessionToken: 'not-a-signed-session-token',
      turn: 1,
      partnerPromptJa: scenarioOpeningLine,
    }), {
      ALLOW_MOCK: 'true',
      SCENARIO_SIGNING_SECRET: env.SCENARIO_SIGNING_SECRET,
    })
    expect(invalidTokenResponse.status).toBe(400)

    const request = await listeningRequest()
    const extraFieldResponse = await fetchWorker(post({ ...request, history: [] }), {
      ALLOW_MOCK: 'true',
      SCENARIO_SIGNING_SECRET: env.SCENARIO_SIGNING_SECRET,
    })
    expect(extraFieldResponse.status).toBe(400)

    const wrongMethod = new Request(`${API_ORIGIN}/api/listening-scaffold`, { method: 'GET' })
    expect((await fetchWorker(wrongMethod, env)).status).toBe(405)

    const wrongContentType = new Request(`${API_ORIGIN}/api/listening-scaffold`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify(request),
    })
    expect((await fetchWorker(wrongContentType, env)).status).toBe(415)

    const crossSite = post(request, { 'sec-fetch-site': 'cross-site' })
    expect((await fetchWorker(crossSite, env)).status).toBe(403)
  })

  it('does not affect other endpoints after a listening scaffold error', async () => {
    const badResponse = await fetchWorker(post({
      scenarioType: 'dynamic',
      sessionToken: '',
      turn: 1,
      partnerPromptJa: scenarioOpeningLine,
    }), env)
    expect(badResponse.status).toBe(400)

    const configResponse = await fetchWorker(new Request(`${API_ORIGIN}/api/config`), env)
    expect(configResponse.status).toBe(200)
    await expect(configResponse.json()).resolves.toMatchObject({
      openai: { available: true },
    })
  })
})
