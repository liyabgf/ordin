/** Independent acceptance: a worker ready is checked against the ticket directory before it may end the Ticket. */
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fileExists, fileReadable, resultNonEmpty, runAcceptance, scopeRespected } from '../src/app/acceptance.ts'
import type { Report, Ticket } from '../src/core/model.ts'
import { tempDir } from './helpers/temp.ts'

const ticket = (endedReasons: string[] = []): Ticket => ({
  id: 'ticket-1', title: 't', createdAt: '2026-11-15T00:00:00Z',
  mandate: { policyVersion: 'v', scope: 's', strength: 'explicit', sender: { id: 'operator', kind: 'person' }, via: 'session', at: '' },
  origin: { triggerId: 't' }, attachments: [], inputs: [], notes: [],
  assignments: endedReasons.map((reason, index) => ({ id: 'a-' + index, state: 'ended' as const, createdAt: '', endedReason: reason })),
} as unknown as Ticket)

const report = (files: string[], summary = 'done'): Report => ({ state: 'ready', summary, at: '2026-11-15T00:00:00Z', files })

describe('acceptance checks', () => {
  it('accepts a report whose files exist, are readable and stay inside the directory', async () => {
    const dir = tempDir('ordin-accept-')
    writeFileSync(join(dir, 'RESULT.md'), '# done\n', 'utf8')
    const verdict = await runAcceptance({ ticket: ticket(), report: report(['RESULT.md']), directory: dir })
    expect(verdict.status).toBe('accepted')
    expect(verdict.checks?.every(check => check.passed)).toBe(true)
  })

  it('returns unverified for text-only results but respects explicit custom checks', async () => {
    const subject = { ticket: ticket(), report: report([]), directory: tempDir('ordin-accept-') }
    expect((await runAcceptance(subject)).status).toBe('unverified')
    expect((await runAcceptance(subject, [resultNonEmpty])).status).toBe('accepted')
  })

  it('sends back a missing file, and records the reason', async () => {
    const dir = tempDir('ordin-accept-')
    const verdict = await runAcceptance({ ticket: ticket(), report: report(['missing.md']), directory: dir })
    expect(verdict.status).toBe('rework')
    expect(verdict.reworkReason).toContain('missing.md')
  })

  it('sends back an empty file', async () => {
    const dir = tempDir('ordin-accept-')
    writeFileSync(join(dir, 'empty.md'), '', 'utf8')
    const verdict = await runAcceptance({ ticket: ticket(), report: report(['empty.md']), directory: dir })
    expect(verdict.status).toBe('rework')
    expect(verdict.reworkReason).toContain('empty')
  })

  it('sends back an escape path and never reads outside the directory', async () => {
    const dir = tempDir('ordin-accept-')
    const verdict = await runAcceptance({ ticket: ticket(), report: report(['../secret.txt']), directory: dir })
    expect(verdict.status).toBe('rework')
  })

  it('sends back an empty summary', async () => {
    const dir = tempDir('ordin-accept-')
    const verdict = await runAcceptance({ ticket: ticket(), report: report([], '   '), directory: dir })
    expect(verdict.status).toBe('rework')
    expect(verdict.reworkReason).toContain('empty')
  })

  it('reports unverified once the rework budget is used up', async () => {
    const dir = tempDir('ordin-accept-')
    const verdict = await runAcceptance({ ticket: ticket(['rework', 'rework']), report: report(['missing.md']), directory: dir })
    expect(verdict.status).toBe('unverified')
  })

  it('keeps every check result so the panel can show what failed', async () => {
    const dir = tempDir('ordin-accept-')
    const verdict = await runAcceptance({ ticket: ticket(), report: report(['missing.md']), directory: dir })
    expect(verdict.checks?.map(check => check.name)).toEqual(['result-nonempty', 'scope-respected', 'file-exists', 'file-readable'])
  })
})

describe('filesystem scope boundaries', () => {
  it.each(['normal', 'internal-leaf', 'internal-directory'])('accepts a nonempty internal file via %s', async kind => {
    const dir = tempDir('ordin-accept-')
    mkdirSync(join(dir, 'output'))
    writeFileSync(join(dir, 'output', 'result.md'), 'done', 'utf8')
    symlinkSync('output/result.md', join(dir, 'leaf.md'))
    symlinkSync('output', join(dir, 'linked-output'))
    const name = kind === 'normal' ? 'output/result.md' : kind === 'internal-leaf' ? 'leaf.md' : 'linked-output/result.md'
    const subject = { ticket: ticket(), report: report([name]), directory: dir }
    for (const check of [scopeRespected, fileExists, fileReadable]) expect((await check(subject)).passed).toBe(true)
    expect((await runAcceptance(subject)).status).toBe('accepted')
  })

  it.each(['external-leaf', 'external-directory', 'traversal'])('rejects a real external file via %s in each standalone check', async kind => {
    const root = tempDir('ordin-accept-')
    const dir = join(root, 'ticket')
    const outside = join(root, 'ticket-other')
    mkdirSync(dir)
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.md'), 'outside', 'utf8')
    symlinkSync(join(outside, 'secret.md'), join(dir, 'leaf.md'))
    symlinkSync(outside, join(dir, 'linked-output'))
    const name = kind === 'external-leaf' ? 'leaf.md' : kind === 'external-directory' ? 'linked-output/secret.md' : '../ticket-other/secret.md'
    const subject = { ticket: ticket(), report: report([name]), directory: dir }
    for (const check of [scopeRespected, fileExists, fileReadable]) {
      const result = await check(subject)
      expect(result.passed, result.name + ': ' + name).toBe(false)
      expect(result.detail).toContain(name)
    }
    expect((await runAcceptance(subject)).status).toBe('rework')
  })

  it('rejects a directory when readability is run alone', async () => {
    const dir = tempDir('ordin-accept-')
    mkdirSync(join(dir, 'output'))
    expect((await fileReadable({ ticket: ticket(), report: report(['output']), directory: dir })).passed).toBe(false)
  })
})

describe('individual checks', () => {
  it('each check answers a named verdict rather than throwing', async () => {
    const dir = tempDir('ordin-accept-')
    const subject = { ticket: ticket(), report: report(['x.md']), directory: dir }
    expect((await resultNonEmpty(subject)).name).toBe('result-nonempty')
    expect((await scopeRespected(subject)).passed).toBe(true)
    expect((await fileExists(subject)).passed).toBe(false)
    // A missing file is also unreadable; the two checks answer different questions for the panel.
    expect((await fileReadable(subject)).passed).toBe(false)
  })
})
