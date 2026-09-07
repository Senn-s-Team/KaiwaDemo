/**
 * [INPUT]: 依赖 zod、Worker 环境密钥与 types 中的动态场景、场景 token、会话 token 契约
 * [OUTPUT]: 对外提供场景、会话与独立长期练习 token 的签名、验证、claims 类型和结构化 TokenError
 * [POS]: worker 的可信边界，以严格 schema 保证签名和验签都完整保存五轮动态场景契约并拒绝 legacy claims
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { z } from 'zod'
import type {
  DynamicScenarioDefinition,
  ScenarioTokenPayload,
  SessionTokenPayload,
} from './types'
import type { Env } from './env'

const TOKEN_SCHEMA_VERSION = 1
const HMAC_ALGORITHM = { name: 'HMAC', hash: 'SHA-256' } as const

type TokenKind = 'scenario' | 'session' | 'practice'

type TokenErrorCode =
  | 'token_secret_missing'
  | 'token_malformed'
  | 'token_invalid_signature'
  | 'token_schema_unsupported'
  | 'token_kind_mismatch'
  | 'token_expired'
  | 'token_claims_invalid'

const trainingGoalSchema = z.object({
  id: z.string().trim().min(1),
  titleZh: z.string().trim().min(1),
  descriptionZh: z.string().trim().min(1),
}).strict()

const completionRulesSchema = z.object({
  completed: z.array(z.string().trim().min(1)).min(1),
  partial: z.array(z.string().trim().min(1)).min(1),
  notCompleted: z.array(z.string().trim().min(1)).min(1),
}).strict()

const dynamicScenarioSchema = z.object({
  id: z.string().trim().min(1),
  version: z.number().int().positive(),
  evaluationVersion: z.number().int().positive().optional(),
  evidencePoints: z.array(trainingGoalSchema).min(1).max(5).refine(points => new Set(points.map(p => p.id)).size === points.length).optional(),
  titleZh: z.string().trim().min(1),
  summaryZh: z.string().trim().min(1),
  aiRole: z.string().trim().min(1),
  userRole: z.string().trim().min(1),
  relationship: z.string().trim().min(1),
  tone: z.string().trim().min(1),
  communicationFunction: z.string().trim().min(1),
  firstLine: z.string().trim().min(1),
  partnerOpeningPlan: z.string().trim().min(1),
  userGoal: z.string().trim().min(1),
  coreGoal: trainingGoalSchema,
  initialFacts: z.array(z.string().trim().min(1)).min(1),
  partnerPrivateFacts: z.array(z.string().trim().min(1)),
  keyIntents: z.array(z.string().trim().min(1)).min(1),
  keyInformation: z.array(z.string().trim().min(1)).min(1),
  completionRules: completionRulesSchema,
  closingRules: z.array(z.string().trim().min(1)).min(1),
  maxTurns: z.literal(5),
  worldAnchors: z.array(z.string().trim().min(1)).min(1),
  followUpPrinciples: z.array(z.string().trim().min(1)).min(1),
  hintStrategy: z.string().trim().min(1),
  feedbackFocus: z.array(z.string().trim().min(1)).min(1),
  safetyBoundary: z.string().trim().min(1),
}).strict().refine(scenario => (scenario.evaluationVersion === undefined) === (scenario.evidencePoints === undefined), 'Evaluation version and evidence points must be provided together.')

const scenarioTokenSchema = z.object({
  schemaVersion: z.literal(TOKEN_SCHEMA_VERSION),
  kind: z.literal('scenario'),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  scenario: dynamicScenarioSchema,
}).strict().refine(({ issuedAt, expiresAt }) => expiresAt > issuedAt, 'expiresAt must be after issuedAt.')

const sessionTokenSchema = z.object({
  schemaVersion: z.literal(TOKEN_SCHEMA_VERSION),
  kind: z.literal('session'),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  scenario: dynamicScenarioSchema,
  startedAt: z.number().int().nonnegative(),
}).strict().refine(({ issuedAt, expiresAt }) => expiresAt > issuedAt, 'expiresAt must be after issuedAt.')

const practiceTokenSchema = z.object({
  schemaVersion: z.literal(TOKEN_SCHEMA_VERSION),
  kind: z.literal('practice'),
  issuedAt: z.number().int().nonnegative(),
  scenario: dynamicScenarioSchema.refine(scenario => Boolean(scenario.evaluationVersion && scenario.evidencePoints)),
}).strict()
interface PracticeTokenPayload { schemaVersion: 1; kind: 'practice'; issuedAt: number; scenario: DynamicScenarioDefinition }
function parsePracticeTokenPayload(payload: unknown): PracticeTokenPayload {
  const result = practiceTokenSchema.safeParse(payload)
  if (!result.success) throw new TokenError('token_claims_invalid', 'Practice token claims are invalid.', 401)
  return result.data
}
export async function signPracticeToken(env: Env, scenario: DynamicScenarioDefinition): Promise<string> {
  return signPayload(env, { schemaVersion: 1, kind: 'practice', issuedAt: Date.now(), scenario })
}
export async function verifyPracticeToken(env: Env, token: string): Promise<PracticeTokenPayload> {
  return parsePracticeTokenPayload(await verifyPayload(env, token, 'practice', Date.now()))
}

function parseScenarioTokenPayload(payload: unknown): ScenarioTokenPayload {
  const result = scenarioTokenSchema.safeParse(payload)
  if (!result.success) {
    throw new TokenError('token_claims_invalid', 'Scenario token claims are invalid.', 401)
  }

  return result.data
}

function parseSessionTokenPayload(payload: unknown): SessionTokenPayload {
  const result = sessionTokenSchema.safeParse(payload)
  if (!result.success) {
    throw new TokenError('token_claims_invalid', 'Session token claims are invalid.', 401)
  }

  return result.data
}
export class TokenError extends Error {
  readonly name = 'TokenError'
  readonly code: TokenErrorCode
  readonly status: 400 | 401 | 500

  constructor(code: TokenErrorCode, message: string, status: 400 | 401 | 500) {
    super(message)
    this.code = code
    this.status = status
  }
}

export interface ScenarioTokenClaims {
  scenario: DynamicScenarioDefinition
  expiresAt: number
  issuedAt?: number
}

export interface SessionTokenClaims {
  scenario: DynamicScenarioDefinition
  startedAt: number
  expiresAt: number
  issuedAt?: number
}

export async function signScenarioToken(env: Env, claims: ScenarioTokenClaims): Promise<string> {
  const payload: ScenarioTokenPayload = {
    schemaVersion: TOKEN_SCHEMA_VERSION,
    kind: 'scenario',
    issuedAt: claims.issuedAt ?? Date.now(),
    expiresAt: claims.expiresAt,
    scenario: claims.scenario,
  }

  return signPayload(env, payload)
}

export async function signSessionToken(env: Env, claims: SessionTokenClaims): Promise<string> {
  const payload: SessionTokenPayload = {
    schemaVersion: TOKEN_SCHEMA_VERSION,
    kind: 'session',
    issuedAt: claims.issuedAt ?? Date.now(),
    expiresAt: claims.expiresAt,
    scenario: claims.scenario,
    startedAt: claims.startedAt,
  }

  return signPayload(env, payload)
}

export async function verifyScenarioToken(env: Env, token: string, now = Date.now()): Promise<ScenarioTokenPayload> {
  const payload = await verifyPayload(env, token, 'scenario', now)
  return parseScenarioTokenPayload(payload)
}

export async function verifySessionToken(env: Env, token: string, now = Date.now()): Promise<SessionTokenPayload> {
  const payload = await verifyPayload(env, token, 'session', now)
  return parseSessionTokenPayload(payload)
}

async function signPayload(
  env: Env,
  payload: ScenarioTokenPayload | SessionTokenPayload | PracticeTokenPayload,
): Promise<string> {
  if (payload.kind === 'scenario') {
    parseScenarioTokenPayload(payload)
  } else if (payload.kind === 'practice') {
    parsePracticeTokenPayload(payload)
  } else {
    parseSessionTokenPayload(payload)
  }

  const signingKey = await getSigningKey(env)
  const encodedPayload = encodeBase64Url(new TextEncoder().encode(JSON.stringify(payload)))
  const signature = await crypto.subtle.sign(HMAC_ALGORITHM, signingKey, new TextEncoder().encode(encodedPayload))

  return `${encodedPayload}.${encodeBase64Url(new Uint8Array(signature))}`
}

async function verifyPayload(
  env: Env,
  token: string,
  expectedKind: TokenKind,
  now: number,
): Promise<unknown> {
  const [encodedPayload, encodedSignature, ...extraParts] = token.split('.')
  if (!encodedPayload || !encodedSignature || extraParts.length !== 0) {
    throw new TokenError('token_malformed', 'Token format is invalid.', 400)
  }

  let signature: Uint8Array
  try {
    signature = decodeBase64Url(encodedSignature)
  } catch {
    throw new TokenError('token_malformed', 'Token signature encoding is invalid.', 400)
  }

  const signingKey = await getSigningKey(env)
  const isValid = await crypto.subtle.verify(
    HMAC_ALGORITHM,
    signingKey,
    signature,
    new TextEncoder().encode(encodedPayload),
  )
  if (!isValid) {
    throw new TokenError('token_invalid_signature', 'Token signature is invalid.', 401)
  }

  const payload = parsePayload(encodedPayload)
  assertPayloadEnvelope(payload, expectedKind)

  if (!Number.isSafeInteger(now) || now < 0) {
    throw new TokenError('token_claims_invalid', 'Verification time is invalid.', 400)
  }
  if (expectedKind !== 'practice' && payload.expiresAt <= now) {
    throw new TokenError('token_expired', 'Token has expired.', 401)
  }

  return payload
}

async function getSigningKey(env: Env): Promise<CryptoKey> {
  let secret = env.SCENARIO_SIGNING_SECRET?.trim() || env.OPENAI_API_KEY?.trim()
  if (!secret) {
    if (env.ALLOW_MOCK === 'true') {
      secret = 'dev_mock_scenario_signing_secret_only'
    } else {
      throw new TokenError('token_secret_missing', 'SCENARIO_SIGNING_SECRET or OPENAI_API_KEY must be configured.', 500)
    }
  }

  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`kaiwa_scenario_${secret}`),
    HMAC_ALGORITHM,
    false,
    ['sign', 'verify'],
  )
}

function parsePayload(encodedPayload: string): unknown {
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(decodeBase64Url(encodedPayload))
    return JSON.parse(decoded)
  } catch {
    throw new TokenError('token_malformed', 'Token payload encoding is invalid.', 400)
  }
}

function assertPayloadEnvelope(payload: unknown, expectedKind: TokenKind): asserts payload is {
  schemaVersion: number
  kind: TokenKind
  issuedAt: number
  expiresAt: number
} {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)
    || !('schemaVersion' in payload) || !('kind' in payload)
    || !('issuedAt' in payload) || (expectedKind !== 'practice' && !('expiresAt' in payload))) {
    throw new TokenError('token_claims_invalid', 'Token claims are invalid.', 401)
  }
  if (payload.schemaVersion !== TOKEN_SCHEMA_VERSION) {
    throw new TokenError('token_schema_unsupported', 'Token schema version is unsupported.', 401)
  }
  if (payload.kind !== expectedKind) {
    throw new TokenError('token_kind_mismatch', 'Token type does not match this endpoint.', 401)
  }
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }

  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('Invalid base64url input.')
  }

  const padded = `${value.replaceAll('-', '+').replaceAll('_', '/')}${'='.repeat((4 - (value.length % 4)) % 4)}`
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }

  return bytes
}
