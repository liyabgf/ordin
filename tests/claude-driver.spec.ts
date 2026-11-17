import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ProcessRegistry } from '../src/app/process.ts'
import { ClaudeDriver } from '../src/drivers/claude.ts'
import type { LaunchSpec, WorkerEvent } from '../src/drivers/types.ts'
import { tempDir } from './helpers/temp.ts'

function fakeClaude(): string {
  const dir = tempDir('ordin-fake-claude-')
  const path = join(dir, 'claude')
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args.includes('--version')) { console.log('2.1.325 (Claude Code)'); process.exit(0) }
if (args.includes('auth')) { console.log(JSON.stringify({ loggedIn: process.env.FAKE_CLAUDE_AUTH === 'ok' })); process.exit(process.env.FAKE_CLAUDE_AUTH === 'ok' ? 0 : 1) }
const out = value => process.stdout.write(JSON.stringify(value) + '\\n')
const resume = args.indexOf('--resume')
const sessionId = resume >= 0 ? args[resume + 1] : 'session-claude-fake-1'
out({ type: 'system', subtype: 'init', session_id: sessionId, cwd: process.cwd(), model: 'fake' })
const mode = process.env.FAKE_CLAUDE_MODE || 'ok'
if (mode === 'sleep') { setTimeout(() => {}, 30000) }
else if (mode === 'no-result') { process.exit(0) }
else if (mode === 'empty') { out({ type: 'result', subtype: 'success', is_error: false, result: '', session_id: sessionId }); process.exit(0) }
else if (mode === 'error') { out({ type: 'result', subtype: 'success', is_error: true, terminal_reason: 'api_error', result: 'Not logged in · Please run /login', session_id: sessionId }); process.exit(1) }
else if (mode === 'silent-error') { out({ type: 'result', subtype: 'success', is_error: true, result: '任务失败：请重试', session_id: sessionId }); process.exit(0) }
else {
  out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Claude 做完了' }] }, session_id: sessionId })
  out({ type: 'result', subtype: 'success', is_error: false, result: 'Claude 做完了', session_id: sessionId, num_turns: 1, total_cost_usd: 0.01, usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 1 } })
  process.exit(0)
}
`
  writeFileSync(path, script, 'utf8')
  chmodSync(path, 0o755)
  return path
}

function spec(dir: string, env?: Record<string, string>): LaunchSpec {
  return { ticketId: 'ticket-1', assignmentId: 'assignment-1', cwd: dir, prompt: '只回复 OK', access: 'full', preparedAt: new Date().toISOString(), ...(env === undefined ? {} : { env }) }
}

async function collect(events: AsyncIterable<WorkerEvent>): Promise<WorkerEvent[]> {
  const result: WorkerEvent[] = []
  for await (const event of events) result.push(event)
  return result
}

describe('ClaudeDriver', () => {
  it('probe 读版本与 auth status 登录态', async () => {
    const proc = new ProcessRegistry()
    const driver = new ClaudeDriver(proc, { binary: fakeClaude(), env: { FAKE_CLAUDE_AUTH: 'ok' } })
    const health = await driver.probe()
    expect(health).toMatchObject({ backend: 'claude', ok: true, version: '2.1.325 (Claude Code)', auth: 'ok' })
    await proc.stopAll()
  })

  it('launch 解析 session/result/usage，完成条件严格', async () => {
    const proc = new ProcessRegistry()
    const dir = tempDir('ordin-claude-work-')
    const driver = new ClaudeDriver(proc, { binary: fakeClaude() })
    const turn = await driver.launch(await driver.prepare(spec(dir)))
    const events = await collect(turn.events)
    const result = await turn.done
    expect(result).toMatchObject({ status: 'completed', text: 'Claude 做完了', session: { id: 'session-claude-fake-1' }, usage: { input: 9, output: 2, cached: 3, costUsd: 0.01 } })
    expect(events.map(event => event.kind)).toEqual(['started', 'usage', 'text', 'final'])
    expect(await turn.feed('追问')).toMatchObject({ status: 'queued-for-next-turn' })
    await proc.stopAll()
  })

  it('resume 复用同一 session id', async () => {
    const proc = new ProcessRegistry()
    const dir = tempDir('ordin-claude-resume-')
    const driver = new ClaudeDriver(proc, { binary: fakeClaude() })
    const session = { backend: 'claude' as const, id: 'session-claude-existing-2', cwd: dir, savedAt: new Date().toISOString() }
    const turn = await driver.resume(session, await driver.prepare(spec(dir)))
    const result = await turn.done
    expect(result.status).toBe('completed')
    expect(result.session?.id).toBe('session-claude-existing-2')
    await proc.stopAll()
  })

  it('subtype=success 但 is_error=true 仍是 missing_credential', async () => {
    const proc = new ProcessRegistry()
    const dir = tempDir('ordin-claude-error-')
    const driver = new ClaudeDriver(proc, { binary: fakeClaude() })
    const turn = await driver.launch(await driver.prepare(spec(dir, { FAKE_CLAUDE_MODE: 'error' })))
    const result = await turn.done
    expect(result).toMatchObject({ status: 'failed', error: { code: 'missing_credential' } })
    await proc.stopAll()
  })

  it('退出码 0 但 is_error=true 仍然失败，不得被 success 伪装', async () => {
    const proc = new ProcessRegistry()
    const dir = tempDir('ordin-claude-silent-error-')
    const driver = new ClaudeDriver(proc, { binary: fakeClaude() })
    const turn = await driver.launch(await driver.prepare(spec(dir, { FAKE_CLAUDE_MODE: 'silent-error' })))
    const result = await turn.done
    expect(result.status).toBe('failed')
    expect(result.error).toMatchObject({ code: 'backend_error' })
    await proc.stopAll()
  })

  it('退出码 0 但没有 result 是 protocol_error', async () => {
    const proc = new ProcessRegistry()
    const dir = tempDir('ordin-claude-no-result-')
    const driver = new ClaudeDriver(proc, { binary: fakeClaude() })
    const turn = await driver.launch(await driver.prepare(spec(dir, { FAKE_CLAUDE_MODE: 'no-result' })))
    const result = await turn.done
    expect(result).toMatchObject({ status: 'failed', error: { code: 'protocol_error' } })
    await proc.stopAll()
  })

  it('success 但空 result 是 protocol_error', async () => {
    const proc = new ProcessRegistry()
    const dir = tempDir('ordin-claude-empty-')
    const driver = new ClaudeDriver(proc, { binary: fakeClaude() })
    const turn = await driver.launch(await driver.prepare(spec(dir, { FAKE_CLAUDE_MODE: 'empty' })))
    const result = await turn.done
    expect(result).toMatchObject({ status: 'failed', error: { code: 'protocol_error' } })
    await proc.stopAll()
  })

  it('cancel 收尸进程组并返回 cancelled', async () => {
    const proc = new ProcessRegistry()
    const dir = tempDir('ordin-claude-cancel-')
    const driver = new ClaudeDriver(proc, { binary: fakeClaude() })
    const turn = await driver.launch(await driver.prepare(spec(dir, { FAKE_CLAUDE_MODE: 'sleep' })))
    await new Promise(resolve => setTimeout(resolve, 150))
    await turn.cancel('测试取消')
    const result = await turn.done
    expect(result.status).toBe('cancelled')
    await proc.stopAll()
  })
})
