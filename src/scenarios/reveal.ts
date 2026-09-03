import type { AppPhase, SessionScenario } from '../types'

export function deriveScenarioReveal(phase: AppPhase, scenario: SessionScenario | null): SessionScenario['reveal'] | null {
  return phase === 'session_complete' ? scenario?.reveal ?? null : null
}
