/**
 * [INPUT]: 完成页四维评价、真实回合记录与有效历史比较
 * [OUTPUT]: 验证未观察/无需澄清、原文证据、基线日期和程序事实的可见呈现
 * [POS]: components 的会后评价渲染契约
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SessionComplete } from '../../src/components/SessionComplete'
import { createRoundRecord, buildSessionReport } from '../../src/lib/metrics'
import type { SessionScenario } from '../../src/types'

const scenario = {
  id: 'session', version: 1, variantId: 'v', firstLine: 'ご希望は？', maxTurns: 5, scenarioType: 'dynamic', sessionToken: 'token', scenarioToken: 'scenario-token', practiceToken: 'practice-token',
  reveal: { titleZh: '改期', summaryZh: '改约时间' },
  dynamicData: { id: 'appointment', version: 1, evaluationVersion: 1, evidencePoints: [{ id: 'request', titleZh: '请求', descriptionZh: '提出改期' }], titleZh: '改期', summaryZh: '改约时间', aiRole: '店员', userRole: '顾客', relationship: '初见', tone: '礼貌', firstLine: 'ご希望は？', userGoal: '改期', coreGoal: { id: 'request', titleZh: '请求', descriptionZh: '提出改期' }, communicationFunction: '协商', initialFacts: [], partnerPrivateFacts: [], keyIntents: [], keyInformation: [], completionRules: { completed: [], partial: [], notCompleted: [] }, closingRules: [], maxTurns: 5, partnerOpeningPlan: '', worldAnchors: [], followUpPrinciples: [], hintStrategy: '', feedbackFocus: [], safetyBoundary: '' },
} as SessionScenario

function markup(): string {
  const rounds = Array.from({ length: 5 }, (_, index) => {
    const round = createRoundRecord(index + 1, 'ご希望は？', 0)
    round.userFinal = '金曜日でお願いします。'
    round.inputMode = index === 0 ? 'text' : 'stt'
    round.rerecordCount = index === 1 ? 2 : 0
    round.transcriptModificationCount = index === 2 ? 1 : 0
    return round
  })
  const report = buildSessionReport('current', 'real', scenario, 200, 300, rounds, [])
  const performance = {
    version: 1 as const,
    dimensions: {
      communicationAchievement: { rating: 2 as const, status: 'observed' as const, reasonZh: '主要诉求已表达。', evidence: [{ turn: 1, role: 'user' as const, quoteJa: '金曜日でお願いします。' }] },
      responseRelevance: { rating: null, status: 'unobserved' as const, reasonZh: '没有足够证据。', evidence: [] },
      expressionClarity: { rating: 1 as const, status: 'observed' as const, reasonZh: '意思可以判断。', evidence: [{ turn: 1, role: 'user' as const, quoteJa: '金曜日でお願いします。' }] },
      clarificationRepair: { rating: null, status: 'not_needed' as const, reasonZh: '全程无需澄清。', evidence: [] },
    },
  }
  return renderToStaticMarkup(createElement(SessionComplete, { messages: [], rounds, report, sessionId: 'current', scenario, reveal: scenario.reveal, config: null, feedbackStatus: 'success', feedbackErrorMsg: '', feedbackData: { performance, outcome: 'partial', outcomeEvidenceZh: '“金曜日でお願いします。”是确认稿。', listeningFinding: null, expressionImprovement: null, redoTask: { turn: 1, partnerPromptJa: 'ご希望は？', firstConfirmedJa: '金曜日でお願いします。', directionZh: '说明时间。' } }, restoredRedoTask: undefined, onRetryFeedback: vi.fn(), copyStatus: '', onCopy: vi.fn(), onDownload: vi.fn(), onReplayAi: vi.fn(), onStopAudio: vi.fn(), onRequestRedo: vi.fn(), onRequestListeningScaffold: vi.fn(), onCacheListeningScaffold: vi.fn(), onNewScenario: vi.fn(), audioNotice: '', practiceComparison: { current: { total: 1, completed: 0, notObserved: 0, insufficientEvidence: 0, listeningIndependent: 0, expressionIndependent: 0, independenceUnknown: 0, observedAssistance: { listening: 0, expression: 0 }, evidence: [], validEvaluation: true, dimensions: { communicationAchievement: 2, responseRelevance: null, expressionClarity: 1, clarificationRepair: null }, validPerformance: true }, baseline: null, baselineAttempt: null, performanceBaseline: { total: 1, completed: 0, notObserved: 0, insufficientEvidence: 0, listeningIndependent: 0, expressionIndependent: 0, independenceUnknown: 0, observedAssistance: { listening: 0, expression: 0 }, evidence: [], validEvaluation: true, dimensions: { communicationAchievement: 3, responseRelevance: null, expressionClarity: 1, clarificationRepair: null }, validPerformance: true }, performanceBaselineAttempt: { scenario: scenario.dynamicData, practiceToken: 'p', report: { ...report, sessionId: 'baseline', startedAt: 100 }, feedback: null, scenarioKey: 'key' } }, onRepeatScenario: vi.fn(), historyNotice: '' }))
}

describe('SessionComplete performance', () => {
  it('renders null states, evidence, baseline date, and observable program facts', () => {
    const output = markup()
    expect(output).toContain('回应贴合')
    expect(output).toContain('未观察')
    expect(output).toContain('无需澄清')
    expect(output).toContain('金曜日でお願いします。')
    expect(output).toContain(new Date(100).toLocaleDateString('zh-CN'))
    expect(output).toContain('比较：基线 3 · 本次 2')
    expect(output).toContain('语音输入 4 轮，文字输入 1 轮，重录 2 次，确认稿编辑 1 轮')
  })
})
