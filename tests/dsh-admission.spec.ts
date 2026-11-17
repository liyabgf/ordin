import { chmodSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ProcessRegistry } from '../src/app/process.ts'
import { DshDriver } from '../src/drivers/dsh.ts'
import type { LaunchSpec } from '../src/drivers/types.ts'
import { tempDir } from './helpers/temp.ts'

function fakeDsh(help: string): string {
  const dir = tempDir('ordin-dsh-admission-')
  const path = join(dir, 'dsh')
  const argvPath = join(dir, 'argv')
  const script = '#!/usr/bin/env node\n' +
    "const args = process.argv.slice(2)\n" +
    "if (args.includes('--version')) { console.log('legacy-build'); process.exit(0) }\n" +
    "if (args.includes('--help')) { console.log(" + JSON.stringify(JSON.stringify('PLACEHOLDER')) + " ); process.exit(0) }\n" +
    "require('node:fs').writeFileSync(" + JSON.stringify(argvPath) + ", JSON.stringify(args))\n" +
    "const session = args.includes('--session-id') ? args[args.indexOf('--session-id') + 1] : 'admission-session'\n" +
    "console.log(JSON.stringify({ type: 'session', sessionId: session }))\n" +
    "console.log(JSON.stringify({ type: 'final', text: 'ok', reason: { kind: 'completed' } }))\n" +
    'process.exit(0)\n'
  writeFileSync(path, script.replace('PLACEHOLDER', help))
  chmodSync(path, 0o755)
  return path
}

const base = (cwd: string, access: 'read' | 'edit' | 'full' = 'full', model?: string): LaunchSpec => ({ ticketId: 't', assignmentId: 'a', cwd, prompt: 'run', access, ...(model === undefined ? {} : { model }), preparedAt: new Date().toISOString() })

describe('DshDriver capability admission', () => {
  it('accepts old JSON/session protocol with visible degraded warnings and legacy full launch', async () => {
    const proc = new ProcessRegistry(); const cwd = tempDir('ordin-dsh-old-')
    const binary = fakeDsh('Usage: headless --json --session-id id')
    const driver = new DshDriver(proc, { binary, env: { DEEPSEEK_API_KEY: 'x' } })
    const health = await driver.probe()
    expect(health.ok).toBe(true)
    expect(health.warnings?.some(w => w.includes('degraded_capability'))).toBe(true)
    const turn = await driver.launch(base(cwd))
    expect(await turn.done).toMatchObject({ status: 'completed' })
    expect(JSON.parse(readFileSync(join(binary, '..', 'argv'), 'utf8'))).toEqual(['headless', '--json', 'run'])
    for (const access of ['read', 'edit'] as const) await expect(driver.launch(base(cwd, access))).rejects.toThrow('cannot enforce')
    await expect(driver.launch(base(cwd, 'full', 'x'))).rejects.toThrow('does not support --model')
    const resumed = await driver.resume({ backend: 'dsh', id: 'old-session', cwd, savedAt: new Date().toISOString() }, base(cwd))
    expect(await resumed.done).toMatchObject({ status: 'completed', session: { id: 'old-session' } })
    await proc.stopAll()
  })

  it('passes only advertised safety, model, and session flags', async () => {
    const proc = new ProcessRegistry(); const cwd = tempDir('ordin-dsh-new-')
    const binary = fakeDsh('Usage: headless --json --session-id id --permission-mode preset --approval-policy never --model name')
    const driver = new DshDriver(proc, { binary })
    const turn = await driver.launch(base(cwd, 'edit', 'model-x'))
    expect(await turn.done).toMatchObject({ status: 'completed' })
    const args = JSON.parse(readFileSync(join(binary, '..', 'argv'), 'utf8')) as string[]
    expect(args).toEqual(['headless', '--json', '--permission-mode', 'workspace-write', '--approval-policy', 'never', '--model', 'model-x', 'run'])
    await proc.stopAll()
  })

  it('rejects an unrecognized headless protocol before launch', async () => {
    const proc = new ProcessRegistry(); const cwd = tempDir('ordin-dsh-unknown-')
    const driver = new DshDriver(proc, { binary: fakeDsh('Usage: headless --text') })
    await expect(driver.probe()).resolves.toMatchObject({ ok: false })
    await expect(driver.launch(base(cwd))).rejects.toThrow('--json and --session-id')
    await proc.stopAll()
  })
})
