import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ProcessRegistry } from '../src/app/process.ts'
import { DshDriver } from '../src/drivers/dsh.ts'
import type { LaunchSpec, WorkerEvent } from '../src/drivers/types.ts'
import { tempDir } from './helpers/temp.ts'

function fakeDsh(): string {
  const dir = tempDir('ordin-fake-dsh-')
  const path = join(dir, 'dsh')
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2)
const out = value => process.stdout.write(JSON.stringify(value) + '\\n')
if (args.includes('--version')) { console.log('0.2.2-rc.3'); process.exit(0) }
if (args.includes('--help')) { console.log('Usage: dsh headless --json --approval-policy never --permission-mode preset --session-id id'); process.exit(0) }
const resumed = args.indexOf('--session-id')
const sessionId = resumed >= 0 ? args[resumed + 1] : 'session-fake-1'
out({ type: 'session', sessionId, cwd: process.cwd() })
const mode = process.env.FAKE_DSH_MODE || 'ok'
if (mode === 'sleep') { setTimeout(() => {}, 30000) }
else if (mode === 'no-final') { process.exit(0) }
else if (mode === 'empty') { out({ type: 'final', sessionId, text: '', reason: { kind: 'completed' } }); process.exit(0) }
else if (mode === 'report') {
  const fence = String.fromCharCode(96).repeat(3)
  out({ type: 'final', sessionId, text: 'DSH 做完了\\n' + fence + 'ordin-report\\n' + JSON.stringify({ state: 'ready', summary: 'DSH 完成', files: ['RESULT.md'] }) + '\\n' + fence, reason: { kind: 'completed' } })
  process.exit(0)
}
else if (mode === 'legacy-error') {
  out({ type:'status', phase:'turn_end', reason:{kind:'error',error:{code:'MISSING_CREDENTIAL',message:'no API key for provider route'}} });
  out({ type:'final', text:'' }); process.exit(1);
}
else if (mode === 'error') {
  out({ type: 'status', phase: 'turn_start', turn: 1 })
  out({ type: 'final', sessionId, text: '', reason: { kind: 'error', error: { code: 'MISSING_CREDENTIAL', message: 'no API key' } } })
  process.exit(1)
} else {
  out({ type: 'status', phase: 'step_end', usage: { inputTokens: 10, outputTokens: 3, cacheReadTokens: 2 } })
  out({ type: 'final', sessionId, text: 'DSH 做完了', reason: { kind: 'completed' } })
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

describe('DshDriver', () => {
  it('preserves legacy turn_end credential error when final omits reason', async () => {
    const proc=new ProcessRegistry(); const driver=new DshDriver(proc,{binary:fakeDsh()});
    try { const turn=await driver.launch(await driver.prepare(spec(tempDir('legacy-error-'),{FAKE_DSH_MODE:'legacy-error'}))); const result=await turn.done; expect(result).toMatchObject({status:'failed',error:{code:'missing_credential',message:'no API key for provider route'}}) } finally { await proc.stopAll() }
  })
  it('probe 读版本与 headless 能力，auth 由注入 key 证明', async () => {
    const proc = new ProcessRegistry()
    const driver = new DshDriver(proc, { binary: fakeDsh(), env: { DEEPSEEK_API_KEY: 'test-only' } })
    const health = await driver.probe()
    expect(health).toMatchObject({ backend: 'dsh', ok: true, version: '0.2.2-rc.3', auth: 'ok' })
    await proc.stopAll()
  })

  it('launch 实时解析 session/usage/text/final，完成必须见 completed', async () => {
    const proc = new ProcessRegistry()
    const dir = tempDir('ordin-dsh-work-')
    const driver = new DshDriver(proc, { binary: fakeDsh() })
    const turn = await driver.launch(await driver.prepare(spec(dir)))
    const events = await collect(turn.events)
    const result = await turn.done
    expect(result).toMatchObject({ status: 'completed', text: 'DSH 做完了', session: { id: 'session-fake-1' }, usage: { input: 12, output: 3, cached: 2 } })
    expect(events.map(event => event.kind)).toEqual(['started', 'usage', 'text', 'final'])
    expect(await turn.feed('追问')).toMatchObject({ status: 'queued-for-next-turn' })
    await proc.stopAll()
  })

  it('final 中的合法 ordin-report 会变成结构化 report 事件', async () => {
    const proc = new ProcessRegistry()
    const dir = tempDir('ordin-dsh-report-')
    const driver = new DshDriver(proc, { binary: fakeDsh() })
    const turn = await driver.launch(await driver.prepare(spec(dir, { FAKE_DSH_MODE: 'report' })))
    const events = await collect(turn.events)
    const result = await turn.done
    expect(result.status).toBe('completed')
    const report = events.find((event): event is Extract<WorkerEvent, { kind: 'report' }> => event.kind === 'report')
    expect(report?.report).toMatchObject({ state: 'ready', summary: 'DSH 完成', files: ['RESULT.md'] })
    await proc.stopAll()
  })

  it('resume 把既有 session id 传给 CLI 并保持身份', async () => {
    const proc = new ProcessRegistry()
    const dir = tempDir('ordin-dsh-resume-')
    const driver = new DshDriver(proc, { binary: fakeDsh() })
    const session = { backend: 'dsh' as const, id: 'session-existing-9', cwd: dir, savedAt: new Date().toISOString() }
    const turn = await driver.resume(session, await driver.prepare(spec(dir)))
    const result = await turn.done
    expect(result.status).toBe('completed')
    expect(result.session?.id).toBe('session-existing-9')
    await proc.stopAll()
  })

  it('final error 映射 missing_credential，不伪装完成', async () => {
    const proc = new ProcessRegistry()
    const dir = tempDir('ordin-dsh-error-')
    const driver = new DshDriver(proc, { binary: fakeDsh() })
    const turn = await driver.launch(await driver.prepare(spec(dir, { FAKE_DSH_MODE: 'error' })))
    const result = await turn.done
    expect(result.status).toBe('failed')
    expect(result.error).toMatchObject({ code: 'missing_credential', retryable: false })
    await proc.stopAll()
  })

  it('退出码 0 但没有 final 是 protocol_error', async () => {
    const proc = new ProcessRegistry()
    const dir = tempDir('ordin-dsh-no-final-')
    const driver = new DshDriver(proc, { binary: fakeDsh() })
    const turn = await driver.launch(await driver.prepare(spec(dir, { FAKE_DSH_MODE: 'no-final' })))
    const result = await turn.done
    expect(result).toMatchObject({ status: 'failed', error: { code: 'protocol_error' } })
    await proc.stopAll()
  })

  it('completed 但空文本是 protocol_error', async () => {
    const proc = new ProcessRegistry()
    const dir = tempDir('ordin-dsh-empty-')
    const driver = new DshDriver(proc, { binary: fakeDsh() })
    const turn = await driver.launch(await driver.prepare(spec(dir, { FAKE_DSH_MODE: 'empty' })))
    const result = await turn.done
    expect(result).toMatchObject({ status: 'failed', error: { code: 'protocol_error' } })
    await proc.stopAll()
  })

  it('cancel 按进程组收尸并返回 cancelled', async () => {
    const proc = new ProcessRegistry()
    const dir = tempDir('ordin-dsh-cancel-')
    const driver = new DshDriver(proc, { binary: fakeDsh() })
    const turn = await driver.launch(await driver.prepare(spec(dir, { FAKE_DSH_MODE: 'sleep' })))
    await new Promise(resolve => setTimeout(resolve, 150))
    await turn.cancel('测试取消')
    const result = await turn.done
    expect(result.status).toBe('cancelled')
    await proc.stopAll()
  })
})
