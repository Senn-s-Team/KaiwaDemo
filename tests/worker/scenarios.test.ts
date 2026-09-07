import { describe, expect, it } from 'vitest'
import { createMockReply } from '../../worker/mock'
import { buildDynamicDeveloperPrompt, buildFeedbackPrompt, buildHintPrompt, buildScenarioDraftPrompt } from '../../worker/scenarios'
import type { DynamicScenarioDefinition, ReplyRequest } from '../../worker/types'

const scenario: DynamicScenarioDefinition = {
  id: 'dynamic-schedule-change',
  version: 1,
  titleZh: '调整会议时间',
  summaryZh: '与同事协商一次会议时间变更。',
  aiRole: '日程を調整する同僚',
  userRole: '時間変更を依頼する同僚',
  relationship: '職場の同僚',
  tone: '丁寧体',
  communicationFunction: '礼貌提出会议改期并确认双方接受的新时间',
  firstLine: '来週の打ち合わせですが、時間の変更をご希望ですか？',
  partnerOpeningPlan: '先说明正在讨论既有会议，再邀请用户提出一个新的具体时间。',
  userGoal: '提出新的会议时间并获得确认。',
  coreGoal: { id: 'schedule', titleZh: '确认新时间', descriptionZh: '明确提出一个新的会议时间并确认双方理解一致。' },
  initialFacts: ['双方原定周二下午开会', '用户需要提出改期'],
  partnerPrivateFacts: ['AI一方周五下午三点可以参会'],
  keyIntents: ['用户：提出可行的新会议时间', 'AI：确认新时间是否可接受'],
  keyInformation: ['原会议时间', '用户提出的新时间', '双方对新时间的确认'],
  completionRules: {
    completed: ['用户提出明确新时间，且双方确认理解一致'],
    partial: ['用户表达改期意图，但新时间或确认仍不明确'],
    notCompleted: ['用户未提出与改期相关的可用信息'],
  },
  closingRules: ['第4轮只做最后一次必要确认', '第5轮不提问并以确认结果自然结束'],
  maxTurns: 5,
  worldAnchors: ['原会议在周二下午'],
  followUpPrinciples: ['每次只确认一个必要条件', '第四轮开始收束'],
  hintStrategy: '先提出候选时间，再礼貌确认。',
  feedbackFocus: ['时间表达', '支架使用'],
  safetyBoundary: '不承诺调用真实日历或联系第三方。',
}

function replyRequest(turn: number): ReplyRequest {
  const history = [
    { role: 'assistant' as const, text: scenario.firstLine },
    { role: 'user' as const, text: '金曜日の午後三時に変更したいです。' },
  ]
  while (history.filter((item) => item.role === 'user').length < turn) {
    history.push({ role: 'assistant', text: '内容を確認しました。' })
    history.push({ role: 'user', text: 'はい、お願いします。' })
  }
  return {
    scenarioType: 'dynamic',
    sessionToken: 'signed-session-token',
    sessionId: 'dynamic123456',
    turn,
    history,
  }
}

describe('dynamic scenario prompts', () => {
  it('contains only one core goal and no optional or recommended-turn structure', () => {
    const prompt = buildDynamicDeveloperPrompt(scenario, 2)
    expect(prompt).toContain(`唯一のコア目標: [${scenario.coreGoal.id}]`)
    expect(prompt).not.toContain('オプション目標')
    expect(prompt).not.toContain('recommendedMinTurns')
    expect(prompt).toContain('必ず5ターン以内')
  })

  it('serializes the complete strict contract in the scenario draft prompt', () => {
    const prompt = buildScenarioDraftPrompt({ inputZh: '练习调整会议时间', clarifications: [] })
    expect(prompt).toContain('communicationFunction')
    expect(prompt).toContain('initialFacts')
    expect(prompt).toContain('partnerPrivateFacts')
    expect(prompt).toContain('keyIntents')
    expect(prompt).toContain('keyInformation')
    expect(prompt).toContain('"completed"')
    expect(prompt).toContain('"partial"')
    expect(prompt).toContain('"notCompleted"')
    expect(prompt).toContain('partnerOpeningPlan')
    expect(prompt).toContain('closingRules')
    expect(prompt).toContain('"maxTurns": 5')
    expect(prompt).not.toContain('recommendedMinTurns')
  })

  it('passes facts, intents, information, completion, opening, and closing rules to the runtime model', () => {
    const prompt = buildDynamicDeveloperPrompt(scenario, 3)
    expect(prompt).toContain(scenario.communicationFunction)
    expect(prompt).toContain(scenario.initialFacts[0])
    expect(prompt).toContain(scenario.partnerPrivateFacts[0])
    expect(prompt).toContain(scenario.keyIntents[0])
    expect(prompt).toContain(scenario.keyInformation[0])
    expect(prompt).toContain(scenario.completionRules.completed[0])
    expect(prompt).toContain(scenario.partnerOpeningPlan)
    expect(prompt).toContain(scenario.closingRules[0])
  })

  it('keeps safety, fact-boundary, and natural upward-pull instructions', () => {
    const prompt = buildDynamicDeveloperPrompt(scenario, 3)
    expect(prompt).toContain('ユーザーが確認したSTT転写テキスト')
    expect(prompt).toContain('初期アンカー')
    expect(prompt).toContain('低リスクな細部を一つ')
    expect(prompt).toContain('自然で一段上の口語表現')
    expect(prompt).toContain('実行できない外部確認や将来の対応を約束しない')
  })

  it('defines speechAssistUsed as asymmetric observable scaffold evidence', () => {
    const prompt = buildFeedbackPrompt(scenario, {
      scenarioType: 'dynamic',
      sessionToken: 'signed-session-token',
      turnRecords: [{
        turn: 1,
        partnerPromptJa: scenario.firstLine,
        userOriginal: 'ええと、金曜日の午後三時に変更したいです。',
        userCleaned: '金曜日の午後三時に変更したいです。',
        userConfirmed: '金曜日の午後三時に変更したいです。',
        inputMode: 'stt',
        transcriptModified: false,
        rerecordCount: 0,
        partnerAudioPlayCount: 1,
        ttsReplayCount: 0,
        transcriptRevealed: false,
        listeningScaffoldLevel: 0,
        expressionScaffoldLevel: 0,
        failureCount: 0,
        retryCount: 0,
        textFallback: false,
        speechAssistUsed: true,
      }],
    })
    expect(prompt).toContain('speechAssistUsed=true')
    expect(prompt).toContain('リアルタイム継続ガイダンスが画面に表示され')
    expect(prompt).toContain('「支架なし」「表現支架未使用」')
    expect(prompt).toContain('speechAssistUsed=false')
    expect(prompt).toContain('他フィールド以外の支架もなかった証拠にはならない')
  })

  it('builds a four-field expression scaffold prompt', () => {
    const prompt = buildHintPrompt(scenario, scenario.firstLine, [{ role: 'assistant', text: scenario.firstLine }])
    expect(prompt).toContain('directionZh')
    expect(prompt).toContain('keyPhrasesJa')
    expect(prompt).toContain('sentenceStarterJa')
    expect(prompt).toContain('fullExampleJa')
  })

  it('uses a converging fourth mock reply and a question-free final reply', () => {
    const fourth = createMockReply(replyRequest(4))
    const fifth = createMockReply(replyRequest(5))
    expect(fourth).toContain('相違ありませんか')
    expect((fourth.match(/[？?]/g) ?? []).length).toBeLessThanOrEqual(1)
    expect(fifth.match(/[？?]/g) ?? []).toHaveLength(0)
    expect(fifth).not.toContain('ほかに')
  })
})
