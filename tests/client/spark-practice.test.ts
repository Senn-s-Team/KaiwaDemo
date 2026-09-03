import { describe, expect, it, vi } from 'vitest'
import { startSparkPractice } from '../../src/lib/spark-practice'
import type { VocabScenario } from '../../src/data/vocab-bank'

const scenario: VocabScenario = {
  id: 'admin-rent',
  domain: 'admin',
  domainZh: '生活手续与契约',
  titleZh: '租房问询',
  titleJa: '賃貸物件の問い合わせ',
  settingZh: '不动产中介店铺',
  partnerZh: '推销但有帮助的不动产经纪人',
  challengeZh: '说明预算和需求并询问初期费用',
  keyExpressions: ['家賃は〜万円以内で', '初期費用はどのくらいですか', '内見は可能ですか'],
}

describe('灵感场景一键开始', () => {
  it('强制生成完整场景并立即用返回的 token 启动会话', async () => {
    const draft = vi.fn().mockResolvedValue({ status: 'ready', scenarioToken: 'scenario-token' })
    const start = vi.fn().mockResolvedValue(undefined)

    await startSparkPractice(scenario, draft, start)

    expect(draft).toHaveBeenCalledWith(
      '场所：不动产中介店铺。对方：推销但有帮助的不动产经纪人。挑战：说明预算和需求并询问初期费用。参考表达：家賃は〜万円以内で、初期費用はどのくらいですか、内見は可能ですか',
      [],
      true,
    )
    expect(start).toHaveBeenCalledWith('scenario-token')
  })

  it('生成服务意外返回追问时不启动空会话', async () => {
    const draft = vi.fn().mockResolvedValue({ status: 'needs_clarification' })
    const start = vi.fn().mockResolvedValue(undefined)

    await expect(startSparkPractice(scenario, draft, start)).rejects.toThrow('完整场景')
    expect(start).not.toHaveBeenCalled()
  })
})
