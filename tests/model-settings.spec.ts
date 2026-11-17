import { expect, it } from 'vitest'
import { mkdtemp, readFile, stat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { boot } from '../src/app/boot.ts'
import { resolveConfig } from '../src/app/config.ts'
import { silentLogger } from '../src/app/logger.ts'
import { ProcessRegistry } from '../src/app/process.ts'
import { createRuntime } from '../src/app/runtime.ts'
import type { WorkerDriver } from '../src/drivers/types.ts'

it('persists private model credentials and exercises draft SSE/models without history or secret leakage', async () => {
  const stateDir = await mkdtemp('/tmp/ordin-model-settings-')
  const seen: { url: string; key: string | undefined; body: Record<string, unknown> }[] = []
  let reject = false
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> : {}
    seen.push({ url: req.url!, key: req.headers.authorization, body })
    if (reject) { res.writeHead(401); res.end('remote echoed ' + req.headers.authorization); return }
    if (req.url === '/v1/models') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'test-model' }, { id: 'other-model' }] })); return }
    res.setHeader('content-type', 'text/event-stream')
    res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n')
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address() as { port: number }
  const config = resolveConfig({ stateDir, workRoot: join(stateDir, 'work'), inboxDir: join(stateDir, 'inbox'), port: 0 })
  const logger = silentLogger()
  const driver = { backend: 'dsh', probe: async () => ({ backend: 'dsh', ok: true, checkedAt: new Date().toISOString(), auth: 'ok', problems: [] }) } as unknown as WorkerDriver
  const runtime = createRuntime(boot({ config, logger }), { logger, driver, proc: new ProcessRegistry(), notifier: null, acceptanceEnabled: false })
  const envName = 'ORDIN_TEST_MODEL_SETTINGS_KEY'
  process.env[envName] = 'environment-test-key'
  try {
    await runtime.start()
    const base = runtime.status().panel + 'api/model/'
    const request = (path: string, method = 'GET', body?: unknown) => fetch(base + path, { method, headers: { 'x-ordin-request': '1', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const draft = { baseUrl: 'http://127.0.0.1:' + address.port + '/v1', model: 'test-model', provider: 'OpenAI compatible', temperature: 0.2, maxTokens: 512, apiKeyEnv: envName }
    expect(await (await request('config')).json()).toEqual({ configuredKey: false, localKey: false, envKey: false, models: [], defaultModel: '' })
    expect((await fetch(base + 'config', { method: 'PUT', body: JSON.stringify(draft) })).status).toBe(403)
    const before = runtime.settings().executor
    expect(await (await request('config', 'PUT', { ...draft, apiKey: 'local-test-key' })).json()).toEqual({ configuredKey: true, localKey: true, envKey: true, models: ['test-model'], defaultModel: 'test-model' })
    expect(runtime.settings().executor).toEqual(before)
    const credential = join(stateDir, 'model-credentials.json')
    expect((await stat(credential)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(credential, 'utf8'))).toEqual({ apiKey: 'local-test-key' })
    expect((await request('config', 'PUT', { ...draft, apiKey: '', models: ['test-model', 'other-model', 'test-model'] })).status).toBe(200)
    expect(await (await request('config')).json()).toMatchObject({ models: ['test-model', 'other-model'], defaultModel: 'test-model' })
    const subsetRevision = runtime.store.settingsRevision()
    const invalidList = await request('config', 'PUT', { ...draft, models: ['test-model', ''] })
    expect(invalidList.status).toBe(400)
    expect(runtime.store.settingsRevision()).toBe(subsetRevision)
    expect(await (await request('config')).json()).toMatchObject({ models: ['test-model', 'other-model'], defaultModel: 'test-model' })
    expect(JSON.parse(await readFile(credential, 'utf8')).apiKey).toBe('local-test-key')
    await runtime.conversationTurn('saved-key-conversation', 'hello')
    expect(seen.at(-1)!.key).toBe('Bearer local-test-key')
    runtime.store.conversations.save({ id: 'foreign-profile', profileId: 'foreign', createdAt: 'now', lastMessageAt: 'now' })
    runtime.store.conversationMessages.append({ id: 'private-message', conversationId: 'foreign-profile', at: 'now', role: 'user', content: 'private' })
    const upstreamBeforeDeniedTurn = seen.length
    await expect(runtime.conversationTurn('foreign-profile', 'intrusion')).rejects.toThrow('Profile')
    expect(() => runtime.conversationMessages('foreign-profile')).toThrow('Profile')
    expect(seen).toHaveLength(upstreamBeforeDeniedTurn)
    expect(runtime.store.conversationMessages.list('foreign-profile')).toHaveLength(1)
    expect(runtime.conversationMessages('saved-key-conversation')).toHaveLength(2)
    expect(runtime.conversationMessages('missing-conversation')).toEqual([])
    await runtime.deskLoop!.relay('saved-key-desk', 'hello')
    expect(seen.at(-1)!.key).toBe('Bearer local-test-key')
    const revision = runtime.store.settingsRevision()
    const seq = runtime.store.deskHistory.latestSeq()
    expect(await (await request('test', 'POST', draft)).json()).toEqual({ ok: true, model: 'test-model' })
    expect(seen.at(-1)).toMatchObject({ url: '/v1/chat/completions', key: 'Bearer local-test-key', body: { stream: true, max_tokens: 32 } })
    expect(seen.at(-1)!.body.tools).toBeUndefined()
    expect(await (await request('models', 'POST', { baseUrl: draft.baseUrl })).json()).toEqual({ models: ['test-model', 'other-model'] })
    expect(seen.at(-1)!.key).toBe('Bearer local-test-key')
    expect(await (await request('test', 'POST', { ...draft, apiKey: 'draft-test-key' })).json()).toEqual({ ok: true, model: 'test-model' })
    expect(seen.at(-1)!.key).toBe('Bearer draft-test-key')
    expect(runtime.store.settingsRevision()).toBe(revision)
    expect(runtime.store.deskHistory.latestSeq()).toBe(seq)
    expect(runtime.conversationMessages('probe')).toEqual([])
    reject = true
    const failure = await request('test', 'POST', { ...draft, apiKey: 'draft-secret-echo' })
    expect(failure.status).toBe(400)
    expect(await failure.text()).not.toContain('draft-secret-echo')
    const modelFailure = await request('models', 'POST', { baseUrl: draft.baseUrl, apiKey: 'draft-secret-echo' })
    expect(modelFailure.status).toBe(400)
    expect(await modelFailure.text()).not.toContain('draft-secret-echo')
    const count = seen.length
    for (const bad of [{ apiKey: 'bad\nheader' }, { apiKey: 42 }, { apiKey: 'bad\u0000' }, { baseUrl: 'https://user:secret@example.com/v1' }, { baseUrl: 'file:///tmp/model' }]) {
      expect((await request('config', 'PUT', { ...draft, ...bad })).status).toBe(400)
      expect((await request('test', 'POST', { ...draft, ...bad })).status).toBe(400)
    }
    expect(seen.length).toBe(count)
    reject = false
    expect(await (await request('config', 'PUT', { ...draft, clearApiKey: true })).json()).toEqual({ configuredKey: true, localKey: false, envKey: true, models: ['test-model', 'other-model'], defaultModel: 'test-model' })
    await request('test', 'POST', draft)
    expect(seen.at(-1)!.key).toBe('Bearer environment-test-key')
    expect(await readdir(stateDir)).not.toContain('model-credentials.json')
    expect(JSON.stringify(runtime.settings())).not.toContain('local-test-key')
    for (const file of await readdir(stateDir)) {
      if (file.includes('sqlite') || file.endsWith('.log')) {
        const bytes = await readFile(join(stateDir, file))
        expect(bytes.includes(Buffer.from('local-test-key'))).toBe(false)
        expect(bytes.includes(Buffer.from('draft-secret-echo'))).toBe(false)
      }
    }
  } finally {
    delete process.env[envName]
    await runtime.stop()
    await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()))
  }
})
