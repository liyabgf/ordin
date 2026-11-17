import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const P0_ROOT = '/tmp/ordin-p0'

export function nowIso() { return new Date().toISOString() }

export async function sh(argv, options = {}) {
  mkdirSync(P0_ROOT, { recursive: true })
  const started = Date.now()
  return await new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd ?? P0_ROOT,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options.spawn,
    })
    let stdout = '', stderr = '', timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, options.timeoutMs ?? 120_000)
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.on('error', error => { clearTimeout(timer); resolve({ argv, exitCode: null, signal: null, timedOut, error: String(error), stdout, stderr, durationMs: Date.now() - started }) })
    child.on('close', (exitCode, signal) => { clearTimeout(timer); resolve({ argv, exitCode, signal, timedOut, stdout, stderr, durationMs: Date.now() - started }) })
  })
}

export function clip(text, max = 12000) {
  const s = String(text ?? '')
  return s.length <= max ? s : s.slice(0, max) + `\n...[clipped ${s.length - max} chars]`
}

export function check(id, status, detail = {}) { return { id, status, ...detail } }

export async function writeProbeResult(backend, result) {
  const dir = join(P0_ROOT, 'results')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${backend}.json`)
  writeFileSync(path, JSON.stringify(result, null, 2) + '\n', 'utf8')
  return path
}

export function summarize(result) {
  const rows = result.checks.map(c => `- ${c.id}: ${c.status}${c.note ? ' — ' + c.note : ''}`)
  return [`backend: ${result.backend}`, `version: ${result.version ?? 'unknown'}`, `auth: ${result.auth ?? 'unknown'}`, ...rows].join('\n')
}
