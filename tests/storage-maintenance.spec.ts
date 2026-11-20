import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, realpathSync, rmSync, readFileSync, readdirSync, statSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { AssetCatalog } from '../src/app/asset-catalog.ts'
import { AssetObjects } from '../src/app/asset-objects.ts'
import { Store, SCHEMA_VERSION } from '../src/app/store.ts'
import { takeLock } from '../src/app/lock.ts'
const roots: string[] = []
const fresh = () => { const p = mkdtempSync(join(realpathSync(tmpdir()), 'ordin-maint-')); roots.push(p); return p }
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }) })
const cli = (...args: string[]) => spawnSync(process.execPath, ['--experimental-transform-types', resolve('src/index.ts'), 'storage', ...args], { cwd: process.cwd(), encoding: 'utf8', timeout: 10000, env: { ...process.env, ORDIN_STATE_DIR: join(fresh(), 'implicit-state') } })
function fixture(dir: string, value: string, version = SCHEMA_VERSION): string {
  const p = join(dir, 'ordin.sqlite3'); const s = new Store(p); s.set('retained', value); s.close()
  const db = new DatabaseSync(p); db.exec('UPDATE schema_version SET version=' + version); db.close(); return p
}
function value(p: string): unknown { const db = new DatabaseSync(p, { readOnly: true }); try { return db.prepare("SELECT value FROM kv WHERE key='retained'").get()?.value } finally { db.close() } }
describe('storage maintenance CLI', () => {
  it('runs storage maintenance through a symlink to the entry file or checkout', () => {
    const dir = fresh(), sandbox = fresh()
    fixture(dir, 'linked')
    const fileLink = join(sandbox, 'entry.ts'), directoryLink = join(sandbox, 'checkout')
    symlinkSync(resolve('src/index.ts'), fileLink)
    symlinkSync(process.cwd(), directoryLink)
    for (const [index, entry] of [fileLink, join(directoryLink, 'src/index.ts')].entries()) {
      const output = join(sandbox, 'backup-' + index + '.sqlite3')
      const result = spawnSync(process.execPath, ['--experimental-transform-types', entry, 'storage', 'backup', '--state-dir', dir, '--output', output], { encoding: 'utf8', timeout: 10000 })
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toContain('Storage backup created:')
      expect(value(output)).toBe(JSON.stringify('linked'))
    }
  })
  it('accepts versions 1 through 9, including v8 inputs without ownership columns', () => {
    for (let version = 1; version <= SCHEMA_VERSION; version++) {
      const dir = fresh()
      const path = fixture(dir, 'version-' + version, version)
      if (version < 9) {
        const db = new DatabaseSync(path)
        db.exec('ALTER TABLE effects DROP COLUMN generation; ALTER TABLE effects DROP COLUMN claimToken')
        db.close()
      }
      const before = readFileSync(path)
      const output = join(fresh(), 'backup.sqlite3')
      const result = cli('backup', '--state-dir', dir, '--output', output)
      expect(result.status, result.stderr).toBe(0)
      expect(value(output)).toBe(JSON.stringify('version-' + version))
      expect(readFileSync(path)).toEqual(before)
    }
  })
  it.each(['generation', 'claimToken'])('refuses v9 missing %s without replacing target', column => {
    const dir = fresh(); const target = fixture(dir, 'safe'); const before = readFileSync(target)
    const input = fixture(fresh(), 'input')
    const db = new DatabaseSync(input); db.exec('ALTER TABLE effects DROP COLUMN ' + column); db.close()
    expect(cli('restore', '--state-dir', dir, '--input', input).status).not.toBe(0)
    expect(readFileSync(target)).toEqual(before)
  })
  it('requires explicit state and strict arguments without starting the server', () => {
    for (const args of [['backup'], ['restore'], ['unknown'], ['backup', '--output', join(fresh(), 'unused')], ['backup', '--state-dir', '/', '--output', join(fresh(), 'unused')]]) { const r = cli(...args); expect(r.error).toBeUndefined(); expect(r.status).not.toBe(0); expect(r.stdout).not.toContain('started') }
  })
  it('backs up historical committed WAL data without migration and restores with a private usable rollback', () => {
    const dir = fresh(); const source = fixture(dir, 'before', 7); const backup = join(fresh(), 'backup.sqlite3')
    const writer = new DatabaseSync(source); writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0'); writer.prepare("UPDATE kv SET value=? WHERE key='retained'").run(JSON.stringify("in WAL"))
    try { const r = cli('backup', '--state-dir', dir, '--output', backup); expect(r.status, r.stderr).toBe(0); expect(value(backup)).toBe('"in WAL"'); expect(statSync(backup).mode & 0o777).toBe(0o600) } finally { writer.close() }
    const db = new DatabaseSync(source); db.prepare("UPDATE kv SET value=? WHERE key='retained'").run(JSON.stringify("after")); db.close()
    const r = cli('restore', '--state-dir', dir, '--input', backup); expect(r.status, r.stderr).toBe(0)
    expect(value(source)).toBe('"in WAL"'); expect(statSync(source).mode & 0o777).toBe(0o600)
    const rollback = readdirSync(dir).find(n => n.includes('.rollback-'))!; expect(rollback).toBeTruthy(); expect(value(join(dir, rollback))).toBe('"after"'); expect(statSync(join(dir, rollback)).mode & 0o777).toBe(0o600)
    const check = new DatabaseSync(source, { readOnly: true }); expect(check.prepare('SELECT version FROM schema_version').get()?.version).toBe(7); check.close()
    expect(readdirSync(dir)).not.toContain('ordin.lock'); expect(readdirSync(dir)).not.toContain('ordin.json')
    const undo = cli('restore', '--state-dir', dir, '--input', join(dir, rollback)); expect(undo.status, undo.stderr).toBe(0); expect(value(source)).toBe('"after"')
  })
  it('restores into an empty existing state directory without copying adjacent files', () => {
    const dir = fresh(); const sourceDir = fresh(); const input = fixture(sourceDir, 'source')
    writeFileSync(join(sourceDir, 'credentials.json'), 'do-not-copy')
    const r = cli('restore', '--state-dir', dir, '--input', input); expect(r.status, r.stderr).toBe(0)
    expect(readdirSync(dir)).toEqual(['ordin.sqlite3']); expect(value(join(dir, 'ordin.sqlite3'))).toBe('"source"')
  })
  it('refuses active target WAL without replacing data and retains committed WAL in rollback', () => {
    const dir = fresh(); const target = fixture(dir, 'target'); const input = fixture(fresh(), 'input')
    const writer = new DatabaseSync(target); writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0')
    writer.prepare("UPDATE kv SET value=? WHERE key='retained'").run(JSON.stringify('target WAL'))
    try {
      const r = cli('restore', '--state-dir', dir, '--input', input); expect(r.status, r.stderr).not.toBe(0)
      expect(value(target)).toBe('"target WAL"')
      const rollback = readdirSync(dir).find(n => n.includes('.rollback-'))!; expect(value(join(dir, rollback))).toBe('"target WAL"')
      expect(readdirSync(dir).some(n => n.startsWith('.ordin-restore-'))).toBe(false)
      expect(readdirSync(dir)).not.toContain('ordin.lock')
    } finally { writer.close() }
  })
  it('refuses orphan output sidecars without touching them or the target', () => {
    const dir = fresh(); fixture(dir, 'safe'); const out = join(fresh(), 'backup.sqlite3')
    writeFileSync(out + '-wal', 'orphan')
    expect(cli('backup', '--state-dir', dir, '--output', out).status).not.toBe(0)
    expect(readFileSync(out + '-wal', 'utf8')).toBe('orphan'); expect(readdirSync(resolve(out, '..'))).toEqual(['backup.sqlite3-wal'])
  })
  it('refuses invalid, newer, duplicate stamp and schema drift inputs with byte-identical target', () => {
    const dir = fresh(); const target = fixture(dir, 'safe'); const before = readFileSync(target)
    for (const kind of ['invalid', 'newer', 'duplicate', 'drift']) {
      const input = join(fresh(), 'ordin.sqlite3')
      if (kind === 'invalid') writeFileSync(input, 'not sqlite')
      else { fixture(resolve(input, '..'), 'secret'); const db = new DatabaseSync(input); db.exec(kind === 'newer' ? 'UPDATE schema_version SET version=' + (SCHEMA_VERSION + 1) : kind === 'duplicate' ? 'INSERT INTO schema_version VALUES(8)' : 'DROP TABLE assets'); db.close() }
      const r = cli('restore', '--state-dir', dir, '--input', input); expect(r.status, kind).not.toBe(0); expect(r.stderr).not.toContain('secret'); expect(readFileSync(target)).toEqual(before); expect(readdirSync(dir)).toEqual(['ordin.sqlite3'])
    }
  })
  it('refuses locks, overwrite, aliases, symlinks, traversal and missing state without DB changes', () => {
    const dir = fresh(); const target = fixture(dir, 'safe'); const before = readFileSync(target); const out = join(fresh(), 'new.sqlite3')
    const input = fixture(fresh(), 'input')
    const lock = takeLock(dir); try { expect(cli('backup', '--state-dir', dir, '--output', out).status).not.toBe(0); expect(cli('restore', '--state-dir', dir, '--input', input).status).not.toBe(0) } finally { lock.release() }
    expect(cli('backup', '--state-dir', dir, '--output', input).status).not.toBe(0)
    symlinkSync(target, out)
    for (const args of [['backup', '--state-dir', dir, '--output', out], ['restore', '--state-dir', dir, '--input', target], ['backup', '--state-dir', dir + '/../' + dir.split('/').at(-1), '--output', out], ['backup', '--state-dir', join(dir, 'missing'), '--output', out]]) expect(cli(...args).status).not.toBe(0)
    expect(readFileSync(target)).toEqual(before)
  })
})

describe('instance recovery staging', () => {
  it.each(['missing', 'partial'])('refuses an effects table with a %s unique constraint', kind => {
    const dir = fresh(); const target = fixture(dir, 'safe'); const before = readFileSync(target)
    const input = fixture(fresh(), 'bad')
    const db = new DatabaseSync(input)
    db.exec('DROP TABLE effects; CREATE TABLE effects (kind TEXT NOT NULL, key TEXT NOT NULL, payload TEXT NOT NULL, dueAt INTEGER NOT NULL, failures INTEGER NOT NULL, running INTEGER NOT NULL, generation TEXT NOT NULL, claimToken TEXT);')
    if (kind === 'partial') db.exec('CREATE UNIQUE INDEX broken ON effects(kind, key) WHERE running=0')
    db.close()
    const result = cli('restore', '--state-dir', dir, '--input', input)
    expect(result.status, result.stderr).toBe(1)
    expect(result.stderr).toContain('effects(kind,key)')
    expect(readFileSync(target)).toEqual(before)
    expect(readdirSync(dir)).toEqual(['ordin.sqlite3'])
  })
  it('verifies multiple current and pinned historical objects before using a staged restore', async () => {
    const live = fresh(); const previous = fixture(live, 'previous'); const liveBytes = readFileSync(previous)
    const source = fresh(); const path = fixture(source, 'new')
    const backup = join(fresh(), 'backup.sqlite3'); const target = fresh()
    const store = new Store(path); const objects = new AssetObjects(source)
    const refs = []
    try {
      for (const id of ['first', 'second']) {
        const data = []
        for (const revision of [1, 2]) {
          const bytes = Buffer.from(id + ':' + revision)
          const object = await objects.put(bytes)
          data.push({ id, revision, contentHash: object.objectKey, bytes, storageVersion: 1, storage: { kind: 'managed-object', ...object } })
        }
        refs.push(...data)
        const [historical, current] = data.map(({ bytes: _bytes, ...record }) => record)
        store.assets.save({ ...current, id, revisions: [historical], ownerProfileId: 'default', name: id, kind: 'document', status: 'active', createdAt: '2026-11-19', updatedAt: '2026-11-19' } as Parameters<Store['assets']['save']>[0])
      }
    } finally { store.close() }
    const backedUp = cli('backup', '--state-dir', source, '--output', backup)
    expect(backedUp.status, backedUp.stderr).toBe(0)
    const restored = cli('restore', '--state-dir', target, '--input', backup)
    expect(restored.status, restored.stderr).toBe(0)
    const targetDb = join(target, 'ordin.sqlite3')
    const targetBytes = readFileSync(targetDb)
    const verify = () => cli('verify', '--state-dir', target)
    const verified = verify()
    expect(verified.status, verified.stderr).toBe(0)
    expect(verified.stdout).toContain('4 managed asset objects')
    const locked = takeLock(target)
    try {
      const busy = verify()
      expect(busy.status, busy.stderr).toBe(1)
      expect(busy.stderr).toContain('lock exists')
    } finally { locked.release() }
    const historical = refs[0]!
    const historicalPath = join(target, 'asset-objects', historical.contentHash)
    writeFileSync(historicalPath, 'tampered')
    const corrupt = verify()
    expect(corrupt.status, corrupt.stderr).toBe(1)
    expect(corrupt.stderr).toContain('Managed asset object verification failed')
    expect(readFileSync(historicalPath, 'utf8')).toBe('tampered')
    expect(readFileSync(targetDb)).toEqual(targetBytes)
    expect(readFileSync(previous)).toEqual(liveBytes)
    expect(readdirSync(target).sort()).toEqual(['asset-objects', 'ordin.sqlite3'])
    writeFileSync(historicalPath, historical.bytes)
    const valid = verify()
    expect(valid.status, valid.stderr).toBe(0)
    expect(valid.stdout).toContain('4 managed asset objects')
    const recovered = new Store(targetDb)
    try {
      const catalog = new AssetCatalog(recovered, target)
      for (const { id, revision, contentHash, bytes } of refs) {
        await expect(catalog.resolveBytes({ id, revision, contentHash })).resolves.toMatchObject({ ref: { id, revision, contentHash }, bytes })
      }
    } finally { recovered.close() }
    const replacement = cli('restore', '--state-dir', target, '--input', previous)
    expect(replacement.status, replacement.stderr).toBe(0)
    const rollback = join(target, readdirSync(target).find(name => name.endsWith('.sqlite3') && name.includes('.rollback-'))!)
    const rollbackTarget = fresh()
    const undo = cli('restore', '--state-dir', rollbackTarget, '--input', rollback)
    expect(undo.status, undo.stderr).toBe(0)
    const reopened = new Store(join(rollbackTarget, 'ordin.sqlite3'))
    try {
      const catalog = new AssetCatalog(reopened, rollbackTarget)
      for (const { id, revision, contentHash, bytes } of refs) {
        await expect(catalog.resolveBytes({ id, revision, contentHash })).resolves.toMatchObject({ ref: { id, revision, contentHash }, bytes })
      }
    } finally { reopened.close() }
  })
  it('rejects missing or corrupt backup objects and cleans failed backups', async () => {
    const source = fresh(); const path = fixture(source, 'source'); const objects = new AssetObjects(source)
    const bytes = Buffer.from('only object'); const object = await objects.put(bytes)
    const store = new Store(path)
    try { store.assets.save({ id: 'asset-1', kind: 'document', name: 'one', description: '', source: { type: 'operator-import', actor: 'operator' }, createdAt: '2026-11-19', updatedAt: '2026-11-19', contentHash: object.objectKey, revision: 1, status: 'active', archived: false, storageVersion: 1, storage: { kind: 'managed-object', ...object }, ownerProfileId: 'default' } as Parameters<Store['assets']['save']>[0]) } finally { store.close() }
    const backup = join(fresh(), 'backup.sqlite3'); expect(cli('backup', '--state-dir', source, '--output', backup).status).toBe(0)
    const sidecar = backup + '.assets'
    const objectPath = join(sidecar, object.objectKey)
    const target = fresh(); const targetDb = fixture(target, 'safe'); const before = readFileSync(targetDb)
    const targetObject = await new AssetObjects(target).put(Buffer.from('keep this'))
    const keepPath = join(target, 'asset-objects', targetObject.objectKey)
    writeFileSync(objectPath, 'tampered')
    for (const diagnostic of ['verification failed', 'missing']) {
      const result = cli('restore', '--state-dir', target, '--input', backup)
      expect(result.status, result.stderr).toBe(1)
      expect(result.stderr).toContain(diagnostic)
      expect(readFileSync(targetDb)).toEqual(before)
      expect(readFileSync(keepPath, 'utf8')).toBe('keep this')
      expect(readdirSync(join(target, 'asset-objects'))).toEqual([targetObject.objectKey])
      expect(readdirSync(target).sort()).toEqual(['asset-objects', 'ordin.sqlite3'])
      rmSync(objectPath, { force: true })
    }
    rmSync(join(source, 'asset-objects', object.objectKey))
    const failedOutput = join(fresh(), 'failed.sqlite3')
    const failed = cli('backup', '--state-dir', source, '--output', failedOutput)
    expect(failed.status, failed.stderr).toBe(1)
    expect(failed.stderr).toContain('missing')
    expect(readdirSync(resolve(failedOutput, '..'))).toEqual([])
    expect(readdirSync(source).sort()).toEqual(['asset-objects', 'ordin.sqlite3'])
  })
})
