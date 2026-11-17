import { afterEach, describe, expect, it } from 'vitest'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { ProcessRegistry } from '../src/app/process.ts'
import type { ProcessRecord } from '../src/app/process.ts'

const NODE = process.execPath
/** Marker string baked into every test child, so the shell sweep can prove none survived. */
const MARK = 'ordin-p2-test'
const SLEEPER = `/*${MARK}*/ setTimeout(() => {}, 30000)`

function alive(pid: number | null): boolean {
  if (pid === null) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function pollFor<T>(fn: () => T | null | undefined | false, ms = 4000): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = fn()
    if (value !== null && value !== undefined && value !== false) return value
    if (Date.now() - started > ms) throw new Error(`pollFor timed out after ${ms}ms`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function expectDead(pid: number | null): Promise<void> {
  expect(pid, 'pid must be registered').not.toBeNull()
  await pollFor(() => (!alive(pid) ? true : null))
}

describe('ProcessRegistry', () => {
  const registries: ProcessRegistry[] = []
  function registry(): ProcessRegistry {
    const reg = new ProcessRegistry()
    registries.push(reg)
    return reg
  }
  afterEach(async () => {
    // No test may leave a child behind, whatever it asserted above.
    for (const reg of registries.splice(0)) await reg.stopAll(100)
  })

  it('captures a numeric zero exit code and registers id/pid/owner/start time', async () => {
    const reg = registry()
    const before = Date.now()
    const rec = reg.spawn({ owner: 'ticket-1', argv: [NODE, '-e', 'process.exit(0)'] })
    expect(rec.id).toMatch(/^proc-/)
    expect(rec.pid).toBeTypeOf('number')
    expect(rec.owner).toBe('ticket-1')
    expect(rec.groupId).toBe(rec.id)
    expect(rec.startedAt).toBeGreaterThanOrEqual(before)
    expect(rec.status).toBe('running')
    const res = await reg.wait(rec.id)
    expect(res.exitCode).toBe(0)
    expect(res.status).toBe('exited')
    expect(rec.status).toBe('exited')
    expect(rec.endedAt).not.toBeNull()
    await expectDead(rec.pid)
  })

  it('captures a non-zero exit code without throwing', async () => {
    const reg = registry()
    const rec = reg.spawn({ owner: 'ticket-2', argv: [NODE, '-e', 'process.exit(3)'] })
    const res = await reg.wait(rec.id)
    expect(res.exitCode).toBe(3)
    expect(rec.status).toBe('exited')
    expect(rec.error).toBeNull()
  })

  it('configures cwd, env and stdin, and collects stdout/stderr', async () => {
    const reg = registry()
    const script = [
      "let s=''",
      "process.stdin.on('data', (d) => { s += d })",
      "process.stdin.on('end', () => {",
      "  console.log('in:' + s)",
      "  console.log('env:' + process.env.ORDIN_P2_VAR)",
      "  console.log('cwd:' + process.cwd())",
      "  process.stderr.write('err-line')",
      '})',
    ].join('\n')
    const rec = reg.spawn({
      owner: 'ticket-io',
      argv: [NODE, '-e', script],
      cwd: tmpdir(),
      env: { ORDIN_P2_VAR: 'p2-value' },
      stdin: 'hello-stdin',
    })
    const res = await reg.wait(rec.id)
    expect(res.exitCode).toBe(0)
    expect(rec.stdout).toContain('in:hello-stdin')
    expect(rec.stdout).toContain('env:p2-value')
    expect(rec.stdout).toContain(`cwd:${realpathSync(tmpdir())}`)
    expect(rec.stderr).toContain('err-line')
    expect(rec.stdoutTruncated).toBe(false)
    expect(rec.stderrTruncated).toBe(false)
  })

  it('caps stdout and stderr at the configured byte limits', async () => {
    const reg = registry()
    const script = "process.stdout.write('x'.repeat(300000)); process.stderr.write('e'.repeat(60000))"
    const rec = reg.spawn({
      owner: 'ticket-cap',
      argv: [NODE, '-e', script],
      stdoutLimit: 4096,
      stderrLimit: 1024,
    })
    const res = await reg.wait(rec.id)
    expect(res.exitCode).toBe(0)
    expect(rec.stdoutTruncated).toBe(true)
    expect(rec.stderrTruncated).toBe(true)
    expect(Buffer.byteLength(rec.stdout)).toBeLessThanOrEqual(4096)
    expect(Buffer.byteLength(rec.stderr)).toBeLessThanOrEqual(1024)
    expect(rec.stdout.startsWith('xxxx')).toBe(true)
  })

  it('lists processes by owner', async () => {
    const reg = registry()
    const a = reg.spawn({ owner: 'alice', argv: [NODE, '-e', SLEEPER] })
    reg.spawn({ owner: 'bob', argv: [NODE, '-e', SLEEPER] })
    const c = reg.spawn({ owner: 'alice', argv: [NODE, '-e', SLEEPER] })
    expect(reg.list('alice').map((r) => r.id).sort()).toEqual([a.id, c.id].sort())
    expect(reg.list('bob')).toHaveLength(1)
    expect(reg.list()).toHaveLength(3)
    await reg.stopAll(100)
    expect(reg.list('alice').every((r) => r.status === 'stopped')).toBe(true)
    expect(reg.list().every((r: ProcessRecord) => r.status !== 'running')).toBe(true)
  })

  it('cancels via AbortSignal and reaps the child', async () => {
    const reg = registry()
    const ac = new AbortController()
    const rec = reg.spawn({
      owner: 'ticket-abort',
      argv: [NODE, '-e', SLEEPER],
      signal: ac.signal,
      graceMs: 150,
    })
    // Give the child's process group a moment to exist before signalling it.
    await new Promise((resolve) => setTimeout(resolve, 150))
    ac.abort()
    const res = await reg.wait(rec.id)
    expect(res.status).toBe('canceled')
    expect(res.exitCode).toBeNull()
    expect(res.exitSignal).toBe('SIGTERM')
    await expectDead(rec.pid)
  })

  it('never starts when the AbortSignal is already aborted', async () => {
    const reg = registry()
    const ac = new AbortController()
    ac.abort()
    const rec = reg.spawn({ owner: 'ticket-pre', argv: [NODE, '-e', SLEEPER], signal: ac.signal })
    const res = await reg.wait(rec.id)
    expect(res.status).toBe('canceled')
    expect(rec.pid).toBeNull()
  })

  it('cancels the whole process group, leaving no orphaned grandchild', async () => {
    const reg = registry()
    const script = [
      `/*${MARK}*/`,
      "const { spawn } = require('node:child_process')",
      `const c = spawn(process.execPath, ['-e', '/*${MARK}-grand*/ setTimeout(() => {}, 30000)'])`,
      "console.log('grandchild:' + c.pid)",
      'setTimeout(() => {}, 30000)',
    ].join('\n')
    const rec = reg.spawn({ owner: 'ticket-group', argv: [NODE, '-e', script], graceMs: 150 })
    const grandPid = await pollFor(() => {
      const m = /grandchild:(\d+)/.exec(rec.stdout)
      return m?.[1] ? Number(m[1]) : null
    })
    expect(alive(grandPid)).toBe(true)
    await reg.cancel(rec.id)
    expect(rec.status).toBe('canceled')
    await expectDead(rec.pid)
    await expectDead(grandPid)
  })

  it('cancelGroup kills every member of the group id and only those', async () => {
    const reg = registry()
    const a = reg.spawn({ owner: 't', groupId: 'job-1', argv: [NODE, '-e', SLEEPER], graceMs: 100 })
    const b = reg.spawn({ owner: 't', groupId: 'job-1', argv: [NODE, '-e', SLEEPER], graceMs: 100 })
    const c = reg.spawn({ owner: 't', groupId: 'job-2', argv: [NODE, '-e', SLEEPER], graceMs: 100 })
    await reg.cancelGroup('job-1')
    expect(a.status).toBe('canceled')
    expect(b.status).toBe('canceled')
    expect(c.status).toBe('running')
    await expectDead(a.pid)
    await expectDead(b.pid)
    expect(alive(c.pid)).toBe(true)
    await reg.cancel(c.id)
    await expectDead(c.pid)
  })

  it('stopAll terminates everything still running and leaves finished records alone', async () => {
    const reg = registry()
    const a = reg.spawn({ owner: 'x', argv: [NODE, '-e', SLEEPER], graceMs: 100 })
    const b = reg.spawn({ owner: 'y', argv: [NODE, '-e', SLEEPER], graceMs: 100 })
    const finished = reg.spawn({ owner: 'y', argv: [NODE, '-e', 'process.exit(0)'] })
    await reg.wait(finished.id)
    await reg.stopAll()
    expect(a.status).toBe('stopped')
    expect(b.status).toBe('stopped')
    expect(finished.status).toBe('exited')
    await expectDead(a.pid)
    await expectDead(b.pid)
  })

  it('reaps a run past its timeout even when it ignores SIGTERM', async () => {
    const reg = registry()
    const script = `/*${MARK}*/ process.on('SIGTERM', () => {}); setTimeout(() => {}, 30000)`
    const rec = reg.spawn({
      owner: 'ticket-timeout',
      argv: [NODE, '-e', script],
      timeoutMs: 200,
      graceMs: 200,
    })
    const started = Date.now()
    const res = await reg.wait(rec.id)
    const elapsed = Date.now() - started
    expect(res.status).toBe('timedout')
    expect(rec.exitSignal).toBe('SIGKILL')
    expect(elapsed).toBeLessThan(5000)
    await expectDead(rec.pid)
  })

  it('reports a spawn failure on the record instead of throwing', async () => {
    const reg = registry()
    const rec = reg.spawn({ owner: 'ticket-bad', argv: ['/nonexistent/ordin-p2-no-such-bin'] })
    const res = await reg.wait(rec.id)
    expect(res.status).toBe('failed')
    expect(res.exitCode).toBeNull()
    expect(rec.error).toMatch(/ENOENT/)
  })

  it('delivers incremental stdout/stderr callbacks and reports a throwing listener', async () => {
    const reg = registry()
    const stdout: string[] = []
    const stderr: string[] = []
    const rec = reg.spawn({
      owner: 'ticket-callbacks',
      argv: [NODE, '-e', "process.stdout.write('out'); process.stderr.write('err')"],
      onStdout: text => { stdout.push(text) },
      onStderr: text => { stderr.push(text); throw new Error('listener boom') },
    })
    await reg.wait(rec.id)
    expect(stdout.join('')).toBe('out')
    expect(stderr.join('')).toBe('err')
    expect(rec.error).toContain('listener boom')
  })

  it('treats cancel of unknown or already finished ids as a no-op', async () => {
    const reg = registry()
    await reg.cancel('proc-nope')
    const rec = reg.spawn({ owner: 't', argv: [NODE, '-e', 'process.exit(0)'] })
    await reg.wait(rec.id)
    await reg.cancel(rec.id)
    expect(rec.status).toBe('exited')
  })
})

describe('capture limits never silence the protocol stream (B1)', () => {
  it('keeps parsing past the capture cap, so a final marker after megabytes still arrives', async () => {
    const registry = new ProcessRegistry()
    const chunks: string[] = []
    const rec = registry.spawn({
      owner: 'b1',
      argv: ['perl', '-e', 'print "x" x 262144; print "\nFINAL: done\n"'],
      stdoutLimit: 4096,
      onStdout: text => { chunks.push(text) },
    })
    const done = await registry.wait(rec.id)
    expect(done.status).toBe('exited')
    expect(chunks.join('')).toContain('FINAL: done')
    const record = registry.get(rec.id)!
    expect(record.stdoutTruncated).toBe(true)
    expect(record.stdout.length).toBeLessThanOrEqual(4096 * 2)
  })
})

describe('kill outcomes stay honest (B5)', () => {
  it('stopping an already-exited process leaves no fabricated error', async () => {
    const registry = new ProcessRegistry()
    const rec = registry.spawn({ owner: 'b5', argv: ['sh', '-c', 'exit 0'] })
    await registry.wait(rec.id)
    await registry.stopAll(50)
    const record = registry.get(rec.id)!
    expect(record.status).toBe('exited')
    expect(record.error).toBeNull()
  })
})
