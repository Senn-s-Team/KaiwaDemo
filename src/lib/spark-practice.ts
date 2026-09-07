import type { VocabScenario } from '../data/vocab-bank'
import type { ScenarioDraftResponse, ScenarioDraftReadyResponse } from '../types'

type DraftSparkScenario = (
  prompt: string,
  clarifications: readonly { questionZh: string; answerZh: string }[],
  forceGenerate: boolean,
) => Promise<ScenarioDraftResponse>

export function buildSparkPrompt(scenario: VocabScenario): string {
  return `背景：${scenario.settingZh}。相手：${scenario.partnerZh}。唯一目标：${scenario.challengeZh}。`
}

export async function prepareSparkPractice(
  scenario: VocabScenario,
  draft: DraftSparkScenario,
): Promise<ScenarioDraftReadyResponse> {
  const result = await draft(buildSparkPrompt(scenario), [], true)
  if (result.status !== 'ready') {
    throw new Error('未能生成完整场景，请重试。')
  }
  return result
}
