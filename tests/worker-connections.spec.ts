import { expect, it, vi } from 'vitest'
import { chmod, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { WorkerConnections } from '../src/app/worker-connections.ts'
import { DshServiceDriver } from '../src/drivers/dsh-service.ts'
import { DriverRouter } from '../src/drivers/router.ts'
import type { BackendKind, WorkerDriver, WorkerSpec } from '../src/drivers/types.ts'
import { tempDir } from './helpers/temp.ts'

it.each(['/', '/connect'])('tests a local %s link on a custom port and reloads without returning the token', async path => {
  const token = 'test-fixture-token'
  let probes = 0
  const address = 'http://127.0.0.1:23456'
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const u = new URL(input)
    if (u.origin !== address) throw Error('unexpected fixture origin')
    if (u.pathname === '/connect') {
      if (u.searchParams.get('token') !== token) return new Response(null, {status:401})
      return new Response(null, {status:302, headers:{'set-cookie':'fixture=ok'}})
    }
    if (u.pathname !== '/api/session/list' || new Headers(init?.headers).get('cookie') !== 'fixture=ok') return new Response(null, {status:403})
    probes++
    return Response.json({type:'server-response',rpcId:JSON.parse(String(init?.body)).rpcId,result:{ok:true,value:{items:[]}}})
  })
  try {
    const stateDir = tempDir('ordin-connections-')
    const make = () => new WorkerConnections(stateDir,(backend,saved) => {
      if (backend === 'dsh' && saved.dsh) return new DshServiceDriver({baseUrl:saved.dsh.address,token:saved.dsh.token,useServiceSettings:true})
      return {backend,probe:async()=>({backend,ok:true,checkedAt:'',auth:'ok',problems:[]})} as any
    })
    const connections = make()
    const previous = connections.driver('dsh')
    const value = address+path+'?token='+token
    await expect(connections.testAndSave('dsh',{value})).rejects.toThrow('确认')
    await expect(connections.testAndSave('dsh',{value:'https://example.test/connect?token='+token,allowDshPermissions:true})).rejects.toThrow('本机')
    expect(probes).toBe(0)
    const view = await connections.testAndSave('dsh',{value,allowDshPermissions:true})
    expect(view.dsh).toMatchObject({configured:true,address,connectionId:expect.stringMatching(/^[0-9a-f-]{36}$/)})
    expect(JSON.stringify(view)).not.toContain(token)
    expect(connections.driver('dsh')).not.toBe(previous)
    const active = connections.driver('dsh')
    await expect(connections.testAndSave('dsh',{value:value+'-wrong',allowDshPermissions:true})).rejects.toThrow('旧设置未更改')
    expect(connections.driver('dsh')).toBe(active)
    expect((await stat(join(stateDir,'worker-connections.json'))).mode & 0o777).toBe(0o600)
    const reloaded = make(); await reloaded.load()
    expect(reloaded.view()).toEqual(view)
    expect(reloaded.connectionId('dsh')).toMatch(/^[0-9a-f-]{36}$/)
    expect(JSON.stringify(reloaded.view())).not.toContain(token)
    expect((await reloaded.driver('dsh').probe()).ok).toBe(true)
    expect(probes).toBe(2)
    await expect(reloaded.testAndSave('codex',{value:'codex --other'})).rejects.toThrow('完整路径')
    expect((await reloaded.testAndSave('codex',{value:''})).codex).toMatchObject({configured:true,binary:'codex',connectionId:expect.stringMatching(/^[0-9a-f-]{36}$/)})
    expect((await reloaded.testAndSave('claude',{value:''})).claude).toMatchObject({configured:true,binary:'claude',connectionId:expect.stringMatching(/^[0-9a-f-]{36}$/)})
  } finally { vi.unstubAllGlobals() }
})

it('keeps the prepared connection identity across saves and uses the new identity on the next prepare', async () => {
  const stateDir=tempDir('ordin-connection-identity-')
  let serial=0
  const launched:number[]=[]
  const make=()=>new WorkerConnections(stateDir, backend=>{
    const identity=++serial
    return {backend,probe:async()=>({backend,ok:true,checkedAt:'fixture',auth:'ok',problems:[]}),
      prepare:async input=>({...input,preparedAt:'fixture'}),
      launch:async()=>{launched.push(identity);return {} as any},resume:async()=>{launched.push(identity);return {} as any}}
  })
  const connections=make();await connections.load();expect(connections.connectionId('codex')).toBeUndefined()
  await connections.testAndSave('codex',{value:''})
  const firstId=connections.connectionId('codex')!;expect(firstId).toMatch(/^[0-9a-f-]{36}$/)
  const router=new DriverRouter(backend=>connections.driver(backend),()=> 'codex')
  const prepared=await router.prepare({ticketId:'t',assignmentId:'a',cwd:'/fixture',prompt:'fixture',access:'read'})
  expect(router.preparedConnectionId(prepared)).toBe(firstId)
  await connections.testAndSave('codex',{value:''})
  expect(connections.connectionId('codex')).not.toBe(firstId)
  expect(router.preparedConnectionId(prepared)).toBe(firstId)
  await router.launch(prepared);expect(launched).toEqual([1])
  const next=await router.prepare({ticketId:'t',assignmentId:'b',cwd:'/fixture',prompt:'fixture',access:'read'})
  expect(router.preparedConnectionId(next)).toBe(connections.connectionId('codex'))
  await router.launch(next);expect(launched).toEqual([1,2])
  const reloaded=make();await reloaded.load();expect(reloaded.connectionId('codex')).toBe(connections.connectionId('codex'))
  expect(reloaded.view().codex).toMatchObject({connectionId:connections.connectionId('codex')})
})

const spec: WorkerSpec = { ticketId:'test', assignmentId:'test', cwd:'/fixture', prompt:'fixture', access:'read' }
const backends = ['dsh', 'codex', 'claude'] as const
function fixture(stateDir: string) {
  let ready = true
  const build = vi.fn((backend: BackendKind, _saved: unknown): WorkerDriver => ({
    backend,
    probe: async () => ({ backend, ok:ready, checkedAt:'', auth:'unknown', problems:[] }),
    prepare: async input => ({ ...input, preparedAt:'fixture' }),
    launch: async () => { throw Error('no worker launched by fixture') },
    resume: async () => { throw Error('no worker resumed by fixture') },
  }))
  const connections = new WorkerConnections(stateDir, build)
  const router = new DriverRouter(backend => connections.driver(backend), () => 'dsh')
  return { build, connections, router, setReady: (value: boolean) => { ready = value } }
}

it('preserves fallback on missing files and on legacy files after ordinary saves', async () => {
  const stateDir = tempDir('ordin-connections-')
  const first = fixture(stateDir)
  await first.connections.load()
  await expect(first.router.prepare({ ...spec, backend:'claude' })).resolves.toHaveProperty('preparedAt', 'fixture')
  await first.connections.testAndSave('codex', {value:''})
  expect(JSON.parse(await readFile(join(stateDir,'worker-connections.json'), 'utf8'))).toEqual({codex:'', connectionIds:{codex:expect.stringMatching(/^[0-9a-f-]{36}$/)}})
  const restarted = fixture(stateDir)
  await restarted.connections.load()
  expect(restarted.connections.view().claude).toEqual({configured:false})
  await expect(restarted.router.prepare({ ...spec, backend:'claude' })).resolves.toHaveProperty('preparedAt', 'fixture')
})

it.each([
  {case:'malformed JSON', content:'{', mode:0o600},
  {case:'invalid schema', content:'{"codex":"not-an-absolute-path"}', mode:0o600},
  {case:'unsafe permissions', content:'{"codex":""}', mode:0o644},
])('blocks all dispatch for $case and persists backend-by-backend repair', async ({content, mode}) => {
  const stateDir = tempDir('ordin-connections-')
  const file = join(stateDir, 'worker-connections.json')
  await writeFile(file, content, {mode})
  await chmod(file, mode)
  const first = fixture(stateDir)
  await expect(first.connections.load()).rejects.toThrow('执行端连接设置无效或权限不安全')
  for (const backend of backends) {
    await expect(first.router.probe(backend)).resolves.toMatchObject({backend, ok:false})
    await expect(first.router.prepare({ ...spec, backend })).rejects.toThrow('请在设置中重新连接')
  }
  expect(first.build).not.toHaveBeenCalled()

  first.setReady(false)
  await expect(first.connections.testAndSave('codex', {value:''})).rejects.toThrow('旧设置未更改')
  expect(await readFile(file, 'utf8')).toBe(content)
  await expect(first.router.prepare({ ...spec, backend:'codex' })).rejects.toThrow('请在设置中重新连接')
  first.setReady(true)
  await expect(first.connections.testAndSave('codex', {value:''})).resolves.toMatchObject({
    dsh:{configured:false}, codex:{configured:true,binary:'codex',connectionId:expect.stringMatching(/^[0-9a-f-]{36}$/)}, claude:{configured:false},
  })

  const restarted = fixture(stateDir)
  await restarted.connections.load()
  for (const {router} of [first, restarted]) {
    await expect(router.prepare({ ...spec, backend:'codex' })).resolves.toHaveProperty('preparedAt', 'fixture')
    for (const backend of ['dsh', 'claude'] as const) {
      await expect(router.probe(backend)).resolves.toMatchObject({backend, ok:false})
      await expect(router.prepare({ ...spec, backend })).rejects.toThrow('请在设置中重新连接')
    }
  }
  expect(restarted.build.mock.calls).toEqual([['codex', expect.objectContaining({codex:''})]])
  await restarted.connections.testAndSave('claude', {value:''})
  const repairedAgain = fixture(stateDir)
  await repairedAgain.connections.load()
  await expect(repairedAgain.router.prepare({ ...spec, backend:'claude' })).resolves.toHaveProperty('preparedAt', 'fixture')
  await expect(repairedAgain.router.prepare(spec)).rejects.toThrow('请在设置中重新连接')
})
