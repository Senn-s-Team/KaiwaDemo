import { afterEach, describe, expect, it } from 'vitest'
import type { ListeningScaffoldRequest } from '../../shared/listening-scaffold'
import { requestListeningScaffold, streamReply } from '../../src/lib/api'
import type { ConversationMessage } from '../../src/types'

const request: ListeningScaffoldRequest = {
  scenarioType: 'dynamic',
  sessionToken: 'signed-session-token',
  turn: 2,
  partnerPromptJa: 'サイズはいかがなさいますか？',
}

const validResponse = {
  keyInformationHintZh: '对方正在询问你想要的尺寸。',
  keyPhrasesJa: ['サイズ', 'いかがなさいますか'],
  intentSummaryZh: '请说明你想选择的尺寸。',
}

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('requestListeningScaffold', () => {
  it('posts the shared request contract and accepts a strict valid response', async () => {
    let capturedUrl: string | URL | Request | undefined
    let capturedInit: RequestInit | undefined
    globalThis.fetch = async (url, init) => {
      capturedUrl = url
      capturedInit = init
      return new Response(JSON.stringify(validResponse), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }

    await expect(requestListeningScaffold(request)).resolves.toEqual(validResponse)
    expect(capturedUrl).toBe('/api/listening-scaffold')
    expect(capturedInit?.method).toBe('POST')
    expect(JSON.parse(String(capturedInit?.body))).toEqual(request)
  })

  it('rejects response fields outside the shared strict schema', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      ...validResponse,
      leakedContext: 'not allowed',
    }), { status: 200 })

    await expect(requestListeningScaffold(request)).rejects.toThrow()
  })

  it('does not serialize a message scaffold cache into reply history', async () => {
    let capturedInit: RequestInit | undefined
    globalThis.fetch = async (_url, init) => {
      capturedInit = init
      return new Response(`${JSON.stringify({
        type: 'done',
        text: 'トールですね。',
        model: 'test-model',
        mock: false,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      })}\n`, { status: 200 })
    }
    const messages: ConversationMessage[] = [
      {
        id: 'assistant-1',
        turn: 1,
        role: 'assistant',
        text: request.partnerPromptJa,
        listeningScaffold: validResponse,
      },
      { id: 'user-1', turn: 1, role: 'user', text: 'トールでお願いします。' },
    ]

    await streamReply('session-1234', 1, messages, { sessionToken: request.sessionToken }, () => undefined)

    const body = JSON.parse(String(capturedInit?.body)) as { history: unknown[] }
    expect(body.history).toEqual(messages.map(({ role, text }) => ({ role, text })))
  })
})
