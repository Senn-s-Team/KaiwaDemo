/**
 * [INPUT]: 依赖练习表现纯函数与会话报告构造器
 * [OUTPUT]: 验证评价引用、独立性归因与跨次比较边界
 * [POS]: tests/client 的练习表现契约测试
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { describe, expect, it } from 'vitest'
import { buildSessionReport, createRoundRecord } from '../../src/lib/metrics'
import { getPracticeScenarioKey, type PracticeAttempt, type StoredPracticeAttempt } from '../../src/lib/practice-history'
import { comparePracticeAttempts, summarizePracticeAttempt } from '../../src/lib/practice-progress'

function attempt(id = 'current', startedAt = 200): PracticeAttempt {
  const scenario: PracticeAttempt['scenario'] = {
    id: 'appointment', version: 1, titleZh: '改期', summaryZh: '改约时间', aiRole: '店员', userRole: '顾客',
    relationship: '初见', tone: '礼貌', opening: { speaker: 'assistant', partnerLineJa: 'ご希望は？', planZh: '询问需求' }, userGoal: '改期',
    coreGoal: { id: 'reschedule', titleZh: '改期', descriptionZh: '确认新时间' }, communicationFunction: '协商',
    initialFacts: [], partnerPrivateFacts: [], keyIntents: [], keyInformation: [],
    completionRules: { completed: [], partial: [], notCompleted: [] }, closingRules: [], maxTurns: 5,
    worldAnchors: [], followUpPrinciples: [], hintStrategy: '', feedbackFocus: [], safetyBoundary: '',
    evaluationVersion: 1, evidencePoints: [
      { id: 'request', titleZh: '说明需求', descriptionZh: '提出改期' },
      { id: 'confirm', titleZh: '确认时间', descriptionZh: '确认最终安排' },
    ],
  }
  const rounds = Array.from({ length: 5 }, (_, index) => {
    const round = createRoundRecord(index + 1, 'ご希望は？', 0)
    round.userFinal = index === 0 ? '予約を変更したいです。' : '金曜日でお願いします。'
    round.timing.audioCompletedAt = 10
    return round
  })
  return {
    scenario, practiceToken: 'signed-definition',
    report: buildSessionReport(id, 'real', { id: scenario.id, version: 1, variantId: id, reveal: { titleZh: '改期', summaryZh: '改约时间' } }, startedAt, startedAt + 100, rounds, []),
    feedback: {
      outcome: 'completed', outcomeEvidenceZh: '已确认', listeningFinding: null, expressionImprovement: null,
      redoTask: { turn: 1, partnerPromptJa: 'ご希望は？', firstConfirmedJa: rounds[0].userFinal, directionZh: '练习改期' },
      evaluationVersion: 1, evidenceResults: [
        { pointId: 'request', status: 'completed', evidence: [{ turn: 1, quoteJa: '予約を変更したいです。' }] },
        { pointId: 'confirm', status: 'completed', evidence: [{ turn: 5, quoteJa: '金曜日でお願いします。' }] },
      ],
    },
  }
}

function stored(value: PracticeAttempt): StoredPracticeAttempt {
  return { ...value, scenarioKey: getPracticeScenarioKey(value.scenario) }
}

describe('practice performance', () => {
  it('counts linked assistance and conservatively excludes earlier assistance from expression independence', () => {
    const value = attempt()
    value.report.rounds[1].expressionScaffoldLevel = 4
    value.report.rounds[4].ttsReplayCount = 1
    expect(summarizePracticeAttempt(value)).toMatchObject({
      total: 2, completed: 2, listeningIndependent: 1, expressionIndependent: 1, independenceUnknown: 1,
      observedAssistance: { listening: 1, expression: 0 }, validEvaluation: true,
    })
  })

  it('treats a user-opening first round without partner audio as observable rather than uncertain', () => {
    const value = attempt()
    value.scenario.opening = { speaker: 'user', planZh: '先说明改期请求。' }
    value.report.rounds[0]!.partnerPromptJa = null
    value.feedback!.redoTask.partnerPromptJa = null
    value.report.rounds[0]!.timing.audioCompletedAt = null
    expect(summarizePracticeAttempt(value)).toMatchObject({
      completed: 2,
      listeningIndependent: 2,
      expressionIndependent: 2,
      independenceUnknown: 0,
    })
  })

  it('counts displayed continuation suggestions as expression assistance only', () => {
    const value = attempt()
    value.report.rounds[0].speechAssistEvents = [{
      turn: 1, requestVersion: 1, observedTextJa: '予約', cleanedObservedTextJa: '予約',
      continuationSuggestionJa: '変更したいです。', displayed: true, latencyMs: 100, failureReason: null,
    }]
    expect(summarizePracticeAttempt(value)).toMatchObject({ expressionIndependent: 0, listeningIndependent: 2, independenceUnknown: 1, observedAssistance: { expression: 1 } })
    value.report.rounds[0].speechAssistEvents[0].continuationSuggestionJa = null
    expect(summarizePracticeAttempt(value).expressionIndependent).toBe(2)
    value.report.rounds[0].speechAssistEvents[0].displayed = false
    expect(summarizePracticeAttempt(value).expressionIndependent).toBe(2)
  })

  it.each(['text', 'edited', 'rerecord', 'failure', 'missing_audio'] as const)('marks %s evidence as uncertain instead of independent', (kind) => {
    const value = attempt()
    const round = value.report.rounds[0]
    if (kind === 'text') round.inputMode = 'text'
    if (kind === 'edited') round.transcriptModified = true
    if (kind === 'rerecord') round.rerecordCount = 1
    if (kind === 'failure') round.failureCount = 1
    if (kind === 'missing_audio') round.timing.audioCompletedAt = null
    expect(summarizePracticeAttempt(value)).toMatchObject({ completed: 2, listeningIndependent: 1, expressionIndependent: 1, independenceUnknown: 1 })
  })

  it('rejects invented quotes and does not count unobserved points as failed', () => {
    const value = attempt()
    value.feedback!.evidenceResults![0].evidence[0].quoteJa = '存在しない文章'
    value.feedback!.evidenceResults![1] = { pointId: 'confirm', status: 'not_observed', evidence: [] }
    expect(summarizePracticeAttempt(value)).toMatchObject({ completed: 0, notObserved: 1, insufficientEvidence: 1, validEvaluation: false })
  })

  it('does not count a partner quote as proof of independent user completion', () => {
    const value = attempt()
    const partnerPromptJa = value.report.rounds[0].partnerPromptJa
    if (partnerPromptJa === null) throw new Error('Assistant-opening fixture lost its partner prompt.')
    value.feedback!.evidenceResults![0].evidence[0].quoteJa = partnerPromptJa
    expect(summarizePracticeAttempt(value)).toMatchObject({ completed: 1, insufficientEvidence: 1, validEvaluation: false })
  })

  it('finds the earliest complete comparable attempt, ignoring incomplete and different definitions', () => {
    const current = attempt('current', 500)
    const incomplete = attempt('incomplete', 100)
    incomplete.report.rounds.pop()
    const changed = attempt('changed', 150)
    changed.scenario.partnerPrivateFacts = ['下午已满']
    const first = attempt('first', 200)
    const recent = attempt('recent', 400)
    const result = comparePracticeAttempts(current, [stored(recent), stored(incomplete), stored(changed), stored(first), stored(current)])
    expect(result.baselineAttempt?.report.sessionId).toBe('first')
    expect(result.baseline?.completed).toBe(2)
  })

  it('accepts an observed non-completion without a quotation, but excludes wholly unobservable evaluations', () => {
    const value = attempt()
    value.feedback!.evidenceResults![0] = { pointId: 'request', status: 'not_completed', evidence: [] }
    expect(summarizePracticeAttempt(value)).toMatchObject({ completed: 1, insufficientEvidence: 0, validEvaluation: true })
    value.feedback!.evidenceResults![0].status = 'insufficient_evidence'
    value.feedback!.evidenceResults![1] = { pointId: 'confirm', status: 'not_observed', evidence: [] }
    expect(summarizePracticeAttempt(value)).toMatchObject({ completed: 0, insufficientEvidence: 1, notObserved: 1, validEvaluation: false })
  })

  it('does not count a final-only quote as independent after an earlier full reference', () => {
    const value = attempt()
    value.report.rounds[0].expressionScaffoldLevel = 4
    expect(summarizePracticeAttempt(value)).toMatchObject({
      completed: 2, expressionIndependent: 0, listeningIndependent: 2,
      independenceUnknown: 1, observedAssistance: { expression: 1 },
    })
    value.report.rounds[4].transcriptModified = true
    expect(summarizePracticeAttempt(value).independenceUnknown).toBe(1)
  })

  it('does not compare mock sessions or sessions using different integration modes', () => {
    const current = attempt()
    const first = stored(attempt('first', 100))
    first.report.mode = 'partial'
    expect(comparePracticeAttempts(current, [first]).baseline).toBeNull()
    current.report.mode = 'mock'
    first.report.mode = 'mock'
    expect(comparePracticeAttempts(current, [first]).baseline).toBeNull()
  })

  it('does not compare missing, mismatched or malformed evaluation contracts', () => {
    const current = attempt()
    const first = stored(attempt('first', 100))
    current.feedback!.evaluationVersion = 2
    expect(comparePracticeAttempts(current, [first]).baseline).toBeNull()
    current.feedback!.evaluationVersion = 1
    current.feedback!.evidenceResults![1].pointId = 'request'
    expect(comparePracticeAttempts(current, [first]).baseline).toBeNull()
    delete current.scenario.evidencePoints
    expect(comparePracticeAttempts(current, [first]).baseline).toBeNull()
  })

  it('only compares grounded, complete, non-mock performance records with a matching runtime and version', () => {
    const current = attempt('current', 500)
    const first = stored(attempt('first', 100))
    const performance = {
      version: 1 as const,
      dimensions: {
        communicationAchievement: { rating: 2 as const, status: 'observed' as const, reasonZh: '完成主要诉求。', evidence: [{ turn: 1, role: 'user' as const, quoteJa: '予約を変更したいです。' }] },
        responseRelevance: { rating: 2 as const, status: 'observed' as const, reasonZh: '回应当前话题。', evidence: [{ turn: 1, role: 'user' as const, quoteJa: '予約を変更したいです。' }] },
        expressionClarity: { rating: 2 as const, status: 'observed' as const, reasonZh: '意思清楚。', evidence: [{ turn: 1, role: 'user' as const, quoteJa: '予約を変更したいです。' }] },
        clarificationRepair: { rating: null, status: 'not_needed' as const, reasonZh: '无需澄清。', evidence: [] },
      },
    }
    current.feedback!.performance = performance
    first.feedback!.performance = structuredClone(performance)
    expect(comparePracticeAttempts(current, [first]).performanceBaselineAttempt?.report.sessionId).toBe('first')
    first.report.mode = 'partial'
    expect(comparePracticeAttempts(current, [first]).performanceBaseline).toBeNull()
    first.report.mode = 'real'
    first.feedback!.performance!.dimensions.expressionClarity.rating = null
    first.feedback!.performance!.dimensions.expressionClarity.status = 'unobserved'
    expect(comparePracticeAttempts(current, [first]).performanceBaseline).toBeNull()
  })
})
