/**
 * [INPUT]: 依赖 zod 定义场景草拟任务请求、结果与状态线协议
 * [OUTPUT]: 对外提供场景草拟任务严格 schema、推导类型及 TTL 常量
 * [POS]: shared 的场景草拟 wire contract 唯一来源，供浏览器与 Worker 使用
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { z } from 'zod'

export const SCENARIO_DRAFT_TASK_TTL_MS = 86_400_000

const TrainingGoalSchema = z.object({
  id: z.string().trim().min(1).max(64), titleZh: z.string().trim().min(1).max(80), descriptionZh: z.string().trim().min(1).max(240),
}).strict()

export const DynamicScenarioDefinitionSchema = z.object({
  id: z.string().trim().min(1).max(64), version: z.number().int().positive(), evaluationVersion: z.number().int().positive().optional(),
  evidencePoints: z.array(TrainingGoalSchema).min(1).max(5).refine(points => new Set(points.map(p => p.id)).size === points.length).optional(),
  titleZh: z.string().trim().min(1).max(100), summaryZh: z.string().trim().min(1).max(300), aiRole: z.string().trim().min(1).max(160), userRole: z.string().trim().min(1).max(160), relationship: z.string().trim().min(1).max(160), tone: z.string().trim().min(1).max(100), firstLine: z.string().trim().min(1).max(120), userGoal: z.string().trim().min(1).max(240), coreGoal: TrainingGoalSchema, communicationFunction: z.string().trim().min(1).max(300),
  initialFacts: z.array(z.string().trim().min(1).max(240)).min(1).max(8), partnerPrivateFacts: z.array(z.string().trim().min(1).max(240)).max(8), keyIntents: z.array(z.string().trim().min(1).max(160)).min(1).max(6), keyInformation: z.array(z.string().trim().min(1).max(240)).min(1).max(8),
  completionRules: z.object({ completed: z.array(z.string().trim().min(1).max(240)).min(1).max(6), partial: z.array(z.string().trim().min(1).max(240)).min(1).max(6), notCompleted: z.array(z.string().trim().min(1).max(240)).min(1).max(6) }).strict(), closingRules: z.array(z.string().trim().min(1).max(240)).min(1).max(5), maxTurns: z.literal(5), partnerOpeningPlan: z.string().trim().min(1).max(300), worldAnchors: z.array(z.string().trim().min(1).max(240)).min(1).max(6), followUpPrinciples: z.array(z.string().trim().min(1).max(240)).min(1).max(5), hintStrategy: z.string().trim().min(1).max(300), feedbackFocus: z.array(z.string().trim().min(1).max(160)).min(1).max(5), safetyBoundary: z.string().trim().min(1).max(300),
}).strict().refine(scenario => (scenario.evaluationVersion === undefined) === (scenario.evidencePoints === undefined), 'Evaluation version and evidence points must be provided together.')

const ClarificationSchema = z.object({ questionZh: z.string().trim().min(1).max(120), answerZh: z.string().trim().min(1).max(300) }).strict()
export const ScenarioDraftTaskRequestSchema = z.object({ requestId: z.string().uuid(), createdAt: z.number().int().positive(), inputZh: z.string().trim().min(1).max(300), clarifications: z.array(ClarificationSchema).max(1), forceGenerate: z.boolean().default(false) }).strict()
export type ScenarioDraftTaskRequest = z.infer<typeof ScenarioDraftTaskRequestSchema>

export const ScenarioDraftTaskAcceptedSchema = z.object({ taskToken: z.string().min(1), expiresAt: z.number().int().positive() }).strict()
export type ScenarioDraftTaskAccepted = z.infer<typeof ScenarioDraftTaskAcceptedSchema>

export const ScenarioDraftModelResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('needs_clarification'), questionZh: z.string().trim().min(1).max(120), optionsZh: z.array(z.string().trim().min(1).max(120)).min(2).max(4) }).strict(),
  z.object({ status: z.literal('ready'), scenario: DynamicScenarioDefinitionSchema.refine(scenario => Boolean(scenario.evaluationVersion && scenario.evidencePoints), 'New scenarios require versioned evidence points.') }).strict(),
])
const ScenarioDraftResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('needs_clarification'), questionZh: z.string().trim().min(1).max(120), optionsZh: z.array(z.string().trim().min(1).max(120)).min(2).max(4) }).strict(),
  z.object({ status: z.literal('ready'), scenario: DynamicScenarioDefinitionSchema, scenarioToken: z.string().min(1), practiceToken: z.string().min(1).optional() }).strict(),
])
export type ScenarioDraftResponse = z.infer<typeof ScenarioDraftResponseSchema>
export const ScenarioDraftTaskStatusSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }).strict(), z.object({ status: z.literal('complete'), result: ScenarioDraftResponseSchema }).strict(), z.object({ status: z.literal('failed'), error: z.object({ code: z.string().min(1), message: z.string().min(1) }).strict() }).strict(),
])
export type ScenarioDraftTaskStatus = z.infer<typeof ScenarioDraftTaskStatusSchema>
