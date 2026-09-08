/**
 * [INPUT]: durable feedback request 与提交时已验签的场景快照
 * [OUTPUT]: 单次 conversation/redo feedback Workflow 结果
 * [POS]: Node 可导入的执行 seam；不引用 cloudflare:workers
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { DEADLINES } from './constants'
import { generateConversationFeedback, generateRedoFeedback, ScenarioDraftError } from './openai'
import { signSessionToken } from './tokens'
import type { Env } from './env'
import type { DynamicScenarioDefinition } from './types'
import type { FeedbackTaskRequest, FeedbackTaskStatus } from '../shared/feedback-task'

export interface FeedbackWorkflowParams { request: FeedbackTaskRequest; scenario: DynamicScenarioDefinition }

export async function executeFeedbackTask(env: Env, params: FeedbackWorkflowParams): Promise<FeedbackTaskStatus> {
  const sessionToken = await signSessionToken(env, { scenario: params.scenario, startedAt: Date.now(), expiresAt: Date.now() + 60_000 })
  const request = { ...params.request, payload: { ...params.request.payload, sessionToken } } as FeedbackTaskRequest
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort('feedback_timeout'), DEADLINES.feedbackWorkflowModelMs)
  try {
    if (request.kind === 'conversation') {
      const result = await generateConversationFeedback(env, request.payload, controller.signal)
      return { status: 'complete', kind: 'conversation', result }
    }
    const result = await generateRedoFeedback(env, request.payload, controller.signal)
    return { status: 'complete', kind: 'redo', result }
  } catch (error) {
    if (error instanceof ScenarioDraftError) {
      return { status: 'failed', error: { code: error.code, message: '反馈生成失败，请稍后重试。' } }
    }
    return { status: 'failed', error: { code: 'feedback_generation_failed', message: '反馈生成失败，请稍后重试。' } }
  } finally {
    clearTimeout(timer)
  }
}
