import { spawn } from 'node:child_process'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { expect, it } from 'vitest'

it('starts the real entry with no execution binary or model key and serves its own panel', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ordin-independent-'))
  const child = spawn(process.execPath, ['--experimental-transform-types', 'src/index.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, DEEPSEEK_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '',
      ORDIN_DSH_BIN: join(root, 'no-dsh-installed'), ORDIN_STATE_DIR: root,
      ORDIN_WORK_ROOT: join(root, 'work'), ORDIN_INBOX_DIR: join(root, 'inbox'), ORDIN_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const exited = once(child, 'exit')
  try {
    const deadline = Date.now() + 8000
    let panel = ''
    while (!panel) {
      panel = output.match(/panel=[^\s]+/)?.[0]?.slice('panel='.length) ?? ''
      if (child.exitCode !== null || Date.now() > deadline) throw new Error('Ordin failed to start: ' + output)
      if (!panel) await new Promise(resolve => setTimeout(resolve, 25))
    }
    expect((await fetch(panel)).status).toBe(200)
    const deadline2 = Date.now() + 4000
    let state: any
    do {
      state = await (await fetch(panel + 'api/state', { headers: { 'x-ordin-request': '1' } })).json()
      if (state.health?.['execution-backend']?.detail?.includes('no-dsh-installed')) break
      await new Promise(resolve => setTimeout(resolve, 25))
    } while (Date.now() < deadline2)
    expect(state.health['execution-backend']).toMatchObject({ ok: false })
    expect(state.health['execution-backend'].detail).toContain('no-dsh-installed')
    expect(child.exitCode).toBeNull()
  } finally {
    child.kill('SIGTERM')
    const [code] = await exited
    expect(code, output).toBe(0)
    expect(existsSync(join(root, 'ordin.lock'))).toBe(false)
  }
}, 15000)
