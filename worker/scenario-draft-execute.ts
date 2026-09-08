/**
 * [INPUT]: 依赖场景草拟模型编排与任务请求
 * [OUTPUT]: 对外提供单次无重试场景草拟执行函数
 * [POS]: Workflow 与 Node 测试共用的纯执行 seam
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { draftScenario, ScenarioDraftError } from './openai'
import type { Env } from './env'
import type { ScenarioDraftTaskRequest } from '../shared/scenario-draft'
import type { ScenarioDraftWorkflowOutput } from './scenario-draft-workflow'

export async function executeScenarioDraftTask(env: Env, request: ScenarioDraftTaskRequest): Promise<ScenarioDraftWorkflowOutput> {
  try {
    return await draftScenario(env, { inputZh: request.inputZh, clarifications: request.clarifications, forceGenerate: request.forceGenerate })
  } catch (error) {
    if (error instanceof ScenarioDraftError) return { status: 'failed', error: { code: error.code, message: 'Scenario draft generation failed. Retry this request.' } }
    return { status: 'failed', error: { code: 'scenario_draft_failed', message: 'Scenario draft generation failed. Retry this request.' } }
  }
}
