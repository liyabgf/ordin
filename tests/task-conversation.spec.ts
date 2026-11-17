import { expect, it } from 'vitest'
import { join } from 'node:path'
import { Store } from '../src/app/store.ts'
import { Conversations } from '../src/app/conversations.ts'
import { buildSystemContext, type CoordinatorHost } from '../src/app/coordinator.ts'
import { BASE_PATH, REQUEST_HEADER, serve, type HttpHost } from '../src/app/http.ts'
import { tempDir } from './helpers/temp.ts'

const task = (id: string, conversationId: string | undefined, patch: Record<string, unknown> = {}) => ({ id, title: 'task '+id, createdAt: '2026-01-01T00:00:00Z', mandate: {}, origin: { triggerId: 'trigger-'+id }, attachments: [], assignments: [], notes: [], inputs: [], conversationId, ...patch }) as never
function hostFor(store: Store): CoordinatorHost { return { store, engine: {} as never, send: async () => {}, complete: async () => ({ text: '', toolCalls: [] }), stopTask: async () => ({ stopped: false }), workRoot: () => '/tmp' } }
function httpHost(store: Store): HttpHost { return { context: { logger: { debug(){},info(){},warn(){},error(){} } }, serverPort: () => 0, engine: {} as never, decisions: () => [], dismissDecision(){}, raiseDecision: () => 'x', store, health: {} as never, prompts: {} as never, sources: { source: () => undefined }, sourceStatus: () => ({}), delivery: { sends: () => ({ queued: 0, nowhere: 0 }) }, deleteTicket: async () => ({ deleted:'x', assets:'keep', record:'nothing' }), artifacts: () => [], mountedAt: () => '', executor: { used: () => 0, sandbox: {} as never }, uploads: {} as never, createTicketWithUploads: () => ({} as never), passes: { requestPass(){} }, nudge: async () => {}, progress: () => ({} as never), recipes: () => [], machine: { view: () => ({}), promptMaxChars: () => 1 }, settings: () => ({} as never), saveSettings: value => value as never, panelHtml: () => '', setupProblem: () => undefined, mainSession: () => ({ exists:false,running:false,busy:false }), createMainSession: async () => ({}) } }

it('explicitly continues one live task with fresh history and revocable bounded context', async () => {
 const store=new Store(join(tempDir('task-conv-'),'state.sqlite3')); const service=new Conversations(store); const source=service.create(); const old=service.create();
 const chosen=task('chosen',source.id,{ assignments:[{id:'a',state:'ended',createdAt:'now',report:{state:'ready',summary:'SAFE selected summary',files:['/private/file']}}], ended:{at:'now',by:'agent',reason:'done',outcome:'completed'}, acceptance:{status:'accepted'}, execution:{directory:'/secret'}, inputs:[{text:'INPUT SECRET'}] });
 store.tickets.save(chosen); store.tickets.save(task('unrelated',source.id,{title:'UNRELATED secret'})); store.tickets.save(task('legacy',undefined,{title:'legacy task'}));
 store.conversationMessages.append({id:'old-secret',conversationId:source.id,at:'now',role:'user',content:'OLD SECRET HISTORY'});
 const created=service.fromTask({ticketId:'chosen'}); expect(created.id).not.toBe(source.id); expect(created).toMatchObject({taskRefs:['chosen']}); expect(service.messages(created.id).messages).toEqual([]);
 const content=buildSystemContext(hostFor(store),created.id).content; expect(content).toContain('SAFE selected summary'); expect(content).toContain('chosen'); expect(content).not.toContain('OLD SECRET HISTORY'); expect(content).not.toContain('UNRELATED secret'); expect(content).not.toContain('/private/file'); expect(content).not.toContain('/secret'); expect(content).not.toContain('INPUT SECRET');
 store.tickets.save({...chosen as object,deleted:{at:'now',assets:'keep',directory:'/secret'}} as never); expect(buildSystemContext(hostFor(store),created.id).content).not.toContain('SAFE selected summary');
 store.tickets.save({...chosen as object,deleted:undefined,ownerProfileId:'foreign'} as never); expect(buildSystemContext(hostFor(store),created.id).content).not.toContain('SAFE selected summary');
 expect(store.tickets.get('chosen')?.ended?.outcome).toBe('completed');
 store.close();
});

it('rejects foreign, missing-source and deleted tasks atomically and preserves ended state', () => {
 const store=new Store(join(tempDir('task-deny-'),'state.sqlite3')); const service=new Conversations(store); const before=service.list({includeArchived:true}).length;
 store.conversations.save({id:'foreign',profileId:'other',createdAt:'now',lastMessageAt:'now'}); store.tickets.save(task('foreign-task','foreign')); store.tickets.save(task('orphan-task','missing')); store.tickets.save(task('gone',undefined,{deleted:{at:'now',assets:'keep'}}));
 for(const ticketId of ['foreign-task','orphan-task','gone','absent']) expect(()=>service.fromTask({ticketId})).toThrow(); expect(service.list({includeArchived:true})).toHaveLength(before);
 store.tickets.save(task('legacy',undefined)); const c=service.fromTask({ticketId:'legacy'}); expect(c).toBeDefined();
 store.close();
});

it('strict HTTP endpoint creates selected task conversation and rejects caller taskRefs', async () => {
 const store=new Store(join(tempDir('task-http-'),'state.sqlite3')); const service=new Conversations(store); const source=service.create(); store.tickets.save(task('ticket',source.id)); const serving=await serve({...httpHost(store),conversations:service}); const headers={ [REQUEST_HEADER]:'1','content-type':'application/json' }; const req=(body:unknown)=>fetch(serving.url+BASE_PATH+'/api/conversations/from-task',{method:'POST',headers,body:JSON.stringify(body)});
 try { const res=await req({ticketId:'ticket',title:'Continue'}); expect(res.status).toBe(200); const {conversation}=await res.json(); expect(conversation).toMatchObject({title:'Continue',taskRefs:['ticket']}); expect((await service.messages(conversation.id)).messages).toEqual([]); expect((await req({ticketId:'ticket',taskRefs:['victim']})).status).toBe(400); } finally { await serving.close(); store.close() }
});
