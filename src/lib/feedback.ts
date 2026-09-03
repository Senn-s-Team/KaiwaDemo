import type { FeedbackImprovement, RoundRecord } from '../types'

export function mapImprovementsByTurn(
  improvements: readonly FeedbackImprovement[] = [],
): Record<number, FeedbackImprovement[]> {
  const map: Record<number, FeedbackImprovement[]> = {}
  for (const item of improvements) {
    if (!map[item.turn]) {
      map[item.turn] = []
    }
    map[item.turn].push(item)
  }
  return map
}

export function formatImprovementType(type: FeedbackImprovement['type']): string {
  switch (type) {
    case 'grammar_fix':
      return '语法修正'
    case 'naturalness_upgrade':
      return '地道表达'
    default:
      return '表达建议'
  }
}

export function getRoundForTurn(rounds: readonly RoundRecord[], turn: number): RoundRecord | undefined {
  return rounds.find((r) => r.turn === turn)
}
