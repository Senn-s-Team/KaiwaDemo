/**
 * [INPUT]: shared nullable 相手事实 feedback task envelope、签名会话与 Workflow binding
 * [OUTPUT]: 按判别式开场校验 feedback/redo durable task 的提交与查询 HTTP handler
 * [POS]: Node 可导入的 Worker durable task seam
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { z } from 'zod'
import { FEEDBACK_TASK_TTL_MS, FeedbackTaskAcceptedSchema, FeedbackTaskRequestSchema, FeedbackTaskStatusSchema, type FeedbackTaskRequest, type FeedbackTaskStatus } from '../shared/feedback-task'
import type { Env } from './env'
import { errorJson, json, readJsonBody } from './http'
import { LIMITS } from './constants'
import { signFeedbackTaskCapability, verifyFeedbackTaskCapability, verifySessionToken, TokenError } from './tokens'
import type { FeedbackWorkflowParams } from './feedback-task-execute'

interface WorkflowInstance { id: string; status(): Promise<{ status: string; output?: unknown; error?: { message: string } }> }
export class FeedbackTaskError extends Error {
  readonly code: string
  readonly status: 400 | 410 | 500 | 503
  constructor(code: string, message: string, status: 400 | 410 | 500 | 503 = 410) { super(message); this.code = code; this.status = status }
}
export async function taskIdForFeedbackRequest(request: FeedbackTaskRequest): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(request)))
  return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, '0')).join('')
}
function pending(status: string): boolean { return ['queued', 'running', 'waiting', 'waitingForPause', 'complete'].includes(status) }
function isMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : ''
  return message.includes('not found') || message.includes('missing') || message.includes('does not exist')
}
async function proveExistingTask(env: Env, taskId: string, missingCode: string): Promise<void> {
  if (!env.FEEDBACK_TASK) throw new FeedbackTaskError('workflow_unconfigured', 'Feedback Workflow is not configured.', 503)
  try {
    const instance = await env.FEEDBACK_TASK.get(taskId)
    await instance.status()
  } catch (error) {
    if (isMissing(error)) throw new FeedbackTaskError(missingCode, 'Feedback task is no longer available.', 410)
    throw new FeedbackTaskError('workflow_unavailable', 'Feedback task status is temporarily unavailable.', 503)
  }
}
export function mapFeedbackWorkflowStatus(raw: { status: string; output?: unknown }): FeedbackTaskStatus {
  if (pending(raw.status)) {
    if (raw.status !== 'complete') return { status: 'pending' }
    const parsed = FeedbackTaskStatusSchema.safeParse(raw.output)
    return parsed.success ? parsed.data : { status: 'failed', error: { code: 'feedback_invalid_result', message: '反馈结果无效，请重试。' } }
  }
  return { status: 'failed', error: { code: 'feedback_generation_failed', message: '反馈生成失败，请稍后重试。' } }
}
export async function submitFeedbackTask(env: Env, request: FeedbackTaskRequest): Promise<{ taskToken: string; expiresAt: number }> {
  const parsed = FeedbackTaskRequestSchema.parse(request)
  const now = Date.now()
  const expiresAt = parsed.createdAt + FEEDBACK_TASK_TTL_MS
  if (parsed.createdAt > now + 60_000 || parsed.createdAt <= now - FEEDBACK_TASK_TTL_MS) throw new FeedbackTaskError('feedback_task_expired', 'Feedback task request is expired.')
  if (!env.FEEDBACK_TASK) throw new FeedbackTaskError('workflow_unconfigured', 'Feedback Workflow is not configured.', 503)
  let session: Awaited<ReturnType<typeof verifySessionToken>>
  let sessionExpired = false
  try {
    session = await verifySessionToken(env, parsed.payload.sessionToken)
  } catch (error) {
    if (!(error instanceof TokenError) || error.code !== 'token_expired') throw error
    sessionExpired = true
    try {
      session = await verifySessionToken(env, parsed.payload.sessionToken, parsed.createdAt)
    } catch (replayError) {
      if (replayError instanceof TokenError && replayError.code === 'token_expired') {
        throw new FeedbackTaskError('session_expired', 'Session credential has expired.', 410)
      }
      throw replayError
    }
  }
  const expectedOpeningPrompt = session.scenario.opening.speaker === 'assistant' ? session.scenario.opening.partnerLineJa : null
  if (parsed.kind === 'conversation' && (parsed.payload.turnRecords[0]?.partnerPromptJa !== expectedOpeningPrompt || parsed.payload.turnRecords.slice(1).some((record) => record.partnerPromptJa === null))) throw new FeedbackTaskError('scenario_context_mismatch', 'Feedback records do not match the real partner turns.', 400)
  if (parsed.kind === 'redo') {
    const expectedMissingPrompt = session.scenario.opening.speaker === 'user' && parsed.payload.turn === 1
    if ((parsed.payload.partnerPromptJa === null) !== expectedMissingPrompt || (parsed.payload.turn === 1 && expectedOpeningPrompt !== null && parsed.payload.partnerPromptJa !== expectedOpeningPrompt)) throw new FeedbackTaskError('scenario_context_mismatch', 'Redo feedback does not reference a real partner turn.', 400)
  }
  const taskId = await taskIdForFeedbackRequest(parsed)
  const taskToken = await signFeedbackTaskCapability(env, taskId, expiresAt)
  if (sessionExpired) {
    await proveExistingTask(env, taskId, 'session_expired')
    return { taskToken, expiresAt }
  }
  const params: FeedbackWorkflowParams = { request: parsed, scenario: session.scenario }
  try {
    await env.FEEDBACK_TASK.create({ id: taskId, params, retention: { successRetention: '1 day', errorRetention: '1 day' } })
  } catch {
    try {
      if (!env.FEEDBACK_TASK) throw new Error('workflow missing')
      const existing = await env.FEEDBACK_TASK.get(taskId)
      await existing.status()
    } catch {
      throw new FeedbackTaskError('workflow_unavailable', 'Feedback task is temporarily unavailable. Retry this request.', 503)
    }
  }
  return { taskToken, expiresAt }
}
export async function getFeedbackTaskStatus(env: Env, taskToken: string): Promise<FeedbackTaskStatus> {
  const capability = await verifyFeedbackTaskCapability(env, taskToken)
  if (!env.FEEDBACK_TASK) throw new FeedbackTaskError('workflow_unconfigured', 'Feedback Workflow is not configured.', 503)
  let instance: WorkflowInstance
  try { instance = await env.FEEDBACK_TASK.get(capability.taskId) } catch (error) {
    const msg = error instanceof Error ? error.message.toLowerCase() : ''
    if (msg.includes('not found') || msg.includes('missing') || msg.includes('does not exist')) throw new FeedbackTaskError('feedback_task_missing', 'Feedback task is no longer available.')
    throw new FeedbackTaskError('workflow_unavailable', 'Feedback task status is temporarily unavailable.', 503)
  }
  return mapFeedbackWorkflowStatus(await instance.status())
}
export async function handleFeedbackTaskPost(request: Request, env: Env): Promise<Response> {
  const body = await readJsonBody(request, LIMITS.requestBytes)
  try { return json(FeedbackTaskAcceptedSchema.parse(await submitFeedbackTask(env, FeedbackTaskRequestSchema.parse(body))), { status: 202 }) }
  catch (error) {
    if (error instanceof z.ZodError) return errorJson(400, 'invalid_feedback_task_request', 'Feedback task request is invalid.')
    if (error instanceof TokenError) return errorJson(error.code === 'token_secret_missing' ? 503 : 401, error.code, 'Session credential is invalid.')
    if (error instanceof FeedbackTaskError) return errorJson(error.status, error.code, error.message)
    return errorJson(503, 'workflow_unavailable', 'Feedback task is temporarily unavailable. Retry this request.')
  }
}
export async function handleFeedbackTaskGet(request: Request, env: Env): Promise<Response> {
  const match = (request.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i)
  if (!match) return errorJson(401, 'invalid_capability', 'Task capability is invalid.')
  try { return json(await getFeedbackTaskStatus(env, match[1]!)) }
  catch (error) {
    if (error instanceof TokenError) return errorJson(error.code === 'token_expired' ? 410 : 401, error.code, error.code === 'token_expired' ? 'Task capability has expired.' : 'Task capability is invalid.')
    if (error instanceof FeedbackTaskError) return errorJson(error.status, error.code, error.message)
    return errorJson(503, 'workflow_unavailable', 'Feedback task status is temporarily unavailable. Retry this request.')
  }
}
