/**
 * [INPUT]: 依赖 shared 场景草拟请求类型，以及 Cloudflare Worker 注入的 secrets、模型配置、Workflow 与 D1 binding
 * [OUTPUT]: 提供 Env 配置接口，定义场景草拟、反馈任务和匿名验证持久化的运行时边界
 * [POS]: Worker runtime 配置契约，集中连接短期任务 Workflow 与可选 VALIDATION_DB
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import type { ScenarioDraftTaskRequest } from '../shared/scenario-draft'

interface ScenarioDraftWorkflowInstance {
  id: string
  status(): Promise<{ status: string; output?: unknown; error?: { message: string } }>
}
interface ScenarioDraftWorkflowBinding {
  create(options: { id?: string; params?: ScenarioDraftTaskRequest; retention?: unknown }): Promise<ScenarioDraftWorkflowInstance>
  get(id: string): Promise<ScenarioDraftWorkflowInstance>
}
interface FeedbackWorkflowBinding {
  create(options: { id?: string; params?: unknown; retention?: unknown }): Promise<ScenarioDraftWorkflowInstance>
  get(id: string): Promise<ScenarioDraftWorkflowInstance>
}
export interface Env {
  ELEVENLABS_API_KEY?: string
  ELEVENLABS_VOICE_ID?: string
  ELEVENLABS_STT_MODEL?: string
  ELEVENLABS_TTS_MODEL?: string
  OPENAI_API_KEY?: string
  OPENAI_BASE_URL?: string
  OPENAI_MODEL?: string
  SCENARIO_SIGNING_SECRET?: string
  ALLOW_MOCK?: string
  SCENARIO_DRAFT?: ScenarioDraftWorkflowBinding
  FEEDBACK_TASK?: FeedbackWorkflowBinding
  VALIDATION_DB?: D1Database
}
