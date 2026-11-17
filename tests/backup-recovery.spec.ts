/** Recovery artifacts are snapshots only; restoring/CLI orchestration belongs to a later package. */
import { copyFileSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { Store, SCHEMA_VERSION } from '../src/app/store.ts'
import { tempDir } from './helpers/temp.ts'

function legacy(): string {
  const path = join(tempDir('ordin-backup-'), 'old.sqlite3')
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE schema_version(version INTEGER NOT NULL);
    INSERT INTO schema_version VALUES(7);
    CREATE TABLE tickets(id TEXT PRIMARY KEY, createdAt TEXT, open INTEGER, record TEXT,
      workId TEXT GENERATED ALWAYS AS (json_extract(record, '$.workId')) VIRTUAL,
      workSeq INTEGER GENERATED ALWAYS AS (json_extract(record, '$.workSeq')) VIRTUAL);
    CREATE TABLE kv(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO kv VALUES('retained', '"before upgrade"');
    CREATE TABLE desk_messages(seq INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT, content TEXT, tool_calls TEXT,
      tool_call_id TEXT, name TEXT, ticketId TEXT, requestId TEXT, at TEXT);`)
  db.close()
  return path
}
function inspectDb<T>(path: string, run: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path)
  try { return run(db) } finally { db.close() }
}
const backups = (path: string): string[] => readdirSync(dirname(path)).filter(name => name.startsWith(path.split('/').at(-1)! + '.pre-v'))
const version = (db: DatabaseSync) => db.prepare('SELECT version FROM schema_version').get()?.version
const value = (db: DatabaseSync) => db.prepare("SELECT value FROM kv WHERE key='retained'").get()?.value

describe('migration recovery snapshots', () => {
  it('uses runtime VACUUM INTO to preserve pre-upgrade rows, version and committed WAL data in a private standalone file', () => {
    const path = legacy()
    const writer = new DatabaseSync(path)
    writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0')
    writer.exec(`UPDATE kv SET value='"committed in WAL"'`)
    expect(statSync(path + '-wal').size).toBeGreaterThan(0)
    const store = new Store(path)
    try {
      const backup = store.migrationBackupPath!
      expect(backup).toBeTypeOf('string')
      expect(statSync(backup).mode & 0o777).toBe(0o600)
      inspectDb(backup, db => {
        expect(version(db)).toBe(7)
        expect(value(db)).toBe('"committed in WAL"')
        expect(Object.values(db.prepare('PRAGMA integrity_check').get()!)).toEqual(['ok'])
        expect(db.prepare("SELECT name FROM sqlite_master WHERE name='conversations'").get()).toBeUndefined()
      })
      // Offline restore drill: copy to a separate fixture, open with SQLite, then upgrade independently.
      const restoredPath = join(dirname(path), 'restored.sqlite3')
      copyFileSync(backup, restoredPath)
      inspectDb(restoredPath, db => {
        expect(version(db)).toBe(7); expect(value(db)).toBe('"committed in WAL"')
        expect(Object.values(db.prepare('PRAGMA integrity_check').get()!)).toEqual(['ok'])
      })
      const restored = new Store(restoredPath)
      try { expect(restored.get('retained')).toBe('committed in WAL') } finally { restored.close() }
      expect(store.get('retained')).toBe('committed in WAL')
      expect(inspectDb(path, version)).toBe(SCHEMA_VERSION)
    } finally { store.close(); writer.close() }
    const reopened = new Store(path)
    try { expect(reopened.migrationBackupPath).toBeUndefined(); expect(backups(path)).toHaveLength(1) }
    finally { reopened.close() }
  })

  it('gives each upgrade a unique retained backup even if a prior backup already exists', () => {
    const path = legacy()
    const first = new Store(path)
    const backup = first.migrationBackupPath!
    first.close()
    const bytes = readFileSync(backup)
    inspectDb(path, db => db.exec('UPDATE schema_version SET version=7'))
    const second = new Store(path)
    try { expect(second.migrationBackupPath).not.toBe(backup); expect(readFileSync(backup)).toEqual(bytes) }
    finally { second.close() }
  })

  it('stops before changing schema, rows or journal mode when snapshot creation fails', () => {
    const path = legacy()
    const before = readFileSync(path)
    const exec = DatabaseSync.prototype.exec
    const spy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql.startsWith('VACUUM INTO')) throw new Error('injected snapshot I/O failure')
      return exec.call(this, sql)
    })
    try { expect(() => new Store(path)).toThrow(/backup.*injected snapshot I.O failure/i) }
    finally { spy.mockRestore() }
    expect(readFileSync(path)).toEqual(before)
    inspectDb(path, db => { expect(version(db)).toBe(7); expect(value(db)).toBe('"before upgrade"') })
  })

  it('rolls back migration DDL and rows while retaining a readable backup after stamp failure', () => {
    const path = legacy()
    inspectDb(path, db => db.exec("CREATE TRIGGER fail_stamp BEFORE INSERT ON schema_version BEGIN SELECT RAISE(ABORT, 'stamp rejected'); END"))
    expect(() => new Store(path)).toThrow(/stamp rejected/)
    inspectDb(path, db => {
      expect(version(db)).toBe(7)
      expect(value(db)).toBe('"before upgrade"')
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='conversations'").get()).toBeUndefined()
    })
    expect(backups(path)).toHaveLength(1)
    inspectDb(join(dirname(path), backups(path)[0]!), db => {
      expect(version(db)).toBe(7); expect(value(db)).toBe('"before upgrade"')
      expect(Object.values(db.prepare('PRAGMA integrity_check').get()!)).toEqual(['ok'])
    })
  })

  it('does not back up fresh, empty on-disk, memory or current databases', () => {
    const path = join(tempDir('ordin-no-backup-'), 'fresh.sqlite3')
    new DatabaseSync(path).close()
    for (const target of [path, path, ':memory:']) {
      const store = new Store(target)
      try { expect(store.migrationBackupPath).toBeUndefined() } finally { store.close() }
    }
    expect(backups(path)).toEqual([])
  })
})

describe('schema admission', () => {
  it.each(['0', '-1', '1.5', '9007199254740992', "'unknown'", 'NULL'])('refuses invalid version %s without changing the file', stamp => {
    const path = join(tempDir('ordin-invalid-version-'), 'invalid.sqlite3')
    inspectDb(path, db => db.exec(`CREATE TABLE schema_version(version); INSERT INTO schema_version VALUES(${stamp})`))
    const before = readFileSync(path)
    expect(() => new Store(path)).toThrow(/schema_version/)
    expect(readFileSync(path)).toEqual(before)
  })
  it.each([0, 2])('requires exactly one stamp, refusing %i rows', count => {
    const path = join(tempDir('ordin-stamp-count-'), 'count.sqlite3')
    new Store(path).close()
    inspectDb(path, db => db.exec(count === 0 ? 'DELETE FROM schema_version' : `INSERT INTO schema_version VALUES(${SCHEMA_VERSION})`))
    expect(() => new Store(path)).toThrow(/schema_version.*exactly one/i)
    expect(backups(path)).toEqual([])
  })
  it('refuses current-version message seq drift without rewriting or repairing it', () => {
    const path = join(tempDir('ordin-drift-'), 'drift.sqlite3')
    new Store(path).close()
    inspectDb(path, db => db.exec(`DROP TABLE conversation_messages;
      CREATE TABLE conversation_messages(id TEXT PRIMARY KEY, conversationId TEXT, at TEXT, role TEXT, record TEXT);
      INSERT INTO conversation_messages VALUES('kept', 'c', 'now', 'user', '{}')`))
    const before = readFileSync(path)
    expect(() => new Store(path)).toThrow(/conversation_messages.*seq/i)
    expect(readFileSync(path)).toEqual(before)
  })
  it('refuses missing essential v8 tables instead of treating the stamp as healthy', () => {
    const path = join(tempDir('ordin-missing-'), 'missing.sqlite3')
    new Store(path).close()
    inspectDb(path, db => db.exec('DROP TABLE memory_entries'))
    expect(() => new Store(path)).toThrow(/memory_entries/)
  })
})
