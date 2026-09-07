import { describe, expect, it, vi } from 'vitest'
import { buildSparkPrompt, prepareSparkPractice } from '../../src/lib/spark-practice'
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
  firstLine: 'どのようなお部屋をお探しですか。',
  userGoal: '说明预算并询问初期费用',
  coreGoal: { id: 'goal', titleZh: '确认初期费用', descriptionZh: '说明预算后，问清初期费用。' },
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
