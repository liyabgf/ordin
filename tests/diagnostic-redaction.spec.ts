import { describe, expect, it } from 'vitest'
import { createLogger, formatDetails } from '../src/app/logger.ts'
import { deskLlmGenerate, DeskLlmError } from '../src/desk/llm.ts'

const marker = 'SYNTHETIC_BODY_ECHO_83a9'

describe('diagnostic boundary redaction (synthetic only)', () => {
  it.each([[401, 'auth', false], [403, 'auth', false], [429, 'rate_limit', true], [500, 'server', true], [400, 'http', false]] as const)(
    'HTTP %s retains classification but never echoes upstream body', async (status, kind, retryable) => {
      const fetchFn: typeof fetch = async () => new Response(JSON.stringify({ error: marker }), {
        status, headers: { 'retry-after': '3', 'content-type': 'application/json' },
      })
      const error = await deskLlmGenerate({ baseUrl: 'http://synthetic.invalid/v1', model: 'synthetic', fetchFn }, [], []).catch(e => e)
      expect(error).toBeInstanceOf(DeskLlmError)
      expect(error).toMatchObject({ status, kind, retryable, retryAfterMs: 3000 })
      expect(error.message).toContain('HTTP ' + status)
      expect(String(error)).not.toContain(marker)
      expect(JSON.stringify(error)).not.toContain(marker)
    },
  )

  it.each(['debug', 'info', 'warn', 'error'] as const)('scrubs labeled secrets in %s messages, JSON, printf, and Errors', level => {
    const lines: string[] = []
    const logger = createLogger({ level: 'debug', sink: line => lines.push(line), now: () => 'clock' })
    logger[level]('HTTP 429 Authorization: Bearer SYNTH_AUTH retryAfterMs=3000')
    logger[level]('request failed', { apiKey: 'SYNTH_KEY', nested: { access_token: 'SYNTH_TOKEN', password: 'SYNTH_PASSWORD' }, status: 401 })
    logger[level]('HTTP %d token=%s retryAfterMs=%d', 500, 'SYNTH_PRINTF', 3000)
    logger[level]('Authorization: Bearer %s', 'SYNTH_SINGLE')
    logger[level]('failure', new Error(`HTTP 500 api_key="SYNTH_ERROR" password='SYNTH_SPACED secret'`))
    logger[level]('json %j inspected %o', { 'x-api-key': 'SYNTH_JSON' }, { refreshToken: 'SYNTH_INSPECT' })
    const output = lines.join('\n')
    expect(output).not.toMatch(/SYNTH_/)
    expect(output).toContain('HTTP 429')
    expect(output).toContain('retryAfterMs=3000')
    expect(output).toContain('HTTP 500')
    expect(output).toContain('"status":401')
    expect(output).toContain('[REDACTED]')
  })

  it('preserves operational parameters and ordinary text; cycles do not throw or mutate inputs', () => {
    const lines: string[] = []
    const logger = createLogger({ sink: line => lines.push(line), now: () => 'clock' })
    logger.info('request %s completed in %d ms', 'r-42', 25)
    logger.info('request %s', 'r-43')
    logger.info('token count=42 password reset requested ticket_token=ordinary')
    const cyclic: Record<string, unknown> = { apiKey: 'SYNTH_CYCLE', status: 503 }
    cyclic.self = cyclic
    expect(() => logger.warn('retry', cyclic)).not.toThrow()
    expect(() => logger.warn('retry %o status=%d', cyclic, 503)).not.toThrow()
    expect(lines.join('\n')).not.toContain('SYNTH_CYCLE')
    expect(lines.join('\n')).toContain('request r-42 completed in 25 ms')
    expect(lines.join('\n')).toContain('request r-43')
    expect(lines.join('\n')).toContain('token count=42 password reset requested ticket_token=ordinary')
    const error = new Error('HTTP 500 token=SYNTH_NAMED')
    error.name = 'SyntheticProviderError'
    logger.error('provider %s status=%d', error, 500)
    expect(lines.at(-1)).toContain('SyntheticProviderError')
    expect(lines.at(-1)).not.toContain('SYNTH_NAMED')
    expect(cyclic.apiKey).toBe('SYNTH_CYCLE')
    expect(formatDetails({ token: 'SYNTH_DIRECT', status: 429 })).toContain('"status":429')
    expect(formatDetails({ token: 'SYNTH_DIRECT' })).not.toContain('SYNTH_DIRECT')
  })
})
