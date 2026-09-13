/**
 * [INPUT]: 场景素材与首页例子适配函数
 * [OUTPUT]: 验证可编辑描述、三条例子与准备结果
 * [POS]: tests/client 的首页场景准备契约测试
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { describe, expect, it, vi } from 'vitest'
import { buildSparkPrompt, drawPracticeExamples, prepareSparkPractice } from '../../src/lib/spark-practice'
import type { VocabScenario } from '../../src/data/vocab-bank'
import type { DynamicScenarioData } from '../../src/types'

const spark: VocabScenario = {
  id: 'admin-rent',
  domain: 'admin',
  domainZh: '生活手续与契约',
  titleZh: '租房问询',
  titleJa: '賃貸物件の問い合わせ',
  settingZh: '不动产中介店铺',
  partnerZh: '不动产经纪人',
  challengeZh: '说明预算并询问初期费用',
  keyExpressions: ['家賃は〜万円以内で'],
}

const scenario: DynamicScenarioData = {
  id: 'rent',
  version: 1,
  titleZh: '租房问询',
  summaryZh: '在不动产中介店铺咨询租房。',
  aiRole: '不动产经纪人',
  userRole: '租房者',
  relationship: '初次见面',
  tone: '礼貌',
  opening: { speaker: 'user', planZh: '用户主动说明预算并询问费用。' },
  userGoal: '说明预算并询问初期费用',
  coreGoal: { id: 'goal', titleZh: '确认初期费用', descriptionZh: '说明预算后，问清初期费用。' },
  communicationFunction: '主动询问租房初期费用',
  initialFacts: ['双方正在不动产中介店铺交谈'],
  partnerPrivateFacts: [],
  keyIntents: ['用户：询问费用', 'AI：说明可提供的信息'],
  keyInformation: ['预算', '初期费用'],
  completionRules: { completed: ['确认稿说明预算并询问费用'], partial: ['只表达其中一项'], notCompleted: ['未表达相关需求'] },
  closingRules: ['第5轮自然结束'],
  maxTurns: 5,
  worldAnchors: [],
  followUpPrinciples: [],
  hintStrategy: '逐级提示',
  feedbackFocus: [],
  safetyBoundary: '不提供法律建议',
}

describe('灵感速练预览', () => {
  it('prompt只携带背景、相手与唯一目标，不泄露参考表达', () => {
    expect(buildSparkPrompt(spark)).toBe('背景：不动产中介店铺。相手：不动产经纪人。唯一目标：说明预算并询问初期费用。')
    expect(buildSparkPrompt(spark)).not.toContain('家賃は')
  })

  it('先返回ready场景供确认，不直接启动会话', async () => {
    const draft = vi.fn().mockResolvedValue({ status: 'ready', scenarioToken: 'scenario-token', scenario })
    await expect(prepareSparkPractice(spark, draft)).resolves.toEqual({ status: 'ready', scenarioToken: 'scenario-token', scenario })
    expect(draft).toHaveBeenCalledWith(buildSparkPrompt(spark), [], true)
  })

  it('意外追问时拒绝产生不完整预览', async () => {
    const draft = vi.fn().mockResolvedValue({ status: 'needs_clarification', questionZh: '补充？', optionsZh: [] })
    await expect(prepareSparkPractice(spark, draft)).rejects.toThrow('完整场景')
  })
})


describe('首页场景例子', () => {
  it('提供三个可编辑且不包含参考日语的短描述', () => {
    const examples = drawPracticeExamples()
    expect(examples).toHaveLength(3)
    expect(new Set(examples.map((example) => example.id)).size).toBe(3)
    for (const example of examples) {
      const prompt = buildSparkPrompt(example)
      expect(prompt.length).toBeLessThanOrEqual(300)
      for (const expression of example.keyExpressions) expect(prompt).not.toContain(expression)
    }
  })

  it('换组避开当前三个例子，结果不重复', () => {
    const previous = drawPracticeExamples().map((example) => example.id)
    const next = drawPracticeExamples(previous)
    expect(next).toHaveLength(3)
    expect(new Set(next.map((example) => example.id)).size).toBe(3)
    expect(next.every((example) => !previous.includes(example.id))).toBe(true)
  })
})
