import { describe, expect, it } from 'vitest'
import { decideNextSessionStep, isFinalTurn } from '../../src/lib/session'

describe('five-turn session boundary', () => {
  it('identifies turn 5 as the final turn budget without allowing turn 6', () => {
    expect(isFinalTurn(1)).toBe(false)
    expect(isFinalTurn(4)).toBe(false)
    expect(isFinalTurn(5)).toBe(true)
    expect(isFinalTurn(6)).toBe(true)
  })

  it('decides session advance vs completion based on turn boundary', () => {
    expect(decideNextSessionStep(1)).toEqual({ action: 'advance', nextTurn: 2 })
    expect(decideNextSessionStep(4)).toEqual({ action: 'advance', nextTurn: 5 })
    expect(decideNextSessionStep(5)).toEqual({ action: 'complete', nextTurn: null })
    expect(decideNextSessionStep(6)).toEqual({ action: 'complete', nextTurn: null })
  })
})
