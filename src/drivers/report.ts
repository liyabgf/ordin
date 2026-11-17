/** L1 worker report protocol: exactly one fenced ordin-report block in final text. */
import type { Report, ReportState } from '../core/model.ts'

const STATES = new Set<ReportState>(['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped'])
const FENCE = '\u0060\u0060\u0060'
const BLOCK_RE = new RegExp(FENCE + 'ordin-report[ \\t]*\\n([\\s\\S]*?)\\n?' + FENCE, 'g')

export type ParsedWorkerReport =
  | { readonly kind: 'none' }
  | { readonly kind: 'valid'; readonly report: Report }
  | { readonly kind: 'invalid'; readonly error: string }

export function parseWorkerReport(text: string, at: string): ParsedWorkerReport {
  const blocks = [...text.matchAll(BLOCK_RE)]
  if (blocks.length === 0) return { kind: 'none' }
  if (blocks.length !== 1) return { kind: 'invalid', error: `expected exactly one ordin-report block, got ${blocks.length}` }
  let value: unknown
  try { value = JSON.parse(blocks[0]![1]!) } catch (error) { return { kind: 'invalid', error: `invalid report JSON: ${error instanceof Error ? error.message : String(error)}` } }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { kind: 'invalid', error: 'report must be an object' }
  const candidate = value as { state?: unknown; summary?: unknown; question?: unknown; files?: unknown }
  if (typeof candidate.state !== 'string' || !STATES.has(candidate.state as ReportState)) return { kind: 'invalid', error: `invalid report state: ${String(candidate.state)}` }
  if (typeof candidate.summary !== 'string' || candidate.summary.trim() === '') return { kind: 'invalid', error: 'report summary must be non-empty' }
  const state = candidate.state as ReportState
  if (['waiting', 'blocked', 'failed'].includes(state) && (typeof candidate.question !== 'string' || candidate.question.trim() === '')) {
    return { kind: 'invalid', error: `${state} report requires a non-empty question` }
  }
  if (candidate.files !== undefined && (!Array.isArray(candidate.files) || candidate.files.some(file => typeof file !== 'string' || file.trim() === ''))) {
    return { kind: 'invalid', error: 'report files must be an array of non-empty strings' }
  }
  return {
    kind: 'valid',
    report: {
      state,
      summary: candidate.summary,
      at,
      ...(typeof candidate.question === 'string' && candidate.question.trim() !== '' ? { question: candidate.question } : {}),
      ...(candidate.files === undefined ? {} : { files: candidate.files as string[] }),
    },
  }
}
