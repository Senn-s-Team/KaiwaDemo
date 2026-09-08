/**
 * [INPUT]: 依赖 Cloudflare Workflow step、场景草拟模型编排与共享任务契约
 * [OUTPUT]: 对外提供 ScenarioDraftWorkflow 单步可恢复场景生成入口
 * [POS]: Worker workflow runtime seam，避免路由直接依赖 cloudflare runtime
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { WorkflowEntrypoint } from 'cloudflare:workers'
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers'
import { executeScenarioDraftTask } from './scenario-draft-execute'
import type { Env } from './env'
import type { ScenarioDraftModelResult } from './types'
import type { ScenarioDraftTaskRequest } from '../shared/scenario-draft'

export type ScenarioDraftWorkflowOutput = ScenarioDraftModelResult | { status: 'failed'; error: { code: string; message: string } }

export class ScenarioDraftWorkflow extends WorkflowEntrypoint<Env, ScenarioDraftTaskRequest> {

  async run(event: Readonly<WorkflowEvent<ScenarioDraftTaskRequest>>, step: WorkflowStep): Promise<ScenarioDraftWorkflowOutput> {
    return step.do('generate scenario draft', { retries: { limit: 0, delay: 1, backoff: 'constant' } }, async () => {
      return executeScenarioDraftTask(this.env, event.payload)
    })
  }
}
