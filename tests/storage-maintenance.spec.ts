import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, realpathSync, rmSync, readFileSync, readdirSync, statSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
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
