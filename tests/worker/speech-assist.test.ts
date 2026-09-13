import { describe, expect, it } from 'vitest'
import {
  enforceCleanedSubsequence,
  isCharacterSubsequence,
  parseSpeechAssistModelOutput,
  parseSpeechAssistRequest,
  sanitizeContinuationSuggestion,
  ValidationError,
} from '../../worker/validation'
import { createMockSpeechAssist } from '../../worker/mock'
import { generateSpeechAssist } from '../../worker/openai'
import { signSessionToken } from '../../worker/tokens'
import worker from '../../worker/index'
import type { DynamicScenarioDefinition } from '../../worker/types'
import type { SpeechAssistRequest } from '../../shared/speech-assist'

const testScenario: DynamicScenarioDefinition = {
  id: 'dyn_test_cafe',
  version: 1,
  titleZh: '咖啡店点餐',
  summaryZh: '在咖啡店点一杯咖啡。',
  aiRole: '店員',
  userRole: '客',
  relationship: '接客',
  tone: '丁寧',
  opening: { speaker: 'assistant', partnerLineJa: 'いらっしゃいませ。何になさいますか？', planZh: '根据客人位于柜台这一可观察事实迎客并询问点单。' },
  userGoal: 'ホットコーヒーを1つ注文する。',
  coreGoal: { id: 'order', titleZh: '点单', descriptionZh: '明确点单内容。' },
  communicationFunction: '在咖啡店向店员明确点一杯指定饮品。',
  initialFacts: ['用户正在咖啡店柜台点餐'],
  partnerPrivateFacts: ['店员可以接受一杯热咖啡的订单'],
  keyIntents: ['明确表达点单请求'],
  keyInformation: ['饮品是热咖啡', '数量是一杯'],
  completionRules: {
    completed: ['明确说出饮品和数量并提出点单请求'],
    partial: ['只说出饮品或只表达想点单'],
    notCompleted: ['未提供可执行的点单内容'],
  },
  closingRules: ['确认饮品和数量后结束点单'],
  maxTurns: 5,
  worldAnchors: ['店内にいます'],
  followUpPrinciples: ['丁寧に対応する'],
  hintStrategy: '商品名を伝える',
  feedbackFocus: ['注文の明確さ'],
  safetyBoundary: '決済情報は扱わない',
}
const scenarioOpeningLine = testScenario.opening.speaker === 'assistant'
  ? testScenario.opening.partnerLineJa
  : (() => { throw new Error('Speech assist fixture requires assistant opening.') })()

const env = {
  SCENARIO_SIGNING_SECRET: 'test-secret-for-speech-assist-e2e',
  ALLOW_MOCK: 'true',
}

type WorkerFetch = (request: Request, workerEnv: typeof env) => Response | Promise<Response>
const fetchWorker = worker.fetch as unknown as WorkerFetch

describe('Worker Speech Assist - Request & Validation', () => {
  it('validates SpeechAssistRequest strict schema with all required fields', () => {
    const valid: SpeechAssistRequest = {
      requestId: 'req_12345',
      transcriptVersion: 2,
      observedTextJa: 'あの、カフェラテをお願いします',
      lastAssistantTextJa: 'ご注文はお決まりですか？',
      trailingSilenceMs: 950,
      sessionToken: 'valid-session-token',
      turn: 2,
    }

    expect(parseSpeechAssistRequest(valid)).toEqual(valid)
    expect(() => parseSpeechAssistRequest({ ...valid, turn: 6 })).toThrow(ValidationError)
    expect(() => parseSpeechAssistRequest({ ...valid, sessionToken: '' })).toThrow(ValidationError)
    expect(() => parseSpeechAssistRequest({ ...valid, observedTextJa: '' })).toThrow(ValidationError)
    expect(() => parseSpeechAssistRequest({ ...valid, requestId: '' })).toThrow(ValidationError)
    expect(() => parseSpeechAssistRequest({ ...valid, transcriptVersion: 0 })).toThrow(ValidationError)
    expect(() => parseSpeechAssistRequest({ ...valid, transcriptVersion: -1 })).toThrow(ValidationError)
    expect(() => parseSpeechAssistRequest({ ...valid, trailingSilenceMs: 899 })).toThrow(ValidationError)
    expect(() => parseSpeechAssistRequest({ ...valid, trailingSilenceMs: 15_000 })).toThrow(ValidationError)
    // 空文字は「相手発話が空」という不正な表現なので拒否し、user-opening 首輪の不在は null だけが表す。
    expect(() => parseSpeechAssistRequest({ ...valid, lastAssistantTextJa: '' })).toThrow(ValidationError)
    expect(parseSpeechAssistRequest({ ...valid, lastAssistantTextJa: null }).lastAssistantTextJa).toBeNull()
    // Extra unallowed keys rejected by strict()
    expect(() => parseSpeechAssistRequest({ ...valid, history: [] })).toThrow(ValidationError)
  })

  describe('Field A - Deletion-only subsequence constraint & prolonged sound mark (ー)', () => {
    it('allows character subsequence when only deleting fillers and stuttering', () => {
      expect(isCharacterSubsequence('ラテ', 'あのラテ')).toBe(true)
      expect(isCharacterSubsequence('私は行きます', 'ええと私は私は行きます')).toBe(true)
      expect(isCharacterSubsequence('行きます', '行きます')).toBe(true)
    })

    it('rejects changes when new words, characters, or modifications are introduced', () => {
      expect(isCharacterSubsequence('ラテ', 'らて')).toBe(false)
      expect(isCharacterSubsequence('ラテをお願いします', 'ラテ')).toBe(false)
      expect(isCharacterSubsequence('行きたい', '行きます')).toBe(false)
    })

    it('prolonged sound mark (ー) is a real character and cannot be added to bypass deletion constraint', () => {
      // User said "コヒー", model tried to add "ー" -> "コーヒー"
      expect(isCharacterSubsequence('コーヒー', 'コヒー')).toBe(false)
      expect(enforceCleanedSubsequence('コーヒー', 'コヒー')).toBe('コヒー')

      // User said "コーヒー", model kept "コーヒー" -> allowed
      expect(enforceCleanedSubsequence('コーヒー', 'あの、コーヒー')).toBe('コーヒー')
    })

    it('enforceCleanedSubsequence falls back to observedTextJa on any violation', () => {
      const observed = 'ええと、あの、ラテをお願いします'
      const validCleaned = 'ラテをお願いします'
      expect(enforceCleanedSubsequence(validCleaned, observed)).toBe('ラテをお願いします')

      // Hallucinated new fact / words
      const invalidCleaned = 'ラテとサンドイッチをお願いします'
      expect(enforceCleanedSubsequence(invalidCleaned, observed)).toBe(observed)

      // Changed word
      const changedCleaned = 'カプチーノをお願いします'
      expect(enforceCleanedSubsequence(changedCleaned, observed)).toBe(observed)

      // Empty string after stripping punctuation
      expect(enforceCleanedSubsequence('、、、', observed)).toBe(observed)
    })
  })

  describe('Field B - Continuation suggestion constraints & 20 code points boundary', () => {
    it('accepts safe short phrase / sentence-ender frameworks', () => {
      expect(sanitizeContinuationSuggestion('をお願いします')).toBe('をお願いします')
      expect(sanitizeContinuationSuggestion('について話したいです')).toBe('について話したいです')
      expect(sanitizeContinuationSuggestion('と思います')).toBe('と思います')
    })

    it('boundary test: exactly 20 Unicode code points passes, 21 code points rejected', () => {
      // Exactly 20 Japanese characters
      const exact20 = 'あいうえおかきくけこさしすせそたちつてと'
      expect(Array.from(exact20).length).toBe(20)
      expect(sanitizeContinuationSuggestion(exact20)).toBe(exact20)

      // 21 Japanese characters
      const len21 = 'あいうえおかきくけこさしすせそたちつてとな'
      expect(Array.from(len21).length).toBe(21)
      expect(sanitizeContinuationSuggestion(len21)).toBeNull()
    })

    it('rejects suggestions containing numbers, prices, or strong negations/promises', () => {
      expect(sanitizeContinuationSuggestion('500円になります')).toBeNull()
      expect(sanitizeContinuationSuggestion('５００円')).toBeNull()
      expect(sanitizeContinuationSuggestion('３つください')).toBeNull()
      expect(sanitizeContinuationSuggestion('ではないと思います')).toBeNull()
      expect(sanitizeContinuationSuggestion('絶対に約束します')).toBeNull()
    })

    it('converts non-string or empty suggestions to null', () => {
      expect(sanitizeContinuationSuggestion(null)).toBeNull()
      expect(sanitizeContinuationSuggestion(undefined)).toBeNull()
      expect(sanitizeContinuationSuggestion('   ')).toBeNull()
    })
  })

  describe('A/B separation in model output parser', () => {
    it('parses A and B independently into clean fields', () => {
      const observed = 'あの、パスポートの更新を'
      const modelOutput = {
        cleanedObservedTextJa: 'パスポートの更新を',
        continuationSuggestionJa: 'したいのですが',
      }
      const res = parseSpeechAssistModelOutput(modelOutput, observed)
      expect(res.cleanedObservedTextJa).toBe('パスポートの更新を')
      expect(res.continuationSuggestionJa).toBe('したいのですが')
    })

    it('protects A and nullifies B independently if invalid', () => {
      const observed = 'あの、パスポートの更新を'
      const modelOutput = {
        cleanedObservedTextJa: 'ビザの申請をしたい', // Violates subsequence
        continuationSuggestionJa: '1000円です', // Violates price rule
      }
      const res = parseSpeechAssistModelOutput(modelOutput, observed)
      expect(res.cleanedObservedTextJa).toBe(observed) // Protected: fallback to observed
      expect(res.continuationSuggestionJa).toBeNull() // Protected: fallback to null
    })
  })

  describe('Worker Mock & Missing API Key Handling', () => {
    it('returns valid cleaned A and safe B in mock mode', () => {
      const mockRes = createMockSpeechAssist({
        requestId: 'req_1',
        transcriptVersion: 1,
        lastAssistantTextJa: 'いらっしゃいませ。',
        trailingSilenceMs: 1000,
        sessionToken: 'tok',
        turn: 1,
        observedTextJa: 'あの、こんにちは',
      })
      expect(mockRes.cleanedObservedTextJa).toBe('こんにちは')
      expect(mockRes.continuationSuggestionJa).toBe('と思います')
    })

    it('throws openai_unconfigured 503 when OPENAI_API_KEY missing and ALLOW_MOCK is false', async () => {
      const token = await signSessionToken(env, {
        scenario: testScenario,
        startedAt: Date.now(),
        expiresAt: Date.now() + 3_600_000,
      })
      const noMockEnv = {
        ...env,
        ALLOW_MOCK: 'false',
        OPENAI_API_KEY: undefined,
      }
      const req: SpeechAssistRequest = {
        requestId: 'req_nomock',
        transcriptVersion: 1,
        lastAssistantTextJa: scenarioOpeningLine,
        trailingSilenceMs: 1000,
        sessionToken: token,
        turn: 1,
        observedTextJa: 'カフェラテをお願いします',
      }
      await expect(generateSpeechAssist(noMockEnv as never, req)).rejects.toMatchObject({
        code: 'openai_unconfigured',
        status: 503,
      })
    })
  })

  describe('E2E Route POST /api/speech/assist with signed session token', () => {
    it('successfully returns strictly cleanedObservedTextJa and continuationSuggestionJa fields', async () => {
      const token = await signSessionToken(env, {
        scenario: testScenario,
        startedAt: Date.now(),
        expiresAt: Date.now() + 3_600_000,
      })

      const payload: SpeechAssistRequest = {
        requestId: 'req_e2e_1',
        transcriptVersion: 1,
        observedTextJa: 'あの、ええと、アイスコーヒーをください',
        lastAssistantTextJa: scenarioOpeningLine,
        trailingSilenceMs: 1200,
        sessionToken: token,
        turn: 1,
      }

      const request = new Request('https://kaiwa.example/api/speech/assist', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })

      const response = await fetchWorker(request, env)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('application/json')
      const body = (await response.json()) as {
        cleanedObservedTextJa: string
        continuationSuggestionJa: string | null
      }
      // Assert response strictly has only A and B product fields
      expect(Object.keys(body).sort()).toEqual(['cleanedObservedTextJa', 'continuationSuggestionJa'])
      expect(typeof body.cleanedObservedTextJa).toBe('string')
      expect(body.cleanedObservedTextJa.length).toBeGreaterThan(0)
    })

    it('accepts a user-opening first turn without any partner utterance', async () => {
      const token = await signSessionToken(env, {
        scenario: testScenario,
        startedAt: Date.now(),
        expiresAt: Date.now() + 3_600_000,
      })
      const payload: SpeechAssistRequest = {
        requestId: 'req_e2e_user_open',
        transcriptVersion: 1,
        observedTextJa: 'あの、ええと、すみません、忘れ物をしたかもしれなくて',
        lastAssistantTextJa: null,
        trailingSilenceMs: 1200,
        sessionToken: token,
        turn: 1,
      }
      const response = await fetchWorker(new Request('https://kaiwa.example/api/speech/assist', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }), env)
      expect(response.status).toBe(200)
      const body = (await response.json()) as { cleanedObservedTextJa: string; continuationSuggestionJa: string | null }
      // A 只依据用户自己的观察文本清理，不借用不存在的相手発話。
      expect(isCharacterSubsequence(body.cleanedObservedTextJa, payload.observedTextJa)).toBe(true)
      expect(body.cleanedObservedTextJa.length).toBeLessThan(payload.observedTextJa.length)
    })
  })
})
