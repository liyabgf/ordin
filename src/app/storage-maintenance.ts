/** Offline database-only maintenance. Never construct Store here: opening it may migrate. */
import { DatabaseSync } from 'node:sqlite'
import { closeSync, fsyncSync, lstatSync, openSync, renameSync, unlinkSync } from 'node:fs'
import { dirname, join, parse, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { LockHeld, takeLock } from './lock.ts'

const DB_FILE = 'ordin.sqlite3'
class MaintenanceError extends Error {}
function fail(message: string): never { throw new MaintenanceError(message) }
function stat(path: string) {
  try { return lstatSync(path) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e }
}
/** Reject traversal and every symlink component before resolving any write destination. */
function safePath(raw: string): string {
  if (!raw.trim() || raw.includes('\0') || raw.split(/[\/\\]/).includes('..')) fail('Unsafe path')
  const path = resolve(raw)
  let cursor = parse(path).root
  for (const part of path.slice(cursor.length).split(sep).filter(Boolean)) {
    cursor = join(cursor, part)
    if (stat(cursor)?.isSymbolicLink()) fail('Symlink paths are refused')
  }
  return path
}
function directory(raw: string): string {
  const path = safePath(raw)
  if (path === parse(path).root || !stat(path)?.isDirectory()) fail('An existing non-root directory is required')
  return path
}
function file(path: string, optional = false): boolean {
  const info = stat(path)
  if (!info && optional) return false
  if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail('A regular, unlinked file is required')
  return true
}
function sidecars(path: string): void {
  for (const suffix of ['-wal', '-shm', '-journal']) { const p = path + suffix; if (stat(p)) file(p) }
}
const base: Record<string, string[]> = {
  triggers: ['id','source','kind','at','disposition','record'], tickets: ['id','createdAt','open','record'],
  decisions: ['id','triggerId','at','outcome','record'], effects: ['kind','key','payload','dueAt','failures','running'], kv: ['key','value'],
}
/** Integrity and versioned structural contract, without executing application migrations. */
function validate(db: DatabaseSync): number {
  const integrity = db.prepare('PRAGMA integrity_check').all()
  if (integrity.length !== 1 || Object.values(integrity[0]!)[0] !== 'ok') fail('SQLite integrity validation failed')
  const rows = db.prepare('SELECT version FROM schema_version LIMIT 2').all()
  const version = rows[0]?.version
  if (rows.length !== 1 || typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1 || version > 9) fail('Unsupported schema_version: require exactly one integer in 1..9')
  const required = { ...base }
  if (version >= 2) required.artifacts = ['ticketId','path','at','record']
  if (version >= 3) { required.projects = ['id','name','createdAt','record']; required.works = ['id','projectId','name','createdAt','record']; required.tickets = [...base.tickets!, 'workId','workSeq'] }
  if (version >= 4) required.events = ['ticketId','seq','at','type','record']
  if (version >= 5) required.ticket_deps = ['upstream','downstream','record']
  if (version >= 6) required.threads = ['key','record']
  if (version >= 7) required.desk_messages = ['seq','role','content','tool_calls','tool_call_id','name','ticketId','requestId','at']
  if (version >= 8) {
    required.conversations = ['id','profileId','createdAt','lastMessageAt','record']
    required.conversation_messages = ['seq','id','conversationId','at','role','record']
    required.assets = ['id','kind','name','createdAt','updatedAt','archived','record']
    required.memory_entries = ['id','kind','scope','createdAt','updatedAt','record']
  }
  if (version >= 9) required.effects = [...base.effects!, 'generation', 'claimToken']
  for (const [table, names] of Object.entries(required)) {
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) fail('Required schema table missing')
    const columns = db.prepare('PRAGMA table_xinfo(' + table + ')').all()
    if (names.some(name => !columns.some(c => c.name === name))) fail('Required schema columns missing')
    if (table === 'effects' && version >= 9) {
      const generation = columns.find(c => c.name === 'generation')!
      const claimToken = columns.find(c => c.name === 'claimToken')!
      if (generation.type !== 'TEXT' || generation.notnull !== 1 || claimToken.type !== 'TEXT' || claimToken.notnull !== 0) fail('Invalid effect ownership schema')
    }
    if (table === 'conversation_messages' || table === 'desk_messages') {
      const seq = columns.find(c => c.name === 'seq')
      const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(table)?.sql
      if (seq?.type !== 'INTEGER' || seq.pk !== 1 || typeof sql !== 'string' || !/\bAUTOINCREMENT\b/i.test(sql)) fail('Invalid message sequence schema')
    }
  }
  return version
}
function read<T>(path: string, fn: (db: DatabaseSync) => T): T {
  file(path); sidecars(path)
  const db = new DatabaseSync(path, { readOnly: true })
  try { return fn(db) } finally { db.close() }
}
function sync(path: string): void { const fd = openSync(path, 'r'); try { fsyncSync(fd) } finally { closeSync(fd) } }
function snapshot(source: string, output: string): void {
  for (const suffix of ['-wal','-shm','-journal']) if (stat(output + suffix)) fail('Output sidecars already exist')
  // wx reserves a private empty file; VACUUM INTO reads committed WAL pages through SQLite.
  const fd = openSync(output, 'wx', 0o600); closeSync(fd)
  try {
    read(source, db => { validate(db); db.prepare('VACUUM INTO ?').run(output) })
    read(output, validate); sync(output)
  } catch (error) { unlinkSync(output); throw error }
}
function checkpoint(path: string): void {
  sidecars(path)
  const db = new DatabaseSync(path)
  try {
    const row = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
    if (row && row.busy !== 0) fail('Target checkpoint is busy; restore refused')
    // SQLite owns sidecar cleanup, including changing out of WAL. Never unlink them manually.
    const mode = db.prepare('PRAGMA journal_mode=DELETE').get()
    if (Object.values(mode ?? {})[0] !== 'delete') fail('Cannot leave target WAL mode')
  } finally { db.close() }
  for (const suffix of ['-wal','-shm','-journal']) if (stat(path + suffix)) fail('Target sidecars remain; restore refused')
}
export function storageMaintenance(args: string[]): number {
  const [command, ...rest] = args
  const option = command === 'backup' ? '--output' : command === 'restore' ? '--input' : undefined
  if (!option || rest.length !== 4) { console.error('Usage: storage backup|restore --state-dir <existing-dir> --output|--input <file>'); return 2 }
  const values = new Map<string, string>()
  for (let i=0; i<rest.length; i+=2) {
    const key = rest[i]!, value = rest[i+1]!
    if ((key !== '--state-dir' && key !== option) || values.has(key) || value.startsWith('--') || !value.trim()) { console.error('Invalid storage arguments'); return 2 }
    values.set(key,value)
  }
  if (!values.has('--state-dir') || !values.has(option)) { console.error('Explicit --state-dir and file required'); return 2 }
  try {
    const stateDir = directory(values.get('--state-dir')!)
    const external = safePath(values.get(option)!)
    directory(dirname(external))
    const target = safePath(join(stateDir, DB_FILE))
    safePath(join(stateDir, 'ordin.lock')); if (stat(join(stateDir, 'ordin.lock'))) file(join(stateDir, 'ordin.lock'))
    if (external === target) fail('Source and target must differ')
    if (command === 'restore') read(external, validate)
    else { if (stat(external)) fail('Backup output must be a new file'); read(target, validate) }
    const lock = takeLock(stateDir)
    try {
      if (command === 'backup') {
        snapshot(target, external)
        console.log('Database backup created: ' + external)
      } else {
        const stage = join(stateDir, '.ordin-restore-' + randomUUID() + '.sqlite3')
        let rollback: string | undefined
        try {
          snapshot(external, stage)
          if (file(target, true)) {
            rollback = target + '.rollback-' + randomUUID() + '.sqlite3'
            snapshot(target, rollback)
            checkpoint(target)
          } else {
            for (const suffix of ['-wal','-shm','-journal']) if (stat(target + suffix)) fail('Orphan target sidecars; restore refused')
          }
          renameSync(stage, target)
          console.log('Database restored: ' + target + (rollback ? '\nRollback retained: ' + rollback : ''))
        } finally { if (stat(stage)) unlinkSync(stage) }
      }
    } finally { lock.release() }
    return 0
  } catch (error) {
    // SQLite errors can contain record values. Only our own fixed diagnostics are safe to echo.
    const reason = error instanceof MaintenanceError ? error.message : error instanceof LockHeld ? 'State directory lock is held' : 'SQLite validation or filesystem operation failed'
    console.error('Storage maintenance failed: ' + reason)
    return 1
  }
}
