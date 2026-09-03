import type { VocabScenario } from '../data/vocab-bank'

type SparkDraftResult =
  | { status: 'ready'; scenarioToken: string }
  | { status: 'needs_clarification' }

type DraftSparkScenario = (
  prompt: string,
  clarifications: readonly { questionZh: string; answerZh: string }[],
  forceGenerate: boolean,
) => Promise<SparkDraftResult>

type StartDynamicSession = (scenarioToken: string) => Promise<void> | void

export function buildSparkPrompt(scenario: VocabScenario): string {
  return `场所：${scenario.settingZh}。对方：${scenario.partnerZh}。挑战：${scenario.challengeZh}。参考表达：${scenario.keyExpressions.join('、')}`
}

export async function startSparkPractice(
  scenario: VocabScenario,
  draft: DraftSparkScenario,
  start: StartDynamicSession,
): Promise<void> {
  const result = await draft(buildSparkPrompt(scenario), [], true)
  if (result.status !== 'ready') {
    throw new Error('未能生成完整场景，请重试。')
  }
  await start(result.scenarioToken)
}
