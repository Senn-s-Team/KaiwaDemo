/**
 * [INPUT]: 依赖场景草拟模型编排、默认模型配置与任务请求
 * [OUTPUT]: 对外提供单次无重试场景草拟执行函数，并记录不含输入、上游正文或凭据的失败诊断
 * [POS]: Workflow 与 Node 测试共用的纯执行 seam
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { draftScenario, ScenarioDraftError } from './openai'
import { DEFAULT_MODELS } from './constants'
import type { Env } from './env'
import type { ScenarioDraftTaskRequest } from '../shared/scenario-draft'
import type { ScenarioDraftWorkflowOutput } from './scenario-draft-workflow'

export async function executeScenarioDraftTask(env: Env, request: ScenarioDraftTaskRequest): Promise<ScenarioDraftWorkflowOutput> {
  const startedAt = Date.now()
  try {
    return await draftScenario(env, { inputZh: request.inputZh, clarifications: request.clarifications, forceGenerate: request.forceGenerate })
  } catch (error) {
    const code = error instanceof ScenarioDraftError ? error.code : 'scenario_draft_failed'
    console.error('scenario_draft_failed', {
      code,
      durationMs: Math.max(0, Date.now() - startedAt),
      model: env.OPENAI_MODEL || DEFAULT_MODELS.openai,
    })
    return { status: 'failed', error: { code, message: 'Scenario draft generation failed. Retry this request.' } }
  }
}
