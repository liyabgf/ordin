import { describe, expect, it } from 'vitest'
import { BASE_PATH, REQUEST_HEADER, serve, type HttpHost } from '../src/app/http.ts'
const headers = { [REQUEST_HEADER]: '1', 'content-type': 'application/json' }

describe('chat model selection', () => {
  it('forwards an optional model while preserving the legacy default request', async () => {
    const received: (string | undefined)[] = []
    const serving = await serve({
      conversationTurn: async (_id: string, _text: string, model?: string) => {
        received.push(model)
        return { reply: 'ok', sent: [], toolOutcomes: [], rounds: 1 }
      },
    } as unknown as HttpHost, { port: 0 })
    try {
      const endpoint = serving.url + BASE_PATH + '/api/conversations/c1/message'
      const post = (body: unknown) => fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) })
      expect((await post({ text: 'hello' })).status).toBe(200)
      expect((await post({ text: 'hello', model: 'saved-2' })).status).toBe(200)
      expect(received).toEqual([undefined, 'saved-2'])
      for (const model of ['', '  ', 42, 'x'.repeat(201)]) expect((await post({ text: 'hello', model })).status).toBe(400)
      expect(received).toEqual([undefined, 'saved-2'])
    } finally { await serving.close() }
  })

  it('returns a clear client error for a model rejected by the runtime', async () => {
    const serving = await serve({
      conversationTurn: async () => { throw new RangeError('Choose a saved model from Settings before sending a message') },
    } as unknown as HttpHost, { port: 0 })
    try {
      const response = await fetch(serving.url + BASE_PATH + '/api/conversations/c1/message', { method: 'POST', headers, body: JSON.stringify({ text: 'hello', model: 'unknown' }) })
      expect(response.status).toBe(400)
      expect((await response.json()).error).toContain('saved model')
    } finally { await serving.close() }
  })
})
