/**
 * [INPUT]: 依赖 shared 技术验证 schema、token HMAC 与 D1 handler
 * [OUTPUT]: 验证严格性、认证、原子持久化、幂等性、单调汇总和保留期的可执行覆盖
 * [POS]: Worker 遥测可信边界的回归测试
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { describe, expect, it } from 'vitest'
import { ValidationAudioDeviceClassSchema, ValidationBatchSchema, ValidationCheckpointRecordSchema, ValidationCompletionReasonSchema, ValidationDeviceClassSchema, ValidationBrowserFamilySchema, type ValidationBatch } from '../../shared/validation-telemetry'
import { handleValidationBatch, runValidationRetention } from '../../worker/validation-telemetry'
import { hashTelemetryClientId, signTelemetryToken, verifyTelemetryToken } from '../../worker/tokens'

const env = { SCENARIO_SIGNING_SECRET: 'telemetry-test-secret' }
const sessionId = 'dyn_ses_1234567890abcdef'
const clientId = '00000000-0000-4000-8000-000000000003'
const summaryEndedAt = Date.now()
const checkpoint = (sequence: number) => ({ kind: 'checkpoint' as const, eventId: `00000000-0000-4000-8000-${String(sequence + 1).padStart(12, '0')}`, sequence, occurredAt: Date.now(), stage: 'session_starting' as const, turn: null, event: 'session_started' as const, failureDomain: null, failureCode: null, recoverable: false, recovered: false, latencyMs: null })
const roundSnapshot = { kind: 'round_snapshot' as const, eventId: '00000000-0000-4000-8000-000000000010', sequence: 10, occurredAt: Date.now(), turn: 1, inputMode: 'text' as const, listeningScaffoldLevel: 0, expressionScaffoldLevel: 1, speechAssistDisplayed: false, transcriptModified: false, transcriptModificationCount: 0, rerecordCount: 0, ttsReplayCount: 0, failureCount: 0, retryCount: 0, speechStartLatencyMs: null, sttFinalizeLatencyMs: null, transcriptConfirmLatencyMs: 10, llmFirstTextLatencyMs: 20, llmCompleteLatencyMs: 30, ttsFirstAudioLatencyMs: null, roundWaitLatencyMs: 40, roundCompleted: true }
const reviewResult = { kind: 'review_result' as const, eventId: '00000000-0000-4000-8000-000000000011', sequence: 11, occurredAt: Date.now(), reviewKind: 'conversation' as const, turn: 1, evaluationVersion: 'eval-1', modelVersion: 'model-1', promptVersion: 'prompt-1', outcome: 'completed' as const, improvement: null, citationValid: true, modelHumanAgreement: null }
const sessionSummary = { kind: 'session_summary' as const, eventId: '00000000-0000-4000-8000-000000000012', sequence: 12, occurredAt: summaryEndedAt, scenarioId: 'scenario-1', scenarioVersion: 1, variantId: 'variant-1', mode: 'real' as const, scenarioSource: 'unknown' as const, practiceTrigger: 'unknown' as const, deviceClass: 'desktop' as const, osFamily: 'linux' as const, browserFamily: 'chrome' as const, browserMajor: 1, networkClass: 'online' as const, audioDeviceClass: 'unknown' as const, startedAt: summaryEndedAt - 1000, endedAt: summaryEndedAt, durationMilliseconds: 1000, lastStage: 'complete' as const, completionReason: 'turn_budget' as const, closedNaturally: true, feedbackCompleted: true, redoStarted: false, redoCompleted: false, roundCount: 1, failureCount: 0, retryCount: 0, textFallbackCount: 0, listeningScaffoldRoundsCount: 0, expressionScaffoldRoundsCount: 1, speechAssistRequestCount: 0, speechAssistDisplayedCount: 0, inputTokens: 10, outputTokens: 20, sttAudioMilliseconds: 0, llmRequestCount: 1, ttsRequestCount: 0, ttsCharacterCount: 0 }

function fakeDatabase() {
  const prepared: Array<{ sql: string; binds: unknown[] }> = []
  const batches: unknown[][] = []
  const database = { prepare(sql: string) { const statement = { sql, binds: [] as unknown[], bind(...values: unknown[]) { statement.binds = values; prepared.push({ sql, binds: values }); return statement } }; return statement }, async batch(statements: unknown[]) { batches.push(statements) } }
  return { database: database as unknown as D1Database, prepared, batches }
}
async function makeBatch(records: ValidationBatch['records']): Promise<ValidationBatch> { return { schemaVersion: 2, batchId: crypto.randomUUID(), sessionId, telemetryToken: await signTelemetryToken(env, sessionId), anonymousClientId: clientId, anonymousMetricsCollection: true, sentAt: Date.now(), records } as ValidationBatch }
function request(batch: ValidationBatch): Request { return new Request('https://kaiwa.example/api/validation/batch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(batch) }) }

describe('validation telemetry schema', () => {
  it('rejects dialogue, text, and unknown fields', () => {
    expect(ValidationCheckpointRecordSchema.safeParse({ ...checkpoint(0), dialogue: '私の会話' }).success).toBe(false)
    expect(ValidationCheckpointRecordSchema.safeParse({ ...checkpoint(0), text: 'raw text' }).success).toBe(false)
    expect(ValidationCheckpointRecordSchema.safeParse({ ...checkpoint(0), failureCode: '会泄漏' }).success).toBe(false)
    expect(ValidationDeviceClassSchema.safeParse('手机').success).toBe(false)
    expect(ValidationBrowserFamilySchema.safeParse('浏览器').success).toBe(false)
    expect(ValidationAudioDeviceClassSchema.safeParse('耳机').success).toBe(false)
    expect(ValidationCompletionReasonSchema.safeParse('completed').success).toBe(false)
    expect(ValidationCompletionReasonSchema.safeParse('turn_budget').success).toBe(true)
    expect(ValidationCompletionReasonSchema.safeParse('user_exit').success).toBe(true)
    expect(ValidationCompletionReasonSchema.safeParse('unrecoverable_failure').success).toBe(true)
    expect(ValidationBatchSchema.safeParse({ schemaVersion: 2, batchId: crypto.randomUUID(), sessionId, telemetryToken: 'token', anonymousClientId: clientId, anonymousMetricsCollection: true, sentAt: Date.now(), records: [{ ...sessionSummary, scenarioId: '含中文', variantId: 'v', completionReason: 'turn_budget' }] }).success).toBe(false)
  })
  it('enforces collection flag, UUID identity, and 25-record bound', () => {
    const base = { schemaVersion: 2, batchId: crypto.randomUUID(), sessionId, telemetryToken: 'token', anonymousClientId: clientId, anonymousMetricsCollection: true, sentAt: Date.now(), records: [checkpoint(0)] }
    expect(ValidationBatchSchema.safeParse(base).success).toBe(true)
    expect(ValidationBatchSchema.safeParse({ ...base, anonymousMetricsCollection: false }).success).toBe(false)
    expect(ValidationBatchSchema.safeParse({ ...base, anonymousClientId: 'not-a-uuid' }).success).toBe(false)
    expect(ValidationBatchSchema.safeParse({ ...base, records: Array.from({ length: 26 }, (_, index) => checkpoint(index)) }).success).toBe(false)
  })
})
describe('telemetry credentials', () => {
  it('binds sessions and authenticates a seven-day-old batch', async () => {
    const issuedAt = Date.now() - 7 * 24 * 60 * 60 * 1_000
    const token = await signTelemetryToken(env, sessionId, issuedAt)
    await expect(verifyTelemetryToken(env, token, sessionId, Date.now())).resolves.toMatchObject({ sessionId })
    await expect(verifyTelemetryToken(env, token, 'dyn_ses_other')).rejects.toMatchObject({ code: 'token_claims_invalid' })
    expect(await hashTelemetryClientId(env, clientId)).not.toBe(clientId)
  })
})
describe('D1 telemetry persistence', () => {
  it('uses one atomic batch with session activity, receipt, child, and summary guards', async () => {
    const fake = fakeDatabase()
    const response = await handleValidationBatch(request(await makeBatch([checkpoint(0), roundSnapshot, reviewResult, sessionSummary])), { ...env, VALIDATION_DB: fake.database })
    expect(response.status).toBe(200)
    expect(fake.batches).toHaveLength(1)
    expect(fake.prepared.some(item => item.sql.includes('INSERT OR IGNORE INTO validation_sessions'))).toBe(true)
    expect(fake.prepared.some(item => item.sql.includes('UPDATE validation_sessions SET last_seen_at'))).toBe(true)
    expect(fake.prepared.filter(item => item.sql.includes('EXISTS (SELECT 1 FROM validation_events')).length).toBe(3)
    const summary = fake.prepared.find(item => item.sql.includes('scenario_id = ?'))
    expect(summary?.sql).toContain('MAX(last_seen_at, ?)')
    expect(summary?.sql).toContain('event_id = ? AND session_id = ? AND kind = ?')
    expect(summary?.sql).toContain('last_summary_sequence = ?')
    expect(summary?.sql).toContain('(last_summary_sequence IS NULL OR ? > last_summary_sequence)')
    expect(summary?.sql).toContain('AND sequence = ?')
    expect(summary?.sql).toContain('feedback_completed = MAX(COALESCE(feedback_completed, 0), ?)')
    expect(summary?.sql).toContain('redo_started = MAX(COALESCE(redo_started, 0), ?)')
    expect(summary?.sql).toContain('redo_completed = MAX(COALESCE(redo_completed, 0), ?)')
  })
  it('keeps 25 records in one atomic batch', async () => {
    const fake = fakeDatabase()
    const response = await handleValidationBatch(request(await makeBatch(Array.from({ length: 25 }, (_, index) => checkpoint(index)))), { ...env, VALIDATION_DB: fake.database })
    expect(response.status).toBe(200)
    expect(fake.batches).toHaveLength(1)
    expect(fake.batches[0]).toHaveLength(27)
  })
  it('rejects missing binding and an expired batch', async () => {
    const batch = await makeBatch([checkpoint(0)])
    expect((await handleValidationBatch(request(batch), env)).status).toBe(503)
    expect((await handleValidationBatch(request({ ...batch, sentAt: Date.now() - 8 * 24 * 60 * 60 * 1_000 }), { ...env, VALIDATION_DB: fakeDatabase().database })).status).toBe(400)
  })
})
describe('telemetry retention', () => {
  it('deletes reviews, rounds, events at 180 days and sessions at 365 days', async () => {
    const fake = fakeDatabase(); const now = 1_900_000_000_000
    await runValidationRetention({ ...env, VALIDATION_DB: fake.database }, now)
    expect(fake.batches).toHaveLength(1)
    expect(fake.batches[0]).toHaveLength(4)
    expect(fake.prepared.map(item => item.sql)).toEqual(expect.arrayContaining(['DELETE FROM validation_reviews WHERE occurred_at < ?', 'DELETE FROM validation_rounds WHERE occurred_at < ?', 'DELETE FROM validation_events WHERE occurred_at < ?', 'DELETE FROM validation_sessions WHERE last_seen_at < ?']))
    expect(fake.prepared.map(item => item.binds[0])).toContain(now - 180 * 24 * 60 * 60 * 1_000)
    expect(fake.prepared.map(item => item.binds[0])).toContain(now - 365 * 24 * 60 * 60 * 1_000)
  })
})
