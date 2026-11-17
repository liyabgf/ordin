import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { boot } from '../src/app/boot.ts'
import { resolveConfig } from '../src/app/config.ts'
import { silentLogger } from '../src/app/logger.ts'
import { ProcessRegistry } from '../src/app/process.ts'
import { createRuntime } from '../src/app/runtime.ts'
import { serve } from '../src/app/http.ts'
import { tempDir } from './helpers/temp.ts'
import type { WorkerDriver } from '../src/drivers/types.ts'

async function fixture() {
  const stateDir = tempDir('ordin-catalog-')
  const driver = { backend: 'dsh', probe: async () => ({ backend: 'dsh', ok: false, checkedAt: new Date().toISOString(), auth: 'unknown', problems: [] }) } as unknown as WorkerDriver
  const runtime = createRuntime(boot({ config: resolveConfig({ stateDir, workRoot: join(stateDir, 'work'), inboxDir: join(stateDir, 'inbox'), port: 0 }), logger: silentLogger() }), { logger: silentLogger(), driver, proc: new ProcessRegistry(), notifier: null }); runtime.saveSettings({ acceptMode: 'auto' })
  const server = await serve(runtime, { port: 0 })
  const request = async (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = { 'x-ordin-request': '1' }) => {
    const response = await fetch(server.url + '/ordin/api/' + path, { method, headers: { ...headers, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, data: await response.json() as any }
  }
  return { runtime, request, close: async () => { await server.close(); await runtime.stop() } }
}
const input = { text: 'hello catalog', name: 'Notes', description: 'operator notes', kind: 'document', tags: ['local'], mimeType: 'text/plain', contentKind: 'text' }
describe('F2-B2 asset catalog real Runtime HTTP', () => {
  it('imports, searches, deduplicates only identical explicit imports, versions labels, archives and soft deletes', async () => {
    const f = await fixture()
    try {
      expect((await f.request('assets', 'GET', undefined, {})).status).toBe(403)
      const imported = await f.request('assets/import', 'POST', input)
      expect(imported.status).toBe(200)
      const a = imported.data
      expect(a.id).toMatch(/^asset-[0-9a-f-]{36}$/)
      expect(a.contentHash).toBe(createHash('sha256').update(input.text).digest('hex'))
      expect(a.source.type).toBe('operator-import'); expect(a.status).toBe('active'); expect(a.ownerProfileId).toBe('default')
      expect(JSON.stringify(a)).not.toContain('/tmp/')
      expect((await f.request('assets?query=notes')).data.assets.map((v: any) => v.id)).toContain(a.id)
      const patched = await f.request('assets/' + a.id, 'PATCH', { expectedRevision: 1, name: 'Renamed', tags: ['edited'], archived: true })
      expect(patched.data.revision).toBe(2)
      expect((await f.request('assets/import', 'POST', input)).data).toMatchObject({ id: a.id, name: 'Renamed', archived: true, revision: 2 })
      expect((await f.request('assets')).data.assets).toHaveLength(0)
      expect((await f.request('assets?includeArchived=true')).data.assets).toHaveLength(1)
      const revisions = (await f.request('assets/' + a.id + '/revisions')).data.revisions
      expect(revisions.map((v: any) => v.name)).toEqual(['Notes', 'Renamed'])
      expect((await f.request('assets/' + a.id, 'PATCH', { expectedRevision: 1, name: 'stale' })).status).toBe(409)
      expect((await f.request('assets/' + a.id, 'PATCH', { expectedRevision: 2.5, name: 'bad' })).status).toBe(400)
      expect((await f.request('assets/import', 'POST', { ...input, name: 'Different' })).data.id).not.toBe(a.id)
      expect((await f.request('assets/' + a.id, 'DELETE', { expectedRevision: 2 })).data.deletedAt).toBeTruthy()
      expect(f.runtime.store.assets.get(a.id)).toMatchObject({ archived: true, revision: 3 })
      expect((await f.request('assets/' + a.id + '/revisions')).data.revisions).toHaveLength(3)
    } finally { await f.close() }
  })
  it('rejects unknown fields, every path import, invalid bounds and foreign owners', async () => {
    const f = await fixture()
    try {
      for (const body of [{ path: '/etc/passwd' }, { ...input, path: '/etc/passwd' }, { ...input, uploadId: 'unknown' }, { ...input, url: 'https://example.test' }, { ...input, text: 'x'.repeat(1048577) }, { ...input, text: 'é'.repeat(524289) }, { ...input, tags: Array(21).fill('tag') }, { ...input, kind: 'binary' }, { ...input, mimeType: 'application/octet-stream' }, { ...input, contentKind: 'binary' }, { ...input, ownerProfileId: 'other' }]) {
        expect((await f.request('assets/import', 'POST', body)).status, JSON.stringify(body).slice(0, 120)).toBe(400)
      }
      expect(f.runtime.store.assets.list()).toHaveLength(0)
    } finally { await f.close() }
  })
  it('refuses deleting active Ticket and Work references', async () => {
    const f = await fixture()
    try {
      const a = (await f.request('assets/import', 'POST', input)).data
      const id = f.runtime.engine.createTicket({ title: 'Consumer', text: 'task' }).ticketId!
      const ticket = f.runtime.store.tickets.get(id)!
      f.runtime.store.tickets.save({ ...ticket, assetRefs: [{ id: a.id, revision: 1 }] } as any)
      expect((await f.request('assets/' + a.id, 'DELETE', { expectedRevision: 1 })).status).toBe(409)
      f.runtime.store.tickets.save(ticket)
      f.runtime.store.works.save({ id: 'work', name: 'Consumer', createdAt: new Date().toISOString(), assetRefs: [{ assetId: a.id, revision: 1 }] } as any)
      expect((await f.request('assets/' + a.id, 'DELETE', { expectedRevision: 1 })).status).toBe(409)
      f.runtime.store.works.remove('work')
      expect((await f.request('assets/' + a.id, 'DELETE', { expectedRevision: 1 })).status).toBe(200)
    } finally { await f.close() }
  })
  it('keeps Ticket candidate/accepted provenance, filters foreign Ticket profiles, and never dedups into source assets', async () => {
    const f = await fixture()
    try {
      const ticketId = f.runtime.engine.createTicket({ title: 'Producer', text: 'task' }).ticketId!
      const now = new Date().toISOString()
      for (const status of ['candidate', 'active']) f.runtime.store.assets.save({ id: status, kind: 'document', name: status, description: '', source: { ticketId, path: '/private/secret/file', acceptance: { status: status === 'active' ? 'accepted' : 'unverified' } }, status, contentHash: createHash('sha256').update(input.text).digest('hex'), createdAt: now, updatedAt: now } as any)
      const listed = (await f.request('assets')).data.assets
      expect(listed.map((v: any) => v.status).sort()).toEqual(['active', 'candidate'])
      expect(JSON.stringify(listed)).not.toContain('/private/secret')
      const imported = (await f.request('assets/import', 'POST', input)).data
      expect(imported.id).not.toBe('active'); expect(imported.id).not.toBe('candidate')
      const ticket = f.runtime.store.tickets.get(ticketId)!
      f.runtime.store.conversations.save({ id: 'foreign', profileId: 'other', createdAt: now, lastMessageAt: now })
      f.runtime.store.tickets.save({ ...ticket, conversationId: 'foreign' })
      expect((await f.request('assets')).data.assets.map((v: any) => v.id)).toEqual([imported.id])
      expect((await f.request('assets/active/revisions')).status).toBe(403)
    } finally { await f.close() }
  })
})
