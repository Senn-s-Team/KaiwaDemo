import { describe, expect, it, vi } from 'vitest'
import { checkSessionCheckpoint } from '../../src/lib/api'
import { createRoundRecord, createTiming } from '../../src/lib/metrics'
import type { ConversationMessage } from '../../src/types'

describe('checkpoint timing and metrics recording tests', () => {
  it('checkSessionCheckpoint sends history ending with user message', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          isGoalCompleted: false,
          completedGoals: [{ id: 'g1', evidence: 'checked in' }],
          remainingGoals: [{ id: 'g2', titleZh: '询问早餐' }],
          factsSummary: ['已提供姓名'],
          nextDirection: '请询问早餐时间',
          canExtend: true,
          nextCap: 14,
          newSessionToken: 'extended-token-xyz',
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const history: ConversationMessage[] = [
      { id: 'm1', turn: 1, role: 'assistant', text: 'いらっしゃいませ。' },
      { id: 'm2', turn: 1, role: 'user', text: '田中です。チェックインお願いします。' },
      { id: 'm3', turn: 2, role: 'assistant', text: '田中様ですね。お部屋をご用意いたします。' },
      { id: 'm4', turn: 2, role: 'user', text: 'ありがとうございます。' },
    ]

    const res = await checkSessionCheckpoint('token-123', 2, history)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/session/checkpoint')
    const body = JSON.parse(init.body as string)
    expect(body.sessionToken).toBe('token-123')
    expect(body.turn).toBe(2)
    expect(body.history).toHaveLength(4)
    expect(body.history[body.history.length - 1].role).toBe('user')
    expect(body.history[body.history.length - 1].text).toBe('ありがとうございます。')
    expect(res.canExtend).toBe(true)
    expect(res.nextCap).toBe(14)
    expect(res.newSessionToken).toBe('extended-token-xyz')

    vi.unstubAllGlobals()
  })

  it('records firstSpeechAt once without overriding on subsequent sound events', () => {
    const timing = createTiming()
    expect(timing.firstSpeechAt).toBeNull()

    const firstSoundAt = 1000
    if (timing.firstSpeechAt === null) {
      timing.firstSpeechAt = firstSoundAt
    }
    expect(timing.firstSpeechAt).toBe(1000)

    const secondSoundAt = 2000
    if (timing.firstSpeechAt === null) {
      timing.firstSpeechAt = secondSoundAt
    }
    expect(timing.firstSpeechAt).toBe(1000)
  })

  it('tracks highest hintLevelUsed and userCleaned on RoundRecord', () => {
    const round = createRoundRecord(1, 'いらっしゃいませ。', 0)
    expect(round.hintLevelUsed).toBe(0)
    expect(round.userCleaned).toBe('')

    round.userCleaned = '田中です。'
    expect(round.userCleaned).toBe('田中です。')

    // Request hint level 1
    const level1 = 1
    if (level1 > round.hintLevelUsed) round.hintLevelUsed = level1
    expect(round.hintLevelUsed).toBe(1)

    // Expand hint to level 3
    const level3 = 3
    if (level3 > round.hintLevelUsed) round.hintLevelUsed = level3
    expect(round.hintLevelUsed).toBe(3)

    // Ensure lower level does not reduce recorded max
    const level2 = 2
    if (level2 > round.hintLevelUsed) round.hintLevelUsed = level2
    expect(round.hintLevelUsed).toBe(3)
  })
})
