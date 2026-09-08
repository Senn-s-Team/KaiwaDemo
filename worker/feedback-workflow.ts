/**
 * [INPUT]: Cloudflare Workflow runtime 与反馈执行 seam
 * [OUTPUT]: FeedbackWorkflow 单步、无自动重试的 durable 执行入口
 * [POS]: runtime-only Worker Workflow 边界
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { WorkflowEntrypoint } from 'cloudflare:workers'
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers'
import { executeFeedbackTask, type FeedbackWorkflowParams } from './feedback-task-execute'
import type { Env } from './env'
import type { FeedbackTaskStatus } from '../shared/feedback-task'

export class FeedbackWorkflow extends WorkflowEntrypoint<Env, FeedbackWorkflowParams> {
  async run(event: Readonly<WorkflowEvent<FeedbackWorkflowParams>>, step: WorkflowStep): Promise<FeedbackTaskStatus> {
    return step.do('generate feedback', { retries: { limit: 0, delay: 1, backoff: 'constant' } }, async () => executeFeedbackTask(this.env, event.payload))
  }
}
