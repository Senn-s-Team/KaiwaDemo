/**
 * [INPUT]: zod 与反馈/重做 wire payload 字段
 * [OUTPUT]: 浏览器与 Worker 共用的 durable feedback task 严格契约
 * [POS]: 跨端反馈任务 schema 唯一来源；不依赖 worker runtime
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { z } from 'zod'

export const FEEDBACK_TASK_TTL_MS = 86_400_000

const InputModeSchema = z.enum(['stt', 'text'])
const ListeningScaffoldLevelSchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
const ExpressionScaffoldLevelSchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)])

export const FeedbackTurnRecordSchema = z.object({
  turn: z.number().int().min(1).max(5),
  partnerPromptJa: z.string().trim().min(1).max(120),
  userOriginal: z.string().max(600),
  userCleaned: z.string().max(600),
  userConfirmed: z.string().trim().min(1).max(600),
  inputMode: InputModeSchema,
  transcriptModified: z.boolean(),
  rerecordCount: z.number().int().nonnegative().max(50),
  partnerAudioPlayCount: z.number().int().nonnegative().max(100),
  ttsReplayCount: z.number().int().nonnegative().max(99),
  transcriptRevealed: z.boolean(),
  listeningScaffoldLevel: ListeningScaffoldLevelSchema,
  expressionScaffoldLevel: ExpressionScaffoldLevelSchema,
  failureCount: z.number().int().nonnegative().max(50),
  retryCount: z.number().int().nonnegative().max(50),
  textFallback: z.boolean(),
  speechAssistUsed: z.boolean(),
}).strict().superRefine((record, context) => {
  if (record.transcriptRevealed !== (record.listeningScaffoldLevel >= 3)) {
    context.addIssue({ code: 'custom', message: 'Transcript reveal must match listening scaffold level 3 or 4.' })
  }
  if (record.listeningScaffoldLevel === 1 && record.ttsReplayCount < 1) {
    context.addIssue({ code: 'custom', message: 'Listening scaffold level 1 requires a recorded replay.' })
  }
  if (!record.textFallback && record.partnerAudioPlayCount < 1) {
    context.addIssue({ code: 'custom', message: 'Audio-first rounds require at least one partner audio play.' })
  }
  if (record.textFallback && record.inputMode !== 'text') {
    context.addIssue({ code: 'custom', message: 'Text fallback rounds must record text input mode.' })
  }
})
export type FeedbackTurnRecord = z.infer<typeof FeedbackTurnRecordSchema>

export const ConversationFeedbackRequestSchema = z.object({
  scenarioType: z.literal('dynamic'),
  sessionToken: z.string().trim().min(1),
  turnRecords: z.array(FeedbackTurnRecordSchema).min(1).max(5),
}).strict().superRefine((request, context) => {
  request.turnRecords.forEach((record, index) => {
    if (record.turn !== index + 1) context.addIssue({ code: 'custom', message: `Turn record must be numbered ${index + 1}.` })
  })
})
export type ConversationFeedbackRequest = z.infer<typeof ConversationFeedbackRequestSchema>

const EvaluationTextSchema = z.string().trim().min(1).refine(
  value => !/(?:发音|声调|口音|语调|情绪|能力(?:水平|等级)|掌握|熟练度|肌肉记忆|発音|声調|アクセント|イントネーション|能力レベル|習得|マスター|筋肉記憶|\b(?:[1-9]\d?|100)分\b|★|⭐|星[1-5一二三四五]|得分)/.test(value),
  'Forbidden evaluation dimension in feedback output.',
)
const ChineseDirectionSchema = EvaluationTextSchema.refine(value => !/[ぁ-ゟ゠-ヿ]/.test(value), 'Redo direction must be Chinese guidance without Japanese words or sentences.')

export const ConversationFeedbackResponseSchema = z.object({
  evaluationVersion: z.number().int().positive().optional(),
  evidenceResults: z.array(z.object({
    pointId: z.string().trim().min(1),
    status: z.enum(['completed', 'not_completed', 'not_observed', 'insufficient_evidence']),
    evidence: z.array(z.object({ turn: z.number().int().min(1).max(5), quoteJa: z.string().trim().min(1) }).strict()).max(5),
  }).strict()).max(5).optional(),
  outcome: z.enum(['completed', 'partial', 'not_completed', 'insufficient_evidence']),
  outcomeEvidenceZh: EvaluationTextSchema,
  listeningFinding: z.object({
    turn: z.number().int().min(1).max(5), findingZh: EvaluationTextSchema, evidenceZh: EvaluationTextSchema,
  }).strict().nullable(),
  expressionImprovement: z.object({
    turn: z.number().int().min(1).max(5), userConfirmedJa: z.string().trim().min(1), suggestedJa: EvaluationTextSchema, reasonZh: EvaluationTextSchema,
  }).strict().nullable(),
  redoTask: z.object({
    turn: z.number().int().min(1).max(5), partnerPromptJa: z.string().trim().min(1), firstConfirmedJa: z.string().trim().min(1), directionZh: ChineseDirectionSchema,
  }).strict(),
}).strict()
export type ConversationFeedbackResponse = z.infer<typeof ConversationFeedbackResponseSchema>

export const RedoFeedbackRequestSchema = z.object({
  scenarioType: z.literal('dynamic'),
  sessionToken: z.string().trim().min(1),
  turn: z.number().int().min(1).max(5),
  partnerPromptJa: z.string().trim().min(1).max(120),
  firstConfirmedJa: z.string().trim().min(1).max(600),
  secondConfirmedJa: z.string().trim().min(1).max(600),
  secondInputMode: InputModeSchema,
  secondListeningScaffoldLevel: ListeningScaffoldLevelSchema,
  secondExpressionScaffoldLevel: ExpressionScaffoldLevelSchema,
}).strict()
export type RedoFeedbackRequest = z.infer<typeof RedoFeedbackRequestSchema>

export const RedoFeedbackResponseSchema = z.object({
  comparisonZh: EvaluationTextSchema,
  referenceExpressionJa: EvaluationTextSchema,
}).strict()
export type RedoFeedbackResponse = z.infer<typeof RedoFeedbackResponseSchema>

const TaskEnvelopeSchema = z.object({
  requestId: z.string().uuid(),
  createdAt: z.number().int().positive(),
}).strict()

export const FeedbackTaskRequestSchema = z.discriminatedUnion('kind', [
  TaskEnvelopeSchema.extend({ kind: z.literal('conversation'), payload: ConversationFeedbackRequestSchema }),
  TaskEnvelopeSchema.extend({ kind: z.literal('redo'), payload: RedoFeedbackRequestSchema }),
])
export type FeedbackTaskRequest = z.infer<typeof FeedbackTaskRequestSchema>

export const FeedbackTaskAcceptedSchema = z.object({ taskToken: z.string().min(1), expiresAt: z.number().int().positive() }).strict()
export type FeedbackTaskAccepted = z.infer<typeof FeedbackTaskAcceptedSchema>

const TaskErrorSchema = z.object({ code: z.string().min(1), message: z.string().min(1) }).strict()
export const FeedbackTaskStatusSchema = z.union([
  z.object({ status: z.literal('pending') }).strict(),
  z.object({ status: z.literal('failed'), error: TaskErrorSchema }).strict(),
  z.object({ status: z.literal('complete'), kind: z.literal('conversation'), result: ConversationFeedbackResponseSchema }).strict(),
  z.object({ status: z.literal('complete'), kind: z.literal('redo'), result: RedoFeedbackResponseSchema }).strict(),
])
export type FeedbackTaskStatus = z.infer<typeof FeedbackTaskStatusSchema>
