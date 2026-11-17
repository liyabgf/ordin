/**
 * The Store: one SQLite database, the domain's repositories, the settings and prompt revisions, and the transaction
 * boundary every command writes inside.
 *
 * `node:sqlite` keeps this dependency-free: no native module to build, and the same file the panel reads. Each kind of
 * state has one writer — the Engine writes Triggers, Decisions, Tickets and Assignments; a Source writes its own read
 * position through `kv`; Settings and Prompts write their revisions; Effects writes its rows.
 */
import { DatabaseSync, type StatementResultingChanges } from 'node:sqlite'
import { DeskHistory } from './desk-history.ts'
import { closeSync, fsyncSync, mkdirSync, openSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { waitsForPerson, type Decision, type Ticket, type Trigger } from '../core/model.ts'
import type { Artifact, Dependency, Disposition, Project, Thread, TicketEvent, Work } from '../core/model.ts'
import type { DecisionRepository, DependencyRepository, EventRepository, LostTrigger, ProjectRepository, TicketRepository, TriggerRecord, TriggerRepository, WorkRepository, ThreadRepository } from '../core/engine.ts'
import type { Transaction, InputConsumption, InputConsumptionRepository } from '../core/engine.ts'
import { parseSettings, type Settings } from '../core/policy.ts'

/** The schema this build writes; a database of a newer schema is refused rather than misread. */
export const SCHEMA_VERSION = 9
const WORKER_PROGRESS_KEEP = 500
const WORKER_PROGRESS_TYPES = "'worker_text', 'worker_tool', 'worker_usage', 'worker_phase'"

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS triggers (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  at TEXT NOT NULL,
  disposition TEXT NOT NULL,
  record TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS triggers_at ON triggers (at);
CREATE TABLE IF NOT EXISTS threads (
  key TEXT PRIMARY KEY,
  record TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  createdAt TEXT NOT NULL,
  open INTEGER NOT NULL,
  record TEXT NOT NULL,
  workId TEXT GENERATED ALWAYS AS (json_extract(record, '$.workId')) VIRTUAL,
  workSeq INTEGER GENERATED ALWAYS AS (json_extract(record, '$.workSeq')) VIRTUAL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS tickets_open ON tickets (open, createdAt);
CREATE INDEX IF NOT EXISTS tickets_work ON tickets (workId, workSeq);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  record TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS works (
  id TEXT PRIMARY KEY,
  projectId TEXT,
  name TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  record TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS works_project ON works (projectId, createdAt);
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  triggerId TEXT NOT NULL,
  at TEXT NOT NULL,
  outcome TEXT NOT NULL,
  record TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS decisions_at ON decisions (at);
CREATE TABLE IF NOT EXISTS effects (
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  payload TEXT NOT NULL,
  dueAt INTEGER NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0,
  running INTEGER NOT NULL DEFAULT 0,
  generation TEXT NOT NULL,
  claimToken TEXT,
  PRIMARY KEY (kind, key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS effects_due ON effects (dueAt, kind);
CREATE TABLE IF NOT EXISTS artifacts (
  ticketId TEXT NOT NULL,
  path TEXT NOT NULL,
  at TEXT NOT NULL,
  record TEXT NOT NULL,
  PRIMARY KEY (ticketId, path)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS artifacts_ticket ON artifacts (ticketId, at);
CREATE TABLE IF NOT EXISTS events (
  ticketId TEXT NOT NULL,
  seq INTEGER NOT NULL,
  at TEXT NOT NULL,
  type TEXT NOT NULL,
  record TEXT NOT NULL,
  PRIMARY KEY (ticketId, seq)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS events_at ON events (at);
CREATE TABLE IF NOT EXISTS ticket_deps (
  upstream TEXT NOT NULL,
  downstream TEXT NOT NULL,
  record TEXT NOT NULL,
  PRIMARY KEY (upstream, downstream)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS deps_downstream ON ticket_deps (downstream);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  profileId TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  lastMessageAt TEXT NOT NULL,
  record TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS conversations_profile ON conversations (profileId, lastMessageAt);
CREATE TABLE IF NOT EXISTS conversation_messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  conversationId TEXT NOT NULL,
  at TEXT NOT NULL,
  role TEXT NOT NULL,
  record TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS conversation_messages_conversation ON conversation_messages (conversationId, seq);
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  record TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS assets_kind ON assets (kind, updatedAt);
CREATE INDEX IF NOT EXISTS assets_archived ON assets (archived, updatedAt);
CREATE TABLE IF NOT EXISTS memory_entries (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  scope TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  record TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS memory_entries_scope ON memory_entries (scope, kind, updatedAt);
`

/** A row of `kv`: a typed record with the family that owns it. */
export const KV = {
  sourceConsumption: (identity: string) => `source:consumed:${encodeURIComponent(identity)}` as const,
  /** A Source's read position, written only by that Source: `source:<id>:cursor`. */
  sourceCursor: (id: string) => `source:${id}:cursor` as const,
  /** The stored settings document: `settings:document`. */
  settingsDocument: 'settings:document' as const,
  /** The front desk's actual Session id, which DSH chooses and this system records. */
  mainSession: 'main-session:id' as const,
  /** The settings revision counter. */
  settingsRevision: 'settings:revision' as const,
  /** How many times this Ticket has been relaunched after a turn that died in an upstream error. */
  autoRetry: (ticketId: string) => `auto-retry:${ticketId}` as const,
  /** The operator's decision queue: items parked there wait for a person, and the panel shows them. */
  operatorQueue: 'operator:queue' as const,
  /** That one attempt has already been told its runtime budget is up: `budget:nudge:<ticket>:<attempt>`. */
  budgetNudge: (ticketId: string, assignmentId: string) => `budget:nudge:${ticketId}:${assignmentId}` as const,
  /** The team's prompt overrides: `prompts:config`. */
  promptsConfig: 'prompts:config' as const,
  /** The prompt revision counter. */
  promptsRevision: 'prompts:revision' as const,
  /** The prompt revision a Session last ran under: `prompts:session:<id>`. */
  promptSession: (sessionId: string) => `prompts:session:${sessionId}` as const,
  /** The payloads the queue gave up on that were not recognizable as a Trigger: `triggers:lost`. */
  lostTriggers: 'triggers:lost' as const,
  terminalReceipt: (id: string) => `effects:terminal:${encodeURIComponent(id)}` as const,
} as const

/**
 * How many given-up payloads `KV.lostTriggers` keeps, and how much text of each.
 *
 * Bounded because the whole list is one `kv` value and `set` rewrites it whole: an unbounded one would grow a single
 * row forever and re-copy all of it on every loss, which is half of what §4.35 rejected `kv` for. Twenty is a day of a
 * producer broken on every firing — enough that a person who opens the file afterwards finds the run rather than only
 * its last minute — at a worst case of twenty thousand characters, which is small enough that rewriting the value per
 * loss costs nothing.
 *
 * A thousand characters per payload cuts only a payload that was already long: a rule Trigger serializes to 275, and
 * what an inbox or chat Trigger carries in `text` is a request a person wrote, so a bound has to exist for it. `chars`
 * records the whole length, so a cut says it was cut.
 */
export const LOST_TRIGGER_KEEP = 20
export const LOST_TRIGGER_CHARS = 1000

/**
 * One payload the queue gave up on that was not recognizable as a Trigger.
 *
 * `payload` is the beginning of the text and `chars` the length of all of it, so a reader can tell a payload that was
 * short from one that was cut.
 */
export interface LostPayload {
  readonly at: string
  readonly effectKey: string
  readonly error: string
  readonly chars: number
  readonly payload: string
}

/** Thrown when the database was written by a newer build, which this one must not misread. */
/**
 * One step per version, keyed by the version it upgrades TO.
 *
 * A fresh database is created at the newest shape by `SCHEMA` and then stamped, so a step can be run against a file
 * that already has the shape it produces: every step must be idempotent (`IF NOT EXISTS`, nullable or defaulted
 * `ADD COLUMN`, `WHERE … IS NULL` backfills) and must never rewrite an existing record blob or drop a live table.
 */
const MIGRATIONS: Record<number, (db: DatabaseSync) => void> = {
  // Version 2 adds the artifact registry. Additive only: every column is new, no existing table changes shape, and no
  // existing record is rewritten. Rolling back is therefore exactly `UPDATE schema_version SET version = 1` — valid
  // because the older build neither reads nor writes the new table — and this step also drops the `settings` table
  // that no build has ever read or written, so no live table is ever dropped.
  2: db => {
    db.exec(`CREATE TABLE IF NOT EXISTS artifacts (
  ticketId TEXT NOT NULL,
  path TEXT NOT NULL,
  at TEXT NOT NULL,
  record TEXT NOT NULL,
  PRIMARY KEY (ticketId, path)
) WITHOUT ROWID`)
    db.exec('CREATE INDEX IF NOT EXISTS artifacts_ticket ON artifacts (ticketId, at)')
    db.exec('DROP TABLE IF EXISTS settings')
  },
  // Version 3 adds Project and Work. Still additive: two new tables, and two GENERATED VIRTUAL columns on `tickets`
  // rather than promoted ones. A promoted column is written by the save path and can silently diverge from the record
  // it came from — an older build's `save` would leave it stale and every index on it would then lie. A generated
  // column is read out of the record on every query, so it cannot disagree with it.
  3: db => {
    db.exec(`CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  record TEXT NOT NULL
) WITHOUT ROWID`)
    db.exec(`CREATE TABLE IF NOT EXISTS works (
  id TEXT PRIMARY KEY,
  projectId TEXT,
  name TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  record TEXT NOT NULL
) WITHOUT ROWID`)
    db.exec('CREATE INDEX IF NOT EXISTS works_project ON works (projectId, createdAt)')
    // SQLite has no `ADD COLUMN IF NOT EXISTS`, and a fresh database already has both columns from `SCHEMA`.
    // `table_xinfo`, not `table_info`: a generated VIRTUAL column is hidden, and `table_info` omits hidden columns, so
    // it would report the column as absent and the step would fail with "duplicate column name" on a fresh install.
    const columns = (db.prepare('PRAGMA table_xinfo(tickets)').all() as { name: string }[]).map(row => row.name)
    if (!columns.includes('workId')) {
      db.exec("ALTER TABLE tickets ADD COLUMN workId TEXT GENERATED ALWAYS AS (json_extract(record, '$.workId')) VIRTUAL")
    }
    if (!columns.includes('workSeq')) {
      db.exec("ALTER TABLE tickets ADD COLUMN workSeq INTEGER GENERATED ALWAYS AS (json_extract(record, '$.workSeq')) VIRTUAL")
    }
    db.exec('CREATE INDEX IF NOT EXISTS tickets_work ON tickets (workId, workSeq)')
  },
  // Version 4 adds the per-Ticket event log. Additive again: one new table, one new index, nothing existing changes.
  4: db => {
    db.exec(`CREATE TABLE IF NOT EXISTS events (
  ticketId TEXT NOT NULL,
  seq INTEGER NOT NULL,
  at TEXT NOT NULL,
  type TEXT NOT NULL,
  record TEXT NOT NULL,
  PRIMARY KEY (ticketId, seq)
) WITHOUT ROWID`)
    db.exec('CREATE INDEX IF NOT EXISTS events_at ON events (at)')
  },
  // Version 5 adds the dependency edges between Tickets. Additive: one new table, one new index.
  5: db => {
    db.exec(`CREATE TABLE IF NOT EXISTS ticket_deps (
  upstream TEXT NOT NULL,
  downstream TEXT NOT NULL,
  record TEXT NOT NULL,
  PRIMARY KEY (upstream, downstream)
) WITHOUT ROWID`)
    db.exec('CREATE INDEX IF NOT EXISTS deps_downstream ON ticket_deps (downstream)')
  },
  // 【W8】Version 6 adds the threads table for Thread+Subscription (W8-W12).
  6: db => {
    db.exec(`CREATE TABLE IF NOT EXISTS threads (
  key TEXT PRIMARY KEY,
  record TEXT NOT NULL
) WITHOUT ROWID`)
  },
  // 【D3】Version 7 adds the desk conversation history (DeskLoop messages).
  // Additive: one new table. Each row is one message in the desk's conversation with the LLM,
  // in insertion order (seq). role ∈ {'system','user','assistant','tool'}. tool_calls and
  // tool_call_id support function-calling turns. ticketId ties each message to the Ticket that
  // triggered this desk turn (null for system messages). requestId deduplicates relay/notify
  // entries so an effect that is retried does not add a second row.
  7: db => {
    db.exec(`CREATE TABLE IF NOT EXISTS desk_messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool_calls TEXT,
  tool_call_id TEXT,
  name TEXT,
  ticketId TEXT,
  requestId TEXT,
  at TEXT NOT NULL
)`)
    db.exec('CREATE INDEX IF NOT EXISTS desk_messages_at ON desk_messages (at)')
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS desk_messages_request ON desk_messages (requestId) WHERE requestId IS NOT NULL')
  },
  // Version 8 adds the coordinator model: conversations, their messages, data assets, and long-term memory.
  // Additive only: four new tables, no existing table changes shape. Rolling back is `UPDATE schema_version SET version = 7`
  // because the older build neither reads nor writes the new tables. Ticket acceptance/plan/workerBackend live inside
  // the existing `tickets.record` JSON and need no migration.
  8: db => {
    db.exec(`CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  profileId TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  lastMessageAt TEXT NOT NULL,
  record TEXT NOT NULL
) WITHOUT ROWID`)
    db.exec('CREATE INDEX IF NOT EXISTS conversations_profile ON conversations (profileId, lastMessageAt)')
    db.exec(`CREATE TABLE IF NOT EXISTS conversation_messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  conversationId TEXT NOT NULL,
  at TEXT NOT NULL,
  role TEXT NOT NULL,
  record TEXT NOT NULL
)`)
    db.exec('CREATE INDEX IF NOT EXISTS conversation_messages_conversation ON conversation_messages (conversationId, seq)')
    db.exec(`CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  record TEXT NOT NULL
) WITHOUT ROWID`)
    db.exec('CREATE INDEX IF NOT EXISTS assets_kind ON assets (kind, updatedAt)')
    db.exec('CREATE INDEX IF NOT EXISTS assets_archived ON assets (archived, updatedAt)')
    db.exec(`CREATE TABLE IF NOT EXISTS memory_entries (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  scope TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  record TEXT NOT NULL
) WITHOUT ROWID`)
    db.exec('CREATE INDEX IF NOT EXISTS memory_entries_scope ON memory_entries (scope, kind, updatedAt)')
  },
  // Add ownership without rewriting payloads or retry budgets. Old in-flight work is retried after upgrade.
  9: db => {
    db.exec('CREATE TABLE IF NOT EXISTS effects (kind TEXT NOT NULL, key TEXT NOT NULL, payload TEXT NOT NULL, dueAt INTEGER NOT NULL, failures INTEGER NOT NULL DEFAULT 0, running INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(kind,key)) WITHOUT ROWID')
    const columns = db.prepare('PRAGMA table_xinfo(effects)').all().map(row => row.name)
    if (!columns.includes('generation')) db.exec("ALTER TABLE effects ADD COLUMN generation TEXT NOT NULL DEFAULT ''")
    if (!columns.includes('claimToken')) db.exec('ALTER TABLE effects ADD COLUMN claimToken TEXT')
    const rows = db.prepare("SELECT kind, key FROM effects WHERE generation = ''").all()
    const backfill = db.prepare('UPDATE effects SET generation = ?, running = 0, claimToken = NULL WHERE kind = ? AND key = ?')
    for (const row of rows) backfill.run(randomUUID(), row.kind!, row.key!)
    db.exec('UPDATE effects SET running = 0, claimToken = NULL')
  },
}

export class SchemaTooNew extends Error {
  constructor(readonly found: number) {
    super(`This database was written by schema ${found}; this build writes schema ${SCHEMA_VERSION}. Upgrade ordin before starting it.`)
    this.name = 'SchemaTooNew'
  }
}

const read = <T>(text: string): T => JSON.parse(text) as T
const written = (value: unknown): string => JSON.stringify(value)

class Dependencies implements DependencyRepository {
  // Every query here orders by an endpoint rather than by `rowid`: `ticket_deps` is WITHOUT ROWID, so it has none, and
  // asking for one is a runtime error no type check can see. Edge order is not a fact anybody depends on.
  constructor(private readonly db: DatabaseSync) {}
  save(dependency: Dependency): void {
    this.db.prepare('INSERT INTO ticket_deps (upstream, downstream, record) VALUES (?, ?, ?) '
      + 'ON CONFLICT (upstream, downstream) DO UPDATE SET record = excluded.record')
      .run(dependency.upstream, dependency.downstream, written(dependency))
  }
  delete(upstream: string, downstream: string): void {
    this.db.prepare('DELETE FROM ticket_deps WHERE upstream = ? AND downstream = ?').run(upstream, downstream)
  }
  /** What a Ticket is waiting for, in the order the edges were written. */
  upstreamOf(downstream: string): Dependency[] {
    return (this.db.prepare('SELECT record FROM ticket_deps WHERE downstream = ? ORDER BY upstream').all(downstream) as { record: string }[])
      .map(row => read<Dependency>(row.record))
  }
  /** What waits for a Ticket, which is what releasing dependants reads. */
  downstreamOf(upstream: string): Dependency[] {
    return (this.db.prepare('SELECT record FROM ticket_deps WHERE upstream = ? ORDER BY downstream').all(upstream) as { record: string }[])
      .map(row => read<Dependency>(row.record))
  }
  /** Every edge, which is what a cycle check has to walk. */
  list(): Dependency[] {
    return (this.db.prepare('SELECT record FROM ticket_deps ORDER BY upstream, downstream').all() as { record: string }[])
      .map(row => read<Dependency>(row.record))
  }
}

class Events implements EventRepository {
  constructor(private readonly db: DatabaseSync) {}

  append(event: Omit<TicketEvent, 'seq'>): TicketEvent {
    const row = this.db.prepare('SELECT max(seq) AS highest FROM events WHERE ticketId = ?').get(event.ticketId) as
      | { highest: number | null } | undefined
    const stored: TicketEvent = { ...event, seq: (row?.highest ?? 0) + 1 }
    this.db.prepare('INSERT INTO events (ticketId, seq, at, type, record) VALUES (?, ?, ?, ?, ?) '
      + 'ON CONFLICT (ticketId, seq) DO UPDATE SET at = excluded.at, type = excluded.type, record = excluded.record')
      .run(stored.ticketId, stored.seq, stored.at, stored.type, written(stored))
    if (stored.type.startsWith('worker_')) {
      // Worker output can be frequent. Keep a bounded recent window for each Ticket without pruning its domain history.
      this.db.prepare(`DELETE FROM events WHERE ticketId = ? AND type IN (${WORKER_PROGRESS_TYPES}) AND seq NOT IN (
        SELECT seq FROM events WHERE ticketId = ? AND type IN (${WORKER_PROGRESS_TYPES}) ORDER BY seq DESC LIMIT ?
      )`).run(stored.ticketId, stored.ticketId, WORKER_PROGRESS_KEEP)
    }
    return stored
  }

  list(ticketId: string): TicketEvent[] {
    return (this.db.prepare('SELECT record FROM events WHERE ticketId = ? ORDER BY seq').all(ticketId) as { record: string }[])
      .map(row => read<TicketEvent>(row.record))
  }
}

/** 【W8】Thread repository: stores Thread aggregates for Subscription fan-out. */
class Threads implements ThreadRepository {
  constructor(private readonly db: DatabaseSync) {}

  get(key: string): Thread | undefined {
    const row = this.db.prepare('SELECT record FROM threads WHERE key = ?').get(key) as { record: string } | undefined
    return row === undefined ? undefined : read<Thread>(row.record)
  }

  save(thread: Thread): void {
    this.db.prepare('INSERT INTO threads (key, record) VALUES (?, ?) '
      + 'ON CONFLICT(key) DO UPDATE SET record = excluded.record')
      .run(thread.key, written(thread))
  }

  list(): Thread[] {
    return (this.db.prepare('SELECT record FROM threads').all() as { record: string }[])
      .map(row => read<Thread>(row.record))
  }
}

class Artifacts {
  constructor(private readonly db: DatabaseSync) {}

  /** Upsert one artifact: re-registering a path replaces what an earlier report claimed about it. */
  save(artifact: Artifact): void {
    this.db.prepare(
      'INSERT INTO artifacts (ticketId, path, at, record) VALUES (?, ?, ?, ?) '
      + 'ON CONFLICT (ticketId, path) DO UPDATE SET at = excluded.at, record = excluded.record',
    ).run(artifact.ticketId, artifact.path, artifact.at, written(artifact))
  }

  /** A Ticket's artifacts in the order their registering reports arrived. */
  list(ticketId: string): Artifact[] {
    const rows = this.db.prepare('SELECT record FROM artifacts WHERE ticketId = ? ORDER BY at').all(ticketId) as { record: string }[]
    return rows.map(row => read<Artifact>(row.record))
  }
}

class Triggers implements TriggerRepository {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * How many of each source's Triggers ended in each disposition, counted from the record itself.
   *
   * A Source's own counters live in instance memory, and an instance is thrown away by every settings save that
   * touches its block, so they read as cumulative in the panel while being per-process. The record is the only thing
   * that survives a restart, so it is what these numbers mean.
   */
  countBySource(): Record<string, Record<string, number>> {
    const rows = this.db.prepare(
      "SELECT source, json_extract(disposition, '$.state') AS state, count(*) AS total FROM triggers GROUP BY source, state",
    ).all() as { source: string; state: string; total: number }[]
    const counted: Record<string, Record<string, number>> = {}
    for (const row of rows) (counted[row.source] ??= {})[row.state] = row.total
    return counted
  }
  get(id: string): TriggerRecord | undefined {
    const row = this.db.prepare('SELECT record, disposition FROM triggers WHERE id = ?').get(id) as
      | { record: string; disposition: string } | undefined
    if (row === undefined) return undefined
    return { trigger: read<Trigger>(row.record), disposition: read<Disposition>(row.disposition) }
  }
  save(record: TriggerRecord): void {
    this.db.prepare(`INSERT INTO triggers (id, source, kind, at, disposition, record) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET disposition = excluded.disposition, record = excluded.record`)
      .run(record.trigger.id, record.trigger.source, record.trigger.kind, record.trigger.at,
        written(record.disposition), written(record.trigger))
  }
  /**
   * Store a Trigger the queue gave up on, with the payload verbatim in `record`.
   *
   * `DO NOTHING` on a conflict rather than the update `save` does, and the row it protects is a true one: the other way
   * a `trigger` effect fails permanently is the Store itself failing, so the read at the top of `receive` can throw over
   * a row that is already there saying `accepted`, with a Ticket behind it. Updating would replace work that exists
   * with a claim that it was dropped. The other row a conflict can find is the one an earlier give-up of the same
   * effect wrote — the same fact, with the error it had then — so a re-delivery of a failing effect adds no second row
   * and rewrites nothing.
   */
  insertLost(lost: LostTrigger): void {
    const disposition: Disposition = { state: 'lost', error: lost.error, effectKey: lost.effectKey }
    this.db.prepare(`INSERT INTO triggers (id, source, kind, at, disposition, record) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO NOTHING`)
      .run(lost.id, lost.source, lost.kind, lost.at, written(disposition), lost.raw)
  }
  list(): TriggerRecord[] {
    const rows = this.db.prepare('SELECT record, disposition FROM triggers ORDER BY at').all() as
      { record: string; disposition: string }[]
    return rows.map(row => ({ trigger: read<Trigger>(row.record), disposition: read<Disposition>(row.disposition) }))
  }
  /** Triggers since `at`, newest first, for the panel's flow counts. */
  since(at: string, limit = 200): TriggerRecord[] {
    const rows = this.db.prepare('SELECT record, disposition FROM triggers WHERE at >= ? ORDER BY at DESC LIMIT ?')
      .all(at, limit) as { record: string; disposition: string }[]
    return rows.map(row => ({ trigger: read<Trigger>(row.record), disposition: read<Disposition>(row.disposition) }))
  }
}

class Projects implements ProjectRepository {
  constructor(private readonly db: DatabaseSync) {}
  save(project: Project): void {
    this.db.prepare('INSERT INTO projects (id, name, createdAt, record) VALUES (?, ?, ?, ?) '
      + 'ON CONFLICT (id) DO UPDATE SET name = excluded.name, record = excluded.record')
      .run(project.id, project.name, project.createdAt, written(project))
  }
  get(id: string): Project | undefined {
    const row = this.db.prepare('SELECT record FROM projects WHERE id = ?').get(id) as { record: string } | undefined
    return row === undefined ? undefined : read<Project>(row.record)
  }
  list(): Project[] {
    return (this.db.prepare('SELECT record FROM projects ORDER BY createdAt').all() as { record: string }[])
      .map(row => read<Project>(row.record))
  }
  remove(id: string): void { this.db.prepare('DELETE FROM projects WHERE id = ?').run(id) }
}

class Works implements WorkRepository {
  constructor(private readonly db: DatabaseSync) {}
  save(work: Work): void {
    this.db.prepare('INSERT INTO works (id, projectId, name, createdAt, record) VALUES (?, ?, ?, ?, ?) '
      + 'ON CONFLICT (id) DO UPDATE SET projectId = excluded.projectId, name = excluded.name, record = excluded.record')
      .run(work.id, work.projectId ?? null, work.name, work.createdAt, written(work))
  }
  get(id: string): Work | undefined {
    const row = this.db.prepare('SELECT record FROM works WHERE id = ?').get(id) as { record: string } | undefined
    return row === undefined ? undefined : read<Work>(row.record)
  }
  list(): Work[] {
    return (this.db.prepare('SELECT record FROM works ORDER BY createdAt').all() as { record: string }[])
      .map(row => read<Work>(row.record))
  }
  byProject(projectId: string | undefined): Work[] {
    // `IS ?` matches a NULL projectId, which is how "in no Project" is asked for; `= ?` would never match NULL.
    return (this.db.prepare('SELECT record FROM works WHERE projectId IS ? ORDER BY createdAt').all(projectId ?? null) as { record: string }[])
      .map(row => read<Work>(row.record))
  }
  remove(id: string): void { this.db.prepare('DELETE FROM works WHERE id = ?').run(id) }
}

class Conversations {
  constructor(private readonly db: DatabaseSync) {}
  save(conversation: { id: string; profileId?: string; createdAt: string; lastMessageAt: string; title?: string; archivedAt?: string; deletedAt?: string; revision?: number }): void {
    const existing = this.get(conversation.id)
    if (existing !== undefined && conversation.profileId !== undefined && conversation.profileId !== existing.profileId) throw new Error('Conversation profile cannot be reassigned')
    conversation = { ...existing, ...conversation, profileId: conversation.profileId ?? (typeof existing?.profileId === 'string' ? existing.profileId : 'default') }
    this.db.prepare(`INSERT INTO conversations (id, profileId, createdAt, lastMessageAt, record) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET lastMessageAt = excluded.lastMessageAt, record = excluded.record`)
      .run(conversation.id, conversation.profileId ?? 'default', conversation.createdAt, conversation.lastMessageAt, written(conversation))
  }
  get(id: string): Record<string, unknown> | undefined {
    const row = this.db.prepare('SELECT record FROM conversations WHERE id = ?').get(id) as { record: string } | undefined
    if (row === undefined) return undefined
    const value = read<Record<string, unknown>>(row.record)
    return { ...value, profileId: value.profileId ?? 'default', title: value.title ?? 'New conversation', revision: value.revision ?? 1 }
  }
  list(options: { profileId?: string; limit?: number; includeArchived?: boolean } = {}): Record<string, unknown>[] {
    return (this.db.prepare("SELECT record FROM conversations WHERE profileId = ? AND json_extract(record, '$.deletedAt') IS NULL AND (? OR json_extract(record, '$.archivedAt') IS NULL) ORDER BY (json_extract(record, '$.archivedAt') IS NOT NULL), lastMessageAt DESC, id LIMIT ?")
      .all(options.profileId ?? 'default', options.includeArchived === true ? 1 : 0, options.limit ?? 50) as { record: string }[])
      .map(row => { const value = read<Record<string, unknown>>(row.record); return { ...value, profileId: value.profileId ?? 'default', title: value.title ?? 'New conversation', revision: value.revision ?? 1 } })
  }
  byProfile(profileId: string, limit = 50): Record<string, unknown>[] {
    return (this.db.prepare('SELECT record FROM conversations WHERE profileId = ? ORDER BY lastMessageAt DESC LIMIT ?').all(profileId, limit) as { record: string }[])
      .map(row => read<Record<string, unknown>>(row.record))
  }
  remove(id: string): void { this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id) }
}

class ConversationMessages {
  constructor(private readonly db: DatabaseSync) {}
  /** Idempotent by message id: a retried append does not add a second row. */
  append(message: { id: string; conversationId: string; at: string; role: string; content?: string }): void {
    const parent = this.db.prepare('SELECT record FROM conversations WHERE id = ?').get(message.conversationId) as { record: string } | undefined
    if (parent !== undefined && read<Record<string, unknown>>(parent.record).deletedAt !== undefined) throw new Error('Conversation is deleted; messages cannot be appended')
    this.db.prepare('INSERT OR IGNORE INTO conversation_messages (id, conversationId, at, role, record) VALUES (?, ?, ?, ?, ?)')
      .run(message.id, message.conversationId, message.at, message.role, written(message))
  }
  list(conversationId: string, limit = 100): Record<string, unknown>[] {
    return (this.db.prepare('SELECT record FROM conversation_messages WHERE conversationId = ? ORDER BY seq LIMIT ?').all(conversationId, limit) as { record: string }[])
      .map(row => read<Record<string, unknown>>(row.record))
  }
  /** Stable seq cursor (message id), including messages with identical timestamps. */
  page(conversationId: string, options: { limit: number; before?: string; since?: string }): { messages: Record<string, unknown>[]; nextCursor?: string } {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 500) throw new RangeError('Invalid message limit')
    if (options.before !== undefined && options.since !== undefined) throw new RangeError('Choose before or since, not both')
    let before = Number.MAX_SAFE_INTEGER
    if (options.before !== undefined) {
      const cursor = this.db.prepare('SELECT seq FROM conversation_messages WHERE id = ? AND conversationId = ?').get(options.before, conversationId) as { seq: number } | undefined
      if (cursor === undefined) throw new RangeError('Invalid conversation message cursor')
      before = cursor.seq
    }
    const rows = this.db.prepare('SELECT record FROM conversation_messages WHERE conversationId = ? AND seq < ? AND (? IS NULL OR at > ?) ORDER BY seq DESC LIMIT ?')
      .all(conversationId, before, options.since ?? null, options.since ?? null, options.limit + 1) as { record: string }[]
    const more = rows.length > options.limit
    const messages = rows.slice(0, options.limit).reverse().map(row => read<Record<string, unknown>>(row.record))
    return { messages, ...(more ? { nextCursor: String(messages[0]!.id) } : {}) }
  }
  /** Most recent messages, returned in insertion order. */
  recent(conversationId: string, limit = 30): Record<string, unknown>[] {
    return (this.db.prepare('SELECT record FROM conversation_messages WHERE conversationId = ? ORDER BY seq DESC LIMIT ?').all(conversationId, limit) as { record: string }[])
      .reverse().map(row => read<Record<string, unknown>>(row.record))
  }
  since(conversationId: string, afterAt: string, limit = 100): Record<string, unknown>[] {
    return (this.db.prepare('SELECT record FROM conversation_messages WHERE conversationId = ? AND at > ? ORDER BY seq LIMIT ?').all(conversationId, afterAt, limit) as { record: string }[])
      .map(row => read<Record<string, unknown>>(row.record))
  }
}

class Assets {
  constructor(private readonly db: DatabaseSync) {}
  save(asset: { id: string; kind: string; name: string; description?: string; source?: Record<string, unknown>; accessLevel?: string; tags?: readonly string[]; usageCount?: number; contentHash?: string; createdAt: string; updatedAt: string; archived?: boolean }): void {
    this.db.prepare(`INSERT INTO assets (id, kind, name, createdAt, updatedAt, archived, record) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, name = excluded.name, updatedAt = excluded.updatedAt,
        archived = excluded.archived, record = excluded.record`)
      .run(asset.id, asset.kind, asset.name, asset.createdAt, asset.updatedAt, asset.archived === true ? 1 : 0, written(asset))
  }
  get(id: string): Record<string, unknown> | undefined {
    const row = this.db.prepare('SELECT record FROM assets WHERE id = ?').get(id) as { record: string } | undefined
    return row === undefined ? undefined : read<Record<string, unknown>>(row.record)
  }
  list(options: { kind?: string; includeArchived?: boolean; limit?: number } = {}): Record<string, unknown>[] {
    const limit = options.limit ?? 200
    // includeArchived means "both", so the archived predicate is only added when it is NOT asked for.
    const archivedClause = options.includeArchived === true ? '' : 'archived = 0 AND '
    const rows = options.kind === undefined
      ? this.db.prepare(`SELECT record FROM assets WHERE ${archivedClause}1 ORDER BY updatedAt DESC LIMIT ?`).all(limit)
      : this.db.prepare(`SELECT record FROM assets WHERE ${archivedClause}kind = ? ORDER BY updatedAt DESC LIMIT ?`).all(options.kind, limit)
    return (rows as { record: string }[]).map(row => read<Record<string, unknown>>(row.record))
  }
  /** Case-insensitive name/description search over the non-archived rows; the coordinator's search_assets uses this. */
  search(query: string, limit = 20): Record<string, unknown>[] {
    const pattern = '%' + query.replace(/[%_]/g, '') + '%'
    const rows = this.db.prepare(`SELECT record FROM assets WHERE archived = 0
      AND (lower(name) LIKE lower(?) OR lower(json_extract(record, '$.description')) LIKE lower(?))
      ORDER BY updatedAt DESC LIMIT ?`).all(pattern, pattern, limit)
    return (rows as { record: string }[]).map(row => read<Record<string, unknown>>(row.record))
  }
  remove(id: string): void { this.db.prepare('DELETE FROM assets WHERE id = ?').run(id) }
}

class MemoryEntries {
  constructor(private readonly db: DatabaseSync) {}
  /** Resolve proposal provenance without scanning every conversation or message. */
  sourceMessageAllowed(id: string): boolean {
    return this.db.prepare("SELECT 1 FROM conversation_messages m JOIN conversations c ON c.id = m.conversationId WHERE m.id = ? AND c.profileId = 'default' LIMIT 1").get(id) !== undefined
  }
  save(entry: { id: string; kind: string; scope: string; createdAt: string; updatedAt: string; content?: string; confidence?: string; sourceTicketId?: string; sourceMessageId?: string; ownerProfileId?: string; expiresAt?: string | null; revision?: number; proposedAt?: string; confirmation?: Record<string, unknown>; deletedAt?: string; deleted?: unknown; deprecated?: boolean; archived?: boolean; status?: string; revisions?: unknown[]; audit?: unknown[]; useCount?: number }): void {
    this.db.prepare(`INSERT INTO memory_entries (id, kind, scope, createdAt, updatedAt, record) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, scope = excluded.scope, updatedAt = excluded.updatedAt, record = excluded.record`)
      .run(entry.id, entry.kind, entry.scope, entry.createdAt, entry.updatedAt, written(entry))
  }
  get(id: string): Record<string, unknown> | undefined {
    const row = this.db.prepare('SELECT record FROM memory_entries WHERE id = ?').get(id) as { record: string } | undefined
    return row === undefined ? undefined : read<Record<string, unknown>>(row.record)
  }
  list(options: { scope?: string; kind?: string; limit?: number } = {}): Record<string, unknown>[] {
    const limit = options.limit ?? 100
    if (options.scope !== undefined && options.kind !== undefined) {
      return (this.db.prepare('SELECT record FROM memory_entries WHERE scope = ? AND kind = ? ORDER BY updatedAt DESC LIMIT ?').all(options.scope, options.kind, limit) as { record: string }[])
        .map(row => read<Record<string, unknown>>(row.record))
    }
    if (options.scope !== undefined) {
      return (this.db.prepare('SELECT record FROM memory_entries WHERE scope = ? ORDER BY updatedAt DESC LIMIT ?').all(options.scope, limit) as { record: string }[])
        .map(row => read<Record<string, unknown>>(row.record))
    }
    if (options.kind !== undefined) {
      return (this.db.prepare('SELECT record FROM memory_entries WHERE kind = ? ORDER BY updatedAt DESC LIMIT ?').all(options.kind, limit) as { record: string }[]).map(row => read<Record<string, unknown>>(row.record))
    }
    return (this.db.prepare('SELECT record FROM memory_entries ORDER BY updatedAt DESC LIMIT ?').all(limit) as { record: string }[])
      .map(row => read<Record<string, unknown>>(row.record))
  }
  remove(id: string): void { this.db.prepare('DELETE FROM memory_entries WHERE id = ?').run(id) }
}

class Tickets implements TicketRepository {
  constructor(private readonly db: DatabaseSync) {}

  /** The Tickets of one Work, in the order they joined it — the ordering the generated column exists to make cheap. */
  byWork(workId: string): Ticket[] {
    return (this.db.prepare('SELECT record FROM tickets WHERE workId = ? ORDER BY workSeq').all(workId) as { record: string }[])
      .map(row => read<Ticket>(row.record))
  }
  get(id: string): Ticket | undefined {
    const row = this.db.prepare('SELECT record FROM tickets WHERE id = ?').get(id) as { record: string } | undefined
    return row === undefined ? undefined : read<Ticket>(row.record)
  }
  save(ticket: Ticket): void {
    this.db.prepare(`INSERT INTO tickets (id, createdAt, open, record) VALUES (?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET open = excluded.open, record = excluded.record`)
      .run(ticket.id, ticket.createdAt, ticket.ended === undefined ? 1 : 0, written(ticket))
  }
  list(): Ticket[] {
    return (this.db.prepare('SELECT record FROM tickets ORDER BY createdAt').all() as { record: string }[])
      .map(row => read<Ticket>(row.record))
      // 墓碑对每一个列表都不可见（面板、ordin_list_tickets、Work 的子项），而 get 仍然解析得到——
      // 指向已删任务的 note 与 artifact 于是读到「已删除」，而不是报错。
      .filter(ticket => ticket.deleted === undefined)
  }
  open(): Ticket[] {
    return (this.db.prepare('SELECT record FROM tickets WHERE open = 1 ORDER BY createdAt').all() as { record: string }[])
      .map(row => read<Ticket>(row.record))
  }
  /** Tickets by state, newest first, for the panel's lists. */
  page(filter: 'open' | 'ended' | 'attention' | 'all' | 'deleted', offset: number, limit: number): Ticket[] {
    // `deleted` reads the tombstones, which `list` hides: a tombstone the operator cannot reach is not an audit trail.
    if (filter === 'deleted') return this.deleted().reverse().slice(offset, offset + limit)
    const all = filter === 'open' ? this.open().reverse() : this.list().reverse()
    const wanted = filter === 'attention' ? all.filter(ticket => waitsForPerson(ticket))
      : filter === 'ended' ? all.filter(ticket => ticket.ended !== undefined) : all
    return wanted.slice(offset, offset + limit)
  }
  count(): { open: number; ended: number; attention: number } {
    const rows = this.list()
    return {
      open: rows.filter(ticket => ticket.ended === undefined).length,
      ended: rows.filter(ticket => ticket.ended !== undefined).length,
      // 【排障修复】已结束的票即使有 attention 字段也不再需要操作者介入，
      // 不应计入 attention 数——否则 worker 以 ready+question 结束时，
      // 面板会一直显示"等你回答1条"但列表里查不到任何票。
      attention: rows.filter(ticket => ticket.ended === undefined && ticket.attention !== undefined).length,
    }
  }
  /** Take the row away entirely: the `record: 'nothing'` half of a deletion (S4). */
  remove(id: string): void { this.db.prepare('DELETE FROM tickets WHERE id = ?').run(id) }
  /** The tombstones, for the one view that shows what was deleted. `list` hides them by design. */
  deleted(): Ticket[] {
    return (this.db.prepare('SELECT record FROM tickets').all() as { record: string }[])
      .map(row => read<Ticket>(row.record))
      .filter(ticket => ticket.deleted !== undefined)
  }

}

class Decisions implements DecisionRepository {
  constructor(private readonly db: DatabaseSync) {}
  get(id: string): Decision | undefined {
    const row = this.db.prepare('SELECT record FROM decisions WHERE id = ?').get(id) as { record: string } | undefined
    return row === undefined ? undefined : read<Decision>(row.record)
  }
  save(decision: Decision): void {
    this.db.prepare(`INSERT INTO decisions (id, triggerId, at, outcome, record) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET record = excluded.record`)
      .run(decision.id, decision.triggerId, decision.at, decision.outcome, written(decision))
  }
  list(limit = 200): Decision[] {
    return (this.db.prepare('SELECT record FROM decisions ORDER BY at DESC LIMIT ?').all(limit) as { record: string }[])
      .map(row => read<Decision>(row.record))
  }
  since(at: string, limit = 500): Decision[] {
    return (this.db.prepare('SELECT record FROM decisions WHERE at >= ? ORDER BY at DESC LIMIT ?').all(at, limit) as { record: string }[])
      .map(row => read<Decision>(row.record))
  }
}

/** One queued side effect, as `Effects` reads and writes it. */
export interface EffectRow {
  readonly kind: string
  readonly key: string
  readonly payload: unknown
  readonly dueAt: number
  readonly failures: number
  readonly running: boolean
  readonly generation: string
  readonly claimToken: string
}

export interface EffectTerminalReceipt {
  readonly id: string
  readonly kind: string
  readonly key: string
  readonly generation: string
  readonly payload: unknown
  readonly error: string
  readonly at: string
}

const TERMINAL_ERROR_CHARS = 2000

/**
 * The database, its repositories and the transaction boundary.
 * The outermost `atomic` opens a transaction and flushes the work registered with `afterCommit` only once it commits;
 * a nested one uses a savepoint, so a command that spans parts rolls back as one.
 */
export class Store implements Transaction {
  private readonly db: DatabaseSync
  private transactionFailure: Error | undefined
  private depth = 0
  private queue: (() => void)[] = []
  /** Deferred actions that threw, newest last, bounded. A Store must never be the only place that knows one failed. */
  readonly deferredFailures: { at: string; message: string }[] = []
  /** Wired by the Runtime to the log and the health board, so a lost launch is visible instead of silent. */
  onDeferredError?: (error: unknown) => void
  readonly triggers: Triggers
  readonly tickets: Tickets
  readonly decisions: Decisions
  readonly artifacts: Artifacts
  readonly projects: Projects
  readonly works: Works
  readonly events: Events
  readonly dependencies: Dependencies
  readonly threads: Threads
  readonly deskHistory: DeskHistory
  readonly conversations: Conversations
  readonly conversationMessages: ConversationMessages
  readonly assets: Assets
  readonly memory: MemoryEntries
  readonly inputConsumptions: InputConsumptionRepository = {
    get: identity => this.get<InputConsumption>(KV.sourceConsumption(identity)),
    save: (identity, receipt) => this.set(KV.sourceConsumption(identity), receipt),
  }

  /** Standalone pre-upgrade snapshot, retained on disk. Restore/CLI policy is outside Store. */
  readonly migrationBackupPath: string | undefined

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    try {
      this.migrationBackupPath = this.open(path)
    } catch (error) {
      try { this.db.close() } catch {}
      throw error
    }
    this.triggers = new Triggers(this.db)
    this.tickets = new Tickets(this.db)
    this.decisions = new Decisions(this.db)
    this.artifacts = new Artifacts(this.db)
    this.projects = new Projects(this.db)
    this.works = new Works(this.db)
    this.events = new Events(this.db)
    this.dependencies = new Dependencies(this.db)
    this.threads = new Threads(this.db)
    this.deskHistory = new DeskHistory(this.db)
    this.conversations = new Conversations(this.db)
    this.conversationMessages = new ConversationMessages(this.db)
    this.assets = new Assets(this.db)
    this.memory = new MemoryEntries(this.db)
  }

  /** Pragma, schema and version stamp, in the order that keeps a failed upgrade from half-applying. */
  private open(path: string): string | undefined {
    // Inspect and snapshot BEFORE persistent pragmas or schema writes, including on refusal paths.
    const found = this.readVersion()
    if (found !== undefined && found > SCHEMA_VERSION) throw new SchemaTooNew(found)
    if (found === SCHEMA_VERSION) this.validateSchema()
    const backup = found !== undefined && found < SCHEMA_VERSION && path !== ':memory:'
      ? this.backupBeforeMigration(path, found) : undefined
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    // Without this a second writer fails instantly with SQLITE_BUSY, which reads like corruption rather than contention.
    this.db.exec('PRAGMA busy_timeout = 5000')
    try { this.migrate(found) } catch (cause) {
      if (backup !== undefined) throw new Error(`Migration failed; pre-upgrade backup retained at ${backup}: ${String(cause)}`, { cause })
      throw cause
    }
    return backup
  }

  private backupBeforeMigration(path: string, found: number): string {
    const backup = `${resolve(path)}.pre-v${found}-to-v${SCHEMA_VERSION}-${randomUUID()}.sqlite3`
    try {
      // Reserve exclusively and privately before SQLite writes any page. VACUUM INTO accepts an empty file,
      // reads committed WAL pages through SQLite, and produces a standalone database (no sidecars required).
      const reserved = openSync(backup, 'wx', 0o600)
      closeSync(reserved)
      this.db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`)
      const fd = openSync(backup, 'r')
      try { fsyncSync(fd) } finally { closeSync(fd) }
      return backup
    } catch (cause) {
      throw new Error(`Migration backup failed at ${backup}: ${String(cause)}; upgrade stopped`, { cause })
    }
  }

  /**
   * Bring the file to this build's schema, or refuse it.
   *
   * The version is stamped LAST and everything runs in one transaction, so a step that throws leaves the file at the
   * version it had and the previous build can still open it. That ordering is the whole rollback story: the version
   * number is the only thing that makes an older build refuse a file.
   */
  private migrate(found: number | undefined): void {
    if (found !== undefined && found > SCHEMA_VERSION) throw new SchemaTooNew(found)
    if (found === SCHEMA_VERSION) return
    let began = false
    try {
      this.db.exec('BEGIN IMMEDIATE')
      began = true
      // foreign_keys is already ON and cannot change inside a transaction; deferring keeps a mid-migration state legal
      // without weakening the check once the transaction ends.
      this.db.exec('PRAGMA defer_foreign_keys = ON')
      if (found === undefined) this.db.exec(SCHEMA)
      for (let version = found ?? 0; version < SCHEMA_VERSION; version++) MIGRATIONS[version + 1]?.(this.db)
      this.validateSchema()
      this.db.exec('DELETE FROM schema_version')
      this.db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION)
      this.db.exec('COMMIT')
    } catch (error) {
      // A rollback that itself throws would replace the real cause with "no transaction is active".
      if (began) { try { this.db.exec('ROLLBACK') } catch { /* the original error is the one worth reporting */ } }
      throw error
    }
  }

  atomic<T>(run: () => T): T {
    if (this.transactionFailure !== undefined) throw this.transactionFailure
    const outermost = this.depth === 0
    const name = `s${this.depth}`
    // A failed transaction drops only the callbacks registered within its boundary.
    const mark = this.queue.length
    if (outermost) this.db.exec('BEGIN IMMEDIATE')
    else this.db.exec(`SAVEPOINT ${name}`)
    this.depth++
    let result: T
    try {
      result = run()
      // COMMIT may fail while SQLite keeps the transaction open (deferred constraints, busy I/O).
      // Keep it in the same failure boundary as the writes, with callbacks still pending.
      this.db.exec(outermost ? 'COMMIT' : `RELEASE ${name}`)
    } catch (error) {
      this.queue.length = mark
      try {
        if (outermost) this.db.exec('ROLLBACK')
        else {
          this.db.exec(`ROLLBACK TO ${name}`)
          this.db.exec(`RELEASE ${name}`)
        }
      } catch (rollbackError) {
        // No repository may keep writing when SQLite's transaction outcome is unknown.
        this.queue = []
        this.transactionFailure = new AggregateError([error, rollbackError], 'Transaction rollback failed; Store is unusable')
        try { this.db.close() } catch { /* retain both original failures */ }
        throw this.transactionFailure
      }
      throw error
    } finally {
      this.depth--
    }
    if (!outermost) return result
    const deferred = this.queue.slice(mark)
    this.queue = []
    // Deliberately outside the try above: the transaction has committed, so a throwing action is not a transaction
    // failure. Letting it reach the catch would decrement `depth` a second time, and a Store at depth -1 answers every
    // later `atomic()` with `SAVEPOINT s-1` — a syntax error — staying unusable until the process restarts, with the
    // original error replaced by "cannot rollback - no transaction is active".
    for (const action of deferred) {
      try { action() } catch (error) { this.deferredFailed(error) }
    }
    return result
  }

  /**
   * Record a deferred action that threw. Kept even when nobody is listening, because "it was enqueued and then nothing
   * happened" is exactly the silence an unattended system cannot afford.
   */
  private deferredFailed(error: unknown): void {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    this.deferredFailures.push({ at: new Date().toISOString(), message })
    if (this.deferredFailures.length > 50) this.deferredFailures.shift()
    this.onDeferredError?.(error)
  }

  /** The version stamped in the file, or `undefined` when there is nothing readable to migrate from. */
  private readVersion(): number | undefined {
    // A fresh database has no version table yet, and asking it for one would fail before anything was created.
    const known = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'").get()
    if (known === undefined) {
      const existing = this.db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get()
      if (existing !== undefined) throw new Error('schema_version is missing from a nonempty database; refusing initialization')
      return undefined
    }
    let rows: { version: unknown }[]
    try { rows = this.db.prepare('SELECT version FROM schema_version LIMIT 2').all() as { version: unknown }[] }
    catch (cause) { throw new Error(`schema_version cannot be read safely: ${String(cause)}`, { cause }) }
    if (rows.length !== 1) throw new Error('schema_version must contain exactly one version stamp')
    const row = rows[0]!
    // A version that is not an integer is a file this build does not understand. Treating it as "no version" and
    // re-stamping would silently adopt a hand-edited or foreign database as our own.
    if (typeof row.version !== 'number' || !Number.isSafeInteger(row.version) || row.version < 1) {
      throw new Error(`schema_version holds ${JSON.stringify(row.version)}, which is not a version this ordin can read`)
    }
    return row.version
  }

  /** Check the essential v8 read/write contract, without repairing or rewriting historical data. */
  private validateSchema(): void {
    const essential: Record<string, string[]> = {
      conversations: ['id', 'profileId', 'createdAt', 'lastMessageAt', 'record'],
      conversation_messages: ['seq', 'id', 'conversationId', 'at', 'role', 'record'],
      assets: ['id', 'kind', 'name', 'createdAt', 'updatedAt', 'archived', 'record'],
      memory_entries: ['id', 'kind', 'scope', 'createdAt', 'updatedAt', 'record'],
      effects: ['kind', 'key', 'payload', 'dueAt', 'failures', 'running', 'generation', 'claimToken'],
    }
    for (const [table, required] of Object.entries(essential)) {
      const columns = this.db.prepare(`PRAGMA table_xinfo(${table})`).all() as { name: string; type: string; pk: number; notnull: number }[]
      const missing = required.filter(name => !columns.some(column => column.name === name))
      if (missing.length) throw new Error(`Invalid schema v8: ${table} missing ${missing.join(', ')}; refusing schema drift`)
      if (table === 'effects') {
        const generation = columns.find(column => column.name === 'generation')!
        const claimToken = columns.find(column => column.name === 'claimToken')!
        if (generation.type.toUpperCase() !== 'TEXT' || generation.notnull !== 1 || claimToken.type.toUpperCase() !== 'TEXT' || claimToken.notnull !== 0) {
          throw new Error('Invalid schema v9: effects ownership columns must be generation TEXT NOT NULL and nullable claimToken TEXT')
        }
      }
      if (table === 'conversation_messages') {
        const seq = columns.find(column => column.name === 'seq')!
        const sql = this.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table)?.sql
        if (seq.type.toUpperCase() !== 'INTEGER' || seq.pk !== 1 || typeof sql !== 'string' || !/\bAUTOINCREMENT\b/i.test(sql)) {
          throw new Error('Invalid schema v8: conversation_messages.seq must be INTEGER PRIMARY KEY AUTOINCREMENT; refusing schema drift')
        }
      }
    }
  }

  afterCommit(run: () => void): void {
    if (this.transactionFailure !== undefined) throw this.transactionFailure
    if (this.depth === 0) { run(); return }
    this.queue.push(run)
  }

  // -------------------------------------------------------------- Effects

  /** Insert or replace a queued effect; a replacement becomes due at once and keeps the queue's order. */
  enqueueEffect(kind: string, key: string, payload: unknown, dueAt = Date.now()): void {
    this.db.prepare(`INSERT INTO effects (kind, key, payload, dueAt, failures, running, generation, claimToken) VALUES (?, ?, ?, ?, 0, 0, ?, NULL)
      ON CONFLICT (kind, key) DO UPDATE SET payload = excluded.payload, dueAt = excluded.dueAt, running = 0, generation = excluded.generation, claimToken = NULL`)
      .run(kind, key, written(payload), dueAt, randomUUID())
  }

  /** Due effects of one kind, oldest first, marked running, at most `limit`. */
  claimEffects(kind: string, limit: number, now = Date.now()): EffectRow[] {
    if (limit <= 0) return []
    return this.atomic(() => {
      const rows = this.db.prepare('SELECT kind, key, payload, dueAt, failures, generation FROM effects WHERE kind = ? AND running = 0 AND dueAt <= ? ORDER BY dueAt LIMIT ?').all(kind, now, limit) as
        { kind: string; key: string; payload: string; dueAt: number; failures: number; generation: string }[]
      const mark = this.db.prepare('UPDATE effects SET running = 1, claimToken = ? WHERE kind = ? AND key = ? AND generation = ? AND running = 0 AND dueAt <= ?')
      const claimed: EffectRow[] = []
      for (const row of rows) {
        const claimToken = randomUUID()
        if (Number(mark.run(claimToken, row.kind, row.key, row.generation, now).changes) === 1) claimed.push({ ...row, payload: read<unknown>(row.payload), running: true, claimToken })
      }
      return claimed
    })
  }

  /** Handler callbacks only mutate the generation and running claim that they own. */
  settleClaimedEffect(row: EffectRow): boolean {
    return Number(this.db.prepare('DELETE FROM effects WHERE kind = ? AND key = ? AND generation = ? AND claimToken = ? AND running = 1')
      .run(row.kind, row.key, row.generation, row.claimToken).changes) === 1
  }

  /** Atomically delete the owned terminal row and persist its receipt; stale claims produce no receipt. */
  settleClaimedEffectWithReceipt(row: EffectRow, error: unknown): EffectTerminalReceipt | undefined {
    const receipt = this.atomic(() => {
      const deleted = Number(this.db.prepare('DELETE FROM effects WHERE kind = ? AND key = ? AND generation = ? AND claimToken = ? AND running = 1')
        .run(row.kind, row.key, row.generation, row.claimToken).changes)
      if (deleted !== 1) return undefined
      const id = row.generation
      const rawError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      const safeError = rawError.replace(/(bearer\s+)[^\s,;]+/gi, '$1[redacted]')
        .replace(/((?:api[_-]?key|token|password|secret|authorization)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]')
        .replace(/https?:\/\/[^\s]+/gi, '[url redacted]')
      const boundedError = safeError.length > TERMINAL_ERROR_CHARS ? `${safeError.slice(0, TERMINAL_ERROR_CHARS)}…` : safeError
      const payload = row.payload
      const value: EffectTerminalReceipt = { id, kind: row.kind, key: row.key, generation: row.generation, payload, error: boundedError, at: new Date().toISOString() }
      this.set(KV.terminalReceipt(id), value)
      return value
    })
    return receipt
  }

  failClaimedEffect(row: EffectRow, dueAt: number): boolean {
    return Number(this.db.prepare('UPDATE effects SET running = 0, claimToken = NULL, failures = failures + 1, dueAt = ? WHERE kind = ? AND key = ? AND generation = ? AND claimToken = ? AND running = 1')
      .run(dueAt, row.kind, row.key, row.generation, row.claimToken).changes) === 1
  }

  deferClaimedEffect(row: EffectRow, dueAt: number): boolean {
    return Number(this.db.prepare('UPDATE effects SET running = 0, claimToken = NULL, dueAt = ? WHERE kind = ? AND key = ? AND generation = ? AND claimToken = ? AND running = 1')
      .run(dueAt, row.kind, row.key, row.generation, row.claimToken).changes) === 1
  }

  /** Administrative removal independent of worker ownership. */
  settleEffect(kind: string, key: string): void {
    this.db.prepare('DELETE FROM effects WHERE kind = ? AND key = ?').run(kind, key)
  }

  /** Record a failure and defer the effect to `dueAt`, releasing it for a later claim. */
  failEffect(kind: string, key: string, dueAt: number): void {
    this.db.prepare('UPDATE effects SET running = 0, claimToken = NULL, failures = failures + 1, dueAt = ? WHERE kind = ? AND key = ?')
      .run(dueAt, kind, key)
  }

  /** Defer an effect without counting a failure, for work that is not runnable yet. */
  deferEffect(kind: string, key: string, dueAt: number): void {
    this.db.prepare('UPDATE effects SET running = 0, claimToken = NULL, dueAt = ? WHERE kind = ? AND key = ?').run(dueAt, kind, key)
  }

  /** Release every effect this process marked running, which a crash or a shutdown left behind. */
  releaseRunning(): number {
    const result: StatementResultingChanges = this.db.prepare('UPDATE effects SET running = 0, claimToken = NULL WHERE running = 1').run()
    return Number(result.changes)
  }

  pendingEffects(kind: string, key: string): boolean {
    return this.db.prepare('SELECT 1 FROM effects WHERE kind = ? AND key = ? LIMIT 1').get(kind, key) !== undefined
  }

  effectCounts(): Record<string, number> {
    const rows = this.db.prepare('SELECT kind, COUNT(*) AS count FROM effects GROUP BY kind').all() as
      { kind: string; count: number | bigint }[]
    return Object.fromEntries(rows.map(row => [row.kind, Number(row.count)]))
  }

  // ------------------------------------------------------------- Settings

  /** The stored settings document, parsed and defaulted; the defaults when nothing is stored yet. */
  settings(): Settings {
    // `get` already parsed the stored JSON, so this is one parse of the document, never of its text.
    return parseSettings(this.get<unknown>(KV.settingsDocument) ?? {})
  }

  /** The current settings revision, 0 before the first save. */
  settingsRevision(): number {
    return this.get(KV.settingsRevision) ?? 0
  }

  /** Store a settings document and raise its revision; returns the new revision. */
  saveSettings(value: Settings): number {
    const revision = this.settingsRevision() + 1
    this.atomic(() => {
      this.set(KV.settingsDocument, value)
      this.set(KV.settingsRevision, revision)
    })
    return revision
  }

  // ------------------------------------------------------------------- KV

  get<T = unknown>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined
    return row === undefined ? undefined : read<T>(row.value)
  }

  set(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .run(key, written(value))
  }

  delete(key: string): void { this.db.prepare('DELETE FROM kv WHERE key = ?').run(key) }

  getTerminalReceipt(id: string): EffectTerminalReceipt | undefined {
    return this.get<EffectTerminalReceipt>(KV.terminalReceipt(id))
  }

  listTerminalReceipts(limit = 100): EffectTerminalReceipt[] {
    const prefix = 'effects:terminal:'
    const rows = this.db.prepare('SELECT value FROM kv WHERE key LIKE ? ORDER BY key LIMIT ?').all(`${prefix}%`, limit) as { value: string }[]
    return rows.map(row => read<EffectTerminalReceipt>(row.value))
  }

  ackTerminalReceipt(id: string): void { this.delete(KV.terminalReceipt(id)) }

  /** Every key with a prefix, for a family's records. */
  keys(prefix: string): string[] {
    return (this.db.prepare('SELECT key FROM kv WHERE key LIKE ? ORDER BY key').all(`${prefix}%`) as { key: string }[])
      .map(row => row.key)
  }

  // ------------------------------------------------------- Lost trigger payloads

  /**
   * Keep one payload the queue gave up on that was not a Trigger this build could read, oldest dropped past the bound.
   *
   * Here rather than in `triggers` because that table's five columns are all NOT NULL and `countBySource` groups by
   * `source` and feeds the panel's intake counts: a row with an invented `source: 'lost'` would put a Source named
   * "lost" on the page whose job is answering where work comes from, and a false statement in an audit surface is worse
   * than a missing one. What is left to say is the text itself, so it is kept, bounded, and not pretending to be more.
   */
  pushLostPayload(entry: { at: string; effectKey: string; error: string; payload: string }): void {
    const kept = this.lostPayloads()
    kept.push({
      at: entry.at, effectKey: entry.effectKey, chars: entry.payload.length,
      // The same bound `notice_lost` puts on the words it keeps (runtime.ts:306): an error is worth its first
      // sentence, and this one is a passenger in a value that is rewritten whole.
      error: entry.error.slice(0, 400),
      payload: entry.payload.slice(0, LOST_TRIGGER_CHARS),
    })
    this.set(KV.lostTriggers, kept.slice(-LOST_TRIGGER_KEEP))
  }

  /** The payloads `pushLostPayload` kept, oldest first. */
  lostPayloads(): LostPayload[] {
    const stored = this.get<LostPayload[]>(KV.lostTriggers)
    // Anything but a list is treated as empty rather than read: this entry is written by one method, so a value of
    // another shape was put there by hand, and a crash in whatever asks what was lost would be a second loss.
    return Array.isArray(stored) ? stored : []
  }

  close(): void { this.db.close() }
}
