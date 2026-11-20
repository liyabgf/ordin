/** Offline state maintenance. Never construct Store here: opening it may migrate. */
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, parse, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
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
function sidecars(path: string): boolean {
  let found = false
  for (const suffix of ['-wal', '-shm', '-journal']) {
    if (file(path + suffix, true)) found = true
  }
  return found
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
    if (table === 'effects') {
      const indexes = db.prepare('SELECT name FROM pragma_index_list(?) WHERE [unique]=1 AND partial=0').all(table)
      const columnsIn = db.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno')
      const constrained = indexes.some(index => {
        const keys = columnsIn.all(index.name!)
        return keys.length === 2 && keys[0]?.name === 'kind' && keys[1]?.name === 'key'
      })
      if (!constrained || ['kind', 'key'].some(name => columns.find(c => c.name === name)?.notnull !== 1)) {
        fail('Required unique constraint missing: effects(kind,key)')
      }
    }
  }
  return version
}
function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('Asset metadata is invalid')
  return value as Record<string, unknown>
}

function managedKeys(db: DatabaseSync): string[] {
  if (validate(db) < 8) return []
  const keys = new Set<string>()
  for (const { record } of db.prepare('SELECT record FROM assets').iterate()) {
    if (typeof record !== 'string') fail('Asset record is invalid')
    let parsed: unknown
    try { parsed = JSON.parse(record) } catch { fail('Asset record is invalid JSON') }
    const asset = asRecord(parsed)
    if (asset.revisions !== undefined && !Array.isArray(asset.revisions)) fail('Asset revision history is invalid')
    for (const entry of [asset, ...(asset.revisions as unknown[] | undefined ?? [])]) {
      const ref = asRecord(entry)
      if (ref.storage === undefined && ref.storageVersion === undefined) continue
      const storage = asRecord(ref.storage)
      const key = storage.objectKey
      if (ref.storageVersion !== 1 || storage.kind !== 'managed-object' || typeof key !== 'string' ||
          !/^[a-f0-9]{64}$/.test(key) || ref.contentHash !== key) fail('Managed asset reference is invalid')
      keys.add(key)
    }
  }
  return [...keys]
}

const objectRoot = (stateDir: string): string => join(stateDir, 'asset-objects')
const objectSidecar = (path: string): string => path + '.assets'

function objectBytes(root: string, key: string): Buffer {
  const rootInfo = stat(root)
  const path = join(root, key)
  if (!rootInfo || (rootInfo.isDirectory() && !stat(path))) fail('Managed asset object missing: ' + key)
  if (!rootInfo.isDirectory()) fail('Managed asset object directory is invalid')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = fstatSync(fd)
    if (!before.isFile() || before.nlink !== 1 || before.size > 32 * 1024 * 1024) fail('Managed asset object is not a bounded regular file: ' + key)
    const bytes = Buffer.alloc(before.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (count === 0) fail('Managed asset object verification failed: ' + key)
      offset += count
    }
    const after = fstatSync(fd)
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
        createHash('sha256').update(bytes).digest('hex') !== key) fail('Managed asset object verification failed: ' + key)
    return bytes
  } finally { closeSync(fd) }
}

function copyObjects(source: string, target: string, keys: string[], allowExisting = false): () => void {
  const added: string[] = []
  let created = false
  const undo = () => {
    for (const path of added) unlinkSync(path)
    if (created) rmdirSync(target)
  }
  if (!keys.length) return undo
  try {
    if (!allowExisting || !stat(target)) {
      mkdirSync(target, { mode: 0o700 })
      created = true
    } else directory(target)
    for (const key of keys) {
      const bytes = objectBytes(source, key)
      const path = join(target, key)
      if (allowExisting && stat(path)) { objectBytes(target, key); continue }
      const fd = openSync(path, 'wx', 0o600)
      added.push(path)
      try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
    }
    sync(target)
    if (created) sync(dirname(target))
    return undo
  } catch (error) { undo(); throw error }
}

function verifyAssets(stateDir: string): void {
  if (stat(join(stateDir, 'ordin.lock'))) fail('State directory lock exists; stop Ordin before verification')
  const path = safePath(join(stateDir, DB_FILE))
  file(path)
  for (const suffix of ['-wal', '-shm', '-journal']) {
    if (stat(path + suffix)) fail('SQLite sidecars present; stop writers and close SQLite before verification')
  }
  const db = new DatabaseSync(pathToFileURL(path).href + '?immutable=1', { readOnly: true })
  try {
    const keys = managedKeys(db)
    for (const key of keys) objectBytes(objectRoot(stateDir), key)
    console.log(keys.length + ' managed asset objects verified')
  } finally { db.close() }
}
function read<T>(path: string, fn: (db: DatabaseSync) => T): T {
  file(path)
  const input = sidecars(path) ? path : pathToFileURL(path).href + '?immutable=1'
  const db = new DatabaseSync(input, { readOnly: true })
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
function backup(source: string, output: string, objects: string): number {
  if (stat(objectSidecar(output))) fail('Backup object directory already exists')
  snapshot(source, output)
  try {
    const keys = read(output, managedKeys)
    copyObjects(objects, objectSidecar(output), keys)
    return keys.length
  } catch (error) { unlinkSync(output); throw error }
}

export function storageMaintenance(args: string[]): number {
  const [command, ...rest] = args
  const option = command === 'backup' ? '--output' : command === 'restore' ? '--input' : undefined
  if (command === 'verify') {
    if (rest.length !== 2 || rest[0] !== '--state-dir' || rest[1]?.startsWith('--')) {
      console.error('Usage: storage verify --state-dir <existing-dir>')
      return 2
    }
    try { verifyAssets(directory(rest[1]!)); return 0 } catch (error) {
      console.error('Storage verification failed: ' + (error instanceof MaintenanceError ? error.message : 'Database or object verification failed'))
      return 1
    }
  }
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
    const lockPath = safePath(join(stateDir, 'ordin.lock'))
    file(lockPath, true)
    if (external === target) fail('Source and target must differ')
    const lock = takeLock(stateDir)
    try {
      if (command === 'backup') {
        const count = backup(target, external, objectRoot(stateDir))
        console.log('Storage backup created: ' + external + ' (' + count + ' managed asset objects)')
      } else {
        const stage = join(stateDir, '.ordin-restore-' + randomUUID() + '.sqlite3')
        let undoObjects: (() => void) | undefined
        let rollback: string | undefined
        try {
          snapshot(external, stage)
          const keys = read(stage, managedKeys)
          const sidecar = safePath(objectSidecar(external))
          for (const key of keys) objectBytes(sidecar, key)

          const replacing = file(target, true)
          if (replacing) {
            rollback = target + '.rollback-' + randomUUID() + '.sqlite3'
            backup(target, rollback, objectRoot(stateDir))
          } else {
            for (const suffix of ['-wal','-shm','-journal']) if (stat(target + suffix)) fail('Orphan target sidecars; restore refused')
          }
          undoObjects = copyObjects(sidecar, objectRoot(stateDir), keys, true)
          if (replacing && sidecars(target)) checkpoint(target)
          renameSync(stage, target)
          undoObjects = undefined
          console.log('Storage restored: ' + target + (rollback ? '\nRollback retained: ' + rollback : ''))
        } finally {
          try { undoObjects?.() } finally { if (stat(stage)) unlinkSync(stage) }
        }
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
