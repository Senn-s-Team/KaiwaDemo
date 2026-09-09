/**
 * [INPUT]: 依赖 shared 技术验证 schema、会话绑定 telemetry token、D1 binding 与严格 Worker 环境契约
 * [OUTPUT]: 提供认证、原子且幂等的匿名验证批次写入，以及 180/365 天保留期清理
 * [POS]: Worker 的匿名技术验证可信边界，服务端只保存匿名客户端标识的 HMAC 派生值和固定事实
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { ValidationBatchSchema, type ValidationRecord } from '../shared/validation-telemetry'
import { errorJson, json, readJsonBody } from './http'
import { hashTelemetryClientId, verifyTelemetryToken } from './tokens'
import type { Env } from './env'

const MAX_BYTES = 32_768
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000
const DAY_MS = 24 * 60 * 60 * 1_000
const receiptSql = `INSERT OR IGNORE INTO validation_events
  (event_id, session_id, sequence, occurred_at, kind, stage, turn, event, failure_domain, failure_code, recoverable, recovered, latency_ms)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
const roundSql = `INSERT OR IGNORE INTO validation_rounds
  (event_id, session_id, sequence, occurred_at, turn, input_mode, listening_scaffold_level, expression_scaffold_level,
   speech_assist_displayed, transcript_modified, transcript_modification_count, rerecord_count, tts_replay_count,
   failure_count, retry_count, speech_start_latency_ms, stt_finalize_latency_ms, transcript_confirm_latency_ms,
   llm_first_text_latency_ms, llm_complete_latency_ms, tts_first_audio_latency_ms, round_wait_latency_ms, round_completed)
  SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
  WHERE EXISTS (SELECT 1 FROM validation_events WHERE event_id = ? AND session_id = ? AND kind = ?)`
const reviewSql = `INSERT OR IGNORE INTO validation_reviews
  (event_id, session_id, sequence, occurred_at, review_kind, turn, evaluation_version, model_version, prompt_version,
   outcome, improvement, citation_valid, model_human_agreement)
  SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? ,?
  WHERE EXISTS (SELECT 1 FROM validation_events WHERE event_id = ? AND session_id = ? AND kind = ?)`

export async function handleValidationBatch(request: Request, env: Env): Promise<Response> {
  const database = env.VALIDATION_DB
  if (!database) return errorJson(503, 'validation_unavailable', 'Validation telemetry is unavailable.')
  const parsed = ValidationBatchSchema.safeParse(await readJsonBody(request, MAX_BYTES))
  if (!parsed.success) return errorJson(400, 'invalid_validation_batch', 'Validation telemetry batch is invalid.')
  const batch = parsed.data
  await verifyTelemetryToken(env, batch.telemetryToken, batch.sessionId)
  const now = Date.now()
  const outsideWindow = batch.sentAt < now - MAX_AGE_MS || batch.sentAt > now + 300_000 || batch.records.some(record => record.occurredAt < now - MAX_AGE_MS || record.occurredAt > now + 300_000)
  if (outsideWindow) return errorJson(400, 'validation_batch_expired', 'Validation telemetry batch is outside the accepted time window.')
  const clientHash = await hashTelemetryClientId(env, batch.anonymousClientId)
  const statements: D1PreparedStatement[] = [
    database.prepare('INSERT OR IGNORE INTO validation_sessions (session_id, anonymous_client_hash, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)').bind(batch.sessionId, clientHash, batch.sentAt, batch.sentAt),
    database.prepare('UPDATE validation_sessions SET last_seen_at = MAX(last_seen_at, ?) WHERE session_id = ?').bind(batch.sentAt, batch.sessionId),
  ]
  for (const record of batch.records) statements.push(...recordStatements(database, batch.sessionId, record))
  await database.batch(statements)
  return json({ accepted: batch.records.length })
}

function recordStatements(database: D1Database, sessionId: string, record: ValidationRecord): D1PreparedStatement[] {
  const receipt = database.prepare(receiptSql).bind(
    record.eventId, sessionId, record.sequence, record.occurredAt, record.kind,
    record.kind === 'checkpoint' ? record.stage : null,
    record.kind === 'checkpoint' ? record.turn : null,
    record.kind === 'checkpoint' ? record.event : null,
    record.kind === 'checkpoint' ? record.failureDomain : null,
    record.kind === 'checkpoint' ? record.failureCode : null,
    record.kind === 'checkpoint' ? Number(record.recoverable) : null,
    record.kind === 'checkpoint' ? Number(record.recovered) : null,
    record.kind === 'checkpoint' ? record.latencyMs : null,
  )
  if (record.kind === 'checkpoint') return [receipt]
  if (record.kind === 'round_snapshot') {
    const detail = database.prepare(roundSql).bind(
      record.eventId, sessionId, record.sequence, record.occurredAt, record.turn, record.inputMode,
      record.listeningScaffoldLevel, record.expressionScaffoldLevel, Number(record.speechAssistDisplayed),
      Number(record.transcriptModified), record.transcriptModificationCount, record.rerecordCount,
      record.ttsReplayCount, record.failureCount, record.retryCount, record.speechStartLatencyMs,
      record.sttFinalizeLatencyMs, record.transcriptConfirmLatencyMs, record.llmFirstTextLatencyMs,
      record.llmCompleteLatencyMs, record.ttsFirstAudioLatencyMs, record.roundWaitLatencyMs,
      Number(record.roundCompleted), record.eventId, sessionId, record.kind,
    )
    return [receipt, detail]
  }
  if (record.kind === 'review_result') {
    const detail = database.prepare(reviewSql).bind(
      record.eventId, sessionId, record.sequence, record.occurredAt, record.reviewKind, record.turn,
      record.evaluationVersion, record.modelVersion, record.promptVersion, record.outcome, record.improvement,
      record.citationValid === null ? null : Number(record.citationValid),
      record.modelHumanAgreement === null ? null : Number(record.modelHumanAgreement),
      record.eventId, sessionId, record.kind,
    )
    return [receipt, detail]
  }
  const summarySql = `UPDATE validation_sessions SET last_seen_at = MAX(last_seen_at, ?), last_summary_sequence = ?, scenario_id = ?, scenario_version = ?, variant_id = ?, mode = ?, scenario_source = ?, practice_trigger = ?, device_class = ?, os_family = ?, browser_family = ?, browser_major = ?, network_class = ?, audio_device_class = ?, started_at = ?, ended_at = ?, duration_milliseconds = ?, last_stage = ?, completion_reason = ?, closed_naturally = MAX(COALESCE(closed_naturally, 0), ?), feedback_completed = MAX(COALESCE(feedback_completed, 0), ?), redo_started = MAX(COALESCE(redo_started, 0), ?), redo_completed = MAX(COALESCE(redo_completed, 0), ?), round_count = ?, failure_count = ?, retry_count = ?, text_fallback_count = ?, listening_scaffold_rounds_count = ?, expression_scaffold_rounds_count = ?, speech_assist_request_count = ?, speech_assist_displayed_count = ?, input_tokens = ?, output_tokens = ?, stt_audio_milliseconds = ?, llm_request_count = ?, tts_request_count = ?, tts_character_count = ? WHERE session_id = ? AND (last_summary_sequence IS NULL OR ? > last_summary_sequence) AND EXISTS (SELECT 1 FROM validation_events WHERE event_id = ? AND session_id = ? AND kind = ? AND sequence = ?)`
  const summary = database.prepare(summarySql).bind(
    record.occurredAt, record.sequence, record.scenarioId, record.scenarioVersion, record.variantId, record.mode,
    record.scenarioSource, record.practiceTrigger, record.deviceClass, record.osFamily, record.browserFamily,
    record.browserMajor, record.networkClass, record.audioDeviceClass, record.startedAt, record.endedAt,
    record.durationMilliseconds, record.lastStage, record.completionReason, Number(record.closedNaturally),
    Number(record.feedbackCompleted), Number(record.redoStarted), Number(record.redoCompleted), record.roundCount,
    record.failureCount, record.retryCount, record.textFallbackCount, record.listeningScaffoldRoundsCount,
    record.expressionScaffoldRoundsCount, record.speechAssistRequestCount, record.speechAssistDisplayedCount,
    record.inputTokens, record.outputTokens, record.sttAudioMilliseconds, record.llmRequestCount,
    record.ttsRequestCount, record.ttsCharacterCount, sessionId, record.sequence, record.eventId, sessionId, record.kind, record.sequence,
  )
  return [receipt, summary]
}

export async function runValidationRetention(env: Env, now = Date.now()): Promise<void> {
  const database = env.VALIDATION_DB
  if (!database) return
  await database.batch([
    database.prepare('DELETE FROM validation_reviews WHERE occurred_at < ?').bind(now - 180 * DAY_MS),
    database.prepare('DELETE FROM validation_rounds WHERE occurred_at < ?').bind(now - 180 * DAY_MS),
    database.prepare('DELETE FROM validation_events WHERE occurred_at < ?').bind(now - 180 * DAY_MS),
    database.prepare('DELETE FROM validation_sessions WHERE last_seen_at < ?').bind(now - 365 * DAY_MS),
  ])
}
