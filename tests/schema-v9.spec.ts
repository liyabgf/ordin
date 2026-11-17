import { copyFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { Store, SCHEMA_VERSION } from '../src/app/store.ts'
import { tempDir } from './helpers/temp.ts'

// Static historical v8 checkpoint DDL: no current Store runs before these rows exist.
const V8_DDL = "\nCREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);\nCREATE TABLE IF NOT EXISTS triggers (\n  id TEXT PRIMARY KEY,\n  source TEXT NOT NULL,\n  kind TEXT NOT NULL,\n  at TEXT NOT NULL,\n  disposition TEXT NOT NULL,\n  record TEXT NOT NULL\n) WITHOUT ROWID;\nCREATE INDEX IF NOT EXISTS triggers_at ON triggers (at);\nCREATE TABLE IF NOT EXISTS threads (\n  key TEXT PRIMARY KEY,\n  record TEXT NOT NULL\n) WITHOUT ROWID;\nCREATE TABLE IF NOT EXISTS tickets (\n  id TEXT PRIMARY KEY,\n  createdAt TEXT NOT NULL,\n  open INTEGER NOT NULL,\n  record TEXT NOT NULL,\n  workId TEXT GENERATED ALWAYS AS (json_extract(record, '$.workId')) VIRTUAL,\n  workSeq INTEGER GENERATED ALWAYS AS (json_extract(record, '$.workSeq')) VIRTUAL\n) WITHOUT ROWID;\nCREATE INDEX IF NOT EXISTS tickets_open ON tickets (open, createdAt);\nCREATE INDEX IF NOT EXISTS tickets_work ON tickets (workId, workSeq);\nCREATE TABLE IF NOT EXISTS projects (\n  id TEXT PRIMARY KEY,\n  name TEXT NOT NULL,\n  createdAt TEXT NOT NULL,\n  record TEXT NOT NULL\n) WITHOUT ROWID;\nCREATE TABLE IF NOT EXISTS works (\n  id TEXT PRIMARY KEY,\n  projectId TEXT,\n  name TEXT NOT NULL,\n  createdAt TEXT NOT NULL,\n  record TEXT NOT NULL\n) WITHOUT ROWID;\nCREATE INDEX IF NOT EXISTS works_project ON works (projectId, createdAt);\nCREATE TABLE IF NOT EXISTS decisions (\n  id TEXT PRIMARY KEY,\n  triggerId TEXT NOT NULL,\n  at TEXT NOT NULL,\n  outcome TEXT NOT NULL,\n  record TEXT NOT NULL\n) WITHOUT ROWID;\nCREATE INDEX IF NOT EXISTS decisions_at ON decisions (at);\nCREATE TABLE IF NOT EXISTS effects (\n  kind TEXT NOT NULL,\n  key TEXT NOT NULL,\n  payload TEXT NOT NULL,\n  dueAt INTEGER NOT NULL,\n  failures INTEGER NOT NULL DEFAULT 0,\n  running INTEGER NOT NULL DEFAULT 0,\n  PRIMARY KEY (kind, key)\n) WITHOUT ROWID;\nCREATE INDEX IF NOT EXISTS effects_due ON effects (dueAt, kind);\nCREATE TABLE IF NOT EXISTS artifacts (\n  ticketId TEXT NOT NULL,\n  path TEXT NOT NULL,\n  at TEXT NOT NULL,\n  record TEXT NOT NULL,\n  PRIMARY KEY (ticketId, path)\n) WITHOUT ROWID;\nCREATE INDEX IF NOT EXISTS artifacts_ticket ON artifacts (ticketId, at);\nCREATE TABLE IF NOT EXISTS events (\n  ticketId TEXT NOT NULL,\n  seq INTEGER NOT NULL,\n  at TEXT NOT NULL,\n  type TEXT NOT NULL,\n  record TEXT NOT NULL,\n  PRIMARY KEY (ticketId, seq)\n) WITHOUT ROWID;\nCREATE INDEX IF NOT EXISTS events_at ON events (at);\nCREATE TABLE IF NOT EXISTS ticket_deps (\n  upstream TEXT NOT NULL,\n  downstream TEXT NOT NULL,\n  record TEXT NOT NULL,\n  PRIMARY KEY (upstream, downstream)\n) WITHOUT ROWID;\nCREATE INDEX IF NOT EXISTS deps_downstream ON ticket_deps (downstream);\nCREATE TABLE IF NOT EXISTS kv (\n  key TEXT PRIMARY KEY,\n  value TEXT NOT NULL\n) WITHOUT ROWID;\nCREATE TABLE IF NOT EXISTS conversations (\n  id TEXT PRIMARY KEY,\n  profileId TEXT NOT NULL,\n  createdAt TEXT NOT NULL,\n  lastMessageAt TEXT NOT NULL,\n  record TEXT NOT NULL\n) WITHOUT ROWID;\nCREATE INDEX IF NOT EXISTS conversations_profile ON conversations (profileId, lastMessageAt);\nCREATE TABLE IF NOT EXISTS conversation_messages (\n  seq INTEGER PRIMARY KEY AUTOINCREMENT,\n  id TEXT NOT NULL UNIQUE,\n  conversationId TEXT NOT NULL,\n  at TEXT NOT NULL,\n  role TEXT NOT NULL,\n  record TEXT NOT NULL\n);\nCREATE INDEX IF NOT EXISTS conversation_messages_conversation ON conversation_messages (conversationId, seq);\nCREATE TABLE IF NOT EXISTS assets (\n  id TEXT PRIMARY KEY,\n  kind TEXT NOT NULL,\n  name TEXT NOT NULL,\n  createdAt TEXT NOT NULL,\n  updatedAt TEXT NOT NULL,\n  archived INTEGER NOT NULL DEFAULT 0,\n  record TEXT NOT NULL\n) WITHOUT ROWID;\nCREATE INDEX IF NOT EXISTS assets_kind ON assets (kind, updatedAt);\nCREATE INDEX IF NOT EXISTS assets_archived ON assets (archived, updatedAt);\nCREATE TABLE IF NOT EXISTS memory_entries (\n  id TEXT PRIMARY KEY,\n  kind TEXT NOT NULL,\n  scope TEXT NOT NULL,\n  createdAt TEXT NOT NULL,\n  updatedAt TEXT NOT NULL,\n  record TEXT NOT NULL\n) WITHOUT ROWID;\nCREATE INDEX IF NOT EXISTS memory_entries_scope ON memory_entries (scope, kind, updatedAt);\n;CREATE TABLE IF NOT EXISTS desk_messages (\n  seq INTEGER PRIMARY KEY AUTOINCREMENT,\n  role TEXT NOT NULL,\n  content TEXT NOT NULL,\n  tool_calls TEXT,\n  tool_call_id TEXT,\n  name TEXT,\n  ticketId TEXT,\n  requestId TEXT,\n  at TEXT NOT NULL\n);INSERT INTO schema_version VALUES(8);"
function v8() {
  const path = join(tempDir('ordin-v9-'), 'v8.sqlite3')
  const db = new DatabaseSync(path)
  db.exec(V8_DDL)
  db.prepare('INSERT INTO effects VALUES(?,?,?,?,?,?)').run('work', 'queued', '{"q":1}', 123, 2, 0)
  db.prepare('INSERT INTO effects VALUES(?,?,?,?,?,?)').run('work', 'claimed', '{"c":1}', 456, 3, 1)
  db.close()
  return path
}
function inspectDb<T>(path: string, f: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path); try { return f(db) } finally { db.close() }
}
const rows = (db: DatabaseSync) => db.prepare('SELECT * FROM effects ORDER BY key').all()

describe('schema v9 effect ownership', () => {
  it('backfills unique UUIDs preserving queued data, resets claims, retains a real v8 prebackup and reopens unchanged', () => {
    const path = v8()
    const before = inspectDb(path, rows)
    const store = new Store(path)
    const backup = store.migrationBackupPath!
    try {
      const after = inspectDb(path, rows)
      expect(SCHEMA_VERSION).toBe(9)
      expect(after.map(({ generation, claimToken, ...row }) => row)).toEqual(before.map(row => ({ ...row, running: 0 })))
      expect(new Set(after.map(row => row.generation)).size).toBe(2)
      for (const row of after) {
        expect(row.generation).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
        expect(row.claimToken).toBeNull()
      }
      const columns = inspectDb(path, db => db.prepare('PRAGMA table_xinfo(effects)').all())
      expect(columns.find(row => row.name === 'generation')).toMatchObject({ type: 'TEXT', notnull: 1 })
      expect(columns.find(row => row.name === 'claimToken')).toMatchObject({ type: 'TEXT', notnull: 0 })
      inspectDb(backup, db => { expect(rows(db)).toEqual(before); expect(db.prepare('SELECT version FROM schema_version').get()?.version).toBe(8) })
      const restore = join(tempDir('ordin-v9-rollback-'), 'restored.sqlite3')
      copyFileSync(backup, restore)
      expect(inspectDb(restore, rows)).toEqual(before)
      const upgraded = new Store(restore); upgraded.close()
      expect(inspectDb(restore, db => db.prepare('SELECT version FROM schema_version').get()?.version)).toBe(9)
    } finally { store.close() }
    const after = inspectDb(path, rows)
    const reopened = new Store(path); expect(reopened.migrationBackupPath).toBeUndefined(); reopened.close()
    expect(inspectDb(path, rows)).toEqual(after)
  })
  it('rolls back both added columns and claim resets when stamping fails, retaining prebackup', () => {
    const path = v8()
    inspectDb(path, db => db.exec("CREATE TRIGGER fail_stamp BEFORE INSERT ON schema_version BEGIN SELECT RAISE(ABORT, 'stamp rejected'); END"))
    const before = inspectDb(path, rows)
    expect(() => new Store(path)).toThrow(/pre-upgrade backup retained.*stamp rejected/)
    inspectDb(path, db => {
      expect(rows(db)).toEqual(before)
      expect(db.prepare('SELECT version FROM schema_version').get()?.version).toBe(8)
      expect(db.prepare('PRAGMA table_xinfo(effects)').all().map(row => row.name)).not.toContain('generation')
    })
  })
})
