import type { Ticket, TicketOutcome } from '../core/model.ts'
import type { BackendKind, DriverHealth } from '../drivers/types.ts'
import { Conversations, taskSelectionAllowed } from './conversations.ts'
import type { Store } from './store.ts'

const PROBE_FRESH_MS = 15 * 60_000
const TASK_RECEIPT_MAX_AGE_MS = 7 * 24 * 60 * 60_000
const TASK_RECEIPT_LIMIT = 10

type ProbeWarning = 'degraded-capability' | 'authentication-unverified' | 'version-unavailable' | 'execution-unverified' | 'other'

function warningSignal(warning: string): ProbeWarning {
  if (warning.startsWith('degraded_capability:')) return 'degraded-capability'
  if (warning.startsWith('DEEPSEEK_API_KEY not visible to probe;')) return 'authentication-unverified'
  if (warning.startsWith('dsh --version unavailable (diagnostic only):')) return 'version-unavailable'
  if (warning === 'DSH service owns model and permissions; service access verified, execution requires a task receipt') return 'execution-unverified'
  return 'other'
}

function observedTime(value: string | undefined, now: number) {
  const time = value === undefined ? NaN : Date.parse(value)
  return Number.isFinite(time) && time <= now ? { at: new Date(time).toISOString(), ageMs: now - time } : null
}

function summarizeProbe(selected: BackendKind, health: DriverHealth | null, now: number) {
  const observed = health?.backend === selected ? observedTime(health.checkedAt, now) : null
  if (!observed || !health) return { state: 'unknown', lastResult: null, observedAt: null, ageMs: null, freshness: 'unobserved', warnings: [] } as const
  const lastResult = health.ok ? 'passed' : 'failed'
  const fresh = observed.ageMs <= PROBE_FRESH_MS
  // Driver diagnostics may include paths, credentials, command output and remote errors. Only fixed signals cross this boundary.
  return {
    state: fresh ? lastResult : 'unknown', lastResult, observedAt: observed.at, ageMs: observed.ageMs,
    freshness: fresh ? 'fresh' : 'stale', warnings: [...new Set(health.warnings?.map(warningSignal))],
  } as const
}

function receipt(ticket: Ticket, now: number) {
  const attempt = ticket.assignments.findLast(assignment => assignment.role !== 'triage' && observedTime(assignment.startedAt, now) !== null)
  if (!attempt) return []
  const observed = observedTime(attempt.endedAt ?? attempt.startedAt, now)
  if (!observed || observed.ageMs > TASK_RECEIPT_MAX_AGE_MS) return []
  const outcome: TicketOutcome | undefined = ticket.ended?.outcome
  return [{ ticketId: ticket.id, observedAt: observed.at, assignmentState: attempt.state, outcome: outcome ?? null }]
}

interface ManagerHealthInput {
  readonly store: Store
  readonly selected: BackendKind
  readonly configured?: boolean
  readonly health: DriverHealth | null
  readonly conversationId: string
  readonly now?: number
}

/** Read-only snapshot of just the current selection, its last process-local probe and recent durable task receipts. */
export function inspectManagerHealth({ store, selected, configured, health, conversationId, now = Date.now() }: ManagerHealthInput) {
  new Conversations(store).assertWritable(conversationId)
  const taskReceipts = store.tickets.list()
    .filter(ticket => ticket.workerBackend === selected && ticket.conversationId === conversationId && taskSelectionAllowed(store, ticket))
    .flatMap(ticket => receipt(ticket, now))
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt))
    .slice(0, TASK_RECEIPT_LIMIT)
  return {
    backend: selected,
    configuration: configured === undefined ? 'unknown' : configured ? 'configured' : 'not-configured',
    configurationSource: configured === undefined ? null : 'saved-connection-settings',
    probeFreshForMs: PROBE_FRESH_MS,
    probe: summarizeProbe(selected, health, now),
    taskEvidenceScope: 'current-conversation',
    taskReceiptWindowMs: TASK_RECEIPT_MAX_AGE_MS,
    taskEvidence: taskReceipts.length > 0 ? 'recent-task-receipt' : 'unknown',
    taskReceipts,
  } as const
}
