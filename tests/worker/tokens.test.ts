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
const env = { SCENARIO_SIGNING_SECRET: 'test-only-signing-secret' }

const scenario: DynamicScenarioDefinition = {
  id: 'dynamic-cafe-order',
  version: 1,
  titleZh: '咖啡店点单',
  summaryZh: '在繁忙咖啡店确认一杯定制饮品。',
  aiRole: '咖啡店店员',
  userRole: '顾客',
  relationship: '初次见面的服务关系',
  tone: '礼貌、自然',
  firstLine: 'いらっしゃいませ。ご注文はお決まりですか？',
  userGoal: '用日语点一杯符合需求的饮品。',
  coreGoals: [{ id: 'order', titleZh: '完成点单', descriptionZh: '说明饮品和尺寸。' }],
  optionalGoals: [],
  worldAnchors: ['午间高峰', '可选牛奶种类'],
  followUpPrinciples: ['一次只确认一个必要细节'],
  hintStrategy: '先提示意图，再给出可直接使用的表达。',
  feedbackFocus: ['请求表达', '听懂确认问题'],
  safetyBoundary: '不涉及现实个人资料或危险建议。',
  recommendedMinTurns: 6,
  recommendedMaxTurns: 8,
}

function expectTokenError(code: TokenError['code']) {
  return (error: unknown) => error instanceof TokenError && error.code === code
}

describe('dynamic scenario tokens', () => {
  it('signs and verifies a scenario token', async () => {
    const token = await signScenarioToken(env, {
      scenario,
      issuedAt: now,
      expiresAt: now + 60_000,
    })

    await expect(verifyScenarioToken(env, token, now + 1)).resolves.toEqual({
      schemaVersion: 1,
      kind: 'scenario',
      issuedAt: now,
      expiresAt: now + 60_000,
      scenario,
    })
  })

  it('rejects a tampered token payload', async () => {
    const token = await signScenarioToken(env, {
      scenario,
      issuedAt: now,
      expiresAt: now + 60_000,
    })
    const [payload, signature] = token.split('.')
    const tampered = `${payload.slice(0, -1)}${payload.endsWith('A') ? 'B' : 'A'}.${signature}`

    await expect(verifyScenarioToken(env, tampered, now + 1)).rejects.toSatisfy(
      expectTokenError('token_invalid_signature'),
    )
  })

  it('rejects expired tokens', async () => {
    const token = await signScenarioToken(env, {
      scenario,
      issuedAt: now,
      expiresAt: now + 1,
    })

    await expect(verifyScenarioToken(env, token, now + 1)).rejects.toSatisfy(expectTokenError('token_expired'))
  })

  it('rejects a valid token used at the wrong endpoint', async () => {
    const token = await signSessionToken(env, {
      scenario,
      cap: 10,
      startedAt: now,
      issuedAt: now,
      expiresAt: now + 60_000,
    })

    await expect(verifyScenarioToken(env, token, now + 1)).rejects.toSatisfy(
      expectTokenError('token_kind_mismatch'),
    )
  })

  it('rejects signing or verification without any secret', async () => {
    await expect(signScenarioToken({}, {
      scenario,
      issuedAt: now,
      expiresAt: now + 60_000,
    })).rejects.toSatisfy(expectTokenError('token_secret_missing'))

    const token = await signScenarioToken(env, {
      scenario,
      issuedAt: now,
      expiresAt: now + 60_000,
    })
    await expect(verifySessionToken({}, token, now + 1)).rejects.toSatisfy(
      expectTokenError('token_secret_missing'),
    )
  })
})
