/**
 * [INPUT]: 依赖共享场景草拟任务契约、Workflow binding、签名能力与 token 签发
 * [OUTPUT]: 对外提供纯任务提交/状态映射及 HTTP task handlers
 * [POS]: Worker 场景草拟耐久任务边界，路由与 Workflow runtime 的纯 seam
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { z } from 'zod'
import { SCENARIO_DRAFT_TASK_TTL_MS, ScenarioDraftTaskAcceptedSchema, ScenarioDraftTaskRequestSchema, ScenarioDraftModelResultSchema, type ScenarioDraftTaskRequest, type ScenarioDraftTaskStatus } from '../shared/scenario-draft'
import type { Env } from './env'
import { errorJson, json, readJsonBody } from './http'
import { signPracticeToken, signScenarioDraftCapability, signScenarioToken, verifyScenarioDraftCapability, TokenError } from './tokens'
import { LIMITS } from './constants'
interface ScenarioDraftInstance {
  id: string
  status(): Promise<{ status: string; output?: unknown; error?: { message: string } }>
}

export class ScenarioDraftTaskError extends Error {
  readonly code: string
  readonly status: 401 | 410 | 500 | 503
  constructor(code: string, message: string, status: 401 | 410 | 500 | 503 = 410) {
    super(message)
    this.code = code
    this.status = status
  }
}

export async function taskIdForRequest(request: ScenarioDraftTaskRequest): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(request)))
  return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export function mapWorkflowStatus(status: { status: string; output?: unknown; error?: { message: string } }): ScenarioDraftTaskStatus {
  if (status.status === 'complete') return { status: 'pending' }
  if (status.status === 'queued' || status.status === 'running' || status.status === 'waiting' || status.status === 'waitingForPause') return { status: 'pending' }
  if (status.status === 'unknown') return { status: 'failed', error: { code: 'scenario_draft_unavailable', message: 'Scenario draft task is no longer available.' } }
  return { status: 'failed', error: { code: `scenario_draft_${status.status}`, message: 'Scenario draft generation failed. Retry this request.' } }
}

export async function submitScenarioDraftTask(env: Env, request: ScenarioDraftTaskRequest): Promise<{ taskToken: string; expiresAt: number }> {
  const parsed = ScenarioDraftTaskRequestSchema.parse(request)
  const now = Date.now()
  const expiresAt = parsed.createdAt + SCENARIO_DRAFT_TASK_TTL_MS
  if (parsed.createdAt > now + 60_000 || parsed.createdAt < now - SCENARIO_DRAFT_TASK_TTL_MS) throw new ScenarioDraftTaskError('scenario_draft_expired', 'Scenario draft task request is expired.')
  if (!env.SCENARIO_DRAFT) throw new ScenarioDraftTaskError('workflow_unconfigured', 'Scenario draft Workflow is not configured.', 503)
  const taskId = await taskIdForRequest(parsed)
  const taskToken = await signScenarioDraftCapability(env, taskId, expiresAt)
  try {
    await env.SCENARIO_DRAFT.create({ id: taskId, params: parsed, retention: { successRetention: '1 day', errorRetention: '1 day' } })
  } catch (error) {
    try {
      const existing = await env.SCENARIO_DRAFT.get(taskId)
      await existing.status()
    } catch { throw error }
  }
  return { taskToken, expiresAt }
}

export async function getScenarioDraftTaskStatus(env: Env, taskToken: string): Promise<ScenarioDraftTaskStatus> {
  const capability = await verifyScenarioDraftCapability(env, taskToken)
  if (!env.SCENARIO_DRAFT) throw new ScenarioDraftTaskError('workflow_unconfigured', 'Scenario draft Workflow is not configured.', 503)
  let instance: ScenarioDraftInstance
  try { instance = await env.SCENARIO_DRAFT.get(capability.taskId) } catch (error) {
    const message = error instanceof Error ? error.message.toLowerCase() : ''
    if (message.includes('not found') || message.includes('does not exist') || message.includes('missing')) throw new ScenarioDraftTaskError('scenario_draft_missing', 'Scenario draft task is no longer available.')
    throw new ScenarioDraftTaskError('workflow_unavailable', 'Scenario draft task status is temporarily unavailable.', 503)
  }
  const raw = await instance.status()
  if (raw.status === 'complete') {
    if (raw.output && typeof raw.output === 'object' && !Array.isArray(raw.output) && (raw.output as Record<string, unknown>).status === 'failed') {
      const failure = raw.output as { status: 'failed'; error?: { code?: unknown } }
      return { status: 'failed', error: { code: typeof failure.error?.code === 'string' ? failure.error.code : 'scenario_draft_failed', message: 'Scenario draft generation failed. Retry this request.' } }
    }
    const parsed = ScenarioDraftModelResultSchema.safeParse(raw.output)
    if (!parsed.success) return { status: 'failed', error: { code: 'scenario_draft_invalid_result', message: 'Scenario draft result is invalid.' } }
    if (parsed.data.status === 'needs_clarification') return { status: 'complete', result: parsed.data }
    const issuedAt = Date.now()
    const expiresAt = issuedAt + LIMITS.scenarioTokenTtlMs
    return { status: 'complete', result: { ...parsed.data, scenarioToken: await signScenarioToken(env, { scenario: parsed.data.scenario, expiresAt, issuedAt }), practiceToken: await signPracticeToken(env, parsed.data.scenario) } }
  }
  return mapWorkflowStatus(raw)
}

export async function handleScenarioDraftPost(request: Request, env: Env): Promise<Response> {
  const body = await readJsonBody(request, LIMITS.requestBytes)
  try {
    const accepted = ScenarioDraftTaskAcceptedSchema.parse(await submitScenarioDraftTask(env, ScenarioDraftTaskRequestSchema.parse(body)))
    return json(accepted, { status: 202 })
  } catch (error) {
    if (error instanceof z.ZodError) return errorJson(400, 'invalid_scenario_draft_request', 'Scenario draft request is invalid.')
    if (error instanceof TokenError) return errorJson(500, 'token_secret_missing', 'Scenario draft signing is not configured.')
    if (error instanceof ScenarioDraftTaskError) return errorJson(error.status, error.code, error.message)
    return errorJson(503, 'workflow_unavailable', 'Scenario draft task is temporarily unavailable. Retry this request.')
  }
}

export async function handleScenarioDraftGet(request: Request, env: Env): Promise<Response> {
  const authorization = request.headers.get('authorization') || ''
  const match = authorization.match(/^Bearer\s+(.+)$/i)
  if (!match) return errorJson(401, 'invalid_capability', 'Task capability is invalid.')
  try { return json(await getScenarioDraftTaskStatus(env, match[1]!)) }
  catch (error) {
    if (error instanceof TokenError) return errorJson(error.code === 'token_expired' ? 410 : 401, error.code, error.code === 'token_expired' ? 'Task capability has expired.' : 'Task capability is invalid.')
    if (error instanceof ScenarioDraftTaskError) return errorJson(error.status, error.code, error.message)
    return errorJson(503, 'workflow_unavailable', 'Scenario draft task status is temporarily unavailable. Retry this request.')
  }
}
