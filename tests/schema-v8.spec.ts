/**
 * Schema v8: conversations, their messages, data assets and long-term memory, plus the Ticket acceptance fields.
 * The migration is additive, so a v7 file (without the four tables) must open, gain them, and keep its data.
 */
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { SCHEMA_VERSION, Store } from '../src/app/store.ts'
import type { Ticket } from '../src/core/model.ts'
import { tempDir } from './helpers/temp.ts'

const now = (): string => new Date().toISOString()

/** Historical v7 fixture created from its versioned table DDL, not by downgrading the current schema. */
function v7File(): string {
  const path = join(tempDir('ordin-v8-'), 'v7.sqlite3')
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE schema_version (version INTEGER NOT NULL);
    INSERT INTO schema_version VALUES (7);
    CREATE TABLE triggers (id TEXT PRIMARY KEY, source TEXT NOT NULL, kind TEXT NOT NULL, at TEXT NOT NULL, disposition TEXT NOT NULL, record TEXT NOT NULL) WITHOUT ROWID;
    CREATE INDEX triggers_at ON triggers (at);
    CREATE TABLE threads (key TEXT PRIMARY KEY, record TEXT NOT NULL) WITHOUT ROWID;
    CREATE TABLE tickets (id TEXT PRIMARY KEY, createdAt TEXT NOT NULL, open INTEGER NOT NULL, record TEXT NOT NULL, workId TEXT GENERATED ALWAYS AS (json_extract(record,'$.workId')) VIRTUAL, workSeq INTEGER GENERATED ALWAYS AS (json_extract(record,'$.workSeq')) VIRTUAL) WITHOUT ROWID;
    CREATE INDEX tickets_open ON tickets (open, createdAt); CREATE INDEX tickets_work ON tickets (workId, workSeq);
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, createdAt TEXT NOT NULL, record TEXT NOT NULL) WITHOUT ROWID;
    CREATE TABLE works (id TEXT PRIMARY KEY, projectId TEXT, name TEXT NOT NULL, createdAt TEXT NOT NULL, record TEXT NOT NULL) WITHOUT ROWID; CREATE INDEX works_project ON works (projectId, createdAt);
    CREATE TABLE decisions (id TEXT PRIMARY KEY, triggerId TEXT NOT NULL, at TEXT NOT NULL, outcome TEXT NOT NULL, record TEXT NOT NULL) WITHOUT ROWID; CREATE INDEX decisions_at ON decisions (at);
    CREATE TABLE effects (kind TEXT NOT NULL, key TEXT NOT NULL, payload TEXT NOT NULL, dueAt INTEGER NOT NULL, failures INTEGER NOT NULL DEFAULT 0, running INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(kind,key)) WITHOUT ROWID; CREATE INDEX effects_due ON effects (dueAt,kind);
    CREATE TABLE artifacts (ticketId TEXT NOT NULL,path TEXT NOT NULL,at TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(ticketId,path)) WITHOUT ROWID; CREATE INDEX artifacts_ticket ON artifacts (ticketId,at);
    CREATE TABLE events (ticketId TEXT NOT NULL,seq INTEGER NOT NULL,at TEXT NOT NULL,type TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(ticketId,seq)) WITHOUT ROWID; CREATE INDEX events_at ON events (at);
    CREATE TABLE ticket_deps (upstream TEXT NOT NULL,downstream TEXT NOT NULL,record TEXT NOT NULL,PRIMARY KEY(upstream,downstream)) WITHOUT ROWID; CREATE INDEX deps_downstream ON ticket_deps (downstream);
    CREATE TABLE kv (key TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID;
    CREATE TABLE desk_messages (seq INTEGER PRIMARY KEY AUTOINCREMENT,role TEXT NOT NULL,content TEXT NOT NULL,tool_calls TEXT,tool_call_id TEXT,name TEXT,ticketId TEXT,requestId TEXT,at TEXT NOT NULL); CREATE INDEX desk_messages_at ON desk_messages (at); CREATE UNIQUE INDEX desk_messages_request ON desk_messages (requestId) WHERE requestId IS NOT NULL;
    PRAGMA user_version = 7;
  `)
  db.close()
  return path
}

describe('schema v8', () => {
  it('creates the four coordinator tables on a fresh file', () => {
    const path = join(tempDir('ordin-v8-fresh-'), 'fresh.sqlite3')
    const store = new Store(path)
    try {
      const db = new DatabaseSync(path)
      const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(row => row.name)
      db.close()
      for (const table of ['conversations', 'conversation_messages', 'assets', 'memory_entries']) expect(names).toContain(table)
      expect(SCHEMA_VERSION).toBe(9)
    } finally { store.close() }
  })

  it('migrates a v7 file in place, keeps its rows, and is idempotent on reopen', () => {
    const path = v7File()
    // A v7 file with one Ticket in it: the migration must not touch the record.
    const before = new DatabaseSync(path)
    const ticket = { id: 'ticket-1', title: 'v7 row', createdAt: now(), mandate: { policyVersion: 'v1', scope: 's', strength: 'explicit', sender: { id: 'operator', kind: 'person' }, via: 'session', at: now() }, origin: { triggerId: 't' }, attachments: [], assignments: [], inputs: [], notes: [] } as unknown as Ticket
    before.prepare('INSERT INTO tickets (id,createdAt,open,record) VALUES (?,?,?,?)').run(ticket.id,ticket.createdAt,1,JSON.stringify(ticket))
    before.prepare('INSERT INTO kv (key,value) VALUES (?,?)').run('migration-proof',JSON.stringify({preserved:true}))
    before.prepare('INSERT INTO desk_messages (role,content,at,requestId) VALUES (?,?,?,?)').run('user','before upgrade',now(),'v7-message')
    expect((before.prepare('SELECT version FROM schema_version').get() as {version:number}).version).toBe(7)
    before.close()

    const store = new Store(path)
    try {
      expect(store.tickets.get('ticket-1')?.title).toBe('v7 row')
      expect(store.get('migration-proof')).toEqual({preserved:true})
      expect(store.deskHistory.latestSeq()).toBe(1)
      const db = new DatabaseSync(path)
      const version = (db.prepare('SELECT version FROM schema_version').get() as { version: number }).version
      const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(row => row.name)
      db.close()
      expect(version).toBe(SCHEMA_VERSION)
      for (const table of ['conversations', 'conversation_messages', 'assets', 'memory_entries']) expect(names).toContain(table)
    } finally { store.close() }

    // Reopening an already-migrated file must not throw or double-migrate.
    const again = new Store(path)
    try {
      expect(again.tickets.get('ticket-1')?.title).toBe('v7 row')
      const db = new DatabaseSync(path)
      expect((db.prepare('SELECT version FROM schema_version').get() as { version: number }).version).toBe(SCHEMA_VERSION)
      db.close()
    } finally { again.close() }
  })
})

describe('conversations', () => {
  it('saves, reads back and lists by profile, newest first', () => {
    const store = new Store(join(tempDir('ordin-conv-'), 'conv.sqlite3'))
    try {
      store.conversations.save({ id: 'conv-1', profileId: 'default', createdAt: '2026-11-15T00:00:00Z', lastMessageAt: '2026-11-15T00:01:00Z' })
      store.conversations.save({ id: 'conv-2', profileId: 'default', createdAt: '2026-11-15T00:02:00Z', lastMessageAt: '2026-11-15T00:03:00Z' })
      expect(store.conversations.get('conv-1')).toMatchObject({ id: 'conv-1', profileId: 'default' })
      expect(store.conversations.byProfile('default').map(c => c.id)).toEqual(['conv-2', 'conv-1'])
      expect(store.conversations.byProfile('someone-else')).toEqual([])
    } finally { store.close() }
  })
})

describe('conversation messages', () => {
  it('appends idempotently by id and reads in order', () => {
    const store = new Store(join(tempDir('ordin-convmsg-'), 'msg.sqlite3'))
    try {
      store.conversationMessages.append({ id: 'm-1', conversationId: 'conv-1', at: '2026-11-15T00:00:00Z', role: 'user' })
      store.conversationMessages.append({ id: 'm-1', conversationId: 'conv-1', at: '2026-11-15T00:00:00Z', role: 'user' })
      store.conversationMessages.append({ id: 'm-2', conversationId: 'conv-1', at: '2026-11-15T00:01:00Z', role: 'ordin' })
      const rows = store.conversationMessages.list('conv-1')
      expect(rows.map(r => r.id)).toEqual(['m-1', 'm-2'])
      expect(store.conversationMessages.since('conv-1', '2026-11-15T00:00:00Z').map(r => r.id)).toEqual(['m-2'])
    } finally { store.close() }
  })
})

describe('assets', () => {
  it('saves, searches by name or description, and hides archived rows from search', () => {
    const store = new Store(join(tempDir('ordin-assets-'), 'assets.sqlite3'))
    try {
      const base = { createdAt: '2026-11-15T00:00:00Z', updatedAt: '2026-11-15T00:00:00Z', archived: false }
      store.assets.save({ ...base, id: 'a-1', kind: 'report', name: 'Q3 竞品分析', description: '三家对比' })
      store.assets.save({ ...base, id: 'a-2', kind: 'dataset', name: 'sales.csv', description: '月度销量' })
      store.assets.save({ ...base, id: 'a-3', kind: 'report', name: 'old', description: 'old', archived: true })
      expect(store.assets.search('竞品').map(a => a.id)).toEqual(['a-1'])
      expect(store.assets.search('销量').map(a => a.id)).toEqual(['a-2'])
      expect(store.assets.list({ kind: 'report' }).map(a => a.id)).toEqual(['a-1'])
      expect(store.assets.list({ includeArchived: true }).length).toBe(3)
    } finally { store.close() }
  })
})

describe('memory entries', () => {
  it('saves, lists by scope and kind, and removes', () => {
    const store = new Store(join(tempDir('ordin-memory-'), 'memory.sqlite3'))
    try {
      const base = { createdAt: '2026-11-15T00:00:00Z', updatedAt: '2026-11-15T00:00:00Z' }
      store.memory.save({ ...base, id: 'mem-1', kind: 'preference', scope: 'global' })
      store.memory.save({ ...base, id: 'mem-2', kind: 'project-fact', scope: 'work-1' })
      expect(store.memory.list({ scope: 'global' }).map(m => m.id)).toEqual(['mem-1'])
      expect(store.memory.list({ scope: 'work-1', kind: 'project-fact' }).map(m => m.id)).toEqual(['mem-2'])
      store.memory.remove('mem-1')
      expect(store.memory.get('mem-1')).toBeUndefined()
    } finally { store.close() }
  })
})

describe('ticket acceptance round-trip', () => {
  it('persists acceptance, plan, backend and budget inside the record', () => {
    const store = new Store(join(tempDir('ordin-accept-'), 'accept.sqlite3'))
    try {
      const ticket = { id: 'ticket-a', title: 'checked', createdAt: now(), mandate: { policyVersion: 'v1', scope: 's', strength: 'explicit', sender: { id: 'operator', kind: 'person' }, via: 'session', at: now() }, origin: { triggerId: 't' }, attachments: [], assignments: [], inputs: [], notes: [], conversationId: 'conv-1', plan: ['read the data', 'write the report'], workerBackend: 'codex', estimatedBudgetMs: 600000, acceptance: { status: 'pending' as const, checks: [{ name: 'file-exists', passed: true }] } } as unknown as Ticket
      store.tickets.save(ticket)
      const back = store.tickets.get('ticket-a')!
      expect(back.acceptance).toMatchObject({ status: 'pending', checks: [{ name: 'file-exists', passed: true }] })
      expect(back.plan).toEqual(['read the data', 'write the report'])
      expect(back.workerBackend).toBe('codex')
      expect(back.conversationId).toBe('conv-1')
    } finally { store.close() }
  })
})
