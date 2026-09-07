/**
 * [INPUT]: 依赖场景证据标准、会话回合与反馈引用，以及本机历史记录
 * [OUTPUT]: 提供基于真实引用的表现事实及同场景首次有效练习对比，不生成能力分数
 * [POS]: src/lib 的保守评价纯函数，隔离模型结论与程序可观察的帮助事实
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import type { RoundRecord } from '../types'
import { getPracticeScenarioKey, type PracticeAttempt, type StoredPracticeAttempt } from './practice-history'

export interface PracticePerformance {
  total: number
  completed: number
  notObserved: number
  insufficientEvidence: number
  listeningIndependent: number
  expressionIndependent: number
  independenceUnknown: number
  observedAssistance: { listening: number; expression: number }
  evidence: { turn: number; quoteJa: string }[]
  validEvaluation: boolean
}

function expressionHelpUsed(round: RoundRecord): boolean {
  return round.expressionScaffoldLevel > 0
    || round.speechAssistEvents.some((event) => event.displayed && event.continuationSuggestionJa !== null)
}

function uncertainRound(round: RoundRecord): boolean {
  return round.inputMode !== 'stt' || round.transcriptModified || round.transcriptModificationCount > 0
    || round.rerecordCount > 0 || round.failureCount > 0 || round.retryCount > 0
    || round.timing.audioCompletedAt === null
}

export function summarizePracticeAttempt(attempt: PracticeAttempt): PracticePerformance {
  const points = attempt.scenario.evidencePoints ?? []
  const feedback = attempt.feedback
  const results = feedback?.evidenceResults ?? []
  const versionMatches = typeof attempt.scenario.evaluationVersion === 'number'
    && feedback?.evaluationVersion === attempt.scenario.evaluationVersion
  const summary: PracticePerformance = {
    total: points.length, completed: 0, notObserved: 0, insufficientEvidence: 0,
    listeningIndependent: 0, expressionIndependent: 0, independenceUnknown: 0,
    observedAssistance: { listening: 0, expression: 0 }, evidence: [],
    validEvaluation: versionMatches && points.length > 0 && results.length === points.length
      && new Set(results.map((result) => result.pointId)).size === points.length,
  }
  for (const point of points) {
    const result = versionMatches ? results.find((item) => item.pointId === point.id) : undefined
    if (!result || result.status === 'insufficient_evidence') {
      summary.insufficientEvidence++
      if (!result) summary.validEvaluation = false
      continue
    }
    if (result.status === 'not_observed') { summary.notObserved++; continue }
    const linked = result.evidence.map((evidence) => ({
      evidence,
      round: attempt.report.rounds.find((round) => round.turn === evidence.turn),
    }))
    const hasValidEvidence = (result.status !== 'completed' || linked.length > 0) && linked.every(({ round, evidence }) =>
      round && evidence.quoteJa.trim().length > 0 && round.userFinal.includes(evidence.quoteJa))
    if (!hasValidEvidence) {
      summary.insufficientEvidence++
      summary.validEvaluation = false
      continue
    }
    if (result.status !== 'completed') continue
    summary.completed++
    const rounds = linked.map(({ round }) => round!)
    summary.evidence.push(...linked.map(({ evidence }) => evidence))
    const listeningHelp = rounds.some((round) => round.listeningScaffoldLevel > 0 || round.transcriptRevealed || round.ttsReplayCount > 0)
    const expressionHelp = rounds.some(expressionHelpUsed)
    const latestEvidenceTurn = Math.max(...rounds.map((round) => round.turn))
    const priorExpressionHelp = attempt.report.rounds.some((round) => round.turn < latestEvidenceTurn && expressionHelpUsed(round))
    if (listeningHelp) summary.observedAssistance.listening++
    if (expressionHelp) summary.observedAssistance.expression++
    if (rounds.some(uncertainRound)) { summary.independenceUnknown++; continue }
    if (!listeningHelp) summary.listeningIndependent++
    if (!expressionHelp && !priorExpressionHelp) summary.expressionIndependent++
    else if (!expressionHelp && priorExpressionHelp) summary.independenceUnknown++
  }
  summary.validEvaluation = summary.validEvaluation
    && summary.total - summary.notObserved - summary.insufficientEvidence > 0
  return summary
}

function completeAttempt(attempt: PracticeAttempt): boolean {
  return attempt.report.rounds.length === attempt.scenario.maxTurns
    && attempt.report.completion.finalTurn === attempt.scenario.maxTurns
    && new Set(attempt.report.rounds.map((round) => round.turn)).size === attempt.scenario.maxTurns
    && attempt.report.rounds.every((round) => round.userFinal.trim().length > 0)
}

export function comparePracticeAttempts(current: PracticeAttempt, history: readonly StoredPracticeAttempt[]): {
  current: PracticePerformance
  baseline: PracticePerformance | null
  baselineAttempt: StoredPracticeAttempt | null
} {
  const performance = summarizePracticeAttempt(current)
  const key = getPracticeScenarioKey(current.scenario)
  const baselineAttempt = current.report.mode !== 'mock' && performance.validEvaluation && completeAttempt(current)
    ? [...history].sort((a, b) => a.report.startedAt - b.report.startedAt).find((attempt) =>
      attempt.report.mode === current.report.mode
      && attempt.report.sessionId !== current.report.sessionId
      && attempt.report.startedAt < current.report.startedAt
      && getPracticeScenarioKey(attempt.scenario) === key
      && completeAttempt(attempt) && summarizePracticeAttempt(attempt).validEvaluation) ?? null
    : null
  return { current: performance, baseline: baselineAttempt ? summarizePracticeAttempt(baselineAttempt) : null, baselineAttempt }
}
