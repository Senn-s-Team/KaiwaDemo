/**
 * [INPUT]: 依赖 zod，对浏览器与 Worker 的匿名技术验证 wire contract 执行严格运行时校验
 * [OUTPUT]: 提供版本化会话批次、阶段检查点、回合快照、会话汇总、结构化复盘结果 schema 及推导类型
 * [POS]: shared 的隐私安全遥测边界，拒绝未知字段及对话、转写、音频和模型自由文本
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { z } from 'zod'

const positiveInteger = z.number().int().positive()
const nonnegativeInteger = z.number().int().nonnegative()
const uuid = z.string().uuid()
const commonRecordFields = {
  eventId: uuid,
  sequence: nonnegativeInteger,
  occurredAt: positiveInteger,
}

export const VALIDATION_SCHEMA_VERSION = 2 as const
export const ValidationStageSchema = z.enum([
  'home', 'scenario_input', 'scenario_preparing', 'scenario_ready', 'session_starting',
  'partner_audio', 'waiting_user', 'recording', 'transcript_finalizing', 'transcript_confirming',
  'partner_generating', 'partner_speaking', 'feedback_generating', 'feedback_ready',
  'redo_listening', 'redo_recording', 'redo_feedback', 'complete',
])
export const ValidationEventSchema = z.enum([
  'session_started', 'round_confirmed', 'round_completed', 'failure_occurred',
  'failure_recovered', 'feedback_completed', 'redo_started', 'redo_completed', 'session_completed',
])
export const ValidationFailureDomainSchema = z.enum([
  'permission', 'audio', 'stt', 'llm', 'tts', 'workflow', 'network', 'validation', 'storage', 'product_state',
])
export const ValidationScenarioSourceSchema = z.enum([
  'example', 'custom_text', 'custom_voice', 'recent_practice', 'completion_restart', 'unknown',
])
export const ValidationPracticeTriggerSchema = z.enum([
  'upcoming_real', 'recent_failure', 'general_practice', 'researcher_prompt', 'unknown',
])
export const ValidationDeviceClassSchema = z.enum(['phone', 'tablet', 'desktop'])
export const ValidationOsFamilySchema = z.enum(['android', 'ios', 'macos', 'windows', 'linux', 'other'])
export const ValidationBrowserFamilySchema = z.enum(['edge', 'chrome', 'firefox', 'safari', 'other'])
export const ValidationNetworkClassSchema = z.enum(['online', 'offline'])
export const ValidationAudioDeviceClassSchema = z.literal('unknown')
export const ValidationCompletionReasonSchema = z.enum(['turn_budget', 'user_exit', 'unrecoverable_failure'])
const opaqueIdentifierPattern = /^[A-Za-z0-9._:/-]+$/
export const ValidationFailureCodeSchema = z.enum(['config', 'scenario', 'token', 'stt', 'llm', 'tts', 'product_state'])

export const ValidationCheckpointRecordSchema = z.object({
  kind: z.literal('checkpoint'),
  ...commonRecordFields,
  stage: ValidationStageSchema,
  turn: z.number().int().min(1).max(5).nullable(),
  event: ValidationEventSchema,
  failureDomain: ValidationFailureDomainSchema.nullable(),
  failureCode: ValidationFailureCodeSchema.nullable(),
  recoverable: z.boolean(),
  recovered: z.boolean(),
  latencyMs: nonnegativeInteger.nullable(),
}).strict()

export const ValidationRoundSnapshotRecordSchema = z.object({
  kind: z.literal('round_snapshot'),
  ...commonRecordFields,
  turn: z.number().int().min(1).max(5),
  inputMode: z.enum(['stt', 'text']),
  listeningScaffoldLevel: z.number().int().min(0).max(4),
  expressionScaffoldLevel: z.number().int().min(0).max(4),
  speechAssistDisplayed: z.boolean(),
  transcriptModified: z.boolean(),
  transcriptModificationCount: nonnegativeInteger,
  rerecordCount: nonnegativeInteger,
  ttsReplayCount: nonnegativeInteger,
  failureCount: nonnegativeInteger,
  retryCount: nonnegativeInteger,
  speechStartLatencyMs: nonnegativeInteger.nullable(),
  sttFinalizeLatencyMs: nonnegativeInteger.nullable(),
  transcriptConfirmLatencyMs: nonnegativeInteger.nullable(),
  llmFirstTextLatencyMs: nonnegativeInteger.nullable(),
  llmCompleteLatencyMs: nonnegativeInteger.nullable(),
  ttsFirstAudioLatencyMs: nonnegativeInteger.nullable(),
  roundWaitLatencyMs: nonnegativeInteger.nullable(),
  roundCompleted: z.boolean(),
}).strict()

export const ValidationSessionSummaryRecordSchema = z.object({
  kind: z.literal('session_summary'),
  ...commonRecordFields,
  scenarioId: z.string().regex(opaqueIdentifierPattern).max(128),
  scenarioVersion: nonnegativeInteger,
  variantId: z.string().regex(opaqueIdentifierPattern).max(128),
  mode: z.enum(['real', 'mock', 'partial']),
  scenarioSource: ValidationScenarioSourceSchema,
  practiceTrigger: ValidationPracticeTriggerSchema,
  deviceClass: ValidationDeviceClassSchema,
  osFamily: ValidationOsFamilySchema,
  browserFamily: ValidationBrowserFamilySchema,
  browserMajor: nonnegativeInteger.max(999),
  networkClass: ValidationNetworkClassSchema,
  audioDeviceClass: ValidationAudioDeviceClassSchema,
  startedAt: positiveInteger,
  endedAt: positiveInteger,
  durationMilliseconds: nonnegativeInteger,
  lastStage: ValidationStageSchema,
  completionReason: ValidationCompletionReasonSchema,
  closedNaturally: z.boolean(),
  feedbackCompleted: z.boolean(),
  redoStarted: z.boolean(),
  redoCompleted: z.boolean(),
  roundCount: nonnegativeInteger,
  failureCount: nonnegativeInteger,
  retryCount: nonnegativeInteger,
  textFallbackCount: nonnegativeInteger,
  listeningScaffoldRoundsCount: nonnegativeInteger,
  expressionScaffoldRoundsCount: nonnegativeInteger,
  speechAssistRequestCount: nonnegativeInteger,
  speechAssistDisplayedCount: nonnegativeInteger,
  inputTokens: nonnegativeInteger.nullable(),
  outputTokens: nonnegativeInteger.nullable(),
  sttAudioMilliseconds: nonnegativeInteger,
  llmRequestCount: nonnegativeInteger,
  ttsRequestCount: nonnegativeInteger,
  ttsCharacterCount: nonnegativeInteger,
}).strict().superRefine((value, context) => {
  if (value.endedAt < value.startedAt) context.addIssue({ code: 'custom', path: ['endedAt'], message: 'endedAt before startedAt' })
  if (value.durationMilliseconds !== value.endedAt - value.startedAt) context.addIssue({ code: 'custom', path: ['durationMilliseconds'], message: 'duration mismatch' })
})

export const ValidationReviewResultRecordSchema = z.object({
  kind: z.literal('review_result'),
  ...commonRecordFields,
  reviewKind: z.enum(['conversation', 'redo']),
  turn: z.number().int().min(1).max(5).nullable(),
  evaluationVersion: z.string().regex(opaqueIdentifierPattern).max(64),
  modelVersion: z.string().regex(opaqueIdentifierPattern).max(128),
  promptVersion: z.string().regex(opaqueIdentifierPattern).max(64),
  outcome: z.enum(['completed', 'partial', 'not_completed', 'insufficient_evidence']).nullable(),
  improvement: z.enum(['improved', 'unchanged', 'regressed', 'not_assessed']).nullable(),
  citationValid: z.boolean().nullable(),
  modelHumanAgreement: z.boolean().nullable(),
}).strict().superRefine((value, context) => {
  if (value.reviewKind === 'conversation' && value.outcome === null) context.addIssue({ code: 'custom', path: ['outcome'], message: 'conversation outcome required' })
  if (value.reviewKind === 'redo' && (value.improvement === null || value.turn === null)) context.addIssue({ code: 'custom', path: ['improvement'], message: 'redo improvement and turn required' })
})

export const ValidationRecordSchema = z.discriminatedUnion('kind', [
  ValidationCheckpointRecordSchema,
  ValidationRoundSnapshotRecordSchema,
  ValidationSessionSummaryRecordSchema,
  ValidationReviewResultRecordSchema,
])

export const ValidationBatchSchema = z.object({
  schemaVersion: z.literal(VALIDATION_SCHEMA_VERSION),
  batchId: uuid,
  sessionId: z.string().regex(/^dyn_ses_[A-Za-z0-9_-]{1,55}$/),
  telemetryToken: z.string().min(1).max(2048),
  anonymousClientId: uuid,
  anonymousMetricsCollection: z.literal(true),
  sentAt: positiveInteger,
  records: z.array(ValidationRecordSchema).min(1).max(25),
}).strict()

export type ValidationStage = z.infer<typeof ValidationStageSchema>
export type ValidationEvent = z.infer<typeof ValidationEventSchema>
export type ValidationFailureDomain = z.infer<typeof ValidationFailureDomainSchema>
export type ValidationScenarioSource = z.infer<typeof ValidationScenarioSourceSchema>
export type ValidationPracticeTrigger = z.infer<typeof ValidationPracticeTriggerSchema>
export type ValidationDeviceClass = z.infer<typeof ValidationDeviceClassSchema>
export type ValidationOsFamily = z.infer<typeof ValidationOsFamilySchema>
export type ValidationBrowserFamily = z.infer<typeof ValidationBrowserFamilySchema>
export type ValidationNetworkClass = z.infer<typeof ValidationNetworkClassSchema>
export type ValidationAudioDeviceClass = z.infer<typeof ValidationAudioDeviceClassSchema>
export type ValidationCompletionReason = z.infer<typeof ValidationCompletionReasonSchema>
export type ValidationCheckpointRecord = z.infer<typeof ValidationCheckpointRecordSchema>
export type ValidationRoundSnapshotRecord = z.infer<typeof ValidationRoundSnapshotRecordSchema>
export type ValidationSessionSummaryRecord = z.infer<typeof ValidationSessionSummaryRecordSchema>
export type ValidationReviewResultRecord = z.infer<typeof ValidationReviewResultRecordSchema>
export type ValidationRecord = z.infer<typeof ValidationRecordSchema>
export type ValidationFailureCode = z.infer<typeof ValidationFailureCodeSchema>
export type ValidationBatch = z.infer<typeof ValidationBatchSchema>
