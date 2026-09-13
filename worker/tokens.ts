/**
 * [INPUT]: 依赖 zod、Worker 环境密钥，以及含判别式开场的动态场景、场景/会话/任务和 telemetry token 契约
 * [OUTPUT]: 提供各类 HMAC capability 的签发、验签、过期与域隔离
 * [POS]: Worker 的凭据边界；telemetry token 仅用于内存会话上传认证
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { z } from 'zod'
import type {
  DynamicScenarioDefinition,
  ScenarioDraftCapabilityPayload,
  FeedbackTaskCapabilityPayload,
  ScenarioTokenPayload,
  SessionTokenPayload,
} from './types'
import type { Env } from './env'

const TOKEN_SCHEMA_VERSION = 1
const HMAC_ALGORITHM = { name: 'HMAC', hash: 'SHA-256' } as const

type TokenKind = 'scenario' | 'session' | 'practice' | 'scenario_draft' | 'feedback_task' | 'telemetry'
const telemetryTokenSchema = z.object({ schemaVersion: z.literal(2), kind: z.literal('telemetry'), issuedAt: z.number().int().nonnegative(), expiresAt: z.number().int().positive(), sessionId: z.string().regex(/^dyn_ses_[A-Za-z0-9_-]{1,55}$/) }).strict().refine(value => value.expiresAt > value.issuedAt, 'expiresAt must be after issuedAt.')

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

const scenarioOpeningSchema = z.discriminatedUnion('speaker', [
  z.object({ speaker: z.literal('assistant'), partnerLineJa: z.string().trim().min(1), planZh: z.string().trim().min(1) }).strict(),
  z.object({ speaker: z.literal('user'), planZh: z.string().trim().min(1) }).strict(),
])

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
  opening: scenarioOpeningSchema,
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
export interface TelemetryTokenClaims {
  sessionId: string
  expiresAt?: number
  issuedAt?: number
}

export async function signTelemetryToken(env: Env, sessionId: string, issuedAt = Date.now()): Promise<string> {
  if (!/^dyn_ses_[A-Za-z0-9_-]{1,55}$/.test(sessionId)) throw new TokenError('token_claims_invalid', 'Telemetry session claims are invalid.', 400)
  const expiresAt = issuedAt + 8 * 24 * 60 * 60 * 1000
  return signPayload(env, { schemaVersion: 2, kind: 'telemetry', issuedAt, expiresAt, sessionId })
}

export async function verifyTelemetryToken(env: Env, token: string, sessionId: string, now = Date.now()): Promise<z.infer<typeof telemetryTokenSchema>> {
  const payload = await verifyPayload(env, token, 'telemetry', now)
  const parsed = telemetryTokenSchema.safeParse(payload)
  if (!parsed.success) throw new TokenError('token_claims_invalid', 'Telemetry token claims are invalid.', 401)
  if (parsed.data.sessionId !== sessionId) throw new TokenError('token_claims_invalid', 'Telemetry token session does not match.', 401)
  return parsed.data
}

export async function hashTelemetryClientId(env: Env, clientId: string): Promise<string> {
  const key = await getSigningKey(env, 'telemetry')
  const digest = await crypto.subtle.sign(HMAC_ALGORITHM, key, new TextEncoder().encode(`client_id:${clientId}`))
  return encodeBase64Url(new Uint8Array(digest))
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
  payload: ScenarioTokenPayload | SessionTokenPayload | PracticeTokenPayload | ScenarioDraftCapabilityPayload | FeedbackTaskCapabilityPayload | { schemaVersion: 2; kind: 'telemetry'; issuedAt: number; expiresAt: number; sessionId: string },
): Promise<string> {
  if (payload.kind === 'scenario') parseScenarioTokenPayload(payload)
  else if (payload.kind === 'practice') parsePracticeTokenPayload(payload)
  else if (payload.kind === 'session') parseSessionTokenPayload(payload)
  else if (payload.kind === 'telemetry') telemetryTokenSchema.parse(payload)
  const signingKey = await getSigningKey(env, payload.kind)
  const encodedPayload = encodeBase64Url(new TextEncoder().encode(JSON.stringify(payload)))
  const signature = await crypto.subtle.sign(HMAC_ALGORITHM, signingKey, new TextEncoder().encode(encodedPayload))
  return `${encodedPayload}.${encodeBase64Url(new Uint8Array(signature))}`
}

export async function signScenarioDraftCapability(env: Env, taskId: string, expiresAt: number, issuedAt = Date.now()): Promise<string> {
  if (!taskId || !Number.isSafeInteger(expiresAt) || expiresAt <= issuedAt) throw new TokenError('token_claims_invalid', 'Task capability claims are invalid.', 400)
  return signPayload(env, { schemaVersion: 1, kind: 'scenario_draft', issuedAt, expiresAt, taskId })
}

export async function verifyScenarioDraftCapability(env: Env, token: string, now = Date.now()): Promise<ScenarioDraftCapabilityPayload> {
  const payload = await verifyPayload(env, token, 'scenario_draft', now)
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload) || typeof (payload as Record<string, unknown>).taskId !== 'string' || !(payload as Record<string, unknown>).taskId) {
    throw new TokenError('token_claims_invalid', 'Task capability claims are invalid.', 401)
  }
  return payload as ScenarioDraftCapabilityPayload
}

export async function signFeedbackTaskCapability(env: Env, taskId: string, expiresAt: number, issuedAt = Date.now()): Promise<string> {
  if (!taskId || !Number.isSafeInteger(expiresAt) || expiresAt <= issuedAt) throw new TokenError('token_claims_invalid', 'Task capability claims are invalid.', 400)
  return signPayload(env, { schemaVersion: 1, kind: 'feedback_task', issuedAt, expiresAt, taskId })
}

export async function verifyFeedbackTaskCapability(env: Env, token: string, now = Date.now()): Promise<FeedbackTaskCapabilityPayload> {
  const payload = await verifyPayload(env, token, 'feedback_task', now)
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload) || typeof (payload as Record<string, unknown>).taskId !== 'string' || !(payload as Record<string, unknown>).taskId) {
    throw new TokenError('token_claims_invalid', 'Task capability claims are invalid.', 401)
  }
  return payload as FeedbackTaskCapabilityPayload
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

  const signingKey = await getSigningKey(env, expectedKind)
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

async function getSigningKey(env: Env, kind: TokenKind = 'scenario'): Promise<CryptoKey> {
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
    new TextEncoder().encode(`${kind === 'feedback_task' ? 'kaiwa_feedback_task' : kind === 'telemetry' ? 'kaiwa_validation_telemetry' : 'kaiwa_scenario'}_${secret}`),
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
  const expectedSchemaVersion = expectedKind === 'telemetry' ? 2 : TOKEN_SCHEMA_VERSION
  if (payload.schemaVersion !== expectedSchemaVersion) {
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
