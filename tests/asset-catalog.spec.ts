import { describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash } from 'node:crypto'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { AssetRegistration } from '../src/app/assets.ts'
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
  it('generates only on explicit request, bounds the excerpt, and leaves the asset unchanged', async () => {
    const f = await fixture()
    const calls: any[] = []
    let fail = false
    const model = createServer(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const block of req) chunks.push(Buffer.from(block))
      calls.push(JSON.parse(Buffer.concat(chunks).toString()))
      if (fail) { res.writeHead(500); res.end('upstream-private-details'); return }
      res.setHeader('content-type', 'text/event-stream')
      res.end('data: '+JSON.stringify({choices:[{delta:{content:'可供后续任务参考的材料。'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n')
    })
    await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve))
    try {
      const asset = (await f.request('assets/import','POST',{...input,text:'x'.repeat(9000)+'private-tail'})).data
      const path = 'assets/'+asset.id
      expect((await f.request(path+'/description-suggestion','POST',{revision:1})).status).toBe(409)
      await f.runtime.saveModelConfig({baseUrl:'http://127.0.0.1:'+(model.address() as AddressInfo).port+'/v1',model:'local-fixture',provider:'OpenAI compatible',models:['local-fixture'],temperature:0.2,maxTokens:512,apiKeyEnv:''})
      await f.request(path)
      expect((await f.request(path+'/description-suggestion','POST',{revision:2})).status).toBe(409)
      expect(calls).toHaveLength(0)
      const reply = await f.request(path+'/description-suggestion','POST',{revision:1})
      expect(reply.status).toBe(200)
      expect(reply.data).toMatchObject({description:'可供后续任务参考的材料。',revision:1,model:'local-fixture',generatedAt:expect.any(String)})
      expect(calls).toHaveLength(1)
      expect(JSON.parse(calls[0].messages[1].content).excerpt).toBe('x'.repeat(8192))
      expect(calls[0].max_tokens).toBe(160)
      fail = true
      const failed = await f.request(path+'/description-suggestion','POST',{revision:1})
      expect(failed.status).toBe(409)
      expect(JSON.stringify(failed.data)).not.toContain('upstream-private-details')
      expect((await f.request(path)).data).toEqual(asset)
      expect((await f.request(path+'/content')).status).toBe(200)
    } finally { await f.close(); await new Promise<void>(resolve => model.close(() => resolve())) }
  })
  it('discovers co-selected assets from initial pins and supplements without leaking private or archived rows', async () => {
    const f = await fixture()
    try {
      const create = async (name: string) => (await f.request('assets/import','POST',{...input,name})).data
      const [anchor, peer, hidden, archived, unrelated] = await Promise.all(['Anchor','Peer','Hidden','Archived','Unrelated'].map(create))
      const pin = (a: any) => ({id:a.id,revision:1,contentHash:a.contentHash})
      const ticket = f.runtime.engine.require(f.runtime.engine.createTicket({title:'Public task',text:'work'}).ticketId!)
      f.runtime.store.tickets.save({...ticket,assetRefs:[pin(anchor),pin(hidden),pin(archived)]})
      f.runtime.engine.assetNote(ticket.id,'supplement',[pin(peer)],'')
      f.runtime.engine.assetNote(ticket.id,'repeat',[pin(peer)],'')
      for (const [a, changes] of [[hidden,{ownerProfileId:'other'}],[archived,{archived:true}]] as const) {
        f.runtime.store.assets.save({...f.runtime.store.assets.get(a.id)!,...changes} as any)
      }
      const now = new Date().toISOString()
      f.runtime.store.conversations.save({id:'foreign',profileId:'other',createdAt:now,lastMessageAt:now})
      const foreign = f.runtime.engine.require(f.runtime.engine.createTicket({title:'Foreign task',text:'private work'}).ticketId!)
      f.runtime.store.tickets.save({...foreign,conversationId:'foreign',assetRefs:[pin(anchor),pin(unrelated)]})
      const result = await f.request('assets/'+anchor.id+'/relations')
      expect(result.status).toBe(200)
      expect(result.data.related).toEqual([expect.objectContaining({id:peer.id, taskCount:1, reason:'曾在 1 个任务中共同选用；不代表已使用'})])
      expect((await f.request('assets/'+peer.id+'/relations')).data.related.map((a: any)=>a.id)).toEqual([anchor.id])
    } finally { await f.close() }
  })
  it('persists pinned asset inputs idempotently and rejects unauthorized or changed requests',async()=>{
    const f=await fixture();try{
      const asset=(await f.request('assets/import','POST',input)).data;
      const id=f.runtime.engine.createTicket({title:'Active consumer',text:'work'}).ticketId!;
      const payload={requestId:'request-one',text:'Use notes',assetRefs:[{id:asset.id,revision:1,contentHash:asset.contentHash}]};
      const first=await f.request('tickets/'+id+'/asset-inputs','POST',payload);expect(first.status).toBe(200);expect(first.data.deliveryState).toBe('queued');
      const trace=()=>f.request('assets/'+asset.id+'/relations');
      expect((await trace()).data.references).toMatchObject([{ticketId:id,inputId:first.data.inputId,revision:1,state:'queued'}]);
      const repeated=await f.request('tickets/'+id+'/asset-inputs','POST',payload);expect(repeated.data.inputId).toBe(first.data.inputId);expect(f.runtime.engine.require(id).inputs.filter(i=>i.kind==='note' && i.requestId==='request-one')).toHaveLength(1);
      expect((await f.request('tickets/'+id+'/asset-inputs','POST',{...payload,text:'different'})).status).not.toBe(200);
      expect((await f.request('tickets/'+id+'/asset-inputs','POST',{...payload,requestId:'bad-hash',assetRefs:[{...payload.assetRefs[0],contentHash:'0'.repeat(64)}]})).status).toBe(409);
      expect((await f.request('tickets/'+id+'/asset-inputs','POST',{...payload,requestId:'path',assetRefs:[{path:'/etc/passwd'}]})).status).not.toBe(200);
      f.runtime.engine.stopTicket(id,'stop');expect((await f.request('tickets/'+id+'/asset-inputs','POST',{...payload,requestId:'new-after-stop'})).status).toBe(409);
      const endedReplay = await f.request('tickets/'+id+'/asset-inputs','POST',payload);
      expect(endedReplay.status).toBe(200);
      expect(endedReplay.data).toMatchObject({inputId:first.data.inputId,deliveryState:'not-delivered',message:'任务已结束，未送达执行端'});
      expect((await trace()).data.references[0].state).toBe('not-delivered');
      const before=f.runtime.engine.require(id);
      f.runtime.store.tickets.save({...before,inputs:before.inputs.map(i=>i.id===first.data.inputId?{...i,deliveredAt:new Date().toISOString()}:i)});
      expect((await trace()).data.references[0]).toMatchObject({state:'delivered',reason:expect.stringContaining('不代表')});
      const at=new Date().toISOString();f.runtime.store.conversations.save({id:'foreign',profileId:'other',createdAt:at,lastMessageAt:at});const ticket=f.runtime.engine.require(id);f.runtime.store.tickets.save({...ticket,conversationId:'foreign'});
      expect((await f.request('tickets/'+id+'/asset-inputs','POST',payload)).status).toBe(403);
      expect((await trace()).data.references).toEqual([]);
    }finally{await f.close()}
  });
  it('returns same-task provenance and explicit pinned-reference records without claiming use', async()=>{
    const f=await fixture();try{
      const source=await f.request('assets/import','POST',input);const id=f.runtime.engine.createTicket({title:'Reference consumer',text:'use asset'}).ticketId!;
      const t=f.runtime.store.tickets.get(id)!;f.runtime.store.tickets.save({...t,assetRefs:[{id:source.data.id,revision:1,contentHash:source.data.contentHash}]});
      const relations=await f.request('assets/'+source.data.id+'/relations');expect(relations.status).toBe(200);
      expect(relations.data).toMatchObject({related:[],references:[{ticketId:id,title:'Reference consumer',revision:1,state:'selected',reason:expect.stringContaining('不代表')} ]});
      expect((await f.request('assets/not-here/relations')).status).toBe(404);
      const now=new Date().toISOString();
      const shared=f.runtime.engine.createTicket({title:'Shared source',text:'source'}).ticketId!;
      const sharedTicket=f.runtime.store.tickets.get(shared)!; f.runtime.store.tickets.save({...sharedTicket,id:'shared-source'} as any);
      for(const [aid,owner] of [['sibling','default'],['foreign-sibling','other']]) f.runtime.store.assets.save({id:aid,name:aid,kind:'report',ownerProfileId:owner,storageVersion:1,storage:{kind:'managed-object'},source:{ticketId:'shared-source'},createdAt:now,updatedAt:now} as any);
      const base=f.runtime.store.assets.get(source.data.id)!;f.runtime.store.assets.save({...base,source:{ticketId:'shared-source'}} as any);
      const related=await f.request('assets/'+source.data.id+'/relations');
      expect(related.data.related.map((row:any)=>row.id)).toEqual(['sibling']);
      f.runtime.store.conversations.save({id:'foreign-conversation',profileId:'other',createdAt:now,lastMessageAt:now});
      f.runtime.store.tickets.save({...t,conversationId:'foreign-conversation',assetRefs:[{id:source.data.id,revision:1,contentHash:source.data.contentHash}]});
      expect((await f.request('assets/'+source.data.id+'/relations')).data.references).toEqual([]);
      expect((await f.request('assets/foreign-sibling/relations')).status).toBe(403);
    }finally{await f.close()}
  })
  it('serves independent delivered bytes after source task deletion and rejects foreign owners and corrupted content', async()=>{
    const f=await fixture();try{
      const id=f.runtime.engine.createTicket({title:'Producer',text:'work'}).ticketId!;
      const original=f.runtime.engine.require(id), directory=join(f.runtime.machine.workRoot,id), at=new Date().toISOString();
      await mkdir(directory,{recursive:true});await writeFile(join(directory,'report.md'),'你好 <script>bad()</script>');
      const ticket={...original,execution:{name:id,directory},ended:{outcome:'done' as const,by:'system' as const,at,reason:'done'},result:{summary:'Independent report',files:['report.md'],at},acceptance:{status:'accepted' as const}};
      f.runtime.store.tickets.save(ticket);
      const registration=new AssetRegistration({assets:f.runtime.store.assets,workRoot:f.runtime.machine.workRoot,stateDir:f.runtime.machine.stateDir});
      const [a]=await registration.registerTicket(ticket);
      const before=await f.request('assets/'+a!.id+'/content');expect(before.status).toBe(200);expect(Buffer.from(before.data.base64,'base64').toString()).toBe('你好 <script>bad()</script>');
      expect((await f.request('assets/'+a!.id)).data).toMatchObject({managed:true,source:{ticketTitle:'Producer',availability:'available'}});
      f.runtime.store.tickets.remove(id);await rm(directory,{recursive:true});
      expect((await f.request('assets/'+a!.id)).data.source.availability).toBe('missing');
      expect((await f.request('assets/'+a!.id+'/content')).data.base64).toBe(before.data.base64);
      const updated=await f.request('assets/'+a!.id,'PATCH',{name:'My report',expectedRevision:1});expect(updated.status).toBe(200);
      const row=f.runtime.store.assets.get(a!.id)!;
      f.runtime.store.assets.save({...row,ownerProfileId:'other'} as any);expect((await f.request('assets/'+a!.id+'/content')).status).toBe(403);
      f.runtime.store.assets.save({...row,contentHash:'0'.repeat(64)} as any);expect((await f.request('assets/'+a!.id+'/content')).status).toBe(409);
    }finally{await f.close()}
  })

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
