/**
 * Independent acceptance: the checks Ordin runs on a worker output before it may call the work done.
 *
 * Contract: docs/contracts/wp-0.4-acceptance.md. A worker ready report is a claim; these checks are the evidence.
 * Every check is deterministic and reads only the Ticket directory, so the verdict does not depend on the model.
 */
import { realpath, stat, open } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'
import type { AcceptanceCheckResult, TicketAcceptance } from '../types/index.ts'
import type { Report, Ticket } from '../core/model.ts'

/** How many times one Ticket may be sent back before its result is delivered as unverified. */
export const MAX_REWORK = 2

/** The narrow facts a check may read. A directory plus the report it is judging. */
export interface AcceptanceSubject {
  readonly ticket: Ticket
  readonly report: Report
  readonly directory: string
}

export type Check = (subject: AcceptanceSubject) => Promise<AcceptanceCheckResult>

const inside = (directory: string, name: string): string | undefined => {
  if (name.trim() === '' || isAbsolute(name)) return undefined
  const target = resolve(directory, name)
  const base = resolve(directory)
  return target === base || target.startsWith(base + sep) ? target : undefined
}

/** Resolve both boundaries before stat/open so leaf and directory links cannot escape.
 * This assumes a stable filesystem; realpath followed by stat/open is not an atomic sandbox.
 */
const realInside = async (directory: string, name: string): Promise<string | undefined> => {
  const target = inside(directory, name)
  if (target === undefined) return undefined
  try {
    const base = await realpath(directory)
    const actual = await realpath(target)
    return actual === base || actual.startsWith(base + sep) ? actual : undefined
  } catch { return undefined }
}

/** Every file the report named must exist, be a regular file, and hold at least one byte. */
export const fileExists: Check = async subject => {
  const missing: string[] = []
  const empty: string[] = []
  for (const name of subject.report.files ?? []) {
    const target = await realInside(subject.directory, name)
    if (target === undefined) { missing.push(name + " (outside the ticket directory)"); continue }
    const info = await stat(target).catch(() => undefined)
    if (info === undefined || !info.isFile()) { missing.push(name); continue }
    if (info.size === 0) empty.push(name)
  }
  const failed = [...missing.map(name => `missing: ${name}`), ...empty.map(name => `empty: ${name}`)]
  return failed.length === 0 ? { name: 'file-exists', passed: true } : { name: 'file-exists', passed: false, detail: failed.join('; ') }
}

/** A named file must be readable; a directory answers false rather than throwing. */
export const fileReadable: Check = async subject => {
  const unreadable: string[] = []
  for (const name of subject.report.files ?? []) {
    const target = await realInside(subject.directory, name)
    if (target === undefined) { unreadable.push(name); continue }
    try {
      const handle = await open(target, 'r')
      try {
        if (!(await handle.stat()).isFile()) unreadable.push(name)
      } finally { await handle.close() }
    } catch { unreadable.push(name) }
  }
  return unreadable.length === 0 ? { name: 'file-readable', passed: true } : { name: 'file-readable', passed: false, detail: `unreadable: ${unreadable.join(', ')}` }
}

/** The worker must have said something: a ready with no text is a claim with no content. */
export const resultNonEmpty: Check = async subject => {
  const summary = (subject.report.summary ?? '').trim()
  return summary === '' ? { name: 'result-nonempty', passed: false, detail: 'the report summary is empty' } : { name: 'result-nonempty', passed: true }
}

/** Every artifact must live inside the Ticket directory: a path outside it belongs to somebody else. */
export const scopeRespected: Check = async subject => {
  const escapes: string[] = []
  for (const name of subject.report.files ?? []) {
    const target = inside(subject.directory, name)
    if (target === undefined) { escapes.push(name); continue }
    // Missing artifacts are diagnosed by fileExists; scope still rejects every resolvable escape.
    if (await realpath(target).catch(() => undefined) === undefined) continue
    if (await realInside(subject.directory, name) === undefined) escapes.push(name)
  }
  return escapes.length === 0 ? { name: 'scope-respected', passed: true } : { name: 'scope-respected', passed: false, detail: `outside the ticket directory: ${escapes.join(', ')}` }
}

/** The default set, in the order the panel shows them. */
export const DEFAULT_CHECKS: readonly Check[] = [resultNonEmpty, scopeRespected, fileExists, fileReadable]

/** How many attempts have already been sent back for rework, read off the assignment history. */
export const reworksSoFar = (ticket: Ticket): number =>
  ticket.assignments.filter(assignment => assignment.endedReason === 'rework').length

/**
 * Run the checks and decide: accepted when every check passes; rework while attempts remain; unverified when they do
 * not. A report that names no files cannot be verified beyond its text, which the panel states rather than hides.
 */
export async function runAcceptance(
  subject: AcceptanceSubject,
  checks: readonly Check[] = DEFAULT_CHECKS,
  limit: number = MAX_REWORK,
): Promise<TicketAcceptance> {
  const results: AcceptanceCheckResult[] = []
  for (const check of checks) {
    try {
      results.push(await check(subject))
    } catch (error) {
      results.push({ name: 'check-error', passed: false, detail: error instanceof Error ? error.message : String(error) })
    }
  }
  const failed = results.filter(result => !result.passed)
  const at = new Date().toISOString()
  if (failed.length === 0 && checks === DEFAULT_CHECKS && (subject.report.files?.length ?? 0) === 0) {
    return { status: 'unverified', checks: results, checkedAt: at, reworkReason: 'No files or task-specific checks were supplied; only the report text was checked' }
  }
  if (failed.length === 0) return { status: 'accepted', checks: results, checkedAt: at }
  const reason = failed.map(result => result.detail ?? result.name).join('; ')
  if (reworksSoFar(subject.ticket) < limit) return { status: 'rework', checks: results, checkedAt: at, reworkReason: reason }
  return { status: 'unverified', checks: results, checkedAt: at, reworkReason: reason }
}
