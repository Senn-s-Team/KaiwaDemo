/**
 * [INPUT]: 依赖 ../shared/scenario-draft 的 ScenarioDraftTaskRequest 类型，以及 Cloudflare Worker 注入的 secrets、模型配置和 Workflow binding
 * [OUTPUT]: 对外导出 Env 配置接口；定义 SCENARIO_DRAFT 与 FEEDBACK_TASK 的创建、查询及任务参数边界
 * [POS]: Worker runtime 配置契约，连接 shared 场景草拟请求与两个 durable task Workflow，并集中声明可选部署配置
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
}
