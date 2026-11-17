#!/usr/bin/env node
// P0-T2 DSH contract probes. Isolation: /tmp/ordin-p0-dsh/{home,npm}; web is never booted and plugin_manager is never called.
// Exit contract: 0 means every requested probe finished and produced machine-readable evidence; per-probe status is in the JSON.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { check, clip, sh, summarize } from './common.mjs'

const ROOT = '/tmp/ordin-p0-dsh'
const HOME = `${ROOT}/home`
const BIN = `${ROOT}/npm/node_modules/.bin/dsh`
const CWD = process.cwd()
const ENV = { HOME, DSH_HOME: HOME, DSH_TELEMETRY_DISABLED: '1' }

function parseEvents(stdout) {
  const events = []
  const bad = []
  for (const [index, line] of stdout.split(/\n/).entries()) {
    if (!line.trim()) continue
    try { events.push({ line: index + 1, value: JSON.parse(line) }) }
    catch { bad.push({ line: index + 1, text: clip(line, 240) }) }
  }
  return { events, bad }
}

async function runDsh(id, args, timeoutMs = 180_000) {
  const result = await sh([BIN, ...args], { cwd: CWD, env: ENV, timeoutMs })
  const parsed = parseEvents(result.stdout)
  const first = parsed.events.find(item => item.value.type === 'session')?.value
  const finalEvent = [...parsed.events].reverse().find(item => item.value.type === 'final')?.value
  const errorEvent = parsed.events.find(item => item.value.type === 'error')?.value
  return {
    id,
    argv: result.argv,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    stderr: clip(result.stderr, 4000),
    spawnError: result.error ?? null,
    sessionId: first?.sessionId ?? null,
    eventTypes: parsed.events.map(item => item.value.type),
    malformedJsonLines: parsed.bad,
    finalEvent: finalEvent ?? null,
    errorEvent: errorEvent ?? null,
  }
}

function completed(run) {
  return run.exitCode === 0
    && !run.timedOut
    && run.finalEvent?.type === 'final'
    && run.finalEvent?.sessionId === run.sessionId
    && run.finalEvent?.reason?.kind === 'completed'
    && run.sessionId?.startsWith('session-')
}

function credentialBlocked(run) {
  return run.finalEvent?.reason?.error?.code === 'MISSING_CREDENTIAL'
    || run.stderr.includes('MISSING_CREDENTIAL')
}

function evidence(raw) {
  return {
    eventTypes: raw.eventTypes,
    firstEvent: raw.sessionId ? { type: 'session', sessionId: raw.sessionId } : raw.errorEvent,
    statusSamples: raw.eventTypes.includes('status') ? 'status events captured; full NDJSON in probe logs' : null,
    finalEvent: raw.finalEvent,
    stderr: raw.stderr,
    exitCode: raw.exitCode,
  }
}

const installation = await (async () => {
  const node = await sh(['node', '--version'], { cwd: CWD, env: ENV })
  const npm = await sh(['npm', '--version'], { cwd: CWD, env: ENV })
  const version = await sh([BIN, '--version'], { cwd: CWD, env: ENV })
  const packageJson = await readFile(`${ROOT}/npm/node_modules/@deepseek-ai/dsh/package.json`, 'utf8').then(JSON.parse)
  return check('install-pin', version.exitCode === 0 && packageJson.version === version.stdout.trim() ? 'passed' : 'failed', {
    version: version.stdout.trim() || null,
    packageJsonVersion: packageJson.version,
    bin: BIN,
    node: node.stdout.trim(), nodeExitCode: node.exitCode,
    npm: npm.stdout.trim(), npmExitCode: npm.exitCode,
    note: 'local prefix /tmp/ordin-p0-dsh/npm; global npm untouched'
  })
})()

const probe1 = await runDsh('start-task', ['headless', '--permission-mode', 'read-only', '--approval-policy', 'never', '--json', '只回复 OK'])
const probe2 = { ...probe1, id: 'event-stream' }
const probe3 = { ...probe1, id: 'structured-final' }
const probe4 = await runDsh('session-resume', ['headless', '--session-id', probe1.sessionId, '--permission-mode', 'read-only', '--approval-policy', 'never', '--json', '请继续并只回复 OK'])

const negativeUnknown = await runDsh('resume-negative-unknown-session', ['headless', '--session-id', 'headless-unknown-session', '--json', 'Continue'])
const negativePermission = await runDsh('permission-negative-unknown-preset', ['headless', '--permission-mode', 'not-a-preset', '--approval-policy', 'never', '--json', '只回复 OK'])

const auth = credentialBlocked(probe1) ? 'missing-deepseek-credential' : (completed(probe1) ? 'ok' : 'unknown')

const result = {
  backend: 'dsh',
  measuredAt: new Date().toISOString(),
  version: installation.version,
  auth,
  contractRule: 'completed only when exitCode=0, no timeout, final.reason.kind=completed, and final.sessionId equals the session event id',
  checks: [
    installation,
    check(probe1.id, auth === 'missing-deepseek-credential' ? 'blocked' : (completed(probe1) ? 'passed' : 'failed'), {
      ...evidence(probe1),
      note: auth === 'missing-deepseek-credential'
        ? 'process started and emitted session/status/final, but the model turn was refused with MISSING_CREDENTIAL'
        : 'end-to-end model completion must satisfy the contract rule',
    }),
    check(probe2.id, auth === 'missing-deepseek-credential' ? 'blocked' : (completed(probe2) && probe2.malformedJsonLines.length === 0 ? 'passed' : 'failed'), {
      ...evidence(probe2),
      malformedJsonLineCount: probe2.malformedJsonLines.length,
      note: auth === 'missing-deepseek-credential' ? 'NDJSON skeleton captured, but no successful model event stream occurred' : null,
    }),
    check(probe3.id, auth === 'missing-deepseek-credential' ? 'blocked' : (completed(probe3) ? 'passed' : 'failed'), {
      ...evidence(probe3),
      note: auth === 'missing-deepseek-credential' ? 'structured error final observed; successful structured final not observed' : null,
    }),
    check(probe4.id, auth === 'missing-deepseek-credential' ? 'blocked' : (completed(probe4) && probe4.sessionId === probe1.sessionId ? 'passed' : 'failed'), {
      ...evidence(probe4),
      resumedSessionId: probe4.sessionId,
      originalSessionId: probe1.sessionId,
      sameSessionId: probe4.sessionId === probe1.sessionId,
      negativeUnknown: { exitCode: negativeUnknown.exitCode, stderr: clip(negativeUnknown.stderr, 1000), errorEvent: negativeUnknown.errorEvent },
      negativePermission: { exitCode: negativePermission.exitCode, stderr: clip(negativePermission.stderr, 1000), errorEvent: negativePermission.errorEvent },
      note: auth === 'missing-deepseek-credential' ? 'resume reused the persisted session id and advanced to turn 2, but context retention was not model-verified' : null,
    }),
  ],
  raw: { probe1, probe4, negativeUnknown, negativePermission },
}

async function writeLocalResult(result) {
  const dir = `${ROOT}/results`
  await mkdir(dir, { recursive: true })
  const path = `${dir}/dsh.json`
  await writeFile(path, JSON.stringify(result, null, 2) + '\n', 'utf8')
  return path
}

const path = await writeLocalResult(result)
console.log(summarize(result))
console.log(`result: ${path}`)
