/**
 * [INPUT]: 依赖 data/vocab-bank 场景素材与动态场景生成响应类型
 * [OUTPUT]: 提供可编辑场景描述、首页三条例子抽取与完整场景准备
 * [POS]: 首页例子与动态场景请求之间的内容适配边界
 * [PROTOCOL]: 变更时更新此头部，然后检查 AGENTS.md
 */
import { VOCAB_BANK, type VocabScenario } from '../data/vocab-bank'
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

/** 选取三个可编辑的场景例子；换组时避开当前例子。 */
export function drawPracticeExamples(excludeIds: readonly string[] = []): VocabScenario[] {
  if (excludeIds.length === 0) {
    return ['daily-salon', 'social-hobby', 'daily-return'].map((id) => VOCAB_BANK.find((scenario) => scenario.id === id)!)
  }
  const candidates = VOCAB_BANK.filter((scenario) => !excludeIds.includes(scenario.id))
  const result: VocabScenario[] = []
  while (result.length < 3 && candidates.length > 0) {
    result.push(candidates.splice(Math.floor(Math.random() * candidates.length), 1)[0])
  }
  return result
}
