import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ProcessRegistry } from '../src/app/process.ts'
import { CodexDriver } from '../src/drivers/codex.ts'
import type { LaunchSpec, WorkerEvent } from '../src/drivers/types.ts'
import { tempDir } from './helpers/temp.ts'

function fakeCodex(): string {
  const dir = tempDir('ordin-fake-codex-')
  const path = join(dir, 'codex')
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args.includes('--version')) { console.log('codex-cli 0.166.0-alpha.6'); process.exit(0) }
if (args.includes('login')) { console.log(process.env.FAKE_CODEX_AUTH === 'ok' ? 'Logged in' : 'Not logged in'); process.exit(process.env.FAKE_CODEX_AUTH === 'ok' ? 0 : 1) }
const out = value => process.stdout.write(JSON.stringify(value) + '\\n')
const resumed = args.indexOf('resume') >= 0
const threadId = resumed ? args.filter(a => a.startsWith('thread-')).at(-1) : 'thread-fake-1'
out({ type: 'thread.started', thread_id: threadId })
out({ type: 'turn.started' })
const mode = process.env.FAKE_CODEX_MODE || 'ok'
if (mode === 'sleep') { setTimeout(() => {}, 30000) }
else if (mode === 'no-completed') { process.exit(0) }
else if (mode === 'failed') { out({ type: 'turn.failed', error: { message: 'Your access token could not be refreshed' } }); process.exit(1) }
else if (mode === 'empty') { out({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 1, cached_input_tokens: 2 } }); process.exit(0) }
else {
  out({ type: 'item.completed', item: { type: 'agent_message', text: 'Codex 做完了' } })
  out({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 1, cached_input_tokens: 2 } })
  process.exit(0)
}
`
  writeFileSync(path, script, 'utf8')
  chmodSync(path, 0o755)
  return path
}

function spec(dir: string, env?: Record<string, string>): LaunchSpec {
  return { ticketId: 'ticket-1', assignmentId: 'assignment-1', cwd: dir, prompt: '只回复 OK', access: 'edit', preparedAt: new Date().toISOString(), ...(env === undefined ? {} : { env }) }
}

async function collect(events: AsyncIterable<WorkerEvent>): Promise<WorkerEvent[]> {
  const result: WorkerEvent[] = []
  for await (const event of events) result.push(event)
  return result
}

describe('CodexDriver', () => {
  it('probe 读版本并用 login status 判登录态', async () => {
    const proc = new ProcessRegistry()
    const driver = new CodexDriver(proc, { binary: fakeCodex(), env: { FAKE_CODEX_AUTH: 'ok' } })
    const health = await driver.probe()
    expect(health).toMatchObject({ backend: 'codex', ok: true, version: 'codex-cli 0.166.0-alpha.6', auth: 'ok' })
    await proc.stopAll()
  })

  it('launch 解析 thread/agent_message/usage，completed 才完成', async () => {
    const proc = new ProcessRegistry()
    const dir = tempDir('ordin-codex-work-')
    const driver = new CodexDriver(proc, { binary: fakeCodex() })
    const turn = await driver.launch(await driver.prepare(spec(dir)))
    const events = await collect(turn.events)
    const result = await turn.done
    expect(result).toMatchObject({ status: 'completed', text: 'Codex 做完了', session: { id: 'thread-fake-1' }, usage: { input: 7, output: 1, cached: 2 } })
    expect(events.map(event => event.kind)).toEqual(['started', 'usage', 'text', 'final'])
    expect(await turn.feed('追问')).toMatchObject({ status: 'queued-for-next-turn' })
    await proc.stopAll()
  })

  it('resume 复用同一 thread id', async () => {
    const proc = new ProcessRegistry()
    const dir = tempDir('ordin-codex-resume-')
    const driver = new CodexDriver(proc, { binary: fakeCodex() })
    const session = { backend: 'codex' as const, id: 'thread-existing-3', cwd: dir, savedAt: new Date().toISOString() }
    const turn = await driver.resume(session, await driver.prepare(spec(dir)))
    const result = await turn.done
    expect(result.status).toBe('completed')
    expect(result.session?.id).toBe('thread-existing-3')
    await proc.stopAll()
  })

  it('turn.failed 映射 auth_expired，不伪装完成', async () => {
    const proc = new ProcessRegistry()
    const dir = tempDir('ordin-codex-failed-')
    const driver = new CodexDriver(proc, { binary: fakeCodex() })
    const turn = await driver.launch(await driver.prepare(spec(dir, { FAKE_CODEX_MODE: 'failed' })))
    const result = await turn.done
    expect(result).toMatchObject({ status: 'failed', error: { code: 'auth_expired' } })
    await proc.stopAll()
  })

  it('exit 0 但没有 turn.completed 是 protocol_error', async () => {
    const proc = new ProcessRegistry()
    const dir = tempDir('ordin-codex-no-completed-')
    const driver = new CodexDriver(proc, { binary: fakeCodex() })
    const turn = await driver.launch(await driver.prepare(spec(dir, { FAKE_CODEX_MODE: 'no-completed' })))
    const result = await turn.done
    expect(result).toMatchObject({ status: 'failed', error: { code: 'protocol_error' } })
    await proc.stopAll()
  })

  it('completed 但没有 agent_message 是 protocol_error', async () => {
    const proc = new ProcessRegistry()
    const dir = tempDir('ordin-codex-empty-')
    const driver = new CodexDriver(proc, { binary: fakeCodex() })
    const turn = await driver.launch(await driver.prepare(spec(dir, { FAKE_CODEX_MODE: 'empty' })))
    const result = await turn.done
    expect(result).toMatchObject({ status: 'failed', error: { code: 'protocol_error' } })
    await proc.stopAll()
  })

  it('cancel 收尸进程组并返回 cancelled', async () => {
    const proc = new ProcessRegistry()
    const dir = tempDir('ordin-codex-cancel-')
    const driver = new CodexDriver(proc, { binary: fakeCodex() })
    const turn = await driver.launch(await driver.prepare(spec(dir, { FAKE_CODEX_MODE: 'sleep' })))
    await new Promise(resolve => setTimeout(resolve, 150))
    await turn.cancel('测试取消')
    const result = await turn.done
    expect(result.status).toBe('cancelled')
    await proc.stopAll()
  })
})
