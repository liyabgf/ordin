import { describe, expect, it } from 'vitest'
import { parseWorkerReport } from '../src/drivers/report.ts'

const AT = '2026-11-15T00:00:00Z'
const FENCE = '\u0060\u0060\u0060'
const block = (json: string) => `结论。\n${FENCE}ordin-report\n${json}\n${FENCE}`

describe('L1 worker report parser', () => {
  it('parses a ready report with files', () => {
    const parsed = parseWorkerReport(block('{"state":"ready","summary":"做完","files":["RESULT.md"]}'), AT)
    expect(parsed).toEqual({ kind: 'valid', report: { state: 'ready', summary: '做完', at: AT, files: ['RESULT.md'] } })
  })
  it('accepts no block as none, never as an inferred report', () => {
    expect(parseWorkerReport('只是普通回答', AT)).toEqual({ kind: 'none' })
  })
  it('requires a question for waiting/blocked/failed', () => {
    for (const state of ['waiting', 'blocked', 'failed']) {
      expect(parseWorkerReport(block(`{"state":"${state}","summary":"等人"}`), AT).kind).toBe('invalid')
      expect(parseWorkerReport(block(`{"state":"${state}","summary":"等人","question":"选哪个？"}`), AT).kind).toBe('valid')
    }
  })
  it('rejects duplicate blocks, bad JSON, bad state and empty files', () => {
    const good = block('{"state":"ready","summary":"做完"}')
    expect(parseWorkerReport(good + '\n' + good, AT).kind).toBe('invalid')
    expect(parseWorkerReport(block('{bad'), AT).kind).toBe('invalid')
    expect(parseWorkerReport(block('{"state":"done","summary":"做完"}'), AT).kind).toBe('invalid')
    expect(parseWorkerReport(block('{"state":"ready","summary":"做完","files":[""]}'), AT).kind).toBe('invalid')
  })
})
