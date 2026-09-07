import { describe, expect, it } from 'vitest'
import type { DynamicScenarioDefinition } from '../../worker/types'
import {
  signScenarioToken,
  signSessionToken,
  TokenError,
  verifyScenarioToken,
  verifySessionToken,
} from '../../worker/tokens'

const now = 1_800_000_000_000
const signingSecret = 'test-only-signing-secret'
const env = { SCENARIO_SIGNING_SECRET: signingSecret }

const scenario: DynamicScenarioDefinition = {
  id: 'dynamic-cafe-order',
  version: 1,
  titleZh: '咖啡店点单',
  summaryZh: '在咖啡店完成饮品点单。',
  aiRole: '咖啡店店员',
  userRole: '顾客',
  relationship: '初次见面的服务关系',
  tone: '礼貌自然的丁寧体',
  communicationFunction: '在咖啡店礼貌提出饮品需求并确认点单内容',
  firstLine: 'いらっしゃいませ。ご注文はお決まりですか？',
  partnerOpeningPlan: '以店员问候进入点单，并先询问顾客想要的饮品。',
  userGoal: '用日语完成饮品点单。',
  coreGoal: { id: 'order', titleZh: '完成点单', descriptionZh: '说明饮品和尺寸。' },
  initialFacts: ['顾客正在咖啡店点单', '店员可以确认饮品规格'],
  partnerPrivateFacts: [],
  keyIntents: ['用户：完成一杯饮品点单', 'AI：确认顾客的饮品需求'],
  keyInformation: ['饮品名称', '饮品尺寸'],
  completionRules: {
    completed: ['确认稿明确饮品和尺寸'],
    partial: ['确认稿只明确饮品或尺寸之一'],
    notCompleted: ['确认稿没有可用于点单的信息'],
  },
  closingRules: ['第4轮确认最后一项必要信息', '第5轮不提问并确认点单结束'],
  maxTurns: 5,
  worldAnchors: ['午间高峰'],
  followUpPrinciples: ['一次只确认一个细节'],
  hintStrategy: '先提示饮品，再提示尺寸。',
  feedbackFocus: ['请求表达'],
  safetyBoundary: '不处理真实支付信息。',
}

function expectTokenError(code: TokenError['code']) {
  return (error: unknown) => error instanceof TokenError && error.code === code
}

async function signRawScenario(scenarioClaims: unknown): Promise<string> {
  const encoder = new TextEncoder()
  const algorithm = { name: 'HMAC', hash: 'SHA-256' } as const
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(`kaiwa_scenario_${signingSecret}`),
    algorithm,
    false,
    ['sign'],
  )
  const payload = {
    schemaVersion: 1,
    kind: 'scenario',
    issuedAt: now,
    expiresAt: now + 60_000,
    scenario: scenarioClaims,
  }
  const encodedPayload = btoa(String.fromCharCode(...encoder.encode(JSON.stringify(payload))))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
  const signature = new Uint8Array(await crypto.subtle.sign(algorithm, key, encoder.encode(encodedPayload)))
  const encodedSignature = btoa(String.fromCharCode(...signature))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
  return `${encodedPayload}.${encodedSignature}`
}

describe('dynamic scenario tokens', () => {
  it('signs and verifies a single-goal scenario token', async () => {
    const token = await signScenarioToken(env, { scenario, issuedAt: now, expiresAt: now + 60_000 })
    await expect(verifyScenarioToken(env, token, now + 1)).resolves.toEqual({
      schemaVersion: 1,
      kind: 'scenario',
      issuedAt: now,
      expiresAt: now + 60_000,
      scenario,
    })
  })

  it('preserves every batch-contract field in signed claims', async () => {
    const token = await signScenarioToken(env, { scenario, issuedAt: now, expiresAt: now + 60_000 })
    const payload = await verifyScenarioToken(env, token, now + 1)
    expect(payload.scenario).toEqual(scenario)
    expect(payload.scenario.maxTurns).toBe(5)
    expect(payload.scenario.partnerPrivateFacts).toEqual([])
  })

  it('rejects signed claims with missing or legacy scenario fields', async () => {
    const incompleteScenario = { ...scenario }
    Reflect.deleteProperty(incompleteScenario, 'communicationFunction')
    const legacyScenario = { ...scenario, recommendedMinTurns: 6 }
    const incompleteToken = await signRawScenario(incompleteScenario)
    const legacyToken = await signRawScenario(legacyScenario)

    await expect(verifyScenarioToken(env, incompleteToken, now + 1))
      .rejects.toSatisfy(expectTokenError('token_claims_invalid'))
    await expect(verifyScenarioToken(env, legacyToken, now + 1))
      .rejects.toSatisfy(expectTokenError('token_claims_invalid'))
  })

  it('signs a session without a variable turn cap', async () => {
    const token = await signSessionToken(env, {
      scenario,
      startedAt: now,
      issuedAt: now,
      expiresAt: now + 60_000,
    })
    await expect(verifySessionToken(env, token, now + 1)).resolves.toEqual({
      schemaVersion: 1,
      kind: 'session',
      issuedAt: now,
      expiresAt: now + 60_000,
      scenario,
      startedAt: now,
    })
  })

  it('rejects tampering, expiry, and wrong token kind', async () => {
    const scenarioToken = await signScenarioToken(env, { scenario, issuedAt: now, expiresAt: now + 60_000 })
    const [payload, signature] = scenarioToken.split('.')
    const tampered = `${payload.slice(0, -1)}${payload.endsWith('A') ? 'B' : 'A'}.${signature}`
    await expect(verifyScenarioToken(env, tampered, now + 1)).rejects.toSatisfy(expectTokenError('token_invalid_signature'))

    const expired = await signScenarioToken(env, { scenario, issuedAt: now, expiresAt: now + 1 })
    await expect(verifyScenarioToken(env, expired, now + 1)).rejects.toSatisfy(expectTokenError('token_expired'))

    const sessionToken = await signSessionToken(env, { scenario, startedAt: now, issuedAt: now, expiresAt: now + 60_000 })
    await expect(verifyScenarioToken(env, sessionToken, now + 1)).rejects.toSatisfy(expectTokenError('token_kind_mismatch'))
  })

  it('rejects signing or verification without a secret', async () => {
    await expect(signScenarioToken({}, { scenario, issuedAt: now, expiresAt: now + 60_000 }))
      .rejects.toSatisfy(expectTokenError('token_secret_missing'))
    const token = await signScenarioToken(env, { scenario, issuedAt: now, expiresAt: now + 60_000 })
    await expect(verifySessionToken({}, token, now + 1)).rejects.toSatisfy(expectTokenError('token_secret_missing'))
  })
})
